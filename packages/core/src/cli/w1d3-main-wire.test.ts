/**
 * W1-D3（BI-08.1 + BI-11.1 + BI-21.1）· main 分发装配面验收。
 *
 * config → runHeadless 的开关下发经 RunBiOptions.config 注入面做确定性 e2e
 * （model 替身 + 已装载配置注入，零磁盘零网络）；并回归"注入 model 而未注
 * config = 跳过配置装载 = 现状行为逐字节等价"。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import type { ModelPort, ToolBinding } from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type BiConfig } from "../config/schema";

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

function fixedOutputTool(output: unknown): ToolBinding {
	return {
		definition: { name: "emit", description: "输出固定内容", inputSchema: { type: "object", properties: {} } },
		readOnly: true,
		execute: async () => output,
	};
}

function toolThenFinal(): StreamEvent[][] {
	return [
		[
			{ type: "tool_call_delta", index: 0, id: "call_1", name: "emit", argumentsDelta: "{}" },
			{ type: "done", stopReason: "tool_use" },
		],
		[{ type: "content_delta", delta: "完成。" }, { type: "done", stopReason: "stop" }],
	];
}

function configWith(patch: (config: BiConfig) => void): BiConfig {
	const config = createDefaultConfig();
	patch(config);
	return config;
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-w1d3-main-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("W1-D3 main: [tools] output_limit_bytes → runHeadless", () => {
	test("on：config 声明的上限经主分发生效（模型回填见截断标记，原文不整穿）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "x".repeat(5_000);
			const { port, received } = scriptedModel(toolThenFinal());
			const code = await runBi(["--prompt", "输出"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.tools.output_limit_bytes = 200;
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [fixedOutputTool(raw)] },
			});
			expect(code).toBe(0);
			const lastMessage = received[1]!.messages.at(-1);
			const content = JSON.stringify(lastMessage?.content);
			expect(content).toContain("[... output truncated:");
			expect(content).not.toContain(raw); // 5000 字符原文不整穿
		} finally {
			await cleanup();
		}
	});

	test("缺省 64KiB（F-ST-04）：config 未声明时超限输出经 boundToolText 截断", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "x".repeat(100_000); // > 64KiB 缺省上限
			const { port, received } = scriptedModel(toolThenFinal());
			const code = await runBi(["--prompt", "输出"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith(() => {
					// 缺省态：config [tools] output_limit_bytes = 65536（64KiB 有界截断）
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [fixedOutputTool(raw)] },
			});
			expect(code).toBe(0);
			const lastMessage = received[1]!.messages.at(-1);
			const content = JSON.stringify(lastMessage?.content);
			expect(content).toContain("[... output truncated:");
			expect(content).not.toContain(raw); // 超限原文不整穿
		} finally {
			await cleanup();
		}
	});

	test("显式 0 = off：超大输出原样回填（关闭截断，与缺省 64KiB 区分）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "x".repeat(100_000);
			const { port, received } = scriptedModel(toolThenFinal());
			const code = await runBi(["--prompt", "输出"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.tools.output_limit_bytes = 0; // 显式 0 = off
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [fixedOutputTool(raw)] },
			});
			expect(code).toBe(0);
			expect(JSON.stringify(received[1]!.messages.at(-1)?.content)).toContain(raw);
		} finally {
			await cleanup();
		}
	});

	test("注入 model 而未注 config：跳过配置装载，输出不截（现状路径）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const raw = "x".repeat(100_000);
			const { port, received } = scriptedModel(toolThenFinal());
			const code = await runBi(["--prompt", "输出"], {
				model: port,
				out: () => {},
				err: () => {},
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [fixedOutputTool(raw)] },
			});
			expect(code).toBe(0);
			expect(JSON.stringify(received[1]!.messages.at(-1)?.content)).toContain(raw);
		} finally {
			await cleanup();
		}
	});
});

describe("W1-D3 main: [telemetry] sanitize_errors → err 面", () => {
	const SECRET_ERROR: StreamEvent[] = [
		{ type: "error", error: { code: "server", message: "上游 401 Authorization: Bearer sk-abcdef1234567890" } },
	];

	test("on：会话失败文本经 err 报出前脱敏", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([SECRET_ERROR]);
			const errs: string[] = [];
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: (line) => errs.push(line),
				config: configWith((c) => {
					c.telemetry.sanitize_errors = true;
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(1);
			expect(errs.join("\n")).toContain("会话失败");
			expect(errs.join("\n")).toContain("authorization: …");
			expect(errs.join("\n")).not.toContain("sk-abcdef1234567890");
		} finally {
			await cleanup();
		}
	});

	test("off（缺省）：err 面原样报出（现状逐字节等价）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([SECRET_ERROR]);
			const errs: string[] = [];
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: (line) => errs.push(line),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(1);
			expect(errs.join("\n")).toContain("sk-abcdef1234567890");
		} finally {
			await cleanup();
		}
	});
});

describe("W1-D3 main: [verify] on_completion → 收尾自验", () => {
	test("on 通过（deliverable 落盘）：exit 0，正常收尾", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "out.txt"), "done", "utf8");
			const { port } = scriptedModel([[{ type: "content_delta", delta: "好" }, { type: "done", stopReason: "stop" }]]);
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.verify = {
						on_completion: true,
						objective: "交付 out.txt",
						deliverables: [{ path: "out.txt", must_exist: true, must_contain: ["done"] }],
						checks: [],
					};
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
		} finally {
			await cleanup();
		}
	});

	test("on 不通过（deliverable 缺失）：exit 1 + err 结构化差距报告（不假冒成功）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([[{ type: "content_delta", delta: "我宣称完成了" }, { type: "done", stopReason: "stop" }]]);
			const errs: string[] = [];
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: (line) => errs.push(line),
				config: configWith((c) => {
					c.verify = {
						on_completion: true,
						objective: "交付 out.txt",
						deliverables: [{ path: "out.txt", must_exist: true, must_contain: [] }],
						checks: [],
					};
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(1);
			expect(errs.join("\n")).toContain("会话失败");
			expect(errs.join("\n")).toContain("收尾自验未通过");
			expect(errs.join("\n")).toContain("deliverable[0]:out.txt");
		} finally {
			await cleanup();
		}
	});

	test("off（on_completion=false）：同一缺失 deliverable 的场景 exit 0（零开销零行为差）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { port } = scriptedModel([[{ type: "content_delta", delta: "我宣称完成了" }, { type: "done", stopReason: "stop" }]]);
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: () => {},
				config: configWith((c) => {
					c.verify = {
						on_completion: false,
						objective: "交付 out.txt",
						deliverables: [{ path: "out.txt", must_exist: true, must_contain: [] }],
						checks: [],
					};
				}),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
		} finally {
			await cleanup();
		}
	});
});
