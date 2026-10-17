import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import {
  DEFAULT_SKEW_MS,
  MemoryReplayStore,
  type A2aEnvelope,
  type A2aSharedSecret,
  type SignedEnvelope,
  type VerifyFailureReason,
  type VerifyOptions,
  type VerifyResult,
  a2aSecret,
  canonicalJson,
  defaultReplayStore,
  signEnvelope,
  verifyEnvelope,
} from "./auth";

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

type Payload = { task: string };

/** 密钥明文只在夹具出现一次；所有日志/序列化断言用它做反向检查（安全红线）。 */
const SECRET: A2aSharedSecret = a2aSecret("bi-a2a-unit-secret-0123456789abcdef");

const T0 = 1_700_000_000_000;
/** 注入时钟：与真实 Date.now() 无关（若实现偷读真实时钟，T0 已过期 5 分钟窗外，测试必然翻车）。 */
const BASE_NOW = T0 + 60_000;

function makeEnvelope(overrides: Partial<A2aEnvelope<Payload>> = {}): A2aEnvelope<Payload> {
  return {
    from: "scout-01",
    to: "coordinator",
    ts: T0,
    nonce: "nonce-0001",
    payload: { task: "fetch-report" },
    ...overrides,
  };
}

function baseOpts(overrides: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    secret: SECRET,
    allowFrom: ["scout-01"],
    now: BASE_NOW,
    replayStore: new MemoryReplayStore(),
    ...overrides,
  };
}

function expectFail(reason: VerifyFailureReason): (result: VerifyResult<Payload>) => void {
  return (result) => {
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe(reason);
  };
}

/** 同长度翻转签名字符（保证走「长度对齐但内容不同」路径）。 */
function flipFirstChar(text: string): string {
  const first = text[0]!;
  return (first === "A" ? "B" : "A") + text.slice(1);
}

function signedMissing(key: string): unknown {
  const signed: Record<string, unknown> = { ...signEnvelope(makeEnvelope(), SECRET) };
  delete signed[key];
  return signed;
}

// ---------------------------------------------------------------------------
// A2aSharedSecret 品牌语义
// ---------------------------------------------------------------------------

describe("auth: A2aSharedSecret 品牌语义", () => {
  test("a2aSecret 返回同值字符串（compile-time brand，零运行时开销）", () => {
    expect<string>(a2aSecret("k-123")).toBe("k-123");
    const marked: A2aSharedSecret = a2aSecret("k-123");
    const asString: string = marked; // 品牌可赋回 string（读方向无害）
    expect(asString).toBe("k-123");
  });

  test("空串密钥拒绝构造（防呆；错误消息不含密钥材料）", () => {
    expect(() => a2aSecret("")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 签名往返
// ---------------------------------------------------------------------------

describe("auth: signEnvelope × verifyEnvelope 签名往返", () => {
  test("正常往返：valid 且五字段无损", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    const result = verifyEnvelope(signed, baseOpts());
    expect(result).toEqual({
      valid: true,
      envelope: { from: "scout-01", to: "coordinator", ts: T0, nonce: "nonce-0001", payload: { task: "fetch-report" } },
    });
  });

  test("签名为 43 字符无填充 base64url（HMAC-SHA256 = 32 字节）", () => {
    const { signature } = signEnvelope(makeEnvelope(), SECRET);
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("确定性：同封套同密钥两次签名逐字节一致", () => {
    const a = signEnvelope(makeEnvelope(), SECRET).signature;
    const b = signEnvelope(makeEnvelope(), SECRET).signature;
    expect(b).toBe(a);
  });

  test("换密钥签名不同，且交叉验证判 bad-signature", () => {
    const other = a2aSecret("another-shared-secret-9876543210");
    const signedA = signEnvelope(makeEnvelope(), SECRET);
    const signedB = signEnvelope(makeEnvelope(), other);
    expect(signedB.signature).not.toBe(signedA.signature);
    expectFail("bad-signature")(verifyEnvelope(signedA, baseOpts({ secret: other })));
  });

  test("复杂 payload（嵌套/数组/中文/布尔/null/浮点）往返 deep equal", () => {
    const envelope = makeEnvelope({
      nonce: "nonce-complex",
      payload: { task: "audit", list: [1, 2.5, true, null, "良率勾稽"], nested: { deep: { x: 1 } }, empty: {}, arr: [] },
    } as Partial<A2aEnvelope<Payload>>);
    const result = verifyEnvelope(signEnvelope(envelope, SECRET), baseOpts({ replayStore: new MemoryReplayStore() }));
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.envelope.payload).toEqual(envelope.payload);
  });

  test("注入时钟生效：ts 与 now 同为固定历史时刻仍可验证（偷读真实时钟则必翻车）", () => {
    const result = verifyEnvelope(signEnvelope(makeEnvelope(), SECRET), baseOpts());
    expect(result.valid).toBe(true);
  });

  test("安全红线：签名产物与验证结果的所有序列化出口均无密钥明文", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    const verdict = verifyEnvelope(signed, baseOpts());
    const secretText: string = SECRET; // 明文视图仅用于「不出现」断言
    const surfaces = [
      JSON.stringify(signed),
      inspect(signed, { depth: null }),
      JSON.stringify(verdict),
      inspect(verdict, { depth: null }),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain(secretText);
      expect(surface).not.toContain("unit-secret-0123"); // 中段片段也不得出现
      expect(surface).not.toContain("0123456789abcdef"); // 尾段片段也不得出现
    }
  });
});

// ---------------------------------------------------------------------------
// 五类失败逐一
// ---------------------------------------------------------------------------

describe("auth: 失败原因五类逐一", () => {
  test("篡改 payload → bad-signature", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    const tampered: SignedEnvelope<Payload> = { ...signed, payload: { task: "fetch-credentials" } };
    expectFail("bad-signature")(verifyEnvelope(tampered, baseOpts()));
  });

  test("篡改签名字段/收件人（to）→ bad-signature / 重打包后规范签名不复用", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expectFail("bad-signature")(verifyEnvelope({ ...signed, signature: flipFirstChar(signed.signature) }, baseOpts()));
    expectFail("bad-signature")(verifyEnvelope({ ...signed, to: "auditor-01" }, baseOpts({ allowFrom: ["scout-01"] })));
  });

  test("签名截断（长度不齐路径 A）→ bad-signature 且不抛错", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    const truncated = signed.signature.slice(0, signed.signature.length - 4);
    expect(truncated.length).toBeLessThan(signed.signature.length);
    expectFail("bad-signature")(verifyEnvelope({ ...signed, signature: truncated }, baseOpts()));
  });

  test("签名加长（长度不齐路径 B）→ bad-signature 且不抛错", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    const extended = `${signed.signature}AAAA`;
    expect(extended.length).toBeGreaterThan(signed.signature.length);
    expectFail("bad-signature")(verifyEnvelope({ ...signed, signature: extended }, baseOpts()));
  });

  test("非法 base64url 字符集（含 + / =）→ bad-signature", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expectFail("bad-signature")(verifyEnvelope({ ...signed, signature: `+${signed.signature.slice(1)}` }, baseOpts()));
    expectFail("bad-signature")(verifyEnvelope({ ...signed, signature: `${signed.signature}=` }, baseOpts()));
  });

  test("过期（now = ts + skew + 1ms）→ expired", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expectFail("expired")(verifyEnvelope(signed, baseOpts({ now: T0 + DEFAULT_SKEW_MS + 1 })));
  });

  test("未来时间戳（now = ts - skew - 1ms）→ expired（绝对值窗，双向）", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expectFail("expired")(verifyEnvelope(signed, baseOpts({ now: T0 - DEFAULT_SKEW_MS - 1 })));
  });

  test("窗口边界含等号：|now - ts| = skew 恰好有效（过去侧与未来侧）", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expect(verifyEnvelope(signed, baseOpts({ now: T0 + DEFAULT_SKEW_MS })).valid).toBe(true);
    expect(verifyEnvelope(signed, baseOpts({ now: T0 - DEFAULT_SKEW_MS })).valid).toBe(true);
  });

  test("skewMs 可配：自定义窄窗下旧消息过期，默认窗下同消息有效", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expectFail("expired")(verifyEnvelope(signed, baseOpts({ skewMs: 1_000, now: T0 + 5_000 })));
    expect(verifyEnvelope(signed, baseOpts({ now: T0 + 5_000 })).valid).toBe(true);
  });

  test("非白名单发件人 → unknown-sender（先于时间窗与验签短路）", () => {
    const signed = signEnvelope(makeEnvelope({ from: "ghost-agent" }), SECRET);
    expectFail("unknown-sender")(verifyEnvelope(signed, baseOpts({ now: T0 + DEFAULT_SKEW_MS * 10 })));
  });

  test("fail-closed：allowFrom 为空数组时拒绝一切发件人", () => {
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expectFail("unknown-sender")(verifyEnvelope(signed, baseOpts({ allowFrom: [] })));
  });

  test("重放：同封套第二次验证 → replayed", () => {
    const store = new MemoryReplayStore();
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expect(verifyEnvelope(signed, baseOpts({ replayStore: store })).valid).toBe(true);
    expectFail("replayed")(verifyEnvelope(signed, baseOpts({ replayStore: store })));
  });

  test("不同 nonce 互不干扰：各自首次验证均 valid", () => {
    const store = new MemoryReplayStore();
    const first = verifyEnvelope(signEnvelope(makeEnvelope({ nonce: "n-a" }), SECRET), baseOpts({ replayStore: store }));
    const second = verifyEnvelope(signEnvelope(makeEnvelope({ nonce: "n-b" }), SECRET), baseOpts({ replayStore: store }));
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
  });

  test("nonce TTL 过期后可复用（注入时钟推进；TTL-1 仍拒绝，TTL 整点起放行）", () => {
    const store = new MemoryReplayStore();
    const signed = signEnvelope(makeEnvelope(), SECRET);
    expect(verifyEnvelope(signed, baseOpts({ replayStore: store, now: T0 })).valid).toBe(true);
    // 窗内推进时钟：仍然拒绝
    expectFail("replayed")(verifyEnvelope(signed, baseOpts({ replayStore: store, now: T0 + DEFAULT_SKEW_MS - 1 })));
    // 注入时钟推进过 TTL：惰性清理后允许复用
    expect(verifyEnvelope(signed, baseOpts({ replayStore: store, now: T0 + DEFAULT_SKEW_MS })).valid).toBe(true);
  });

  test("验签失败不登记 nonce：坏签名消息不得污染 nonce 库（防合法发件人被 DoS）", () => {
    const store = new MemoryReplayStore();
    const wrongKey = a2aSecret("wrong-key-abcdef0123456789");
    const forged = signEnvelope(makeEnvelope(), wrongKey); // nonce 同 "nonce-0001"
    expectFail("bad-signature")(verifyEnvelope(forged, baseOpts({ replayStore: store })));
    // 同 nonce 的正确签名消息不受影响
    expect(verifyEnvelope(signEnvelope(makeEnvelope(), SECRET), baseOpts({ replayStore: store })).valid).toBe(true);
  });

  test("过期消息不登记 nonce：修正 ts 重发（同 nonce）后 valid", () => {
    const store = new MemoryReplayStore();
    const stale = signEnvelope(makeEnvelope(), SECRET);
    expectFail("expired")(verifyEnvelope(stale, baseOpts({ replayStore: store, now: T0 + DEFAULT_SKEW_MS + 1 })));
    expect(store.size).toBe(0);
    expect(verifyEnvelope(stale, baseOpts({ replayStore: store, now: BASE_NOW })).valid).toBe(true);
  });

  test("缺省 replayStore 为进程级内存库：同 nonce 二次验证判 replayed", () => {
    const nonce = `default-store-probe-${randomUUID()}`;
    const signed = signEnvelope(makeEnvelope({ nonce }), SECRET);
    const opts = baseOpts();
    delete (opts as { replayStore?: unknown }).replayStore; // 显式走 defaultReplayStore 缺省路径
    expect(verifyEnvelope(signed, opts).valid).toBe(true);
    expectFail("replayed")(verifyEnvelope(signed, opts));
    expect(defaultReplayStore).toBeInstanceOf(MemoryReplayStore);
  });
});

// ---------------------------------------------------------------------------
// malformed 结构校验
// ---------------------------------------------------------------------------

describe("auth: malformed 结构校验（运行时防御）", () => {
  const cases: Array<[string, unknown]> = [
    ["缺 ts", signedMissing("ts")],
    ["缺 from", signedMissing("from")],
    ["缺 to", signedMissing("to")],
    ["缺 nonce", signedMissing("nonce")],
    ["缺 payload", signedMissing("payload")],
    ["缺 signature", signedMissing("signature")],
    ["from 为空串", { ...signEnvelope(makeEnvelope(), SECRET), from: "" }],
    ["ts 为浮点（非安全整数）", { ...signEnvelope(makeEnvelope(), SECRET), ts: T0 + 0.5 }],
    ["ts 为 NaN", { ...signEnvelope(makeEnvelope(), SECRET), ts: Number.NaN }],
    ["ts 为字符串", { ...signEnvelope(makeEnvelope(), SECRET), ts: String(T0) }],
    ["signature 为数字", { ...signEnvelope(makeEnvelope(), SECRET), signature: 42 }],
    ["signature 为空串", { ...signEnvelope(makeEnvelope(), SECRET), signature: "" }],
    ["附加未签名顶层字段", { ...signEnvelope(makeEnvelope(), SECRET), hopCount: 1 }],
    ["入参为 null", null],
    ["入参为字符串", "not-an-envelope"],
    ["入参为数组", []],
  ];

  for (const [label, candidate] of cases) {
    test(`malformed: ${label}`, () => {
      const result = verifyEnvelope(candidate as SignedEnvelope<Payload>, baseOpts());
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toBe("malformed");
    });
  }

  test("失败结果形状稳定：恰好 { valid, reason } 两键（可编程判断）", () => {
    const result = verifyEnvelope("junk" as unknown as SignedEnvelope<Payload>, baseOpts());
    expect(Object.keys(result).sort().join(",")).toBe("reason,valid");
  });
});

// ---------------------------------------------------------------------------
// canonicalJson 规范化稳定性
// ---------------------------------------------------------------------------

describe("auth: canonicalJson 规范化稳定性", () => {
  test("对象键递归排序：插入顺序扰动输出不变", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [{ c: 3, b: 4 }] })).toBe('{"a":[{"b":4,"c":3}],"z":{"x":2,"y":1}}');
  });

  test("数组顺序保持（数组是语义，不排序）", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("undefined 字段：对象中剔除、数组中落 null（与 JSON.stringify 语义一致）", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });

  test("键序扰动（顶层 + payload 内）→ 签名一致且可互验", () => {
    const payload = { a: 1, b: { x: 1, y: [2, 3] } };
    const envA: A2aEnvelope<typeof payload> = {
      from: "scout-01", to: "coordinator", ts: T0, nonce: "n-order", payload,
    };
    const envB: A2aEnvelope<typeof payload> = {
      payload: { b: { y: [2, 3], x: 1 }, a: 1 }, nonce: "n-order", ts: T0, to: "coordinator", from: "scout-01",
    };
    const signature = signEnvelope(envA, SECRET).signature;
    expect(signEnvelope(envB, SECRET).signature).toBe(signature);
    expect(verifyEnvelope({ ...envB, signature }, baseOpts({ replayStore: new MemoryReplayStore() })).valid).toBe(true);
  });

  test("中文 payload 规范化稳定（Unicode 键名排序一致）", () => {
    const envA = makeEnvelope({ nonce: "n-cjk", payload: { task: "良率勾稽" } });
    const envB: A2aEnvelope<Payload> = {
      payload: { task: "良率勾稽" }, nonce: "n-cjk", ts: T0, to: "coordinator", from: "scout-01",
    };
    expect(signEnvelope(envB, SECRET).signature).toBe(signEnvelope(envA, SECRET).signature);
  });

  test("signEnvelope 只携带五个协议字段 + signature（附加键被丢弃，往返自洽）", () => {
    const withExtra = { ...makeEnvelope(), extra: "ignored" } as A2aEnvelope<Payload> & { extra: string };
    const signed = signEnvelope(withExtra, SECRET);
    expect(Object.keys(signed).sort().join(",")).toBe("from,nonce,payload,signature,to,ts");
    expect((signed as { extra?: string }).extra).toBeUndefined();
    expect(verifyEnvelope(signed, baseOpts({ replayStore: new MemoryReplayStore() })).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MemoryReplayStore 单元
// ---------------------------------------------------------------------------

describe("auth: MemoryReplayStore", () => {
  test("mark → has 命中；注入时钟推进过 TTL 后 has 落空", () => {
    const store = new MemoryReplayStore(1_000);
    store.mark("n1", 5_000);
    expect(store.has("n1", 5_000)).toBe(true);
    expect(store.has("n1", 5_999)).toBe(true);
    expect(store.has("n1", 6_000)).toBe(false); // expiresAt = 5000 + 1000 ≤ now → 已清
  });

  test("惰性清理只清过期条目，未过期 nonce 不受牵连", () => {
    const store = new MemoryReplayStore(1_000);
    store.mark("old", 1_000);
    store.mark("fresh", 1_500);
    expect(store.size).toBe(2);
    expect(store.has("old", 2_100)).toBe(false); // 触发清理
    expect(store.size).toBe(1);
    expect(store.has("fresh", 2_100)).toBe(true);
  });

  test("不同 nonce 各自独立过期；DEFAULT_SKEW_MS 为缺省 TTL", () => {
    const store = new MemoryReplayStore();
    store.mark("a", 0);
    expect(store.has("a", DEFAULT_SKEW_MS - 1)).toBe(true);
    expect(store.has("a", DEFAULT_SKEW_MS)).toBe(false);
  });
});
