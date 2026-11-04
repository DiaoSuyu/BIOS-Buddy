import * as vscode from 'vscode';
import * as fs from 'fs';
import { readWebviewHtml } from './webview';

/**
 * GUID Tool — a standalone webview panel that generates GUIDs and converts
 * between the textual forms used in firmware work (D / N / B / P, C struct,
 * UEFI #define, EFI byte array, raw bytes, Base64).
 *
 * All of the conversion logic lives in the webview (media/guid-tool.html);
 * the extension only owns the panel and the clipboard, which a sandboxed
 * webview is not allowed to touch directly.
 */

let panel: vscode.WebviewPanel | undefined;

export function registerGuidTool(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('biosBuddy.guidTool', () => openGuidTool(context)),
        // Splitting or reloading the tab rebuilds the webview; without this the
        // new view has no way back to the extension and shows up blank.
        vscode.window.registerWebviewPanelSerializer('biosGuidTool', {
            async deserializeWebviewPanel(p: vscode.WebviewPanel) { attach(context, p); },
        }),
    );
}

export function openGuidTool(context: vscode.ExtensionContext) {
    if (panel) {
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Active, false);
        return;
    }
    const p = vscode.window.createWebviewPanel(
        'biosGuidTool',
        'GUID Assistant',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaDir(context)] },
    );
    attach(context, p);
}

function mediaDir(context: vscode.ExtensionContext): vscode.Uri {
    return vscode.Uri.joinPath(context.extensionUri, 'media');
}

function attach(context: vscode.ExtensionContext, p: vscode.WebviewPanel) {
    const dir = mediaDir(context);
    p.webview.options = { enableScripts: true, localResourceRoots: [dir] };
    p.iconPath = vscode.Uri.joinPath(dir, 'bios.png');
    p.webview.html = readWebviewHtml(dir, 'guid-tool.html');

    panel = p;
    p.onDidDispose(() => {
        if (panel === p) panel = undefined;
    });

    p.webview.onDidReceiveMessage(async (m: { type: string; [k: string]: unknown }) => {
        if (!m || typeof m.type !== 'string') return;
        try {
            if (m.type === 'copy') {
                // Copied lines may hold several formats at once; keep the line breaks.
                await vscode.env.clipboard.writeText(String(m.text ?? ''));
            } else if (m.type === 'readClipboard') {
                const text = await vscode.env.clipboard.readText();
                p.webview.postMessage({ type: 'clipboard', text });
            }
        } catch {
            // The clipboard can be denied by policy; the tool still works by hand.
        }
    });
}
