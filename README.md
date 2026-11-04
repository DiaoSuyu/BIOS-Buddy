# BIOS Buddy

A VS Code extension for day-to-day BIOS / firmware work: version bumps, build scripts,
SVN & Git actions, and four offline tools — **GUID Assistant**, **COM Assistant**,
**Binary Editor**, **Text Comparer**. Nothing talks to the network, so it is safe on
locked-down machines.

[中文说明](README.zh-CN.md) · [使用指南（含截图）](docs/USAGE.md)

## Sidebar

```
BIOS Buddy
├─ BIOS Current Info      the version file, then the fields read from it
├─ BIOS Build Action      Formal / Test version rows + one or more build rows
├─ SVN Operation
├─ Git Operation
└─ Tools                  GUID Assistant · COM Assistant · Binary Editor · Text Comparer
```

- **Version rows** bump Formal / Test and show a diff first — they never compile.
- **Build rows** run one script each; click to run, `+` on the group title adds another.
- **SVN / Git rows** run in the integrated terminal; hover for ▶ / ✎, right-click to rename or hide.
- Drag to reorder anything; `↺` in the view title bar restores the default order (your own rows stay).

## Tools

| Tool | What it does |
| --- | --- |
| **GUID Assistant** | Makes GUID **v4 / v7**; converts a pasted GUID into nine forms at once (D / N / B / P, C struct, `#define`, EFI byte order, raw hex, Base64). |
| **COM Assistant** | Serial console for boot logs: raw bytes, HEX view, timestamps, line endings, timed repeat, find / find-all, line numbers. |
| **Binary Editor** | Two-pane HEX editor: open or import, overwrite / insert bytes, byte diff with a jumpable list, save back to the source file. |
| **Text Comparer** | Side-by-side diff for `.def` / `.dsc` / logs: character-level marks, in-place editing, per-pane minimap, unified-diff export. |

## Quick start

1. Click the BIOS Buddy icon in the activity bar.
2. Pick the version file in **BIOS Current Info** (gear on the first row).
3. Pick a build script on the build row (gear); `+` adds more builds.
4. Bump with **Formal** / **Test**, then click a build row to compile.

## Settings

`biosBuddy.svnCleanRemoveIgnored` · `biosBuddy.gitPullMode` · `biosBuddy.gitUpdateSubmodules` ·
`biosBuddy.confirmDestructive` — all with sensible defaults, adjustable in Settings.

Rows you add live in `.vscode/settings.json`, so they can be reviewed and shared.

---

VS Code 1.85 or newer. COM Assistant is Windows-only (it uses `System.IO.Ports`).
