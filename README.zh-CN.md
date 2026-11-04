# BIOS Buddy

给 BIOS / 固件日常工作用的 VS Code 扩展：版本号维护、编译脚本、SVN 与 Git 操作，外加四个离线小工具
—— **GUID Assistant**、**COM Assistant**、**Binary Editor**、**Text Comparer**。全程不联网，
内网机器、保密机房都能直接用。

## 侧边栏

```
BIOS Buddy
├─ BIOS Current Info      版本文件，以及从里面读出来的字段
├─ BIOS Build Action      Formal / Test 版本行 + 一条或多条编译行
├─ SVN Operation
├─ Git Operation
└─ Tools                  GUID Assistant · COM Assistant · Binary Editor · Text Comparer
```

- **版本行**（Formal / Test）只改版本字段，改之前先给 diff，不会触发编译。
- **编译行**每条绑一个脚本，点一下就编译；组标题上的 `+` 再加一条。
- **SVN / Git 行**都发到集成终端里执行；悬停出现 ▶ / ✎，右键可重命名、隐藏。
- 所有行都能拖动排序；拖乱了点视图标题栏的 `↺` 恢复默认顺序（自己加的行不会丢）。

## 四个工具

| 工具 | 用途 |
| --- | --- |
| **GUID Assistant** | 生成 GUID **v4 / v7**；把粘进来的 GUID 一次翻成九种写法（D / N / B / P、C 结构体、`#define`、EFI 字节序、原始 hex、Base64）。 |
| **COM Assistant** | 串口控制台：原始字节、HEX 视图、时间戳、行尾符、定时重发、查找 / 查找全部、行号。 |
| **Binary Editor** | 双栏 HEX 编辑器：打开 / 导入、按字节覆盖或插入、字节级 diff + 可跳转差异清单、直接存回源文件。 |
| **Text Comparer** | `.def` / `.dsc` / 日志的并排比较：字符级标注、就地编辑、每栏差异小地图、unified diff 导出。 |

## 快速上手

1. 点左侧活动栏的 BIOS Buddy 图标。
2. 在 **BIOS Current Info** 第一行点齿轮选版本文件。
3. 在编译行点齿轮选编译脚本；要并行维护多个配置就按 `+` 再加。
4. 用 **Formal** / **Test** 跳版本，然后点编译行开始编译。

## 设置

`biosBuddy.svnCleanRemoveIgnored` · `biosBuddy.gitPullMode` · `biosBuddy.gitUpdateSubmodules` ·
`biosBuddy.confirmDestructive` —— 都有默认值，在设置里改。

自己加的行存在 `.vscode/settings.json`，可以评审、可以共享。

---

VS Code 1.85 及以上。COM Assistant 只支持 Windows（依赖 `System.IO.Ports`）。
