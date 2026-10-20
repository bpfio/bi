/**
 * BI-20.5 接线 —— vis 令牌轮转（env 门）验收。
 *
 * 覆盖：
 *   - env BI_VIS_TOKEN_ROTATE=1 且宿主注入权威 → 令牌校验走权威（宽限内旧令牌仍过）；
 *   - env 关闭 → 走现状静态令牌路径（工厂零调用，行为回归）；
 *   - env 开启但未注入权威 → 回退静态路径并如实告警（不静默降级）；
 *   - env 开启 → 打印带令牌的访问链接。
 *
 * 测试零外呼：注入 serve 工厂捕获 fetch（不真实监听），注入会话管理器替身。
 */
import { describe, expect, test } from "bun:test";

import { handleVis, TOKEN_ROTATE_ENV, type VisServerDeps } from "./vis";
import type { SessionMeta } from "../../session/types";

const fakeManager = {
  listSessions: async (): Promise<SessionMeta[]> => [],
  getSessionMeta: async (): Promise<SessionMeta | undefined> => undefined,
  entries: async () => [],
} as never;

/** 轮转权威替身：当前令牌恒真 + 上一代令牌宽限期内双活（口径同 TokenRotator）。 */
class StubAuthority {
  currentToken = "tok-new";
  graceToken: string | null = "tok-old";

  current(): string {
    return this.currentToken;
  }

  validate(token: string | null | undefined): boolean {
    if (typeof token !== "string" || token.length === 0) return false;
    return token === this.currentToken || token === this.graceToken;
  }
}

interface Harness {
  io: { out: (line: string) => void; err: (line: string) => void };
  outs: string[];
  errs: string[];
  /** serve 工厂捕获的 fetch（不真实监听）。 */
  fetch: (request: Request) => Promise<Response>;
  getEnv: (name: string) => string | undefined;
  serve: VisServerDeps["serve"];
}

function makeHarness(env: Record<string, string | undefined>): Harness {
  const outs: string[] = [];
  const errs: string[] = [];
  let captured: ((request: Request) => Promise<Response>) | undefined;
  const serve: VisServerDeps["serve"] = (options) => {
    captured = options.fetch;
    return { port: 5173, stop: () => {} };
  };
  return {
    io: { out: (l) => outs.push(l), err: (l) => errs.push(l) },
    outs,
    errs,
    fetch: (request) => {
      if (captured === undefined) throw new Error("serve 工厂未捕获 fetch");
      return captured(request);
    },
    getEnv: (name: string) => env[name],
    serve,
  };
}

describe("BI-20.5 接线 · vis 令牌轮转（env 门）", () => {
  test("env 开启 + 注入权威：令牌校验走权威（宽限内旧令牌仍过）", async () => {
    const h = makeHarness({ [TOKEN_ROTATE_ENV]: "1" });
    const authority = new StubAuthority();
    const code = await handleVis([], h.io, {}, {
      serve: h.serve,
      getEnv: h.getEnv,
      attachSignals: false,
      tokenAuthority: () => authority,
    });
    expect(code).toBe(0);
    // 当前令牌与宽限内的上一代令牌均放行；无关令牌与缺令牌 401
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions?t=tok-new"))).status).toBe(200);
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions?t=tok-old"))).status).toBe(200);
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions?t=other"))).status).toBe(401);
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions"))).status).toBe(401);
    // 宽限耗尽后旧令牌失效（替身清空 grace 即等价过期）
    authority.graceToken = null;
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions?t=tok-old"))).status).toBe(401);
  });

  test("env 开启：打印带令牌的访问链接 + 轮转说明", async () => {
    const h = makeHarness({ [TOKEN_ROTATE_ENV]: "1" });
    await handleVis([], h.io, {}, {
      serve: h.serve,
      getEnv: h.getEnv,
      attachSignals: false,
      tokenAuthority: () => new StubAuthority(),
    });
    const text = h.outs.join("\n");
    expect(text).toContain("http://127.0.0.1:5173/?t=tok-new");
    expect(text).toContain(TOKEN_ROTATE_ENV);
  });

  test("env 关闭：走现状静态令牌路径（工厂零调用）", async () => {
    const h = makeHarness({});
    let factoryCalls = 0;
    const code = await handleVis([], h.io, {}, {
      serve: h.serve,
      getEnv: h.getEnv,
      attachSignals: false,
      tokenAuthority: () => {
        factoryCalls += 1;
        return new StubAuthority();
      },
    });
    expect(code).toBe(0);
    expect(factoryCalls).toBe(0); // env 未开 → 权威工厂零调用
    // 回环 + 无令牌 → 现状：/api/sessions 免令牌放行
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions"))).status).toBe(200);
    expect(h.outs.join("\n")).not.toContain("?t=");
  });

  test("env 关闭 + 非回环：现状静态令牌（BI_VIS_AUTH_TOKEN）仍生效", async () => {
    const h = makeHarness({ BI_VIS_AUTH_TOKEN: "static-tok" });
    const code = await handleVis(["--host", "0.0.0.0"], h.io, {}, {
      serve: h.serve,
      getEnv: h.getEnv,
      attachSignals: false,
      tokenAuthority: () => new StubAuthority(),
    });
    expect(code).toBe(0);
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions?t=static-tok"))).status).toBe(200);
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions?t=other"))).status).toBe(401);
    expect(h.outs.join("\n")).toContain("已启用令牌校验");
  });

  test("env 开启但未注入权威：回退静态路径并如实告警（不静默降级）", async () => {
    const h = makeHarness({ [TOKEN_ROTATE_ENV]: "1" });
    const code = await handleVis([], h.io, {}, {
      serve: h.serve,
      getEnv: h.getEnv,
      attachSignals: false,
    });
    expect(code).toBe(0);
    expect(h.errs.join("\n")).toContain(TOKEN_ROTATE_ENV);
    expect(h.errs.join("\n")).toContain("回退静态令牌路径");
    // 回环 + 无静态令牌 → 现状：免令牌放行
    expect((await h.fetch(new Request("http://127.0.0.1/api/sessions"))).status).toBe(200);
  });

  test("env 值非 '1'（如 '0'/'true'）：视为关闭，走现状路径", async () => {
    for (const value of ["0", "true", "yes", ""]) {
      const h = makeHarness({ [TOKEN_ROTATE_ENV]: value });
      let factoryCalls = 0;
      await handleVis([], h.io, {}, {
        serve: h.serve,
        getEnv: h.getEnv,
        attachSignals: false,
        tokenAuthority: () => {
          factoryCalls += 1;
          return new StubAuthority();
        },
      });
      expect(factoryCalls).toBe(0);
    }
  });
});
