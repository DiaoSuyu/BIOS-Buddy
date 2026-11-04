import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

import {
    SerialPortInfo,
    validateConfig, encodePsCommand,
    PORT_NAMES_SCRIPT, PORT_DESC_SCRIPT, parsePortNames, parsePortDescs,
} from './serialCore';
import { SerialBridge } from './serialBridge';
import { readWebviewHtml } from './webview';

// ---------------------------------------------------------------------------
// COM Debugger (serial / UART) webview
// A webview cannot open a COM port (no Web Serial), so the port stays in the extension process:
// SerialBridge runs a long-lived PowerShell hosting System.IO.Ports; this file only
// relays webview messages to the bridge, lists ports and saves logs.
// Closing the panel shuts the bridge down and the port with it.
// ---------------------------------------------------------------------------

const LIST_TIMEOUT_MS = 6000;
const DESC_TIMEOUT_MS = 5000;
const MAX_TEXT = 4 * 1024 * 1024;      // Upper bound for a saved log

let diagChannel: vscode.OutputChannel | undefined;
/** Serial diagnostics: pick BIOS COM Debugger in the Output panel to see every step */
function diag(message: string): void {
    if (!diagChannel) diagChannel = vscode.window.createOutputChannel('BIOS COM Assistant');
    diagChannel.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function runPs(script: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePsCommand(script)],
            { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
            (err, stdout) => {
                if (err) { reject(err); return; }
                resolve(String(stdout ?? ''));
            });
    });
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
    if (process.platform !== 'win32') {
        // On non-Windows it is view-only: a plausible list, and a clear message when connecting
        const out: SerialPortInfo[] = [];
        let names: string[] = [];
        try { names = fs.readdirSync('/dev'); } catch { names = []; }
        for (const n of names) {
            if (/^(ttyUSB|ttyACM|ttyS|cu\.|tty\.)/.test(n)) out.push({ path: '/dev/' + n, desc: n });
        }
        return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 40);
    }

    // Step one asks for names only; it must succeed or the panel has no ports at all
    let names: string[];
    try {
        names = parsePortNames(await runPs(PORT_NAMES_SCRIPT, LIST_TIMEOUT_MS));
    } catch (e) {
        diag(`list ports failed: ${(e as Error).message}`);
        return [];
    }
    if (!names.length) return [];

    // Step two adds descriptions through WMI; slow or failing does not matter, the names are already there
    let descs: Record<string, string> = {};
    try {
        descs = parsePortDescs(await runPs(PORT_DESC_SCRIPT, DESC_TIMEOUT_MS));
    } catch { /* Works without a description */ }

    const out = names.map(n => ({ path: n, desc: descs[n.toUpperCase()] || 'Serial port' }));
    diag(`ports: ${out.map(p => p.path + ' (' + p.desc + ')').join(', ')}`);
    return out;
}

/** Opening usually fails for one of two reasons — another program holds the port, or it was unplugged — so say which */
function hintForOpenError(raw: string): string {
    const msg = String(raw || '');
    if (/denied|拒绝访问|占用/i.test(msg)) {
        return `${msg}\nThe port is held by another program (SuperCom / PuTTY / a serial monitor) — close it and try again.`;
    }
    if (/not exist|找不到|cannot find|does not exist/i.test(msg)) {
        return `${msg}\nThat port is gone — plug the device back in and hit ⟳ to rescan.`;
    }
    return msg;
}

// Serial settings and display switches live here, surviving panel close and window restart
const PREFS_KEY = 'biosBuddy.comPrefs';

export function registerSerialConsole(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('biosBuddy.serialConsole', () => openSerialConsole(context)),
    );
}

// One COM Debugger per window: a second click reveals it, connection and log intact
let livePanel: vscode.WebviewPanel | undefined;

export async function openSerialConsole(context: vscode.ExtensionContext) {
    if (livePanel) { livePanel.reveal(livePanel.viewColumn ?? vscode.ViewColumn.Active, false); return; }

    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
        'biosSerialConsole',
        'COM Assistant',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaDir] },
    );
    panel.iconPath = vscode.Uri.joinPath(mediaDir, 'bios.png');
    // Serial settings: port, baud, data bits, parity, stop bits, flow, DTR, RTS, display switches, send options
    // Stored in globalState so they survive closing the panel and restarting VS Code.
    // Injected straight into the html so the page opens already in shape; waiting for a postMessage would flash the defaults first.
    const prefs = context.globalState.get<Record<string, unknown>>(PREFS_KEY);
    let html = readWebviewHtml(mediaDir, 'serial-console.html');
    if (prefs) {
        const json = JSON.stringify(prefs).replace(/</g, '\\u003c');
        html = html.replace('<head>', `<head>\n<script>window.__comPrefs = ${json};</script>`);
    }
    panel.webview.html = html;
    livePanel = panel;
    panel.onDidDispose(() => { if (livePanel === panel) livePanel = undefined; }, null, context.subscriptions);

    let bridge: SerialBridge | undefined;
    const post = (msg: unknown) => { try { panel.webview.postMessage(msg); } catch { /* disposed */ } };

    // reason is only a code — 'user' / 'replaced' / 'panel' / 'exit:N' — the UI translates it
    const closeBridge = (reason: string) => {
        const b = bridge;
        bridge = undefined;
        if (!b) return;
        b.close();
        post({ type: 'closed', reason });
    };

    panel.webview.onDidReceiveMessage(async (m: { type?: string; [k: string]: unknown }) => {
        if (!m || typeof m.type !== 'string') return;
        try {
            switch (m.type) {
                case 'ready':
                case 'listPorts': {
                    post({ type: 'ports', ports: await listSerialPorts() });
                    break;
                }

                case 'open': {
                    const v = validateConfig(m.config);
                    if (v.error) { post({ type: 'openResult', ok: false, error: v.error }); return; }
                    if (process.platform !== 'win32') {
                        post({
                            type: 'openResult', ok: false,
                            error: 'COM Assistant can only open ports on Windows (System.IO.Ports via PowerShell).',
                        });
                        return;
                    }
                    const cfg = v.cfg!;
                    if (bridge) closeBridge('replaced');

                    let rxBytes = 0;
                    // At 3 Mbps the bridge pushes hundreds of packets a second; one postMessage each would grind the main thread.
                    // Batching for 40ms cuts the number of messages the webview receives by an order of magnitude.
                    let rxChunks: Buffer[] = [];
                    let rxTimer: NodeJS.Timeout | undefined;
                    let rxPending = 0;
                    let rxDropped = 0;
                    const flushRx = () => {
                        rxTimer = undefined;
                        if (!rxChunks.length) return;
                        const chunk = Buffer.concat(rxChunks);
                        rxChunks = [];
                        rxPending = 0;
                        post({ type: 'rx', data: chunk.toString('base64') });
                    };
                    diag(`open ${cfg.port} baud=${cfg.baud} ${cfg.dataBits}${cfg.parity[0]}${cfg.stopBits} `
                        + `flow=${cfg.flow} dtr=${cfg.dtr} rts=${cfg.rts}`);
                    const b = new SerialBridge(cfg, {
                        onRx: bytes => {
                            rxBytes += bytes.length;
                            // If the webview stalls, unsent data piles up in the message queue — drop it past 1 MB,
                            // better to lose a slice of log than freeze the whole extension host
                            if (rxPending > 1024 * 1024) { rxDropped += bytes.length; return; }
                            rxChunks.push(bytes);
                            rxPending += bytes.length;
                            if (!rxTimer) rxTimer = setTimeout(flushRx, 40);
                        },
                        onInfo: text => diag('port: ' + text),
                        onError: message => {
                            diag('bridge error: ' + message);
                            post({ type: 'bridgeError', message });
                        },
                        onExit: code => {
                            if (bridge === b) bridge = undefined;
                            clearTimeout(rxTimer); flushRx();     // Do not sit on the last few bytes
                            diag(`bridge exited (code ${code ?? 0}), rx=${rxBytes}, dropped=${rxDropped}`);
                            post({ type: 'closed', reason: `exit:${code ?? 0}` });
                        },
                    });
                    bridge = b;

                    const err = await b.open();
                    if (err) {
                        if (bridge === b) bridge = undefined;
                        diag('open failed: ' + err);
                        post({ type: 'openResult', ok: false, error: hintForOpenError(err) });
                        return;
                    }
                    diag(`opened ${cfg.port}`);
                    post({ type: 'openResult', ok: true, port: cfg.port, baud: cfg.baud });
                    break;
                }

                case 'close':
                    closeBridge('user');
                    break;

                // Any change to a serial setting is reported here and lands in globalState
                case 'savePrefs':
                    if (m.prefs && typeof m.prefs === 'object') {
                        await context.globalState.update(PREFS_KEY, m.prefs);
                    }
                    break;

                case 'send': {
                    const b64 = String(m.data ?? '');
                    if (!bridge || !bridge.isOpen || !bridge.send(Buffer.from(b64, 'base64'))) {
                        post({ type: 'sendFailed', error: 'Port is not open.' });
                    }
                    break;
                }

                case 'setLine':
                    bridge?.setLines(m.dtr !== false, m.rts !== false);
                    break;

                // A board's reset line usually hangs off DTR / RTS: pull it low, release it, and the board reboots
                // and prints its boot log again — far more reliable than waiting for it to speak.
                case 'resetPulse': {
                    const dtr = m.dtr !== false;
                    const rts = m.rts !== false;
                    if (!bridge?.isOpen) {
                        post({ type: 'bridgeError', message: 'Port is not open.' });
                        break;
                    }
                    diag(`reset pulse (back to dtr=${dtr} rts=${rts})`);
                    bridge.setLines(false, false);
                    const target = bridge;
                    setTimeout(() => target.setLines(dtr, rts), 300);
                    break;
                }

                case 'save': {
                    const text = String(m.text ?? '');
                    const suggested = String(m.name ?? 'serial-log.txt').replace(/[\\/:*?"<>|]/g, '_') || 'serial-log.txt';
                    const target = await vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.joinPath(
                            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(context.globalStorageUri.fsPath),
                            suggested),
                        saveLabel: 'Save log',
                        filters: { 'Text log': ['txt', 'log'], 'All files': ['*'] },
                    });
                    if (!target) { post({ type: 'saved', ok: false }); return; }
                    try {
                        fs.writeFileSync(target.fsPath, text.length > MAX_TEXT ? text.slice(-MAX_TEXT) : text, 'utf8');
                        post({ type: 'saved', ok: true, path: target.fsPath });
                    } catch (e) {
                        vscode.window.showErrorMessage(`COM Assistant: cannot write the log.\n${(e as Error).message}`);
                        post({ type: 'saved', ok: false, error: (e as Error).message });
                    }
                    break;
                }

                case 'copy': {
                    try { await vscode.env.clipboard.writeText(String(m.text ?? '')); } catch { /* ignore */ }
                    break;
                }

                // Context-menu Paste: the webview has no clipboard access, so the extension process reads it and posts it back
                case 'paste': {
                    let text = '';
                    try { text = await vscode.env.clipboard.readText(); } catch { /* ignore */ }
                    post({ type: 'clipboardText', text });
                    break;
                }
            }
        } catch (e) {
            vscode.window.showErrorMessage(`COM Assistant: ${(e as Error).message}`);
        }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => closeBridge('panel'), null, context.subscriptions);
}
