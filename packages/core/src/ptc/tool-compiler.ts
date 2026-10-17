/**
 * BI-16.2 · PTC (Programmatic Tool Calling) —— 工具清单 → 类型声明面编译器。
 *
 * 把运行时工具清单(名称 + JSON Schema 描述对象)动态编译为可注入 System
 * Prompt 的类型声明面,供模型以"写精算脚本"的方式程序化调用工具(PTC Mode):
 *
 *   - language: "ts"     → `declare const tools: { name(args: {...}): Promise<Result> }`
 *   - language: "python" → `class Tools:` 的 .pyi 片段(async def + 类型注解)
 *
 * 设计约束:
 *   - 零外部依赖:纯 schema → 声明文本的确定性映射;
 *   - 确定性:同一输入永远产出逐字节相同的声明面(可快照断言);
 *   - 类型映射覆盖 string / number(integer) / boolean / array(items) /
 *     object(嵌套 properties)/ enum(字面量联合)/ required 可选标记;
 *   - 非法标识符(-、.、数字开头等)与 Python 关键字做确定性净化,并在
 *     声明面中保留 @originalName 注记,保证模型看到的即可调用的;
 *   - 工具级 description 渲染进 JSDoc/Docstring;属性级 description 不渲染。
 */

export type PtcLanguage = "ts" | "python";

/** 覆盖本编译器关心的 JSON Schema 子集(零外部依赖,不引入完整 JSON Schema 类型)。 */
export interface JsonSchema {
  type?: string | readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  items?: JsonSchema | readonly JsonSchema[];
  enum?: readonly unknown[];
  description?: string;
}

export interface ToolManifest {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

export interface CompileOptions {
  /** 输出语言:TypeScript 声明面 或 Python .pyi 片段。 */
  language: PtcLanguage;
  /** 返回值类型名;TS 中包裹为 Promise<T>,Python 中作为返回注解。默认 "ToolResult"。 */
  resultType?: string;
  /** 缩进单元,默认两个空格。 */
  indent?: string;
  /** 对象内联展开最大深度,超出回退 Record<string, unknown> / dict[str, Any]。默认 8。 */
  maxDepth?: number;
}

/** Python 硬关键字(def 名不可用;软关键字 match/case/type 合法故不在列)。 */
const PY_KEYWORDS: ReadonlySet<string> = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]);

/**
 * 标识符净化:
 *   - ts:替换非法字符为 `_`,数字开头补 `_` 前缀(成员位置关键字合法,不改动);
 *   - python:替换非法字符(含 `$`)为 `_`,数字开头补 `_`,硬关键字补 `_` 后缀。
 */
export function sanitizeIdent(name: string, language: PtcLanguage): string {
  const cleaned = String(name).replace(
    language === "ts" ? /[^A-Za-z0-9_$]/g : /[^A-Za-z0-9_]/g,
    "_",
  );
  const headed = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return language === "python" && PY_KEYWORDS.has(headed) ? `${headed}_` : headed;
}

/** 在同一作用域内净化并去重(净化碰撞时追加 `_2`、`_3`…)。 */
function uniqueIdent(name: string, language: PtcLanguage, used: Set<string>): string {
  const base = sanitizeIdent(name, language) || "_tool";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}_${n}`)) n++;
  const out = `${base}_${n}`;
  used.add(out);
  return out;
}

/** JSON 字面量 → TS 字面量类型文本。 */
function jsonLiteralToTs(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return "unknown";
}

/** JSON 字面量 → Python Literal 成员文本。 */
function jsonLiteralToPy(v: unknown): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return String(v);
  return "Any";
}

/** 判定 items 为元组形态(readonly 数组)。 */
function isTupleItems(
  items: JsonSchema | readonly JsonSchema[] | undefined,
): items is readonly JsonSchema[] {
  return Array.isArray(items);
}

/** TS 类型映射(schema → 类型文本)。深度超限回退:object 折叠 Record,其余 unknown。 */
function tsTypeOf(schema: JsonSchema, depth: number, maxDepth: number): string {
  if (depth > maxDepth) {
    return schema.type === "object" ? "Record<string, unknown>" : "unknown";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(jsonLiteralToTs).join(" | ");
  }
  const t = schema.type;
  if (Array.isArray(t)) {
    return t.map((x) => tsTypeOf({ ...schema, type: x }, depth, maxDepth)).join(" | ");
  }
  switch (t) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = schema.items;
      if (isTupleItems(items)) {
        return `[${items.map((it) => tsTypeOf(it, depth + 1, maxDepth)).join(", ")}]`;
      }
      return items ? `Array<${tsTypeOf(items, depth + 1, maxDepth)}>` : "Array<unknown>";
    }
    case "object": {
      return tsObjectBody(schema, depth, maxDepth) ?? "Record<string, unknown>";
    }
    default:
      return "unknown";
  }
}

/** 对象 properties → 内联 `{ a: T; b?: U }`;无/空 properties 返回 null。 */
function tsObjectBody(
  schema: JsonSchema,
  depth: number,
  maxDepth: number,
): string | null {
  const props = schema.properties;
  if (!props) return null;
  const entries = Object.entries(props);
  if (entries.length === 0) return null;
  const required = new Set(schema.required ?? []);
  const used = new Set<string>();
  const parts = entries.map(([key, sub]) => {
    const ident = uniqueIdent(key, "ts", used);
    const opt = required.has(key) ? "" : "?";
    return `${ident}${opt}: ${tsTypeOf(sub, depth + 1, maxDepth)}`;
  });
  return `{ ${parts.join("; ")} }`;
}

/** TS 参数列表:无 schema → 零参;有 schema 无有效 properties → Record 兜底。 */
function tsParams(schema: JsonSchema | undefined, maxDepth: number): string {
  if (!schema) return "";
  const body = tsObjectBody(schema, 0, maxDepth);
  return body ? `args: ${body}` : "args: Record<string, unknown>";
}

/** Python 类型映射。深度超限回退:object 折叠 dict[str, Any],其余 Any。 */
function pyTypeOf(schema: JsonSchema, depth: number, maxDepth: number): string {
  if (depth > maxDepth) {
    return schema.type === "object" ? "dict[str, Any]" : "Any";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return `Literal[${schema.enum.map(jsonLiteralToPy).join(", ")}]`;
  }
  const t = schema.type;
  if (Array.isArray(t)) {
    return t.map((x) => pyTypeOf({ ...schema, type: x }, depth, maxDepth)).join(" | ");
  }
  switch (t) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "array": {
      const items = schema.items;
      if (isTupleItems(items)) {
        return `list[${items.map((it) => pyTypeOf(it, depth + 1, maxDepth)).join(" | ")}]`;
      }
      return items ? `list[${pyTypeOf(items, depth + 1, maxDepth)}]` : "list[Any]";
    }
    case "object":
      return "dict[str, Any]";
    default:
      return "Any";
  }
}

/** Python 参数列表:required 优先(语法强制),其后 optional 带 `= ...` 缺省。 */
function pyParams(schema: JsonSchema | undefined, maxDepth: number): string {
  if (!schema) return "self";
  const props = schema.properties ? Object.entries(schema.properties) : [];
  if (props.length === 0) return "self, payload: dict[str, Any]";
  const required = new Set(schema.required ?? []);
  const used = new Set<string>();
  const render = ([key, sub]: [string, JsonSchema]): string => {
    const ident = uniqueIdent(key, "python", used);
    const py = pyTypeOf(sub, 1, maxDepth);
    return required.has(key) ? `${ident}: ${py}` : `${ident}: Optional[${py}] = ...`;
  };
  const ordered = [
    ...props.filter(([k]) => required.has(k)),
    ...props.filter(([k]) => !required.has(k)),
  ];
  return `self, ${ordered.map(render).join(", ")}`;
}

/** 中和会提前终止 JSDoc 块注释的 `*`+`/` 序列。 */
function cleanTsDescription(desc: string): string {
  return desc.replace(/\r\n?/g, "\n").replace(/\*\//g, "*\\/");
}

/** 单行化并中和会破坏 Docstring 的 `"""` 序列。 */
function cleanPyDescription(desc: string): string {
  return desc.replace(/\s+/g, " ").trim().replace(/"""/g, '\\"\\"\\"');
}

/**
 * 把工具清单编译为类型声明面(确定性输出,可快照断言)。
 *
 * 形态约定:
 *   - TS:工具清单为空 → `declare const tools: {};`;
 *     无 inputSchema → 零参调用 `name()`;有 schema 无 properties →
 *     `args: Record<string, unknown>` 兜底;有 properties → 内联对象类型。
 *   - Python:`class Tools` 每工具一个 `async def`;无 inputSchema →
 *     零参(仅 self);无 properties → `payload: dict[str, Any]`;
 *     required 参数按 schema 内相对顺序前置。
 */
export function compileToolDeclarations(
  manifests: readonly ToolManifest[],
  options: CompileOptions,
): string {
  const language = options.language;
  const resultType = options.resultType ?? "ToolResult";
  const indent = options.indent ?? "  ";
  const maxDepth = options.maxDepth ?? 8;

  const used = new Set<string>();
  const entries = manifests.map((m) => {
    const ident = uniqueIdent(String(m.name), language, used);
    return { manifest: m, ident, renamed: ident !== m.name };
  });

  if (language === "ts") {
    const lines: string[] = [
      "// PTC tool surface (compiled by BI-16.2 tool-compiler)",
      "declare const tools: {",
    ];
    for (const e of entries) {
      const desc = cleanTsDescription(e.manifest.description ?? "");
      if (desc !== "" || e.renamed) {
        lines.push(`${indent}/**`);
        for (const line of desc.split("\n")) {
          lines.push(`${indent} * ${line}`.trimEnd());
        }
        if (e.renamed) lines.push(`${indent} * @originalName ${e.manifest.name}`);
        lines.push(`${indent} */`);
      }
      lines.push(
        `${indent}${e.ident}(${tsParams(e.manifest.inputSchema, maxDepth)}): Promise<${resultType}>;`,
      );
    }
    lines.push("};");
    return lines.join("\n");
  }

  const lines: string[] = [
    "# PTC tool surface (compiled by BI-16.2 tool-compiler)",
    "from typing import Any, Literal, Optional",
    "",
    "class Tools:",
    `${indent}"""Programmatic tool calling surface (compiled by BI-16.2 tool-compiler)."""`,
  ];
  for (const e of entries) {
    lines.push("");
    if (e.renamed) lines.push(`${indent}# original name: ${e.manifest.name}`);
    lines.push(
      `${indent}async def ${e.ident}(${pyParams(e.manifest.inputSchema, maxDepth)}) -> ${resultType}:`,
    );
    const desc = cleanPyDescription(e.manifest.description ?? "");
    if (desc !== "") lines.push(`${indent}${indent}"""${desc}"""`);
    lines.push(`${indent}${indent}...`);
  }
  return lines.join("\n");
}

/** 便捷封装:编译 TypeScript 声明面。 */
export function compileTsToolSurface(
  manifests: readonly ToolManifest[],
  options?: Omit<CompileOptions, "language">,
): string {
  return compileToolDeclarations(manifests, { ...options, language: "ts" });
}

/** 便捷封装:编译 Python .pyi 片段。 */
export function compilePyiToolSurface(
  manifests: readonly ToolManifest[],
  options?: Omit<CompileOptions, "language">,
): string {
  return compileToolDeclarations(manifests, { ...options, language: "python" });
}
