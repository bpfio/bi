# 工单 PROD-3 验收报告：config 键面补六挂载分区

- 日期：2026-10-20
- 范围：`bi config` 命令键注册面扩展至 `[verify]/[subagent]/[ptc]/[cron]/[context]/[memory]`
- 改动文件：`packages/core/src/cli/commands/config.ts`（键面 + get/set/list 缺省解析）、
  `packages/core/src/cli/config.test.ts`（六分区契约测试）
- 硬约束自检：DEFAULT_BI_CONFIG 根键恒 17（未触碰 schema.ts 根表/默认值）；
  未改 `toolset.ts` / `bin/bi.ts` 器官装配门；未 git commit / push。

## 1. 新增键全名单（按分区分组，共 20 个）

键名以 `packages/core/src/config/schema.ts` 实际字段为准，分区前径挂载。

- **verify**（4）：`verify.on_completion`、`verify.objective`、`verify.deliverables`、`verify.checks`
  - `verify.deliverables` / `verify.checks` 为实体数组（sListOf 条目），挂载为键但**单值 set 被 schema 校验拦截**（CLI 单值无法表达结构化条目，设值由 `validateConfigLayer` 拒绝）。get/list 读缺省空数组 `[  ]`。
- **subagent**（5）：`subagent.enabled`、`subagent.max_iterations`、`subagent.timeout_ms`、`subagent.default_profile`、`subagent.btw_enabled`
- **ptc**（3）：`ptc.enabled`、`ptc.timeout_ms`、`ptc.max_tool_calls`
- **cron**（1）：`cron.enabled`
- **context**（5）：`context.time_context`、`context.date_change_sensor`、`context.tool_result_prune`、`context.max_history_entries`、`context.timezone`
- **memory**（2）：`memory.dream_enabled`、`memory.inject_enabled`

> 键面由 schema 推导（单一事实来源），零硬编码：实现新增 `MOUNTED_SECTIONS` 表
> （分区名 → 分区 schema），`configKeySurface()` 在遍历 17 根键默认树之外，额外遍历
> 六分区 schema 的 `defaultValue()` 叶子。合法键总数由 42 → **62**（42 + 20）。

## 2. get/set 缺省语义说明

分区缺省**不在** `DEFAULT_BI_CONFIG`（17 根键不含挂载分区，符合约束 #1）。
`get` / `list` 的生效值解析与 `set` 的强类型化样本均经新增 `withMountedDefaults()` 回填：

- 仅当合并结果中该挂载分区**未显式声明**时，才以分区 schema 缺省补入
  （`merged[section] = schema.defaultValue()`）；已声明分区保持用户合并值不动。
- 该回填**只作用于 config 命令的运行期解析**，绝不改写 `schema.ts` 的
  `DEFAULT_BI_CONFIG` / `createDefaultConfig()`（根键表恒 17）。
- 因此 `bi config get ptc.enabled`（未声明）→ 读到 `ptcSchema` 缺省 `false`，
  与器官装配门（`bin/bi.ts` / `main.ts` 的 `config.ptc?.enabled` 读取点）语义一致：
  未声明恒为缺省 false，逐字节等价缺省路径。

`set` 写盘策略沿用既有 `writebackConfigFile`（`config.toml` 注释保留原子回写），
经 `validateConfigLayer` 校验后落盘（如 `[ptc]\nenabled = true`）。值校验跟随 schema 类型
（bool/number/enum/string），非法值结构化报错并 exit 2。

## 3. 实测输出摘录（临时 homeDir 注入，零触碰真实 ~/.bi）

```
### 1) config get ptc.enabled (缺省)
exit=0 | false

### 2) config get context.timezone (缺省)
exit=0 | Asia/Shanghai

### 3) config set ptc.enabled true
exit=0 | bi config: 已写入 ptc.enabled = true（/tmp/bi-prod3-xxxx/.bi/config.toml）

### 4) config get ptc.enabled (回读)
exit=0 | true

### 5) config set ptc.enabled yes (非法布尔 → exit 2)
exit=2 | bi config: 非法布尔值 "yes"（允许 true | false）

### 6) config set context.max_history_entries huge (非法数字 → exit 2)
exit=2 | bi config: 非法数字 "huge"

### 7) config get 未知挂载子键 ptc.nope (exit 2)
exit=2 | bi config: 未知配置键 "ptc.nope"。

### 8) config list 含新键摘录
ptc.enabled = true
ptc.timeout_ms = 30000
ptc.max_tool_calls = 64
cron.enabled = false
subagent.enabled = false
subagent.default_profile = explore
context.time_context = false
context.timezone = Asia/Shanghai
memory.dream_enabled = false
memory.inject_enabled = false
verify.on_completion = false

### list 总键数 = 62
```

## 4. 门禁数字

- `BI_PTY_E2E=1 bun test`：全量 4651 用例中 **4649 通过 / 2 失败**。
  - 2 失败为 `BI-21 终局演练` 链 4（财报勾稽 xlsx_audit）、链 5（研报生成）——
    端到端演练需联网拉取 web/PDF/xlsx 的 GDP 真值并跑真实模型，**与 PROD-3 无关**。
    已用 `git stash` 排除本工单改动复跑，确认这 2 例在无本改动时**同样失败**（预存、
    环境依赖），非本工单引入。
  - 本工单新增/相关的 `config.test.ts` 共 **21/21 通过**（含 PROD-3 六分区
    get 缺省态 / set/get 往返 / list 含新键 / 非法值四类的契约测试）。
- `cd packages/core && bunx tsc --noEmit`：**0 错误**。
- `cd packages/tui && bunx tsc --noEmit`：**0 错误**。

## 5. 验收小结

键面断层已闭合：六挂载分区共 20 个标量/数组键全部可 `get`（含缺省）/ `set`（跟随 schema
类型校验、写回 config.toml）/ `list`，未知键与非法值结构化报错 exit 2。DEFAULT_BI_CONFIG
根键恒 17，器官装配门与 config 命令缺省语义对齐。
