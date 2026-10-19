Read-only reconnaissance complete. All findings below are from actual file reads (no writes, no code changes).

---

## 1) kimi vis 架构一页纸

**包结构**：`apps/vis/` 是**独立 workspace 包**（不是 kimi 主包组成部分），伞包 `@moonshot-ai/vis` 内含两个子包：
- `@moonshot-ai/vis-server`（Hono + `@hono/node-server`，`tsdown` 构建）
- `@moonshot-ai/vis-web`（React SPA）
- `apps/kimi-code` 主 CLI 仅用 **动态 import** `@moonshot-ai/vis-server/start` 拉起，耦合极松（`vis.ts:134`）。

**构建栈**：server=`tsdown`(TS→ESM)；web=`Vite 6`+`React 19`+`Tailwind 4`+`react-router 7`+`react-query`+`react-virtual`，用 `vite-plugin-singlefile` 打成**单文件 HTML**，构建期 gzip 成 base64 内嵌（`VIS_WEB_GZIP_B64`），运行时从内存喂（`web-asset.ts`、`vis.ts:61`）；兜底落到 `server/dist/public/`。

**server 路由清单**（全部 `/api` 前缀，来源 `app.ts:98-110`）：
| endpoint | 数据 |
|---|---|
| `GET /api/sessions` | 会话摘要列表（meta + agentCount + health）|
| `DELETE /api/sessions/:id` | 删会话目录 |
| `POST /api/sessions/:id/reveal` | 服务端打开 OS 文件夹 |
| `GET /api/sessions/:id` | 会话详情（state.json + agents[]）|
| `GET /api/sessions/:id/wire?agent=` | 原始 wire.jsonl 记录（tool.call/result 配对）|
| `GET /api/sessions/:id/agents` | agent 树 |
| `GET /api/sessions/:id/tasks` | 后台任务列表 |
| `GET /api/sessions/:id/tasks/:tid/output` | 任务 output.log 字节窗 |
| `GET /api/sessions/:id/cron` | cron 任务 |
| `GET /api/sessions/:id/logs?which=` | 诊断日志 |
| `GET /api/sessions/:id/blobs/:hash` | blob 二进制 |
| `GET /api/sessions/:id/context?history=` | 投影上下文（messages/usage/tokens）|
| `POST /api/imports?name=` | 上传 debug zip（≤500MiB）|

**web 渲染面**（`SessionDetailPage.tsx` 8 个 tab）：`Wire`（虚拟化的扁平 wire 事件流，call↔result 配对+耗时+搜索+issues，非 DAG/树）、`Timeline`（**客户端**从 wire 派生 turns→steps→tool calls 的时长/Token/上下文增长/缓存命中/空闲间隙，见 `lib/analysis`）、`Context`（重建模型视角上下文）、`Agents`（agent 父子树）、`Tasks`/`Cron`/`Logs`/`State`(原始 state.json)。**无 diff 专用 tab**（Context 内有 Undo/Compaction ribbon）。

## 2) 拉起链一句话
`kimi vis [sessionId] [--port] [--host] [--no-open]` → `handleVis` 解析 home(`~/.kimi-code`) → 动态 import `@moonshot-ai/vis-server/start` → Hono 在 **loopback 自动端口**起服 → 打印单条 `http://127.0.0.1:<port>/`（可选浏览器深链 `sessions/<id>`）→ 等 SIGINT 关闭。

## 3) bi 数据可得性三栏表（文件:行号证据）

| 类别 | 字段/能力 | 证据 |
|---|---|---|
| **直接可得** | 会话列表+元数据(sessionId/title/createdAt/cwd/forkedFrom) | `manager.ts:309 listSessions`；`types.ts:59-70`；`index.ts:227 list` |
| 直接可得 | 消息流(类型 user/assistant/system/compaction) | `types.ts:13-19`；`manager.ts:157 entries()` |
| 直接可得 | 工具名+配对 id(toolName/toolCallId) | `types.ts:49-55`；`index.ts:142-143 EntryRow` |
| 直接可得 | **分支树(森林)** id/parentId + fork + rewind + history | `types.ts:37-40`；`manager.ts:254 fork`、`:293 rewindTo`、`:219 history` |
| 直接可得 | 每条目时间戳 createdAt | `types.ts:46`；`manager.ts:205` |
| **需补记** | 耗时/时长 | 无显式 duration 字段，仅有 per-entry `createdAt`；tool 调用→结果延迟须由 `toolCallId` 配对后按 createdAt 之差**推断**；无 turn/step/TTFT/活跃时钟模型 |
| 需补记 | payload 内部结构 | `types.ts:43` 明确“各类型 schema 归属上层模块”——消息文本/工具参数形状在 session 层**不定义**，渲染器需上层 payload 契约(BI-10.x)才能可读 |
| 需补记 | Token 用量/上下文窗口/cache 命中 | **完全缺失**（kimi 来自 wire+context 投影，bi 无此账本）|
| 需补记 | 子 agent 树 | bi 无 agent 概念（fork=对话分支，非 agent）；kimi 的 Agents tab 在 bi 需改用 fork 分支树替代 |
| **不可得** | kimi wire 协议(wire.jsonl/state.json/agents/<id>/wire.jsonl、blobs、cron、tasks/output.log、logs、zip-import) | bi 模型为单 JSONL，无 kimi 引擎产物 |
| 不可得 | LLM 推理细节(TTFT/decode/上下文增长曲线) | 未存储 |
| 不可得 | 后台任务/cron/日志二进制 | bi 仅存会话 |

## 4) 最小面拆单提案（bi vis v1）

**只做 2–3 块（按可感知度/工作量排序）：**
1. **会话列表 + 分支树 + 消息流浏览器**（核心，M）：列表→点开→看对话分支树 + 按类型(用户/助理/系统/压缩)的消息流。数据 100% 就绪（`listSessions`/`entries`/`parentId` 树）。
2. **工具调用视图**（S/M）：按 `toolCallId` 配对 tool_call↔tool_result，显示工具名 + 由 createdAt 差推断的延迟。数据字段齐，仅缺显式时长。
3. **(可选)基础派生统计**（S）：客户端从 createdAt 算 turn/step 计数、工具调用数、时间间隙——**不引入新存储**。

**新增文件布局提案**（bi 运行时是 Bun，见 `index.ts:15 bun:sqlite`、`Bun Compile`）：
- `packages/core/src/cli/commands/vis.ts` —— CLI 入口（仿 `vis.ts`：`--port/--host/--no-open/[sessionId]`，解析 `~/.bi/sessions` 或 config，起服、打印 URL、可选打开、SIGINT）。
- `packages/vis-server/server.ts` —— 用 `Bun.serve`（非 Hono/node）提供 `GET /api/sessions`、`GET /api/sessions/:id`（内联算分支树）；复用 `@bi/core` 的 `SessionManager` + `SqliteIndexEngine`。
- `packages/vis-web/` —— 新包，Vite+React 单文件 SPA（仿 kimi）产出 `dist/index.html`；静态资源放 `packages/vis-web/dist/` → 复制进 server 的 `public/`（仿 `copy-web-dist.mjs`），或 gzip 内嵌从内存喂（仿 `web-asset.ts`）。

**工作量**：S=工具配对视图/派生统计；M=列表+树+消息流 SPA+server+CLI（v1 本体）；L=完整 kimi 等价体（token/context/agents/cron/logs/import）——**明确不做**。

**风险两条**：
- **安全**：默认绑 **127.0.0.1**；非回环绑定时强制静态令牌（仿 `config.ts:51 resolveVisAuthToken` 抛错逻辑，命名 `BI_VIS_AUTH_TOKEN`）；令牌走 URL `#token=` 片段（不落日志）+ localStorage；会话 id 用现有 `SESSION_ID_PATTERN` 白名单防穿越。
- **范围**：防全家桶蔓延——kimi vis 已膨胀到 8 tab + wire/context/agents/cron/tasks/logs/blobs/imports。v1 封顶 2–3 视图，坚决推迟 token/context/agents/cron/logs/import/reveal/令牌轮转/多网卡 URL。

## 5) v1 明确不做清单
- Token 用量 / 上下文窗口 sparkline / 缓存命中（数据缺失且无账本）
- Context 投影重建、Agents/subagent 树（bi 无 agent 概念）
- Cron / 后台任务 / 诊断日志 tab（kimi 引擎产物，bi 无）
- zip 导入 / reveal 打开文件夹
- 令牌轮转(rotate-token) / 多网卡 Local+Network 地址打印（属 `kimi web` 命令，与 vis 无关）
- 实时刷新/流式推送（v1 只读拉取即可）
- 消息正文富渲染（依赖 BI-10.x payload 契约，未就绪前仅显示原始 payload）

---

**一处前提更正（已核实）**：你描述的“vis 用 rotate-token / access-urls 多网卡地址打印”**不成立**。这些属于**另一个独立命令 `kimi web`**（`apps/kimi-code/src/cli/sub/web/rotate-token.ts`、`access-urls.ts`，基于 `@moonshot-ai/kap-server`）。`kimi vis` 本身：默认绑 `127.0.0.1`、令牌为**静态** `VIS_AUTH_TOKEN`（仅非回环时强制）、只打印**单条** URL，不轮转令牌也不枚举网卡。bi vis 应直接复用 vis 的“回环+可选静态令牌”模型，而非 web 的轮转/多网卡模型。
