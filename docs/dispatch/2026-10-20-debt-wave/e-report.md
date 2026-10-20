# 工单 E 报告：bi TUI/REPL 面接线（BI-11 TokenHud+/compact 三命令 + BI-20 diff 审查门入口）

仓库 /home/yupeng/bi · 2026-10-20 · 未 commit/push/stash（工作树改动待主控线收编）

## 一、接线点（文件:行）

### BI-11 —— TokenHud 上屏（状态行）
| 位置 | 内容 |
|---|---|
| `packages/tui/src/mount/token-hud.ts`（新） | `TokenHudTracker`：喂适配器 `usage` 读数 → TokenHud 门面渲染（`Tokens: 42k/128k (32%) \| Cache: 88%`）；`DEFAULT_CONTEXT_TOKENS = 128000` |
| `packages/tui/src/mount/agent-tui.ts:86,460` | 装配 tracker（`options.contextTokens` 作分母） |
| `packages/tui/src/mount/agent-tui.ts:829` | 模型流 `usage` 事件更新点 → 喂 tracker + 出帧（数据源 = deepseek-adapter 现成 `usage` 事件） |
| `packages/tui/src/mount/agent-tui.ts:532` | `statusText()` 尾部追加 HUD 段（`[manual] 就绪 \| Tokens: …`）；无读数则整段缺席（不冒充 0/0） |
| `packages/tui/src/mount/agent-tui.ts:214` | `TuiSessionOptions.contextTokens`（宿主按模型 `context_limit` 注入） |
| `bin/bi.ts:53,210` | `contextLimitOf(config, modelId)` → 会话装配透传（config `models.entries[].context_limit`，0/未配走缺省） |

### BI-11 —— /compact /rewind /clear 三命令（候选面 + 分发面 + 执行体）
| 位置 | 内容 |
|---|---|
| `packages/tui/src/mount/gate-commands.ts`（新） | 候选面条目 `gateCommandCandidates`（compact/rewind/clear）+ 分发面 `dispatchGateCommand(line, ctx)`：按名取 core 命令对象（`core/src/commands/compact.ts`，只读未改）→ `parse` → `execute(端口)`；结构化错误原样透出 |
| `packages/tui/src/mount/candidate-menu.ts:34,60-61` | 内置斜杠候选面收录三命令 + `/diff`（菜单可发现） |
| `packages/tui/src/mount/agent-tui.ts:753` | 会话 `submit()` 在模型回合前分流三命令（先于宿主 slashCommand，同 `/btw` 既有先例） |
| `packages/tui/src/mount/agent-tui.ts:968` | `#handleGateCommand`：分发 → 等执行体落定 → system 行回执上屏（不入模型回合、JSONL 零追加） |
| `packages/tui/src/mount/agent-tui.ts:1013,1019,1025` | `CommandContext` 端口装配：宿主替身（`options.gateCommands`）优先，缺省走内建执行体 |
| `packages/tui/src/mount/agent-tui.ts:1038` | 内建 `/compact`：模型摘要 → 上下文收为一条 `[compacted] <摘要>` + JSONL `compaction` 条目；失败不改上下文并如实回报 |
| `packages/tui/src/mount/agent-tui.ts:1080` | 内建 `/rewind N`：回退最近 N 轮**用户输入**（工具结果回填不算新一轮）；JSONL 追加链不截断（append-only 铁律） |
| `packages/tui/src/mount/agent-tui.ts:1099` | 内建 `/clear`：清模型侧上下文 + 转录 + 滚回偏移 |
| `packages/tui/src/transcript-projection.ts:310`、`packages/tui/src/transcript-styled.ts:93` | 增 `clear()`（/clear 清面所需，增量式改动，不改既有语义） |
| `packages/tui/src/mount/agent-tui.ts:437,793-799` | 新增 `#rootCreated` 根条目标志位：`/clear` 清空消息表后不再撞 `SessionManager`「同会话不允许第二个根」 |
| `bin/bi.ts:137` | 宿主命令面兜底：三命令本应由会话内建执行体处理，走到宿主面即装配缺环，如实回报 |

### BI-20 —— diff 审查门入口
| 位置 | 内容 |
|---|---|
| `packages/tui/src/mount/diff-gate.ts`（新） | `/diff` 入口：`parseDiffArgs`（`--staged`）→ git diff 取文（`GitRunner` 注入面，缺省 node:child_process）→ `parseDiff` → `renderDiff` → `presentDiff` 审查门；`stripAnsi` 出纯文本上屏；`DiffGatePorts.confirm` 注入面 |
| `bin/bi.ts:129-131` | 宿主斜杠命令面接线：`/diff` → `runDiffGate({ cwd })` → 回执文本上屏 |
| `packages/tui/src/index.ts:126-161` | 导出面：`TokenHudTracker` / 三命令分发面 / **diff-view 器官**（`parseDiff`/`renderDiff`/`presentDiff`/`buildDiffFromFiles`）/`runDiffGate` —— 补上「diff-view 无生产导入方」缺口 |
| `packages/tui/src/mount/diff-gate.ts` 头注 | 另一入口（edit/write 工具执行前 diff 预览）**留注释备案**，未交付 |

## 二、入口选择与理由（一行）

**BI-20 选 REPL `/diff` 斜杠命令**：不侵入工具执行/审批回路（侵入面最小），复用既有宿主命令面（`/permissions` 同款），另一入口（edit/write 前 diff 预览）留注释备案。
**BI-11 三命令选会话内建分流**：会话持有消息表/转录/模型端口，执行体天然在会话侧（同 `/btw` 先例），宿主只需提供替身端口。

## 三、新增测试（40 例）

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `packages/tui/src/mount/gate-commands.test.ts`（新） | 11 | 三命令可发现（候选面 + 内置面）、分发透传（prompt/steps/clear）、参数校验（invalid-steps / unexpected-argument / unknown-command）、执行体零调用 |
| `packages/tui/src/mount/token-hud.test.ts`（新） | 9 | 无读数不挂段、k 缩写 + floor 百分比、Cache round 百分比、缓存缺席、窗口可配、确定性 |
| `packages/tui/src/mount/diff-gate.test.ts`（新） | 10 | 参数解析、diff 解析+渲染上屏（去 ANSI）、ANSI 视图行同源、门禁裁决（通过/否决/fail-closed）、空 diff、git 执行面注入（成功/非零退出） |
| `packages/tui/src/mount/agent-tui.test.ts`（增） | 10 | HUD 上屏断言（状态行含 Tokens/Cache、无读数不挂段）、三命令替身注入可执行、不入模型回合、参数错误上屏、执行体抛错结构化回执、内建 `/clear` 清面、内建 `/rewind` 回退后模型侧无旧消息、内建 `/compact` 摘要紧缩 + JSONL compaction 条目、`/diff` 入口落屏断言 |

改既有断言 6 处（`candidate-menu.test.ts`）：内置候选面新增 `/compact /rewind /clear /diff` 后，原按旧清单钉死的期望（`/re` 前缀命中集、`lines` 行数、`completeNonSlash` 共同前缀）同步更新为新集合语义（`/rel` 仍只命中 reload/reload-tui）。

## 四、门禁统计

| 门禁 | 结果 |
|---|---|
| `cd /home/yupeng/bi && BI_PTY_E2E=1 bun test` | **4732 pass / 0 fail**（256 文件 / 52514 expect / 96s，含 pty 真人面、build-bin e2e、伪端点 e2e、kill -9 e2e） |
| `cd packages/tui && bunx tsc --noEmit` | **0 错** |
| `bunx tsc --noEmit -p tsconfig.json`（全仓） | **0 错** |
| `bun test packages/tui` | 661 pass / 0 fail（37 文件） |

中途并行单施工面（`packages/core/src/cli/{main,toolset}.ts` 等 + `bin/bi.ts` 的 subagent/swarm 接线）在 `packages/core/src/cli/subagent-adapter`、`packages/core/src/subagent/swarm/swarm-service` 落盘前导致真 bin 加载失败，pty/build-bin/伪端点/kill-9 四例 e2e 连带红；隔离复跑（HEAD core + 本工单全部改动）该四例全绿，判定为并行面在途态、非本工单回归。对方收工后全仓复跑即 4732/0。

## 五、诚实边界（备案）

- `/compact` 摘要经模型调用生成，失败则上下文原样保留并回报失败（不塞占位摘要）。
- `/rewind` 只回退**模型侧上下文**；JSONL 追加链按 append-only 铁律不截断（审计链完整）。
- `/clear` 清上下文与转录；JSONL 保留，会话仍只有一个根条目。
- `/diff` 未注册交互确认回调时，`presentDiff` 按 fail-closed 判**拒绝**并如实回报（不冒充已审通过）；交互确认留 `DiffGatePorts.confirm` 注入口。
- TokenHud 依赖供应商真的发 `usage` 事件；不发则状态行不挂 HUD 段（不造数）。
- `edit/write` 工具执行前的 diff 预览入口未交付（注释备案），留给后续卡。
