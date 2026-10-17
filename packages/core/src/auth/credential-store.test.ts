import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileCredentialStore } from "./credential-store";
import { CredentialStoreError, role, type ICredentialStore, type Secret } from "./types";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "bi-auth-store-"));
}

/** 时钟注入容器。 */
function makeClock() {
  const state = { now: 1_700_000_000_000 };
  return {
    now: () => state.now,
    advance(ms: number) {
      state.now += ms;
    },
  };
}

describe("FileCredentialStore · 机器密钥", () => {
  test("首次使用自动生成 32 字节密钥，0600 权限，实例间复用", async () => {
    const dir = makeTempDir();
    try {
      const keyPath = join(dir, ".machine-key");
      const filePath = join(dir, "credentials.json");
      const store = new FileCredentialStore({ keyPath, filePath });

      // 写入触发密钥生成。
      await store.set("k", role("secret", "v1"));

      expect(existsSync(keyPath)).toBe(true);
      const mode = statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);

      const decoded = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
      expect(decoded.length).toBe(32);

      // 第二实例复用同一机器密钥，可解密第一实例写入的数据。
      const second = new FileCredentialStore({ keyPath, filePath });
      expect(second.get("k")).resolves.toMatchObject({ value: role("secret", "v1") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("机器密钥内容非法（长度不符）时报 machine_key 错误", () => {
    const dir = makeTempDir();
    try {
      const keyPath = join(dir, ".machine-key");
      const filePath = join(dir, "credentials.json");
      writeFileSync(keyPath, Buffer.from("too-short").toString("base64"), { mode: 0o600 });
      const store = new FileCredentialStore({ keyPath, filePath });
      // set 需要机器密钥，应触发 machine_key 错误。
      expect(store.set("k", role("secret", "v"))).rejects.toMatchObject({
        name: "CredentialStoreError",
        code: "machine_key",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileCredentialStore · 加密落盘与 0600 权限", () => {
  test("凭据文件为加密信封，磁盘上无明文，权限 0600", async () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "credentials.json");
      const store = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath,
      });
      const secretValue = "PAT-PLAINTEXT-abc123";
      await store.set("bigmodel:pat", role("secret", secretValue));

      const mode = statSync(filePath).mode & 0o777;
      expect(mode).toBe(0o600);

      const raw = readFileSync(filePath, "utf8");
      expect(raw).not.toContain(secretValue);
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      expect(envelope.version).toBe(1);
      expect(envelope.cipher).toBe("AES-256-GCM");
      expect(envelope.kdf).toBe("HKDF-SHA256");
      expect(typeof envelope.salt).toBe("string");
      expect(typeof envelope.iv).toBe("string");
      expect(typeof envelope.authTag).toBe("string");
      expect(typeof envelope.payload).toBe("string");
      // payload 是合法 base64 密文。
      expect(Buffer.from(envelope.payload as string, "base64").length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set/get 往返（含多键与特殊字符）", async () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "credentials.json");
      const store: ICredentialStore = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath,
      });
      await store.set("bigmodel:pat", role("secret", "pat-🔒-value"));
      await store.set("kimi:token", role("secret", "k-1"), { expiresAt: 9_999_999_999_999 });

      expect((await store.get("bigmodel:pat"))?.value).toBe(role("secret", "pat-🔒-value"));
      expect((await store.get("kimi:token"))?.value).toBe(role("secret", "k-1"));
      expect(await store.get("missing")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("权限松弛自愈：落盘后手动放宽，再次操作时恢复 0600", async () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "credentials.json");
      const keyPath = join(dir, ".machine-key");
      const store = new FileCredentialStore({ keyPath, filePath });
      await store.set("k", role("secret", "v"));
      chmodSync(filePath, 0o644);
      expect(statSync(filePath).mode & 0o777).toBe(0o644);

      await store.set("k2", role("secret", "v2"));
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileCredentialStore · 端口语义", () => {
  test("set 整条覆盖重置 createdAt；refresh 原位轮换保留 createdAt", async () => {
    const clock = makeClock();
    const dir = makeTempDir();
    try {
      const store = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath: join(dir, "credentials.json"),
        now: clock.now,
      });
      await store.set("k", role("secret", "v1"));
      const first = (await store.get("k"))!;
      expect(first.createdAt).toBe(clock.now());

      clock.advance(1000);
      await store.set("k", role("secret", "v2"));
      const overwritten = (await store.get("k"))!;
      expect(overwritten.value).toBe(role("secret", "v2"));
      expect(overwritten.createdAt).toBe(clock.now()); // set 重置

      clock.advance(1000);
      await store.refresh("k", role("secret", "v3"), { expiresAt: 9_999_999_999_999 });
      const rotated = (await store.get("k"))!;
      expect(rotated.value).toBe(role("secret", "v3"));
      expect(rotated.createdAt).toBe(overwritten.createdAt); // refresh 保留当前记录的 createdAt
      expect(rotated.updatedAt).toBe(clock.now());
      expect(rotated.expiresAt).toBe(9_999_999_999_999);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refresh 对不存在的键抛 not_found", () => {
    const dir = makeTempDir();
    try {
      const store = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath: join(dir, "credentials.json"),
      });
      expect(store.refresh("ghost", role("secret", "v"))).rejects.toMatchObject({
        name: "CredentialStoreError",
        code: "not_found",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clear 移除凭据且幂等", async () => {
    const dir = makeTempDir();
    try {
      const store = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath: join(dir, "credentials.json"),
      });
      await store.set("k", role("secret", "v"));
      await store.clear("k");
      expect(await store.get("k")).toBeUndefined();
      await store.clear("k"); // 幂等
      expect(await store.get("k")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("过期凭据 get 返回 undefined（注入时钟）", async () => {
    const clock = makeClock();
    const dir = makeTempDir();
    try {
      const store = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath: join(dir, "credentials.json"),
        now: clock.now,
      });
      await store.set("k", role("secret", "v"), { expiresAt: clock.now() + 100 });
      expect((await store.get("k"))?.value).toBe(role("secret", "v"));

      clock.advance(101);
      expect(await store.get("k")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileCredentialStore · 解密失败分类", () => {
  test("错误机器密钥解密失败（decrypt）", async () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "credentials.json");
      const writer = new FileCredentialStore({
        keyPath: join(dir, "key-a"),
        filePath,
      });
      await writer.set("k", role("secret", "secret-value"));

      const reader = new FileCredentialStore({
        keyPath: join(dir, "key-b"), // 不同机器密钥
        filePath,
      });
      expect(reader.get("k")).rejects.toMatchObject({
        name: "CredentialStoreError",
        code: "decrypt",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("密文被篡改（authTag 校验失败）报 decrypt", async () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "credentials.json");
      const store = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath,
      });
      await store.set("k", role("secret", "v"));

      const envelope = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, string>;
      const cipher = Buffer.from(envelope.payload!, "base64");
      cipher[0] = cipher[0]! ^ 0xff;
      envelope.payload = cipher.toString("base64");
      writeFileSync(filePath, JSON.stringify(envelope), { mode: 0o600 });

      expect(store.get("k")).rejects.toMatchObject({
        name: "CredentialStoreError",
        code: "decrypt",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件损坏（非法 JSON）报 format", () => {
    const dir = makeTempDir();
    try {
      const filePath = join(dir, "credentials.json");
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, "not-json{{", { mode: 0o600 });
      const store = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath,
      });
      expect(store.get("k")).rejects.toMatchObject({
        name: "CredentialStoreError",
        code: "format",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("types · role('secret') 标记语义", () => {
  test("role 标记零开销透传且类型收敛为 Secret", () => {
    const raw = "raw-token-value";
    const marked: Secret = role("secret", raw);
    expect(marked as string).toBe(raw);
  });

  test("FileCredentialStore 满足 ICredentialStore 端口（编译期契约）", () => {
    const dir = makeTempDir();
    try {
      const store: ICredentialStore = new FileCredentialStore({
        keyPath: join(dir, ".machine-key"),
        filePath: join(dir, "credentials.json"),
      });
      expect(store).toBeDefined();
      expect(new CredentialStoreError("format", "x").name).toBe("CredentialStoreError");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
