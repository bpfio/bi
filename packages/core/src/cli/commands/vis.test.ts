/**
 * BI-20.5b — vis 子命令单测。
 *
 * 覆盖：
 *   - 处理器路由矩阵（列表 / 详情 / 404 / 令牌门 / 路径穿越拒绝 / 非法 host 无 token 拒启）；
 *   - buildBranchTree / pairTools 派生逻辑；
 *   - 单文件 HTML 关键结构子串断言（零外部依赖）；
 *   - handleVis 主机/令牌策略：非回环缺 BI_VIS_AUTH_TOKEN → 拒绝启动(exit 1)。
 *
 * 测试零外呼：用注入的 SessionManager 替身 + 注入 serve 工厂，不真实监听端口。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEntry, SessionMeta } from "../../session/types";
import {
  buildBranchTree,
  handleVis,
  isLoopback,
  isSafeSessionId,
  pairTools,
  parseVisArgs,
  parseVisListen,
  renderIndexHtml,
  SubUsageError,
  VisHandler,
  type VisServerDeps,
} from "./vis";

// ---------------------------------------------------------------------------
// SessionManager 替身
// ---------------------------------------------------------------------------

class FakeManager {
  metas: SessionMeta[] = [];
  /** sessionId -> entries */
  store = new Map<string, SessionEntry[]>();
  /** 设为 true 时 getSessionMeta 返回 undefined（模拟未知 id）。 */
  unknownIds = new Set<string>();

  listSessions(): Promise<SessionMeta[]> {
    return Promise.resolve([...this.metas]);
  }
  getSessionMeta(sessionId: string): Promise<SessionMeta | undefined> {
    if (this.unknownIds.has(sessionId)) return Promise.resolve(undefined);
    return Promise.resolve(this.metas.find((m) => m.sessionId === sessionId));
  }
  entries(sessionId: string): Promise<SessionEntry[]> {
    return Promise.resolve(this.store.get(sessionId) ?? []);
  }
}

function makeEntry(over: Partial<SessionEntry> & Pick<SessionEntry, "id" | "type" | "payload">): SessionEntry {
  return {
    parentId: null,
    createdAt: 1_700_000_000_000,
    seq: 1,
    ...over,
  } as SessionEntry;
}

// 注入 serve 工厂：不真实监听，仅回显端口。
function fakeServe(port: number): VisServerDeps["serve"] {
  return () => {
    return { port, stop: () => {} };
  };
}

// ---------------------------------------------------------------------------
// 安全 / 校验纯函数
// ---------------------------------------------------------------------------

describe("vis 安全纯函数", () => {
  test("isLoopback 识别回环地址（0.0.0.0/:: 视为非回环，需令牌）", () => {
    for (const h of ["127.0.0.1", "localhost", "::1"]) {
      expect(isLoopback(h)).toBe(true);
    }
    // 通配符绑定全部接口，暴露到网络 → 非回环（需令牌）。
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("::")).toBe(false);
    expect(isLoopback("192.168.1.5")).toBe(false);
    expect(isLoopback("10.0.0.1")).toBe(false);
  });

  test("isSafeSessionId 白名单口径（防路径穿越）", () => {
    expect(isSafeSessionId("abc123")).toBe(true);
    expect(isSafeSessionId("a.b-c_d")).toBe(true);
    expect(isSafeSessionId("../etc/passwd")).toBe(false);
    expect(isSafeSessionId("a/../b")).toBe(false);
    expect(isSafeSessionId("..")).toBe(false);
    expect(isSafeSessionId("")).toBe(false);
    expect(isSafeSessionId("-leading")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 派生逻辑
// ---------------------------------------------------------------------------

describe("vis 派生逻辑", () => {
  test("buildBranchTree 计算 depth（parentId 森林）", () => {
    const entries = [
      makeEntry({ id: "r", parentId: null, type: "user", payload: {}, seq: 1 }),
      makeEntry({ id: "a", parentId: "r", type: "assistant", payload: {}, seq: 2 }),
      makeEntry({ id: "b", parentId: "a", type: "user", payload: {}, seq: 3 }),
    ];
    const tree = buildBranchTree(entries);
    expect(tree.find((n) => n.id === "r")?.depth).toBe(0);
    expect(tree.find((n) => n.id === "a")?.depth).toBe(1);
    expect(tree.find((n) => n.id === "b")?.depth).toBe(2);
  });

  test("pairTools 按 toolCallId 配对 call/result", () => {
    const entries = [
      makeEntry({ id: "e1", type: "tool_call", payload: { q: 1 }, toolCallId: "tc1", toolName: "Read", seq: 1 }),
      makeEntry({ id: "e2", type: "tool_result", payload: { out: "x" }, toolCallId: "tc1", toolName: "Read", seq: 2 }),
      makeEntry({ id: "e3", type: "tool_call", payload: {}, toolCallId: "tc2", toolName: "Write", seq: 3 }),
    ];
    const pairs = pairTools(entries);
    expect(pairs).toHaveLength(2);
    const p1 = pairs.find((p) => p.toolCallId === "tc1")!;
    expect(p1.name).toBe("Read");
    expect(p1.call?.id).toBe("e1");
    expect(p1.result?.id).toBe("e2");
    const p2 = pairs.find((p) => p.toolCallId === "tc2")!;
    expect(p2.call?.id).toBe("e3");
    expect(p2.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 处理器路由矩阵
// ---------------------------------------------------------------------------

describe("VisHandler 路由矩阵", () => {
  function makeHandler(requireToken: boolean, token = "secret") {
    return new VisHandler({ manager: new FakeManager() as never, requireToken, token });
  }

  test("GET / 返回 200 text/html（骨架页，无需令牌）", async () => {
    const h = makeHandler(true, "secret");
    const res = await h.dispatch(new Request("http://127.0.0.1/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("bi vis");
  });

  test("/api/sessions 返回列表（无需令牌时）", async () => {
    const mgr = new FakeManager();
    mgr.metas = [
      { sessionId: "s1", title: "t1", createdAt: 1 },
      { sessionId: "s2", title: "t2", createdAt: 2 },
    ];
    const h = new VisHandler({ manager: mgr as never, requireToken: false, token: "" });
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionMeta[];
    expect(body).toHaveLength(2);
    expect(body.map((m) => m.sessionId).sort()).toEqual(["s1", "s2"]); // 透传替身原序
  });

  test("/api/sessions/:id 返回详情（meta + 分支树 + 工具配对）", async () => {
    const mgr = new FakeManager();
    mgr.metas = [{ sessionId: "s1", title: "t1", createdAt: 1 }];
    mgr.store.set("s1", [
      makeEntry({ id: "r", parentId: null, type: "user", payload: { text: "hi" }, seq: 1 }),
      makeEntry({ id: "c", parentId: "r", type: "tool_call", payload: {}, toolCallId: "tc", toolName: "Read", seq: 2 }),
      makeEntry({ id: "x", parentId: "r", type: "tool_result", payload: { ok: 1 }, toolCallId: "tc", toolName: "Read", seq: 3 }),
    ]);
    const h = new VisHandler({ manager: mgr as never, requireToken: false, token: "" });
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions/s1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      meta: SessionMeta;
      branchTree: unknown[];
      tools: unknown[];
    };
    expect(body.meta.sessionId).toBe("s1");
    expect(body.branchTree).toHaveLength(3);
    expect(body.tools).toHaveLength(1);
  });

  test("/api/sessions/:id 未知 id → 结构化 404", async () => {
    const mgr = new FakeManager();
    mgr.unknownIds.add("ghost");
    const h = new VisHandler({ manager: mgr as never, requireToken: false, token: "" });
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions/ghost"));
    expect(res.status).toBe(404);
    expect((await res.json())).toEqual({ error: "session_not_found", sessionId: "ghost" });
  });

  test("/api/sessions/:id 路径穿越式 id → 400", async () => {
    const h = makeHandler(false, "");
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions/..%2f..%2fetc%2fpasswd"));
    expect(res.status).toBe(400);
    expect((await res.json())).toMatchObject({ error: "invalid_session_id" });
  });

  test("非 GET 方法 → 405", async () => {
    const h = makeHandler(false, "");
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  test("未知路径 → 404", async () => {
    const h = makeHandler(false, "");
    const res = await h.dispatch(new Request("http://127.0.0.1/api/whatever"));
    expect(res.status).toBe(404);
  });

  test("requireToken=true 且无令牌 → 401（门禁先于 404）", async () => {
    const h = makeHandler(true, "secret");
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions"));
    expect(res.status).toBe(401);
  });

  test("requireToken=true 且令牌正确 → 200", async () => {
    const mgr = new FakeManager();
    mgr.metas = [{ sessionId: "s1", title: "t1", createdAt: 1 }];
    const h = new VisHandler({ manager: mgr as never, requireToken: true, token: "secret" });
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions?t=secret"));
    expect(res.status).toBe(200);
  });

  test("requireToken=true 且令牌错误 → 401", async () => {
    const h = makeHandler(true, "secret");
    const res = await h.dispatch(new Request("http://127.0.0.1/api/sessions?t=wrong"));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// handleVis 主机 / 令牌策略
// ---------------------------------------------------------------------------

describe("handleVis 主机/令牌策略", () => {
  function fakeIo() {
    const outs: string[] = [];
    const errs: string[] = [];
    return { io: { out: (l: string) => outs.push(l), err: (l: string) => errs.push(l) }, outs, errs };
  }

  test("缺省 host=127.0.0.1 且端口自动分配 → exit 0，打印 URL", async () => {
    const { io, outs } = fakeIo();
    const code = await handleVis([], io, { sessionsRoot: "/tmp/bi-sessions" }, { serve: fakeServe(5173), attachSignals: false });
    expect(code).toBe(0);
    expect(outs.join("\n")).toContain("http://127.0.0.1:5173/");
  });

  test("非回环 host 且缺 BI_VIS_AUTH_TOKEN → 拒绝启动 exit 1", async () => {
    const { io, errs } = fakeIo();
    const code = await handleVis(
      ["--host", "0.0.0.0"],
      io,
      {},
      { serve: fakeServe(0), getEnv: () => undefined, attachSignals: false },
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("BI_VIS_AUTH_TOKEN");
  });

  test("非回环 host 且带 BI_VIS_AUTH_TOKEN → exit 0", async () => {
    const { io, outs } = fakeIo();
    const code = await handleVis(
      ["--host", "0.0.0.0"],
      io,
      {},
      { serve: fakeServe(8080), getEnv: () => "tok", attachSignals: false },
    );
    expect(code).toBe(0);
    expect(outs.join("\n")).toContain("已启用令牌校验");
  });

  test("--port 非法 → exit 2", async () => {
    const { io } = fakeIo();
    const code = await handleVis(["--port", "abc"], io, {}, { serve: fakeServe(0), attachSignals: false });
    expect(code).toBe(2);
  });

  test("未知旗标 → SubUsageError（exit 2 路径）", async () => {
    const { io } = fakeIo();
    let thrown = false;
    try {
      await handleVis(["--bogus"], io, {}, { serve: fakeServe(0), attachSignals: false });
    } catch (e) {
      thrown = e instanceof SubUsageError;
    }
    expect(thrown).toBe(true);
  });

  test("parseVisArgs 仅接受 0-1 位置参数", () => {
    expect(() => parseVisArgs(["a", "b"])).toThrow(SubUsageError);
    const r = parseVisArgs(["sid", "--port", "9000", "--host", "localhost"]);
    expect(r.positionals).toEqual(["sid"]);
    expect(r.flags.get("--port")).toBe("9000");
    expect(r.flags.get("--host")).toBe("localhost");
  });
});

// ---------------------------------------------------------------------------
// F-EV-04：config [vis] 挂载分区接线
// ---------------------------------------------------------------------------

describe("F-EV-04 config [vis] 接线", () => {
  function fakeIo() {
    const outs: string[] = [];
    const errs: string[] = [];
    return { io: { out: (l: string) => outs.push(l), err: (l: string) => errs.push(l) }, outs, errs };
  }

  /** 回显真实解析端口的 serve 替身（不真实监听）。 */
  function echoServe(): VisServerDeps["serve"] {
    return (opts) => ({ port: opts.port, stop: () => {} });
  }

  test("缺省不物化：未声明 [vis] → 照常启动（缺省路径零行为差）", async () => {
    const { io, outs } = fakeIo();
    const code = await handleVis([], io, {}, { serve: fakeServe(5173), attachSignals: false });
    expect(code).toBe(0);
    expect(outs.join("\n")).toContain("http://127.0.0.1:5173/");
  });

  test("config listen 生效：缺省监听地址取 [vis] listen", async () => {
    const { io, outs } = fakeIo();
    const code = await handleVis(
      [],
      io,
      {},
      {
        serve: echoServe(),
        attachSignals: false,
        visSection: { enabled: true, listen: "127.0.0.1:7788", token_env: "" },
      },
    );
    expect(code).toBe(0);
    expect(outs.join("\n")).toContain("http://127.0.0.1:7788/");
  });

  test("CLI 旗标优先于 config listen：--host / --port 各自覆盖", async () => {
    const { io, outs } = fakeIo();
    const code = await handleVis(
      ["--host", "0.0.0.0", "--port", "5173"],
      io,
      {},
      {
        serve: echoServe(),
        attachSignals: false,
        getEnv: () => "tok",
        visSection: { enabled: true, listen: "127.0.0.1:7788", token_env: "" },
      },
    );
    expect(code).toBe(0);
    expect(outs.join("\n")).toContain("http://0.0.0.0:5173/");
  });

  test("token_env 生效：令牌从 config 指定的 env 名读（缺省仍是 BI_VIS_AUTH_TOKEN）", async () => {
    const asked: string[] = [];
    const { io, outs } = fakeIo();
    const code = await handleVis(
      ["--host", "0.0.0.0"],
      io,
      {},
      {
        serve: echoServe(),
        attachSignals: false,
        getEnv: (name: string) => {
          asked.push(name);
          return name === "MY_VIS_TOKEN" ? "tok" : undefined;
        },
        visSection: { enabled: true, listen: "127.0.0.1:0", token_env: "MY_VIS_TOKEN" },
      },
    );
    expect(code).toBe(0);
    expect(asked).toContain("MY_VIS_TOKEN");
    expect(outs.join("\n")).toContain("已启用令牌校验（MY_VIS_TOKEN）");
  });

  test("token_env 生效：自定义 env 缺令牌 → 拒绝启动 exit 1（错误信息点名该 env）", async () => {
    const { io, errs } = fakeIo();
    const code = await handleVis(
      ["--host", "0.0.0.0"],
      io,
      {},
      {
        serve: echoServe(),
        attachSignals: false,
        getEnv: () => undefined,
        visSection: { enabled: true, listen: "127.0.0.1:0", token_env: "MY_VIS_TOKEN" },
      },
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("MY_VIS_TOKEN");
  });

  test("token_env 缺省（空串）→ 仍读内建 BI_VIS_AUTH_TOKEN（既有兼容）", async () => {
    const { io, errs } = fakeIo();
    const code = await handleVis(
      ["--host", "0.0.0.0"],
      io,
      {},
      {
        serve: echoServe(),
        attachSignals: false,
        getEnv: () => undefined,
        visSection: { enabled: true, listen: "127.0.0.1:0", token_env: "" },
      },
    );
    expect(code).toBe(1);
    expect(errs.join("\n")).toContain("BI_VIS_AUTH_TOKEN");
  });

  test("enabled=false → 结构化拒绝启动 exit 4（能力未配置）", async () => {
    const { io, errs } = fakeIo();
    const code = await handleVis(
      [],
      io,
      {},
      {
        serve: echoServe(),
        attachSignals: false,
        visSection: { enabled: false, listen: "127.0.0.1:0", token_env: "" },
      },
    );
    expect(code).toBe(4);
    expect(errs.join("\n")).toContain("[vis-disabled]");
  });

  test("config listen 非法 → 结构化报错 exit 2（不静默丢弃配置错误）", async () => {
    const { io, errs } = fakeIo();
    const code = await handleVis(
      [],
      io,
      {},
      {
        serve: echoServe(),
        attachSignals: false,
        visSection: { enabled: true, listen: "no-port", token_env: "" },
      },
    );
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("config [vis] listen 非法");
  });

  test("parseVisListen：合法 ip:port 与 port=0；非法 → undefined", () => {
    expect(parseVisListen("127.0.0.1:0")).toEqual({ hostname: "127.0.0.1", port: 0 });
    expect(parseVisListen("0.0.0.0:8080")).toEqual({ hostname: "0.0.0.0", port: 8080 });
    expect(parseVisListen("no-colon")).toBeUndefined();
    expect(parseVisListen("127.0.0.1:")).toBeUndefined();
    expect(parseVisListen("127.0.0.1:70000")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 单文件 HTML 结构断言（零外部依赖）
// ---------------------------------------------------------------------------

describe("renderIndexHtml 单文件结构断言", () => {
  const html = renderIndexHtml();

  test("含 bi vis 标题与关键区块 id", () => {
    expect(html).toContain("<title>bi vis");
    expect(html).toContain('id="session-list"');
    expect(html).toContain('id="content"');
    expect(html).toContain("分支树");
    expect(html).toContain("消息流");
  });

  test("零外部依赖：无 script src / 无 link / 无任何 http(s) 外链", () => {
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toMatch(/<link\s/i);
    // 允许 ?t= 这类相对路径；拒绝出现 http(s):// 绝对外链
    expect(html).not.toMatch(/https?:\/\//i);
  });

  test("工具调用折叠卡使用原生 <details> 折叠（无依赖组件）", () => {
    // 折叠卡由原生 <details> 实现（JS createElement('details') + details.tool 样式）。
    expect(html).toContain("createElement('details')");
    expect(html).toContain("details.tool");
    expect(html).toContain("toolCallId");
  });
});
