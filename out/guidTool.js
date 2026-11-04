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
exports.registerGuidTool = registerGuidTool;
exports.openGuidTool = openGuidTool;
const vscode = __importStar(require("vscode"));
const webview_1 = require("./webview");
/**
 * GUID Tool — a standalone webview panel that generates GUIDs and converts
 * between the textual forms used in firmware work (D / N / B / P, C struct,
 * UEFI #define, EFI byte array, raw bytes, Base64).
 *
 * All of the conversion logic lives in the webview (media/guid-tool.html);
 * the extension only owns the panel and the clipboard, which a sandboxed
 * webview is not allowed to touch directly.
 */
let panel;
function registerGuidTool(context) {
    context.subscriptions.push(vscode.commands.registerCommand('biosBuddy.guidTool', () => openGuidTool(context)), 
    // Splitting or reloading the tab rebuilds the webview; without this the
    // new view has no way back to the extension and shows up blank.
    vscode.window.registerWebviewPanelSerializer('biosGuidTool', {
        async deserializeWebviewPanel(p) { attach(context, p); },
    }));
}
function openGuidTool(context) {
    if (panel) {
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
        return;
    }
    const p = vscode.window.createWebviewPanel('biosGuidTool', 'GUID Assistant', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaDir(context)] });
    attach(context, p);
}
function mediaDir(context) {
    return vscode.Uri.joinPath(context.extensionUri, 'media');
}
function attach(context, p) {
    const dir = mediaDir(context);
    p.webview.options = { enableScripts: true, localResourceRoots: [dir] };
    p.iconPath = vscode.Uri.joinPath(dir, 'bios.png');
    p.webview.html = (0, webview_1.readWebviewHtml)(dir, 'guid-tool.html');
    panel = p;
    p.onDidDispose(() => {
        if (panel === p)
            panel = undefined;
    });
    p.webview.onDidReceiveMessage(async (m) => {
        if (!m || typeof m.type !== 'string')
            return;
        try {
            if (m.type === 'copy') {
                // Copied lines may hold several formats at once; keep the line breaks.
                await vscode.env.clipboard.writeText(String(m.text ?? ''));
            }
            else if (m.type === 'readClipboard') {
                const text = await vscode.env.clipboard.readText();
                p.webview.postMessage({ type: 'clipboard', text });
            }
        }
        catch {
            // The clipboard can be denied by policy; the tool still works by hand.
        }
    });
}
//# sourceMappingURL=guidTool.js.map