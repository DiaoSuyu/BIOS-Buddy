import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { askSourceFile, cachedSource, defaultDirUri, initSourceIndex, rememberSrc, scanRecentDirs } from './srcLocate';
import { readWebviewHtml, reloadIfBlank } from './webview';

// ---------------------------------------------------------------------------
// Text Comparer webview
// Side-by-side text comparison (media/text-compare.html). The webview diffs and draws;
// reading, clipboard and saving all come through here:
//   webview -> host : ready / pickFile / readUris / clipboardRead / copy / save / savePane / saveAs
//   host -> webview : load / loadBoth / clipboard / saved / savedPane / saveFail / error
// With dialog set, pickFile and readUris only fill the import dialog's A / B boxes, never the panes
// ---------------------------------------------------------------------------

const MAX_BYTES = 32 * 1024 * 1024;   // 32 MB: past that this stops being a diff view and becomes a job for a real tool

interface LoadedText {
    name: string;
    path: string;
    text: string;
    enc: string;
    bytes: number;
}

/** Detect the encoding from the BOM: UTF-16LE / UTF-16BE / UTF-8, with or without BOM, so it round-trips exactly */
function decodeText(buf: Buffer): { text: string; enc: string } {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        return { text: buf.subarray(2).toString('utf16le'), enc: 'UTF-16LE' };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        const body = Buffer.from(buf.subarray(2));
        body.swap16();
        return { text: body.toString('utf16le'), enc: 'UTF-16BE' };
    }
    let text = buf.toString('utf8');
    let bom = false;
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bom = true; }
    return { text, enc: bom ? 'UTF-8-BOM' : 'UTF-8' };
}

/** Write back in the original encoding — UTF-16 and BOM'd UTF-8 are never quietly turned into plain UTF-8 */
function encodeText(text: string, enc: string): Buffer {
    if (enc === 'UTF-16LE') {
        return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    }
    if (enc === 'UTF-16BE') {
        const body = Buffer.from(text, 'utf16le');
        body.swap16();
        return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
    if (enc === 'UTF-8-BOM') {
        return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    }
    return Buffer.from(text, 'utf8');
}

async function readTextFile(fp: string): Promise<LoadedText | null> {
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(fp); } catch {
        vscode.window.showErrorMessage(`Text Comparer: cannot read "${fp}".`);
        return null;
    }
    if (stat.isDirectory()) {
        vscode.window.showErrorMessage(`Text Comparer: "${path.basename(fp)}" is a folder.`);
        return null;
    }
    if (stat.size > MAX_BYTES) {
        vscode.window.showErrorMessage(
            `Text Comparer: file too large (${(stat.size / 1048576).toFixed(1)} MB, limit 32 MB):\n${fp}`);
        return null;
    }
    let buf: Buffer;
    try { buf = await fs.promises.readFile(fp); } catch (e) {
        vscode.window.showErrorMessage(`Text Comparer: ${(e as Error).message}`);
        return null;
    }
    const { text, enc } = decodeText(buf);
    const loaded: LoadedText = { name: path.basename(fp), path: fp, text, enc, bytes: buf.length };
    rememberSrc(fp, loaded.name, loaded.bytes);   // Remember "name + size → path" so the same drop never asks twice
    return loaded;
}

/**
 * Recover the real path from a file name. Dropped or pasted content carries no
 * path, so saving runs through here first: a cache hit returns at once, otherwise
 * search the workspace and then the recently used folders. A single hit (optionally
 * filtered by byte size) is used directly; several same-named matches and not
 * silent means the user picks one.
 */
async function locateFileByName(name: string, wantBytes = 0, silent = false): Promise<string> {
    const base = path.basename(String(name || '').trim());
    if (!base) return '';

    // 0) a source file confirmed before: the same drop hits and never bothers the user
    const memo = cachedSource(base, wantBytes);
    if (memo) return memo;

    const files: vscode.Uri[] = [];
    const seen = new Set<string>();
    const consider = async (fp: string) => {
        const key = fp.toLowerCase();
        if (seen.has(key)) return;
        try {
            const st = await fs.promises.stat(fp);
            if (!st.isFile()) return;
            if (wantBytes && st.size !== wantBytes) return;
        } catch { return; }
        seen.add(key);
        files.push(vscode.Uri.file(fp));
    };

    // 1) same-named files inside the workspace
    for (const u of await vscode.workspace.findFiles(`**/${base}`, '**/node_modules/**', 40)) {
        await consider(u.fsPath);
    }
    // 2) outside it: recently used folders, where dropped files usually live
    if (!files.length) {
        for (const fp of await scanRecentDirs(base, wantBytes)) await consider(fp);
    }

    if (files.length === 1) { rememberSrc(files[0].fsPath, base, wantBytes || undefined); return files[0].fsPath; }
    if (!files.length || silent) return '';
    const pick = await vscode.window.showQuickPick(
        files.map(u => ({
            label: path.basename(u.fsPath),
            description: vscode.workspace.asRelativePath(u, false),
            uri: u,
        })),
        { title: `Text Comparer: which "${base}"?`, ignoreFocusOut: true },
    );
    return pick ? pick.uri.fsPath : '';
}

/** A drop can be a file:// URI, a vscode-file:// URI or a bare path */function toFsPath(raw: string): string | null {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) return s;
    if (s.startsWith('/')) return s;
    if (/^file:/i.test(s)) {
        try { return vscode.Uri.parse(s, true).fsPath; } catch { return null; }
    }
    if (/^vscode-file:/i.test(s) || /^vscode-remote:/i.test(s)) {
        try { return vscode.Uri.parse(s, true).fsPath; } catch { return null; }
    }
    return null;
}

/** Explorer context menus are called with (uri) or (uri, selectedUris) — and with a single
 * selection the second argument repeats the first. Without dedupe, one right-click became
 * "two files" and the comparer dutifully loaded the file into A and B at once. */
function uniqueUris(args: unknown[]): vscode.Uri[] {
    const seen = new Set<string>();
    const out: vscode.Uri[] = [];
    for (const a of args) {
        if (!(a instanceof vscode.Uri)) continue;
        const k = a.fsPath.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(a);
    }
    return out;
}

const BASE_KEY = 'biosBuddy.tcCompareBase';   // "Select for Compare" remembers this file
const BASE_CTX = 'biosBuddy.tcHasBase';       // ...and this makes "Compare with Selected" appear

export function registerTextCompare(context: vscode.ExtensionContext) {
    initSourceIndex(context.globalState);
    void vscode.commands.executeCommand('setContext', BASE_CTX, !!context.workspaceState.get<string>(BASE_KEY));
    context.subscriptions.push(
        vscode.commands.registerCommand('biosBuddy.textComparer', (...args: unknown[]) => {
            // The Explorer context menu and the drop controller pass (uri) or (uri, selectedUris[])
            openTextComparer(context, uniqueUris(args.flat(2)).slice(0, 2));
        }),

        // Two-step compare, the same way VS Code's own diff works:
        // right-click A -> Select for Compare, right-click B -> Compare with Selected.
        vscode.commands.registerCommand('biosBuddy.tcSelectBase', async (uri?: vscode.Uri) => {
            const target = uniqueUris([uri])[0];
            if (!target) return;
            await context.workspaceState.update(BASE_KEY, target.fsPath);
            await vscode.commands.executeCommand('setContext', BASE_CTX, true);
            vscode.window.setStatusBarMessage(`$(bookmark) Compare base: ${path.basename(target.fsPath)}`, 4000);
        }),

        vscode.commands.registerCommand('biosBuddy.tcCompareWithBase', async (uri?: vscode.Uri) => {
            const base = context.workspaceState.get<string>(BASE_KEY);
            const other = uniqueUris([uri])[0];
            if (!base) {
                vscode.window.showInformationMessage('No compare base yet — right-click a file and pick "BIOS Buddy: Select Text for Compare (A)" first.');
                return;
            }
            if (!other) return;
            if (base.toLowerCase() === other.fsPath.toLowerCase()) {
                vscode.window.showInformationMessage('That is the compare base itself — pick the other file.');
                return;
            }
            if (!fs.existsSync(base)) {
                const pick = await vscode.window.showWarningMessage(`Compare base is gone: ${base}`, 'Pick another file instead');
                if (pick) {
                    await context.workspaceState.update(BASE_KEY, undefined);
                    await vscode.commands.executeCommand('setContext', BASE_CTX, false);
                }
                return;
            }
            openTextComparer(context, [vscode.Uri.file(base), other]);
        }),
    );
    // "Split editor / split and move" rebuilds the whole webview — this serializer is how
    // VS Code asks us for the panel again; without it you get a blank page.
    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer('biosTextComparer', {
            async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
                const st = state as { snap?: TcSnap } | undefined;
                // VS Code is still wiring the restored panel while the serializer runs; setting html
                // in the same tick is silently lost on some builds. One tick later it sticks.
                setTimeout(() => attachTextComparer(context, panel, [], st?.snap, true), 0);
            },
        }),
    );
}

// Normally one Text Comparer per window: a second click reveals it instead of opening another.
// Splitting adds a copy, so they are tracked in a set — closing one falls back to the other.
const panels = new Set<vscode.WebviewPanel>();
let livePanel: vscode.WebviewPanel | undefined;

/** The two-pane snapshot the webview reports: a split or moved copy restores itself from it */
interface SideSnap { name?: string; path?: string; enc?: string; bytes?: number; text?: string; }
interface TcSnap { a?: SideSnap | null; b?: SideSnap | null }
let liveSnap: TcSnap | undefined;
/** When the last panel went away: a new one right after that is a split / moved copy */
let lastCloseAt = 0;

/** The snapshot stays in memory: after a split the new webview says ready first, and
 * liveSnap is still there. It is never written to globalState / workspaceState —
 * a few MB of text on every edit would be far too heavy. */
function snapSeed(s?: TcSnap): TcSnap | undefined {
    if (!s) return undefined;
    const ok = (v?: SideSnap | null) => !!v && typeof v.text === 'string';
    if (!ok(s.a) && !ok(s.b)) return undefined;
    return s;
}

/** Where a single file should land. Loading it into the pane that already holds it, or into
 * an empty pane next to it, would just put the same file on both sides — the thing that made
 * one right-click look like a pointless self-compare. */
function placeOne(path: string): { pane: 'A' | 'B' | null; note?: string } {
    const same = (p?: string) => !!p && p.toLowerCase() === path.toLowerCase();
    const a = liveSnap?.a?.path, b = liveSnap?.b?.path;
    if (same(a) || same(b)) {
        return { pane: null, note: `${path.split(/[\\/]/).pop()} is already loaded — pick "Select for Compare" on the other file.` };
    }
    if (!a) return { pane: 'A' };
    if (!b) return { pane: 'B' };
    return { pane: 'B' };   // both sides busy: the new file replaces the right-hand side
}

export async function openTextComparer(context: vscode.ExtensionContext, files: vscode.Uri[] = []) {
    files = uniqueUris(files);
    if (livePanel) {
        livePanel.reveal(livePanel.viewColumn ?? vscode.ViewColumn.Active, false);
        if (files.length) {
            const loaded: LoadedText[] = [];
            for (const u of files.slice(0, 2)) {
                const f = await readTextFile(u.fsPath);
                if (f) loaded.push(f);
            }
            try {
                if (loaded.length >= 2) {
                    livePanel.webview.postMessage({ type: 'loadBoth', a: loaded[0], b: loaded[1] });
                } else if (loaded.length === 1) {
                    const where = placeOne(loaded[0].path);
                    if (where.pane) livePanel.webview.postMessage({ type: 'load', pane: where.pane, ...loaded[0] });
                    else if (where.note) vscode.window.setStatusBarMessage(`$(info) ${where.note}`, 5000);
                }
            } catch { /* disposed */ }
        }
        return;
    }

    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
        'biosTextComparer',
        'Text Comparer',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaDir] },
    );
    attachTextComparer(context, panel, files.slice(0, 2).map(u => u.fsPath), undefined, false);
    if (files.length === 1) {
        vscode.window.setStatusBarMessage(
            `$(info) ${path.basename(files[0].fsPath)} → pane A. Right-click the other file → "BIOS Buddy: Compare Text with Selected (B)", or drop it on the panel.`,
            6000,
        );
    }
}

/**
 * Wire a panel up: set the html, install the message handler, decide what to send
 * back on "ready". Both the command-line path and a split copy (restored through
 * the serializer) share this, so they behave identically.
 *   seed      — snapshot handed in by the serializer (the webview's setState copy)
 *   restoring — called by the serializer: "ready" may replay liveSnap (a split copy)
 */
function attachTextComparer(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    initFiles: string[],
    seed: TcSnap | undefined,
    restoring: boolean,
) {
    const mediaDir = vscode.Uri.joinPath(context.extensionUri, 'media');
    // The serializer hands over a panel VS Code already built, so the options are set again here
    // retainContextWhenHidden is a panel-level option — webview.options has no such field
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaDir] };
    panel.iconPath = vscode.Uri.joinPath(mediaDir, 'bios.png');
    /* A panel that pops up right after another one closed, or while another one is
     * still around, is a split / moved copy of the same view — not a fresh open.
     * Fresh opens start empty; copies get the snapshot pushed back. */
    const isCopy = restoring || panels.size > 0 || (Date.now() - lastCloseAt < 2500);
    const html = readWebviewHtml(mediaDir, 'text-compare.html');
    panel.webview.html = html;
    // A panel restored from the last window sometimes keeps the html it was handed here; the page
    // says "ready" when it really is up, so a missing ready means it stayed blank -> write it again
    const markReady = reloadIfBlank(panel, html);
    panels.add(panel);
    livePanel = panel;
    panel.onDidDispose(() => {
        // liveSnap is deliberately not cleared: on a split the old panel is disposed first
        // and the new one says ready afterwards — clearing would lose exactly that gap. Keeping it costs nothing.
        lastCloseAt = Date.now();
        panels.delete(panel);
        if (livePanel === panel) livePanel = panels.values().next().value as vscode.WebviewPanel | undefined;
    });

    const post = (msg: unknown) => { try { panel.webview.postMessage(msg); } catch { /* disposed */ } };
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;

    /** The snapshot is pushed at most once per webview: needSnap usually lands before ready */
    let snapSent = false;
    const putSnap = (s: TcSnap | undefined) => {
        if (snapSent) return;
        snapSent = true;
        if (s && s.a && s.b) post({ type: 'loadBoth', a: s.a, b: s.b });
        else if (s) {
            const one = (s.a || s.b) as SideSnap;
            post({ type: 'load', pane: s.a ? 'A' : 'B', ...one });
        }
    };

    panel.webview.onDidReceiveMessage(async (m: { type: string; [k: string]: unknown }) => {
        if (!m || typeof m.type !== 'string') return;
        markReady();                   // any message proves the page is up: no reload wanted
        try {
            switch (m.type) {
                case 'ready': {
                    // Opened with files: they win and overwrite whatever the webview restored
                    if (!initFiles.length) {
                        // The webview already restored itself (split / moved to another group) — do not replay
                        if (m.restored === true || snapSent) break;
                        // Split or moved to another group: the new webview is blank, so push the last snapshot back
                        // so A and B never come up empty (a fresh command-line open skips this and stays blank)
                        const s = isCopy ? (snapSeed(liveSnap) ?? snapSeed(seed)) : undefined;
                        if (s) { putSnap(s); break; }
                    }
                    const loaded: LoadedText[] = [];
                    for (const fp of initFiles) {
                        const f = await readTextFile(fp);
                        if (f) loaded.push(f);
                    }
                    if (loaded.length >= 2) post({ type: 'loadBoth', a: loaded[0], b: loaded[1] });
                    else if (loaded.length === 1) post({ type: 'load', pane: 'A', ...loaded[0] });
                    break;
                }

                // A brand new webview that has nothing to restore (a split usually
                // comes up with no state at all): hand back the last two panes.
                case 'needSnap': {
                    if (!isCopy) return;
                    const s = snapSeed(liveSnap) ?? snapSeed(seed);
                    if (s) putSnap(s);
                    break;
                }

                case 'pickFile': {
                    const pane = m.pane === 'B' ? 'B' : 'A';
                    const dialog = !!m.dialog;   // Comes from the import dialog: the text only fills a box, never a pane
                    const uris = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        openLabel: dialog ? 'Import' : 'Compare',
                        defaultUri: defaultDirUri() ?? wsFolder,
                    });
                    if (!uris || !uris.length) return;
                    if (uris.length >= 2) {
                        const a = await readTextFile(uris[0].fsPath);
                        const b = await readTextFile(uris[1].fsPath);
                        if (a && b) post(dialog ? { type: 'loadBoth', dialog: true, a, b } : { type: 'loadBoth', a, b });
                        return;
                    }
                    const one = await readTextFile(uris[0].fsPath);
                    if (one) post(dialog ? { type: 'load', dialog: true, pane, ...one } : { type: 'load', pane, ...one });
                    break;
                }

                // Drop: two at once go to A / B, one goes to the empty pane; a drop inside the import dialog fills only that box
                case 'readUris': {
                    const raw = Array.isArray(m.uris) ? m.uris as string[] : [];
                    const paths = raw.map(toFsPath).filter((p): p is string => !!p).slice(0, 2);
                    const dialog = m.dialog === 'A' || m.dialog === 'B' ? m.dialog : '';
                    if (!paths.length) { post({ type: 'error', message: 'unrecognized drop' }); return; }
                    const loaded: LoadedText[] = [];
                    for (const fp of paths) {
                        const f = await readTextFile(fp);
                        if (f) loaded.push(f);
                    }
                    if (loaded.length >= 2) {
                        post(dialog ? { type: 'loadBoth', dialog: true, a: loaded[0], b: loaded[1] }
                                    : { type: 'loadBoth', a: loaded[0], b: loaded[1] });
                    } else if (loaded.length === 1) {
                        const pane = dialog || (m.pane === 'B' ? 'B' : 'A');
                        post(dialog ? { type: 'load', dialog: true, pane, ...loaded[0] }
                                    : { type: 'load', pane, ...loaded[0] });
                    }
                    break;
                }

                // A dropped File object has no path and no readable content (common from the VS Code Explorer):
                // search the project by name + size and only accept an exact match.
                case 'locateByName': {
                    const names = (Array.isArray(m.names) ? m.names as string[] : [])
                        .map(n => path.basename(String(n || '')))
                        .filter(Boolean).slice(0, 2);
                    const sizes = (Array.isArray(m.sizes) ? m.sizes as unknown[] : []).map(v => Number(v) || 0);
                    const dialog = m.dialog === 'A' || m.dialog === 'B' ? m.dialog : '';
                    const pane = dialog || (m.pane === 'B' ? 'B' : 'A');
                    if (!names.length) { post({ type: 'error', message: 'unrecognized drop' }); return; }

                    const loaded: LoadedText[] = [];
                    for (let i = 0; i < names.length; i++) {
                        const name = names[i];
                        const want = sizes[i] > 0 ? sizes[i] : 0;
                        // cache → workspace → recently used folders (finds files from outside the workspace too)
                        const hit = await locateFileByName(name, want);
                        if (!hit) continue;
                        const f = await readTextFile(hit);
                        if (f) loaded.push(f);
                    }
                    if (!loaded.length) { post({ type: 'error', message: 'unrecognized drop' }); return; }
                    if (loaded.length >= 2) {
                        post(dialog ? { type: 'loadBoth', dialog: true, a: loaded[0], b: loaded[1] }
                                    : { type: 'loadBoth', a: loaded[0], b: loaded[1] });
                    } else {
                        post(dialog ? { type: 'load', dialog: true, pane, ...loaded[0] }
                                    : { type: 'load', pane, ...loaded[0] });
                    }
                    break;
                }

                // The webview reports a two-pane snapshot on every change, used to restore a split or moved view
                case 'snapshot': {
                    const pick = (v: unknown): SideSnap | null => {
                        const o = v as SideSnap | null | undefined;
                        if (!o || typeof o.text !== 'string') return null;
                        return {
                            name: String(o.name ?? ''), path: String(o.path ?? ''),
                            enc: String(o.enc ?? 'UTF-8'), bytes: Number(o.bytes) || 0, text: o.text,
                        };
                    };
                    liveSnap = { a: pick(m.a), b: pick(m.b) };
                    if (!liveSnap.a && !liveSnap.b) liveSnap = undefined;
                    break;
                }

                case 'clipboardRead': {
                    const text = await vscode.env.clipboard.readText();
                    post({
                        type: 'clipboard',
                        pane: m.pane === 'B' ? 'B' : 'A',
                        purpose: typeof m.purpose === 'string' ? m.purpose : '',
                        text,
                    });
                    break;
                }

                case 'copy': {
                    await vscode.env.clipboard.writeText(String(m.text ?? ''));
                    break;
                }

                // Pane Save: write straight back to the original file, reusing the encoding detected on open
                // No path (dropped or pasted): look the file up first (cache → workspace → recent folders),
                // and only then ask the user once; the answer is remembered so later saves stay quiet
                case 'savePane': {
                    const pane = m.pane === 'B' ? 'B' : 'A';
                    let target = String(m.path || '');
                    const name = String(m.name || '');
                    const enc = String(m.enc || 'UTF-8');
                    const buf = encodeText(String(m.text ?? ''), enc);
                    // Do not filter by byte size: the pane may already have been edited, so its size no longer matches
                    if (!target) target = await locateFileByName(name);
                    if (!target) target = await askSourceFile(name);
                    if (!target) { post({ type: 'needPath', pane }); break; }
                    try {
                        await fs.promises.writeFile(target, buf);
                        rememberSrc(target, name || path.basename(target), buf.length);
                        post({ type: 'savedPane', pane, path: target, name: path.basename(target) });
                    } catch (e) {
                        post({ type: 'saveFail', error: (e as Error).message });
                    }
                    break;
                }

                // A drop with content but no path: recover the source by name (+ size) and only fill in the path
                case 'resolvePath': {
                    const pane = m.pane === 'B' ? 'B' : 'A';
                    const name = path.basename(String(m.name || ''));
                    if (!name) return;
                    const hit = await locateFileByName(name, Number(m.bytes) || 0, true);
                    if (hit) post({ type: 'pathOf', pane, name, path: hit, dialog: m.dialog || '' });
                    break;
                }

                // Pane Save As: write a new file and move that pane's path and name over to it
                case 'saveAs': {
                    const pane = m.pane === 'B' ? 'B' : 'A';
                    const suggested = String(m.suggested || 'copy.txt');
                    const baseDir = defaultDirUri() ?? wsFolder;
                    const target = await vscode.window.showSaveDialog({
                        saveLabel: 'Save',
                        filters: { 'Text': ['txt', 'def', 'dsc', 'log', 'md', 'ini', 'json'], 'All files': ['*'] },
                        defaultUri: baseDir ? vscode.Uri.joinPath(baseDir, suggested) : undefined,
                    });
                    if (!target) return;
                    try {
                        const buf = encodeText(String(m.text ?? ''), String(m.enc || 'UTF-8'));
                        await fs.promises.writeFile(target.fsPath, buf);
                        rememberSrc(target.fsPath, path.basename(target.fsPath), buf.length);
                        post({ type: 'savedPane', pane, path: target.fsPath, name: path.basename(target.fsPath) });
                    } catch (e) {
                        post({ type: 'saveFail', error: (e as Error).message });
                    }
                    break;
                }

                case 'save': {
                    const suggested = String(m.suggested || 'compare.diff');
                    const baseDir = defaultDirUri() ?? wsFolder;
                    const target = await vscode.window.showSaveDialog({
                        saveLabel: 'Save diff',
                        filters: { 'Diff': ['diff', 'txt'], 'All files': ['*'] },
                        defaultUri: baseDir ? vscode.Uri.joinPath(baseDir, suggested) : undefined,
                    });
                    if (!target) return;
                    try {
                        await fs.promises.writeFile(target.fsPath, String(m.text ?? ''), 'utf8');
                        post({ type: 'saved', path: target.fsPath });
                    } catch (e) {
                        post({ type: 'saveFail', error: (e as Error).message });
                    }
                    break;
                }
            }
        } catch (e) {
            post({ type: 'error', message: (e as Error).message });
        }
    });
}
