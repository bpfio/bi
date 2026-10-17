import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_OUTPUT_BYTES, decodeEntities, htmlToMarkdown } from "./html-markdown";

describe("decodeEntities", () => {
	test("命名实体解码", () => {
		expect(decodeEntities("a&amp;b&lt;c&gt;d")).toBe("a&b<c>d");
		expect(decodeEntities("&quot;引号&quot;&amp;&apos;")).toBe('"引号"&\'');
		expect(decodeEntities("&mdash;&mdash;")).toBe("——");
	});

	test("数字与十六进制实体", () => {
		expect(decodeEntities("&#65;&#x42;")).toBe("AB");
		expect(decodeEntities("&#128512;")).toBe("😀");
		expect(decodeEntities("&#x1F600;")).toBe("😀");
	});

	test("未知实体原样保留", () => {
		expect(decodeEntities("&notanentity;x")).toBe("&notanentity;x");
		expect(decodeEntities("100 & 200")).toBe("100 & 200");
		expect(decodeEntities("&#999999999999;")).toBe("&#999999999999;");
	});

	test("代理对拆写自动合并", () => {
		// 😀 = 0x1F600 = 高代理 0xD83D + 低代理 0xDE00
		expect(decodeEntities("&#55357;&#56832;")).toBe("😀");
	});

	test("孤立代理以 U+FFFD 兜底", () => {
		expect(decodeEntities("&#55357;A")).toBe("\uFFFDA");
	});

	test("nbsp 解码", () => {
		expect(decodeEntities("a&nbsp;b")).toBe("a b");
	});
});

describe("块级映射", () => {
	test("标题 h1-h6", () => {
		const { markdown } = htmlToMarkdown("<h1>大标题</h1><h2>次级</h2><h6>最深</h6>");
		expect(markdown).toBe("# 大标题\n\n## 次级\n\n###### 最深");
	});

	test("段落与空白折叠", () => {
		const { markdown } = htmlToMarkdown("<p>  hello\n\n   world  </p>");
		expect(markdown).toBe("hello world");
	});

	test("段落间空行分隔", () => {
		const { markdown } = htmlToMarkdown("<p>甲</p><p>乙</p>");
		expect(markdown).toBe("甲\n\n乙");
	});

	test("div 容器段落化", () => {
		const { markdown } = htmlToMarkdown("<div>一</div><div>二</div>");
		expect(markdown).toBe("一\n\n二");
	});

	test("hr 分隔线", () => {
		const { markdown } = htmlToMarkdown("<p>上</p><hr><p>下</p>");
		expect(markdown).toBe("上\n\n---\n\n下");
	});
});

describe("行内映射", () => {
	test("粗体/斜体/删除线", () => {
		const { markdown } = htmlToMarkdown("<p><b>粗</b> <strong>更强</strong> <em>斜</em> <del>删</del></p>");
		expect(markdown).toBe("**粗** **更强** *斜* ~~删~~");
	});

	test("嵌套行内包裹", () => {
		const { markdown } = htmlToMarkdown("<p><b>加 <i>嵌套</i> 回</b></p>");
		expect(markdown).toBe("**加 *嵌套* 回**");
	});

	test("空包裹回退", () => {
		const { markdown } = htmlToMarkdown("<p>前<b></b>后</p>");
		expect(markdown).toBe("前后");
	});

	test("包裹首尾空白收边", () => {
		const { markdown } = htmlToMarkdown("<p>foo <b>bar </b> baz</p>");
		expect(markdown).toBe("foo **bar** baz");
	});

	test("链接", () => {
		const { markdown } = htmlToMarkdown('<p>见 <a href="https://example.com/a?b=1">示例</a> 页</p>');
		expect(markdown).toBe("见 [示例](https://example.com/a?b=1) 页");
	});

	test("无文本链接回退", () => {
		const { markdown } = htmlToMarkdown('<a href="https://example.com"></a>');
		expect(markdown).toBe("");
	});

	test("图片", () => {
		const { markdown } = htmlToMarkdown('<p><img src="/img/chart.webp" alt="图表"></p>');
		expect(markdown).toBe("![图表](/img/chart.webp)");
	});

	test("行内代码", () => {
		const { markdown } = htmlToMarkdown("<p>用 <code>npm run test</code> 执行</p>");
		expect(markdown).toBe("用 `npm run test` 执行");
	});

	test("含反引号的行内代码加长围栏", () => {
		const { markdown } = htmlToMarkdown("<p><code>a`b</code></p>");
		expect(markdown).toBe("``a`b``");
	});

	test("br 硬换行", () => {
		const { markdown } = htmlToMarkdown("<p>第一行<br>第二行</p>");
		expect(markdown).toBe("第一行\n第二行");
	});

	test("行内文本中的实体解码", () => {
		const { markdown } = htmlToMarkdown("<p>A &amp; B &lt;tag&gt;</p>");
		expect(markdown).toBe("A & B <tag>");
	});
});

describe("列表", () => {
	test("无序列表", () => {
		const { markdown } = htmlToMarkdown("<ul><li>甲</li><li>乙</li></ul>");
		expect(markdown).toBe("- 甲\n- 乙");
	});

	test("有序列表与 start 偏移", () => {
		const { markdown } = htmlToMarkdown('<ol start="3"><li>丙</li><li>丁</li></ol>');
		expect(markdown).toBe("3. 丙\n4. 丁");
	});

	test("隐式闭合的相邻 li", () => {
		const { markdown } = htmlToMarkdown("<ul><li>甲<li>乙</ul>");
		expect(markdown).toBe("- 甲\n- 乙");
	});

	test("嵌套列表缩进", () => {
		const { markdown } = htmlToMarkdown("<ul><li>外<ul><li>内一</li><li>内二</li></ul></li></ul>");
		expect(markdown).toBe("- 外\n  - 内一\n  - 内二");
	});

	test("多段 li 续行缩进", () => {
		const { markdown } = htmlToMarkdown("<ul><li>首行<br>续行</li></ul>");
		expect(markdown).toBe("- 首行\n  续行");
	});

	test("空 li 保留标记", () => {
		const { markdown } = htmlToMarkdown("<ul><li> </li></ul>");
		expect(markdown).toBe("-");
	});
});

describe("引用", () => {
	test("单层引用", () => {
		const { markdown } = htmlToMarkdown("<blockquote><p>引文一句</p></blockquote>");
		expect(markdown).toBe("> 引文一句");
	});

	test("嵌套引用前缀叠加", () => {
		const { markdown } = htmlToMarkdown(
			"<blockquote><p>外层</p><blockquote><p>内层</p></blockquote></blockquote>",
		);
		expect(markdown).toBe("> 外层\n>\n> > 内层");
	});
});

describe("围栏代码", () => {
	test("pre 纯文本", () => {
		const { markdown } = htmlToMarkdown("<pre>const x = 1;\nreturn x;</pre>");
		expect(markdown).toBe("```\nconst x = 1;\nreturn x;\n```");
	});

	test("pre>code 语言标注", () => {
		const { markdown } = htmlToMarkdown(
			'<pre><code class="language-ts">let a: number = 1;</code></pre>',
		);
		expect(markdown).toBe("```ts\nlet a: number = 1;\n```");
	});

	test("内容含三反引号时加长围栏", () => {
		const { markdown } = htmlToMarkdown("<pre>md 例子：\n```\nraw\n```\n结束</pre>");
		expect(markdown).toBe("````\nmd 例子：\n```\nraw\n```\n结束\n````");
	});

	test("pre 内空白与换行保真", () => {
		const { markdown } = htmlToMarkdown("<pre>  缩进保留\n    更深</pre>");
		expect(markdown).toBe("```\n  缩进保留\n    更深\n```");
	});
});

describe("rawtext 与 skip 子树", () => {
	test("script/style/noscript 事件级剥离", () => {
		const { markdown } = htmlToMarkdown(
			"<p>正文</p><script>var x = '</p><p>注入</p>';</script><style>.a{color:red}</style><p>续</p>",
		);
		expect(markdown).toBe("正文\n\n续");
	});

	test("script 内的 </p> 不破坏结构（大小写不敏感闭合）", () => {
		const { markdown } = htmlToMarkdown("<SCRIPT>if (a</P)b;</SCRIPT><p>ok</p>");
		expect(markdown).toBe("ok");
	});

	test("head/title/meta 整树丢弃", () => {
		const { markdown } = htmlToMarkdown(
			"<html><head><title>站点名</title><meta charset=\"utf-8\"></head><body><p>内容</p></body></html>",
		);
		expect(markdown).toBe("内容");
	});

	test("dropTags 扩展剥离 nav/footer", () => {
		const { markdown } = htmlToMarkdown(
			"<nav>导航</nav><p>正文</p><footer>备案号</footer>",
			{ dropTags: ["nav", "footer"] },
		);
		expect(markdown).toBe("正文");
	});

	test("注释与 doctype 丢弃", () => {
		const { markdown } = htmlToMarkdown(
			"<!DOCTYPE html><!-- 页面注释 --><p>可见</p><!-- 尾注 -->",
		);
		expect(markdown).toBe("可见");
	});
});

describe("GFM 表格", () => {
	test("基础两列表格", () => {
		const { markdown } = htmlToMarkdown(
			"<table><tr><th>指标</th><th>数值</th></tr><tr><td>CPI</td><td>2.1%</td></tr></table>",
		);
		expect(markdown).toBe("| 指标 | 数值 |\n| --- | --- |\n| CPI | 2.1% |");
	});

	test("对齐矩阵重构", () => {
		const { markdown } = htmlToMarkdown(
			'<table><tr><th align="left">省</th><th align="center">GDP</th><th align="right">增速</th></tr>' +
			"<tr><td>粤</td><td>13.5万亿</td><td>4.8%</td></tr></table>",
		);
		expect(markdown).toBe(
			"| 省 | GDP | 增速 |\n| :--- | :---: | ---: |\n| 粤 | 13.5万亿 | 4.8% |",
		);
	});

	test("colspan 空单元格补齐", () => {
		const { markdown } = htmlToMarkdown(
			'<table><tr><th colspan="2">合计</th></tr><tr><td>a</td><td>b</td></tr></table>',
		);
		expect(markdown).toBe("| 合计 |  |\n| --- | --- |\n| a | b |");
	});

	test("thead/tbody 结构", () => {
		const { markdown } = htmlToMarkdown(
			"<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
		);
		expect(markdown).toBe("| A |\n| --- |\n| 1 |");
	});

	test("表格内行内标记保留", () => {
		const { markdown } = htmlToMarkdown(
			"<table><tr><th>口径</th></tr><tr><td><b>同比</b> 口径</td></tr></table>",
		);
		expect(markdown).toBe("| 口径 |\n| --- |\n| **同比** 口径 |");
	});
});

describe("容错与安全", () => {
	test("空输入", () => {
		expect(htmlToMarkdown("")).toEqual({ markdown: "", warnings: [] });
	});

	test("散闭标签忽略", () => {
		const { markdown } = htmlToMarkdown("</div><p>正文</p></body>");
		expect(markdown).toBe("正文");
	});

	test("未闭合标签 EOF 收口", () => {
		const { markdown } = htmlToMarkdown("<p>未闭合段落");
		expect(markdown).toBe("未闭合段落");
	});

	test("裸 '<' 字面容错", () => {
		const { markdown } = htmlToMarkdown("<p>1 < 2 且 3>2</p>");
		expect(markdown).toContain("1");
		expect(markdown).toContain("2 且 3>2");
	});

	test("属性三种引号态与裸属性", () => {
		const { markdown } = htmlToMarkdown(
			'<p><a href=\'https://a.b\'>单引号</a><a href=/noquote>无引号</a><a disabled>裸属性</a></p>',
		);
		expect(markdown).toContain("[单引号](https://a.b)");
		expect(markdown).toContain("[无引号](/noquote)");
		expect(markdown).toContain("裸属性");
	});

	test("属性值实体解码", () => {
		const { markdown } = htmlToMarkdown('<p><a href="/s?q=a&amp;b">查</a></p>');
		expect(markdown).toBe("[查](/s?q=a&b)");
	});

	test("emoji 等 UTF-16 代理对全字保真", () => {
		const { markdown } = htmlToMarkdown("<p>政策🚀速览</p>");
		expect(markdown).toBe("政策🚀速览");
	});

	test("CRLF 空白折叠", () => {
		const { markdown } = htmlToMarkdown("<p>a\r\nb</p>");
		expect(markdown).toBe("a b");
	});

	test("大写标签名归一", () => {
		const { markdown } = htmlToMarkdown("<P>大写</P><UL><LI>表项</LI></UL>");
		expect(markdown).toBe("大写\n\n- 表项");
	});

	test("5MiB 缺省预算常量", () => {
		expect(DEFAULT_MAX_OUTPUT_BYTES).toBe(5 * 1024 * 1024);
	});

	test("预算截断产生 warning 且不抛错", () => {
		const big = "<p>" + "字".repeat(2000) + "</p>";
		const { markdown, warnings } = htmlToMarkdown(big, { maxBytes: 100 });
		expect(markdown.length).toBeLessThanOrEqual(300);
		expect(warnings.length).toBe(1);
		expect(warnings[0]!).toContain("截断");
	});
});

describe("端到端：研报网页样例", () => {
	test("混合结构整页抽取", () => {
		const html = [
			"<!DOCTYPE html><html><head><title>宏观月报</title></head>",
			"<body>",
			'<nav><a href="/">首页</a></nav>',
			"<h1>十月宏观速览</h1>",
			"<p>CPI <b>同比</b>上涨 <code>0.4%</code>，PPI&nbsp;降幅收窄。</p>",
			'<table><thead><tr><th>指标</th><th align="right">同比</th></tr></thead>',
			"<tbody><tr><td>CPI</td><td>0.4%</td></tr></tbody></table>",
			'<blockquote><p>数据来源：国家统计局</p></blockquote>',
			'<pre><code class="language-python">print("hi")</code></pre>',
			"</body></html>",
		].join("");
		const { markdown, warnings } = htmlToMarkdown(html, { dropTags: ["nav"] });
		expect(warnings).toEqual([]);
		expect(markdown).toBe(
			["# 十月宏观速览", "", "CPI **同比**上涨 `0.4%`，PPI 降幅收窄。", "",
				"| 指标 | 同比 |", "| --- | ---: |", "| CPI | 0.4% |", "",
				"> 数据来源：国家统计局", "", "```python", 'print("hi")', "```"].join("\n"),
		);
	});
});
