/**
 * BI-05.2 —— 项目技术栈自主探测与 BI.md 规则自省生成器。
 *
 * 职责：
 *  1. detectStack：扫描清单文件（package.json/Cargo.toml/pyproject.toml/go.mod/
 *     Makefile/pnpm-workspace.yaml），判定包管理器、测试框架、构建命令。
 *  2. draftBiMd：按确定性模板生成初始 BI.md 草稿（技术栈/构建/测试/约定四节）；
 *     必须经用户审查——只返回 { draft, requiresReview: true }，绝不直接落盘。
 *  3. writeBiMd：由调用方在审批后显式调用落盘。
 *
 * 设计裁定：
 * - 包管理器优先序（按锁文件）：bun.lock/bun.lockb > pnpm-lock.yaml/
 *   pnpm-workspace.yaml > yarn.lock > package-lock.json；无任何锁文件时
 *   返回 null（不臆测默认值，草稿如实标注"未检测到"）。
 * - 生态precedence：node 锁 > cargo > go > python；Makefile 仅作
 *   测试/构建命令兜底，不覆盖已检测结果。
 * - languages/manifests 排序输出（确定性）；模板无时间戳，同 profile
 *   两次草稿逐字节相等。
 */
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import { DEFAULT_FS, type FsLike } from "../rules";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm" | "cargo" | "go" | "pip" | "poetry";

/** 工单点名的清单文件集合（tsconfig.json 与各锁文件仅作探测输入，不计入 manifests）。 */
const MANIFEST_FILES = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Makefile",
  "pnpm-workspace.yaml",
] as const;

export interface StackProfile {
  cwd: string;
  /** 检测到的清单文件名（字母序，确定性）。 */
  manifests: string[];
  /** 检测到的语言/运行时（字母序，确定性）。 */
  languages: string[];
  packageManager: PackageManager | null;
  testFramework: string | null;
  testCommand: string | null;
  buildCommand: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(fs: FsLike, path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** scripts.test 值分类：依关键字判定测试框架。 */
export function classifyTestScript(script: string): string {
  const s = script.toLowerCase();
  if (s.includes("vitest")) return "vitest";
  if (s.includes("bun test")) return "bun";
  if (s.includes("jest")) return "jest";
  if (s.includes("mocha")) return "mocha";
  if (s.includes("node --test") || s.includes("node:test")) return "node-test";
  if (s.includes("playwright")) return "playwright";
  return "unknown";
}

export function detectStack(cwd: string, injectFs?: FsLike): StackProfile {
  const fs = injectFs ?? DEFAULT_FS;
  const at = (name: string): string => nodePath.join(cwd, name);
  const exists = (name: string): boolean => fs.existsSync(at(name));

  const manifests: string[] = [];
  for (const name of MANIFEST_FILES) {
    if (exists(name)) manifests.push(name);
  }
  manifests.sort();

  const languages = new Set<string>();
  let packageManager: PackageManager | null = null;
  let testFramework: string | null = null;
  let testCommand: string | null = null;
  let buildCommand: string | null = null;

  // ---- 包管理器：仅由锁文件/工作区文件判定，bun > pnpm > yarn > npm ----
  if (exists("bun.lock") || exists("bun.lockb")) packageManager = "bun";
  else if (exists("pnpm-lock.yaml") || exists("pnpm-workspace.yaml")) packageManager = "pnpm";
  else if (exists("yarn.lock")) packageManager = "yarn";
  else if (exists("package-lock.json")) packageManager = "npm";

  // ---- Node / TypeScript ----
  let pkg: Record<string, unknown> | null = null;
  if (exists("package.json")) {
    languages.add("javascript");
    if (exists("tsconfig.json")) languages.add("typescript");
    const raw = readText(fs, at("package.json"));
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) pkg = parsed;
      } catch {
        pkg = null; // 损坏 package.json：清单仍存在，但脚本不可用
      }
    }
    const scripts: Record<string, unknown> = pkg !== null && isRecord(pkg["scripts"]) ? pkg["scripts"] : {};
    const testScript = typeof scripts["test"] === "string" ? (scripts["test"] as string).trim() : "";
    if (testScript.length > 0) {
      testFramework = classifyTestScript(testScript);
      testCommand = testScript;
    }
    const buildScript = typeof scripts["build"] === "string" ? (scripts["build"] as string).trim() : "";
    if (buildScript.length > 0) buildCommand = buildScript;
  }

  // ---- Rust ----
  if (exists("Cargo.toml")) {
    languages.add("rust");
    if (packageManager === null) packageManager = "cargo";
    if (testFramework === null) {
      testFramework = "cargo-test";
      testCommand = "cargo test";
    }
    if (buildCommand === null) buildCommand = "cargo build";
  }

  // ---- Go ----
  if (exists("go.mod")) {
    languages.add("go");
    if (packageManager === null) packageManager = "go";
    if (testFramework === null) {
      testFramework = "go-test";
      testCommand = "go test ./...";
    }
    if (buildCommand === null) buildCommand = "go build ./...";
  }

  // ---- Python ----
  if (exists("pyproject.toml")) {
    languages.add("python");
    const content = readText(fs, at("pyproject.toml")) ?? "";
    if (packageManager === null) packageManager = content.includes("[tool.poetry]") ? "poetry" : "pip";
    if (testFramework === null && content.includes("pytest")) {
      testFramework = "pytest";
      testCommand = "pytest";
    }
  }

  // ---- Makefile 兜底（不覆盖已检测结果）----
  if (exists("Makefile")) {
    const makefile = readText(fs, at("Makefile")) ?? "";
    if (testCommand === null && /^test[ \t]*:/m.test(makefile)) {
      testFramework = "make";
      testCommand = "make test";
    }
    if (buildCommand === null && /^build[ \t]*:/m.test(makefile)) buildCommand = "make build";
  }

  return {
    cwd,
    manifests,
    languages: [...languages].sort(),
    packageManager,
    testFramework,
    testCommand,
    buildCommand,
  };
}

export interface DraftBiMdOptions {
  projectName?: string;
}

export interface BiMdDraft {
  draft: string;
  /** 恒为 true：草稿必须经用户审查，调用方审批后才可 writeBiMd。 */
  requiresReview: true;
}

/** 确定性模板：技术栈/构建/测试/约定四节；缺失字段如实标注"未检测到"。 */
export function draftBiMd(profile: StackProfile, opts?: DraftBiMdOptions): BiMdDraft {
  const name = opts?.projectName ?? nodePath.basename(profile.cwd);
  const joinList = (items: readonly string[]): string =>
    items.length > 0 ? items.join("、") : "（未检测到）";
  const cmd = (value: string | null): string => (value === null ? "（未检测到）" : `\`${value}\``);
  const draft = [
    `# ${name} · BI.md`,
    "",
    "> 本文件为 `bi init` 生成的项目长期记忆草稿，需经人工审查修订后方可生效。",
    "",
    "## 技术栈",
    `- 语言：${joinList(profile.languages)}`,
    `- 包管理器：${profile.packageManager ?? "（未检测到）"}`,
    `- 清单文件：${joinList(profile.manifests)}`,
    "",
    "## 构建",
    `- 构建命令：${cmd(profile.buildCommand)}`,
    "",
    "## 测试",
    `- 测试框架：${profile.testFramework ?? "（未检测到）"}`,
    `- 测试命令：${cmd(profile.testCommand)}`,
    "",
    "## 约定",
    "- （待补充：提交规范、目录结构、命名约定等团队约定）",
    "",
  ].join("\n");
  return { draft, requiresReview: true };
}

/** 审批通过后的落盘动作；只应由持有审查结论的调用方调用。 */
export function writeBiMd(path: string, draft: string, opts?: { fs?: FsLike }): void {
  (opts?.fs ?? DEFAULT_FS).writeFileSync(path, draft);
}
