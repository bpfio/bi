/**
 * FX-A / F-ST-03 —— Read-Before-Write 门禁装配验收（binding 级）。
 *
 * 验证 buildDefaultToolset 把 ReadFileStateMap 接到 read_file / write / edit：
 * - 未读直写已存在文件 → 拒（not-read）；
 * - read_file 后写 → 过；
 * - read 后外部改动（mtime 变）→ 拒（externally-modified）；
 * - 新文件直写 → 过；
 * - edit 同理（自身读内容不算认知）。
 *
 * 全部用真实临时目录（mkdtemp），零 mock；fs 由工具绑定真实落盘。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDefaultToolset } from "./toolset";

/** bun:test 默认 AbortSignal 占位（execute 第二参）。 */
const SIGNAL = new AbortController().signal;

/** 取工具集中指定名的绑定 execute。 */
function byName(
	tools: ReturnType<typeof buildDefaultToolset>,
	name: string,
): (args: unknown) => unknown | Promise<unknown> {
	const tool = tools.find((t) => t.definition.name === name);
	if (tool === undefined) throw new Error(`tool not found: ${name}`);
	return (args) => tool.execute(args, SIGNAL);
}

describe("FX-A · Read-Before-Write 门禁（write 直写已存在文件）", () => {
	let root: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "bi-writegate-"));
		cleanup = async () => {
			await rm(root, { recursive: true, force: true });
		};
	});
	afterEach(async () => {
		await cleanup();
	});

	test("① 未读直写已存在文件 → 拒 not-read（铁律）", async () => {
		await writeFile(join(root, "doc.txt"), "原始内容\n", "utf8");
		const write = byName(buildDefaultToolset(root), "write");
		let thrown = "";
		try {
			await write({ path: "doc.txt", content: "覆盖" });
			expect.unreachable();
		} catch (e) {
			thrown = (e as Error).message;
		}
		expect(thrown).toContain("not-read");
		// 文件未被覆盖（守门在写之前）。
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("原始内容\n");
	});

	test("② read_file 后 write → 过（基线一致放行）", async () => {
		await writeFile(join(root, "doc.txt"), "原始内容\n", "utf8");
		const tools = buildDefaultToolset(root);
		const read = byName(tools, "read_file");
		const write = byName(tools, "write");
		await read({ path: "doc.txt" });
		const raw = (await write({ path: "doc.txt", content: "新内容\n" })) as string;
		expect(JSON.parse(raw)).toMatchObject({ ok: true });
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("新内容\n");
	});

	test("③ read 后外部改动（mtime 变）→ 拒 externally-modified（强制重读）", async () => {
		await writeFile(join(root, "doc.txt"), "原始内容\n", "utf8");
		const tools = buildDefaultToolset(root);
		const read = byName(tools, "read_file");
		const write = byName(tools, "write");
		await read({ path: "doc.txt" });
		// 模拟外部进程改动文件（改变内容 → mtime/size 漂移）。
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(join(root, "doc.txt"), "被外部改过了\n", "utf8");
		let thrown = "";
		try {
			await write({ path: "doc.txt", content: "想覆盖" });
			expect.unreachable();
		} catch (e) {
			thrown = (e as Error).message;
		}
		expect(thrown).toContain("externally-modified");
		// 守门拦截，磁盘仍是外部改后的内容。
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("被外部改过了\n");
	});

	test("④ 新文件直写 → 过（无基线也放行）", async () => {
		await mkdir(join(root, "sub"), { recursive: true });
		const write = byName(buildDefaultToolset(root), "write");
		const raw = (await write({ path: "sub/new.txt", content: "全新文件" })) as string;
		expect(JSON.parse(raw)).toMatchObject({ ok: true });
		expect(await readFile(join(root, "sub/new.txt"), "utf8")).toBe("全新文件");
	});

	test("⑤ 自写后再次写（noteEdited 刷新基线）→ 过（写者自知）", async () => {
		await writeFile(join(root, "doc.txt"), "初始\n", "utf8");
		const tools = buildDefaultToolset(root);
		const read = byName(tools, "read_file");
		const write = byName(tools, "write");
		await read({ path: "doc.txt" });
		await write({ path: "doc.txt", content: "第一次写\n" });
		// 同一次会话：noteEdited 已刷新基线，二次直写不再需重读。
		const raw = (await write({ path: "doc.txt", content: "第二次写\n" })) as string;
		expect(JSON.parse(raw)).toMatchObject({ ok: true });
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("第二次写\n");
	});
});

describe("FX-A · Read-Before-Write 门禁（edit 同理）", () => {
	let root: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "bi-editgate-"));
		cleanup = async () => {
			await rm(root, { recursive: true, force: true });
		};
	});
	afterEach(async () => {
		await cleanup();
	});

	test("① 未读直 edit 已存在文件 → 拒 not-read", async () => {
		await writeFile(join(root, "doc.txt"), "hello world\n", "utf8");
		const edit = byName(buildDefaultToolset(root), "edit");
		let thrown = "";
		try {
			await edit({ path: "doc.txt", old_string: "world", new_string: "there" });
			expect.unreachable();
		} catch (e) {
			thrown = (e as Error).message;
		}
		expect(thrown).toContain("not-read");
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("hello world\n");
	});

	test("② read_file 后 edit → 过", async () => {
		await writeFile(join(root, "doc.txt"), "hello world\n", "utf8");
		const tools = buildDefaultToolset(root);
		const read = byName(tools, "read_file");
		const edit = byName(tools, "edit");
		await read({ path: "doc.txt" });
		const raw = (await edit({ path: "doc.txt", old_string: "world", new_string: "there" })) as string;
		expect(JSON.parse(raw)).toMatchObject({ ok: true, matches: 1 });
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("hello there\n");
	});

	test("③ read 后外部改动（mtime 变）→ 拒 externally-modified", async () => {
		await writeFile(join(root, "doc.txt"), "hello world\n", "utf8");
		const tools = buildDefaultToolset(root);
		const read = byName(tools, "read_file");
		const edit = byName(tools, "edit");
		await read({ path: "doc.txt" });
		await new Promise((r) => setTimeout(r, 20));
		await writeFile(join(root, "doc.txt"), "hello moon\n", "utf8");
		let thrown = "";
		try {
			await edit({ path: "doc.txt", old_string: "world", new_string: "there" });
			expect.unreachable();
		} catch (e) {
			thrown = (e as Error).message;
		}
		expect(thrown).toContain("externally-modified");
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("hello moon\n");
	});

	test("④ 自 edit 后再次 edit（noteEdited 刷新基线）→ 过", async () => {
		await writeFile(join(root, "doc.txt"), "aa\n", "utf8");
		const tools = buildDefaultToolset(root);
		const read = byName(tools, "read_file");
		const edit = byName(tools, "edit");
		await read({ path: "doc.txt" });
		await edit({ path: "doc.txt", old_string: "aa", new_string: "bb" });
		const raw = (await edit({ path: "doc.txt", old_string: "bb", new_string: "cc" })) as string;
		expect(JSON.parse(raw)).toMatchObject({ ok: true, matches: 1 });
		expect(await readFile(join(root, "doc.txt"), "utf8")).toBe("cc\n");
	});

	test("⑤ edit 不存在文件 → file-not-found（守门之前的结构化错，不变）", async () => {
		const edit = byName(buildDefaultToolset(root), "edit");
		let thrown = "";
		try {
			await edit({ path: "ghost.txt", old_string: "a", new_string: "b" });
			expect.unreachable();
		} catch (e) {
			thrown = (e as Error).message;
		}
		expect(thrown).toBe("file-not-found");
	});
});
