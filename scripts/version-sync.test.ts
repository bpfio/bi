/**
 * BI-26.6 —— 版本多源同步门禁（PROD-4 扩展为三源同卡同升）。
 *
 * 背景:发布链版本号存在多个来源——
 *   1. 根 package.json（npm 打包 / scripts/npm-pack.ts 读取的版本）
 *   2. @bi/core package.json（workspace 包版本,随根同升）
 *   3. @bi/tui package.json（workspace 包版本,随根同升）
 *   4. @bi/core 的 VERSION 常量（Bun Compile 二进制 `bi --version` 输出源）
 * BI-25.5 排障中根 package.json 与 VERSION 曾漂移(0.1.0 包发了 0.1.1 入口);
 * PROD-4 验收发现 @bi/core / @bi/tui 的 package.json 也滞后于根(0.1.0 vs 0.2.0)。
 * 本测试把"同卡同升"固化为结构约束:任一处单独升版而未同步其他处,全仓测试即红,
 * 发布不可通过。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../packages/core/src/index";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readVersion(relPath: string): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, relPath), "utf8")) as { version?: unknown };
  expect(typeof pkg.version).toBe("string");
  expect(pkg.version).not.toBe("");
  return pkg.version as string;
}

describe("版本多源同步(BI-26.6 / PROD-4)", () => {
  const rootVersion = readVersion("package.json");
  const coreVersion = readVersion("packages/core/package.json");
  const tuiVersion = readVersion("packages/tui/package.json");

  test("根 package.json version === @bi/core VERSION 常量", () => {
    expect(rootVersion).toBe(VERSION);
  });

  test("@bi/core package.json version === @bi/core VERSION 常量", () => {
    expect(coreVersion).toBe(VERSION);
  });

  test("@bi/tui package.json version === @bi/core VERSION 常量", () => {
    expect(tuiVersion).toBe(VERSION);
  });

  test("三处 package.json 版本彼此相等（同卡同升）", () => {
    expect(coreVersion).toBe(rootVersion);
    expect(tuiVersion).toBe(rootVersion);
  });
});
