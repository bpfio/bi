/**
 * BI-11 接线 —— 手动门三命令（/compact /rewind /clear）候选面与分发面验收。
 *
 * 全离线：命令对象来自 core（只读不改），执行体为替身注入（记录调用）。
 */
import { describe, expect, test } from "bun:test";

import {
	GATE_COMMAND_NAMES,
	gateCommandCandidates,
	gateCommandName,
	isGateCommandLine,
	dispatchGateCommand,
} from "./gate-commands";
import { builtinSlashCandidates } from "./candidate-menu";
import type { CommandContext } from "../../../core/src/commands/compact";

/** 替身执行体：记录三命令的调用参数。 */
function fakePorts(): { ctx: CommandContext; calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		ctx: {
			compact: {
				compact: (prompt) => {
					calls.push(`compact:${prompt ?? ""}`);
				},
			},
			rewind: {
				rewind: (steps) => {
					calls.push(`rewind:${steps}`);
				},
			},
			clear: {
				clear: () => {
					calls.push("clear");
				},
			},
		},
	};
}

describe("BI-11 · 三命令候选面（可发现）", () => {
	test("候选面条目覆盖三命令（name 不含前导 /）", () => {
		expect(gateCommandCandidates.map((c) => c.name)).toEqual(["compact", "rewind", "clear"]);
		for (const candidate of gateCommandCandidates) {
			expect(candidate.description.length).toBeGreaterThan(0);
		}
	});

	test("内置斜杠候选面收录三命令（菜单可发现）", () => {
		const names = builtinSlashCandidates.map((c) => c.name);
		for (const name of GATE_COMMAND_NAMES) {
			expect(names).toContain(name);
		}
	});

	test("内置斜杠候选面收录 diff 审查门入口（BI-20 接线）", () => {
		expect(builtinSlashCandidates.map((c) => c.name)).toContain("diff");
	});
});

describe("BI-11 · 三命令分发面", () => {
	test("命令头识别：/compact /rewind /clear 命中，其余不命中", () => {
		expect(gateCommandName("/compact")).toBe("compact");
		expect(gateCommandName("/rewind 3")).toBe("rewind");
		expect(gateCommandName("/clear")).toBe("clear");
		expect(gateCommandName("/nope")).toBeUndefined();
		expect(gateCommandName("hello")).toBeUndefined();
		expect(isGateCommandLine("/compact 提炼要点")).toBe(true);
		expect(isGateCommandLine("/permissions")).toBe(false);
	});

	test("/compact：余参整体作提示词，执行体收到 prompt", () => {
		const { ctx, calls } = fakePorts();
		const outcome = dispatchGateCommand("/compact 保留架构决策", ctx);
		expect(outcome).toEqual({ ok: true, command: "compact" });
		expect(calls).toEqual(["compact:保留架构决策"]);
	});

	test("/compact 无参：提示词缺省（undefined）", () => {
		const { ctx, calls } = fakePorts();
		const outcome = dispatchGateCommand("/compact", ctx);
		expect(outcome.ok).toBe(true);
		expect(calls).toEqual(["compact:"]);
	});

	test("/rewind 3：执行体收到 steps", () => {
		const { ctx, calls } = fakePorts();
		const outcome = dispatchGateCommand("/rewind 3", ctx);
		expect(outcome).toEqual({ ok: true, command: "rewind" });
		expect(calls).toEqual(["rewind:3"]);
	});

	test("/clear：执行体无参触发", () => {
		const { ctx, calls } = fakePorts();
		const outcome = dispatchGateCommand("/clear", ctx);
		expect(outcome).toEqual({ ok: true, command: "clear" });
		expect(calls).toEqual(["clear"]);
	});

	test("参数校验：/rewind 缺参与非正整数 → invalid-steps，执行体零调用", () => {
		for (const line of ["/rewind", "/rewind 0", "/rewind -1", "/rewind 2.5", "/rewind abc"]) {
			const { ctx, calls } = fakePorts();
			const outcome = dispatchGateCommand(line, ctx);
			expect(outcome.ok).toBe(false);
			if (!outcome.ok) expect(outcome.error.code).toBe("invalid-steps");
			expect(calls).toEqual([]);
		}
	});

	test("参数校验：/clear 带参 → unexpected-argument，执行体零调用", () => {
		const { ctx, calls } = fakePorts();
		const outcome = dispatchGateCommand("/clear now", ctx);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("unexpected-argument");
		expect(calls).toEqual([]);
	});

	test("未知命令 → unknown-command（不触执行体）", () => {
		const { ctx, calls } = fakePorts();
		const outcome = dispatchGateCommand("/nope", ctx);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("unknown-command");
		expect(calls).toEqual([]);
	});
});
