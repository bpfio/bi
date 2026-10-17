import { describe, expect, test } from 'bun:test';
import { ANSI_CSS, ANSI_CLASS_ORDER, ansiToHtml } from './ansi-to-html';

describe('BI-20.3 ansiToHtml —— 纯文本与转义', () => {
  test('无 ANSI 纯文本原样输出', () => {
    expect(ansiToHtml('hello world')).toBe('hello world');
  });

  test('HTML 特殊字符转义 (& < > ")', () => {
    expect(ansiToHtml('a<b & c>d "e"')).toBe('a&lt;b &amp; c&gt;d &quot;e&quot;');
  });

  test('span 内文本同样转义', () => {
    expect(ansiToHtml('\x1b[31m<x>\x1b[0m')).toBe('<span class="ansi-red">&lt;x&gt;</span>');
  });

  test('空字符串 -> 空输出', () => {
    expect(ansiToHtml('')).toBe('');
  });
});

describe('BI-20.3 ansiToHtml —— 基础色矩阵 (30..37)', () => {
  const CASES: Array<[number, string]> = [
    [30, 'ansi-black'],
    [31, 'ansi-red'],
    [32, 'ansi-green'],
    [33, 'ansi-yellow'],
    [34, 'ansi-blue'],
    [35, 'ansi-magenta'],
    [36, 'ansi-cyan'],
    [37, 'ansi-white'],
  ];

  test('30..37 全色映射 span', () => {
    for (const [code, cls] of CASES) {
      expect(ansiToHtml(`\x1b[${code}mX\x1b[0m`)).toBe(`<span class="${cls}">X</span>`);
    }
  });

  test('红色区间持续到重置', () => {
    expect(ansiToHtml('\x1b[31mred plain')).toBe('<span class="ansi-red">red plain</span>');
  });

  test('色槽互斥: 后到色替换前色', () => {
    expect(ansiToHtml('\x1b[31mred\x1b[32mgreen')).toBe(
      '<span class="ansi-red">red</span><span class="ansi-green">green</span>',
    );
  });

  test('文本在色码前后正确分段', () => {
    expect(ansiToHtml('a\x1b[34mb\x1b[0mc')).toBe(
      'a<span class="ansi-blue">b</span>c',
    );
  });
});

describe('BI-20.3 ansiToHtml —— 粗体与重置', () => {
  test('\\x1b[1m -> ansi-bold', () => {
    expect(ansiToHtml('\x1b[1mB\x1b[0m')).toBe('<span class="ansi-bold">B</span>');
  });

  test('粗体+色规范序: ansi-bold 在前', () => {
    expect(ansiToHtml('\x1b[31;1mX\x1b[0m')).toBe('<span class="ansi-bold ansi-red">X</span>');
    expect(ansiToHtml('\x1b[1;31mX\x1b[0m')).toBe('<span class="ansi-bold ansi-red">X</span>');
  });

  test('\\x1b[0m 清空粗体与色', () => {
    expect(ansiToHtml('\x1b[1;33mA\x1b[0mplain')).toBe(
      '<span class="ansi-bold ansi-yellow">A</span>plain',
    );
  });

  test('\\x1b[22m 仅取消粗体保留色', () => {
    expect(ansiToHtml('\x1b[1;31mA\x1b[22mB')).toBe(
      '<span class="ansi-bold ansi-red">A</span><span class="ansi-red">B</span>',
    );
  });

  test('\\x1b[39m 清前景色保留粗体', () => {
    expect(ansiToHtml('\x1b[1;31mA\x1b[39mB')).toBe(
      '<span class="ansi-bold ansi-red">A</span><span class="ansi-bold">B</span>',
    );
  });

  test('\\x1b[m 空参数等价 \\x1b[0m', () => {
    expect(ansiToHtml('\x1b[31mA\x1b[mB')).toBe('<span class="ansi-red">A</span>B');
  });
});

describe('BI-20.3 ansiToHtml —— 未知码忽略', () => {
  test('下划线 4 / 反显 7 / 亮色 90 等未知码剥离且不产出类', () => {
    expect(ansiToHtml('\x1b[4mX')).toBe('X');
    expect(ansiToHtml('\x1b[7mX')).toBe('X');
    expect(ansiToHtml('\x1b[90mX')).toBe('X');
    expect(ansiToHtml('\x1b[38;5;196mX')).toBe('X');
  });

  test('混合已知+未知码: 已知生效未知忽略', () => {
    expect(ansiToHtml('\x1b[4;31mX')).toBe('<span class="ansi-red">X</span>');
  });

  test('ANSI_CLASS_ORDER 规范序钉死', () => {
    expect([...ANSI_CLASS_ORDER]).toEqual([
      'ansi-bold',
      'ansi-black',
      'ansi-red',
      'ansi-green',
      'ansi-yellow',
      'ansi-blue',
      'ansi-magenta',
      'ansi-cyan',
      'ansi-white',
    ]);
  });

  test('ANSI_CSS 包含全部类与固定调色板', () => {
    expect(ANSI_CSS).toContain('.ansi-bold { font-weight: bold; }');
    expect(ANSI_CSS).toContain('.ansi-red { color: #cd3131; }');
    expect(ANSI_CSS).toContain('.ansi-blue { color: #2472c8; }');
  });
});
