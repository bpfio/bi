/**
 * BI-21 工位 H 域级演练 J —— 命令与钩子链。
 *
 * 链路:custom-commands 单遍扫描(frontmatter 发现 → argsSpec 解析 → $1/$ARGUMENTS
 * 展开注入安全)→ shell-expansion(变量展开 + 引号参数解析)→ hook-runner
 * 生命周期事件序列(伪执行器,I/O 边界)→ compact/rewind/clear 命令门。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	discoverSlashCommands,
	expandCommand,
	parseArgsSpec,
	slashCommandSurface,
	parseFrontmatter,
	type CommandFs,
} from "../commands/custom-commands";
import { expandShellVars, parseShellArgs } from "../commands/shell-expansion";
import { compactCommand, rewindCommand, clearCommand } from "../commands/compact";
import { HookRunner, parseHookOutput, type HookSpawnImpl } from "../hooks/hook-runner";
import { HOOK_EVENTS, type HooksConfig } from "../hooks/types";

const roots: string[] = [];
afterAll(async () => {
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

/** 内存 CommandFs(命令发现 I/O 边界注入)。 */
function memFs(files: Record<string, string>): CommandFs {
	return {
		readdir: async (path) => Object.keys(files).filter((f) => f.startsWith(path + "/")).map((f) => f.slice(path.length + 1)),
		readFile: async (path) => {
			const hit = files[path];
			if (hit === undefined) throw new Error(`ENOENT: ${path}`);
			return hit;
		},
	};
}

describe("BI-21 域 J —— 命令与钩子", () => {
	test("J1 custom-commands:单遍扫描发现 + argsSpec + 单遍展开注入安全", async () => {
		const dir = join(tmpdir(), "bi21-j-cmds");
		roots.push(dir);
		const files: Record<string, string> = {
			[`${dir}/audit.md`]: [
				"---",
				"name: audit",
				"description: 公报审计命令",
				'args: <doc> [limit]',
				"---",
				"审计 $1 上限 $2,全部参数:{{args}}",
			].join("\n"),
			// 无 frontmatter:文件名派生命令名
			[`${dir}/status.md`]: "会话状态一览,无参数",
			// 坏 frontmatter:缺失分隔符 → 告警不中断
			[`${dir}/broken.md`]: "---\nname: broken\n",
		};
		const fs = memFs(files);
		const disc = await discoverSlashCommands([dir], fs);
		expect(disc.commands.map((c) => c.name)).toEqual(["audit", "status"]);
		expect(disc.warnings.length).toBe(1);
		expect(disc.warnings[0]!.file).toContain("broken.md");

		const audit = disc.commands.find((c) => c.name === "audit")!;
		expect(audit.requiredArgs).toEqual(["doc"]);
		expect(audit.optionalArgs).toEqual(["limit"]);
		// argsSpec 解析器与发现结果一致
		expect(parseArgsSpec("<doc> [limit]")).toEqual([["doc"], ["limit"]]);

		// 单遍扫描展开:$1/$2/{{args}} 各就位
		const expanded = expandCommand(audit, ["国统字〔2026〕87 号", "5"]);
		expect(expanded.ok).toBe(true);
		if (expanded.ok) {
			expect(expanded.text).toBe("审计 国统字〔2026〕87 号 上限 5,全部参数:国统字〔2026〕87 号 5");
		}
		// 缺必选参数 → 结构化拒绝
		const missing = expandCommand(audit, []);
		expect(missing).toMatchObject({ ok: false, error: { code: "missing-required", missing: ["doc"] } });

		// 注入安全:$1 展开产物含 $ARGUMENTS 字面时不二次展开(出现 2 处均为
		// 直接产物:$1 本体 + {{args}} 全参回显;若重扫则会被再展开成嵌套产物)
		const injected = expandCommand(audit, ["$ARGUMENTS", "x"]);
		if (injected.ok) {
			expect(injected.text).toContain("$ARGUMENTS x");
			expect(injected.text.match(/\$ARGUMENTS/g)?.length).toBe(2);
		}

		// TUI 补全面
		const surface = slashCommandSurface(disc.commands);
		expect(surface.map((s) => s.name)).toContain("audit");
	}, 30_000);

	test("J2 shell-expansion:变量展开 + 引号参数解析 + ~ 展开", () => {
		// ${VAR} / $VAR / 未知保留 / \$ 转义
		const env = { DOC: "国统字〔2026〕87 号", HOME: "/home/drill" };
		expect(expandShellVars("审计 ${DOC} 第 $HOME 页", env)).toBe("审计 国统字〔2026〕87 号 第 /home/drill 页");
		expect(expandShellVars("${MISSING}", env)).toBe("${MISSING}");
		expect(expandShellVars("\\${DOC}", env)).toBe("${DOC}");

		// 参数解析:单双引号 + 反斜杠 + ~ 展开
		expect(parseShellArgs("cat 'a b.txt' \"c\\\"d\" plain", { home: "/home/drill" })).toEqual([
			"cat", "a b.txt", 'c"d', "plain",
		]);
		expect(parseShellArgs("~/ledger.txt ~/x", { home: "/home/drill" })).toEqual(["/home/drill/ledger.txt", "/home/drill/x"]);
	}, 30_000);

	test("J3 hook-runner:生命周期事件匹配 + 决策聚合 + 信任门 + shell-scan 门", async () => {
		const executions: { command: string; stdin: string }[] = [];
		const spawnImpl: HookSpawnImpl = async (command, opts) => {
			executions.push({ command, stdin: opts.stdin });
			// 钩子协议:stdout 末行 JSON 决策
			if (command.includes("blocker")) {
				return { code: 0, signal: null, stdout: '{"action": "block", "reason": "审计未过"}', stderr: "", timedOut: false };
			}
			return { code: 0, signal: null, stdout: '{"action": "allow"}', stderr: "", timedOut: false };
		};
		const scanShell = (cmd: string) => cmd.includes("eval")
			? { opaque: true, dangerous: false, statements: [], reasons: ["dynamic-execution:eval"], heredocs: [], redirects: [], input: cmd }
			: { opaque: false, dangerous: false, statements: [], reasons: [], heredocs: [], redirects: [], input: cmd };
		const config: HooksConfig = {
			hooks: [
				{ event: "PreToolUse", command: "echo allow-hook" },
				{ event: "PreToolUse", command: "eval $EVIL" }, // shell-scan 拒绝
				{ event: "PreToolUse", command: "echo blocker-hook" },
				{ event: "SessionStart", command: "echo session-hook" }, // 不同事件
				{ event: "PostToolUse", command: "echo post-hook", blocking: false },
			],
		};
		const runner = new HookRunner({
			config,
			spawnImpl,
			trust: () => "trusted",
			scanShell,
		});

		const outcome = await runner.run("PreToolUse", { event: "PreToolUse", tool: "Bash", args: { cmd: "ls" }, cwd: "/tmp/ws", timestamp: "2026-10-17T00:00:00Z" });
		// 事件匹配:allow-hook 执行,eval-hook 被 scan 门拒(skipped-opaque),blocker-hook 执行后 block 短路
		expect(outcome.ran).toBe(2);
		expect(outcome.action).toBe("block");
		expect(outcome.reason).toBe("审计未过");
		expect(outcome.records).toHaveLength(3);
		expect(outcome.records[1]).toMatchObject({ status: "skipped-opaque" });
		// stdin 携带 HookInput JSON(权威 event 覆盖)
		expect(JSON.parse(executions[0]!.stdin)).toMatchObject({ event: "PreToolUse", tool: "Bash" });

		// 咨询性钩子:blocking=false → block 降级为 allow + 记录
		const consult = await runner.run("PostToolUse", { event: "PostToolUse", tool: "Bash", cwd: "/tmp/ws", timestamp: "x" });
		expect(consult.action).toBe("allow"); // post-hook allow;若 block 则降级
		// 无匹配事件 → 零执行直接放行
		const none = await runner.run("SessionEnd", { event: "SessionEnd", cwd: "/tmp/ws", timestamp: "x" });
		expect(none.ran).toBe(0);
		expect(none.action).toBe("allow");

		// 信任门:untrusted → 零 spawn,结构化拒绝记录
		const untrusted = new HookRunner({ config, spawnImpl, trust: () => "untrusted", scanShell });
		const blocked = await untrusted.run("PreToolUse", { event: "PreToolUse", cwd: "/tmp/ws", timestamp: "x" });
		expect(executions.length).toBe(3); // 未新增 spawn
		expect(blocked.records.every((r) => r.status !== "ran")).toBe(true);

		// 事件枚举完备:20 种生命周期事件
		expect(HOOK_EVENTS.length).toBe(20);
	}, 30_000);

	test("J4 hook 协议解析 + compact/rewind/clear 命令门", async () => {
		// 末行决策 JSON 提取:噪声行透传
		const noisy = parseHookOutput('日志行 1\n日志行 2\n{"action": "ask", "reason": "确认?"}');
		expect(noisy).toMatchObject({ ok: true, output: { action: "ask", reason: "确认?" } });
		// 空输出 / 非法 action → 结构化错误
		expect(parseHookOutput("")).toMatchObject({ ok: false });
		expect(parseHookOutput('{"action": "nope"}')).toMatchObject({ ok: false });

		// /compact:空参 undefined,其余整体为提示词;execute 走端口
		let compacted: string | undefined | "unset" = "unset";
		let rewound = 0;
		let cleared = 0;
		const ctx = {
			compact: { compact: (p?: string) => { compacted = p; } },
			rewind: { rewind: (n: number) => { rewound = n; } },
			clear: { clear: () => { cleared += 1; } },
		};
		const c1 = compactCommand.parse("");
		expect(c1.ok).toBe(true);
		if (c1.ok) compactCommand.execute(c1.args, ctx);
		expect(compacted).toBeUndefined();
		const c2 = compactCommand.parse("保留 953680 指标");
		expect(c2.ok).toBe(true);
		if (c2.ok) compactCommand.execute(c2.args, ctx);
		expect(compacted).toBe("保留 953680 指标");

		// /rewind:正整数门;非法 steps 结构化拒绝
		const r1 = rewindCommand.parse("2");
		expect(r1.ok).toBe(true);
		if (r1.ok) rewindCommand.execute(r1.args, ctx);
		expect(rewound).toBe(2);
		expect(rewindCommand.parse("0")).toMatchObject({ ok: false, error: { code: "invalid-steps" } });
		expect(rewindCommand.parse("abc")).toMatchObject({ ok: false, error: { code: "invalid-steps" } });

		// /clear:无参
		const clr = clearCommand.parse("");
		expect(clr.ok).toBe(true);
		if (clr.ok) clearCommand.execute(clr.args, ctx);
		expect(cleared).toBe(1);
	}, 30_000);
});
