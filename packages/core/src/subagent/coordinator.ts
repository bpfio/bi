/**
 * BI-07.4 · 子智能体双向信令协调器。
 *
 * 双向通道（钉死：中途零退出沟通）：
 * - RespondToCoordinator（子→父阶段汇报）：子运行中把阶段进展 append 到
 *   父 outbox 的 steer 通道（BI-03.5 复用），**不打断子任务**——不 abort、
 *   不取消、不改子循环状态，子循环继续跑完；
 * - SendMessage（父→子 steer）：写入子运行专属 Inbox 的 steer 箱，子循环在
 *   step boundary 经 ctx.takeSteers() 消费（BI-03.5 双边界语义复用）；
 * - 双向均零退出：任何信令都不触发 cancelRequest / abort / 循环终结。
 *
 * 结构化拒绝（不走异常控制流）：unknown-subagent / unroutable / invalid-input。
 * 寻址面：SubagentRunner.runInfo(childSessionId) + runner.outbox。
 */
import { systemClock, type Clock } from "../guard/deadline";
import type { SubagentRunner } from "./runner";

/* ------------------------------------------------------------------ */
/* 工具规格（装配层据此注册模型可见表面）                                 */
/* ------------------------------------------------------------------ */

export interface CoordinatorToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export const RESPOND_TO_COORDINATOR_SPEC: CoordinatorToolSpec = {
  name: "RespondToCoordinator",
  description:
    "子智能体向协调者（父会话）做阶段汇报：不打断当前任务，汇报经 steer 通道送达父会话。请在关键阶段节点调用。",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "阶段汇报文本（必填，非空）" },
      phase: { type: "string", description: "阶段标识（可选，如 scanning/implementing）" },
    },
    required: ["message"],
  },
};

export const SEND_MESSAGE_SPEC: CoordinatorToolSpec = {
  name: "SendMessage",
  description:
    "协调者（父会话）向指定子智能体发送 steer 纠偏：写入子收件箱，子任务在步界消费，中途零退出。",
  inputSchema: {
    type: "object",
    properties: {
      childSessionId: { type: "string", description: "目标子会话 id" },
      message: { type: "string", description: "纠偏指令文本（必填，非空）" },
      phase: { type: "string", description: "关联阶段标识（可选）" },
    },
    required: ["childSessionId", "message"],
  },
};

/* ------------------------------------------------------------------ */
/* 结果与校验                                                           */
/* ------------------------------------------------------------------ */

/** 双向信令工具的结构化结果（成功/拒绝都不抛异常）。 */
export type CoordinatorToolResult =
  | { readonly ok: true; readonly delivered: true; readonly from: string; readonly to: string }
  | {
      readonly ok: false;
      readonly code: "invalid-input" | "unknown-subagent" | "unroutable";
      readonly message: string;
    };

function plainArgs(args: unknown): Record<string, unknown> | undefined {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface CoordinatorDeps {
  /** 信令寻址与投递都经 runner（runInfo / outbox / 子 steerInbox）。 */
  readonly runner: SubagentRunner;
  /** 注入时钟（信令打点；默认系统时钟）。 */
  readonly clock?: Clock;
}

/* ------------------------------------------------------------------ */
/* RespondToCoordinator：子→父阶段汇报                                   */
/* ------------------------------------------------------------------ */

export class RespondToCoordinatorTool {
  readonly spec = RESPOND_TO_COORDINATOR_SPEC;
  readonly #runner: SubagentRunner;
  readonly #clock: Clock;

  constructor(deps: CoordinatorDeps) {
    this.#runner = deps.runner;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * @param args   工具入参 { message, phase? }
   * @param caller 调用方上下文（装配层绑定当前子会话 id）
   */
  async run(
    args: unknown,
    caller: { readonly childSessionId: string },
  ): Promise<CoordinatorToolResult> {
    const input = plainArgs(args);
    const message = input === undefined ? undefined : nonEmptyString(input.message);
    if (message === undefined) {
      return {
        ok: false,
        code: "invalid-input",
        message: "RespondToCoordinator 需要 message（非空字符串）",
      };
    }
    const phase = input?.phase === undefined ? undefined : nonEmptyString(input.phase);
    if (input?.phase !== undefined && phase === undefined) {
      return { ok: false, code: "invalid-input", message: "phase 必须是非空字符串" };
    }

    const run = this.#runner.runInfo(caller.childSessionId);
    if (run === undefined) {
      return {
        ok: false,
        code: "unknown-subagent",
        message: `未知子会话: ${caller.childSessionId}`,
      };
    }
    if (run.parentSessionId === undefined) {
      return {
        ok: false,
        code: "unroutable",
        message: `子会话 ${run.childSessionId} 无父会话归属，无处投递`,
      };
    }
    const outbox = this.#runner.outbox;
    if (outbox === undefined) {
      return {
        ok: false,
        code: "unroutable",
        message: "runner 未接父 outbox，无法投递阶段汇报",
      };
    }

    // append 到父 outbox steer 通道；零退出：不触碰子循环任何状态。
    outbox.push("steer", {
      kind: "child-report",
      fromSessionId: run.childSessionId,
      toSessionId: run.parentSessionId,
      text: message,
      ...(phase !== undefined ? { phase } : {}),
      at: this.#clock.now(),
    });
    return { ok: true, delivered: true, from: run.childSessionId, to: run.parentSessionId };
  }
}

/* ------------------------------------------------------------------ */
/* SendMessage：父→子 steer                                             */
/* ------------------------------------------------------------------ */

export class SendMessageTool {
  readonly spec = SEND_MESSAGE_SPEC;
  readonly #runner: SubagentRunner;
  readonly #clock: Clock;

  constructor(deps: CoordinatorDeps) {
    this.#runner = deps.runner;
    this.#clock = deps.clock ?? systemClock;
  }

  /**
   * @param args   工具入参 { childSessionId, message, phase? }
   * @param caller 调用方上下文（装配层绑定当前父会话 id）
   */
  async run(
    args: unknown,
    caller: { readonly parentSessionId: string },
  ): Promise<CoordinatorToolResult> {
    const input = plainArgs(args);
    const childSessionId =
      input === undefined ? undefined : nonEmptyString(input.childSessionId);
    const message = input === undefined ? undefined : nonEmptyString(input.message);
    if (childSessionId === undefined || message === undefined) {
      return {
        ok: false,
        code: "invalid-input",
        message: "SendMessage 需要 childSessionId 与 message（均非空字符串）",
      };
    }
    const phase = input?.phase === undefined ? undefined : nonEmptyString(input.phase);
    if (input?.phase !== undefined && phase === undefined) {
      return { ok: false, code: "invalid-input", message: "phase 必须是非空字符串" };
    }

    const run = this.#runner.runInfo(childSessionId);
    if (run === undefined) {
      return {
        ok: false,
        code: "unknown-subagent",
        message: `未知子会话: ${childSessionId}`,
      };
    }

    // 写入子 Inbox steer 箱；零退出：不 abort、不取消，等子循环步界收割。
    run.steerInbox.push("steer", {
      kind: "parent-steer",
      fromSessionId: caller.parentSessionId,
      toSessionId: run.childSessionId,
      text: message,
      ...(phase !== undefined ? { phase } : {}),
      at: this.#clock.now(),
    });
    return { ok: true, delivered: true, from: caller.parentSessionId, to: run.childSessionId };
  }
}
