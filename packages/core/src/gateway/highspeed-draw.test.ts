import { describe, expect, test } from "bun:test";

import type { FetchLike } from "../auth/http";
import { role } from "../auth/types";
import {
  DEFAULT_HIGHSPEED_BASE_URL,
  DEFAULT_HIGHSPEED_DRAW_PATH,
  HIGHSPEED_TOKEN_EXPIRED_CODE,
  HighspeedDraw,
  HighspeedDrawError,
  isTokenExpiredCode,
} from "./highspeed-draw";

const TOKEN_A = role("secret", "hs-token-PLAINTEXT-do-not-leak-A");
const TOKEN_B = role("secret", "hs-token-PLAINTEXT-do-not-leak-B");

function drawResponse(hit: boolean, token?: string, ttlMs?: number): Response {
  return new Response(
    JSON.stringify(hit ? { hit: true, token, ...(ttlMs === undefined ? {} : { ttlMs }) } : { hit: false }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function captureFetch(respond: (req: CapturedRequest, call: number) => Response): {
  fetch: FetchLike;
  requests: CapturedRequest[];
  count: () => number;
} {
  const requests: CapturedRequest[] = [];
  const doFetch = ((url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const request: CapturedRequest = { url, method: init?.method ?? "GET", headers };
    requests.push(request);
    return Promise.resolve(respond(request, requests.length));
  }) as FetchLike;
  return { fetch: doFetch, requests, count: () => requests.length };
}

describe("HighspeedDraw · draw 命中与持牌", () => {
  test("命中：POST 注入 drawPath（缺省布线正确），token 包装为 Secret，current() 持有", async () => {
    const { fetch, requests } = captureFetch(() => drawResponse(true, TOKEN_A, 30_000));
    const svc = new HighspeedDraw({ fetchImpl: fetch, baseUrl: "https://stub.example" });
    const outcome = await svc.draw();

    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url).toBe("https://stub.example/api/highspeed/draw");
    expect(outcome).toMatchObject({ ok: true, hit: true, ttlMs: 30_000 });
    if (outcome.ok && outcome.hit) {
      expect(outcome.token).toBe(TOKEN_A); // role("secret") 零开销透传
    }
    expect(svc.current()?.token).toBe(TOKEN_A);
    expect(svc.current()?.expiresAt).toBe(outcome.ok && outcome.hit ? outcome.drawnAt + 30_000 : undefined);

    const { fetch: fetch2, requests: requests2 } = captureFetch(() => drawResponse(true, TOKEN_A));
    await new HighspeedDraw({ fetchImpl: fetch2 }).draw();
    expect(requests2[0]!.url).toBe(`${DEFAULT_HIGHSPEED_BASE_URL}${DEFAULT_HIGHSPEED_DRAW_PATH}`);
  });

  test("未命中：hit:false 无 token，不持牌", async () => {
    const { fetch } = captureFetch(() => drawResponse(false));
    const svc = new HighspeedDraw({ fetchImpl: fetch });
    const outcome = await svc.draw();
    expect(outcome).toMatchObject({ ok: true, hit: false });
    expect(svc.current()).toBeUndefined();
  });

  test("畸形响应：缺 hit / 命中缺 token / ttlMs 非正 → protocol（不抛异常）", async () => {
    const cases: unknown[] = [{ token: TOKEN_A }, { hit: true }, { hit: true, token: "" }, { hit: true, token: TOKEN_A, ttlMs: 0 }];
    for (const body of cases) {
      const svc = new HighspeedDraw({
        fetchImpl: captureFetch(() => new Response(JSON.stringify(body), { status: 200 })).fetch,
      });
      const outcome = await svc.draw();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.failure.kind).toBe("protocol");
    }
  });

  test("HTTP 500 → http 失败；fetch 拒绝 → network 失败", async () => {
    const httpErr = await new HighspeedDraw({
      fetchImpl: captureFetch(() => new Response("{}", { status: 500 })).fetch,
    })
      .draw()
      .then((o) => o);
    expect(httpErr.ok).toBe(false);
    if (!httpErr.ok) expect(httpErr.failure.kind).toBe("http");

    const doFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchLike;
    const networkErr = await new HighspeedDraw({ fetchImpl: doFetch })
      .draw()
      .then((o) => o);
    expect(networkErr.ok).toBe(false);
    if (!networkErr.ok) expect(networkErr.failure.kind).toBe("network");
  });
});

describe("HighspeedDraw · 抽卡冷却（注入时钟）", () => {
  test("冷却期内 draw → cooldown 结果，不触网（fetch 计数不变）附 retryAfterMs", async () => {
    const now = { value: 1_000 };
    const { fetch, count } = captureFetch(() => drawResponse(true, TOKEN_A));
    const svc = new HighspeedDraw({ fetchImpl: fetch, cooldownMs: 1_000, now: () => now.value });

    const first = await svc.draw();
    expect(first.ok).toBe(true);
    expect(count()).toBe(1);

    now.value = 1_400; // 冷却期内
    const second = await svc.draw();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.failure.kind).toBe("cooldown");
      expect(second.failure.retryAfterMs).toBe(600);
    }
    expect(count()).toBe(1); // 冷却拦截，零网络
  });

  test("注入时钟推进过冷却 → 再次真实 draw；尝试即刷新冷却计时", async () => {
    const now = { value: 1_000 };
    const { fetch, count } = captureFetch(() => drawResponse(true, TOKEN_A));
    const svc = new HighspeedDraw({ fetchImpl: fetch, cooldownMs: 1_000, now: () => now.value });

    await svc.draw();
    now.value = 2_100;
    const second = await svc.draw();
    expect(second.ok).toBe(true);
    expect(count()).toBe(2);

    // 失败尝试同样刷新冷却计时（防对失败端点连打）
    now.value = 2_200;
    const failing = new HighspeedDraw({
      fetchImpl: captureFetch(() => new Response("{}", { status: 500 })).fetch,
      cooldownMs: 1_000,
      now: () => now.value,
    });
    await failing.draw();
    now.value = 2_500;
    const blocked = await failing.draw();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.failure.kind).toBe("cooldown");
  });

  test("cooldownMs=0 不去抖；cooldownMs 负数 → config 错误", async () => {
    const { fetch, count } = captureFetch(() => drawResponse(true, TOKEN_A));
    const svc = new HighspeedDraw({ fetchImpl: fetch, cooldownMs: 0 });
    await svc.draw();
    await svc.draw();
    expect(count()).toBe(2);

    expect(() => new HighspeedDraw({ cooldownMs: -1 })).toThrowError(HighspeedDrawError);
  });
});

describe("HighspeedDraw · 3402 过期自愈与并发合并", () => {
  test("isTokenExpiredCode 对齐 3402 语义（常量可编程判断）", () => {
    expect(HIGHSPEED_TOKEN_EXPIRED_CODE).toBe(3402);
    expect(isTokenExpiredCode(3402)).toBe(true);
    expect(isTokenExpiredCode(3102)).toBe(false);
    expect(isTokenExpiredCode("3402")).toBe(false);
  });

  test("3402 后 recover → 重新 draw 一次并替换所持 token", async () => {
    const { fetch, requests } = captureFetch(() =>
      drawResponse(true, TOKEN_A, 1_000),
    );
    let call = 0;
    const { fetch: twoPhase, requests: twoPhaseRequests } = captureFetch(() => {
      call++;
      return drawResponse(true, call === 1 ? TOKEN_A : TOKEN_B);
    });
    const svc = new HighspeedDraw({ fetchImpl: twoPhase });

    const first = await svc.draw(); // 命中 TOKEN_A
    expect(svc.current()?.token).toBe(TOKEN_A);

    // 调用方用 TOKEN_A 打上游 → classifyFailure 观察到 3402 → recover()
    const recovered = await svc.recover();
    expect(recovered).toMatchObject({ ok: true, hit: true });
    if (recovered.ok && recovered.hit) expect(recovered.token).toBe(TOKEN_B);
    expect(svc.current()?.token).toBe(TOKEN_B); // 已替换
    expect(twoPhaseRequests.length).toBe(2);

    void fetch;
    void requests;
  });

  test("并发 recover 单飞合并：三次并发只发一次请求，共享同一 token", async () => {
    let call = 0;
    const { fetch } = captureFetch(() => {
      call++;
      return drawResponse(true, call === 1 ? TOKEN_A : TOKEN_B);
    });
    const svc = new HighspeedDraw({ fetchImpl: fetch, cooldownMs: 0 });
    await svc.draw(); // TOKEN_A

    const [r1, r2, r3] = await Promise.all([svc.recover(), svc.recover(), svc.recover()]);
    expect(call).toBe(2); // 初始 draw + 合并后的一次 recover
    expect(r1.ok && r1.hit && r1.token).toBe(TOKEN_B);
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(svc.current()?.token).toBe(TOKEN_B);
  });

  test("recover 重绘 miss → 清空所持失效 token；recover 失败 → 保持旧 token", async () => {
    const missFetch = captureFetch((_req, n) =>
      n <= 1 ? drawResponse(true, TOKEN_A) : drawResponse(false),
    );
    const svc = new HighspeedDraw({ fetchImpl: missFetch.fetch, cooldownMs: 0 });
    await svc.draw(); // 命中 TOKEN_A
    const miss = await svc.recover(); // 重绘未命中
    expect(miss.ok).toBe(true);
    expect(svc.current()).toBeUndefined();

    const failFetch = captureFetch((_req, n) =>
      n <= 1 ? drawResponse(true, TOKEN_A) : new Response("{}", { status: 503 }),
    );
    const svc2 = new HighspeedDraw({ fetchImpl: failFetch.fetch, cooldownMs: 0 });
    await svc2.draw(); // TOKEN_A
    const failed = await svc2.recover();
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.failure.kind).toBe("http");
    expect(svc2.current()?.token).toBe(TOKEN_A); // 旧 token 保持，调用方可重试
  });

  test("recover 绕过抽卡冷却（冷却期内自愈仍真实 draw）", async () => {
    const now = { value: 1_000 };
    let call = 0;
    const { fetch, count } = captureFetch(() => {
      call++;
      return drawResponse(true, call === 1 ? TOKEN_A : TOKEN_B);
    });
    const svc = new HighspeedDraw({ fetchImpl: fetch, cooldownMs: 1_000_000, now: () => now.value });
    await svc.draw(); // t=1000 命中 TOKEN_A

    now.value = 1_100; // 冷却期内
    const blocked = await svc.draw();
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.failure.kind).toBe("cooldown");

    const recovered = await svc.recover(); // 自愈不受冷却拦截
    expect(recovered.ok).toBe(true);
    expect(count()).toBe(2);
    expect(svc.current()?.token).toBe(TOKEN_B);
  });
});

describe("HighspeedDraw · 零网络与脱敏", () => {
  test("构造不触网；全程 stub 计数精确", async () => {
    const { fetch, count } = captureFetch(() => drawResponse(true, TOKEN_A));
    const svc = new HighspeedDraw({ fetchImpl: fetch });
    expect(count()).toBe(0);
    await svc.draw();
    await svc.recover();
    expect(count()).toBe(2);
  });

  test("日志不含 token 明文（响应正文不落日志）", async () => {
    const logs: string[] = [];
    const { fetch } = captureFetch(() => drawResponse(true, TOKEN_A));
    const svc = new HighspeedDraw({
      fetchImpl: fetch,
      headers: { "x-api-key": "sk-PLAINTEXT-draw-key-888" },
      log: (l) => logs.push(l),
    });
    await svc.draw();
    await svc.recover();
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(TOKEN_A);
    expect(all).not.toContain("hs-token-PLAINTEXT");
    expect(all).toContain("[REDACTED]");
  });
});
