import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write";

describe("atomicWriteFile", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("正常写入新文件，内容一致", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-atomic-write-"));
    const target = join(dir, "state.json");
    await atomicWriteFile(target, '{"ok":true}');
    expect(await readFile(target, "utf8")).toBe('{"ok":true}');
  });

  test("覆盖写：原内容被原子替换", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-atomic-write-"));
    const target = join(dir, "state.json");
    await atomicWriteFile(target, "old-content");
    await atomicWriteFile(target, "new-content");
    expect(await readFile(target, "utf8")).toBe("new-content");
  });

  test("支持二进制 payload", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-atomic-write-"));
    const target = join(dir, "blob.bin");
    await atomicWriteFile(target, new Uint8Array([0, 1, 2, 254, 255]));
    const bytes = new Uint8Array(await readFile(target));
    expect([...bytes]).toEqual([0, 1, 2, 254, 255]);
  });

  test("成功后目录中不残留临时文件", async () => {
    dir = await mkdtemp(join(tmpdir(), "bi-atomic-write-"));
    const target = join(dir, "state.json");
    await atomicWriteFile(target, "first");
    await atomicWriteFile(target, "second");
    expect(await readdir(dir)).toEqual(["state.json"]);
  });
});
