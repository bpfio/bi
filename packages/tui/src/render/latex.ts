/**
 * render/latex —— 终端 LaTeX 公式 ASCII/Unicode 渲染。
 *
 * BI-19.8 合约：renderLatex(src): string[]，最小子集：
 * - \frac{a}{b}：分子/横线/分母三行（ASCII 横线 ─，超深嵌套展平为 (a)/(b)）；
 * - x^2 / x_i：同行后缀，可映射字符转 Unicode 上/下标（²/ᵢ/¹⁰/ᵢ₌₁…），
 *   不可映射回退 ^2 / _2 形态；
 * - \sqrt{x}：√(x) 括号形态（多行内容时括号包住中部行）；
 * - \sum_{i}^{n}：Σ 上下限堆叠（display 风格三行）；无限值单行 Σ；
 * - 希腊字母映射表（小写 24 + 大写 10）；普通文本透传；
 * - 未知命令 → 原文透传 + 警告行（renderLatex 输出尾部追加 ⚠ 行，不抛异常）；
 * - 多行公式：按换行与 `\\`（LaTeX 换行命令）分块，逐块渲染拼接。
 *
 * 零外部依赖；宽度测量复用 components/cjk-width。
 */

import { tokenizeMath } from "./math-lexer";
import type { MathToken } from "./math-lexer";
import { textWidth } from "../components/cjk-width";

export interface LatexRenderResult {
  lines: string[];
  warnings: string[];
}

/** 分数嵌套深度上限（超过则展平为 (a)/(b) 行内形态）。 */
export const MAX_FRAC_DEPTH = 4;

/** 希腊字母映射表：小写全表 24 + 大写常用 10。 */
const GREEK: Record<string, string> = {
  "\\alpha": "α",
  "\\beta": "β",
  "\\gamma": "γ",
  "\\delta": "δ",
  "\\epsilon": "ε",
  "\\zeta": "ζ",
  "\\eta": "η",
  "\\theta": "θ",
  "\\iota": "ι",
  "\\kappa": "κ",
  "\\lambda": "λ",
  "\\mu": "μ",
  "\\nu": "ν",
  "\\xi": "ξ",
  "\\pi": "π",
  "\\rho": "ρ",
  "\\sigma": "σ",
  "\\tau": "τ",
  "\\upsilon": "υ",
  "\\phi": "φ",
  "\\chi": "χ",
  "\\psi": "ψ",
  "\\omega": "ω",
  "\\varepsilon": "ε",
  "\\varphi": "φ",
  "\\Gamma": "Γ",
  "\\Delta": "Δ",
  "\\Theta": "Θ",
  "\\Lambda": "Λ",
  "\\Xi": "Ξ",
  "\\Pi": "Π",
  "\\Sigma": "Σ",
  "\\Phi": "Φ",
  "\\Psi": "Ψ",
  "\\Omega": "Ω",
};

/** 上标映射（可全映射才转 Unicode，任一字符缺映射即回退 ^ 形态）。 */
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  d: "ᵈ",
  e: "ᵉ",
  f: "ᶠ",
  g: "ᵍ",
  h: "ʰ",
  i: "\u2071" /* ⁱ ⁱ → U+2071 上标 i */,
  j: "ʲ",
  k: "ᵏ",
  l: "ˡ",
  m: "ᵐ",
  n: "ⁿ",
  o: "ᵒ",
  p: "ᵖ",
  r: "ʳ",
  s: "ˢ",
  t: "ᵗ",
  u: "ᵘ",
  v: "ᵛ",
  w: "ʷ",
  x: "ˣ",
  y: "ʸ",
  z: "ᶻ",
};

/** 下标映射。 */
const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

function mapScript(s: string, table: Record<string, string>): string | null {
  let out = "";
  for (const ch of s) {
    const m = table[ch];
    if (m === undefined) return null;
    out += m;
  }
  return out;
}

function toSuperscript(s: string): string {
  return mapScript(s, SUPERSCRIPT) ?? "^" + s;
}

function toSubscript(s: string): string {
  return mapScript(s, SUBSCRIPT) ?? "_" + s;
}

// ---------------------------------------------------------------------------
// 盒模型：{ rows, baseline }，水平拼接按基线对齐，垂直堆叠按中心对齐
// ---------------------------------------------------------------------------

interface Box {
  rows: string[];
  baseline: number;
}

function flatText(s: string): Box {
  return { rows: [s], baseline: 0 };
}

function boxWidth(b: Box): number {
  let w = 0;
  for (const r of b.rows) w = Math.max(w, textWidth(r));
  return w;
}

/** 中心对齐堆叠：baseline 指向 mid 的行序号（mid 为空时取中间）。 */
function vstackCenter(parts: Box[], baselineIndex: number): Box {
  const w = Math.max(1, ...parts.map(boxWidth));
  const rows: string[] = [];
  for (const p of parts) {
    for (const r of p.rows) {
      const pad = w - textWidth(r);
      const left = Math.ceil(pad / 2);
      rows.push(" ".repeat(left) + r + " ".repeat(pad - left));
    }
  }
  return { rows, baseline: baselineIndex };
}

/** 基线对齐水平拼接。 */
function hcat(parts: Box[]): Box {
  if (parts.length === 0) return flatText("");
  const maxBase = Math.max(...parts.map((p) => p.baseline));
  const maxBottom = Math.max(...parts.map((p) => p.rows.length - 1 - p.baseline));
  const totalRows = maxBase + maxBottom + 1;
  const rows: string[] = new Array(totalRows).fill("");
  for (const p of parts) {
    const w = boxWidth(p);
    const top = maxBase - p.baseline;
    for (let y = 0; y < totalRows; y++) {
      const src = y - top;
      const seg = src >= 0 && src < p.rows.length ? p.rows[src]! : "";
      const pad = w - textWidth(seg);
      rows[y] = rows[y]! + seg + " ".repeat(pad);
    }
  }
  return { rows, baseline: maxBase };
}

/** 分数盒：分子 / 横线 / 分母；超深展平为行内 (num)/(den)。横线取最宽者。 */
function fracBox(num: Box, den: Box, warnings: string[], depth: number): Box {
  if (depth >= MAX_FRAC_DEPTH) {
    warnings.push(`fraction nesting depth exceeded (>${MAX_FRAC_DEPTH}); flattened inline`);
    return hcat([flatText("("), num, flatText(")/("), den, flatText(")")]);
  }
  const w = Math.max(1, boxWidth(num), boxWidth(den));
  const centerRows = (b: Box): string[] =>
    b.rows.map((r) => {
      const pad = w - textWidth(r);
      const left = Math.ceil(pad / 2);
      return " ".repeat(left) + r + " ".repeat(pad - left);
    });
  const rows = [...centerRows(num), "─".repeat(w), ...centerRows(den)];
  return { rows, baseline: num.rows.length };
}

/** 根号盒：单行内容 √(x)；多行内容括号包住中部行。 */
function sqrtBox(inner: Box): Box {
  if (inner.rows.length === 1) {
    return flatText(`√(${inner.rows[0]})`);
  }
  const w = boxWidth(inner);
  const rows = inner.rows.map((r, y) => {
    const pad = w - textWidth(r);
    const body = r + " ".repeat(pad);
    return y === inner.baseline ? `√(${body})` : `  ${body} `;
  });
  return { rows, baseline: inner.baseline };
}

/** 求和盒：Σ 上下限堆叠（display 风格）；上下限用原文（非 Unicode 角标）。 */
function sumBox(sup: Box | null, sub: Box | null): Box {
  if (sup && sub) {
    return vstackCenter([sup, flatText("Σ"), sub], 1);
  }
  if (sup) return vstackCenter([sup, flatText("Σ")], 1);
  if (sub) return vstackCenter([flatText("Σ"), sub], 0);
  return flatText("Σ");
}

// ---------------------------------------------------------------------------
// 语法层：token 流 → 盒
// ---------------------------------------------------------------------------

interface Ctx {
  warnings: string[];
}

function renderToken(tk: MathToken, cur: CursorState, ctx: Ctx, depth: number): Box {
  if (tk.kind === "char") return flatText(tk.value);
  if (tk.kind === "group") return layout(tk.children ?? [], ctx, depth);
  if (tk.kind === "lbrace" || tk.kind === "rbrace") return flatText(tk.value);
  // command
  const name = tk.value;
  if (name === "\\frac") {
    return renderFrac(cur, ctx, depth);
  }
  if (name === "\\sqrt") {
    return renderSqrt(cur, ctx, depth);
  }
  if (name === "\\sum") {
    return renderSum(cur, ctx, depth);
  }
  const greek = GREEK[name];
  if (greek !== undefined) return flatText(greek);
  ctx.warnings.push(`unknown command: ${name}`);
  // 原文透传：紧随的 group 保留花括号原样
  const next = cur.tokens[cur.i];
  if (next && next.kind === "group") {
    cur.i += 1;
    return flatText(`${name}{${flatten(layout(next.children ?? [], ctx, depth))}}`);
  }
  return flatText(name);
}

interface CursorState {
  tokens: MathToken[];
  i: number;
}

/** 读取下一个"单原子"参数：group → 展开；其余单 token 原样渲染。 */
function nextAtom(cur: CursorState, ctx: Ctx, depth: number): Box | null {
  if (cur.i >= cur.tokens.length) return null;
  const tk = cur.tokens[cur.i++]!;
  return renderToken(tk, cur, ctx, depth);
}

function renderFrac(cur: CursorState, ctx: Ctx, depth: number): Box {
  const num = nextAtom(cur, ctx, depth + 1);
  const den = nextAtom(cur, ctx, depth + 1);
  if (!num || !den) {
    ctx.warnings.push("\\frac missing argument");
    return flatText("\\frac");
  }
  return fracBox(num, den, ctx.warnings, depth);
}

function renderSqrt(cur: CursorState, ctx: Ctx, depth: number): Box {
  const inner = nextAtom(cur, ctx, depth + 1);
  if (!inner) {
    ctx.warnings.push("\\sqrt missing argument");
    return flatText("\\sqrt");
  }
  return sqrtBox(inner);
}

function renderSum(cur: CursorState, ctx: Ctx, depth: number): Box {
  let sup: Box | null = null;
  let sub: Box | null = null;
  // 上下限顺序无关：_\sum^ 或 ^\sum_ 均可（最多两轮）
  for (let k = 0; k < 2; k++) {
    const tk = cur.tokens[cur.i];
    if (!tk || tk.kind !== "char" || (tk.value !== "_" && tk.value !== "^")) break;
    cur.i += 1;
    const arg = nextAtom(cur, ctx, depth + 1);
    if (!arg) {
      ctx.warnings.push(`\\sum dangling ${tk.value === "_" ? "subscript" : "superscript"}`);
      break;
    }
    if (tk.value === "_") sub = arg;
    else sup = arg;
  }
  return sumBox(sup, sub);
}

function layout(tokens: MathToken[], ctx: Ctx, depth: number): Box {
  const parts: Box[] = [];
  const cur: CursorState = { tokens, i: 0 };
  while (cur.i < tokens.length) {
    const tk = tokens[cur.i++]!;
    if (tk.kind === "char" && (tk.value === "^" || tk.value === "_")) {
      const arg = nextAtom(cur, ctx, depth);
      if (!arg) {
        ctx.warnings.push(`dangling ${tk.value === "_" ? "subscript" : "superscript"} marker`);
        parts.push(flatText(tk.value));
        continue;
      }
      const content = flatten(arg);
      parts.push(flatText(tk.value === "^" ? toSuperscript(content) : toSubscript(content)));
      continue;
    }
    parts.push(renderToken(tk, cur, ctx, depth));
  }
  return hcat(parts);
}

/** 多行盒压平为单行串（脚本参数内嵌分数等场景）。 */
function flatten(b: Box): string {
  return b.rows.join("");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 渲染单块（无换行/换行分隔符）公式。 */
function renderBlock(block: string, warnings: string[]): string[] {
  const tokens = tokenizeMath(block.trim());
  const box = layout(tokens, { warnings }, 0);
  return box.rows.map((r) => r.replace(/\s+$/, ""));
}

export function renderLatexDetailed(src: string): LatexRenderResult {
  const warnings: string[] = [];
  const lines: string[] = [];
  const blocks = src.split(/\\\\|\r?\n/);
  for (const block of blocks) {
    if (block.trim().length === 0) continue;
    lines.push(...renderBlock(block, warnings));
  }
  return { lines, warnings };
}

/** 渲染公式；警告以 ⚠ 行追加在输出尾部（不抛异常）。 */
export function renderLatex(src: string): string[] {
  const { lines, warnings } = renderLatexDetailed(src);
  return [...lines, ...warnings.map((w) => `⚠ ${w}`)];
}
