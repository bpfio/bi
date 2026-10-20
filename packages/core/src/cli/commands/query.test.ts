/**
 * F-ST-07 —— `bi query` 子命令验收（会话语料检索薄壳）。
 *
 * 覆盖：
 * - type=user 过滤：临时会话根造 2 会话 → 命中条目逐行 JSON（sessionId / nodeId / type）；
 * - contains 过滤：只命中含关键词的条目；
 * - 非法表达式：结构化 exit 2（复用 FilterSyntaxError 的 code）；
 * - 无会话：exit 0 空集 + stderr 提示；
 * - --limit 截断。
 * 全部用例走临时会话根 + 临时索引库（索引落 os.tmpdir），绝不触碰 ~/.bi。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../session/manager";
import { handleSubcommand } from "./dispatch";
import { handleQuery } from "./query";

let dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
	dirs = [];
});

/** 收集器：stdout / stderr 分流。 */
function collect(): {
	io: { out: (line: string) => void; err: (line: string) => void };
	outs: string[];
	errs: string[];
} {
	const outs: string[] = [];
	const errs: string[] = [];
	return { io: { out: (l) => outs.push(l), err: (l) => errs.push(l) }, outs, errs };
}

/** 临时会话根 + 造会话（每会话若干条目）。 */
async function makeSessionsRoot(): Promise<{
	root: string;
	ids: string[];
	nodeIds: string[];
}> {
	const root = await mkdtemp(join(tmpdir(), "bi-query-cmd-"));
	dirs.push(root);
	const manager = new SessionManager({ rootDir: root });
	const ids: string[] = [];
	const nodeIds: string[] = [];
	for (let i = 0; i < 2; i++) {
		const meta = await manager.createSession({ title: `会话${i}` });
		ids.push(meta.sessionId);
		const user = await manager.append(meta.sessionId, null, {
			type: "user",
			payload: { text: i === 0 ? "部署脚本怎么修" : "无关提问" },
		});
		nodeIds.push(user.id);
		const assistant = await manager.append(meta.sessionId, user.id, {
			type: "assistant",
			payload: { content: [{ type: "text", text: i === 0 ? "先看日志再修" : "收到" }] },
		});
		nodeIds.push(assistant.id);
	}
	return { root, ids, nodeIds };
}

/** 解析 stdout 的 JSON 行。 */
function parseHits(outs: string[]): Array<Record<string, unknown>> {
	return outs.filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("F-ST-07 query 子命令：过滤与输出", () => {
	test("type=user 过滤：命中逐行 JSON（sessionId / nodeId / type）", async () => {
		const { root, ids, nodeIds } = await makeSessionsRoot();
		const { io, outs, errs } = collect();
		const code = await handleQuery(["type=user"], io, { sessionsRoot: root });
		expect(code).toBe(0);
		const hits = parseHits(outs);
		expect(hits).toHaveLength(2);
		expect(hits.every((h) => h.type === "user")).toBe(true);
		expect(hits.map((h) => h.sessionId).sort()).toEqual([...ids].sort());
		// nodeId 来自会话条目（不伪造）。
		expect(hits.map((h) => h.nodeId).sort()).toEqual([nodeIds[0], nodeIds[2]].sort());
		// 汇总计数走 stderr。
		expect(errs.join("\n")).toContain("命中 2 条");
	});

	test("contains 过滤：只命中含关键词的条目", async () => {
		const { root } = await makeSessionsRoot();
		const { io, outs, errs } = collect();
		const code = await handleQuery(["contains:部署"], io, { sessionsRoot: root });
		expect(code).toBe(0);
		const hits = parseHits(outs);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.summary).toContain("部署");
		expect(errs.join("\n")).toContain("命中 1 条");
	});

	test("摘要字段可读：assistant 条目取 content 文本块正文（非裸 JSON 串）", async () => {
		const { root } = await makeSessionsRoot();
		const { io, outs } = collect();
		const code = await handleQuery(["type=assistant"], io, { sessionsRoot: root });
		expect(code).toBe(0);
		const hits = parseHits(outs);
		expect(hits).toHaveLength(2);
		expect(hits.map((h) => h.summary).sort()).toEqual(["先看日志再修", "收到"].sort());
		expect(hits.every((h) => !String(h.summary).startsWith("{"))).toBe(true);
	});

	test("非法表达式：结构化 exit 2（FilterSyntaxError 的 code）", async () => {
		const { root } = await makeSessionsRoot();
		const { io, outs, errs } = collect();
		const code = await handleQuery(["type=user and"], io, { sessionsRoot: root });
		expect(code).toBe(2);
		expect(outs).toHaveLength(0);
		const text = errs.join("\n");
		expect(text).toContain("表达式非法");
		expect(text).toContain("dangling-operator");
	});

	test("未知过滤原子：结构化 exit 2（unknown-atom）", async () => {
		const { root } = await makeSessionsRoot();
		const { io, errs } = collect();
		const code = await handleQuery(["foo=bar"], io, { sessionsRoot: root });
		expect(code).toBe(2);
		expect(errs.join("\n")).toContain("unknown-atom");
	});

	test("无会话：exit 0 空集 + stderr 提示", async () => {
		const root = await mkdtemp(join(tmpdir(), "bi-query-empty-"));
		dirs.push(root);
		const { io, outs, errs } = collect();
		const code = await handleQuery(["type=user"], io, { sessionsRoot: root });
		expect(code).toBe(0);
		expect(outs).toHaveLength(0);
		expect(errs.join("\n")).toContain("无会话文件");
	});

	test("--limit 截断：命中数不超过上限", async () => {
		const { root } = await makeSessionsRoot();
		const { io, outs, errs } = collect();
		const code = await handleQuery(["type=user", "--limit", "1"], io, { sessionsRoot: root });
		expect(code).toBe(0);
		expect(parseHits(outs)).toHaveLength(1);
		expect(errs.join("\n")).toContain("命中 1 条");
	});

	test("用法错误：缺表达式 / 非法 --limit → exit 2（dispatch 归一 SubUsageError）", async () => {
		const { root } = await makeSessionsRoot();
		const noExpr = collect();
		expect(await handleSubcommand("query", [], noExpr.io, { sessionsRoot: root })).toBe(2);
		expect(noExpr.errs.join("\n")).toContain("用法");
		const badLimit = collect();
		expect(await handleSubcommand("query", ["type=user", "--limit", "x"], badLimit.io, { sessionsRoot: root })).toBe(2);
		const unknownFlag = collect();
		expect(await handleSubcommand("query", ["type=user", "--bogus"], unknownFlag.io, { sessionsRoot: root })).toBe(2);
	});

	test("子命令已注册：bi query --help → exit 0 且含用法关键词", async () => {
		const { io, outs } = collect();
		expect(await handleSubcommand("query", ["--help"], io, {})).toBe(0);
		const text = outs.join("\n");
		expect(text).toContain("--limit");
		expect(text).toContain("type=");
	});
});
