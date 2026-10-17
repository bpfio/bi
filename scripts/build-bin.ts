#!/usr/bin/env bun
/**
 * BI-22 — Bun Compile 独立单文件原生二进制构建发布
 *
 * 用法：
 *   bun scripts/build-bin.ts [--target <triple>] [--outdir <dir>] [--embed <dir>] [--check]
 *
 * 职责：
 *   1. 入口拼装：packages 下暂无 cli 包，使用 core 最小入口包装（临时 entry.ts 导出
 *      VERSION 并打印 `bi <VERSION>`）。最终入口随 BI-20.2 CLI 生态卡替换。
 *      偏差说明：工单示例为 `import { VERSION } from "@bi/core"`，但本仓库 bun
 *      workspace 不落 node_modules 符号链接，"@bi/core" 仅可由声明方 package.json
 *      解析（根 package.json 未声明），临时 entry 改用相对路径导入
 *      packages/core/src/index.ts，语义等价。
 *   2. compile：`bun build --compile --minify --sourcemap=none --target=<target>`。
 *      目标矩阵：linux-x64（本机默认）、darwin-arm64（交叉编译 `--target=bun-darwin-arm64`，
 *      尽力而为：默认运行时交叉失败只降级为 warnings 记录，不阻塞本机产物）。
 *      偏差说明：工单原文写 `-o <outdir>/bi`，但 bun 1.3.14 的 `bun build` 不接受
 *      `-o` 短选项，实际使用 `--outfile`（语义等价）。
 *   3. 产物完整性：sha256 写入 `<outdir>/bi.sha256`（sha256sum -c 兼容格式）；
 *      `--check` 模式仅校验现有产物哈希，不重建。
 *   4. 嵌入静态资源：`--embed <dir>` 读取 `<dir>/manifest.json`
 *      （schema：`{"assets":[{"name":"rg","path":"bin/rg"}]}`，path 相对 manifest 所在目录）。
 *      manifest 不存在 → 跳过并记录 warning；manifest 存在但资产文件缺失 → 结构化报错。
 *      为 BI-06.2 加速器（ripgrep/ugrep/bfs 预编译静态二进制）预留。
 *      Bun Compile 嵌入机制与 bun 版本兼容性：`import <abs> with { type: "file" }`
 *      在 bun 1.3.14 已可用（本卡实测通过：资产字节进入二进制，运行期
 *      `Bun.file(imported)` 读回原字节），生成模块由本脚本在构建期拼装。
 *   5. 结构化输出：成功打印 BuildReport JSON（含 `mode` 扩展字段区分 build/check）；
 *      失败打印 `{"ok":false,"error":...}` 并以退出码 1 结束。
 *
 * NOTE(BI-20.2): 入口替换 — 当 packages/cli 就位后，将 renderTempEntrySource
 * 下游指向 cli 包入口；临时 entry 拼装逻辑保留作为 fallback。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTDIR = "dist/bin";
const TEMP_DIR = join(REPO_ROOT, ".bi", "build-bin");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 目标平台三元组（归一化后） */
export type TargetTriple = "linux-x64" | "darwin-arm64";

export const SUPPORTED_TARGETS: readonly TargetTriple[] = ["linux-x64", "darwin-arm64"];

export interface EmbedManifestEntry {
  /** 嵌入后运行期引用名（如 "rg"） */
  name: string;
  /** 绝对路径（readEmbedManifest 从相对 path 解析而来） */
  path: string;
}

/** mode 为本卡扩展字段：区分构建报告与 --check 校验报告 */
export interface BuildReport {
  mode: "build" | "check";
  target: TargetTriple;
  outPath: string;
  bytes: number;
  sha256: string;
  durationMs: number;
  crossCompiled: boolean;
  warnings: string[];
}

export interface ParsedArgs {
  target?: TargetTriple;
  outdir: string;
  embed?: string;
  check: boolean;
}

/** BuildReport 声明字段清单（测试用于锁形状，防字段漂移） */
export const BuildReportShapeKeys = [
  "bytes",
  "crossCompiled",
  "durationMs",
  "mode",
  "outPath",
  "sha256",
  "target",
  "warnings",
] as const;

/** 携带结构化 payload 的错误；main() 捕获后输出 {"ok":false,...} */
export class StructuredError extends Error {
  readonly payload: Record<string, unknown>;
  constructor(message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = "StructuredError";
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Target 归一化
// ---------------------------------------------------------------------------

/** 本机矩阵目标；非 linux-x64/darwin-arm64 宿主不支持本矩阵 */
export function nativeTarget(): TargetTriple {
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  throw new StructuredError(`unsupported host for binary matrix: ${process.platform}-${process.arch}`, {
    supported: [...SUPPORTED_TARGETS],
  });
}

/** 三元组归一：缺省=本机；兼容 bun-* 前缀与常见别名 */
export function normalizeTarget(raw?: string): TargetTriple {
  if (raw === undefined || raw === "") return nativeTarget();
  const t = raw.toLowerCase().replace(/^bun-/, "");
  const aliases: Record<string, TargetTriple> = {
    "linux-x64": "linux-x64",
    "linux-amd64": "linux-x64",
    "linux-x86_64": "linux-x64",
    "darwin-arm64": "darwin-arm64",
    "darwin-aarch64": "darwin-arm64",
    "macos-arm64": "darwin-arm64",
    "macos-aarch64": "darwin-arm64",
    "mac-arm64": "darwin-arm64",
  };
  const hit = aliases[t];
  if (hit !== undefined) return hit;
  throw new StructuredError(`unsupported target: ${raw}`, {
    supported: [...SUPPORTED_TARGETS],
    hint: "accepted forms: linux-x64 | bun-linux-x64 | linux-amd64 | darwin-arm64 | bun-darwin-arm64 | macos-arm64",
  });
}

/** 三元组 → bun build --compile 的 --target 值 */
export function bunTargetFor(target: TargetTriple): string {
  return `bun-${target}`;
}

// ---------------------------------------------------------------------------
// CLI 参数解析
// ---------------------------------------------------------------------------

function readFlagValue(argv: string[], i: number, flag: string, inlineValue?: string): { value: string; next: number } {
  if (inlineValue !== undefined) return { value: inlineValue, next: i + 1 };
  const next = argv[i + 1];
  if (next === undefined) throw new StructuredError(`${flag} requires a value`, { flag });
  return { value: next, next: i + 2 };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { outdir: DEFAULT_OUTDIR, check: false };
  for (let i = 0; i < argv.length; ) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg.startsWith("--target=")) {
      parsed.target = normalizeTarget(readFlagValue(argv, i, "--target", arg.slice("--target=".length)).value);
      i += 1;
    } else if (arg === "--target") {
      const { value, next } = readFlagValue(argv, i, "--target");
      parsed.target = normalizeTarget(value);
      i = next;
    } else if (arg.startsWith("--outdir=")) {
      parsed.outdir = readFlagValue(argv, i, "--outdir", arg.slice("--outdir=".length)).value;
      i += 1;
    } else if (arg === "--outdir") {
      const { value, next } = readFlagValue(argv, i, "--outdir");
      parsed.outdir = value;
      i = next;
    } else if (arg.startsWith("--embed=")) {
      parsed.embed = readFlagValue(argv, i, "--embed", arg.slice("--embed=".length)).value;
      i += 1;
    } else if (arg === "--embed") {
      const { value, next } = readFlagValue(argv, i, "--embed");
      parsed.embed = value;
      i = next;
    } else if (arg === "--check") {
      parsed.check = true;
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new StructuredError(`unknown argument: ${arg}`, { arg });
    } else {
      throw new StructuredError(`unexpected positional argument: ${arg}`, { arg });
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 入口拼装（临时 entry；NOTE(BI-20.2): 最终入口随 CLI 生态卡替换）
// ---------------------------------------------------------------------------

// 仓库解析事实：bun 1.3.14 workspace 不在 node_modules 落包符号链接，
// "@bi/core" 仅能由声明了该依赖的 package.json 链解析（如 packages/tui 声明
// "workspace:*"）；根 package.json 未声明，故临时 entry 用相对路径导入 core
// 入口（语义与 `import { VERSION } from "@bi/core"` 等价，偏差已在卡报告注明）。
const CORE_ENTRY_SPECIFIER = "../../packages/core/src/index.ts";

/** 生成临时 entry.ts 内容（core 最小入口包装；embeds 非空时挂载嵌入资产表） */
export function renderTempEntrySource(embeds: EmbedManifestEntry[] | null): string {
  const embedHook =
    embeds !== null && embeds.length > 0
      ? `import { embeddedAssets } from "./bi-embed.gen.ts";\nglobalThis.__BI_EMBED_ASSETS__ = embeddedAssets;\n`
      : "";
  return [
    "// GENERATED by scripts/build-bin.ts (BI-22) — temp compile entry, do not edit.",
    "// NOTE(BI-20.2): placeholder entry; replace with the packages/cli entry when the CLI ecosystem card lands.",
    `import { VERSION } from ${JSON.stringify(CORE_ENTRY_SPECIFIER)};`,
    embedHook,
    `console.log("bi", VERSION);`,
    "",
  ].join("\n");
}

/** 生成嵌入资产清单模块：import attributes `with { type: "file" }`（bun >=1.2.17，本机 1.3.14 实测可用） */
export function renderEmbedModuleSource(entries: EmbedManifestEntry[]): string {
  const imports = entries.map((e, i) => `import a${i} from ${JSON.stringify(e.path)} with { type: "file" };`);
  const map = entries.map((e, i) => `  ${JSON.stringify(e.name)}: a${i},`);
  return [
    "// GENERATED by scripts/build-bin.ts (BI-22) — embedded asset manifest module, do not edit.",
    ...imports,
    "",
    "export const embeddedAssets = {",
    ...map,
    "} as const;",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 嵌入静态资源清单（BI-06.2 预留）
// ---------------------------------------------------------------------------

/**
 * 读取 <embedDir>/manifest.json；manifest 不存在返回 null（调用方跳过并报告）。
 * 资产文件缺失 → 结构化报错（manifest 存在即作者意图，缺文件按构建失败处理）。
 */
export function readEmbedManifest(embedDir: string): EmbedManifestEntry[] | null {
  const manifestPath = join(embedDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new StructuredError(`embed manifest is not valid JSON: ${manifestPath}`, {
      manifestPath,
      cause: String(err instanceof Error ? err.message : err),
    });
  }
  const assets = (raw as { assets?: unknown } | null)?.assets;
  if (!Array.isArray(assets)) {
    throw new StructuredError(`embed manifest must be {"assets":[{"name","path"}]}: ${manifestPath}`, { manifestPath });
  }
  const seen = new Set<string>();
  const entries: EmbedManifestEntry[] = [];
  const missing: string[] = [];
  for (const item of assets) {
    const rec = item as { name?: unknown; path?: unknown };
    if (typeof rec.name !== "string" || rec.name === "" || typeof rec.path !== "string" || rec.path === "") {
      throw new StructuredError(`embed manifest entry requires non-empty "name" and "path": ${manifestPath}`, {
        manifestPath,
        entry: item,
      });
    }
    if (seen.has(rec.name)) {
      throw new StructuredError(`embed manifest duplicate asset name "${rec.name}": ${manifestPath}`, { manifestPath });
    }
    seen.add(rec.name);
    const abs = isAbsolute(rec.path) ? rec.path : resolve(embedDir, rec.path);
    if (!existsSync(abs)) missing.push(abs);
    entries.push({ name: rec.name, path: abs });
  }
  if (missing.length > 0) {
    throw new StructuredError(`embed manifest references missing asset files: ${manifestPath}`, {
      manifestPath,
      missing,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

function runBunCompile(bunTarget: string, entryPath: string, outPath: string): void {
  const result = spawnSync(
    process.execPath,
    ["build", "--compile", "--minify", "--sourcemap=none", `--target=${bunTarget}`, entryPath, "--outfile", outPath],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const stderrTail = (result.stderr ?? "").split("\n").filter(Boolean).slice(-20).join("\n");
    throw new StructuredError(`bun build --compile failed (target=${bunTarget})`, {
      target: bunTarget,
      entryPath,
      outPath,
      exitStatus: result.status,
      signal: result.signal ?? null,
      stderrTail,
    });
  }
  // bun 1.3.14 --compile 在 --sourcemap=none 下仍会在 outfile 目录旁路写出
  // `<entry基名>.js.map`（实测副作用，二进制内嵌 debugId 引用的调试映射）。
  // 卡片要求 sourcemap=none，构建后清除该旁路文件，保证产物集干净。
  const strayMapPath = join(dirname(outPath), `${basename(entryPath).replace(/\.ts$/, "")}.js.map`);
  rmSync(strayMapPath, { force: true });
}

/** 编译单目标二进制。缺入口/编译失败均为结构化报错。 */
export function compileBinary(opts: { target: TargetTriple; entryPath: string; outPath: string }): void {
  if (!existsSync(opts.entryPath)) {
    throw new StructuredError(`entry not found: ${opts.entryPath}`, { entryPath: opts.entryPath });
  }
  mkdirSync(dirname(opts.outPath), { recursive: true });
  runBunCompile(bunTargetFor(opts.target), opts.entryPath, opts.outPath);
}

// ---------------------------------------------------------------------------
// 产物完整性：sha256 / sidecar / --check
// ---------------------------------------------------------------------------

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 写 sha256sum -c 兼容 sidecar：`<hash>  <basename>\n`；返回 sidecar 路径 */
export function writeSha256Sidecar(outPath: string): string {
  const sidecar = `${outPath}.sha256`;
  writeFileSync(sidecar, `${sha256File(outPath)}  ${basename(outPath)}\n`);
  return sidecar;
}

/** --check 模式：仅校验现有产物哈希（<out>.sha256），不重建 */
export function checkExisting(outPath: string): BuildReport {
  const started = performance.now();
  if (!existsSync(outPath)) {
    throw new StructuredError(`artifact not found: ${outPath}`, { outPath });
  }
  const sidecarPath = `${outPath}.sha256`;
  if (!existsSync(sidecarPath)) {
    throw new StructuredError(`sha256 sidecar not found: ${sidecarPath}`, { outPath, sidecarPath });
  }
  const recorded = readFileSync(sidecarPath, "utf8").trim().split(/\s+/)[0];
  if (recorded === undefined || recorded === "") {
    throw new StructuredError(`sha256 sidecar is empty: ${sidecarPath}`, { sidecarPath });
  }
  const actual = sha256File(outPath);
  if (actual !== recorded) {
    throw new StructuredError(`sha256 mismatch for ${outPath}`, {
      outPath,
      expected: recorded,
      actual,
    });
  }
  return {
    mode: "check",
    target: nativeTarget(),
    outPath,
    bytes: statSync(outPath).size,
    sha256: actual,
    durationMs: Math.round(performance.now() - started),
    crossCompiled: false,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// 构建编排
// ---------------------------------------------------------------------------

function resolveOutdir(outdir: string): string {
  return isAbsolute(outdir) ? outdir : join(REPO_ROOT, outdir);
}

export interface BuildBinOptions {
  target: TargetTriple;
  outdir: string;
  embedDir?: string;
  /** true=用户显式指定 --target（不做矩阵 best-effort 交叉）；false=默认运行 */
  explicitTarget: boolean;
}

export function buildBin(opts: BuildBinOptions): BuildReport {
  const started = performance.now();
  const warnings: string[] = [];

  // 嵌入清单解析（manifest 缺失=跳过+报告；资产缺失=结构化失败）
  let embeds: EmbedManifestEntry[] | null = null;
  if (opts.embedDir !== undefined) {
    const entries = readEmbedManifest(opts.embedDir);
    if (entries === null) {
      warnings.push(`embed: no manifest.json in ${opts.embedDir}; skipped`);
    } else if (entries.length === 0) {
      warnings.push(`embed: manifest has no assets in ${opts.embedDir}; nothing embedded`);
    } else {
      embeds = entries;
    }
  }

  // 临时 entry 落盘（.bi/ 已被 .gitignore 忽略；@bi/core 自该目录向上解析至仓库 node_modules）
  rmSync(TEMP_DIR, { recursive: true, force: true });
  mkdirSync(TEMP_DIR, { recursive: true });
  const entryPath = join(TEMP_DIR, "entry.ts");
  writeFileSync(entryPath, renderTempEntrySource(embeds));
  if (embeds !== null) writeFileSync(join(TEMP_DIR, "bi-embed.gen.ts"), renderEmbedModuleSource(embeds));

  const outdirAbs = resolveOutdir(opts.outdir);
  mkdirSync(outdirAbs, { recursive: true });

  // 主目标构建
  const outPath = join(outdirAbs, "bi");
  compileBinary({ target: opts.target, entryPath, outPath });
  writeSha256Sidecar(outPath);

  // 矩阵 best-effort：默认运行（未显式指定 target）时，尝试交叉 darwin-arm64，
  // 失败降级为 warning，不影响本机产物与退出码。
  let crossCompiled = false;
  if (!opts.explicitTarget && opts.target === "linux-x64") {
    const crossPath = join(outdirAbs, "bi-darwin-arm64");
    try {
      compileBinary({ target: "darwin-arm64", entryPath, outPath: crossPath });
      writeSha256Sidecar(crossPath);
      crossCompiled = true;
      warnings.push(
        `cross-compile darwin-arm64 ok: ${crossPath} (${statSync(crossPath).size} bytes, sha256 ${sha256File(crossPath)})`,
      );
    } catch (err) {
      const detail = err instanceof StructuredError ? String(err.payload.stderrTail ?? err.message) : String(err);
      warnings.push(`cross-compile darwin-arm64 failed (best-effort, native artifact unaffected): ${detail}`);
    }
  }

  rmSync(TEMP_DIR, { recursive: true, force: true });

  return {
    mode: "build",
    target: opts.target,
    outPath,
    bytes: statSync(outPath).size,
    sha256: sha256File(outPath),
    durationMs: Math.round(performance.now() - started),
    crossCompiled,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const outdirAbs = resolveOutdir(args.outdir);
  if (args.check) {
    const report = checkExisting(join(outdirAbs, "bi"));
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  const report = buildBin({
    target: args.target ?? nativeTarget(),
    outdir: args.outdir,
    embedDir: args.embed,
    explicitTarget: args.target !== undefined,
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      const payload =
        err instanceof StructuredError
          ? { ok: false, error: err.message, ...err.payload }
          : { ok: false, error: String(err instanceof Error ? err.message : err) };
      console.error(JSON.stringify(payload, null, 2));
      process.exit(1);
    },
  );
}
