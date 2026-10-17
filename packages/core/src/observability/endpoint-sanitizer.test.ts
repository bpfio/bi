import { describe, expect, test } from "bun:test";
import {
	DEFAULT_REDACTION_PATTERNS,
	INVALID_ENDPOINT_PLACEHOLDER,
	REDACTED,
	REDACTED_SEGMENT,
	sanitizeEndpoint,
	sanitizeErrorPayload,
} from "./endpoint-sanitizer";

describe("sanitizeEndpoint", () => {
	test("保留 scheme+host+端口，path 深处抹为 …", () => {
		expect(sanitizeEndpoint("https://api.example.com:8443/v1/users/42/orders")).toBe(
			"https://api.example.com:8443/v1/…",
		);
	});

	test("query 值全抹且键序保持", () => {
		expect(sanitizeEndpoint("https://api.example.com/v1/x?token=abc&page=2&q=%20hi")).toBe(
			"https://api.example.com/v1/…?token=…&page=…&q=…",
		);
	});

	test("白名单参数保留原值（大小写不敏感）", () => {
		expect(
			sanitizeEndpoint("https://api.example.com/v1/x?token=abc&page=2", { allowQueryParams: ["page"] }),
		).toBe("https://api.example.com/v1/…?token=…&page=2");
	});

	test("keepPathDepth=0 仅保留 host；=2 保留两段", () => {
		expect(sanitizeEndpoint("https://h.example.com/a/b/c", { keepPathDepth: 0 })).toBe(
			"https://h.example.com",
		);
		expect(sanitizeEndpoint("https://h.example.com/a/b/c", { keepPathDepth: 2 })).toBe(
			"https://h.example.com/a/b/…",
		);
	});

	test("无 path 无 query 原样保留 host", () => {
		expect(sanitizeEndpoint("https://collector.example.com:4318")).toBe(
			"https://collector.example.com:4318",
		);
	});

	test("无 scheme 的 host:port 兜底按 https 解析", () => {
		expect(sanitizeEndpoint("collector.otel:4317/v1/traces")).toBe(
			"https://collector.otel:4317/v1/…",
		);
	});

	test("不可解析字符串 → 安全占位（零泄漏）", () => {
		expect(sanitizeEndpoint("::garbage secret-value::")).toBe(INVALID_ENDPOINT_PLACEHOLDER);
	});

	test("userinfo（user:pass@）与 fragment 一律丢弃", () => {
		expect(sanitizeEndpoint("https://user:hunter2@db.example.com:5432/internal/row?id=1#cred")).toBe(
			"https://db.example.com:5432/internal/…?id=…",
		);
	});

	test("query 白名单命中保留后不再有深值泄漏", () => {
		const out = sanitizeEndpoint("https://api.example.com/search?q=秘密资料&format=json", {
			allowQueryParams: ["format"],
		});
		expect(out).toBe("https://api.example.com/search?q=…&format=json");
		expect(out).not.toContain("秘密资料");
	});
});

describe("sanitizeErrorPayload", () => {
	test("Authorization 头整值抹除", () => {
		const text = "GET /v1 HTTP/1.1\nauthorization: Bearer abc.def.ghi\nHost: x";
		const out = sanitizeErrorPayload(text);
		expect(out).not.toContain("abc.def.ghi");
		expect(out).toContain("authorization: …");
		expect(out).toContain("Host: x");
	});

	test("Bearer 凭据抹除", () => {
		const out = sanitizeErrorPayload("请求失败: Bearer eyJhbGciOiJIUzI1NiJ9.token.sig at position 1");
		expect(out).toContain("Bearer …");
		expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	});

	test("JSON 形态 api_key/token 值抹除，键保留", () => {
		const out = sanitizeErrorPayload('{"api_key":"sk-abc123def456","token":"t-1234567890","ok":true}');
		expect(out).toContain('"api_key":"…"');
		expect(out).toContain('"token":"…"');
		expect(out).toContain('"ok":true');
	});

	test("裸 kv 形态（query 串）抹除", () => {
		const out = sanitizeErrorPayload("POST https://api.example.com/v1/chat?api_key=AKIA123456&x=1 失败");
		expect(out).toContain("api_key=…");
		expect(out).not.toContain("AKIA123456");
	});

	test("secret/password/session_id kv 抹除", () => {
		const out = sanitizeErrorPayload("db connect failed: password=hunter2 secret='xyz 12' session_id:s9a8b7");
		expect(out).not.toContain("hunter2");
		expect(out).not.toContain("xyz 12");
		expect(out).not.toContain("s9a8b7");
	});

	test("sk- 形态平台密钥抹除", () => {
		const out = sanitizeErrorPayload("invalid key sk-proj-abcdef1234567890abcd");
		expect(out).toContain("sk-…");
		expect(out).not.toContain("abcdef1234567890");
	});

	test("IPv4 尾段抹除（保留前三段）", () => {
		const out = sanitizeErrorPayload("connect ECONNREFUSED 10.1.2.3:5432 via 192.168.10.254");
		expect(out).toContain("10.1.2.…");
		expect(out).toContain("192.168.10.…");
		expect(out).not.toContain("10.1.2.3");
		expect(out).not.toContain("254");
	});

	test("extraPatterns 注入扩展：自定义模式生效", () => {
		const out = sanitizeErrorPayload("user john.doe@corp.example.com 登录失败", {
			extraPatterns: [{ name: "email", pattern: /[\w.]+@[\w.]+/g, replacement: "[email]" }],
		});
		expect(out).toBe("user [email] 登录失败");
	});

	test("patterns 整体替换：仅用注入表", () => {
		const out = sanitizeErrorPayload("token=supersecret ip 10.1.2.3", {
			patterns: [{ name: "token", pattern: /token=\S+/g, replacement: "token=" + REDACTED }],
		});
		expect(out).toBe("token=… ip 10.1.2.3"); // 内建 IPv4 模式不参与
	});

	test("内建模式表含 IPv4 与 bearer（供 telemetry-runtime 复用）", () => {
		const names = DEFAULT_REDACTION_PATTERNS.map((p) => p.name);
		expect(names).toContain("ipv4-tail-octet");
		expect(names).toContain("bearer");
	});

	test("重复应用幂等：掩码值不再被二次改写", () => {
		const once = sanitizeErrorPayload("token=abc123456789");
		const twice = sanitizeErrorPayload(once);
		expect(twice).toBe(once);
	});

	test("掩码段常量统一为 …", () => {
		expect(REDACTED).toBe(REDACTED_SEGMENT);
	});
});
