import { describe, expect, test } from "bun:test";
import {
	FUZZY_MATCH_LIMIT_CHARS,
	levenshteinDistance,
	matchBlockAnchor,
	matchContextFallback,
	matchExact,
	matchIndentationFlexible,
	matchLineNumberStripped,
	matchLineTrimmed,
	matchOldText,
	matchQuoteNormalized,
	matchWhitespaceNormalized,
	similarityRatio,
	splitLines,
	type MatchResult,
} from "./edit-matchers";

/** 命中切片恒等式：index/matched 必须指向原文的可切片段。 */
function expectSpanInvariant(content: string, r: MatchResult): void {
	expect(r.index).toBeGreaterThanOrEqual(0);
	expect(content.slice(r.index, r.index + r.matched.length)).toBe(r.matched);
}

describe("第1级 exact", () => {
	test("精确命中：level/index/matched 三元组正确", () => {
		const file = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
		const r = matchOldText(file, "const b = 2;");
		expect(r.level).toBe("exact");
		expect(r.index).toBe(13);
		expect(r.matched).toBe("const b = 2;");
		expectSpanInvariant(file, r);
	});

	test("多点命中默认报歧义：index=-1、occurrences=2、阶梯终止", () => {
		const file = "x\nfoo\ny\nfoo\nz";
		const r = matchOldText(file, "foo");
		expect(r.level).toBe("exact");
		expect(r.ambiguous).toBe(true);
		expect(r.occurrences).toBe(2);
		expect(r.index).toBe(-1);
		expect(r.matched).toBe("");
	});

	test("onAmbiguous=first：多点取第一处", () => {
		const file = "x\nfoo\ny\nfoo\nz";
		const r = matchOldText(file, "foo", { onAmbiguous: "first" });
		expect(r.level).toBe("exact");
		expect(r.ambiguous).toBeUndefined();
		expect(r.index).toBe(2);
		expect(r.matched).toBe("foo");
		expectSpanInvariant(file, r);
	});
});

describe("第2级 quote_normalized", () => {
	test("模型带弯引号、文件是直引号：归一命中，matched 为原文直引号切片", () => {
		const file = 'const s = say("hi");\n';
		const old = "const s = say(\u201Chi\u201D);";
		const r = matchOldText(file, old);
		expect(r.level).toBe("quote_normalized");
		expect(r.index).toBe(0);
		expect(r.matched).toBe('const s = say("hi");');
		expectSpanInvariant(file, r);
	});

	test("双向归一：模型直引号、文件弯引号同样命中", () => {
		const file = "const s = say(\u2018hi\u2019);\n";
		const r = matchOldText(file, "const s = say('hi');");
		expect(r.level).toBe("quote_normalized");
		expect(r.matched).toBe("const s = say(\u2018hi\u2019);");
		expectSpanInvariant(file, r);
	});

	test("第2级歧义：弯引号文件两处命中，报 quote_normalized 歧义", () => {
		const file = "a(\u201Cx\u201D)b(\u201Cx\u201D)";
		const r = matchQuoteNormalized(file, '"x"');
		expect(r).not.toBeNull();
		expect(r!.level).toBe("quote_normalized");
		expect(r!.ambiguous).toBe(true);
		expect(r!.occurrences).toBe(2);
	});

	test("非引号差异不归第2级：返回 null 交给后续级", () => {
		expect(matchQuoteNormalized("a-b", "a+b")).toBeNull();
	});
});

describe("第3级 line_number_stripped", () => {
	test("剥离 `N→` 行号前缀后命中", () => {
		const file = "let a = 1;\nlet b = 2;\n";
		const r = matchOldText(file, "12\u2192let b = 2;");
		expect(r.level).toBe("line_number_stripped");
		expect(r.index).toBe(11);
		expect(r.matched).toBe("let b = 2;");
		expectSpanInvariant(file, r);
	});

	test("剥离 `N:` 行号前缀（含前导空白与后随空白）后命中", () => {
		const file = "bar();\n";
		const r = matchOldText(file, "  3: bar();");
		expect(r.level).toBe("line_number_stripped");
		expect(r.matched).toBe("bar();");
		expectSpanInvariant(file, r);
	});

	test("内容不同则第3级返回 null", () => {
		expect(matchLineNumberStripped("baz\n", "12\u2192foo")).toBeNull();
	});

	test("行号前缀 + 缩进漂移组合：line_trimmed（剥前缀后 trim）接住", () => {
		// old 行带前缀且内容缩进与文件（制表符）不同：L3 剥前缀后内容缩进不等，
		// L4/L5 归一不出（前缀未入其语义），L6 剥前缀+trim 命中。
		const file = "function f() {\n\treturn 1;\n}\n";
		const r = matchOldText(file, "4\u2192function f() {\n5\u2192    return 1;\n6\u2192}");
		expect(r.level).toBe("line_trimmed");
		expectSpanInvariant(file, r);
	});
});

describe("第4级 whitespace_normalized", () => {
	test("制表符 ↔ 4 空格归一命中，matched 保留文件原貌制表符", () => {
		const file = "function f() {\n\treturn 1;\n}\n";
		const r = matchOldText(file, "function f() {\n    return 1;\n}");
		expect(r.level).toBe("whitespace_normalized");
		expect(r.matched).toBe("function f() {\n\treturn 1;\n}");
		expectSpanInvariant(file, r);
	});

	test("行尾随空白剥离后命中", () => {
		const file = "a = 1;   \nb = 2;\t\n";
		const r = matchOldText(file, "a = 1;\nb = 2;");
		expect(r.level).toBe("whitespace_normalized");
		expect(r.matched).toBe("a = 1;   \nb = 2;\t");
		expectSpanInvariant(file, r);
	});

	test("行首缩进差异不在第4级语义内：返回 null（由第5/6级接手）", () => {
		expect(matchWhitespaceNormalized("  foo();\n", "foo();")).toBeNull();
	});

	test("内容差异不归第4级", () => {
		expect(matchWhitespaceNormalized("a = 1;\n", "a = 2;")).toBeNull();
	});
});

describe("第5级 indentation_flexible", () => {
	test("整块绝对缩进漂移：相对结构一致即命中，matched 保留文件缩进", () => {
		const file = "  if (x) {\n    foo();\n  }\n";
		const r = matchOldText(file, "if (x) {\n  foo();\n}");
		expect(r.level).toBe("indentation_flexible");
		expect(r.index).toBe(0);
		expect(r.matched).toBe("  if (x) {\n    foo();\n  }");
		expectSpanInvariant(file, r);
	});

	test("块内含空行：空行不参与基线，相对结构保持即命中", () => {
		const file = "  a {\n\n    b;\n  }\n";
		const r = matchOldText(file, "a {\n\n  b;\n}");
		expect(r.level).toBe("indentation_flexible");
		expect(r.matched).toBe("  a {\n\n    b;\n  }");
		expectSpanInvariant(file, r);
	});

	test("相对缩进结构不一致：第5级拒绝（绝不硬凑）", () => {
		const file = "  if (x) {\n      foo();\n  }\n";
		expect(matchIndentationFlexible(file, "if (x) {\n  foo();\n}")).toBeNull();
	});

	test("第5级歧义：两个同形漂移块报歧义", () => {
		const file = "  foo\n  bar\nsep\n  foo\n  bar\n";
		const r = matchIndentationFlexible(file, "foo\nbar");
		expect(r).not.toBeNull();
		expect(r!.level).toBe("indentation_flexible");
		expect(r!.ambiguous).toBe(true);
		expect(r!.occurrences).toBe(2);
	});
});

describe("第6级 line_trimmed", () => {
	test("行首行尾空白在 trim 域整块命中", () => {
		const file = "code();\n   next();   \nlast();\n";
		const r = matchOldText(file, "code();\nnext();\nlast();");
		expect(r.level).toBe("line_trimmed");
		expect(r.matched).toBe("code();\n   next();   \nlast();");
		expectSpanInvariant(file, r);
	});

	test("内容差异第6级返回 null", () => {
		expect(matchLineTrimmed("alpha\n", "beta")).toBeNull();
	});
});

describe("第7级 block_anchor", () => {
	test("中段轻微改写：相似度 ≥0.8 模糊对齐命中", () => {
		const file = "start\nalpha = compute(1);\nbeta = compute(2);\nend\n";
		const r = matchOldText(file, "start\nalpha = compute(1);\nbeta = compute(3);\nend");
		expect(r.level).toBe("block_anchor");
		expect(r.index).toBe(0);
		expect(r.matched).toBe("start\nalpha = compute(1);\nbeta = compute(2);\nend");
		expectSpanInvariant(file, r);
	});

	test("中段完全改写（相似度 <0.8）：第7级拒绝", () => {
		const file = "start\nThis line is totally rewritten beyond recognition\nend\n";
		expect(matchBlockAnchor(file, "start\nzzz\nend")).toBeNull();
	});

	test("多候选取最高相似度胜者", () => {
		const file = "start\nvalue = 1;\nend\nmid\nstart\nvalue = 2;\nend\n";
		// 阶梯语境 exact 会先命中，这里直接调级函数验证第7级自身的择优。
		const r = matchBlockAnchor(file, "start\nvalue = 1;\nend");
		expect(r).not.toBeNull();
		expect(r!.index).toBe(0);
		expectSpanInvariant(file, r!);
	});

	test("并列最高分按歧义策略处理；first 取最早起点", () => {
		const file = "start\nabc\nend\nsep\nstart\nabc\nend\n";
		const ambiguous = matchBlockAnchor(file, "start\nabd\nend");
		expect(ambiguous).not.toBeNull();
		expect(ambiguous!.ambiguous).toBe(true);
		expect(ambiguous!.occurrences).toBe(2);
		const first = matchBlockAnchor(file, "start\nabd\nend", { onAmbiguous: "first" });
		expect(first!.index).toBe(0);
	});
});

describe("第8级 context_fallback", () => {
	test("块面 目全非但存在唯一上下文行：重锚到 ±2 窗口", () => {
		const file = 'import x from "x";\n\nfunction uniqueHelper() {\n  stale1\n  stale2\n  stale3\n  stale4\n}\n\nother\n';
		const r = matchOldText(file, "function uniqueHelper() {\n  TOTALLY\n  DIFFERENT\n  CONTENT\n  HERE\n}");
		expect(r.level).toBe("context_fallback");
		expect(r.index).toBe(0);
		expect(r.matched).toBe('import x from "x";\n\nfunction uniqueHelper() {\n  stale1\n  stale2');
		expectSpanInvariant(file, r);
	});

	test("无唯一行（所有行多处出现）：返回 null", () => {
		expect(matchContextFallback("a\nb\na\nb", "a\nb")).toBeNull();
	});

	test("窗口在文件头部/尾部钳制", () => {
		const head = matchContextFallback("uniqueTop()\nfiller1\nfiller2\nfiller3\n", "uniqueTop()\nzzz");
		expect(head).not.toBeNull();
		expect(head!.index).toBe(0);
		expect(head!.matched).toBe("uniqueTop()\nfiller1\nfiller2");
		expectSpanInvariant("uniqueTop()\nfiller1\nfiller2\nfiller3\n", head!);
		const tail = matchContextFallback("f1\nf2\nf3\nuniqueTail()\n", "zzz\nuniqueTail()");
		expect(tail).not.toBeNull();
		// 锚在末行，窗口 = [末行-2, 末行] 钳制。
		expect(tail!.matched).toBe("f2\nf3\nuniqueTail()");
	});

	test("锚行按 oldText 行序取第一个唯一行，不取非唯一行", () => {
		// "common" 在文件出现两次；"lone" 唯一 → 锚取 lone。
		const file = "x1\ncommon\nx2\nlone\nx3\ncommon\nx4\n";
		const r = matchContextFallback(file, "common\nzzz\nlone");
		expect(r).not.toBeNull();
		// 锚在文件第 3 行（0 基），窗口 = [1, 5]。
		expect(r!.matched).toBe("common\nx2\nlone\nx3\ncommon");
		expectSpanInvariant(file, r!);
	});
});

describe("阶梯语义与全局不变式", () => {
	test("低级命中即停：完全一致内容判 exact 而非更宽松级别", () => {
		const r = matchOldText("foo\nbar\n", "foo\nbar");
		expect(r.level).toBe("exact");
	});

	test("降级顺序：仅缩进漂移的内容判第5级（先于 line_trimmed）", () => {
		const r = matchOldText("  foo();\n  bar();\n", "foo();\nbar();");
		expect(r.level).toBe("indentation_flexible");
	});

	test("中文内容 + 弯引号：归一级命中", () => {
		const file = "const 提示 = \"你好，世界\";\n";
		const r = matchOldText(file, "const 提示 = \u201C你好，世界\u201D;");
		expect(r.level).toBe("quote_normalized");
		expect(r.matched).toBe("const 提示 = \"你好，世界\";");
		expectSpanInvariant(file, r);
	});

	test("CRLF 文件 × LF oldText：行级对齐（第3级，无行号时为恒等行窗）命中且 matched 保留 CRLF 原貌", () => {
		const file = "a = 1;\r\nb = 2;\r\nc = 3;\r\n";
		const r = matchOldText(file, "b = 2;\nc = 3;");
		expect(r.level).toBe("line_number_stripped");
		expect(r.index).toBe(8);
		expect(r.matched).toBe("b = 2;\r\nc = 3;");
		expectSpanInvariant(file, r);
	});

	test("oldText 以换行结尾且文件行有终止符：终止符并入 matched", () => {
		const file = "a = 1;\r\nb = 2;\r\nc = 3;\r\n";
		const r = matchOldText(file, "b = 2;\n");
		expect(r.level).toBe("line_number_stripped");
		expect(r.matched).toBe("b = 2;\r\n");
		expectSpanInvariant(file, r);
	});

	test("空 oldText / 空 fileContent：直接 unmatched", () => {
		expect(matchOldText("abc", "").level).toBe("unmatched");
		expect(matchOldText("", "abc").level).toBe("unmatched");
	});

	test("8 级全败：unmatched", () => {
		const r = matchOldText("one\ntwo\nthree\n", "四\n五\n六");
		expect(r.level).toBe("unmatched");
		expect(r.index).toBe(-1);
		expect(r.matched).toBe("");
	});

	test("超 64KB 上限：跳过 7/8 级，仅中段改写的近似块判 unmatched", () => {
		const block = "head\nAAA middle line BBB\nend\n";
		const file = "x".repeat(FUZZY_MATCH_LIMIT_CHARS + 1) + "\n" + "head\nAAA middle line CCC\nend\n";
		const r = matchOldText(file, block);
		expect(r.level).toBe("unmatched");
	}, 5_000);

	test("未超限的中段改写块仍由第7级接住（与上例互为反证）", () => {
		const file = "pad\nhead\nAAA middle line BBB\nend\n";
		const r = matchOldText(file, "head\nAAA middle line CCC\nend");
		expect(r.level).toBe("block_anchor");
	});
});

describe("相似度函数与行切分（纯函数单元）", () => {
	test("levenshteinDistance 基准值", () => {
		expect(levenshteinDistance("kitten", "sitting")).toBe(3);
		expect(levenshteinDistance("", "abc")).toBe(3);
		expect(levenshteinDistance("same", "same")).toBe(0);
	});

	test("similarityRatio：恒等=1、已知距离=10/13、空对空=1", () => {
		expect(similarityRatio("abc", "abc")).toBe(1);
		expect(similarityRatio("kitten", "sitting")).toBeCloseTo(10 / 13);
		expect(similarityRatio("", "")).toBe(1);
		expect(similarityRatio("abc", "xyz")).toBeCloseTo(0.5);
		expect(similarityRatio("a", "xyz")).toBeLessThan(0.5);
	});

	test("复杂度保护：超 64KB 或超单元预算一律按不相似（返回 0）", () => {
		expect(similarityRatio("a".repeat(FUZZY_MATCH_LIMIT_CHARS + 1), "a")).toBe(0);
		// 2000×2000 = 4M > 1M 单元预算。
		expect(similarityRatio("a".repeat(2000), "b".repeat(2000))).toBe(0);
	});

	test("splitLines：\\r\\n / \\n / \\r 终止符分离，末行终止符不产生幻影空行", () => {
		const spans = splitLines("a\r\nb\nc\rd\n");
		expect(spans.map((l) => l.text)).toEqual(["a", "b", "c", "d"]);
		expect(spans.map((l) => l.term)).toEqual(["\r\n", "\n", "\r", "\n"]);
		const none = splitLines("");
		expect(none).toHaveLength(1);
		expect(none[0]!.text).toBe("");
	});
});
