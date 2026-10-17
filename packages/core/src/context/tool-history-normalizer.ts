/**
 * 分工声明：10.2（tool-pairing.ts）管切点安全——切在哪
 * （findSafeCut/isCutSafe/sanitize）；本卡管内容规整——补什么
 * （悬挂 system 重排、未闭合 tool_call 补结果、空输出占位、连续重复
 * system 合并）。与 tool-pairing.ts 互补不重叠：本卡不判定切点，10.2
 * 不补内容；先 normalize 后 pairing 恒安全（链式组合契约）。
 *
 * BI-10.4 · 工具历史语法树安全补齐与空值规整看门狗。
 *
 * 四类 Fix（工单钉死）：
 *  ① orphan-system-requeued：悬挂 system 消息（tool_use 未闭合时插入的
 *    system）→ 摘入 held queue，排到最近配对闭合点之后；到结尾仍未闭合
 *    则排到序列末尾。头部 system 与闭合点上的 system 不属悬挂，原位保留
 *    （语义与 10.2 sanitize 的 dangling-system 一致，但产出 typed Fix 且
 *    入口为历史看门狗而非修整时刻）。
 *  ② missing-tool-result-synthesized：未闭合 tool_call（assistant 携带
 *    toolCallId 无对应结果）→ 在该调用之后立即合成 tool 结果消息
 *    `"(Tool result missing)"`（同 toolCallId）。与 10.2 sanitize 的
 *    orphan-result 注入互为镜像：它补无主结果的调用，本卡补无结果的调用。
 *    裁定（偏差）：合成条件放宽为「一切未闭合调用」——含其后跟随普通
 *    assistant 消息的形态；工单描述的「其后无 assistant」截断形态是子集，
 *    行为一致。理由：API 序列合法性要求每个 tool_use 都有结果，放过后
 *    任何切点门禁都要为其回退。
 *  ③ empty-tool-output-filled：工具空输出 `""` → `"(no tool output)"`。
 *    字面空串语义：仅 content === ""，空白串不动（工单钉死字面量）。
 *  ④ duplicate-system-merged：连续（相邻）重复 system 合并，保留首条；
 *    内容相等按稳定序列化深比较（对象键序不敏感）；非相邻重复不合并。
 *
 * 处理序：③ → ② → ① → ④（先补结果再判悬挂：合成结果会使原悬挂 system
 * 落回闭合点；最后合并，可吃到重排后新相邻的重复）。
 *
 * 幂等：normalize(normalize(x)) 的 messages 与 normalize(x) 深相等，且第二
 * 遍 fixes 为空。输入不被改写（返回新数组，未修复消息共享引用）。
 *
 * 签名裁定：入参收紧为 readonly Msg[]（骨架草稿为 unknown[]）——与 10.2
 * Msg 生态（compactor/sanitize）对齐，看门狗不猜测消息形态。
 * Fix.index 语义：该 pass 输出数组坐标；后续 pass（合成/重排/合并）可能
 * 再移位，单修复场景即最终坐标。
 */

import type { Msg } from "./tool-pairing";

export type FixKind =
  | 'orphan-system-requeued'
  | 'missing-tool-result-synthesized'
  | 'empty-tool-output-filled'
  | 'duplicate-system-merged';

export interface Fix {
  kind: FixKind;
  /** 规整发生的消息索引（该 pass 输出坐标，见头注） */
  index: number;
  /** 人类可读的规整说明 */
  detail: string;
}

export interface NormalizeResult {
  /** 规整后的消息数组（新数组，不改入参） */
  messages: Msg[];
  /** 本轮施加的全部规整动作 */
  fixes: Fix[];
}

const MISSING_RESULT = "(Tool result missing)";
const NO_OUTPUT = "(no tool output)";

/** 内容相等：严格相等或稳定序列化相等（对象内容键序不敏感深比较）。 */
function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

/** 键序不敏感的确定性序列化（对象键排序，数组保序，循环引用走异常路径）。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`);
  return `{${entries.join(",")}}`;
}

/** pass ③：工具空输出 `""` → `"(no tool output)"`。 */
function fillEmptyOutputs(msgs: readonly Msg[], fixes: Fix[]): Msg[] {
  return msgs.map((m, i) => {
    if (m.role === "tool" && m.content === "") {
      fixes.push({
        kind: "empty-tool-output-filled",
        index: i,
        detail: `tool 输出为空串，已填充占位 ${NO_OUTPUT}`,
      });
      return { ...m, content: NO_OUTPUT };
    }
    return m;
  });
}

/** pass ②：为一切未闭合 tool_call 立即合成缺失结果（FIFO 配对判定）。 */
function synthesizeMissingResults(msgs: readonly Msg[], fixes: Fix[]): Msg[] {
  // 先扫描：记录每个调用出现的下标队列，结果按 FIFO 消费。
  const queueById = new Map<string, number[]>();
  msgs.forEach((m, i) => {
    if (m.role === "assistant" && typeof m.toolCallId === "string") {
      const q = queueById.get(m.toolCallId);
      if (q === undefined) queueById.set(m.toolCallId, [i]);
      else q.push(i);
    } else if (m.role === "tool") {
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const q = queueById.get(id);
      if (q !== undefined && q.length > 0) q.shift();
    }
  });
  const unclosed = new Set<number>();
  for (const idxs of queueById.values()) {
    for (const i of idxs) unclosed.add(i);
  }
  if (unclosed.size === 0) return [...msgs];

  // 再重建：未闭合调用之后立即插入合成结果。
  const out: Msg[] = [];
  msgs.forEach((m, i) => {
    out.push(m);
    if (unclosed.has(i)) {
      out.push({ role: "tool", toolCallId: m.toolCallId as string, content: MISSING_RESULT });
      fixes.push({
        kind: "missing-tool-result-synthesized",
        index: out.length - 1,
        detail: `tool_call ${String(m.toolCallId)} 无对应结果，已合成 ${MISSING_RESULT}`,
      });
    }
  });
  return out;
}

/** pass ①：悬挂 system 摘入 held queue，排到最近闭合点之后。 */
function requeueDanglingSystems(msgs: readonly Msg[], fixes: Fix[]): Msg[] {
  const out: Msg[] = [];
  const held: Array<{ msg: Msg; from: number }> = [];
  const openById = new Map<string, number>();
  let openCount = 0;

  const flushHeld = (): void => {
    for (const h of held) {
      fixes.push({
        kind: "orphan-system-requeued",
        index: out.length,
        detail: `悬挂 system（原位 ${h.from}）移至最近配对闭合点之后`,
      });
      out.push(h.msg);
    }
    held.length = 0;
  };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as Msg;
    if (m.role === "system" && openCount > 0) {
      held.push({ msg: m, from: i });
      continue;
    }
    out.push(m);
    if (m.role === "assistant" && typeof m.toolCallId === "string") {
      openById.set(m.toolCallId, (openById.get(m.toolCallId) ?? 0) + 1);
      openCount++;
    } else if (m.role === "tool") {
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const remaining = openById.get(id) ?? 0;
      if (remaining > 0) {
        if (remaining === 1) openById.delete(id);
        else openById.set(id, remaining - 1);
        openCount--;
      }
    }
    if (openCount === 0 && held.length > 0) flushHeld();
  }
  if (held.length > 0) flushHeld(); // 到结尾仍未闭合：兜底排到序列末尾
  return out;
}

/** pass ④：相邻重复 system 合并（保留首条，内容按 JSON 序列化比较）。 */
function mergeConsecutiveSystems(msgs: readonly Msg[], fixes: Fix[]): Msg[] {
  const out: Msg[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (m.role === "system" && last !== undefined && last.role === "system" && sameContent(last.content, m.content)) {
      fixes.push({
        kind: "duplicate-system-merged",
        index: out.length - 1,
        detail: "相邻重复 system 消息已并入前一条（保留首条）",
      });
      continue;
    }
    out.push(m);
  }
  return out;
}

/** 工具历史语法树安全补齐与空值规整（幂等：normalize(normalize(x)) == normalize(x)）。 */
export function normalizeHistory(msgs: readonly Msg[]): NormalizeResult {
  const fixes: Fix[] = [];
  let cur: Msg[] = [...msgs]; // 不改写入参
  cur = fillEmptyOutputs(cur, fixes); // ③
  cur = synthesizeMissingResults(cur, fixes); // ②
  cur = requeueDanglingSystems(cur, fixes); // ①
  cur = mergeConsecutiveSystems(cur, fixes); // ④
  return { messages: cur, fixes };
}
