import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type AtomicWriteData = string | Uint8Array;

/**
 * 原子写文件：先在同目录写临时文件（含 fsync 落盘），再 rename 原子替换目标。
 * 任何失败路径都不残留临时文件，目标文件保持旧内容不变。
 */
export async function atomicWriteFile(path: string, data: AtomicWriteData): Promise<void> {
  const tmpPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(tmpPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(tmpPath, path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}
