/**
 * BI-05.3 —— 动态嵌套规则探测器。
 *
 * 职责：detectNestedRules 对触碰目录自底向上（至 knownRoot 为界）探测
 * 未披露的 AGENTS.md / BI.md / .cursorrules；knownRoot 自身的规则文件
 * 视为已注入，不在报告之列。
 *
 * 设计裁定：
 * - 仅探测 knownRoot 子树内的触碰目录；子树外的触碰路径整体忽略。
 * - 沿途所有命中都报告（而非首个命中），攀升止于 knownRoot（不含）。
 * - 结果按 path 码点排序并按路径去重（确定性输出，与触碰顺序无关）。
 * - fs 可注入（缺省 node:fs）。
 */
import * as nodePath from "node:path";
import { DEFAULT_FS, type FsLike } from "../rules";

/** 嵌套规则文件名探测集合。 */
export const NESTED_RULE_FILENAMES = ["AGENTS.md", "BI.md", ".cursorrules"] as const;

export type NestedRuleFilename = (typeof NESTED_RULE_FILENAMES)[number];

export interface NestedRuleHit {
  /** 命中文件所在目录。 */
  dir: string;
  /** 文件名（AGENTS.md / BI.md / .cursorrules）。 */
  file: NestedRuleFilename;
  /** 完整路径。 */
  path: string;
}

function isWithin(child: string, root: string): boolean {
  return child === root || child.startsWith(root + nodePath.sep);
}

/**
 * 对每个触碰目录自底向上探测嵌套规则文件，直到 knownRoot（不含 knownRoot 自身）。
 * 不在 knownRoot 子树内的触碰目录被忽略；结果按 path 码点排序（确定性）并去重。
 */
export function detectNestedRules(
  knownRoot: string,
  touchedDirs: readonly string[],
  injectFs?: FsLike,
): NestedRuleHit[] {
  const fs = injectFs ?? DEFAULT_FS;
  const root = nodePath.resolve(knownRoot);
  const seen = new Set<string>();
  const hits: NestedRuleHit[] = [];
  for (const raw of touchedDirs) {
    let dir = nodePath.resolve(raw);
    if (!isWithin(dir, root)) continue;
    while (dir !== root) {
      for (const file of NESTED_RULE_FILENAMES) {
        const path = nodePath.join(dir, file);
        if (!seen.has(path) && fs.existsSync(path)) {
          seen.add(path);
          hits.push({ dir, file, path });
        }
      }
      const parent = nodePath.dirname(dir);
      if (parent === dir) break; // 根盘安全阀（正常路径语义不会到达）
      dir = parent;
    }
  }
  hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return hits;
}
