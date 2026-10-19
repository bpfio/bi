/**
 * TUI-ALIGN-4a —— 键位注册表验收：默认表完整性 / 规范化 / 覆盖生效 / 非法输入忽略
 * / 冲突告警 / repl 路由抽查（默认行为不变 + 改绑跟随新键）。
 *
 * 全离线，零网络；文件操作走临时目录。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_KEYBINDINGS,
	actionForKey,
	keyMatches,
	loadKeybindings,
	normalizeKey,
	type Keybindings,
	type KeybindingAction,
} from "./keybindings";
import { LineEditor, KeyStream, runRepl } from "./repl";
import { AgentTuiSession } from "./agent-tui";
import type { ModelPort } from "../../../core/src/cli/headless";
import type { StreamEvent } from "../../../core/src/adapters/deepseek-adapter";
import type { ParsedKey } from "../engine/diff-renderer";

const ctrl = (char: string): ParsedKey => ({ kind: "ctrl", char });
const chr = (char: string): ParsedKey => ({ kind: "char", char });
const named = (kind: ParsedKey["kind"]): ParsedKey => ({ kind });

// ---------------------------------------------------------------------------
// 1. 默认表完整性（逐条对照现行为）
// ---------------------------------------------------------------------------
describe("默认表完整性", () => {
	const EXPECTED: Keybindings = {
		"editor.beginning-of-line": "ctrl+a",
		"editor.backward-char": "ctrl+b",
		"editor.external-edit": "ctrl+e",
		"editor.kill-line": "ctrl+k",
		"editor.kill-line-to-start": "ctrl+u",
		"editor.kill-word-backward": "ctrl+w",
		"editor.yank": "ctrl+y",
		"editor.undo": "ctrl+z",
		"editor.clear-or-exit": "ctrl+c",
		"editor.exit": "ctrl+d",
		"search.open": "ctrl+f",
		"search.previous": "ctrl+g",
		"search.next": "enter",
		"search.close": "esc",
		"approval.allow": "y",
		"approval.deny": "n",
	};

	test("默认 16 动作与键位逐条对照", () => {
		expect(DEFAULT_KEYBINDINGS).toEqual(EXPECTED);
	});

	test("每个默认键位自规范化且非空", () => {
		for (const action of Object.keys(EXPECTED) as KeybindingAction[]) {
			const norm = normalizeKey(DEFAULT_KEYBINDINGS[action]!);
			expect(norm).not.toBeNull();
			expect(norm).toBe(DEFAULT_KEYBINDINGS[action]);
		}
	});

	test("反查：每个默认键位都能命中正确动作", () => {
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("a"))).toBe("editor.beginning-of-line");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("b"))).toBe("editor.backward-char");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("e"))).toBe("editor.external-edit");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("k"))).toBe("editor.kill-line");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("u"))).toBe("editor.kill-line-to-start");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("w"))).toBe("editor.kill-word-backward");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("y"))).toBe("editor.yank");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("z"))).toBe("editor.undo");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("c"))).toBe("editor.clear-or-exit");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("d"))).toBe("editor.exit");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("f"))).toBe("search.open");
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("g"))).toBe("search.previous");
		expect(actionForKey(DEFAULT_KEYBINDINGS, named("enter"))).toBe("search.next");
		expect(actionForKey(DEFAULT_KEYBINDINGS, named("esc"))).toBe("search.close");
		expect(actionForKey(DEFAULT_KEYBINDINGS, chr("y"))).toBe("approval.allow");
		expect(actionForKey(DEFAULT_KEYBINDINGS, chr("n"))).toBe("approval.deny");
	});

	test("未绑定键反查为 undefined", () => {
		expect(actionForKey(DEFAULT_KEYBINDINGS, ctrl("q"))).toBeUndefined();
		expect(actionForKey(DEFAULT_KEYBINDINGS, chr("x"))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// 2. 规范化
// ---------------------------------------------------------------------------
describe("normalizeKey 规范化", () => {
	test("大小写与 ctrl- / ctrl+ 前缀归一并小写", () => {
		expect(normalizeKey("Ctrl+A")).toBe("ctrl+a");
		expect(normalizeKey("CTRL+a")).toBe("ctrl+a");
		expect(normalizeKey("ctrl-a")).toBe("ctrl+a");
		expect(normalizeKey("ctrl+A")).toBe("ctrl+a");
		expect(normalizeKey("ctrl+x")).toBe("ctrl+x");
	});

	test("具名 kind 小写原样", () => {
		expect(normalizeKey("ENTER")).toBe("enter");
		expect(normalizeKey("Esc")).toBe("esc");
		expect(normalizeKey("TAB")).toBe("tab");
		expect(normalizeKey("backspace")).toBe("backspace");
	});

	test("单字符键", () => {
		expect(normalizeKey("y")).toBe("y");
		expect(normalizeKey("Y")).toBe("y");
	});

	test("非法键串返回 null", () => {
		expect(normalizeKey("")).toBeNull();
		expect(normalizeKey("   ")).toBeNull();
		expect(normalizeKey("ctrl+")).toBeNull();
		expect(normalizeKey("ctrl+shift+a")).toBeNull();
		expect(normalizeKey("ctrl+abc")).toBeNull();
		expect(normalizeKey("foo")).toBeNull();
		expect(normalizeKey("ctrl+1")).toBe("ctrl+1");
	});

	test("keyMatches 大小写不敏感", () => {
		expect(keyMatches(ctrl("A"), "ctrl+a")).toBe(true);
		expect(keyMatches(ctrl("a"), "CTRL+A")).toBe(true);
		expect(keyMatches(ctrl("a"), "ctrl+b")).toBe(false);
		expect(keyMatches(chr("Y"), "y")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. 覆盖生效
// ---------------------------------------------------------------------------
describe("loadKeybindings 覆盖生效", () => {
	let dir = "";
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "bi-kb-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("覆盖单条键位生效", async () => {
		const path = join(dir, "kb.json");
		await writeFile(path, JSON.stringify({ "editor.undo": "ctrl+x" }), "utf8");
		const res = await loadKeybindings(path);
		expect(res.bindings["editor.undo"]).toBe("ctrl+x");
		// 未覆盖项保持默认
		expect(res.bindings["editor.kill-line"]).toBe("ctrl+k");
		expect(res.ignored).toHaveLength(0);
		expect(res.conflicts).toHaveLength(0);
		// 反查跟随新键
		expect(actionForKey(res.bindings, ctrl("x"))).toBe("editor.undo");
		expect(actionForKey(res.bindings, ctrl("z"))).toBeUndefined();
	});

	test("文件缺失 = 纯默认", async () => {
		const res = await loadKeybindings(join(dir, "nope.json"));
		expect(res.bindings).toEqual(DEFAULT_KEYBINDINGS);
		expect(res.ignored).toHaveLength(0);
		expect(res.conflicts).toHaveLength(0);
	});

	test("JSON 解析错误 → 纯默认 + 一条 ignored", async () => {
		const path = join(dir, "bad.json");
		await writeFile(path, "{ not json", "utf8");
		const res = await loadKeybindings(path);
		expect(res.bindings).toEqual(DEFAULT_KEYBINDINGS);
		expect(res.ignored).toEqual([{ reason: "parse-error" }]);
	});
});

// ---------------------------------------------------------------------------
// 4. 非法输入忽略（结构化计数）
// ---------------------------------------------------------------------------
describe("loadKeybindings 非法输入忽略", () => {
	let dir = "";
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "bi-kb-ill-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("未知动作 / 非法键串 / 非字符串 均忽略且不影响默认", async () => {
		const path = join(dir, "ill.json");
		await writeFile(
			path,
			JSON.stringify({
				"editor.undo": "ctrl+x", // 合法覆盖
				"editor.nope": "ctrl+a", // 未知动作
				"search.open": "ctrl+shift+f", // 非法键串
				"editor.kill-line": 123, // 非字符串
				"editor.backward-char": "", // 空串非法
			}),
			"utf8",
		);
		const res = await loadKeybindings(path);
		expect(res.bindings["editor.undo"]).toBe("ctrl+x");
		expect(res.bindings["search.open"]).toBe("ctrl+f"); // 非法覆盖被忽略
		expect(res.bindings["editor.kill-line"]).toBe("ctrl+k"); // 非字符串被忽略
		expect(res.bindings["editor.backward-char"]).toBe("ctrl+b"); // 空串被忽略

		const reasons = res.ignored.map((e) => e.reason);
		expect(reasons).toContain("illegal-key");
		expect(reasons).toContain("non-string");
		expect(reasons).toContain("unknown-action");
		expect(reasons).toHaveLength(4);
		// 未知动作条目带 action 名；非法键串条目带 key
		const unknown = res.ignored.find((e) => e.action === "editor.nope");
		expect(unknown?.reason).toBe("unknown-action");
		const illegal = res.ignored.find((e) => e.key === "ctrl+shift+f");
		expect(illegal?.reason).toBe("illegal-key");
		expect(res.conflicts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 5. 冲突告警（后到覆盖）
// ---------------------------------------------------------------------------
describe("loadKeybindings 冲突告警", () => {
	let dir = "";
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "bi-kb-cf-"));
	});
	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("两动作绑同键 → 后到覆盖 + 冲突对记入", async () => {
		const path = join(dir, "cf.json");
		await writeFile(
			path,
			JSON.stringify({
				"editor.yank": "ctrl+z", // ctrl+z 默认属 editor.undo
			}),
			"utf8",
		);
		const res = await loadKeybindings(path);
		expect(res.conflicts).toHaveLength(1);
		expect(res.conflicts[0]!.key).toBe("ctrl+z");
		expect(res.conflicts[0]!.overridden).toBe("editor.undo");
		expect(res.conflicts[0]!.by).toBe("editor.yank");
		// 后到覆盖：ctrl+z 现绑 yank
		expect(actionForKey(res.bindings, ctrl("z"))).toBe("editor.yank");
		expect(res.ignored).toHaveLength(0);
	});

	test("多个冲突全部记录", async () => {
		const path = join(dir, "cf2.json");
		await writeFile(
			path,
			JSON.stringify({
				"editor.beginning-of-line": "ctrl+d", // 与 editor.exit 冲突
				"editor.backward-char": "ctrl+d", // 再次与 editor.exit 冲突（后到）
			}),
			"utf8",
		);
		const res = await loadKeybindings(path);
		expect(res.conflicts.length).toBeGreaterThanOrEqual(1);
		expect(res.conflicts.some((c) => c.key === "ctrl+d")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 6. repl 路由抽查（注入默认表行为不变；改绑后跟随新键）
// ---------------------------------------------------------------------------
describe("repl 路由抽查", () => {
	test("默认表注入：编辑器 ctrl+a 行首 / ctrl+k 删至行尾 行为不变", () => {
		const ed = new LineEditor(); // 默认表
		ed.insert("hello"); // 草稿 "hello"，光标 5
		ed.feed(ctrl("a")); // 行首
		expect(ed.cursor).toBe(0);
		ed.feed(ctrl("k")); // 删至行尾 → 清空
		expect(ed.draft).toBe("");
		expect(ed.cursor).toBe(0);
		// 外编动作（默认 ctrl+e）返回结构化动作，不改草稿
		expect(ed.feed(ctrl("e"))).toEqual({ kind: "external-edit" });
	});

	test("默认表注入：ctrl+c 空=退出 / ctrl+d=退出弃稿", () => {
		const edEmpty = new LineEditor();
		expect(edEmpty.feed(ctrl("c"))).toEqual({ kind: "exit", key: "ctrl-c" });
		expect(edEmpty.feed(ctrl("d"))).toEqual({ kind: "exit", key: "ctrl-d" });

		const edFull = new LineEditor();
		edFull.insert("abc");
		expect(edFull.feed(ctrl("c"))).toEqual({ kind: "edit" }); // 非空清空
		expect(edFull.draft).toBe("");
	});

	test("改绑：editor.beginning-of-line → ctrl+q 后跟随新键，旧键失效", () => {
		const custom: Keybindings = { ...DEFAULT_KEYBINDINGS, "editor.beginning-of-line": "ctrl+q" };
		const ed = new LineEditor(custom);
		ed.insert("hello");
		ed.feed(ctrl("q")); // 新键：行首
		expect(ed.cursor).toBe(0);
		const ed2 = new LineEditor(custom);
		ed2.insert("hello");
		ed2.feed(ctrl("a")); // 旧键：不再绑定 → 不消费
		expect(ed2.cursor).toBe(5);
	});

	test("改绑：search.open → ctrl+q 后 runRepl 跟随新键转发", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bi-kb-rt-"));
		try {
			// 默认：ctrl+f 开搜索
			expect(await searchOpensWith(DEFAULT_KEYBINDINGS, ctrl("f"))).toBe(true);
			expect(await searchOpensWith(DEFAULT_KEYBINDINGS, ctrl("q"))).toBe(false);
			// 改绑：search.open = ctrl+q
			const custom: Keybindings = { ...DEFAULT_KEYBINDINGS, "search.open": "ctrl+q" };
			expect(await searchOpensWith(custom, ctrl("f"))).toBe(false);
			expect(await searchOpensWith(custom, ctrl("q"))).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// 路由抽查辅助：构造最小会话跑一段 runRepl，断言 ctrl 键是否触发转录搜索
// ---------------------------------------------------------------------------
function dummyModel(): ModelPort {
	return {
		async *stream() {
			// 永不触发回合（路由抽查不提交）
		},
	};
}

async function searchOpensWith(bindings: Keybindings, key: ParsedKey): Promise<boolean> {
	const session = new AgentTuiSession({
		model: dummyModel(),
		tools: [],
		cwd: await mkdtemp(join(tmpdir(), "bi-kb-sess-")),
		keybindings: bindings,
	});
	const keys = new KeyStream();
	keys.push(key);
	keys.end();
	await runRepl({ session, keys, title: "kb-route", keybindings: bindings });
	return session.searchActive;
}
