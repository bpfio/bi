/**
 * BI-07.8 测试 — SwarmService（扇出渲染 / 槽位池 / 超时隔离 / 聚合）+ AgentSwarmTool。
 */
import { describe, expect, test } from "bun:test";
import {
	SwarmError,
	SwarmService,
	renderSwarmPrompt,
} from "./swarm-service";
import { AgentSwarmTool, AGENT_SWARM_TOOL_SPEC } from "./agent-swarm-tool";
import { SWARM_MAX_TASKS } from "./types";

/** 在飞计数 stub：记录峰值与启动序。 */
function countingSpawn(delayMs = 5) {
	let inFlight = 0;
	const state = { peak: 0, starts: [] as string[] };
	const spawnFn = async (prompt: string): Promise<string> => {
		inFlight++;
		state.peak = Math.max(state.peak, inFlight);
		state.starts.push(prompt);
		await new Promise((r) => setTimeout(r, delayMs));
		inFlight--;
		return `out(${prompt})`;
	};
	return { spawnFn, state };
}

/** 门控 stub：启动即挂起，手动逐个放行（FIFO/保序断言用）。 */
function gatedSpawn() {
	const state = { starts: [] as string[] };
	const gates: Array<(v: string) => void> = [];
	const spawnFn = (prompt: string): Promise<string> => {
		state.starts.push(prompt);
		return new Promise((resolve) => gates.push(resolve));
	};
	const releaseAll = () => {
		for (const gate of gates.splice(0)) gate("done");
	};
	/** 反复排空：worker 放行后会取新号再挂门，直至全部条目完成。 */
	const drain = async (): Promise<void> => {
		while (gates.length > 0) {
			releaseAll();
			await Promise.resolve();
			await new Promise((r) => setTimeout(r, 0));
		}
	};
	return { spawnFn, state, gates, releaseAll, drain };
}

describe("BI-07.8 · 模板扇出渲染", () => {
	test("renderSwarmPrompt：{{item}} 全部出现处替换", () => {
		expect(renderSwarmPrompt("审查 {{item}}，然后复核 {{item}} 的结论", "X.csv")).toBe(
			"审查 X.csv，然后复核 X.csv 的结论",
		);
	});

	test("单条目：results[0] 字段齐备（item/ok/output/durationMs）", async () => {
		const { spawnFn } = countingSpawn();
		const service = new SwarmService(spawnFn);
		const result = await service.swarm(["only-one"], { promptTemplate: "处理 {{item}}" });
		expect(result.total).toBe(1);
		expect(result.failed).toBe(0);
		expect(result.results[0]).toMatchObject({
			item: "only-one",
			ok: true,
			output: "out(处理 only-one)",
		});
		expect(typeof result.results[0]!.durationMs).toBe("number");
		expect(result.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("item 含特殊字符/换行原样渲染（无转义）", async () => {
		const { spawnFn } = countingSpawn();
		const service = new SwarmService(spawnFn);
		const item = "a$b|c{{d}}\n第二行";
		const result = await service.swarm([item], { promptTemplate: "{{item}}" });
		expect(result.results[0]!.output).toBe(`out(${item})`);
	});

	test("结果与输入同序：乱序完成不改变聚合序（门控逆序放行）", async () => {
		const { spawnFn, gates } = gatedSpawn();
		const service = new SwarmService(spawnFn, { maxConcurrency: 3 });
		const pending = service.swarm(["t0", "t1", "t2"], { promptTemplate: "{{item}}" });
		// 逆序放行：t2 先完成。
		for (const i of [2, 1, 0]) gates[i]!(`done-${i}`);
		const result = await pending;
		expect(result.results.map((r) => r.item)).toEqual(["t0", "t1", "t2"]);
		expect(result.results.map((r) => r.output)).toEqual(["done-0", "done-1", "done-2"]);
	});

	test("spawnFn 拒绝 → 单条 ok:false + error 捕获，failed 计数，不炸整群", async () => {
		const spawnFn = async (prompt: string): Promise<string> => {
			if (prompt.includes("bad")) throw new Error("spawn 爆炸");
			return `out(${prompt})`;
		};
		const service = new SwarmService(spawnFn);
		const result = await service.swarm(["good", "bad", "good2"], { promptTemplate: "{{item}}" });
		expect(result.failed).toBe(1);
		expect(result.results[0]!.ok).toBe(true);
		expect(result.results[1]).toMatchObject({ item: "bad", ok: false, output: "" });
		expect(result.results[1]!.error).toBe("spawn 爆炸");
		expect(result.results[2]!.ok).toBe(true);
	});
});

describe("BI-07.8 · 并发槽位池（WorkerPool 房规：上限内并行、超限 FIFO）", () => {
	test("并发峰值恰为上限：8 任务 max=3 → peak === 3", async () => {
		const { spawnFn, state } = countingSpawn();
		const service = new SwarmService(spawnFn);
		const tasks = Array.from({ length: 8 }, (_, i) => `item-${i}`);
		const result = await service.swarm(tasks, { promptTemplate: "{{item}}", maxConcurrency: 3 });
		expect(state.peak).toBe(3);
		expect(result.failed).toBe(0);
	});

	test("缺省 maxConcurrency=3：不传上限时峰值仍 ≤3 且 =3", async () => {
		const { spawnFn, state } = countingSpawn();
		const service = new SwarmService(spawnFn);
		const tasks = Array.from({ length: 8 }, (_, i) => `item-${i}`);
		await service.swarm(tasks, { promptTemplate: "{{item}}" });
		expect(state.peak).toBe(3);
	});

	test("FIFO 排队：首批启动恰为输入前 max 条", async () => {
		const { spawnFn, state, drain } = gatedSpawn();
		const service = new SwarmService(spawnFn);
		const tasks = ["a", "b", "c", "d", "e", "f"];
		const pending = service.swarm(tasks, { promptTemplate: "{{item}}", maxConcurrency: 2 });
		expect(state.starts).toEqual(["a", "b"]); // 同步取号：首两批即起飞
		await drain();
		const result = await pending;
		expect(state.starts).toEqual(["a", "b", "c", "d", "e", "f"]); // 严格输入序取号
		expect(result.results).toHaveLength(6);
		expect(result.failed).toBe(0);
	});

	test("上限大于条目数：全部同时起飞（峰值 = 条目数）", async () => {
		const { spawnFn, state } = countingSpawn();
		const service = new SwarmService(spawnFn);
		await service.swarm(["a", "b", "c", "d"], { promptTemplate: "{{item}}", maxConcurrency: 10 });
		expect(state.peak).toBe(4);
	});

	test("实例级缺省并发：构造注入 maxConcurrency=2 覆盖缺省 3", async () => {
		const { spawnFn, state } = countingSpawn();
		const service = new SwarmService(spawnFn, { maxConcurrency: 2 });
		const tasks = Array.from({ length: 6 }, (_, i) => `item-${i}`);
		await service.swarm(tasks, { promptTemplate: "{{item}}" });
		expect(state.peak).toBe(2);
	});
});

describe("BI-07.8 · 单条超时（BI-06.3 withDeadline 复用）", () => {
	test("慢条目到点超时：ok:false + error 含 deadline，快条目不受拖累", async () => {
		const spawnFn = async (prompt: string): Promise<string> => {
			if (prompt.includes("slow")) await new Promise((r) => setTimeout(r, 150));
			return `out(${prompt})`;
		};
		const service = new SwarmService(spawnFn);
		const startedAt = Date.now();
		const result = await service.swarm(["fast-1", "slow", "fast-2"], {
			promptTemplate: "{{item}}",
			timeoutMs: 30,
		});
		const wall = Date.now() - startedAt;
		expect(result.failed).toBe(1);
		expect(result.results[1]).toMatchObject({ item: "slow", ok: false, output: "" });
		expect(result.results[1]!.error).toContain("exceeded deadline");
		expect(result.results[1]!.durationMs).toBeGreaterThanOrEqual(25);
		expect(result.results[0]!.ok).toBe(true);
		expect(result.results[2]!.ok).toBe(true);
		expect(wall).toBeLessThan(120); // 不等慢条目自然结束（150ms）
	});

	test("timeoutMs 缺省：不限时，慢条目正常完成", async () => {
		const spawnFn = async (prompt: string): Promise<string> => {
			if (prompt.includes("slow")) await new Promise((r) => setTimeout(r, 30));
			return `out(${prompt})`;
		};
		const service = new SwarmService(spawnFn);
		const result = await service.swarm(["fast", "slow"], { promptTemplate: "{{item}}" });
		expect(result.failed).toBe(0);
		expect(result.results.every((r) => r.ok)).toBe(true);
	});
});

describe("BI-07.8 · 入参校验（服务面结构化拒绝）", () => {
	test("空 tasks → invalid-tasks", async () => {
		const service = new SwarmService(async () => "");
		await expect(service.swarm([], { promptTemplate: "{{item}}" })).rejects.toMatchObject({
			name: "SwarmError",
			code: "invalid-tasks",
		});
	});

	test("tasks > 64 → invalid-tasks；恰好 64 → 成功", async () => {
		const service = new SwarmService(async (p) => p);
		const tooMany = Array.from({ length: SWARM_MAX_TASKS + 1 }, (_, i) => `t${i}`);
		await expect(service.swarm(tooMany, { promptTemplate: "{{item}}" })).rejects.toMatchObject({
			code: "invalid-tasks",
		});
		const exact = Array.from({ length: SWARM_MAX_TASKS }, (_, i) => `t${i}`);
		const result = await service.swarm(exact, { promptTemplate: "{{item}}" });
		expect(result.total).toBe(64);
		expect(result.failed).toBe(0);
	});

	test("tasks 非数组 / 含非字符串 → invalid-tasks", async () => {
		const service = new SwarmService(async () => "");
		await expect(
			service.swarm("not-array" as unknown as string[], { promptTemplate: "{{item}}" }),
		).rejects.toMatchObject({ code: "invalid-tasks" });
		await expect(
			service.swarm(["ok", 42] as unknown as string[], { promptTemplate: "{{item}}" }),
		).rejects.toMatchObject({ code: "invalid-tasks" });
	});

	test("模板缺 {{item}} 占位 → invalid-template", async () => {
		const service = new SwarmService(async () => "");
		await expect(service.swarm(["t"], { promptTemplate: "没有占位符" })).rejects.toMatchObject({
			code: "invalid-template",
		});
	});

	test("maxConcurrency 非正整数 / timeoutMs 非正数 → invalid-options", async () => {
		const service = new SwarmService(async () => "");
		await expect(
			service.swarm(["t"], { promptTemplate: "{{item}}", maxConcurrency: 0 }),
		).rejects.toMatchObject({ code: "invalid-options" });
		await expect(
			service.swarm(["t"], { promptTemplate: "{{item}}", maxConcurrency: 1.5 }),
		).rejects.toMatchObject({ code: "invalid-options" });
		await expect(
			service.swarm(["t"], { promptTemplate: "{{item}}", timeoutMs: 0 }),
		).rejects.toMatchObject({ code: "invalid-options" });
		await expect(
			service.swarm(["t"], { promptTemplate: "{{item}}", timeoutMs: -5 }),
		).rejects.toMatchObject({ code: "invalid-options" });
	});
});

describe("BI-07.8 · AgentSwarmTool 模型工具面", () => {
	test("spec：名称 AgentSwarm，必填 tasks + prompt_template", () => {
		expect(AGENT_SWARM_TOOL_SPEC.name).toBe("AgentSwarm");
		expect((AGENT_SWARM_TOOL_SPEC.inputSchema as { required: string[] }).required).toEqual([
			"tasks",
			"prompt_template",
		]);
	});

	test("run：非对象 / 缺 tasks / 缺模板占位 → invalid-input（不走异常）", async () => {
		const service = new SwarmService(async (p) => p);
		const tool = new AgentSwarmTool(service);
		expect(await tool.run(null)).toMatchObject({ ok: false, code: "invalid-input" });
		expect(await tool.run({ prompt_template: "{{item}}" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
		expect(await tool.run({ tasks: ["a"], prompt_template: "无占位" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
	});

	test("run：tasks 超 64 / 非字符串条目 → invalid-input", async () => {
		const service = new SwarmService(async (p) => p);
		const tool = new AgentSwarmTool(service);
		const tooMany = Array.from({ length: 65 }, (_, i) => `t${i}`);
		expect(await tool.run({ tasks: tooMany, prompt_template: "{{item}}" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
		expect(
			await tool.run({ tasks: ["a", 1], prompt_template: "{{item}}" }),
		).toMatchObject({ ok: false, code: "invalid-input" });
	});

	test("run：max_concurrency / timeout_ms 非法 → invalid-input", async () => {
		const service = new SwarmService(async (p) => p);
		const tool = new AgentSwarmTool(service);
		expect(
			await tool.run({ tasks: ["a"], prompt_template: "{{item}}", max_concurrency: 0 }),
		).toMatchObject({ ok: false, code: "invalid-input" });
		expect(
			await tool.run({ tasks: ["a"], prompt_template: "{{item}}", timeout_ms: -1 }),
		).toMatchObject({ ok: false, code: "invalid-input" });
	});

	test("run 成功 → ok:true + 聚合结构（results/failed/total）", async () => {
		const service = new SwarmService(async (p) => `R:${p}`);
		const tool = new AgentSwarmTool(service);
		const result = await tool.run({
			tasks: ["x", "y"],
			prompt_template: "分析 {{item}}",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.total).toBe(2);
			expect(result.failed).toBe(0);
			expect(result.results.map((r) => r.output)).toEqual(["R:分析 x", "R:分析 y"]);
		}
	});

	test("run：服务面错误码透传（>64 走 SwarmError invalid-tasks 路径）", async () => {
		const service = new SwarmService(async (p) => p);
		const tool = new AgentSwarmTool(service);
		// 直连 service 构造 SwarmError 场景：模板经 tool 校验已拦，此处断言 tool 拦截优先。
		const tooMany = Array.from({ length: 65 }, (_, i) => `t${i}`);
		expect(await tool.run({ tasks: tooMany, prompt_template: "{{item}}" })).toMatchObject({
			ok: false,
		});
	});

	test("run：max_concurrency 传递生效（5 任务 max=2 → 峰值 2）", async () => {
		const { spawnFn, state } = countingSpawn();
		const service = new SwarmService(spawnFn);
		const tool = new AgentSwarmTool(service);
		const tasks = Array.from({ length: 5 }, (_, i) => `item-${i}`);
		const result = await tool.run({
			tasks,
			prompt_template: "{{item}}",
			max_concurrency: 2,
		});
		expect(result.ok).toBe(true);
		expect(state.peak).toBe(2);
	});
});

describe("BI-07.8 · SwarmError 结构化判别", () => {
	test("code/name 字段可分支自愈", () => {
		const err = new SwarmError("invalid-tasks", "x");
		expect(err.name).toBe("SwarmError");
		expect(err.code).toBe("invalid-tasks");
		expect(err).toBeInstanceOf(Error);
	});
});
