# bi CLI Agent 工程研发与落地执行计划 (devplan.md)

> **版本**：v1.1 (正式立项版)  
> **项目**：`bi` (`bpfio/bi`)  
> **定位**：100% 白盒开源、零数据外泄、极低幻觉、极高并发执行力的现代化政策深度调研与商业智能（BI）终端 Agent CLI。  
> **基石**：**单模型全自洽即插即用（Single-Model First）+ Python 沙箱代码运行即验（Code-backed Grounding）**。  
> **单一事实源 (SSOT)**：本文档是 `bi` 项目全生命周期的工程执行纲领与技术决策总纲。所有参与开发的 Agent 必须以此为顶层依据开展自主决策与代码施工。  
> **Logbook 知识底账**：`project: "bi"`，研发批次：`BI-DEVPLAN-2026-10-16`。

---

## 一、 整体开发提纲与框架 (Architecture & Decision Framework)

### 1. 核心包职责划分与依赖拓扑 (Package Topology)

整个工程收敛在 TypeScript + Bun Monorepo 体系（位于 `packages/` 与 `presets/`），层级严格单向依赖，杜绝循环引用：

```
┌────────────────────────────────────────────────────────────────────────┐
│                              终端展现层                                 │
│      packages/tui (基于 @earendil-works/pi-tui 双缓冲差分渲染)          │
│      ├── HUD 状态栏 (Token/Cache/延迟)   ├── Unified Diff 交互审查门    │
│      └── 动态折叠卡片 (R1思考流/子任务)   └── /doctor 全链路健康体检引擎 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 调用
┌───────────────────────────────────▼────────────────────────────────────┐
│                             跨网协作与编排层                            │
│  packages/a2a (分布式 A2A 协议)      packages/workflow (声明式 DAG 引擎) │
│  ├── a2a-email-gateway (私密信令)   ├── DAG 拓扑依赖解析器             │
│  ├── github-a2a-hub (PR 任务交付)    ├── Checkpoint 检查点持久化与自愈  │
│  └── blackboard (共享事实黑板)       └── 运行即验代码审计闭环 (audit.ts) │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ 调用                            │ 调用
┌──────────────────▼─────────────────────────────────▼───────────────────┐
│                             执行与隔离沙箱层                            │
│  packages/worktree (Git 物理隔离)    packages/mcp (标准 MCP 客户端)    │
│  ├── ~/.bi/worktrees/<id> 临时沙箱   ├── StdioClientTransport (本地管道)│
│  └── 独立分支挂载与零污染擦除        └── SseClientTransport (远程直连)  │
└──────────────────┬─────────────────────────────────┬───────────────────┘
                   │ 调用                            │ 调用
┌──────────────────▼─────────────────────────────────▼───────────────────┐
│                             状态机与内核基础层                          │
│                          packages/core                                 │
│  ├── agent.ts (核心循环与二段式抢占) ├── context/ (三层上下文水位与紧缩)│
│  ├── session/ (UUIDv7 DAG 会话引擎)  ├── prompt.ts (Prompt Cache 排布)  │
│  ├── auth/ (智谱双轨特权认证/PAT换票)├── sandbox/ (Path Jail 凭据防御)  │
│  └── tools/bash.ts (Linux PGID 熔断) └── parser.ts (Fuzzy 容错解析器)   │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 2. 七大标杆能力全景吸收规范 (Benchmark Synthesis)

任何开发 Agent 在实现具体模块时，必须对齐以下七大标杆的最优实践：

| 标杆工程 | 吸收模块与落位 | 核心实现机制与代码契约 |
|---|---|---|
| **清华 ZCode** | `packages/core/src/tool/edit-matchers.ts`<br>`packages/core/src/tool/read-file-state.ts`<br>`packages/core/src/memory/dream.ts`<br>`presets/plugins/superpowers/` | 1. **8 级阶梯弹性文件匹配**：自动归一化中英弯引号、剥离行号前缀、弹性缩进、相似度块锚点（0.8），彻底消灭 TargetContent 找不到的痛点，编辑成功率提升至 99.5%；<br>2. **Read-Before-Write 门禁与 mtime 防脏写**：未读文件禁止修改，基于真实 mtime 检测外部进程改动并拦截 stale write；<br>3. **Dream Cycle 仿生记忆沉淀**：后台空闲期基于文件锁自动提炼会话精华为长期记忆；<br>4. **清华顶级 Agent SOP**：吸收 `using-git-worktrees` 与 `verification-before-completion` 强制自验纪律。 |
| **清华系 Kimi Code** | `packages/tree-sitter-bash/`<br>`packages/agent-core-v2/src/agent/toolExecutor/`<br>`packages/minidb/`<br>`packages/agent-core-v2/src/agent/media/`<br>`packages/acp-server/` | 1. **纯 TS Tree-sitter Bash 语法分析**：0 原生 C 依赖，50k 节点 / 50ms 超时熔断，语法树级免疫命令注入与越界窃密；<br>2. **细粒度 RWLock 调度矩阵**：只读并发、写操作按路径串行互斥、全局写设立屏障；<br>3. **纯 TS LSM-Tree 存储 (MiniDB)**：零 C 编译依赖，免疫 SQLite 锁死与动态链接缺失；<br>4. **端侧媒体压缩**：自动降采样与质量压缩（< 25KB），防止 Token 撑爆；<br>5. **ACP 标准服务端**：标准 JSON-RPC 开放协议直连现代 IDE。 |
| **Claude Code** | `packages/core/src/prompt.ts`<br>`packages/core/src/agent.ts`<br>`packages/core/src/tools/bash.ts` | 1. **Prompt Cache 黄金排布**：严格遵循 `[静态 System + BI.md] → [静态 Tools] → [Anchor] → [历史消息]` 顺序，保证 GLM/DeepSeek 缓存命中率 ≥ 85%；<br>2. **二段式抢占取消**：单击 Esc / Ctrl+C 暂停并保留上下文，连续双击才退出；<br>3. **Linux PGID 组杀**：子进程派生独立 `setsid()`，超时发射 `-PGID` 信号彻底杀绝孤儿进程。 |
| **OpenAI Codex** | `packages/core/src/sandbox/path-jail.ts`<br>`packages/tui/src/diff-view.ts` | 1. **Credential Guard 凭据防御**：严禁模型读取 `~/.ssh`、`~/.bash_history`、`.env` 等高危路径；<br>2. **交互式 Unified Diff**：对所有文件修改在终端高亮渲染 Diff，人类敲击 `y/n` 审查门放行。 |
| **Qwen CLI** | `packages/core/src/parser.ts`<br>`packages/a2a/src/audit.ts` | 1. **Fuzzy Tool Parser**：模型输出的工具 JSON 遇到缺少括号或包裹在 Markdown 中时，自动进行 AST/正则容错修补；<br>2. **Self-Healing Traceback**：Python 脚本报错时自动捕获堆栈回溯，模型自主打补丁重试，杜绝求助人类。 |
| **Pi Agent** | `packages/core/src/session/`<br>`packages/core/src/context/`<br>`packages/tui/` | 1. **UUIDv7 DAG 树状会话**：节点带 `id` 与 `parentId`，天然支持 `/rewind` 与 `/fork` 平行分支；<br>2. **CompactionEntry 抽象**：记录 `summary`、`tokensBefore` 与 `readFiles/modifiedFiles`；<br>3. **`pi-tui` 差分渲染**：纯 ANSI 矩阵差分计算，终端 0 闪烁，CPU < 1%。 |
| **OpenCode** | `packages/core/src/model-router.ts`<br>`scripts/build-bin.ts` | 1. **统一模型适配器总线**：标准 SSE 事件分发，解耦物理模型差异；<br>2. **Bun Compile 原生打包**：一键生成 Linux/macOS 独立二进制 `bi`，用户免装 Node.js/Bun。 |

---

### 3. 开发智能体（Agent）自主决策树与不可违背红线

当开发 Agent 在实现或重构过程中面临技术分歧时，必须严格执行以下决策逻辑：

```
[分歧场景 1: 模型选择与调用]
  ├─ 必须坚持单模型自洽 (Single-Model First)！
  ├─ 严禁在代码中写死“必须同时调 GLM 和 DeepSeek 才能工作”的逻辑；
  └─ 任何角色（Scout/Auditor/Reporter）必须默认绑定到用户当前配置的单一主力模型。

[分歧场景 2: 政策与数据防幻觉]
  ├─ 严禁依靠大模型在 Prompt 里口算数值（良率、同比、财务勾稽）！
  └─ 必须调用 Python 运行真实脚本，以终端输出（Stdout）作为进入事实黑板的唯一依据。

[分歧场景 3: 上下文长度与压缩]
  ├─ 单次工具输出 > 64KB？立即调用 BoundedToolText 保留头尾 200 行并在中间截断！
  ├─ 当前上下文水位 >= 80%？立即挂起任务，调用 Summarizer 生成 CompactionEntry 重置视窗！
  └─ 底层磁盘 JSONL 必须 Append-only，绝对禁止物理删除任何历史记录！

[分歧场景 4: 跨网络协作]
  ├─ 需要跨越 NAT / 防火墙进行轻量控制？走 A2A 邮件私密信令网关 (a2a-email-gateway)！
  └─ 需要交付复杂代码、数据表与大篇幅研报？走 GitHub A2A 任务中枢 (github-a2a-hub) 的 PR 审查门！

[分歧场景 5: 跨网 A2A 鉴权与安全防御]
  ├─ 任何跨网络 A2A 封套必须经过 HMAC-SHA256 签名 + 5分钟时间戳防重放 + 发件人白名单校验！
  ├─ 严禁任何未经密码学验签的外部指令直接进入本地 Agent 执行流，彻底阻断远程代码执行 (RCE) 后门；
  ├─ 本地各角色严格受限：Scout 禁写、Auditor 仅限沙箱运行 Python 并由 Path Jail 阻断窃取凭据；
  └─ 高危动作（修改本地代码、合并主分支、执行 rm/kill 命令）无论来自何方，必须弹 Unified Diff 人类审查门！
```

---

## 二、 细颗粒度工程研发任务矩阵 (WBS)

### 【Phase 1】 白盒内核、沙箱、Prompt Cache 与官方双轨特权认证 (Days 1~3)
> 目标：打通核心 Agent 循环、会话树、凭据防御、Prompt Cache 与智谱官方双轨特权折扣通道。

| 任务编号 | 任务名称 | 责任模块 / 文件路径 | 细化设计与验收指标 | 优先级 |
|---|---|---|---|---|
| **BI-01** | Bun Monorepo 骨架与多包拓扑初始化 | 根目录配置<br>`package.json`, `tsconfig.json` | 1. 建立 `packages/{core, worktree, workflow, mcp, a2a, tui, plugins}` 与 `presets/`；<br>2. 配置 TypeScript 5.x 严格模式与 Bun 工作区链接；`bun test` 骨架跑通 | P1 |
| **BI-02** | 智谱 BigModel 官方双轨特权认证引擎 | `packages/core/src/auth/cli-oauth.ts`<br>`packages/core/src/auth/coding-plan-key.ts` | 1. **通道一**：OAuth 2.0 PKCE/Poll 状态机，生成 32 字节 PollToken 并唤醒浏览器，捕获 Project Access Token (PAT)；<br>2. **通道二**：API Key 二阶段换票器（换取 `token_use: "project_access"` 的短期 PAT）；<br>3. 凭据加密落盘于 `~/.bi/credentials.json` (0600 权限) | P0 |
| **BI-02.1** | Ultra VIP 专线路由与特权指纹标头注入 | `packages/core/src/gateway/ultra-gateway.ts`<br>`packages/core/src/gateway/fingerprint.ts` | 1. 请求标头注入 `X-Coding-Plan-Api-Key`、`User-Agent: zcode-cli/0.1.8`、`x-zcode-trace-id`；<br>2. 自动重定向至专线 `/api/v1/ultra/anthropic/v1/messages`；实测触发官方 Coding Plan 计费抵扣与客户端费率 | P0 |
| **BI-03** | Append-only JSONL 树状会话引擎 | `packages/core/src/session/manager.ts`<br>`packages/core/src/session/types.ts` | 1. 会话落盘至 `~/.bi/sessions/<id>.jsonl`，原子追加，抗机器掉电；<br>2. 每条记录携带 UUIDv7 `id` 与 `parentId`，天然支持分支与时光倒流；<br>3. 混合索引设计：支持 SQLite WAL 与纯 TS MiniDB (LSM-Tree) 双引擎，历史列表毫秒级检索，保证 Bun Compile 零 C 依赖打包 | P0 |
| **BI-03.1** | 会话时光倒流与物理文件差分回滚引擎 | `packages/core/src/session/file-rewind.ts` | 吸收清华核心算法：实现 `file-rewind.ts`（21KB）与 `workspace-checkpoints.ts`，基于 `diff` 逆向补丁与 SHA256 哈希校验，支持会话回退时工作区文件的物理级无损恢复与撤销 | P1 |
| **BI-04** | 单模型统一 SSE 流式驱动与插槽路由器 | `packages/core/src/model-router.ts`<br>`packages/core/src/drivers/sse-driver.ts` | 统一抽象 OpenAI / Anthropic SSE 事件流；实现 `ModelSlotRouter`，将逻辑语义插槽（`fast`, `reasoner`, `auditor`）默认解析映射至用户单一主力模型 | P1 |
| **BI-04.1** | Prompt Cache 黄金排布与 Fuzzy 工具解析器 | `packages/core/src/prompt.ts`<br>`packages/core/src/parser.ts` | 1. 严格锁定 `System + BI.md + Tools` 前缀顺序，确保服务端 Cache 命中率 ≥ 85%；<br>2. 引入 Qwen 风格容错解析器，对缺失闭合符或包裹代码块的畸形 JSON 自动 AST 修复 | P1 |
| **BI-05** | `BI.md` 项目长期记忆自适应注入器 | `packages/core/src/rules.ts` | 启动时自动向上递归检索当前工程根目录的 `BI.md` 或 `.bi/rules.md`，将政策信源、统计口径与禁用词静态注入 System Prompt 前缀 | P1 |
| **BI-05.1** | Dream Cycle 仿生做梦记忆沉淀中枢 | `packages/core/src/memory/dream.ts` | 借鉴清华认知神经科学设计：利用 `evaluateAutoDreamTiming` 与 `.consolidate-lock` 文件锁，在后台空闲期自动扫描会话精华，沉淀固化入项目级长期记忆 | P1 |
| **BI-06** | 受控 Bash 执行器与 Linux PGID 进程组看门狗 | `packages/core/src/tools/bash.ts` | 派生独立子进程并调用 `setsid()` 赋予独立 PGID；超时（默认 120s）或被取消时向 `-PGID` 发送 `SIGTERM → (等待1.5s) → SIGKILL`，彻底杜绝僵尸进程 | P0 |
| **BI-06.1** | Credential Guard 路径沙箱越界防御 (Path Jail) | `packages/core/src/sandbox/path-jail.ts` | 吸收 Codex 与 Kimi Code 纯 TS Tree-sitter Bash AST 解析器，在 50ms/50k 节点预算内完成语法树级安全扫描，严密拦截对 `~/.ssh`、`~/.gnupg`、`~/.bash_history`、`/etc/` 以及项目外 `.env` 文件的读取尝试与命令注入，违规直接阻断 | P0 |
| **BI-06.2** | 嵌入式原生快速搜索加速器 | `packages/core/src/sandbox/embedded-search.ts` | 吸收清华执行加速设计：透明注入 `embedded-search-prelude.ts`（7.3KB），将模型的 `find`/`grep` 命令透明劫持路由至预编译静态 `bfs` 与 `ugrep` 二进制，搜索性能提升 20 至 50 倍且自动过滤 .git 目录 | P1 |
| **BI-07** | 多工具并行流水线与二段式抢占取消状态机 | `packages/core/src/agent.ts` | 1. 吸收 Kimi Code 细粒度读写锁（RWLock）调度矩阵：只读工具安全并发（`Promise.all`），同文件写操作严格串行互斥（`fileAccessesOverlap`），全局操作设内存屏障；<br>2. 落地二段式取消：单击 Esc/Ctrl+C 暂停并保留上下文，连续双击才真正退出 | P1 |
| **BI-07.1** | 8 级阶梯弹性文件匹配引擎 | `packages/core/src/tool/edit-matchers.ts` | 吸收清华核心算法：实现 exact、quote_normalized（中英弯引号）、line_number_stripped、indentation_flexible 与 block_anchor（0.8 相似度）等 8 级阶梯匹配，消灭匹配失败 | P0 |
| **BI-07.2** | Read-Before-Write 门禁与 mtime 防脏写看门狗 | `packages/core/src/tool/read-file-state.ts` | 吸收清华防御机制：维护 `ReadFileStateMap`，未读文件严禁编辑修改；校验磁盘真实 `mtime`，一旦发生外部并发改动立即阻断并强制重新读取 | P0 |
| **BI-07.3** | 本地多角色子智能体分流引擎与上下文断路器 (Sub-agent Window Sandbox) | `packages/core/src/subagent/runner.ts`<br>`packages/core/src/subagent/profile.ts`<br>`packages/core/src/subagent/explore.ts` | 1. 落地模型可见工具 `Agent({ description, prompt, subagent_type, run_in_background })`；<br>2. 内建 `explore`（只读禁令、剔除编辑与递归，专职文件与代码扫盘）、`coder`（带编辑权限的实施专家）、`plan`（只读高阶规划）；<br>3. 视窗断路器机制：子 Agent 内部多轮探索与工具调用写入专属 `childSessionId`，主会话只追加最终汇总文本，从源头消灭长文本冲垮主视窗；<br>4. 借用 MCP 快照端口（`borrowed-mcp-port.ts`），子 Agent 退出不影响宿主 MCP 状态；<br>5. 剥离 `Agent` 与 `AskUserQuestion` 工具，彻底根除无限递归派生与非预期中断 | P0 |

---

### 【Phase 2】 全自动三层上下文管理与有界防护 (Days 4~5)
> 目标：彻底消灭长会话上下文撑爆（Context Exceeded）与内存泄漏，打造自愈型视窗。

| 任务编号 | 任务名称 | 责任模块 / 文件路径 | 细化设计与验收指标 | 优先级 |
|---|---|---|---|---|
| **BI-08** | 单次工具输出 64KB 有界截断与端侧媒体压缩保护 | `packages/core/src/context/bounded-tool-text.ts`<br>`packages/core/src/context/media-compress.ts` | 1. 限制单次工具输出上限 64,000 字符，超出时保留前 200 行与后 200 行，中间折叠并注入标记，完整输出存入沙箱磁盘日志；<br>2. 吸收 Kimi Code 端侧图片压缩管线（`image-compress.ts`），截图动态降采样至 25KB，杜绝多模态 Token 视窗瞬间撑爆 | P0 |
| **BI-09** | 历史工具输出自动脱水修剪器 (Pruner) | `packages/core/src/context/pruner.ts` | 自动将 5 轮之前的历史 `tool_result` 大文本脱水为单行摘要标记，Token 占用压减 60%~70%，完整保留 Assistant 决策意图 | P1 |
| **BI-10** | 80% 高水位静默自动紧缩器 (Auto-Compactor) | `packages/core/src/context/compactor.ts`<br>`packages/core/src/context/window-manager.ts` | 实时感知 API 返回的 `prompt_tokens`；触及 80% 水位时自动静默调用 Summarizer 提取阶段事实底账，生成 `CompactionEntry`，重构视窗并回落至 35% 安全区 | P0 |
| **BI-11** | 终端 Token HUD 实时显性感知与手动控制门 | `packages/tui/src/hud.ts`<br>`packages/core/src/commands/compact.ts` | 1. 终端底部常驻渲染 `Tokens: 42k/128k (32%) | Cache: 88%`；<br>2. 开放手动 `/compact [prompt]`、`/rewind [steps]` 与 `/clear` 交互命令 | P1 |

---

### 【Phase 3】 Git Worktree 并发隔离与完整 MCP 引擎 (Days 6~7)
> 目标：提供物理级并发沙箱，防止改脏工作区；接驳本地与远程私有工具中枢。

| 任务编号 | 任务名称 | 责任模块 / 文件路径 | 细化设计与验收指标 | 优先级 |
|---|---|---|---|---|
| **BI-12** | Git Worktree 物理并发沙箱引擎 | `packages/worktree/src/engine.ts`<br>`packages/worktree/src/branch.ts` | 多 Agent 读写全部分流至 `~/.bi/worktrees/<task-id>` 独立目录；挂载独立临时分支 `bi-task-<id>`；任务完成经审查后原子 Merge，撤销则静默清空 | P0 |
| **BI-13** | 完整 MCP 客户端 (Stdio + SSE 双通道) 与 ACP 协议 | `packages/mcp/src/client.ts`<br>`packages/mcp/src/transports/`<br>`packages/acp/src/server.ts` | 1. `StdioClientTransport`：子进程看门狗与输入输出管道封套；<br>2. `SseClientTransport`：远程 HTTP/SSE 连接器（实测接驳 QNAP 生产环境 Logbook 服务）；<br>3. 动态聚合工具注册表；<br>4. 吸收 Kimi Code `acp-server`，支持标准 Agent Client Protocol 直连现代 IDE | P0 |

---

### 【Phase 4】 A2A 协议、跨网双总线与声明式 DAG 工作流 (Days 8~10)
> 目标：实现长流程自动推进、代码运行即验与跨电脑/跨防火墙分布式协作。

| 任务编号 | 任务名称 | 责任模块 / 文件路径 | 细化设计与验收指标 | 优先级 |
|---|---|---|---|---|
| **BI-14** | 声明式 DAG 工作流调度引擎 | `packages/workflow/src/engine.ts`<br>`packages/workflow/src/checkpoint.ts` | 1. 解析 YAML 格式 DAG 步骤（并行拓扑与前置依赖）；<br>2. 每一步完成自动持久化 Checkpoint，发生网络断线或进程重启秒级断点自愈续跑 | P1 |
| **BI-14.1** | 因果拓扑图与 Taint 污点分析编译器 | `packages/workflow/src/analysis/` | 吸收清华理论算法：实现 `causality-graph.ts`（因果拓扑排序）与 `taint.ts`（数据污染分析），静态检测死锁并自动输出 Mermaid 流程图 | P1 |
| **BI-15** | 分布式 A2A 协议、跨网双总线与共享事实黑板 | `packages/a2a/src/host.ts`<br>`packages/a2a/src/blackboard.ts` | 统一管理分布式跨网协作角色 Coordinator（编排）、Scout（外部抓取）、Auditor（精算）、Reporter（起草）；统一往 `Blackboard` 共享事实底账，所有角色基于单模型按需派生，与单机进程内 Sub-agent (BI-07.3) 严格分层 | P1 |
| **BI-15.1** | A2A 邮件私密信令网关 (Control Plane) | `packages/a2a/src/transports/a2a-email-gateway.ts` | 落地 SMTP/IMAP 跨网通信驱动：支持 TLS 465/993、HMAC-SHA256 签名校验、IMAP IDLE 秒级唤醒与发件人白名单；100% 穿透物理防火墙，支持人类抄送介入 | P1 |
| **BI-15.2** | GitHub A2A 任务中枢 (Data & Task Plane) | `packages/a2a/src/transports/github-a2a-hub.ts` | 落地基于 Git 分支与 PR 的分布式任务中枢：任务专属分支派发（`bi-task-<id>`）、数据清洗脚本同步、Unified Diff 渲染与 PR 自动化审查合并 | P1 |
| **BI-15.3** | A2A 三级鉴权体系与角色能力矩阵 | `packages/a2a/src/auth.ts`<br>`packages/a2a/src/permissions.ts` | 1. 落地 HMAC-SHA256 签名与常量时间验签（`crypto.timingSafeEqual`），拦截重放（5分钟时钟偏斜）与发件人白名单；<br>2. 落地角色能力矩阵（Scout 禁写，Auditor 仅限沙箱，禁止窃取凭据）；<br>3. 高危动作强制人类在环 Unified Diff 审查门 | P0 |
| **BI-16** | Python 沙箱代码运行即验与 Traceback 自愈 | `packages/a2a/src/audit.ts` | 严禁口算！调用沙箱 Python 脚本计算良率与勾稽指标；若抛出异常，自动捕获 Traceback 并在当前轮次内自动打补丁纠偏重跑，直到输出合规底表 | P0 |

---

### 【Phase 5】 官方研报插件生态吸收、Pi-TUI 差分终端与交付验收 (Days 11~14)
> 目标：吸收 15 个官方研报插件，打造极速无闪烁交互，完成单文件二进制构建与实战验收。

| 任务编号 | 任务名称 | 责任模块 / 文件路径 | 细化设计与验收指标 | 优先级 |
|---|---|---|---|---|
| **BI-17** | 官方插件双协议加载器 (.zcode & .claude) | `packages/plugins/src/loader.ts`<br>`packages/plugins/src/marketplace.ts` | 纯声明式解析 `.zcode-plugin` 与 `.claude-plugin` 标准（`plugin.json`, `skills/`, `mcpServers/`）；支持 Marketplace 目录索引与本地安装 | P1 |
| **BI-18** | 官方核心数据研报插件全量吸收移植 | `presets/plugins/spreadsheets/`<br>`presets/plugins/pdf/` | 全量吸收移植官方 `spreadsheets-plugin`（全套金融与宏观统计 Python 勾稽模板）与 `pdf-plugin`（部委公报双栏排版与长篇抽取脚本） | P1 |
| **BI-18.1** | 清华顶尖 Agent SOP 技能集吸收 | `presets/plugins/superpowers/` | 全量吸收 `using-git-worktrees`（沙箱隔离规范）、`verification-before-completion`（完工自验铁律）与 `systematic-debugging`（系统化排查法） | P1 |
| **BI-19** | Pi-TUI 双缓冲差分无闪烁渲染终端 | `packages/tui/src/app.ts`<br>`packages/tui/src/thinking.ts` | 移植 `@earendil-works/pi-tui` 双缓冲字符矩阵差分引擎；终端流式打字 0 闪烁，CPU < 1%；支持 DeepSeek-R1 思考流卡片动态折叠收起/展开 | P1 |
| **BI-20** | 交互式 Git Unified Diff 审查门与 /doctor | `packages/tui/src/diff-view.ts`<br>`packages/core/src/doctor.ts` | 1. 文件变更弹出 Unified Diff 供人类确认；<br>2. `/doctor` 一键全链路体检智谱网络、凭据有效期、Python 环境（`pandas`/`openpyxl`）并附带修复建议 | P1 |
| **BI-21** | 宏观政策与数据审计端到端实战演练验收 | 测试套件与场景演练 | 选取真实部委产业公报与上市公司财报，全流程演练政策比对、良率勾稽、Worktree 隔离与研报生成，指标误差 0 容忍 | P0 |
| **BI-21.1** | 任务完工前置自验看门狗 | `packages/core/src/verifier/target-verifier.ts` | 吸收清华闭环校验机制：实现 `target-completion-verification.ts`（14.7KB），在 Agent 自行声称任务完成前进行目标契约严格核验，未通过时阻断退出并返回差距清单自愈续跑 | P0 |
| **BI-22** | Bun Compile 独立单文件原生二进制构建发布 | `scripts/build-bin.ts` | 通过 `bun build --compile` 打包输出免安装、零依赖的单一独立可执行文件 `bi`，跨平台支持 Linux x64 与 macOS arm64 | P0 |

---

## 三、 开源轮子全景资产图谱与代码映射矩阵 (SSOT)

> **开发铁律**：开发智能体在执行具体任务时，必须**严禁从零重复造轮子**！首选从清华大学 ZCode（`/home/yupeng/references/zcode`）与清华系 Kimi Code（`/home/yupeng/references/kimi-code`）官方仓库中提取并适配工业级成熟源码；次选从 Pi Agent、DeepCode、OpenCode 或成熟社区库中吸收。下表为各任务的权威资产映射清单：

| 任务编号与名称 | 首选 ZCode 官方源码轮子 (清华大学工业级资产) | 其它标杆 / 社区成熟轮子 (备选与互补) | 代码复用率与自研量估算 | 核心算法与复用收益 |
|---|---|---|---|---|
| **BI-01** Bun Monorepo 骨架与多包拓扑初始化 | `apps/zcode-cli/packages/contracts/`<br>`apps/zcode-cli/packages/shared-types/`<br>`turbo.json`, `pnpm-workspace.yaml` | `@earendil-works/pi-agent-core`<br>`opencode/packages/core/` | 90% 轮子<br>10% 胶水配置 | 完整复用契约定义、类型签名与多包编译流水线，消灭接口歧义。 |
| **BI-02** 智谱 BigModel 官方双轨特权认证引擎 | `packages/core/src/runtime/methods/model-runtime-headers.ts`<br>`packages/adapters/src/model/off-peak-request-auth.ts`<br>`packages/adapters/src/model/failure-classifier.ts` | Node `node:crypto` (生成安全 32 字节 PollToken) | 85% 轮子<br>15% 适配 | 复用官方 OAuth PKCE 轮询与二阶段换票机制，凭据加密落盘。 |
| **BI-02.1** Ultra VIP 专线路由与特权指纹标头注入 | `packages/adapters/src/model/runner-network-headers.ts`<br>`packages/adapters/tests/provider-endpoint-routing-fetch.test.ts` | `opencode/packages/ai/src/providers/` | 95% 轮子<br>5% 胶水 | 复用 `X-Coding-Plan-Api-Key` 标头注入与 `/api/v1/ultra/` 专线 URL 重写，触发折扣。 |
| **BI-03** Append-only JSONL 树状会话引擎 | `packages/core/src/runtime/methods/message-persistence.ts`<br>`packages/core/src/runtime/methods/session-fork.ts` (53KB)<br>`packages/core/src/runtime/methods/timeline-persistence.ts` | `pi/packages/coding-agent/src/core/session-manager.ts` (UUIDv7)<br>`kimi-code/packages/minidb/` (纯 TS LSM-Tree/SkipList/Trigram 引擎) | 90% 轮子<br>10% 适配 | 复用 53KB 会话分叉树算法，结合 MiniDB 纯 TS LSM 存储，彻底消除 Bun 跨平台编译 native C 绑定痛点。 |
| **BI-03.1** 会话时光倒流与物理文件差分回滚引擎 | `packages/core/src/runtime/methods/file-rewind.ts` (21KB)<br>`packages/core/src/runtime/methods/workspace-checkpoints.ts` (11KB) | `diff` npm package (`applyPatch`, `StructuredPatch`) | 90% 轮子<br>10% 适配 | 复用 21KB 逆向补丁恢复算法，时光倒流时物理工作区自动差分自愈。 |
| **BI-04** 单模型统一 SSE 流式驱动与插槽路由器 | `packages/core/src/runtime/methods/turn-model-step.ts` (32KB)<br>`packages/core/src/runtime/methods/streaming-recovery.ts`<br>`packages/adapters/src/model/runner-generate.ts` | `deepcode/packages/core/src/session.ts` (R1 流式分离)<br>`eventsource-parser` | 85% 轮子<br>15% 适配 | 复用 32KB 流式 Step 状态机与断线自愈恢复，支持 R1 思考流无缝分离。 |
| **BI-04.1** Prompt Cache 黄金排布与 Fuzzy 工具解析器 | `packages/core/src/context/builder.ts` (12KB, `ephemeral` 标记)<br>`packages/core/src/tool/input-normalization.ts`<br>`packages/core/src/tool/tool-input-validation-issues.ts` | Qwen CLI 畸变 JSON 自动修复 AST | 90% 轮子<br>10% 适配 | 严格锁定前缀顺序，Cache 命中率 ≥ 85%；自动清洗修复畸变 JSON。 |
| **BI-05** `BI.md` 项目长期记忆自适应注入器 | `packages/core/src/memory/extraction.ts` (10KB)<br>`packages/core/src/memory/memory-file-path.ts`<br>`packages/core/src/context/sections/memory.ts` | Claude Code `CLAUDE.md` 注入规范 | 90% 轮子<br>10% 适配 | 向上递归检索定位 `BI.md`，事实与口径静态注入 System Prompt 前缀。 |
| **BI-05.1** Dream Cycle 仿生做梦记忆沉淀中枢 | `packages/core/src/memory/dream.ts` (9.9KB, `evaluateAutoDreamTiming`)<br>`packages/core/src/memory/memory-agent-loop.ts` | 无 (清华大学 ZCode 独创认知算法) | 95% 轮子<br>5% 胶水 | REM 做梦机制，后台空闲期自动扫描会话精华，增量沉淀固化入长期记忆。 |
| **BI-06** 受控 Bash 执行器与 Linux PGID 进程组看门狗 | `packages/adapters/src/exec/process-tree.ts`<br>`packages/adapters/src/exec/node-execution-adapter-process.ts`<br>`packages/core/src/tool/bash-timeout-policy.ts`<br>`packages/adapters/src/exec/cwd-capture.ts` | `pi/packages/coding-agent/src/core/tools/bash.ts` | 90% 轮子<br>10% 适配 | 独立 PGID 进程组，`SIGTERM → SIGKILL` 强杀超时与孤儿进程，自动捕获 cwd。 |
| **BI-06.1** Credential Guard 路径沙箱越界防御 (Path Jail) | `packages/core/src/tool/path-policy.ts`<br>`packages/core/src/tool/path-normalization.ts`<br>`packages/core/src/tool/handlers/bash-readonly-policy-*.ts` (14 文件) | `kimi-code/packages/tree-sitter-bash/` (纯 TS Tree-sitter Bash AST 解析器)<br>OpenAI Codex CLI Path Jail 规则 | 90% 轮子<br>10% 适配 | 结合 AST 语法树解析与 Path Jail，在 50ms/50k 节点硬预算下阻断 `rm -rf /`、子命令嵌套及凭据窃取，零 C 依赖。 |
| **BI-06.2** 嵌入式原生快速搜索加速器 | `packages/adapters/src/exec/embedded-search-prelude.ts` (7.3KB)<br>`apps/zcode-cli/dependencies/native-search/` | BurntSushi/ripgrep 官方发布包 | 95% 轮子<br>5% 胶水 | 透明劫持 `find`/`grep` 至预编译静态 `bfs`/`ugrep`，速度提升 20 至 50 倍。 |
| **BI-07** 多工具并行流水线与二段式抢占取消状态机 | `packages/core/src/tool/scheduler.ts` (7KB)<br>`packages/core/src/runtime/methods/streaming-tool-coordinator.ts` (14KB)<br>`packages/core/src/runtime/methods/turn-tools.ts` | `kimi-code/packages/agent-core-v2/src/agent/toolExecutor/toolScheduler.ts` (细粒度 RWLock 调度矩阵)<br>Pi Agent `Promise.allSettled` | 85% 轮子<br>15% 适配 | 落地 `ToolAccesses.conflict` 读并发、路径重叠串行与全局屏障，只读并发加速同时消灭并发脏写。 |
| **BI-07.1** 8 级阶梯弹性文件匹配引擎 | `packages/core/src/tool/edit-matchers.ts` (13.2KB) | 无 (清华大学 ZCode 独创弹性算法) | 100% 轮子<br>0% 自研 | 8 级阶梯（exact、quotes、line-number、indentation、block 0.8），彻底消灭编辑失败。 |
| **BI-07.2** Read-Before-Write 门禁与 mtime 防脏写看门狗 | `packages/core/src/tool/read-file-state.ts`<br>`packages/core/src/tool/read-file-state-metadata.ts` (5.4KB)<br>`packages/core/src/tool/handlers/edit.ts` | 无 (清华大学 ZCode 独创防御机制) | 100% 轮子<br>0% 自研 | 未读严禁修改，校验磁盘真实 mtime，外部并发篡改立即阻断。 |
| **BI-07.3** 本地多角色子智能体分流引擎与上下文断路器 (Sub-agent Window Sandbox) | `packages/core/src/subagent/runner.ts` (68KB)<br>`packages/core/src/subagent/explore.ts` (3.5KB)<br>`packages/core/src/subagent/explore-tools.ts` (1.8KB)<br>`packages/core/src/subagent/borrowed-mcp-port.ts` (2.5KB)<br>`packages/core/src/subagent/definitions.ts` | `kimi-code/packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts`<br>`kimi-code/packages/agent-core-v2/src/session/agentLifecycle/profile/explore-overlay.md` | 90% 轮子<br>10% 适配 | 独立 Query Loop，海量探索日志沉淀子 Session，主视窗只收摘要，Token 膨胀降 95%，彻底免疫长上下文冲垮。 |
| **BI-08** 单次工具输出 64KB 有界截断保护 | `packages/adapters/src/exec/bash-output-policy.ts`<br>`packages/adapters/src/exec/bash-file-output.ts` (7KB)<br>`packages/core/src/tool/executor/result-content-projection.ts` | `kimi-code/packages/agent-core-v2/src/agent/media/image-compress.ts` (端侧 25KB 媒体压缩)<br>`zcode-app-cli` `bounded-tool-text.ts` | 95% 轮子<br>5% 胶水 | 单次输出 64KB 头尾 200 行截断，辅以端侧图片就地压缩（25KB 预算），全面封堵视窗撑爆风险。 |
| **BI-09** 历史工具输出自动脱水修剪器 (Pruner / Microcompact) | `packages/core/src/compact/microcompact.ts` (9.3KB) | 无 (清华大学 ZCode 独创脱水算法) | 100% 轮子<br>0% 自研 | 保留最近 5 轮工具结果，历史老旧 `Read`/`Bash` 脱水为单行标记，省 70% Token。 |
| **BI-10** 80% 高水位静默自动紧缩器 (Auto-Compactor) | `packages/core/src/compact/policy.ts` (6.2KB)<br>`packages/core/src/compact/manual.ts`<br>`packages/core/src/runtime/methods/compact-active.ts` (28KB) | Claude Code `/compact` 机制 | 90% 轮子<br>10% 适配 | 扣减输出预留后的有效视窗计算，3 击熔断器，自动摘要事实底账并重构上下文。 |
| **BI-11** 终端 Token HUD 实时显性感知与手动控制门 | `packages/core/src/runtime/methods/context-usage.ts` (14KB)<br>`packages/core/src/runtime/methods/usage-observability.ts` | `pi/packages/tui/src/program-status.ts` | 85% 轮子<br>15% 适配 | 常驻渲染已用 Token、百分比与缓存命中率，支持 `/compact` 手动交互。 |
| **BI-12** Git Worktree 物理并发沙箱引擎 | `packages/superpowers-plugin/skills/using-git-worktrees/SKILL.md`<br>`packages/adapters/src/context/git-snapshot.ts` | Node `child_process.execFile` | 80% 轮子<br>20% 胶水 | 任务专属独立工作树 `~/.bi/worktrees/<id>`，审查后 Merge，失败静默丢弃。 |
| **BI-13** 完整 MCP 客户端 (Stdio + SSE 双通道) | `packages/adapters/src/mcp/stdio-transport.ts`<br>`packages/adapters/src/mcp/network.ts`<br>`packages/adapters/src/mcp/pool.ts` | `pi/packages/mcp/src/client.ts` (21KB)<br>`kimi-code/packages/acp-server/` (标准 ACP 服务端)<br>`streamable-http.ts` | 90% 轮子<br>10% 适配 | 纯白盒 Stdio 与 SSE 客户端连通 QNAP Logbook，同时预留 ACP JSON-RPC 开放协议直通现代 IDE。 |
| **BI-14** 声明式 DAG 工作流调度引擎 | `packages/dynamic-workflow/src/engine/engine.ts` (36KB)<br>`packages/dynamic-workflow/src/engine/scheduler.ts` (26KB)<br>`packages/dynamic-workflow/src/engine/journal-memory.ts` (11KB) | 无 (清华大学 ZCode 独创工作流引擎) | 90% 轮子<br>10% 适配 | 步骤并行拓扑调度，每步 Checkpoint 持久化，进程重启秒级断点自愈续跑。 |
| **BI-14.1** 因果拓扑图与 Taint 污点分析编译器 | `packages/dynamic-workflow/src/analysis/causality-graph.ts`<br>`packages/dynamic-workflow/src/analysis/taint.ts` | Mermaid 流程图导出引擎 | 95% 轮子<br>5% 胶水 | 静态拓扑排序与数据污染分析，编译期检测死锁并生成可视化架构图。 |
| **BI-15** 分布式 A2A 协议、跨网双总线与共享事实黑板 | `packages/core/src/subagent/coordinator-response.ts`<br>`packages/core/src/tool/handlers/send-message.ts` | OpenCode `protocol/` 跨端契约 | 85% 轮子<br>15% 适配 | 统一管理跨网络 Coordinator、Scout、Auditor、Reporter，单模型按需派生，事实黑板共享，与本地 Sub-agent (BI-07.3) 分层解耦。 |
| **BI-15.1** A2A 邮件私密信令网关 (Control Plane) | `packages/core/src/tool/handlers/send-message.ts` (信令封套) | `nodemailer` (SMTP 465)<br>`mailparser` / `imap-flow` (IMAP IDLE)<br>Node `node:crypto` (HMAC-SHA256) | 40% 轮子<br>60% 自研协议 | **核心创新轮子**：SMTP/IMAP 穿透防火墙跨网信令传输，HMAC 签名，人类抄送介入。 |
| **BI-15.2** GitHub A2A 任务中枢 (Data & Task Plane) | `packages/core/src/tool/diff.ts` | `@octokit/rest` (GitHub 官方 SDK)<br>`diff` npm package | 50% 轮子<br>50% 自研编排 | **核心创新轮子**：基于分支与 PR 的分布式任务派发，Unified Diff 审查合并。 |
| **BI-15.3** A2A 三级鉴权体系与角色能力矩阵 | `packages/core/src/permission/service.ts` (24KB)<br>`packages/core/src/subagent/tool-policy.ts` | Node `crypto.timingSafeEqual` | 85% 轮子<br>15% 适配 | L1 角色能力矩阵（Scout 禁写，Auditor 沙箱）；L2 邮件验签防重放；L3 人类审查门。 |
| **BI-16** Python 沙箱代码运行即验与 Traceback 自愈 | `packages/node-repl-host/`<br>`packages/spreadsheets-plugin/skills/xlsx/xlsx.py` | 系统原生 `python3` + `pandas` + `openpyxl` | 80% 轮子<br>20% 适配 | 严禁口算！Python 沙箱计算良率，捕获 Traceback 并在当前轮自愈重跑。 |
| **BI-17** 官方插件双协议加载器 (.zcode & .claude) | `packages/adapters/src/plugins/marketplace.ts`<br>`packages/adapters/src/plugins/plugin-components.ts`<br>`packages/adapters/src/plugins/markdown-frontmatter.ts` | Anthropic Claude Plugin 官方规范 | 90% 轮子<br>10% 适配 | 纯声明式解析双协议插件目录（`plugin.json`, `skills/`, `mcpServers/`）。 |
| **BI-18** 官方核心数据研报插件全量吸收移植 | `packages/spreadsheets-plugin/`<br>`packages/pdf-plugin/`<br>`packages/documents-plugin/`<br>`packages/presentations-plugin/`<br>`packages/visualize-plugin/` | 无 (官方全套高质量插件资产) | 100% 轮子<br>0% 自研 | 全量吸收移植 Excel/CSV 审计（`xlsx.py`）、PDF 双栏解析、Word/PPT 报告生成。 |
| **BI-18.1** 清华顶尖 Agent SOP 技能集吸收 | `packages/superpowers-plugin/skills/` | 无 (清华顶级工程学科研资产) | 100% 轮子<br>0% 自研 | 全量吸收 `using-git-worktrees`、`verification-before-completion` 与 `systematic-debugging`。 |
| **BI-19** Pi-TUI 双缓冲差分无闪烁渲染终端 | `packages/tui/src/app-thought-components.tsx` (折叠逻辑) | `pi/packages/tui/src/tui.ts` (50KB 差分引擎)<br>`deepcode/packages/core/src/session.ts` | 90% 轮子<br>10% 适配 | 双缓冲字符矩阵差分引擎，终端打字 0 闪烁，CPU < 1%，R1 思考流动态卡片收起。 |
| **BI-20** 交互式 Git Unified Diff 审查门与 /doctor | `packages/tui/src/app-approval.ts` (6KB)<br>`packages/core/src/tool/diff.ts` | `pi/packages/tui/src/components/diff-view.ts`<br>`shiki` (语法高亮) | 85% 轮子<br>15% 适配 | 文件变更弹出 Unified Diff 供人类确认；`/doctor` 全链路体检凭据与环境。 |
| **BI-21** 宏观政策与数据审计端到端实战演练验收 | `packages/spreadsheets-plugin/` & `pdf-plugin/` 内置测试用例与断言 | 无 | 80% 轮子<br>20% 场景编写 | 真实部委公报与上市公司财报全流程演练，良率勾稽 0 误差验收。 |
| **BI-21.1** 任务完工前置自验看门狗 | `packages/core/src/runtime/methods/target-completion-verification.ts` (14.7KB) | `superpowers-plugin/skills/verification-before-completion` | 95% 轮子<br>5% 胶水 | 闭环自验拦截门：模型宣布完成前强制对比目标契约，未达标阻断退出并自愈。 |
| **BI-22** Bun Compile 独立单文件原生二进制构建发布 | `apps/zcode-cli/dependencies/native-search/` (预编译静态二进制打包) | `bun build --compile` 官方工具链 | 90% 轮子<br>10% 脚本 | 输出零依赖单一二进制 `bi`，内置静态 `ripgrep`/`ugrep`/`bfs`，支持 Linux/macOS。 |

---

## 四、 开发智能体实战决策指引 (FAQ & Self-Correction)

在开发阶段，如果执行 Agent 遇到异常，必须按以下标准规程自愈：

1. **遇到大模型返回畸形 JSON 时**：
   - 严禁直接抛出 `SyntaxError` 中断会话；
   - 必须流经 `FuzzyToolParser`，尝试剥离 Markdown 包裹标签、补齐缺失的双引号与花括号后再行反序列化。
2. **遇到 Python 勾稽脚本运行抛错时**：
   - 严禁将 Raw Traceback 直接作为最终答案抛给用户；
   - 必须将异常堆栈送回模型，触发一次内部 Self-Healing 循环，修改脚本代码后再次在 Worktree 沙箱中重跑。
3. **遇到工作区冲突或改动回滚时**：
   - 严禁在当前工作区执行破坏性的 `git reset --hard`；
   - 所有实验性代码必须在 `~/.bi/worktrees/` 中进行，即便崩溃只需安全删除工作树，主工作区毫发无损。
4. **遇到目标任务宣布完成时**：
   - 严禁未经前置看门狗（`BI-21.1`）即直接向用户交卷；
   - 必须通过 `TargetCompletionVerification` 严格核验原始需求契约与证据链，100% 闭环后方可汇报办结。

