/**
 * FIX-A F1 · cron 装配接线验收（[cron] enabled → 三工具真正工作）。
 *
 * 关注面：
 * 1. 调度核适配器（cli/cron-kernel.ts）：parseCron/nextFire 真实委托 workflow
 *    解析核（BI-07.14）——非法表达式抛错、可命中表达式算出未来的触发时刻。
 * 2. 工具面：注入真 CronService（workflow 调度核）后 cron_schedule/cron_list/
 *    cron_remove 三动作真实生效（登记 → 巡检 → 注销），非法表达式结构化拒绝。
 * 3. main 装配面：config [cron] enabled → 无头会话工具面含三件 cron 工具；
 *    未声明 [cron] → 不挂载（缺省零行为差）。
 * 4. 诚实性：工具描述如实陈述"到点自动触发未接"（不冒充已可定时执行）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowCronCorePort } from "./cron-kernel";
import { buildDefaultToolset, type SpawnImpl } from "./toolset";
import { CronService } from "../cron/cron-service";
import { runBi } from "./main";
import type { ModelPort, ToolBinding } from "./headless";
import type { StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type BiConfig } from "../config/schema";

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

/** 记录模型收到的工具名集合（无头会话把工具定义喂给模型）。 */
function scriptedModel(): { port: ModelPort; toolNames: () => string[] } {
	const seen: string[] = [];
	const port: ModelPort = {
		async *stream(input): AsyncGenerator<StreamEvent> {
			seen.push(...input.tools.map((t) => t.name));
			yield { type: "content_delta", delta: "好。" };
			yield { type: "done", stopReason: "stop" };
		},
	};
	return { port, toolNames: () => [...seen] };
}

function configWith(patch: (config: BiConfig) => void): BiConfig {
	const config = createDefaultConfig();
	patch(config);
	return config;
}

describe("FIX-A F1 · 调度核适配器：委托 workflow 解析核", () => {
	test("合法 5 字段表达式：算出严格晚于 now 的下次触发时刻", () => {
		const port = workflowCronCorePort("UTC");
		const parsed = port.parseCron("0 9 * * *");
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const next = port.nextFire(parsed, now);
		expect(next).toBeGreaterThan(now);
		expect(new Date(next).toISOString()).toBe("2026-01-01T09:00:00.000Z");
	});

	test("非法表达式：parseCron 抛错（宿主包装为结构化 invalid-expr）", () => {
		const port = workflowCronCorePort("UTC");
		expect(() => port.parseCron("not a cron")).toThrow();
	});

	test("不可命中表达式（2 月 30 日）：nextFire 抛错而非返回 null", () => {
		const port = workflowCronCorePort("UTC");
		const parsed = port.parseCron("0 0 30 2 *");
		expect(() => port.nextFire(parsed, Date.UTC(2026, 0, 1))).toThrow();
	});
});

describe("FIX-A F1 · 工具面：真 CronService 下三动作真实生效", () => {
	test("schedule → list → remove：登记条目含下次触发时刻，注销后清空", async () => {
		const service = new CronService({ core: workflowCronCorePort("UTC") });
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), cronService: service });
		const schedule = byName(tools, "cron_schedule");
		const list = byName(tools, "cron_list");
		const remove = byName(tools, "cron_remove");

		const created = JSON.parse((await schedule.execute({ name: "nightly", cron_expr: "0 9 * * *" }, SIGNAL)) as string) as {
			ok: boolean;
			entry?: { id: string; nextFireAt: number };
		};
		expect(created.ok).toBe(true);
		expect(created.entry!.nextFireAt).toBeGreaterThan(Date.now());

		const listed = JSON.parse((await list.execute({}, SIGNAL)) as string).entries as Array<{ id: string }>;
		expect(listed).toHaveLength(1);
		expect(listed[0]!.id).toBe(created.entry!.id);

		const removed = JSON.parse((await remove.execute({ id: created.entry!.id }, SIGNAL)) as string) as { ok: boolean };
		expect(removed.ok).toBe(true);
		expect(JSON.parse((await list.execute({}, SIGNAL)) as string).entries).toEqual([]);
	});

	test("非法表达式：结构化拒绝 code=invalid-expr（不登记条目）", async () => {
		const service = new CronService({ core: workflowCronCorePort("UTC") });
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
		expect(service.list()).toHaveLength(0);
	});

	test("工具描述如实陈述：到点自动触发未接（不冒充已可定时执行）", () => {
		const service = new CronService({ core: workflowCronCorePort("UTC") });
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), cronService: service });
		const description = byName(tools, "cron_schedule").definition.description;
		expect(description).toContain("到点自动触发尚未接线");
	});
});

describe("FIX-A F1 · main 装配面：[cron] enabled → 三件工具挂载", () => {
	test("[cron] enabled：无头会话工具面含 cron_schedule/cron_list/cron_remove", async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-cron-wire-"));
		try {
			const { port, toolNames } = scriptedModel();
			const code = await runBi(["--prompt", "登记一条 cron"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.cron = { enabled: true };
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions") },
			});
			expect(code).toBe(0);
			const names = toolNames();
			expect(names).toContain("cron_schedule");
			expect(names).toContain("cron_list");
			expect(names).toContain("cron_remove");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("未声明 [cron]：工具面不含三件 cron 工具（缺省零行为差）", async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-cron-wire-"));
		try {
			const { port, toolNames } = scriptedModel();
			const code = await runBi(["--prompt", "你好"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith(() => {}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions") },
			});
			expect(code).toBe(0);
			const names = toolNames();
			expect(names).not.toContain("cron_schedule");
			expect(names).not.toContain("cron_list");
			expect(names).not.toContain("cron_remove");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
