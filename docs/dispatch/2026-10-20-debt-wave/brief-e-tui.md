# 工单 E：bi TUI/REPL 面接线（BI-11 TokenHud+/compact 三命令 + BI-20 diff 审查门入口）

仓库 /home/yupeng/bi。背景：三组 TUI/命令器官交付时未接产品面（虚账清偿波次 1）。你负责接线，器官全部现成。

## 任务

### 1. BI-11：TokenHud + /compact /rewind /clear 接 TUI mount 与 REPL 命令分发
- 器官：`packages/tui/src/hud.ts`（TokenHud：确定性单行渲染 `Tokens: 42k/128k (32%) | Cache: 88%`）、`packages/core/src/commands/compact.ts`（/compact /rewind /clear 三命令对象+注册表）。先通读三个器官+其测试。
- 接线点：`packages/tui/src/mount/`（先 ls 该目录读现有 mount 结构，TokenHud 挂状态行/提示行区域）与 REPL 命令分发面（找现有斜杠命令注册处：`grep -rn "slashCommand\|builtinSlashCandidates\|commands" packages/tui/src packages/core/src/cli --include=*.ts | grep -v test` 找注册表，把 compact.ts 三命令对象挂进候选与分发）。
- HUD 数据源：token 用量事件——TUI 会话回路里已有 usage/token 事件流（BI-11.1 telemetry 与 AgentTuiSession 的事件面），接线把流数据喂给 TokenHud 渲染并上屏到状态行。找不到现成事件面就把 HUD 渲染挂到会话 done/usage 事件更新点。
- /rewind /clear 的实际执行语义以 core commands/compact.ts 现有命令对象为准（它们可能只做会话级操作声明——若执行体需要 SessionManager 注入，照现有命令的依赖注入先例接）。

### 2. BI-20：diff 审查门 CLI/TUI 入口
- 器官：`packages/tui/src/diff-view.ts`（644 行：parseDiff/buildDiffFromFiles/交互审查门）。现状：仅库面+测试，无生产导入方。
- 接线点：先读器官导出面与 `packages/tui/src/index.ts` 现状。最小入口=edit/write 工具执行前的 diff 预览（找 TUI 会话里工具审批/展示回路，将 diff-view 渲染挂进去）或 REPL /diff 命令（对工作区 `git diff` 跑 parseDiff 展示）。**选侵入面最小的一个**入口交付，另一个入口留注释备案。

### 3. 测试
- 接线层测试照所在文件现有模式补：三命令在分发面可被发现与执行（替身注入）、HUD 渲染上屏断言、diff 入口渲染断言。
- 既有全仓测试零回归是硬门槛。

## 红线
- 不许 commit/push/stash；不改 schema.ts、toolset.ts、headless.ts、packages/a2a/**、packages/mcp/**（并行单施工面）；packages/core/src/commands/compact.ts 只读不改（执行体在 TUI 侧接）
- 注释/缩进跟随所在文件

## 报告要求（格式从简，先落盘后润色——不要花篇幅自省格式）
- 完成自检：`cd /home/yupeng/bi && BI_PTY_E2E=1 bun test` 全绿 + `cd packages/tui && bunx tsc --noEmit` 零错
- 报告：接线点（文件:行）、入口选择与理由（一行）、新增测试数、门禁统计。直接写文件 /tmp/brief-e-report.md，写完一句话收尾即可。
