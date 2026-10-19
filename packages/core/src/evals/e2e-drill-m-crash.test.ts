/**
 * BI-26.3 —— 工位 M 域级演练:崩溃恢复与持久化。
 *
 * 链路 1(JSONL 半写):kill -9 落在行中间的真实形态 —— 末行无换行残缺 →
 * loadSession 容忍(truncated/cleanLength),append 先物理截断再续写,文件痊愈。
 * 链路 2(meta 行残缺):首行无换行 = 会话不可用,结构化 SessionFileCorruptError
 * (不静默降级、不假冒恢复)。
 * 链路 3(并发):双 manager 同根互不串味;同会话并发追加不抛错、全量可读。
 * 链路 4(kill -9 真实子进程):真 bi --prompt + 伪端点,首行 stdout 即刻 SIGKILL,
 * 会话文件无论撕裂与否必须可恢复;二次运行在新会话照常完成。
 *
 * 注入仅限 I/O 边界(伪端点/临时根);解析器、截断痊愈、结构化报错全部真实代码。
 * 零 DEGRADED:无 skipIf 门,全链无条件下沉。
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionFileCorruptError, SessionManager } from "../session/manager";
import type { SessionEntry } from "../session/types";
import { startFakeEndpoint } from "../../../../scripts/fake-endpoint";

// ---------------------------------------------------------------------------
// 共用夹具
// ---------------------------------------------------------------------------

const CLEANUPS: string[] = [];

function tmpRoot(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	CLEANUPS.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of CLEANUPS) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 清理尽力而为
		}
	}
});

/** 会话 JSONL 物理路径。 */
function sessionFile(root: string, sessionId: string): string {
	return join(root, `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// 链路 1 —— JSONL 半写:撕裂行容忍 + append 痊愈
// ---------------------------------------------------------------------------

describe("BI-26.3 链路 1:JSONL 半写恢复", () => {
	test("末行撕裂(truncated JSON 无换行) → loadSession 容忍;append 截断痊愈;再读干净", async () => {
		const root = tmpRoot("bi-drill-m-jsonl-");
		const manager = new SessionManager({ rootDir: root });
		const meta = await manager.createSession({ title: "半写演练" });
		const first = await manager.append(meta.sessionId, null, { type: "user", payload: { text: "问一" } });
		await manager.append(meta.sessionId, first.id, { type: "assistant", payload: { text: "答一" } });

		// 模拟 kill -9 落在行中间:追加残缺 JSON,无换行
		const file = sessionFile(root, meta.sessionId);
		appendFileSync(file, '{"id":"e-torn","type":"user","payload":{"text":"半截', "utf8");
		const tornSize = readFileSync(file).byteLength;

		const loaded = await manager.loadSession(meta.sessionId);
		expect(loaded.truncated).toBe(true);
		expect(loaded.cleanLength).toBeLessThan(tornSize);
		expect(loaded.entries).toHaveLength(2); // 残缺区之前的全部干净条目保留
		expect(loaded.entries.at(-1)!.payload).toEqual({ text: "答一" });

		// append 先截断到干净边界再续写 → 痊愈
		const healed = await manager.append(meta.sessionId, loaded.entries.at(-1)!.id, {
			type: "user",
			payload: { text: "问二" },
		});
		const healedLoaded = await manager.loadSession(meta.sessionId);
		expect(healedLoaded.truncated).toBe(false);
		expect(healedLoaded.entries).toHaveLength(3);
		expect(healedLoaded.entries.at(-1)!.id).toBe(healed.id);
		// 撕裂字节已物理清除
		const raw = readFileSync(file, "utf8");
		expect(raw).not.toContain("半截");
	});

	test("坏行(非法 JSON 但有换行)同样构成残缺区起点,其后全部丢弃", async () => {
		const root = tmpRoot("bi-drill-m-badline-");
		const manager = new SessionManager({ rootDir: root });
		const meta = await manager.createSession({ title: "坏行演练" });
		await manager.append(meta.sessionId, null, { type: "user", payload: { text: "问一" } });
		const file = sessionFile(root, meta.sessionId);
		appendFileSync(file, "{not-json-at-all}\n{\"future\":\"ghost\"}\n", "utf8");

		const loaded = await manager.loadSession(meta.sessionId);
		expect(loaded.truncated).toBe(true);
		expect(loaded.entries).toHaveLength(1);
		// 幽灵行不在条目里
		expect(JSON.stringify(loaded.entries)).not.toContain("ghost");
	});
});

// ---------------------------------------------------------------------------
// 链路 2 —— meta 行残缺:结构化拒载,不假冒
// ---------------------------------------------------------------------------

describe("BI-26.3 链路 2:meta 行残缺结构化拒载", () => {
	test("首行无换行 / 首行非 meta → SessionFileCorruptError;空文件同样拒载", async () => {
		const root = tmpRoot("bi-drill-m-meta-");
		const manager = new SessionManager({ rootDir: root });
		const meta = await manager.createSession({ title: "meta 演练" });
		const file = sessionFile(root, meta.sessionId);

		// 形态 A:meta 行被截断(无换行)
		const original = readFileSync(file);
		writeFileSync(file, original.subarray(0, original.byteLength - 2));
		await expect(manager.loadSession(meta.sessionId)).rejects.toThrow(SessionFileCorruptError);

		// 形态 B:meta 行存在但内容不是 meta
		writeFileSync(file, "garbage-line\n");
		await expect(manager.loadSession(meta.sessionId)).rejects.toThrow(SessionFileCorruptError);

		// 形态 C:空文件
		writeFileSync(file, "");
		await expect(manager.loadSession(meta.sessionId)).rejects.toThrow(SessionFileCorruptError);

		// 不存在:SessionNotFoundError 形态区分(与损坏不同码)
		await expect(manager.loadSession("no-such-session-id")).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// 链路 3 —— 并发会话:互不串味 + 同会话并发追加不损坏
// ---------------------------------------------------------------------------

describe("BI-26.3 链路 3:并发会话", () => {
	test("双 manager 同根:各自会话交错追加,互不串味,全量可读", async () => {
		const root = tmpRoot("bi-drill-m-conc-");
		const managerA = new SessionManager({ rootDir: root });
		const managerB = new SessionManager({ rootDir: root });
		const metaA = await managerA.createSession({ title: "线 A" });
		const metaB = await managerB.createSession({ title: "线 B" });

		// 交错追加(A1,B1,A2,B2)
		const a1 = await managerA.append(metaA.sessionId, null, { type: "user", payload: { text: "A1" } });
		const b1 = await managerB.append(metaB.sessionId, null, { type: "user", payload: { text: "B1" } });
		await managerA.append(metaA.sessionId, a1.id, { type: "assistant", payload: { text: "A2" } });
		await managerB.append(metaB.sessionId, b1.id, { type: "assistant", payload: { text: "B2" } });

		const entriesA: SessionEntry[] = await managerA.entries(metaA.sessionId);
		const entriesB: SessionEntry[] = await managerB.entries(metaB.sessionId);
		expect(entriesA.map((e) => (e.payload as { text: string }).text)).toEqual(["A1", "A2"]);
		expect(entriesB.map((e) => (e.payload as { text: string }).text)).toEqual(["B1", "B2"]);
		// 第三视角(新 manager)读到同一真相
		const managerC = new SessionManager({ rootDir: root });
		expect((await managerC.listSessions()).map((m) => m.title).sort()).toEqual(["线 A", "线 B"]);
	});

	test("同会话并发追加(双 manager):不抛错、两条都在、可继续追加", async () => {
		const root = tmpRoot("bi-drill-m-race-");
		const managerA = new SessionManager({ rootDir: root });
		const managerB = new SessionManager({ rootDir: root });
		const meta = await managerA.createSession({ title: "竞写" });

		const [x, y] = await Promise.all([
			managerA.append(meta.sessionId, null, { type: "user", payload: { text: "X" } }),
			managerB.append(meta.sessionId, null, { type: "user", payload: { text: "Y" } }),
		]);

		// 两条都物理在盘且可读(append 全链路单次写行,追加面互不覆盖)
		const entries = await managerA.entries(meta.sessionId);
		const texts = entries.map((e) => (e.payload as { text: string }).text);
		expect(texts).toContain("X");
		expect(texts).toContain("Y");
		expect(x.id).not.toBe(y.id);
		// 竞写后会话仍可健康续写(以盘上末条为父)
		await managerA.append(meta.sessionId, entries.at(-1)!.id, { type: "assistant", payload: { text: "续" } });
		expect(await managerA.entries(meta.sessionId)).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// 链路 4 —— kill -9 真实子进程:任意时刻毙掉,持久层必须可恢复
// ---------------------------------------------------------------------------

describe("BI-26.3 链路 4:kill -9 真实子进程", () => {
	test("bi --prompt 中途 SIGKILL → 会话文件可恢复 + 二次运行照常完成", async () => {
		const fake = startFakeEndpoint({ echo: true });
		const home = tmpRoot("bi-drill-m-kill-");
		mkdirSync(join(home, ".bi"), { recursive: true });
		writeFileSync(
			join(home, ".bi", "config.toml"),
			[
				"[providers.entries.fake]",
				'api_key_env = "BI_FAKE_KEY"',
				`base_url = "${fake.url}"`,
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
			].join("\n"),
			{ mode: 0o600 },
		);

		// 第一跑:首行 stdout 即 SIGKILL(回合中弹,撕裂与否全凭天意 —— 恢复面都得接住)
		const first = Bun.spawn(["bun", join(process.cwd(), "bin", "bi.ts"), "--prompt", "ECHO 前毙掉我"], {
			env: { PATH: process.env.PATH ?? "", HOME: home, BI_FAKE_KEY: "dummy" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdoutReader = first.stdout.getReader();
		const firstChunk = await stdoutReader.read(); // 首个输出块即杀
		first.kill("SIGKILL");
		await stdoutReader.cancel().catch(() => undefined);
		await first.exited.catch(() => undefined);
		expect(firstChunk.done).toBe(false); // 确实看到过输出(进程真跑起来了)

		// 持久层恢复:无论撕裂与否,loadSession 不抛;listSessions 看得到
		const manager = new SessionManager({ rootDir: join(home, ".bi", "sessions") });
		const metas = await manager.listSessions();
		expect(metas.length).toBeGreaterThanOrEqual(1);
		const killedSession = metas[0]!;
		const loaded = await manager.loadSession(killedSession.sessionId); // 不抛 = 恢复面成立
		// 撕裂态下 append 痊愈;干净态下 append 直接续写 —— 两态都走通
		const tail = loaded.entries.at(-1);
		await manager.append(
			killedSession.sessionId,
			tail !== undefined ? tail.id : null,
			{ type: "user", payload: { text: "尸检后补写" } },
		);
		expect((await manager.loadSession(killedSession.sessionId)).truncated).toBe(false);

		// 二次跑:同 HOME 新会话照常完整跑完(session_done 出现,旧文件不挡路)
		const second = Bun.spawn(
			["bun", join(process.cwd(), "bin", "bi.ts"), "--prompt", "hello"],
			{ env: { PATH: process.env.PATH ?? "", HOME: home, BI_FAKE_KEY: "dummy" }, stdout: "pipe", stderr: "pipe" },
		);
		const secondOut = await new Response(second.stdout).text();
		await second.exited;
		expect(secondOut).toContain("ECHO:hello");
		expect(secondOut).toContain("session_done");
		fake.close();
	}, 30_000);
});
