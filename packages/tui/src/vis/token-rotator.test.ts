/**
 * BI-20.5 — TokenRotator 单元测试（注入时钟 + 注入随机源，零等待确定性验证）。
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GRACE_MS,
  DEFAULT_ROTATION_MS,
  TokenRotator,
  accessUrls,
  randomToken128,
  type InterfacesProvider,
  type VisClock,
} from "./token-rotator";

class FakeClock implements VisClock {
  constructor(private t: number = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** 确定性 32 位 hex 令牌序列：000...01, 000...02, ... */
function seqTokens(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return n.toString(16).padStart(32, "0");
  };
}

describe("TokenRotator 令牌生成", () => {
  test("默认随机令牌为 32 位小写 hex（128-bit）", () => {
    expect(randomToken128()).toMatch(/^[0-9a-f]{32}$/);
    const rotator = new TokenRotator();
    expect(rotator.current()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("周期内 current() 幂等（推进半个周期不变）", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const first = rotator.current();
    clock.advance(DEFAULT_ROTATION_MS / 2);
    expect(rotator.current()).toBe(first);
    clock.advance(DEFAULT_ROTATION_MS / 2 - 1);
    expect(rotator.current()).toBe(first);
  });

  test("到达轮转周期后 current() 惰性轮转出新令牌", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const oldToken = rotator.current();
    clock.advance(DEFAULT_ROTATION_MS);
    const newToken = rotator.current();
    expect(newToken).not.toBe(oldToken);
    expect(rotator.current()).toBe(newToken);
  });

  test("多轮轮转令牌互不相同", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const seen = new Set<string>([rotator.current()]);
    for (let i = 0; i < 5; i++) {
      clock.advance(DEFAULT_ROTATION_MS);
      seen.add(rotator.current());
    }
    expect(seen.size).toBe(6);
  });

  test("rotate() 显式立即轮转并返回新令牌", () => {
    const rotator = new TokenRotator({ randomToken: seqTokens() });
    const oldToken = rotator.current();
    const newToken = rotator.rotate();
    expect(newToken).not.toBe(oldToken);
    expect(rotator.current()).toBe(newToken);
  });

  test("构造参数校验：rotationMs<=0 与 graceMs<0 抛 RangeError", () => {
    expect(() => new TokenRotator({ rotationMs: 0 })).toThrow(RangeError);
    expect(() => new TokenRotator({ rotationMs: -1 })).toThrow(RangeError);
    expect(() => new TokenRotator({ graceMs: -1 })).toThrow(RangeError);
  });

  test("默认常量：轮转 5 分钟、宽限 60 秒", () => {
    expect(DEFAULT_ROTATION_MS).toBe(300_000);
    expect(DEFAULT_GRACE_MS).toBe(60_000);
  });
});

describe("TokenRotator 令牌校验与宽限双活", () => {
  test("当前令牌 validate=true，未知令牌 validate=false", () => {
    const rotator = new TokenRotator({ randomToken: seqTokens() });
    const token = rotator.current();
    expect(rotator.validate(token)).toBe(true);
    expect(rotator.validate("deadbeef".repeat(4))).toBe(false);
  });

  test("validate(null/undefined/空串) 一律 false", () => {
    const rotator = new TokenRotator();
    expect(rotator.validate(null)).toBe(false);
    expect(rotator.validate(undefined)).toBe(false);
    expect(rotator.validate("")).toBe(false);
  });

  test("轮转后宽限期内旧令牌双活（validate=true）", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const oldToken = rotator.current();
    rotator.rotate();
    clock.advance(DEFAULT_GRACE_MS - 1_000);
    expect(rotator.validate(oldToken)).toBe(true);
    expect(rotator.validate(rotator.current())).toBe(true);
  });

  test("宽限边界：advance(graceMs-1) 仍双活、advance(graceMs) 即失效", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const oldToken = rotator.current();
    rotator.rotate();
    clock.advance(DEFAULT_GRACE_MS - 1);
    expect(rotator.validate(oldToken)).toBe(true);
    clock.advance(1);
    expect(rotator.validate(oldToken)).toBe(false);
  });

  test("宽限过期：advance(graceMs+1) 后旧令牌失效", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const oldToken = rotator.current();
    rotator.rotate();
    clock.advance(DEFAULT_GRACE_MS + 1);
    expect(rotator.validate(oldToken)).toBe(false);
    expect(rotator.validate(rotator.current())).toBe(true);
  });

  test("graceMs=0：轮转后旧令牌立即失效", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, graceMs: 0, randomToken: seqTokens() });
    const oldToken = rotator.current();
    rotator.rotate();
    expect(rotator.validate(oldToken)).toBe(false);
    expect(rotator.validate(rotator.current())).toBe(true);
  });

  test("两次轮转后第一代令牌立即失效（只保留一代宽限）", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const first = rotator.current();
    rotator.rotate();
    rotator.rotate();
    clock.advance(0);
    expect(rotator.validate(first)).toBe(false);
  });

  test("自定义 rotationMs 生效（半周期不轮转、满周期轮转）", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, rotationMs: 2_000, randomToken: seqTokens() });
    const first = rotator.current();
    clock.advance(1_000);
    expect(rotator.current()).toBe(first);
    clock.advance(1_000);
    expect(rotator.current()).not.toBe(first);
  });

  test("rotate(now) 显式指定轮转时刻，宽限窗口以该时刻起算", () => {
    const clock = new FakeClock(10_000);
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    const oldToken = rotator.current();
    rotator.rotate(12_000);
    clock.advance(2_050); // 虚拟时刻 12050，距轮转 50ms
    expect(rotator.validate(oldToken)).toBe(true);
    clock.advance(60_000); // 距轮转 60050ms > 宽限
    expect(rotator.validate(oldToken)).toBe(false);
  });

  test("graceActive() 探针：初始 false、轮转后 true、过期后 false", () => {
    const clock = new FakeClock();
    const rotator = new TokenRotator({ clock, randomToken: seqTokens() });
    expect(rotator.graceActive()).toBe(false);
    rotator.rotate();
    expect(rotator.graceActive()).toBe(true);
    clock.advance(DEFAULT_GRACE_MS + 1);
    expect(rotator.graceActive()).toBe(false);
  });
});

describe("accessUrls 构造", () => {
  const stub: InterfacesProvider = () => ({
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "192.168.1.7", family: "IPv4", internal: false }],
    eth0v6: [{ address: "fe80::1", family: "IPv6", internal: false }],
  });

  test("首项恒为 http://127.0.0.1:<port>/?t=<token> 形态", () => {
    const urls = accessUrls(8080, "abc123");
    expect(urls[0]).toBe("http://127.0.0.1:8080/?t=abc123");
    expect(urls.length).toBeGreaterThanOrEqual(1);
  });

  test("多接口枚举：internal 回环跳过、IPv4 收录、IPv6 跳过", () => {
    const urls = accessUrls(8080, "abc123", { interfaces: stub });
    expect(urls).toContain("http://192.168.1.7:8080/?t=abc123");
    expect(urls.every((u) => !u.includes("fe80"))).toBe(true);
    expect(urls.every((u) => !u.includes("internal"))).toBe(true);
    expect(urls[0]).toBe("http://127.0.0.1:8080/?t=abc123");
  });

  test("family 为数值 4 的地址也被收录", () => {
    const urls = accessUrls(9, "t", {
      interfaces: () => ({ wg0: [{ address: "10.0.0.2", family: 4, internal: false }] }),
    });
    expect(urls).toContain("http://10.0.0.2:9/?t=t");
  });

  test("重复地址去重，token 逐 URL 携带", () => {
    const urls = accessUrls(1, "aabb", {
      interfaces: () => ({
        eth0: [{ address: "192.168.1.7", family: "IPv4", internal: false }],
        eth1: [{ address: "192.168.1.7", family: "IPv4", internal: false }],
      }),
    });
    expect(urls).toHaveLength(2); // 127.0.0.1 + 去重后的 192.168.1.7
    expect(urls.every((u) => u.endsWith("t=aabb"))).toBe(true);
  });

  test("path 选项定制页面路径", () => {
    const urls = accessUrls(3000, "xy", { path: "/index.html" });
    expect(urls[0]).toBe("http://127.0.0.1:3000/index.html?t=xy");
  });
});
