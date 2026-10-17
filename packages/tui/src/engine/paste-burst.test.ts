import { describe, expect, test } from "bun:test";
import { PasteBurst, PASTE_GAP_MS, PASTE_SIZE_THRESHOLD } from "./paste-burst";
import { FakeClock, ManualScheduler } from "../testing";

interface Harness {
  onBytesSpy: { bytes: Uint8Array[] };
  onPasteSpy: { texts: string[] };
  burst: PasteBurst;
  clock: FakeClock;
  sched: ManualScheduler;
}

function makeBurst(): Harness {
  const clock = new FakeClock();
  const sched = new ManualScheduler();
  const onBytesSpy = { bytes: [] as Uint8Array[] };
  const onPasteSpy = { texts: [] as string[] };
  const burst = new PasteBurst({
    onBytes: (b) => onBytesSpy.bytes.push(b),
    onPaste: (t) => onPasteSpy.texts.push(t),
    clock,
    scheduler: sched,
  });
  return { onBytesSpy, onPasteSpy, burst, clock, sched };
}

const bigChunk = (n: number, fill = "a"): Uint8Array =>
  new TextEncoder().encode(fill.repeat(n));

describe("PasteBurst —— 尺寸阈值", () => {
  test("阈值常量符合合约（64 字节 / 10ms）", () => {
    expect(PASTE_SIZE_THRESHOLD).toBe(64);
    expect(PASTE_GAP_MS).toBe(10);
  });

  test("单次读入 >64 字节判为 paste，feed 返回 true", () => {
    const h = makeBurst();
    expect(h.burst.feed(bigChunk(65))).toBe(true);
    expect(h.burst.pasting).toBe(true);
  });

  test("64 字节整（不超阈值且无 \\n）走正常按键路径", () => {
    const h = makeBurst();
    expect(h.burst.feed(bigChunk(64))).toBe(false);
    expect(h.onBytesSpy.bytes).toHaveLength(1);
    expect(h.burst.pasting).toBe(false);
  });

  test("阈值边界：65 字节为 paste，flush 后一次性回调整段文本", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(65));
    h.burst.flush();
    expect(h.onPasteSpy.texts).toEqual(["a".repeat(65)]);
    expect(h.burst.pasting).toBe(false);
  });
});

describe("PasteBurst —— \\n 连续块判定", () => {
  test("首发单块含 \\n（无前序间隔）不是 paste —— 孤立 Enter 保全", () => {
    const h = makeBurst();
    expect(h.burst.feed(new TextEncoder().encode("\n"))).toBe(false);
    expect(h.onBytesSpy.bytes).toHaveLength(1);
  });

  test("间隔 <10ms 的含 \\n 后续块判为 paste", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(3)); // 普通键路径
    h.clock.advance(5); // <10ms
    expect(h.burst.feed(new TextEncoder().encode("\n"))).toBe(true);
    expect(h.burst.pasting).toBe(true);
  });

  test("间隔 ≥10ms 的含 \\n 块不是 paste", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(3));
    h.clock.advance(PASTE_GAP_MS + 1);
    expect(h.burst.feed(new TextEncoder().encode("\n"))).toBe(false);
    expect(h.burst.pasting).toBe(false);
  });

  test("粘贴节奏下含 \\n 块整体聚合，回车不被解释成 Enter —— 防逐字符回车误提交", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(3, "x")); // 普通键路径（无 \\n 且不超阈值）
    h.clock.advance(5); // <10ms
    h.burst.feed(new TextEncoder().encode("lo\n")); // 快速连续 + 含 \n → paste
    h.burst.flush();
    // 块内换行进入聚合文本，而不是触发 enter 键
    expect(h.onPasteSpy.texts).toEqual(["lo\n"]);
    expect(h.onBytesSpy.bytes).toHaveLength(1); // 仅最初的 3 字节走了键路径
  });
});

describe("PasteBurst —— 聚合与结算", () => {
  test("burst 内多个快速块聚合为一次回调", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(70, "1"));
    h.clock.advance(3);
    h.burst.feed(new TextEncoder().encode("abc"));
    h.clock.advance(3);
    h.burst.feed(new TextEncoder().encode("def"));
    h.burst.flush();
    expect(h.onPasteSpy.texts).toEqual(["1".repeat(70) + "abcdef"]);
    expect(h.onPasteSpy.texts[0]!.length).toBe(76);
  });

  test("间隔拉大结束 burst：先 paste 回调，再按普通键处理新块", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(70));
    h.clock.advance(20);
    expect(h.burst.feed(new TextEncoder().encode("y"))).toBe(false);
    expect(h.onPasteSpy.texts).toEqual(["a".repeat(70)]);
    expect(h.onBytesSpy.bytes).toHaveLength(1);
    expect(new TextDecoder().decode(h.onBytesSpy.bytes[0]!)).toBe("y");
  });

  test("跨块 UTF-8 多字节聚合后正确解码", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(70));
    h.clock.advance(2);
    h.burst.feed(new TextEncoder().encode("中"));
    h.burst.flush();
    expect(h.onPasteSpy.texts).toEqual(["a".repeat(70) + "中"]);
  });

  test("flushAsKeys 把挂起粘贴缓冲按普通按键路径分片释放", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(70));
    h.clock.advance(2);
    h.burst.feed(new TextEncoder().encode("zz"));
    h.burst.flushAsKeys();
    expect(h.burst.pasting).toBe(false);
    expect(h.onBytesSpy.bytes).toHaveLength(1);
    expect(h.onBytesSpy.bytes[0]!.length).toBe(72);
    // 释放后定时器结算不再触发 paste
    h.clock.advance(50);
    h.sched.runDue();
    expect(h.onPasteSpy.texts).toHaveLength(0);
  });

  test("定时器静默自动结算（scheduler 注入路径）", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(70));
    h.clock.advance(PASTE_GAP_MS + 1);
    h.sched.runDue();
    expect(h.onPasteSpy.texts).toEqual(["a".repeat(70)]);
  });

  test("定时器提前触发（时钟未走够）会重新排定而不误结算", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(70));
    h.sched.runDue(); // now-lastFeedAt = 0 < 10ms → 重排
    expect(h.onPasteSpy.texts).toHaveLength(0);
    expect(h.burst.pasting).toBe(true);
    h.clock.advance(PASTE_GAP_MS + 1);
    h.sched.runDue();
    expect(h.onPasteSpy.texts).toEqual(["a".repeat(70)]);
  });

  test("空块：非粘贴态直接吞掉不回调；粘贴态仅维持节奏", () => {
    const h = makeBurst();
    expect(h.burst.feed(new Uint8Array(0))).toBe(false);
    expect(h.onBytesSpy.bytes).toHaveLength(0);
    h.burst.feed(bigChunk(70));
    h.clock.advance(2);
    expect(h.burst.feed(new Uint8Array(0))).toBe(true); // 继续聚合节奏
    expect(h.burst.bufferedBytes).toBe(70);
  });

  test("dispose 取消定时器且不触发任何回调", () => {
    const h = makeBurst();
    h.burst.feed(bigChunk(70));
    h.burst.dispose();
    h.clock.advance(100);
    h.sched.runDue();
    expect(h.onPasteSpy.texts).toHaveLength(0);
    expect(h.burst.pasting).toBe(false);
  });
});
