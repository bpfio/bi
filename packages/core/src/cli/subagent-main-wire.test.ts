/**
 * BI-07.4 · main 分发装配面验收（config [subagent] enabled → headless 注册
 * spawn_subagent 并派生子会话）。
 *
 * 通过 RunBiOptions.config 注入面做确定性 e2e（脚本化模型复用同一份 cursor 驱动
 * 父回合与子会话：回合0=父调 spawn_subagent，回合1=子会话回答，回合2=父收束）。
 * 断言：exit 0 + 子会话（sub- 前缀）独立落盘（持久化隔离）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import type { ModelPort } from "./headless";
import type { AgentMessage, StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig, type BiConfig } from "../config/schema";
import { SessionManager } from "../session/manager";

function subagentScriptedModel(): ModelPort {
	const rounds: StreamEvent[][] = [
		[
			{ type: "tool_call_delta", index: 0, id: "s1", name: "spawn_subagent", argumentsDelta: '{"goal":"找X","profile":"explore"}' },
			{ type: "done", stopReason: "tool_use" },
		],
		[{ type: "content_delta", delta: "子答案" }, { type: "done", stopReason: "stop" }],
		[{ type: "content_delta", delta: "主回合完成" }, { type: "done", stopReason: "stop" }],
	];
	let cursor = 0;
	return {
		async *stream(input) {
			const round = rounds[cursor];
			cursor += 1;
			if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
			void (input.messages as readonly AgentMessage[]);
			for (const event of round) yield event;
		},
	};
}

function configWithSubagent(enabled: boolean): BiConfig {
	const config = createDefaultConfig();
	config.subagent = { enabled, btw_enabled: false, default_profile: "explore", max_iterations: 8, timeout_ms: 60_000 };
	return config;
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-subagent-main-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("BI-07.4 main: [subagent] enabled → spawn_subagent 装配 + 子会话落盘", () => {
	test("enabled=true：spawn_subagent 注册并派生子会话（子会话独立落盘隔离）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const code = await runBi(["--prompt", "开始"], {
				model: subagentScriptedModel(),
				out: () => {},
				err: () => {},
				config: configWithSubagent(true),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
			const mgr = new SessionManager({ rootDir: join(root, "sessions") });
			const sessions = await mgr.listSessions();
			expect(sessions.some((s) => s.sessionId.startsWith("sub-"))).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("enabled=false（缺省）：不注册 spawn_subagent，模型若调用则无此工具（exit 0，无子会话）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			// 即便模型尝试调用 spawn_subagent，工具表未注册 → 与 enabled 行为一致地零装配。
			const code = await runBi(["--prompt", "开始"], {
				model: subagentScriptedModel(),
				out: () => {},
				err: () => {},
				config: configWithSubagent(false),
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			// 工具未注册时，模型第一轮 spawn 调用被装配层按 unknown-tool 处理为
			// 工具错误回喂模型（不炸会话），模型续轮正常收束 → exit 0；关键是
			// 没有任何 sub- 子会话落盘（装配未触发）。
			expect(code).toBe(0);
			const mgr = new SessionManager({ rootDir: join(root, "sessions") });
			const sessions = await mgr.listSessions();
			expect(sessions.some((s) => s.sessionId.startsWith("sub-"))).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("未注入 config = 跳过装配（缺省路径逐字节等价，exit 0）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			// 不触发 spawn 的普通模型，验证缺省装配零行为差。
			const port: ModelPort = {
				async *stream() {
					yield { type: "content_delta", delta: "ok" } as StreamEvent;
					yield { type: "done", stopReason: "stop" } as StreamEvent;
				},
			};
			const code = await runBi(["--prompt", "hi"], {
				model: port,
				out: () => {},
				err: () => {},
				headless: { cwd: root, sessionsRoot: join(root, "sessions"), tools: [] },
			});
			expect(code).toBe(0);
		} finally {
			await cleanup();
		}
	});
});
