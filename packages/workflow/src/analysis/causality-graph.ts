/**
 * BI-14.1 · 因果拓扑图编译器——Kahn 拓扑排序 / 死锁检测 / Mermaid 渲染。
 *
 * 与 engine.ts 的关系：引擎内部分层调度用的是同语义的私有实现（卡 1 落地、
 * 已测）；本模块把拓扑分析提升为公共分析 API，供编排前静态检查（环/死锁）
 * 与图可视化使用。二者错误码对齐（cycle-detected / unknown-dep /
 * duplicate-step），判定算法同源（Kahn 计数）。
 *
 * 死锁语义（detectDeadlock）：依赖图不可拓扑收满即死锁——环（A↔B 互相等）
 * 或依赖悬空（引用不存在的步骤，条件永不满足）均判 true。
 *
 * Mermaid 输出（toMermaid）：纯字符串生成，`graph TD`；节点先按声明序裸声明
 * （孤立节点因此可见），随后逐条依赖边 `dep --> id`。仅负责确定性生成，不
 * 校验 Mermaid 语法（id 假定为合法标识符，完整校验归后续增强）。
 */

/** 图节点：工作流步骤的最小投影（只关心 id 与依赖）。 */
export interface GraphStep {
  id: string;
  depends_on: string[];
}

export interface TopoSortResult {
  /** 拓扑序：层序拼接，层内保持声明顺序（确定性）。 */
  order: string[];
  /** 分层：第 k 层的步骤恰依赖 <k 层的全部步骤。 */
  layers: string[][];
}

/** 结构化图错误（判别方式：code 字段；码与 engine.parseWorkflow 对齐）。 */
export class CausalityError extends Error {
  readonly code: "duplicate-step" | "unknown-dep" | "cycle-detected" | "unknown-node";

  constructor(
    code: "duplicate-step" | "unknown-dep" | "cycle-detected" | "unknown-node",
    message: string,
  ) {
    super(message);
    this.name = "CausalityError";
    this.code = code;
  }
}

/** 建索引：重复 id → duplicate-step；未知依赖 → unknown-dep。 */
function indexSteps(steps: readonly GraphStep[]): {
  byId: Map<string, GraphStep>;
  dependents: Map<string, string[]>;
} {
  const byId = new Map<string, GraphStep>();
  for (const s of steps) {
    if (byId.has(s.id)) {
      throw new CausalityError("duplicate-step", `步骤 id "${s.id}" 重复`);
    }
    byId.set(s.id, s);
  }
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    for (const d of s.depends_on) {
      if (!byId.has(d)) {
        throw new CausalityError(
          "unknown-dep",
          `步骤 "${s.id}" 依赖不存在的步骤 "${d}"`,
        );
      }
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [s.id]);
      else list.push(s.id);
    }
  }
  return { byId, dependents };
}

/** Kahn 主循环：返回分层与是否收满；收不满即有环（层内保持声明顺序）。 */
function kahnLayers(
  steps: readonly GraphStep[],
  dependents: ReadonlyMap<string, string[]>,
): { layers: string[][]; complete: boolean } {
  const indeg = new Map<string, number>();
  for (const s of steps) indeg.set(s.id, s.depends_on.length);
  const layers: string[][] = [];
  const settled = new Set<string>();
  let frontier = steps.filter((s) => s.depends_on.length === 0).map((s) => s.id);
  while (frontier.length > 0) {
    layers.push(frontier);
    for (const id of frontier) settled.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        const left = (indeg.get(dep) ?? 0) - 1;
        indeg.set(dep, left);
        if (left === 0) next.push(dep);
      }
    }
    frontier = next;
  }
  return { layers, complete: settled.size === steps.length };
}

/**
 * Kahn 拓扑排序：order 为层序拼接、层内声明序；环 → CausalityError
 * （code="cycle-detected"，附卡死步骤清单）。
 */
export function topoSort(steps: readonly GraphStep[]): TopoSortResult {
  const { dependents } = indexSteps(steps);
  const { layers, complete } = kahnLayers(steps, dependents);
  if (!complete) {
    const settled = new Set(layers.flat());
    const stuck = steps.map((s) => s.id).filter((id) => !settled.has(id));
    throw new CausalityError(
      "cycle-detected",
      `依赖图存在环，卡死步骤: ${stuck.join(", ")}`,
    );
  }
  return { order: layers.flat(), layers };
}

/**
 * 死锁检测：依赖图不可拓扑收满（环或依赖悬空）即 true。不抛错——
 * 非法图（重复 id）按不可收满处理判 true；空图为 false。
 */
export function detectDeadlock(steps: readonly GraphStep[]): boolean {
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) return true; // 重复 id：图不合法，按死锁处置
    ids.add(s.id);
  }
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    for (const d of s.depends_on) {
      if (!ids.has(d)) return true; // 依赖悬空：条件永不满足
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [s.id]);
      else list.push(s.id);
    }
  }
  return !kahnLayers(steps, dependents).complete;
}

/**
 * Mermaid 渲染：`graph TD` + 声明序裸节点 + 依赖边（dep --> id）。
 * 空图仅返回 "graph TD"。
 */
export function toMermaid(steps: readonly GraphStep[]): string {
  const lines: string[] = ["graph TD"];
  for (const s of steps) lines.push(`  ${s.id}`);
  for (const s of steps) {
    for (const d of s.depends_on) {
      lines.push(`  ${d} --> ${s.id}`);
    }
  }
  return lines.join("\n");
}
