"use strict";
// ---------------------------------------------------------------------------
// SVN / Git operations
//
// Why this lives in its own file:
// "Clean" has to leave the working copy genuinely clean, yet SVN's own
// `svn cleanup --remove-unversioned` only removes unversioned (?) files,
// so build output ignored through svn:ignore (I) survives — which is why older versions left a dirty tree.
// Both kinds now go through `svn cleanup --remove-unversioned/--remove-ignored`
// inside the terminal; the extension computes nothing itself.
//
// How it runs:
// Every action (update, clean, custom commands) runs in the integrated terminal,
// because update / pull may ask for credentials or need manual conflict resolution.
//
// The point: nothing is spawned in the background after a click.
// It used to probe with `svn --version` and `svn info --show-item wc-root` first — seconds on a big working copy —
// before anything reached the terminal. Now the command is written the moment the confirmation closes,
// the working directory is the folder VS Code has open, and every command targets ` .`,
// so svn / git walk up to the working copy root themselves.
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
exports.runInTerminal = runInTerminal;
exports.deleteCommands = deleteCommands;
exports.splitArgs = splitArgs;
exports.vcsRootFor = vcsRootFor;
exports.runStepsInTerminal = runStepsInTerminal;
exports.svnUpdate = svnUpdate;
exports.parseSvnStatus = parseSvnStatus;
exports.planDeletes = planDeletes;
exports.leftoverLines = leftoverLines;
exports.pullFlag = pullFlag;
exports.svnClean = svnClean;
exports.gitUpdate = gitUpdate;
exports.gitResetClean = gitResetClean;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function cfg() { return vscode.workspace.getConfiguration('biosBuddy'); }
/** Quoting for the terminal: always quote a path so spaces and special characters cannot split it */
const qt = (p) => '"' + p + '"';
// ---------------------------------------------------------------------------
// Target root
// ---------------------------------------------------------------------------
/** The open workspace folder first; without one, fall back to the folder holding the configured def / bat */
function workspaceDir() {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws)
        return ws;
    const c = cfg();
    for (const key of ['defFile', 'buildBat']) {
        const raw = c.get(key, '') || '';
        if (!raw)
            continue;
        const p = raw.replace(/\$\{workspaceFolder\}/g, '').replace(/[\\/]+$/, '');
        try {
            if (fs.existsSync(raw) && fs.statSync(raw).isDirectory())
                return raw;
            if (fs.existsSync(p))
                return fs.statSync(p).isDirectory() ? p : path.dirname(p);
        }
        catch { /* ignore */ }
    }
    return '';
}
// ---------------------------------------------------------------------------
// Terminal and confirmation helpers
// ---------------------------------------------------------------------------
/**
 * Send these commands to the integrated terminal in order.
 * One terminal, one cwd, commands queue up — and a failure stays visible in the
 * terminal instead of hiding in an output panel.
 */
function runInTerminal(name, cwd, lines) {
    const term = vscode.window.createTerminal({ name, cwd });
    term.show(true);
    for (const l of lines) {
        if (l && l.trim())
            term.sendText(l);
    }
}
async function mustConfirm(title, detail, cleanLabel) {
    if (!cfg().get('confirmDestructive', true))
        return Promise.resolve(true);
    const lines = detail.length ? detail.join('\n') : '';
    const pick = await vscode.window.showWarningMessage(title, { modal: true, detail: lines }, cleanLabel);
    return pick === cleanLabel;
}
function isInside(root, target) {
    const rel = path.relative(root, target);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
// ---------------------------------------------------------------------------
// Deleting files: build one batch command and hand it to the terminal
// ---------------------------------------------------------------------------
const psQuote = (p) => "'" + p.replace(/'/g, "''") + "'";
const shQuote = (p) => "'" + p.replace(/'/g, "'\\''") + "'";
/**
 * Squeeze the paths to delete into as few commands as possible:
 * Windows → powershell Remove-Item (handles files, folders, read-only and missing)
 * elsewhere → rm -rf --
 * so the command works whatever the default terminal is: cmd, PowerShell or bash.
 */
function deleteCommands(paths, platform = process.platform, maxLen = 2000) {
    const cmds = [];
    if (!paths.length)
        return cmds;
    const list = platform === 'win32'
        ? (ps) => 'powershell -NoProfile -Command "Remove-Item -LiteralPath ' +
            ps.join(',') + ' -Recurse -Force -ErrorAction SilentlyContinue"'
        : (ps) => 'rm -rf -- ' + ps.join(' ');
    const quote = platform === 'win32' ? psQuote : shQuote;
    let batch = [];
    let len = 0;
    const flush = () => {
        if (batch.length) {
            cmds.push(list(batch));
            batch = [];
            len = 0;
        }
    };
    for (const p of paths) {
        const piece = quote(p);
        if (batch.length && len + piece.length + 1 > maxLen)
            flush();
        batch.push(piece);
        len += piece.length + 1;
    }
    flush();
    return cmds;
}
/** Split one command line into arguments ("double" and 'single' quotes allowed; no variable expansion, no shell) */
function splitArgs(line) {
    const out = [];
    let cur = '';
    let quote = '';
    for (const ch of String(line ?? '')) {
        if (quote) {
            if (ch === quote)
                quote = '';
            else
                cur += ch;
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
        }
        else if (/\s/.test(ch)) {
            if (cur) {
                out.push(cur);
                cur = '';
            }
        }
        else {
            cur += ch;
        }
    }
    if (cur)
        out.push(cur);
    return out;
}
/**
 * Working directory for these commands: the folder VS Code has open.
 * It used to spawn `svn info --show-item wc-root` / `git rev-parse` to find the
 * repository root, so every click waited on it. Nothing external runs now — the
 * command reaches the terminal immediately.
 */
function vcsRootFor(_tool) {
    return workspaceDir() || null;
}
/**
 * Every action command goes through the terminal: credentials and conflicts need interaction.
 * No `echo ==== title ====` banner is printed any more — PowerShell splits that line into
 * four, so the terminal showed a stack of bare words before the first real command.
 */
function runStepsInTerminal(tool, _title, root, steps) {
    runInTerminal(tool === 'svn' ? 'BIOS SVN' : 'BIOS Git', root, steps);
}
// ---------------------------------------------------------------------------
// SVN Update
// ---------------------------------------------------------------------------
async function svnUpdate() {
    const dir = workspaceDir();
    if (!dir) {
        vscode.window.showErrorMessage('BIOS Buddy: no workspace folder for SVN commands.');
        return;
    }
    runInTerminal('BIOS SVN', dir, ['svn update']);
}
/** Turn escaped XML content back into a real path (svn escapes special characters, including &#xx; entities) */
function decodeXml(s) {
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}
/** Parse `svn status --xml` and collect the requested categories: unversioned / ignored / added … */
function parseSvnStatus(xml, kinds) {
    const entries = [];
    const re = /<entry\b[^>]*\bpath="([^"]+)"[\s\S]*?<wc-status\b[^>]*\bitem="([^"]+)"/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const item = m[2];
        if (!kinds.has(item))
            continue;
        entries.push({ p: decodeXml(m[1]), item });
    }
    return entries;
}
/**
 * Turn svn status output into a delete list: de-duplicate, skip .svn, skip paths
 * outside the working copy, and put deeper paths first so child folders go before
 * their parents.
 */
function planDeletes(all, root) {
    const seen = new Set();
    const uniq = [];
    for (const e of all) {
        const key = e.p.toLowerCase();
        if (seen.has(key))
            continue;
        if (path.basename(e.p).toLowerCase() === '.svn')
            continue;
        if (!isInside(root, e.p))
            continue;
        seen.add(key);
        uniq.push(e);
    }
    return uniq.sort((a, b) => b.p.length - a.p.length);
}
/**
 * Final check: if svn status still lists anything other than externals (X), the
 * tree is not clean. --no-ignore also prints ignored entries, so I counts too.
 */
function leftoverLines(statusOut) {
    return (statusOut || '').split(/\r?\n/).filter(l => l.trim() && !/^[X\s]/.test(l));
}
/** gitPullMode → git pull arguments */
function pullFlag(mode) {
    return mode === 'rebase' ? '--rebase' : (mode === 'merge' ? '--no-rebase' : '--ff-only');
}
async function svnClean() {
    const dir = workspaceDir();
    if (!dir) {
        vscode.window.showErrorMessage('BIOS Buddy: no workspace folder for SVN commands.');
        return;
    }
    const removeIgnored = cfg().get('svnCleanRemoveIgnored', true);
    // The confirmation appears at once, with no svn command run first; confirming executes
    const okToDelete = await mustConfirm(`SVN Clean will revert every local change and delete all unversioned${removeIgnored ? ' and ignored' : ''} files.`, [
        `Folder: ${dir}`,
        '',
        'No scan happens first — the terminal shows exactly what gets removed.',
        'That includes build output and any local file SVN does not track.',
        '.vscode is snapshotted first and restored afterwards, so your',
        'settings / tasks / launch configs are not lost.',
        '',
        'Everything else it deletes is gone for good.',
    ], 'Delete & Clean');
    if (!okToDelete) {
        vscode.window.setStatusBarMessage('SVN Clean cancelled — nothing was deleted', 5000);
        return;
    }
    // svn in the terminal works it all out; the extension never builds paths itself
    const ext = ' --include-externals';
    const cleanup = `svn cleanup${ext} .`;
    const lines = [
        cleanup,
        'svn revert -R .',
        // After a revert, added files turn unversioned, so the cleanup runs after it
        `svn cleanup --remove-unversioned${ext} .`,
    ];
    if (removeIgnored)
        lines.push(`svn cleanup --remove-ignored${ext} .`);
    lines.push(cleanup, 'svn status --no-ignore .');
    runInTerminal('BIOS SVN', dir, lines);
    vscode.window.setStatusBarMessage(`SVN Clean: ${lines.length} command(s) running in terminal "BIOS SVN"`, 8000);
}
// ---------------------------------------------------------------------------
// Git Update
// ---------------------------------------------------------------------------
async function gitUpdate() {
    const dir = workspaceDir();
    if (!dir) {
        vscode.window.showErrorMessage('BIOS Buddy: no workspace folder for Git commands.');
        return;
    }
    const c = cfg();
    const sub = c.get('gitUpdateSubmodules', false);
    const flag = pullFlag(c.get('gitPullMode', 'ff-only'));
    const lines = [
        'git fetch --all --prune',
        `git pull ${flag}`,
    ];
    if (sub)
        lines.push('git submodule update --init --recursive');
    lines.push('git status -sb');
    runInTerminal('BIOS Git', dir, lines);
}
// ---------------------------------------------------------------------------
// Git Reset & Clean
// ---------------------------------------------------------------------------
async function gitResetClean() {
    const dir = workspaceDir();
    if (!dir) {
        vscode.window.showErrorMessage('BIOS Buddy: no workspace folder for Git commands.');
        return;
    }
    const sub = cfg().get('gitUpdateSubmodules', false);
    const go = await mustConfirm('Git Reset & Clean will discard ALL local changes and delete every untracked / ignored path.', [
        `Folder: ${dir}`,
        '',
        'No scan happens first — the terminal shows exactly what gets discarded.',
        'This cannot be undone.',
    ], 'Reset & Clean');
    if (!go) {
        vscode.window.setStatusBarMessage('Git Reset & Clean cancelled — nothing was changed', 5000);
        return;
    }
    const lines = ['git reset --hard'];
    if (sub) {
        lines.push('git submodule foreach --recursive git reset --hard');
        lines.push('git submodule foreach --recursive git clean -ffdx');
    }
    lines.push('git clean -ffdx');
    lines.push('git status --porcelain --ignored');
    runInTerminal('BIOS Git', dir, lines);
    vscode.window.setStatusBarMessage(`Git Reset & Clean: ${lines.length} command(s) running in terminal "BIOS Git"`, 8000);
}
//# sourceMappingURL=vcsOps.js.map