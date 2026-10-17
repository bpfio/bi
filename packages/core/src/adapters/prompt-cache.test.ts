/**
 * BI-04.1 — prompt-cache 测试。
 *
 * 覆盖：黄金排布字节锁死（System+BI.md → Tools → Anchor → 历史）、
 * appendHistory 逐字节真前缀、renderToolDefsBlock 确定性序列化、
 * fuzzyParseToolCall 五规则 escalation 容错（逐规则 + repaired 标记）。
 * 全部纯内存 fixture，零网络。
 */

import { describe, expect, test } from 'bun:test';

import type { ToolDef } from './prompt-cache';
import {
  PROMPT_PREFIX_ORDER,
  PROMPT_SEGMENT_SEPARATOR,
  appendHistory,
  buildPromptPrefix,
  fuzzyParseToolCall,
  renderToolDefsBlock,
} from './prompt-cache';

const SEP = PROMPT_SEGMENT_SEPARATOR;

const toolA: ToolDef = { name: 'get_weather', description: 'query weather', inputSchema: { type: 'object' } };
const toolB: ToolDef = { name: 'run_sql', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };

// ---------------------------------------------------------------------------
// 黄金排布
// ---------------------------------------------------------------------------

describe('BI-04.1 · 黄金排布', () => {
  test('PROMPT_PREFIX_ORDER 顺序锁死：system+biMd → tools → anchor → history', () => {
    expect([...PROMPT_PREFIX_ORDER]).toEqual(['system+biMd', 'tools', 'anchor', 'history']);
  });

  test('全段黄金排布：System+BI.md → Tools → Anchor，段间统一分隔符', () => {
    const prefix = buildPromptPrefix({ system: 'SYS', biMd: 'BI', tools: [toolA], anchor: 'ANCHOR' });
    expect(prefix).toBe(`SYS${SEP}BI${SEP}${renderToolDefsBlock([toolA])}${SEP}ANCHOR`);
  });

  test('缺 biMd：System 直接衔接 Tools，不产生空段', () => {
    const prefix = buildPromptPrefix({ system: 'SYS', tools: [toolA], anchor: 'A' });
    expect(prefix).toBe(`SYS${SEP}${renderToolDefsBlock([toolA])}${SEP}A`);
  });

  test('缺 anchor：前缀不以分隔符结尾', () => {
    const prefix = buildPromptPrefix({ system: 'SYS', biMd: 'BI', tools: [toolA] });
    expect(prefix.endsWith(SEP)).toBe(false);
    expect(prefix).toBe(`SYS${SEP}BI${SEP}${renderToolDefsBlock([toolA])}`);
  });

  test('空工具集：tools 段整体跳过（无空字节洞）', () => {
    const prefix = buildPromptPrefix({ system: 'SYS', biMd: 'BI', tools: [], anchor: 'A' });
    expect(prefix).toBe(`SYS${SEP}BI${SEP}A`);
  });

  test('确定性：同输入恒同字节（可作 KV 前缀键）', () => {
    const segments = { system: 'S', biMd: 'B', tools: [toolA, toolB], anchor: 'X' };
    expect(buildPromptPrefix(segments)).toBe(buildPromptPrefix({ ...segments }));
  });

  test('静态段字节变动即打穿前缀：BI.md 变化改变前缀字节', () => {
    const base = buildPromptPrefix({ system: 'S', biMd: 'B1', tools: [toolA] });
    const changed = buildPromptPrefix({ system: 'S', biMd: 'B2', tools: [toolA] });
    expect(base).not.toBe(changed);
  });

  test('appendHistory 逐字节真前缀：不偷加分隔符', () => {
    const prefix = buildPromptPrefix({ system: 'SYS', tools: [toolA] });
    const full = appendHistory(prefix, 'turn-1');
    expect(full.startsWith(prefix)).toBe(true);
    expect(full.slice(0, prefix.length)).toBe(prefix);
    expect(full.length).toBe(prefix.length + 'turn-1'.length);
  });

  test('appendHistory 链式追加：prefix 恒为真前缀，历史单调增长', () => {
    const prefix = buildPromptPrefix({ system: 'SYS', tools: [] });
    const step1 = appendHistory(prefix, 'h1');
    const step2 = appendHistory(step1, 'h2');
    expect(step2.startsWith(prefix)).toBe(true);
    expect(step2.startsWith(step1)).toBe(true);
    expect(step2).toBe(prefix + 'h1' + 'h2');
  });

  test('端到端：静态前缀 + 历史保持黄金排布（history 永不插入静态段）', () => {
    const prefix = buildPromptPrefix({ system: 'SYS', biMd: 'BI', tools: [toolA], anchor: 'A' });
    const full = appendHistory(prefix, `${SEP}user: hi${SEP}assistant: yo`);
    expect(full.indexOf('SYS')).toBeLessThan(full.indexOf('BI'));
    expect(full.indexOf('BI')).toBeLessThan(full.indexOf('get_weather'));
    expect(full.indexOf('get_weather')).toBeLessThan(full.indexOf('A'));
    expect(full.indexOf('A')).toBeLessThan(full.indexOf('user: hi'));
  });
});

// ---------------------------------------------------------------------------
// 工具块确定性序列化
// ---------------------------------------------------------------------------

describe('BI-04.1 · renderToolDefsBlock', () => {
  test('键序规范化：等价工具（构造键序不同）序列化恒同字节', () => {
    const x: ToolDef = { name: 't', inputSchema: { type: 'object', properties: {} }, description: 'd' };
    const y: ToolDef = { description: 'd', inputSchema: { properties: {}, type: 'object' }, name: 't' };
    expect(renderToolDefsBlock([x])).toBe(renderToolDefsBlock([y]));
  });

  test('工具数组序保持调用方字节序（不重排）', () => {
    expect(renderToolDefsBlock([toolA, toolB])).not.toBe(renderToolDefsBlock([toolB, toolA]));
  });

  test('空工具集 → 空串', () => {
    expect(renderToolDefsBlock([])).toBe('');
  });

  test('嵌套 schema 键序也规范化（深层确定性）', () => {
    const a: ToolDef = { name: 't', inputSchema: { properties: { b: { type: 'string' }, a: { type: 'number' } } } };
    const b: ToolDef = { name: 't', inputSchema: { properties: { a: { type: 'number' }, b: { type: 'string' } } } };
    expect(renderToolDefsBlock([a])).toBe(renderToolDefsBlock([b]));
  });
});

// ---------------------------------------------------------------------------
// fuzzyParseToolCall 五规则容错
// ---------------------------------------------------------------------------

describe('BI-04.1 · fuzzyParseToolCall', () => {
  test('合法 JSON 原样透传：无 repaired 标记', () => {
    const r = fuzzyParseToolCall('{"name":"get_weather","arguments":{"city":"SF"}}');
    expect(r.ok).toBe(true);
    expect(r.call).toEqual({ name: 'get_weather', arguments: { city: 'SF' } });
    expect(r.repaired).toBeUndefined();
  });

  test('规则 1 strip-markdown-fence：```json 围栏剥离', () => {
    const r = fuzzyParseToolCall('```json\n{"name":"f","arguments":{"a":1}}\n```');
    expect(r.ok).toBe(true);
    expect(r.call?.name).toBe('f');
    expect(r.repaired?.rules).toEqual(['strip-markdown-fence']);
  });

  test('规则 1 裸围栏（无语言标签）同样剥离', () => {
    const r = fuzzyParseToolCall('```\n{"name":"f","arguments":{}}\n```');
    expect(r.ok).toBe(true);
    expect(r.repaired?.rules).toEqual(['strip-markdown-fence']);
  });

  test('规则 2+3 补尾引号再补尾括号：{"name": "abc} → name="abc}"', () => {
    const r = fuzzyParseToolCall('{"name": "abc}');
    expect(r.ok).toBe(true);
    expect(r.call?.name).toBe('abc}');
    expect(r.call?.arguments).toEqual({});
    expect(r.repaired?.rules).toEqual(['close-trailing-quote', 'close-trailing-bracket']);
  });

  test('规则 3 close-trailing-bracket：嵌套未闭合按栈序补 ]}}', () => {
    const r = fuzzyParseToolCall('{"name":"f","arguments":{"a":[1,2');
    expect(r.ok).toBe(true);
    expect(r.call).toEqual({ name: 'f', arguments: { a: [1, 2] } });
    expect(r.repaired?.rules).toEqual(['close-trailing-bracket']);
  });

  test('规则 4 single-to-double-quotes：单引号整体转双引号', () => {
    const r = fuzzyParseToolCall("{'name': 'get_weather', 'arguments': {'city': 'SF'}}");
    expect(r.ok).toBe(true);
    expect(r.call).toEqual({ name: 'get_weather', arguments: { city: 'SF' } });
    expect(r.repaired?.rules).toEqual(['single-to-double-quotes']);
  });

  test('规则 4 不破坏双引号串内 Apostrophe（"it\'s" 原样保留）', () => {
    const r = fuzzyParseToolCall(`{"name":"f","arguments":{"q":"it's fine"}}`);
    expect(r.ok).toBe(true);
    expect(r.call?.arguments).toEqual({ q: "it's fine" });
    expect(r.repaired).toBeUndefined();
  });

  test('规则 5 strip-trailing-comma：} 前尾逗号移除', () => {
    const r = fuzzyParseToolCall('{"name":"f","arguments":{"a":1,}}');
    expect(r.ok).toBe(true);
    expect(r.call).toEqual({ name: 'f', arguments: { a: 1 } });
    expect(r.repaired?.rules).toEqual(['strip-trailing-comma']);
  });

  test('组合修复：围栏 + 单引号 + 尾逗号按固定顺序记录', () => {
    const r = fuzzyParseToolCall("```json\n{'name':'f','arguments':{'a':1,}}\n```");
    expect(r.ok).toBe(true);
    expect(r.call).toEqual({ name: 'f', arguments: { a: 1 } });
    expect(r.repaired?.rules).toEqual(['strip-markdown-fence', 'single-to-double-quotes', 'strip-trailing-comma']);
  });

  test('字符串型 arguments（Qwen 常见）自动解包，内层修复规则合并上报', () => {
    const r = fuzzyParseToolCall('{"name":"f","arguments":"{\\"a\\":1,}"}');
    expect(r.ok).toBe(true);
    expect(r.call).toEqual({ name: 'f', arguments: { a: 1 } });
    expect(r.repaired?.rules).toEqual(['strip-trailing-comma']);
  });

  test('arguments 缺省视为空对象（宽松形状）', () => {
    const r = fuzzyParseToolCall('{"name":"f"}');
    expect(r.ok).toBe(true);
    expect(r.call).toEqual({ name: 'f', arguments: {} });
  });

  test('全规则修不动 → ok=false 结构化原因（不抛异常）', () => {
    const r = fuzzyParseToolCall('definitely not json at all!!!');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unparseable-json');
    expect(r.call).toBeUndefined();
  });

  test('合法 JSON 但缺 name → ok=false（语法修复不救形状错误）', () => {
    const r = fuzzyParseToolCall('{"foo":"bar"}');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('missing-name');
  });

  test('arguments 字符串修不动 → ok=false: arguments-unparseable', () => {
    const r = fuzzyParseToolCall('{"name":"f","arguments":"@@@"}');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('arguments-unparseable');
  });
});
