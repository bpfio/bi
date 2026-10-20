import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE, VERSION } from "./index";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_VERSION = (
  JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { version: string }
).version;

describe("@bi/core", () => {
  test("导出 VERSION 常量（与 package.json 同卡同升）", () => {
    expect(VERSION).toBe(EXPECTED_VERSION);
  });

  test("导出包描述对象", () => {
    expect(PACKAGE.name).toBe("@bi/core");
    expect(PACKAGE.version).toBe(VERSION);
    expect(PACKAGE.description.length).toBeGreaterThan(0);
  });
});
