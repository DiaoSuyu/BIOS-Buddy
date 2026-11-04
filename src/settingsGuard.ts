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

import * as fs from 'fs';
import * as path from 'path';

export const OWN_PREFIX = 'biosBuddy.';

/** Read a JSON file; missing or broken counts as empty (unavoidable once settings.json may contain comments) */
export function readJsonFile(p: string): Record<string, unknown> {
    try {
        if (!fs.existsSync(p)) return {};
        const txt = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
        if (!txt.trim()) return {};
        const obj = JSON.parse(txt);
        return obj && typeof obj === 'object' ? obj as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

export function writeJsonFile(p: string, obj: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 4) + '\n', 'utf-8');
}

/** Keep only this extension's own keys */
export function pickOwned(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
        if (k.startsWith(OWN_PREFIX)) out[k] = obj[k];
    }
    return out;
}

export function hasOwned(obj: Record<string, unknown>): boolean {
    return Object.keys(obj).some(k => k.startsWith(OWN_PREFIX));
}

/** Copy a whole tree into dest (cleared first) and return the relative paths copied */
export function snapshotTree(src: string, dest: string): string[] {
    const copied: string[] = [];
    const walk = (rel: string): void => {
        const abs = rel ? path.join(src, rel) : src;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const r = rel ? path.join(rel, e.name) : e.name;
            if (e.isDirectory()) {
                walk(r);
            } else if (e.isFile()) {
                try {
                    const to = path.join(dest, r);
                    fs.mkdirSync(path.dirname(to), { recursive: true });
                    fs.copyFileSync(path.join(src, r), to);
                    copied.push(r);
                } catch { /* One failing file must not stop the rest */ }
            }
        }
    };
    try {
        fs.rmSync(dest, { recursive: true, force: true });
    } catch { /* ignore */ }
    walk('');
    return copied;
}

/** Restore files present in the snapshot but missing from the target, returning what was restored */
export function restoreMissingFiles(snap: string, dest: string): string[] {
    const restored: string[] = [];
    if (!fs.existsSync(snap)) return restored;
    const walk = (rel: string): void => {
        const abs = rel ? path.join(snap, rel) : snap;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(abs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const r = rel ? path.join(rel, e.name) : e.name;
            if (e.isDirectory()) {
                walk(r);
                continue;
            }
            if (!e.isFile()) continue;
            const target = path.join(dest, r);
            if (fs.existsSync(target)) continue;
            try {
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(path.join(snap, r), target);
                restored.push(r);
            } catch { /* ignore */ }
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
export function restoreOwnedSettings(settingsPath: string, mirrorPath: string): string[] {
    if (!settingsPath || !mirrorPath || !fs.existsSync(mirrorPath)) return [];
    const backup = readJsonFile(mirrorPath);
    if (!Object.keys(backup).length) return [];

    const current = readJsonFile(settingsPath);
    if (hasOwned(current)) return [];

    for (const k of Object.keys(backup)) current[k] = backup[k];
    try {
        writeJsonFile(settingsPath, current);
    } catch {
        return [];
    }
    return Object.keys(backup);
}
