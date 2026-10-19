/**
 * BI-28.3 · 权限模式产品化验收 —— parsePermissionMode / permissionModeFromConfig /
 * PermissionSessionController（纯内存，零 IO）。
 *
 * 钉死的裁定（与 permission-mode.ts 文件头一一对应）：
 * 1. switchMode 不清空会话授权：会话记忆是用户对本条参数串的显式裁决，语义
 *    强于三态默认——manual 回切后记忆放行照常生效（一次性收回走 revoke/clear）。
 * 2. grant/deny 直接喂 gate 会话记忆：check 命中 remembered 自动裁决，归一化
 *    键与 gate 同源（./ 前缀/反斜杠/尾斜杠）。
 * 3. yolo/auto 只改变 ask 门行为（三态默认）；静态规则照常压过自动放行——
 *    器官层（PathJail/shell-scan）在工具绑定层，与门禁两层互不取代（器官侧
 *    回归见 toolset.test.ts / path-jail.test.ts，此处验收门禁面语义）。
 * 4. 默认 manual（最安全缺省）；config 词面 default/plan → manual（默认不变）。
 */
import { describe, expect, test } from "bun:test";
import { PermissionGate } from "../guard/permission-gate";
import type { PermissionRequest } from "../guard/types";
import {
	PermissionSessionController,
	parsePermissionMode,
	permissionModeFromConfig,
} from "./permission-mode";

const req = (tool: string, argSummary: string): PermissionRequest => ({
	tool,
	argSummary,
	mode: "manual",
});

/** 可拨动测试时钟（grants recordedAt 断言用）。 */
function makeClock() {
	let now = 1_700_000_000_000;
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

// ---------- parsePermissionMode（严格词面） ----------

describe("parsePermissionMode（严格词面，不猜别名不认大写）", () => {
	test("三态词面原样通过", () => {
		expect(parsePermissionMode("manual")).toBe("manual");
		expect(parsePermissionMode("auto")).toBe("auto");
		expect(parsePermissionMode("yolo")).toBe("yolo");
	});

	test("其余一律 undefined：大小写 / 别名 / 空白 / 空串", () => {
		for (const text of ["MANUAL", "Auto", "YOLO", "default", "plan", "readonly", "yolo ", " yolo", ""]) {
			expect(parsePermissionMode(text)).toBeUndefined();
		}
	});
});

// ---------- permissionModeFromConfig（config 词面映射） ----------

describe("permissionModeFromConfig（[permission] mode → 门禁三态）", () => {
	test("yolo 直通；auto/manual 门禁原生词面直通", () => {
		expect(permissionModeFromConfig("yolo")).toBe("yolo");
		expect(permissionModeFromConfig("auto")).toBe("auto");
		expect(permissionModeFromConfig("manual")).toBe("manual");
	});

	test("default/plan → manual（plan 只读规划档写语义最保守）", () => {
		expect(permissionModeFromConfig("default")).toBe("manual");
		expect(permissionModeFromConfig("plan")).toBe("manual");
	});

	test("未配置/未知一律 → manual（默认不变）", () => {
		expect(permissionModeFromConfig(undefined)).toBe("manual");
		expect(permissionModeFromConfig(null)).toBe("manual");
		expect(permissionModeFromConfig("")).toBe("manual");
		expect(permissionModeFromConfig("danger")).toBe("manual");
	});
});

// ---------- PermissionSessionController ----------

describe("PermissionSessionController（模式 + 会话授权产品面）", () => {
	test("缺省构造：manual 门禁（最安全缺省）；mode 选项可指定", () => {
		expect(new PermissionSessionController().mode).toBe("manual");
		expect(new PermissionSessionController({ mode: "yolo" }).mode).toBe("yolo");
		expect(new PermissionSessionController({ mode: "auto" }).mode).toBe("auto");
	});

	test("gate 注入即共享实例：controller 与 gate 互见模式与会话记忆", () => {
		const gate = new PermissionGate({ mode: "manual" });
		const controller = new PermissionSessionController({ gate });
		expect(controller.gate).toBe(gate);
		controller.switchMode("yolo");
		expect(gate.mode).toBe("yolo");
		gate.remember({ tool: "Bash", argSummary: "bun test" }, "allow");
		expect(controller.grants()).toHaveLength(1);
	});

	test("grantAlways 喂 gate 会话记忆：同 tool 同参 check → allow(remembered)", () => {
		const controller = new PermissionSessionController(); // manual：未授权操作本应 ask
		expect(controller.check(req("Bash", "bun test"))).toEqual({ decision: "ask" });
		controller.grantAlways("Bash", "bun test");
		expect(controller.check(req("Bash", "bun test"))).toEqual({ decision: "allow", remembered: true });
		// 不同参数串不命中记忆：manual 下回退 ask
		expect(controller.check(req("Bash", "bun install"))).toEqual({ decision: "ask" });
		// 不同工具不命中记忆
		expect(controller.check(req("Edit", "bun test"))).toEqual({ decision: "ask" });
	});

	test("记忆键与 gate 同源归一化：./ 前缀 / 反斜杠 / 尾斜杠", () => {
		const controller = new PermissionSessionController();
		controller.grantAlways("ReadFile", "./src/a.ts\\");
		expect(controller.check(req("ReadFile", "src/a.ts"))).toEqual({ decision: "allow", remembered: true });
	});

	test("denyAlways：同参 check → deny(remembered) + feedback 原样透传", () => {
		const controller = new PermissionSessionController({ mode: "yolo" }); // 记忆先于三态默认
		controller.denyAlways("Bash", "rm -rf build", "构建目录手工清理");
		const decision = controller.check(req("Bash", "rm -rf build"));
		expect(decision.decision).toBe("deny");
		expect(decision.remembered).toBe(true);
		expect(decision.feedback).toBe("构建目录手工清理");
	});

	test("switchMode 不清空会话授权（裁定：显式裁决语义强于三态默认）", () => {
		const controller = new PermissionSessionController();
		controller.grantAlways("Bash", "bun test");
		controller.switchMode("auto");
		controller.switchMode("yolo");
		controller.switchMode("manual");
		expect(controller.grants()).toHaveLength(1);
		// manual 回切后记忆放行照常生效（不落 ask）
		expect(controller.check(req("Bash", "bun test"))).toEqual({ decision: "allow", remembered: true });
		// 未被记忆覆盖的操作照旧 ask
		expect(controller.check(req("Bash", "curl example.com"))).toEqual({ decision: "ask" });
	});

	test("revokeGrant：命中删除返回 true 且 check 回退 ask；未命中返回 false", () => {
		const controller = new PermissionSessionController();
		controller.grantAlways("Bash", "bun test");
		expect(controller.revokeGrant("Bash", "bun install")).toBe(false); // 归一化键未命中
		expect(controller.revokeGrant("Bash", "./bun test/")).toBe(true); // 同键归一化命中
		expect(controller.grants()).toHaveLength(0);
		expect(controller.check(req("Bash", "bun test"))).toEqual({ decision: "ask" });
	});

	test("clearGrants：清空全部授权快照", () => {
		const controller = new PermissionSessionController({ mode: "yolo" });
		controller.grantAlways("Bash", "a");
		controller.denyAlways("Edit", "b");
		expect(controller.grants()).toHaveLength(2);
		controller.clearGrants();
		expect(controller.grants()).toHaveLength(0);
		expect(controller.check(req("Edit", "b"))).toEqual({ decision: "allow" }); // yolo 默认放行
	});

	test("grants 快照：插入序 + recordedAt 走注入时钟 + decision/feedback 字段", () => {
		const clock = makeClock();
		const controller = new PermissionSessionController({ now: clock.now });
		controller.grantAlways("Bash", "a");
		clock.advance(50);
		controller.denyAlways("Edit", "b", "不行");
		const grants = controller.grants();
		expect(grants.map((g) => [g.tool, g.pattern, g.decision])).toEqual([
			["Bash", "a", "allow"],
			["Edit", "b", "deny"],
		]);
		expect(grants[0]?.recordedAt).toBe(1_700_000_000_000);
		expect(grants[1]?.recordedAt).toBe(1_700_000_000_050);
		expect(grants[1]?.feedback).toBe("不行");
	});

	test("yolo/auto 只改变 ask 门：deny 规则照常压过自动放行（器官/规则两层不因模式失效）", () => {
		const gate = new PermissionGate({
			mode: "manual",
			rules: [{ tool: "Bash", pattern: "rm *", action: "deny", scope: "always" }],
		});
		const controller = new PermissionSessionController({ gate });
		// 注意 picomatch 语义：单星不跨 "/"，参数串取无斜杠形态（与 gate 测试同款）。
		expect(controller.check(req("Bash", "bun test"))).toEqual({ decision: "ask" }); // 未命中规则 → manual ask
		controller.switchMode("yolo");
		const yoloDecision = controller.check(req("Bash", "rm -rf build"));
		expect(yoloDecision.decision).toBe("deny"); // 规则压过 yolo 自动放行
		expect(yoloDecision.matchedRule?.action).toBe("deny");
		controller.switchMode("auto");
		expect(controller.check(req("Bash", "rm -rf build")).decision).toBe("deny");
		// 无规则命中的未知操作：yolo allow（无标记）/ auto allow + reasonedDefault
		controller.switchMode("yolo");
		expect(controller.check(req("Bash", "bun test"))).toEqual({ decision: "allow" });
		controller.switchMode("auto");
		const autoDecision = controller.check(req("Bash", "bun install"));
		expect(autoDecision.decision).toBe("allow");
		expect(autoDecision.reasonedDefault).toBe(true);
	});

	test("check 透传静态规则放行：allow 规则命中带 matchedRule，manual 下不落 ask", () => {
		const gate = new PermissionGate({
			rules: [{ tool: "Bash", pattern: "bun *", action: "allow", scope: "always" }],
		});
		const controller = new PermissionSessionController({ gate });
		const decision = controller.check(req("Bash", "bun test core"));
		expect(decision.decision).toBe("allow");
		expect(decision.matchedRule?.pattern).toBe("bun *");
		expect(decision.remembered).toBeUndefined();
	});
});
