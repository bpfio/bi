# bi 开发台账逐项检查 · 批 1/6（清单项 1-29，BI-01 ~ BI-06.10）

- 仓库：`/home/yupeng/bi`（Bun 1.3.14 / TypeScript 5.9 monorepo CLI Agent）
- 检查口径：卡面交付物在仓库中是否有**代码 / 测试 / 文档 / 构建脚本**实证
- 辅助证据源：`devplan.md`（卡面规格与预期路径）、`DEVLOG.md`（闭环台账与 commit 号）、git 历史
- 只读检查：未修改仓库任何文件；仅执行 `bun test`（测试自建临时目录）与 `git` 只读命令

## 验证方法

1. 按族定位目录地图（`packages/core/src/{config,commands,auth,gateway,session,adapters,memory,rules,context,tools,sandbox,guard,hooks,terminal,cli}`）
2. 每卡核对：`devplan.md` 预期路径是否存在 + 源文件头部的卡号标记（`BI-xx.y —`）+ DEVLOG 闭环表 commit 号在 git 中是否可达
3. 族级测试回归（`bun test`，全部 0 fail）：

| 目录 | 结果 | 目录 | 结果 | 目录 | 结果 |
|---|---|---|---|---|---|
| config | 127 pass / 0 fail | session | 252 pass / 0 fail | context | 284 pass / 0 fail |
| commands | 70 pass / 0 fail | adapters | 142 pass / 0 fail | tools | 182 pass / 0 fail |
| auth | 117 pass / 0 fail | memory | 21 pass / 0 fail | sandbox | 286 pass / 0 fail |
| gateway | 84 pass / 0 fail | rules | 62 pass / 0 fail | guard | 149 pass / 0 fail |
| | | | | hooks | 41 pass / 0 fail |

29 张卡对应的闭环 commit **全部在 git 历史中可达**（`git cat-file -e` 逐一验证）。

## 逐项结果

| 项 | 卡id | verdict | 证据/说明 |
|---|---|---|---|
| 1 | BI-01 | CONFIRMED | `package.json`（`workspaces: packages/*` + `test`/`typecheck`/`build:bin` 三脚本）、`tsconfig.json`（strict + noUncheckedIndexedAccess）、7 包拓扑 `packages/{core,worktree,workflow,mcp,a2a,tui,plugins}` + `presets/`；闭环 commit `e555591`（"feat(bi-01): Bun monorepo skeleton — 7 packages"） |
| 2 | BI-01.1 | CONFIRMED | `packages/core/src/config/config-service.ts`（三级 TOML 合并 + `startWatch` fs.watch 300ms 防抖热重载，优先级 defaults<config/tui<local<env<cli）、`config/schema.ts`（17 分区 + `redactSecrets`）、`config/writeback.ts`（smol-toml 注释保留原子回写）、`packages/tui/src/commands/config-dialog.ts`；commit `eb26543`；config 族 127 测试全绿 |
| 3 | BI-01.2 | CONFIRMED | `packages/core/src/commands/custom-commands.ts`（`discoverSlashCommands` / `expandCommand` / `slashCommandSurface`，frontmatter + `$1..$n` + `$ARGUMENTS`）、`commands/shell-expansion.ts`（`expandShellVars` / 引号感知拆分，零子进程执行）；commit `591daef`；commands 族 70 测试全绿。注：devplan 预定的独立文件 `slash-command-surface.ts` 未单列，调度面函数落在 `custom-commands.ts:276`，属落位差异非缺件 |
| 4 | BI-02 | CONFIRMED | `packages/core/src/auth/cli-oauth.ts`（通道一 OAuth2 PKCE + 32 字节 PollToken 轮询状态机）、`auth/coding-plan-key.ts`（通道二 API Key 二阶段换票，四类结构化失败）、`auth/credential-store.ts`（0600 落盘）、`auth/http.ts`（脱敏 fetch 封装）；commit `ddd1c9c`；auth 族 117 测试全绿 |
| 5 | BI-02.1 | CONFIRMED | `packages/core/src/gateway/ultra-gateway.ts`（`routeUltra` 把 `/v1/messages` 重写为 `/api/v1/ultra/anthropic/v1/messages`，幂等短路 + 失败四分类）、`gateway/fingerprint.ts`（`buildFingerprintHeaders` / `redactFingerprint`）；commit `1bcc1af`。注：卡面"实测触发官方计费抵扣"属线上行为，代码面只能证到 URL 重写与标头注入 |
| 6 | BI-02.2 | CONFIRMED | `packages/core/src/auth/quota-watchdog.ts`（两级告警 low_ratio/exhausted、冷却去抖、rpm/tpm 快照）、`gateway/balance-monitor.ts`；commit `dc9eec6` |
| 7 | BI-02.3 | CONFIRMED | `packages/core/src/auth/off-peak-service.ts`（queued→polling→settling→settled 状态机、3102 重取号、Outbox 至少一次核销 + 指数退避）、`gateway/off-peak-client.ts`；commit `15276eb` |
| 8 | BI-02.4 | CONFIRMED | `packages/core/src/auth/benefit-claim.ts`（preview/claim 原子语义 + already_claimed/not_found 结构化）、`gateway/highspeed-draw.ts`；commit `27358df` |
| 9 | BI-03 | CONFIRMED | `packages/core/src/session/manager.ts`（append-only JSONL，UUIDv7 id/parentId 树，fsync 抗掉电，残缺行截断自愈）、`session/jsonl.ts`、`session/index.ts`（`SqliteIndexEngine` WAL + `MemoryIndexEngine` 双引擎等价性）；commit `d46a219`；session 族 252 测试全绿。注：devplan 写的 "MiniDB LSM-Tree" 未移植，模块头已明确备案"以 Memory + SQLite 双引擎交付" |
| 10 | BI-03.1 | CONFIRMED | `packages/core/src/session/file-rewind.ts`（自实现行级 LCS diff + SHA256 校验 + 逆向补丁回滚）；commit `2585ebb` |
| 11 | BI-03.2 | CONFIRMED | `packages/core/src/session/file-history.ts`（`snapshotBefore` 写前快照 + `turnId` 索引）、`session/blob-store.ts`（SHA-256 内容寻址 blob 仓）；commit `bfe0148` |
| 12 | BI-03.3 | CONFIRMED | `packages/core/src/session/state-matrix.ts`（`runPhase`×`activeWork`×`queueAuthority`×动作 30 格穷举矩阵 + `Invariants` 不变量注册表 + `StateMatrixViolationError`）；commit `2585ebb`。注：devplan 预定的独立 `session/invariants.ts` 折入同文件，不变量实现齐备 |
| 13 | BI-03.4 | CONFIRMED | `packages/core/src/session/undo-service.ts`（`AgentConversationUndoService` / `computeUndoCut` 撤销切线）、`session/undo-participants.ts`（ContextUndoneEvent 总线 + `FileHistoryParticipant`）、`packages/tui/src/dialogs/undo-selector.ts`；commit `4b5848a` |
| 14 | BI-03.5 | CONFIRMED | `packages/core/src/session/inbox.ts`（steer 步边界 / input 空闲边界双边界消费）、`session/run-coordinator.ts`（门铃 `pendingWake` 看门狗 + `awaitSettlement`/`awaitIdle`）；commit `db96942` |
| 15 | BI-03.6 | CONFIRMED | `packages/core/src/session/shadow-replay.ts`（`ShadowReplay` 离线重演 + 非回归校验）、`session/trajectory.ts`（`TrajectoryRecorder` 黄金轨迹 Schema）；commit `c51e162` |
| 16 | BI-03.7 | CONFIRMED | `packages/core/src/session/query/query-engine.ts`（`SessionQueryEngine.search` + `rebuildIndex` 幂等）、`query/filter-compiler.ts`（`compileFilter` / `FilterSyntaxError`）、`query/sqlite-corpus.ts`（bun:sqlite WAL + keyset 分页）；commit `c51e162`；`query-engine.test.ts` 存在 |
| 17 | BI-04 | **PARTIAL** | ✅ SSE 统一流式驱动已交付：`packages/core/src/adapters/deepseek-adapter.ts`（手写 O(N) SSE 解析、OpenAI/Anthropic 双模态统一抽象）经 `packages/core/src/cli/model-port.ts`（`createAdapterModelPort`）接入 `cli/headless.ts` 的 `ModelPort` 线合约；`DEVLOG.md` 亦将 BI-04 记为"父卡 rollup（SSE 驱动与插槽路由，adapters 域承载）"（commit `591daef`）。❌ **插槽路由器缺失**：devplan 指定的 `packages/core/src/model-router.ts` 与 `packages/core/src/drivers/sse-driver.ts` 在 git 全历史中从未存在（`git log --all --diff-filter=A` 无匹配），全仓无 `ModelSlotRouter`、无 `fast`/`reasoner`/`auditor` 语义槽解析实现；`config/schema.ts` 的 `secondary_model{subagent,background,summarize}` 仅有 schema 声明、无消费方实现。**缺件：语义插槽（fast/reasoner/auditor）→ 单一主力模型的路由层** |
| 18 | BI-04.1 | CONFIRMED | `packages/core/src/adapters/prompt-cache.ts`：`PROMPT_PREFIX_ORDER = ['system+biMd','tools','anchor','history']` 黄金排布锁死、`buildPromptPrefix` / `appendHistory` / `renderToolDefsBlock`，以及 `fuzzyParseToolCall`（Qwen 风格畸形 JSON 容错解析）；commit `591daef`；`prompt-cache.test.ts` 三组 describe 全覆盖。注：devplan 的 `src/prompt.ts` / `src/parser.ts` 折入本文件 |
| 19 | BI-04.2 | CONFIRMED | `packages/core/src/adapters/deepseek-adapter.ts`（双模态 Wire 协议、thinking/signature 无损回放、O(N²) JSON.parse 消除）、`adapters/reasoning-stream.ts`（思考流折叠 + `serializeReasoning` 字节级往返 + v41 视觉 Token 网格）；commit `3e2d7db` |
| 20 | BI-04.3 | CONFIRMED | `packages/core/src/adapters/cache-warmer.ts`（TTL 90% 水位发 1-token 保活脉冲 + 经济学闸门 expectedSavings）、`adapters/cache-stats.ts`（命中率记账 + expired 浪费成本账单）；commit `39e9a3f` |
| 21 | BI-04.4 | CONFIRMED | `packages/core/src/adapters/cache-policy.ts`（`allocateBreakpoints` 4 级硬预算 tools-tail/system-tail/system-head/message-tail + 跨厂商 Anthropic/Bedrock/Qwen/Gemini 矩阵）、`adapters/effort-updates.ts`（`freezeEffort` per-message 推理强度冻结）；commit `8b42adb` |
| 22 | BI-05 | CONFIRMED | `packages/core/src/rules.ts`（`findRuleFile` 向上递归 BI.md / .bi/rules.md、`loadRules` 二级标题切节、`buildSystemPromptSection` 确定性注入块 8K 截断、`RulesInjector` 按 path+mtime 缓存）；commit `ffcb5af`；rules 族 62 测试全绿 |
| 23 | BI-05.1 | CONFIRMED | `packages/core/src/memory/dream.ts`（`evaluateAutoDreamTiming` 空闲判定 + `.consolidate-lock` 原子锁 + append-only `BI.dream.md` 沉淀 + 启动注入）；commit `ffcb5af`（初版）/ `91dae53`（BI-05.1 装配接线，config-gated 默认关）；`cli/w4d9-dream-memory.test.ts` 覆盖 |
| 24 | BI-05.2 | CONFIRMED | `packages/core/src/rules/init-service.ts`（`detectStack` 扫 package.json/Cargo.toml/pyproject.toml/go.mod/Makefile、`draftBiMd` 四节确定性草稿且 `requiresReview: true` 强制人工审查），并经 `packages/core/src/cli/commands/dispatch.ts:48` 接入 `bi init` 子命令；commit `e401039`。注：devplan 预定的 `packages/core/src/cli/sub/init.ts` 已被 `6f65667` 显式移除（"remove parallel unwired init draft"）并由本路径取代，非缺件 |
| 25 | BI-05.3 | CONFIRMED | 台账两种读法均有交付：①台账标题"context 上下文引擎装配" → `packages/core/src/context/`（`time-context` / `date-change-sensor` / `tool-result-pruner` / `window-manager`）经 `cli/headless.ts` + `cli/main.ts` config-gated 接线，commit `7102599`（同 commit 诚实备案 10 个重器官未接原因），`config/w3d7-context.test.ts` + `cli/w3d7-context-*.test.ts` 覆盖；②DEVLOG 台账"嵌套规则探测器" → `packages/core/src/rules/nested-rules-detector.ts` + `rules/nested-reminder.ts`，commit `ffcb5af` |
| 26 | BI-05.4 | CONFIRMED | `packages/core/src/context/time-context.ts`（`buildTimeContext` 注入 ISO 挂钟 + IANA 时区（默认 `Asia/Shanghai`）+ `Elapsed: Xm Ys since last turn` + 时钟回拨钳零 + `TimeContextCache` 600s 最小刷新间隔）；commit `a87016e`；`context/time-context.test.ts` 覆盖。注：devplan 预定的 `context/request-zone.ts` 未单列，时区/时长能力在 time-context.ts 内 |
| 27 | BI-06 | CONFIRMED | `packages/core/src/tools/bash.ts`（受控执行器，独立 PGID + SIGTERM→1.5s→SIGKILL）、`tools/process-group.ts`（`killProcessGroup`，按 /proc 状态判僵尸）；commit `619e9bd`；tools 族 182 测试全绿 |
| 28 | BI-06.1 | CONFIRMED | `packages/core/src/sandbox/path-jail.ts`（在 BI-06.8 语句树上做路径/策略裁决，拦截 `~/.ssh`、`~/.gnupg`、`~/.bash_history`、`/etc/`、项目外 `.env`）、`sandbox/sandbox-policy.ts`；commit `62177e7`；sandbox 族 286 测试全绿 |
| 29 | BI-06.10 | CONFIRMED | `packages/core/src/sandbox/os-sandbox.ts`（landlock 真实 syscall 探针 abi=5 二分 + 内嵌 `LANDLOCK_LOADER_SRC` 自重执行；bwrap PATH + `--ro-bind / / /bin/true` 功能探针；seatbelt darwin + sandbox-exec 存在性探针；全后端不可用 fail-closed refused）、`sandbox/sandbox-policy.ts`（`landlockProfileArgs` / `seatbeltProfile` / `bwrapProfile`）；commit `81d4b06`；`os-sandbox.test.ts` 24 例（含"真实 landlock 执行（本机 Linux 内核实测）"组）全绿 |

## 统计

| verdict | 数量 |
|---|---|
| CONFIRMED | 28 |
| PARTIAL | 1（BI-04） |
| MISSING | 0 |
| UNVERIFIABLE | 0 |

## 补充观察（不计入 verdict）

1. **BI-04 收口建议**：若要把 BI-04 从 PARTIAL 补到 CONFIRMED，缺的是一层 `ModelSlotRouter`——把 `fast`/`reasoner`/`auditor` 等逻辑语义槽解析到单一主力模型。现成的落点已经铺好：`config/schema.ts` 的 `secondary_model{subagent,background,summarize}` 三个槽目前只有 schema 声明、无消费方；`cli/model-port.ts` 的 `resolveModelPort` 已是配置→模型的解析链，只需在其上叠一层槽位映射。
2. **落位差异（非缺件）**：BI-01.2 / BI-03.3 / BI-04.1 / BI-05.2 / BI-05.4 五张卡的 devplan 预期文件与最终落位不一致（多为"预定单文件 → 折入同族既有文件"），每个能力点都有对应实现与测试，不构成缺件。
3. **备案式降级两处**：BI-03 的 MiniDB LSM-Tree 未移植（以 Memory+SQLite 双引擎交付，模块头已备案）；BI-05.3 的 10 个重 context 器官未接入（同 commit 逐条备案原因）。
4. **证据链完整性**：29 张卡的 DEVLOG 闭环 commit 全部在 git 历史中可达且 commit message 与卡号一致（如 `feat(bi-06.10): OS-level sandbox — landlock real syscall probe (abi=5)`），台账与代码面无悬空引用。
