/**
 * BI-07.3 · 本地多角色子智能体分流与 Fork 视窗沙箱（SubagentRunner）。
 *
 * 视窗断路器（钉死语义）：
 * - 子循环的全部事件经注入 sessionWriter 落入专属 childSessionId；
 * - 主会话只追加一条最终汇总文本（assistant 条目）——子 Agent 内部多轮
 *   探索日志绝不冲刷主视窗；
 * - 结果同时以 steer 消息推进父 outbox（BI-03.5 通道复用），主运行环在
 *   step boundary 消费。
 *
 * Fork 语义（Prompt Cache 复用）：
 * - type='fork'：克隆父级 systemPrompt **字节级**（绝不拼接任何 addon）+
 *   精确工具集（保序）+ 指定历史切片（端口注入 getHistorySlice）；
 * - 缺任一克隆源 → 结构化失败（不炸、不 throw）。
 *
 * 防递归（钉死）：子 profile 工具集（含 fork 克隆源）中出现
 * `Agent` / `spawn` / `AskUserQuestion` 一律剥离并留审计
 * （runner 审计簿 + 子会话 system 条目双落痕）。
 *
 * 复用约定（组合而非重建）：
 * - loopFactory 端口：测试注入 stub 循环；生产装配层在此端口内组合
 *   agent.ts 的 AgentLoop（BI-07）为子循环；
 * - outbox：session/inbox.ts 的 Inbox（BI-03.5 steer 通道复用）；
 * - sessionWriter：duck-type session/manager.ts 的 append 面（BI-03 JSONL）。
 */
import { systemClock, type Clock } from "../guard/deadline";
import { Inbox } from "../session/inbox";
import type { JsonValue, SessionEntry, SessionEntryType } from "../session/types";
import { uuid7 } from "../session/uuid7";
import {
  getSubagentProfile,
  RECURSION_HAZARD_TOOLS,
} from "./profiles";
import type { SubagentProfile, SubagentProfileType } from "./profiles";

export type { SubagentProfile, SubagentProfileType } from "./profiles";
export { getSubagentProfile, RECURSION_HAZARD_TOOLS, SUBAGENT_PROFILES } from "./profiles";

/* ------------------------------------------------------------------ */
/* 端口与载荷                                                           */
/* ------------------------------------------------------------------ */

/** 子会话事件草稿（写入 childSessionId / 主会话汇总的最小面）。 */
export interface SubagentEventDraft {
  readonly type: SessionEntryType;
  readonly payload: JsonValue;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

/**
 * 会话写端口：duck-type SessionManager.append(sessionId, parentId, input)。
 * 实现自管 parentId 链与 seq（首次 append 前 load 已有条目取 tip）。
 */
export interface SubagentSessionWriter {
  append(sessionId: string, draft: SubagentEventDraft): Promise<SessionEntry>;
}

/** 历史切片：fork 克隆进子循环的父会话条目只读快照。 */
export interface HistorySlice {
  readonly entries: readonly SessionEntry[];
}

/** 历史切片端口：按父会话 id 取尾部切片（Prompt Cache 复用的输入）。 */
export type GetHistorySlice = (
  sessionId: string,
  opts: { readonly tail?: number },
) => HistorySlice | Promise<HistorySlice>;

/** 子循环会话上下文：loopFactory 的第二参（运行时生效面）。 */
export interface SubLoopSessionCtx {
  readonly childSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly prompt: string;
  /** 运行时生效工具集（已剥离防递归危害工具、已套 toolLock）。 */
  readonly effectiveTools: readonly string[];
  /** 生效 system prompt（非 fork = profile.systemAddon ?? ""；fork = 父级逐字节）。 */
  readonly systemPrompt: string;
  readonly historySlice: HistorySlice | undefined;
  /** 旁路上下文切片（BI-07.6 /btw 复用现有上下文用；普通派生为 undefined）。 */
  readonly contextSlice: JsonValue | undefined;
  /** 事件落盘口：子循环把每一笔事件写入 childSessionId（视窗断路器入口）。 */
  readonly emit: (event: SubagentEventDraft) => Promise<void>;
  /**
   * 父→子 steer 收件箱（BI-03.5 语义复用）：子循环在 step boundary 调
   * takeSteers() 消费；高级接线可用 steerInbox.onWake() 门铃零轮询等待。
   */
  readonly steerInbox: Inbox<SubagentSteerMessage>;
  /** 步界收割：只取走全部 steer，绝不动常规 input 箱。 */
  readonly takeSteers: () => SubagentSteerMessage[];
}

/** 子循环运行结果。 */
export interface SubLoopOutcome {
  readonly ok: boolean;
  readonly summary: string;
  /** 循环未 emit 任何 tool_call 事件时的兜底计数。 */
  readonly toolCalls?: number;
  readonly error?: string;
}

/** 子循环句柄：一次子运行的执行体。 */
export interface SubLoop {
  run(): Promise<SubLoopOutcome>;
}

/**
 * 循环工厂端口：(profile, sessionCtx) => SubLoop。
 * 测试注入 stub；生产装配层组合 AgentLoop（BI-07）。
 */
export type LoopFactory = (profile: SubagentProfile, ctx: SubLoopSessionCtx) => SubLoop;

/** 子结果通知：runner 收束时投递。 */
export interface SubagentResultMessage {
  readonly kind: "subagent-result";
  readonly childSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly profileType: SubagentProfileType;
  readonly ok: boolean;
  readonly summary: string;
  readonly toolCalls: number;
}

/**
 * 父 outbox 载荷（判别联合）：subagent-result 完成通知与 child-report
 * 阶段汇报（BI-07.4）共用 BI-03.5 steer 通道。
 */
export type SubagentOutboxMessage = SubagentResultMessage | SubagentSteerMessage;

/** 双向信令载荷（BI-07.4 coordinator 复用同一形状）。 */
export interface SubagentSteerMessage {
  readonly kind: "child-report" | "parent-steer";
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly text: string;
  readonly phase?: string;
  readonly at: number;
}

export interface SpawnOptions {
  /** 父会话 id：提供时主会话追加汇总 + resultFor(parent) 可查。 */
  readonly parentSessionId?: string;
  /** fork 克隆源：父级 systemPrompt（字节级克隆，绝不改写）。 */
  readonly parentSystemPrompt?: string;
  /** fork 克隆源：父级精确工具集（保序克隆，危害工具仍剥离）。 */
  readonly parentTools?: readonly string[];
  /** fork 历史切片尾长（透传给 getHistorySlice）。 */
  readonly historyTail?: number;
  /** 旁路上下文切片（BI-07.6 使用）。 */
  readonly contextSlice?: JsonValue;
  /** 工具面收紧锁：与策略白名单求交（只收不放；BI-07.6 使用）。 */
  readonly toolLock?: readonly string[];
}

export interface SpawnResult {
  readonly childSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly profileType: SubagentProfileType;
  readonly ok: boolean;
  /** 最终汇总文本（失败时为结构化失败话术）。 */
  readonly summary: string;
  readonly toolCalls: number;
  readonly error?: string;
  /** 本次派生被剥离的防递归工具。 */
  readonly strippedTools: readonly string[];
}

/** 防递归剥离审计记录。 */
export interface StripAudit {
  readonly childSessionId: string;
  readonly profileType: SubagentProfileType;
  readonly stripped: readonly string[];
  readonly at: number;
}

export interface SubagentRunnerDeps {
  /** 循环工厂端口（必填；测试 stub，生产组合 AgentLoop）。 */
  readonly loopFactory: LoopFactory;
  /** 会话写端口（必填；BI-03 JSONL 引擎适配）。 */
  readonly sessionWriter: SubagentSessionWriter;
  /** 父 outbox（BI-03.5 steer 通道复用；缺省不投递）。 */
  readonly outbox?: Inbox<SubagentOutboxMessage>;
  /** 注入时钟（审计打点；默认系统时钟）。 */
  readonly clock?: Clock;
  /** 子会话 id 生成器（默认 `sub-<uuid7>`）。 */
  readonly generateSessionId?: () => string;
  /** 历史切片端口（fork 必需）。 */
  readonly getHistorySlice?: GetHistorySlice;
  /** 扩展角色档案（内建四类之外的自定义角色；内建不可覆盖）。 */
  readonly extraProfiles?: Readonly<Record<string, SubagentProfile>>;
  /** 实时镜像口（BI-07.4 MirrorSink 注入；缺省不镜像）。 */
  readonly mirror?: SubagentMirrorPort;
}

/** 实时镜像端口（BI-07.4）：只镜不落库——镜像流绝不回流 sessionWriter。 */
export interface SubagentMirrorPort {
  mirror(childSessionId: string, event: SubagentEventDraft): void;
}

/* ------------------------------------------------------------------ */
/* 工具策略分区                                                         */
/* ------------------------------------------------------------------ */

/** 按危害名单分区工具白名单：kept 保序，stripped 保序。 */
export function partitionToolPolicy(policy: readonly string[]): {
  kept: string[];
  stripped: string[];
} {
  const kept: string[] = [];
  const stripped: string[] = [];
  for (const tool of policy) {
    if (RECURSION_HAZARD_TOOLS.includes(tool)) stripped.push(tool);
    else kept.push(tool);
  }
  return { kept, stripped };
}

/** 工具面收紧锁：kept ∩ lock（只收不放，保序）。 */
function applyToolLock(kept: readonly string[], lock: readonly string[] | undefined): string[] {
  if (lock === undefined) return [...kept];
  const lockSet = new Set(lock);
  return kept.filter((tool) => lockSet.has(tool));
}

/* ------------------------------------------------------------------ */
/* 子运行登记（BI-07.4 协调器寻址面）                                     */
/* ------------------------------------------------------------------ */

/** 一次子运行的登记项：协调器据此路由双向信令。 */
export interface ChildRunRecord {
  readonly childSessionId: string;
  readonly parentSessionId: string | undefined;
  readonly profileType: SubagentProfileType;
  /** 父→子 steer 收件箱（step boundary 消费）。 */
  readonly steerInbox: Inbox<SubagentSteerMessage>;
}

/* ------------------------------------------------------------------ */
/* SubagentRunner                                                      */
/* ------------------------------------------------------------------ */

export class SubagentRunner {
  readonly #deps: SubagentRunnerDeps;
  readonly #clock: Clock;
  readonly #generateSessionId: () => string;
  /** 父会话 id → 该父下全部结果（spawn 完成序）。 */
  readonly #resultsByParent = new Map<string, SpawnResult[]>();
  /** 子会话 id → 结果。 */
  readonly #resultsByChild = new Map<string, SpawnResult>();
  /** 防递归剥离审计簿。 */
  readonly #audits: StripAudit[] = [];
  /** 子运行登记（spawn 即登记，协调器寻址）。 */
  readonly #runs = new Map<string, ChildRunRecord>();

  constructor(deps: SubagentRunnerDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? systemClock;
    this.#generateSessionId = deps.generateSessionId ?? (() => `sub-${uuid7()}`);
  }

  /** 防递归剥离审计簿（只读快照）。 */
  stripAudits(): readonly StripAudit[] {
    return [...this.#audits];
  }

  /** 父 outbox（BI-07.4 协调器子→父投递用；未接为 undefined）。 */
  get outbox(): Inbox<SubagentOutboxMessage> | undefined {
    return this.#deps.outbox;
  }

  /** 按子会话 id 查运行登记（协调器寻址；未知为 undefined）。 */
  runInfo(childSessionId: string): ChildRunRecord | undefined {
    return this.#runs.get(childSessionId);
  }

  /** 全部运行登记快照。 */
  runInfos(): readonly ChildRunRecord[] {
    return [...this.#runs.values()];
  }

  /** 某父会话下最近一次派生结果（无则 undefined）。 */
  resultFor(parent: string): SpawnResult | undefined {
    return this.#resultsByParent.get(parent)?.at(-1);
  }

  /** 某父会话下全部派生结果（完成序）。 */
  resultsFor(parent: string): readonly SpawnResult[] {
    return [...(this.#resultsByParent.get(parent) ?? [])];
  }

  /** 按子会话 id 查结果。 */
  resultByChild(childSessionId: string): SpawnResult | undefined {
    return this.#resultsByChild.get(childSessionId);
  }

  /**
   * 派生子运行。绝不因子循环异常而 throw：一切运营性失败折叠为
   * ok:false 的结构化 SpawnResult（未知 profileType 属程序员错误，仍抛 TypeError）。
   */
  async spawn(
    profileType: SubagentProfileType | (string & {}),
    prompt: string,
    opts: SpawnOptions = {},
  ): Promise<SpawnResult> {
    const profile = this.#resolveProfile(profileType);
    if (profile === undefined) {
      throw new TypeError(`SubagentRunner.spawn: 未知子智能体角色: ${String(profileType)}`);
    }
    const childSessionId = this.#generateSessionId();
    const parentSessionId = opts.parentSessionId;

    // ---- 0. 运行登记：父→子 steer 收件箱（BI-03.5 语义）+ 协调器寻址 ----
    const steerInbox = new Inbox<SubagentSteerMessage>();
    this.#runs.set(childSessionId, {
      childSessionId,
      parentSessionId,
      profileType: profile.type,
      steerInbox,
    });

    // ---- 1. 工具面与 system prompt 解析（fork 走克隆分支） ----
    let effectiveTools: string[];
    let systemPrompt: string;
    let historySlice: HistorySlice | undefined;
    let stripped: readonly string[] = [];
    const cloneFailures: string[] = [];

    if (profile.type === "fork") {
      if (typeof opts.parentSystemPrompt !== "string") {
        cloneFailures.push("fork 需要 opts.parentSystemPrompt（父级 systemPrompt 字节级克隆源）");
      }
      if (opts.parentTools === undefined) {
        cloneFailures.push("fork 需要 opts.parentTools（父级精确工具集克隆源）");
      }
      if (parentSessionId === undefined) {
        cloneFailures.push("fork 需要 opts.parentSessionId（历史切片与结果归属源）");
      }
      if (cloneFailures.length === 0) {
        // 字节级克隆：绝不拼接、绝不改写。
        systemPrompt = opts.parentSystemPrompt!;
        const partition = partitionToolPolicy(opts.parentTools!);
        stripped = partition.stripped;
        effectiveTools = applyToolLock(partition.kept, opts.toolLock);
        // 历史切片端口可选：未注入即轻量克隆（不带历史）；注入且调用即透传。
        if (this.#deps.getHistorySlice !== undefined) {
          try {
            historySlice = await this.#deps.getHistorySlice(parentSessionId!, {
              tail: opts.historyTail,
            });
          } catch (err) {
            cloneFailures.push(
              `getHistorySlice 端口失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } else {
        systemPrompt = "";
        effectiveTools = [];
      }
    } else {
      const partition = partitionToolPolicy(profile.toolPolicy);
      stripped = partition.stripped;
      effectiveTools = applyToolLock(partition.kept, opts.toolLock);
      systemPrompt = profile.systemAddon ?? "";
    }

    if (cloneFailures.length > 0) {
      const message = cloneFailures.join("；");
      const summary = `[subagent:${profile.type}] 克隆校验失败: ${message}`;
      const result = await this.#settle({
        childSessionId,
        parentSessionId,
        profileType: profile.type,
        ok: false,
        summary,
        error: message,
        toolCalls: 0,
        strippedTools: [],
        persistToMain: parentSessionId !== undefined,
      });
      return result;
    }

    // ---- 2. 事件泵：子事件串行落盘 childSessionId + 工具调用计数 ----
    let toolCallCount = 0;
    let chain: Promise<unknown> = Promise.resolve();
    const emit = (event: SubagentEventDraft): Promise<void> => {
      if (event.type === "tool_call") toolCallCount += 1;
      const appendOnce = async (): Promise<void> => {
        await this.#deps.sessionWriter.append(childSessionId, event);
      };
      const task = chain.then(appendOnce);
      // 链条自愈：单笔落盘失败只上抛给本次 emit 的 awaiter，不毒化后续事件。
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      // 只镜不落库：镜像只外送工具事件快照（BI-07.4），绝不回流写盘。
      if (event.type === "tool_call" || event.type === "tool_result") {
        this.#deps.mirror?.mirror(childSessionId, event);
      }
      return task;
    };

    // ---- 3. 防递归剥离：审计簿 + 子会话 system 条目双落痕 ----
    if (stripped.length > 0) {
      this.#audits.push({
        childSessionId,
        profileType: profile.type,
        stripped: [...stripped],
        at: this.#clock.now(),
      });
      await emit({
        type: "system",
        payload: { kind: "tool-policy-strip", profileType: profile.type, stripped: [...stripped] },
      });
    }

    // ---- 4. 子循环运行：异常折叠为结构化失败 ----
    const ctx: SubLoopSessionCtx = {
      childSessionId,
      parentSessionId,
      prompt,
      effectiveTools,
      systemPrompt,
      historySlice,
      contextSlice: opts.contextSlice,
      emit,
      steerInbox,
      takeSteers: () => steerInbox.takeSteers(),
    };
    let outcome: SubLoopOutcome;
    try {
      outcome = await this.#deps.loopFactory(profile, ctx).run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        ok: false,
        summary: `[subagent:${profile.type}] 结构化失败: ${message}`,
        error: message,
      };
    }
    const toolCalls =
      toolCallCount > 0 ? toolCallCount : (outcome.toolCalls ?? 0);

    await chain; // 排干子会话写盘，spawn 返回即持久化完成

    // ---- 5. 视窗断路器：主会话只追加最终汇总文本 ----
    const result = await this.#settle({
      childSessionId,
      parentSessionId,
      profileType: profile.type,
      ok: outcome.ok,
      summary: outcome.summary,
      error: outcome.error,
      toolCalls,
      strippedTools: stripped,
      persistToMain: parentSessionId !== undefined,
    });
    return result;
  }

  /** 收尾：主会话汇总 + outbox steer 投递 + 结果记账。 */
  async #settle(input: {
    childSessionId: string;
    parentSessionId: string | undefined;
    profileType: SubagentProfileType;
    ok: boolean;
    summary: string;
    error?: string;
    toolCalls: number;
    strippedTools: readonly string[];
    persistToMain: boolean;
  }): Promise<SpawnResult> {
    if (input.persistToMain && input.parentSessionId !== undefined) {
      const payload: Record<string, JsonValue> = {
        text: input.summary,
        source: "subagent",
        subagentType: input.profileType,
        childSessionId: input.childSessionId,
        ok: input.ok,
        toolCalls: input.toolCalls,
      };
      if (input.error !== undefined) payload.error = input.error;
      await this.#deps.sessionWriter.append(input.parentSessionId, {
        type: "assistant",
        payload,
      });
    }
    this.#deps.outbox?.push("steer", {
      kind: "subagent-result",
      childSessionId: input.childSessionId,
      parentSessionId: input.parentSessionId,
      profileType: input.profileType,
      ok: input.ok,
      summary: input.summary,
      toolCalls: input.toolCalls,
    });
    const result: SpawnResult = {
      childSessionId: input.childSessionId,
      parentSessionId: input.parentSessionId,
      profileType: input.profileType,
      ok: input.ok,
      summary: input.summary,
      toolCalls: input.toolCalls,
      strippedTools: [...input.strippedTools],
      ...(input.error !== undefined ? { error: input.error } : {}),
    };
    if (input.parentSessionId !== undefined) {
      const list = this.#resultsByParent.get(input.parentSessionId);
      if (list === undefined) this.#resultsByParent.set(input.parentSessionId, [result]);
      else list.push(result);
    }
    this.#resultsByChild.set(input.childSessionId, result);
    return result;
  }

  #resolveProfile(profileType: string): SubagentProfile | undefined {
    const builtin = getSubagentProfile(profileType);
    if (builtin !== undefined) return builtin;
    return this.#deps.extraProfiles?.[profileType];
  }
}

/** 从 runner 导入面再导出 steer 消息类型（BI-07.4 协调器复用）。 */
export type { SubagentSteerMessage as CoordinatorSteerMessage };
