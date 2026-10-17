/**
 * BI-14.2 · 退出审批门禁测试（纯内存 + 受控定时器，零 IO）。
 *
 * 覆盖工单钉死的测试矩阵：
 * 1. 审批器端口注入：autoApprover 恒通过、ManualApprovalQueue 手动队列注入交互
 *    （挂起 → 事后裁决，FIFO 时序）；
 * 2. 超时路径：超时 → { approved: false, feedback: "review-timeout" }，不挂死、
 *    门禁可复用、迟到裁决/迟到拒绝不产生 unhandledrejection；
 * 3. 接缝② 端到端：PlanModeService × ExitReviewGate 手动队列全回路
 *    （enter → submitPlan → requestApproval → exit → 回退/放行）。
 */
import { describe, expect, test } from "bun:test";
import { ExitReviewGate, ManualApprovalQueue, autoApprover } from "./exit-review";
import type { PlanApprover } from "./exit-review";
import { PlanModeService } from "./plan-mode";
import type { PlanDocument, PlanToolPolicy } from "./plan-mode";

/** 合法计划文档工厂。 */
const doc = (overrides: Partial<PlanDocument> = {}): PlanDocument => ({
  title: "重构 plan 模块",
  changeFiles: ["packages/workflow/src/plan/plan-mode.ts"],
  design: "先落状态机，再接审批门禁。",
  risks: [],
  createdAt: 1_700_000_000_000,
  ...overrides,
});

/** 测试用只读白名单策略（与 plan-mode.test.ts 同款）。 */
const readOnlyPolicy: PlanToolPolicy = {
  isReadOnly: (tool) => tool === "Read" || tool === "Grep" || tool === "Glob",
};

describe("BI-14.2 ExitReviewGate：autoApprover（测试实现 1）", () => {
  test("autoApprover 恒自动通过且正交无 feedback 字段", async () => {
    expect(await autoApprover(doc())).toEqual({ approved: true });
  });

  test("注入 autoApprover、不配 timeoutMs：直接透传裁决，缺省不超时", async () => {
    const gate = new ExitReviewGate({ approver: autoApprover });
    expect(gate.hasTimeout).toBe(false);
    expect(await gate.requestApproval(doc())).toEqual({ approved: true });
  });
});

describe("BI-14.2 ExitReviewGate：ManualApprovalQueue（测试实现 2，手动队列注入交互）", () => {
  test("requestApproval 挂起入队：pendingCount=1、pendingDocs 记录原文档", async () => {
    const queue = new ManualApprovalQueue();
    const gate = new ExitReviewGate({ approver: queue.approver });
    const d = doc();
    const pending = gate.requestApproval(d);
    expect(queue.pendingCount).toBe(1);
    expect(queue.pendingDocs).toEqual([d]);
    expect(queue.resolveNext({ approved: true })).toBe(true);
    expect(await pending).toEqual({ approved: true });
  });

  test("批准裁决原样透传给等待方", async () => {
    const queue = new ManualApprovalQueue();
    const gate = new ExitReviewGate({ approver: queue.approver });
    const pending = gate.requestApproval(doc());
    queue.resolveNext({ approved: true });
    expect(await pending).toEqual({ approved: true });
  });

  test("驳回裁决 + feedback 原样透传（供回路 PlanModeService.exit 挂到当前轮）", async () => {
    const queue = new ManualApprovalQueue();
    const gate = new ExitReviewGate({ approver: queue.approver });
    const pending = gate.requestApproval(doc());
    queue.resolveNext({ approved: false, feedback: "风险清单重写" });
    expect(await pending).toEqual({ approved: false, feedback: "风险清单重写" });
  });

  test("空队列 resolveNext → false（不抛错，便于断言时序）", () => {
    const queue = new ManualApprovalQueue();
    expect(queue.resolveNext({ approved: true })).toBe(false);
  });

  test("FIFO 时序：两条挂起请求按入队顺序逐一裁决，结果一一对应", async () => {
    const queue = new ManualApprovalQueue();
    const gate = new ExitReviewGate({ approver: queue.approver });
    const d1 = doc({ title: "v1" });
    const d2 = doc({ title: "v2" });
    const p1 = gate.requestApproval(d1);
    const p2 = gate.requestApproval(d2);
    expect(queue.pendingCount).toBe(2);
    expect(queue.pendingDocs).toEqual([d1, d2]);
    expect(queue.resolveNext({ approved: false, feedback: "先改 v1" })).toBe(true);
    expect(await p1).toEqual({ approved: false, feedback: "先改 v1" });
    expect(queue.resolveNext({ approved: true })).toBe(true);
    expect(await p2).toEqual({ approved: true });
  });
});

describe("BI-14.2 ExitReviewGate：超时路径（可配、不挂死）", () => {
  test("永不裁决的审批器 + timeoutMs=10 → review-timeout，await 正常完成", async () => {
    const never: PlanApprover = () => new Promise(() => {});
    const gate = new ExitReviewGate({ approver: never, timeoutMs: 10 });
    expect(gate.hasTimeout).toBe(true);
    expect(await gate.requestApproval(doc())).toEqual({ approved: false, feedback: "review-timeout" });
  });

  test("慢审批器（30ms 后批准）+ timeoutMs=5 → 超时码压过迟到批准", async () => {
    const slow: PlanApprover = () =>
      new Promise((resolve) => setTimeout(() => resolve({ approved: true }), 30));
    const gate = new ExitReviewGate({ approver: slow, timeoutMs: 5 });
    expect(await gate.requestApproval(doc())).toEqual({ approved: false, feedback: "review-timeout" });
  });

  test("快审批器 + 宽裕 timeoutMs → 正常裁决，不误杀", async () => {
    const quick: PlanApprover = () =>
      new Promise((resolve) => setTimeout(() => resolve({ approved: true, feedback: "ok" }), 5));
    const gate = new ExitReviewGate({ approver: quick, timeoutMs: 1_000 });
    expect(await gate.requestApproval(doc())).toEqual({ approved: true, feedback: "ok" });
  });

  test("超时后门禁可复用：timer 已清理，第二次请求正常裁决", async () => {
    let calls = 0;
    const flaky: PlanApprover = () => {
      calls += 1;
      return calls === 1 ? new Promise(() => {}) : Promise.resolve({ approved: true });
    };
    const gate = new ExitReviewGate({ approver: flaky, timeoutMs: 10 });
    expect(await gate.requestApproval(doc())).toEqual({ approved: false, feedback: "review-timeout" });
    expect(await gate.requestApproval(doc())).toEqual({ approved: true });
    expect(calls).toBe(2);
  });

  test("超时后审批器迟到拒绝：先拿到 review-timeout，迟到 rejection 不炸进程", async () => {
    const lateReject: PlanApprover = () =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("审批器迟到崩溃")), 30));
    const gate = new ExitReviewGate({ approver: lateReject, timeoutMs: 5 });
    expect(await gate.requestApproval(doc())).toEqual({ approved: false, feedback: "review-timeout" });
    await new Promise((resolve) => setTimeout(resolve, 50)); // 让迟到 rejection 落地
    // 若产生 unhandledrejection，bun test 会直接判负——走到这里即无噪音。
  });

  test("审批器自身失败（rejected promise）：原样向调用方抛出，不吞错不超时顶替", async () => {
    const failing: PlanApprover = () => Promise.reject(new Error("TUI 审批面板崩溃"));
    const gate = new ExitReviewGate({ approver: failing, timeoutMs: 1_000 });
    let caught: unknown;
    try {
      await gate.requestApproval(doc());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("TUI 审批面板崩溃");
  });
});

describe("BI-14.2 接缝②：PlanModeService × ExitReviewGate 端到端接线", () => {
  test("enter → submitPlan → requestApproval（挂起）→ 驳回回退 planning → 重提 → 批准 → executing", async () => {
    const service = new PlanModeService({ policy: readOnlyPolicy });
    const queue = new ManualApprovalQueue();
    const gate = new ExitReviewGate({ approver: queue.approver }); // 组装方接线点

    expect(service.enter("sess-9")).toEqual({
      ok: true,
      status: "planning",
      sessionId: "sess-9",
      alreadyActive: false,
    });
    expect(service.submitPlan(doc())).toEqual({ ok: true, status: "awaiting-review", version: 1 });

    // 审批口拿到的是服务里的计划原文（同一实现同一文档）。
    const firstReview = gate.requestApproval(service.currentPlan!);
    expect(queue.pendingCount).toBe(1);
    expect(queue.pendingDocs[0]?.title).toBe("重构 plan 模块");

    // 用户驳回：裁决回路 exit() → 回 planning，feedback 挂当前轮。
    queue.resolveNext({ approved: false, feedback: "补测试清单" });
    expect(service.exit(await firstReview)).toEqual({
      ok: true,
      status: "planning",
      outcome: "rejected",
    });
    expect(service.currentFeedback).toBe("补测试清单");

    // 模型修订重提（v2），用户批准 → executing（写权限恢复由调用方按状态切换）。
    expect(service.submitPlan(doc({ design: "补测试清单后的修订版" }))).toEqual({
      ok: true,
      status: "awaiting-review",
      version: 2,
    });
    const secondReview = gate.requestApproval(service.currentPlan!);
    queue.resolveNext({ approved: true });
    expect(service.exit(await secondReview)).toEqual({
      ok: true,
      status: "executing",
      outcome: "approved",
    });
    expect(service.versions).toHaveLength(2);
    expect(service.versions[0]?.status).toBe("rejected");
    expect(service.versions[1]?.status).toBe("approved");
  });
});
