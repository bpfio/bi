/**
 * 缺省工具注册表面验收（全离线：web 工具注入 fetch 替身、bash 注入 spawn 替身，
 * 零网络零实弹；fs 全部走临时目录）。
 *
 * 覆盖：
 * 1. 注册表构成：六件工具（read_file/web_fetch/web_search 只读在前，bash/edit/
 *    write 写语义在后）、readOnly 标志、definition/argSummary 面齐全；
 *    未挂面工具（list_dir/grep/write_file）不在表。
 * 2. read_file 真实 fs 读写（tmp cwd）+ cwd 逃逸拒绝（相对越界 / 兄弟目录同前缀 /
 *    绝对路径）+ path 缺参报错。
 * 3. web 工具注入 fetch 替身的执行路径：web_fetch 抓 HTML → markdown；
 *    web_search 经 DeepSeek provider（注入密钥 env + fetch 替身）出结构化结果；
 *    未配置密钥结构化报错；abort 信号绑定层竞出。
 * 4. bash（BI-28.1）：注入 spawn 替身验证 cmd/cwd/stdin 透传、stdout+stderr
 *    合并、exitCode 非 0 不抛错、超时 kill 标注 timedOut、尾部 100KB 截断标注
 *    truncated、argSummary 120 字符截断与 shell-scan dangerous/opaque 标注、
 *    参数校验（command 缺参 / timeout_ms 非法）、已中止信号不触 spawn。
 * 5. edit/write（BI-28.2）：唯一性替换语义（0 命中/多处命中/replace_all/空
 *    new_string/字面 $ 语义）、write 新建与父目录存在性、原子写落盘（无临时
 *    文件残留）、共用路径守卫（逃逸三连 + PathJail 写裁决 .env/凭据文件名）、
 *    argSummary 审计面（匹配计数/字节数/首行片段）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
	buildDefaultToolset,
	DEFAULT_SEARCH_API_KEY_ENV,
	DEFAULT_BASH_TOOL_TIMEOUT_MS,
	BASH_TRUNCATION_MARKER,
	type SpawnImpl,
	type BashSpawnOptions,
} from "./toolset";
import type { ToolBinding } from "./headless";
import type { FetchExecutor } from "../tools/web-fetch";

// ---------------------------------------------------------------------------
// 底座：tmp 工作区 / fetch 与 spawn 替身 / AbortSignal
// ---------------------------------------------------------------------------

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-toolset-"));
	await writeFile(join(root, "note.txt"), "勾稽差额为零", "utf8");
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** fetch 替身：按 URL 路由 Response，记录调用（零真实网络）。 */
function routeFetch(routes: Record<string, () => Response>): { fetchImpl: FetchExecutor; calls: string[] } {
	const calls: string[] = [];
	const fetchImpl = async (url: string) => {
		calls.push(url);
		const handler = routes[url];
		if (!handler) throw new Error(`no route: ${url}`);
		return handler();
	};
	return { fetchImpl, calls };
}

function htmlRes(html: string): Response {
	return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function jsonRes(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** DeepSeek provider 语义的 chat/completions 响应体（content = JSON 结果数组）。 */
const SEARCH_CONTENT = JSON.stringify([
	{ title: "BI 工具面", url: "https://a.example.com/bi", snippet: "注册表面第一件" },
	{ title: "噪声无链接条目", url: "not-a-url", snippet: "应被 provider 跳过" },
]);

const SIGNAL = new AbortController().signal;

function namesOf(tools: readonly ToolBinding[]): string[] {
	return tools.map((t) => t.definition.name);
}

/** 按名字取绑定（缺省注册表序无关的取用面）。 */
function byName(tools: readonly ToolBinding[], name: string): ToolBinding {
	const found = tools.find((t) => t.definition.name === name);
	if (found === undefined) throw new Error(`test-setup: 工具 ${name} 未注册`);
	return found;
}

interface SpawnRecord {
	readonly cmd: readonly string[];
	readonly options: BashSpawnOptions;
}

interface FakeSpawnSpec {
	/** stdout/stderr 载荷（缺省空）。 */
	readonly stdout?: string;
	readonly stderr?: string;
	/** 正常退出码（缺省 0）。 */
	readonly exitCode?: number;
	/** 设为 true：exited 永不自行落定，直到 kill() 被调用（以 137 落定）。 */
	readonly resolveOnKill?: boolean;
}

/** spawn 替身：记录调用、产出受控流与退出码（零实弹）。 */
function fakeSpawn(spec: FakeSpawnSpec = {}): {
	spawnImpl: SpawnImpl;
	calls: SpawnRecord[];
	killCount: () => number;
} {
	const calls: SpawnRecord[] = [];
	let kills = 0;
	const spawnImpl: SpawnImpl = (cmd, options) => {
		calls.push({ cmd, options });
		let resolveExited!: (code: number) => void;
		const exited = new Promise<number>((res) => {
			resolveExited = res;
		});
		if (spec.resolveOnKill !== true) resolveExited(spec.exitCode ?? 0);
		return {
			exited,
			stdout: streamOf(spec.stdout ?? ""),
			stderr: streamOf(spec.stderr ?? ""),
			kill: () => {
				kills++;
				resolveExited(137); // SIGKILL 语义：128+9
			},
		};
	};
	return { spawnImpl, calls, killCount: () => kills };
}

/** 字符串 → 一次性可读流（替身 stdout/stderr 用）。 */
function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
}

/** 爆破替身：被调用即失败（零实弹保险丝）。 */
function explodingSpawn(): SpawnImpl {
	return () => {
		throw new Error("test-guard: spawn 不应被调用");
	};
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("BI-25.1/28 · 注册表构成", () => {
	test("六件工具全部在表：只读三件在前、写语义三件在后、definition/argSummary 面齐全", () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() });
		expect(namesOf(tools)).toEqual(["read_file", "web_fetch", "web_search", "bash", "edit", "write"]);
		const readOnlyNames = new Set(tools.filter((t) => t.readOnly).map((t) => t.definition.name));
		expect([...readOnlyNames].sort()).toEqual(["read_file", "web_fetch", "web_search"].sort());
		for (const tool of tools) {
			expect(tool.definition.description).toBeTruthy();
			expect(tool.definition.inputSchema).toHaveProperty("type", "object");
			expect(tool.argSummary).toBeInstanceOf(Function);
		}
		// argSummary：目标参数原文直出（审计面）
		const readFile = tools.find((t) => t.definition.name === "read_file")!;
		expect(readFile.argSummary?.({ path: "note.txt" })).toBe("note.txt");
		const webFetch = tools.find((t) => t.definition.name === "web_fetch")!;
		expect(webFetch.argSummary?.({ url: "https://x.test/" })).toBe("https://x.test/");
	});

	test("未挂面工具不在表：list_dir/grep/write_file 均未注册（器官在才挂）", () => {
		const names = new Set(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() })));
		expect(names.has("write_file")).toBe(false);
		expect(names.has("list_dir")).toBe(false);
		expect(names.has("grep")).toBe(false);
	});
});

describe("BI-25.1 · read_file（真实 fs）", () => {
	test("tmp cwd 真实读写：相对路径读回文件内容", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const readFile = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "read_file");
			const value = await readFile.execute({ path: "note.txt" }, SIGNAL);
			expect(value).toBe("勾稽差额为零");
		} finally {
			await cleanup();
		}
	});

	test("cwd 逃逸拒绝：相对越界 / 兄弟目录同前缀 / 绝对路径", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			// 兄弟目录同前缀：/bi-toolset-X 与 /bi-toolset-X-sib（字符串前缀命中、路径段不命中）
			const sibling = `${root}-sib`;
			await mkdir(sibling, { recursive: true });
			await writeFile(join(sibling, "outside.txt"), "界外", "utf8");
			const readFile = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "read_file");
			for (const path of ["../outside-escape.txt", `../${basename(sibling)}/outside.txt`, "/etc/hostname"]) {
				try {
					await readFile.execute({ path }, SIGNAL);
					expect.unreachable();
				} catch (e) {
					expect((e as Error).message).toBe("path-escape");
				}
			}
			await rm(sibling, { recursive: true, force: true });
		} finally {
			await cleanup();
		}
	});

	test("path 缺参/空串：结构化报错（不触 fs）", async () => {
		const readFile = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }), "read_file");
		for (const args of [undefined, {}, { path: "" }, { path: 42 }]) {
			try {
				await readFile.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("path required");
			}
		}
	});
});

describe("BI-25.1 · web 工具（注入 fetch 替身，零网络）", () => {
	test("web_fetch：HTML → markdown 主内容抽取，URL 透传替身", async () => {
		const { fetchImpl, calls } = routeFetch({
			"https://a.example.com/x": () =>
				htmlRes("<html><head><title>宏观速递</title></head><body><h1>利率决议</h1><p>维持不变。</p></body></html>"),
		});
		const webFetch = byName(buildDefaultToolset("/tmp", { fetchImpl, spawnImpl: explodingSpawn() }), "web_fetch");
		const value = (await webFetch.execute({ url: "https://a.example.com/x" }, SIGNAL)) as {
			url: string;
			title?: string;
			markdown?: string;
		};
		expect(calls).toEqual(["https://a.example.com/x"]);
		expect(value.url).toBe("https://a.example.com/x");
		expect(value.title).toBe("宏观速递");
		expect(value.markdown).toContain("利率决议");
	});

	test("web_fetch：http-error 结构化失败面（4xx 冒泡为执行异常）", async () => {
		const { fetchImpl } = routeFetch({
			"https://a.example.com/404": () => new Response("nope", { status: 404, headers: { "content-type": "text/plain" } }),
		});
		const webFetch = byName(buildDefaultToolset("/tmp", { fetchImpl, spawnImpl: explodingSpawn() }), "web_fetch");
		try {
			await webFetch.execute({ url: "https://a.example.com/404" }, SIGNAL);
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).toContain("HTTP 404");
		}
	});

	test("web_search：注入密钥 env + fetch 替身 → DeepSeek provider 出结构化结果", async () => {
		const { fetchImpl, calls } = routeFetch({
			"https://api.deepseek.com/chat/completions": () =>
				jsonRes({ choices: [{ message: { content: SEARCH_CONTENT } }] }),
		});
		const envName = "BI_TOOLSET_TEST_SEARCH_KEY";
		const webSearch = byName(buildDefaultToolset("/tmp", {
			fetchImpl,
			spawnImpl: explodingSpawn(),
			searchApiKeyEnv: envName,
			env: { [envName]: "test-key" },
		}), "web_search");
		const value = (await webSearch.execute({ query: "bi 工具面" }, SIGNAL)) as Array<{
			title: string;
			url: string;
			snippet: string;
			provider: string;
		}>;
		expect(calls).toHaveLength(1);
		expect(value).toHaveLength(1); // 无有效 URL 的噪声条目被 provider 跳过
		expect(value[0]).toMatchObject({ title: "BI 工具面", url: "https://a.example.com/bi", provider: "deepseek" });
	});

	test(`web_search 未配置密钥（${DEFAULT_SEARCH_API_KEY_ENV} 缺省语义）：结构化报错，不触网`, async () => {
		const { fetchImpl, calls } = routeFetch({});
		const webSearch = byName(buildDefaultToolset("/tmp", { fetchImpl, spawnImpl: explodingSpawn(), env: {} }), "web_search");
		try {
			await webSearch.execute({ query: "bi" }, SIGNAL);
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).toContain(DEFAULT_SEARCH_API_KEY_ENV);
		}
		expect(calls).toHaveLength(0);
	});

	test("web_search query 缺参：结构化报错（不建 provider、不触网）", async () => {
		const { fetchImpl, calls } = routeFetch({});
		const envName = "BI_TOOLSET_TEST_SEARCH_KEY";
		const webSearch = byName(buildDefaultToolset("/tmp", { fetchImpl, spawnImpl: explodingSpawn(), searchApiKeyEnv: envName, env: { [envName]: "k" } }), "web_search");
		for (const args of [undefined, {}, { query: "  " }]) {
			try {
				await webSearch.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("query required");
			}
		}
		expect(calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// BI-28.1 · bash（注入 spawn 替身，零实弹）
// ---------------------------------------------------------------------------

describe("BI-28.1 · bash（注入 spawn 替身）", () => {
	test("spawn 透传：cmd=[bash,-c,command]、cwd=工具集根、stdin=ignore、流为 pipe", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const { spawnImpl, calls } = fakeSpawn({ stdout: "hi\n", exitCode: 0 });
			const bash = byName(buildDefaultToolset(root, { spawnImpl }), "bash");
			const raw = (await bash.execute({ command: "echo hi" }, SIGNAL)) as string;
			expect(calls).toHaveLength(1);
			expect(calls[0]!.cmd).toEqual(["bash", "-c", "echo hi"]);
			expect(calls[0]!.options.cwd).toBe(root);
			expect(calls[0]!.options.stdin).toBe("ignore");
			expect(calls[0]!.options.stdout).toBe("pipe");
			expect(calls[0]!.options.stderr).toBe("pipe");
			const parsed = JSON.parse(raw) as { exitCode: number; output: string };
			expect(parsed.exitCode).toBe(0);
			expect(parsed.output).toContain("hi");
			expect(Object.keys(parsed)).not.toContain("timedOut");
			expect(Object.keys(parsed)).not.toContain("truncated");
		} finally {
			await cleanup();
		}
	});

	test("stdout+stderr 合并进同一 output（双流都计入）", async () => {
		const { spawnImpl } = fakeSpawn({ stdout: "OUT-1", stderr: "ERR-1", exitCode: 0 });
		const bash = byName(buildDefaultToolset("/tmp", { spawnImpl }), "bash");
		const parsed = JSON.parse((await bash.execute({ command: "x" }, SIGNAL)) as string) as { output: string };
		expect(parsed.output).toContain("OUT-1");
		expect(parsed.output).toContain("ERR-1");
	});

	test("exitCode 非 0 不抛错：命令失败是正常工具结果", async () => {
		const { spawnImpl, calls } = fakeSpawn({ stdout: "boom", exitCode: 3 });
		const bash = byName(buildDefaultToolset("/tmp", { spawnImpl }), "bash");
		const parsed = JSON.parse((await bash.execute({ command: "false" }, SIGNAL)) as string) as { exitCode: number };
		expect(parsed.exitCode).toBe(3);
		expect(calls).toHaveLength(1);
	});

	test("超时：timeout_ms 到点 kill，timedOut=true、exitCode=kill 后退出码", async () => {
		const { spawnImpl, killCount } = fakeSpawn({ resolveOnKill: true });
		const bash = byName(buildDefaultToolset("/tmp", { spawnImpl }), "bash");
		const parsed = JSON.parse((await bash.execute({ command: "sleep 999", timeout_ms: 50 }, SIGNAL)) as string) as {
			exitCode: number;
			timedOut?: boolean;
		};
		expect(killCount()).toBe(1);
		expect(parsed.timedOut).toBe(true);
		expect(parsed.exitCode).toBe(137);
	});

	test("截断：超过 100KB 只保留末尾 100KB，标记行在前、truncated=true", async () => {
		const head = "HEAD-MARKER";
		const big = `${head}${"a".repeat(120 * 1024)}`;
		const { spawnImpl } = fakeSpawn({ stdout: big, exitCode: 0 });
		const bash = byName(buildDefaultToolset("/tmp", { spawnImpl }), "bash");
		const raw = (await bash.execute({ command: "cat big" }, SIGNAL)) as string;
		const parsed = JSON.parse(raw) as { output: string; truncated?: boolean };
		expect(parsed.truncated).toBe(true);
		expect(parsed.output.startsWith(`${BASH_TRUNCATION_MARKER}\n`)).toBe(true);
		expect(parsed.output).not.toContain(head); // 头部已截
		// 保留尾 = 100KB 字节 + 标记行（ASCII 场景字符数与字节数一致）
		expect(parsed.output.length).toBe(BASH_TRUNCATION_MARKER.length + 1 + 100 * 1024);
		expect(raw.length).toBeLessThan(big.length); // 确实瘦身
	});

	test("argSummary：命令截断 120 字符；dangerous/opaque 带 shell-scan 标注；普通命令无标注", () => {
		const { spawnImpl } = fakeSpawn({});
		const bash = byName(buildDefaultToolset("/tmp", { spawnImpl }), "bash");
		expect(bash.argSummary?.({ command: "echo hi" })).toBe("echo hi");
		const long = "x".repeat(200);
		const summary = bash.argSummary?.({ command: long }) as string;
		expect(summary.startsWith(`${"x".repeat(120)}…`)).toBe(true);
		expect(summary).toBe(`${"x".repeat(120)}…`);
		expect(bash.argSummary?.({ command: "rm -rf /" })).toContain("[shell-scan:dangerous]");
		expect(bash.argSummary?.({ command: 'eval "$X"' })).toContain("[shell-scan:opaque]");
	});

	test("参数校验：command 缺参/非字符串、timeout_ms 非法 → 结构化报错，不触 spawn", async () => {
		const { spawnImpl, calls } = fakeSpawn({});
		const bash = byName(buildDefaultToolset("/tmp", { spawnImpl }), "bash");
		for (const args of [undefined, {}, { command: "" }, { command: 42 }]) {
			try {
				await bash.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("command required");
			}
		}
		for (const timeoutMs of [0, -5, 1.5, "100", null]) {
			try {
				await bash.execute({ command: "x", timeout_ms: timeoutMs }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("timeout_ms invalid");
			}
		}
		expect(calls).toHaveLength(0);
	});

	test(`缺省超时面：DEFAULT_BASH_TOOL_TIMEOUT_MS=${DEFAULT_BASH_TOOL_TIMEOUT_MS}（60s 语义钉死）`, () => {
		expect(DEFAULT_BASH_TOOL_TIMEOUT_MS).toBe(60_000);
	});

	test("已中止信号：不触 spawn、即刻拒绝", async () => {
		const { spawnImpl, calls } = fakeSpawn({});
		const bash = byName(buildDefaultToolset("/tmp", { spawnImpl }), "bash");
		const controller = new AbortController();
		controller.abort();
		try {
			await bash.execute({ command: "echo hi" }, controller.signal);
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).toBe("aborted");
		}
		expect(calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// BI-28.2 · edit / write（真实 fs 临时目录 + 共用路径守卫 + 原子写）
// ---------------------------------------------------------------------------

/** 逃逸三连（read_file/edit/write 共用守卫的参数化用例）。 */
async function expectPathEscape(execute: (path: string) => unknown, siblingBase: string): Promise<void> {
	for (const path of ["../outside-escape.txt", `../${siblingBase}/outside.txt`, "/etc/hostname"]) {
		try {
			await execute(path);
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).toBe("path-escape");
		}
	}
}

describe("BI-28.2 · edit（唯一性替换 + 原子写）", () => {
	test("唯一命中替换：落盘新内容，返回 matches=1", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "hello world\n", "utf8");
			const edit = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			const raw = (await edit.execute({ path: "doc.txt", old_string: "world", new_string: "there" }, SIGNAL)) as string;
			expect(JSON.parse(raw)).toMatchObject({ ok: true, path: "doc.txt", matches: 1 });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("hello there\n");
			// 原子写不残留临时文件
			expect((await readdir(root)).filter((n) => n.includes(".tmp"))).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("0 命中：edit-no-match 结构化报错（报匹配数）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "abc", "utf8");
			const edit = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			try {
				await edit.execute({ path: "doc.txt", old_string: "zzz", new_string: "y" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("edit-no-match: matches=0");
			}
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("abc"); // 原文件不动
		} finally {
			await cleanup();
		}
	});

	test("多处命中未 replace_all：edit-ambiguous（报匹配数）；replace_all=true 全量替换", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "aXbXc", "utf8");
			const edit = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			try {
				await edit.execute({ path: "doc.txt", old_string: "X", new_string: "Y" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("edit-ambiguous: matches=2 (set replace_all=true)");
			}
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("aXbXc"); // 拒绝时不落盘
			const raw = (await edit.execute({ path: "doc.txt", old_string: "X", new_string: "Y", replace_all: true }, SIGNAL)) as string;
			expect(JSON.parse(raw)).toMatchObject({ matches: 2 });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("aYbYc");
		} finally {
			await cleanup();
		}
	});

	test("空 new_string=删除；替换为字面 $& 语义（split/join，不走 $ 模式展开）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "abc", "utf8");
			const edit = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			await edit.execute({ path: "doc.txt", old_string: "b", new_string: "" }, SIGNAL);
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("ac");
			await edit.execute({ path: "doc.txt", old_string: "a", new_string: "$&" }, SIGNAL);
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("$&c");
		} finally {
			await cleanup();
		}
	});

	test("file-not-found：目标文件不存在 = 结构化报错", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const edit = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			try {
				await edit.execute({ path: "missing.txt", old_string: "a", new_string: "b" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("file-not-found");
			}
		} finally {
			await cleanup();
		}
	});

	test("路径守卫：逃逸三连拒绝 + PathJail 写裁决（工作区 .env）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const sibling = `${root}-sib`;
			await mkdir(sibling, { recursive: true });
			await writeFile(join(sibling, "outside.txt"), "界外", "utf8");
			const edit = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			await expectPathEscape(
				(path) => edit.execute({ path, old_string: "a", new_string: "b" }, SIGNAL),
				basename(sibling),
			);
			await rm(sibling, { recursive: true, force: true });
			try {
				await edit.execute({ path: ".env", old_string: "a", new_string: "b" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("path-protected: workspace-env");
			}
		} finally {
			await cleanup();
		}
	});

	test("argSummary：路径 + 真实匹配计数 + old/new 首行片段（审批浮层审计面）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "k=1\nk=2\n", "utf8");
			const edit = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			const summary = edit.argSummary?.({ path: "doc.txt", old_string: "k=1", new_string: "v=1\nv=2" }) as string;
			expect(summary).toContain("path=doc.txt");
			expect(summary).toContain("matches=1");
			expect(summary).toContain('old="k=1"');
			expect(summary).toContain('new="v=1…"'); // new 首行 + 多行省略号
			const ambiguous = edit.argSummary?.({ path: "doc.txt", old_string: "k=", new_string: "v=" }) as string;
			expect(ambiguous).toContain("matches=2");
			const missing = edit.argSummary?.({ path: "ghost.txt", old_string: "a", new_string: "b" }) as string;
			expect(missing).toContain("matches=?"); // 读不到 = 容错占位，绝不抛
		} finally {
			await cleanup();
		}
	});

	test("参数校验：path 缺参 / old_string 或 new_string 非字符串 → 结构化报错", async () => {
		const edit = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }), "edit");
		for (const args of [undefined, {}, { path: "" }, { path: "a", old_string: "x" }, { path: "a", old_string: 1, new_string: "b" }, { path: "a", old_string: "x", new_string: 2 }]) {
			try {
				await edit.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect(["path required", "old_string required", "new_string required"]).toContain((e as Error).message);
			}
		}
	});
});

describe("BI-28.2 · write（整文件原子写）", () => {
	test("新建文件（父目录已存在）与覆盖已有文件；返回 bytes=内容字节数", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await mkdir(join(root, "sub"), { recursive: true });
			const write = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "write");
			const content = "第一行\n第二行\n";
			const raw = (await write.execute({ path: "sub/new.txt", content }, SIGNAL)) as string;
			expect(JSON.parse(raw)).toMatchObject({ ok: true, path: "sub/new.txt", bytes: new TextEncoder().encode(content).byteLength });
			expect(await readFile(join(root, "sub/new.txt"), "utf8")).toBe(content);
			await write.execute({ path: "note.txt", content: "覆盖后的内容" }, SIGNAL);
			expect(await readFile(join(root, "note.txt"), "utf8")).toBe("覆盖后的内容");
			// 原子写不残留临时文件
			expect((await readdir(join(root, "sub"))).filter((n) => n.includes(".tmp"))).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("父目录缺失：parent-dir-not-found 结构化报错（不建目录）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const write = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "write");
			try {
				await write.execute({ path: "no-such-dir/f.txt", content: "x" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("parent-dir-not-found");
			}
			expect((await readdir(root)).filter((n) => n === "no-such-dir")).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("空 content=清空文件；路径守卫：逃逸三连 + PathJail（.env / 凭据文件名）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const sibling = `${root}-sib`;
			await mkdir(sibling, { recursive: true });
			await writeFile(join(sibling, "outside.txt"), "界外", "utf8");
			const write = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "write");
			await write.execute({ path: "note.txt", content: "" }, SIGNAL);
			expect(await readFile(join(root, "note.txt"), "utf8")).toBe("");
			await expectPathEscape((path) => write.execute({ path, content: "x" }, SIGNAL), basename(sibling));
			await rm(sibling, { recursive: true, force: true });
			for (const [path, reason] of [
				[".env", "workspace-env"],
				["id_rsa", "credential-filename"],
			] as const) {
				try {
					await write.execute({ path, content: "x" }, SIGNAL);
					expect.unreachable();
				} catch (e) {
					expect((e as Error).message).toBe(`path-protected: ${reason}`);
				}
			}
		} finally {
			await cleanup();
		}
	});

	test("argSummary：路径 + 内容字节数", () => {
		const write = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }), "write");
		const content = "勾稽";
		expect(write.argSummary?.({ path: "note.txt", content })).toBe(
			`path=note.txt bytes=${new TextEncoder().encode(content).byteLength}`,
		);
	});

	test("参数校验：path/content 缺参或非字符串 → 结构化报错", async () => {
		const write = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }), "write");
		for (const args of [undefined, {}, { path: "" }, { path: "a" }, { path: "a", content: 1 }, { path: 2, content: "x" }]) {
			try {
				await write.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect(["path required", "content required"]).toContain((e as Error).message);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 信号透传（全工具面）
// ---------------------------------------------------------------------------

describe("BI-25.1/28 · 信号透传", () => {
	test("信号透传：已中止的 signal 即刻拒绝（绑定层竞出，不悬挂、不触 spawn/fs）", async () => {
		const { fetchImpl, calls } = routeFetch({
			"https://a.example.com/slow": () => htmlRes("<html><body>慢</body></html>"),
		});
		const envName = "BI_TOOLSET_TEST_SEARCH_KEY";
		const tools = buildDefaultToolset("/tmp", { fetchImpl, spawnImpl: explodingSpawn(), searchApiKeyEnv: envName, env: { [envName]: "k" } });
		const argsByName: Record<string, unknown> = {
			read_file: { path: "note.txt" },
			web_fetch: { url: "https://a.example.com/slow" },
			web_search: { query: "慢查询" },
			bash: { command: "echo hi" },
			edit: { path: "note.txt", old_string: "a", new_string: "b" },
			write: { path: "note.txt", content: "x" },
		};
		const controller = new AbortController();
		controller.abort();
		for (const tool of tools) {
			try {
				await tool.execute(argsByName[tool.definition.name], controller.signal);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("aborted");
			}
		}
		expect(calls).toHaveLength(0); // 已中止：器官调用根本不启动
	});
});
