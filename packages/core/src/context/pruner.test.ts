/**
 * BI-09 · dehydrateOldToolResults 测试。
 *
 * 覆盖：N 轮边界（user 计轮）、多轮历史脱水、assistant 决策文本永不脱水、
 * 摘要格式与字节统计、toolName 回退链、配对关系不破坏、空历史。
 */
import { describe, expect, test } from "bun:test";
import { dehydrateOldToolResults, DEFAULT_KEEP_TURNS } from "./pruner";
import { pairingBalance, type Msg } from "./tool-pairing";

const user = (content = "u"): Msg => ({ role: "user", content });
const assistant = (content: string): Msg => ({ role: "assistant", content });
const call = (id: string, toolName: string): Msg => ({
  role: "assistant",
  toolCallId: id,
  toolName,
  content: "",
});
const result = (id: string, content: unknown, toolName?: string): Msg => {
  const m: Msg = { role: "tool", toolCallId: id, content };
  if (toolName !== undefined) m.toolName = toolName;
  return m;
};
const sys = (content = "s"): Msg => ({ role: "system", content });

/** 构造 6 个完整轮次，第 turn 轮（1 基）的结果内容可定制。 */
function sixTurns(firstResultContent = "old data\nline2"): Msg[] {
  const msgs: Msg[] = [];
  for (let t = 1; t <= 6; t++) {
    msgs.push(user(`turn ${t}`));
    msgs.push(call(`c${t}`, "Read"));
    msgs.push(result(`c${t}`, t === 1 ? firstResultContent : `fresh ${t}`));
    msgs.push(assistant(`decision ${t}`));
  }
  return msgs;
}

describe("BI-09 历史脱水 · 轮次边界", () => {
  test("默认 keepRecentTurns = 5（常量钉死）", () => {
    expect(DEFAULT_KEEP_TURNS).toBe(5);
  });

  test("恰好 5 轮历史：全部在窗口内，原样返回", () => {
    const msgs = sixTurns().slice(4); // 弃掉第 1 轮 → 剩 5 轮
    const r = dehydrateOldToolResults(msgs);
    expect(r.prunedCount).toBe(0);
    expect(r.savedBytes).toBe(0);
    expect(r.messages).toEqual(msgs);
  });

  test("6 轮历史：仅第 1 轮的 tool 结果脱水，近 5 轮原文保留", () => {
    const msgs = sixTurns("old data\nline2");
    const r = dehydrateOldToolResults(msgs);
    expect(r.prunedCount).toBe(1);
    // 第 1 轮结果（index 2）已替换为单行摘要。
    const pruned = r.messages[2] as Msg;
    expect(pruned.role).toBe("tool");
    expect(typeof pruned.content).toBe("string");
    expect(String(pruned.content)).toMatch(/^\[pruned: Read old data \(14B\)\]$/);
    // 第 2 轮起的结果原文保留。
    expect(r.messages[6]).toEqual(result("c2", "fresh 2"));
    // 轮内消息总数不变（只替换 content，不删消息）。
    expect(r.messages.length).toBe(msgs.length);
  });

  test("窗口起点 = 倒数第 N 个 user 消息，边界消息原文保留", () => {
    const msgs = sixTurns();
    const r = dehydrateOldToolResults(msgs, { keepRecentTurns: 2 });
    // 窗口起点 = 第 5 个 user（index 16）；之前 4 轮各 1 条结果脱水。
    expect(r.prunedCount).toBe(4);
    expect(r.messages[18]).toEqual(result("c5", "fresh 5")); // 第 5 轮原文
    expect(r.messages[14] as Msg).toMatchObject({ role: "tool" }); // 第 4 轮已脱水
    expect(String((r.messages[14] as Msg).content)).toMatch(/^\[pruned: /);
  });

  test("keepRecentTurns = 0：所有 tool 结果全部脱水", () => {
    const msgs = sixTurns();
    const r = dehydrateOldToolResults(msgs, { keepRecentTurns: 0 });
    expect(r.prunedCount).toBe(6);
  });

  test("空历史：空转", () => {
    const r = dehydrateOldToolResults([]);
    expect(r).toEqual({ messages: [], prunedCount: 0, savedBytes: 0 });
  });

  test("非法 keepRecentTurns（负数/非整数）抛 RangeError", () => {
    expect(() => dehydrateOldToolResults([], { keepRecentTurns: -1 })).toThrow(RangeError);
    expect(() => dehydrateOldToolResults([], { keepRecentTurns: 1.5 })).toThrow(RangeError);
  });
});

describe("BI-09 历史脱水 · 永不脱水与原样保留", () => {
  test("assistant 决策文本永不脱水（含最老轮次）", () => {
    const msgs = sixTurns();
    const r = dehydrateOldToolResults(msgs, { keepRecentTurns: 1 });
    expect(r.messages[3]).toEqual(assistant("decision 1"));
    expect(r.messages[7]).toEqual(assistant("decision 2"));
  });

  test("user 与 system 消息原样保留", () => {
    const msgs: Msg[] = [
      sys("head"),
      user("turn 1"),
      call("c1", "Bash"),
      result("c1", "x".repeat(200)),
      user("turn 2"),
      call("c2", "Bash"),
      result("c2", "y".repeat(200)),
    ];
    const r = dehydrateOldToolResults(msgs, { keepRecentTurns: 1 });
    expect(r.messages[0]).toEqual(sys("head"));
    expect(r.messages[1]).toEqual(user("turn 1"));
    expect(r.messages[4]).toEqual(user("turn 2"));
    expect(r.prunedCount).toBe(1);
  });
});

describe("BI-09 历史脱水 · 摘要格式与统计", () => {
  test("多行内容取首行；首行 > 80 码点截断并追加 ...", () => {
    const text = `${"g".repeat(100)}\nsecond line`;
    const r = dehydrateOldToolResults(
      [user(), call("c1", "Bash"), result("c1", text), user(), call("c2", "Bash"), result("c2", "ok"), user()],
      { keepRecentTurns: 1 },
    );
    const marker = String((r.messages[2] as Msg).content);
    expect(marker).toBe(`[pruned: Bash ${"g".repeat(80)}... (112B)]`);
  });

  test("首行 ≤ 80 码点：不追加 ...", () => {
    const r = dehydrateOldToolResults(
      [user(), call("c1", "Bash"), result("c1", "short output\nmore"), user(), call("c2", "Bash"), result("c2", "ok"), user()],
      { keepRecentTurns: 1 },
    );
    expect((r.messages[2] as Msg).content).toBe("[pruned: Bash short output (17B)]");
  });

  test("savedBytes = Σ(原文字节 − 摘要字节)，含 UTF-8 多字节", () => {
    const text = "状态输出\n第二行"; // 中文 3 字节/字，22 字节
    const r = dehydrateOldToolResults(
      [
        user(),
        call("c1", "Bash"),
        result("c1", text),
        user(),
        call("c2", "Bash"),
        result("c2", "ok"),
        user(),
        call("c3", "Bash"),
        result("c3", "ok"),
      ],
      { keepRecentTurns: 2 }, // 3 个 user，窗口从第 2 个 user 起 → 仅 c1 陈旧
    );
    const marker = String((r.messages[2] as Msg).content);
    expect(marker).toBe("[pruned: Bash 状态输出 (22B)]");
    expect(r.prunedCount).toBe(1);
    // 裁定：标记比微小原文更长时 savedBytes 允许为负（工单字面语义：老旧
    // 一律换标记，不做"亏本跳过"；真实工具输出为 KB 级，正常恒为正）。
    expect(r.savedBytes).toBe(22 - Buffer.byteLength(marker, "utf8"));
    expect(r.savedBytes).toBeLessThan(0);
  });

  test("大体量原文：savedBytes 显著为正", () => {
    // 2 个 user、keepRecentTurns=1 → 窗口从最后一个 user 起，仅 c1 陈旧。
    const r = dehydrateOldToolResults(
      [user(), call("c1", "Bash"), result("c1", "x".repeat(5000)), user()],
      { keepRecentTurns: 1 },
    );
    expect(r.prunedCount).toBe(1);
    expect(r.savedBytes).toBe(5000 - Buffer.byteLength(`[pruned: Bash ${"x".repeat(80)}... (5000B)]`, "utf8"));
    expect(r.savedBytes).toBeGreaterThan(4500);
  });

  test("toolName 回退链：消息字段优先 → 配对调用名 → 'tool'", () => {
    const base: Msg[] = [
      user(),
      call("cA", "Grep"),
      result("cA", "aaa", "Override"), // 自带 toolName：优先
      call("cB", "Read"),
      result("cB", "bbb"), // 无自带：回退调用名
      result("ghost", "ccc"), // 无配对无字段：'tool'
      user(),
      call("c2", "Bash"),
      result("c2", "ok"),
      user(),
    ];
    const r = dehydrateOldToolResults(base, { keepRecentTurns: 1 });
    expect((r.messages[2] as Msg).content).toBe("[pruned: Override aaa (3B)]");
    expect((r.messages[4] as Msg).content).toBe("[pruned: Read bbb (3B)]");
    expect((r.messages[5] as Msg).content).toBe("[pruned: tool ccc (3B)]");
  });

  test("非字符串 content：JSON 序列化后取首行与字节", () => {
    const r = dehydrateOldToolResults(
      [user(), call("c1", "Json"), result("c1", { out: "a" }), user(), call("c2", "Bash"), result("c2", "ok"), user()],
      { keepRecentTurns: 1 },
    );
    expect((r.messages[2] as Msg).content).toBe('[pruned: Json {"out":"a"} (11B)]');
  });

  test("首行 80 码点边界落在 emoji 上：代理对不截半", () => {
    const firstLine = `${"e".repeat(79)}😀😀`; // 81 码点
    const r = dehydrateOldToolResults(
      [user(), call("c1", "Emoji"), result("c1", firstLine), user(), call("c2", "Bash"), result("c2", "ok"), user()],
      { keepRecentTurns: 1 },
    );
    const marker = String((r.messages[2] as Msg).content);
    // 头 80 码点 = 79 个 e + 第一个 😀（整对）。
    expect(marker).toBe(`[pruned: Emoji ${"e".repeat(79)}😀... (87B)]`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(marker)).toBe(false);
  });
});

describe("BI-09 历史脱水 · 结构不变量", () => {
  test("脱水只换 content：配对关系保持配平", () => {
    const msgs = sixTurns();
    const r = dehydrateOldToolResults(msgs, { keepRecentTurns: 2 });
    expect(pairingBalance(r.messages).balanced).toBe(true);
  });

  test("多轮多工具：全部老旧结果逐条脱水，计数与留痕一致", () => {
    const msgs: Msg[] = [
      user("t1"),
      call("c1", "A"),
      result("c1", "aaaa"),
      call("c2", "B"),
      result("c2", "bbbb"),
      assistant("decide"),
      user("t2"),
      call("c3", "C"),
      result("c3", "cccc"),
    ];
    const r = dehydrateOldToolResults(msgs, { keepRecentTurns: 1 });
    expect(r.prunedCount).toBe(2);
    expect((r.messages[2] as Msg).content).toBe("[pruned: A aaaa (4B)]");
    expect((r.messages[4] as Msg).content).toBe("[pruned: B bbbb (4B)]");
    expect(r.messages[8]).toEqual(result("c3", "cccc"));
  });
});
