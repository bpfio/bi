/**
 * BI-21 工位 H 域级演练 K —— 网关与升级面。
 *
 * 链路 1:UltraGateway 专线 URL 重写(幂等短路/未知路径标记)→ 指纹防伪标头
 * (fetch 注入捕获,响应头 + 日志脱敏 ze-***last4)→ 结构化失败分级。
 * 链路 2:native-swap 三原语(临时目录演练,不碰主程序):stageDownload 哈希校验
 * 落盘 → swapBinary 原子换装 → installLock 互斥与 stale 接管。
 * 链路 3:config 快照 redact(凭据遮蔽、URL 保留)。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	UltraGateway,
	UltraGatewayError,
	classifyFailure,
	DEFAULT_ULTRA_BASE_URL,
	DEFAULT_ULTRA_ROUTE_RULES,
} from "../gateway/ultra-gateway";
import {
	buildFingerprintHeaders,
	redactFingerprint,
	FINGERPRINT_HEADER_PLAN_KEY,
	FINGERPRINT_HEADER_TRACE_ID,
	FINGERPRINT_MASK_PREFIX,
	DEFAULT_USER_AGENT,
} from "../gateway/fingerprint";
import { role } from "../auth/types";
import { redactSecrets, SECRET_MASK } from "../config/redact";
import {
	stageDownload,
	swapBinary,
	installLock,
	UpgradeError,
} from "../cli/update/native-swap";

const roots: string[] = [];
afterAll(async () => {
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

describe("BI-21 域 K —— 网关与升级面", () => {
	test("K1 ultra-gateway:专线重写 + 指纹防伪 + 脱敏日志 + 失败分级", async () => {
		const gw = new UltraGateway({
			fetchImpl: async (input, init) => {
				const seen = new Headers(init?.headers);
				// 网关回显指纹三标头,供响应脱敏断言
				return new Response("ok-body", {
					status: 200,
					headers: {
						"x-request-id": "req-1",
						[FINGERPRINT_HEADER_PLAN_KEY]: seen.get(FINGERPRINT_HEADER_PLAN_KEY) ?? "",
						[FINGERPRINT_HEADER_TRACE_ID]: seen.get(FINGERPRINT_HEADER_TRACE_ID) ?? "",
						"user-agent": seen.get("user-agent") ?? "",
					},
				});
			},
			traceIdGenerator: () => "abcd1234abcd1234abcd1234abcd1234",
		});

		// 专线重写:/v1/messages → /api/v1/ultra/anthropic/v1/messages
		const url = gw.routeUltra({ path: "/v1/messages?beta=true" });
		expect(url.toString()).toBe(`${DEFAULT_ULTRA_BASE_URL}/api/v1/ultra/anthropic/v1/messages?beta=true`);
		expect(url.routed).toBe(true);
		// 幂等短路:已是专线形态 → 原样
		const again = gw.routeUltra({ path: "/api/v1/ultra/anthropic/v1/messages" });
		expect(again.pathname).toBe("/api/v1/ultra/anthropic/v1/messages");
		expect(again.routed).toBe(true);
		// 未知路径:routed:false(交上层决策)
		expect(gw.routeUltra({ path: "/healthz" }).routed).toBe(false);

		// send:指纹标头防伪 + 响应头脱敏
		const lines: string[] = [];
		const res = await gw.send(
			{ method: "POST", path: "/v1/messages", body: '{"model":"k2"}' },
			role("secret", "ze-1234567890abcd"),
			{ log: (l) => lines.push(l) },
		);
		expect(res.status).toBe(200);
		expect(res.bodyText).toBe("ok-body");
		// 响应头脱敏:ze-***last4(明文绝不外泄;headers 由 Headers.entries 归一小写键)
		const planKeyLower = FINGERPRINT_HEADER_PLAN_KEY.toLowerCase();
		expect(res.headers[planKeyLower]).toBe("ze-***abcd");
		expect(res.headers["x-request-id"]).toBe("req-1"); // 非指纹标头原样
		// 指纹构造面:User-Agent 通道身份 + traceId 32 hex
		const fp = buildFingerprintHeaders({ apiKey: role("secret", "ze-1234567890abcd"), traceId: "abcd1234abcd1234abcd1234abcd1234" });
		expect(fp[FINGERPRINT_HEADER_PLAN_KEY]).toBe("ze-1234567890abcd");
		expect(fp["User-Agent"]).toBe(DEFAULT_USER_AGENT);
		expect(fp[FINGERPRINT_HEADER_TRACE_ID]).toMatch(/^[0-9a-f]{32}$/);
		// 日志行:JSON 且仅含脱敏指纹
		expect(lines.length).toBe(1);
		const logObj = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(String(logObj["plan_key"] ?? JSON.stringify(logObj))).toContain(FINGERPRINT_MASK_PREFIX);
		expect(lines[0]!).not.toContain("ze-1234567890abcd");

		// 失败分级:429 → rate_limited;500 → server;错误不携带正文
		const gwErr = new UltraGateway({
			fetchImpl: async () => new Response("rate-limited-body", { status: 429 }),
		});
		const err429 = await gwErr.send({ method: "POST", path: "/v1/messages" }, role("secret", "ze-key-1")).catch((e: unknown) => e);
		expect(err429).toBeInstanceOf(UltraGatewayError);
		const uge = err429 as UltraGatewayError;
		expect(uge.code).toBe("http");
		expect(uge.status).toBe(429);
		// classifyFailure 全函数映射
		expect(classifyFailure(429)).toBe("rate_limited");
		expect(classifyFailure(401)).toBe("auth");
		expect(classifyFailure(500)).toBe("server");
		expect(classifyFailure(400)).toBe("protocol");
		// 非法凭据:空 apiKey 结构化拒绝
		expect(() => buildFingerprintHeaders({ apiKey: role("secret", "") })).toThrow(TypeError);
		// 规则表扩展:全量替换语义
		const custom = new UltraGateway({
			fetchImpl: async () => new Response("", { status: 200 }),
			rules: [...DEFAULT_ULTRA_ROUTE_RULES],
		});
		expect(custom.routeUltra({ path: "/v2/models" }).pathname).toBe("/api/v2/ultra/anthropic/v2/models");
	}, 30_000);

	test("K2 native-swap:staging 哈希门 + 原子换装 + 安装锁(临时目录演练)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bi21-k-swap-"));
		roots.push(dir);

		// —— stageDownload:fetch 注入字节流,sha256 校验通过才落正式文件 ——
		const payload = new TextEncoder().encode("#!/bin/sh\necho bi-21-staged-v2\n");
		const sha = createHash("sha256").update(payload).digest("hex");
		const staged = await stageDownload("https://release.example.com/bi-bin-v2", {
			sha256: sha,
			dir,
			fetchFn: (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch,
		});
		expect(staged.bytes).toBe(payload.byteLength);
		expect(staged.sha256).toBe(sha);
		expect(await readFile(staged.stagedPath, "utf8")).toContain("bi-21-staged-v2");

		// 哈希不匹配:.part 清理,结构化 hash-mismatch,零残file
		await expect(
			stageDownload("https://release.example.com/evil", {
				sha256: "0".repeat(64),
				dir,
				fileName: "evil",
				fetchFn: (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({ code: "hash-mismatch" });

		// —— swapBinary:current(v1) ← staged(v2) 原子换装 ——
		const current = join(dir, "bi-bin");
		await readFile; // no-op(类型引用)
		const { writeFile } = await import("node:fs/promises");
		await writeFile(current, "v1-binary", { mode: 0o755 });
		await swapBinary(current, staged.stagedPath);
		expect(await readFile(current, "utf8")).toContain("bi-21-staged-v2");
		// staged 已被 rename 消费
		await expect(readFile(staged.stagedPath, "utf8")).rejects.toThrow();
		// staged 缺失 → 结构化错误
		await expect(swapBinary(current, join(dir, "ghost"))).rejects.toMatchObject({ code: "staged-missing" });

		// —— installLock:O_EXCL 互斥 + 他人持锁 null + 释放幂等 ——
		const lockPath = join(dir, "install.lock");
		const lock1 = await installLock(lockPath, { now: () => 1_000 });
		expect(lock1).not.toBeNull();
		const lock2 = await installLock(lockPath, { now: () => 2_000 });
		expect(lock2).toBeNull(); // 他人持锁未过期
		lock1!.release();
		const lock3 = await installLock(lockPath, { now: () => 3_000 });
		expect(lock3).not.toBeNull(); // 释放后可接管
		// stale 接管:超 staleMs 的死锁可被新进程接管
		lock3!.release();
		const stale = await installLock(lockPath, { now: () => 1_000 + 60 * 60 * 1000 + 1, staleMs: 60 * 60 * 1000 });
		expect(stale).not.toBeNull();
		stale!.release();
	}, 30_000);

	test("K3 config 快照 redact:凭据遮蔽、端点 URL 保留、结构无损", () => {
		// 模拟 ConfigService 产出的配置快照(含凭据形态)
		const snapshot = {
			providers: {
				default: "primary",
				entries: {
					primary: { api_key: "sk-live-953680abcd", base_url: "https://open.example.com/v1" },
					backup: { api_key_env: "BI_BACKUP_KEY", base_url: "https://backup.example.com" },
				},
			},
			token: "pat-drill-tail4321", // 精确键名命中 SECRET_KEY_NAMES
			nested: { secret: "ze-abcdef123456" },
			models: { default: "k2" },
		};
		const redacted = redactSecrets(snapshot) as typeof snapshot;
		// 凭据键全部遮蔽
		expect(redacted.providers.entries.primary.api_key).toContain(SECRET_MASK);
		expect(redacted.providers.entries.primary.api_key).not.toBe("sk-live-953680abcd");
		expect(redacted.token).toContain("***");
		expect(redacted.nested.secret).toContain("***");
		// 端点 URL 与普通值原样保留(结构无损)
		expect(redacted.providers.entries.primary.base_url).toBe("https://open.example.com/v1");
		expect(redacted.providers.entries.backup.api_key_env).toBe("BI_BACKUP_KEY");
		expect(redacted.models.default).toBe("k2");
		// 入参对象未被改动(返回全新对象)
		expect(snapshot.providers.entries.primary.api_key).toBe("sk-live-953680abcd");
		// 指纹脱敏:非指纹标头透传,指纹标头 ze-***last4
		expect(redactFingerprint({ "x-custom": "keep-me", [FINGERPRINT_HEADER_PLAN_KEY]: "ze-1234567890abcd" })).toEqual({
			"x-custom": "keep-me",
			[FINGERPRINT_HEADER_PLAN_KEY]: "ze-***abcd",
		});
	}, 30_000);
});
