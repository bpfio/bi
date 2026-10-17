/**
 * BI-05.3 · 动态嵌套规则探测器测试（纯内存，零 IO）。
 *
 * 覆盖：自底向上沿途命中、knownRoot 自身排除、攀升止于 knownRoot、
 * 子树外触碰忽略、路径去重、多文件类型、结果确定性排序、空输入。
 */
import { describe, expect, test } from "bun:test";
import { detectNestedRules } from "./nested-rules-detector";
import { makeMemFs } from "./testing-memfs";

describe("BI-05.3 detectNestedRules：自底向上探测", () => {
  test("触碰目录自身命中 AGENTS.md", () => {
    const fs = makeMemFs({ files: { "/r/sub/AGENTS.md": "" } });
    expect(detectNestedRules("/r", ["/r/sub"], fs)).toEqual([
      { dir: "/r/sub", file: "AGENTS.md", path: "/r/sub/AGENTS.md" },
    ]);
  });

  test("自底向上：深层触碰目录沿途两层规则文件全部报告", () => {
    const fs = makeMemFs({
      files: {
        "/r/a/BI.md": "",
        "/r/a/b/AGENTS.md": "",
      },
    });
    const hits = detectNestedRules("/r", ["/r/a/b/c"], fs);
    expect(hits.map((h) => h.path)).toEqual(["/r/a/BI.md", "/r/a/b/AGENTS.md"]);
  });

  test("knownRoot 自身排除：根上的 BI.md 已注入不报，子目录规则照报", () => {
    const fs = makeMemFs({
      files: {
        "/r/BI.md": "",
        "/r/sub/BI.md": "",
      },
    });
    const hits = detectNestedRules("/r", ["/r/sub"], fs);
    expect(hits.map((h) => h.path)).toEqual(["/r/sub/BI.md"]);
  });

  test("攀升止于 knownRoot：knownRoot 之上的规则文件不可见", () => {
    const fs = makeMemFs({
      files: {
        "/r/sub/AGENTS.md": "",
        "/OUTSIDE/BI.md": "",
      },
    });
    // 触碰点在 knownRoot 内：只报内层；即便 /OUTSIDE 与 /r 同盘也不可达
    expect(detectNestedRules("/r", ["/r/sub"], fs).map((h) => h.path)).toEqual(["/r/sub/AGENTS.md"]);
  });

  test("knownRoot 子树外的触碰目录整体忽略", () => {
    const fs = makeMemFs({
      files: {
        "/elsewhere/AGENTS.md": "",
        "/r/keep.txt": "",
      },
    });
    expect(detectNestedRules("/r", ["/elsewhere", "/elsewhere/deep"], fs)).toEqual([]);
  });

  test("去重：兄弟触碰目录共享的祖先规则文件只报一次", () => {
    const fs = makeMemFs({
      files: {
        "/r/shared/AGENTS.md": "",
        "/r/shared/x/keep": "",
        "/r/shared/y/keep": "",
      },
      dirs: ["/r/shared/x", "/r/shared/y"],
    });
    const hits = detectNestedRules("/r", ["/r/shared/x", "/r/shared/y"], fs);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.path).toBe("/r/shared/AGENTS.md");
  });

  test("多文件类型：同目录 AGENTS.md + BI.md + .cursorrules 全部命中", () => {
    const fs = makeMemFs({
      files: {
        "/r/pkg/AGENTS.md": "",
        "/r/pkg/BI.md": "",
        "/r/pkg/.cursorrules": "",
      },
    });
    const hits = detectNestedRules("/r", ["/r/pkg/src"], fs);
    expect(hits.map((h) => h.file)).toEqual([".cursorrules", "AGENTS.md", "BI.md"]);
    expect(hits.every((h) => h.dir === "/r/pkg")).toBe(true);
  });

  test("确定性：结果按 path 码点排序，与触碰顺序无关", () => {
    const fs = makeMemFs({
      files: {
        "/r/b/AGENTS.md": "",
        "/r/a/BI.md": "",
      },
    });
    const one = detectNestedRules("/r", ["/r/b/x", "/r/a/x"], fs);
    const two = detectNestedRules("/r", ["/r/a/x", "/r/b/x"], fs);
    expect(one.map((h) => h.path)).toEqual(["/r/a/BI.md", "/r/b/AGENTS.md"]);
    expect(one).toEqual(two);
  });

  test("空触碰列表 / 无规则文件 → 空结果", () => {
    const fs = makeMemFs({ files: { "/r/keep": "" } });
    expect(detectNestedRules("/r", [], fs)).toEqual([]);
    expect(detectNestedRules("/r", ["/r"], fs)).toEqual([]);
  });

  test("触碰点即 knownRoot：不探测（自身已注入，无更深层可爬）", () => {
    const fs = makeMemFs({ files: { "/r/AGENTS.md": "" } });
    expect(detectNestedRules("/r", ["/r"], fs)).toEqual([]);
  });
});
