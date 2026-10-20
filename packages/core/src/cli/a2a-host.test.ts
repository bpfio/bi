import { afterEach, describe, expect, test } from "bun:test";

import { signEnvelope, type A2aSharedSecret } from "../../../a2a/src/auth";
import { A2aHost } from "../../../a2a/src/host";
import { parseListen, startA2aHost, A2A_TOKEN_ENV } from "./a2a-host";

/** 还原令牌环境（测试间隔离，防泄漏到其他用例）。 */
const savedToken = process.env[A2A_TOKEN_ENV];
afterEach(() => {
  if (savedToken === undefined) {
    delete process.env[A2A_TOKEN_ENV];
  } else {
    process.env[A2A_TOKEN_ENV] = savedToken;
  }
});

describe("parseListen", () => {
  test("合法 ip:port 与 port=0", () => {
    expect(parseListen("127.0.0.1:0")).toEqual({ hostname: "127.0.0.1", port: 0 });
    expect(parseListen("localhost:8399")).toEqual({ hostname: "localhost", port: 8399 });
    expect(parseListen("::1:0")).toEqual({ hostname: "::1", port: 0 });
  });
  test("非法 listen → error", () => {
    expect("error" in parseListen("no-colon")).toBe(true);
    expect("error" in parseListen(":8080")).toBe(true);
    expect("error" in parseListen("127.0.0.1:")).toBe(true);
    expect("error" in parseListen("127.0.0.1:70000")).toBe(true);
    expect("error" in parseListen("127.0.0.1:-1")).toBe(true);
  });
});

describe("startA2aHost 拒绝路径", () => {
  test("enabled=false → 结构化拒绝不抛", async () => {
    const result = await startA2aHost({ enabled: false, listen: "127.0.0.1:0", allow: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("a2a-disabled");
  });

  test("listen 非法 → 结构化拒绝不抛", async () => {
    const result = await startA2aHost({ enabled: true, listen: "127.0.0.1:70000", allow: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("端口非法");
  });

  test("非回环 listen 且无 token → 结构化拒绝（对齐 vis 先例）", async () => {
    delete process.env[A2A_TOKEN_ENV];
    const result = await startA2aHost({ enabled: true, listen: "0.0.0.0:0", allow: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(A2A_TOKEN_ENV);
  });

  test("自定义 tokenEnv 非回环无令牌 → 拒绝", async () => {
    delete process.env.BI_A2A_CUSTOM_TOKEN;
    const result = await startA2aHost(
      { enabled: true, listen: "0.0.0.0:0", allow: [] },
      { tokenEnv: "BI_A2A_CUSTOM_TOKEN" },
    );
    expect(result.ok).toBe(false);
  });
});

describe("startA2aHost 回环启动", () => {
  test("127.0.0.1:0 → 真实端口、fetch 探活可达、close 干净", async () => {
    const result = await startA2aHost({ enabled: true, listen: "127.0.0.1:0", allow: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.port).toBeGreaterThan(0);
    expect(result.address).toBe(`127.0.0.1:${result.port}`);
    expect(result.host).toBeInstanceOf(A2aHost);

    const res = await fetch(`http://127.0.0.1:${result.port}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "bi-a2a", status: "ok" });

    result.close();
    await expect(fetch(`http://127.0.0.1:${result.port}/`)).rejects.toThrow();
  });

  test("allow 白名单透传为 HostOptions.allowFrom（验签面生效）", async () => {
    const result = await startA2aHost({
      enabled: true,
      listen: "127.0.0.1:0",
      allow: ["coordinator"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 白名单外发件人（scout）在验签步骤①即被拒（unknown-sender）；
    // 白名单内发件人通过①但签名密钥不匹配 → bad-signature。两者均不投递。
    const secret = "not-the-host-secret" as A2aSharedSecret;
    const makeRaw = (from: "coordinator" | "scout") =>
      signEnvelope(
        { from, to: "coordinator", ts: Date.now(), nonce: crypto.randomUUID(), payload: {} },
        secret,
      );
    result.host.attachTransport({
      name: "probe",
      send: () => {},
      onMessage: (cb) => {
        cb(makeRaw("scout"));
        cb(makeRaw("coordinator"));
      },
    });
    result.host.derive("coordinator", { handler: () => undefined });
    const handled = await result.host.dispatch();
    expect(handled).toBe(0);
    expect(result.host.rejections.map((r) => r.reason)).toEqual([
      "unknown-sender",
      "bad-signature",
    ]);
    result.close();
  });
});
