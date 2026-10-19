# W1-D3 结论清单（BI-08.1 + BI-11.1 + BI-21.1）

## 改动文件清单（8 个，既有测试零改动）

| 文件 | 性质 |
|---|---|
| `packages/core/src/config/schema.ts` | 三开关 schema + `[verify]` 挂载式根拓扑 |
| `packages/core/src/cli/headless.ts` | 三开关接线面 + `buildVerifyContract` |
| `packages/core/src/cli/main.ts` | config→runHeadless 装配 + err 面脱敏 |
| `packages/core/src/verifier/target-verifier.ts` | 仅追加 `export`（DEFAULT_SHELL_RUNNER，行为零变） |
| `packages/core/src/config/w1d3-switches.test.ts` | 新（19 例） |
| `packages/core/src/cli/w1d3-headless-wire.test.ts` | 新（16 例） |
| `packages/core/src/cli/w1d3-main-wire.test.ts` | 新（8 例） |

未触边界：toolset.ts/tools//interaction/（D1）、dispatch.ts/cli/commands//subagent//bin/bi.ts（D2）均未动；未 commit 未 push。

## 三个开关的语义与缺省值

1. **[tools] `output_limit_bytes`**（缺省 `0`=off）：>0 时 headless 工具**成功输出**（executor 内、PostToolUse 前）经 `boundToolText` 两级预算截断，仅 bounded 时替换为带钉死标记行 `[... output truncated: N chars / M lines omitted ...]` 的文本；未超限/≤0 原值原样返回。错误路径、非字符串未超限值均不截。
2. **[telemetry] `sanitize_errors`**（缺省 `false`）：true 时会话错误文本输出前经 `sanitizeErrorPayload`——覆盖 headless 全部 HeadlessError 抛出口（经 `failSession` 收敛）与 main 的 `bi: 会话失败:` err 面；verify 失败时 stream-json 线上 gaps（含 stderr 回显）同样脱敏。二次应用幂等，无重复脱敏副作用。
3. **[verify] `on_completion`**（缺省 off）：true 时 headless 收尾分支（stop 判定后）跑 `TargetVerifier.verify(contract, 会话cwd)`。通过=原路输出+`HeadlessResult.verification` 回执；不通过=stream-json 末行 `session_done exit:"verify-failed"`（gaps 结构化上路）+ throw `HeadlessError("verify-failed")`（消息携 formatGaps、error.verification 携结构化 gaps），main 转 exit 1——**不假冒成功**。CommandRunner 缺省注入 target-verifier 既有 `DEFAULT_SHELL_RUNNER`（已追加导出），测试可注入替身。

## config schema 键面（snake_case，沿用仓库 TOML 约定）

```toml
[tools]
output_limit_bytes = 0            # sInt；≤0=off

[telemetry]
sanitize_errors = false           # sBool

[verify]                          # 挂载式分区：显式声明才物化
on_completion = false
objective = ""
[[verify.deliverables]]           # sEntity fail-closed：path/must_exist/must_contain
[[verify.checks]]                 # sEntity：id/command/description（TOML 仅能声明 command 检查）
```
三级 TOML 拓扑（config.toml/tui.toml/local.toml）、键级合并、local 覆盖均沿用；未新增 ENV_OVERRIDES。`buildVerifyContract` 恒转 `tolerance:"best-effort"`（收完整自愈清单），kind 恒 `"command"`。

**关键设计决策（撞硬约束后的重设计）**：工单要求的 `[verify]` 新根分区会使 `schema.test.ts:22`（钉死 17 根分区）变红，违反最高优先级硬约束。采用**挂载式拓扑**：`[verify]` 在校验期从原始输入摘出单独校验，不进默认值形状——`DEFAULT_BI_CONFIG`/`createDefaultConfig()` 恒 17 键（pin 回归有测试钉死），配置层未声明时 `config.verify === undefined`；显式声明才物化并由 backfill 补叶子默认。TOML 键面与工单规格逐字一致。

## 测试数 + tsc

- **本单新增 43 例全绿**：缺省值/17 根键回归/单层校验/合并+backfill/ConfigService 三级端到端（19）；截断 off 逐字节等价+单行确定性算例（72 头留/428 省略，实测反证器官预算）+多行保头尾+恰好上限不截+对象值 stringify+错误路径不截（7）；脱敏 on/off 对照+凭据样例（2）；verifier off 不跑/通过回执/失败两路（deliverable 缺失、命令 exit≠0、text 形态、脱敏联动）+buildVerifyContract（7）。
- **全量 `bun test ./packages/core/src/`：2816 pass / 1 fail / 152 files**。唯一失败 `exec-drill.test.ts`（BI-28.4）系并行 D1 工单在途的 toolset.ts 未提交改动（期望 9 工具含 AskUserQuestion、实收 8）——已两次用 `git stash` 撤下本单全部改动复跑实证同红，与本单无关。
- **`cd packages/core && bunx tsc --noEmit`：0 错**（基线时存在的一条 D1 测试文件错误已由其工单自行修复）。
- **`bun test ./packages/tui/`：618 pass / 0 fail**，不红。

## 缺省等价性证明方式

1. **配置面**：DEFAULT_BI_CONFIG 仍 17 键（测试钉死 toEqual）；未声明 `[verify]` 时 `load()` 结果无 verify 键（`"verify" in config === false`）；tools/telemetry 新键缺省 0/false。
2. **行为面**：三开关缺省时 runHeadless 不触达 boundToolText/sanitizer/verifier——off 对照测试断言超大工具输出**同一字符串原样穿越**（模型回填含 5000 字符原文）、错误消息含原始凭据、无 verification 回执；main 层"注入 model 未注 config=无配置面"回归同样原样。
3. **既有面**：全部 2758 例基线测试零改动且通过计数一致（+59 全部来自本单 43 例与并行工单新文件）。

## 未尽边界（备案）

- **spill 落盘未接线**：config 无 logDir 面，`fullOutputPath` 恒 undefined——截断后省略内容不可回收，仅标记行告知省略量（BI-08.1 spill 预留位保持预留）。
- **脱敏面边界**：回注模型的 tool_result 错误文本（会话内部上下文）不脱敏；model 装配期 err 诊断（exit 3 路径）不脱敏；`error.verification` 进程内结构化数据保持原样（输出面已脱敏）。
- **verify 失败退出码复用 1**（会话失败既有码），未 invent 新码；gap 回注模型自愈续跑的回路（TUI 挂载）不在本单范围。
- 空 `[verify]` 契约恒过（声明面为空=无可验项）；on_completion=true 但 deliverables/checks 全非法时 fail-safe 落到 off 并记 issue。
- `[verify]` 为 `BiConfig` 可选键（挂载式拓扑的固有不对称），TUI /config 面板若需展示该分区需另行适配（本次未动 TUI，618 例不红）。
