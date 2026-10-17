/**
 * BI-07.9 · 声明式技能注册表与 Skill 工具测试。
 *
 * 覆盖：双目录扫描与 workspace 覆盖、frontmatter 房规解析
 * （name/description/allowed-tools/params 块）、坏技能跳过不拖垮、
 * 普通文件忽略、refresh 重扫、unknown 相似候选、schema 校验矩阵、
 * allowed-tools 声明透传、正文展开确定性。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillRegistry,
  levenshtein,
  parseSkillMarkdown,
  type SkillFsPort,
} from "./skill-executor";
import { SkillTool, expandSkillBody, validateSkillParams } from "./skill-tool";

/* ------------------------------------------------------------------ */
/* memfs 注入                                                           */
/* ------------------------------------------------------------------ */

function memfs(files: Record<string, string>, dirs: string[] = []): SkillFsPort {
  return {
    async readdir(dir) {
      const names = new Set<string>();
      for (const d of dirs) {
        if (d === dir || d.startsWith(`${dir}/`)) {
          const rest = d.slice(dir.length + 1);
          if (rest.length > 0) names.add(rest.split("/")[0]!);
        }
      }
      for (const f of Object.keys(files)) {
        if (f.startsWith(`${dir}/`)) {
          const rest = f.slice(dir.length + 1);
          if (rest.length > 0) names.add(rest.split("/")[0]!);
        }
      }
      if (names.size === 0 && !dirs.includes(dir)) throw new Error(`ENOENT: ${dir}`);
      return [...names];
    },
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    async isDirectory(path) {
      return dirs.includes(path);
    },
  };
}

const USER_DIR = "/home/fake/.bi/skills";
const WS_DIR = "/work/.bi/skills";

function reviewPrMd(overrides: Partial<{ name: string; description: string; allowed: string; params: string; body: string }> = {}): string {
  const { name = "review-pr", description = "评审 PR 变更", allowed = "Read, Grep, Bash", params = "", body = "开始评审 PR。" } = overrides;
  return `---\nname: ${name}\ndescription: ${description}\nallowed-tools: ${allowed}\n${params}---\n${body}`;
}

async function makeRegistry(
  files: Record<string, string>,
  dirs: string[] = [],
): Promise<SkillRegistry> {
  // 含 SKILL.md 的目录自动派生为技能目录（测试书写省心）
  const derived = new Set(dirs);
  for (const path of Object.keys(files)) {
    if (path.endsWith("/SKILL.md")) derived.add(path.slice(0, -"/SKILL.md".length));
  }
  const registry = new SkillRegistry({
    fs: memfs(files, [...derived]),
    userSkillsDir: USER_DIR,
    workspaceSkillsDir: WS_DIR,
  });
  await registry.refresh();
  return registry;
}

/* ------------------------------------------------------------------ */
/* 注册表扫描                                                           */
/* ------------------------------------------------------------------ */

describe("SkillRegistry 注册表扫描", () => {
  test("扫描双目录：user 与 workspace 技能均在册", async () => {
    const reg = await makeRegistry({
      [`${USER_DIR}/review-pr/SKILL.md`]: reviewPrMd(),
      [`${WS_DIR}/executing-plans/SKILL.md`]:
        "---\nname: executing-plans\ndescription: 执行计划\n---\n按计划执行。",
    });
    const names = reg.list().map((s) => s.name);
    expect(names).toEqual(["executing-plans", "review-pr"]);
    expect(reg.get("review-pr")?.source).toBe("user");
    expect(reg.get("executing-plans")?.source).toBe("workspace");
  });

  test("同名技能 workspace 覆盖 user（项目优先）", async () => {
    const reg = await makeRegistry({
      [`${USER_DIR}/review-pr/SKILL.md`]: reviewPrMd({ description: "用户级版本" }),
      [`${WS_DIR}/review-pr/SKILL.md`]: reviewPrMd({ description: "工作区版本" }),
    });
    const skill = reg.get("review-pr")!;
    expect(skill.source).toBe("workspace");
    expect(skill.description).toBe("工作区版本");
    expect(reg.list()).toHaveLength(1);
  });

  test("allowed-tools 逗号表解析（去空格、去空项）", async () => {
    const reg = await makeRegistry({
      [`${USER_DIR}/review-pr/SKILL.md`]: reviewPrMd({ allowed: " Read , , Bash ,, Grep " }),
    });
    expect([...reg.get("review-pr")!.allowedTools]).toEqual(["Read", "Bash", "Grep"]);
  });

  test("params 块解析成 mini schema（type/required/description）", async () => {
    const reg = await makeRegistry({
      [`${USER_DIR}/review-pr/SKILL.md`]: reviewPrMd({
        params:
          "params:\n  pr_number:\n    type: number\n    required: true\n    description: PR 编号\n  title:\n    type: string\n",
      }),
    });
    const schema = reg.get("review-pr")!.paramsSchema;
    expect(schema["pr_number"]).toEqual({
      type: "number",
      required: true,
      description: "PR 编号",
    });
    expect(schema["title"]).toEqual({ type: "string", required: false });
  });

  test("allowed-tools 缺省 → 空数组（无脚本执行资格）", async () => {
    const reg = await makeRegistry(
      { [`${USER_DIR}/review-pr/SKILL.md`]: "---\nname: review-pr\ndescription: d\n---\n正文" },
      [`${USER_DIR}/review-pr`],
    );
    expect([...reg.get("review-pr")!.allowedTools]).toEqual([]);
  });

  test("缺 SKILL.md 的目录 → errors 收集且跳过，不拖垮注册表", async () => {
    const reg = await makeRegistry(
      {
        [`${USER_DIR}/empty/SKILL.md`]: "",
        [`${USER_DIR}/good/SKILL.md`]: "---\nname: good\ndescription: d\n---\n正文",
      },
      [`${USER_DIR}/empty`, `${USER_DIR}/good`, `${WS_DIR}/broken`],
    );
    const names = reg.list().map((s) => s.name);
    expect(names).toEqual(["good"]);
    const errors = reg.loadErrors();
    expect(errors.some((e) => e.dir === `${WS_DIR}/broken` && e.reason === "缺少 SKILL.md")).toBe(
      true,
    );
  });

  test("frontmatter 缺 name / 未闭合 → errors 收集", async () => {
    const reg = await makeRegistry(
      {
        [`${USER_DIR}/noname/SKILL.md`]: "---\ndescription: 没名字\n---\n正文",
        [`${USER_DIR}/unclosed/SKILL.md`]: "---\nname: unclosed\ndescription: 没闭合\n",
        [`${USER_DIR}/good/SKILL.md`]: "---\nname: good\ndescription: d\n---\n正文",
      },
      [`${USER_DIR}/noname`, `${USER_DIR}/unclosed`, `${USER_DIR}/good`],
    );
    expect(reg.list().map((s) => s.name)).toEqual(["good"]);
    expect(reg.loadErrors()).toHaveLength(2);
    expect(reg.loadErrors().some((e) => e.reason.includes("缺 name"))).toBe(true);
    expect(reg.loadErrors().some((e) => e.reason.includes("未闭合"))).toBe(true);
  });

  test("无 frontmatter 定界符 → errors 收集；普通文件（非目录）忽略", async () => {
    const reg = await makeRegistry(
      {
        [`${USER_DIR}/raw/SKILL.md`]: "没有 frontmatter 的正文",
        [`${USER_DIR}/README.md`]: "这不是技能，是文件",
        [`${USER_DIR}/good/SKILL.md`]: "---\nname: good\ndescription: d\n---\n正文",
      },
      [`${USER_DIR}/raw`, `${USER_DIR}/good`], // README.md 不在 dirs → 文件
    );
    expect(reg.list().map((s) => s.name)).toEqual(["good"]);
    expect(reg.loadErrors()).toHaveLength(1);
    expect(reg.loadErrors()[0]!.reason).toContain("缺少 frontmatter");
  });

  test("refresh 重扫：新增技能在册、删除技能出册", async () => {
    const files: Record<string, string> = {
      [`${USER_DIR}/a/SKILL.md`]: "---\nname: a\ndescription: d\n---\nA",
    };
    const fs = memfs(files, [`${USER_DIR}/a`]);
    const reg = new SkillRegistry({ fs, userSkillsDir: USER_DIR, workspaceSkillsDir: WS_DIR });
    await reg.refresh();
    expect(reg.list().map((s) => s.name)).toEqual(["a"]);

    files[`${USER_DIR}/a/SKILL.md`] = "---\nname: a2\ndescription: d\n---\nA2";
    fs.readdir = (dir) =>
      dir === USER_DIR ? Promise.resolve(["a"]) : Promise.reject(new Error("ENOENT"));
    await reg.refresh();
    expect(reg.list().map((s) => s.name)).toEqual(["a2"]);
  });

  test("目录缺失层静默为空（用户未装技能不报错）", async () => {
    const reg = new SkillRegistry({
      fs: memfs({}, []),
      userSkillsDir: USER_DIR,
      workspaceSkillsDir: WS_DIR,
    });
    const result = await reg.refresh();
    expect(result.scanned.user).toBe(0);
    expect(result.scanned.workspace).toBe(0);
    expect(reg.list()).toHaveLength(0);
    expect(reg.loadErrors()).toHaveLength(0);
  });

  test("similar 相似候选：前缀/包含优先，编辑距离兜底", async () => {
    const reg = await makeRegistry(
      {
        [`${USER_DIR}/review-pr/SKILL.md`]: reviewPrMd(),
        [`${USER_DIR}/review-doc/SKILL.md`]: "---\nname: review-doc\ndescription: d\n---\nB",
        [`${USER_DIR}/unrelated/SKILL.md`]: "---\nname: unrelated\ndescription: d\n---\nC",
      },
      [`${USER_DIR}/review-pr`, `${USER_DIR}/review-doc`, `${USER_DIR}/unrelated`],
    );
    const candidates = reg.similar("review-p");
    expect(candidates).toContain("review-pr");
    expect(candidates).not.toContain("unrelated");
    expect(levenshtein("review-p", "review-pr")).toBe(1);
    expect(reg.similar("完全不相关")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* parseSkillMarkdown 房规直测                                          */
/* ------------------------------------------------------------------ */

describe("parseSkillMarkdown 房规解析", () => {
  test("完整样本：五字段齐备、正文剥离 frontmatter", () => {
    const parsed = parseSkillMarkdown(
      '---\nname: demo\ndescription: 演示技能\nallowed-tools: Read, Bash\nparams:\n  n:\n    type: number\n    required: true\n---\n正文第一行\n{{n}}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.name).toBe("demo");
    expect(parsed.description).toBe("演示技能");
    expect([...parsed.allowedTools]).toEqual(["Read", "Bash"]);
    expect(parsed.params["n"]!.type).toBe("number");
    expect(parsed.body).toBe("正文第一行\n{{n}}");
  });

  test("description 含冒号不误切", () => {
    const parsed = parseSkillMarkdown("---\nname: demo\ndescription: 时间: 效率: 双冒号\n---\nX");
    expect(parsed.ok && parsed.description).toBe("时间: 效率: 双冒号");
  });

  test("非法 type / 属性游离于 params 外 → 解析失败", () => {
    expect(
      parseSkillMarkdown("---\nname: d\ndescription: x\nparams:\n  n:\n    type: array\n---\nB").ok,
    ).toBe(false);
    expect(
      parseSkillMarkdown("---\nname: d\ndescription: x\n  orphan: true\n---\nB").ok,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* SkillTool                                                           */
/* ------------------------------------------------------------------ */

async function makeTool(): Promise<{ tool: SkillTool; reg: SkillRegistry }> {
  const reg = await makeRegistry({
    [`${USER_DIR}/review-pr/SKILL.md`]: reviewPrMd({
      params:
        "params:\n  pr_number:\n    type: number\n    required: true\n  title:\n    type: string\n",
      body: "评审 {{title}}（PR #{{pr_number}}），范围: {{unknown_placeholder}}",
    }),
    [`${WS_DIR}/executing-plans/SKILL.md`]:
      "---\nname: executing-plans\ndescription: 执行计划\n---\n按计划逐步执行，无需参数。",
  });
  return { tool: new SkillTool({ registry: reg }), reg };
}

describe("SkillTool 技能调度", () => {
  test("成功路径：查表 + 校验 + 正文展开 + allowed-tools 透传", async () => {
    const { tool } = await makeTool();
    const r = await tool.run({ skill: "review-pr", input: { pr_number: 42, title: "登录重构" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill).toBe("review-pr");
    expect(r.prompt).toBe("评审 登录重构（PR #42），范围: {{unknown_placeholder}}");
    expect([...r.allowedTools]).toEqual(["Read", "Grep", "Bash"]);
    expect(r.params).toEqual({ pr_number: 42, title: "登录重构" });
  });

  test("展开确定性：同输入两次调用逐字节相同", async () => {
    const { tool } = await makeTool();
    const args = { skill: "review-pr", input: { pr_number: 7, title: "X" } };
    const a = await tool.run(args);
    const b = await tool.run(args);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(Buffer.from(a.prompt, "utf8").equals(Buffer.from(b.prompt, "utf8"))).toBe(true);
      expect(a.prompt).toBe(b.prompt);
    }
  });

  test("unknown 技能 → 结构化拒绝并附相似候选", async () => {
    const { tool } = await makeTool();
    const r = await tool.run({ skill: "review-p" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unknown-skill");
      expect(r.candidates).toContain("review-pr");
    }
  });

  test("schema 校验矩阵：缺必填 / 类型错 / 未知键 / 无参技能空输入", async () => {
    const { tool } = await makeTool();

    const missing = await tool.run({ skill: "review-pr", input: { title: "t" } });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("schema-violation");
      expect(missing.violations).toEqual(["缺少必填参数: pr_number"]);
    }

    const wrongType = await tool.run({ skill: "review-pr", input: { pr_number: "42" } });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) {
      expect(wrongType.violations![0]).toContain("pr_number 类型应为 number");
    }

    const unknownKey = await tool.run({
      skill: "review-pr",
      input: { pr_number: 1, extra: true },
    });
    expect(unknownKey.ok).toBe(false);
    if (!unknownKey.ok) {
      expect(unknownKey.violations).toEqual(["未知参数: extra"]);
    }

    const noParams = await tool.run({ skill: "executing-plans" });
    expect(noParams.ok).toBe(true);

    const booleanType = validateSkillParams(
      { flag: { type: "boolean", required: true } },
      { flag: "yes" },
    );
    expect(booleanType).toEqual(["参数 flag 类型应为 boolean，实为 string"]);
  });

  test("input 非对象 / skill 缺失 → invalid-input", async () => {
    const { tool } = await makeTool();
    const r1 = await tool.run({ skill: "review-pr", input: "不是对象" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("invalid-input");
    const r2 = await tool.run({ input: {} });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("invalid-input");
    const r3 = await tool.run(undefined);
    expect(r3.ok).toBe(false);
  });

  test("expandSkillBody 未提供占位原样保留（确定性展开）", () => {
    expect(expandSkillBody("a {{x}} b {{y}}", { x: 1 })).toBe("a 1 b {{y}}");
    expect(expandSkillBody("无占位", {})).toBe("无占位");
  });
});
