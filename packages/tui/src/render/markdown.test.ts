/**
 * render/markdown —— BI-27.3 富文本转录验收（手写解析器，零依赖，全离线）。
 *
 * 覆盖：
 * 1. ATX 标题：标记剥离 + 整行 bold+cyan 样式；`#` 后无空格不误判（字面透传）；
 * 2. 行内样式：**粗体** / __粗体__ / *斜体* / _斜体_（含嵌套）、`行内代码`
 *    （标记剥离 + 前景色）、`\` 转义、未闭合定界符字面透传、贴字边界
 *    （a_b_c 不触发斜体）；
 * 3. 围栏代码块：``` / ~~~ 开合、内容行整体 dim、未闭合围栏优雅降级、
 *    latex/tex/math 走 renderLatex（BI-19.8）、mermaid 走 renderMermaid
 *    （BI-19.6）、器官产物原样落行不抛异常；
 * 4. 列表：无序 `-`/`*`/`+` → `•`（缩进保留）、有序 `1.` 原样透传；
 * 5. 折行：按显示列宽贪心（CJK 宽字符计 2 列不劈字）、样式跨行延续、
 *    firstRowIndent 首行预算收缩、rowPlain 拼接还原折行无损；
 * 6. 降级：畸形输入永不抛异常（外层兜底退化纯文本）、极端窄宽（width=1）。
 */
import { describe, expect, test } from "bun:test";

import { renderMarkdown, rowPlain, type MarkdownRow } from "./markdown";

/** 视图行 → [拼接文本, 首分段样式键] 断言小工具。 */
function plain(rows: readonly MarkdownRow[]): string[] {
  return rows.map((r) => rowPlain(r));
}

describe("BI-27.3 · renderMarkdown 块级", () => {
  test("ATX 标题：标记剥离 + bold/cyan 样式；1-6 级等价", () => {
    const rows = renderMarkdown("# 大标题", 40);
    expect(rows).toHaveLength(1);
    expect(rowPlain(rows[0]!)).toBe("大标题");
    expect(rows[0]!.spans).toHaveLength(1);
    expect(rows[0]!.spans[0]!.style).toEqual({ bold: true, fg: "cyan" });

    const h6 = renderMarkdown("###### 六级", 40);
    expect(rowPlain(h6[0]!)).toBe("六级");
    expect(h6[0]!.spans[0]!.style).toEqual({ bold: true, fg: "cyan" });

    // `#` 后无空格：不误判标题，原样透传
    const literal = renderMarkdown("#标签", 40);
    expect(rowPlain(literal[0]!)).toBe("#标签");
    expect(literal[0]!.spans[0]!.style).toBeUndefined();
  });

  test("无序列表：-/*/+ 换 •、缩进保留；有序列表原样透传", () => {
    expect(plain(renderMarkdown("- 甲", 40))).toEqual(["• 甲"]);
    expect(plain(renderMarkdown("* 乙", 40))).toEqual(["• 乙"]);
    expect(plain(renderMarkdown("+ 丙", 40))).toEqual(["• 丙"]);
    expect(plain(renderMarkdown("  - 嵌套", 40))).toEqual(["  • 嵌套"]);
    // 列表项内行内样式仍解析
    const styled = renderMarkdown("- **重点**", 40);
    expect(rowPlain(styled[0]!)).toBe("• 重点");
    expect(styled[0]!.spans.map((s) => s.style?.bold)).toEqual([undefined, true]);
    // 有序：编号可读，原样透传
    expect(plain(renderMarkdown("1. 第一", 40))).toEqual(["1. 第一"]);
    expect(plain(renderMarkdown("10) 第十", 40))).toEqual(["10) 第十"]);
  });

  test("空行保留为空视图行（结构分隔）", () => {
    const rows = renderMarkdown("甲\n\n乙", 40);
    expect(plain(rows)).toEqual(["甲", "", "乙"]);
  });

  test("围栏代码块：``` 开合、内容整体 dim、围栏行剥离", () => {
    const rows = renderMarkdown("前文\n```ts\nconst a = 1;\nlet b = 2;\n```\n后文", 40);
    expect(plain(rows)).toEqual(["前文", "const a = 1;", "let b = 2;", "后文"]);
    expect(rows[1]!.spans[0]!.style).toEqual({ dim: true });
    expect(rows[2]!.spans[0]!.style).toEqual({ dim: true });
  });

  test("围栏 ~~~ 形态与未闭合围栏优雅降级", () => {
    const tilde = renderMarkdown("~~~\nx\n~~~", 40);
    expect(plain(tilde)).toEqual(["x"]);
    expect(tilde[0]!.spans[0]!.style).toEqual({ dim: true });
    // 未闭合：残余内容按代码块收尾（不吞行、不抛异常）
    const unclosed = renderMarkdown("```\nalpha\nbeta", 40);
    expect(plain(unclosed)).toEqual(["alpha", "beta"]);
    expect(unclosed.every((r) => r.spans[0]!.style?.dim === true)).toBe(true);
  });

  test("latex/tex/math 围栏走 renderLatex（BI-19.8）：\\frac 三行产物", () => {
    const rows = renderMarkdown("```latex\n\\frac{a}{b}\n```", 40);
    expect(plain(rows)).toEqual(["a", "─", "b"]);
    const tex = renderMarkdown("```tex\n\\frac{x}{y}\n```", 40);
    expect(plain(tex)).toEqual(["x", "─", "y"]);
  });

  test("mermaid 围栏走 renderMermaid（BI-19.6）：框线图产物落行", () => {
    const rows = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```", 60);
    const text = plain(rows).join("\n");
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).toContain("│"); // 框线字符（图形化证据）
  });

  test("畸形输入降级：永不抛异常", () => {
    // 各类畸形组合：解析器全容错 + 外层兜底
    const weird = "**未闭合 *斜 _下 `反引\n\t#伪标题\n- \n``` \n~~~x";
    expect(() => renderMarkdown(weird, 20)).not.toThrow();
    // 极端窄宽不抛（宽字符独立成行硬放语义由 wrap 承担）
    expect(() => renderMarkdown("中文**粗**`码`", 1)).not.toThrow();
  });
});

describe("BI-27.3 · renderMarkdown 行内", () => {
  test("粗体 ** 与 __：标记剥离、bold 样式、前后文保留", () => {
    const rows = renderMarkdown("前**粗**后", 40);
    expect(rows[0]!.spans).toEqual([
      { text: "前" },
      { text: "粗", style: { bold: true } },
      { text: "后" },
    ]);
    const under = renderMarkdown("__整段__", 40);
    expect(rowPlain(under[0]!)).toBe("整段");
    expect(under[0]!.spans[0]!.style).toEqual({ bold: true });
  });

  test("斜体 * 与 _：标记剥离、italic 样式", () => {
    const rows = renderMarkdown("*斜*", 40);
    expect(rows[0]!.spans[0]!.style).toEqual({ italic: true });
    const under = renderMarkdown("_斜体文_", 40);
    expect(under[0]!.spans[0]!.style).toEqual({ italic: true });
  });

  test("嵌套：粗体包斜体/行内代码（有界递归 + 样式叠加）", () => {
    const rows = renderMarkdown("**粗 *里* 粗**", 40);
    expect(rowPlain(rows[0]!)).toBe("粗 里 粗");
    expect(rows[0]!.spans[0]!.style).toEqual({ bold: true });
    expect(rows[0]!.spans[1]!.style).toEqual({ bold: true, italic: true });
    const code = renderMarkdown("**x `c` y**", 40);
    expect(rowPlain(code[0]!)).toBe("x c y");
    expect(code[0]!.spans[1]!.style).toEqual({ bold: true, fg: "cyan" });
  });

  test("行内代码：闭合 ` 内容原样（不再解析标记）、前景色", () => {
    const rows = renderMarkdown("前 `a*b*` 后", 40);
    expect(rowPlain(rows[0]!)).toBe("前 a*b* 后");
    expect(rows[0]!.spans[1]!.style).toEqual({ fg: "cyan" });
    // 未闭合反引号：字面透传
    expect(plain(renderMarkdown("前 ` 开", 40))).toEqual(["前 ` 开"]);
  });

  test("转义 \\：下一字符字面（不触发定界）", () => {
    const rows = renderMarkdown("\\*不是斜体\\*", 40);
    expect(rowPlain(rows[0]!)).toBe("*不是斜体*");
    expect(rows[0]!.spans).toHaveLength(1);
    expect(rows[0]!.spans[0]!.style).toBeUndefined();
  });

  test("贴字边界：a_b_c 不触发斜体；未闭合 ** 字面透传", () => {
    expect(plain(renderMarkdown("a_b_c", 40))).toEqual(["a_b_c"]);
    expect(plain(renderMarkdown("snake_case_word 保持", 40))).toEqual(["snake_case_word 保持"]);
    expect(plain(renderMarkdown("**未闭合", 40))).toEqual(["**未闭合"]);
    // 空定界（** 紧跟空白）：不误判
    expect(plain(renderMarkdown("** 空白**", 40))).toEqual(["** 空白**"]);
  });
});

describe("BI-27.3 · renderMarkdown 折行（cell-grid 安全）", () => {
  test("超宽贪心折行：与 L3 wrapLine 同语义（空格留在续行首，折行无损）", () => {
    const text = "aa bb cc dd ee";
    const rows = renderMarkdown(text, 5);
    expect(plain(rows)).toEqual(["aa bb", " cc d", "d ee"]);
    // 折行无损：拼接逐字还原原行
    expect(plain(rows).join("")).toBe(text);
  });

  test("CJK 宽字符计 2 列、不劈字", () => {
    const rows = renderMarkdown("甲乙丙丁戊", 5); // 每字 2 列：一行放 2 字
    expect(plain(rows)).toEqual(["甲乙", "丙丁", "戊"]);
  });

  test("样式跨行延续：粗体句折行后各段仍带 bold", () => {
    const rows = renderMarkdown("**aaaa bbbb**", 4);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.spans.every((s) => s.style?.bold === true)).toBe(true);
    }
    expect(plain(rows).join("")).toBe("aaaa bbbb");
  });

  test("firstRowIndent：首行按 width-indent 预算收缩（[assistant] 前缀垫位）", () => {
    const plainRows = renderMarkdown("hello world", 11);
    expect(plain(plainRows)).toEqual(["hello world"]);
    // 首行预算 11-11=0 → 钳 1：首行只放得下 1 列，其余行整宽（空格保留=无损）
    const indented = renderMarkdown("hello world", 11, { firstRowIndent: 11 });
    expect(rowPlain(indented[0]!)).toBe("h");
    expect(plain(indented).join("")).toBe("hello world");
  });

  test("无样式行产物不含任何转义序列（网格安全）", () => {
    const rows = renderMarkdown("# 标\n- `x` **y**\n```ts\nz\n```", 40);
    for (const row of rows) {
      for (const span of row.spans) {
        expect(span.text.includes("\x1b")).toBe(false);
      }
    }
  });
});
