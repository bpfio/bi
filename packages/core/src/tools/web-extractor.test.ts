import { describe, expect, test } from "bun:test";
import { extractReadable, extractTitle } from "./web-extractor";

describe("extractTitle", () => {
	test("常规标题", () => {
		expect(extractTitle("<html><head><title>宏观月报 · 第 10 期</title></head></html>")).toBe(
			"宏观月报 · 第 10 期",
		);
	});

	test("无 title 返回空串", () => {
		expect(extractTitle("<p>无头页面</p>")).toBe("");
	});

	test("标题实体解码与空白折叠", () => {
		expect(extractTitle("<title>A &amp;\n   B</title>")).toBe("A & B");
	});
});

describe("extractReadable", () => {
	test("镀铬剥离 + 主内容抽取", () => {
		const html = [
			"<html><head><title>研报站</title></head><body>",
			'<nav><a href="/">首页</a> | <a href="/sub">订阅</a></nav>',
			"<h1>利率决议</h1>",
			"<p>央行维持 <b>LPR</b> 不变。</p>",
			'<form><input name="q"><button>搜索</button></form>',
			"<footer>© 2026 研报站</footer>",
			"</body></html>",
		].join("");
		const r = extractReadable(html);
		expect(r.title).toBe("研报站");
		expect(r.markdown).toBe("# 利率决议\n\n央行维持 **LPR** 不变。");
		expect(r.warnings).toEqual([]);
	});

	test("extraDropTags 追加剥离", () => {
		const html = "<aside>侧栏</aside><p>正文</p><div class='ad'>广告</div>";
		const r = extractReadable(html);
		expect(r.markdown).toBe("正文\n\n广告"); // div 默认保留
		const r2 = extractReadable(html, { extraDropTags: ["div"] });
		expect(r2.markdown).toBe("正文");
	});

	test("maxBytes 透传截断", () => {
		const html = "<p>" + "长".repeat(1000) + "</p>";
		const r = extractReadable(html, { maxBytes: 50 });
		expect(r.markdown.length).toBeLessThanOrEqual(120);
		expect(r.warnings.length).toBe(1);
	});

	test("空输入", () => {
		expect(extractReadable("")).toEqual({ title: "", markdown: "", warnings: [] });
	});
});
