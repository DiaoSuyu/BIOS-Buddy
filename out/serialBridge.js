"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SerialBridge = void 0;
const child_process_1 = require("child_process");
const serialCore_1 = require("./serialCore");
class SerialBridge {
    constructor(cfg, handlers, opts = {}) {
        this.cfg = cfg;
        this.handlers = handlers;
        this.opts = opts;
        this.ready = false;
        this.errBuf = '';
        this.closing = false;
    }
    get isOpen() { return this.ready; }
    /** Open the port: resolve(null) on success, resolve(reason) on failure — no reject, so callers stay simple */
    open() {
        const script = this.opts.script ?? (0, serialCore_1.buildPsScript)(this.cfg);
        const timeoutMs = this.opts.timeoutMs ?? 8000;
        return new Promise((resolve) => {
            let settled = false;
            const done = (err) => { if (!settled) {
                settled = true;
                resolve(err);
            } };
            let proc;
            try {
                proc = (0, child_process_1.spawn)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', (0, serialCore_1.encodePsCommand)(script)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
            }
            catch (e) {
                done(e.message);
                return;
            }
            this.proc = proc;
            this.ready = false;
            this.errBuf = '';
            const timer = setTimeout(() => {
                done(`Opening ${this.cfg.port} timed out after ${Math.round(timeoutMs / 1000)}s.`);
                this.close();
            }, timeoutMs);
            proc.stdout?.on('data', (chunk) => {
                if (this.ready)
                    this.handlers.onRx(chunk);
            });
            proc.stderr?.on('data', (chunk) => {
                this.errBuf += chunk.toString('utf8');
                let idx;
                while ((idx = this.errBuf.indexOf('\n')) >= 0) {
                    const line = this.errBuf.slice(0, idx).replace(/\r$/, '');
                    this.errBuf = this.errBuf.slice(idx + 1);
                    const parsed = (0, serialCore_1.parseBridgeLine)(line);
                    if (parsed.kind === 'ready') {
                        this.ready = true;
                        clearTimeout(timer);
                        done(null);
                    }
                    else if (parsed.kind === 'info') {
                        this.handlers.onInfo?.(parsed.text);
                    }
                    else if (parsed.kind === 'error') {
                        if (this.ready) {
                            this.handlers.onError(parsed.message);
                        }
                        else {
                            clearTimeout(timer);
                            done(parsed.message);
                            try {
                                proc.kill();
                            }
                            catch { /* ignore */ }
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
                if (!wasOpen)
                    done(`Serial process exited with code ${code ?? 0} before the port was open.`);
                else if (!this.closing)
                    this.handlers.onExit(code);
                this.closing = false;
            });
        });
    }
    /** Send bytes; false when the port is closed */
    send(bytes) {
        if (!this.ready || !this.proc)
            return false;
        try {
            this.proc.stdin?.write(bytes.toString('base64') + '\n');
            return true;
        }
        catch {
            return false;
        }
    }
    /** Change DTR / RTS while running */
    setLines(dtr, rts) {
        if (!this.ready || !this.proc)
            return;
        try {
            this.proc.stdin?.write(`DTR:${dtr ? 1 : 0}\n`);
            this.proc.stdin?.write(`RTS:${rts ? 1 : 0}\n`);
        }
        catch { /* ignore */ }
    }
    /** Close politely first: QUIT → end → kill after 250ms */
    close() {
        const p = this.proc;
        this.ready = false;
        this.proc = undefined;
        if (!p)
            return;
        this.closing = true;
        try {
            p.stdin?.write('QUIT\n');
        }
        catch { /* ignore */ }
        try {
            p.stdin?.end();
        }
        catch { /* ignore */ }
        setTimeout(() => { try {
            p.kill();
        }
        catch { /* already gone */ } }, 250);
    }
}
exports.SerialBridge = SerialBridge;
//# sourceMappingURL=serialBridge.js.map