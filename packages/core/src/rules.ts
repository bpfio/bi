/**
 * BI-05 —— BI.md 项目长期记忆自适应注入。
 *
 * 职责：
 *  1. findRuleFile：自 startDir 向上递归检索 BI.md / .bi/rules.md（根盘止步，fs 可注入）。
 *  2. loadRules：读文件并按 markdown 二级标题切节为 RuleSection[]。
 *  3. buildSystemPromptSection：构建静态注入块（前缀缓存友好：确定性排序、
 *     无时间戳、总长截断 8K 字符防膨胀）。
 *  4. RulesInjector：sectionFor(cwd) 组合上述三步，缓存 by path+mtime。
 *
 * 设计裁定：
 * - 同一目录内 BI.md 优先于 .bi/rules.md；更近目录整体优先于更远目录（最近优先）。
 * - 解析只切 markdown 二级标题（`## `），一级标题与前言忽略，三级及更深标题
 *   归入上一节正文；``` 围栏内的 `##` 行不切节。
 * - 注入块确定性：按 title 码点排序、同 title 去重（保留首现）、无时间戳，
 *   相同输入两次调用逐字节相等。
 * - 文件系统全部经 FsLike 注入（缺省收敛 node:fs），测试用内存实现零 IO。
 */
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

/** 最小文件系统接口（结构兼容 node:fs，测试用内存实现注入）。 */
export interface FsLike {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  appendFileSync(path: string, data: string): void;
  statSync(path: string): { mtimeMs: number; isFile(): boolean };
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  unlinkSync(path: string): void;
}

/** 缺省真实文件系统（node:fs 结构收敛到 FsLike）。 */
export const DEFAULT_FS: FsLike = nodeFs as unknown as FsLike;

/** 候选规则文件名（同一目录内按数组顺序判定优先序）。 */
export const RULE_FILE_CANDIDATES = ["BI.md", ".bi/rules.md"] as const;

/** 命中的规则文件：path=规则文件路径，root=其所在目录（即该项目根）。 */
export interface RuleFileRef {
  path: string;
  root: string;
}

export interface FindRuleFileOptions {
  fs?: FsLike;
  /** 可选上界：检索只在该目录（含）以内进行，不再向上越过。 */
  stopAt?: string;
}

/** 一个规则节：markdown 二级标题为 title，其后正文（修剪后）为 body。 */
export interface RuleSection {
  title: string;
  body: string;
}

export interface LoadRulesOptions {
  fs?: FsLike;
}

export interface BuildSectionOptions {
  /** 注入块总长上限（字符数），缺省 8192。 */
  maxChars?: number;
}

/** 注入块默认总长上限：8K 字符。 */
export const MAX_PROMPT_SECTION_CHARS = 8192;

/** 注入块超长时的确定性截断尾缀。 */
const TRUNCATION_SUFFIX = "\n\n…（已截断）";

/** 注入块固定标题（无时间戳，前缀缓存友好）。 */
const SECTION_HEADER = "## BI.md 项目规则（自动注入）";

function fsOf(opts?: { fs?: FsLike }): FsLike {
  return opts?.fs ?? DEFAULT_FS;
}

/** child 与 root 相等，或位于 root 目录树内。 */
function isWithin(child: string, root: string): boolean {
  if (child === root) return true;
  const prefixed = root.endsWith(nodePath.sep) ? root : root + nodePath.sep;
  return child.startsWith(prefixed);
}

/**
 * 自 startDir 逐级向上检索规则文件；同一目录内 BI.md 优先于 .bi/rules.md，
 * 更近的目录整体优先于更远的目录；到达根盘（或 stopAt）止步。
 */
export function findRuleFile(startDir: string, opts?: FindRuleFileOptions): RuleFileRef | null {
  const fs = fsOf(opts);
  const stop = opts?.stopAt !== undefined ? nodePath.resolve(opts.stopAt) : null;
  let dir = nodePath.resolve(startDir);
  while (true) {
    if (stop !== null && !isWithin(dir, stop)) return null;
    for (const name of RULE_FILE_CANDIDATES) {
      const candidate = nodePath.join(dir, name);
      if (fs.existsSync(candidate)) {
        return { path: candidate, root: dir };
      }
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) return null; // 根盘止步
    dir = parent;
  }
}

/**
 * 把 markdown 文本按二级标题切节：`## ` 起新节（title=标题文本，body=其后正文
 * 修剪后）；``` 围栏内的 `##` 行不切节；一级标题/前言忽略；title 为空的节丢弃。
 */
export function parseRuleSections(content: string): RuleSection[] {
  const lines = content.split(/\r?\n/);
  const sections: { title: string; body: string[] }[] = [];
  let current: { title: string; body: string[] } | null = null;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (current !== null) current.body.push(line);
      continue;
    }
    if (!inFence) {
      const heading = /^##[ \t]+(.*)$/.exec(line);
      if (heading !== null) {
        if (current !== null) sections.push(current);
        current = { title: (heading[1] ?? "").trim(), body: [] };
        continue;
      }
    }
    if (current !== null) current.body.push(line);
  }
  if (current !== null) sections.push(current);
  return sections
    .map((s) => ({ title: s.title, body: s.body.join("\n").trim() }))
    .filter((s) => s.title.length > 0);
}

/** 读取规则文件并解析为节列表；读不到（含 IO 异常）返回空数组，不抛错。 */
export function loadRules(path: string, opts?: LoadRulesOptions): RuleSection[] {
  let raw: string;
  try {
    raw = fsOf(opts).readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return parseRuleSections(raw);
}

/**
 * 构建静态注入块：同 title 去重（保留首现）→ 按 title 码点升序 → 渲染为
 * `### title + 正文` 块；无时间戳；总长超 maxChars（缺省 8192）时确定性截断。
 * 相同输入集合（无论次序）两次调用逐字节相等。
 */
export function buildSystemPromptSection(sections: RuleSection[], opts?: BuildSectionOptions): string {
  const maxChars = opts?.maxChars ?? MAX_PROMPT_SECTION_CHARS;
  const byTitle = new Map<string, RuleSection>();
  for (const section of sections) {
    const title = section.title.trim();
    if (title.length === 0 || byTitle.has(title)) continue;
    byTitle.set(title, { title, body: section.body.trim() });
  }
  const ordered = [...byTitle.values()].sort((a, b) =>
    a.title < b.title ? -1 : a.title > b.title ? 1 : 0,
  );
  if (ordered.length === 0) return "";
  const blocks = ordered.map((s) => (s.body.length > 0 ? `### ${s.title}\n${s.body}` : `### ${s.title}`));
  let text = `${SECTION_HEADER}\n\n${blocks.join("\n\n")}`;
  if (text.length > maxChars) {
    const keep = maxChars - TRUNCATION_SUFFIX.length;
    text = keep > 0 ? text.slice(0, keep) + TRUNCATION_SUFFIX : text.slice(0, Math.max(0, maxChars));
  }
  return text;
}

interface InjectorCacheEntry {
  mtimeMs: number;
  text: string;
}

/** 规则注入器：组合 findRuleFile + loadRules + build，按 path+mtime 缓存。 */
export class RulesInjector {
  private readonly fs: FsLike;
  private readonly cache = new Map<string, InjectorCacheEntry>();

  constructor(opts?: { fs?: FsLike }) {
    this.fs = fsOf(opts);
  }

  /** 返回 cwd 对应项目根的注入块；无规则文件（或文件消失）返回 null。 */
  sectionFor(cwd: string): string | null {
    const found = findRuleFile(cwd, { fs: this.fs });
    if (found === null) return null;
    let mtimeMs: number;
    try {
      mtimeMs = this.fs.statSync(found.path).mtimeMs;
    } catch {
      this.cache.delete(found.path);
      return null;
    }
    const hit = this.cache.get(found.path);
    if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.text;
    const text = buildSystemPromptSection(loadRules(found.path, { fs: this.fs }));
    this.cache.set(found.path, { mtimeMs, text });
    return text;
  }
}
