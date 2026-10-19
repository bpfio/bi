# 工单 ORGAN-WIRE W3-D8 完成结论清单

## 改动文件清单（器官本体只读消费，零提交零推送）
1. **`packages/core/src/cli/toolset.ts`** — 双工具注册主体
   - `BuildDefaultToolsetOptions` 增 `ptcDeps?` / `cronService?`（依赖注入门）
   - 新增 `runPtcScriptBinding`（5 件只读白名单转发）+ `cronBindings`（cron_schedule/list/remove 三件，委托既有 `CronTools`），均条件注册
   - 导出 `PTC_READONLY_WHITELIST` / `ptcReadonlyBindings` / `cronBindings`
2. **`packages/core/src/config/schema.ts`** — 挂载式 `[ptc]`/`[cron]` 两分区（`enabled` 缺省 false，不进 17 根键 → `DEFAULT_BI_CONFIG` 仍 17 键零变化；`BiConfig` 类型扩展）
3. **`packages/core/src/cli/headless.ts`** — `HeadlessOptions` 增 `cronService?` 透传 seam + runHeadless 一处合并（headless 装配限一行）
4. **`packages/core/src/cli/main.ts`** — `ptcDeps` 经 config `[ptc]` 门装配进 `buildDefaultToolset`（h.tools 缺省时自建）
5. **`bin/bi.ts`** — TUI 路径接 `ptcDeps` 门；headless 路径改由 main 自建工具集（统一门控）
6. **新增测试**：`cli/ptc-toolset.test.ts`(10)、`cli/cron-toolset.test.ts`(6)

## 两工具语义
- **run_ptc_script**：输入 `{script}` → `PtcRunner` 单轮执行；脚本内 `await tools.<name>(args)` 程序化调用。
  - 注册门：`config [ptc] enabled` 缺省 false，仅注入 `ptcDeps` 才挂，缺省工具面零变动
  - 白名单：`read_file/grep/glob/web_search/web_fetch` 五件只读子集；`bash/edit/write` 不开放（双重保险：PtcRunner `knownTools` + executor 白名单双重拒绝，**程序化调用禁写禁执行**，安全边界写头注）
  - 边界：单轮 `timeoutMs`（缺省 30s）、`maxToolCalls`（缺省 64）有界
- **cron_schedule / cron_list / cron_remove**：委托 `CronTools` 做条目管理/列表/注销两动作注册。
  - 注册门：`config [cron] enabled` 缺省 false，仅注入 `cronService` 才挂
  - 安全备案：**绝不假冒"已可定时执行"** —— 定时触发（CronService.tick→onFire）归宿主运行环；core 不 import workflow，`CronCorePort` 由 host 注入

## 测试数 + tsc
- 新增 16 用例；全仓 `bun test ./packages/core/src/`：**2902 pass / 0 fail**
- `cd packages/core && bunx tsc --noEmit`：**0 错**（整仓 root tsc 同样 0 错）
- 覆盖：PTC 跑通/白名单外拒绝/超时边界/调用上限/注册门；cron 生命周期/非法表达式结构化/注册门；缺省零变化对照（既有 toolset/subagent/config 断言全绿）

## 未尽边界（备案）
- 真实 `CronCorePort`（workflow parseCron/nextFire）由宿主运行环注入；core CLI 缺省不 import workflow，故 `cron_schedule` 在真实 CLI 仅当 host 提供 `cronService` 才具解析能力，定时触发执行本单不做（明确不假冒）。
- PTC 五件子集为进程内回读，测试走 tmp 工作区 + fetch 替身，零实弹零网络。
