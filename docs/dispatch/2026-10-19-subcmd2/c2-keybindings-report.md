All acceptance criteria pass. Final summary:

## 改动/新增文件清单

**新增**
- `packages/tui/src/mount/keybindings.ts` — 动作名→键位注册表：`DEFAULT_KEYBINDINGS`、`normalizeKey`、`keyMatches`、`actionForKey`、`loadKeybindings`（含 `LoadResult`/`IgnoredEntry`/`ConflictEntry`）
- `packages/tui/src/mount/keybindings.test.ts` — 19 个用例（见下）

**修改（仅消费注入，行为零变化）**
- `packages/tui/src/mount/repl.ts` — 导入注册表；`LineEditor` 构造注入 `bindings`（缺省 `DEFAULT_KEYBINDINGS`）；`feed` 的 ctrl 分支改查表；`ReplOptions.keybindings`；`runRepl` 内 Ctrl+F 转发改为 `actionForKey === "search.open"`
- `packages/tui/src/mount/agent-tui.ts` — `TuiSessionOptions.keybindings`；`#bindings` 字段；`handleKey` 搜索态 Enter/Esc/Ctrl+G、开搜索 Ctrl+F 改查表；`ApprovalOverlay` 构造注入并 y/n 查表（Esc 拒绝保留硬编码兜底）
- `bin/bi.ts` — **仅装配这一处**：加载 `.bi/keybindings.json` 一次，告警 stderr 提示，结果传入 `AgentTuiSession` 与 `runRepl`

边界未触碰：`packages/core/src/cli/**`（并行单）、`packages/core/src/export/**`、鼠标/滚轮事件（BI-27.5 原样保留）。

## 默认动作表全文（动作 → 键）

| 动作 | 键 |
|---|---|
| editor.beginning-of-line | ctrl+a |
| editor.backward-char | ctrl+b |
| editor.external-edit | ctrl+e |
| editor.kill-line | ctrl+k |
| editor.kill-line-to-start | ctrl+u |
| editor.kill-word-backward | ctrl+w |
| editor.yank | ctrl+y |
| editor.undo | ctrl+z |
| editor.clear-or-exit | ctrl+c |
| editor.exit | ctrl+d |
| search.open | ctrl+f |
| search.previous | ctrl+g |
| search.next | enter |
| search.close | esc |
| approval.allow | y |
| approval.deny | n |

## 覆盖与冲突语义
- **规范化**：大小写不敏感；`ctrl-`/`ctrl+` 统一归一到 `ctrl+<小写字母>`（`"Ctrl+A"`/`"CTRL+a"`/`"ctrl-a"`→`ctrl+a`）；具名 kind 小写原样；单字符键；非法（空/`ctrl+shift+a`/`foo`）返回 null。
- **加载**：JSON `{动作:"ctrl+a"}` 覆盖默认；文件缺失（ENOENT）= 纯默认；读/解析错误→纯默认 + 一条 `read-error`/`parse-error`（永不 reject）。
- **忽略**：未知动作 / 非法键串 / 非字符串值 → 结构化计入 `ignored`（含 action/key/reason），不影响其余默认。
- **冲突**：两动作绑同键 = 后到覆盖，冲突对 `{key, overridden, by}` 记入 `conflicts` 随结果返回（简单策略，不抛错）。

## 测试数 + tsc
- 新增 `keybindings.test.ts`：**19 个用例**（默认表完整性逐条对照现行为、规范化、覆盖生效、非法输入忽略与计数、冲突告警、repl 路由抽查=默认行为不变+改绑跟随新键）。
- `bun test ./packages/tui/`：**593 pass / 0 fail**（含既有）。
- `cd packages/tui && bunx tsc --noEmit`：**0 错**。
- `bun test ./packages/core/src/cli/`：**270 pass / 0 fail**（装配面连带无破坏）。

## 未尽边界
- 仅消费面注入键位，未做持久化默认表导出/文档（`loadKeybindings` 路径现为 `./.bi/keybindings.json`，可在 bin/bi.ts 调整）。
- `approval.deny` 与结构性的 Esc 拒绝并存（Esc 拒绝未纳入注册表，保持兜底）；鼠标滚轮/翻页/方向/Home/End/Tab/Enter(提交)/Esc(取消) 等结构性键未纳入注册表（本单范围外，避免行为漂移）。
- 未 commit / push（依工单要求）。
