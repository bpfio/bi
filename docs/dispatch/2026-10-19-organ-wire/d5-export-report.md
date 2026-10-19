## 结论清单

**改动文件清单**（未触碰 dispatch.ts / bin/bi.ts / session/ / toolset.ts；未 commit/push）
- `packages/core/src/export/html-exporter.ts` — 双主题 + 插件面
- `packages/core/src/cli/commands/export.ts` — `theme` 选项 + `invalid-theme` 校验
- `packages/core/src/export/html-exporter.test.ts` — 新增 10 例（不改既有 12 例）
- `packages/core/src/cli/commands/export.test.ts` — 新增 3 例（不改既有用例）

**主题语义与 light 色表要点**
- `renderHtml(meta, entries, options?)` 新增 `options.theme: "dark"|"light"`，缺省 `"dark"`；`options` 未传 / 传 `{}` 与原 2 参产物逐字节一致（已用 `toBe` 回归断言锁死）。
- `HTML_THEMES = ["dark","light"] as const` 为单一事实源，export.ts 复用校验。
- light 色表自拟、与 Dark 同构（Catppuccin 风浅色）：页面 `#eff1f5`、文本 `#4c4f69`、卡片 `#e6e9ef`、边框 `#ccd0da`、强调 `#8839ef`、pre `#dce0e8`，`color-scheme: light`。ANSI 调色板沿用 `ansi-to-html.ts` 固定值（双主题一致，未动）。

**插件面契约**
- `ToolHtmlRenderer { callHtml?(entry), resultHtml?(result) }` 按 `toolName` 索引（`ToolHtmlRenderers`），覆盖 tool_call「输入」/ tool_result「输出」区。
- 责任边界写进文件头注：宿主**直接插入、不做任何转义/二次转义**，渲染器须自负责 HTML 转义（可复用 `escapeHtml`）；未命中（无对应 toolName 或钩子缺省）回退默认 `escapeHtml/ansiToHtml` 路径，默认产物逐字节不变。
- CLI 面本单不暴露（纯库面），备案。

**测试 + tsc**
- `bun test ./packages/core/src/cli/commands/ ./packages/core/src/export/` → **186 pass / 0 fail**（含原 12 例零改动全绿、dark 逐字节回归、light 结构、非法 theme、插件命中/未命中回退/不二次转义契约）。
- `cd packages/core && bunx tsc --noEmit` → **0 错**。

**未尽边界**
- `dispatch.ts` 的 `--theme` 旗标解析与退出码映射（当前 `invalid-theme` 会走 `? 1` 分支而非专属码）归属并行工单 D6，未触碰；本单仅将 `theme` 接入 `exportSession` 库面并完成合法值校验（非法 → 结构化 `invalid-theme`）。待 D6 接线实际 `--theme` argv 即可生效。
