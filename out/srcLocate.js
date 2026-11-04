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
exports.initSourceIndex = initSourceIndex;
exports.recentDirs = recentDirs;
exports.rememberDirOf = rememberDirOf;
exports.rememberSrc = rememberSrc;
exports.cachedSource = cachedSource;
exports.scanRecentDirs = scanRecentDirs;
exports.defaultDirUri = defaultDirUri;
exports.askSourceFile = askSourceFile;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ---------------------------------------------------------------------------
// Source-file index shared by the Text Comparer and the Binary Editor
//
// Files dragged in from the system explorer arrive as a File object with no real path
// (File.path was removed in Electron 32). Saving back therefore needs the path first:
// 1) Remember every file the user picked or that was read/written successfully — cache the path by name + size,
// so the next drop of the same file hits immediately and never asks again;
// 2) Remember recently used folders — look for out-of-workspace files there by name + size first,
// which almost always hits when the same project keeps dropping the same files;
// 3) only then ask once with a "locate the source file" dialog, and cache the answer.
// The cache lives in globalState, so it survives windows and restarts.
// ---------------------------------------------------------------------------
const KEY_MAP = 'biosBuddy.srcIndex';
const KEY_DIRS = 'biosBuddy.recentDirs';
const MAX_ENTRIES = 120;
const MAX_DIRS = 10;
const MAX_SUBDIRS = 160; // How many subfolders to look at per folder — enough to help, few enough not to stall
let store;
/** Call once during activation; every memory afterwards goes into this Memento */
function initSourceIndex(memento) {
    store = memento;
}
function keyOf(name, size) {
    const base = path.basename(String(name || '').trim()).toLowerCase();
    return `${base}|${Number(size) || 0}`;
}
function readMap() {
    try {
        const v = store?.get(KEY_MAP);
        return v && typeof v === 'object' ? v : {};
    }
    catch {
        return {};
    }
}
function writeMap(m) {
    try {
        void store?.update(KEY_MAP, m);
    }
    catch { /* If it cannot be stored, so be it — the feature still works */ }
}
function statAsync(fp) {
    return new Promise(res => fs.stat(fp, (e, st) => res(e ? null : st)));
}
function existsFile(fp) {
    try {
        return fs.statSync(fp).isFile();
    }
    catch {
        return false;
    }
}
/** Recently used (read or written) folders, most recent first */
function recentDirs() {
    try {
        const v = store?.get(KEY_DIRS);
        return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
    }
    catch {
        return [];
    }
}
/** Record a folder: called for every successful read or write, so out-of-workspace folders pile up too */
function rememberDirOf(filePath) {
    if (!filePath)
        return;
    let dir = '';
    try {
        dir = path.dirname(filePath);
    }
    catch {
        return;
    }
    if (!dir || dir === '.' || dir === path.sep)
        return;
    const list = recentDirs().filter(d => d.toLowerCase() !== dir.toLowerCase());
    list.unshift(dir);
    try {
        void store?.update(KEY_DIRS, list.slice(0, MAX_DIRS));
    }
    catch { /* Ignore */ }
}
/** Remember "file name + size → real path" */
function rememberSrc(filePath, name, size) {
    if (!filePath)
        return;
    let st = null;
    try {
        st = fs.statSync(filePath);
    }
    catch {
        st = null;
    }
    if (!st || !st.isFile())
        return;
    const base = path.basename(name || filePath);
    const key = keyOf(base, st.size);
    const map = readMap();
    map[key] = { path: filePath, name: base, size: st.size, at: Date.now() };
    // Over the limit: drop the oldest entries first
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
            .slice(0, keys.length - MAX_ENTRIES)
            .forEach(k => { delete map[k]; });
    }
    writeMap(map);
    rememberDirOf(filePath);
    void size;
}
/** Look up the cache: the path must still exist and the size still match, otherwise
 * the entry is void. Without a size, any record with that file name matches — the
 * panel content may already have changed, so the size proves nothing. */
function cachedSource(name, size) {
    const base = path.basename(String(name || '').trim());
    if (!base)
        return '';
    const want = Number(size) || 0;
    const map = readMap();
    const alive = (hit) => {
        if (!hit || !hit.path)
            return '';
        if (!existsFile(hit.path))
            return '';
        if (want && fs.statSync(hit.path).size !== want)
            return '';
        return hit.path;
    };
    if (want) {
        const key = keyOf(base, want);
        const hit = alive(map[key]);
        if (hit)
            return hit;
        if (map[key] && !hit) {
            delete map[key];
            writeMap(map);
        }
    }
    // Name-only fallback: the most recently confirmed match wins
    let best;
    for (const k of Object.keys(map)) {
        const e = map[k];
        if (!e || path.basename(e.path).toLowerCase() !== base.toLowerCase())
            continue;
        if (!best || (e.at || 0) > (best.at || 0))
            best = e;
    }
    return alive(best);
}
/**
 * Look for "file name + size" in the recently used folders.
 * The folder itself first (fast), then one level of subfolders (capped). Every
 * hit is returned as a candidate.
 */
async function scanRecentDirs(name, size) {
    const base = path.basename(String(name || '').trim());
    if (!base)
        return [];
    const want = Number(size) || 0;
    const dirs = recentDirs();
    if (!dirs.length)
        return [];
    // pass 1: the folder itself — a dropped file often sits right there
    const hits = [];
    for (const dir of dirs) {
        const fp = path.join(dir, base);
        const st = await statAsync(fp);
        if (st && st.isFile() && (!want || st.size === want))
            hits.push(fp);
    }
    if (hits.length)
        return hits;
    // pass 2: one level down — finds it even when the project splits into module folders
    for (const dir of dirs.slice(0, 6)) {
        let subs = [];
        try {
            subs = (await fs.promises.readdir(dir, { withFileTypes: true }))
                .filter(d => d.isDirectory()).slice(0, MAX_SUBDIRS).map(d => d.name);
        }
        catch {
            continue;
        }
        for (const sub of subs) {
            const fp = path.join(dir, sub, base);
            const st = await statAsync(fp);
            if (st && st.isFile() && (!want || st.size === want) && !hits.includes(fp))
                hits.push(fp);
        }
        if (hits.length)
            return hits;
    }
    return hits;
}
/** Default location for open/save dialogs: the last used folder, then the workspace */
function defaultDirUri() {
    const dir = recentDirs()[0];
    if (dir) {
        try {
            return vscode.Uri.file(dir);
        }
        catch { /* Fall back to the workspace */ }
    }
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}
/**
 * Last resort: let the user point at where this file really lives.
 * Asked once — the answer is cached, so saving the same drop later just works.
 */
async function askSourceFile(name, size) {
    const base = path.basename(String(name || '').trim());
    if (!base)
        return '';
    const want = Number(size) || 0;
    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use as source',
        title: `Locate the source file "${base}" — Save will write back to it`,
        defaultUri: defaultDirUri(),
    });
    if (!picked || !picked.length)
        return '';
    const fp = picked[0].fsPath;
    const st = await statAsync(fp);
    if (!st || !st.isFile())
        return '';
    if (want && st.size !== want) {
        const go = await vscode.window.showWarningMessage(`"${path.basename(fp)}" is ${st.size.toLocaleString()} bytes, but this pane holds `
            + `${want.toLocaleString()} bytes. Saving will overwrite it with the pane content.`, { modal: true, detail: fp }, 'Use it anyway');
        if (go !== 'Use it anyway')
            return '';
    }
    rememberSrc(fp, base, st.size);
    return fp;
}
//# sourceMappingURL=srcLocate.js.map