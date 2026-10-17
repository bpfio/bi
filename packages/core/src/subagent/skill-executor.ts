/**
 * BI-07.9 · 声明式技能注册表（SkillRegistry）。
 *
 * 扫描双技能目录（fs 端口注入）：
 * - 用户级 ~/.bi/skills（默认）；
 * - 工作区 .bi/skills（默认，**同名覆盖用户级**——项目优先）。
 *
 * 每个技能 = 一个目录，含 SKILL.md：
 *
 *   ---
 *   name: review-pr
 *   description: 评审 PR 变更
 *   allowed-tools: Read, Grep, Bash
 *   params:
 *     pr_number:
 *       type: number
 *       required: true
 *       description: PR 编号
 *   ---
 *   （正文 = 注入 prompt 的模板，支持 {{param}} 占位）
 *
 * frontmatter 房规（手写 mini 解析，零外部依赖）：
 * - 首行 `---` 开、独立 `---` 行闭；顶层 `key: value`；
 * - `params:` 开启参数块：2 空格缩进行为参数声明（value 必空），
 *   4+ 空格缩进行为参数属性（type: string|number|boolean；required: true|false；
 *   description: 文本）；未知键忽略（向前兼容）；
 * - allowed-tools 为逗号分隔白名单（**声明透传**：脚本执行资格由装配层
 *   经 BI-06.5 权限门执行，本卡只做声明校验 + 正文展开，不执行脚本）；
 * - 缺 name / 定界符不闭合 / 行无法解析 → 记入 load errors 并跳过该技能
 *   （坏技能绝不拖垮整个注册表）。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** 注入 fs 端口（生产适配 node:fs；测试注 memfs）。 */
export interface SkillFsPort {
  /** 列目录项名；目录不存在时抛错（调用方按"该层无技能"处理）。 */
  readdir(dir: string): Promise<string[]> | string[];
  /** 读文本文件；不存在时抛错。 */
  readFile(path: string): Promise<string> | string;
  /** 目录探测：true=path 是目录；false=不存在或非目录。 */
  isDirectory(path: string): Promise<boolean> | boolean;
}

/** 参数规格（mini schema：type/required/description）。 */
export interface SkillParamSpec {
  readonly type: "string" | "number" | "boolean";
  readonly required: boolean;
  readonly description?: string;
}

/** 技能元数据（正文模板随附）。 */
export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  /** allowed-tools 声明（空数组 = 无脚本执行资格；仅声明透传，不在此执行）。 */
  readonly allowedTools: readonly string[];
  /** 参数 mini schema（frontmatter params 块）。 */
  readonly paramsSchema: Readonly<Record<string, SkillParamSpec>>;
  /** SKILL.md 正文（frontmatter 之后），执行时展开为注入 prompt。 */
  readonly body: string;
  /** 技能目录绝对路径。 */
  readonly dir: string;
  /** 来源层。 */
  readonly source: "user" | "workspace";
}

/** 单个技能装载失败记录（坏技能跳过不致命）。 */
export interface SkillLoadError {
  readonly dir: string;
  readonly reason: string;
}

export interface SkillRegistryOptions {
  readonly fs: SkillFsPort;
  /** 用户级技能目录；默认 ~/.bi/skills。 */
  readonly userSkillsDir?: string;
  /** 工作区技能目录；默认 .bi/skills。 */
  readonly workspaceSkillsDir?: string;
}

export function defaultUserSkillsDir(): string {
  return join(homedir(), ".bi", "skills");
}

export const defaultWorkspaceSkillsDir = ".bi/skills";

/* ------------------------------------------------------------------ */
/* frontmatter 房规解析                                                  */
/* ------------------------------------------------------------------ */

export type ParsedSkillMarkdown =
  | {
      ok: true;
      name: string;
      description: string;
      allowedTools: string[];
      params: Record<string, SkillParamSpec>;
      body: string;
    }
  | { ok: false; reason: string };

/** 解析 SKILL.md（房规见模块头注释）。 */
export function parseSkillMarkdown(raw: string): ParsedSkillMarkdown {
  const lines = raw.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { ok: false, reason: "缺少 frontmatter 定界符（首行必须为 ---）" };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return { ok: false, reason: "frontmatter 未闭合" };

  let name = "";
  let description = "";
  const allowedTools: string[] = [];
  const params: Record<string, SkillParamSpec> = {};
  let inParams = false;
  let currentParam: string | null = null;

  for (const line of lines.slice(1, close)) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      return { ok: false, reason: `frontmatter 行无法解析: ${line.trim()}` };
    }
    const indented = /^[ \t]/.test(line);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (!indented) {
      inParams = key === "params";
      currentParam = null;
      if (key === "name") {
        name = value;
      } else if (key === "description") {
        description = value;
      } else if (key === "allowed-tools") {
        for (const part of value.split(",")) {
          const tool = part.trim();
          if (tool.length > 0) allowedTools.push(tool);
        }
      }
      // 未知顶层键忽略（向前兼容）
      continue;
    }

    if (!inParams) {
      return { ok: false, reason: `frontmatter 缩进行不在 params 块内: ${key}` };
    }
    if (value === "") {
      // 参数声明行（2 空格缩进；缺省 type=string、required=false）
      currentParam = key;
      params[key] = { type: "string", required: false };
      continue;
    }
    // 参数属性行（4+ 空格缩进）
    if (currentParam === null) {
      return { ok: false, reason: `params 属性缺少所属参数: ${key}` };
    }
    const base = params[currentParam]!;
    if (key === "type") {
      if (value !== "string" && value !== "number" && value !== "boolean") {
        return { ok: false, reason: `参数 ${currentParam} 的 type 非法: ${value}` };
      }
      params[currentParam] = { ...base, type: value };
    } else if (key === "required") {
      if (value !== "true" && value !== "false") {
        return { ok: false, reason: `参数 ${currentParam} 的 required 非法: ${value}` };
      }
      params[currentParam] = { ...base, required: value === "true" };
    } else if (key === "description") {
      params[currentParam] = { ...base, description: value };
    }
    // 未知参数属性忽略（向前兼容）
  }

  if (name === "") return { ok: false, reason: "frontmatter 缺 name" };
  const body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\n/, "");
  return { ok: true, name, description, allowedTools, params, body };
}

/* ------------------------------------------------------------------ */
/* SkillRegistry                                                       */
/* ------------------------------------------------------------------ */

export interface SkillScanResult {
  /** 每层实际装载的技能数。 */
  readonly scanned: { readonly user: number; readonly workspace: number };
  /** 装载失败记录（坏技能跳过）。 */
  readonly errors: readonly SkillLoadError[];
}

export class SkillRegistry {
  readonly #fs: SkillFsPort;
  readonly #userSkillsDir: string;
  readonly #workspaceSkillsDir: string;
  #skills = new Map<string, SkillMeta>();
  #errors: SkillLoadError[] = [];

  constructor(options: SkillRegistryOptions) {
    this.#fs = options.fs;
    this.#userSkillsDir = options.userSkillsDir ?? defaultUserSkillsDir();
    this.#workspaceSkillsDir = options.workspaceSkillsDir ?? defaultWorkspaceSkillsDir;
  }

  /** 重扫双目录：工作区同名覆盖用户级；坏技能记 errors 跳过。 */
  async refresh(): Promise<SkillScanResult> {
    const loaded = new Map<string, SkillMeta>();
    const errors: SkillLoadError[] = [];
    const scanned = { user: 0, workspace: 0 };

    const layers: readonly (readonly ["user" | "workspace", string])[] = [
      ["user", this.#userSkillsDir],
      ["workspace", this.#workspaceSkillsDir],
    ];
    for (const [source, dir] of layers) {
      let names: string[];
      try {
        names = [...(await this.#fs.readdir(dir))];
      } catch {
        continue; // 目录不存在 → 该层无技能
      }
      for (const entry of names) {
        const skillDir = join(dir, entry);
        if (!(await this.#fs.isDirectory(skillDir))) continue; // 普通文件忽略
        const raw = await this.#readOrNull(join(skillDir, "SKILL.md"));
        if (raw === null) {
          errors.push({ dir: skillDir, reason: "缺少 SKILL.md" });
          continue;
        }
        const parsed = parseSkillMarkdown(raw);
        if (!parsed.ok) {
          errors.push({ dir: skillDir, reason: parsed.reason });
          continue;
        }
        loaded.set(parsed.name, {
          name: parsed.name,
          description: parsed.description,
          allowedTools: parsed.allowedTools,
          paramsSchema: parsed.params,
          body: parsed.body,
          dir: skillDir,
          source,
        });
        scanned[source] += 1;
      }
    }

    this.#skills = loaded;
    this.#errors = errors;
    return { scanned, errors: [...errors] };
  }

  /** 全部技能元数据（名称序）。 */
  list(): readonly SkillMeta[] {
    return [...this.#skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** 按名称取技能；未知返回 undefined。 */
  get(name: string): SkillMeta | undefined {
    return this.#skills.get(name);
  }

  /** 最近一次 refresh 的装载错误。 */
  loadErrors(): readonly SkillLoadError[] {
    return [...this.#errors];
  }

  /**
   * 相似候选（unknown 技能的纠正提示）：前缀/包含命中优先，
   * 其次编辑距离 ≤ max(2, len/3)；按分排序取前 limit（默认 3）。
   */
  similar(name: string, limit = 3): string[] {
    const query = name.toLowerCase();
    const scored: Array<{ candidate: string; score: number }> = [];
    for (const candidate of this.#skills.keys()) {
      const c = candidate.toLowerCase();
      let score: number;
      if (c === query) score = 0;
      else if (c.startsWith(query) || query.startsWith(c)) score = 1;
      else if (c.includes(query) || query.includes(c)) score = 2;
      else {
        const distance = levenshtein(query, c);
        score = distance <= Math.max(2, Math.floor(c.length / 3)) ? 10 + distance : Number.POSITIVE_INFINITY;
      }
      if (score !== Number.POSITIVE_INFINITY) scored.push({ candidate, score });
    }
    scored.sort((a, b) => a.score - b.score || (a.candidate < b.candidate ? -1 : 1));
    return scored.slice(0, limit).map((s) => s.candidate);
  }

  async #readOrNull(path: string): Promise<string | null> {
    try {
      return await this.#fs.readFile(path);
    } catch {
      return null;
    }
  }
}

/** 经典 DP 编辑距离（小串，无性能压力）。 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}
