/**
 * BI-23.1 走骨架点火端到端验收（RULE-BI-12 首卡）。
 *
 * 验收硬标准：一条确定性会话贯通全部装配环节——
 * kimi 序 main 分发 → JSONL 会话落盘（BI-03）→ 钩子触发（真实子进程，BI-06.4
 * 经 BI-01.1 装载适配器）→ 权限门（BI-06.5）→ agent 工具流水线（BI-07）→
 * 真实 fs 工具执行 → stream-json 线合约（BI-04.2 StreamEvent 原样透传）。
 * 模型端口为脚本化注入（零网络；真实驱动随 BI-23.3）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBi } from "./main";
import { runHeadless, type ModelPort, type ToolBinding } from "./headless";
import { SessionManager } from "../session/manager";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import type { HooksSection } from "../config/schema";

/** 脚本化模型端口：按回合回放事件序列，并捕获收到的消息流供接线断言。 */
function scriptedModel(rounds: StreamEvent[][]): {
	port: ModelPort;
	received: Array<{ messages: readonly AgentMessage[]; tools: readonly string[] }>;
} {
	const received: Array<{ messages: readonly AgentMessage[]; tools: readonly string[] }> = [];
	let cursor = 0;
	const port: ModelPort = {
		async *stream(input) {
			const round = rounds[cursor];
			cursor += 1;
			if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
			received.push({ messages: [...input.messages], tools: input.tools.map((t) => t.name) });
			for (const event of round) yield event;
		},
	};
	return { port, received };
}

function readFileSyncBinding(cwd: string): ToolBinding {
	return {
		definition: {
			name: "read_file",
			description: "读取工作区内文本文件",
			inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
		readOnly: true,
		argSummary: (args) => String((args as { path?: string }).path ?? ""),
		execute: async (args) => {
			const path = (args as { path?: string }).path;
			if (typeof path !== "string" || path === "") throw new Error("path required");
			const abs = resolve(cwd, path);
			if (!abs.startsWith(resolve(cwd))) throw new Error("path-escape");
			return await Bun.file(abs).text();
		},
	};
}

const TOOL_ROUND: StreamEvent[] = [
	{ type: "content_delta", delta: "我来读取文件。" },
	{ type: "tool_call_delta", index: 0, id: "call_1", name: "read_file", argumentsDelta: '{"path":"note.txt"}' },
	{ type: "usage", usage: { inputTokens: 12, outputTokens: 8 } },
	{ type: "done", stopReason: "tool_use" },
];

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-skel-"));
	await writeFile(join(root, "note.txt"), "勾稽差额为零", "utf8");
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const ALLOW_HOOK = 'echo \'{"action":"allow"}\'';

describe("BI-23.1 走骨架点火（端到端）", () => {
	test("全链路点亮：真实工具执行 + 钩子触发 + 权限门 + JSONL 落盘 + stream-json 线", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([
				TOOL_ROUND,
				[
					{ type: "content_delta", delta: "文件内容是：勾稽差额为零。" },
					{ type: "usage", usage: { inputTokens: 30, outputTokens: 9 } },
					{ type: "done", stopReason: "stop" },
				],
			]);
			const lines: string[] = [];
			const result = await runHeadless({
				prompt: "读取 note.txt 并总结",
				cwd: root,
				model: port,
				tools: [readFileSyncBinding(root)],
				hooks: {
					enabled: true,
					entries: [
						{ event: "session_start", command: ALLOW_HOOK, timeout_ms: 5_000, matcher: "", blocking: true },
						{ event: "pre_tool_use", command: ALLOW_HOOK, timeout_ms: 5_000, matcher: "", blocking: true },
					],
				},
				sessionsRoot: join(root, "sessions"),
				out: (line) => lines.push(line),
			} as Parameters<typeof runHeadless>[0]);

			expect(result.exitCode).toBe(0);
			expect(result.rounds).toBe(2);
			expect(result.finalText).toContain("勾稽差额为零");
			expect(result.toolResults).toHaveLength(1);
			expect(result.toolResults[0]!.ok).toBe(true);
			// 真实 fs 执行：工具读回文件真实内容
			expect(safeValue(result.toolResults[0]!)).toContain("勾稽差额为零");
			// 权限门：auto 模式放行 + 审计轨迹
			expect(result.permissionDecisions).toEqual([{ tool: "read_file", decision: "allow" }]);
			// 钩子：真实子进程执行，SessionStart 与 PreToolUse 均 ran 且决策 allow
			const ranEvents = result.hookRecords.filter((r) => r.status === "ran").map((r) => r.event);
			expect(ranEvents).toContain("SessionStart");
			expect(ranEvents).toContain("PreToolUse");
			expect(result.hookRecords.filter((r) => r.event === "PreToolUse" && r.status === "ran").every((r) => r.decision === "allow")).toBe(true);

			// JSONL 会话：user → assistant(tool_use) → tool_call → tool_result → assistant(最终)
			const manager = new SessionManager({ rootDir: join(root, "sessions") });
			const entries = await manager.entries(result.sessionId);
			expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "tool_call", "tool_result", "assistant"]);
			const toolResultEntry = entries.find((e) => e.type === "tool_result");
			expect(JSON.stringify(toolResultEntry?.payload)).toContain("勾稽差额为零");
			expect(toolResultEntry?.toolName).toBe("read_file");

			// 模型侧接线：第二回合收到 tool_result 回填（含真实工具输出）
			expect(received).toHaveLength(2);
			const secondRoundMessages = received[1]!.messages;
			const lastMessage = secondRoundMessages.at(-1);
			expect(lastMessage?.role).toBe("user");
			expect(JSON.stringify(lastMessage?.content)).toContain("勾稽差额为零");
			// 工具定义面喂给模型
			expect(received[0]!.tools).toEqual(["read_file"]);

			// stream-json 线合约：首行 content_delta，末行 session_done 汇总
			const parsed = lines.map((line) => JSON.parse(line) as { type: string });
			expect(parsed[0]!.type).toBe("content_delta");
			expect(parsed.some((e) => e.type === "tool_call_delta")).toBe(true);
			const done = parsed.at(-1)!;
			expect(done.type).toBe("session_done");
			expect((done as { type: string; exit?: string }).exit).toBe("ok");
		} finally {
			await cleanup();
		}
	});

	test("PreToolUse 钩子阻断：fail-closed 回喂模型，工具不执行", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
				TOOL_ROUND,
				[
					{ type: "content_delta", delta: "钩子拒绝读取，我停止。" },
					{ type: "done", stopReason: "stop" },
				],
			]);
			const result = await runHeadless({
				prompt: "读取 note.txt",
				cwd: root,
				model: port,
				tools: [readFileSyncBinding(root)],
				hooks: {
					enabled: true,
					entries: [{ event: "pre_tool_use", command: 'echo \'{"action":"block","reason":"policy"}\'', timeout_ms: 5_000, matcher: "", blocking: true }],
				},
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as Parameters<typeof runHeadless>[0]);

			expect(result.exitCode).toBe(0);
			expect(result.toolResults[0]!.ok).toBe(false);
			expect(result.toolResults[0]!.error).toContain("hook-blocked");
			expect(result.toolResults[0]!.error).toContain("policy");
			const preRecords = result.hookRecords.filter((r) => r.event === "PreToolUse");
			expect(preRecords.some((r) => r.status === "ran" && r.decision === "block")).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("manual 模式 ask 降级：无头无审批 UI，结构化拒绝回喂（不假冒放行）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
				TOOL_ROUND,
				[
					{ type: "content_delta", delta: "权限未授，停止。" },
					{ type: "done", stopReason: "stop" },
				],
			]);
			const result = await runHeadless({
				prompt: "读取 note.txt",
				cwd: root,
				model: port,
				tools: [readFileSyncBinding(root)],
				permissionMode: "manual",
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as Parameters<typeof runHeadless>[0]);

			expect(result.permissionDecisions).toEqual([{ tool: "read_file", decision: "ask" }]);
			expect(result.toolResults[0]!.ok).toBe(false);
			expect(result.toolResults[0]!.error).toContain("permission-ask-unavailable-in-headless");
		} finally {
			await cleanup();
		}
	});
});

function safeValue(result: { value?: unknown }): string {
	return typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? "");
}

describe("BI-23.1 main 分发（kimi 序 main → dispatch）", () => {
	test("runBi：--version / 无参 usage / 未知子命令 / 已识别未接线子命令 / 全链路 --prompt", async () => {
		const outs: string[] = [];
		const errs: string[] = [];
		const io = { out: (line: string) => outs.push(line), err: (line: string) => errs.push(line) };

		expect(await runBi(["--version"], io)).toBe(0);
		expect(outs.at(-1)).toMatch(/^bi \d/);

		expect(await runBi([], io)).toBe(2);
		expect(errs.join("\n")).toContain("用法");

		expect(await runBi(["frobnicate"], io)).toBe(2);
		expect(errs.join("\n")).toContain("未知子命令");

		expect(await runBi(["session"], io)).toBe(4);
		expect(errs.at(-1)).toContain("装配未接线");

		// 无模型端口：结构化降级（真实驱动随 BI-23.3）
		expect(await runBi(["--prompt", "hi"], io)).toBe(3);
		expect(errs.at(-1)).toContain("模型端口");
	});

	test("runBi 端到端：经主分发跑通注入式模型无头会话", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([[{ type: "content_delta", delta: "骨架在线。" }, { type: "done", stopReason: "stop" }]]);
			const outs: string[] = [];
			const code = await runBi(["--prompt", "你好", "--output-format", "stream-json"], {
				model: port,
				out: (line) => outs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [readFileSyncBinding(root)] },
			});
			expect(code).toBe(0);
			const done = JSON.parse(outs.at(-1)!) as { type: string; exit?: string };
			expect(done.type).toBe("session_done");
			expect(done.exit).toBe("ok");
		} finally {
			await cleanup();
		}
	});
});
