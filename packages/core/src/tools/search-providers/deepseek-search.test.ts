import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEEPSEEK_ENDPOINT,
	DEFAULT_DEEPSEEK_MODEL,
	DeepSeekSearchProvider,
	parseDeepSeekResults,
} from "./deepseek-search";
import { SearchError } from "../web-search";
import type { FetchExecutor as WebFetchExecutor } from "../web-fetch";

// ---------------------------------------------------------------------------
// 测试底座
// ---------------------------------------------------------------------------

interface CapturedRequest {
	url: string;
	init?: RequestInit;
}

function jsonFetch(status: number, body: unknown | string): {
	fetchImpl: WebFetchExecutor;
	captured: CapturedRequest[];
} {
	const captured: CapturedRequest[] = [];
	const fetchImpl: WebFetchExecutor = async (url, init) => {
		captured.push({ url, init });
		const text = typeof body === "string" ? body : JSON.stringify(body);
		return new Response(text, {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetchImpl, captured };
}

function completion(content: string): unknown {
	return { id: "chatcmpl-1", choices: [{ index: 0, message: { role: "assistant", content } }] };
}

function provider(fetchImpl: WebFetchExecutor, extra = {}): DeepSeekSearchProvider {
	return new DeepSeekSearchProvider({ apiKey: "sk-test-key-0123456789", fetchImpl, ...extra });
}

async function expectProviderError(p: Promise<unknown>, status?: number): Promise<SearchError> {
	try {
		await p;
		expect.unreachable();
		throw new Error("unreachable");
	} catch (e) {
		expect(SearchError.is(e)).toBe(true);
		const err = e as SearchError;
		expect(err.kind).toBe("provider-error");
		expect(err.provider).toBe("deepseek");
		if (status !== undefined) expect(err.status).toBe(status);
		return err;
	}
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

describe("parseDeepSeekResults", () => {
	test("裸 JSON 数组 → SearchResult[]，provider 标记 deepseek", () => {
		const out = parseDeepSeekResults(
			'[{"title":"A","url":"https://a.example.com/","snippet":"摘要A"},{"title":"B","url":"https://b.example.com/","snippet":"摘要B"}]',
			8,
		);
		expect(out).toEqual([
			{ title: "A", url: "https://a.example.com/", snippet: "摘要A", provider: "deepseek" },
			{ title: "B", url: "https://b.example.com/", snippet: "摘要B", provider: "deepseek" },
		]);
	});

	test("{results: [...]} 包裹形态", () => {
		const out = parseDeepSeekResults('{"results":[{"title":"R","url":"https://r.example.com/","snippet":"s"}]}', 8);
		expect(out).toHaveLength(1);
		expect(out[0]!.title).toBe("R");
	});

	test("markdown 代码围栏剥离", () => {
		const out = parseDeepSeekResults('```json\n[{"title":"F","url":"https://f.example.com/","snippet":"x"}]\n```', 8);
		expect(out).toHaveLength(1);
		expect(out[0]!.url).toBe("https://f.example.com/");
	});

	test("limit 截断", () => {
		const arr = JSON.stringify(
			Array.from({ length: 5 }, (_, i) => ({ title: String(i), url: `https://h${i}.example.com/`, snippet: "" })),
		);
		expect(parseDeepSeekResults(arr, 2)).toHaveLength(2);
	});

	test("无效条目跳过：非法 URL / 缺 URL / 非对象", () => {
		const out = parseDeepSeekResults(
			'[{"title":"无url"},{"title":"坏url","url":"notaurl"},{"title":"ftp","url":"ftp://x/"},{"title":"好","url":"https://ok.example.com/","snippet":"s"}, "junk", null]',
			8,
		);
		expect(out).toHaveLength(1);
		expect(out[0]!.url).toBe("https://ok.example.com/");
	});

	test("snippet 回退链 description → summary → content；title 回退 url", () => {
		const out = parseDeepSeekResults(
			'[{"url":"https://r1.example.com/","description":"描述"},{"url":"https://r2.example.com/","summary":"总结"},{"url":"https://r3.example.com/","content":"正文"}]',
			8,
		);
		expect(out[0]!.snippet).toBe("描述");
		expect(out[1]!.snippet).toBe("总结");
		expect(out[2]!.snippet).toBe("正文");
		expect(out[0]!.title).toBe("https://r1.example.com/");
	});

	test("非 JSON → provider-error（不抛裸异常）", () => {
		try {
			parseDeepSeekResults("抱歉我找不到任何结果", 8);
			expect.unreachable();
		} catch (e) {
			expect(SearchError.is(e)).toBe(true);
			expect((e as SearchError).kind).toBe("provider-error");
		}
	});
});

// ---------------------------------------------------------------------------
// ProviderPort 行为（注入伪 fetch，离屏）
// ---------------------------------------------------------------------------

describe("DeepSeekSearchProvider", () => {
	test("POST chat/completions 语义：端点/模型/Bearer 头/消息结构", async () => {
		const { fetchImpl, captured } = jsonFetch(200, completion('[{"title":"T","url":"https://t.example.com/","snippet":"s"}]'));
		const p = new DeepSeekSearchProvider({
			apiKey: "sk-live-secret",
			endpoint: "https://relay.example.com/v1/chat/completions",
			model: "deepseek-researcher",
			fetchImpl,
		});
		const r = await p.search("央行利率", { limit: 8 });
		expect(r).toHaveLength(1);
		expect(captured).toHaveLength(1);
		const req = captured[0]!;
		expect(req.url).toBe("https://relay.example.com/v1/chat/completions");
		expect(req.init?.method).toBe("POST");
		const headers = req.init?.headers as Record<string, string>;
		expect(headers["authorization"]).toBe("Bearer sk-live-secret");
		expect(headers["content-type"]).toBe("application/json");
		const payload = JSON.parse(String(req.init?.body)) as {
			model: string;
			stream: boolean;
			messages: Array<{ role: string; content: string }>;
		};
		expect(payload.model).toBe("deepseek-researcher");
		expect(payload.stream).toBe(false);
		expect(payload.messages[0]!.role).toBe("system");
		expect(payload.messages[1]).toEqual({ role: "user", content: "央行利率" });
	});

	test("缺省端点与模型常量", () => {
		expect(DEFAULT_DEEPSEEK_ENDPOINT).toBe("https://api.deepseek.com/chat/completions");
		expect(DEFAULT_DEEPSEEK_MODEL).toBe("deepseek-chat");
	});

	test("HTTP 401 → provider-error 携带 status，错误消息不含密钥", async () => {
		const { fetchImpl } = jsonFetch(401, { error: { message: "auth failed" } });
		const p = provider(fetchImpl);
		const err = await expectProviderError(p.search("q", { limit: 8 }), 401);
		expect(err.message).not.toContain("sk-test-key-0123456789");
		expect(err.message).toContain("401");
	});

	test("HTTP 500 → provider-error status=500", async () => {
		const { fetchImpl } = jsonFetch(500, "oops");
		await expectProviderError(provider(fetchImpl).search("q", { limit: 8 }), 500);
	});

	test("响应非合法 JSON → provider-error", async () => {
		const { fetchImpl } = jsonFetch(200, "<html>gateway error</html>");
		await expectProviderError(provider(fetchImpl).search("q", { limit: 8 }));
	});

	test("网络异常 → provider-error 包装", async () => {
		const fetchImpl: WebFetchExecutor = async () => {
			throw new Error("DNS failure");
		};
		const err = await expectProviderError(provider(fetchImpl).search("q", { limit: 8 }));
		expect(err.message).toContain("DNS failure");
	});

	test("挂起 fetch 响应 abort → timeout 结构化错误", async () => {
		const fetchImpl: WebFetchExecutor = (_url, init) =>
			new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		try {
			await provider(fetchImpl).search("q", { limit: 8, timeoutMs: 40 });
			expect.unreachable();
		} catch (e) {
			expect(SearchError.is(e)).toBe(true);
			expect((e as SearchError).kind).toBe("timeout");
		}
	});

	test("空 apiKey 构造即拒绝（密钥必须参数注入）", () => {
		try {
			new DeepSeekSearchProvider({ apiKey: "  " });
			expect.unreachable();
		} catch (e) {
			expect(SearchError.is(e)).toBe(true);
			expect((e as SearchError).kind).toBe("provider-error");
		}
	});

	test("可接入 webSearch 注册表（跨文件端口一致性）", async () => {
		const { fetchImpl } = jsonFetch(200, completion('[{"title":"Z","url":"https://z.example.com/","snippet":"s"}]'));
		const p = provider(fetchImpl);
		expect(p.name).toBe("deepseek");
		// ProviderPort 契约：search(query, opts) 签名与 SearchResult 形状
		const r = await p.search("q", { limit: 5 });
		expect(r[0]).toEqual({ title: "Z", url: "https://z.example.com/", snippet: "s", provider: "deepseek" });
	});
});
