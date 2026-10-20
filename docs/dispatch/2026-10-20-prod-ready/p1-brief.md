# 工单 PROD-1：README 生产化重写 + example 配置纠偏（文档面）

## 背景

bi（/home/yupeng/bi，Bun + TypeScript monorepo CLI Agent）功能骨架已齐：11 个子命令
（init/session/fork/export/transfer/acp/upgrade/doctor/vis/config/copy）全部真实接线，
无参裸跑进交互 REPL，`bi doctor` 五项体检可用，`bi init` 可写工作区模板。
但 README.md 停在装配前的旧状态，对新用户完全是误导。

## 硬约束（违反即废工）

1. 只许改：`README.md`、`setting.example.json`、`provider.example.json`（删除或重写均允许）。
   不改任何 .ts 代码。
2. 不许 git commit / git push，完工即止，由主控验收后提交。
3. README 里所有命令示例必须真实可跑（`bun bin/bi.ts ...` 形式），写前逐条实测。

## 任务清单

1. **重写「当前状态」段**：删除「init/session/fork/export/transfer/acp/upgrade/doctor
   子命令尚未接线（exit 4）」「TUI 装配中」「211 个测试文件」等过时断言。
   实测统计当前测试规模：仓库根跑 `bun test` 一次，用真实输出数字（测试文件数/用例数）。
2. **新增「快速上手」节**（四步，逐条实测）：
   - `bun install`
   - `bun bin/bi.ts init`（工作区模板 + BI.md 草稿）
   - 配置 provider：说明配置文件真实路径（`~/.bi/config.toml` 与项目级 `.bi/local.toml`，
     以 `bi init` 实际产物为准）、`providers` 表 + `api_key_env` 间接引用密钥（配置永不落明文），
     给一个最小 TOML 示例（参考仓库根现有配置解析实测行为，`bun bin/bi.ts doctor` 可验证配置装载）。
   - 首单跑通：`BI_XXX_API_KEY=... bun bin/bi.ts --prompt "..." `（无头）与无参 REPL 两种形态。
3. **新增「子命令一览」节**：11 个子命令 + 一句话职责，与 `bun bin/bi.ts --help` 真实文本一致。
4. **新增「配置参考」节**：键面以 `bun bin/bi.ts config get <key>` 可用键为准
   （运行 `bun bin/bi.ts config` 系列命令实测拿列表），按分组列表；说明挂载式分区
   （[verify]/[subagent]/[ptc]/[cron]/[context]/[memory]）config-gated 特性（缺省关）。
   注意：另一个工单正在给 config 键面补六分区，本节按现状 42 键写，不臆造未来键。
5. **example 配置纠偏**：`setting.example.json` 与 `provider.example.json` 是上游 zcode 的
   JSON 遗留形状（storage.dir ~/.zcode、providerConfigRules 等），与 bi TOML 体系完全不符。
   处置：直接删除这两个文件，并在 README「快速上手」中讲清真实配置形态（第 2 步已覆盖）。
   `git rm` 不做——文件删除从工作树移除即可，主控验收时一并提交。
6. **文档链接校验**：README 中相对链接（devplan.md、DEVLOG.md、docs/*）逐条确认目标存在。

## 验收门（自跑，全过才算完工）

- `grep -n "尚未接线\|211 个测试文件" README.md` 零命中。
- README 全部命令示例在仓库根逐条可执行（你自己跑过并留存输出）。
- `bun test` 全绿（确认你没碰坏东西）；`cd packages/core && bunx tsc --noEmit` 0 错误。

## 报告

写 `docs/dispatch/2026-10-20-prod-ready/p1-report.md`：改动清单、每条示例实测输出摘录、
删除两 example 的理由确认、门禁输出末尾数字。
