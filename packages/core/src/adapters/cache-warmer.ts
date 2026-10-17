/**
 * BI-04.3 — KV 缓存保活预热器（CacheWarmer）。
 *
 * # 设计总纲
 *
 * ## 1. TTL 消逝保活
 *
 * KV 前缀缓存有 TTL（缺省 300_000ms）。距上次请求消逝比例
 * `elapsedRatio = (now - lastRequestAt) / ttlMs` 达到 `thresholdRatio`
 * （缺省 0.9）即发送 **1-token 保活脉冲**（`max_tokens: 1` 的最小请求，
 * 经注入 fetchImpl 发出），重置 TTL、保住已缓存的静态前缀。
 *
 * - `elapsedRatio < thresholdRatio` → skip-fresh（缓存还热，不打扰）。
 * - `elapsedRatio ≥ thresholdRatio` → 进入经济学闸门。
 *
 * ## 2. 经济学闸门（doc 口径）
 *
 * 保活不是免费的：脉冲本身要花 1 个输出 token + 网络往返。是否值得唤醒
 * 由期望节省决定：
 *
 *   expectedSavingsUsd = tokens × pricePerTokenUsd × 0.8
 *
 * - `tokens`：受保活保护的缓存前缀 token 数。
 * - `pricePerTokenUsd`：注入单价（缺省 $0.27/M ≈ 0.00000027，DeepSeek
 *   缓存未命中价口径）。
 * - `× 0.8`：保活只挽回**输入缓存缺失**部分的成本，经验折算系数 0.8
 *   （其余 20% 对应输出/网络等不可挽回开销的保守折扣）。
 *
 * **expectedSavingsUsd < $0.05 不唤醒**（`MIN_SAVINGS_USD`）：小前缀让
 * TTL 自然过期再全量重算，比频繁脉冲更便宜。$0.05 闸门 = 单次脉冲调用
 * 成本 + 失败重试风险折算的最小值得门槛。
 *
 * ## 3. 失败语义
 *
 * 脉冲 fetch 抛错或非 2xx → `decision: 'pulse-failed'`，**不抛出**：
 * 保活是尽力而为的后台动作，失败只记账不炸主流程（调用方可据此告警）。
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 缺省 TTL（ms）。 */
export const DEFAULT_TTL_MS = 300_000;
/** 缺省触发阈值（消逝比例）。 */
export const DEFAULT_THRESHOLD_RATIO = 0.9;
/** 缺省单价（USD/token，DeepSeek 缓存未命中价口径）。 */
export const DEFAULT_PRICE_PER_TOKEN_USD = 0.00000027;
/** 缺省保活 URL（DeepSeek chat completions）。 */
export const DEFAULT_WARMER_URL = 'https://api.deepseek.com/chat/completions';
/** 缺省保活 model 字段。 */
export const DEFAULT_WARMER_MODEL = 'deepseek-chat';

export interface CacheWarmerOptions {
  fetchImpl: FetchLike;
  /** 缓存 TTL，缺省 300_000ms。 */
  ttlMs?: number;
  /** 触发保活的消逝比例，缺省 0.9。 */
  thresholdRatio?: number;
  /** 注入时钟（ms），缺省 Date.now。 */
  clock?: () => number;
  /** 每 token 单价（USD），缺省 0.00000027。 */
  pricePerTokenUsd?: number;
  /** 保活请求 model 字段。 */
  model?: string;
  /** 保活请求 URL。 */
  url?: string;
}

export type TickDecision = 'pulse' | 'skip-fresh' | 'skip-economics' | 'pulse-failed';

export interface TickResult {
  decision: TickDecision;
  elapsedMs: number;
  elapsedRatio: number;
  expectedSavingsUsd: number;
  /** decision=pulse-failed 时的错误摘要。 */
  error?: string;
}

/** 经济学闸门：期望节省低于该值（USD）不唤醒。 */
export const MIN_SAVINGS_USD = 0.05;

/** 保活折算系数（见文件头 §2）。 */
export const KEEPALIVE_RECOVERY_RATIO = 0.8;

/** 经济学闸门：期望节省 = tokens × 单价 × 0.8（见文件头 §2）。 */
function expectedSavings(tokens: number, pricePerTokenUsd: number): number {
  return tokens * pricePerTokenUsd * KEEPALIVE_RECOVERY_RATIO;
}

export class CacheWarmer {
  private readonly fetchImpl: FetchLike;
  private readonly ttlMs: number;
  private readonly thresholdRatio: number;
  private readonly clock: () => number;
  private readonly pricePerTokenUsd: number;
  private readonly model: string;
  private readonly url: string;

  constructor(options: CacheWarmerOptions) {
    this.fetchImpl = options.fetchImpl;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.thresholdRatio = options.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
    this.clock = options.clock ?? (() => Date.now());
    this.pricePerTokenUsd = options.pricePerTokenUsd ?? DEFAULT_PRICE_PER_TOKEN_USD;
    this.model = options.model ?? DEFAULT_WARMER_MODEL;
    this.url = options.url ?? DEFAULT_WARMER_URL;
  }

  /** 期望节省（USD）：tokens × 单价 × 0.8。 */
  expectedSavingsUsd(tokens: number): number {
    return expectedSavings(tokens, this.pricePerTokenUsd);
  }

  /**
   * TTL 消逝判定 → 经济学闸门 → 1-token 保活脉冲。
   * 状态机：skip-fresh（还热）→ skip-economics（不值得）→ pulse / pulse-failed。
   * 保活是尽力而为的后台动作：任何失败都不抛出，只记账（见文件头 §3）。
   */
  async tick(lastRequestAt: number, tokens: number): Promise<TickResult> {
    const now = this.clock();
    const elapsedMs = now - lastRequestAt;
    const elapsedRatio = this.ttlMs > 0 ? elapsedMs / this.ttlMs : Number.POSITIVE_INFINITY;
    const savings = expectedSavings(tokens, this.pricePerTokenUsd);

    if (elapsedRatio < this.thresholdRatio) {
      return { decision: 'skip-fresh', elapsedMs, elapsedRatio, expectedSavingsUsd: savings };
    }
    if (savings < MIN_SAVINGS_USD) {
      return { decision: 'skip-economics', elapsedMs, elapsedRatio, expectedSavingsUsd: savings };
    }

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: '.' }],
          max_tokens: 1,
        }),
      });
      if (!response.ok) {
        return {
          decision: 'pulse-failed',
          elapsedMs,
          elapsedRatio,
          expectedSavingsUsd: savings,
          error: `HTTP ${response.status}`,
        };
      }
      return { decision: 'pulse', elapsedMs, elapsedRatio, expectedSavingsUsd: savings };
    } catch (err) {
      return {
        decision: 'pulse-failed',
        elapsedMs,
        elapsedRatio,
        expectedSavingsUsd: savings,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
