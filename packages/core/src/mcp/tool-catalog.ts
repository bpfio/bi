/**
 * BI-13.3 — 分级命名空间工具名录压缩器（2,000 Token 硬预算 + 渐进式展现）。
 * token 估算：chars/4 保守近似（doc 口径）；预算单位=token。
 */
import { summarizeToolLine } from "./catalog-summarizer";

export interface CatalogTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}
export interface CatalogSource {
  name: string;
  tools: CatalogTool[];
}
export interface CatalogNode {
  namespace: string;
  tools: CatalogTool[];
  toolCount: number;
  hasSchema: boolean;
}
export interface CatalogRoot {
  namespaces: CatalogNode[];
  totalTools: number;
}

export function buildCatalog(sources: CatalogSource[]): CatalogRoot {
  const namespaces: CatalogNode[] = sources.map((s) => ({
    namespace: s.name,
    tools: s.tools.map((t) => ({ ...t })),
    toolCount: s.tools.length,
    hasSchema: s.tools.some((t) => t.inputSchema != null),
  }));
  return { namespaces, totalTools: namespaces.reduce((n, x) => n + x.toolCount, 0) };
}

/** token 估算：chars/4 向上取整（保守近似口径） */
export function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export interface FlattenOptions {
  /** pinned 工具名：无论预算如何，其完整签名行保顶输出 */
  pinned?: string[];
}

/**
 * 渐进式展现：预算内从粗粒度（`- ns: N tools` 摘要行）到细粒度（完整签名行）逐行吃预算。
 * - pinned 行保顶：恒输出，且先行占用预算；
 * - 命名空间整体能放下→整体展开；放不下→先出摘要行，再逐行尝试（一行放不下整行跳过）；
 * - 预算耗尽→停在当前粒度，其余命名空间保持摘要行（无摘要余量则直接截断）。
 */
export function flattenBudget(root: CatalogRoot, budgetTokens: number, opts: FlattenOptions = {}): string[] {
  const pinned = new Set(opts.pinned ?? []);
  const lines: string[] = [];
  let used = 0;

  for (const ns of root.namespaces) {
    for (const t of ns.tools) {
      if (pinned.has(t.name)) {
        const line = summarizeToolLine(ns.namespace, t);
        lines.push(line);
        used += estTokens(line);
      }
    }
  }

  for (const ns of root.namespaces) {
    const unpinned = ns.tools.filter((t) => !pinned.has(t.name));
    if (unpinned.length === 0) continue;
    const fullLines = unpinned.map((t) => summarizeToolLine(ns.namespace, t));
    const fullCost = fullLines.reduce((a, l) => a + estTokens(l), 0);
    if (used + fullCost <= budgetTokens) {
      lines.push(...fullLines);
      used += fullCost;
      continue;
    }
    const summary = `- ${ns.namespace}: ${unpinned.length} tools`;
    const summaryCost = estTokens(summary);
    if (used + summaryCost > budgetTokens) {
      break; // 摘要都放不下：预算耗尽，停在当前粒度
    }
    lines.push(summary);
    used += summaryCost;
    for (const line of fullLines) {
      const c = estTokens(line);
      if (used + c <= budgetTokens) {
        lines.push(line);
        used += c;
      } // 整行跳过
    }
  }
  return lines;
}

/** 指定命名空间强制细粒度展开（不受预算约束），其余命名空间保持摘要行。 */
export function expandNamespace(root: CatalogRoot, ns: string, budgetTokens: number, opts: FlattenOptions = {}): string[] {
  const pinned = new Set(opts.pinned ?? []);
  const target = root.namespaces.find((n) => n.namespace === ns);
  if (!target) throw new RangeError(`unknown-namespace: ${ns}`);
  const lines: string[] = [];
  for (const n of root.namespaces) {
    if (n.namespace === ns) {
      for (const t of n.tools) lines.push(summarizeToolLine(n.namespace, t));
      continue;
    }
    const unpinned = n.tools.filter((t) => !pinned.has(t.name));
    if (unpinned.length === 0) continue;
    lines.push(`- ${n.namespace}: ${unpinned.length} tools`);
  }
  void budgetTokens;
  return lines;
}
