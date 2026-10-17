/**
 * BI-14.2 · 退出 Plan 模式的用户审批门禁（ExitReviewGate）——审批器端口 + 超时护栏。
 *
 * 接缝②（AUDIT-10，工单钉死）：`/mode` 表面入口（BI-20.1）与本服务同一实现
 * ——TUI 的 /mode 切到 plan 只是把会话送进 PlanModeService（见同目录
 * plan-mode.ts），退出规划态必须走本门禁的 requestApproval 产出用户裁决再回
 * 路 PlanModeService.exit()；BI-14.4 互斥协调器将来把 planning 态注册进互斥
 * 矩阵（planning 期间独占会话编排权）。TUI 交互实现（弹窗/按键/渲染）归
 * BI-19/20，本模块只定义端口与护栏。
 *
 * 审批器端口：PlanApprover 由组装方注入。真实交互实现（BI-19/20）之外，本模块
 * 默认提供两个测试实现：
 * - autoApprover：恒自动通过（测试流水线用）；
 * - ManualApprovalQueue：手动队列（测试里模拟"人挂起 → 事后裁决"的交互时序）。
 *
 * 语义裁定（钉死，供主控复核）：
 * 1. approver 为构造必填项——不设"缺省自动通过"的构造缺省：写权限门禁的静默
 *    自动通过是危险缺省，测试双轨必须显式注入，生产路径漏注入即构造报错。
 * 2. 超时可配（timeoutMs）：超时未获裁决 → { approved: false, feedback:
 *    "review-timeout" }（工单钉死码），绝不挂死。缺省（不配 timeoutMs）不设
 *    超时——人工审批可能任意久，交互态由人兜底；需要"不挂死"保障的场景
 *    （无人值守/CI）显式配置。
 * 3. 超时只是"本层放弃等待"，不取消审批器本身：迟到的裁决结果被丢弃（不产生
 *    unhandledrejection），审批器内部副作用由其实现自负。
 * 4. 本门禁只透传文档与裁决，不做内容校验——必填校验属 PlanModeService.submitPlan
 *    （单一职责，校验在提交口而非审批口）。
 */
import type { PlanDocument } from "./plan-mode";

/** 审批裁决结果（结构同形体：可直接透传给 PlanModeService.exit()）。 */
export interface ReviewResult {
  readonly approved: boolean;
  /** 审批意见：rejected 时为修订反馈原文；approved 时可选附言。 */
  readonly feedback?: string;
}

/** 审批器端口：收到计划文档，产出（可能需要任意久的）用户裁决。 */
export type PlanApprover = (doc: PlanDocument) => Promise<ReviewResult>;

/** ExitReviewGate 构造选项。 */
export interface ExitReviewGateOptions {
  /** 审批器端口（必填：真实 TUI 实现归 BI-19/20；测试注入 autoApprover / ManualApprovalQueue#approver）。 */
  readonly approver: PlanApprover;
  /** 超时毫秒数；缺省不超时（语义裁定见文件头注释 2）。 */
  readonly timeoutMs?: number;
}

/** 超时裁决（工单钉死码）。 */
const REVIEW_TIMEOUT: ReviewResult = { approved: false, feedback: "review-timeout" };

/**
 * 退出 Plan 模式的审批门禁：把计划文档递交审批器端口并等待裁决；
 * 配置 timeoutMs 时以定时器竞速，超时返回 REVIEW_TIMEOUT，绝不挂死。
 * 实例可复用：每次 requestApproval 独立计时、finally 清理定时器。
 */
export class ExitReviewGate {
  readonly #approver: PlanApprover;
  readonly #timeoutMs: number | undefined;

  constructor(options: ExitReviewGateOptions) {
    this.#approver = options.approver;
    this.#timeoutMs = options.timeoutMs;
  }

  /** 是否配置了超时（观测用）。 */
  get hasTimeout(): boolean {
    return this.#timeoutMs !== undefined;
  }

  /**
   * 递交审批：无超时配置 → 直接等待审批器；配置超时 → 审批器与定时器竞速，
   * 超时侧返回 { approved: false, feedback: "review-timeout" }。审批器自身的
   * 失败（rejected promise）原样向调用方抛出，不吞错；超时后迟到的裁决被
   * 显式吞掉（防 unhandledrejection 噪音，语义裁定见文件头注释 3）。
   */
  async requestApproval(doc: PlanDocument): Promise<ReviewResult> {
    const pending = this.#approver(doc);
    if (this.#timeoutMs === undefined) {
      return await pending;
    }
    const timeoutMs = this.#timeoutMs; // 收窄为 number（闭包内不依赖属性收窄）。
    // 显式吞掉迟到 rejection：超时裁定返回后审批器仍可能在后台拒绝。
    void pending.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<ReviewResult>((resolve) => {
      timer = setTimeout(() => resolve(REVIEW_TIMEOUT), timeoutMs);
    });
    try {
      return await Promise.race([pending, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** 测试实现 1：恒自动通过（不带附言）。 */
export const autoApprover: PlanApprover = () => Promise.resolve({ approved: true });

/**
 * 测试实现 2：手动裁决队列——请求进入 FIFO 队列挂起，测试用例在任意时点
 * 逐条裁决（模拟"人挂起 → 事后批准/驳回"的真实交互时序）。
 */
export class ManualApprovalQueue {
  readonly #pending: Array<{ doc: PlanDocument; resolve: (result: ReviewResult) => void }> = [];

  /** 作为审批端口注入 ExitReviewGate（approver: queue.approver）。 */
  readonly approver: PlanApprover = (doc) =>
    new Promise<ReviewResult>((resolve) => {
      this.#pending.push({ doc, resolve });
    });

  /** 当前挂起待裁决的请求数。 */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** 挂起请求的计划文档快照（FIFO 序，观测用）。 */
  get pendingDocs(): readonly PlanDocument[] {
    return this.#pending.map((entry) => entry.doc);
  }

  /** FIFO 裁决队首请求；队列空时返回 false（不抛错，便于测试断言时序）。 */
  resolveNext(result: ReviewResult): boolean {
    const next = this.#pending.shift();
    if (next === undefined) {
      return false;
    }
    next.resolve(result);
    return true;
  }
}
