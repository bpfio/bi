/**
 * BI-14.2 · Plan 模式状态机测试（纯内存，零 IO）。
 *
 * 覆盖工单钉死的测试矩阵：
 * 1. 状态机全转移：idle→planning→awaiting-review→executing 与 rejected 回退；
 * 2. 非法转移矩阵：plan-not-active / must-submit-plan / plan-already-pending /
 *    plan-invalid / plan-session-active 全部结构化报错；
 * 3. enter 幂等（含 executing/awaiting-review 态重复进入）；
 * 4. gate 降权：只读过 / 写拒（reason: "plan-mode-readonly"）/ 管辖域边界；
 * 5. submit 校验：changeFiles / design 必填；
 * 6. reject 带 feedback 回 planning 且 versions 追加留痕（多轮互不污染）。
 */
import { describe, expect, test } from "bun:test";
import { PlanModeService } from "./plan-mode";
import type { PlanDocument, PlanToolPolicy } from "./plan-mode";

/** 可手动拨动的测试时钟（版本时间线语义）。 */
function makeClock() {
  let now = 1_700_000_000_000;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** 测试用只读白名单策略：Read/Grep/Glob 只读，其余（Write/Edit/Bash…）一律写。 */
const readOnlyPolicy: PlanToolPolicy = {
  isReadOnly: (tool) => tool === "Read" || tool === "Grep" || tool === "Glob",
};

/** 合法计划文档工厂（覆盖生成变体）。 */
const doc = (overrides: Partial<PlanDocument> = {}): PlanDocument => ({
  title: "重构 plan 模块",
  changeFiles: ["packages/workflow/src/plan/plan-mode.ts"],
  design: "先落状态机，再接审批门禁，最后由 /mode 表面入口接线。",
  risks: ["状态回退时模型可能重复提交"],
  createdAt: 1_700_000_000_000,
  ...overrides,
});

/** 构造一个已 enter（planning 态）的服务。 */
function planningService(clock = makeClock()): { service: PlanModeService; clock: typeof clock } {
  const service = new PlanModeService({ policy: readOnlyPolicy, now: clock.now });
  const entered = service.enter("sess-1");
  expect(entered.ok).toBe(true);
  return { service, clock };
}

/** 构造一个已提交计划（awaiting-review 态）的服务，并返回其提交结果。 */
function pendingService(clock = makeClock()): {
  service: PlanModeService;
  clock: typeof clock;
  submitted: Extract<ReturnType<PlanModeService["submitPlan"]>, { ok: true }>;
} {
  const { service, clock: c } = planningService(clock);
  const submitted = service.submitPlan(doc());
  expect(submitted.ok).toBe(true);
  if (!submitted.ok) throw new Error("unreachable");
  return { service, clock: c, submitted };
}

describe("BI-14.2 状态机：全转移", () => {
  test("初始态 idle：sessionId 未绑定、版本史为空、无挂起反馈", () => {
    const service = new PlanModeService({ policy: readOnlyPolicy });
    expect(service.status).toBe("idle");
    expect(service.sessionId).toBeUndefined();
    expect(service.versions).toEqual([]);
    expect(service.currentPlan).toBeUndefined();
    expect(service.currentFeedback).toBeUndefined();
  });

  test("enter：idle → planning，绑定 sessionId，alreadyActive=false", () => {
    const service = new PlanModeService({ policy: readOnlyPolicy });
    const result = service.enter("sess-1");
    expect(result).toEqual({ ok: true, status: "planning", sessionId: "sess-1", alreadyActive: false });
    expect(service.status).toBe("planning");
    expect(service.sessionId).toBe("sess-1");
  });

  test("合法 submitPlan：planning → awaiting-review，version=1，currentPlan 即提交文档", () => {
    const { service } = planningService();
    const d = doc();
    const result = service.submitPlan(d);
    expect(result).toEqual({ ok: true, status: "awaiting-review", version: 1 });
    expect(service.status).toBe("awaiting-review");
    expect(service.currentPlan).toBe(d); // 原样快照（同一引用，createdAt 等字段不被改写）
  });

  test("exit(approved)：awaiting-review → executing（终态），版本置 approved 并盖 reviewedAt", () => {
    const { service, clock } = pendingService();
    clock.advance(50);
    const result = service.exit({ approved: true });
    expect(result).toEqual({ ok: true, status: "executing", outcome: "approved" });
    expect(service.status).toBe("executing");
    const version = service.versions.at(-1);
    expect(version?.status).toBe("approved");
    expect(version?.reviewedAt).toBe(1_700_000_000_050);
    expect(version?.submittedAt).toBe(1_700_000_000_000);
  });

  test("exit(approved) 携带附言：附言留痕到版本 feedback", () => {
    const { service } = pendingService();
    service.exit({ approved: true, feedback: "同意，注意回滚脚本" });
    const version = service.versions.at(-1);
    expect(version?.status).toBe("approved");
    expect(version?.feedback).toBe("同意，注意回滚脚本");
  });

  test("exit(rejected)：awaiting-review → planning，feedback 挂到当前轮且版本留痕", () => {
    const { service } = pendingService();
    const result = service.exit({ approved: false, feedback: "先补迁移脚本再动 schema" });
    expect(result).toEqual({ ok: true, status: "planning", outcome: "rejected" });
    expect(service.status).toBe("planning");
    expect(service.currentFeedback).toBe("先补迁移脚本再动 schema");
    const version = service.versions.at(-1);
    expect(version?.status).toBe("rejected");
    expect(version?.feedback).toBe("先补迁移脚本再动 schema");
    expect(version?.reviewedAt).toBeDefined();
  });

  test("reject 后重新 submitPlan：version=2、currentFeedback 清空（新一轮不沾旧意见），旧版本留痕不变", () => {
    const { service, clock } = pendingService();
    service.exit({ approved: false, feedback: "风险清单太薄" });
    clock.advance(100);
    const resubmit = service.submitPlan(doc({ design: "补充回滚与迁移方案" }));
    expect(resubmit).toEqual({ ok: true, status: "awaiting-review", version: 2 });
    expect(service.currentFeedback).toBeUndefined();
    const versions = service.versions;
    expect(versions).toHaveLength(2);
    expect(versions[0]?.feedback).toBe("风险清单太薄"); // 历史留痕不被改写
    expect(versions[1]?.status).toBe("pending-review");
    expect(versions[1]?.submittedAt).toBe(1_700_000_000_100);
  });

  test("连续两轮拒绝：两条版本各自 rejected、feedback 互不污染", () => {
    const { service } = pendingService();
    service.exit({ approved: false, feedback: "第一轮意见" });
    service.submitPlan(doc({ design: "修订 v2" }));
    service.exit({ approved: false, feedback: "第二轮意见" });
    const versions = service.versions;
    expect(versions).toHaveLength(2);
    expect(versions[0]?.status).toBe("rejected");
    expect(versions[0]?.feedback).toBe("第一轮意见");
    expect(versions[1]?.status).toBe("rejected");
    expect(versions[1]?.feedback).toBe("第二轮意见");
    expect(service.status).toBe("planning");
    expect(service.currentFeedback).toBe("第二轮意见");
  });

  test("rejected 不带 feedback：版本留痕无 feedback 字段，currentFeedback 保持 undefined", () => {
    const { service } = pendingService();
    const result = service.exit({ approved: false });
    expect(result).toEqual({ ok: true, status: "planning", outcome: "rejected" });
    const version = service.versions.at(-1);
    expect(version?.status).toBe("rejected");
    expect(version?.feedback).toBeUndefined();
    expect(service.currentFeedback).toBeUndefined();
  });
});

describe("BI-14.2 状态机：enter 幂等", () => {
  test("planning 态重复 enter：幂等返回当前态，状态与版本史不重置", () => {
    const { service } = planningService();
    service.submitPlan(doc()); // 推进到 awaiting-review 再回退，确保历史非空
    service.exit({ approved: false, feedback: "改" });
    const again = service.enter("sess-1");
    expect(again).toEqual({ ok: true, status: "planning", sessionId: "sess-1", alreadyActive: true });
    expect(service.versions).toHaveLength(1); // 未被幂等 enter 清空
  });

  test("awaiting-review 态重复 enter：幂等返回 awaiting-review", () => {
    const { service } = pendingService();
    const again = service.enter("sess-1");
    expect(again).toEqual({ ok: true, status: "awaiting-review", sessionId: "sess-1", alreadyActive: true });
    expect(service.status).toBe("awaiting-review");
  });

  test("executing 态重复 enter：幂等返回 executing（终态不复活为 planning）", () => {
    const { service } = pendingService();
    service.exit({ approved: true });
    const again = service.enter("sess-1");
    expect(again).toEqual({ ok: true, status: "executing", sessionId: "sess-1", alreadyActive: true });
    expect(service.status).toBe("executing");
  });

  test("活跃会话期异 sessionId enter → plan-session-active（防跨会话串态）", () => {
    const { service } = pendingService();
    const result = service.enter("sess-2");
    expect(result).toEqual({
      ok: false,
      code: "plan-session-active",
      message: expect.any(String),
    });
    expect(service.status).toBe("awaiting-review"); // 状态不被扰动
    expect(service.sessionId).toBe("sess-1");
  });
});

describe("BI-14.2 gate：进入即物理降权", () => {
  test("idle 态 gate：Plan 模式未生效 → 放行且正交无 reason 字段", () => {
    const service = new PlanModeService({ policy: readOnlyPolicy });
    expect(service.gate("Write", { path: "a.ts" })).toEqual({ allowed: true });
  });

  test("planning 态只读工具 → { allowed: true }（无 reason）", () => {
    const { service } = planningService();
    expect(service.gate("Read", { path: "a.ts" })).toEqual({ allowed: true });
    expect(service.gate("Grep", { pattern: "x" })).toEqual({ allowed: true });
  });

  test("planning 态写工具 → { allowed: false, reason: 'plan-mode-readonly' }（工单钉死码）", () => {
    const { service } = planningService();
    expect(service.gate("Write", { path: "a.ts" })).toEqual({
      allowed: false,
      reason: "plan-mode-readonly",
    });
    expect(service.gate("Bash", "rm -rf build")).toEqual({
      allowed: false,
      reason: "plan-mode-readonly",
    });
  });

  test("gate 将 tool 与 args 原样透传给注入策略（端口契约）", () => {
    const seen: Array<{ tool: string; args: unknown }> = [];
    const spyPolicy: PlanToolPolicy = {
      isReadOnly: (tool, args) => {
        seen.push({ tool, args });
        return true;
      },
    };
    const service = new PlanModeService({ policy: spyPolicy });
    service.enter("sess-1");
    const args = { path: "src/a.ts", mode: "read" };
    service.gate("Read", args);
    expect(seen).toEqual([{ tool: "Read", args }]); // 同一引用：不做任何包装改写
  });

  test("awaiting-review 态仍降权：写拒、只读过", () => {
    const { service } = pendingService();
    expect(service.gate("Edit", { path: "a.ts" })).toEqual({
      allowed: false,
      reason: "plan-mode-readonly",
    });
    expect(service.gate("Glob", { pattern: "**/*.ts" })).toEqual({ allowed: true });
  });

  test("executing 态 gate 放行：降权解除（写权限恢复由调用方按状态切换）", () => {
    const { service } = pendingService();
    service.exit({ approved: true });
    expect(service.gate("Write", { path: "a.ts" })).toEqual({ allowed: true });
  });

  test("rejected 回 planning 后 gate 恢复降权：写仍拒", () => {
    const { service } = pendingService();
    service.exit({ approved: false, feedback: "改了再来" });
    expect(service.gate("Write", { path: "a.ts" })).toEqual({
      allowed: false,
      reason: "plan-mode-readonly",
    });
  });
});

describe("BI-14.2 submitPlan：必填校验", () => {
  test("idle 态提交 → plan-not-active", () => {
    const service = new PlanModeService({ policy: readOnlyPolicy });
    expect(service.submitPlan(doc())).toEqual({
      ok: false,
      code: "plan-not-active",
      message: expect.any(String),
    });
  });

  test("executing 态提交 → plan-not-active（终态不开新一轮）", () => {
    const { service } = pendingService();
    service.exit({ approved: true });
    expect(service.submitPlan(doc({ design: "新一轮" }))).toEqual({
      ok: false,
      code: "plan-not-active",
      message: expect.any(String),
    });
    expect(service.versions).toHaveLength(1); // 版本史不被污染
  });

  test("changeFiles 空数组 → plan-invalid", () => {
    const { service } = planningService();
    expect(service.submitPlan(doc({ changeFiles: [] }))).toEqual({
      ok: false,
      code: "plan-invalid",
      message: expect.any(String),
    });
    expect(service.status).toBe("planning"); // 校验失败不转移
  });

  test("changeFiles 运行期非数组（模型脏输出）→ plan-invalid", () => {
    const { service } = planningService();
    const dirty = doc({ changeFiles: "packages/a.ts" as unknown as readonly string[] });
    expect(service.submitPlan(dirty)).toEqual({
      ok: false,
      code: "plan-invalid",
      message: expect.any(String),
    });
  });

  test("design 空白字符串 → plan-invalid", () => {
    const { service } = planningService();
    expect(service.submitPlan(doc({ design: "   \n\t " }))).toEqual({
      ok: false,
      code: "plan-invalid",
      message: expect.any(String),
    });
  });

  test("title/risks 不参与必填校验（工单钉死仅 changeFiles/design）", () => {
    const { service } = planningService();
    const result = service.submitPlan(doc({ title: "", risks: [] }));
    expect(result).toEqual({ ok: true, status: "awaiting-review", version: 1 });
  });

  test("awaiting-review 态再提交（即便文档合法）→ plan-already-pending", () => {
    const { service } = pendingService();
    expect(service.submitPlan(doc({ design: "重复提交" }))).toEqual({
      ok: false,
      code: "plan-already-pending",
      message: expect.any(String),
    });
    expect(service.versions).toHaveLength(1);
  });

  test("validateDoc 静态校验：合法 → undefined；null → 失败原因", () => {
    expect(PlanModeService.validateDoc(doc())).toBeUndefined();
    expect(PlanModeService.validateDoc(null as unknown as PlanDocument)).toBeTypeOf("string");
  });
});

describe("BI-14.2 exit：非法退出矩阵", () => {
  test("planning 态 exit → must-submit-plan（工单钉死码）", () => {
    const { service } = planningService();
    expect(service.exit({ approved: true })).toEqual({
      ok: false,
      code: "must-submit-plan",
      message: expect.any(String),
    });
    expect(service.exit({ approved: false, feedback: "x" })).toEqual({
      ok: false,
      code: "must-submit-plan",
      message: expect.any(String),
    });
    expect(service.status).toBe("planning");
  });

  test("idle 态 exit → plan-not-active", () => {
    const service = new PlanModeService({ policy: readOnlyPolicy });
    expect(service.exit({ approved: true })).toEqual({
      ok: false,
      code: "plan-not-active",
      message: expect.any(String),
    });
  });

  test("executing 态 exit → plan-not-active（终态不可重复裁决）", () => {
    const { service } = pendingService();
    service.exit({ approved: true });
    expect(service.exit({ approved: true })).toEqual({
      ok: false,
      code: "plan-not-active",
      message: expect.any(String),
    });
    expect(service.versions).toHaveLength(1); // 版本史不被二次改写
  });
});
