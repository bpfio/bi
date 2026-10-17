/**
 * TOML 语法树级注释保留原子回写（对齐工单 BI-01.1 第 4 点：`smol-toml` + `planConfigWriteback`）。
 *
 * 工作方式：
 * 1. `planConfigWriteback` 先用 smol-toml 的表头/键寻址模型对原文档建立索引
 *    （表头路径、键全路径、跨行值 span），再把编辑计划落成行级替换/插入/删除，
 *    未被触及的行（用户注释、空行、格式）字节级保留；
 * 2. 生成的目标文本强制过一遍 smol-toml 解析守卫——无法通过语法校验的计划直接报错拒绝，
 *    绝不产出损坏文件（同时天然拦截内联表嵌套等不支持场景）；
 * 3. 落盘走 `atomicWriteFile`（同目录临时文件 + rename 原子替换）。
 *
 * 已知边界（守卫保护，报错而非损坏）：
 * - 不支持对 `[[array of tables]]` 内部的键寻址回写；
 * - 不支持对"键值为内联表后再展开其子键"的场景寻址（会触发解析守卫报错）；
 * - 键段不支持含点号的引号键（配置 Schema 全部为裸键）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as tomlParse, TomlError } from "smol-toml";
import { atomicWriteFile } from "../utils/atomic-write";
import { ConfigError } from "./schema";

/** 可回写的 TOML 值（标量 / 数组 / 内联表）。 */
export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };

/** 单条回写编辑：`value === undefined` 表示删除该键。 */
export interface WritebackEdit {
  /** 目标键点分路径（相对文档根），如 ["providers","entries","openai","api_key_env"]。 */
  path: string[];
  value?: TomlValue;
}

/** 回写计划：纯文本变换结果，调用方可审阅后自行落盘或直接用 `writebackConfigFile`。 */
export interface PlannedWriteback {
  originalText: string;
  nextText: string;
  /** 是否产生变化（所有编辑均为空操作时为 false，调用方可跳过写盘）。 */
  changed: boolean;
  edits: WritebackEdit[];
  /** 因原文件缺失而新建的表头路径（便于上层提示）。 */
  createdTables: string[][];
}

// ---------------------------------------------------------------------------
// 行扫描基础工具（均尊重字符串边界与转义）
// ---------------------------------------------------------------------------

interface ScanState {
  inBasic: boolean;
  inLiteral: boolean;
  escaped: boolean;
}

function newState(): ScanState {
  return { inBasic: false, inLiteral: false, escaped: false };
}

function isInString(state: ScanState): boolean {
  return state.inBasic || state.inLiteral;
}

function stepScan(line: string, i: number, state: ScanState): void {
  const ch = line[i];
  if (ch === undefined) return;
  if (state.inBasic) {
    if (state.escaped) state.escaped = false;
    else if (ch === "\\") state.escaped = true;
    else if (ch === '"') state.inBasic = false;
    return;
  }
  if (state.inLiteral) {
    if (ch === "'") state.inLiteral = false;
    return;
  }
  if (ch === '"') state.inBasic = true;
  else if (ch === "'") state.inLiteral = true;
}

/** 找到键值分隔的顶层 `=`（不在字符串内）的下标；无则 -1。 */
function topLevelEqualsIndex(line: string): number {
  const state = newState();
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === undefined) break;
    if (!isInString(state) && ch === "=") return i;
    stepScan(line, i, state);
  }
  return -1;
}

/** 提取值部分的行尾注释（`# ...`，不在字符串内），含 `#` 前的原有空白；无注释返回空串。 */
function extractTrailingComment(valuePart: string): string {
  const state = newState();
  for (let i = 0; i < valuePart.length; i += 1) {
    const ch = valuePart[i];
    if (ch === undefined) break;
    if (!isInString(state) && ch === "#") {
      // 连同 `#` 前的空白一起截取，保证替换值后行内注释的原始间距字节保留
      let wsStart = i;
      while (wsStart > 0 && valuePart[wsStart - 1] === " ") wsStart -= 1;
      return valuePart.slice(wsStart);
    }
    stepScan(valuePart, i, state);
  }
  return "";
}

/** 把点分键/表头内容按"不在字符串内的 `.`"切分并去掉引号。 */
function splitDottedKey(text: string): string[] {
  const segments: string[] = [];
  const state = newState();
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (!isInString(state) && ch === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
    stepScan(text, i, state);
  }
  segments.push(current.trim());
  return segments.map(unquoteSegment).filter((segment) => segment !== "");
}

function unquoteSegment(segment: string): string {
  if (segment.length >= 2) {
    const quote = segment[0];
    if (quote === '"' && segment.endsWith('"')) return segment.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
    if (quote === "'" && segment.endsWith("'")) return segment.slice(1, -1);
  }
  return segment;
}

function dotted(path: readonly string[]): string {
  return path.join(".");
}

// ---------------------------------------------------------------------------
// 文档索引
// ---------------------------------------------------------------------------

interface HeaderEntry {
  path: string[];
  lineIndex: number;
  isAoT: boolean;
}

interface KeyEntry {
  lineIndex: number;
  /** 值 span：跨行数组/内联表的起止行（含），单行值 start === end。 */
  spanEnd: number;
}

interface DocIndex {
  headers: Map<string, HeaderEntry>;
  keys: Map<string, KeyEntry>;
  firstHeaderIndex: number;
  headerLineIndexes: number[];
}

/** 判断某行是否纯注释/空行。 */
function isIgnorableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** 计算键所在值的跨行 span 结束行（括号深度回到 0）。 */
function computeValueSpan(lines: string[], startLine: number, equalsIndex: number): number {
  const state = newState();
  let depth = 0;
  let sawOpen = false;
  for (let li = startLine; li < lines.length; li += 1) {
    const line = lines[li];
    if (line === undefined) break;
    const from = li === startLine ? equalsIndex + 1 : 0;
    for (let i = from; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === undefined) break;
      if (isInString(state)) {
        stepScan(line, i, state);
        continue;
      }
      if (ch === "#") break; // 行注释，跳到下一行
      if (ch === "[" || ch === "{") {
        depth += 1;
        sawOpen = true;
      } else if (ch === "]" || ch === "}") {
        depth -= 1;
      }
      stepScan(line, i, state);
    }
    if (sawOpen && depth <= 0) return li;
    if (!sawOpen) return startLine;
  }
  return startLine;
}

function buildIndex(lines: string[]): DocIndex {
  const headers = new Map<string, HeaderEntry>();
  const keys = new Map<string, KeyEntry>();
  const headerLineIndexes: number[] = [];
  let firstHeaderIndex = -1;
  let currentPath: string[] = [];
  let currentIsAoT = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (isIgnorableLine(line)) continue;

    const aotMatch = /^\[\[(.+)\]\]$/.exec(trimmed);
    const headerMatch = aotMatch === null ? /^\[(.+)\]$/.exec(trimmed) : null;
    if (aotMatch !== null || headerMatch !== null) {
      const content = (aotMatch ?? headerMatch)?.[1] ?? "";
      currentPath = splitDottedKey(content);
      currentIsAoT = aotMatch !== null;
      headers.set(dotted(currentPath), { path: currentPath, lineIndex: i, isAoT: currentIsAoT });
      headerLineIndexes.push(i);
      if (firstHeaderIndex === -1) firstHeaderIndex = i;
      continue;
    }

    const equalsIndex = topLevelEqualsIndex(line);
    if (equalsIndex === -1) continue;
    const keyPart = line.slice(0, equalsIndex);
    const fullPath = [...currentPath, ...splitDottedKey(keyPart)];
    if (currentIsAoT) continue; // AoT 块内不索引（不支持寻址回写）
    keys.set(dotted(fullPath), { lineIndex: i, spanEnd: computeValueSpan(lines, i, equalsIndex) });
  }

  return { headers, keys, firstHeaderIndex, headerLineIndexes };
}

// ---------------------------------------------------------------------------
// 值序列化
// ---------------------------------------------------------------------------

function isPlainRecord(value: TomlValue): value is { [key: string]: TomlValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 序列化为单行 TOML 值（数组/内联表单行化；字符串用基本字符串转义）。 */
function serializeTomlValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConfigError(`回写值不能为非有限数字: ${String(value)}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[ ${value.map(serializeTomlValue).join(", ")} ]`;
  if (isPlainRecord(value)) {
    const fields = Object.keys(value).map((key) => `${key} = ${serializeTomlValue(value[key] as TomlValue)}`);
    return `{ ${fields.join(", ")} }`;
  }
  throw new ConfigError(`不支持的回写值类型: ${String(value)}`);
}

// ---------------------------------------------------------------------------
// 编辑器
// ---------------------------------------------------------------------------

class TomlDocEditor {
  private readonly lines: string[];

  constructor(text: string) {
    this.lines = text.split("\n");
  }

  toString(): string {
    return this.lines.join("\n");
  }

  /** 设置键值；`createdTables` 收集因本次编辑新建的表头路径。返回是否发生变化。 */
  setValue(path: string[], value: TomlValue, createdTables: string[][]): boolean {
    if (path.length === 0) throw new ConfigError("回写编辑路径不能为空");
    const keyName = path[path.length - 1];
    if (keyName === undefined || keyName === "") throw new ConfigError(`回写编辑路径的键名无效: ${dotted(path)}`);
    const tablePath = path.slice(0, -1);
    const index = buildIndex(this.lines);

    const existing = index.keys.get(dotted(path));
    if (existing !== undefined) {
      this.replaceKeyLine(existing.lineIndex, existing.spanEnd, keyName, value);
      return true;
    }

    const serialized = serializeTomlValue(value);
    const newLine = `${keyName} = ${serialized}`;

    if (tablePath.length === 0) {
      this.lines.splice(this.rootInsertIndex(index), 0, newLine);
      return true;
    }

    const header = index.headers.get(dotted(tablePath));
    if (header !== undefined) {
      if (header.isAoT) {
        throw new ConfigError(`不支持对数组表 [[${dotted(tablePath)}]] 内部回写`);
      }
      this.lines.splice(this.tableInsertIndex(index, header.lineIndex), 0, newLine);
      return true;
    }

    this.ensureTableWritable(tablePath, index);
    this.appendTableAndKey(tablePath, keyName, serialized);
    createdTables.push(tablePath);
    return true;
  }

  /** 删除键（连同其跨行值 span）。键不存在时为空操作。 */
  removeValue(path: string[]): boolean {
    if (path.length === 0) throw new ConfigError("回写编辑路径不能为空");
    const index = buildIndex(this.lines);
    const existing = index.keys.get(dotted(path));
    if (existing === undefined) return false;
    this.lines.splice(existing.lineIndex, existing.spanEnd - existing.lineIndex + 1);
    return true;
  }

  // ----- 内部定位 -----

  private replaceKeyLine(lineIndex: number, spanEnd: number, keyName: string, value: TomlValue): void {
    const line = this.lines[lineIndex];
    if (line === undefined) throw new ConfigError(`回写索引指向不存在的行: ${lineIndex}`);
    const equalsIndex = topLevelEqualsIndex(line);
    if (equalsIndex === -1) throw new ConfigError(`回写索引行不是键值行: ${lineIndex}`);
    const comment = extractTrailingComment(line.slice(equalsIndex + 1));
    const newLine = `${line.slice(0, equalsIndex + 1)} ${serializeTomlValue(value)}${comment !== "" ? comment : ""}`;
    this.lines.splice(lineIndex, spanEnd - lineIndex + 1, newLine);
  }

  private rootInsertIndex(index: DocIndex): number {
    let insertAt = -1;
    for (let i = 0; i < this.lines.length; i += 1) {
      if (index.firstHeaderIndex !== -1 && i >= index.firstHeaderIndex) break;
      const line = this.lines[i];
      if (line === undefined) continue;
      if (!isIgnorableLine(line) && topLevelEqualsIndex(line) !== -1) insertAt = i + 1;
    }
    if (insertAt !== -1) return insertAt;
    return index.firstHeaderIndex !== -1 ? index.firstHeaderIndex : this.lines.length;
  }

  private tableInsertIndex(index: DocIndex, headerLineIndex: number): number {
    const end = this.nextHeaderIndex(index, headerLineIndex);
    let insertAt = headerLineIndex + 1;
    // 跳过紧随表头的注释行（它们记录的是整表说明）
    for (let i = headerLineIndex + 1; i < end; i += 1) {
      const line = this.lines[i];
      if (line === undefined) continue;
      if (line.trim().startsWith("#")) insertAt = i + 1;
      else break;
    }
    // 插到块内最后一个键值行（含其跨行值 span）之后，保留块尾注释归属
    for (const keyEntry of index.keys.values()) {
      if (keyEntry.lineIndex > headerLineIndex && keyEntry.lineIndex < end) {
        insertAt = Math.max(insertAt, keyEntry.spanEnd + 1);
      }
    }
    return Math.min(insertAt, end);
  }

  private nextHeaderIndex(index: DocIndex, headerLineIndex: number): number {
    let end = this.lines.length;
    for (const candidate of index.headerLineIndexes) {
      if (candidate > headerLineIndex && candidate < end) end = candidate;
    }
    return end;
  }

  /** 追加新表头 + 键值行到文档末尾（TOML 点分表头可一次性声明嵌套路径），保证恰好一个空行分隔。 */
  private appendTableAndKey(tablePath: string[], keyName: string, serializedValue: string): void {
    const count = this.lines.length;
    const lastTrimmed = count > 0 ? this.lines[count - 1]?.trim() : undefined;
    const beforeLastTrimmed = count > 1 ? this.lines[count - 2]?.trim() : undefined;
    let needBlank: boolean;
    if (count === 0) {
      needBlank = false; // 空文档
    } else if (lastTrimmed === "") {
      needBlank = beforeLastTrimmed !== undefined && beforeLastTrimmed !== ""; // 仅换行符产物 → 升级为视觉空行
    } else {
      needBlank = true; // 末尾是内容行（无结尾换行）
    }
    if (needBlank) this.lines.push("");
    this.lines.push(`[${dotted(tablePath)}]`, `${keyName} = ${serializedValue}`);
  }

  /** 校验目标表路径不与任何数组表冲突。 */
  private ensureTableWritable(tablePath: string[], index: DocIndex): void {
    for (let take = 1; take <= tablePath.length; take += 1) {
      const prefix = tablePath.slice(0, take);
      const header = index.headers.get(dotted(prefix));
      if (header !== undefined && header.isAoT) {
        throw new ConfigError(`表路径与数组表 [[${dotted(prefix)}]] 冲突，拒绝回写`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

/**
 * 规划一次注释保留回写：解析 → 键寻址修改 → 序列化校验。
 * 只做纯文本变换规划，不落盘；落盘用 `writebackConfigFile`。
 */
export function planConfigWriteback(currentText: string, edits: readonly WritebackEdit[]): PlannedWriteback {
  const editor = new TomlDocEditor(currentText);
  const createdTables: string[][] = [];
  for (const edit of edits) {
    if (!Array.isArray(edit.path) || edit.path.length === 0) {
      throw new ConfigError("回写编辑路径不能为空");
    }
    if (edit.value === undefined) {
      editor.removeValue(edit.path);
    } else {
      editor.setValue(edit.path, edit.value, createdTables);
    }
  }
  const nextText = editor.toString();
  if (nextText !== currentText) {
    assertValidToml(nextText);
  }
  return {
    originalText: currentText,
    nextText,
    changed: nextText !== currentText,
    edits: [...edits],
    createdTables,
  };
}

/**
 * 同步一张表的全部叶子键（键级 diff：更新已有、追加新增、删除移除项），
 * 用于 /config 面板整体改写某个分区/子表（如一个 provider 条目）。
 */
export function planTableSync(currentText: string, tablePath: string[], table: Record<string, TomlValue>): PlannedWriteback {
  const edits: WritebackEdit[] = [];

  // 旧表中将被移除的叶子键
  let parsed: unknown;
  try {
    parsed = currentText.trim() === "" ? {} : tomlParse(currentText);
  } catch (error) {
    throw new ConfigError(`现有配置不是合法 TOML，无法规划回写: ${errorMessage(error)}`);
  }
  let node: unknown = parsed;
  for (const segment of tablePath) {
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      node = (node as Record<string, unknown>)[segment];
    } else {
      node = undefined;
      break;
    }
  }
  collectRemovals(node, tablePath, table, edits);

  // 新表的设置/追加（子表递归展开为表头，标量/数组就地设值）
  collectSets(table, tablePath, edits);

  return planConfigWriteback(currentText, edits);
}

/** 读取配置文件 → 规划 →（有变化时）原子落盘。文件不存在视为空文档并按需创建。 */
export async function writebackConfigFile(filePath: string, edits: readonly WritebackEdit[]): Promise<PlannedWriteback> {
  let currentText = "";
  try {
    currentText = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  const plan = planConfigWriteback(currentText, edits);
  if (plan.changed) {
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, plan.nextText);
  }
  return plan;
}

/** 读取配置文件 → 整表同步 →（有变化时）原子落盘。 */
export async function writebackTableToFile(
  filePath: string,
  tablePath: string[],
  table: Record<string, TomlValue>,
): Promise<PlannedWriteback> {
  let currentText = "";
  try {
    currentText = await readFile(filePath, "utf8");
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
  const plan = planTableSync(currentText, tablePath, table);
  if (plan.changed) {
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWriteFile(filePath, plan.nextText);
  }
  return plan;
}

// ----- 内部工具 -----

function collectRemovals(
  oldNode: unknown,
  prefix: string[],
  next: Record<string, TomlValue>,
  edits: WritebackEdit[],
): void {
  if (oldNode === null || typeof oldNode !== "object" || Array.isArray(oldNode)) return;
  for (const key of Object.keys(oldNode)) {
    const child = (oldNode as Record<string, unknown>)[key];
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      collectRemovals(child, [...prefix, key], (next[key] ?? {}) as Record<string, TomlValue>, edits);
      continue;
    }
    if (!(key in next)) {
      edits.push({ path: [...prefix, key] });
    }
  }
}

function collectSets(node: Record<string, TomlValue>, prefix: string[], edits: WritebackEdit[]): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value !== undefined && isPlainRecord(value)) {
      collectSets(value, [...prefix, key], edits);
    } else if (value !== undefined) {
      edits.push({ path: [...prefix, key], value });
    }
  }
}

function assertValidToml(text: string): void {
  try {
    tomlParse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(`回写计划生成的 TOML 未通过语法校验（已拒绝写入）: ${error.message}`);
    }
    throw new ConfigError(`回写计划生成的 TOML 未通过语法校验（已拒绝写入）: ${errorMessage(error)}`);
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
