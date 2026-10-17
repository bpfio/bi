/**
 * PasteBurst —— 粘贴防冲看门狗（字节到达节奏分析）。
 *
 * BI-19 合约（Kimi Code 增强 pi-tui 底座 · 重实现，未读取任何参考源码）：
 * - 判定规则：单次读入 > 64 字节，或「含 \n 的连续块」（相对前一块间隔 < 10ms）
 *   → 判为 paste burst；burst 期间间隔 < 10ms 的后续字节持续聚合；
 * - burst 结束（间隔 ≥ 10ms 或显式结算）→ 聚合文本以
 *   `{ kind: "paste", text }` 一次性回调 —— 防止逐字符到达的回车被解释成「提交」；
 * - 非粘贴节奏的字节原样走 onBytes 正常按键路径（onKey 正常分片）；
 * - 时钟与定时调度器均可注入（测试用假时钟 + 手动调度器，全离屏确定性）。
 *
 * 说明：本实现基于节奏启发式，不依赖括号粘贴模式（bracketed paste）转义序列；
 * 换行判定严格按合约只看 \n（0x0A；CRLF 粘贴必含 \n，不受影响）。
 */

/** 可注入时钟（测试用假时钟）。 */
export interface Clock {
  now(): number;
}

/** 已排定的定时器句柄（可取消）。 */
export interface Timer {
  cancel(): void;
}

/** 可注入定时调度器（测试用手动调度器替代真实 setTimeout）。 */
export interface Scheduler {
  schedule(ms: number, fn: () => void): Timer;
}

/** 默认系统时钟。 */
export const defaultClock: Clock = { now: () => Date.now() };

/** 默认真实定时器调度器。 */
export const defaultScheduler: Scheduler = {
  schedule(ms: number, fn: () => void): Timer {
    const id = setTimeout(fn, ms);
    return {
      cancel: () => clearTimeout(id),
    };
  },
};

/** 单次读入超过该字节数直接判为粘贴。 */
export const PASTE_SIZE_THRESHOLD = 64;

/** 相邻字节块间隔小于该毫秒数视为同一到达脉冲。 */
export const PASTE_GAP_MS = 10;

/** PasteBurst 的依赖注入。 */
export interface PasteBurstDeps {
  /** 正常按键路径：非粘贴节奏的字节按到达顺序原样交给调用方解析（onKey 正常分片）。 */
  onBytes: (bytes: Uint8Array) => void;
  /** 粘贴聚合完成：一次性回调，text 为整段 UTF-8 解码文本。 */
  onPaste: (text: string) => void;
  /** 时钟注入（缺省系统时钟）。 */
  clock?: Clock;
  /** 调度器注入（缺省 setTimeout；测试可注入手动调度器）。 */
  scheduler?: Scheduler;
}

/** 粘贴看门狗：区分「逐键输入」与「粘贴突发」。 */
export class PasteBurst {
  private readonly onBytes: (bytes: Uint8Array) => void;
  private readonly onPaste: (text: string) => void;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;

  private lastFeedAt: number | undefined;
  private inPaste = false;
  private parts: Uint8Array[] = [];
  private pasteBytes = 0;
  private settleTimer: Timer | null = null;

  constructor(deps: PasteBurstDeps) {
    this.onBytes = deps.onBytes;
    this.onPaste = deps.onPaste;
    this.clock = deps.clock ?? defaultClock;
    this.scheduler = deps.scheduler ?? defaultScheduler;
  }

  /** 当前是否处于粘贴聚合中（调试与测试观察用）。 */
  get pasting(): boolean {
    return this.inPaste;
  }

  /** 当前聚合的字节数（调试与测试观察用）。 */
  get bufferedBytes(): number {
    return this.pasteBytes;
  }

  /**
   * 喂入一次读到的字节块。
   * 返回 true = 已吸收进粘贴聚合（调用方不得再解析该块）；
   * 返回 false = 非粘贴节奏，字节已走 onBytes 正常按键路径。
   */
  feed(chunk: Uint8Array): boolean {
    const now = this.clock.now();
    const gap =
      this.lastFeedAt === undefined
        ? Number.POSITIVE_INFINITY
        : now - this.lastFeedAt;
    this.lastFeedAt = now;

    if (this.inPaste) {
      if (gap < PASTE_GAP_MS) {
        this.append(chunk);
        this.armSettle();
        return true;
      }
      // 间隔过大：粘贴结束，先把聚合文本一次性回调，再按新块处理。
      this.settlePaste();
    }

    const hasNewline = containsByte(chunk, 0x0a);
    if (chunk.length > PASTE_SIZE_THRESHOLD || (hasNewline && gap < PASTE_GAP_MS)) {
      this.inPaste = true;
      this.append(chunk);
      this.armSettle();
      return true;
    }

    if (chunk.length > 0) this.onBytes(chunk);
    return false;
  }

  /** 自然结算：粘贴模式挂起内容以 paste 一次性回调；非粘贴模式无操作。 */
  flush(): void {
    if (this.inPaste) this.settlePaste();
  }

  /** 强制把挂起的粘贴缓冲按普通按键路径分片释放（InputLoop 超时兜底用）。 */
  flushAsKeys(): void {
    if (!this.inPaste) return;
    const bytes = concatBytes(this.parts, this.pasteBytes);
    this.clearPaste();
    if (bytes.length > 0) this.onBytes(bytes);
  }

  /** 释放资源：取消挂起定时器（不触发任何回调）。 */
  dispose(): void {
    this.cancelSettle();
    this.clearPaste();
  }

  private settlePaste(): void {
    const bytes = concatBytes(this.parts, this.pasteBytes);
    this.clearPaste();
    if (bytes.length > 0) this.onPaste(decodeUtf8(bytes));
  }

  private clearPaste(): void {
    this.inPaste = false;
    this.parts = [];
    this.pasteBytes = 0;
    this.cancelSettle();
  }

  private cancelSettle(): void {
    if (this.settleTimer !== null) {
      this.settleTimer.cancel();
      this.settleTimer = null;
    }
  }

  /** 排定结算定时器：PASTE_GAP_MS 静默后自动结束聚合（真实环境兜底）。 */
  private armSettle(): void {
    this.cancelSettle();
    this.settleTimer = this.scheduler.schedule(PASTE_GAP_MS, () => {
      this.settleTimer = null;
      if (!this.inPaste) return;
      const last = this.lastFeedAt;
      if (last === undefined) return;
      if (this.clock.now() - last >= PASTE_GAP_MS) {
        this.settlePaste();
      } else {
        this.armSettle();
      }
    });
  }

  private append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.parts.push(chunk);
    this.pasteBytes += chunk.length;
  }
}

/** 是否包含指定字节。 */
function containsByte(bytes: Uint8Array, target: number): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === target) return true;
  }
  return false;
}

/** 拼接字节块列表。 */
function concatBytes(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** UTF-8 解码（容忍截断尾部，非法序列替换为 U+FFFD）。 */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}
