/**
 * BI-20.2 · `fork` 子命令测试。
 *
 * 覆盖：中段分叉三态（成功 / node-missing / session-missing）、title 缺省
 * 透传（`<源标题> (fork)`）与显式 title、源会话不受影响、fork 后可在
 * branchFrom 上继续追加、meta.forkedFrom 记录。
 * 全部用例注入临时会话目录，绝不触碰 ~/.bi。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../session/manager";
import { ForkError, forkSession } from "./fork";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const FIXED_NOW = () => 1700000000000;

function makeIdGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
}

async function tmpManager(): Promise<SessionManager> {
  const root = await mkdtemp(join(tmpdir(), "bi-fork-"));
  dirs.push(root);
  return new SessionManager({
    rootDir: join(root, "sessions"),
    now: FIXED_NOW,
    generateId: makeIdGen(),
  });
}

/** 构造 4 节点链：根(n1) → a(n2) → b(n3) → c(n4)，返回各节点 id。 */
async function setupChain(): Promise<{
  mgr: SessionManager;
  sessionId: string;
  ids: [string, string, string, string];
}> {
  const mgr = await tmpManager();
  const meta = await mgr.createSession({ sessionId: "s-src", title: "主线", cwd: "/w" });
  const e1 = await mgr.append(meta.sessionId, null, { type: "user", payload: { text: "问1" } });
  const e2 = await mgr.append(meta.sessionId, e1.id, { type: "assistant", payload: { text: "答1" } });
  const e3 = await mgr.append(meta.sessionId, e2.id, { type: "user", payload: { text: "问2" } });
  const e4 = await mgr.append(meta.sessionId, e3.id, { type: "assistant", payload: { text: "答2" } });
  return { mgr, sessionId: meta.sessionId, ids: [e1.id, e2.id, e3.id, e4.id] };
}

async function errorCode(promise: Promise<unknown>): Promise<ForkError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ForkError) return error;
    throw error;
  }
  throw new Error("预期分叉失败，但成功了");
}

describe("BI-20.2 fork：成功分叉", () => {
  test("中段分叉：返回 newSessionId 与 branchFrom=atNode，新会话含祖先路径", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const result = await forkSession(mgr, sessionId, ids[1]!);
    expect(result.branchFrom).toBe(ids[1]);
    expect(result.newSessionId).not.toBe(sessionId);
    const forked = await mgr.loadSession(result.newSessionId);
    expect(forked.entries.map((e) => e.id)).toEqual([ids[0], ids[1]]);
    expect(forked.entries).toHaveLength(2);
  });

  test("title 缺省透传 manager：`<源标题> (fork)`，且 meta.forkedFrom 记录源", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const result = await forkSession(mgr, sessionId, ids[2]!);
    const meta = (await mgr.loadSession(result.newSessionId)).meta;
    expect(meta.title).toBe("主线 (fork)");
    expect(meta.forkedFrom).toBe(sessionId);
    expect(meta.cwd).toBe("/w");
  });

  test("title 显式生效（不追加 fork 后缀）", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const result = await forkSession(mgr, sessionId, ids[0]!, { title: "我的分支" });
    const meta = (await mgr.loadSession(result.newSessionId)).meta;
    expect(meta.title).toBe("我的分支");
  });

  test("源会话不受分叉影响（条目数与内容不变）", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const before = await mgr.entries(sessionId);
    await forkSession(mgr, sessionId, ids[1]!);
    const after = await mgr.entries(sessionId);
    expect(after).toEqual(before);
    expect(after).toHaveLength(4);
  });

  test("fork 出的新会话可在 branchFrom 上继续追加（seq 接续）", async () => {
    const { mgr, sessionId, ids } = await setupChain();
    const result = await forkSession(mgr, sessionId, ids[1]!);
    const next = await mgr.append(result.newSessionId, result.branchFrom, {
      type: "user",
      payload: { text: "分支上的新问题" },
    });
    expect(next.seq).toBe(3);
    expect(next.parentId).toBe(ids[1]);
  });
});

describe("BI-20.2 fork：结构化错误", () => {
  test("atNode 不在源会话 → node-missing", async () => {
    const { mgr, sessionId } = await setupChain();
    const error = await errorCode(forkSession(mgr, sessionId, "n99"));
    expect(error.code).toBe("node-missing");
  });

  test("atNode 为任意不存在的 id → node-missing", async () => {
    const { mgr, sessionId } = await setupChain();
    const error = await errorCode(forkSession(mgr, sessionId, "不存在节点"));
    expect(error.code).toBe("node-missing");
  });

  test("源会话不存在 → session-missing", async () => {
    const mgr = await tmpManager();
    const error = await errorCode(forkSession(mgr, "no-such", "n1"));
    expect(error.code).toBe("session-missing");
  });
});
