# bi 开发台账逐项检查 · 批 5/6（清单项 114-142）

- 仓库：/home/yupeng/bi（Bun/TypeScript monorepo CLI Agent）
- 台账输入：/tmp/bi-ledger-170.md（第四分片 129-170 与本批对应：台账卡号 129=清单项 114 … 卡号 157=清单项 142）
- 检查口径：每卡交付物在仓库内的真实证据（代码模块/测试文件/文档/构建脚本）；只读检查，未修改仓库任何文件
- 检查日期：2026-10-20

| 项 | 卡id | verdict | 证据/说明 |
|---|---|---|---|
| 114 | BI-25.3 | CONFIRMED | `packages/tui/src/mount/repl.ts:3` 头注直接标 "BI-25.3 —— REPL 增强：up/down 历史翻页、tab 补全、多行输入语义"；三件交付物同文件落地：`PromptHistory` 类(:447)、`historyCompletions`(:504)、`completeDraft`(:529)；配套 `packages/tui/src/mount/repl.test.ts`（1595 行）、`packages/tui/src/mount/editor-history.ts`、`file-completion.ts` |
| 115 | BI-25.4 | CONFIRMED | `scripts/npm-pack.ts:23` `SCOPE = "@bpfio"`（元包 `@bpfio/bi` + `@bpfio/bi-linux-x64` + `@bpfio/bi-darwin-arm64`，`bin/bi.js` shim 按平台 optionalDependencies 选装，:161）；冷安装冒烟回执 `docs/dispatch/2026-10-20-prod-ready/p4-report.md:115-149`（全新 prefix → added 2 packages → `.bin/bi --version`=bi 0.2.0 → `session` 真实列出）；发布回执 `DEVLOG.md:251,259`（三包上 registry、@bpfio 迁移后冷装 PASS）。说明：真正 `npm publish` 属外发动作，仓库面证据为拼装脚本 + 回执 + 冷装实测输出 |
| 116 | BI-25.5 | CONFIRMED | `scripts/build-bin.ts:203-204` `BIN_ENTRY_SPECIFIER = "../../bin/bi.ts"`（头注 :9 "BI-25.5 起编译 entry 指向 bin/bi.ts"）；`scripts/build-bin.test.ts:150-154` 断言 entry 与 BI-25.5 标记、:339-342 断言裸跑落 REPL 装配路径（空 HOME → exit 3 凭据门）而非旧 0.1.0 的 USAGE exit 2；重发布记录 `DEVLOG.md:285,288`（0.1.1） |
| 117 | BI-26 | CONFIRMED | 父卡 rollup（verify/P1），六子卡交付物全部在库（见 118-123）；台账/批次记录 `DEVLOG.md:296-340`（第一波 2a04a9f / 第二波 13884f4+3525fca+918ac3a，4310+ pass/0 fail、双 tsc 0） |
| 118 | BI-26.1 | CONFIRMED | `packages/core/src/evals/e2e-drill-l-execution.test.ts:1-23` 头注 "BI-26.1 —— 工位 L 域级演练:执行面与装配链(BI-23/24/25 器官入阵)"，9 个用例/5 条链：toolset 真面、model-port 装配、agent-tui 挂载、acp 桥全生命周期、八子命令分发；零 DEGRADED（无 skipIf 门） |
| 119 | BI-26.2 | CONFIRMED | `scripts/fake-endpoint.ts:1-17` 本地伪端点（127.0.0.1 随机端口，anthropic/openai 双模态 SSE，echo 回环）+ `scripts/fake-endpoint-e2e.test.ts:1-13` bin 级 e2e（走真实 bin/bi.ts 入口 → 凭据门 → 适配器 → 伪端点 → stream-json 断言，子进程 env 只透传 PATH/HOME/BI_FAKE_KEY，结构性杜绝外呼）。门控 `BI_PTY_E2E=1`，本地缺省跳过 |
| 120 | BI-26.3 | CONFIRMED | `packages/core/src/evals/e2e-drill-m-crash.test.ts:1-18`（BI-26.3 崩溃恢复与持久化，7 用例/4 链：JSONL 半写痊愈、meta 残缺拒载、双 manager 并发、kill -9 真子进程）；并发撕裂真缺陷根因修复见 commit `30814b0`（+20 轮并发风暴回归） |
| 121 | BI-26.4 | CONFIRMED | `scripts/pty-repl.test.ts:1-15`（40×100 真伪终端：状态行 rows-2 / 提示行 rows-1 行分离、无 "❯ anual]" 叠写乱码、提交 "hello" → 伪端点 ECHO 真实回合上屏）+ 常驻探针 `scripts/pty-probe.py:1-12`（pty 真实字节流采集）。门控 BI_PTY_E2E=1，缺 python3 自动跳过 |
| 122 | BI-26.5 | CONFIRMED | commit `2a04a9f` 删除 36 个母体死脚本（bench-tui-*/smoke-tui-*/runtime-*-patches 等，引用已不存在的 vendor/zcode.cjs、packages/zcode-tui）+ 3 个母体 workflow（.github/workflows/prepare-release.yml、publish.yml、release-commit.yml）；现 `scripts/` 仅 8 个 bi 自有文件，全仓 `grep vendor/zcode` 零命中（仅 writeback.test.ts 的 "vendor/**" 配置样例串，无关） |
| 123 | BI-26.6 | CONFIRMED | `scripts/version-sync.test.ts:1-15` 版本多源同步门禁：根 package.json ≡ @bi/core package.json ≡ @bi/tui package.json ≡ core `VERSION` 常量，四源恒等、任一处单独升版即红（BI-25.5 漂移教训结构化固化） |
| 124 | BI-27 | CONFIRMED | 父卡 rollup（feat/P1），五子卡交付物全部在库（见 125-129）；批次记录 `DEVLOG.md:302-303,329-331`（27.1/27.2 wave1、27.3/27.4/27.5 wave2 全 closed） |
| 125 | BI-27.1 | CONFIRMED | `packages/tui/src/mount/repl.ts:4-5` 头注 "BI-27.1 —— 输入补齐:光标可视化(▏1 格条)、多行粘贴(换行原样入稿)、pageup/pagedown 十条跳页"；实现 :206 `insertRaw`（paste 不摊平）、:584-612 提示行 `❯ 草稿 ▏` 光标条渲染、:817-823 pageup/pagedown 十条跳页；配套 repl.test.ts |
| 126 | BI-27.2 | CONFIRMED | `packages/tui/src/mount/agent-tui.ts`：`StreamView` 组件(:294，状态行上方 rows-3 单行预览，缓冲空不渲染)、80ms 节流窗口(:94)、运行态已用秒数（turnStartedAt 起算，:399-401/:505）、流收束清缓冲退场(:786)；配套 `packages/tui/src/mount/agent-tui.test.ts`（慢速 delta 预览行 / 节流合并 / 取消收束三例） |
| 127 | BI-27.3 | CONFIRMED | `packages/tui/src/transcript-styled.ts:1-20`（StyledTranscript 富文本视图模型：assistant 正文走 renderMarkdown，与 TranscriptProjection 并行消费同一份 L1，文本面与 L3 逐字节一致、仅样式面新增）+ `packages/tui/src/render/markdown.ts`（零依赖手写 markdown）；配套 transcript-styled.test.ts |
| 128 | BI-27.4 | CONFIRMED | `packages/tui/src/mount/candidate-menu.ts:1-20`（CandidateMenu 纯状态机 + CandidatesProvider 端口 + builtinSlashCandidates 缺省候选面）；宿主接线 `bin/bi.ts`（discoverSlashCommands 读 ~/.bi/commands 与 <cwd>/.bi/commands → slashCommandSurface 注入 session.candidates） |
| 129 | BI-27.5 | CONFIRMED | `packages/tui/src/mount/agent-tui.ts:22-33` ADR「REPL 视口方案裁定 —— 维持 inline（正常屏幕）」，含理由/代价/复核条件；配套 :87-91 SGR 1000/1006 鼠标上报、:387/:557 转录窗滚回（±3 行/格，锚底钳顶）、:610 resize 折行宽双侧跟随；测试三例（resize 重排 / 滚轮滚回 / 富文本视图行）见 agent-tui.test.ts |
| 130 | BI-28 | CONFIRMED | 父卡 rollup（feat/P1），五子卡交付物全部在库（见 131-135）；批次记录 `DEVLOG.md:304-305,326-328`（28.1/28.2 wave1、28.3/28.4/28.5 wave2 全 closed，commit 3525fca） |
| 131 | BI-28.1 | CONFIRMED | `packages/core/src/cli/toolset.ts:13`（bash 绑定：spawn(["bash","-c",cmd])、超时杀、100KB 尾截断、shell-scan dangerous\|opaque 标注、spawnImpl 注入替身）+ `packages/core/src/cli/toolset.test.ts:328-432`（透传/双流合并/exitCode 非 0 不抛错/超时 kill/100KB 截断/argSummary/缺参校验/已中止信号 七类用例） |
| 132 | BI-28.2 | CONFIRMED | `packages/core/src/cli/toolset.ts:18-21,209-210`（edit 唯一性替换 + $& 字面量语义、write 走 atomicWriteFile + PathJail 第二层）+ toolset.test.ts:463-530+（唯一命中/0 命中 edit-no-match/多处命中 edit-ambiguous/replace_all/空 new_string 删除/文件不存在结构化报错） |
| 133 | BI-28.3 | CONFIRMED | `packages/core/src/cli/permission-mode.ts:1-20`（PermissionSessionController：模式切换 + 「始终允许」会话记忆，switchMode 不清授权的裁定）+ `packages/core/src/cli/commands/permissions-command.ts`（/permissions show\|mode\|grant\|deny\|revoke\|clear）+ `bin/bi.ts` 门禁接线（config [permission] mode→三态门禁、规则 ask 剔除、REPL `/` 行本地回执不入模型回合） |
| 134 | BI-28.4 | CONFIRMED | `packages/core/src/cli/exec-drill.test.ts:1-25` 执行面真实任务演练：脚本化伪端点（本地 Bun.serve SSE，多回合 tool_use 编排）→ 真实适配器解析 → headless 全回合 → buildDefaultToolset 真实 read_file/edit/bash（真 Bun.spawn 子进程跑 bun test）→ 文本收束；断言落盘修复、bash 结果携真实测试输出、permissionDecisions 全 allow |
| 135 | BI-28.5 | CONFIRMED | `packages/core/src/cli/toolset.ts:23-27,206-207,311,359`（glob = Bun.Glob 零依赖扫描；grep = 递归正则 rg 语义、命中 200 条封顶、输出超 10KB 保留尾部、超 1MB 单文件跳过、abort 即时 reject；两件均走 assertInsideRoot + PathJail 读裁决）；注册面断言 toolset.test.ts:188（"BI-28.5 起 grep/glob 已挂"） |
| 136 | BI-29 | CONFIRMED | 父卡 rollup（ops/P2），两子卡交付物全部在库（见 137-138）；`DEVLOG.md:323-324`（BI-29.1/BI-29.2 落 commit 13884f4） |
| 137 | BI-29.1 | CONFIRMED | `packages/core/src/doctor.ts:1-16`（BI-29.1 去母体化：五检查项 = 配置装载/凭据门(resolveModelPort 同链)/所配 provider base_url 网络探测/OsSandbox 真探/工具注册面；open.bigmodel.cn 硬编码端点、ZHIPU 环境变量面、Python/pandas 母体遗产检查全部退役）；`packages/core/src/doctor.test.ts` 离屏注入假端口、零真实 IO |
| 138 | BI-29.2 | CONFIRMED | `packages/core/src/cli/update/upgrade-subcommand.ts:1-15`（manifest 源解析 --manifest-url > BI_UPGRADE_MANIFEST_URL > 无源 exit 4 → sha256 门 → native-swap 原子换装；母体 python3 upstream_sync.py 替身退役）+ `packages/core/src/cli/commands/dispatch.ts:30,650-666` 真实子命令接线；器官 `packages/core/src/cli/update/upgrade-command.ts` + `native-swap.ts`（全步注入可测、测试零外呼） |
| 139 | BI-00 | CONFIRMED | 父卡 rollup（ops/P1）：`docs/UPSTREAM_ANCHORS.md:1-5` 三要素齐备——锚点引擎指针（upstream_sync.py v1：record/check）、运行协议（BI-00.2 受控循环）、母体硬分叉裁定（RULE-BI-08，不回跟任何母体版本）；`docs/FIVE_AGENTS_FULL_SPECTRUM_ANALYSIS.md:6` 大典锚定 T0 并绑定受控循环吸收流程；`DEVLOG.md:155` 父卡 rollup 记 a4931dc |
| 140 | BI-00.1 | CONFIRMED | `docs/UPSTREAM_ANCHORS.md:7-20` 六棵参考树 T0 锚点基线表（zcode / kimi-code / opencode / deepseek-harness / pi / deepcode，含 commit hash、提交时间、HEAD 主题、上游前移标记）+ 机器可读快照指针 `upstream_anchors.json`；引擎 v1 本体在仓库外 `/home/yupeng/bi-ledger-ops/upstream_sync.py`（已核实存在，4900 字节，record/check 双模式）。说明：引擎代码未入库，仓库面交付为锚点基线 + 协议 + 快照指针 |
| 141 | BI-00.2 | CONFIRMED | `docs/UPSTREAM_ANCHORS.md:22-32` 运行协议五步（git pull 只读树 → git 元数据差分 → 大典增量 → 卡片重对齐 → Shadow Replay 回归）+ `:34-50` T1 首周期实测记录（三树 upstream-moved：opencode 40 提交/189 files、DHS 36 提交/586 files、pi 14 提交/60 files，零源码内容扫描）+ AUDIT-9 卡片锚点增补表 19 项；commit `a4931dc`。说明：T1 为观测备案周期，「大典增量吸收 + Shadow Replay 回归」两步按 RULE-BI-06 显式延后（依赖 BI-03.6），循环的「常态复跑」属运维节律，非代码面可证 |
| 142 | BI-30 | CONFIRMED | `docs/dogfood/2026-10-19-BI-30/`：INDEX.md（运行记录索引 + 零密钥泄漏扫描结论）、briefs/（六份工单简报）、3 份实例报告（30.1 斜杠命令执行面 / 30.3 --output-format / 30.2a 门控）、runlogs/*.log.gz（7 次无头运行控制台流）、transcripts/*.jsonl（bi 自有会话格式原始转录）；代码落地 commit `94cc84b`（斜杠命令执行面 / --output-format 实装 / 测试可移植性门控）+ `832da15`（BI-30.2b 伪端点 openai e2e 根因=ci.yml 缺 bun install，已修）。说明：BI-30.2b 曾留「断点」，最终由 commit 832da15 收口（该项为台账清单项 158，不在本批范围） |

## 统计

| verdict | 数量 |
|---|---|
| CONFIRMED | 29 |
| PARTIAL | 0 |
| MISSING | 0 |
| UNVERIFIABLE | 0 |
| **合计** | **29**（清单项 114-142） |

## 补充说明（需读者注意的边界）

1. **无 PARTIAL/MISSING/UNVERIFIABLE 的原因**：本批 29 项全部有可定位的仓库内交付物（代码模块/测试文件/文档/构建脚本），且多数卡的交付物自带头注卡号（如 `BI-26.1`、`BI-27.5`、`BI-29.2`），证据链闭合。
2. **执行性交付物 vs 运维/发布动作**：BI-25.4（npm 发布）、BI-30（dogfood 演练）、BI-00.1/.2（上游追踪）性质上含外发/循环/演练动作。仓库面可证的是装配脚本、协议文档、实跑回执与落盘语料；真正的 `npm publish`、跨网 fetch、常态循环节律无法从代码面独立验证，但已有回执文件（DEVLOG.md、p4-report.md、UPSTREAM_ANCHORS.md）留痕，故仍判 CONFIRMED 而非 UNVERIFIABLE。
3. **门控套件**：BI-26.2 / BI-26.4 依赖环境变量 `BI_PTY_E2E=1`（本地缺省跳过、CI 置位），缺 python3 时 pty 套件自动 skip——用例在库但默认不跑，复验时须带门控。
4. **唯一有实质延迟的子交付**：BI-00.2 的「大典增量吸收 + Shadow Replay 回归」两步按 RULE-BI-06 显式延后至 BI-03.6 就绪，属已备案的设计依赖，非缺失交付。
