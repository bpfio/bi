/**
 * BI-15.2 · GitHub A2A 任务中枢测试 —— 零真实网络·零真实 token·零数据外泄。
 *
 * 测试红线（对齐工单）：
 * - 所有 GitHub REST 交互经注入 fetchImpl 路由桩（脚本化状态码/响应体/Link 头），
 *   不访问真实 api.github.com、不使用真实 token（凭据为本测试专用假值）；
 * - 覆盖：派发分支 + spec 写入（含 GET→PATCH 幂等）、PR 开启/合并门禁（无 approvedBy
 *   零网络拒绝）、错误五分类映射、信封 export/import 往返、token 不入日志断言、分页 list；
 * - 日志/错误消息/审计全量扫描，断言不含 token 明文与 Authorization 头回显。
 */

import { describe, expect, test } from "bun:test";
import { MemoryReplayStore, a2aSecret, signEnvelope } from "../auth";
import {
  GithubA2aError,
  GithubA2aHub,
  encodeTaskJson,
  exportTaskEnvelope,
  githubToken,
  importTaskEnvelope,
  type FetchLike,
  type GithubA2aErrorCode,
  type GithubA2aHubOptions,
  type TaskResult,
  type TaskSpec,
} from "./github-a2a-hub";

// ---------------------------------------------------------------------------
// 固定测试常量（全部假值，绝不指向真实仓库/令牌）
// ---------------------------------------------------------------------------

const OWNER = "bi-org";
const REPO = "bi-tasks";
const TOKEN_TEXT = "ghp_test_token_0123456789";
const TOKEN = githubToken(TOKEN_TEXT);
const SECRET = a2aSecret("bi-a2a-test-secret-0123456789abcdef");
const NOW = 1_760_000_000_000;
const MAIN_SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const EXISTING_SHA = "d".repeat(40);
const MERGE_SHA = "e".repeat(40);

const SPEC: TaskSpec = {
  kind: "bi.task.dispatch",
  payload: { action: "repo-scan", depth: 3 },
  createdAt: "2026-10-16T00:00:00Z",
};
const RESULT: TaskResult = { taskId: "T1", ok: true, payload: { findings: 2 } };

// ---------------------------------------------------------------------------
// fetchImpl 路由桩：脚本化 [method, pathname 正则, 响应器]，未命中 → 404
// ---------------------------------------------------------------------------

interface StubRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type Route = [
  method: string,
  pattern: RegExp,
  respond: (req: StubRequest) => Response | undefined | Promise<Response | undefined>,
];

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeFetch(routes: Route[], calls: Call[]): FetchLike {
  return async function fetchImpl(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = { raw: init.body };
      }
    }
    calls.push({ method, url, headers, body });
    for (const [routeMethod, pattern, respond] of routes) {
      if (routeMethod === method && pattern.test(url.pathname)) {
        const out = await respond({ method, url, headers, body });
        if (out !== undefined) return out;
      }
    }
    return json(404, { message: "not found (stub default)" });
  };
}

function fixture(routes: Route[], overrides?: Partial<GithubA2aHubOptions>): {
  hub: GithubA2aHub;
  calls: Call[];
} {
  const calls: Call[] = [];
  const hub = new GithubA2aHub({
    fetchImpl: makeFetch(routes, calls),
    owner: OWNER,
    repo: REPO,
    token: TOKEN,
    clock: () => NOW,
    ...overrides,
  });
  return { hub, calls };
}

/** 标准仓库流（从 main 建分支 / contents GET 404 + PUT create / PR / merge），overrides 优先命中。 */
function flowRoutes(overrides: Route[] = []): Route[] {
  const base: Route[] = [
    ["GET", /\/git\/ref\/heads\/main$/, () => json(200, { ref: "refs/heads/main", object: { sha: MAIN_SHA } })],
    [
      "POST",
      /\/git\/refs$/,
      (req) => json(201, { ref: req.body?.ref, object: { sha: NEW_SHA } }),
    ],
    ["GET", /\/contents\//, () => json(404, { message: "No commit found for the path" })],
    [
      "PUT",
      /\/contents\//,
      (req) =>
        json(
          req.body?.sha !== undefined ? 200 : 201,
          { content: { path: "stub" }, commit: { sha: COMMIT_SHA } },
        ),
    ],
    [
      "POST",
      /\/pulls$/,
      () =>
        json(201, {
          number: 42,
          title: "bi-task T1",
          html_url: `https://github.com/${OWNER}/${REPO}/pull/42`,
          head: { ref: "bi-task-T1" },
          base: { ref: "main" },
        }),
    ],
    ["PUT", /\/pulls\/\d+\/merge$/, () => json(200, { merged: true, sha: MERGE_SHA })],
  ];
  return [...overrides, ...base];
}

/** 以 dispatchTask 首步（GET base ref）驱动错误映射断言。 */
async function expectDispatchCode(
  routes: Route[],
  code: GithubA2aErrorCode,
  status?: number,
): Promise<GithubA2aError> {
  const { hub, calls } = fixture(routes);
  let caught: unknown;
  try {
    await hub.dispatchTask("T1", SPEC);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GithubA2aError);
  const err = caught as GithubA2aError;
  expect(err.code).toBe(code);
  if (status !== undefined) {
    expect(err.status).toBe(status);
  }
  void calls;
  return err;
}

function statusRoute(status: number, body: unknown = { message: `HTTP ${status}` }, headers: Record<string, string> = {}): Route {
  return ["GET", /\/git\/ref\/heads\/main$/, () => json(status, body, headers)];
}

/** noUncheckedIndexedAccess 友好的取调用助手。 */
function nth(calls: Call[], index: number): Call {
  const call = calls[index];
  if (call === undefined) throw new Error(`missing stub call #${index} (got ${calls.length})`);
  return call;
}

function decodeContent(body: Record<string, unknown> | undefined): string {
  const content = body?.content;
  if (typeof content !== "string") throw new Error("stub body.content missing");
  return Buffer.from(content, "base64").toString("utf8");
}

// ---------------------------------------------------------------------------
// dispatchTask 任务派发
// ---------------------------------------------------------------------------

describe("GithubA2aHub.dispatchTask", () => {
  test("从 main 创建分支：GET base ref 解析 sha → POST git/refs", async () => {
    const { hub, calls } = fixture(flowRoutes());
    const result = await hub.dispatchTask("T1", SPEC);
    expect(calls.length).toBe(4);
    const refCall = nth(calls, 0);
    expect(refCall.method).toBe("GET");
    expect(refCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
    const branchCall = nth(calls, 1);
    expect(branchCall.method).toBe("POST");
    expect(branchCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/git/refs`);
    expect(branchCall.body?.ref).toBe("refs/heads/bi-task-T1");
    expect(branchCall.body?.sha).toBe(MAIN_SHA);
    expect(result).toEqual({ branch: "bi-task-T1", path: "bi-tasks/T1/spec.json", created: true });
  });

  test("spec.json 首次写入：GET 404 → PUT create（无 sha，base64 正文，201）", async () => {
    const { hub, calls } = fixture(flowRoutes());
    await hub.dispatchTask("T1", SPEC);
    const getCall = nth(calls, 2);
    expect(getCall.method).toBe("GET");
    expect(getCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/contents/bi-tasks/T1/spec.json`);
    expect(getCall.url.searchParams.get("ref")).toBe("bi-task-T1");
    const putCall = nth(calls, 3);
    expect(putCall.method).toBe("PUT");
    expect(putCall.body?.branch).toBe("bi-task-T1");
    expect(putCall.body?.sha).toBeUndefined();
    expect(decodeContent(putCall.body)).toBe(encodeTaskJson(SPEC));
  });

  test("GET→PATCH 幂等：spec 已存在时携带既有 sha 更新（200，created=false）", async () => {
    const { hub, calls } = fixture(
      flowRoutes([
        [
          "GET",
          /\/contents\/bi-tasks\/T1\/spec\.json$/,
          () => json(200, { sha: EXISTING_SHA, content: "old", encoding: "base64" }),
        ],
      ]),
    );
    const result = await hub.dispatchTask("T1", SPEC);
    const putCall = nth(calls, 3);
    expect(putCall.body?.sha).toBe(EXISTING_SHA);
    expect(putCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/contents/bi-tasks/T1/spec.json`);
    expect(result.created).toBe(false);
  });

  test("非法 taskId 本地拒绝（路径穿越/斜杠/空白/越界），零网络调用", async () => {
    const { hub, calls } = fixture(flowRoutes());
    for (const bad of ["", "../evil", "a/b", "has space", ".hidden", "a..b", "a".repeat(65)]) {
      await expect(hub.dispatchTask(bad, SPEC)).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls.length).toBe(0);
  });

  test("base ref 404 → not_found，且不发起分支创建", async () => {
    const { hub, calls } = fixture([statusRoute(404, { message: "Branch not found" })]);
    let caught: unknown;
    try {
      await hub.dispatchTask("T1", SPEC);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GithubA2aError);
    const err = caught as GithubA2aError;
    expect(err.code).toBe("not_found");
    expect(err.status).toBe(404);
    expect(calls.length).toBe(1);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("分支已存在（POST git/refs 422）→ conflict", async () => {
    const { hub } = fixture(
      flowRoutes([["POST", /\/git\/refs$/, () => json(422, { message: "Reference already exists" })]]),
    );
    await expect(hub.dispatchTask("T1", SPEC)).rejects.toMatchObject({
      code: "conflict",
      status: 422,
    });
  });

  test("baseBranch 可注入覆盖（develop）", async () => {
    const { hub, calls } = fixture(
      flowRoutes([
        ["GET", /\/git\/ref\/heads\/develop$/, () => json(200, { object: { sha: MAIN_SHA } })],
      ]),
      { baseBranch: "develop" },
    );
    await hub.dispatchTask("T1", SPEC);
    expect(nth(calls, 0).url.pathname).toBe(`/repos/${OWNER}/${REPO}/git/ref/heads/develop`);
    const branchCall = nth(calls, 1);
    expect(branchCall.body?.ref).toBe("refs/heads/bi-task-T1");
  });
});

// ---------------------------------------------------------------------------
// openPr / listOpenPrs / mergePr 交付与审查
// ---------------------------------------------------------------------------

describe("GithubA2aHub 交付与审查", () => {
  test("openPr：POST /pulls head=bi-task-T1 base=main，PrRef 字段映射", async () => {
    const { hub, calls } = fixture(flowRoutes());
    const pr = await hub.openPr("T1", { title: "bi-task T1 交付", body: "result 见 result.json" });
    const prCall = nth(calls, 0);
    expect(prCall.method).toBe("POST");
    expect(prCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/pulls`);
    expect(prCall.body).toEqual({
      title: "bi-task T1 交付",
      head: "bi-task-T1",
      base: "main",
      body: "result 见 result.json",
    });
    expect(pr).toEqual({
      number: 42,
      taskId: "T1",
      title: "bi-task T1",
      head: "bi-task-T1",
      base: "main",
      url: `https://github.com/${OWNER}/${REPO}/pull/42`,
    });
  });

  test("openPr 422（PR 已存在）→ conflict status=422", async () => {
    const { hub } = fixture(
      flowRoutes([["POST", /\/pulls$/, () => json(422, { message: "A pull request already exists" })]]),
    );
    await expect(hub.openPr("T1", { title: "t", body: "b" })).rejects.toMatchObject({
      code: "conflict",
      status: 422,
    });
  });

  test("openPr 非法 taskId → RangeError 零调用", async () => {
    const { hub, calls } = fixture(flowRoutes());
    await expect(hub.openPr("../x", { title: "t", body: "b" })).rejects.toBeInstanceOf(RangeError);
    expect(calls.length).toBe(0);
  });

  test("listOpenPrs：只回 head=bi-task-* 的 PR（无关 PR 被过滤）", async () => {
    const { hub, calls } = fixture([
      [
        "GET",
        /\/pulls$/,
        () =>
          json(200, [
            { number: 1, title: "task T1", head: { ref: "bi-task-T1" }, base: { ref: "main" }, html_url: "u1" },
            { number: 2, title: "misc", head: { ref: "feature-x" }, base: { ref: "main" }, html_url: "u2" },
            { number: 3, title: "task T2", head: { ref: "bi-task-T2" }, base: { ref: "main" }, html_url: "u3" },
          ]),
      ],
    ]);
    const prs = await hub.listOpenPrs();
    expect(prs.map((p) => [p.number, p.taskId])).toEqual([[1, "T1"], [3, "T2"]]);
    expect(calls.length).toBe(1);
    const call = nth(calls, 0);
    expect(call.url.searchParams.get("state")).toBe("open");
    expect(call.url.searchParams.get("per_page")).toBe("100");
  });

  test("listOpenPrs 分页：Link rel=next 驱动，两页按序合并", async () => {
    let pullsCalls = 0;
    const { hub, calls } = fixture([
      [
        "GET",
        /\/pulls$/,
        (_req) => {
          pullsCalls += 1;
          if (pullsCalls === 1) {
            return json(
              200,
              [{ number: 7, title: "t7", head: { ref: "bi-task-T1" }, base: { ref: "main" }, html_url: "u7" }],
              { link: `<https://api.github.com/repos/${OWNER}/${REPO}/pulls?state=open&page=2>; rel="next"` },
            );
          }
          return json(200, [
            { number: 8, title: "t8", head: { ref: "bi-task-T2" }, base: { ref: "main" }, html_url: "u8" },
            { number: 9, title: "t9", head: { ref: "bi-task-T3" }, base: { ref: "main" }, html_url: "u9" },
          ]);
        },
      ],
    ]);
    const prs = await hub.listOpenPrs();
    expect(pullsCalls).toBe(2);
    expect(prs.map((p) => p.taskId)).toEqual(["T1", "T2", "T3"]);
    expect(nth(calls, 0).url.searchParams.get("page")).toBe("1");
    expect(nth(calls, 1).url.searchParams.get("page")).toBe("2");
  });

  test("mergePr 门禁：无 approvedBy（空串）→ RangeError 零网络调用", async () => {
    const { hub, calls } = fixture(flowRoutes());
    await expect(hub.mergePr(42, "")).rejects.toBeInstanceOf(RangeError);
    expect(calls.length).toBe(0);
    expect(hub.mergeDecisions().length).toBe(0);
  });

  test("mergePr 门禁：空白/含控制符 approvedBy → RangeError 零调用", async () => {
    const { hub, calls } = fixture(flowRoutes());
    await expect(hub.mergePr(42, "   ")).rejects.toBeInstanceOf(RangeError);
    await expect(hub.mergePr(42, "alice\n-cron")).rejects.toBeInstanceOf(RangeError);
    expect(calls.length).toBe(0);
  });

  test("mergePr 门禁：非法 prNumber → RangeError 零调用", async () => {
    const { hub, calls } = fixture(flowRoutes());
    await expect(hub.mergePr(0, "alice")).rejects.toBeInstanceOf(RangeError);
    await expect(hub.mergePr(1.5, "alice")).rejects.toBeInstanceOf(RangeError);
    expect(calls.length).toBe(0);
  });

  test("mergePr 有 approvedBy：PUT /pulls/42/merge + 决策审计（RULE-BI-05）", async () => {
    const { hub, calls } = fixture(flowRoutes());
    const result = await hub.mergePr(42, "alice");
    const mergeCall = nth(calls, 0);
    expect(mergeCall.method).toBe("PUT");
    expect(mergeCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/pulls/42/merge`);
    expect(mergeCall.body).toEqual({ merge_method: "merge" });
    expect(result).toEqual({ merged: true, sha: MERGE_SHA });
    expect(hub.mergeDecisions()).toEqual([
      { prNumber: 42, approvedBy: "alice", merged: true, sha: MERGE_SHA, ts: NOW },
    ]);
  });

  test("mergePr 404 → not_found", async () => {
    const { hub } = fixture([["PUT", /\/pulls\/42\/merge$/, () => json(404, { message: "Not Found" })]]);
    await expect(hub.mergePr(42, "alice")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("mergePr 405（不可合并）→ conflict", async () => {
    const { hub } = fixture([
      ["PUT", /\/pulls\/42\/merge$/, () => json(405, { message: "Pull Request is not mergeable" })],
    ]);
    await expect(hub.mergePr(42, "alice")).rejects.toMatchObject({ code: "conflict", status: 405 });
  });
});

// ---------------------------------------------------------------------------
// postResult 载荷面
// ---------------------------------------------------------------------------

describe("GithubA2aHub.postResult", () => {
  test("首次写入：GET 404 → PUT create（base 分支，created=true）", async () => {
    const { hub, calls } = fixture(flowRoutes());
    const result = await hub.postResult("T1", RESULT);
    expect(result).toEqual({ path: "bi-tasks/T1/result.json", created: true });
    const getCall = nth(calls, 0);
    expect(getCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/contents/bi-tasks/T1/result.json`);
    expect(getCall.url.searchParams.get("ref")).toBe("main");
    const putCall = nth(calls, 1);
    expect(putCall.body?.branch).toBe("main");
    expect(putCall.body?.sha).toBeUndefined();
    expect(decodeContent(putCall.body)).toBe(encodeTaskJson(RESULT));
  });

  test("GET→PATCH 幂等：result 已存在时携带 sha 更新（created=false）", async () => {
    const { hub, calls } = fixture(
      flowRoutes([
        [
          "GET",
          /\/contents\/bi-tasks\/T1\/result\.json$/,
          () => json(200, { sha: EXISTING_SHA, content: "old", encoding: "base64" }),
        ],
      ]),
    );
    const result = await hub.postResult("T1", RESULT);
    expect(nth(calls, 1).body?.sha).toBe(EXISTING_SHA);
    expect(result.created).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 错误五分类映射（REST 状态映射表）
// ---------------------------------------------------------------------------

describe("错误五分类映射", () => {
  test("401 → auth", async () => {
    await expectDispatchCode([statusRoute(401, { message: "Bad credentials" })], "auth", 401);
  });

  test("403（普通）→ auth", async () => {
    await expectDispatchCode([statusRoute(403, { message: "Forbidden" })], "auth", 403);
  });

  test("403 且 x-ratelimit-remaining: 0 → rate_limited", async () => {
    await expectDispatchCode(
      [statusRoute(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })],
      "rate_limited",
      403,
    );
  });

  test("429 → rate_limited", async () => {
    await expectDispatchCode([statusRoute(429, { message: "Too Many Requests" })], "rate_limited", 429);
  });

  test("409 → conflict", async () => {
    await expectDispatchCode([statusRoute(409, { message: "Conflict" })], "conflict", 409);
  });

  test("422 → conflict", async () => {
    await expectDispatchCode([statusRoute(422, { message: "Validation Failed" })], "conflict", 422);
  });

  test("500 → network（服务端错误归传输面）", async () => {
    await expectDispatchCode([statusRoute(500, { message: "boom" })], "network", 500);
  });

  test("503 → network", async () => {
    await expectDispatchCode([statusRoute(503, { message: "Service Unavailable" })], "network", 503);
  });

  test("fetchImpl 抛 TypeError → network（无 status）", async () => {
    const hub = new GithubA2aHub({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
      owner: OWNER,
      repo: REPO,
      token: TOKEN,
    });
    let caught: unknown;
    try {
      await hub.dispatchTask("T1", SPEC);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GithubA2aError);
    const err = caught as GithubA2aError;
    expect(err.code).toBe("network");
    expect(err.status).toBeUndefined();
  });

  test("200 但响应体非 JSON → network", async () => {
    const { hub } = fixture([
      ["GET", /\/git\/ref\/heads\/main$/, () => new Response("<html>oops</html>", { status: 200 })],
    ]);
    await expect(hub.dispatchTask("T1", SPEC)).rejects.toMatchObject({ code: "network" });
  });
});

// ---------------------------------------------------------------------------
// A2A 信封 export / import（复用 BI-15.3 signEnvelope / verifyEnvelope）
// ---------------------------------------------------------------------------

describe("A2A 信封 export/import", () => {
  test("往返：exportTaskEnvelope → importTaskEnvelope 保留 taskId/kind/data", () => {
    const signed = exportTaskEnvelope(
      "T1",
      "spec",
      { action: "repo-scan", depth: 3 },
      { from: "coordinator", to: "builder", ts: NOW, nonce: "nonce-001" },
      SECRET,
    );
    const verdict = importTaskEnvelope(signed, {
      secret: SECRET,
      allowFrom: ["coordinator"],
      now: NOW,
      replayStore: new MemoryReplayStore(),
    });
    expect(verdict.valid).toBe(true);
    if (verdict.valid) {
      expect(verdict.taskId).toBe("T1");
      expect(verdict.kind).toBe("spec");
      expect(verdict.data).toEqual({ action: "repo-scan", depth: 3 });
    }
  });

  test("result 载荷同样可签名往返", () => {
    const signed = exportTaskEnvelope(
      "T2",
      "result",
      { ok: true, findings: 0 },
      { from: "builder", to: "coordinator", ts: NOW, nonce: "nonce-002" },
      SECRET,
    );
    const verdict = importTaskEnvelope(signed, {
      secret: SECRET,
      allowFrom: ["builder"],
      now: NOW,
      replayStore: new MemoryReplayStore(),
    });
    expect(verdict.valid).toBe(true);
  });

  test("篡改 payload → bad-signature", () => {
    const signed = exportTaskEnvelope(
      "T1",
      "spec",
      { keep: true },
      { from: "coordinator", to: "builder", ts: NOW, nonce: "nonce-003" },
      SECRET,
    );
    const tampered = { ...signed, payload: { ...signed.payload, data: { keep: false } } };
    const verdict = importTaskEnvelope(tampered, {
      secret: SECRET,
      allowFrom: ["coordinator"],
      now: NOW,
      replayStore: new MemoryReplayStore(),
    });
    expect(verdict).toEqual({ valid: false, reason: "bad-signature" });
  });

  test("载荷形状破坏（缺 kind/data）→ malformed", () => {
    const signed = signEnvelope(
      {
        from: "coordinator",
        to: "builder",
        ts: NOW,
        nonce: "nonce-004",
        payload: { taskId: "T1" } as unknown as { taskId: string; kind: "spec"; data: unknown },
      },
      SECRET,
    );
    const verdict = importTaskEnvelope(signed, {
      secret: SECRET,
      allowFrom: ["coordinator"],
      now: NOW,
      replayStore: new MemoryReplayStore(),
    });
    expect(verdict).toEqual({ valid: false, reason: "malformed" });
  });

  test("载荷 taskId 含路径穿越 → malformed（本地形状校验）", () => {
    const signed = signEnvelope(
      {
        from: "coordinator",
        to: "builder",
        ts: NOW,
        nonce: "nonce-005",
        payload: { taskId: "../evil", kind: "spec" as const, data: null },
      },
      SECRET,
    );
    const verdict = importTaskEnvelope(signed, {
      secret: SECRET,
      allowFrom: ["coordinator"],
      now: NOW,
      replayStore: new MemoryReplayStore(),
    });
    expect(verdict).toEqual({ valid: false, reason: "malformed" });
  });

  test("白名单外发件人 → unknown-sender；过期 ts → expired", () => {
    const signed = exportTaskEnvelope(
      "T1",
      "spec",
      { x: 1 },
      { from: "intruder", to: "builder", ts: NOW, nonce: "nonce-006" },
      SECRET,
    );
    expect(
      importTaskEnvelope(signed, {
        secret: SECRET,
        allowFrom: ["coordinator"],
        now: NOW,
        replayStore: new MemoryReplayStore(),
      }),
    ).toEqual({ valid: false, reason: "unknown-sender" });

    const stale = exportTaskEnvelope(
      "T1",
      "spec",
      { x: 1 },
      { from: "coordinator", to: "builder", ts: NOW, nonce: "nonce-007" },
      SECRET,
    );
    expect(
      importTaskEnvelope(stale, {
        secret: SECRET,
        allowFrom: ["coordinator"],
        now: NOW + 300_001,
        replayStore: new MemoryReplayStore(),
      }),
    ).toEqual({ valid: false, reason: "expired" });
  });

  test("exportTaskEnvelope 本地校验：非法 taskId / kind → RangeError", () => {
    expect(() =>
      exportTaskEnvelope("../evil", "spec", {}, { from: "a", to: "b" }, SECRET),
    ).toThrow(RangeError);
    expect(() =>
      exportTaskEnvelope("T1", "bogus" as "spec", {}, { from: "a", to: "b" }, SECRET),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// host TransportPort 形态门面
// ---------------------------------------------------------------------------

describe("GithubA2aHub 传输端口形态（host TransportPort）", () => {
  test("asTransport：name + send 把签名信封落盘到 bi-tasks/<id>/envelope.json", async () => {
    const { hub, calls } = fixture(flowRoutes());
    const signed = exportTaskEnvelope(
      "T1",
      "result",
      { ok: true },
      { from: "builder", to: "coordinator", ts: NOW, nonce: "nonce-008" },
      SECRET,
    );
    const transport = hub.asTransport();
    expect(transport.name).toBe("github-a2a-hub");
    await transport.send(signed);
    const putCall = nth(calls, 1);
    expect(putCall.method).toBe("PUT");
    expect(putCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/contents/bi-tasks/T1/envelope.json`);
    expect(putCall.body?.branch).toBe("main");
    expect(decodeContent(putCall.body)).toBe(JSON.stringify(signed));
  });

  test("send 无 taskId payload → 回退 bi-a2a/messages/<nonce>.json", async () => {
    const { hub, calls } = fixture(flowRoutes());
    const signed = signEnvelope(
      { from: "coordinator", to: "builder", ts: NOW, nonce: "nonce-009", payload: { ping: true } },
      SECRET,
    );
    const transport = hub.asTransport();
    await transport.send(signed);
    const putCall = nth(calls, 1);
    expect(putCall.url.pathname).toBe(`/repos/${OWNER}/${REPO}/contents/bi-a2a/messages/nonce-009.json`);
  });

  test("onMessage + pollResult：result.json（base64 含折行）解码透传给订阅者", async () => {
    const raw = encodeTaskJson(RESULT);
    const folded = (raw.length > 0 ? Buffer.from(raw, "utf8").toString("base64") : "").replace(
      /.{16}/g,
      (chunk) => `${chunk}\n`,
    );
    const { hub } = fixture([
      [
        "GET",
        /\/contents\/bi-tasks\/T1\/result\.json$/,
        () => json(200, { sha: EXISTING_SHA, content: folded, encoding: "base64" }),
      ],
    ]);
    const received: unknown[] = [];
    const transport = hub.asTransport();
    transport.onMessage((rawMsg) => {
      received.push(rawMsg);
    });
    const delivered = await hub.pollResult("T1");
    expect(delivered).toBe(true);
    expect(received).toEqual([RESULT]);
  });

  test("pollResult 404 → not_found", async () => {
    const { hub } = fixture(flowRoutes());
    await expect(hub.pollResult("T-missing")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

// ---------------------------------------------------------------------------
// 安全红线：协议头与日志脱敏（零数据外泄）
// ---------------------------------------------------------------------------

describe("安全红线", () => {
  test("REST 请求头：Bearer 授权 + GitHub API 版本 + User-Agent + Accept", async () => {
    const { hub, calls } = fixture(flowRoutes());
    await hub.dispatchTask("T1", SPEC);
    const headers = nth(calls, 0).headers;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN_TEXT}`);
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["User-Agent"]).toContain("bi-a2a-hub");
    // 写请求（PUT contents）才携带 JSON Content-Type
    const putHeaders = nth(calls, 3).headers;
    expect(putHeaders["Content-Type"]).toBe("application/json");
    expect(putHeaders["Authorization"]).toBe(`Bearer ${TOKEN_TEXT}`);
  });

  test("token 不入日志：失败流程后 logs/错误消息/审计全量扫描零泄露", async () => {
    const leakToken = "ghp_SUPER_secret_token_9876543210zzz";
    const { hub } = fixture([statusRoute(500, { message: "Internal error" })], {
      token: githubToken(leakToken),
    });
    let caught: unknown;
    try {
      await hub.dispatchTask("T1", SPEC);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GithubA2aError);
    const err = caught as GithubA2aError;
    const allLogs = hub.logs().join("\n");
    expect(allLogs).not.toContain(leakToken);
    expect(allLogs).not.toContain("Bearer");
    expect(err.message).not.toContain(leakToken);
    expect(JSON.stringify(hub.mergeDecisions())).not.toContain(leakToken);
    // 日志确有内容（脱敏不等于静默）：method+path+status 可观测
    expect(allLogs).toContain("github GET /repos/bi-org/bi-tasks/git/ref/heads/main -> 500");
    expect(allLogs).toContain("code=network");
  });

  test("错误消息携带 GitHub message 且经脱敏通道", async () => {
    const err = await expectDispatchCode(
      [statusRoute(403, { message: "Forbidden" })],
      "auth",
      403,
    );
    expect(err.message).toContain("[github-a2a-hub:auth]");
    expect(err.message).toContain("Forbidden");
    expect(err.message).not.toContain(TOKEN_TEXT);
  });
});
