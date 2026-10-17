/**
 * BI-04.2 — reasoning-stream 测试。
 *
 * 覆盖：thinking/正文分离、signature_delta 无损透传（逐字节）、reasoning_content
 * 聚合、ReplayEnvelope 序列化往返（unicode/空串/畸形输入）、toReplayBlocks 回放、
 * v41 视觉 Token 网格数学（公式锚定/上采样/极端长宽比/1024 钳制/非法输入）。
 * 全部纯内存 fixture，零网络。
 */

import { describe, expect, test } from 'bun:test';

import type { FetchLike, StreamEvent } from './deepseek-adapter';
import {
  CELL_SIZE,
  MAX_IMAGE_TOKENS,
  MIN_PIXELS,
  PATCH_SIZE,
  ReasoningAccumulator,
  deserializeReasoning,
  gridCells,
  gridTokens,
  parseReasoningStream,
  serializeReasoning,
  toReplayBlocks,
  v41ImageGrid,
  v41ImageTokens,
  type ReasoningResult,
} from './reasoning-stream';

function eventsOf(...events: StreamEvent[]): StreamEvent[] {
  return events;
}

function resultOf(r: ReasoningResult): string {
  return JSON.stringify(r);
}

// ---------------------------------------------------------------------------
// 思考流分离与签名透传
// ---------------------------------------------------------------------------

describe('parseReasoningStream · 分离与聚合', () => {
  test('thinking 块与正文 content 完全分离、互不污染', async () => {
    const result = await parseReasoningStream(
      eventsOf(
        { type: 'thinking_delta', delta: '第一步。' },
        { type: 'content_delta', delta: '答案：' },
        { type: 'thinking_delta', delta: '第二步。' },
        { type: 'content_delta', delta: '42' },
      ),
    );
    expect(result.thinking).toBe('第一步。第二步。');
    expect(result.content).toBe('答案：42');
    expect(result.signature).toBeUndefined();
  });

  test('signature_delta 无损透传：多段增量逐字节拼接（含空格/斜杠/unicode）', async () => {
    const signature = ' sig/Λws==\nΩ© ';
    const result = await parseReasoningStream(
      eventsOf(
        { type: 'thinking_delta', delta: 'T' },
        { type: 'signature_delta', delta: ' sig/' },
        { type: 'signature_delta', delta: 'Λws==' },
        { type: 'signature_delta', delta: '\nΩ© ' },
        { type: 'content_delta', delta: 'C' },
      ),
    );
    expect(result.signature).toBe(signature);
    // 序列化后签名逐字节保真（无损，无 trim/转义歧义）
    const restored = deserializeReasoning(serializeReasoning(result));
    expect(restored.signature).toBe(signature);
  });

  test('reasoning_content 聚合：openai 适配器归一化后的 thinking_delta 累积', async () => {
    const result = await parseReasoningStream(
      eventsOf(
        { type: 'thinking_delta', delta: 'reasoning-1' },
        { type: 'thinking_delta', delta: '+reasoning-2' },
        { type: 'content_delta', delta: 'body' },
      ),
    );
    expect(result.thinking).toBe('reasoning-1+reasoning-2');
    expect(result.content).toBe('body');
  });

  test('tool_call_delta/usage/done/error 事件被忽略，不污染分离结果', async () => {
    const result = await parseReasoningStream(
      eventsOf(
        { type: 'tool_call_delta', index: 0, name: 'bash', argumentsDelta: '{"x":1}' },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
        { type: 'done', stopReason: 'tool_use' },
        { type: 'error', error: { code: 'server', message: 'x' } },
      ),
    );
    expect(result.thinking).toBe('');
    expect(result.content).toBe('');
    expect(result.signature).toBeUndefined();
  });

  test('sync 数组与 async iterable 两种输入等价；ReasoningAccumulator 增量快照一致', async () => {
    const events = eventsOf(
      { type: 'thinking_delta', delta: 'abc' },
      { type: 'signature_delta', delta: 'SIG' },
      { type: 'content_delta', delta: 'xyz' },
    );
    const fromArray = await parseReasoningStream(events);
    async function* gen(): AsyncGenerator<StreamEvent> {
      for (const e of events) yield e;
    }
    const fromAsync = await parseReasoningStream(gen());
    expect(resultOf(fromArray)).toBe(resultOf(fromAsync));

    const acc = new ReasoningAccumulator();
    for (const e of events) acc.push(e);
    expect(resultOf(acc.snapshot())).toBe(resultOf(fromArray));
  });
});

// ---------------------------------------------------------------------------
// ReplayEnvelope 序列化往返
// ---------------------------------------------------------------------------

describe('ReplayEnvelope 序列化往返', () => {
  test('完整结构（thinking+signature+content）字节级往返', () => {
    const r: ReasoningResult = {
      thinking: '思考\n多行\t含 emoji 🧠 与引号 "q"',
      signature: ' base64+/=签 ',
      content: '正文 Unicode ✓',
    };
    const json = serializeReasoning(r);
    expect(JSON.parse(json)).toEqual({
      version: 1,
      thinking: r.thinking,
      signature: r.signature,
      content: r.content,
    });
    const restored = deserializeReasoning(json);
    expect(resultOf(restored)).toBe(resultOf(r));
    // 幂等：二次序列化稳定
    expect(serializeReasoning(restored)).toBe(json);
  });

  test('空串与无 signature：键精确（signature 缺席，不序列化为 null/空串）', () => {
    const r: ReasoningResult = { thinking: '', content: 'only' };
    const json = serializeReasoning(r);
    expect(JSON.parse(json)).toEqual({ version: 1, thinking: '', content: 'only' });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect('signature' in parsed).toBe(false);
    expect(deserializeReasoning(json)).toEqual({ thinking: '', content: 'only' });
  });

  test('空串 signature：见过 signature_delta 即存在，序列化保留空串', () => {
    const r: ReasoningResult = { thinking: 't', signature: '', content: 'c' };
    const restored = deserializeReasoning(serializeReasoning(r));
    expect(restored.signature).toBe('');
  });

  test('畸形输入抛 TypeError：坏 JSON / version 不符 / 缺 content / 非 object', () => {
    expect(() => deserializeReasoning('not json{')).toThrow(TypeError);
    expect(() => deserializeReasoning('[]')).toThrow(TypeError);
    expect(() =>
      deserializeReasoning(JSON.stringify({ version: 2, thinking: '', content: '' })),
    ).toThrow(TypeError);
    expect(() => deserializeReasoning(JSON.stringify({ version: 1, thinking: 'x' }))).toThrow(
      TypeError,
    );
    expect(() =>
      deserializeReasoning(
        JSON.stringify({ version: 1, thinking: 'x', content: 'y', signature: 42 }),
      ),
    ).toThrow(TypeError);
  });

  test('toReplayBlocks：thinking(带签名)在前、正文在后；空块不产出', () => {
    expect(
      toReplayBlocks({ thinking: 'T', signature: 'S', content: 'C' }),
    ).toEqual([
      { type: 'thinking', thinking: 'T', signature: 'S' },
      { type: 'text', text: 'C' },
    ]);
    expect(toReplayBlocks({ thinking: '', content: 'C' })).toEqual([
      { type: 'text', text: 'C' },
    ]);
    expect(toReplayBlocks({ thinking: 'T', content: '' })).toEqual([
      { type: 'thinking', thinking: 'T' },
    ]);
    expect(toReplayBlocks({ thinking: '', content: '' })).toEqual([]);
  });

  test('端到端：适配器流 → 分离 → 序列化 → 反序列化 → buildRequest 回放（签名闭环）', async () => {
    const { DeepSeekAdapter } = await import('./deepseek-adapter');
    const { buildRequest } = await import('./deepseek-adapter');
    const sse = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"S/=="}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"答"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const fetchImpl: FetchLike = async () =>
      new Response(new Blob([sse]), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const result = await parseReasoningStream(
      adapter.stream(
        buildRequest([{ role: 'user', content: 'q' }], { mode: 'messages', model: 'm' }),
      ),
    );
    expect(result).toEqual({ thinking: '想', signature: 'S/==', content: '答' });

    // 序列化往返后回放：签名原样进入下一轮请求体
    const replayed = deserializeReasoning(serializeReasoning(result));
    const req = buildRequest(
      [
        { role: 'assistant', content: toReplayBlocks(replayed) },
        { role: 'user', content: '继续' },
      ],
      { mode: 'messages', model: 'm' },
    );
    if (req.mode !== 'messages') return;
    expect(req.body.messages[0]?.content).toEqual([
      { type: 'thinking', thinking: '想', signature: 'S/==' },
      { type: 'text', text: '答' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// v41 视觉 Token 网格数学
// ---------------------------------------------------------------------------

describe('v41 视觉 Token 网格', () => {
  test('常量与官方公式锚定：PATCH=14、CELL=42、MIN_PIXELS=544²、gridTokens 公式', () => {
    expect(PATCH_SIZE).toBe(14);
    expect(CELL_SIZE).toBe(42);
    expect(MIN_PIXELS).toBe(295936);
    expect(MAX_IMAGE_TOKENS).toBe(1024);
    expect(gridCells(1050)).toBe(25); // floor(1050/14)=75 → ceil(75/3)=25
    expect(gridTokens(25, 25)).toBe(652); // 25×26+2
    expect(gridTokens(1, 1)).toBe(4); // 最小网格 = 1×1 + 2 帧位
  });

  test('标准 1024×1024 → 652（手算锚定：pad 1050 → 25×26+2）', () => {
    expect(v41ImageTokens(1024, 1024)).toBe(652);
    const grid = v41ImageGrid(1024, 1024);
    expect(grid).toEqual({ width: 25, height: 25, tokens: 652 });
  });

  test('小图上采样至 MIN_PIXELS：100×100 → ×6 → 630 pad → 242；200×200 同网格', () => {
    // 100×100=10000 < 295936 → f=6（f=5 时 250000 仍不足）
    expect(v41ImageTokens(100, 100)).toBe(242);
    // 200×200 → f=3 → 同样 600×600 → 网格一致
    expect(v41ImageTokens(200, 200)).toBe(242);
  });

  test('极端长宽比 10000×10 → 1×477 网格 → 480', () => {
    // f=2 → 20000×20；padW=20034→477 单元；padH=42→1 单元；1×(477+1)+2
    expect(v41ImageTokens(10000, 10)).toBe(480);
    const grid = v41ImageGrid(10000, 10);
    expect(grid.height).toBe(1);
    expect(grid.width).toBe(477);
    expect(grid.tokens).toBe(480);
  });

  test('1024 上限钳制：4096×4096 → tokens ≤1024、方形保持方形、结果确定', () => {
    const g1 = v41ImageGrid(4096, 4096);
    expect(g1.tokens).toBeLessThanOrEqual(1024);
    expect(g1.tokens).toBeGreaterThanOrEqual(4);
    expect(Math.abs(g1.width - g1.height)).toBeLessThanOrEqual(1);
    const g2 = v41ImageGrid(4096, 4096);
    expect(g2).toEqual(g1);
  });

  test('超宽幅 20000×10000 钳制：tokens ≤1024 且宽高比≈2 保持', () => {
    const g = v41ImageGrid(20000, 10000);
    expect(g.tokens).toBeLessThanOrEqual(1024);
    expect(g.tokens).toBeGreaterThanOrEqual(4);
    const ratio = g.width / g.height;
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.6);
  });

  test('参数化 maxTokens 钳制：maxTokens=100 → ≤100 且 ≥4', () => {
    const t = v41ImageTokens(1024, 1024, { maxTokens: 100 });
    expect(t).toBeLessThanOrEqual(100);
    expect(t).toBeGreaterThanOrEqual(4);
  });

  test('自定义 minPixels=0：10×10 不上采样 → 1×1 网格 → 4', () => {
    expect(v41ImageTokens(10, 10, { minPixels: 0 })).toBe(4);
  });

  test('同宽高比尺寸递增 tokens 单调不减（100/200/400/800/1024 方图）', () => {
    const seq = [100, 200, 400, 800, 1024].map((s) => v41ImageTokens(s, s));
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
    }
    expect(seq).toEqual([242, 242, 422, 422, 652]);
  });

  test('非法输入抛 RangeError：0/负数/NaN/Infinity', () => {
    expect(() => v41ImageTokens(0, 100)).toThrow(RangeError);
    expect(() => v41ImageTokens(100, -1)).toThrow(RangeError);
    expect(() => v41ImageTokens(Number.NaN, 100)).toThrow(RangeError);
    expect(() => v41ImageTokens(100, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => v41ImageTokens(100, 100, { maxTokens: 3 })).toThrow(RangeError);
  });
});
