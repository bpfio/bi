/**
 * BI-14.4 · 运行期高阶工作模式互斥协调器（EventBus 风格）。
 *
 * 接缝②（工单钉死）：'plan' 即 BI-14.2 已关单 PlanModeService 的状态——本卡
 * 只管运行期互斥协调，不重建 plan 的内部状态机；plan/swarm/tower/goal 在此
 * 仅作为互斥矩阵中的模式标识。
 *
 * 互斥矩阵（单 session 语义——互斥只作用于同一 sessionId，跨 session 互不
 * 干扰，多 session 同模式共存是常态）：
 *   plan / swarm / tower 三者两两互斥——enter 其一自动 force-exit 其余已激活者；
 *   goal × swarm 特例并存（蜂群自主攻坚组合）；
 *   goal 与 plan / tower 互斥。
 * 即：除 swarm×goal 这一无序兼容对外，任意两两互斥（isExclusive 派生自
 * COMPATIBLE 集合，矩阵未来调参只动一处）。
 *
 * 事件契约（监听器按注册序 FIFO 调用；监听器异常被隔离，不阻断协调器与后续
 * 监听器）：
 *   enter        —— { type:"enter", mode, sessionId }
 *   exit         —— { type:"exit", mode, sessionId, reason:"explicit"|"forced",
 *                   exitedBy? }（全部出口都走 exit 事件，reason 区分来源）
 *   forced-exit  —— { type:"forced-exit", mode, sessionId, exitedBy }（稽核
 *                   专道：仅互斥强退发出，exitedBy 即触发强退的进入模式）
 * 强退发射序：按 WORKFLOW_MODES 声明序逐个 exit→forced-exit，随后 enter——
 * 全程确定性。enter 亦在返回值 EnterResult.forcedExits 里同步带回稽核记录
 * （不依赖监听器也能审计）。
 *
 * 幂等与非法操作：重复 enter 同 session 同模式 → no-op（零事件，forcedExits
 * 空）；exit 未激活的 (mode, sessionId) → "not-active"；未知模式 →
 * "unknown-mode"；空 sessionId → "bad-session-id"。
 */

export type WorkflowMode = "plan" | "swarm" | "tower" | "goal";

/** 全部模式（canonical 声明序：强退扫描序与 activeModes 返回序）。 */
export const WORKFLOW_MODES: readonly WorkflowMode[] = [
  "plan",
  "swarm",
  "tower",
  "goal",
];

/** 兼容对（无序集合，键 = "a|b" 双向冗余）：swarm×goal 可并存，其余两两互斥。 */
const COMPATIBLE_PAIRS: ReadonlySet<string> = new Set(["swarm|goal", "goal|swarm"]);

/** 两模式是否互斥（单 session 语义；同模式不算互斥——幂等重入由 enter 吸收）。 */
export function isExclusive(a: WorkflowMode, b: WorkflowMode): boolean {
  return a !== b && !COMPATIBLE_PAIRS.has(`${a}|${b}`);
}

export type ModeEvent =
  | { type: "enter"; mode: WorkflowMode; sessionId: string }
  | {
      type: "exit";
      mode: WorkflowMode;
      sessionId: string;
      reason: "explicit" | "forced";
      exitedBy?: WorkflowMode;
    }
  | { type: "forced-exit"; mode: WorkflowMode; sessionId: string; exitedBy: WorkflowMode };

export type ModeEventType = ModeEvent["type"];

export type ModeListener = (event: ModeEvent) => void;

export interface ForcedExitRecord {
  /** 被强退的模式。 */
  mode: WorkflowMode;
  sessionId: string;
  /** 触发强退的进入模式（稽核字段，工单钉死 exitedBy）。 */
  exitedBy: WorkflowMode;
}

export interface EnterResult {
  mode: WorkflowMode;
  sessionId: string;
  /** 本次进入引发的互斥强退稽核记录（声明序）。 */
  forcedExits: ForcedExitRecord[];
}

/** 结构化互斥错误（判别方式：code 字段）。 */
export class ModeMutexError extends Error {
  readonly code: "unknown-mode" | "not-active" | "bad-session-id";

  constructor(code: "unknown-mode" | "not-active" | "bad-session-id", message: string) {
    super(message);
    this.name = "ModeMutexError";
    this.code = code;
  }
}

export class ModeMutexCoordinator {
  /** sessionId → 已激活模式集合（权威态）。 */
  readonly #active = new Map<string, Set<WorkflowMode>>();
  /** 事件类型 → 监听器（FIFO）。 */
  readonly #listeners = new Map<ModeEventType, ModeListener[]>();

  /** 订阅事件（FIFO 调用序）；返回退订函数。 */
  on(type: ModeEventType, listener: ModeListener): () => void {
    const list = this.#listeners.get(type);
    if (list === undefined) this.#listeners.set(type, [listener]);
    else list.push(listener);
    return () => this.off(type, listener);
  }

  /** 退订（未注册过则静默）。 */
  off(type: ModeEventType, listener: ModeListener): void {
    const list = this.#listeners.get(type);
    if (list === undefined) return;
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
  }

  /**
   * 进入模式：对同 session 内与之互斥的已激活模式逐个强退（exit[forced] +
   * forced-exit 稽核），随后激活并广播 enter。幂等：已激活同模式 → no-op。
   */
  enter(mode: WorkflowMode, sessionId: string): EnterResult {
    this.#assertMode(mode);
    this.#assertSession(sessionId);
    const set = this.#active.get(sessionId);
    if (set !== undefined && set.has(mode)) {
      return { mode, sessionId, forcedExits: [] }; // 幂等重入：零事件零强退
    }
    const forcedExits: ForcedExitRecord[] = [];
    for (const active of WORKFLOW_MODES) {
      if (set === undefined || !set.has(active) || !isExclusive(active, mode)) continue;
      set.delete(active);
      forcedExits.push({ mode: active, sessionId, exitedBy: mode });
      this.#emit({ type: "exit", mode: active, sessionId, reason: "forced", exitedBy: mode });
      this.#emit({ type: "forced-exit", mode: active, sessionId, exitedBy: mode });
    }
    const target = this.#active.get(sessionId) ?? new Set<WorkflowMode>();
    target.add(mode);
    this.#active.set(sessionId, target);
    this.#emit({ type: "enter", mode, sessionId });
    return { mode, sessionId, forcedExits };
  }

  /** 显式退出：激活集合移除并广播 exit（reason="explicit"）；未激活 → not-active。 */
  exit(mode: WorkflowMode, sessionId: string): void {
    this.#assertMode(mode);
    this.#assertSession(sessionId);
    const set = this.#active.get(sessionId);
    if (set === undefined || !set.has(mode)) {
      throw new ModeMutexError(
        "not-active",
        `session "${sessionId}" 未激活模式 "${mode}"，exit 非法`,
      );
    }
    set.delete(mode);
    if (set.size === 0) this.#active.delete(sessionId);
    this.#emit({ type: "exit", mode, sessionId, reason: "explicit" });
  }

  /** 某 session 当前激活模式（canonical 声明序；未激活任何 → 空数组）。 */
  activeModes(sessionId: string): WorkflowMode[] {
    const set = this.#active.get(sessionId);
    if (set === undefined) return [];
    return WORKFLOW_MODES.filter((m) => set.has(m));
  }

  #assertMode(mode: WorkflowMode): void {
    if (!WORKFLOW_MODES.includes(mode)) {
      throw new ModeMutexError("unknown-mode", `未知工作模式 "${String(mode)}"`);
    }
  }

  #assertSession(sessionId: string): void {
    if (sessionId.length === 0) {
      throw new ModeMutexError("bad-session-id", "sessionId 不可为空");
    }
  }

  /** FIFO 发射 + 监听器异常隔离（单监听器抛错不影响协调器与后续监听器）。 */
  #emit(event: ModeEvent): void {
    const list = this.#listeners.get(event.type);
    if (list === undefined) return;
    for (const listener of [...list]) {
      try {
        listener(event);
      } catch {
        // 隔离：监听器异常不外溢（稽核通道自身健壮优先）
      }
    }
  }
}
