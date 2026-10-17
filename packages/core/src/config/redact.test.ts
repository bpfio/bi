import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { SecretValue, isSecret, isSecretKey, redactSecret, redactSecrets } from "./redact";

describe("redact: redactSecret 单值遮蔽", () => {
  test("保留协议前缀与 last4，中间不可逆遮蔽", () => {
    expect(redactSecret("ze-1234567890abcd")).toBe("ze-***abcd");
    expect(redactSecret("sk-proj-abcdefgh1234")).toBe("sk-***1234");
  });

  test("无协议前缀时仅保留 last4", () => {
    expect(redactSecret("abcdefghijkl")).toBe("***ijkl");
  });

  test("短密钥整体遮蔽（last4 也不留，防短凭据泄漏）", () => {
    expect(redactSecret("abc")).toBe("***");
    expect(redactSecret("a1b2c3d")).toBe("***"); // 7 位
  });
});

describe("redact: SecretValue 标记凭据", () => {
  const raw = "ze-super-secret-9876543210";

  test("role('secret') 与显式 reveal", () => {
    const secret = new SecretValue(raw);
    expect(secret.role).toBe("secret");
    expect(isSecret(secret)).toBe(true);
    expect(isSecret("plain")).toBe(false);
    expect(secret.reveal()).toBe(raw);
  });

  test("隐式字符串化出口全部自动遮蔽", () => {
    const secret = new SecretValue(raw);
    expect(secret.toString()).not.toContain(raw);
    expect(`${secret}`).not.toContain(raw);
    expect(secret.toJSON()).not.toContain(raw);
    expect(inspect(secret)).not.toContain(raw);
    expect(secret.toString()).toMatch(/\*\*\*[0-9a-z]{4}$/);
  });

  test("JSON 序列化（跨进程 / TUI / A2A 边界）不泄漏原文", () => {
    const payload = { provider: "openai", credential: new SecretValue(raw), nested: [new SecretValue("abcd1234efgh5678")] };
    const json = JSON.stringify(payload);
    expect(json).not.toContain(raw);
    expect(json).not.toContain("abcd1234efgh5678");
    expect(json).toContain("***");
  });
});

/** redactSecrets 传输边界产物视图：标记值与敏感键名值在运行时均为遮蔽字符串。 */
interface RedactedView {
  providers: { entries: Record<string, { key: string }> };
  api_key: string;
  note: string;
  list: string[];
  meta: { count: number; token: string };
}

describe("redact: redactSecrets 深遍历", () => {
  test("SecretValue 与敏感键名明文一并遮蔽，返回全新对象", () => {
    const original = {
      providers: { entries: { openai: { key: new SecretValue("ze-1234567890abcd") } } },
      api_key: "sk-raw-abcdefgh",
      note: "not-secret",
      list: [new SecretValue("zz-9876543210"), "plain"],
      meta: { count: 2, token: "tok-1234567890" },
    };

    const redacted = redactSecrets(original) as unknown as RedactedView;

    // 标记值被遮蔽
    expect(redacted.providers.entries["openai"]?.key).toBe("ze-***abcd");
    expect(redacted.list[0]).toBe("zz-***3210");
    // 敏感键名兜底遮蔽
    expect(redacted.api_key).toBe("sk-***efgh");
    expect(redacted.meta.token).toBe("tok-***7890");
    // 非敏感内容原样保留
    expect(redacted.note).toBe("not-secret");
    expect(redacted.list[1]).toBe("plain");
    expect(redacted.meta.count).toBe(2);

    // 不修改原对象
    expect(original.providers.entries["openai"]?.key).toBeInstanceOf(SecretValue);
    expect(original.api_key).toBe("sk-raw-abcdefgh");
  });

  test("byKeyNames=false 时仅遮蔽 SecretValue 标记值", () => {
    const redacted = redactSecrets(
      { api_key: "sk-raw-abcdefgh", inner: new SecretValue("ze-1234567890abcd") },
      { byKeyNames: false },
    ) as unknown as { api_key: string; inner: string };
    expect(redacted.api_key).toBe("sk-raw-abcdefgh");
    expect(redacted.inner).toBe("ze-***abcd");
  });

  test("isSecretKey 覆盖常见凭据键名", () => {
    expect(isSecretKey("api_key")).toBe(true);
    expect(isSecretKey("password")).toBe(true);
    expect(isSecretKey("client_secret")).toBe(true);
    expect(isSecretKey("name")).toBe(false);
    expect(isSecretKey("base_url")).toBe(false);
  });

  test("数组与原始值透传", () => {
    expect(redactSecrets([1, "two", true, null])).toEqual([1, "two", true, null]);
    expect(redactSecrets("plain-string")).toBe("plain-string");
  });
});
