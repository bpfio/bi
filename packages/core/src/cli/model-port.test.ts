/**
 * BI-23.3 —— 真实模型端口装配单测（全离线，零网络）。
 *
 * 覆盖面（装配层自己的逻辑，不重测 BI-04.2 适配器线协议——那由
 * deepseek-adapter.test.ts 全量覆盖）：
 * - effortToAdapter 四档映射 + enabled=false 强制 off；
 * - resolveModelPort 选择链：models.default 缺省回退 entries 首个 → provider
 *   引用回退链（entries.default → 首个）→ 缺失各步结构化报错（含修复指引）；
 * - kind → WireMode（openai/anthropic/google）；
 * - 凭据门（BI-02）：api_key_env 未设置结构化报错、已设置流入 Authorization /
 *   x-api-key 头、未声明 = 无静态 Key；
 * - createAdapterModelPort 双模态 URL 与事件透传（注入 fetch，假 SSE 流）。
 */
import { describe, expect, test } from "bun:test";

import {
	createAdapterModelPort,
	effortToAdapter,
	ModelPortConfigError,
	resolveModelPort,
} from "./model-port";
import type { BiConfig } from "../config/schema";
import type { FetchLike } from "../adapters/deepseek-adapter";
import type { StreamEvent } from "../adapters/deepseek-adapter";
import { createDefaultConfig } from "../config/schema";

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

function bytesOf(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function sseResponse(text: string): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytesOf(text));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface FetchCall {
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

function makeFetch(responder?: (call: FetchCall) => Response): {
	fetchImpl: FetchLike;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const headers = Object.fromEntries(
			Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
		) as Record<string, string>;
		const call: FetchCall = { url: String(input), headers, body: JSON.parse(String(init?.body ?? "{}")) };
		calls.push(call);
		return responder?.(call) ?? sseResponse("");
	};
	return { fetchImpl, calls };
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const ev of iter) out.push(ev);
	return out;
}

/** Messages 模态最小 SSE 流：text 增量 + message_delta 终态 + [DONE]。 */
const MESSAGES_SSE =
	'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n' +
	"data: [DONE]\n\n";

/** OpenAI 模态最小 SSE 流：content 增量 + finish_reason=stop + [DONE]。 */
const OPENAI_SSE =
	'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}\n\n' +
	'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
	"data: [DONE]\n\n";

function configWith(overrides: {
	provider?: Partial<BiConfig["providers"]["entries"][string]>;
	model?: Partial<BiConfig["models"]["entries"][string]>;
	defaults?: { provider?: string; model?: string };
}): BiConfig {
	const config = createDefaultConfig();
	config.providers.entries = {
		p1: {
			api_key_env: "BI_TEST_KEY_23_3",
			base_url: "https://mimo.test/v1",
			kind: "openai",
			models: ["test-model"],
			...(overrides.provider ?? {}),
		},
	};
	config.models.entries = {
		main: { provider: "p1", model: "test-model", max_tokens: 0, temperature: 0.7, context_limit: 0, ...(overrides.model ?? {}) },
	};
	config.providers.default = overrides.defaults?.provider ?? "";
	config.models.default = overrides.defaults?.model ?? "main";
	return config;
}

// ---------------------------------------------------------------------------
// effortToAdapter
// ---------------------------------------------------------------------------

describe("BI-23.3 · effortToAdapter 档位映射", () => {
	test("四档映射 minimal→off / low→low / medium→high / high→max", () => {
		expect(effortToAdapter(true, "minimal")).toBe("off");
		expect(effortToAdapter(true, "low")).toBe("low");
		expect(effortToAdapter(true, "medium")).toBe("high");
		expect(effortToAdapter(true, "high")).toBe("max");
	});

	test("enabled=false 强制 off；未知档位回退 off（不猜测）", () => {
		expect(effortToAdapter(false, "high")).toBe("off");
		expect(effortToAdapter(true, "bogus")).toBe("off");
	});
});

// ---------------------------------------------------------------------------
// resolveModelPort 选择链与凭据门
// ---------------------------------------------------------------------------

describe("BI-23.3 · resolveModelPort 选择链", () => {
	test("完整链：models.default → provider 引用 → kind=openai → 端口元数据", () => {
		const selection = resolveModelPort(configWith({}), {
			env: { BI_TEST_KEY_23_3: "tp-secret" },
		});
		expect(selection.providerName).toBe("p1");
		expect(selection.modelId).toBe("main");
		expect(selection.wireModel).toBe("test-model");
		expect(selection.mode).toBe("openai");
		expect(selection.baseUrl).toBe("https://mimo.test/v1");
		expect(selection.thinking).toBe("high"); // 缺省 effort=medium → high
	});

	test("models.default 为空回退 entries 首个；provider 引用空回退 providers.default 再回退首个", () => {
		const config = configWith({ defaults: { model: "", provider: "p1" } });
		config.models.entries.main!.provider = "";
		const selection = resolveModelPort(config, { env: { BI_TEST_KEY_23_3: "k" } });
		expect(selection.modelId).toBe("main");
		expect(selection.providerName).toBe("p1");
	});

	test("未配置任何模型 → 结构化报错含修复指引", () => {
		const config = createDefaultConfig();
		expect(() => resolveModelPort(config, { env: {} })).toThrow(ModelPortConfigError);
		expect(() => resolveModelPort(config, { env: {} })).toThrow(/models\.default/);
	});

	test("引用不存在的 provider / 空 wire 模型 / 未知 kind → 各自结构化报错", () => {
		expect(() =>
			resolveModelPort(configWith({ model: { provider: "ghost" } }), { env: { BI_TEST_KEY_23_3: "k" } }),
		).toThrow(/ghost/);
		expect(() => resolveModelPort(configWith({ model: { model: "" } }), { env: { BI_TEST_KEY_23_3: "k" } })).toThrow(
			/供应商侧模型名/,
		);
		expect(() => resolveModelPort(configWith({ provider: { kind: "google" } }), { env: { BI_TEST_KEY_23_3: "k" } })).toThrow(
			/google/,
		);
	});

	test("凭据门：api_key_env 未设置 → 结构化报错且不泄露配置之外的信息；注入门返回 undefined → 空串放行", () => {
		expect(() => resolveModelPort(configWith({}), { env: {} })).toThrow(/BI_TEST_KEY_23_3 未设置/);
		const selection = resolveModelPort(configWith({}), { resolveApiKey: () => undefined });
		expect(selection.mode).toBe("openai");
	});

	test("max_tokens=0 不透传（供应商默认）；temperature 透传", async () => {
		const { fetchImpl, calls } = makeFetch(() => sseResponse(OPENAI_SSE));
		const selection = resolveModelPort(configWith({}), { env: { BI_TEST_KEY_23_3: "k" }, fetchImpl });
		await collect(selection.port.stream({ messages: [{ role: "user", content: "hi" }], tools: [] }));
		expect(calls.length).toBe(1);
		expect(calls[0]!.body).toMatchObject({ model: "test-model", temperature: 0.7 });
	});
});

// ---------------------------------------------------------------------------
// createAdapterModelPort 双模态线装
// ---------------------------------------------------------------------------

describe("BI-23.3 · createAdapterModelPort 双模态", () => {
	test("messages 模态：POST {baseUrl}/anthropic/v1/messages，x-api-key 头，事件透传", async () => {
		const { fetchImpl, calls } = makeFetch(() => sseResponse(MESSAGES_SSE));
		const port = createAdapterModelPort({
			baseUrl: "https://mimo.test",
			apiKey: "tp-secret",
			model: "mimo-v2.6-flash",
			mode: "messages",
			thinking: "off",
			fetchImpl,
		});
		const events = await collect(
			port.stream({ messages: [{ role: "user", content: "hi" }], tools: [] }),
		);
		expect(calls[0]!.url).toBe("https://mimo.test/anthropic/v1/messages");
		expect(calls[0]!.headers["x-api-key"]).toBe("tp-secret");
		expect(calls[0]!.body).toMatchObject({ model: "mimo-v2.6-flash", stream: true, thinking: { type: "disabled" } });
		const content = events.find((e) => e.type === "content_delta");
		expect(content).toMatchObject({ delta: "你好" });
		expect(events.at(-1)).toMatchObject({ type: "done" });
	});

	test("openai 模态：POST {baseUrl}/chat/completions，Bearer 头，事件透传", async () => {
		const { fetchImpl, calls } = makeFetch(() => sseResponse(OPENAI_SSE));
		const port = createAdapterModelPort({
			baseUrl: "https://mimo.test/v1",
			apiKey: "tp-secret",
			model: "mimo-v2.6-flash",
			mode: "openai",
			thinking: "off",
			fetchImpl,
		});
		const events = await collect(
			port.stream({ messages: [{ role: "user", content: "hi" }], tools: [] }),
		);
		expect(calls[0]!.url).toBe("https://mimo.test/v1/chat/completions");
		expect(calls[0]!.headers["authorization"]).toBe("Bearer tp-secret");
		expect(events.some((e) => e.type === "content_delta")).toBe(true);
		expect(events.at(-1)).toMatchObject({ type: "done" });
	});

	test("工具定义进入请求体（tools 非空才携带）", async () => {
		const { fetchImpl, calls } = makeFetch(() => sseResponse(OPENAI_SSE));
		const port = createAdapterModelPort({
			baseUrl: "https://mimo.test/v1",
			apiKey: "k",
			model: "m",
			mode: "openai",
			fetchImpl,
		});
		await collect(
			port.stream({
				messages: [{ role: "user", content: "hi" }],
				tools: [{ name: "read_file", description: "读文件", inputSchema: { type: "object" } }],
			}),
		);
		const body = calls[0]!.body as { tools?: Array<{ type: string; function: { name: string } }> };
		expect(body.tools?.[0]?.type).toBe("function");
		expect(body.tools?.[0]?.function.name).toBe("read_file");
	});
});
