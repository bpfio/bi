import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "bun:test";
import {
	AGENT_TURN_STATES,
	AGENT_TURN_TRANSITIONS,
	AgentLoop,
	InvalidTransitionError,
	assertTransition,
	fileAccessesOverlap,
	readFileStateWriteGate,
	type ToolCall,
} from "./agent";
import { ReadFileStateMap } from "./tool/read-file-state";
import { RepeatBreaker, ToolDedupe } from "./tool/tool-dedupe";
import { ToolTimeoutPolicy } from "./guard/timeout-policy";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 手动放行的栅栏：观察"已开始"与"保持运行"两个时点。 */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const call = (id: string, name: string, args: unknown = {}): ToolCall => ({ id, name, args });

/** 并发/时序跟踪执行体。 */
function trackedExecutor(delayFor?: (c: ToolCall) => number) {
	const order: string[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	let started = 0;
	const execute = async (c: ToolCall) => {
		started += 1;
		order.push(`start:${c.id}`);
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await delay(delayFor?.(c) ?? 10);
		inFlight -= 1;
		order.push(`end:${c.id}`);
		return `v:${c.id}`;
	};
	return { execute, order, started: () => started, maxInFlight: () => maxInFlight };
}

/** 可注入的假时钟（取消窗口测试用）。 */
function fakeClock() {
	let now = 0;
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms;
		},
		setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
		clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

let root = "";

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "bi-agent-")));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 状态机：转移矩阵（房规 14.5）                                        */
/* ------------------------------------------------------------------ */

describe("回合状态机转移矩阵", () => {
	test("穷举合法转移边：表内 (from,to) 全部放行", () => {
		for (const from of AGENT_TURN_STATES) {
			for (const to of AGENT_TURN_TRANSITIONS[from]) {
				expect(() => assertTransition(from, to)).not.toThrow();
			}
		}
	});

	test("穷举非法转移：表外组合一律结构化报错 invalid-transition", () => {
		for (const from of AGENT_TURN_STATES) {
			for (const to of AGENT_TURN_STATES) {
				if (AGENT_TURN_TRANSITIONS[from].includes(to)) continue;
				try {
					assertTransition(from, to);
					throw new Error(`expected invalid: ${from} -> ${to}`);
				} catch (err) {
					expect(err).toBeInstanceOf(InvalidTransitionError);
					expect((err as InvalidTransitionError).code).toBe("invalid-transition");
				}
			}
		}
	});

	test("exit 为绝对终态：无任何出边", () => {
		expect(AGENT_TURN_TRANSITIONS.exit).toHaveLength(0);
	});

	test("生命周期：beginTurn → thinking，finishTurn 经 settling 回 idle", () => {
		const loop = new AgentLoop({ execute: () => "ok" });
		expect(loop.state).toBe("idle");
		loop.beginTurn();
		expect(loop.state).toBe("thinking");
		loop.finishTurn();
		expect(loop.state).toBe("idle");
	});

	test("单飞铁律：thinking 中重复 beginTurn / executeTools 违规即抛", () => {
		const loop = new AgentLoop({ execute: () => "ok" });
		loop.beginTurn();
		expect(() => loop.beginTurn()).toThrow(InvalidTransitionError);
	});

	test("executeTools 必须从 thinking 进入：idle/exit 态调用即抛；exit 后 resume 拒绝", async () => {
		const idle = new AgentLoop({ execute: () => "ok" });
		await expect(idle.executeTools([call("a", "read")])).rejects.toThrow(InvalidTransitionError);
		const exited = new AgentLoop({ execute: () => "ok" });
		exited.beginTurn();
		await exited.cancelRequest(); // thinking → paused
		await exited.cancelRequest(); // paused → exit
		expect(exited.state).toBe("exit");
		expect(() => exited.resume()).toThrow(InvalidTransitionError);
		await expect(exited.executeTools([call("a", "read")])).rejects.toThrow(InvalidTransitionError);
	});

	test("onTransition 观测：begin/execute/finish 全程转移序可审计", async () => {
		const seen: string[] = [];
		const loop = new AgentLoop({
			execute: () => "ok",
			onTransition: (from, to) => seen.push(`${from}->${to}`),
		});
		loop.beginTurn();
		await loop.executeTools([]);
		loop.finishTurn();
		expect(seen).toEqual([
			"idle->thinking",
			"thinking->tool-executing",
			"tool-executing->thinking",
			"thinking->settling",
			"settling->idle",
		]);
	});
});

/* ------------------------------------------------------------------ */
/* 多工具并行流水线：RWLock 调度矩阵                                    */
/* ------------------------------------------------------------------ */

describe("并行流水线：只读并行 / 写串行分组", () => {
	test("只读同路径不互斥：Promise.all 并行（读-读共享锁）", async () => {
		const t = trackedExecutor();
		const loop = new AgentLoop({
			execute: t.execute,
			readOnlyTools: new Set(["read"]),
			fileAccesses: (c) => [join(root, `${c.id}.ts`)],
		});
		loop.beginTurn();
		const results = await loop.executeTools([
			call("r1", "read", { p: "a" }),
			call("r2", "read", { p: "a" }),
		]);
		expect(t.maxInFlight()).toBe(2);
		expect(results.map((r) => r.value)).toEqual(["v:r1", "v:r2"]);
		expect(loop.state).toBe("thinking");
	});

	test("写同路径严格串行：同组顺序执行", async () => {
		const t = trackedExecutor();
		const loop = new AgentLoop({
			execute: t.execute,
			fileAccesses: (c) => [join(root, "a.ts")],
		});
		loop.beginTurn();
		await loop.executeTools([call("w1", "edit"), call("w2", "edit")]);
		expect(t.maxInFlight()).toBe(1);
		expect(t.order).toEqual(["start:w1", "end:w1", "start:w2", "end:w2"]);
	});

	test("写异路径并行：组间 Promise.all", async () => {
		const t = trackedExecutor();
		const loop = new AgentLoop({
			execute: t.execute,
			fileAccesses: (c) => [join(root, `${c.id}.ts`)],
		});
		loop.beginTurn();
		await loop.executeTools([call("w1", "edit"), call("w2", "edit")]);
		expect(t.maxInFlight()).toBe(2);
	});

	test("读写同路径互斥：进同组串行（读-写排他锁）", async () => {
		const t = trackedExecutor();
		const loop = new AgentLoop({
			execute: t.execute,
			readOnlyTools: new Set(["read"]),
			fileAccesses: () => [join(root, "a.ts")],
		});
		loop.beginTurn();
		await loop.executeTools([call("r1", "read"), call("w1", "edit")]);
		expect(t.maxInFlight()).toBe(1);
		expect(t.order).toEqual(["start:r1", "end:r1", "start:w1", "end:w1"]);
	});

	test("路径重叠传递性：w1(a) - w2(a,b) - w3(b) 传递闭包成一条串行链", async () => {
		const t = trackedExecutor();
		const loop = new AgentLoop({
			execute: t.execute,
			fileAccesses: (c) =>
				c.id === "w2" ? [join(root, "a.ts"), join(root, "b.ts")] : [join(root, `${c.id === "w1" ? "a" : "b"}.ts`)],
		});
		loop.beginTurn();
		await loop.executeTools([call("w1", "edit"), call("w2", "edit"), call("w3", "edit")]);
		expect(t.maxInFlight()).toBe(1);
		expect(t.order).toEqual(["start:w1", "end:w1", "start:w2", "end:w2", "start:w3", "end:w3"]);
	});

	test("未声明路径的写类调用保守串行成链（缺省 fileAccesses）", async () => {
		const t = trackedExecutor();
		const loop = new AgentLoop({ execute: t.execute });
		loop.beginTurn();
		await loop.executeTools([call("w1", "edit"), call("w2", "edit")]);
		expect(t.maxInFlight()).toBe(1);
	});

	test("结果恒按调用序返回（完成顺序被打乱也不重排）", async () => {
		const t = trackedExecutor((c) => (c.id === "c0" ? 60 : 5));
		const loop = new AgentLoop({
			execute: t.execute,
			readOnlyTools: new Set(["read"]),
			fileAccesses: (c) => [join(root, `${c.id}.ts`)],
		});
		loop.beginTurn();
		const results = await loop.executeTools([call("c0", "read"), call("c1", "read")]);
		expect(t.order.indexOf("end:c1")).toBeLessThan(t.order.indexOf("end:c0"));
		expect(results.map((r) => [r.id, r.value])).toEqual([
			["c0", "v:c0"],
			["c1", "v:c1"],
		]);
	});

	test("屏障工具独占一轮：前组落定、屏障独行、后组随后", async () => {
		const t = trackedExecutor(() => 15);
		const loop = new AgentLoop({
			execute: t.execute,
			readOnlyTools: new Set(["read"]),
			barrierTools: new Set(["bash"]),
			fileAccesses: (c) => [join(root, `${c.id}.ts`)],
		});
		loop.beginTurn();
		const results = await loop.executeTools([
			call("r1", "read"),
			call("b1", "bash"),
			call("r2", "read"),
			call("r3", "read"),
		]);
		// 严格执行序证明屏障独占：r1 落定 → b1 独行 → r2/r3 才启动。
		expect(t.order).toEqual([
			"start:r1",
			"end:r1",
			"start:b1",
			"end:b1",
			"start:r2",
			"start:r3",
			"end:r2",
			"end:r3",
		]);
		// 屏障绝不与他人并发（并发峰值 2 全部来自 r2/r3 读-读并行）。
		expect(t.maxInFlight()).toBe(2);
		expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
	});

	test("空批次：合法空转，状态回 thinking", async () => {
		const loop = new AgentLoop({ execute: () => "ok" });
		loop.beginTurn();
		expect(await loop.executeTools([])).toEqual([]);
		expect(loop.state).toBe("thinking");
	});
});

/* ------------------------------------------------------------------ */
/* 二段式抢占取消                                                       */
/* ------------------------------------------------------------------ */

describe("二段式抢占取消状态机", () => {
	test("不变式：tool-executing 第一段取消必须等在飞工具 settle 才进 paused", async () => {
		const gate = deferred();
		const loop = new AgentLoop({
			execute: async (c) => {
				if (c.id === "c0") await gate.promise;
				return `v:${c.id}`;
			},
			fileAccesses: () => [join(root, "a.ts")],
		});
		loop.beginTurn();
		const pending = loop.executeTools([call("c0", "edit"), call("c1", "edit"), call("c2", "edit")]);
		await delay(20); // c0 已在飞、c1/c2 排队同组
		const cancelPromise = loop.cancelRequest();
		await delay(10);
		// 取消已按下、信号已 abort，但在飞 c0 未 settle 前 state 不得离开 tool-executing。
		expect(loop.state).toBe("tool-executing");
		gate.resolve();
		const outcome = await cancelPromise;
		expect(outcome).toEqual({ stage: 1, action: "paused" });
		expect(loop.state).toBe("paused");
		const results = await pending;
		// c1/c2 未派发，协作取消记为 cancelled；executeTools 不把 paused 回写 thinking。
		expect(results[1]).toMatchObject({ id: "c1", ok: false, cancelled: true });
		expect(results[2]).toMatchObject({ id: "c2", ok: false, cancelled: true });
		expect(loop.state).toBe("paused");
	});

	test("第一段取消：协作 AbortSignal 送达在飞执行体", async () => {
		const gate = deferred();
		let observedAborted = false;
		const loop = new AgentLoop({
			execute: async (_c, signal) => {
				signal.addEventListener("abort", () => {
					observedAborted = signal.aborted;
				});
				await gate.promise;
				return "done";
			},
			readOnlyTools: new Set(["wait"]),
		});
		loop.beginTurn();
		const pending = loop.executeTools([call("c0", "wait")]);
		await delay(20);
		const cancelPromise = loop.cancelRequest();
		gate.resolve();
		await cancelPromise;
		await pending;
		expect(observedAborted).toBe(true);
		expect(loop.state).toBe("paused");
	});

	test("单段后 resume：paused → thinking，流水线可续跑", async () => {
		const t = trackedExecutor(() => 5);
		const loop = new AgentLoop({
			execute: t.execute,
			readOnlyTools: new Set(["read"]),
			fileAccesses: (c) => [join(root, `${c.id}.ts`)],
		});
		loop.beginTurn();
		await loop.cancelRequest(); // thinking → paused
		expect(loop.state).toBe("paused");
		loop.resume();
		expect(loop.state).toBe("thinking");
		const results = await loop.executeTools([call("r1", "read")]);
		expect(results[0]).toMatchObject({ ok: true, value: "v:r1" });
		loop.finishTurn();
		expect(loop.state).toBe("idle");
	});

	test("双段取消（窗口内）：paused → exit 终态，且 resume/beginTurn 均拒绝", async () => {
		const gate = deferred();
		const loop = new AgentLoop({
			execute: async () => {
				await gate.promise;
				return "done";
			},
			readOnlyTools: new Set(["wait"]),
		});
		loop.beginTurn();
		const pending = loop.executeTools([call("c0", "wait")]);
		await delay(20); // c0 在飞
		const firstPromise = loop.cancelRequest(); // 第一段：等在飞落定
		gate.resolve(); // 放行 c0，让协作取消落定
		expect(await firstPromise).toEqual({ stage: 1, action: "paused" });
		expect(loop.state).toBe("paused");
		const second = await loop.cancelRequest(); // 窗口内第二次按下 → exit
		expect(second).toEqual({ stage: 2, action: "exit" });
		expect(loop.state).toBe("exit");
		expect(() => loop.resume()).toThrow(InvalidTransitionError);
		expect(() => loop.beginTurn()).toThrow(InvalidTransitionError);
		const results = await pending;
		expect(results[0]).toMatchObject({ id: "c0", ok: true });
		expect(loop.state).toBe("exit");
	});

	test("窗口外重复单击仍按第一段处理（cancelWindowMs 可配 + 假时钟）", async () => {
		const clock = fakeClock();
		const loop = new AgentLoop({ execute: () => "ok", clock, cancelWindowMs: 800 });
		loop.beginTurn();
		clock.advance(0);
		expect(await loop.cancelRequest()).toEqual({ stage: 1, action: "paused" });
		clock.advance(1000); // 超窗：仍是第一段
		expect(await loop.cancelRequest()).toEqual({ stage: 1, action: "already-paused" });
		clock.advance(100); // 窗内：第二段
		expect(await loop.cancelRequest()).toEqual({ stage: 2, action: "exit" });
		expect(loop.state).toBe("exit");
	});

	test("settling 态可被第一段取消暂停并可 resume", async () => {
		const loop = new AgentLoop({ execute: () => "ok" });
		loop.beginTurn();
		loop.beginSettle();
		expect(loop.state).toBe("settling");
		expect(await loop.cancelRequest()).toEqual({ stage: 1, action: "paused" });
		loop.resume();
		expect(loop.state).toBe("thinking");
	});

	test("idle 态取消为 noop：状态不迁移、不占用窗口", async () => {
		const loop = new AgentLoop({ execute: () => "ok" });
		expect(await loop.cancelRequest()).toEqual({ stage: 1, action: "noop" });
		expect(loop.state).toBe("idle");
		loop.beginTurn();
		// noop 未污染取消窗口：此后第一次真取消仍按第一段。
		expect(await loop.cancelRequest()).toEqual({ stage: 1, action: "paused" });
	});
});

/* ------------------------------------------------------------------ */
/* 集成点：07.2 写前门 / 07.13 硬门与排重 / 06.3 限时                    */
/* ------------------------------------------------------------------ */

describe("集成钩子", () => {
	test("钩子固定序：breaker → dedupe → writeGate → execute → recordResult", async () => {
		const order: string[] = [];
		const dedupe = new ToolDedupe({ readOnlyTools: [] });
		const loop = new AgentLoop({
			execute: async () => {
				order.push("execute");
				return "ok";
			},
			fileAccesses: () => [join(root, "a.ts")],
			writeGate: {
				assertWritable: () => {
					order.push("gate");
					return null;
				},
			},
			dedupe: {
				check: (name, args) => {
					order.push("dedupe");
					return dedupe.check(name, args);
				},
				recordResult: (name, args, result) => {
					order.push("record");
					dedupe.recordResult(name, args, result);
				},
			},
			repeatBreaker: {
				observe: (name, args) => {
					order.push("breaker");
					return realBreaker.observe(name, args);
				},
			},
		});
		const realBreaker = new RepeatBreaker();
		loop.beginTurn();
		await loop.executeTools([call("e1", "edit")]);
		expect(order).toEqual(["breaker", "dedupe", "gate", "execute", "record"]);
	});

	test("BI-07.13 只读排重：缓存回放短路执行体", async () => {
		const t = trackedExecutor(() => 5);
		const loop = new AgentLoop({
			execute: t.execute,
			readOnlyTools: new Set(["read"]),
			dedupe: new ToolDedupe({ readOnlyTools: ["read"] }),
		});
		loop.beginTurn();
		const first = await loop.executeTools([call("q1", "read", { p: "a" })]);
		const second = await loop.executeTools([call("q2", "read", { p: "a" })]);
		expect(t.started()).toBe(1);
		expect(first[0]).toMatchObject({ ok: true, value: "v:q1" });
		expect(first[0]?.deduped).toBeUndefined();
		expect(second[0]).toMatchObject({ ok: true, value: "v:q1", deduped: true });
	});

	test("BI-07.13 三阶打断门：tier3 短路执行、tier1/2 附加话术仍放行", async () => {
		const t = trackedExecutor(() => 1);
		const loop = new AgentLoop({
			execute: t.execute,
			repeatBreaker: new RepeatBreaker(),
		});
		loop.beginTurn();
		const calls = Array.from({ length: 8 }, (_, i) => call(`w${i}`, "edit", { same: true }));
		const results = await loop.executeTools(calls);
		// 前 7 次执行（其中第 3 次起带话术），第 8 次被硬阻断。
		expect(t.started()).toBe(7);
		expect(results[2]).toMatchObject({ ok: true });
		expect(results[2]?.breakerVerdict?.tier).toBe(1);
		expect(results[7]).toMatchObject({ ok: false, blocked: true });
		expect(results[7]?.error).toBe("硬阻断：后续工具调用全部拒绝，强制直出文本");
		expect(results[7]?.breakerVerdict?.tier).toBe(3);
	});

	test("BI-07.2 写前门禁（readFileStateWriteGate 适配器）：not-read / 外部篡改 / 放行三态", async () => {
		const target = join(root, "gated.ts");
		await writeFile(target, "hello");
		const fileStat = await stat(target);
		const map = new ReadFileStateMap();
		let currentMtime = fileStat.mtimeMs;
		const loop = new AgentLoop({
			execute: async () => "written",
			fileAccesses: () => [target],
			writeGate: readFileStateWriteGate(map, async () => ({ mtimeMs: currentMtime, size: fileStat.size })),
		});
		loop.beginTurn();
		// ① 未读过：拒绝，执行体不被触达。
		const denied = await loop.executeTools([call("e1", "edit")]);
		expect(denied[0]).toMatchObject({ ok: false, denied: true });
		expect(denied[0]?.error).toContain("not-read");
		// ② 记录读取基线后放行。
		map.recordRead(target, { mtimeMs: currentMtime, size: fileStat.size });
		const allowed = await loop.executeTools([call("e2", "edit")]);
		expect(allowed[0]).toMatchObject({ ok: true, value: "written" });
		// ③ 外部篡改（mtime 漂移）：拒绝并强制重读。
		currentMtime = fileStat.mtimeMs + 999;
		const dirty = await loop.executeTools([call("e3", "edit")]);
		expect(dirty[0]).toMatchObject({ ok: false, denied: true });
		expect(dirty[0]?.error).toContain("externally-modified");
	});

	test("BI-06.3 限时看门狗：到点结构化超时落为失败结果", async () => {
		const loop = new AgentLoop({
			execute: async () => {
				await delay(200);
				return "late";
			},
			timeoutPolicy: new ToolTimeoutPolicy({ timeouts: { slow: 30 }, defaultTimeoutMs: 30 }),
		});
		loop.beginTurn();
		const results = await loop.executeTools([call("s1", "slow")]);
		expect(results[0]).toMatchObject({ ok: false });
		expect(results[0]?.error).toContain("exceeded deadline");
	});
});

/* ------------------------------------------------------------------ */
/* [loop_control] max_tool_calls_per_turn（单回合工具调用上限）           */
/* ------------------------------------------------------------------ */

describe("AgentLoop · max_tool_calls_per_turn（单回合工具调用上限）", () => {
	test("超限调用不执行，回填结构化拒绝（loop-control: 单轮工具调用超过上限 N）", async () => {
		const executed: string[] = [];
		const loop = new AgentLoop({
			execute: async (c) => {
				executed.push(c.id);
				return `v:${c.id}`;
			},
			maxToolCallsPerTurn: 2,
		});
		loop.beginTurn();
		const results = await loop.executeTools([call("c1", "t"), call("c2", "t"), call("c3", "t")]);
		expect(executed).toEqual(["c1", "c2"]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(results[2]).toMatchObject({ ok: false });
		expect(results[2]?.error).toContain("loop-control: 单轮工具调用超过上限 2");
		expect(results[2]?.error).toContain("[loop_control] max_tool_calls_per_turn");
	});

	test("0 / 未提供 → 不限（全部调用执行）", async () => {
		for (const cap of [undefined, 0]) {
			const executed: string[] = [];
			const loop = new AgentLoop({
				execute: async (c) => {
					executed.push(c.id);
					return `v:${c.id}`;
				},
				...(cap !== undefined ? { maxToolCallsPerTurn: cap } : {}),
			});
			loop.beginTurn();
			const results = await loop.executeTools([call("c1", "t"), call("c2", "t"), call("c3", "t")]);
			expect(executed).toEqual(["c1", "c2", "c3"]);
			expect(results.every((r) => r.ok)).toBe(true);
		}
	});

	test("拒绝结果按调用序回填（results 下标与调用下标对齐）", async () => {
		const loop = new AgentLoop({
			execute: async (c) => `v:${c.id}`,
			maxToolCallsPerTurn: 1,
		});
		loop.beginTurn();
		const results = await loop.executeTools([call("a", "t"), call("b", "t")]);
		expect(results[0]).toMatchObject({ id: "a", ok: true });
		expect(results[1]).toMatchObject({ id: "b", ok: false });
	});
});

/* ------------------------------------------------------------------ */
/* fileAccessesOverlap 路径重叠矩阵                                     */
/* ------------------------------------------------------------------ */

describe("fileAccessesOverlap 路径重叠矩阵", () => {
	test("相同路径 / resolve 归一化后相同 → 重叠", () => {
		expect(fileAccessesOverlap([join(root, "a.ts")], [join(root, "a.ts")])).toBe(true);
		expect(fileAccessesOverlap([join(root, ".", "a.ts")], [join(root, "a.ts")])).toBe(true);
	});

	test("不相交路径 / 空集合 → 不重叠", () => {
		expect(fileAccessesOverlap([join(root, "a.ts")], [join(root, "b.ts")])).toBe(false);
		expect(fileAccessesOverlap([], [join(root, "a.ts")])).toBe(false);
		expect(fileAccessesOverlap([join(root, "a.ts")], [])).toBe(false);
	});

	test("集合语义：任一相交即重叠", () => {
		expect(
			fileAccessesOverlap([join(root, "x.ts"), join(root, "a.ts")], [join(root, "b.ts"), join(root, "a.ts")]),
		).toBe(true);
	});
});
