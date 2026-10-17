/**
 * BI-05.1 —— Dream Cycle 仿生做梦记忆沉淀中枢。
 *
 * 职责：
 *  1. evaluateAutoDreamTiming：依据空闲时长与锁持有状态判定是否进入做梦沉淀。
 *  2. acquireDreamLock：.consolidate-lock 原子文件锁（O_EXCL 创建 + pid/ts），
 *     stale 锁（超 1h）或内容不可解析时可接管。
 *  3. consolidate：会话精华段去重合并后追加写入 BI.dream.md（append-only），
 *     全程持锁、finally 释放。
 *
 * 设计裁定：
 * - 空闲阈值默认 30 分钟，边界语义为 idleMs >= 阈值即可做梦；未持锁一票否决。
 * - 锁文件为 JSON { pid, ts }；双进程互斥由 O_EXCL（flag:"wx"）保证，测试以
 *   先后 acquire 模拟。
 * - consolidate 去重 = 批内 Set 去重 + 对既有文件内容 includes 判重（append
 *   幂等：同输入重跑不产生新段落）。
 * - fs/now/pid 全部可注入；extractor 可注入（返回 null/undefined/空串跳过）。
 */
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { DEFAULT_FS, type FsLike } from "../rules";

/** 锁文件名。 */
export const DREAM_LOCK_FILENAME = ".consolidate-lock";
/** 沉淀目标文件名。 */
export const DREAM_FILE_FILENAME = "BI.dream.md";

/** 进入做梦的空闲阈值默认 30 分钟。 */
export const DEFAULT_DREAM_IDLE_MS = 30 * 60 * 1000;
/** 锁 stale（可接管）阈值默认 1 小时。 */
export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

export interface DreamTimingInput {
  /** 距上次活动的空闲毫秒数（由调用方注入时钟差）。 */
  idleMs: number;
  /** 是否已持有 consolidate 锁。 */
  hasLock: boolean;
}

export interface DreamTimingDecision {
  shouldDream: boolean;
  reason: string;
}

export interface DreamTimingOptions {
  /** 覆盖默认空闲阈值（毫秒）。 */
  idleThresholdMs?: number;
}

/** 空闲且持锁才做梦；reason 为机器可读判定依据。 */
export function evaluateAutoDreamTiming(
  input: DreamTimingInput,
  opts?: DreamTimingOptions,
): DreamTimingDecision {
  const threshold = opts?.idleThresholdMs ?? DEFAULT_DREAM_IDLE_MS;
  if (!input.hasLock) return { shouldDream: false, reason: "no-lock" };
  if (input.idleMs < threshold) return { shouldDream: false, reason: "idle-below-threshold" };
  return { shouldDream: true, reason: "idle-and-locked" };
}

export interface DreamLockHandle {
  path: string;
  release(): void;
}

export interface AcquireDreamLockOptions {
  fs?: FsLike;
  /** 注入当前时间（毫秒），缺省 Date.now()。 */
  now?: number;
  /** 覆盖默认 stale 阈值（毫秒）。 */
  staleMs?: number;
  /** 注入 pid（缺省 process.pid）。 */
  pid?: number;
}

function makeLockHandle(fs: FsLike, lockPath: string): DreamLockHandle {
  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) return;
      released = true;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // 锁文件已被他人接管或移除：释放语义视为完成。
      }
    },
  };
}

/**
 * 原子获取 .consolidate-lock：O_EXCL（flag:"wx"）创建并写入 { pid, ts }；
 * 已存在且 stale（now - ts > staleMs）或内容不可解析时接管；他人持锁未过期
 * 返回 null。release 幂等，重复调用安全。
 */
export function acquireDreamLock(dir: string, opts?: AcquireDreamLockOptions): DreamLockHandle | null {
  const fs = opts?.fs ?? DEFAULT_FS;
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pid = opts?.pid ?? process.pid;
  const lockPath = nodePath.join(dir, DREAM_LOCK_FILENAME);
  const payload = `${JSON.stringify({ pid, ts: now })}\n`;
  try {
    fs.writeFileSync(lockPath, payload, { flag: "wx" });
    return makeLockHandle(fs, lockPath);
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
  }
  let existingTs: number | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { ts?: unknown };
    if (typeof parsed?.ts === "number" && Number.isFinite(parsed.ts)) existingTs = parsed.ts;
  } catch {
    existingTs = null; // 内容不可解析（含读失败）：按 stale 处置
  }
  if (existingTs !== null && now - existingTs <= staleMs) return null;
  // stale 接管：覆写为己方锁
  fs.writeFileSync(lockPath, payload);
  return makeLockHandle(fs, lockPath);
}

export interface ConsolidateOptions<T> {
  dir: string;
  fs?: FsLike;
  /** 注入当前时间（毫秒）。 */
  now?: number;
  /** 可注入精华提取器；返回 null/undefined/空串的会话被跳过。缺省视会话本身为字符串精华。 */
  extractor?: (session: T) => string | null | undefined;
}

export type ConsolidateResult =
  | { ok: true; added: number; duplicates: number }
  | { ok: false; reason: string };

/**
 * 持锁沉淀：提取精华 → 去重（批内 + 对既有 BI.dream.md）→ 追加段落
 * （`## dream @ <iso>` 头 + `- 精华` 条目，append-only）→ finally 释放锁。
 * 无新增段时不写盘；锁被他人持有时返回 { ok:false, reason:"locked" }。
 */
export function consolidate<T = string>(
  sessions: readonly T[],
  opts: ConsolidateOptions<T>,
): ConsolidateResult {
  const fs = opts.fs ?? DEFAULT_FS;
  const lock = acquireDreamLock(opts.dir, { fs, now: opts.now });
  if (lock === null) return { ok: false, reason: "locked" };
  try {
    const dreamPath = nodePath.join(opts.dir, DREAM_FILE_FILENAME);
    let existing = "";
    try {
      existing = fs.readFileSync(dreamPath, "utf8");
    } catch {
      existing = "";
    }
    const extract = opts.extractor ?? ((session: T) => session as unknown as string | null | undefined);
    const seen = new Set<string>();
    const fresh: string[] = [];
    let duplicates = 0;
    for (const session of sessions) {
      const raw = extract(session);
      const segment = typeof raw === "string" ? raw.trim() : "";
      if (segment.length === 0) continue;
      if (seen.has(segment) || existing.includes(segment)) {
        duplicates += 1;
        continue;
      }
      seen.add(segment);
      fresh.push(segment);
    }
    if (fresh.length > 0) {
      let separator: string;
      if (existing.length === 0 || existing.endsWith("\n\n")) separator = "";
      else if (existing.endsWith("\n")) separator = "\n";
      else separator = "\n\n";
      const stamp = new Date(opts.now ?? Date.now()).toISOString();
      const block =
        `${separator}## dream @ ${stamp}\n` + fresh.map((s) => `- ${s}`).join("\n") + "\n";
      fs.appendFileSync(dreamPath, block);
    }
    return { ok: true, added: fresh.length, duplicates };
  } finally {
    lock.release();
  }
}
