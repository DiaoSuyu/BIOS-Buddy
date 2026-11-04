import { ChildProcess, spawn } from 'child_process';
import { SerialConfig, buildPsScript, encodePsCommand, parseBridgeLine } from './serialCore';

// ---------------------------------------------------------------------------
// Serial bridge: one long-lived PowerShell process hosts System.IO.Ports.SerialPort.
// stdout → raw bytes received from the port, no wrapper at all
// stderr → one control message per line: READY = opened, ERR xxx = failure
// stdin ← one base64 line per write; DTR:, RTS: and QUIT are control commands
//
// No vscode here: the webview feeds data through callbacks, so the pipe is easy to test.
// ---------------------------------------------------------------------------

export interface BridgeHandlers {
    /** Bytes received from the port, passed on untouched */
    onRx(bytes: Buffer): void;
    /** The port failed after opening (write error, device unplugged) */
    onError(message: string): void;
    /** Process exit, whether closed cleanly or crashed */
    onExit(code: number | null): void;
    /** Parameters read back after opening (the SET line) — diagnostics only */
    onInfo?(text: string): void;
}

export interface BridgeOptions {
    /** For tests: swap in a different script, same stdin/stdout protocol */
    script?: string;
    /** Open timed out */
    timeoutMs?: number;
}

export class SerialBridge {
    private proc: ChildProcess | undefined;
    private ready = false;
    private errBuf = '';
    private closing = false;

    constructor(
        private readonly cfg: SerialConfig,
        private readonly handlers: BridgeHandlers,
        private readonly opts: BridgeOptions = {},
    ) { }

    get isOpen(): boolean { return this.ready; }

    /** Open the port: resolve(null) on success, resolve(reason) on failure — no reject, so callers stay simple */
    open(): Promise<string | null> {
        const script = this.opts.script ?? buildPsScript(this.cfg);
        const timeoutMs = this.opts.timeoutMs ?? 8000;

        return new Promise((resolve) => {
            let settled = false;
            const done = (err: string | null) => { if (!settled) { settled = true; resolve(err); } };

            let proc: ChildProcess;
            try {
                proc = spawn('powershell.exe',
                    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePsCommand(script)],
                    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                done((e as Error).message);
                return;
            }
            this.proc = proc;
            this.ready = false;
            this.errBuf = '';

            const timer = setTimeout(() => {
                done(`Opening ${this.cfg.port} timed out after ${Math.round(timeoutMs / 1000)}s.`);
                this.close();
            }, timeoutMs);

            proc.stdout?.on('data', (chunk: Buffer) => {
                if (this.ready) this.handlers.onRx(chunk);
            });

            proc.stderr?.on('data', (chunk: Buffer) => {
                this.errBuf += chunk.toString('utf8');
                let idx: number;
                while ((idx = this.errBuf.indexOf('\n')) >= 0) {
                    const line = this.errBuf.slice(0, idx).replace(/\r$/, '');
                    this.errBuf = this.errBuf.slice(idx + 1);
                    const parsed = parseBridgeLine(line);
                    if (parsed.kind === 'ready') {
                        this.ready = true;
                        clearTimeout(timer);
                        done(null);
                    } else if (parsed.kind === 'info') {
                        this.handlers.onInfo?.(parsed.text);
                    } else if (parsed.kind === 'error') {
                        if (this.ready) {
                            this.handlers.onError(parsed.message);
                        } else {
                            clearTimeout(timer);
                            done(parsed.message);
                            try { proc.kill(); } catch { /* ignore */ }
                        }
                    }
                }
            });

            proc.on('error', (e) => { clearTimeout(timer); done(e.message); });

            proc.on('exit', (code) => {
                clearTimeout(timer);
                const wasOpen = this.ready;
                this.ready = false;
                this.proc = undefined;
                if (!wasOpen) done(`Serial process exited with code ${code ?? 0} before the port was open.`);
                else if (!this.closing) this.handlers.onExit(code);
                this.closing = false;
            });
        });
    }

    /** Send bytes; false when the port is closed */
    send(bytes: Buffer): boolean {
        if (!this.ready || !this.proc) return false;
        try {
            this.proc.stdin?.write(bytes.toString('base64') + '\n');
            return true;
        } catch {
            return false;
        }
    }

    /** Change DTR / RTS while running */
    setLines(dtr: boolean, rts: boolean): void {
        if (!this.ready || !this.proc) return;
        try {
            this.proc.stdin?.write(`DTR:${dtr ? 1 : 0}\n`);
            this.proc.stdin?.write(`RTS:${rts ? 1 : 0}\n`);
        } catch { /* ignore */ }
    }

    /** Close politely first: QUIT → end → kill after 250ms */
    close(): void {
        const p = this.proc;
        this.ready = false;
        this.proc = undefined;
        if (!p) return;
        this.closing = true;
        try { p.stdin?.write('QUIT\n'); } catch { /* ignore */ }
        try { p.stdin?.end(); } catch { /* ignore */ }
        setTimeout(() => { try { p.kill(); } catch { /* already gone */ } }, 250);
    }
}
