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
exports.registerBinaryEditor = registerBinaryEditor;
exports.openBinaryEditor = openBinaryEditor;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const pairDir_1 = require("./pairDir");
const srcLocate_1 = require("./srcLocate");
const webview_1 = require("./webview");
// ---------------------------------------------------------------------------
// Binary Editor webview
// Runs the standalone Binary Editor (a two-pane hex editor, media/binary-editor.html)
// as a built-in editor. Every file read and write inside the webview is bridged here over postMessage:
//   webview -> host : ready / pickFile / save / readClipboard / writeClipboard / readUris
//   host -> webview : init / filePicked / fileDirect / filesLoaded2 / saved / clipboardText / clipboardError
// ---------------------------------------------------------------------------
const MAX_FILE_BYTES = 64 * 1024 * 1024; // 64 MB; anything larger is reported and left to the command line
function readAsBase64(fp) {
    return fs.readFileSync(fp).toString('base64');
}
function sanitizeName(name) {
    const cleaned = String(name || 'output.bin').replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned || 'output.bin';
}
async function readUriChecked(uri) {
    let stat;
    try {
        stat = fs.statSync(uri.fsPath);
    }
    catch {
        vscode.window.showErrorMessage(`Binary Editor: cannot read "${uri.fsPath}".`);
        return null;
    }
    if (stat.isDirectory()) {
        vscode.window.showErrorMessage(`Binary Editor: "${path.basename(uri.fsPath)}" is a folder, not a file.`);
        return null;
    }
    if (stat.size > MAX_FILE_BYTES) {
        vscode.window.showErrorMessage(`Binary Editor: file too large (${(stat.size / 1048576).toFixed(1)} MB, limit 64 MB):\n${uri.fsPath}`);
        return null;
    }
    const name = path.basename(uri.fsPath);
    (0, srcLocate_1.rememberSrc)(uri.fsPath, name, stat.size); // Cache name+size -> path so the same file dropped again needs no lookup
    return { name, path: uri.fsPath, data: readAsBase64(uri.fsPath) };
}
function statOf(fp) {
    try {
        return fs.statSync(fp);
    }
    catch {
        return null;
    }
}
/** A dropped item may be a file:// URI, a vscode-file:// URI or a bare path; normalise it to a Uri */
function toUri(raw) {
    const s = String(raw || '').trim();
    if (!s)
        return null;
    if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\'))
        return vscode.Uri.file(s); // Windows path / UNC
    if (s.startsWith('/'))
        return vscode.Uri.file(s);
    if (/^file:/i.test(s))
        return vscode.Uri.parse(s, true);
    try {
        return vscode.Uri.parse(s, true);
    }
    catch {
        return null;
    }
}
const BE_BASE_KEY = 'biosBuddy.beCompareBase'; // "Select Hex for Compare" remembers this file
const BE_BASE_CTX = 'biosBuddy.beHasBase'; // ...and this makes "Compare Hex with Selected" appear
/**
 * Right-clicking one file in Explorer calls back with (uri, selectedUris) where selectedUris
 * holds that same file, so the raw argument list repeats it. Dedupe by path: without this a
 * single click used to open the file on both sides, i.e. a diff of a file against itself.
 */
function uniqueUris(list) {
    const out = [];
    const seen = new Set();
    for (const a of list) {
        if (!(a instanceof vscode.Uri))
            continue;
        const key = a.fsPath.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(a);
    }
    return out;
}
function registerBinaryEditor(context) {
    (0, srcLocate_1.initSourceIndex)(context.globalState);
    void vscode.commands.executeCommand('setContext', BE_BASE_CTX, !!context.workspaceState.get(BE_BASE_KEY));
    context.subscriptions.push(vscode.commands.registerCommand('biosBuddy.binaryEditor', (...args) => {
        // The explorer context menu / drop controller may pass (uri) or (uri, selectedUris[])
        openBinaryEditor(context, uniqueUris(args.flat(2)));
    }), 
    // Hex compare in two steps, the same way Text Comparer and VS Code's own diff do it:
    // right-click A -> Select Hex for Compare, right-click B -> Compare Hex with Selected.
    vscode.commands.registerCommand('biosBuddy.beSelectBase', async (uri) => {
        const target = uniqueUris([uri])[0];
        if (!target)
            return;
        await context.workspaceState.update(BE_BASE_KEY, target.fsPath);
        await vscode.commands.executeCommand('setContext', BE_BASE_CTX, true);
        vscode.window.setStatusBarMessage(`$(bookmark) Hex compare base: ${path.basename(target.fsPath)}`, 4000);
    }), vscode.commands.registerCommand('biosBuddy.beCompareWithBase', async (uri) => {
        const base = context.workspaceState.get(BE_BASE_KEY);
        const other = uniqueUris([uri])[0];
        if (!base) {
            vscode.window.showInformationMessage('No hex compare base yet — right-click a file and pick "BIOS Buddy: Select Hex for Compare (A)" first.');
            return;
        }
        if (!other)
            return;
        if (base.toLowerCase() === other.fsPath.toLowerCase()) {
            vscode.window.showInformationMessage('That is the hex compare base itself — pick the other file.');
            return;
        }
        if (!fs.existsSync(base)) {
            const pick = await vscode.window.showWarningMessage(`Hex compare base is gone: ${base}`, 'Pick another file instead');
            if (pick) {
                await context.workspaceState.update(BE_BASE_KEY, undefined);
                await vscode.commands.executeCommand('setContext', BE_BASE_CTX, false);
            }
            return;
        }
        openBinaryEditor(context, [vscode.Uri.file(base), other]);
    }));
    // Split Editor rebuilds the webview; without a serializer it reopens blank (the "splitting never works" users report)
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('biosBinaryEditor', {
        async deserializeWebviewPanel(panel, state) {
            const st = state;
            // A tick later: a restored panel drops the html written in the same tick on some builds
            setTimeout(() => attachBinaryEditor(context, panel, [], st?.snap, true), 0);
        },
    }));
}
// Usually one Binary Editor per window: opening again just reveals it.
// Split Editor creates an extra copy, so track them in a set and fall back when one closes.
const panels = new Set();
let livePanel;
/** When the last panel went away: a new one right after that is a split / moved copy */
let lastCloseAt = 0;
let liveSnap;
/** The snapshot lives in memory only: a split webview is ready almost immediately, while liveSnap is still around.
 *  A pane counts as restorable when it carries either its bytes or the path they can be re-read from. */
function snapSeed(s) {
    if (!s)
        return undefined;
    const ok = (v) => !!v && ((typeof v.data === 'string' && v.data.length > 0) || !!v.path);
    if (!ok(s.a) && !ok(s.b))
        return undefined;
    return s;
}
async function openBinaryEditor(context, files = []) {
    const pick = files.filter(f => { try {
        return fs.existsSync(f.fsPath) && fs.statSync(f.fsPath).isFile();
    }
    catch {
        return false;
    } }).slice(0, 2);
    if (livePanel) {
        livePanel.reveal(livePanel.viewColumn ?? vscode.ViewColumn.Active, false);
        if (pick.length) {
            /* The same files are already on screen: just show the panel. Re-reading them here is the
               "loading the same firmware again" the user sees when they only wanted the window back. */
            const same = liveSnap
                && liveSnap.a?.path === pick[0].fsPath
                && (pick[1] ? liveSnap.b?.path === pick[1].fsPath : !liveSnap.b);
            if (same)
                return;
            try {
                const a = await readUriChecked(pick[0]);
                const b = pick[1] ? await readUriChecked(pick[1]) : null;
                if (a && b)
                    livePanel.webview.postMessage({ type: 'filesLoaded2', a, b });
                else if (a)
                    livePanel.webview.postMessage({ type: 'init', pane: 'A', single: true, name: a.name, path: a.path, data: a.data });
            }
            catch { /* disposed */ }
        }
        return;
    }
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('biosBinaryEditor', 'Binary Editor', vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [mediaDir],
    });
    if (files.length > 2) {
        vscode.window.showInformationMessage(`Binary Editor: opened the first 2 of ${files.length} files (A and B).`);
    }
    attachBinaryEditor(context, panel, pick.map(f => f.fsPath), undefined, false);
    if (pick.length === 1) {
        vscode.window.setStatusBarMessage(`$(info) ${path.basename(pick[0].fsPath)} → pane A (single-pane edit). Right-click the other file → "BIOS Buddy: Compare Hex with Selected (B)" to diff.`, 6000);
    }
}
/**
 * Wire up a panel: set the html, install the message handler, decide what to push on ready.
 * Shared by the command-line open path and a split copy restored by the serializer.
 */
function attachBinaryEditor(context, panel, initFiles, seed, restoring) {
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
    // retainContextWhenHidden is a panel-level option; webview.options has no such field
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaDir] };
    panel.iconPath = vscode.Uri.joinPath(mediaDir, 'bios.png');
    /* A panel that pops up right after another one closed, or while another one is
       still around, is a split / moved copy of the same editor — not a fresh open.
       Fresh opens start empty; copies get the snapshot pushed back. */
    const isCopy = restoring || panels.size > 0 || (Date.now() - lastCloseAt < 2500);
    panels.add(panel);
    livePanel = panel;
    const html = (0, webview_1.readWebviewHtml)(mediaDir, 'binary-editor.html');
    panel.webview.html = html;
    // Restored panels can keep the html handed to them here (see reloadIfBlank)
    const markReady = (0, webview_1.reloadIfBlank)(panel, html);
    panel.onDidDispose(() => {
        // liveSnap is deliberately kept: on split the old panel disposes before the new one is ready, clearing it would lose the snapshot in that gap
        lastCloseAt = Date.now();
        panels.delete(panel);
        if (livePanel === panel)
            livePanel = panels.values().next().value;
    });
    const post = (msg) => { try {
        panel.webview.postMessage(msg);
    }
    catch { /* disposed */ } };
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
    /** The snapshot is pushed at most once per webview: needSnap usually lands before ready */
    let snapSent = false;
    /** Read a file for a restore: no dialogs, no error popups, null when it is gone or unreadable */
    const readQuiet = (p) => {
        if (!p)
            return null;
        try {
            const st = fs.statSync(p);
            if (!st.isFile() || st.size > MAX_FILE_BYTES)
                return null;
            return { name: path.basename(p), path: p, data: readAsBase64(p) };
        }
        catch {
            return null;
        }
    };
    /** Put the two files back from their paths, silently: this is a restore, not a fresh load */
    const pushFromPaths = (aPath, bPath) => {
        const a = readQuiet(aPath);
        const b = readQuiet(bPath);
        if (a && b)
            post({ type: 'filesLoaded2', a, b, quiet: true });
        else if (a)
            post({ type: 'init', pane: 'A', name: a.name, path: a.path, data: a.data, quiet: true });
        else if (b)
            post({ type: 'init', pane: 'B', name: b.name, path: b.path, data: b.data, quiet: true });
    };
    /** Push one snapshot into the webview: bytes when the snapshot has them, paths otherwise */
    const postSnap = (s) => {
        if (!s)
            return;
        const withData = (v) => !!v && typeof v.data === 'string' && v.data.length > 0;
        if (withData(s.a) && withData(s.b)) {
            post({ type: 'filesLoaded2', a: s.a, b: s.b, quiet: true });
        }
        else if (withData(s.a)) {
            const one = s.a;
            post({ type: 'init', pane: 'A', name: one.name, path: one.path, data: one.data, quiet: true });
        }
        else if (withData(s.b)) {
            const one = s.b;
            post({ type: 'init', pane: 'B', name: one.name, path: one.path, data: one.data, quiet: true });
        }
        else if (s.a?.path || s.b?.path) {
            /* The bytes never made it into the snapshot (too large, or a state copy that dropped them):
               re-read the recorded files instead of restoring a pair of empty panes. */
            pushFromPaths(s.a?.path ?? '', s.b?.path ?? '');
        }
    };
    const putSnap = (s) => {
        if (snapSent)
            return;
        snapSent = true;
        postSnap(s);
    };
    panel.webview.onDidReceiveMessage(async (m) => {
        if (!m || typeof m.type !== 'string')
            return;
        markReady(); // any message proves the page is up: no reload wanted
        try {
            switch (m.type) {
                // Opened with files -> two land in A + B, one lands in A
                case 'ready': {
                    // Opened with files: files win, overwrite whatever the webview restored by itself
                    if (!initFiles.length) {
                        // The webview already restored from its own state (split / moved group), do not push again
                        if (m.restored === true || snapSent)
                            break;
                        // Split / moved to another editor group: the new webview is blank, push the snapshot back first;
                        // a fresh command-line open skips this and keeps both panes empty
                        const s = isCopy ? (snapSeed(liveSnap) ?? snapSeed(seed)) : undefined;
                        if (s) {
                            putSnap(s);
                            break;
                        }
                    }
                    if (initFiles.length >= 2) {
                        const a = await readUriChecked(vscode.Uri.file(initFiles[0]));
                        const b = await readUriChecked(vscode.Uri.file(initFiles[1]));
                        if (a && b)
                            post({ type: 'filesLoaded2', a, b });
                    }
                    else if (initFiles.length === 1) {
                        const f = await readUriChecked(vscode.Uri.file(initFiles[0]));
                        if (f)
                            post({ type: 'init', pane: 'A', single: true, name: f.name, path: f.path, data: f.data });
                    }
                    break;
                }
                // A new webview starts with nothing (Split Editor often carries no state at all):
                // hand back the two panes that were last shown instead of leaving it at "Not loaded".
                case 'needSnap': {
                    if (!isCopy)
                        return;
                    const s = snapSeed(liveSnap) ?? snapSeed(seed);
                    if (s)
                        putSnap(s);
                    break;
                }
                // Import dialog "choose file": multi-select allowed, two picks fill A + B
                case 'pickFile': {
                    const pane = (m.pane === 'B' ? 'B' : 'A');
                    const uris = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        openLabel: 'Load into Binary Editor',
                        defaultUri: (0, srcLocate_1.defaultDirUri)() ?? wsFolder,
                    });
                    if (!uris || uris.length === 0)
                        return;
                    if (uris.length >= 2) {
                        const a = await readUriChecked(uris[0]);
                        const b = await readUriChecked(uris[1]);
                        if (a && b)
                            post({ type: 'filesLoaded2', a, b });
                        return;
                    }
                    const f = await readUriChecked(uris[0]);
                    if (f)
                        post({ type: 'filePicked', pane, name: f.name, path: f.path, data: f.data });
                    break;
                }
                // Save: show the VS Code save dialog; a name the user edits wins
                case 'save': {
                    const id = m.id;
                    const suggested = sanitizeName(m.name);
                    const baseDir = (0, srcLocate_1.defaultDirUri)() ?? wsFolder;
                    const target = await vscode.window.showSaveDialog({
                        defaultUri: baseDir
                            ? vscode.Uri.joinPath(baseDir, suggested)
                            : vscode.Uri.joinPath(context.globalStorageUri, suggested),
                        saveLabel: 'Save',
                    });
                    if (!target) {
                        post({ type: 'saved', id, ok: false });
                        return;
                    }
                    try {
                        fs.writeFileSync(target.fsPath, Buffer.from(m.data, 'base64'));
                        (0, srcLocate_1.rememberSrc)(target.fsPath); // Remember where it landed so reopening the same file skips the directory picker
                        post({ type: 'saved', id, ok: true, name: path.basename(target.fsPath), path: target.fsPath });
                    }
                    catch (err) {
                        vscode.window.showErrorMessage(`Binary Editor: failed to write file.\n${err.message}`);
                        post({ type: 'saved', id, ok: false });
                    }
                    break;
                }
                // Files dropped in from the explorer / a tab (at most two)
                case 'readUris': {
                    const total = Number(m.total ?? m.uris.length);
                    const raws = m.uris.slice(0, 2);
                    const uris = raws.map(toUri).filter((u) => u !== null);
                    const alt = m.alt === true;
                    if (total > 2) {
                        vscode.window.showInformationMessage(`Binary Editor: ${total} files dropped — only the first 2 were loaded (A and B).`);
                    }
                    if (uris.length >= 2) {
                        const a = await readUriChecked(uris[0]);
                        const b = await readUriChecked(uris[1]);
                        if (a && b)
                            post({ type: 'filesLoaded2', a, b });
                    }
                    else if (uris.length === 1) {
                        const f = await readUriChecked(uris[0]);
                        if (f)
                            post({ type: 'fileDirect', pane: alt ? 'B' : 'A', name: f.name, path: f.path, data: f.data });
                    }
                    break;
                }
                // No source path (e.g. dragged straight out of the OS file manager):
                // resolve once by file name + size. Any size mismatch is rejected to avoid overwriting a namesake.
                // ask=false: silent lookup on load, accept only a unique hit, never prompt;
                // ask=true : the user pressed Save, so with several namesakes let them pick one.
                // Lookup order: previously resolved (cache) -> directory of the other pane -> open editors / workspace
                //               -> recently touched directories (also covers paths outside the workspace) -> finally ask the user once.
                case 'locateFile': {
                    const id = m.id;
                    const name = path.basename(String(m.name ?? ''));
                    const want = (typeof m.size === 'number' && m.size > 0) ? m.size : null;
                    const ask = m.ask === true;
                    const nearPath = String(m.nearPath ?? '');
                    const nearDir = nearPath ? path.dirname(nearPath) : '';
                    if (!name) {
                        post({ type: 'locateResult', id, path: null, none: true });
                        return;
                    }
                    // 0) A previously resolved source (picked or read/written by the user) - the same file dropped again hits directly.
                    //    Accept it even if the content or size changed: the user confirmed this very file.
                    const memo = (0, srcLocate_1.cachedSource)(name, want ?? 0);
                    if (memo) {
                        const stm = statOf(memo);
                        if (stm && stm.isFile()) {
                            post({ type: 'locateResult', id, path: memo, size: stm.size, trusted: true });
                            return;
                        }
                    }
                    const seen = new Set();
                    const cands = [];
                    const consider = (fp, hot) => {
                        const key = fp.toLowerCase();
                        if (seen.has(key))
                            return;
                        if (path.basename(fp).toLowerCase() !== name.toLowerCase())
                            return;
                        const st = statOf(fp);
                        if (!st || !st.isFile())
                            return;
                        if (want != null && st.size !== want)
                            return; // size mismatch: never accept
                        seen.add(key);
                        cands.push({ fsPath: fp, size: st.size, mtime: st.mtimeMs, hot });
                    };
                    // 1) Two files dropped together come from one directory: check the other pane's directory first.
                    //    Matching name and size means it is surely that file, so resolve it without a namesake picker.
                    if (nearDir) {
                        const sib = path.join(nearDir, name);
                        const st0 = statOf(sib);
                        if (st0 && st0.isFile() && (want == null || st0.size === want)) {
                            (0, srcLocate_1.rememberSrc)(sib, name, st0.size);
                            post({ type: 'locateResult', id, path: sib, size: st0.size });
                            return;
                        }
                    }
                    // 2) Files this panel opened with, plus visible editors: same name and size is most likely it
                    for (const fp of initFiles)
                        consider(fp, true);
                    for (const ed of vscode.window.visibleTextEditors)
                        consider(ed.document.uri.fsPath, true);
                    // 3) Namesakes inside the workspace
                    const found = await vscode.workspace.findFiles(`**/${name}`, '**/node_modules/**', 40);
                    for (const u of found)
                        consider(u.fsPath, false);
                    // 4) Outside the workspace: recently touched directories (dropped files often live there)
                    if (!cands.length) {
                        for (const fp of await (0, srcLocate_1.scanRecentDirs)(name, want ?? 0))
                            consider(fp, true);
                    }
                    if (cands.length === 0) {
                        // 5) Nothing found: if Save was pressed, let the user point at the source once - it is remembered
                        if (ask) {
                            const pickedPath = await (0, srcLocate_1.askSourceFile)(name, want ?? 0);
                            if (pickedPath) {
                                const stp = statOf(pickedPath);
                                post({
                                    type: 'locateResult', id, path: pickedPath,
                                    size: stp ? stp.size : (want ?? 0), trusted: true,
                                });
                                return;
                            }
                            post({ type: 'locateResult', id, path: null }); // user cancelled: do nothing
                            return;
                        }
                        post({ type: 'locateResult', id, path: null, none: true });
                        return;
                    }
                    if (cands.length === 1) {
                        (0, srcLocate_1.rememberSrc)(cands[0].fsPath, name, cands[0].size);
                        post({ type: 'locateResult', id, path: cands[0].fsPath, size: cands[0].size });
                        return;
                    }
                    if (!ask) {
                        post({ type: 'locateResult', id, path: null });
                        return;
                    } // background lookup, stay silent
                    // Save pressed and several candidates: list them (same directory / currently open files first)
                    const near = nearDir.toLowerCase();
                    const isNear = (c) => !!near && path.dirname(c.fsPath).toLowerCase() === near;
                    cands.sort((x, y) => (Number(isNear(y)) - Number(isNear(x)))
                        || (Number(y.hot) - Number(x.hot)) || (y.mtime - x.mtime));
                    const items = cands.map(c => ({
                        label: (isNear(c) ? '$(folder) ' : (c.hot ? '$(file) ' : '$(file-binary) ')) + path.basename(c.fsPath),
                        description: vscode.workspace.asRelativePath(c.fsPath, false),
                        detail: `${c.fsPath}  ·  ${c.size.toLocaleString()} bytes`,
                        cand: c,
                    }));
                    const picked = await vscode.window.showQuickPick(items, {
                        title: `Binary Editor: which "${name}" should Save write back to?`,
                        placeHolder: 'Only files of the same size are listed — press Esc to cancel',
                        ignoreFocusOut: true,
                    });
                    if (!picked) {
                        post({ type: 'locateResult', id, path: null });
                        return;
                    }
                    (0, srcLocate_1.rememberSrc)(picked.cand.fsPath, name, picked.cand.size); // remember the user's choice
                    post({ type: 'locateResult', id, path: picked.cand.fsPath, size: picked.cand.size, trusted: true });
                    break;
                }
                // Two files dropped together must come from the same directory.
                // Find the directory holding both (name and size matching):
                // a unique hit resolves both panes, so Save overwrites directly instead of listing namesakes.
                case 'locatePair': {
                    const id = m.id;
                    const pa = (m.a ?? {});
                    const pb = (m.b ?? {});
                    const nA = path.basename(String(pa.name ?? ''));
                    const nB = path.basename(String(pb.name ?? ''));
                    const sA = (typeof pa.size === 'number' && pa.size > 0) ? pa.size : null;
                    const sB = (typeof pb.size === 'number' && pb.size > 0) ? pb.size : null;
                    if (!nA || !nB) {
                        post({ type: 'locatePairResult', id, a: null, b: null });
                        return;
                    }
                    const listOf = async (nm, want) => {
                        const out = [];
                        const seen = new Set();
                        const add = (fp) => {
                            const key = fp.toLowerCase();
                            if (seen.has(key))
                                return;
                            if (path.basename(fp).toLowerCase() !== nm.toLowerCase())
                                return;
                            const st = statOf(fp);
                            if (!st || !st.isFile())
                                return;
                            if (want != null && st.size !== want)
                                return;
                            seen.add(key);
                            out.push({ dir: path.dirname(fp).toLowerCase(), fsPath: fp, size: st.size });
                        };
                        // Inside the workspace
                        for (const u of await vscode.workspace.findFiles(`**/${nm}`, '**/node_modules/**', 200)) {
                            add(u.fsPath);
                        }
                        // Outside the workspace: recently touched directories (both files of one drop live together)
                        for (const fp of await (0, srcLocate_1.scanRecentDirs)(nm, want ?? 0))
                            add(fp);
                        return out;
                    };
                    const [la, lb] = await Promise.all([listOf(nA, sA), listOf(nB, sB)]);
                    const hit = (0, pairDir_1.pickPairHit)(la, lb);
                    if (!hit) { // none / more than one directory: fall back to per-pane lookup
                        post({ type: 'locatePairResult', id, a: null, b: null });
                        return;
                    }
                    post({
                        type: 'locatePairResult', id,
                        a: { path: hit.a.fsPath, size: hit.a.size },
                        b: { path: hit.b.fsPath, size: hit.b.size },
                    });
                    (0, srcLocate_1.rememberSrc)(hit.a.fsPath, nA, hit.a.size);
                    (0, srcLocate_1.rememberSrc)(hit.b.fsPath, nB, hit.b.size);
                    break;
                }
                // Save back to the source: the webview already confirmed, so overwrite the original path directly
                case 'writeFile': {
                    const id = m.id;
                    const target = String(m.path ?? '');
                    try {
                        if (!target || !fs.existsSync(target))
                            throw new Error('source file not found: ' + target);
                        fs.writeFileSync(target, Buffer.from(m.data, 'base64'));
                        (0, srcLocate_1.rememberSrc)(target); // a successful write means this path is confirmed
                        post({ type: 'writeResult', id, ok: true });
                    }
                    catch (err) {
                        vscode.window.showErrorMessage(`Binary Editor: failed to write back.\n${err.message}`);
                        post({ type: 'writeResult', id, ok: false });
                    }
                    break;
                }
                // The webview reports a two-pane snapshot on every content change (used to restore splits / moves).
                // snapshotPaths carries the same shape without the bytes: too big to shuttle, but the paths
                // are enough to re-read the two files silently when the page is rebuilt.
                case 'snapshot':
                case 'snapshotPaths': {
                    const pick = (v) => {
                        const o = v;
                        if (!o)
                            return null;
                        const name = String(o.name ?? '');
                        const data = typeof o.data === 'string' ? o.data : '';
                        if (!name && !data)
                            return null;
                        return { name, path: String(o.path ?? ''), data };
                    };
                    liveSnap = { a: pick(m.a), b: pick(m.b) };
                    if (!liveSnap.a && !liveSnap.b)
                        liveSnap = undefined;
                    break;
                }
                // A rebuilt page whose saved snapshot lost the bytes (or never had them, because the
                // pair was too large): hand it the panes again — from the in-memory snapshot when that
                // still holds the bytes (keeps unsaved edits), from disk otherwise. Quiet either way.
                case 'restorePaths': {
                    if (snapSent)
                        break;
                    snapSent = true;
                    const pa = String(m.a ?? '');
                    const pb = String(m.b ?? '');
                    const live = liveSnap;
                    const covers = (v, p) => !!v && typeof v.data === 'string' && v.data.length > 0 && (!p || v.path === p);
                    if (live && (covers(live.a, pa) || covers(live.b, pb)))
                        postSnap(live);
                    else
                        pushFromPaths(pa, pb);
                    break;
                }
                case 'readClipboard': {
                    try {
                        post({ type: 'clipboardText', text: await vscode.env.clipboard.readText() });
                    }
                    catch {
                        post({ type: 'clipboardError' });
                    }
                    break;
                }
                case 'writeClipboard': {
                    try {
                        await vscode.env.clipboard.writeText(String(m.text ?? ''));
                    }
                    catch { /* ignore */ }
                    break;
                }
            }
        }
        catch (err) {
            vscode.window.showErrorMessage(`Binary Editor: ${err.message}`);
        }
    }, undefined, context.subscriptions);
}
//# sourceMappingURL=binaryEditor.js.map