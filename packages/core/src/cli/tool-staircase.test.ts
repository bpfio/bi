/**
 * BI-07.1 装配验收 —— edit 工具的 8 级阶梯弹性匹配（经 buildDefaultToolset 切入）。
 *
 * 关注面：
 * - 精确命中（第 1 级）：走既有逐字节不变路径，结果不含 matchLevel（与既有用例一致）。
 * - 各级降级命中（2-8 级）：命中后替换唯一匹配切片、四周字节原样保留，结果附 matchLevel。
 * - 全不命中：edit-no-match（与既有用例一致）。
 * - 降级级歧义（quote_normalized 多点）：replace_all=false → edit-ambiguous；=true → 取首处替换。
 *
 * 既有 edit 成功路径（toolset.test.ts）零改动前提下，本文件仅新增覆盖，不改既有用例。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { buildDefaultToolset, type SpawnImpl } from "./toolset";
import type { ToolBinding } from "./headless";
import type { MatchLevel } from "../tool/edit-matchers";

async function makeWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "bi-staircase-"));
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const SIGNAL = new AbortController().signal;

/** 爆破替身：被调用即失败（零实弹保险丝）。 */
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

/** 写文件并取 edit 绑定；返回执行后的解析结果。 */
async function edit(
	root: string,
	args: Record<string, unknown>,
): Promise<{ ok: boolean; matches?: number; matchLevel?: MatchLevel; path?: string }> {
	const editTool = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
	const raw = (await editTool.execute(args, SIGNAL)) as string;
	return JSON.parse(raw);
}

describe("BI-07.1 · 精确命中（第 1 级）行为逐字节不变", () => {
	test("精确单点：matches=1、结果不含 matchLevel、文件字节与既有 split/join 一致", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "hello world\n", "utf8");
			const res = await edit(root, { path: "doc.txt", old_string: "world", new_string: "there" });
			expect(res).toMatchObject({ ok: true, matches: 1 });
			// 精确路径结果形状与既有用例一致（无 matchLevel 备注）。
			expect(res).not.toHaveProperty("matchLevel");
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("hello there\n");
		} finally {
			await cleanup();
		}
	});

	test("精确 + 字面 $& 语义（split/join 不走 $ 展开）：回归确认", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "abc", "utf8");
			await edit(root, { path: "doc.txt", old_string: "a", new_string: "$&" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("$&bc");
		} finally {
			await cleanup();
		}
	});
});

describe("BI-07.1 · 阶梯降级命中（各级附 matchLevel）", () => {
	test("第 2 级 quote_normalized：弯引号 ↔ 直引号归一命中", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), 'say "hi" to me\n', "utf8");
			// 模型给出弯引号版本（与文件直引号不同，精确不中）。
			const res = await edit(root, { path: "doc.txt", old_string: "say “hi” to me", new_string: "greet" });
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "quote_normalized" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("greet\n");
		} finally {
			await cleanup();
		}
	});

	test("第 3 级 line_number_stripped：剥离行号前缀 `N:` 命中", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "const x = 1\n", "utf8");
			const res = await edit(root, { path: "doc.txt", old_string: "1: const x = 1", new_string: "const y = 2" });
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "line_number_stripped" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("const y = 2\n");
		} finally {
			await cleanup();
		}
	});

	test("第 4 级 whitespace_normalized：制表符→4空格 + 剥行尾空白命中", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "foo\tbar \n", "utf8"); // 制表符 + 行尾空格
			const res = await edit(root, { path: "doc.txt", old_string: "foo    bar", new_string: "baz" });
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "whitespace_normalized" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("baz\n");
		} finally {
			await cleanup();
		}
	});

	test("第 5 级 indentation_flexible：块绝对缩进漂移、相对结构保留命中", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "    function f() {\n        return 1;\n    }\n", "utf8");
			// 模型给出 0 缩进版本：相对缩进（内层比外层多 4 空格）保持一致，仅绝对缩进漂移；
			// 1-4 级均不中，第 6 级（纯 trim）虽也能中但排在 5 之后，故 5 优先命中。
			const res = await edit(root, {
				path: "doc.txt",
				old_string: "function f() {\n    return 1;\n}",
				new_string: "function g() {\n    return 2;\n}",
			});
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "indentation_flexible" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("function g() {\n    return 2;\n}\n");
		} finally {
			await cleanup();
		}
	});

	test("第 6 级 line_trimmed：行内缩进 + 行尾空白（相对缩进漂移）命中", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "  a\n    b\n", "utf8"); // 相对缩进差 2
			const res = await edit(root, { path: "doc.txt", old_string: "a\nb", new_string: "c\nd" });
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "line_trimmed" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("c\nd\n");
		} finally {
			await cleanup();
		}
	});

	test("第 7 级 block_anchor：首尾锚行精确、中段模糊（≥0.8）命中", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(
				join(root, "doc.txt"),
				"function compute() {\n  const total = price * qty;\n  return total;\n}\n",
				"utf8",
			);
			// 中段被改写一处（sum ↔ total），首尾锚行不变；1-6 级均不中。
			const res = await edit(root, {
				path: "doc.txt",
				old_string: "function compute() {\n  const sum = price * qty;\n  return total;\n}",
				new_string: "function compute() {\n  const amount = price * qty;\n  return amount;\n}",
			});
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "block_anchor" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe(
				"function compute() {\n  const amount = price * qty;\n  return amount;\n}\n",
			);
		} finally {
			await cleanup();
		}
	});

	test("第 8 级 context_fallback：唯一上下文锚行 ±2 重锚命中", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(
				join(root, "doc.txt"),
				"alpha\nbeta\nUNIQUE_CTX_LINE\ngamma\ndelta\n",
				"utf8",
			);
			// 上下文中无整块行匹配（before/after 不在文件），首尾锚（before/after）亦不在文件，
			// 唯 UNIQUE_CTX_LINE 在文件中恰好出现一次 → 第 8 级兜底。
			const res = await edit(root, {
				path: "doc.txt",
				old_string: "before\nUNIQUE_CTX_LINE\nafter",
				new_string: "REPLACED",
			});
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "context_fallback" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toContain("REPLACED");
		} finally {
			await cleanup();
		}
	});
});

describe("BI-07.1 · 全不命中 + 降级歧义", () => {
	test("8 级全败：edit-no-match（与既有用例一致）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), "abc", "utf8");
			const editTool = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			try {
				await editTool.execute({ path: "doc.txt", old_string: "zzz", new_string: "y" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("edit-no-match: matches=0");
			}
		} finally {
			await cleanup();
		}
	});

	test("降级级歧义（quote_normalized 多点）：replace_all=false → edit-ambiguous", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), 'a "x" b "x" c', "utf8");
			const editTool = byName(buildDefaultToolset(root, { spawnImpl: explodingSpawn() }), "edit");
			try {
				// 弯引号归一后 "x" 出现两处 → 歧义。
				await editTool.execute({ path: "doc.txt", old_string: "“x”", new_string: "y" }, SIGNAL);
				expect.unreachable();
			} catch (e) {
				expect((e as Error).message).toBe("edit-ambiguous: matches=2 (set replace_all=true)");
			}
		} finally {
			await cleanup();
		}
	});

	test("降级级歧义 + replace_all=true：取第一处单点替换（matchLevel=quote_normalized）", async () => {
		const { root, cleanup } = await makeWorkspace();
		try {
			await writeFile(join(root, "doc.txt"), 'a "x" b "x" c', "utf8");
			const res = await edit(root, { path: "doc.txt", old_string: "“x”", new_string: "y", replace_all: true });
			expect(res).toMatchObject({ ok: true, matches: 1, matchLevel: "quote_normalized" });
			expect(await readFile(join(root, "doc.txt"), "utf8")).toBe('a y b "x" c');
		} finally {
			await cleanup();
		}
	});
});
