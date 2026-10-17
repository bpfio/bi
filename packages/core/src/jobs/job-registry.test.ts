/**
 * BI-07.11 测试 — JobRegistry（生命周期四态 / OutputRing / 唤醒预算 / 并发隔离）
 *          + JobPump + JobTools 三件套。
 */
import { describe, expect, test } from "bun:test";
import {
	JobError,
	JobRegistry,
	OutputRing,
	type JobRunner,
} from "./job-registry";
import { JobPump } from "./job-pump";
import { JOB_KILL_TOOL_SPEC, JOB_LIST_TOOL_SPEC, JOB_OUTPUT_TOOL_SPEC, JobTools } from "./job-tools";

/** 微任务排空（pump 终结走 .then 宏观前微任务链）。 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function streamOf(chunks: string[]): AsyncIterable<string> {
	return (async function* () {
		for (const chunk of chunks) yield chunk;
	})();
}

function makeRegistry(options?: {
	maxConsecutiveWakes?: number;
	ringCapacityBytes?: number;
}) {
	const nowMs = { v: 1_000 };
	const registry = new JobRegistry({
		now: () => (nowMs.v += 10),
		idGen: (() => {
			let n = 0;
			return () => `job-${++n}`;
		})(),
		...options,
	});
	return { registry, nowMs };
}

describe("BI-07.11 · 生命周期四态", () => {
	test("start → running + startedAt；ids 单调", () => {
		const { registry } = makeRegistry();
		const id1 = registry.start("build", { stream: streamOf(["x"]) });
		const id2 = registry.start("test", { stream: streamOf([]) });
		expect(id1).toBe("job-1");
		expect(id2).toBe("job-2");
		const job = registry.get(id1)!;
		expect(job.status).toBe("running");
		expect(job.kind).toBe("build");
		expect(job.startedAt).toBe(1_010);
		expect(job.endedAt).toBeUndefined();
	});

	test("流耗尽 → done + endedAt", async () => {
		const { registry } = makeRegistry();
		const id = registry.start("build", { stream: streamOf(["a", "b"]) });
		await flush();
		const job = registry.get(id)!;
		expect(job.status).toBe("done");
		expect(job.endedAt).toBeGreaterThan(job.startedAt);
	});

	test("流抛错 → failed + error 留痕", async () => {
		const { registry } = makeRegistry();
		const failing: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return (async function* () {
					yield "ok-part";
					throw new Error("runner 爆炸");
				})();
			},
		};
		const id = registry.start("deploy", { stream: failing });
		await flush();
		const job = registry.get(id)!;
		expect(job.status).toBe("failed");
		expect(job.error).toBe("runner 爆炸");
		expect(job.endedAt).toBeDefined();
	});

	test("kill running → killed + runner.kill 回调被调；重复 kill / kill 已终态 → false", async () => {
		const { registry } = makeRegistry();
		let killed = false;
		const id = registry.start("serve", {
			stream: (async function* () {
				yield "chunk-1";
				await new Promise((r) => setTimeout(r, 30));
				yield "chunk-2";
			})(),
			kill: () => {
				killed = true;
			},
		});
		await flush();
		expect(registry.kill(id)).toBe(true);
		expect(killed).toBe(true);
		expect(registry.get(id)!.status).toBe("killed");
		expect(registry.get(id)!.endedAt).toBeDefined();
		expect(registry.kill(id)).toBe(false);
	});

	test("kill 未知 id → false", () => {
		const { registry } = makeRegistry();
		expect(registry.kill("job-none")).toBe(false);
	});

	test("空流 → done 且输出为空", async () => {
		const { registry } = makeRegistry();
		const id = registry.start("noop", { stream: streamOf([]) });
		await flush();
		expect(registry.get(id)!.status).toBe("done");
		expect(registry.output(id).output).toBe("");
	});

	test("kind 空 → invalid-kind", () => {
		const { registry } = makeRegistry();
		expect(() => registry.start("  ", { stream: streamOf([]) })).toThrow(JobError);
		try {
			registry.start("", { stream: streamOf([]) });
		} catch (err) {
			expect((err as JobError).code).toBe("invalid-kind");
		}
	});

	test("list：登记序快照，外改不污染内部", async () => {
		const { registry } = makeRegistry();
		registry.start("a", { stream: streamOf([]) });
		registry.start("b", { stream: streamOf([]) });
		await flush();
		const listed = registry.list();
		expect(listed.map((j) => j.kind)).toEqual(["a", "b"]);
		listed[0]!.kind = "mutated";
		expect(registry.list()[0]!.kind).toBe("a");
	});

	test("output 未知 id → unknown-job 结构化抛错", () => {
		const { registry } = makeRegistry();
		expect(() => registry.output("job-none")).toThrow(JobError);
		try {
			registry.output("job-none");
		} catch (err) {
			expect((err as JobError).code).toBe("unknown-job");
		}
	});
});

describe("BI-07.11 · OutputRing（64KB 房规）与 tail 读取", () => {
	test("常规写入与 readTail：tail=N 自尾部截取", () => {
		const ring = new OutputRing();
		for (let i = 0; i < 10; i++) ring.write("abcdefghij");
		expect(ring.sizeBytes).toBe(100);
		expect(ring.readTail(10)).toBe("abcdefghij");
		expect(ring.readTail(3)).toBe("hij");
		expect(ring.readTail()).toBe("abcdefghij".repeat(10));
	});

	test("多块超 64KB：字节精确保留最新 64KB，droppedBytes 记账", () => {
		const ring = new OutputRing(); // 65536
		for (let i = 0; i < 10; i++) ring.write("x".repeat(10_000));
		expect(ring.sizeBytes).toBe(65_536);
		expect(ring.droppedBytes).toBe(34_464);
		expect(ring.readTail().length).toBe(65_536);
	});

	test("单块超容量：仅保留尾部 capacity 字节", () => {
		const ring = new OutputRing();
		ring.write("a".repeat(70_000));
		expect(ring.sizeBytes).toBe(65_536);
		expect(ring.droppedBytes).toBe(4_464);
		expect(ring.readTail().length).toBe(65_536);
	});

	test("注入容量：ringCapacityBytes=10 覆盖房规（字节精确尾部保留）", async () => {
		const { registry } = makeRegistry({ ringCapacityBytes: 10 });
		const id = registry.start("tiny", { stream: streamOf(["1234567890", "abc"]) });
		await flush();
		const { output } = registry.output(id);
		expect(output).toBe("4567890abc"); // 总 13 字节 → 保留最新 10 字节
	});

	test("泵写环：pump 拉流逐块写入（chunkCount 记账）", async () => {
		const ring = new OutputRing();
		const pump = new JobPump(ring);
		const outcome = await pump.run({ stream: streamOf(["a", "b", "c"]) });
		expect(outcome.status).toBe("done");
		expect(outcome.chunks).toBe(3);
		expect(pump.chunkCount).toBe(3);
		expect(ring.readTail()).toBe("abc");
	});

	test("pump 流抛错 → failed + error", async () => {
		const ring = new OutputRing();
		const pump = new JobPump(ring);
		const outcome = await pump.run({
			stream: (async function* () {
				yield "p";
				throw new Error("boom");
			})(),
		});
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toBe("boom");
	});

	test("pump stop：后续 chunk 丢弃，终结 killed", async () => {
		const ring = new OutputRing();
		const pump = new JobPump(ring);
		const gates: Array<() => void> = [];
		let n = 0;
		const runner: JobRunner = {
			stream: (async function* () {
				while (n < 5) {
					n++;
					yield `c${n}`;
					await new Promise<void>((r) => gates.push(r));
				}
			})(),
		};
		const pending = pump.run(runner);
		await flush();
		gates.shift()!(); // 放行第二块
		await flush();
		pump.stop();
		gates.shift()!(); // 放行后生成器继续，但 pump 已停
		await flush();
		const outcome = await pending;
		expect(outcome.status).toBe("killed");
		expect(ring.readTail()).toBe("c1c2");
	});
});

describe("BI-07.11 · 完成唤醒与预算（防自激）", () => {
	test("onComplete：done 触发回调（job 载荷 id/kind/status）", async () => {
		const { registry } = makeRegistry();
		const wakes: Array<{ id: string; kind: string; status: string }> = [];
		registry.onComplete(({ job }) => wakes.push({ id: job.id, kind: job.kind, status: job.status }));
		const id = registry.start("build", { stream: streamOf(["x"]) });
		await flush();
		expect(wakes).toEqual([{ id, kind: "build", status: "done" }]);
	});

	test("failed / killed 也触发完成唤醒（一次性，kill 后 pump 迟到结算不重复）", async () => {
		const { registry } = makeRegistry();
		const statuses: string[] = [];
		registry.onComplete(({ job }) => statuses.push(job.status));
		const failing = registry.start("bad", {
			stream: (async function* () {
				throw new Error("x");
			})(),
		});
		await flush();
		expect(statuses).toEqual(["failed"]);
		statuses.length = 0;
		const slow = registry.start("slow", {
			stream: (async function* () {
				yield "a";
				await new Promise((r) => setTimeout(r, 20));
				yield "b";
			})(),
		});
		await flush();
		registry.kill(slow);
		await new Promise((r) => setTimeout(r, 40)); // 等 pump 迟到结算
		expect(statuses).toEqual(["killed"]); // 恰一次
		void failing;
	});

	test("唤醒预算默认 3：连续 4 次完成 → 3 次唤醒 + 第 4 次抑制", async () => {
		const { registry } = makeRegistry();
		let wakes = 0;
		registry.onComplete(() => wakes++);
		for (let i = 0; i < 4; i++) {
			registry.start(`t${i}`, { stream: streamOf([]) });
		}
		await flush();
		expect(wakes).toBe(3);
		expect(registry.wakeBudgetRemaining).toBe(0);
		expect(registry.suppressedWakeCount).toBe(1);
	});

	test("noteUserInput 重置预算：抑制后解锁下一次唤醒", async () => {
		const { registry } = makeRegistry();
		let wakes = 0;
		registry.onComplete(() => wakes++);
		for (let i = 0; i < 3; i++) registry.start(`t${i}`, { stream: streamOf([]) });
		await flush();
		expect(wakes).toBe(3);
		registry.noteUserInput();
		expect(registry.wakeBudgetRemaining).toBe(3);
		registry.start("after", { stream: streamOf([]) });
		await flush();
		expect(wakes).toBe(4);
	});

	test("maxConsecutiveWakes=1 注入：首次唤醒后即抑制", async () => {
		const { registry } = makeRegistry({ maxConsecutiveWakes: 1 });
		let wakes = 0;
		registry.onComplete(() => wakes++);
		registry.start("a", { stream: streamOf([]) });
		await flush();
		registry.start("b", { stream: streamOf([]) });
		await flush();
		expect(wakes).toBe(1);
		expect(registry.suppressedWakeCount).toBe(1);
	});

	test("回调异常隔离：抛错回调不阻断其余回调与后续唤醒", async () => {
		const { registry } = makeRegistry();
		const seen: string[] = [];
		registry.onComplete(() => {
			throw new Error("坏监听器");
		});
		registry.onComplete(({ job }) => seen.push(job.id));
		registry.start("a", { stream: streamOf([]) });
		await flush();
		expect(seen).toEqual(["job-1"]);
		registry.start("b", { stream: streamOf([]) });
		await flush();
		expect(seen).toEqual(["job-1", "job-2"]);
	});
});

describe("BI-07.11 · 并发任务隔离", () => {
	test("kill 一个不影响另一个：慢任务 killed 保部分输出，快任务 done 全输出", async () => {
		const { registry } = makeRegistry();
		const gates: Array<() => void> = [];
		const slow = registry.start("slow", {
			stream: (async function* () {
				yield "s1";
				await new Promise<void>((r) => gates.push(r));
				yield "s2";
				await new Promise<void>((r) => gates.push(r));
			})(),
		});
		const fast = registry.start("fast", { stream: streamOf(["f1", "f2"]) });
		await flush();
		expect(registry.output(slow).output).toBe("s1");
		registry.kill(slow);
		await flush();
		await new Promise((r) => setTimeout(r, 30));
		expect(registry.get(slow)!.status).toBe("killed");
		expect(registry.output(slow).output).toBe("s1"); // 终止后不再增长
		expect(registry.get(fast)!.status).toBe("done");
		expect(registry.output(fast).output).toBe("f1f2");
	});
});

describe("BI-07.11 · JobTools 三件套", () => {
	test("specs：JobList/JobOutput/JobKill 名称与必填面", () => {
		expect(JOB_LIST_TOOL_SPEC.name).toBe("JobList");
		expect(JOB_OUTPUT_TOOL_SPEC.name).toBe("JobOutput");
		expect((JOB_OUTPUT_TOOL_SPEC.inputSchema as { required: string[] }).required).toEqual(["id"]);
		expect(JOB_KILL_TOOL_SPEC.name).toBe("JobKill");
	});

	test("job_list → ok:true jobs", async () => {
		const { registry } = makeRegistry();
		const tools = new JobTools(registry);
		registry.start("a", { stream: streamOf([]) });
		await flush();
		const result = tools.runList();
		expect(result.ok).toBe(true);
		expect("jobs" in result && result.jobs[0]!.kind).toBe("a");
	});

	test("job_output：缺 id / 非法 tail → invalid-input；成功 → job + output", async () => {
		const { registry } = makeRegistry();
		const tools = new JobTools(registry);
		const id = registry.start("a", { stream: streamOf(["hello", "world"]) });
		await flush();
		expect(tools.runOutput(null)).toMatchObject({ ok: false, code: "invalid-input" });
		expect(tools.runOutput({})).toMatchObject({ ok: false, code: "invalid-input" });
		expect(tools.runOutput({ id, tail: 0 })).toMatchObject({ ok: false, code: "invalid-input" });
		const ok = tools.runOutput({ id, tail: 5 });
		expect(ok.ok).toBe(true);
		if (ok.ok && "output" in ok) {
			expect(ok.output).toBe("world");
			expect(ok.job.status).toBe("done");
			expect(ok.job.id).toBe(id);
		}
	});

	test("job_output 未知 id → ok:false unknown-job", () => {
		const { registry } = makeRegistry();
		const tools = new JobTools(registry);
		expect(tools.runOutput({ id: "job-none" })).toMatchObject({ ok: false, code: "unknown-job" });
	});

	test("job_kill：成功 killed；未知 → unknown-job；非运行态 → not-running", async () => {
		const { registry } = makeRegistry();
		const tools = new JobTools(registry);
		const running = registry.start("serve", {
			stream: (async function* () {
				yield "x";
				await new Promise((r) => setTimeout(r, 20));
			})(),
		});
		await flush();
		expect(tools.runKill({ id: running })).toEqual({ ok: true, killed: true, id: running });
		expect(tools.runKill({ id: running })).toMatchObject({ ok: false, code: "not-running" });
		expect(tools.runKill({ id: "job-none" })).toMatchObject({ ok: false, code: "unknown-job" });
		expect(tools.runKill({})).toMatchObject({ ok: false, code: "invalid-input" });
	});
});
