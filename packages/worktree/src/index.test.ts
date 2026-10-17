import { describe, expect, test } from "bun:test";
import { DESCRIPTION } from "./index";

describe("@bi/worktree", () => {
  test("声明包职责", () => {
    expect(typeof DESCRIPTION).toBe("string");
    expect(DESCRIPTION.length).toBeGreaterThan(0);
  });
});
