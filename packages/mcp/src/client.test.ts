import { describe, expect, test } from "bun:test";
import type {
	JsonRpcMessage,
	McpTransport,
	RestartableTransport,
	TransportCloseEvent,
} from "./protocol";
import {
	MCP_PROTOCOL_VERSION,
	McpError,
	jsonRpcError,
	jsonRpcNotification,
	jsonRpcResponse,
} from "./protocol";
import { McpClient, McpRegistry } from "./client";

/** 类型化请求（用于测试内 narrow）。 */
function asRequest(message: JsonRpcMessage): { id: number; method: string; params?: unknown } {
	if ("id" in message && "method" in message) {
		return { id: message.id as number, method: message.method, params: message.params };
	}
	throw new Error("期望请求消息");
}

/** 内存假传输：可脚本化应答，可注入关闭/重启事件。 */
class FakeTransport implements McpTransport, RestartableTransport {
	readonly sent: JsonRpcMessage[] = [];
	private handlers: Record<string, (request: { id: number; method: string; params?: unknown }) => unknown>;
	private readonly messageCallbacks: Array<(message: JsonRpcMessage) => void> = [];
	private readonly closeCallbacks: Array<(event: TransportCloseEvent) => void> = [];
	private readonly restartCallbacks: Array<(event: { attempt: number }) => void> = [];

	constructor(
		handlers: Record<string, (request: { id: number; method: string; params?: unknown }) => unknown> = {},
		private readonly errorHandlers: Record<string, { code: number; message: string }> = {},
	) {
		this.handlers = handlers;
	}

	/** 运行中替换应答脚本（如超时用例先静默后恢复）。 */
	setHandlers(handlers: Record<string, (request: { id: number; method: string; params?: unknown }) => unknown>): void {
		this.handlers = handlers;
	}

	async start(): Promise<void> {}

	async send(message: JsonRpcMessage): Promise<void> {
		this.sent.push(message);
		if (!("method" in message) || !("id" in message)) {
			return;
		}
		const request = asRequest(message);
		const errorHandler = this.errorHandlers[request.method];
		if (errorHandler !== undefined) {
			this.emitMessage(jsonRpcError(request.id, errorHandler.code, errorHandler.message));
			return;
		}
		const handler = this.handlers[request.method];
		if (handler !== undefined) {
			this.emitMessage(jsonRpcResponse(request.id, handler(request)));
		}
	}

	onMessage(callback: (message: JsonRpcMessage) => void): void {
		this.messageCallbacks.push(callback);
	}

	onClose(callback: (event: TransportCloseEvent) => void): void {
		this.closeCallbacks.push(callback);
	}

	onRestart(callback: (event: { attempt: number }) => void): void {
		this.restartCallbacks.push(callback);
	}

	async close(): Promise<void> {}

	emitMessage(message: JsonRpcMessage): void {
		for (const callback of this.messageCallbacks) {
			callback(message);
		}
	}

	emitClose(event: TransportCloseEvent): void {
		for (const callback of this.closeCallbacks) {
			callback(event);
		}
	}

	emitRestart(attempt: number): void {
		for (const callback of this.restartCallbacks) {
			callback({ attempt });
		}
	}
}

const DEFAULT_HANDLERS = {
	initialize: () => ({
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {},
		serverInfo: { name: "fake-mcp", version: "0.1.0" },
	}),
	ping: () => ({}),
	"tools/list": () => ({
		tools: [
			{ name: "echo", description: "回显", inputSchema: { type: "object" } },
			{ name: "add", inputSchema: { type: "object" } },
		],
	}),
	"tools/call": (request) => {
		const name = (request.params as { name: string }).name;
		if (name === "boom") {
			return { content: [{ type: "text", text: "boom failed" }], isError: true };
		}
		return { content: [{ type: "text", text: "ok" }], isError: false };
	},
} satisfies Record<string, (request: { id: number; method: string; params?: unknown }) => unknown>;

async function readyClient(
	handlers: Record<string, (request: { id: number; method: string; params?: unknown }) => unknown> = DEFAULT_HANDLERS,
	clientOpts?: ConstructorParameters<typeof McpClient>[1],
): Promise<{ transport: FakeTransport; client: McpClient }> {
	const transport = new FakeTransport(handlers);
	const client = new McpClient(transport, clientOpts);
	await client.initialize();
	return { transport, client };
}

function errorData<T>(error: McpError): T {
	return error.data as T;
}

async function expectMcpError(promise: Promise<unknown>, code: import("./protocol").McpErrorCode): Promise<McpError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(McpError);
		const mcpError = error as McpError;
		expect(mcpError.code).toBe(code);
		return mcpError;
	}
	throw new Error(`期望抛出 McpError(${code})，但请求成功了`);
}

describe("McpClient：握手与会话（内存假传输）", () => {
	test("initialize 发送正确信封并补发 initialized 通知", async () => {
		const { transport } = await readyClient();
		expect(transport.sent.length).toBe(2);
		const initRequest = asRequest(transport.sent[0]!);
		expect(initRequest.method).toBe("initialize");
		expect(initRequest.id).toBe(1);
		expect(initRequest.params).toEqual({
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "@bi/mcp-client", version: "0.1.0" },
		});
		expect(transport.sent[1]).toEqual(jsonRpcNotification("notifications/initialized"));
	});

	test("自定义协议版本、客户端信息与能力声明透传", async () => {
		const { transport } = await readyClient(DEFAULT_HANDLERS, {
			protocolVersion: "2024-11-05",
			clientInfo: { name: "bi-agent", version: "2.3.4" },
			capabilities: { roots: { listChanged: true } },
		});
		const initRequest = asRequest(transport.sent[0]!);
		expect(initRequest.params).toEqual({
			protocolVersion: "2024-11-05",
			capabilities: { roots: { listChanged: true } },
			clientInfo: { name: "bi-agent", version: "2.3.4" },
		});
	});

	test("ping 往返成功", async () => {
		const { client } = await readyClient();
		await expect(client.ping()).resolves.toBeUndefined();
	});

	test("callTool 透传 content 与 isError", async () => {
		const { client } = await readyClient();
		const ok = await client.callTool("echo", { text: "hi" });
		expect(ok.content).toEqual([{ type: "text", text: "ok" }]);
		expect(ok.isError).toBe(false);
		const boom = await client.callTool("boom");
		expect(boom.isError).toBe(true);
		expect(boom.content).toEqual([{ type: "text", text: "boom failed" }]);
	});

	test("listTools 默认单页返回", async () => {
		const { client } = await readyClient();
		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["echo", "add"]);
	});

	test("listTools 自动跟随 nextCursor 翻页", async () => {
		let listCalls = 0;
		const { transport, client } = await readyClient({
			initialize: DEFAULT_HANDLERS.initialize!,
			ping: DEFAULT_HANDLERS.ping!,
			"tools/list": () => {
				listCalls++;
				if (listCalls === 1) {
					return {
						tools: [{ name: "a", inputSchema: {} }],
						nextCursor: "page-2",
					};
				}
				return { tools: [{ name: "b", inputSchema: {} }] };
			},
		});
		const tools = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["a", "b"]);
		expect(listCalls).toBe(2);
		const listRequests = transport.sent
			.filter((m) => "method" in m && m.method === "tools/list")
			.map((m) => asRequest(m));
		expect(listRequests.length).toBe(2);
		expect(listRequests[1]?.params).toEqual({ cursor: "page-2" });
	});

	test("服务器 JSON-RPC 错误 → rpc-error 携带 rpcCode", async () => {
		const errorTransport = new FakeTransport(DEFAULT_HANDLERS, {
			"tools/call": { code: -32601, message: "no such tool" },
		});
		const client = new McpClient(errorTransport);
		await client.initialize();
		const error = await expectMcpError(client.callTool("echo"), "rpc-error");
		expect(errorData<{ rpcCode: number; rpcMessage: string }>(error).rpcCode).toBe(-32601);
		expect(errorData<{ rpcCode: number; rpcMessage: string }>(error).rpcMessage).toBe("no such tool");
	});

	test("请求超时 → 结构化 timeout 错误；迟到响应被忽略", async () => {
		const transport = new FakeTransport({ initialize: DEFAULT_HANDLERS.initialize! });
		const client = new McpClient(transport, { requestTimeoutMs: 80 });
		await client.initialize();
		const pingPromise = client.ping(); // 无 ping handler → 不应答
		const error = await expectMcpError(pingPromise, "timeout");
		expect(errorData<{ method: string }>(error).method).toBe("ping");
		// 迟到响应：未知 id 与已超时 id 都应被静默忽略
		transport.emitMessage(jsonRpcResponse(1, {}));
		transport.emitMessage(jsonRpcResponse(999, {}));
		transport.setHandlers({ ping: () => ({}) }); // 恢复应答能力
		await expect(client.ping()).resolves.toBeUndefined(); // 后续会话不受影响
	});

	test("未 initialize 直接调用 → not-ready", async () => {
		const client = new McpClient(new FakeTransport(DEFAULT_HANDLERS));
		await expectMcpError(client.callTool("echo"), "not-ready");
		await expectMcpError(client.ping(), "not-ready");
	});

	test("传输终态关闭（非重启）→ 未决请求 reject 且状态 closed", async () => {
		const transport = new FakeTransport({ initialize: DEFAULT_HANDLERS.initialize! });
		const client = new McpClient(transport, { requestTimeoutMs: 3000 });
		await client.initialize();
		const closedEvents: TransportCloseEvent[] = [];
		client.onClosed((event) => closedEvents.push(event));
		const pingPromise = client.ping();
		transport.emitClose({ code: "server-exited", restarting: false, exitCode: 9 });
		await expectMcpError(pingPromise, "server-exited");
		expect(client.getState()).toBe("closed");
		expect(closedEvents.length).toBe(1);
		await expectMcpError(client.ping(), "transport-closed");
	});

	test("close()：未决请求以 transport-closed 拒绝", async () => {
		const transport = new FakeTransport({ initialize: DEFAULT_HANDLERS.initialize! });
		const client = new McpClient(transport, { requestTimeoutMs: 3000 });
		await client.initialize();
		const pingPromise = client.ping();
		await client.close();
		await expectMcpError(pingPromise, "transport-closed");
		expect(client.getState()).toBe("closed");
	});
});

describe("McpClient：重启语义", () => {
	function crashableClient(
		clientOpts?: ConstructorParameters<typeof McpClient>[1],
		handlers: Record<string, (request: { id: number; method: string; params?: unknown }) => unknown> = DEFAULT_HANDLERS,
	): {
		transport: FakeTransport;
		client: McpClient;
	} {
		const transport = new FakeTransport(handlers);
		const client = new McpClient(transport, { requestTimeoutMs: 3000, ...clientOpts });
		return { transport, client };
	}

	test("重启事件（restarting=true）：未决请求以 server-exited 拒绝", async () => {
		// 仅 initialize：保证 ping 在关闭事件前不被应答
		const { transport, client } = crashableClient(undefined, {
			initialize: DEFAULT_HANDLERS.initialize!,
		});
		await client.initialize();
		const pingPromise = client.ping();
		transport.emitClose({ code: "server-exited", restarting: true });
		await expectMcpError(pingPromise, "server-exited");
		expect(client.getState()).toBe("restarting");
	});

	test("fail-fast：重启窗口内请求立即拒绝，重握手后恢复", async () => {
		const { transport, client } = crashableClient();
		await client.initialize();
		transport.emitClose({ code: "server-exited", restarting: true });
		await expectMcpError(client.ping(), "restarting");
		transport.emitRestart(1); // 新进程就绪 → 客户端自动重握手（handlers 应答 initialize）
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(client.getState()).toBe("ready");
		await expect(client.ping()).resolves.toBeUndefined();
	});

	test("queue：重启窗口内请求排队，重握手后依次完成", async () => {
		const { transport, client } = crashableClient({ restartBehavior: "queue" });
		await client.initialize();
		transport.emitClose({ code: "server-exited", restarting: true });
		const queuedPing = client.ping();
		const queuedCall = client.callTool("echo", { text: "after-restart" });
		expect(client.getState()).toBe("restarting");
		transport.emitRestart(1);
		await expect(queuedPing).resolves.toBeUndefined();
		const result = await queuedCall;
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(client.getState()).toBe("ready");
	});

	test("重启用尽：onClosed 触发且状态 closed", async () => {
		const { transport, client } = crashableClient();
		const closedEvents: TransportCloseEvent[] = [];
		client.onClosed((event) => closedEvents.push(event));
		await client.initialize();
		transport.emitClose({ code: "restart-exhausted", restarting: false });
		expect(closedEvents.map((event) => event.code)).toEqual(["restart-exhausted"]);
		expect(client.getState()).toBe("closed");
	});
});

describe("McpRegistry：多服务器聚合", () => {
	async function serverClient(
		handlers: Record<string, (request: { id: number; method: string; params?: unknown }) => unknown> = {
			initialize: DEFAULT_HANDLERS.initialize!,
			"tools/list": () => ({ tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }] }),
			"tools/call": () => ({ content: [{ type: "text", text: "generic" }], isError: false }),
		},
	): Promise<{ client: McpClient; transport: FakeTransport }> {
		const transport = new FakeTransport(handlers);
		const client = new McpClient(transport);
		await client.initialize();
		return { client, transport };
	}

	test("跨服务器聚合并加前缀防撞", async () => {
		const registry = new McpRegistry();
		registry.register("a", (await serverClient()).client);
		registry.register("b", (await serverClient()).client);
		expect(registry.listServers()).toEqual(["a", "b"]);
		const tools = await registry.toolsAcrossServers();
		expect(tools.map((tool) => tool.prefixedName).sort()).toEqual(["a.echo", "b.echo"]);
		expect(tools[0]?.server).toBe("a");
		expect(tools[0]?.name).toBe("echo");
		expect(tools[0]?.description).toBe("回显");
	});

	test("callTool 按前缀路由到所属服务器", async () => {
		const registry = new McpRegistry();
		const a = await serverClient({
			initialize: DEFAULT_HANDLERS.initialize!,
			"tools/list": () => ({ tools: [{ name: "echo", inputSchema: {} }] }),
			"tools/call": () => ({ content: [{ type: "text", text: "A" }], isError: false }),
		});
		const b = await serverClient({
			initialize: DEFAULT_HANDLERS.initialize!,
			"tools/list": () => ({ tools: [{ name: "echo", inputSchema: {} }] }),
			"tools/call": () => ({ content: [{ type: "text", text: "B" }], isError: false }),
		});
		registry.register("alpha", a.client);
		registry.register("beta", b.client);
		const fromB = await registry.callTool("beta.echo", { text: "x" });
		expect(fromB.content).toEqual([{ type: "text", text: "B" }]);
		expect(a.transport.sent.some((m) => "method" in m && m.method === "tools/call")).toBe(false);
		expect(b.transport.sent.some((m) => "method" in m && m.method === "tools/call")).toBe(true);
	});

	test("重复服务器名 → server-name-conflict", async () => {
		const registry = new McpRegistry();
		registry.register("dup", (await serverClient()).client);
		const again = await serverClient();
		expect(() => registry.register("dup", again.client)).toThrow(/服务器名冲突/);
	});

	test("服务器名包含点号 → server-name-conflict（前缀歧义防线）", async () => {
		const registry = new McpRegistry();
		const dotted = await serverClient();
		expect(() => registry.register("a.b", dotted.client)).toThrow(/前缀路由/);
	});

	test("未知前缀或裸工具名 → unknown-tool", async () => {
		const registry = new McpRegistry();
		registry.register("solo", (await serverClient()).client);
		await expectMcpError(registry.callTool("ghost.echo"), "unknown-tool");
		await expectMcpError(registry.callTool("no-dots"), "unknown-tool");
	});

	test("unregister 后服务器下线", async () => {
		const registry = new McpRegistry();
		registry.register("gone", (await serverClient()).client);
		registry.unregister("gone");
		expect(registry.listServers()).toEqual([]);
	});
});
