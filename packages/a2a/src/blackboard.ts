/**
 * BI-15.2 · 共享事实黑板（Blackboard）—— 跨网协作角色的共享事实底账。
 *
 * 职责（BI-15 工单卡设计）：
 * - 事实面五操作：write / read / subscribe / append / snapshot；
 * - 写权限与 BI-15.3 角色能力矩阵联动：write/append 前经 assertCapability(source, 'write')
 *   断言（deny-by-default）。矩阵禁写角色（scout/auditor）拒绝，放行角色
 *   （coordinator/reporter）通过；拒绝 reason 原样透传矩阵稳定原因码
 *   （"denied-by-matrix" / "unknown-role" / "unknown-capability"），可编程判断；
 * - 时钟注入：事实 ts 由注入 Clock 产生（不由调用方传入），测试确定性有保障。
 *
 * 语义约定（时间线底账）：
 * - 每键维护一条事实时间线；write = 覆盖（latest-wins，时间线重置为单条新事实）；
 * - append = 列表型事实追加（时间线末尾累积，逐条保留 source/ts，底账审计视图）；
 * - read = 返回该键最新一条事实；
 * - snapshot = key -> 时间线只读快照（防御性拷贝，prefix 按键名前缀过滤）；
 * - subscribe = 该键写事件通知：多订阅者、单订阅者异常隔离
 *   （不影响其他订阅者、不影响写入本身），返回退订函数。
 *
 * 分层声明：
 * - 本黑板服务于 BI-15 跨网 A2A 协作角色（A2aHost 派生面）的共享事实层；
 *   单机进程内子代理编排归 BI-07.3（已关单），两层互不复用、不混用。
 *
 * 零外部依赖；仅 import 本包 permissions（只许 import，不许改动）。
 */

import { assertCapability, type A2aRole } from "./permissions";

/** 注入时钟端口（测试可注入固定/递增时钟）。 */
export interface Clock {
  now(): number;
}

/** 零依赖 Json 值域（本包独立，不跨包引用 @bi/core）。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 黑板事实条目（ts 由注入时钟补齐）。 */
export interface BlackboardFact {
  value: JsonValue;
  source: A2aRole;
  ts: number;
}

/** write/append 入参事实（ts 由注入时钟补齐，不由调用方传入）。 */
export interface BlackboardFactInput {
  value: JsonValue;
  source: A2aRole;
}

/** 写事件（订阅通知载体；write/append 均通知）。 */
export interface BlackboardEvent {
  type: "write" | "append";
  key: string;
  fact: BlackboardFact;
}

/** 订阅回调。 */
export type BlackboardListener = (event: BlackboardEvent) => void;

/** 快照：key -> 事实时间线（write 覆盖、append 累积）。 */
export type BlackboardSnapshot = Map<string, readonly BlackboardFact[]>;

/**
 * 黑板写入拒绝（写权限与能力矩阵联动的稳定拒绝面）。
 * reason 原样透传 assertCapability 的稳定原因码：
 * "denied-by-matrix" / "unknown-role" / "unknown-capability"。
 */
export class BlackboardWriteDeniedError extends Error {
  readonly role: string;
  readonly capability: "write";
  readonly reason: string;

  constructor(role: string, reason: string) {
    super(`黑板写入被拒：role="${role}" capability="write" reason="${reason}"（deny-by-default 能力矩阵）`);
    this.name = "BlackboardWriteDeniedError";
    this.role = role;
    this.capability = "write";
    this.reason = reason;
  }
}

/** 每键事实时间线。 */
type Timeline = BlackboardFact[];

export class Blackboard {
  readonly #clock: Clock;
  readonly #facts = new Map<string, Timeline>();
  readonly #listeners = new Map<string, Set<BlackboardListener>>();

  constructor(opts?: { clock?: Clock }) {
    this.#clock = opts?.clock ?? { now: () => Date.now() };
  }

  /** 覆盖写（latest-wins）。写入前经能力矩阵断言 source 的 'write' 能力。 */
  write(key: string, fact: BlackboardFactInput): BlackboardFact {
    return this.#record(key, fact, "write");
  }

  /** 列表型事实追加（同样受 'write' 能力矩阵约束）。 */
  append(key: string, fact: BlackboardFactInput): BlackboardFact {
    return this.#record(key, fact, "append");
  }

  /** 读该键最新一条事实；未写键返回 undefined。 */
  read(key: string): BlackboardFact | undefined {
    const timeline = this.#facts.get(key);
    return timeline === undefined ? undefined : timeline[timeline.length - 1];
  }

  /**
   * 订阅该键写事件（write/append 均通知）。多订阅者彼此独立，
   * 单订阅者抛错被隔离（不传染、不影响写入本身）；返回退订函数。
   */
  subscribe(key: string, cb: BlackboardListener): () => void {
    let set = this.#listeners.get(key);
    if (set === undefined) {
      set = new Set<BlackboardListener>();
      this.#listeners.set(key, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  /** 快照：prefix 缺省取全量，否则按键名前缀过滤；时间线为防御性拷贝。 */
  snapshot(prefix?: string): BlackboardSnapshot {
    const out = new Map<string, readonly BlackboardFact[]>();
    for (const [key, timeline] of this.#facts) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue;
      out.set(key, [...timeline]);
    }
    return out;
  }

  #record(key: string, fact: BlackboardFactInput, type: "write" | "append"): BlackboardFact {
    const check = assertCapability(fact.source, "write");
    if (!check.ok) {
      throw new BlackboardWriteDeniedError(fact.source, check.reason ?? "denied-by-matrix");
    }
    const stamped: BlackboardFact = { value: fact.value, source: fact.source, ts: this.#clock.now() };
    let timeline = this.#facts.get(key);
    if (timeline === undefined) {
      timeline = [];
      this.#facts.set(key, timeline);
    }
    if (type === "write") {
      timeline.length = 0;
    }
    timeline.push(stamped);
    this.#notify(key, { type, key, fact: stamped });
    return stamped;
  }

  #notify(key: string, event: BlackboardEvent): void {
    const set = this.#listeners.get(key);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // 异常隔离：单订阅者异常不传染其他订阅者，也不影响写入本身。
      }
    }
  }
}
