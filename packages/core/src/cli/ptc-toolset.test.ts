/**
 * BI-16.2 装配验收 —— run_ptc_script 注册进 buildDefaultToolset（条件注册门）。
 *
 * 关注面（先例照抄 ask_user_question / spawn_subagent）：
 * - 缺省（未注入 ptcDeps）注册表不含 run_ptc_script（既有工具面零变动）。
 * - 注入 ptcDeps 后 run_ptc_script 在表（readOnly=true）；execute 调 PtcRunner
 *   跑脚本，脚本内 `await tools.<name>(args)` 程序化调用 5 件只读子集。
 * - 白名单外工具拒绝：脚本调 bash/write/edit 等 → 不派发、结构化拒绝。
 * - 超时边界：小 timeoutMs + 阻塞脚本 → timedOut=true。
 * - 调用上限：小 maxToolCalls + 多次调用 → 超出被拒、totalCalls 正确。
 * - 安全边界头注钉死：程序化调用仅 5 件只读，禁写禁执行。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDefaultToolset, type SpawnImpl } from "./toolset";
import type { ToolBinding } from "./headless";
import type { FetchExecutor } from "../tools/web-fetch";

const SIGNAL = new AbortController().signal;

function explodingSpawn(): SpawnImpl {
	return () => {
		throw new Error("test-guard: spawn 不应被调用");
	};
}

function byName(tools: readonly ToolBinding[], name: string): ToolBinding {
	const found = tools.find((t) => t.definition.name === name);
	if (found === undefined) throw new Error(`test-setup: 工具 ${name} 未注册`);
	return found;
}

/** fetch 替身：按 URL 路由；不触真实网络。 */
function routeFetch(routes: Record<string, () => Response>): FetchExecutor {
	return async (url: string) => {
		const handler = routes[url];
		if (!handler) throw new Error(`no route: ${url}`);
		return handler();
	};
}

function htmlRes(html: string): Response {
	return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-ptc-"));
	await writeFile(join(root, "note.txt"), "勾稽差额为零\n", "utf8");
	await writeFile(join(root, "code.ts"), "const x = 1;\nfunction f() { return x; }\n", "utf8");
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("BI-16.2 · 注册门：仅注入 ptcDeps 才挂 run_ptc_script", () => {
	test("缺省 buildDefaultToolset 不含 run_ptc_script（既有工具面零变动）", () => {
		const names = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }).map((t) => t.definition.name);
		expect(names).not.toContain("run_ptc_script");
	});

	test("注入 ptcDeps 后 run_ptc_script 在表（readOnly=true）；definition 面齐全", () => {
		const tool = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 1000, maxToolCalls: 10 } }),
			"run_ptc_script",
		);
		expect(tool.readOnly).toBe(true);
		expect(tool.definition.description).toBeTruthy();
		expect(tool.definition.description).toContain("tools.<name>");
		expect(tool.definition.inputSchema).toHaveProperty("type", "object");
		expect(tool.argSummary).toBeInstanceOf(Function);
	});
});

describe("BI-16.2 · 脚本跑通：5 件只读子集程序化调用", () => {
	test("脚本内 await tools.read_file / grep 回传最终结果 + 调用台账（calls/totalCalls）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fetchImpl = routeFetch({
				"https://a.example.com/x": () => htmlRes("<html><body>宏观</body></html>"),
			});
			const tool = byName(
				buildDefaultToolset(root, { fetchImpl, spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 5000, maxToolCalls: 16 } }),
				"run_ptc_script",
			);
			const script = [
				"const a = await tools.read_file({ path: 'note.txt' });",
				"const b = await tools.grep({ pattern: 'function' });",
				"return { a, b };",
			].join("\n");
			const raw = (await tool.execute({ script }, SIGNAL)) as string;
			const result = JSON.parse(raw) as {
				ok: boolean;
				result: { a: string; b: string };
				calls: Array<{ tool: string; ok: boolean }>;
				totalCalls: number;
			};
			expect(result.ok).toBe(true);
			expect(result.result.a).toBe("勾稽差额为零\n");
			expect(result.result.b).toContain("code.ts:2:"); // grep 命中
			expect(result.totalCalls).toBe(2);
			expect(result.calls.map((c) => c.tool).sort()).toEqual(["grep", "read_file"]);
		} finally {
			await cleanup();
		}
	});

	test("web_fetch/web_search 程序化调用：注入替身零网络", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fetchImpl = routeFetch({
				"https://a.example.com/page": () => htmlRes("<html><body>利率</body></html>"),
			});
			const tool = byName(
				buildDefaultToolset(root, { fetchImpl, spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 5000 } }),
				"run_ptc_script",
			);
			const script = "const r = await tools.web_fetch({ url: 'https://a.example.com/page' }); return r;";
			const result = JSON.parse((await tool.execute({ script }, SIGNAL)) as string) as { ok: boolean; result: { markdown?: string } };
			expect(result.ok).toBe(true);
			expect(result.result.markdown).toContain("利率");
		} finally {
			await cleanup();
		}
	});
});

describe("BI-16.2 · 白名单外工具拒绝（安全边界）", () => {
	test("脚本调 bash/write/edit 等白名单外工具 → 不派发、结构化拒绝、不触 spawn", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const fetchImpl = routeFetch({});
			const tool = byName(
				buildDefaultToolset(root, { fetchImpl, spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 5000, maxToolCalls: 8 } }),
				"run_ptc_script",
			);
			for (const name of ["bash", "edit", "write"]) {
				const script = `await tools.${name}({ command: 'echo x' }); return 1;`;
				const result = JSON.parse((await tool.execute({ script }, SIGNAL)) as string) as {
					ok: boolean;
					error?: string;
					calls: Array<{ ok: boolean; error?: string }>;
				};
				expect(result.ok).toBe(false);
				// 白名单外工具被拒：要么 PtcRunner knownTools 层（"未知工具"）要么 executor 层
				// （"ptc-tool-not-whitelisted"），两种都保证不派发到写/执行工具。
				const reason = result.error ?? result.calls[0]?.error ?? "";
				expect(reason === "ptc-tool-not-whitelisted" || reason.includes("未知工具")).toBe(true);
			}
		} finally {
			await cleanup();
		}
	});

	test("白名单外工具被拒不计入 totalCalls（仅派发到白名单才计数）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const tool = byName(
				buildDefaultToolset(root, { spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 5000, maxToolCalls: 8 } }),
				"run_ptc_script",
			);
			const script = "try { await tools.bash({ command: 'x' }); } catch (e) {}\nreturn await tools.read_file({ path: 'note.txt' });";
			const result = JSON.parse((await tool.execute({ script }, SIGNAL)) as string) as { ok: boolean; totalCalls: number; calls: unknown[] };
			expect(result.ok).toBe(true);
			expect(result.totalCalls).toBe(1); // 仅 read_file 派发
			expect(result.calls).toHaveLength(2); // bash 的拒绝尝试也入台账
		} finally {
			await cleanup();
		}
	});
});

describe("BI-16.2 · 超时边界", () => {
	test("小 timeoutMs + 阻塞脚本 → timedOut=true、ok=false", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const tool = byName(
				buildDefaultToolset(root, { spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 60, maxToolCalls: 8 } }),
				"run_ptc_script",
			);
			// 死循环：单线程内无法打断同步死循环，但同步死循环不会让出事件循环，
			// Promise.race 的 setTimeout 也需让出——故用 await 一个永不 resolve 的
			// Promise 触发超时更可靠（与 PtcRunner 测试同款边界）。
			const script = "await new Promise(() => {}); return 1;";
			const result = JSON.parse((await tool.execute({ script }, SIGNAL)) as string) as { ok: boolean; timedOut: boolean; error?: string };
			expect(result.timedOut).toBe(true);
			expect(result.ok).toBe(false);
			expect(result.error ?? "").toContain("超时");
		} finally {
			await cleanup();
		}
	});
});

describe("BI-16.2 · 调用次数上限", () => {
	test("小 maxToolCalls + 多次调用 → 超出被拒、totalCalls 封顶", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const tool = byName(
				buildDefaultToolset(root, { spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 5000, maxToolCalls: 3 } }),
				"run_ptc_script",
			);
			const script = [
				"let n = 0;",
				"for (let i = 0; i < 6; i++) { try { await tools.read_file({ path: 'note.txt' }); n++; } catch (e) {} }",
				"return n;",
			].join("\n");
			const result = JSON.parse((await tool.execute({ script }, SIGNAL)) as string) as { ok: boolean; totalCalls: number; result: number };
			expect(result.ok).toBe(true);
			expect(result.totalCalls).toBe(3); // 封顶在 maxToolCalls
			expect(result.result).toBe(3); // 仅 3 次真正派发成功
		} finally {
			await cleanup();
		}
	});

	test("maxToolCalls=0 → 任何工具调用即被拒", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const tool = byName(
				buildDefaultToolset(root, { spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 5000, maxToolCalls: 0 } }),
				"run_ptc_script",
			);
			const script = "try { await tools.read_file({ path: 'note.txt' }); } catch (e) { return 'blocked'; } return 'unreachable';";
			const result = JSON.parse((await tool.execute({ script }, SIGNAL)) as string) as { ok: boolean; result: string; totalCalls: number };
			expect(result.ok).toBe(true);
			expect(result.result).toBe("blocked");
			expect(result.totalCalls).toBe(0);
		} finally {
			await cleanup();
		}
	});
});

describe("BI-16.2 · 参数校验", () => {
	test("script 缺参/非字符串 → 结构化报错（不触工具）", async () => {
		const tool = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), ptcDeps: { timeoutMs: 1000 } }),
			"run_ptc_script",
		);
		for (const args of [undefined, {}, { script: "" }, { script: 42 }]) {
			try {
				await tool.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("script required");
			}
		}
	});
});
