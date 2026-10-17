/**
 * @bi/mcp —— MCP 客户端与多服务器注册表。
 *
 * McpClient 持有任意 McpTransport，统一负责请求-响应关联
 * （id→pending map）、可配超时（默认 30s，结构化超时错误）、
 * initialize 握手与能力协商、工具枚举/调用/ping；
 * stdio 进程重启后自动重握手，重启窗口内的请求可快速失败或排队。
 * McpRegistry 聚合多服务器工具，工具名加 `server.tool` 前缀防撞。
 */
import type {
	JsonRpcId,
	JsonRpcMessage,
	McpTransport,
	RestartableTransport,
	TransportCloseEvent,
} from "./protocol";
import {
	MCP_PROTOCOL_VERSION,
	jsonRpcNotification,
	jsonRpcRequest,
	McpError,
} from "./protocol";

/** 客户端对服务器暴露的信息。 */
export interface McpClientInfo {
	name: string;
	version: string;
}

export interface McpClientOptions {
	/** 请求超时毫秒数，默认 30000。 */
	requestTimeoutMs?: number;
	/** 握手使用的协议版本字符串，默认 "2025-06-18"。 */
	protocolVersion?: string;
	/** 客户端名称与版本，默认 @bi/mcp-client 0.1.0。 */
	clientInfo?: McpClientInfo;
	/** 客户端能力声明，默认 {}。 */
	capabilities?: Record<string, unknown>;
	/**
	 * 重启窗口内（stdio 进程崩溃到重握手完成之间）新请求的行为：
	 * "fail-fast" 立即以 restarting 错误拒绝（默认）；"queue" 排队至重握手完成后执行。
	 */
	restartBehavior?: "fail-fast" | "queue";
}

/** initialize 结果（透传关键字段）。 */
export interface McpInitializeResult {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: McpClientInfo;
	instructions?: string;
}

/** 工具定义（tools/list 条目）。 */
export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema: unknown;
}

/** 工具调用结果：content 数组透传 + isError 语义。 */
export interface McpToolCallResult {
	content?: unknown[];
	isError?: boolean;
	[key: string]: unknown;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (cause: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
}

interface QueuedTask {
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (cause: unknown) => void;
}

type ClientState = "idle" | "initializing" | "ready" | "restarting" | "closed";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_INFO: McpClientInfo = { name: "@bi/mcp-client", version: "0.1.0" };

/** MCP 客户端：面向任意传输的会话层。 */
export class McpClient {
	private nextId = 1;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private readonly queue: QueuedTask[] = [];
	private readonly requestTimeoutMs: number;
	private readonly restartBehavior: "fail-fast" | "queue";
	private readonly protocolVersion: string;
	private readonly clientInfo: McpClientInfo;
	private readonly capabilities: Record<string, unknown>;

	private state: ClientState = "idle";
	private wasReady = false;
	private readonly readyCallbacks: Array<() => void> = [];
	private readonly closedCallbacks: Array<(event: TransportCloseEvent) => void> = [];

	constructor(
		private readonly transport: McpTransport,
		opts: McpClientOptions = {},
	) {
		this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.restartBehavior = opts.restartBehavior ?? "fail-fast";
		this.protocolVersion = opts.protocolVersion ?? MCP_PROTOCOL_VERSION;
		this.clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO;
		this.capabilities = opts.capabilities ?? {};

		this.transport.onMessage((message) => this.handleMessage(message));
		this.transport.onClose((event) => this.handleTransportClose(event));
		const restartable = transport as Partial<RestartableTransport>;
		if (typeof restartable.onRestart === "function") {
			restartable.onRestart((event) => void this.handleTransportRestart(event));
		}
	}

	/**
	 * initialize 握手：发送协议版本 + 客户端信息 + 能力声明，
	 * 收到服务器结果后补发 notifications/initialized 通知。
	 * stdio 重启后的自动重握手也复用本方法。
	 */
	async initialize(): Promise<McpInitializeResult> {
		if (this.state === "closed") {
			throw new McpError("transport-closed", "客户端已关闭，无法握手");
		}
		this.state = "initializing";
		try {
			const result = (await this.performRpc("initialize", {
				protocolVersion: this.protocolVersion,
				capabilities: this.capabilities,
				clientInfo: this.clientInfo,
			})) as McpInitializeResult;
			await this.transport.send(jsonRpcNotification("notifications/initialized"));
			this.state = "ready";
			this.wasReady = true;
			this.flushQueue();
			for (const callback of this.readyCallbacks) {
				callback();
			}
			return result;
		} catch (cause) {
			// await 期间可能被 onClose 改写为 closed；断言恢复完整联合以正确比较
			if ((this.state as ClientState) !== "closed") {
				this.state = "idle";
			}
			throw cause;
		}
	}

	/** 枚举工具（自动跟随 nextCursor 翻页）。 */
	async listTools(): Promise<McpToolDefinition[]> {
		const tools: McpToolDefinition[] = [];
		let cursor: string | undefined;
		do {
			const result = (await this.rpc("tools/list", cursor === undefined ? undefined : { cursor })) as {
				tools?: McpToolDefinition[];
				nextCursor?: string;
			};
			tools.push(...(result.tools ?? []));
			cursor = result.nextCursor;
		} while (cursor !== undefined);
		return tools;
	}

	/** 调用工具：content 数组与 isError 标志原样透传给调用方判别。 */
	async callTool(name: string, args?: unknown): Promise<McpToolCallResult> {
		const result = (await this.rpc("tools/call", { name, arguments: args ?? {} })) as McpToolCallResult;
		return result;
	}

	/** 存活探测。 */
	async ping(): Promise<void> {
		await this.rpc("ping");
	}

	/** 当前会话状态（观测用）。 */
	getState(): ClientState {
		return this.state;
	}

	/** 握手完成（含重启后重握手）时触发。 */
	onReady(callback: () => void): void {
		this.readyCallbacks.push(callback);
	}

	/** 传输终态关闭（不再重启）时触发。 */
	onClosed(callback: (event: TransportCloseEvent) => void): void {
		this.closedCallbacks.push(callback);
	}

	/** 关闭客户端与底层传输；未决请求与队列全部以 transport-closed 拒绝。 */
	async close(): Promise<void> {
		this.state = "closed";
		this.rejectQueue(new McpError("transport-closed", "客户端已关闭，排队请求被取消"));
		await this.transport.close();
		this.rejectPending(
			new McpError("transport-closed", "客户端已关闭，未决请求被取消"),
		);
	}

	/** 发起一次请求-响应往返（重启窗口按策略快速失败或排队）。 */
	private rpc(method: string, params?: unknown): Promise<unknown> {
		if (this.state === "closed") {
			return Promise.reject(new McpError("transport-closed", `客户端已关闭，无法调用 ${method}`));
		}
		if (this.state === "restarting") {
			if (this.restartBehavior === "queue") {
				return new Promise<unknown>((resolve, reject) => {
					this.queue.push({
						run: () => this.performRpc(method, params),
						resolve,
						reject,
					});
				});
			}
			return Promise.reject(
				new McpError("restarting", `传输正在重启，${method} 快速失败（restartBehavior=fail-fast）`),
			);
		}
		if (this.state === "idle") {
			return Promise.reject(
				new McpError("not-ready", `请先调用 initialize() 完成握手（${method}）`),
			);
		}
		return this.performRpc(method, params);
	}

	private performRpc(method: string, params?: unknown): Promise<unknown> {
		const id = this.nextId++;
		const request = jsonRpcRequest(id, method, params);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new McpError(
						"timeout",
						`请求 ${method} (id=${id}) 超过 ${this.requestTimeoutMs}ms 未收到响应`,
						{ method, id, timeoutMs: this.requestTimeoutMs },
					),
				);
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			this.transport.send(request).catch((cause) => {
				if (!this.pending.has(id)) {
					return; // 已超时
				}
				clearTimeout(timer);
				this.pending.delete(id);
				reject(
					cause instanceof McpError
						? cause
						: new McpError("not-connected", `发送 ${method} 失败`, { cause: String(cause) }),
				);
			});
		});
	}

	private handleMessage(message: JsonRpcMessage): void {
		if ("method" in message) {
			return; // 服务器-initiated 通知/请求：本工单会话面不处理，忽略
		}
		const entry = this.pending.get(message.id);
		if (entry === undefined) {
			return; // 迟到响应（已超时或未知 id）：静默忽略
		}
		clearTimeout(entry.timer);
		this.pending.delete(message.id);
		if ("error" in message) {
			entry.reject(
				new McpError("rpc-error", `[${message.error.code}] ${message.error.message}`, {
					rpcCode: message.error.code,
					rpcMessage: message.error.message,
					data: message.error.data,
					method: entry.method,
				}),
			);
			return;
		}
		entry.resolve(message.result);
	}

	private handleTransportClose(event: TransportCloseEvent): void {
		const willRestart = event.restarting;
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
		}
		if (willRestart) {
			this.state = "restarting";
			this.rejectPending(
				new McpError("server-exited", `对端断开，正在重启: ${event.message ?? event.code}`, {
					closeEvent: event,
				}),
			);
			return;
		}
		this.state = "closed";
		const errorCode =
			event.code === "closed"
				? "transport-closed"
				: event.code === "server-exited"
					? "server-exited"
					: event.code;
		this.rejectPending(
			new McpError(errorCode, `传输终态关闭: ${event.message ?? event.code}`, {
				closeEvent: event,
			}),
		);
		this.rejectQueue(
			new McpError("transport-closed", "传输终态关闭，排队请求被取消", { closeEvent: event }),
		);
		for (const callback of this.closedCallbacks) {
			callback(event);
		}
	}

	private async handleTransportRestart(event: { attempt: number }): Promise<void> {
		if (this.state === "closed") {
			return;
		}
		this.state = "restarting";
		if (!this.wasReady) {
			return; // 从未完成过握手：等用户显式 initialize
		}
		try {
			await this.initialize();
		} catch {
			// 重握手失败：若因失败被重置为 idle，则回到 restarting 语义，等下一次 onRestart 再试
			if ((this.state as ClientState) === "idle") {
				this.state = "restarting";
			}
		}
	}

	private flushQueue(): void {
		const tasks = this.queue.splice(0, this.queue.length);
		for (const task of tasks) {
			task.run().then(task.resolve, task.reject);
		}
	}

	private rejectQueue(cause: McpError): void {
		const tasks = this.queue.splice(0, this.queue.length);
		for (const task of tasks) {
			task.reject(cause);
		}
	}

	private rejectPending(cause: McpError): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(cause);
		}
		this.pending.clear();
	}
}

/** 聚合后的工具条目：name 为原工具名，prefixedName 为 `server.tool` 全局唯一名。 */
export interface RegisteredMcpTool {
	server: string;
	name: string;
	prefixedName: string;
	description?: string;
	inputSchema: unknown;
}

/** 多服务器工具注册表：注册、跨服务器聚合（前缀防撞）、按前缀名路由调用。 */
export class McpRegistry {
	private readonly clients = new Map<string, McpClient>();

	/**
	 * 注册一个服务器客户端。
	 * 服务器名重复或包含 "."（会破坏前缀路由的无歧义性）时抛 server-name-conflict。
	 */
	register(name: string, client: McpClient): void {
		if (this.clients.has(name)) {
			throw new McpError("server-name-conflict", `服务器名冲突: "${name}" 已注册`);
		}
		if (name.includes(".")) {
			throw new McpError(
				"server-name-conflict",
				`服务器名不能包含 ".": "${name}"（前缀路由要求服务器名无点号）`,
			);
		}
		this.clients.set(name, client);
	}

	/** 注销一个服务器。 */
	unregister(name: string): void {
		this.clients.delete(name);
	}

	/** 已注册服务器名列表。 */
	listServers(): string[] {
		return [...this.clients.keys()];
	}

	/**
	 * 聚合所有服务器的工具列表，工具名加 `server.tool` 前缀防撞。
	 * 任一服务器枚举失败则整体失败（透明上报）；聚合后前缀名仍冲突（理论上仅
	 * 在绕过 register 校验时可能）抛 tool-name-conflict。
	 */
	async toolsAcrossServers(): Promise<RegisteredMcpTool[]> {
		const entries = [...this.clients.entries()];
		const perServer = await Promise.all(
			entries.map(async ([server, client]) => ({
				server,
				tools: await client.listTools(),
			})),
		);
		const result: RegisteredMcpTool[] = [];
		const owner = new Map<string, string>();
		for (const { server, tools } of perServer) {
			for (const tool of tools) {
				const prefixedName = `${server}.${tool.name}`;
				const existing = owner.get(prefixedName);
				if (existing !== undefined) {
					throw new McpError(
						"tool-name-conflict",
						`聚合工具名冲突: "${prefixedName}" 同时来自 "${existing}" 与 "${server}"`,
					);
				}
				owner.set(prefixedName, server);
				result.push({
					server,
					name: tool.name,
					prefixedName,
					description: tool.description,
					inputSchema: tool.inputSchema,
				});
			}
		}
		return result;
	}

	/** 按前缀名（`server.tool`）路由工具调用到所属服务器。 */
	async callTool(prefixedName: string, args?: unknown): Promise<McpToolCallResult> {
		const dot = prefixedName.indexOf(".");
		const server = dot === -1 ? "" : prefixedName.slice(0, dot);
		const toolName = dot === -1 ? "" : prefixedName.slice(dot + 1);
		if (server.length === 0 || toolName.length === 0) {
			throw new McpError(
				"unknown-tool",
				`非法工具名 "${prefixedName}"，要求 "server.tool" 前缀形式`,
			);
		}
		const client = this.clients.get(server);
		if (client === undefined) {
			throw new McpError("unknown-tool", `工具 "${prefixedName}" 的服务器 "${server}" 未注册`);
		}
		return client.callTool(toolName, args);
	}
}
