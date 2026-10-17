/**
 * @bi/mcp —— LSP 符号级导航：基础协议传输（BI-13.2）。
 *
 * LSP Base Protocol 与 MCP 的换行分帧不同：每条消息为
 * `Content-Length: <字节数>\r\n[Content-Type: ...\r\n]\r\n<UTF-8 payload>`
 * 的头帧协议，Content-Length 按 UTF-8 字节计（多字节字符不可按字符切帧）。
 *
 * 本文件自实现：
 * - 字节级帧读取器（粘包：一次 push 多帧；半包：跨 chunk 拼装；畸形头跳过并计数）；
 * - 请求-响应关联（id→pending map），超时语义复刻 BI-13 McpClient 模式
 *   （可配超时、结构化 timeout 错误携带 method/id/timeoutMs），不 import 其文件；
 * - initialize/shutdown 握手原语（信封构造复用 protocol.ts 纯函数）；
 * - 服务器→客户端请求的默认 MethodNotFound 应答（防服务器挂等）；
 * - 子进程生命周期：spawn 失败分类为 server-missing，
 *   优雅关闭 SIGTERM → 宽限 → SIGKILL（自实现，不依赖 stdio 传输）。
 * 测试可注入 input/output 流代替子进程。
 */
import type { JsonRpcMessage, JsonRpcRequest } from "../protocol";
import {
	JsonRpcErrorCode,
	isJsonRpcMessage,
	jsonRpcError,
	jsonRpcNotification,
	jsonRpcRequest,
	jsonRpcResponse,
} from "../protocol";

// ---------- 结构化错误 ----------

/** LSP 域结构化错误码。 */
export type LspErrorCode =
	| "server-missing"
	| "timeout"
	| "capability-unsupported"
	| "rpc-error"
	| "protocol-error"
	| "not-connected"
	| "transport-closed"
	| "server-exited"
	| "invalid-state";

/** 贯穿 LSP 域的结构化错误：code 可编程判别，data 携带上下文。 */
export class LspError extends Error {
	readonly code: LspErrorCode;
	readonly data?: unknown;

	constructor(code: LspErrorCode, message: string, data?: unknown) {
		super(message);
		this.name = "LspError";
		this.code = code;
		if (data !== undefined) {
			this.data = data;
		}
	}
}

// ---------- 帧协议（纯函数与字节级读取器） ----------

const HEADER_TERMINATOR = "\r\n\r\n";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 把 payload 编码为一帧完整字节：`Content-Length: N\r\n\r\n<UTF-8 字节>`。 */
export function encodeLspFrame(payload: string): Uint8Array {
	const body = encoder.encode(payload);
	const header = `Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`;
	const headerBytes = encoder.encode(header);
	const frame = new Uint8Array(headerBytes.byteLength + body.byteLength);
	frame.set(headerBytes, 0);
	frame.set(body, headerBytes.byteLength);
	return frame;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left, 0);
	out.set(right, left.byteLength);
	return out;
}

/** 在字节流中定位头部终止符 \r\n\r\n 的起始下标；未找到返回 -1。 */
function indexOfHeaderTerminator(bytes: Uint8Array): number {
	for (let index = 0; index + 3 < bytes.byteLength; index++) {
		if (
			bytes[index] === 13 &&
			bytes[index + 1] === 10 &&
			bytes[index + 2] === 13 &&
			bytes[index + 3] === 10
		) {
			return index;
		}
	}
	return -1;
}

/** 从头部块文本解析 Content-Length（键名大小写不敏感）；缺失或非法返回 null。 */
function parseContentLength(headerBlock: string): number | null {
	for (const line of headerBlock.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon === -1) {
			continue;
		}
		const key = line.slice(0, colon).trim().toLowerCase();
		if (key !== "content-length") {
			continue;
		}
		const value = Number.parseInt(line.slice(colon + 1).trim(), 10);
		if (Number.isInteger(value) && value >= 0) {
			return value;
		}
		return null;
	}
	return null;
}

export interface LspFrameParseResult {
	/** 完整帧的 payload 文本（JSON，按到达顺序）。 */
	frames: string[];
	/** 被跳过的畸形帧数（头部完整但缺 Content-Length）。 */
	malformed: number;
}

/**
 * 字节级 LSP 帧读取器：容忍任意切分的字节块（半包自动拼装），
 * 一次喂入多帧自动拆解（粘包），畸形头跳过并计数。
 * Content-Length 按字节消费 payload，天然支持多字节 UTF-8。
 */
export class LspFrameReader {
	private buffer: Uint8Array = new Uint8Array(0);

	push(chunk: Uint8Array): LspFrameParseResult {
		this.buffer = concatBytes(this.buffer, chunk);
		const frames: string[] = [];
		let malformed = 0;
		for (;;) {
			const headerEnd = indexOfHeaderTerminator(this.buffer);
			if (headerEnd === -1) {
				break; // 半包：头部未完整
			}
			const headerBlock = decoder.decode(this.buffer.slice(0, headerEnd));
			const contentLength = parseContentLength(headerBlock);
			if (contentLength === null) {
				malformed += 1;
				this.buffer = this.buffer.slice(headerEnd + 4); // 丢弃畸形头，继续扫描
				continue;
			}
			const totalNeeded = headerEnd + 4 + contentLength;
			if (this.buffer.byteLength < totalNeeded) {
				break; // 半包：payload 未到齐
			}
			const payloadBytes = this.buffer.slice(headerEnd + 4, totalNeeded);
			frames.push(decoder.decode(payloadBytes));
			this.buffer = this.buffer.slice(totalNeeded);
		}
		return { frames, malformed };
	}
}

// ---------- 传输层 ----------

export interface LspStdioTransportOptions {
	/** 服务器可执行命令（如 gopls / typescript-language-server）。与 input/output 注入互斥。 */
	command?: string;
	/** 命令参数。 */
	args?: string[];
	/** 子进程工作目录。 */
	cwd?: string;
	/** 子进程环境变量增量覆盖（在 process.env 基础上合并）。 */
	env?: Record<string, string>;
	/** 测试注入：代替子进程 stdout 的可读字节流。 */
	input?: ReadableStream<Uint8Array>;
	/** 测试注入：代替子进程 stdin 的接收器。 */
	output?: { write(chunk: Uint8Array): void | Promise<void> };
	/** 请求超时毫秒数，默认 30000（与 BI-13 McpClient 同语义）。 */
	requestTimeoutMs?: number;
	/** 优雅关闭宽限期毫秒数（SIGTERM→SIGKILL 升级阈值），默认 5000。 */
	killGraceMs?: number;
	/** stderr 诊断缓冲上限（字节），默认 65536。 */
	maxStderrBytes?: number;
}

/** 传输关闭/断开事件（LSP 传输无自动重启语义，终态一次）。 */
export interface LspCloseEvent {
	code: "closed" | "server-exited";
	message?: string;
	exitCode?: number | null;
	signal?: string | null;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (cause: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
	method: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_STDERR_BYTES = 65_536;

/**
 * LSP stdio 传输：头帧协议读写 + 请求-响应关联。
 * 会话语义（initialize/initialized/shutdown/exit 序列）由 LspClient 编排，
 * 本层提供 request/notify 原语。
 */
export class LspStdioTransport {
	private readonly options: LspStdioTransportOptions;
	private readonly requestTimeoutMs: number;
	private readonly killGraceMs: number;
	private readonly maxStderrBytes: number;

	private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
	private readonly injectedInput?: ReadableStream<Uint8Array>;
	private readonly injectedOutput?: { write(chunk: Uint8Array): void | Promise<void> };
	private readerHandle: ReadableStreamDefaultReader<Uint8Array> | null = null;

	private readonly frameReader = new LspFrameReader();
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private started = false;
	private closed = false;
	private terminalEmitted = false;
	private malformedCount = 0;
	private stderrTail = "";
	private stderrTruncated = false;

	private readonly messageCallbacks: Array<(message: JsonRpcMessage) => void> = [];
	private readonly closeCallbacks: Array<(event: LspCloseEvent) => void> = [];
	/** 服务器→客户端请求处理器：返回 undefined 表示不处理（最终自动 MethodNotFound）。 */
	private readonly serverRequestHandlers: Array<(request: JsonRpcRequest) => Promise<unknown>> = [];

	constructor(options: LspStdioTransportOptions) {
		this.options = options;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
		this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
		this.injectedInput = options.input;
		this.injectedOutput = options.output;
	}

	/** 建立连接：spawn 子进程或挂接注入流。spawn 失败分类为 server-missing。 */
	async start(): Promise<void> {
		if (this.started) {
			throw new LspError("invalid-state", "LSP 传输已启动过，请新建实例");
		}
		this.started = true;
		if (this.injectedInput !== undefined || this.injectedOutput !== undefined) {
			if (this.injectedInput !== undefined) {
				void this.pumpStream(this.injectedInput);
			}
			return;
		}
		if (typeof this.options.command !== "string" || this.options.command.length === 0) {
			throw new LspError("invalid-state", "未提供 command 且未注入 input/output 流");
		}
		let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
		try {
			proc = Bun.spawn({
				cmd: [this.options.command, ...(this.options.args ?? [])],
				env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
				cwd: this.options.cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (cause) {
			throw new LspError(
				"server-missing",
				`无法启动 LSP 服务器进程: ${this.options.command}`,
				{ cause: String(cause) },
			);
		}
		this.proc = proc;
		void this.pumpStream(proc.stdout);
		void this.pumpStderr(proc);
		void this.watchExit(proc);
	}

	/** 发送一条 JSON-RPC 消息（请求、通知或响应），自动加头帧。 */
	async send(message: JsonRpcMessage): Promise<void> {
		const frame = encodeLspFrame(JSON.stringify(message));
		const output = this.injectedOutput;
		if (output !== undefined) {
			if (this.closed) {
				throw new LspError("not-connected", "LSP 传输已关闭，无法发送");
			}
			await output.write(frame);
			return;
		}
		const proc = this.proc;
		if (proc === null || proc.exitCode !== null) {
			throw new LspError("not-connected", "LSP 传输未连接（进程未启动或已退出）");
		}
		try {
			proc.stdin.write(frame);
			proc.stdin.flush();
		} catch (cause) {
			throw new LspError("server-exited", "写入 stdin 失败（LSP 服务器进程可能已退出）", {
				cause: String(cause),
			});
		}
	}

	/** 发起一次请求-响应往返：超时语义与 BI-13 McpClient 一致（结构化 timeout 错误）。 */
	async request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
		if (this.closed) {
			throw new LspError("not-connected", `LSP 传输已关闭，无法调用 ${method}`);
		}
		const id = this.nextId++;
		const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
		const request = jsonRpcRequest(id, method, params);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new LspError(
						"timeout",
						`请求 ${method} (id=${id}) 超过 ${timeoutMs}ms 未收到响应`,
						{ method, id, timeoutMs },
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, method });
			this.send(request).catch((cause) => {
				if (!this.pending.has(id)) {
					return; // 已超时
				}
				clearTimeout(timer);
				this.pending.delete(id);
				reject(
					cause instanceof LspError
						? cause
						: new LspError("not-connected", `发送 ${method} 失败`, { cause: String(cause) }),
				);
			});
		});
	}

	/** 发送一条通知（无 id，不期望响应）。 */
	async notify(method: string, params?: unknown): Promise<void> {
		await this.send(jsonRpcNotification(method, params));
	}

	/** 注册入站消息回调（通知与服务器发起的请求；本端请求的响应已内部关联消费）。 */
	onMessage(callback: (message: JsonRpcMessage) => void): void {
		this.messageCallbacks.push(callback);
	}

	/** 注册关闭/断开事件回调（终态只投递一次）。 */
	onClose(callback: (event: LspCloseEvent) => void): void {
		this.closeCallbacks.push(callback);
	}

	/** 注册服务器→客户端请求处理器；按注册序尝试，返回 undefined 视为不处理。 */
	onServerRequest(handler: (request: JsonRpcRequest) => Promise<unknown>): void {
		this.serverRequestHandlers.push(handler);
	}

	/** 被跳过的畸形入站帧数（含非 JSON payload 与缺 Content-Length 的头部）。 */
	getMalformedCount(): number {
		return this.malformedCount;
	}

	/** stderr 诊断尾部（有界）。 */
	getStderrTail(): string {
		return this.stderrTail;
	}

	/** stderr 是否发生过截断。 */
	isStderrTruncated(): boolean {
		return this.stderrTruncated;
	}

	/** 子进程 pid（注入流模式或未运行时为 undefined）。 */
	get pid(): number | undefined {
		const proc = this.proc;
		return proc !== null && proc.exitCode === null ? proc.pid : undefined;
	}

	/**
	 * 关闭传输：SIGTERM → 宽限 → SIGKILL（注入流模式直接断流）。
	 * 未决请求以 transport-closed 拒绝；终态事件只投递一次。幂等。
	 */
	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		const proc = this.proc;
		if (proc !== null && proc.exitCode === null) {
			try {
				proc.kill("SIGTERM");
			} catch {
				// 进程恰在 kill 前退出：忽略
			}
			const exitedInGrace = await Promise.race([
				proc.exited.then(
					() => true,
					() => true,
				),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.killGraceMs)),
			]);
			if (!exitedInGrace && proc.exitCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// 同上
				}
			}
			await proc.exited;
		}
		if (this.readerHandle !== null) {
			try {
				await this.readerHandle.cancel();
			} catch {
				// 流已关闭：忽略
			}
			this.readerHandle = null;
		}
		this.rejectPending(new LspError("transport-closed", "LSP 传输已关闭，未决请求被取消"));
		this.emitTerminal({ code: "closed", exitCode: proc?.exitCode ?? null, signal: proc?.signalCode ?? null });
	}

	// ---------- 内部 ----------

	private async pumpStream(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		this.readerHandle = reader;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (value !== undefined) {
					this.dispatchBytes(value);
				}
			}
		} catch {
			// 流读失败：交给进程退出监视或 close 处理
		}
	}

	private dispatchBytes(chunk: Uint8Array): void {
		const { frames, malformed } = this.frameReader.push(chunk);
		this.malformedCount += malformed;
		for (const frame of frames) {
			this.dispatchFrame(frame);
		}
	}

	private dispatchFrame(frame: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(frame);
		} catch {
			this.malformedCount += 1;
			return;
		}
		if (!isJsonRpcMessage(parsed)) {
			this.malformedCount += 1;
			return;
		}
		if ("method" in parsed) {
			for (const callback of this.messageCallbacks) {
				callback(parsed);
			}
			if ("id" in parsed) {
				void this.handleServerRequest(parsed);
			}
			return;
		}
		// 响应：按 id 关联（迟到/未知响应静默忽略）
		if (typeof parsed.id !== "number") {
			return; // 字符串 id 超出本端数字 id 空间：静默忽略
		}
		const entry = this.pending.get(parsed.id);
		if (entry === undefined) {
			return;
		}
		clearTimeout(entry.timer);
		this.pending.delete(parsed.id);
		if ("error" in parsed) {
			entry.reject(
				new LspError("rpc-error", `[${parsed.error.code}] ${parsed.error.message}`, {
					rpcCode: parsed.error.code,
					rpcMessage: parsed.error.message,
					data: parsed.error.data,
					method: entry.method,
				}),
			);
			return;
		}
		entry.resolve(parsed.result);
	}

	private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
		for (const handler of this.serverRequestHandlers) {
			let result: unknown;
			try {
				result = await handler(request);
			} catch (cause) {
				await this.send(
					jsonRpcError(request.id, JsonRpcErrorCode.InternalError, `请求处理器异常: ${String(cause)}`),
				);
				return;
			}
			if (result !== undefined) {
				await this.send(jsonRpcResponse(request.id, result));
				return;
			}
		}
		await this.send(
			jsonRpcError(
				request.id,
				JsonRpcErrorCode.MethodNotFound,
				`客户端未注册 "${request.method}" 处理器`,
			),
		);
	}

	private async pumpStderr(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const reader = proc.stderr.getReader();
		const stderrDecoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (value !== undefined) {
					this.appendStderr(stderrDecoder.decode(value, { stream: true }));
				}
			}
		} catch {
			// 进程异常退出：交给 watchExit
		}
	}

	private appendStderr(text: string): void {
		this.stderrTail += text;
		if (this.stderrTail.length > this.maxStderrBytes) {
			this.stderrTail = this.stderrTail.slice(this.stderrTail.length - this.maxStderrBytes);
			this.stderrTruncated = true;
		}
	}

	private async watchExit(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const exitCode = await proc.exited;
		if (this.closed || this.proc !== proc) {
			return; // close() 接管终态
		}
		this.proc = null;
		this.rejectPending(new LspError("server-exited", "LSP 服务器进程已退出，未决请求被取消"));
		this.emitTerminal({
			code: "server-exited",
			exitCode,
			signal: proc.signalCode ?? null,
			message: `LSP 服务器进程退出 (code=${exitCode})`,
		});
	}

	private rejectPending(cause: LspError): void {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(cause);
		}
		this.pending.clear();
	}

	private emitTerminal(event: LspCloseEvent): void {
		if (this.terminalEmitted) {
			return;
		}
		this.terminalEmitted = true;
		for (const callback of this.closeCallbacks) {
			callback(event);
		}
	}
}
