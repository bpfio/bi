/**
 * BI-17 — 官方 Marketplace（索引 + 安装 + 已装列表）
 *
 * 纯文件操作：读 `marketplace.json` 建索引、`fs.cp` 递归复制安装、
 * 扫描安装根列出已装插件。不执行任何代码、不 spawn。
 *
 * marketplace.json 形态（公开文档常识，版本假设同 loader.ts）：
 *   { "plugins": [ { "name": "...", "source": "./relative/path" } ] }
 *
 * 安全语义：install 只做声明目录的递归复制；复制进来的插件要被加载时，
 * 仍走 loader.ts 声明层 → BI-13 装配层 → BI-06.5 执行门禁的三层分工。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { probePluginManifest, type PluginProtocol } from './loader';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface MarketplaceEntry {
  name: string;
  /** marketplace.json 中的原始相对路径。 */
  source: string;
  /** 相对 marketplace 目录解析后的绝对路径。 */
  resolvedPath: string;
}

export interface MarketplaceIndex {
  dir: string;
  file: string;
  entries: MarketplaceEntry[];
  /** 形态不合法被跳过的条目问题清单（name/source 缺失、重复 name 等）。 */
  problems: string[];
}

export type InstallResult =
  | { ok: true; name: string; dest: string }
  | { ok: false; code: 'not-indexed'; name: string }
  | { ok: false; code: 'not-in-index'; name: string }
  | { ok: false; code: 'source-missing'; name: string; src: string }
  | { ok: false; code: 'already-installed'; name: string; dest: string };

export interface InstalledEntry {
  name: string;
  dir: string;
  protocol: PluginProtocol | 'unknown';
}

/** 结构化 marketplace 错误（索引文件缺失/畸形等）。 */
export class MarketplaceError extends Error {
  readonly code: 'marketplace-dir-not-found' | 'marketplace-malformed';
  readonly dir: string;

  constructor(code: MarketplaceError['code'], dir: string, message: string) {
    super(`[${code}] ${message} (dir: ${dir})`);
    this.name = 'MarketplaceError';
    this.code = code;
    this.dir = dir;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Marketplace
// ---------------------------------------------------------------------------

export class Marketplace {
  /** 最近一次 index() 的结果；install() 依赖它。 */
  private currentIndex: MarketplaceIndex | null = null;

  /** 扫描 marketplace 目录的 marketplace.json → 目录索引。 */
  async index(dir: string): Promise<MarketplaceIndex> {
    const absDir = path.resolve(dir);
    if (!(await dirExists(absDir))) {
      throw new MarketplaceError('marketplace-dir-not-found', absDir, 'marketplace 目录不存在');
    }
    const file = path.join(absDir, 'marketplace.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      throw new MarketplaceError(
        'marketplace-malformed',
        absDir,
        `marketplace.json 读取或 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!isPlainObject(raw) || !Array.isArray(raw['plugins'])) {
      throw new MarketplaceError(
        'marketplace-malformed',
        absDir,
        'marketplace.json 必须是 { plugins: [{ name, source }] } 形态',
      );
    }

    const entries: MarketplaceEntry[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    const list = raw['plugins'] as unknown[];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!isPlainObject(item)) {
        problems.push(`plugins[${i}]: 必须是 { name, source } 对象`);
        continue;
      }
      const name = item['name'];
      const source = item['source'];
      if (typeof name !== 'string' || name.trim() === '' || typeof source !== 'string' || source.trim() === '') {
        problems.push(`plugins[${i}]: 缺少非空 name 或 source`);
        continue;
      }
      if (seen.has(name)) {
        problems.push(`plugins[${i}]: 重复 name '${name}'，后者忽略`);
        continue;
      }
      seen.add(name);
      entries.push({ name, source, resolvedPath: path.resolve(absDir, source) });
    }
    entries.sort(byName);

    const idx: MarketplaceIndex = { dir: absDir, file, entries, problems };
    this.currentIndex = idx;
    return idx;
  }

  /**
   * 从索引复制插件目录到目标（fs.cp 递归）。目标已存在同名目录
   * → already-installed 结构化结果（不覆盖、不抛异常）。
   */
  async install(name: string, into: string): Promise<InstallResult> {
    const idx = this.currentIndex;
    if (!idx) return { ok: false, code: 'not-indexed', name };

    const entry = idx.entries.find((e) => e.name === name);
    if (!entry) return { ok: false, code: 'not-in-index', name };

    const src = entry.resolvedPath;
    if (!(await pathExists(src))) {
      return { ok: false, code: 'source-missing', name, src };
    }

    const absInto = path.resolve(into);
    const dest = path.join(absInto, name);
    if (await pathExists(dest)) {
      return { ok: false, code: 'already-installed', name, dest };
    }

    await fs.mkdir(absInto, { recursive: true });
    await fs.cp(src, dest, { recursive: true });
    return { ok: true, name, dest };
  }

  /**
   * 扫描安装根的一级子目录，列出可识别的已装插件（双协议探测命中即算）。
   * 根不存在 → 空数组；清单畸形的子目录回退用目录名，仍列出。
   */
  async listInstalled(root: string): Promise<InstalledEntry[]> {
    const absRoot = path.resolve(root);
    if (!(await dirExists(absRoot))) return [];

    const out: InstalledEntry[] = [];
    const dirents = (await fs.readdir(absRoot, { withFileTypes: true })).sort(byName);
    for (const dent of dirents) {
      if (!dent.isDirectory()) continue;
      const dir = path.join(absRoot, dent.name);
      const probe = await probePluginManifest(dir);
      if (!probe) continue;

      let name = dent.name;
      try {
        const raw: unknown = JSON.parse(await fs.readFile(probe.file, 'utf8'));
        const rawName = isPlainObject(raw) ? raw['name'] : undefined;
        if (typeof rawName === 'string' && rawName.trim() !== '') name = rawName;
      } catch {
        // 清单畸形：回退目录名
      }
      out.push({ name, dir, protocol: probe.protocol });
    }
    return out;
  }
}
