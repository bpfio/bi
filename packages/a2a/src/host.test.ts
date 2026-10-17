import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SKEW_MS,
  a2aSecret,
  signEnvelope,
  verifyEnvelope,
  type A2aSharedSecret,
  type SignedEnvelope,
} from "./auth";
import { Blackboard, BlackboardWriteDeniedError, type JsonValue } from "./blackboard";
import { A2aHost, type InboundDelivery, type TransportPort } from "./host";
import type { A2aRole } from "./permissions";

const NOW = 1_700_000_000_000;
const SECRET = a2aSecret("bi-15-test-shared-secret");
const clock = { now: () => NOW };

/** 内存测试传输：实现 { name, send, onMessage } 三方法端口；peer 模拟跨网对端（JSON 序列化往返）。 */
class FakeTransport implements TransportPort {
  readonly sent: SignedEnvelope[] = [];
  #onReceive: ((raw: unknown) => void) | undefined;
  peer: FakeTransport | undefined;

  constructor(readonly name: string) {}

  send(envelope: SignedEnvelope): void {
    this.sent.push(envelope);
    if (this.peer !== undefined) {
      // 模拟跨网传输：JSON 序列化往返（键序扰动、引用断裂）后投递对端 onMessage。
      this.peer.receive(JSON.parse(JSON.stringify(envelope)) as unknown);
    }
  }

  onMessage(cb: (raw: unknown) => void): void {
    this.#onReceive = cb;
  }

  /** 测试注入口：模拟网络侧投递一条 raw 消息。 */
  receive(raw: unknown): void {
    this.#onReceive?.(raw);
  }
}

let nonceSeq = 0;

/** 构造签名封套（默认 scout → coordinator，合法密钥与时间）。 */
function makeSigned(opts?: {
  from?: string;
  to?: string;
  ts?: number;
  payload?: unknown;
  secret?: A2aSharedSecret;
}): SignedEnvelope {
  nonceSeq += 1;
  return signEnvelope(
    {
      from: opts?.from ?? "scout",
      to: opts?.to ?? "coordinator",
      ts: opts?.ts ?? NOW,
      nonce: `nonce-${nonceSeq}`,
      payload: opts?.payload ?? { question: "life?" },
    },
    opts?.secret ?? SECRET,
  );
}

// ---------------------------------------------------------------------------
// 角色派生与能力矩阵
// ---------------------------------------------------------------------------

describe("host: 角色派生与能力矩阵", () => {
  test("derive coordinator：能力句柄经 permissions 矩阵投影（全 5 能力）", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    expect(handle.role).toBe("coordinator");
    expect([...handle.capabilities].sort()).toEqual(["delegate", "execute", "network", "read", "write"]);
  });

  test("derive scout：read + network，无 write（黑板写入将被矩阵拦截）", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("scout", { handler: () => undefined });
    expect([...handle.capabilities].sort()).toEqual(["network", "read"]);
    expect(handle.capabilities).not.toContain("write");
  });

  test("derive auditor/reporter：矩阵投影各自成立", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    expect([...host.derive("auditor", { handler: () => undefined }).capabilities].sort()).toEqual([
      "execute",
      "read",
    ]);
    expect([...host.derive("reporter", { handler: () => undefined }).capabilities].sort()).toEqual([
      "read",
      "write",
    ]);
  });

  test("derive：sessionRef 注入优先；缺省生成非空且互不相同", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const scout = host.derive("scout", { handler: () => undefined, sessionRef: "sess-scout-1" });
    const auditor = host.derive("auditor", { handler: () => undefined });
    expect(scout.sessionRef).toBe("sess-scout-1");
    expect(auditor.sessionRef.length).toBeGreaterThan(0);
    expect(auditor.sessionRef).not.toBe(scout.sessionRef);
  });

  test("derive 未知角色：运行时 RangeError 拒绝", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const stranger = "root" as string as A2aRole;
    expect(() => host.derive(stranger, { handler: () => undefined })).toThrow(RangeError);
  });

  test("derive 同角色重复派生：RangeError 拒绝（保证路由唯一 inbox）", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    host.derive("scout", { handler: () => undefined });
    expect(() => host.derive("scout", { handler: () => undefined })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 双总线接线端口
// ---------------------------------------------------------------------------

describe("host: 双总线接线端口 attachTransport", () => {
  test("可接线多条传输（双总线），transportNames 按接线顺序记录", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    host.attachTransport(new FakeTransport("email"));
    host.attachTransport(new FakeTransport("wss"));
    expect(host.transportNames).toEqual(["email", "wss"]);
  });

  test("重名传输接线拒绝", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    host.attachTransport(new FakeTransport("email"));
    expect(() => host.attachTransport(new FakeTransport("email"))).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 入站五步验签与分发
// ---------------------------------------------------------------------------

describe("host: 入站五步验签与分发", () => {
  test("验签通过 → 目标角色 inbox 入队，投递字段齐全", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    const signed = makeSigned({ payload: { question: "life?" } });
    t.receive(signed);
    expect(handle.inbox.size).toBe(1);
    const [delivery] = handle.inbox.drain();
    expect(delivery?.from).toBe("scout");
    expect(delivery?.to).toBe("coordinator");
    expect(delivery?.payload).toEqual({ question: "life?" });
    expect(delivery?.nonce).toBe(signed.nonce);
    expect(delivery?.ts).toBe(NOW);
    expect(delivery?.transport).toBe("email");
    expect(delivery?.sessionRef).toBe(handle.sessionRef);
  });

  test("伪造签名（异钥）→ bad-signature 审计拒绝，不入队", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ secret: a2aSecret("attacker-secret") }));
    expect(handle.inbox.size).toBe(0);
    expect(host.rejections).toEqual([{ transport: "email", reason: "bad-signature", ts: NOW }]);
  });

  test("过期时间戳（超 5 分钟窗）→ expired", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ ts: NOW - DEFAULT_SKEW_MS - 1 }));
    expect(handle.inbox.size).toBe(0);
    expect(host.rejections.at(-1)?.reason).toBe("expired");
  });

  test("nonce 重放：同一封套二次投递 → replayed（仅首次入队）", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    const signed = makeSigned();
    t.receive(signed);
    t.receive(signed);
    expect(handle.inbox.size).toBe(1);
    expect(host.rejections).toHaveLength(1);
    expect(host.rejections[0]?.reason).toBe("replayed");
  });

  test("非白名单发件人 → unknown-sender（allowFrom fail-closed）", () => {
    const host = new A2aHost({ secret: SECRET, clock, allowFrom: ["coordinator"] });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ from: "scout" }));
    expect(handle.inbox.size).toBe(0);
    expect(host.rejections[0]?.reason).toBe("unknown-sender");
  });

  test("畸形 raw（对象/null/字符串）→ malformed，不抛异常逐条审计", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive({ garbage: true });
    t.receive(null);
    t.receive("raw-string");
    expect(handle.inbox.size).toBe(0);
    expect(host.rejections.map((r) => r.reason)).toEqual(["malformed", "malformed", "malformed"]);
  });

  test("目标角色未派生 → unknown-target（验签通过但不路由）", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    host.derive("scout", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ to: "coordinator" }));
    expect(host.rejections[0]?.reason).toBe("unknown-target");
  });

  test("发件人非法角色（自定义白名单含非角色串）→ unknown-sender-role", () => {
    const host = new A2aHost({ secret: SECRET, clock, allowFrom: ["ops-bot"] });
    host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ from: "ops-bot" }));
    expect(host.rejections[0]?.reason).toBe("unknown-sender-role");
  });
});

// ---------------------------------------------------------------------------
// dispatch 与出站签名
// ---------------------------------------------------------------------------

describe("host: dispatch 与出站签名", () => {
  test("dispatch：drain inbox 交 handler，返回处理数且队列清空", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const seen: InboundDelivery[] = [];
    const handle = host.derive("coordinator", {
      handler: (d) => {
        seen.push(d);
        return undefined;
      },
    });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ payload: { q: 1 } }));
    t.receive(makeSigned({ payload: { q: 2 } }));
    const handled = await host.dispatch("coordinator");
    expect(handled).toBe(2);
    expect(seen.map((d) => d.payload)).toEqual([{ q: 1 }, { q: 2 }]);
    expect(handle.inbox.size).toBe(0);
  });

  test("handler 返回 OutboundMessage → 封装签名 fan-out 至全部已接线传输（双总线同封套）", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    host.derive("coordinator", {
      handler: () => ({ from: "coordinator", to: "scout", payload: { answer: 42 } }),
    });
    const email = new FakeTransport("email");
    const wss = new FakeTransport("wss");
    host.attachTransport(email);
    host.attachTransport(wss);
    email.receive(makeSigned());
    await host.dispatch("coordinator");
    expect(email.sent).toHaveLength(1);
    expect(wss.sent).toHaveLength(1);
    expect(wss.sent[0]).toEqual(email.sent[0]);
  });

  test("出站信封：恰五协议字段 + signature，verifyEnvelope 验签通过", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    handle.outbox.push({ from: "coordinator", to: "scout", payload: { answer: 42 } });
    await host.dispatch("coordinator");
    const signed = t.sent[0];
    expect(signed).toBeDefined();
    expect(signed?.from).toBe("coordinator");
    expect(signed?.to).toBe("scout");
    expect(signed?.ts).toBe(NOW);
    expect(Object.keys(signed ?? {}).sort()).toEqual([
      "from",
      "nonce",
      "payload",
      "signature",
      "to",
      "ts",
    ]);
    const verdict = verifyEnvelope(signed as SignedEnvelope, {
      secret: SECRET,
      allowFrom: ["coordinator"],
      now: NOW,
    });
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.envelope.payload).toEqual({ answer: 42 });
    }
  });

  test("出站签名防篡改：payload 改动 → bad-signature", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("coordinator", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    handle.outbox.push({ from: "coordinator", to: "scout", payload: { answer: 42 } });
    await host.dispatch("coordinator");
    const signed = t.sent[0];
    expect(signed).toBeDefined();
    const tampered = { ...(signed as SignedEnvelope), payload: { answer: 43 } };
    expect(
      verifyEnvelope(tampered, { secret: SECRET, allowFrom: ["coordinator"], now: NOW }),
    ).toEqual({ valid: false, reason: "bad-signature" });
  });

  test("outbox 队列路径：push 后 dispatch flush 出站", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("scout", { handler: () => undefined });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    handle.outbox.push({ from: "scout", to: "coordinator", payload: { found: ["a", "b"] } });
    expect(handle.outbox.size).toBe(1);
    await host.dispatch("scout");
    expect(handle.outbox.size).toBe(0);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.from).toBe("scout");
    expect(t.sent[0]?.payload).toEqual({ found: ["a", "b"] });
  });

  test("未接线传输时出站投递抛错（不静默丢失）", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const handle = host.derive("scout", { handler: () => undefined });
    handle.outbox.push({ from: "scout", to: "coordinator", payload: 1 });
    expect(host.dispatch("scout")).rejects.toThrow("未接线任何传输");
  });

  test("dispatch 未派生角色：RangeError", () => {
    const host = new A2aHost({ secret: SECRET, clock });
    expect(host.dispatch("scout")).rejects.toThrow(RangeError);
  });

  test("dispatch 错误隔离：单条 handler 抛错入 failures，后续投递继续", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    let calls = 0;
    host.derive("coordinator", {
      handler: () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return undefined;
      },
    });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ payload: "first" }));
    t.receive(makeSigned({ payload: "second" }));
    const handled = await host.dispatch("coordinator");
    expect(handled).toBe(2);
    expect(calls).toBe(2);
    expect(host.failures).toHaveLength(1);
    expect(host.failures[0]?.role).toBe("coordinator");
    expect((host.failures[0]?.error as Error).message).toBe("boom");
  });

  test("dispatch 无参：派发全部派生角色", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    const seen: string[] = [];
    host.derive("scout", {
      handler: (d) => {
        seen.push(`scout:${String(d.payload)}`);
        return undefined;
      },
    });
    host.derive("reporter", {
      handler: (d) => {
        seen.push(`reporter:${String(d.payload)}`);
        return undefined;
      },
    });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ from: "coordinator", to: "scout", payload: "s" }));
    t.receive(makeSigned({ from: "coordinator", to: "reporter", payload: "r" }));
    const handled = await host.dispatch();
    expect(handled).toBe(2);
    expect(seen.sort()).toEqual(["reporter:r", "scout:s"]);
  });
});

// ---------------------------------------------------------------------------
// 双 host 端到端（内存 transport 对接跨网流转）
// ---------------------------------------------------------------------------

describe("host: 双 host 端到端（内存 transport 对接跨网流转）", () => {
  test("scout(B) → coordinator(A) → 回复 scout(B)：全程签名/验签通过，零拒绝", async () => {
    const hostA = new A2aHost({ secret: SECRET, clock });
    const hostB = new A2aHost({ secret: SECRET, clock });
    const ta = new FakeTransport("wire-a");
    const tb = new FakeTransport("wire-b");
    hostA.attachTransport(ta);
    hostB.attachTransport(tb);
    ta.peer = tb;
    tb.peer = ta;

    let coordinatorAsked: unknown;
    let scoutAsked: unknown;
    hostA.derive("coordinator", {
      handler: (d) => {
        coordinatorAsked = d.payload;
        return { from: "coordinator", to: "scout", payload: { answer: 42 } };
      },
    });
    const scout = hostB.derive("scout", {
      handler: (d) => {
        scoutAsked = d.payload;
        return undefined;
      },
    });

    scout.outbox.push({ from: "scout", to: "coordinator", payload: { question: "life?" } });
    await hostB.dispatch("scout"); // B 出站签名 → 跨网 → A 验签入队
    await hostA.dispatch("coordinator"); // A 处理并签名回复 → 跨网 → B 验签入队
    await hostB.dispatch("scout"); // B scout 消费回复

    expect(coordinatorAsked).toEqual({ question: "life?" });
    expect(scoutAsked).toEqual({ answer: 42 });
    expect(hostA.rejections).toHaveLength(0);
    expect(hostB.rejections).toHaveLength(0);
    expect(hostA.failures).toHaveLength(0);
    expect(hostB.failures).toHaveLength(0);
  });

  test("异钥宿主：跨网消息验签失败被审计拒绝，不入队", async () => {
    const hostA = new A2aHost({ secret: SECRET, clock });
    const hostB = new A2aHost({ secret: a2aSecret("other-host-secret"), clock });
    const ta = new FakeTransport("wire-a");
    const tb = new FakeTransport("wire-b");
    hostA.attachTransport(ta);
    hostB.attachTransport(tb);
    ta.peer = tb;
    tb.peer = ta;
    const handle = hostA.derive("coordinator", { handler: () => undefined });
    const scout = hostB.derive("scout", { handler: () => undefined });
    scout.outbox.push({ from: "scout", to: "coordinator", payload: { stolen: true } });
    await hostB.dispatch("scout");
    expect(handle.inbox.size).toBe(0);
    expect(hostA.rejections).toHaveLength(1);
    expect(hostA.rejections[0]?.reason).toBe("bad-signature");
  });
});

// ---------------------------------------------------------------------------
// 黑板矩阵联动（host 流转中被拦截/放行）
// ---------------------------------------------------------------------------

describe("host: 黑板矩阵联动（host 流转中被拦截/放行）", () => {
  test("scout 在 handler 中写黑板 → 矩阵拦截，failures 记录 BlackboardWriteDeniedError，黑板无写入", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    host.derive("scout", {
      handler: (d) => {
        // A2aEnvelope payload 协议约定为纯 JSON 结构（auth.ts），此处断言回 JsonValue 值域。
        host.blackboard.write("scout/findings", {
          value: d.payload as JsonValue,
          source: "scout",
        });
        return undefined;
      },
    });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ from: "coordinator", to: "scout", payload: { data: 1 } }));
    await host.dispatch("scout");
    const failure = host.failures[0];
    expect(failure?.role).toBe("scout");
    expect(failure?.error).toBeInstanceOf(BlackboardWriteDeniedError);
    expect((failure?.error as BlackboardWriteDeniedError).reason).toBe("denied-by-matrix");
    expect(host.blackboard.read("scout/findings")).toBeUndefined();
  });

  test("对照：coordinator 在流转中写黑板放行（矩阵允许 write）", async () => {
    const host = new A2aHost({ secret: SECRET, clock });
    host.derive("coordinator", {
      handler: (d) => {
        host.blackboard.write("plan/step-1", {
          value: d.payload as JsonValue,
          source: "coordinator",
        });
        return undefined;
      },
    });
    const t = new FakeTransport("email");
    host.attachTransport(t);
    t.receive(makeSigned({ from: "scout", to: "coordinator", payload: { finding: "x" } }));
    await host.dispatch("coordinator");
    expect(host.failures).toHaveLength(0);
    expect(host.blackboard.read("plan/step-1")?.source).toBe("coordinator");
    expect(host.blackboard.read("plan/step-1")?.value).toEqual({ finding: "x" });
  });

  test("blackboard 注入共享：host.blackboard 即注入实例；缺省自建 Blackboard", () => {
    const custom = new Blackboard({ clock });
    const hostA = new A2aHost({ secret: SECRET, clock, blackboard: custom });
    expect(hostA.blackboard).toBe(custom);
    const hostB = new A2aHost({ secret: SECRET, clock });
    expect(hostB.blackboard).toBeInstanceOf(Blackboard);
    expect(hostB.blackboard).not.toBe(custom);
  });
});
