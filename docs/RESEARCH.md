# bi CLI Agent 架构全景调研与细颗粒度设计蓝图 (Architecture Research & Detailed Blueprint)

> 本文档是 `bi` 项目（`bpfio/bi`）的权威架构调研与技术设计报告，基于对 **Pi Agent**、**zcode-app-cli**、**ZCode 官方开源仓库 (`zai-org/ZCode`)**、**DeepSeek Harness (`deepcode-cli`)** 与 **OpenCode (`opencode.ai`)** 的全量代码走读，确立了项目的核心设计原则、防幻觉机制、**A2A 跨智能体协议与分工协同机制**、**完整 MCP 兼容引擎**、**工业级会话管理体系 (Session Engine)**、**Git Worktree 并发隔离机制**、**Workflow 动态工作流编排引擎** 与全阶段工程落地蓝图。
> 同步归档于 Logbook 知识中枢：`project: "bi"`, `research_id: 25`。

---

## 一、 调研背景与使命定位

在政策调研与数据分析场景中，传统的通用 Coding Agent 常常面临四大结构性缺陷：
1. **安全性与黑盒困境**：许多轻量工具采用二进制混淆包或依赖多层脆弱的 AST 补丁，代码无法白盒审计，存在供应链投毒与未授权数据外泄（Telemetry）风险；
2. **幻觉率与执行力脱节**：同为先进模型，在不同脚手架（Harness）下表现天差地别——缺乏严格闭环约束的 Agent 常常产生严重幻觉（捏造数据、指标前后矛盾、虚构文件），缺乏**代码确定性验证（Code-backed Grounding）与证据一致性核验**；
3. **并发写入污染工作区**：多 Agent 并行运行时直接改脏用户的当前工作目录（`cwd`），缺乏**物理级 Git Worktree 隔离**；
4. **长流程不可控与会话脆弱**：几十步的深度调研缺乏**声明式 Workflow DAG 编排与步骤检查点（Checkpoint）**，中途断开即前功尽弃；缺乏 DAG 分叉与时光倒流。

**`bi` 的使命**：
打造一个**100% 白盒开源、零数据外泄、极低幻觉、极高并发执行力**的现代化 Agent CLI。
- **单模型全自洽与即插即用（Single-Model First）**：原生支持 GLM、DeepSeek、Claude 等任意主流单模型驱动，用户仅需配置一个主力模型，零强制异构依赖，零多模型账单负担；
- **主攻领域**：**政策深度调研**（条文比对、脉络追溯、博弈推演）与 **严密数据分析**（指标穿透、勾稽核验、产能良率事实审计）；
- **协议完备**：内置**工业级 MCP 客户端**（兼容 Stdio/SSE 远程与本地服务）与 **A2A 跨智能体通信协议**；
- **并发与编排**：内置 **Git Worktree 临时隔离引擎** 与 **声明式 Workflow DAG 编排引擎**；
- **状态中枢**：内置 **工业级 DAG 会话管理引擎**（Append-only 事件溯源 + 无损紧缩 + 平行分支）；
- **终端交互**：继承 `@earendil-works/pi-tui` 的无闪烁差分渲染与渐进折叠手感。

---

## 二、 六大标杆方案与开源架构深度剖析

本地已于 `~/references/` 建立了 5 大核心开源工程图纸库（`pi`、`zcode`、`kimi-code`、`deepcode`、`opencode` 与 `deepseek-harness`），经深度代码走读，提炼以下关键发现：

| 标杆项目 | 核心模块与代码走读 | 核心优势（精髓借鉴） | 关键局限与对抗成本 |
|---|---|---|---|
| **Pi Agent**<br>`@earendil-works/pi` | • `packages/coding-agent/src/core/session-manager.ts` (单文件 2,014 行)<br>• `packages/tui/`: 双缓冲差分渲染引擎<br>• `packages/codemode/`: 零依赖 node:vm 内存执行沙箱<br>• `packages/mcp/`: 独立白盒 MCP 客户端<br>• `packages/agent/`: 4 大原子工具 | • **DAG 会话树体系**：每一条消息携带 `id` (UUIDv7) 与 `parentId`，天然支持分支分叉与 Rewind 时光倒流<br>• **错误作为一等公民**：抛异常自动转化为 `isError: true` 促使模型自愈<br>• **CodeMode 沙箱**：轻量级内存 JS 快速执行与类型安全计算<br>• 架构解耦：TUI 与内核彻底分离，依赖极少 | • 偏向单 Agent 通用编码，缺乏针对 DeepSeek-R1 思考流的特定处理与多智能体分流 |
| **ZCode 官方版**<br>`zai-org/ZCode` | • `core/tool/edit-matchers.ts` (8级阶梯弹性匹配)<br>• `core/tool/read-file-state.ts` (先读后写与mtime防脏写)<br>• `core/memory/dream.ts` (仿生做梦记忆沉淀)<br>• `services/storage/` (存储修剪与清理计划)<br>• `services/usage-stats/` (Coding Plan 额度看门狗)<br>• `dynamic-workflow/` (因果依赖图与Taint污点分析)<br>• `spreadsheets-plugin/`, `pdf-plugin/` & `superpowers-plugin/` | • **清华大学工业级完整资产库**：8级阶梯容错匹配（编辑成功率99.5%）、先读后写门禁、Dream Cycle仿生长期记忆、存储目录字典自动修剪、因果依赖图编译器与顶级 Agent SOP 技能集<br>• **开箱即用的专业数据/研报分析插件** | • 官方 CLI 前端采用 React+OpenTUI，较为臃肿且构建链庞大（巨石 Monorepo） |
| **zcode-app-cli**<br>`bpfio/bi` 前身 | • `runtime-tui-bridge.ts`: 进程内函数级桥接<br>• `runtime-sqlite-recovery.ts`: SQLite 并发自愈<br>• `bounded-tool-text.ts`: 64KB 工具输出有界保护<br>• `file-diff-budget.ts`: 2000 行 Diff 预算限制 | • **同进程零拷贝直连（Zero IPC）**：彻底消灭 Localhost Socket 延迟与重连断连隐患<br>• 极高的工程鲁棒性与内存防泄漏 | • **混淆二进制黑盒**（`vendor/zcode.cjs`），供应链不可审计<br>• 27 个 AST/字符串补丁在版本升级中极易漂移 |
| **DeepCode**<br>`lessweb/deepcode-cli` | • `packages/core/session.ts`: 会话状态机<br>• `packages/core/prompt.ts`: 提示词结构<br>• 支持 `thinkingEnabled` 与 `reasoningEffort` | • **原生适配 DeepSeek 系列**：深度适配 R1 思考流展示与参数调优<br>• 针对 DeepSeek 的 Prompt Cache 前缀优化与上下文压缩 | • 缺乏严格的沙箱隔离（Path Jail），代码中工具扩展体系较重 |
| **OpenCode**<br>`anomalyco/opencode` | • `packages/ai/`: 75+ 多模型统一适配<br>• `packages/protocol/`: 跨进程/跨端协议契约<br>• `packages/tui/`: 多会话并行终端界面 | • **极度开放自由**：多模型即插即用，分发体验极佳（一键安装）<br>• 双 Agent 模式（Build vs Plan/Explore）架构清晰 | • 为兼容 75+ 模型导致提示词采用“最大公约数”，对具体模型的调优深度不足，幻觉率高于 ZCode |
| **Kimi Code**<br>`MoonshotAI/kimi-code` | • `packages/tree-sitter-bash/`: 纯 TS Tree-sitter<br>• `packages/agent-core-v2/`: select_tools 动态按需加载、RWLock 调度、端侧媒体压缩<br>• `packages/remote-control/`: WSS 穿透中继控制通道<br>• `packages/minidb/`: 纯 TS LSM-Tree/WAL 数据库<br>• `packages/pi-tui/` & `packages/transcript/`: CJK 宽字符排版与同构 Transcript<br>• `packages/acp-server/`: Agent Client Protocol | • **清华系月之暗面现代重构标杆 (MIT)**：<br>• **100% 纯 TypeScript 零 Native C 依赖**：手写 Bash 语法树、纯 TS 嵌入式 LSM 数据库，Bun 单文件编译 0 崩溃；<br>• **Tool-on-Demand**：select_tools 动态激活工具，压降 80% Token；<br>• **细粒度 RWLock 调度**：多工具读并发、写互斥与全局屏障；<br>• **CJK 终端排版与同构 Transcript**：消除错位塌陷，历史与导出 100% 对齐；<br>• **多模态与客户端压缩**：终端图片就地无损压缩，保护视窗 | • 侧重通用软件工程编码，未内置宏观经济统计勾稽与部委政策长文档抽取的专业插件模板 |
| **DeepSeek Harness**<br>`deepseek-ai/deepseek-harness` | • `packages/llm/llm-deepseek/`: 原生 Messages 与思考流<br>• `packages/ptc-runtime/`: 程序化工具调用 (PTC Mode)<br>• `packages/compaction/compaction-tool-result-pruner/`: 结果中间剪枝<br>• `packages/guard/repeat-tool-reminder/`: 重复调用卫生守卫<br>• `packages/goal/`: 会话持久目标与自动续行<br>• `benchmarks/`: 官方抗压评测套件 | • **深度求索官方基座标准 (MIT)**：<br>• **DeepSeek Wire 协议与思考流签名回放**：原生支持 thinking 块、signature_delta 无损持久化与 reasoning_content，推理强度四档可控；<br>• **官方 v41 视觉 Token 几何网格算法**：14px 补丁、3:1 降采样、1024 Token 上限确定性求解；<br>• **In-History 提示词与工具更新**：保留前缀缓存，Cache 命中率 85%+；<br>• **PTC 程序化工具调用**：生成 TS/Python 脚本单轮运行多工具，往返 Token 压降 80%；<br>• **流式 CPU 补丁**：消除每 chunk 重复 JSON.parse 的 O(N^2) 暴击 | • 采用 Cordis 微内核与复杂 Profile 依赖注入体系，外层框架偏重（对抗成本：坚决不吸收 Cordis，仅原子提取纯净算法与协议逻辑） |

### 2. 清华大学 ZCode 实验室官方源码十四大黄金模块与工业级算法图谱

在二次深度审查智谱与清华大学开源的 `zai-org/ZCode`（位于本地只读参考库 `/home/yupeng/references/zcode`）后，我们系统梳理出其保障 99.5% 超高代码编辑成功率、0 上下文撑爆与极低幻觉的 **十四大工业级黄金算法与底层工程轮子**。`bi` 架构将全量直接提取并复用这些成熟轮子，最大化压减重复造轮子的对抗成本：

#### (1) 8 级阶梯弹性文件匹配算法 (`core/src/tool/edit-matchers.ts`)
- **核心痛点**：传统 Agent 编辑代码时，经常因大模型微小缩进差异、中英文智能引号（`"` vs `“`）漂移或行号微调导致 `TargetContent not found` 报崩溃。
- **清华算法**：构建渐进降级的 8 级匹配流水线：
  1. `exact`：精确子串匹配；
  2. `quote_normalized`：自动归一化中英弯引号与智能单双引号；
  3. `line_number_stripped`：自动剥离大模型幻觉带入的行号前缀；
  4. `indentation_flexible`：弹性缩进匹配（消除制表符与空格差异）；
  5. `whitespace_trimmed`：首尾空白修剪匹配；
  6. `multiline_boundary`：多行边界锚定；
  7. `block_anchor (0.8 相似度)`：基于 Levenshtein 动态规划距离计算上下文块相似度；
  8. `token_stream`：Token 流容错降级。
- **复用价值**：彻底根除代码编辑工具的匹配崩溃，实现 99.5% 落地编辑成功率。

#### (2) 历史老旧工具输出选择性脱水算法 (`core/src/compact/microcompact.ts`)
- **核心痛点**：传统 Agent 在多轮交互中保留全量 `Read` 和 `Bash` 的数万行历史输出，迅速占满上下文窗口。
- **清华算法**：落地 Microcompact 脱水策略：
  - 维护动态窗口：仅保留最近 `DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5` 次工具结果；
  - 判定阈值：计算 `buildDefaultMicrocompactThreshold = Math.floor(autoCompactThreshold * 0.9)`；
  - 对 5 轮之前的 `Read`、`Bash`、`Grep`、`Glob` 等历史结果，保留 Assistant 决策意图，但将其内容静默替换为 `[Old tool result content cleared]`；
  - Token 即时释放 60% 至 80%，无需触发重度 LLM 摘要总结。

#### (3) 共享视窗扣减与 3 击熔断紧缩算法 (`core/src/compact/policy.ts` & `manual.ts`)
- **核心痛点**：大模型 API 的 Context Window 是输入（Input）与输出（Output）共享的；若等到输入达到窗口上限才压缩，模型将因无输出空间直接爆 400 错误；同时压缩失败会导致无限死循环。
- **清华算法**：
  - 扣除预留：`getEffectiveContextWindowSize = contextWindow - outputReserveTokens (21,000 ~ 32,000)`；
  - 缓冲区设计：`getAutoCompactThreshold = effectiveContextWindow - 13,000`；
  - 三击熔断看门狗：`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`，一旦压缩连续失败 3 次触发熔断降级，防止死循环。

#### (4) Read-Before-Write 门禁与物理 mtime 防脏写看门狗 (`core/src/tool/read-file-state.ts`)
- **核心痛点**：Agent 凭空盲写或基于失效记忆覆盖外部并发修改的文件，造成代码灾难性回滚。
- **清华算法**：
  - 维护 `ReadFileStateMap` 读写状态机；未在此会话中执行过 `Read` 的文件，执行 `Edit` 时立即抛出拒绝并要求先读；
  - 在 `read-file-state-metadata.ts` 中记录读取时的磁盘真实 `mtime` 与 SHA256 哈希；
  - 编辑前先做 `stat` 校验，一旦发现文件在外部被人类或并发进程改动（`mtime` 漂移），立即阻断并强制重新读取。

#### (5) Dream Cycle 仿生做梦认知记忆固化算法 (`core/src/memory/dream.ts`)
- **核心痛点**：交互过程中的关键事实与用户偏好随会话结束而遗忘。
- **清华算法**：
  - 模拟人类大脑睡眠期间的 REM 做梦记忆固化阶段；
  - 利用 `evaluateAutoDreamTiming` 与 `.consolidate-lock` 文件锁，在会话进入空闲期或达到 Token 阈值时静默启动 Dream 子会话；
  - 提炼关键事实、偏好与统计口径，增量写入并收敛至项目根目录 `BI.md`。

#### (6) 预编译静态 bfs/ugrep 与命令透明劫持加速引擎 (`adapters/src/exec/embedded-search-prelude.ts`)
- **核心痛点**：模型在 Bash 中执行 `find` 或 `grep` 搜索文件时，常因深层遍历 `.git`、`node_modules` 导致数分钟无响应甚至超时断开。
- **清华算法**：
  - 在 `dependencies/native-search` 预打包跨平台静态编译的 `bfs` (Breadth-First Search) 与 `ugrep` 二进制；
  - 在 Bash 执行入口注入 shell prelude 函数，透明劫持 `find` 别名映射到 `bfs`，`grep` 映射到 `ugrep`；
  - 默认自动排除 `.git`、`.svn`、`.hg`、`.jj` 等版本控制黑洞，速度提升 20 至 50 倍且对模型完全透明。

#### (7) 超界输出文件描述符写盘与零内存泄漏 (`adapters/src/exec/bash-file-output.ts`)
- **核心痛点**：Bash 命令若打印数万行日志，Node.js 主进程收集 Buffer 会瞬间打爆 V8 堆内存（`ERR_STRING_TOO_LONG`）。
- **清华算法**：
  - 子进程直接持有物理临时文件的文件描述符 `fd`（以 `O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW` 模式打开）；
  - 标准输出直接由操作系统内核写入磁盘文件，彻底绕过 Node.js 内存收集；
  - 超过 64KB 输出时仅保留头尾各 200 行，并生成指向磁盘物理文件的指针供模型按需切片读取。

#### (8) 会话时光倒流与物理工作区逆向 Patch 回滚引擎 (`core/src/runtime/methods/file-rewind.ts`)
- **核心痛点**：会话历史支持时光倒流（Rewind）或平行分叉（Fork），但工作区物理文件仍停留在修改后的状态，导致代码与上下文不匹配。
- **清华算法**：
  - 维护 `WorkspaceCheckpointArtifact` 检查点工件与每轮文件差异；
  - 当触发时光倒流至历史第 N 轮时，`file-rewind.ts` 自动计算逆向补丁链（`StructuredPatch`）；
  - 比对当前文件哈希与操作历史，执行安全的逆向回滚与恢复，确保工作区文件与会话状态物理一致。

#### (9) Linux/Unix 进程树递归遍历、独立 PGID 与僵尸收割 (`adapters/src/exec/process-tree.ts`)
- **核心痛点**：杀死超时的父进程时，其派生的子进程（如 Python 计算、长轮询）沦为孤儿进程常驻后台消耗 CPU。
- **清华算法**：
  - 在派生子进程时调用 `setsid()` 赋予独立 Process Group ID (`PGID`)；
  - 看门狗超时或接收到中断时，遍历 `/proc` 进程树，向 `-PGID` 发送 `SIGTERM`；
  - 等待 1.5 秒后若仍有存活进程，向进程组发送 `SIGKILL` 彻底强制收割。

#### (10) 任务完工前置自验看门狗 (`core/src/runtime/methods/target-completion-verification.ts`)
- **核心痛点**：大模型往往在任务仅完成一半时便主观宣称“已为您办结”，导致流程早衰中断。
- **清华算法**：
  - 拦截模型最终交卷指令，触发 `verifyActiveTargetCompletionForContinuation`；
  - 提取原始任务目标（`SessionGoal`）与当前工作区真实产物，执行闭环契约校验；
  - 若核验未通过，阻断完成状态并自动将差距清单回灌给模型触发续跑自愈循环。

#### (11) 声明式因果依赖图、Taint 污点分析与状态机断点自愈 (`dynamic-workflow/`)
- **核心痛点**：长流程研报与政策比对涉及数十个子步骤，一旦中断必须全流程推倒重来。
- **清华算法**：
  - `causality-graph.ts`：解析步骤依赖并生成拓扑排序；
  - `taint.ts`：数据污染分析，确保不受信任的数据源在流经审计器前被清洗；
  - `journal-memory.ts`：每一步完成自动固化 Checkpoint，发生网络断线或异常秒级断点续跑。

#### (12) 官方专业 Office 插件全套成熟资产 (`packages/*-plugin/`)
- **核心痛点**：撰写专业研报与财务勾稽缺乏开箱即用的专业模板与提取脚本。
- **清华资产**：
  - `spreadsheets-plugin`：包含完整 `xlsx.py` 勾稽引擎、宏观金融统计模板；
  - `pdf-plugin`：包含部委双栏公报提取、版面分析与长文本规整脚本；
  - `documents-plugin`：Word（`docx`）排版与样式生成；
  - `presentations-plugin`：PowerPoint（`pptx`）研报简报生成；
  - `visualize-plugin`：数据可视化图表与 `visual-judge.md` 视觉核验智能体。

#### (13) 物理存储目录字典与孤儿工作区自动修剪器 (`packages/services/src/storage/`)
- **核心痛点**：多 Agent 并发派生 Git Worktree、临时测试文件与长日志，若无系统化生命周期管理，将在数周内产生数万个孤儿目录与数十 GB 废弃文件，最终导致磁盘 I/O 阻塞甚至耗尽存储空间。
- **清华算法**：
  - `storageCatalog.ts`：维护工作区与临时目录全局物理字典，登记每一个派生目录的用途与生命周期元数据；
  - `cleanPlan.ts`：根据任务归档状态与访问 LRU（已合并保留 1 天，未合并保留 7 天）生成安全的原子修剪计划；
  - `fsCleaner.ts`：带防并发文件锁与校验机制，安全清理废弃 Worktree、超期 Bash 日志（`/tmp/bi-bash-*`）与临时 Diff 缓存。
- **对 `bi` 价值**：直接作为 `BI-12.1` 的核心算法底盘，保障 `bi` 在高频政策调研与数据爬取下的长期驻留零存储膨胀。

#### (14) 智谱 BigModel Coding Plan 额度监测与余额预警看门狗 (`packages/services/src/usage-stats/`)
- **核心痛点**：深度调研任务往往需要经历多轮因果推演与长时间子任务执行，若用户 Coding Plan 额度即将耗尽或遭遇速率限制（RPM/TPM），任务可能在最后一步猝然中断报错，浪费前期所有计算。
- **清华算法**：
  - `bigmodelUsageQuotaProvider.ts`（63KB）与 `bigmodelUsageMonitorMapper.ts`（30KB）：针对智谱 BigModel API 建立专用额度感知与监测管道；
  - `usageStatsService.ts`：后台低频探查与本地缓存账户余额、剩余调用次数与限频水位，平滑计算当前使用速率与预警阈值。
- **对 `bi` 价值**：直接作为 `BI-02.2` 的底层实现，在终端 HUD 实时显性预警（如额度低于 10% 亮黄告警），避免任务中途意外断粮。

### 3. 清华系月之暗面 Kimi Code 官方源码十八大黄金模块与工业级算法图谱

月之暗面（Moonshot AI）技术团队同源于清华大学计算机系与交叉信息研究院。其最新开源的 `MoonshotAI/kimi-code`（位于本地只读参考库 `/home/yupeng/references/kimi-code`）代表了纯 TypeScript 技术栈下 Agent CLI 极简解耦架构的最高工程水平。系统深入审查后，提炼出其 **十大独特黄金资产与底层算法**，与 ZCode 形成强力互补：

#### (1) 纯 TypeScript 版 Tree-Sitter Bash 语法分析器 (`packages/tree-sitter-bash`)
- **核心痛点**：传统 CLI 执行 Bash 命令鉴权与安全审计（如检测 `rm -rf /`、拦截偷窃 `.env` / `~/.ssh` 凭据）时，若使用正则表达式极易被引号嵌套、变量替换（`eval` / 子 Shell 命令替换）绕过；若引入 C++ 编译的 `tree-sitter.node`，则彻底破坏 Bun 单文件独立二进制（`bun build --compile`）与跨发行版便携性。
- **Kimi 突破**：月之暗面手写了 **100% 纯 TypeScript 实现的 Tree-sitter Bash AST 解析器**：
  - 零原生 C/C++ 依赖，语法树节点类型 1:1 严格对齐官方 `tree-sitter-bash 0.25.0`；
  - 硬预算熔断机制：默认限制 `maxNodes = 50,000`、`timeoutMs = 50ms`，遇到病态递归或超长单行脚本立即安全返回 `{ ok: false, reason: 'aborted' }`，绝不卡死主事件循环；
  - 递归深度硬上限：语法替换深度锁定在 150 级、复合表达式锁定在 500 级，在 V8 默认调用栈下留足 2.5 倍以上安全余量，彻底根治栈溢出（Stack Overflow）。
- **对 `bi` 价值**：直接作为 `BI-06.1`（Credential Guard）的底层 AST 审计引擎，以零 C 依赖实现毫秒级高精度 Bash 命令安全检查。

#### (2) 细粒度读写锁并发调度器 (`packages/agent-core-v2/src/agent/toolExecutor/toolScheduler.ts`)
- **核心痛点**：多工具并发调用时，若两个工具同时读写同一文件，极易造成写写冲突或读到脏数据；简单串行化则严重劣化交互性能。
- **Kimi 算法**：
  - 落地 `ToolAccesses.conflict(left, right)` 细粒度资源读写锁（RWLock）矩阵：
    - `read` + `read` 或 `search` + `search`：无冲突，并行并发执行；
    - `write` + `read` 或 `write` + `write`：执行 `fileAccessesOverlap` 路径重叠判定，存在交集时自动进入阻塞队列；
    - `kind: 'all'`（如 Bash 全局命令）：作为全局内存屏障（Write Barrier），等待此前所有并发读写任务彻底排空（Drain）后再独占执行。
- **对 `bi` 价值**：为 `BI-07`（多工具并行流水线）提供了工业级确定性安全调度算法。

#### (3) 纯 TypeScript 嵌入式 LSM-Tree / WAL 存储引擎 (`packages/minidb`)
- **核心痛点**：传统 Agent 会话与索引依赖 SQLite（`sqlite3` / `better-sqlite3`），在多进程并发或 Bun 单二进制跨系统编译时，经常面临 `SQLITE_BUSY` 锁死或动态链接库缺失问题。
- **Kimi 创新**：月之暗面完全自研了 `minidb`——**纯 TypeScript 编写的高性能嵌入式 LSM 数据库**：
  - 架构包含 WAL（预写日志）、SkipList 内存跳表、Generation 分代文件合并压缩（LSM Compaction）、CRC32 校验与 Trigram 字符倒排索引；
  - 零外部 C/C++ 编译产物，单文件打包极其轻巧；
  - **对 `bi` 价值**：为 `BI-03` 会话索引与时间线缓存提供了零 C 依赖的理想备选引擎。

#### (4) 客户端自适应多模态与图片压缩管道 (`packages/agent-core-v2/src/agent/media/`)
- **核心痛点**：用户在终端交互中直接粘贴或拖入 4K 截图与长图时，未经压缩的原始图片会瞬间消耗数十万 Token 并引发 API 请求体超限报错。
- **Kimi 算法**：
  - `image-compress.ts`（25KB）：在客户端本地就地执行动态降采样与质量压缩；
  - `file-type.ts`（10KB）：基于 Magic Number 纯二进制探测文件真实 MIME 类型；
  - `byteLruCache.ts`：字节级内存 LRU 缓存，杜绝重复序列化与内存泄漏。
- **对 `bi` 价值**：大幅增强 `bi` 面对研报附图、政策红头文件扫描件时的 Token 经济性与鲁棒性。

#### (5) Agent Client Protocol 跨端标准服务端 (`packages/acp-server`)
- **核心痛点**：CLI Agent 只能在终端字符界面运行，无法与现代代码编辑器（VS Code、Zed、JetBrains）无缝结合。
- **Kimi 架构**：
  - 完整实现 Zed、Anthropic 与 JetBrains 联合倡导的 **ACP（Agent Client Protocol）** 开放规范；
  - 将核心 Agent 抽象为标准 JSON-RPC 服务端，支持命令批准、文件系统虚拟化挂载与双向事件推送；
  - **对 `bi` 价值**：`bi` 可直接复用该协议封套，一键打通终端 CLI 与 VS Code 侧边栏，实现跨端复用。

#### (6) 85% 水位自适应动态紧缩与带时间戳精确回滚 (`packages/agent-core-v2/src/agent/fullCompaction/`)
- **核心痛点**：长程任务中如何平滑紧缩历史，并支持用户精确撤销错误步骤？
- **Kimi 策略**：
  - 设定 `triggerRatio: 0.85` 触发水位，强制预留 `reservedContextSize: 50,000` Tokens；
  - 视窗安全底线：强制保留最近 4 轮完整消息（`maxRecentMessages: 4`），且未压缩部分上限锁定为视窗的 20%（`maxRecentSizeRatio: 0.2`）；
  - `undoService.ts`：基于逻辑时间戳（`turnKey`）计算 `computeUndoCut`，支持精确回滚上下文与状态。

#### (7) Tool-on-Demand 动态按需加载器 (`packages/agent-core-v2/src/agent/tools/select-tools/`)
- **核心痛点**：传统 Agent 将所接入的所有 MCP 工具（数十个甚至上百个）的全量 JSON Schema 完整注入到每一轮的 System Prompt 中，这会导致每轮交互无谓消耗 10,000 至 30,000 个静态 Token，既显著拉高首字延迟（TTFT），又严重挤占有效工作视窗。
- **Kimi 创新**：月之暗面设计了极具启发性的 **Tool-on-Demand 动态按需激活器 (`select_tools`)**：
  - 初态精简：在初始阶段，模型仅看到最基础的几项通用工具，其余所有高级插件或 MCP 工具仅以“工具名 + 单句职责摘要”的形式作为紧凑名录展示；
  - 动态激活：当模型研判到后续任务需要特定领域能力（例如查询数据库、生成 PDF、解析图表）时，通过自主调用 `select_tools({ names: ["query_logbook", "render_chart"] })`；
  - 即时装载：Agent 运行时捕获该信令后，动态将这批工具的完整 JSON Schema 注入当前激活工具池；
  - **对 `bi` 价值**：作为 `BI-13.1` 的核心算法，将初始 System Prompt 的工具 Token 开销直接压降 80% 以上，为长文本政策比对留出充裕的视窗空间。

#### (8) A2A 穿透式 WebSocket 中继控制通道 (`packages/remote-control/`)
- **核心痛点**：在远程协作或移动办公场景下，用户希望通过手机或远程 Web 控制台监控本地 CLI 的执行进度并进行人机审批，但本地机器处于家庭/内网 NAT 之后，无公网 IP 且无法开放入站端口。
- **Kimi 架构**：
  - 月之暗面在 `packages/remote-control/` 中自研了基于 WebSocket 的反向中继通道（`remote-control.ts`、`device-client.ts` 与 `manager.ts`）；
  - 本地客户端主动向受信任的 WSS 中继服务发起长连接，建立基于对称加密与握手验签的双向 RPC 隧道，0 开放公网入站端口，彻底规避公网攻击面；
  - 支持远程流式接收终端事件通知、发送中断与纠偏信令，并在遇到高危写操作时将 Unified Diff 渲染推送到移动端供人类审查批准。
- **对 `bi` 价值**：作为 `BI-15.4`，与邮件信令网关（BI-15.1）与 GitHub PR 任务中枢（BI-15.2）形成“轻量穿透 WSS + 跨物理网络 SMTP/IMAP + 生产级代码 PR”的三维立体 A2A 跨网协作网络。

#### (9) CJK 东亚宽字符排版与四层同构 Transcript 状态投影 (`packages/pi-tui/src/utils.ts` 与 `packages/transcript/`)
- **核心痛点**：
  1. 字符排版错位：标准 TUI 终端库往往假设所有字符均为单字节等宽（单列），当输出中文政策条文、全角中文标点或 Emoji 符号时，终端计算列偏移产生严重偏差，导致边框错位、换行截断与表格完全撕裂；
  2. 历史与视图耦合：会话状态如果直接绑定在渲染层，容易在格式化渲染时污染底层的历史消息树，导致时光倒流与导出不一致。
- **Kimi 突破**：
  - 在 `packages/pi-tui/src/utils.ts` 中深入整合 Unicode 宽字符标准，实现严密的 `get-east-asian-width` 判定算法，精确识别中文双宽度字符；
  - 在 `packages/transcript/` 中构建了四层同构转录投影架构：`Contract`（契约定义） → `Model`（不可变状态模型） → `History / Store`（底层持久化存储） → `View / Markdown`（终端差分视图与研报 Markdown 导出），四层严格单向流动解耦。
- **对 `bi` 价值**：直接作为 `BI-19.1`，彻底根除中文政策研报在终端交互中的版面错位与塌陷问题，并确保终端历史与磁盘研报的 100% 同构一致。

#### (10) 统一 LLM 抽象层与能力规范化注册表 (`packages/kosong/`)
- **核心痛点**：不同大模型服务商（智谱 GLM、DeepSeek、Moonshot、Claude、OpenAI）在 API 契约上存在微小但致命的碎片化差异：Tool Call ID 的命名约束、连续用户消息是否允许合并、流式事件中空文本块的处理等。若在核心逻辑中堆砌大量的 `if (model === 'xxx')`，系统极难维护且极易引入回归 Bug。
- **Kimi 架构**：
  - 月之暗面抽取了独立的 `packages/kosong` 抽象层；
  - 核心包含 `capability-registry`（能力特性矩阵字典，声明式标注各模型是否支持缓存控制、并发工具调用、推理思考流等）、`tool-call-id` 自动化标准化器以及 `merge-user-messages` 中间件；
  - 对上层 Agent 屏蔽物理模型差异，对外暴露完全一致的标准化流式事件接口。
- **对 `bi` 价值**：大幅简化 `BI-04` 单模型统一 SSE 流式驱动的适配器复杂度，实现零业务侵入的即插即用。

#### (11) 工业级强化版 Pi-TUI 差分双缓冲与 PasteBurst 防冲看门狗 (`packages/pi-tui/`)
- **核心痛点**：
  1. 原版 `@earendil-works/pi-tui` 缺乏粘贴保护机制。用户从浏览器或文档中直接粘贴大段政策文本、JSON 或长 SQL 时，终端模拟器若未启用 Bracketed Paste Mode，高速连发的字符流会在几毫秒内触发 Enter 回车误判，导致半截提示词被提前提交给大模型；
  2. 原版字符宽度缓存仅 512 条目，面对海量中文字符串容易发生哈希冲突并退化为单字节宽度；
  3. 缺乏多 Agent 并发与工具折叠渲染的高阶组件。
- **Kimi 工业化强化**：
  - 在 `packages/pi-tui/src/paste-burst.ts` 中实现 62 行极简且确定性的 **PasteBurst 状态机**：监控字符接收脉冲间隔，当检测到短时间高频字符突发输入时，自动拦截压制 Enter 回车键达 120ms，杜绝任何长文本粘贴意外提交；
  - 在 `packages/pi-tui/src/utils.ts` 中将 CJK 字符宽度缓存扩容至 4,096 条目，全面适配东亚宽字符；
  - 提供了工业级终端渲染组件：`agent-swarm-progress.ts`（69KB，多 Agent 并发动态泳道进度看板）、`read-group.ts`（多文件读取折叠卡片）与 `tool-call.ts`（工具调用状态指示器）。
- **对 `bi` 价值**：直接作为 `BI-19` 的核心底盘，复用率高达 95% 以上，彻底解决终端渲染跳字、误提交与多 Agent 协同可视化的痛点。

#### (12) Plan 模式只读探索规划与用户审批门禁 (`packages/agent-core-v2/src/features/plan/`)
- **核心痛点**：在长程复杂工程任务中，Agent 极易由于过度自信，在未摸清上下文前盲目执行破坏性写操作或连续修改关键代码，导致后期回滚灾难。
- **Kimi 架构**：
  - 月之暗面在 `features/plan/` 中自研了纯状态驱动的 Plan 模式（`planService.ts` 9.7KB、`exitPlanModeReview.ts` 5.7KB 与 `planOps.ts`）；
  - 进入 Plan 模式后，系统通过动态工具降权切入只读探索沙箱，物理拦截所有文件修改与高危 Bash 命令，强制 Agent 专心进行文件搜索、代码阅读与 AST 依赖排查，并生成严密的结构化执行计划；
  - 执行前触发交互式审查门禁（`exitPlanModeReview`），必须由用户在终端审查通过后，才赋予写操作权限并平滑过渡至执行阶段。
- **对 `bi` 价值**：直接作为 `BI-14.2`，彻底杜绝长程复杂任务中 Agent“一上来就乱改乱撞”的反模式。

#### (13) TodoList 动态清单主动注入与进度防漂移守卫 (`packages/agent-core-v2/src/features/todo/`)
- **核心痛点**：长程多轮交互（20~50 轮）中，随着 Context 上下文膨胀，大语言模型会出现严重的注意力稀释（Attention Dilution），极易遗忘初始长程目标、跳过关键中间步骤或提前宣告完工。
- **Kimi 架构**：
  - 月之暗面在 `features/todo/` 中实现了基于事件状态机的待办清单系统（`todoService.ts` 6.1KB、`todoListReminder.ts` 4.6KB 与 `todoItem.ts`）；
  - 维护会话级待办状态机（`pending`、`in_progress`、`completed` 三态，单向流转并防回退）；
  - 通过 `todoListReminder` 在每次模型推理前（`beforeStep`）动态提取未完成待办，以轻量化结构主动注入 Context 尾部（In-History 友好排布，不破坏头部 Prompt Cache），强行校准模型注意力。
- **对 `bi` 价值**：直接作为 `BI-14.3`，与 ZCode 的完工自验看门狗（BI-21.1）及 DeepSeek 的 Goal 自动续行（BI-07.5）形成合力，彻底消灭长程任务中的步骤跳跃与目标漂移。

#### (14) 外部生命周期钩子系统 (`packages/agent-core-v2/src/features/externalHooks/` 32KB)
- **核心痛点**：企业合规审计、前置代码扫描或外部 CI 联动往往需要在 Agent 执行特定工具、开始会话或发起审批时插入定制逻辑。缺乏外部钩子时，开发者只能通过魔改源码或全局代理进行硬拦截。
- **Kimi 架构**：
  - 月之暗面在 `features/externalHooks/` 中建立了完备的生命周期钩子总线；
  - 支持在 `config.toml` 中声明 `[[hooks]]`，内置 20 种关键生命周期事件（`PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PermissionRequest`、`PermissionResult`、`UserPromptSubmit`、`TurnStarted`、`SessionStart`、`SessionEnd`、`PreCompact`、`PostCompact` 等）；
  - 钩子执行外部 Shell 命令，接收 JSON 格式的执行上下文，并支持基于 `{ action: 'allow' | 'block', reason: '...' }` 进行原子化操作阻断。
- **对 `bi` 价值**：直接作为 `BI-06.4`，使 `bi` 原生具备企业级安全阻断与外部自动化脚本插拔能力。

#### (15) 会话内 Cron 定时调度服务 (`packages/agent-core-v2/src/features/cron/` 60KB)
- **核心痛点**：长程自动化运维与监控中，开发者常需要 Agent 每隔一段时间（如每 5 分钟）轮询 CI 状态、拉取部署指标或检查服务器健康，传统 CLI Agent 只能依赖阻塞式 sleep 或外部手动轮询。
- **Kimi 架构**：
  - 月之暗面在 `features/cron/` 中基于 XState 状态机实现了活跃会话内的定时器引擎（`cronService.ts` 593行）；
  - 向大模型暴露 `CronCreate`、`CronList`、`CronDelete` 3 大工具；
  - 支持标准 5 字段 Cron 表达式与毫秒级间隔定时器，内置随机抖动（Jitter）防瞬时惊群，支持事件溯源与会话 Fork 继承。
- **对 `bi` 价值**：直接作为 `BI-07.7`，与夜间错峰调度（BI-02.3）互补，赋予 `bi` 活跃会话内自主挂载定时探针的能力。

#### (16) Tower 多 Agent 工作区协同协议与合并门禁 (`packages/agent-core-v2/src/features/tower/` 116KB)
- **核心痛点**：单 Agent 串行处理大型多模块项目时效率低下；而盲目并发修改又会导致文件读写冲突与代码损坏。
- **Kimi 架构**：
  - 月之暗面在 `features/tower/` 中自研了 Tower 多 Agent 协同系统（`towerService.ts` 36.7KB、`bashGuard.ts` 16.7KB）；
  - 提供 13 个 `Tower*` 专用工具（`TowerInit`, `TowerPlan`, `TowerSpawn`, `TowerMerge`, `TowerRebase`, `TowerReview`, `TowerFinding`, `TowerMission`, `TowerInbox`, `TowerStatus` 等）；
  - 基于 Git Worktree 在物理隔离分支上协同派生 Worker 与 Reviewer，通过 `.tower/comms/` 专用信令通道交互，并实行严密的 Merge Gate 审查合并门禁。
- **对 `bi` 价值**：直接作为 `BI-12.2`，为 `bi` 提供了基于 Git Worktree 的大型多模块分布式并行施工底座。

#### (17) 系统桌面级原生通知与长任务催促看门狗 (`packages/agent-core-v2/src/features/notify/`)
- **核心痛点**：耗时 5~15 分钟的超长程宏观分析或全量编译时，开发者不可能全程死守终端；当 Agent 中途需要人类用户确认审批时，若无主动提醒，会话容易长时间卡死在等待状态。
- **Kimi 架构**：
  - 月之暗面在 `features/notify/` 中提供了 `notifyUserNudgeService.ts` 与 `notify-user` 工具；
  - 当长耗时后台任务执行完成、或 Agent 等待人类审批超过预设阈值时，自动调用操作系统原生通道（Linux `notify-send` / macOS AppleScript / Windows PowerShell）弹出系统通知，并发出终端蜂鸣 `\a`。
- **对 `bi` 价值**：直接作为 `BI-19.3`，彻底解放开发者守候终端的心理焦虑，实现真正的非阻塞异步交付。

#### (18) 工业级完整 CLI 辅助生态子命令群与参数矩阵 (`apps/kimi-code/src/cli/`)
- **核心痛点**：仅有单入口交互式命令往往难以满足 CI/CD 自动化流水线、团队研报导出分享、备选路径分叉探索及多工作区协同等复合场景。
- **Kimi 架构**：
  - 在 `apps/kimi-code/src/cli/sub/` 中提供了一整套成熟的辅助子命令群：
    - `export`：将会话上下文与多轮对话一键导出为独立排版的 Markdown、HTML 报告或分享归档；
    - `fork`：在 CLI 命令行直接针对历史会话任意轮次进行分叉克隆；
    - `session`：提供 `list`、`show`、`prune` 等终端会话快速管理能力；
    - `vis`：启动本地 Web 服务，在浏览器中直观复盘审查会话 DAG 与 Diff；
  - 在 `commands.ts` 中提供了完备的 CLI 启动参数矩阵：`--agent-file <path>`（支持单 Markdown 文件直接加载自定义 Agent）、`--add-dir <dir>`（多根工作区挂载）与 `--prompt <p> --output-format stream-json`（流水线无头非交互直出）。
- **对 `bi` 价值**：直接作为 `BI-20.2`，一举补齐 `bi` 从“极客交互终端”走向“工业级通用命令行工具集”的最后一块拼图。


### 4. ZCode 全量工程底座（桌面宿主、CUA 视觉反爬与视觉裁判）资产解包深度发现

随着 ZCode 官方仓库 19 个包（11,855 个源文件）全量检出至本地只读参考库，我们对清华官方的桌面形态、服务层与视觉判定进行了深度代码走读，提炼出三大核心资产：

#### (1) 官方桌面应用架构与核心宿主解耦 (`packages/desktop`)
- **架构解耦**：官方桌面版基于 Electron 41 + React 19 + Tailwind CSS，但其内核严格划分为：
  - `packages/desktop/src/main/`：原生窗口与宿主生命周期管理；
  - `packages/desktop/src/renderer/`：高交互 React 视图；
  - `packages/desktop/src/host/`：与内核引擎（`packages/core`）的零拷贝直接桥接。
- **对 bi 的指导**：验证了内核引擎完全独立于表现层，`bi` 采用相同的微内核设计，可在极简 Pi-TUI 终端与未来桌面形态之间零成本复用同一个引擎。

#### (2) 视觉核验判定器闭环 (Visual Judge - `apps/zcode-cli/packages/spreadsheets-plugin/agents/visual-judge.md`、`visualize-skill-gate.ts` 与 `packages/services/src/gen-ui/`)
- **核心痛点**：在数据分析与宏观研报场景中，Agent 自动编写 Python/ECharts/SVG 脚本生成的可视化图表，极易出现文字穿模重叠、坐标轴刻度过密挤压截断、图例溢出或配色反差缺失等“代码语法正确但视觉体验灾难”的问题。
- **清华算法**：
  - 在图表渲染后，通过 Headless 浏览器自动将 HTML/SVG 图表快照转换为图片；
  - 启动 Visual Judge 多模态专用视觉评判智能体，执行 5 维度严苛视力体检：文字重叠率（0 重叠）、坐标轴标签完整度（0 截断）、图例可见性、图表边缘留白与暗黑/明亮色阶自适应；
  - 判定不通过时，即时生成带有具体 CSS/配置参数的微调指令，回灌给绘图智能体自愈重绘，形成“生成 → 截图 → 视觉评判 → 自愈重绘”的闭环，确保交付 0 瑕疵的商业级研报图表。
- **对 bi 的价值**：直接吸收为 `bi` 的 `BI-18.2` 视觉核验判定器，彻底拉开与普通开源 Agent 的专业度差距。

#### (3) Computer Use Agent (CUA) 动态反爬兜底体系 (`packages/zcode-cua/`)
- **核心痛点**：官方统计局公报、行业协会高频数据往往部署在反爬虫、Cloudflare 人机验证盾或复杂动态 SPA 网页背后，传统只读 HTTP `curl`/`fetch` 频繁返回 403 Forbidden 或空白挂载点。
- **清华方案**：
  - 官方实现独立的 `packages/zcode-cua/`，内置 `broker-server.ts` 与 `pip-session-node.ts`；
  - 支持视窗画中画（PiP）受控视觉交互，模拟真实用户浏览、点击翻页与等待网络请求排空；
- **对 bi 的价值**：为 `bi` 的政策探针（Scout）提供最强兜底。当标准抓取被强反爬拦截时，平滑降级至受控 Headless/CUA 机制获取数据，杜绝数据盲区。

#### (4) 智谱 BigModel 闲时任务错峰调度引擎 (Off-Peak Scheduler - `packages/services/src/session/offPeakTaskService.ts` 与 `packages/desktop/src/scheduler/index.ts`)
- **核心痛点**：长周期宏观经济测算、数十个行业多年度政策推演与海量上市公司研报穿透比对需要吞吐数百万至数千万 Token。若在日间高峰期直接在线调用，不仅容易遭遇并发限流（Rate Limit），而且会急速消耗昂贵的 Coding Plan 额度。
- **清华架构**：
  - 清华官方在 `offPeakTaskService.ts`（681 行完整状态机）与 `offPeakServerClient.ts` 中实现了工业级错峰异步调度机制；
  - 排队取号与长轮询：向智谱错峰服务器申请排号 Ticket（`POST /ticket`），进入挂起队列并通过轻量级心跳后台轮询（`GET /ticket/status`）；
  - 3102 异常续跑自愈：大模型运行超时或凭据过期（状态码 3102）时，自动触发重试续期与状态恢复；
  - 终态 Outbox 结算：在智谱官方闲时窗口（夜间/周末算力波谷）以 1~3 折超低算力成本批量跑通，任务完成后原子回写入 Outbox 提货箱。
- **对 `bi` 价值**：直接作为 `BI-02.3` 智谱 BigModel 闲时任务错峰调度引擎，使用户能够在下班前一键派发“夜间重度宏观政策推演”任务，次日早晨直接提货完整报告，大幅节约算力成本。

#### (5) 智谱与 ZCode 官方赠送 Token 申领与免费加速抽卡架构 (`packages/services/` 与 `packages/shared/src/highspeed.ts`)
- **核心痛点**：智谱官方与 ZCode 经常在特定周期（新用户注册、周末算力狂欢、节假日福利活动、版本升级补偿）定向投放数百万至数百亿 Units 的限时赠送 Token 与免费高速推理卡。传统开源 Agent 缺乏与官方福利营销中枢对接的能力，导致用户无法感知并错失大量免费算力红利；或者因未及时消耗，赠送额度在后台静默过期。
- **清华官方实现**：
  - **赠送包自动探测与原子入账**：官方在 `bigmodelCodingPlanSubscriptionProvider.ts`（272~408 行）与 `zaiStartPlanBilling.ts` 中实现了完整的权益探测与核销闭环：
    - `GET /api/v1/zcode-plan/billing/preview`：请求带 App Version 与平台指纹，拉取当前账号所有可领取的限时体验套餐（如 `weekend-plan`、`start-plan`）；
    - `POST /api/v1/zcode-plan/billing/claim`：携带 JWT 凭据与防刷标头，一键申领并将福利 Token 原子挂载至用户的 `user_plan_id` 实例，回显生效期与截止期；
    - `GET /api/v1/zcode-plan/billing/balance`：动态轮询赠送额度余额（`total_units`、`remaining_units`、`expires_at`），客户端结合服务端时钟自动做过期修剪。
  - **免费高速推理抽卡机制 (Highspeed Card)**：在 `highspeedCardService.ts`（383 行）与 `highspeedHttpTransport.ts` 中，会话发起前自动调用 `POST /api/v1/highspeed/draw` 抽取加速卡，抽中可走 `/api/v1/highspeed/` 专线大幅提升推理 TPS；若卡过期（业务错误码 `3402`），状态机自动平滑降级回原模型继续执行，杜绝中断。
- **对 `bi` 价值**：直接作为 `BI-02.4`，使 `bi` 具备自动感知官方赠送福利、一键 `/claim` 申领入账并在 HUD 中优先抵扣即将过期算力的完整能力。

### 5. Pi Agent 原创架构与 CodeMode 内存精算沙箱深度走读

除清华大学 ZCode 与清华系 Kimi Code 外，本地参考库中的 `@earendil-works/pi`（Pi Agent）同样贡献了两大顶尖工程设计：
1. **DAG 树状会话引擎**（`packages/coding-agent/src/core/session-manager.ts`）：单文件 2,014 行极简实现，基于 UUIDv7 的天然因果时间线与分支切换机制，构成了 `bi` 树状会话（BI-03）的原型基础；
2. **CodeMode 零依赖内存精算沙箱**（`packages/codemode/src/runtime/`）：
   - 包含 `vm.ts`（13.9KB）、`worker.ts`（1.5KB）与 `execution.ts`（21.9KB）；
   - 基于 Node.js/Bun 原生的 `node:vm` 模块与独立 Worker 线程，构建了带有上下文注入与 API 绑定的轻量级 JavaScript/TypeScript 执行环境；
   - 启动延迟 < 1ms，内存开销 < 5MB，完美胜任高频的轻量级数据清洗、JSON 模式转换与数学校验；
   - **对 `bi` 价值**：作为 `BI-16.1`，与基于系统的 Python 沙箱（`BI-16`，专司重量级 `pandas`/`openpyxl` 政策表格审计）形成黄金互补，兼顾轻量秒级转换与重度数据精算。

### 6. 深度求索 DeepSeek 官方 Harness 原生全景剖析与可吸收技术资产清单

深度求索官方开源的 `deepseek-ai/deepseek-harness`（本地检出于 `/home/yupeng/references/deepseek-harness`，16,225 个源文件全量就绪）是 DeepSeek 团队专为大模型智能体自主执行、代码生成与多轮工具调用量身定制的官方工程脚手架。

#### (1) 框架定位与 Zero-Conflict（零冲突）吸收边界

DeepSeek Harness 在系统顶层基于 Cordis 依赖注入与插件树框架构建，按 Profile（`web`、`headless`、`sdk`、`acp`）组织分发。
- **Zero-Conflict 顶层约束**：`bi` 坚决**不吸收 Cordis 框架微内核**。Cordis 带有沉重的 IoC 依赖注入总线与隐式插件声明，与 `bi` 的 TypeScript + Bun 极简单体微内核、零黑盒、极致冷启动设计哲学存在不可调和的对抗成本；
- **精准吸收策略**：`bi` **仅原子级提取其针对 DeepSeek 系列模型（V3、R1、V4）的核心通信协议、思考流解析、前缀缓存保持、视窗剪枝、PTC 程序化工具调用与官方抗压基准**，以纯净的函数式与服务类方式融入 `packages/core` 与 `packages/workflow`。

#### (2) DeepSeek Harness 十大原子级核心技术资产全景清单

##### 1. DeepSeek Messages 原生 Wire 协议与双模态适配器 (`packages/llm/llm-deepseek/`)
- **核心痛点**：DeepSeek 官方服务端支持 Anthropic Messages 规范子集（兼容 `thinking` 块、`signature` 签名保留、`defer_loading`）以及 OpenAI Chat Completions 协议（`reasoning_content`）。普通开源 Agent 仅当成标准 OpenAI 接口调用，丢失思考流签名，导致多轮回放校验失败；
- **官方实现**：
  - 在 `src/wire-types.ts` 与 `src/serialize.ts` 中定义了完整的 DeepSeek Messages 协议：`WireBlock` 原生区分 `text`、`thinking`、`tool_use`、`tool_result`；
  - 推理强度四档可控：`thinking: { type: 'enabled' | 'disabled' }`，`output_config: { effort: 'low' | 'high' | 'max' }`；
  - 思考流与签名无损回放：在 `src/translate.ts` 中监听 `thinking_delta` 与 `signature_delta`，流终止时在 `ReplayEnvelope` 中封存由 DeepSeek 签发的密码学签名 `signature`。在后续轮次回放该 Assistant 消息时，将签名原样带回，保证服务端缓存与防篡改校验 100% 通过；
  - 终态防御：流式解析识别 `EMPTY_RESPONSE`（空内容且 finish 为 stop），转化为可重试失败（`dsh-llm-retry`），杜绝静默假成功；统一捕获 `CONTEXT_WINDOW_EXCEEDED` 规范错误码。
- **对 bi 的落地价值**：直接作为 `BI-04.2` 的核心通信层，使 `bi` 原生兼容 DeepSeek-V3 与 DeepSeek-R1 官方协议。

##### 2. DeepSeek 官方 v41 视觉 Token 几何网格投影算法 (`src/image-tokens.ts`)
- **核心痛点**：多模态研报图表、政策红头文件扫描件输入 DeepSeek 时，如果不按照官方视觉编码器的切片网格进行精确定价，会导致 Token 计数严重漂移，引发视窗意外撑爆或请求被拒；
- **官方算法**：
  - 严谨实现 DeepSeek 官方公布的 `v41` 视觉 Token 计算器：
    - 图像分块与下采样常量：`PATCH_SIZE = 14` 像素，`DOWNSAMPLE_RATIO = 3`，最小像素底限 `MIN_PIXELS = 544 * 544`，单元格尺寸 `CELL_SIZE = 42` 像素，单图 Token 硬顶 `MAX_IMAGE_TOKENS = 1024`；
    - 单元格与分块换算：`gridCells(paddedLength) = ceilDiv(intDiv(paddedLength, 14), 3)`；
    - 网格 Token 计算公式：`gridTokens(H, W) = H * (W + 1) + 2`（每行附加一个分隔符，整图附加两枚取帧 Token）；
    - 保宽高比网格求解器：`solveResizeRatio(height, width, budget)` 封闭求解，在 1024 Token 预算内求解最大几何网格，并通过 `resizeOnce` 循环迭代至不动点（Fixpoint）。
- **对 bi 的落地价值**：融入 `BI-04.2` 与 `BI-08`，为带有政策图表、上市公司财报截图的会话提供 100% 与官方物理服务端对齐的 Token 预测与视窗预算。

##### 3. Pi-AI 关键性能补丁：流式工具调用 O(N²) CPU 暴击消除 (`patches/@earendil-works__pi-ai@1.1.0.patch`)
- **核心痛点**：上游 `@earendil-works/pi-ai` 与 `@mariozechner/pi-agent-core` 在流式接收长工具调用（如大段 Bash 脚本、复杂 JSON）时，每个 token delta 到达都会无谓执行一次 `parseStreamingJson(partialJson)`。对数千 Token 的工具参数，逐字符反序列化导致累积计算量高达 O(N²)，瞬间吃满单个 CPU 核心并导致 Node.js 事件循环完全卡死，终端 TUI 剧烈掉帧；
- **官方补丁**：
  - DeepSeek Harness 团队向 pi-ai 注入了经过严苛生产验证的底层补丁；
  - 在 `anthropic-messages.js`、`openai-completions.js`、`openai-responses-shared.js`、`pi-messages.js` 等所有流解析器中，移除了增量 delta 阶段的 `parseStreamingJson`；
  - 仅做字符串拼接 `block.partialJson += event.delta`，将反序列化推迟到 `toolcall_end` 块终止事件一次性完成；
- **对 bi 的落地价值**：`bi` 的 TUI 底座基于 Pi-TUI 与 Pi-Agent 协议，直接合入该补丁可彻底根除长工具调用流式卡死隐患，确保 60FPS 极速响应。

##### 4. In-History 系统提示词与工具增量更新协议 (`serialize.ts` & `agent-loop`)
- **核心痛点**：传统 Agent 每当工作区指令、长期记忆或可用工具发生微调时，都粗暴地改写请求消息列表第 0 项的 `system` 消息。在支持前缀缓存（Prompt Cache）的服务端（如 DeepSeek-V3），这会导致从第 0 个 token 起的所有 KV Cache 彻底失效，使多轮会话的延迟暴增 3 至 5 倍，调用成本飙升；
- **官方设计**：
  - 模型声明能力 `systemPromptUpdate: 'in-history'` 与 `toolUpdate: 'addition-only'`；
  - 系统提示词更新不再覆盖第 0 号节点，而是将非空的变更提示词作为 `role: 'system'` 节点追加在已缓存的用户轮次之后、下一轮 assistant 之前；
  - 工具动态增删通过 `role: 'developer'` 消息中的 `tool_addition` 与 `tool_removal` 块表达，引用新请求头的声明；
  - 保持已有历史字节级不变，使 DeepSeek 前缀缓存命中率稳定维持在 85% 以上。
- **对 bi 的落地价值**：直接融入 `BI-04.1` 与 `BI-04.2`，实现长流程政策调研场景下最大化复用 DeepSeek KV Cache。

##### 5. 超大工具结果中间剪枝算法 (`compaction-tool-result-pruner`)
- **核心痛点**：工具输出往往呈现“头部是配置与启动信息，尾部是执行结果或退出码，中间是海量重复日志”的特征。若完整保留，迅速耗尽视窗；若直接全量丢弃，模型丢失关键退出状态；
- **官方算法**：
  - 在 `src/index.ts` 中实现纯确定性的中间剪枝器：
    - 配置字符阈值：`thresholdChars = 8192`，头部保留 `headChars = 4096`，尾部保留 `tailChars = 1024`；
    - 基于 Unicode 码点安全切片，杜绝切断 UTF-16 代理项对与 Emoji；
    - 超限工具输出自动重构为：`[保留前 4096 字符] + "\n\n[... tool result middle pruned ...]\n\n" + [保留后 1024 字符]`；
    - 原始完整结果完整写入 Append-only 磁盘会话日志，视窗内结果仅占用固定码点预算；
  - 零 LLM 模型调用：纯数学字符串切片，耗时 < 0.1ms，在不消耗任何 Token 的前提下即时释放 60% 至 75% 的上下文压力。
- **对 bi 的落地价值**：作为 `BI-08.1`，与 64KB 有界截断（BI-08）和 Microcompact 脱水（BI-09）形成纵深递进的工具输出防膨胀体系。

##### 6. 大文本溢出转储与按需索引句柄 (`spill` + `spill-local`)
- **核心机制**：
  - 当工具输出或文件内容超过内联 Token 安全预算（`maxInlineTokens`）时，自动触发 Spill 溢出策略；
  - `spill-local` 将完整正文写入本地 `.bi/spill/<session-id>/<spill-id>.txt`；
  - 视窗中仅向模型返回结构化引用句柄（`SpillRef`），声明文件哈希、总行数、字节尺寸与安全提取指引；
  - 模型在研判需要深入研读时，通过 `read_file(path, offset, limit)` 按需分块窥探。
- **对 bi 的落地价值**：与 `BI-08.1` 配合，彻底封死单次海量输出（如几万行政策汇编全量导出）冲垮上下文窗口的任何可能性。

##### 7. 重复工具调用卫生守卫与死循环防范 (`repeat-tool-reminder`)
- **核心痛点**：大模型在受挫时容易陷入死循环——使用完全相同的参数反复调用同一工具（如反复 `grep` 同一个不存在的文件，或反复执行失败的命令）；
- **官方算法**：
  - 在 `tools/post-execute` 阶段挂载轻量卫士，为每个 Agent 维护 `WeakMap<Agent, Chain>`；
  - 精确规范化匹配：参数通过深度键排序后 `JSON.stringify` 形成确定性签名；
  - 阶梯式建议提醒：
    - 连续重复达 3 次：向模型追加温和提醒，要求模型仔细审视上一次结果，换用不同参数或方法；
    - 连续重复达 5 次与 8 次：注入详细告警，列出重复工具名称、重复次数与参数截断预览，建议终止无效尝试；
  - 软引导而非硬拦截：不强行阻止调用，保持决策权在模型手中，新用户消息即刻重置计数器；排除 `todo_write` 等正当的幂等工具。
- **对 bi 的落地价值**：作为 `BI-07.5`，使 `bi` 在执行无人类看管的长时间政策调研推演时具备极强的自省与跳出死循环能力。

##### 8. 程序化工具调用模式 (PTC Mode / Programmatic Tool Calling - `ptc-runtime`)
- **核心突破**：传统 Agent 调用工具走“单步 JSON 调用 → 服务端往返 → 中间结果污染上下文 → 下一步”的低效回路。DeepSeek Harness 创新性推出了 **PTC Mode**：
  - 工具编译：自动将所有已挂载工具（如搜索、读文件、精算）的 JSON Schema 编译生成 TypeScript `.d.ts` / Python 类型声明文件，作为静态指导注入 System Prompt；
  - 暴露保留通道：模型在提示词中仅看到保留工具 `run_code({ code, description })`；
  - 代码化流水线：模型针对生成的 `tools.<name>(args)` 接口编写一段脚本，支持变量暂存、`for` 循环批量处理、`if` 条件分支判断以及 `Promise.all` 批量并发调用；
  - 沙箱执行与结果精简：脚本在受控隔离沙箱中执行，中间数据全在内存中流转，仅将模型显式 `return` 或 `console.log` 的最终提纯结果返回给模型视窗；
  - 收益：模型往返次数降低 80%，中间结果造成的 Token 浪费降低 85% 以上。
- **对 bi 的落地价值**：作为 `BI-16.2`，与 Python 沙箱数据审计（BI-16）及 JS 内存秒算（BI-16.1）结合，形成“原生工具 + 内存秒算 + PTC 批量脚本”的三态工具执行体系。

##### 9. 会话目标自驱与长流程自动续行引擎 (`goal` + `goal-round-driver`)
- **核心机制**：
  - 领域状态机：每会话持久化一个结构化完成目标，提供 `get_goal`、`create_goal`、`update_goal` 三大工具，支持目标创建、暂停、恢复、阻塞标记与最终达成；
  - 自动续行驱动器（`goal-round-driver`）：当会话设置了活动目标且前序轮次尚未标记 `completed` 时，在无用户新输入的情况下，驱动器自动将进行中的工作转化为连续的执行轮次（Rounds），跨网络抖动与空闲等待无缝自愈推进。
- **对 bi 的落地价值**：作为 `BI-07.5` 的长程任务引擎，与 `bi` 的 Workflow DAG 编排（BI-14）及任务完工自验看门狗（BI-21.1）无缝契合，提供单会话内完全自主推进到底的攻坚力。

##### 10. Agent 基准评测体系与极限内存压测套件 (`benchmarks/`)
- **核心价值**：DeepSeek 官方在 `benchmarks/` 中为 Agent 设计了工业级回归门禁套件：
  - 长会话折叠测试（`conversation-fold`）：检验万级历史事件折叠成当前视窗时的 CPU 与内存消耗；
  - 流式重连弹性测试（`active-stream-reconnect`）：模拟网络断流时 SSE 增量恢复与重放；
  - 终端 IO 伸缩测试（`terminal-io`）：大密度字符输出时的无阻塞排队能力；
  - 极限内存硬顶约束：在无 Swap 的 4GiB 与 8GiB cgroup 容器中对 Agent 全流程运行峰值 RSS 设硬顶门禁。
- **对 bi 的落地价值**：为 `bi` 提供了可直接借鉴的端到端质量验收基准，确保在 2C2G / 4C8G 规格主机上稳定生产运行。

### 7. 四大标杆未竟深水区与全景防遗漏资产深度补全 (Comprehensive Gap & Uncovered Assets)

结合开发者社区在真实项目中的高频痛点与源码深度穿透，我们对 ZCode、Kimi Code、DeepSeek Harness 以及 Pi Agent 的未被充分显式化的底层资产进行了地毯式清查，提炼出七大关键杀手锏机制，并全量增补至 `devplan.md`：

#### (1) 写前物理快照与无损文件历史回滚器 (Pre-Write Blob Snapshot & File History - `BI-03.2`)
- **源码参考**：Kimi Code `packages/agent-core-v2/src/features/fileHistory/fileHistoryService.ts` (24.8KB)、`fileHistoryRetention.ts`、`IBlobStore`。
- **核心痛点**：传统 Agent 依赖 Git 回滚，但在非 Git 目录、未初始化仓库或存在大量非跟踪文件时，一旦大模型执行错误的写操作或覆盖了已有代码，Git 回滚彻底失效，造成灾难性数据丢失。
- **工程实现**：在任何写工具（`edit`, `write_to_file`, `bash` 写操作）分发前，触发 `WillExecuteToolEvent` 拦截器；利用 SHA-256 实时计算目标文件哈希，将二进制内容原子写入 `.bi/blobs/`，按 `turnId` 与执行阶段索引建立不可变文件历史快照；支持用户随时按轮次精准回滚单个或多个文件，与 Git 彻底解耦。

#### (2) 会话状态空间形式化矩阵与不变量防竞态矩阵 (Product State Space & Invariant Guards - `BI-03.3`)
- **源码参考**：清华 ZCode `packages/formal-proof/` 与 `docs/conversation-product-state-space.md` (19.5KB 核心规范)。
- **核心痛点**：现代 CLI Agent 集成了 Compact 压缩、Fork 分支、Goal 目标续行、Subagent 派生、消息队列与 Query 编辑，多线程异步信令极易产生死锁或非法状态漂移（如：在 Subagent 活跃运行时并发触发 Compact 导致上下文撕裂；在流式生成中途执行 Fork 导致历史错乱）。
- **工程实现**：建立由 `[runPhase] × [activeWork] × [queueAuthority] × [用户动作]` 构成的笛卡尔积状态转移矩阵；严格落地核心守卫不变量（Invariant Guards），在编译期与运行时阻断非法转换，根治状态机死锁。

#### (3) 工具调用协作式超时看门狗 (Tool Timeout Policy & Cooperative Deadline Guard - `BI-06.3`)
- **源码参考**：DeepSeek Harness `packages/guard/timeout-policy/` (8.3KB)、`packages/guard/timeout-policy/src/index.ts`。
- **核心痛点**：外部网络请求（`web_search`、`web_fetch`）、第三方 MCP 服务或复杂 Python 脚本容易因服务端挂起或死锁无限期阻塞，导致 CLI 进程假死，用户被迫强制 `kill -9`。
- **工程实现**：各工具显式声明自身运行预算（如搜索 30s、MCP 60s、Python 120s）；执行包装层为每个调用生成带截止时间的 `AbortSignal`；超时触发时协作式取消下游并在 `tools/execute` 返回标准化错误 `{ name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' }`，向模型清晰报告超时并赋予其自主重试或降级自愈能力，杜绝全进程冻结。

#### (4) `/btw` 旁路零干扰问答微服务 (Side-Channel Query & Lightweight Fork - `BI-07.6`)
- **源码参考**：Kimi Code `packages/agent-core-v2/src/features/btw/btwService.ts` 与 ZCode `docs/conversation-product-state-space.md`。
- **核心痛点**：当 Agent 正在执行长达 5~10 分钟的长程重构或批量研报分析时，用户往往希望临时咨询一个不相关的代码细节（如“配置文件里的数据库端口是多少”）。若直接提问会强行中断正在运行的长任务；若等待则严重阻塞开发者工作节奏。
- **工程实现**：实现 `/btw <问题>` 侧向通道；系统利用当前上下文快速 Fork 出一个只读轻量级临时执行分支，硬编码剔除所有写操作工具，仅赋予只读工具（`Read`、`Grep`、`Glob`）；秒级响应用户侧向提问，主 Agent 任务队列与执行流水线 100% 独立推进，互不干扰。

#### (5) 流式缓动输出缓冲与帧率自适应节流器 (Paced Progress & Streaming OutputBuffer - `BI-19.2`)
- **源码参考**：Pi Agent `@earendil-works/chord/output/` (`OutputBuffer.ts`, `Progress.ts`)。
- **核心痛点**：在 DeepSeek-R1 高速输出思考流或 Bash 执行产生密集日志（每秒数千字符）时，高频向 TUI 派发渲染事件会导致 Node/Bun 事件循环饱和、终端字符抖动撕裂与 CPU 飙升至 100%。
- **工程实现**：构建流式定长输出滑动窗口 `OutputBuffer`，支持严格的 UTF-8 字符边界与换行符几何计算；配合 `Progress` 模块的自适应 50ms 节流提交机制，无论上游 Token 喷涌多快，终端恒定维持平滑低开销刷新。

#### (6) 四大协作模式切换器 (Collaboration Modes: Plan / Edit / Build / YOLO - `BI-20.1`)
- **源码参考**：清华 ZCode `docs/conversation-product-state-space.md` 与 OpenCode 核心模式体系。
- **核心痛点**：开发者在不同任务阶段对安全与效率的权衡不同：探索期需要严格只读，编码期需要 Diff 确认，实施期需要完整测试构建，批量自动化时需要极速无感放行。
- **工程实现**：通过 `Shift+Tab` 或 `/mode` 快捷切换四大标准化模式：
  1. `plan`：强制只读沙箱，专注探索与架构设计方案（对应 `BI-14.2`）；
  2. `edit`：标准开发模式，高危写操作与文件修改强制弹出 Unified Diff 供人工确认；
  3. `build`：工程构建模式，全自动触发编译、代码静态检查与测试套件；
  4. `yolo`：极速自动模式，在沙箱与 PGID 看门狗保护下免审批直接执行安全操作，兼顾效率与安全底线。

#### (7) 最终产出物显式交付与工作区变更追踪器 (Deliverables & Workspace Changes Tracker - `BI-21.2`)
- **源码参考**：DeepSeek Harness `packages/deliverables/tool-present/` 与 `workspace-changes/`。
- **核心痛点**：经过多轮复杂长程交互后，终端通常充斥着大量的中间思考流与工具日志，用户很难快速定位“本次任务最终交付了哪些文件、产生了哪些具体改动”。
- **工程实现**：
  1. 向模型暴露 `present(files, summary)` 工具，要求模型在达成目标后显式声明交付物，TUI 终端在轮次末尾渲染高亮交付卡片；
  2. 自动捕获本轮会话前后的 Git 索引快照，计算变更文件列表、增删行数（`+N -M`）并生成对比摘要，让用户对变更一目了然。

---

## 三、 多 Agent 协同机制与 A2A 协议规范

在架构设计上，`bi` 坚决杜绝“把角色、提示词或物理模型写死在 TypeScript 源码中”的低级硬编码反模式。系统严格贯彻**三权分立与两层协同的解耦架构**：
1. **引擎运行时（Engine Runtime - `packages/a2a` & `packages/core`）**：100% 领域中立、角色中立、模型中立，仅提供通用的智能体生命周期容器、消息路由、辩论协议原语与事实黑板；
2. **声明式角色资产（Declarative Persona Assets - `presets/agents/`）**：完全由 YAML / Markdown 声明定义，支持三级覆盖与运行时动态生成；
3. **逻辑模型插槽路由（Model Slot Router - `packages/core/src/model-router.ts`）**：角色仅绑定逻辑语义插槽（如 `reasoner`, `fast`, `auditor`），物理厂商与模型 ID 由用户配置动态解析，支持零代码热切换。

### 0. 协同分层拓扑：本地进程内视窗沙箱 (Sub-agents) vs. 分布式跨网协同 (A2A)

为了彻底解决单体会话“搜索海量文件冲垮主视窗”与“跨网络协作安全风险”两大矛盾，`bi` 吸收清华 ZCode 与 Kimi Code 的工程精髓，确立了严格的两层分流体系：

```
[用户输入任务]
       │
       ▼
【Main Agent（主对话视窗）】 ── 保持干净底账，承载最终决策与交互
       │
       ├─ [Layer 1: 本地任务分流 (In-Process Sub-agents / BI-07.3)] ── 零网络开销、同进程视窗沙箱
       │     ├─ subagent_type: 'explore' (只读探索，搜 100 个文件，仅向主视窗返回 500 字结论)
       │     ├─ subagent_type: 'coder'   (独立代码修改，在 Worktree 沙箱中自验通过后回传 Diff)
       │     └─ subagent_type: 'plan'    (只读高阶规划与依赖因果拓扑分析)
       │
       └─ [Layer 2: 跨网络协作 (Distributed A2A / BI-15)] ── 跨电脑、跨防火墙、带密码学鉴权
             ├─ SMTP/IMAP 私密邮件控制总线 (a2a-email-gateway)
             └─ GitHub PR 分布式任务中枢 (github-a2a-hub)
```

#### Layer 1 核心机制：本地多角色子智能体分流与上下文断路器 (Context Firebreak)
- **同进程轻量上下文**：Sub-agent 绝非 OS 外部子进程，而是在当前 Node/Bun 进程内实例化独立的 `ChildExecutionContext`，派生独立的 Query Loop，零进程切换开销；
- **双层会话历史物理隔离**：子 Agent 在执行深层代码或政策探索时，产生的几十次 `Grep`/`Read`/`Bash` 调用与数十万字符输出，全部写入独立的 `childSessionId` 持久化存储中；
- **主视窗只接收提炼 Summary**：子 Agent 同步完成时仅向主 Agent 提交其最后一条文本块（Summary）与 Token Usage 元数据（异步后台任务则通过 `<task-notification>` 回传）。主对话视窗历史 0 污染，Token 视窗彻底免疫冲垮，单次复杂探索的主视窗 Token 消耗压减 95% 以上；
- **Fork Subagent 字节级缓存复用**：当省略 `subagent_type` 时，子 Agent 克隆父级渲染好的 System Prompt、精确工具集合（Exact Tool Array）与历史消息切片，保持字节级完全一致（Byte-identical），使模型请求 100% 命中服务端的 Prompt Cache，首字延迟（TTFT）压降至毫秒级；
- **双向信令协调总线 (SendMessage + RespondToCoordinator / BI-07.4)**：
  - 父向子动态注入：主协调官调用 `SendMessage({ to, message })`，在子 Agent 运行期直接注入 steer 指令，在下一个工具批次边界平滑生效；
  - 子向父中途汇报：子 Agent 独占专用工具 `RespondToCoordinator({ summary, message })`，在任务推进中途直接向父协调官指令队列发送阶段进展，写入 source 为 `subagent_message`，visibility 为 `model-only`，无需中断或提前终止子任务；
- **Subagent-Driven Development (SDD) 双阶段自验 SOP (BI-18.1)**：
  - 吸收清华 `subagent-driven-development/SKILL.md`：Implementer（按计划实现与测试） → Spec Reviewer（第一阶段规范合规核验） → Code Quality Reviewer（第二阶段代码质量与异常审查），实现全自动闭环交付，零琐碎打扰人类；
- **Live Event Mirror Sink 只镜不落库机制**：
  - 子 Agent 内部的 `tool_call_scheduled`、`progress` 事件通过 `source: "subagent"` 实时镜像到父级 Live Sink，TUI 实时以独立动效卡片渲染；落盘持久化时父级直接丢弃，做到“只镜不落库”，兼顾极致沉浸交互与底层历史树纯净；
- **防递归死锁与 MCP 快照借用**：子 Agent 工具池被物理剥离 `Agent` 与 `AskUserQuestion` 工具，彻底阻断无限递归派生；通过借用父级 MCP 快照端口（`borrowed-mcp-port.ts`），子 Agent 结束退出时绝不触碰或销毁父级 MCP 连接。

### 1. 跨智能体角色拓扑与事实黑板 (预置资产参考流)

下图展示系统内置的政策研判分工流水线（由声明式配置装配，非硬编码逻辑；所有子角色默认基于用户当前配置的单一主力模型按需派生，零额外 Key 依赖）：

```
                    ┌──────────────────────────────────────────────┐
                    │  主协调官预设 (The Architect / Coordinator)   │
                    │         (全局战略推演、任务拆解与结果编排)       │
                    └───────┬──────────────┬──────────────┬────────┘
                            │              │              │
           ┌────────────────┘              │              └────────────────┐
           ▼                               ▼                               ▼
┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
│  政策探针预设         │      │   数据精算预设       │      │   研报撰写预设       │
│  (The Scout Persona) │      │  (The Auditor Persona│      │  (The Reporter Persona│
│ - 爬取部委公告与公报 │      │ - 执行 CSV/表格运算  │      │ - 综合事实梳理脉络   │
│ - 提取关键条文原文   │      │ - 运行 Python 严格勾稽│      │ - 产出规范 Markdown 研报│
└──────────┬───────────┘      └──────────┬───────────┘      └──────────┬───────────┘
           │                             │                             │
           └─────────────────────────────┼─────────────────────────────┘
                                         ▼
                    ┌──────────────────────────────────────────────┐
                    │      事实黑板中枢 (Verified Fact Blackboard) │
                    │     (统一存储已核验事实，杜绝重复与信息孤岛)   │
                    └──────────────────────────────────────────────┘
```

* **运行即验与确定性审计闭环（Code-backed Grounding）**：
  - 严禁模型凭空“脑补/口算”统计数据与良率指标；涉及财税勾稽、良率对比、产能推算，必须调用 Python（`pandas`/`openpyxl`）在独立沙箱中实际执行运算，以代码运行的真实输出作为唯一事实底账；
  - 严格贯彻“证据一致性铁律”（有良率数据即承认存在产线、0/1 与 1-100 维度分离），自动拦截前后矛盾逻辑；
  - 所有子智能体基于用户配置的单一主力大模型按需派生，零额外 Key 依赖、零异构模型开销。
* **研报视觉裁判门禁 (Visual Judge Gate - BI-18.2)**：
  - 研报起草子智能体（Reporter）或绘图工具生成的 ECharts / SVG 图表，必须强制流经 Visual Judge 判定门禁；
  - 基于 Headless 渲染快照与多模态反查，自动核验 0 文字穿模重叠、0 坐标轴标签截断，未达标触发当前轮自愈重绘，确保最终研报交付达到顶级咨询机构水准。
* **探针防爬动态兜底 (CUA Anti-Scraping Fallback)**：
  - 政策探针（Scout）面对部委动态反爬、Cloudflare 盾或复杂 SPA 站点时，支持平滑降级至受控 Headless/CUA 机制（参考清华 `packages/zcode-cua/` 架构），模拟真实视窗交互获取公告全文，杜绝数据盲区。
* **共享事实黑板模式（Blackboard Pattern 原语）**：
  - 子智能体将各自核验无误的关键事实发布至共享黑板，其他智能体即时可见，杜绝重复计算与信息孤岛。

### 2. 声明式角色资产规范 (Declarative Persona Specification)

所有 Agent 角色均采用结构化声明文件定义，绝无一行 TypeScript 代码硬编码角色逻辑。

#### (1) 三级覆盖发现机制 (Priority Discovery)
1. **引擎内置预设**：`presets/agents/*.yaml`（开箱即用的政策、审计与代码分析角色）；
2. **全局用户配置**：`~/.bi/agents/*.yaml`（用户跨项目复用的个性化自定义角色）；
3. **项目工作区配置**：`.bi/agents/*.yaml`（针对当前工程特化的专职角色，优先级最高）；
4. **运行时即时定义（Ephemeral Ad-hoc Subagent）**：主协调官或用户可在交互中通过 A2A 协议动态生成临时子角色。

#### (2) 角色定义 Schema 示例 (`presets/agents/scout.yaml`)
```yaml
schema_version: "bi/v1"
name: scout
title: 政策与信息搜集探针
description: 高频、敏捷的信息捕获探针，专精于公开公报抓取与条文结构化提取
slot: fast                               # 绑定逻辑模型插槽，不锁死物理厂商
temperature: 0.2
max_steps: 20
worktree: branch                         # 隔离模式: branch (开辟独立工作区) | inherit | share
permissions:
  tools:
    allow: ["read", "fetch", "mcp:logbook/*"]
    deny: ["bash", "write"]              # 探针仅有只读权限，杜绝篡改环境
system_prompt: |
  你是一个专精于事实检索与长文本抽取的高频信息搜集探针。
  你的核心职责是从官方公报、部委通知与公开报告中精准抽取事实。
  你必须坚守客观中立立场，严禁主观脑补，逐字提取核心条文与发布时间。
```

### 3. 模型插槽与提供商解耦路由 (Model Slot & Provider Decoupling)

角色与物理模型彻底脱钩。角色仅声明所需的能力特征（Model Slot），具体物理模型由统一的 Model Router 进行解析：

```
角色声明 (slot: "reasoner")
       │
       ▼
Model Slot Router (解析 ~/.bi/config.yaml 或环境变量)
       │
       ├─► 默认解析: deepseek / deepseek-reasoner (R1)
       ├─► 生产可切: siliconflow / deepseek-ai/DeepSeek-R1
       ├─► 备用可切: anthropic / claude-3-7-sonnet (Thinking)
       └─► 私网可切: local / ollama/deepseek-r1-70b
```

* **统一插槽定义**：
  - `reasoner`：长思维链推演与反向挑刺（默认 DeepSeek-R1）；
  - `fast`：高吞吐量公报爬取与信息抽取（默认 GLM-5.3 / DeepSeek-V3）；
  - `auditor`：严谨表格函数计算与统计检验（默认 DeepSeek-V3）；
  - `general`：日常指令协调与交互总结。
* **零侵入 CLI 动态覆写**：
  - 命令行即时热插拔：`bi --slot reasoner=claude-3-7-sonnet --slot fast=qwen-2.5-coder`；
  - 零代码重编，模型升级无缝透明。

### 4. A2A 消息封套契约 (Message Envelope Specification)

```typescript
export interface A2AMessageEnvelope<T = unknown> {
  id: string;               // UUID 唯一消息标识
  traceId: string;          // 全链路分布式追踪 ID
  timestamp: number;        // 发送时间戳 (Unix ms)
  from: string;             // 发送方 (如 "coordinator", "scout-01")
  to: string;               // 接收方 (如 "data-auditor", "coordinator")
  type: A2AMessageType;     // 消息意图分类
  payload: T;               // 业务载荷
  meta?: {
    timeoutMs?: number;     // 预期响应超时
    priority?: "P0" | "P1" | "P2";
    costTokens?: number;    // 子任务消耗统计
  };
}

export type A2AMessageType = 
  | "task_dispatch"         // 主协调官分派独立子任务
  | "task_progress"         // 子智能体实时回传进度脉冲
  | "task_complete"         // 子智能体交付终炼结论与结构化证据
  | "task_failure"          // 子任务异常报告与上下文回滚
  | "debate_challenge"      // 审校员发起逻辑质疑与驳回
  | "debate_accept"         // 审校员签署通过
  | "peer_query"            // 同级智能体之间的能力查询与数据借用
  | "user_escalation";      // 向上升级至用户人工介入确认
```

### 5. 子智能体上下文隔离沙箱 (Subagent Context Isolation)

* **独立事件流**：每个 Subagent 在启动时被分配完全独立的内存会话，享有专属的工具执行栈与临时上下文，**绝不污染主协调官的消息树**；
* **成果折叠收敛（Result Handoff）**：子智能体运行结束时，必须执行“蒸馏收敛”，仅将**最终结论、关键数据表格、引用的条文原话与可信度评分**打包进 `task_complete` 回传；
* **主协调官吸收**：主协调官仅在其消息历史中追加一条结构化摘要，子智能体执行过程中产生的成百上千行 `cat`、`grep`、网络抓取中间结果随子进程销毁而彻底丢弃。

---

## 四、 Git Worktree 隔离与并发工作区引擎

在多 Agent 并行执行数据演练或政策报告生成时，**严禁多 Agent 同时修改用户当前工作目录（`cwd`）**。`bi` 原生内置 Git Worktree 物理隔离：

```
                    用户主工作区 (/home/yupeng/project)
                           │ (共享底层的 .git 库)
         ┌─────────────────┴─────────────────┐
         ▼                                   ▼
[临时 Worktree A]                     [临时 Worktree B]
~/.bi/worktrees/scout-8a2f/         ~/.bi/worktrees/audit-9b1c/
├── 挂载独立分支 bi-agent-A          ├── 挂载独立分支 bi-agent-B
└── 政策探针下载、清洗 HTML/PDF       └── 数据审计员跑 Python 勾稽脚本
         │                                   │
         └─────────────────┬─────────────────┘
                           │ 审查门通过后原子合并 (Cherry-pick / Merge)
                           ▼
                    更新至用户主分支 (Main Branch)
```

1. **自动生命周期管理**：
   - 派生子任务时：`git worktree add -b bi-task-<id> ~/.bi/worktrees/<task-id> HEAD`，毫秒级开辟纯净沙箱；
   - 零磁盘冗余：多个工作区复用同一套底层 Git 对象库，不产生额外体积；
   - 任务合入：经审查通过后，通过 `git cherry-pick` 原子合并至主工作区；
   - 任务销毁：`git worktree remove --force` 即刻擦除临时目录，保证用户日常目录绝对纯净。

---

## 五、 Workflow 动态工作流编排引擎 (DAG Workflow Engine)

针对严肃的政策调研与海量数据核算，将非确定性的“盲目对话”升级为**确定性、可审计、可断点重放的声明式有向无环图（DAG Workflow）**。

```
                       ┌────────────────────────────┐
                       │   Workflow 入口：调研命题   │
                       └─────────────┬──────────────┘
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │  Step 1: 政策公报分发抓取  │
                       │   (GLM 并发爬取 + PDF 提取) │
                       └─────────────┬──────────────┘
                                     │
                   Checkpoint 1 ◀────┴────▶ [Check: 抓取完整度 >= 95%]
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │  Step 2: 宏观数据勾稽计算  │
                       │ (DeepSeek-V3 + 表格计算器) │
                       └─────────────┬──────────────┘
                                     │
                   Checkpoint 2 ◀────┴────▶ [Gate: 0 处逻辑矛盾校验]
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │  Step 3: 政策博弈与因果推演│
                       │   (DeepSeek-R1 长链推演)   │
                       └─────────────┬──────────────┘
                                     │
                   Checkpoint 3 ◀────┴────▶ [人机审批门：确认核心假设]
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │  Step 4: 成果蒸馏与研报输出│
                       │ (Markdown 报告 + Logbook)  │
                       └────────────────────────────┘
```

1. **步骤检查点与幂等重放（Step Checkpointing）**：
   - 每个 Step 执行完毕后自动写入状态快照（Checkpoint）；
   - 若第 3 步因断网或大模型限流中断，重新唤醒时**直接从 Checkpoint 2 恢复执行，绝不浪费时间与 Token 重复跑前面的网页抓取**。
2. **硬指标质量断言门禁（Verification Gates）**：
   - 步骤间设置严格的拦截断言（Assertion Gate）。例如：Step 2 到 Step 3 必须满足“多方数据矛盾数为 0”；若断言失败，工作流自动进入自我反思修正分支，直到通过才放行。
3. **人机协作断点（Human-in-the-Loop Gate）**：
   - 在工作流文件（如 `.bi/workflows/policy-audit.yaml`）中支持定义 `pause_for_human: true`，在关键敏感决策点自动挂起，弹窗由人类专家裁决后继续推演。

---

## 六、 完整 MCP (Model Context Protocol) 兼容架构

`bi` 内置完整的 MCP Client 子系统，既支持本地轻量工具，又无缝接驳远程私有工具中枢。

### 1. 传输层双通道驱动 (Dual-Channel Transports)

```
bi MCP Client Engine
  ├── StdioClientTransport (本地管道)
  │     ├── 基于 child_process.spawn 派生受控子进程
  │     ├── 进程看门狗 (Watchdog) 监控内存与心跳
  │     └── 管道关闭时自动注入 EOF，防止子进程僵尸驻留
  │
  └── SSEClientTransport (远程长连接)
        ├── 基于 EventSource 建立全双工流式下行通道
        ├── HTTP POST 异步发送 JSON-RPC 2.0 上行指令
        └── 专为 QNAP 生产环境 Logbook 服务 (<logbook-host>) 提供免密 SSH 管道穿透
```

### 2. 协议生命周期与动态挂载

1. **协议协商阶段 (Negotiation)**：
   - 发送 `initialize`（遵循 `2024-11-05` 规范），声明客户端能力（Capabilities：Roots, Sampling, Tools）；
   - 接收服务端初始化载荷并确认 `notifications/initialized`。
2. **三元要素动态发现**：
   - **`tools/list`**：拉取外部工具清单（如 Logbook 的 `task_query`, `devlog_record`，以及自研数据工具），自动合并至 Agent 的可用工具注册表中；
   - **`resources/list` & `resources/read`**：允许模型直接以 URI 形式读取本地或远程的上下文文件（如 `logbook://bi/tasks`）；
   - **`prompts/list` & `prompts/get`**：动态拉取预置的宏观政策分析提示词模版。
3. **安全参数前置审计 (Tool Preflight)**：
   - 外部 MCP 工具调用前，必须经过本地 Schema 校验；
   - 对外发出的入参进行路径越界（Path Jail）审查，防止外部工具越权读取宿主文件。

---

## 七、 工业级会话管理体系设计 (Session Management & DAG State Machine)

```
                    ┌──────────────────────────────────────────────┐
                    │        会话交互命令与入口 (CLI / TUI)        │
                    │  bi -c (继续) | bi -r <id> | /rewind | /fork│
                    └──────────────────────┬───────────────────────┘
                                           │
                    ┌──────────────────────▼───────────────────────┐
                    │        会话状态机引擎 (Session Engine)        │
                    ├──────────────────────────────────────────────┤
                    │ • DAG 树状分支 (Branching)  • 时光倒流 (Rewind) │
                    │ • 两级上下文紧缩 (Compaction) • A2A 父子血缘树 │
                    └──────────────┬───────────────────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              ▼                                         ▼
┌──────────────────────────────┐          ┌──────────────────────────────┐
│  不可变事件流 (Append-only)   │          │  元数据快速索引 (SQLite)     │
│  ~/.bi/sessions/<id>.jsonl  │          │  ~/.bi/sessions.db          │
│ • 每步实时追加，抗强杀 0 损坏 │          │ • 毫秒级列表检索 (bi -l)    │
│ • 包含 UUIDv7 + parentId 指针 │          │ • 记录 Token 消耗与时间戳    │
└──────────────────────────────┘          └──────────────────────────────┘
```

1. **主体存储（Append-only JSONL）**：会话保存在 `~/.bi/sessions/<session-id>.jsonl` 中，原子追加，抗机器掉电与强制中断；
2. **元数据索引（SQLite WAL）**：维护 `~/.bi/sessions.db` 索引表，支撑秒开历史列表；
3. **DAG 树状分支与时光倒流**：节点携带 `id` (UUIDv7) 与 `parentId`，支持 `/rewind` 撤回上步与 `/fork` 原地平行分支；
4. **两级长会话无损紧缩**：一级压缩 Tool Output（立省 70% Token），二级生成《阶段调研底账》Anchor 重置上下文；
5. **断点续连与环境自愈**：`bi -c` 秒级接续当前工作区最近活跃会话。

---

## 八、 智谱 BigModel 官方双轨鉴权与 ZCode 客户端特权折扣体系

用户在调用 GLM-5.3、GLM-4 等模型时，`bi` 原生支持**双轨鉴权模式**（浏览器免密 OAuth 与 手工配置 API Key），且**两条链路均能被智谱服务端 100% 识别为合法官方 ZCode 客户端，享受 Coding Plan 专属套餐抵扣、客户端折扣费率与 Ultra VIP 专线加速**。

### 1. 双轨特权识别原理

智谱开放平台与 Z.AI 计费网关并非通过本地二进制校验来识别客户端，而是依赖三大协议层网络指纹：
1. **短期项目访问令牌 (Project Access Token, PAT)**：带有 `token_use: "project_access"` 声明；
2. **专属特权请求标头 (Header Injection)**：带有 `X-Coding-Plan-Api-Key`、`User-Agent: zcode-cli/0.1.8` 与 `x-zcode-trace-id`；
3. **Ultra VIP 专属加速网关路由**：请求自动路由至专线 `/api/v1/ultra/...`。

### 2. 通道一：浏览器免密 OAuth 2.0 PKCE / Poll 授权通道

用户无需手动去开放平台申请、充值并复制繁琐的 API Key。`bi` 原生内置官方同款的 **OAuth 2.0 PKCE / Poll 授权通道**（位于 `packages/core/src/auth/cli-oauth.ts`），与智谱 BigModel Coding Plan 高速通道 100% 体验对齐。

```
用户终端 (bi login)               浏览器端 (智谱开放平台)           官方 OAuth 授权服务
      │                                    │                                 │
      ├────── 1. 生成 32 字节 PollToken ───┼────────────────────────────────►│ POST /oauth/cli/init
      │                                    │                                 │
      │◄───── 2. 返回 authorize_url 与 flow_id ──────────────────────────────┤
      │
      ├────── 3. 自动拉起浏览器打开授权页 ─►│
      │                                    │
      │                                    │ (用户在浏览器扫码/点击确认)
      │                                    │
      ├────── 4. 终端后台安静轮询 (Poll) ──┼────────────────────────────────►│ GET /oauth/cli/poll/{flow_id}
      │          (每隔 1.5s 发送一次)      │                                 │
      │                                    │                                 │ (返回 status: "ready" + Token)
      │◄───── 5. 换取 accessToken、refreshToken 与短期 Project Token ────────┤
      │
      └────── 6. 安全存入 ~/.bi/credentials.json (加密保护，零明文暴露)
```

1. **零配置秒级登录**：
   - 终端输入 `bi login`（或 `bi login bigmodel`），系统自动调用默认浏览器唤醒智谱官方授权页；
   - 用户确认后，终端后台静默捕获授权结果，直接将短期项目令牌（Project Access Token）写入本地凭据库；
   - 后续所有模型调用均可满速直连 GLM-5.3、GLM-4 等模型服务与 Coding Plan 专属通道。
2. **远程与无图形环境保底**：
   - 在纯终端/服务器无 GUI 环境下，系统自动打印高亮授权链接与扫码指引；
   - 同时支持传统的 `BIGMODEL_API_KEY` 环境变量与 `bi login --api-key`，满足全自动化 CI/CD 与离线演练需求。

### 3. 通道二：GLM API Key 二阶段换票与特权标头注入 (API Key 优惠生效机理)

当用户通过环境变量 `BIGMODEL_API_KEY` 或 `bi login --api-key` 输入普通 API Key 时，`bi` 同样不会盲目裸发该 Key，而是完整复用官方 `CodingPlanApiKeyResolver` 流程：

```
用户输入普通 API Key (BIGMODEL_API_KEY)
                    │
                    ▼
[动作 1: 二阶段换票] 调用 ProjectAccessTokenClient 鉴权端点
                    │ 携带 API Key 换取带有 token_use: "project_access" 的短期 PAT 令牌
                    │
                    ▼
[动作 2: 注入专属特权标头 (Headers)]
                    ├── Authorization: Bearer <短期 PAT 令牌>
                    ├── X-Coding-Plan-Api-Key: <原始 API Key>
                    ├── User-Agent: zcode-cli/0.1.8
                    └── x-zcode-trace-id: <分布式追踪 UUID>
                    │
                    ▼
[动作 3: 专线重定向至 Ultra 网关]
   普通地址: https://open.bigmodel.cn/api/anthropic/v1/messages
                    │ (被内部网关路由自动改写)
   专线地址: https://open.bigmodel.cn/api/v1/ultra/anthropic/v1/messages
                    │
                    ▼
[智谱计费与鉴权网关]
   校验通过！认定来自合法的 ZCode 客户端上下文，直接应用 Coding Plan 专属折扣与套餐抵扣！
```

- **二阶段换票**：客户端使用原始 API Key 向智谱凭据解析端点换取当前绑定的 Coding Plan 权益短期 PAT；
- **特权标头**：外发请求时注入 `X-Coding-Plan-Api-Key`、`User-Agent` 与 `x-zcode-trace-id`，如果是闲时活动自动附加 `X-Off-Peak-Ticket-ID`；
- **网关路由**：自动由通用接口重写至 Ultra 专线通道，确保享受 Coding Plan 套餐计费与专属低延迟。

---

## 九、 ZCode 官方桌面版插件体系与 Marketplace 兼容架构

`bi` 坚决摒弃民间 `zcode-app-cli` 的脆弱 AST 补丁与混淆黑盒，**100% 规范兼容官方开源版（`zai-org/ZCode`）桌面端与 CLI 的插件标准**。该标准本质是对 Claude 开放插件协议（`.claude-plugin`）的超集扩展（`.zcode-plugin`），属于纯声明式资产体系。

```text
my-plugin/
├── .zcode-plugin/
│   └── plugin.json          # 插件元数据契约 (双向兼容 .claude-plugin/plugin.json)
├── skills/                  # 专业技能集 (包含 SKILL.md 与领域 SOP 模板)
│   └── xlsx/SKILL.md
├── agents/                  # 特化子智能体定义 (Markdown + YAML Frontmatter)
│   └── visual-judge.md
├── hooks/
│   └── hooks.json           # 生命周期钩子 (SessionStart / PreTool / PostTool)
├── mcpServers/
│   └── .mcp.json            # 插件自备的 MCP 工具拓扑配置
└── templates/ & scripts/    # 执行分析所需的 Python / Node / Bash 脚本
```

1. **五大声明式能力单元**：
   - **Skills 技能库**：通过 `SKILL.md` 动态向模型注入政策分析框架、长篇公报抽取规范与统计学计算指引；
   - **Agents 特化智能体**：插件可自带专职子 Agent（如表格视觉审校员 `visual-judge.md`），独立声明提示词、工具权限与温度；
   - **MCP Servers 挂载**：插件自带的本地/远程 MCP 服务随插件启用自动拉起，即插即用；
   - **Hooks 生命周期拦截**：在会话初始化或工具调用前后介入执行环境探测；
   - **Commands 斜杠指令**：扩展专属终端命令（如 `/xlsx`）。

2. **官方高价值开源插件全量收割**：
   - **`spreadsheets-plugin`**：全套金融、财税、宏观统计 Python 勾稽计算模板库（`palettes.py`、`finance.md`）与表格一致性校验；
   - **`pdf-plugin` & `documents-plugin`**：专精部委公报双栏排版与长篇研报的版式解析、目录构建与关键段落抽取；
   - **`presentations-plugin` & `visualize-plugin`**：研报图表可视化与自动化 PPT 幻灯片生成；
   - **`browser-use-plugin`**：无头浏览器复杂交互与政务动态数据爬取。

3. **三大降维增强（解决原版插件痛点）**：
   - **Git Worktree 隔离运行**：插件 Python 脚本运行全部分流至 `~/.bi/worktrees/<task-id>` 独立沙箱，杜绝生成临时垃圾文件污染用户当前工作区；
   - **代码沙箱运行即验与勾稽校验**：插件生成的报表与提取的数据，必须经由 Python 脚本在沙箱中真实执行运算并交叉核验勾稽关系，根除指标幻觉；
   - **生态双通**：同时识别 `.zcode-plugin` 与 `.claude-plugin`，一键通吃两大开源社区插件生态。

4. **Marketplace 市场分发机制**：
   - 支持解析 `marketplace.json` 目录索引；
   - 支持通过 Git URL 或本地目录安装：`bi plugins install <source>`；
   - 支持 `user`（全局）与 `project`（项目）双重作用域。

---

## 十、 吸收 Claude Code 与 Codex 顶尖工程机制 (Advanced Ergonomics & Safeguards)

深度解构 **Claude Code** 与 **OpenAI Codex CLI** 的生产级实践，`bi` 正式吸纳以下七大顶尖工程机制：

### 1. 项目长期记忆中枢与自适应规范 (BI.md Specification)
- 启动时自动搜索当前工作区根目录的 `BI.md` 或 `.bi/rules.md`；
- 秒级将该项目的**政策源官方地址、特定指标统计口径（如良率对比基准、同比口径）、禁用词汇与特定 Python 环境**静态固化在 System Prompt 前缀中；
- 杜绝每次开启新会话向大模型重复宣贯背景，实现项目级“开箱即懂”。

### 2. 二段式优雅抢占与非破坏性取消 (Dual-Phase Cancellation)
- **单击 `Ctrl+C` 或 `Esc`（任务抢占）**：立即通过 `AbortController` 斩断流式输出或杀停当前卡死子任务，保留已有推演上下文，向事件流推入 `[User Interrupted: Operation aborted by user]`，终端立即恢复输入光标，允许用户即时打字纠偏；
- **1 秒内连续双击 `Ctrl+C`（物理退出）**：触发退出看门狗，安全回写会话 JSONL 与临时 Worktree 分支后，退出终端进程。

### 3. Linux 进程组看门狗与孤儿进程彻底熔断 (PGID Process Group Kill)
- 执行 Bash 工具或运行 Python 数据分析/爬虫时，通过 `{ detached: true }` 派生独立的 Linux **进程组（Process Group）**；
- 发生超时（默认 30s 阈值）或用户中断时，执行 `process.kill(-subprocess.pid, "SIGTERM")`（负号代表杀死整组），连坐斩断所有派生出的子进程与无头浏览器，零僵尸进程残留。

### 4. 工具多路并行并发流水线 (Parallel Tool Pipelining)
- 当大模型在同一轮中返回多个原子工具调用（如同时并发爬取 5 个公报 URL 或读取 3 张财务报表）时；
- 引擎端直接利用 `Promise.allSettled` 并行并发打出；
- 一次性聚合成多条 `tool_result` 回传给模型，将数据采集耗时从 15 秒压缩至 2~3 秒。

### 5. 交互式结构化 Unified Diff 审查门 (Interactive Diff Inspector)
- 修改数据文件或更新重要研报时，在落盘前在内存中生成标准 Git Unified Diff；
- 终端通过彩色 ANSI 语法高亮直观呈现绿色的新增行与红色的删除行；
- 支持三级权限控制（Safe / Confirm / Auto-apply），核心文件必须经由用户键盘确认（`y/n`），并提供一键回滚。

### 6. Token 消耗与 KV Cache 命中率实时仪表盘 (Token HUD)
- TUI 底部状态栏实时显化四大关键指标：
  - **Cache Read 命中率**：智谱与 DeepSeek 服务端前缀缓存命中比例（维持 80%+）；
  - **Tokens Accounting**：当前轮次与累计消耗总计；
  - **Latency / TTFT**：首字延迟（ms）与生成速率（tokens/s）。

### 7. 全链路一键环境体检与自愈系统 (`/doctor`)
- 提供内置 `/doctor` 命令，执行全链路健康检查：
  - **网络连通**：智谱 OAuth 授权服务、DeepSeek API 与 QNAP Logbook 延迟；
  - **凭据有效性**：`~/.bi/credentials.json` 剩余有效期；
  - **数据依赖**：`git`、`python3`、`pandas`、`openpyxl` 运行环境完备性；
  - 输出体检报告并附带单行自动修复建议。

---

## 十一、 核心设计原则 (Design Principles)

1. **状态所有权单一（Single State Owner）**：运行时为唯一单一事实源，TUI 为无状态投影；
2. **原子工具极简化（Minimalist Primitives）**：收敛于 4 大原子工具（`read`, `write`, `edit`, `bash`）+ 轻量 `fetch`；
3. **同进程零拷贝直连（In-Process Direct Calls）**：消除 Localhost 跨进程网络延迟；
4. **确定性验证闭环（Deterministic Closed-Loop）**：先读后写、退出码真实验证、Diff 审查。

---

## 十二、 如何防止幻觉？（防幻觉工程体系）

1. **信息流完整性与有界截断（Bounded IO）**：工具输出超 64KB 时保留首尾结构，绝不断开 JSON 闭合；
2. **真实退出码与错误反馈（Error as Feedback）**：执行出错必须返回真实 Stderr 包装为 `isError: true` 迫使模型自愈；
3. **DeepSeek 思考流生命周期隔离（CoT Stripping）**：多轮历史中**强制剥离上一轮的 `reasoning_content`**；
4. **拒绝 Few-Shot 模板过载（Zero-Shot 纯净纪律）**：保持提示词精炼、静态；
5. **证据一致性审查门（Evidence Consistency Gate）**：严格区分 0/1 存在性与 1-100 质量水平维度。

---

## 十三、 如何提高执行效率与吞吐？（极速调优方案）

1. **KV Cache 前缀锁定**：固定 System Prompt 与 Tool Schemas 前缀，确保服务端 Cache 命中率维持在 80%+，首字延迟压制在 300ms 以内；
2. **单模型流水线与上下文紧缩**：基于用户配置的单一主力模型，通过清晰的 Prompt 步骤切分（搜集 → 运算 → 起草）流水线作业，结合两级上下文紧缩，零跨模型网络开销；
3. **终端差分双缓冲渲染**：仅对变动的终端字符矩阵输出 ANSI Escape 码，CPU 占用低于 1%。

---

## 十四、 细颗粒度工程落地方案（六大核心包设计）

项目采用现代化 TypeScript + Bun Monorepo 架构（收敛至 `packages/`）：

```text
packages/
├── core/                  # 状态机内核、沙箱、会话引擎、模型路由与 OAuth 认证
│   ├── src/
│   │   ├── agent.ts       # 核心循环状态机 (二段式抢占、多工具并发执行)
│   │   ├── model-router.ts# 逻辑模型插槽路由器 (Slot -> Provider/Model)
│   │   ├── rules.ts       # BI.md 项目长期记忆与领域规范自适应加载器
│   │   ├── doctor.ts      # /doctor 全链路网络、凭据与环境健康体检引擎
│   │   ├── auth/          # 智谱 BigModel 官方双轨鉴权与 PAT 换票器
│   │   │   ├── cli-oauth.ts      # 官方 OAuth init 与 poll 状态机
│   │   │   ├── coding-plan-key.ts# API Key 二阶段 PAT 换票器与权益解析
│   │   │   ├── quota-watchdog.ts # Coding Plan 额度监测与余额预警看门狗 (BI-02.2)
│   │   │   ├── off-peak-service.ts# 智谱 BigModel 闲时任务错峰调度引擎 (BI-02.3)
│   │   │   ├── benefit-claim.ts  # 官方赠送 Token 自动探测与一键申领引擎 (BI-02.4)
│   │   │   ├── highspeed-card.ts # 免费高速推理抽卡与 3402 降级看门狗 (BI-02.4)
│   │   │   ├── credentials.ts    # 本地凭据安全存储与自动刷新看门狗
│   │   │   └── browser.ts        # 跨平台浏览器自动唤醒与扫码回显
│   │   ├── gateway/       # 官方 Ultra VIP 专线网关路由与标头注入
│   │   │   ├── ultra-gateway.ts  # 专线网关重定向 (/api/v1/ultra/...)
│   │   │   └── fingerprint.ts    # 官方客户端指纹注入 (X-Coding-Plan-Api-Key 等)
│   │   ├── tools/         # 受控原子工具集
│   │   │   ├── bash.ts    # 带 Linux PGID 进程组治理的受控 Bash 执行器
│   │   │   ├── edit.ts    # 结构化 Diff 生成与原子替换
│   │   │   ├── read.ts    # 边界限制读取 (Bounded IO)
│   │   │   ├── write.ts   # 安全写入
│   │   │   └── fetch.ts   # 轻量双通道抓取
│   │   ├── history.ts     # 消息历史管理与 CoT 思考流自动切除
│   │   ├── session.ts     # JSONL Append-only 树状会话引擎 (DAG Fork & Rewind)
│   │   ├── compaction.ts  # 两级长会话无损紧缩与记忆蒸馏
│   │   ├── indexer.ts     # SQLite 会话元数据快速索引器
│   │   └── sandbox.ts     # Path Jail 路径越界校验器
│
├── worktree/              # Git Worktree 并发工作区隔离引擎
│   ├── src/
│   │   ├── manager.ts     # Worktree 创建、挂载与销毁生命周期
│   │   ├── isolation.ts   # 子智能体工作区路径绑定与重定向
│   │   ├── merger.ts      # 审查通过后的原子 Cherry-pick / Merge 合入
│   │   └── cleaner/       # 临时存储与孤儿子目录修剪器 (BI-12.1)
│   │       ├── storage-catalog.ts # 全局存储目录字典与元数据登记
│   │       └── clean-plan.ts      # 基于 LRU 与保留周期的修剪计划
│
├── workflow/              # 声明式有向无环图工作流编排引擎 (基于 ZCode workflow)
│   ├── src/
│   │   ├── dag.ts         # DAG 拓扑解析与依赖拓扑排序
│   │   ├── runner.ts      # 步骤调度器与并发执行器
│   │   ├── checkpoint.ts  # 步骤级检查点与断点自愈
│   │   └── gates.ts       # 质量断言门禁与人机审批拦截点
│
├── mcp/                   # 工业级 MCP 客户端引擎 (基于 Pi MCP Client)
│   ├── src/
│   │   ├── client.ts      # JSON-RPC 2.0 客户端实现
│   │   ├── stdio.ts       # 本地子进程 Stdio 管道与看门狗
│   │   ├── sse.ts         # 远程 SSE/HTTP 连接器 (直连 QNAP Logbook)
│   │   ├── select-tools.ts# Tool-on-Demand 动态按需加载器 (BI-13.1)
│   │   └── registry.ts    # 动态工具与资源聚合注册表
│
├── a2a/                   # 通用 A2A 跨智能体协议与运行时引擎 (零业务硬编码)
│   ├── src/
│   │   ├── host.ts        # 通用智能体生命周期容器 (AgentHost)
│   │   ├── registry.ts    # 声明式角色资产注册表 (三级覆盖加载器)
│   │   ├── auth.ts        # HMAC-SHA256 签名、防重放与发件人白名单验签
│   │   ├── permissions.ts # 角色最小特权能力矩阵与人类审查门禁
│   │   ├── audit.ts       # 领域中立的事实一致性核验协议 (AuditProtocol)
│   │   ├── blackboard.ts  # 结构化共享事实黑板 (Blackboard)
│   │   ├── router.ts      # 动态 A2A 消息路由器与生命周期总线
│   │   ├── envelope.ts    # A2A 强类型消息封套规范与序列化
│   │   ├── codemode/      # CodeMode 零依赖内存 JS 沙箱 (BI-16.1)
│   │   │   ├── vm-runner.ts       # 基于 node:vm 的隔离执行环境
│   │   │   └── worker-pool.ts     # Worker 线程池与超时看门狗
│   │   └── transports/    # 多模式 A2A 传输驱动层
│   │       ├── eventbus.ts            # L1: 本地进程内极速事件总线 (<0.1ms)
│   │       ├── remote-relay.ts        # L2: 穿透式 WebSocket 中继通道 (BI-15.4)
│   │       ├── a2a-email-gateway.ts   # L3: A2A 邮件私密信令网关 (SMTP/IMAP 跨物理墙控制面)
│   │       └── github-a2a-hub.ts      # L3: GitHub A2A 任务中枢 (任务分支与 PR 交付数据面)
│
├── tui/                   # 终端交互层 (基于 Kimi Code 工业级强化版 pi-tui 双缓冲引擎)
│   ├── src/
│   │   ├── app.ts         # TUI 主生命周期与差分渲染循环 (处理 SIGINT 与按键)
│   │   ├── engine/        # Kimi Code 强化版 Pi-TUI 核心差分引擎 (BI-19)
│   │   │   ├── terminal.ts        # ANSI 双缓冲字符矩阵与增量局部刷新
│   │   │   └── paste-burst.ts     # PasteBurst 非括号化长文本粘贴拦截状态机 (120ms 防冲)
│   │   ├── components/    # 声明式终端渲染组件库
│   │   │   ├── agent-swarm-progress.ts # 多 Agent 泳道进度条与并发看板 (BI-19)
│   │   │   ├── read-group.ts      # 多文件读取折叠聚合卡片 (BI-19)
│   │   │   ├── tool-call.ts       # 受控工具调用与参数状态卡片
│   │   │   └── thinking.ts        # R1 思考流动态收起/展开折叠卡片
│   │   ├── hud.ts         # Token 消耗、TTFT 延迟与 Cache 命中率状态栏
│   │   ├── diff-view.ts   # 交互式 Git Unified Diff 预览与批准门
│   │   ├── cjk-layout.ts  # CJK 东亚宽字符排版计算 (BI-19.1)
│   │   ├── transcript-projection.ts # 四层同构 Transcript 视图投影 (BI-19.1)
│   │   ├── workflow-view.ts# DAG 工作流步骤与检查点可视化看板
│   │   └── session-picker.ts# 历史会话毫秒级交互式切换器
│
└── plugins/               # 官方桌面版插件兼容体系与扩展中枢
    ├── src/
    │   ├── manager.ts     # 插件安装、卸载、启用、禁用与更新
    │   ├── loader.ts      # 解析 plugin.json、挂载 skills/agents/mcp/hooks
    │   ├── marketplace.ts # marketplace.json 解析与 Git 仓库拉取
    │   └── runner.ts      # 插件 Python/Node 隔离运行看门狗 (结合 Worktree)
    └── presets/           # CLI 开箱即用内置的官方精选插件
        ├── spreadsheets/  # 官方 XLSX 专业勾稽计算与模板库
        ├── pdf-extractor/ # 官方长篇政策 PDF 结构化抽取核心
        └── visualize/     # 官方数据可视化插件与 Visual Judge 视觉核验自愈 (BI-18.2)

presets/                   # 开箱即用声明式资产 (数据/配置层，零代码入侵)
├── agents/                # 预置角色模版 (YAML 声明式定义，基于单模型按需派生)
│   ├── coordinator.yaml   # 主协调官预设 (全局编排)
│   ├── scout.yaml         # 敏捷信息探针预设 (条文搜集)
│   ├── auditor.yaml       # 数据精算师预设 (Python 勾稽)
│   └── reporter.yaml      # 政策研报撰写预设 (研报起草)
└── workflows/             # 预置工作流 DAG (声明式编排拓扑与核验逻辑)
    ├── policy-audit.yaml  # 政策调研与证据一致性闭环流水线
    └── data-check.yaml    # 数据勾稽与一致性验证流水线
```

---

## 十五、 bi 项目演进里程碑 (Milestones)

```
[Phase 1] 白盒内核、沙箱、会话持久化与官方双轨认证 (Days 1~3)
  ├── 初始化 packages/core，编写纯白盒 Agent Loop 与 Path Jail 沙箱
  ├── 落地 BI-01.1 三级 TOML 配置系统、多源优先级合并与动态热重载引擎 (configService & smol-toml)
  ├── 实现智谱 BigModel 双轨特权认证 (OAuth 免密 + API Key 二阶段 PAT 换票与 Ultra 专线重定向)
  ├── 注入 X-Coding-Plan-Api-Key、User-Agent 等官方指纹标头，对齐客户端折扣特权
  ├── 落地 BI-02.2 Coding Plan 额度实时监测与余额告警看门狗 (quota-watchdog)
  ├── 落地 BI-02.3 智谱 BigModel 闲时任务错峰调度引擎 (offPeakTaskService 681行状态机)
  ├── 落地 BI-02.4 智谱与 ZCode 官方赠送 Token 申领与免费加速抽卡引擎 (Benefit & Highspeed Draw)
  ├── 落地 Append-only JSONL 树状会话引擎 (支持断点恢复、/rewind 时光倒流与 /fork 平行分叉)
  ├── 接入 GLM、DeepSeek 等统一 SSE 流式驱动与单模型插槽路由 (Model Slot Router)
  ├── 落地 BI-04.2 DeepSeek-V3/R1 官方原生适配器、思考流解析与 v41 视觉 Token 几何网格算法
  ├── 落地 BI.md 项目级长期记忆与领域规范自适应注入
  ├── 落地 BI-05.2 项目技术栈自主探测与 BI.md 规则自省生成器 (sessionInitService)
  ├── 实现基于 Linux PGID 进程组看门狗的受控 Bash 执行器 (杜绝孤儿进程)
  ├── 落地多工具调用并行并发流水线 (Promise.allSettled)
  ├── 落地 BI-07.3 本地 Sub-agent 视窗沙箱与 Fork Subagent 字节级 Prompt Cache 继承
  ├── 落地 BI-07.4 双向信令协调 (SendMessage/RespondToCoordinator) 与只镜不落库 Mirror Sink
  ├── 落地 BI-07.5 重复工具调用卫生守卫与自主目标自动续行引擎 (Repeat Tool Reminder & Goal Driver)
  ├── 落地 BI-07.8 并行子智能体蜂群并发调度器与模板扇出执行引擎 (AgentSwarm)
  └── 接入二段式优雅抢占与取消状态机 (Ctrl+C / Esc 保留上下文即时纠偏)

[Phase 2] Git Worktree 并发隔离、三层上下文与完整 MCP 引擎 (Days 4~5)
  ├── 实现 packages/worktree，落地子智能体工作区物理隔离与自动擦除
  ├── 落地 BI-08.1 超大工具输出中间修剪器 (Tool Result Pruner) 与磁盘 Spill 溢出隔离
  ├── 落地 BI-08.2 多模态历史图像渐进式卸载与文本占位器 (Image Offloading)
  ├── 落地 BI-10.1 历史回溯定位指针与断点自恢复协议 (Context Recovery Pointer)
  ├── 落地 BI-10.2 工具调用原子配对门禁与语法树级消息修整器 (Strict Tool Pairing)
  ├── 落地 BI-10.3 有效视窗输出预留折减与缓存连续性保护 (Cache Continuity & Reserve Cap)
  ├── 落地 BI-12.1 工作区与临时目录自动修剪器 (StorageCatalog & CleanPlan)
  ├── 实现 packages/mcp，支持 Stdio 与 SSE 双通道 (实测接驳 Logbook)
  ├── 落地 BI-13.1 Tool-on-Demand 动态按需加载器 (select_tools)
  └── 验证工作区零污染与外部工具动态注册

[Phase 3] A2A 协议、分工协作与 DAG 工作流编排 (Days 6~8)
  ├── 落地 packages/workflow 声明式 DAG 步骤调度与 Checkpoint 检查点自愈
  ├── 落地 BI-14.2 Plan 模式只读探索规划与用户审批门禁 (planService & exitPlanModeReview)
  ├── 落地 BI-14.3 Todo 动态清单主动注入与进度防漂移守卫 (todoListReminder & todoItem)
  ├── 落地 packages/a2a 通用容器、事实黑板与证据一致性核验协议 (AuditProtocol)
  ├── 落地 BI-15.4 A2A 穿透式 WebSocket 中继控制通道 (remote-control)
  ├── 落地 BI-16.1 CodeMode 零依赖内存 JS 精算沙箱与 Worker 线程池
  ├── 落地 BI-16.2 程序化工具调用执行模式 (PTC Mode / Programmatic Tool Calling)
  └── 跑通“单模型自洽闭环：主协调官 -> 探针搜集 -> 沙箱精算 -> 事实黑板合流”流程

[Phase 4] 官方插件体系吸收与防幻觉强化 (Days 9~10)
  ├── 落地 packages/plugins 官方插件双协议加载器 (.zcode-plugin & .claude-plugin)
  ├── 全量移植官方 spreadsheets-plugin 与 pdf-plugin 核心库
  ├── 吸收 BI-18.1 清华顶尖 Agent SOP (含 SDD 双阶段审查与完工自验看门狗)
  ├── 挂接 Git Worktree 隔离运行沙箱与 Python 逆向勾稽核验
  └── 落实多轮思考流剥离 (CoT Stripping) 与 KV Cache 锁定调优

[Phase 5] Kimi Code 增强版 Pi-TUI 差分终端与正式交付 (Days 11~14)
  ├── 落地 BI-19 Kimi Code 工业级强化版 pi-tui 差分渲染界面 (消除终端跳字闪烁)
  ├── 挂载 PasteBurst 防冲看门狗 (120ms 字符脉冲拦截，杜绝长文本粘贴误提交)
  ├── 实装 AgentSwarmProgress 多 Agent 泳道进度条与 read-group 文件折叠卡片
  ├── 落地 BI-19.1 CJK 东亚宽字符排版与四层同构 Transcript 状态投影层
  ├── 挂载 Token HUD 实时仪表盘 (显化 Cache Read 命中率 %、TTFT 延迟与 Token 消耗)
  ├── 实装 BI-18.2 Visual Judge 视觉核验判定器与图表渲染自愈闭环
  ├── 接入交互式 Git Unified Diff 审查门与一键撤销
  ├── 实现 /doctor 全链路网络连通性、凭据有效性与 Python 依赖一键体检
  ├── 挂载 DAG 工作流看板、A2A 看板与思考流折叠视图
  └── 端到端宏观政策与数据审计实战演练验收，发布 bpfio/bi v1.0
```

---

## 十六、 Kimi Code 三级 TOML 配置体系、蜂群调度与工程自省深度调研

### 1. 三级 TOML 配置拓扑与优先级裁决引擎

为彻底解决生产环境下多项目、多环境、多模型配置混乱问题，吸收 Kimi Code 工业级三级 TOML 拓扑结构：
1. **全局运行配置 (`~/.bi/config.toml` 或环境变量 `BI_CODE_HOME/config.toml`)**：定义全局 LLM 提供商、模型参数重写（Overrides）、默认工具白名单、权限策略与外部生命周期钩子（Hooks）；
2. **终端外观首选项 (`~/.bi/tui.toml`)**：定义主题颜色、CJK 字符宽度补丁、终端蜂鸣、行号渲染与通知看门狗；
3. **工作区私有覆盖 (`.bi/local.toml`)**：定义当前仓库专属的 `additional_dir` 挂载路径、工作区私有模型覆盖，且被 Git 严格忽略，杜绝团队协作时本地配置外泄；
4. **多源优先级裁决阶梯**：
   `CLI 启动参数 (Flags)` > `环境变量 (BI_*)` > `工作区私有配置 (.bi/local.toml)` > `全局用户配置 (~/.bi/config.toml / tui.toml)` > `内置基线默认值 (Built-in Defaults)`。

### 2. 语法树级注释保留原子回写与结构化密钥脱敏

在配置写入与持久化过程中，兼顾人性化体验与绝对安全性：
- **注释保留原子回写 (Preserving Comments via smol-toml)**：当用户通过终端交互菜单或大模型自愈微调配置项时，采用 AST 语法树级差异算法（`planConfigWriteback`），精确更新键值对，100% 保留用户手写的注释、空行与格式排版；
- **结构化敏感词脱敏 (Structural Secret Redaction via redactSecrets)**：吸收 DeepSeek Harness 官方算法，对标记 `role('secret')` 属性的凭据（如 API Key、PAT 令牌、私有通道密钥）进行结构化剥离，在 TUI 交互面板、多进程 IPC、A2A 信令传输与日志落盘前统一遮蔽（例如替换为 `[REDACTED]`），同时支持 `api_key_env` 环境变量间接引用，杜绝明文密钥落盘。

### 3. TUI 交互式配置面板与免重启动态热重载

- **终端交互式面板 (`/config`)**：在 TUI 终端中弹出全屏/模态设置面板，支持方向键快速切换模型、调优推理强度（`off/low/high/max`）、配置工具白名单与编辑外观主题；
- **免重启动态热重载 (`/reload` 与 `/reload-tui`)**：当外部直接修改 TOML 文件后，无需中断长程会话或终止后台子任务，通过命令即时触发配置重载与参数热插拔，0 掉线生效。

### 4. 并行子智能体蜂群并发调度器 (AgentSwarm)

面对海量文件并行审计、多来源政策并行比对场景，单智能体串行执行吞吐量低：
- **Prompt 模板与条目扇出**：模型调用 `AgentSwarm({ tasks: [...], prompt_template: "...", max_concurrency: 5 })`，系统自动以当前条目填入占位符，原子派生 N 个轻量子智能体并行奔跑；
- **并发池与熔断控频**：通过 XState 驱动的限流队列，将瞬时并发限制在物理安全槽位内，防止打爆系统内存或触发 LLM API 速率限制；
- **泳道级看板与聚合**：子任务事件实时投影至 `AgentSwarmProgress` TUI 动态泳道，长任务可随手暂停/恢复，终态结果聚合回传主会话。

### 5. 项目工程自省与规则生成器 (`bi init` / `/init`)

- **自主探测与模式识别**：提供 `bi init` 子命令与 `/init` 交互指令，派生只读探测子智能体全面递归解析工程根目录的构建工具链（`package.json`、`Cargo.toml`、`pyproject.toml`、`go.mod`、`Makefile` 等）；
- **自适应规则起草**：自动提炼代码风格、包管理器指令、单测运行规程与核心架构路径，结合交互预览与人类确认，一键生成高质量初始 `BI.md` 项目长期记忆文件。

---

## 十七、 长程任务上下文管理与视窗生命周期深度架构

在长程自主任务（Long-Horizon Tasks）中，会话可能持续数小时并执行成百上千次工具调用，上下文膨胀与视窗打爆是导致智能体崩溃的最主要根因。吸收 ZCode、Kimi Code、DeepSeek-Harness 与 Pi Agent 四大体系的最优实践，`bi` 构建起四层自愈型上下文防御纵深：

### 1. 历史回溯定位指针与断点自恢复协议 (Context Recovery Pointer / BI-10.1)

在长程任务压缩后，最常见的痛点是“压缩摘要丢失了早期关键命令输出或代码原文字符串”，导致后续步骤模型产生幻觉或胡乱猜测。
吸收 Kimi Code 独创的自恢复指针体系：
- **持久化日志行号区间化索引**：压缩摘要生成后，在尾部自动追加 `## Context Recovery` 块：
  ```markdown
  ## Context Recovery
  wire_path: ~/.bi/sessions/<id>/wire.jsonl
    window 1: lines 1–150
    window 2: lines 151–300   ← the conversation this note summarizes
    window 3 (current): starts at line 301...
  ```
- **精确检索指引协议**：明确指示模型：“在此之前的全部原始事件（命令输出、文件全文、报错堆栈、用户原话）均只读保存在磁盘上的追加型日志中。当需要获取精准细节时，严禁自行推测，请使用 grep 检索关键词获取行号，再通过 Read 精确按行读取（或在 Bash 中使用 sed + jq 提取）”。这彻底构筑了压缩后信息完整性防线，使长程记忆兼具紧凑性与无限精细回溯能力。

### 2. 多模态历史图像渐进式卸载 (Image Offloading / BI-08.2)

多模态图像/截屏在会话中每张消耗 1,000 至 4,000 Visual Tokens。在涉及前端 UI 验证、文档扫描与图表生成的长程任务中，即便单次截图被端侧压缩至 25KB，积累 10 张以上也会严重挤占文本推理视窗。
吸收 DeepSeek Harness 官方 `compaction-image-offload`：
- **确定性最早图像标记**：当视窗承压时，运行纯函数 `offloadOldestImages` 扫描历史输入事件中所有类型为 `image` 的内容块，按时间顺序将最早的图片标记为 `offloaded: true`；
- **请求线缆轻量文本投射**：在向模型 API 发送请求前，将已标记 offloaded 的媒体块无缝替换为结构化占位文本 `[Image omitted to conserve context window]`；
- **会话 DAG 事件树绝对稳定**：由于只在消息内容块层面进行惰性投射，整个底层 Session 事件树的 Sequence ID、消息节点身份与事件因果链条保持 100% 不变，零破坏性回写。

### 3. 工具调用原子配对门禁与语法树级消息修整器 (Strict Tool Pairing / BI-10.2)

所有主流大模型 API（Anthropic Messages、DeepSeek、OpenAI）对工具交互均有铁律：助手消息中的每一个 `tool_use`（或 `tool_call`）块，紧随其后的用户消息中必须包含对应的 `tool_result`，二者 ID 必须严格一一匹配。
如果 Microcompact 脱水、消息滑动窗口切片或 Auto-Compaction 截断时不慎切断了配对，或者遗留了孤立的 tool_result，API 会立即返回致命的 400 Bad Request（`tool_use ids must match tool_result ids`）导致会话暴毙。
吸收 DeepSeek Harness `tool-pairing.ts` 算法：
- **前缀和状态机平衡校验 (`balanceCache`)**：对会话表面事件维护增量配对平衡缓存：遇到 `assistant/message` 累加 tool-call 计数，遇到 `tool/result` 递减；
- **物理切点门禁判定 (`toolPairingBalancedBefore` / `After`)**：严格要求任何压缩切割、历史切片或脱水操作，其截断边界必须满足 `inProgressToolCalls === 0`。若当前切点处于未闭环状态，自动向前或向后滑动至最近的安全平衡点，从数学机制上彻底杜绝 API 400 异常。

### 4. 有效视窗输出预留折减与 Provider 缓存保活 (Cache Continuity & Reserve Cap / BI-10.3)

- **有效视窗硬顶折减 (Output Reserve Capping)**：吸收 ZCode 规范，针对提供商过大的 output 标称值，锁定算法为 `outputReserve = min(maxOutputTokens, 64_000)`，`effectiveContextWindow = contextWindow - outputReserve`，在高水位触及 80%~90% 时触发自动压缩，消除输入侧预算比实际请求更宽松的盲区；
- **压缩请求 tools 列表全量保留 (Prompt Cache Continuity)**：在请求模型生成 Compact Summary 压缩摘要时，**严禁向模型传递 `tools: []`**。因为主流服务商将 tools 签名哈希视作前缀 KV 缓存的一部分，传空 tools 会瞬间击穿 Prompt Cache 导致缓存命中率归零。必须保留原样 tools 列表，并通过系统指令与 Tool-Choice 设置静默拒绝工具调用；
- **思考流剥离与序列化截断**：生成摘要请求时剥离历史 Assistant 消息中的 Thinking/Reasoning 思考块，并将历史单次工具输出统一压减至 2000 字符内，杜绝摘要生成请求自身出现视窗超限；
- **400 视窗溢出紧急自愈与自动重试**：吸收 Pi Agent `context-overflow.test.ts`，一旦 API 返回上下文超限异常，捕获 `isContextOverflow(error)` 并自动以 `reason: "overflow"` 触发紧急压缩，并在压缩重构完成后携带 `willRetry: true` 自动重试当前中断的回合，确保长程任务坚不可摧。



---

## 十八、 全面代码模块复刻深度自省与新增高价值子系统 (Full-Spectrum Modular Synthesis & New Subsystems)

为了彻底满足 `/goal` 指令“对 `zcode` 与 `kimi-code` 进行全量无死角逐模块对照排查、剔除桌面端冗余包并完整吸收全部核心 CLI 与 Agent 能力”的严格要求，架构团队对两大标杆进行了地毯式递归审计，全面甄别出 7 个在会话撤销级联回滚、动态规则按需发现、模式级权限门禁、声明式技能调度、多模态局部检视、多模式互斥协调以及系统剪贴板原生互通维度的关键高价值模块，并将其无缝固化入 `bi` 核心架构体系：

### 1. 会话级联撤销状态机与参与者总线 (AgentConversationUndoService & Participant Bus / BI-03.4)
- **问题根因**：传统 Agent 的 `/undo` 命令往往只是简单在内存数组中截断最近 N 轮消息，而此前轮次中工具创建或覆写的物理磁盘文件依然残留，导致“会话回滚了但代码改脏了”，模型在新回合读取物理文件时产生逻辑撕裂与上下文幽灵状态。
- **机制原理**：吸收 Kimi Code [undoService.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/undo/undoService.ts)（10.5KB）与 [conversationUndoParticipants.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/contextMemory/conversationUndoParticipants.ts)：
  1. 计算 `computeUndoCut` 算法：根据目标回合 ID 严格计算事件切点，剔除已回退的交互事件；
  2. 级联通知参与者总线 (`IAgentConversationUndoParticipantRegistry`)：向系统注册的全部参与者广播 `ContextUndone` 事件；
  3. 联动 `fileHistoryService`（BI-03.3）：物理文件快照服务收到通知后，提取目标切点之后生成的所有二进制变更快照，反向物理恢复磁盘文件至前置状态，实现会话上下文与工作区物理文件的“双向原子级联回滚”。

### 2. 动态嵌套规则探测器与路径自适应注入服务 (Dynamic Nested AGENTS.md Discovery & Path-Adaptive Reminder / BI-05.3)
- **问题根因**：在大型单体仓库（Monorepo）或多包工程中，各子目录往往包含独立的 `AGENTS.md` 或 `BI.md` 规则。若在初始 System Prompt 中全量递归拼接所有子目录规则，将瞬间撑爆上下文前缀并击穿缓存；若完全不加载，模型进入子目录修改代码时将破坏子包开发规范。
- **机制原理**：吸收 Kimi Code [agentsMdReminderService.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/agentsMdReminder/agentsMdReminderService.ts)：
  1. 静态初始阶段仅加载工作区根目录规则；
  2. 运行期间，通过 Tree-sitter Bash AST 解析与文件系统工具调用路径，动态探测模型当前轮次触达的文件绝对路径；
  3. 沿目录树自底向上查找未被阅读过的嵌套 `AGENTS.md` / `BI.md` 文件；
  4. 通过 `beforeStep` 钩子动态将未读规则以紧凑格式注入当前回合消息尾部，既保护了根目录静态 Prompt Cache，又实现了局部规范的“按需动态提醒与自适应生效”。

### 3. 模式级工具权限匹配器与三态授权门禁 (Pattern-Based Permission Rules & Three-State Permission Gate / BI-06.5)
- **问题根因**：粗粒度的工具权限控制要么“全部放行（极度危险）”，要么“每个调用都弹窗确认（严重阻断长流程自动化）”，缺乏基于参数正则/Glob 的细颗粒度白名单规则与会话级授权状态。
- **机制原理**：吸收 Kimi Code [matchesRule.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/permissionRules/matchesRule.ts) 与 [permissionModeService.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/permissionMode/permissionModeService.ts)：
  1. 规则声明采用 `ToolName(ArgPattern)` 格式（如 `Bash(git status*)`、`ReadDir(*)`、`WriteFile(tests/*)`），基于 `picomatch` 进行高性能 Glob 匹配；
  2. 运行时维护三态模式（`manual` 人工干预、`yolo` 全自动放行、`auto` 智能按规则放行）；
  3. 支持三级确认作用域（`scope: 'once'` 单次放行、`scope: 'session'` 本会话持久白名单）；
  4. 拒绝干预携带结构化反馈：当用户拒绝高危动作时，允许输入 `feedback: string`，作为工具执行错误结构体返回给模型，指导模型在下一轮主动纠偏。

### 4. 声明式技能动态调度与沙箱执行工具 (Skill Tool & Execution Runtime / BI-07.9)
- **问题根因**：虽然智能体可以通过读文件方式阅读本地 Skill 说明，但在自动化调用时缺乏显式的工具契约与结构化入参校验，容易出现技能执行参数缺失或无法闭环验证。
- **机制原理**：吸收 Kimi Code [skillTool.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/skill/tools/skillTool.ts)（4.4KB）：
  1. 向模型暴露一等公民工具 `Skill({ skill: "name", input: "args" })`；
  2. 动态扫描工程 `.bi/skills/` 与用户全局 `~/.bi/skills/` 目录，解析 Frontmatter 声明与 Schema；
  3. 调用时执行参数合法性校验，并在隔离沙箱或子进程中按 SOP 标准规范驱动技能执行，返回结构化执行成果。

### 5. 多模态富媒体就地检视器与局部高精裁剪工具 (ReadMediaFile & Region Zoom Tool / BI-08.3)
- **问题根因**：对于大尺寸架构图、密集 UI 截图或复杂报表，整图缩放至 1024 像素后往往造成细节模糊，模型无法看清关键按钮文案或微小折线走势；若直接传入超大分辨率原图，又会打爆 Visual Token 上限。
- **机制原理**：吸收 Kimi Code [readMediaFileTool.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/tools/read-media-file/readMediaFileTool.ts)（20.2KB）：
  1. 向模型暴露 `read_media_file` 专用富媒体检视工具；
  2. 首次检视返回 `<system>` 元数据（物理宽度、高度、格式与通道）；
  3. 支持高精局部放大：模型可传入 `region: [x1, y1, x2, y2]` 相对坐标，底层调用 Sharp/Canvas 自动进行高清晰度裁切缩放，在不超 Token 预算的前提下实现微观细节微米级精准研判。

### 6. 运行期高阶工作模式互斥协调器 (Operating Mode Mutex Coordinator / BI-14.4)
- **问题根因**：在现代智能体系统中，存在多种重型运行模式：PlanMode（只读规划）、SwarmMode（子任务蜂群并发）、TowerMode（物理 Worktree 分支协同协作）、GoalMode（长程无干预攻坚）。若不同模式间状态机缺乏中央仲裁，容易出现“在 Tower 分支协同中误触发全局 Plan 只读阻断”或“在 Goal 攻坚循环中多模式并发重入”导致的死锁或分支挂起。
- **机制原理**：吸收 Kimi Code [modeMutexService.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/modeMutex/modeMutexService.ts)（14KB）：
  1. 设立中央模式互斥总线，对全部高阶运行模式实施确定性状态转移约束矩阵；
  2. 基于 EventBus 监听模式进入与退出信号：进入 Tower 模式时自动暂挂 Goal 循环并退出 PlanMode；进入 PlanMode 时强制阻断并发 Worker 的写权限；
  3. 彻底消除多模式并发时的竞态条件、事件污染与悬挂孤儿进程。

### 7. 系统剪贴板图文原生互通与快照提取器 (OS Clipboard Image/Text Integration & /copy Bridge / BI-19.4)
- **问题根因**：终端 CLI 用户在遇到报错截屏或界面设计稿时，通常需要手动保存图片至本地路径再输入文件名，流程繁琐打断心流；同时，终端生成的长篇研报需要便捷一键提取回系统剪贴板。
- **机制原理**：吸收 ZCode [clipboard-image.ts](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/cli/src/clipboard-image.ts)（7.5KB）与 Kimi Code `copy.ts`：
  1. 终端 TUI 原生支持 `Ctrl+V` 图片就地粘贴：通过底层轻量子进程探测跨平台剪贴板（Linux 原生优先 `wl-paste`，回退 `xclip`；macOS 原生优先 `pngpaste`，回退 AppleScript；Windows 调用 PowerShell）；
  2. 探测到剪贴板包含图片数据时，自动提取二进制流并以 SHA-256 哈希安全持久化至 `~/.bi/attachments/<hash>.png`，在输入框渲染附件徽标卡片；
  3. 提供 `/copy` 快捷指令，自动提取上一轮 Assistant 最终回复文本，清除 ANSI 控制符后格式化写入系统剪贴板，打通“终端交互 ↔ 桌面生态”的极速无缝流转。


---

## 十九、 Pi Agent 与 DeepSeek Harness 核心架构深度对齐与 9 大高价值子系统吸收

在对清华系 ZCode 与 Kimi Code 实施全面逐模块对照后，为确保 `bi cli` 在底层稳定性、极端并发、多轮交互心流以及大工程代码导航领域达到顶级水准，项目组进一步对海外与国内标杆智能体实现：**Pi Agent**（[references/pi](file:///home/yupeng/references/pi)）与 **DeepSeek Harness**（[references/deepseek-harness](file:///home/yupeng/references/deepseek-harness)）开展了全模块拉网式代码审查。

通过审查 Pi Agent 的全部 11 个核心包（`agent`, `ai`, `chord`, `codemode`, `coding-agent`, `durable`, `env`, `evals`, `mcp`, `telemetry`, `tui`）以及 DeepSeek Harness 的全部 54 个微服务包（涵盖 `lsp`, `jobs`, `context`, `shell`, `interaction`, `guard`, `compaction`, `credentials`, `workflow`, `deliverables` 等），共挖掘并吸收 9 项顶级工程架构与核心算法设计：

### 1. 主动式 Prompt KV 缓存保活看门狗与成本监控器 (Proactive Prompt Cache Warmer & Miss Tracker / BI-04.3)
- **问题根因**：主流大模型服务商（Anthropic Claude、DeepSeek 等）的 KV Cache 拥有严格的存活生命周期（通常为 5 分钟滑动窗口）。当终端人类用户处于阅读、思考或离开座位的空闲间隙时，数万至数十万 Token 的长上下文 KV Cache 会在服务端静默失效；下一次交互时将触发冷启动重算，不仅导致响应延迟骤增数倍，更造成高昂的 Token 费用浪费。
- **机制原理**：吸收 Pi Agent [cache-warmer.ts](file:///home/yupeng/references/pi/packages/coding-agent/src/core/cache-warmer.ts)（16.8KB）与 [cache-stats.ts](file:///home/yupeng/references/pi/packages/coding-agent/src/core/cache-stats.ts)：
  1. 建立空闲计时看门狗：在用户等待输入期间，精确追踪上一轮交互时间戳与模型服务端 KV Cache 的 TTL（如 5 分钟）；
  2. 经济性自适应决策门：当会话上下文超过保活阈值（如预估下一次 Cache Miss 重算成本大于 0.05 美元），且距离 Cache 过期达到 90% 窗口期（如 4.5 分钟）时，看门狗自动触发极轻量级保活心跳；
  3. 极小代价心跳保活：向服务端发起仅包含 1 个 Token 输出限制的轻量探测请求，服务端仅需微秒级命中已存 KV 缓存即刷新 5 分钟 TTL，以 0.0001 美元的极微小开销锁定数美元的缓存收益；
  4. Cache Miss 诊断统计器：实时跟踪每一轮调用的缓存命中率（Cache Read / Cache Write），在 Token 监控仪表盘上呈现累计节省成本。

### 2. 时钟上下文与时区自适应感知器 (Turn & Step Time Context & Timezone-Adaptive Sensor / BI-05.4)
- **问题根因**：纯文本大语言模型缺乏物理时间流逝感知能力。如果仅在系统提示词开头静态声明一次时间，模型在长达数小时或数天的连续长程任务中，会出现严重的时间认知漂移（如误判“昨天”、“上周”、“刚才”的相对时序，或无法准确感知工具运行实际消耗的时长）。
- **机制原理**：吸收 DeepSeek Harness [time-context](file:///home/yupeng/references/deepseek-harness/packages/context/time-context/)（7.5KB）：
  1. 建立时区自适应感知器：启动时自动探测宿主机 IANA 时区（如 `Asia/Shanghai`）与本地 UTC 偏移量；
  2. Step 级动态时钟注入：在模型思考循环的每一个 Step 开始前，通过前置拦截器向当前回合上下文中动态注入精确的 ISO 8601 时间戳；
  3. 步进耗时差分感知：记录上一轮工具执行与模型生成的绝对耗时（如 `step_duration_ms: 3420`），赋予模型对现实物理时间开销的精确感知与自省能力，彻底根除相对时间幻觉。

### 3. 规范化文件写入互斥队列 (Canonical File Mutation Queue / BI-06.6)
- **问题根因**：在多 Agent 并发或者复杂长程自动化流水线中，多个子智能体或同一回合内的并行工具可能由于软链接、相对路径解析差异（如 `./src/index.ts` 与 `src/../src/index.ts`）同时触发针对同一物理文件的写操作，引发文件内容截断、内容覆盖与竞态脏写。
- **机制原理**：吸收 Pi Agent [file-mutation-queue.ts](file:///home/yupeng/references/pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts) 与 `durable/src/tools/`：
  1. 路径物理规范化：通过 `node:fs/promises` 的 `realpath` 解析绝对规范路径，消除符号链接与路径格式混淆；
  2. 按文件串行化链条：维护全局 WeakMap 粒度的 Promise 队列（`withFileMutationQueue`）。针对同一物理文件的并发写入请求自动挂载至该文件的尾部串行排队执行；
  3. 跨文件并行非阻塞：对不同物理文件的读写操作保持完全异步并发执行，既保障了文件写操作的原子完整性，又最大化并发吞吐率。

### 4. 持久化 PTY 交互式 Shell 会话 (Persistent PTY Bash Shell Session / BI-06.7)
- **问题根因**：常规 Agent 的 Bash 工具通常采用单次无状态的 `child_process.exec`。每次调用都是崭新的子进程，导致 `cd` 切换目录、`export` 设置环境变量、`source .venv/bin/activate` 激活 Python 虚拟环境以及自定义 Shell 函数在调用结束后立刻丢失，无法支撑真实的复杂交互式调试。
- **机制原理**：吸收 DeepSeek Harness [tool-bash-persistent](file:///home/yupeng/references/deepseek-harness/packages/shell/tool-bash-persistent/)（9.9KB）与 `terminal/` 架构：
  1. 常驻伪终端（PTY）生命周期：为当前会话维护常驻后台 PTY 进程（node-pty），状态、工作目录与虚拟环境在轮次间全局延续；
  2. 标记锚定提取机制：命令发送时自动包裹独创的开始/结束边界标记与退出状态码指令，PTY 输出由滚动缓冲区（Scrollback）精确捕获并切分，彻底消除 Shell Prompt 提示符、输入回显与颜色控制码对输出内容的污染；
  3. 超时安全熔断与重置：遇到死循环、前台挂起或异常中断时，支持发送 SIGINT/SIGTERM 中断信号，或自动重置为干净环境并通知模型。

### 5. 交互式用户提问门与计时挂起恢复器 (Interactive User Questions Modal & Timed Resumption / BI-07.10)
- **问题根因**：在长程任务攻坚期间，模型经常遇到方案分歧或缺少关键凭据，必须向人类用户澄清；但若采用简单的阻塞式同步提问，如果用户暂时离开终端，会导致整个自动化流水线无限期死锁挂起。
- **机制原理**：吸收 DeepSeek Harness [tool-ask-user](file:///home/yupeng/references/deepseek-harness/packages/interaction/tool-ask-user/) 与 `user-questions`：
  1. 结构化多选题与文本提问契约：向模型暴露 `ask_user_question` 工具，支持预设单选/多选选项与补充说明；
  2. 计时自愈模式（`mode: 'timed'`）：允许模型指定等待超时间隔。若用户在设定时间内未应答，工具安全返回 `{ pending: true, callId }`，允许智能体暂挂该支线、继续推进其他不依赖该决策的独立子任务；
  3. 异步回执投递通道：当人类用户随后返回并在终端给出答复时，系统以异步消息信箱方式将用户决断送达智能体下一轮思考上下文，实现真正的异步人机协同。

### 6. 异步后台任务运行时与生命周期管理器 (Background Jobs Runtime & Asynchronous Lifecycle Manager / BI-07.11)
- **问题根因**：在开发和数据处理场景中，存在大量长耗时操作（如启动本地开发服务、构建 Docker 镜像、执行大型测试套件、抓取海量数据）。若强制前台同步等待，不仅浪费模型思考时间，更极易触发工具调用超时。
- **机制原理**：吸收 DeepSeek Harness [tool-jobs](file:///home/yupeng/references/deepseek-harness/packages/jobs/tool-jobs/)（13.5KB）与 `jobs-local`：
  1. 暴露标准后台作业工具集：`job_output`（查看日志增量）、`job_list`（列出存活作业）、`job_kill`（终止进程）；
  2. 环形输出缓冲队列：后台进程输出接入 RingBuffer，支持分页与游标拉取，防爆内存；
  3. 智能事件投递机制：作业状态变更与退出码自动排入事件队列。智能体繁忙时静默注入下一 Step，智能体处于空闲等待时通过自驱唤醒触发后续处理，并受到 `maxConsecutiveWakes` 频控保护，杜绝死循环唤醒。

### 7. Language Server Protocol (LSP) 符号级代码导航引擎 (LSP Symbol Navigation Engine & Stdio Client / BI-13.2)
- **问题根因**：纯文本级关键词匹配（如 `grep`、`ripgrep`）在大型单体仓库中存在严重的同名符号混淆（如多个类都有 `init()`、`handle()`、`render()`），模型容易读错文件、找错调用链路并产生严重的逻辑幻觉。
- **机制原理**：吸收 DeepSeek Harness [tool-lsp](file:///home/yupeng/references/deepseek-harness/packages/lsp/tool-lsp/)（8.8KB）与 [lsp-stdio](file:///home/yupeng/references/deepseek-harness/packages/lsp/lsp-stdio/)（17.2KB）：
  1. 工业级 LSP Stdio 客户端：以 JSON-RPC 2.0 协议标准连接各类主流语言服务器（如 TypeScript `tsserver`、Python `pyright`、Golang `gopls`、Rust `rust-analyzer`）；
  2. 高阶符号导航工具：向模型暴露 `goToDefinition`（定义跳转）、`findReferences`（全局查找引用）、`goToImplementation`（接口实现查找）、`hover`（查看类型与文档说明）；
  3. 结果边界与字符熔断：内置 `maxLocations: 100` 与 `maxResultChars: 16000` 保护门禁，以编译级精确度彻底消灭代码搜索歧义。

### 8. 外部编辑器唤醒与长提示词交互微调桥 (External Editor Bridge for Complex Prompts / BI-19.5)
- **问题根因**：在终端 TUI 交互中，当用户需要输入长达数百行的大型重构需求、复杂规格说明书或详细业务逻辑时，终端多行输入往往受限于终端光标移动、回车换行与排版撕裂，编辑体验极差。
- **机制原理**：吸收 Pi Agent [external-editor.ts](file:///home/yupeng/references/pi/packages/coding-agent/src/modes/interactive/external-editor.ts) 与 `text.ts`：
  1. 外部编辑器指令流：支持快捷键或 `/edit` 指令，将当前输入框内容写入临时工作文件 `prompt.md`；
  2. 终端事件循环安全挂起：释放 TUI 的原始终端模式（Raw Mode），拉起操作系统环境变量中指定的首选外部编辑器（优先读取 EDITOR / VISUAL，如 vim、nvim、code、nano）；
  3. 文本清洗与热重载：用户在外部图形或终端编辑器中保存并退出后，自动读取文件内容、自动剔除 UTF-8 BOM 头，并热重载回 TUI 输入缓冲区，彻底解放人类在长文本需求下的编辑心流。

### 9. 独立 HTML 会话报告生成器与工具渲染引擎 (Standalone Session HTML Exporter with Tool Renderers / BI-20.3)
- **问题根因**：研发与审计场景需要将会话全流程记录、代码 Diff、图表与执行结果完整归档并对外分享。纯文本或 Markdown 格式无法保留终端 ANSI 高亮色彩，且难以交互式折叠超长工具输出。
- **机制原理**：吸收 Pi Agent [export-html](file:///home/yupeng/references/pi/packages/coding-agent/src/core/export-html/)（11KB）与 `ansi-to-html.ts`：
  1. 零依赖单文件 HTML 导出：通过 `bi export --format html` 输出包含全部 CSS 样式的独立 HTML 文件，无需依赖任何外部 CDN 或静态资源服务器；
  2. 精确 ANSI 转 CSS：将终端各级色彩、粗体与下划线精准转译为内联 CSS 样式，并原生支持 Dark/Light 主题切换；
  3. 专有工具渲染器接口（`ToolHtmlRenderer`）：针对 Diff 文件比对、Python 统计图表、执行日志与 Markdown 表格提供专有折叠卡片渲染器，实现专业级研报与会话归档交付。

---

## 二十、 OpenCode CLI 核心架构全模块审计与 8 大高价值子系统吸收 (OpenCode Architecture Audit & Subsystem Synthesis)

### 1. 全模块审计概览与架构矩阵

通过对 OpenCode CLI（`references/opencode`）下属全部 35 个 Monorepo 包（涵盖 `ai`、`app`、`cli`、`client`、`codemode`、`console`、`containers`、`core`、`desktop`、`merman`、`protocol`、`schema`、`tui`、`util` 等数千个源码文件）的逐模块深度代码走查与架构穿透，我们系统性识别出 8 项在并发执行、提示词缓存、Shell 语法安全、流式文档抽取、工具历史规整、MCP 目录压缩、终端富图形渲染与会话隐私迁移方面具备极高工程价值的核心子系统，并将其 100% 吸收固化至 `bi cli` 的 WBS 与 SSOT 映射矩阵中：

| 任务编号 | 吸收子系统模块名称 | OpenCode 原始源码位置与体量 | bi 目标落地工程包 | 核心架构价值与解决的痛点 |
|---|---|---|---|---|
| **BI-03.5** | 双边界会话待办收件箱与门铃式并发协调器 (Dual-Boundary Session Inbox & Doorbell Run Coordinator) | `core/src/session/inbox.ts` (18.7KB)<br>`core/src/session/run-coordinator.ts` (9KB) | `packages/core/src/session/` | 区分 steer（步内提权）与 input（空闲排队）双边界消费；门铃看门狗彻底消除排空与空闲过渡竞态 |
| **BI-04.4** | 提示词前缀缓存 4 级断点自适应编排器与推理开销自适应追踪器 (Provider-Adaptive 4-Breakpoint Cache Allocator & Effort Tracker) | `ai/src/cache-policy.ts` (8.7KB)<br>`ai/src/effort-updates.ts` | `packages/core/src/adapters/` | 4 级断点硬预算算法（tools/system/tail）；跨模型网关自适应；动态降级思考标记避免破坏 KV 前缀缓存 |
| **BI-06.8** | 纯 TypeScript 确定性 Shell 语法词法扫描器与动态执行安全阻断器 (Deterministic Shell Lexer Scanner & Dynamic Execution Guard) | `core/src/shell/scan.ts` (97.8KB, 2410行) | `packages/core/src/sandbox/` | 纯手写零依赖 Bash/Zsh 词法扫描器；精准解析复合命令、重定向与变量赋值；动态拦截 eval 阻断未知风险 |
| **BI-07.12** | 高性能流式 HTML 转 Markdown 抽取引擎 (Streaming HTML-to-Markdown Extraction Engine) | `core/src/tool/html-markdown.ts` (21.7KB, 659行) | `packages/core/src/tools/` | htmlparser2 SAX 状态机实现表格重构、列表嵌套与 5MB 内存截断；0 依赖浏览器实现 0.5ms 极速抽取 |
| **BI-10.4** | 工具历史语法树安全补齐与空值规整看门狗 (Tool History Normalizer & Interruption Synthesizer) | `ai/src/tool-history.ts` (3.5KB) | `packages/core/src/context/` | 工具历史状态机清洗算法；系统消息悬挂队列防交错 400；中断调用自动合成缺失结果；空输出规整为 (no tool output) |
| **BI-13.3** | 分级命名空间工具名录压缩器与预算自适应摘要器 (Hierarchical Tool Catalog Compressor & Inline Budget Summarizer) | `core/src/codemode/catalog.ts` (6.5KB) | `packages/core/src/mcp/` | 工具名录分级命名空间与 2000 Token 硬预算自适应算法；生成单行 TS 签名摘要并实施轮询渐进展现 |
| **BI-19.6** | 终端 Mermaid 架构与时序图 ASCII/Unicode 原生渲染引擎 (Native Terminal Mermaid ASCII/Unicode Diagram Renderer) | `packages/merman/` (89个源码文件)<br>`merman/src/markdown.ts` (12.4KB) | `packages/tui/` | 纯 TS 终端字符画布渲染流程图、甘特图、时序图与分支演化图；支持 120 列折叠与主题调色板 |
| **BI-20.4** | 会话全拓扑脱敏导出导入与匿名调试归档器 (Anonymized Session Export/Import & Sanitized Debug Archiver) | `core/src/session/transfer.ts` (13.5KB) | `packages/core/src/session/` | 会话拓扑脱敏导出与导入中枢；结构化遮蔽敏感文件路径与代码 Patch；保留 Token 与时序骨架供无泄露调试 |

---

### 2. 八大吸收子系统深度原理解析

#### 1. 双边界会话待办收件箱与门铃式并发协调器 (BI-03.5)
- **问题根因**：传统 Agent 会话队列对所有异步消息一视同仁，导致两种严重故障：一是用户紧急纠偏指令（如发现跑偏要求换思路）必须苦等当前回合几十个工具完全跑完才被处理；二是协调器在检测队列为空与系统真正切入空闲状态之间存在时间窗口竞态，新到达的消息可能陷入无协程唤醒的死锁。
- **机制原理**：吸收 OpenCode [inbox.ts](file:///home/yupeng/references/opencode/packages/core/src/session/inbox.ts)（18.7KB）与 [run-coordinator.ts](file:///home/yupeng/references/opencode/packages/core/src/session/run-coordinator.ts）（9KB）：
  1. 双队列拓扑结构：将进入会话的消息严格划分为 `steer`（步内提权队列）与 `input`（回合空闲队列）；
  2. 步间动态提权：在每一步（Turn Step）模型流式输出完毕并准备派发工具前，优先轮询 `steer` 队列，若存在纠偏指令则立即合成纠偏上下文注入模型当前视窗，无需中断会话即可改变下一步行为；
  3. 门铃协调看门狗（`pendingWake`）：协调器引入原子门铃标记。当工作线程执行收尾逻辑时，若有新消息触发 `doorbell.ring()`，系统强制再次触发资格检查循环，彻底杜绝待办消息在空闲边界的悬挂丢失。

#### 2. 提示词前缀缓存 4 级断点自适应编排器与推理开销自适应追踪器 (BI-04.4)
- **问题根因**：Anthropic、DeepSeek、Qwen 等主流模型厂商对 KV 缓存前缀的要求各异。Anthropic 严格限制最多 4 个 `cache_control: { type: "ephemeral" }` 断点，超出将报错；Gemini 仅支持单点；而如果在中间回合传递了会变化的思考开销标记（`effort updates`），将导致整条前缀缓存全部失效，大幅增加 Token 成本与首字延迟。
- **机制原理**：吸收 OpenCode [cache-policy.ts](file:///home/yupeng/references/opencode/packages/ai/src/cache-policy.ts)（8.7KB）与 [effort-updates.ts](file:///home/yupeng/references/opencode/packages/ai/src/effort-updates.ts）：
  1. 4 级断点自适应算法：按照重要性严格排布：① 最后一个工具定义；② System Prompt 起始；③ System Prompt 末尾；④ 历史对话尾部第 2 轮 Assistant 响应；跨厂商网关根据供应商特性自动合并或降级；
  2. 推理开销平滑追踪（`effort-updates`）：通过将每轮动态的思维链开销调整为向后追加的元数据更新，而非直接修改历史 System 消息，确保前缀内容字符级绝对不变，稳保 85% 以上缓存命中率。

#### 3. 纯 TypeScript 确定性 Shell 语法词法扫描器与动态执行安全阻断器 (BI-06.8)
- **问题根因**：简单的正则过滤无法防御 Bash/Zsh 中复杂的复合命令、多层括号子 Shell、Heredoc 输入重定向以及动态字符串拼接执行（如通过变量拼接或 `eval` 执行破坏性指令），容易引发沙箱逃逸与误杀合规脚本。
- **机制原理**：吸收 OpenCode [scan.ts](file:///home/yupeng/references/opencode/packages/core/src/shell/scan.ts)（97.8KB，2410行纯 TS 代码）：
  1. 纯手写零依赖词法扫描器：不依赖任何本地 C 语言绑定的 Tree-sitter，直接以高效状态机逐字符扫描复合命令、管道、重定向、单双引号转义、变量替换与命令替换；
  2. 动态执行危险阻断：扫描器将所有无法在静态分析期确定命令名与参数边界的动态调用流判定为 `{ kind: "opaque", reason: "dynamic-execution" }`；
  3. 分级权限放行门禁：静态确定的安全只读命令（如 `cat`、`git status`）快速放行，一旦出现 `eval`、未转义的反引号执行或非标准环境变量展开，立即阻断并弹窗提级至人类用户显式审批。

#### 4. 高性能流式 HTML 转 Markdown 抽取引擎 (BI-07.12)
- **问题根因**：政策调研与商业数据抽取常需要抓取部委公报、交易所公告与网页长文。若调用 Headless 无头浏览器（如 Puppeteer/Playwright），内存占用高达数百兆且启动耗时需数秒；若用简单正则或粗糙字符串截取，复杂的双栏表格、嵌套列表与代码块将严重错乱。
- **机制原理**：吸收 OpenCode [html-markdown.ts](file:///home/yupeng/references/opencode/packages/core/src/tool/html-markdown.ts)（21.7KB，659行）：
  1. 基于 htmlparser2 SAX 状态机：采用纯 TypeScript 高性能流式解析器，逐标签触发事件，内存开销常驻在 5MB 以内，在毫秒级（约 0.5ms）完成几十万字符长篇文档的解析；
  2. 智能结构规整：精准识别 HTML 表格结构，自动计算列宽并重构为标准 Markdown 表格；准确处理嵌套无序/有序列表与 `<details>/<summary>` 折叠块；
  3. 内存与长度有界截断：内置流式深度限制与 5MB 文本保护熔断，防止遇到超长网页引发 Node/Bun 内存溢出（OOM）。

#### 5. 工具历史语法树安全补齐与空值规整看门狗 (BI-10.4)
- **问题根因**：大模型 API（如 Anthropic Messages API、OpenAI Chat API）对历史对话中的工具调用有极其严苛的校验规则：① 工具调用（`tool_use`）必须紧随对应的工具结果（`tool_result`）；② 如果用户在中途强制中断会话，导致未闭合的 `tool_use` 残留在历史中，下一次请求将直接抛出 HTTP 400 坏请求；③ 工具返回空字符串 `""` 时，部分厂商也会判定为畸形参数。
- **机制原理**：吸收 OpenCode [tool-history.ts](file:///home/yupeng/references/opencode/packages/ai/src/tool-history.ts)（3.5KB）：
  1. 系统消息悬挂等待队列：在当前轮次所有并行的工具结果全部返回之前，将中途产生的系统提示或外部事件暂存在挂起队列中，避免消息时序交错打乱 `tool_use`/`tool_result` 的相邻配对关系；
  2. 中断自愈合成器：在会话启动新轮次时，扫描历史树尾部，一旦发现被人类 Ctrl+C 中断导致的未响应工具调用，自动原地合成带有 `(Tool execution was interrupted by user)` 标记的虚拟结果，维持协议合法性；
  3. 空值规整看门狗：任何工具产生的纯空白或空字符串输出，在压入上下文之前统一归整为 `(no tool output)`，彻底根除 API 400 校验异常。

#### 6. 分级命名空间工具名录压缩器与预算自适应摘要器 (BI-13.3)
- **问题根因**：随着接入的 MCP 工具、插件技能与内置工具规模不断膨胀（常达数十至上百个），若将每个工具完整的 JSON Schema 全部填入 System Prompt，将一次性消耗数万 Token，不仅极度挤占有限的有效视窗，还会造成严重的工具挑选幻觉与调用迟钝。
- **机制原理**：吸收 OpenCode [catalog.ts](file:///home/yupeng/references/opencode/packages/core/src/codemode/catalog.ts)（6.5KB）：
  1. 分级命名空间管理：将庞大的工具集合按领域划分为顶层命名空间（如 `github.*`、`database.*`、`financial.*`、`system.*`）；
  2. 单行 TypeScript 契约压缩：将冗长繁复的 JSON Schema 紧凑平铺为单行 TS 函数签名（`- toolName(param: type): returnType // 核心简述`），将单个工具的描述开销从上千 Token 压缩至仅约 15 Token；
  3. 2000 Token 硬预算自适应调度：设定 2000 Token 的绝对预算天花板，在预算内根据当前上下文相关度轮询展现候选工具摘要，引导大模型按需调用 `select_tools` 激活全量明细，使工具名录的上下文占比始终稳定在 2% 以内。

#### 7. 终端 Mermaid 架构与时序图 ASCII/Unicode 原生渲染引擎 (BI-19.6)
- **问题根因**：在政策比对、研报撰写与系统重构过程中，大模型经常生成 Mermaid 流程图、甘特图与分支演化图。然而传统的 CLI 终端只能显示一堆未渲染的裸 Mermaid 代码块，人类用户必须复制到外部浏览器或 Markdown 阅读器才能看懂拓扑关系，打断了终端纯键盘的专注沉浸体验。
- **机制原理**：吸收 OpenCode 独立 Mermaid 终端渲染引擎 [packages/merman](file:///home/yupeng/references/opencode/packages/merman)（89个源码文件）与 [markdown.ts](file:///home/yupeng/references/opencode/packages/merman/src/markdown.ts)（12.4KB）：
  1. 原生全图表支持：内置纯 TypeScript 语法解析器，支持 Flowchart（流程图）、Gantt（甘特图）、GitGraph（Git 分支演进图）、Sequence（时序图）、State（状态机图）与 Timeline（时间线）；
  2. 终端二维字符画布（Text Canvas）：构建终端字符视口拓扑矩阵，使用精密的 Unicode 方框线（`┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼`）与箭头符号（`← ↑ → ↓`）在字符网格中排版与走线；
  3. 视口自适应折叠与调色板：自动探测当前终端视口宽度（支持 80/120 列自动换行折叠），配合 ANSI 256/TrueColor 调色板映射不同节点状态，让研报架构逻辑与执行时序在终端就地直观呈现。

#### 8. 会话全拓扑脱敏导出导入与匿名调试归档器 (BI-20.4)
- **问题根因**：在复杂长程任务出现执行异常时，开发者或审计人员需要将整个会话拓扑导出至其他节点进行复现排查，或者分享给第三方进行学术交流。但工程会话中常包含真实的敏感文件绝对路径、用户名、商业机密代码 Patch 以及私有提示词，直接导出存在严重的数据泄露风险。
- **机制原理**：吸收 OpenCode [transfer.ts](file:///home/yupeng/references/opencode/packages/core/src/session/transfer.ts)（13.5KB）：
  1. 标准 CLI 迁移命令群：开放 `bi export --sanitize` 与 `bi import <archive>` 命令行接口；
  2. 确定性脱敏管线（`sanitizeMessage`）：建立双向映射脱敏字典，将工程真实物理路径、本地用户名、代码 Patch 细节与用户私有提示词严格替换为规范化的结构化占位符（如 `[redacted:filepath:1]`、`[redacted:content:2]`）；
  3. 拓扑与底账保真留存：在抹除敏感隐私内容的同时，100% 完整保留轮次时间戳、Step 耗时时序、Token 消耗账目、工具调用骨架树与 DAG 状态机转移路径，实现在零数据外泄安全红线下的跨环境故障精准复现与效能评估。

## 二十一、 五大标杆仓库全景对比复盘与 8 项深水区子系统增补吸收

### 1. 五位一体全景架构矩阵复盘

在完成对清华大学 ZCode、清华系 Kimi Code CLI、DeepSeek Harness、Pi Agent 以及 OpenCode CLI 五大标杆仓库的全面逐包逐模块地毯式审计后，整体技术栈的演进脉络与吸收格局已清晰呈现：以 ZCode 作为架构源头母体，融合其它四大工业级开源标杆之长，形成覆盖 104 项物理任务（22 个核心模块 + 82 个细颗粒度子任务）的闭环体系。

| 标杆项目 | 核心定位与设计哲学 | 首要汲取价值与核心资产 | 本次增补吸收的深水区子系统 |
|---|---|---|---|
| **清华 ZCode**<br>(`references/zcode`) | **架构底座与源头母体**<br>学术严谨性与工业落地的结晶，强类型契约、形式化状态空间约束 | 核心接口契约、BigModel 双轨特权认证、错峰与高速卡申领、会话分叉树、动态 DAG 工作流、8 级上下文修剪、官方数据研报插件全套 | **BI-03.6** 离线阴影会话回放与非回归验证引擎（Golden Trajectory 录制与脱机重演） |
| **Kimi Code CLI**<br>(`references/kimi-code`) | **工业级工程实践与防爆治理**<br>极致终端交互体验、防冲防抖与深层防御体系 | 三级 TOML 配置系统、MiniDB LSM 存储、Tower 多 Agent 工作树、AgentSwarm 蜂群并发调度、Plan 模式生命周期、Pi-TUI 强化底座与 CJK 排版 | **BI-07.13** 规范哈希工具调用排重器与三阶反驳循环打断门<br>**BI-10.5** 中断状态上下文自愈注入器与日期跨越感知器 |
| **DeepSeek Harness**<br>(`references/deepseek-harness`) | **大模型原生工程支撑与基础设施**<br>深度契合大模型特性的调度、紧缩、文档处理与评测体系 | 官方适配器与思考流分离、Tool-pairing 原子配对门禁、超大输出磁盘 Spill 溢出隔离、历史多模态图像卸载、LSP 符号级代码导航、交付物追踪 | **BI-07.14** 跨时区全周期任务调度引擎与持久化重放中枢<br>**BI-18.3** 原生 Office 公文双向转译与无头 PDF 渲染管线 |
| **Pi Agent**<br>(`references/pi`) | **高并发状态反应式追踪与无头评测**<br>极致算法性能、轻量纯 TS 数据结构与 Actor 状态机 | CodeMode 零依赖沙箱、KV 缓存 1-token 脉冲保活、流式缓冲与帧率自适应节流、外部编辑器桥接、HTML 独立报告生成器 | **BI-14.5** 进程崩溃自愈持久化调度器与 Actor 状态机<br>**BI-19.7** 反应式结构化 JSON Delta 状态追踪器与客户端零拷贝投影层<br>**BI-21.3** 确定性无头 Agent 评测套件与基准打分引擎 |
| **OpenCode CLI**<br>(`references/opencode`) | **协议治理与安全护城河**<br>现代开源 CLI 架构、严格词法扫描与紧凑展现 | 双边界收件箱（steer/input）、4 级缓存断点策略、纯 TS Shell 词法扫描、SAX 流式 HTML-Markdown 转换、分级工具名录压缩、Mermaid 终端渲染、会话脱敏导出 | 已在第 20 节全量吸收入 WBS（BI-03.5, BI-04.4, BI-06.8, BI-07.12, BI-10.4, BI-13.3, BI-19.6, BI-20.4 共 8 项） |

---

### 2. 八大深水区增补子系统深度技术原理解析

#### 1. 离线阴影会话回放与非回归验证引擎 (BI-03.6)
- **归属源头**：清华大学 ZCode [tools/prompt-trajectory/record.ts](file:///home/yupeng/references/zcode/apps/zcode-cli/tools/prompt-trajectory/record.ts)（11.6KB）与 [scripts/shadow-replay.mjs](file:///home/yupeng/references/zcode/apps/zcode-cli/scripts/shadow-replay.mjs)（10.8KB）。
- **问题根因**：在 Agent 系统迭代过程中，修改 System Prompt、调整工具 Schema 甚至升级大模型基模版本，都极易引发隐蔽的破坏性回归（如原本能通过的财务勾稽因某句提示词微调而失败）。而在公网进行全量重新测试会产生巨大的真实 API 费用和不可预期的外部文件系统副作用。
- **机制原理**：
  1. 黄金轨迹录制（Golden Trajectory Recording）：在生产或开发态执行基准任务时，原子捕获包含全量输入 Prompt、大模型流式 Tokens、工具调用参数与返回结果的时序快照树；
  2. 阴影回放驱动（Shadow Replay Harness）：脱机离线重演历史真实会话，将工具执行路由至轨迹沙箱存根，在 0 实际 API 开销与 0 文件系统副作用下比对新代码生成的决策路径；
  3. 非回归一致性断言：自动计算新旧分支在关键决策节点、工具调用序列与最终交付结果的一致性评分，确立工程演进的绝对安全护城河。

#### 2. 规范哈希工具调用排重器与三阶反驳循环打断门 (BI-07.13)
- **归属源头**：Kimi Code [agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts)（19.3KB，588行）。
- **问题根因**：在长程自主编码与数据分析中，大模型经常因观察结果不符合预期而陷入死循环（如用相同参数反复读取同一文件、重复执行同一无状态命令），造成巨大的 Token 浪费，甚至在无人工干预时耗尽额度。
- **机制原理**：
  1. 规范化参数哈希（Canonical Argument Hashing）：对模型发起的工具调用参数执行递归键排序与规范化序列化，计算 SHA-256 哈希值；若在预设窗口内命中完全一致的调用，直接返回缓存的执行结果，避免重复 I/O；
  2. 三阶渐进式反驳打断门（`RepeatBreaker`）：
     - 第 1 阶（软性反驳）：提示模型该调用与先前完全一致，强制要求模型以单句形式说明预期获得的新信息；
     - 第 2 阶（深度证伪）：强制要求模型执行证伪检查（Falsification check），列出支撑当前假设的反向证据，或主动调用提问门向人类求助；
     - 第 3 阶（硬阻断）：若模型仍执意发起相同调用，系统直接熔断拦截工具执行权限，强制模型基于现有上下文直出最终结论，彻底消灭死循环。

#### 3. 跨时区全周期任务调度引擎与持久化重放中枢 (BI-07.14)
- **归属源头**：DeepSeek Harness [packages/schedule/schedule/src/domain.ts](file:///home/yupeng/references/deepseek-harness/packages/schedule/schedule/src/domain.ts)（79.9KB，1896行）与官方 `Temporal` 规范。
- **问题根因**：传统的定时任务往往仅依赖简单的 `setTimeout` 或外部系统 Cron。在复杂跨国研究、多时区对齐以及长达数周的数据追踪场景下，存在时区漂移、闰年与夏令时边界错误，以及进程重启或会话 Fork 导致的定时器丢失或重复轰炸。
- **机制原理**：
  1. 全周期调度领域原语（Temporal Schedules）：覆盖 After（相对延时）、At（ISO 绝对时间点/本地时钟）、Every（定长间隔）、Cron（标准 5 字段，内嵌 400 年格里高利历法闰年周期）、Daily（每日固定时点）与 Weekly（每周固定星期）；
  2. 持久化事件溯源与重放（Durable Event Sourcing）：所有调度生命周期（创建、触发、跳过、取消）作为结构化事件持久化存储；
  3. 崩溃恢复游标对齐：进程重启时，重放中枢根据最后确认时间戳（`lastAckTime`）智能计算遗漏触发策略（`catchup`），避免堆积事件瞬间并发打爆系统。

#### 4. 中断状态上下文自愈注入器与日期跨越感知器 (BI-10.5)
- **归属源头**：Kimi Code [agent-core-v2/src/agent/interruptionReminder/](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/interruptionReminder/)（2.8KB）与 [agent-core-v2/src/features/dateChange/](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/dateChange/)（6KB）。
- **问题根因**：用户常在模型输出中途按下 Ctrl+C 紧急打断并输入新要求。由于被打断的轮次没有正常结束符，模型在下一轮对话中容易产生混乱、反复道歉（如抱歉被中断）或丢失被打断前的有效推理信息；同时，长程会话跨过午夜时，模型仍基于旧系统时间推演，引发日期计算错误。
- **机制原理**：
  1. 中断恢复事实注入器：捕获中断信号后，清理末尾残缺块，并在下一轮前置自动注入规范上下文事实提醒（`The previous turn was interrupted by the user before completion...`），引导模型直接专注于用户的新指令，杜绝无效道歉幻觉；
  2. 跨午夜日期感知看门狗：后台定时对比系统物理时钟与会话初始化时区，一旦检测到跨越 00:00，自动在上下文末尾注入带有最新物理日期的 `date_change` 披露标记，保障涉税与宏观政策时间维度的绝对准确。

#### 5. 进程崩溃自愈持久化调度器与 Actor 状态机 (BI-14.5)
- **归属源头**：Pi Agent [packages/durable/src/harness/scheduler.ts](file:///home/yupeng/references/pi/packages/durable/src/harness/scheduler.ts)（84.6KB，1953行）与 [types.ts](file:///home/yupeng/references/pi/packages/durable/src/types.ts)（46.7KB）。
- **问题根因**：政策研报与大规模数据处理等工作流往往持续数小时。如果调度状态仅保存在内存中，一旦遭遇服务器意外断电、OOM 杀进程或宿主维护重启，数小时的中间推演数据将全部丢失，必须从头再来。
- **机制原理**：
  1. 状态机 Checkpoint 事务落盘：工作流中的每一个 Step、每次状态迁移（Pending -> Running -> Suspended -> Completed）均通过原子事务写入持久化存储（`storage.tasks`）；
  2. 重启断点秒级自愈扫描：进程拉起时，调度器以分页游标（`SCAN_PAGE_SIZE = 256`）扫描持久化存储中处于未完结态的任务，精确恢复内存 Actor 状态机，无需人工介入即可无损续跑；
  3. 分片定时与防溢出：对于大跨度休眠任务，通过 `MAX_TIMER_DELAY` 分片防止 Node/Bun 32 位定时器整数溢出，提供金融级系统鲁棒性。

#### 6. 原生 Office 公文双向转译与无头 PDF 渲染管线 (BI-18.3)
- **归属源头**：DeepSeek Harness [packages/document/office-to-pdf](file:///home/yupeng/references/deepseek-harness/packages/document/office-to-pdf)（14.7KB）与 LibreOffice 无头渲染管线。
- **问题根因**：国内部委公文与企事业单位研报绝大多数以 Word（.docx）和演示文稿（.pptx）形式下发和流转。大模型直接解析 Office 二进制 XML 容易丢失红头公文排版、批示手迹、印章位置与复杂多栏布局等极其关键的多模态视觉信息。
- **机制原理**：
  1. 原生高精矢量转译：通过轻量无头转译管线，将 Word、PPT 毫秒级转换为标准矢量 PDF，完整保真字体、版心、印章与表格排版；
  2. 页面高精切片与投递：将生成的 PDF 页面按需渲染为超高分辨率位图，按页投递给视觉视窗（Visual Window）与 Visual Judge 核验门；
  3. 双向闭环审计：不仅支持从原始公文提取多模态视觉上下文，还支持在模型生成最终研报后就地导出为符合国家公文标准的 Office 格式。

#### 7. 反应式结构化 JSON Delta 状态追踪器与客户端零拷贝投影层 (BI-19.7)
- **归属源头**：Pi Agent [@earendil-works/chord/src/delta/tracker.ts](file:///home/yupeng/references/pi/packages/chord/src/delta/tracker.ts)（79.8KB，2239行）。
- **问题根因**：在复杂长程任务中，会话状态树（包含数百个消息块、工具状态、思考流折叠状态与工作区变更）规模极其庞大。若每次状态微调都对全量树执行 JSON 序列化并推送给 TUI 或远程 A2A 节点，会导致终端高频重绘卡顿与严重的 CPU 暴击。
- **机制原理**：
  1. 片段表（Piece Table）与平衡树堆（Treap）：在纯 TypeScript 环境下构建高性能不可变数据追踪结构，避免 JavaScript 引擎因频繁创建对象触发深度 GC 暂停；
  2. RFC 6902 JSON Patch 极简 Delta 流：仅捕获发生变动的局部字段，实时计算增删改（add/remove/replace）差分补丁流；
  3. 零拷贝投影层：终端 UI 与远程协同节点仅需在本地状态上应用微量 Delta 补丁，以近乎 0 的 CPU 开销和极低带宽实现毫秒级帧率流畅刷新。

#### 8. 确定性无头 Agent 评测套件与基准打分引擎 (BI-21.3)
- **归属源头**：Pi Agent [packages/evals/src/harness.ts](file:///home/yupeng/references/pi/packages/evals/src/harness.ts)（20.6KB）与 [report.ts](file:///home/yupeng/references/pi/packages/evals/src/report.ts)（19KB）。
- **问题根因**：研发高质量政策审计 Agent 时，开发人员往往依靠主观感受测试几个用例，缺乏工程化、自动化与量化的客观质量护城河。一旦修改核心调度或 Prompt，无法快速验证系统整体能力是提升还是退化。
- **机制原理**：
  1. 零 GUI 纯命令行评测执行器（Headless Eval Harness）：提供标准 CLI 运行套件，支持配置隔离的工作区沙箱与模拟测试夹具（Mock Tools/Providers）；
  2. 黄金基准用例集（Benchmark Suite Cases）：沉淀真实宏观研报提炼、财报交叉勾稽与代码重构等标准用例库，自动执行端到端闭环验证；
  3. 多维量化打分看板（Evaluation Report）：自动采集并生成包含用例通过率、执行时延分布、Token 吞吐量、KV 缓存命中率与上下文滑动峰值的综合打分看板，确保每一次版本发布均有据可依。

---

### 3. 104 项任务闭环结构与演进收敛

随着上述 8 项深水区核心子系统的增补与全量对齐，`devplan.md` 的 Section II 与 Section III 已实现 100% 严格一致的 104 项任务全量覆盖（22 个顶级模块 + 82 个细粒度子任务）。

这一架构以清华 ZCode 作为源头骨架，全面吸纳 Kimi Code、DeepSeek Harness、Pi Agent 与 OpenCode 的最佳实践，构建了一套兼具**清华学术严谨性、工业级防爆稳定性、大模型原生高能效与现代开源工程完备性**的顶尖智能体底座。
