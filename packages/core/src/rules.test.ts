/**
 * BI-05 · BI.md 项目长期记忆自适应注入测试（纯内存，零 IO）。
 *
 * 覆盖：向上递归命中/未命中/最近优先、双文件名优先序、stopAt 上界、
 * 二级标题切节（围栏免疫）、注入块确定性（乱序等价 + 逐字节相等）、
 * 8K 截断、Injector 缓存 by path+mtime。
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_PROMPT_SECTION_CHARS,
  RulesInjector,
  buildSystemPromptSection,
  findRuleFile,
  loadRules,
  parseRuleSections,
} from "./rules";
import { makeMemFs } from "./rules/testing-memfs";

describe("BI-05 findRuleFile：向上递归检索", () => {
  test("startDir 本身命中 BI.md", () => {
    const fs = makeMemFs({ files: { "/proj/BI.md": "# BI\n" } });
    expect(findRuleFile("/proj", { fs })).toEqual({ path: "/proj/BI.md", root: "/proj" });
  });

  test("祖先目录命中：向上递归直到项目根", () => {
    const fs = makeMemFs({ files: { "/home/u/proj/BI.md": "# BI\n" } });
    const hit = findRuleFile("/home/u/proj/packages/core/src", { fs });
    expect(hit).toEqual({ path: "/home/u/proj/BI.md", root: "/home/u/proj" });
  });

  test("未命中：一路到根盘返回 null（根盘止步不死循环）", () => {
    const fs = makeMemFs({ files: { "/elsewhere/BI.md": "# BI\n" } });
    expect(findRuleFile("/a/b/c", { fs })).toBeNull();
    expect(findRuleFile("/", { fs })).toBeNull();
  });

  test("最近优先：近处 .bi/rules.md 胜过远处 BI.md", () => {
    const fs = makeMemFs({
      files: {
        "/proj/BI.md": "# far\n",
        "/proj/sub/.bi/rules.md": "# near\n",
      },
    });
    const hit = findRuleFile("/proj/sub/deeper", { fs });
    expect(hit).toEqual({ path: "/proj/sub/.bi/rules.md", root: "/proj/sub" });
  });

  test("双文件名优先序：同目录 BI.md 优先于 .bi/rules.md", () => {
    const fs = makeMemFs({
      files: {
        "/proj/BI.md": "# preferred\n",
        "/proj/.bi/rules.md": "# fallback\n",
      },
    });
    expect(findRuleFile("/proj", { fs })?.path).toBe("/proj/BI.md");
  });

  test("stopAt 上界：上界之上的文件不可见；上界之内（含自身）可命中", () => {
    const fs = makeMemFs({
      files: {
        "/root/BI.md": "# root\n",
        "/root/deep/BI.md": "# deep\n",
      },
    });
    expect(findRuleFile("/root/deeper/dir", { fs, stopAt: "/root/deeper" })).toBeNull();
    // 界内最近优先：/root/deeper 无规则文件，命中 /root/BI.md（而非更远的 /root/deep）
    expect(findRuleFile("/root/deeper/dir", { fs, stopAt: "/root" })).toEqual({
      path: "/root/BI.md",
      root: "/root",
    });
    expect(findRuleFile("/root/deep", { fs, stopAt: "/root/deep" })?.path).toBe("/root/deep/BI.md");
  });
});

describe("BI-05 loadRules / parseRuleSections：二级标题切节", () => {
  test("政策信源/统计口径/禁用词切节：title+body，一级标题与前言忽略", () => {
    const content = [
      "# BI.md",
      "",
      "本文件是项目长期记忆。",
      "",
      "## 政策信源",
      "以官方公告为准。",
      "",
      "## 统计口径",
      "DAU 按去重设备号统计。",
      "### 子口径",
      "子口径并入正文。",
      "",
      "## 禁用词",
      "禁止出现：竞品 A。",
    ].join("\n");
    const sections = parseRuleSections(content);
    expect(sections).toEqual([
      { title: "政策信源", body: "以官方公告为准。" },
      { title: "统计口径", body: "DAU 按去重设备号统计。\n### 子口径\n子口径并入正文。" },
      { title: "禁用词", body: "禁止出现：竞品 A。" },
    ]);
  });

  test("代码围栏内的 ## 行不切节", () => {
    const content = [
      "## 真实节",
      "```bash",
      "## 不是标题，是注释",
      "```",
      "## 第二节",
      "正文",
    ].join("\n");
    const sections = parseRuleSections(content);
    expect(sections.map((s) => s.title)).toEqual(["真实节", "第二节"]);
    expect(sections[0]?.body).toBe("```bash\n## 不是标题，是注释\n```");
  });

  test("loadRules：文件缺失返回空数组（不抛错）", () => {
    const fs = makeMemFs({});
    expect(loadRules("/nope/BI.md", { fs })).toEqual([]);
  });

  test("loadRules：经注入 fs 读取并解析", () => {
    const fs = makeMemFs({ files: { "/p/.bi/rules.md": "## 口径\n正文" } });
    expect(loadRules("/p/.bi/rules.md", { fs })).toEqual([{ title: "口径", body: "正文" }]);
  });
});

describe("BI-05 buildSystemPromptSection：确定性注入块", () => {
  const a = { title: "统计口径", body: "DAU 去重。" };
  const b = { title: "政策信源", body: "以官方公告为准。" };
  const c = { title: "禁用词", body: "禁竞品 A。" };

  test("空节列表返回空串（无空头部噪音）", () => {
    expect(buildSystemPromptSection([])).toBe("");
  });

  test("确定性：相同集合乱序输入，输出逐字节相等且按 title 码点升序", () => {
    const one = buildSystemPromptSection([a, b, c]);
    const two = buildSystemPromptSection([c, b, a]);
    expect(one).toBe(two);
    // 码点升序：政(U+653F) < 禁(U+7981) < 统(U+7EDF)
    expect(one.indexOf("### 政策信源")).toBeLessThan(one.indexOf("### 禁用词"));
    expect(one.indexOf("### 禁用词")).toBeLessThan(one.indexOf("### 统计口径"));
    expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}/); // 无时间戳
  });

  test("同 title 去重：保留首现 body", () => {
    const merged = buildSystemPromptSection([a, { title: "统计口径", body: "另一版本。" }]);
    expect(merged).toContain("DAU 去重。");
    expect(merged).not.toContain("另一版本。");
  });

  test("默认 8K 截断：总长不超 8192 且带截断尾缀", () => {
    const big = { title: "大节", body: "口".repeat(MAX_PROMPT_SECTION_CHARS * 2) };
    const text = buildSystemPromptSection([big]);
    expect(text.length).toBe(MAX_PROMPT_SECTION_CHARS);
    expect(text.endsWith("…（已截断）")).toBe(true);
  });

  test("自定义 maxChars 极小时仍确定性且不超限", () => {
    const text = buildSystemPromptSection([a, b], { maxChars: 10 });
    expect(text.length).toBeLessThanOrEqual(10);
    expect(text).toBe(buildSystemPromptSection([a, b], { maxChars: 10 }));
  });
});

describe("BI-05 RulesInjector：组合与缓存（by path+mtime）", () => {
  test("命中：find+load+build 组合输出；未命中返回 null", () => {
    const hit = makeMemFs({ files: { "/p/BI.md": "## 口径\n正文" } });
    const injector = new RulesInjector({ fs: hit });
    const text = injector.sectionFor("/p/src");
    expect(text).toContain("### 口径");
    expect(text).toContain("正文");

    const miss = makeMemFs({ files: { "/p/README.md": "x" } });
    expect(new RulesInjector({ fs: miss }).sectionFor("/p/src")).toBeNull();
  });

  test("缓存：mtime 不变时不再读盘；mtime 变更后刷新", () => {
    const fs = makeMemFs({ files: { "/p/BI.md": "## 旧节\n旧正文" } });
    const injector = new RulesInjector({ fs });
    const first = injector.sectionFor("/p");
    expect(fs.reads.count).toBe(1);
    expect(injector.sectionFor("/p")).toBe(first);
    expect(fs.reads.count).toBe(1); // 命中缓存，未再读盘

    fs.writeFileSync("/p/BI.md", "## 新节\n新正文");
    const second = injector.sectionFor("/p");
    expect(second).toContain("新正文");
    expect(second).not.toBe(first);
    expect(fs.reads.count).toBe(2);
  });

  test("不同根各自缓存互不串扰", () => {
    const fs = makeMemFs({
      files: {
        "/a/BI.md": "## A节\n内容A",
        "/b/BI.md": "## B节\n内容B",
      },
    });
    const injector = new RulesInjector({ fs });
    expect(injector.sectionFor("/a")).toContain("内容A");
    expect(injector.sectionFor("/b")).toContain("内容B");
    expect(injector.sectionFor("/a")).toContain("内容A");
  });
});
