/**
 * mount/candidate-menu —— BI-27.4 候选与命令菜单验收（纯状态机，全离线）。
 *
 * 覆盖：
 * 1. builtinSlashCandidates：name 不含前导 "/"（与 core SlashCommandSurfaceEntry
 *    同构）、描述非空、name 唯一；
 * 2. filterSlashCandidates：前缀命中优先（原序）、子序列模糊命中（原序）、
 *    合并去重、MAX_ITEMS 截断、空 query 全集；
 * 3. CandidateMenu 状态机：sync 开合（斜杠草稿开、含空白/非斜杠关）、过滤
 *    刷新、moveUp/moveDown 双端钳制、accept() 回吐 "/name "、dismiss 关闭、
 *    自定义 provider 接线（core slashCommandSurface 产物形态）；
 * 4. completeNonSlash：provider 候选名前缀延伸补全（唯一/共同前缀/无进益
 *    no-op/代理对不劈开）；斜杠草稿与空草稿恒 undefined（归菜单/不猜）；
 * 5. lines(cols)：`/name  描述` 对齐 + 选中行 ❯ 标记 + 超宽截断 + 不可见空。
 */
import { describe, expect, test } from "bun:test";

import { textWidth } from "../components/cjk-width";
import {
  builtinSlashCandidates,
  CANDIDATE_MENU_MAX_ITEMS,
  CandidateMenu,
  filterSlashCandidates,
} from "./candidate-menu";
import type { Candidate, CandidatesProvider } from "./candidate-menu";

describe("BI-27.4 · builtinSlashCandidates 与过滤", () => {
  test("内置候选合约：name 无前导 /、描述非空、name 唯一", () => {
    expect(builtinSlashCandidates.length).toBeGreaterThan(0);
    const names = builtinSlashCandidates.map((c) => c.name);
    for (const name of names) {
      expect(name.startsWith("/")).toBe(false); // 与 core SlashCommandSurfaceEntry 同构
      expect(name.length).toBeGreaterThan(0);
    }
    for (const candidate of builtinSlashCandidates) {
      expect(candidate.description.length).toBeGreaterThan(0);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test("filterSlashCandidates：前缀优先原序；模糊子序列补位；去重", () => {
    // "re" 前缀命中 reload / reload-tui（builtin 原序）
    const re = filterSlashCandidates("/re", builtinSlashCandidates);
    expect(re.map((c) => c.name)).toEqual(["reload", "reload-tui"]);
    // 模糊命中："cf" 无前缀命中 → 子序列 c…f 命中 config
    const fuzzy = filterSlashCandidates("/cf", [{ name: "copy", description: "" }, { name: "config", description: "" }]);
    expect(fuzzy.map((c) => c.name)).toEqual(["config"]);
    // 前缀与模糊混合：前缀排前
    const mixed = filterSlashCandidates("/re", [
      { name: "render", description: "" },
      { name: "reload-tui", description: "" },
      { name: "rerun", description: "" },
    ]);
    expect(mixed.map((c) => c.name)).toEqual(["render", "reload-tui", "rerun"]);
    // 去重：provider 重复回吐同名候选不重复展示
    const dedup = filterSlashCandidates("/", [
      { name: "help", description: "a" },
      { name: "help", description: "b" },
    ]);
    expect(dedup).toHaveLength(1);
  });

  test("filterSlashCandidates：空 query 全集；MAX_ITEMS 截断", () => {
    const all = filterSlashCandidates("/", builtinSlashCandidates);
    expect(all).toEqual(builtinSlashCandidates.slice(0, CANDIDATE_MENU_MAX_ITEMS));
    const many: Candidate[] = Array.from({ length: 12 }, (_, i) => ({ name: `cmd${i}`, description: "" }));
    expect(filterSlashCandidates("/", many)).toHaveLength(CANDIDATE_MENU_MAX_ITEMS);
    // 大小写不敏感前缀
    const folded = filterSlashCandidates("/RE", builtinSlashCandidates);
    expect(folded.map((c) => c.name)).toEqual(["reload", "reload-tui"]);
  });
});

describe("BI-27.4 · CandidateMenu 状态机", () => {
  test("sync 开合：斜杠草稿开（无候选不开）、含空白关、非斜杠关", () => {
    const menu = new CandidateMenu();
    menu.sync("");
    expect(menu.visible).toBe(false);
    menu.sync("普通草稿");
    expect(menu.visible).toBe(false);
    menu.sync("/");
    expect(menu.visible).toBe(true);
    expect(menu.items.length).toBeGreaterThan(0);
    menu.sync("/re");
    expect(menu.visible).toBe(true);
    expect(menu.items.map((c) => c.name)).toEqual(["reload", "reload-tui"]);
    // 含空白（进入参数阶段）：关闭
    menu.sync("/reload ");
    expect(menu.visible).toBe(false);
    menu.sync("/reload x");
    expect(menu.visible).toBe(false);
  });

  test("无候选的斜杠草稿：不可见（不空开菜单）", () => {
    const menu = new CandidateMenu(() => []);
    menu.sync("/x");
    expect(menu.visible).toBe(false);
    expect(menu.accept()).toBeUndefined();
  });

  test("moveUp/moveDown 双端钳制；sync 复位选择", () => {
    const menu = new CandidateMenu();
    menu.sync("/re"); // 2 项：reload / reload-tui
    expect(menu.selectedIndex).toBe(0);
    menu.moveDown();
    expect(menu.selectedIndex).toBe(1);
    menu.moveDown(); // 底端钳制
    expect(menu.selectedIndex).toBe(1);
    expect(menu.selected?.name).toBe("reload-tui");
    menu.moveUp();
    menu.moveUp(); // 顶端钳制
    expect(menu.selectedIndex).toBe(0);
    // 草稿变化 → 选择复位
    menu.sync("/rel");
    expect(menu.selectedIndex).toBe(0);
  });

  test("accept()：回吐 '/name '（尾随空格）；不可见 undefined", () => {
    const menu = new CandidateMenu();
    menu.sync("/");
    menu.moveDown();
    expect(menu.accept()).toBe("/config ");
    menu.dismiss();
    expect(menu.accept()).toBeUndefined();
  });

  test("dismiss()：关闭并返回关闭前可见性", () => {
    const menu = new CandidateMenu();
    expect(menu.dismiss()).toBe(false); // 本就不可见
    menu.sync("/");
    expect(menu.dismiss()).toBe(true);
    expect(menu.visible).toBe(false);
    expect(menu.items).toHaveLength(0);
  });

  test("自定义 provider 接线：core slashCommandSurface 产物形态直接可用", () => {
    // 与 discoverSlashCommands → slashCommandSurface 的产物同构
    const provider: CandidatesProvider = () => [
      { name: "review-pr", description: "审查当前 PR" },
      { name: "review-doc", description: "审查文档" },
      { name: "deploy", description: "发布" },
    ];
    const menu = new CandidateMenu(provider);
    menu.sync("/review");
    expect(menu.items.map((c) => c.name)).toEqual(["review-pr", "review-doc"]);
    menu.moveDown();
    expect(menu.accept()).toBe("/review-doc ");
  });

  test("completeNonSlash：唯一候选整稿补全；多候选共同前缀；无进益 no-op", () => {
    const provider: CandidatesProvider = (draft) =>
      draft.startsWith("de") ? [{ name: "deploy", description: "" }] : [
        { name: "readx", description: "" },
        { name: "ready", description: "" },
      ];
    const menu = new CandidateMenu(provider);
    expect(menu.completeNonSlash("deploy")).toBeUndefined(); // 等值无进益
    expect(menu.completeNonSlash("de")).toBe("deploy"); // 唯一候选
    expect(menu.completeNonSlash("re")).toBe("read"); // 共同前缀
    expect(menu.completeNonSlash("zzz")).toBeUndefined(); // 无候选
    // 代理对不劈开：🎉 = \uD83C\uDF89
    const emojiMenu = new CandidateMenu(() => [
      { name: "🎉x", description: "" },
      { name: "🎉y", description: "" },
    ]);
    expect(emojiMenu.completeNonSlash("")).toBeUndefined(); // 空草稿不猜
    expect(emojiMenu.completeNonSlash("🎉")).toBeUndefined(); // 等值无进益
  });

  test("completeNonSlash：斜杠草稿恒 undefined（归菜单）；前缀延伸补全语义", () => {
    const menu = new CandidateMenu();
    expect(menu.completeNonSlash("/re")).toBeUndefined();
    // 内置名为斜杠命令："re" 前缀延伸出 ["reload","reload-tui"]，
    // 第一共同前缀 = "reload"（其一为另一的前缀）→ 补全为最短候选名。
    expect(menu.completeNonSlash("re")).toBe("reload");
  });
});

describe("BI-27.4 · CandidateMenu.lines 渲染行", () => {
  test("不可见返回空数组；可见时 `/name  描述` 对齐 + 选中行 ❯ 标记", () => {
    const menu = new CandidateMenu();
    expect(menu.lines(60)).toEqual([]); // 未 sync：不可见
    menu.sync("/re");
    const lines = menu.lines(60);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("/reload");
    expect(lines[0]!.startsWith("❯ /reload")).toBe(true); // 选中行标记
    expect(lines[1]!.startsWith("  /reload-tui")).toBe(true);
    // name 列对齐：两行命令名后的描述起始列一致
    expect(lines[0]!.indexOf("免重启")).toBe(lines[1]!.indexOf("免重启"));
    // 选择移动 → ❯ 标记跟随
    menu.moveDown();
    expect(menu.lines(60)[0]!.startsWith("  /reload")).toBe(true);
    expect(menu.lines(60)[1]!.startsWith("❯ /reload-tui")).toBe(true);
  });

  test("超宽截断：cols 不足时按显示列宽 … 收尾（永不越过 cols）", () => {
    const menu = new CandidateMenu();
    menu.sync("/");
    const wide = menu.lines(30);
    for (const line of wide) {
      expect(textWidth(line)).toBeLessThanOrEqual(30);
    }
    // 极窄：截断仍然成立（1 列内容 + …）
    const narrow = menu.lines(2);
    for (const line of narrow) expect(textWidth(line)).toBeLessThanOrEqual(2);
  });
});
