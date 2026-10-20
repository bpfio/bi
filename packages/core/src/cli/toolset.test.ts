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
 * 6. glob/grep（BI-28.5）：注入临时树的真实扫描——单星不递归/双星递归/起点
 *    path、grep 跳过面（node_modules/隐藏条目/二进制/超限文件/凭据文件名）、
 *    include 过滤、条数与输出双封顶、非法正则结构化报错、读路径守卫（逃逸
 *    三连 + PathJail read 裁决）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import {
	buildDefaultToolset,
	makeSelectToolsRegistry,
	DEFAULT_SEARCH_API_KEY_ENV,
	DEFAULT_BASH_TOOL_TIMEOUT_MS,
	BASH_TRUNCATION_MARKER,
	GLOB_RESULT_LIMIT,
	GREP_MATCH_LIMIT,
	GREP_OUTPUT_TAIL_LIMIT_BYTES,
	GREP_TRUNCATION_MARKER,
	type SpawnImpl,
	type BashSpawnOptions,
} from "./toolset";
import type { ToolBinding } from "./headless";
import type { FetchExecutor } from "../tools/web-fetch";
import { pngBytes } from "../tool/handlers/read-media-file.test";
import type { LspToolClientLike } from "../../../mcp/src/lsp/lsp-tool";
import { SwarmService } from "../subagent/swarm/swarm-service";
import { SkillRegistry, type SkillFsPort } from "../subagent/skill-executor";

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
	test("八件工具全部在表：只读五件在前、写语义三件在后、definition/argSummary 面齐全", () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() });
		expect(namesOf(tools)).toEqual([
			"read_file",
			"web_fetch",
			"web_search",
			"glob",
			"grep",
			"bash",
			"edit",
			"write",
		]);
		const readOnlyNames = new Set(tools.filter((t) => t.readOnly).map((t) => t.definition.name));
		expect([...readOnlyNames].sort()).toEqual(
			["read_file", "web_fetch", "web_search", "glob", "grep"].sort(),
		);
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

	test("未挂面工具不在表：list_dir/write_file 均未注册（器官在才挂；BI-28.5 起 grep/glob 已挂）", () => {
		const names = new Set(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() })));
		expect(names.has("write_file")).toBe(false);
		expect(names.has("list_dir")).toBe(false);
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
// BI-28.5 · glob / grep（注入临时树的真实扫描，零网络）
// ---------------------------------------------------------------------------

/** glob/grep 共用扫描树：常规文件 + 各类应跳过面（二进制/超限/隐藏/凭据）。 */
async function makeScanTree(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-scan-"));
	await writeFile(join(root, "a.ts"), "TODO: 根级待办\nexport const a = 1;\n", "utf8");
	await mkdir(join(root, "sub", "deep"), { recursive: true });
	await writeFile(join(root, "sub", "b.ts"), "TODO: 子目录待办\n", "utf8");
	await writeFile(join(root, "sub", "deep", "c.txt"), "TODO: 深层待办\n", "utf8");
	await mkdir(join(root, "node_modules"), { recursive: true });
	await writeFile(join(root, "node_modules", "vendored.ts"), "TODO: 三方包内\n", "utf8");
	await mkdir(join(root, ".hidden"), { recursive: true });
	await writeFile(join(root, ".hidden", "h.ts"), "TODO: 隐藏目录内\n", "utf8");
	await writeFile(join(root, "blob.bin"), "TODO: 伪装文本\u0000二进制", "utf8");
	// >1MB 的单文件（超 GREP_FILE_SIZE_LIMIT_BYTES，整文件跳过）
	await writeFile(join(root, "big.log"), `x${"TODO: 巨文件".repeat(200_000)}`, "utf8");
	await writeFile(join(root, "id_rsa"), "TODO: 凭据文件名\n", "utf8");
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("BI-28.5 · glob（Bun.Glob 扫描）", () => {
	test("单星不递归 + 双星递归 + 起点收窄：返回排序相对路径与计数", async () => {
		const { root, cleanup } = await makeScanTree();
		try {
			const glob = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "glob");
			const rootLevel = JSON.parse((await glob.execute({ pattern: "*.ts" }, SIGNAL)) as string) as {
				matches: string[];
				count: number;
			};
			expect(rootLevel.matches).toEqual(["a.ts"]); // 单星不跨目录；隐藏/子目录不入
			expect(rootLevel.count).toBe(1);
			const all = JSON.parse((await glob.execute({ pattern: "**/*.ts" }, SIGNAL)) as string) as {
				matches: string[];
			};
			// Bun.Glob 纯语义：node_modules 不排除（dot:false 仅挡 .hidden），封顶防护
			expect(all.matches).toEqual(["a.ts", "node_modules/vendored.ts", "sub/b.ts"]);
			const scoped = JSON.parse(
				(await glob.execute({ pattern: "*.ts", path: "sub" }, SIGNAL)) as string,
			) as { matches: string[] };
			expect(scoped.matches).toEqual(["sub/b.ts"]); // 相对工作区根呈现
		} finally {
			await cleanup();
		}
	});

	test(`封顶：超过 GLOB_RESULT_LIMIT=${GLOB_RESULT_LIMIT} 截断并标注 truncated=true`, async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-glob-cap-"));
		try {
			for (let i = 0; i < GLOB_RESULT_LIMIT + 5; i++) {
				await writeFile(join(root, `f${String(i).padStart(4, "0")}.txt`), "x", "utf8");
			}
			const glob = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "glob");
			const parsed = JSON.parse((await glob.execute({ pattern: "*.txt" }, SIGNAL)) as string) as {
				count: number;
				truncated?: boolean;
			};
			expect(parsed.count).toBe(GLOB_RESULT_LIMIT);
			expect(parsed.truncated).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("路径守卫：逃逸三连拒绝 + PathJail read 裁决（工作区 .env）", async () => {
		const { root, cleanup } = await makeScanTree();
		try {
			const sibling = `${root}-sib`;
			await mkdir(sibling, { recursive: true });
			const glob = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "glob");
			await expectPathEscape((path) => glob.execute({ pattern: "*.txt", path }, SIGNAL), basename(sibling));
			await rm(sibling, { recursive: true, force: true });
			await writeFile(join(root, ".env"), "K=1", "utf8");
			try {
				await glob.execute({ pattern: "*", path: ".env" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("path-protected: workspace-env");
			}
		} finally {
			await cleanup();
		}
	});

	test("argSummary 与参数校验：pattern 缺参结构化报错", async () => {
		const glob = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }), "glob");
		expect(glob.argSummary?.({ pattern: "**/*.ts", path: "src" })).toBe("pattern=**/*.ts path=src");
		for (const args of [undefined, {}, { pattern: "" }, { pattern: 42 }]) {
			try {
				await glob.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("pattern required");
			}
		}
	});
});

describe("BI-28.5 · grep（递归正则扫描）", () => {
	test("递归命中 file:line:text；跳过面全生效（node_modules/隐藏/二进制/超限/凭据文件名）", async () => {
		const { root, cleanup } = await makeScanTree();
		try {
			const grep = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "grep");
			const parsed = JSON.parse((await grep.execute({ pattern: "TODO" }, SIGNAL)) as string) as {
				count: number;
				output: string;
			};
			// 命中仅三个常规文件；node_modules/.hidden/blob.bin/big.log/id_rsa 全部不入结果
			expect(parsed.count).toBe(3);
			expect(parsed.output).toBe(
				["a.ts:1:TODO: 根级待办", "sub/b.ts:1:TODO: 子目录待办", "sub/deep/c.txt:1:TODO: 深层待办"].join("\n"),
			);
		} finally {
			await cleanup();
		}
	});

	test("include 过滤（对相对路径 glob）与单文件起点、起点收窄", async () => {
		const { root, cleanup } = await makeScanTree();
		try {
			const grep = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "grep");
			const onlyTs = JSON.parse(
				(await grep.execute({ pattern: "TODO", include: "*.ts" }, SIGNAL)) as string,
			) as { count: number };
			expect(onlyTs.count).toBe(2); // a.ts + sub/b.ts（c.txt 被过滤）
			const onlySubTs = JSON.parse(
				(await grep.execute({ pattern: "TODO", include: "sub/*.ts" }, SIGNAL)) as string,
			) as { count: number; output: string };
			// 含 "/" 的 glob 对工作区相对路径匹配：单星不跨段，只命中 sub/b.ts
			expect(onlySubTs.count).toBe(1);
			expect(onlySubTs.output).toBe("sub/b.ts:1:TODO: 子目录待办");
			const subDir = JSON.parse(
				(await grep.execute({ pattern: "TODO", path: "sub" }, SIGNAL)) as string,
			) as { count: number; output: string };
			expect(subDir.count).toBe(2);
			expect(subDir.output).toContain("sub/b.ts:1:");
			expect(subDir.output).toContain("sub/deep/c.txt:1:");
			const single = JSON.parse(
				(await grep.execute({ pattern: "TODO", path: "sub/b.ts" }, SIGNAL)) as string,
			) as { count: number; output: string };
			expect(single.count).toBe(1);
			expect(single.output).toBe("sub/b.ts:1:TODO: 子目录待办");
		} finally {
			await cleanup();
		}
	});

	test(`双封顶：命中 > GREP_MATCH_LIMIT=${GREP_MATCH_LIMIT} 截断；输出 > 10KB 保留尾部（bash 同款标记）`, async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-grep-cap-"));
		try {
			// 250 行命中、每行约 100 字节：条数先顶到 GREP_MATCH_LIMIT，输出同时超 10KB
			const line = `m${"z".repeat(90)}m\n`;
			await writeFile(join(root, "many.txt"), line.repeat(GREP_MATCH_LIMIT + 50), "utf8");
			const grep = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "grep");
			const raw = (await grep.execute({ pattern: "^m.*m$" }, SIGNAL)) as string;
			const parsed = JSON.parse(raw) as { count: number; output: string; truncated?: boolean; outputTruncated?: boolean };
			expect(parsed.count).toBe(GREP_MATCH_LIMIT);
			expect(parsed.truncated).toBe(true);
			expect(parsed.outputTruncated).toBe(true);
			expect(parsed.output.startsWith(`${GREP_TRUNCATION_MARKER}\n`)).toBe(true);
			expect(parsed.output.length).toBeGreaterThan(GREP_OUTPUT_TAIL_LIMIT_BYTES);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("路径守卫：逃逸三连拒绝 + PathJail read 裁决（.env 起点）；路径不存在结构化报错", async () => {
		const { root, cleanup } = await makeScanTree();
		try {
			const sibling = `${root}-sib`;
			await mkdir(sibling, { recursive: true });
			await writeFile(join(sibling, "outside.txt"), "TODO 界外", "utf8");
			const grep = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "grep");
			await expectPathEscape((path) => grep.execute({ pattern: "TODO", path }, SIGNAL), basename(sibling));
			await rm(sibling, { recursive: true, force: true });
			await writeFile(join(root, ".env"), "TODO SECRET=1", "utf8");
			try {
				await grep.execute({ pattern: "TODO", path: ".env" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("path-protected: workspace-env");
			}
			try {
				await grep.execute({ pattern: "TODO", path: "no-such-dir" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("grep-path-not-found");
			}
		} finally {
			await cleanup();
		}
	});

	test("非法正则与缺参：结构化报错（不触 fs）；argSummary 审计面", async () => {
		const grep = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }), "grep");
		try {
			await grep.execute({ pattern: "([bad" }, SIGNAL);
			expect.unreachable();
		} catch (e) {
			expect((e as Error).message).toContain("grep-pattern-invalid");
		}
		for (const args of [undefined, {}, { pattern: "" }]) {
			try {
				await grep.execute(args, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("pattern required");
			}
		}
		expect(grep.argSummary?.({ pattern: "TODO", path: "src", include: "*.ts" })).toBe(
			"pattern=TODO path=src include=*.ts",
		);
		expect(grep.argSummary?.({ pattern: "TODO" })).toBe("pattern=TODO path=.");
	});
});

// ---------------------------------------------------------------------------
// BI-08.3 / BI-07.11 · 挂载式门控（缺省零变动；显式开启才挂）
// ---------------------------------------------------------------------------

describe("BI-08.3 / BI-07.11 · 挂载式门控", () => {
	test("缺省（不传开关）：工具名集合不含 read_media_file / JobList / JobOutput / JobKill（现状回归）", () => {
		const names = new Set(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() })));
		expect(names.has("read_media_file")).toBe(false);
		expect(names.has("JobList")).toBe(false);
		expect(names.has("JobOutput")).toBe(false);
		expect(names.has("JobKill")).toBe(false);
	});

	test("media:true → 含 read_media_file；execute 对临时目录最小合法 PNG 返回结构化元数据 + base64", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			// 复用 read-media-file.test.ts 现有 PNG 字节 fixture（3x2，33 字节）。
			await writeFile(join(root, "pic.png"), pngBytes(3, 2));
			const media = byName(
				buildDefaultToolset(root, { spawnImpl: explodingSpawn(), media: true }),
				"read_media_file",
			);
			const result = (await media.execute({ path: "pic.png" }, SIGNAL)) as {
				ok: boolean;
				metadata: { mimeType: string; bytes: number; width: number; height: number; delivery: string };
				base64: string;
			};
			expect(result.ok).toBe(true);
			expect(result.metadata.mimeType).toBe("image/png");
			expect(result.metadata.bytes).toBe(33);
			expect(result.metadata.width).toBe(3);
			expect(result.metadata.height).toBe(2);
			expect(result.metadata.delivery).toBe("inline-base64");
			// base64 往返：解码后与原字节逐位一致（验证 fs 端口真实读入）。
			expect(Buffer.from(result.base64, "base64").equals(Buffer.from(pngBytes(3, 2)))).toBe(true);
			expect(media.readOnly).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("jobs:true → 含 JobList/JobOutput/JobKill；JobList execute 返回 {ok:true, jobs:[]}", async () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), jobs: true });
		const names = namesOf(tools);
		expect(names).toContain("JobList");
		expect(names).toContain("JobOutput");
		expect(names).toContain("JobKill");
		const jobList = byName(tools, "JobList");
		expect(jobList.readOnly).toBe(true);
		const jobOutput = byName(tools, "JobOutput");
		expect(jobOutput.readOnly).toBe(true);
		const jobKill = byName(tools, "JobKill");
		expect(jobKill.readOnly).toBe(false);
		const listed = (await jobList.execute({}, SIGNAL)) as { ok: true; jobs: unknown[] };
		expect(listed.ok).toBe(true);
		expect(listed.jobs).toEqual([]);
	});

	test("定义面以 JOB_*_TOOL_SPEC 为单一事实源（name/description 与器官一致，inputSchema 为对象）", () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), jobs: true });
		const listDef = byName(tools, "JobList").definition;
		expect(listDef.name).toBe("JobList");
		expect(typeof listDef.description).toBe("string");
		expect(listDef.inputSchema).toHaveProperty("type", "object");
		const killDef = byName(tools, "JobKill").definition;
		expect(killDef.name).toBe("JobKill");
	});
});

// ---------------------------------------------------------------------------
// 工单 C · BI-13.2 / BI-07.8 / BI-07.9 · 三器官挂载式门控 + execute 行为
// ---------------------------------------------------------------------------

/** LSP server 注入缝替身（LspToolClientLike；零真实 server）。 */
const stubLspClient: LspToolClientLike = {
	goToDefinition: async (filePath, line, character) => ({
		operation: "goToDefinition",
		locations: [{ uri: filePath, startLine: line, startCharacter: character, endLine: line, endCharacter: character }],
		totalLocations: 1,
		omittedLocations: 0,
		truncated: false,
		rendered: `${filePath}:${line}`,
	}),
	findReferences: async () => ({
		operation: "findReferences",
		locations: [],
		totalLocations: 0,
		omittedLocations: 0,
		truncated: false,
		rendered: "",
	}),
	goToImplementation: async () => ({
		operation: "goToImplementation",
		locations: [],
		totalLocations: 0,
		omittedLocations: 0,
		truncated: false,
		rendered: "",
	}),
	hover: async (filePath, line, character) => ({
		operation: "hover",
		found: true,
		contents: "doc",
		truncated: false,
		rendered: `${filePath}:${line}`,
	}),
};

/** SwarmService 替身：spawnFn 直接回显 prompt（零真实子进程/子代理）。 */
function makeSwarmService(): SwarmService {
	return new SwarmService(async (prompt) => `out:${prompt}`);
}

/** Skill 注册表 fs 替身：按技能名 → SKILL.md 正文映射（零真实磁盘）。 */
function makeSkillFs(skillBodies: Record<string, string>): SkillFsPort {
	const SKILLS_SUFFIX = "/skills";
	return {
		readdir: (dir) => (dir.endsWith(SKILLS_SUFFIX) ? Object.keys(skillBodies) : []),
		readFile: (path) => {
			const name = basename(dirname(path));
			const body = skillBodies[name];
			if (body === undefined) throw new Error(`no skill file: ${path}`);
			return body;
		},
		isDirectory: (path) =>
			path.endsWith(SKILLS_SUFFIX) || Object.prototype.hasOwnProperty.call(skillBodies, basename(path)),
	};
}

const REVIEW_SKILL =
	"---\nname: review\ndescription: r\nparams:\n  pr:\n    type: number\n    required: true\n    description: PR 编号\n---\n展开 {{pr}}\n";

describe("工单 C · BI-13.2 / BI-07.8 / BI-07.9 · 三器官挂载式门控", () => {
	test("缺省（不传三开关）：工具名集合不含 lsp_navigate / AgentSwarm / Skill（现状回归）", () => {
		const names = new Set(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() })));
		expect(names.has("lsp_navigate")).toBe(false);
		expect(names.has("AgentSwarm")).toBe(false);
		expect(names.has("Skill")).toBe(false);
	});

	// --- BI-13.2 lsp_navigate ---
	test("lsp:true → 含 lsp_navigate（readOnly=true）；注册名覆盖为 lsp_navigate", () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), lsp: true });
		const names = namesOf(tools);
		expect(names).toContain("lsp_navigate");
		const lsp = byName(tools, "lsp_navigate");
		expect(lsp.readOnly).toBe(true);
		expect(lsp.definition.name).toBe("lsp_navigate");
		expect(lsp.definition.inputSchema).toHaveProperty("type", "object");
	});

	test("lsp:true 但 lspClient 未注入 → execute 结构化返回 {ok:false,code:'lsp-unavailable'}，不抛", async () => {
		const lsp = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), lsp: true }), "lsp_navigate");
		const res = JSON.parse((await lsp.execute({ operation: "hover", file_path: "/a.ts", line: 0, character: 0 }, SIGNAL)) as string) as {
			ok: false;
			code: string;
		};
		expect(res.ok).toBe(false);
		expect(res.code).toBe("lsp-unavailable");
	});

	test("lsp:true 且注入 lspClient → execute 委托器官 dispatch（hover 透传结果）", async () => {
		const lsp = byName(
			buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), lsp: true, lspClient: stubLspClient }),
			"lsp_navigate",
		);
		const res = JSON.parse(
			(await lsp.execute({ operation: "hover", file_path: "/a.ts", line: 3, character: 5 }, SIGNAL)) as string,
		) as { ok: true; result: { operation: string; rendered: string } };
		expect(res.ok).toBe(true);
		expect(res.result.operation).toBe("hover");
		expect(res.result.rendered).toContain("/a.ts:3");
	});

	// --- BI-07.8 AgentSwarm ---
	test("swarm:true 但 swarmRunner 未注入 → 不挂载（依赖缺失不伪造能力）", () => {
		const names = new Set(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), swarm: true })));
		expect(names.has("AgentSwarm")).toBe(false);
	});

	test("swarm:true 且注入 swarmRunner → 含 AgentSwarm（readOnly=false）；execute 派发蜂群返回 ok:true", async () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), swarm: true, swarmRunner: makeSwarmService() });
		const names = namesOf(tools);
		expect(names).toContain("AgentSwarm");
		const swarm = byName(tools, "AgentSwarm");
		expect(swarm.readOnly).toBe(false);
		expect(swarm.definition.name).toBe("AgentSwarm");
		const res = JSON.parse(
			(await swarm.execute({ tasks: ["x", "y"], prompt_template: "do {{item}}" }, SIGNAL)) as string,
		) as { ok: true; results: Array<{ item: string; ok: boolean; output: string }>; failed: number; total: number };
		expect(res.ok).toBe(true);
		expect(res.total).toBe(2);
		expect(res.results[0]!.output).toBe("out:do x");
		expect(res.results[1]!.output).toBe("out:do y");
	});

	// --- BI-07.9 Skill ---
	test("skill:true → 含 Skill（readOnly=true）；skills 目录缺失 → execute 返回 {ok:false,code:'no-skills'}", async () => {
		const tools = buildDefaultToolset("/tmp", {
			spawnImpl: explodingSpawn(),
			skill: true,
			skillRegistry: new SkillRegistry({ fs: makeSkillFs({}) }),
		});
		const names = namesOf(tools);
		expect(names).toContain("Skill");
		const skill = byName(tools, "Skill");
		expect(skill.readOnly).toBe(true);
		expect(skill.definition.name).toBe("Skill");
		const res = JSON.parse((await skill.execute({ skill: "anything" }, SIGNAL)) as string) as { ok: false; code: string };
		expect(res.ok).toBe(false);
		expect(res.code).toBe("no-skills");
	});

	test("skill:true 且注入含技能 registry → execute 展开 SKILL.md 为注入 prompt（ok:true）", async () => {
		const registry = new SkillRegistry({
			fs: makeSkillFs({ review: REVIEW_SKILL }),
			userSkillsDir: "/u/.bi/skills",
			workspaceSkillsDir: "/w/.bi/skills",
		});
		const skill = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), skill: true, skillRegistry: registry }), "Skill");
		const res = JSON.parse(
			(await skill.execute({ skill: "review", input: { pr: 7 } }, SIGNAL)) as string,
		) as { ok: true; skill: string; prompt: string; params: Record<string, unknown> };
		expect(res.ok).toBe(true);
		expect(res.skill).toBe("review");
		expect(res.prompt).toBe("展开 7\n");
		expect(res.params).toMatchObject({ pr: 7 });
	});

	test("skill:true 且参数非法（缺 skill）→ execute 结构化返回 invalid-input（不触 registry 崩溃）", async () => {
		const registry = new SkillRegistry({
			fs: makeSkillFs({ review: REVIEW_SKILL }),
			userSkillsDir: "/u/.bi/skills",
			workspaceSkillsDir: "/w/.bi/skills",
		});
		const skill = byName(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), skill: true, skillRegistry: registry }), "Skill");
		const res = JSON.parse((await skill.execute({ input: {} }, SIGNAL)) as string) as { ok: false; code: string };
		expect(res.ok).toBe(false);
		expect(res.code).toBe("invalid-input");
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
			glob: { pattern: "**/*.txt" },
			grep: { pattern: "x" },
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

// ---------------------------------------------------------------------------
// 工单 G · BI-13.1/BI-13.3 · select_tools 挂载式门控 + 名录后端（buildCatalog）
// ---------------------------------------------------------------------------

describe("工单 G · BI-13.1/BI-13.3 · select_tools", () => {
	test("缺省（不传开关）/ select_tools:false → 工具名集合不含 select_tools（零变动回归）", () => {
		expect(new Set(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() }))).has("select_tools")).toBe(false);
		expect(
			new Set(namesOf(buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), select_tools: false }))).has("select_tools"),
		).toBe(false);
	});

	test("select_tools:true → 含 select_tools（readOnly=true）；定义面 name/inputSchema 齐备（names 必填）", () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), select_tools: true });
		const names = namesOf(tools);
		expect(names).toContain("select_tools");
		const st = byName(tools, "select_tools");
		expect(st.readOnly).toBe(true);
		expect(st.definition.name).toBe("select_tools");
		expect(st.definition.inputSchema).toHaveProperty("type", "object");
		expect((st.definition.inputSchema as Record<string, unknown>)["required"]).toEqual(["names"]);
	});

	test("execute 传入名录中名字 → 返回对应工具全量 inputSchema（含 server 路由，与绑定定义一致）", async () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), select_tools: true });
		const st = byName(tools, "select_tools");
		const raw = (await st.execute({ names: ["read_file"] }, SIGNAL)) as string;
		const res = JSON.parse(raw) as {
			activated: Array<{ name: string; server: string; inputSchema: unknown }>;
			unknown: unknown[];
		};
		expect(res.activated).toHaveLength(1);
		expect(res.activated[0]!.name).toBe("read_file");
		expect(res.activated[0]!.server).toBe("builtin");
		// 全量 inputSchema 与 read_file 绑定定义逐字节一致（select 换回全 schema）。
		expect(res.activated[0]!.inputSchema).toEqual(byName(tools, "read_file").definition.inputSchema);
		expect(res.unknown).toEqual([]);
	});

	test("execute 传入未知名 → 结构化 unknown + 最近候选建议（非空，且含正确候选）", async () => {
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn(), select_tools: true });
		const st = byName(tools, "select_tools");
		const raw = (await st.execute({ names: ["read_fle"] }, SIGNAL)) as string;
		const res = JSON.parse(raw) as {
			activated: unknown[];
			unknown: Array<{ kind: string; name: string; suggestions?: string[] }>;
		};
		expect(res.activated).toEqual([]);
		expect(res.unknown).toHaveLength(1);
		expect(res.unknown[0]!.kind).toBe("unknown-tool");
		expect(res.unknown[0]!.name).toBe("read_fle");
		expect(res.unknown[0]!.suggestions).toBeDefined();
		expect(res.unknown[0]!.suggestions!.length).toBeGreaterThan(0);
		expect(res.unknown[0]!.suggestions!).toContain("read_file");
	});

	test("BI-13.3：名录后端（buildCatalog）接入后摘要非空（命名空间 builtin + 渐进摘要行）", () => {
		// 用缺省工具集（8 件）建 registry，断言 catalog 与 flattenBudget 摘要均非空。
		const tools = buildDefaultToolset("/tmp", { spawnImpl: explodingSpawn() });
		const registry = makeSelectToolsRegistry(tools);
		expect(registry.catalog.totalTools).toBeGreaterThan(0);
		const summary = registry.catalogSummary();
		expect(summary.length).toBeGreaterThan(0);
		// 摘要行形态：`- builtin.<tool>(...)`（BI-13.3 单行签名）。
		expect(summary[0]).toMatch(/^- builtin\./);
	});
});
