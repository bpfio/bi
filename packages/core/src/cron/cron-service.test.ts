/**
 * BI-07.7 测试 — CronService（端口委托 / Jitter / 事件溯源 / 幂等）+ CronTools 三件套。
 */
import { describe, expect, test } from "bun:test";
import {
	CronError,
	CronService,
	type CronAction,
	type CronCorePort,
	type CronEntry,
	type CronEvent,
} from "./cron-service";
import {
	CRON_CREATE_TOOL_SPEC,
	CRON_DELETE_TOOL_SPEC,
	CRON_LIST_TOOL_SPEC,
	CronTools,
} from "./cron-tools";

/** 可变假时钟（仅 now 面；调度核推进全经显式 tick，禁用定时器面）。 */
function makeClock() {
	let nowMs = 0;
	return {
		clock: {
			now: () => nowMs,
			setTimeout: (): unknown => {
				throw new Error("CronService 不应使用定时器（时钟推进经 tick）");
			},
			clearTimeout: (): void => undefined,
		},
		getNow: () => nowMs,
		setNow: (v: number) => {
			nowMs = v;
		},
	};
}

/** stub 调度核：按队列回放 nextFire；记录调用踪迹断言委托发生。 */
class StubCronCore implements CronCorePort {
	readonly parseCalls: string[] = [];
	readonly #calls: Array<{ parsed: unknown; fromMs: number }> = [];
	readonly #fires: number[];
	readonly #failParse: ReadonlySet<string>;

	constructor(fires: number[], failParse: ReadonlySet<string> = new Set()) {
		this.#fires = [...fires];
		this.#failParse = failParse;
	}

	parseCron(expr: string): unknown {
		this.parseCalls.push(expr);
		if (this.#failParse.has(expr)) throw new Error(`非法字段: ${expr}`);
		return { expr };
	}

	nextFire(parsed: unknown, fromMs: number): number {
		this.#calls.push({ parsed, fromMs });
		const next = this.#fires.shift();
		if (next === undefined) throw new Error("400 年硬边界：无可命中触发时刻");
		return next;
	}

	get nextFireCalls(): Array<{ parsed: unknown; fromMs: number }> {
		return this.#calls;
	}
}

/** service 工厂：fires 队列 + jitter 序列 + 可变时钟，一并交出 stub 供委托断言。 */
function makeService(fires: number[], jitters: number[], failParse: ReadonlySet<string> = new Set()) {
	const box = makeClock();
	let j = 0;
	const stub = new StubCronCore(fires, failParse);
	const service = new CronService({
		core: stub,
		jitterMs: () => (j < jitters.length ? jitters[j++]! : 0),
		clock: box.clock,
	});
	return { service, stub, ...box };
}

describe("BI-07.7 · CronService 端口委托（不重建 cron 解析）", () => {
	test("create：字段齐备，nextFireAt = 端口返回 + 注入 jitter，快照副本", () => {
		const { service } = makeService([100], [500]);
		const entry = service.create("巡检", "*/5 * * * *", () => undefined);
		expect(entry.id).toBe("cron-1");
		expect(entry.name).toBe("巡检");
		expect(entry.cronExpr).toBe("*/5 * * * *");
		expect(entry.createdAt).toBe(0);
		expect(entry.jitterMs).toBe(500);
		expect(entry.nextFireAt).toBe(600);
		expect(entry.lastFiredAt).toBeNull();
	});

	test("端口委托：parseCron(cronExpr) 与 nextFire(parsed, now) 各一次（stub 踪迹）", () => {
		const { service, stub } = makeService([100], [0]);
		service.create("t", "0 9 * * *", () => undefined);
		expect(stub.parseCalls).toEqual(["0 9 * * *"]);
		expect(stub.nextFireCalls).toEqual([{ parsed: { expr: "0 9 * * *" }, fromMs: 0 }]);
	});

	test("不自带 cron 解析：端口 parseCron 抛错 → 结构化 invalid-expr，零事件零条目", () => {
		const { service } = makeService([], [], new Set(["bad"]));
		expect(() => service.create("t", "bad", () => undefined)).toThrow(CronError);
		try {
			service.create("t2", "bad", () => undefined);
		} catch (err) {
			expect((err as CronError).code).toBe("invalid-expr");
			expect((err as Error).message).toContain("非法字段");
		}
		expect(service.events()).toHaveLength(0);
		expect(service.list()).toHaveLength(0);
	});

	test("端口 nextFire 不可达 → unreachable-schedule", () => {
		const { service } = makeService([], []);
		expect(() => service.create("t", "0 9 * * *", () => undefined)).toThrow(CronError);
		try {
			service.create("t2", "0 9 * * *", () => undefined);
		} catch (err) {
			expect((err as CronError).code).toBe("unreachable-schedule");
		}
	});

	test("空名 / 非函数 action → invalid-name", () => {
		const { service } = makeService([100], [0]);
		expect(() => service.create("  ", "0 9 * * *", () => undefined)).toThrow(CronError);
		try {
			service.create("t", "0 9 * * *", undefined as unknown as CronAction);
		} catch (err) {
			expect((err as CronError).code).toBe("invalid-name");
		}
	});
});

describe("BI-07.7 · Jitter 防惊群", () => {
	test("注入固定 jitter：nextFireAt 精确 = nextFire + jitter", () => {
		const { service } = makeService([1000], [7777]);
		const entry = service.create("t", "0 9 * * *", () => undefined);
		expect(entry.nextFireAt).toBe(1000 + 7777);
		expect(entry.jitterMs).toBe(7777);
	});

	test("缺省 jitter ∈ [0, 30000] 且为整数", () => {
		const box = makeClock();
		const fires = Array.from({ length: 60 }, (_, i) => 60_000 * (i + 1));
		const service = new CronService({ core: new StubCronCore(fires), clock: box.clock });
		for (let i = 0; i < 60; i++) {
			const entry = service.create(`t${i}`, "0 9 * * *", () => undefined);
			const jitter = entry.nextFireAt - fires[i]!;
			expect(Number.isInteger(jitter)).toBe(true);
			expect(jitter).toBeGreaterThanOrEqual(0);
			expect(jitter).toBeLessThanOrEqual(30_000);
		}
	});
});

describe("BI-07.7 · 三工具面与幂等 create", () => {
	test("幂等 create：同名返回同 id 条目、list 长度 1、CronAdd 仅一条", () => {
		const { service } = makeService([100], [0]);
		const first = service.create("daily", "0 9 * * *", () => undefined);
		const second = service.create("daily", "0 9 * * *", () => undefined);
		expect(second.id).toBe(first.id);
		expect(service.list()).toHaveLength(1);
		const adds = service.events().filter((e) => e.type === "CronAdd");
		expect(adds).toHaveLength(1);
	});

	test("异名同表达式 → 两条独立条目", () => {
		const { service } = makeService([100, 200], [0]);
		service.create("a", "0 9 * * *", () => undefined);
		service.create("b", "0 9 * * *", () => undefined);
		expect(service.list()).toHaveLength(2);
	});

	test("list：按 createdAt 升序，快照与内部演进隔离", () => {
		const { service } = makeService([100, 200, 300], [0]);
		service.create("a", "0 9 * * *", () => undefined);
		service.create("b", "0 9 * * *", () => undefined);
		service.create("c", "0 9 * * *", () => undefined);
		const listed = service.list();
		expect(listed.map((e) => e.name)).toEqual(["a", "b", "c"]);
		listed[0]!.name = "mutated";
		expect(service.list()[0]!.name).toBe("a");
	});

	test("delete：true + CronDelete 事件 + 移除；重复/未知 delete → false", () => {
		const { service } = makeService([100], [0]);
		const entry = service.create("t", "0 9 * * *", () => undefined);
		expect(service.delete(entry.id)).toBe(true);
		expect(service.list()).toHaveLength(0);
		expect(service.delete(entry.id)).toBe(false);
		expect(service.delete("cron-none")).toBe(false);
		const deletes = service.events().filter((e) => e.type === "CronDelete");
		expect(deletes).toHaveLength(1);
	});
});

describe("BI-07.7 · tick 触发与重排", () => {
	test("未到期 tick：零触发、零 CronFired", async () => {
		const { service, setNow } = makeService([1000], [0]);
		service.create("t", "0 9 * * *", () => undefined);
		setNow(500);
		expect(await service.tick(500)).toBe(0);
		expect(service.events().filter((e) => e.type === "CronFired")).toHaveLength(0);
	});

	test("到期触发：action 收到条目、lastFiredAt 更新、重排经端口 + 新 jitter、CronFired 事件", async () => {
		const { service, stub, setNow } = makeService([100, 999], [0, 500]);
		const seen: string[] = [];
		service.create("t", "0 9 * * *", (entry) => {
			seen.push(entry.id);
		});
		setNow(150);
		expect(await service.tick(150)).toBe(1);
		expect(seen).toEqual(["cron-1"]);
		const entry = service.list()[0]!;
		expect(entry.lastFiredAt).toBe(150);
		expect(entry.nextFireAt).toBe(999 + 500); // 重排：端口返回 + 新 jitter
		expect(entry.jitterMs).toBe(500);
		expect(stub.nextFireCalls).toEqual([
			{ parsed: { expr: "0 9 * * *" }, fromMs: 0 },
			{ parsed: { expr: "0 9 * * *" }, fromMs: 150 },
		]);
		const fired = service.events().filter((e) => e.type === "CronFired");
		expect(fired).toEqual([{ type: "CronFired", at: 150, id: "cron-1" }]);
	});

	test("多条到期：按 nextFireAt 升序逐个触发", async () => {
		const { service, setNow } = makeService([200, 100, 999, 999], [0]);
		const order: string[] = [];
		service.create("late", "0 9 * * *", (e) => {
			order.push(e.name);
		});
		service.create("early", "0 9 * * *", (e) => {
			order.push(e.name);
		});
		setNow(1000);
		expect(await service.tick(1000)).toBe(2);
		expect(order).toEqual(["early", "late"]);
	});

	test("action 抛错不阻断：lastError 留痕、CronFired 带 error、其余条目照常触发", async () => {
		const { service, setNow } = makeService([100, 200, 999, 999], [0]);
		service.create("boom", "0 9 * * *", () => {
			throw new Error("boom");
		});
		service.create("ok", "0 9 * * *", () => undefined);
		setNow(1000);
		expect(await service.tick(1000)).toBe(2);
		const fired = service.events().filter((e) => e.type === "CronFired") as Array<
			Extract<CronEvent, { type: "CronFired" }>
		>;
		expect(fired).toHaveLength(2);
		expect(fired[0]!.error).toBe("boom");
		expect(fired[1]!.error).toBeUndefined();
		const boom = service.list().find((e) => e.name === "boom")!;
		expect(boom.lastError).toBe("boom");
		expect(boom.nextFireAt).toBe(999);
	});

	test("重排不可达：nextFireAt=Infinity、lastError 留痕、后续 tick 不再触发", async () => {
		const { service, setNow } = makeService([100], [0]); // 重排时队列已空 → 抛
		service.create("t", "0 9 * * *", () => undefined);
		setNow(200);
		expect(await service.tick(200)).toBe(1);
		const entry = service.list()[0]!;
		expect(entry.nextFireAt).toBe(Number.POSITIVE_INFINITY);
		expect(entry.lastError).toContain("硬边界");
		expect(await service.tick(999_999)).toBe(0);
	});

	test("async action：tick 等待完成后再重排与返回", async () => {
		const { service, setNow } = makeService([100, 999], [0]);
		const log: string[] = [];
		service.create("t", "0 9 * * *", async () => {
			log.push("start");
			await new Promise((r) => setTimeout(r, 5));
			log.push("end");
		});
		setNow(150);
		await service.tick(150);
		expect(log).toEqual(["start", "end"]);
	});

	test("事件溯源全序：CronAdd → CronFired → CronDelete（字段齐备）", async () => {
		const { service, setNow } = makeService([100, 999], [0]);
		const entry = service.create("t", "0 9 * * *", () => undefined);
		setNow(150);
		await service.tick(150);
		service.delete(entry.id);
		const events = service.events();
		expect(events.map((e) => e.type)).toEqual(["CronAdd", "CronFired", "CronDelete"]);
		expect(events[0]).toMatchObject({ type: "CronAdd", at: 0, id: entry.id, name: "t", nextFireAt: 100 });
		expect(events[1]).toMatchObject({ type: "CronFired", at: 150, id: entry.id });
		expect(events[2]).toMatchObject({ type: "CronDelete", at: 150, id: entry.id });
	});
});

describe("BI-07.7 · CronTools 模型工具三件套", () => {
	test("specs：CronCreate/CronList/CronDelete 名称与必填面", () => {
		expect(CRON_CREATE_TOOL_SPEC.name).toBe("CronCreate");
		expect((CRON_CREATE_TOOL_SPEC.inputSchema as { required: string[] }).required).toEqual([
			"name",
			"cron_expr",
		]);
		expect(CRON_LIST_TOOL_SPEC.name).toBe("CronList");
		expect(CRON_DELETE_TOOL_SPEC.name).toBe("CronDelete");
	});

	test("CronCreate 缺参/非对象 → invalid-input（拒绝不走异常）", async () => {
		const { service } = makeService([100], [0]);
		const tools = new CronTools({ service });
		expect(await tools.runCreate(null)).toMatchObject({ ok: false, code: "invalid-input" });
		expect(await tools.runCreate({ cron_expr: "0 9 * * *" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
		expect(await tools.runCreate({ name: "t" })).toMatchObject({ ok: false, code: "invalid-input" });
		expect(await tools.runCreate({ name: "", cron_expr: "0 9 * * *" })).toMatchObject({
			ok: false,
			code: "invalid-input",
		});
	});

	test("CronCreate 成功 → ok:true entry；非法表达式 → ok:false invalid-expr", async () => {
		const { service } = makeService([100], [0], new Set(["bad"]));
		const tools = new CronTools({ service });
		const ok = await tools.runCreate({ name: "t", cron_expr: "0 9 * * *" });
		expect(ok).toMatchObject({ ok: true, entry: { name: "t", cronExpr: "0 9 * * *" } });
		const bad = await tools.runCreate({ name: "b", cron_expr: "bad" });
		expect(bad).toMatchObject({ ok: false, code: "invalid-expr" });
	});

	test("CronList → ok:true entries 与 service.list 一致", async () => {
		const { service } = makeService([100, 200], [0]);
		const tools = new CronTools({ service });
		await tools.runCreate({ name: "a", cron_expr: "0 9 * * *" });
		await tools.runCreate({ name: "b", cron_expr: "0 10 * * *" });
		const listed = tools.runList();
		expect(listed.ok).toBe(true);
		expect("entries" in listed && listed.entries.map((e) => e.name)).toEqual(["a", "b"]);
	});

	test("CronDelete：成功 ok:true deleted:true；未知 → ok:false unknown-cron", async () => {
		const { service } = makeService([100], [0]);
		const tools = new CronTools({ service });
		const created = await tools.runCreate({ name: "t", cron_expr: "0 9 * * *" });
		const id = (created as { entry: CronEntry }).entry.id;
		expect(await tools.runDelete({ id })).toEqual({ ok: true, deleted: true, id });
		expect(await tools.runDelete({ id })).toMatchObject({ ok: false, code: "unknown-cron" });
		expect(await tools.runDelete({})).toMatchObject({ ok: false, code: "invalid-input" });
	});

	test("onFire 装配回调注入：tick 触发时收到条目", async () => {
		const { service, setNow } = makeService([100, 999], [0]);
		const fired: string[] = [];
		const tools = new CronTools({ service, onFire: (entry) => void fired.push(entry.name) });
		await tools.runCreate({ name: "t", cron_expr: "0 9 * * *" });
		setNow(150);
		await service.tick(150);
		expect(fired).toEqual(["t"]);
	});
});
