工单 TUI-ALIGN-4b 完成。结论清单：

## 改动/新增文件

**新增**
- `packages/tui/src/mount/mouse-cursor.ts` — `promptClickToCursor(click, {draft,cursor,cols,promptRow})` 纯函数（零 TTY），含 `\r\n?/\n→⏎` 摊平+码元映射 helper
- `packages/tui/src/mount/mouse-cursor.test.ts` — 换算矩阵 13 例

**改动**
- `packages/tui/src/engine/diff-renderer.ts` — `ParsedKey` 增 `mouse-click` + `x/y`(0 基)；导出 `parseSgrMouse(params, release)`/`SgrMouseEvent` 纯函数；`dispatchCsi` 接线（cjk 无关零动）
- `packages/tui/src/components/cjk-width.ts` — 最小扩展：导出 `PROMPT_PREFIX_WIDTH`、`promptLineWindow()`（start/end/startCol/cursorCol）；`layoutPromptLine` 改为委托，输出逐字节不变（cjk-width 20 例全绿为证）
- `packages/tui/src/mount/repl.ts` — `LineEditor.setCursor(n)`（越界钳制，最小接口）；`runRepl` 滚轮分支后插入 mouse-click 分支；头注+键位路由文档
- `packages/tui/src/engine/diff-renderer.test.ts` — SGR 解析 +8 例；`packages/tui/src/mount/repl.test.ts` — 接线 +4 例（含 setCursor 单元）

**未碰**（符合边界）：`bin/bi.ts`（1000 模式本就含按下/释放上报，无需动模式串）、键位注册表文件、`packages/core/**`；未 commit 未 push。

## 事件语义（SGR 解析）
`ESC[<b;x;y M`(按下)/`m`(释放)：**b=0 按下 → `mouse-click`(x-1,y-1)**；b=64/65 按下 → wheel-up/down（BI-27.5 原样，其释放不派发）；释放终字 / 拖动(b&32) / 中右键(b&3≠0) / 修饰组合(shift=4/alt=8/ctrl=16) / 残容(非 `<数字;数字;数字` 三段、非数字) → 一律忽略。

## 点击落点矩阵（换算）
| 条件 | 结果 |
|---|---|
| y ≠ promptRow(rows-1) | undefined（转录区/状态行忽略） |
| 点中前缀 ❯（未滚） | 光标 0；横滚中 → 窗口起点 |
| 可见列 = max(0, x−2)；目标列 = 窗口起始列+可见列，落点超光标列扣回 ▏ 占的 1 列 | 按字素宽度步行定位 |
| 落在 CJK 宽字符右半 | 对齐该字素码元起点 |
| 目标列 ≥ 草稿总显示宽 / 空草稿 | 贴末尾 / 0 |
| 多行草稿 | 摊平行定位，⏎ 位映射到换行序列起点 |
| 路由 | 仅 idle 且非搜索态生效；审批/运行态经 dispatchKey 落空、搜索态被搜索路由吞掉（v1=忽略） |

## 测试与门禁
- 新增 25 例（换算 13 + SGR 8 + 接线 4），全绿
- `BI_PTY_E2E=1 bun test ./packages/tui/` → **618 pass / 0 fail**（33 文件）
- `packages/tui bunx tsc --noEmit` → **0 错**；root tsc 亦 0 错
- pty 回归 `scripts/pty-repl.test.ts` → 1 pass；全仓 `bun test` → 4434 pass / 0 fail

## 未尽边界
- 转录区点击仅忽略（无文本选区/无跳转，v1）；修饰键点击忽略；拖动选择不支持（1000 模式不上报 motion）
- 多行草稿按摊平行换算，不做视觉行↔逻辑行映射；残容中 'a' 类终字区字节会提前成框、残余按普通键（既有 InputLoop 成框行为，已备案不断言漏派）
