我已读取两份工单简报、`custom-commands.ts`(确认未改),并交叉核验了 `bin/bi.ts`、`headless.ts`、`main.ts`、`args.ts`、`agent-tui.ts` 的工作树实际内容与 diff 一致,以及 `headless.test.ts` 引用的测试辅助符号(`scriptedModel`/`TOOL_ROUND`/`readFileSyncBinding`/`makeWorkspace`/`runBi`/`runHeadless`)均存在。

环境说明:本环境无 `Bash`/`git` 工具,无法执行 `git status` 或 `bun test` 复核测试是否"全绿"。以下结论基于提供的 `git diff HEAD` 全文 + 直接读取工作树文件交叉验证;测试运行结果未经我实跑确认。

## 结论(通过)

三工单验收标准在代码与测试层面均已满足,未发现 high/medium 缺陷。

## 缺陷清单

- **bin/bi.ts:113(low, 文案微调)**: 已知内置候选未接线回执由 `候选菜单可用` 改为 `内置候选`。属 bin/bi.ts(BI-30.1 范围)内文案微调,`/permissions` 与未知命令分支语义未变,不在验收保护清单内;若团队对文案有锁定需保持原措辞,否则可接受。非阻断。
- **packages/core/src/cli/headless.ts:293(low, edge)**: text 形态下若末轮 assistant 文本为空,`out(finalText)` 仍会落一个空行。验收只要求"只落 finalText 一段",此 edge 不违反契约;如需健壮可加 `if (finalText !== "") out(finalText)`。非阻断。
- **无 high / medium 缺陷**。

## 契约符合性(逐条)

**BI-30.1**
- agent-tui.ts `TuiSessionOptions.slashCommand` 返回 `Promise<string | { prompt: string }>`(agent-tui.ts:178 类型签名 + agent-tui.ts:355 `#slashCommand` 字段) — 符合。
- `string` 本地形态:submit 内 `typeof outcome === "string"` 走 `#transcribe("system", …)`、`endedAs:"finish"`、不入模型回合/不落 JSONL(agent-tui.ts:605-616);测试 `string 本地形态` 断言 `l3` 含 `[system]`、`[user]` 为零、JSONL 条目为 0 — 符合。
- `{ prompt }` 形态:`turnPrompt = outcome.prompt` 改写本回合用户输入,正常落 model 回合(agent-tui.ts:617、639-640),JSONL 记 user/assistant、转录 `[user]/[assistant]` 无 system 行;测试 `{ prompt } 形态` 断言 `messages[0].content==="总结: 日志"`、`entries==["user","assistant"]`、`[system]` 行不存在 — 符合。
- bin/bi.ts 保留完整注册表 `customCommands = discovered.commands`(bin/bi.ts:82),执行面按名 `find` 后 `expandCommand(command, argv)`(bin/bi.ts:104-110);`ok → {prompt: expanded.text}`、`!ok → expanded.error.message`(string)— 符合。
- `/permissions` 语义不变:`head==="/permissions"` 优先分支、未知命令回执文案 `未知斜杠命令…(可用: /permissions)` 未变(bin/bi.ts:97-103、115)— 符合。
- `custom-commands.ts` 本体未修改(已读全文,未出现在 diff)— 符合约束。

**BI-30.3**
- `OutputFormat` 白名单 `["stream-json","text"]`(args.ts:62)、`type OutputFormat = "stream-json" | "text"`(args.ts:67)— 符合。
- headless 新增 `outputFormat` 选项、缺省 `"stream-json"`(headless.ts:90-92、157);text 形态 `emit` 在 stream-json 才落盘、终局仅 `out(finalText)`、session_done 等 meta 不落 out(headless.ts:160-162、291-296)— 符合。
- 错误仍走 err:text 错误经 StreamEvent `error` → 抛 `HeadlessError` → main.ts `catch` 经 `err("bi: 会话失败: …")` 返回 1(headless.ts:276-278、main.ts:186-190);测试断言 `outs==[]`、`errs` 含 `会话失败` 与 `server` — 符合。
- main.ts 接线 `parsed.outputFormat`(main.ts:177-178),且不传时省略→headless 缺省 stream-json(现状不变)— 符合。
- 既有 stream e2e(`--output-format stream-json`,headless.test.ts:260)契约未破 — 符合。

**--max-rounds 脚手架**
- 正整数校验:`/^[1-9]\d*$/.test(value)`,非法抛 `invalid-value`(args.ts:176-178);负数 `-3` 因 `next.startsWith("-")` 先抛 `missing-value`(args.ts:151-158),与 `--prompt` 遇 `-` 同规 — 符合,且 args.test.ts 相应断言(`-3`→missing-value、`0/2.5/abc`→invalid-value)对齐。
- CLI 优先于 deps 透传:main.ts `parsed.maxRounds ?? h.maxRounds`(main.ts:180-182),CLI 设值即覆盖 deps — 符合。

## 边界检查

- 改动文件全部落在三工单范围:`bin/bi.ts`、`packages/tui/src/mount/agent-tui.ts`、`packages/tui/src/mount/agent-tui.test.ts`(BI-30.1);`packages/core/src/cli/commands/args.ts`、`args.test.ts`、`headless.ts`、`headless.test.ts`、`main.ts`(BI-30.3 + --max-rounds 脚手架)。
- 约束文件 `custom-commands.ts` 未出现在 diff 且经读取确认未改动 — 满足"只消费不修改"。
- **未发现范围外越界改动**(基于提供的 `git diff HEAD` 全文;因无 git 工具,未能用 `git status` 二次确认是否存在 diff 未涵盖的其它未提交改动,建议评审合入前补一次 `git status` 核验)。
- 测试真实性:`agent-tui.test.ts` 新增 `{prompt}` 用例三则(含展开失败 !ok)、`headless.test.ts` 新增 text/stream 双形态与 main 接线用例,逻辑与实现对齐;但**测试"全绿"未经我实跑验证**(环境无 bun/git)。
