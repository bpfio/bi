/**
 * merman/mermaid-renderer —— 终端 Mermaid 极简渲染引擎。
 *
 * BI-19.6 合约：renderMermaid(src, opts{ cols=120 }): string[]，纯 TS 手写，
 * 零外部依赖。支持最小子集：
 * - `graph TD|LR` / `flowchart TD|LR`：方框 [ ]、圆角 ( )、菱形判断 { }；
 *   边 `-->` 与 `-->|文字|`；链式 `A --> B --> C`；
 * - 布局：分层（入度 0 层置顶，逐层 = max(前驱层)+1 闭包松弛），同层水平
 *   居中分布；TD 逐层下移（先横后竖 L 形走线），LR 逐列右移（先竖后横）；
 * - `sequenceDiagram`：participant [as 别名]、`->>` / `-->>`（含 `->`/`-->`
 *   宽容映射）、自消息小回环、顶部/底部参与者盒与生命线；
 * - 不支持语法 → 结构化错误行返回（不抛异常）。
 *
 * 未读取 /home/yupeng/references/ 下任何源码；全部算法按公开 mermaid 语法
 * 语义自行实现。
 */

import { Canvas } from "./canvas";
import { textWidth } from "../components/cjk-width";

export interface RenderMermaidOpts {
  /** 画布列数，默认 120。 */
  cols?: number;
}

export interface MermaidParseIssue {
  line: number;
  message: string;
}

type NodeShape = "rect" | "rounded" | "diamond";

interface FlowNode {
  id: string;
  label: string;
  shape: NodeShape;
}

interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

interface FlowDiagram {
  direction: "TD" | "LR";
  nodes: FlowNode[];
  nodeById: Map<string, FlowNode>;
  edges: FlowEdge[];
}

type SeqArrow = "solid" | "dashed";

interface SeqParticipant {
  id: string;
  label: string;
}

interface SeqMessage {
  from: string;
  to: string;
  text: string;
  arrow: SeqArrow;
}

interface SeqDiagram {
  participants: SeqParticipant[];
  messages: SeqMessage[];
}

type Diagram =
  | { kind: "flow"; flow: FlowDiagram }
  | { kind: "sequence"; seq: SeqDiagram };

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface Statement {
  line: number;
  text: string;
}

function toStatements(src: string): Statement[] {
  const out: Statement[] = [];
  const physical = src.split("\n");
  for (let i = 0; i < physical.length; i++) {
    for (const part of physical[i]!.split(";")) {
      const t = part.trim();
      if (t.length > 0 && !t.startsWith("%%")) out.push({ line: i + 1, text: t });
    }
  }
  return out;
}

const ID_RE = /[A-Za-z0-9_.]+/y;

function parseMermaid(src: string): { diagram?: Diagram; issues: MermaidParseIssue[] } {
  const issues: MermaidParseIssue[] = [];
  const statements = toStatements(src);
  if (statements.length === 0) {
    return { issues: [{ line: 0, message: "empty diagram" }] };
  }
  const head = statements[0]!;
  const flowMatch = head.text.match(/^(?:graph|flowchart)\s+(\S+)\s*$/i);
  const seqMatch = head.text.match(/^sequenceDiagram\s*$/i);
  if (flowMatch) {
    const rawDir = (flowMatch[1] ?? "").toUpperCase();
    const direction = rawDir === "LR" || rawDir === "RL" ? "LR" : "TD";
    const flow = parseFlow(statements.slice(1), direction, issues);
    return { issues, diagram: issues.length === 0 ? { kind: "flow", flow } : undefined };
  }
  if (seqMatch) {
    const seq = parseSequence(statements.slice(1), issues);
    return { issues, diagram: issues.length === 0 ? { kind: "sequence", seq } : undefined };
  }
  issues.push({ line: head.line, message: `unsupported diagram header: "${head.text}"` });
  return { issues };
}

function parseFlow(stmts: Statement[], direction: "TD" | "LR", issues: MermaidParseIssue[]): FlowDiagram {
  const flow: FlowDiagram = { direction, nodes: [], nodeById: new Map(), edges: [] };
  for (const st of stmts) {
    parseFlowStatement(st, flow, issues);
  }
  return flow;
}

/** 登记节点：已存在则显式提供的 label/shape 覆盖；缺省 label = id。 */
function registerNode(flow: FlowDiagram, id: string, label: string | undefined, shape: NodeShape | undefined): void {
  const existing = flow.nodeById.get(id);
  if (existing) {
    if (label !== undefined) existing.label = label;
    if (shape !== undefined) existing.shape = shape;
    return;
  }
  const node: FlowNode = { id, label: label ?? id, shape: shape ?? "rect" };
  flow.nodeById.set(id, node);
  flow.nodes.push(node);
}

/** 单条 flow 语句游走解析：节点 (--> [|label|] 节点)*，支持链式。 */
function parseFlowStatement(st: Statement, flow: FlowDiagram, issues: MermaidParseIssue[]): void {
  const s = st.text;
  const first = readNode(s, 0);
  if (!first) {
    issues.push({ line: st.line, message: `cannot parse node in: "${s}"` });
    return;
  }
  registerNode(flow, first.id, first.label, first.shape);
  let from = first;
  let i = first.next;
  for (;;) {
    let j = i;
    while (j < s.length && /\s/.test(s[j]!)) j++;
    if (j >= s.length) return;
    if (!s.startsWith("-->", j)) {
      issues.push({ line: st.line, message: `unsupported syntax: "${s.slice(j)}"` });
      return;
    }
    j += 3;
    let label: string | undefined;
    const lm = s.slice(j).match(/^\s*\|([^|]*)\|/);
    if (lm) {
      label = lm[1]?.trim() ?? "";
      j += lm[0].length;
    }
    while (j < s.length && /\s/.test(s[j]!)) j++;
    const next = readNode(s, j);
    if (!next) {
      issues.push({ line: st.line, message: `edge target missing in: "${s}"` });
      return;
    }
    registerNode(flow, next.id, next.label, next.shape);
    flow.edges.push({ from: from.id, to: next.id, label });
    from = next;
    i = next.next;
  }
}

interface ParsedNode {
  id: string;
  label?: string;
  shape?: NodeShape;
  next: number;
}

/** 读取节点 token：id + 可选形状（[ ] 圆角 ( ) 菱形 { }）。 */
function readNode(s: string, from: number): ParsedNode | null {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  ID_RE.lastIndex = i;
  const m = ID_RE.exec(s);
  if (!m || m.index !== i) return null;
  const id = m[0];
  i += id.length;
  const open = s[i];
  if (open === "[" || open === "(" || open === "{") {
    const close = open === "[" ? "]" : open === "(" ? ")" : "}";
    const end = s.indexOf(close, i + 1);
    if (end < 0) return null;
    const label = s.slice(i + 1, end).trim();
    const shape: NodeShape = open === "[" ? "rect" : open === "(" ? "rounded" : "diamond";
    return { id, label, shape, next: end + 1 };
  }
  return { id, next: i };
}

function parseSequence(stmts: Statement[], issues: MermaidParseIssue[]): SeqDiagram {
  const seq: SeqDiagram = { participants: [], messages: [] };
  const byId = new Map<string, SeqParticipant>();
  const ensure = (id: string, label?: string): SeqParticipant => {
    const got = byId.get(id);
    if (got) {
      if (label !== undefined && got.label === id) got.label = label;
      return got;
    }
    const p: SeqParticipant = { id, label: label ?? id };
    byId.set(id, p);
    seq.participants.push(p);
    return p;
  };
  for (const st of stmts) {
    const pm = st.text.match(/^participant\s+([A-Za-z0-9_.]+)(?:\s+as\s+(.+))?$/i);
    if (pm) {
      ensure(pm[1]!, pm[2]?.trim());
      continue;
    }
    const mm = st.text.match(/^([A-Za-z0-9_.]+)\s*(-->>|->>|-->|->)\s*([A-Za-z0-9_.]+)\s*:\s*(.*)$/);
    if (mm) {
      const from = ensure(mm[1]!);
      const to = ensure(mm[3]!);
      const arrow: SeqArrow = mm[2]!.startsWith("--") ? "dashed" : "solid";
      seq.messages.push({ from: from.id, to: to.id, text: mm[4]?.trim() ?? "", arrow });
      continue;
    }
    issues.push({ line: st.line, message: `unsupported sequence statement: "${st.text}"` });
  }
  return seq;
}

// ---------------------------------------------------------------------------
// 布局与渲染
// ---------------------------------------------------------------------------

/** 层内节点水平间距。 */
const H_GAP = 6;
/** TD 层间垂直节奏：3 行盒 + 3 行箭头带。 */
const TD_STRIDE = 6;
/** LR 同列节点垂直节奏：3 行盒 + 2 行间隔。 */
const LR_STRIDE = 5;
/** 时序图参与者水平间距。 */
const SEQ_GAP = 8;

export function renderMermaid(src: string, opts?: RenderMermaidOpts): string[] {
  const cols = Math.max(20, Math.floor(opts?.cols ?? 120));
  const { diagram, issues } = parseMermaid(src);
  if (!diagram || issues.length > 0) {
    const lines = ["⚠ mermaid: unsupported or invalid syntax"];
    for (const issue of issues) lines.push(`  L${issue.line}: ${issue.message}`);
    return lines;
  }
  return diagram.kind === "flow" ? renderFlow(diagram.flow, cols) : renderSequence(diagram.seq, cols);
}

/** 超宽标签截断：保证显示宽度 ≤ maxW，截断处以 … 收尾（放得下时）。 */
function truncateToWidth(s: string, maxW: number): string {
  if (maxW <= 0) return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = textWidth(ch);
    if (w + cw > maxW) {
      if (w < maxW) {
        out += "…";
      }
      break;
    }
    out += ch;
    w += cw;
  }
  return out;
}

interface PlacedBox {
  cx: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function nodeBoxW(label: string, cols: number): { w: number; label: string } {
  const lw = textWidth(label);
  const w = Math.min(lw + 4, Math.max(4, cols));
  if (lw + 4 > w) {
    return { w, label: truncateToWidth(label, w - 4) };
  }
  return { w, label };
}

/** TD/LR 分层：闭包松弛 layer[to] = max(layer[to], layer[from]+1)，迭代上限 = 节点数。 */
function assignLayers(nodes: FlowNode[], edges: FlowEdge[]): Map<string, number> {
  const layer = new Map<string, number>();
  for (const n of nodes) layer.set(n.id, 0);
  const cap = Math.max(1, nodes.length);
  for (let round = 0; round < cap; round++) {
    let changed = false;
    for (const e of edges) {
      const lf = layer.get(e.from) ?? 0;
      const lt = layer.get(e.to) ?? 0;
      if (lt <= lf) {
        layer.set(e.to, lf + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

function renderFlow(flow: FlowDiagram, cols: number): string[] {
  const layer = assignLayers(flow.nodes, flow.edges);
  let maxLayer = 0;
  for (const l of layer.values()) maxLayer = Math.max(maxLayer, l);
  const buckets: FlowNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of flow.nodes) buckets[layer.get(n.id) ?? 0]!.push(n);

  const pos = new Map<string, PlacedBox>();
  let canvas: Canvas;

  if (flow.direction === "TD") {
    const rows = 1 + maxLayer * TD_STRIDE + 3 + 1;
    canvas = new Canvas(cols, rows);
    for (let l = 0; l <= maxLayer; l++) {
      const bucket = buckets[l]!;
      const boxes = bucket.map((n) => nodeBoxW(n.label, cols));
      const totalW = boxes.reduce((acc, b) => acc + b.w, 0) + H_GAP * Math.max(0, bucket.length - 1);
      let x = Math.max(0, Math.floor((cols - totalW) / 2));
      const top = 1 + l * TD_STRIDE;
      for (let k = 0; k < bucket.length; k++) {
        const node = bucket[k]!;
        const b = boxes[k]!;
        canvas.box(x, top, b.w, 3, { shape: node.shape, label: b.label });
        pos.set(node.id, { cx: x + Math.floor(b.w / 2), top, bottom: top + 2, left: x, right: x + b.w - 1 });
        x += b.w + H_GAP;
      }
    }
    for (const e of flow.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const sy = a.bottom + 1;
      const ty = b.top - 1;
      canvas.arrow(a.cx, sy, b.cx, ty, { route: "h" });
      if (e.label) {
        const lw = textWidth(e.label);
        const midRow = Math.floor((sy + ty) / 2);
        let lx = b.cx + 2;
        if (lx + lw > cols) lx = b.cx - lw - 2;
        if (lx >= 0) canvas.text(lx, midRow, e.label);
      }
    }
  } else {
    const colW = buckets.map((bucket) => Math.max(4, ...bucket.map((n) => nodeBoxW(n.label, cols).w)));
    const maxStack = Math.max(1, ...buckets.map((b) => b.length));
    const rows = 1 + (maxStack - 1) * LR_STRIDE + 3 + 1;
    canvas = new Canvas(cols, rows);
    const totalW = colW.reduce((acc, w) => acc + w, 0) + H_GAP * Math.max(0, buckets.length - 1);
    let x = Math.max(0, Math.floor((cols - totalW) / 2));
    for (let l = 0; l <= maxLayer; l++) {
      const bucket = buckets[l]!;
      const w = colW[l]!;
      for (let k = 0; k < bucket.length; k++) {
        const node = bucket[k]!;
        const b = nodeBoxW(node.label, cols);
        const top = 1 + k * LR_STRIDE;
        canvas.box(x, top, b.w, 3, { shape: node.shape, label: b.label });
        pos.set(node.id, { cx: x + Math.floor(b.w / 2), top, bottom: top + 2, left: x, right: x + b.w - 1 });
      }
      x += w + H_GAP;
    }
    for (const e of flow.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const sx = a.right + 1;
      const tx = b.left - 1;
      canvas.arrow(sx, a.top + 1, tx, b.top + 1, { route: "v" });
      if (e.label) {
        let lx = sx + 1;
        const lw = textWidth(e.label);
        if (lx + lw > cols) lx = Math.max(0, cols - lw);
        canvas.text(lx, Math.max(0, b.top + 1 - 1), e.label);
      }
    }
  }
  return canvas.render();
}

function renderSequence(seq: SeqDiagram, cols: number): string[] {
  const n = Math.max(1, seq.participants.length);
  const boxes = seq.participants.map((p) => {
    const lw = textWidth(p.label);
    const w = Math.min(Math.max(lw + 4, 5), cols);
    return { w, label: lw + 4 > w ? truncateToWidth(p.label, Math.max(1, w - 4)) : p.label };
  });
  const totalW = boxes.reduce((acc, b) => acc + b.w, 0) + SEQ_GAP * Math.max(0, n - 1);
  let x = Math.max(0, Math.floor((cols - totalW) / 2));
  const cx: number[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const px = Math.min(x, Math.max(0, cols - b.w));
    cx.push(px + Math.floor(b.w / 2));
    x = px + b.w + SEQ_GAP;
  }

  let msgRows = 0;
  for (const m of seq.messages) msgRows += m.from === m.to ? 4 : 2;
  const msgTop = 4;
  const rows = msgTop + msgRows + 1 + 3;
  const canvas = new Canvas(cols, rows);

  for (let i = 0; i < boxes.length; i++) {
    const p = seq.participants[i]!;
    const b = boxes[i]!;
    const px = cx[i]! - Math.floor(b.w / 2);
    canvas.box(px, 0, b.w, 3, { label: b.label });
    canvas.box(px, rows - 3, b.w, 3, { label: b.label });
  }

  const bottomBoxTop = rows - 3;
  for (let i = 0; i < boxes.length; i++) {
    for (let y = 3; y < bottomBoxTop; y++) {
      canvas.setCell(cx[i]!, y, "│");
    }
  }

  let r = msgTop;
  for (const m of seq.messages) {
    const ia = seq.participants.findIndex((p) => p.id === m.from);
    const ib = seq.participants.findIndex((p) => p.id === m.to);
    if (ia < 0 || ib < 0) continue;
    const a = cx[ia]!;
    const b = cx[ib]!;
    if (a === b) {
      // 自消息：文字 + 三行小回环 ─┐ / │ / <┘
      canvas.text(a + 2, r, m.text);
      canvas.setCell(a + 1, r + 1, "─");
      canvas.setCell(a + 2, r + 1, "┐");
      canvas.setCell(a + 2, r + 2, "│");
      canvas.setCell(a + 1, r + 3, "<");
      canvas.setCell(a + 2, r + 3, "┘");
      r += 4;
    } else {
      const left = Math.min(a, b);
      const right = Math.max(a, b);
      const tx = (b > a ? a : b) + 2;
      canvas.text(tx, r, m.text);
      const lineCh = m.arrow === "dashed" ? "╌" : "─";
      for (let x = left + 1; x < right; x++) canvas.setCell(x, r + 1, lineCh);
      canvas.setCell(b, r + 1, b > a ? ">" : "<");
      r += 2;
    }
  }
  return canvas.render();
}
