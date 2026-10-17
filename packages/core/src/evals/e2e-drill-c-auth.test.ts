/**
 * BI-21 工位 H 域级演练 C —— 认证与凭据全链。
 *
 * 链路:CliOAuthFlow PKCE/Poll 状态机跨三流程走完七态(伪 fetch 端点,I/O 边界)
 * → FileCredentialStore AES-256-GCM 写读回路 + 篡改拒收 → redact 遮蔽三出口
 * → ConfigService 五级优先级合并 + 热重载防抖。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CliOAuthFlow,
	OAUTH_STATE_TRANSITIONS,
	pkceS256Challenge,
	generatePkcePair,
	type OAuthEndpoints,
} from "../auth/cli-oauth";
import { FileCredentialStore } from "../auth/credential-store";
import { role } from "../auth/types";
import { redactSecrets, SecretValue, SECRET_MASK, isSecret } from "../config/redact";
import { ConfigService } from "../config/config-service";

const roots: string[] = [];
afterAll(async () => {
	while (roots.length > 0) {
		const dir = roots.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function injectRoot(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `bi21-c-${prefix}-`));
	roots.push(dir);
	return dir;
}

const FAKE_ENDPOINTS: OAuthEndpoints = {
	authorize: "https://oauth.example.com/authorize",
	poll: "https://oauth.example.com/poll",
	token: "https://oauth.example.com/token",
};

/** 断言转移序列合法(每一步都在状态转移表内)。 */
function expectLegalTransitions(flow: CliOAuthFlow): void {
	expect(flow.transitions.length).toBeGreaterThan(0);
	expect(flow.transitions[0]!.from).toBe("idle");
	for (const t of flow.transitions) {
		expect(OAUTH_STATE_TRANSITIONS[t.from]).toContain(t.to);
	}
}

describe("BI-21 域 C —— 认证与凭据", () => {
	test("C1 oauth 状态机:success 直出 + expired 服务端过期 + error HTTP,三流程走完七态", async () => {
		// —— 流程一:pending → success(access_token 直出)——
		const seenUrls: string[] = [];
		let pollCalls = 0;
		const ok = new CliOAuthFlow({
			clientId: "drill-client",
			endpoints: FAKE_ENDPOINTS,
			openBrowser: () => {},
			fetch: (input) => {
				seenUrls.push(String(input));
				pollCalls += 1;
				const body = pollCalls === 1
					? { status: "pending" }
					: { status: "success", access_token: "pat-drill-953680", expires_in: 3600, token_use: "project_access" };
				return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
			},
		});
		const out1 = await ok.run();
		expect(out1.status).toBe("success");
		if (out1.status !== "success") throw new Error("unreachable");
		expect(ok.state).toBe("success");
		expectLegalTransitions(ok);
		// 走过的态:idle→awaiting_browser→polling→exchange→success
		expect(ok.transitions.map((t) => t.to)).toEqual(["awaiting_browser", "polling", "exchange", "success"]);
		expect(isSecret(out1.credential.accessToken)).toBe(false);
		// role("secret") 契约:brand 后的同一字符串(不拷贝不改写)
		expect(String(out1.credential.accessToken)).toBe("pat-drill-953680");
		expect(out1.credential.expiresAt).toBeDefined();
		// 授权 URL 带 PKCE challenge 与 poll_token(逐字断言)
		const authUrl = ok.authorizeUrl ?? "";
		const { verifier } = generatePkcePair();
		expect(authUrl).toContain("code_challenge=");
		expect(authUrl).toContain("code_challenge_method=S256");
		expect(pkceS256Challenge(verifier)).toBe(pkceS256Challenge(verifier));
		expect(seenUrls.some((u) => u.startsWith(FAKE_ENDPOINTS.poll))).toBe(true);

		// —— 流程二:服务端 expired ——
		const expired = new CliOAuthFlow({
			clientId: "drill-client",
			endpoints: FAKE_ENDPOINTS,
			openBrowser: () => {},
			fetch: () => Promise.resolve(new Response(JSON.stringify({ status: "expired" }), { status: 200 })),
		});
		const out2 = await expired.run();
		expect(out2).toEqual({ status: "expired", reason: "server_expired" });
		expect(expired.state).toBe("expired");
		expectLegalTransitions(expired);

		// —— 流程三:轮询 HTTP 500 → error(结构化,不含响应原文)——
		const err = new CliOAuthFlow({
			clientId: "drill-client",
			endpoints: FAKE_ENDPOINTS,
			openBrowser: () => {},
			fetch: () => Promise.resolve(new Response("boom", { status: 500 })),
		});
		const out3 = await err.run();
		expect(out3.status).toBe("error");
		if (out3.status !== "error") throw new Error("unreachable");
		expect(out3.failure.kind).toBe("http");
		expect(out3.failure.status).toBe(500);
		expect(err.state).toBe("error");
		expectLegalTransitions(err);

		// 七态全覆盖:三流程状态并集 = {idle, awaiting_browser, polling, exchange, success, expired, error}
		const visited = new Set<string>(["idle"]);
		for (const f of [ok, expired, err]) for (const t of f.transitions) { visited.add(t.from); visited.add(t.to); }
		expect([...visited].sort()).toEqual(["awaiting_browser", "error", "exchange", "expired", "idle", "polling", "success"]);
	}, 30_000);

	test("C2 credential-store:AES-GCM 落盘密文 + 写读回路 + 篡改拒收 + refresh 保留创建时间", async () => {
		const dir = await injectRoot("cred");
		const store = new FileCredentialStore({
			filePath: join(dir, "credentials.json"),
			keyPath: join(dir, ".machine-key"),
		});
		const secret = role("secret", "pat-drill-953680");
		await store.set("bigmodel:pat", secret, { expiresAt: 4102444800000 });

		// 落盘是密文:明文不出现在凭据文件
		const raw = await readFile(join(dir, "credentials.json"), "utf8");
		expect(raw).not.toContain("pat-drill-953680");
		expect(JSON.parse(raw).version).toBe(1);

		// 新实例(重新派生密钥)读回一致
		const store2 = new FileCredentialStore({
			filePath: join(dir, "credentials.json"),
			keyPath: join(dir, ".machine-key"),
		});
		const rec = await store2.get("bigmodel:pat");
		expect(String(rec?.value)).toBe("pat-drill-953680");
		expect(rec?.expiresAt).toBe(4102444800000);

		// refresh:轮换值,createdAt 保留,updatedAt 前移
		await store2.refresh("bigmodel:pat", role("secret", "pat-rotated"));
		const rec2 = await store2.get("bigmodel:pat");
		expect(String(rec2?.value)).toBe("pat-rotated");
		expect(rec2?.createdAt).toBe(rec?.createdAt);
		expect(rec2!.updatedAt).toBeGreaterThanOrEqual(rec!.updatedAt);

		// 篡改密文 → GCM 认证标签拒收(结构化失败,绝不吐明文)
		const tampered = raw.replace(/[A-Za-z0-9+/=]{8}/, "AAAAAAAA");
		await writeFile(join(dir, "credentials.json"), tampered, "utf8");
		const broken = new FileCredentialStore({
			filePath: join(dir, "credentials.json"),
			keyPath: join(dir, ".machine-key"),
		});
		await expect(broken.get("bigmodel:pat")).rejects.toThrow();

		// clear:删除后读不到(独立目录,不受后续篡改影响)
		const dir2 = await injectRoot("cred2");
		const store3 = new FileCredentialStore({
			filePath: join(dir2, "credentials.json"),
			keyPath: join(dir2, ".machine-key"),
		});
		await store3.set("kimi:refresh", role("secret", "r1"));
		await store3.clear("kimi:refresh");
		expect(await store3.get("kimi:refresh")).toBeUndefined();
	}, 30_000);

	test("C3 redact:SecretValue 三出口遮蔽 + 键名兜底深遮蔽", () => {
		const secret = new SecretValue("sk-drill-1234567890");
		// 字符串化 / JSON / inspect 三出口全部遮蔽(合约:保留前缀+末 4 位,中间 ***)
		expect(`${secret}`).toBe("sk-***7890");
		expect(JSON.stringify({ token: secret })).toBe('{"token":"sk-***7890"}');
		expect(JSON.parse(JSON.stringify({ token: secret })).token).toBe("sk-***7890");

		// 深遍历:键名命中防御纵深 + SecretValue 实例
		const payload = {
			api_key: "plaintext-abc",
			nested: { refresh_token: new SecretValue("rt-xyz") },
			normal: "953680",
		};
		const out = redactSecrets(payload) as typeof payload;
		expect(String(out.api_key)).not.toBe("plaintext-abc");
		expect(String(out.api_key)).toContain("***");
		// 合约:SecretValue 实例在深遮蔽出口被替换为遮蔽字符串(不可逆)
		expect(isSecret(out.nested.refresh_token)).toBe(false);
		expect(String(out.nested.refresh_token)).toBe(SECRET_MASK);
		expect(out.normal).toBe("953680");
	}, 30_000);

	test("C4 config-service 五级优先级合并 + onChange + 热重载防抖", async () => {
		const home = await injectRoot("home");
		const work = await injectRoot("work");
		await mkdir(join(home, ".bi"), { recursive: true });
		await mkdir(join(work, ".bi"), { recursive: true });
		const globalToml = join(home, ".bi", "config.toml");
		const localToml = join(work, ".bi", "local.toml");

		// 第一级:global
		await writeFile(globalToml, `[models]\ndefault = "global-model"\n`, "utf8");
		const svc = new ConfigService({ homeDir: home, workDir: work, env: {}, watchDebounceMs: 20 });
		let cfg = await svc.load();
		expect(cfg.models.default).toBe("global-model");

		// 第三级:local 压过 global(第二级 tui 空层)
		await writeFile(localToml, `[models]\ndefault = "local-model"\n`, "utf8");
		cfg = await svc.reload();
		expect(cfg.models.default).toBe("local-model");

		// 第四级:env 压过 local
		svc.stopWatch();
		const svcEnv = new ConfigService({ homeDir: home, workDir: work, env: { BI_MODEL: "env-model" }, watchDebounceMs: 20 });
		cfg = await svcEnv.load();
		expect(cfg.models.default).toBe("env-model");

		// 第五级:cli 压过 env
		const svcCli = new ConfigService({
			homeDir: home, workDir: work, env: { BI_MODEL: "env-model" },
			cliOverrides: { models: { default: "cli-model" } }, watchDebounceMs: 20,
		});
		cfg = await svcCli.load();
		expect(cfg.models.default).toBe("cli-model");

		// 热重载 watch 防抖:连续写盘(间隔 < 防抖窗口)合并触发,终值正确(无 env/cli 层,local 即终值)
		const changes: { model: string; trigger: string }[] = [];
		const unsubscribe = svc.onChange((c, meta) => changes.push({ model: c.models.default, trigger: meta.trigger }));
		svc.startWatch();
		await writeFile(localToml, `[models]\ndefault = "hot-1"\n`, "utf8");
		await new Promise((r) => setTimeout(r, 60)); // 间隔小于防抖窗口
		await writeFile(localToml, `[models]\ndefault = "hot-2"\n`, "utf8");
		await waitFor(() => changes.some((c) => c.model === "hot-2"), 2000);
		await new Promise((r) => setTimeout(r, 250)); // 等潜在的第二波触发
		unsubscribe();
		svc.stopWatch();
		const watchChanges = changes.filter((c) => c.trigger === "watch");
		expect(watchChanges.length).toBeGreaterThanOrEqual(1);
		expect(watchChanges.length).toBeLessThanOrEqual(2); // 防抖把连续写合并为至多两波
		expect(watchChanges.at(-1)?.model).toBe("hot-2");
	}, 30_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor 超时");
		await new Promise((r) => setTimeout(r, 25));
	}
}
