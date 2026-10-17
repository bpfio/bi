/**
 * BI-07.5 — 重复工具调用守卫（软提醒）与自主目标自动续行。
 *
 * 职责（工单钉死）：
 * - RepeatReminder：per 工具连续同参哈希计数，阈值 3/5 注入渐进软提醒
 *   （返回 string | null，由运行环注入下一 prompt）。**软边界**：只提醒、
 *   不拦截任何调用——硬阻断门（tier 3 短路工具执行）归 BI-07.13 的
 *   RepeatBreaker（core/tool-dedupe，已关单），两卡阈值语义互补不重叠。
 * - GoalDriver：持久化目标状态机。Goal { id, text, state, rounds, checkpoint }，
 *   三原语 createGoal/updateGoal/getGoal（模型工具面语义）+ nextRound(goal)
 *   续行决策：目标未达（判定函数注入）且 rounds<maxRounds → 生成确定性续行
 *   prompt（"继续目标:…已完成 X,剩余 Y"）；达成 → done + 完成摘要；
 *   maxRounds 耗尽 → 停止自动续行（state 不变，等待用户指示）。
 *
 * 接缝①（存储，工单钉死）：Goal 持久化经注入 KVStore 端口，接口同 BI-02.3
 * Outbox 形态（get/set/delete/scan，结构类型与 core/auth/off-peak-service 的
 * KVStore 逐成员兼容，注入即可互换）。生产绑定 BI-03 SQLite 底座（宿主装配
 * 注入），本模块永不私建存储；测试注入内存实现。
 *
 * 跨包复用（工单明示）：同参判重哈希 import core tool-dedupe 的 canonicalHash
 * （toolName 参与哈希——不同工具同形参数不互判重复）。workflow 未声明 @bi/core
 * 依赖且 package.json 冻结禁改，故按包内相对路径 import（bun/tsc 同程序解析，
 * 零外部 npm 依赖不变）。
 */
import { canonicalHash } from "../../core/src/tool/tool-dedupe";

/* ------------------------------------------------------------------ */
/* RepeatReminder：per 工具连续同参软提醒                                */
/* ------------------------------------------------------------------ */

export interface RepeatReminderOptions {
  /** 连续第 N 次同参调用注入首次提醒（默认 3）。 */
  readonly firstAt?: number;
  /** 连续第 M 次同参调用注入升级提醒（默认 5；≥firstAt 钳制）。 */
  readonly escalateAt?: number;
}

/** 渐进提醒话术（软提醒一：陈述新信息）。 */
export function repeatFirstMessage(tool: string, count: number): string {
  return (
    `[重复调用提醒] ${tool} 已连续 ${count} 次以相同参数调用，` +
    "若上一次结果未变，本次大概率仍不变：请调整参数、更换工具，" +
    "或先用一句话陈述本次预期新增的信息。"
  );
}

/** 渐进提醒话术（软提醒二：停止该序列）。 */
export function repeatEscalateMessage(tool: string, count: number): string {
  return (
    `[重复调用升级提醒] ${tool} 已连续 ${count} 次同参调用且无进展。` +
    "请立即停止该调用序列：改换策略、终结该方向，或向用户汇报阻塞。"
  );
}

/** per 工具计数槽。 */
interface RepeatSlot {
  hash: string;
  count: number;
}

export class RepeatReminder {
  readonly #firstAt: number;
  readonly #escalateAt: number;
  readonly #slots = new Map<string, RepeatSlot>();

  constructor(options: RepeatReminderOptions = {}) {
    this.#firstAt = Math.max(1, options.firstAt ?? 3);
    this.#escalateAt = Math.max(this.#firstAt, options.escalateAt ?? 5);
  }

  /**
   * 记一次调用并给出软提醒裁决：
   * - 规范化哈希（canonicalHash(tool, args)，toolName 参与）相同 → 计数累加；
   * - 同工具异参 / 首调 → 计数重置为 1；
   * - count ≥ escalateAt → 升级提醒（持续，模型明显未听劝）；
   * - count === firstAt（且未达升级阈值）→ 首次提醒；
   * - 其余 → null（不打扰 prompt）。
   */
  record(tool: string, args: unknown): string | null {
    const hash = canonicalHash(tool, args);
    const prior = this.#slots.get(tool);
    const count = prior !== undefined && prior.hash === hash ? prior.count + 1 : 1;
    this.#slots.set(tool, { hash, count });
    if (count >= this.#escalateAt) return repeatEscalateMessage(tool, count);
    if (count === this.#firstAt) return repeatFirstMessage(tool, count);
    return null;
  }

  /** 查询某工具当前连续同参计数（观测用）。 */
  countOf(tool: string): number {
    return this.#slots.get(tool)?.count ?? 0;
  }

  /** 手动清账：不传 tool 清全部（新用户输入/回合边界）；传 tool 只清该工具。 */
  reset(tool?: string): void {
    if (tool === undefined) this.#slots.clear();
    else this.#slots.delete(tool);
  }
}

/* ------------------------------------------------------------------ */
/* GoalDriver：持久化目标状态机                                          */
/* ------------------------------------------------------------------ */

export type GoalState = "active" | "paused" | "done" | "abandoned";

export interface Goal {
  id: string;
  text: string;
  state: GoalState;
  /** 已完成续行轮数（nextRound 累进并持久化）。 */
  rounds: number;
  checkpoint?: string;
  createdAt: number;
  updatedAt: number;
}

export type GoalPatch = Partial<Pick<Goal, "text" | "state" | "checkpoint" | "rounds">>;

export interface RoundDecision {
  continue: boolean;
  prompt: string;
}

/**
 * KVStore 端口——接口同 BI-02.3 Outbox 形态（get/set/delete/scan）。
 * 生产绑定 BI-03 SQLite 底座（接缝①：宿主装配注入）；测试注入内存实现。
 */
export interface GoalKVStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  scan(prefix: string): Promise<Array<{ key: string; value: string }>>;
}

export type GoalErrorCode = "unknown-goal" | "invalid-transition" | "invalid-goal";

/** GoalDriver 结构化错误（判别方式：code 字段）。 */
export class GoalError extends Error {
  readonly code: GoalErrorCode;

  constructor(code: GoalErrorCode, message: string) {
    super(message);
    this.name = "GoalError";
    this.code = code;
  }
}

/** 状态机合法转移表：done / abandoned 为无出边终态。 */
export const GOAL_TRANSITIONS: Readonly<Record<GoalState, readonly GoalState[]>> = {
  active: ["active", "paused", "done", "abandoned"],
  paused: ["active", "paused", "done", "abandoned"],
  done: ["done"],
  abandoned: ["abandoned"],
};

/** Goal 记录在 KVStore 中的键前缀。 */
export const GOAL_KEY_PREFIX = "bi:goal:";

export interface GoalDriverOptions {
  /** 目标达成判定函数（注入）；缺省恒 false（仅经 updateGoal 显式置 done）。 */
  readonly judge?: (goal: Goal) => boolean;
  /** 单目标最大续行轮数（默认 10，≥1）。 */
  readonly maxRounds?: number;
  readonly now?: () => number;
  readonly idGen?: () => string;
}

/** 缺省 id 生成：实例内单调 goal-1、goal-2…（确定性，测试友好）。 */
function defaultGoalIdGen(): () => string {
  let n = 0;
  return () => `goal-${++n}`;
}

export class GoalDriver {
  readonly #kv: GoalKVStore;
  readonly #judge: (goal: Goal) => boolean;
  readonly #maxRounds: number;
  readonly #now: () => number;
  readonly #idGen: () => string;

  constructor(kv: GoalKVStore, options: GoalDriverOptions = {}) {
    this.#kv = kv;
    this.#judge = options.judge ?? (() => false);
    this.#maxRounds = Math.max(1, Math.trunc(options.maxRounds ?? 10));
    this.#now = options.now ?? (() => Date.now());
    this.#idGen = options.idGen ?? defaultGoalIdGen();
  }

  /** 三原语之一：创建目标（state=active、rounds=0）。空文本结构化拒绝。 */
  async createGoal(text: string, checkpoint?: string): Promise<Goal> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new GoalError("invalid-goal", "目标文本须为非空字符串");
    }
    const now = this.#now();
    const goal: Goal = {
      id: this.#idGen(),
      text,
      state: "active",
      rounds: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (checkpoint !== undefined) goal.checkpoint = checkpoint;
    await this.#put(goal);
    return structuredClone(goal);
  }

  /**
   * 三原语之二：补丁式更新。state 转移经合法边表校验
   * （done/abandoned 终态不可出边）；未知 id / 非法转移结构化拒绝。
   */
  async updateGoal(id: string, patch: GoalPatch): Promise<Goal> {
    const current = await this.getGoal(id);
    if (current === null) {
      throw new GoalError("unknown-goal", `未知目标: ${id}`);
    }
    if (patch.state !== undefined && !GOAL_TRANSITIONS[current.state].includes(patch.state)) {
      throw new GoalError(
        "invalid-transition",
        `非法状态转移: ${current.state} → ${patch.state}（终态无出边）`,
      );
    }
    if (patch.text !== undefined) {
      if (typeof patch.text !== "string" || patch.text.trim().length === 0) {
        throw new GoalError("invalid-goal", "目标文本须为非空字符串");
      }
      current.text = patch.text;
    }
    if (patch.checkpoint !== undefined) current.checkpoint = patch.checkpoint;
    if (patch.rounds !== undefined) {
      if (!Number.isInteger(patch.rounds) || patch.rounds < 0) {
        throw new GoalError("invalid-goal", `rounds 须为非负整数: ${patch.rounds}`);
      }
      current.rounds = patch.rounds;
    }
    if (patch.state !== undefined) current.state = patch.state;
    current.updatedAt = this.#now();
    await this.#put(current);
    return current;
  }

  /** 三原语之三：按 id 读取（缺失返回 null）。 */
  async getGoal(id: string): Promise<Goal | null> {
    const raw = await this.#kv.get(GOAL_KEY_PREFIX + id);
    if (raw === undefined) return null;
    return JSON.parse(raw) as Goal;
  }

  /** 全量目标列表（scan 端口消费；按 createdAt 升序稳定排序）。 */
  async listGoals(): Promise<Goal[]> {
    const rows = await this.#kv.scan(GOAL_KEY_PREFIX);
    const goals = rows.map((row) => JSON.parse(row.value) as Goal);
    goals.sort((a, b) => (a.createdAt - b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return goals;
  }

  /**
   * 续行决策（运行环每轮收尾调用）：
   * - paused/abandoned → 不续行、不增轮（等待恢复/用户指示）；
   * - 已 done → 幂等返回完成摘要；
   * - rounds ≥ maxRounds → 耗尽停止（state 不变，不再增轮）；
   * - judge 达成 → 落 done + 完成摘要；
   * - 否则 rounds+1 并持久化，生成确定性续行 prompt。
   * 传入 goal 须为调用方持有的最新态（getGoal/updateGoal 返回值）；
   * 变更一律经 KVStore 持久化。
   */
  async nextRound(goal: Goal): Promise<RoundDecision> {
    if (goal.state === "paused" || goal.state === "abandoned") {
      return {
        continue: false,
        prompt: `目标处于 ${goal.state} 状态，不自动续行: ${goal.text}`,
      };
    }
    if (goal.state === "done") {
      return { continue: false, prompt: this.#summary(goal) };
    }
    if (goal.rounds >= this.#maxRounds) {
      return { continue: false, prompt: this.#exhausted(goal.rounds, goal.text) };
    }
    const rounds = goal.rounds + 1;
    if (this.#judge(goal)) {
      const done = await this.updateGoal(goal.id, { state: "done", rounds });
      return { continue: false, prompt: this.#summary(done) };
    }
    await this.updateGoal(goal.id, { rounds });
    if (rounds >= this.#maxRounds) {
      return { continue: false, prompt: this.#exhausted(rounds, goal.text) };
    }
    return {
      continue: true,
      prompt: `继续目标: ${goal.text}（已完成 ${rounds} 轮，剩余 ${this.#maxRounds - rounds} 轮）`,
    };
  }

  #summary(goal: Goal): string {
    return `目标已完成: ${goal.text}（共 ${goal.rounds} 轮）`;
  }

  #exhausted(rounds: number, text: string): string {
    return (
      `目标未达成且已达最大轮数 ${this.#maxRounds}（已完成 ${rounds} 轮）: ` +
      `${text}；停止自动续行，等待用户指示。`
    );
  }

  async #put(goal: Goal): Promise<void> {
    await this.#kv.set(GOAL_KEY_PREFIX + goal.id, JSON.stringify(goal));
  }
}
