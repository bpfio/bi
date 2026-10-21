# 修复工单 FIX-A：四项 P0 装配接线（bi 仓库，写模式）

你是 bi 仓库（/home/yupeng/bi，Bun/TypeScript monorepo CLI agent）的修复工程师。以下四项缺陷已经审计确认并经主控对树核实。逐项修复，配测试，不 commit 不 push（留工作树给主控验收）。

## 统一纪律
- **不许 commit / 不许 push**；不碰 docs/**、DEVLOG.md、packages/worktree|a2a|plugins|workflow/**、packages/tui/src/mount/agent-tui.ts（那是下一单的领地）
- 改行为必须同步改/加测试（含把钉死旧行为的断言改成新期望）；README.md 只许改与本次四项直接相关的行
- 修完自跑 `bun test`（全绿）+ `bun run typecheck`（零错）再交
- 既有代码风格：中文注释、结构化错误、零行为差缺省；**严禁顺手重构无关代码**
- 最终输出结论清单（每项：改了什么文件/核心思路/测试名），不要复述过程；格式从简

## F1 [cron] 虚账接线（P0-2）
现状：README:189 宣称 `[cron] enabled` 注册会话内 cron 三件套，但 `CronService` 全仓零生产实例化（toolset.ts:215,322 只是接收缝）。`packages/core/src/cron/cron-service.ts` 已有完整服务（`constructor({core: CronCorePort})`、`create/list/remove`、`async tick(now?)` 自带触发推进）。
修复：
1. 装配层（packages/core/src/cli/main.ts 的 headless 路径 + bin/bi.ts 的 REPL 路径）：config `[cron] enabled === true` 时实例化 CronService（core 端口接仓库现成 cron 解析核，先查 cron-tools.ts / cron/ 目录里已有什么）并注入 toolset 缝，让 cron_schedule/cron_list/cron_remove 三工具真正工作。
2. 触发面：检查 cron-tools.ts 与 CronService 的 action 语义后择一：(a) 若能在不侵入 AgentLoop 状态机的前提下接 tick（如宿主层定时器 unref + action 走既有事件/消息缝），接上；(b) 若 action 语义需要会话深度集成（M 级），则本单只接「注册/列出/移除真实工作」，并把 README 该行与工具描述改为如实陈述「自动触发未接，归后续卡」。
3. 判据：**不许制造新虚账**——README 承诺的与实际接线的必须一致。

## F2 MCP 解耦 [ptc] 门控（P0-6）
现状：main.ts FX-F 段 `mountMcpServers` 仅在 `ptcSection?.enabled === true` 时调用——用户配 `[mcp.servers]` 不配 `[ptc]` 则 MCP 静默不挂载。
修复：改为「`[mcp].servers` 非空即挂载」（[ptc] 继续只管 run_ptc_script 工具）；同步改钉死旧行为的测试；README 相关行同步（若有 [ptc] 耦合描述）。

## F3 lsp_navigate 诚实化（P0-4）
现状：`[tools] lsp` 开启即挂载 lsp_navigate，但 lspClient 生产装配从未注入（main.ts:398 / bin/bi.ts:214 只是注释），工具每次执行必返 `{ok:false,code:"lsp-unavailable"}`。
修复：装配层无 lspClient 时**不挂载**该工具，并发一条结构化 warn（如 `bi: [tools] lsp=true 但本版本未提供宿主 LSP 装配，lsp_navigate 未挂载`）；有注入时照常挂载。测试两态都钉。

## F4 REPL 会话恢复（P0-8）
现状：TUI/REPL 路径恒 `createSession`（agent-tui.ts:546），`--resume` 只在 headless 生效。
修复：bin/bi.ts REPL 启动路径接受 `--resume <sessionId>`（若 CLI 解析层已定义该 flag 则复用），经 SessionManager 既有 API 重开会话并作为 REPL 初始会话；无效 id 结构化报错退出。packages/tui/src/mount/repl.ts 若需加初始会话参数可以改（仅此文件，agent-tui.ts 不碰）；SessionManager 若缺 reopen 缝，最小新增并配测试。

## 交付判据
`bun test` 全绿 + `bun run typecheck` 零错 + 每项修复在结论清单里给出对应测试文件与用例名。
