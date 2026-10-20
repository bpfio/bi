# bi 开发台账逐项检查 — 批 4/6（清单项 86-113）

- 仓库：`/home/yupeng/bi`（只读审计，未修改任何仓库文件）
- 清单来源：`/tmp/bi-ledger-170.md`
- 编号口径：按工单给定的「清单项 86-113 + 卡 id」清单核对（对应台账文件第三分片中 BI-19.8 … BI-25.2，即文件内行 101-128；工单编号较文件行号前移 15）。
- 证据口径：代码模块 / 测试文件 / 文档 / 构建脚本四类；并按项目自订纪律「库存在≠功能存在，验收要查接线面」（DEVLOG 行 413）额外核查生产接线面。

## 逐项结论

| 项 | 卡id | verdict | 证据/说明 |
| --- | --- | --- | --- |
| 86 | BI-19.8 | CONFIRMED | `packages/tui/src/render/latex.ts`（397 行，renderLatex/renderLatexDetailed）+ `math-lexer.ts` + `latex.test.ts`（196 行），commit `ed85adc`。**已接线**：`render/markdown.ts:251` 对 latex/tex/math 围栏走 renderLatex → `transcript-styled.ts` → `mount/agent-tui.ts:81` 上屏。复跑 latex.test.ts 通过（批 A 169 pass / 0 fail）。 |
| 87 | BI-20 | PARTIAL | 两个子交付物一半接线：`/doctor` 体检**已接线**——`packages/core/src/doctor.ts`（340 行）+ `doctor.test.ts`（252 行），`cli/commands/dispatch.ts:684` 调 `runDoctor`，即 `bi doctor` 命令面。交互式 Git Unified Diff 审查门**仅库面**——`packages/tui/src/diff-view.ts`（644 行，含 `parseDiff` 解析 `diff --git`/`@@ -a,b +c,d @@`、`buildDiffFromFiles`、交互门）+ `diff-view.test.ts`（351 行），commit `4ebb049`；但全仓检索**无生产导入方**（`tui/src/index.ts` 导出的 `DiffRenderer` 是 `engine/diff-renderer.ts` 的双缓冲终端渲染器，与本文件无关；`diff-view.ts` 未被 index.ts 导出）。缺口：审查门无 CLI/TUI 入口，仅由 `evals/e2e-drill-i-tui.test.ts` 域 I 间接驱动。 |
| 88 | BI-20.1 | PARTIAL | 模块在库但零生产接线：`packages/core/src/modes/mode-selector.ts`（ModeId = plan/edit/build/yolo，MODE_ORDER 钉死循环，plan 态经只读端口结构化拒绝 `plan-mode-readonly`）+ `mode-selector.test.ts`（198 行），commit `4e8be45`。全仓检索仅 `tui/src/components/mode-indicator.ts:4` 一句注释引用 MODE_LABELS，**无 import**；`builtinSlashCandidates`（`candidate-menu.ts:52`）亦无 `/mode` 命令。成品层的模式面由 BI-28.3 另行实现（`cli/permission-mode.ts` + `PermissionGate` + `/permissions` 命令面），语义是 default/plan→manual 三态，非本卡四态循环。缺口：四态切换器在 CLI/REPL 无入口。 |
| 89 | BI-20.2 | CONFIRMED | `packages/core/src/cli/commands/args.ts`（GLOBAL_ARGS 参数矩阵 + `parseGlobalArgs`，含 unknown-flag / missing-value / invalid-value / duplicate-flag 结构化错误）+ `args.test.ts`（144 行）；子命令群 `commands/export.ts`、`fork.ts`、`session.ts`（含 `pruneOrphans` 安全阀，即 commit msg 所称 prune）+ 各自 test，commit `4fa7ad0`。复跑 args.test.ts 19 例全绿。 |
| 90 | BI-20.2b | CONFIRMED | flag 装配消费双面落地：`cli/main.ts:166-193`（`--agent-file` 读 Markdown → 系统指令；`--add-dir` 存在性/目录校验，缺失或非目录 → 结构化 exit 2）+ `cli/headless.ts:459-465`（系统指令前置注入、附加目录聚合透传）+ `cli/commands/args.ts:35-41`（flag 声明，--add-dir 可重复）+ 新增 `cli/agent-file-addir.test.ts`。与 DEVLOG 行 409「B1 BI-20.2b flag 装配消费」逐项吻合。 |
| 91 | BI-20.3 | CONFIRMED | `packages/core/src/export/html-exporter.ts`（单文件自包含 HTML + 内联 CSS）+ `ansi-to-html.ts` + `html-exporter.test.ts`（158 行）+ `cli/commands/export.ts`（EXPORT_FORMATS = markdown/json/html，`--format html` 已接线，`export.test.ts` 12 例）。原始 commit `fc30d5f` 曾是**孤儿实现**（CLI 未接线，DEVLOG 行 413 记为典型反例），由 BI-20.3b/B2 补接线后现为可用。 |
| 92 | BI-20.5 | PARTIAL | 两个器官模块在库且测试充分：`packages/core/src/web/vis-handler.ts`（412 行，本地 Web 服务器 + 令牌校验 + /api/sessions、/api/session/:id、/api/entry/:id 路由）+ `vis-handler.test.ts`（243 行）；`packages/tui/src/vis/token-rotator.ts`（201 行，128-bit 令牌 / 默认 5 分钟轮转 / 60 秒宽限双活 / accessUrls）+ `token-rotator.test.ts`（232 行）+ `vis-integration.test.ts`（97 行），commit `736369d`。**但两个模块均无生产导入方**：检索仅 `vis-handler.ts:18` 一句注释提及 TokenRotator；上线的 `bi vis` CLI 走的是 BI-20.5b 另起炉灶的 `cli/commands/vis.ts`（其头注明确「v1 不做 … 令牌轮转 / 多网卡地址」）。缺口：**令牌轮转引擎在成品层无入口**。 |
| 93 | BI-20.5a | CONFIRMED | 只读侦察交付物落盘：`docs/dispatch/2026-10-19-subcmd1/b3-vis-recon-report.md`（kimi vis 架构一页纸、apps/vis 包结构、Vite+React 构建栈、server 路由清单）+ 同目录 `b3-vis-recon-brief.txt` 任务书。报告自述「Read-only reconnaissance complete. All findings below are from actual file reads (no writes, no code changes)」，与 DEVLOG 行 411「B3 BI-20.5a vis 只读侦察 | 零只写」一致。 |
| 94 | BI-20.5b | CONFIRMED | `packages/core/src/cli/commands/vis.ts`（657 行：Bun.serve 绑 127.0.0.1、端口 0 随机、--host 非回环强制 `BI_VIS_AUTH_TOKEN`、401 先于 404 防枚举、sessionId 白名单防穿越、前端全 textContent 零 XSS）+ `vis.test.ts`（325 行）+ `cli/commands/dispatch.ts:65/697/720` 注册（SUBCOMMANDS 含 "vis"）。与 DEVLOG 行 427「C1 BI-20.5b bi vis v1」吻合。 |
| 95 | BI-20.6 | CONFIRMED | `packages/core/src/cli/commands/acp-command.ts`（309 行，stdio JSON-RPC 帧、端口注入装配 AcpAgentPort）+ `acp-command.test.ts`（255 行，commit `711a7f6` 补测）；桥接本体 `packages/mcp/src/acp/acp-bridge.ts`（601 行）+ `acp-bridge.test.ts`（498 行），commit `5e7f5d5`。复跑全绿（批 B 142 pass / 0 fail）。 |
| 96 | BI-20.7 | CONFIRMED | `packages/core/src/cli/update/upgrade-command.ts`（178 行，五步：manifest check → download → sha256 校验（不匹配删 .part）→ stageDownload → swapBinary unlink→rename 原子替换 + installLock）+ `native-swap.ts`（407 行）+ `upgrade-subcommand.ts` + `native-swap.test.ts`（322 行）+ `upgrade-command.test.ts`（251 行），commit `711a7f6`。已接线：dispatch.ts 的 `upgrade` 子命令。 |
| 97 | BI-20.3b | CONFIRMED | `packages/core/src/export/html-exporter.ts` 双主题（HTML_THEMES dark/light，dark 缺省 byte-identical）+ `ToolHtmlRenderer` 插件面接口（`html-exporter.ts:49/57`，被 `renderStandaloneResult:191` / `renderToolCall:211` 消费）+ `html-exporter.test.ts`（+100 例，含插件面用例）+ `cli/commands/export.ts`（theme 参数 dispatch，+15 行），commit `04629f1`。注：独立 `export/tool-renderers.ts` 后来作为零引用死码删除（DEVLOG 行 413），插件面以接口形式内嵌于 html-exporter.ts。 |
| 98 | BI-21 | CONFIRMED | 演练交付物已落盘且可复现：`docs/E2E_DRILL_REPORT.md`（场景 A 宏观政策数据审计 + 11 域 A-K 验收矩阵，判定 PASS，44 测试/575 断言，零 DEGRADED）+ `packages/core/src/evals/e2e-drill.test.ts`（481 行，链 1-6）+ `e2e-drill-b..k.test.ts`（10 个域文件）+ 夹具 `evals/fixtures/e2e-drill/`（gazette.html 红头公报 / gazette-layout.ts 双栏版面生成器 / gen_drill_xlsx.py 三表账簿 / drill-data.ts 单一数字源）。commits `3d212ee` + `4610bc0`。我复跑 7 个演练文件 **37 pass / 0 fail**。备案：矩阵止步 104 卡时代，BI-23/24/25 三族未入阵（DEVLOG 行 294），补入阵归 BI-26.1 卡。 |
| 99 | BI-21.1 | CONFIRMED | `packages/core/src/verifier/target-verifier.ts`（453 行，TargetContract 完工自验看门狗：读盘为唯一真相源、predicate 纯函数直调、command 白名单、差距清单 gaps 回注自愈）+ `target-verifier.test.ts`（617 行），commit `235551c`。复跑通过（批 C 165 pass / 0 fail）。 |
| 100 | BI-21.2 | CONFIRMED | `packages/workflow/src/deliverables/workspace-tracker.ts`（captureBaseline 记 HEAD + `git status --porcelain -z` 快照 / changesSinceBaseline 走 `git diff --numstat` + porcelain 差分 / renderChangeCard 确定性渲染 + 结构化错误 not-a-git-repo / no-baseline / git-failed）+ `present-tool.ts`（交付指纹 deliveryFingerprint）+ 各自 test，commit `48b5e26`。复跑通过。 |
| 101 | BI-21.3 | CONFIRMED | `packages/core/src/evals/eval-harness.ts`（575 行，确定性无头评测装置：虚拟工作区、modelScript 预编排回放、工具 stub、有界并发池、超时中止）+ `eval-report.ts`（181 行，基准打分看板）+ `eval-harness.test.ts`（656 行）+ `eval-report.test.ts`（242 行），commit `aee8e67`。复跑通过。 |
| 102 | BI-22 | CONFIRMED | `scripts/build-bin.ts`（`bun build --compile --minify --sourcemap=none --target`，目标矩阵 linux-x64/darwin-arm64 交叉编译降级为 warnings、sha256 sidecar、`--check` 校验模式、`--embed` 静态资产 manifest）+ `scripts/build-bin.test.ts`；根 `package.json` `"build:bin": "bun scripts/build-bin.ts"`（commit `732ba01`）；产物 `dist/bin/bi`（95MB linux-x64）+ `dist/bin/bi-darwin-arm64` + `bi.sha256`/`bi-darwin-arm64.sha256`。备注：dist 内二进制当前自报 `bi 0.2.0`（2026-10-18 构建），源码版本已 0.2.1 —— 产物滞后，脚本可重建；registry 发布动作由 BI-25.4 `scripts/npm-pack.ts` + DEVLOG 发布回执承载。 |
| 103 | BI-23 | CONFIRMED | 父卡 rollup，三子卡证据链齐备：23.1 `75c466f` / 23.2 `b678fb6` / 23.3 `73b5d29`（DEVLOG 行 229 rollup 记 5+6+实弹用例数）。总装面锚点：`bin/bi.ts`、`packages/core/src/cli/main.ts`、`packages/tui/src/mount/agent-tui.ts`。 |
| 104 | BI-23.1 | CONFIRMED | `bin/bi.ts`（bi 真入口）+ `packages/core/src/cli/main.ts`（runBi 分发，退出码 0 会话 ok / 2 参数与未知子命令 / 3 无模型端口 / 4 已识别未接线）+ `packages/core/src/cli/headless.ts`（332 行，无头确定性端到端）+ `scripts/build-bin.ts`（编译 entry 改指 bin/bi.ts），commit `75c466f`。复跑 `cli/headless.test.ts`（254 行）通过（批 E 164 pass / 0 fail）。 |
| 105 | BI-23.2 | CONFIRMED | `packages/tui/src/mount/agent-tui.ts`（461 行，双缓冲投影 TranscriptProjection L1→L3 + 差分帧；审批 ask 回路 y/n/Esc，deny 结构化 permission-denied 回喂模型；Esc 二段取消 thinking→paused+流 abort、窗口内二段→exit）+ `agent-tui.test.ts`（341 行，注入渲染面 6 用例）+ `packages/tui/src/index.ts` 导出挂载面，commit `b678fb6`。 |
| 106 | BI-23.3 | CONFIRMED | `packages/core/src/cli/model-port.ts`（220 行，`resolveModelPort` 配置选择链 models.default→entries→provider→kind→WireMode + BI-02 凭据门 api_key_env 间接引用、key 只经环境变量永不落盘 + thinking 档位映射）+ `model-port.test.ts`（249 行）+ `scripts/ignition-real-model.ts`（244 行实弹 e2e 脚本），commit `73b5d29`。复跑 model-port.test.ts 通过。备注：实弹脚本默认零外呼（需 `BI_IGNITION=1` + 真实 key），仓库面可验证的是门控 + 装配 + 脚本本体；真实模型 PASS 记录在 DEVLOG 行 215。 |
| 107 | BI-24 | CONFIRMED | 父卡 rollup：BI-24.1 `28b6486`（八子命令分发）+ BI-24.2 `28b6486`（行编辑器 REPL）。总装面锚点：`packages/core/src/cli/commands/dispatch.ts`（681 行）、`packages/tui/src/mount/repl.ts`（414 行）。复跑 `subcommands.test.ts`（417 行）+ `repl.test.ts`（545 行）全绿。 |
| 108 | BI-24.1 | CONFIRMED | `packages/core/src/cli/commands/dispatch.ts:75-86` `SUBCOMMANDS` = init / session / fork / export / transfer / acp / upgrade / doctor（八子命令齐），后续补 vis / config / copy；各命令真实参数面 + `SUBCOMMAND_SUMMARIES` + help 面；`packages/core/src/cli/subcommands.test.ts`（417 行，注入式用例）；`bin/bi.ts` 全局旗标后切 argv 的 `findSubcommandIndex` 派发。commit `28b6486`。 |
| 109 | BI-24.2 | CONFIRMED | `packages/tui/src/mount/repl.ts`（LineEditor 单行编辑 + KeyStream 单消费键流 + PromptView + `runRepl` 主回路：审批浮层全键 dispatchKey / running 态 Esc 二段取消 / idle 编辑）+ `repl.test.ts`（545 行，13 条注入键流用例），commit `28b6486`；`tui/src/index.ts` 导出挂载面。 |
| 110 | BI-24.3 | CONFIRMED | `packages/tui/src/mount/agent-tui.ts`（状态条独占 rows-2、转录窗收缩 rows-2、TranscriptView 改读 session.rows 单一来源、新增 `resize(rows, cols)`）+ `bin/bi.ts:145-153`（注入 `process.stdout.rows/columns` + SIGWINCH 跟随），commit `7c9189a`（版本 0.1.2，历史版本号现已 0.2.1）。交叉核：真人 TTY 回归已入库 `scripts/pty-repl.test.ts` + `scripts/pty-probe.py`（40×100 真伪终端，断言状态行第 39 行 / 提示行第 40 行 / 无 "anual]" 叠写乱码 / 输入回环，门控 `BI_PTY_E2E=1`）。 |
| 111 | BI-25 | CONFIRMED | 父卡 rollup，五子卡闭合（DEVLOG 行 263-267 表）：25.1 `ee77698` 工具注册面 / 25.2 `ee77698` acp 桥接 / 25.3 `ee77698` REPL 增强 / 25.4 `24c01af→5ffb2ba` npm 发布面 / 25.5 `0391e38` 发布物编译入口修复。锚点：`cli/toolset.ts`、`cli/commands/acp-session.ts`、`tui/src/mount/repl.ts`、`scripts/npm-pack.ts`、`scripts/build-bin.ts`。 |
| 112 | BI-25.1 | CONFIRMED | `packages/core/src/cli/toolset.ts`（213 行，`buildDefaultToolset(cwd)`：read_file（段级 cwd 逃逸守卫）+ web_fetch（BI-07.15 器官）+ web_search（env 密钥门 + TTL 缓存 + 令牌桶），后续由 BI-28 扩 bash/edit/write/glob/grep）+ `toolset.test.ts`（250 行）；**双路径挂载**：`cli/main.ts:278`（headless）+ `bin/bi.ts`（REPL `buildDefaultToolset(process.cwd(), …)`），commit `ee77698`。复跑通过。 |
| 113 | BI-25.2 | CONFIRMED | `packages/core/src/cli/commands/acp-session.ts`（477 行，`AcpSessionConnection`：Content-Length JSON-RPC、session/new 落 UUIDv7 JSONL、session/prompt 增量 agent_message_chunk + 终帧 + 链式续聊、session/end、错误面 -32003/-32004/-32005/-32006、stdout 帧纯净）+ `acp-session.test.ts`（530 行，8 用例）+ 接线 `cli/commands/dispatch.ts:610-639`（`new AcpSessionConnection({...})`），commit `ee77698`。复跑通过（批 E）。 |

## 统计

| verdict | 项数 |
| --- | --- |
| CONFIRMED | 25 |
| PARTIAL | 3 |
| MISSING | 0 |
| UNVERIFIABLE | 0 |
| **合计** | **28**（项 86-113） |

PARTIAL 三项均为「器官库面在库 + 测试充分，但生产接线面缺失」，非交付物缺失：

- 87 BI-20 —— diff 审查门（`packages/tui/src/diff-view.ts`）无任何生产导入方，仅 `/doctor` 半边接线。
- 88 BI-20.1 —— 四态模式切换器（`packages/core/src/modes/mode-selector.ts`）零 import，成品层模式面由 BI-28.3 另建（default/plan→manual 三态）。
- 92 BI-20.5 —— `vis-handler.ts` + `token-rotator.ts` 均无生产导入方；上线的 `bi vis` 为 BI-20.5b 独立实现且 v1 明确不做令牌轮转。

## 附：本次核查的复跑记录（只读，未改仓库）

| 批次 | 测试文件 | 结果 |
| --- | --- | --- |
| A | latex / doctor / diff-view / mode-selector / args / agent-file-addir / html-exporter / cli-export（8 个） | 169 pass / 0 fail |
| B | vis-handler / token-rotator / vis-integration / vis / acp-command / acp-bridge / update×2（8 个） | 142 pass / 0 fail |
| C | target-verifier / deliverables×2 / eval-harness / eval-report / build-bin / model-port（7 个） | 165 pass / 0 fail |
| D | e2e-drill 及 b/i/j/k/l/m（7 个演练文件） | 37 pass / 0 fail |
| E | headless / agent-tui / subcommands / repl / toolset / acp-session（6 个） | 164 pass / 0 fail |

合计 **677 pass / 0 fail**。台账引用 commits（`ed85adc` `4ebb049` `4e8be45` `4fa7ad0` `fc30d5f` `736369d` `5e7f5d5` `711a7f6` `235551c` `48b5e26` `aee8e67` `3d212ee` `4610bc0` `732ba01` `75c466f` `b678fb6` `73b5d29` `28b6486` `7c9189a` `ee77698` `04629f1` `0391e38`）经 `git cat-file -e` 逐个验证存在。
