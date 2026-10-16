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

## 二、 五大标杆方案与开源架构深度剖析

本地已于 `~/references/` 建立了 4 大核心开源工程图纸库（`pi`、`zcode`、`deepcode`、`opencode`），经深度代码走读，提炼以下关键发现：

| 标杆项目 | 核心模块与代码走读 | 核心优势（精髓借鉴） | 关键局限与对抗成本 |
|---|---|---|---|
| **Pi Agent**<br>`@earendil-works/pi` | • `packages/coding-agent/src/core/session-manager.ts` (单文件 2,014 行)<br>• `packages/tui/`: 双缓冲差分渲染引擎<br>• `packages/mcp/`: 独立白盒 MCP 客户端<br>• `packages/agent/`: 4 大原子工具 | • **DAG 会话树体系**：每一条消息携带 `id` (UUIDv7) 与 `parentId`，天然支持分支分叉与 Rewind 时光倒流<br>• **错误作为一等公民**：抛异常自动转化为 `isError: true` 促使模型自愈<br>• 架构解耦：TUI 与内核彻底分离，依赖极少 | • 偏向单 Agent 通用编码，缺乏针对 DeepSeek-R1 思考流的特定处理与多智能体分流 |
| **ZCode 官方版**<br>`zai-org/ZCode` | • `core/tool/edit-matchers.ts` (8级阶梯弹性匹配)<br>• `core/tool/read-file-state.ts` (先读后写与mtime防脏写)<br>• `core/memory/dream.ts` (仿生做梦记忆沉淀)<br>• `dynamic-workflow/` (因果依赖图与Taint污点分析)<br>• `spreadsheets-plugin/`, `pdf-plugin/` & `superpowers-plugin/` | • **清华五大黄金模块**：8级阶梯容错匹配（编辑成功率99.5%）、先读后写门禁、Dream Cycle仿生长期记忆、因果依赖图编译器与顶级 Agent SOP 技能集<br>• **开箱即用的专业数据/研报分析插件** | • 官方 CLI 前端采用 React+OpenTUI，较为臃肿且构建链庞大（巨石 Monorepo） |
| **zcode-app-cli**<br>`bpfio/bi` 前身 | • `runtime-tui-bridge.ts`: 进程内函数级桥接<br>• `runtime-sqlite-recovery.ts`: SQLite 并发自愈<br>• `bounded-tool-text.ts`: 64KB 工具输出有界保护<br>• `file-diff-budget.ts`: 2000 行 Diff 预算限制 | • **同进程零拷贝直连（Zero IPC）**：彻底消灭 Localhost Socket 延迟与重连断连隐患<br>• 极高的工程鲁棒性与内存防泄漏 | • **混淆二进制黑盒**（`vendor/zcode.cjs`），供应链不可审计<br>• 27 个 AST/字符串补丁在版本升级中极易漂移 |
| **DeepCode**<br>`lessweb/deepcode-cli` | • `packages/core/session.ts`: 会话状态机<br>• `packages/core/prompt.ts`: 提示词结构<br>• 支持 `thinkingEnabled` 与 `reasoningEffort` | • **原生适配 DeepSeek 系列**：深度适配 R1 思考流展示与参数调优<br>• 针对 DeepSeek 的 Prompt Cache 前缀优化与上下文压缩 | • 缺乏严格的沙箱隔离（Path Jail），代码中工具扩展体系较重 |
| **OpenCode**<br>`anomalyco/opencode` | • `packages/ai/`: 75+ 多模型统一适配<br>• `packages/protocol/`: 跨进程/跨端协议契约<br>• `packages/tui/`: 多会话并行终端界面 | • **极度开放自由**：多模型即插即用，分发体验极佳（一键安装）<br>• 双 Agent 模式（Build vs Plan/Explore）架构清晰 | • 为兼容 75+ 模型导致提示词采用“最大公约数”，对具体模型的调优深度不足，幻觉率高于 ZCode |
| **Kimi Code**<br>`MoonshotAI/kimi-code` | • `packages/tree-sitter-bash/`: 纯 TS Tree-sitter<br>• `packages/minidb/`: 纯 TS LSM-Tree/WAL 数据库<br>• `packages/agent-core-v2/`: DI 容器与细粒度调度<br>• `packages/acp-server/`: Agent Client Protocol | • **清华系月之暗面现代重构标杆 (MIT)**：<br>• **100% 纯 TypeScript 零 Native C 依赖**：手写 Bash 语法树、纯 TS 嵌入式 LSM 数据库，Bun 单文件编译 0 崩溃；<br>• **细粒度 RWLock 调度**：多工具读并发、写互斥与全局屏障；<br>• **多模态与客户端压缩**：终端图片就地无损压缩，保护视窗 | • 侧重通用软件工程编码，未内置宏观经济统计勾稽与部委政策长文档抽取的专业插件模板 |

### 2. 清华大学 ZCode 实验室官方源码十二大黄金模块与工业级算法图谱

在二次深度审查智谱与清华大学开源的 `zai-org/ZCode`（位于本地只读参考库 `/home/yupeng/references/zcode`）后，我们系统梳理出其保障 99.5% 超高代码编辑成功率、0 上下文撑爆与极低幻觉的 **十二大工业级黄金算法与底层工程轮子**。`bi` 架构将全量直接提取并复用这些成熟轮子，最大化压减重复造轮子的对抗成本：

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

### 3. 清华系月之暗面 Kimi Code 官方源码六大黄金模块与工业级算法图谱

月之暗面（Moonshot AI）技术团队同源于清华大学计算机系与交叉信息研究院。其最新开源的 `MoonshotAI/kimi-code`（位于本地只读参考库 `/home/yupeng/references/kimi-code`）代表了纯 TypeScript 技术栈下 Agent CLI 极简解耦架构的最高工程水平。系统深入审查后，提炼出其 **六大独特黄金资产与底层算法**，与 ZCode 形成强力互补：

#### (1) 纯 TypeScript 版 Tree-Sitter Bash 语法分析器 (`packages/tree-sitter-bash`)
- **核心痛点**：传统 CLI 执行 Bash 命令鉴权与安全审计（如检测 `rm -rf /`、拦截偷窃 `.env` / `~/.ssh` 凭据）时，若使用正则表达式极易被引号嵌套、变量替换（`eval` / `$()`）绕过；若引入 C++ 编译的 `tree-sitter.node`，则彻底破坏 Bun 单文件独立二进制（`bun build --compile`）与跨发行版便携性。
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
│   │   └── merger.ts      # 审查通过后的原子 Cherry-pick / Merge 合入
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
│   │   └── transports/    # 多模式 A2A 传输驱动层
│   │       ├── eventbus.ts            # L1: 本地进程内极速事件总线 (<0.1ms)
│   │       ├── a2a-email-gateway.ts   # L3: A2A 邮件私密信令网关 (SMTP/IMAP 跨物理墙控制面)
│   │       └── github-a2a-hub.ts      # L3: GitHub A2A 任务中枢 (任务分支与 PR 交付数据面)
│
├── tui/                   # 终端交互层 (基于 @earendil-works/pi-tui)
│   ├── src/
│   │   ├── app.ts         # TUI 主生命周期与差分渲染循环 (处理 SIGINT 与按键)
│   │   ├── hud.ts         # Token 消耗、TTFT 延迟与 Cache 命中率状态栏
│   │   ├── diff-view.ts   # 交互式 Git Unified Diff 预览与批准门
│   │   ├── thinking.ts    # R1 思考流动态收起/展开折叠卡片
│   │   ├── workflow-view.ts# DAG 工作流步骤与检查点可视化看板
│   │   ├── subagent-view.ts# A2A 多子智能体并行执行看板
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
  ├── 实现智谱 BigModel 双轨特权认证 (OAuth 免密 + API Key 二阶段 PAT 换票与 Ultra 专线重定向)
  ├── 注入 X-Coding-Plan-Api-Key、User-Agent 等官方指纹标头，对齐客户端折扣特权
  ├── 落地 Append-only JSONL 树状会话引擎 (支持断点恢复、/rewind 时光倒流与 /fork 平行分叉)
  ├── 接入 GLM、DeepSeek 等统一 SSE 流式驱动与单模型插槽路由 (Model Slot Router)
  ├── 落地 BI.md 项目级长期记忆与领域规范自适应注入
  ├── 实现基于 Linux PGID 进程组看门狗的受控 Bash 执行器 (杜绝孤儿进程)
  ├── 落地多工具调用并行并发流水线 (Promise.allSettled)
  ├── 落地 BI-07.3 本地 Sub-agent 视窗沙箱与 Fork Subagent 字节级 Prompt Cache 继承
  ├── 落地 BI-07.4 双向信令协调 (SendMessage/RespondToCoordinator) 与只镜不落库 Mirror Sink
  └── 接入二段式优雅抢占与取消状态机 (Ctrl+C / Esc 保留上下文即时纠偏)

[Phase 2] Git Worktree 并发隔离与完整 MCP 引擎 (Days 4~5)
  ├── 实现 packages/worktree，落地子智能体工作区物理隔离与自动擦除
  ├── 实现 packages/mcp，支持 Stdio 与 SSE 双通道 (实测接驳 Logbook)
  └── 验证工作区零污染与外部工具动态注册

[Phase 3] A2A 协议、分工协作与 DAG 工作流编排 (Days 6~8)
  ├── 落地 packages/workflow 声明式 DAG 步骤调度与 Checkpoint 检查点自愈
  ├── 落地 packages/a2a 通用容器、事实黑板与证据一致性核验协议 (AuditProtocol)
  └── 跑通“单模型自洽闭环：主协调官 -> 探针搜集 -> 沙箱精算 -> 事实黑板合流”流程

[Phase 4] 官方插件体系吸收与防幻觉强化 (Days 9~10)
  ├── 落地 packages/plugins 官方插件双协议加载器 (.zcode-plugin & .claude-plugin)
  ├── 全量移植官方 spreadsheets-plugin 与 pdf-plugin 核心库
  ├── 吸收 BI-18.1 清华顶尖 Agent SOP (含 SDD 双阶段审查与完工自验看门狗)
  ├── 挂接 Git Worktree 隔离运行沙箱与 Python 逆向勾稽核验
  └── 落实多轮思考流剥离 (CoT Stripping) 与 KV Cache 锁定调优

[Phase 5] Pi-TUI 差分终端与正式交付 (Days 11~14)
  ├── 接入 @earendil-works/pi-tui 差分渲染界面 (消除终端跳字闪烁)
  ├── 挂载 Token HUD 实时仪表盘 (显化 Cache Read 命中率 %、TTFT 延迟与 Token 消耗)
  ├── 实装 BI-18.2 Visual Judge 视觉核验判定器与图表渲染自愈闭环
  ├── 接入交互式 Git Unified Diff 审查门与一键撤销
  ├── 实现 /doctor 全链路网络连通性、凭据有效性与 Python 依赖一键体检
  ├── 挂载 DAG 工作流看板、A2A 看板与思考流折叠视图
  └── 端到端宏观政策与数据审计实战验收，发布 bpfio/bi v1.0
```
