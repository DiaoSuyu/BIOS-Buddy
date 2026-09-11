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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const DEFAULT_INFO_FIELDS = [
    { label: 'BIOS_VERSION', key: 'BIOS_VERSION' },
    { label: 'BIOS_VERSION_MAJOR', key: 'BIOS_VERSION_MAJOR' },
    { label: 'BIOS_VERSION_MINOR', key: 'BIOS_VERSION_MINOR' },
    { label: 'ACPI_OEM_REVISION', key: 'ACPI_OEM_REVISION' },
    { label: 'LENOVO_COMMON_BLD_ID', key: 'LENOVO_COMMON_BLD_ID' },
    { label: 'LENOVO_COMMON_BLD_DATE', key: 'LENOVO_COMMON_BLD_DATE' },
];
// Convert old-style entries (virtual @version / @majorMinor, custom labels)
// into raw-token entries, and drop invalid rows.
function normalizeInfoFields(raw) {
    if (!Array.isArray(raw))
        return null;
    const out = [];
    const seen = new Set();
    const push = (key) => {
        if (!key || seen.has(key))
            return;
        seen.add(key);
        out.push({ label: key, key });
    };
    for (const x of raw) {
        const key = typeof x?.key === 'string' ? x.key : '';
        if (key === '@version') {
            push('BIOS_VERSION');
        }
        else if (key === '@majorMinor') {
            push('BIOS_VERSION_MAJOR');
            push('BIOS_VERSION_MINOR');
        }
        else {
            push(key);
        }
    }
    return out;
}
// Direct .vscode/settings.json access. Some hosts cache extension manifests
// and reject workspace writes of "unregistered" settings even when the current
// package.json declares them; reading/writing the file bypasses that entirely.
function workspaceSettingsPath() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, '.vscode', 'settings.json') : undefined;
}
function readWorkspaceSettings() {
    const p = workspaceSettingsPath();
    if (!p || !fs.existsSync(p))
        return {};
    try {
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
function writeWorkspaceSetting(key, value) {
    const p = workspaceSettingsPath();
    if (!p)
        return false;
    try {
        let settings = {};
        if (fs.existsSync(p)) {
            const txt = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
            if (txt.trim())
                settings = JSON.parse(txt);
        }
        else {
            fs.mkdirSync(path.dirname(p), { recursive: true });
        }
        settings[key] = value;
        fs.writeFileSync(p, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
        return true;
    }
    catch (e) {
        vscode.window.showErrorMessage(`BIOS Build Assistant: cannot write ${p}: ${e.message}`);
        return false;
    }
}
function readWorkspaceValue(cfg, leaf) {
    // File always wins: it is what the user sees and it survives host caches.
    const fromFile = readWorkspaceSettings()[`biosBuildAssistant.${leaf}`];
    if (fromFile !== undefined)
        return fromFile;
    const ins = cfg.inspect(leaf);
    return ins?.workspaceFolderValue ?? ins?.workspaceValue ?? ins?.globalValue;
}
// An explicitly stored empty list is valid (all fields hidden); only fall back
// to defaults when the setting was never configured at all.
function getInfoFields(cfg) {
    const configured = readWorkspaceValue(cfg, 'infoFields');
    if (configured !== undefined) {
        return normalizeInfoFields(configured) ?? DEFAULT_INFO_FIELDS;
    }
    return DEFAULT_INFO_FIELDS;
}
const DEFAULT_FORMAL_BUILD_FIELDS = [
    'BIOS_VERSION_MAJOR',
    'BIOS_VERSION_MINOR',
    'ACPI_OEM_REVISION',
    'BIOS_VERSION',
    'LENOVO_COMMON_BLD_DATE',
    'BIOS_BUILD_DATE',
    'LENOVO_COMMON_BLD_ID',
    'SINGLE_CAPSULE_DEFAULT_FW_VER_PACKAGE',
];
const DEFAULT_TEST_BUILD_FIELDS = [
    'LENOVO_COMMON_BLD_ID',
    'LENOVO_COMMON_BLD_DATE',
    'BIOS_BUILD_DATE',
];
function getConfiguredChangeFields(cfg, key, fallback) {
    const configured = readWorkspaceValue(cfg, key);
    const entries = Array.isArray(configured) ? configured : [];
    const cleaned = entries
        .map(v => typeof v === 'string' ? v.trim() : '')
        .filter(Boolean);
    return new Set(cleaned.length ? cleaned : fallback);
}
function getAvailableDefKeys(fields) {
    return [...new Set(fields.map(f => f.key).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
async function pickFieldsForBuild(cfg, mode, fields, title, fallback, forcePrompt = false) {
    const allKeys = getAvailableDefKeys(fields);
    const saved = readWorkspaceValue(cfg, mode);
    const existing = Array.isArray(saved)
        ? saved.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean)
        : [];
    // If a saved selection exists, reuse it unless the caller explicitly wants to
    // reconfigure. Otherwise we must show the chooser so the user can pick fields
    // for the current build; fallback values are only default checked items.
    if (!forcePrompt && existing.length > 0) {
        return new Set(existing);
    }
    const initial = existing.length > 0 ? existing : fallback;
    const items = allKeys.map(key => ({
        label: key,
        picked: initial.includes(key),
    }));
    const selected = await vscode.window.showQuickPick(items, {
        title,
        canPickMany: true,
        placeHolder: 'Select fields to update in this build. Leave all unchecked to keep version increment only.',
    });
    if (!selected) {
        return new Set(initial);
    }
    const chosen = new Set(selected.map(item => item.label));
    writeWorkspaceSetting(`biosBuildAssistant.${mode}`, Array.from(chosen));
    return chosen;
}
const DEFAULT_ITEM_ORDER = {
    paths: ['defFile', 'buildBat'],
    actions: ['incBuild', 'testBuild', 'buildOnly'],
    svnops: ['svnUpdate', 'svnCleanRevert'],
};
function getItemOrder(cfg) {
    const v = (readWorkspaceValue(cfg, 'itemOrder') ?? {});
    return {
        paths: Array.isArray(v.paths) && v.paths.length ? v.paths : DEFAULT_ITEM_ORDER.paths,
        actions: Array.isArray(v.actions) && v.actions.length ? v.actions : DEFAULT_ITEM_ORDER.actions,
        svnops: Array.isArray(v.svnops) && v.svnops.length ? v.svnops : DEFAULT_ITEM_ORDER.svnops,
    };
}
function getActionLabel(cfg, key) {
    const overrides = {
        formalBuild: 'formalBuildLabel',
        testBuild: 'testBuildLabel',
        buildOnly: 'buildOnlyLabel',
        svnUpdate: 'svnUpdateLabel',
        svnCleanRevert: 'svnCleanRevertLabel',
    };
    const defaultLabels = {
        formalBuild: 'Formal BIOS Build',
        testBuild: 'Test BIOS Build',
        buildOnly: 'Build Only',
        svnUpdate: 'SVN Update',
        svnCleanRevert: 'SVN Clean & Revert',
    };
    const value = readWorkspaceValue(cfg, overrides[key]);
    return typeof value === 'string' && value.trim() ? value.trim() : defaultLabels[key];
}
// Pick a codicon for a def Config token so every child row carries an icon;
// this keeps the icon/label columns aligned across all groups.
function fieldIcon(key) {
    if (/DATE|TIME/i.test(key))
        return 'calendar';
    if (/MAJOR|MINOR|REVISION|VERSION\b|SIGN/i.test(key))
        return 'symbol-number';
    if (/_ID$|_ID_/i.test(key) || key === 'BIOS_VERSION')
        return 'tag';
    return 'symbol-field';
}
// Stable sort: items keep their relative order unless `order` moves them.
function sortByDnd(items, order, keyOf) {
    const rank = (x) => {
        const k = keyOf(x);
        const i = k ? order.indexOf(k) : -1;
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...items].sort((a, b) => rank(a) - rank(b));
}
// ---------------------------------------------------------------------------
// Panel data provider
// ---------------------------------------------------------------------------
const ITEM_DND_MIME = 'application/vnd.code.tree.biosbuildassistant-items';
class BiosPanelProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.dragMimeTypes = [ITEM_DND_MIME];
        this.dropMimeTypes = [ITEM_DND_MIME];
    }
    refresh() { this._onDidChangeTreeData.fire(); }
    dndOf(e) {
        if (e.kind === 'action' && e.dndGroup)
            return { id: e.id, group: e.dndGroup };
        if (e.kind === 'info' && e.dndId && e.dndGroup)
            return { id: e.dndId, group: e.dndGroup };
        return undefined;
    }
    handleDrag(source, dataTransfer) {
        // Only items from one shared parent group can be dragged together.
        let group;
        const ids = [];
        for (const e of source) {
            const d = this.dndOf(e);
            if (!d)
                continue;
            if (group === undefined)
                group = d.group;
            if (d.group !== group)
                continue;
            ids.push(d.id);
        }
        if (group !== undefined && ids.length > 0) {
            dataTransfer.set(ITEM_DND_MIME, new vscode.DataTransferItem({ group, ids }));
        }
    }
    async handleDrop(target, dataTransfer) {
        const payload = dataTransfer.get(ITEM_DND_MIME)?.value;
        if (!payload || !Array.isArray(payload.ids) || payload.ids.length === 0)
            return;
        // Resolve the drop target group; dropping onto a group node appends.
        let targetGroup;
        let beforeId;
        if (target) {
            if (target.kind === 'group') {
                targetGroup = target.id;
            }
            else {
                const d = this.dndOf(target);
                if (d) {
                    targetGroup = d.group;
                    beforeId = d.id;
                }
            }
        }
        if (!targetGroup || targetGroup !== payload.group)
            return;
        if (payload.group === 'version') {
            await this.reorderVersionFields(payload.ids, beforeId);
        }
        else {
            await this.reorderGroup(payload.group, payload.ids, beforeId);
        }
    }
    async reorderVersionFields(ids, beforeId) {
        const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
        const list = getInfoFields(cfg);
        const moved = new Set(ids);
        const dragged = list.filter(e => moved.has(e.key));
        if (dragged.length === 0)
            return;
        const remaining = list.filter(e => !moved.has(e.key));
        let at = remaining.length;
        if (beforeId) {
            const idx = remaining.findIndex(e => e.key === beforeId);
            if (idx >= 0)
                at = idx;
        }
        remaining.splice(at, 0, ...dragged);
        if (await saveInfoFields(cfg, remaining))
            this.refresh();
    }
    async reorderGroup(group, ids, beforeId) {
        const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
        const order = getItemOrder(cfg);
        const current = order[group];
        const moved = new Set(ids);
        const dragged = current.filter(k => moved.has(k));
        if (dragged.length === 0)
            return;
        const remaining = current.filter(k => !moved.has(k));
        let at = remaining.length;
        if (beforeId) {
            const idx = remaining.indexOf(beforeId);
            if (idx >= 0)
                at = idx;
        }
        remaining.splice(at, 0, ...dragged);
        order[group] = remaining;
        if (writeWorkspaceSetting('biosBuildAssistant.itemOrder', order))
            this.refresh();
    }
    getTreeItem(element) {
        switch (element.kind) {
            case 'root': {
                // Should never happen; root has no tree item
                return new vscode.TreeItem('');
            }
            case 'group': {
                const map = {
                    paths: '📁 Key File Path',
                    version: '🔢 BIOS Current Info',
                    actions: '⚡ BIOS Build Action',
                    svnops: '🔧 SVN Operation',
                };
                const item = new vscode.TreeItem(map[element.id] ?? element.id, vscode.TreeItemCollapsibleState.Expanded);
                if (element.id === 'version')
                    item.contextValue = 'versionGroup';
                return item;
            }
            case 'info': {
                const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
                if (element.desc)
                    item.description = element.desc;
                if (element.tooltip)
                    item.tooltip = element.tooltip;
                if (element.cfgKey)
                    item.contextValue = 'infoField';
                else if (element.dndGroup === 'paths') {
                    item.contextValue = element.commandId === 'configureDefFile' ? 'pathDefFile' : 'pathBuildBat';
                    item.command = element.commandId ? {
                        command: `biosBuildAssistant.${element.commandId}`,
                        title: 'Configure path',
                    } : undefined;
                }
                let iconName;
                if (element.icon) {
                    iconName = element.icon;
                }
                else if (element.dndGroup === 'paths') {
                    iconName = 'file-code';
                }
                else if (element.dndGroup === 'version') {
                    iconName = 'symbol-field';
                }
                else if (/^[⚠❌]/.test(element.label)) {
                    iconName = 'warning';
                }
                else if (element.cfgKey) {
                    iconName = fieldIcon(element.cfgKey);
                }
                if (iconName)
                    item.iconPath = new vscode.ThemeIcon(iconName);
                if (element.filePath) {
                    const line = element.line ?? 0;
                    const pos = new vscode.Position(line, 0);
                    item.command = {
                        command: 'vscode.open',
                        title: 'Open',
                        arguments: [
                            vscode.Uri.file(element.filePath),
                            { selection: new vscode.Range(pos, pos), preview: false },
                        ],
                    };
                }
                return item;
            }
            case 'action': {
                const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
                const labels = {
                    incBuild: getActionLabel(cfg, 'formalBuild'),
                    testBuild: getActionLabel(cfg, 'testBuild'),
                    buildOnly: getActionLabel(cfg, 'buildOnly'),
                    svnUpdate: getActionLabel(cfg, 'svnUpdate'),
                    svnCleanRevert: getActionLabel(cfg, 'svnCleanRevert'),
                };
                const meta = {
                    incBuild: { label: labels.incBuild, icon: 'repo-push', tip: 'Increment MINOR, update dates, then compile' },
                    testBuild: { label: labels.testBuild, icon: 'beaker', tip: 'Build ID W -> T01 (or T02, T03...), update dates, then compile' },
                    buildOnly: { label: labels.buildOnly, icon: 'terminal', tip: 'Run build bat, no version change' },
                    svnUpdate: { label: labels.svnUpdate, icon: 'sync', tip: 'svn update' },
                    svnCleanRevert: { label: labels.svnCleanRevert, icon: 'clear-all', tip: 'cleanup & revert -R & cleanup --remove-unversioned & status' },
                }[element.id];
                const item = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.None);
                const isConfigurableBuild = element.id === 'incBuild' || element.id === 'testBuild';
                item.contextValue = isConfigurableBuild ? 'actionWithConfig' : 'action';
                item.tooltip = meta.tip;
                item.iconPath = new vscode.ThemeIcon(meta.icon);
                const cmdMap = {
                    incBuild: 'biosBuildAssistant.incrementAndBuild',
                    testBuild: 'biosBuildAssistant.testBuild',
                    buildOnly: 'biosBuildAssistant.buildOnly',
                    svnUpdate: 'biosBuildAssistant.svnUpdate',
                    svnCleanRevert: 'biosBuildAssistant.svnCleanRevert',
                };
                item.command = {
                    command: cmdMap[element.id],
                    title: meta.label,
                };
                return item;
            }
        }
    }
    getChildren(element) {
        try {
            if (!element) {
                // Top level: four groups
                return [
                    { kind: 'group', id: 'paths' },
                    { kind: 'group', id: 'version' },
                    { kind: 'group', id: 'actions' },
                    { kind: 'group', id: 'svnops' },
                ];
            }
            if (element.kind !== 'group') {
                // Leaf info/action nodes have no children
                return [];
            }
            const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
            if (element.id === 'paths') {
                const defPath = resolvePath(cfg.get('defFile', ''));
                const batPath = resolvePath(cfg.get('buildBat', ''));
                const items = [
                    { kind: 'info', label: 'BIOS Version File', desc: defPath || '(not configured)', tooltip: defPath, filePath: defPath && fs.existsSync(defPath) ? defPath : undefined, dndId: 'defFile', dndGroup: 'paths', icon: 'file-code', commandId: 'configureDefFile' },
                    { kind: 'info', label: 'Build Script', desc: batPath || '(not configured)', tooltip: batPath, filePath: batPath && fs.existsSync(batPath) ? batPath : undefined, dndId: 'buildBat', dndGroup: 'paths', icon: 'play', commandId: 'configureBuildBat' },
                ];
                return sortByDnd(items, getItemOrder(cfg).paths, x => x.kind === 'info' ? x.dndId : undefined);
            }
            if (element.id === 'version') {
                const defPath = resolvePath(cfg.get('defFile', ''));
                if (!defPath) {
                    return [{ kind: 'info', label: '❌ BIOS Version File is not configured' }];
                }
                if (!fs.existsSync(defPath)) {
                    return [{ kind: 'info', label: '❌ BIOS Version File is not founded', desc: defPath }];
                }
                let fields;
                let raw = '';
                try {
                    raw = readDefFile(defPath);
                    fields = parseConfigFields(raw);
                }
                catch (e) {
                    return [{ kind: 'info', label: '❌ Failed to read file', desc: e.message }];
                }
                if (fields.length === 0) {
                    return [{
                            kind: 'info',
                            label: '⚠️ No "Config" fields parsed',
                            desc: `${raw.split(/\r?\n/).length} lines`,
                            tooltip: defPath,
                        }];
                }
                const out = [];
                for (const entry of getInfoFields(cfg)) {
                    const f = fields.find(x => x.key === entry.key);
                    if (!f)
                        continue;
                    const v = stripValue(f.value);
                    if (!v)
                        continue;
                    out.push({
                        kind: 'info', label: entry.key, desc: v,
                        cfgKey: entry.key, filePath: defPath, line: f.lineIndex,
                        dndId: entry.key, dndGroup: 'version',
                    });
                }
                if (out.length === 0) {
                    out.push({ kind: 'info', label: '⚠️ No fields shown — click + to add or the reset button on the group title', tooltip: defPath });
                }
                return out;
            }
            if (element.id === 'actions') {
                const items = [
                    { kind: 'action', id: 'incBuild', dndGroup: 'actions' },
                    { kind: 'action', id: 'testBuild', dndGroup: 'actions' },
                    { kind: 'action', id: 'buildOnly', dndGroup: 'actions' },
                ];
                return sortByDnd(items, getItemOrder(cfg).actions, x => x.kind === 'action' ? x.id : undefined);
            }
            if (element.id === 'svnops') {
                const items = [
                    { kind: 'action', id: 'svnUpdate', dndGroup: 'svnops' },
                    { kind: 'action', id: 'svnCleanRevert', dndGroup: 'svnops' },
                ];
                return sortByDnd(items, getItemOrder(cfg).svnops, x => x.kind === 'action' ? x.id : undefined);
            }
            return [];
        }
        catch (e) {
            vscode.window.showErrorMessage('BIOS Build Assistant panel error: ' + e.message);
            return [{ kind: 'info', label: '❌ Error', desc: e.message }];
        }
    }
}
// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
let panelProvider;
function activate(context) {
    panelProvider = new BiosPanelProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider('biosBuildAssistant.panel', panelProvider), vscode.commands.registerCommand('biosBuildAssistant.incrementAndBuild', () => run(true)), vscode.commands.registerCommand('biosBuildAssistant.testBuild', () => runTestBuild()), vscode.commands.registerCommand('biosBuildAssistant.buildOnly', () => buildOnly()), vscode.commands.registerCommand('biosBuildAssistant.reselectBuildFields', (mode) => reselectBuildFields(mode)), vscode.commands.registerCommand('biosBuildAssistant.svnUpdate', () => runSvnCommands(['svn update'])), vscode.commands.registerCommand('biosBuildAssistant.svnCleanRevert', () => runSvnCommands([
        'svn cleanup .',
        'svn revert -R .',
        'svn cleanup --remove-unversioned .',
        'svn status .',
    ])), vscode.commands.registerCommand('biosBuildAssistant.configurePaths', () => configurePaths()), vscode.commands.registerCommand('biosBuildAssistant.configureDefFile', () => configurePath('defFile')), vscode.commands.registerCommand('biosBuildAssistant.configureBuildBat', () => configurePath('buildBat')), vscode.commands.registerCommand('biosBuildAssistant.addInfoField', () => addInfoField()), vscode.commands.registerCommand('biosBuildAssistant.resetInfoFields', () => resetInfoFields()), vscode.commands.registerCommand('biosBuildAssistant.removeInfoField', (el) => removeInfoField(el)), vscode.commands.registerCommand('biosBuildAssistant.moveItemUp', (el) => moveItem(el, -1)), vscode.commands.registerCommand('biosBuildAssistant.moveItemDown', (el) => moveItem(el, 1)), vscode.commands.registerCommand('biosBuildAssistant.refresh', () => panelProvider.refresh()), vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('biosBuildAssistant'))
            panelProvider.refresh();
    }));
}
function deactivate() { }
// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------
async function run(thenBuild) {
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const defPath = resolvePath(cfg.get('defFile', ''));
    if (!defPath) {
        vscode.window.showErrorMessage('BIOS Build Assistant: BIOS Version File is is not configured.');
        return;
    }
    if (!fs.existsSync(defPath)) {
        vscode.window.showErrorMessage(`BIOS Build Assistant: BIOS Version File is not found at:\n${defPath}`);
        return;
    }
    const raw = readDefFile(defPath);
    const fields = parseConfigFields(raw);
    if (fields.length === 0) {
        vscode.window.showWarningMessage('BIOS Build Assistant: no Config fields found in file.');
        return;
    }
    const majorField = fields.find(f => f.key === 'BIOS_VERSION_MAJOR');
    const minorField = fields.find(f => f.key === 'BIOS_VERSION_MINOR');
    if (!majorField || !minorField) {
        vscode.window.showErrorMessage('BIOS Build Assistant: BIOS_VERSION_MAJOR / BIOS_VERSION_MINOR not found.');
        return;
    }
    const curMajor = parseInt(stripValue(majorField.value), 10);
    const curMinor = parseInt(stripValue(minorField.value), 10);
    if (isNaN(curMajor) || isNaN(curMinor)) {
        vscode.window.showErrorMessage('BIOS Build Assistant: could not parse MAJOR/MINOR as integers.');
        return;
    }
    const newMinor = curMinor + 1;
    let newMajor = curMajor;
    const overflow = cfg.get('incrementMajor', false);
    if (overflow && newMinor >= 100) {
        newMajor += 1;
    }
    const dateFmt = cfg.get('dateFormat', 'MM/DD/YYYY') || 'MM/DD/YYYY';
    const newDate = formatDate(new Date(), dateFmt);
    const picked = await pickFieldsForBuild(cfg, 'formalBuildFields', fields, 'Select fields for Formal BIOS Build', DEFAULT_FORMAL_BUILD_FIELDS, false);
    const changes = computeAllChanges(fields, curMajor, curMinor, newMajor, newMinor, newDate, picked);
    const accepted = await showChangePreview(defPath, changes);
    if (!accepted) {
        vscode.window.showInformationMessage('BIOS Build Assistant: cancelled.');
        return;
    }
    const newContent = applyChanges(raw, changes);
    fs.writeFileSync(defPath, newContent, 'utf-8');
    vscode.window.showInformationMessage(`BIOS Build Assistant: ${changes.length} field(s) updated. MINOR ${curMinor} -> ${newMinor}.`);
    panelProvider.refresh();
    if (thenBuild) {
        await runBuild();
    }
}
async function buildOnly() {
    await runBuild();
}
async function reselectBuildFields(modeOrItem) {
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const defPath = resolvePath(cfg.get('defFile', ''));
    if (!defPath || !fs.existsSync(defPath)) {
        vscode.window.showErrorMessage('BIOS Build Assistant: configure BiosVersion.def path first.');
        return;
    }
    const raw = readDefFile(defPath);
    const fields = parseConfigFields(raw);
    if (fields.length === 0) {
        vscode.window.showWarningMessage('BIOS Build Assistant: no Config fields found in file.');
        return;
    }
    let selectedMode;
    if (modeOrItem && typeof modeOrItem !== 'string') {
        if (modeOrItem.kind === 'action') {
            selectedMode = modeOrItem.id === 'incBuild' ? 'formalBuildFields' : modeOrItem.id === 'testBuild' ? 'testBuildFields' : undefined;
        }
    }
    else {
        selectedMode = modeOrItem;
    }
    if (!selectedMode) {
        const picked = await vscode.window.showQuickPick([
            { label: 'Formal BIOS Build', value: 'formalBuildFields' },
            { label: 'Test BIOS Build', value: 'testBuildFields' },
        ], {
            placeHolder: 'Which build type do you want to reconfigure?',
        });
        selectedMode = picked?.value;
    }
    if (!selectedMode)
        return;
    const fallback = selectedMode === 'formalBuildFields' ? DEFAULT_FORMAL_BUILD_FIELDS : DEFAULT_TEST_BUILD_FIELDS;
    await pickFieldsForBuild(cfg, selectedMode, fields, selectedMode === 'formalBuildFields' ? 'Select fields for Formal BIOS Build' : 'Select fields for Test BIOS Build', fallback, true);
    panelProvider.refresh();
    vscode.window.showInformationMessage(`BIOS Build Assistant: ${selectedMode === 'formalBuildFields' ? 'Formal BIOS Build' : 'Test BIOS Build'} field selection updated.`);
}
async function runTestBuild() {
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const defPath = resolvePath(cfg.get('defFile', ''));
    if (!defPath) {
        vscode.window.showErrorMessage('BIOS Build Assistant: BIOS Version File is not configured.');
        return;
    }
    if (!fs.existsSync(defPath)) {
        vscode.window.showErrorMessage(`BIOS Build Assistant: BIOS Version File is not founded at:\n${defPath}`);
        return;
    }
    const raw = readDefFile(defPath);
    const fields = parseConfigFields(raw);
    const bldIdField = fields.find(f => f.key === 'LENOVO_COMMON_BLD_ID');
    if (!bldIdField) {
        vscode.window.showErrorMessage('BIOS Build Assistant: LENOVO_COMMON_BLD_ID not found.');
        return;
    }
    const newBldId = nextTestBuildId(bldIdField.value);
    if (newBldId === null) {
        vscode.window.showErrorMessage('BIOS Build Assistant: Build ID must end with W (release) or T## (test) to switch to a TEST build.');
        return;
    }
    const majorField = fields.find(f => f.key === 'BIOS_VERSION_MAJOR');
    const minorField = fields.find(f => f.key === 'BIOS_VERSION_MINOR');
    if (!majorField || !minorField) {
        vscode.window.showErrorMessage('BIOS Build Assistant: BIOS_VERSION_MAJOR / BIOS_VERSION_MINOR not found.');
        return;
    }
    const curMajor = parseInt(stripValue(majorField.value), 10);
    const curMinor = parseInt(stripValue(minorField.value), 10);
    if (isNaN(curMajor) || isNaN(curMinor)) {
        vscode.window.showErrorMessage('BIOS Build Assistant: could not parse MAJOR/MINOR as integers.');
        return;
    }
    const newMinor = curMinor + 1;
    let newMajor = curMajor;
    const overflow = cfg.get('incrementMajor', false);
    if (overflow && newMinor >= 100) {
        newMajor += 1;
    }
    const dateFmt = cfg.get('dateFormat', 'MM/DD/YYYY') || 'MM/DD/YYYY';
    const newDate = formatDate(new Date(), dateFmt);
    const selected = await pickFieldsForBuild(cfg, 'testBuildFields', fields, 'Select fields for Test BIOS Build', DEFAULT_TEST_BUILD_FIELDS, false);
    const changes = computeAllChanges(fields, curMajor, curMinor, newMajor, newMinor, newDate, selected);
    const selectedBld = selected.has('LENOVO_COMMON_BLD_ID');
    if (selectedBld) {
        const f = fields.find(x => x.key === 'LENOVO_COMMON_BLD_ID');
        if (f) {
            changes.push({ field: f, oldRaw: f.value, newRaw: newBldId, reason: 'test build id' });
        }
    }
    const dedup = new Map();
    for (const c of changes)
        dedup.set(c.field.key, c);
    const finalChanges = [...dedup.values()];
    if (finalChanges.length === 0) {
        vscode.window.showInformationMessage('BIOS Build Assistant: no changes needed.');
        return;
    }
    const accepted = await showChangePreview(defPath, finalChanges);
    if (!accepted) {
        vscode.window.showInformationMessage('BIOS Build Assistant: cancelled.');
        return;
    }
    fs.writeFileSync(defPath, applyChanges(raw, finalChanges), 'utf-8');
    const cleanId = newBldId.replace(/[\\"]/g, '').trim();
    vscode.window.showInformationMessage(`BIOS Build Assistant: TEST BIOS build id -> ${cleanId}. ${finalChanges.length} field(s) updated.`);
    panelProvider.refresh();
    await runBuild();
}
function runSvnCommands(commands) {
    const cwd = resolveSvnCwd();
    if (!cwd) {
        vscode.window.showErrorMessage('BIOS Build Assistant: no workspace folder for SVN commands.');
        return;
    }
    const terminal = vscode.window.createTerminal({ name: 'BIOS SVN', cwd });
    terminal.show(true);
    for (const cmd of commands) {
        terminal.sendText(cmd);
    }
}
function resolveSvnCwd() {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws)
        return ws;
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const defPath = resolvePath(cfg.get('defFile', ''));
    if (defPath && fs.existsSync(defPath))
        return path.dirname(defPath);
    const batPath = resolvePath(cfg.get('buildBat', ''));
    if (batPath && fs.existsSync(batPath))
        return path.dirname(batPath);
    return '';
}
async function configurePath(key) {
    const label = key === 'defFile' ? 'Bios Version File' : 'Build Script';
    const filters = key === 'defFile'
        ? { 'Config files': ['def'], 'All files': ['*'] }
        : { 'Batch files': ['bat', 'cmd'], 'All files': ['*'] };
    const defaultUri = getConfigFolder(key);
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters,
        defaultUri,
        title: `Select ${label}`,
    });
    if (!uris || uris.length === 0)
        return;
    let rawPath = uris[0].fsPath;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws && rawPath.startsWith(ws)) {
        rawPath = '${workspaceFolder}' + rawPath.substring(ws.length);
    }
    const configKey = `biosBuildAssistant.${key}`;
    const ok = writeWorkspaceSetting(configKey, rawPath);
    if (!ok)
        return;
    panelProvider.refresh();
    vscode.window.showInformationMessage(`BIOS Build Assistant: ${label} set to ${rawPath}`);
}
async function configurePaths() {
    const choice = await vscode.window.showQuickPick([
        { label: 'Bios Version File', key: 'defFile' },
        { label: 'Build Script', key: 'buildBat' },
    ], {
        placeHolder: 'Choose which BIOS version file is path or build script file path to configure',
    });
    if (!choice)
        return;
    await configurePath(choice.key);
}
function getConfigFolder(key) {
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const existing = resolvePath(cfg.get(key, ''));
    if (existing) {
        const dir = fs.existsSync(existing) && fs.statSync(existing).isDirectory()
            ? existing
            : path.dirname(existing);
        return vscode.Uri.file(dir);
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return ws ? vscode.Uri.file(ws) : undefined;
}
// ---------------------------------------------------------------------------
// BIOS Current Info: add / remove displayed fields
// ---------------------------------------------------------------------------
async function addInfoField() {
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const defPath = resolvePath(cfg.get('defFile', ''));
    if (!defPath || !fs.existsSync(defPath)) {
        vscode.window.showErrorMessage('BIOS Build Assistant: configure BiosVersion.def path first.');
        return;
    }
    let fields = [];
    try {
        fields = parseConfigFields(readDefFile(defPath));
    }
    catch {
        // fall through with an empty list
    }
    const usedKeys = new Set(getInfoFields(cfg).map(e => e.key));
    const items = [];
    for (const f of fields) {
        if (usedKeys.has(f.key))
            continue;
        items.push({
            label: f.key,
            description: stripValue(f.value) || '(empty)',
            key: f.key,
        });
    }
    if (items.length === 0) {
        vscode.window.showInformationMessage('BIOS Build Assistant: every available field is already shown.');
        return;
    }
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Config field to show under BIOS Current Info',
    });
    if (!pick)
        return;
    const list = getInfoFields(cfg);
    list.push({ label: pick.key, key: pick.key });
    if (!await saveInfoFields(cfg, list))
        return;
    panelProvider.refresh();
}
async function removeInfoField(element) {
    if (!element || element.kind !== 'info' || !element.cfgKey)
        return;
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const list = getInfoFields(cfg).filter(e => e.key !== element.cfgKey);
    if (!await saveInfoFields(cfg, list))
        return;
    panelProvider.refresh();
}
async function resetInfoFields() {
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const pick = await vscode.window.showWarningMessage('Reset "BIOS Current Info" fields to the default set and order?', { modal: true }, 'Reset');
    if (pick !== 'Reset')
        return;
    const defaults = DEFAULT_INFO_FIELDS.map(e => ({ ...e }));
    if (!await saveInfoFields(cfg, defaults))
        return;
    panelProvider.refresh();
}
// Right-click "Move Up / Move Down" counterpart to drag-and-drop reordering.
async function moveItem(element, dir) {
    if (!element)
        return;
    let id;
    let group;
    if (element.kind === 'action') {
        id = element.id;
        group = element.dndGroup;
    }
    else if (element.kind === 'info') {
        id = element.dndId;
        group = element.dndGroup;
    }
    if (!id || !group)
        return;
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    if (group === 'version') {
        const list = getInfoFields(cfg);
        const i = list.findIndex(e => e.key === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length)
            return;
        [list[i], list[j]] = [list[j], list[i]];
        if (await saveInfoFields(cfg, list))
            panelProvider.refresh();
        return;
    }
    if (group !== 'paths' && group !== 'actions' && group !== 'svnops')
        return;
    const order = getItemOrder(cfg);
    const arr = order[group];
    const i = arr.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length)
        return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    order[group] = arr;
    if (writeWorkspaceSetting('biosBuildAssistant.itemOrder', order))
        panelProvider.refresh();
}
// Persist infoFields directly into .vscode/settings.json so the host's
// extension-manifest cache can never block the write.
function saveInfoFields(_cfg, list) {
    return writeWorkspaceSetting('biosBuildAssistant.infoFields', list);
}
// ---------------------------------------------------------------------------
// Change computation
// ---------------------------------------------------------------------------
function computeAllChanges(fields, curMajor, curMinor, newMajor, newMinor, newDate, selected) {
    const changes = [];
    const pushChange = (field, newRaw, reason) => {
        if (!field)
            return;
        changes.push({ field, oldRaw: field.value, newRaw, reason });
    };
    for (const key of selected) {
        const field = fields.find(x => x.key === key);
        if (!field)
            continue;
        if (/VERSION_MAJOR$/i.test(key)) {
            pushChange(field, String(newMajor), 'major update');
            continue;
        }
        if (/VERSION_MINOR$/i.test(key)) {
            pushChange(field, String(newMinor), 'auto-increment');
            continue;
        }
        if (/BIOS_VERSION$/i.test(key) || /LENOVO_SECURITY_VERSION$/i.test(key)) {
            const next = bumpVersionString(field.value);
            if (next !== null)
                pushChange(field, next, 'bump embedded version');
            continue;
        }
        if (/ACPI_OEM_REVISION$/i.test(key) || /ACPI_OEM_TABLE_ID$/i.test(key)) {
            const q = Math.floor(newMinor / 10);
            const r = newMinor % 10;
            const oemRev = (newMajor << 12) | (q << 8) | (r << 4);
            const next = '0x' + oemRev.toString(16).toUpperCase().padStart(8, '0');
            pushChange(field, next, 'derived from MAJOR.MINOR (PQR)');
            continue;
        }
        if (/BLD_DATE$/i.test(key) || /BUILD_DATE$/i.test(key)) {
            pushChange(field, quoteLike(field.value, newDate), 'today');
            continue;
        }
        if (/BLD_TIME$/i.test(key)) {
            pushChange(field, quoteLike(field.value, formatTime(new Date())), 'time now');
            continue;
        }
        if (/BLD_ID$/i.test(key)) {
            const next = replaceWholeNumber(field.value, curMinor, newMinor);
            pushChange(field, next, `replace ${curMinor} -> ${newMinor}`);
            continue;
        }
        if (/FW_VER_PACKAGE$/i.test(key)) {
            const next = bumpLastTwoDigits(field.value);
            if (next !== null)
                pushChange(field, next, 'bump 2-digit ver');
        }
    }
    return changes;
}
function bumpVersionString(oldRaw) {
    const re = /(\d+)\.(\d+)/;
    const m = oldRaw.match(re);
    if (!m)
        return null;
    const minorGroup = m[2];
    const num = parseInt(minorGroup, 10);
    if (isNaN(num))
        return null;
    const bumped = String(num + 1).padStart(minorGroup.length, '0');
    return oldRaw.substring(0, m.index + m[1].length + 1) + bumped + oldRaw.substring(m.index + m[0].length);
}
function replaceWholeNumber(oldRaw, curNum, newNum) {
    const re = new RegExp(`(?<!\\d)${curNum}(?!\\d)`);
    return oldRaw.replace(re, String(newNum));
}
function bumpLastTwoDigits(oldRaw) {
    const re = /(\d{2})(?!\d)/g;
    let lastMatch = null;
    let m;
    while ((m = re.exec(oldRaw)) !== null) {
        lastMatch = m;
    }
    if (!lastMatch)
        return null;
    const num = parseInt(lastMatch[1], 10);
    const bumped = String(num + 1).padStart(2, '0');
    return oldRaw.substring(0, lastMatch.index) + bumped + oldRaw.substring(lastMatch.index + 2);
}
// Release build ID ends with W (e.g. "N4YET27W"). First TEST build turns it
// into T01; subsequent TEST builds bump the digits (T01 -> T02 -> T03 ...).
// The raw value keeps its surrounding escaped quotes, e.g. "\"N4YET27W \"".
function nextTestBuildId(oldRaw) {
    let m = oldRaw.match(/(T)(\d+)(\s*\\?"{1,2})$/);
    if (m) {
        const n = parseInt(m[2], 10) + 1;
        const suffix = 'T' + String(n).padStart(m[2].length, '0');
        return oldRaw.substring(0, m.index) + suffix + m[3];
    }
    m = oldRaw.match(/(W)(\s*\\?"{1,2})$/);
    if (m) {
        return oldRaw.substring(0, m.index) + 'T01' + m[2];
    }
    return null;
}
// String fields in the def file are stored as "\"value \"" (outer quotes plus
// backslash-escaped inner quotes). Preserve whatever quoting the field uses.
function quoteLike(oldRaw, inner) {
    if (oldRaw.includes('\\"')) {
        return '"\\"' + inner + '\\""';
    }
    return '"' + inner + '"';
}
// ---------------------------------------------------------------------------
// Build execution
// ---------------------------------------------------------------------------
async function runBuild() {
    const cfg = vscode.workspace.getConfiguration('biosBuildAssistant');
    const batPath = resolvePath(cfg.get('buildBat', ''));
    const extraArgs = cfg.get('buildArgs', '') || '';
    if (!batPath) {
        vscode.window.showErrorMessage('BIOS Build Assistant: buildBat not configured.');
        return;
    }
    if (!fs.existsSync(batPath)) {
        vscode.window.showErrorMessage(`BIOS Build Assistant: build bat not found:\n${batPath}`);
        return;
    }
    const terminal = vscode.window.createTerminal({
        name: 'BIOS Build',
        cwd: path.dirname(batPath),
    });
    terminal.show(true);
    const prefix = process.platform === 'win32' ? '.\\' : './';
    terminal.sendText(prefix + path.basename(batPath) + (extraArgs ? ' ' + extraArgs : ''));
    vscode.window.showInformationMessage(`BIOS Build Assistant: build started in terminal "BIOS Build".`);
}
// ---------------------------------------------------------------------------
// Preview / confirmation UI
// ---------------------------------------------------------------------------
async function showChangePreview(defPath, changes) {
    if (changes.length === 0) {
        vscode.window.showInformationMessage('BIOS Build Assistant: no changes needed.');
        return false;
    }
    const detail = changes
        .map(c => `  ${c.field.key}: ${c.oldRaw.trim()}  →  ${c.newRaw.trim()}   (${c.reason})`)
        .join('\n');
    const selected = await vscode.window.showInformationMessage(`Apply ${changes.length} change(s) to ${path.basename(defPath)}?\n\n${detail}`, { modal: true }, 'Apply', 'Cancel');
    return selected === 'Apply';
}
// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------
function parseConfigFields(rawIn) {
    const raw = rawIn.replace(/^\uFEFF/, ''); // strip UTF-8 BOM if present
    const lines = raw.split(/\r?\n/);
    // Real line terminator length: CRLF files need +2 per line, LF files +1.
    const sepLen = raw.includes('\r\n') ? 2 : 1;
    const fields = [];
    let offset = 0;
    const lineRe = /^(\s*Config\s+)(\w+)\s*,\s*(.*?)(\s*(?:\/\/.*)?)$/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(lineRe);
        if (m) {
            const key = m[2];
            const valuePart = m[3];
            // Compute value start from capture-group boundaries (prefix + key),
            // then locate the comma and skip following whitespace. This avoids
            // indexOf pitfalls when the same text happens to appear twice.
            const commaPos = line.indexOf(',', m[1].length + m[2].length - 1);
            const wsAfterComma = line.substring(commaPos + 1).match(/^\s*/)?.[0].length ?? 0;
            const valueStartInLine = commaPos + 1 + wsAfterComma;
            const valueStart = offset + valueStartInLine;
            const valueEnd = valueStart + valuePart.length;
            fields.push({
                key,
                value: valuePart,
                lineIndex: i,
                matchStart: valueStart,
                matchEnd: valueEnd,
            });
        }
        offset += line.length + sepLen;
    }
    return fields;
}
// BOM must be stripped identically before parsing and before applying changes,
// otherwise every offset is shifted by one when the file carries a BOM.
function readDefFile(defPath) {
    return fs.readFileSync(defPath, 'utf-8').replace(/^\uFEFF/, '');
}
function applyChanges(raw, changes) {
    const sorted = [...changes].sort((a, b) => b.field.matchStart - a.field.matchStart);
    let out = raw;
    for (const c of sorted) {
        out = out.substring(0, c.field.matchStart) + c.newRaw + out.substring(c.field.matchEnd);
    }
    return out;
}
function stripValue(raw) {
    // String fields are stored like "\"1.02 \"" (outer quotes + escaped inner
    // quotes). Strip every quote/backslash and surrounding whitespace.
    return raw.replace(/[\\"]/g, '').trim();
}
function formatDate(d, fmt) {
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const YYYY = String(d.getFullYear());
    return fmt
        .replace('MM', MM)
        .replace('DD', DD)
        .replace('YYYY', YYYY);
}
function formatTime(d) {
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    const SS = String(d.getSeconds()).padStart(2, '0');
    return `${HH}:${MM}:${SS}`;
}
function resolvePath(p) {
    if (!p)
        return '';
    if (p.includes('${workspaceFolder}')) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        p = p.replace(/\$\{workspaceFolder\}/g, ws);
    }
    return path.resolve(p);
}
//# sourceMappingURL=extension.js.map