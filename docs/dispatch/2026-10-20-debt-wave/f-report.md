# 工单 F 报告：BI-20.1 四态切换器入口 + BI-20.5 令牌轮转接 vis

仓库 /home/yupeng/bi · 虚账清偿波次 2 · 未 commit/push/stash。

## 1. BI-20.1 四态模式切换器入口（/mode）

### 接线点

| 面 | 位置 | 说明 |
|---|---|---|
| 命令面（新增） | `packages/tui/src/mount/mode-command.ts` | 候选条目 + 参数解析 + 分发；状态机全部走 core 器官 `core/src/modes/mode-selector.ts`（只读引用） |
| 候选面 | `packages/tui/src/mount/candidate-menu.ts:62` | `builtinSlashCandidates` 追加 `modeCommandCandidates`（菜单可发现） |
| REPL 分发 | `packages/tui/src/mount/agent-tui.ts:798` | `submit()` 在模型回合前分流 `/mode`（与 /btw、手动门同语义：本地回执上屏、不入模型回合、主会话 JSONL 零追加） |
| 回执 | `packages/tui/src/mount/agent-tui.ts:1055` | `#handleModeCommand`：成功走回执文本，非法 id 走结构化错误文本 |
| 状态机持有 | `packages/tui/src/mount/agent-tui.ts:478` | 会话内 `ModeSelector`（初值 `workMode` 选项，缺省 `build`——plan 会拦写，不作缺省） |
| 权限面联动 | `packages/tui/src/mount/agent-tui.ts:484` | 器官 `onChange` 回调：进 plan → `PermissionGate.setMode("manual")`（并记住原模式）；离 plan → 复原原模式 |
| 只读约束 | `packages/tui/src/mount/agent-tui.ts:1180` | 工具执行面（`#execute`）先查 `ModeSelector.intercept`：plan 态写工具结构化拒绝 `plan-mode-readonly`（不进权限裁决回路） |
| 模式指示（接活） | `packages/tui/src/mount/agent-tui.ts:575` | 状态行首位挂 `renderModeIndicator`（`components/mode-indicator.ts`），形如 `[build] [manual] 就绪`（工作模式在前、权限三态在后） |
| 只读端口 | 会话内闭包 | 判据取工具注册表的 `readOnly` 标记（与 AgentLoop 只读排重集同源） |
| 宿主兜底 | `bin/bi.ts`（slashCommand 面） | 走到宿主面说明装配缺环，如实回报「由会话内建执行体处理」，不冒充未知命令 |

### 语义

- `/mode`（无参）= 显示当前态：`[build] 当前模式: build`；plan 态追加只读提示。
- `/mode <id>` = 切换 plan/edit/build/yolo，回执带徽标；切到当前态幂等（`当前已是`）。
- `/mode <非法>` = 结构化拒绝 `unknown-mode`，不改态。
- plan 态回执带结构化提示：只读生效，写操作被 `plan-mode-readonly` 拒绝。

### 依赖方向裁定（工单指定：与 BI-28.3 权限三态门并存不合并）

- 工作模式（mode-selector：plan 只读语义）与权限面（PermissionGate：manual/auto/yolo）**两套并存**：`mode-command.ts` 不碰权限门，只切工作模式。
- 最小接缝落在宿主一处：`ModeSelector.onChange` 回调里做「plan → 权限面 manual + 只读拦截」联动；plan 态只读用器官自带的 `intercept`（结构化码 `plan-mode-readonly`），不新造拦截通道。
- 依赖方向：tui → core（`core/src/modes/mode-selector.ts`）。core 不反向依赖 tui。

## 2. BI-20.5 令牌轮转接 bi vis 成品

### 接线点

| 面 | 位置 | 说明 |
|---|---|---|
| env 门 | `packages/core/src/cli/commands/vis.ts:50` | `TOKEN_ROTATE_ENV = "BI_VIS_TOKEN_ROTATE"`，值恒为 `"1"` 才启用；config 不加键（schema 零改动） |
| 令牌校验 | `packages/core/src/cli/commands/vis.ts:212`（VisHandlerOptions.tokens）、`vis.ts:296` 附近（`authorized()`） | 注入权威端口后走 `tokens.validate()`（轮转口径：当前令牌恒真、上一代令牌宽限期内双活）；未注入走现状静态令牌比对 |
| 装配链 | `packages/core/src/cli/commands/vis.ts:463` | env 开且宿主注入权威 → 装配轮转权威 + `requireToken=true` + 打印带令牌访问链接；env 关 → 现状路径一字不改；env 开但未注入权威 → 回退静态路径并**如实告警**（不静默降级） |
| 轮转通知 | `vis.ts:468` | 权威 `onRotate` 回调 → 重印新访问链接（旧链接的令牌过期后靠它拿新的） |
| 端口透传 | `packages/core/src/cli/commands/dispatch.ts:289`、`:706` | `SubcommandDeps.visTokenAuthority` → `handleVis` options |
| 轮转引擎侧（新增） | `packages/tui/src/vis/vis-token-authority.ts` | 包 tui 侧器官 `vis/token-rotator.ts`（128-bit / 5 分钟 / 60 秒宽限双活）为「令牌权威端口」；器官文件只读未改 |
| 宿主注入 | `bin/bi.ts:46`、`:285` | `runBi` 的 deps 注入 `createVisTokenAuthority`（tui 侧产物） |

### 依赖方向裁定（工单指定：不许倒置依赖）

- **core 不依赖 tui**：`packages/core` 的 `package.json` 无 `@bi/tui` 依赖，方向恒为 tui → core。故 core 侧只认「令牌权威端口」（`TokenAuthority`：current + validate，与 `core/src/web/vis-handler.ts` 的端口同构），轮转引擎留在 tui 侧，由宿主 `bin/bi.ts` 注入。
- `core/src/web/vis-handler.ts`（vis 服务器器官）**零改动**：其 `TokenAuthority` 端口天然满足 TokenRotator——轮转校验经注入生效，无需改器官文件即满足「启用时令牌校验经 rotator」。
- 两器官文件（`core/src/modes/mode-selector.ts`、`tui/src/vis/token-rotator.ts`）与 `core/src/web/vis-handler.ts`、`tui/src/components/mode-indicator.ts` 均**只读未改**。

### 行为对照

- `BI_VIS_TOKEN_ROTATE` 未设 / 非 "1"：现状静态令牌路径（回环免令牌；非回环强制 `BI_VIS_AUTH_TOKEN`），权威工厂零调用。
- `BI_VIS_TOKEN_ROTATE=1`：令牌校验经 rotator（当前令牌恒真、上一代令牌 60 秒宽限内仍过、过期即 401），打印 `http://127.0.0.1:<port>/?t=<token>` 访问链接。
- 真机实测（`BI_VIS_TOKEN_ROTATE=1 bun bin/bi.ts vis --port 45991`）：无令牌 401 / 带令牌 200 / 错令牌 401 / `Authorization: Bearer` 200。

## 3. 测试

新增 **30** 个用例（全离线，无外呼）：

| 文件 | 新增 | 覆盖 |
|---|---|---|
| `packages/tui/src/mount/mode-command.test.ts`（新增） | 14 | 候选面可发现；命令头识别；`/mode` 无参显示态；切态回执与只读提示；幂等；`unknown-mode` / `unknown-command` 结构化拒绝且不改态；与器官 plan 只读拦截联动 |
| `packages/tui/src/mount/agent-tui.test.ts`（追加 describe） | 5 | REPL 分发面（本地回执、不入模型回合）；plan 进出与权限面 manual 切/复原；非法 id 不改态；**plan 态写工具结构化拒绝 `plan-mode-readonly`**（工具不执行、错误回喂模型）；状态行徽标接活 |
| `packages/tui/src/vis/vis-token-authority.test.ts`（新增） | 5 | 128-bit 令牌；宽限双活（旧令牌宽限内仍过、过期即假）；`graceMs=0` 即时失效；`onRotate` 回调；注入 core vis 处理器后的 200/200/401 路由矩阵 |
| `packages/core/src/cli/commands/vis-token-rotate.test.ts`（新增） | 6 | env 开→走权威（宽限内旧令牌仍过、宽限耗尽即 401、缺令牌 401）；env 开→打印带令牌链接；env 关→现状静态路径（工厂零调用、免令牌回归）；env 关 + 非回环→`BI_VIS_AUTH_TOKEN` 仍生效；env 开但未注入权威→回退并告警；env 值非 "1"→视为关闭 |

## 4. 门禁统计

| 门禁 | 结果 |
|---|---|
| `BI_PTY_E2E=1 bun test` | **4762 pass / 0 fail**（259 文件，52632 expect） |
| `tsc --noEmit -p packages/core/tsconfig.json` | 0 错 |
| `tsc --noEmit -p packages/tui/tsconfig.json` | 0 错 |
| `tsc --noEmit -p tsconfig.json`（根，含 packages/*/src） | 0 错 |
| 红线核查 | 未 commit/push/stash；未改 `schema.ts` / `toolset.ts` / `headless.ts` / `packages/a2a/**`（这些是并行单施工面，本次零触碰）；四个器官文件只读 |

补充：`bin/bi.ts` 不在根 tsconfig 的 include 内（既有缺口），单文件核验时其 `PermissionRule` 未定义报错为 HEAD 既有状态，与本次改动无关。

## 5. 诚实边界

- `/mode` 缺省工作模式取 `build`（非 plan）：plan 会拦写，缺省即拒写不可接受；宿主可经 `TuiSessionOptions.workMode` 覆盖。
- plan 态只读判据是工具级 `readOnly` 标记（与 AgentLoop 同源）；`bash` 整体视为写（`git status` 这类子命令不单独放行）——与器官 `ReadOnlyPort(tool, args)` 口径一致，未做命令级细分。
- 轮转开启后打印的链接带的是**当时**的令牌：令牌每 5 分钟轮转，链接随之失效；CLI 在轮转发生时重印新链接（`onRotate`），进程重启则需重新取链接。
- `accessUrls()`（tui 侧器官，多网卡 URL 列表）未接进 CLI 打印面——core 不得依赖 tui，CLI 打印仅 127.0.0.1 形态；多网卡地址仍留在器官侧待后续卡。
- 仓库内存在两套 vis 实现：`core/src/web/vis-handler.ts`（BI-20.5，TokenAuthority 端口）与 `core/src/cli/commands/vis.ts`（BI-20.5b，`bi vis` 生产路径）。本次按工单口径把轮转接进生产路径（cli/commands/vis.ts 的处理器 + 端口），web 侧器官零改动即天然兼容轮转；两套实现的合并不在本工单范围。
- `/mode` 与 `/permissions` 等斜杠命令的最终分发仍归宿主装配面；本次只按 /compact /rewind 先例把命令对象挂进候选面与统一分发入口。
