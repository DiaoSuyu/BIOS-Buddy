"use strict";
// ---------------------------------------------------------------------------
// Configuration model for SVN / Git actions
//
// Each row under SVN Operation / Git Operation in the sidebar is one action:
// · presets (SVN Update / SVN Clean & Revert / Git Update / Git Reset & Clean)
//   carry a builtin flow — "diff → preview → delete → verify" is not one command;
// · user-added actions just run their steps in order;
// · a preset can be edited too: editing drops builtin and leaves a plain step list ("restore defaults" brings it back).
//
// This file does not depend on vscode: plain functions, easy to unit-test directly.
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILTIN_OF = exports.DEFAULT_STEPS = exports.ROOT_TOKEN = void 0;
exports.presetIds = presetIds;
exports.defaultActions = defaultActions;
exports.splitSteps = splitSteps;
exports.joinSteps = joinSteps;
exports.expandStep = expandStep;
exports.normalizeActions = normalizeActions;
exports.findAction = findAction;
exports.isModified = isModified;
exports.withSteps = withSteps;
exports.makeCustomId = makeCustomId;
exports.visibleActions = visibleActions;
exports.hiddenActions = hiddenActions;
exports.removeAction = removeAction;
exports.restoreAction = restoreAction;
exports.insertPreset = insertPreset;
exports.ROOT_TOKEN = '{root}';
/** Default commands of a preset — a preview for humans only; the builtin flow is what runs */
exports.DEFAULT_STEPS = {
    svnUpdate: ['svn update'],
    svnCleanRevert: [
        'svn cleanup --include-externals {root}',
        'svn revert -R {root}',
        'svn cleanup --remove-unversioned --include-externals {root}',
        'svn cleanup --remove-ignored --include-externals {root}',
        'svn status --no-ignore {root}',
    ],
    gitUpdate: [
        'git fetch --all --prune',
        'git pull --ff-only',
    ],
    gitResetClean: [
        'git reset --hard',
        'git clean -ffdx',
        'git status --porcelain --ignored',
    ],
};
exports.BUILTIN_OF = {
    svnUpdate: 'svnUpdate',
    svnCleanRevert: 'svnClean',
    gitUpdate: 'gitUpdate',
    gitResetClean: 'gitResetClean',
};
/** Fixed order and ids of the preset actions */
function presetIds(tool) {
    return tool === 'svn' ? ['svnUpdate', 'svnCleanRevert'] : ['gitUpdate', 'gitResetClean'];
}
function defaultActions(tool, labels) {
    const [upd, cln] = presetIds(tool);
    return [
        {
            id: upd,
            label: labels.update,
            steps: [...exports.DEFAULT_STEPS[upd]],
            builtin: exports.BUILTIN_OF[upd],
        },
        {
            id: cln,
            label: labels.clean,
            steps: [...exports.DEFAULT_STEPS[cln]],
            builtin: exports.BUILTIN_OF[cln],
        },
    ];
}
/** Input box text → command array: one per line, && chains allowed */
function splitSteps(text) {
    return String(text ?? '')
        .split(/\r?\n|&&/)
        .map(s => s.trim())
        .filter(Boolean);
}
/** Command array → the text shown in the input box */
function joinSteps(steps) {
    return (steps || []).join(' && ');
}
/** Expand {root} to the real path, quoting it when it has spaces — otherwise the shell splits it in two */
function expandStep(step, root) {
    if (!step)
        return '';
    return step.replace(/\{root\}/g, () => (/[ \t]/.test(root) ? '"' + root + '"' : root));
}
function toSteps(v) {
    if (Array.isArray(v))
        return v.map(x => typeof x === 'string' ? x.trim() : '').filter(Boolean);
    if (typeof v === 'string')
        return splitSteps(v);
    return [];
}
/**
 * Turn what settings.json holds into a valid action list: drop empty entries,
 * fill in id and label, de-duplicate ids, and keep the order.
 */
function normalizeActions(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seen = new Set();
    raw.forEach((item, i) => {
        if (!item || typeof item !== 'object')
            return;
        const o = item;
        const steps = toSteps(o.steps);
        const builtin = typeof o.builtin === 'string' && o.builtin.trim() ? o.builtin.trim() : undefined;
        if (!steps.length && !builtin)
            return; // Neither commands nor a builtin flow: drop it
        let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : 'custom.' + (i + 1);
        while (seen.has(id))
            id += '_' + i;
        seen.add(id);
        const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : id;
        out.push({
            id,
            label,
            steps: steps.length ? steps : [...(exports.DEFAULT_STEPS[builtin || ''] || [])],
            builtin,
            custom: o.custom === true,
            hidden: o.hidden === true ? true : undefined,
        });
    });
    return out;
}
function findAction(list, id) {
    return list.find(a => a.id === id);
}
/**
 * Whether this entry differs from its default (commands / label / builtin flow).
 * Only presets can be "restored"; a custom action always counts as edited and is
 * removed instead.
 */
function isModified(action, defaults) {
    if (action.custom)
        return false;
    const d = findAction(defaults, action.id);
    if (!d)
        return true;
    return joinSteps(action.steps) !== joinSteps(d.steps)
        || action.label !== d.label
        || (action.builtin || '') !== (d.builtin || '');
}
/** Used when the commands change: matching the defaults puts the builtin flow back, otherwise it runs as plain commands */
function withSteps(action, steps, defaults) {
    const d = findAction(defaults, action.id);
    const same = d && joinSteps(steps) === joinSteps(d.steps);
    return {
        ...action,
        steps: [...steps],
        builtin: same ? d.builtin : undefined,
    };
}
function makeCustomId(tool, list) {
    let n = 1;
    while (findAction(list, `${tool}.custom.${n}`))
        n++;
    return `${tool}.custom.${n}`;
}
// ---------------------------------------------------------------------------
// Remove / put back
//
// Two different paths — do not mix them up:
// · a custom action belongs to the user, so deleting removes it outright;
// · a preset ships with the extension, so deleting only sets hidden — it disappears from the panel
//   and a "removed" row stays at the end of the group; one click brings it back in place.
// ---------------------------------------------------------------------------
/** The rows actually rendered in the panel */
function visibleActions(list) {
    return list.filter(a => !a.hidden);
}
/** Presets that were removed (hidden), keeping their original order */
function hiddenActions(list) {
    return list.filter(a => a.hidden === true);
}
/** Remove a row: custom actions for real, presets hidden only */
function removeAction(list, id) {
    const a = findAction(list, id);
    if (!a)
        return list;
    if (a.custom)
        return list.filter(x => x.id !== id);
    return list.map(x => (x.id === id ? { ...x, hidden: true } : x));
}
/** Put a removed preset back */
function restoreAction(list, id) {
    return list.map(x => (x.id === id ? { ...x, hidden: undefined } : x));
}
/** Gone entirely from settings (an older version's file) → re-insert it in preset order */
function insertPreset(list, preset, tool) {
    if (findAction(list, preset.id))
        return list;
    const order = presetIds(tool);
    const mine = order.indexOf(preset.id);
    const at = list.findIndex(a => order.indexOf(a.id) > mine && mine >= 0);
    const out = [...list];
    out.splice(at < 0 ? out.length : at, 0, { ...preset });
    return out;
}
//# sourceMappingURL=vcsActions.js.map