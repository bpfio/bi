/**
 * BI-08.1 · 超大工具输出磁盘 Spill 溢出隔离（SpillStore）。
 *
 * 职责边界（钉死）：只做"整段文本 → 落盘 → 句柄寻址 → 读回 → 文件级 GC"。
 * 引用生命周期由调用方管理（handle 由调用方持有/丢弃），本模块不做引用
 * 计数；sweep 按文件 mtime 做纯 GC，只碰本目录下 `*.spill` 后缀文件，
 * 绝不越界删改。默认根目录 `~/.bi/spill/`（工单钉死），构造注入可换
 * （测试一律用 tmp 根目录，绝不写真机 home）。
 *
 * 落盘失败上抛（对齐 BI-08 落盘接缝房规：绝不静默吞错、绝不假造路径）。
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";

import { takeCodePoints } from "./tool-result-pruner";

/** 句柄 preview 长度：头 200 字符（码点语义，工单钉死）。 */
export const SPILL_PREVIEW_CHARS = 200;

/** 默认 spill 根目录：`~/.bi/spill/`。 */
export function defaultSpillRoot(): string {
  return join(homedir(), ".bi", "spill");
}

export interface SpillHandle {
  id: string;
  path: string;
  /** UTF-8 字节数。 */
  bytes: number;
  /** 头 200 字符预览（码点安全切片）。 */
  preview: string;
}

export interface SpillStoreOpts {
  /** 注入时钟（sweep 年龄基准）。默认 `Date.now`。 */
  now?: () => number;
}

const SPILL_SUFFIX = ".spill";

export class SpillStore {
  /** 解析后的绝对根目录。 */
  readonly root: string;
  private readonly now: () => number;

  constructor(root: string = defaultSpillRoot(), opts: SpillStoreOpts = {}) {
    this.root = resolve(root);
    this.now = opts.now ?? Date.now;
  }

  /** 落盘整段文本，返回句柄（目录不存在自动递归创建）。 */
  save(text: string): SpillHandle {
    const id = randomUUID();
    mkdirSync(this.root, { recursive: true });
    const path = join(this.root, `${id}${SPILL_SUFFIX}`);
    writeFileSync(path, text, "utf8");
    return {
      id,
      path,
      bytes: Buffer.byteLength(text, "utf8"),
      preview: takeCodePoints(text, SPILL_PREVIEW_CHARS),
    };
  }

  /** 读回句柄指向的完整文本；句柄路径逃逸根目录时拒绝（防路径穿越）。 */
  load(handle: SpillHandle): string {
    const p = resolve(handle.path);
    if (!p.startsWith(this.root + sep)) {
      throw new RangeError(`spill path escapes store root: ${handle.path}`);
    }
    return readFileSync(p, "utf8");
  }

  /**
   * 文件级 GC：删除 mtime 距注入时钟严格超过 `olderThanMs` 的 `*.spill`
   * 文件，返回删除数。年龄恰好等于阈值：保留（严格大于才删）。
   * 根目录不存在 → 无可清理，返回 0。
   */
  sweep(olderThanMs: number): number {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return 0;
    }
    const nowMs = this.now();
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(SPILL_SUFFIX)) continue;
      const full = join(this.root, name);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (nowMs - mtimeMs > olderThanMs) {
        try {
          unlinkSync(full);
          removed++;
        } catch {
          // 并发竞争已被清理：视为未删，不计入。
        }
      }
    }
    return removed;
  }
}
