/**
 * BI-25.2 —— acp 会话桥接面：session/new + session/prompt + session/end。
 *
 * 接缝⑤（端口注入，不跨包 import；基座 BI-24.1 dispatch.ts v1 握手帧）：
 * core 不 import @bi/mcp，本文件按 @bi/mcp AcpBridge 的公开协议形状做
 * core 侧镜像实现（方法名 / 字段名 / 应用错误码段一致），装配归属本命令层。
 *
 * 协议面（agent 侧 = JSON-RPC server，Content-Length 头帧，\r\n\r\n 房规）：
 * - initialize     → { protocolVersion, agentCapabilities, authMethods }（v1 握手形状不变）；
 * - session/new    → SessionManager.createSession 落 JSONL，回 { sessionId }；
 * - session/prompt → 入参 { sessionId, content: [{ type: "text", text }] }：
 *     文本增量以 session/update 通知（agent_message_chunk 语义）流式推回，
 *     终帧 { stopReason: "end_turn" | "max_tokens" }；
 * - session/end    → 会话收束（连接内状态移除，JSONL 已落盘），回 { sessionId, ended: true }；
 * - 未知请求 -32601 / 解析错 -32700 / 非对象 -32600 / 通知静默（v1 不回归）。
 *
 * 生命周期：连接内 sessions Map 持活跃会话（内存对话历史 + JSONL 链尾指针），
 * 同一 acp 连续 prompt 落同一 JSONL 会话链（parentId 链式追加）；session/prompt
 * 派发为不阻塞读泵的在飞任务（EOF 收束时统一 drain），在飞期间同会话新请求 →
 * -32004 忙错误（不串流）；连接关闭（EOF）→ 等待在飞回合完成后收束。
 * 出站帧经单队列串行化，帧与帧字节不交叠；汇总统计由调用方走 err（协议
 * stdout 纯净，沿用 v1 约定）。
 *
 * 错误码（core 侧镜像 @bi/mcp AcpErrorCode 应用段，LSP 房规同段）：
 *   -32003 SessionNotFound / -32004 PromptBusy / -32005 AgentPortMissing / -32006 PromptFailed。
 *
 * 诚实边界（归后续卡）：
 * - 工具不挂（与 bin v1 一致）：stream 恒传空工具表，tool_call / tool_call_update
 *   更新帧不存在；模型若强回 tool_use 停止 → 结构化 -32006 拒绝续跑；
 * - 取消语义未接（无 session/cancel 方法、无 abort 传导给模型流）；
 * - 多会话并行未支持（连接内可多次 session/new，但调度与互相隔离归后续卡）；
 * - thinking_delta / signature_delta / usage 事件静默丢弃（无 thought 块透传）；
 * - initialize 门禁未强制（v1 握手宽松兼容，未握手调会话方法不回 -32002）。
 */
import type { AgentMessage, StopReason, StreamEvent, TextBlock } from "../../adapters/deepseek-adapter";
import type { SessionManager } from "../../session/manager";
import type { JsonValue } from "../../session/types";
import type { ModelPort } from "../headless";

/** ACP 协议版本（core 侧镜像 @bi/mcp ACP_PROTOCOL_VERSION = 1）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** 头帧结束标记（与 lsp-stdio-transport 同为 \r\n\r\n 房规）。 */
const ACP_HEADER_END = "\r\n\r\n";

const ACP_ENCODER = new TextEncoder();

/** ACP 应用层错误码（镜像 @bi/mcp AcpErrorCode；-32002 NotInitialized 未启用见头注）。 */
export const ACP_APP_ERROR = {
	/** sessionId 不存在（或 session/end 后复用）。 */
	SessionNotFound: -32003,
	/** 同会话已有在飞 prompt（单会话单飞）。 */
	PromptBusy: -32004,
	/** 模型端口未注入或装配失败（不假冒）。 */
	AgentPortMissing: -32005,
	/** 模型端口执行失败（流错误 / 不可继续的停止原因）。 */
	PromptFailed: -32006,
} as const;

/** 连接级统计（结构化汇总由 dispatch 走 err）。 */
export interface AcpConnectionStats {
	initialize: number;
	sessionNew: number;
	promptTurns: number;
	busyRefusals: number;
	sessionEnds: number;
	notifications: number;
	methodNotFound: number;
	parseErrors: number;
}

/** 连接装配参数（IO 与会话根由 dispatch 注入；测试两通道齐注不触碰真实 stdio）。 */
export interface AcpConnectionOptions {
	input: ReadableStream<Uint8Array>;
	output: { write(chunk: Uint8Array): void | Promise<void> };
	manager: SessionManager;
	/**
	 * 模型端口工厂（session/prompt 每回合调用一次；生产路径由 main/bin 传入
	 * 配置装配的真实端口，测试注入脚本化替身）。未注入时 prompt 结构化
	 * -32005 拒绝执行，不假冒。
	 */
	buildModelPort?: () => ModelPort | Promise<ModelPort>;
}

/** 连接内活跃会话：内存对话历史 + JSONL 链尾指针 + 单飞标记。 */
interface AcpLiveSession {
	readonly sessionId: string;
	/** 模型对话内存历史（每回合追加 user/assistant；跨 prompt 续聊）。 */
	history: AgentMessage[];
	/** JSONL 链尾指针（下一条 append 的 parentId；undefined = 尚无根条目）。 */
	lastEntryId: string | undefined;
	/** 单会话单飞：在飞 prompt 期间拒绝新请求（-32004）。 */
	busy: boolean;
}

/** 端口不可用（未注入 / 装配抛错）——回合内映射 -32005，不与执行失败混码。 */
class AcpPortError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "AcpPortError";
	}
}

/**
 * acp 会话连接：头帧读泵 + 方法分派 + 会话/单飞状态机。
 * 用法：`await new AcpSessionConnection(options).run()`——跑到 EOF 收束，
 * 返回统计。session/prompt 在飞派发不阻塞读泵（忙错误可达）。
 */
export class AcpSessionConnection {
	readonly #options: AcpConnectionOptions;
	readonly #sessions = new Map<string, AcpLiveSession>();
	/** 在飞 prompt 回合（EOF 收束前统一 drain）。 */
	readonly #pending = new Set<Promise<void>>();
	readonly #stats: AcpConnectionStats = {
		initialize: 0,
		sessionNew: 0,
		promptTurns: 0,
		busyRefusals: 0,
		sessionEnds: 0,
		notifications: 0,
		methodNotFound: 0,
		parseErrors: 0,
	};
	/** 出站帧串行化链：入队顺序即落序，帧内字节不交叠。 */
	#sendQueue: Promise<void> = Promise.resolve();

	constructor(options: AcpConnectionOptions) {
		this.#options = options;
	}

	/** 统计快照（汇总行用）。 */
	get stats(): AcpConnectionStats {
		return { ...this.#stats };
	}

	/** 逐帧读泵至 EOF；prompt 请求派发为在飞任务不阻塞读；EOF 后 drain 收束。 */
	async run(): Promise<AcpConnectionStats> {
		const reader = this.#options.input.getReader();
		let buffer: Uint8Array = new Uint8Array(0);
		for (;;) {
			const extracted = tryExtractAcpFrame(buffer);
			if (extracted === null) {
				const next = await reader.read();
				if (next.done) break; // EOF：不足一帧的残余半帧静默丢弃（v1 房规）
				buffer = concatBytes(buffer, next.value);
				continue;
			}
			buffer = extracted.rest;
			await this.#handlePayload(extracted.payload);
		}
		await this.#drain();
		return this.stats;
	}

	// ---------- 出站帧 ----------

	/** 单帧写出（编码 + 入串行化队列；队列断链自愈，单帧写失败不拖垮连接）。 */
	#send(payloadText: string): Promise<void> {
		const run = this.#sendQueue.then(() => this.#writeFrame(payloadText));
		this.#sendQueue = run.catch(() => undefined);
		return run;
	}

	async #writeFrame(payloadText: string): Promise<void> {
		const body = ACP_ENCODER.encode(payloadText);
		const header = ACP_ENCODER.encode(`Content-Length: ${body.byteLength}${ACP_HEADER_END}`);
		const frame = new Uint8Array(header.byteLength + body.byteLength);
		frame.set(header, 0);
		frame.set(body, header.byteLength);
		await this.#options.output.write(frame);
	}

	#sendResult(id: unknown, result: unknown): Promise<void> {
		return this.#send(JSON.stringify({ jsonrpc: "2.0", id, result }));
	}

	#sendError(id: unknown, code: number, message: string): Promise<void> {
		return this.#send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
	}

	/** session/update 通知（agent_message_chunk 等更新语义的载体）。 */
	#notifyUpdate(sessionId: string, update: unknown): Promise<void> {
		return this.#send(
			JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }),
		);
	}

	// ---------- 入站分派 ----------

	async #handlePayload(payload: Uint8Array): Promise<void> {
		let message: unknown;
		try {
			message = JSON.parse(new TextDecoder().decode(payload));
		} catch {
			this.#stats.parseErrors += 1;
			await this.#sendError(null, -32700, "Parse error");
			return;
		}
		if (typeof message !== "object" || message === null) {
			this.#stats.parseErrors += 1;
			await this.#sendError(null, -32600, "Invalid Request");
			return;
		}
		const record = message as { id?: unknown; method?: unknown; params?: unknown };
		if (typeof record.method !== "string") return; // 客户端响应帧：忽略
		if (record.id === undefined) {
			this.#stats.notifications += 1; // 通知：接受不回执（与 @bi/mcp 桥同房规）
			return;
		}
		if (record.method === "session/prompt") {
			this.#dispatchPrompt(record.id, record.params);
			return;
		}
		await this.#handleRequest(record.id, record.method, record.params);
	}

	async #handleRequest(id: unknown, method: string, params: unknown): Promise<void> {
		switch (method) {
			case "initialize":
				this.#stats.initialize += 1;
				await this.#sendResult(id, {
					protocolVersion: ACP_PROTOCOL_VERSION,
					agentCapabilities: {},
					authMethods: [],
				});
				return;
			case "session/new":
				await this.#handleSessionNew(id, params);
				return;
			case "session/end":
				await this.#handleSessionEnd(id, params);
				return;
			default:
				this.#stats.methodNotFound += 1;
				await this.#sendError(id, -32601, `未知方法 "${method}"`);
		}
	}

	// ---------- session/new ----------

	async #handleSessionNew(id: unknown, params: unknown): Promise<void> {
		const record = asRecord(params);
		const create: { title?: string; cwd?: string } = {};
		const title = record?.["title"];
		if (typeof title === "string" && title !== "") create.title = title;
		const cwd = record?.["cwd"];
		if (typeof cwd === "string" && cwd !== "") create.cwd = cwd;
		try {
			const meta = await this.#options.manager.createSession(create);
			this.#sessions.set(meta.sessionId, {
				sessionId: meta.sessionId,
				history: [],
				lastEntryId: undefined,
				busy: false,
			});
			this.#stats.sessionNew += 1;
			await this.#sendResult(id, { sessionId: meta.sessionId });
		} catch (cause) {
			await this.#sendError(id, -32603, `session/new 失败: ${errorMessage(cause)}`);
		}
	}

	// ---------- session/end ----------

	async #handleSessionEnd(id: unknown, params: unknown): Promise<void> {
		const record = asRecord(params);
		const sessionId = record?.["sessionId"];
		if (typeof sessionId !== "string" || sessionId === "") {
			await this.#sendError(id, -32602, "session/end 需要 { sessionId } 参数");
			return;
		}
		const session = this.#sessions.get(sessionId);
		if (session === undefined) {
			await this.#sendError(id, ACP_APP_ERROR.SessionNotFound, `会话不存在: ${sessionId}`);
			return;
		}
		if (session.busy) {
			this.#stats.busyRefusals += 1;
			await this.#sendError(id, ACP_APP_ERROR.PromptBusy, "该会话已有在飞 prompt，拒绝 session/end");
			return;
		}
		this.#sessions.delete(sessionId); // JSONL 已落盘：连接内状态优雅移除
		this.#stats.sessionEnds += 1;
		await this.#sendResult(id, { sessionId, ended: true });
	}

	// ---------- session/prompt（单会话单飞） ----------

	/**
	 * prompt 在飞派发：读泵不等待回合完成（忙错误可达）。回合内一切失败
	 * 均已结构化回执为错误帧，此处兜底吞异常防 unhandled rejection。
	 */
	#dispatchPrompt(id: unknown, params: unknown): void {
		const turn = this.#runPromptTurn(id, params).catch(() => undefined);
		this.#pending.add(turn);
		void turn.finally(() => {
			this.#pending.delete(turn);
		});
	}

	async #runPromptTurn(id: unknown, params: unknown): Promise<void> {
		// 参数校验（同步段：忙检查后立即置忙，杜绝并发窗口）
		const record = asRecord(params);
		if (record === undefined) {
			await this.#sendError(id, -32602, "session/prompt 需要 { sessionId, content } 参数");
			return;
		}
		const sessionId = record["sessionId"];
		if (typeof sessionId !== "string" || sessionId === "") {
			await this.#sendError(id, -32602, "sessionId 缺失或类型非法");
			return;
		}
		const session = this.#sessions.get(sessionId);
		if (session === undefined) {
			await this.#sendError(id, ACP_APP_ERROR.SessionNotFound, `会话不存在: ${sessionId}`);
			return;
		}
		const text = Array.isArray(record["content"]) ? extractText(record["content"]) : undefined;
		if (text === undefined || text === "") {
			await this.#sendError(id, -32602, "content 必须为含文本块的非空数组");
			return;
		}
		if (session.busy) {
			this.#stats.busyRefusals += 1;
			await this.#sendError(id, ACP_APP_ERROR.PromptBusy, "该会话已有在飞 prompt");
			return;
		}
		session.busy = true;
		try {
			await this.#streamTurn(session, id, text);
		} catch (cause) {
			const code = cause instanceof AcpPortError ? cause.code : ACP_APP_ERROR.PromptFailed;
			await this.#sendError(id, code, `prompt 回合失败: ${errorMessage(cause)}`);
		} finally {
			session.busy = false;
		}
	}

	/** 单回合：用户条目入链 → 模型流（增量逐帧通知）→ 助手条目入链 → 终帧。 */
	async #streamTurn(session: AcpLiveSession, id: unknown, text: string): Promise<void> {
		const port = await this.#resolvePort(session.sessionId);
		this.#stats.promptTurns += 1; // 只计实际开跑的模型回合（端口缺失/装配失败不计）
		const userEntry = await this.#options.manager.append(
			session.sessionId,
			session.lastEntryId ?? null,
			{ type: "user", payload: { text } as unknown as JsonValue },
		);
		session.lastEntryId = userEntry.id;
		const messages: AgentMessage[] = [...session.history, { role: "user", content: text }];
		let reply = "";
		let stop: StopReason = null;
		for await (const event of port.stream({ messages, tools: [] })) {
			if (event.type === "content_delta") {
				reply += event.delta;
				await this.#notifyUpdate(session.sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: event.delta },
				});
			} else if (event.type === "done") {
				stop = event.stopReason;
			} else if (event.type === "error") {
				throw new Error(`模型流错误 ${event.error.code}: ${event.error.message}`);
			}
			// thinking_delta / signature_delta / tool_call_delta / usage：静默丢弃（诚实边界见头注）
		}
		const content: TextBlock[] = reply === "" ? [] : [{ type: "text", text: reply }];
		const assistantEntry = await this.#options.manager.append(
			session.sessionId,
			session.lastEntryId,
			{ type: "assistant", payload: { content } as unknown as JsonValue },
		);
		session.lastEntryId = assistantEntry.id;
		session.history = [...messages, { role: "assistant", content }];
		if (stop === "tool_use" || stop === "error") {
			throw new Error(`不可继续的停止原因: ${String(stop)}（本桥接不挂工具，tool_use 归后续卡）`);
		}
		await this.#sendResult(id, { stopReason: stop === "length" ? "max_tokens" : "end_turn" });
	}

	/** 端口解析：未注入 / 装配抛错 → -32005（不假冒），执行期失败归 -32006。 */
	async #resolvePort(sessionId: string): Promise<ModelPort> {
		const build = this.#options.buildModelPort;
		if (build === undefined) {
			throw new AcpPortError(
				ACP_APP_ERROR.AgentPortMissing,
				"模型端口未注入（SubcommandDeps.buildModelPort），拒绝执行 prompt（不假冒）",
			);
		}
		try {
			return await build();
		} catch (cause) {
			throw new AcpPortError(ACP_APP_ERROR.AgentPortMissing, `模型端口装配失败: ${errorMessage(cause)}`);
		}
	}

	// ---------- 收束 ----------

	/** EOF 收束：等全部在飞回合落帧，再等出站队列清空。 */
	async #drain(): Promise<void> {
		while (this.#pending.size > 0) {
			await Promise.all([...this.#pending]);
		}
		await this.#sendQueue;
	}
}

// ---------- 头帧编解码（BI-24.1 v1 原样迁移） ----------

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const merged = new Uint8Array(a.byteLength + b.byteLength);
	merged.set(a, 0);
	merged.set(b, a.byteLength);
	return merged;
}

/**
 * 从缓冲区头部尝试抽取一帧（Content-Length 头帧协议，Content-Length 按
 * UTF-8 字节计）。缓冲不足 → null；头部非法 → 交空 payload 走 ParseError。
 */
function tryExtractAcpFrame(buffer: Uint8Array): { payload: Uint8Array; rest: Uint8Array } | null {
	let headerEnd = -1;
	for (let i = 0; i + 4 <= buffer.byteLength; i++) {
		if (
			buffer[i] === 13 && buffer[i + 1] === 10 &&
			buffer[i + 2] === 13 && buffer[i + 3] === 10
		) {
			headerEnd = i;
			break;
		}
	}
	if (headerEnd === -1) return null;
	const headerText = new TextDecoder("ascii").decode(buffer.subarray(0, headerEnd));
	let length = Number.NaN;
	for (const line of headerText.split("\r\n")) {
		const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
		if (match !== null) length = Number.parseInt(match[1] ?? "", 10);
	}
	if (!Number.isFinite(length) || length < 0) {
		// 非法头部块：整块丢弃（payload 为空 → 交 JSON 层记 ParseError），继续收帧
		return { payload: new Uint8Array(0), rest: buffer.subarray(headerEnd + 4) };
	}
	const total = headerEnd + 4 + length;
	if (buffer.byteLength < total) return null; // 体未到齐，等下一块
	return { payload: buffer.subarray(headerEnd + 4, total), rest: buffer.subarray(total) };
}

// ---------- 内部工具 ----------

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** 抽取内容块纯文本（type 缺省视为 text；裸字符串宽容；其余块跳过——与 @bi/mcp 桥同规则）。 */
function extractText(blocks: readonly unknown[]): string {
	let text = "";
	for (const block of blocks) {
		if (typeof block === "string") {
			text += block;
			continue;
		}
		if (typeof block !== "object" || block === null) continue;
		const record = asRecord(block);
		const type = record?.["type"];
		const value = record?.["text"];
		if ((type === undefined || type === "text") && typeof value === "string") {
			text += value;
		}
	}
	return text;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
