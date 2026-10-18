import { describe, expect, test } from "bun:test";
import { PACKAGE, VERSION } from "./index";

describe("@bi/core", () => {
  test("导出 VERSION 常量", () => {
    expect(VERSION).toBe("0.2.0");
  });

  test("导出包描述对象", () => {
    expect(PACKAGE.name).toBe("@bi/core");
    expect(PACKAGE.version).toBe(VERSION);
    expect(PACKAGE.description.length).toBeGreaterThan(0);
  });
});
