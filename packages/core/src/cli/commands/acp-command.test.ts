/**
 * BI-20.6 —— core 侧 ACP 命令测试：AgentLoop 装配端口的流式回执 / 取消映射 /
 * `bi acp` 命令编排（工厂注入接缝⑤）。
 */
import { describe, expect, test } from "bun:test";
import {
	ACP_COMMAND_NAME,
	createAcpAgentPort,
	runAcpCommand,
	type AcpBridgeLike,
	type AcpSessionUpdateLike,
} from "./acp-command";

// ---------- 脚手架 ----------

interface Emitted {
	updates: AcpSessionUpdateLike[];
	stopReason?: string;
}

/** 收集 emit 的更新；返回端口调用上下文手柄。 */
function harness() {
	const emitted: AcpSessionUpdateLike[] = [];
	const controllers: AbortController[] = [];
	return {
		emitted,
		nextContext(): { sessionId: string; signal: AbortSignal; emit: (u: AcpSessionUpdateLike) => void } {
			const controller = new AbortController();
			controllers.push(controller);
			return {
				sessionId: "ses_test",
				signal: controller.signal,
				emit: (update) => emitted.push(update),
			};
		},
		abortLast(): void {
			controllers[controllers.length - 1]?.abort();
		},
	};
}

const INPUT = { text: "帮我读文件", blocks: [{ type: "text", text: "帮我读文件" }] };

// ---------- createAcpAgentPort（AgentLoop 装配端口） ----------

describe("createAcpAgentPort：工具调用流式回执", () => {
	test("plan→单工具：tool_call(in_progress) → tool_call_update(completed) 按序回执", async () => {
		const h = harness();
		const port = createAcpAgentPort({
			execute: async () => "file-contents",
			plan: () => [{ id: "t1", name: "read_file", args: { path: "/a.txt" } }],
		});
		const outcome = await port.prompt(INPUT, h.nextContext());
		expect(outcome).toEqual({ stopReason: "end_turn" });
		expect(h.emitted).toHaveLength(2);
		expect(h.emitted[0]).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "t1",
			title: "read_file",
			status: "in_progress",
			rawInput: { path: "/a.txt" },
		});
		expect(h.emitted[1]).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			output: "file-contents",
		});
	});

	test("执行体抛错 → tool_call_update(failed) 携带错误消息，回合仍 end_turn", async () => {
		const h = harness();
		const port = createAcpAgentPort({
			execute: async () => {
				throw new Error("磁盘不可达");
			},
			plan: () => [{ id: "t1", name: "boom", args: {} }],
		});
		const outcome = await port.prompt(INPUT, h.nextContext());
		expect(outcome).toEqual({ stopReason: "end_turn" });
		expect(h.emitted[1]).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "failed",
			error: "磁盘不可达",
		});
	});

	test("respond 注入产出 agent_message_chunk；空串不发送", async () => {
		const h = harness();
		const port = createAcpAgentPort({
			execute: async () => null,
			respond: () => "这是最终答复",
		});
		await port.prompt(INPUT, h.nextContext());
		expect(h.emitted).toEqual([
			{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "这是最终答复" } },
		]);
		const h2 = harness();
		const port2 = createAcpAgentPort({ execute: async () => null, respond: () => "" });
		await port2.prompt(INPUT, h2.nextContext());
		expect(h2.emitted).toEqual([]);
	});

	test("缺省 plan/respond：零事件直接 end_turn", async () => {
		const h = harness();
		const port = createAcpAgentPort({ execute: async () => null });
		const outcome = await port.prompt(INPUT, h.nextContext());
		expect(outcome).toEqual({ stopReason: "end_turn" });
		expect(h.emitted).toEqual([]);
	});

	test("prompt 前已 abort → cancelled 且不触计划/执行", async () => {
		const h = harness();
		let executed = false;
		const port = createAcpAgentPort({
			execute: async () => {
				executed = true;
				return null;
			},
			plan: () => {
				throw new Error("不应触达计划");
			},
		});
		const ctx = h.nextContext();
		h.abortLast();
		const outcome = await port.prompt(INPUT, ctx);
		expect(outcome).toEqual({ stopReason: "cancelled" });
		expect(h.emitted).toEqual([]);
		expect(executed).toBe(false);
	});

	test("客户端 abort → 二段取消：未派发调用补发 failed(cancelled)，stopReason cancelled", async () => {
		const h = harness();
		const port = createAcpAgentPort({
			execute: async (call, signal) => {
				if (call.id === "t1") {
					// t1 挂起直至批次协作取消信号（房规：在飞工具 settle 后才暂停）
					await new Promise<void>((resolve) => {
						signal.addEventListener("abort", () => resolve(), { once: true });
					});
					return "settled";
				}
				return "t2-value";
			},
			plan: () => [
				{ id: "t1", name: "write_a", args: {} },
				{ id: "t2", name: "write_b", args: {} },
			],
			fileAccesses: () => ["/same/path"],
		});
		const ctx = h.nextContext();
		const outcomePromise = port.prompt(INPUT, ctx);
		// 等 t1 进入执行（tool_call 回执出现）再 abort
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(h.emitted[0]).toMatchObject({ sessionUpdate: "tool_call", toolCallId: "t1" });
		h.abortLast();
		const outcome = await outcomePromise;
		expect(outcome).toEqual({ stopReason: "cancelled" });
		const kinds = h.emitted.map((u) => (u as { sessionUpdate: string }).sessionUpdate);
		// t1 落定 → completed；t2 未派发 → failed(cancelled) 补发
		expect(h.emitted).toContainEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "t1",
			status: "completed",
			output: "settled",
		});
		expect(h.emitted).toContainEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "t2",
			status: "failed",
			error: "cancelled",
		});
		expect(kinds[0]).toBe("tool_call");
	});
});

// ---------- runAcpCommand（`bi acp` 编排） ----------

function fakeBridge(): AcpBridgeLike & { calls: string[]; channels?: unknown } {
	const calls: string[] = [];
	return {
		calls,
		start: async () => {
			calls.push("start");
		},
		stop: async () => {
			calls.push("stop");
		},
	};
}

describe("runAcpCommand：命令编排", () => {
	test("未注入 createBridge → 结构化退出（exitCode 2），绝不静默", async () => {
		const result = await runAcpCommand({});
		expect(result.exitCode).toBe(2);
		expect(result.reason).toContain("桥接面工厂未装配");
	});

	test("工厂注入：stdio 通道与 agent 透传，start→done→stop 次序，exit 0", async () => {
		const bridge = fakeBridge();
		bridge.done = Promise.resolve();
		let received: unknown;
		const agent = { prompt: async () => ({ stopReason: "end_turn" }) };
		const input = new ReadableStream<Uint8Array>({ start() {} });
		const output = { write: () => undefined };
		const result = await runAcpCommand({
			input,
			output,
			agent,
			createBridge: (channels) => {
				received = channels;
				return bridge;
			},
		});
		expect(result).toEqual({ exitCode: 0 });
		expect(bridge.calls).toEqual(["start", "stop"]);
		expect(received).toMatchObject({ input, output, agent });
	});

	test("桥接面 start 抛错 → exitCode 2 且 reason 携带 启动失败", async () => {
		const result = await runAcpCommand({
			createBridge: () => ({
				start: async () => {
					throw new Error("stdin 不可用");
				},
				stop: async () => undefined,
			}),
		});
		expect(result.exitCode).toBe(2);
		expect(result.reason).toContain("启动失败");
		expect(result.reason).toContain("stdin 不可用");
	});

	test("无 done 信号时经 onSignal 收尾：handler 注入 → 信号触发 → stop → exit 0", async () => {
		const bridge = fakeBridge();
		let signalHandler: (() => void) | undefined;
		const pending = runAcpCommand({
			createBridge: () => bridge,
			onSignal: (handler) => {
				signalHandler = handler;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 10)); // 等 start 与 handler 注册
		expect(typeof signalHandler).toBe("function");
		signalHandler!(); // 模拟 SIGINT
		const result = await pending;
		expect(result).toEqual({ exitCode: 0 });
		expect(bridge.calls).toEqual(["start", "stop"]);
	});

	test("命令名常量供装配方注册", () => {
		expect(ACP_COMMAND_NAME).toBe("acp");
	});
});
