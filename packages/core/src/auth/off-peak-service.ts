/**
 * BI-02.3 · 闲时任务错峰调度引擎 —— 状态机 + Outbox 核销。
 *
 * 接缝①（持久化禁止私建）：Outbox 与票据状态复用注入的 KVStore 端口
 * （{get,set,delete,scan}，测试用内存实现）——生产绑定 BI-03 SQLite 底座，
 * BI-14.5 durable 同源；本模块永不私建存储。
 *
 * 状态机（per 任务，记录持久化于 KVStore `bi:offpeak:task:<ticketId>`）：
 *   queued → polling → (server schedulable → 执行注入 execute 回调) → settling
 *          → flushOutbox 核销成功 → settled（终态）
 *   polling → server expired(3102) → re-ticket（client.submit 同 payload）→ 新票 queued
 *           （旧票归档为 expired；attempts+1；超 maxRetickets → failed）
 *   任意执行点 → failed（终态）：execute 抛异常 / server failed / re-ticket 耗尽
 *
 * Outbox 核销（记录持久化于 `bi:offpeak:outbox:<ticketId>`）：
 *   - 终态落定前先写 outbox（settle/fail 意图，at-least-once），再更新任务状态；
 *   - flushOutbox() 扫描到期条目 → POST settle 端点（settlePath 注入）；
 *     成功 → 删除条目 + settling 任务晋升 settled；失败 → 指数退避
 *     （nextAttemptAt = now + flushBackoffMs * 2^(attempts-1)，注入时钟）；
 *     耗尽 maxFlushAttempts → 条目标记 dead（留档不再投递）；
 *   - 幂等：同 ticket 核销成功即删条目（后续 flush 不再发送）+ 并发 flush in-flight 防重；
 *     服务端按 ticketId 幂等去重（崩溃窗口内的重复投递由服务端兜底）。
 *
 * 零数据外泄红线：settle POST 经 requestJson（./http）注入 fetch，本模块自身永不触网；
 * 日志只含脱敏 note（错误 name，不含 payload/响应原文）。
 * 零外部依赖：node:timers（经 IntervalTimerPort）+ 注入 fetch。
 */
import { DEFAULT_OFF_PEAK_BASE_URL, type OffPeakStatusResult } from "../gateway/off-peak-client";
import { requestJson, type FetchLike } from "./http";
import type { IntervalTimerPort } from "./quota-watchdog";

/** 票据状态结果（自 gateway 域 OffPeakClient 再导出，构成本端口面的一部分）。 */
export type { OffPeakStatusResult };

/**
 * 通用 KV 存储端口（接缝①）。生产绑定 BI-03 SQLite 底座，BI-14.5 durable 同源；
 * 测试注入内存实现。scan 返回匹配前缀的全部键值对。
 */
export interface KVStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

/** 任务键前缀（KVStore 命名空间）。 */
export const OFF_PEAK_TASK_KEY_PREFIX = "bi:offpeak:task:";
/** Outbox 键前缀（KVStore 命名空间）。 */
export const OFF_PEAK_OUTBOX_KEY_PREFIX = "bi:offpeak:outbox:";

/** 任务状态机状态。 */
export type OffPeakTaskState =
  | "queued"
  | "polling"
  | "schedulable"
  | "settling"
  | "settled"
  | "expired"
  | "failed";

/** 任务持久化记录（JSON 序列化存 KVStore）。 */
export interface OffPeakTaskRecord {
  /** 当前票据 ID（=KV 键后缀）。 */
  readonly ticketId: string;
  /** 原始任务载荷（原样透传给 client.submit 与 execute）。 */
  readonly payload: unknown;
  state: OffPeakTaskState;
  /** 已 re-ticket 次数（新票继承累加）。 */
  attempts: number;
  readonly createdAt: number;
  updatedAt: number;
  /** execute 返回值或 server 结果（进 settle 核销载荷）。 */
  result?: unknown;
  /** failed 原因（脱敏，不含外部响应原文）。 */
  reason?: string;
}

/** Outbox 持久化记录（JSON 序列化存 KVStore）。 */
export interface OffPeakOutboxEntry {
  readonly ticketId: string;
  readonly kind: "settle" | "fail";
  readonly attempts: number;
  /** 下次允许投递时间（epoch 毫秒；注入时钟比较）。 */
  nextAttemptAt: number;
  status: "pending" | "dead";
  readonly createdAt: number;
  result?: unknown;
  reason?: string;
}

/** execute 回调载荷视图。 */
export interface OffPeakTaskView {
  readonly ticketId: string;
  readonly payload: unknown;
  /** server schedulable/done 附带的结果（原样透传）。 */
  readonly result?: unknown;
}

/**
 * 取号客户端端口（gateway 域 OffPeakClient 结构化满足；测试注入脚本化 fake）。
 */
export interface OffPeakClientPort {
  submit(payload: unknown): Promise<string>;
  pollStatus(ticketId: string): Promise<OffPeakStatusResult>;
}

/** flushOutbox 结果统计（内部累加计数，字段可变）。 */
export interface FlushOutboxResult {
  /** 核销成功（条目已删除）数。 */
  settled: number;
  /** 失败进入退避重试数。 */
  retried: number;
  /** 退避冷却期内跳过数。 */
  skipped: number;
  /** 重试耗尽标记 dead 数。 */
  dead: number;
}

/** 调度服务结构化错误。 */
export class OffPeakServiceError extends Error {
  readonly code: "config" | "store";

  constructor(code: OffPeakServiceError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OffPeakServiceError";
    this.code = code;
  }
}

export interface OffPeakServiceOptions {
  /** 取号客户端（注入 OffPeakClient 或测试 fake）。 */
  readonly client: OffPeakClientPort;
  /** KV 存储端口（接缝①；生产绑定 BI-03 SQLite 底座）。 */
  readonly store: KVStore;
  /** 闲时执行回调（server 标记 schedulable 时调用；抛异常 → 任务 failed）。 */
  readonly execute: (task: OffPeakTaskView) => Promise<unknown> | unknown;
  /** settle 端点基址，缺省与取号客户端同域常量。 */
  readonly baseUrl?: string;
  /** settle 端点路径（POST 核销语义），缺省 /api/off-peak/settle。 */
  readonly settlePath?: string;
  /** settle POST 的 fetch 注入，缺省 globalThis.fetch（生产）；测试必须注入 stub。 */
  readonly fetchImpl?: FetchLike;
  /** 后台轮询 timer 注入，缺省全局 setInterval（unref）。 */
  readonly timer?: IntervalTimerPort;
  /** 后台轮询间隔（毫秒），缺省 30_000。 */
  readonly pollIntervalMs?: number;
  /** Outbox 核销退避基数（毫秒），缺省 1_000；第 n 次失败后等待 backoff*2^(n-1)。 */
  readonly flushBackoffMs?: number;
  /** Outbox 条目最大投递次数，缺省 8；耗尽标记 dead。 */
  readonly maxFlushAttempts?: number;
  /** 单任务最大 re-ticket 次数，缺省 3；耗尽 → failed。 */
  readonly maxRetickets?: number;
  /** 时钟注入（退避/去抖/时间戳），缺省 Date.now。 */
  readonly now?: () => number;
  /** 脱敏日志宿。 */
  readonly log?: (line: string) => void;
}

export class OffPeakService {
  readonly #client: OffPeakClientPort;
  readonly #store: KVStore;
  readonly #execute: (task: OffPeakTaskView) => Promise<unknown> | unknown;
  readonly #settleUrl: string;
  readonly #fetchImpl: FetchLike | undefined;
  readonly #timer: IntervalTimerPort;
  readonly #pollIntervalMs: number;
  readonly #flushBackoffMs: number;
  readonly #maxFlushAttempts: number;
  readonly #maxRetickets: number;
  readonly #now: () => number;
  readonly #log: ((line: string) => void) | undefined;

  #running = false;
  #handle: unknown;
  /** 轮询/执行/投递中的 ticket 防重入集合。 */
  readonly #pollInFlight = new Set<string>();
  readonly #executing = new Set<string>();
  readonly #flushInFlight = new Set<string>();

  constructor(options: OffPeakServiceOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#execute = options.execute;
    const baseUrl = options.baseUrl ?? DEFAULT_OFF_PEAK_BASE_URL;
    const settlePath = options.settlePath ?? "/api/off-peak/settle";
    this.#settleUrl = `${baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl}${settlePath.startsWith("/") ? settlePath : `/${settlePath}`}`;
    this.#fetchImpl = options.fetchImpl;
    this.#timer = options.timer ?? {
      start(fn, intervalMs) {
        const handle = setInterval(fn, intervalMs);
        handle.unref();
        return handle;
      },
      stop(handle) {
        clearInterval(handle as ReturnType<typeof setInterval>);
      },
    };
    const pollIntervalMs = options.pollIntervalMs ?? 30_000;
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new OffPeakServiceError("config", "pollIntervalMs 必须为正数");
    }
    this.#pollIntervalMs = pollIntervalMs;
    const flushBackoffMs = options.flushBackoffMs ?? 1_000;
    if (!Number.isFinite(flushBackoffMs) || flushBackoffMs < 0) {
      throw new OffPeakServiceError("config", "flushBackoffMs 不能为负数");
    }
    this.#flushBackoffMs = flushBackoffMs;
    this.#maxFlushAttempts = options.maxFlushAttempts ?? 8;
    this.#maxRetickets = options.maxRetickets ?? 3;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
  }

  /** 取号：client.submit → 任务记录（queued）持久化。 */
  async submitTask(payload: unknown): Promise<OffPeakTaskRecord> {
    const ticketId = await this.#client.submit(payload);
    const now = this.#now();
    const record: OffPeakTaskRecord = {
      ticketId,
      payload,
      state: "queued",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.#saveTask(record);
    return record;
  }

  /** 读取任务记录（不存在返回 undefined）。 */
  async getTask(ticketId: string): Promise<OffPeakTaskRecord | undefined> {
    return this.#loadTask(ticketId);
  }

  /**
   * 单轮调度：扫描 queued/polling 任务逐个轮询推进状态机；
   * 单任务异常不中断整轮（吞错记日志）。不隐式触发 flushOutbox（宿主自定节律）。
   */
  async tick(): Promise<void> {
    const records = await this.#loadAllTasks();
    for (const record of records) {
      if (record.state !== "queued" && record.state !== "polling") continue;
      await this.#pollTask(record.ticketId);
    }
  }

  /**
   * Outbox 核销：扫描到期（nextAttemptAt <= now 且 pending）条目逐个 POST settle 端点。
   * 成功 → 删条目 + settling 任务晋升 settled；失败 → 指数退避；耗尽 → dead。
   * 幂等：同 ticket 只投递一次（成功即删 + in-flight 防重）。
   */
  async flushOutbox(): Promise<FlushOutboxResult> {
    const entries = await this.#loadAllOutbox();
    const now = this.#now();
    const result: FlushOutboxResult = { settled: 0, retried: 0, skipped: 0, dead: 0 };
    for (const entry of entries) {
      if (entry.status !== "pending") continue;
      if (entry.nextAttemptAt > now) {
        result.skipped++;
        continue;
      }
      if (this.#flushInFlight.has(entry.ticketId)) {
        result.skipped++;
        continue;
      }
      this.#flushInFlight.add(entry.ticketId);
      try {
        await this.#postSettle(entry);
        await this.#store.delete(`${OFF_PEAK_OUTBOX_KEY_PREFIX}${entry.ticketId}`);
        const task = await this.#loadTask(entry.ticketId);
        if (task !== undefined && task.state === "settling") {
          await this.#saveTask({ ...task, state: "settled", updatedAt: now });
        }
        result.settled++;
      } catch (error) {
        const attempts = entry.attempts + 1;
        if (attempts >= this.#maxFlushAttempts) {
          await this.#saveOutbox({ ...entry, attempts, status: "dead" });
          result.dead++;
        } else {
          const backoff = this.#flushBackoffMs * 2 ** (attempts - 1);
          await this.#saveOutbox({ ...entry, attempts, nextAttemptAt: now + backoff });
          result.retried++;
        }
        this.#log?.(
          JSON.stringify({
            note: `settle-failed:attempt:${attempts}:${error instanceof Error ? error.name : "unknown"}`,
          }),
        );
      } finally {
        this.#flushInFlight.delete(entry.ticketId);
      }
    }
    return result;
  }

  /**
   * 启动后台轮询：立即执行一轮 tick（吞错），随后按 pollIntervalMs 周期执行。
   * 重复 start 幂等。
   */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#tickSafely();
    if (!this.#running) return; // start/stop 竞态
    this.#handle = this.#timer.start(() => {
      void this.#tickSafely();
    }, this.#pollIntervalMs);
  }

  /** 停止后台轮询（幂等）；在途 tick 自然完成。 */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    if (this.#handle !== undefined) {
      this.#timer.stop(this.#handle);
      this.#handle = undefined;
    }
  }

  // ---- 状态机推进 ----

  async #pollTask(ticketId: string): Promise<void> {
    if (this.#pollInFlight.has(ticketId)) return;
    this.#pollInFlight.add(ticketId);
    try {
      const record = await this.#loadTask(ticketId);
      if (record === undefined) return;
      if (record.state !== "queued" && record.state !== "polling") return;

      if (record.state === "queued") {
        await this.#saveTask({ ...record, state: "polling", updatedAt: this.#now() });
      }

      let status: OffPeakStatusResult;
      try {
        status = await this.#client.pollStatus(ticketId);
      } catch (error) {
        // 轮询瞬态失败：保持 polling，下一 tick 重试。
        this.#log?.(
          JSON.stringify({ note: `poll-failed:${error instanceof Error ? error.name : "unknown"}` }),
        );
        return;
      }

      switch (status.status) {
        case "queued":
          break; // 服务端仍在排队：保持本地 polling
        case "schedulable":
          await this.#runExecute(ticketId, status.result);
          break;
        case "done":
          // 服务端已完成：跳过本地 execute，直接核销。
          await this.#finishWithResult(ticketId, status.result);
          break;
        case "expired":
          await this.#reTicket(ticketId);
          break;
        case "failed":
          await this.#failTask(ticketId, status.reason ?? "upstream_failed");
          break;
      }
    } finally {
      this.#pollInFlight.delete(ticketId);
    }
  }

  async #runExecute(ticketId: string, serverResult: unknown): Promise<void> {
    if (this.#executing.has(ticketId)) return;
    this.#executing.add(ticketId);
    try {
      const record = await this.#loadTask(ticketId);
      if (record === undefined) return;
      await this.#saveTask({ ...record, state: "schedulable", updatedAt: this.#now() });
      const view: OffPeakTaskView = {
        ticketId,
        payload: record.payload,
        ...(serverResult === undefined ? {} : { result: serverResult }),
      };
      const outcome = await this.#execute(view);
      await this.#finishWithResult(ticketId, outcome);
    } catch (error) {
      // execute 异常 → failed（终态；outbox 记 fail 意图）。reason 只取错误名，防泄漏。
      await this.#failTask(ticketId, `execute_failed:${error instanceof Error ? error.name : "unknown"}`);
    } finally {
      this.#executing.delete(ticketId);
    }
  }

  /** 终态落定（执行完成）：先写 outbox settle 意图（at-least-once），再置 settling。 */
  async #finishWithResult(ticketId: string, result: unknown): Promise<void> {
    const record = await this.#loadTask(ticketId);
    if (record === undefined) return;
    const now = this.#now();
    await this.#saveOutbox({
      ticketId,
      kind: "settle",
      attempts: 0,
      nextAttemptAt: now, // 立即可投递
      status: "pending",
      createdAt: now,
      ...(result === undefined ? {} : { result }),
    });
    await this.#saveTask({
      ...record,
      state: "settling",
      ...(result === undefined ? {} : { result }),
      updatedAt: now,
    });
  }

  /** failed 终态：写 outbox fail 意图 + 状态落定。 */
  async #failTask(ticketId: string, reason: string): Promise<void> {
    const record = await this.#loadTask(ticketId);
    if (record === undefined) return;
    const now = this.#now();
    await this.#saveOutbox({
      ticketId,
      kind: "fail",
      attempts: 0,
      nextAttemptAt: now,
      status: "pending",
      createdAt: now,
      reason,
    });
    await this.#saveTask({ ...record, state: "failed", reason, updatedAt: now });
  }

  /** 3102 expired → re-ticket：同 payload 重新取号，新票 queued（attempts 累加），旧票归档。 */
  async #reTicket(ticketId: string): Promise<void> {
    const record = await this.#loadTask(ticketId);
    if (record === undefined) return;
    const attempts = record.attempts + 1;
    if (attempts > this.#maxRetickets) {
      await this.#failTask(ticketId, "re_ticket_exhausted");
      return;
    }
    let newTicketId: string;
    try {
      newTicketId = await this.#client.submit(record.payload);
    } catch (error) {
      // 重新取号瞬态失败：旧票保持现状，下一 tick 再次轮询 → 仍 expired → 重试。
      this.#log?.(
        JSON.stringify({ note: `reticket-failed:${error instanceof Error ? error.name : "unknown"}` }),
      );
      return;
    }
    const now = this.#now();
    await this.#saveTask({ ...record, state: "expired", updatedAt: now }); // 旧票归档
    await this.#saveTask({
      ticketId: newTicketId,
      payload: record.payload,
      state: "queued",
      attempts,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ---- 持久化 ----

  async #loadTask(ticketId: string): Promise<OffPeakTaskRecord | undefined> {
    const raw = await this.#store.get(`${OFF_PEAK_TASK_KEY_PREFIX}${ticketId}`);
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as OffPeakTaskRecord;
  }

  async #saveTask(record: OffPeakTaskRecord): Promise<void> {
    await this.#store.set(
      `${OFF_PEAK_TASK_KEY_PREFIX}${record.ticketId}`,
      JSON.stringify(record),
    );
  }

  async #loadAllTasks(): Promise<OffPeakTaskRecord[]> {
    const entries = await this.#store.scan(OFF_PEAK_TASK_KEY_PREFIX);
    return entries.map((e) => JSON.parse(e.value) as OffPeakTaskRecord);
  }

  async #loadAllOutbox(): Promise<OffPeakOutboxEntry[]> {
    const entries = await this.#store.scan(OFF_PEAK_OUTBOX_KEY_PREFIX);
    return entries.map((e) => JSON.parse(e.value) as OffPeakOutboxEntry);
  }

  async #saveOutbox(entry: OffPeakOutboxEntry): Promise<void> {
    await this.#store.set(`${OFF_PEAK_OUTBOX_KEY_PREFIX}${entry.ticketId}`, JSON.stringify(entry));
  }

  /** settle 核销 POST（retries=0：重试节奏完全由 Outbox 退避掌控）。 */
  async #postSettle(entry: OffPeakOutboxEntry): Promise<void> {
    await requestJson({
      method: "POST",
      url: this.#settleUrl,
      body: {
        ticketId: entry.ticketId,
        kind: entry.kind,
        ...(entry.result === undefined ? {} : { result: entry.result }),
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      },
      fetch: this.#fetchImpl,
      timeoutMs: 10_000,
      retries: 0,
      log: this.#log,
    });
  }

  async #tickSafely(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      this.#log?.(
        JSON.stringify({ note: `tick-failed:${error instanceof Error ? error.name : "unknown"}` }),
      );
    }
  }
}

/** 结构化守卫：KVStore 值必须是合法 JSON 对象（防御存储损坏）。 */
