/**
 * BI-03.7 会话语料检索引擎 测试。
 *
 * 覆盖面（工单要求 ≥18 用例，tmp sqlite）：
 *  - 过滤语法矩阵（type=/tool=/contains:/after:）与非法语法结构化错误；
 *  - and/or 组合与优先级；
 *  - 分页无重无漏（500 条游标）；
 *  - ingest 流式/容错与 rebuildIndex 幂等重建；
 *  - 中文 contains；空语料。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilterSyntaxError, compileFilter } from "./filter-compiler";
import type { CorpusEntry } from "./sqlite-corpus";
import { SessionQueryEngine } from "./query-engine";

let dir: string | undefined;

afterEach(async () => {
  if (engine) {
    engine.close();
    engine = undefined;
  }
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

let engine: SessionQueryEngine | undefined;

async function makeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "bi-query-"));
  return dir;
}

function makeEngine(d: string): SessionQueryEngine {
  engine = new SessionQueryEngine({ dbPath: join(d, "corpus.db") });
  return engine;
}

const ISO = (ms: number): string => new Date(ms).toISOString();
const BASE = Date.parse("2026-01-01T00:00:00.000Z");

function entry(overrides: Partial<CorpusEntry>): CorpusEntry {
  return {
    id: 1,
    sessionId: "s1",
    type: "user",
    tool: null,
    text: "hello",
    ts: ISO(BASE),
    ...overrides,
  };
}

/* --------------------------------- 过滤语法矩阵 --------------------------------- */

describe("compileFilter 过滤语法", () => {
  test("type=user 精确匹配条目类型", () => {
    const pred = compileFilter("type=user");
    expect(pred(entry({ type: "user" }))).toBe(true);
    expect(pred(entry({ type: "assistant" }))).toBe(false);
  });

  test("tool=bash 匹配工具名；tool 为 null 的条目不匹配", () => {
    const pred = compileFilter("tool=bash");
    expect(pred(entry({ tool: "bash" }))).toBe(true);
    expect(pred(entry({ tool: null }))).toBe(false);
    expect(pred(entry({ tool: "bashx" }))).toBe(false);
  });

  test("contains: 子串匹配（含中文）", () => {
    const pred = compileFilter("contains:时光倒流");
    expect(pred(entry({ text: "会话时光倒流引擎" }))).toBe(true);
    expect(pred(entry({ text: "无关内容" }))).toBe(false);
  });

  test("after: ISO 边界为严格大于", () => {
    const pred = compileFilter("after:2026-01-01T00:00:00.000Z");
    expect(pred(entry({ ts: "2026-01-01T00:00:00.000Z" }))).toBe(false);
    expect(pred(entry({ ts: "2026-01-01T00:00:00.001Z" }))).toBe(true);
    expect(pred(entry({ ts: "2025-12-31T23:59:59.999Z" }))).toBe(false);
  });

  test("and 组合：两原子同时成立", () => {
    const pred = compileFilter("type=tool_call and tool=bash");
    expect(pred(entry({ type: "tool_call", tool: "bash" }))).toBe(true);
    expect(pred(entry({ type: "user", tool: "bash" }))).toBe(false);
    expect(pred(entry({ type: "tool_call", tool: "read" }))).toBe(false);
  });

  test("or 组合：任一原子成立", () => {
    const pred = compileFilter("type=user or type=system");
    expect(pred(entry({ type: "user" }))).toBe(true);
    expect(pred(entry({ type: "system" }))).toBe(true);
    expect(pred(entry({ type: "assistant" }))).toBe(false);
  });

  test("优先级：and 高于 or（a or b and c ≡ a or (b and c)）", () => {
    const pred = compileFilter("type=user or type=tool_call and tool=bash");
    expect(pred(entry({ type: "user", tool: null }))).toBe(true);
    // 若误为 (a or b) and c，此条会因 tool!=bash 而为 false。
    expect(pred(entry({ type: "tool_call", tool: "bash" }))).toBe(true);
    expect(pred(entry({ type: "tool_call", tool: "read" }))).toBe(false);
    expect(pred(entry({ type: "assistant", tool: "bash" }))).toBe(false);
  });

  test("contains 文本可含空格（原子边界只切裸 and/or）", () => {
    const pred = compileFilter("contains:时光 倒流");
    expect(pred(entry({ text: "会话时光 倒流引擎" }))).toBe(true);
    expect(pred(entry({ text: "时光倒流" }))).toBe(false);
  });

  test("contains 词内 and/or 不误切（android / oracles）", () => {
    const pred = compileFilter("contains:android and contains:oracles");
    expect(pred(entry({ text: "android 手机跑 oracles 测试" }))).toBe(true);
    expect(pred(entry({ text: "android 手机" }))).toBe(false);
  });
});

describe("compileFilter 非法语法（结构化错误）", () => {
  test("空表达式 / 纯空白 → empty-expr", () => {
    for (const expr of ["", "   "]) {
      try {
        compileFilter(expr);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(FilterSyntaxError);
        expect((error as FilterSyntaxError).code).toBe("empty-expr");
      }
    }
  });

  test("裸 and 开头 / 结尾 / 相邻连接词 → dangling-operator", () => {
    for (const expr of ["and type=user", "type=user and", "type=user and or tool=bash"]) {
      try {
        compileFilter(expr);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(FilterSyntaxError);
        expect((error as FilterSyntaxError).code).toBe("dangling-operator");
      }
    }
  });

  test("相邻原子（缺连接词）→ dangling-operator", () => {
    try {
      compileFilter("type=user tool=bash");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FilterSyntaxError);
      expect((error as FilterSyntaxError).code).toBe("dangling-operator");
    }
  });

  test("未知原子 → unknown-atom", () => {
    try {
      compileFilter("session=abc");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FilterSyntaxError);
      expect((error as FilterSyntaxError).code).toBe("unknown-atom");
    }
  });

  test("取值非法：type= 空值、after: 坏时间 → bad-atom", () => {
    for (const expr of ["type=", "after:昨天下午", "contains:"]) {
      try {
        compileFilter(expr);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(FilterSyntaxError);
        expect((error as FilterSyntaxError).code).toBe("bad-atom");
      }
    }
  });
});

/* --------------------------------- 语料与检索（tmp sqlite） --------------------------------- */

/** 写一个会话 JSONL（meta 首行 + entry 行），返回路径。 */
async function writeSessionJsonl(
  d: string,
  sessionId: string,
  entries: Array<{ type: string; text: string; tool?: string; offsetMs: number }>,
): Promise<string> {
  const path = join(d, `${sessionId}.jsonl`);
  const lines = [JSON.stringify({ kind: "meta", v: 1, sessionId, title: sessionId, createdAt: BASE })];
  entries.forEach((e, i) => {
    lines.push(
      JSON.stringify({
        kind: "entry",
        v: 1,
        entry: {
          id: `${sessionId}-e${i + 1}`,
          parentId: null,
          type: e.type,
          payload: { text: e.text },
          createdAt: BASE + e.offsetMs,
          seq: i + 1,
          ...(e.tool !== undefined ? { toolName: e.tool } : {}),
        },
      }),
    );
  });
  await writeFile(path, lines.join("\n") + "\n", "utf8");
  return path;
}

describe("SqliteCorpus ingest 与 keyset 分页", () => {
  test("ingest：meta 行取 session_id，entry 行投影入库，行数/条数正确", async () => {
    const d = await makeDir();
    const path = await writeSessionJsonl(d, "sess-a", [
      { type: "user", text: "第一问", offsetMs: 1 },
      { type: "assistant", text: "回答", offsetMs: 2 },
    ]);
    const engine = makeEngine(d);
    const report = await engine.corpus.ingest(path);
    expect(report.lines).toBe(3);
    expect(report.inserted).toBe(2);
    expect(engine.corpus.count()).toBe(2);
  });

  test("ingest：残缺行（非 JSON / 半行）跳过不拖垮", async () => {
    const d = await makeDir();
    const path = join(d, "broken.jsonl");
    const lines = [
      JSON.stringify({ kind: "meta", v: 1, sessionId: "sess-b", title: "t", createdAt: BASE }),
      JSON.stringify({
        kind: "entry",
        v: 1,
        entry: { id: "e1", parentId: null, type: "user", payload: { text: "好的" }, createdAt: BASE + 1, seq: 1 },
      }),
      '{"kind":"entry","v":1,"entry":{"id":"e2",', // 掉电半行
      "完全不是JSON",
    ];
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const engine = makeEngine(d);
    const report = await engine.corpus.ingest(path);
    expect(report.lines).toBe(4);
    expect(report.inserted).toBe(1);
  });

  test("分页无重无漏：500 条、pageSize=50，游标走完全集", async () => {
    const d = await makeDir();
    const path = join(d, "big.jsonl");
    const lines = [JSON.stringify({ kind: "meta", v: 1, sessionId: "sess-big", title: "t", createdAt: BASE })];
    for (let i = 0; i < 500; i++) {
      lines.push(
        JSON.stringify({
          kind: "entry",
          v: 1,
          entry: {
            id: `e${i + 1}`,
            parentId: null,
            type: i % 2 === 0 ? "user" : "assistant",
            payload: { text: `条目 ${i + 1}` },
            createdAt: BASE + i + 1,
            seq: i + 1,
          },
        }),
      );
    }
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const engine = makeEngine(d);
    await engine.corpus.ingest(path);
    expect(engine.corpus.count()).toBe(500);

    const seen: number[] = [];
    let cursor: number | null = 0;
    let pages = 0;
    while (cursor !== null) {
      const page = engine.corpus.search(() => true, { cursor, pageSize: 50 });
      pages += 1;
      expect(page.items.length).toBeLessThanOrEqual(50);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    }
    expect(pages).toBe(10);
    expect(seen.length).toBe(500);
    expect(new Set(seen).size).toBe(500); // 无重
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // id 升序无漏
  });

  test("带谓词分页无重无漏：过滤后游标跨页续取", async () => {
    const d = await makeDir();
    const path = join(d, "filtered.jsonl");
    const lines = [JSON.stringify({ kind: "meta", v: 1, sessionId: "sess-f", title: "t", createdAt: BASE })];
    for (let i = 0; i < 500; i++) {
      lines.push(
        JSON.stringify({
          kind: "entry",
          v: 1,
          entry: {
            id: `e${i + 1}`,
            parentId: null,
            type: i % 5 === 0 ? "user" : "assistant", // 100 条 user
            payload: { text: `第 ${i + 1} 条` },
            createdAt: BASE + i + 1,
            seq: i + 1,
          },
        }),
      );
    }
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const engine = makeEngine(d);
    await engine.corpus.ingest(path);

    const seen: CorpusEntry[] = [];
    let cursor: number | null = 0;
    let pages = 0;
    while (cursor !== null) {
      const page = engine.corpus.search((e) => e.type === "user", { cursor, pageSize: 7 });
      pages += 1;
      expect(page.items.every((e) => e.type === "user")).toBe(true);
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen.length).toBe(100); // 无重无漏：恰好 100 条 user
    expect(new Set(seen.map((e) => e.id)).size).toBe(100);
    expect(pages).toBe(15); // 100/7 = 14.3 → 15 页
  });
});

/* --------------------------------- SessionQueryEngine 端到端 --------------------------------- */

describe("SessionQueryEngine", () => {
  test("search：语法 + 语料 + 分页端到端（中文 contains）", async () => {
    const d = await makeDir();
    await writeSessionJsonl(d, "sess-zh", [
      { type: "user", text: "请实现会话时光倒流", offsetMs: 1 },
      { type: "assistant", text: "已生成差分补丁", offsetMs: 2 },
      { type: "tool_call", text: "", tool: "edit", offsetMs: 3 },
      { type: "user", text: "再看看状态矩阵", offsetMs: 4 },
    ]);
    const engine = makeEngine(d);
    await engine.rebuildIndex(d);

    const page1 = engine.search("contains:时光", { pageSize: 1 });
    expect(page1.items.length).toBe(1);
    expect(page1.items[0]?.text).toBe("请实现会话时光倒流");
    // keyset 语义：页满即停；是否扫尽由下一页证明（下一页为空页且 nextCursor=null）。
    expect(page1.nextCursor).toBe(1);

    const collected: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = engine.search("contains:时光", { cursor, pageSize: 1 });
      collected.push(...page.items.map((e) => e.text));
      cursor = page.nextCursor;
    }
    expect(collected).toEqual(["请实现会话时光倒流"]); // 无重无漏（尾随空页已排除）
  });

  test("search：组合表达式端到端（type= and contains:）", async () => {
    const d = await makeDir();
    await writeSessionJsonl(d, "sess-mix", [
      { type: "user", text: "bash 脚本怎么写", offsetMs: 1 },
      { type: "tool_call", text: "", tool: "bash", offsetMs: 2 },
      { type: "assistant", text: "bash 要点如下", offsetMs: 3 },
    ]);
    const engine = makeEngine(d);
    await engine.rebuildIndex(d);
    const result = engine.search("tool=bash and type=tool_call");
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.type).toBe("tool_call");
    expect(engine.search("type=user and contains:bash").items.length).toBe(1);
    expect(engine.search("type=assistant or type=user").items.length).toBe(2);
  });

  test("search：非法表达式 → FilterSyntaxError 透传", async () => {
    const d = await makeDir();
    const engine = makeEngine(d);
    // tool=== 语义上合法（取值 "=="），这里用真正的非法形态验证透传。
    expect(() => engine.search("bogus=1")).toThrow(FilterSyntaxError);
    expect(() => engine.search("")).toThrow(FilterSyntaxError);
    expect(() => engine.search("type=user and")).toThrow(FilterSyntaxError);
  });

  test("rebuildIndex：全量重建幂等（清表重灌，两次结果一致）", async () => {
    const d = await makeDir();
    await writeSessionJsonl(d, "sess-r1", [
      { type: "user", text: "一", offsetMs: 1 },
      { type: "assistant", text: "二", offsetMs: 2 },
    ]);
    await writeSessionJsonl(d, "sess-r2", [{ type: "user", text: "三", offsetMs: 3 }]);
    const engine = makeEngine(d);

    const first = await engine.rebuildIndex(d);
    expect(first).toEqual({ sessions: 2, entries: 3 });
    expect(engine.corpus.count()).toBe(3);

    const second = await engine.rebuildIndex(d);
    expect(second).toEqual({ sessions: 2, entries: 3 });
    expect(engine.corpus.count()).toBe(3);
    expect(engine.search("type=user").items.length).toBe(2);
  });

  test("rebuildIndex：目录不存在 → {0,0}；空语料 search → 空结果且 nextCursor null", async () => {
    const d = await makeDir();
    const engine = makeEngine(d);
    const report = await engine.rebuildIndex(join(d, "no-such-dir"));
    expect(report).toEqual({ sessions: 0, entries: 0 });
    const result = engine.search("type=user");
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  test("ingest 进度回调：批量触发且最终 inserted 一致", async () => {
    const d = await makeDir();
    const path = join(d, "progress.jsonl");
    const lines = [JSON.stringify({ kind: "meta", v: 1, sessionId: "sess-p", title: "t", createdAt: BASE })];
    for (let i = 0; i < 30; i++) {
      lines.push(
        JSON.stringify({
          kind: "entry",
          v: 1,
          entry: { id: `e${i}`, parentId: null, type: "user", payload: { text: `p${i}` }, createdAt: BASE + i, seq: i + 1 },
        }),
      );
    }
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    const engine = makeEngine(d);
    const ticks: number[] = [];
    const report = await engine.corpus.ingest(path, { batchSize: 10, onProgress: (p) => ticks.push(p.inserted) });
    expect(report.inserted).toBe(30);
    expect(ticks).toEqual([10, 20, 30]);
  });

  test("WAL 模式生效：库文件旁出现 -wal/-shm（journal_mode=wal）", async () => {
    const d = await makeDir();
    const engine = makeEngine(d);
    await engine.rebuildIndex(d); // 空目录也建表
    const walExists = await Bun.file(join(d, "corpus.db-wal")).exists();
    expect(walExists).toBe(true);
  });
});
