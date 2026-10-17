/**
 * BI-17 — 官方插件双协议加载器（纯声明式解析，零代码执行）
 *
 * # 双协议与版本假设
 *
 * 本加载器按两类"官方插件协议"的公开文档常识实现（不读取任何参考源码，
 * 遵守 RULE-BI-06；版本假设：以 2025~2026 年公开文档所描述的形态为准）：
 *
 * 1. Anthropic 形态：插件目录含 `.claude-plugin/plugin.json` 清单文件；
 *    技能位于插件根的 `skills/` 目录（`skills/<name>/SKILL.md` 或平铺的
 *    单个 `.md` 文件）；MCP 服务器以清单内声明式 `mcpServers` 字段表达。
 * 2. zcode 形态：与 Anthropic 同构（`.zcode-plugin/` 点目录或插件根级
 *    `plugin.json`），清单字段与技能集同构。
 *
 * 探测优先级（`protocol: 'auto'`，默认）：
 *   `.claude-plugin/plugin.json` > `.zcode-plugin/plugin.json` > `plugin.json`
 *
 * # 安全语义与三层分工（重要）
 *
 * 本模块是**声明层**：纯数据解析。不 eval、不执行插件目录内的任何代码、
 * 不 spawn 任何子进程；`mcpServers` 仅作为声明数据透传。
 *
 *   1) 声明层（本卡 BI-17，本文件）——把插件目录解析成纯数据清单；
 *   2) 装配层（BI-13 MCP 客户端）——根据声明装配 MCP 连接/会话；
 *      注意：`.mcp.json` 独立文件形态不在本卡范围内，归 BI-13。
 *   3) 执行门禁（BI-06.5 权限门）——任何实际执行/连接动作必须先过权限门，
 *      未授权的 mcpServers 声明不得触达执行面。
 *
 * # frontmatter 解析（手写 YAML 子集，零外部 npm 依赖）
 *
 * `---` 围栏内的 `key: value` 行；值支持字符串（可带成对引号）、布尔
 * （true/false）、列表项（`- x`，含 `key:` 空值后跟缩进列表项的形态）；
 * 畸形行（无冒号、无归属列表项）跳过容错；重复键后者覆盖；不支持数字
 * 字面量（保持字符串）与行内注释。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** frontmatter 值的 YAML 子集：字符串 / 布尔 / 字符串列表。 */
export type FrontmatterValue = string | boolean | string[];

export type Frontmatter = Record<string, FrontmatterValue>;

/**
 * mcpServers 的声明条目。仅声明——command/url 不在本层被执行；
 * 透传保留未知字段，供装配层（BI-13）解释。
 */
export interface McpServerDecl {
  command?: string;
  url?: string;
  [key: string]: unknown;
}

/** 一个技能（SKILL.md 或单 .md 文件）解析出的纯数据。 */
export interface SkillRef {
  /** 取 frontmatter.name，缺省回退为目录名 / 文件名（去 .md）。 */
  name: string;
  /** 技能 markdown 文件的绝对路径（自包含，供装配层直接寻址）。 */
  path: string;
  frontmatter: Frontmatter;
  /** 围栏之后的正文原文（去除围栏与首尾空白）。 */
  body: string;
}

/** 插件清单协议形态标记。 */
export type PluginProtocol = 'claude' | 'zcode';

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  skills: SkillRef[];
  /** 仅声明透传，不启动。启动/装配归 BI-13，执行门禁归 BI-06.5。 */
  mcpServers?: Record<string, McpServerDecl>;
}

export interface LoadOptions {
  /** 'auto'（默认）按探测优先级三选一；指定则仅探测该协议形态。 */
  protocol?: PluginProtocol | 'auto';
}

/** 结构化加载失败：带稳定 code 供上层分支。 */
export class PluginLoadError extends Error {
  readonly code: 'dir-not-found' | 'no-manifest' | 'manifest-malformed' | 'name-missing';
  readonly dir: string;

  constructor(code: PluginLoadError['code'], dir: string, message: string) {
    super(`[${code}] ${message} (dir: ${dir})`);
    this.name = 'PluginLoadError';
    this.code = code;
    this.dir = dir;
  }
}

/** discoverPlugins 结果：先到先得，重复 name 的后到者被拒绝。 */
export interface DiscoveryResult {
  plugins: PluginManifest[];
  rejected: Array<{ dir: string; name: string | null; reason: string }>;
}

export interface ValidationReport {
  ok: boolean;
  problems: string[];
}

// ---------------------------------------------------------------------------
// frontmatter（手写 YAML 子集）
// ---------------------------------------------------------------------------

export interface ParsedSkillDoc {
  frontmatter: Frontmatter;
  body: string;
  /** 是否存在 `---` 围栏（validatePlugin 用以报告缺 frontmatter 的 SKILL.md）。 */
  fenced: boolean;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const head = s[0];
    const tail = s[s.length - 1];
    if ((head === '"' || head === "'") && head === tail) return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s: string): string | boolean {
  if (s === 'true') return true;
  if (s === 'false') return false;
  return stripQuotes(s);
}

/**
 * 解析 `---` 围栏 frontmatter + 正文。
 * 容错：无围栏 → frontmatter 为空、正文为原文（fenced: false）；
 * 畸形行（无冒号、无归属的列表项）跳过；重复键后者覆盖。
 */
export function parseFrontmatter(raw: string): ParsedSkillDoc {
  const lines = raw.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') {
    return { frontmatter: {}, body: raw.trim(), fenced: false };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) {
    // 围栏未闭合：按无 frontmatter 容错处理
    return { frontmatter: {}, body: raw.trim(), fenced: false };
  }

  const frontmatter: Frontmatter = {};
  let currentKey: string | null = null;
  for (let i = 1; i < close; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '') {
      currentKey = null;
      continue;
    }
    if (line.startsWith('- ')) {
      if (currentKey === null) continue; // 畸形：列表项无归属键
      const current = frontmatter[currentKey];
      const item = stripQuotes(line.slice(2).trim());
      if (current === '') {
        frontmatter[currentKey] = [item];
      } else if (Array.isArray(current)) {
        current.push(item);
      }
      // 其余情况（标量已占位）视为畸形续行，跳过
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    if (!match) continue; // 畸形行容错
    const key = match[1] ?? '';
    if (key === '') continue;
    const rest = (match[2] ?? '').trim();
    if (rest === '') {
      frontmatter[key] = ''; // 空值占位；若紧跟列表项则升级为数组
      currentKey = key;
    } else {
      frontmatter[key] = parseScalar(rest);
      currentKey = null;
    }
  }

  const body = lines
    .slice(close + 1)
    .join('\n')
    .trim();
  return { frontmatter, body, fenced: true };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
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
// 双协议探测
// ---------------------------------------------------------------------------

const PROBE_ORDER: ReadonlyArray<{ rel: string; protocol: PluginProtocol }> = [
  { rel: '.claude-plugin/plugin.json', protocol: 'claude' },
  { rel: '.zcode-plugin/plugin.json', protocol: 'zcode' },
  { rel: 'plugin.json', protocol: 'zcode' },
];

/**
 * 返回 (协议, 清单绝对路径)。探测优先级：
 * `.claude-plugin/plugin.json` > `.zcode-plugin/plugin.json` > `plugin.json`。
 * protocol 指定时仅探测该协议形态（zcode 含点目录与根级两种落位）。
 */
export async function probePluginManifest(
  dir: string,
  protocol: PluginProtocol | 'auto' = 'auto',
): Promise<{ protocol: PluginProtocol; file: string } | null> {
  const candidates = PROBE_ORDER.filter((c) => {
    if (protocol === 'auto') return true;
    return c.protocol === protocol;
  });
  for (const candidate of candidates) {
    const file = path.join(dir, candidate.rel);
    if (await fileExists(file)) {
      return { protocol: candidate.protocol, file };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// skills/ 目录扫描
// ---------------------------------------------------------------------------

async function readSkillDoc(absPath: string, fallbackName: string): Promise<SkillRef> {
  const raw = await fs.readFile(absPath, 'utf8');
  const parsed = parseFrontmatter(raw);
  const fmName = parsed.frontmatter['name'];
  const name = typeof fmName === 'string' && fmName.trim() !== '' ? fmName.trim() : fallbackName;
  return { name, path: absPath, frontmatter: parsed.frontmatter, body: parsed.body };
}

/**
 * 扫描插件根的 `skills/` 目录：
 * 子目录含 SKILL.md → 用之；子目录仅含唯一 .md → 用之；
 * 平铺的 .md 文件直接用。0/多个 .md 且无 SKILL.md 的子目录跳过
 * （validatePlugin 会报告）。结果按 name 排序保证确定性。
 */
async function loadSkills(dir: string): Promise<SkillRef[]> {
  const skillsDir = path.join(dir, 'skills');
  if (!(await dirExists(skillsDir))) return [];
  const dirents = (await fs.readdir(skillsDir, { withFileTypes: true })).sort(byName);
  const skills: SkillRef[] = [];
  for (const dent of dirents) {
    const entryPath = path.join(skillsDir, dent.name);
    if (dent.isFile()) {
      if (!dent.name.endsWith('.md')) continue;
      skills.push(await readSkillDoc(entryPath, dent.name.replace(/\.md$/, '')));
    } else if (dent.isDirectory()) {
      const skillMd = path.join(entryPath, 'SKILL.md');
      if (await fileExists(skillMd)) {
        skills.push(await readSkillDoc(skillMd, dent.name));
        continue;
      }
      const mdNames = (await fs.readdir(entryPath, { withFileTypes: true }))
        .filter((d) => d.isFile() && d.name.endsWith('.md'))
        .map((d) => d.name)
        .sort();
      if (mdsExactlyOne(mdNames)) {
        skills.push(await readSkillDoc(path.join(entryPath, mdNames[0] ?? ''), dent.name));
      }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

function mdsExactlyOne(names: string[]): boolean {
  return names.length === 1;
}

// ---------------------------------------------------------------------------
// loadPlugin
// ---------------------------------------------------------------------------

/** 加载并解析插件目录为纯数据清单。不执行任何插件内代码，不 spawn。 */
export async function loadPlugin(
  dir: string,
  opts?: LoadOptions,
): Promise<PluginManifest> {
  const absDir = path.resolve(dir);
  if (!(await dirExists(absDir))) {
    throw new PluginLoadError('dir-not-found', absDir, '插件目录不存在或不是目录');
  }
  const probe = await probePluginManifest(absDir, opts?.protocol ?? 'auto');
  if (!probe) {
    throw new PluginLoadError('no-manifest', absDir, '未找到 plugin.json 清单（双协议探测均失败）');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(probe.file, 'utf8'));
  } catch (e) {
    throw new PluginLoadError(
      'manifest-malformed',
      absDir,
      `清单 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new PluginLoadError('manifest-malformed', absDir, '清单必须是 JSON 对象');
  }

  const name = raw['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw new PluginLoadError('name-missing', absDir, '清单缺少必填字段 name（需非空字符串）');
  }

  const manifest: PluginManifest = { name, skills: await loadSkills(absDir) };
  if (typeof raw['version'] === 'string') manifest.version = raw['version'];
  if (typeof raw['description'] === 'string') manifest.description = raw['description'];

  if (isPlainObject(raw['mcpServers'])) {
    const servers: Record<string, McpServerDecl> = {};
    for (const [key, val] of Object.entries(raw['mcpServers'])) {
      if (isPlainObject(val)) {
        servers[key] = { ...val }; // 纯声明透传：不解释、不校验执行语义、不启动
      }
      // 非对象条目：声明层丢弃，validatePlugin 负责报告
    }
    manifest.mcpServers = servers;
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// discoverPlugins
// ---------------------------------------------------------------------------

/**
 * 多根扫描（如 `~/.bi/plugins`、工作区 `.bi/plugins`、内置 presets/plugins，
 * 路径由调用方注入）。每个根下的一级子目录视为候选插件目录；非插件目录
 * 与不存在的根静默跳过；重复 name 先到先得（按 roots 顺序 + 目录名字典序），
 * 后者进 rejected。加载失败的候选（畸形清单等）也进 rejected 并附原因。
 */
export async function discoverPlugins(roots: string[]): Promise<DiscoveryResult> {
  const plugins: PluginManifest[] = [];
  const rejected: DiscoveryResult['rejected'] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const absRoot = path.resolve(root);
    if (!(await dirExists(absRoot))) continue; // 可选根：不存在即跳过
    const dirents = (await fs.readdir(absRoot, { withFileTypes: true })).sort(byName);
    for (const dent of dirents) {
      if (!dent.isDirectory()) continue;
      const candidate = path.join(absRoot, dent.name);
      if (!(await probePluginManifest(candidate))) continue; // 非插件目录
      try {
        const manifest = await loadPlugin(candidate);
        if (seen.has(manifest.name)) {
          rejected.push({
            dir: candidate,
            name: manifest.name,
            reason: `duplicate-name: 插件 '${manifest.name}' 已由更早的根/目录提供，后者拒绝（先到先得）`,
          });
        } else {
          seen.add(manifest.name);
          plugins.push(manifest);
        }
      } catch (e) {
        rejected.push({ dir: candidate, name: null, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return { plugins, rejected };
}

// ---------------------------------------------------------------------------
// validatePlugin
// ---------------------------------------------------------------------------

async function checkFence(absPath: string, baseDir: string, problems: string[]): Promise<void> {
  const raw = await fs.readFile(absPath, 'utf8');
  if (!parseFrontmatter(raw).fenced) {
    problems.push(`skills: ${path.relative(baseDir, absPath)} 缺少 frontmatter（--- 围栏）`);
  }
}

/** 结构化校验：清单缺字段 / skills 引用不存在 / JSON 畸形 / mcpServers 形态。 */
export async function validatePlugin(dir: string): Promise<ValidationReport> {
  const problems: string[] = [];
  const absDir = path.resolve(dir);

  if (!(await dirExists(absDir))) {
    return { ok: false, problems: ['manifest: 插件目录不存在'] };
  }
  const probe = await probePluginManifest(absDir);
  if (!probe) {
    return {
      ok: false,
      problems: [
        'manifest: 未找到清单（.claude-plugin/plugin.json、.zcode-plugin/plugin.json、plugin.json 均不存在）',
      ],
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(probe.file, 'utf8'));
  } catch (e) {
    return {
      ok: false,
      problems: [`manifest: JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  if (!isPlainObject(raw)) {
    return { ok: false, problems: ['manifest: 清单必须是 JSON 对象'] };
  }

  const name = raw['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    problems.push('manifest: 缺少必填字段 name（需非空字符串）');
  }
  if (raw['version'] !== undefined && typeof raw['version'] !== 'string') {
    problems.push('manifest: version 应为字符串');
  }
  if (raw['description'] !== undefined && typeof raw['description'] !== 'string') {
    problems.push('manifest: description 应为字符串');
  }

  const declaredSkills = raw['skills'];
  if (declaredSkills !== undefined) {
    if (!Array.isArray(declaredSkills) || declaredSkills.some((s) => typeof s !== 'string')) {
      problems.push('skills: 清单声明的 skills 应为字符串路径数组');
    } else {
      for (const rel of declaredSkills as string[]) {
        const p = path.resolve(absDir, rel);
        if (!(await pathExists(p))) {
          problems.push(`skills: 清单声明的技能路径不存在: ${rel}`);
        }
      }
    }
  }

  const mcp = raw['mcpServers'];
  if (mcp !== undefined) {
    if (!isPlainObject(mcp)) {
      problems.push('mcpServers: 应为 { 名称: 声明 } 对象映射');
    } else {
      for (const [key, val] of Object.entries(mcp)) {
        if (!isPlainObject(val)) {
          problems.push(`mcpServers.${key}: 声明必须是对象`);
          continue;
        }
        if (typeof val['command'] !== 'string' && typeof val['url'] !== 'string') {
          problems.push(`mcpServers.${key}: 声明缺少 command 或 url 之一`);
        }
      }
    }
  }

  // skills/ 目录结构：子目录须有 SKILL.md 或唯一 .md；技能文件须有围栏
  const skillsDir = path.join(absDir, 'skills');
  if (await dirExists(skillsDir)) {
    const dirents = (await fs.readdir(skillsDir, { withFileTypes: true })).sort(byName);
    for (const dent of dirents) {
      const entryPath = path.join(skillsDir, dent.name);
      if (dent.isDirectory()) {
        const skillMd = path.join(entryPath, 'SKILL.md');
        if (await fileExists(skillMd)) {
          await checkFence(skillMd, absDir, problems);
          continue;
        }
        const mdNames = (await fs.readdir(entryPath, { withFileTypes: true }))
          .filter((d) => d.isFile() && d.name.endsWith('.md'))
          .map((d) => d.name)
          .sort();
        if (mdNames.length === 1) {
          await checkFence(path.join(entryPath, mdNames[0] ?? ''), absDir, problems);
        } else {
          problems.push(`skills: 子目录 '${dent.name}' 缺少 SKILL.md 或唯一 .md 文件`);
        }
      } else if (dent.isFile() && dent.name.endsWith('.md')) {
        await checkFence(entryPath, absDir, problems);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
