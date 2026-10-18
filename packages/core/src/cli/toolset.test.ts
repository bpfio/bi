/**
 * BI-25.1 —— 缺省工具注册表面验收（全离线：web 工具注入 fetch 替身，零网络）。
 *
 * 覆盖：
 * 1. 注册表构成：三件工具（read_file/web_fetch/web_search）、全 readOnly、
 *    definition/argSummary 面齐全；未知工具（bash/写类/list_dir）不在表。
 * 2. read_file 真实 fs 读写（tmp cwd）+ cwd 逃逸拒绝（相对越界 / 兄弟目录同前缀 /
 *    绝对路径）+ path 缺参报错。
 * 3. web 工具注入 fetch 替身的执行路径：web_fetch 抓 HTML → markdown；
 *    web_search 经 DeepSeek provider（注入密钥 env + fetch 替身）出结构化结果；
 *    未配置密钥结构化报错；abort 信号绑定层竞出。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { buildDefaultToolset, DEFAULT_SEARCH_API_KEY_ENV } from "./toolset";
import type { ToolBinding } from "./headless";
import type { FetchExecutor } from "../tools/web-fetch";

// ---------------------------------------------------------------------------
// 底座：tmp 工作区 / fetch 替身 / AbortSignal
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

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("BI-25.1 · 注册表构成", () => {
	test("三件工具全部在表：全 readOnly、definition 面齐全、argSummary 可用", () => {
		const tools = buildDefaultToolset("/tmp");
		expect(namesOf(tools)).toEqual(["read_file", "web_fetch", "web_search"]);
		for (const tool of tools) {
			expect(tool.readOnly).toBe(true); // 首批面无写语义工具
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

	test("未知工具不在表：bash/写类/list_dir 均未注册（器官在才挂）", () => {
		const names = new Set(namesOf(buildDefaultToolset("/tmp")));
		expect(names.has("bash")).toBe(false);
		expect(names.has("write_file")).toBe(false);
		expect(names.has("list_dir")).toBe(false);
		expect(names.has("grep")).toBe(false);
	});
});

describe("BI-25.1 · read_file（真实 fs）", () => {
	test("tmp cwd 真实读写：相对路径读回文件内容", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			const readFile = byName(buildDefaultToolset(root), "read_file");
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
			const readFile = byName(buildDefaultToolset(root), "read_file");
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
		const readFile = byName(buildDefaultToolset("/tmp"), "read_file");
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
		const webFetch = byName(buildDefaultToolset("/tmp", { fetchImpl }), "web_fetch");
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
		const webFetch = byName(buildDefaultToolset("/tmp", { fetchImpl }), "web_fetch");
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
		const webSearch = byName(buildDefaultToolset("/tmp", { fetchImpl, env: {} }), "web_search");
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
		const webSearch = byName(buildDefaultToolset("/tmp", { fetchImpl, searchApiKeyEnv: envName, env: { [envName]: "k" } }), "web_search");
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

	test("信号透传：已中止的 signal 即刻拒绝（绑定层竞出，不悬挂）", async () => {
		const { fetchImpl, calls } = routeFetch({
			"https://a.example.com/slow": () => htmlRes("<html><body>慢</body></html>"),
		});
		const envName = "BI_TOOLSET_TEST_SEARCH_KEY";
		const tools = buildDefaultToolset("/tmp", { fetchImpl, searchApiKeyEnv: envName, env: { [envName]: "k" } });
		const argsByName: Record<string, unknown> = {
			read_file: { path: "note.txt" },
			web_fetch: { url: "https://a.example.com/slow" },
			web_search: { query: "慢查询" },
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
