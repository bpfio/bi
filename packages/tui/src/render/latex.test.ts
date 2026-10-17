import { describe, expect, test } from "bun:test";
import { tokenizeMath } from "./math-lexer";
import { MAX_FRAC_DEPTH, renderLatex, renderLatexDetailed } from "./latex";

describe("math-lexer —— token 化", () => {
  test("命令 token：\\alpha 整体成词", () => {
    const tokens = tokenizeMath("\\alpha+x");
    expect(tokens).toEqual([
      { kind: "command", value: "\\alpha" },
      { kind: "char", value: "+" },
      { kind: "char", value: "x" },
    ]);
  });

  test("花括号组：递归子 token，value 保留内部原文", () => {
    const tokens = tokenizeMath("\\frac{a}{bc}");
    expect(tokens[0]).toEqual({ kind: "command", value: "\\frac" });
    expect(tokens[1]!.kind).toBe("group");
    expect(tokens[1]!.value).toBe("a");
    expect(tokens[1]!.children).toEqual([{ kind: "char", value: "a" }]);
    expect(tokens[2]!.kind).toBe("group");
    expect(tokens[2]!.children?.length).toBe(2);
  });

  test("嵌套组与转义花括号不计入配对", () => {
    const tokens = tokenizeMath("{\\alpha{x\\}}y}");
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.kind).toBe("group");
    const kids = tokens[0]!.children!;
    expect(kids[0]).toEqual({ kind: "command", value: "\\alpha" });
    expect(kids[1]!.kind).toBe("group");
    expect(kids[2]).toEqual({ kind: "char", value: "y" });
  });

  test("未配对花括号 → lbrace/rbrace（不炸）", () => {
    expect(tokenizeMath("{a")).toEqual([
      { kind: "lbrace", value: "{" },
      { kind: "char", value: "a" },
    ]);
    expect(tokenizeMath("a}")).toEqual([
      { kind: "char", value: "a" },
      { kind: "rbrace", value: "}" },
    ]);
  });

  test("反斜杠+非字母单字符命令（如 \\{）", () => {
    expect(tokenizeMath("\\{")).toEqual([{ kind: "command", value: "\\{" }]);
    expect(tokenizeMath("\\")).toEqual([{ kind: "char", value: "\\" }]);
  });
});

describe("renderLatex —— 基础与希腊字母", () => {
  test("普通文本透传", () => {
    expect(renderLatex("hello world")).toEqual(["hello world"]);
    expect(renderLatex("E = mc^2")).toEqual(["E = mc²"]);
  });

  test("希腊字母映射表（小写全表）", () => {
    const cases: Array<[string, string]> = [
      ["\\alpha", "α"],
      ["\\beta", "β"],
      ["\\gamma", "γ"],
      ["\\delta", "δ"],
      ["\\epsilon", "ε"],
      ["\\zeta", "ζ"],
      ["\\eta", "η"],
      ["\\theta", "θ"],
      ["\\iota", "ι"],
      ["\\kappa", "κ"],
      ["\\lambda", "λ"],
      ["\\mu", "μ"],
      ["\\nu", "ν"],
      ["\\xi", "ξ"],
      ["\\pi", "π"],
      ["\\rho", "ρ"],
      ["\\sigma", "σ"],
      ["\\tau", "τ"],
      ["\\upsilon", "υ"],
      ["\\phi", "φ"],
      ["\\chi", "χ"],
      ["\\psi", "ψ"],
      ["\\omega", "ω"],
    ];
    for (const [cmd, glyph] of cases) {
      expect(renderLatex(cmd)).toEqual([glyph]);
    }
    expect(renderLatex("\\alpha\\beta")).toEqual(["αβ"]);
  });

  test("大写希腊字母", () => {
    expect(renderLatex("\\Gamma \\Delta \\Omega")).toEqual(["Γ Δ Ω"]);
    expect(renderLatex("\\Sigma \\Lambda \\Phi")).toEqual(["Σ Λ Φ"]);
  });
});

describe("renderLatex —— 分数", () => {
  test("简单分数三行：分子/横线/分母", () => {
    expect(renderLatex("\\frac{a}{b}")).toEqual(["a", "─", "b"]);
  });

  test("宽度不齐分子分母居中，横线取最宽", () => {
    expect(renderLatex("\\frac{10}{5}")).toEqual(["10", "──", " 5"]);
    expect(renderLatex("\\frac{x}{abc}")).toEqual([" x", "───", "abc"]);
  });

  test("分数与邻居同行基线对齐（横线在基线行）", () => {
    const lines = renderLatex("1 + \\frac{a}{b} + 2");
    expect(lines).toEqual(["    a", "1 + ─ + 2", "    b"]);
  });

  test("嵌套分数低于深度上限正常展开", () => {
    const lines = renderLatex("\\frac{\\frac{a}{b}}{c}");
    expect(lines).toEqual(["a", "─", "b", "─", "c"]);
    // 分子为多行盒时横线落在分子基线之下
    const mixed = renderLatex("x + \\frac{\\frac{a}{b}}{c}");
    expect(mixed[3]).toBe("x + ─");
  });

  test("嵌套分数超过深度上限 → 展平为行内形态 + 警告（不炸）", () => {
    const deep = "\\frac{\\frac{\\frac{\\frac{\\frac{a}{b}}{c}}{d}}{e}}{f}";
    const { lines, warnings } = renderLatexDetailed(deep);
    expect(warnings.some((w) => w.includes("nesting depth"))).toBe(true);
    expect(lines.join("\n")).toContain("(a)/(b)");
    // 再深一层也不炸
    const deeper = renderLatex(deep + "!");
    expect(Array.isArray(deeper)).toBe(true);
    expect(MAX_FRAC_DEPTH).toBe(4);
  });

  test("\\frac 缺参数 → 原样透传 + 警告", () => {
    const { lines, warnings } = renderLatexDetailed("\\frac{a}");
    expect(lines).toEqual(["\\frac"]);
    expect(warnings.some((w) => w.includes("missing argument"))).toBe(true);
  });
});

describe("renderLatex —— 上下标与根号", () => {
  test("x^2 / x_i 同行后缀 Unicode 形态", () => {
    expect(renderLatex("x^2")).toEqual(["x²"]);
    expect(renderLatex("x_i")).toEqual(["xᵢ"]);
    expect(renderLatex("x^{10}")).toEqual(["x¹⁰"]);
    expect(renderLatex("x_{ij}")).toEqual(["xᵢⱼ"]);
    expect(renderLatex("a^{n+1}")).toEqual(["aⁿ⁺¹"]);
  });

  test("不可映射字符回退 ^/_ 形态", () => {
    expect(renderLatex("x^q")).toEqual(["x^q"]);
    expect(renderLatex("x^{qx}")).toEqual(["x^qx"]); // q 无上标 → 整组回退
    expect(renderLatex("x_{Q}")).toEqual(["x_Q"]);
  });

  test("根号 √ 括号形态", () => {
    expect(renderLatex("\\sqrt{x}")).toEqual(["√(x)"]);
    expect(renderLatex("\\sqrt{2}+\\sqrt{3}")).toEqual(["√(2)+√(3)"]);
  });

  test("根号内多行内容：括号包住中部行", () => {
    expect(renderLatex("\\sqrt{\\frac{1}{2}}")).toEqual(["  1", "√(─)", "  2"]);
  });
});

describe("renderLatex —— 求和与多行", () => {
  test("\\sum 上下限堆叠 display 风格", () => {
    const lines = renderLatex("\\sum_{i=1}^{n}");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("n");
    expect(lines[1]).toContain("Σ");
    expect(lines[2]).toContain("i=1");
  });

  test("\\sum 单下限两行 / 无限值单行", () => {
    const withSub = renderLatex("\\sum_{i}");
    expect(withSub).toEqual(["Σ", "i"]);
    expect(renderLatex("\\sum")).toEqual(["Σ"]);
  });

  test("未知命令原文透传 + ⚠ 警告行（不炸）", () => {
    const lines = renderLatex("\\foo + x");
    expect(lines[0]).toBe("\\foo + x");
    expect(lines[1]).toBe("⚠ unknown command: \\foo");
    const d = renderLatexDetailed("\\bar{x}");
    expect(d.lines[0]).toBe("\\bar{x}"); // 未知命令透传原文 \bar，花括号组保留
    expect(d.warnings).toEqual(["unknown command: \\bar"]);
  });

  test("多行公式：换行与 \\\\ 命令分块", () => {
    expect(renderLatex("a\nb")).toEqual(["a", "b"]);
    const lines = renderLatex("\\frac{a}{b} \\\\ c");
    expect(lines).toEqual(["a", "─", "b", "c"]);
  });

  test("空输入返回空", () => {
    expect(renderLatex("")).toEqual([]);
    expect(renderLatex("  \n ")).toEqual([]);
  });
});
