/**
 * BI-14.5 · 崩溃自愈的持久化调度器（DurableScheduler）。
 *
 * 接缝①（工单钉死）：状态全部落在单一 SQLite 底座（DurableStore），调度器
 * 自身无内存权威态——进程随时可死，重起实例凭 store + recover() 续跑。
 *
 * 执行模型（每一步都经 task-state.ts 转移表校验，非法转移结构化报错）：
 *   submit(kind, payload)                → pending（checkpoint = payload）
 *   run() 主循环：分页拉 pending/suspended → 认领 pending/suspended→running
 *     （attempts +1，崩溃因此不丢计数）→ handler →
 *     - 正常返回 JsonValue               → running→completed（返回值即 checkpoint 留痕）
 *     - 返回 { done:false, checkpoint }  → running→suspended（挂起，断点续跑）
 *     - 抛异常且 attempts < maxAttempts  → running→failed→pending（退避重试，
 *                                          退避时刻由注入时钟/睡眠驱动）
 *     - 抛异常且 attempts ≥ maxAttempts  → running→failed（终态）
 *
 * 崩溃自愈 recover()：扫 state='running' 孤儿（进程死于"认领之后、终态之前"
 * 的断点），按策略处置——replay（默认）：running→failed（崩溃计一次失败尝试，
 * attempts 已在认领时 +1）→ attempts < maxAttempts 则 failed→pending 重放，
 * 否则留在 failed 终态（防"每次都崩死进程"的任务无限重启）；fail：一律标
 * failed 终态。两步均走转移表合法边，不开旁门。
 *
 * 长定时器分片 scheduleAt(id, atMs)：把 pending 任务的 checkpoint 包上
 * { __bi_deferred__: { wakeAt, payload } } 延期标记（主循环据此跳过，不被
 * 提前认领），分片睡眠（每片 ≤ MAX_TIMER_DELAY = 2^31-1，规避 setTimeout
 * 大延迟被运行时钳制成立即触发）直到到点，解包认领 pending→running 并执行
 * 到终态。deferred 任务归 scheduleAt 自驱，run() 不接管。
 *
 * 并发约定（单驱动）：同一实例内 run() 禁止重入（scheduler-busy）；认领动作
 * get→assert→put 同步完成，进程内不会被并发认领插队。跨进程同时驱动同一
 * store 不在本卡范围（调用方保证单写者）。
 */
import {
  assertTransition,
  type JsonValue,
  type TaskRecord,
  type TaskState,
} from "./task-state";
import { DEFAULT_PAGE_SIZE, type DurableStore } from "./storage";

/** 单片睡眠上限：2^31 - 1 毫秒（setTimeout 语义上限，超过须分片）。 */
export const MAX_TIMER_DELAY = 2_147_483_647;

/** handler 挂起信号：未完成，携带续跑断点，调度器转 suspended。 */
export interface SuspendSignal {
  done: false;
  checkpoint: JsonValue;
}

/** handler 端口：认领后的任务记录（state=running，checkpoint=续跑断点）。 */
export type TaskHandler = (
  task: TaskRecord,
) => Promise<JsonValue | SuspendSignal>;

/** 判别 handler 返回是否为挂起信号（结构化：done === false 且带 checkpoint）。 */
export function isSuspendSignal(value: unknown): value is SuspendSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { done?: unknown }).done === false &&
    "checkpoint" in value
  );
}

/** scheduleAt 延期标记（落盘在 checkpoint 字段内；主循环据此跳过 deferred 任务）。 */
type DeferredMarker = {
  wakeAt: number;
  payload: JsonValue;
};

const DEFERRED_KEY = "__bi_deferred__";

/** 构造延期 checkpoint（scheduleAt 专用；payload 为原任务载荷，到点解包透传 handler）。 */
export function deferredCheckpoint(wakeAt: number, payload: JsonValue): JsonValue {
  return { [DEFERRED_KEY]: { wakeAt, payload } };
}

/** 判别 checkpoint 是否为延期标记。 */
export function isDeferredCheckpoint(
  value: JsonValue,
): value is { [DEFERRED_KEY]: DeferredMarker } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const marker = (value as Record<string, unknown>)[DEFERRED_KEY];
  return (
    typeof marker === "object" &&
    marker !== null &&
    typeof (marker as { wakeAt?: unknown }).wakeAt === "number" &&
    "payload" in marker
  );
}

/** 结构化错误码集合（稳定标识，供调用方分支自愈）。 */
export type DurableSchedulerErrorCode =
  | "unknown-task"
  | "not-schedulable"
  | "handler-missing"
  | "scheduler-busy"
  | "task-failed";

/** 调度器结构化错误（判别方式：code 字段）。 */
export class DurableSchedulerError extends Error {
  readonly code: DurableSchedulerErrorCode;
  readonly taskId?: string;

  constructor(
    code: DurableSchedulerErrorCode,
    message: string,
    taskId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DurableSchedulerError";
    this.code = code;
    this.taskId = taskId;
  }
}

/** DurableScheduler 构造选项（clock/sleep 注入可加速测试；均可缺省）。 */
export interface DurableSchedulerOptions {
  store: DurableStore;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  handlers: Record<string, TaskHandler>;
  /** 缺省最大尝试次数（submit 未显式指定时），缺省 3。 */
  maxAttempts?: number;
  /** 主循环 / recover 分页大小，缺省 256（与 store 缺省一致）。 */
  pageSize?: number;
  /** 退避重试：基准毫秒（第 n 次失败后延迟 backoffMs * 2^(n-1)），缺省 0（立即重试）。 */
  retry?: { backoffMs?: number };
  /** recover 缺省策略，缺省 replay（工单钉死默认重放）。 */
  recover?: { strategy?: "replay" | "fail" };
}

/** recover 结果：扫描孤儿数 / 重放回 pending 数 / 标记 failed 数。 */
export interface RecoverResult {
  scanned: number;
  replayed: number;
  failed: number;
}

interface DeferredWaiter {
  resolve: (value: JsonValue) => void;
  reject: (error: unknown) => void;
}

/**
 * 崩溃自愈的持久化调度器：submit + run 主循环 + recover 自愈 + scheduleAt
 * 长定时器分片 + awaitSettled 多 waiter 终态汇聚。权威态在 store，实例可弃可换。
 */
export class DurableScheduler {
  readonly #store: DurableStore;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #handlers: Record<string, TaskHandler>;
  readonly #defaultMaxAttempts: number;
  readonly #pageSize: number;
  readonly #backoffMs: number;
  readonly #recoverStrategy: "replay" | "fail";
  /** 退避登记：id → 最早可再认领时刻（进程内辅助，丢失只影响退避精度不影响正确性）。 */
  readonly #backoffUntil = new Map<string, number>();
  /** 终态 waiter 汇聚：id → 挂起中的 waiter 列表。 */
  readonly #waiters = new Map<string, DeferredWaiter[]>();
  #runActive = false;

  constructor(options: DurableSchedulerOptions) {
    this.#store = options.store;
    this.#now = options.clock ?? Date.now;
    this.#sleep =
      options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.#handlers = options.handlers;
    this.#defaultMaxAttempts = options.maxAttempts ?? 3;
    this.#pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#backoffMs = options.retry?.backoffMs ?? 0;
    this.#recoverStrategy = options.recover?.strategy ?? "replay";
  }

  /** 底层存储（观测 / recover 前后断言用）。 */
  get store(): DurableStore {
    return this.#store;
  }

  /**
   * 提交任务：落一条 pending 记录（checkpoint = payload，attempts = 0）。
   * kind 未注册 handler → 结构化报错 handler-missing（提交口 fail-fast）。
   * id 缺省 crypto.randomUUID；可显式指定（scheduleAt / awaitSettled 需按 id 寻址）。
   */
  submit(
    kind: string,
    payload: JsonValue,
    opts?: { id?: string; maxAttempts?: number },
  ): TaskRecord {
    if (this.#handlers[kind] === undefined) {
      throw new DurableSchedulerError(
        "handler-missing",
        `未注册 kind="${kind}" 的 handler，拒绝提交`,
      );
    }
    const record: TaskRecord = {
      id: opts?.id ?? crypto.randomUUID(),
      kind,
      state: "pending",
      checkpoint: payload,
      attempts: 0,
      maxAttempts: opts?.maxAttempts ?? this.#defaultMaxAttempts,
      updatedAt: this.#now(),
    };
    this.#store.put(record);
    return record;
  }

  /**
   * 主循环：分页拉 pending / suspended 逐个认领执行，直到无可跑任务。
   * 退避中的 pending（backoffUntil 未到）本轮跳过；全部退避中则睡眠到最早
   * 退避点再续；deferred（scheduleAt 管辖）任务一律跳过。重入 → scheduler-busy。
   */
  async run(): Promise<void> {
    if (this.#runActive) {
      throw new DurableSchedulerError(
        "scheduler-busy",
        "run() 已在进行中，禁止重入",
      );
    }
    this.#runActive = true;
    try {
      for (;;) {
        const executed = await this.#drainEligible();
        if (executed > 0) continue; // 有进展：重扫（退避/续跑可能解锁新工作）
        this.#pruneStaleBackoff();  // 到期却没跑成 → 任务已消失/变态，清登记防空转
        const next = this.#earliestBackoff();
        if (next === undefined) return; // 无可跑、无退避中任务 → 静默收敛
        await this.#sleepUntil(next);
      }
    } finally {
      this.#runActive = false;
    }
  }

  /**
   * 崩溃自愈：扫全部 state='running' 孤儿，按策略处置（默认 replay）。
   * replay：running→failed（崩溃计一次失败尝试）→ attempts < maxAttempts 则
   * failed→pending 重放，否则留 failed 终态；fail：一律 failed 终态。
   */
  async recover(strategy?: "replay" | "fail"): Promise<RecoverResult> {
    const mode = strategy ?? this.#recoverStrategy;
    let scanned = 0;
    let replayed = 0;
    let failed = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = this.#store.scanStates(["running"], cursor, this.#pageSize);
      for (const orphan of page.items) {
        scanned++;
        // 崩溃视为一次失败尝试：running→failed（合法边，attempts 已在认领时 +1）
        this.#store.put({
          ...orphan,
          state: "failed",
          updatedAt: this.#now(),
        });
        if (mode === "replay" && orphan.attempts < orphan.maxAttempts) {
          const marked = this.#store.get(orphan.id);
          if (marked !== null && marked.state === "failed") {
            assertTransition("failed", "pending");
            this.#store.put({ ...marked, state: "pending", updatedAt: this.#now() });
            replayed++;
            continue;
          }
        }
        failed++;
        // 标 failed 终态的孤儿：已在等待的 waiter 全部结构化拒绝（不留悬空 promise）
        this.#settleWaiters(orphan.id, "failed", orphan.checkpoint);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return { scanned, replayed, failed };
  }

  /**
   * 长定时器分片调度：把 pending 任务包延期标记（主循环不再认领），分片睡眠
   * （每片 ≤ MAX_TIMER_DELAY）到 atMs，解包认领执行到终态。resolve 于 completed
   * 的 checkpoint；终态 failed 则拒绝（task-failed）。非 pending / 重复调度 /
   * 未知 id → 结构化报错。
   */
  async scheduleAt(id: string, atMs: number): Promise<JsonValue> {
    const record = this.#store.get(id);
    if (record === null) {
      throw new DurableSchedulerError("unknown-task", `任务 ${id} 不存在`, id);
    }
    if (record.state !== "pending" || isDeferredCheckpoint(record.checkpoint)) {
      throw new DurableSchedulerError(
        "not-schedulable",
        `任务 ${id} 当前态 ${record.state}${isDeferredCheckpoint(record.checkpoint) ? "（已延期）" : ""}，不可 scheduleAt`,
        id,
      );
    }
    this.#store.put({
      ...record,
      checkpoint: deferredCheckpoint(atMs, record.checkpoint),
      updatedAt: this.#now(),
    });
    await this.#sleepUntil(atMs);
    await this.#claimAndExecute(id);
    return this.awaitSettled(id);
  }

  /**
   * 等待任务到终态（completed / failed）：多 waiter 挂同一汇聚点，终态时全部
   * 放行——completed 逐个 resolve(checkpoint)，failed 逐个拒绝（task-failed）。
   * 已终态立即返回；未知 id → unknown-task；pending/suspended 则挂起等待。
   */
  awaitSettled(id: string): Promise<JsonValue> {
    const record = this.#store.get(id);
    if (record === null) {
      return Promise.reject(
        new DurableSchedulerError("unknown-task", `任务 ${id} 不存在`, id),
      );
    }
    if (record.state === "completed") return Promise.resolve(record.checkpoint);
    if (record.state === "failed") {
      return Promise.reject(this.#taskFailedError(record));
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const list = this.#waiters.get(id) ?? [];
      list.push({ resolve, reject });
      this.#waiters.set(id, list);
    });
  }

  /** 认领 + 执行一条任务（run 主循环与 scheduleAt 共用执行体）。 */
  async #claimAndExecute(id: string): Promise<void> {
    const fresh = this.#store.get(id);
    if (
      fresh === null ||
      fresh.state === "running" ||
      fresh.state === "completed" ||
      fresh.state === "failed"
    ) {
      return; // 已被认领或已终态：不重复执行
    }
    // fresh.state ∈ {pending, suspended}；deferred 标记在此解包（原 payload 透传 handler）
    const checkpoint = isDeferredCheckpoint(fresh.checkpoint)
      ? fresh.checkpoint[DEFERRED_KEY].payload
      : fresh.checkpoint;
    assertTransition(fresh.state, "running");
    const claimed: TaskRecord = {
      ...fresh,
      state: "running",
      checkpoint,
      attempts: fresh.attempts + 1,
      updatedAt: this.#now(),
    };
    this.#store.put(claimed);
    await this.#executeClaimed(claimed);
  }

  /** 执行已认领（running）任务：调 handler 并按结果落终态 / 挂起 / 退避重试。 */
  async #executeClaimed(claimed: TaskRecord): Promise<void> {
    const handler = this.#handlers[claimed.kind];
    if (handler === undefined) {
      // 防御路径：submit 已 fail-fast，此处兜底（记录被外部改 kind 等异常态）——
      // 直接落 failed 终态，不让任务滞留 running 成孤儿。
      this.#finish(claimed.id, "failed", claimed.checkpoint);
      return;
    }
    try {
      const out = await handler(claimed);
      if (isSuspendSignal(out)) {
        this.#finish(claimed.id, "suspended", out.checkpoint);
      } else {
        this.#finish(claimed.id, "completed", out);
      }
    } catch (cause) {
      if (claimed.attempts < claimed.maxAttempts) {
        // 退避重试：running→failed→pending，登记退避点（backoffMs=0 即立即）
        this.#finish(claimed.id, "failed", claimed.checkpoint, { retriable: true });
        if (this.#backoffMs > 0) {
          this.#backoffUntil.set(
            claimed.id,
            this.#now() + this.#backoffMs * 2 ** (claimed.attempts - 1),
          );
        }
      } else {
        this.#finish(claimed.id, "failed", claimed.checkpoint);
      }
      void cause; // 错误经 task-failed 结构化透出给 waiter；记录字段不留原始异常
    }
  }

  /** 落一次转移（running → to；to=failed 且 retriable 时续走 failed→pending 重试边）。 */
  #finish(
    id: string,
    to: Extract<TaskState, "suspended" | "completed" | "failed">,
    checkpoint: JsonValue,
    opts?: { retriable?: boolean },
  ): void {
    const current = this.#store.get(id);
    if (current === null || current.state !== "running") return;
    assertTransition("running", to);
    this.#store.put({ ...current, state: to, checkpoint, updatedAt: this.#now() });
    if (to === "failed" && opts?.retriable === true) {
      const marked = this.#store.get(id);
      if (marked !== null && marked.state === "failed") {
        assertTransition("failed", "pending");
        this.#store.put({ ...marked, state: "pending", updatedAt: this.#now() });
        return; // 未到终态：waiter 继续等
      }
    }
    if (to === "completed" || to === "failed") {
      this.#backoffUntil.delete(id);
      this.#settleWaiters(id, to, checkpoint);
    }
  }

  /** 终态放行全部 waiter（同步、逐个；completed resolve / failed 拒绝）。 */
  #settleWaiters(id: string, state: "completed" | "failed", checkpoint: JsonValue): void {
    const list = this.#waiters.get(id);
    if (list === undefined) return;
    this.#waiters.delete(id);
    for (const waiter of list) {
      if (state === "completed") {
        waiter.resolve(checkpoint);
      } else {
        waiter.reject(this.#taskFailedError(this.#store.get(id)));
      }
    }
  }

  #taskFailedError(record: TaskRecord | null): DurableSchedulerError {
    const id = record?.id ?? "?";
    return new DurableSchedulerError(
      "task-failed",
      `任务 ${id} 终态 failed（attempts=${record?.attempts ?? "?"}/${record?.maxAttempts ?? "?"}）`,
      id,
    );
  }

  /** 一轮分页扫描：把当前全部可跑任务执行一遍，返回执行数。 */
  async #drainEligible(): Promise<number> {
    let executed = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = this.#store.scanStates(
        ["pending", "suspended"],
        cursor,
        this.#pageSize,
      );
      for (const snapshot of page.items) {
        if (!this.#eligible(snapshot)) continue;
        await this.#claimAndExecute(snapshot.id);
        executed++;
      }
      if (page.nextCursor === null) return executed;
      cursor = page.nextCursor;
    }
  }

  /** 可跑判定：pending 须非 deferred 且不在退避期；suspended 恒可跑。 */
  #eligible(snapshot: TaskRecord): boolean {
    if (snapshot.state === "pending") {
      if (isDeferredCheckpoint(snapshot.checkpoint)) return false;
      const until = this.#backoffUntil.get(snapshot.id);
      return until === undefined || until <= this.#now();
    }
    return snapshot.state === "suspended";
  }

  /** 清理失效退避登记：已到期但任务消失/不再是可跑 pending 的条目（防 run() 空转）。 */
  #pruneStaleBackoff(): void {
    const now = this.#now();
    for (const [id, at] of this.#backoffUntil) {
      if (at > now) continue;
      const rec = this.#store.get(id);
      if (rec === null || rec.state !== "pending" || isDeferredCheckpoint(rec.checkpoint)) {
        this.#backoffUntil.delete(id);
      }
    }
  }

  /** 最早未到期的退避点（无 → undefined；已到期条目由 prune 清理或本就该被 drain 跑掉）。 */
  #earliestBackoff(): number | undefined {
    let earliest: number | undefined;
    const now = this.#now();
    for (const at of this.#backoffUntil.values()) {
      if (at > now && (earliest === undefined || at < earliest)) earliest = at;
    }
    return earliest;
  }

  /** 分片睡眠到 atMs：每片 ≤ MAX_TIMER_DELAY，注入 sleep/clock 可加速测试。 */
  async #sleepUntil(atMs: number): Promise<void> {
    for (;;) {
      const remaining = atMs - this.#now();
      if (remaining <= 0) return;
      await this.#sleep(Math.min(MAX_TIMER_DELAY, remaining));
    }
  }
}
