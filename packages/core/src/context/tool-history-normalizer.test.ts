/**
 * BI-10.4 · tool-history-normalizer 测试。
 *
 * 覆盖：四类 Fix 各态矩阵、幂等性断言（messages 深相等 + 二遍零修复）、
 * 与 tool-pairing 的 sanitize 组合链（先 normalize 后 pairing 恒安全）、
 * 空历史与干净序列 no-op。
 */
import { describe, expect, test } from "bun:test";
import { pairingBalance, sanitize, type Msg } from "./tool-pairing";
import { normalizeHistory } from "./tool-history-normalizer";

const user = (content = "hi"): Msg => ({ role: "user", content });
const assistant = (content = "thinking"): Msg => ({ role: "assistant", content });
const call = (id: string, toolName = "Bash"): Msg => ({
  role: "assistant",
  toolCallId: id,
  toolName,
  content: "",
});
const result = (id: string, content = "out"): Msg => ({ role: "tool", toolCallId: id, content });
const sys = (content = "sys"): Msg => ({ role: "system", content });

describe("BI-10.4 · ① orphan-system-requeued", () => {
  test("配对中间的悬挂 system：移到最近闭合点（result）之后", () => {
    const r = normalizeHistory([user(), call("a1"), sys("mid"), result("a1"), assistant("done")]);
    expect(r.messages).toEqual([user(), call("a1"), result("a1"), sys("mid"), assistant("done")]);
    expect(r.fixes).toEqual([
      { kind: "orphan-system-requeued", index: 3, detail: expect.stringContaining("悬挂 system") },
    ]);
  });

  test("结尾未闭合 pair 中的 system：② 合成结果后落回原闭合点，不判悬挂", () => {
    // call 与 sys 之间无 result：② 先补合成结果 → sys 落在闭合点 → 原位保留。
    const r = normalizeHistory([user(), call("a1"), sys("mid")]);
    expect(r.messages).toEqual([
      user(),
      call("a1"),
      { role: "tool", toolCallId: "a1", content: "(Tool result missing)" },
      sys("mid"),
    ]);
    expect(r.fixes.map((f) => f.kind)).toEqual(["missing-tool-result-synthesized"]);
  });

  test("头部 system 与闭合点上的 system 原位保留（非悬挂）", () => {
    const msgs = [sys("head"), user(), call("a1"), result("a1"), sys("note"), assistant("ok")];
    const r = normalizeHistory(msgs);
    expect(r.fixes).toEqual([]);
    expect(r.messages).toEqual(msgs);
  });

  test("结尾仍未闭合（合成后依旧 open）时悬挂 system 兜底排到末尾", () => {
    // ① 处理时序列已含合成结果……合成结果闭合了调用，此场景需构造：
    // system 悬挂于 open 期间且之后仍有未闭合调用（openCount 依多重集）。
    const r = normalizeHistory([user(), call("a1"), sys("d"), call("a2"), result("a1")]);
    // a1 闭合后 sys 仍在 a2 未闭合期 → 悬挂 → 排到 a2 的合成结果之后（末尾）。
    expect(r.fixes.some((f) => f.kind === "orphan-system-requeued")).toBe(true);
    expect(r.messages[r.messages.length - 1]).toEqual(sys("d"));
  });
});

describe("BI-10.4 · ② missing-tool-result-synthesized", () => {
  test("尾部未闭合调用：紧随其后合成 tool 结果（同 id，占位文案）", () => {
    const r = normalizeHistory([user(), call("t9"), assistant("later")]);
    expect(r.messages[2]).toEqual({ role: "tool", toolCallId: "t9", content: "(Tool result missing)" });
    expect(r.fixes).toEqual([
      { kind: "missing-tool-result-synthesized", index: 2, detail: expect.stringContaining("t9") },
    ]);
    expect(pairingBalance(r.messages).balanced).toBe(true);
  });

  test("已闭合调用不合成（no-op）", () => {
    const r = normalizeHistory([user(), call("t1"), result("t1", "data")]);
    expect(r.fixes).toEqual([]);
    expect(r.messages).toEqual([user(), call("t1"), result("t1", "data")]);
  });

  test("连续两个未闭合调用：各自紧随合成结果（FIFO 互不干扰）", () => {
    const r = normalizeHistory([call("a"), call("b")]);
    expect(r.messages).toEqual([
      call("a"),
      { role: "tool", toolCallId: "a", content: "(Tool result missing)" },
      call("b"),
      { role: "tool", toolCallId: "b", content: "(Tool result missing)" },
    ]);
    expect(r.fixes.length).toBe(2);
    expect(pairingBalance(r.messages).balanced).toBe(true);
  });

  test("交错：call a、call b、result a → 仅 b 合成，且插在 b 调用之后", () => {
    const r = normalizeHistory([call("a"), call("b"), result("a", "ra")]);
    expect(r.messages).toEqual([
      call("a"),
      call("b"),
      { role: "tool", toolCallId: "b", content: "(Tool result missing)" },
      result("a", "ra"),
    ]);
    expect(r.fixes.length).toBe(1);
  });

  test("偏差形态：未闭合调用后跟普通 assistant 也合成（裁定：一切未闭合调用）", () => {
    const r = normalizeHistory([user(), call("x"), assistant("直接作答")]);
    expect(r.messages[2]).toEqual({ role: "tool", toolCallId: "x", content: "(Tool result missing)" });
    expect(pairingBalance(r.messages).balanced).toBe(true);
  });

  test("同 id 多重调用：结果逐个 FIFO 闭合，缺额才合成", () => {
    const r = normalizeHistory([call("d"), call("d"), result("d"), result("d")]);
    expect(r.fixes).toEqual([]);
    const short = normalizeHistory([call("d"), call("d"), result("d")]);
    expect(short.fixes.length).toBe(1);
    // FIFO：首个 call("d") 被 result 闭合，第二个未闭合 → 合成结果紧随其后。
    expect(short.messages[2]).toEqual({ role: "tool", toolCallId: "d", content: "(Tool result missing)" });
    expect(short.messages[3]).toEqual(result("d"));
    expect(pairingBalance(short.messages).balanced).toBe(true);
  });
});

describe("BI-10.4 · ③ empty-tool-output-filled", () => {
  test("空串输出填充占位，非空输出原样", () => {
    const r = normalizeHistory([user(), call("e1"), result("e1", ""), result("e2", "ok")]);
    expect(r.messages[2]).toEqual({ role: "tool", toolCallId: "e1", content: "(no tool output)" });
    expect(r.messages[3]).toEqual(result("e2", "ok"));
    expect(r.fixes).toEqual([
      { kind: "empty-tool-output-filled", index: 2, detail: expect.stringContaining("(no tool output)") },
    ]);
  });

  test("字面空串语义：空白串不填充（工单钉死字面量）", () => {
    const r = normalizeHistory([user(), call("w1"), result("w1", " ")]);
    expect(r.fixes).toEqual([]);
    expect(r.messages[2]).toEqual(result("w1", " "));
  });

  test("空输出修复与合成结果互不误伤：合成结果的占位文案不再被 ③ 改写", () => {
    const r = normalizeHistory([call("z1")]);
    expect(r.fixes.map((f) => f.kind)).toEqual(["missing-tool-result-synthesized"]);
    expect((r.messages[1] as Msg).content).toBe("(Tool result missing)");
  });
});

describe("BI-10.4 · ④ duplicate-system-merged", () => {
  test("相邻重复 system：保留首条，fix 指向保留位置", () => {
    const r = normalizeHistory([sys("same"), sys("same"), user()]);
    expect(r.messages).toEqual([sys("same"), user()]);
    expect(r.fixes).toEqual([
      { kind: "duplicate-system-merged", index: 0, detail: expect.stringContaining("保留首条") },
    ]);
  });

  test("三条连续重复：级联合并出两条 fix", () => {
    const r = normalizeHistory([sys("s"), sys("s"), sys("s")]);
    expect(r.messages).toEqual([sys("s")]);
    expect(r.fixes.length).toBe(2);
  });

  test("非相邻重复不合并", () => {
    const msgs = [sys("same"), user(), sys("same")];
    const r = normalizeHistory(msgs);
    expect(r.fixes).toEqual([]);
    expect(r.messages).toEqual(msgs);
  });

  test("相邻但内容不同不合并", () => {
    const r = normalizeHistory([sys("a"), sys("b")]);
    expect(r.fixes).toEqual([]);
    expect(r.messages).toEqual([sys("a"), sys("b")]);
  });

  test("对象内容按 JSON 序列化比较：深相等即合并", () => {
    const a: Msg = { role: "system", content: { repo: "bi", depth: 2 } };
    const b: Msg = { role: "system", content: { depth: 2, repo: "bi" } };
    const r = normalizeHistory([a, b]);
    expect(r.fixes.map((f) => f.kind)).toEqual(["duplicate-system-merged"]);
    expect(r.messages).toEqual([a]);
  });
});

describe("BI-10.4 · 幂等性与边界", () => {
  test("幂等：normalize(normalize(x)) 与 normalize(x) messages 深相等且二遍零修复", () => {
    const nasty: Msg[] = [
      sys("head"),
      user(),
      call("u1"),
      sys("dangling"),
      result("u1", ""),
      call("u2"),
      result("ghost"),
      sys("head"),
      user("final"),
    ];
    const once = normalizeHistory(nasty);
    const twice = normalizeHistory(once.messages);
    expect(twice.messages).toEqual(once.messages);
    expect(twice.fixes).toEqual([]);
    expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once.messages));
  });

  test("空历史：messages 与 fixes 双空", () => {
    const r = normalizeHistory([]);
    expect(r.messages).toEqual([]);
    expect(r.fixes).toEqual([]);
  });

  test("干净序列 no-op：内容深相等、零修复", () => {
    const msgs = [sys("head"), user(), call("a1"), result("a1", "ok"), assistant("done")];
    const r = normalizeHistory(msgs);
    expect(r.fixes).toEqual([]);
    expect(r.messages).toEqual(msgs);
  });

  test("不改写入参（新数组，未修复消息共享引用）", () => {
    const msgs = [user(), call("k1"), result("k1", "")];
    const r = normalizeHistory(msgs);
    expect(msgs[2]?.content).toBe(""); // 入参未变
    expect(r.messages[0]).toBe(msgs[0]); // 未修复元素共享引用
    expect(r.messages).not.toBe(msgs); // 但数组是新的
  });
});

describe("BI-10.4 · 与 10.2 组合链：先 normalize 后 pairing 恒安全", () => {
  test("病态混合序列：normalize → sanitize → pairingBalance 全配平", () => {
    const nasty: Msg[] = [
      sys("head"),
      user(),
      call("u1"),
      sys("dangling"), // ①
      result("u1", ""), // ③
      call("u2"), // ② 未闭合
      result("ghost", "orphan"), // 10.2 sanitize 修（无主结果）
      sys("head"), // ④ 与 head 相邻后合并（重排后）
      user("final"),
    ];
    const norm = normalizeHistory(nasty);
    const clean = sanitize(norm.messages);
    expect(pairingBalance(clean.messages).balanced).toBe(true);
  });

  test("纯 normalize 输出：无主结果之外的不变量——无未闭合调用、无空串输出", () => {
    const r = normalizeHistory([call("a"), call("b"), result("a", "")]);
    for (const m of r.messages) {
      if (m.role === "tool") expect(m.content).not.toBe("");
    }
    // 剩余未闭合调用为零：扫描多重集。
    const openById = new Map<string, number>();
    for (const m of r.messages) {
      if (m.role === "assistant" && typeof m.toolCallId === "string") {
        openById.set(m.toolCallId, (openById.get(m.toolCallId) ?? 0) + 1);
      } else if (m.role === "tool") {
        const id = typeof m.toolCallId === "string" ? m.toolCallId : "";
        const rem = openById.get(id) ?? 0;
        if (rem > 0) {
          if (rem === 1) openById.delete(id);
          else openById.set(id, rem - 1);
        }
      }
    }
    let openTotal = 0;
    for (const v of openById.values()) openTotal += v;
    expect(openTotal).toBe(0);
  });

  test("normalize 与 sanitize 分工不重叠：orphan 结果留给 10.2，未闭合调用本卡兜底", () => {
    const r = normalizeHistory([result("ghost", "x")]);
    // 本卡不修无主结果（10.2 职责），fixes 为空、消息原样。
    expect(r.fixes).toEqual([]);
    expect(r.messages).toEqual([result("ghost", "x")]);
    // 但链式过 sanitize 后配平。
    const clean = sanitize(r.messages);
    expect(pairingBalance(clean.messages).balanced).toBe(true);
  });
});
