/**
 * BI-07.7 装配验收 —— cron_schedule/cron_list/cron_remove 注册进 buildDefaultToolset
 * （条件注册门）。
 *
 * 关注面（先例照抄 ask_user_question / spawn_subagent）：
 * - 缺省（未注入 cronService）注册表不含三件 cron 工具（既有工具面零变动）。
 * - 注入 cronService 后三件在表（readOnly=true）。
 * - 生命周期：cron_schedule 登记 → cron_list 返回 → cron_remove 注销。
 * - 非法表达式结构化拒绝（code=invalid-expr），绝不假冒执行。
 * - 备案：定时触发（CronService.tick → onFire）归宿主运行环，本测试只验证条目
 *   管理与列表查询两动作的注册与行为；不验证定时触发。
 */
import { describe, expect, test } from "bun:test";
import { buildDefaultToolset, type SpawnImpl, cronBindings } from "./toolset";
import type { ToolBinding } from "./headless";
import { CronService, type CronCorePort, type CronEntry } from "../cron/cron-service";

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

/** 注入 buildDefaultToolset 的 cronService（含 stub 调度核 + 可变时钟）。 */
function makeCronService(fires: number[], failParse: ReadonlySet<string> = new Set()) {
	const box = makeClock();
	const core = new StubCronCore(fires, failParse);
	const service = new CronService({ core, clock: box.clock as never });
	return { service, core, box };
}

describe("BI-07.7 · 注册门：仅注入 cronService 才挂三件 cron 工具", () => {
	test("缺省 buildDefaultToolset 不含 cron_schedule/cron_list/cron_remove", () => {
		const names = new Set(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }).map((t) => t.definition.name));
		expect(names.has("cron_schedule")).toBe(false);
		expect(names.has("cron_list")).toBe(false);
		expect(names.has("cron_remove")).toBe(false);
	});

	test("注入 cronService 后三件在表（readOnly=true）；definition 面齐全", () => {
		const { service } = makeCronService([1000]);
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), cronService: service });
		const names = tools.map((t) => t.definition.name);
		expect(names).toContain("cron_schedule");
		expect(names).toContain("cron_list");
		expect(names).toContain("cron_remove");
		for (const n of ["cron_schedule", "cron_list", "cron_remove"]) {
			expect(byName(tools, n).readOnly).toBe(true);
		}
		// cronBindings 导出面：直接产出同样三件
		expect(cronBindings(service).map((b) => b.definition.name).sort()).toEqual(
			["cron_list", "cron_remove", "cron_schedule"].sort(),
		);
	});
});

describe("BI-07.7 · 生命周期：schedule → list → remove", () => {
	test("登记后 list 返回条目；remove 后 list 清空（幂等/未知 id 结构化）", async () => {
		const { service } = makeCronService([1000, 2000]);
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), cronService: service });
		const schedule = byName(tools, "cron_schedule");
		const list = byName(tools, "cron_list");
		const remove = byName(tools, "cron_remove");

		// 空表
		expect(JSON.parse((await list.execute({}, SIGNAL)) as string).entries).toEqual([]);

		// 登记
		const created = JSON.parse((await schedule.execute({ name: "nightly", cron_expr: "0 0 * * *" }, SIGNAL)) as string) as {
			ok: true;
			entry: CronEntry;
		};
		expect(created.ok).toBe(true);
		expect(created.entry.name).toBe("nightly");
		expect(created.entry.id).toMatch(/^cron-\d+$/);

		// list 含一条
		const listed = JSON.parse((await list.execute({}, SIGNAL)) as string).entries as CronEntry[];
		expect(listed).toHaveLength(1);
		expect(listed[0]!.id).toBe(created.entry.id);

		// 注销
		const removed = JSON.parse((await remove.execute({ id: created.entry.id }, SIGNAL)) as string) as {
			ok: boolean;
			deleted?: boolean;
			id?: string;
		};
		expect(removed.ok).toBe(true);
		expect(removed.deleted).toBe(true);

		// 再次 list 清空
		expect(JSON.parse((await list.execute({}, SIGNAL)) as string).entries).toEqual([]);

		// 注销未知 id → 结构化 unknown-cron
		const unknown = JSON.parse((await remove.execute({ id: "cron-999" }, SIGNAL)) as string) as {
			ok: boolean;
			code?: string;
		};
		expect(unknown.ok).toBe(false);
		expect(unknown.code).toBe("unknown-cron");
	});

	test("同名幂等：重复 schedule 返回既有条目，不重复登记", async () => {
		const { service } = makeCronService([1000, 2000]);
		const schedule = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), cronService: service }),
			"cron_schedule",
		);
		const first = JSON.parse((await schedule.execute({ name: "dup", cron_expr: "0 0 * * *" }, SIGNAL)) as string).entry;
		const second = JSON.parse((await schedule.execute({ name: "dup", cron_expr: "0 0 * * *" }, SIGNAL)) as string).entry;
		expect(second.id).toBe(first.id);
		expect(service.list()).toHaveLength(1);
	});
});

describe("BI-07.7 · 非法表达式结构化拒绝", () => {
	test("cron_expr 非法 → ok:false, code=invalid-expr；不假冒执行", async () => {
		const { service } = makeCronService([], new Set(["not a cron"]));
		const schedule = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), cronService: service }),
			"cron_schedule",
		);
		const result = JSON.parse((await schedule.execute({ name: "bad", cron_expr: "not a cron" }, SIGNAL)) as string) as {
			ok: boolean;
			code?: string;
		};
		expect(result.ok).toBe(false);
		expect(result.code).toBe("invalid-expr");
		expect(service.list()).toHaveLength(0); // 未登记
	});

	test("参数校验：name/cron_expr 缺参 → 结构化失败（不触调度核）", async () => {
		const { service, core } = makeCronService([1000]);
		const schedule = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), cronService: service }),
			"cron_schedule",
		);
		for (const args of [{}, { name: "x" }, { cron_expr: "* * * * *" }, { name: "  ", cron_expr: "* * * * *" }]) {
			const r = JSON.parse((await schedule.execute(args, SIGNAL)) as string) as { ok: boolean; code?: string };
			expect(r.ok).toBe(false);
		}
		expect(core.parseCalls).toHaveLength(0); // 参数校验先于调度核委托
	});
});
