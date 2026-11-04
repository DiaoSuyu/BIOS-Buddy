import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { registerBinaryEditor, openBinaryEditor } from './binaryEditor';
import { registerGuidTool } from './guidTool';
import { registerSerialConsole } from './serialPort';
import { registerTextCompare } from './textCompare';
import {
    svnUpdate, svnClean, gitUpdate, gitResetClean,
    vcsRootFor, runStepsInTerminal,
} from './vcsOps';
import {
    VcsAction, VcsTool,
    defaultActions, normalizeActions, findAction, isModified, withSteps,
    makeCustomId, splitSteps, joinSteps, expandStep, presetIds,
    visibleActions, hiddenActions, removeAction, restoreAction, insertPreset,
} from './vcsActions';
import {
    BuildTarget, PRESET_BUILD_ID,
    defaultBuilds, normalizeBuilds, findBuild, visibleBuilds, hiddenBuilds,
    removeBuild, restoreBuild, makeBuildId, scriptStem, displayLabel,
} from './buildTargets';
import {
    readJsonFile, writeJsonFile, pickOwned, snapshotTree, restoreMissingFiles, restoreOwnedSettings,
} from './settingsGuard';

// Keep the context around: the guard needs globalStorageUri from anywhere
let extCtx: vscode.ExtensionContext | undefined;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedField {
    key: string;
    value: string;
    lineIndex: number;
    matchStart: number;
    matchEnd: number;
}

interface FieldChange {
    field: ParsedField;
    oldRaw: string;
    newRaw: string;
    reason: string;
}

type ElementKind =
    | { kind: 'root' }
    | { kind: 'group'; id: string }
    | { kind: 'info'; label: string; desc?: string; tooltip?: string; filePath?: string; line?: number; cfgKey?: string; dndId?: string; dndGroup?: string; icon?: string; tint?: 'warning' | 'error' }
    | { kind: 'action'; id: 'incBuild' | 'testBuild' | 'binEdit' | 'serialTool' | 'txtCmp' | 'guidTool'; dndGroup?: string }
    | { kind: 'build'; target: BuildTarget; dndGroup?: string }
    | { kind: 'buildHidden'; target: BuildTarget }
    | { kind: 'vcs'; tool: VcsTool; action: VcsAction; dndGroup?: string }
    | { kind: 'vcsHidden'; tool: VcsTool; action: VcsAction };

// One row under "BIOS Current Info": display label + Config field key.
// Labels always mirror the raw token names from BiosVersion.def.
interface InfoFieldCfg {
    label: string;
    key: string;
}

const DEFAULT_INFO_FIELDS: InfoFieldCfg[] = [
    { label: 'BIOS_VERSION',           key: 'BIOS_VERSION' },
    { label: 'BIOS_VERSION_MAJOR',     key: 'BIOS_VERSION_MAJOR' },
    { label: 'BIOS_VERSION_MINOR',     key: 'BIOS_VERSION_MINOR' },
    { label: 'ACPI_OEM_REVISION',      key: 'ACPI_OEM_REVISION' },
    { label: 'LENOVO_COMMON_BLD_ID',   key: 'LENOVO_COMMON_BLD_ID' },
    { label: 'LENOVO_COMMON_BLD_DATE', key: 'LENOVO_COMMON_BLD_DATE' },
];

// Convert old-style entries (virtual @version / @majorMinor, custom labels)
// into raw-token entries, and drop invalid rows.
function normalizeInfoFields(raw: unknown): InfoFieldCfg[] | null {
    if (!Array.isArray(raw)) return null;
    const out: InfoFieldCfg[] = [];
    const seen = new Set<string>();
    const push = (key: string) => {
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({ label: key, key });
    };
    for (const x of raw as Array<{ label?: unknown; key?: unknown }>) {
        const key = typeof x?.key === 'string' ? x.key : '';
        if (key === '@version') {
            push('BIOS_VERSION');
        } else if (key === '@majorMinor') {
            push('BIOS_VERSION_MAJOR');
            push('BIOS_VERSION_MINOR');
        } else {
            push(key);
        }
    }
    return out;
}

// Direct .vscode/settings.json access. Some hosts cache extension manifests
// and reject workspace writes of "unregistered" settings even when the current
// package.json declares them; reading/writing the file bypasses that entirely.
function workspaceSettingsPath(): string | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return root ? path.join(root, '.vscode', 'settings.json') : undefined;
}

// ---------------------------------------------------------------------------
// Settings guard — Clean treats .vscode/settings.json as an untracked file and deletes it
// ---------------------------------------------------------------------------

/** One folder per workspace inside the extension's global storage: follows the machine, never the repo */
function guardDir(): string | undefined {
    const gs = extCtx?.globalStorageUri?.fsPath;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!gs || !ws) return undefined;
    let h = 0;
    for (let i = 0; i < ws.length; i++) h = (h * 31 + ws.charCodeAt(i)) | 0;
    const tag = `${path.basename(ws).replace(/[^\w.-]+/g, '_')}-${Math.abs(h).toString(36)}`;
    return path.join(gs, 'workspace-guard', tag);
}

function settingsMirrorPath(): string | undefined {
    const g = guardDir();
    return g ? path.join(g, 'settings-mirror.json') : undefined;
}

function vscodeSnapshotDir(): string | undefined {
    const g = guardDir();
    return g ? path.join(g, 'dot-vscode') : undefined;
}

/** Mirror this extension's workspace settings into global storage */
function mirrorOwnedSettings(): void {
    const src = workspaceSettingsPath();
    const dest = settingsMirrorPath();
    if (!src || !dest) return;
    try {
        const own = pickOwned(readJsonFile(src));
        if (Object.keys(own).length) writeJsonFile(dest, own);
    } catch { /* A broken mirror must not break the main flow */ }
}

/** Restore workspace settings from the mirror when the whole block was deleted; returns the keys put back */
function restoreOwnedFromMirror(): string[] {
    const src = workspaceSettingsPath();
    const mirror = settingsMirrorPath();
    if (!src || !mirror) return [];
    return restoreOwnedSettings(src, mirror);
}

/** Before a Clean: snapshot the whole .vscode folder */
function snapshotDotVscode(): string[] {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const dest = vscodeSnapshotDir();
    if (!ws || !dest) return [];
    const src = path.join(ws, '.vscode');
    if (!fs.existsSync(src)) return [];
    return snapshotTree(src, dest);
}

let guardTimer: ReturnType<typeof setInterval> | undefined;

/**
 * After a destructive Clean-style command: re-create the files missing from .vscode
 * on a timer. The command runs in a terminal and the extension cannot tell when it
 * ends, so we restore on every tick of a short window — svn deletes, the next tick
 * puts it back — and stop by ourselves once the window is over.
 */
function watchDotVscode(): void {
    if (guardTimer) clearInterval(guardTimer);
    const started = Date.now();
    let told = false;
    guardTimer = setInterval(() => {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const snap = vscodeSnapshotDir();
        if (ws && snap) {
            const back = restoreMissingFiles(snap, path.join(ws, '.vscode'));
            const keys = restoreOwnedFromMirror();
            if (back.length || keys.length) {
                refreshPanel();
                if (!told) {
                    told = true;
                    vscode.window.setStatusBarMessage(
                        `BIOS Buddy: restored ${Math.max(back.length, keys.length)} file(s) in .vscode that Clean removed`,
                        8000,
                    );
                }
            }
        }
        if (Date.now() - started > 3 * 60 * 1000) {
            clearInterval(guardTimer!);
            guardTimer = undefined;
        }
    }, 1200);
    (guardTimer as unknown as { unref?: () => void }).unref?.();
}

function readWorkspaceSettings(): Record<string, unknown> {
    const p = workspaceSettingsPath();
    if (!p || !fs.existsSync(p)) return {};
    try {
        const txt = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
        if (!txt.trim()) return {};
        const obj = JSON.parse(txt);
        return obj && typeof obj === 'object' ? obj as Record<string, unknown> : {};
    } catch {
        return {};
    }
}

function writeWorkspaceSetting(key: string, value: unknown): boolean {
    const p = workspaceSettingsPath();
    if (!p) return false;
    try {
        let settings: Record<string, unknown> = {};
        if (fs.existsSync(p)) {
            const txt = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
            if (txt.trim()) settings = JSON.parse(txt);
        } else {
            fs.mkdirSync(path.dirname(p), { recursive: true });
        }
        settings[key] = value;
        fs.writeFileSync(p, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
        mirrorOwnedSettings();
        return true;
    } catch (e) {
        vscode.window.showErrorMessage(
            `BIOS Buddy: cannot write ${p}: ${(e as Error).message}`,
        );
        return false;
    }
}

function readWorkspaceValue<T>(cfg: vscode.WorkspaceConfiguration, leaf: string): unknown {
    // File always wins: it is what the user sees and it survives host caches.
    const fromFile = readWorkspaceSettings()[`biosBuddy.${leaf}`];
    if (fromFile !== undefined) return fromFile;
    const ins = cfg.inspect<T>(leaf);
    return ins?.workspaceFolderValue ?? ins?.workspaceValue ?? ins?.globalValue;
}

// An explicitly stored empty list is valid (all fields hidden); only fall back
// to defaults when the setting was never configured at all.
function getInfoFields(cfg: vscode.WorkspaceConfiguration): InfoFieldCfg[] {
    const configured = readWorkspaceValue<InfoFieldCfg[]>(cfg, 'infoFields');
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

function getConfiguredChangeFields(cfg: vscode.WorkspaceConfiguration, key: 'formalBuildFields' | 'testBuildFields', fallback: string[]): Set<string> {
    const configured = readWorkspaceValue<string[]>(cfg, key);
    const entries = Array.isArray(configured) ? configured : [];
    const cleaned = entries
        .map(v => typeof v === 'string' ? v.trim() : '')
        .filter(Boolean);
    return new Set(cleaned.length ? cleaned : fallback);
}

function getAvailableDefKeys(fields: ParsedField[]): string[] {
    return [...new Set(fields.map(f => f.key).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function pickFieldsForBuild(
    cfg: vscode.WorkspaceConfiguration,
    mode: 'formalBuildFields' | 'testBuildFields',
    fields: ParsedField[],
    title: string,
    fallback: string[],
    forcePrompt = false,
): Promise<Set<string>> {
    const allKeys = getAvailableDefKeys(fields);
    const saved = readWorkspaceValue<string[]>(cfg, mode);
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
    writeWorkspaceSetting(`biosBuddy.${mode}`, Array.from(chosen));
    return chosen;
}

// Drag-and-drop ordering for the non-field groups. Each entry is a stable item
// id; the panel renders in this order, unknown/new ids append at the end.
// Build rows (build.only / build.custom.N) live in the same 'actions' list.
type OrderGroup = 'actions' | 'svnops' | 'gitops' | 'tools';
const DEFAULT_ITEM_ORDER: Record<OrderGroup, string[]> = {
    actions: ['incBuild', 'testBuild', PRESET_BUILD_ID],
    svnops:  ['svnUpdate', 'svnCleanRevert'],
    gitops:  ['gitUpdate', 'gitResetClean'],
    tools:   ['guidTool', 'serialTool', 'txtCmp', 'binEdit'],
};

function getItemOrder(cfg: vscode.WorkspaceConfiguration): Record<OrderGroup, string[]> {
    const v = (readWorkspaceValue(cfg, 'itemOrder') ?? {}) as Partial<Record<OrderGroup, string[]>>;
    // Always hand out a copy: callers push and splice, and returning the module constant would dirty it
    const pick = (key: OrderGroup, raw: unknown): string[] =>
        Array.isArray(raw) && raw.length ? [...raw as string[]] : [...DEFAULT_ITEM_ORDER[key]];
    const tools0 = pick('tools', v.tools);
    // Every tools order older versions could have stored: the three older tools in any order,
    // with GUID Assistant appended at the end once it was registered. Matching one of those
    // means the list was never dragged, so it gets the current default (GUID Assistant first)
    // instead of staying frozen with GUID Assistant last.
    const LEGACY_TOOLS = (() => {
        const base = ['serialTool', 'binEdit', 'txtCmp'];
        const out = new Set<string>();
        const perm = (rest: string[], cur: string[]): void => {
            if (!rest.length) {
                out.add(cur.join(','));
                out.add([...cur, 'guidTool'].join(','));
                return;
            }
            rest.forEach((x, i) => perm([...rest.slice(0, i), ...rest.slice(i + 1)], [...cur, x]));
        };
        perm(base, []);
        return out;
    })();
    const tools = LEGACY_TOOLS.has(tools0.join(','))
        ? [...DEFAULT_ITEM_ORDER.tools] : tools0;
    return {
        actions: pick('actions', v.actions),
        svnops:  pick('svnops', v.svnops),
        gitops:  pick('gitops', v.gitops),
        tools,
    };
}

function getActionLabel(cfg: vscode.WorkspaceConfiguration, key: 'formalBuild' | 'testBuild' | 'buildOnly' | 'svnUpdate' | 'svnCleanRevert' | 'gitUpdate' | 'gitResetClean'): string {
    const overrides: Record<typeof key, string> = {
        formalBuild: 'formalBuildLabel',
        testBuild: 'testBuildLabel',
        buildOnly: 'buildOnlyLabel',
        svnUpdate: 'svnUpdateLabel',
        svnCleanRevert: 'svnCleanRevertLabel',
        gitUpdate: 'gitUpdateLabel',
        gitResetClean: 'gitResetCleanLabel',
    };
    const defaultLabels: Record<typeof key, string> = {
        formalBuild: 'Formal BIOS Version',
        testBuild: 'Test BIOS Version',
        buildOnly: 'Build',
        svnUpdate: 'SVN Update',
        svnCleanRevert: 'SVN Clean & Revert',
        gitUpdate: 'Git Update',
        gitResetClean: 'Git Reset & Clean',
    };
    const value = readWorkspaceValue<string>(cfg, overrides[key]);
    return typeof value === 'string' && value.trim() ? value.trim() : defaultLabels[key];
}

// ---------------------------------------------------------------------------
// Build rows (Build Only plus any build the user added)
//
// The preset row still keeps its three fields in the old settings (buildBat / buildArgs / buildOnlyLabel),
// so existing configurations keep working after the upgrade; builds[] only records the extra rows, their names and scripts.
// ---------------------------------------------------------------------------

/** Script name without its extension — build rows are named after the .bat by default */
function scriptLabel(script: string): string {
    return scriptStem(script || '');
}

function presetBuild(cfg: vscode.WorkspaceConfiguration): BuildTarget {
    const rawScript = cfg.get<string>('buildBat', '') || '';
    const stem = scriptLabel(resolvePath(rawScript));
    // The name follows the script: with no buildOnlyLabel in settings, use the .bat file name.
    // Older versions wrote the script name into buildOnlyLabel on every swap — a name equal to the script name is not a rename.
    const explicit = readWorkspaceValue<string>(cfg, 'buildOnlyLabel');
    const named = typeof explicit === 'string' ? explicit.trim() : '';
    const manual = !!named && named !== stem;
    const preset = defaultBuilds(manual ? named : stem, rawScript, cfg.get<string>('buildArgs', '') || '')[0];
    return manual ? { ...preset, renamed: true } : preset;
}

/**
 * Versions up to 0.7.4 wrote the script name into buildOnlyLabel whenever the
 * script changed, which pinned the name. On upgrade, drop such settings when they
 * merely repeat the current script name, so the name follows again.
 */
function migrateAutoBuildLabel(): void {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const named = readWorkspaceValue<string>(cfg, 'buildOnlyLabel');
    const bat = cfg.get<string>('buildBat', '') || '';
    if (typeof named !== 'string' || !named.trim() || !bat) return;
    if (named.trim() === scriptLabel(resolvePath(bat))) {
        removeWorkspaceSetting('biosBuddy.buildOnlyLabel');
    }
}

function getBuilds(cfg: vscode.WorkspaceConfiguration): BuildTarget[] {
    const raw = readWorkspaceValue(cfg, 'builds');
    if (raw === undefined) return [presetBuild(cfg)];
    return normalizeBuilds(raw, presetBuild(cfg));
}

function saveBuilds(list: BuildTarget[]): boolean {
    // The preset row's content always comes from those separate settings; this only records that it was removed,
    // so one script is never stored twice with only one copy taking effect
    const clean = list
        .filter(b => b.id !== PRESET_BUILD_ID || b.hidden)
        .map(b => b.id === PRESET_BUILD_ID
            ? { id: b.id, hidden: true }
            : {
                id: b.id,
                // The name is stored only after a manual rename; otherwise the panel derives it from the script name every time
                ...(b.renamed ? { label: b.label, renamed: true } : {}),
                script: b.script,
                ...(b.args ? { args: b.args } : {}),
                custom: true,
            });
    return writeWorkspaceSetting('biosBuddy.builds', clean);
}

function buildTargetOf(arg: unknown): BuildTarget | undefined {
    const o = arg as { target?: BuildTarget } | undefined;
    if (o && o.target && typeof o.target === 'object' && typeof o.target.id === 'string') return o.target;
    return undefined;
}

/** How this row lands in the settings after its script or arguments change */
function updateBuild(
    presetPatch: { label?: string; script?: string; args?: string; renamed?: boolean },
    list: BuildTarget[],
    id: string,
): boolean {
    if (id === PRESET_BUILD_ID) {
        if (presetPatch.script !== undefined) writeWorkspaceSetting('biosBuddy.buildBat', presetPatch.script);
        // When the name follows the script we store nothing, so the next .bat swap renames it again
        if (presetPatch.renamed === false) removeWorkspaceSetting('biosBuddy.buildOnlyLabel');
        else if (presetPatch.label !== undefined) writeWorkspaceSetting('biosBuddy.buildOnlyLabel', presetPatch.label);
        if (presetPatch.args !== undefined) writeWorkspaceSetting('biosBuddy.buildArgs', presetPatch.args);
        return true;
    }
    const idx = list.findIndex(b => b.id === id);
    if (idx < 0) return false;
    list[idx] = {
        ...list[idx],
        ...(presetPatch.label !== undefined ? { label: presetPatch.label } : {}),
        ...(presetPatch.script !== undefined ? { script: presetPatch.script } : {}),
        ...(presetPatch.args !== undefined ? { args: presetPatch.args } : {}),
        ...(presetPatch.renamed !== undefined ? { renamed: presetPatch.renamed || undefined } : {}),
    };
    return saveBuilds(list);
}

// ---------------------------------------------------------------------------
// SVN / Git actions (presets plus user-defined ones)
// ---------------------------------------------------------------------------

function vcsSettingKey(tool: VcsTool): string {
    return tool === 'svn' ? 'svnActions' : 'gitActions';
}

function vcsDefaultLabels(cfg: vscode.WorkspaceConfiguration, tool: VcsTool): { update: string; clean: string } {
    return tool === 'svn'
        ? { update: getActionLabel(cfg, 'svnUpdate'), clean: getActionLabel(cfg, 'svnCleanRevert') }
        : { update: getActionLabel(cfg, 'gitUpdate'), clean: getActionLabel(cfg, 'gitResetClean') };
}

/** The action list in force: presets until settings.json has its own copy, then that copy wins */
function getVcsActions(cfg: vscode.WorkspaceConfiguration, tool: VcsTool): VcsAction[] {
    const defaults = defaultActions(tool, vcsDefaultLabels(cfg, tool));
    const raw = readWorkspaceValue(cfg, vcsSettingKey(tool));
    if (raw === undefined) return defaults;
    return normalizeActions(raw);
}

function saveVcsActions(tool: VcsTool, list: VcsAction[]): boolean {
    return writeWorkspaceSetting(`biosBuddy.${vcsSettingKey(tool)}`, list);
}

function removeWorkspaceSetting(key: string): boolean {
    const p = workspaceSettingsPath();
    if (!p || !fs.existsSync(p)) return true;
    try {
        const txt = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
        const settings = txt.trim() ? JSON.parse(txt) as Record<string, unknown> : {};
        if (!(key in settings)) return true;
        delete settings[key];
        fs.writeFileSync(p, JSON.stringify(settings, null, 4) + '\n', 'utf-8');
        mirrorOwnedSettings();
        return true;
    } catch (e) {
        vscode.window.showErrorMessage(
            `BIOS Buddy: cannot write ${p}: ${(e as Error).message}`,
        );
        return false;
    }
}

function vcsGroupOf(tool: VcsTool): OrderGroup {
    return tool === 'svn' ? 'svnops' : 'gitops';
}

/** Work out which action a command argument refers to — inline buttons pass a TreeItem, context menus pass the element */
interface VcsTarget { tool: VcsTool; action: VcsAction; }

function vcsTargetOf(arg: unknown): VcsTarget | undefined {
    const o = arg as (Partial<VcsTarget> & { tool?: VcsTool; action?: VcsAction }) | undefined;
    if (o && o.action && typeof o.action === 'object' && (o.tool === 'svn' || o.tool === 'git')) {
        return { tool: o.tool, action: o.action };
    }
    return undefined;
}

// Pick a codicon for a def Config token so every child row carries an icon;
// this keeps the icon/label columns aligned across all groups.
function fieldIcon(key: string): string {
    if (/DATE|TIME/i.test(key)) return 'calendar';
    if (/MAJOR|MINOR|REVISION|VERSION\b|SIGN/i.test(key)) return 'symbol-number';
    if (/_ID$|_ID_/i.test(key) || key === 'BIOS_VERSION') return 'tag';
    return 'symbol-field';
}

// Every row carries a 16px icon so all labels land on the same column. Emoji in a
// label are wider than a codicon, which shoves that one label out of line.
function treeIcon(id: string, colorId?: string): vscode.ThemeIcon {
    const Color = (vscode as unknown as { ThemeColor?: new (id: string) => vscode.ThemeColor }).ThemeColor;
    return colorId && Color ? new vscode.ThemeIcon(id, new Color(colorId)) : new vscode.ThemeIcon(id);
}

// Stable sort: items keep their relative order unless `order` moves them.
function sortByDnd<T>(items: T[], order: string[], keyOf: (x: T) => string | undefined): T[] {
    const rank = (x: T) => {
        const k = keyOf(x);
        const i = k ? order.indexOf(k) : -1;
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...items].sort((a, b) => rank(a) - rank(b));
}

// The order a group currently shows in the tree (same rules getChildren uses).
// Move up / down falls back on it: ids missing from the order table (newly added actions) have no position otherwise.
function displayedIds(group: OrderGroup, cfg: vscode.WorkspaceConfiguration): string[] {
    const order = getItemOrder(cfg)[group];
    const sorted = (ids: string[]) => sortByDnd(ids, order, x => x);
    switch (group) {
        case 'actions':
            return sorted(['incBuild', 'testBuild', ...visibleBuilds(getBuilds(cfg)).map(b => b.id)]);
        case 'tools':   return sorted(['guidTool', 'serialTool', 'binEdit', 'txtCmp']);
        case 'svnops':  return sorted(visibleActions(getVcsActions(cfg, 'svn')).map(a => a.id));
        case 'gitops':  return sorted(visibleActions(getVcsActions(cfg, 'git')).map(a => a.id));
        default:        return [];
    }
}

// ---------------------------------------------------------------------------
// Panel data provider
// ---------------------------------------------------------------------------

const ITEM_DND_MIME = 'application/vnd.code.tree.biosbuildassistant-items';

interface DndPayload {
    group: string;
    ids: string[];
}

// The five top-level groups. The objects must be reused: TreeView.reveal() matches by identity,
// so a fresh { kind:'group', id } on every getChildren makes "expand all" fail silently.
const PANEL_GROUPS = ['version', 'actions', 'svnops', 'gitops', 'tools'] as const;
const GROUP_ELEMENTS: ElementKind[] = PANEL_GROUPS.map(id => ({ kind: 'group', id }));

function groupElement(id: string): ElementKind | undefined {
    return GROUP_ELEMENTS.find(g => g.kind === 'group' && g.id === id);
}

export class BiosPanelProvider implements vscode.TreeDataProvider<ElementKind>,
                                       vscode.TreeDragAndDropController<ElementKind> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ElementKind | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    readonly dragMimeTypes = [ITEM_DND_MIME];
    readonly dropMimeTypes = [ITEM_DND_MIME, 'text/uri-list'];   // uri-list: files dragged in from the Explorer

    constructor(private readonly ctx: vscode.ExtensionContext) { }

    refresh() { this._onDidChangeTreeData.fire(); }

    // Used by the one-click collapse: mark every group Collapsed so VS Code redraws them shut
    private allCollapsed = false;
    forceCollapse(collapsed: boolean) {
        if (this.allCollapsed === collapsed) return;
        this.allCollapsed = collapsed;
        this.refresh();
    }
    // Expanding a group by hand only clears the flag; a refresh would redraw everyone else too
    clearCollapsedFlag() { this.allCollapsed = false; }
    get collapsingAll() { return this.allCollapsed; }

    private dndOf(e: ElementKind): { id: string; group: string } | undefined {
        if (e.kind === 'action' && e.dndGroup) return { id: e.id, group: e.dndGroup };
        if (e.kind === 'build' && e.dndGroup) return { id: e.target.id, group: e.dndGroup };
        if (e.kind === 'vcs') return { id: e.action.id, group: vcsGroupOf(e.tool) };
        if (e.kind === 'info' && e.dndId && e.dndGroup) return { id: e.dndId, group: e.dndGroup };
        return undefined;
    }

    handleDrag(source: readonly ElementKind[], dataTransfer: vscode.DataTransfer): void {
        // Only items from one shared parent group can be dragged together.
        let group: string | undefined;
        const ids: string[] = [];
        for (const e of source) {
            const d = this.dndOf(e);
            if (!d) continue;
            if (group === undefined) group = d.group;
            if (d.group !== group) continue;
            ids.push(d.id);
        }
        if (group !== undefined && ids.length > 0) {
            dataTransfer.set(ITEM_DND_MIME, new vscode.DataTransferItem({ group, ids }));
        }
    }

    async handleDrop(target: ElementKind | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        const payload = dataTransfer.get(ITEM_DND_MIME)?.value as DndPayload | undefined;

        // Files dropped in from outside (no internal drag marker) open in the Binary Editor, at most two, A and B
        if (!payload) {
            const raw = dataTransfer.get('text/uri-list');
            const text = raw ? String(raw.value ?? '') : '';
            const uris = text.split(/\r?\n/)
                .map(s => s.trim())
                .filter(s => s && s !== 'undefined' && !s.startsWith('#'))
                .map(s => { try { return vscode.Uri.parse(s); } catch { return undefined; } })
                .filter((u): u is vscode.Uri => !!u && (u.scheme === 'file' || u.scheme === 'vscode-remote'));
            if (uris.length) {
                await openBinaryEditor(this.ctx, uris.slice(0, 2));
                return;
            }
            return;
        }
        if (!Array.isArray(payload.ids) || payload.ids.length === 0) return;

        // Resolve the drop target group; dropping onto a group node appends.
        let targetGroup: string | undefined;
        let beforeId: string | undefined;
        if (target) {
            if (target.kind === 'group') {
                targetGroup = target.id;
            } else {
                const d = this.dndOf(target);
                if (d) { targetGroup = d.group; beforeId = d.id; }
            }
        }
        if (!targetGroup || targetGroup !== payload.group) return;

        if (payload.group === 'version') {
            await this.reorderVersionFields(payload.ids, beforeId);
        } else {
            await this.reorderGroup(payload.group as OrderGroup, payload.ids, beforeId);
        }
    }

    private async reorderVersionFields(ids: string[], beforeId?: string): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('biosBuddy');
        const list = getInfoFields(cfg);
        const moved = new Set(ids);
        const dragged = list.filter(e => moved.has(e.key));
        if (dragged.length === 0) return;
        const remaining = list.filter(e => !moved.has(e.key));
        let at = remaining.length;
        if (beforeId) {
            const idx = remaining.findIndex(e => e.key === beforeId);
            if (idx >= 0) at = idx;
        }
        remaining.splice(at, 0, ...dragged);
        if (await saveInfoFields(cfg, remaining)) this.refresh();
    }

    private async reorderGroup(group: OrderGroup, ids: string[], beforeId?: string): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('biosBuddy');
        const order = getItemOrder(cfg);
        // Start from the tree's current order so ids the table has never seen (just-added actions or builds) can still be dragged
        const shown = displayedIds(group, cfg);
        const base = order[group].filter(k => shown.includes(k));
        for (const sid of shown) if (!base.includes(sid)) base.push(sid);

        const moved = new Set(ids);
        const dragged = base.filter(k => moved.has(k));
        if (dragged.length === 0) return;
        const remaining = base.filter(k => !moved.has(k));
        let at = remaining.length;
        if (beforeId) {
            const idx = remaining.indexOf(beforeId);
            if (idx >= 0) at = idx;
        }
        remaining.splice(at, 0, ...dragged);
        order[group] = remaining;
        if (writeWorkspaceSetting('biosBuddy.itemOrder', order)) this.refresh();
    }

    getTreeItem(element: ElementKind): vscode.TreeItem {
        switch (element.kind) {
            case 'root': {
                // Should never happen; root has no tree item
                return new vscode.TreeItem('');
            }
            case 'group': {
                // Titles are text plus an icon only: an emoji inside the label pushes the text right,
                // which knocks the title out of line with the child rows.
                const map: Record<string, { label: string; icon: string }> = {
                    version: { label: 'BIOS Current Info', icon: 'symbol-numeric' },
                    actions: { label: 'BIOS Build Action', icon: 'zap' },
                    svnops:  { label: 'SVN Operation',     icon: '' },
                    gitops:  { label: 'Git Operation',     icon: '' },
                    tools:   { label: 'Tools',             icon: 'tools' },
                };
                const meta = map[element.id] ?? { label: element.id, icon: 'circle-filled' };
                const item = new vscode.TreeItem(
                    meta.label,
                    this.allCollapsed
                        ? vscode.TreeItemCollapsibleState.Collapsed
                        : vscode.TreeItemCollapsibleState.Expanded,
                );
                // A fixed id is what lets VS Code keep the expand state across refreshes caused by other groups
                item.id = 'biosGroup:' + element.id;
                if (meta.icon) item.iconPath = treeIcon(meta.icon);
                if (element.id === 'version') {
                    item.contextValue = 'versionGroup';
                    item.tooltip = 'The BIOS version file and the fields shown from it — hover the title for + (add field) and ↺ (reset fields)';
                }
                if (element.id === 'actions') {
                    item.contextValue = 'actionsGroup';
                    item.tooltip = 'Formal / Test only rewrite the version fields; builds run a script. '
                        + 'Hover this title for + (add another build) — or right-click a row → Add Build. '
                        + '↺ puts the default Build row back';
                }
                if (element.id === 'svnops' || element.id === 'gitops') {
                    // Monochrome: white on dark themes, dark grey on light ones (two files, same shape)
                    const base = element.id === 'svnops' ? 'svn' : 'git';
                    const dir = path.join(this.ctx.extensionUri.fsPath, 'media', 'icons');
                    item.iconPath = {
                        light: vscode.Uri.file(path.join(dir, `${base}-light.svg`)),
                        dark: vscode.Uri.file(path.join(dir, `${base}-dark.svg`)),
                    };
                    item.contextValue = element.id === 'svnops' ? 'svnGroup' : 'gitGroup';
                    item.tooltip = element.id === 'svnops'
                        ? 'SVN actions — hover the title for + (add) and ↺ (restore defaults)'
                        : 'Git actions — hover the title for + (add) and ↺ (restore defaults)';
                }
                const stampedGroup = item as vscode.TreeItem & { groupId?: string };
                stampedGroup.groupId = element.id;
                return item;
            }
            case 'info': {
                const item = new vscode.TreeItem(
                    element.label,
                    vscode.TreeItemCollapsibleState.None,
                );
                if (element.desc) item.description = element.desc;
                if (element.tooltip) item.tooltip = element.tooltip;
                if (element.cfgKey) item.contextValue = 'infoField';
                else if (element.dndGroup === 'paths') {
                    // This row is the old "Key File Path → BIOS Version File", now living under Current Info
                    item.contextValue = 'pathDefFile';
                    item.command = { command: 'biosBuddy.configureDefFile', title: 'Configure BIOS Version File' };
                }

                let iconName: string | undefined;
                if (element.icon) {
                    iconName = element.icon;
                } else if (element.tint) {
                    iconName = element.tint === 'error' ? 'error' : 'warning';
                } else if (element.dndGroup === 'paths') {
                    iconName = 'file-code';
                } else if (element.dndGroup === 'version') {
                    iconName = 'symbol-field';
                } else if (element.cfgKey) {
                    iconName = fieldIcon(element.cfgKey);
                }
                if (iconName) {
                    const colorId = element.tint === 'error'
                        ? 'problemsErrorIcon.foreground'
                        : (element.tint === 'warning' ? 'problemsWarningIcon.foreground' : undefined);
                    item.iconPath = treeIcon(iconName, colorId);
                }
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
                const cfg = vscode.workspace.getConfiguration('biosBuddy');
                const labels = {
                    incBuild:      getActionLabel(cfg, 'formalBuild'),
                    testBuild:     getActionLabel(cfg, 'testBuild'),
                };
                const meta = {
                    incBuild:      { label: labels.incBuild,      icon: 'repo-push',  tip: 'Formal BIOS: bump MINOR (+MAJOR on overflow) and refresh the date/build fields. Version only — nothing is compiled. Click a build row when you want to build.' },
                    testBuild:     { label: labels.testBuild,     icon: 'beaker',     tip: 'Test BIOS: Build ID W -> T01 (or T02, T03...) and refresh the date fields. Version only — nothing is compiled. Click a build row when you want to build.' },
                    binEdit:       { label: 'Binary Editor',       icon: 'file-binary', tip: 'Open the built-in binary / HEX editor (dual pane, compare, padding resize) — you can also drop files here: 2 files → A + B, 1 file → A' },
                    serialTool:    { label: 'COM Assistant', icon: 'plug',     tip: 'Open the COM / UART port console: raw bytes, HEX view, timestamps, per-line endings — connect, send and watch BIOS serial output in one window' },
                    guidTool:      { label: 'GUID Assistant', icon: 'key',     tip: 'Generate GUIDs (v4 / v1) and convert any GUID between D / N / B / P, C struct, UEFI #define, EFI byte array, raw bytes and Base64 — paste one form, copy any of the others' },
                    txtCmp:        { label: 'Text Comparer', icon: 'diff',      tip: 'Compare two text files side by side (.def / .dsc / .txt / logs): real line alignment, character-level highlighting, ignore whitespace / case / blank lines, copy or save the result as a unified diff' },
                }[element.id];
                const item = new vscode.TreeItem(
                    meta.label,
                    vscode.TreeItemCollapsibleState.None,
                );
                const isConfigurableBuild = element.id === 'incBuild' || element.id === 'testBuild';
                item.contextValue = isConfigurableBuild ? 'actionWithConfig' : ('action' + element.id.charAt(0).toUpperCase() + element.id.slice(1));
                item.tooltip = meta.tip;
                item.iconPath = new vscode.ThemeIcon(meta.icon);
                const cmdMap: Record<string, string> = {
                    incBuild:      'biosBuddy.formalVersion',
                    testBuild:     'biosBuddy.testVersion',
                    binEdit:       'biosBuddy.binaryEditor',
                    serialTool:    'biosBuddy.serialConsole',
                    guidTool:      'biosBuddy.guidTool',
                    txtCmp:        'biosBuddy.textComparer',
                };
                const cmdId = cmdMap[element.id];
                if (cmdId) item.command = { command: cmdId, title: meta.label };
                // The inline gear receives this TreeItem, so its identity rides along instead of asking which version was clicked
                const stamped = item as vscode.TreeItem & { actionId?: string };
                stamped.actionId = element.id;

                return item;
            }
            case 'build': {
                // One row = one script. Click to run, gear to change the script, bin to remove it
                const t = element.target;
                const script = resolvePath(t.script);
                const missing = !script || !fs.existsSync(script);
                // The name is always derived from the script file, so swapping the .bat renames it at once (unless renamed by hand)
                const label = displayLabel(t);
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                // The name usually is the script name, so do not repeat it; only a rename or extra arguments need a description
                const base = script ? path.basename(script) : '';
                const stem = base.replace(/\.(bat|cmd|ps1)$/i, '');
                const detail = [stem && stem !== label ? base : '', t.args || ''].filter(Boolean).join('  ');
                item.description = !script ? '(no script)' : missing ? 'script not found' : (detail || undefined);
                item.tooltip = [
                    label,
                    script ? `  ${script}` : '  no build script configured yet — click the gear',
                    ...(t.args ? [`  args: ${t.args}`] : []),
                    missing ? '  ⚠ script not found' : '  click this row to run it in a terminal',
                ].join('\n');
                item.iconPath = missing
                    ? treeIcon('error', 'problemsErrorIcon.foreground')
                    : new vscode.ThemeIcon(t.custom ? 'play' : 'terminal');
                item.contextValue = t.custom ? 'buildCustom' : 'buildPreset';
                item.command = {
                    command: 'biosBuddy.runBuildTarget',
                    title: label,
                    arguments: [{ target: t }],
                };
                const stamped = item as vscode.TreeItem & { target?: BuildTarget };
                stamped.target = t;
                return item;
            }
            case 'buildHidden': {
                const t = element.target;
                const label = displayLabel(t);
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                item.description = 'removed';
                item.tooltip = [
                    label,
                    'Removed from the panel.',
                    'Click this row (or use "Put Back") to show it again — its script is still the one in buildBat.',
                ].join('\n');
                item.iconPath = new vscode.ThemeIcon('history');
                item.contextValue = 'buildHidden';
                item.command = {
                    command: 'biosBuddy.restoreBuild',
                    title: 'Put back ' + label,
                    arguments: [{ target: t }],
                };
                return item;
            }
            case 'vcs': {
                const cfg = vscode.workspace.getConfiguration('biosBuddy');
                const defaults = defaultActions(element.tool, vcsDefaultLabels(cfg, element.tool));
                const a = element.action;
                const item = new vscode.TreeItem(a.label, vscode.TreeItemCollapsibleState.None);
                const changed = isModified(a, defaults);
                item.description = a.custom ? 'custom' : (changed ? 'modified' : undefined);
                item.tooltip = [
                    a.label,
                    ...a.steps.map(s => '  ' + s),
                    a.builtin
                        ? 'built-in flow (the lines above are a preview) · runs in the terminal'
                        : 'runs in the terminal',
                ].join('\n');
                // Presets keep the shared icons (Update=sync, Clean=clear-all); custom actions get a play icon
                const icon = a.custom
                    ? 'play'
                    : (a.builtin === 'svnClean' || a.builtin === 'gitResetClean' ? 'clear-all'
                        : (a.builtin ? 'sync' : 'play'));
                item.iconPath = new vscode.ThemeIcon(icon);
                item.contextValue = a.custom
                    ? `vcsCustomAction.${element.tool}`
                    : (changed ? `vcsActionModified.${element.tool}` : `vcsAction.${element.tool}`);
                // Clicking the row runs it; inline buttons receive this TreeItem, so the identity is attached here
                item.command = {
                    command: 'biosBuddy.runVcsAction',
                    title: a.label,
                    arguments: [{ tool: element.tool, action: a }],
                };
                const stamped = item as vscode.TreeItem & { tool?: VcsTool; action?: VcsAction };
                stamped.tool = element.tool;
                stamped.action = a;
                return item;
            }
            case 'vcsHidden': {
                // A removed preset: grey placeholder row, one click puts it back
                const a = element.action;
                const item = new vscode.TreeItem(a.label, vscode.TreeItemCollapsibleState.None);
                item.description = 'removed';
                item.tooltip = [
                    a.label,
                    'Removed from the panel.',
                    'Click this row (or use "Put Back") to show it again with its original command.',
                ].join('\n');
                item.iconPath = new vscode.ThemeIcon('history');
                item.contextValue = `vcsHidden.${element.tool}`;
                item.command = {
                    command: 'biosBuddy.restoreVcsAction',
                    title: 'Put back ' + a.label,
                    arguments: [{ tool: element.tool, action: a }],
                };
                return item;
            }
        }
    }

    // Used by TreeView.reveal(): it walks the parent chain to know which group to expand.
    // Top-level groups simply return undefined.
    getParent(element: ElementKind): ElementKind | undefined {
        switch (element.kind) {
            case 'info':   return groupElement('version');
            case 'action':
            case 'build':
            case 'buildHidden':
                return groupElement('actions');
            case 'vcs':
            case 'vcsHidden':
                return groupElement(element.tool === 'svn' ? 'svnops' : 'gitops');
            default:
                return undefined;
        }
    }

    getChildren(element?: ElementKind): ElementKind[] {
        try {
            if (!element) {
                // Top level: five groups (the version-file column now lives inside Current Info)
                // Note: return the same object instances (see GROUP_ELEMENTS); never build new objects here.
                return GROUP_ELEMENTS.slice();
            }
            if (element.kind !== 'group') {
                // Leaf info/action nodes have no children
                return [];
            }

            const cfg = vscode.workspace.getConfiguration('biosBuddy');

            if (element.id === 'version') {
                const defPath = resolvePath(cfg.get<string>('defFile', ''));
                const defExists = !!defPath && fs.existsSync(defPath);

                // The first row is the version file reference (the old standalone Key File Path).
                // Only the file name goes in the row, the full path in the tooltip — otherwise one row spans the whole sidebar
                const out: ElementKind[] = [{
                    kind: 'info',
                    label: 'BIOS Version File',
                    desc: defPath ? (defExists ? path.basename(defPath) : 'not found: ' + path.basename(defPath)) : '(not configured)',
                    tooltip: defPath
                        ? `${defPath}\n${defExists ? 'Click to open · gear to pick another file' : 'File is missing — click to pick another file'}`
                        : 'No BIOS version file yet — click this row (or the gear) to pick BiosVersion.def',
                    filePath: defExists ? defPath : undefined,
                    dndGroup: 'paths',
                    icon: 'file-code',
                    tint: defExists ? undefined : 'error',
                }];

                if (!defPath || !defExists) return out;   // The red row is clickable to pick or change the file

                let fields: ParsedField[];
                let raw = '';
                try {
                    raw = readDefFile(defPath);
                    fields = parseConfigFields(raw);
                } catch (e) {
                    out.push({ kind: 'info', label: 'Failed to read file', desc: (e as Error).message, tint: 'error' });
                    return out;
                }

                if (fields.length === 0) {
                    out.push({
                        kind: 'info',
                        label: 'No "Config" fields parsed',
                        desc: `${raw.split(/\r?\n/).length} lines`,
                        tooltip: defPath,
                        tint: 'warning',
                    });
                    return out;
                }

                for (const entry of getInfoFields(cfg)) {
                    const f = fields.find(x => x.key === entry.key);
                    if (!f) continue;
                    const v = stripValue(f.value);
                    if (!v) continue;
                    // Warn when the same key appears twice in the def file (one under #ifdef, one under #else),
                    // so nobody assumes only one copy changed
                    const copies = fields.filter(x => x.key === entry.key).length;
                    out.push({
                        kind: 'info', label: entry.key, desc: v,
                        cfgKey: entry.key, filePath: defPath, line: f.lineIndex,
                        dndId: entry.key, dndGroup: 'version',
                        tooltip: copies > 1
                            ? `${defPath}\n${copies} copies in the file (#ifdef branches) — every copy is updated`
                            : undefined,
                    });
                }
                if (out.length === 1) {
                    out.push({ kind: 'info', label: 'No fields shown — click + to add or the reset button on the group title', tooltip: defPath, tint: 'warning' });
                }
                return out;
            }

            if (element.id === 'actions') {
                // The first two rows only bump versions; the rest are build rows that run a script
                const items: ElementKind[] = [
                    { kind: 'action', id: 'incBuild',  dndGroup: 'actions' },
                    { kind: 'action', id: 'testBuild', dndGroup: 'actions' },
                ];
                const builds = getBuilds(cfg);
                for (const target of visibleBuilds(builds)) {
                    items.push({ kind: 'build', target, dndGroup: 'actions' });
                }
                const sorted = sortByDnd(items, getItemOrder(cfg).actions,
                    x => x.kind === 'build' ? x.target.id : (x.kind === 'action' ? x.id : undefined));
                // Removed preset builds sit at the end; one click brings them back
                return sorted.concat(hiddenBuilds(builds).map(target => ({ kind: 'buildHidden', target } as ElementKind)));
            }

            if (element.id === 'svnops' || element.id === 'gitops') {
                const tool: VcsTool = element.id === 'svnops' ? 'svn' : 'git';
                const all = getVcsActions(cfg, tool);
                let items: ElementKind[] = visibleActions(all)
                    .map(action => ({ kind: 'vcs', tool, action } as ElementKind));
                if (items.length === 0) {
                    items = [{
                        kind: 'info',
                        label: tool === 'svn' ? 'No SVN actions — click + above' : 'No Git actions — click + above',
                        icon: 'info',
                    }];
                } else {
                    items = sortByDnd(items, getItemOrder(cfg)[vcsGroupOf(tool)],
                        x => x.kind === 'vcs' ? x.action.id : undefined);
                }
                // Removed presets sit at the end; one click brings them back
                return items.concat(hiddenActions(all).map(action => ({ kind: 'vcsHidden', tool, action } as ElementKind)));
            }

            if (element.id === 'tools') {
                const items: ElementKind[] = [
                    { kind: 'action', id: 'guidTool',   dndGroup: 'tools' },
                    { kind: 'action', id: 'serialTool', dndGroup: 'tools' },
                    { kind: 'action', id: 'binEdit',    dndGroup: 'tools' },
                    { kind: 'action', id: 'txtCmp',     dndGroup: 'tools' },
                ];
                return sortByDnd(items, getItemOrder(cfg).tools, x => x.kind === 'action' ? x.id : undefined);
            }

            return [];
        } catch (e) {
            vscode.window.showErrorMessage('BIOS Buddy panel error: ' + (e as Error).message);
            return [{ kind: 'info', label: 'Error', desc: (e as Error).message, tint: 'error' }];
        }
    }
}

// ---------------------------------------------------------------------------
// SVN / Git actions: run, add, edit, remove, restore defaults
// ---------------------------------------------------------------------------

function refreshPanel(): void {
    try { panelProvider?.refresh(); } catch { /* not activated yet */ }
}

function vcsLabelOf(tool: VcsTool): string {
    return tool === 'svn' ? 'SVN' : 'Git';
}

function vcsToolOfArg(arg: unknown): VcsTool | undefined {
    const o = arg as { tool?: VcsTool; groupId?: string } | undefined;
    if (o?.tool === 'svn' || o?.tool === 'git') return o.tool;
    if (o?.groupId === 'svnops') return 'svn';
    if (o?.groupId === 'gitops') return 'git';
    return undefined;
}

export async function runVcsAction(arg?: unknown, only?: VcsTool): Promise<void> {
    let target = vcsTargetOf(arg);

    // Invoked from the palette with no argument: list them and let the user pick (run SVN / run Git only list their own group)
    if (!target) {
        const cfg = vscode.workspace.getConfiguration('biosBuddy');
        const tools: VcsTool[] = only ? [only] : ['svn', 'git'];
        const items = tools.flatMap(tool =>
            getVcsActions(cfg, tool).map(a => ({
                label: a.label,
                description: vcsLabelOf(tool),
                detail: a.steps.join('  ·  '),
                tool,
                action: a,
            })));
        const picked = await vscode.window.showQuickPick(items, {
            title: only ? `Run a ${vcsLabelOf(only)} action` : 'Run an SVN / Git action',
            placeHolder: 'Pick an action to run',
            ignoreFocusOut: true,
        });
        if (!picked) return;
        target = { tool: picked.tool, action: picked.action };
    }

    const { tool, action } = target;

    // Unmodified preset → the built-in flow (clean has to diff, preview, delete and verify, which one command cannot do)
    switch (action.builtin) {
        case 'svnUpdate': return svnUpdate();
        case 'svnClean': {
            // Clean deletes untracked files in .vscode, settings.json included,
            // so snapshot first and restore afterwards — nobody has to reconfigure.
            mirrorOwnedSettings();
            snapshotDotVscode();
            await svnClean();
            watchDotVscode();
            return;
        }
        case 'gitUpdate': return gitUpdate();
        case 'gitResetClean': {
            mirrorOwnedSettings();
            snapshotDotVscode();
            await gitResetClean();
            watchDotVscode();
            return;
        }
        default: break;
    }

    if (!action.steps.length) {
        vscode.window.showErrorMessage(`BIOS Buddy: "${action.label}" has no command.`);
        return;
    }

    const root = await vcsRootFor(tool);
    if (!root) {
        vscode.window.showErrorMessage(
            `BIOS Buddy: "${workspaceRootOrEmpty()}" is not inside a ${vcsLabelOf(tool)} working copy, so "${action.label}" has nothing to run against.`);
        return;
    }
    // Always through a terminal: update / pull may ask for credentials or need conflict resolution, and only a terminal can do that
    const steps = action.steps.map(s => expandStep(s, root));
    runStepsInTerminal(tool, action.label, root, steps);
}

function workspaceRootOrEmpty(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

/** Palette entry point: resolve the action in force by id and run it (a user-edited one runs as edited) */
async function runVcsActionById(tool: VcsTool, id: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const action = findAction(getVcsActions(cfg, tool), id)
        ?? findAction(defaultActions(tool, vcsDefaultLabels(cfg, tool)), id);
    if (!action) {
        vscode.window.showErrorMessage(`BIOS Buddy: "${id}" no longer exists in the ${vcsLabelOf(tool)} actions.`);
        return;
    }
    return runVcsAction({ tool, action });
}

async function pickVcsTool(title: string): Promise<VcsTool | undefined> {
    const picked = await vscode.window.showQuickPick([
        { label: 'SVN Operation', value: 'svn' as VcsTool },
        { label: 'Git Operation', value: 'git' as VcsTool },
    ], { title, placeHolder: 'Which group?', ignoreFocusOut: true });
    return picked?.value;
}

export async function addVcsAction(arg?: unknown): Promise<void> {
    const tool = vcsToolOfArg(arg) ?? await pickVcsTool('Add an action to…');
    if (!tool) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getVcsActions(cfg, tool);

    const name = await vscode.window.showInputBox({
        title: `Add ${vcsLabelOf(tool)} action`,
        prompt: 'Name shown in the panel',
        placeHolder: tool === 'svn' ? 'e.g. SVN Status' : 'e.g. Git Log',
        ignoreFocusOut: true,
    });
    if (name === undefined) return;
    if (!name.trim()) return;

    const text = await vscode.window.showInputBox({
        title: `Add ${vcsLabelOf(tool)} action — command`,
        prompt: 'Command(s): separate with &&   ·   {root} = working copy / repo root',
        placeHolder: tool === 'svn' ? 'svn status --no-ignore' : 'git log --oneline -10',
        ignoreFocusOut: true,
    });
    if (text === undefined) return;
    const steps = splitSteps(text);
    if (!steps.length) {
        vscode.window.showErrorMessage('BIOS Buddy: no command entered, nothing added.');
        return;
    }

    list.push({
        id: makeCustomId(tool, list),
        label: name.trim(),
        steps,
        custom: true,
    });
    if (saveVcsActions(tool, list)) refreshPanel();
}

export async function editVcsAction(arg?: unknown): Promise<void> {
    const target = vcsTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getVcsActions(cfg, target.tool);
    const defaults = defaultActions(target.tool, vcsDefaultLabels(cfg, target.tool));
    const cur = findAction(list, target.action.id) ?? target.action;

    const text = await vscode.window.showInputBox({
        title: `Command — ${cur.label}`,
        prompt: 'Separate commands with &&   ·   {root} = working copy / repo root   ·   keep it identical to restore the built-in flow',
        value: joinSteps(cur.steps),
        ignoreFocusOut: true,
    });
    if (text === undefined) return;
    const steps = splitSteps(text);
    if (!steps.length) {
        vscode.window.showErrorMessage('BIOS Buddy: the command cannot be empty. Use "Restore default" instead.');
        return;
    }

    const next = withSteps(cur, steps, defaults);
    const idx = list.findIndex(a => a.id === cur.id);
    if (idx < 0) list.push(next); else list[idx] = next;
    if (saveVcsActions(target.tool, list)) refreshPanel();
}

async function renameVcsAction(arg?: unknown): Promise<void> {
    const target = vcsTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getVcsActions(cfg, target.tool);
    const cur = findAction(list, target.action.id) ?? target.action;

    const name = await vscode.window.showInputBox({
        title: 'Rename action',
        prompt: 'Name shown in the panel',
        value: cur.label,
        ignoreFocusOut: true,
    });
    if (name === undefined || !name.trim()) return;

    const idx = list.findIndex(a => a.id === cur.id);
    const next = { ...cur, label: name.trim() };
    if (idx < 0) list.push(next); else list[idx] = next;
    if (saveVcsActions(target.tool, list)) refreshPanel();
}

async function resetVcsAction(arg?: unknown): Promise<void> {
    const target = vcsTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getVcsActions(cfg, target.tool);
    const defaults = defaultActions(target.tool, vcsDefaultLabels(cfg, target.tool));
    const d = findAction(defaults, target.action.id);
    if (!d) return;

    const idx = list.findIndex(a => a.id === target.action.id);
    if (idx < 0) list.push({ ...d }); else list[idx] = { ...d };
    if (saveVcsActions(target.tool, list)) {
        refreshPanel();
        vscode.window.setStatusBarMessage(`BIOS Buddy: "${d.label}" restored to default`, 3000);
    }
}

export async function deleteVcsAction(arg?: unknown): Promise<void> {
    const target = vcsTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getVcsActions(cfg, target.tool);
    const cur = findAction(list, target.action.id);
    if (!cur) return;

    const isPreset = !cur.custom;
    const pick = await vscode.window.showWarningMessage(
        `Remove "${cur.label}" from ${vcsLabelOf(target.tool)} actions?`,
        {
            modal: true,
            detail: isPreset
                ? 'This one is a preset, so it is only hidden: a grey "removed" row stays at the bottom of the group and puts it back with one click. No file and no repository change.'
                : 'Only the panel entry is removed — no file and no repository change.',
        },
        'Remove',
    );
    if (pick !== 'Remove') return;

    const next = removeAction(list, cur.id);
    if (saveVcsActions(target.tool, next)) {
        // Order table: drop custom actions when they are deleted, keep presets so they return to their old slot
        if (cur.custom) {
            const order = getItemOrder(cfg);
            const g = vcsGroupOf(target.tool);
            order[g] = order[g].filter(id => id !== cur.id);
            writeWorkspaceSetting('biosBuddy.itemOrder', order);
        }
        refreshPanel();
        vscode.window.setStatusBarMessage(
            isPreset
                ? `BIOS Buddy: "${cur.label}" removed — click the grey row to put it back`
                : `BIOS Buddy: "${cur.label}" removed`,
            4000);
    }
}

/** Put back a preset that was removed, or that vanished entirely from older settings */
export async function restoreVcsAction(arg?: unknown): Promise<void> {
    const target = vcsTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getVcsActions(cfg, target.tool);
    const defaults = defaultActions(target.tool, vcsDefaultLabels(cfg, target.tool));
    const id = target.action.id;

    let next: VcsAction[];
    if (findAction(list, id)) {
        next = restoreAction(list, id);
    } else {
        const d = findAction(defaults, id);
        if (!d) return;                                  // Not a preset and already gone: nothing to restore
        next = insertPreset(list, d, target.tool);
    }
    if (!saveVcsActions(target.tool, next)) return;

    // If the id was dropped from the order table, re-insert it where the presets belong
    const order = getItemOrder(cfg);
    const g = vcsGroupOf(target.tool);
    if (!order[g].includes(id)) {
        const presets = presetIds(target.tool);
        const mine = presets.indexOf(id);
        const at = order[g].findIndex(x => presets.indexOf(x) > mine && mine >= 0);
        order[g] = [...order[g]];
        order[g].splice(at < 0 ? order[g].length : at, 0, id);
        writeWorkspaceSetting('biosBuddy.itemOrder', order);
    }
    refreshPanel();
    const label = findAction(next, id)?.label ?? id;
    vscode.window.setStatusBarMessage(`BIOS Buddy: "${label}" is back`, 3000);
}

export async function restoreVcsDefaults(arg?: unknown): Promise<void> {
    const tool = vcsToolOfArg(arg) ?? await pickVcsTool('Restore defaults for…');
    if (!tool) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const defaults = defaultActions(tool, vcsDefaultLabels(cfg, tool));

    const pick = await vscode.window.showWarningMessage(
        `Restore the default ${vcsLabelOf(tool)} actions?`,
        {
            modal: true,
            detail: 'Custom actions in this group are removed and the two presets get their original commands back:\n'
                + defaults.map(a => `  ${a.label}`).join('\n'),
        },
        'Restore',
    );
    if (pick !== 'Restore') return;

    // Delete the setting outright instead of writing a default, so future default changes still reach it
    const ok = removeWorkspaceSetting(`biosBuddy.${vcsSettingKey(tool)}`);
    const order = getItemOrder(cfg);
    order[vcsGroupOf(tool)] = [...DEFAULT_ITEM_ORDER[vcsGroupOf(tool)]];
    writeWorkspaceSetting('biosBuddy.itemOrder', order);
    if (ok) {
        refreshPanel();
        vscode.window.setStatusBarMessage(`BIOS Buddy: ${vcsLabelOf(tool)} actions restored to default`, 3000);
    }
}

// ---------------------------------------------------------------------------
// Build rows: run, add a row, change the script, remove
// ---------------------------------------------------------------------------

async function runBuildTarget(arg?: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    let target = buildTargetOf(arg);

    // Invoked from the palette with no argument: list every build row and let the user pick
    if (!target) {
        const items = visibleBuilds(getBuilds(cfg)).map(b => ({
            label: b.label,
            description: b.script ? path.basename(b.script) : '(no script)',
            detail: resolvePath(b.script) || undefined,
            target: b,
        }));
        const picked = await vscode.window.showQuickPick(items, {
            title: 'Run a build',
            placeHolder: 'Pick a build row',
            ignoreFocusOut: true,
        });
        if (!picked) return;
        target = picked.target;
    }
    await runBuild(target);
}

/** Pick a script file; paths inside the workspace are stored as ${workspaceFolder}/… */
async function pickBuildScript(title: string, current: string): Promise<string | undefined> {
    const existing = resolvePath(current);
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Build scripts': ['bat', 'cmd', 'ps1'], 'All files': ['*'] },
        defaultUri: existing ? vscode.Uri.file(path.dirname(existing)) : getConfigFolder('buildBat'),
        title,
    });
    if (!uris || uris.length === 0) return undefined;

    let rawPath = uris[0].fsPath;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws && rawPath.toLowerCase().startsWith(ws.toLowerCase())) {
        rawPath = '${workspaceFolder}' + rawPath.substring(ws.length);
    }
    return rawPath;
}

export async function configureBuildScript(arg?: unknown): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const target = buildTargetOf(arg) ?? presetBuild(cfg);
    const script = await pickBuildScript(`Build script — ${displayLabel(target)}`, target.script);
    if (!script) return;

    // The name follows the script: keep a manual rename, otherwise take the new .bat file name
    const renamed = target.renamed === true;
    const nextLabel = renamed && target.label.trim() ? target.label.trim() : scriptLabel(script);

    const list = getBuilds(cfg);
    if (!updateBuild({ script, label: nextLabel, renamed }, list, target.id)) return;
    refreshPanel();
    vscode.window.setStatusBarMessage(
        `BIOS Buddy: "${nextLabel}" → ${script}`,
        4000,
    );
}

/** Script candidates: the version file's folder, the current script's folder, the workspace root — that level only */
function scriptCandidates(cfg: vscode.WorkspaceConfiguration): string[] {
    const dirs: string[] = [];
    const def = resolvePath(cfg.get<string>('defFile', '') || '');
    if (def) dirs.push(path.dirname(def));
    const bat = resolvePath(cfg.get<string>('buildBat', '') || '');
    if (bat) dirs.push(path.dirname(bat));
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) dirs.push(ws);

    const out: string[] = [];
    for (const d of dirs) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isFile() || !/\.(bat|cmd|ps1)$/i.test(e.name)) continue;
            const full = path.join(d, e.name);
            if (!out.includes(full)) out.push(full);
        }
    }
    return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

/**
 * Pick a script: list what is around first (a BIOS project keeps its .bat next
 * to the def), so no system dialog is needed; Browse is there for anything else.
 */
async function pickBuildScriptForAdd(cfg: vscode.WorkspaceConfiguration): Promise<string | undefined> {
    type Item = vscode.QuickPickItem & { script?: string; browse?: boolean };
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const found = scriptCandidates(cfg);
    const items: Item[] = found.map(p => ({
        label: '$(file) ' + path.basename(p),
        description: ws && p.toLowerCase().startsWith(ws.toLowerCase()) ? p.substring(ws.length + 1) : p,
        script: p,
    }));
    items.push({ label: '$(folder-opened) Browse…', description: 'pick a script anywhere on disk', browse: true });

    const picked = await vscode.window.showQuickPick<Item>(items, {
        title: 'Add a build — pick its script',
        placeHolder: found.length
            ? `${found.length} script(s) next to your BIOS version file`
            : 'No .bat next to the version file — choose Browse…',
        ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    return picked.browse ? pickBuildScript('Add a build — pick its script', '') : picked.script;
}

export async function addBuild(): Promise<void> {
    try {
        const cfg = vscode.workspace.getConfiguration('biosBuddy');
        const script = await pickBuildScriptForAdd(cfg);
        if (!script) return;

        // Name it after the script — no input box, nothing pinned, so a later .bat swap renames it
        const name = scriptLabel(script);

        const list = getBuilds(cfg);
        const id = makeBuildId(list);
        list.push({ id, label: name, script, custom: true });
        if (!saveBuilds(list)) return;

        // Read it back after writing: say so when the setting did not land, instead of "clicked and nothing happened"
        if (!getBuilds(cfg).some(b => b.id === id)) {
            vscode.window.showErrorMessage(
                `BIOS Buddy: could not save the new build row to ${workspaceSettingsPath() ?? '(no workspace folder)'}. `
                + 'Check that the file is writable.',
            );
            return;
        }

        // Register the new row at the end of the order table; it can be dragged later
        const order = getItemOrder(cfg);
        if (!order.actions.includes(id)) {
            order.actions.push(id);
            writeWorkspaceSetting('biosBuddy.itemOrder', order);
        }
        refreshPanel();
        vscode.window.setStatusBarMessage(`BIOS Buddy: build "${name}" added`, 4000);
    } catch (e) {
        // Any thrown error has to surface, otherwise the UI just seems to ignore the click
        vscode.window.showErrorMessage(`BIOS Buddy: add build failed — ${(e as Error).message}`);
    }
}

export async function renameBuild(arg?: unknown): Promise<void> {
    const target = buildTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const stem = scriptLabel(resolvePath(target.script));

    const name = await vscode.window.showInputBox({
        title: 'Rename build',
        prompt: stem
            ? `Name shown in the panel — clear it (or type "${stem}") to follow the script name again`
            : 'Name shown in the panel',
        value: displayLabel(target),
        ignoreFocusOut: true,
    });
    if (name === undefined) return;

    // Show whatever was typed; empty or exactly the script name means "follow the .bat" again
    const trimmed = name.trim();
    const renamed = !!trimmed && trimmed !== stem;

    const list = getBuilds(cfg);
    if (!updateBuild({ label: renamed ? trimmed : stem, renamed }, list, target.id)) return;
    refreshPanel();
}

export async function setBuildArgs(arg?: unknown): Promise<void> {
    const target = buildTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');

    const args = await vscode.window.showInputBox({
        title: `Arguments — ${displayLabel(target)}`,
        prompt: 'Appended to the script command. Leave empty for none.',
        value: target.args ?? '',
        ignoreFocusOut: true,
    });
    if (args === undefined) return;

    const list = getBuilds(cfg);
    if (!updateBuild({ args: args.trim() }, list, target.id)) return;
    refreshPanel();
}

export async function deleteBuild(arg?: unknown): Promise<void> {
    const target = buildTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getBuilds(cfg);
    const cur = findBuild(list, target.id) ?? target;
    const isPreset = cur.id === PRESET_BUILD_ID;

    const pick = await vscode.window.showWarningMessage(
        `Remove the build row "${displayLabel(cur)}"?`,
        {
            modal: true,
            detail: isPreset
                ? 'This is the default build, so it is only hidden: a grey "removed" row stays at the bottom and puts it back with one click. The script setting is kept.'
                : 'Only the row is removed — the script file itself is untouched, and buildBat is not affected.',
        },
        'Remove',
    );
    if (pick !== 'Remove') return;

    if (!saveBuilds(removeBuild(list, cur.id))) return;
    if (!isPreset) {
        // Clear it from the order table too, so no junk ids stay behind in settings
        const order = getItemOrder(cfg);
        order.actions = order.actions.filter(id => id !== cur.id);
        writeWorkspaceSetting('biosBuddy.itemOrder', order);
    }
    refreshPanel();
    vscode.window.setStatusBarMessage(
        isPreset
            ? `BIOS Buddy: "${displayLabel(cur)}" removed — click the grey row to put it back`
            : `BIOS Buddy: "${displayLabel(cur)}" removed`,
        4000);
}

export async function restoreBuildTarget(arg?: unknown): Promise<void> {
    const target = buildTargetOf(arg);
    if (!target) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getBuilds(cfg);
    if (!saveBuilds(restoreBuild(list, target.id))) return;

    const order = getItemOrder(cfg);
    if (!order.actions.includes(target.id)) {
        order.actions.push(target.id);
        writeWorkspaceSetting('biosBuddy.itemOrder', order);
    }
    refreshPanel();
    vscode.window.setStatusBarMessage(`BIOS Buddy: "${displayLabel(target)}" is back`, 3000);
}

export async function restoreBuildDefaults(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const pick = await vscode.window.showWarningMessage(
        'Restore the default build rows?',
        {
            modal: true,
            detail: 'Self-added build rows are removed and the default build row comes back.\n'
                + 'The build script / arguments settings are kept as they are.',
        },
        'Restore',
    );
    if (pick !== 'Restore') return;

    removeWorkspaceSetting('biosBuddy.builds');
    const order = getItemOrder(cfg);
    order.actions = [...DEFAULT_ITEM_ORDER.actions];
    writeWorkspaceSetting('biosBuddy.itemOrder', order);
    refreshPanel();
    vscode.window.setStatusBarMessage('BIOS Buddy: build rows restored to default', 3000);
}

/**
 * Title-bar reset. Dropping the saved order is enough: every group falls back to
 * DEFAULT_ITEM_ORDER, so Tools reads GUID Assistant → COM → Binary → Text again and each
 * group gets its preset rows first. Only the order is touched — hidden rows, renames and
 * self-added builds stay exactly as they are.
 */
export function resetItemOrder(): void {
    if (!removeWorkspaceSetting('biosBuddy.itemOrder')) return;
    refreshPanel();
    vscode.window.setStatusBarMessage('BIOS Buddy: default order restored', 3000);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

let panelProvider: BiosPanelProvider;

// ---------------------------------------------------------------------------
// Sidebar one-click collapse / expand
// ---------------------------------------------------------------------------
const PANEL_VIEW_ID = 'biosBuddy.panel';
const TOP_GROUPS = PANEL_GROUPS;

let panelTree: vscode.TreeView<ElementKind> | undefined;
// Which groups are open right now (kept in sync with clicks); the title-bar button uses it to pick collapse or expand
const openGroups = new Set<string>(TOP_GROUPS);

function syncTreeToggleKey() {
    void vscode.commands.executeCommand('setContext', 'biosTreeOpen', openGroups.size > 0);
}

async function expandOneGroup(view: vscode.TreeView<ElementKind>, id: string): Promise<boolean> {
    const node = groupElement(id);
    if (!node) return false;
    try {
        // reveal + expand is the only official way to open a tree view; the node objects must be the same instances
        await view.reveal(node, { expand: true, select: false, focus: false });
        return true;
    } catch {
        return false;
    }
}

async function setGroupsExpanded(open: boolean) {
    if (!panelTree) return;
    if (open) {
        // Clear the "collapse everything" flag before expanding, or the redraw closes them again
        panelProvider.forceCollapse(false);
        await new Promise(resolve => setTimeout(resolve, 0));   // Let that redraw land first
        openGroups.clear();
        let failed = 0;
        for (const id of TOP_GROUPS) {
            let ok = await expandOneGroup(panelTree, id);
            if (!ok) {
                // The first attempt fails while the view is still showing or the sidebar is not ready — wait a frame and retry
                await new Promise(resolve => setTimeout(resolve, 60));
                ok = await expandOneGroup(panelTree, id);
            }
            if (ok) openGroups.add(id); else failed++;
        }
        // None of the five worked: clear the flags and redraw once so at least the icon matches reality
        if (failed === TOP_GROUPS.length) panelProvider.refresh();
    } else {
        openGroups.clear();
        // The tree view has no collapse API, so use VS Code's own Collapse All command
        try {
            await vscode.commands.executeCommand(`workbench.actions.treeView.${PANEL_VIEW_ID}.collapseAll`);
        } catch { /* Version differences — fall back to the provider approach below */ }
        panelProvider.forceCollapse(true);
    }
    syncTreeToggleKey();
}

// ---------------------------------------------------------------------------
// Rename migration: before 0.11.0 the extension was bios-build-assistant, with biosBuildAssistant.* commands and settings
// Move the old settings over to biosBuddy.* unchanged and delete the old keys — no reconfiguration needed.
// ---------------------------------------------------------------------------
const LEGACY_SECTION = 'biosBuildAssistant';
const CURRENT_SECTION = 'biosBuddy';

/** Workspace keys are edited in the file itself, which is the most reliable: what is written is what the user sees */
function migrateLegacyWorkspaceSettings(): void {
    const p = workspaceSettingsPath();
    if (!p || !fs.existsSync(p)) return;
    try {
        const raw = fs.readFileSync(p, 'utf-8').replace(/^\uFEFF/, '');
        if (!raw.trim()) return;
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (!obj || typeof obj !== 'object') return;
        let changed = false;
        for (const key of Object.keys(obj)) {
            if (!key.startsWith(LEGACY_SECTION + '.')) continue;
            const next = CURRENT_SECTION + key.slice(LEGACY_SECTION.length);
            if (obj[next] === undefined) obj[next] = obj[key];
            delete obj[key];
            changed = true;
        }
        if (changed) fs.writeFileSync(p, JSON.stringify(obj, null, 4) + '\n', 'utf-8');
    } catch { /* A failed migration must not block activation */ }
}

/** Global and multi-root folder-level keys of the same name go through the configuration API */
function migrateLegacyGlobalSettings(): void {
    try {
        const contributes = extCtx?.extension?.packageJSON?.contributes?.configuration;
        const blocks = Array.isArray(contributes) ? contributes : [contributes];
        const keys: string[] = [];
        for (const block of blocks) {
            const props = (block as { properties?: Record<string, unknown> } | undefined)?.properties;
            for (const key of Object.keys(props ?? {})) {
                if (key.startsWith(CURRENT_SECTION + '.')) keys.push(key);
            }
        }
        for (const key of keys) {
            const oldKey = LEGACY_SECTION + key.slice(CURRENT_SECTION.length);
            const from = vscode.workspace.getConfiguration().inspect(oldKey);
            if (!from) continue;
            const to = vscode.workspace.getConfiguration().inspect(key);
            const scopes: Array<[vscode.ConfigurationTarget, 'globalValue' | 'workspaceFolderValue']> = [
                [vscode.ConfigurationTarget.Global, 'globalValue'],
                [vscode.ConfigurationTarget.WorkspaceFolder, 'workspaceFolderValue'],
            ];
            for (const [target, field] of scopes) {
                const value = from[field];
                if (value === undefined) continue;
                const quiet = (p: Thenable<unknown>) => {
                    try { void Promise.resolve(p).catch(() => { /* An unregistered section refuses the write — ignore it */ }); }
                    catch { /* A synchronous throw is skipped the same way */ }
                };
                try {
                    if (to?.[field] === undefined) {
                        quiet(vscode.workspace.getConfiguration().update(key, value, target));
                    }
                    quiet(vscode.workspace.getConfiguration().update(oldKey, undefined, target));
                } catch { /* Skip a single key that fails */ }
            }
        }
    } catch { /* Same as above */ }
}

export function activate(context: vscode.ExtensionContext) {
    extCtx = context;

    // Migrate the old names first, then mirror, and only then restore what Clean deleted
    migrateLegacyWorkspaceSettings();
    migrateLegacyGlobalSettings();

    // Mirror the current settings first (even a first install needs a copy), then decide what to restore.
    // Scenario: Clean just deleted .vscode/settings.json and the window reloaded — restore it here,
    // so nobody has to pick the def / bat again.
    mirrorOwnedSettings();
    migrateAutoBuildLabel();
    const restored = restoreOwnedFromMirror();
    if (restored.length) {
        vscode.window.setStatusBarMessage(
            `BIOS Buddy: restored ${restored.length} setting(s) removed from .vscode/settings.json`,
            10000,
        );
    }

    panelProvider = new BiosPanelProvider(context);
    registerBinaryEditor(context);
    registerSerialConsole(context);
    registerTextCompare(context);
    registerGuidTool(context);

    context.subscriptions.push(
        panelTree = vscode.window.createTreeView(PANEL_VIEW_ID, {
            treeDataProvider: panelProvider,
            dragAndDropController: panelProvider,
            showCollapseAll: false,          // The built-in collapse-all duplicates our button, so turn it off
        }),
        vscode.commands.registerCommand('biosBuddy.expandAll',   () => setGroupsExpanded(true)),
        vscode.commands.registerCommand('biosBuddy.collapseAll', () => setGroupsExpanded(false)),
        vscode.commands.registerCommand('biosBuddy.formalVersion',   () => runFormalVersion()),
        vscode.commands.registerCommand('biosBuddy.testVersion',     () => runTestVersion()),
        vscode.commands.registerCommand('biosBuddy.runBuildTarget',  (arg?: unknown) => runBuildTarget(arg)),
        vscode.commands.registerCommand('biosBuddy.buildOnly',       () => runBuildTarget({ target: presetBuild(vscode.workspace.getConfiguration('biosBuddy')) })),
        vscode.commands.registerCommand('biosBuddy.addBuild',        () => addBuild()),
        vscode.commands.registerCommand('biosBuddy.configureBuildScript', (arg?: unknown) => configureBuildScript(arg)),
        vscode.commands.registerCommand('biosBuddy.renameBuild',     (arg?: unknown) => renameBuild(arg)),
        vscode.commands.registerCommand('biosBuddy.setBuildArgs',    (arg?: unknown) => setBuildArgs(arg)),
        vscode.commands.registerCommand('biosBuddy.deleteBuild',     (arg?: unknown) => deleteBuild(arg)),
        vscode.commands.registerCommand('biosBuddy.restoreBuild',    (arg?: unknown) => restoreBuildTarget(arg)),
        vscode.commands.registerCommand('biosBuddy.restoreBuildDefaults', () => restoreBuildDefaults()),
        vscode.commands.registerCommand('biosBuddy.reselectBuildFields', (mode?: 'formalBuildFields' | 'testBuildFields') => reselectBuildFields(mode)),
        vscode.commands.registerCommand('biosBuddy.svnUpdate',       () => runVcsActionById('svn', 'svnUpdate')),
        vscode.commands.registerCommand('biosBuddy.svnCleanRevert',  () => runVcsActionById('svn', 'svnCleanRevert')),
        vscode.commands.registerCommand('biosBuddy.gitUpdate',       () => runVcsActionById('git', 'gitUpdate')),
        vscode.commands.registerCommand('biosBuddy.gitResetClean',   () => runVcsActionById('git', 'gitResetClean')),
        // SVN and Git buttons are split per group so the tooltip reads "Edit SVN Command", not "Edit SVN / Git Command"
        vscode.commands.registerCommand('biosBuddy.runVcsAction',      (arg?: unknown) => runVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.runSvnAction',      (arg?: unknown) => runVcsAction(arg, 'svn')),
        vscode.commands.registerCommand('biosBuddy.runGitAction',      (arg?: unknown) => runVcsAction(arg, 'git')),
        vscode.commands.registerCommand('biosBuddy.addSvnAction',      (arg?: unknown) => addVcsAction(arg ?? { tool: 'svn' })),
        vscode.commands.registerCommand('biosBuddy.addGitAction',      (arg?: unknown) => addVcsAction(arg ?? { tool: 'git' })),
        vscode.commands.registerCommand('biosBuddy.editSvnAction',     (arg?: unknown) => editVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.editGitAction',     (arg?: unknown) => editVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.renameSvnAction',   (arg?: unknown) => renameVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.renameGitAction',   (arg?: unknown) => renameVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.resetVcsAction',    (arg?: unknown) => resetVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.deleteSvnAction',   (arg?: unknown) => deleteVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.deleteGitAction',   (arg?: unknown) => deleteVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.restoreSvnAction',  (arg?: unknown) => restoreVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.restoreGitAction',  (arg?: unknown) => restoreVcsAction(arg)),
        vscode.commands.registerCommand('biosBuddy.restoreSvnDefaults', (arg?: unknown) => restoreVcsDefaults(arg ?? { tool: 'svn' })),
        vscode.commands.registerCommand('biosBuddy.restoreGitDefaults', (arg?: unknown) => restoreVcsDefaults(arg ?? { tool: 'git' })),
        vscode.commands.registerCommand('biosBuddy.configurePaths',  () => configurePaths()),
        vscode.commands.registerCommand('biosBuddy.configureDefFile', () => configureDefFile()),
        vscode.commands.registerCommand('biosBuddy.configureBuildBat', (arg?: unknown) => configureBuildScript(arg)),
        vscode.commands.registerCommand('biosBuddy.addInfoField',    () => addInfoField()),
        vscode.commands.registerCommand('biosBuddy.resetInfoFields', () => resetInfoFields()),
        vscode.commands.registerCommand('biosBuddy.removeInfoField', (el?: ElementKind) => removeInfoField(el)),
        vscode.commands.registerCommand('biosBuddy.moveItemUp',   (el?: ElementKind) => moveItem(el, -1)),
        vscode.commands.registerCommand('biosBuddy.moveItemDown', (el?: ElementKind) => moveItem(el, 1)),
        vscode.commands.registerCommand('biosBuddy.refresh',          () => panelProvider.refresh()),
        vscode.commands.registerCommand('biosBuddy.resetOrder',       () => resetItemOrder()),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('biosBuddy')) panelProvider.refresh();
        }),
    );

    // Keep the collapse-all / expand-all button in sync with manual clicks
    if (panelTree) {
        const view = panelTree;
        context.subscriptions.push(
            view.onDidExpandElement(e => {
                if (e.element.kind !== 'group') return;
                openGroups.add(e.element.id);
                if (panelProvider.collapsingAll) panelProvider.clearCollapsedFlag();
                syncTreeToggleKey();
            }),
            view.onDidCollapseElement(e => {
                if (e.element.kind !== 'group') return;
                openGroups.delete(e.element.id);
                syncTreeToggleKey();
            }),
        );
    }
    syncTreeToggleKey();          // All five groups start expanded, so the button offers collapse-all
}

export function deactivate() {}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Formal BIOS: bump the version fields one step, no build. To compile, click a build row.
async function runFormalVersion() {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const defPath = resolvePath(cfg.get<string>('defFile', ''));

    if (!defPath) {
        vscode.window.showErrorMessage('BIOS Buddy: BIOS Version File is is not configured.');
        return;
    }
    if (!fs.existsSync(defPath)) {
        vscode.window.showErrorMessage(`BIOS Buddy: BIOS Version File is not found at:\n${defPath}`);
        return;
    }

    const raw = readDefFile(defPath);
    const fields = parseConfigFields(raw);
    if (fields.length === 0) {
        vscode.window.showWarningMessage('BIOS Buddy: no Config fields found in file.');
        return;
    }

    const majorField = fields.find(f => f.key === 'BIOS_VERSION_MAJOR');
    const minorField = fields.find(f => f.key === 'BIOS_VERSION_MINOR');
    if (!majorField || !minorField) {
        vscode.window.showErrorMessage('BIOS Buddy: BIOS_VERSION_MAJOR / BIOS_VERSION_MINOR not found.');
        return;
    }

    const curMajor = parseInt(stripValue(majorField.value), 10);
    const curMinor = parseInt(stripValue(minorField.value), 10);
    if (isNaN(curMajor) || isNaN(curMinor)) {
        vscode.window.showErrorMessage('BIOS Buddy: could not parse MAJOR/MINOR as integers.');
        return;
    }

    const newMinor = curMinor + 1;
    let newMajor = curMajor;
    const overflow = cfg.get<boolean>('incrementMajor', false);
    if (overflow && newMinor >= 100) {
        newMajor += 1;
    }

    const dateFmt = cfg.get<string>('dateFormat', 'MM/DD/YYYY') || 'MM/DD/YYYY';
    const newDate = formatDate(new Date(), dateFmt);

    const picked = await pickFieldsForBuild(
        cfg,
        'formalBuildFields',
        fields,
        'Select fields for Formal BIOS Build',
        DEFAULT_FORMAL_BUILD_FIELDS,
        false,
    );
    const changes = computeAllChanges(fields, curMajor, curMinor, newMajor, newMinor, newDate, picked);

    const accepted = await showChangePreview(defPath, changes);
    if (!accepted) {
        vscode.window.showInformationMessage('BIOS Buddy: cancelled.');
        return;
    }

    const newContent = applyChanges(raw, changes);
    fs.writeFileSync(defPath, newContent, 'utf-8');
    vscode.window.showInformationMessage(
        `BIOS Buddy: ${changes.length} field(s) updated. MINOR ${curMinor} -> ${newMinor}. `
        + 'Version only — click a build row when you want to compile.',
    );
    panelProvider.refresh();
}

async function reselectBuildFields(modeOrItem?: 'formalBuildFields' | 'testBuildFields' | ElementKind) {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const defPath = resolvePath(cfg.get<string>('defFile', ''));
    if (!defPath || !fs.existsSync(defPath)) {
        vscode.window.showErrorMessage('BIOS Buddy: configure BiosVersion.def path first.');
        return;
    }

    const raw = readDefFile(defPath);
    const fields = parseConfigFields(raw);
    if (fields.length === 0) {
        vscode.window.showWarningMessage('BIOS Buddy: no Config fields found in file.');
        return;
    }

    let selectedMode: 'formalBuildFields' | 'testBuildFields' | undefined;
    if (modeOrItem && typeof modeOrItem !== 'string') {
        // Inline gears pass a TreeItem carrying actionId; context menus pass the element itself
        const id = modeOrItem.kind === 'action'
            ? modeOrItem.id
            : (modeOrItem as { actionId?: string }).actionId;
        selectedMode = id === 'incBuild' ? 'formalBuildFields' : id === 'testBuild' ? 'testBuildFields' : undefined;
    } else {
        selectedMode = modeOrItem;
    }

    if (!selectedMode) {
        const picked = await vscode.window.showQuickPick([
            { label: 'Formal BIOS Version', value: 'formalBuildFields' as const },
            { label: 'Test BIOS Version', value: 'testBuildFields' as const },
        ], {
            placeHolder: 'Which version action do you want to reconfigure?',
        });
        selectedMode = picked?.value;
    }
    if (!selectedMode) return;

    const fallback = selectedMode === 'formalBuildFields' ? DEFAULT_FORMAL_BUILD_FIELDS : DEFAULT_TEST_BUILD_FIELDS;
    await pickFieldsForBuild(cfg, selectedMode, fields, selectedMode === 'formalBuildFields' ? 'Select fields for Formal BIOS Version' : 'Select fields for Test BIOS Version', fallback, true);
    panelProvider.refresh();
    vscode.window.showInformationMessage(`BIOS Buddy: ${selectedMode === 'formalBuildFields' ? 'Formal BIOS Version' : 'Test BIOS Version'} field selection updated.`);
}

// Test BIOS: move the Build ID from W to T01 / T02 … and bump the version, again without building.
async function runTestVersion() {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const defPath = resolvePath(cfg.get<string>('defFile', ''));

    if (!defPath) {
        vscode.window.showErrorMessage('BIOS Buddy: BIOS Version File is not configured.');
        return;
    }
    if (!fs.existsSync(defPath)) {
        vscode.window.showErrorMessage(`BIOS Buddy: BIOS Version File is not founded at:\n${defPath}`);
        return;
    }

    const raw = readDefFile(defPath);
    const fields = parseConfigFields(raw);
    const bldIdField = fields.find(f => f.key === 'LENOVO_COMMON_BLD_ID');
    if (!bldIdField) {
        vscode.window.showErrorMessage('BIOS Buddy: LENOVO_COMMON_BLD_ID not found.');
        return;
    }

    const newBldId = nextTestBuildId(bldIdField.value);
    if (newBldId === null) {
        vscode.window.showErrorMessage(
            'BIOS Buddy: Build ID must end with W (release) or T## (test) to switch to a TEST build.',
        );
        return;
    }

    const majorField = fields.find(f => f.key === 'BIOS_VERSION_MAJOR');
    const minorField = fields.find(f => f.key === 'BIOS_VERSION_MINOR');
    if (!majorField || !minorField) {
        vscode.window.showErrorMessage('BIOS Buddy: BIOS_VERSION_MAJOR / BIOS_VERSION_MINOR not found.');
        return;
    }

    const curMajor = parseInt(stripValue(majorField.value), 10);
    const curMinor = parseInt(stripValue(minorField.value), 10);
    if (isNaN(curMajor) || isNaN(curMinor)) {
        vscode.window.showErrorMessage('BIOS Buddy: could not parse MAJOR/MINOR as integers.');
        return;
    }

    const newMinor = curMinor + 1;
    let newMajor = curMajor;
    const overflow = cfg.get<boolean>('incrementMajor', false);
    if (overflow && newMinor >= 100) {
        newMajor += 1;
    }

    const dateFmt = cfg.get<string>('dateFormat', 'MM/DD/YYYY') || 'MM/DD/YYYY';
    const newDate = formatDate(new Date(), dateFmt);

    const selected = await pickFieldsForBuild(
        cfg,
        'testBuildFields',
        fields,
        'Select fields for Test BIOS Version',
        DEFAULT_TEST_BUILD_FIELDS,
        false,
    );

    let changes = computeAllChanges(fields, curMajor, curMinor, newMajor, newMinor, newDate, selected);
    const selectedBld = selected.has('LENOVO_COMMON_BLD_ID');
    if (selectedBld) {
        // One BLD_ID may exist under both #ifdef and #else, so each copy is handled in turn:
        // the first follows W->T01 / T01->T02; a second copy written differently just gets its trailing number +1.
        changes = changes.filter(c => c.field.key !== 'LENOVO_COMMON_BLD_ID');
        for (const f of fields.filter(x => x.key === 'LENOVO_COMMON_BLD_ID')) {
            const next = nextTestBuildId(f.value) ?? bumpLastNumber(f.value, 1);
            if (next !== null) {
                changes.push({ field: f, oldRaw: f.value, newRaw: next, reason: 'test build id' });
            }
        }
    }

    const finalChanges = changes;

    if (finalChanges.length === 0) {
        vscode.window.showInformationMessage('BIOS Buddy: no changes needed.');
        return;
    }

    const accepted = await showChangePreview(defPath, finalChanges);
    if (!accepted) {
        vscode.window.showInformationMessage('BIOS Buddy: cancelled.');
        return;
    }

    fs.writeFileSync(defPath, applyChanges(raw, finalChanges), 'utf-8');
    const cleanId = newBldId.replace(/[\\"]/g, '').trim();
    vscode.window.showInformationMessage(
        `BIOS Buddy: TEST BIOS build id -> ${cleanId}. ${finalChanges.length} field(s) updated. `
        + 'Version only — click a build row when you want to compile.',
    );
    panelProvider.refresh();
}

async function configureDefFile() {
    const defaultUri = getConfigFolder('defFile');
    const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { 'Config files': ['def'], 'All files': ['*'] },
        defaultUri,
        title: 'Select Bios Version File',
    });
    if (!uris || uris.length === 0) return;

    let rawPath = uris[0].fsPath;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws && rawPath.startsWith(ws)) {
        rawPath = '${workspaceFolder}' + rawPath.substring(ws.length);
    }

    if (!writeWorkspaceSetting('biosBuddy.defFile', rawPath)) return;

    panelProvider.refresh();
    vscode.window.showInformationMessage(`BIOS Buddy: BIOS version file set to ${rawPath}`);
}

async function configurePaths() {
    // Both sections are reachable from the panel now, so this is just a Command Palette entry
    const choice = await vscode.window.showQuickPick([
        { label: 'BIOS Version File', description: 'BIOS Current Info 的第一行', key: 'defFile' },
        { label: 'Build Script',      description: '默认那一行 Build 用的脚本', key: 'buildBat' },
    ], {
        placeHolder: 'What do you want to configure?',
    });
    if (!choice) return;
    if (choice.key === 'defFile') return configureDefFile();
    return configureBuildScript();
}

function getConfigFolder(key: string): vscode.Uri | undefined {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const existing = resolvePath(cfg.get<string>(key, ''));
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
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const defPath = resolvePath(cfg.get<string>('defFile', ''));
    if (!defPath || !fs.existsSync(defPath)) {
        vscode.window.showErrorMessage('BIOS Buddy: configure BiosVersion.def path first.');
        return;
    }

    let fields: ParsedField[] = [];
    try {
        fields = parseConfigFields(readDefFile(defPath));
    } catch {
        // fall through with an empty list
    }

    const usedKeys = new Set(getInfoFields(cfg).map(e => e.key));
    interface Pick extends vscode.QuickPickItem { key: string }
    const items: Pick[] = [];

    for (const f of fields) {
        if (usedKeys.has(f.key)) continue;
        items.push({
            label: f.key,
            description: stripValue(f.value) || '(empty)',
            key: f.key,
        });
    }

    if (items.length === 0) {
        vscode.window.showInformationMessage('BIOS Buddy: every available field is already shown.');
        return;
    }

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Config field to show under BIOS Current Info',
    });
    if (!pick) return;

    const list = getInfoFields(cfg);
    list.push({ label: pick.key, key: pick.key });
    if (!await saveInfoFields(cfg, list)) return;
    panelProvider.refresh();
}

async function removeInfoField(element?: ElementKind) {
    if (!element || element.kind !== 'info' || !element.cfgKey) return;
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const list = getInfoFields(cfg).filter(e => e.key !== element.cfgKey);
    if (!await saveInfoFields(cfg, list)) return;
    panelProvider.refresh();
}

async function resetInfoFields() {
    const cfg = vscode.workspace.getConfiguration('biosBuddy');
    const pick = await vscode.window.showWarningMessage(
        'Reset "BIOS Current Info" fields to the default set and order?',
        { modal: true },
        'Reset',
    );
    if (pick !== 'Reset') return;
    const defaults = DEFAULT_INFO_FIELDS.map(e => ({ ...e }));
    if (!await saveInfoFields(cfg, defaults)) return;
    panelProvider.refresh();
}

// Right-click "Move Up / Move Down" counterpart to drag-and-drop reordering.
export async function moveItem(element: ElementKind | undefined, dir: -1 | 1): Promise<void> {
    if (!element) return;
    let id: string | undefined;
    let group: string | undefined;
    if (element.kind === 'action') { id = element.id; group = element.dndGroup; }
    else if (element.kind === 'vcs') { id = element.action.id; group = vcsGroupOf(element.tool); }
    else if (element.kind === 'build') { id = element.target.id; group = element.dndGroup; }
    else if (element.kind === 'info') { id = element.dndId; group = element.dndGroup; }
    if (!id || !group) return;

    const cfg = vscode.workspace.getConfiguration('biosBuddy');

    if (group === 'version') {
        const list = getInfoFields(cfg);
        const i = list.findIndex(e => e.key === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        if (await saveInfoFields(cfg, list)) refreshPanel();
        return;
    }

    if (group !== 'actions' && group !== 'svnops' && group !== 'gitops' && group !== 'tools') return;

    // Work from the order the tree shows right now instead of the stored order table:
    // an id never registered there (new action, never dragged) has indexOf -1, so up/down would silently do nothing.
    const order = getItemOrder(cfg);
    const key = group as OrderGroup;
    const shown = displayedIds(key, cfg);
    const arr = order[key].filter(x => shown.includes(x));
    for (const sid of shown) if (!arr.includes(sid)) arr.push(sid);

    const i = arr.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    order[key] = arr;
    if (writeWorkspaceSetting('biosBuddy.itemOrder', order)) refreshPanel();
}

// Persist infoFields directly into .vscode/settings.json so the host's
// extension-manifest cache can never block the write.
function saveInfoFields(_cfg: vscode.WorkspaceConfiguration, list: InfoFieldCfg[]): boolean {
    return writeWorkspaceSetting('biosBuddy.infoFields', list);
}

// ---------------------------------------------------------------------------
// Change computation
// ---------------------------------------------------------------------------

function computeAllChanges(
    fields: ParsedField[],
    curMajor: number, curMinor: number,
    newMajor: number, newMinor: number,
    newDate: string,
    selected: Set<string>,
): FieldChange[] {
    const changes: FieldChange[] = [];

    const pushChange = (field: ParsedField | undefined, newRaw: string, reason: string) => {
        if (!field) return;
        changes.push({ field, oldRaw: field.value, newRaw, reason });
    };

    for (const key of selected) {
        // The same Config key can occur twice in the def (typically under #ifdef XXX ... #else ... #endif,
        // one BLD_ID / ACPI_OEM_TABLE_ID per branch). Both copies must change, otherwise the
        // branch that was left alone still builds with the old version.
        const hits = fields.filter(x => x.key === key);
        if (hits.length === 0) continue;

        for (const field of hits) {
            const twin = hits.length > 1 ? ` #${hits.indexOf(field) + 1}/${hits.length}` : '';
            const reason = (text: string) => text + twin;

            if (/VERSION_MAJOR$/i.test(key)) {
                pushChange(field, String(newMajor), reason('major update'));
                continue;
            }

            if (/VERSION_MINOR$/i.test(key)) {
                pushChange(field, String(newMinor), reason('auto-increment'));
                continue;
            }

            if (/BIOS_VERSION$/i.test(key) || /LENOVO_SECURITY_VERSION$/i.test(key)) {
                const next = bumpVersionString(field.value);
                if (next !== null) pushChange(field, next, reason('bump embedded version'));
                continue;
            }

            if (/ACPI_OEM_REVISION$/i.test(key) || /ACPI_OEM_TABLE_ID$/i.test(key)) {
                // Only rewrite the copy that is already a hex number; a table name like "TP-R3U" must stay untouched
                const bare = field.value.replace(/[\\"]/g, '').trim();
                if (!/^0x[0-9a-f]+$/i.test(bare)) continue;
                const q = Math.floor(newMinor / 10);
                const r = newMinor % 10;
                const oemRev = (newMajor << 12) | (q << 8) | (r << 4);
                const next = '0x' + oemRev.toString(16).toUpperCase().padStart(8, '0');
                pushChange(field, /[\\"]/.test(field.value) ? quoteLike(field.value, next) : next,
                    reason('derived from MAJOR.MINOR (PQR)'));
                continue;
            }

            if (/BLD_DATE$/i.test(key) || /BUILD_DATE$/i.test(key)) {
                pushChange(field, quoteLike(field.value, newDate), reason('today'));
                continue;
            }

            if (/BLD_TIME$/i.test(key)) {
                pushChange(field, quoteLike(field.value, formatTime(new Date())), reason('time now'));
                continue;
            }

            if (/BLD_ID$/i.test(key)) {
                const next = bumpBuildId(field.value, curMinor, newMinor);
                if (next !== null) pushChange(field, next, reason(`bump build id (${curMinor} -> ${newMinor})`));
                continue;
            }

            if (/FW_VER_PACKAGE$/i.test(key)) {
                const next = bumpLastTwoDigits(field.value);
                if (next !== null) pushChange(field, next, reason('bump 2-digit ver'));
            }
        }
    }

    return changes;
}

function bumpVersionString(oldRaw: string): string | null {
    const re = /(\d+)\.(\d+)/;
    const m = oldRaw.match(re);
    if (!m) return null;
    const minorGroup = m[2];
    const num = parseInt(minorGroup, 10);
    if (isNaN(num)) return null;
    const bumped = String(num + 1).padStart(minorGroup.length, '0');
    return oldRaw.substring(0, m.index! + m[1].length + 1) + bumped + oldRaw.substring(m.index! + m[0].length);
}

function replaceWholeNumber(oldRaw: string, curNum: number, newNum: number): string {
    const re = new RegExp(`(?<!\\d)${curNum}(?!\\d)`);
    return oldRaw.replace(re, String(newNum));
}

/**
 * Build ID style strings ("R3UET12T01" / "R3TET11A"):
 * first try swapping the current MINOR for the new one; if this value has no such MINOR
 * (typical of the #else branch, whose number already lags a step), shift the trailing
 * number by the same delta instead - that keeps both branches moving in lockstep.
 */
function bumpBuildId(oldRaw: string, curMinor: number, newMinor: number): string | null {
    const replaced = replaceWholeNumber(oldRaw, curMinor, newMinor);
    if (replaced !== oldRaw) return replaced;
    return bumpLastNumber(oldRaw, newMinor - curMinor || 1);
}

function bumpLastNumber(oldRaw: string, delta: number): string | null {
    const re = /\d+/g;
    let last: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(oldRaw)) !== null) last = m;
    if (!last) return null;
    const bumped = String(parseInt(last[0], 10) + delta).padStart(last[0].length, '0');
    return oldRaw.substring(0, last.index) + bumped + oldRaw.substring(last.index + last[0].length);
}

function bumpLastTwoDigits(oldRaw: string): string | null {
    const re = /(\d{2})(?!\d)/g;
    let lastMatch: RegExpExecArray | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(oldRaw)) !== null) {
        lastMatch = m;
    }
    if (!lastMatch) return null;
    const num = parseInt(lastMatch[1], 10);
    const bumped = String(num + 1).padStart(2, '0');
    return oldRaw.substring(0, lastMatch.index) + bumped + oldRaw.substring(lastMatch.index + 2);
}

// Release build ID ends with W (e.g. "N4YET27W"). First TEST build turns it
// into T01; subsequent TEST builds bump the digits (T01 -> T02 -> T03 ...).
// The raw value keeps its surrounding escaped quotes, e.g. "\"N4YET27W \"".
function nextTestBuildId(oldRaw: string): string | null {
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
function quoteLike(oldRaw: string, inner: string): string {
    if (oldRaw.includes('\\"')) {
        return '"\\"' + inner + '\\""';
    }
    return '"' + inner + '"';
}

// ---------------------------------------------------------------------------
// Build execution
// ---------------------------------------------------------------------------

async function runBuild(target: BuildTarget) {
    const batPath = resolvePath(target.script);
    const extraArgs = (target.args ?? '').trim();
    const label = displayLabel(target);

    if (!batPath) {
        const pick = await vscode.window.showWarningMessage(
            `BIOS Buddy: "${label}" has no build script yet.`,
            'Pick a script',
        );
        if (pick === 'Pick a script') await configureBuildScript({ target });
        return;
    }
    if (!fs.existsSync(batPath)) {
        vscode.window.showErrorMessage(`BIOS Buddy: "${target.label}" script not found:\n${batPath}`);
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: label,
        cwd: path.dirname(batPath),
    });
    terminal.show(true);
    const prefix = process.platform === 'win32' ? '.\\' : './';
    terminal.sendText(prefix + path.basename(batPath) + (extraArgs ? ' ' + extraArgs : ''));
    vscode.window.setStatusBarMessage(`BIOS Buddy: "${label}" started`, 3000);
}

// ---------------------------------------------------------------------------
// Preview / confirmation UI
// ---------------------------------------------------------------------------

async function showChangePreview(defPath: string, changes: FieldChange[]): Promise<boolean> {
    if (changes.length === 0) {
        vscode.window.showInformationMessage('BIOS Buddy: no changes needed.');
        return false;
    }

    const detail = changes
        .map(c => `  ${c.field.key}: ${c.oldRaw.trim()}  →  ${c.newRaw.trim()}   (${c.reason})`)
        .join('\n');

    const selected = await vscode.window.showInformationMessage(
        `Apply ${changes.length} change(s) to ${path.basename(defPath)}?\n\n${detail}`,
        { modal: true },
        'Apply',
        'Cancel',
    );
    return selected === 'Apply';
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

function parseConfigFields(rawIn: string): ParsedField[] {
    const raw = rawIn.replace(/^\uFEFF/, ''); // strip UTF-8 BOM if present
    const lines = raw.split(/\r?\n/);
    // Real line terminator length: CRLF files need +2 per line, LF files +1.
    const sepLen = raw.includes('\r\n') ? 2 : 1;
    const fields: ParsedField[] = [];
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
function readDefFile(defPath: string): string {
    return fs.readFileSync(defPath, 'utf-8').replace(/^\uFEFF/, '');
}

function applyChanges(raw: string, changes: FieldChange[]): string {
    const sorted = [...changes].sort((a, b) => b.field.matchStart - a.field.matchStart);
    let out = raw;
    for (const c of sorted) {
        out = out.substring(0, c.field.matchStart) + c.newRaw + out.substring(c.field.matchEnd);
    }
    return out;
}

function stripValue(raw: string): string {
    // String fields are stored like "\"1.02 \"" (outer quotes + escaped inner
    // quotes). Strip every quote/backslash and surrounding whitespace.
    return raw.replace(/[\\"]/g, '').trim();
}

function formatDate(d: Date, fmt: string): string {
    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    const YYYY = String(d.getFullYear());
    return fmt
        .replace('MM', MM)
        .replace('DD', DD)
        .replace('YYYY', YYYY);
}

function formatTime(d: Date): string {
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    const SS = String(d.getSeconds()).padStart(2, '0');
    return `${HH}:${MM}:${SS}`;
}

function resolvePath(p: string): string {
    if (!p) return '';
    if (p.includes('${workspaceFolder}')) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        p = p.replace(/\$\{workspaceFolder\}/g, ws);
    }
    return path.resolve(p);
}


