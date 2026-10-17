import { describe, expect, test } from "bun:test";
import type {
	SelectResultLike,
	SelectToolsRegistryLike,
	SurfaceByteStatsLike,
} from "./tool-activator";
import { MAX_SELECT_NAMES, createToolActivator } from "./tool-activator";

// ---------- 测试基建 ----------

/** 可脚本化的 registry stub（与 mcp 侧 ToolOnDemandRegistry duck-type 兼容）。 */
function stubRegistry(options: {
	selectResult?: SelectResultLike;
	bytes?: SurfaceByteStatsLike;
	selectCalls?: { count: number };
}): SelectToolsRegistryLike {
	return {
		async select(names) {
			if (options.selectCalls !== undefined) {
				options.selectCalls.count += 1;
			}
			if (options.selectResult !== undefined) {
				return options.selectResult;
			}
			return {
				activated: names.map((name) => ({
					name,
					server: "stub",
					description: `${name} 的描述`,
					inputSchema: { type: "object", properties: { path: { type: "string" } } },
				})),
				alreadyActive: [],
				unknown: [],
			};
		},
		surfaceByteStats: () => options.bytes ?? { baselineBytes: 0, initialBytes: 0, currentBytes: 0 },
	};
}

const successSelectResult: SelectResultLike = {
	activated: [
		{
			name: "fs.read",
			server: "fs",
			description: "读取文件",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
		},
	],
	alreadyActive: ["core.run"],
	unknown: [
		{
			kind: "unknown-tool",
			name: "fs.reda",
			message: `工具 "fs.reda" 不在工具目录中`,
			suggestions: ["fs.read"],
		},
	],
};

// ---------- 工具规格 ----------

describe("createToolActivator 工具规格", () => {
	test("name/description/inputSchema：select_tools + names 必填约束", () => {
		const activator = createToolActivator(stubRegistry({}));
		expect(activator.tool.name).toBe("select_tools");
		expect(activator.tool.description.length).toBeGreaterThan(10);
		const schema = activator.tool.inputSchema as Record<string, unknown>;
		expect(schema["type"]).toBe("object");
		expect(schema["required"]).toEqual(["names"]);
	});
});

// ---------- handle 输入校验 ----------

describe("createToolActivator.handle 输入校验", () => {
	test("非对象输入：invalid-input 拒绝", async () => {
		const activator = createToolActivator(stubRegistry({}));
		for (const input of [null, "names", 42, ["fs.read"]]) {
			const outcome = await activator.handle(input);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) {
				return;
			}
			expect(outcome.error.kind).toBe("invalid-input");
			expect(outcome.error.issues.length).toBeGreaterThan(0);
		}
	});

	test("names 缺失/非数组/空数组：issues 覆盖", async () => {
		const activator = createToolActivator(stubRegistry({}));
		for (const input of [{}, { names: "fs.read" }, { names: [] }]) {
			const outcome = await activator.handle(input);
			expect(outcome.ok).toBe(false);
			if (outcome.ok) {
				return;
			}
			expect(outcome.error.issues.length).toBeGreaterThan(0);
		}
	});

	test("names 超上限（>64）与空字符串元素：issues 覆盖", async () => {
		const activator = createToolActivator(stubRegistry({}));
		const tooMany = { names: Array.from({ length: MAX_SELECT_NAMES + 1 }, (_, i) => `t${i}`) };
		const tooManyOutcome = await activator.handle(tooMany);
		expect(tooManyOutcome.ok).toBe(false);
		if (!tooManyOutcome.ok) {
			expect(tooManyOutcome.error.issues.some((issue) => issue.includes("上限"))).toBe(true);
		}
		const blankOutcome = await activator.handle({ names: ["fs.read", "   "] });
		expect(blankOutcome.ok).toBe(false);
	});

	test("合法输入：ok=true，activated 全量序列化（schema + server 路由）", async () => {
		const calls = { count: 0 };
		const activator = createToolActivator(stubRegistry({ selectCalls: calls }));
		const outcome = await activator.handle({ names: ["fs.read"] });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		expect(outcome.result.activated[0]?.name).toBe("fs.read");
		expect(outcome.result.activated[0]?.server).toBe("stub");
		expect(outcome.result.activated[0]?.inputSchema).toEqual({
			type: "object",
			properties: { path: { type: "string" } },
		});
		expect(outcome.result.summary).toContain("已激活 1 个工具");
		expect(calls.count).toBe(1);
	});

	test("unknown 拒绝透传：结构化 unknown-tool + suggestions + summary 文案", async () => {
		const activator = createToolActivator(stubRegistry({ selectResult: successSelectResult }));
		const outcome = await activator.handle({ names: ["fs.reda"] });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		expect(outcome.result.unknown.length).toBe(1);
		expect(outcome.result.unknown[0]?.kind).toBe("unknown-tool");
		expect(outcome.result.unknown[0]?.suggestions).toEqual(["fs.read"]);
		expect(outcome.result.summary).toContain("1 个未知名被拒绝");
	});

	test("alreadyActive 透传：summary 含幂等提示", async () => {
		const activator = createToolActivator(stubRegistry({ selectResult: successSelectResult }));
		const outcome = await activator.handle({ names: ["core.run"] });
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) {
			return;
		}
		expect(outcome.result.alreadyActive).toEqual(["core.run"]);
		expect(outcome.result.summary).toContain("本就处于激活态");
	});
});

// ---------- compressionStats ----------

describe("createToolActivator.compressionStats", () => {
	test("精确计算：baseline=1000/initial=100/current=400 → 90%/60%，达标", () => {
		const activator = createToolActivator(
			stubRegistry({ bytes: { baselineBytes: 1000, initialBytes: 100, currentBytes: 400 } }),
		);
		const stats = activator.compressionStats();
		expect(stats.reductionPercent).toBe(90);
		expect(stats.currentReductionPercent).toBe(60);
		expect(stats.targetPercent).toBe(80);
		expect(stats.meetsTarget).toBe(true);
	});

	test("baseline 为 0（未装载）：压降 0 且不达标", () => {
		const activator = createToolActivator(stubRegistry({}));
		const stats = activator.compressionStats();
		expect(stats.reductionPercent).toBe(0);
		expect(stats.meetsTarget).toBe(false);
	});

	test("初态未达标（<80%）：meetsTarget=false", () => {
		const activator = createToolActivator(
			stubRegistry({ bytes: { baselineBytes: 1000, initialBytes: 500, currentBytes: 500 } }),
		);
		const stats = activator.compressionStats();
		expect(stats.reductionPercent).toBe(50);
		expect(stats.meetsTarget).toBe(false);
	});
});
