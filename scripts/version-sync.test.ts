/**
 * BI-26.6 —— 版本双源同步门禁。
 *
 * 背景:发布链版本号存在两个来源——根 package.json(npm 打包/npm-pack.ts 读取)
 * 与 @bi/core 的 VERSION 常量(编译二进制 `bi --version` 输出)。BI-25.5 排障中
 * 两者曾漂移(0.1.0 包发了 0.1.1 入口),本测试把"同卡同升"固化为结构约束:
 * 任一侧单独升版而未同步另一侧,全仓测试即红,发布不可通过。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../packages/core/src/index";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("版本双源同步(BI-26.6)", () => {
  test("根 package.json version === @bi/core VERSION", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version).not.toBe("");
    expect(pkg.version).toBe(VERSION);
  });
});
