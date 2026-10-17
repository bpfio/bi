/**
 * BI-13.3 — 工具 Schema → 单行 TS 签名摘要器。
 * 与 BI-13.1 select-tools 口径互补：13.1 管按需激活（Schema 伸缩），本卡管静态名录压缩。
 */

interface SchemaLike {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, SchemaLike & { description?: string }>;
  required?: string[];
  items?: SchemaLike;
  anyOf?: SchemaLike[];
  oneOf?: SchemaLike[];
}

const MAX_DEPTH = 2;

function mapType(schema: SchemaLike | undefined, depth: number): string {
  if (schema == null || typeof schema !== "object") return "any";
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum.map((v) => (typeof v === "string" ? `'${v}'` : String(v))).join(" | ");
  }
  if (schema.anyOf || schema.oneOf) {
    return "any"; // 联合降级（保守）
  }
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `${mapType(schema.items, depth)}[]`;
    case "object": {
      if (depth >= MAX_DEPTH) return "object";
      const props = schema.properties ?? {};
      const req = new Set(schema.required ?? []);
      const parts = Object.entries(props).map(([k, v]) => {
        const opt = req.has(k) ? "" : "?";
        return `${k}${opt}: ${mapType(v, depth + 1)}`;
      });
      return parts.length > 0 ? `{ ${parts.join(", ")} }` : "object";
    }
    default:
      return "any";
  }
}

function clipDesc(desc: string | undefined, max = 120): string {
  if (!desc) return "";
  const d = desc.trim();
  if (d.length <= max) return d;
  return `${d.slice(0, max)}…`;
}

/** 单工具摘要行：`- ns.tool(args): ret // desc` */
export function summarizeToolLine(ns: string, tool: { name: string; description?: string; inputSchema?: unknown }): string {
  const schema = (tool.inputSchema ?? {}) as SchemaLike;
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? []);
  const args = Object.entries(props)
    .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${mapType(v as SchemaLike, 0)}`)
    .join(", ");
  const argsStr = args.length > 0 ? `args: { ${args} }` : "args?: Record<string, never>";
  const desc = clipDesc(tool.description);
  return `- ${ns}.${tool.name}(${argsStr}): unknown${desc ? ` // ${desc}` : ""}`;
}

/** 独立工具（无命名空间语境）签名：`tool(args): ret // desc` */
export function summarizeTool(tool: { name: string; description?: string; inputSchema?: unknown }): string {
  const schema = (tool.inputSchema ?? {}) as SchemaLike;
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? []);
  const args = Object.entries(props)
    .map(([k, v]) => `${k}${req.has(k) ? "" : "?"}: ${mapType(v as SchemaLike, 0)}`)
    .join(", ");
  const argsStr = args.length > 0 ? `args: { ${args} }` : "args?: Record<string, never>";
  const desc = clipDesc(tool.description);
  return `${tool.name}(${argsStr}): unknown${desc ? ` // ${desc}` : ""}`;
}
