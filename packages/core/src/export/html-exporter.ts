/**
 * BI-20.3 —— 会话 → 单文件自含 HTML 导出。
 *
 * 设计边界（工单钉死）:
 *   - 零依赖: 内联 CSS, 无外链 / 无 CDN / 无图片 / 无 vendor 大库;
 *   - 默认 Dark 主题（light 主题切换属未做项, 见尾部边界清单）;
 *   - 工具调用卡用 <details> 折叠, 内含「输入 / 输出」两块;
 *   - 代码与 diff 一律 <pre><code> 纯文本, 不做语法高亮;
 *   - 所有动态文本经 HTML 转义; 含 ANSI 的终端文本经 ./ansi-to-html.ts 转换
 *     （转换内部已转义, 不二次转义）。
 *
 * 入参复用 export.ts 既有链路产物: loadSession 的 meta / entries（真实会话类型）。
 */
import type { JsonValue, SessionEntry, SessionMeta } from "../session/types";
import { ANSI_CSS, ansiToHtml } from "./ansi-to-html";

/** tool_call 参数摘要截断上限（字符数, 超长以 … 结尾）。 */
const ARGS_SUMMARY_MAX = 120;

/** HTML 转义 (& 先行, 防 XSS)。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/** 内联 CSS（Dark 默认; 含 ANSI 着色类）。 */
function buildCss(): string {
  return [
    ":root { color-scheme: dark; }",
    "* { box-sizing: border-box; }",
    "body { margin: 0; background: #1e1e2e; color: #cdd6f4; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif; line-height: 1.55; }",
    ".container { max-width: 880px; margin: 0 auto; padding: 24px 16px; }",
    "header { border-bottom: 1px solid #313244; margin-bottom: 20px; padding-bottom: 12px; }",
    "h1 { font-size: 20px; margin: 0 0 10px; }",
    ".meta { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 13px; color: #a6adc8; margin: 0; }",
    ".meta dt { font-weight: 600; }",
    ".meta dd { margin: 0; word-break: break-all; }",
    ".entry { border: 1px solid #313244; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; background: #181825; }",
    ".entry-header { display: flex; gap: 8px; align-items: center; font-size: 13px; margin-bottom: 8px; flex-wrap: wrap; }",
    ".badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #313244; color: #cdd6f4; font-family: ui-monospace, monospace; }",
    ".badge-tool_call { background: #45475a; }",
    ".badge-tool_result { background: #585b70; }",
    ".tool-name { font-family: ui-monospace, monospace; color: #f9e2af; }",
    ".seq { color: #6c7086; font-family: ui-monospace, monospace; }",
    "pre { background: #11111b; border: 1px solid #313244; border-radius: 6px; padding: 10px; overflow: auto; margin: 8px 0; }",
    "code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; white-space: pre-wrap; word-break: break-word; }",
    "details { border: 1px solid #313244; border-radius: 6px; padding: 8px 10px; margin: 8px 0; background: #11111b; }",
    "summary { cursor: pointer; font-family: ui-monospace, monospace; color: #f9e2af; }",
    ".io-label { font-size: 12px; color: #a6adc8; margin: 6px 0 2px; }",
    ANSI_CSS,
  ].join("\n");
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
function renderStandaloneResult(entry: SessionEntry): string {
  const name = entry.toolName ?? "unknown";
  const lines: string[] = [];
  lines.push(`<section class="entry entry-tool_result">`);
  lines.push(
    `<div class="entry-header"><span class="badge badge-tool_result">tool_result</span>` +
      `<span class="tool-name">${escapeHtml(name)}</span>` +
      `<span class="seq">#${entry.seq}</span></div>`,
  );
  lines.push(`<details><summary>tool result: ${escapeHtml(name)}</summary>`);
  lines.push(`<div class="io-label">输出</div>`);
  lines.push(`<pre><code>${ansiToHtml(bodyText(entry.payload))}</code></pre>`);
  lines.push("</details>");
  lines.push("</section>");
  return lines.join("\n");
}

/** 工具调用卡：<details> 折叠, 内含输入 / 输出（输出来自配对的 tool_result）。 */
function renderToolCall(entry: SessionEntry, result: SessionEntry | undefined): string {
  const name = entry.toolName ?? "unknown";
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
  lines.push(`<pre><code>${escapeHtml(inputJson)}</code></pre>`);
  if (result !== undefined) {
    lines.push(`<div class="io-label">输出</div>`);
    lines.push(`<pre><code>${ansiToHtml(bodyText(result.payload))}</code></pre>`);
  }
  lines.push("</details>");
  lines.push("</section>");
  return lines.join("\n");
}

/** 组装零依赖独立 HTML（内联 CSS, Dark 默认; 同输入逐字节确定）。 */
export function renderHtml(meta: SessionMeta, entries: readonly SessionEntry[]): string {
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
      bodyParts.push(renderStandaloneResult(entry));
    } else if (entry.type === "tool_call") {
      const result =
        entry.toolCallId !== undefined ? resultByCallId.get(entry.toolCallId) : undefined;
      if (result !== undefined && entry.toolCallId !== undefined) {
        consumed.add(entry.toolCallId);
      }
      bodyParts.push(renderToolCall(entry, result));
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
    buildCss(),
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
