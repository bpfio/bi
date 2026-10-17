/**
 * BI-10.2 · tool-pairing 测试。
 *
 * 覆盖：配对矩阵（正常/无主结果/未闭合调用/交错/多重同 id）、
 * isCutSafe 与 findSafeCut 各态、sanitize 三修整、空历史边界。
 */
import { describe, expect, test } from "bun:test";
import {
  findSafeCut,
  isCutSafe,
  pairingBalance,
  sanitize,
  type Msg,
} from "./tool-pairing";

const user = (content = "hi"): Msg => ({ role: "user", content });
const assistant = (content = "thinking"): Msg => ({ role: "assistant", content });
/** assistant tool_use：携带 toolCallId 即视为一次调用。 */
const call = (id: string, toolName = "Bash"): Msg => ({
  role: "assistant",
  toolCallId: id,
  toolName,
  content: "",
});
const result = (id: string, content = "out"): Msg => ({ role: "tool", toolCallId: id, content });
const sys = (content = "sys"): Msg => ({ role: "system", content });

describe("BI-10.2 配对矩阵 · pairingBalance", () => {
  test("正常一对：call→result 配平", () => {
    const r = pairingBalance([user(), call("a1"), result("a1"), assistant("done")]);
    expect(r.balanced).toBe(true);
    expect(r.final).toEqual({ index: 4, open: 0, orphan: 0 });
  });

  test("无主结果：orphan 计 1，不配平", () => {
    const r = pairingBalance([user(), result("ghost"), assistant("x")]);
    expect(r.balanced).toBe(false);
    expect(r.final.open).toBe(0);
    expect(r.final.orphan).toBe(1);
  });

  test("未闭合调用：open 计 1，不配平", () => {
    const r = pairingBalance([user(), call("a1"), assistant("x")]);
    expect(r.balanced).toBe(false);
    expect(r.final.open).toBe(1);
    expect(r.final.orphan).toBe(0);
  });

  test("交错配对：A 调 B 调 A 应 B 应，各前缀计数精确", () => {
    const r = pairingBalance([call("A"), call("B"), result("A"), result("B")]);
    expect(r.balanced).toBe(true);
    expect(r.prefixes[1]).toEqual({ index: 1, open: 1, orphan: 0 });
    expect(r.prefixes[2]).toEqual({ index: 2, open: 2, orphan: 0 });
    expect(r.prefixes[3]).toEqual({ index: 3, open: 1, orphan: 0 });
    expect(r.prefixes[4]).toEqual({ index: 4, open: 0, orphan: 0 });
  });

  test("结果先于调用：orphan 与 open 同时在册", () => {
    const r = pairingBalance([result("X"), call("X")]);
    expect(r.final).toEqual({ index: 2, open: 1, orphan: 1 });
  });

  test("prefixes 覆盖 0..n 共 n+1 条且 index 连续", () => {
    const msgs = [user(), call("a"), result("a"), user()];
    const r = pairingBalance(msgs);
    expect(r.prefixes.length).toBe(msgs.length + 1);
    expect(r.prefixes.map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
    expect(r.prefixes[0]).toEqual({ index: 0, open: 0, orphan: 0 });
  });

  test("缺失 toolCallId 的 tool 消息计 orphan（裁定）", () => {
    const r = pairingBalance([user(), { role: "tool", content: "no id" }]);
    expect(r.final.orphan).toBe(1);
  });

  test("user/system/普通 assistant 消息不影响计数", () => {
    const r = pairingBalance([sys(), user(), assistant("plain"), user()]);
    expect(r.balanced).toBe(true);
  });

  test("同 id 多重调用按多重集逐个闭合", () => {
    const r = pairingBalance([call("d"), call("d"), result("d"), result("d")]);
    expect(r.balanced).toBe(true);
    const over = pairingBalance([call("d"), call("d"), result("d")]);
    expect(over.final.open).toBe(1);
  });

  test("空消息数组：final 即空前缀，配平", () => {
    const r = pairingBalance([]);
    expect(r.balanced).toBe(true);
    expect(r.prefixes).toEqual([{ index: 0, open: 0, orphan: 0 }]);
  });
});

describe("BI-10.2 切点门禁 · isCutSafe", () => {
  const msgs = [user(), call("a1"), result("a1"), user(), call("a2"), result("a2")];

  test("切点落在调用与结果之间：不安全", () => {
    expect(isCutSafe(msgs, 2)).toBe(false);
  });

  test("切点落在结果之后：安全", () => {
    expect(isCutSafe(msgs, 3)).toBe(true);
  });

  test("切点 0（不丢任何消息）恒安全", () => {
    expect(isCutSafe(msgs, 0)).toBe(true);
  });

  test("切点 = 全长：整条序列配平时安全", () => {
    expect(isCutSafe(msgs, msgs.length)).toBe(true);
  });

  test("越界切点（负数 / 超长）不安全", () => {
    expect(isCutSafe(msgs, -1)).toBe(false);
    expect(isCutSafe(msgs, msgs.length + 1)).toBe(false);
  });

  test("切点之前有未闭合调用：不安全", () => {
    expect(isCutSafe([call("z"), user()], 2)).toBe(false);
  });
});

describe("BI-10.2 · findSafeCut", () => {
  test("preferred 在未闭合对中间：回退到调用之前", () => {
    const msgs = [user(), call("a1"), result("a1"), user(), call("a2")];
    // preferred=5（切在 a2 调用之后，前缀含未闭合调用）不安全 → 回退到 4
    // （a2 调用之前，前缀恰好配平）。
    expect(findSafeCut(msgs, 5)).toBe(4);
  });

  test("preferred 本身安全：原样返回", () => {
    const msgs = [user(), call("a1"), result("a1"), user()];
    expect(findSafeCut(msgs, 3)).toBe(3);
  });

  test("preferred 超长：钳制到全长", () => {
    const msgs = [user(), call("a1"), result("a1")];
    expect(findSafeCut(msgs, 99)).toBe(3);
  });

  test("开头即未闭合调用：一路回退到 0", () => {
    // [call("z"), user()] 任何非空前缀都含未闭合调用 → 只能切在 0。
    expect(findSafeCut([call("z"), user()], 2)).toBe(0);
  });

  test("空消息数组：返回 0", () => {
    expect(findSafeCut([], 5)).toBe(0);
  });

  test("无主结果区域回退：跳过 orphan 前缀", () => {
    const msgs = [user(), result("ghost"), user()];
    // preferred=2：前缀含 orphan → 不安全；回退到 1（orphan 之前）？前缀 1
    // 不含 ghost，配平 → 返回 1。
    expect(findSafeCut(msgs, 2)).toBe(1);
  });
});

describe("BI-10.2 · sanitize 三修整", () => {
  test("无主结果：注入合成 tool_use 后配平", () => {
    const out = sanitize([user(), result("g1", "data")]);
    expect(out.fixes).toEqual(["orphan-result:g1:injected-synthetic-call"]);
    expect(out.messages).toEqual([
      user(),
      { role: "assistant", toolCallId: "g1", content: "(Tool result missing)" },
      result("g1", "data"),
    ]);
    expect(pairingBalance(out.messages).balanced).toBe(true);
  });

  test("空工具输出：替换为 (no tool output)", () => {
    const out = sanitize([user(), call("e1"), result("e1", ""), assistant("next")]);
    expect(out.fixes).toEqual(["empty-output:e1:placeholder"]);
    expect(out.messages[2]).toEqual({ role: "tool", toolCallId: "e1", content: "(no tool output)" });
  });

  test("悬挂 system 夹在配对中间：移到最近闭合点之后", () => {
    const out = sanitize([user(), call("a1"), sys("mid"), result("a1"), assistant("done")]);
    expect(out.fixes.length).toBe(1);
    expect(out.fixes[0]?.startsWith("dangling-system:")).toBe(true);
    expect(out.messages).toEqual([user(), call("a1"), result("a1"), sys("mid"), assistant("done")]);
    expect(pairingBalance(out.messages).balanced).toBe(true);
  });

  test("干净序列 no-op：内容不变且 fixes 为空", () => {
    const msgs = [sys("head"), user(), call("a1"), result("a1"), assistant("ok")];
    const out = sanitize(msgs);
    expect(out.fixes).toEqual([]);
    expect(out.messages).toEqual(msgs);
  });

  test("空数组：空转", () => {
    const out = sanitize([]);
    expect(out.messages).toEqual([]);
    expect(out.fixes).toEqual([]);
  });

  test("头部 system 消息原位保留", () => {
    const out = sanitize([sys("head"), user(), call("a1"), result("a1")]);
    expect(out.fixes).toEqual([]);
    expect(out.messages[0]).toEqual(sys("head"));
  });

  test("闭合点上的中途 system 不算悬挂：原位保留（裁定）", () => {
    const msgs = [user(), call("a1"), result("a1"), sys("note"), assistant("ok")];
    const out = sanitize(msgs);
    expect(out.fixes).toEqual([]);
    expect(out.messages).toEqual(msgs);
  });

  test("三处损伤同时修复：无主 + 空输出 + 悬挂", () => {
    const out = sanitize([
      user(),
      call("a1"),
      sys("dangling"),
      result("a1", ""),
      result("g2"),
    ]);
    expect(out.fixes.length).toBe(3);
    expect(out.fixes).toContain("empty-output:a1:placeholder");
    expect(out.fixes).toContain("orphan-result:g2:injected-synthetic-call");
    expect(out.fixes.some((f) => f.startsWith("dangling-system:"))).toBe(true);
    // 修整后整条序列必须配平。
    expect(pairingBalance(out.messages).balanced).toBe(true);
  });

  test("结尾仍未闭合：悬挂 system 兜底排到末尾（裁定）", () => {
    const out = sanitize([user(), call("a1"), sys("late")]);
    expect(out.messages).toEqual([user(), call("a1"), sys("late")]);
    expect(out.fixes.length).toBe(1);
    expect(out.fixes[0]?.startsWith("dangling-system:")).toBe(true);
  });

  test("两条悬挂 system 按原相对顺序一起排队", () => {
    const out = sanitize([user(), call("a1"), sys("s1"), sys("s2"), result("a1")]);
    expect(out.messages).toEqual([user(), call("a1"), result("a1"), sys("s1"), sys("s2")]);
  });
});
