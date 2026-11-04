"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readWebviewHtml = readWebviewHtml;
exports.reloadIfBlank = reloadIfBlank;
const fs = __importStar(require("fs"));
const vscode = __importStar(require("vscode"));
const version_1 = require("./version");
function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
/**
 * A page the user can actually read when the real one cannot be loaded.
 * Without this a failed read leaves the panel completely black, which tells nobody anything.
 */
function errorPage(file, message) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>BIOS Buddy</title><style>
body{margin:0;padding:26px 28px;background:#1e1e1e;color:#d4d4d4;
  font:13px/1.65 "Segoe UI","Microsoft YaHei UI","PingFang SC",sans-serif}
h1{font-size:15px;margin:0 0 12px;color:#f48771}
code{background:#2d2d2d;border:1px solid #3c3c3c;border-radius:4px;padding:2px 6px;
  font-family:Consolas,"Courier New",monospace}
p{margin:8px 0}
</style></head><body>
<h1>This tool page could not be loaded</h1>
<p><code>${esc(file)}</code></p>
<p>${esc(message)}</p>
<p>Reinstalling the extension usually fixes it — the <code>media</code> folder ships inside the package.</p>
</body></html>`;
}
/** Read media/<file> and stamp the tool version into it, never throwing: a broken page is
 *  better than an empty panel, and the empty panel is exactly what a thrown FS error produced. */
function readWebviewHtml(mediaDir, file) {
    const fp = vscode.Uri.joinPath(mediaDir, file).fsPath;
    try {
        const html = fs.readFileSync(fp, 'utf8');
        if (!html.trim())
            return errorPage(fp, 'The file is empty.');
        return (0, version_1.stampVersion)(html);
    }
    catch (e) {
        return errorPage(fp, e instanceof Error ? e.message : String(e));
    }
}
/**
 * VS Code occasionally drops the html a webview panel gets while it is being restored from a
 * previous window, leaving a restored panel blank while a freshly opened one is fine. The page
 * always says "ready" once its script runs, so if that never arrives, write the html once more.
 */
function reloadIfBlank(panel, html) {
    let ready = false;
    const opened = Date.now();
    const write = () => {
        if (ready)
            return;
        try {
            panel.webview.html = html;
        }
        catch { /* disposed */ }
    };
    const timer = setTimeout(write, 2500);
    // A panel that was hidden while its content was dropped only shows the problem when it comes
    // back, so a repaint on "visible again" asks the same question one more time
    const sub = panel.onDidChangeViewState(() => {
        if (panel.visible && Date.now() - opened > 1200)
            write();
    });
    return () => {
        ready = true;
        clearTimeout(timer);
        sub.dispose();
    };
}
//# sourceMappingURL=webview.js.map