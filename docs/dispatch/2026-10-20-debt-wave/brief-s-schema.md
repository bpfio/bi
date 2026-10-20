# 工单 S：bi config 键面集中扩展（虚账清偿波次 0，为后续三单并发预置键面）

仓库 /home/yupeng/bi（Bun/TypeScript monorepo CLI Agent）。背景：虚账清偿波次将有三个单并发施工，config schema 是公共冲突区——所有新键由**本单一次加齐**，后续单只消费不定义。

## 任务（两个文件）

### 1. packages/core/src/config/schema.ts（只许加键，不改既有键）
- toolsSchema（含 allow/deny/output_limit_bytes/media/job_tools）追加：
  - `lsp: sBool(false)` — 注释：true = 注册 lsp_navigate 工具（BI-13.2 门控挂载；缺省 false 工具面零变动）。
  - `select_tools: sBool(false)` — 注释：true = 注册 select_tools 工具（BI-13.1 门控挂载；缺省 false）。
- contextSchema（先读现场确认现有键：date_change_sensor/max_history_entries/time_context/timezone/tool_result_prune）追加：
  - `image_offload: sBool(false)` — 注释：true = 接入 BI-08.2 image-offload 管线（渐进图像卸载；缺省 false 行为零变动）。
  - `auto_compactor: sBool(false)` — 注释：true = 接入 BI-10 AutoCompactor token 水位紧缩（缺省 false 走既有条目数门禁裁剪）。

### 2. README.md（键数同步，全仓 grep 核实现值再改）
- 现文档记 config 键面 **62 键**（"62 键 = 42 根键 + 20 挂载分区键"表述+分区键清单）——加 4 键后变 **66 键**。用 `grep -c` 核对实际键数后同步：正文键数表述、分区键清单（tools 分区补 lsp/select_tools，context 分区补 image_offload/auto_compactor）。

### 3. packages/core/src/config/schema.test.ts
- 照现有分区断言模式补 4 键缺省 false 回填断言（一组 describe 即可）。

## 红线
- 不许 commit/push/stash；不改其他任何文件（后续单在等这些键，键名必须与上文逐字一致）
- 注释风格跟随所在文件

## 完成自检并报告
- `cd /home/yupeng/bi/packages/core && bun test src/config/schema.test.ts` 全绿
- `cd /home/yupeng/bi && BI_PTY_E2E=1 bun test` 全绿 + `bunx tsc --noEmit`（core/tui 两包）零错
- 报告：键数核实值（grep 证据）、README 改动处数、测试统计
