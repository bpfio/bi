/**
 * BI-04.2 — DeepSeek 官方原生适配器（双模态 Wire 协议 + 手写 O(N) SSE 流解析）。
 *
 * # 设计总纲
 *
 * ## 1. 双模态 Wire 协议
 *
 * DeepSeek 官方服务端同时暴露两种 Wire 形态：
 *
 * - **Anthropic Messages 规范子集**（`mode: 'messages'`）：原生区分
 *   `text / thinking / tool_use / tool_result` 四种 WireBlock，支持 `thinking`
 *   块与 `signature` 密签回放（`POST {baseUrl}/anthropic/v1/messages`）。
 * - **OpenAI Chat Completions 兼容**（`mode: 'openai'`）：思考流以
 *   `reasoning_content` 字段承载（`POST {baseUrl}/chat/completions`）。
 *
 * ### 1.1 字段映射表（bi 语义 → 两种 Wire 形态）
 *
 * | bi 语义            | Messages 模态                                          | OpenAI 模态                                       |
 * |--------------------|--------------------------------------------------------|---------------------------------------------------|
 * | system 提示        | 顶层 `system` 字段（多条以 `\n\n` 连接提升）           | `{role:'system'}` 消息原位保留                    |
 * | 纯文本块           | `{type:'text', text}`                                  | `content` 字符串（多块合并）或 `{type:'text'}` 数组 |
 * | 思考块             | `{type:'thinking', thinking, signature?}`              | `reasoning_content`（仅文本，签名不可回放*）      |
 * | 工具调用           | `{type:'tool_use', id, name, input}`                   | `tool_calls[]:{id, function:{name, arguments}}`   |
 * | 工具结果           | user 消息内 `{type:'tool_result', tool_use_id, content}` | `{role:'tool', tool_call_id, content}`          |
 * | 工具定义           | `{name, description, input_schema}`                    | `{type:'function', function:{name, description, parameters}}` |
 * | maxTokens         | `max_tokens`（缺省 8192）                              | `max_tokens`（缺省 8192）                         |
 * | stopSequences     | `stop_sequences`                                       | `stop`                                            |
 * | toolChoice auto   | `{type:'auto'}`                                        | `'auto'`                                          |
 * | toolChoice any    | `{type:'any'}`                                         | `'required'`                                      |
 * | toolChoice none   | `{type:'none'}`                                        | `'none'`                                          |
 * | toolChoice {name} | `{type:'tool', name}`                                  | `{type:'function', function:{name}}`              |
 *
 * \* OpenAI 兼容形态没有签名字段：signature 仅 Messages 模态可无损回放（模态限制，
 * 官方行为即如此）。思考流签名透传见 reasoning-stream.ts。
 *
 * ### 1.2 thinking 四档映射表
 *
 * | effort | Messages 模态                                                | OpenAI 模态                          |
 * |--------|--------------------------------------------------------------|--------------------------------------|
 * | off    | `thinking:{type:'disabled'}`                                 | `thinking:{type:'disabled'}`（扩展字段透传） |
 * | low    | `thinking:{type:'enabled'}` + `output_config:{effort:'low'}` | `reasoning_effort:'low'`             |
 * | high   | `thinking:{type:'enabled'}` + `output_config:{effort:'high'}`| `reasoning_effort:'high'`            |
 * | max    | `thinking:{type:'enabled'}` + `output_config:{effort:'max'}` | `reasoning_effort:'max'`（扩展档位透传） |
 *
 * ## 2. 流式解析 O(N) 保证（官方 Harness CPU 补丁的等价实现）
 *
 * - SSE 手写解析器（`SSEParser`）维护**增量 buffer**：每个 chunk 到达后仅从上次
 *   扫描游标向前查找 `\n`，已消费字节立刻从 buffer 头部裁掉——任何字节只被扫过
 *   一次，整体 O(N)，**禁止每 chunk 对全量 buffer 重放解析**（O(N²) 暴击）。
 * - 每个 SSE 事件的 data 载荷 **JSON.parse 恰好一次**；`stats.jsonParses` 与
 *   chunk 切割方式无关、恒等于事件数，可作为 O(N) 的确定性证明（见测试）。
 * - 工具调用参数增量（`input_json_delta.partial_json` / `function.arguments`）
 *   仅做字符串拼接，**绝不**对流式半截 JSON 做 parseStreamingJson——反序列化
 *   推迟到 `tool_call_delta` 全量聚合后由消费端一次完成（消除官方补丁所指
 *   每 token 重复 parse 的 O(N²) CPU 累积）。
 * - 多字节 UTF-8：网络字节流先经 `TextDecoder(streaming)` 增量解码，
 *   跨 chunk 断裂的多字节序列由解码器内部状态无缝拼接。
 *
 * ## 3. 事件与错误
 *
 * 流事件七类：`content_delta / thinking_delta / signature_delta / tool_call_delta /
 * usage / done / error`。前六类为本卡合约必选；`signature_delta` 为官方 Messages
 * wire 原生事件（`content_block_delta.delta.type = 'signature_delta'`），因
 * reasoning-stream 契约要求签名无损透传而显式建模。
 *
 * 错误结构化五分类 `{ code: 'auth'|'rate_limited'|'server'|'protocol'|'network', status?, retryAfterMs? }`：
 *
 * | code         | 触发                                                         |
 * |--------------|--------------------------------------------------------------|
 * | auth         | HTTP 401/403；流内 `authentication_error`                    |
 * | rate_limited | HTTP 429（Retry-After/Retry-After-ms → retryAfterMs）；流内 `rate_limit_error` |
 * | server       | HTTP 5xx；流内 `overloaded_error`/`api_error`                |
 * | network      | fetch 抛出 / 中途读流失败 / HTTP 408                         |
 * | protocol     | 其余 4xx（含 CONTEXT_WINDOW_EXCEEDED）、畸形 SSE/JSON、流内 `invalid_request_error` |
 *
 * ## 4. 终态防御（官方 Harness 语义）
 *
 * - **EMPTY_RESPONSE**：流正常收尾但零 content/thinking/tool_call 且 finish 为
 *   `stop`/空 → 不发假 done，改发 `protocol` 错误（可重试），杜绝静默假成功。
 * - **签名无损回放**：Messages 模态 assistant 历史回放时把 `signature` 原样带回
 *   （buildRequest 对 ThinkingBlock 的透传），保证服务端校验与前缀缓存命中。
 */

// ---------------------------------------------------------------------------
// 语义层输入类型（provider 中立）
// ---------------------------------------------------------------------------

/** 推理强度四档。 */
export type ThinkingEffort = 'off' | 'low' | 'high' | 'max';

export interface TextBlock {
  type: 'text';
  text: string;
}

/** 思考块；`signature` 为 DeepSeek 密签，回放时必须原样透传。 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type ToolChoice = 'auto' | 'any' | 'none' | { name: string };

// ---------------------------------------------------------------------------
// StreamEvent（适配器输出）
// ---------------------------------------------------------------------------

export type StopReason = 'stop' | 'length' | 'tool_use' | 'error' | null;

export interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

/**
 * 流事件七类。`signature_delta` 为官方 Messages wire 原生事件，签名无损透传专用。
 */
export type StreamEvent =
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'signature_delta'; delta: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta: string;
    }
  | { type: 'usage'; usage: StreamUsage }
  | { type: 'done'; stopReason: StopReason }
  | { type: 'error'; error: AdapterError };

/** 结构化错误五分类。 */
export type AdapterErrorCode = 'auth' | 'rate_limited' | 'server' | 'protocol' | 'network';

export interface AdapterError {
  code: AdapterErrorCode;
  status?: number;
  retryAfterMs?: number;
  message: string;
  /** 原始错误载荷截断（≤2000 字符），用于诊断。 */
  raw?: string;
}

// ---------------------------------------------------------------------------
// Wire 请求类型（双模态）
// ---------------------------------------------------------------------------

export type WireMode = 'messages' | 'openai';

export type MessagesWireBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface MessagesWireMessage {
  role: 'user' | 'assistant';
  content: string | MessagesWireBlock[];
}

export interface MessagesToolDef {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface MessagesWireBody {
  model: string;
  max_tokens: number;
  stream: boolean;
  messages: MessagesWireMessage[];
  thinking: { type: 'enabled' | 'disabled' };
  output_config?: { effort: 'low' | 'high' | 'max' };
  system?: string;
  tools?: MessagesToolDef[];
  tool_choice?: Record<string, unknown>;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type OpenAIWireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string }> }
  | {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAIToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface OpenAIWireBody {
  model: string;
  max_tokens: number;
  stream: boolean;
  messages: OpenAIWireMessage[];
  tools?: OpenAIToolDef[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  top_p?: number;
  stop?: string[];
  thinking?: { type: 'disabled' };
  reasoning_effort?: 'low' | 'high' | 'max';
}

export type WireRequest =
  | { mode: 'messages'; body: MessagesWireBody }
  | { mode: 'openai'; body: OpenAIWireBody };

export interface BuildRequestOptions {
  /** Wire 形态，缺省 `'messages'`（DeepSeek Messages 官方原生形态）。 */
  mode?: WireMode;
  model: string;
  thinking?: ThinkingEffort;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  /** 缺省 true。 */
  stream?: boolean;
}

// ---------------------------------------------------------------------------
// buildRequest — 纯函数，双模态字段映射
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 8192;

function textBlocksFrom(content: string | ContentBlock[]): TextBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const out: TextBlock[] = [];
  for (const block of content) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text });
  }
  return out;
}

function toMessagesBlock(block: ContentBlock): MessagesWireBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking': {
      // signature 原样透传：官方 ReplayEnvelope 要求签名逐字节保真。
      return block.signature === undefined
        ? { type: 'thinking', thinking: block.thinking }
        : { type: 'thinking', thinking: block.thinking, signature: block.signature };
    }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return block.isError === undefined
        ? { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content }
        : {
            type: 'tool_result',
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError,
          };
  }
}

function messagesToolChoice(tc: ToolChoice): Record<string, unknown> {
  if (tc === 'auto' || tc === 'any' || tc === 'none') return { type: tc };
  return { type: 'tool', name: tc.name };
}

function openAIToolChoice(tc: ToolChoice): NonNullable<OpenAIWireBody['tool_choice']> {
  if (tc === 'auto' || tc === 'none') return tc;
  if (tc === 'any') return 'required';
  return { type: 'function', function: { name: tc.name } };
}

/**
 * 双模态请求构建。语义消息 + 选项 → 对应 Wire 形态请求体（映射表见文件头）。
 */
export function buildRequest(messages: AgentMessage[], opts: BuildRequestOptions): WireRequest {
  const mode: WireMode = opts.mode ?? 'messages';
  const effort: ThinkingEffort = opts.thinking ?? 'off';

  if (mode === 'messages') {
    // system 全部提升到顶层字段（\n\n 连接），保住前缀缓存第 0 位稳定。
    const systemParts: string[] = [];
    const convo: MessagesWireMessage[] = [];
    for (const msg of messages) {
      if (msg.role === 'system') {
        for (const b of textBlocksFrom(msg.content)) systemParts.push(b.text);
        continue;
      }
      if (msg.role === 'user') {
        const content =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content.map(toMessagesBlock);
        convo.push({ role: 'user', content });
        continue;
      }
      // assistant
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map(toMessagesBlock);
      convo.push({ role: 'assistant', content });
    }

    const body: MessagesWireBody = {
      model: opts.model,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: opts.stream ?? true,
      messages: convo,
      thinking: effort === 'off' ? { type: 'disabled' } : { type: 'enabled' },
    };
    if (effort !== 'off') body.output_config = { effort };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        input_schema: t.inputSchema,
      }));
    }
    if (opts.toolChoice) body.tool_choice = messagesToolChoice(opts.toolChoice);
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.topP !== undefined) body.top_p = opts.topP;
    if (opts.stopSequences && opts.stopSequences.length > 0) {
      body.stop_sequences = [...opts.stopSequences];
    }
    return { mode: 'messages', body };
  }

  // ---- OpenAI Chat Completions 模态 ----
  const out: OpenAIWireMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      // OpenAI 模态 system 原位保留（不合并，保序）。
      for (const b of textBlocksFrom(msg.content)) {
        out.push({ role: 'system', content: b.text });
      }
      continue;
    }
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
        continue;
      }
      const texts: Array<{ type: 'text'; text: string }> = [];
      const flushTexts = (): void => {
        if (texts.length === 1) out.push({ role: 'user', content: texts[0]!.text });
        else if (texts.length > 1) out.push({ role: 'user', content: [...texts] });
        texts.length = 0;
      };
      for (const block of msg.content) {
        if (block.type === 'text') {
          texts.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_result') {
          flushTexts();
          out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
        }
        // user 消息中的 thinking/tool_use 块非法，静默跳过（防御）。
      }
      flushTexts();
      continue;
    }
    // assistant：文本 + reasoning_content + tool_calls
    let text = '';
    const thinkingParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'thinking') thinkingParts.push(block.thinking);
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              // 对象序列化为 canonical JSON；字符串入参原样使用（防双重编码）。
              arguments:
                typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
            },
          });
        }
      }
    }
    const hasText = text.length > 0;
    const assistant: OpenAIWireMessage = {
      role: 'assistant',
      content: hasText ? text : null,
    };
    if (thinkingParts.length > 0) assistant.reasoning_content = thinkingParts.join('');
    if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
    out.push(assistant);
  }

  const body: OpenAIWireBody = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: opts.stream ?? true,
    messages: out,
  };
  // thinking 四档 → OpenAI 形态：off 用扩展 thinking 开关；low/high/max 透传档位。
  if (effort === 'off') body.thinking = { type: 'disabled' };
  else body.reasoning_effort = effort;
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description === undefined ? {} : { description: t.description }),
        parameters: t.inputSchema,
      },
    }));
  }
  if (opts.toolChoice) body.tool_choice = openAIToolChoice(opts.toolChoice);
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.topP !== undefined) body.top_p = opts.topP;
  if (opts.stopSequences && opts.stopSequences.length > 0) body.stop = [...opts.stopSequences];
  return { mode: 'openai', body };
}

// ---------------------------------------------------------------------------
// SSEParser — 手写增量解析器（O(N)，无外部依赖）
// ---------------------------------------------------------------------------

export interface SSEStats {
  bytesFed: number;
  linesSeen: number;
  sseEvents: number;
  jsonParses: number;
}

/** 解析器输出的 wire 级事件（尚未映射为 StreamEvent）。 */
export type SSEWireEvent =
  | { kind: 'data'; name: string; value: unknown }
  | { kind: 'invalid'; payload: string }
  | { kind: 'done-sentinel' };

/**
 * 增量 SSE 解析器：
 * - `feed` 追加 chunk 后仅从游标向前扫描完整行，消费后立刻裁剪 buffer；
 *   每字节只扫一次 ⇒ O(N)。
 * - `data:` 多行按 SSE 规范以 `\n` 连接；`event:` 记录事件名；`:` 注释行忽略；
 *   `retry:` 及未知字段忽略；空行触发事件分发。
 * - `data: [DONE]` → done-sentinel；其余 data 载荷 JSON.parse 恰好一次。
 * - `flush` 处理无结尾换行的残余行与未分发的事件（容错收尾）。
 */
export class SSEParser {
  private buf = '';
  private scan = 0;
  private dataLines: string[] | null = null;
  private eventName = '';
  readonly stats: SSEStats = { bytesFed: 0, linesSeen: 0, sseEvents: 0, jsonParses: 0 };

  feed(chunk: string): SSEWireEvent[] {
    this.stats.bytesFed += chunk.length;
    this.buf += chunk;
    const out: SSEWireEvent[] = [];
    let start = this.scan;
    for (;;) {
      const nl = this.buf.indexOf('\n', start);
      if (nl === -1) break;
      const end = nl > start && this.buf.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      const line = this.buf.slice(start, end);
      start = nl + 1;
      this.stats.linesSeen++;
      this.handleLine(line, out);
    }
    if (start > 0) {
      this.buf = this.buf.slice(start);
      this.scan = 0;
    }
    return out;
  }

  /** 流终止时调用：处理无换行结尾的残余行 + 未被空行分发的事件。 */
  flush(): SSEWireEvent[] {
    const out: SSEWireEvent[] = [];
    if (this.scan < this.buf.length) {
      let line = this.buf.slice(this.scan);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.stats.linesSeen++;
      this.handleLine(line, out);
    }
    this.buf = '';
    this.scan = 0;
    if (this.dataLines !== null && this.dataLines.length > 0) {
      this.dispatch(out);
    }
    return out;
  }

  private handleLine(line: string, out: SSEWireEvent[]): void {
    if (line.length === 0) {
      this.dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58 /* ':' */) return; // 注释行
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      (this.dataLines ??= []).push(value);
    } else if (field === 'event') {
      this.eventName = value;
    }
    // 'retry' 与未知字段按 SSE 规范忽略。
  }

  private dispatch(out: SSEWireEvent[]): void {
    const dataLines = this.dataLines;
    this.dataLines = null;
    const name = this.eventName;
    this.eventName = '';
    if (dataLines === null || dataLines.length === 0) return;
    const data = dataLines.join('\n');
    this.stats.sseEvents++;
    if (data === '[DONE]') {
      out.push({ kind: 'done-sentinel' });
      return;
    }
    try {
      const value: unknown = JSON.parse(data);
      this.stats.jsonParses++;
      out.push({ kind: 'data', name, value });
    } catch {
      out.push({ kind: 'invalid', payload: data });
    }
  }
}

// ---------------------------------------------------------------------------
// wire 事件 → StreamEvent 映射
// ---------------------------------------------------------------------------

interface StreamFoldState {
  sawContent: boolean;
  sawThinking: boolean;
  sawToolCall: boolean;
  stopReason: StopReason;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function truncate(s: string, max = 2000): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function mapMessagesStopReason(raw: string): StopReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    default:
      return null;
  }
}

function mapOpenAIStopReason(raw: string): StopReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function':
      return 'tool_use';
    case 'content_filter':
      return 'error';
    default:
      return null;
  }
}

function classifyErrorKind(raw: string): AdapterErrorCode {
  if (/auth/i.test(raw)) return 'auth';
  if (/rate_limit/i.test(raw)) return 'rate_limited';
  if (/overloaded|api_error|server_error/i.test(raw)) return 'server';
  return 'protocol';
}

/**
 * EMPTY_RESPONSE 终态防御：零内容 + finish=stop/空 → protocol 错误（可重试），
 * 不发假 done；否则发 done。
 */
function makeDone(state: StreamFoldState): StreamEvent {
  const empty =
    !state.sawContent && !state.sawThinking && !state.sawToolCall;
  if (empty && (state.stopReason === 'stop' || state.stopReason === null)) {
    return {
      type: 'error',
      error: {
        code: 'protocol',
        message: 'EMPTY_RESPONSE: stream completed with no content and finish=stop',
      },
    };
  }
  return { type: 'done', stopReason: state.stopReason ?? 'stop' };
}

function interpretMessagesData(
  value: unknown,
  fallbackName: string,
  state: StreamFoldState,
): StreamEvent[] {
  const rec = asRecord(value);
  if (rec === null) {
    return [
      { type: 'error', error: { code: 'protocol', message: 'SSE data is not an object' } },
    ];
  }
  const type = asString(rec.type) ?? fallbackName;
  switch (type) {
    case 'message_start': {
      const message = asRecord(rec.message);
      const usage = message === null ? null : asRecord(message.usage);
      if (usage === null) return [];
      const u: StreamUsage = {};
      const input = asNumber(usage.input_tokens);
      if (input !== null) u.inputTokens = input;
      const cached = asNumber(usage.cache_read_input_tokens);
      if (cached !== null) u.cachedInputTokens = cached;
      return Object.keys(u).length > 0 ? [{ type: 'usage', usage: u }] : [];
    }
    case 'content_block_start': {
      const block = asRecord(rec.content_block);
      if (block === null || block.type !== 'tool_use') return [];
      state.sawToolCall = true;
      const id = asString(block.id) ?? undefined;
      const name = asString(block.name) ?? undefined;
      return [
        {
          type: 'tool_call_delta',
          index: asNumber(rec.index) ?? 0,
          ...(id === undefined ? {} : { id }),
          ...(name === undefined ? {} : { name }),
          argumentsDelta: '',
        },
      ];
    }
    case 'content_block_delta': {
      const delta = asRecord(rec.delta);
      if (delta === null) return [];
      const index = asNumber(rec.index) ?? 0;
      switch (delta.type) {
        case 'text_delta': {
          state.sawContent = true;
          return [{ type: 'content_delta', delta: asString(delta.text) ?? '' }];
        }
        case 'thinking_delta': {
          state.sawThinking = true;
          return [{ type: 'thinking_delta', delta: asString(delta.thinking) ?? '' }];
        }
        case 'signature_delta': {
          // 官方 wire：thinking 块终止前的密签增量，逐字节透传。
          return [{ type: 'signature_delta', delta: asString(delta.signature) ?? '' }];
        }
        case 'input_json_delta': {
          state.sawToolCall = true;
          return [
            {
              type: 'tool_call_delta',
              index,
              argumentsDelta: asString(delta.partial_json) ?? '',
            },
          ];
        }
        default:
          return [];
      }
    }
    case 'message_delta': {
      const delta = asRecord(rec.delta);
      const out: StreamEvent[] = [];
      const rawStop = delta === null ? null : asString(delta.stop_reason);
      if (rawStop !== null) state.stopReason = mapMessagesStopReason(rawStop);
      const usage = asRecord(rec.usage);
      if (usage !== null) {
        const u: StreamUsage = {};
        const output = asNumber(usage.output_tokens);
        if (output !== null) u.outputTokens = output;
        const input = asNumber(usage.input_tokens);
        if (input !== null) u.inputTokens = input;
        if (Object.keys(u).length > 0) out.push({ type: 'usage', usage: u });
      }
      return out;
    }
    case 'message_stop':
      return [makeDone(state)];
    case 'error': {
      const err = asRecord(rec.error);
      const kind = err === null ? 'protocol' : classifyErrorKind(asString(err.type) ?? '');
      const message = err === null ? 'stream error event' : asString(err.message) ?? 'stream error event';
      return [{ type: 'error', error: { code: kind, message } }];
    }
    default:
      return []; // ping 与未知事件忽略
  }
}

function interpretOpenAIData(value: unknown, state: StreamFoldState): StreamEvent[] {
  const rec = asRecord(value);
  if (rec === null) {
    return [
      { type: 'error', error: { code: 'protocol', message: 'SSE data is not an object' } },
    ];
  }
  if (rec.error !== undefined) {
    const err = asRecord(rec.error);
    const kindRaw = err === null ? '' : (asString(err.type) ?? asString(err.code) ?? '');
    const message =
      err === null ? 'stream error payload' : asString(err.message) ?? 'stream error payload';
    return [{ type: 'error', error: { code: classifyErrorKind(kindRaw), message } }];
  }
  const out: StreamEvent[] = [];
  const choices = Array.isArray(rec.choices) ? rec.choices : [];
  const choice = asRecord(choices[0]);
  if (choice !== null) {
    const delta = asRecord(choice.delta);
    if (delta !== null) {
      const reasoning = asString(delta.reasoning_content);
      if (reasoning !== null && reasoning.length > 0) {
        state.sawThinking = true;
        out.push({ type: 'thinking_delta', delta: reasoning });
      }
      const content = asString(delta.content);
      if (content !== null && content.length > 0) {
        state.sawContent = true;
        out.push({ type: 'content_delta', delta: content });
      }
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = asRecord(toolCalls[i]);
        if (tc === null) continue;
        const fn = asRecord(tc.function);
        const id = asString(tc.id);
        const name = fn === null ? null : asString(fn.name);
        state.sawToolCall = true;
        out.push({
          type: 'tool_call_delta',
          index: asNumber(tc.index) ?? i,
          ...(id === null ? {} : { id }),
          ...(name === null ? {} : { name }),
          argumentsDelta: fn === null ? '' : asString(fn.arguments) ?? '',
        });
      }
    }
    const finish = asString(choice.finish_reason);
    if (finish !== null) state.stopReason = mapOpenAIStopReason(finish);
  }
  const usage = asRecord(rec.usage);
  if (usage !== null) {
    const u: StreamUsage = {};
    const prompt = asNumber(usage.prompt_tokens);
    if (prompt !== null) u.inputTokens = prompt;
    const completion = asNumber(usage.completion_tokens);
    if (completion !== null) u.outputTokens = completion;
    const promptDetails = asRecord(usage.prompt_tokens_details);
    const cached = promptDetails === null ? null : asNumber(promptDetails.cached_tokens);
    if (cached !== null) u.cachedInputTokens = cached;
    const completionDetails = asRecord(usage.completion_tokens_details);
    const reasoning = completionDetails === null ? null : asNumber(completionDetails.reasoning_tokens);
    if (reasoning !== null) u.reasoningTokens = reasoning;
    if (Object.keys(u).length > 0) out.push({ type: 'usage', usage: u });
  }
  return out;
}

function interpretWire(
  wire: SSEWireEvent,
  mode: WireMode,
  state: StreamFoldState,
): StreamEvent[] {
  switch (wire.kind) {
    case 'invalid':
      return [
        {
          type: 'error',
          error: {
            code: 'protocol',
            message: `malformed SSE JSON payload: ${truncate(wire.payload, 200)}`,
          },
        },
      ];
    case 'done-sentinel':
      return [makeDone(state)];
    case 'data':
      return mode === 'messages'
        ? interpretMessagesData(wire.value, wire.name, state)
        : interpretOpenAIData(wire.value, state);
  }
}

// ---------------------------------------------------------------------------
// HTTP 错误分类
// ---------------------------------------------------------------------------

function extractErrorMessage(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const rec = asRecord(parsed);
    if (rec === null) return null;
    const err = asRecord(rec.error);
    if (err !== null) {
      const msg = asString(err.message);
      if (msg !== null) return msg;
    }
    const direct = asString(rec.message);
    if (direct !== null) return direct;
    return null;
  } catch {
    return null;
  }
}

function retryAfterMsFromHeaders(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  const sec = headers.get('retry-after');
  if (sec !== null) {
    const n = Number(sec);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
    const date = Date.parse(sec);
    if (!Number.isNaN(date)) {
      const delta = date - Date.now();
      if (delta >= 0) return delta;
    }
  }
  return undefined;
}

function classifyHttpError(status: number, body: string, headers: Headers): AdapterError {
  const contextWindow = /context_window|context_window_exceeded|context_length|max_context/i.test(
    body,
  );
  let code: AdapterErrorCode;
  if (status === 401 || status === 403) code = 'auth';
  else if (status === 408) code = 'network';
  else if (status === 429) code = 'rate_limited';
  else if (status >= 500) code = 'server';
  else code = 'protocol'; // 其余 4xx（含 CONTEXT_WINDOW_EXCEEDED 400）
  const retryAfterMs = code === 'rate_limited' || code === 'server'
    ? retryAfterMsFromHeaders(headers)
    : undefined;
  const message = extractErrorMessage(body) ?? `HTTP ${status}`;
  return {
    code,
    status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    message: contextWindow ? `${message} (CONTEXT_WINDOW_EXCEEDED)` : message,
    raw: truncate(body),
  };
}

// ---------------------------------------------------------------------------
// DeepSeekAdapter
// ---------------------------------------------------------------------------

/**
 * 可注入 fetch 的最小结构化类型（参数面从运行时 globalThis.fetch 派生，
 * 兼容 Bun 的 fetch 对象形态——其上还挂有 preconnect 等属性，不宜直接用
 * `typeof fetch` 约束注入桩）。
 */
export type FetchLike = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>;

export interface DeepSeekAdapterOptions {
  /** 注入 fetch（测试 fixture 专用）；缺省 globalThis.fetch。 */
  fetchImpl?: FetchLike;
  /** 缺省 `https://api.deepseek.com`。 */
  baseUrl?: string;
  apiKey: string;
  /** Messages 模态版本头，缺省 `2023-06-01`。 */
  anthropicVersion?: string;
  /**
   * 附加请求头（provider.extra_headers 装配透传）：合并进每次请求，
   * 同键覆盖缺省头（content-type/accept/鉴权头）；空/缺省 = 不注入。
   */
  extraHeaders?: Record<string, string>;
}

export interface DeepSeekAdapterInstance {
  /**
   * 发起流式请求。URL 规则：
   * - messages 模态：`POST {baseUrl}/anthropic/v1/messages`
   * - openai 模态：`POST {baseUrl}/chat/completions`
   */
  stream(request: WireRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

export function DeepSeekAdapter(options: DeepSeekAdapterOptions): DeepSeekAdapterInstance {
  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const apiKey = options.apiKey;
  const anthropicVersion = options.anthropicVersion ?? '2023-06-01';
  const extraHeaders = options.extraHeaders ?? {};
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  async function* stream(
    request: WireRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const isMessages = request.mode === 'messages';
    const url = isMessages
      ? `${baseUrl}/anthropic/v1/messages`
      : `${baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(isMessages
        ? { 'x-api-key': apiKey, 'anthropic-version': anthropicVersion }
        : { authorization: `Bearer ${apiKey}` }),
      ...extraHeaders,
    };

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      yield {
        type: 'error',
        error: {
          code: 'network',
          message: signal?.aborted === true ? 'request aborted' : `fetch failed: ${String(err)}`,
        },
      };
      return;
    }

    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        body = '';
      }
      yield { type: 'error', error: classifyHttpError(res.status, body, res.headers) };
      return;
    }
    if (res.body === null) {
      yield {
        type: 'error',
        error: { code: 'protocol', status: res.status, message: 'response has no body' },
      };
      return;
    }

    const parser = new SSEParser();
    const decoder = new TextDecoder();
    const state: StreamFoldState = {
      sawContent: false,
      sawThinking: false,
      sawToolCall: false,
      stopReason: null,
    };
    const reader = res.body.getReader();

    try {
      /** 处理一批 wire 事件；返回 'stop' 表示流已终结（done 或 error 已发出）。 */
      const pump = function* (wires: SSEWireEvent[]): Generator<StreamEvent, 'stop' | 'continue'> {
        for (const wire of wires) {
          const events = interpretWire(wire, request.mode, state);
          for (const ev of events) {
            yield ev;
            if (ev.type === 'error' || ev.type === 'done') return 'stop';
          }
        }
        return 'continue';
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text.length === 0) continue;
        const outcome = yield* pump(parser.feed(text));
        if (outcome === 'stop') return;
      }
      // 解码器尾部 + 解析器残余（无换行结尾 / 未分发事件）。
      const tail = decoder.decode();
      const wires = tail.length > 0 ? parser.feed(tail) : [];
      for (const w of parser.flush()) wires.push(w);
      const outcome = yield* pump(wires);
      if (outcome === 'stop') return;
      // 流自然收尾但从未出现 done（服务器漏发 [DONE]/message_stop）：优雅补齐。
      yield makeDone(state);
    } catch (err) {
      yield {
        type: 'error',
        error: {
          code: 'network',
          message: signal?.aborted === true ? 'stream aborted' : `stream read failed: ${String(err)}`,
        },
      };
    } finally {
      try {
        void reader.cancel();
      } catch {
        // 忽略取消异常
      }
    }
  }

  return { stream };
}
