/**
 * @bi/mcp —— ACP (Agent Client Protocol) IDE 桥接面（BI-20.6）。
 *
 * 接缝⑤：ACP server 基座复用已关单 BI-13 的 McpClient 生态——
 * JSON-RPC 2.0 信封/错误码复用 protocol.ts 纯函数，Content-Length 头帧
 * 复用 lsp-stdio-transport 的纯函数（encodeLspFrame / LspFrameReader，
 * 同为 \r\n\r\n 头帧协议，多字节 UTF-8 按字节计长）；本文件不重复造帧。
 *
 * 本包与 @bi/core 零依赖（房规：跨包接线经端口注入，不 import），
 * AgentLoop 装配归属 core 侧 acp-command（结构等价端口对接）。
 *
 * 协议面（agent 侧 = JSON-RPC server，IDE 为 client）：
 * - `initialize`     → 回应 protocolVersion / agentCapabilities / authMethods；
 * - `session/new`    → 开会话（cwd/mcpServers/kap 兼容字段），回 sessionId；
 * - `session/prompt` → 输入投递 AgentPort 端口，端口 emit 的更新以
 *   `session/update` 通知流式回执（思考流 + 工具调用 tool_call /
 *   tool_call_update 形态），完成后回 { stopReason }；
 *   `agent/prompt` 为兼容别名（同参同语义）；
 * - 客户端通知 `initialized` 接受不回执；未知通知静默；未知请求 MethodNotFound。
 *
 * KAP 头协议兼容（预留）：入站 payload 顶层 `kap` 字段（次选 params.kap），
 * 结构不限、只透传不解读——请求响应在信封顶层原样回显，会话级 kap
 * 随 `session/update` 通知透出。无 kap 的流量零影响。
 *
 * 错误形态：JSON-RPC 标准码（ParseError/InvalidRequest/MethodNotFound/
 * InvalidParams/InternalError）+ ACP 应用码（-32002..-32006，LSP 房规同段），
 * 结构化错误 data 携带上下文。
 */
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest } from "../protocol";
import {
	JsonRpcErrorCode,
	isJsonRpcMessage,
	jsonRpcError,
	jsonRpcNotification,
	jsonRpcResponse,
} from "../protocol";
import { LspFrameReader, encodeLspFrame } from "../lsp/lsp-stdio-transport";

// ---------- 协议常量与结构化错误 ----------

/** 本桥接面支持的 ACP 协议版本（initialize 握手回应值）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP 应用层错误码（JSON-RPC server error 段，LSP 房规同段复用）。 */
export const AcpErrorCode = {
	/** 未完成 initialize 握手就调用会话方法。 */
	NotInitialized: -32002,
	/** sessionId 不存在。 */
	SessionNotFound: -32003,
	/** 同会话已有在飞 prompt（单会话单飞）。 */
	PromptBusy: -32004,
	/** agent 端口未注入。 */
	AgentPortMissing: -32005,
	/** agent 端口执行抛错。 */
	PromptFailed: -32006,
} as const;

export type AcpErrorCodeValue = (typeof AcpErrorCode)[keyof typeof AcpErrorCode];

/** ACP 域结构化错误：code 可编程判别，data 携带上下文。 */
export class AcpError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "AcpError";
		this.code = code;
		if (data !== undefined) {
			this.data = data;
		}
	}
}

// ---------- 端口契约（agent 执行体，core 侧 AgentLoop 装配） ----------

/** 工具调用回执形态的种类（ACP tool kind 兼容值域）。 */
export type AcpToolCallKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "other";

/** 工具调用回执状态。 */
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** ACP 内容块（透传面：本层不解读，仅抽取 text 供端口）。 */
export interface AcpContentBlock {
	type?: string;
	text?: string;
	[extra: string]: unknown;
}

/**
 * session/update 通知的 update 载荷（判别字段 sessionUpdate）：
 * 思考流/消息流（chunk）+ 工具调用流式回执（tool_call / tool_call_update）。
 */
export type AcpSessionUpdate =
	| {
			sessionUpdate: "agent_message_chunk";
			content: { type: "text"; text: string };
	  }
	| {
			sessionUpdate: "agent_thought_chunk";
			content: { type: "text"; text: string };
	  }
	| {
			sessionUpdate: "tool_call";
			toolCallId: string;
			title: string;
			kind?: AcpToolCallKind;
			status?: AcpToolCallStatus;
			rawInput?: unknown;
	  }
	| {
			sessionUpdate: "tool_call_update";
			toolCallId: string;
			status?: AcpToolCallStatus;
			output?: unknown;
			error?: string;
	  };

/** prompt 终止原因（ACP 兼容值域，端口可回自定义串）。 */
export type AcpStopReason = "end_turn" | "max_tokens" | "refusal" | "cancelled";

/** prompt 输入：抽取的纯文本 + 原始内容块（透传）。 */
export interface AcpPromptInput {
	text: string;
	blocks: readonly AcpContentBlock[];
}

/** prompt 执行上下文：emit 的更新经桥接面变成 session/update 通知。 */
export interface AcpPromptContext {
	sessionId: string;
	/** 客户端断连/桥接面关闭时 abort。 */
	signal: AbortSignal;
	emit(update: AcpSessionUpdate): void;
}

/**
 * agent 执行端口（接缝⑤）：桥接面只认本接口；core 侧 acp-command 用
 * AgentLoop 装配结构等价实现注入（本包不 import @bi/core）。
 */
export interface AcpAgentPort {
	prompt(
		input: AcpPromptInput,
		ctx: AcpPromptContext,
	): Promise<{ stopReason: AcpStopReason | string }>;
}

// ---------- KAP 头协议兼容（预留透传面） ----------

/**
 * 从入站消息提取 KAP 头：顶层 `payload.kap` 优先，次选 `params.kap`；
 * 结构不限（unknown 透传），缺失返回 undefined。
 */
export function extractKap(message: unknown): unknown {
	if (typeof message !== "object" || message === null) {
		return undefined;
	}
	const record = message as Record<string, unknown>;
	if (record["kap"] !== undefined) {
		return record["kap"];
	}
	const params = record["params"];
	if (typeof params === "object" && params !== null) {
		const kap = (params as Record<string, unknown>)["kap"];
		if (kap !== undefined) {
			return kap;
		}
	}
	return undefined;
}

/** 在出站信封上附加顶层 kap（undefined 时零改动）。 */
function withKap<T extends object>(envelope: T, kap: unknown): T {
	if (kap === undefined) {
		return envelope;
	}
	return { ...envelope, kap } as T;
}

/** 未知 id 的错误响应信封用 null id（JSON-RPC 规范允许；protocol.ts 类型面未收编，本地桥接）。 */
const UNKNOWN_ID = null as unknown as JsonRpcId;

// ---------- 会话与桥接面 ----------

interface AcpSession {
	readonly id: string;
	/** 会话级 KAP 头（session/new 时捕获，随 session/update 透出）。 */
	kap?: unknown;
}

export interface AcpBridgeOptions {
	/** 测试注入：代替 stdin 的可读字节流（缺省用 Bun.stdin.stream()）。 */
	input?: ReadableStream<Uint8Array>;
	/** 测试注入：代替 stdout 的接收器（缺省写 process.stdout）。 */
	output?: { write(chunk: Uint8Array): void | Promise<void> };
	/** agent 执行端口（接缝⑤；缺省时 prompt 报 AgentPortMissing）。 */
	agent?: AcpAgentPort;
	/** initialize 回应的协议版本（缺省 ACP_PROTOCOL_VERSION）。 */
	protocolVersion?: number;
	/** initialize 回应的 agent 信息标识（缺省 "bi-acp-bridge"）。 */
	agentName?: string;
}

/** initialize 成功结果的回执形态。 */
export interface AcpInitializeResult {
	protocolVersion: number;
	agentInfo: { name: string; version: string };
	agentCapabilities: {
		loadSession: boolean;
		promptCapabilities: { audio: boolean; embeddedContext: boolean; image: boolean };
	};
	authMethods: readonly never[];
}

const AGENT_INFO_VERSION = "0.1.0";
const ACP_PROMPT_METHODS = new Set(["session/prompt", "agent/prompt"]);

/**
 * ACP stdio 桥接面：头帧读写 + 方法分派 + 会话/单飞 prompt 状态机。
 * 入站处理串行化（promise 链），保证同会话 session/update 通知先于
 * prompt 响应落序；单会话单飞（并发 prompt → PromptBusy）。
 */
export class AcpBridge {
	private readonly injectedInput?: ReadableStream<Uint8Array>;
	private readonly injectedOutput?: { write(chunk: Uint8Array): void | Promise<void> };
	private readonly agent?: AcpAgentPort;
	private readonly protocolVersion: number;
	private readonly agentName: string;

	private readonly frameReader = new LspFrameReader();
	private readonly sessions = new Map<string, AcpSession>();
	private readonly busySessions = new Set<string>();
	private readonly promptControllers = new Map<string, AbortController>();

	private initialized = false;
	private closed = false;
	private malformedCount = 0;
	private connectionKap: unknown;
	private pumpHandle: ReadableStreamDefaultReader<Uint8Array> | null = null;

	constructor(options: AcpBridgeOptions = {}) {
		this.injectedInput = options.input;
		this.injectedOutput = options.output;
		this.agent = options.agent;
		this.protocolVersion = options.protocolVersion ?? ACP_PROTOCOL_VERSION;
		this.agentName = options.agentName ?? "bi-acp-bridge";
	}

	/** 连接级 KAP 头（最近一次入站消息捕获；测试观测用）。 */
	get kap(): unknown {
		return this.connectionKap;
	}

	/** 已开会话 id（到达序）。 */
	getSessionIds(): readonly string[] {
		return [...this.sessions.keys()];
	}

	/** 畸形入站帧计数（非 JSON / 结构非法 / 缺 Content-Length 头）。 */
	getMalformedCount(): number {
		return this.malformedCount;
	}

	/**
	 * 启动 stdio 泵：注入流优先，否则回落进程 stdio。
	 * 只挂泵不改进程状态；stop() 后幂等返回。
	 */
	async start(): Promise<void> {
		if (this.closed) {
			throw new AcpError(JsonRpcErrorCode.InvalidRequest, "桥接面已 stop，请新建实例");
		}
		if (this.pumpHandle !== null) {
			return; // 已启动
		}
		const input =
			this.injectedInput ??
			(typeof Bun !== "undefined" ? Bun.stdin.stream() : undefined);
		if (input !== undefined) {
			void this.pump(input);
			return;
		}
		// 注入流缺失且无 Bun stdin（非 Bun 运行时）：走 node:process.stdin 异步迭代。
		void this.pumpNodeStdin();
	}

	/** 停止桥接面：abort 全部在飞 prompt 并退出泵。幂等。 */
	async stop(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const controller of this.promptControllers.values()) {
			controller.abort();
		}
		this.promptControllers.clear();
		const handle = this.pumpHandle;
		this.pumpHandle = null;
		if (handle !== null) {
			try {
				await handle.cancel();
			} catch {
				// 流已关闭：忽略
			}
		}
	}

	/** 喂入原始字节（头帧拆解，支持粘包/半包/畸形帧）。测试与泵共用。 */
	async pushBytes(chunk: Uint8Array): Promise<void> {
		const { frames, malformed } = this.frameReader.push(chunk);
		this.malformedCount += malformed;
		// 并发分派：prompt 期间到达的后续帧仍能及时处理（单会话单飞由
		// busySessions 保证）；同一 prompt 内的通知→响应落序由 emitChain 保证。
		await Promise.all(frames.map((frame) => this.handlePayload(frame)));
	}

	/** 直派一条已解析消息（跳过头帧层；测试用）。 */
	async handleMessage(message: JsonRpcMessage): Promise<void> {
		await this.dispatch(message);
	}

	/** 发送一条 session/update 通知（含会话级 kap 透出）。 */
	async notifySessionUpdate(sessionId: string, update: AcpSessionUpdate): Promise<void> {
		const session = this.sessions.get(sessionId);
		const params = { sessionId, update };
		const envelope = withKap(jsonRpcNotification("session/update", params), session?.kap ?? this.connectionKap);
		await this.sendEnvelope(envelope);
	}

	// ---------- 内部：泵与信封 ----------

	private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		this.pumpHandle = reader;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				if (value !== undefined) {
					await this.pushBytes(value);
				}
			}
		} catch {
			// 流读失败：交由 stop() 收尾
		}
	}

	private async pumpNodeStdin(): Promise<void> {
		const { stdin } = await import("node:process");
		try {
			for await (const chunk of stdin) {
				const bytes =
					typeof chunk === "string"
						? new TextEncoder().encode(chunk)
						: new Uint8Array(chunk as ArrayBufferLike);
				await this.pushBytes(bytes);
			}
		} catch {
			// stdin 关闭/读失败：交由 stop() 收尾
		}
	}

	private async sendEnvelope(envelope: object): Promise<void> {
		const output = this.injectedOutput ?? defaultStdoutSink();
		if (this.closed) {
			throw new AcpError(JsonRpcErrorCode.InvalidRequest, "桥接面已 stop，无法发送");
		}
		const frame = encodeLspFrame(JSON.stringify(envelope));
		await output.write(frame);
	}

	// ---------- 内部：payload 分派 ----------

	private async handlePayload(payload: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			this.malformedCount += 1;
			await this.sendEnvelope(
				jsonRpcError(UNKNOWN_ID, JsonRpcErrorCode.ParseError, "payload 不是合法 JSON"),
			);
			return;
		}
		if (!isJsonRpcMessage(parsed)) {
			this.malformedCount += 1;
			await this.sendEnvelope(
				jsonRpcError(UNKNOWN_ID, JsonRpcErrorCode.InvalidRequest, "payload 不是合法 JSON-RPC 2.0 消息"),
			);
			return;
		}
		await this.dispatch(parsed);
	}

	private async dispatch(message: JsonRpcMessage): Promise<void> {
		const kap = extractKap(message);
		if (kap !== undefined) {
			this.connectionKap = kap;
		}
		if ("method" in message) {
			if ("id" in message) {
				await this.handleRequest(message as JsonRpcRequest, kap);
				return;
			}
			await this.handleNotification(message.method, message.params);
			return;
		}
		// 本端不发起请求，收到响应视为畸形（不计入 malformed：结构合法）。
		this.malformedCount += 1;
	}

	private async handleRequest(request: JsonRpcRequest, kap: unknown): Promise<void> {
		const { id, method, params } = request;
		try {
			const result = await this.invokeMethod(method, params, kap);
			await this.sendEnvelope(withKap(jsonRpcResponse(id, result), kap));
		} catch (cause) {
			const error = cause instanceof AcpError ? cause : undefined;
			try {
				await this.sendEnvelope(
					withKap(
						jsonRpcError(
							id,
							error?.code ?? JsonRpcErrorCode.InternalError,
							cause instanceof Error ? cause.message : String(cause),
							error?.data,
						),
						kap,
					),
				);
			} catch {
				// 桥接面已 stop 等发送失败：错误回执不可达，放弃（不掩盖原始异常）。
			}
		}
	}

	private async invokeMethod(method: string, params: unknown, kap: unknown): Promise<unknown> {
		switch (method) {
			case "initialize":
				return this.handleInitialize(params);
			case "session/new":
				this.assertInitialized();
				return this.handleSessionNew(params, kap);
			case "session/prompt":
			case "agent/prompt": // 兼容别名
				this.assertInitialized();
				return this.handlePrompt(method, params);
			default:
				throw new AcpError(JsonRpcErrorCode.MethodNotFound, `未知方法 "${method}"`, { method });
		}
	}

	private assertInitialized(): void {
		if (!this.initialized) {
			throw new AcpError(
				AcpErrorCode.NotInitialized,
				"未完成 initialize 握手，拒绝会话方法",
				{ method: "session" },
			);
		}
	}

	private handleInitialize(_params: unknown): AcpInitializeResult {
		this.initialized = true;
		return {
			protocolVersion: this.protocolVersion,
			agentInfo: { name: this.agentName, version: AGENT_INFO_VERSION },
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { audio: false, embeddedContext: false, image: false },
			},
			authMethods: [],
		};
	}

	private handleSessionNew(params: unknown, kap: unknown): { sessionId: string } {
		const record = asRecord(params);
		const session: AcpSession = { id: newSessionId() };
		const sessionKap = record !== undefined && record["kap"] !== undefined ? record["kap"] : kap;
		if (sessionKap !== undefined) {
			session.kap = sessionKap;
		}
		this.sessions.set(session.id, session);
		return { sessionId: session.id };
	}

	private async handlePrompt(_method: string, params: unknown): Promise<{ stopReason: string }> {
		const record = asRecord(params);
		if (record === undefined) {
			throw new AcpError(JsonRpcErrorCode.InvalidParams, "prompt 需要 { sessionId, content } 参数", {
				field: "params",
			});
		}
		const sessionId = record["sessionId"];
		if (typeof sessionId !== "string" || sessionId.length === 0) {
			throw new AcpError(JsonRpcErrorCode.InvalidParams, "sessionId 缺失或类型非法", {
				field: "sessionId",
			});
		}
		const session = this.sessions.get(sessionId);
		if (session === undefined) {
			throw new AcpError(AcpErrorCode.SessionNotFound, `会话不存在: ${sessionId}`, { sessionId });
		}
		const blocks = record["content"];
		if (!Array.isArray(blocks)) {
			throw new AcpError(JsonRpcErrorCode.InvalidParams, "content 必须为内容块数组", {
				field: "content",
			});
		}
		if (this.agent === undefined) {
			throw new AcpError(AcpErrorCode.AgentPortMissing, "agent 端口未注入，无法执行 prompt", {
				sessionId,
			});
		}
		if (this.busySessions.has(sessionId)) {
			throw new AcpError(AcpErrorCode.PromptBusy, "该会话已有在飞 prompt", { sessionId });
		}
		this.busySessions.add(sessionId);
		const controller = new AbortController();
		this.promptControllers.set(sessionId, controller);
		const content = blocks as readonly AcpContentBlock[];
		const input: AcpPromptInput = { text: extractText(content), blocks: content };
		// 本 prompt 的通知落盘链：保证 session/update 先于 prompt 响应。
		let emitChain: Promise<void> = Promise.resolve();
		try {
			const outcome = await this.agent.prompt(input, {
				sessionId,
				signal: controller.signal,
				emit: (update) => {
					emitChain = emitChain.then(() => this.notifySessionUpdate(sessionId, update));
				},
			});
			await emitChain;
			return { stopReason: outcome?.stopReason ?? "end_turn" };
		} catch (cause) {
			await emitChain.catch(() => undefined);
			throw new AcpError(
				AcpErrorCode.PromptFailed,
				`agent 端口执行失败: ${cause instanceof Error ? cause.message : String(cause)}`,
				{ sessionId, cause: String(cause) },
			);
		} finally {
			this.busySessions.delete(sessionId);
			this.promptControllers.delete(sessionId);
		}
	}

	private async handleNotification(method: string, params: unknown): Promise<void> {
		if (method === "initialized") {
			return; // 客户端握手收尾通知：接受不回执
		}
		if (method === "session/update") {
			return; // agent→client 方向，本端不消费：静默
		}
		void params; // 未知通知静默（JSON-RPC 无回执面）
	}
}

// ---------- 内部工具 ----------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** 抽取内容块纯文本（type 缺省视为 text；其余块跳过）。 */
function extractText(blocks: readonly AcpContentBlock[]): string {
	let text = "";
	for (const block of blocks) {
		if (typeof block === "object" && block !== null) {
			const type = block["type"];
			const value = block["text"];
			if ((type === undefined || type === "text") && typeof value === "string") {
				text += value;
			}
		} else if (typeof block === "string") {
			text += block; // 宽容形态：裸字符串块
		}
	}
	return text;
}

function newSessionId(): string {
	return `ses_${globalThis.crypto.randomUUID()}`;
}

function defaultStdoutSink(): { write(chunk: Uint8Array): void | Promise<void> } {
	// 延迟解析 node:process：测试注入路径永不触碰进程流。
	return {
		write(chunk) {
			void import("node:process").then(({ stdout }) => {
				stdout.write(chunk);
			});
		},
	};
}
