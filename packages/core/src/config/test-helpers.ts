/**
 * 配置域测试公共工具：临时目录注入与异步轮询。
 * 全部测试只读写临时目录，严禁触碰真实 ~/.bi。
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempDirs {
  home: string;
  work: string;
  cleanup(): Promise<void>;
}

/** 创建一对临时 home / work 目录（测试注入用）。 */
export async function createTempDirs(prefix: string): Promise<TempDirs> {
  const home = await mkdtemp(join(tmpdir(), `${prefix}-home-`));
  const work = await mkdtemp(join(tmpdir(), `${prefix}-work-`));
  return {
    home,
    work,
    async cleanup(): Promise<void> {
      await rm(home, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
    },
  };
}

/** 预创建 ~/.bi 与 <work>/.bi 目录（watch 需要目录先存在）。 */
export async function ensureBiDirs(home: string, work: string): Promise<void> {
  await mkdir(join(home, ".bi"), { recursive: true });
  await mkdir(join(work, ".bi"), { recursive: true });
}

/** 写入 ~/.bi 下的配置文件（config.toml / tui.toml）。 */
export async function writeHomeConfig(home: string, fileName: string, content: string): Promise<void> {
  await mkdir(join(home, ".bi"), { recursive: true });
  await writeFile(join(home, ".bi", fileName), content, "utf8");
}

/** 写入 <work>/.bi/local.toml。 */
export async function writeLocalConfig(work: string, content: string): Promise<void> {
  await mkdir(join(work, ".bi"), { recursive: true });
  await writeFile(join(work, ".bi", "local.toml"), content, "utf8");
}

/** 轮询等待条件成立；超时抛错（避免测试悬挂）。 */
export async function waitFor(condition: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = condition();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
