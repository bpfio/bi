/**
 * BI-20.3 · 会话 → 自含 HTML 导出测试。
 *
 * 覆盖: 关键结构（DOCTYPE/标题/meta/section/details 输入-输出/pre-code）、
 * 默认 Dark 内联 CSS、转义安全（会话内容含 <script> 必须已转义）、
 * ANSI 着色、工具调用与结果配对折叠、空会话骨架、确定性、escapeHtml 单元。
 * 全部用例注入临时会话目录, 绝不触碰 ~/.bi。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session/manager";
import type { AppendEntryInput } from "../session/types";
import { escapeHtml, renderHtml, type ToolHtmlRenderers } from "./html-exporter";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function makeIdGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
}

async function tmpManager(): Promise<SessionManager> {
  const root = await mkdtemp(join(tmpdir(), "bi-html-"));
  dirs.push(root);
  return new SessionManager({ rootDir: join(root, "sessions"), now: () => 1700000000000, generateId: makeIdGen() });
}

interface Step extends AppendEntryInput {
  id?: string;
}

async function setup(steps: Step[]): Promise<{ mgr: SessionManager; meta: Awaited<ReturnType<SessionManager["loadSession"]>>["meta"]; entries: Awaited<ReturnType<SessionManager["loadSession"]>>["entries"] }> {
  const mgr = await tmpManager();
  const created = await mgr.createSession({ sessionId: "s-main", title: "导出演练", cwd: "/w" });
  let parent: string | null = null;
  for (const step of steps) {
    const entry = await mgr.append(created.sessionId, parent, step);
    parent = entry.id;
  }
  const loaded = await mgr.loadSession(created.sessionId);
  return { mgr, meta: loaded.meta, entries: loaded.entries };
}

const WITH_TOOLS: Step[] = [
  { type: "user", payload: { text: "读一下 a.md" } },
  { type: "tool_call", payload: { args: { path: "a.md" } }, toolName: "read_file", toolCallId: "t1" },
  { type: "tool_result", payload: { text: "文件内容" }, toolName: "read_file", toolCallId: "t1" },
  { type: "assistant", payload: { text: "答1" } },
];

describe("BI-20.3 renderHtml —— 关键结构", () => {
  test("骨架: DOCTYPE + html + title + meta(会话/创建/条目)", async () => {
    const { meta, entries } = await setup([{ type: "user", payload: { text: "问1" } }]);
    const html = renderHtml(meta, entries);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="zh">');
    expect(html).toContain("<title>导出演练</title>");
    expect(html).toContain("<h1>导出演练</h1>");
    expect(html).toContain("<dt>会话</dt><dd>s-main</dd>");
    expect(html).toContain("<dt>创建</dt><dd>2023-11-14T22:13:20.000Z</dd>");
    expect(html).toContain("<dt>工作目录</dt><dd>/w</dd>");
    expect(html).toContain("<dt>条目</dt><dd>1</dd>");
    expect(html.endsWith("</html>\n")).toBe(true);
  });

  test("条目分节: user/assistant/tool_call 各自 section；配对的 tool_result 并入 tool_call 卡（不单独成节）", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const html = renderHtml(meta, entries);
    expect(html).toContain('<section class="entry entry-user">');
    expect(html).toContain('<section class="entry entry-assistant">');
    expect(html).toContain('<section class="entry entry-tool_call">');
    // 配对结果被消费进 tool_call 的 <details>（输入/输出）, 不再独立成节
    expect(html).not.toContain('<section class="entry entry-tool_result">');
    expect(html).toContain("文件内容");
  });

  test("工具调用卡为 <details> 折叠, 含『输入』『输出』两区", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const html = renderHtml(meta, entries);
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>tool: read_file(");
    expect(html).toContain('<div class="io-label">输入</div>');
    expect(html).toContain('<div class="io-label">输出</div>');
    // 输入含 args 的 path, 输出含结果文本
    expect(html).toContain("文件内容");
    expect(html).toContain("a.md");
  });

  test("代码与 diff 走 <pre><code> 纯文本（无语法高亮脚本/外链）", async () => {
    const { meta, entries } = await setup([
      { type: "assistant", payload: { text: "```js\nconst x = 1;\n```" } },
    ]);
    const html = renderHtml(meta, entries);
    expect(html).toContain("<pre><code>");
    expect(html).toContain("const x = 1;");
    // 零外链 / 零 CDN / 零图片: 不含 http(s):// 资源引用与 <img
    expect(html).not.toContain("<img");
    expect(html).not.toMatch(/src\s*=\s*["']https?:/);
  });

  test("默认 Dark 主题: 内联 CSS 含暗色背景", async () => {
    const { meta, entries } = await setup([]);
    const html = renderHtml(meta, entries);
    expect(html).toContain("<style>");
    expect(html).toContain("background: #1e1e2e");
    expect(html).toContain("color-scheme: dark");
  });

  test("空会话: 含标题与完整骨架, 无 section", async () => {
    const { meta, entries } = await setup([]);
    const html = renderHtml(meta, entries);
    expect(html.includes("<section")).toBe(false);
    expect(html).toContain("<h1>导出演练</h1>");
    expect(html).toContain("<dt>条目</dt><dd>0</dd>");
  });
});

describe("BI-20.3 renderHtml —— 转义安全", () => {
  test("会话内容含 <script> 必须已转义（不出现原始标签）", async () => {
    const { meta, entries } = await setup([
      { type: "user", payload: { text: '<script>alert("xss")</script>' } },
    ]);
    const html = renderHtml(meta, entries);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    // 断言确实落在 <pre><code> 内的转义文本, 而非被当作元素解析
    expect(html).toContain("<pre><code>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</code></pre>");
  });

  test("标题含 < > & 同样转义", async () => {
    const mgr = await tmpManager();
    const created = await mgr.createSession({ sessionId: "s-x", title: '<b>&"</b>' });
    const loaded = await mgr.loadSession(created.sessionId);
    const html = renderHtml(loaded.meta, loaded.entries);
    expect(html).toContain("<title>&lt;b&gt;&amp;&quot;&lt;/b&gt;</title>");
    expect(html).not.toContain("<title><b>");
  });
});

describe("BI-20.3 renderHtml —— ANSI 与配对", () => {
  test("工具结果含 ANSI 色码 -> 内联 ansi-red span", async () => {
    const { meta, entries } = await setup([
      { type: "tool_call", payload: { args: {} }, toolName: "run", toolCallId: "t2" },
      { type: "tool_result", payload: { text: "\x1b[31m出错\x1b[0m" }, toolName: "run", toolCallId: "t2" },
    ]);
    const html = renderHtml(meta, entries);
    expect(html).toContain('<span class="ansi-red">出错</span>');
  });

  test("孤立 tool_result（无配对 tool_call）以独立 details 渲染, 不丢失", async () => {
    const { meta, entries } = await setup([
      { type: "tool_result", payload: { text: "孤立结果" }, toolName: "grep", toolCallId: "orphan" },
    ]);
    const html = renderHtml(meta, entries);
    expect(html).toContain('<section class="entry entry-tool_result">');
    expect(html).toContain("孤立结果");
    expect(html).toContain("tool result: grep");
  });

  test("确定性: 同输入两次导出逐字节一致", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    expect(renderHtml(meta, entries)).toBe(renderHtml(meta, entries));
  });
});

describe("BI-20.3 escapeHtml 单元", () => {
  test("& < > \" 全覆盖", () => {
    expect(escapeHtml('a&b<c>d"e')).toBe("a&amp;b&lt;c&gt;d&quot;e");
  });
});

describe("BI-20.3 renderHtml —— 双主题", () => {
  test("缺省(dark) 与显式 {theme:'dark'} 逐字节一致（回归保护）", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    expect(renderHtml(meta, entries)).toBe(renderHtml(meta, entries, { theme: "dark" }));
  });

  test("未传 options 与传 {} 仍逐字节一致（向后兼容）", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    expect(renderHtml(meta, entries)).toBe(renderHtml(meta, entries, {}));
  });

  test("light 关键结构: color-scheme:light + 亮色背景, 且不含暗色背景", async () => {
    const { meta, entries } = await setup([]);
    const html = renderHtml(meta, entries, { theme: "light" });
    expect(html).toContain("<style>");
    expect(html).toContain("color-scheme: light");
    expect(html).toContain("background: #eff1f5");
    expect(html).not.toContain("background: #1e1e2e");
    expect(html).not.toContain("color-scheme: dark");
  });

  test("light 同样渲染工具卡（details/输入/输出结构存在）", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const html = renderHtml(meta, entries, { theme: "light" });
    expect(html).toContain("<details>");
    expect(html).toContain('<div class="io-label">输入</div>');
    expect(html).toContain('<div class="io-label">输出</div>');
    expect(html).toContain("文件内容");
  });
});

describe("BI-20.3 renderHtml —— 工具渲染器插件面", () => {
  test("callHtml 命中: 覆盖「输入」区, 直接插入不转义", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const renderers: ToolHtmlRenderers = {
      read_file: { callHtml: (e) => `<div class="custom-call">CALL ${escapeHtml(String(e.toolName))}</div>` },
    };
    const html = renderHtml(meta, entries, { renderers });
    expect(html).toContain('<div class="custom-call">CALL read_file</div>');
    // 默认输入区（转义后的 args JSON）不再出现
    expect(html).not.toContain('<pre><code>{"path":"a.md"}</code></pre>');
  });

  test("resultHtml 命中: 覆盖「输出」区, 直接插入不转义", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const renderers: ToolHtmlRenderers = {
      read_file: { resultHtml: () => '<div class="custom-res">RES</div>' },
    };
    const html = renderHtml(meta, entries, { renderers });
    expect(html).toContain('<div class="custom-res">RES</div>');
    expect(html).not.toContain("<pre><code>文件内容</code></pre>");
  });

  test("不二次转义契约: 插件返回原始 <tag> 直接落地, 不被转义", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const renderers: ToolHtmlRenderers = {
      read_file: { resultHtml: () => "<b>bold-raw</b>" },
    };
    const html = renderHtml(meta, entries, { renderers });
    expect(html).toContain("<b>bold-raw</b>");
    expect(html).not.toContain("&lt;b&gt;bold-raw&lt;/b&gt;");
  });

  test("未命中: 无对应 toolName 时回退默认路径（逐字节等价于无 renderers）", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const renderers: ToolHtmlRenderers = {
      write_file: { callHtml: () => "<div>never</div>" }, // 不匹配 read_file
    };
    const withPlugin = renderHtml(meta, entries, { renderers });
    const without = renderHtml(meta, entries);
    expect(withPlugin).toBe(without);
    expect(withPlugin).not.toContain("never");
  });

  test("部分命中: 仅 callHtml 命中时, 输出区仍走默认转义路径", async () => {
    const { meta, entries } = await setup(WITH_TOOLS);
    const renderers: ToolHtmlRenderers = {
      read_file: { callHtml: () => '<div class="custom-call">C</div>' },
    };
    const html = renderHtml(meta, entries, { renderers });
    expect(html).toContain('<div class="custom-call">C</div>');
    // 输出区回退默认 → 含转义后的文件内容 pre-code
    expect(html).toContain("<pre><code>文件内容</code></pre>");
  });

  test("孤立 tool_result 经 resultHtml 覆盖输出区", async () => {
    const { meta, entries } = await setup([
      { type: "tool_result", payload: { text: "孤立结果" }, toolName: "grep", toolCallId: "orphan" },
    ]);
    const renderers: ToolHtmlRenderers = {
      grep: { resultHtml: () => '<div class="custom-orphan">ORPHAN</div>' },
    };
    const html = renderHtml(meta, entries, { renderers });
    expect(html).toContain('<div class="custom-orphan">ORPHAN</div>');
    expect(html).not.toContain("<pre><code>孤立结果</code></pre>");
  });
});
