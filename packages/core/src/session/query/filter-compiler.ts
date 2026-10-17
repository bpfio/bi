/**
 * 最小会话语料过滤语法编译器（BI-03.7）：`compileFilter`。
 *
 * 语法（EBNF 子集，and 优先级高于 or）：
 *   expr   := orExpr
 *   orExpr := andExpr ( "or" andExpr )*
 *   andExpr:= atom ( "and" atom )*
 *   atom   := "type=" word | "tool=" word | "contains:" text | "after:" iso8601
 *
 * 词法约定：
 *  - 原子以空白分隔；contains: 的文本可含空白，原子终止于「空白 + 裸 and/or 词元」处；
 *  - 因此 contains 文本内不能出现裸 " and " / " or " 词（最小语法已知限制）；
 *  - after: 接受 Date.parse 可解析的 ISO 8601 字符串，语义为严格大于（ts > iso）。
 *
 * 非法语法一律抛 FilterSyntaxError（code 结构化：empty-expr / dangling-operator /
 * unknown-atom / bad-atom），绝不静默放行为「全匹配」。
 */

/** 语料条目投影（权威定义见 ./sqlite-corpus，此处 structural 复用）。 */
export interface CorpusEntry {
  id: number;
  sessionId: string;
  type: string;
  tool: string | null;
  text: string;
  ts: string;
}

export type FilterPredicate = (entry: CorpusEntry) => boolean;

export interface FilterSyntaxErrorShape {
  code: "empty-expr" | "dangling-operator" | "unknown-atom" | "bad-atom";
  message: string;
  position?: number;
}

export class FilterSyntaxError extends Error {
  readonly code: FilterSyntaxErrorShape["code"];
  readonly position?: number;

  constructor(shape: FilterSyntaxErrorShape) {
    super(shape.message);
    this.name = "FilterSyntaxError";
    this.code = shape.code;
    this.position = shape.position;
  }
}

type Token = { kind: "atom"; text: string; position: number } | { kind: "and" | "or"; position: number };

/** 关键词边界：and/or 后不能紧跟词字符/冒号/等号（防 android / contains:and 误切）。 */
const KEYWORD_RE = /^(?:and|or)(?![\w:=-])/;
/** 原子边界：一段空白 + 捕获裸 and/or（回跳点按捕获长度计算）。 */
const ATOM_BOUNDARY_RE = /\s+(and|or)(?![\w:=-])/g;

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** 词法：切出原子与 and/or 词元（contains 文本允许内嵌空白）。 */
function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = expr.length;
  while (i < n) {
    while (i < n && isSpace(expr[i])) i += 1;
    if (i >= n) break;
    const kw = KEYWORD_RE.exec(expr.slice(i));
    if (kw) {
      tokens.push({ kind: kw[0] as "and" | "or", position: i });
      i += kw[0].length;
      continue;
    }
    // 原子：读到「空白+裸 and/or」边界或串尾。
    ATOM_BOUNDARY_RE.lastIndex = i + 1; // 至少前进一位，防零宽死循环
    const boundary = ATOM_BOUNDARY_RE.exec(expr);
    let atomEnd = n;
    let nextStart = -1;
    if (boundary) {
      atomEnd = boundary.index;
      // 关键词起点 = 边界匹配末尾回退关键词长度（and=3 / or=2）。
      nextStart = boundary.index + boundary[0].length - (boundary[1]?.length ?? 0);
    }
    const raw = expr.slice(i, atomEnd).replace(/\s+$/, "");
    if (raw.length === 0) {
      throw new FilterSyntaxError({
        code: "unknown-atom",
        message: `无法识别的过滤原子（位置 ${i}）`,
        position: i,
      });
    }
    tokens.push({ kind: "atom", text: raw, position: i });
    if (nextStart === -1) break;
    i = nextStart;
  }
  return tokens;
}

/** 单原子编译；非法形态/取值抛结构化错误。 */
function compileAtom(token: Token & { kind: "atom" }): FilterPredicate {
  const atom = token.text;
  const at = token.position;
  // 非 contains: 原子内嵌空白 = 相邻原子缺连接词（type/user tool=bash 之类），
  // 词法层无法区分意图，在此拒绝，绝不静默并成一个怪原子。
  if (!atom.startsWith("contains:") && /\s/.test(atom)) {
    throw new FilterSyntaxError({
      code: "dangling-operator",
      message: `位置 ${at} 附近存在相邻原子（缺少 and/or 连接词）: ${JSON.stringify(atom)}`,
      position: at,
    });
  }
  if (atom.startsWith("type=")) {
    const value = atom.slice("type=".length);
    if (value.length === 0) {
      throw new FilterSyntaxError({ code: "bad-atom", message: "type= 取值不能为空", position: at });
    }
    return (entry) => entry.type === value;
  }
  if (atom.startsWith("tool=")) {
    const value = atom.slice("tool=".length);
    if (value.length === 0) {
      throw new FilterSyntaxError({ code: "bad-atom", message: "tool= 取值不能为空", position: at });
    }
    return (entry) => entry.tool === value; // tool 为 null 的条目永不匹配
  }
  if (atom.startsWith("contains:")) {
    const needle = atom.slice("contains:".length);
    if (needle.length === 0) {
      throw new FilterSyntaxError({ code: "bad-atom", message: "contains: 文本不能为空", position: at });
    }
    return (entry) => entry.text.includes(needle);
  }
  if (atom.startsWith("after:")) {
    const iso = atom.slice("after:".length);
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) {
      throw new FilterSyntaxError({
        code: "bad-atom",
        message: `after: 无法解析时间: ${JSON.stringify(iso)}`,
        position: at,
      });
    }
    return (entry) => Date.parse(entry.ts) > ms;
  }
  throw new FilterSyntaxError({
    code: "unknown-atom",
    message: `未知过滤原子: ${JSON.stringify(atom)}（允许 type=/tool=/contains:/after:）`,
    position: at,
  });
}

/** 递归下降解析（and 优先级 > or）；结构非法抛 dangling-operator。 */
function parseExpr(expr: string, tokens: Token[]): FilterPredicate {
  if (tokens.length === 0) {
    throw new FilterSyntaxError({ code: "empty-expr", message: "过滤表达式为空" });
  }
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const expectAtom = (): FilterPredicate => {
    const token = peek();
    if (token === undefined) {
      throw new FilterSyntaxError({
        code: "dangling-operator",
        message: "表达式以连接词结尾（缺原子）",
      });
    }
    if (token.kind !== "atom") {
      throw new FilterSyntaxError({
        code: "dangling-operator",
        message: `位置 ${token.position} 处连接词 ${token.kind} 缺少左侧/右侧原子`,
        position: token.position,
      });
    }
    pos += 1;
    return compileAtom(token);
  };

  const parseAnd = (): FilterPredicate => {
    let left = expectAtom();
    for (;;) {
      const token = peek();
      if (token === undefined || token.kind !== "and") break;
      pos += 1;
      const right = expectAtom();
      const l = left;
      left = (entry) => l(entry) && right(entry);
    }
    return left;
  };

  const parseOr = (): FilterPredicate => {
    let left = parseAnd();
    for (;;) {
      const token = peek();
      if (token === undefined || token.kind !== "or") break;
      pos += 1;
      const right = parseAnd();
      const l = left;
      left = (entry) => l(entry) || right(entry);
    }
    return left;
  };

  const predicate = parseOr();
  if (pos !== tokens.length) {
    const token = tokens[pos];
    throw new FilterSyntaxError({
      code: "dangling-operator",
      message:
        token !== undefined && token.kind !== "atom"
          ? `位置 ${token.position} 处出现相邻连接词 ${token.kind}`
          : "表达式存在未连接的相邻原子（缺少 and/or）",
      position: token?.position,
    });
  }
  return predicate;
}

/**
 * 编译过滤表达式为谓词函数。
 * expr 为空/纯空白 → empty-expr；非法结构/原子/取值 → 结构化错误。
 */
export function compileFilter(expr: string): FilterPredicate {
  if (expr.trim().length === 0) {
    throw new FilterSyntaxError({ code: "empty-expr", message: "过滤表达式为空" });
  }
  return parseExpr(expr, tokenize(expr));
}
