/**
 * W4-D9（BI-05.1）· [memory] 挂载式分区 schema 验收（仿 W3-D7 [context]）。
 *
 * - [memory] 为挂载式分区：DEFAULT_BI_CONFIG 恒 17 个根键（既有钉死断言不红），
 *   仅配置层显式声明时物化进合并结果（缺省 config.memory === undefined）；
 * - 子键全部缺省关（false），未声明时不存在 memory 键；
 * - 子键类型不符/未知键记诊断并 fail-closed 丢弃（不冒充合法）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BI_CONFIG_SCHEMA,
	DEFAULT_BI_CONFIG,
	createDefaultConfig,
	deepMergeLayer,
	validateConfigLayer,
	type BiConfig,
	type BiConfigLayer,
	type ConfigIssue,
} from "./schema";
import { ConfigService } from "./config-service";

function validate(raw: unknown): { layer: BiConfigLayer | undefined; issues: ConfigIssue[] } {
	const issues: ConfigIssue[] = [];
	const layer = validateConfigLayer(raw, issues);
	return { layer, issues };
}

describe("W4-D9 config: 缺省值与 17 根键拓扑（回归）", () => {
	test("根配置仍为 17 个强类型分区：DEFAULT_BI_CONFIG 不含 memory 键（挂载式拓扑）", () => {
		expect(Object.keys(DEFAULT_BI_CONFIG).sort()).toEqual([
			"a2a",
			"hooks",
			"identity",
			"image",
			"loop_control",
			"mcp",
			"models",
			"permission",
			"providers",
			"read",
			"secondary_model",
			"telemetry",
			"thinking",
			"tools",
			"tui",
			"watch",
			"workspace",
		]);
		expect("memory" in DEFAULT_BI_CONFIG).toBe(false);
		expect(createDefaultConfig().memory).toBeUndefined();
	});

	test("BI_CONFIG_SCHEMA 默认值与 DEFAULT_BI_CONFIG 一致（新增挂载分区不影响根键数）", () => {
		expect(BI_CONFIG_SCHEMA.defaultValue()).toEqual(DEFAULT_BI_CONFIG);
	});
});

describe("W4-D9 config: 单层校验（[memory] 挂载分区）", () => {
	test("合法 [memory] 层：显式键进层，缺省键不出现（合并期继承/backfill）", () => {
		const { layer, issues } = validate({ memory: { dream_enabled: true } });
		expect(issues).toEqual([]);
		expect(layer).toEqual({ memory: { dream_enabled: true } });
	});

	test("子键类型不符/未知键记诊断并 fail-closed 丢弃（不冒充合法，缺省保持关）", () => {
		const { layer, issues } = validate({
			memory: { dream_enabled: "yes", unknown_key: 1 },
		});
		expect(layer).toBeUndefined();
		expect(issues.some((i) => i.path === "memory.dream_enabled")).toBe(true);
		expect(issues.some((i) => i.path === "memory.unknown_key")).toBe(true);
	});

	test("[memory] 空表 / 非 table：等价于未提供（默认路径无 memory 键）", () => {
		expect(validate({ memory: {} }).layer).toBeUndefined();
		const bad = validate({ memory: 42 });
		expect(bad.layer).toBeUndefined();
		expect(bad.issues.some((i) => i.path === "memory")).toBe(true);
	});

	test("合并 + backfill：仅声明 dream_enabled 的 [memory] 物化后叶子默认补齐", () => {
		const base = createDefaultConfig();
		deepMergeLayer(base, validate({ memory: { dream_enabled: true } }).layer);
		BI_CONFIG_SCHEMA.backfill?.(base);
		expect(base.memory).toEqual({ dream_enabled: true, inject_enabled: false });
	});

	test("合并：未声明 [memory] 的层合入后 base 仍无 memory 键（缺省等价）", () => {
		const base = createDefaultConfig();
		deepMergeLayer(base, validate({ tools: { output_limit_bytes: 1024 } }).layer);
		BI_CONFIG_SCHEMA.backfill?.(base);
		expect("memory" in base).toBe(false);
		expect(base.tools.output_limit_bytes).toBe(1024);
	});
});

describe("W4-D9 config: ConfigService 三级 TOML 端到端", () => {
	async function withHome(configToml?: string): Promise<{ home: string; work: string; cleanup: () => Promise<void> }> {
		const home = await mkdtemp(join(tmpdir(), "bi-w4d9-home-"));
		const work = await mkdtemp(join(tmpdir(), "bi-w4d9-work-"));
		await mkdir(join(home, ".bi"), { recursive: true });
		if (configToml !== undefined) await writeFile(join(home, ".bi", "config.toml"), configToml, "utf8");
		const cleanup = async (): Promise<void> => {
			await rm(home, { recursive: true, force: true });
			await rm(work, { recursive: true, force: true });
		};
		return { home, work, cleanup };
	}

	test("config.toml 声明 [memory]：load() 物化且叶子默认补齐", async () => {
		const { home, work, cleanup } = await withHome(`
[memory]
dream_enabled = true
inject_enabled = true
`);
		try {
			const service = new ConfigService({ homeDir: home, workDir: work });
			const config: BiConfig = await service.load();
			expect(service.issues).toEqual([]);
			expect(config.memory).toEqual({ dream_enabled: true, inject_enabled: true });
		} finally {
			await cleanup();
		}
	});

	test("未声明 [memory]：load() 无 memory 键（缺省路径逐字节等价）", async () => {
		const { home, work, cleanup } = await withHome(`
[tools]
output_limit_bytes = 0
`);
		try {
			const config = await new ConfigService({ homeDir: home, workDir: work }).load();
			expect(config.tools.output_limit_bytes).toBe(0);
			expect(config.memory).toBeUndefined();
			expect("memory" in config).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("config.toml 的 [memory] 子键全非法：记 issue，[memory] 不物化（fail-closed，开关恒 off）", async () => {
		const { home, work, cleanup } = await withHome(`
[memory]
dream_enabled = "yes"
inject_enabled = "also"
`);
		try {
			const service = new ConfigService({ homeDir: home, workDir: work });
			const config = await service.load();
			expect(config.memory).toBeUndefined();
			expect("memory" in config).toBe(false);
			expect(service.issues.some((i) => i.path.startsWith("memory"))).toBe(true);
		} finally {
			await cleanup();
		}
	});
});
