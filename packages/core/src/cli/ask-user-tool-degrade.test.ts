/**
 * BI-07.10 装配验收 —— ask_user_question 注册进 buildDefaultToolset + 交互降级安全。
 *
 * 关注面：
 * - 缺省（未注入 userQuestionService）注册表不含 ask_user_question（既有 8 件不变）。
 * - 注入后注册；headless（askUserInteractive=false）结构化返回
 *   {answered:false,reason:"no-interactive"}，不调用 service（无挂起 IO），不悬挂不抛。
 * - 可交互（askUserInteractive=true）走既有语义：非法结构 → ok:false invalid-request；
 *   block 全流程 → ok:true + answers（host 注入 resolve 落定）。
 *
 * 既有 ask 用例（user-questions.test.ts）零改动前提下，本文件仅新增装配面覆盖。
 */
import { describe, expect, test } from "bun:test";
import { buildDefaultToolset, type SpawnImpl } from "./toolset";
import type { ToolBinding } from "./headless";
import { UserQuestionService } from "../interaction/user-questions";
import { AskUserTool } from "../interaction/ask-user-tool";

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

describe("BI-07.10 · 注册门：仅注入 service 才挂面（既有 8 件零变动）", () => {
	test("缺省 buildDefaultToolset 不含 AskUserQuestion", () => {
		const names = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }).map((t) => t.definition.name);
		expect(names).not.toContain("AskUserQuestion");
	});

	test("注入 userQuestionService 后 AskUserQuestion 在表（readOnly=true）", () => {
		const tools = buildDefaultToolset("/tmp", {
			spawnImpl: explodingSpawn(),
			userQuestionService: new UserQuestionService(),
		});
		const ask = byName(tools, "AskUserQuestion");
		expect(ask.definition.name).toBe("AskUserQuestion");
		expect(ask.readOnly).toBe(true);
	});
});

describe("BI-07.10 · headless 降级安全（无 TTY：结构化返回、不悬挂、不抛、无 IO）", () => {
	test("binding（askUserInteractive=false）：任何参数都返回 {answered:false,reason:'no-interactive'}，service 无 pending（未调用 IO）", async () => {
		const service = new UserQuestionService();
		const ask = byName(
			buildDefaultToolset("/tmp", {
				spawnImpl: explodingSpawn(),
				userQuestionService: service,
				askUserInteractive: false,
			}),
			"AskUserQuestion",
		);
		// 即便给出合法 block 参数（本应挂起等待 resolve），headless 也立即返回，绝不悬挂。
		const raw = (await ask.execute(
			{
				questions: [{ id: "a", question: "q", header: "h", options: [{ label: "y" }, { label: "n" }] }],
			},
			SIGNAL,
		)) as string;
		expect(JSON.parse(raw)).toEqual({ answered: false, reason: "no-interactive" });
		// 未触碰 service：没有挂起的提问（无挂起 IO 回调）。
		expect(service.pending()).toHaveLength(0);
	});

	test("AskUserTool 类（interactive=false）：不调用 service.ask，立即结构化返回", async () => {
		const service = new UserQuestionService();
		const tool = new AskUserTool(service, { interactive: false });
		const result = await tool.run({
			questions: [{ id: "a", question: "q", header: "h", options: [{ label: "y" }] }],
		});
		expect(result).toEqual({ answered: false, reason: "no-interactive" });
		expect(service.pending()).toHaveLength(0);
	});
});

describe("BI-07.10 · 可交互语义（askUserInteractive=true）：校验 + block 全流程", () => {
	test("非法结构 → ok:false invalid-request（结构化，不抛）", async () => {
		const ask = byName(
			buildDefaultToolset("/tmp", {
				spawnImpl: explodingSpawn(),
				userQuestionService: new UserQuestionService(),
				askUserInteractive: true,
			}),
			"AskUserQuestion",
		);
		for (const args of [null, { questions: [] }, { questions: [{ id: "x" }] }]) {
			const raw = (await ask.execute(args, SIGNAL)) as string;
			expect(JSON.parse(raw)).toMatchObject({ ok: false, code: "invalid-request" });
		}
	});

	test("block 全流程：host 注入 resolve → ok:true + answers（无悬挂）", async () => {
		const service = new UserQuestionService();
		const ask = byName(
			buildDefaultToolset("/tmp", {
				spawnImpl: explodingSpawn(),
				userQuestionService: service,
				askUserInteractive: true,
			}),
			"AskUserQuestion",
		);
		const pending = ask.execute(
			{
				questions: [{ id: "a", question: "q", header: "h", options: [{ label: "y" }, { label: "n" }] }],
			},
			SIGNAL,
		);
		// 模拟宿主注入回答（挂起落定）。
		expect(service.resolve("q-1", [{ questionId: "a", selected: ["y"] }])).toBe(true);
		const raw = (await pending) as string;
		expect(JSON.parse(raw)).toEqual({
			ok: true,
			pending: false,
			callId: "q-1",
			answers: [{ questionId: "a", selected: ["y"] }],
			cancelled: false,
		});
	});
});
