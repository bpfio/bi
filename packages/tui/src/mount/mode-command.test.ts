/**
 * BI-20.1 接线 —— 四态工作模式命令面（/mode）候选面与分发面验收。
 *
 * 全离线：状态机来自 core 器官（只读不改），只读端口为替身注入。
 */
import { describe, expect, test } from "bun:test";

import {
	DEFAULT_WORK_MODE,
	MODE_COMMAND_NAME,
	dispatchModeCommand,
	isModeCommandLine,
	isModeId,
	modeCommandCandidates,
	modeCommandName,
} from "./mode-command";
import { builtinSlashCandidates } from "./candidate-menu";
import { ModeSelector, type ReadOnlyPort } from "../../../core/src/modes/mode-selector";

/** 只读端口替身：白名单内只读，其余写。 */
function stubPort(readOnlyTools: string[]): ReadOnlyPort {
	return {
		isReadOnly(tool: string, _args: string): boolean {
			return readOnlyTools.includes(tool);
		},
	};
}

function makeSelector(initial: "plan" | "edit" | "build" | "yolo" = DEFAULT_WORK_MODE): ModeSelector {
	return new ModeSelector(stubPort(["read"]), initial);
}

describe("BI-20.1 · /mode 候选面（可发现）", () => {
	test("候选面条目覆盖 mode（name 不含前导 /）", () => {
		expect(modeCommandCandidates.map((c) => c.name)).toEqual([MODE_COMMAND_NAME]);
		for (const candidate of modeCommandCandidates) {
			expect(candidate.description.length).toBeGreaterThan(0);
		}
	});

	test("内置斜杠候选面收录 /mode（菜单可发现）", () => {
		expect(builtinSlashCandidates.map((c) => c.name)).toContain("mode");
	});
});

describe("BI-20.1 · /mode 分发面", () => {
	test("命令头识别：/mode 命中，其余不命中", () => {
		expect(modeCommandName("/mode")).toBe("mode");
		expect(modeCommandName("/mode plan")).toBe("mode");
		expect(modeCommandName("/nope")).toBeUndefined();
		expect(modeCommandName("hello")).toBeUndefined();
		expect(isModeCommandLine("/mode")).toBe(true);
		expect(isModeCommandLine("/mode edit")).toBe(true);
		expect(isModeCommandLine("/permissions")).toBe(false);
		expect(isModeCommandLine("/compact")).toBe(false);
	});

	test("/mode 无参：显示当前态（不切态）", () => {
		const selector = makeSelector("edit");
		const outcome = dispatchModeCommand("/mode", selector);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.mode).toBe("edit");
		expect(outcome.changed).toBe(false);
		expect(outcome.text).toBe("[edit] 当前模式: edit");
		expect(selector.getMode()).toBe("edit");
	});

	test("/mode 无参且当前为 plan：回执带只读提示", () => {
		const selector = makeSelector("plan");
		const outcome = dispatchModeCommand("/mode", selector);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.text).toContain("plan-mode-readonly");
	});

	test("/mode <id>：切态并回执徽标", () => {
		const selector = makeSelector("build");
		const outcome = dispatchModeCommand("/mode yolo", selector);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.mode).toBe("yolo");
		expect(outcome.changed).toBe(true);
		expect(outcome.text).toBe("[yolo] 已切换到 yolo");
		expect(selector.getMode()).toBe("yolo");
	});

	test("/mode plan：切态且回执带只读提示", () => {
		const selector = makeSelector("build");
		const outcome = dispatchModeCommand("/mode plan", selector);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.mode).toBe("plan");
		expect(outcome.text).toContain("plan-mode-readonly");
		expect(selector.getMode()).toBe("plan");
	});

	test("/mode <当前态>：幂等（changed=false，不重复切）", () => {
		const selector = makeSelector("edit");
		const outcome = dispatchModeCommand("/mode edit", selector);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(outcome.changed).toBe(false);
		expect(outcome.text).toBe("[edit] 当前已是 edit");
	});

	test("/mode <非法 id>：结构化拒绝 unknown-mode（不改态）", () => {
		const selector = makeSelector("build");
		const outcome = dispatchModeCommand("/mode turbo", selector);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.code).toBe("unknown-mode");
		expect(outcome.error.message).toContain("turbo");
		expect(selector.getMode()).toBe("build");
	});

	test("未知命令 → unknown-command（不改态）", () => {
		const selector = makeSelector("build");
		const outcome = dispatchModeCommand("/nope", selector);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.error.code).toBe("unknown-command");
		expect(selector.getMode()).toBe("build");
	});

	test("isModeId：四态表白名单", () => {
		expect(isModeId("plan")).toBe(true);
		expect(isModeId("edit")).toBe(true);
		expect(isModeId("build")).toBe(true);
		expect(isModeId("yolo")).toBe(true);
		expect(isModeId("turbo")).toBe(false);
		expect(isModeId("")).toBe(false);
	});
});

describe("BI-20.1 · /mode 与 plan 只读拦截（器官联动）", () => {
	test("切到 plan 后写工具被器官拦截（结构化 plan-mode-readonly）", () => {
		const selector = makeSelector("build");
		expect(selector.intercept("write", "a.ts").allowed).toBe(true);
		dispatchModeCommand("/mode plan", selector);
		const blocked = selector.intercept("write", "a.ts");
		expect(blocked.allowed).toBe(false);
		expect(blocked.code).toBe("plan-mode-readonly");
		expect(blocked.mode).toBe("plan");
	});

	test("切离 plan 后写工具放行", () => {
		const selector = makeSelector("build");
		dispatchModeCommand("/mode plan", selector);
		dispatchModeCommand("/mode edit", selector);
		expect(selector.intercept("write", "a.ts").allowed).toBe(true);
	});

	test("只读工具在 plan 态仍放行", () => {
		const selector = makeSelector("plan");
		expect(selector.intercept("read", "a.ts").allowed).toBe(true);
	});
});
