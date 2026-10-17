/**
 * render/math-lexer —— LaTeX 数学 token 化。
 *
 * BI-19.8 合约：把数学源串切成 token 流：
 * - command：`\` + 连续字母（如 `\alpha`），或 `\` + 单个非字母（如 `\{`）；
 * - group：配对花括号 `{...}`（value = 内部原文，children = 递归 token 化；
 *   内部 `\` 转义的花括号不参与配对计数）；
 * - char：其余单字符（含 `^`/`_`，由上层语法器消费）；
 * - lbrace/rbrace：未配对的花括号原样保留（不炸）。
 */

export type MathTokenKind = "command" | "group" | "char" | "lbrace" | "rbrace";

export interface MathToken {
  kind: MathTokenKind;
  value: string;
  /** kind === "group" 时的子 token 序列 */
  children?: MathToken[];
}

const LETTER = /[a-zA-Z]/;

export function tokenizeMath(src: string): MathToken[] {
  const out: MathToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      const j = i + 1;
      if (j >= src.length) {
        out.push({ kind: "char", value: "\\" });
        i = j;
      } else if (LETTER.test(src[j]!)) {
        let k = j;
        while (k < src.length && LETTER.test(src[k]!)) k++;
        out.push({ kind: "command", value: src.slice(i, k) });
        i = k;
      } else {
        out.push({ kind: "command", value: src.slice(i, j + 1) });
        i = j + 1;
      }
    } else if (ch === "{") {
      // 扫描配对闭括号（跳过反斜杠转义）
      let depth = 1;
      let j = i + 1;
      while (j < src.length) {
        const c = src[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) break;
        }
        j++;
      }
      if (depth === 0 && j < src.length) {
        const inner = src.slice(i + 1, j);
        out.push({ kind: "group", value: inner, children: tokenizeMath(inner) });
        i = j + 1;
      } else {
        out.push({ kind: "lbrace", value: "{" });
        i++;
      }
    } else if (ch === "}") {
      out.push({ kind: "rbrace", value: "}" });
      i++;
    } else {
      out.push({ kind: "char", value: ch });
      i++;
    }
  }
  return out;
}
