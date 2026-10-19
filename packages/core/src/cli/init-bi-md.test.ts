/**
 * BI-05.2 / BI-24.1 —— `bi init` BI.md 草稿生成增强验收。
 *
 * 走 runBi 主分发 + SubcommandDeps 注入（临时目录，真实 fs），零网络：
 *   - 新生成：写 .bi/local.toml（语义不变）+ cwd/BI.md 草稿（detectStack 检测到的栈）；
 *   - 已存在不覆盖：local.toml 与 BI.md 均幂等跳过并报告路径；
 *   - 检测失败/不支持栈：无清单目录仍生成标注「未检测到」的草稿并结构化提示，绝不假冒。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await import("node:fs/promises").then((m) => m.mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function collect(): { io: { out: (line: string) => void; err: (line: string) => void }; outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { io: { out: (l) => outs.push(l), err: (l) => errs.push(l) }, outs, errs };
}

describe("BI-24.1 init · BI.md 草稿生成（增强）", () => {
  test("happy：写 local.toml + 检测到栈时生成含栈信息的 BI.md", async () => {
    const root = await tmpDir("bi-init-bimd-");
    const proj = join(root, "demo");
    await mkdir(proj, { recursive: true });
    // 模拟一个 bun 项目：package.json + bun.lock + tsconfig.json
    await writeFile(join(proj, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "vitest", build: "tsc" } }));
    await writeFile(join(proj, "bun.lock"), "");
    await writeFile(join(proj, "tsconfig.json"), "{}");

    const io = collect();
    expect(await runBi(["init", "--dir", "demo"], { ...io.io, deps: { cwd: root, homeDir: root } })).toBe(0);

    const biMd = await readFile(join(proj, "BI.md"), "utf8");
    expect(biMd).toContain("# demo · BI.md"); // projectName = basename(workDir)
    expect(biMd).toContain("## 技术栈");
    expect(biMd).toContain("- 包管理器：bun");
    expect(biMd).toContain("- 测试框架：vitest");
    expect(io.outs.join("\n")).toContain(join(proj, "BI.md"));
    // local.toml 脚手架语义不变（落在 demo 子目录）
    expect(await readFile(join(proj, ".bi", "local.toml"), "utf8")).toContain("[workspace]");
  });

  test("已存在不覆盖：local.toml 与 BI.md 均幂等跳过并报告路径", async () => {
    const root = await tmpDir("bi-init-bimd-");
    await mkdir(join(root, ".bi"), { recursive: true });
    await writeFile(join(root, ".bi", "local.toml"), "# existing");
    await writeFile(join(root, "BI.md"), "# hand written, keep me");

    const io = collect();
    expect(await runBi(["init"], { ...io.io, deps: { cwd: root, homeDir: root } })).toBe(0);

    // 内容原封不动
    expect(await readFile(join(root, "BI.md"), "utf8")).toBe("# hand written, keep me");
    expect(await readFile(join(root, ".bi", "local.toml"), "utf8")).toBe("# existing");
    const out = io.outs.join("\n");
    expect(out).toContain("BI.md 已存在");
    expect(out).toContain("local.toml 已存在");
  });

  test("不支持栈（无清单）：仍生成标注「未检测到」的 BI.md 并结构化提示，不假冒", async () => {
    const root = await tmpDir("bi-init-bimd-");
    const io = collect();
    expect(await runBi(["init"], { ...io.io, deps: { cwd: root, homeDir: root } })).toBe(0);

    const biMd = await readFile(join(root, "BI.md"), "utf8");
    expect(biMd).toContain("- 语言：（未检测到）");
    expect(biMd).toContain("- 包管理器：（未检测到）");
    expect(io.errs.join("\n")).toContain("未检测到支持的栈清单");
  });

  test("--dir 重定向：BI.md 落在重定向目录，local.toml 同步重定向", async () => {
    const root = await tmpDir("bi-init-bimd-");
    const sub = join(root, "ws");
    const io = collect();
    expect(await runBi(["init", "--dir", sub], { ...io.io, deps: { cwd: root, homeDir: root } })).toBe(0);
    expect(await readFile(join(sub, "BI.md"), "utf8")).toContain("## 技术栈");
    expect(await readFile(join(sub, ".bi", "local.toml"), "utf8")).toContain("[workspace]");
  });
});
