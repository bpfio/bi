/**
 * mount/file-completion —— 文件/路径/@ 自动补全（BI-19.8 快赢提案 B）。
 *
 * 纯函数层（零 TTY 可测）：前缀抽取、readdir 候选枚举、模糊排名、Tab 裁决
 * 与光标数学。吸收机制参考 kimi packages/pi-tui/src/autocomplete.ts
 * (getFileSuggestions / applyCompletion) 与 fuzzy.ts (fuzzyFilter)，bi 独立
 * 实现，不引新依赖（Node/bun readdir 降级路径：纯 readdir，不做 fd fan-out）。
 *
 * Tab 行为（与 BI-25.3 completeDraft 同判据）：
 * - 唯一候选 → 整稿补全（目录补 "/"，文件补 " "）；
 * - 多候选 → 补首公共前缀 + 候选菜单数据（items）；
 * - 无候选 → 保持原样（no-op）。
 *
 * @ 附件候选走同一路径机制（isAt 前缀），目录结尾 "/"、文件结尾补空格。
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** 单条文件补全候选。value 为替换文本（目录结尾 "/"，@ 附件前缀 "@"）。 */
export interface FileCompletionItem {
  readonly value: string;
  readonly label: string;
  readonly isDirectory: boolean;
}

/** Tab 补全裁决结果：无候选 / 唯一整稿 / 多候选补公共前缀并附带候选集。 */
export type FileTabResult =
  | { readonly kind: "none" }
  | { readonly kind: "full"; readonly draft: string; readonly cursor: number }
  | {
      readonly kind: "common";
      readonly draft: string;
      readonly cursor: number;
      readonly items: readonly FileCompletionItem[];
    };

/** 路径分词分隔符（kimi PATH_DELIMITERS 务实子集）。 */
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function expandHomePath(path: string): string {
  if (path.startsWith("~/")) {
    const expanded = join(homedir(), path.slice(2));
    return path.endsWith("/") && !expanded.endsWith("/") ? `${expanded}/` : expanded;
  }
  if (path === "~") return homedir();
  return path;
}

/**
 * 从光标前文本抽取待补全 token（含起止下标，end = 文本长度 = 光标位）。
 * 空格/制表/引号/= 为分隔符；无分隔符则整段为 token。
 */
export function extractToken(text: string): { prefix: string; start: number; end: number } {
  const end = text.length;
  let start = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  return { prefix: text.slice(start, end), start, end };
}

/**
 * 是否像文件/路径/@ 触发前缀（@ 附件、./相对、~/家目录、含 / 的路径段）。
 * 用于 REPL Tab 路由在与历史补全并存时划定属地，避免抢普通历史词前缀。
 */
export function isPathLikePrefix(prefix: string): boolean {
  return prefix.startsWith("@") || prefix.startsWith(".") || prefix.startsWith("~") || prefix.includes("/");
}

/** 由 display 前缀与条目名重建相对/绝对显示路径（端口 kimi 的 relativePath 构造）。 */
function buildRelativePath(displayPrefix: string, name: string): string {
  if (displayPrefix.endsWith("/")) {
    return toDisplayPath(`${displayPrefix}${name}`);
  }
  if (displayPrefix.includes("/") || displayPrefix.includes("\\")) {
    if (displayPrefix.startsWith("~/")) {
      const homeRelativeDir = displayPrefix.slice(2);
      const dir = dirname(homeRelativeDir);
      return `~/${dir === "." ? name : join(dir, name)}`;
    }
    if (displayPrefix.startsWith("/")) {
      const dir = dirname(displayPrefix);
      return dir === "/" ? `/${name}` : `${dir}/${name}`;
    }
    const dir = dirname(displayPrefix);
    let rel = join(dir, name);
    if (displayPrefix.startsWith("./") && !rel.startsWith("./")) rel = `./${rel}`;
    return toDisplayPath(rel);
  }
  if (displayPrefix.startsWith("~")) return `~/${name}`;
  return name;
}

/**
 * 枚举给定前缀下的文件/目录候选（纯 readdir，无 fd fan-out）。
 * 目录排前、其后按标签字典序；读取失败（目录不存在/无权限）返回空数组。
 */
export function getFileSuggestions(prefix: string, basePath: string): FileCompletionItem[] {
  try {
    const isAt = prefix.startsWith("@");
    const rawPrefix = isAt ? prefix.slice(1) : prefix;
    let expandedPrefix = prefix;
    if (expandedPrefix.startsWith("~")) expandedPrefix = expandHomePath(expandedPrefix);

    const isRootPrefix =
      rawPrefix === "" ||
      rawPrefix === "./" ||
      rawPrefix === "../" ||
      rawPrefix === "~" ||
      rawPrefix === "~/" ||
      rawPrefix === "/" ||
      (isAt && rawPrefix === "");

    let searchDir: string;
    let searchPrefix: string;

    if (isRootPrefix) {
      searchDir =
        rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")
          ? expandedPrefix
          : join(basePath, rawPrefix);
      searchPrefix = "";
    } else if (rawPrefix.endsWith("/")) {
      searchDir =
        rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")
          ? expandedPrefix
          : join(basePath, rawPrefix);
      searchPrefix = "";
    } else {
      const dir = dirname(rawPrefix);
      const file = basename(rawPrefix);
      searchDir =
        rawPrefix.startsWith("~") || expandedPrefix.startsWith("/")
          ? dir
          : join(basePath, dir);
      searchPrefix = file;
    }

    const entries = readdirSync(searchDir, { withFileTypes: true });
    const items: FileCompletionItem[] = [];
    for (const entry of entries) {
      if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue;

      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(join(searchDir, entry.name)).isDirectory();
        } catch {
          // 断链/无权限：按文件处理。
        }
      }

      const relativePath = buildRelativePath(rawPrefix, entry.name);
      const pathValue = isDirectory ? `${relativePath}/` : relativePath;
      const value = isAt ? `@${pathValue}` : pathValue;
      items.push({ value, label: `${entry.name}${isDirectory ? "/" : ""}`, isDirectory });
    }

    items.sort((a, b) => {
      const ad = a.isDirectory;
      const bd = b.isDirectory;
      if (ad && !bd) return -1;
      if (!ad && bd) return 1;
      return a.label.localeCompare(b.label);
    });
    return items;
  } catch {
    return [];
  }
}

/**
 * 模糊打分（端口 kimi fuzzy.ts fuzzyMatch 的评分：lowercase 子序列匹配，
 * 连续命中/词边界命中降分、间隔/靠后命中升分；exact 额外降分）。
 * 返回数值：有限值 = 命中（越低越优），Infinity = 不命中。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  if (q.length > t.length) return Number.POSITIVE_INFINITY;

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;
  let consecutive = 0;
  for (let i = 0; i < t.length && queryIndex < q.length; i += 1) {
    if (t[i] === q[queryIndex]) {
      const isBoundary = i === 0 || /[\s\-_./:]/.test(t[i - 1] ?? "");
      if (lastMatchIndex === i - 1) {
        consecutive += 1;
        score -= consecutive * 5;
      } else {
        consecutive = 0;
        if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
      }
      if (isBoundary) score -= 10;
      score += i * 0.1;
      lastMatchIndex = i;
      queryIndex += 1;
    }
  }
  if (queryIndex < q.length) return Number.POSITIVE_INFINITY;
  if (q === t) score -= 100;
  return score;
}

/** 模糊排名：目录优先，其后按 fuzzyScore 升序、标签字典序稳定。空查询原序返回。 */
export function rankSuggestions(
  items: readonly FileCompletionItem[],
  query: string,
): FileCompletionItem[] {
  const q = query.trim();
  if (q === "") return [...items];
  const scored = items
    .map((it) => ({ it, s: fuzzyScore(q, it.label) }))
    .filter((x) => Number.isFinite(x.s));
  scored.sort((a, b) => {
    const ad = a.it.isDirectory;
    const bd = b.it.isDirectory;
    if (ad !== bd) return ad ? -1 : 1;
    if (a.s !== b.s) return a.s - b.s;
    return a.it.label.localeCompare(b.it.label);
  });
  return scored.map((x) => x.it);
}

/** 候选值集合的首公共前缀（UTF-16 码元逐位；收尾高代理回退一位不劈开代理对）。 */
export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0] ?? "";
  for (const value of values) {
    let i = 0;
    const n = Math.min(prefix.length, value.length);
    while (i < n && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === "") return "";
  }
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last !== undefined && last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/** 候选应用后缀：目录补 "/"，文件补 " "（@ 附件同源）。 */
function withSuffix(item: FileCompletionItem): string {
  return item.isDirectory ? ensureTrailingSlash(item.value) : `${item.value} `;
}

/**
 * 单行光标数学：把草稿中光标前 token 替换为候选（含后缀）。返回新草稿与光标。
 * token 由 extractToken 从光标前文本抽取。
 */
export function applyFileCompletion(
  draft: string,
  cursor: number,
  item: FileCompletionItem,
): { draft: string; cursor: number } {
  const { prefix, start, end } = extractToken(draft.slice(0, cursor));
  if (prefix === "") return { draft, cursor };
  const applied = withSuffix(item);
  const newDraft = `${draft.slice(0, start)}${applied}${draft.slice(end)}`;
  return { draft: newDraft, cursor: start + applied.length };
}

/**
 * Tab 补全裁决总入口：抽取光标前 token，枚举候选，按 Tab 行为裁决。
 * - none：无候选 / 空 token / 斜杠草稿（归候选菜单）；
 * - full：唯一候选整稿补全；
 * - common：多候选补首公共前缀（无进益时维持原 token）并附带候选集。
 */
export function completeFileAtCursor(
  draft: string,
  cursor: number,
  basePath: string,
): FileTabResult {
  const text = draft.slice(0, cursor);
  const { prefix, start, end } = extractToken(text);
  if (prefix === "" || prefix.startsWith("/")) return { kind: "none" };

  const suggestions = getFileSuggestions(prefix, basePath);
  if (suggestions.length === 0) return { kind: "none" };

  const filePart = prefix.startsWith("@") ? prefix.slice(1) : prefix;
  const ranked = rankSuggestions(suggestions, basename(filePart));

  if (ranked.length <= 1) {
    const item = ranked[0];
    if (item === undefined) return { kind: "none" };
    const applied = withSuffix(item);
    const newDraft = `${draft.slice(0, start)}${applied}${draft.slice(end)}`;
    return { kind: "full", draft: newDraft, cursor: start + applied.length };
  }

  const common = commonPrefix(ranked.map((it) => it.value));
  const filled = common.startsWith(prefix) && common !== "" ? common : prefix;
  const newDraft = `${draft.slice(0, start)}${filled}${draft.slice(end)}`;
  return { kind: "common", draft: newDraft, cursor: start + filled.length, items: ranked };
}
