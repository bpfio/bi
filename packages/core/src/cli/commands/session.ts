/**
 * BI-20.2 —— `session` 子命令群（列表 + 孤儿清理）。
 *
 * kimi 对应物: apps/kimi-code/src/cli/sub/session.ts
 * 差异边界:
 *   - 列表复用 BI-03 SessionManager.listSessions（坏文件跳过、最新在前），
 *     本模块只补 limit 截断（limit 非正整数或非整数 → 空数组）；
 *   - pruneOrphans 以「目录内 .jsonl 文件不在 list 之列」推导孤儿
 *     （损坏/无 meta），并用 loadSession 复核分类：
 *       no-meta    = 文件损坏/空文件/meta 行残缺（SessionFileCorruptError）；
 *       unreadable = 非法会话 id 文件名、无权限等（不能安全加载）；
 *     可正常加载却不在 list 的（竞态）与已消失的文件一律保守跳过；
 *   - 安全阀（三重）：
 *       1) 路径白名单 = 会话目录本身（sessionsDir 必须 resolve 等于
 *          manager.rootDir，否则 path-not-allowed，含目录不存在时）；
 *       2) 删除目标必须是白名单目录下 lstat 为常规文件的直接子项
 *          （符号链接/目录/非 .jsonl 一律不动）；
 *       3) force 缺省不删；显式 dryRun:true 可否决 force（dry-run 优先）。
 *   - 非 .jsonl 文件（如 notes.txt）不属于会话文件，不列出也不删除。
 *
 * 消费接线（CLI argv → 本模块）归属 BI-20.1 / 后续装配方；本卡只提供库面。
 */
import { lstat, readdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  SessionFileCorruptError,
  SessionNotFoundError,
  type SessionManager,
} from "../../session/manager";
import type { SessionMeta } from "../../session/types";

export interface ListSessionsOptions {
  /** 最多返回条数；非正整数/非整数视为 0 条。 */
  limit?: number;
}

/** 列出会话（复用 manager.listSessions：坏文件跳过、最新在前），按 limit 截断。 */
export async function listSessions(
  manager: SessionManager,
  opts: ListSessionsOptions = {},
): Promise<SessionMeta[]> {
  const metas = await manager.listSessions();
  const { limit } = opts;
  if (limit === undefined) return metas;
  if (!Number.isInteger(limit) || limit <= 0) return [];
  return metas.slice(0, limit);
}

export interface PruneOptions {
  /** true 强制只列不删（可否决 force）；缺省 false。 */
  dryRun?: boolean;
  /** true 才允许删除；缺省 false（安全阀）。 */
  force?: boolean;
}

export type OrphanReason = "unreadable" | "no-meta";

export interface OrphanEntry {
  /** 孤儿文件绝对路径（白名单目录直接子项）。 */
  file: string;
  reason: OrphanReason;
}

export interface PruneResult {
  /** 待删清单（按路径排序，输出稳定）。 */
  orphans: OrphanEntry[];
  /** 实际删除的路径（仅非 dry-run 时非空）。 */
  deleted: string[];
  /** 本次是否为 dry-run（未删除）。 */
  dryRun: boolean;
}

export type PruneErrorCode = "path-not-allowed" | "io-error";

export class PruneError extends Error {
  constructor(
    readonly code: PruneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PruneError";
  }
}

/** 孤儿复核结论：可安全删除的只有 no-meta / unreadable。 */
type OrphanVerdict = "no-meta" | "unreadable" | "healthy" | "gone";

async function classifyOrphan(manager: SessionManager, sessionId: string): Promise<OrphanVerdict> {
  try {
    await manager.loadSession(sessionId);
    return "healthy"; // 能加载却不在 list → 竞态，保守跳过
  } catch (error) {
    if (error instanceof SessionFileCorruptError) return "no-meta";
    if (error instanceof SessionNotFoundError) return "gone"; // 已消失，无需处理
    return "unreadable"; // 非法会话 id 文件名 / 无权限等
  }
}

/** 会话目录孤儿清理：缺省 dry-run 只列清单，force（且未显式 dryRun）才删除。 */
export async function pruneOrphans(
  sessionsDir: string,
  manager: SessionManager,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const dir = resolve(sessionsDir);
  const whitelist = resolve(manager.rootDir);
  // 安全阀 1：白名单 = 会话目录本身（先于任何读操作校验）。
  if (dir !== whitelist) {
    throw new PruneError(
      "path-not-allowed",
      `拒绝清理：${dir} 不在白名单内（仅允许会话目录本身 ${whitelist}）`,
    );
  }

  const willDelete = opts.force === true && opts.dryRun !== true;

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { orphans: [], deleted: [], dryRun: !willDelete };
    }
    throw new PruneError("io-error", `读取会话目录失败 (${dir}): ${errorMessage(error)}`);
  }

  const listed = new Set((await manager.listSessions()).map((meta) => meta.sessionId));
  const orphans: OrphanEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue; // 非 .jsonl 一律不动
    const sessionId = name.slice(0, -".jsonl".length);
    if (listed.has(sessionId)) continue;
    const file = join(dir, name);
    // 安全阀 2：只考虑白名单目录的直接子项。
    if (!resolve(file).startsWith(dir + sep)) continue;
    let regular = false;
    try {
      regular = (await lstat(file)).isFile();
    } catch {
      continue; // 竞态：文件已消失
    }
    if (!regular) continue; // 目录/符号链接等：保守跳过
    const verdict = await classifyOrphan(manager, sessionId);
    if (verdict === "healthy" || verdict === "gone") continue;
    orphans.push({ file, reason: verdict });
  }
  orphans.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  const deleted: string[] = [];
  if (willDelete) {
    for (const orphan of orphans) {
      // 安全阀 2 复核：删除前再次确认路径仍在白名单目录内。
      if (!resolve(orphan.file).startsWith(dir + sep)) {
        throw new PruneError("path-not-allowed", `拒绝删除白名单外路径: ${orphan.file}`);
      }
      try {
        await unlink(orphan.file);
      } catch (error) {
        throw new PruneError("io-error", `删除失败 (${orphan.file}): ${errorMessage(error)}`);
      }
      deleted.push(orphan.file);
    }
  }
  return { orphans, deleted, dryRun: !willDelete };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
