/**
 * BI-20.5 — vis-handler 路由矩阵与 HTML 骨架测试。
 * 网络 仅 127.0.0.1；会话数据用真实 BI-03 SessionManager（临时目录）往返验证。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/manager";
import { VisServer, renderIndexHtml, type TokenAuthority } from "./vis-handler";

const TOKEN = "0123456789abcdef0123456789abcdef";

const staticTokens: TokenAuthority = {
  current: () => TOKEN,
  validate: (token) => token === TOKEN,
};

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

/** 每用例独立临时目录 + 真实 SessionManager + 主线三节点链 + fork 分支。 */
async function makeServer(): Promise<{
  mgr: SessionManager;
  sessionId: string;
  forkedId: string;
  entryIds: [string, string, string];
}> {
  dir = await mkdtemp(join(tmpdir(), "bi-vis-"));
  const mgr = new SessionManager({ rootDir: join(dir, "sessions"), now: () => 1_700_000_000_000 });
  const meta = await mgr.createSession({ title: "可视化会话", cwd: "/work" });
  const e1 = await mgr.append(meta.sessionId, null, { type: "user", payload: { text: "看看这个文件" } });
  const e2 = await mgr.append(meta.sessionId, e1.id, { type: "assistant", payload: { text: "好的" } });
  const e3 = await mgr.append(meta.sessionId, e2.id, {
    type: "tool_call",
    payload: null,
    toolCallId: "tc-1",
    toolName: "Read",
  });
  const fork = await mgr.fork(meta.sessionId, e2.id, { title: "分支会话" });
  server = new VisServer({ manager: mgr, tokens: staticTokens });
  server.start();
  return { mgr, sessionId: meta.sessionId, forkedId: fork.sessionId, entryIds: [e1.id, e2.id, e3.id] };
}

function base(): string {
  if (server === undefined) {
    throw new Error("server 未初始化");
  }
  return `http://127.0.0.1:${server.port}`;
}

describe("VisServer HTML 骨架（零依赖内联）", () => {
  test("renderIndexHtml 含 bi vis 标题", () => {
    expect(renderIndexHtml()).toContain("<title>bi vis");
  });

  test("会话 DAG 区块：#session-dag 与 #session-list", () => {
    const html = renderIndexHtml();
    expect(html).toContain('id="session-dag"');
    expect(html).toContain('id="session-list"');
  });

  test("轮次水流区块：#turn-flow 与 #turn-list", () => {
    const html = renderIndexHtml();
    expect(html).toContain('id="turn-flow"');
    expect(html).toContain('id="turn-list"');
  });

  test("工具卡片区块：#tool-cards 与 .tool-card 样式", () => {
    const html = renderIndexHtml();
    expect(html).toContain('id="tool-cards"');
    expect(html).toContain("tool-card");
  });

  test("Diff 展示区块：#diff-view 与 pre.diff", () => {
    const html = renderIndexHtml();
    expect(html).toContain('id="diff-view"');
    expect(html).toContain('class="diff"');
  });

  test("零外部依赖：无 script src、无 link、无任何 http(s) 外链", () => {
    const html = renderIndexHtml();
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/https?:\/\//i);
  });

  test("GET / 返回 200 text/html（骨架页无需令牌）", async () => {
    await makeServer();
    const res = await fetch(`${base()}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="session-dag"');
  });
});

describe("VisServer API 令牌门禁", () => {
  test("/api/sessions 无令牌 → 401", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/sessions`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("/api/sessions 错误令牌 → 401", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/sessions?t=${"f".repeat(32)}`);
    expect(res.status).toBe(401);
  });

  test("/api/sessions ?t= 正确 → 200 且透传 SessionMeta[]", async () => {
    const { sessionId } = await makeServer();
    const res = await fetch(`${base()}/api/sessions?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const metas = (await res.json()) as Array<{ sessionId: string; title: string }>;
    expect(Array.isArray(metas)).toBe(true);
    expect(metas.some((m) => m.sessionId === sessionId && m.title === "可视化会话")).toBe(true);
  });

  test("/api/sessions Authorization Bearer 正确 → 200", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/sessions`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("/api/session/:id 无令牌 → 401", async () => {
    const { sessionId } = await makeServer();
    const res = await fetch(`${base()}/api/session/${sessionId}`);
    expect(res.status).toBe(401);
  });

  test("/api/session/:id 错误令牌 → 401", async () => {
    const { sessionId } = await makeServer();
    const res = await fetch(`${base()}/api/session/${sessionId}?t=wrong-token`);
    expect(res.status).toBe(401);
  });

  test("/api/entry/:id 无令牌 → 401", async () => {
    const { entryIds } = await makeServer();
    const res = await fetch(`${base()}/api/entry/${entryIds[0]}`);
    expect(res.status).toBe(401);
  });

  test("未知 API 路径无令牌 → 401（门禁先于 404，防路径探测）", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/secret`);
    expect(res.status).toBe(401);
  });
});

describe("VisServer 会话数据路由", () => {
  test("/api/session/:id 返回全量条目（与 manager.entries 往返一致）", async () => {
    const { mgr, sessionId } = await makeServer();
    const res = await fetch(`${base()}/api/session/${sessionId}?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as Array<{ id: string; seq: number }>;
    expect(fetched).toEqual(await mgr.entries(sessionId));
    expect(fetched).toHaveLength(3);
  });

  test("/api/session/:id 会话不存在 → 404", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/session/no-such-session?t=${TOKEN}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("session_not_found");
  });

  test("/api/entry/:id 返回单条且与 manager 往返一致", async () => {
    const { mgr, sessionId, entryIds } = await makeServer();
    const res = await fetch(`${base()}/api/entry/${entryIds[1]}?t=${TOKEN}`);
    expect(res.status).toBe(200);
    const fetched = (await res.json()) as { id: string };
    const expected = (await mgr.entries(sessionId)).find((e) => e.id === entryIds[1]);
    if (expected === undefined) {
      throw new Error(`条目 ${entryIds[1]} 应存在于会话`);
    }
    expect(fetched).toEqual(expected);
  });

  test("/api/entry/:id 条目不存在 → 404", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/entry/00000000000000000000000000000000?t=${TOKEN}`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("entry_not_found");
  });

  test("/api/sessions 透传 forkedFrom DAG 字段", async () => {
    const { sessionId, forkedId } = await makeServer();
    const res = await fetch(`${base()}/api/sessions?t=${TOKEN}`);
    const metas = (await res.json()) as Array<{ sessionId: string; forkedFrom?: string }>;
    const forked = metas.find((m) => m.sessionId === forkedId);
    expect(forked).toBeDefined();
    expect(forked?.forkedFrom).toBe(sessionId);
  });

  test("非 GET 方法 → 405", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/sessions?t=${TOKEN}`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: string }).error).toBe("method_not_allowed");
  });

  test("未知 API 路径有令牌 → 404", async () => {
    await makeServer();
    const res = await fetch(`${base()}/api/whatever?t=${TOKEN}`);
    expect(res.status).toBe(404);
  });
});

describe("VisServer 启动面", () => {
  test("start() 绑定 127.0.0.1 随机端口，URL 形态正确", async () => {
    const { mgr } = await makeServer();
    expect(server).toBeDefined();
    const info = server?.info();
    expect(info?.hostname).toBe("127.0.0.1");
    expect(info?.port).toBeGreaterThan(0);
    expect(info?.url).toBe(`http://127.0.0.1:${info?.port}/`);
    expect(info?.token).toBe(TOKEN);
    expect(mgr).toBeDefined();
  });

  test("stop() 后 running=false 且幂等", async () => {
    await makeServer();
    expect(server?.running).toBe(true);
    server?.stop();
    expect(server?.running).toBe(false);
    expect(() => server?.stop()).not.toThrow();
  });
});
