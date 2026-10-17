/**
 * BI-04.1 — Prompt 前缀黄金排布 + Qwen 风格工具调用容错解析。
 *
 * # 设计总纲
 *
 * ## 1. 黄金排布（顺序锁死）
 *
 * KV 前缀缓存（DeepSeek / Qwen / Anthropic prompt cache）按**请求前缀的字节
 * 公共最长前缀**命中。要让命中率 ≥85%，排布必须保证：
 *
 *   1. 静态 System + BI.md   ← 会话生命周期内字节不变
 *   2. 静态 Tools 序列化块    ← 工具集不变则字节不变
 *   3. Anchor（会话级锚点）   ← 会话内不变
 *   4. 历史（动态，调用方追加）← 每轮增长
 *
 * **任何动态内容只允许出现在静态段之后**；静态段内任何一个字节变动都会
 * 打穿其后全部 KV 缓存。本模块把 1→2→3 的拼接顺序固化在
 * `buildPromptPrefix` 内，调用方只能通过 `appendHistory` 追加历史，从
 * 结构上杜绝"把动态内容插进静态段"的排布事故。
 *
 * ### 1.1 命中率口径（doc）
 *
 * - 命中对象：System+BI.md+Tools+Anchor 组成的静态前缀。
 * - ≥85% 的前提：三段在全请求生命周期内字节不变（工具集变更 / BI.md
 *   热更新 / Anchor 漂移都会使该口径失效，需重置统计）。
 * - `appendHistory(prefix, history)` 保证 `prefix` 是拼接结果的**逐字节
 *   真前缀**（不偷加分隔符），这是排布可测试性的锚点。
 *
 * ## 2. fuzzyParseToolCall — Qwen 风格容错
 *
 * Qwen 系模型在 tool call 里输出的 JSON 常见五类畸形，按固定顺序逐规则
 * 修复，`repaired.rules` 记录**实际生效**的规则（按生效顺序）：
 *
 * | 顺序 | 规则                     | 畸形示例                                   |
 * |------|--------------------------|--------------------------------------------|
 * | 1    | strip-markdown-fence     | ```json ... ``` 包裹                        |
 * | 2    | close-trailing-quote     | {"name": "abc} 引号未闭合                   |
 * | 3    | close-trailing-bracket   | {"a":{"b":[1,2 括号未闭合                   |
 * | 4    | single-to-double-quotes  | {'name': 'x'} 单引号                        |
 * | 5    | strip-trailing-comma     | {"a":1,} 尾逗号                             |
 *
 * 解析成功的最早规则组合即返回（escalation pipeline）；合法 JSON 原样
 * 透传（`repaired` 缺省）。双引号字符串内部的 `'`（如 "it's"）**不会**
 * 被单引号规则破坏。
 */

import type { ToolDefinition } from './deepseek-adapter';

/** 工具定义（复用 BI-04.2 已关单资产语义）。 */
export type ToolDef = ToolDefinition;

// ---------------------------------------------------------------------------
// 黄金排布
// ---------------------------------------------------------------------------

/** 黄金排布段顺序（锁死；doc 口径见文件头 §1）。 */
export const PROMPT_PREFIX_ORDER = ['system+biMd', 'tools', 'anchor', 'history'] as const;

/** 段间统一分隔符。 */
export const PROMPT_SEGMENT_SEPARATOR = '\n\n';

export interface PromptSegments {
  /** 静态 system 提示（必填，排布第一位）。 */
  system: string;
  /** BI.md 全文（可选，紧跟 system，同属静态第一位）。 */
  biMd?: string;
  /** 静态工具定义（排布第二位；顺序保持调用方给定的字节序）。 */
  tools: ToolDef[];
  /** 会话级锚点（可选，排布第三位）。 */
  anchor?: string;
}

/** 递归键排序的规范化值（数组序保持；用于确定性序列化）。 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalValue(source[key]);
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** 工具定义块的确定性序列化（同输入恒同字节，键序规范化、工具序保持调用方字节序）。 */
export function renderToolDefsBlock(tools: ToolDef[]): string {
  if (tools.length === 0) return '';
  return canonicalJson(tools);
}

/** 按黄金排布渲染静态前缀（System+BI.md → Tools → Anchor；history 由 appendHistory 追加）。 */
export function buildPromptPrefix(segments: PromptSegments): string {
  const headParts: string[] = [];
  if (segments.system.length > 0) headParts.push(segments.system);
  if (segments.biMd !== undefined && segments.biMd.length > 0) headParts.push(segments.biMd);
  const parts: string[] = [headParts.join(PROMPT_SEGMENT_SEPARATOR)];

  const toolsBlock = renderToolDefsBlock(segments.tools);
  if (toolsBlock.length > 0) parts.push(toolsBlock);

  if (segments.anchor !== undefined && segments.anchor.length > 0) parts.push(segments.anchor);

  return parts.filter((p) => p.length > 0).join(PROMPT_SEGMENT_SEPARATOR);
}

/**
 * 逐字节真前缀追加历史：结果恒以 `prefix` 的原始字节开头，不偷加任何
 * 分隔符（doc 口径见文件头 §1.1）。需要段间分隔时由调用方在 history
 * 头部自带 PROMPT_SEGMENT_SEPARATOR。
 */
export function appendHistory(prefix: string, history: string): string {
  return prefix + history;
}

// ---------------------------------------------------------------------------
// Qwen 风格容错解析
// ---------------------------------------------------------------------------

export type FuzzyRepairRule =
  | 'strip-markdown-fence'
  | 'close-trailing-quote'
  | 'close-trailing-bracket'
  | 'single-to-double-quotes'
  | 'strip-trailing-comma';

export interface FuzzyRepairReport {
  /** 实际生效的规则，按生效顺序。 */
  rules: FuzzyRepairRule[];
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface FuzzyParseResult {
  ok: boolean;
  call?: ParsedToolCall;
  repaired?: FuzzyRepairReport;
  /** ok=false 时的结构化原因。 */
  reason?: string;
}

// ---------------------------------------------------------------------------
// 容错解析内部实现
// ---------------------------------------------------------------------------

type ParseAttempt = { ok: true; value: unknown } | { ok: false };

function tryParseJson(s: string): ParseAttempt {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch {
    return { ok: false };
  }
}

interface StructureScan {
  /** 未闭合开括号栈（扫描序；仅统计双引号字符串之外）。 */
  unclosed: string[];
  /** 是否停留在未闭合的双引号字符串内。 */
  quoteOpen: boolean;
}

/** 双引号字符串感知的结构扫描（转义 `\` 正确跳过）。 */
function structuralScan(s: string): StructureScan {
  const unclosed: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      unclosed.push(ch);
    } else if ((ch === '}' || ch === ']') && unclosed.length > 0) {
      unclosed.pop();
    }
  }
  return { unclosed, quoteOpen: inString };
}

/** 规则 1：剥离 markdown 围栏（```lang\n ... \n```）。 */
function stripMarkdownFence(s: string): string {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return s;
  let body = trimmed.replace(/^```[a-zA-Z0-9_-]*[ \t]*\n?/, '');
  body = body.replace(/\n?```[ \t]*$/, '');
  return body.trim();
}

/** 规则 2：补未闭合的双引号（末尾悬挂反斜杠先去除，避免转义掉补上的引号）。 */
function closeTrailingQuote(s: string): string {
  const { quoteOpen } = structuralScan(s);
  if (!quoteOpen) return s;
  let backslashes = 0;
  while (backslashes < s.length && s[s.length - 1 - backslashes] === '\\') backslashes++;
  const base = backslashes % 2 === 1 ? s.slice(0, -1) : s;
  return base + '"';
}

/** 规则 3：按栈序补未闭合的 } / ]（内层先闭合）。 */
function closeTrailingBracket(s: string): string {
  const { unclosed } = structuralScan(s);
  if (unclosed.length === 0) return s;
  const closers = unclosed
    .slice()
    .reverse()
    .map((c) => (c === '{' ? '}' : ']'))
    .join('');
  return s + closers;
}

/** 规则 4：双引号字符串之外的单引号 → 双引号（"it's" 类 Apostrophe 不受影响）。 */
function singleToDoubleQuotes(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "'") {
      out += '"';
      changed = true;
      continue;
    }
    out += ch;
  }
  return changed ? out : s;
}

/** 规则 5：移除 } / ] 前的尾逗号（字符串之外，逗号后允许空白）。 */
function stripTrailingCommas(s: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
      if (j < s.length && (s[j] === '}' || s[j] === ']')) continue;
    }
    out += ch;
  }
  return out;
}

interface RepairRule {
  name: FuzzyRepairRule;
  apply: (s: string) => string;
}

/** 固定顺序规则表（顺序锁死，见文件头 §2 表格）。 */
const REPAIR_RULES: readonly RepairRule[] = [
  { name: 'strip-markdown-fence', apply: stripMarkdownFence },
  { name: 'close-trailing-quote', apply: closeTrailingQuote },
  { name: 'close-trailing-bracket', apply: closeTrailingBracket },
  { name: 'single-to-double-quotes', apply: singleToDoubleQuotes },
  { name: 'strip-trailing-comma', apply: stripTrailingCommas },
];

type RepairOutcome =
  | { ok: true; value: unknown; rules: FuzzyRepairRule[] }
  | { ok: false };

/** escalation 流水线：合法 JSON 原样透传；否则逐规则累积修复，最早可解析组合即返回。 */
function repairPipeline(raw: string): RepairOutcome {
  const direct = tryParseJson(raw);
  if (direct.ok) return { ok: true, value: direct.value, rules: [] };

  let current = raw.trim();
  const fired: FuzzyRepairRule[] = [];
  for (const rule of REPAIR_RULES) {
    const next = rule.apply(current);
    if (next === current) continue;
    current = next;
    fired.push(rule.name);
    const attempt = tryParseJson(current);
    if (attempt.ok) return { ok: true, value: attempt.value, rules: fired.slice() };
  }
  return { ok: false };
}

type ShapeOutcome =
  | { ok: true; call: ParsedToolCall; extraRules: FuzzyRepairRule[] }
  | { ok: false; reason: string };

/** 形状校验：name 必须为非空 string；arguments 缺省 {}、对象直用、字符串走一次嵌套修复。 */
function toToolCall(parsed: unknown): ShapeOutcome {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-an-object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    return { ok: false, reason: 'missing-name' };
  }

  let args: Record<string, unknown> = {};
  const extraRules: FuzzyRepairRule[] = [];
  const rawArgs = obj.arguments;
  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else if (typeof rawArgs === 'string') {
      const nested = repairPipeline(rawArgs);
      const nestedValue = nested.ok ? nested.value : undefined;
      if (!nested.ok || nestedValue === null || typeof nestedValue !== 'object' || Array.isArray(nestedValue)) {
        return { ok: false, reason: 'arguments-unparseable' };
      }
      args = nestedValue as Record<string, unknown>;
      extraRules.push(...nested.rules);
    } else {
      return { ok: false, reason: 'arguments-not-object' };
    }
  }
  return { ok: true, call: { name: obj.name, arguments: args }, extraRules };
}

/** Qwen 风格五规则 escalation 容错解析（doc 口径见文件头 §2）。 */
export function fuzzyParseToolCall(raw: string): FuzzyParseResult {
  const top = repairPipeline(raw);
  if (!top.ok) return { ok: false, reason: 'unparseable-json' };

  const shaped = toToolCall(top.value);
  if (!shaped.ok) return { ok: false, reason: shaped.reason };

  const rules = [...top.rules, ...shaped.extraRules];
  if (rules.length > 0) return { ok: true, call: shaped.call, repaired: { rules } };
  return { ok: true, call: shaped.call };
}
