import { describe, expect, test } from "bun:test";

import { role, type Secret } from "../auth/types";
import {
  buildFingerprintHeaders,
  DEFAULT_USER_AGENT,
  FINGERPRINT_HEADER_PLAN_KEY,
  FINGERPRINT_HEADER_TRACE_ID,
  FINGERPRINT_HEADER_USER_AGENT,
  FINGERPRINT_MASK_PREFIX,
  redactFingerprint,
} from "./fingerprint";

/** 假 key（仅测试内存值，非真实凭据，命名显式标注 PLAINTEXT 便于断言无泄漏）。 */
const API_KEY = "ultra-test-key-PLAINTEXT-abcd1234";

function apiKey(): Secret {
  return role("secret", API_KEY);
}

describe("buildFingerprintHeaders · 标头组完整性与顺序无关性", () => {
  test("恰好三个指纹标头，无多余键", () => {
    const headers = buildFingerprintHeaders({ apiKey: apiKey() });
    expect(Object.keys(headers).sort()).toEqual(
      [FINGERPRINT_HEADER_PLAN_KEY, FINGERPRINT_HEADER_USER_AGENT, FINGERPRINT_HEADER_TRACE_ID].sort(),
    );
  });

  test("按名取值与键序无关：plan key 为注入 Secret，UA 为缺省指纹", () => {
    const headers = buildFingerprintHeaders({ apiKey: apiKey() });
    expect(headers[FINGERPRINT_HEADER_PLAN_KEY]).toBe(API_KEY);
    expect(headers[FINGERPRINT_HEADER_USER_AGENT]).toBe(DEFAULT_USER_AGENT);
    expect(headers[FINGERPRINT_HEADER_USER_AGENT]).toBe("zcode-cli/0.1.8");
  });

  test("User-Agent 缺省值可配置覆盖", () => {
    const headers = buildFingerprintHeaders({ apiKey: apiKey(), userAgent: "custom-agent/9.9" });
    expect(headers[FINGERPRINT_HEADER_USER_AGENT]).toBe("custom-agent/9.9");
    expect(headers[FINGERPRINT_HEADER_PLAN_KEY]).toBe(API_KEY);
  });

  test("显式 traceId 原样透传", () => {
    const headers = buildFingerprintHeaders({ apiKey: apiKey(), traceId: "fixed-trace-id" });
    expect(headers[FINGERPRINT_HEADER_TRACE_ID]).toBe("fixed-trace-id");
  });

  test("traceIdGenerator 注入确定性：每次构造取一次生成器输出", () => {
    let calls = 0;
    const generator = () => {
      calls += 1;
      return `trace-${calls}`;
    };
    const first = buildFingerprintHeaders({ apiKey: apiKey(), traceIdGenerator: generator });
    const second = buildFingerprintHeaders({ apiKey: apiKey(), traceIdGenerator: generator });
    expect(first[FINGERPRINT_HEADER_TRACE_ID]).toBe("trace-1");
    expect(second[FINGERPRINT_HEADER_TRACE_ID]).toBe("trace-2");
    expect(calls).toBe(2);
  });

  test("缺省 traceId 为 16 字节（32 位小写 hex），且两次生成互不相同", () => {
    const first = buildFingerprintHeaders({ apiKey: apiKey() });
    const second = buildFingerprintHeaders({ apiKey: apiKey() });
    const traceFirst = first[FINGERPRINT_HEADER_TRACE_ID]!;
    const traceSecond = second[FINGERPRINT_HEADER_TRACE_ID]!;
    expect(traceFirst).toMatch(/^[0-9a-f]{32}$/);
    expect(traceSecond).toMatch(/^[0-9a-f]{32}$/);
    expect(traceFirst).not.toBe(traceSecond);
  });

  test("优先级：显式 traceId 高于 traceIdGenerator（generator 不被调用）", () => {
    let called = false;
    const headers = buildFingerprintHeaders({
      apiKey: apiKey(),
      traceId: "explicit-wins",
      traceIdGenerator: () => {
        called = true;
        return "unused";
      },
    });
    expect(headers[FINGERPRINT_HEADER_TRACE_ID]).toBe("explicit-wins");
    expect(called).toBe(false);
  });

  test("空 apiKey 抛 TypeError（错误消息不回显凭据内容）", () => {
    expect(() => buildFingerprintHeaders({ apiKey: role("secret", "") })).toThrow(TypeError);
  });

  test("空 userAgent 抛 TypeError", () => {
    expect(() => buildFingerprintHeaders({ apiKey: apiKey(), userAgent: "" })).toThrow(TypeError);
  });
});

describe("redactFingerprint · 日志/错误路径脱敏", () => {
  test("三个指纹标头均遮蔽为 ze-***last4", () => {
    const raw = buildFingerprintHeaders({ apiKey: apiKey(), traceId: "0123456789abcdef" });
    const masked = redactFingerprint(raw);
    expect(masked[FINGERPRINT_HEADER_PLAN_KEY]).toBe("ze-***1234");
    expect(masked[FINGERPRINT_HEADER_USER_AGENT]).toBe("ze-***.1.8");
    expect(masked[FINGERPRINT_HEADER_TRACE_ID]).toBe("ze-***cdef");
  });

  test("对其他标头不动：键名大小写与值均原样保留", () => {
    const masked = redactFingerprint({
      Authorization: "Bearer test-token",
      "content-type": "application/json",
      "X-Custom-Trace": "keep-me",
    });
    expect(masked).toEqual({
      Authorization: "Bearer test-token",
      "content-type": "application/json",
      "X-Custom-Trace": "keep-me",
    });
  });

  test("指纹标头名大小写变体同样被遮蔽", () => {
    const masked = redactFingerprint({
      "x-coding-plan-api-key": "lowercase-variant-key",
      "USER-AGENT": "SomeAgent/1.0",
      "X-Zcode-Trace-Id": "mixedcase-trace-9",
    });
    expect(masked["x-coding-plan-api-key"]).toBe("ze-***-key");
    expect(masked["USER-AGENT"]).toBe("ze-***/1.0");
    expect(masked["X-Zcode-Trace-Id"]).toBe("ze-***ce-9");
  });

  test("短值（≤4 字符）与空值整体遮蔽为 ze-***，不泄漏 last4", () => {
    const masked = redactFingerprint({
      [FINGERPRINT_HEADER_PLAN_KEY]: "abcd",
      [FINGERPRINT_HEADER_TRACE_ID]: "",
    });
    expect(masked[FINGERPRINT_HEADER_PLAN_KEY]).toBe("ze-***");
    expect(masked[FINGERPRINT_HEADER_TRACE_ID]).toBe("ze-***");
  });

  test("混合记录：指纹标头遮蔽、普通标头原样，各自归位", () => {
    const masked = redactFingerprint({
      "x-coding-plan-api-key": API_KEY,
      authorization: "Bearer test-token",
      "x-zcode-trace-id": "ffffffffffffffffffffffffffffffff",
    });
    expect(masked["x-coding-plan-api-key"]).toBe("ze-***1234");
    expect(masked.authorization).toBe("Bearer test-token");
    expect(masked["x-zcode-trace-id"]).toBe("ze-***ffff");
  });

  test("全记录序列化后不含 key 明文", () => {
    const raw = buildFingerprintHeaders({ apiKey: apiKey() });
    const serialized = JSON.stringify(redactFingerprint(raw));
    expect(serialized.includes(API_KEY)).toBe(false);
    expect(serialized.includes("PLAINTEXT")).toBe(false);
  });
});
