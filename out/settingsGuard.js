"use strict";
// ---------------------------------------------------------------------------
// Settings guard: do not let a Clean bury the configuration with it
//
// Background: `svn cleanup --remove-unversioned` deletes every unversioned file in the working copy,
// and `.vscode/settings.json` is usually a local, uncommitted file — so one Clean wipes
// the def path, build script and itemOrder this extension recorded, and everything must be set up again.
//
// Two things happen here, both inside the extension process, with no extra terminal commands:
// 1. Mirror: every settings write also saves the `biosBuddy.*` keys to the extension's global storage;
// when none of them are left in the workspace settings, restore them from the mirror at once.
// 2. Snapshot: copy the whole `.vscode` folder before a Clean, then poll afterwards and
// put back whatever went missing (launch.json, tasks.json, *.bcat …).
//
// Only missing files are restored — never overwrite a surviving one, never touch another extension's keys.
// ---------------------------------------------------------------------------
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
exports.OWN_PREFIX = void 0;
exports.readJsonFile = readJsonFile;
exports.writeJsonFile = writeJsonFile;
exports.pickOwned = pickOwned;
exports.hasOwned = hasOwned;
exports.snapshotTree = snapshotTree;
exports.restoreMissingFiles = restoreMissingFiles;
exports.restoreOwnedSettings = restoreOwnedSettings;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.OWN_PREFIX = 'biosBuddy.';
/** Read a JSON file; missing or broken counts as empty (unavoidable once settings.json may contain comments) */
function readJsonFile(p) {
    try {
        if (!fs.existsSync(p))
            return {};
        const txt = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
        if (!txt.trim())
            return {};
        const obj = JSON.parse(txt);
        return obj && typeof obj === 'object' ? obj : {};
    }
    catch {
        return {};
    }
}
function writeJsonFile(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 4) + '\n', 'utf-8');
}
/** Keep only this extension's own keys */
function pickOwned(obj) {
    const out = {};
    for (const k of Object.keys(obj)) {
        if (k.startsWith(exports.OWN_PREFIX))
            out[k] = obj[k];
    }
    return out;
}
function hasOwned(obj) {
    return Object.keys(obj).some(k => k.startsWith(exports.OWN_PREFIX));
}
/** Copy a whole tree into dest (cleared first) and return the relative paths copied */
function snapshotTree(src, dest) {
    const copied = [];
    const walk = (rel) => {
        const abs = rel ? path.join(src, rel) : src;
        let entries;
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const r = rel ? path.join(rel, e.name) : e.name;
            if (e.isDirectory()) {
                walk(r);
            }
            else if (e.isFile()) {
                try {
                    const to = path.join(dest, r);
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    fs.copyFileSync(path.join(src, r), to);
                    copied.push(r);
                }
                catch { /* One failing file must not stop the rest */ }
            }
        }
    };
    try {
        fs.rmSync(dest, { recursive: true, force: true });
    }
    catch { /* ignore */ }
    walk('');
    return copied;
}
/** Restore files present in the snapshot but missing from the target, returning what was restored */
function restoreMissingFiles(snap, dest) {
    const restored = [];
    if (!fs.existsSync(snap))
        return restored;
    const walk = (rel) => {
        const abs = rel ? path.join(snap, rel) : snap;
        let entries;
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const r = rel ? path.join(rel, e.name) : e.name;
            if (e.isDirectory()) {
                walk(r);
                continue;
            }
            if (!e.isFile())
                continue;
            const target = path.join(dest, r);
            if (fs.existsSync(target))
                continue;
            try {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(path.join(snap, r), target);
                restored.push(r);
            }
            catch { /* ignore */ }
        }
    };
    walk('');
    return restored;
}
/**
 * Put the mirrored keys back when the whole workspace settings block was deleted.
 * As long as one of this extension's keys survives, the file is still being
 * managed, so we keep out.
 */
function restoreOwnedSettings(settingsPath, mirrorPath) {
    if (!settingsPath || !mirrorPath || !fs.existsSync(mirrorPath))
        return [];
    const backup = readJsonFile(mirrorPath);
    if (!Object.keys(backup).length)
        return [];
    const current = readJsonFile(settingsPath);
    if (hasOwned(current))
        return [];
    for (const k of Object.keys(backup))
        current[k] = backup[k];
    try {
        writeJsonFile(settingsPath, current);
    }
    catch {
        return [];
    }
    return Object.keys(backup);
}
//# sourceMappingURL=settingsGuard.js.map