/**
 * BI-20.2b —— 全局 flag 装配消费面单测（最小诚实消费，不假冒成功）。
 *
 * 覆盖：解析后原先无人消费的 --agent-file / --add-dir 接进无头装配面的断言。
 * 解析面已在 cli/commands/args.test.ts 覆盖，此处不重复；本文件只验消费语义。
 * 模型端口一律脚本化替身（零网络、零真凭据）；fs 用临时目录。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBi } from "./main";
import { runHeadless, type ModelPort } from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";

/** 脚本化模型端口：按回合回放，捕获收到的消息流供注入断言。 */
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

const STOP_ROUND: StreamEvent[] = [
	{ type: "content_delta", delta: "done" },
	{ type: "done", stopReason: "stop" },
];

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-afd-"));
	await writeFile(join(root, "note.txt"), "x", "utf8");
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("BI-20.2b --agent-file 消费（系统指令面）", () => {
	test("内容作为 system 消息前置注入无头会话（经主分发跑通）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const agentPath = join(root, "agent.md");
			const agentContent = "# 指令\n你是一个严谨的审计助手。";
			await writeFile(agentPath, agentContent, "utf8");
			const { port, received } = scriptedModel([STOP_ROUND]);
			const code = await runBi(["--prompt", "hi", "--agent-file", agentPath], {
				model: port,
				out: () => {},
				err: () => {},
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
			expect(received).toHaveLength(1);
			const first = received[0]!.messages[0]!;
			expect(first.role).toBe("system");
			expect(first.content).toBe(agentContent);
			// user 提示词紧随其后
			expect(received[0]!.messages[1]!.role).toBe("user");
		} finally {
			await cleanup();
		}
	});

	test("runHeadless 直接注入：systemInstruction 前置首条消息", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port, received } = scriptedModel([STOP_ROUND]);
			const result = await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				systemInstruction: "be terse",
				out: () => {},
			} as Parameters<typeof runHeadless>[0]);
			expect(result.exitCode).toBe(0);
			expect(received[0]!.messages[0]!.role).toBe("system");
			expect(received[0]!.messages[0]!.content).toBe("be terse");
		} finally {
			await cleanup();
		}
	});

	test("文件缺失/不可读：结构化参数错误 exit 2（不静默继续）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const errs: string[] = [];
			const code = await runBi(["--prompt", "hi", "--agent-file", join(root, "nope.md")], {
				model: undefined as unknown as ModelPort,
				out: () => {},
				err: (line) => errs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(2);
			expect(errs.join("\n")).toContain("[param-error]");
			expect(errs.join("\n")).toContain("--agent-file");
		} finally {
			await cleanup();
		}
	});
});

describe("BI-20.2b --add-dir 消费（存在性校验 + 透传，toolset 单根边界备案）", () => {
	test("有效目录：校验通过并透传进会话上下文（HeadlessResult.additionalDirs）", async () => {
		const { root, cleanup } = await makeWorkspace();
		const extra = await mkdtemp(join(tmpdir(), "bi-adddir-"));
		try {
			const { port } = scriptedModel([STOP_ROUND]);
			const result = await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				additionalDirs: [extra],
				out: () => {},
			} as Parameters<typeof runHeadless>[0]);
			expect(result.exitCode).toBe(0);
			expect(result.additionalDirs).toEqual([extra]);
		} finally {
			await rm(extra, { recursive: true, force: true });
			await cleanup();
		}
	});

	test("缺省（无 --add-dir）：additionalDirs 为空数组（不暴露未传值）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([STOP_ROUND]);
			const result = await runHeadless({
				prompt: "hi",
				cwd: root,
				model: port,
				tools: [],
				out: () => {},
			} as Parameters<typeof runHeadless>[0]);
			expect(result.additionalDirs).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("经主分发：有效 --add-dir 不阻断（exit 0），无效目录结构化 exit 2", async () => {
		const { root, cleanup } = await makeWorkspace();
		const extra = await mkdtemp(join(tmpdir(), "bi-adddir-"));
		try {
			const { port } = scriptedModel([STOP_ROUND]);
			const ok = await runBi(["--prompt", "hi", "--add-dir", extra], {
				model: port,
				out: () => {},
				err: () => {},
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(ok).toBe(0);
		} finally {
			await rm(extra, { recursive: true, force: true });
			await cleanup();
		}

		// 不存在的目录 → exit 2
		const { root: r2, cleanup: c2 } = await makeWorkspace();
		try {
			const errs: string[] = [];
			const missing = await runBi(["--prompt", "hi", "--add-dir", join(r2, "ghost")], {
				model: undefined as unknown as ModelPort,
				out: () => {},
				err: (line) => errs.push(line),
				headless: { cwd: r2, sessionsRoot: join(r2, "sessions"), tools: [] },
			});
			expect(missing).toBe(2);
			expect(errs.join("\n")).toContain("[param-error]");
			expect(errs.join("\n")).toContain("--add-dir");
		} finally {
			await c2();
		}

		// 存在但非目录（是文件）→ exit 2
		const { root: r3, cleanup: c3 } = await makeWorkspace();
		try {
			const errs: string[] = [];
			const notDir = await runBi(["--prompt", "hi", "--add-dir", join(r3, "note.txt")], {
				model: undefined as unknown as ModelPort,
				out: () => {},
				err: (line) => errs.push(line),
				headless: { cwd: r3, sessionsRoot: join(r3, "sessions"), tools: [] },
			});
			expect(notDir).toBe(2);
			expect(errs.join("\n")).toContain("--add-dir 不是目录");
		} finally {
			await c3();
		}
	});
});
