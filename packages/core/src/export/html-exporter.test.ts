import { describe, expect, test } from 'bun:test';
import {
  THEME_COLORS,
  escapeHtml,
  exportHtml,
  type Session,
} from './html-exporter';

const DEMO: Session = { title: 'Demo', entries: [{ type: 'user', text: 'hi' }] };

/** 双主题 golden 快照 (dark, 钉死逐字节)。 */
const GOLDEN_DARK = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Demo</title>
<style>
body { background: #1e1e1e; color: #d4d4d4; font-family: monospace; margin: 16px; }
h1 { font-size: 16px; }
.entry { border: 1px solid #333333; border-radius: 4px; padding: 8px; margin: 8px 0; }
.entry-user { border-left: 4px solid #569cd6; }
.entry-assistant { border-left: 4px solid #4ec9b0; }
.entry-tool { border-left: 4px solid #ce9178; }
.tool-name { color: #ce9178; font-weight: bold; }
pre { margin: 4px 0; white-space: pre-wrap; }
table { border-collapse: collapse; }
th, td { border: 1px solid #333333; padding: 2px 6px; text-align: left; }
.ansi-bold { font-weight: bold; }
.ansi-black { color: #808080; }
.ansi-red { color: #cd3131; }
.ansi-green { color: #0dbc79; }
.ansi-yellow { color: #e5e510; }
.ansi-blue { color: #2472c8; }
.ansi-magenta { color: #bc3fbc; }
.ansi-cyan { color: #11a8cd; }
.ansi-white { color: #e5e5e5; }
</style>
</head>
<body>
<h1>Demo</h1>
<section class="entry entry-user">
<div class="role">user</div>
<pre>hi</pre>
</section>
</body>
</html>
`;

describe('BI-20.3 exportHtml —— 主题色表', () => {
  test('THEME_COLORS 双主题六字段钉死', () => {
    expect(THEME_COLORS.dark).toEqual({
      bg: '#1e1e1e',
      fg: '#d4d4d4',
      border: '#333333',
      userAccent: '#569cd6',
      assistantAccent: '#4ec9b0',
      toolAccent: '#ce9178',
    });
    expect(THEME_COLORS.light).toEqual({
      bg: '#ffffff',
      fg: '#1e1e1e',
      border: '#dddddd',
      userAccent: '#0451a5',
      assistantAccent: '#098658',
      toolAccent: '#a31515',
    });
  });

  test('缺省 theme 为 dark', () => {
    const html = exportHtml(DEMO);
    expect(html).toContain('background: #1e1e1e');
    expect(html).not.toContain('background: #ffffff');
  });

  test('theme light 使用亮色表', () => {
    const html = exportHtml(DEMO, { theme: 'light' });
    expect(html).toContain('background: #ffffff');
    expect(html).toContain('.entry-user { border-left: 4px solid #0451a5; }');
  });

  test('双主题仅色值不同 (剥掉 hex 后逐字节一致)', () => {
    const dark = exportHtml(DEMO, { theme: 'dark' });
    const light = exportHtml(DEMO, { theme: 'light' });
    const strip = (s: string): string => s.replace(/#[0-9a-fA-F]{6}/g, '');
    expect(strip(dark)).toBe(strip(light));
    expect(dark).not.toBe(light);
  });

  test('golden 快照: dark 主题小会话逐字节一致', () => {
    expect(exportHtml(DEMO)).toBe(GOLDEN_DARK);
  });
});

describe('BI-20.3 exportHtml —— 结构与转义', () => {
  test('title HTML 转义 (title 与 h1)', () => {
    const html = exportHtml({ title: '<B&>', entries: [] });
    expect(html).toContain('<title>&lt;B&amp;&gt;</title>');
    expect(html).toContain('<h1>&lt;B&amp;&gt;</h1>');
    expect(html.includes('<h1><B')).toBe(false);
  });

  test('user/assistant/tool 三类 section 与 role 标注', () => {
    const html = exportHtml({
      title: 't',
      entries: [
        { type: 'user', text: 'q' },
        { type: 'assistant', text: 'a' },
        { type: 'tool', toolName: 'bash', text: 'ok' },
      ],
    });
    expect(html).toContain('<section class="entry entry-user">');
    expect(html).toContain('<section class="entry entry-assistant">');
    expect(html).toContain('<section class="entry entry-tool">');
    expect(html).toContain('<div class="role">user</div>');
    expect(html).toContain('<div class="role tool-name">bash</div>');
  });

  test('toolName 缺省为空串 (仍转义安全)', () => {
    const html = exportHtml({ title: 't', entries: [{ type: 'tool', text: 'x' }] });
    expect(html).toContain('<div class="role tool-name"></div>');
  });

  test('entry 文本经 ANSI 转换 (span 输出)', () => {
    const html = exportHtml({
      title: 't',
      entries: [{ type: 'assistant', text: '\x1b[31m红' }],
    });
    expect(html).toContain('<span class="ansi-red">红</span>');
  });

  test('tool 文本经分发: 表格输入产出 table, diff 输入产出 tool-diff', () => {
    const html = exportHtml({
      title: 't',
      entries: [
        { type: 'tool', toolName: 'grep', text: '| a |\n| --- |\n| 1 |' },
        { type: 'tool', toolName: 'edit', text: '@@ -1 +1 @@' },
      ],
    });
    expect(html).toContain('<table class="tool-table">');
    expect(html).toContain('<pre class="tool-diff">@@ -1 +1 @@</pre>');
  });

  test('空会话: 无 section 但含标题与完整骨架', () => {
    const html = exportHtml({ title: '空', entries: [] });
    expect(html.includes('<section')).toBe(false);
    expect(html).toContain('<h1>空</h1>');
    expect(html).toContain('<style>');
    expect(html.endsWith('</html>\n')).toBe(true);
  });

  test('确定性: 同输入两次导出逐字节一致', () => {
    expect(exportHtml(DEMO, { theme: 'light' })).toBe(exportHtml(DEMO, { theme: 'light' }));
  });

  test('escapeHtml 单元: & < > " 全覆盖', () => {
    expect(escapeHtml('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e');
  });
});
