/**
 * 测试专用内存文件系统（零 IO、零外部依赖）。
 *
 * - 路径为绝对路径键；写入自动补齐父目录存在性（仅 existsSync 语义）。
 * - mtime 计数器：初值 startMtime，每次 write/append/unlink 自增 1，
 *   供 RulesInjector 等 by-mtime 缓存的命中/失效断言。
 * - writeFileSync 支持 flag:"wx"（O_EXCL 语义：已存在抛 EEXIST），
 *   供 .consolidate-lock 原子创建等场景使用。
 */
import type { FsLike } from "../rules";

export interface MemFsOptions {
  /** 初始文件树：绝对路径 → 文本内容。 */
  files?: Record<string, string>;
  /** 额外初始目录集合。 */
  dirs?: readonly string[];
  /** mtime 基准（缺省 100）。 */
  startMtime?: number;
}

export interface MemFs extends FsLike {
  /** 直接读取内存文件内容（不存在返回 undefined），供测试断言。 */
  peek(path: string): string | undefined;
  /** 查询某路径当前 mtime。 */
  mtimeOf(path: string): number;
  /** readFileSync 调用计数（缓存命中断言用）。 */
  readonly reads: { count: number };
}

function errnoError(code: string, path: string): Error {
  const err = new Error(`${code}: ${path}`) as Error & { code?: string };
  err.code = code;
  return err;
}

export function makeMemFs(opts: MemFsOptions = {}): MemFs {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const dirs = new Set<string>(opts.dirs ?? []);
  const mtimes = new Map<string, number>();
  let clock = opts.startMtime ?? 100;

  const normalizeDir = (p: string): string => (p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p);
  const trackParents = (p: string): void => {
    const parts = normalizeDir(p).split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) dirs.add(`/${parts.slice(0, i).join("/")}`);
  };
  for (const [p] of files) {
    mtimes.set(p, clock);
    trackParents(p);
  }
  for (const d of dirs) trackParents(d);

  const mem: MemFs = {
    reads: { count: 0 },
    existsSync: (p) => files.has(p) || dirs.has(normalizeDir(p)),
    readFileSync: (p) => {
      mem.reads.count += 1;
      const content = files.get(p);
      if (content === undefined) throw errnoError("ENOENT", p);
      return content;
    },
    writeFileSync: (p, data, options) => {
      if (options?.flag === "wx" && files.has(p)) throw errnoError("EEXIST", p);
      files.set(p, data);
      trackParents(p);
      clock += 1;
      mtimes.set(p, clock);
    },
    appendFileSync: (p, data) => {
      files.set(p, (files.get(p) ?? "") + data);
      trackParents(p);
      clock += 1;
      mtimes.set(p, clock);
    },
    statSync: (p) => {
      const mtime = mtimes.get(p);
      if (mtime === undefined && !files.has(p) && !dirs.has(normalizeDir(p))) throw errnoError("ENOENT", p);
      return {
        mtimeMs: mtime ?? clock,
        isFile: () => files.has(p),
      };
    },
    mkdirSync: (p, options) => {
      const target = normalizeDir(p);
      if (options?.recursive) trackParents(target);
      dirs.add(target);
    },
    unlinkSync: (p) => {
      if (!files.has(p)) throw errnoError("ENOENT", p);
      files.delete(p);
      clock += 1;
      mtimes.set(p, clock);
    },
    peek: (p) => files.get(p),
    mtimeOf: (p) => mtimes.get(p) ?? 0,
  };
  return mem;
}
