工单 BI-20.5b 完成验收。

## 结论清单

**新增/改动文件**
- 新增 `packages/core/src/cli/commands/vis.ts`（`bi vis [sessionId] [--port N] [--host H]`：Bun.serve、缺省 127.0.0.1 + 随机端口、控制台打印 URL、SIGINT 优雅退出；内联零依赖 HTML/JS；安全策略与路由矩阵全部内聚于本文件）
- 新增 `packages/core/src/cli/commands/vis.test.ts`（23 用例，全绿）
- 改动 `packages/core/src/cli/commands/dispatch.ts`：`SUBCOMMANDS` 注册 `"vis"`（:77）、新增 `handleVisCommand` 派发、`usage`/头注释同步

**路由与安全语义**
- `GET /api/sessions` → 会话列表+元数据（透传 `listSessions`）
- `GET /api/sessions/:id` → 消息流 + 分支树（parentId 森林，含 depth）+ 工具配对（tool_call/tool_result 按 toolCallId）
- `GET /` → 单文件 vanilla HTML+内联 CSS+原生 JS（零构建/零 npm 依赖/零 CDN，已断言无 `script src`/无 `link`/无 `http(s)://` 外链）
- 端口：缺省 `0`=内核随机空闲；`--port` 非法 → exit 2
- host：缺省 127.0.0.1 免令牌；`0.0.0.0`/`::`/非回环 → 强制 `BI_VIS_AUTH_TOKEN`，缺失 **拒绝启动 exit 1**，带 token 时 `/api/*` 经 `?t=` 或 `Authorization: Bearer` 校验（401）
- 404：`sessionId` 未知 → 结构化 `session_not_found`；路径穿越式 id（如 `../..`）→ `invalid_session_id` 400；非 GET → 405

**测试数 / tsc / 手动自验**
- 测试：`bun test ./packages/core/src/cli/` → **270 pass 0 fail**；新增 `vis.test.ts` 23 pass（含列表/详情/404/令牌门/穿越拒绝/非法 host 拒启 + HTML 结构断言）
- tsc：`bunx tsc --noEmit` → **0 errors**
- 手动自验（真实端口 curl）：`/api/sessions`→200+JSON、`/api/sessions/:id`→200+完整详情、`/`→200 HTML、unknown→404、穿越 `../..`→400，**全部符合**

**未尽边界（v1 明确不做，照抄侦察报告第 5 节）**
- token 统计 / 上下文曲线 / agents 树 / cron / logs / zip 导入 / 实时推送 / 富文本渲染 / 令牌轮转 / 多网卡地址
- 消息正文仍按原始 payload 展示（依赖 BI-10.x payload 契约，未就绪前不富渲染）
- 注意：仓库内已存在无关的 `packages/core/src/web/vis-handler.ts`（另一套常驻令牌设计），本单未触碰；本单以全新 `cli/commands/vis.ts` 独立交付，二者并存但本单不依赖它

工作树未 commit 未 push，留主控验收。
