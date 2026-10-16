# raw CLI Agent 架构全景调研与细颗粒度设计蓝图 (Architecture Research & Detailed Blueprint)

> 本文档是 `raw` 项目（`bpfio/raw`）的权威架构调研与技术设计报告，基于对 **Pi Agent**、**zcode-app-cli**、**ZCode 官方开源仓库 (`zai-org/ZCode`)**、**DeepSeek Harness (`deepcode-cli`)** 与 **OpenCode (`opencode.ai`)** 的全量代码分析，确立了项目的核心设计原则、防幻觉机制、**A2A 跨智能体协议规范**、**完整 MCP 兼容引擎** 与五阶段工程落地蓝图。
> 同步归档于 Logbook 知识中枢：`project: "raw"`, `research_id: 24`。

---

## 一、 调研背景与使命定位

在政策调研与数据分析场景中，传统的通用 Coding Agent 常常面临三大结构性缺陷：
1. **安全性与黑盒困境**：许多轻量工具采用二进制混淆包或依赖多层脆弱的 AST 补丁，代码无法白盒审计，存在供应链投毒与未授权数据外泄（Telemetry）风险；
2. **幻觉率与执行力脱节**：同为先进模型，在不同脚手架（Harness）下表现天差地别——缺乏严格闭环约束的 Agent 常常产生严重幻觉（捏造数据、指标前后矛盾、虚构文件），而过度复杂的框架则陷入漫长的 IPC 延迟与上下文爆炸；
3. **协同隔离能力缺失**：单 Agent 面对几十页红头政策公报与海量财务报表时，上下文极易被中间提取过程冲刷殆尽，缺乏**多智能体（A2A）分工与独立沙箱机制**。

**`raw` 的使命**：
打造一个**100% 白盒开源、零数据外泄、极低幻觉、极高执行力**的现代化 Agent CLI。
- **双擎核心**：深度整合 **GLM**（敏捷信息流探针）与 **DeepSeek**（长链因果逻辑推演）；
- **主攻领域**：**政策深度调研**（条文比对、脉络追溯、博弈推演）与 **严密数据分析**（指标穿透、勾稽核验、产能良率事实审计）；
- **协议完备**：内置**工业级 MCP 客户端**（兼容 Stdio/SSE 远程与本地服务）与 **A2A 跨智能体通信协议**；
- **终端交互**：继承 `@earendil-works/pi-tui` 的无闪烁差分渲染与渐进折叠手感。

---

## 二、 五大标杆方案与开源架构深度剖析

本地已于 `~/references/` 建立了 4 大核心开源工程图纸库（`pi`、`zcode`、`deepcode`、`opencode`），经深度代码走读，提炼以下关键发现：

| 标杆项目 | 核心模块与代码走读 | 核心优势（精髓借鉴） | 关键局限与对抗成本 |
|---|---|---|---|
| **Pi Agent**<br>`@earendil-works/pi` | • `packages/agent/`: 状态机与上下文管理<br>• `packages/tui/`: 双缓冲差分渲染引擎<br>• `packages/mcp/`: 独立白盒 MCP 客户端<br>• `packages/coding-agent/`: 4 大原子工具 | • **极简主义哲学**：系统提示词压制在 1000 Token 内<br>• **错误作为一等公民**：抛异常自动转化为 `isError: true` 促使模型自愈<br>• 架构解耦：TUI 与内核彻底分离，依赖极少 | • 偏向单 Agent 通用编码，缺乏针对 DeepSeek-R1 思考流的特定处理与多智能体分流 |
| **ZCode 官方版**<br>`zai-org/ZCode` | • `packages/core/src/runtime/`: 工业级调度器<br>• `packages/core/src/subagent/`: 多智能体协调器<br>• `packages/spreadsheets-plugin/`: 表格计算<br>• `packages/pdf-plugin/`: 政策 PDF 结构化提取 | • **极低幻觉率**：经过数百万次调优的 System Prompt、Tool Schema 与先读后写门禁<br>• **金融级 Event Sourcing**：基于 SQLite 不可变事件流的会话恢复<br>• **开箱即用的专业数据/研报分析插件** | • 官方 CLI 前端采用 React+OpenTUI，较为臃肿且构建链庞大（巨石 Monorepo） |
| **zcode-app-cli**<br>`bpfio/raw` 前身 | • `runtime-tui-bridge.ts`: 进程内函数级桥接<br>• `runtime-sqlite-recovery.ts`: SQLite 并发自愈<br>• `bounded-tool-text.ts`: 64KB 工具输出有界保护<br>• `file-diff-budget.ts`: 2000 行 Diff 预算限制 | • **同进程零拷贝直连（Zero IPC）**：彻底消灭 Localhost Socket 延迟与重连断连隐患<br>• 极高的工程鲁棒性与内存防泄漏 | • **混淆二进制黑盒**（`vendor/zcode.cjs`），供应链不可审计<br>• 27 个 AST/字符串补丁在版本升级中极易漂移 |
| **DeepCode**<br>`lessweb/deepcode-cli` | • `packages/core/session.ts`: 会话状态机<br>• `packages/core/prompt.ts`: 提示词结构<br>• 支持 `thinkingEnabled` 与 `reasoningEffort` | • **原生适配 DeepSeek 系列**：深度适配 R1 思考流展示与参数调优<br>• 针对 DeepSeek 的 Prompt Cache 前缀优化与上下文压缩 | • 缺乏严格的沙箱隔离（Path Jail），代码中工具扩展体系较重 |
| **OpenCode**<br>`anomalyco/opencode` | • `packages/ai/`: 75+ 多模型统一适配<br>• `packages/protocol/`: 跨进程/跨端协议契约<br>• `packages/tui/`: 多会话并行终端界面 | • **极度开放自由**：多模型即插即用，分发体验极佳（一键安装）<br>• 双 Agent 模式（Build vs Plan/Explore）架构清晰 | • 为兼容 75+ 模型导致提示词采用“最大公约数”，对具体模型的调优深度不足，幻觉率高于 ZCode |

---

## 三、 A2A (Agent-to-Agent) 跨智能体协议规范

在数据分析与政策研判场景中，单 Agent 面对海量报表与长篇公报容易引发上下文污染与注意力涣散。`raw` 采用**层次化多智能体协调体系（Coordinator-Worker Architecture）**。

### 1. 跨智能体角色拓扑

```
                    ┌──────────────────────────────────────────────┐
                    │      主协调官 (Coordinator / Orchestrator)    │
                    │         (搭载 DeepSeek-R1，全局战略推演)       │
                    └───────┬──────────────┬──────────────┬────────┘
                            │              │              │
           ┌────────────────┘              │              └────────────────┐
           ▼                               ▼                               ▼
┌──────────────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
│  政策探针子智能体     │      │   数据审计子智能体   │      │   一致性审查子智能体 │
│  (Scout Subagent)    │      │  (Data Subagent)     │      │  (Audit Subagent)    │
│ (搭载 GLM-5.3 Flash) │      │  (搭载 DeepSeek-V3)  │      │ (搭载 DeepSeek-R1)   │
│ - 爬取部委公告与公报 │      │ - 执行 CSV/表格运算  │      │ - 交叉检验良率与产能 │
│ - 提取关键条文摘要   │      │ - 校验勾稽计算与偏差 │      │ - 审查因果逻辑矛盾   │
└──────────────────────┘      └──────────────────────┘      └──────────────────────┘
```

### 2. A2A 消息封套契约 (Message Envelope Specification)

所有 Agent 之间的通信均采用强类型 JSON-RPC 2.0 风格的不可变消息包：

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
  | "peer_query"            // 同级智能体之间的能力查询与数据借用
  | "user_escalation";      // 向上升级至用户人工介入确认
```

### 3. 子智能体上下文隔离沙箱 (Subagent Context Isolation)

* **独立事件流**：每个 Subagent 在启动时被分配完全独立的内存会话，享有专属的工具执行栈与临时上下文，**绝不污染主协调官的消息树**；
* **成果折叠收敛（Result Handoff）**：子智能体运行结束时，必须执行“蒸馏收敛”，仅将**最终结论、关键数据表格、引用的条文原话与可信度评分**打包进 `task_complete` 回传；
* **主协调官吸收**：主协调官仅在其消息历史中追加一条结构化摘要，子智能体执行过程中产生的成百上千行 `cat`、`grep`、网络抓取中间结果随子进程销毁而彻底丢弃。

### 4. 远程与跨节点邮箱整合 (Logbook Mailbox Bridge)

`raw` 的 A2A 体系原生对接 Logbook 知识中枢的异步消息队列：
- 当子任务耗时极长或涉及远程服务器任务时，自动通过 Logbook MCP 的 `agent_message_send` 发送至项目邮箱；
- 支持随时通过 `message_inbox` 接收来自其他节点（如 QNAP 上的自动化审计服务）的离线调研任务。

---

## 四、 完整 MCP (Model Context Protocol) 兼容架构

`raw` 内置完整的 MCP Client 子系统，既支持本地轻量工具，又无缝接驳远程私有工具中枢。

### 1. 传输层双通道驱动 (Dual-Channel Transports)

```
raw MCP Client Engine
  ├── StdioClientTransport (本地管道)
  │     ├── 基于 child_process.spawn 派生受控子进程
  │     ├── 进程看门狗 (Watchdog) 监控内存与心跳
  │     └── 管道关闭时自动注入 EOF，防止子进程僵尸驻留
  │
  └── SSEClientTransport (远程长连接)
        ├── 基于 EventSource 建立全双工流式下行通道
        ├── HTTP POST 异步发送 JSON-RPC 2.0 上行指令
        └── 专为 QNAP 生产环境 Logbook 服务 (192.168.1.68) 提供免密 SSH 管道穿透
```

### 2. 协议生命周期与动态挂载

1. **协议协商阶段 (Negotiation)**：
   - 发送 `initialize`（遵循 `2024-11-05` 规范），声明客户端能力（Capabilities：Roots, Sampling, Tools）；
   - 接收服务端初始化载荷并确认 `notifications/initialized`。
2. **三元要素动态发现**：
   - **`tools/list`**：拉取外部工具清单（如 Logbook 的 `task_query`, `devlog_record`，以及自研数据工具），自动合并至 Agent 的可用工具注册表中；
   - **`resources/list` & `resources/read`**：允许模型直接以 URI 形式读取本地或远程的上下文文件（如 `logbook://raw/tasks`）；
   - **`prompts/list` & `prompts/get`**：动态拉取预置的宏观政策分析提示词模版。
3. **安全参数前置审计 (Tool Preflight)**：
   - 外部 MCP 工具调用前，必须经过本地 Schema 校验；
   - 对外发出的入参进行路径越界（Path Jail）审查，防止外部工具越权读取宿主文件。

---

## 五、 核心设计原则 (Design Principles)

1. **状态所有权单一（Single State Owner）**：
   运行时（Runtime / Event Store）是唯一的单一事实源；TUI 界面坚决不维护独立状态副本，仅作为**纯投影（Projection）**被动响应事件。
2. **原子工具极简化（Minimalist Primitives）**：
   坚持 4 大通用原子工具（`read`, `write`, `edit`, `bash`）加上专为研判设计的轻量 `fetch`。工具契约越短越清晰，模型决策路径越短，幻觉率越低。
3. **同进程零拷贝直连（In-Process Direct Calls）**：
   Agent 内核与终端界面运行在同一个 Node/Bun 进程中，以内存事件与函数调用通信，消除任何 Localhost 跨进程网络开销。
4. **确定性验证闭环（Deterministic Closed-Loop）**：
   先读后写（Read-before-Write）、执行后检查真实状态码、编辑输出结构化 Diff。

---

## 六、 如何防止幻觉？（防幻觉工程体系）

针对数据分析与政策研判场景，构建五重防幻觉闭环机制：

1. **信息流完整性与有界截断（Bounded IO）**：
   - 工具输出超过 64KB 时，保留稳定的头部与滚动尾部，绝不断裂 JSON 语法闭合，防止模型因信息缺失而凭概率补全。
2. **真实退出码与错误反馈（Error as Feedback）**：
   - 执行出错必须返回真实 Stderr，转化为 `isError: true` 错误块，迫使模型感知失败并自我修正。
3. **DeepSeek 思考流生命周期隔离（CoT Stripping）**：
   - **单轮可见，多轮剥离**：DeepSeek-R1 的思考流在当次输出时实时在终端以折叠脉冲展示；但在生成历史记录推入下一轮上下文前，**强制剥离上一轮的 `reasoning_content`**，彻底根除 R1 陷入递归自我模仿循环的问题。
4. **拒绝 Few-Shot 模板过载（Zero-Shot 纯净纪律）**：
   - 保持提示词精炼、静态、高信噪比，消除自相矛盾的要求。
5. **证据一致性审查门（Evidence Consistency Gate）**：
   - **0/1 与 1-100 维度分离**：严格区分“有无”与“水平高低”（例如：引用良率数据即等于承认主体具备产线与产能，严禁用良率低推导无产能）；
   - **数据对账自检**：在分析多方宏观数据时，强制模型输出数据勾稽对照，发现矛盾必须显式汇报。

---

## 七、 如何提高执行效率与吞吐？（极速调优方案）

1. **KV Cache / Prompt Caching 前缀锁定**：
   - 将不变的 System Prompt、A2A 契约与 Tool Schemas 置于消息数组最前端，保持字节级静态；
   - 确保大模型服务端 **KV Cache 命中率维持在 80% 以上**，首字延迟（TTFT）压制在 300 毫秒以内。
2. **GLM + DeepSeek 快慢双擎流水线**：
   - **快通道（GLM-5.3 Flash / Plus）**：高速抓取长篇政策公报、清洗表格 CSV，吞吐量大、响应敏捷；
   - **慢通道（DeepSeek-R1 / V3）**：当且仅当需要深入推演因果逻辑、对账审计时触发，快慢解耦。
3. **终端差分双缓冲渲染**：
   - 仅对变动的终端字符矩阵输出 ANSI Escape 码，CPU 占用低于 1%，流式输出不闪烁。

---

## 八、 细颗粒度工程落地方案（五大核心包设计）

项目采用现代化 TypeScript + Bun Monorepo 架构（收敛至 `packages/`），彻底摆脱对混淆二进制的依赖：

```text
packages/
├── core/                  # 状态机内核与 Agent Loop (基于 pi-agent-core 精髓)
│   ├── src/
│   │   ├── agent.ts       # 核心循环状态机 (Planning -> Tool -> Reflection)
│   │   ├── history.ts     # 消息历史管理与 CoT 思考流自动切除
│   │   ├── session.ts     # SQLite / JSONL 会话事件持久化
│   │   └── sandbox.ts     # Path Jail 路径越界校验器
│
├── mcp/                   # 工业级 MCP 客户端引擎 (借鉴 Pi MCP Client)
│   ├── src/
│   │   ├── client.ts      # JSON-RPC 2.0 客户端实现
│   │   ├── stdio.ts       # 本地子进程 Stdio 管道与看门狗
│   │   ├── sse.ts         # 远程 SSE/HTTP 连接器
│   │   └── registry.ts    # 动态工具与资源聚合注册表
│
├── a2a/                   # A2A 跨智能体协议中枢 (借鉴 ZCode subagent)
│   ├── src/
│   │   ├── coordinator.ts # 主协调官调度状态机
│   │   ├── subagent.ts    # 隔离子智能体运行沙箱
│   │   ├── envelope.ts    # 强类型消息封套与序列化
│   │   └── mailbox.ts     # 异步收件箱与 Logbook 桥接
│
├── tui/                   # 终端交互层 (基于 @earendil-works/pi-tui)
│   ├── src/
│   │   ├── app.ts         # TUI 主生命周期与差分渲染循环
│   │   ├── thinking.ts    # R1 思考流动态收起/展开折叠卡片
│   │   ├── subagent-view.ts# A2A 多子智能体并行执行看板
│   │   └── diff-view.ts   # 结构化代码/条文变更对比视图
│
└── plugins/               # 政策与数据专业分析插件 (借鉴 ZCode plugins)
    ├── src/
    │   ├── spreadsheets.ts# CSV / Excel 结构化表格勾稽计算探针
    │   ├── pdf-extractor.ts# 长篇政策文件与研报章节提取
    │   └── audit-rules.ts # 证据一致性与数据矛盾自检规则
```

---

## 九、 raw 项目演进里程碑 (Milestones)

```
[Phase 1] 白盒内核与安全沙箱 (Days 1~3)
  ├── 初始化 packages/core，编写纯白盒 Agent Loop
  ├── 接入 GLM 与 DeepSeek 统一 SSE 流式驱动
  └── 落地带 Path Jail 的 4 大原子工具 (read/write/edit/bash)

[Phase 2] 完整 MCP 兼容引擎 (Days 4~5)
  ├── 实现 packages/mcp，支持 Stdio 与 SSE 双传输通道
  ├── 实测接驳 QNAP 远程 Logbook MCP 服务
  └── 实现外部工具动态注册与参数 Preflight 防御

[Phase 3] A2A 跨智能体协议与分流 (Days 6~8)
  ├── 实现 packages/a2a 协调器与子智能体隔离沙箱
  ├── 实现 Coordinator(R1) -> Scout(GLM) -> Auditor 任务流水线
  └── 落地结构化成果收敛 (Result Handoff) 机制

[Phase 4] 专业研报/数据插件与防幻觉门禁 (Days 9~10)
  ├── 移植表格计算与 PDF 结构化分析核心
  ├── 落实多轮思考流剥离 (CoT Stripping) 与 KV Cache 优化
  └── 接入数据一致性自检门禁

[Phase 5] Pi-TUI 差分终端与正式交付 (Days 11~14)
  ├── 接入 @earendil-works/pi-tui 差分渲染界面
  ├── 挂载 A2A 子任务看板与思考流折叠视图
  └── 端到端宏观政策与数据审计实战验收，发布 bpfio/raw v1.0
```
