/**
 * BI-04.2 — deepseek-adapter 测试。
 *
 * 全 fixture 注入（fetchImpl / ReadableStream / 字节级切割），零真实网络。
 * 覆盖：双模态 buildRequest 矩阵、SSE 任意切割点 + 跨 chunk 拼接 + 多字节
 * UTF-8、thinking/signature 流、错误五分类、EMPTY_RESPONSE 终态防御、
 * O(N) 确定性证明（jsonParses 与切割无关）与时间粗测。
 */

import { describe, expect, test } from 'bun:test';

import {
  DeepSeekAdapter,
  SSEParser,
  buildRequest,
  type AgentMessage,
  type BuildRequestOptions,
  type FetchLike,
  type MessagesWireBody,
  type OpenAIWireBody,
  type StreamEvent,
  type ToolDefinition,
  type WireRequest,
} from './deepseek-adapter';

// ---------------------------------------------------------------------------
// fixture 工具
// ---------------------------------------------------------------------------

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** 把字节流包装成 SSE Response（ReadableStream 逐块 enqueue）。 */
function sseResponse(chunks: Uint8Array[], headers?: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: headers ?? { 'content-type': 'text/event-stream' },
  });
}

/** 错误 Response（JSON 文本体）。 */
function errorResponse(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: headers ?? { 'content-type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  responder: (call: FetchCall) => Response,
): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call: FetchCall = { url: String(input), init };
    calls.push(call);
    return responder(call);
  };
  return { fetchImpl, calls };
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** 确定性 LCG 伪随机字节切割（含强制多字节 UTF-8 中断点）。 */
function splitBytesDeterministic(bytes: Uint8Array, seed: number, extraCuts: number): Uint8Array[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const cuts = new Set<number>();
  // 前 80 字节逐字节切割（覆盖 'data:'、JSON 起始、行边界被斩断的情形）。
  for (let i = 1; i < Math.min(80, bytes.length); i++) cuts.add(i);
  for (let i = 0; i < extraCuts; i++) cuts.add(1 + Math.floor(next() * (bytes.length - 1)));
  // 强制切进多字节序列：找 '🎯'（4 字节 UTF-8）与 '中'（3 字节）的位置。
  const target = bytesOf('🎯');
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      bytes[i] === target[0] &&
      bytes[i + 1] === target[1] &&
      bytes[i + 2] === target[2] &&
      bytes[i + 3] === target[3]
    ) {
      cuts.add(i + 1);
      cuts.add(i + 2);
      cuts.add(i + 3);
      break;
    }
  }
  const zh = bytesOf('中');
  for (let i = 0; i + 3 <= bytes.length; i++) {
    if (bytes[i] === zh[0] && bytes[i + 1] === zh[1] && bytes[i + 2] === zh[2]) {
      cuts.add(i + 1);
      cuts.add(i + 2);
      break;
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b).filter((c) => c < bytes.length);
  const chunks: Uint8Array[] = [];
  let prev = 0;
  for (const cut of sorted) {
    chunks.push(bytes.slice(prev, cut));
    prev = cut;
  }
  if (prev < bytes.length) chunks.push(bytes.slice(prev));
  return chunks;
}

const TOOL_DEFS: ToolDefinition[] = [
  {
    name: 'bash',
    description: 'Run a shell command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  },
];

// ---------------------------------------------------------------------------
// buildRequest — Messages 模态
// ---------------------------------------------------------------------------

describe('buildRequest · messages 模态', () => {
  const base: BuildRequestOptions = { mode: 'messages', model: 'deepseek-chat' };

  test('默认字段：max_tokens=8192、stream=true、thinking off → disabled 且无 output_config', () => {
    const req = buildRequest([{ role: 'user', content: 'hi' }], base);
    expect(req.mode).toBe('messages');
    if (req.mode !== 'messages') return;
    expect(req.body.model).toBe('deepseek-chat');
    expect(req.body.max_tokens).toBe(8192);
    expect(req.body.stream).toBe(true);
    expect(req.body.thinking).toEqual({ type: 'disabled' });
    expect(req.body.output_config).toBeUndefined();
    expect(req.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('system 全部提升为顶层 system 字段（\\n\\n 连接，messages 内无 system）', () => {
    const req = buildRequest(
      [
        { role: 'system', content: '你是调研助手' },
        { role: 'system', content: [{ type: 'text', text: '第二段' }] },
        { role: 'user', content: '问题' },
      ],
      base,
    );
    if (req.mode !== 'messages') return;
    expect(req.body.system).toBe('你是调研助手\n\n第二段');
    expect(req.body.messages).toEqual([{ role: 'user', content: '问题' }]);
  });

  test('assistant 思考回放：thinking + signature 逐字节透传（ReplayEnvelope 语义）', () => {
    const req = buildRequest(
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: '推导 A→B',
              signature: 'sig/Λ+ws==Ω',
            },
            { type: 'text', text: '结论 B' },
          ],
        },
        { role: 'user', content: '继续' },
      ],
      base,
    );
    if (req.mode !== 'messages') return;
    expect(req.body.messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '推导 A→B', signature: 'sig/Λ+ws==Ω' },
        { type: 'text', text: '结论 B' },
      ],
    });
  });

  test('thinking 无 signature 时不产生 signature 键；tool_use/tool_result 块映射', () => {
    const req = buildRequest(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'silent' },
            { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'tu_1', content: 'file.txt', isError: true },
            { type: 'text', text: '看到结果了' },
          ],
        },
      ],
      base,
    );
    if (req.mode !== 'messages') return;
    const assistant = req.body.messages[0];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toEqual([
      { type: 'thinking', thinking: 'silent' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
    ]);
    expect(JSON.stringify(req.body.messages)).not.toContain('signature');
    expect(req.body.messages[1]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt', is_error: true },
      { type: 'text', text: '看到结果了' },
    ]);
  });

  test('tools → {name, description, input_schema}；stop_sequences/temperature/topP 透传', () => {
    const req = buildRequest(
      [{ role: 'user', content: 'x' }],
      { ...base, tools: TOOL_DEFS, stopSequences: ['END', 'STOP'], temperature: 0.3, topP: 0.9 },
    );
    if (req.mode !== 'messages') return;
    expect(req.body.tools).toEqual([
      {
        name: 'bash',
        description: 'Run a shell command',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ]);
    expect(req.body.stop_sequences).toEqual(['END', 'STOP']);
    expect(req.body.temperature).toBe(0.3);
    expect(req.body.top_p).toBe(0.9);
  });

  test('toolChoice 四态 → messages 形态', () => {
    const cases: Array<
      [NonNullable<BuildRequestOptions['toolChoice']>, MessagesWireBody['tool_choice']]
    > = [
      ['auto', { type: 'auto' }],
      ['any', { type: 'any' }],
      ['none', { type: 'none' }],
      [{ name: 'bash' }, { type: 'tool', name: 'bash' }],
    ];
    for (const [choice, expected] of cases) {
      const req = buildRequest([{ role: 'user', content: 'x' }], { ...base, toolChoice: choice });
      if (req.mode !== 'messages') return;
      expect(req.body.tool_choice).toEqual(expected);
    }
  });

  test('thinking 四档：off/low/high/max → thinking.type 与 output_config.effort', () => {
    const expected: Array<
      ['off' | 'low' | 'high' | 'max', MessagesWireBody['thinking'], MessagesWireBody['output_config']]
    > = [
      ['off', { type: 'disabled' }, undefined],
      ['low', { type: 'enabled' }, { effort: 'low' }],
      ['high', { type: 'enabled' }, { effort: 'high' }],
      ['max', { type: 'enabled' }, { effort: 'max' }],
    ];
    for (const [effort, thinking, outputConfig] of expected) {
      const req = buildRequest([{ role: 'user', content: 'x' }], {
        ...base,
        thinking: effort,
      });
      if (req.mode !== 'messages') return;
      expect(req.body.thinking).toEqual(thinking);
      expect(req.body.output_config).toEqual(outputConfig);
    }
  });
});

// ---------------------------------------------------------------------------
// buildRequest — OpenAI 模态
// ---------------------------------------------------------------------------

describe('buildRequest · openai 模态', () => {
  const base: BuildRequestOptions = { mode: 'openai', model: 'deepseek-reasoner' };

  test('默认字段 + thinking off → 扩展 thinking:{type:disabled}，无 reasoning_effort', () => {
    const req = buildRequest([{ role: 'user', content: 'hi' }], base);
    expect(req.mode).toBe('openai');
    if (req.mode !== 'openai') return;
    expect(req.body.max_tokens).toBe(8192);
    expect(req.body.stream).toBe(true);
    expect(req.body.thinking).toEqual({ type: 'disabled' });
    expect(req.body.reasoning_effort).toBeUndefined();
  });

  test('system 原位保留；user 字符串透传', () => {
    const req = buildRequest(
      [
        { role: 'system', content: 'S1' },
        { role: 'system', content: [{ type: 'text', text: 'S2' }] },
        { role: 'user', content: 'U' },
      ],
      base,
    );
    if (req.mode !== 'openai') return;
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'U' },
    ]);
  });

  test('assistant thinking 块 → reasoning_content 聚合（OpenAI 模态无签名字段）', () => {
    const req = buildRequest(
      [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'A', signature: 'SIG' },
            { type: 'thinking', thinking: 'B' },
            { type: 'text', text: '正文' },
          ],
        },
      ],
      base,
    );
    if (req.mode !== 'openai') return;
    expect(req.body.messages).toEqual([
      { role: 'assistant', content: '正文', reasoning_content: 'AB' },
    ]);
    expect(JSON.stringify(req.body)).not.toContain('SIG');
  });

  test('tool_use → tool_calls（对象 canonical JSON、字符串原样不双重编码）', () => {
    const req = buildRequest(
      [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls -la' } },
            { type: 'tool_use', id: 'call_2', name: 'raw', input: '{"already":"json"}' },
          ],
        },
      ],
      base,
    );
    if (req.mode !== 'openai') return;
    expect(req.body.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls -la"}' },
        },
        {
          id: 'call_2',
          type: 'function',
          function: { name: 'raw', arguments: '{"already":"json"}' },
        },
      ],
    });
  });

  test('user 混合块：text+tool_result 保序 → user/tool 消息交错；多文本块合并', () => {
    const req = buildRequest(
      [
        {
          role: 'user',
          content: [
            { type: 'text', text: '先看' },
            { type: 'tool_result', toolUseId: 'call_1', content: 'result-1' },
            { type: 'text', text: '再看' },
            { type: 'text', text: '两段' },
            { type: 'tool_result', toolUseId: 'call_2', content: 'result-2' },
          ],
        },
      ],
      base,
    );
    if (req.mode !== 'openai') return;
    expect(req.body.messages).toEqual([
      { role: 'user', content: '先看' },
      { role: 'tool', tool_call_id: 'call_1', content: 'result-1' },
      { role: 'user', content: [{ type: 'text', text: '再看' }, { type: 'text', text: '两段' }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'result-2' },
    ]);
  });

  test('tools → {type:function, function:{parameters}}；stop → stop；temperature/topP 透传', () => {
    const req = buildRequest(
      [{ role: 'user', content: 'x' }],
      { ...base, tools: TOOL_DEFS, stopSequences: ['\nEND'], temperature: 0.7, topP: 0.95 },
    );
    if (req.mode !== 'openai') return;
    expect(req.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ]);
    expect(req.body.stop).toEqual(['\nEND']);
    expect(req.body.temperature).toBe(0.7);
    expect(req.body.top_p).toBe(0.95);
  });

  test('toolChoice：auto/any→required/none/命名函数 四态映射', () => {
    const cases: Array<
      [NonNullable<BuildRequestOptions['toolChoice']>, OpenAIWireBody['tool_choice']]
    > = [
      ['auto', 'auto'],
      ['any', 'required'],
      ['none', 'none'],
      [{ name: 'bash' }, { type: 'function', function: { name: 'bash' } }],
    ];
    for (const [choice, expected] of cases) {
      const req = buildRequest([{ role: 'user', content: 'x' }], { ...base, toolChoice: choice });
      if (req.mode !== 'openai') return;
      expect(req.body.tool_choice).toEqual(expected);
    }
  });

  test('thinking 四档：low/high/max → reasoning_effort 透传', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      const req = buildRequest([{ role: 'user', content: 'x' }], {
        ...base,
        thinking: effort,
      });
      if (req.mode !== 'openai') return;
      expect(req.body.reasoning_effort).toBe(effort);
      expect(req.body.thinking).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// SSEParser 单元
// ---------------------------------------------------------------------------

describe('SSEParser', () => {
  test('data/event/注释行/多 data 行连接/CRLF 完整语义', () => {
    const p = new SSEParser();
    const events = p
      .feed(
        [
          ': keep-alive 注释',
          'event: ping',
          'data: first',
          'data: second',
          '',
          'data: {"a":1}',
          '',
        ].join('\r\n'),
      )
      .concat(p.flush());
    // 非 JSON 多行 data：SSE 规范按 \n 连接，非 [DONE]/JSON 载荷 → invalid（上层按 protocol 分类）。
    expect(events).toEqual([
      { kind: 'invalid', payload: 'first\nsecond' },
      { kind: 'data', name: '', value: { a: 1 } },
    ]);
    expect(p.stats.jsonParses).toBe(1);
    expect(p.stats.sseEvents).toBe(2);
  });

  test('任意切割点：1..64 步长全切分结果一致（跨 chunk 拼接）', () => {
    const payload =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Hello 世界 🎯"}}\n\n' +
      ': ping\n' +
      'data: [DONE]\n\n';
    const expected = new SSEParser().feed(payload);
    expect(expected.length).toBe(2);
    for (let step = 1; step <= 64; step++) {
      const p = new SSEParser();
      let got: ReturnType<SSEParser['feed']> = [];
      for (let i = 0; i < payload.length; i += step) {
        got = got.concat(p.feed(payload.slice(i, i + step)));
      }
      got = got.concat(p.flush());
      expect(got).toEqual(expected);
    }
  });

  test('flush 收尾：无换行残余行与未分发事件', () => {
    const p = new SSEParser();
    const a = p.feed('data: {"x":1}');
    expect(a).toEqual([]);
    const b = p.flush();
    expect(b).toEqual([{ kind: 'data', name: '', value: { x: 1 } }]);
    expect(p.stats.jsonParses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stream() — Messages 模态端到端
// ---------------------------------------------------------------------------

const MESSAGES_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":64,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我想想"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"，先查表"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-Λws/N=="}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"是 42 🎯"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":2}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":321}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
].join('\n');

const MESSAGES_EXPECTED: StreamEvent[] = [
  { type: 'usage', usage: { inputTokens: 120, cachedInputTokens: 64 } },
  { type: 'thinking_delta', delta: '让我想想' },
  { type: 'thinking_delta', delta: '，先查表' },
  { type: 'signature_delta', delta: 'sig-Λws/N==' },
  { type: 'content_delta', delta: '答案' },
  { type: 'content_delta', delta: '是 42 🎯' },
  { type: 'tool_call_delta', index: 2, id: 'toolu_1', name: 'bash', argumentsDelta: '' },
  { type: 'tool_call_delta', index: 2, argumentsDelta: '{"command":' },
  { type: 'tool_call_delta', index: 2, argumentsDelta: '"ls"}' },
  { type: 'usage', usage: { outputTokens: 321 } },
  { type: 'done', stopReason: 'tool_use' },
];

describe('stream · messages 模态', () => {
  test('全事件流：usage/thinking/signature/content/tool_call/done 顺序与载荷精确匹配', async () => {
    const { fetchImpl, calls } = makeFetch(() => sseResponse([bytesOf(MESSAGES_SSE)]));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'sk-bi' });
    const request: WireRequest = buildRequest([{ role: 'user', content: 'hi' }], {
      mode: 'messages',
      model: 'deepseek-chat',
    });
    const events = await collect(adapter.stream(request));
    expect(JSON.parse(JSON.stringify(events))).toEqual(MESSAGES_EXPECTED);

    // 请求 URL / 头 / 体 断言
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://mock.test/anthropic/v1/messages');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('x-api-key')).toBe('sk-bi');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    const sentBody = JSON.parse(String(calls[0]?.init?.body)) as typeof request.body;
    expect(sentBody).toEqual(request.body);
  });

  test('任意字节切割（含多字节 UTF-8 中断）：事件流与整块喂入完全一致', async () => {
    const whole = bytesOf(MESSAGES_SSE);
    const chunks = splitBytesDeterministic(whole, 0xb1042, 220);
    expect(chunks.length).toBeGreaterThan(100); // 切得足够碎
    const { fetchImpl } = makeFetch(() => sseResponse(chunks));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const events = await collect(
      adapter.stream(buildRequest([{ role: 'user', content: 'hi' }], { mode: 'messages', model: 'm' })),
    );
    expect(JSON.parse(JSON.stringify(events))).toEqual(MESSAGES_EXPECTED);
  });

  test('逐字节喂入（极端切割）：仍产出全事件流', async () => {
    const whole = bytesOf('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"AB"}}\n\ndata: {"type":"message_stop"}\n\ndata: [DONE]\n\n');
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < whole.length; i++) chunks.push(whole.slice(i, i + 1));
    const { fetchImpl } = makeFetch(() => sseResponse(chunks));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const events = await collect(
      adapter.stream(buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' })),
    );
    expect(events.map((e) => e.type)).toEqual(['content_delta', 'done']);
    expect(events[0]).toEqual({ type: 'content_delta', delta: 'AB' });
    expect(events[1]).toEqual({ type: 'done', stopReason: 'stop' });
  });

  test('注释行与 ping 事件被忽略；漏发 message_stop 时优雅补 done', async () => {
    const sse =
      ': keep-alive\n\nevent: ping\ndata: {"type":"ping"}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n';
    const { fetchImpl } = makeFetch(() => sseResponse([bytesOf(sse)]));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const events = await collect(
      adapter.stream(buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' })),
    );
    expect(events).toEqual([
      { type: 'content_delta', delta: 'hi' },
      { type: 'done', stopReason: 'stop' },
    ]);
  });

  test('EMPTY_RESPONSE 终态防御：零内容 + finish=stop → protocol 错误而非假 done', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    const { fetchImpl } = makeFetch(() => sseResponse([bytesOf(sse)]));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const events = await collect(
      adapter.stream(buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' })),
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('usage');
    expect(events[1]?.type).toBe('error');
    if (events[1]?.type !== 'error') return;
    expect(events[1].error.code).toBe('protocol');
    expect(events[1].error.message).toContain('EMPTY_RESPONSE');
  });

  test('流内 error 事件：authentication_error → auth、rate_limit_error → rate_limited', async () => {
    for (const [wireType, expected] of [
      ['authentication_error', 'auth'],
      ['rate_limit_error', 'rate_limited'],
    ] as const) {
      const sse = `data: {"type":"error","error":{"type":"${wireType}","message":"boom"}}\n\n`;
      const { fetchImpl } = makeFetch(() => sseResponse([bytesOf(sse)]));
      const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
      const events = await collect(
        adapter.stream(
          buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' }),
        ),
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'error',
        error: expect.objectContaining({ code: expected, message: 'boom' }),
      });
    }
  });

  test('畸形 SSE JSON → protocol 错误并终止流（后续事件不再产出）', async () => {
    const sse =
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\ndata: {broken json\n\ndata: {"type":"message_stop"}\n\n';
    const { fetchImpl } = makeFetch(() => sseResponse([bytesOf(sse)]));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const events = await collect(
      adapter.stream(buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' })),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'content_delta', delta: 'ok' });
    expect(events[1]?.type).toBe('error');
    if (events[1]?.type !== 'error') return;
    expect(events[1].error.code).toBe('protocol');
    expect(events[1].error.message).toContain('malformed SSE JSON payload');
  });
});

// ---------------------------------------------------------------------------
// stream() — OpenAI 模态端到端
// ---------------------------------------------------------------------------

const OPENAI_SSE = [
  'data: {"id":"c1","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考中"}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"你好"}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":"{\\"pa"}}]}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/a\\"}"}}]}}]}',
  '',
  'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":50,"completion_tokens":21,"prompt_tokens_details":{"cached_tokens":8},"completion_tokens_details":{"reasoning_tokens":13}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('stream · openai 模态', () => {
  test('reasoning_content/content/tool_calls/usage/[DONE] 全链路', async () => {
    const { fetchImpl, calls } = makeFetch(() => sseResponse([bytesOf(OPENAI_SSE)]));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'sk-o' });
    const request: WireRequest = buildRequest([{ role: 'user', content: 'hi' }], {
      mode: 'openai',
      model: 'deepseek-reasoner',
      thinking: 'high',
    });
    const events = await collect(adapter.stream(request));
    expect(JSON.parse(JSON.stringify(events))).toEqual([
      { type: 'thinking_delta', delta: '思考中' },
      { type: 'content_delta', delta: '你好' },
      { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"pa' },
      { type: 'tool_call_delta', index: 0, argumentsDelta: 'th":"/a"}' },
      {
        type: 'usage',
        usage: {
          inputTokens: 50,
          outputTokens: 21,
          cachedInputTokens: 8,
          reasoningTokens: 13,
        },
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);
    expect(calls[0]?.url).toBe('https://mock.test/chat/completions');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-o');
    expect(headers.get('x-api-key')).toBeNull();
    const sentBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(sentBody.reasoning_effort).toBe('high');
  });

  test('OpenAI 空 finish=stop（无任何内容）→ EMPTY_RESPONSE protocol 错误', async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const { fetchImpl } = makeFetch(() => sseResponse([bytesOf(sse)]));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const events = await collect(
      adapter.stream(
        buildRequest([{ role: 'user', content: 'x' }], { mode: 'openai', model: 'm' }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type !== 'error') return;
    expect(events[0].error.code).toBe('protocol');
    expect(events[0].error.message).toContain('EMPTY_RESPONSE');
  });

  test('OpenAI 流内 error 载荷 → server 分类（server_error）', async () => {
    const sse = 'data: {"error":{"type":"server_error","message":"kaboom"}}\n\n';
    const { fetchImpl } = makeFetch(() => sseResponse([bytesOf(sse)]));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const events = await collect(
      adapter.stream(
        buildRequest([{ role: 'user', content: 'x' }], { mode: 'openai', model: 'm' }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'error',
      error: expect.objectContaining({ code: 'server', message: 'kaboom' }),
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP 错误五分类
// ---------------------------------------------------------------------------

describe('stream · HTTP 错误五分类', () => {
  const run = async (
    status: number,
    body: string,
    headers?: Record<string, string>,
  ): Promise<StreamEvent[]> => {
    const { fetchImpl } = makeFetch(() => errorResponse(status, body, headers));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    return collect(
      adapter.stream(
        buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' }),
      ),
    );
  };

  test('401/403 → auth（message 从 JSON error 提取）', async () => {
    const e1 = await run(401, '{"error":{"type":"authentication_error","message":"bad key"}}');
    expect(e1[0]).toEqual({
      type: 'error',
      error: { code: 'auth', status: 401, message: 'bad key', raw: expect.any(String) },
    });
    const e2 = await run(403, '{"error":{"message":"forbidden"}}');
    expect(e2[0]).toEqual({
      type: 'error',
      error: { code: 'auth', status: 403, message: 'forbidden', raw: expect.any(String) },
    });
  });

  test('429 → rate_limited：retry-after: 7 → 7000ms；retry-after-ms: 250 优先 → 250ms', async () => {
    const e1 = await run(429, '{"error":{"message":"slow down"}}', { 'retry-after': '7' });
    expect(e1[0]?.type).toBe('error');
    if (e1[0]?.type !== 'error') return;
    expect(e1[0].error.code).toBe('rate_limited');
    expect(e1[0].error.retryAfterMs).toBe(7000);
    expect(e1[0].error.status).toBe(429);

    const e2 = await run(429, '{}', { 'retry-after-ms': '250', 'retry-after': '9' });
    if (e2[0]?.type !== 'error') return;
    expect(e2[0].error.retryAfterMs).toBe(250);
  });

  test('500 → server；408 → network；fetch 抛出 → network', async () => {
    const e1 = await run(500, '{"error":{"message":"internal"}}');
    if (e1[0]?.type !== 'error') return;
    expect(e1[0].error.code).toBe('server');
    expect(e1[0].error.status).toBe(500);

    const e2 = await run(408, 'timeout');
    if (e2[0]?.type !== 'error') return;
    expect(e2[0].error.code).toBe('network');

    const { fetchImpl } = makeFetch(() => {
      throw new TypeError('connect ECONNREFUSED');
    });
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const e3 = await collect(
      adapter.stream(
        buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' }),
      ),
    );
    expect(e3).toHaveLength(1);
    expect(e3[0]?.type).toBe('error');
    if (e3[0]?.type !== 'error') return;
    expect(e3[0].error.code).toBe('network');
  });

  test('400 CONTEXT_WINDOW_EXCEEDED → protocol 且标记保留', async () => {
    const e = await run(
      400,
      '{"error":{"message":"This model\'s maximum context length is 131072 tokens","code":"CONTEXT_WINDOW_EXCEEDED"}}',
    );
    expect(e[0]?.type).toBe('error');
    if (e[0]?.type !== 'error') return;
    expect(e[0].error.code).toBe('protocol');
    expect(e[0].error.status).toBe(400);
    expect(e[0].error.message).toContain('CONTEXT_WINDOW_EXCEEDED');
    expect(e[0].error.message).toContain('131072');
  });

  test('422 → protocol（非五类特判的 4xx 归协议错误）', async () => {
    const e = await run(422, '{"error":{"message":"unprocessable"}}');
    if (e[0]?.type !== 'error') return;
    expect(e[0].error.code).toBe('protocol');
  });
});

// ---------------------------------------------------------------------------
// O(N) 证明与粗测
// ---------------------------------------------------------------------------

describe('O(N) 流式解析', () => {
  /** 生成 eventCount 个 content_delta 事件的 SSE（约 eventCount × 150 字节）。 */
  function bigSSE(eventCount: number): string {
    const parts: string[] = [];
    for (let i = 0; i < eventCount; i++) {
      const text = `chunk-${i}-${'x'.repeat(96)}`;
      parts.push(
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${text}"}}\n\n`,
      );
    }
    return parts.join('');
  }

  test('确定性证明：jsonParses 恒等于事件数，与 chunk 切割方式无关', () => {
    const payload = bigSSE(2000);
    for (const step of [1, 37, 997, payload.length]) {
      const p = new SSEParser();
      let events = 0;
      for (let i = 0; i < payload.length; i += step) {
        events += p.feed(payload.slice(i, i + step)).length;
      }
      events += p.flush().length;
      expect(events).toBe(2000);
      expect(p.stats.jsonParses).toBe(2000); // 每 data 载荷恰好 parse 一次
      expect(p.stats.bytesFed).toBe(payload.length);
    }
  });

  test('时间粗测：300KB × 3000 chunks 端到端 < 3s（O(N²) 重放在此规模需数十秒）', async () => {
    const payload = bigSSE(3000); // ~300KB
    const step = Math.floor(payload.length / 3000);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < payload.length; i += step) {
      chunks.push(bytesOf(payload.slice(i, i + step)));
    }
    const { fetchImpl } = makeFetch(() => sseResponse(chunks));
    const adapter = DeepSeekAdapter({ fetchImpl, baseUrl: 'https://mock.test', apiKey: 'k' });
    const started = performance.now();
    let count = 0;
    for await (const ev of adapter.stream(
      buildRequest([{ role: 'user', content: 'x' }], { mode: 'messages', model: 'm' }),
    )) {
      if (ev.type === 'content_delta') count++;
    }
    const elapsed = performance.now() - started;
    expect(count).toBe(3000);
    expect(elapsed).toBeLessThan(3000);
  });
});
