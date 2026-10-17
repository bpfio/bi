/**
 * BI-07.11 — 异步后台任务运行时：JobRegistry（生命周期 + 唤醒预算）+ OutputRing。
 *
 * 职责（工单钉死）：
 * - start(kind, runner): JobId —— Job { id, kind, status: running|done|failed|killed,
 *   startedAt, endedAt? }；完成唤醒 onComplete(cb)：繁忙运行环在下一步注入通知、
 *   空闲环触发 follow-up 唤醒（消费方语义；本卡只负责回调派发与预算闸门）；
 * - maxConsecutiveWakes 预算（默认 3）：连续唤醒超预算不再自动唤醒（防自激），
 *   预算随用户输入重置（noteUserInput）；
 * - OutputRing 环形缓冲：64KB 房规容量，超限覆盖最旧内容（字节记账）；
 * - Pump（job-pump.ts）：异步拉取 runner 的注入 stream 写入 ring；
 * - 模型工具三件套（job-tools.ts）：job_list / job_output / job_kill。
 */
import { Buffer } from "node:buffer";
import { JobPump, type PumpOutcome } from "./job-pump";

export type JobId = string;

export type JobStatus = "running" | "done" | "failed" | "killed";

export interface Job {
  id: JobId;
  kind: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** failed 时的错误留痕。 */
  error?: string;
}

/** runner 句柄：stream 为注入的输出流（Pump 异步拉取）；kill 可选（job_kill 支路）。 */
export interface JobRunner {
  stream: AsyncIterable<string>;
  kill?: () => void;
}

/** 完成唤醒回调载荷（done/failed/killed 均触发，受唤醒预算约束）。 */
export interface JobWakeEvent {
  job: Job;
}

export type JobErrorCode = "unknown-job" | "invalid-kind" | "invalid-capacity";

/** JobRegistry 结构化错误（判别方式：code 字段）。 */
export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode, message: string) {
    super(message);
    this.name = "JobError";
    this.code = code;
  }
}

/** 缺省环形缓冲容量：64KB（房规钉死）。 */
export const OUTPUT_RING_CAPACITY_BYTES = 64 * 1024;

/**
 * 环形缓冲（字节记账，64KB 房规）：总驻留字节超容量时精确保留最新
 * capacity 字节（按 UTF-8 字节截取，多字节字符边界截断退化为替换符，
 * 已知可接受边界）。读面 readTail(maxChars) 按字符自尾部截取。
 */
export class OutputRing {
  readonly #capacity: number;
  #buf = "";
  #bytes = 0;
  #droppedBytes = 0;

  constructor(capacityBytes: number = OUTPUT_RING_CAPACITY_BYTES) {
    if (!Number.isInteger(capacityBytes) || capacityBytes < 1) {
      throw new JobError("invalid-capacity", `环形缓冲容量须为正整数: ${capacityBytes}`);
    }
    this.#capacity = capacityBytes;
  }

  get capacityBytes(): number {
    return this.#capacity;
  }

  /** 当前驻留字节数（≤ capacity，± 多字节截断边界）。 */
  get sizeBytes(): number {
    return this.#bytes;
  }

  /** 累计被覆盖丢弃的字节数（观测用）。 */
  get droppedBytes(): number {
    return this.#droppedBytes;
  }

  write(chunk: string): void {
    this.#buf += chunk;
    this.#bytes = Buffer.byteLength(this.#buf, "utf8");
    if (this.#bytes <= this.#capacity) return;
    const overflow = this.#bytes - this.#capacity;
    const kept = Buffer.from(this.#buf, "utf8").subarray(overflow).toString("utf8");
    const keptBytes = Buffer.byteLength(kept, "utf8");
    this.#droppedBytes += this.#bytes - keptBytes;
    this.#buf = kept;
    this.#bytes = keptBytes;
  }

  /** 自尾部读取至多 maxChars 字符（缺省全量驻留内容）。 */
  readTail(maxChars?: number): string {
    if (maxChars === undefined || maxChars < 0 || maxChars >= this.#buf.length) return this.#buf;
    return this.#buf.slice(-maxChars);
  }
}

export interface JobRegistryOptions {
  readonly now?: () => number;
  readonly idGen?: () => string;
  /** 注入环形缓冲容量（缺省 64KB 房规）。 */
  readonly ringCapacityBytes?: number;
  /** 连续自动唤醒预算（默认 3；防自激）。 */
  readonly maxConsecutiveWakes?: number;
}

function defaultJobIdGen(): () => string {
  let n = 0;
  return () => `job-${++n}`;
}

interface JobRecord {
  job: Job;
  ring: OutputRing;
  pump: JobPump;
  runner: JobRunner;
}

export class JobRegistry {
  readonly #now: () => number;
  readonly #idGen: () => string;
  readonly #ringCapacity: number;
  readonly #maxWakes: number;
  readonly #records = new Map<JobId, JobRecord>();
  readonly #wakeCallbacks: Array<(event: JobWakeEvent) => void> = [];
  #wakeBudget: number;
  #suppressedWakes = 0;

  constructor(options: JobRegistryOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#idGen = options.idGen ?? defaultJobIdGen();
    this.#ringCapacity = options.ringCapacityBytes ?? OUTPUT_RING_CAPACITY_BYTES;
    this.#maxWakes = Math.max(0, Math.trunc(options.maxConsecutiveWakes ?? 3));
    this.#wakeBudget = this.#maxWakes;
  }

  /** 登记后台任务：立即返回 running 态 Job；Pump 异步拉流至终态。 */
  start(kind: string, runner: JobRunner): JobId {
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw new JobError("invalid-kind", "kind 须为非空字符串");
    }
    const id = this.#idGen();
    const ring = new OutputRing(this.#ringCapacity);
    const pump = new JobPump(ring);
    const job: Job = { id, kind, status: "running", startedAt: this.#now() };
    this.#records.set(id, { job, ring, pump, runner });
    void pump.run(runner).then((outcome) => this.#finalize(id, outcome));
    return id;
  }

  /** 全量任务快照（startedAt 升序，即登记序）。 */
  list(): Job[] {
    return [...this.#records.values()]
      .map((r) => ({ ...r.job }))
      .sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get(id: JobId): Job | undefined {
    const record = this.#records.get(id);
    return record === undefined ? undefined : { ...record.job };
  }

  /** tail 读取（字符数）；未知 id 结构化抛错。 */
  output(id: JobId, opts?: { tail?: number }): { job: Job; output: string } {
    const record = this.#records.get(id);
    if (record === undefined) {
      throw new JobError("unknown-job", `未知任务: ${id}`);
    }
    const tail = opts?.tail;
    if (tail !== undefined && (!Number.isInteger(tail) || tail < 1)) {
      throw new JobError("invalid-capacity", `tail 须为正整数: ${String(tail)}`);
    }
    return { job: { ...record.job }, output: record.ring.readTail(tail) };
  }

  /** 终止运行中任务 → killed（通知 runner.kill 并停泵）；非 running 返回 false。 */
  kill(id: JobId): boolean {
    const record = this.#records.get(id);
    if (record === undefined || record.job.status !== "running") return false;
    record.pump.stop();
    record.runner.kill?.();
    record.job.status = "killed";
    record.job.endedAt = this.#now();
    this.#wake({ ...record.job });
    return true;
  }

  /** 注册完成唤醒回调（done/failed/killed 均触发，受唤醒预算约束）。 */
  onComplete(cb: (event: JobWakeEvent) => void): void {
    this.#wakeCallbacks.push(cb);
  }

  /** 用户输入到达：重置连续唤醒预算（防自激的解锁通道）。 */
  noteUserInput(): void {
    this.#wakeBudget = this.#maxWakes;
  }

  /** 剩余唤醒预算（观测用）。 */
  get wakeBudgetRemaining(): number {
    return this.#wakeBudget;
  }

  /** 被预算抑制的唤醒次数（观测用）。 */
  get suppressedWakeCount(): number {
    return this.#suppressedWakes;
  }

  #finalize(id: JobId, outcome: PumpOutcome): void {
    const record = this.#records.get(id);
    if (record === undefined) return;
    if (record.job.status !== "running") return; // kill 已落终态，勿覆盖、勿重复唤醒
    if (outcome.status === "done") {
      record.job.status = "done";
    } else if (outcome.status === "failed") {
      record.job.status = "failed";
      record.job.error = outcome.error;
    } else {
      record.job.status = "killed";
    }
    record.job.endedAt = this.#now();
    this.#wake({ ...record.job });
  }

  #wake(job: Job): void {
    if (this.#wakeBudget <= 0) {
      this.#suppressedWakes++;
      return;
    }
    this.#wakeBudget--;
    for (const cb of this.#wakeCallbacks) {
      try {
        cb({ job });
      } catch {
        // 监听器异常隔离：单回调抛错不阻断其余回调与后续唤醒。
      }
    }
  }
}
