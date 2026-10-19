/**
 * BI-28.3 · /permissions 命令对象验收（纯内存，零 IO）。
 *
 * 覆盖面：
 * 1. parse 全动作语法：show / 三态模式词面 / grant|deny|revoke <tool> <参数串> /
 *    clear；空白容错（trim + 多空白切分）。
 * 2. 结构化错误五分类：unknown-action / invalid-mode（词面保留位，当前词面
 *    即模式的冗余面）/ unexpected-argument / missing-tool / missing-args
 *    （空参数串 fail-closed，不认"全量放行"）。
 * 3. execute 端口回写与展示行：mode 切换行、grant/deny 记忆行、revoke 命中
 *    与未命中两态、clear 计数行、show 的模式行/计数行/逐条清单（+/- 前缀）。
 *
 * 端口用收集型替身（零决策逻辑）；controller → gate 的真实语义链在
 * permission-mode.test.ts 验收。
 */
import { describe, expect, test } from "bun:test";
import {
	permissionsCommand,
	PERMISSIONS_USAGE,
	type PermissionsArgs,
	type PermissionsPorts,
} from "./permissions-command";
import type { SessionApprovalEntry } from "../../guard/permission-gate";
import type { PermissionMode } from "../../guard/types";

// ---------- 端口替身（收集型：记录调用 + 可脚本化返回值） ----------

interface PortStub extends PermissionsPorts {
	readonly calls: string[];
}

function portStub(options: {
	mode?: PermissionMode;
	grants?: readonly SessionApprovalEntry[];
	revokeResult?: boolean;
} = {}): PortStub {
	const calls: string[] = [];
	let grants = [...(options.grants ?? [])];
	return {
		calls,
		mode: () => options.mode ?? "manual",
		setMode: (mode) => calls.push(`setMode:${mode}`),
		grants: () => grants,
		grantAlways: (tool, argSummary) => {
			calls.push(`grantAlways:${tool}:${argSummary}`);
			grants = [...grants, { tool, pattern: argSummary, decision: "allow", recordedAt: 1 }];
		},
		denyAlways: (tool, argSummary) => {
			calls.push(`denyAlways:${tool}:${argSummary}`);
			grants = [...grants, { tool, pattern: argSummary, decision: "deny", recordedAt: 2 }];
		},
		revokeGrant: (tool, argSummary) => {
			calls.push(`revokeGrant:${tool}:${argSummary}`);
			return options.revokeResult ?? true;
		},
		clearGrants: () => {
			calls.push("clearGrants");
			grants = [];
		},
	};
}

const entry = (tool: string, pattern: string, decision: "allow" | "deny"): SessionApprovalEntry => ({
	tool,
	pattern,
	decision,
	recordedAt: 1,
});

// ---------- parse：全动作语法 ----------

describe("/permissions parse（纯语法面）", () => {
	test("空串与 show：缺省展示动作；show 带参 = unexpected-argument", () => {
		expect(permissionsCommand.parse("")).toEqual({ ok: true, args: { action: "show" } });
		expect(permissionsCommand.parse("   ")).toEqual({ ok: true, args: { action: "show" } });
		expect(permissionsCommand.parse("show")).toEqual({ ok: true, args: { action: "show" } });
		const bad = permissionsCommand.parse("show all");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.code).toBe("unexpected-argument");
	});

	test("三态模式词面：manual/auto/yolo → mode 动作；带参 = unexpected-argument", () => {
		for (const mode of ["manual", "auto", "yolo"] as const) {
			const parsed = permissionsCommand.parse(mode);
			expect(parsed).toEqual({ ok: true, args: { action: "mode", mode } });
		}
		const bad = permissionsCommand.parse("yolo now");
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.error.code).toBe("unexpected-argument");
			expect(bad.error.message).toContain("/permissions yolo");
		}
	});

	test("grant/deny/revoke：tool + 参数串（多空白折叠为单空格参数串）", () => {
		const grant = permissionsCommand.parse("grant Bash bun test --fix");
		expect(grant).toEqual({
			ok: true,
			args: { action: "grant", tool: "Bash", argSummary: "bun test --fix" },
		});
		const deny = permissionsCommand.parse("deny Edit src/a.ts 涉密目录");
		expect(deny).toEqual({
			ok: true,
			args: { action: "deny", tool: "Edit", argSummary: "src/a.ts 涉密目录" },
		});
		const revoke = permissionsCommand.parse("  revoke   Bash   bun test  ");
		expect(revoke).toEqual({
			ok: true,
			args: { action: "revoke", tool: "Bash", argSummary: "bun test" },
		});
	});

	test("grant/deny/revoke 缺 tool = missing-tool；tool 后无参数串 = missing-args（fail-closed）", () => {
		for (const action of ["grant", "deny", "revoke"] as const) {
			const noTool = permissionsCommand.parse(action);
			expect(noTool.ok).toBe(false);
			if (!noTool.ok) {
				expect(noTool.error.code).toBe("missing-tool");
				expect(noTool.error.message).toContain(`/permissions ${action}`);
			}
			const noArgs = permissionsCommand.parse(`${action} Bash`);
			expect(noArgs.ok).toBe(false);
			if (!noArgs.ok) {
				expect(noArgs.error.code).toBe("missing-args");
				expect(noArgs.error.message).toContain("参数串不可为空");
			}
		}
	});

	test("clear：成功与 unexpected-argument；未知子命令 = unknown-action（附用法原文）", () => {
		expect(permissionsCommand.parse("clear")).toEqual({ ok: true, args: { action: "clear" } });
		const clearBad = permissionsCommand.parse("clear now");
		expect(clearBad.ok).toBe(false);
		if (!clearBad.ok) expect(clearBad.error.code).toBe("unexpected-argument");
		const unknown = permissionsCommand.parse("grant-all Bash x");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) {
			expect(unknown.error.code).toBe("unknown-action");
			expect(unknown.error.message).toContain("grant-all");
			expect(unknown.error.message).toContain(PERMISSIONS_USAGE);
		}
	});

	test("usage 原文与 name 面齐全（注册表/补全提示同源）", () => {
		expect(permissionsCommand.name).toBe("permissions");
		expect(PERMISSIONS_USAGE).toContain("/permissions");
		expect(PERMISSIONS_USAGE).toContain("grant");
		expect(PERMISSIONS_USAGE).toContain("clear");
	});
});

// ---------- execute：端口回写 + 展示行 ----------

describe("/permissions execute（端口回写与展示行）", () => {
	test("mode：回写 setMode + 迁移行 before → after", () => {
		const ports = portStub({ mode: "manual" });
		const lines = permissionsCommand.execute({ action: "mode", mode: "yolo" }, ports);
		expect(ports.calls).toEqual(["setMode:yolo"]);
		expect(lines).toEqual(["权限模式: manual → yolo"]);
	});

	test("grant / deny：回写记忆端口 + 确认行", () => {
		const ports = portStub();
		expect(permissionsCommand.execute({ action: "grant", tool: "Bash", argSummary: "bun test" }, ports)).toEqual([
			"已记住（本会话）始终允许: Bash bun test",
		]);
		expect(permissionsCommand.execute({ action: "deny", tool: "Edit", argSummary: "secrets/**" }, ports)).toEqual([
			"已记住（本会话）始终拒绝: Edit secrets/**",
		]);
		expect(ports.calls).toEqual(["grantAlways:Bash:bun test", "denyAlways:Edit:secrets/**"]);
	});

	test("revoke：命中/未命中两态分行", () => {
		const hit = portStub({ revokeResult: true });
		expect(permissionsCommand.execute({ action: "revoke", tool: "Bash", argSummary: "bun test" }, hit)).toEqual([
			"已撤销会话授权: Bash bun test",
		]);
		const miss = portStub({ revokeResult: false });
		expect(permissionsCommand.execute({ action: "revoke", tool: "Bash", argSummary: "bun test" }, miss)).toEqual([
			"未找到会话授权: Bash bun test",
		]);
	});

	test("clear：先计数后清空 + 计数行", () => {
		const ports = portStub({ grants: [entry("Bash", "x", "allow"), entry("Edit", "y", "deny")] });
		const lines = permissionsCommand.execute({ action: "clear" }, ports);
		expect(lines).toEqual(["已清空会话授权（2 条）"]);
		expect(ports.calls).toEqual(["clearGrants"]);
	});

	test("show：模式行（语义注记）+ 授权计数行 + 逐条清单（+allow / -deny）", () => {
		const ports = portStub({
			mode: "auto",
			grants: [entry("Bash", "bun test", "allow"), entry("Edit", "secrets/**", "deny")],
		});
		const lines = permissionsCommand.execute({ action: "show" }, ports);
		expect(lines).toEqual([
			"权限模式: auto（manual=逐项询问 auto=自动放行+审计标记 yolo=自动放行）",
			"会话授权: 2 条",
			"  + Bash bun test",
			"  - Edit secrets/**",
		]);
		expect(ports.calls).toEqual([]); // show 零回写
	});

	test("parse → execute 全链：合法词面穷举驱动真实端口替身（判别联合穷尽）", () => {
		// 判别联合穷举性回归：execute 对每个 action 分支都有回写或展示产出。
		const cases: readonly PermissionsArgs[] = [
			{ action: "show" },
			{ action: "mode", mode: "auto" },
			{ action: "grant", tool: "Bash", argSummary: "bun test" },
			{ action: "deny", tool: "Bash", argSummary: "rm -rf /" },
			{ action: "revoke", tool: "Bash", argSummary: "bun test" },
			{ action: "clear" },
		];
		for (const args of cases) {
			const ports = portStub();
			const lines = permissionsCommand.execute(args, ports);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(typeof line).toBe("string");
		}
	});
});
