/**
 * BI-26.2 —— bin 级伪端点 e2e:零网络、零密钥、可回归的全链路验收。
 *
 * 走真实 bin 入口(bin/bi.ts):配置装载(临时 HOME 的三级 TOML)→ BI-02 凭据门
 * (BI_FAKE_KEY 环境变量)→ BI-04.2 双模态适配器 → 本地伪端点(127.0.0.1)→
 * stream-json 输出断言。与 ignition-real-model.ts 的差异:实弹点火需真端点真
 * 密钥(手动/定期),本套件 CI 可跑(门控 BI_PTY_E2E=1,本地开发缺省跳过以保
 * 持开发环轻快)。
 * 纪律:子进程 env 仅 PATH+HOME+BI_FAKE_KEY——宿主任何真实凭据不透传,
 * 结构性杜绝真实外呼。
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFakeEndpoint } from "./fake-endpoint.ts";

const ROOT = join(import.meta.dir, "..");
const RUN = process.env.BI_PTY_E2E === "1";

async function makeHome(providerKind: "anthropic" | "openai", baseUrl: string): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "bi-fake-e2e-"));
	await mkdir(join(home, ".bi"), { recursive: true });
	const config = [
		"[providers.entries.fake]",
		'api_key_env = "BI_FAKE_KEY"',
		`base_url = "${baseUrl}"`,
		`kind = "${providerKind}"`,
		'models = ["fake-echo"]',
		"",
		"[providers]",
		'default = "fake"',
		"",
		"[models]",
		'default = "main"',
		"",
		"[models.entries.main]",
		'provider = "fake"',
		'model = "fake-echo"',
		"",
	].join("\n");
	await writeFile(join(home, ".bi", "config.toml"), config, { mode: 0o600 });
	return home;
}

describe.skipIf(!RUN)("BI-26.2 伪端点 bin e2e", () => {
	test("anthropic 模式:bin --prompt 全链路回环(ECHO 上屏+session_done)", async () => {
		const fake = startFakeEndpoint({ echo: true, mode: "anthropic" });
		const home = await makeHome("anthropic", fake.url);
		try {
			const proc = Bun.spawn(["bun", join(ROOT, "bin", "bi.ts"), "--prompt", "你好伪端点"], {
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home, BI_FAKE_KEY: "dummy" },
			});
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const code = await proc.exited;
			expect(code).toBe(0);
			expect(fake.requests.length).toBeGreaterThan(0);
			expect(stdout).toContain('"type":"content_delta"');
			expect(stdout).toContain("ECHO:你好伪端点");
			expect(stdout).toContain('"exit":"ok"');
			expect(stdout).toContain('"finalText":"ECHO:你好伪端点"');
			// 装配面在 stderr:provider/mode/model 三元组可见
			expect(stderr).toContain("mode=messages");
		} finally {
			fake.close();
			await rm(home, { recursive: true, force: true });
		}
	}, 60_000);

	test("openai 模式:resolveModelPort 选择链→适配器直连伪端点", async () => {
		const { ConfigService } = await import("../packages/core/src/config/config-service");
		const { resolveModelPort } = await import("../packages/core/src/cli/model-port");
		const fake = startFakeEndpoint({ echo: true, mode: "openai" });
		const home = await makeHome("openai", fake.url);
		try {
			const service = new ConfigService({ homeDir: home, workDir: home });
			const config = await service.load();
			// 凭据面走 options.env(注入),不经 service.resolveProviderApiKey(读进程 env)
			const selection = resolveModelPort(config, {
				env: { BI_FAKE_KEY: "dummy" },
			});
			expect(selection.mode).toBe("openai");
			const events = [];
			for await (const event of selection.port.stream({
				messages: [{ role: "user", content: "openai 模式回环" }],
				tools: [],
			})) {
				events.push(event);
			}
			const text = events
				.filter((e) => e.type === "content_delta")
				.map((e) => (e as { delta: string }).delta)
				.join("");
			expect(text).toBe("ECHO:openai 模式回环");
			expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop" });
		} finally {
			fake.close();
			await rm(home, { recursive: true, force: true });
		}
	}, 60_000);
});
