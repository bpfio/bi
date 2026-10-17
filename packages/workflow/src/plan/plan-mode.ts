/**
 * BI-14.2 · Plan 模式只读规划与用户审批门禁（PlanModeService）——纯内存状态机，零 IO、零 TUI。
 *
 * 接缝②（AUDIT-10 钉死的正主）：BI-20.1 的 `plan` 即本实现，`/mode` 仅是表面
 * 入口——TUI 侧只做交互呈现与按键回路，规划生命周期、只读降权与审批转移全部
 * 收敛在本服务与同目录的 ExitReviewGate；BI-14.4 互斥协调器将来把本服务的
 * planning 态注册进互斥矩阵。
 *
 * 状态机（显式、单向、每步转移可测）：
 *
 *   idle ── enter ──▶ planning ── submitPlan(合法) ──▶ awaiting-review
 *                       ▲                                  │
 *                       └──────── exit(rejected) ──────────┘
 *                                                          │ exit(approved)
 *                                                          ▼
 *                                                      executing（终态）
 *
 * - executing 为终态：新一轮规划由调用方新建服务实例（会话维度状态归属调用方
 *   编排），本实例不提供 executing → planning 的循环边。
 * - 非法转移一律结构化报错（PlanModeError），绝不静默吞掉：
 *   idle/executing 下 submitPlan/exit → plan-not-active；
 *   planning 下 exit → must-submit-plan（工单钉死码）；
 *   awaiting-review 下再 submitPlan → plan-already-pending（工单钉死码）；
 *   活跃会话期异 sessionId 再 enter → plan-session-active。
 *
 * 进入即物理降权：enter 成功后本服务处于降权态（planning / awaiting-review），
 * gate(tool, args) 全量委托注入的 PlanToolPolicy（读工具白名单语义由组装方
 * 提供，本卡不硬编码任何工具名）；非只读 → 结构化拒绝
 * { allowed: false, reason: "plan-mode-readonly" }，供模型自愈改道。
 *
 * 语义裁定（钉死，供主控复核）：
 * 1. gate 的管辖域 = Plan 模式激活期（planning / awaiting-review）。idle 与
 *    executing 下 Plan 模式未生效，gate 放行 { allowed: true }——写权限恢复由
 *    调用方根据状态切换（工单原义），本服务只表达"Plan 降权"这一层，不越权
 *    代理完整权限体系（那是 BI-06.5 PermissionGate 的职责）。
 * 2. 必填校验仅 changeFiles（非空数组）与 design（trim 后非空）两项——工单
 *    钉死；title / risks / createdAt 不做强校验（门禁不越权代拟内容标准）。
 * 3. PlanDocument.createdAt 由调用方声明（epoch 毫秒），服务原样保留；权威
 *    时间线以服务注入时钟落盘的 PlanVersion.submittedAt / reviewedAt 为准，
 *    不信任模型自报时间戳（与 BI-06.5"请求透传快照不作权威源"同一哲学）。
 * 4. 版本史（versions）：submitPlan 即追加一条 pending-review 版本；exit 裁决
 *   原地整体替换该版本状态（approved / rejected + feedback），历史只追加不改写、
 *   不删除——rejected 轮的 feedback 永久留痕。
 */

/** 规范化计划文档（模型在 Plan 模式下的结构化产出物）。 */
export interface PlanDocument {
  /** 计划标题（门禁不强校验，可空）。 */
  readonly title: string;
  /** 变更文件列表（必填：非空数组）。 */
  readonly changeFiles: readonly string[];
  /** 设计逻辑（必填：trim 后非空）。 */
  readonly design: string;
  /** 风险评估（门禁不强校验，可为空数组）。 */
  readonly risks: readonly string[];
  /** 声明性创建时刻（epoch 毫秒，调用方给出；服务侧权威时间见 PlanVersion.submittedAt）。 */
  readonly createdAt: number;
}

/** Plan 模式状态机的四个显式状态。 */
export type PlanModeStatus = "idle" | "planning" | "awaiting-review" | "executing";

/** 单个版本的生命周期状态：已提交待审 → 审批通过 / 审批驳回。 */
export type PlanVersionStatus = "pending-review" | "approved" | "rejected";

/** 一轮提交的计划版本快照（不可变；裁决以整体替换方式更新）。 */
export interface PlanVersion {
  /** 版本号：1 起算，每次 submitPlan 递增 1。 */
  readonly version: number;
  /** 本轮提交的计划文档原样快照。 */
  readonly doc: PlanDocument;
  /** 服务侧权威提交时刻（注入时钟的 epoch 毫秒）。 */
  readonly submittedAt: number;
  /** 当前生命周期状态。 */
  readonly status: PlanVersionStatus;
  /** 裁决时刻（epoch 毫秒）；仅已裁决（approved/rejected）的版本携带。 */
  readonly reviewedAt?: number;
  /**
   * 裁决反馈原文：rejected 时用户修订意见（原样透传，挂到当前轮）；
   * approved 时可选附言。未裁决版本不携带。
   */
  readonly feedback?: string;
}

/** 结构化错误码集合（稳定标识，供模型/调用方分支自愈）。 */
export type PlanModeErrorCode =
  | "plan-not-active"
  | "plan-already-pending"
  | "must-submit-plan"
  | "plan-invalid"
  | "plan-session-active";

/** 结构化错误（判别方式：对联合用 `"ok" in result` 收窄）。 */
export interface PlanModeError {
  /** 恒为 false，判别用。 */
  readonly ok: false;
  /** 稳定错误码。 */
  readonly code: PlanModeErrorCode;
  /** 人类可读失败原因（中文）。 */
  readonly message: string;
}

/** enter 的成功结果。 */
export interface PlanEnterOk {
  readonly ok: true;
  /** enter 后的当前态（幂等命中时 = 当前态原样返回）。 */
  readonly status: PlanModeStatus;
  /** 已绑定的会话标识。 */
  readonly sessionId: string;
  /** true = 重复 enter 幂等命中（状态未变化）。 */
  readonly alreadyActive: boolean;
}

/** submitPlan 的成功结果。 */
export interface PlanSubmitOk {
  readonly ok: true;
  readonly status: "awaiting-review";
  /** 本轮版本号（1-based）。 */
  readonly version: number;
}

/** exit 的成功结果。 */
export interface PlanExitOk {
  readonly ok: true;
  /** approved → executing（终态）；rejected → planning（回退修订）。 */
  readonly status: "executing" | "planning";
  readonly outcome: "approved" | "rejected";
}

export type PlanEnterResult = PlanEnterOk | PlanModeError;
export type PlanSubmitResult = PlanSubmitOk | PlanModeError;
export type PlanExitResult = PlanExitOk | PlanModeError;

/**
 * Plan 模式只读降权裁决：allowed: false 时必带 reason（工单钉死码
 * "plan-mode-readonly"）；allowed: true 时正交无 reason 字段。
 */
export interface PlanGateDecision {
  readonly allowed: boolean;
  /** 拒绝原因码；放行时缺省。 */
  readonly reason?: string;
}

/** exit 的裁决入参（审批器 ReviewResult 的结构同形体，调用方直接透传即可）。 */
export interface PlanReviewInput {
  readonly approved: boolean;
  /** 审批意见：rejected 时挂到当前轮供模型修订；approved 时可选附言。 */
  readonly feedback?: string;
}

/**
 * 只读工具判定端口：组装方把"读工具白名单"语义注入进来（如 Read/Grep/Glob
 * 及 AST 探测为只读，Write/Edit/破坏性 Bash 为写）。本模块对具体工具名零感知。
 */
export interface PlanToolPolicy {
  /** 返回 true = 该调用属只读（Plan 模式下放行）。 */
  isReadOnly(tool: string, args: unknown): boolean;
}

/** PlanModeService 构造选项。 */
export interface PlanModeServiceOptions {
  /** 只读工具判定端口（读工具白名单语义由组装方注入）。 */
  readonly policy: PlanToolPolicy;
  /** 时钟注入（版本时间线测试语义），缺省 Date.now。 */
  readonly now?: () => number;
}

/** err 工厂：构造结构化错误。 */
function err(code: PlanModeErrorCode, message: string): PlanModeError {
  return { ok: false, code, message };
}

/**
 * Plan 模式状态机服务：单实例承载一个"规划 → 提交 → 审批"生命周期。
 * 纯内存决策体：不弹窗、不读盘、不感知具体工具名；用户审批的交互呈现由
 * ExitReviewGate（TUI 交互实现归 BI-19/20）产出 ReviewResult 后由调用方回路
 * 到 exit()。本服务与 ExitReviewGate 解耦，接线归组装方。
 */
export class PlanModeService {
  readonly #policy: PlanToolPolicy;
  readonly #now: () => number;
  #status: PlanModeStatus = "idle";
  #sessionId: string | undefined;
  #versions: PlanVersion[] = [];
  #currentFeedback: string | undefined;

  constructor(options: PlanModeServiceOptions) {
    this.#policy = options.policy;
    this.#now = options.now ?? Date.now;
  }

  /** 当前状态（观测用）。 */
  get status(): PlanModeStatus {
    return this.#status;
  }

  /** 已绑定的会话标识；未 enter 前 undefined。 */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** 版本史快照（只追加：pending-review → approved/rejected，历史留痕）。 */
  get versions(): readonly PlanVersion[] {
    return [...this.#versions];
  }

  /** 最新一轮提交的计划文档；尚未提交时 undefined。 */
  get currentPlan(): PlanDocument | undefined {
    return this.#versions.at(-1)?.doc;
  }

  /**
   * 挂到当前轮的审批反馈：rejected 后非空（供模型修订计划），重新 submitPlan
   * 即清空（新的一轮不应沾旧意见）；approved 路径恒为 undefined（结构使然：
   * awaiting-review 只能经 submitPlan 进入，而 submitPlan 清空反馈）。
   */
  get currentFeedback(): string | undefined {
    return this.#currentFeedback;
  }

  /**
   * 进入 Plan 模式：idle → planning，并绑定 sessionId；进入即物理降权。
   * 幂等：同一 sessionId 重复 enter 原样返回当前态（alreadyActive: true，
   * 状态不回退、不重置版本史）。活跃会话期换 sessionId 进入 → plan-session-active
   * （防跨会话串态；跨会话请新建实例）。
   */
  enter(sessionId: string): PlanEnterResult {
    if (this.#status === "idle") {
      this.#sessionId = sessionId;
      this.#status = "planning";
      return { ok: true, status: this.#status, sessionId, alreadyActive: false };
    }
    if (this.#sessionId !== sessionId) {
      return err(
        "plan-session-active",
        `Plan 会话 ${this.#sessionId ?? ""} 进行中（状态 ${this.#status}），拒绝异会话 ${sessionId} 进入；跨会话请新建 PlanModeService 实例`,
      );
    }
    return { ok: true, status: this.#status, sessionId, alreadyActive: true };
  }

  /**
   * 只读降权门禁：Plan 模式激活期（planning / awaiting-review）全量委托注入
   * 的 PlanToolPolicy；非只读 → { allowed: false, reason: "plan-mode-readonly" }。
   * idle / executing 下 Plan 模式未生效 → 放行（语义裁定见文件头注释 1）。
   */
  gate(tool: string, args: unknown): PlanGateDecision {
    if (this.#status !== "planning" && this.#status !== "awaiting-review") {
      return { allowed: true };
    }
    if (this.#policy.isReadOnly(tool, args)) {
      return { allowed: true };
    }
    return { allowed: false, reason: "plan-mode-readonly" };
  }

  /**
   * 提交计划：planning → awaiting-review。必填校验（工单钉死）：changeFiles
   * 非空数组、design trim 后非空；违规 → plan-invalid。awaiting-review 期间
   * 再提交 → plan-already-pending（先等本轮裁决）。idle / executing → plan-not-active。
   */
  submitPlan(doc: PlanDocument): PlanSubmitResult {
    if (this.#status === "idle" || this.#status === "executing") {
      return err(
        "plan-not-active",
        `当前状态 ${this.#status} 下不可提交计划：Plan 模式未激活（需先 enter）`,
      );
    }
    if (this.#status === "awaiting-review") {
      return err(
        "plan-already-pending",
        `已有计划（v${this.#versions.at(-1)?.version ?? "?"}）待审，不可重复提交；请等待用户裁决`,
      );
    }
    // 至此状态必为 planning（非法转移已全部被上方结构化拒绝）。
    const invalid = PlanModeService.validateDoc(doc);
    if (invalid !== undefined) {
      return err("plan-invalid", `计划文档校验失败：${invalid}`);
    }
    const version = this.#versions.length + 1;
    this.#versions = [
      ...this.#versions,
      {
        version,
        doc,
        submittedAt: this.#now(),
        status: "pending-review",
      },
    ];
    this.#currentFeedback = undefined; // 新的一轮不沾旧意见
    this.#status = "awaiting-review";
    return { ok: true, status: "awaiting-review", version };
  }

  /** submitPlan 必填校验（changeFiles 非空数组 + design trim 非空），返回失败原因或 undefined。 */
  static validateDoc(doc: PlanDocument): string | undefined {
    if (typeof doc !== "object" || doc === null) {
      return "计划文档不可为空";
    }
    if (!Array.isArray(doc.changeFiles) || doc.changeFiles.length === 0) {
      return "changeFiles 必填：至少列出一个变更文件";
    }
    if (typeof doc.design !== "string" || doc.design.trim().length === 0) {
      return "design 必填：设计逻辑不可为空白";
    }
    return undefined;
  }

  /**
   * 审批出口：仅 awaiting-review 可退出。approved → executing（终态；写权限
   * 恢复由调用方根据状态切换，本服务只报状态）；rejected → planning，feedback
   * 挂到当前轮（currentFeedback + 对应版本的 feedback 字段，历史留痕）。
   * planning 下退出 → must-submit-plan（工单钉死码）；idle / executing → plan-not-active。
   */
  exit(review: PlanReviewInput): PlanExitResult {
    if (this.#status === "idle" || this.#status === "executing") {
      return err("plan-not-active", `当前状态 ${this.#status} 下无待审计划可退出`);
    }
    if (this.#status === "planning") {
      return err("must-submit-plan", "尚未提交计划（submitPlan）不可退出 Plan 模式");
    }
    const index = this.#versions.length - 1;
    const pending = this.#versions.at(-1);
    if (index < 0 || pending === undefined) {
      // 结构不可达：awaiting-review 只能经 submitPlan 进入（必已落一条版本）。
      return err("plan-not-active", "状态 awaiting-review 但版本史为空（内部不变量被破坏）");
    }
    const reviewedAt = this.#now();
    this.#versions[index] = {
      ...pending,
      status: review.approved ? "approved" : "rejected",
      reviewedAt,
      ...(review.feedback !== undefined ? { feedback: review.feedback } : {}),
    };
    if (review.approved) {
      this.#status = "executing";
      this.#currentFeedback = undefined;
    } else {
      this.#status = "planning";
      this.#currentFeedback = review.feedback;
    }
    return { ok: true, status: this.#status, outcome: review.approved ? "approved" : "rejected" };
  }
}
