import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./../../session/manager";
import { transferCommand } from "./transfer";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function makeManager(): Promise<SessionManager> {
  dir = await mkdtemp(join(tmpdir(), "bi-transfer-cli-"));
  return new SessionManager({ rootDir: join(dir, "sessions") });
}

/** 两条目的最小会话，返回 sessionId。 */
async function seedSession(manager: SessionManager): Promise<string> {
  const meta = await manager.createSession({ title: "CLI 会话", cwd: "/tmp/proj" });
  const root = await manager.append(meta.sessionId, null, {
    type: "user",
    payload: { text: "查 /tmp/proj/a.ts" },
  });
  await manager.append(meta.sessionId, root.id, {
    type: "assistant",
    payload: { text: "ok" },
  });
  return meta.sessionId;
}

describe("transferCommand · export --sanitize", () => {
  test("space 传值：返回归档 JSON（meta/entries 齐备且已脱敏）", async () => {
    const manager = await makeManager();
    const sid = await seedSession(manager);
    const result = await transferCommand(manager, ["export", "--sanitize", sid]);
    expect(result.command).toBe("export");
    if (result.command !== "export") return;
    expect(result.sessionId).toBe(sid);
    expect(result.entries).toBe(2);
    const archive = JSON.parse(result.content) as { meta: { sessionId: string }; entries: unknown[] };
    expect(archive.meta.sessionId).toBe(sid);
    expect(archive.entries).toHaveLength(2);
    expect(result.content).not.toContain("/tmp/proj");
  });

  test("等号传值 --sanitize=<id> 等价", async () => {
    const manager = await makeManager();
    const sid = await seedSession(manager);
    const result = await transferCommand(manager, ["export", `--sanitize=${sid}`]);
    expect(result.command).toBe("export");
    if (result.command !== "export") return;
    expect(result.sessionId).toBe(sid);
    expect(result.entries).toBe(2);
  });

  test("--out 落盘：目录自动创建，writtenTo 为绝对路径，文件内容可读回", async () => {
    const manager = await makeManager();
    const sid = await seedSession(manager);
    const outPath = join(dir as string, "nested", "dir", "archive.json");
    const result = await transferCommand(manager, ["export", "--sanitize", sid, "--out", outPath]);
    expect(result.command).toBe("export");
    if (result.command !== "export") return;
    expect(result.writtenTo).toBe(outPath);
    const onDisk = JSON.parse(await readFile(outPath, "utf8")) as { meta: { sessionId: string } };
    expect(onDisk.meta.sessionId).toBe(sid);
  });

  test("缺 --sanitize / 未知旗标 / 缺值 → usage", async () => {
    const manager = await makeManager();
    for (const argv of [
      ["export"],
      ["export", "--sanitize"],
      ["export", "--sanitize", "--out", "x.json"],
      ["export", "--sanitize=a", "--bogus"],
      ["export", "someid"],
    ]) {
      try {
        await transferCommand(manager, argv);
        throw new Error(`应抛 usage: ${JSON.stringify(argv)}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("usage");
      }
    }
  });

  test("会话不存在 → session-missing", async () => {
    const manager = await makeManager();
    try {
      await transferCommand(manager, ["export", "--sanitize", "ghost1"]);
      throw new Error("应抛 session-missing");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("session-missing");
    }
  });
});

describe("transferCommand · import", () => {
  test("读归档文件重建会话：命令回执 + 管理器可读回且拓扑一致", async () => {
    const source = await makeManager();
    const sid = await seedSession(source);
    const exported = await transferCommand(source, ["export", "--sanitize", sid]);
    if (exported.command !== "export") throw new Error("unreachable");
    const archivePath = join(dir as string, "archive.json");
    await writeFile(archivePath, exported.content, "utf8");

    const target = await makeManager();
    const result = await transferCommand(target, ["import", archivePath]);
    expect(result.command).toBe("import");
    if (result.command !== "import") return;
    expect(result.sessionId).toBe(sid);
    expect(result.entries).toBe(2);

    const entries = await target.entries(sid);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.type)).toEqual(["user", "assistant"]);
    expect(entries[0]?.parentId).toBeNull();
    expect(entries[1]?.parentId).toBe(entries[0]?.id);
  });

  test("文件不存在 → file-missing；坏 JSON → invalid-archive；参数个数不符 → usage", async () => {
    const manager = await makeManager();
    try {
      await transferCommand(manager, ["import", join(dir as string, "nope.json")]);
      throw new Error("应抛 file-missing");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("file-missing");
    }
    const badPath = join(dir as string, "bad.json");
    await writeFile(badPath, "{not-json", "utf8");
    try {
      await transferCommand(manager, ["import", badPath]);
      throw new Error("应抛 invalid-archive");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("invalid-archive");
    }
    try {
      await transferCommand(manager, ["import"]);
      throw new Error("应抛 usage");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("usage");
    }
    try {
      await transferCommand(manager, ["import", "a.json", "b.json"]);
      throw new Error("应抛 usage");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("usage");
    }
  });

  test("归档结构非法（entries 非数组）→ invalid-archive 透传", async () => {
    const manager = await makeManager();
    const path = join(dir as string, "struct.json");
    await writeFile(path, JSON.stringify({ meta: { sessionId: "ok2" }, entries: 7 }), "utf8");
    try {
      await transferCommand(manager, ["import", path]);
      throw new Error("应抛 invalid-archive");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("invalid-archive");
    }
  });
});

describe("transferCommand · 派发", () => {
  test("空参数 / 未知子命令 → usage（含用法说明）", async () => {
    const manager = await makeManager();
    for (const argv of [[], ["frobnicate"], ["--help"]]) {
      try {
        await transferCommand(manager, argv);
        throw new Error(`应抛 usage: ${JSON.stringify(argv)}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("usage");
        expect((error as Error).message).toContain("bi export --sanitize");
      }
    }
  });
});
