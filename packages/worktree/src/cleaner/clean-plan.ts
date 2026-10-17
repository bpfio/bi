/**
 * @bi/worktree —— 存储清理计划与安全执行器（BI-12.1）。
 *
 * 保留策略（now 注入，阈值可配）：
 * - 未合并工作树保留 7 天（`DEFAULT_UNMERGED_TTL_MS`），到期 → 'expired-unmerged'；
 * - 已合并工作树保留 1 天（`DEFAULT_MERGED_TTL_MS`），到期 → 'expired-merged'；
 * - 孤儿目录（失去工作树身份）无保留期，直接 → 'orphan'。
 *   到期判定为严格大于（整点保留、越点可删）。
 *
 * 安全阀（RULE-BI-05 精神的存储侧推论）：计划只允许包含 worktreesRoot 与
 * 显式注册目录内的路径；白名单外路径一律拒绝 —— 构建与执行双重校验，
 * 执行侧整批先验，任何违规都在触碰磁盘之前终止。allowedRoots 未配置时
 * 构造即拒绝（拒绝无界清理）。
 *
 * 原子删除：先 rename 为同目录 `<name>.trash-<ts>` 再 rm —— rename 成功后
 * rm 失败会回滚 rename 恢复原路径，保证"要么原样存在、要么彻底消失"。
 * 仍被 open worktree 引用的路径跳过并标注 skipped（执行前由调用方注入
 * `git worktree list` 在册路径）；白名单根目录本体受保护，永不自删。
 */
import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { WorktreeError } from "../branch";
import type { CatalogEntry, StorageCatalog } from "./storage-catalog";

/** 未合并工作树默认保留期：7 天。 */
export const DEFAULT_UNMERGED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 已合并工作树默认保留期：1 天。 */
export const DEFAULT_MERGED_TTL_MS = 1 * 24 * 60 * 60 * 1000;

/** 清理原因。 */
export type CleanReason = "expired-unmerged" | "expired-merged" | "orphan";

/** 计划条目：待清理路径与原因。 */
export interface CleanPlanEntry {
  path: string;
  reason: CleanReason;
}

/** 清理策略（安全阀 + 阈值）。 */
export interface CleanPolicy {
  /** 未合并保留阈值，默认 7 天 */
  unmergedTtlMs?: number;
  /** 已合并保留阈值，默认 1 天 */
  mergedTtlMs?: number;
  /** 白名单根目录（worktreesRoot + 显式注册目录）；必填，缺省即拒绝 */
  allowedRoots?: readonly string[];
}

/** fs 操作注入点（测试用）；缺省为真实 renameSync / rmSync -rf。 */
export interface FsOps {
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
}

/** 执行选项。 */
export interface ExecuteOptions {
  /** 演练模式：只出计划不碰磁盘 */
  dryRun?: boolean;
  /** 注入时钟（trash 命名时间戳） */
  now?: () => number;
  /** open worktree 在册路径（git worktree list 结果）；命中即跳过 */
  openWorktreePaths?: Iterable<string>;
  /** fs 操作注入点 */
  ops?: FsOps;
}

/** 跳过原因。 */
export type SkipWhy = "open-worktree" | "root-protected" | "missing";

/** 被跳过的条目（磁盘动作未发生）。 */
export interface SkippedEntry {
  path: string;
  reason: CleanReason;
  why: SkipWhy;
}

/** 失败条目（现场已回滚，可重试）。 */
export interface FailedEntry {
  path: string;
  reason: CleanReason;
  error: string;
}

/** 执行结果：dryRun 时 removed 语义为"将被删除"。 */
export interface ExecuteResult {
  dryRun: boolean;
  removed: CleanPlanEntry[];
  skipped: SkippedEntry[];
  failed: FailedEntry[];
}

function toMs(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 依据条目类别与保留阈值给出清理原因；null = 仍在保留期内。 */
function classify(
  entry: CatalogEntry,
  nowMs: number,
  unmergedTtlMs: number,
  mergedTtlMs: number,
): CleanReason | null {
  if (entry.kind === "orphan") return "orphan";
  const age = nowMs - entry.lastUsedAt;
  if (entry.merged) return age > mergedTtlMs ? "expired-merged" : null;
  return age > unmergedTtlMs ? "expired-unmerged" : null;
}

/**
 * 存储清理计划器/执行器。构建（buildPlan）与执行（execute）都以
 * allowedRoots 白名单为安全阀：白名单外路径一律结构化拒绝。
 */
export class CleanPlan {
  readonly #unmergedTtlMs: number;
  readonly #mergedTtlMs: number;
  readonly #allowedRoots: readonly string[];

  constructor(policy: CleanPolicy = {}) {
    const unmergedTtlMs = policy.unmergedTtlMs ?? DEFAULT_UNMERGED_TTL_MS;
    const mergedTtlMs = policy.mergedTtlMs ?? DEFAULT_MERGED_TTL_MS;
    for (const ttl of [unmergedTtlMs, mergedTtlMs]) {
      if (!Number.isFinite(ttl) || ttl < 0) {
        throw new WorktreeError("invalid-argument", "保留阈值必须为非负有限数值");
      }
    }
    const allowedRoots = (policy.allowedRoots ?? []).map((root) => resolve(root));
    if (allowedRoots.length === 0) {
      throw new WorktreeError(
        "invalid-argument",
        "安全阀拒绝：必须显式配置 allowedRoots 白名单（拒绝无界清理）",
      );
    }
    this.#unmergedTtlMs = unmergedTtlMs;
    this.#mergedTtlMs = mergedTtlMs;
    this.#allowedRoots = allowedRoots;
  }

  /** 白名单根目录（已 resolve 规范化）。 */
  get allowedRoots(): readonly string[] {
    return this.#allowedRoots;
  }

  /** 白名单校验：通过返回规范化路径，违规抛 invalid-argument。 */
  #assertInsideWhitelist(path: string): string {
    const resolved = resolve(path);
    for (const root of this.#allowedRoots) {
      if (isInside(resolved, root)) return resolved;
    }
    throw new WorktreeError(
      "invalid-argument",
      `安全阀拒绝：路径不在白名单目录内，禁止纳入清理计划：${path}`,
    );
  }

  /**
   * 由目录字典构建清理计划：按保留策略分类过滤（保留期内条目不进计划）。
   * 白名单外条目一律拒绝（抛 invalid-argument）。
   */
  buildPlan(catalog: StorageCatalog, now: Date | number): CleanPlanEntry[] {
    const nowMs = toMs(now);
    const plan: CleanPlanEntry[] = [];
    for (const [rawPath, entry] of catalog) {
      const path = this.#assertInsideWhitelist(rawPath);
      const reason = classify(entry, nowMs, this.#unmergedTtlMs, this.#mergedTtlMs);
      if (reason !== null) plan.push({ path, reason });
    }
    return plan;
  }

  /**
   * 执行清理计划。流程：整批先验白名单（先于一切磁盘动作）→ 逐条
   * open-worktree / 白名单根本体 / 已消失 跳过 → dryRun 出列表 →
   * 原子删除（rename → rm，rm 失败回滚 rename）。
   */
  execute(plan: readonly CleanPlanEntry[], opts: ExecuteOptions = {}): ExecuteResult {
    const dryRun = opts.dryRun === true;
    const nowMs = toMs((opts.now ?? Date.now)());
    const openPaths = new Set(
      [...(opts.openWorktreePaths ?? [])].map((path) => resolve(path)),
    );
    const rename = opts.ops?.rename ?? renameSync;
    const remove = opts.ops?.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));

    const entries = plan.map((entry) => ({
      path: this.#assertInsideWhitelist(entry.path),
      reason: entry.reason,
    }));

    const result: ExecuteResult = { dryRun, removed: [], skipped: [], failed: [] };
    let trashSeq = 0;
    for (const entry of entries) {
      if (openPaths.has(entry.path)) {
        result.skipped.push({ ...entry, why: "open-worktree" });
        continue;
      }
      if (this.#allowedRoots.some((root) => entry.path === root)) {
        result.skipped.push({ ...entry, why: "root-protected" });
        continue;
      }
      if (!existsSync(entry.path)) {
        result.skipped.push({ ...entry, why: "missing" });
        continue;
      }
      if (dryRun) {
        result.removed.push({ ...entry });
        continue;
      }

      // 原子删除：先 rename 入同目录 trash 名，再 rm；rm 失败回滚 rename
      const parent = dirname(entry.path);
      const stem = basename(entry.path);
      let trash = join(parent, `${stem}.trash-${nowMs}`);
      while (existsSync(trash)) {
        trashSeq += 1;
        trash = join(parent, `${stem}.trash-${nowMs}-${trashSeq}`);
      }
      try {
        rename(entry.path, trash);
      } catch (err) {
        result.failed.push({ ...entry, error: `rename 失败（原路径未动）：${messageOf(err)}` });
        continue;
      }
      try {
        remove(trash);
      } catch (err) {
        const detail = messageOf(err);
        try {
          rename(trash, entry.path);
        } catch (restoreErr) {
          result.failed.push({
            ...entry,
            error: `rm 失败且回滚失败：${detail}；回滚：${messageOf(restoreErr)}`,
          });
          continue;
        }
        result.failed.push({ ...entry, error: `rm 失败（rename 已回滚，原路径恢复）：${detail}` });
        continue;
      }
      result.removed.push({ ...entry });
    }
    return result;
  }
}
