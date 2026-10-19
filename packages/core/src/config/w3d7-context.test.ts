/**
 * W3-D7（BI-05.3）· [context] 挂载式分区 schema 验收。
 *
 * 仿 W1-D3 的 [verify] 挂载式拓扑：
 * - [context] 为挂载式分区：DEFAULT_BI_CONFIG 恒 17 个根键（既有钉死断言不红），
 *   仅配置层显式声明时物化进合并结果（缺省 config.context === undefined，
 *   缺省路径逐字节等价于现状）；
 * - 子键全部缺省关（false / 0），未声明时不存在 context 键；
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

describe("W3-D7 config: 缺省值与 17 根键拓扑（回归）", () => {
	test("根配置仍为 17 个强类型分区：DEFAULT_BI_CONFIG 不含 context 键（挂载式拓扑）", () => {
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
		expect("context" in DEFAULT_BI_CONFIG).toBe(false);
		expect(createDefaultConfig().context).toBeUndefined();
	});

	test("[context] 子键缺省值：仅声明 time_context 时，其余叶子经 backfill 补齐为缺省关", () => {
		// 挂载分区不进默认值形状；显式声明一个子键 + 合并 + backfill 才能看到完整叶子默认。
		const base = createDefaultConfig();
		deepMergeLayer(base, validate({ context: { time_context: true } }).layer);
		BI_CONFIG_SCHEMA.backfill?.(base);
		expect(base.context).toEqual({
			time_context: true,
			date_change_sensor: false,
			tool_result_prune: false,
			max_history_entries: 0,
			timezone: "Asia/Shanghai",
		});
	});

	test("BI_CONFIG_SCHEMA 默认值与 DEFAULT_BI_CONFIG 一致（含新增挂载分区，不影响根键数）", () => {
		expect(BI_CONFIG_SCHEMA.defaultValue()).toEqual(DEFAULT_BI_CONFIG);
	});
});

describe("W3-D7 config: 单层校验（[context] 挂载分区）", () => {
	test("合法 [context] 层：显式键进层，缺省键不出现（合并期继承/backfill）", () => {
		const { layer, issues } = validate({
			context: { time_context: true, max_history_entries: 12, timezone: "America/New_York" },
		});
		expect(issues).toEqual([]);
		expect(layer).toEqual({
			context: { time_context: true, max_history_entries: 12, timezone: "America/New_York" },
		});
	});

	test("子键类型不符/未知键记诊断并 fail-closed 丢弃（不冒充合法，缺省保持关）", () => {
		const { layer, issues } = validate({
			context: {
				time_context: "yes",
				max_history_entries: "big",
				unknown_key: 1,
			},
		});
		// 非法子键被丢弃；合法子键（date_change_sensor/tool_result_prune/timezone）未声明故不进层。
		expect(layer).toBeUndefined();
		expect(issues.some((i) => i.path === "context.time_context")).toBe(true);
		expect(issues.some((i) => i.path === "context.max_history_entries")).toBe(true);
		expect(issues.some((i) => i.path === "context.unknown_key")).toBe(true);
	});

	test("[context] 空表 / 非 table：等价于未提供（默认路径无 context 键）", () => {
		expect(validate({ context: {} }).layer).toBeUndefined();
		const bad = validate({ context: 42 });
		expect(bad.layer).toBeUndefined();
		expect(bad.issues.some((i) => i.path === "context")).toBe(true);
	});

	test("[context] 与既有分区同层共存：未知根键照常诊断（context 不再误报未知键）", () => {
		const { layer, issues } = validate({
			nope: 1,
			tools: { deny: ["rm"] },
			context: { date_change_sensor: true },
		});
		expect(layer).toEqual({ tools: { deny: ["rm"] }, context: { date_change_sensor: true } });
		expect(issues.some((i) => i.path === "nope")).toBe(true);
		expect(issues.some((i) => i.path === "context")).toBe(false);
	});

	test("合并 + backfill：仅声明 time_context 的 [context] 物化后叶子默认补齐", () => {
		const base = createDefaultConfig();
		deepMergeLayer(base, validate({ context: { time_context: true } }).layer);
		BI_CONFIG_SCHEMA.backfill?.(base);
		expect(base.context).toEqual({
			time_context: true,
			date_change_sensor: false,
			tool_result_prune: false,
			max_history_entries: 0,
			timezone: "Asia/Shanghai",
		});
	});

	test("合并：未声明 [context] 的层合入后 base 仍无 context 键（缺省等价）", () => {
		const base = createDefaultConfig();
		deepMergeLayer(base, validate({ tools: { output_limit_bytes: 1024 } }).layer);
		BI_CONFIG_SCHEMA.backfill?.(base);
		expect("context" in base).toBe(false);
		expect(base.tools.output_limit_bytes).toBe(1024);
	});
});

describe("W3-D7 config: ConfigService 三级 TOML 端到端", () => {
	async function withHome(configToml?: string): Promise<{ home: string; work: string; cleanup: () => Promise<void> }> {
		const home = await mkdtemp(join(tmpdir(), "bi-w3d7-home-"));
		const work = await mkdtemp(join(tmpdir(), "bi-w3d7-work-"));
		await mkdir(join(home, ".bi"), { recursive: true });
		if (configToml !== undefined) await writeFile(join(home, ".bi", "config.toml"), configToml, "utf8");
		const cleanup = async (): Promise<void> => {
			await rm(home, { recursive: true, force: true });
			await rm(work, { recursive: true, force: true });
		};
		return { home, work, cleanup };
	}

	test("config.toml 声明 [context]：load() 物化且叶子默认补齐", async () => {
		const { home, work, cleanup } = await withHome(`
[context]
time_context = true
date_change_sensor = true
max_history_entries = 30
timezone = "UTC"
`);
		try {
			const service = new ConfigService({ homeDir: home, workDir: work });
			const config: BiConfig = await service.load();
			expect(service.issues).toEqual([]);
			expect(config.context).toEqual({
				time_context: true,
				date_change_sensor: true,
				tool_result_prune: false,
				max_history_entries: 30,
				timezone: "UTC",
			});
		} finally {
			await cleanup();
		}
	});

	test("未声明 [context]：load() 无 context 键（缺省路径逐字节等价）", async () => {
		const { home, work, cleanup } = await withHome(`
[tools]
output_limit_bytes = 0
`);
		try {
			const config = await new ConfigService({ homeDir: home, workDir: work }).load();
			expect(config.tools.output_limit_bytes).toBe(0);
			expect(config.context).toBeUndefined();
			expect("context" in config).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("config.toml 的 [context] 子键全非法：记 issue，[context] 不物化（fail-closed，开关恒 off 不误开）", async () => {
		const { home, work, cleanup } = await withHome(`
[context]
time_context = "yes"
max_history_entries = "big"
`);
		try {
			const service = new ConfigService({ homeDir: home, workDir: work });
			const config = await service.load();
			// 全非法子键 → 分区不物化 → 所有开关恒 off（缺省等价）。
			expect(config.context).toBeUndefined();
			expect("context" in config).toBe(false);
			expect(service.issues.some((i) => i.path.startsWith("context"))).toBe(true);
		} finally {
			await cleanup();
		}
	});
});
