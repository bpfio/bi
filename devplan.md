# bi CLI Agent 工程研发与落地执行计划 (devplan.md)

> 本文档是 `bi` CLI Agent（`bpfio/bi`）的官方工程开发计划与任务分解矩阵（WBS）。
> 定位：100% 白盒开源、零数据外泄、极低幻觉、极高并发执行力，专精于**政策深度调研**与**商业智能/严密数据分析**的现代化终端 Agent CLI。
> 架构基石：**单模型全自洽即插即用（Single-Model First）+ Python 沙箱代码运行即验（Code-backed Grounding）**。
> 同步归档于 Logbook 知识中枢：`project: "bi"`。

---

## 一、 核心架构原则与设计红线

1. **单模型自洽闭环（Single-Model First）**：
   - 彻底摒弃异构双模型强制打架等学术化包袱；系统由用户配置的单一主力大模型（GLM、DeepSeek、Claude 或本地 vLLM）驱动，零额外 Key 负担，零多模型账单开销；
   - 专职子角色（探针搜集、沙箱精算、研报撰写）均基于该单一模型按需派生。
2. **代码运行即验（Code-backed Grounding）**：
   - 严禁模型口算指标；良率对比、产能推算、财税勾稽必须在沙箱中由 Python（`pandas` / `openpyxl`）真实跑出结果作为事实底账；
   - 严格贯彻“证据一致性铁律”（良率存在即有产线、0/1 与 1-100 维度分离）。
3. **全自动三层上下文管理（Auto Context Management）**：
   - 工具输出 64KB 有界截断 + 历史工具输出自动脱水 + 80% 水位静默自动紧缩（生成 Anchor 阶段底账）；
   - 保留手动 `/compact`、`/rewind` 与 Token HUD 显性感知。
4. **Git Worktree 物理并发隔离**：
   - 子智能体读写全部分流至 `~/.bi/worktrees/<task-id>` 独立沙箱，杜绝改脏主工作区。
5. **智谱 BigModel 官方特权无损对齐**：
   - 官方 OAuth 免密 + API Key 二阶段 PAT 换票 + 特权标头注入与 Ultra VIP 专线路由，100% 享受 Coding Plan 客户端折扣。
6. **100% 白盒可审计**：
   - 彻底摒弃民间 `zcode-app-cli` 的混淆二进制（`vendor/zcode.cjs`）与 27 个脆弱 AST 补丁，全链路纯 TypeScript/Bun 源码构建。

---

## 二、 研发里程碑与任务拆解矩阵 (WBS)

### 【Phase 1】 白盒内核、沙箱、会话持久化与官方双轨认证 (Days 1~3)
> 目标：打通核心 Agent Loop、Append-only 会话引擎与智谱官方双轨特权鉴权。

| 任务编号 | 任务名称 | 责任包 / 模块 | 核心交付物与验收标准 | 优先级 |
|---|---|---|---|---|
| **BI-01** | Bun Monorepo 骨架与工程环境构建 | 根目录配置 | 完成 `package.json`、`tsconfig.json` 工作区拓扑；配置 `packages/{core, worktree, workflow, mcp, a2a, tui, plugins}` | P1 |
| **BI-02** | 智谱 BigModel 双轨特权认证与 Ultra 专线路由 | `packages/core/src/auth/`<br>`packages/core/src/gateway/` | 1. 落地 OAuth 2.0 PKCE/Poll 状态机（`cli-oauth.ts`）；<br>2. 落地 API Key 二阶段换票器（`coding-plan-key.ts`，换取带 `token_use: "project_access"` 的短期 PAT）；<br>3. 注入特权 Headers 并自动重定向至 Ultra VIP 专线（`/api/v1/ultra/...`），实测触发 Coding Plan 套餐抵扣 | P0 |
| **BI-03** | Append-only JSONL 树状会话引擎 | `packages/core/src/session/` | 1. 会话持久化至 `~/.bi/sessions/<id>.jsonl`；<br>2. 消息节点携带 UUIDv7 `id` 与 `parentId`，天然支持 `/rewind` 撤回与 `/fork` 分支；<br>3. SQLite WAL 索引表（`~/.bi/sessions.db`）支撑秒开列表 | P0 |
| **BI-04** | 单模型统一 SSE 流式驱动与插槽路由器 | `packages/core/src/model-router.ts`<br>`packages/core/src/drivers/` | 适配 GLM、DeepSeek、Claude 等标准 OpenAI / Anthropic 协议；实现零代码热切换的 `ModelSlotRouter` | P1 |
| **BI-05** | `BI.md` 项目长期记忆自适应注入 | `packages/core/src/rules.ts` | 启动时自动解析当前工作区 `BI.md` 或 `.bi/rules.md`，静态固化官方信源与统计口径至 System Prompt 前缀 | P1 |
| **BI-06** | 受控 Bash 执行器与 Linux PGID 进程组看门狗 | `packages/core/src/tools/bash.ts` | 派生独立 PGID；超时或被取消时内核级软硬两阶段熔断（SIGTERM → SIGKILL），彻底杜绝后台孤儿僵尸进程 | P0 |
| **BI-07** | 多工具并行流水线与二段式抢占状态机 | `packages/core/src/agent.ts` | 1. 支撑多只读工具并发执行（`Promise.allSettled`）；<br>2. 落地 Esc / Ctrl+C 二段式优雅取消，保留现场与上下文 | P1 |

---

### 【Phase 2】 全自动三层上下文管理与有界防护 (Days 4~5)
> 目标：彻底解决长会话爆视窗与内存泄漏问题，实现用户零负担的上下文自愈。

| 任务编号 | 任务名称 | 责任包 / 模块 | 核心交付物与验收标准 | 优先级 |
|---|---|---|---|---|
| **BI-08** | 单次工具输出 64KB 有界截断保护 | `packages/core/src/context/bounded-tool-text.ts` | 移植打磨 `BoundedToolText`，单次工具输出上限 64KB 字符，保留头部 200 行与尾部 200 行，中间折叠，彻底防刷屏 | P0 |
| **BI-09** | 历史老旧工具输出自动脱水修剪 | `packages/core/src/context/pruner.ts` | 对超过 5 轮的老旧工具输出自动缩减为单行摘要指示符，Token 消耗压减 60%+ | P1 |
| **BI-10** | 80% 高水位静默自动紧缩器 | `packages/core/src/context/compactor.ts`<br>`packages/core/src/context/window-manager.ts` | 实时感知上下文长度；触及 80% 水位时自动提取事实底账生成 `CompactionEntry`（Anchor），重构上下文视窗，回落至 35% 安全区 | P0 |
| **BI-11** | 终端 Token HUD 实时感知与手动控制门 | `packages/tui/src/hud.ts`<br>`packages/core/src/commands/` | 1. 终端状态栏常驻显化 `Ctx: 42k/128k (32%) | Cache: 88%`；<br>2. 支持手动 `/compact [prompt]`、`/rewind` 与 `/clear` | P1 |

---

### 【Phase 3】 Git Worktree 并发隔离与完整 MCP 引擎 (Days 6~7)
> 目标：提供物理级多任务隔离执行能力，接驳本地与远程私有工具中枢。

| 任务编号 | 任务名称 | 责任包 / 模块 | 核心交付物与验收标准 | 优先级 |
|---|---|---|---|---|
| **BI-12** | Git Worktree 物理并发沙箱引擎 | `packages/worktree/` | 多任务与子 Agent 自动派生至 `~/.bi/worktrees/<task-id>` 独立目录；任务结束后自动审查合并或静默擦除，工作区 0 污染 | P0 |
| **BI-13** | 完整 MCP 客户端 (Stdio + SSE) | `packages/mcp/` | 1. `StdioClientTransport`（受控子进程与管道看门狗）；<br>2. `SseClientTransport`（远程长连接，实测直连 QNAP Logbook 服务）；<br>3. 动态工具注册与 Schema 转换 | P0 |

---

### 【Phase 4】 A2A 协议、任务分工与声明式 DAG 工作流 (Days 8~10)
> 目标：实现长流程自动推进、确定性代码审计与事实黑板协同。

| 任务编号 | 任务名称 | 责任包 / 模块 | 核心交付物与验收标准 | 优先级 |
|---|---|---|---|---|
| **BI-14** | 声明式 DAG 工作流调度引擎 | `packages/workflow/` | 1. 解析 YAML 格式 DAG 步骤（依赖解析、并行拓扑）；<br>2. 每一步落盘 Checkpoint，中断后支持秒级断点自愈续跑 | P1 |
| **BI-15** | A2A 跨角色分工与事实黑板中枢 | `packages/a2a/` | 统一管理 Coordinator（编排）、Scout（搜集）、Auditor（精算）、Reporter（起草）；统一往 `Blackboard` 共享事实底账 | P1 |
| **BI-15.1** | A2A 邮件私密信令网关 (Control Plane) | `packages/a2a/src/transports/a2a-email-gateway.ts` | 落地 SMTP/IMAP 跨网通信驱动：支持 TLS 465/993、HMAC-SHA256 验签、IMAP IDLE 秒级唤醒与发件人白名单，100% 穿透物理防火墙，支持人类抄送介入 | P1 |
| **BI-15.2** | GitHub A2A 任务中枢 (Data & Task Plane) | `packages/a2a/src/transports/github-a2a-hub.ts` | 落地基于 Git 分支与 PR 的分布式任务中枢：任务专属分支派发（`bi-task-<id>`）、数据清洗脚本同步、Unified Diff 渲染与 PR 自动化审查合并 | P1 |
| **BI-16** | Python 沙箱代码运行即验与审计闭环 | `packages/a2a/src/audit.ts` | 严禁口算；内置 Python 脚本运行门禁，强制执行勾稽对比，并依据证据一致性铁律自动纠偏 | P0 |

> **跨网 A2A 双总线架构设计（控制面与数据面分离）**：
> - **私密控制面（A2A 邮件私密信令网关）**：负责跨网 Agent 间的加密握手、静默唤醒、指令调度与进度汇报。依托邮件天然的 Store-and-Forward（离线存储转发）机制，100% 穿透企业局域网与物理防火墙，人类可直接抄送查阅或回复介入；
> - **任务数据面（GitHub A2A 任务中枢）**：负责任务代码、重型数据表与研报的分发与交付。以 Git 分支作为任务隔离沙箱，以 Pull Request 作为最终验收门禁，实现全链路版本化不可篡改审计留痕。

---

### 【Phase 5】 官方插件生态吸收、Pi-TUI 差分终端与交付验收 (Days 11~14)
> 目标：吸收 15 个官方研报插件，打造极速无闪烁交互，完成端到端实战验收。

| 任务编号 | 任务名称 | 责任包 / 模块 | 核心交付物与验收标准 | 优先级 |
|---|---|---|---|---|
| **BI-17** | 官方插件双协议加载器 | `packages/plugins/` | 纯声明式解析 `.zcode-plugin` 与 `.claude-plugin`（`plugin.json`, `skills/`, `mcpServers/`），支持 Marketplace 安装 | P1 |
| **BI-18** | 官方核心数据研报插件全量吸收 | `presets/plugins/` | 全量吸收移植 `spreadsheets-plugin`（金融/宏观勾稽）与 `pdf-plugin`（双栏公报长文本抽取）核心模板与脚本 | P1 |
| **BI-19** | Pi-TUI 双缓冲差分无闪烁渲染 | `packages/tui/` | 基于 `@earendil-works/pi-tui` 构建；无跳字、无闪烁、CPU 占用 < 1%；支持 DeepSeek-R1 思考流动态折叠卡片 | P1 |
| **BI-20** | 交互式 Git Unified Diff 审查门与 /doctor 体检 | `packages/tui/src/diff-view.ts`<br>`packages/core/src/doctor.ts` | 1. 变更文件弹出 Unified Diff 供人工确认；<br>2. `/doctor` 一键体检网络、凭据、Python 依赖与环境自愈 | P1 |
| **BI-21** | 宏观政策与数据审计端到端实战验收 | 全链路 | 选取部委公报与上市企业研报开展真实数据穿透与报告生成演练，通过验收并发布 `bpfio/bi v1.0` | P0 |

---

## 三、 执行推进原则与审批红线

1. **审批先行**：每一个 Phase 的具体代码工程启动前，必须遵循《方案先行与执行前审批铁律》，向用户提交细化方案；
2. **测试先行**：核心模块（OAuth 换票、会话 DAG、有界截断、PGID 熔断）必须配备 1:1 的单元测试与场景回放测试；
3. **安全闭环**：严禁泄露任何真实私网 IP 与敏感凭据，所有示例均采用 RFC 5737 规范。
