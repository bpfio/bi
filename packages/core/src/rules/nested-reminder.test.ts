/**
 * BI-05.3 · ReminderService 测试（纯内存，零 IO）。
 *
 * 覆盖：一次性消费（reminderBlock 后清空）、重复触碰去重、LRU 上限
 * （默认 50 与自定义容量）、再触碰刷新 LRU 新旧序、触碰文件路径归约
 * 父目录、多文件类型分组、消费后可重新提醒、无命中返回 null。
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_REMINDER_CAPACITY, ReminderService } from "./nested-reminder";
import { makeMemFs } from "./testing-memfs";

function fsWithAgents(n: number, root = "/r"): ReturnType<typeof makeMemFs> {
  const files: Record<string, string> = {};
  for (let i = 1; i <= n; i++) {
    files[`${root}/d${String(i).padStart(2, "0")}/AGENTS.md`] = "";
  }
  return makeMemFs({ files });
}

describe("BI-05.3 ReminderService：一次性消费与去重", () => {
  test("触碰含嵌套规则的目录 → 提醒块非空且含目录与文件名；再次取用为 null", () => {
    const fs = makeMemFs({ files: { "/r/sub/AGENTS.md": "" } });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs });
    expect(svc.reminderBlock()).toBeNull(); // 未触碰前无提醒
    svc.onToolPaths(["/r/sub/src"]);
    const block = svc.reminderBlock();
    expect(block).toContain("以下目录存在嵌套规则文件未读：");
    expect(block).toContain("/r/sub");
    expect(block).toContain("AGENTS.md");
    expect(svc.reminderBlock()).toBeNull(); // 一次性消费后清空
  });

  test("重复 onToolPaths 同路径去重：size 不随重复触碰增长", () => {
    const fs = makeMemFs({ files: { "/r/sub/BI.md": "" } });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs });
    svc.onToolPaths(["/r/sub"]);
    expect(svc.size).toBe(1);
    svc.onToolPaths(["/r/sub", "/r/sub/deep"]);
    expect(svc.size).toBe(1);
  });

  test("一次性消费后再次触碰 → 可重新提醒", () => {
    const fs = makeMemFs({ files: { "/r/sub/AGENTS.md": "" } });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs });
    svc.onToolPaths(["/r/sub"]);
    expect(svc.reminderBlock()).not.toBeNull();
    svc.onToolPaths(["/r/sub"]);
    const again = svc.reminderBlock();
    expect(again).not.toBeNull();
    expect(again).toContain("/r/sub");
  });

  test("触碰文件路径（非目录）→ 归约到父目录探测", () => {
    const fs = makeMemFs({
      files: { "/r/sub/AGENTS.md": "", "/r/sub/main.ts": "console.log(1)" },
    });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs });
    svc.onToolPaths(["/r/sub/main.ts"]);
    const block = svc.reminderBlock();
    expect(block).toContain("/r/sub");
    expect(block).toContain("AGENTS.md");
  });

  test("多文件类型按目录分组展示，文件名确定性排序", () => {
    const fs = makeMemFs({
      files: {
        "/r/pkg/AGENTS.md": "",
        "/r/pkg/BI.md": "",
        "/r/pkg/.cursorrules": "",
      },
    });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs });
    svc.onToolPaths(["/r/pkg"]);
    const block = svc.reminderBlock() ?? "";
    expect(block).toContain("/r/pkg：.cursorrules、AGENTS.md、BI.md");
  });

  test("无命中触碰（子树外/无规则文件）→ reminderBlock 仍为 null", () => {
    const fs = makeMemFs({ files: { "/out/AGENTS.md": "" } });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs });
    svc.onToolPaths(["/out", "/r/plain"]);
    expect(svc.reminderBlock()).toBeNull();
  });
});

describe("BI-05.3 ReminderService：LRU 上限", () => {
  test(`默认容量 ${DEFAULT_REMINDER_CAPACITY}：第 51 个新命中挤掉最旧`, () => {
    const fs = fsWithAgents(51);
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs });
    const dirs = Array.from({ length: 51 }, (_, i) => `/r/d${String(i + 1).padStart(2, "0")}`);
    svc.onToolPaths(dirs);
    expect(svc.size).toBe(DEFAULT_REMINDER_CAPACITY);
    const block = svc.reminderBlock() ?? "";
    expect(block).not.toContain("/r/d01"); // 最旧被挤掉
    expect(block).toContain("/r/d51"); // 最新保留
  });

  test("自定义容量 capacity:2：超限挤掉最旧", () => {
    const fs = makeMemFs({
      files: {
        "/r/a/AGENTS.md": "",
        "/r/b/BI.md": "",
        "/r/c/.cursorrules": "",
      },
    });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs, capacity: 2 });
    svc.onToolPaths(["/r/a", "/r/b", "/r/c"]);
    expect(svc.size).toBe(2);
    const block = svc.reminderBlock() ?? "";
    expect(block).not.toContain("/r/a");
    expect(block).toContain("/r/b");
    expect(block).toContain("/r/c");
  });

  test("已在待提醒集的路径再次触碰刷新新旧序：不被后续挤掉", () => {
    const fs = makeMemFs({
      files: {
        "/r/a/AGENTS.md": "",
        "/r/b/AGENTS.md": "",
        "/r/c/AGENTS.md": "",
      },
    });
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs, capacity: 2 });
    svc.onToolPaths(["/r/a", "/r/b"]);
    svc.onToolPaths(["/r/a"]); // 刷新 a 为最新
    svc.onToolPaths(["/r/c"]); // 挤掉最旧的 b
    const block = svc.reminderBlock() ?? "";
    expect(block).toContain("/r/a");
    expect(block).not.toContain("/r/b");
    expect(block).toContain("/r/c");
  });

  test("消费后集合清空：size 归零，容量重新可用", () => {
    const fs = fsWithAgents(3);
    const svc = new ReminderService({ knownRoot: "/r", injectFs: fs, capacity: 2 });
    svc.onToolPaths(["/r/d01", "/r/d02", "/r/d03"]);
    expect(svc.size).toBe(2);
    svc.reminderBlock();
    expect(svc.size).toBe(0);
    svc.onToolPaths(["/r/d01"]);
    expect(svc.size).toBe(1);
  });
});
