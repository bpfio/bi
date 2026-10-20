# 工单 F：bi TUI/web 面接线包二（BI-20.1 四态切换器入口 + BI-20.5 令牌轮转接 vis）

仓库 /home/yupeng/bi。虚账清偿波次 2。两器官现成，你做接线。

## 任务

### 1. BI-20.1 四态模式切换器入口（/mode 命令）
- 器官：`packages/core/src/modes/mode-selector.ts`（ModeId=plan/edit/build/yolo 循环状态机，plan 态只读端口拒绝）。先通读器官+测试。
- **设计裁定（已定，照做）**：与 BI-28.3 权限三态门（manual/auto/yolo）**并存不合并**——mode-selector 是工作模式（plan 只读语义），权限面继续走 permission-mode；plan 态激活时把 PermissionGate 切到 manual+只读约束的方式以两者现有接缝最小实现。
- 接线：REPL /mode 命令（进 `packages/tui/src` 现有命令注册/候选面——参考 /compact /rewind 三命令的接线先例，它们已由并行单接好，读其模式照做）+ TUI 模式指示（`packages/tui/src/components/mode-indicator.ts` 已有 MODE_LABELS 引用，接活）。
- 命令语义：/mode 无参=显示当前态；/mode <id>=切换；plan 态进入时结构化提示只读生效。

### 2. BI-20.5 令牌轮转接 bi vis 成品
- 器官：`packages/tui/src/vis/token-rotator.ts`（128-bit 令牌/5 分钟轮转/60 秒宽限双活）+ `packages/core/src/web/vis-handler.ts`（vis 服务器，含令牌校验）。
- **设计裁定（已定）**：vis v1（`packages/core/src/cli/commands/vis.ts`）头注明示"v1 不做令牌轮转"——本次把轮转做成**vis 的可选增强**：config 无新键（不加 schema），以环境变量 `BI_VIS_TOKEN_ROTATE=1` 显式启用；启用时 vis-handler 的令牌校验改为经 TokenRotator 校验（含宽限双活），关闭时走现状静态令牌路径。
- 接线面：读 vis-handler.ts 的令牌校验函数与 cli/commands/vis.ts 的装配链，最小侵入接入；跨包依赖方向注意（tui 的 token-rotator 被 core 引用是否合理——若 core 不能依赖 tui，把轮转校验接在 tui 侧 vis 集成层或用注入端口，以现有分层为准，不许倒置依赖）。

### 3. 测试
- /mode 命令分发面测试+plan 只读结构化拒绝测试（照器官既有测试模式）；
- 令牌轮转：env 开启时 vis-handler 校验走 rotator（宽限窗口内旧令牌仍过）、关闭走现状（回归）。

## 红线
- 不许 commit/push/stash；不改 schema.ts、toolset.ts、headless.ts、packages/a2a/**（并行单施工面）；两器官文件只读
- 报告格式从简先落盘：/tmp/brief-f-report.md，一句话收尾

## 自检
- `BI_PTY_E2E=1 bun test` 全绿 + core/tui 双包 tsc 零错；报告接线点/依赖方向裁定/新增测试数/门禁统计
