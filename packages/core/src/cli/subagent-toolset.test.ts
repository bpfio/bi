/**
 * BI-07.4 装配验收 —— spawn_subagent 注册进 buildDefaultToolset（条件注册门）。
 *
 * 关注面（先例照抄 ask_user_question）：
 * - 缺省（未注入 subagentRunner）注册表不含 spawn_subagent（既有工具面零变动）。
 * - 注入后注册；readOnly=true；其 execute 调 runner.spawn 并把 summary 结构化回传。
 * - 非法 profile 兜底 explore（绝不把非法角色透传给 runner 触发 TypeError）。
 */
import { describe, expect, test } from "bun:test";
import { buildDefaultToolset, type SpawnImpl } from "./toolset";
import type { ToolBinding } from "./headless";
import type { SubagentRunner } from "../subagent/runner";

const SIGNAL = new AbortController().signal;

function explodingSpawn(): SpawnImpl {
	return () => {
		throw new Error("test-guard: spawn 不应被调用");
	};
}

function byName(tools: readonly ToolBinding[], name: string): ToolBinding {
	const found = tools.find((t) => t.definition.name === name);
	if (found === undefined) throw new Error(`test-setup: 工具 ${name} 未注册`);
	return found;
}

/** 最小替身 runner：仅实现 spawn 契约（脚本化返回）。 */
function stubRunner(): SubagentRunner {
	return {
		spawn: async () => ({
			childSessionId: "c-1",
			parentSessionId: undefined,
			profileType: "explore",
			ok: true,
			summary: "child-done",
			toolCalls: 0,
		}),
	} as unknown as SubagentRunner;
}

describe("BI-07.4 · 注册门：仅注入 subagentRunner 才挂 spawn_subagent", () => {
	test("缺省 buildDefaultToolset 不含 spawn_subagent", () => {
		const names = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }).map((t) => t.definition.name);
		expect(names).not.toContain("spawn_subagent");
	});

	test("注入 subagentRunner 后 spawn_subagent 在表（readOnly=true）；execute 调 spawn 回传 summary", async () => {
		const calls: Array<{ p: unknown; g: unknown; o: unknown }> = [];
		const runner = {
			spawn: async (p: unknown, g: unknown, o: unknown) => {
				calls.push({ p, g, o });
				return { childSessionId: "c-1", parentSessionId: undefined, profileType: p, ok: true, summary: "S", toolCalls: 0 };
			},
		} as unknown as SubagentRunner;

		const tool = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), subagentRunner: runner }),
			"spawn_subagent",
		);
		expect(tool.readOnly).toBe(true);

		const raw = (await tool.execute({ goal: "找 X", profile: "explore" }, SIGNAL)) as string;
		const parsed = JSON.parse(raw);
		expect(parsed.ok).toBe(true);
		expect(parsed.summary).toBe("S");
		expect(parsed.childSessionId).toBe("c-1");
		expect(calls[0]).toMatchObject({ p: "explore", g: "找 X" });
		expect(calls[0]!.o).toEqual({}); // 主会话侧 spawn 不带 parentSessionId（子会话与主隔离）
	});

	test("非法/缺省 profile 兜底 explore（不抛 TypeError）", async () => {
		const calls: Array<{ p: unknown }> = [];
		const runner = {
			spawn: async (p: unknown) => {
				calls.push({ p });
				return { childSessionId: "c-1", parentSessionId: undefined, profileType: p, ok: true, summary: "S", toolCalls: 0 };
			},
		} as unknown as SubagentRunner;
		const tool = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), subagentRunner: runner }),
			"spawn_subagent",
		);
		const bad = (await tool.execute({ goal: "g", profile: "???" }, SIGNAL)) as string;
		expect(JSON.parse(bad).profileType).toBe("explore");
		const missing = (await tool.execute({ goal: "g" }, SIGNAL)) as string;
		expect(JSON.parse(missing).profileType).toBe("explore");
		expect(calls).toHaveLength(2);
	});

	test("goal 缺失：结构化失败回传（不抛）", async () => {
		const tool = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), subagentRunner: stubRunner() }),
			"spawn_subagent",
		);
		const raw = (await tool.execute({}, SIGNAL)) as string;
		const parsed = JSON.parse(raw);
		expect(parsed.ok).toBe(false);
		expect(parsed.summary).toContain("goal");
	});
});
