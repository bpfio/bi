/**
 * 离线阴影会话回放与非回归验证引擎（BI-03.6，差异工单）：`ShadowReplay`。
 *
 * 定位：本卡是 BI-00.2 升级追踪循环的回归门（大典增量吸收前置）；
 * 轨迹格式与 BI-21.3 评测共享，权威 Schema 备案见 ./trajectory.ts
 * （TrajectoryEntry = SessionEntry 超集 + modelResponse 时序标记）。
 *
 * 回放原则（0 真实 API、0 副作用）：
 *  - 本模块不 import 任何真实工具注册表/模型客户端；工具调用一律由
 *    注入的 toolStubs 纯函数沙箱存根接管，模型响应一律由注入的
 *    responseSequencer 提供——缺注入即无法产生真实副作用。
 *
 * 逐条重演语义：
 *  - user 条目：prompt 输入一致——注入 promptSource 时逐条比对（缺省无独立
 *    输入源，离线重放输入一致性由轨迹本身保证，仅计步）；
 *  - assistant 条目（模型决策点，含 modelResponse 标记）：比对「tool 选择序列」
 *    （payload.toolCalls 的 name+args 规范 JSON）与新实现输出
 *    （responseSequencer 供给）。仅断言决策，不断言措辞文本（LLM 非确定性，
 *    文本自由）；未注入 sequencer 时决策点只计步不比对；
 *  - tool_call 条目：改由 stub 响应（stub(args) 结果即影子工具结果，不做
 *    结果比对——结果环境相关）；无对应存根 → missing-stub 分歧；
 *  - tool_result/system/compaction：结构重演，只计步。
 *
 * 非回归门：assertNoRegression(threshold) = 差异率（divergences/decisionSteps）
 * 不超过阈值即放行（ok 字段）；发布前非回归校验的升级阻断由调用方依据 ok 裁决。
 * 空轨迹（decisionSteps=0）差异率定义为 0（无决策点即无从回归）。
 */
import { readFileSync } from "node:fs";
import { parseTrajectoryContent } from "./trajectory";
import type { TrajectoryEntry } from "./trajectory";
import type { JsonValue } from "./types";

/** 新实现在决策点给出的响应（影子模型输出）。 */
export interface ReplayModelResponse {
  text?: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
}

export type ReplayDivergenceKind =
  | "prompt-mismatch"
  | "decision-mismatch"
  | "missing-stub"
  | "sequencer-exhausted"
  | "extra-decision";

export interface ReplayDivergence {
  /** 轨迹条目 seq（extra-decision 为虚拟步号 = steps + 序数）。 */
  step: number;
  kind: ReplayDivergenceKind;
  expected: string;
  actual: string;
}

export interface ReplayReport {
  passed: boolean;
  /** 重演轨迹条目数。 */
  steps: number;
  /** 模型决策点数（assistant 条目）。 */
  decisionSteps: number;
  divergences: ReplayDivergence[];
}

export interface ShadowReplayOptions {
  trajectoryPath: string;
  /** 沙箱存根接管工具：name -> 纯函数（影子工具，0 副作用由注入方保证）。 */
  toolStubs?: Record<string, (args: unknown) => unknown>;
  /** 注入回放模型响应时序（新实现输出，逐决策点消耗；undefined = 耗尽）。 */
  responseSequencer?: () => ReplayModelResponse | undefined;
  /** 可选：新实现的 prompt 输入流（逐 user 条目比对；缺省不比对）。 */
  promptSource?: () => string | undefined;
}

/** 规范 JSON：键递归排序，规避键序差异造成的伪分歧。 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** 从 assistant payload 提取决策的 tool 选择序列（Golden Schema: { toolCalls?: [...] }）。 */
function extractToolCalls(payload: JsonValue): Array<{ name: string; args: unknown }> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const toolCalls = (payload as Record<string, unknown>).toolCalls;
  if (!Array.isArray(toolCalls)) return [];
  const out: Array<{ name: string; args: unknown }> = [];
  for (const call of toolCalls) {
    if (typeof call !== "object" || call === null || Array.isArray(call)) continue;
    const c = call as Record<string, unknown>;
    if (typeof c.name !== "string") continue;
    out.push({ name: c.name, args: c.args });
  }
  return out;
}

/** 从 user payload 提取 prompt 文本（Golden Schema: { text: string }）。 */
function extractPromptText(payload: JsonValue): string {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/** tool_call payload 的 args（Golden Schema: { args: JsonValue }）。 */
function extractToolArgs(payload: JsonValue): unknown {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return (payload as Record<string, unknown>).args;
  }
  return null;
}

export class ShadowReplay {
  readonly #options: ShadowReplayOptions;

  constructor(options: ShadowReplayOptions) {
    this.#options = options;
  }

  /**
   * 逐条重演 Golden 轨迹，输出结构化分歧报告（passed = 零分歧）。
   * 同步 API（工单签名）：轨迹须已录制完毕；同步加载复用 trajectory.ts
   * 的权威 Schema 解析器。可重复调用（每次重新读盘重演）。
   */
  replay(): ReplayReport {
    let text: string;
    try {
      text = readFileSync(this.#options.trajectoryPath, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // 空轨迹/缺文件：无可重演内容，视为通过（与空语料语义一致）。
        return { passed: true, steps: 0, decisionSteps: 0, divergences: [] };
      }
      throw error;
    }
    const entries = parseTrajectoryContent(this.#options.trajectoryPath, text);

    const divergences: ReplayDivergence[] = [];
    let steps = 0;
    let decisionSteps = 0;
    let extraDecisions = 0;

    for (const entry of entries) {
      steps += 1;
      switch (entry.type) {
        case "user": {
          if (this.#options.promptSource === undefined) break;
          const expected = extractPromptText(entry.payload);
          const actual = this.#options.promptSource();
          if (actual !== expected) {
            divergences.push({
              step: entry.seq,
              kind: "prompt-mismatch",
              expected,
              actual: actual ?? "undefined",
            });
          }
          break;
        }
        case "assistant": {
          decisionSteps += 1;
          const sequencer = this.#options.responseSequencer;
          if (sequencer === undefined) break; // 未注入新实现输出：只计步不比对
          const expectedCalls = extractToolCalls(entry.payload);
          const actual = sequencer();
          if (actual === undefined) {
            divergences.push({
              step: entry.seq,
              kind: "sequencer-exhausted",
              expected: canonicalJson(expectedCalls),
              actual: "undefined",
            });
            break;
          }
          const actualCalls = actual.toolCalls ?? [];
          if (canonicalJson(expectedCalls) !== canonicalJson(actualCalls)) {
            divergences.push({
              step: entry.seq,
              kind: "decision-mismatch",
              expected: canonicalJson(expectedCalls),
              actual: canonicalJson(actualCalls),
            });
          }
          break;
        }
        case "tool_call": {
          const toolName = entry.toolName ?? "";
          const stub = this.#options.toolStubs?.[toolName];
          if (stub === undefined) {
            divergences.push({
              step: entry.seq,
              kind: "missing-stub",
              expected: `沙箱存根 toolStubs["${toolName}"]`,
              actual: "undefined",
            });
            break;
          }
          stub(extractToolArgs(entry.payload)); // 影子执行：结果即影子工具结果，不做比对
          break;
        }
        default:
          // tool_result / system / compaction：结构重演，只计步。
          break;
      }
    }

    // 决策点走完后仍有多余的新实现响应 → extra-decision（逐条 drains）。
    const sequencer = this.#options.responseSequencer;
    if (sequencer !== undefined) {
      for (;;) {
        const extra = sequencer();
        if (extra === undefined) break;
        extraDecisions += 1;
        divergences.push({
          step: steps + extraDecisions,
          kind: "extra-decision",
          expected: "无更多决策点",
          actual: canonicalJson(extra.toolCalls ?? []),
        });
      }
    }

    return { passed: divergences.length === 0, steps, decisionSteps, divergences };
  }

  /**
   * 差异率阈值门：rate = divergences / decisionSteps（决策点为 0 时，
   * 有分歧记 1、无分歧记 0）。ok=false 即发布前非回归校验不通过，
   * 升级路径由调用方阻断。
   */
  assertNoRegression(threshold: number): { ok: boolean; rate: number; threshold: number } {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError(`threshold 须为 [0, 1] 内的有限数: ${threshold}`);
    }
    const report = this.replay();
    const rate =
      report.decisionSteps > 0
        ? report.divergences.length / report.decisionSteps
        : report.divergences.length > 0
          ? 1
          : 0;
    return { ok: rate <= threshold, rate, threshold };
  }
}
