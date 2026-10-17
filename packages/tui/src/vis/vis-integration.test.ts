/**
 * BI-20.5 — VisServer × TokenRotator 集成测试（真实轮转引擎接入真实 SessionManager）。
 * 网络仅 127.0.0.1；不依赖真实时间（用显式 rotate() 驱动轮转）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../core/src/session/manager";
import { VisServer } from "../../../core/src/web/vis-handler";
import { TokenRotator, accessUrls } from "./token-rotator";

let dir: string | undefined;
let server: VisServer | undefined;

afterEach(async () => {
  if (server !== undefined) {
    server.stop();
    server = undefined;
  }
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function makeWired(graceMs = 60_000): Promise<{ rotator: TokenRotator; mgr: SessionManager }> {
  dir = await mkdtemp(join(tmpdir(), "bi-vis-int-"));
  const mgr = new SessionManager({ rootDir: join(dir, "sessions") });
  await mgr.createSession({ title: "集成会话" });
  // rotationMs 远大于用例时长：轮转一律由显式 rotate() 驱动，避免真实计时抖动。
  const rotator = new TokenRotator({ rotationMs: 3_600_000, graceMs });
  server = new VisServer({ manager: mgr, tokens: rotator });
  server.start();
  return { rotator, mgr };
}

function base(): string {
  if (server === undefined) {
    throw new Error("server 未初始化");
  }
  return `http://127.0.0.1:${server.port}`;
}

describe("VisServer × TokenRotator 集成", () => {
  test("start() 信息与 rotator 同源：url 为 127.0.0.1 形态、token 快照一致", async () => {
    const { rotator } = await makeWired();
    const info = server?.info();
    expect(info?.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(info?.token).toBe(rotator.current());
  });

  test("accessUrls 首项可直接访问 /api/sessions → 200", async () => {
    const { rotator } = await makeWired();
    const url = accessUrls(server?.port ?? 0, rotator.current())[0] as string;
    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    const res = await fetch(url.replace("/?", "/api/sessions?"));
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test("轮转后双活窗口：旧令牌仍 200，新令牌 200", async () => {
    const { rotator } = await makeWired();
    const oldToken = rotator.current();
    rotator.rotate();
    const newToken = rotator.current();
    expect(newToken).not.toBe(oldToken);
    expect((await fetch(`${base()}/api/sessions?t=${oldToken}`)).status).toBe(200);
    expect((await fetch(`${base()}/api/sessions?t=${newToken}`)).status).toBe(200);
    expect((await fetch(`${base()}/api/sessions`, { headers: { authorization: `Bearer ${oldToken}` } })).status).toBe(200);
  });

  test("graceMs=0 轮转后旧令牌立即 401，新令牌 200", async () => {
    const { rotator } = await makeWired(0);
    const oldToken = rotator.current();
    rotator.rotate();
    const newToken = rotator.current();
    const stale = await fetch(`${base()}/api/session/nope?t=${oldToken}`);
    expect(stale.status).toBe(401);
    expect((await fetch(`${base()}/api/sessions?t=${newToken}`)).status).toBe(200);
  });

  test("401 响应体结构稳定（error=unauthorized）", async () => {
    await makeWired();
    const res = await fetch(`${base()}/api/sessions`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("stop() 幂等且停止后 running=false", async () => {
    await makeWired();
    expect(server?.running).toBe(true);
    server?.stop();
    server?.stop();
    expect(server?.running).toBe(false);
  });
});
