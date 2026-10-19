## BI-30.1 断点续作完成

### 改动文件清单（本工单）

| 文件 | 改动 |
|---|---|
| `packages/tui/src/mount/agent-tui.ts` | `TuiSessionOptions.slashCommand` → `(line) => Promise<string \| { prompt: string }>`；`submit()` 分流：`string` 走既有 `#transcribe("system")` 本地回执（不入模型/JSONL，`endedAs="finish"`）；`{ prompt }` 改写 `turnPrompt` 落下方普通模型回合（JSONL 记 user+assistant、转录 `[user]/[assistant]`、无 system 行）；doc 注释同步两形态语义 |
| `bin/bi.ts` | 保留 `discovered.commands` 完整注册表 `customCommands: readonly SlashCommand[]`（发现失败=空表）；执行面：`/permissions` 语义不变 → 已知自定义命令按名取对象、参数体按空白切 `argv` → `expandCommand(command, argv)` → `ok` 返回 `{ prompt: expanded.text }`、`!ok` 返回 `expanded.error.message`；未知/内置候选的本地应答不变 |
| `packages/tui/src/mount/agent-tui.test.ts` | 前任新增的 3 条 BI-30.1 用例（+154 行）经验证真实跑通：`{prompt}` 入模型回合（model 收到展开文本"总结: 日志"、转录无 `[system]` 行、JSONL `[user, assistant]`、`endedAs="finish"`）；`string` 本地回归（system 行上屏、脚本空模型调用即抛=不入回合、JSONL 0 条目）；`!ok` 展开失败断言（`/demo 缺少必选参数: topic` 走 system 行、JSONL 0 条目） |

`custom-commands.ts` **只消费未修改**（未发现缺陷）。`args.ts / args.test.ts / main.ts` 的 `--max-rounds` 改动原样保留（`grep` 计数 4/8/1 处）。

### 测试结果
- `bun test packages/tui`：**520 pass / 0 fail**（含 BI-30.1 新 3 条；`agent-tui.test.ts` 15/15）
- `bun test packages/core`：**2735 pass / 4 fail**
- 合计 **3259 tests：3255 pass / 4 fail**；`custom-commands.test.ts` 26/26 绿
- `tsc --noEmit -p packages/tui/tsconfig.json` = **0**；`tsc --noEmit -p packages/core/tsconfig.json` = **0**

### 遗留问题
1. **4 条失败为环境性既有失败，与本工单无关**：`e2e-drill`（链4 xlsx_audit / 链5 研报组装）与 `os-sandbox`（真实 landlock / bwrap 内核拦截）——我已用 `git stash` 把工作树退到纯净 HEAD 复跑，同样 4 fail（29 pass/4 fail），确认非本次改动引入；本机无 bwrap、landlock 未生效、drill 依赖 Python xlsx 链路。
2. **共享工作树有并发实例（BI-30.3 主控线）**：正在改 `args.ts/args.test.ts/main.ts/headless(.test).ts`。我为验证既有失败做过一次 `git stash push/pop`，pop 因并发方在窗口期写入 `args.ts`（新增 BI-30.3 `OutputFormat = "stream-json" | "text"`）而中止——**已完整恢复**：其余 5 文件从 stash 还原并取消误入的 index 暂存，`args.ts` = 原 `--max-rounds` 版 + 并发方 BI-30.3 hunk（`/tmp/bi30-backup/` 留有原件备份），stash 已 drop，`git status` 中其改动全部在列、未回滚。并发方随后又自行推进了 `args.test.ts/headless.ts/headless.test.ts`，属其在途工作，我未触碰。
3. 中途曾见 `BI-26.3 并发会话`、`BI-20.2 args` 瞬时失败，均因并发方编辑中的半成态；复跑后分别为 252/252、19/19 绿。