/**
 * 虚账接线 A —— [loop_control] 四键 + [identity] 两键的装配与行为验收。
 *
 * 覆盖矩阵（每键 ≥ 生效 / 缺省关 / 装配透传）：
 * - [loop_control] max_tool_calls_per_turn：单回合工具调用上限（超限调用不执行，
 *   回填结构化拒绝；缺省不限）。
 * - [loop_control] step_timeout_ms：工具限时看门狗缺省时限（>0 自建缺省看门狗；
 *   0 = 关闭看门狗）。
 * - [loop_control] turn_timeout_ms：单回合总时限（超时 → 在飞工具协作取消 +
 *   结构化失败面 exit="turn-timeout" + 非零退出；0 = 不限）。
 * - [loop_control] max_iterations：会话回合上限通用层（四层优先级链第四层；
 *   0 = 不生效，回退内建缺省）。
 * - [identity] system_prompt_path：系统指令前缀（CLI --agent-file 优先；文件缺失 →
 *   结构化 warn + 回退内置，不炸会话）。
 * - [identity] extra_instructions：追加为系统面末条。
 *
 * 全部离线：脚本化/挂死模型端口 + 临时目录；零网络、零真实 ~/.bi 触碰。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import { runHeadless, type ModelPort, type ToolBinding } from "./headless";
import { createDefaultConfig } from "../config/schema";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";

/** 脚本化模型：按回合回放事件序列，并捕获每回合收到的消息流。 */
function scriptedModel(rounds: StreamEvent[][]): {
	port: ModelPort;
	received: Array<{ messages: readonly AgentMessage[] }>;
} {
	const received: Array<{ messages: readonly AgentMessage[] }> = [];
	let cursor = 0;
	const port: ModelPort = {
		async *stream(input) {
			const round = rounds[cursor];
			cursor += 1;
			if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
			received.push({ messages: [...input.messages] });
			for (const event of round) yield event;
		},
	};
	return { port, received };
}

/** 挂死模型（伪端点永挂）：用于单回合时限触发。 */
function hangingModel(): ModelPort {
	return {
		async *stream() {
			await new Promise<void>(() => undefined);
		},
	};
}

/** 回合打尽脚本：每回合只回 tool_use（无工具调用）→ 回合计数推进至上限。 */
function loopingModel(): ModelPort {
	return {
		async *stream() {
			yield { type: "done", stopReason: "tool_use" } as StreamEvent;
		},
	};
}

/** 回显工具绑定（记录实际执行过的入参，用于断言"超限调用不执行"）。 */
function echoBinding(executed: string[]): ToolBinding {
	return {
		definition: {
			name: "echo",
			description: "回显",
			inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
		readOnly: true,
		execute: async (args) => {
			const text = String((args as { text?: string }).text ?? "");
			executed.push(text);
			return `echo:${text}`;
		},
	};
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-loopctl-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 三连工具调用脚本（单回合三个调用）。 */
const THREE_CALLS: StreamEvent[] = [
	{ type: "tool_call_delta", index: 0, id: "c1", name: "echo", argumentsDelta: '{"text":"一"}' },
	{ type: "tool_call_delta", index: 1, id: "c2", name: "echo", argumentsDelta: '{"text":"二"}' },
	{ type: "tool_call_delta", index: 2, id: "c3", name: "echo", argumentsDelta: '{"text":"三"}' },
	{ type: "done", stopReason: "tool_use" },
];

// ---------------------------------------------------------------------------
// [loop_control] max_tool_calls_per_turn
// ---------------------------------------------------------------------------

describe("[loop_control] max_tool_calls_per_turn（单回合工具调用上限）", () => {
	test("生效：超限调用不执行，回填结构化拒绝（loop-control: 单轮工具调用超过上限 N）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const executed: string[] = [];
			const { port, received } = scriptedModel([
				THREE_CALLS,
				[{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }],
			]);
			const result = await runHeadless({
				prompt: "跑三个工具",
				cwd: root,
				model: port,
				tools: [echoBinding(executed)],
				sessionsRoot: join(root, "sessions"),
				maxToolCallsPerTurn: 2,
				out: () => undefined,
			});
			expect(result.exitCode).toBe(0);
			// 前两个执行、第三个被拒（不执行）
			expect(executed).toEqual(["一", "二"]);
			const rejected = result.toolResults[2]!;
			expect(rejected.ok).toBe(false);
			expect(rejected.error).toContain("loop-control: 单轮工具调用超过上限 2");
			expect(rejected.error).toContain("[loop_control] max_tool_calls_per_turn");
			// 拒绝结果回喂模型（可自愈重试；回合不炸）
			expect(JSON.stringify(received[1]!.messages.at(-1)?.content)).toContain("loop-control");
		} finally {
			await cleanup();
		}
	});

	test("缺省关：不传上限 → 三个调用全部执行（零行为差）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const executed: string[] = [];
			const { port } = scriptedModel([
				THREE_CALLS,
				[{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }],
			]);
			const result = await runHeadless({
				prompt: "跑三个工具",
				cwd: root,
				model: port,
				tools: [echoBinding(executed)],
				sessionsRoot: join(root, "sessions"),
				out: () => undefined,
			});
			expect(result.exitCode).toBe(0);
			expect(executed).toEqual(["一", "二", "三"]);
			expect(result.toolResults.every((r) => r.ok)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("装配透传：config [loop_control] max_tool_calls_per_turn → headless 生效", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const executed: string[] = [];
			const { port, received } = scriptedModel([
				THREE_CALLS,
				[{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }],
			]);
			const config = createDefaultConfig();
			config.loop_control.max_tool_calls_per_turn = 1;
			const code = await runBi(["--prompt", "跑三个工具"], {
				model: port,
				config,
				out: () => undefined,
				err: () => undefined,
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [echoBinding(executed)] },
			});
			expect(code).toBe(0);
			expect(executed).toEqual(["一"]);
			// 超限调用回喂模型（结构化拒绝文本可被模型读到）
			expect(JSON.stringify(received[1]!.messages.at(-1)?.content)).toContain("单轮工具调用超过上限 1");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// [loop_control] step_timeout_ms
// ---------------------------------------------------------------------------

describe("[loop_control] step_timeout_ms（工具限时看门狗缺省时限）", () => {
	test("生效：>0 → 自建缺省看门狗，挂死工具到点结构化超时（不炸回合）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const hangTool: ToolBinding = {
				definition: {
					name: "hang",
					description: "挂死工具",
					inputSchema: { type: "object", properties: {}, required: [] },
				},
				readOnly: true,
				execute: async () => await new Promise<never>(() => undefined),
			};
			const { port } = scriptedModel([
				[
					{ type: "tool_call_delta", index: 0, id: "h1", name: "hang", argumentsDelta: "{}" },
					{ type: "done", stopReason: "tool_use" },
				],
				[{ type: "content_delta", delta: "看门狗到点后我继续。" }, { type: "done", stopReason: "stop" }],
			]);
			const result = await runHeadless({
				prompt: "跑挂死工具",
				cwd: root,
				model: port,
				tools: [hangTool],
				sessionsRoot: join(root, "sessions"),
				stepTimeoutMs: 30,
				out: () => undefined,
			});
			expect(result.exitCode).toBe(0);
			const timedOut = result.toolResults[0]!;
			expect(timedOut.ok).toBe(false);
			expect(timedOut.error).toContain("exceeded deadline");
		} finally {
			await cleanup();
		}
	});

	test("缺省关：0 → 不装配看门狗，慢工具正常完成", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const slowTool: ToolBinding = {
				definition: {
					name: "slow",
					description: "慢工具",
					inputSchema: { type: "object", properties: {}, required: [] },
				},
				readOnly: true,
				execute: async () => {
					await new Promise((r) => setTimeout(r, 30));
					return "slow-ok";
				},
			};
			const { port } = scriptedModel([
				[
					{ type: "tool_call_delta", index: 0, id: "s1", name: "slow", argumentsDelta: "{}" },
					{ type: "done", stopReason: "tool_use" },
				],
				[{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }],
			]);
			const result = await runHeadless({
				prompt: "跑慢工具",
				cwd: root,
				model: port,
				tools: [slowTool],
				sessionsRoot: join(root, "sessions"),
				stepTimeoutMs: 0,
				out: () => undefined,
			});
			expect(result.exitCode).toBe(0);
			expect(result.toolResults[0]).toMatchObject({ ok: true, value: "slow-ok" });
		} finally {
			await cleanup();
		}
	});

	test("装配透传：config [loop_control] step_timeout_ms → headless 自建看门狗", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const hangTool: ToolBinding = {
				definition: {
					name: "hang",
					description: "挂死工具",
					inputSchema: { type: "object", properties: {}, required: [] },
				},
				readOnly: true,
				execute: async () => await new Promise<never>(() => undefined),
			};
			const { port, received } = scriptedModel([
				[
					{ type: "tool_call_delta", index: 0, id: "h1", name: "hang", argumentsDelta: "{}" },
					{ type: "done", stopReason: "tool_use" },
				],
				[{ type: "content_delta", delta: "看门狗到点后我继续。" }, { type: "done", stopReason: "stop" }],
			]);
			const config = createDefaultConfig();
			config.loop_control.step_timeout_ms = 30;
			const code = await runBi(["--prompt", "跑挂死工具"], {
				model: port,
				config,
				out: () => undefined,
				err: () => undefined,
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [hangTool] },
			});
			expect(code).toBe(0);
			expect(JSON.stringify(received[1]!.messages.at(-1)?.content)).toContain("exceeded deadline");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// [loop_control] turn_timeout_ms
// ---------------------------------------------------------------------------

describe("[loop_control] turn_timeout_ms（单回合总时限）", () => {
	test("生效：超时 → stream-json 落 session_done 帧（exit=\"turn-timeout\"）+ 非零退出 + stderr 提示", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const outs: string[] = [];
			const errs: string[] = [];
			const config = createDefaultConfig();
			config.loop_control.turn_timeout_ms = 30;
			const code = await runBi(["--prompt", "长任务"], {
				model: hangingModel(),
				config,
				out: (line) => outs.push(line),
				err: (line) => errs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(1);
			const parsed = outs.map((line) => JSON.parse(line) as { type: string; exit?: string; rounds?: number });
			const done = parsed.at(-1)!;
			expect(done.type).toBe("session_done");
			expect(done.exit).toBe("turn-timeout");
			expect(errs.join("\n")).toContain("turn-timeout");
			expect(errs.join("\n")).toContain("单回合超过时限 30ms");
		} finally {
			await cleanup();
		}
	});

	test("生效：json 形态 → stdout 落完整对象（exit=\"turn-timeout\"，reply 空串）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const outs: string[] = [];
			const config = createDefaultConfig();
			config.loop_control.turn_timeout_ms = 30;
			const code = await runBi(["--prompt", "长任务", "--output-format", "json"], {
				model: hangingModel(),
				config,
				out: (line) => outs.push(line),
				err: () => undefined,
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(1);
			expect(outs).toHaveLength(1);
			const payload = JSON.parse(outs[0]!) as { exit: string; reply: string; rounds: number };
			expect(payload.exit).toBe("turn-timeout");
			expect(payload.reply).toBe("");
			expect(payload.rounds).toBe(1);
		} finally {
			await cleanup();
		}
	});

	test("缺省关：turn_timeout_ms = 0 → 不限时（正常会话收束，无 turn-timeout 帧）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const outs: string[] = [];
			const { port } = scriptedModel([
				[{ type: "content_delta", delta: "干完了。" }, { type: "done", stopReason: "stop" }],
			]);
			const config = createDefaultConfig();
			config.loop_control.turn_timeout_ms = 0;
			const code = await runBi(["--prompt", "短任务"], {
				model: port,
				config,
				out: (line) => outs.push(line),
				err: () => undefined,
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
			expect(outs.join("\n")).not.toContain("turn-timeout");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// [loop_control] max_iterations（回合上限通用层）
// ---------------------------------------------------------------------------

/** 跑一次必然"回合打尽"的无头会话，返回退出码 / stderr。 */
async function runUntilRoundsExceeded(opts: {
	argv?: readonly string[];
	sessionMaxRounds?: number;
	loopControlMaxIterations?: number;
	depsMaxRounds?: number;
}): Promise<{ code: number; outs: string[]; errs: string[] }> {
	const { root, cleanup } = await makeWorkspace();
	try {
		const outs: string[] = [];
		const errs: string[] = [];
		const config = createDefaultConfig();
		if (opts.sessionMaxRounds !== undefined) config.session = { max_rounds: opts.sessionMaxRounds };
		if (opts.loopControlMaxIterations !== undefined) {
			config.loop_control.max_iterations = opts.loopControlMaxIterations;
		}
		const code = await runBi(opts.argv ?? ["--prompt", "调研任务"], {
			model: loopingModel(),
			config,
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

describe("[loop_control] max_iterations（会话回合上限通用层）", () => {
	test("生效：仅声明本键 → 按其值收束（回合打尽）", async () => {
		const { code, errs } = await runUntilRoundsExceeded({ loopControlMaxIterations: 2 });
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 2");
	});

	test("优先级：[session].max_rounds > [loop_control].max_iterations", async () => {
		const { code, errs } = await runUntilRoundsExceeded({
			sessionMaxRounds: 5,
			loopControlMaxIterations: 2,
		});
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 5");
		expect(errs.join("\n")).not.toContain("模型回合超过上限 2");
	});

	test("优先级：CLI --max-rounds > [loop_control].max_iterations", async () => {
		const { code, errs } = await runUntilRoundsExceeded({
			argv: ["--prompt", "调研任务", "--max-rounds", "1"],
			loopControlMaxIterations: 4,
		});
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 1");
		expect(errs.join("\n")).not.toContain("模型回合超过上限 4");
	});

	test("优先级：deps 透传 > [loop_control].max_iterations", async () => {
		const { code, errs } = await runUntilRoundsExceeded({
			depsMaxRounds: 3,
			loopControlMaxIterations: 4,
		});
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 3");
		expect(errs.join("\n")).not.toContain("模型回合超过上限 4");
	});

	test("0 = 不生效 → 回退内建缺省 16", async () => {
		const { code, errs } = await runUntilRoundsExceeded({ loopControlMaxIterations: 0 });
		expect(code).toBe(1);
		expect(errs.join("\n")).toContain("模型回合超过上限 16");
	});
});

// ---------------------------------------------------------------------------
// [identity] system_prompt_path / extra_instructions
// ---------------------------------------------------------------------------

describe("[identity] system_prompt_path（系统指令前缀）", () => {
	test("生效：config 声明路径 → 文件内容作为系统指令前缀", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const promptFile = join(root, "prompt.md");
			await writeFile(promptFile, "你是勾稽稽核员。", "utf8");
			const { port, received } = scriptedModel([
				[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }],
			]);
			await runHeadless({
				prompt: "开始",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				identity: {
					name: "bi",
					tagline: "",
					system_prompt_path: promptFile,
					extra_instructions: "",
				},
				out: () => undefined,
			});
			const system = received[0]!.messages.find((m) => m.role === "system");
			expect(system?.content).toContain("你是勾稽稽核员。");
		} finally {
			await cleanup();
		}
	});

	test("装配透传：CLI --agent-file 优先于 config system_prompt_path", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const promptFile = join(root, "prompt.md");
			await writeFile(promptFile, "来自 config 文件的指令。", "utf8");
			const agentFile = join(root, "agent.md");
			await writeFile(agentFile, "来自 CLI 的指令。", "utf8");
			const { port, received } = scriptedModel([
				[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }],
			]);
			const config = createDefaultConfig();
			config.identity.system_prompt_path = promptFile;
			await runBi(["--prompt", "开始", "--agent-file", agentFile], {
				model: port,
				config,
				out: () => undefined,
				err: () => undefined,
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			const system = received[0]!.messages.find((m) => m.role === "system");
			expect(system?.content).toContain("来自 CLI 的指令。");
			expect(system?.content).not.toContain("来自 config 文件的指令。");
		} finally {
			await cleanup();
		}
	});

	test("缺省关/异常面：文件不存在 → 结构化 warn（stderr）+ 不炸会话（回退内置）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const errs: string[] = [];
			const { port, received } = scriptedModel([
				[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }],
			]);
			const result = await runHeadless({
				prompt: "开始",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				identity: {
					name: "bi",
					tagline: "",
					system_prompt_path: join(root, "缺失.md"),
					extra_instructions: "",
				},
				err: (line) => errs.push(line),
				out: () => undefined,
			});
			expect(result.exitCode).toBe(0);
			expect(errs.join("\n")).toContain("identity");
			expect(errs.join("\n")).toContain("system_prompt_path");
			// 回退内置：系统面无注入内容
			expect(received[0]!.messages.some((m) => m.role === "system")).toBe(false);
		} finally {
			await cleanup();
		}
	});
});

describe("[identity] extra_instructions（追加系统指令）", () => {
	test("生效：追加为系统面末条（在内建段之后）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([
				[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }],
			]);
			await runHeadless({
				prompt: "开始",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				identity: {
					name: "bi",
					tagline: "",
					system_prompt_path: "",
					extra_instructions: "收尾必须给出勾稽结论。",
				},
				out: () => undefined,
			});
			const system = received[0]!.messages.find((m) => m.role === "system");
			expect(system?.content).toContain("收尾必须给出勾稽结论。");
		} finally {
			await cleanup();
		}
	});

	test("缺省关：空串 → 不追加（系统面无内容）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([
				[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }],
			]);
			await runHeadless({
				prompt: "开始",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				identity: { name: "bi", tagline: "", system_prompt_path: "", extra_instructions: "" },
				out: () => undefined,
			});
			expect(received[0]!.messages.some((m) => m.role === "system")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("装配透传：config [identity] extra_instructions → headless 系统面末条", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([
				[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }],
			]);
			const config = createDefaultConfig();
			config.identity.extra_instructions = "收尾必须给出勾稽结论。";
			const code = await runBi(["--prompt", "开始"], {
				model: port,
				config,
				out: () => undefined,
				err: () => undefined,
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
			const system = received[0]!.messages.find((m) => m.role === "system");
			expect(system?.content).toContain("收尾必须给出勾稽结论。");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// [identity] 键面（config get/set）
// ---------------------------------------------------------------------------

describe("[identity] config 键面", () => {
	test("get/set 可用：identity.* 走根分区自带键面（无需额外注册）", async () => {
		const home = await mkdtemp(join(tmpdir(), "bi-identity-cfg-"));
		try {
			const outs: string[] = [];
			const errs: string[] = [];
			const io = { out: (l: string) => outs.push(l), err: (l: string) => errs.push(l) };
			expect(await runBi(["config", "set", "identity.name", "稽核员"], { ...io, deps: { homeDir: home } })).toBe(0);
			outs.length = 0;
			expect(await runBi(["config", "get", "identity.name"], { ...io, deps: { homeDir: home } })).toBe(0);
			expect(outs.join("\n")).toContain("稽核员");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
