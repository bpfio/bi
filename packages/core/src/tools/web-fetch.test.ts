import { describe, expect, test } from "bun:test";
import {
	DEFAULT_ALLOWED_SCHEMES,
	WebFetchError,
	fetchWebPage,
	type FetchExecutor,
	type WebFetchErrorKind,
} from "./web-fetch";

// ---------------------------------------------------------------------------
// 测试底座：注入伪 fetch，离屏零真实网络
// ---------------------------------------------------------------------------

function routeFetch(
	routes: Record<string, () => Response>,
): { fetchImpl: FetchExecutor; calls: string[] } {
	const calls: string[] = [];
	const fetchImpl: FetchExecutor = async (url) => {
		calls.push(url);
		const handler = routes[url];
		if (!handler) throw new Error(`no route: ${url}`);
		return handler();
	};
	return { fetchImpl, calls };
}

function htmlRes(html: string): Response {
	return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirectRes(location: string, status = 302): Response {
	return new Response(null, { status, headers: { location } });
}

/** 逐级 302 链：urls[0] → urls[1] → … → urls[n-1]（终点 200 HTML）。 */
function chainRoutes(urls: string[], terminal: string): Record<string, () => Response> {
	const routes: Record<string, () => Response> = {};
	for (let i = 0; i < urls.length - 1; i++) {
		const from = urls[i]!;
		const to = urls[i + 1]!;
		routes[from] = () => redirectRes(to);
	}
	routes[urls[urls.length - 1]!] = () => htmlRes(terminal);
	return routes;
}

function assertError(e: unknown, kind: WebFetchErrorKind, status?: number): WebFetchError {
	expect(WebFetchError.is(e)).toBe(true);
	const err = e as WebFetchError;
	expect(err.kind).toBe(kind);
	if (status !== undefined) expect(err.status).toBe(status);
	return err;
}

async function expectError(p: Promise<unknown>, kind: WebFetchErrorKind, status?: number): Promise<WebFetchError> {
	try {
		await p;
		expect.unreachable();
		throw new Error("unreachable");
	} catch (e) {
		return assertError(e, kind, status);
	}
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("fetchWebPage · 内容判定与转换", () => {
	test("HTML → markdown 引擎（复用 extractReadable）+ title + 最终 url", async () => {
		const html =
			"<html><head><title>宏观速递</title></head><body><h1>利率决议</h1><p>维持 <b>LPR</b> 不变。</p></body></html>";
		const { fetchImpl, calls } = routeFetch({ "https://a.example.com/x": () => htmlRes(html) });
		const r = await fetchWebPage("https://a.example.com/x", { fetchImpl });
		expect(r.url).toBe("https://a.example.com/x");
		expect(r.title).toBe("宏观速递");
		expect(r.markdown).toBe("# 利率决议\n\n维持 **LPR** 不变。");
		expect(r.text).toBeUndefined();
		expect(r.bytes).toBe(new TextEncoder().encode(html).length);
		expect(r.truncated).toBe(false);
		expect(r.warnings).toEqual([]);
		expect(calls).toEqual(["https://a.example.com/x"]);
	});

	test("HTML 主内容剥离镀铬（nav/footer 不入 markdown）", async () => {
		const html = [
			"<html><head><title>研报站</title></head><body>",
			'<nav><a href="/">首页</a></nav>',
			"<p>正文段落。</p>",
			"<footer>版权所有</footer>",
			"</body></html>",
		].join("");
		const { fetchImpl } = routeFetch({ "https://b.example.com/": () => htmlRes(html) });
		const r = await fetchWebPage("https://b.example.com/", { fetchImpl });
		expect(r.markdown).toBe("正文段落。");
		expect(r.markdown).not.toContain("首页");
		expect(r.markdown).not.toContain("版权所有");
	});

	test("content=full 兜底模式：htmlToMarkdown 全文档转换", async () => {
		const html = "<nav>菜单</nav><h1>标题</h1><p>全文保留。</p>";
		const { fetchImpl } = routeFetch({ "https://c.example.com/": () => htmlRes(html) });
		const r = await fetchWebPage("https://c.example.com/", { fetchImpl, content: "full" });
		expect(r.markdown).toContain("菜单");
		expect(r.markdown).toContain("# 标题");
		expect(r.markdown).toContain("全文保留。");
		expect(r.title).toBeUndefined(); // 无 <title>
	});

	test("text/plain 原样走 text 通道", async () => {
		const { fetchImpl } = routeFetch({
			"https://d.example.com/a.txt": () =>
				new Response("纯文本内容", { status: 200, headers: { "content-type": "text/plain" } }),
		});
		const r = await fetchWebPage("https://d.example.com/a.txt", { fetchImpl });
		expect(r.text).toBe("纯文本内容");
		expect(r.markdown).toBeUndefined();
		expect(r.title).toBeUndefined();
	});

	test("application/json 原样走 text 通道", async () => {
		const body = '{"ok":true,"items":[1,2]}';
		const { fetchImpl } = routeFetch({
			"https://d.example.com/api.json": () =>
				new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
		});
		const r = await fetchWebPage("https://d.example.com/api.json", { fetchImpl });
		expect(r.text).toBe(body);
	});

	test("二进制 content-type → unsupported-content-type 结构化错误", async () => {
		const { fetchImpl } = routeFetch({
			"https://d.example.com/i.png": () =>
				new Response("bin", { status: 200, headers: { "content-type": "image/png" } }),
		});
		await expectError(fetchWebPage("https://d.example.com/i.png", { fetchImpl }), "unsupported-content-type");
	});
});

describe("fetchWebPage · 手动逐跳重定向", () => {
	test("302 跟随：最终 url 更新且内容取自终点", async () => {
		const { fetchImpl, calls } = routeFetch(
			chainRoutes(
				["https://e.example.com/a", "https://e.example.com/b"],
				"<title>终点</title><p>落地页。</p>",
			),
		);
		const r = await fetchWebPage("https://e.example.com/a", { fetchImpl });
		expect(r.url).toBe("https://e.example.com/b");
		expect(r.markdown).toBe("落地页。");
		expect(r.title).toBe("终点");
		expect(calls).toEqual(["https://e.example.com/a", "https://e.example.com/b"]);
	});

	test("相对 Location 基于当前 url 解析", async () => {
		const routes: Record<string, () => Response> = {
			"https://f.example.com/dir/a": () => redirectRes("b"),
			"https://f.example.com/dir/b": () => redirectRes("../c"),
			"https://f.example.com/c": () => htmlRes("<p>到达。</p>"),
		};
		const { fetchImpl } = routeFetch(routes);
		const r = await fetchWebPage("https://f.example.com/dir/a", { fetchImpl });
		expect(r.url).toBe("https://f.example.com/c");
	});

	test("重定向计数上限：maxRedirects=2 遇第 3 跳抛 too-many-redirects", async () => {
		const { fetchImpl, calls } = routeFetch(
			chainRoutes(["https://g.example.com/1", "https://g.example.com/2", "https://g.example.com/3", "https://g.example.com/4"], "<p>x</p>"),
		);
		const err = await expectError(
			fetchWebPage("https://g.example.com/1", { fetchImpl, maxRedirects: 2 }),
			"too-many-redirects",
		);
		expect(calls.length).toBe(3); // 恰好消耗上限后停手
		expect(err.url).toBe("https://g.example.com/3");
	});

	test("maxRedirects=0：首跳即拒", async () => {
		const { fetchImpl, calls } = routeFetch({
			"https://g.example.com/a": () => redirectRes("https://g.example.com/b"),
		});
		await expectError(fetchWebPage("https://g.example.com/a", { fetchImpl, maxRedirects: 0 }), "too-many-redirects");
		expect(calls.length).toBe(1);
	});

	test("重定向目标协议不在白名单 → scheme-not-allowed", async () => {
		const { fetchImpl } = routeFetch({
			"https://h.example.com/a": () => redirectRes("ftp://h.example.com/file"),
		});
		await expectError(
			fetchWebPage("https://h.example.com/a", { fetchImpl }),
			"scheme-not-allowed",
		);
	});
});

describe("fetchWebPage · 结构化错误路径", () => {
	test("初始协议不在白名单 → scheme-not-allowed", async () => {
		await expectError(
			fetchWebPage("javascript:alert(1)"),
			"scheme-not-allowed",
		);
	});

	test("自定义 allowedSchemes 覆盖：仅 https 时 http 被拒", async () => {
		await expectError(
			fetchWebPage("http://insecure.example.com/", { allowedSchemes: ["https"] }),
			"scheme-not-allowed",
		);
	});

	test("缺省白名单为 https+http", () => {
		expect([...DEFAULT_ALLOWED_SCHEMES]).toEqual(["https", "http"]);
	});

	test("非法 URL → invalid-url", async () => {
		const err = await expectError(fetchWebPage("::not-a-url::"), "invalid-url");
		expect(err.status).toBeUndefined();
	});

	test("404 → http-error 结构化（status=404，不抛裸异常）", async () => {
		const { fetchImpl } = routeFetch({
			"https://i.example.com/missing": () => new Response("gone", { status: 404 }),
		});
		const err = await expectError(
			fetchWebPage("https://i.example.com/missing", { fetchImpl }),
			"http-error",
			404,
		);
		expect(err.message).toContain("404");
	});

	test("500 → http-error 结构化（status=500）", async () => {
		const { fetchImpl } = routeFetch({
			"https://i.example.com/boom": () => new Response("boom", { status: 500 }),
		});
		await expectError(fetchWebPage("https://i.example.com/boom", { fetchImpl }), "http-error", 500);
	});

	test("网络层异常包装为 network-error", async () => {
		const fetchImpl: FetchExecutor = async () => {
			throw new Error("ECONNREFUSED");
		};
		const err = await expectError(fetchWebPage("https://j.example.com/", { fetchImpl }), "network-error");
		expect(err.message).toContain("ECONNREFUSED");
	});

	test("伪 fetch 挂起且响应 abort 信号 → timeout", async () => {
		const fetchImpl: FetchExecutor = (_url, init) =>
			new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		await expectError(
			fetchWebPage("https://slow.example.com/", { fetchImpl, timeoutMs: 50 }),
			"timeout",
		);
	});
});

describe("fetchWebPage · 大小截断", () => {
	test("超过 maxBytes 截断：bytes == maxBytes + warning", async () => {
		const body = "字".repeat(100); // UTF-8 每字 3 字节 → 300 字节
		const { fetchImpl } = routeFetch({
			"https://k.example.com/big": () =>
				new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
		});
		const r = await fetchWebPage("https://k.example.com/big", { fetchImpl, maxBytes: 30 });
		expect(r.truncated).toBe(true);
		expect(r.bytes).toBe(30);
		expect(r.text!.length).toBe(10); // 30 字节 = 10 个三字节汉字
		expect(r.warnings.some((w) => w.includes("30") && w.includes("截断"))).toBe(true);
	});

	test("恰好等于 maxBytes 不误标截断", async () => {
		const body = "abcde";
		const { fetchImpl } = routeFetch({
			"https://k.example.com/exact": () =>
				new Response(body, { status: 200, headers: { "content-type": "text/plain" } }),
		});
		const r = await fetchWebPage("https://k.example.com/exact", { fetchImpl, maxBytes: 5 });
		expect(r.truncated).toBe(false);
		expect(r.bytes).toBe(5);
		expect(r.text).toBe("abcde");
	});
});
