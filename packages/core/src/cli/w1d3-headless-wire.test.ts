/**
 * W1-D3（BI-08.1 + BI-11.1 + BI-21.1）· headless 装配面验收。
 *
 * 三开关各自 on/off 对照（缺省 off = 与现状逐字节等价的关键回归）：
 * - outputLimitBytes：截断边界（恰好上限不截 / 超限截断附钉死标记行）、
 *   对象值 stringify 后有界化、错误路径不截；
 * - sanitizeErrors：错误抛出口脱敏 on/off 对照；
 * - verify：通过/失败两路 + off 时零开销（runner 不被触达）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildVerifyContract,
	runHeadless,
	HeadlessError,
	type HeadlessOptions,
	type ModelPort,
	type ToolBinding,
} from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import type {
	CommandRunner,
	CommandRunOutcome,
	TargetContract,
} from "../verifier/target-verifier";
import type { VerifySection } from "../config/schema";

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

/** 固定输出工具绑定（供截断断言）。 */
function fixedOutputTool(output: unknown): ToolBinding {
	return {
		definition: {
			name: "emit",
			description: "输出固定内容",
			inputSchema: { type: "object", properties: {} },
		},
		readOnly: true,
		execute: async () => output,
	};
}

function errorTool(message: string): ToolBinding {
	return {
		definition: { name: "boom", description: "必失败工具", inputSchema: { type: "object", properties: {} } },
		readOnly: false,
		execute: async () => {
			throw new Error(message);
		},
	};
}

const FINAL_ROUND: StreamEvent[] = [
	{ type: "content_delta", delta: "完成。" },
	{ type: "done", stopReason: "stop" },
];

const TOOL_THEN_FINAL = (output: unknown): StreamEvent[][] => [
	[
		{ type: "tool_call_delta", index: 0, id: "call_1", name: "emit", argumentsDelta: "{}" },
		{ type: "done", stopReason: "tool_use" },
	],
	FINAL_ROUND,
];

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-w1d3-hl-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** 脚本化 CommandRunner：按序回放 outcome，并记录触达的命令（白名单旁证）。 */
function scriptedRunner(outcomes: readonly CommandRunOutcome[]): CommandRunner & { readonly calls: string[] } {
	const calls: string[] = [];
	let cursor = 0;
	return {
		calls,
		async run(command: string): Promise<CommandRunOutcome> {
			calls.push(command);
			const outcome = outcomes[Math.min(cursor, outcomes.length - 1)];
			cursor += 1;
			return outcome ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
		},
	};
}

const PASS_CONTRACT: TargetContract = {
	objective: "交付产物",
	deliverables: [{ path: "out.txt", mustExist: true, mustContain: ["done"] }],
	checks: [{ id: "noop", kind: "command", command: "true", description: "空命令" }],
	tolerance: "best-effort",
};

// ---------------------------------------------------------------------------
// BI-08.1 有界截断
// ---------------------------------------------------------------------------

describe("W1-D3 headless: outputLimitBytes（BI-08.1）", () => {
	test("off（缺省）：超大工具输出原样穿越（逐字节等价回归）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "x".repeat(5_000);
			const { port, received } = scriptedModel(TOOL_THEN_FINAL(raw));
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [fixedOutputTool(raw)],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as HeadlessOptions);

			expect(result.exitCode).toBe(0);
			expect(result.toolResults[0]!.value).toBe(raw); // 同一字符串，未截断
			const lastMessage = received[1]!.messages.at(-1);
			expect(JSON.stringify(lastMessage?.content)).toContain(raw.slice(0, 100));
			expect(JSON.stringify(lastMessage?.content).length).toBeGreaterThan(4_900);
		} finally {
			await cleanup();
		}
	});

	test("on：单行超限按两级预算截断，标记行钉死（确定性算例）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "x".repeat(500);
			const { port } = scriptedModel(TOOL_THEN_FINAL(raw));
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [fixedOutputTool(raw)],
				sessionsRoot: join(root, "sessions"),
				outputLimitBytes: 200,
				out: () => {},
			} as HeadlessOptions);

			const value = result.toolResults[0]!.value as string;
			// F-EV-05：单行（尾侧为空）时尾侧字符预算整段并入头侧——头侧拿满
			// available（200 − 标记行 55 − 分隔符 1 = 144），不再是半预算 72。
			expect(value).toBe("x".repeat(144) + "\n" + "[... output truncated: 356 chars / 0 lines omitted ...]");
			expect(result.verification).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("on：多行超限保头尾、抹中间（头行/尾行在、中段不在、标记行在）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = Array.from({ length: 500 }, (_, i) => `L${String(i).padStart(4, "0")}`).join("\n");
			const { port } = scriptedModel(TOOL_THEN_FINAL(raw));
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [fixedOutputTool(raw)],
				sessionsRoot: join(root, "sessions"),
				outputLimitBytes: 400,
				out: () => {},
			} as HeadlessOptions);

			const value = result.toolResults[0]!.value as string;
			expect(value).toContain("L0000");
			expect(value).toContain("L0499");
			expect(value).not.toContain("L0200");
			expect(value).toMatch(/\[\.\.\. output truncated: \d+ chars \/ \d+ lines omitted \.\.\.\]/);
		} finally {
			await cleanup();
		}
	});

	test("边界：恰好等于上限不截（器官钉死语义经装配层保持）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "y".repeat(300);
			const { port } = scriptedModel(TOOL_THEN_FINAL(raw));
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [fixedOutputTool(raw)],
				sessionsRoot: join(root, "sessions"),
				outputLimitBytes: 300,
				out: () => {},
			} as HeadlessOptions);
			expect(result.toolResults[0]!.value).toBe(raw);
		} finally {
			await cleanup();
		}
	});

	test("on：对象值先 stringify 再有界；未超限时对象原样返回（同一引用）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const obj = { blob: "z".repeat(500), tag: "t" };
			const under = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: scriptedModel(TOOL_THEN_FINAL(obj)).port,
				tools: [fixedOutputTool(obj)],
				sessionsRoot: join(root, "sessions"),
				outputLimitBytes: 100_000,
				out: () => {},
			} as HeadlessOptions);
			expect(under.toolResults[0]!.value).toBe(obj); // 未超限：原对象，零变形

			const over = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: scriptedModel(TOOL_THEN_FINAL(obj)).port,
				tools: [fixedOutputTool(obj)],
				sessionsRoot: join(root, "sessions"),
				outputLimitBytes: 200,
				out: () => {},
			} as HeadlessOptions);
			const value = over.toolResults[0]!.value as string;
			expect(typeof value).toBe("string");
			expect(value).toContain("[... output truncated:");
		} finally {
			await cleanup();
		}
	});

	test("on：工具失败路径不截（错误文本原样，截断只管成功输出）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const huge = "e".repeat(500);
			const { port } = scriptedModel([
				[
					{ type: "tool_call_delta", index: 0, id: "call_1", name: "boom", argumentsDelta: "{}" },
					{ type: "done", stopReason: "tool_use" },
				],
				FINAL_ROUND,
			]);
			const result = await runHeadless({
				prompt: "输出",
				cwd: root,
				model: port,
				tools: [errorTool(huge)],
				sessionsRoot: join(root, "sessions"),
				outputLimitBytes: 100,
				out: () => {},
			} as HeadlessOptions);
			expect(result.toolResults[0]!.ok).toBe(false);
			expect(result.toolResults[0]!.error).toBe(huge);
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// BI-11.1 错误文本脱敏
// ---------------------------------------------------------------------------

const SECRET_ERROR: StreamEvent[] = [
	{
		type: "error",
		error: { code: "server", message: "上游 401 Authorization: Bearer sk-abcdef1234567890 token=ghp_abcdef123456" },
	},
];

describe("W1-D3 headless: sanitizeErrors（BI-11.1）", () => {
	test("on：错误抛出口先脱敏（凭据/IP 模式抹除，零数据外泄）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			let caught: unknown;
			try {
				await runHeadless({
					prompt: "hi",
					cwd: root,
					model: scriptedModel([SECRET_ERROR]).port,
					tools: [],
					sessionsRoot: join(root, "sessions"),
					sanitizeErrors: true,
					out: () => {},
				} as HeadlessOptions);
			} catch (err) {
				caught = err;
			}
			expect(caught).toBeInstanceOf(HeadlessError);
			const message = (caught as HeadlessError).message;
			expect(message).toContain("authorization: …");
			expect(message).not.toContain("sk-abcdef1234567890");
			expect(message).not.toContain("ghp_abcdef123456");
		} finally {
			await cleanup();
		}
	});

	test("off（缺省）：错误消息原样抛出（现状逐字节等价）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			let caught: unknown;
			try {
				await runHeadless({
					prompt: "hi",
					cwd: root,
					model: scriptedModel([SECRET_ERROR]).port,
					tools: [],
					sessionsRoot: join(root, "sessions"),
					out: () => {},
				} as HeadlessOptions);
			} catch (err) {
				caught = err;
			}
			expect((caught as HeadlessError).message).toContain("sk-abcdef1234567890");
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// BI-21.1 收尾自验看门狗
// ---------------------------------------------------------------------------

describe("W1-D3 headless: verify（BI-21.1）", () => {
	test("off（缺省）：零开销——无 verification 回执，正常收尾", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([FINAL_ROUND]);
			const result = await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				out: () => {},
			} as HeadlessOptions);
			expect(result.exitCode).toBe(0);
			expect(result.verification).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("on 通过：verification 回执挂载 + session_done ok（runner 经注入面触达）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "out.txt"), "all done", "utf8");
			const runner = scriptedRunner([{ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }]);
			const lines: string[] = [];
			const result = await runHeadless({
				prompt: "hi",
				cwd: root,
				model: scriptedModel([FINAL_ROUND]).port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				verify: { contract: PASS_CONTRACT, runner },
				out: (line) => lines.push(line),
			} as HeadlessOptions);

			expect(result.exitCode).toBe(0);
			expect(result.verification?.passed).toBe(true);
			expect(result.verification?.gaps).toEqual([]);
			expect(runner.calls).toEqual(["true"]);
			const done = JSON.parse(lines.at(-1)!) as { type: string; exit?: string };
			expect(done.type).toBe("session_done");
			expect(done.exit).toBe("ok");
		} finally {
			await cleanup();
		}
	});

	test("on 不通过：deliverable 缺失 → verify-failed 结构化报告 + 非零退出（不假冒成功）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const runner = scriptedRunner([{ exitCode: 0, stdout: "", stderr: "", timedOut: false }]);
			const lines: string[] = [];
			let caught: unknown;
			try {
				await runHeadless({
					prompt: "hi",
					cwd: root,
					model: scriptedModel([FINAL_ROUND]).port,
					tools: [],
					sessionsRoot: join(root, "sessions"),
					verify: { contract: PASS_CONTRACT, runner },
					out: (line) => lines.push(line),
				} as HeadlessOptions);
			} catch (err) {
				caught = err;
			}
			const error = caught as HeadlessError;
			expect(error).toBeInstanceOf(HeadlessError);
			expect(error.code).toBe("verify-failed");
			expect(error.verification?.passed).toBe(false);
			expect(error.verification?.gaps.length).toBeGreaterThan(0);
			// 错误消息携带 formatGaps 人类可读清单
			expect(error.message).toContain("target incomplete");
			expect(error.message).toContain("deliverable[0]:out.txt");
			// stream-json 线：末行 session_done exit=verify-failed，gaps 结构化上路
			const done = JSON.parse(lines.at(-1)!) as { type: string; exit?: string; gaps?: unknown[] };
			expect(done.type).toBe("session_done");
			expect(done.exit).toBe("verify-failed");
			expect(Array.isArray(done.gaps)).toBe(true);
			expect((done.gaps as unknown[]).length).toBeGreaterThan(0);
			// runner 未被触达（deliverable 先失败，checks 仍跑——best-effort 见下）
			expect(runner.calls).toEqual(["true"]);
		} finally {
			await cleanup();
		}
	});

	test("on 不通过：command 检查 exit≠0 → gap 收录（best-effort 契约收完整自愈清单）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "out.txt"), "all done", "utf8");
			const runner = scriptedRunner([
				{ exitCode: 1, stdout: "", stderr: "boom detail", timedOut: false },
			]);
			let caught: unknown;
			try {
				await runHeadless({
					prompt: "hi",
					cwd: root,
					model: scriptedModel([FINAL_ROUND]).port,
					tools: [],
					sessionsRoot: join(root, "sessions"),
					verify: { contract: PASS_CONTRACT, runner },
					out: () => {},
				} as HeadlessOptions);
			} catch (err) {
				caught = err;
			}
			const error = caught as HeadlessError;
			expect(error.code).toBe("verify-failed");
			expect(error.verification?.gaps.some((g) => g.checkId === "noop")).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("on 不通过（text 形态）：out 空——报告只经错误通道，不落最终文本", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const runner = scriptedRunner([{ exitCode: 0, stdout: "", stderr: "", timedOut: false }]);
			const lines: string[] = [];
			await expect(
				runHeadless({
					prompt: "hi",
					cwd: root,
					model: scriptedModel([FINAL_ROUND]).port,
					tools: [],
					sessionsRoot: join(root, "sessions"),
					outputFormat: "text",
					verify: { contract: PASS_CONTRACT, runner },
					out: (line) => lines.push(line),
				} as HeadlessOptions),
			).rejects.toThrow(HeadlessError);
			expect(lines).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("on 不通过 + sanitizeErrors：verify-failed 消息与线上 gaps 同样先过脱敏器", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const contract: TargetContract = {
				objective: "o",
				deliverables: [{ path: "missing.txt", mustExist: true }],
				checks: [{ id: "leaky", kind: "command", command: "echo", description: "d" }],
				tolerance: "best-effort",
			};
			const runner = scriptedRunner([
				{ exitCode: 1, stdout: "", stderr: "fatal: bad token sk-zzzz999988887777", timedOut: false },
			]);
			const lines: string[] = [];
			let caught: unknown;
			try {
				await runHeadless({
					prompt: "hi",
					cwd: root,
					model: scriptedModel([FINAL_ROUND]).port,
					tools: [],
					sessionsRoot: join(root, "sessions"),
					sanitizeErrors: true,
					verify: { contract, runner },
					out: (line) => lines.push(line),
				} as HeadlessOptions);
			} catch (err) {
				caught = err;
			}
			const message = (caught as HeadlessError).message;
			expect(message).not.toContain("sk-zzzz999988887777");
			expect(message).toContain("sk-…");
			// stream-json 线上的 gaps 结构化报告同样脱敏（stderr 回显的凭据不外泄）
			const done = JSON.parse(lines.at(-1)!) as { exit?: string; gaps?: Array<{ actual: string }> };
			expect(done.exit).toBe("verify-failed");
			expect(done.gaps!.some((g) => g.actual.includes("sk-zzzz999988887777"))).toBe(false);
			expect(done.gaps!.some((g) => g.actual.includes("sk-…"))).toBe(true);
		} finally {
			await cleanup();
		}
	});
});

// ---------------------------------------------------------------------------
// buildVerifyContract：config [verify] → TargetContract
// ---------------------------------------------------------------------------

describe("W1-D3 headless: buildVerifyContract", () => {
	test("映射：kind 恒 command、tolerance 恒 best-effort、字段逐项转换", () => {
		const section: VerifySection = {
			on_completion: true,
			objective: "修复计算器",
			deliverables: [{ path: "calc.test.ts", must_exist: true, must_contain: ["add", "sub"] }],
			checks: [{ id: "t", command: "bun test", description: "跑测试" }],
		};
		expect(buildVerifyContract(section)).toEqual({
			objective: "修复计算器",
			deliverables: [{ path: "calc.test.ts", mustExist: true, mustContain: ["add", "sub"] }],
			checks: [{ id: "t", kind: "command", command: "bun test", description: "跑测试" }],
			tolerance: "best-effort",
		});
	});

	test("空契约：空 deliverables/checks 恒过（声明面为空 = 无可验项，不假冒失败）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const contract = buildVerifyContract({
				on_completion: true,
				objective: "",
				deliverables: [],
				checks: [],
			});
			const result = await runHeadless({
				prompt: "hi",
				cwd: root,
				model: scriptedModel([FINAL_ROUND]).port,
				tools: [],
				sessionsRoot: join(root, "sessions"),
				verify: { contract, runner: scriptedRunner([]) },
				out: () => {},
			} as HeadlessOptions);
			expect(result.exitCode).toBe(0);
			expect(result.verification?.passed).toBe(true);
		} finally {
			await cleanup();
		}
	});
});
