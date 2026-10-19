/**
 * BI-20.3 —— 会话 → 单文件自含 HTML 导出。
 *
 * 设计边界（工单钉死）:
 *   - 零依赖: 内联 CSS, 无外链 / 无 CDN / 无图片 / 无 vendor 大库;
 *   - 双主题: 默认 Dark; light 由 options.theme 切换（色表见 buildCss,
 *     风格与 Dark 同构, 可读性优先; 缺省 dark 时产物与旧版逐字节一致）;
 *   - 工具调用卡用 <details> 折叠, 内含「输入 / 输出」两块;
 *   - 代码与 diff 一律 <pre><code> 纯文本, 不做语法高亮;
 *   - 所有动态文本经 HTML 转义; 含 ANSI 的终端文本经 ./ansi-to-html.ts 转换
 *     （转换内部已转义, 不二次转义）。
 *
 * 工具渲染器插件面（最小版, pi ToolHtmlRenderer 语义简化）:
 *   渲染器按 toolName 注册, 命中时覆盖该工具 tool_call / tool_result 在
 *   <details> 内的「输入 / 输出」区 HTML。责任边界（XSS 归属）:
 *     - 宿主(本导出器)将渲染器返回字符串【直接插入, 不做任何转义 / 二次转义】;
 *     - 因此渲染器【必须自行对其动态文本做 HTML 转义】(可复用本模块 escapeHtml),
 *       宿主不替插件兜底 XSS —— 自渲 HTML 的安全责任完全在插件侧。
 *   未命中(无对应 toolName 或该钩子未提供)则回退默认路径(escapeHtml/ansiToHtml),
 *   默认路径产物逐字节不变。
 *
 * 入参复用 export.ts 既有链路产物: loadSession 的 meta / entries（真实会话类型）。
 */
import type { JsonValue, SessionEntry, SessionMeta } from "../session/types";
import { ANSI_CSS, ansiToHtml } from "./ansi-to-html";

/** 合法主题集合（单一事实源; export.ts 校验复用）。 */
export const HTML_THEMES = ["dark", "light"] as const;

/** 主题标识。 */
export type Theme = (typeof HTML_THEMES)[number];

/** tool_call 参数摘要截断上限（字符数, 超长以 … 结尾）。 */
const ARGS_SUMMARY_MAX = 120;

/** HTML 转义 (& 先行, 防 XSS)。渲染器插件须自行复用本函数对其内容转义。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 工具渲染器插件面（最小版, pi ToolHtmlRenderer 语义简化）。
 * 见文件头注释的责任边界: 返回字符串由宿主【直接插入不转义】, 插件须自负责转义。
 */
export interface ToolHtmlRenderer {
  /** 返回 tool_call 「输入」区 HTML（直接插入, 宿主不转义）。entry 为 tool_call 条目。 */
  callHtml?(entry: SessionEntry): string;
  /** 返回 tool_result 「输出」区 HTML（直接插入, 宿主不转义）。result 为 tool_result 条目。 */
  resultHtml?(result: SessionEntry): string;
}

/** 按 toolName 索引的工具渲染器表。 */
export type ToolHtmlRenderers = Record<string, ToolHtmlRenderer>;

/** renderHtml 的可选参数。 */
export interface RenderHtmlOptions {
  /** 主题; 缺省 dark（与旧版逐字节一致）。 */
  theme?: Theme;
  /** 工具渲染器插件表; 缺省 undefined = 走默认路径（逐字节不变）。 */
  renderers?: ToolHtmlRenderers;
}

/** 主题色板（暗/亮同构; ANSI 调色板见 ansi-to-html.ts, 双主题一致）。 */
interface ThemePalette {
  colorScheme: string;
  pageBg: string;
  text: string;
  headerBorder: string;
  metaText: string;
  border: string;
  cardBg: string;
  badgeBg: string;
  badgeText: string;
  badgeToolCallBg: string;
  badgeToolResultBg: string;
  accent: string;
  seq: string;
  preBg: string;
  detailsBg: string;
}

const DARK: ThemePalette = {
  colorScheme: "dark",
  pageBg: "#1e1e2e",
  text: "#cdd6f4",
  headerBorder: "#313244",
  metaText: "#a6adc8",
  border: "#313244",
  cardBg: "#181825",
  badgeBg: "#313244",
  badgeText: "#cdd6f4",
  badgeToolCallBg: "#45475a",
  badgeToolResultBg: "#585b70",
  accent: "#f9e2af",
  seq: "#6c7086",
  preBg: "#11111b",
  detailsBg: "#11111b",
};

const LIGHT: ThemePalette = {
  colorScheme: "light",
  pageBg: "#eff1f5",
  text: "#4c4f69",
  headerBorder: "#ccd0da",
  metaText: "#6c6f85",
  border: "#ccd0da",
  cardBg: "#e6e9ef",
  badgeBg: "#ccd0da",
  badgeText: "#4c4f69",
  badgeToolCallBg: "#bcc0cc",
  badgeToolResultBg: "#aeb3c2",
  accent: "#8839ef",
  seq: "#9ca0b0",
  preBg: "#dce0e8",
  detailsBg: "#e6e9ef",
};

/** 内联 CSS（按主题取色板; dark 与旧版逐字节一致）。 */
function buildCss(theme: Theme): string {
  const pal = theme === "light" ? LIGHT : DARK;
  return [
    `:root { color-scheme: ${pal.colorScheme}; }`,
    "* { box-sizing: border-box; }",
    `body { margin: 0; background: ${pal.pageBg}; color: ${pal.text}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.55; }`,
    ".container { max-width: 880px; margin: 0 auto; padding: 24px 16px; }",
    `header { border-bottom: 1px solid ${pal.headerBorder}; margin-bottom: 20px; padding-bottom: 12px; }`,
    "h1 { font-size: 20px; margin: 0 0 10px; }",
    `.meta { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 13px; color: ${pal.metaText}; margin: 0; }`,
    ".meta dt { font-weight: 600; }",
    ".meta dd { margin: 0; word-break: break-all; }",
    `.entry { border: 1px solid ${pal.border}; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; background: ${pal.cardBg}; }`,
    ".entry-header { display: flex; gap: 8px; align-items: center; font-size: 13px; margin-bottom: 8px; flex-wrap: wrap; }",
    `.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: ${pal.badgeBg}; color: ${pal.badgeText}; font-family: ui-monospace, monospace; }`,
    `.badge-tool_call { background: ${pal.badgeToolCallBg}; }`,
    `.badge-tool_result { background: ${pal.badgeToolResultBg}; }`,
    `.tool-name { font-family: ui-monospace, monospace; color: ${pal.accent}; }`,
    `.seq { color: ${pal.seq}; font-family: ui-monospace, monospace; }`,
    `pre { background: ${pal.preBg}; border: 1px solid ${pal.border}; border-radius: 6px; padding: 10px; overflow: auto; margin: 8px 0; }`,
    "code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; white-space: pre-wrap; word-break: break-word; }",
    `details { border: 1px solid ${pal.border}; border-radius: 6px; padding: 8px 10px; margin: 8px 0; background: ${pal.detailsBg}; }`,
    `summary { cursor: pointer; font-family: ui-monospace, monospace; color: ${pal.accent}; }`,
    `.io-label { font-size: 12px; color: ${pal.metaText}; margin: 6px 0 2px; }`,
    ANSI_CSS,
  ].join("\n");
}

/** 正文提取: 字符串原样; 对象取 text 字段; 其余 JSON 缩进打印。 */
function bodyText(payload: JsonValue): string {
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const text = (payload as Record<string, JsonValue>)["text"];
    if (typeof text === "string") return text;
  }
  return JSON.stringify(payload, null, 2);
}

/** tool_call 参数提取: 优先 payload.args, 否则回退整个 payload。 */
function toolArgs(payload: JsonValue): JsonValue {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const args = (payload as Record<string, JsonValue>)["args"];
    if (args !== undefined) return args;
  }
  return payload;
}

/** tool_call 折叠摘要行用的参数摘要（超长截断）。 */
function argsSummaryText(payload: JsonValue): string {
  const text = JSON.stringify(toolArgs(payload));
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX)}…` : text;
}

/** user/assistant/system/compaction 等消息型条目。 */
function renderMessageEntry(entry: SessionEntry): string {
  const lines: string[] = [];
  lines.push(`<section class="entry entry-${entry.type}">`);
  lines.push(`<div class="entry-header"><span class="badge">${escapeHtml(entry.type)}</span>`);
  if (entry.toolName !== undefined) {
    lines.push(`<span class="tool-name">${escapeHtml(entry.toolName)}</span>`);
  }
  lines.push(`<span class="seq">#${entry.seq}</span></div>`);
  lines.push(`<pre><code>${ansiToHtml(bodyText(entry.payload))}</code></pre>`);
  lines.push("</section>");
  return lines.join("\n");
}

/** 工具结果（未与 tool_call 配对的孤立结果）。 */
function renderStandaloneResult(entry: SessionEntry, renderers: ToolHtmlRenderers | undefined): string {
  const name = entry.toolName ?? "unknown";
  const renderer = renderers?.[name];
  const lines: string[] = [];
  lines.push(`<section class="entry entry-tool_result">`);
  lines.push(
    `<div class="entry-header"><span class="badge badge-tool_result">tool_result</span>` +
      `<span class="tool-name">${escapeHtml(name)}</span>` +
      `<span class="seq">#${entry.seq}</span></div>`,
  );
  lines.push(`<details><summary>tool result: ${escapeHtml(name)}</summary>`);
  lines.push(`<div class="io-label">输出</div>`);
  // 插件命中: 直接插入其 HTML（不转义, 责任在插件）; 否则默认路径（转义）。
  lines.push(renderer?.resultHtml ? renderer.resultHtml(entry) : `<pre><code>${ansiToHtml(bodyText(entry.payload))}</code></pre>`);
  lines.push("</details>");
  lines.push("</section>");
  return lines.join("\n");
}

/** 工具调用卡：<details> 折叠, 内含输入 / 输出（输出来自配对的 tool_result）。 */
function renderToolCall(entry: SessionEntry, result: SessionEntry | undefined, renderers: ToolHtmlRenderers | undefined): string {
  const name = entry.toolName ?? "unknown";
  const renderer = renderers?.[name];
  const summaryText = `tool: ${name}(${argsSummaryText(entry.payload)})`;
  const inputJson = JSON.stringify(toolArgs(entry.payload), null, 2);

  const lines: string[] = [];
  lines.push(`<section class="entry entry-tool_call">`);
  lines.push(
    `<div class="entry-header"><span class="badge badge-tool_call">tool_call</span>` +
      `<span class="tool-name">${escapeHtml(name)}</span>` +
      `<span class="seq">#${entry.seq}</span></div>`,
  );
  lines.push(`<details><summary>${escapeHtml(summaryText)}</summary>`);
  lines.push(`<div class="io-label">输入</div>`);
  // 插件命中: 直接插入其 HTML（不转义, 责任在插件）; 否则默认路径（转义）。
  lines.push(renderer?.callHtml ? renderer.callHtml(entry) : `<pre><code>${escapeHtml(inputJson)}</code></pre>`);
  if (result !== undefined) {
    lines.push(`<div class="io-label">输出</div>`);
    lines.push(renderer?.resultHtml ? renderer.resultHtml(result) : `<pre><code>${ansiToHtml(bodyText(result.payload))}</code></pre>`);
  }
  lines.push("</details>");
  lines.push("</section>");
  return lines.join("\n");
}

/** 组装零依赖独立 HTML（内联 CSS, 双主题; 同输入 + 同 options 逐字节确定）。 */
export function renderHtml(
  meta: SessionMeta,
  entries: readonly SessionEntry[],
  options?: RenderHtmlOptions,
): string {
  const theme: Theme = options?.theme ?? "dark";
  const renderers = options?.renderers;

  // 预建 tool_call → tool_result 配对（按 toolCallId）。
  const resultByCallId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (entry.type === "tool_result" && entry.toolCallId !== undefined) {
      resultByCallId.set(entry.toolCallId, entry);
    }
  }
  const consumed = new Set<string>();

  const bodyParts: string[] = [];
  for (const entry of entries) {
    if (entry.type === "tool_result") {
      if (entry.toolCallId !== undefined && consumed.has(entry.toolCallId)) continue;
      bodyParts.push(renderStandaloneResult(entry, renderers));
    } else if (entry.type === "tool_call") {
      const result =
        entry.toolCallId !== undefined ? resultByCallId.get(entry.toolCallId) : undefined;
      if (result !== undefined && entry.toolCallId !== undefined) {
        consumed.add(entry.toolCallId);
      }
      bodyParts.push(renderToolCall(entry, result, renderers));
    } else {
      bodyParts.push(renderMessageEntry(entry));
    }
  }

  const metaRows: string[] = [];
  metaRows.push(`<dt>会话</dt><dd>${escapeHtml(meta.sessionId)}</dd>`);
  metaRows.push(`<dt>创建</dt><dd>${escapeHtml(new Date(meta.createdAt).toISOString())}</dd>`);
  if (meta.cwd !== undefined) {
    metaRows.push(`<dt>工作目录</dt><dd>${escapeHtml(meta.cwd)}</dd>`);
  }
  if (meta.forkedFrom !== undefined) {
    metaRows.push(`<dt>分叉自</dt><dd>${escapeHtml(meta.forkedFrom)}</dd>`);
  }
  metaRows.push(`<dt>条目</dt><dd>${entries.length}</dd>`);

  const title = escapeHtml(meta.title);
  return [
    "<!DOCTYPE html>",
    '<html lang="zh">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    "<style>",
    buildCss(theme),
    "</style>",
    "</head>",
    "<body>",
    '<div class="container">',
    `<header><h1>${title}</h1><dl class="meta">${metaRows.join("")}</dl></header>`,
    "<main>",
    bodyParts.join("\n"),
    "</main>",
    "</div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
