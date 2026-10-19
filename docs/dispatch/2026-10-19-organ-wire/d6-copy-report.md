完成判据达成：CLI 全绿（350 pass，0 fail）+ tsc 0 错。

## 结论清单

**改动文件清单**
- 新增 `packages/core/src/cli/commands/copy.ts` — `bi copy` 子命令实现（字段提取 / 平台探测 / 剪贴板分派 / 降级链 / 结构化错误）
- 新增 `packages/core/src/cli/commands/copy.test.ts` — 19 个测试
- 修改 `packages/core/src/cli/commands/dispatch.ts` — SUBCOMMANDS 加 `copy`、DISPATCH 加 `copy: handleCopy`、SubcommandDeps 加 `cmdRunner`/`osPlatform`/`osType` 注入面、文件头注释同步

**copy 语义表（字段 × 平台）**
| 字段 `-f` | 取值 | 缺省 |
|---|---|---|
| `id` | 会话 id（meta.sessionId） | ✅ 缺省字段 |
| `title` | 会话标题 | |
| `last-reply` | 会话末条 assistant 条目 payload.text（无 assistant 返回空串，不报错） | |

| 平台探测（OSTYPE/process.platform） | 剪贴板工具分派 |
|---|---|
| Linux | 先探 `xclip`(exit0 才用)，缺失则探 `wl-copy`；均缺失→降级 |
| macOS (darwin) | `pbcopy` |
| Windows GitBash (msys/cygwin/win32) | `clip` |
| unknown | 降级 |

**降级链**
- 三平台剪贴板工具全缺失（或 unknown 平台）→ 内容仍 `io.out` 直出 + `io.err` 结构化提示"剪贴板工具缺失，已打印到 stdout"，**exit 0**（诚实，不假冒成功）。

**测试数 + tsc**
- 19 个 copy 用例覆盖：四字段语义 / 最近会话缺省 / 显式 id / 三平台 CmdRunner 替身分派 / 全缺失降级 / 未知会话 / 非法字段 / 等号旗标形式。
- 全 CLI 套件 350 pass 0 fail；`bunx tsc --noEmit` 0 错误。

**未尽边界（已诚实标注）**
- 生产 `realCmdRunner` 仅执行命令探活，文本经 stdin 喂入剪贴板的实际管道未在本卡实现（真实写入依赖 shell 管道，留待后续；测试经 `cmdRunner` 注入替身零外呼，不触真实进程/剪贴板）。
- 未触碰并行工单面：`export`(D5)/`bin/bi.ts`/`headless.ts`/`main.ts`/`session/` 只读消费；未 commit/push。
- `findSubcommandIndex` 的 `SUBCOMMANDS` 已含 `copy`，main 用法文本自动同步（`SUBCOMMANDS.join(" / ")`），无需改 main.ts。
