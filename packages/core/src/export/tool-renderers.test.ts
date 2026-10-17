import { describe, expect, test } from 'bun:test';
import { isDiffText, isTableText, renderToolResult } from './tool-renderers';

describe('BI-20.3 renderToolResult —— 分发判定', () => {
  test('普通文本 -> pre.tool-result', () => {
    expect(renderToolResult('bash', 'hello\nworld')).toBe(
      '<pre class="tool-result">hello\nworld</pre>',
    );
  });

  test("diff --git 开头 -> pre.tool-diff", () => {
    const diff = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644';
    expect(renderToolResult('edit', diff)).toBe(`<pre class="tool-diff">${diff}</pre>`);
  });

  test('@@ -1,2 行 -> pre.tool-diff', () => {
    const diff = 'context\n@@ -1,2 +1,3 @@\n+added';
    expect(renderToolResult('edit', diff)).toBe(`<pre class="tool-diff">${diff}</pre>`);
  });

  test('--- /+++ 成对 -> pre.tool-diff', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts';
    expect(renderToolResult('edit', diff)).toBe(`<pre class="tool-diff">${diff}</pre>`);
  });

  test('仅 --- 无 +++ 不误判为 diff', () => {
    const text = '--- 分割线\n普通文本';
    expect(isDiffText(text)).toBe(false);
    expect(renderToolResult('bash', text)).toBe(
      `<pre class="tool-result">${text}</pre>`,
    );
  });

  test('toolName 不影响内容分发 (纯内容判定)', () => {
    const diff = '@@ -1 +1 @@';
    expect(renderToolResult('bash', diff)).toBe(renderToolResult('edit', diff));
  });

  test('空文本 -> pre.tool-result', () => {
    expect(renderToolResult('bash', '')).toBe('<pre class="tool-result"></pre>');
  });

  test('diff 文本内 HTML 特殊字符被转义', () => {
    const diff = 'diff --git a<b';
    expect(renderToolResult('edit', diff)).toBe(
      '<pre class="tool-diff">diff --git a&lt;b</pre>',
    );
  });
});

describe('BI-20.3 renderToolResult —— 管道表格', () => {
  test('带分隔行的表格 -> table (首行 th, 分隔行跳过)', () => {
    const table = '| 文件 | 状态 |\n| --- | --- |\n| a.ts | 修改 |';
    expect(renderToolResult('grep', table)).toBe(
      '<table class="tool-table"><tr><th>文件</th><th>状态</th></tr><tr><td>a.ts</td><td>修改</td></tr></table>',
    );
  });

  test('无分隔行不误判为表格', () => {
    const text = '| a | b |\n| c | d |';
    expect(isTableText(text)).toBe(false);
    expect(renderToolResult('bash', text)).toBe(
      '<pre class="tool-result">| a | b |\n| c | d |</pre>',
    );
  });

  test('单元格内容 HTML 转义', () => {
    const table = '| x |\n| --- |\n| <i> |';
    expect(renderToolResult('bash', table)).toBe(
      '<table class="tool-table"><tr><th>x</th></tr><tr><td>&lt;i&gt;</td></tr></table>',
    );
  });

  test('单元格内 ANSI 仍转 span', () => {
    const table = '| 状态 |\n| --- |\n| \x1b[31m失败 |';
    expect(renderToolResult('bash', table)).toContain('<span class="ansi-red">失败</span>');
  });

  test('单行管道文本不判为表格', () => {
    expect(isTableText('| a | b |')).toBe(false);
  });

  test('混合管道行 (有非管道行) 不判为表格', () => {
    expect(isTableText('| a |\n| --- |\nplain')).toBe(false);
  });
});
