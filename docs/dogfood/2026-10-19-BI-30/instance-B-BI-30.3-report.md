工单 BI-30.3 完成。

## 改动文件清单（5 个）

| 文件 | 改动 |
|---|---|
| `packages/core/src/cli/commands/args.ts` | `--output-format` 白名单 → `["stream-json","text"]`；`OutputFormat` 类型扩为 `"stream-json" \| "text"`（附形态语义注释）。**未触碰**主控线的 `--max-rounds` 脚手架 |
| `packages/core/src/cli/commands/args.test.ts` | 白名单用例同步：非法值 `text`→`json`；合法值用例改为 stream-json / text 双通过；`allowedValues` 断言 → `["stream-json","text"]`。**未触碰** max-rounds 用例 |
| `packages/core/src/cli/headless.ts` | ① `HeadlessOptions.outputFormat?`（缺省 `"stream-json"` = 现状行为，契约不变）；② `emit` 按形态门控——text 下事件（content_delta/usage/done…）照旧内部流转但不落 `out`；③ 终局分支：text 只 `out(finalText)` 一段，`session_done` 等 meta 不落 out（含 hook-blocked 分支的 meta 也被门控）；错误/诊断仍由抛 `HeadlessError` → 装配方 `err` 报出；④ 模块头文档改写为双形态说明 |
| `packages/core/src/cli/main.ts` | 接线行 1 条：`...(parsed.outputFormat !== undefined ? { outputFormat: parsed.outputFormat } : {})`（缺省留给 headless 决定） |
| `packages/core/src/cli/headless.test.ts` | 新增 `BI-30.3` 两个 describe、5 个用例：text 形态（注入伪 ModelPort + out 收集器，断言 `lines` 恰为 `[finalText]`、工具/回合内部流转不收敛）、stream-json 缺省与显式同形回归、runBi 三条接线用例（`--output-format text` out=finalText、text 下模型错误 out 空/err 有/exit 1、不传缺省仍 stream-json 末行 session_done） |

## 测试结果（窄范围，零网络）

- `bun test packages/core/src/cli/commands/args.test.ts` → **19 pass / 0 fail**
- `bun test packages/core/src/cli/headless.test.ts` → **12 pass / 0 fail**（含新增 5 条）
- 相邻回归：`exec-drill.test.ts + subcommands.test.ts` → **23 pass / 0 fail**；bin e2e `BI_PTY_E2E=1 bun test scripts/fake-endpoint-e2e.test.ts` → **2 pass / 0 fail**（stream 形态断言不破）
- `bun x tsc --noEmit -p packages/core/tsconfig.json` → **exit 0**

## 遗留问题

1. **并行实例工作树波动**：过程中另一实例把未提交改动（`bin/bi.ts`、`packages/tui/**`、args/main 的 --max-rounds）stash（`bi30-verify`）又恢复，我全程未动未回滚；现 `git diff HEAD` 可见他人改动与我的改动并存完好，stash 条目已被对方清理。若对方再次 `stash pop`，args.ts/args.test.ts/main.ts 为双方共同修改文件，可能需自行解一次并集冲突（内容均为非重叠语义）。
2. text 形态下 `finalText` 为空串时 out 会收到一个空行（按"恰为一段 finalText"字面实现）；若产品面要"空则零输出"需另开小卡定。
3. `RunBiOptions.headless` 的 `Pick` 未加 `outputFormat`（CLI 面已由 argv 解析接入；测试走 argv 或直接调 runHeadless）。如需 deps 层透传可再加一行。
4. `main.ts` 的 `USAGE` 文案仍只列 `stream-json`——按"改动限定在接线行"未越界改，建议主控线顺手补 `stream-json|text`。