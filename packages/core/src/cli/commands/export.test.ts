/**
 * BI-20.2 · `export` 子命令测试。
 *
 * 覆盖：markdown 渲染（分节标题/正文/工具调用折叠单行/args 摘要截断/空会话）
 * 与 json 直出（round-trip 一致）双格式快照；out 落盘（含嵌套目录自动创建）；
 * 错误结构化（session-missing / session-corrupt / invalid-format）；残缺尾部容忍。
 * 全部用例注入临时会话目录，绝不触碰 ~/.bi。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../session/manager";
import type { AppendEntryInput } from "../../session/types";
import { ExportError, exportSession } from "./export";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const FIXED_NOW = () => 1700000000000;

function makeIdGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
}

async function tmpManager(): Promise<SessionManager> {
  const root = await mkdtemp(join(tmpdir(), "bi-export-"));
  dirs.push(root);
  return new SessionManager({
    rootDir: join(root, "sessions"),
    now: FIXED_NOW,
    generateId: makeIdGen(),
  });
}

interface Step extends AppendEntryInput {
  id?: string;
}

/** 顺序追加 entries 形成线性链，返回 manager 与会话 id。 */
async function setup(steps: Step[]): Promise<{ mgr: SessionManager; sessionId: string }> {
  const mgr = await tmpManager();
  const meta = await mgr.createSession({ sessionId: "s-main", title: "导出演练", cwd: "/w" });
  let parent: string | null = null;
  for (const step of steps) {
    const entry = await mgr.append(meta.sessionId, parent, step);
    parent = entry.id;
  }
  return { mgr, sessionId: meta.sessionId };
}

const USER_ASSISTANT: Step[] = [
  { type: "user", payload: { text: "问1" } },
  { type: "assistant", payload: { text: "答1" } },
];

const WITH_TOOLS: Step[] = [
  { type: "user", payload: { text: "读一下 a.md" } },
  { type: "tool_call", payload: { args: { path: "a.md" } }, toolName: "read_file", toolCallId: "t1" },
  { type: "tool_result", payload: { text: "文件内容" }, toolName: "read_file", toolCallId: "t1" },
  { type: "assistant", payload: { text: "答1" } },
];

async function errorCode(promise: Promise<unknown>): Promise<ExportError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ExportError) return error;
    throw error;
  }
  throw new Error("预期导出失败，但成功了");
}

describe("BI-20.2 export：markdown 渲染", () => {
  test("缺省格式 markdown：标题 + user/assistant 分节标题 + 正文 + 元信息", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    const { content } = await exportSession(mgr, sessionId);
    expect(content).toContain("# 导出演练");
    expect(content).toContain("- 会话: s-main");
    expect(content).toContain("- 创建: 2023-11-14T22:13:20.000Z");
    expect(content).toContain("- 工作目录: /w");
    expect(content).toContain("## [user] #1");
    expect(content).toContain("问1");
    expect(content).toContain("## [assistant] #2");
    expect(content).toContain("答1");
  });

  test("工具调用折叠为单行 `> tool: name(args 摘要)`，tool_result 走正文", async () => {
    const { mgr, sessionId } = await setup(WITH_TOOLS);
    const { content } = await exportSession(mgr, sessionId);
    expect(content).toContain("## [tool_call] read_file #2");
    const lines = content.split("\n");
    const folded = lines.find((l) => l.startsWith("> tool:"));
    expect(folded).toBe('> tool: read_file({"path":"a.md"})');
    expect(content).toContain("## [tool_result] read_file #3");
    expect(content).toContain("文件内容");
  });

  test("args 摘要超长截断并以 … 结尾", async () => {
    const long = "x".repeat(300);
    const { mgr, sessionId } = await setup([
      { type: "tool_call", payload: { args: { blob: long } }, toolName: "note" },
    ]);
    const { content } = await exportSession(mgr, sessionId);
    const folded = content.split("\n").find((l) => l.startsWith("> tool:"));
    expect(folded).toBeDefined();
    const jsonPart = folded!.slice("> tool: note(".length, -1);
    expect(jsonPart.length).toBe(121); // 120 截断 + 1 个 …
    expect(jsonPart.endsWith("…")).toBe(true);
  });

  test("快照：user/assistant/tool 混合会话渲染稳定", async () => {
    const { mgr, sessionId } = await setup(WITH_TOOLS);
    const { content } = await exportSession(mgr, sessionId);
    expect(content).toMatchSnapshot();
  });

  test("空会话（仅 meta）：渲染（空会话：无条目）", async () => {
    const { mgr, sessionId } = await setup([]);
    const { content } = await exportSession(mgr, sessionId);
    expect(content).toContain("（空会话：无条目）");
  });

  test("forkedFrom 元信息进 markdown 头部（对 fork 出的会话导出）", async () => {
    const { mgr, sessionId } = await setup([{ type: "user", payload: { text: "问1" } }]);
    const rootId = (await mgr.entries(sessionId))[0]!.id;
    const forkResult = await mgr.fork(sessionId, rootId);
    const { content } = await exportSession(mgr, forkResult.sessionId);
    expect(content).toContain(`- 分叉自: ${sessionId}`);
    expect(content).toContain("# 导出演练 (fork)");
  });
});

describe("BI-20.2 export：json 直出", () => {
  test("json 为 { meta, entries }，round-trip 与引擎读取一致", async () => {
    const { mgr, sessionId } = await setup(WITH_TOOLS);
    const { content } = await exportSession(mgr, sessionId, { format: "json" });
    const parsed = JSON.parse(content) as {
      meta: unknown;
      entries: unknown;
    };
    expect(parsed.meta).toEqual({
      sessionId: "s-main",
      title: "导出演练",
      createdAt: 1700000000000,
      cwd: "/w",
    });
    expect(parsed.entries).toEqual(await mgr.entries(sessionId));
  });

  test("快照：json 直出结构稳定", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    const { content } = await exportSession(mgr, sessionId, { format: "json" });
    expect(content).toMatchSnapshot();
  });

  test("out 指定时 json 同样落盘且以换行结尾", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    const root = mgr.rootDir;
    const out = join(root, "..", "out-nested", "export.json");
    const { writtenTo } = await exportSession(mgr, sessionId, { format: "json", out });
    expect(writtenTo).toBeDefined();
    const written = await readFile(out, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written)).toHaveProperty("entries");
  });
});

describe("BI-20.2 export：out 落盘", () => {
  test("out 写盘：嵌套目录自动创建，文件内容与 content 一致", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    const root = mgr.rootDir;
    const out = join(root, "..", "deep", "nested", "export.md");
    const { content, writtenTo } = await exportSession(mgr, sessionId, { out });
    expect(writtenTo).toBe(out);
    const written = await readFile(out, "utf8");
    expect(written).toBe(content);
    expect(written).toContain("# 导出演练");
  });
});

describe("BI-20.3 export：html 分支", () => {
  test("format html：合法导出含 DOCTYPE/标题/details/输入-输出结构", async () => {
    const { mgr, sessionId } = await setup(WITH_TOOLS);
    const { content } = await exportSession(mgr, sessionId, { format: "html" });
    expect(content.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(content).toContain("<title>导出演练</title>");
    expect(content).toContain("<details>");
    expect(content).toContain('<div class="io-label">输入</div>');
    expect(content).toContain('<div class="io-label">输出</div>');
    expect(content).toContain("<pre><code>");
  });

  test("html 导出含 <script> 内容必须已转义", async () => {
    const { mgr, sessionId } = await setup([
      { type: "user", payload: { text: '<script>alert(1)</script>' } },
    ]);
    const { content } = await exportSession(mgr, sessionId, { format: "html" });
    expect(content).toContain("&lt;script&gt;");
    expect(content).not.toContain("<script>alert");
  });

  test("html 与 markdown/json 同为合法格式（白名单终态）", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    expect((await exportSession(mgr, sessionId, { format: "html" })).content).toContain("<!DOCTYPE html>");
    expect((await exportSession(mgr, sessionId)).content).toContain("# 导出演练");
    expect((await exportSession(mgr, sessionId, { format: "json" })).content).toContain('"entries"');
  });

  test("非法 format 仍抛 invalid-format（xml 等非白名单值）", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    const error = await errorCode(exportSession(mgr, sessionId, { format: "xml" as "markdown" }));
    expect(error.code).toBe("invalid-format");
  });

  test("html 同样支持 out 落盘（路径语义对齐 markdown 分支）", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    const root = mgr.rootDir;
    const out = join(root, "..", "html-out", "export.html");
    const { content, writtenTo } = await exportSession(mgr, sessionId, { format: "html", out });
    expect(writtenTo).toBe(out);
    const written = await readFile(out, "utf8");
    expect(written).toBe(content);
    expect(written.startsWith("<!DOCTYPE html>")).toBe(true);
  });
});

describe("BI-20.2 export：错误结构化", () => {
  test("会话不存在 → session-missing", async () => {
    const mgr = await tmpManager();
    const error = await errorCode(exportSession(mgr, "no-such"));
    expect(error.code).toBe("session-missing");
  });

  test("meta 行残缺 → session-corrupt", async () => {
    const mgr = await tmpManager();
    await mkdir(mgr.rootDir, { recursive: true });
    await writeFile(join(mgr.rootDir, "s-bad.jsonl"), "不是 json\n", "utf8");
    const error = await errorCode(exportSession(mgr, "s-bad"));
    expect(error.code).toBe("session-corrupt");
  });

  test("非法 format → invalid-format", async () => {
    const { mgr, sessionId } = await setup(USER_ASSISTANT);
    const error = await errorCode(exportSession(mgr, sessionId, { format: "xml" as "markdown" }));
    expect(error.code).toBe("invalid-format");
  });
});

describe("BI-20.2 export：残缺尾部容忍", () => {
  test("末尾残缺行被丢弃：只导出干净条目", async () => {
    const { mgr, sessionId } = await setup([{ type: "user", payload: { text: "问1" } }]);
    await appendFile(join(mgr.rootDir, `${sessionId}.jsonl`), '{"kind":"entry","entry":{"id":"x"', "utf8");
    const { content } = await exportSession(mgr, sessionId);
    expect(content).toContain("问1");
    expect(content).not.toContain('"id":"x"');
    const parsed = JSON.parse((await exportSession(mgr, sessionId, { format: "json" })).content);
    expect(parsed.entries).toHaveLength(1);
  });
});
