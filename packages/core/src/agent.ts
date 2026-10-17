/**
 * BI-07 · 多工具并行流水线与二段式抢占取消状态机（总装）。
 *
 * 吸收 Kimi Code 细粒度读写锁（RWLock）调度矩阵：
 * - 只读工具（名单注入）无路径重叠 → `Promise.all` 并行（读-读共享锁）；
 * - 写类工具按路径重叠（fileAccessesOverlap：路径集合相交判定）串行分组——
 *   同组顺序执行、组间并行；读写同路径互斥（读-写/写-写排他锁）；
 * - 未声明路径的写类调用视同"触碰一切"，与段内所有写类调用合并为一条串行链
 *   （保守从紧，宁慢勿脏）；
 * - 全局屏障类工具（名单注入）独占一轮：屏障前的分组全部落定后，屏障调用
 *   独自执行，之后的调用才继续（内存屏障语义）；
 * - 结果恒按调用序返回（results 数组按原下标回填）。
 *
 * 二段式抢占取消（工单钉死）：
 * - 第一段（单击 Esc/Ctrl+C）：running（tool-executing/settling/thinking）→ paused，
 *   保留上下文；tool-executing 中的第一段取消必须**等在飞工具 settle（协作式
 *   AbortSignal 取消）才进 paused**——状态机不变式，绝不半途丢弃在飞结果；
 *   单段后 resume() 回 thinking 续跑；
 * - 第二段：cancelWindowMs（默认 800ms，可配）内连续两次 → 退出到 exit 终态；
 *   窗口外的再次单击仍按第一段处理；
 * - exit 为绝对终态（房规同 14.5：无任何出边）。
 *
 * 状态机（显式转移表 + assertTransition，房规同 BI-14.5 task-state）：
 *
 *   idle ──▶ thinking ──▶ tool-executing ──▶ thinking（工具批落定回环）
 *                │  ▲            │  ▲
 *                │  └─resume─────┘  │
 *                ▼                  ▼
 *             paused ◀──────── settling（thinking 直落 / 工具后收尾）
 *                │                  │
 *                └──────▶ exit ◀────┘（二段取消，绝对终态）
 *
 * 集成点（全部注入端口，不硬编码）：
 * - BI-07.2 ReadFileStateMap：经 WriteGatePort（readFileStateWriteGate 适配器）
 *   做写前 Read-Before-Write/mtime 防脏写校验，拒绝即短路该调用；
 * - BI-07.13 ToolDedupe/RepeatBreaker：执行前检查——tier 3 block 直接短路
 *   （硬门），只读重复调用直接回放缓存结果；执行钩子固定序：
 *   repeatBreaker.observe → dedupe.check → writeGate.assertWritable →
 *   execute → dedupe.recordResult；
 * - BI-06.6 file-mutation-queue：写类调用（有声明路径时）经
 *   withFileMutationQueue 以首路径入队，作为分组调度之下的串行底层保险；
 * - BI-06.3 ToolTimeoutPolicy.withDeadline：注入时在飞工具经其协作取消语义
 *   执行（外部取消信号透传，到点结构化超时）。
 */
import { resolve as resolvePath } from "node:path";
import { systemClock, type Clock } from "./guard/deadline";
import { ToolTimeoutPolicy } from "./guard/timeout-policy";
import { withFileMutationQueue } from "./tools/file-mutation-queue";
import { ReadFileStateMap, type FileStat } from "./tool/read-file-state";
import type { RepeatBreaker, RepeatVerdict, ToolDedupe } from "./tool/tool-dedupe";

/* ------------------------------------------------------------------ */
/* 房规 14.5：显式转移表 + assertTransition                              */
/* ------------------------------------------------------------------ */

/** Agent 回合状态。 */
export type AgentTurnState =
  | "idle"
  | "thinking"
  | "tool-executing"
  | "paused"
  | "settling"
  | "exit";

/** 全部状态枚举（穷举测试用）。 */
export const AGENT_TURN_STATES: readonly AgentTurnState[] = [
  "idle",
  "thinking",
  "tool-executing",
  "paused",
  "settling",
  "exit",
];

/**
 * 转移表常量：每态列出合法去向；不在表内的 (from, to) 即非法转移。
 * exit 为绝对终态（空数组）。settling → thinking 支持收尾后无缝续转。
 */
export const AGENT_TURN_TRANSITIONS: Readonly<
  Record<AgentTurnState, readonly AgentTurnState[]>
> = {
  idle: ["thinking"],
  thinking: ["tool-executing", "settling", "paused"],
  "tool-executing": ["thinking", "paused", "exit"],
  paused: ["thinking", "exit"],
  settling: ["idle", "thinking", "paused", "exit"],
  exit: [],
};

/** 非法转移的结构化错误（判别方式：instanceof 或 code === "invalid-transition"）。 */
export class InvalidTransitionError extends Error {
  readonly code = "invalid-transition" as const;
  readonly from: AgentTurnState;
  readonly to: AgentTurnState;

  constructor(from: AgentTurnState, to: AgentTurnState) {
    super(`invalid transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** 校验一次状态转移合法性；非法即抛 InvalidTransitionError，绝不静默放行。 */
export function assertTransition(from: AgentTurnState, to: AgentTurnState): void {
  if (!AGENT_TURN_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/* ------------------------------------------------------------------ */
/* 工具调用/结果与端口类型                                               */
/* ------------------------------------------------------------------ */

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolResult {
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  /** 成功时的执行结果（含只读缓存回放）。 */
  readonly value?: unknown;
  /** 失败原因（执行异常 / 门禁拒绝 / 打断话术）。 */
  readonly error?: string;
  /** 因取消而未执行或被中断。 */
  readonly cancelled?: boolean;
  /** 只读重复调用，结果来自 BI-07.13 缓存回放。 */
  readonly deduped?: boolean;
  /** 被 RepeatBreaker 阶 3 硬阻断。 */
  readonly blocked?: boolean;
  /** 被 BI-07.2 写前门禁拒绝。 */
  readonly denied?: boolean;
  /** RepeatBreaker 裁决（含阶 1/2 软话术与阶 3 硬话术）。 */
  readonly breakerVerdict?: RepeatVerdict;
}

/** 工具执行体：接收协作取消信号，应监听 abort 自行收尾。 */
export type ToolExecutor = (call: ToolCall, signal: AbortSignal) => Promise<unknown> | unknown;

/**
 * BI-07.2 写前校验端口：返回拒绝原因字符串；null/undefined = 放行。
 * 用 readFileStateWriteGate 把 ReadFileStateMap + stat 函数装配成本端口。
 */
export interface WriteGatePort {
  assertWritable(call: ToolCall, paths: readonly string[]): string | null | Promise<string | null>;
}

/**
 * 把 ReadFileStateMap 与注入 stat 函数装配成 WriteGatePort：
 * 逐路径 assertCleanForWrite，首个拒绝原因即返回（"reason: path"）。
 */
export function readFileStateWriteGate(
  map: ReadFileStateMap,
  statFn: (path: string) => FileStat | Promise<FileStat>,
): WriteGatePort {
  return {
    async assertWritable(_call: ToolCall, paths: readonly string[]): Promise<string | null> {
      for (const path of paths) {
        const current = await statFn(path);
        const verdict = map.assertCleanForWrite(path, current);
        if (!verdict.allowed) return `${verdict.reason}: ${path}`;
      }
      return null;
    },
  };
}

export interface AgentLoopOptions {
  /** 工具执行体（唯一必填端口；fs/mcp 等具体工具由装配层提供）。 */
  readonly execute: ToolExecutor;
  /** 只读工具名单（RWLock 读锁语义 + dedupe 缓存资格；缺省空集→全部按写类串行）。 */
  readonly readOnlyTools?: ReadonlySet<string>;
  /** 全局屏障工具名单（缺省空集）。 */
  readonly barrierTools?: ReadonlySet<string>;
  /** 声明一次调用将触碰的路径集合（重叠判定 + 写前门禁的输入；缺省无路径）。 */
  readonly fileAccesses?: (call: ToolCall) => readonly string[];
  /** BI-07.2 写前门禁端口（缺省不校验）。 */
  readonly writeGate?: WriteGatePort;
  /** BI-07.13 排重器（缺省不排重）。 */
  readonly dedupe?: Pick<ToolDedupe, "check" | "recordResult">;
  /** BI-07.13 循环打断门（缺省不打断）。 */
  readonly repeatBreaker?: Pick<RepeatBreaker, "observe">;
  /** BI-06.3 工具限时看门狗（缺省不限时，仅协作取消）。 */
  readonly timeoutPolicy?: ToolTimeoutPolicy;
  /** 注入时钟（取消窗口计时；默认系统时钟）。 */
  readonly clock?: Clock;
  /** 二段取消判定窗口（毫秒，默认 800）。 */
  readonly cancelWindowMs?: number;
  /** 状态转移观测（测试/遥测用）。 */
  readonly onTransition?: (from: AgentTurnState, to: AgentTurnState) => void;
}

/** cancelRequest 的结构化裁决。 */
export interface CancelOutcome {
  /** 第几次按下（窗口判定后的归属段）。 */
  readonly stage: 1 | 2;
  /** paused=第一段暂停；exit=第二段退出；already-paused=窗口外重复单击；noop=无可取消。 */
  readonly action: "paused" | "exit" | "already-paused" | "noop";
}

/* ------------------------------------------------------------------ */
/* 路径重叠判定                                                         */
/* ------------------------------------------------------------------ */

/**
 * 路径集合相交判定（RWLock 冲突边）。比较前经 path.resolve 归一化——
 * 同一物理文件的相对/绝对/含 `..` 写法判定为重叠。
 */
export function fileAccessesOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const left = new Set(a.map((p) => resolvePath(p)));
  return b.some((p) => left.has(resolvePath(p)));
}

/* ------------------------------------------------------------------ */
/* 调度段与分组                                                         */
/* ------------------------------------------------------------------ */

interface SegmentItem {
  readonly call: ToolCall;
  readonly index: number;
  readonly isReadOnly: boolean;
  readonly paths: readonly string[];
}

type Segment =
  | { readonly kind: "barrier"; readonly item: SegmentItem }
  | { readonly kind: "batch"; readonly items: readonly SegmentItem[] };

const CANCELLED_ERROR = "cancelled";

/* ------------------------------------------------------------------ */
/* AgentLoop                                                           */
/* ------------------------------------------------------------------ */

export class AgentLoop {
  readonly #options: AgentLoopOptions;
  readonly #clock: Clock;
  readonly #cancelWindowMs: number;
  #state: AgentTurnState = "idle";
  #batchController: AbortController | undefined;
  #lastCancelAt: number | undefined;
  /** 第一段取消已在等待在飞工具落定的标记（executeTools finally 让位）。 */
  #cancelSettling = false;
  #inFlight = 0;
  #settleWaiters: Array<() => void> = [];

  constructor(options: AgentLoopOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#cancelWindowMs = Math.max(0, options.cancelWindowMs ?? 800);
  }

  /** 当前回合状态（只读观测）。 */
  get state(): AgentTurnState {
    return this.#state;
  }

  /** 当前批次取消信号（无批次时 undefined；测试/装配层观测协作取消用）。 */
  get signal(): AbortSignal | undefined {
    return this.#batchController?.signal;
  }

  /** 开启新回合：idle → thinking。 */
  beginTurn(): void {
    this.#transition("thinking");
    this.#lastCancelAt = undefined;
  }

  /** 收束回合：thinking → settling → idle（同步两步，收尾无在飞 IO）。 */
  finishTurn(): void {
    this.#transition("settling");
    this.#transition("idle");
  }

  /** 进入收尾相：thinking → settling（模型已产出最终文本，可被二段取消打断）。 */
  beginSettle(): void {
    this.#transition("settling");
  }

  /** 单段暂停后续跑：paused → thinking。 */
  resume(): void {
    this.#transition("thinking");
    this.#lastCancelAt = undefined;
  }

  /**
   * 多工具并行流水线：必须从 thinking 态进入（thinking → tool-executing）。
   * 分段调度见模块头注释；结果按调用序返回。取消落定后停在 paused/exit，
   * 本方法不再回写 thinking（让位给取消路径的状态迁移）。
   */
  async executeTools(calls: readonly ToolCall[]): Promise<ToolResult[]> {
    this.#transition("tool-executing");
    const controller = new AbortController();
    this.#batchController = controller;
    const results: ToolResult[] = new Array(calls.length);
    try {
      for (const segment of this.#segments(calls)) {
        if (controller.signal.aborted) {
          // 屏障之后/段间取消：整段不再派发，记为已取消。
          const rest = segment.kind === "barrier" ? [segment.item] : segment.items;
          for (const item of rest) results[item.index] = cancelledResult(item.call);
          continue;
        }
        if (segment.kind === "barrier") {
          results[segment.item.index] = await this.#executeCall(segment.item, controller.signal);
        } else {
          const groups = this.#conflictGroups(segment.items);
          await Promise.all(
            groups.map((members) => this.#runGroupSerially(members, controller.signal, results)),
          );
        }
      }
    } finally {
      this.#batchController = undefined;
      // 第一段取消正在等落定：状态迁移让位给 cancelRequest（不变式）。
      if (this.#state === "tool-executing" && !this.#cancelSettling) {
        this.#transition("thinking");
      }
    }
    return results;
  }

  /**
   * 二段式抢占取消（见模块头注释）。异步返回：tool-executing 中的取消
   * 会先 abort 协作信号、等在飞工具全部 settle 后才迁移状态并 resolve。
   */
  async cancelRequest(): Promise<CancelOutcome> {
    const state = this.#state;
    if (state === "idle" || state === "exit") {
      return { stage: this.#lastCancelAt !== undefined ? 2 : 1, action: "noop" };
    }
    const now = this.#clock.now();
    const withinWindow =
      this.#lastCancelAt !== undefined && now - this.#lastCancelAt <= this.#cancelWindowMs;
    this.#lastCancelAt = now;

    if (!withinWindow) {
      // 第一段：running → paused
      if (state === "tool-executing") {
        this.#cancelSettling = true;
        try {
          this.#batchController?.abort();
          await this.#awaitSettled();
          if (this.#state === "tool-executing") this.#transition("paused");
        } finally {
          this.#cancelSettling = false;
        }
        return { stage: 1, action: "paused" };
      }
      if (state === "thinking" || state === "settling") {
        this.#transition("paused");
        return { stage: 1, action: "paused" };
      }
      // paused 且窗口已过期：仍是第一段语义，停留 paused。
      return { stage: 1, action: "already-paused" };
    }

    // 第二段：paused/settling/tool-executing → exit 终态
    if (this.#state === "tool-executing") {
      this.#cancelSettling = true;
      try {
        this.#batchController?.abort();
        await this.#awaitSettled();
      } finally {
        this.#cancelSettling = false;
      }
    }
    if (this.#state !== "exit") this.#transition("exit");
    return { stage: 2, action: "exit" };
  }

  /* ---------------- 内部：转移与在飞落定 ---------------- */

  #transition(to: AgentTurnState): void {
    const from = this.#state;
    assertTransition(from, to);
    this.#state = to;
    this.#options.onTransition?.(from, to);
  }

  #awaitSettled(): Promise<void> {
    if (this.#inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#settleWaiters.push(resolve);
    });
  }

  #flushSettleWaiters(): void {
    if (this.#inFlight > 0) return;
    const waiters = this.#settleWaiters;
    this.#settleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /* ---------------- 内部：分段与分组 ---------------- */

  #segments(calls: readonly ToolCall[]): Segment[] {
    const segments: Segment[] = [];
    let batch: SegmentItem[] = [];
    const flush = (): void => {
      if (batch.length > 0) {
        segments.push({ kind: "batch", items: batch });
        batch = [];
      }
    };
    calls.forEach((call, index) => {
      const isReadOnly = this.#options.readOnlyTools?.has(call.name) ?? false;
      const paths = this.#options.fileAccesses?.(call) ?? [];
      const item: SegmentItem = { call, index, isReadOnly, paths };
      if (this.#options.barrierTools?.has(call.name)) {
        flush();
        segments.push({ kind: "barrier", item });
      } else {
        batch.push(item);
      }
    });
    flush();
    return segments;
  }

  /**
   * 冲突分组（并查集）：冲突边 = 两调用至少一个是写类，且（任一路径未知
   * 或路径集合相交）。读-读永不互斥。组内按调用序串行，组间并行。
   */
  #conflictGroups(items: readonly SegmentItem[]): SegmentItem[][] {
    const parent = items.map((_, i) => i);
    const find = (x0: number): number => {
      // 路径减半压缩：parent[x] ← parent[parent[x]]。
      let x = x0;
      for (;;) {
        const p = parent[x]!;
        if (p === x) return x;
        const grand = parent[p]!;
        parent[x] = grand;
        x = grand;
      }
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    const unknownPaths = (item: SegmentItem): boolean => !item.isReadOnly && item.paths.length === 0;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        const writeInvolved = !a.isReadOnly || !b.isReadOnly;
        if (!writeInvolved) continue;
        if (unknownPaths(a) || unknownPaths(b) || fileAccessesOverlap(a.paths, b.paths)) {
          union(i, j);
        }
      }
    }
    const groups = new Map<number, SegmentItem[]>();
    items.forEach((item, i) => {
      const root = find(i);
      const group = groups.get(root);
      if (group === undefined) groups.set(root, [item]);
      else group.push(item);
    });
    return [...groups.values()];
  }

  async #runGroupSerially(
    members: readonly SegmentItem[],
    signal: AbortSignal,
    results: ToolResult[],
  ): Promise<void> {
    for (const item of members) {
      if (signal.aborted) {
        results[item.index] = cancelledResult(item.call);
        continue;
      }
      results[item.index] = await this.#executeCall(item, signal);
    }
  }

  /* ---------------- 内部：单调用执行管线（钩子固定序） ---------------- */

  async #executeCall(item: SegmentItem, batchSignal: AbortSignal): Promise<ToolResult> {
    const { call } = item;
    const base = { id: call.id, name: call.name };

    // ① BI-07.13 循环打断门（硬门）：tier 3 短路，不执行、不进排重窗。
    const breakerVerdict = this.#options.repeatBreaker?.observe(call.name, call.args);
    if (breakerVerdict !== undefined && breakerVerdict.tier === 3) {
      return {
        ...base,
        ok: false,
        blocked: true,
        error: breakerVerdict.message,
        breakerVerdict,
      };
    }

    // ② BI-07.13 排重：只读窗口内重复 → 回放缓存结果，不执行。
    const dedupeVerdict = this.#options.dedupe?.check(call.name, call.args);
    if (dedupeVerdict !== undefined && dedupeVerdict.duplicate) {
      return {
        ...base,
        ok: true,
        value: dedupeVerdict.cachedResult,
        deduped: true,
        breakerVerdict,
      };
    }

    // ③ BI-07.2 写前门禁：写类调用逐路径 Read-Before-Write / mtime 校验。
    if (!item.isReadOnly && item.paths.length > 0 && this.#options.writeGate !== undefined) {
      const denial = await this.#options.writeGate.assertWritable(call, item.paths);
      if (denial !== null && denial !== undefined) {
        return { ...base, ok: false, denied: true, error: denial, breakerVerdict };
      }
    }

    // ④ 执行：file-mutation-queue（写串行底层）外包 → withDeadline（协作取消）内包。
    const primaryPath = !item.isReadOnly && item.paths.length > 0 ? item.paths[0] : undefined;
    const run = (): Promise<unknown> => {
      const outcome = this.#options.timeoutPolicy
        ? this.#options.timeoutPolicy.withDeadline(
            call.name,
            (deadlineSignal) => this.#options.execute(call, deadlineSignal),
            { signal: batchSignal },
          )
        : this.#options.execute(call, batchSignal);
      return Promise.resolve(outcome);
    };
    this.#inFlight += 1;
    try {
      const value = await (primaryPath !== undefined
        ? withFileMutationQueue(primaryPath, run)
        : run());
      this.#options.dedupe?.recordResult(call.name, call.args, value);
      return { ...base, ok: true, value, breakerVerdict };
    } catch (err) {
      const cancelled = batchSignal.aborted;
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        ok: false,
        cancelled,
        error: cancelled ? (message === "" ? CANCELLED_ERROR : message) : message,
        breakerVerdict,
      };
    } finally {
      this.#inFlight -= 1;
      this.#flushSettleWaiters();
    }
  }
}

function cancelledResult(call: ToolCall): ToolResult {
  return { id: call.id, name: call.name, ok: false, cancelled: true, error: CANCELLED_ERROR };
}
