import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSearchPrelude, detectSearchBinaries } from "./embedded-search";

// ---------------------------------------------------------------------------
// buildSearchPrelude — 确定性与脚本结构
// ---------------------------------------------------------------------------

describe("buildSearchPrelude", () => {
  test("is byte-identical for identical inputs", () => {
    expect(buildSearchPrelude()).toBe(buildSearchPrelude());
    const opts = { bfsPath: "/opt/bfs", ugrepPath: "/opt/ugrep" };
    expect(buildSearchPrelude(opts)).toBe(buildSearchPrelude(opts));
  });

  test("defines transparent hijack functions for find and grep", () => {
    const prelude = buildSearchPrelude();
    expect(prelude).toContain("find() {");
    expect(prelude).toContain("grep() {");
  });

  test("emits no export lines when no explicit paths are given", () => {
    const prelude = buildSearchPrelude();
    expect(prelude).not.toContain("export BI_BFS_PATH");
    expect(prelude).not.toContain("export BI_UGREP_PATH");
  });

  test("injects the explicit bfs path as an export line", () => {
    expect(buildSearchPrelude({ bfsPath: "/opt/tools/bfs" })).toContain(
      "export BI_BFS_PATH='/opt/tools/bfs'",
    );
  });

  test("injects the explicit ugrep path as an export line", () => {
    expect(buildSearchPrelude({ ugrepPath: "/opt/tools/ugrep" })).toContain(
      "export BI_UGREP_PATH='/opt/tools/ugrep'",
    );
  });

  test("escapes single quotes in injected paths (POSIX '\\'' form)", () => {
    const prelude = buildSearchPrelude({ bfsPath: "/opt/my'tools" });
    expect(prelude).toContain(`export BI_BFS_PATH='/opt/my'\\''tools'`);
  });

  test("appends bfs-syntax hidden/.git filters in the hijack branch", () => {
    const prelude = buildSearchPrelude();
    expect(prelude).toContain("-nohidden");
    expect(prelude).toContain("-exclude .git");
  });

  test("appends ugrep-syntax hidden/.git filters in the hijack branch", () => {
    const prelude = buildSearchPrelude();
    expect(prelude).toContain("--hidden");
    expect(prelude).toContain("--exclude-dir=.git");
  });

  test("falls back to the real find/grep via command passthrough", () => {
    const prelude = buildSearchPrelude();
    expect(prelude).toContain('command find "$@"');
    expect(prelude).toContain('command grep "$@"');
  });

  test("forwards arguments and binary paths via printf %q quoting", () => {
    const prelude = buildSearchPrelude();
    const argForwardCount = prelude.split(`printf ' %q' "$@"`).length - 1;
    expect(argForwardCount).toBe(4); // find/grep 各两分支（直连 + 探测）
    expect(prelude).toContain(`printf ' %q' "$BI_BFS_PATH"`);
    expect(prelude).toContain(`printf ' %q' "$BI_UGREP_PATH"`);
  });

  test("probes bfs/ugrep via command -v when no explicit path", () => {
    const prelude = buildSearchPrelude();
    expect(prelude).toContain("command -v");
    expect(prelude).toContain("__bi_search_have bfs");
    expect(prelude).toContain("__bi_search_have ugrep");
  });

  test("never uses exec inside functions (host-shell safety)", () => {
    const prelude = buildSearchPrelude();
    const functionBodies = prelude.slice(prelude.indexOf("__bi_search_have"));
    expect(functionBodies.length).toBeGreaterThan(0);
    expect(/\bexec\b/.test(functionBodies)).toBe(false);
  });

  test("ends with a trailing newline (sourcable)", () => {
    expect(buildSearchPrelude().endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectSearchBinaries — 注入探测
// ---------------------------------------------------------------------------

describe("detectSearchBinaries", () => {
  test("prefers the injected probe", () => {
    const result = detectSearchBinaries(undefined, (name) =>
      name === "bfs" ? "/x/bfs" : null,
    );
    expect(result).toEqual({ bfs: "/x/bfs" });
    expect("ugrep" in result).toBe(false);
  });

  test("probe result covers both tools", () => {
    const result = detectSearchBinaries(undefined, (name) => `/bin/${name}`);
    expect(result).toEqual({ bfs: "/bin/bfs", ugrep: "/bin/ugrep" });
  });

  test("injected probe wins over candidate path lists", () => {
    const dir = mkdtempSync(join(tmpdir(), "bi-embedded-search-"));
    try {
      writeFileSync(join(dir, "bfs"), "#!/bin/sh\n");
      chmodSync(join(dir, "bfs"), 0o755);
      const result = detectSearchBinaries([dir], () => null);
      expect(result).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("scans candidate directories for executable binaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "bi-embedded-search-"));
    try {
      const bfs = join(dir, "bfs");
      writeFileSync(bfs, "#!/bin/sh\n");
      chmodSync(bfs, 0o755);
      expect(detectSearchBinaries([dir])).toEqual({ bfs });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores non-executable files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bi-embedded-search-"));
    try {
      writeFileSync(join(dir, "ugrep"), "not executable");
      expect(detectSearchBinaries([dir])).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns empty when nothing is found", () => {
    expect(detectSearchBinaries([])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 行为级验证：真实 bash 里 source prelude 后调用（无 bash 环境跳过）
// ---------------------------------------------------------------------------

const BASH = ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path));

function makeStub(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\nfor a in "$@"; do echo "ARG:$a"; done\n');
  chmodSync(path, 0o755);
  return path;
}

function runBash(script: string): { status: number; stdout: string } {
  const result = spawnSync(BASH!, ["-c", script], { encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function argLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("ARG:"))
    .map((line) => line.slice(4));
}

(BASH === undefined ? describe.skip : describe)("buildSearchPrelude behavioral", () => {
  test("hijack branch: args forwarded verbatim (spaces/quotes/globs) plus bfs filters", () => {
    const dir = mkdtempSync(join(tmpdir(), "bi-embedded-search-"));
    try {
      const prelude = buildSearchPrelude({ bfsPath: makeStub(dir, "bfs") });
      const script = `${prelude}\nfind 'a b' "it's" -name '*.ts'\n`;
      const { status, stdout } = runBash(script);
      expect(status).toBe(0);
      expect(argLines(stdout)).toEqual([
        "-nohidden",
        "-exclude",
        ".git",
        "a b",
        "it's",
        "-name",
        "*.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fallback branch: real find receives only user args (no filters appended)", () => {
    const stubDir = mkdtempSync(join(tmpdir(), "bi-embedded-path-"));
    const dir = mkdtempSync(join(tmpdir(), "bi-embedded-search-"));
    try {
      makeStub(stubDir, "find"); // PATH 里唯一的 find；无 bfs/ugrep
      const prelude = buildSearchPrelude({
        bfsPath: "/nonexistent/bfs",
        ugrepPath: "/nonexistent/ugrep",
      });
      const script = `export PATH='${stubDir}'\n${prelude}\nfind 'x y'\n`;
      const { status, stdout } = runBash(script);
      expect(status).toBe(0);
      expect(argLines(stdout)).toEqual(["x y"]);
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("grep hijack branch: args forwarded verbatim plus ugrep filters", () => {
    const dir = mkdtempSync(join(tmpdir(), "bi-embedded-search-"));
    try {
      const prelude = buildSearchPrelude({ ugrepPath: makeStub(dir, "ugrep") });
      const script = `${prelude}\ngrep -n foo bar.txt\n`;
      const { status, stdout } = runBash(script);
      expect(status).toBe(0);
      expect(argLines(stdout)).toEqual([
        "--hidden",
        "--exclude-dir=.git",
        "-n",
        "foo",
        "bar.txt",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
