"use strict";
// ---------------------------------------------------------------------------
// Configuration model for the build rows (the old Build Only row)
//
// The build script is no longer one global setting — each row is one build:
// · the preset row (id = build.only) is the old Build Only: script from buildBat,
//   arguments from buildArgs, name from buildOnlyLabel — existing settings keep working;
// · "+" on the panel adds another row, each with its own script (build.custom.N);
// · to run one script twice with different arguments, add two rows and fill each in.
//
// The version actions (Formal / Test) only edit BiosVersion.def and never run anything here.
//
// This file has no vscode import on purpose: pure functions, easy to unit test.
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRESET_BUILD_ID = void 0;
exports.scriptStem = scriptStem;
exports.displayLabel = displayLabel;
exports.defaultBuilds = defaultBuilds;
exports.normalizeBuilds = normalizeBuilds;
exports.findBuild = findBuild;
exports.visibleBuilds = visibleBuilds;
exports.hiddenBuilds = hiddenBuilds;
exports.removeBuild = removeBuild;
exports.restoreBuild = restoreBuild;
exports.makeBuildId = makeBuildId;
/**
 * Script file name without its extension — the default name of a build row.
 * Plain string work, no path module: both Windows and POSIX separators are fine.
 */
function scriptStem(script) {
    const base = String(script ?? '').split(/[\\/]/).pop() ?? '';
    return base.replace(/\.(bat|cmd|ps1)$/i, '').trim() || base.trim();
}
/**
 * The name actually shown in the panel. Unless it was renamed by hand it always
 * follows the script file name, so swapping the .bat renames the row immediately.
 */
function displayLabel(t, fallback = 'Build') {
    if (t.renamed && typeof t.label === 'string' && t.label.trim())
        return t.label.trim();
    return scriptStem(t.script) || (t.label ?? '').trim() || fallback;
}
exports.PRESET_BUILD_ID = 'build.only';
/**
 * The preset row. Its three fields come from buildBat / buildArgs / buildOnlyLabel,
 * so the settings only store its id (and whether it is hidden) — never a copy.
 */
function defaultBuilds(label, script, args) {
    return [{ id: exports.PRESET_BUILD_ID, label, script, args }];
}
/**
 * Turn builds from settings.json into a clean list: drop custom rows without a
 * script, de-duplicate ids, and always take the preset row's label/script/args
 * from the preset itself.
 */
function normalizeBuilds(raw, preset) {
    const out = [];
    if (Array.isArray(raw)) {
        const seen = new Set();
        raw.forEach((item, i) => {
            if (!item || typeof item !== 'object')
                return;
            const o = item;
            let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : 'build.custom.' + (i + 1);
            while (seen.has(id))
                id += '_' + i;
            seen.add(id);
            if (id === exports.PRESET_BUILD_ID) {
                out.push({ ...preset, hidden: o.hidden === true ? true : undefined });
                return;
            }
            const script = typeof o.script === 'string' ? o.script.trim() : '';
            if (!script)
                return; // A build without a script cannot run, so it does not get a row
            // The name follows the script; only an explicit "renamed" flag keeps a stored name
            const renamed = o.renamed === true;
            const stored = typeof o.label === 'string' ? o.label.trim() : '';
            out.push({
                id,
                label: renamed ? (stored || scriptStem(script)) : scriptStem(script),
                ...(renamed ? { renamed: true } : {}),
                script,
                args: typeof o.args === 'string' ? o.args : undefined,
                custom: true,
                hidden: undefined,
            });
        });
    }
    if (!out.some(b => b.id === exports.PRESET_BUILD_ID))
        out.unshift({ ...preset });
    return out;
}
function findBuild(list, id) {
    return list.find(b => b.id === id);
}
/** Rows that actually show up in the panel */
function visibleBuilds(list) {
    return list.filter(b => !b.hidden);
}
/** Preset rows that were removed (hidden) */
function hiddenBuilds(list) {
    return list.filter(b => b.id === exports.PRESET_BUILD_ID && b.hidden === true);
}
/** Remove a row: custom rows are deleted, presets are only hidden behind a grey placeholder */
function removeBuild(list, id) {
    const b = findBuild(list, id);
    if (!b)
        return list;
    if (b.custom)
        return list.filter(x => x.id !== id);
    return list.map(x => (x.id === id ? { ...x, hidden: true } : x));
}
/** Bring a removed preset row back */
function restoreBuild(list, id) {
    return list.map(x => (x.id === id ? { ...x, hidden: undefined } : x));
}
function makeBuildId(list) {
    let n = 1;
    while (findBuild(list, `build.custom.${n}`))
        n++;
    return `build.custom.${n}`;
}
//# sourceMappingURL=buildTargets.js.map