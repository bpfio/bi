import { describe, expect, test } from "bun:test";
import {
  DiffRenderer,
  InputLoop,
  cup,
  EL,
  ESC_ALONE_TIMEOUT_MS,
} from "./diff-renderer";
import type { ParsedKey } from "./diff-renderer";
import { FakeClock, ManualScheduler, MemoryWriter, enc, emptyReader } from "../testing";

// ---------------------------------------------------------------------------
// DiffRenderer —— 双缓冲差分渲染
// ---------------------------------------------------------------------------

describe("DiffRenderer —— 最小 ANSI 输出", () => {
  test("合约序列常量：CUP 为 1 基行定位，EL 为行尾清除", () => {
    expect(cup(3)).toBe("\x1b[3;1H");
    expect(EL).toBe("\x1b[K");
  });

  test("首帧只输出非空行：CUP + 内容 + 行尾清除", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 3, 10);
    r.begin().write(0, 0, "abc");
    r.end();
    expect(w.count).toBe(1);
    expect(w.output).toBe(`\x1b[1;1Habc${" ".repeat(7)}${EL}`);
  });

  test("首帧空白行不产生输出（终端基线即空白）", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 4, 10);
    r.begin();
    r.end();
    expect(w.output).toBe("");
  });

  test("CPU 特性断言：两次相同帧，第二帧输出为空字节序列", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 3, 12);
    const t1 = r.begin();
    t1.write(0, 0, "hello");
    t1.write(0, 1, "world");
    r.end();
    const firstFrameCount = w.count;
    const firstOutput = w.output;

    // 全帧重渲：同样内容再画一遍
    const t2 = r.begin();
    t2.write(0, 0, "hello");
    t2.write(0, 1, "world");
    r.end();

    expect(firstFrameCount).toBe(1);
    expect(firstOutput.length).toBeGreaterThan(0);
    expect(w.count).toBe(1); // 第二帧零输出
    expect(w.output).toBe(firstOutput);
  });

  test("仅变更行产生输出，unchanged 行被跳过", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 3, 10);
    const t1 = r.begin();
    t1.write(0, 0, "aaa");
    t1.write(0, 1, "bbb");
    r.end();
    w.clear();

    const t2 = r.begin();
    t2.write(0, 0, "aaa"); // unchanged
    t2.write(0, 1, "zzz"); // changed
    r.end();
    expect(w.output).toBe(`\x1b[2;1Hzzz${" ".repeat(7)}${EL}`);
  });

  test("多行同时变更按行序输出多条 CUP 段", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 3, 10);
    r.begin();
    r.end();
    w.clear();
    const t = r.begin();
    t.write(0, 0, "one");
    t.write(0, 2, "three");
    r.end();
    expect(w.output).toBe(
      `\x1b[1;1Hone${" ".repeat(7)}${EL}\x1b[3;1Hthree${" ".repeat(5)}${EL}`,
    );
  });

  test("erase：内容消失的行输出 CUP + EL（无文本）", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 2, 10);
    const t1 = r.begin();
    t1.write(0, 0, "aaa");
    t1.write(0, 1, "bbb");
    r.end();
    w.clear();

    r.begin().write(0, 0, "aaa"); // row1 清空 → erase
    r.end();
    expect(w.output).toBe(`\x1b[2;1H${EL}`);
  });

  test("begin() 返回草稿缓冲供组件绘制，CJK 宽尾列在行文本中折叠", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 2, 10);
    const term = r.begin();
    term.write(0, 0, "中");
    r.end();
    expect(w.output).toBe(`\x1b[1;1H中${" ".repeat(8)}${EL}`);
  });

  test("resize 后强制全量重绘非空行", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 3, 10);
    r.begin().write(0, 0, "old");
    r.end();
    w.clear();

    r.resize(4, 10);
    const term = r.begin();
    term.write(0, 3, "new");
    r.end();
    expect(w.output).toBe(`\x1b[4;1Hnew${" ".repeat(7)}${EL}`);
  });

  test("行尾部分擦除也走 changed（文本变短）", () => {
    const w = new MemoryWriter();
    const r = new DiffRenderer(w, 1, 10);
    r.begin().write(0, 0, "abcdef");
    r.end();
    w.clear();
    r.begin().write(0, 0, "abc");
    r.end();
    expect(w.output).toBe(`\x1b[1;1Habc${" ".repeat(7)}${EL}`);
  });
});

// ---------------------------------------------------------------------------
// InputLoop —— 按键解析矩阵（离屏 pump 驱动）
// ---------------------------------------------------------------------------

function makeLoop() {
  const clock = new FakeClock();
  const sched = new ManualScheduler();
  const keys: ParsedKey[] = [];
  const loop = new InputLoop(emptyReader(), (k) => keys.push(k), clock, sched);
  return { loop, keys, clock, sched };
}

describe("InputLoop —— 普通键与控制键", () => {
  test("可打印 ASCII 字符逐键回调", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("hi"));
    expect(keys.map((k) => k.kind)).toEqual(["char", "char"]);
    expect(keys[0]!.char).toBe("h");
    expect(keys[1]!.char).toBe("i");
  });

  test("CR 与 LF 均为 enter（首发孤立块不判粘贴）", () => {
    const { loop, keys, clock } = makeLoop();
    loop.pump(enc.encode("\r"));
    clock.advance(200); // 拉开间隔，避免落入粘贴脉冲窗口
    loop.pump(enc.encode("\n"));
    expect(keys.map((k) => k.kind)).toEqual(["enter", "enter"]);
  });

  test("Tab 与 BackSpace（DEL 0x7f）", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\t\x7f"));
    expect(keys.map((k) => k.kind)).toEqual(["tab", "backspace"]);
  });

  test("Ctrl 字母矩阵：^A ^C ^H（0x08 归 ctrl h 而非 backspace）", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\x01\x03\x08"));
    expect(keys).toEqual([
      { kind: "ctrl", char: "a" },
      { kind: "ctrl", char: "c" },
      { kind: "ctrl", char: "h" },
    ]);
  });

  test("其余 C0 控制字节被忽略", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\x00\x1c\x1f"));
    expect(keys).toEqual([]);
  });

  test("UTF-8 多字节字符（CJK）聚为单键", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("中"));
    expect(keys).toEqual([{ kind: "char", char: "中" }]);
  });

  test("UTF-8 多字节序列跨块拆分仍聚为单键", () => {
    const { loop, keys } = makeLoop();
    const full = enc.encode("中");
    loop.pump(full.slice(0, 2));
    loop.pump(full.slice(2));
    expect(keys).toEqual([{ kind: "char", char: "中" }]);
  });
});

describe("InputLoop —— ESC 序列", () => {
  test("方向键矩阵 ESC[A/B/C/D", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\x1b[A\x1b[B\x1b[C\x1b[D"));
    expect(keys.map((k) => k.kind)).toEqual(["up", "down", "right", "left"]);
  });

  test("Home/End（ESC[H、ESC[F）与 ~ 形式（ESC[1~/ESC[4~）", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\x1b[H\x1b[F\x1b[1~\x1b[4~"));
    expect(keys.map((k) => k.kind)).toEqual(["home", "end", "home", "end"]);
  });

  test("PgUp/PgDn（ESC[5~ / ESC[6~）；ESC[3~（Delete）不在合约键集，忽略", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\x1b[5~\x1b[6~\x1b[3~"));
    expect(keys.map((k) => k.kind)).toEqual(["pageup", "pagedown"]);
  });

  test("SS3 形态 ESC O A / ESC O H", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\x1bOA\x1bOH"));
    expect(keys.map((k) => k.kind)).toEqual(["up", "home"]);
  });

  test("ESC 歧义超时：单独到达 30ms 无后续 = ESC 键", () => {
    const { loop, keys, clock, sched } = makeLoop();
    loop.pump(enc.encode("\x1b"));
    expect(keys).toEqual([]);
    clock.advance(ESC_ALONE_TIMEOUT_MS + 1);
    sched.runDue();
    expect(keys).toEqual([{ kind: "esc" }]);
  });

  test("ESC 后 30ms 内续接 [A → 完整解析为 up，不误发 esc", () => {
    const { loop, keys, clock } = makeLoop();
    loop.pump(enc.encode("\x1b"));
    clock.advance(10);
    loop.pump(enc.encode("[A"));
    expect(keys).toEqual([{ kind: "up" }]);
  });

  test("ESC 超时后到达的后续字节：先补发 esc，再按普通键解析", () => {
    const { loop, keys, clock } = makeLoop();
    loop.pump(enc.encode("\x1b"));
    clock.advance(ESC_ALONE_TIMEOUT_MS + 50);
    loop.pump(enc.encode("x"));
    expect(keys).toEqual([
      { kind: "esc" },
      { kind: "char", char: "x" },
    ]);
  });

  test("连续两次 ESC = 两个 esc 键（第二个经 30ms 歧义消解）", () => {
    const { loop, keys, clock, sched } = makeLoop();
    loop.pump(enc.encode("\x1b\x1b"));
    expect(keys).toEqual([{ kind: "esc" }]); // 第一个 ESC 立即结算
    clock.advance(ESC_ALONE_TIMEOUT_MS + 1);
    sched.runDue();
    expect(keys).toEqual([{ kind: "esc" }, { kind: "esc" }]);
  });

  test("ESC + 随机字节：ESC 单独成键，随机字节按普通键处理", () => {
    const { loop, keys } = makeLoop();
    loop.pump(enc.encode("\x1bz"));
    expect(keys).toEqual([{ kind: "esc" }, { kind: "char", char: "z" }]);
  });
});

describe("InputLoop —— PasteBurst 集成", () => {
  test("大块聚合 → 定时静默后回调 paste 键（携带整段文本）", () => {
    const { loop, keys, clock, sched } = makeLoop();
    loop.pump(enc.encode("p".repeat(100)));
    expect(loop.pasting).toBe(true);
    expect(keys).toEqual([]);
    clock.advance(11);
    sched.runDue();
    expect(keys).toEqual([{ kind: "paste", text: "p".repeat(100) }]);
  });

  test("正常逐键节奏不被误判为 paste", () => {
    const { loop, keys, clock } = makeLoop();
    loop.pump(enc.encode("a"));
    clock.advance(200);
    loop.pump(enc.encode("b"));
    clock.advance(200);
    loop.pump(enc.encode("\r"));
    expect(keys.map((k) => k.kind)).toEqual(["char", "char", "enter"]);
  });

  test("stop() 后 pump 不再产生按键", () => {
    const { loop, keys } = makeLoop();
    loop.stop();
    loop.pump(enc.encode("a"));
    expect(keys).toEqual([]);
  });

  test("start() 消费异步 reader 至枯竭并解析按键", async () => {
    const keys: ParsedKey[] = [];
    async function* gen(): AsyncIterable<Uint8Array> {
      yield enc.encode("ok");
      yield enc.encode("\r");
    }
    const loop = new InputLoop(gen(), (k) => keys.push(k));
    loop.start();
    await Bun.sleep(20);
    loop.stop();
    expect(keys.map((k) => k.kind)).toEqual(["char", "char", "enter"]);
  });

  test("start() 真实定时器结算粘贴（端到端）", async () => {
    const keys: ParsedKey[] = [];
    async function* gen(): AsyncIterable<Uint8Array> {
      yield enc.encode("y".repeat(120));
    }
    const loop = new InputLoop(gen(), (k) => keys.push(k));
    loop.start();
    await Bun.sleep(60);
    loop.stop();
    expect(keys).toEqual([{ kind: "paste", text: "y".repeat(120) }]);
  });
});
