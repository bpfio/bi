import { afterEach, describe, expect, test } from "bun:test";
import type { JsonRpcMessage } from "../protocol";
import { McpError, jsonRpcRequest } from "../protocol";
import { McpClient } from "../client";
import { SseClientTransport, SseFrameParser } from "./sse";

describe("SSE 帧解析器（单测矩阵）", () => {
	test("基础 event/data 帧", () => {
		const parser = new SseFrameParser();
		expect(parser.push("event: greeting\ndata: hello\n\n")).toEqual([
			{ event: "greeting", data: "hello" },
		]);
	});

	test("缺省事件名为 message", () => {
		const parser = new SseFrameParser();
		expect(parser.push("data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
	});

	test("多行 data 按 \\n 拼接", () => {
		const parser = new SseFrameParser();
		expect(parser.push("data: line1\ndata: line2\ndata: line3\n\n")).toEqual([
			{ event: "message", data: "line1\nline2\nline3" },
		]);
	});

	test("注释行忽略且不产生帧", () => {
		const parser = new SseFrameParser();
		expect(parser.push(": keep-alive\n\n")).toEqual([]);
		expect(parser.push(": ping\ndata: after-comment\n\n")).toEqual([
			{ event: "message", data: "after-comment" },
		]);
	});

	test("CRLF 行尾容忍", () => {
		const parser = new SseFrameParser();
		expect(parser.push("event: e\r\ndata: 1\r\n\r\n")).toEqual([{ event: "e", data: "1" }]);
	});

	test("裸 CR 行尾容忍", () => {
		const parser = new SseFrameParser();
		expect(parser.push("data: 1\r\rdata: 2\n\n")).toEqual([
			{ event: "message", data: "1" },
			{ event: "message", data: "2" },
		]);
	});

	test("retry 字段解析为毫秒数", () => {
		const parser = new SseFrameParser();
		expect(parser.push("retry: 250\ndata: x\n\n")).toEqual([
			{ event: "message", data: "x", retryMs: 250 },
		]);
	});

	test("id 字段进入帧并更新 last-event-id", () => {
		const parser = new SseFrameParser();
		const frames = parser.push("id: 42\ndata: x\n\n");
		expect(frames[0]?.id).toBe("42");
		expect(parser.getLastEventId()).toBe("42");
	});

	test("冒号后无空格容错", () => {
		const parser = new SseFrameParser();
		expect(parser.push("data:x\nid:9\n\n")).toEqual([
			{ event: "message", data: "x", id: "9" },
		]);
	});

	test("跨切块边界缓冲", () => {
		const parser = new SseFrameParser();
		expect(parser.push('data: {"a"')).toEqual([]);
		expect(parser.push(":1}")).toEqual([]);
		expect(parser.push("\n")).toEqual([]);
		expect(parser.push("\n")).toEqual([{ event: "message", data: '{"a":1}' }]);
	});

	test("flush 派发未以空行收尾的残帧", () => {
		const parser = new SseFrameParser();
		expect(parser.push("data: tail")).toEqual([]);
		expect(parser.flush()).toEqual([{ event: "message", data: "tail" }]);
	});

	test("未知字段按规范忽略", () => {
		const parser = new SseFrameParser();
		expect(parser.push("foo: bar\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
	});
});

/** 本地 SSE fixture 服务器集合，测试结束统一关闭。 */
const servers: Array<{ stop: () => void }> = [];
const transports: SseClientTransport[] = [];

function makeServer(handler: (req: Request, ctx: { connectionCount: () => number }) => Response | Promise<Response>): {
	url: string;
	connectionCount: () => number;
} {
	let count = 0;
	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === "/stream") {
				count++;
			}
			return handler(req, { connectionCount: () => count });
		},
	});
	servers.push({ stop: () => server.stop(true) });
	return {
		url: `http://127.0.0.1:${server.port}/stream`,
		connectionCount: () => count,
	};
}

afterEach(async () => {
	while (transports.length > 0) {
		const transport = transports.pop();
		if (transport) {
			try {
				await transport.close();
			} catch {
				// 终态实例忽略
			}
		}
	}
	while (servers.length > 0) {
		servers.pop()?.stop();
	}
});

function track(transport: SseClientTransport): SseClientTransport {
	transports.push(transport);
	return transport;
}

async function waitFor(
	condition: () => boolean,
	timeoutMs = 3000,
	stepMs = 10,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor 等待超时");
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}

const encoder = new TextEncoder();

function sseFrame(event: string | null, data: string): Uint8Array {
	return encoder.encode(`${event === null ? "" : `event: ${event}\n`}data: ${data}\n\n`);
}

describe("SSE 传输（本地 Bun.serve 集成）", () => {
	test("endpoint 事件解析 + 出站 POST 到达", async () => {
		const posts: unknown[] = [];
		const { url } = makeServer((req) => {
			const path = new URL(req.url).pathname;
			if (path === "/stream") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(sseFrame("endpoint", "/mcp?sid=abc"));
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			}
			if (path === "/mcp" && req.method === "POST") {
				return req.text().then((body) => {
					posts.push(JSON.parse(body));
					return new Response("accepted", { status: 202 });
				});
			}
			return new Response("nf", { status: 404 });
		});
		const transport = track(new SseClientTransport({ url }));
		await transport.start();
		const message = jsonRpcRequest(1, "ping");
		await transport.send(message);
		expect(posts).toEqual([message]);
	});

	test("显式 endpointUrl 时无需等待 endpoint 事件", async () => {
		const posts: unknown[] = [];
		const { url } = makeServer((req) => {
			const path = new URL(req.url).pathname;
			if (path === "/stream") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(sseFrame(null, "warm-up"));
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			}
			if (path === "/mcp2" && req.method === "POST") {
				return req.text().then((body) => {
					posts.push(JSON.parse(body));
					return new Response("", { status: 202 });
				});
			}
			return new Response("nf", { status: 404 });
		});
		const transport = track(new SseClientTransport({ url, endpointUrl: "/mcp2" }));
		await transport.start();
		await transport.send(jsonRpcRequest("a", "tools/list"));
		expect(posts.length).toBe(1);
	});

	test("入站 JSON-RPC 经 onMessage 交付，畸形 data 计数", async () => {
		const received: JsonRpcMessage[] = [];
		const { url } = makeServer(() => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						sseFrame(null, '{"jsonrpc":"2.0","method":"server/notify","params":{}}'),
					);
					controller.enqueue(sseFrame(null, "definitely-not-json"));
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		});
		const transport = track(new SseClientTransport({ url, endpointUrl: "/mcp" }));
		transport.onMessage((message) => received.push(message));
		await transport.start();
		await waitFor(() => received.length === 1 && transport.getMalformedCount() === 1);
		expect(received.length).toBe(1);
		expect(received[0]?.jsonrpc).toBe("2.0");
		expect(transport.getMalformedCount()).toBe(1);
	});

	test("断线重连：流量后重置退避序列（1x 基数）", async () => {
		const sleeps: number[] = [];
		const { url, connectionCount } = makeServer((req) => {
			const path = new URL(req.url).pathname;
			if (path !== "/stream") {
				return new Response("accepted", { status: 202 });
			}
			const first = connectionCount() === 1;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(sseFrame("endpoint", "/mcp"));
					if (first) {
						// 首条连接：交付数据后立即断开
						controller.close();
					}
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		});
		const transport = track(
			new SseClientTransport({
				url,
				baseBackoffMs: 100,
				maxBackoffMs: 500,
				maxRetries: 5,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		await transport.start();
		await Bun.sleep(30);
		expect(connectionCount()).toBe(2);
		expect(sleeps).toEqual([100]);
		await transport.send(jsonRpcRequest(2, "ping"));
	});

	test("连续失败用尽 maxRetries：connect-failed 终态，退避指数翻倍", async () => {
		const sleeps: number[] = [];
		const closeEvents: string[] = [];
		const { url } = makeServer(() => new Response("boom", { status: 500 }));
		const transport = track(
			new SseClientTransport({
				url,
				baseBackoffMs: 100,
				maxRetries: 2,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		transport.onClose((event) => closeEvents.push(event.code));
		const error = await transport.start().catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(McpError);
		expect((error as McpError).code).toBe("connect-failed");
		expect(sleeps).toEqual([100, 200]);
		expect(closeEvents).toEqual(["connect-failed"]);
	});

	test("retry: 帧提示优先于指数退避", async () => {
		const sleeps: number[] = [];
		const { url, connectionCount } = makeServer((req) => {
			if (new URL(req.url).pathname !== "/stream") {
				return new Response("accepted", { status: 202 });
			}
			const first = connectionCount() === 1;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode("retry: 250\nevent: endpoint\ndata: /mcp\n\n"));
					if (first) {
						controller.close();
					}
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		});
		const transport = track(
			new SseClientTransport({
				url,
				baseBackoffMs: 1000,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			}),
		);
		await transport.start();
		await Bun.sleep(30);
		expect(connectionCount()).toBe(2);
		expect(sleeps).toEqual([250]);
	});

	test("重连请求回传 Last-Event-ID 头", async () => {
		const seenLastEventIds: Array<string | null> = [];
		let receivedNotifications = 0;
		const { url, connectionCount } = makeServer((req) => {
			if (new URL(req.url).pathname !== "/stream") {
				return new Response("accepted", { status: 202 });
			}
			seenLastEventIds.push(req.headers.get("last-event-id"));
			const first = connectionCount() === 1;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						sseFrame(null, '{"jsonrpc":"2.0","method":"server/notify","params":{}}'),
					);
					if (first) {
						controller.enqueue(encoder.encode("id: 42\n\n"));
						controller.close();
					}
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		});
		const transport = track(
			new SseClientTransport({
				url,
				endpointUrl: "/mcp",
				baseBackoffMs: 50,
				sleep: async () => {},
			}),
		);
		transport.onMessage((message) => {
			if ("method" in message) {
				receivedNotifications++;
			}
		});
		await transport.start();
		await waitFor(() => connectionCount() >= 2 && receivedNotifications >= 1);
		expect(connectionCount()).toBe(2);
		expect(seenLastEventIds[0]).toBeNull();
		expect(seenLastEventIds[1]).toBe("42");
	});

	test("外部 AbortSignal 取消：停止重连，close 终态", async () => {
		const abortController = new AbortController();
		const { url, connectionCount } = makeServer(() => new Response("boom", { status: 500 }));
		const transport = track(
			new SseClientTransport({
				url,
				baseBackoffMs: 50,
				maxRetries: 50,
				abortSignal: abortController.signal,
			}),
		);
		const startPromise = transport.start();
		await Bun.sleep(30);
		abortController.abort();
		const error = await startPromise.catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(McpError);
		const attemptsAtAbort = connectionCount();
		await Bun.sleep(80);
		expect(connectionCount()).toBe(attemptsAtAbort);
	});

	test("close() 幂等且只投递一次 closed 终态", async () => {
		const closeEvents: string[] = [];
		const { url } = makeServer(() => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(sseFrame("endpoint", "/mcp"));
				},
			});
			return new Response(stream, { headers: { "content-type": "text/event-stream" } });
		});
		const transport = track(new SseClientTransport({ url }));
		transport.onClose((event) => closeEvents.push(event.code));
		await transport.start();
		await transport.close();
		await transport.close();
		expect(closeEvents).toEqual(["closed"]);
	});

	test("全栈：McpClient 经 SSE 完成握手与工具枚举", async () => {
		const posts: string[] = [];
		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const pushEvent = (event: string, data: string): void => {
			streamController?.enqueue(sseFrame(event, data));
		};
		const { url } = makeServer((req) => {
			const path = new URL(req.url).pathname;
			if (path === "/stream") {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						streamController = controller;
						pushEvent("endpoint", "/mcp");
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			}
			if (path === "/mcp" && req.method === "POST") {
				return req.text().then((body) => {
					posts.push(body);
					const message = JSON.parse(body) as { id: number; method: string };
					if (message.method === "initialize") {
						pushEvent(
							"message",
							JSON.stringify({
								jsonrpc: "2.0",
								id: message.id,
								result: {
									protocolVersion: "2025-06-18",
									capabilities: { tools: {} },
									serverInfo: { name: "sse-fixture", version: "0.1.0" },
								},
							}),
						);
					} else if (message.method === "tools/list") {
						pushEvent(
							"message",
							JSON.stringify({
								jsonrpc: "2.0",
								id: message.id,
								result: {
									tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }],
								},
							}),
						);
					}
					return new Response("accepted", { status: 202 });
				});
			}
			return new Response("nf", { status: 404 });
		});
		const transport = track(new SseClientTransport({ url }));
		const client = new McpClient(transport, { requestTimeoutMs: 3000 });
		await transport.start();
		const initResult = await client.initialize();
		expect(initResult.serverInfo.name).toBe("sse-fixture");
		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
		const methods = posts.map((body) => (JSON.parse(body) as { method: string }).method);
		expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
		await client.close();
	});
});
