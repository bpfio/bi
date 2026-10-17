/**
 * BI-20.3 — 会话 HTML 导出。
 *
 * 零依赖独立 HTML: 内联 CSS, 双主题色表 (dark/light) 确定性常量。
 * 工具结果渲染分发见 ./tool-renderers.ts; ANSI 文本经 ./ansi-to-html.ts 转换。
 * 输出结构 (钉死): <!DOCTYPE html> ... <style> 内联 CSS ... <h1> 标题 ...
 * 每个 entry 一个 <section class="entry entry-{type}">。
 */

import { ANSI_CSS, ansiToHtml } from './ansi-to-html';
import { renderToolResult } from './tool-renderers';

export type EntryType = 'user' | 'assistant' | 'tool';

export interface SessionEntry {
  type: EntryType;
  toolName?: string;
  text: string;
}

export interface Session {
  title: string;
  entries: SessionEntry[];
}

export type Theme = 'dark' | 'light';

export interface ExportOptions {
  /** 缺省 'dark'。 */
  theme?: Theme;
}

/** 双主题色表 (确定性常量, 测试钉死)。 */
export interface ThemeColors {
  bg: string;
  fg: string;
  border: string;
  userAccent: string;
  assistantAccent: string;
  toolAccent: string;
}

export const THEME_COLORS: Record<Theme, ThemeColors> = {
  dark: {
    bg: '#1e1e1e',
    fg: '#d4d4d4',
    border: '#333333',
    userAccent: '#569cd6',
    assistantAccent: '#4ec9b0',
    toolAccent: '#ce9178',
  },
  light: {
    bg: '#ffffff',
    fg: '#1e1e1e',
    border: '#dddddd',
    userAccent: '#0451a5',
    assistantAccent: '#098658',
    toolAccent: '#a31515',
  },
};

/** HTML 转义 (& 先行)。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildCss(colors: ThemeColors): string {
  return [
    `body { background: ${colors.bg}; color: ${colors.fg}; font-family: monospace; margin: 16px; }`,
    'h1 { font-size: 16px; }',
    `.entry { border: 1px solid ${colors.border}; border-radius: 4px; padding: 8px; margin: 8px 0; }`,
    `.entry-user { border-left: 4px solid ${colors.userAccent}; }`,
    `.entry-assistant { border-left: 4px solid ${colors.assistantAccent}; }`,
    `.entry-tool { border-left: 4px solid ${colors.toolAccent}; }`,
    `.tool-name { color: ${colors.toolAccent}; font-weight: bold; }`,
    'pre { margin: 4px 0; white-space: pre-wrap; }',
    'table { border-collapse: collapse; }',
    `th, td { border: 1px solid ${colors.border}; padding: 2px 6px; text-align: left; }`,
    ANSI_CSS,
  ].join('\n');
}

function renderEntry(entry: SessionEntry): string {
  if (entry.type === 'tool') {
    const name = entry.toolName ?? '';
    return [
      '<section class="entry entry-tool">',
      `<div class="role tool-name">${escapeHtml(name)}</div>`,
      renderToolResult(name, entry.text),
      '</section>',
    ].join('\n');
  }
  return [
    `<section class="entry entry-${entry.type}">`,
    `<div class="role">${entry.type}</div>`,
    `<pre>${ansiToHtml(entry.text)}</pre>`,
    '</section>',
  ].join('\n');
}

/** 组装零依赖独立 HTML (内联 CSS + 两主题; 同输入逐字节确定)。 */
export function exportHtml(session: Session, opts: ExportOptions = {}): string {
  const theme = opts.theme ?? 'dark';
  const colors = THEME_COLORS[theme];
  const title = escapeHtml(session.title);
  const sections = session.entries.map(renderEntry).join('\n');
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    '<style>',
    buildCss(colors),
    '</style>',
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    sections,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
