/**
 * FIX-A F4 · 续会话上下文重放（无头与 REPL 共用单一事实源）。
 *
 * 语义与 headless 的 --resume 历史重放一致：既有会话条目里的 user/assistant
 * 文本轮按序还原为模型消息；assistant 兼容 {text} 与 {content:[{type:"text",text}]}
 * 双形态；tool 轮不重放（归语法树语义卡，备案不重放）。
 *
 * 两处消费：
 * - 无头路径（cli/headless.ts）：把重放历史拼进本次请求的 messages；
 * - REPL 路径（bin/bi.ts）：经 withResumeHistory 包住模型端口，把重放历史前置到
 *   每次模型请求的 messages 首位（不改 agent-tui.ts 的私有消息面）。
 */
import type { AgentMessage } from "../adapters/deepseek-adapter";
import type { SessionEntry } from "../session/types";
import type { ModelPort } from "./headless";

/**
 * 既有会话条目 → 模型消息（user/assistant 文本轮；tool 轮不重放）。
 * 空文本条目跳过；无法解析的 payload 跳过（绝不把脏数据喂进模型上下文）。
 */
export function resumeContextMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type !== "user" && entry.type !== "assistant") continue;
		const payload = entry.payload as { text?: unknown; content?: unknown } | null;
		if (payload === null || typeof payload !== "object") continue;
		let text: string | undefined;
		if (typeof payload.text === "string") text = payload.text;
		else if (Array.isArray(payload.content)) {
			text = payload.content
				.filter(
					(block): block is { type: string; text: string } =>
						block !== null &&
						typeof block === "object" &&
						(block as { type?: unknown }).type === "text" &&
						typeof (block as { text?: unknown }).text === "string",
				)
				.map((block) => block.text)
				.join("");
		}
		if (text === undefined || text.length === 0) continue;
		messages.push({ role: entry.type, content: text });
	}
	return messages;
}

/**
 * 模型端口包装：把重放历史前置到每次模型请求的 messages 首位。
 * 历史为空 = 原样返回（零行为差）。
 */
export function withResumeHistory(port: ModelPort, history: readonly AgentMessage[]): ModelPort {
	if (history.length === 0) return port;
	return {
		async *stream(input) {
			yield* port.stream({ ...input, messages: [...history, ...input.messages] });
		},
	};
}
