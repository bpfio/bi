/**
 * BI-14.5 · Durable 任务状态机——TaskRecord、显式转移表与 assertTransition。
 *
 * 接缝①（工单钉死）：持久化走单一 SQLite 底座（见同目录 storage.ts 的
 * SqliteDurableStore），本模块只定义"任务长什么样、状态怎么走"，不含任何 IO。
 *
 * 状态机（显式、单向、每步转移可测，与 plan-mode.ts 同一哲学）：
 *
 *   pending ──▶ running ──▶ completed（终态）
 *                 │  ▲
 *                 │  └──── suspended（挂起续跑：suspended→running）
 *                 └──▶ failed ──▶ pending（重试边）
 *
 * 合法转移边全集（恰 6 条）：
 *   pending → running            （调度认领）
 *   running → suspended          （handler 主动挂起）
 *   running → failed             （handler 异常 / 崩溃恢复）
 *   running → completed          （handler 正常返回）
 *   suspended → running          （挂起后续跑）
 *   failed → pending             （可重试终态回退重放）
 *
 * 非法转移一律结构化报错（InvalidTransitionError，code = "invalid-transition"），
 * 绝不静默吞掉；completed 为绝对终态，无任何出边。
 */

/** 极简 JSON 值类型（checkpoint 载荷约束；与 core/session 的 JsonValue 同形体）。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Durable 任务生命周期状态。 */
export type TaskState =
  | "pending"
  | "running"
  | "suspended"
  | "completed"
  | "failed";

/** 全部状态枚举（穷举测试用）。 */
export const TASK_STATES: readonly TaskState[] = [
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
];

/**
 * 一条持久化任务记录。checkpoint 即"断点续跑载荷"：submit 时的 payload、
 * handler 挂起时的进度、完成时的返回值留痕，全走同一字段。
 */
export interface TaskRecord {
  id: string;
  kind: string;
  state: TaskState;
  checkpoint: JsonValue;
  /** 已开始的执行段数（认领 running 时 +1；崩溃重放因此不丢计数）。 */
  attempts: number;
  maxAttempts: number;
  updatedAt: number;
}

/**
 * 转移表常量：每态列出合法去向；不在表内的 (from, to) 组合即非法转移。
 * completed 为绝对终态（空数组）。
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["running"],
  running: ["suspended", "failed", "completed"],
  suspended: ["running"],
  completed: [],
  failed: ["pending"],
};

/** 非法转移的结构化错误（判别方式：instanceof 或 code === "invalid-transition"）。 */
export class InvalidTransitionError extends Error {
  readonly code = "invalid-transition" as const;
  readonly from: TaskState;
  readonly to: TaskState;

  constructor(from: TaskState, to: TaskState) {
    super(`invalid transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** 校验一次状态转移合法性；非法即抛 InvalidTransitionError，绝不静默放行。 */
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}
