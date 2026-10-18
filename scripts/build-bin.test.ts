// BI-22 — scripts/build-bin.ts 单元与冒烟测试
// 运行：bun test scripts/

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BuildReportShapeKeys,
  bunTargetFor,
  buildBin,
  checkExisting,
  compileBinary,
  normalizeTarget,
  parseArgs,
  readEmbedManifest,
  renderEmbedModuleSource,
  renderTempEntrySource,
  sha256File,
  StructuredError,
  writeSha256Sidecar,
} from "./build-bin.ts";

const SCRATCH = join(tmpdir(), `bi22-test-${process.pid}`);

beforeAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function scratch(name: string): string {
  return join(SCRATCH, name);
}

// ---------------------------------------------------------------------------
// 参数解析矩阵
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("无参数 → 默认 outdir=dist/bin、check=false、target 缺省本机", () => {
    const args = parseArgs([]);
    expect(args.target).toBeUndefined();
    expect(args.outdir).toBe("dist/bin");
    expect(args.check).toBe(false);
    expect(args.embed).toBeUndefined();
  });

  test("--target bun-darwin-arm64 → 归一为 darwin-arm64", () => {
    expect(parseArgs(["--target", "bun-darwin-arm64"]).target).toBe("darwin-arm64");
  });

  test("--target=macos-arm64 内联形式与别名 → darwin-arm64", () => {
    expect(parseArgs(["--target=macos-arm64"]).target).toBe("darwin-arm64");
  });

  test("--outdir/--embed/--check 组合", () => {
    const args = parseArgs(["--outdir", "/tmp/x", "--embed=/tmp/e", "--check"]);
    expect(args.outdir).toBe("/tmp/x");
    expect(args.embed).toBe("/tmp/e");
    expect(args.check).toBe(true);
  });

  test("--target 缺值 → 结构化报错", () => {
    expect(() => parseArgs(["--target"])).toThrow(StructuredError);
    expect(() => parseArgs(["--target"])).toThrow(/requires a value/);
  });

  test("未知 flag 与位置参数 → 结构化报错", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["stray"])).toThrow(/unexpected positional/);
  });
});

// ---------------------------------------------------------------------------
// target 三元组归一
// ---------------------------------------------------------------------------

describe("normalizeTarget", () => {
  test("缺省 → 本机三元组（当前宿主 linux-x64）", () => {
    expect(normalizeTarget(undefined)).toBe("linux-x64");
    expect(normalizeTarget("")).toBe("linux-x64");
  });

  test("bun-* 前缀剥离与别名矩阵", () => {
    expect(normalizeTarget("bun-linux-x64")).toBe("linux-x64");
    expect(normalizeTarget("linux-amd64")).toBe("linux-x64");
    expect(normalizeTarget("LINUX-X86_64")).toBe("linux-x64");
    expect(normalizeTarget("darwin-aarch64")).toBe("darwin-arm64");
    expect(normalizeTarget("mac-arm64")).toBe("darwin-arm64");
  });

  test("矩阵外 target → 结构化报错并列出支持矩阵", () => {
    try {
      normalizeTarget("windows-x64");
      throw new Error("expected StructuredError");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      const e = err as StructuredError;
      expect(String(e.payload.supported)).toContain("linux-x64");
      expect(String(e.payload.supported)).toContain("darwin-arm64");
    }
  });

  test("bunTargetFor: 三元组 → bun build --compile target 值", () => {
    expect(bunTargetFor("linux-x64")).toBe("bun-linux-x64");
    expect(bunTargetFor("darwin-arm64")).toBe("bun-darwin-arm64");
  });
});

// ---------------------------------------------------------------------------
// 临时 entry 与嵌入模块生成
// ---------------------------------------------------------------------------

describe("renderTempEntrySource / renderEmbedModuleSource", () => {
  test("无嵌入：bin/bi.ts 真实入口（BI-25.5 修复 REPL 主面），不含 file 属性导入", () => {
    const src = renderTempEntrySource(null);
    // 编译入口=bin/bi.ts（无参→REPL；带参→runBi 全分发），相对路径副作用导入
    expect(src).toContain('await import("../../bin/bi.ts");');
    expect(src).toContain("BI-25.5");
    expect(src).not.toContain("packages/core/src/cli/main.ts");
    expect(src).not.toContain('with { type: "file" }');
  });

  test("有嵌入：entry 引用嵌入模块并挂载 globalThis", () => {
    const src = renderTempEntrySource([{ name: "rg", path: "/abs/rg" }]);
    expect(src).toContain('from "./bi-embed.gen.ts"');
    expect(src).toContain("globalThis.__BI_EMBED_ASSETS__");
  });

  test("嵌入模块：with { type: \"file\" } 绝对路径导入与名称映射", () => {
    const src = renderEmbedModuleSource([
      { name: "rg", path: "/abs/rg" },
      { name: "bfs", path: "/abs/bfs" },
    ]);
    expect(src).toContain('import a0 from "/abs/rg" with { type: "file" };');
    expect(src).toContain('import a1 from "/abs/bfs" with { type: "file" };');
    expect(src).toContain('"rg": a0,');
    expect(src).toContain('"bfs": a1,');
  });
});

// ---------------------------------------------------------------------------
// sha256 / sidecar / --check
// ---------------------------------------------------------------------------

describe("sha256 / checkExisting", () => {
  test("sha256File 固定基准值（sha256(\"bi22\")）", () => {
    const p = scratch("groundtruth.txt");
    writeFileSync(p, "bi22");
    expect(sha256File(p)).toBe("9413f01b22a1257a39bb2487d309a9d6217b83f5d0a29d19af6864b9a9d314ba");
  });

  test("writeSha256Sidecar: <out>.sha256、sha256sum -c 兼容格式", () => {
    const p = scratch("artifact.bin");
    writeFileSync(p, "bi22");
    const sidecar = writeSha256Sidecar(p);
    expect(sidecar).toBe(`${p}.sha256`);
    const line = readFileSync(sidecar, "utf8");
    expect(line).toBe("9413f01b22a1257a39bb2487d309a9d6217b83f5d0a29d19af6864b9a9d314ba  artifact.bin\n");
  });

  test("checkExisting: 哈希一致 → mode=check 报告", () => {
    const p = scratch("ok.bin");
    writeFileSync(p, "bi22");
    writeSha256Sidecar(p);
    const report = checkExisting(p);
    expect(report.mode).toBe("check");
    expect(report.sha256).toBe("9413f01b22a1257a39bb2487d309a9d6217b83f5d0a29d19af6864b9a9d314ba");
    expect(report.bytes).toBe(4);
  });

  test("checkExisting: 产物被篡改 → 结构化 mismatch（expected/actual）", () => {
    const p = scratch("tampered.bin");
    writeFileSync(p, "bi22");
    writeSha256Sidecar(p);
    writeFileSync(p, "bi23");
    try {
      checkExisting(p);
      throw new Error("expected StructuredError");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      const e = err as StructuredError;
      expect(e.message).toContain("sha256 mismatch");
      expect(e.payload.expected).toBe("9413f01b22a1257a39bb2487d309a9d6217b83f5d0a29d19af6864b9a9d314ba");
      expect(e.payload.actual).not.toBe(e.payload.expected);
    }
  });

  test("checkExisting: 缺产物或缺 sidecar → 结构化报错", () => {
    expect(() => checkExisting(scratch("missing.bin"))).toThrow(/artifact not found/);
    const p = scratch("nosidecar.bin");
    writeFileSync(p, "x");
    expect(() => checkExisting(p)).toThrow(/sidecar not found/);
  });
});

// ---------------------------------------------------------------------------
// 嵌入清单
// ---------------------------------------------------------------------------

describe("readEmbedManifest", () => {
  test("目录或 manifest 不存在 → null（跳过路径）", () => {
    expect(readEmbedManifest(scratch("no-such-dir"))).toBeNull();
    mkdirSync(scratch("empty-embed"), { recursive: true });
    expect(readEmbedManifest(scratch("empty-embed"))).toBeNull();
  });

  test("合法 manifest → 绝对路径条目", () => {
    const dir = scratch("embed-ok");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rg.bin"), "rg-bytes");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ assets: [{ name: "rg", path: "rg.bin" }] }));
    const entries = readEmbedManifest(dir);
    expect(entries).toEqual([{ name: "rg", path: join(dir, "rg.bin") }]);
  });

  test("重复 name / 资产缺失 / 坏 JSON / 形状错误 → 结构化报错", () => {
    const dup = scratch("embed-dup");
    mkdirSync(dup, { recursive: true });
    writeFileSync(join(dup, "manifest.json"), JSON.stringify({ assets: [{ name: "a", path: "x" }, { name: "a", path: "y" }] }));
    expect(() => readEmbedManifest(dup)).toThrow(/duplicate asset name/);

    const miss = scratch("embed-missing-file");
    mkdirSync(miss, { recursive: true });
    writeFileSync(join(miss, "manifest.json"), JSON.stringify({ assets: [{ name: "rg", path: "ghost.bin" }] }));
    try {
      readEmbedManifest(miss);
      throw new Error("expected StructuredError");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect(String((err as StructuredError).payload.missing)).toContain("ghost.bin");
    }

    const bad = scratch("embed-bad-json");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "manifest.json"), "{not json");
    expect(() => readEmbedManifest(bad)).toThrow(/not valid JSON/);

    const shape = scratch("embed-bad-shape");
    mkdirSync(shape, { recursive: true });
    writeFileSync(join(shape, "manifest.json"), JSON.stringify({ assets: [{ name: "rg" }] }));
    expect(() => readEmbedManifest(shape)).toThrow(/non-empty/);
  });
});

// ---------------------------------------------------------------------------
// compileBinary 缺入口结构化报错
// ---------------------------------------------------------------------------

describe("compileBinary", () => {
  test("entry 不存在 → 结构化报错且不触发 bun build", () => {
    try {
      compileBinary({ target: "linux-x64", entryPath: scratch("ghost-entry.ts"), outPath: scratch("ghost-out/bi") });
      throw new Error("expected StructuredError");
    } catch (err) {
      expect(err).toBeInstanceOf(StructuredError);
      expect((err as StructuredError).message).toContain("entry not found");
      expect((err as StructuredError).payload.entryPath).toContain("ghost-entry.ts");
    }
  });
});

// ---------------------------------------------------------------------------
// BuildReport 形状与真实构建 e2e（本机 linux-x64，含嵌入资产）
// ---------------------------------------------------------------------------

describe("buildBin e2e", () => {
  test("真实构建 linux-x64：BuildReport 字段、sidecar、产物可执行输出", async () => {
    const embedDir = scratch("e2e-embed");
    mkdirSync(embedDir, { recursive: true });
    writeFileSync(join(embedDir, "asset.txt"), "bi22-embed-probe");
    writeFileSync(join(embedDir, "manifest.json"), JSON.stringify({ assets: [{ name: "probe", path: "asset.txt" }] }));

    const outdir = scratch("e2e-out");
    const report = buildBin({ target: "linux-x64", outdir, embedDir, explicitTarget: true });

    // BuildReport 字段完整性（卡片结构 + mode 扩展）
    expect(Object.keys(report).sort()).toEqual([...BuildReportShapeKeys]);
    expect(report.mode).toBe("build");
    expect(report.target).toBe("linux-x64");
    expect(report.outPath).toBe(join(outdir, "bi"));
    expect(report.bytes).toBeGreaterThan(1_000_000); // 编入了 bun runtime
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.crossCompiled).toBe(false); // explicitTarget=true 不做矩阵交叉
    expect(report.warnings).toEqual([]);
    expect(report.durationMs).toBeGreaterThan(0);

    // sidecar 与 --check 闭环
    expect(existsSync(`${report.outPath}.sha256`)).toBe(true);
    expect(checkExisting(report.outPath).sha256).toBe(report.sha256);

    // 产物集干净：bun 1.3.14 --compile 旁路的 entry.js.map 已被清除
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(outdir).sort()).toEqual(["bi", "bi.sha256"]);

    // 冒烟执行：BI-23.1 真实入口主分发——--version 输出 "bi <VERSION>"（exit 0）
    const proc = Bun.spawn([report.outPath, "--version"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^bi \d+\.\d+\.\d+/);
    // 裸跑（无参数）：BI-25.5 起入口=bin/bi.ts → 交互 REPL 主路径。
    // HOME 指向空目录 → 配置装载/凭据门结构化失败（exit 3，stderr "bi: " 前缀），
    // 证明裸跑已落入 REPL 装配路径而非 runBi 的 USAGE 分支
    // （旧 0.1.0 缺陷：编译入口指向 core main，裸跑 exit 2，发布物缺 REPL 主入口）。
    const bareHome = scratch("bare-home");
    mkdirSync(bareHome, { recursive: true });
    const bare = Bun.spawn([report.outPath], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: bareHome, XDG_CONFIG_HOME: join(bareHome, ".config") },
    });
    const bareErr = await new Response(bare.stderr).text();
    expect(await bare.exited).toBe(3);
    expect(bareErr).toContain("bi: ");
  }, 180_000);
});
