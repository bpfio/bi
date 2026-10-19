/**
 * file-completion 纯函数层测试（零 TTY 可测）。
 * 覆盖：路径前缀补全、@ 附件补全、目录 vs 文件后缀、fuzzy 排名序、
 * Tab 唯一 / 多候选 / 无候选。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyFileCompletion,
  commonPrefix,
  completeFileAtCursor,
  fuzzyScore,
  getFileSuggestions,
  rankSuggestions,
  type FileCompletionItem,
} from "./file-completion";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bi-file-completion-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "src", "index.ts"), "");
  writeFileSync(join(root, "main.ts"), "");
  writeFileSync(join(root, "note.txt"), "");
  writeFileSync(join(root, "cmd_alpha.ts"), "");
  writeFileSync(join(root, "cmd_beta.ts"), "");
  writeFileSync(join(root, "cmd_gamma.ts"), "");
  writeFileSync(join(root, "sub", "inner.ts"), "");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("路径前缀补全", () => {
  test("无分隔符前缀枚举同名条目（目录排前）", () => {
    const items = getFileSuggestions("src", root);
    expect(items.length).toBe(1);
    expect(items[0]!.label).toBe("src/");
    expect(items[0]!.isDirectory).toBe(true);
  });

  test("尾斜杠前缀枚举目录下内容", () => {
    const items = getFileSuggestions("src/", root);
    const names = items.map((i) => i.label);
    expect(names).toContain("index.ts");
  });

  test("含路径段前缀（src/in）命中 index.ts", () => {
    const items = getFileSuggestions("src/in", root);
    const names = items.map((i) => i.label);
    expect(names).toContain("index.ts");
  });

  test("普通文件名前缀命中", () => {
    const items = getFileSuggestions("main", root);
    expect(items.some((i) => i.label === "main.ts")).toBe(true);
  });
});

describe("@ 附件补全", () => {
  test("@ 列出全部候选且值带 @ 前缀", () => {
    const items = getFileSuggestions("@", root);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.value.startsWith("@")).toBe(true);
  });

  test("@ 前缀收敛（@mai → @main.ts）", () => {
    const items = getFileSuggestions("@mai", root);
    expect(items.some((i) => i.value === "@main.ts")).toBe(true);
  });

  test("completeFileAtCursor 多候选 common 且候选带 @ 前缀", () => {
    const res = completeFileAtCursor("@", 1, root);
    expect(res.kind).toBe("common");
    if (res.kind === "common") {
      expect(res.items.length).toBeGreaterThan(1);
      for (const it of res.items) expect(it.value.startsWith("@")).toBe(true);
    }
  });
});

describe("目录 vs 文件后缀", () => {
  test("目录唯一候选补 '/'（不补空格）", () => {
    const res = completeFileAtCursor("sub", 3, root);
    expect(res.kind).toBe("full");
    if (res.kind === "full") {
      expect(res.draft.endsWith("sub/")).toBe(true);
      expect(res.draft.endsWith("sub/ ")).toBe(false);
    }
  });

  test("文件唯一候选补 ' '（尾随空格）", () => {
    const res = completeFileAtCursor("note", 4, root);
    expect(res.kind).toBe("full");
    if (res.kind === "full") {
      expect(res.draft.endsWith("note.txt ")).toBe(true);
    }
  });

  test("applyFileCompletion 直接光标数学：目录 '/'、文件 ' '", () => {
    const dir: FileCompletionItem = { value: "src/", label: "src/", isDirectory: true };
    const file: FileCompletionItem = { value: "main.ts", label: "main.ts", isDirectory: false };
    expect(applyFileCompletion("sr", 2, dir).draft).toBe("src/");
    expect(applyFileCompletion("ma", 2, file).draft).toBe("main.ts ");
  });
});

describe("fuzzy 排名序", () => {
  test("fuzzyScore：不可匹配返回 Infinity", () => {
    expect(fuzzyScore("q", "main.ts")).toBe(Number.POSITIVE_INFINITY);
    expect(fuzzyScore("xyz", "ab")).toBe(Number.POSITIVE_INFINITY);
  });

  test("fuzzyScore：exact 优于子序列", () => {
    expect(fuzzyScore("abc", "abc")).toBeLessThan(fuzzyScore("abc", "a-b-c"));
  });

  test("rankSuggestions 把前缀命中排在纯子序列命中之前", () => {
    const items: FileCompletionItem[] = [
      { value: "x/ab.md", label: "ab.md", isDirectory: false },
      { value: "x/axb.md", label: "axb.md", isDirectory: false },
    ];
    const ranked = rankSuggestions(items, "ab");
    expect(ranked[0]!.label).toBe("ab.md");
    expect(ranked[1]!.label).toBe("axb.md");
  });

  test("completeFileAtCursor 多候选按确定序（cmd_alpha 在前）", () => {
    const res = completeFileAtCursor("c", 1, root);
    expect(res.kind).toBe("common");
    if (res.kind === "common") {
      expect(res.items[0]!.label).toBe("cmd_alpha.ts");
    }
  });
});

describe("Tab 唯一 / 多候选 / 无候选", () => {
  test("唯一候选 → full", () => {
    const res = completeFileAtCursor("sub", 3, root);
    expect(res.kind).toBe("full");
  });

  test("多候选 → common（补首公共前缀 cmd_）+ 候选集", () => {
    const res = completeFileAtCursor("c", 1, root);
    expect(res.kind).toBe("common");
    if (res.kind === "common") {
      expect(res.draft).toBe("cmd_");
      expect(res.items.length).toBeGreaterThan(1);
    }
  });

  test("无候选 → none（前缀不匹配）", () => {
    const res = completeFileAtCursor("zzz", 3, root);
    expect(res.kind).toBe("none");
  });

  test("无候选 → none（目录不存在）", () => {
    const res = completeFileAtCursor("no_such_dir/", 12, root);
    expect(res.kind).toBe("none");
  });

  test("空草稿 / 斜杠草稿 → none（不抢候选菜单地盘）", () => {
    expect(completeFileAtCursor("", 0, root).kind).toBe("none");
    expect(completeFileAtCursor("/copy", 5, root).kind).toBe("none");
  });
});

describe("commonPrefix 工具", () => {
  test("多值首公共前缀", () => {
    expect(commonPrefix(["cmd_alpha.ts", "cmd_beta.ts", "cmd_gamma.ts"])).toBe("cmd_");
    expect(commonPrefix(["a", "b"])).toBe("");
    expect(commonPrefix([])).toBe("");
  });
});
