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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBi } from "./main";
import { runHeadless, type ModelPort, type ToolBinding } from "./headless";
import { SessionManager } from "../session/manager";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type HooksSection } from "../config/schema";

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

		// BI-24.1 起 session 已接线：改为断言注入式离线列表路径（空会话目录 → 零条输出）
		const sessRoot = await mkdtemp(join(tmpdir(), "bi-sess-"));
		try {
			const sessOuts: string[] = [];
			const sessErrs: string[] = [];
			const code = await runBi(["session"], {
				out: (line) => sessOuts.push(line),
				err: (line) => sessErrs.push(line),
				deps: { sessionsRoot: sessRoot },
			});
			expect(code).toBe(0);
			expect(sessOuts).toHaveLength(0);
			expect(sessErrs.join("\n")).toContain("共 0 个会话");
		} finally {
			await rm(sessRoot, { recursive: true, force: true });
		}

		// 无模型端口且无配置：走 BI-23.3 配置装配，结构化退出码 3
		const emptyHome = await mkdtemp(join(tmpdir(), "bi-home-"));
		try {
			expect(await runBi(["--prompt", "hi"], { ...io, headless: { homeDir: emptyHome } })).toBe(3);
			expect(errs.at(-1)).toContain("未配置对话模型");
		} finally {
			await rm(emptyHome, { recursive: true, force: true });
		}
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

// ---------------------------------------------------------------------------
// BI-23.3 main 配置装配（BI-02 凭据门离线失败面，全程不触网）
// ---------------------------------------------------------------------------

function writeGateConfig(apiKeyEnv: string, kind: string): string {
	return `
[providers.entries.gate]
api_key_env = "${apiKeyEnv}"
base_url = "https://gate.test/v1"
kind = "${kind}"
models = ["gate-model"]

[models]
default = "main"

[models.entries.main]
provider = "gate"
model = "gate-model"
`;
}

describe("BI-23.3 main 配置装配与凭据门", () => {
	test("凭据未设置：退出码 3，报错携带 api_key_env 变量名与修复指引", async () => {
		const home = await mkdtemp(join(tmpdir(), "bi-gate-"));
		const envName = "BI_GATE_MISSING_KEY";
		delete process.env[envName];
		await mkdir(join(home, ".bi"), { recursive: true });
		await writeFile(join(home, ".bi", "config.toml"), writeGateConfig(envName, "openai"), "utf8");
		const errs: string[] = [];
		try {
			const code = await runBi(["--prompt", "hi"], {
				out: () => {},
				err: (line) => errs.push(line),
				headless: { homeDir: home },
			});
			expect(code).toBe(3);
			expect(errs.join("\n")).toContain(`${envName} 未设置`);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("kind 无驱动（google）：凭据门通过后仍结构化退出码 3，不触网", async () => {
		const home = await mkdtemp(join(tmpdir(), "bi-gate-"));
		const envName = "BI_GATE_KEY_GOOGLE";
		process.env[envName] = "k";
		await mkdir(join(home, ".bi"), { recursive: true });
		await writeFile(join(home, ".bi", "config.toml"), writeGateConfig(envName, "google"), "utf8");
		const errs: string[] = [];
		try {
			const code = await runBi(["--prompt", "hi"], {
				out: () => {},
				err: (line) => errs.push(line),
				headless: { homeDir: home },
			});
			expect(code).toBe(3);
			expect(errs.join("\n")).toContain("暂无已装配驱动");
		} finally {
			delete process.env[envName];
			await rm(home, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// BI-30.3 --output-format 真消费：stream-json（缺省）/ text 两种输出形态
// ---------------------------------------------------------------------------

describe("BI-30.3 headless outputFormat 输出面", () => {
	test("text 形态：out 恰为最终 finalText 一段，事件与 session_done meta 不落 out", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
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
				sessionsRoot: join(root, "sessions"),
				outputFormat: "text",
				out: (line) => lines.push(line),
			} as Parameters<typeof runHeadless>[0]);

			expect(result.exitCode).toBe(0);
			// 内部流转不收敛：工具真执行、回合照常推进（只收敛输出面）
			expect(result.rounds).toBe(2);
			expect(result.toolResults).toHaveLength(1);
			expect(result.toolResults[0]!.ok).toBe(true);
			// 输出面：恰为一段 finalText（无 content_delta/usage/done/session_done）
			expect(lines).toEqual([result.finalText]);
			expect(result.finalText).toContain("勾稽差额为零");
		} finally {
			await cleanup();
		}
	});

	test("stream-json 缺省与显式同形：逐行透传事件，末行 session_done 汇总", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			for (const explicit of [false, true] as const) {
				const { port } = scriptedModel([
					[
						{ type: "content_delta", delta: "骨架在线。" },
						{ type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
						{ type: "done", stopReason: "stop" },
					],
				]);
				const lines: string[] = [];
				const result = await runHeadless({
					prompt: "你好",
					cwd: root,
					model: port,
					tools: [],
					sessionsRoot: join(root, "sessions"),
					...(explicit ? { outputFormat: "stream-json" as const } : {}),
					out: (line) => lines.push(line),
				} as Parameters<typeof runHeadless>[0]);

				expect(result.exitCode).toBe(0);
				const parsed = lines.map((line) => JSON.parse(line) as { type: string });
				// 三事件 + 末行 session_done 汇总
				expect(parsed).toHaveLength(4);
				expect(parsed[0]!.type).toBe("content_delta");
				expect(parsed[1]!.type).toBe("usage");
				expect(parsed.at(-1)!.type).toBe("session_done");
			}
		} finally {
			await cleanup();
		}
	});
});

describe("BI-30.3 main 接线：CLI --output-format → runHeadless", () => {
	test("--output-format text：out 仅 finalText 一段，诊断仍走 err", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
				[{ type: "content_delta", delta: "骨架在线。" }, { type: "done", stopReason: "stop" }],
			]);
			const outs: string[] = [];
			const errs: string[] = [];
			const code = await runBi(["--prompt", "你好", "--output-format", "text"], {
				model: port,
				out: (line) => outs.push(line),
				err: (line) => errs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
			expect(outs).toEqual(["骨架在线。"]);
			expect(errs.join("\n")).not.toContain("骨架在线。");
		} finally {
			await cleanup();
		}
	});

	test("text 形态下模型错误：out 空，错误经 err 报出（退出码 1）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
				[{ type: "error", error: { code: "server", message: "上游 500" } }],
			]);
			const outs: string[] = [];
			const errs: string[] = [];
			const code = await runBi(["--prompt", "你好", "--output-format", "text"], {
				model: port,
				out: (line) => outs.push(line),
				err: (line) => errs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(1);
			expect(outs).toEqual([]);
			expect(errs.join("\n")).toContain("会话失败");
			expect(errs.join("\n")).toContain("server");
		} finally {
			await cleanup();
		}
	});

	test("不传 --output-format：缺省 stream-json，runBi 输出面契约不变", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
				[{ type: "content_delta", delta: "骨架在线。" }, { type: "done", stopReason: "stop" }],
			]);
			const outs: string[] = [];
			const code = await runBi(["--prompt", "你好"], {
				model: port,
				out: (line) => outs.push(line),
				err: () => {},
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
			const parsed = outs.map((line) => JSON.parse(line) as { type: string });
			expect(parsed[0]!.type).toBe("content_delta");
			expect(parsed.at(-1)!.type).toBe("session_done");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// F-ST-02 --output-format 第三形态：json（全程不落事件流，结束只落一个 JSON 对象）
// ---------------------------------------------------------------------------

describe("F-ST-02 headless outputFormat：json 形态", () => {
	test("json 形态：全程不落事件流，结束只落一个 JSON 对象（含 reply）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
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
				sessionsRoot: join(root, "sessions"),
				outputFormat: "json",
				out: (line) => lines.push(line),
			} as Parameters<typeof runHeadless>[0]);

			expect(result.exitCode).toBe(0);
			// 输出面：恰一行（事件流与 session_done meta 全程不落 out）
			expect(lines).toHaveLength(1);
			const payload = JSON.parse(lines[0]!) as {
				sessionId: string;
				title: string;
				rounds: number;
				usage: { inputTokens: number; outputTokens: number };
				reply: string;
				exit: string;
			};
			expect(payload.sessionId).toBe(result.sessionId);
			expect(payload.title).toBe("读取 note.txt 并总结");
			expect(payload.rounds).toBe(2);
			expect(payload.reply).toBe(result.finalText);
			expect(payload.reply).toContain("勾稽差额为零");
			expect(payload.exit).toBe("ok");
			// 用量汇总：逐轮取本轮最大值后累加（12+30 / 8+9）
			expect(payload.usage.inputTokens).toBe(42);
			expect(payload.usage.outputTokens).toBe(17);
			// 事件流未落 out：单行里既无事件类型也无 session_done
			expect(lines[0]).not.toContain("content_delta");
			expect(lines[0]).not.toContain("session_done");
		} finally {
			await cleanup();
		}
	});

	test("main 接线：--output-format json → stdout 单个 JSON 对象，可 parse 且含 reply", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
				[
					{ type: "content_delta", delta: "骨架在线。" },
					{ type: "usage", usage: { inputTokens: 7, outputTokens: 3 } },
					{ type: "done", stopReason: "stop" },
				],
			]);
			const outs: string[] = [];
			const errs: string[] = [];
			const code = await runBi(["--prompt", "你好", "--output-format", "json"], {
				model: port,
				out: (line) => outs.push(line),
				err: (line) => errs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
			expect(outs).toHaveLength(1);
			const payload = JSON.parse(outs[0]!) as {
				sessionId: string;
				title: string;
				rounds: number;
				usage: { inputTokens: number; outputTokens: number };
				reply: string;
				exit: string;
			};
			expect(payload.reply).toBe("骨架在线。");
			expect(payload.title).toBe("你好");
			expect(payload.rounds).toBe(1);
			expect(payload.exit).toBe("ok");
			expect(payload.usage.inputTokens).toBe(7);
			expect(payload.usage.outputTokens).toBe(3);
			expect(payload.sessionId.length).toBeGreaterThan(0);
			expect(errs.join("\n")).not.toContain("骨架在线。");
		} finally {
			await cleanup();
		}
	});

	test("json 形态失败路径：stdout 不出残缺 JSON，错误经 err 报出（退出码 1）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([
				[{ type: "error", error: { code: "server", message: "上游 500" } }],
			]);
			const outs: string[] = [];
			const errs: string[] = [];
			const code = await runBi(["--prompt", "你好", "--output-format", "json"], {
				model: port,
				out: (line) => outs.push(line),
				err: (line) => errs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(1);
			expect(outs).toEqual([]); // stdout 无残缺 JSON
			expect(errs.join("\n")).toContain("会话失败");
			expect(errs.join("\n")).toContain("server");
		} finally {
			await cleanup();
		}
	});

	test("json 形态续会话（--resume）：title 取既有会话标题", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const sessionsRoot = join(root, "sessions");
			const manager = new SessionManager({ rootDir: sessionsRoot });
			const existing = await manager.createSession({ title: "既有会话", cwd: root });
			const { port } = scriptedModel([
				[{ type: "content_delta", delta: "接着说。" }, { type: "done", stopReason: "stop" }],
			]);
			const lines: string[] = [];
			const result = await runHeadless({
				prompt: "继续",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot,
				sessionId: existing.sessionId,
				outputFormat: "json",
				out: (line) => lines.push(line),
			} as Parameters<typeof runHeadless>[0]);

			expect(result.exitCode).toBe(0);
			expect(lines).toHaveLength(1);
			const payload = JSON.parse(lines[0]!) as { sessionId: string; title: string; reply: string };
			expect(payload.sessionId).toBe(existing.sessionId);
			expect(payload.title).toBe("既有会话");
			expect(payload.reply).toBe("接着说。");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// F-EV-01 —— 回合上限可配（CLI > deps > config > 缺省 8）+ rounds-exceeded 结构化失败面
// ---------------------------------------------------------------------------

/** 回合打尽脚本：每回合只回 tool_use（无工具调用）→ 回合计数持续推进至上限。 */
function loopingModel(): ModelPort {
	return {
		async *stream() {
			yield { type: "done", stopReason: "tool_use" } as StreamEvent;
		},
	};
}

/** 跑一次必然"回合打尽"的无头会话，返回退出码 / stdout / stderr。 */
async function runUntilRoundsExceeded(opts: {
	argv?: readonly string[];
	sessionMaxRounds?: number;
	depsMaxRounds?: number;
	outputFormat?: "stream-json" | "json";
}): Promise<{ code: number; outs: string[]; errs: string[] }> {
	const { root, cleanup } = await makeWorkspace();
	try {
		const outs: string[] = [];
		const errs: string[] = [];
		const config =
			opts.sessionMaxRounds === undefined
				? undefined
				: { ...createDefaultConfig(), session: { max_rounds: opts.sessionMaxRounds } };
		const argv = [
			...(opts.argv ?? ["--prompt", "调研任务"]),
			...(opts.outputFormat !== undefined ? ["--output-format", opts.outputFormat] : []),
		];
		const code = await runBi(argv, {
			model: loopingModel(),
			...(config !== undefined ? { config } : {}),
			out: (line) => outs.push(line),
			err: (line) => errs.push(line),
			headless: {
				cwd: root,
				sessionsRoot: join(root, "sessions"),
				tools: [],
				...(opts.depsMaxRounds !== undefined ? { maxRounds: opts.depsMaxRounds } : {}),
			},
		});
		return { code, outs, errs };
	} finally {
		await cleanup();
	}
}

describe("F-EV-01 headless 回合上限可配 + rounds-exceeded 结构化失败面", () => {
	test("stream-json：回合打尽落 session_done 帧（exit=\"rounds-exceeded\"），退出码非零", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const lines: string[] = [];
			const promise = runHeadless({
				prompt: "调研任务",
				cwd: root,
				model: loopingModel(),
				tools: [],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 2,
				out: (line) => lines.push(line),
			} as Parameters<typeof runHeadless>[0]);
			await expect(promise).rejects.toThrow(/模型回合超过上限 2/);
			const parsed = lines.map((line) => JSON.parse(line) as { type: string; exit?: string; rounds?: number });
			const done = parsed.at(-1)!;
			expect(done.type).toBe("session_done");
			expect(done.exit).toBe("rounds-exceeded");
			expect(done.rounds).toBe(2);
		} finally {
			await cleanup();
		}
	});

	test("json：回合打尽 stdout 落完整 JSON 对象（exit/reply/rounds），进程退出码非零", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const lines: string[] = [];
			const promise = runHeadless({
				prompt: "调研任务",
				cwd: root,
				model: loopingModel(),
				tools: [],
				sessionsRoot: join(root, "sessions"),
				maxRounds: 2,
				outputFormat: "json",
				out: (line) => lines.push(line),
			} as Parameters<typeof runHeadless>[0]);
			await expect(promise).rejects.toThrow(/模型回合超过上限 2/);
			// stdout 恰一个完整对象（可 parse，无残缺 JSON）
			expect(lines).toHaveLength(1);
			const payload = JSON.parse(lines[0]!) as {
				sessionId: string;
				title: string;
				rounds: number;
				usage: { inputTokens: number; outputTokens: number };
				reply: string;
				exit: string;
			};
			expect(payload.exit).toBe("rounds-exceeded");
			expect(payload.reply).toBe("");
			expect(payload.rounds).toBe(2);
			expect(payload.sessionId.length).toBeGreaterThan(0);
			expect(payload.usage.inputTokens).toBe(0);
			expect(payload.usage.outputTokens).toBe(0);
		} finally {
			await cleanup();
		}
	});

	test("main 接线：json 形态回合打尽 → stdout 完整对象 + 退出码 1 + 诊断经 err", async () => {
		const { code, outs, errs } = await runUntilRoundsExceeded({
			argv: ["--prompt", "调研任务", "--max-rounds", "1"],
			outputFormat: "json",
		});
		expect(code).toBe(1);
		expect(outs).toHaveLength(1);
		const payload = JSON.parse(outs[0]!) as { exit: string; reply: string; rounds: number };
		expect(payload.exit).toBe("rounds-exceeded");
		expect(payload.reply).toBe("");
		expect(payload.rounds).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 1");
		expect(errs.join("\n")).toContain("可用 --max-rounds 或 config [session] max_rounds 调高");
	});

	test("优先级：CLI --max-rounds > config [session] max_rounds", async () => {
		const { code, errs } = await runUntilRoundsExceeded({
			argv: ["--prompt", "调研任务", "--max-rounds", "1"],
			sessionMaxRounds: 5,
		});
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 1");
		expect(errs.join("\n")).not.toContain("模型回合超过上限 5");
	});

	test("优先级：deps 透传 maxRounds > config [session] max_rounds", async () => {
		const { code, errs } = await runUntilRoundsExceeded({
			sessionMaxRounds: 5,
			depsMaxRounds: 3,
		});
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 3");
		expect(errs.join("\n")).not.toContain("模型回合超过上限 5");
	});

	test("优先级：仅 config [session] max_rounds 声明 → 生效", async () => {
		const { code, errs } = await runUntilRoundsExceeded({ sessionMaxRounds: 2 });
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 2");
	});

	test("优先级：config max_rounds = 0 / 负数 → 按 0 处理，回内建缺省 8", async () => {
		for (const value of [0, -3]) {
			const { code, errs } = await runUntilRoundsExceeded({ sessionMaxRounds: value });
			expect(code).toBe(1);
			expect(errs.join("\n")).toContain("模型回合超过上限 8");
		}
	});

	test("优先级：三者皆缺省 → 内建缺省 8（缺省语义不变）", async () => {
		const { code, errs } = await runUntilRoundsExceeded({});
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 8");
	});
});
