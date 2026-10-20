# 工单 PROD-3：config 键面补六挂载分区（verify/subagent/ptc/cron/context/memory）

## 背景

bi（/home/yupeng/bi，Bun + TypeScript monorepo CLI Agent）在 ORGAN-WIRE 战役中装配了
六个 config-gated 器官分区，schema 在 `packages/core/src/config/schema.ts`
（[verify]/[subagent]/[ptc]/[cron]/[context]/[memory]，挂载式分区——不进
DEFAULT_BI_CONFIG 的 17 根键）。但 `bi config` 命令的键注册面没有跟进：
`bi config get ptc` 报「未知配置键 ptc」，合法键 42 个全为旧 17 根键展开。
器官装配了却配不了，是生产化断层。

## 硬约束（违反即废工）

1. `DEFAULT_BI_CONFIG` 根键数恒为 17，不许把六分区默认值塞进根键。
2. 缺省路径零行为差：不碰器官装配的条件注册逻辑（`packages/core/src/cli/toolset.ts`、
   `bin/bi.ts` 的门），只扩 config 命令的键面。
3. 不许 git commit / git push。

## 任务清单

1. **锚点**：`packages/core/src/cli/commands/config.ts`（键注册面、42 键定义与
   get/set/list 实现）、`packages/core/src/config/schema.ts`（六分区 schema 与缺省值）、
   `packages/core/src/cli/commands/config.test.ts`（既有测试形状）。
2. **键面扩展**：六分区各自 schema 键全部注册进 config 合法键面，键名用分区前径
   （如 `ptc.enabled`、`ptc.timeout_ms`、`context.time_enabled` 等，以 schema.ts 实际字段为准）。
   「未知配置键」报错里的合法键列表同步扩容。
3. **get/set/list 全通**：`bi config get <分区键>` 读分区值（含缺省值——注意分区缺省不在
   DEFAULT_BI_CONFIG，要从 schema 缺省或分区解析器取，值语义与器官装配门
   （bin/bi.ts、main.ts 的 config.ptc.enabled 等读取点）一致）；
   `bi config set <分区键> <value>` 写入用户配置文件（跟随既有 set 的写盘策略）；
   list/枚举输出含分区键。先读清既有 get/set 对合法键的实现策略再动手，保持同构。
4. **值校验**：分区键 set 的值校验跟随 schema 类型（bool/number/string），
   非法值结构化报错 exit 2。
5. **测试**：六分区键的 get（缺省态与显式态）/set/list/非法值四类契约测试补齐。

## 验收门（自跑，全过才算完工）

- `BI_PTY_E2E=1 bun test` 全绿。
- `cd packages/core && bunx tsc --noEmit` 0 错误；`cd packages/tui && bunx tsc --noEmit` 0 错误。
- 实测留痕：`bun bin/bi.ts config get ptc.enabled`（缺省 false）、
  `config set ptc.enabled true` + 回读、非法值报错、list 含新键——各留输出摘录。

## 报告

写 `docs/dispatch/2026-10-20-prod-ready/p3-report.md`：新增键全名单（按分区分组）、
get/set 缺省语义说明（分区缺省从哪取）、实测输出摘录、门禁数字。
