/**
 * BI-07.10 测试 — UserQuestionService（block/timed/迟到回答/取消/校验）+ AskUserTool。
 */
import { describe, expect, test } from "bun:test";
import type { Clock } from "../guard/deadline";
import {
	UserQuestionError,
	UserQuestionService,
	lateAnswerText,
	type AskResult,
	type UserAnswer,
	type UserQuestion,
} from "./user-questions";
import { ASK_USER_QUESTION_TOOL_SPEC, AskUserTool } from "./ask-user-tool";

/** 假时钟：手动 advance 触发到期计时器，记录 clearTimeout 清理。 */
function fakeClock() {
	let nowMs = 1_000;
	const timers: Array<{ fn: () => void; at: number; cleared: boolean }> = [];
	const clock: Clock = {
		now: () => nowMs,
		setTimeout: (fn, ms) => {
			const timer = { fn, at: nowMs + ms, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
	};
	const advance = (toMs: number) => {
		nowMs = toMs;
		for (const timer of timers) {
			if (!timer.cleared && timer.at <= toMs) {
				timer.cleared = true;
				timer.fn();
			}
		}
	};
	return { clock, timers, advance };
}

function makeService() {
	const box = fakeClock();
	let n = 0;
	const service = new UserQuestionService({
		clock: box.clock,
		idGen: () => `q-${++n}`,
	});
	return { service, ...box };
}

function ask(
	service: UserQuestionService,
	overrides?: Partial<{ mode: "block" | "timed"; timeoutMs: number }>,
): Promise<AskResult> {
	return service.ask({
		questions: [
			{
				id: "db",
				question: "选哪个数据库？",
				header: "存储",
				options: [
					{ label: "SQLite", description: "零运维", recommended: true },
					{ label: "Postgres" },
				],
			},
		],
		mode: overrides?.mode,
		timeoutMs: overrides?.timeoutMs,
	});
}

function answers(pairs: Array<[string, string[]]>): UserAnswer[] {
	return pairs.map(([questionId, selected]) => ({ questionId, selected }));
}

describe("BI-07.10 · block 全流程（PendingQuestion → resolve 落定）", () => {
	test("resolve 落定 ask Promise：answered + answers 原样返回", async () => {
		const { service } = makeService();
		const pending = ask(service);
		expect(service.resolve("q-1", answers([["db", ["SQLite"]]]))).toBe(true);
		const result = await pending;
		expect(result).toEqual({
			pending: false,
			callId: "q-1",
			answers: [{ questionId: "db", selected: ["SQLite"] }],
			cancelled: false,
		});
	});

	test("resolve 前 pending() 可见，快照深拷贝（外改不污染内部）", () => {
		const { service } = makeService();
		const pendingPromise = ask(service);
		const snapshot = service.pending();
		expect(snapshot).toHaveLength(1);
		expect(snapshot[0]).toMatchObject({ callId: "q-1", mode: "block", status: "pending", deadlineAt: null });
		expect(snapshot[0]!.questions[0]!.options[0]!.recommended).toBe(true);
		snapshot[0]!.questions[0]!.header = "篡改";
		expect(service.pending()[0]!.questions[0]!.header).toBe("存储");
		void pendingPromise;
	});

	test("resolve 幂等：已答再答拒绝（false，ask 已落定不受扰）", async () => {
		const { service } = makeService();
		const pending = ask(service);
		expect(service.resolve("q-1", answers([["db", ["SQLite"]]]))).toBe(true);
		expect(service.resolve("q-1", answers([["db", ["Postgres"]]]))).toBe(false);
		const result = await pending;
		expect((result as { answers: UserAnswer[] }).answers[0]!.selected).toEqual(["SQLite"]);
	});

	test("resolve 未知 callId → false", () => {
		const { service } = makeService();
		expect(service.resolve("q-none", answers([["db", ["SQLite"]]]))).toBe(false);
	});

	test("cancel：落定 cancelled + answers null；取消后 resolve/cancel 均拒绝", async () => {
		const { service } = makeService();
		const pending = ask(service);
		expect(service.cancel("q-1")).toBe(true);
		const result = await pending;
		expect(result).toEqual({ pending: false, callId: "q-1", answers: null, cancelled: true });
		expect(service.resolve("q-1", answers([["db", ["SQLite"]]]))).toBe(false);
		expect(service.cancel("q-1")).toBe(false);
	});

	test("cancel 未知 callId → false；pending() 清空（终态不再可见）", async () => {
		const { service } = makeService();
		expect(service.cancel("q-none")).toBe(false);
		const pending = ask(service);
		await service.cancel("q-1");
		expect(service.pending()).toHaveLength(0);
		void pending;
	});

	test("block 模式不挂计时器（timers 零记录，无泄漏面）", () => {
		const { service, timers } = makeService();
		void ask(service);
		expect(timers).toHaveLength(0);
	});
});

describe("BI-07.10 · timed 计时挂起与迟到恢复", () => {
	test("到点回执 { pending: true, callId, timeoutMs }；deadlineAt = createdAt + timeoutMs", async () => {
		const { service, advance } = makeService();
		const pending = service.ask({
			questions: [
				{
					id: "deploy",
					question: "现在部署吗？",
					header: "发布",
					options: [{ label: "go" }, { label: "abort" }],
				},
			],
			mode: "timed",
			timeoutMs: 500,
		});
		expect(service.pending()[0]!.deadlineAt).toBe(1_500);
		advance(1_500);
		const result = await pending;
		expect(result).toEqual({ pending: true, callId: "q-1", timeoutMs: 500 });
	});

	test("到点后 resolve 结构化拒绝（not pending），须走 lateAnswer", async () => {
		const { service, advance } = makeService();
		const pending = ask(service, { mode: "timed", timeoutMs: 100 });
		advance(1_100);
		await pending;
		expect(service.resolve("q-1", answers([["db", ["SQLite"]]]))).toBe(false);
	});

	test("迟到提交：lateAnswer → true；takeLateAnswers 一次性消费（二调为空）", async () => {
		const { service, advance } = makeService();
		const pending = ask(service, { mode: "timed", timeoutMs: 100 });
		advance(1_100);
		await pending;
		expect(service.lateAnswer("q-1", answers([["db", ["Postgres"]]]))).toBe(true);
		const messages = service.takeLateAnswers();
		expect(messages).toHaveLength(1);
		expect(messages[0]!.role).toBe("user");
		expect(messages[0]!.callId).toBe("q-1");
		expect(messages[0]!.answers).toEqual([{ questionId: "db", selected: ["Postgres"] }]);
		expect(messages[0]!.text).toBe(lateAnswerText("q-1", [{ questionId: "db", selected: ["Postgres"] }]));
		expect(messages[0]!.text).toContain("q-1");
		expect(messages[0]!.text).toContain("db=Postgres");
		expect(service.takeLateAnswers()).toHaveLength(0);
		expect(service.pending()).toHaveLength(0);
	});

	test("迟到回答文本确定性：同输入逐字节同输出", () => {
		const a = answers([
			["q1", ["A", "B"]],
			["q2", ["C"]],
		]);
		expect(lateAnswerText("call-9", a)).toBe(lateAnswerText("call-9", a));
		expect(lateAnswerText("call-9", a)).toBe("[迟到用户回答] 提问 call-9：q1=A/B；q2=C");
	});

	test("未到点 lateAnswer → false（须先 resolve 或等超时）", () => {
		const { service } = makeService();
		void ask(service, { mode: "timed", timeoutMs: 100 });
		expect(service.lateAnswer("q-1", answers([["db", ["SQLite"]]]))).toBe(false);
	});

	test("迟到回答幂等：一个 callId 只收一条迟到消息，二拒", async () => {
		const { service, advance } = makeService();
		const pending = ask(service, { mode: "timed", timeoutMs: 100 });
		advance(1_100);
		await pending;
		expect(service.lateAnswer("q-1", answers([["db", ["SQLite"]]]))).toBe(true);
		expect(service.lateAnswer("q-1", answers([["db", ["Postgres"]]]))).toBe(false);
		expect(service.takeLateAnswers()).toHaveLength(1);
	});

	test("resolve 早于到点：计时器被清理（clearTimeout 置位），到点后 fire 无副作用", async () => {
		const { service, timers, advance } = makeService();
		const pending = ask(service, { mode: "timed", timeoutMs: 100 });
		service.resolve("q-1", answers([["db", ["SQLite"]]]));
		const result = await pending;
		expect((result as { pending: boolean }).pending).toBe(false);
		expect(timers).toHaveLength(1);
		expect(timers[0]!.cleared).toBe(true);
		advance(10_000); // 已清理，不再触发
		expect(service.pending()).toHaveLength(0);
		expect(service.takeLateAnswers()).toHaveLength(0);
	});

	test("timed 到点状态快照：status=timed-out 且仍可被 lateAnswer（pending() 可见）", async () => {
		const { service, advance } = makeService();
		const pending = ask(service, { mode: "timed", timeoutMs: 100 });
		advance(1_100);
		await pending;
		expect(service.pending()[0]!.status).toBe("timed-out");
		expect(service.lateAnswer("q-1", answers([["db", ["SQLite"]]]))).toBe(true);
	});
});

describe("BI-07.10 · 结构校验（多问题 / 选项 / recommended 透传）", () => {
	test("空 questions / 非数组 → invalid-request", () => {
		const { service } = makeService();
		expect(() => service.ask({ questions: [] })).toThrow(UserQuestionError);
		expect(() => service.ask({ questions: [] as UserQuestion[] })).toThrow(UserQuestionError);
		try {
			service.ask({ questions: [] as UserQuestion[] });
		} catch (err) {
			expect((err as UserQuestionError).code).toBe("invalid-request");
		}
	});

	test("缺 header / 空 options / 空 label / 重复 option label → invalid-request", () => {
		const { service } = makeService();
		const base: UserQuestion = {
			id: "x",
			question: "q",
			header: "h",
			options: [{ label: "a" }],
		};
		expect(() =>
			service.ask({ questions: [{ ...base, header: "" }] }),
		).toThrow(UserQuestionError);
		expect(() =>
			service.ask({ questions: [{ ...base, options: [] }] }),
		).toThrow(UserQuestionError);
		expect(() =>
			service.ask({ questions: [{ ...base, options: [{ label: "" }] }] }),
		).toThrow(UserQuestionError);
		expect(() =>
			service.ask({ questions: [{ ...base, options: [{ label: "a" }, { label: "a" }] }] }),
		).toThrow(UserQuestionError);
	});

	test("question id 重复 → invalid-request", () => {
		const { service } = makeService();
		const q: UserQuestion = { id: "dup", question: "q", header: "h", options: [{ label: "a" }] };
		expect(() => service.ask({ questions: [q, { ...q }] })).toThrow(UserQuestionError);
	});

	test("mode 非法 / timed 缺 timeoutMs / timeoutMs 非正 → invalid-request", () => {
		const { service } = makeService();
		const q: UserQuestion = { id: "x", question: "q", header: "h", options: [{ label: "a" }] };
		expect(() => service.ask({ questions: [q], mode: "yolo" as never })).toThrow(UserQuestionError);
		expect(() =>
			service.ask({ questions: [q], mode: "timed", timeoutMs: undefined }),
		).toThrow(UserQuestionError);
		expect(() => service.ask({ questions: [q], mode: "timed", timeoutMs: 0 })).toThrow(
			UserQuestionError,
		);
		expect(() => service.ask({ questions: [q], mode: "timed", timeoutMs: -5 })).toThrow(
			UserQuestionError,
		);
	});

	test("多问题结构：两问题各自 id 独立应答，answers 按 questionId 对齐", async () => {
		const { service } = makeService();
		const pending = service.ask({
			questions: [
				{ id: "db", question: "选库？", header: "存储", options: [{ label: "SQLite" }, { label: "PG" }] },
				{ id: "tz", question: "时区？", header: "地区", options: [{ label: "UTC" }, { label: "CST" }] },
			],
		});
		service.resolve("q-1", answers([
			["tz", ["CST"]],
			["db", ["PG"]],
		]));
		const result = (await pending) as { answers: UserAnswer[] };
		expect(result.answers).toHaveLength(2);
		expect(result.answers.map((a) => a.questionId)).toEqual(["tz", "db"]);
	});

	test("answers 非法：未知 questionId / 未知 label / 空 selected / 重复 questionId → resolve false", () => {
		const { service } = makeService();
		void ask(service);
		expect(service.resolve("q-1", answers([["nope", ["SQLite"]]]))).toBe(false);
		expect(service.resolve("q-1", answers([["db", ["NoSuch"]]]))).toBe(false);
		expect(service.resolve("q-1", [{ questionId: "db", selected: [] }])).toBe(false);
		expect(
			service.resolve("q-1", [
				{ questionId: "db", selected: ["SQLite"] },
				{ questionId: "db", selected: ["Postgres"] },
			]),
		).toBe(false);
		expect(service.resolve("q-1", [])).toBe(false);
	});

	test("recommended (Recommended) 标记透传：纯数据保留在选项结构与快照中", async () => {
		const { service } = makeService();
		const pendingPromise = service.ask({
			questions: [
				{
					id: "x",
					question: "选一个",
					header: "H",
					options: [
						{ label: "推荐项", description: "说明", recommended: true },
						{ label: "普通项" },
					],
				},
			],
		});
		const snapshot = service.pending()[0]!;
		expect(snapshot.questions[0]!.options[0]).toEqual({
			label: "推荐项",
			description: "说明",
			recommended: true,
		});
		expect(snapshot.questions[0]!.options[1]).toEqual({ label: "普通项" });
		service.resolve("q-1", [{ questionId: "x", selected: ["推荐项"] }]);
		await pendingPromise;
	});
});

describe("BI-07.10 · AskUserTool 模型工具面", () => {
	test("spec：名称 AskUserQuestion，必填 questions", () => {
		expect(ASK_USER_QUESTION_TOOL_SPEC.name).toBe("AskUserQuestion");
		expect((ASK_USER_QUESTION_TOOL_SPEC.inputSchema as { required: string[] }).required).toEqual([
			"questions",
		]);
	});

	test("run：非对象 / 非法结构 → ok:false（invalid-request，不走异常）", async () => {
		const { service } = makeService();
		const tool = new AskUserTool(service);
		expect(await tool.run(null)).toMatchObject({ ok: false, code: "invalid-request" });
		expect(await tool.run({ questions: [] })).toMatchObject({ ok: false, code: "invalid-request" });
		expect(await tool.run({ questions: [{ id: "x" }] })).toMatchObject({
			ok: false,
			code: "invalid-request",
		});
	});

	test("run：timed 到点 → ok:true + pending:true + callId + timeoutMs", async () => {
		const { service, advance } = makeService();
		const tool = new AskUserTool(service);
		const pending = tool.run({
			questions: [
				{ id: "a", question: "q", header: "h", options: [{ label: "y" }, { label: "n" }] },
			],
			mode: "timed",
			timeoutMs: 200,
		});
		advance(1_200);
		const result = await pending;
		expect(result).toEqual({ ok: true, pending: true, callId: "q-1", timeoutMs: 200 });
	});

	test("run：block 全流程 → ok:true + answers", async () => {
		const { service } = makeService();
		const tool = new AskUserTool(service);
		const pending = tool.run({
			questions: [
				{ id: "a", question: "q", header: "h", options: [{ label: "y" }, { label: "n" }] },
			],
		});
		service.resolve("q-1", [{ questionId: "a", selected: ["y"] }]);
		expect(await pending).toEqual({
			ok: true,
			pending: false,
			callId: "q-1",
			answers: [{ questionId: "a", selected: ["y"] }],
			cancelled: false,
		});
	});

	test("run：cancel 路径 → ok:true + cancelled:true", async () => {
		const { service } = makeService();
		const tool = new AskUserTool(service);
		const pending = tool.run({
			questions: [
				{ id: "a", question: "q", header: "h", options: [{ label: "y" }] },
			],
		});
		service.cancel("q-1");
		expect(await pending).toEqual({ ok: true, pending: false, callId: "q-1", answers: null, cancelled: true });
	});
});
