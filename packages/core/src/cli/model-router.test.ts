/**
 * 工单 H（BI-04 缺件补齐）—— 模型插槽路由器单测（全离线，零网络）。
 *
 * 覆盖面：
 * - route：有配置且装配成功 → 返回插槽端口（身份相等）；三键全无配置 → 回退
 *   主端口且 resolvePort 零调用；插槽装配失败（模型 ID 缺失 / model 为空 /
 *   resolvePort 抛出模拟凭据门失败）→ 回退主端口且不抛，结构化日志恰一行；
 * - assemble：三键全空 = 三插槽全空；部分配置 = 对应插槽就位、其余回退；
 * - resolvePort 注入替身（本模块不做任何 provider/model 解析，零真实装配）。
 */
import { describe, expect, test } from "bun:test";

import {
	assembleModelRouter,
	type ModelSlotName,
	type ResolveSlotPort,
} from "./model-router";
import { createDefaultConfig, type BiConfig } from "../config/schema";
import type { ModelPort } from "./headless";

// ---------------------------------------------------------------------------
// fixture（替身端口 + 注入式 resolvePort，零网络零真实装配）
// ---------------------------------------------------------------------------

/** 替身端口：stream 永不被消费（route 只做选择，不做驱动）。 */
function makePort(): ModelPort {
	return {
		stream(): AsyncIterable<never> {
			return {
				[Symbol.asyncIterator](): AsyncIterator<never> {
					return { next: async () => ({ done: true as const, value: undefined as never }) };
				},
			};
		},
	};
}

interface SlotHarness {
	main: ModelPort;
	ports: Record<string, ModelPort>;
	calls: string[];
	resolvePort: ResolveSlotPort;
	logs: string[];
}

/**
 * 替身装配面：ports 以 "provider/model" 为键；无对应条目 = 抛错
 * （模拟凭据门/无驱动协议失败面）。
 */
function makeHarness(ports: Record<string, ModelPort>): SlotHarness {
	const calls: string[] = [];
	const logs: string[] = [];
	return {
		main: ports["main"]!,
		ports,
		calls,
		logs,
		resolvePort: (providerName, modelName) => {
			const key = `${providerName}/${modelName}`;
			calls.push(key);
			const port = ports[key];
			if (port === undefined) throw new Error(`凭据门失败（替身）: ${key}`);
			return port;
		},
	};
}

/** 配置夹具：p1/p2 两 provider，main/fast 两模型条目，secondary_model 可注入。 */
function configWith(secondary: Partial<Record<ModelSlotName, string>>): BiConfig {
	const config = createDefaultConfig();
	config.providers.entries = {
		p1: {
			api_key_env: "",
			base_url: "https://mimo.test/v1",
			kind: "openai",
			models: ["main-model"],
			extra_headers: {},
		},
		p2: {
			api_key_env: "",
			base_url: "https://fast.test/v1",
			kind: "openai",
			models: ["fast-model"],
			extra_headers: {},
		},
	};
	config.models.entries = {
		main: { provider: "p1", model: "main-model", max_tokens: 0, temperature: 0.7, context_limit: 0 },
		fast: { provider: "p2", model: "fast-model", max_tokens: 0, temperature: 0.7, context_limit: 0 },
		empty: { provider: "p2", model: "", max_tokens: 0, temperature: 0.7, context_limit: 0 },
	};
	config.models.default = "main";
	config.secondary_model = {
		subagent: secondary.subagent ?? "",
		background: secondary.background ?? "",
		summarize: secondary.summarize ?? "",
	};
	return config;
}

// ---------------------------------------------------------------------------
// route：选择语义
// ---------------------------------------------------------------------------

describe("ModelRouter.route", () => {
	test("插槽有配置且装配成功 → 返回插槽端口（身份相等）", () => {
		const config = configWith({ subagent: "fast" });
		const fastPort = makePort();
		const h = makeHarness({ "p1/main-model": makePort(), "p2/fast-model": fastPort });
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main, log: (l) => h.logs.push(l) });
		expect(router.route("subagent")).toBe(fastPort);
		expect(h.calls).toEqual(["p2/fast-model"]);
		expect(h.logs).toEqual([]);
	});

	test("三键全无配置 → 回退主端口，resolvePort 零调用", () => {
		const config = configWith({});
		const h = makeHarness({ "p1/main-model": makePort() });
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main, log: (l) => h.logs.push(l) });
		expect(router.route("subagent")).toBe(h.main);
		expect(router.route("background")).toBe(h.main);
		expect(router.route("summarize")).toBe(h.main);
		expect(h.calls).toEqual([]);
		expect(h.logs).toEqual([]);
	});

	test("插槽模型 ID 不在 models.entries → 回退且不抛，日志一行", () => {
		const config = configWith({ subagent: "ghost" });
		const h = makeHarness({ "p1/main-model": makePort() });
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main, log: (l) => h.logs.push(l) });
		expect(router.route("subagent")).toBe(h.main);
		expect(h.calls).toEqual([]);
		expect(h.logs.length).toBe(1);
		expect(h.logs[0]).toContain("subagent");
		expect(h.logs[0]).toContain("ghost");
	});

	test("插槽条目缺供应商侧模型名 → 回退且不抛，日志一行", () => {
		const config = configWith({ summarize: "empty" });
		const h = makeHarness({ "p1/main-model": makePort() });
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main, log: (l) => h.logs.push(l) });
		expect(router.route("summarize")).toBe(h.main);
		expect(h.calls).toEqual([]);
		expect(h.logs.length).toBe(1);
		expect(h.logs[0]).toContain("summarize");
	});

	test("resolvePort 抛出（模拟凭据门失败）→ 回退且不抛，日志一行", () => {
		const config = configWith({ background: "fast" });
		const h = makeHarness({ "p1/main-model": makePort() }); // 故意缺 "p2/fast-model"
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main, log: (l) => h.logs.push(l) });
		expect(router.route("background")).toBe(h.main);
		expect(h.calls).toEqual(["p2/fast-model"]);
		expect(h.logs.length).toBe(1);
		expect(h.logs[0]).toContain("background");
		expect(h.logs[0]).toContain("回退主端口");
	});

	test("router.main 暴露主端口本体（回退面可诊断）", () => {
		const config = configWith({});
		const h = makeHarness({ "p1/main-model": makePort() });
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main });
		expect(router.main).toBe(h.main);
	});
});

// ---------------------------------------------------------------------------
// assemble：组合面
// ---------------------------------------------------------------------------

describe("assembleModelRouter", () => {
	test("三键全空 = 三插槽全空（全部回退主端口）", () => {
		const config = configWith({});
		const h = makeHarness({ "p1/main-model": makePort() });
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main, log: (l) => h.logs.push(l) });
		for (const slot of ["subagent", "background", "summarize"] as const) {
			expect(router.route(slot)).toBe(h.main);
		}
		expect(h.calls).toEqual([]);
		expect(h.logs).toEqual([]);
	});

	test("部分配置 = 对应插槽就位，其余键回退；失败键置空 + 日志", () => {
		const config = configWith({ subagent: "fast", background: "ghost" });
		const fastPort = makePort();
		const h = makeHarness({ "p1/main-model": makePort(), "p2/fast-model": fastPort });
		const router = assembleModelRouter(config, h.resolvePort, { main: h.main, log: (l) => h.logs.push(l) });
		expect(router.route("subagent")).toBe(fastPort);
		expect(router.route("background")).toBe(h.main);
		expect(router.route("summarize")).toBe(h.main);
		expect(h.calls).toEqual(["p2/fast-model"]);
		expect(h.logs.length).toBe(1);
		expect(h.logs[0]).toContain("background");
	});
});
