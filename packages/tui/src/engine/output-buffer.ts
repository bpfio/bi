/**
 * output-buffer —— 流式缓动输出缓冲（滑动窗口字节缓冲）。
 *
 * BI-19.2 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - push(bytes)：UTF-8 边界安全——残缺多字节序列（截断的 2/3/4 字节序列）
 *   挂起待续，不提前吐出半字符；
 * - flush()：仅解码「完整字符序列」，挂起尾保留在缓冲中待后续 push 续接
 *   后吐出（挂起尾不丢）；非法首字节按单字节消费、解码为 U+FFFD（终端
 *   同款容忍行为）；
 * - 环形容量上限（默认 64KB）：缓冲超出容量时丢最旧并累计丢弃计数
 *   （丢最旧语义对齐 BI-08 房规；被截断的最旧序列在解码时退化为 U+FFFD）；
 * - 零外部依赖：仅使用 TextDecoder 平台内建。
 */

/** 默认环形容量上限（字节）：64KB。 */
export const DEFAULT_CAPACITY_BYTES = 64 * 1024;

export interface OutputBufferOptions {
  /** 环形容量上限（字节），默认 64KB；必须为正整数。 */
  readonly capacity?: number;
}

/** 扫描字节序列，返回「最后一个完整 UTF-8 序列结束」的偏移（= 可安全解码前缀长度）。 */
function completePrefixLen(bytes: Uint8Array): number {
  let i = 0;
  let lastComplete = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    let seq: number;
    if (b < 0x80) {
      seq = 1;
    } else if ((b & 0xe0) === 0xc0) {
      seq = 2;
    } else if ((b & 0xf0) === 0xe0) {
      seq = 3;
    } else if ((b & 0xf8) === 0xf0) {
      seq = 4;
    } else {
      // 非法首字节（孤立续传字节/过界字节）：按单字节消费，解码器替换 U+FFFD。
      seq = 1;
    }
    if (i + seq > bytes.length) break; // 尾部残缺序列：挂起待续
    i += seq;
    lastComplete = i;
  }
  return lastComplete;
}

/** 滑动窗口字节缓冲：流式喂入字节，按完整 UTF-8 序列吐出文本。 */
export class OutputBuffer {
  private readonly capacity: number;
  private buf: Uint8Array = new Uint8Array(0);
  private dropped = 0;

  constructor(opts: OutputBufferOptions = {}) {
    const capacity = opts.capacity ?? DEFAULT_CAPACITY_BYTES;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`OutputBuffer 容量非法: ${String(opts.capacity)}`);
    }
    this.capacity = capacity;
  }

  /** 环形容量上限（字节）。 */
  get capacityBytes(): number {
    return this.capacity;
  }

  /** 当前缓冲字节数（含残缺多字节挂起尾）。 */
  get pendingBytes(): number {
    return this.buf.length;
  }

  /** 已丢弃的最旧字节数（环形淘汰累计）。 */
  get droppedBytes(): number {
    return this.dropped;
  }

  /**
   * 喂入一块字节。UTF-8 边界安全：与既有缓冲（含挂起尾）拼接后统一度量；
   * 超出容量时从最旧端淘汰至容量内，淘汰字节数累计进 droppedBytes。
   */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf, 0);
    merged.set(bytes, this.buf.length);
    if (merged.length > this.capacity) {
      const evict = merged.length - this.capacity;
      this.dropped += evict;
      this.buf = merged.slice(evict);
    } else {
      this.buf = merged;
    }
  }

  /**
   * 吐出缓冲中所有「完整字符序列」对应的文本；残缺挂起尾保留待续。
   * 空缓冲或仅剩挂起尾时返回空串。
   */
  flush(): string {
    if (this.buf.length === 0) return "";
    const cut = completePrefixLen(this.buf);
    if (cut === 0) return ""; // 整段都是残缺序列尾：继续挂起
    const text = new TextDecoder("utf-8").decode(this.buf.subarray(0, cut));
    this.buf = this.buf.slice(cut);
    return text;
  }
}
