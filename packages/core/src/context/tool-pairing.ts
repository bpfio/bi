/**
 * BI-10.2 · 工具调用原子配对门禁与语法树级消息修整器。
 *
 * 配对模型（轻量 Msg 形态，对齐 BI-03 SessionEntry 的兼容字段）：
 *  - assistant 消息携带 toolCallId 视为一次 tool_use；
 *  - role="tool" 且 toolCallId 相同的消息视为其结果；
 *  - 一个前缀 msgs[0..i] "配平"当且仅当：截至目前每个 tool_use 都已被应答、
 *    每条 tool 结果都能在**同前缀内**找到发起调用。
 *
 * 计数语义（钉死）：
 *  - open：已发起但尚未应答的 tool_use 数（按 toolCallId 多重集匹配，支持
 *    交错发起/交错应答与同 id 多重调用）；
 *  - orphan：无主结果数——tool 结果在其所在前缀内找不到匹配的未闭合调用
 *    （含"结果先于调用"与"调用从未出现"两种形态；role="tool" 但缺失
 *    toolCallId 的消息同样计 orphan）。
 *
 * 切点安全性：cutIndex = 保留前缀长度。前缀边界处 open=0 且 orphan=0 时，
 * 前缀与后缀各自自洽（前缀没有悬空等待后缀应答的调用，后缀也没有需要
 * 前缀兜底的无主结果）——此为唯一安全形态。
 */

export type MsgRole = "user" | "assistant" | "tool" | "system";

/** 轻量消息形态，兼容 BI-03 session 引擎的类型（SessionEntry 配对预留字段）。 */
export interface Msg {
  role: MsgRole;
  /** tool_use 与其结果共用的配对 id（对齐 BI-03 预留字段）。 */
  toolCallId?: string;
  /** 触发的工具名（对齐 BI-03 预留字段；BI-09 脱水摘要取用）。 */
  toolName?: string;
  content: unknown;
}

/** 单个前缀边界的配对计数。 */
export interface PrefixBalance {
  /** 前缀长度（已扫描消息数）。 */
  index: number;
  /** 未闭合 tool_use 数。 */
  open: number;
  /** 无主结果数。 */
  orphan: number;
}

export interface BalanceReport {
  /** 每个前缀长度 0..msgs.length 的计数（共 n+1 条，index 连续）。 */
  prefixes: PrefixBalance[];
  /** 扫描结束时的计数。 */
  final: PrefixBalance;
  /** 整条序列是否配平（open 与 orphan 同时为 0）。 */
  balanced: boolean;
}

/** 前缀和扫描：对每个前缀输出 {open, orphan}。 */
export function pairingBalance(msgs: Msg[]): BalanceReport {
  const prefixes: PrefixBalance[] = [{ index: 0, open: 0, orphan: 0 }];
  // toolCallId → 该 id 当前未闭合调用数（多重集，支持同 id 多重与交错）。
  const openById = new Map<string, number>();
  let open = 0;
  let orphan = 0;

  msgs.forEach((m, i) => {
    if (m.role === "assistant" && typeof m.toolCallId === "string") {
      openById.set(m.toolCallId, (openById.get(m.toolCallId) ?? 0) + 1);
      open++;
    } else if (m.role === "tool") {
      // 缺失 toolCallId 的结果以空串参与匹配（无法与真实调用配对 → orphan）。
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const remaining = openById.get(id) ?? 0;
      if (remaining > 0) {
        if (remaining === 1) openById.delete(id);
        else openById.set(id, remaining - 1);
        open--;
      } else {
        orphan++;
      }
    }
    prefixes.push({ index: i + 1, open, orphan });
  });

  const final = prefixes[prefixes.length - 1] as PrefixBalance;
  return { prefixes, final, balanced: final.open === 0 && final.orphan === 0 };
}

/** 边界计数归零（open=0 且 orphan=0）即安全切点；越界/非整数切点不安全。 */
export function isCutSafe(msgs: Msg[], cutIndex: number): boolean {
  if (!Number.isInteger(cutIndex) || cutIndex < 0 || cutIndex > msgs.length) {
    return false;
  }
  return pairingBalance(msgs.slice(0, cutIndex)).balanced;
}

/** 从 preferred 向回搜索最近安全切点；空前缀（0）恒安全，故必然有解。 */
export function findSafeCut(msgs: Msg[], preferred: number): number {
  const report = pairingBalance(msgs);
  const start = Number.isFinite(preferred)
    ? Math.max(0, Math.min(Math.floor(preferred), msgs.length))
    : msgs.length;
  for (let i = start; i >= 0; i--) {
    const p = report.prefixes[i];
    if (p !== undefined && p.open === 0 && p.orphan === 0) return i;
  }
  return 0;
}

export interface SanitizeResult {
  messages: Msg[];
  /** 每次修整一条稳定格式记录：`<类别>:<id>:<动作>`。 */
  fixes: string[];
}

/**
 * 三类修整（工单钉死）：
 *  1. 无主 tool 结果 → 在其前注入合成 assistant tool_use
 *     `"(Tool result missing)"`（携带同一 toolCallId，注入后立即配平）；
 *  2. 空工具输出 `""` → 替换为 `"(no tool output)"`；
 *  3. 悬挂系统消息（处于未闭合配对中间的 system）→ 摘出排队，移动到最近
 *     配对闭合点之后；到结尾仍未闭合则排到序列末尾。闭合点上的中途 system
 *     消息与头部 system 消息不属"悬挂"，原位保留。
 *
 * 未闭合调用（结尾悬挂的 tool_use）不在本卡修整范围（工单只列三类）。
 */
export function sanitize(messages: Msg[]): SanitizeResult {
  const fixes: string[] = [];

  // ── 第一遍：无主结果注入 + 空输出占位 ────────────────────────────────
  const pass1: Msg[] = [];
  const openById = new Map<string, number>();
  for (const m of messages) {
    if (m.role === "assistant" && typeof m.toolCallId === "string") {
      openById.set(m.toolCallId, (openById.get(m.toolCallId) ?? 0) + 1);
      pass1.push(m);
      continue;
    }
    if (m.role === "tool") {
      const hasId = typeof m.toolCallId === "string";
      const id = hasId ? (m.toolCallId as string) : "";
      const remaining = openById.get(id) ?? 0;
      if (remaining > 0) {
        if (remaining === 1) openById.delete(id);
        else openById.set(id, remaining - 1);
      } else {
        pass1.push({
          role: "assistant",
          toolCallId: hasId ? (m.toolCallId as string) : undefined,
          content: "(Tool result missing)",
        });
        fixes.push(`orphan-result:${id}:injected-synthetic-call`);
      }
      if (m.content === "") {
        fixes.push(`empty-output:${id}:placeholder`);
        pass1.push({ ...m, content: "(no tool output)" });
        continue;
      }
      pass1.push(m);
      continue;
    }
    pass1.push(m);
  }

  // ── 第二遍：悬挂 system 消息排队到最近配对闭合点之后 ─────────────────
  const out: Msg[] = [];
  const pending: Array<{ msg: Msg; from: number }> = [];
  const openById2 = new Map<string, number>();
  let openCount = 0;

  const flushPending = () => {
    for (const p of pending) {
      fixes.push(`dangling-system:${p.from}->${out.length}`);
      out.push(p.msg);
    }
    pending.length = 0;
  };

  for (let i = 0; i < pass1.length; i++) {
    const m = pass1[i] as Msg;
    if (m.role === "system" && openCount > 0) {
      pending.push({ msg: m, from: i });
      continue;
    }
    out.push(m);
    if (m.role === "assistant" && typeof m.toolCallId === "string") {
      openById2.set(m.toolCallId, (openById2.get(m.toolCallId) ?? 0) + 1);
      openCount++;
    } else if (m.role === "tool") {
      const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
      const remaining = openById2.get(id) ?? 0;
      if (remaining > 0) {
        if (remaining === 1) openById2.delete(id);
        else openById2.set(id, remaining - 1);
        openCount--;
      }
    }
    if (openCount === 0 && pending.length > 0) flushPending();
  }
  // 到结尾仍未闭合：悬挂 system 排到序列末尾（尽最大努力的兜底位置）。
  if (pending.length > 0) flushPending();

  return { messages: out, fixes };
}
