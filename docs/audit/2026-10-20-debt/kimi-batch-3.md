# bi 台账逐项检查 · 批 3/6（清单项 58-85）

- 仓库：/home/yupeng/bi（Bun/TypeScript monorepo CLI Agent），核对日期 2026-10-20，HEAD=1e4d45f
- 口径：清单项 58-85 对应台账 `/tmp/bi-ledger-170.md` 第 73-100 行（第二/三分片边界处，项号 = 台账行号 − 15）。卡 id 以台账原文为准。
- 判定含义：CONFIRMED=找到明确交付证据（代码模块+测试/文档）；PARTIAL=找到部分证据，说明缺什么；MISSING=无任何对应证据；UNVERIFIABLE=该卡性质无法从代码面验证。
- 本次 28 项全部为 feat/fix 型代码卡，逐项均可从代码面核验；无 UNVERIFIABLE、无 MISSING。
- 辅助证据源：DEVLOG.md 一节闭环台账（卡↔commit 对照表）、docs/RESEARCH.md 第二十节（卡片原始设计稿）、docs/E2E_DRILL_REPORT.md（BI-21 演练矩阵）。DEVLOG 所列 commit 均用 `git cat-file -t` 验证存在于本仓历史。

| 项 | 卡id | verdict | 证据/说明 |
|---|---|---|---|
| 58 | BI-13.3 | PARTIAL | 实现齐备但零接线。模块：`packages/core/src/mcp/tool-catalog.ts`（buildCatalog 分级命名空间 + flattenBudget 2000 token 预算渐进展现 + expandNamespace）、`packages/core/src/mcp/catalog-summarizer.ts`（单行 TS 签名摘要）、测试 `packages/core/src/mcp/catalog.test.ts`（153 行），commit 3952a75。设计稿 `docs/RESEARCH.md:1429`。**缺**：全仓无任何调用方——MCP 工具面 `packages/mcp/src/client.ts:154`（listTools）与 `:405`（toolsAcrossServers）、`packages/core/src/cli/toolset.ts`、`packages/core/src/agent.ts` 均未接入压缩器，2000 token 硬预算从未作用于真实工具名录；且卡题"预算自适应（按上下文相关度轮询展现）"未实现，实现是固定预算的逐级降级，非相关度轮转。姊妹卡 BI-13.1（`packages/mcp/src/select-tools.ts` 文件头明示"统计供 BI-13.3 压缩器消费"）与本卡从未合流。 |
| 59 | BI-14 | CONFIRMED | `packages/workflow/src/engine.ts`（883 行：YAML 子集 DSL 解析 + Kahn 分层 + 持久化检查点 + 经 14.5 recover 崩溃续跑）+ `engine.test.ts`（626 行），commit adf2b37。集成证据：`packages/core/src/evals/e2e-drill-h-workflow.test.ts` 真实代码路径实跑三节点 DAG→跨实例恢复。 |
| 60 | BI-14.1 | CONFIRMED | `packages/workflow/src/analysis/causality-graph.ts`（152 行：Kahn 拓扑排序 + 死锁检测 + mermaid 导出 + 未清洗流路径）+ `analysis/taint.ts`（151 行 污点传播），各带同名 .test.ts，commit 689a386。 |
| 61 | BI-14.2 | CONFIRMED | `packages/workflow/src/plan/plan-mode.ts`（344 行 只读降级状态机 + 可注入审批器超时）+ `plan/exit-review.ts`（版本化计划评审），commit 5a5858d。core 侧只读拦截 `packages/core/src/modes/mode-selector.ts:85`（结构化拒绝 `plan-mode-readonly`）；演练 `e2e-drill-h-workflow.test.ts` H2 实跑规划→提交→驳回→修订→批准。 |
| 62 | BI-14.3 | CONFIRMED | `packages/workflow/src/todo/todo-service.ts`（145 行 前向唯一状态迁移 + 单 in-progress 不变量）+ `todo/todo-reminder.ts`（42 行 确定性提醒主动注入），commit b99034a。 |
| 63 | BI-14.4 | CONFIRMED | `packages/workflow/src/mode-mutex.ts`（186 行 plan/swarm/tower 互斥 + goal/swarm 共存 + 强退审计轨迹）+ `mode-mutex.test.ts`（235 行），commit cf2dcc8；演练 H 域实跑互斥强退。 |
| 64 | BI-14.5 | CONFIRMED | `packages/workflow/src/durable/durable-scheduler.ts`（500 行 WAL sqlite+内存双存储 + 分页恢复扫描 + 分片定时器 + 转移表守卫）、`durable/storage.ts`、`durable/task-state.ts`（Actor 状态机），共 1854 行含测试，commit 3e2c20b。 |
| 65 | BI-15 | CONFIRMED | `packages/a2a/src/host.ts`（319 行 A2aHost：双总线接线端口 attachTransport + 角色编排 + 签名封套校验 + 拒绝审计；文件头明写"双总线接线端口"）+ `packages/a2a/src/blackboard.ts`（166 行 共享事实黑板 + 能力门控写），commit 40abb58。集成证据：`packages/core/src/evals/e2e-drill-g-mcp-a2a.test.ts`（四角色 + 黑板 + 验签防重放实跑）。 |
| 66 | BI-15.1 | CONFIRMED | `packages/a2a/src/transports/a2a-email-gateway.ts`（1063 行 手写 SMTP/IMAP 子集 + 双层白名单 fail-closed + STARTTLS 回退 + 凭据脱敏）+ 同名测试 1005 行，commit 4eb5c74。 |
| 67 | BI-15.2 | CONFIRMED | `packages/a2a/src/transports/github-a2a-hub.ts`（738 行 REST 直连分支/PR 派发 + approvedBy 合并门 + 封套往返 + 路径穿越守卫）+ 测试 804 行，commit ced1842。**台账小误**：DEVLOG.md:75 记作"含于 51c3e12"，实际提交为 ced1842（51c3e12 是 BI-08.2/08.3/06.7/07.12 那次提交），交付物本身在库。 |
| 68 | BI-15.3 | CONFIRMED | `packages/a2a/src/auth.ts`（344 行 HMAC 封套 + 重放/白名单/时钟偏移三门 + 时序安全验签）+ `packages/a2a/src/permissions.ts`（249 行 deny-by-default 角色能力矩阵），commit a97bdef；演练 G 域实跑签名/验签/能力断言。 |
| 69 | BI-15.4 | CONFIRMED | `packages/a2a/src/transports/remote-relay.ts`（642 行 出站单向 WSS 中继 + 设备注册表桥接 + 游标防轰 + 签名封套透传 + 4xxx close 语义）+ `packages/a2a/src/client/device-client.ts`（770 行），共 2374 行含测试，commit 4b0a0ff。 |
| 70 | BI-16 | CONFIRMED | `packages/a2a/src/audit.ts`（435 行：`runPython` 以 `python3 -I` 运行 + 有界捕获 + `PySandboxError` 三分类 + `extractTraceback`（含 Py3.13+ 短格式）+ `verify` 运行即验门 + `selfHealLoop` 自愈环）+ `audit.test.ts`（338 行），commit c7b1631。 |
| 71 | BI-16.1 | PARTIAL | 沙箱本体齐备但卡题"JS/TS"仅落地 JS 一半。`packages/a2a/src/codemode/vm-runner.ts`（148 行 node:vm 全新 guest realm、console 捕获白名单、100ms 超时、64KB 代码上限、零工具注入接缝③）+ `codemode/worker-pool.ts` + `vm-runner.test.ts`（157 行），commit 854a910。**缺**：① 无任何转译/类型擦除步骤（全仓 grep 无 Transpiler/transpile/stripTypes），`vm.Script` 无法解析类型注解，故 TS 源码不可执行（模块头自述"运行一段纯计算 JS 代码"，docs/RESEARCH.md:1086 亦写"JS 沙箱"）；② `worker-pool.ts` 文件头自述为"promise 队列并发上限"，非 RESEARCH 稿所写的真 worker 线程并行（已自认归后续卡）。 |
| 72 | BI-16.2 | CONFIRMED | `packages/core/src/ptc/tool-compiler.ts`（323 行 JSON Schema→TS d.ts / pyi 双形态声明 + sanitizer + 去重 + 深度折叠）+ `ptc-runner.ts`（340 行 tools Proxy 单轮执行 + 静态扫描拒名单 fail-closed + 参数遮蔽 Function 域 + 30s 竞速超时 + 调用预算），1332 行含 43 测试，commit 91a60eb。 |
| 73 | BI-17 | CONFIRMED | `packages/plugins/src/loader.ts`（531 行 双协议声明式解析：`.claude-plugin/plugin.json` > `.zcode-plugin/plugin.json` > `plugin.json`，手写 YAML frontmatter 子集，零代码执行/零 spawn）+ `packages/plugins/src/marketplace.ts`（212 行）+ loader.test.ts（400 行）/marketplace.test.ts（205 行），commit 10ab65f。 |
| 74 | BI-18 | CONFIRMED | 研报插件资产落位于 `presets/plugins/`：`spreadsheets/SKILL.md` + `spreadsheets/scripts/xlsx_audit.py`（306 行 勾稽引擎：合计/借贷/同比环比校验）、`pdf/SKILL.md` + `pdf/scripts/pdf_extract.py`（204 行 零依赖双栏抽取：中缝切分 + 全角块 + 页眉页脚剥离 + y 序），commit 474277f（commit 记 py_compile + 冒烟验证）；`presets/README.md` 说明落位约定。 |
| 75 | BI-18.1 | CONFIRMED | `presets/plugins/superpowers/SKILL.md`（总纲 91 行）+ 四技能 `skills/{subagent-driven-development,systematic-debugging,using-git-worktrees,verification-before-completion}/SKILL.md`（93/105/95/88 行），共 472 行，commit d709163。 |
| 76 | BI-18.2 | CONFIRMED | `presets/plugins/visualize/visual-judge.ts`（246 行 capture/vision 端口对 + render→capture→judge 自愈状态机 maxRounds=2 + 不可捕获降级 + 契约导出）+ `visual-judge.test.ts`（461 行，27 测试）+ `skills/visual-judge.md`，commit e7cdcb2。 |
| 77 | BI-18.3 | CONFIRMED | `presets/plugins/document/office-converter.ts`（195 行 docx/pptx→PDF：可注入 soffice 命令模板 + %PDF- 魔数校验 + 5 类结构化错误码，不抛异常）+ `pdf-pipeline.ts`（305 行 pdftoppm 分页切片 + 结构化 VisionJudgeLike 本地类型零跨插件耦合 + 按页 SKIP_AUDIT_NOTE 优雅降级），1041 行含 30 测试，commit 464edde。 |
| 78 | BI-19 | CONFIRMED | `packages/tui/src/engine/virtual-terminal.ts`（双缓冲虚拟终端）+ `engine/diff-renderer.ts`（445 行 差分帧渲染）+ `engine/paste-burst.ts`（212 行 PasteBurst 防冲看门狗）+ `components/cjk-width.ts`（185 行）+ 组件栈（tui-app/paste-banner/read-group/swarm-progress/thought-card），commit 0be5704。挂载证据：`packages/tui/src/mount/agent-tui.ts`（双缓冲投影 + 审批 ask 回路 + Esc 二段取消）；演练 `packages/core/src/evals/e2e-drill-i-tui.test.ts` 实跑 DiffRenderer/VirtualTerminal。 |
| 79 | BI-19.1 | CONFIRMED | `packages/tui/src/transcript-projection.ts`（四层同构投影 L1 memory→L2 history 行→L3 CJK 贪心折行 view→L4 markdown 导出 + `assertProjectionInvariants` 运行期不变式断言 + 增量 append 不重算）+ `packages/tui/src/transcript-styled.ts`，commit cc8e326；演练 I 域实跑投影不变式。**台账小误**：DEVLOG.md:99 记作 591daef（该提交实为 BI-04.4/BI-01.2），真实提交为 cc8e326。 |
| 80 | BI-19.2 | CONFIRMED | `packages/tui/src/engine/output-buffer.ts`（108 行 UTF-8 边界安全 + 帧率自适应节流 + 容量上限 DEFAULT_CAPACITY_BYTES）+ `engine/paced-progress.ts`（86 行 缓动进度），commit 622dae2；两件均由 `packages/tui/src/index.ts:55-61` 对外导出。 |
| 81 | BI-19.3 | CONFIRMED | `packages/tui/src/notify/desktop-notify.ts`（110 行 三平台引号转义 + 桌面原生通知）+ `notify/nudge-service.ts`（146 行 终端蜂鸣单次催促看门狗），commit 7633148；`packages/tui/src/index.ts:64` 导出。 |
| 82 | BI-19.4 | CONFIRMED | `packages/tui/src/clipboard/clipboard-text.ts`（218 行 三平台文本命令矩阵 pbcopy/xclip/wl/powershell）+ `clipboard-image.ts`（289 行 图像探针链 + PNG 魔数校验 + SHA-256 内容寻址去重落 ~/.bi/attachments）+ `commands/copy.ts`（110 行 /copy 命令 围栏代码块逐字节保全格式化），共 1327 行含 54 测试，commit 738e358。 |
| 83 | BI-19.5 | CONFIRMED | `packages/tui/src/editor/external-editor.ts`（180 行 VISUAL/EDITOR 探测 + BOM 剥离 + suspend/resume）+ `packages/tui/src/commands/edit-prompt.ts`（61 行 长提示词交互微调桥），commit 6438175；`editPromptCommand` 已被 `packages/tui/src/mount/repl.ts` 引用（运行面接线）。 |
| 84 | BI-19.6 | CONFIRMED | `packages/tui/src/merman/mermaid-renderer.ts`（467 行：flowchart TD/LR 分层布局 + 链式边 + sequenceDiagram 生命线 + 不支持语法返回结构化错误行）+ `merman/canvas.ts`（191 行 Unicode 方框线字符画布），commit ed85adc；已被 `packages/tui/src/render/markdown.ts:29` 接入渲染面，并在演练 I 域实跑。 |
| 85 | BI-19.7 | CONFIRMED | `packages/tui/src/chord/delta-tracker.ts`（267 行 DeltaTracker：深冻结 snapshot + structuredClone 草稿深比对自实现 RFC 6902 patch（add/remove/replace，数组序号指针/对象转义指针）+ apply 子集重放 + history 时间旅行 travel(version) + onDelta 订阅）+ `chord/state-projection.ts`（订阅消费层），测试 360 行，commit ed85adc。设计稿 docs/RESEARCH.md:1559。**备注**：仅模块内自闭环（state-projection 为消费方），未导出至 `packages/tui/src/index.ts`，无 CLI 运行时调用方——功能本身完整，缺的是对外暴露/装配。 |

## 统计

| verdict | 项数 | 清单项 |
|---|---|---|
| CONFIRMED | 26 | 59,60,61,62,63,64,65,66,67,68,69,70,72,73,74,75,76,77,78,79,80,81,82,83,84,85 |
| PARTIAL | 2 | 58（BI-13.3 压缩器零接线/无相关度轮转）, 71（BI-16.1 仅 JS 可执行，无 TS 转译；worker 池为顺序 promise 队列） |
| MISSING | 0 | — |
| UNVERIFIABLE | 0 | — |
| 合计 | 28 | 58-85 |

### 需人工裁决的两处
1. **BI-13.3（项 58）**：模块与测试确凿，但压缩器从未作用于真实工具面，且"自适应"语义未实现。若验收口径为"模块存在即算交付"，可上调为 CONFIRMED；若口径为"功能在产品路径生效"，维持 PARTIAL。
2. **BI-16.1（项 71）**：仅缺 TS 执行半边（且是卡题措辞层面，RESEARCH 原稿写的是 JS 沙箱）。若以 RESEARCH 设计稿为准，可上调为 CONFIRMED。
