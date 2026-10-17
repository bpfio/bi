/**
 * BI-20.3 — 工具结果渲染分发 (确定性)。
 *
 * 规则 (钉死):
 * - diff 判定: 以 'diff --git ' 开头, 或存在 /^@@ -\d/ 行, 或同时存在 /^--- / 与 /^\+\+\+ / 行
 *   -> `<pre class="tool-diff">`
 * - 表格判定: 非空行 >= 2, 每个非空行以 '|' 开头并以 '|' 结尾, 且至少一行是
 *   /^\|(\s*:?-+:?\s*\|)+$/ 分隔行 -> `<table class="tool-table">` (首行 th, 其余 td, 分隔行跳过)
 * - 其余 -> `<pre class="tool-result">`
 * 文本一律经 ansiToHtml (含 HTML 转义) 后输出。零依赖; strict。
 */

import { ansiToHtml } from './ansi-to-html';

const SEPARATOR_ROW = /^\|(\s*:?-+:?\s*\|)+$/;

/** diff 文本判定 (钉死规则见文件头)。 */
export function isDiffText(text: string): boolean {
  if (text.startsWith('diff --git ')) {
    return true;
  }
  if (/^@@ -\d/m.test(text)) {
    return true;
  }
  return /^--- /m.test(text) && /^\+\+\+ /m.test(text);
}

/** 管道表格判定 (钉死规则见文件头)。 */
export function isTableText(text: string): boolean {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length < 2) {
    return false;
  }
  if (!lines.every((line) => line.startsWith('|') && line.endsWith('|'))) {
    return false;
  }
  return lines.some((line) => SEPARATOR_ROW.test(line));
}

function parseTableRows(text: string): string[][] {
  const rows: string[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || SEPARATOR_ROW.test(line)) {
      continue;
    }
    const inner = line.slice(1, -1);
    rows.push(inner.split('|').map((cell) => cell.trim()));
  }
  return rows;
}

/** 工具结果渲染分发: diff -> pre.tool-diff, 表格 -> table, 默认 -> pre.tool-result。 */
export function renderToolResult(toolName: string, text: string): string {
  void toolName;
  if (isDiffText(text)) {
    return `<pre class="tool-diff">${ansiToHtml(text)}</pre>`;
  }
  if (isTableText(text)) {
    const rows = parseTableRows(text);
    const head = rows[0] ?? [];
    const body = rows.slice(1);
    const headCells = head.map((cell) => `<th>${ansiToHtml(cell)}</th>`).join('');
    const bodyRows = body
      .map((row) => `<tr>${row.map((cell) => `<td>${ansiToHtml(cell)}</td>`).join('')}</tr>`)
      .join('');
    return `<table class="tool-table"><tr>${headCells}</tr>${bodyRows}</table>`;
  }
  return `<pre class="tool-result">${ansiToHtml(text)}</pre>`;
}
