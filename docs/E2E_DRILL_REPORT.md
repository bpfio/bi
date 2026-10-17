# BI-21 工位 H —— 终局验收矩阵(全能力面演练报告)

- 演练套件:`packages/core/src/evals/` 下 11 个文件(场景 A + 域级矩阵 B-K),全部 `bun test` 可跑
- 总判定:**PASS**。矩阵 11/11 域全绿(含场景 A),44 个演练测试 / 575 条断言,零 DEGRADED 虚标
- 全仓门禁三绿(见文末);全程无 git commit(场景 A 首轮成果由协调者入库 3d212ee)

## 0. 验收矩阵总表

| 域 | 场景 | 链路组件(真实代码路径) | 判定 | 测试/断言 | 证据行(测试名) |
| --- | --- | --- | --- | --- | --- |
| A | 宏观政策数据审计(业务线) | WorktreeEngine(真实 git)→ web-fetch→htmlToMarkdown → pdf_extract.py → xlsx_audit.py → 研报组装(worktree 隔离落盘)→ visual-judge + runDoctor | PASS | 6/93 | `e2e-drill.test.ts` 链 1-6 |
| B | 会话生命周期 | SessionManager → fork/rewindTo → AgentConversationUndoService+UndoParticipantRegistry+FileHistoryParticipant → transfer 导出/导入 + structuralFingerprint → FileHistoryService 字节级 restore | PASS | 4/42 | B1 append/fork/rewind 前缀同构;B2 undo 切点+幂等短路;B3 restore 字节级+级联;B4 指纹跨实例一致 |
| C | 认证与凭据 | CliOAuthFlow(伪 fetch 端点)×3 流程走完七态 → FileCredentialStore AES-256-GCM → redact 三出口 → ConfigService 五级合并+热重载防抖 | PASS | 4/57 | C1 七态并集断言;C2 密文落盘/篡改拒收;C3 String/JSON/inspect 遮蔽;C4 global→tui→local→env→cli 优先级 |
| D | 沙箱与权限 | shell-scan 分类 → opaque-guard → PathJail 凭据路径拦 → PermissionGate 三态 → ToolTimeoutPolicy/Deadline 子级钳制 → OsSandbox 真实探针 | PASS | 5/63 | D1 dangerous/opaque/budget fail-closed;D2 protected-home/etc/.env/credential-filename;D3 记忆→规则→三态;D4 min(注册限时,父预算);D5 探针 |
| E | 上下文防御链 | WindowManager 水位 → pruner 脱水 → AutoCompactor(伪 summarizer)+熔断 → tool-pairing 配平 → cache-continuity 前缀保持/413 判级 → InterruptionInjector → DateChangeSensor | PASS | 4/75 | E1 紧缩后预算内且配平;E2 三连紧缩熔断;E3 前缀恒等+溢出判级;E4 一次性提醒+跨日一次披露 |
| F | 子代理编排 | SubagentRunner(loopFactory 伪循环)+真实 SessionManager 写端口 → steer 双向信令 → RespondToCoordinator/SendMessage → MirrorSink → fork 克隆 → SwarmService | PASS | 3/40 | F1 双代理协同+配对落盘+镜像只外送;F2 字节级克隆+Agent 剥离+toolLock;F3 并发预算≤2+超时结构化 |
| G | MCP/A2A | McpClient×进程内 fixture transport(握手/分页列举/调用)+McpRegistry 前缀路由 → A2aHost 四角色派生 → Blackboard 能力门控写 → 回环 transport 签名/验签/防重放 | PASS | 2/26 | G1 协议版本+nextCursor 翻页+server.tool 路由;G2 scout 直写被拒+reporter 落板+replayed 拒收 |
| H | 工作流状态机 | parseWorkflow DSL → MemoryDurableStore → DurableScheduler → DagEngine 三节点图+跨实例恢复+recover 孤儿重放 → PlanModeService 只读降级 → ModeMutexCoordinator → TodoService → GoalDriver+RepeatReminder | PASS | 5/64 | H1 outputs 下传+同 store 换引擎幂等+孤儿重放;H2 规划→驳回→修订→批准;H3 互斥强退事件序;H4 前向迁移;H5 judge 达成+5 连升级提醒 |
| I | TUI 渲染面 | 真实 git diff(临时仓)→ DiffRenderer 双缓冲虚拟终端 → TranscriptProjection 四层同构(assertProjectionInvariants)→ renderLatex → renderMermaid | PASS | 4/33 | I1 零变更零输出+单行差分;I2 L2/L3/L4 行行同构+折行无损;I3 \frac/x²/y₁ 转文本 fail-soft;I4 flow/sequence ASCII+非法降级 ⚠ |
| J | 命令与钩子 | discoverSlashCommands+expandCommand 单遍扫描 → expandShellVars/parseShellArgs → HookRunner(伪 spawn)生命周期事件+信任门+shell-scan 门 → compact/rewind/clear 命令门 | PASS | 4/38 | J1 发现+注入安全($ARGUMENTS 不重扫);J2 引号/~ 展开;J3 事件匹配+skipped-opaque+block 短路+20 事件枚举;J4 末行决策 JSON+invalid-steps |
| K | 网关与升级面 | UltraGateway URL 重写+指纹防伪 → redactFingerprint 脱敏 → classifyFailure 分级 → stageDownload/swapBinary/installLock(临时目录,不碰主程序) → config 快照 redact | PASS | 3/44 | K1 /api/v1/ultra/anthropic 重写+幂等短路+ze-\*\*\*last4;K2 sha256 门+原子换装+O_EXCL/stale 接管;K3 凭据遮蔽 URL 保留 |

### 环境相关项记录(无 DEGRADED)

- **D5 os-sandbox**:本机 Linux 实探 `landlock:ok bwrap:ok seatbelt:no(wrong-platform)`,`preferred=landlock`,available=true —— 沙箱后端实际可用,非降级路径。探针断言为结构性事实(后端数、seatbelt 平台判定、原因码枚举),不因环境差异虚标。
- 其余域无内核/环境依赖项;工作树隔离、python 子进程、真实 git diff 均真实执行。

## 1. 场景 A 遗留证据(首轮)

- 夹具:`packages/core/src/evals/fixtures/e2e-drill/`(gazette.html 红头公报 / gazette-layout.ts 双栏版面生成器 / gen_drill_xlsx.py 三表账簿 / drill-data.ts 单一数字源)。
- 0 误差要点:GDP 953680 亿元 / 上期 910000 / 同比 4.8% 在 web、双栏版面、账簿三链逐字一致;注错账(合计 90000→90050)被 `xlsx_audit.py` 精确定位到第 4 行第 2 列,exit=1。
- worktree 隔离:`bi-task-bi-drill` 分支演练、研报只落 worktree,收尾 `git worktree list` 仅主仓、零分支残留。

## 2. 演练暴露并修复的缺陷清单(健康协议:小缺陷直接修+备案)

| # | 缺陷 | 位置 | 修复 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 审计明细金额 `%.4g` 科学计数法(90000 → `9e+04`),财务场景不可读 | `presets/plugins/spreadsheets/scripts/xlsx_audit.py` | 新增 `_fmt()` 定点去尾零,替换 3 处 `.4g` | 场景 A 暴露;已随 3d212ee 入库 |
| 2 | `installLock.release()` 以 fire-and-forget `fs.unlink` 释放,与紧随的 `stat`/重加锁存在竞态(全量并发跑时稳定复现) | `packages/core/src/cli/update/native-swap.ts` | release 改 `unlinkSync` 同步释放(锁删除为原子元数据操作,宽容被接管/清理) | K 域演练在全量回归中暴露;修复后全仓 4074/0 |

## 3. 观察项(不构成缺陷,未改动)

- `packages/workflow/src/index.ts` barrel 仅导出 `DESCRIPTION`,域内模块未经由包入口汇聚。演练按模块路径直连导入(`workflow/src/engine` 等),未改动公共 barrel(超出最小修复面);如需对外 API 收口归组装层裁决。
- `picomatch` 段语义:`Bash(rm -rf *)` 不跨路径段,深路径 deny 需 `/**`;D3 已按真实语义写双规则断言(fail-closed 语义下这是安全侧设计)。
- MCP `McpRegistry` 前缀路由格式为 `server.tool`(点号);A2A `verifyEnvelope` 的 `allowFrom` 为必填显式面(fail-closed)。

## 4. 全仓门禁(三绿)

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 全仓测试 | 仓库根 `bun test` | **4074 pass / 0 fail**(209 文件,49687 expect;含演练 44 例/575 断言) |
| core 类型 | `cd packages/core && bunx tsc --noEmit` | exit 0 |
| tui 类型 | `cd packages/tui && bunx tsc --noEmit` | exit 0 |

## 5. 纪律复核

- [x] 被测组件全部真实代码路径;端口注入仅限 I/O 边界(fetch/spawn/视觉 judge/doctor 探测端口/时钟/存储目录)
- [x] 未读 references/ 母体源码(RULE-BI-06)
- [x] 改动面:`packages/core/src/evals/` 新增(11 套件+4 夹具)、`docs/E2E_DRILL_REPORT.md`、缺陷最小修复面(xlsx_audit.py、native-swap.ts)
- [x] 无 git commit(主仓 HEAD 提交由协调者执行);演练产物/临时仓/锁文件全部清理
