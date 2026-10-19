/**
 * BI-07.4 · config [subagent] 挂载分区验收。
 *
 * 关注面：
 * - DEFAULT_BI_CONFIG 恒为 17 个根键（[subagent] 走挂载式拓扑，不进默认值形状，
 *   既有"17 键"钉死断言不红）；
 * - 缺省不声明 [subagent] 时加载结果中 subagent 恒 undefined（缺省路径零变化）；
 * - 仅显式声明 [subagent] 才物化，字段取默认值 + 显式覆盖生效；
 * - 未知键丢弃、非法枚举回退默认（不暴破，与全仓 schema 容错语义一致）。
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_BI_CONFIG, createDefaultConfig, validateConfigLayer, type ConfigIssue } from "./schema";

describe("BI-07.4 config [subagent] 挂载分区", () => {
	test("DEFAULT_BI_CONFIG 恒为 17 个根键（[subagent] 挂载式，不进默认值）", () => {
		expect(Object.keys(DEFAULT_BI_CONFIG).sort()).toHaveLength(17);
		expect(DEFAULT_BI_CONFIG).not.toHaveProperty("subagent");
		expect(DEFAULT_BI_CONFIG).not.toHaveProperty("verify");
		const fresh = createDefaultConfig();
		expect(Object.keys(fresh).sort()).toHaveLength(17);
		expect(fresh.subagent).toBeUndefined();
	});

	test("缺省不声明 [subagent]：加载结果中 subagent 恒 undefined（零变化）", () => {
		const empty = validateConfigLayer({}, []);
		expect(empty).toBeUndefined();
		const fromDefault = createDefaultConfig();
		expect(fromDefault.subagent).toBeUndefined();
		expect(fromDefault.verify).toBeUndefined();
	});

	test("声明 [subagent] 才物化，字段取默认 + 显式覆盖生效", () => {
		const layer = validateConfigLayer(
			{ subagent: { enabled: true, btw_enabled: true, default_profile: "coder", max_iterations: 12, timeout_ms: 5000 } },
			[],
		);
		expect(layer).toBeDefined();
		const sub = layer!.subagent!;
		expect(sub.enabled).toBe(true);
		expect(sub.btw_enabled).toBe(true);
		expect(sub.default_profile).toBe("coder");
		expect(sub.max_iterations).toBe(12);
		expect(sub.timeout_ms).toBe(5000);
	});

	test("未知键丢弃、非法枚举记 issue 并丢弃（挂载式偏对象，不回灌默认）", () => {
		const issues: ConfigIssue[] = [];
		const layer = validateConfigLayer(
			{ subagent: { enabled: true, default_profile: "danger", bogus: 1 } },
			issues,
		);
		expect(layer!.subagent!.enabled).toBe(true);
		// 非法枚举：记 issue 并丢弃（与 [verify] 挂载分区同构——校验层不回灌默认值）。
		expect(layer!.subagent).not.toHaveProperty("default_profile");
		// 未知键：丢弃。
		expect(layer!.subagent).not.toHaveProperty("bogus");
		expect(issues.length).toBeGreaterThan(0);
	});

	test("仅声明 enabled=false 仍物化（挂载语义：声明即物化；其余字段缺省为 undefined，装配时取默认）", () => {
		const layer = validateConfigLayer({ subagent: { enabled: false } }, []);
		expect(layer?.subagent?.enabled).toBe(false);
		// 挂载分区校验层不回灌默认（与 [verify] 一致），消费方装配时取 schema 默认值。
		expect(layer?.subagent?.btw_enabled).toBeUndefined();
		expect(layer?.subagent?.max_iterations).toBeUndefined();
		expect(layer?.subagent?.timeout_ms).toBeUndefined();
		expect(layer?.subagent?.default_profile).toBeUndefined();
	});
});
