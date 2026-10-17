/**
 * BI-05.3 —— 路径自适应注入提醒服务（ReminderService）。
 *
 * onToolPaths(工具触碰路径) → 探测嵌套规则并入待提醒集：
 *  - 按规则文件路径去重；同路径再次触碰刷新 LRU 新旧序；
 *  - 待提醒集 LRU 上限缺省 50，超限挤掉最旧；
 * reminderBlock() → 一次性消费：有待提醒项时输出确定性提醒块
 * （"以下目录存在嵌套规则文件未读：…"）并清空，否则返回 null。
 *
 * 设计裁定：触碰路径为文件（statSync isFile）时归约到其父目录；
 * 不存在的路径按目录语义处理（工具可能引用待创建路径）。
 */
import * as nodePath from "node:path";
import { DEFAULT_FS, type FsLike } from "../rules";
import { detectNestedRules, type NestedRuleHit } from "./nested-rules-detector";

/** 提醒块固定首行。 */
export const REMINDER_HEADER = "以下目录存在嵌套规则文件未读：";
/** 待提醒集默认 LRU 上限。 */
export const DEFAULT_REMINDER_CAPACITY = 50;

export interface ReminderServiceOptions {
  knownRoot: string;
  injectFs?: FsLike;
  /** 覆盖默认 LRU 上限。 */
  capacity?: number;
}

export class ReminderService {
  private readonly knownRoot: string;
  private readonly fs: FsLike;
  private readonly capacity: number;
  /** path → hit；Map 插入序即 LRU 新旧序（旧 → 新）。 */
  private readonly pending = new Map<string, NestedRuleHit>();

  constructor(opts: ReminderServiceOptions) {
    this.knownRoot = opts.knownRoot;
    this.fs = opts.injectFs ?? DEFAULT_FS;
    this.capacity = Math.max(1, opts.capacity ?? DEFAULT_REMINDER_CAPACITY);
  }

  /** 工具触碰路径（文件或目录均可）→ 并入待提醒集（探测 + 去重 + LRU 淘汰）。 */
  onToolPaths(paths: readonly string[]): void {
    const touched = paths.map((p) => this.toTouchedDir(p));
    const hits = detectNestedRules(this.knownRoot, touched, this.fs);
    for (const hit of hits) {
      if (this.pending.has(hit.path)) {
        // 已在待提醒集：刷新 LRU 新旧序
        const existing = this.pending.get(hit.path);
        this.pending.delete(hit.path);
        this.pending.set(hit.path, existing ?? hit);
        continue;
      }
      this.pending.set(hit.path, hit);
      while (this.pending.size > this.capacity) {
        const oldest = this.pending.keys().next();
        if (oldest.done === true) break;
        this.pending.delete(oldest.value);
      }
    }
  }

  /** 一次性消费：有待提醒项时构建确定性提醒块并清空集合；无则返回 null。 */
  reminderBlock(): string | null {
    if (this.pending.size === 0) return null;
    // pending 按 path 插入（detectNestedRules 已排序），分组保序
    const groups = new Map<string, string[]>();
    for (const hit of this.pending.values()) {
      const files = groups.get(hit.dir);
      if (files !== undefined) files.push(hit.file);
      else groups.set(hit.dir, [hit.file]);
    }
    const lines = [REMINDER_HEADER];
    for (const [dir, files] of groups) {
      lines.push(`- ${dir}：${[...files].sort().join("、")}`);
    }
    this.pending.clear();
    return lines.join("\n");
  }

  /** 当前待提醒条数（诊断/测试用）。 */
  get size(): number {
    return this.pending.size;
  }

  private toTouchedDir(path: string): string {
    const resolved = nodePath.resolve(path);
    try {
      if (this.fs.statSync(resolved).isFile()) return nodePath.dirname(resolved);
    } catch {
      // 不存在的路径按目录语义处理
    }
    return resolved;
  }
}
