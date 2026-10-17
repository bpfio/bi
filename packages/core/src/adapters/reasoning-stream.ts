/**
 * BI-04.2 — 思考流解析与 v41 视觉 Token 网格（纯数学、零依赖）。
 *
 * # 1. 思考流解析（parseReasoningStream）
 *
 * 职责：把适配器输出的 StreamEvent 流折叠为「思考块与正文分离」的最终结构
 * `{ thinking, signature?, content }`：
 *
 * - **thinking 块与正文分离**：`thinking_delta` 聚合进 `thinking`，`content_delta`
 *   聚合进 `content`，两者互不污染；
 * - **signature_delta 无损透传**：官方 Messages wire 在思考块终止前发出
 *   `signature_delta`（DeepSeek 密签），逐字节原样拼接，不做 trim/编码变换——
 *   回放时必须与签发时完全一致才能通过服务端校验并命中前缀缓存；
 * - **reasoning_content 聚合**：OpenAI 兼容形态的 `reasoning_content` 已由适配器
 *   规范化为 `thinking_delta`，在此统一聚合（两种模态得到同构结果）；
 * - **序列化往返可重放**：`serializeReasoning` → `ReplayEnvelope` JSON（定版
 *   version=1），`deserializeReasoning` 校验还原，字节级往返；`toReplayBlocks`
 *   生成可回填 assistant 消息的 ContentBlock 序列（thinking 块原样携带 signature）。
 *
 * # 2. v41 视觉 Token 几何网格（官方公式）
 *
 * DeepSeek 官方 v41 视觉编码器的确定性 Token 计价。常量：
 *
 * ```
 * PATCH_SIZE        = 14          px（视觉补丁边长）
 * DOWNSAMPLE_RATIO  = 3           （3:1 降采样：每 3×3 补丁折叠为 1 个网格单元）
 * CELL_SIZE         = 42          px = PATCH_SIZE × DOWNSAMPLE_RATIO
 * MIN_PIXELS        = 544 × 544   （最小像素底限，不足则整数倍上采样）
 * MAX_IMAGE_TOKENS  = 1024        （单图 Token 硬顶）
 * ```
 *
 * 公式（doc 化，测试锚定）：
 *
 * ```
 * gridCells(paddedLength) = ceilDiv( floor(paddedLength / 14), 3 )
 * gridTokens(H, W)        = H × (W + 1) + 2
 * ```
 *
 * - `gridTokens`：每行 W 个单元外加 1 枚行分隔符（+1），整图再加 2 枚取帧 Token（+2）；
 * - 求解流程 `v41ImageGrid(w, h)`：
 *   1. **上采样到底限**：取最小整数倍 `f ≥ 1` 使 `(w·f)·(h·f) ≥ MIN_PIXELS`；
 *   2. **按 CELL_SIZE 取整**：`padded = ceil(dim·f / 42) × 42`（保持宽高比地补边）；
 *   3. **投影网格**：`W = gridCells(paddedW)`，`H = gridCells(paddedH)`；
 *   4. **预算钳制**：若 `gridTokens(H, W) > MAX_IMAGE_TOKENS`，用
 *      `solveResizeRatio(height, width, budget)` 封闭求解等比缩放系数
 *      （二次方程求根，忽略 ceil 量化），再经 `resizeOnce` 乘性收缩迭代至
 *      不动点（Fixpoint），在预算内求保宽高比的最大网格；返回 Token 数恒
 *      `≤ maxTokens` 且 `≥ 4`（1×1 网格 + 2 帧位）。
 * - 纯整数/浮点数学，无 I/O、无模型调用，耗时 < 0.1ms。
 */

import type { ContentBlock, StreamEvent } from './deepseek-adapter';

// ---------------------------------------------------------------------------
// 思考流折叠
// ---------------------------------------------------------------------------

/** 思考流分离结果：thinking 与正文 content 分离，signature 为官方密签。 */
export interface ReasoningResult {
  thinking: string;
  signature?: string;
  content: string;
}

/** 序列化信封（定版 v1），序列化往返可重放。 */
export interface ReplayEnvelope {
  version: 1;
  thinking: string;
  signature?: string;
  content: string;
}

/**
 * 增量折叠器：逐事件 push，任意时刻 snapshot 得到当前分离结果。
 * 只消费 content_delta / thinking_delta / signature_delta；其余事件
 * （tool_call_delta/usage/done/error）与思考流无关，安全忽略。
 */
export class ReasoningAccumulator {
  private thinking = '';
  private signature: string | undefined;
  private content = '';

  push(event: StreamEvent): void {
    switch (event.type) {
      case 'thinking_delta':
        this.thinking += event.delta;
        break;
      case 'signature_delta':
        // 无损透传：逐字节拼接，见过即存在（含空串）。
        this.signature = (this.signature ?? '') + event.delta;
        break;
      case 'content_delta':
        this.content += event.delta;
        break;
      default:
        break;
    }
  }

  snapshot(): ReasoningResult {
    return this.signature === undefined
      ? { thinking: this.thinking, content: this.content }
      : { thinking: this.thinking, signature: this.signature, content: this.content };
  }
}

/**
 * 消耗事件流（async 或 sync iterable），折叠为最终分离结构。
 */
export async function parseReasoningStream(
  events: AsyncIterable<StreamEvent> | Iterable<StreamEvent>,
): Promise<ReasoningResult> {
  const acc = new ReasoningAccumulator();
  for await (const event of events) {
    acc.push(event);
  }
  return acc.snapshot();
}

/** 序列化为 ReplayEnvelope JSON（键序固定：version → thinking → signature? → content）。 */
export function serializeReasoning(result: ReasoningResult): string {
  const envelope: ReplayEnvelope = {
    version: 1,
    thinking: result.thinking,
    ...(result.signature === undefined ? {} : { signature: result.signature }),
    content: result.content,
  };
  return JSON.stringify(envelope);
}

/** 从 ReplayEnvelope JSON 还原；畸形输入抛 TypeError（杜绝静默假回放）。 */
export function deserializeReasoning(json: string): ReasoningResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new TypeError(`malformed replay envelope: not JSON (${String(err)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('malformed replay envelope: not an object');
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.version !== 1) {
    throw new TypeError(`malformed replay envelope: unsupported version ${String(rec.version)}`);
  }
  if (typeof rec.thinking !== 'string' || typeof rec.content !== 'string') {
    throw new TypeError('malformed replay envelope: thinking/content must be strings');
  }
  if (rec.signature !== undefined && typeof rec.signature !== 'string') {
    throw new TypeError('malformed replay envelope: signature must be a string');
  }
  return rec.signature === undefined
    ? { thinking: rec.thinking, content: rec.content }
    : { thinking: rec.thinking, signature: rec.signature, content: rec.content };
}

/**
 * 生成回放块：非空 thinking（携带 signature，如有）在前、非空正文在后；
 * 空块不产出。回放给 Messages 模态时签名逐字节带回（服务端校验通过的前提）。
 */
export function toReplayBlocks(result: ReasoningResult): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (result.thinking.length > 0 || result.signature !== undefined) {
    blocks.push(
      result.signature === undefined
        ? { type: 'thinking', thinking: result.thinking }
        : { type: 'thinking', thinking: result.thinking, signature: result.signature },
    );
  }
  if (result.content.length > 0) {
    blocks.push({ type: 'text', text: result.content });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// v41 视觉 Token 几何网格
// ---------------------------------------------------------------------------

export const PATCH_SIZE = 14;
export const DOWNSAMPLE_RATIO = 3;
export const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO; // 42
export const MIN_PIXELS = 544 * 544; // 295_936
export const MAX_IMAGE_TOKENS = 1024;

export interface V41Options {
  minPixels?: number;
  maxTokens?: number;
}

export interface V41Grid {
  /** 网格列数（宽向单元数）。 */
  width: number;
  /** 网格行数（高向单元数）。 */
  height: number;
  /** gridTokens(height, width)。 */
  tokens: number;
}

function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/** 官方公式：paddedLength（已按 CELL_SIZE 取整）→ 网格单元数。 */
export function gridCells(paddedLength: number): number {
  return ceilDiv(Math.floor(paddedLength / PATCH_SIZE), DOWNSAMPLE_RATIO);
}

/** 官方公式：每行 1 枚分隔符 + 整图 2 枚取帧 Token。 */
export function gridTokens(rows: number, cols: number): number {
  return rows * (cols + 1) + 2;
}

/** pad 后（CELL_SIZE 整数倍）投影网格。 */
function gridOf(paddedWidth: number, paddedHeight: number): { width: number; height: number } {
  return { width: gridCells(paddedWidth), height: gridCells(paddedHeight) };
}

/** 实数尺寸（未 pad）直接投影：ceil(dim/CELL) 等价于 pad→gridCells。 */
function gridAt(heightPx: number, widthPx: number): { width: number; height: number } {
  return {
    width: Math.ceil(widthPx / CELL_SIZE),
    height: Math.ceil(heightPx / CELL_SIZE),
  };
}

/**
 * 封闭求解：忽略 ceil 量化的等比缩放系数。
 * tokens(s) ≈ (h·s/42)·(w·s/42 + 1) + 2 = (h·w/42²)s² + (h/42)s + 2 ≤ budget
 * 解二次方程取正根。
 */
export function solveResizeRatio(height: number, width: number, budget: number): number {
  const a = (height * width) / (CELL_SIZE * CELL_SIZE);
  const b = height / CELL_SIZE;
  const c = 2 - budget;
  if (a <= 0) return 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) return 1;
  const s = (-b + Math.sqrt(discriminant)) / (2 * a);
  return Math.min(Math.max(s, 0), 1);
}

/**
 * 单步收缩（乘性 √(budget/t) 逼近 + 绝对下限步进），保证每轮严格递减，
 * 不动点迭代至预算内。
 */
function resizeOnce(
  height: number,
  width: number,
  scale: number,
  budget: number,
): number {
  const grid = gridAt(height * scale, width * scale);
  const t = gridTokens(grid.height, grid.width);
  if (t <= budget) return scale;
  const shrink = Math.max(Math.sqrt(budget / t), 1 - 1e-3 / Math.max(scale, 1e-3));
  return Math.max(scale * shrink - 1e-3, 0);
}

function clampError(input: number, name: string): void {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    throw new RangeError(`v41ImageTokens: ${name} must be a positive finite number, got ${String(input)}`);
  }
}

/**
 * v41 官方网格求解：返回保宽高比、预算内的最终网格与 Token 数。
 * 返回 tokens 恒 ≤ maxTokens（默认 1024）且 ≥ 4。
 */
export function v41ImageGrid(
  w: number,
  h: number,
  opts?: V41Options,
): V41Grid {
  clampError(w, 'w');
  clampError(h, 'h');
  const minPixels = opts?.minPixels ?? MIN_PIXELS;
  const maxTokens = opts?.maxTokens ?? MAX_IMAGE_TOKENS;
  if (!Number.isFinite(minPixels) || minPixels < 0) {
    throw new RangeError(`v41ImageTokens: minPixels must be a non-negative finite number`);
  }
  if (!Number.isFinite(maxTokens) || maxTokens < 4) {
    throw new RangeError('v41ImageTokens: maxTokens must be a finite number >= 4');
  }

  // 1. 最小整数倍上采样至像素底限（整数精确校验，免疫浮点边界）。
  let factor = Math.max(1, Math.ceil(Math.sqrt(minPixels / (w * h))));
  while ((w * factor) * (h * factor) < minPixels) factor++;
  while (factor > 1 && (w * (factor - 1)) * (h * (factor - 1)) >= minPixels) factor--;
  const scaledW = w * factor;
  const scaledH = h * factor;

  // 2. 按 CELL_SIZE 向上取整补边，3. 投影网格。
  const paddedW = ceilDiv(scaledW, CELL_SIZE) * CELL_SIZE;
  const paddedH = ceilDiv(scaledH, CELL_SIZE) * CELL_SIZE;
  const grid: { width: number; height: number } = gridOf(paddedW, paddedH);

  // 4. 预算钳制：封闭求解 + 不动点迭代（保宽高比等比收缩）。
  if (gridTokens(grid.height, grid.width) > maxTokens) {
    let scale = solveResizeRatio(scaledH, scaledW, maxTokens);
    for (let i = 0; i < 256; i++) {
      const next = resizeOnce(scaledH, scaledW, scale, maxTokens);
      if (next === scale) break; // 不动点：已落入预算
      scale = next;
    }
    const g = gridAt(scaledH * scale, scaledW * scale);
    // 钳制保证：退化至 1×1 网格 = 4 tokens ≤ 任意合法预算。
    const clamped = {
      width: Math.max(g.width, 1),
      height: Math.max(g.height, 1),
    };
    let t = gridTokens(clamped.height, clamped.width);
    let guard = 0;
    while (t > maxTokens && guard < 64) {
      // 理论不可达的兜底：强制收缩网格直至预算内。
      if (clamped.height >= clamped.width && clamped.height > 1) clamped.height--;
      else if (clamped.width > 1) clamped.width--;
      t = gridTokens(clamped.height, clamped.width);
      guard++;
    }
    return { width: clamped.width, height: clamped.height, tokens: t };
  }

  return { width: grid.width, height: grid.height, tokens: gridTokens(grid.height, grid.width) };
}

/** v41 视觉 Token 计价（官方物理服务端对齐）。 */
export function v41ImageTokens(w: number, h: number, opts?: V41Options): number {
  return v41ImageGrid(w, h, opts).tokens;
}
