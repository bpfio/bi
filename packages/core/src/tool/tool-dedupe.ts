/**
 * BI-07.13 · 规范哈希工具调用排重器与三阶反驳循环打断门。
 *
 * 职责（工单钉死）：
 * - canonicalHash：对工具调用参数做 canonical 规范化（对象键递归按码点序排序、
 *   数组保持序）→ 稳定 JSON → SHA-256 hex；拦截多轮内对相同物理文件或命令的
 *   重复无意义调用并返回缓存结果（ToolDedupe）；
 * - RepeatBreaker：三阶渐进式反驳打断门——第 1 阶强制单句陈述预期新增信息；
 *   第 2 阶证伪检查/终结/提出缺失决策问题；第 3 阶硬阻断后续一切工具调用、
 *   强制直出文本，彻底消灭死循环与 Token 费用浪费。
 *
 * 与 BI-07.5 的边界（工单钉死）：本卡是**硬门**——结构化 verdict 由 AgentLoop
 * 消费，tier 3 直接短路工具执行；BI-07.5 是**软提醒**——只向模型注入提示文本，
 * 不拦截任何调用。
 *
 * 放置说明：devplan 原列 guard/repeat-breaker.ts，按本工单并入本文件（同域就近：
 * 与 canonicalHash 共用规范化管线，避免双实现漂移）。
 *
 * 缓存语义（ToolDedupe）：
 * - 滑动窗口默认最近 10 次调用（windowSize 可注入）；窗口按调用序记录所有工具；
 * - 仅"只读名单"内的工具会命中缓存（duplicate=true + cachedResult）；
 *   只读名单可注入，缺省为空集（核心层中立：未声明的工具一律按写类从紧处理，
 *   宁可不缓存，不可误缓存）；
 * - 写类工具永不缓存：重复写必须走 BI-07.2 的 Read-Before-Write 门禁重校磁盘，
 *   在此短路写调用会绕过 mtime 防脏写看门狗；
 * - duplicate 命中不重复入窗（原条目继续驻留至被挤出）；recordResult 回填最近
 *   一次同哈希未决条目，未回填时 duplicate 仍成立、cachedResult 为 undefined。
 *
 * 计数语义（RepeatBreaker，per 工具）：
 * - 规范化参数哈希相同即一次重复，计数累加；不同参数哈希重置计数为 1；
 * - 阈值：计数 ≥3 → 阶 1 remind；≥5 → 阶 2 challenge；≥8 → 阶 3 block；
 *   阈值均可注入覆盖；三阶 message 与工单逐字一致，tool/count 单列供装配层排版。
 */
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ */
/* canonical 规范化与稳定哈希                                           */
/* ------------------------------------------------------------------ */

/**
 * 码点序比较（不同于 JS 默认 sort 的 UTF-16 码元序）：逐码点比较，
 * 前缀短者在前。键排序必须用它，否则 BMP 外字符（emoji 等）与 U+E000-U+FFFF
 * 区字符的相对次序会偏离码点序，破坏"码点序"钉死语义。
 */
export function compareCodePointOrder(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  const aDone = i >= a.length;
  const bDone = j >= b.length;
  if (aDone && bDone) return 0;
  return aDone ? -1 : 1;
}

/**
 * canonical JSON 序列化：
 * - 对象键按码点序递归排序；数组保持原始顺序；
 * - undefined 属性值跳过（JSON 语义）；数组中的 undefined 落为 null；
 * - bigint 以十进制字符串形式编码（模型工具参数来自 JSON，正常不含 bigint，
 *   防御性兜底；与字符串字面量理论上可碰撞，接受该已知边界）；
 * - function / symbol 属非法工具参数，抛 TypeError（绝不静默吞）；
 * - number 沿用 JSON.stringify（NaN/Infinity → null）。
 * 输出为稳定字符串：同一逻辑值无论键插入序如何，输出恒一致。
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "undefined":
      return "null";
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        return `[${value.map((item) => serializeCanonical(item)).join(",")}]`;
      }
      if (value instanceof Date) {
        return JSON.stringify(value.toISOString());
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([ka], [kb]) => compareCodePointOrder(ka, kb))
        .map(([k, v]) => `${JSON.stringify(k)}:${serializeCanonical(v)}`);
      return `{${entries.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value type: ${typeof value}`);
  }
}

/**
 * 工具调用的规范哈希：SHA-256(toolName + "\0" + canonicalJson(args))。
 * toolName 参与哈希——不同工具的同形参数不得互判重复。
 */
export function canonicalHash(toolName: string, args: unknown): string {
  return createHash("sha256").update(`${toolName}\0${canonicalJson(args)}`).digest("hex");
}

/* ------------------------------------------------------------------ */
/* ToolDedupe：滑动窗口排重 + 只读缓存                                  */
/* ------------------------------------------------------------------ */

export interface ToolDedupeOptions {
  /** 滑动窗口大小（默认最近 10 次调用）。 */
  readonly windowSize?: number;
  /** 只读工具名单（可注入；缺省空集——未声明一律按写类从紧处理）。 */
  readonly readOnlyTools?: Iterable<string>;
}

export interface DedupeVerdict {
  /** 是否为窗口内的只读重复调用。 */
  readonly duplicate: boolean;
  /** 命中时回放的历史结果（未 recordResult 过则为 undefined）。 */
  readonly cachedResult?: unknown;
}

/** 窗口条目：一次调用（含被挤出前的结果槽）。 */
interface DedupeEntry {
  readonly hash: string;
  readonly isReadOnly: boolean;
  hasResult: boolean;
  result: unknown;
}

export class ToolDedupe {
  readonly #windowSize: number;
  readonly #readOnly: ReadonlySet<string>;
  readonly #window: DedupeEntry[] = [];

  constructor(options: ToolDedupeOptions = {}) {
    this.#windowSize = Math.max(1, options.windowSize ?? 10);
    this.#readOnly = new Set(options.readOnlyTools ?? []);
  }

  /**
   * 执行前检查：
   * - 只读工具且窗口内存在同哈希条目 → { duplicate: true, cachedResult }（不重复入窗）；
   * - 其余（写类/新调用）→ { duplicate: false }，并作为一次调用入窗（挤出最老条目）。
   */
  check(toolName: string, args: unknown): DedupeVerdict {
    const hash = canonicalHash(toolName, args);
    const isReadOnly = this.#readOnly.has(toolName);
    if (isReadOnly) {
      // 从最新向最老找同哈希只读条目。
      for (let i = this.#window.length - 1; i >= 0; i--) {
        const entry = this.#window[i]!;
        if (entry.isReadOnly && entry.hash === hash) {
          return entry.hasResult
            ? { duplicate: true, cachedResult: entry.result }
            : { duplicate: true };
        }
      }
    }
    this.#push({ hash, isReadOnly, hasResult: false, result: undefined });
    return { duplicate: false };
  }

  /** 回填最近一次同哈希未决条目的执行结果（执行成功后调用）。 */
  recordResult(toolName: string, args: unknown, result: unknown): void {
    const hash = canonicalHash(toolName, args);
    for (let i = this.#window.length - 1; i >= 0; i--) {
      const entry = this.#window[i]!;
      if (entry.hash === hash && !entry.hasResult) {
        entry.hasResult = true;
        entry.result = result;
        return;
      }
    }
  }

  /** 清空窗口（测试隔离 / 回合边界用）。 */
  reset(): void {
    this.#window.length = 0;
  }

  /** 当前窗口内条目数（观测用）。 */
  get size(): number {
    return this.#window.length;
  }

  #push(entry: DedupeEntry): void {
    this.#window.push(entry);
    if (this.#window.length > this.#windowSize) {
      this.#window.splice(0, this.#window.length - this.#windowSize);
    }
  }
}

/* ------------------------------------------------------------------ */
/* RepeatBreaker：三阶反驳循环打断门                                    */
/* ------------------------------------------------------------------ */

export interface RepeatBreakerOptions {
  /** 阶 1 提醒阈值（默认 3：连续第 3 次同参调用触发）。 */
  readonly remindThreshold?: number;
  /** 阶 2 反驳阈值（默认 5）。 */
  readonly challengeThreshold?: number;
  /** 阶 3 硬阻断阈值（默认 8）。 */
  readonly blockThreshold?: number;
}

export type RepeatAction = "allow" | "remind" | "challenge" | "block";

export interface RepeatVerdict {
  /** 0=放行；1/2/3 对应三阶打断门。 */
  readonly tier: 0 | 1 | 2 | 3;
  readonly action: RepeatAction;
  /** tier ≥1 时的反驳话术（与工单逐字一致）。 */
  readonly message?: string;
  readonly tool: string;
  /** 当前连续同参调用计数（本工具）。 */
  readonly count: number;
}

const TIER1_MESSAGE = "单句陈述本次调用的预期新增信息";
const TIER2_MESSAGE = "证伪检查：若无法给出新增信息，依据现有证据终结或提出缺失决策问题";
const TIER3_MESSAGE = "硬阻断：后续工具调用全部拒绝，强制直出文本";

export class RepeatBreaker {
  readonly #remind: number;
  readonly #challenge: number;
  readonly #block: number;
  /** per 工具的连续同参计数状态。 */
  readonly #counters = new Map<string, { hash: string; count: number }>();

  constructor(options: RepeatBreakerOptions = {}) {
    this.#remind = Math.max(1, options.remindThreshold ?? 3);
    this.#challenge = Math.max(this.#remind, options.challengeThreshold ?? 5);
    this.#block = Math.max(this.#challenge, options.blockThreshold ?? 8);
  }

  /**
   * 记一次调用并给出打断裁决：同参（规范化哈希相同）计数累加，异参重置为 1。
   * 计数落阶即返回对应 verdict；tier 3 由消费方（AgentLoop）短路执行、
   * 强制模型直出文本。
   */
  observe(toolName: string, args: unknown): RepeatVerdict {
    const hash = canonicalHash(toolName, args);
    const prior = this.#counters.get(toolName);
    const state =
      prior !== undefined && prior.hash === hash
        ? { hash, count: prior.count + 1 }
        : { hash, count: 1 };
    this.#counters.set(toolName, state);
    return this.#verdict(toolName, state.count);
  }

  /** 手动清账：不传 tool 清全部（回合边界）；传 tool 只清该工具。 */
  reset(tool?: string): void {
    if (tool === undefined) this.#counters.clear();
    else this.#counters.delete(tool);
  }

  #verdict(tool: string, count: number): RepeatVerdict {
    if (count >= this.#block) {
      return { tier: 3, action: "block", message: TIER3_MESSAGE, tool, count };
    }
    if (count >= this.#challenge) {
      return { tier: 2, action: "challenge", message: TIER2_MESSAGE, tool, count };
    }
    if (count >= this.#remind) {
      return { tier: 1, action: "remind", message: TIER1_MESSAGE, tool, count };
    }
    return { tier: 0, action: "allow", tool, count };
  }
}
