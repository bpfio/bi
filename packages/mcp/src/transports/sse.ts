/**
 * @bi/mcp —— SSE 传输通道。
 *
 * 经注入的 fetch 拉取 text/event-stream，解析 event:/data:/id:/retry: 帧
 * （容忍 CRLF/LF/裸 CR、多行 data 拼接、注释行忽略）；断线按指数退避
 * 自动重连（1s→2s→…→30s 封顶，可配 maxRetries，AbortSignal 可取消）；
 * 出站消息走 HTTP POST 到 endpoint（构造时指定，或从首条 endpoint 事件解析）。
 */
import type {
	JsonRpcMessage,
	McpTransport,
	TransportCloseEvent,
} from "../protocol";
import { McpError, parseJsonRpcLine } from "../protocol";

/** 解析出的一条 SSE 事件帧。 */
export interface SseFrame {
	/** 事件名（缺省为 "message"）。 */
	event: string;
	/** data 多行按 \n 拼接后的载荷。 */
	data: string;
	/** 最近一次 id: 字段值（进入本帧时的 last-event-id）。 */
	id?: string;
	/** retry: 字段建议的重连毫秒数（出现在本帧中时才有）。 */
	retryMs?: number;
}

/**
 * SSE 帧解析器（WHATWG text/event-stream 规则的流式实现）。
 * push 接收任意切分的文本块，返回其中完整派发的事件帧；
 * flush 处理流结束时未以空行收尾的残帧。
 */
export class SseFrameParser {
	private buffer = "";
	private dataLines: string[] = [];
	private eventName: string | null = null;
	private lastEventId: string | undefined;
	private pendingRetryMs: number | undefined;

	/** 跨事件持久的 last-event-id（用于重连时回传 Last-Event-ID 头）。 */
	getLastEventId(): string | undefined {
		return this.lastEventId;
	}

	push(chunk: string): SseFrame[] {
		this.buffer += chunk;
		const frames: SseFrame[] = [];
		for (;;) {
			const line = this.takeLine();
			if (line === null) {
				break;
			}
			const frame = this.processLine(line);
			if (frame !== null) {
				frames.push(frame);
			}
		}
		return frames;
	}

	/** 流结束：处理残留行并派发未完成帧。 */
	flush(): SseFrame[] {
		const frames: SseFrame[] = [];
		if (this.buffer.length > 0) {
			const rest = this.buffer;
			this.buffer = "";
			const frame = this.processLine(rest.endsWith("\r") ? rest.slice(0, -1) : rest);
			if (frame !== null) {
				frames.push(frame);
			}
		}
		const final = this.dispatch();
		if (final !== null) {
			frames.push(final);
		}
		return frames;
	}

	/**
	 * 从缓冲中取出一条完整行（含终止符）。
	 * 行终止符：\r\n、\n、\r（\r 位于缓冲末尾时等待后续块，可能是 \r\n 的前半）。
	 */
	private takeLine(): string | null {
		for (let i = 0; i < this.buffer.length; i++) {
			const ch = this.buffer[i];
			if (ch === "\n") {
				const line = this.buffer.slice(0, i);
				this.buffer = this.buffer.slice(i + 1);
				return line.endsWith("\r") ? line.slice(0, -1) : line;
			}
			if (ch === "\r") {
				if (i === this.buffer.length - 1) {
					return null; // 可能是 CRLF 被切块，等待更多输入
				}
				const line = this.buffer.slice(0, i);
				this.buffer = this.buffer.slice(i + (this.buffer[i + 1] === "\n" ? 2 : 1));
				return line;
			}
		}
		return null;
	}

	/** 处理一行字段；返回非 null 表示派发了一个事件帧。 */
	private processLine(line: string): SseFrame | null {
		if (line.length === 0) {
			return this.dispatch();
		}
		if (line.startsWith(":")) {
			return null; // 注释行
		}
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) {
			value = value.slice(1); // 仅剥一个冒号后的空格
		}
		if (field === "data") {
			this.dataLines.push(value);
		} else if (field === "event") {
			this.eventName = value;
		} else if (field === "id") {
			if (!value.includes("\0")) {
				this.lastEventId = value;
			}
		} else if (field === "retry") {
			if (/^[0-9]+$/.test(value)) {
				this.pendingRetryMs = Number.parseInt(value, 10);
			}
		}
		// 未知字段按规范忽略
		return null;
	}

	/** 空行派发：聚合当前帧状态。 */
	private dispatch(): SseFrame | null {
		if (this.dataLines.length === 0) {
			// 无 data 的帧不派发（与规范一致），但 id/retry 已并入持久状态
			this.eventName = null;
			return null;
		}
		const frame: SseFrame = {
			event: this.eventName ?? "message",
			data: this.dataLines.join("\n"),
		};
		if (this.lastEventId !== undefined) {
			frame.id = this.lastEventId;
		}
		if (this.pendingRetryMs !== undefined) {
			frame.retryMs = this.pendingRetryMs;
			this.pendingRetryMs = undefined;
		}
		this.dataLines = [];
		this.eventName = null;
		return frame;
	}
}

/** 最小 fetch 形状（Bun 的 fetch 类型带 preconnect 等附加成员，注入点只需核心能力）。 */
export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface SseTransportOptions {
	/** SSE 流地址（GET）。 */
	url: string;
	/** 出站 POST 地址。缺省时等待流上的首条 `event: endpoint` 帧并解析（相对地址基于 url 解析）。 */
	endpointUrl?: string;
	/** fetch 注入点，缺省 globalThis.fetch（测试可注入包装以驱动本地 Bun.serve fixture）。 */
	fetchImpl?: FetchLike;
	/** 额外请求头（GET 流与 POST 出站共用）。 */
	headers?: Record<string, string>;
	/** 重连尝试次数上限（连续未收到任何入站数据记一次失败），默认无限重试。 */
	maxRetries?: number;
	/** 指数退避基数毫秒，默认 1000。 */
	baseBackoffMs?: number;
	/** 退避封顶毫秒，默认 30000。 */
	maxBackoffMs?: number;
	/** 休眠注入点 (ms, signal) => Promise，测试可注入即时假时钟；缺省真实可中断休眠。 */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** 外部取消信号：触发后停止重连并关闭传输。 */
	abortSignal?: AbortSignal;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (signal !== undefined) {
			const onAbort = (): void => {
				clearTimeout(timer);
				reject(new Error("sleep-aborted"));
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (cause: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** SSE 传输：GET 事件流入站 + HTTP POST 出站，带自动重连。 */
export class SseClientTransport implements McpTransport {
	private readonly parser = new SseFrameParser();
	private readonly messageCallbacks: Array<(message: JsonRpcMessage) => void> = [];
	private readonly closeCallbacks: Array<(event: TransportCloseEvent) => void> = [];
	private readonly fetchImpl: FetchLike;
	private readonly maxRetries: number;
	private readonly baseBackoffMs: number;
	private readonly maxBackoffMs: number;
	private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;

	private endpoint: string | null = null;
	private endpointWaiter: Deferred<string> | null = null;
	private abortController: AbortController | null = null;
	private readonly shutdown = new AbortController();
	private externalAbort = false;
	private started = false;
	private closing = false;
	private terminalEmitted = false;
	private terminalError: McpError | null = null;
	private loopDone: Promise<void> | null = null;
	private healthyTraffic = false;
	private reconnectAttempt = 0;
	private retryHintMs: number | null = null;
	private malformedCount = 0;

	constructor(private readonly opts: SseTransportOptions) {
		this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
		this.maxRetries = opts.maxRetries ?? Number.POSITIVE_INFINITY;
		this.baseBackoffMs = opts.baseBackoffMs ?? 1000;
		this.maxBackoffMs = opts.maxBackoffMs ?? 30000;
		this.sleepImpl = opts.sleep ?? defaultSleep;
		if (this.opts.abortSignal !== undefined) {
			if (this.opts.abortSignal.aborted) {
				this.externalAbort = true;
			}
			this.opts.abortSignal.addEventListener("abort", () => {
				this.externalAbort = true;
				void this.close();
			});
		}
	}

	/**
	 * 建立连接并等待出站 endpoint 就绪。
	 * endpointUrl 已配置时连接建立即可返回；否则等待首条 endpoint 事件。
	 * 初始连接失败按退避重试，重试用尽后 start() 以 connect-failed 拒绝。
	 */
	async start(): Promise<void> {
		if (this.started) {
			throw new McpError("invalid-state", "SSE 传输已启动");
		}
		this.started = true;
		if (this.opts.endpointUrl !== undefined) {
			this.endpoint = new URL(this.opts.endpointUrl, this.opts.url).toString();
		}
		this.endpointWaiter = createDeferred<string>();
		if (this.endpoint !== null) {
			this.endpointWaiter.resolve(this.endpoint);
		}
		this.loopDone = this.runLoop();
		void this.loopDone.catch(() => {}); // runLoop 按构造不 reject；防御未处理拒绝
		const settled = await Promise.race([
			this.endpointWaiter.promise.then(
				() => "ready" as const,
				() => "terminal" as const,
			),
			this.loopDone.then(() => "terminal" as const),
		]);
		if (settled === "terminal") {
			if (this.endpoint !== null) {
				return; // 终态与就绪竞态：endpoint 已知则视为启动成功
			}
			throw (
				this.terminalError ??
				new McpError("connect-failed", "SSE 连接在 endpoint 就绪前终止")
			);
		}
	}

	/** 出站：向 endpoint POST 一条 JSON-RPC 消息（回执经 SSE 流返回）。 */
	async send(message: JsonRpcMessage): Promise<void> {
		if (this.endpoint === null) {
			throw new McpError(
				"not-connected",
				"SSE 出站 endpoint 尚未就绪（等待 endpoint 事件或配置 endpointUrl）",
			);
		}
		try {
			const response = await this.fetchImpl(this.endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
				body: JSON.stringify(message),
				signal: this.abortController?.signal,
			});
			if (!response.ok) {
				throw new McpError("bad-response", `POST endpoint 返回 HTTP ${response.status}`);
			}
			await response.body?.cancel();
		} catch (cause) {
			if (cause instanceof McpError) {
				throw cause;
			}
			throw new McpError(
				this.closing ? "transport-closed" : "not-connected",
				this.closing ? "传输已关闭，POST 未送达" : "POST endpoint 失败",
				{ cause: String(cause) },
			);
		}
	}

	onMessage(callback: (message: JsonRpcMessage) => void): void {
		this.messageCallbacks.push(callback);
	}

	onClose(callback: (event: TransportCloseEvent) => void): void {
		this.closeCallbacks.push(callback);
	}

	/** 关闭传输：中止当前流与后续重连（含打断退避休眠），投递终态事件。幂等。 */
	async close(): Promise<void> {
		this.closing = true;
		this.shutdown.abort();
		this.abortController?.abort();
		this.endpointWaiter?.reject(new McpError("transport-closed", "close() 已调用，endpoint 等待中止"));
		this.emitTerminal(
			new McpError("transport-closed", "SSE 传输已主动关闭"),
			{ code: "closed", restarting: false },
		);
		await this.loopDone;
	}

	/** 被跳过的畸形入站帧数（非 JSON data 等）。 */
	getMalformedCount(): number {
		return this.malformedCount;
	}

	private async runLoop(): Promise<void> {
		try {
			for (;;) {
				if (this.closing || this.externalAbort) {
					break;
				}
				this.healthyTraffic = false;
				try {
					await this.connectAndPump();
				} catch (cause) {
					if (this.closing || this.externalAbort) {
						break;
					}
					this.reconnectAttempt++;
					if (this.reconnectAttempt > this.maxRetries) {
						this.emitTerminal(
							new McpError("connect-failed", `SSE 连接失败且重试用尽（${this.maxRetries} 次）`, {
								cause: String(cause),
							}),
							{ code: "connect-failed", restarting: false, message: String(cause) },
						);
						return;
					}
					const delay = this.nextBackoffMs(this.reconnectAttempt);
					await this.sleepImpl(delay, this.shutdown.signal);
					continue;
				}
				if (this.closing || this.externalAbort) {
					break;
				}
				// 流正常结束（对端关闭）视为一次失败尝试；有入站流量则健康重置为基数档
				const attempt = this.healthyTraffic ? 1 : this.reconnectAttempt + 1;
				this.reconnectAttempt = attempt;
				if (attempt > this.maxRetries) {
					this.emitTerminal(
						new McpError("connect-failed", `SSE 流反复断开且重试用尽（${this.maxRetries} 次）`),
						{ code: "connect-failed", restarting: false },
					);
					return;
				}
				const delay = this.nextBackoffMs(attempt);
				await this.sleepImpl(delay, this.shutdown.signal);
			}
			// 循环退出：外部取消或主动关闭
			if (this.externalAbort && !this.terminalEmitted) {
				this.emitTerminal(
					new McpError("connect-failed", "外部 AbortSignal 触发取消"),
					{ code: "connect-failed", restarting: false, message: "aborted by external signal" },
				);
			}
		} catch (cause) {
			// 防御性兜底：重连循环永不向调用方抛未捕获异常
			this.emitTerminal(
				new McpError("connect-failed", "SSE 重连循环异常终止", { cause: String(cause) }),
				{ code: "connect-failed", restarting: false, message: String(cause) },
			);
		}
	}

	private nextBackoffMs(attempt: number): number {
		if (this.retryHintMs !== null) {
			return this.retryHintMs; // 服务器 retry: 提示优先
		}
		const raw = this.baseBackoffMs * 2 ** (attempt - 1);
		return Math.min(raw, this.maxBackoffMs);
	}

	private async connectAndPump(): Promise<void> {
		const controller = new AbortController();
		this.abortController = controller;
		const headers: Record<string, string> = {
			accept: "text/event-stream",
			...(this.opts.headers ?? {}),
		};
		if (this.lastEventIdFromParser() !== undefined) {
			headers["last-event-id"] = this.lastEventIdFromParser() as string;
		}
		const response = await this.fetchImpl(this.opts.url, {
			headers,
			signal: controller.signal,
		});
		if (!response.ok || response.body === null) {
			throw new Error(`SSE 连接被拒绝: HTTP ${response.status}`);
		}
		await this.pump(response.body, controller);
	}

	private async pump(
		body: ReadableStream<Uint8Array>,
		controller: AbortController,
	): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					return;
				}
				this.healthyTraffic = true;
				for (const frame of this.parser.push(decoder.decode(value, { stream: true }))) {
					this.handleFrame(frame);
				}
			}
		} catch (cause) {
			if (controller.signal.aborted) {
				return; // 主动中止
			}
			throw cause; // 网络错误 → 重连
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// 流已关闭
			}
		}
	}

	private handleFrame(frame: SseFrame): void {
		if (frame.retryMs !== undefined) {
			this.retryHintMs = frame.retryMs;
		}
		if (frame.event === "endpoint" && this.endpoint === null) {
			try {
				this.endpoint = new URL(frame.data.trim(), this.opts.url).toString();
				this.endpointWaiter?.resolve(this.endpoint);
			} catch {
				this.malformedCount++;
			}
		}
		const parsed = parseJsonRpcLine(frame.data);
		if (!parsed.ok) {
			if (parsed.reason !== "empty-line") {
				this.malformedCount++;
			}
			return;
		}
		for (const callback of this.messageCallbacks) {
			callback(parsed.message);
		}
	}

	private emitTerminal(error: McpError, event: TransportCloseEvent): void {
		if (this.terminalEmitted) {
			return;
		}
		this.terminalEmitted = true;
		this.terminalError = error;
		this.endpointWaiter?.reject(error);
		for (const callback of this.closeCallbacks) {
			callback(event);
		}
	}

	private lastEventIdFromParser(): string | undefined {
		return this.parser.getLastEventId();
	}
}
