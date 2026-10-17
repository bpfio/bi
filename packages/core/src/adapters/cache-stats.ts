/**
 * BI-04.3 — KV 缓存命中统计与过期浪费成本账单（CacheStats）。
 *
 * # 设计总纲
 *
 * ## 1. 记账口径
 *
 * - 命中：请求命中 KV 前缀缓存 → `recordHit(tokens)`。
 * - 丢失：请求未命中 → `recordMiss(tokens, reason)`；reason 三类：
 *   `cold`（冷启动）/ `expired`（TTL 过期）/ `evicted`（被逐出）。
 * - 过期浪费账单：reason='expired' 的丢失 token 按注入单价累计成本——
 *   这些 token 本来命中缓存即可免费，因过期而全价重算，是**可避免成本**。
 *
 *   expiredWastedCostUsd = expiredWastedTokens × pricePerTokenUsd
 *
 * - 命中率：hitTokens / (hitTokens + missedTokens)，无量纲；空态记 0。
 *
 * ## 2. render() 确定性看板
 *
 * 同一状态 → 恒同字节（固定列宽、固定小数位、无时间戳、无迭代序依赖），
 * 可直接做快照断言与回归基线。
 */

export type MissReason = 'cold' | 'expired' | 'evicted';

export interface CacheStatsOptions {
  /** 每 token 单价（USD），用于过期浪费账单；缺省 0.00000027。 */
  pricePerTokenUsd?: number;
}

export interface CacheStatsSnapshot {
  hits: number;
  misses: number;
  hitTokens: number;
  missedTokens: number;
  /** hitTokens / (hitTokens + missedTokens)，空态 0。 */
  hitRate: number;
  expiredWastedTokens: number;
  expiredWastedCostUsd: number;
}

/** 缺省单价（USD/token），与 CacheWarmer 缺省口径一致。 */
export const DEFAULT_STATS_PRICE_PER_TOKEN_USD = 0.00000027;

export class CacheStats {
  private hits = 0;
  private misses = 0;
  private hitTokens = 0;
  private missedTokens = 0;
  private expiredWastedTokens = 0;
  private expiredWastedCostUsd = 0;
  private readonly pricePerTokenUsd: number;

  constructor(options?: CacheStatsOptions) {
    this.pricePerTokenUsd = options?.pricePerTokenUsd ?? DEFAULT_STATS_PRICE_PER_TOKEN_USD;
  }

  /** 命中 KV 前缀缓存：tokens 全免费。 */
  recordHit(tokens: number): void {
    this.hits += 1;
    this.hitTokens += tokens;
  }

  /** 未命中：reason='expired' 时同步累计可避免成本账单（见文件头 §1）。 */
  recordMiss(tokens: number, reason: MissReason = 'cold'): void {
    this.misses += 1;
    this.missedTokens += tokens;
    if (reason === 'expired') {
      this.expiredWastedTokens += tokens;
      this.expiredWastedCostUsd += tokens * this.pricePerTokenUsd;
    }
  }

  /** 不可变快照（后续记账不影响已取出的快照对象）。 */
  snapshot(): CacheStatsSnapshot {
    const total = this.hitTokens + this.missedTokens;
    return {
      hits: this.hits,
      misses: this.misses,
      hitTokens: this.hitTokens,
      missedTokens: this.missedTokens,
      hitRate: total > 0 ? this.hitTokens / total : 0,
      expiredWastedTokens: this.expiredWastedTokens,
      expiredWastedCostUsd: this.expiredWastedCostUsd,
    };
  }

  /** 确定性看板：固定列宽、固定小数位、无时间戳、无迭代序依赖（见文件头 §2）。 */
  render(): string {
    const s = this.snapshot();
    const lines = [
      'CacheStats',
      `  hits                 : ${String(s.hits)}`,
      `  misses               : ${String(s.misses)}`,
      `  hitTokens            : ${String(s.hitTokens)}`,
      `  missedTokens         : ${String(s.missedTokens)}`,
      `  hitRate              : ${(s.hitRate * 100).toFixed(2)}%`,
      `  expiredWastedTokens  : ${String(s.expiredWastedTokens)}`,
      `  expiredWastedCostUsd : $${s.expiredWastedCostUsd.toFixed(8)}`,
    ];
    return lines.join('\n');
  }
}
