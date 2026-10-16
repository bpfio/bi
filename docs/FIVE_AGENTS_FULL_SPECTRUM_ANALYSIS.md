# 五大工业级开源 Agent CLI 全景模块、组件、逻辑与功能分析大典 (SSOT Master Catalog)

> **创建时间**：2026-10-16  
> **单一事实源 (SSOT)**：本文档是 `zcodecli` (`bi`) 项目对五大标杆项目进行 **100% 全覆盖、全模块、全组件、全逻辑与全功能深度透视** 的权威底账。  
> **核心使命**：五大标杆项目源码总计超过 **25,150 个代码文件、211.94 MB 源码**。后续任何开发智能体在吸收、比对、复刻或定位特定能力时，**严禁再次重复遍历扫描庞大源码树**，必须以本文档及同步至 QNAP NAS Logbook 的结构化知识库作为权威索引字典，实现毫秒级精准代码定位与零冗余算力消耗。

---

## 目录索引 (Table of Contents)

- [一、 五大标杆全局定位与全景架构矩阵 (Executive Landscape)](#一-五大标杆全局定位与全景架构矩阵-executive-landscape)
- [二、 清华大学 ZCode 全模块组件与核心逻辑深度透析 (源头母体)](#二-清华大学-zcode-全模块组件与核心逻辑深度透析-源头母体)
- [三、 清华系 Kimi Code CLI 全模块组件与核心逻辑深度透析 (工业防爆)](#三-清华系-kimi-code-cli-全模块组件与核心逻辑深度透析-工业防爆)
- [四、 OpenCode CLI 全模块组件与核心逻辑深度透析 (协议治理与现代规范)](#四-opencode-cli-全模块组件与核心逻辑深度透析-协议治理与现代规范)
- [五、 DeepSeek Harness 全模块组件与核心逻辑深度透析 (大模型原生基础设施)](#五-deepseek-harness-全模块组件与核心逻辑深度透析-大模型原生基础设施)
- [六、 Pi Agent 全模块组件与核心逻辑深度透析 (极高性能与反应式模型)](#六-pi-agent-全模块组件与核心逻辑深度透析-极高性能与反应式模型)
- [七、 五大标杆核心功能与组件跨项目速查字典 (Developer Quick Lookup Matrix)](#七-五大标杆核心功能与组件跨项目速查字典-developer-quick-lookup-matrix)

---

## 一、 五大标杆全局定位与全景架构矩阵 (Executive Landscape)

### 1. 五大开源标杆全局全景统计总表

| 标杆项目 | 本地基准路径 | 源码文件总数 | 源码物理体积 | Monorepo 子包数 | 核心定位与设计哲学 | 顶级技术资产与代表机制 |
|---|---|---|---|---|---|---|
| **清华大学 ZCode** | `references/zcode` | 8,909 个文件 | 77.78 MB | 49 个子包 | **架构底座与源头母体**<br>清华大学学术严谨性与工业落地的集大成者，契约驱动，形式化证明状态空间 | 智谱 BigModel 双轨特权认证、闲时错峰调度、会话分叉树、动态 DAG 工作流引擎、Microcompact 历史工具脱水、REM 仿生做梦沉淀、Golden Trajectory 阴影会话回放、官方插件资产全套 |
| **清华系 Kimi Code CLI** | `references/kimi-code` | 3,436 个文件 | 28.72 MB | 18 个子包 | **工业级工程实践与防爆治理**<br>极致终端交互体验、防冲防抖与深层防御体系 | 三级 TOML 配置系统与 smol-toml 保留注释回写、RepeatBreaker 三阶反驳打断门、MiniDB 纯 TS LSM 存储、Tower 多 Agent 工作树协作、AgentSwarm 蜂群调度、Plan 模式审批门禁、CJK 宽字符排版 |
| **OpenCode CLI** | `references/opencode` | 5,099 个文件 | 35.22 MB | 35 个子包 | **协议治理与现代开源规范**<br>现代 Effect 驱动范式、零依赖严密词法扫描与紧凑展现 | 双边界会话收件箱（steer/input）与门铃并发协调器、4 级 KV 缓存断点编排、纯 TS 确定性 Shell 词法扫描、SAX 流式 HTML 转 Markdown、分级命名空间工具名录压缩、Mermaid 终端 ASCII 渲染、会话全拓扑脱敏导出导入 |
| **DeepSeek Harness (DHS)** | `references/deepseek-harness` | 6,074 个文件 | 56.04 MB | 52 个子包 | **大模型原生工程支撑与基础设施**<br>深度契合大模型特性的调度、紧缩、文档处理与评测体系 | DeepSeek-V3/R1 官方 Messages wire 协议适配与思考流分离、Temporal 全周期调度领域模型、Office 原生公文双向转译管线、LSP 符号级代码导航、Tool-pairing 原子配对门禁、超大输出磁盘 Spill 溢出隔离、PTC 程序化工具调用 |
| **Pi Agent** | `references/pi` | 1,632 个文件 | 14.18 MB | 11 个子包 | **高并发状态反应式追踪与无头评测**<br>极致算法性能、轻量纯 TS 数据结构与 Actor 状态机 | Chord 片段表与平衡树堆（Treap）零拷贝 JSON Delta 状态追踪器、Durable 进程崩溃 Checkpoint 持久化调度器、无头 Agent 评测套件与量化看板、CodeMode 零依赖计算沙箱、Prompt KV 缓存 1-token 脉冲保活 |
| **全网总计** | **5 大标杆** | **25,150 个文件** | **211.94 MB** | **165 个子包** | **五位一体协同互补** | **104 项全生命周期 SSOT 工业级能力矩阵全闭环** |

---

### 2. 五位一体架构融合设计图

```
               ┌─────────────────────────────────────────────────────────────┐
               │              bi 命令行终端应用 (Single-Model CLI)           │
               └──────────────┬───────────────────────────────┬──────────────┘
                              │                               │
        ┌─────────────────────┴─────────────┐   ┌─────────────┴─────────────────────┐
        │        终端交互与状态呈现层       │   │        协议规范与安全治理层       │
        ├───────────────────────────────────┤   ├───────────────────────────────────┤
        │ • Pi-TUI 强化双缓冲差分终端 (Kimi)│   │ • 纯 TS Shell 确定性词法扫描 (OC) │
        │ • CJK 宽字符排版与同构投影 (Kimi) │   │ • 模式级权限规则与三态授权门(Kimi)│
        │ • 终端 Mermaid ASCII 渲染 (OC)    │   │ • 4 级 KV 缓存断点硬预算编排 (OC) │
        │ • Chord 零拷贝 JSON Delta 追踪(Pi)│   │ • 双边界收件箱门铃并发协调器 (OC) │
        └─────────────────────┬─────────────┘   └─────────────┬─────────────────────┘
                              │                               │
               ┌──────────────┴───────────────────────────────┴──────────────┐
               │                清华大学 ZCode 核心运行时母体 (Core)         │
               ├─────────────────────────────────────────────────────────────┤
               │ • 契约接口规范 (@zcode/contracts) 与形式化状态空间约束      │
               │ • 智谱 BigModel 官方双轨特权认证 (OAuth PKCE + 折扣专线)    │
               │ • Append-only JSONL 会话分叉树与逆向补丁差分回滚 (rewind)   │
               │ • 声明式 DAG 工作流调度引擎与 Taint 污点因果拓扑图          │
               │ • 闲时任务错峰调度器 (offPeakTask) 与免费高速卡抽卡机制     │
               │ • Golden Trajectory 黄金轨迹录制与脱机阴影回放 (shadow)     │
               └──────────────┬───────────────────────────────┬──────────────┘
                              │                               │
        ┌─────────────────────┴─────────────┐   ┌─────────────┴─────────────────────┐
        │      上下文防爆与视窗自愈层       │   │      工作流、调度与扩展生态层     │
        ├───────────────────────────────────┤   ├───────────────────────────────────┤
        │ • RepeatBreaker 三阶反驳打断(Kimi)│   │ • Temporal 全周期调度领域模型(DHS)│
        │ • Tool-pairing 原子配对门禁 (DHS) │   │ • Durable 崩溃自愈 Actor 调度 (Pi)│
        │ • 历史工具脱水与 80% 自动紧缩     │   │ • Tower 多 Agent 工作树协作(Kimi) │
        │ • 中断恢复提醒与日期看门狗 (Kimi) │   │ • 原生 Office 公文双向转译 (DHS)  │
        │ • 超大输出磁盘 Spill 溢出 (DHS)   │   │ • 官方研报插件全套移植 (清华ZCode)│
        │ • 1-token 脉冲缓存保活看门狗 (Pi) │   │ • 确定性无头评测套件与看板 (Pi)   │
        └───────────────────────────────────┘   └───────────────────────────────────┘
```

---

## 二、 清华大学 ZCode 全模块组件与核心逻辑深度透析 (源头母体)

### 1. 资产全景与工程拓扑
清华大学官方 ZCode 仓库（`references/zcode`，Apache-2.0）作为 `bi` 项目的**源头母体**，总计包含 49 个 Monorepo 子包，核心代码分布在 `apps/zcode-cli` 与根目录 `packages/` 中。

| 模块路径 | 语言与代码量 | 对应包名 | 核心职责与设计原理 |
|---|---|---|---|
| [`apps/zcode-cli/packages/core`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core) | TS, 799文件, 23.4万行 | `@zcode/core` | 整个 Agent CLI 的核心大脑。包含运行时 Step 循环、会话持久化、会话分叉、上下文构建、Prompt KV 缓存编排、紧缩算法、记忆系统与三级权限管理。 |
| [`apps/zcode-cli/packages/adapters`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters) | TS, 373文件, 12.1万行 | `@zcode/adapters` | 基础设施适配层。包含大模型网络协议与标头路由、Bash 命令执行管道与 64KB 截断保护、MCP Stdio/Network 通信池、插件声明式解析器与 Git 快照。 |
| [`apps/zcode-cli/packages/dynamic-workflow`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/dynamic-workflow) | TS, 463文件, 4.4万行 | `@zcode/dynamic-workflow` | 声明式 DAG 工作流调度引擎。提供因果拓扑排序、Taint 污点分析、步骤 Checkpoint 事务落盘与断点续跑。 |
| [`apps/zcode-cli/packages/contracts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/contracts) | TS, 163文件, 2.98万行 | `@zcode/contracts` | 强类型契约层。定义所有模型、工具、会话、工作流和权限接口规范。 |
| [`apps/zcode-cli/packages/cli`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/cli) | TS, 111文件, 2.46万行 | `@zcode/cli` | 命令行入口与参数解析层。包括剪贴板跨平台图像探测（`clipboard-image.ts`）与启动编排。 |
| [`apps/zcode-cli/packages/tui`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/tui) | TSX, 90文件, 1.8万行 | `@zcode/tui` | 终端 UI 视图层。支持思考折叠渲染、Unified Diff 审批弹窗、状态指示器与键盘监听。 |
| [`apps/zcode-cli/tools/prompt-trajectory`](file:///home/yupeng/references/zcode/apps/zcode-cli/tools/prompt-trajectory) | TS, 11.6KB | 独立工具 | 生产级会话黄金轨迹录制引擎（`record.ts`）。 |
| [`apps/zcode-cli/scripts/shadow-replay.mjs`](file:///home/yupeng/references/zcode/apps/zcode-cli/scripts/shadow-replay.mjs) | MJS, 10.8KB | 独立脚本 | 离线阴影会话回放执行器。脱机执行历史真实轨迹非回归校验。 |
| [`packages/services`](file:///home/yupeng/references/zcode/packages/services) | TS, 674文件, 8.5万行 | `@zcode/services` | 智谱官方特权服务支持包。包含 Token 配额监控、闲时错峰调度器、赠送额度申领与免费高速卡抽卡。 |
| [`packages/formal-proof`](file:///home/yupeng/references/zcode/packages/formal-proof) | Markdown/TS, 19.5KB | 形式化证明规范 | `conversation-product-state-space.md`：定义产品上下文×用户动作×目标对象×阶段转移的形式化正规化状态空间与防竞态不变量。 |
| 官方插件集合 (Plugins) | Python/TS | 6大官方插件 | `spreadsheets-plugin` (xlsx.py 审计), `pdf-plugin`, `documents-plugin`, `presentations-plugin`, `visualize-plugin` (visual-judge.md), `superpowers-plugin` (SDD SOP)。 |

---

### 2. 清华 ZCode 核心子系统与关键代码剖析

#### 1. 运行时 Step 驱动与流式恢复状态机
- **核心文件**：[`apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts)（32KB）与 [`streaming-recovery.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts)。
- **核心机制**：
  - 采用显式状态机驱动模型单步交互：`PREPARING_CONTEXT -> DISPATCHING_MODEL -> STREAMING_CHUNKS -> ACCUMULATING_TOOL_CALLS -> EXECUTING_TOOLS -> EVALUATING_COMPLETION`；
  - 流式连接异常时触发 `StreamingRecoveryCoordinator`，在保留已接收 Tokens 与工具调用片段的前提下发起断点重连，支持 R1 思考流无缝剥离。

#### 2. 会话分叉树与物理差分回滚
- **核心文件**：[`session-fork.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts)（53KB）与 [`file-rewind.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts)（21KB）。
- **核心机制**：
  - 基于 Append-only JSONL 会话事件日志，通过 `parentSessionId` 维护会话分叉树（DAG），支持用户在任意历史轮次发起 `bi fork` 派生独立实验分支；
  - `file-rewind.ts` 结合 `workspace-checkpoints.ts`，记录每轮工具执行产生的反向补丁（Reverse Unified Patch），时光倒流时原子还原物理文件系统。

#### 3. 智谱 BigModel 双轨特权认证与闲时错峰调度
- **核心文件**：[`off-peak-request-auth.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters/src/model/off-peak-request-auth.ts)、[`runner-network-headers.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts) 与 [`offPeakTaskService.ts`](file:///home/yupeng/references/zcode/packages/services/src/session/offPeakTaskService.ts)（26KB，681行）。
- **核心机制**：
  - 自动向请求标头注入 `X-Coding-Plan-Api-Key` 并重定向至 `/api/v1/ultra/` 专线；
  - 完整实现智谱官方闲时错峰调度状态机：用户标记非紧急长程任务后，客户端将任务推送到闲时调度队列，轮询排队序号，在低峰期自动晋级执行，并在 3102 状态下自动断点续跑，终态通过 Outbox 原子核销，享受 1~3 折超低算力。

#### 4. REM 仿生做梦记忆沉淀中枢 (Dream Cycle)
- **核心文件**：[`apps/zcode-cli/packages/core/src/memory/dream.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/memory/dream.ts)（9.9KB，`evaluateAutoDreamTiming`）与 [`memory-agent-loop.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/memory/memory-agent-loop.ts)。
- **核心机制**：
  - 清华大学独创的仿生记忆整理算法。当检测到系统处于持续空闲期且历史累积交互超过阈值时，自动触发后台梦境循环；
  - 提取会话中的关键事实、架构决策与业务口径，自动去重并合并写入项目的 `BI.md`（或 `CLAUDE.md`），实现知识资产的长期固化。

#### 5. 黄金轨迹录制与脱机阴影回放 (Golden Trajectory & Shadow Replay)
- **核心文件**：[`tools/prompt-trajectory/record.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/tools/prompt-trajectory/record.ts)（11.6KB）与 [`scripts/shadow-replay.mjs`](file:///home/yupeng/references/zcode/apps/zcode-cli/scripts/shadow-replay.mjs)（10.8KB）。
- **核心机制**：
  - 在生产环境中录制黄金轨迹（Golden Trajectory），捕获完整的用户指令、上下文快照、模型流式决策与工具返回结果；
  - 发布新版本或更换基模时，脱机回放真实历史会话，工具执行由沙箱存根接管，在 0 实际 API 消耗与 0 文件破坏的前提下自动化校验决策路径一致性。

---

## 三、 清华系 Kimi Code CLI 全模块组件与核心逻辑深度透析 (工业防爆)

### 1. 资产全景与工程拓扑
Kimi Code（`references/kimi-code`，Moonshot 系清华团队）是业界终端工程防爆治理与工业级交互的标杆，包含 18 个子包，核心代码分布在 `agent-core-v2`、`pi-tui`、`minidb` 与 `apps/kimi-code` 中。

| 模块路径 | 语言与代码量 | 对应包名 | 核心职责与设计原理 |
|---|---|---|---|
| [`packages/agent-core-v2`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2) | TS, 1,474文件, 32.98万行 | `@moonshot-ai/agent-core-v2` | 基于 DI 容器与 Scope 生命周期的统一 Agent 引擎。内置工具排重、三阶 RepeatBreaker、级联撤销、Plan 模式、蜂群调度、Tower 多 Agent 协作与三级 TOML 配置。 |
| [`packages/pi-tui`](file:///home/yupeng/references/kimi-code/packages/pi-tui) | TS, 89文件, 3.87万行 | `@moonshot-ai/pi-tui` | 强化版终端双缓冲差分渲染引擎。提供东亚宽字符（CJK）宽度计算、PasteBurst 防冲看门狗与蜂群泳道进度条。 |
| [`packages/minidb`](file:///home/yupeng/references/kimi-code/packages/minidb) | TS, 134文件, 3.89万行 | `@moonshot-ai/minidb` | 纯 Node.js 嵌入式高性能数据库。混合 Redis 内存语义与 LSM-Tree 持久化，支持 SkipList 跳表与 Trigram 分词索引。 |
| [`packages/transcript`](file:///home/yupeng/references/kimi-code/packages/transcript) | TS, 29文件, 7,091行 | `@moonshot-ai/transcript` | 同构日志状态投影层。将底层 Agent 事件树无损投影为终端折叠卡片与离线报表。 |
| [`packages/acp-server`](file:///home/yupeng/references/kimi-code/packages/acp-server) | TS, 46文件, 1.02万行 | `@moonshot-ai/acp-server` | 标准 Agent Client Protocol 服务端。直连现代 IDE 扩展。 |
| [`packages/remote-control`](file:///home/yupeng/references/kimi-code/packages/remote-control) | TS, 8文件, 4,412行 | `@moonshot-ai/remote-control` | 穿透式 WebSocket 中继隧道。支持免公网暴露的移动端/远程审查。 |
| [`packages/kosong`](file:///home/yupeng/references/kimi-code/packages/kosong) | TS, 85文件, 3.78万行 | `@moonshot-ai/kosong` | 现代大模型抽象层。支持跨厂商流式解析与函数调用多模态适配。 |
| [`packages/tree-sitter-bash`](file:///home/yupeng/references/kimi-code/packages/tree-sitter-bash) | TS, 17文件, 7,858行 | `@moonshot-ai/tree-sitter-bash` | 纯 TypeScript 实现的 Bash 语法树解析器。 |
| [`apps/kimi-code`](file:///home/yupeng/references/kimi-code/apps/kimi-code) | TS, 607文件, 15.6万行 | `@moonshot-ai/kimi-code` | 完整 CLI 前端。支持 export、fork、session、vis、config、copy 六大子命令群。 |

---

### 2. Kimi Code 核心子系统与关键代码剖析

#### 1. 规范哈希工具排重器与三阶反驳循环打断门 (Tool Dedupe & RepeatBreaker)
- **核心文件**：[`agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts)（19.3KB，588行）。
- **核心机制**：
  - 参数规范化哈希：对模型发出的工具参数执行深度递归键排序，计算规范 SHA-256 哈希值；同轮或相邻轮命中相同哈希时直接回显缓存结果；
  - 三阶渐进式打断门（`RepeatBreaker`）：
    - 第 1 阶（预期声明）：提示模型该调用与先前完全一致，强制要求模型以单句说明预期获得的新信息；
    - 第 2 阶（证伪检查）：强制要求模型执行反向证据自检（Falsification check）或调用提问门向人类求助；
    - 第 3 阶（硬阻断）：若模型仍尝试调用相同参数，系统彻底阻断工具执行并强制直出文本，消灭死循环。

#### 2. 中断自愈事实注入器与日期跨越感知器
- **核心文件**：[`agent-core-v2/src/agent/interruptionReminder/interruptionReminderService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/interruptionReminder/interruptionReminderService.ts)（2.8KB）与 [`features/dateChange/dateChangeService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/dateChange/dateChangeService.ts)（6KB）。
- **核心机制**：
  - 用户 Ctrl+C 打断当前轮次后，服务自动清理末尾残缺块，并在下一轮前置注入事实提醒（`The previous turn was interrupted by the user before completion...`），引导模型无缝接续，杜绝道歉幻觉；
  - 日期看门狗常驻后台，一旦长程会话跨越午夜 00:00，自动注入 `date_change` 标记，纠正时间基线。

#### 3. 三级 TOML 配置系统与注释保留原子回写
- **核心文件**：[`agent-core-v2/src/app/config/configService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/app/config/configService.ts)（1,025行）与 [`tomlWriteback.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/app/config/tomlWriteback.ts)。
- **核心机制**：
  - 纯 TypeScript 级联三级配置：全局配置（`~/.kimi/config.toml`）、工作区配置（`.kimi/config.toml`）与 CLI 运行时参数优先级覆盖；
  - 基于 `smol-toml` 语法树，修改配置回写时 100% 保留用户手写的代码注释与原始缩进；支持终端 `/config` 交互面板与 `/reload` 零重启热重载。

#### 4. 蜂群并发调度器 (AgentSwarm) 与 Tower 工作树协作协议
- **核心文件**：[`features/swarm/tools/agent-swarm/agentSwarmTool.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/swarm/tools/agent-swarm/agentSwarmTool.ts)（14KB）与 [`features/tower/towerService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/tower/towerService.ts)（36.7KB）。
- **核心机制**：
  - `AgentSwarm` 暴露模板扇出工具，模型可动态派生数十个并发子智能体执行文件扫描，并发池严格限流防打爆 API，进度实时推送到 TUI 泳道面板；
  - `Tower` 基于物理 Git Worktree 分支隔离 Worker 与 Reviewer，通过 `.tower/comms/` 协议交换信令，并设 Merge Gate 审查门禁。

---

## 四、 OpenCode CLI 全模块组件与核心逻辑深度透析 (协议治理与现代规范)

### 1. 资产全景与工程拓扑
OpenCode（`references/opencode`，Anomaly 社区主导）采用现代 Monorepo 架构（35 个子包），在协议规范、语法扫描、缓存对齐与终端渲染方面具有极高的工程价值。

| 模块路径 | 语言与代码量 | 对应包名 | 核心职责与设计原理 |
|---|---|---|---|
| [`packages/core`](file:///home/yupeng/references/opencode/packages/core) | TS, 750文件, 17.38万行 | `@opencode/core` | 核心引擎。包含双边界收件箱门铃协调器（`inbox.ts` 18.7KB, `run-coordinator.ts` 9KB）、确定性 Shell 词法扫描器（`scan.ts` 97.8KB）、流式 HTML 转 Markdown（`html-markdown.ts` 21.7KB）与会话脱敏导出（`transfer.ts` 13.5KB）。 |
| [`packages/ai`](file:///home/yupeng/references/opencode/packages/ai) | TS, 406文件, 7.96万行 | `@opencode/ai` | 大模型协议层。包含 4 级 KV 缓存断点编排（`cache-policy.ts` 8.7KB）、推理开销平滑更新（`effort-updates.ts`）与工具历史状态机补齐（`tool-history.ts` 3.5KB）。 |
| [`packages/merman`](file:///home/yupeng/references/opencode/packages/merman) | TS, 89文件, 1.24万行 | `@opencode/merman` | 终端 Mermaid 原生渲染引擎。在二维字符画布上以高精 Unicode/ASCII 符号直出时序图、流程图与甘特图。 |
| [`packages/codemode`](file:///home/yupeng/references/opencode/packages/codemode) | TS, 85文件, 3.15万行 | `@opencode/codemode` | 包含工具名录分级命名空间与 2000 Token 硬预算自适应调度器（`catalog.ts` 6.5KB）。 |
| [`packages/app`](file:///home/yupeng/references/opencode/packages/app) | TS, 583文件, 17.8万行 | `@opencode/app` | 跨平台应用编排底座。 |
| [`packages/cli`](file:///home/yupeng/references/opencode/packages/cli) | TS, 189文件, 2.52万行 | `@opencode/cli` | 命令行接口实现与命令分发。 |
| 其余 29 个子包 | TS, 共 3,000+ 文件 | 见全包清单 | 覆盖 client, console, containers, gui-extensions, http-recorder, protocol, schema, session-ui, stats, tui 等。 |

---

### 2. OpenCode 核心子系统与关键代码剖析

#### 1. 双边界会话收件箱与门铃并发协调器
- **核心文件**：[`packages/core/src/session/inbox.ts`](file:///home/yupeng/references/opencode/packages/core/src/session/inbox.ts)（18.7KB）与 [`run-coordinator.ts`](file:///home/yupeng/references/opencode/packages/core/src/session/run-coordinator.ts)（9KB）。
- **核心机制**：
  - 消息进入会话时严格划分为 `steer`（步内提权队列）与 `input`（空闲排队队列）；
  - 每步 Step 流式输出完毕派发工具前，优先轮询 `steer` 队列，存在纠偏指令则立即注入当前视窗改变下一步行为；
  - 门铃看门狗（`pendingWake`）：通过原子门铃标记消除排空检查与空闲切换之间的时间窗口竞态，杜绝待办消息挂起。

#### 2. 纯 TypeScript 确定性 Shell 词法扫描器
- **核心文件**：[`packages/core/src/shell/scan.ts`](file:///home/yupeng/references/opencode/packages/core/src/shell/scan.ts)（97.8KB，2,410行纯 TS 代码）。
- **核心机制**：
  - 零依赖扫描 Bash/Zsh 语法树，逐字符解析复合命令、管道、Heredoc、重定向与引号转义；
  - 将所有在静态分析期无法确定命令名与参数边界的动态调用判定为 `{ kind: "opaque", reason: "dynamic-execution" }`；
  - 静态只读命令快速放行，一旦出现 `eval` 或未转义反引号动态拼接，立即阻断并提级审批。

#### 3. 4 级 KV 缓存断点编排与推理开销平滑更新
- **核心文件**：[`packages/ai/src/cache-policy.ts`](file:///home/yupeng/references/opencode/packages/ai/src/cache-policy.ts)（8.7KB）与 [`effort-updates.ts`](file:///home/yupeng/references/opencode/packages/ai/src/effort-updates.ts)。
- **核心机制**：
  - 严格按预算控制 4 个断点：① 最后一个工具定义；② System Prompt 起始；③ System Prompt 末尾；④ 历史对话尾部第 2 轮 Assistant；
  - 动态推理开销（thinking effort）采用向后追加元数据更新，而非修改历史 System 消息，稳保 85% 以上缓存命中率。

#### 4. 高性能流式 HTML 转 Markdown 抽取引擎
- **核心文件**：[`packages/core/src/tool/html-markdown.ts`](file:///home/yupeng/references/opencode/packages/core/src/tool/html-markdown.ts)（21.7KB，659行）。
- **核心机制**：
  - 基于 `htmlparser2` SAX 状态机，内存常驻在 5MB 以内，毫秒级（约 0.5ms）完成长文解析；
  - 精准重构 HTML 表格为标准 Markdown 表格，内置 5MB 文本保护熔断，防止超大网页引发 OOM。

#### 5. 终端 Mermaid 架构与时序图 ASCII/Unicode 原生渲染引擎
- **核心文件**：[`packages/merman/`](file:///home/yupeng/references/opencode/packages/merman)（89个源码文件）与 [`markdown.ts`](file:///home/yupeng/references/opencode/packages/merman/src/markdown.ts)（12.4KB）。
- **核心机制**：
  - 构建终端二维字符视口矩阵，使用高精 Unicode 边框线（`┌ ─ ┐ │ └ ┘ ├ ┤ ┬ ┴ ┼`）与箭头走线；
  - 支持 Flowchart、Sequence、Gantt、GitGraph、State、Timeline，自适应 80/120 列换行折叠与 ANSI 调色板映射。

---

## 五、 DeepSeek Harness 全模块组件与核心逻辑深度透析 (大模型原生基础设施)

### 1. 资产全景与工程拓扑
DeepSeek Harness（`references/deepseek-harness`，DeepSeek 官方基准）包含 52 个 Monorepo 子包，是大模型原生调度、上下文紧缩、公文处理与评测体系的代表作。

| 模块路径 | 语言与代码量 | 对应包名 | 核心职责与设计原理 |
|---|---|---|---|
| [`packages/schedule/schedule`](file:///home/yupeng/references/deepseek-harness/packages/schedule/schedule) | TS, 31文件, 1.8万行 | `schedule` | 包含工业级 Temporal 调度领域模型（`domain.ts` 79.9KB，1896行），覆盖 After/At/Every/Cron/Daily/Weekly 全原语与持久化重放。 |
| [`packages/llm`](file:///home/yupeng/references/deepseek-harness/packages/llm) | TS, 157文件, 3.2万行 | `llm` | DeepSeek-V3/R1 官方 Messages wire 协议适配器、思考流签名回放、v41 视觉 Token 网格算法与 O(N²) CPU 修复。 |
| [`packages/document/office-to-pdf`](file:///home/yupeng/references/deepseek-harness/packages/document) | TS/Shell, 14.7KB | `document` | 原生 Office 公文双向转译管线。将 Word/PPT 快速转为高精矢量 PDF 并切片投递多模态视窗。 |
| [`packages/lsp`](file:///home/yupeng/references/deepseek-harness/packages/lsp) | TS, 28文件, 2.6万行 | `lsp` | Language Server Protocol 客户端。支持定义跳转、符号引用、实现查找与 Hover 文档。 |
| [`packages/compaction`](file:///home/yupeng/references/deepseek-harness/packages/compaction) | TS, 32文件, 8,852行 | `compaction` | 工具调用原子配对门禁（`tool-pairing.ts` 前缀和平衡算法）与历史多模态图像渐进卸载（`compaction-image-offload`）。 |
| [`packages/spill`](file:///home/yupeng/references/deepseek-harness/packages/spill) | TS, 17文件, 3,200行 | `spill` | 超大输出磁盘 Spill 溢出隔离与确定性 Unicode 码点中间修剪器（头 4096 + 标记 + 尾 1024）。 |
| [`packages/jobs`](file:///home/yupeng/references/deepseek-harness/packages/jobs) | TS, 19文件, 4.4万行 | `jobs` | 异步后台任务运行时（`jobs-local` 30.5KB）与生命周期管理工具三件套（`tool-jobs` 13.5KB）。 |
| [`packages/interaction`](file:///home/yupeng/references/deepseek-harness/packages/interaction) | TS, 23文件, 2.35万行 | `interaction` | 交互式用户提问门（`tool-ask-user` 8.5KB）与计时挂起恢复器（`user-questions` 15KB）。 |
| [`packages/settings`](file:///home/yupeng/references/deepseek-harness/packages/settings) | TS, 12文件, 2,100行 | `settings` | 结构化脱敏算法（`redact.ts`，基于 `role('secret')` 消除凭据泄露）。 |
| [`packages/ptc-runtime`](file:///home/yupeng/references/deepseek-harness/packages/ptc-runtime) | TS, 44文件, 1.2万行 | `ptc-runtime` | 程序化工具调用运行时（Programmatic Tool Calling），将 Schema 编译为脚本批量执行。 |
| [`packages/deliverables`](file:///home/yupeng/references/deepseek-harness/packages/deliverables) | TS, 21文件, 2,897行 | `deliverables` | 最终产出物显式交付工具（`tool-present`）与 Git 工作区变更追踪看板（`workspace-changes`）。 |
| 其余 41 个子包 | TS, 约 4,000 文件 | 见清单 | 涵盖 acp, api, attachment, boot, bundle, client, context, core, credentials, experimental, fs, goal, guard, host, identity, mcp, plan, preset, sandbox, sdk, session, shell, skill, ssh, storage, subagent, subprocess, telemetry, terminal, todo, typert, util, web, workflow, workspace 等。 |

---

### 2. DeepSeek Harness 核心子系统与关键代码剖析

#### 1. 跨时区全周期 Temporal 调度领域模型
- **核心文件**：[`packages/schedule/schedule/src/domain.ts`](file:///home/yupeng/references/deepseek-harness/packages/schedule/schedule/src/domain.ts)（79.9KB，1,896行）。
- **核心机制**：
  - 覆盖完整调度语义原语：
    - `AfterSchedule`：相对延时触发；
    - `AtSchedule`：ISO 8601 绝对时间点与本地化时钟解析；
    - `EverySchedule`：定长间隔调度；
    - `CronSchedule`：标准 5 字段 Cron 表达式，内置 400 年格里高利历法闰年边界校验；
    - `DailySchedule` 与 `WeeklySchedule`：固定时点与工作日周期；
  - 严密的事件溯源持久化与崩溃重放游标计算，杜绝事件漏触。

#### 2. 原生 Office 公文双向转译管线 (Office-to-PDF)
- **核心文件**：[`packages/document/office-to-pdf/`](file:///home/yupeng/references/deepseek-harness/packages/document)（14.7KB）。
- **核心机制**：
  - 无头转译 Word（.docx）与 PPT（.pptx）为高精矢量 PDF，保真字体、印章、批示与版心；
  - 页面自动切片为超高分辨率位图投递至多模态视窗与 Visual Judge 核验门，实现红头公文多模态审计。

#### 3. 工具调用原子配对门禁 (Strict Tool Pairing)
- **核心文件**：[`packages/compaction/compaction/src/tool-pairing.ts`](file:///home/yupeng/references/deepseek-harness/packages/compaction/compaction/src/tool-pairing.ts)。
- **核心机制**：
  - 基于前缀和平衡算法对会话消息流执行原子校验：确保每个 `tool_use` 块必须且仅有一个相邻配对的 `tool_result`；
  - 在上下文紧缩或历史裁剪时绝不在配对中途切割，根除 API 400 异常。

#### 4. 超大输出中间修剪与磁盘 Spill 溢出
- **核心文件**：[`packages/compaction/compaction-tool-result-pruner/`](file:///home/yupeng/references/deepseek-harness/packages/compaction) 与 [`packages/spill/`](file:///home/yupeng/references/deepseek-harness/packages/spill)。
- **核心机制**：
  - 纯确定性 Unicode 码点切片：头 4096 字符 + 中间省略标记 + 尾 1024 字符，0 模型调用即时减压；
  - 超限大输出溢出落盘并返回 `spill://` 虚拟句柄，模型可按需 grep/read 磁盘文件。

---

## 六、 Pi Agent 全模块组件与核心逻辑深度透析 (极高性能与反应式模型)

### 1. 资产全景与工程拓扑
Pi Agent（`references/pi`，Earendil 系）是高并发算法与轻量响应式设计的代表，包含 11 个核心子包，以极致性能与纯 TS 数据结构著称。

| 模块路径 | 语言与代码量 | 对应包名 | 核心职责与设计原理 |
|---|---|---|---|
| [`packages/chord`](file:///home/yupeng/references/pi/packages/chord) | TS, 87文件, 2.98万行 | `@earendil-works/chord` | 反应式状态追踪与流式输出缓冲。包含片段表与平衡树堆零拷贝 JSON Delta 追踪器（`delta/tracker.ts` 79.8KB，2239行）与 50ms 缓动提交缓冲器。 |
| [`packages/durable`](file:///home/yupeng/references/pi/packages/durable) | TS, 196文件, 6.38万行 | `@earendil-works/pi-durable` | 进程崩溃自愈持久化调度器（`scheduler.ts` 84.6KB，1953行）。通过 Checkpoint 事务落盘与游标扫描实现断电无损自愈续跑。 |
| [`packages/coding-agent`](file:///home/yupeng/references/pi/packages/coding-agent) | TS, 673文件, 16.48万行 | `@earendil-works/pi-coding-agent` | 编码智能体主程序。包含 Prompt 缓存 1-token 脉冲保活（`cache-warmer.ts` 16.8KB）、外部编辑器桥接（`external-editor.ts`）与独立 HTML 报告生成器（`export-html`）。 |
| [`packages/evals`](file:///home/yupeng/references/pi/packages/evals) | TS, 23文件, 3,329行 | `@earendil-works/pi-evals` | 确定性无头 Agent 评测套件（`harness.ts` 20.6KB）与量化打分看板（`report.ts` 19KB）。 |
| [`packages/codemode`](file:///home/yupeng/references/pi/packages/codemode) | TS, 28文件, 5,237行 | `@earendil-works/pi-codemode` | 零依赖 `node:vm` 内存执行沙箱（`vm.ts` 13.9KB, `execution.ts` 21.9KB）。毫秒级进行数据转换与数学精算。 |
| [`packages/mcp`](file:///home/yupeng/references/pi/packages/mcp) | TS, 25文件, 4,895行 | `@earendil-works/pi-mcp` | 纯白盒 MCP 客户端（`client.ts` 21KB）。支持 Stdio 与 Streamable HTTP 双通道。 |
| [`packages/ai`](file:///home/yupeng/references/pi/packages/ai) | TS, 391文件, 7.51万行 | `@earendil-works/pi-ai` | 统一多模型 LLM 抽象层与自动发现机制。 |
| [`packages/tui`](file:///home/yupeng/references/pi/packages/tui) | TS, 97文件, 3.97万行 | `@earendil-works/pi-tui` | 终端 UI 与状态栏 HUD 组件库（`program-status.ts`）。 |
| 其余 3 个子包 | TS, 共 41 文件 | 见清单 | `agent` (核心契约), `env` (远程执行环境守护), `telemetry` (遥测模式)。 |

---

### 2. Pi Agent 核心子系统与关键代码剖析

#### 1. 反应式结构化 JSON Delta 状态追踪器 (Treap Delta Tracker)
- **核心文件**：[`packages/chord/src/delta/tracker.ts`](file:///home/yupeng/references/pi/packages/chord/src/delta/tracker.ts)（79.8KB，2,239行纯 TS 代码）。
- **核心机制**：
  - 基于纯 TypeScript 片段表（Piece Table）、树堆平衡结构（Treap）与紧凑位图（Bitset），实现大状态树的零拷贝不可变更新；
  - 实时计算 RFC 6902 JSON Patch 极简 Delta 流（add/remove/replace），消除高频重绘时的全量树 JSON 序列化 CPU 暴击。

#### 2. 进程崩溃自愈持久化调度器与 Actor 状态机
- **核心文件**：[`packages/durable/src/harness/scheduler.ts`](file:///home/yupeng/references/pi/packages/durable/src/harness/scheduler.ts)（84.6KB，1,953行）与 [`types.ts`](file:///home/yupeng/references/pi/packages/durable/src/types.ts)（46.7KB）。
- **核心机制**：
  - 工作流状态迁移通过原子事务写入 `storage.tasks`；
  - 进程重启时以分页游标（`SCAN_PAGE_SIZE = 256`）扫描未完结任务并自动拉起 Actor 状态机续跑；
  - `MAX_TIMER_DELAY` 分片防止 32 位定时器整数溢出，支撑数天跨度的长任务。

#### 3. 确定性无头 Agent 评测套件与基准打分引擎
- **核心文件**：[`packages/evals/src/harness.ts`](file:///home/yupeng/references/pi/packages/evals/src/harness.ts)（20.6KB）与 [`report.ts`](file:///home/yupeng/references/pi/packages/evals/src/report.ts)（19KB）。
- **核心机制**：
  - 纯命令行端到端评测运行套件，支持虚拟沙箱目录与 Mock 夹具；
  - 全自动回放标准测试用例集（`suite-cases/`），自动输出量化打分看板（通过率、时延分布、Token 开销、缓存命中率）。

#### 4. 主动式 Prompt KV 缓存保活看门狗 (Cache Warmer)
- **核心文件**：[`packages/coding-agent/src/core/cache-warmer.ts`](file:///home/yupeng/references/pi/packages/coding-agent/src/core/cache-warmer.ts)（16.8KB）与 [`cache-stats.ts`](file:///home/yupeng/references/pi/packages/coding-agent/src/core/cache-stats.ts)（6.6KB）。
- **核心机制**：
  - 预测服务端 KV 缓存生存时间（TTL），在达到 90% 水位时主动发射 1-token 极简脉冲请求；
  - 维持服务端显存缓存有效，消灭用户思考间隙的缓存失效，节约 80% 重复输入成本。

---

## 七、 五大标杆核心功能与组件跨项目速查字典 (Developer Quick Lookup Matrix)

开发智能体在实现或排查特定能力时，**严禁重新全盘扫描代码**，直接查阅下表：

| 功能大类 | 细分能力特性 | 首选最佳开源轮子与源码锚点 | 备选参考轮子与源码锚点 | 核心实现机制与开发提示 |
|---|---|---|---|---|
| **配置系统** | 三级 TOML 配置与保留注释回写 | [`kimi-code/packages/agent-core-v2/src/app/config/configService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/app/config/configService.ts) (1,025行)<br>[`tomlWriteback.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/app/config/tomlWriteback.ts) | [`pi/packages/coding-agent/src/core/settings-manager.ts`](file:///home/yupeng/references/pi/packages/coding-agent/src/core/settings-manager.ts)<br>[`deepseek-harness/packages/settings/settings/src/redact.ts`](file:///home/yupeng/references/deepseek-harness/packages/settings/settings/src/redact.ts) | 采用 smol-toml 语法树保留用户手写注释；结合 DHS redactSecrets 脱敏；支持 /config 面板与 /reload 免重启。 |
| **认证与专线** | 智谱 BigModel 双轨特权认证与错峰调度 | [`zcode/apps/zcode-cli/packages/adapters/src/model/off-peak-request-auth.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters/src/model/off-peak-request-auth.ts)<br>[`packages/services/src/session/offPeakTaskService.ts`](file:///home/yupeng/references/zcode/packages/services/src/session/offPeakTaskService.ts) (26KB, 681行) | [`zcode/packages/services/src/highspeed/highspeedCardService.ts`](file:///home/yupeng/references/zcode/packages/services/src/highspeed/highspeedCardService.ts) (383行) | PKCE 轮询换票；X-Coding-Plan-Api-Key 专线标头；完整错峰排队状态机（1~3折）；免费高速卡抽卡。 |
| **会话与撤销** | Append-only JSONL 会话分叉树与时光回滚 | [`zcode/apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/session-fork.ts) (53KB)<br>[`file-rewind.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts) (21KB) | [`kimi-code/packages/agent-core-v2/src/agent/undo/undoService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/undo/undoService.ts) (10.5KB)<br>[`fileHistoryService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/fileHistory/fileHistoryService.ts) (24.8KB) | 基于 parentSessionId 维护分叉树；逆向补丁恢复物理文件；配合 Kimi 写前快照与 computeUndoCut 级联撤销。 |
| **并发与队列** | 双边界会话待办收件箱与门铃协调器 | [`opencode/packages/core/src/session/inbox.ts`](file:///home/yupeng/references/opencode/packages/core/src/session/inbox.ts) (18.7KB)<br>[`run-coordinator.ts`](file:///home/yupeng/references/opencode/packages/core/src/session/run-coordinator.ts) (9KB) | [`zcode/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts) | 严格区分 steer 步内纠偏与 input 空闲排队；原子门铃 pendingWake 消除排空与空闲过渡死锁。 |
| **阴影回放** | 黄金会话轨迹录制与脱机非回归校验 | [`zcode/apps/zcode-cli/tools/prompt-trajectory/record.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/tools/prompt-trajectory/record.ts) (11.6KB)<br>[`scripts/shadow-replay.mjs`](file:///home/yupeng/references/zcode/apps/zcode-cli/scripts/shadow-replay.mjs) (10.8KB) | [`pi/packages/evals/src/harness.ts`](file:///home/yupeng/references/pi/packages/evals/src/harness.ts) (20.6KB) | 录制 Golden Trajectory 快照；沙箱存根接管工具；0 API 开销与 0 真实副作用下校验决策一致性。 |
| **缓存优化** | 4 级 KV 缓存断点编排与脉冲保活 | [`opencode/packages/ai/src/cache-policy.ts`](file:///home/yupeng/references/opencode/packages/ai/src/cache-policy.ts) (8.7KB)<br>[`effort-updates.ts`](file:///home/yupeng/references/opencode/packages/ai/src/effort-updates.ts) | [`pi/packages/coding-agent/src/core/cache-warmer.ts`](file:///home/yupeng/references/pi/packages/coding-agent/src/core/cache-warmer.ts) (16.8KB)<br>[`zcode/apps/zcode-cli/packages/core/src/context/builder.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/context/builder.ts) | 4 级断点硬预算算法；推理开销动态追加而不改历史前缀；90% TTL 发射 1-token 脉冲防缓存失效。 |
| **Shell 安全** | 纯 TS 确定性 Shell 词法扫描与 eval 阻断 | [`opencode/packages/core/src/shell/scan.ts`](file:///home/yupeng/references/opencode/packages/core/src/shell/scan.ts) (97.8KB, 2,410行纯 TS) | [`kimi-code/packages/tree-sitter-bash/`](file:///home/yupeng/references/kimi-code/packages/tree-sitter-bash/)<br>[`zcode/apps/zcode-cli/packages/adapters/src/exec/bash-output-policy.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/adapters/src/exec/bash-output-policy.ts) | 纯状态机逐字符解析复合命令/管道/Heredoc；动态 eval 判为 opaque 阻断提级；64KB 输出截断保护。 |
| **工具排重** | 规范哈希工具排重器与三阶反驳打断门 | [`kimi-code/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/toolDedupe/toolDedupeService.ts) (19.3KB, 588行) | [`deepseek-harness/packages/core/`](file:///home/yupeng/references/deepseek-harness/packages/core/) | 参数递归排序计算 SHA-256 哈希回显缓存；三阶打断门（预期陈述 -> 证伪检查 -> 强制直出）消灭死循环。 |
| **任务调度** | Temporal 全周期调度引擎与持久化重放 | [`deepseek-harness/packages/schedule/schedule/src/domain.ts`](file:///home/yupeng/references/deepseek-harness/packages/schedule/schedule/src/domain.ts) (79.9KB, 1,896行) | [`kimi-code/packages/agent-core-v2/src/features/cron/cronService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/cron/cronService.ts) (593行) | After/At/Every/Cron(400年公历闰年)/Daily/Weekly 全原语；事件溯源持久化；重启游标自愈消灭漏触。 |
| **崩溃自愈** | 进程崩溃 Checkpoint 持久化调度与 Actor | [`pi/packages/durable/src/harness/scheduler.ts`](file:///home/yupeng/references/pi/packages/durable/src/harness/scheduler.ts) (84.6KB, 1,953行)<br>[`types.ts`](file:///home/yupeng/references/pi/packages/durable/src/types.ts) (46.7KB) | [`zcode/apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts) (36KB) | 状态迁移事务落盘至 storage.tasks；重启分页扫描（256条）恢复 Actor；MAX_TIMER_DELAY 防止定时器溢出。 |
| **中断自愈** | 中断恢复事实注入器与跨午夜日期感知器 | [`kimi-code/packages/agent-core-v2/src/agent/interruptionReminder/interruptionReminderService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/interruptionReminder/interruptionReminderService.ts) (2.8KB)<br>[`features/dateChange/`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/dateChange/) (6KB) | [`opencode/packages/ai/src/tool-history.ts`](file:///home/yupeng/references/opencode/packages/ai/src/tool-history.ts) (3.5KB) | Ctrl+C 中断后注入规范上下文事实提醒，消除道歉幻觉；跨 00:00 自动注入 date_change，纠正时间基线。 |
| **紧缩与配对** | 工具配对门禁、图像卸载与磁盘溢出 | [`deepseek-harness/packages/compaction/compaction/src/tool-pairing.ts`](file:///home/yupeng/references/deepseek-harness/packages/compaction/compaction/src/tool-pairing.ts)<br>[`packages/spill/`](file:///home/yupeng/references/deepseek-harness/packages/spill/) | [`zcode/apps/zcode-cli/packages/core/src/compact/microcompact.ts`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/compact/microcompact.ts) (9.3KB)<br>[`kimi-code/packages/agent-core-v2/src/agent/fullCompaction/contextRecovery.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/agent/fullCompaction/contextRecovery.ts) | 前缀和平衡算法杜绝配对中断 400；图像标记卸载换为占位符；超限输出磁盘 Spill；注入回溯日志指针。 |
| **公文转译** | 原生 Word/PPT 转矢量 PDF 与视觉审计 | [`deepseek-harness/packages/document/office-to-pdf/`](file:///home/yupeng/references/deepseek-harness/packages/document) (14.7KB)<br>LibreOffice Headless | [`zcode/apps/zcode-cli/packages/spreadsheets-plugin/agents/visual-judge.md`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/spreadsheets-plugin/agents/visual-judge.md) | Word/PPT 毫秒级转换为标准矢量 PDF；页面高精切片投递视觉视窗与 Visual Judge 核验门，保真公文排版。 |
| **网页抽取** | SAX 状态机流式 HTML 转 Markdown | [`opencode/packages/core/src/tool/html-markdown.ts`](file:///home/yupeng/references/opencode/packages/core/src/tool/html-markdown.ts) (21.7KB, 659行) | 系统无头浏览器 | 纯 TS htmlparser2 流式解析，常驻内存 5MB 以内，毫秒级表格重构与列表嵌套，5MB 保护截断防 OOM。 |
| **状态追踪** | 反应式片段表与 Treap 零拷贝 JSON Delta | [`pi/packages/chord/src/delta/tracker.ts`](file:///home/yupeng/references/pi/packages/chord/src/delta/tracker.ts) (79.8KB, 2,239行) | [`kimi-code/packages/transcript/`](file:///home/yupeng/references/kimi-code/packages/transcript/) | Piece Table + Treap 树堆不可变差分追踪；实时计算 RFC 6902 JSON Patch 流，消除全量树刷新 CPU 暴击。 |
| **终端图表** | 终端 Mermaid 原生 ASCII/Unicode 渲染 | [`opencode/packages/merman/`](file:///home/yupeng/references/opencode/packages/merman) (89个源码文件)<br>[`markdown.ts`](file:///home/yupeng/references/opencode/packages/merman/src/markdown.ts) (12.4KB) | 外部 Web 渲染 | 在终端字符画布上绘制流程图/时序图/甘特图；自适应 120 列换行折叠与 ANSI 调色板映射。 |
| **无头评测** | 确定性端到端评测套件与量化看板 | [`pi/packages/evals/src/harness.ts`](file:///home/yupeng/references/pi/packages/evals/src/harness.ts) (20.6KB)<br>[`report.ts`](file:///home/yupeng/references/pi/packages/evals/src/report.ts) (19KB) | [`deepseek-harness/benchmarks/`](file:///home/yupeng/references/deepseek-harness/benchmarks/) | 纯命令行评测执行器；沙箱与 Mock 夹具；自动回放标准研报与财报套件；输出多维量化打分看板。 |
| **多 Agent 协同** | 物理 Worktree 隔离与并发蜂群调度 | [`kimi-code/packages/agent-core-v2/src/features/tower/towerService.ts`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/tower/towerService.ts) (36.7KB)<br>[`features/swarm/`](file:///home/yupeng/references/kimi-code/packages/agent-core-v2/src/features/swarm/) (65KB) | [`zcode/apps/zcode-cli/packages/superpowers-plugin/skills/using-git-worktrees/SKILL.md`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/superpowers-plugin/skills/using-git-worktrees/SKILL.md)<br>[`zcode/apps/zcode-cli/packages/core/src/subagent/`](file:///home/yupeng/references/zcode/apps/zcode-cli/packages/core/src/subagent/) | Git Worktree 物理分支隔离；.tower/comms/ 信令总线；Merge Gate 审查门禁；Prompt 模板动态扇出蜂群。 |
