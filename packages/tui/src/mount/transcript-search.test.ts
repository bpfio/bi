/**
 * BI-19.1-search —— 转录内搜索（快赢提案 A）纯函数验收。
 * 零 TTY：仅依赖 transcript-search.ts 的纯逻辑（语料/正则/缓存/控制器）。
 *
 * 覆盖（工单验收四项）：
 * 1. ANSI 剥离后正则命中计数；
 * 2. next/prev 跳转与 wrap-around；
 * 3. 关闭后转录复原；
 * 4. Esc 清零。
 */
import { describe, expect, test } from "bun:test";

import {
	buildSearchCorpus,
	escapeRegExp,
	findSearchCorpusMatches,
	normalizeQuery,
	stripAnsi,
	TranscriptSearch,
	TranscriptSearchIndex,
} from "./transcript-search";

describe("BI-19.1-search · ANSI 剥离 + 正则命中计数", () => {
	test("stripAnsi 剥离 SGR/CSI/OSC 与 C0 控制字节", () => {
		expect(stripAnsi("\x1b[31m红\x1b[0m")).toBe("红");
		expect(stripAnsi("a\x1b[2;3Hb")).toBe("ab"); // CSI 止于终字节 H，仅剥离序列本身
		expect(stripAnsi("x\x1b]0;title\x07y")).toBe("xy");
		expect(stripAnsi("m\x1b(B\x1b)0n\x1b=o")).toBe("mno");
		expect(stripAnsi("tab\tback\nline")).toBe("tab\tback\nline"); // 可打印/换行/制表保留
	});

	test("buildSearchCorpus 逐行剥离 ANSI", () => {
		const corpus = buildSearchCorpus(["\x1b[1mfoo\x1b[0m", "bar \x1b[32mgreen\x1b[0m"]);
		expect(corpus.lines).toEqual(["foo", "bar green"]);
	});

	test("findSearchCorpusMatches：ANSI 剥离后按字面正则计数（不跨行）", () => {
		const raw = [
			"\x1b[31mhello\x1b[0m world", // 剥离后 "hello world" → l 命中 3 次
			"alpha LIMA beta", // 大小写不敏感：L/l 命中 2 次（alpha 含 a? 不，查 "l"）
			"no match here",
		];
		const corpus = buildSearchCorpus(raw);
		const matches = findSearchCorpusMatches(corpus, "l");
		// 行0: he[l][l]o wor[l]d → 3；行1: a[l]pha [L]IMA beta(无 l) → 2；共 5
		expect(matches.length).toBe(5);
		expect(matches[0]).toEqual({ row: 0, startCol: 2, endCol: 3 });
		expect(matches[3]).toEqual({ row: 1, startCol: 1, endCol: 2 });
		expect(matches[4]).toEqual({ row: 1, startCol: 6, endCol: 7 });
	});

	test("findSearchCorpusMatches：空查询/空语料回吐空数组", () => {
		expect(findSearchCorpusMatches(buildSearchCorpus(["abc"]), "   ")).toEqual([]);
		expect(findSearchCorpusMatches(buildSearchCorpus([]), "x")).toEqual([]);
	});

	test("escapeRegExp / normalizeQuery 工具", () => {
		expect(escapeRegExp("a.b+c")).toBe("a\\.b\\+c");
		expect(normalizeQuery("  foo   bar  ")).toBe("foo bar");
	});
});

describe("BI-19.1-search · next/prev 跳转与 wrap-around", () => {
	test("控制器 setQuery 选中首个命中；next/prev 循环且 wrap-around", () => {
		const search = new TranscriptSearch();
		const lines = ["aaa bbb ccc", "aaa ddd", "eee aaa"];
		search.open();
		search.setQuery(lines, "aaa"); // 命中 3 处：row0/0-3, row1/0-3, row2/4-7
		expect(search.matchCount).toBe(3);
		expect(search.currentIndex).toBe(0);
		expect(search.currentMatch).toEqual({ row: 0, startCol: 0, endCol: 3 });

		search.next();
		expect(search.currentIndex).toBe(1);
		expect(search.currentMatch!.row).toBe(1);
		search.next();
		expect(search.currentIndex).toBe(2);
		search.next(); // wrap-around 回到 0
		expect(search.currentIndex).toBe(0);

		search.prev(); // 从 0 wrap 到末
		expect(search.currentIndex).toBe(2);
		search.prev();
		expect(search.currentIndex).toBe(1);
	});

	test("无命中时 next/prev 为 no-op，下标保持 -1", () => {
		const search = new TranscriptSearch();
		search.open();
		search.setQuery(["only text"], "zzz");
		expect(search.matchCount).toBe(0);
		expect(search.currentIndex).toBe(-1);
		expect(search.currentMatch).toBeUndefined();
		search.next();
		search.prev();
		expect(search.currentIndex).toBe(-1);
	});

	test("增量缓存：源行/查询不变时复用命中结果", () => {
		const index = new TranscriptSearchIndex();
		const lines = ["foo bar foo", "baz"];
		const first = index.search(lines, "foo");
		expect(first.changed).toBe(true);
		expect(first.matches.length).toBe(2);
		// 同源同行 + 同查询 → 复用，changed=false
		const second = index.search(lines, "foo");
		expect(second.changed).toBe(false);
		expect(second.matches).toBe(first.matches);
		// 查询变化 → changed=true，命中重算
		const third = index.search(lines, "baz");
		expect(third.changed).toBe(true);
		expect(third.matches.length).toBe(1);
	});
});

describe("BI-19.1-search · 关闭后转录复原 + Esc 清零", () => {
	test("关闭后转录复原：命中/下标/激活态全部复位为中性", () => {
		const search = new TranscriptSearch();
		search.open();
		search.setQuery(["aaa bbb aaa", "ccc aaa"], "aaa");
		expect(search.matchCount).toBe(3);
		search.next();
		search.next();
		expect(search.currentIndex).toBe(2);

		search.close();

		expect(search.active).toBe(false);
		expect(search.matchCount).toBe(0);
		expect(search.currentIndex).toBe(-1);
		expect(search.currentMatch).toBeUndefined();
	});

	test("Esc 清零：触发关闭即清空查询串并退出激活态（对齐 agent-tui Esc 路由）", () => {
		const search = new TranscriptSearch();
		search.open();
		search.setQuery(["hello world hello"], "hello");
		expect(search.active).toBe(true);
		expect(search.query).toBe("hello");
		expect(search.matchCount).toBe(2);

		// agent-tui 按键路由对 Esc 的处理等价于：search.close()
		search.close();

		expect(search.active).toBe(false);
		expect(search.query).toBe(""); // 清零
		expect(search.matchCount).toBe(0);
	});

	test("open 后查询为空、无残留命中（可重新键入）", () => {
		const search = new TranscriptSearch();
		search.open();
		expect(search.active).toBe(true);
		expect(search.query).toBe("");
		expect(search.matchCount).toBe(0);
		search.setQuery(["abc abc"], "abc");
		expect(search.matchCount).toBe(2);
	});
});
