import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPACITY_BYTES, OutputBuffer } from "./output-buffer";

const enc = new TextEncoder();

/** 取字符串 UTF-8 字节的 [from, to) 切片。 */
const slice = (s: string, from: number, to?: number): Uint8Array =>
  enc.encode(s).slice(from, to);

describe("OutputBuffer —— 构造与空态", () => {
  test("默认容量 64KB，可配置覆盖；非法容量抛 RangeError", () => {
    expect(DEFAULT_CAPACITY_BYTES).toBe(65536);
    expect(new OutputBuffer().capacityBytes).toBe(65536);
    expect(new OutputBuffer({ capacity: 16 }).capacityBytes).toBe(16);
    expect(() => new OutputBuffer({ capacity: 0 })).toThrow(RangeError);
    expect(() => new OutputBuffer({ capacity: -1 })).toThrow(RangeError);
    expect(() => new OutputBuffer({ capacity: 1.5 })).toThrow(RangeError);
  });

  test("空缓冲：flush 返回空串，pendingBytes 为 0", () => {
    const b = new OutputBuffer();
    expect(b.flush()).toBe("");
    expect(b.pendingBytes).toBe(0);
    expect(b.droppedBytes).toBe(0);
  });

  test("push 空块为 no-op", () => {
    const b = new OutputBuffer();
    b.push(new Uint8Array(0));
    expect(b.pendingBytes).toBe(0);
    expect(b.flush()).toBe("");
  });

  test("ASCII 单块 push → flush 全量吐出", () => {
    const b = new OutputBuffer();
    b.push(enc.encode("hello world"));
    expect(b.flush()).toBe("hello world");
    expect(b.pendingBytes).toBe(0);
  });
});

describe("OutputBuffer —— UTF-8 边界安全（残缺序列挂起）", () => {
  test("三字节汉字整块 push → flush 解码正确", () => {
    const b = new OutputBuffer();
    b.push(enc.encode("中文"));
    expect(b.flush()).toBe("中文");
    expect(b.pendingBytes).toBe(0);
  });

  test("三字节字符跨 push 边界：首字节挂起，补齐后完整吐出", () => {
    const b = new OutputBuffer();
    const bytes = enc.encode("中"); // E4 B8 AD
    b.push(bytes.slice(0, 1));
    expect(b.flush()).toBe(""); // 残缺首字节不吐半字符
    expect(b.pendingBytes).toBe(1);
    b.push(bytes.slice(1, 2));
    expect(b.flush()).toBe(""); // 仍残缺（2/3）
    expect(b.pendingBytes).toBe(2);
    b.push(bytes.slice(2, 3));
    expect(b.flush()).toBe("中");
    expect(b.pendingBytes).toBe(0);
  });

  test("四字节 emoji（🚀）跨 push 边界拼接", () => {
    const b = new OutputBuffer();
    const bytes = enc.encode("🚀");
    expect(bytes.length).toBe(4);
    b.push(bytes.slice(0, 3));
    expect(b.flush()).toBe("");
    b.push(bytes.slice(3));
    expect(b.flush()).toBe("🚀");
  });

  test("残缺序列横跨三次 push（前缀 + 中段 + 尾字节）", () => {
    const b = new OutputBuffer();
    const bytes = enc.encode("汉"); // E6 B1 89
    b.push(bytes.slice(0, 1));
    b.push(bytes.slice(1, 2));
    expect(b.flush()).toBe("");
    expect(b.pendingBytes).toBe(2);
    b.push(bytes.slice(2));
    expect(b.flush()).toBe("汉");
  });

  test("完整字符先吐、残缺尾挂起不丢（半截多字节随后续 push 到齐）", () => {
    const b = new OutputBuffer();
    const all = enc.encode("ab中"); // 61 62 E4 B8 AD
    b.push(all.slice(0, 3)); // 完整 ab + 残缺「中」首字节
    expect(b.flush()).toBe("ab");
    expect(b.pendingBytes).toBe(1);
    b.push(all.slice(3)); // 「中」尾两字节到齐
    expect(b.flush()).toBe("中");
    expect(b.pendingBytes).toBe(0);
  });

  test("中英混合一次 push 多字符，flush 全量还原", () => {
    const b = new OutputBuffer();
    b.push(enc.encode("a混b合🚀c"));
    expect(b.flush()).toBe("a混b合🚀c");
  });

  test("非法首字节（孤立续传字节）按单字节消费解码为 U+FFFD", () => {
    const b = new OutputBuffer();
    b.push(Uint8Array.of(0x80, 0x41)); // 0x80 非法首字节 + 'A'
    expect(b.flush()).toBe("\uFFFDA");
  });
});

describe("OutputBuffer —— 环形容量与丢弃计数", () => {
  test("超容量丢最旧：capacity 8，push 10 字节 → 丢 2，flush 得后 8 字节", () => {
    const b = new OutputBuffer({ capacity: 8 });
    b.push(enc.encode("0123456789"));
    expect(b.droppedBytes).toBe(2);
    expect(b.pendingBytes).toBe(8);
    expect(b.flush()).toBe("23456789");
  });

  test("丢弃计数跨多次 push 累计", () => {
    const b = new OutputBuffer({ capacity: 4 });
    b.push(enc.encode("ab")); // 2 字节（不超）
    expect(b.droppedBytes).toBe(0);
    b.push(enc.encode("cd")); // 4 字节（恰好不超）
    expect(b.droppedBytes).toBe(0);
    b.push(enc.encode("ef")); // 6 > 4 → 丢 2
    expect(b.droppedBytes).toBe(2);
    b.push(enc.encode("ghij")); // 4+4=8 > 4 → 再丢 4
    expect(b.droppedBytes).toBe(6);
    expect(b.flush()).toBe("ghij");
  });

  test("丢弃可截断最旧多字节序列：孤立续传字节退化为 U+FFFD（丢最旧语义）", () => {
    const b = new OutputBuffer({ capacity: 4 });
    b.push(enc.encode("中中")); // E6 B1 89 E6 B1 89，6 > 4 → 丢最旧 2 字节
    expect(b.droppedBytes).toBe(2);
    expect(b.pendingBytes).toBe(4);
    // 残余 = 首字尾字节(89) + 次字完整序列(E6 B1 89)：首字退化 U+FFFD，次字存活
    expect(b.flush()).toBe("\uFFFD中");
    expect(b.pendingBytes).toBe(0);
  });

  test("恰好等于容量不丢弃", () => {
    const b = new OutputBuffer({ capacity: 6 });
    b.push(enc.encode("abcdef"));
    expect(b.droppedBytes).toBe(0);
    expect(b.flush()).toBe("abcdef");
  });

  test("默认 64KB 容量下小流量零丢弃", () => {
    const b = new OutputBuffer();
    for (let i = 0; i < 100; i++) b.push(enc.encode("中文流式 chunk;"));
    expect(b.droppedBytes).toBe(0);
    const out = b.flush();
    expect(out).toBe("中文流式 chunk;".repeat(100));
  });
});
