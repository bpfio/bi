/**
 * BI-20.6 —— ACP 桥接面测试：头帧往返 / initialize 握手 / prompt→tool 事件流 /
 * KAP 透传 / 错误形态 / 会话状态机。
 */
import { describe, expect, test } from "bun:test";
import { LspFrameReader, encodeLspFrame } from "../lsp/lsp-stdio-transport";
import {
	AcpBridge,
	AcpErrorCode,
	extractKap,
	type AcpAgentPort,
	type AcpPromptContext,
	type AcpSessionUpdate,
} from "./acp-bridge";

// ---------- 测试脚手架 ----------

/** 输出接收器：收集帧字节，断言时整体解码。 */
class FrameSink {
	readonly chunks: Uint8Array[] = [];

	write(chunk: Uint8Array): void {
		this.chunks.push(chunk);
	}

	/** 解码已收到的全部帧（按落盘序）。 */
	decode(): Array<Record<string, unknown>> {
		const reader = new LspFrameReader();
		let all = new Uint8Array(0);
		for (const chunk of this.chunks) {
			const merged = new Uint8Array(all.byteLength + chunk.byteLength);
			merged.set(all, 0);
			merged.set(chunk, all.byteLength);
			all = merged;
		}
		const { frames } = reader.push(all);
		return frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
	}

	/** 便捷取最后一条。 */
	last(): Record<string, unknown> {
		const messages = this.decode();
		expect(messages.length).toBeGreaterThan(0);
		return messages[messages.length - 1]!;
	}
}

function request(id: number, method: string, params?: unknown): Record<string, unknown> {
	return params === undefined
		? { jsonrpc: "2.0", id, method }
		: { jsonrpc: "2.0", id, method, params };
}

/** 伪造 agent 端口：记录调用，按脚本执行。 */
function fakePort(
	body?: (input: { text: string }, ctx: AcpPromptContext) => Promise<{ stopReason: string }>,
): AcpAgentPort & { inputs: Array<{ text: string; blocks: readonly unknown[] }> } {
	const inputs: Array<{ text: string; blocks: readonly unknown[] }> = [];
	return {
		inputs,
		async prompt(input, ctx) {
			inputs.push({ text: input.text, blocks: input.blocks });
			if (body === undefined) {
				return { stopReason: "end_turn" };
			}
			return body(input, ctx);
		},
	};
}

/** 建立「已 initialize」的桥接面（绝大多数用例的前置）。 */
async function makeReadyBridge(
	agent?: AcpAgentPort,
): Promise<{ bridge: AcpBridge; sink: FrameSink }> {
	const sink = new FrameSink();
	const bridge = new AcpBridge({ output: sink, agent });
	await bridge.handleMessage(request(1, "initialize", { protocolVersion: 1 }) as never);
	return { bridge, sink };
}

// ---------- 头帧协议 ----------

describe("头帧协议", () => {
	test("initialize 请求经头帧编码→pushBytes→响应解码完整往返", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		await bridge.pushBytes(encodeLspFrame(JSON.stringify(request(7, "initialize", { protocolVersion: 1 }))));
		const messages = sink.decode();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: expect.objectContaining({ protocolVersion: 1 }),
		});
	});

	test("多字节 UTF-8 payload 头帧往返不切坏（Content-Length 按字节计）", async () => {
		const sink = new FrameSink();
		const port = fakePort();
		const bridge = new AcpBridge({ output: sink, agent: port });
		await bridge.handleMessage(request(1, "initialize") as never);
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		// 经 pushBytes 走字节层：prompt 文本含多字节字符
		await bridge.pushBytes(
			encodeLspFrame(
				JSON.stringify(
					request(3, "session/prompt", {
						sessionId,
						content: [{ type: "text", text: "你好 🌊—世界" }],
					}),
				),
			),
		);
		expect(sink.last()["result"]).toEqual({ stopReason: "end_turn" });
		expect(port.inputs[0]!.text).toBe("你好 🌊—世界");
	});

	test("半包：帧字节跨两次 push 自动拼装", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		const frame = encodeLspFrame(JSON.stringify(request(9, "initialize")));
		await bridge.pushBytes(frame.slice(0, 5));
		expect(sink.decode()).toHaveLength(0); // 头部未完整
		await bridge.pushBytes(frame.slice(5, 20));
		expect(sink.decode()).toHaveLength(0); // payload 未到齐
		await bridge.pushBytes(frame.slice(20));
		expect(sink.decode()).toHaveLength(1);
	});

	test("粘包：一次 push 多帧全部拆解且按序响应", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		const f1 = encodeLspFrame(JSON.stringify(request(1, "initialize")));
		const f2 = encodeLspFrame(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
		const merged = new Uint8Array(f1.byteLength + f2.byteLength);
		merged.set(f1, 0);
		merged.set(f2, f1.byteLength);
		await bridge.pushBytes(merged);
		const messages = sink.decode();
		expect(messages).toHaveLength(1); // 通知无回执，仅 initialize 响应
		expect(messages[0]!["id"]).toBe(1);
	});

	test("畸形帧（缺 Content-Length 头）跳过并计数，不阻断后续帧", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		const good = encodeLspFrame(JSON.stringify(request(2, "initialize")));
		const bad = new TextEncoder().encode("X-Garbage: 1\r\n\r\n"); // 尾部畸形头
		await bridge.pushBytes(good);
		await bridge.pushBytes(bad);
		expect(bridge.getMalformedCount()).toBe(1);
		expect(sink.decode()).toHaveLength(1);
		expect(sink.decode()[0]!["id"]).toBe(2);
	});
});

// ---------- initialize 握手 ----------

describe("initialize 握手", () => {
	test("回执 protocolVersion/agentInfo/agentCapabilities/authMethods", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink, agentName: "bi-test" });
		await bridge.handleMessage(request(1, "initialize", { protocolVersion: 99 }) as never);
		const result = sink.last()["result"] as Record<string, unknown>;
		expect(result["protocolVersion"]).toBe(1); // 以本端支持版本回应
		expect(result["agentInfo"]).toEqual({ name: "bi-test", version: "0.1.0" });
		expect(result["agentCapabilities"]).toEqual({
			loadSession: false,
			promptCapabilities: { audio: false, embeddedContext: false, image: false },
		});
		expect(result["authMethods"]).toEqual([]);
	});

	test("initialize 之前的会话方法被拒绝（-32002 NotInitialized）", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		await bridge.handleMessage(request(1, "session/new") as never);
		const error = sink.last()["error"] as { code: number };
		expect(error.code).toBe(AcpErrorCode.NotInitialized);
		expect(error.code).toBe(-32002);
	});
});

// ---------- 会话状态机 ----------

describe("会话状态机", () => {
	test("session/new 回唯一 sessionId，会话入册", async () => {
		const { bridge, sink } = await makeReadyBridge();
		await bridge.handleMessage(request(2, "session/new", { cwd: "/tmp" }) as never);
		await bridge.handleMessage(request(3, "session/new") as never);
		const [first, second] = sink.decode().slice(1) as Array<{ result: { sessionId: string } }>;
		expect(typeof first!.result.sessionId).toBe("string");
		expect(first!.result.sessionId).not.toBe(second!.result.sessionId);
		expect(bridge.getSessionIds()).toHaveLength(2);
	});

	test("未知 sessionId 的 prompt → -32003 SessionNotFound", async () => {
		const { bridge, sink } = await makeReadyBridge(fakePort());
		await bridge.handleMessage(
			request(2, "session/prompt", { sessionId: "ses_missing", content: [] }) as never,
		);
		const error = sink.last()["error"] as { code: number; data?: { sessionId?: string } };
		expect(error.code).toBe(AcpErrorCode.SessionNotFound);
		expect((error.data as { sessionId?: string } | undefined)?.sessionId).toBe("ses_missing");
	});

	test("prompt 缺 sessionId → -32602 InvalidParams；content 非数组同理", async () => {
		const { bridge, sink } = await makeReadyBridge(fakePort());
		await bridge.handleMessage(request(2, "session/prompt", { content: [] }) as never);
		expect((sink.last()["error"] as { code: number }).code).toBe(-32602);
		await bridge.handleMessage(
			request(3, "session/prompt", { sessionId: bridge.getSessionIds()[0], content: "nope" }) as never,
		);
		expect((sink.last()["error"] as { code: number }).code).toBe(-32602);
	});

	test("单会话单飞：在飞期间二次 prompt → -32004 PromptBusy，结束后恢复", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { bridge, sink } = await makeReadyBridge(
			fakePort(async () => {
				await gate;
				return { stopReason: "end_turn" };
			}),
		);
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		const first = bridge.handleMessage(
			request(3, "session/prompt", { sessionId, content: [{ type: "text", text: "a" }] }) as never,
		);
		await bridge.handleMessage(
			request(4, "session/prompt", { sessionId, content: [] }) as never,
		);
		expect((sink.last()["error"] as { code: number }).code).toBe(AcpErrorCode.PromptBusy);
		release!();
		await first;
		expect((sink.last()["result"] as { stopReason: string }).stopReason).toBe("end_turn");
		// 结束后同会话可再次 prompt
		await bridge.handleMessage(
			request(5, "session/prompt", { sessionId, content: [] }) as never,
		);
		expect((sink.last()["result"] as { stopReason: string }).stopReason).toBe("end_turn");
	});
});

// ---------- prompt→tool 事件流 ----------

describe("prompt→tool 事件流", () => {
	test("tool_call → tool_call_update → 响应按落盘序回执", async () => {
		const { bridge, sink } = await makeReadyBridge(
			fakePort(async (_input, ctx) => {
				ctx.emit({
					sessionUpdate: "tool_call",
					toolCallId: "t1",
					title: "read_file",
					status: "in_progress",
					rawInput: { path: "/a" },
				});
				ctx.emit({
					sessionUpdate: "tool_call_update",
					toolCallId: "t1",
					status: "completed",
					output: "contents",
				});
				return { stopReason: "end_turn" };
			}),
		);
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		await bridge.handleMessage(
			request(3, "session/prompt", { sessionId, content: [{ type: "text", text: "读文件" }] }) as never,
		);
		const messages = sink.decode();
		expect(messages).toHaveLength(5); // init 响应 + new 响应 + tool_call + tool_call_update + prompt 响应
		const updates = messages.filter((m) => m["method"] === "session/update");
		expect(updates).toHaveLength(2);
		const [toolCall, toolUpdate] = updates as Array<{ params: { sessionId: string; update: Record<string, unknown> } }>;
		expect(toolCall!.params.update["sessionUpdate"]).toBe("tool_call");
		expect(toolCall!.params.update).toMatchObject({ toolCallId: "t1", title: "read_file", status: "in_progress" });
		expect(toolCall!.params.sessionId).toBe(sessionId);
		expect(toolUpdate!.params.update["sessionUpdate"]).toBe("tool_call_update");
		expect(toolUpdate!.params.update).toMatchObject({ toolCallId: "t1", status: "completed", output: "contents" });
		// 响应最后落盘
		const final = messages[messages.length - 1]!;
		expect(final["result"]).toEqual({ stopReason: "end_turn" });
		expect(final["id"]).toBe(3);
		// 通知先于响应
		expect(messages.indexOf(updates[0]!)).toBeLessThan(messages.indexOf(final));
	});

	test("思考流与消息块透传（agent_thought_chunk / agent_message_chunk）", async () => {
		const { bridge, sink } = await makeReadyBridge(
			fakePort(async (_input, ctx) => {
				ctx.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "想想…" } });
				ctx.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "答复" } });
				return { stopReason: "end_turn" };
			}),
		);
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		await bridge.handleMessage(request(3, "session/prompt", { sessionId, content: [] }) as never);
		const updates = sink
			.decode()
			.filter((m) => m["method"] === "session/update")
			.map((m) => (m["params"] as { update: Record<string, unknown> }).update);
		expect(updates).toHaveLength(2);
		expect(updates[0]).toEqual({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "想想…" },
		});
		expect(updates[1]).toEqual({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "答复" },
		});
	});

	test("prompt 输入抽取纯文本并连同原始块投递端口", async () => {
		const { bridge, sink } = await makeReadyBridge(fakePort());
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		const blocks = [
			{ type: "text", text: "第一段" },
			{ type: "image", data: " ignored " },
			{ type: "text", text: "第二段" },
		];
		await bridge.handleMessage(request(3, "session/prompt", { sessionId, content: blocks }) as never);
		const port = bridge["agent"] as unknown as { inputs: Array<{ text: string; blocks: readonly unknown[] }> };
		expect(port.inputs[0]!.text).toBe("第一段第二段");
		expect(port.inputs[0]!.blocks).toEqual(blocks);
	});

	test("兼容别名 agent/prompt 与 session/prompt 同语义", async () => {
		const { bridge, sink } = await makeReadyBridge(fakePort());
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		await bridge.handleMessage(
			request(3, "agent/prompt", { sessionId, content: [{ type: "text", text: "别名" }] }) as never,
		);
		expect((sink.last()["result"] as { stopReason: string }).stopReason).toBe("end_turn");
		const port = bridge["agent"] as unknown as { inputs: Array<{ text: string }> };
		expect(port.inputs[0]!.text).toBe("别名");
	});

	test("agent 端口缺省时 prompt → -32005 AgentPortMissing", async () => {
		const { bridge, sink } = await makeReadyBridge();
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		await bridge.handleMessage(request(3, "session/prompt", { sessionId, content: [] }) as never);
		expect((sink.last()["error"] as { code: number }).code).toBe(AcpErrorCode.AgentPortMissing);
	});

	test("agent 端口抛错 → -32006 PromptFailed（错误消息携带原因）", async () => {
		const { bridge, sink } = await makeReadyBridge(
			fakePort(async () => {
				throw new Error("装配失败");
			}),
		);
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		await bridge.handleMessage(request(3, "session/prompt", { sessionId, content: [] }) as never);
		const error = sink.last()["error"] as { code: number; message: string };
		expect(error.code).toBe(AcpErrorCode.PromptFailed);
		expect(error.message).toContain("装配失败");
	});

	test("桥接面 stop() 触发在飞 prompt 的 abort 信号（停机后未决响应被丢弃）", async () => {
		let observeAbort!: (aborted: boolean) => void;
		const abortPromise = new Promise<boolean>((resolve) => {
			observeAbort = resolve;
		});
		const { bridge, sink } = await makeReadyBridge(
			fakePort(async (_input, ctx) => {
				await new Promise<void>((resolveWait) => {
					ctx.signal.addEventListener("abort", () => resolveWait(), { once: true });
				});
				observeAbort(ctx.signal.aborted);
				return { stopReason: "cancelled" };
			}),
		);
		await bridge.handleMessage(request(2, "session/new") as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		const inflight = bridge.handleMessage(
			request(3, "session/prompt", { sessionId, content: [] }) as never,
		);
		await bridge.stop();
		expect(await abortPromise).toBe(true);
		await inflight; // 停机后的响应发送失败在 handleRequest 内部吞掉，不向外抛
		// 停机后未决 prompt 响应被丢弃：sink 停留在 session/new 响应
		const last = sink.last();
		expect(last["id"]).toBe(2);
		expect("stopReason" in (last["result"] as object)).toBe(false);
		await bridge.stop(); // 幂等
	});
});

// ---------- KAP 头协议兼容 ----------

describe("KAP 头协议兼容（payload.kap 透传）", () => {
	test("顶层 payload.kap 在响应信封原样回显，connectionKap 可观测", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		const message = request(1, "initialize", { protocolVersion: 1 });
		message["kap"] = { version: "kap-0", tenant: "acme" };
		await bridge.handleMessage(message as never);
		const response = sink.last();
		expect(response["kap"]).toEqual({ version: "kap-0", tenant: "acme" });
		expect(bridge.kap).toEqual({ version: "kap-0", tenant: "acme" });
	});

	test("params.kap 作为次选透传（顶层缺失时）", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		await bridge.handleMessage(
			request(1, "initialize", { protocolVersion: 1, kap: { trace: "t-1" } }) as never,
		);
		expect(sink.last()["kap"]).toEqual({ trace: "t-1" });
	});

	test("session/new 捕获会话级 kap，随 session/update 通知透出", async () => {
		const { bridge, sink } = await makeReadyBridge(
			fakePort(async (_input, ctx) => {
				ctx.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
				return { stopReason: "end_turn" };
			}),
		);
		await bridge.handleMessage(request(2, "session/new", { kap: { route: "r-7" } }) as never);
		const sessionId = (sink.decode()[1]!.result as { sessionId: string }).sessionId;
		await bridge.handleMessage(request(3, "session/prompt", { sessionId, content: [] }) as never);
		const updates = sink.decode().filter((m) => m["method"] === "session/update");
		expect(updates).toHaveLength(1);
		expect(updates[0]!["kap"]).toEqual({ route: "r-7" });
	});

	test("无 kap 的流量响应不含 kap 字段（零影响）", async () => {
		const { bridge, sink } = await makeReadyBridge();
		await bridge.handleMessage(request(2, "session/new") as never);
		expect("kap" in sink.last()).toBe(false);
	});

	test("extractKap 纯函数：顶层优先、params 次选、缺失 undefined", () => {
		expect(extractKap({ kap: { a: 1 }, params: { kap: { b: 2 } } })).toEqual({ a: 1 });
		expect(extractKap({ params: { kap: { b: 2 } } })).toEqual({ b: 2 });
		expect(extractKap({ params: {} })).toBeUndefined();
		expect(extractKap(null)).toBeUndefined();
	});
});

// ---------- 错误形态 ----------

describe("错误形态", () => {
	test("非 JSON payload → ParseError（id=null）且计入畸形", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		await bridge.pushBytes(encodeLspFrame("{not-json"));
		const error = sink.last()["error"] as { code: number };
		expect(error.code).toBe(-32700);
		expect(sink.last()["id"]).toBeNull();
		expect(bridge.getMalformedCount()).toBe(1);
	});

	test("结构非法（合法 JSON 但非 JSON-RPC）→ InvalidRequest（id=null）", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		await bridge.pushBytes(encodeLspFrame(JSON.stringify({ hello: 1 })));
		expect((sink.last()["error"] as { code: number }).code).toBe(-32600);
		expect(bridge.getMalformedCount()).toBe(1);
	});

	test("未知方法请求 → -32601 MethodNotFound（data 携带 method）", async () => {
		const sink = new FrameSink();
		const bridge = new AcpBridge({ output: sink });
		await bridge.handleMessage(request(1, "no/such/method", { x: 1 }) as never);
		const error = sink.last()["error"] as { code: number; data?: { method?: string } };
		expect(error.code).toBe(-32601);
		expect((error.data as { method?: string } | undefined)?.method).toBe("no/such/method");
	});

	test("未知通知静默无回执；客户端 initialized 通知同样不回执", async () => {
		const { bridge, sink } = await makeReadyBridge();
		const before = sink.decode().length;
		await bridge.handleMessage({ jsonrpc: "2.0", method: "initialized" } as never);
		await bridge.handleMessage({ jsonrpc: "2.0", method: "whatever/notify" } as never);
		expect(sink.decode()).toHaveLength(before);
	});

	test("stop() 后再发送 → 结构化 InvalidRequest，不静默", async () => {
		const { bridge } = await makeReadyBridge();
		await bridge.stop();
		await expect(bridge.notifySessionUpdate("ses_x", {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "x" },
		} as AcpSessionUpdate)).rejects.toMatchObject({ code: -32600 });
		await bridge.stop(); // 幂等
	});
});
