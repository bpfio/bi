/**
 * BI-14.1 · Taint 污点分析编译器——污染沿依赖边传播 + source→sink 路径审计。
 *
 * 传播模型：数据从生产者流向消费者（消费者 depends_on 生产者），因此污染沿
 * "被依赖"边正向扩散——source 步被污染，则一切（传递地）依赖它的步骤被污染。
 *
 * 路径模型：taintedPaths 枚举每条 source→sink 的简单路径（不重复经过节点；
 * sink 可作为中转继续延伸，路径在 sink 处照常记录）。路径级 sanitize 判定：
 * 路径上任一成员步骤 metadata.sanitize === true 即视为已消毒（污点被清洗），
 * unsanitizedFlows 仅收录未消毒路径。
 *
 * 前置校验（结构化报错，码与 causality-graph 对齐）：重复 id → duplicate-step；
 * 未知依赖 → unknown-dep；环 → cycle-detected（环使路径枚举不收敛，直接拒绝）；
 * sources/sinks 引用不存在的步骤 → unknown-node。路径枚举量最坏指数级，
 * 分析器面向静态小图（工作流步骤表），完整 YAML/复杂图归后续增强。
 */
import { CausalityError, topoSort } from "./causality-graph";

/** 污点分析步骤：图步骤 + metadata（sanitize 标记驻留于此）。 */
export interface TaintStep {
  id: string;
  depends_on: string[];
  metadata?: { sanitize?: boolean };
}

/** 一条 source→sink 污染路径（成员为步骤 id，自 source 起至 sink 止）。 */
export interface TaintPath {
  source: string;
  sink: string;
  path: string[];
  /** 路径上任一成员标 metadata.sanitize → true（污点已清洗）。 */
  sanitized: boolean;
}

export interface TaintAnalysisResult {
  /** 被污染步骤（可达自任一 source，含 source 本身；声明序去重）。 */
  taintedSteps: string[];
  /** 全部 source→sink 简单路径（按 source 声明序 × DFS 确定性序）。 */
  taintedPaths: TaintPath[];
  /** 未过 sanitize 的路径（unsanitizedFlows 的结果视图）。 */
  unsanitizedFlows: TaintPath[];
}

/** 校验图结构合法 + source/sink 可解析（非法即结构化抛出）。 */
function validate(
  steps: readonly TaintStep[],
  sources: readonly string[],
  sinks: readonly string[],
): { dependents: Map<string, string[]>; byId: Map<string, TaintStep> } {
  topoSort(steps); // duplicate-step / unknown-dep / cycle-detected 全在这里抛
  const byId = new Map<string, TaintStep>();
  for (const s of steps) byId.set(s.id, s);
  const dependents = new Map<string, string[]>();
  for (const s of steps) {
    for (const d of s.depends_on) {
      const list = dependents.get(d);
      if (list === undefined) dependents.set(d, [s.id]);
      else list.push(s.id);
    }
  }
  for (const src of sources) {
    if (!byId.has(src)) {
      throw new CausalityError("unknown-node", `污点源 "${src}" 不是已声明步骤`);
    }
  }
  for (const sink of sinks) {
    if (!byId.has(sink)) {
      throw new CausalityError("unknown-node", `污点汇 "${sink}" 不是已声明步骤`);
    }
  }
  return { dependents, byId };
}

function isSanitized(path: readonly string[], byId: ReadonlyMap<string, TaintStep>): boolean {
  return path.some((id) => byId.get(id)?.metadata?.sanitize === true);
}

/**
 * 污点分析主入口：污染传播（可达性）+ source→sink 路径枚举 + sanitize 审计。
 * sources / sinks 为步骤 id 列表；空 sources → 全空结果（零污染零噪音）。
 */
export function taintAnalysis(
  steps: readonly TaintStep[],
  sources: readonly string[],
  sinks: readonly string[],
): TaintAnalysisResult {
  const { dependents, byId } = validate(steps, sources, sinks);
  const sinkSet = new Set(sinks);

  // 污染传播：自 source 沿"被依赖"边 BFS（邻序 = 声明序，结果确定性）
  const tainted = new Set<string>();
  let frontier = sources.filter((id) => !tainted.has(id));
  for (const id of frontier) tainted.add(id);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        if (!tainted.has(dep)) {
          tainted.add(dep);
          next.push(dep);
        }
      }
    }
    frontier = next;
  }
  const taintedSteps = steps.map((s) => s.id).filter((id) => tainted.has(id));

  // source→sink 简单路径枚举（DFS，逐 source；sink 处记录并继续延伸）
  const taintedPaths: TaintPath[] = [];
  for (const source of sources) {
    const path: string[] = [source];
    const onPath = new Set<string>([source]);
    const dfs = (node: string): void => {
      if (sinkSet.has(node)) {
        taintedPaths.push({
          source,
          sink: node,
          path: [...path],
          sanitized: isSanitized(path, byId),
        });
      }
      for (const dep of dependents.get(node) ?? []) {
        if (onPath.has(dep)) continue;
        path.push(dep);
        onPath.add(dep);
        dfs(dep);
        path.pop();
        onPath.delete(dep);
      }
    };
    dfs(source);
  }

  return {
    taintedSteps,
    taintedPaths,
    unsanitizedFlows: taintedPaths.filter((p) => !p.sanitized),
  };
}

/**
 * 独立审计口：列出未过 sanitization 步的 source→sink 路径。
 * 语义与 taintAnalysis(...).unsanitizedFlows 完全一致。
 */
export function unsanitizedFlows(
  steps: readonly TaintStep[],
  sources: readonly string[],
  sinks: readonly string[],
): TaintPath[] {
  return taintAnalysis(steps, sources, sinks).unsanitizedFlows;
}
