/**
 * BI-05.2 · `bi init` 子命令（无头模式）测试。
 *
 * 覆盖：无 --yes 只打印草稿不落盘；--yes 才落盘且内容与草稿一致；
 * 目标已存在拒绝覆盖（返回码 1）；未知参数/--dir 缺参返回码 2；
 * --dir 相对路径以注入 cwd 为基准解析。
 */
import { describe, expect, test } from "bun:test";
import { runInit } from "./init";
import { makeMemFs } from "../../rules/testing-memfs";

const PROJ = {
  "/ws/demo/package.json": JSON.stringify({ name: "demo", scripts: { test: "vitest" } }),
  "/ws/demo/bun.lock": "",
};

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

describe("BI-05.2 bi init：无头模式", () => {
  test("无 --yes：仅打印草稿（四节可见），不落盘，退出码 0", () => {
    const fs = makeMemFs({ files: PROJ });
    const { lines, log } = collect();
    const code = runInit(["--dir", "/ws/demo"], { fs, cwd: "/ws/demo", log });
    expect(code).toBe(0);
    expect(fs.existsSync("/ws/demo/BI.md")).toBe(false);
    expect(lines.join("\n")).toContain("## 技术栈");
    expect(lines.join("\n")).toContain("## 测试");
    expect(lines.join("\n")).toContain("--yes");
  });

  test("--yes 才落盘：内容与 draftBiMd 草稿一致，退出码 0", () => {
    const fs = makeMemFs({ files: PROJ });
    const { lines, log } = collect();
    const code = runInit(["--dir", "/ws/demo", "--yes"], { fs, cwd: "/ws/demo", log });
    expect(code).toBe(0);
    const written = fs.peek("/ws/demo/BI.md");
    expect(written).toBeDefined();
    expect(written).toContain("- 测试框架：vitest");
    expect(written).toContain("需经人工审查");
    expect(lines.some((l) => l.includes("已写入"))).toBe(true);
  });

  test("目标 BI.md 已存在：返回码 1，内容未被改写", () => {
    const fs = makeMemFs({ files: { ...PROJ, "/ws/demo/BI.md": "# 既有内容" } });
    const { lines, log } = collect();
    const code = runInit(["--yes"], { fs, cwd: "/ws/demo", log });
    expect(code).toBe(1);
    expect(fs.peek("/ws/demo/BI.md")).toBe("# 既有内容");
    expect(lines.join("\n")).toContain("拒绝覆盖");
  });

  test("缺省目录取 opts.cwd：显式 --yes 直接写入 cwd/BI.md", () => {
    const fs = makeMemFs({ files: PROJ });
    const code = runInit(["--yes"], { fs, cwd: "/ws/demo", log: () => {} });
    expect(code).toBe(0);
    expect(fs.existsSync("/ws/demo/BI.md")).toBe(true);
  });

  test("未知参数：返回码 2 且不落盘", () => {
    const fs = makeMemFs({ files: PROJ });
    const code = runInit(["--force"], { fs, cwd: "/ws/demo", log: () => {} });
    expect(code).toBe(2);
    expect(fs.existsSync("/ws/demo/BI.md")).toBe(false);
  });

  test("--dir 缺参：返回码 2", () => {
    const code = runInit(["--dir"], { fs: makeMemFs(), cwd: "/ws/demo", log: () => {} });
    expect(code).toBe(2);
  });

  test("--dir 相对路径以 opts.cwd 为基准解析", () => {
    const fs = makeMemFs({ files: PROJ });
    const code = runInit(["--dir", "demo", "--yes"], { fs, cwd: "/ws", log: () => {} });
    expect(code).toBe(0);
    expect(fs.existsSync("/ws/demo/BI.md")).toBe(true);
  });

  test("空目录项目：草稿仍生成（未检测到字样），--yes 可落盘", () => {
    const fs = makeMemFs();
    const code = runInit(["--dir", "/empty", "--yes"], { fs, cwd: "/", log: () => {} });
    expect(code).toBe(0);
    const written = fs.peek("/empty/BI.md") ?? "";
    expect(written).toContain("（未检测到）");
  });
});
