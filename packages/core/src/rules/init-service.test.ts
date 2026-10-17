/**
 * BI-05.2 · 技术栈探测与 BI.md 自省生成器测试（纯内存，零 IO）。
 *
 * 覆盖：各清单识别矩阵（package.json/Cargo.toml/pyproject.toml/go.mod/
 * Makefile/pnpm-workspace.yaml）、包管理器锁优先序（bun>pnpm>yarn>npm、
 * 无锁不臆测）、scripts.test 值分类矩阵、Makefile 兜底不越权、草稿
 * 确定性、四节模板、requiresReview 强制、writeBiMd 落盘。
 */
import { describe, expect, test } from "bun:test";
import { classifyTestScript, detectStack, draftBiMd, writeBiMd } from "./init-service";
import { makeMemFs } from "./testing-memfs";

const PKG = (scripts: Record<string, string>): string => JSON.stringify({ name: "demo", scripts });

describe("BI-05.2 detectStack：清单识别矩阵", () => {
  test("空目录：全空/全 null 的零值 StackProfile", () => {
    const profile = detectStack("/proj", makeMemFs());
    expect(profile).toEqual({
      cwd: "/proj",
      manifests: [],
      languages: [],
      packageManager: null,
      testFramework: null,
      testCommand: null,
      buildCommand: null,
    });
  });

  test("package.json：languages 含 javascript，manifests 记录；tsconfig 升级 typescript", () => {
    const plain = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}" } }));
    expect(plain.languages).toEqual(["javascript"]);
    expect(plain.manifests).toEqual(["package.json"]);

    const ts = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/tsconfig.json": "{}" } }));
    expect(ts.languages).toEqual(["javascript", "typescript"]);
  });

  test("无任何锁文件时包管理器为 null（不臆测默认值）", () => {
    const profile = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}" } }));
    expect(profile.packageManager).toBeNull();
  });

  test("锁识别：bun.lock 与 bun.lockb 均判 bun", () => {
    expect(detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/bun.lock": "" } })).packageManager).toBe("bun");
    expect(detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/bun.lockb": "" } })).packageManager).toBe("bun");
  });

  test("锁识别：pnpm-lock.yaml / pnpm-workspace.yaml 判 pnpm（工作区文件也计入 manifests）", () => {
    const lock = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/pnpm-lock.yaml": "" } }));
    expect(lock.packageManager).toBe("pnpm");
    const ws = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/pnpm-workspace.yaml": "" } }));
    expect(ws.packageManager).toBe("pnpm");
    expect(ws.manifests).toEqual(["package.json", "pnpm-workspace.yaml"]);
  });

  test("锁识别：yarn.lock 判 yarn；package-lock.json 判 npm", () => {
    const yarn = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/yarn.lock": "" } }));
    expect(yarn.packageManager).toBe("yarn");
    const npm = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/package-lock.json": "" } }));
    expect(npm.packageManager).toBe("npm");
  });

  test("全锁同存 → bun（优先序 bun > pnpm > yarn > npm）", () => {
    const profile = detectStack("/p", makeMemFs({
      files: {
        "/p/package.json": "{}",
        "/p/bun.lock": "",
        "/p/pnpm-lock.yaml": "",
        "/p/yarn.lock": "",
        "/p/package-lock.json": "",
      },
    }));
    expect(profile.packageManager).toBe("bun");
  });

  test("部分锁同存取最高优先：pnpm > yarn > npm", () => {
    const py = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/pnpm-lock.yaml": "", "/p/yarn.lock": "" } }));
    expect(py.packageManager).toBe("pnpm");
    const yn = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{}", "/p/yarn.lock": "", "/p/package-lock.json": "" } }));
    expect(yn.packageManager).toBe("yarn");
  });

  test("scripts.test 分类矩阵：vitest/jest/bun test/mocha/node --test/未知", () => {
    const check = (testScript: string): string | null =>
      detectStack("/p", makeMemFs({ files: { "/p/package.json": PKG({ test: testScript }) } })).testFramework;
    expect(check("vitest run")).toBe("vitest");
    expect(check("jest --coverage")).toBe("jest");
    expect(check("bun test")).toBe("bun");
    expect(check("mocha ./test")).toBe("mocha");
    expect(check("node --test")).toBe("node-test");
    expect(check("echo hi")).toBe("unknown");
  });

  test("testCommand 取 scripts.test 原文；scripts.build 进 buildCommand", () => {
    const profile = detectStack("/p", makeMemFs({
      files: { "/p/package.json": PKG({ test: "vitest run --reporter=verbose", build: "tsc -p ." }) },
    }));
    expect(profile.testCommand).toBe("vitest run --reporter=verbose");
    expect(profile.buildCommand).toBe("tsc -p .");
  });

  test("无 scripts / 损坏 package.json：不抛错，框架与命令为 null", () => {
    const noScripts = detectStack("/p", makeMemFs({ files: { "/p/package.json": '{"name":"x"}' } }));
    expect(noScripts.testFramework).toBeNull();
    expect(noScripts.buildCommand).toBeNull();
    const corrupt = detectStack("/p", makeMemFs({ files: { "/p/package.json": "{oops" } }));
    expect(corrupt.languages).toEqual(["javascript"]);
    expect(corrupt.testFramework).toBeNull();
  });

  test("Cargo.toml：rust + cargo + cargo test + cargo build", () => {
    const profile = detectStack("/p", makeMemFs({ files: { "/p/Cargo.toml": "[package]\nname='x'" } }));
    expect(profile.languages).toEqual(["rust"]);
    expect(profile.packageManager).toBe("cargo");
    expect(profile.testFramework).toBe("cargo-test");
    expect(profile.testCommand).toBe("cargo test");
    expect(profile.buildCommand).toBe("cargo build");
  });

  test("go.mod：go + go test ./... + go build ./...", () => {
    const profile = detectStack("/p", makeMemFs({ files: { "/p/go.mod": "module x" } }));
    expect(profile.languages).toEqual(["go"]);
    expect(profile.packageManager).toBe("go");
    expect(profile.testFramework).toBe("go-test");
    expect(profile.testCommand).toBe("go test ./...");
    expect(profile.buildCommand).toBe("go build ./...");
  });

  test("pyproject.toml：python + pip；[tool.poetry] 判 poetry；含 pytest 判 pytest", () => {
    const pip = detectStack("/p", makeMemFs({ files: { "/p/pyproject.toml": "[project]\nname='x'" } }));
    expect(pip.packageManager).toBe("pip");
    expect(pip.languages).toEqual(["python"]);
    const poetry = detectStack("/p", makeMemFs({ files: { "/p/pyproject.toml": "[tool.poetry]\nname='x'" } }));
    expect(poetry.packageManager).toBe("poetry");
    const pytest = detectStack("/p", makeMemFs({
      files: { "/p/pyproject.toml": "[project]\ndependencies=['pytest']" },
    }));
    expect(pytest.testFramework).toBe("pytest");
    expect(pytest.testCommand).toBe("pytest");
  });

  test("Makefile 兜底：make test / make build；不覆盖 node 已检测结果", () => {
    const only = detectStack("/p", makeMemFs({ files: { "/p/Makefile": "test:\n\techo t\nbuild:\n\techo b\n" } }));
    expect(only.testFramework).toBe("make");
    expect(only.testCommand).toBe("make test");
    expect(only.buildCommand).toBe("make build");

    const nodeWins = detectStack("/p", makeMemFs({
      files: {
        "/p/package.json": PKG({ test: "vitest", build: "tsc" }),
        "/p/Makefile": "test:\nbuild:\n",
      },
    }));
    expect(nodeWins.testFramework).toBe("vitest");
    expect(nodeWins.buildCommand).toBe("tsc");
  });

  test("多生态并存：语言并集字母序，包管理器与测试以 node 锁/scripts 为最高优先", () => {
    const profile = detectStack("/p", makeMemFs({
      files: {
        "/p/package.json": PKG({ test: "bun test" }),
        "/p/bun.lock": "",
        "/p/Cargo.toml": "",
        "/p/go.mod": "",
      },
    }));
    expect(profile.languages).toEqual(["go", "javascript", "rust"]);
    expect(profile.packageManager).toBe("bun");
    expect(profile.testFramework).toBe("bun");
    expect(profile.testCommand).toBe("bun test");
    expect(profile.buildCommand).toBe("cargo build"); // node 无 build 脚本时按生态链由 cargo 兜底
  });

  test("manifests 字母序输出（确定性）", () => {
    const profile = detectStack("/p", makeMemFs({
      files: {
        "/p/go.mod": "",
        "/p/Makefile": "",
        "/p/Cargo.toml": "",
        "/p/pyproject.toml": "",
      },
    }));
    expect(profile.manifests).toEqual(["Cargo.toml", "Makefile", "go.mod", "pyproject.toml"]);
  });
});

describe("BI-05.2 classifyTestScript：值分类单元", () => {
  test("大小写不敏感；node:test 亦判 node-test", () => {
    expect(classifyTestScript("VITEST run")).toBe("vitest");
    expect(classifyTestScript("node:test --test-reporter")).toBe("node-test");
  });
});

describe("BI-05.2 draftBiMd：确定性模板与审查语义", () => {
  const profile = detectStack("/p", makeMemFs({
    files: {
      "/p/package.json": PKG({ test: "vitest", build: "tsc -p ." }),
      "/p/bun.lock": "",
      "/p/tsconfig.json": "{}",
    },
  }));

  test("四节齐全：技术栈/构建/测试/约定", () => {
    const { draft } = draftBiMd(profile, { projectName: "demo" });
    expect(draft).toContain("## 技术栈");
    expect(draft).toContain("## 构建");
    expect(draft).toContain("## 测试");
    expect(draft).toContain("## 约定");
    expect(draft).toContain("- 包管理器：bun");
    expect(draft).toContain("- 构建命令：`tsc -p .`");
    expect(draft).toContain("- 测试框架：vitest");
  });

  test("确定性：同 profile 两次草稿逐字节相等，且无时间戳", () => {
    const one = draftBiMd(profile);
    const two = draftBiMd(profile);
    expect(one.draft).toBe(two.draft);
    expect(one.draft).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("requiresReview 恒为 true（强制审查语义，不直接落盘）", () => {
    expect(draftBiMd(profile).requiresReview).toBe(true);
  });

  test("缺失字段标注（未检测到）；projectName 缺省取 basename(cwd)", () => {
    const empty = detectStack("/some/where", makeMemFs());
    const { draft } = draftBiMd(empty);
    expect(draft).toContain("# where · BI.md");
    expect(draft).toContain("- 语言：（未检测到）");
    expect(draft).toContain("- 包管理器：（未检测到）");
    expect(draft).toContain("- 构建命令：（未检测到）");
  });

  test("projectName 覆盖标题", () => {
    expect(draftBiMd(profile, { projectName: "我的项目" }).draft).toContain("# 我的项目 · BI.md");
  });
});

describe("BI-05.2 writeBiMd：审批后的落盘动作", () => {
  test("写入内容与草稿一致（注入 fs）", () => {
    const fs = makeMemFs();
    writeBiMd("/p/BI.md", "# draft", { fs });
    expect(fs.peek("/p/BI.md")).toBe("# draft");
  });
});
