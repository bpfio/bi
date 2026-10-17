/**
 * 会话状态空间正规化与不变量防竞态矩阵（BI-03.3，差异工单）。
 *
 * 状态空间 = RunPhase × ActiveWork × QueueAuthority 的笛卡尔积（5×3×2=30 格），
 * 每格 × 每动作在矩阵中有确定裁决（无 undefined 格）；三条核心不变量以卡面原句备案，
 * 作为横切否决/保底规则叠加在基础转移表之上。
 *
 * RunPhase 与 BI-07 agent.ts 6 态（idle/thinking/tool-executing/paused/settling/exit）
 * 的对齐关系（本卡视角子集）：
 *  - idle / thinking / tool-executing：与 agent.ts 同名同义，直接对齐；
 *  - compacting / verifying：agent.ts 收尾段 settling 在会话域的两个细分视角
 *    （压缩收尾 / 验证收尾）；
 *  - paused / exit：回合控制态与绝对终态，归属 BI-07 回合状态机，不入本卡矩阵。
 *
 * 不变量（卡面原句备案，见 Invariants.list[*].doc）：
 *  - inv_noCompactDuringSubagent：activeWork=subagent 时 compact 动作拒绝；
 *  - inv_noForkMidStream：thinking/tool-executing 中 fork 拒绝；
 *  - inv_userAuthorityPreempt：queueAuthority=user 时 cancel 恒允许。
 *
 * 设计决策（防竞态最小面）：
 *  - 基础表只锁「相位忙碌度」：thinking/tool-executing/compacting 期间仅放行 cancel；
 *  - 卡面不变量只锁 subagent 场景的 compact；workflow 场景的压缩管控归属 BI-07，不在本卡放大；
 *  - cancel 在基础表全态放行，inv_userAuthorityPreempt 作为保底（guarantee）再兜一层：
 *    即便未来基础表收紧，用户队列权威下的 cancel 也不可被矩阵拒绝。
 */

/** 运行相位（对齐关系见模块 doc）。 */
export type RunPhase =
  | "idle"
  | "thinking"
  | "tool-executing"
  | "compacting"
  | "verifying";

export const RUN_PHASES: readonly RunPhase[] = [
  "idle",
  "thinking",
  "tool-executing",
  "compacting",
  "verifying",
];

/** 并行工作负载维度。 */
export type ActiveWork = "none" | "subagent" | "workflow";

export const ACTIVE_WORKS: readonly ActiveWork[] = ["none", "subagent", "workflow"];

/** 队列权威维度：user = 用户输入享有抢占权威。 */
export type QueueAuthority = "user" | "agent";

export const QUEUE_AUTHORITIES: readonly QueueAuthority[] = ["user", "agent"];

/** 正规化状态：三维笛卡尔积的一格。 */
export interface MatrixState {
  phase: RunPhase;
  activeWork: ActiveWork;
  queueAuthority: QueueAuthority;
}

/** 本卡视角的会话级动作（防竞态争用面）。 */
export type MatrixAction = "compact" | "fork" | "cancel";

export const MATRIX_ACTIONS: readonly MatrixAction[] = ["compact", "fork", "cancel"];

/** 裁决结果：allowed=false 时必带可诊断 reason（含不变量 id）。 */
export interface ActionVerdict {
  allowed: boolean;
  reason?: string;
}

/** 基础转移表（相位 × 动作）；activeWork/queueAuthority 由不变量层横切。 */
const BASE_ALLOWED: Readonly<Record<RunPhase, readonly MatrixAction[]>> = {
  idle: ["compact", "fork", "cancel"],
  thinking: ["cancel"],
  "tool-executing": ["cancel"],
  compacting: ["cancel"],
  verifying: ["compact", "fork", "cancel"],
};

/* ---------------------------------- 不变量 ---------------------------------- */

/**
 * 不变量条目：veto 型（非空即否决）或 guarantee 型（true 即强制放行）。
 * doc 字段为卡面原句备案。
 */
export interface InvariantCheck {
  id: string;
  /** 卡面原句。 */
  doc: string;
  kind: "veto" | "guarantee";
  /** kind='veto'：返回非空字符串 = 该 (state, action) 被否决。 */
  veto?(state: MatrixState, action: MatrixAction): string | null;
  /** kind='guarantee'：返回 true = 即便基础矩阵拒绝也强制放行。 */
  forcesAllow?(state: MatrixState, action: MatrixAction): boolean;
}

/** 卡面原句：activeWork=subagent 时 compact 动作拒绝。 */
const inv_noCompactDuringSubagent: InvariantCheck = {
  id: "inv_noCompactDuringSubagent",
  doc: "activeWork=subagent 时 compact 动作拒绝",
  kind: "veto",
  veto(state, action) {
    if (action === "compact" && state.activeWork === "subagent") {
      return "inv_noCompactDuringSubagent: 子代理运行中禁止压缩（丢上下文竞态）";
    }
    return null;
  },
};

/** 卡面原句：thinking/tool-executing 中 fork 拒绝。 */
const inv_noForkMidStream: InvariantCheck = {
  id: "inv_noForkMidStream",
  doc: "thinking/tool-executing 中 fork 拒绝",
  kind: "veto",
  veto(state, action) {
    if (action === "fork" && (state.phase === "thinking" || state.phase === "tool-executing")) {
      return `inv_noForkMidStream: ${state.phase} 为模型流中段，fork 拒绝（分叉点不一致竞态）`;
    }
    return null;
  },
};

/** 卡面原句：queueAuthority=user 时 cancel 恒允许。 */
const inv_userAuthorityPreempt: InvariantCheck = {
  id: "inv_userAuthorityPreempt",
  doc: "queueAuthority=user 时 cancel 恒允许",
  kind: "guarantee",
  forcesAllow(state, action) {
    return action === "cancel" && state.queueAuthority === "user";
  },
};

/** 不变量注册表与静态组合检查。 */
export const Invariants: {
  readonly list: readonly InvariantCheck[];
  /** 违反的否决型不变量 id 清单（空数组 = 无否决）。 */
  checkAll(state: MatrixState, action: MatrixAction): string[];
  /** 是否存在保底型不变量强制放行。 */
  forcesAllow(state: MatrixState, action: MatrixAction): boolean;
} = {
  list: [inv_noCompactDuringSubagent, inv_noForkMidStream, inv_userAuthorityPreempt],
  checkAll(state, action) {
    const violated: string[] = [];
    for (const invariant of this.list) {
      if (invariant.kind !== "veto" || invariant.veto === undefined) continue;
      if (invariant.veto(state, action) !== null) violated.push(invariant.id);
    }
    return violated;
  },
  forcesAllow(state, action) {
    return this.list.some(
      (invariant) =>
        invariant.kind === "guarantee" &&
        invariant.forcesAllow !== undefined &&
        invariant.forcesAllow(state, action),
    );
  },
};

/* ---------------------------------- 矩阵 ---------------------------------- */

/** 违反状态矩阵的结构化错误（action/to/from/reason 全量可诊断）。 */
export class StateMatrixViolationError extends Error {
  readonly from: MatrixState;
  readonly action: MatrixAction;
  readonly to: MatrixState;
  readonly reason: string;

  constructor(from: MatrixState, action: MatrixAction, to: MatrixState, reason: string) {
    super(`状态矩阵违规: ${fmtState(from)} --${action}--> ${fmtState(to)}（${reason}）`);
    this.name = "StateMatrixViolationError";
    this.from = from;
    this.action = action;
    this.to = to;
    this.reason = reason;
  }
}

function fmtState(state: MatrixState): string {
  return `${state.phase}/${state.activeWork}/${state.queueAuthority}`;
}

function statesEqual(a: MatrixState, b: MatrixState): boolean {
  return a.phase === b.phase && a.activeWork === b.activeWork && a.queueAuthority === b.queueAuthority;
}

function assertWellFormed(state: MatrixState): void {
  if (!RUN_PHASES.includes(state.phase)) {
    throw new TypeError(`非法 phase: ${JSON.stringify(state.phase)}`);
  }
  if (!ACTIVE_WORKS.includes(state.activeWork)) {
    throw new TypeError(`非法 activeWork: ${JSON.stringify(state.activeWork)}`);
  }
  if (!QUEUE_AUTHORITIES.includes(state.queueAuthority)) {
    throw new TypeError(`非法 queueAuthority: ${JSON.stringify(state.queueAuthority)}`);
  }
}

/** 规范目标态：动作执行后的确定落点（cancel 清运行态、不动队列权威；fork 不改本会话状态）。 */
function canonicalTarget(from: MatrixState, action: MatrixAction): MatrixState {
  switch (action) {
    case "compact":
      return { ...from, phase: "compacting" };
    case "fork":
      return { ...from };
    case "cancel":
      return { ...from, phase: "idle", activeWork: "none" };
  }
}

/**
 * 会话状态矩阵：30 格 × 3 动作全定义（穷举可证），不变量横切。
 */
export class StateMatrix {
  /** 单格裁决：基础表 ∧ 否决型不变量 ∨ 保底型不变量。 */
  verdict(from: MatrixState, action: MatrixAction): ActionVerdict {
    assertWellFormed(from);
    const violations = Invariants.checkAll(from, action);
    if (violations.length > 0) {
      return { allowed: false, reason: violations.join("；") };
    }
    const baseAllowed = BASE_ALLOWED[from.phase].includes(action);
    if (!baseAllowed && !Invariants.forcesAllow(from, action)) {
      return {
        allowed: false,
        reason: `matrix: 基础表不允许 ${fmtState(from)} 执行 ${action}`,
      };
    }
    return { allowed: true };
  }

  /** 某状态下全部允许动作（与 verdict 一致性由实现保证）。 */
  allowedActions(state: MatrixState): MatrixAction[] {
    return MATRIX_ACTIONS.filter((action) => this.verdict(state, action).allowed);
  }

  /** 规范目标态（不校验合法性；与 assertTransition 使用同一落点语义）。 */
  transitionTarget(from: MatrixState, action: MatrixAction): MatrixState {
    assertWellFormed(from);
    return canonicalTarget(from, action);
  }

  /**
   * 断言一次转移合法：(from, action) 必须被矩阵放行，且 to 必须等于规范目标态；
   * 任何违反即抛 StateMatrixViolationError，绝不静默放行。
   */
  assertTransition(from: MatrixState, action: MatrixAction, to: MatrixState): void {
    assertWellFormed(from);
    assertWellFormed(to);
    const verdict = this.verdict(from, action);
    if (!verdict.allowed) {
      throw new StateMatrixViolationError(from, action, to, verdict.reason ?? "denied");
    }
    const target = canonicalTarget(from, action);
    if (!statesEqual(target, to)) {
      throw new StateMatrixViolationError(
        from,
        action,
        to,
        `非法目标状态: 规范落点应为 ${fmtState(target)}`,
      );
    }
  }
}
