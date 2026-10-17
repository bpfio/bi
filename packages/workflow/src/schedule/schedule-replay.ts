/**
 * BI-07.14 持久化重放中枢 (schedule-replay)
 *
 * 接缝①（工单钉死）: 持久化全量复用 durable/ 的 DurableStore（禁私建存储）。
 * 落库包封（TaskRecord 形体）:
 *   id         = 调度 id（'sch-' 前缀，与 14.5 的 UUID 任务 id 天然不相交）
 *   kind       = 'schedule'（本卡命名空间；引擎工作流步骤用 'wf-step'）
 *   state      = 恒写 'completed'——14.5 DurableScheduler.run() 只认领
 *               pending/suspended、recover() 只扫 running，completed 为无出边
 *               绝对终态，调度记录永不被任务执行侧误认领/误重放；
 *   checkpoint = SchedulePayload JSON（ScheduleRecord 本体全量：spec/title/
 *               scheduleState/nextFireAt/lastFiredAt/deliveryCursor/...）。
 * 本卡自治状态机（active/paused/completed）不经 14.5 转移表——put 是纯
 * upsert，桶位 'completed' 只是"归本卡管辖"的命名空间标记。
 *
 * 崩溃自愈: nextFireAt 与 deliveryCursor（游标）随每次触发同步持久化
 * （先落库后返回事件）。重启 = 新实例接同一 store，tick 照常——游标是防
 * 重复触发的核心机制。与 BI-14.5 的分工: 本卡管调度游标，14.5 管任务执行。
 *
 * 防重放轰炸: now 落后于游标多个周期时，tick 只补发一轮并把 nextFireAt
 * 直接推进到 > now 的下一命中点（Every 按间隔纪元对齐推进至 > now）。
 */

import { nextFire } from './schedule-domain';
import type { ScheduleSpec } from './schedule-domain';
import type { DurableStore } from '../durable/storage';
import { DEFAULT_PAGE_SIZE } from '../durable/storage';
import type { JsonValue, TaskRecord } from '../durable/task-state';

/** 本卡在共享 store 上的命名空间 kind（与 14.5 的任务 kind 互斥）。 */
export const SCHEDULE_KIND = 'schedule';

/** 落库桶位（语义见文件头）：14.5 不可达的绝对终态桶。 */
const BUCKET_STATE = 'completed' as const;

/** 调度记录持久态（域对象；整对象经 checkpoint JSON 落 DurableStore）。 */
export interface ScheduleRecord {
  id: string;
  spec: ScheduleSpec;
  title: string;
  /**
   * active | paused | completed。
   * 一次性（at/after）到点后落 completed 终态（lastFiredAt/firedCount 即
   * fired-history 留痕）；paused 保留游标与 nextFireAt。
   */
  state: 'active' | 'paused' | 'completed';
  /** 下一次应触发时刻；completed 终态或不可命中（cron 400 年越界）后为 null。 */
  nextFireAt: number | null;
  lastFiredAt?: number;
  /** 已处理游标（防重复触发核心字段，随触发推进并持久化）。 */
  deliveryCursor: number;
  createdAt: number;
  firedCount: number;
}

/** 一次触发事件。 */
export interface FiredSchedule {
  scheduleId: string;
  firedAt: number;
  spec: ScheduleSpec;
  title: string;
}

export interface ScheduleReplayOptions {
  store: DurableStore;
  /** 注入时钟（缺省 Date.now），测试主用。 */
  clock?: () => number;
  /** spec 未带 tz 的原语（cron 等）与 nextFire 的缺省时区，默认 UTC。 */
  defaultTz?: string;
}

/** 结构化错误（判别方式: code 字段）。 */
export type ScheduleErrorCode = 'unknown-schedule' | 'invalid-record';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

// ============================================================
// checkpoint 载荷编码/解码（JSON 保真 + 解码防御校验）
// ============================================================

/** checkpoint 内的持久载荷（v1 版式）。 */
interface SchedulePayload {
  v: 1;
  id: string;
  spec: JsonValue;
  title: string;
  scheduleState: 'active' | 'paused' | 'completed';
  nextFireAt: number | null;
  lastFiredAt: number | null;
  deliveryCursor: number;
  createdAt: number;
  firedCount: number;
}

function encodePayload(record: ScheduleRecord): JsonValue {
  // 字段全集为 string/number/null/JsonValue（spec 已 JSON 化），结构兼容 JsonValue；
  // 读回侧由 decodePayload/decodeSpec 做防御校验，编码侧不依赖该形状。
  const payload: { [key: string]: JsonValue } = {
    v: 1,
    id: record.id,
    spec: JSON.parse(JSON.stringify(record.spec)) as JsonValue,
    title: record.title,
    scheduleState: record.state,
    nextFireAt: record.nextFireAt,
    lastFiredAt: record.lastFiredAt ?? null,
    deliveryCursor: record.deliveryCursor,
    createdAt: record.createdAt,
    firedCount: record.firedCount,
  };
  return payload;
}

function requireString(p: Record<string, JsonValue>, key: string, id: string): string {
  const value = p[key];
  if (typeof value !== 'string') {
    throw new ScheduleError('invalid-record', `调度 ${id} checkpoint.${key} 非字符串`);
  }
  return value;
}

function requireNumber(p: Record<string, JsonValue>, key: string, id: string): number {
  const value = p[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ScheduleError('invalid-record', `调度 ${id} checkpoint.${key} 非有限数`);
  }
  return value;
}

function optionalTz(p: Record<string, JsonValue>, id: string): string | undefined {
  const value = p.tz;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ScheduleError('invalid-record', `调度 ${id} checkpoint.spec.tz 非字符串`);
  }
  return value;
}

/** 从 JSON 还原六原语 spec（防御校验，外来/损坏记录结构化报错）。 */
function decodeSpec(value: JsonValue, id: string): ScheduleSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScheduleError('invalid-record', `调度 ${id} checkpoint.spec 非对象`);
  }
  const p = value as Record<string, JsonValue>;
  switch (p.kind) {
    case 'after':
      return { kind: 'after', delayMs: requireNumber(p, 'delayMs', id) };
    case 'at':
      return { kind: 'at', isoLocal: requireString(p, 'isoLocal', id), tz: optionalTz(p, id) };
    case 'every':
      return { kind: 'every', intervalMs: requireNumber(p, 'intervalMs', id) };
    case 'cron':
      return { kind: 'cron', expr: requireString(p, 'expr', id), tz: optionalTz(p, id) };
    case 'daily':
      return {
        kind: 'daily',
        hh: requireNumber(p, 'hh', id),
        mm: requireNumber(p, 'mm', id),
        tz: optionalTz(p, id),
      };
    case 'weekly':
      return {
        kind: 'weekly',
        weekday: requireNumber(p, 'weekday', id),
        hh: requireNumber(p, 'hh', id),
        mm: requireNumber(p, 'mm', id),
        tz: optionalTz(p, id),
      };
    default:
      throw new ScheduleError('invalid-record', `调度 ${id} checkpoint.spec.kind 未知`);
  }
}

function decodePayload(value: JsonValue, taskId: string): SchedulePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScheduleError('invalid-record', `调度 ${taskId} checkpoint 非对象`);
  }
  const p = value as Record<string, JsonValue>;
  if (p.v !== 1) {
    throw new ScheduleError('invalid-record', `调度 ${taskId} checkpoint 版本不支持: ${String(p.v)}`);
  }
  const id = requireString(p, 'id', taskId);
  const scheduleState = requireString(p, 'scheduleState', id);
  if (scheduleState !== 'active' && scheduleState !== 'paused' && scheduleState !== 'completed') {
    throw new ScheduleError('invalid-record', `调度 ${id} scheduleState 非法: ${scheduleState}`);
  }
  const nextFireAt = p.nextFireAt;
  if (nextFireAt !== null && typeof nextFireAt !== 'number') {
    throw new ScheduleError('invalid-record', `调度 ${id} nextFireAt 非法`);
  }
  const lastFiredAt = p.lastFiredAt;
  if (lastFiredAt !== null && typeof lastFiredAt !== 'number') {
    throw new ScheduleError('invalid-record', `调度 ${id} lastFiredAt 非法`);
  }
  const spec = p.spec;
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    throw new ScheduleError('invalid-record', `调度 ${id} checkpoint.spec 缺失`);
  }
  return {
    v: 1,
    id,
    spec,
    title: requireString(p, 'title', id),
    scheduleState,
    nextFireAt,
    lastFiredAt,
    deliveryCursor: requireNumber(p, 'deliveryCursor', id),
    createdAt: requireNumber(p, 'createdAt', id),
    firedCount: requireNumber(p, 'firedCount', id),
  };
}

function decodeRecord(task: TaskRecord): ScheduleRecord {
  const payload = decodePayload(task.checkpoint, task.id);
  const spec = decodeSpec(payload.spec, payload.id);
  return {
    id: payload.id,
    spec,
    title: payload.title,
    state: payload.scheduleState,
    nextFireAt: payload.nextFireAt,
    lastFiredAt: payload.lastFiredAt === null ? undefined : payload.lastFiredAt,
    deliveryCursor: payload.deliveryCursor,
    createdAt: payload.createdAt,
    firedCount: payload.firedCount,
  };
}

/**
 * 持久化重放中枢: createSchedule / tick / pause / resume / delete /
 * listSchedules。权威态全在 store，实例可弃可换（崩溃自愈的结构基础）。
 */
export class ScheduleReplay {
  readonly #store: DurableStore;
  readonly #now: () => number;
  readonly #defaultTz: string;
  #seq = 0;

  constructor(options: ScheduleReplayOptions) {
    this.#store = options.store;
    this.#now = options.clock ?? Date.now;
    this.#defaultTz = options.defaultTz ?? 'UTC';
  }

  /** 创建调度并持久化（非法 spec 在 nextFire 推算口 fail-fast）。 */
  createSchedule(spec: ScheduleSpec, opts?: { title?: string }): ScheduleRecord {
    const nowMs = this.#now();
    const nextFireAt = nextFire(spec, nowMs, this.#defaultTz);
    this.#seq += 1;
    const record: ScheduleRecord = {
      id: `sch-${nowMs.toString(36)}-${this.#seq.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      spec,
      title: opts?.title ?? '',
      state: 'active',
      nextFireAt,
      deliveryCursor: nowMs,
      createdAt: nowMs,
      firedCount: 0,
    };
    this.#put(record);
    return record;
  }

  /**
   * 驱动一轮: 扫描 active 且 nextFireAt <= nowMs 的调度 → 触发 + 游标推进。
   * 先持久化后返回事件（崩溃自愈: 已落库的触发重启后绝不重复）。
   * 一次性（at/after）到点落 completed 终态；周期性推进一步游标——
   * now 落后多周期只补发本轮（防重放轰炸）。
   */
  tick(nowMs: number): FiredSchedule[] {
    if (!Number.isFinite(nowMs)) throw new Error(`[schedule] tick.nowMs 须为有限数: ${nowMs}`);
    const fired: FiredSchedule[] = [];
    for (const record of this.listSchedules()) {
      if (record.state !== 'active') continue;
      if (record.nextFireAt === null || record.nextFireAt > nowMs) continue;
      fired.push({
        scheduleId: record.id,
        firedAt: nowMs,
        spec: record.spec,
        title: record.title,
      });
      const updated: ScheduleRecord = {
        ...record,
        lastFiredAt: nowMs,
        deliveryCursor: nowMs,
        firedCount: record.firedCount + 1,
      };
      if (record.spec.kind === 'at' || record.spec.kind === 'after') {
        updated.state = 'completed'; // 一次性终态
        updated.nextFireAt = null;
      } else {
        // 游标推进至严格 > now: Every 纪元对齐下一命中，Cron/Daily/Weekly 下一命中点
        updated.nextFireAt = nextFire(record.spec, nowMs, this.#defaultTz);
      }
      this.#put(updated);
    }
    return fired;
  }

  /** 暂停（保留游标与 nextFireAt；completed 终态幂等 no-op）。 */
  pause(id: string): void {
    const record = this.#getRecord(id);
    if (record === null) {
      throw new ScheduleError('unknown-schedule', `调度不存在: ${id}`);
    }
    if (record.state !== 'active') return;
    this.#put({ ...record, state: 'paused' });
  }

  /** 恢复（游标保留: 暂停期间错过的触发在下一次 tick 合并补发一轮）。 */
  resume(id: string): void {
    const record = this.#getRecord(id);
    if (record === null) {
      throw new ScheduleError('unknown-schedule', `调度不存在: ${id}`);
    }
    if (record.state !== 'paused') return;
    this.#put({ ...record, state: 'active' });
  }

  /** 删除（幂等: 不存在亦 no-op）。 */
  delete(id: string): void {
    this.#store.delete(id);
  }

  /** 全量调度记录（kind='schedule' 过滤，分页拉齐）。 */
  listSchedules(): ScheduleRecord[] {
    const out: ScheduleRecord[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = this.#store.scanStates([BUCKET_STATE], cursor, DEFAULT_PAGE_SIZE);
      for (const task of page.items) {
        if (task.kind !== SCHEDULE_KIND) continue;
        out.push(decodeRecord(task));
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /** 读单条（kind 不匹配视为不存在——桶位被外来记录占用时防御）。 */
  #getRecord(id: string): ScheduleRecord | null {
    const task = this.#store.get(id);
    if (task === null || task.kind !== SCHEDULE_KIND) return null;
    return decodeRecord(task);
  }

  /** 包封落库（接缝①: TaskRecord 形体，语义见文件头）。 */
  #put(record: ScheduleRecord): void {
    const task: TaskRecord = {
      id: record.id,
      kind: SCHEDULE_KIND,
      state: BUCKET_STATE,
      checkpoint: encodePayload(record),
      attempts: 0,
      maxAttempts: 0,
      updatedAt: this.#now(),
    };
    this.#store.put(task);
  }
}
