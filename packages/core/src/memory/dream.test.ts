/**
 * BI-05.1 · Dream Cycle 测试（纯内存，零 IO）。
 *
 * 覆盖：空闲阈值边界（</=/>）、无锁一票否决、锁原子创建与互斥（双进程
 * 先后 acquire 模拟）、stale 接管（含自定义 staleMs 与损坏锁）、release
 * 幂等与再获取、批内去重、对既有文件 append 幂等、锁占用短路不写盘、
 * extractor 注入与异常传播下的 finally 释放锁。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DREAM_IDLE_MS,
  DEFAULT_LOCK_STALE_MS,
  DREAM_FILE_FILENAME,
  DREAM_LOCK_FILENAME,
  acquireDreamLock,
  consolidate,
  evaluateAutoDreamTiming,
} from "./dream";
import { makeMemFs } from "../rules/testing-memfs";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("BI-05.1 evaluateAutoDreamTiming：空闲阈值与锁判定", () => {
  test("空闲低于默认 30 分钟阈值 → 不做梦", () => {
    const decision = evaluateAutoDreamTiming({ idleMs: DEFAULT_DREAM_IDLE_MS - 1, hasLock: true });
    expect(decision.shouldDream).toBe(false);
    expect(decision.reason).toBe("idle-below-threshold");
  });

  test("边界：idleMs 恰好等于阈值 → 做梦", () => {
    const decision = evaluateAutoDreamTiming({ idleMs: DEFAULT_DREAM_IDLE_MS, hasLock: true });
    expect(decision.shouldDream).toBe(true);
    expect(decision.reason).toBe("idle-and-locked");
  });

  test("空闲远超阈值且持锁 → 做梦", () => {
    expect(evaluateAutoDreamTiming({ idleMs: 10 * HOUR, hasLock: true }).shouldDream).toBe(true);
  });

  test("未持锁一票否决：空闲再久也不做梦", () => {
    const decision = evaluateAutoDreamTiming({ idleMs: 24 * HOUR, hasLock: false });
    expect(decision.shouldDream).toBe(false);
    expect(decision.reason).toBe("no-lock");
  });

  test("自定义阈值生效", () => {
    const idle = 5 * MIN;
    expect(evaluateAutoDreamTiming({ idleMs: idle, hasLock: true }, { idleThresholdMs: 10 * MIN }).shouldDream).toBe(false);
    expect(evaluateAutoDreamTiming({ idleMs: idle, hasLock: true }, { idleThresholdMs: idle }).shouldDream).toBe(true);
  });
});

describe("BI-05.1 acquireDreamLock：原子锁与 stale 接管", () => {
  test("新目录原子创建：写入 { pid, ts } JSON", () => {
    const fs = makeMemFs();
    const now = 1_000_000;
    const lock = acquireDreamLock("/proj", { fs, now, pid: 4242 });
    expect(lock).not.toBeNull();
    expect(lock?.path).toBe(`/proj/${DREAM_LOCK_FILENAME}`);
    const content = JSON.parse(fs.peek("/proj/.consolidate-lock") ?? "") as { pid: number; ts: number };
    expect(content).toEqual({ pid: 4242, ts: now });
    lock?.release();
  });

  test("互斥：他人持锁未过期 → 第二次 acquire 返回 null（双进程先后语义）", () => {
    const fs = makeMemFs();
    const first = acquireDreamLock("/proj", { fs, now: 1_000, pid: 111 });
    expect(first).not.toBeNull();
    const second = acquireDreamLock("/proj", { fs, now: 2_000, pid: 222 });
    expect(second).toBeNull();
    first?.release();
  });

  test("stale 接管：锁 ts 超过默认 1 小时可被接管且内容更新", () => {
    const fs = makeMemFs();
    const old = acquireDreamLock("/proj", { fs, now: 1_000, pid: 111 });
    expect(old).not.toBeNull();
    const takeover = acquireDreamLock("/proj", { fs, now: 1_000 + DEFAULT_LOCK_STALE_MS + 1, pid: 222 });
    expect(takeover).not.toBeNull();
    const content = JSON.parse(fs.peek("/proj/.consolidate-lock") ?? "") as { pid: number; ts: number };
    expect(content.pid).toBe(222);
    expect(content.ts).toBe(1_000 + DEFAULT_LOCK_STALE_MS + 1);
  });

  test("stale 边界：恰好等于 staleMs 仍不可接管（须严格超过）", () => {
    const fs = makeMemFs();
    acquireDreamLock("/proj", { fs, now: 1_000, pid: 111 });
    expect(acquireDreamLock("/proj", { fs, now: 1_000 + DEFAULT_LOCK_STALE_MS, pid: 222 })).toBeNull();
  });

  test("自定义 staleMs：小窗口可接管", () => {
    const fs = makeMemFs();
    acquireDreamLock("/proj", { fs, now: 1_000, pid: 111 });
    const takeover = acquireDreamLock("/proj", { fs, now: 1_500, pid: 222, staleMs: 300 });
    expect(takeover).not.toBeNull();
    takeover?.release();
  });

  test("锁内容损坏（不可解析）→ 视为 stale 接管", () => {
    const fs = makeMemFs({ files: { "/proj/.consolidate-lock": "not-a-json" } });
    const takeover = acquireDreamLock("/proj", { fs, now: 5_000, pid: 333 });
    expect(takeover).not.toBeNull();
    expect(JSON.parse(fs.peek("/proj/.consolidate-lock") ?? "{}")).toEqual({ pid: 333, ts: 5_000 });
    takeover?.release();
  });

  test("release 幂等：释放后他人可立即获取", () => {
    const fs = makeMemFs();
    const first = acquireDreamLock("/proj", { fs, now: 1_000, pid: 111 });
    first?.release();
    first?.release(); // 二次释放不抛错
    expect(fs.existsSync("/proj/.consolidate-lock")).toBe(false);
    const next = acquireDreamLock("/proj", { fs, now: 1_100, pid: 222 });
    expect(next).not.toBeNull();
    next?.release();
  });
});

describe("BI-05.1 consolidate：去重合并与 append-only 沉淀", () => {
  test("基本追加：写入 BI.dream.md，含 dream 头与条目，added 计数", () => {
    const fs = makeMemFs();
    const result = consolidate(["精炼结论 A", "精炼结论 B"], { dir: "/proj", fs, now: 2_000 });
    expect(result).toEqual({ ok: true, added: 2, duplicates: 0 });
    const content = fs.peek(`/proj/${DREAM_FILE_FILENAME}`) ?? "";
    expect(content).toContain("## dream @ ");
    expect(content).toContain("- 精炼结论 A");
    expect(content).toContain("- 精炼结论 B");
    expect(content.endsWith("\n")).toBe(true);
  });

  test("批内去重：重复段只落一次", () => {
    const fs = makeMemFs();
    const result = consolidate(["结论 X", "结论 X", "  结论 X  "], { dir: "/proj", fs, now: 1 });
    expect(result).toEqual({ ok: true, added: 1, duplicates: 2 });
  });

  test("append 幂等：对既有文件重跑同输入 → added 0 且文件字节不变", () => {
    const fs = makeMemFs();
    consolidate(["结论 X", "结论 Y"], { dir: "/proj", fs, now: 1_000 });
    const before = fs.peek("/proj/BI.dream.md");
    const mtimeBefore = fs.mtimeOf("/proj/BI.dream.md");
    const second = consolidate(["结论 Y", "结论 X"], { dir: "/proj", fs, now: 2_000 });
    expect(second).toEqual({ ok: true, added: 0, duplicates: 2 });
    expect(fs.peek("/proj/BI.dream.md")).toBe(before);
    expect(fs.mtimeOf("/proj/BI.dream.md")).toBe(mtimeBefore); // 无新增不写盘
  });

  test("连续多次沉淀：段落间以空行分隔且追加不破坏既有内容", () => {
    const fs = makeMemFs();
    consolidate(["第一轮结论"], { dir: "/proj", fs, now: 1_000 });
    consolidate(["第二轮结论"], { dir: "/proj", fs, now: 2_000 });
    const content = fs.peek("/proj/BI.dream.md") ?? "";
    expect(content).toContain("第一轮结论");
    expect(content).toContain("第二轮结论");
    expect(content).toMatch(/第一轮结论\n\n## dream @ /);
  });

  test("锁被他人持有 → 短路 { ok:false, reason:'locked' } 且不写盘", () => {
    const fs = makeMemFs();
    const held = acquireDreamLock("/proj", { fs, now: 1_000, pid: 111 });
    expect(held).not.toBeNull();
    const result = consolidate(["结论 Z"], { dir: "/proj", fs, now: 2_000 });
    expect(result).toEqual({ ok: false, reason: "locked" });
    expect(fs.existsSync("/proj/BI.dream.md")).toBe(false);
    held?.release();
  });

  test("extractor 注入：对象映射精华串，null/undefined 跳过", () => {
    const fs = makeMemFs();
    const sessions = [
      { id: 1, essence: "精华一" },
      { id: 2, essence: null },
      { id: 3, essence: "精华三" },
    ];
    const result = consolidate(sessions, {
      dir: "/proj",
      fs,
      now: 1,
      extractor: (s) => s.essence,
    });
    expect(result).toEqual({ ok: true, added: 2, duplicates: 0 });
    const content = fs.peek("/proj/BI.dream.md") ?? "";
    expect(content).toContain("- 精华一");
    expect(content).toContain("- 精华三");
    expect(content).not.toContain("精华二");
  });

  test("空输入 / 全空段：ok 但不写盘", () => {
    const fs = makeMemFs();
    expect(consolidate([], { dir: "/proj", fs, now: 1 })).toEqual({ ok: true, added: 0, duplicates: 0 });
    expect(consolidate(["", "   "], { dir: "/proj", fs, now: 1 })).toEqual({ ok: true, added: 0, duplicates: 0 });
    expect(fs.existsSync("/proj/BI.dream.md")).toBe(false);
  });

  test("extractor 抛异常 → 异常冒泡且锁已释放（finally 语义）", () => {
    const fs = makeMemFs();
    expect(() =>
      consolidate(["a"], {
        dir: "/proj",
        fs,
        now: 1,
        extractor: () => {
          throw new Error("extractor boom");
        },
      }),
    ).toThrow("extractor boom");
    expect(fs.existsSync("/proj/.consolidate-lock")).toBe(false);
    // 锁已释放：后续沉淀可正常持锁
    expect(consolidate(["恢复后结论"], { dir: "/proj", fs, now: 2 })).toEqual({
      ok: true,
      added: 1,
      duplicates: 0,
    });
  });

  test("成功完成后锁释放：可再次 acquire", () => {
    const fs = makeMemFs();
    consolidate(["结论"], { dir: "/proj", fs, now: 1 });
    expect(fs.existsSync("/proj/.consolidate-lock")).toBe(false);
    expect(acquireDreamLock("/proj", { fs, now: 2, pid: 7 })).not.toBeNull();
  });
});
