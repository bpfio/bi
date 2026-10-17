/**
 * BI-07.7 — 会话内 Cron 调度器（差异工单：接缝①委托）。
 *
 * 职责（工单钉死）：
 * - **不重建 cron 解析/推算**：调度核经注入端口 CronCorePort { parseCron, nextFire }
 *   委托 BI-07.14（workflow/src/schedule 的 parseCron/nextFire）。裁定：core 不得
 *   import workflow（workflow 为独立包，依赖方向单向），故跨包委托以端口注入完成——
 *   组装方（宿主装配）注入 workflow 适配器，本文件测试注入 stub 断言委托发生。
 *   适配器示例（宿主侧）：
 *     { parseCron: (expr) => parseCron(expr),
 *       nextFire: (parsed, fromMs) => nextFire({ kind: 'cron', expr: parsed.expr }, fromMs) }
 * - 三工具面语义：create(name, cronExpr, action) / list() / delete(id)
 *   （模型可见面 CronCreate/CronList/CronDelete 见 cron-tools.ts）。
 * - Jitter 防惊群：下次触发时刻 = nextFire + jitter(0~30s，随机函数可注入)。
 * - 触发 → action 回调注入（经 tick 推进时钟；action 由装配层注入）。
 * - 事件溯源：CronAdd / CronFired / CronDelete 顺序追加至内存事件日志数组。
 * - 幂等 create：同名（name）重复 create 返回既有条目，不重复登记、不重复事件。
 */
import { systemClock, type Clock } from "../guard/deadline";

/** 调度核端口（宿主装配注入 workflow BI-07.14 实现；parsed 为不透明句柄）。 */
export interface CronCorePort {
  /** 解析 5 字段 cron 表达式；非法应抛错（本服务包装为结构化 CronError）。 */
  parseCron(expr: string): unknown;
  /** 返回严格晚于 fromMs 的下一次触发时刻（epoch ms）；不可达应抛错。 */
  nextFire(parsed: unknown, fromMs: number): number;
}

/** 触发回调（装配层注入；entry 标识哪条 cron 到期）。 */
export type CronAction = (entry: CronEntry) => void | Promise<void>;

export interface CronEntry {
  id: string;
  name: string;
  cronExpr: string;
  createdAt: number;
  /** 最近一次排程附加的 jitter（ms；观测用）。 */
  jitterMs: number;
  /** 下一次触发时刻（已含 jitter）。 */
  nextFireAt: number;
  lastFiredAt: number | null;
  /** 最近一次 action / 重排错误（观测用）。 */
  lastError?: string;
}

export type CronEvent =
  | { type: "CronAdd"; at: number; id: string; name: string; cronExpr: string; nextFireAt: number }
  | { type: "CronFired"; at: number; id: string; error?: string }
  | { type: "CronDelete"; at: number; id: string };

export type CronErrorCode = "invalid-expr" | "unreachable-schedule" | "invalid-name";

/** CronService 结构化错误（判别方式：code 字段）。 */
export class CronError extends Error {
  readonly code: CronErrorCode;

  constructor(code: CronErrorCode, message: string) {
    super(message);
    this.name = "CronError";
    this.code = code;
  }
}

/** 缺省 jitter：0~30000ms 均匀含端点（防惊群窗口，工单钉死 30s）。 */
export function defaultJitterMs(): number {
  return Math.floor(Math.random() * 30_001);
}

/** 缺省 id 生成：实例内单调 cron-1、cron-2…（确定性，测试友好）。 */
function defaultCronIdGen(): () => string {
  let n = 0;
  return () => `cron-${++n}`;
}

export interface CronServiceOptions {
  core: CronCorePort;
  /** 注入随机：返回本回合附加 jitter ms（缺省 0~30000 均匀）。 */
  jitterMs?: () => number;
  readonly clock?: Clock;
  readonly idGen?: () => string;
}

interface CronRecord {
  entry: CronEntry;
  /** 调度核不透明句柄（解析产物，重排复用）。 */
  parsed: unknown;
  action: CronAction;
}

export class CronService {
  readonly #core: CronCorePort;
  readonly #jitterMs: () => number;
  readonly #clock: Clock;
  readonly #idGen: () => string;
  readonly #records = new Map<string, CronRecord>();
  readonly #events: CronEvent[] = [];

  constructor(options: CronServiceOptions) {
    this.#core = options.core;
    this.#jitterMs = options.jitterMs ?? defaultJitterMs;
    this.#clock = options.clock ?? systemClock;
    this.#idGen = options.idGen ?? defaultCronIdGen();
  }

  /**
   * 登记一条会话内 cron：经端口校验表达式并计算首次触发时刻（+jitter）。
   * 同名幂等：已存在同名条目 → 原样返回（不重复登记、不追加事件）。
   */
  create(name: string, cronExpr: string, action: CronAction): CronEntry {
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new CronError("invalid-name", "cron 名称须为非空字符串");
    }
    if (typeof action !== "function") {
      throw new CronError("invalid-name", "action 须为回调函数");
    }
    const existing = this.#byName(name);
    if (existing !== undefined) return existing;

    let parsed: unknown;
    try {
      parsed = this.#core.parseCron(cronExpr);
    } catch (err) {
      throw new CronError("invalid-expr", `cron 表达式非法: ${cronExpr}（${(err as Error).message}）`);
    }
    const now = this.#clock.now();
    const first = this.#schedule(parsed, now, name);
    const jitter = this.#jitterMs();
    const entry: CronEntry = {
      id: this.#idGen(),
      name,
      cronExpr,
      createdAt: now,
      jitterMs: jitter,
      nextFireAt: first + jitter,
      lastFiredAt: null,
    };
    this.#records.set(entry.id, { entry, parsed, action });
    this.#events.push({
      type: "CronAdd",
      at: now,
      id: entry.id,
      name,
      cronExpr,
      nextFireAt: entry.nextFireAt,
    });
    // 返回快照副本：调用方持有条目不可变视图，运行时演进经 list()/事件溯源观测。
    return { ...entry };
  }

  /** 条目列表（按 createdAt 升序；不含 action 等运行时面）。 */
  list(): CronEntry[] {
    return [...this.#records.values()]
      .map((r) => ({ ...r.entry }))
      .sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** 注销；未知 id 返回 false（工具面映射结构化拒绝）。 */
  delete(id: string): boolean {
    if (!this.#records.has(id)) return false;
    this.#records.delete(id);
    this.#events.push({ type: "CronDelete", at: this.#clock.now(), id });
    return true;
  }

  /**
   * 时钟推进：触发所有 nextFireAt ≤ now 的条目（按触发时刻升序，action 逐个
   * await），随后各自重排 nextFireAt = nextFire(now) + 新 jitter。action 抛错
   * 不阻断本轮与其余条目（lastError 留痕）；重排不可达 → nextFireAt=Infinity
   * 停止后续触发。返回本次触发条数。
   */
  async tick(now?: number): Promise<number> {
    const at = now ?? this.#clock.now();
    const due = [...this.#records.values()]
      .filter((r) => r.entry.nextFireAt <= at)
      .sort((a, b) => (a.entry.nextFireAt - b.entry.nextFireAt) || (a.entry.id < b.entry.id ? -1 : 1));
    let fired = 0;
    for (const record of due) {
      const entry = record.entry;
      let error: string | undefined;
      try {
        await record.action(entry);
      } catch (err) {
        error = (err as Error).message;
      }
      entry.lastFiredAt = at;
      if (error !== undefined) entry.lastError = error;
      fired++;
      this.#events.push(error === undefined ? { type: "CronFired", at, id: entry.id } : { type: "CronFired", at, id: entry.id, error });
      try {
        const next = this.#core.nextFire(record.parsed, at);
        const jitter = this.#jitterMs();
        entry.jitterMs = jitter;
        entry.nextFireAt = next + jitter;
      } catch (err) {
        entry.lastError = (err as Error).message;
        entry.nextFireAt = Number.POSITIVE_INFINITY;
      }
    }
    return fired;
  }

  /** 事件溯源日志（只读快照副本，追加序）。 */
  events(): readonly CronEvent[] {
    return [...this.#events];
  }

  #schedule(parsed: unknown, fromMs: number, name: string): number {
    try {
      return this.#core.nextFire(parsed, fromMs);
    } catch (err) {
      throw new CronError(
        "unreachable-schedule",
        `cron ${name} 无可命中触发时刻（${(err as Error).message}）`,
      );
    }
  }

  #byName(name: string): CronEntry | undefined {
    for (const record of this.#records.values()) {
      if (record.entry.name === name) return { ...record.entry };
    }
    return undefined;
  }
}
