import { describe, expect, test } from "bun:test";
import type { JsonRpcMessage } from "../protocol";
import { jsonRpcError, jsonRpcNotification, jsonRpcResponse } from "../protocol";
import {
	LspError,
	LspFrameReader,
	LspStdioTransport,
	encodeLspFrame,
	type LspCloseEvent,
} from "./lsp-stdio-transport";

// ---------- 测试基建 ----------

function expectLspError(promise: Promise<unknown>, code: LspError["code"]): Promise<LspError> {
	return promise.then(
		() => {
			throw new Error(`期望 LspError(${code})，但成功返回`);
		},
		(error: unknown) => {
			if (!(error instanceof LspError)) {
				throw error;
			}
			expect(error.code).toBe(code);
			return error;
		},
	);
}

/** 注入流模式的双端桩：模拟 LSP 服务器侧（帧协议解析 + 脚本化应答）。 */
class ScriptedLspServer {
	readonly toClient: ReadableStream<Uint8Array>;
	private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	private readonly frameReader = new LspFrameReader();
	readonly received: JsonRpcMessage[] = [];
	handlers: Record<string, (params: unknown) => unknown> = {};
	/** 静默方法（不应答，测超时）。 */
	readonly silent = new Set<string>();

	constructor() {
		this.toClient = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.controller = controller;
			},
		});
	}

	/** 传输层的 output 注入点。 */
	readonly sink = {
		write: (chunk: Uint8Array): void => {
			const { frames } = this.frameReader.push(chunk);
			for (const frame of frames) {
				const message = JSON.parse(frame) as JsonRpcMessage;
				this.received.push(message);
				this.dispatch(message);
			}
		},
	};

	pushToClient(message: JsonRpcMessage): void {
		this.enqueueOrThrow(encodeLspFrame(JSON.stringify(message)));
	}

	/** 推送任意原始帧字节（畸形 payload 测试用）。 */
	pushRaw(bytes: Uint8Array): void {
		this.enqueueOrThrow(bytes);
	}

	private enqueueOrThrow(bytes: Uint8Array): void {
		const controller = this.controller;
		if (controller === null) {
			throw new Error("服务器流未初始化");
		}
		controller.enqueue(bytes);
	}

	private dispatch(message: JsonRpcMessage): void {
		if ("method" in message && "id" in message) {
			if (this.silent.has(message.method)) {
				return;
			}
			const handler = this.handlers[message.method];
			if (handler !== undefined) {
				this.pushToClient(jsonRpcResponse(message.id, handler(message.params)));
			} else {
				this.pushToClient(jsonRpcError(message.id, -32601, `no handler: ${message.method}`));
			}
		}
	}
}

async function connectedPair(
	handlers: Record<string, (params: unknown) => unknown> = {},
): Promise<{ server: ScriptedLspServer; transport: LspStdioTransport }> {
	const server = new ScriptedLspServer();
	server.handlers = { initialize: () => ({ capabilities: {}, serverInfo: { name: "stub" } }), ...handlers };
	const transport = new LspStdioTransport({
		input: server.toClient,
		output: server.sink,
		requestTimeoutMs: 500,
	});
	await transport.start();
	return { server, transport };
}

// ---------- 帧协议（纯读写） ----------

describe("LSP 帧协议", () => {
	test("encodeLspFrame：Content-Length 头帧格式精确（区别于 MCP 换行分帧）", () => {
		const frame = encodeLspFrame("hi");
		expect(Buffer.from(frame).toString("utf8")).toBe("Content-Length: 2\r\n\r\nhi");
	});

	test("encodeLspFrame：Content-Length 按 UTF-8 字节计（多字节中文）", () => {
		const payload = JSON.stringify({ jsonrpc: "2.0", method: "x", params: { text: "中文内容" } });
		const frame = encodeLspFrame(payload);
		const text = Buffer.from(frame).toString("utf8");
		expect(text.startsWith(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n`)).toBe(true);
		// 字节数与字符数不同，证明按字节计
		expect(Buffer.byteLength(payload)).toBeGreaterThan(payload.length);
	});

	test("帧读取往返：单帧完整 push", () => {
		const reader = new LspFrameReader();
		const { frames, malformed } = reader.push(encodeLspFrame('{"jsonrpc":"2.0","method":"a"}'));
		expect(frames.length).toBe(1);
		expect(malformed).toBe(0);
		expect(JSON.parse(frames[0] ?? "{}")).toEqual({ jsonrpc: "2.0", method: "a" });
	});

	test("粘包：两帧一次 push，按序拆解", () => {
		const a = encodeLspFrame('{"jsonrpc":"2.0","method":"a"}');
		const b = encodeLspFrame('{"jsonrpc":"2.0","method":"b"}');
		const joined = new Uint8Array(a.byteLength + b.byteLength);
		joined.set(a, 0);
		joined.set(b, a.byteLength);
		const { frames, malformed } = new LspFrameReader().push(joined);
		expect(malformed).toBe(0);
		expect(frames.length).toBe(2);
		expect((JSON.parse(frames[0] ?? "{}") as { method?: string }).method).toBe("a");
		expect((JSON.parse(frames[1] ?? "{}") as { method?: string }).method).toBe("b");
	});

	test("半包：逐字节喂入，最终完整拼出两帧", () => {
		const a = encodeLspFrame('{"jsonrpc":"2.0","method":"a"}');
		const b = encodeLspFrame('{"jsonrpc":"2.0","method":"b"}');
		const joined = new Uint8Array(a.byteLength + b.byteLength);
		joined.set(a, 0);
		joined.set(b, a.byteLength);
		const reader = new LspFrameReader();
		const collected: string[] = [];
		for (let index = 0; index < joined.byteLength; index++) {
			collected.push(...reader.push(joined.subarray(index, index + 1)).frames);
		}
		expect(collected.length).toBe(2);
		expect((JSON.parse(collected[0] ?? "{}") as { method?: string }).method).toBe("a");
		expect((JSON.parse(collected[1] ?? "{}") as { method?: string }).method).toBe("b");
	});

	test("Content-Type 头兼容：附加头不破坏解析", () => {
		const payload = '{"jsonrpc":"2.0","method":"m"}';
		const raw = `Content-Length: ${Buffer.byteLength(payload)}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${payload}`;
		const { frames, malformed } = new LspFrameReader().push(new TextEncoder().encode(raw));
		expect(malformed).toBe(0);
		expect(frames).toEqual([payload]);
	});

	test("畸形头（缺 Content-Length）：跳过并计数，后续帧不受影响", () => {
		const reader = new LspFrameReader();
		const bad = reader.push(new TextEncoder().encode("X-Weird: 1\r\n\r\n"));
		expect(bad.frames.length).toBe(0);
		expect(bad.malformed).toBe(1);
		const good = reader.push(encodeLspFrame('{"jsonrpc":"2.0","method":"ok"}'));
		expect(good.frames.length).toBe(1);
		expect(good.malformed).toBe(0);
	});

	test("半截头（无终止符）：不产帧也不计畸形", () => {
		const { frames, malformed } = new LspFrameReader().push(new TextEncoder().encode("Content-Len"));
		expect(frames.length).toBe(0);
		expect(malformed).toBe(0);
	});
});

// ---------- 传输层（注入流模式） ----------

describe("LspStdioTransport（注入流）", () => {
	test("send：服务器收到完整 JSON-RPC 消息", async () => {
		const { server, transport } = await connectedPair();
		await transport.notify("initialized", {});
		const last = server.received[server.received.length - 1];
		expect(last && "method" in last ? last.method : undefined).toBe("initialized");
		await transport.close();
	});

	test("request/response 关联：initialize 往返", async () => {
		const { server, transport } = await connectedPair();
		const result = (await transport.request("initialize", { capabilities: {} })) as {
			serverInfo?: { name?: string };
		};
		expect(result.serverInfo?.name).toBe("stub");
		const request = server.received[0];
		expect(request && "id" in request ? typeof request.id : undefined).toBe("number");
		await transport.close();
	});

	test("并发请求按 id 关联，乱序响应各归其主", async () => {
		const { server, transport } = await connectedPair();
		server.silent.add("slow/method"); // 关闭自动应答，由测试手动乱序回包
		server.silent.add("fast/method");
		const slow = transport.request("slow/method", undefined);
		const fast = transport.request("fast/method", undefined);
		await Bun.sleep(10); // 等两个请求出站
		const ids = server.received
			.filter((message) => "method" in message)
			.map((message) => ("id" in message ? message.id : -1));
		expect(ids.length).toBe(2);
		// 先回第二个请求
		server.pushToClient(jsonRpcResponse(ids[1] ?? 0, "B"));
		server.pushToClient(jsonRpcResponse(ids[0] ?? 0, "A"));
		expect(await fast).toBe("B");
		expect(await slow).toBe("A");
		await transport.close();
	});

	test("超时：结构化 timeout 错误携带 method/id/timeoutMs", async () => {
		const { server, transport } = await connectedPair();
		server.silent.add("silent/method");
		const error = await expectLspError(transport.request("silent/method", undefined), "timeout");
		const data = error.data as { method: string; id: number; timeoutMs: number };
		expect(data.method).toBe("silent/method");
		expect(data.timeoutMs).toBe(500);
		expect(typeof data.id).toBe("number");
		await transport.close();
	});

	test("rpc-error 响应：结构化拒绝并透传 rpcCode", async () => {
		const { transport } = await connectedPair();
		const error = await expectLspError(transport.request("missing/method", undefined), "rpc-error");
		expect((error.data as { rpcCode?: number }).rpcCode).toBe(-32601);
		await transport.close();
	});

	test("通知送达 onMessage；本端请求的响应不投递", async () => {
		const { server, transport } = await connectedPair();
		const seen: JsonRpcMessage[] = [];
		transport.onMessage((message) => seen.push(message));
		server.pushToClient(jsonRpcNotification("textDocument/publishDiagnostics", { uri: "file:///x" }));
		await Bun.sleep(10);
		await transport.request("initialize", undefined); // 响应不进 onMessage
		expect(seen.length).toBe(1);
		expect(seen[0] && "method" in seen[0] ? seen[0].method : undefined).toBe("textDocument/publishDiagnostics");
		await transport.close();
	});

	test("服务器→客户端请求：未注册处理器时自动 MethodNotFound", async () => {
		const { server, transport } = await connectedPair();
		server.pushToClient({
			jsonrpc: "2.0",
			id: 99,
			method: "workspace/configuration",
			params: {},
		} as JsonRpcMessage);
		await Bun.sleep(10);
		const replies = server.received.filter((message) => !("method" in message));
		const last = replies[replies.length - 1];
		expect(last && "error" in last ? last.error.code : undefined).toBe(-32601);
		expect(last && "id" in last ? last.id : undefined).toBe(99);
		await transport.close();
	});

	test("服务器→客户端请求：onServerRequest 返回值作为成功响应", async () => {
		const { server, transport } = await connectedPair();
		transport.onServerRequest(async (request) =>
			request.method === "workspace/configuration" ? [{ section: null }] : undefined,
		);
		server.pushToClient({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: {} } as JsonRpcMessage);
		await Bun.sleep(10);
		const replies = server.received.filter((message) => !("method" in message));
		const last = replies[replies.length - 1];
		expect(last && "result" in last ? last.result : undefined).toEqual([{ section: null }]);
		await transport.close();
	});

	test("非法 JSON payload：malformed 计数，会话存活", async () => {
		const { server, transport } = await connectedPair();
		server.pushRaw(encodeLspFrame("this is not json"));
		await Bun.sleep(10);
		expect(transport.getMalformedCount()).toBe(1);
		await transport.request("initialize", undefined); // 会话仍可用
		expect(transport.getMalformedCount()).toBe(1);
		await transport.close();
	});

	test("close 幂等：终态事件只投递一次，未决请求以 transport-closed 拒绝", async () => {
		const { server, transport } = await connectedPair();
		server.silent.add("pending/method");
		const pending = transport.request("pending/method", undefined);
		const events: LspCloseEvent[] = [];
		transport.onClose((event) => events.push(event));
		await expectLspError(transport.close().then(() => pending), "transport-closed");
		await transport.close();
		expect(events.length).toBe(1);
		expect(events[0]?.code).toBe("closed");
	});

	test("start 后 send 前置校验：close 后 send → not-connected", async () => {
		const { transport } = await connectedPair();
		await transport.close();
		await expectLspError(transport.notify("ping"), "not-connected");
		await expectLspError(transport.request("ping"), "not-connected");
	});
});

// ---------- 传输层（真实子进程 spawn） ----------

const fixturePath = `${import.meta.dir}/fixtures/mock-lsp-server.ts`;

describe("LspStdioTransport（真实子进程）", () => {
	test("spawn 夹具服务器：initialize/definition 端到端头帧往返", async () => {
		const transport = new LspStdioTransport({
			command: process.execPath,
			args: [fixturePath],
			requestTimeoutMs: 5000,
		});
		await transport.start();
		expect(typeof transport.pid).toBe("number");
		const initialize = (await transport.request("initialize", { capabilities: {} })) as {
			serverInfo?: { name?: string };
		};
		expect(initialize.serverInfo?.name).toBe("mock-lsp");
		const definition = (await transport.request("textDocument/definition", {
			textDocument: { uri: "file:///tmp/mock-main.ts" },
			position: { line: 3, character: 7 },
		})) as { uri?: string };
		expect(definition.uri).toBe("file:///tmp/mock-main.ts");
		const events: LspCloseEvent[] = [];
		transport.onClose((event) => events.push(event));
		await transport.close();
		expect(events.length).toBe(1);
		expect(events[0]?.code).toBe("closed");
	}, 15000);

	test("spawn 失败：start() 以 server-missing 拒绝", async () => {
		const transport = new LspStdioTransport({ command: "/nonexistent-lsp-binary-xyz" });
		const error = await expectLspError(transport.start(), "server-missing");
		expect(error.message).toContain("/nonexistent-lsp-binary-xyz");
	});

	test("start 重复调用：invalid-state", async () => {
		const { transport } = await connectedPair();
		await expectLspError(transport.start(), "invalid-state");
		await transport.close();
	});
});
