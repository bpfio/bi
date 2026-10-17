/**
 * BI-10 · AutoCompactor 测试。
 *
 * 覆盖：静默路径（水位未超 → null）、摘要 stub 回注、新序列组装形状
 * （system 头 + 占位 + 保留轮次）、病态配对自动扩窗（BI-10.2 门禁协作）、
 * CompactionEntry 字段提取（tokensBefore/prunedFiles）、summarizer 抛错
 * 结构化失败不炸、3 击熔断后第 4 次尝试抛结构化告警。
 */
import { describe, expect, test } from "bun:test";
import { AutoCompactor, CompactionCircuitOpenError, extractTouchedFiles, type AutoCompactorDeps, type Summarizer } from "./compactor";
import { pairingBalance, type Msg } from "./tool-pairing";
import { WindowManager } from "./window-manager";

const u = (c = "u"): Msg => ({ role: "user", content: c });
const a = (c = "a"): Msg => ({ role: "assistant", content: c });
const call = (id: string, toolName: string, content: unknown = ""): Msg => ({
  role: "assistant",
  toolCallId: id,
  toolName,
  content,
});
const res = (id: string, content: unknown): Msg => ({ role: "tool", toolCallId: id, content });
const sys = (c = "head"): Msg => ({ role: "system", content: c });

/** 水位 0.813（超）与 0.787（未超）的用量注入（100K 视窗 → 有效 75K）。 */
const ABOVE = [61_000, 100_000] as const;
const BELOW = [59_000, 100_000] as const;

interface Harness {
  ac: AutoCompactor;
  wm: WindowManager;
  calls: () => number;
  lastInput: () => Msg[];
}

function makeHarness(overrides?: Partial<AutoCompactorDeps>, summarizer?: Summarizer): Harness {
  const wm = overrides?.window ?? new WindowManager();
  let n = 0;
  let input: Msg[] = [];
  const stub: Summarizer = summarizer ?? (async (msgs: Msg[]) => {
    n++;
    input = msgs;
    return `SUM(${msgs.length})`;
  });
  const ac = new AutoCompactor({ summarizer: stub, window: wm, ...overrides });
  return { ac, wm, calls: () => n, lastInput: () => input };
}

/** 10 条消息、3 个 user 轮、两对完整工具配对（Read + Edit），头部 system。 */
function sampleMessages(): Msg[] {
  return [
    sys("head"),
    u("turn 1"),
    call("c1", "Read", { file_path: "/src/a.ts" }),
    res("c1", "read /src/a.ts ok"),
    a("decision 1"),
    u("turn 2"),
    call("c2", "Edit", { file_path: "/src/b.ts" }),
    res("c2", "edited /src/b.ts ok"),
    a("decision 2"),
    u("turn 3"),
  ];
}

describe("BI-10 AutoCompactor · 静默与触发", () => {
  test("水位未超 → null，summarizer 零调用", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...BELOW);
    expect(await h.ac.maybeCompact(sampleMessages())).toBeNull();
    expect(h.calls()).toBe(0);
  });

  test("水位超 → summarizer 恰好一次，输入为切点前会话（剥 system 头）", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    const r = await h.ac.maybeCompact(sampleMessages());
    expect(r).not.toBeNull();
    expect(h.calls()).toBe(1);
    // 切点 = 倒数第 2 个 user（index 5）；older 会话部分 = index 1..4。
    expect(h.lastInput()).toEqual([
      u("turn 1"),
      call("c1", "Read", { file_path: "/src/a.ts" }),
      res("c1", "read /src/a.ts ok"),
      a("decision 1"),
    ]);
  });

  test("user 轮数不足 keepRecentTurns → null（无历史可摘要，裁定）", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    expect(await h.ac.maybeCompact([u("only"), a("x")])).toBeNull();
    expect(h.calls()).toBe(0);
  });

  test("preferred = 0（保留窗已覆盖全历史）→ null（裁定）", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    expect(await h.ac.maybeCompact([u("t1"), a("x"), u("t2")])).toBeNull();
    expect(h.calls()).toBe(0);
  });

  test("findSafeCut 扩窗到 0（头部病态配平不可行）→ null（裁定）", async () => {
    const h = makeHarness({ keepRecentTurns: 1 });
    h.wm.updateUsage(...ABOVE);
    // 序列以孤立调用开头：任何非零切点前缀都含未闭合调用 → 只能切 0。
    expect(await h.ac.maybeCompact([call("X", "Bash"), u("t1")])).toBeNull();
    expect(h.calls()).toBe(0);
  });
});

describe("BI-10 AutoCompactor · 组装与 CompactionEntry", () => {
  test("新序列 = [system 头] + 占位 + 保留轮次；占位携带摘要", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    const r = await h.ac.maybeCompact(sampleMessages());
    expect(r).not.toBeNull();
    const messages = (r as { messages: Msg[] }).messages;
    expect(messages[0]).toEqual(sys("head"));
    expect(messages[1]).toEqual({ role: "user", content: "[compacted] SUM(4)" });
    // 保留轮次：倒数第 2 个 user 起的 5 条逐字保留。
    const kept = messages.slice(2);
    expect(kept).toEqual([
      u("turn 2"),
      call("c2", "Edit", { file_path: "/src/b.ts" }),
      res("c2", "edited /src/b.ts ok"),
      a("decision 2"),
      u("turn 3"),
    ]);
  });

  test("entry 字段：summary 回注、tokensBefore 取用量读数、keptMessages 与序列一致", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    const r = await h.ac.maybeCompact(sampleMessages());
    const entry = (r as { entry: { summary: string; tokensBefore: number; keptMessages: Msg[] } }).entry;
    expect(entry.summary).toBe("SUM(4)");
    expect(entry.tokensBefore).toBe(61_000);
    expect(entry.keptMessages).toEqual([
      u("turn 2"),
      call("c2", "Edit", { file_path: "/src/b.ts" }),
      res("c2", "edited /src/b.ts ok"),
      a("decision 2"),
      u("turn 3"),
    ]);
  });

  test("prunedFiles 提取：写入类工具名归 modified，其余归 read，同桶去重", async () => {
    const h = makeHarness({ keepRecentTurns: 1 });
    h.wm.updateUsage(...ABOVE);
    // Read 与 Edit 都在前两轮（older 区），第 3 轮保留。
    const msgs: Msg[] = [
      sys("head"),
      u("turn 1"),
      call("c1", "Read", { file_path: "/src/a.ts" }),
      res("c1", "read /src/a.ts ok"),
      u("turn 2"),
      call("c2", "Edit", { file_path: "/src/b.ts" }),
      res("c2", "edited /src/b.ts ok"),
      u("turn 3"),
    ];
    const r = await h.ac.maybeCompact(msgs);
    const entry = (r as { entry: { prunedFiles: { readFiles: string[]; modifiedFiles: string[] } } }).entry;
    expect(entry.prunedFiles.readFiles).toEqual(["/src/a.ts"]);
    expect(entry.prunedFiles.modifiedFiles).toEqual(["/src/b.ts"]);
  });

  test("extractTouchedFiles 直测：字符串内容路径正则 + 工具名回退配对调用", () => {
    const msgs: Msg[] = [
      u("please fix /tmp/log/alpha.txt"),
      call("w1", "Write", { path: "/etc/conf.d/main.conf" }),
      res("w1", "wrote /etc/conf.d/main.conf (bytes)"),
      res("g1", "found in /var/data/beta.csv"),
    ];
    const t = extractTouchedFiles(msgs);
    // user 消息的路径无写入上下文 → read；Write 工具（结果回退调用名）→ modified。
    expect(t.readFiles).toEqual(["/tmp/log/alpha.txt", "/var/data/beta.csv"]);
    expect(t.modifiedFiles).toEqual(["/etc/conf.d/main.conf"]);
  });

  test("紧缩后序列整体配平（结构不变量）", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    const r = await h.ac.maybeCompact(sampleMessages());
    expect(pairingBalance((r as { messages: Msg[] }).messages).balanced).toBe(true);
  });

  test("默认 keepRecentTurns = 2（构造缺省行为）", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    const r = await h.ac.maybeCompact(sampleMessages());
    expect(h.ac.keepRecentTurns).toBe(2);
    expect((r as { entry: { keptMessages: Msg[] } }).entry.keptMessages.length).toBe(5);
  });
});

describe("BI-10 AutoCompactor · 病态配对自动扩窗", () => {
  test("切点落在未闭合对中间：BI-10.2 门禁扩窗到最近安全切点", async () => {
    const h = makeHarness({ keepRecentTurns: 2 });
    h.wm.updateUsage(...ABOVE);
    // preferred = index 2（倒数第 2 个 user），但前缀 [u1, callA] 含未闭合
    // 调用 → findSafeCut 扩窗到 1（kept 从 callA 起，A 的结果仍在保留区）。
    const msgs: Msg[] = [
      u("t1"),
      call("A", "Bash"),
      u("t2"),
      res("A", "out"),
      u("t3"),
      call("B", "Bash"),
      res("B", "out2"),
    ];
    const r = await h.ac.maybeCompact(msgs);
    expect(r).not.toBeNull();
    const { messages, entry } = r as { messages: Msg[]; entry: { keptMessages: Msg[] } };
    expect(messages).toEqual([
      { role: "user", content: "[compacted] SUM(1)" },
      call("A", "Bash"),
      u("t2"),
      res("A", "out"),
      u("t3"),
      call("B", "Bash"),
      res("B", "out2"),
    ]);
    expect(entry.keptMessages[0]).toEqual(call("A", "Bash"));
  });
});

describe("BI-10 AutoCompactor · 结构化失败与熔断", () => {
  test("summarizer 抛错 → null + lastFailure 留痕，熔断器不计数，可重试", async () => {
    const h = makeHarness(undefined, async () => {
      throw new Error("boom");
    });
    h.wm.updateUsage(...ABOVE);
    expect(await h.ac.maybeCompact(sampleMessages())).toBeNull();
    expect(h.ac.lastFailure).toEqual({ code: "BI-COMPACTION-SUMMARIZER-FAILED", message: "boom" });
    expect(h.wm.strikes()).toBe(0);
    // 失败留痕只在"当次尝试"存续：水位回落后的静默路径会清空 lastFailure。
    h.wm.updateUsage(...BELOW);
    expect(await h.ac.maybeCompact(sampleMessages())).toBeNull();
    expect(h.ac.lastFailure).toBeNull();
  });

  test("3 击熔断后第 4 次尝试 → CompactionCircuitOpenError（结构化告警）", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    for (let i = 0; i < 3; i++) {
      const r = await h.ac.maybeCompact(sampleMessages());
      expect(r).not.toBeNull();
      h.wm.updateUsage(...ABOVE); // 紧缩无效：水位仍超（连击保留）
    }
    expect(h.wm.isTripped()).toBe(true);
    let err: unknown;
    try {
      await h.ac.maybeCompact(sampleMessages());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CompactionCircuitOpenError);
    const ce = err as CompactionCircuitOpenError;
    expect(ce.code).toBe("BI-COMPACTION-CIRCUIT-OPEN");
    expect(ce.strikes).toBe(3);
  });

  test("水位回落至复位后熔断不自动解除：需显式 reset（裁定）", async () => {
    const h = makeHarness();
    h.wm.updateUsage(...ABOVE);
    for (let i = 0; i < 3; i++) {
      await h.ac.maybeCompact(sampleMessages());
      h.wm.updateUsage(...ABOVE);
    }
    expect(h.wm.isTripped()).toBe(true);
    h.wm.updateUsage(20_000, 100_000); // 回落 0.35 以下
    expect(h.wm.isTripped()).toBe(true); // 熔断保持
    let threw = false;
    try {
      await h.ac.maybeCompact(sampleMessages());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    h.wm.reset(); // 显式复位是唯一解除途径
    h.wm.updateUsage(...ABOVE);
    const r = await h.ac.maybeCompact(sampleMessages());
    expect(r).not.toBeNull(); // 复位后紧缩能力恢复
  });
});
