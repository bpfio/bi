> 【归档说明】kimi(minimax) session_db4e6381 产出；只读评估 21.5 分钟，自跑 bun test(4928/0)+config list(73 键)；主控对 8 条 P0 逐条对树核实 7/7 直接证实（P0-5 由 bin/bi.ts 工具面装配差佐证），零幻觉。
# bi 距离「优秀 CLI agent」还有多远 —— 只读实证评估

**评估基线**：`/home/yupeng/bi` @ `179e32a`（418 commits）· 非测试源码 73,356 行 · 测试源码 76,169 行 · 274 测试文件
**我亲自跑的验证**：`bun test` → **4928 pass / 4 skip / 0 fail / 274 文件 / 93s**（4 skip 为 `BI_PTY_E2E=1` 门控的 pty 真人面）；`bun bin/bi.ts config list` → 实测 **73 键**（与 README 一致）
**只读确认**：全程未写文件，结束时 `git status --short` 与开工时一致（仅原有的 `?? docs/dispatch/2026-10-20-excel-wave/`）

---

## 1. bi 能力清单实测摘要

标注约定：**【实证】**= 我读码/跑码确认；**【宣传】**= 仅文档/注释声称；**【虚账】**= 声称存在但无生产消费者。

### 1.1 确实做出来且接上线的（【实证】）

| 能力 | 证据 |
|---|---|
| 8 件基础工具（read_file/web_fetch/web_search/glob/grep/bash/edit/write） | `packages/core/src/cli/toolset.ts:289-298` |
| AgentLoop：RWLock 冲突分组并行、路径重叠串行、二段式抢占取消、显式状态机转移表 | `packages/core/src/agent.ts:79-88, 306-346, 352-395, 469-507` |
| 权限门：会话审批记忆优先于配置规则、`Bash(git *)` 式 picomatch 匹配、**mode 不可被模型伪造** | `packages/core/src/guard/permission-gate.ts:22-25, 261-288`；`guard/permission-matcher.ts:53-115` |
| shell-scan：2443 行三阶段词法/语法/分级分析器，17 个稳定 reason code，fail-closed | `packages/core/src/sandbox/shell-scan.ts`（`:147-167, 2266-2314`） |
| PathJail：`.ssh/.gnupg/.aws/.kube/.env` + 工作区外写拦截 | `packages/core/src/sandbox/path-jail.ts:218-232, 254` |
| Read-Before-Write 写门（读→写基线，mtime 防脏写） | `packages/core/src/tool/read-file-state.ts`；`toolset.ts:410-413, 815-818, 881-887` |
| 会话 JSONL：append-only + 每条 fsync、UUIDv7 树、UTF-8 字节空间截断损坏区 | `packages/core/src/session/jsonl.ts:10-17`；`session/manager.ts:5` |
| headless 三形态输出（stream-json / text / json）+ 结构化失败面 | `packages/core/src/cli/headless.ts:434-443, 459-468` |
| 自动紧缩器：安全切点（不拆 tool_call/tool_result 配对）+ 3 击熔断 + 真实模型摘要调用 | `packages/core/src/context/compactor.ts:160-201`；`headless.ts:809-829, 890-913` |
| 子代理上下文隔离：非 fork 派生零父历史、fork 字节级克隆、递归结构上不可能 | `packages/core/src/subagent/runner.ts:324-365, 405-417` |
| 模型适配器双协议（Anthropic Messages + OpenAI Chat Completions）+ 7 类流事件 + thinking 签名无损重放 | `packages/core/src/adapters/deepseek-adapter.ts:61-63, 96-102, 181-186` |
| TUI 屏幕缓冲渲染器（虚拟终端、CJK 宽、diff 渲染、粘贴聚合、节奏化进度、Markdown 渲染） | `packages/tui/src/engine/virtual-terminal.ts`、`engine/diff-renderer.ts`、`engine/paste-burst.ts`、`render/markdown.ts` |
| 审批浮层（y 允许 / n 拒绝 / Esc 拒绝） | `packages/tui/src/mount/agent-tui.ts:261-301` |
| 16 子命令全部真实派发；退出码 0/1/2/3/4 分层 | `packages/core/src/cli/main.ts:97-161`；`cli/commands/dispatch.ts` |
| 4928 用例 0 失败；CI 跑 `bun test` + 双包 tsc | `.github/workflows/ci.yml:31-38` |

### 1.2 声称存在但无生产消费者（【虚账】）

| 声称 | 证据 | 判定 |
|---|---|---|
| `[cron] enabled` 注册 cron 三件套 | README:189；`CronService` 在全仓非测试代码中零实例化，唯一引用点是 `toolset.ts:215, 322` 的**接收缝** | **虚账** |
| `[tui]` theme/mouse_mode/notifications/show_thoughts | README:166；`packages/tui/src` 全树 grep 0 命中 | **虚账** |
| `ask_user_question` 工具 | `toolset.ts:188, 300` 只有接收缝，`UserQuestionService` 全仓零实例化 | **虚账** |
| `lsp_navigate` 符号导航 | `lspClient` 生产装配从未注入（`main.ts:398`、`bin/bi.ts:214` 均只是注释）；执行必返 `{ok:false,code:"lsp-unavailable"}`（`toolset.ts:1433-1438`） | **虚账**（工具常驻但恒失败） |
| `secondary_model.background/summarize` | `main.ts:224` 自述"消费点随后续紧缩接线跟进，本波只交付 route() 面" | **半虚账** |
| OS 沙箱（Landlock/bwrap/seatbelt 587 行） | `os-sandbox.ts:370` 的 `OsSandbox` 唯一生产引用是 `doctor.ts:144` 的探针；`toolset.ts:43-45` 明写"本卡不接线" | **虚账**（器官在，运行时不接） |
| `PathJail.checkScan`/`assertSafe`（管 bash 的那部分） | 无生产调用者；`toolset.ts:48-49` 明写"bash 不接 PathJail" | **虚账** |
| 8 个上下文模块（pruner/spill-store/cache-continuity/interruption-recovery/media-compress/tool-history-normalizer/recovery-pointer） | 零非测试导入方 | **死代码** |
| `AgentConversationUndoService`（撤销服务） | 唯一引用在 `evals/e2e-drill-b-session.test.ts:109`；`packages/tui/src/dialogs/undo-selector.ts:41-44` 恒返回 `null` | **虚账** |

### 1.3 文档与现实的漂移

- README:309 称 devplan 是「117 卡 SSOT」，实文件仅 **109 个卡号**，且**无状态列**（`grep -cE "已完成|已交付|进行中|待开发"` = 1）。真实状态散在 DEVLOG.md / `docs/audit/.../ledger-170.md` / `docs/test/coverage-.../report.md` **三个互不一致的追踪器**里。
- README:26 称「三包 tsc」，CI 只 typecheck core + tui 两包（`ci.yml:33-36`），a2a/mcp/plugins/workflow/worktree 五包不受检——而 `core/src/cli/toolset.ts:90` 还跨包 import 了 `mcp/src/lsp/lsp-tool`。
- README:292 说「双 tsconfig 类型门」，`package.json:12` 是单条 `tsc --noEmit -p tsconfig.json`。
- README:289-293 的安装指引只有 `bun install` + `bun bin/bi.ts init`；**真实可用**的 `npm i -g @bpfio/bi`（0.3.0 已在 registry）只存在于 tarball 内的 README（`scripts/npm-pack.ts:166`），GitHub 首页从不告诉用户。

---

## 2. 优秀 CLI agent 标尺（10+1 维度）

以 Claude Code / Codex CLI / aider 水准为基线，取 11 个可判定的能力维度：

1. **任务完成力** — 多步真实任务的端到端成功率
2. **工具面完备度** — 工具集覆盖度、工具本身的语义正确性
3. **上下文工程** — 紧缩/裁剪/预算感知/多模态上下文
4. **安全门禁与执行隔离** — 权限决策 + 底层强制隔离（沙箱）
5. **会话持久化与恢复** — 持久化完整性、resume/rewind/checkpoint
6. **扩展生态** — MCP 协议面、插件、子代理
7. **评测体系** — 任务级 benchmark、回归基线、正确性度量
8. **交互体验** — REPL 的产品完成度
9. **headless / 自动化契约** — CI 可用性、机器可解析、失败面
10. **性能与成本控制** — token 计量、成本路由、缓存
11. **工程纪律与分发** — 测试/CI/发布/文档一致性

标杆参照分（我的判断）：**4.3 / 5**。

---

## 3. 逐维度对照评分表

| # | 维度 | 权重 | 分数 | 加权 | 实证证据 | 差距一句话 |
|---|---|---|---|---|---|---|
| 1 | 任务完成力与主循环 | 15 | **3** | 45 | `agent.ts:306-346, 469-507` 并行/互斥调度、dedupe、repeat-breaker、写前门禁齐备；但自评 7 探针**无回答率 3/7（43%）**，失败模式全是"回合预算打满"（`docs/test/eval-2026-10-20/eval.md`） | 循环机制是 A 档，**任务级成功率从未被度量**，无从证明能稳定完成一个真仓库的多步改动 |
| 2 | 工具面完备度 | 10 | **3** | 30 | 基础 8 件齐（`toolset.ts:289-298`）+ 15 件门控挂载；但**模型侧无图像 block**（`adapters/deepseek-adapter.ts:181-186` 只有 text/thinking/tool_use/tool_result）→ `read_media_file` 的 base64 只能当文本回喂；无任务清单工具、无 LSP（恒失败）、`glob` 不排除 node_modules（`toolset.ts:440-442`）；`web_search` 只有 DeepSeek 一个 provider | 工具"数量"够，**工具"语义宽度"不够**：看不见图、无符号导航、无计划状态机 |
| 3 | 上下文工程 | 10 | **2** | 20 | AutoCompactor/WindowManager/安全切点/图像卸载/结果修剪**全部实现且接在 headless**（`headless.ts:890-913`）；但**缺省全关**（`config/schema.ts:819` 区段均 false），**TUI 零上下文管线**（`packages/tui/src` grep `AutoCompactor\|WindowManager\|boundToolText` = 0），紧缩窗口**硬编码 128K** 而非模型 `context_limit`（`headless.ts:453`），token 计数用 chars/4（`headless.ts:771-778`） | 引擎质量高但**默认不生效、交互形态完全没有**，长会话必爆窗口 |
| 4 | 安全门禁与执行隔离 | 12 | **2** | 24 | 权限决策层**强**（审批记忆优先、picomatch fail-closed、mode 不可伪造）；但**隔离层不存在**：Landlock/bwrap 587 行零运行时调用（`toolset.ts:43-45`）、shell-scan **只标注不阻断**（`toolset.ts:38-41, 680-691`）、bash 走裸 `spawn`（`toolset.ts:703`）、PathJail 不管 bash（`toolset.ts:48-49`）、`auto` 模式=全放行（`permission-gate.ts:287`） | 门是**软门**：危险命令被标注后照跑，yolo 下 bash 爆炸半径=全盘（评测自认） |
| 5 | 会话持久化与恢复 | 10 | **3** | 30 | JSONL+fsync+UUIDv7 树+损坏区字节级截断+SQLite 检索+fork/transfer/export 都实在；**但无 checkpoint**、TUI 恒 `createSession`（`agent-tui.ts:546`）无 resume、`--resume` **只重放 user/assistant 文本、tool 轮明确不重放**（`headless.ts:715-718` 自述"本面备案不重放"）、`/rewind` 只回退内存不回文件字节（`agent-tui.ts:1267-1282`）、无跨进程锁（`session/manager.ts:12`） | 存储层优秀，**恢复语义残缺**：续会话后模型不知道自己改过文件 |
| 6 | 扩展生态 | 10 | **2** | 20 | MCP **只实现 tools**（`packages/mcp/src/client.ts` 无 resources/prompts 调用）、SSE 传输是死代码（`mcp-mount.ts:14-16` 显式跳过）、无 Streamable HTTP、装配被**错误门控在 `[ptc] enabled`** 下（`main.ts:312-319`）、**TUI 完全不挂载**；插件**只解析清单不执行**（`plugins/loader.ts:20-22`）且不接进 agent；子代理**质量最高**但只在 headless 且需 `[subagent] enabled` | 子代理是亮点，**MCP/插件生态是空壳**——Claude Code 用户装一个 MCP server 在 bi 里多半跑不起来 |
| 7 | 评测体系 | 8 | **2** | 16 | 274 文件 / 4928 用例 / 85197 expect() 断言量真实可观；**但** `eval-harness.ts` 是完整框架却**全仓无 EvalCase 语料**，无任务级 benchmark、无补丁正确性、无通过率基线、无回归门、无覆盖率工具；7 探针幻觉评测是**手工记录的文档**不是可复跑套件 | 测的是**器官**，没测**任务**；无法回答"这周比上周好吗" |
| 8 | 交互体验（TUI） | 10 | **3** | 30 | 屏幕缓冲渲染器**质量确实高**（virtual-terminal / diff-renderer / CJK 宽 / 粘贴聚合 / Markdown）；10 条斜杠命令单一事实源（`candidate-menu.ts:67-78`）+ 审批浮层可用；但 **`/diff` 恒判拒绝**（`diff-view.ts:459` 未注入 confirm → reject；`bin/bi.ts:136` 只写"备案"）、`undo-selector.ts` 恒 null、thinking 不上屏、hooks 明确"无头路径专属"（`agent-tui.ts:51`）、**TUI 工具面少一大截**（`bin/bi.ts:205-226` 未传 subagentRunner/userQuestionService/cronService/codemode，MCP 也不挂） | 渲染是 A 档，**REPL 产品面是 C 档**：命令目录里近半命令在默认配置下不工作 |
| 9 | headless / 自动化契约 | 8 | **3** | 24 | 三形态输出 + 结构化失败面（`rounds-exceeded`/`turn-timeout`/`session-not-found`/`hook-blocked`/`permission-ask-unavailable-in-headless`）+ 退出码分层 + `--resume/--agent-file/--max-rounds/--output-format/--add-dir`，**失败面诚实度高于 aider 水准**；但**无 stdin 管道模式**（`--prompt` 必须给串）、无 `--continue`、MCP 门控错位 | 失败面设计是**真优势**；但**缺管道**这一条就卡住大部分 CI/脚本集成 |
| 10 | 性能与成本控制 | 3 | **2** | 6 | TokenHud、usage 汇总（input/output/cached/reasoning）、TTL 缓存、限速器、prompt-cache 套件 + cache-warmer 都在；但**无 per-task 成本预算/上限键**、成本路由槽位（background/summarize）无消费方、计数非真 tokenizer | 有计量**无控费**：模型选贵的还是便宜的，全看用户自己配 |
| 11 | 工程纪律与分发 | 4 | **3** | 12 | 4928/0 真绿、单测密度高于源码量、结构化错误贯彻到底、密钥只走 env 间接引用、三级 TOML；但**无发布自动化**（`.github/workflows/` 只有 `ci.yml`；`npm-pack.ts:18` 明写"本脚本不发布"）、CI 不 typecheck 五包、不 build/不打包即 CI 失败不暴露、README 不给安装路径、devplan 非状态 SSOT | 造得出来，**发不出去**：发布是手工步骤，文档与实际漂移已系统化 |

### 加权总分

```
45 + 30 + 20 + 24 + 30 + 20 + 16 + 30 + 24 + 6 + 12 = 257
257 / 100 = 2.57 / 5.00  (≈51%)
标杆参照分 4.30 / 5.00
差距 ≈ 1.73 分 ≈ 34 个百分点 ≈ 一整个大版本代差
```

---

## 4. 差距分级清单

### P0 — 现有功能坏 / 错（缺陷，必须先修）

| # | 缺陷 | 证据 | 代价 | 优先级 |
|---|---|---|---|---|
| P0-1 | **`/diff` 审查门恒判拒绝** — 用户执行 `/diff` 永远看到"拒绝"，因为 confirm 端口从未注册 | `packages/tui/src/diff-view.ts:459`；`packages/tui/src/mount/diff-gate.ts:64`；`bin/bi.ts:136`（只写备案注释） | **S** | 立刻 |
| P0-2 | **`[cron]` 是纯虚账** — README 宣称注册 cron 三件套，`CronService` 全仓零实例化 | README:189；`toolset.ts:215, 322` | **S** | 立刻 |
| P0-3 | **`[tui]` 四键零消费者** — 用户配了 theme/mouse/notifications 无任何效果（死配置键比没有更伤） | README:166；`packages/tui/src` grep 0 | **S** | 立刻 |
| P0-4 | **`lsp_navigate` 常驻失败** — 开启 `[tools] lsp` 后工具挂载但每次执行必返 `lsp-unavailable` | `toolset.ts:1433-1438`；`main.ts:398`；`bin/bi.ts:214` | **S**（摘键）/ **M**（接真 server） | 立刻 |
| P0-5 | **TUI 工具面显著小于 headless** — 交互形态下 `spawn_subagent`/`ask_user_question`/`run_js`/cron 三件/MCP 工具**全部不存在** | `bin/bi.ts:205-226`（对比 `main.ts:330-400` 传了 codemode 等） | **M** | 高 |
| P0-6 | **MCP 被错误门控在 `[ptc] enabled` 之下** — 用户配 `[mcp.servers]` 不配 `[ptc]` 则 MCP 静默不挂载，README 未披露此耦合 | `main.ts:312-319`；README:194 | **S** | 立刻 |
| P0-7 | **`--resume` 丢失全部工具历史** — 续会话只重放 user/assistant 文本，tool 轮明确不重放，模型**不知道自己已经改过文件** | `headless.ts:715-718`（"本面备案不重放"） | **M** | 高 |
| P0-8 | **REPL 无会话恢复** — `agent-tui.ts` 恒 `createSession`，`--resume` 只在 headless | `agent-tui.ts:546`；`main.ts:444-446` | **S** | 高 |

### P1 — 有但明显弱于标尺（短板）

| # | 短板 | 证据 | 代价 | 优先级 |
|---|---|---|---|---|
| P1-1 | **OS 沙箱零运行时调用** — 587 行 Landlock/bwrap/seatbelt 全在库里睡觉，bash 裸 spawn | `os-sandbox.ts:370`；`toolset.ts:43-45, 703` | **M** | 最高 |
| P1-2 | **shell-scan 只标注不阻断** — 危险命令被标 `[shell-scan:dangerous]` 后照执行；bash 不受 PathJail 约束 | `toolset.ts:38-41, 48-49, 680-691` | **M** | 最高 |
| P1-3 | **上下文引擎默认全关 + TUI 零管线** — 交互形态长会话必爆上下文 | `config/schema.ts:819` 区；`packages/tui/src` grep = 0 | **M** | 最高 |
| P1-4 | **紧缩窗口硬编码 128K** 而非模型真实 `context_limit`；token 用 chars/4 估 | `headless.ts:453, 771-778` | **S** | 高 |
| P1-5 | **无任务级评测/无回归基线** — harness 是完整框架却无任何语料 | `packages/core/src/evals/eval-harness.ts`（零调用方） | **M** | 高 |
| P1-6 | **模型无图像输入通道** — 适配器 content block 无 image 变体，`read_media_file` 的 base64 只能作文本回喂 | `adapters/deepseek-adapter.ts:181-186, 217-225` | **L** | 中高 |
| P1-7 | **MCP 协议面只有 tools** — 无 resources/prompts、SSE 是死代码、无 Streamable HTTP | `packages/mcp/src/client.ts`；`mcp-mount.ts:14-16` | **M** | 中高 |
| P1-8 | **插件只解析不执行**，且不接进 agent（plugin skills 不注册、plugin mcpServers 不启动） | `plugins/loader.ts:20-22, 78-79` | **L** | 中 |
| P1-9 | **撤销/回退是空壳** — undo 服务零生产调用、`undo-selector` 恒 null、`/rewind` 不恢复文件字节 | `undo-service.ts:29-35`；`undo-selector.ts:41-44`；`agent-tui.ts:1267-1282` | **M** | 中 |
| P1-10 | **无发布自动化** — npm publish 手工，CI 不 build/不打包，5 个包不被 typecheck | `.github/workflows/ci.yml`；`npm-pack.ts:18`；`ci.yml:33-36` | **S** | 中 |
| P1-11 | **README 不给安装路径** — `npm i -g @bpfio/bi` 真实可用却只存在于 tarball 内 | README:289-293 vs `npm-pack.ts:166` | **S** | 中 |
| P1-12 | **8 个上下文模块 + undo + sandbox 三块死代码** — 维护面与产品面脱节 | 见 §1.2 | **S**（删）/ **M**（接） | 中低 |

### P2 — 标尺有而 bi 没有（空白）

| # | 空白 | 标尺参照 | 代价 | 优先级 |
|---|---|---|---|---|
| P2-1 | **stdin 管道模式**（`bi -p` 读管道 / `--prompt -`） | Claude Code `-p`、aider | **S** | 高 |
| P2-2 | **会话选择器 / `--continue` 接最近会话** | Claude Code / Codex | **S** | 高 |
| P2-3 | **任务清单工具面（TodoWrite 类）** — workflow 包的 todo-service 未暴露给模型 | Claude Code | **M** | 中高 |
| P2-4 | **成本路由消费点** — `secondary_model.background/summarize` 无消费者 | Codex | **M** | 中 |
| P2-5 | **覆盖率/lint/格式化门** — package.json 只有 test/typecheck/build:bin | 通用工程基线 | **S** | 中 |
| P2-6 | **公共基准可比分（SWE-bench 类）** — 连私有语料都没有，谈不上可比 | 行业通行 | **L** | 中低 |
| P2-7 | **可编辑 diff 块 / repo map / 自动 commit** | aider | **L** | 低 |
| P2-8 | **per-task token/成本预算上限** — 现有只有回合数与单轮工具数，无金额闸 | Claude Code / Codex | **M** | 中 |
| P2-9 | **多搜索 provider** — `web_search` 只有 DeepSeek 一个 | 通用 | **S** | 低 |
| P2-10 | **Google/Gemini provider 声明但未实现** — schema 接受，运行时结构化报错 | 通用 | **S** | 低 |

---

## 5. 总评与结论

### 总分

**2.57 / 5.00（加权 257/100，约 51%）** ｜ 标杆参照 4.30 ｜ **差距 ≈ 1.73 分 / 34 个百分点**

### 一句话回答「距离优秀还有多远」

> **还差一整个大版本代。** bi 是一台**器官质量高于平均、工程纪律扎实、但"生产接线面"系统性薄于"库态能力面"的 agent**——它的仓库里装着一个 Claude Code 60% 的零件，却只装配出了约一半的产品。
> 具体说：**headless 形态**已接近可用且在失败面诚实度上**超过** aider（结构化 `rounds-exceeded`/`turn-timeout`/权限拒、退出码分层、三形态输出），这一半**离优秀只差一档**（主要差 MCP 协议面、任务级评测、上下文默认生效）。
> **交互 REPL 形态**才是真正的鸿沟：工具面少一大截、无 resume、`/diff` 恒拒、无上下文管线、无 MCP/子代理、thinking 不上屏、4 条斜杠命令在默认配置下不工作——而 Claude Code/Codex 80% 的使用时间都在这个形态里。
> **安全层是硬伤**：权限决策做得比标尺好，但决策之下**没有强制隔离**（Landlock 全在库里睡觉，shell-scan 只标注不阻断，yolo 下 bash 爆炸半径=全盘）——标尺两家都有运行时隔离层。

### 补齐里程碑排序（前 5，最值）

| 序 | 里程碑 | 为什么最值 | 代价 |
|---|---|---|---|
| **1** | **把隔离层接上**：OsSandbox 装进 bash 执行路径 + shell-scan 升级为**阻断**（dangerous/opaque 默认拒） | 这是唯一一处"**做错了比没做更糟**"的地方——当前形态下 `rm -rf /` 在 manual 审批通过后照跑。改完后 bi 的安全叙事才立得住 | M |
| **2** | **补齐交互形态**：TUI 接上上下文管线 + MCP + 子代理 + resume + `/diff` 真实审批（注入 confirm）+ thinking 上屏 | 交互面是主战场，也是当前最大缺口。补完后 REPL 从 C 档直接到 B 档 | M |
| **3** | **上下文工程默认打开 + 窗口对齐模型真实 context_limit** | 单点改动（`schema.ts` 缺省值 + `headless.ts:453` 取 `models.entries[].context_limit`），**收益/代价比最高**。顺带把 TUI 紧缩接上 | S–M |
| **4** | **建任务级评测基线**：给 `eval-harness.ts` 灌 20–30 条真实仓库任务语料（成功/失败判据 + 补丁正确性），进 CI 做回归门 | 这是从"工程好"到"产品可信"的跃迁；没有它，任何后续优化都无法证明。仓库已有框架，只缺语料 | M |
| **5** | **MCP 打穿 + 发布自动化**：`[mcp]` 独立门控（解耦 `[ptc]`）+ 加 resources/prompts + Streamable HTTP；同步上 CI 发布流水线与 README 安装路径 | MCP 是"能不能被集成"的开关；发布自动化是"能不能被用上"的开关。两件都是一次投入长期回报 | M（S 发布自动化 / M-L MCP） |

**外加一条 5 分钟的止损**：把 P0-2/P0-3/P0-4/P0-6 这四个虚账键**要么接线、要么从 README 删掉**。当前状态下 README 主动宣传的能力有 4 项是假的——在一个以"不虚账"为荣的仓库里，这比能力缺失更伤。

---

**验证说明**：本报告全部结论来自 `/home/yupeng/bi` 工作树源码阅读 + 一次完整 `bun test`（4928/0）+ `bi config list` 实测（73 键）；两处子代理调研的结论均已由我独立 grep/读码复核（未复核项已在文中标注为文档出处而非实证）。全程只读，结束时仓库工作树与开工时一致。
