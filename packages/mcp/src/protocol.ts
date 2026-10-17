/**
 * @bi/mcp —— MCP 协议面。
 *
 * JSON-RPC 2.0 信封构造器、标准错误码、newline 分帧工具、结构化错误类型
 * 与传输层契约。本模块是 stdio / SSE 两条传输通道的公共底座，
 * 零外部依赖（仅类型与纯函数）。
 */

/** JSON-RPC 协议版本常量（信封字段值）。 */
export const JSON_RPC_VERSION = "2.0";

/** MCP 握手默认协议版本字符串（可在客户端选项中覆盖）。 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** JSON-RPC 2.0 标准错误码（RFC 严格值）。 */
export const JsonRpcErrorCode = {
	/** 非法 JSON（解析失败）。 */
	ParseError: -32700,
	/** JSON 合法但不是合法的 JSON-RPC 消息。 */
	InvalidRequest: -32600,
	/** 方法不存在。 */
	MethodNotFound: -32601,
	/** 参数不合法。 */
	InvalidParams: -32602,
	/** 服务端内部错误。 */
	InternalError: -32603,
} as const;

/** JSON-RPC 标准错误码的值类型。 */
export type JsonRpcErrorCodeValue =
	(typeof JsonRpcErrorCode)[keyof typeof JsonRpcErrorCode];

/** JSON-RPC 请求/响应标识。 */
export type JsonRpcId = number | string;

/** JSON-RPC 错误对象（响应中的 error 字段）。 */
export interface JsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

/** JSON-RPC 2.0 请求（带 id，期望响应）。 */
export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

/** JSON-RPC 2.0 通知（不带 id，不期望响应）。 */
export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

/** JSON-RPC 2.0 成功响应。 */
export interface JsonRpcSuccessResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result: unknown;
}

/** JSON-RPC 2.0 失败响应。 */
export interface JsonRpcErrorResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	error: JsonRpcErrorObject;
}

/** 传输层上流动的全部消息形态。 */
export type JsonRpcMessage =
	| JsonRpcRequest
	| JsonRpcNotification
	| JsonRpcSuccessResponse
	| JsonRpcErrorResponse;

/** 构造 JSON-RPC 请求信封。params 为 undefined 时省略该字段。 */
export function jsonRpcRequest(
	id: JsonRpcId,
	method: string,
	params?: unknown,
): JsonRpcRequest {
	return params === undefined
		? { jsonrpc: JSON_RPC_VERSION, id, method }
		: { jsonrpc: JSON_RPC_VERSION, id, method, params };
}

/** 构造 JSON-RPC 通知信封。params 为 undefined 时省略该字段。 */
export function jsonRpcNotification(
	method: string,
	params?: unknown,
): JsonRpcNotification {
	return params === undefined
		? { jsonrpc: JSON_RPC_VERSION, method }
		: { jsonrpc: JSON_RPC_VERSION, method, params };
}

/** 构造 JSON-RPC 成功响应信封。 */
export function jsonRpcResponse(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
	return { jsonrpc: JSON_RPC_VERSION, id, result };
}

/** 构造 JSON-RPC 失败响应信封。data 为 undefined 时省略该字段。 */
export function jsonRpcError(
	id: JsonRpcId,
	code: number,
	message: string,
	data?: unknown,
): JsonRpcErrorResponse {
	const error: JsonRpcErrorObject =
		data === undefined ? { code, message } : { code, message, data };
	return { jsonrpc: JSON_RPC_VERSION, id, error };
}

/** 判定一个未知值是否为结构合法的 JSON-RPC 2.0 消息（请求/通知/响应三选一）。 */
export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (record["jsonrpc"] !== JSON_RPC_VERSION) {
		return false;
	}
	const hasIdField = "id" in record;
	const validId =
		hasIdField &&
		(typeof record["id"] === "number" || typeof record["id"] === "string");
	if (typeof record["method"] === "string") {
		return !hasIdField || validId === true; // 通知（无 id）或请求（id 合法）
	}
	if (validId === true && ("result" in record || "error" in record)) {
		return true;
	}
	return false;
}

/** 行解析结果：ok 为真携带消息，否则携带失败原因。 */
export type JsonRpcParseResult =
	| { ok: true; message: JsonRpcMessage }
	| { ok: false; reason: "empty-line" | "invalid-json" | "not-json-rpc" };

/**
 * 解析一行 newline-delimited JSON-RPC 文本。
 * 畸形行不抛异常，返回结构化失败原因（由调用方决定跳过并计数）。
 */
export function parseJsonRpcLine(line: string): JsonRpcParseResult {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return { ok: false, reason: "empty-line" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return { ok: false, reason: "invalid-json" };
	}
	if (!isJsonRpcMessage(parsed)) {
		return { ok: false, reason: "not-json-rpc" };
	}
	return { ok: true, message: parsed };
}

/**
 * 按换行符分帧的流式缓冲器。
 * 容忍 \r\n 与 \n 两种行尾；push 可接收任意切分的字节块；
 * flush 在流结束时吐出残留的未换行内容。
 */
export class LineSplitter {
	private buffer = "";

	/** 喂入一个解码后的字节块，返回其中完整的行（不含行尾符）。 */
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}

	/** 流结束时调用：返回残留缓冲（若非空）。 */
	flush(): string[] {
		if (this.buffer.length === 0) {
			return [];
		}
		const rest = [this.buffer];
		this.buffer = "";
		return rest;
	}
}

/** 客户端结构化错误码。 */
export type McpErrorCode =
	| "timeout"
	| "server-exited"
	| "transport-closed"
	| "spawn-failed"
	| "connect-failed"
	| "restart-exhausted"
	| "restarting"
	| "not-ready"
	| "not-connected"
	| "rpc-error"
	| "bad-response"
	| "invalid-state"
	| "unknown-tool"
	| "server-name-conflict"
	| "tool-name-conflict";

/** 贯穿全包的结构化错误：code 可编程判别，data 携带上下文。 */
export class McpError extends Error {
	readonly code: McpErrorCode;
	readonly data?: unknown;

	constructor(code: McpErrorCode, message: string, data?: unknown) {
		super(message);
		this.name = "McpError";
		this.code = code;
		if (data !== undefined) {
			this.data = data;
		}
	}
}

/** 传输层关闭/断开事件。 */
export interface TransportCloseEvent {
	/**
	 * closed：close() 主动优雅关闭；
	 * server-exited：对端进程消失或流断开（restarting=true 表示将自动重连/重启）；
	 * restart-exhausted：重启重试次数用尽；
	 * connect-failed：SSE 初始连接或重连最终失败。
	 */
	code: "closed" | "server-exited" | "restart-exhausted" | "connect-failed";
	/** 是否会自动恢复（客户端据此决定是重握手还是终态）。 */
	restarting: boolean;
	/** 人类可读的补充说明。 */
	message?: string;
	/** stdio：进程退出码（正常关闭为 0，被信号杀死为 null 以外的值视平台而定）。 */
	exitCode?: number | null;
	/** stdio：终止信号名（如 SIGTERM/SIGKILL）。 */
	signal?: string | null;
}

/** 可重启传输（stdio）的追加事件：进程重新拉起、等待重握手。 */
export interface StdioRestartEvent {
	/** 第几次重启（从 1 开始）。 */
	attempt: number;
	/** 新进程 pid（观测与调试用）。 */
	pid?: number;
}

/**
 * 传输层契约：所有通道（stdio/SSE/测试内存桩）统一实现。
 * 请求-响应关联与超时由 McpClient 统一持有，传输层只负责
 * 消息收发与连接生命周期。
 */
export interface McpTransport {
	/** 建立连接（spawn 子进程 / 打开 SSE 流）。失败时抛结构化错误。 */
	start(): Promise<void>;
	/** 发送一条 JSON-RPC 消息（请求、通知或响应）。 */
	send(message: JsonRpcMessage): Promise<void>;
	/** 注册入站消息回调（可多个）。 */
	onMessage(callback: (message: JsonRpcMessage) => void): void;
	/** 注册关闭/断开事件回调（可多个）。 */
	onClose(callback: (event: TransportCloseEvent) => void): void;
	/** 关闭传输：优雅终止底层连接，幂等。 */
	close(): Promise<void>;
}

/** 具备自动重启能力的传输（stdio）的可选能力接口，客户端以鸭子类型探测。 */
export interface RestartableTransport extends McpTransport {
	onRestart(callback: (event: StdioRestartEvent) => void): void;
}
