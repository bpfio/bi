/**
 * BI-26.2 —— 本地伪模型端点(bin 级零网络零密钥 e2e 的驱动器)。
 *
 * 用 Bun.serve 在 127.0.0.1 随机端口模拟 Anthropic/OpenAI 双模态 SSE 端点:
 * - anthropic 模式:任意以 /anthropic/v1/messages 结尾的路径,标准
 *   message_start → content_block_delta(text_delta) → message_delta(end_turn)
 *   → message_stop 事件序列(与 BI-04.2 适配器解析契约逐字段对齐);
 * - openai 模式:任意以 /chat/completions 结尾的路径,chunk delta + finish_reason
 *   + [DONE] 终帧。
 * 回复语义:echo=true 时提取请求最后一条 user 消息文本回显(`ECHO:<text>`),
 * 供 e2e 断言"输入→模型→上屏"全回环;固定 text 优先。
 * EMPTY_RESPONSE 防御:适配器对零内容+finish=stop 判 protocol 错,故任何
 * 脚本至少含一个 text_delta。
 * 安全:仅绑定 127.0.0.1;进程内显式 close;不含任何真实凭据。
 */

export interface FakeEndpointOptions {
	/** 固定回复文本(优先于 echo)。 */
	readonly text?: string;
	/** true=回显请求最后一条 user 消息文本(ECHO:<text>)。 */
	readonly echo?: boolean;
	/** 指定端口;缺省 0=随机空闲端口。 */
	readonly port?: number;
}

export interface FakeEndpoint {
	/** 形如 http://127.0.0.1:<port>(anthropic 配置直填 base_url;openai 配置亦直填,路径后缀自适应)。 */
	readonly url: string;
	readonly port: number;
	/** 收到的请求体(JSON.parse 后;调试/断言用)。 */
	readonly requests: readonly Record<string, unknown>[];
	close(): void;
}

function lastUserText(body: Record<string, unknown>): string {
	const messages = body.messages;
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown } | null;
		if (m === null || m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) {
			const parts = m.content
				.filter((b): b is { type: string; text?: string } =>
					typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text",
				)
				.map((b) => (typeof b.text === "string" ? b.text : ""));
			return parts.join("");
		}
	}
	return "";
}

export function startFakeEndpoint(options: FakeEndpointOptions = {}): FakeEndpoint {
	const requests: Array<Record<string, unknown>> = [];

	const replyText = (body: Record<string, unknown>): string => {
		if (options.text !== undefined) return options.text;
		if (options.echo === true) return `ECHO:${lastUserText(body)}`;
		return "ECHO:";
	};

	const sse = (frames: string[]): Response =>
		new Response(frames.map((f) => `data: ${f}\n\n`).join(""), {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});

	const server = Bun.serve({
		port: options.port ?? 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			let body: Record<string, unknown> = {};
			try {
				const raw = await req.text();
				const parsed: unknown = raw === "" ? {} : JSON.parse(raw);
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
					body = parsed as Record<string, unknown>;
				}
			} catch {
				body = {};
			}
			requests.push(body);
			const text = replyText(body);
			if (url.pathname.endsWith("/chat/completions")) {
				return sse([
					JSON.stringify({ choices: [{ delta: { role: "assistant", content: text } }] }),
					JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
					"[DONE]",
				]);
			}
			if (url.pathname.endsWith("/anthropic/v1/messages")) {
				return sse([
					JSON.stringify({
						type: "message_start",
						message: { usage: { input_tokens: 8 } },
					}),
					JSON.stringify({
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text },
					}),
					JSON.stringify({
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: { output_tokens: 3 },
					}),
					JSON.stringify({ type: "message_stop" }),
				]);
			}
			return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port,
		requests,
		close: () => server.stop(true),
	};
}
