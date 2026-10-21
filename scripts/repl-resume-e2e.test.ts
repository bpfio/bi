/**
 * FIX-A F4 · bin 级 REPL 续会话 e2e（`bi --resume <sessionId>`）。
 *
 * 走真实 bin 入口（bin/bi.ts）：临时 HOME（无配置 → 缺省配置）→ REPL 路径的
 * 续会话校验（SessionManager.reopenSession）→ 无效 id 结构化报错 + 退出码 2。
 * 纪律：子进程 env 仅 PATH+HOME——宿主真实凭据不透传，结构性杜绝真实外呼。
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startFakeEndpoint } from "./fake-endpoint.ts";
import { SessionManager } from "../packages/core/src/session/manager";

const ROOT = join(import.meta.dir, "..");

/** 临时 HOME + 伪端点配置（provider fake；凭据走 env 间接引用，零真实密钥）。 */
async function makeHome(baseUrl: string): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "bi-resume-bin-"));
	await mkdir(join(home, ".bi"), { recursive: true });
	const config = [
		"[providers.entries.fake]",
		'api_key_env = "BI_FAKE_KEY"',
		`base_url = "${baseUrl}"`,
		'kind = "anthropic"',
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

describe("FIX-A F4 · bi --resume（REPL 路径）", () => {
	test("无效 session id：结构化报错 [session-not-found] + 退出码 2（不静默开新会话）", async () => {
		const home = await mkdtemp(join(tmpdir(), "bi-resume-bin-"));
		try {
			const proc = Bun.spawn(["bun", join(ROOT, "bin", "bi.ts"), "--resume", "no-such-session"], {
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home },
			});
			const stderr = await new Response(proc.stderr).text();
			const code = await proc.exited;
			expect(code).toBe(2);
			expect(stderr).toContain("session-not-found");
			expect(stderr).toContain("--resume 会话不存在");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	test("有效 session id：续会话生效（stderr 报已恢复 + 既有历史注入模型上下文）", async () => {
		const fake = startFakeEndpoint({ echo: true });
		const home = await makeHome(fake.url);
		try {
			// 既有会话：user + assistant 两轮。
			const manager = new SessionManager({ rootDir: join(home, ".bi", "sessions") });
			const meta = await manager.createSession({ title: "旧会话" });
			const e1 = await manager.append(meta.sessionId, null, { type: "user", payload: { text: "旧问" } });
			await manager.append(meta.sessionId, e1.id, { type: "assistant", payload: { text: "旧答" } });

			// stdin 分两批喂（间隔 > 粘贴聚合窗）：首批"新问"、次批 Enter——单批会被
			// 判为粘贴（保换行不提交），故分批以触发真实模型回合。
			const stdin = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(new TextEncoder().encode("新问"));
					await new Promise((r) => setTimeout(r, 150));
					controller.enqueue(new TextEncoder().encode("\n"));
					await new Promise((r) => setTimeout(r, 300));
					controller.close();
				},
			});
			const proc = Bun.spawn(["bun", join(ROOT, "bin", "bi.ts"), "--resume", meta.sessionId], {
				stdin,
				stdout: "pipe",
				stderr: "pipe",
				env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home, BI_FAKE_KEY: "dummy" },
			});
			const stderr = await new Response(proc.stderr).text();
			await new Response(proc.stdout).text();
			const code = await proc.exited;

			expect(code).toBe(0);
			expect(stderr).toContain(`已恢复会话 ${meta.sessionId}`);
			// 既有历史进了模型请求（上下文重放生效）：旧问/旧答在前，新问在后。
			const requests = fake.requests;
			expect(requests.length).toBeGreaterThan(0);
			const sent = requests[requests.length - 1] as { messages?: Array<{ role?: string; content?: unknown }> };
			const roles = (sent.messages ?? []).map((m) => `${m.role}:${String(m.content)}`);
			expect(roles).toEqual(["user:旧问", "assistant:旧答", "user:新问"]);
			// 会话 id 连续：新条目续写在既有会话文件里（未新建第二个会话）。
			const entries = await manager.entries(meta.sessionId);
			expect(entries.length).toBeGreaterThan(2);
		} finally {
			fake.close();
			await rm(home, { recursive: true, force: true });
		}
	});
});
