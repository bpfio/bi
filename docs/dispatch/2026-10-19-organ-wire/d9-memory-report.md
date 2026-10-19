# ORGAN-WIRE W4-D9(BI-05.1) 完成清单

装配已落地并验证通过。

## 改动文件清单
- `packages/core/src/config/schema.ts`（+36行）：新增 `[memory]` 挂载式分区（`memorySchema` = `dream_enabled` / `inject_enabled`，均 `sBool(false)`），并接入 `BI_CONFIG_SCHEMA` 校验/backfill/`BiConfig` 类型——**不进 17 根键**，缺省 `config.memory === undefined`。
- `packages/core/src/cli/headless.ts`（+88行）：消费面装配。
  - 启动注入：`systemParts` 先 push `systemInstruction`(agent-file)，再 append `BI.dream.md` 内容（缺省态/文件缺失 try-catch 跳过）。
  - 收尾沉淀：finalText 落定时若 `idleMs >= DEFAULT_DREAM_IDLE_MS` 调 `consolidate([finalText], …)`，锁/合并/幂等全走器官既有常量与逻辑。
  - 新增 `HeadlessMemoryOptions` / `Dream` / `Inject` 接口（全部可注入 `fs`/`now`/`extractor`/`dir` 以支持确定性测试）。
- `packages/core/src/cli/main.ts`（+14行）：`config.memory` → headless `memory` 选项映射（`dream_enabled`→`dream:{dir:cwd}`，`inject_enabled`→`inject:{dir:cwd}`），缺省不传=全关。
- 新增测试（未跟踪）：`packages/core/src/cli/w4d9-dream-memory.test.ts`（12 例）、`packages/core/src/config/w4d9-memory-config.test.ts`（11 例）。

## 沉淀与注入语义
- **沉淀**：仅 `[memory] dream_enabled=true` 且空闲阈值 ≥30min（`DEFAULT_DREAM_IDLE_MS`）时触发；写 `<cwd>/BI.dream.md`，由 `consolidate` 走 `.consolidate-lock` 原子锁互斥、stale 1h 接管、append-only 合并（`## dream @ <iso>` + `- <精华>`），无新增不写盘。
- **注入**：仅 `[memory] inject_enabled=true` 时启动读 `<cwd>/BI.dream.md`，存在则 trim 后经 `systemInstruction` 前缀注入；与 `--agent-file` 共存时 **agent-file 优先、dream 追加其后**（顺序用 `systemParts.push` 顺序 + `indexOf` 断言钉死）。

## config 键面
`[memory]` 挂载分区，两个布尔开关，缺省全 `false`：`dream_enabled`、`inject_enabled`。

## 测试数 + tsc
- 新增 **23 例全绿**（headless 12 + config 11）。
- 全量 `bun test ./packages/core/src/`：**2937 pass / 2 fail**（2 失败属 `evals/e2e-drill.test.ts` BI-21 终局演练，需联网/模型/xlsx，已 `git stash` 证明在 HEAD 同样失败，**与本次改动零相关、零回归**）。
- `cd packages/core && bunx tsc --noEmit`：**0 错**。
- 既有测试零改动。

## 未尽边界（备案，按工单允许）
- **doctor 健康面**：未做（工单“可做可不做”）。
- **CLI 面 `bi dream` 手动触发**：未暴露（归后续备案）。
- **边界约束遵守**：`cli/commands/**`、`export/`、`session/`、`subagent-adapter.ts`、`toolset.ts` 未动；`memory/dream.ts` 本体只读消费；未 commit/未 push。
- **注入面缺省零行为差**：`inject_enabled=false` 时文件即使存在也不读（已测“缺省等价”）；沉淀阈值为“恰好到达即触发”语义（`<` 不沉淀，已覆盖）。
