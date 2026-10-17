/**
 * Golden Trajectory 录制与加载（BI-03.6）：`TrajectoryRecorder`。
 *
 * 定位：
 *  - 本模块是 BI-00.2 升级追踪循环的回归门数据底座（大典增量吸收前置），
 *    与 BI-21.3 评测共享轨迹格式——本模块即权威 Schema 备案。
 *  - 格式 = SessionEntry 超集：在 ./types 的 SessionEntry 上叠加可选
 *    `modelResponse` 时序标记（模型响应决策点序号 + 产生时刻）。
 *
 * 物理形态：append-only JSONL（每行一条 TrajectoryEntry，单次 write 整行+'\n'），
 * 与会话 JSONL 同构；Golden 轨迹为线性主链（parentId 恒 null），fork/分支语义
 * 不入轨迹（那是会话引擎的事）。
 *
 * 录制规则（record 自动补全）：
 *  - id 缺省 uuid7、createdAt 缺省当前时间、seq 缺省自增（从 1 起）；
 *  - type='assistant' 的条目视为模型决策点，未显式给 modelResponse 时自动编号
 *    ordinal（会话内从 1 递增）与 at；
 *  - modelResponse 只允许出现在 assistant 条目上（否则结构错误）。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { uuid7 } from "./uuid7";
import { isSessionEntryType } from "./types";
import type { JsonValue, SessionEntry, SessionEntryType } from "./types";

/** 模型响应时序标记（TrajectoryEntry 对 SessionEntry 的超集字段）。 */
export interface ModelResponseMark {
  /** 模型响应决策点序号（会话内从 1 递增，仅 assistant 条目有）。 */
  ordinal: number;
  /** 响应产生时刻（unix 毫秒）。 */
  at: number;
}

/** 轨迹条目：SessionEntry 超集 + modelResponse 时序标记。 */
export interface TrajectoryEntry extends SessionEntry {
  modelResponse?: ModelResponseMark;
}

/** record 输入：id/parentId/createdAt/seq 可缺省（录制器补全）。 */
export type TrajectoryRecordInput = Omit<TrajectoryEntry, "id" | "parentId" | "createdAt" | "seq"> &
  Partial<Pick<TrajectoryEntry, "id" | "createdAt" | "seq">> & {
    /** Golden 轨迹为线性主链，缺省 null。 */
    parentId?: string | null;
  };

/** 轨迹文件结构损坏（权威 Schema 校验失败，带行号定位）。 */
export class TrajectoryFormatError extends Error {
  readonly path: string;
  /** 1-based 行号；0 表示文件级问题。 */
  readonly line: number;

  constructor(path: string, line: number, detail: string) {
    super(`轨迹格式损坏（${path} 第 ${line} 行）: ${detail}`);
    this.name = "TrajectoryFormatError";
    this.path = path;
    this.line = line;
  }
}

export class TrajectoryRecorder {
  readonly #path: string;
  #seq = 0;
  #assistantCount = 0;

  constructor(path: string) {
    this.#path = path;
  }

  /** 轨迹文件路径。 */
  get path(): string {
    return this.#path;
  }

  /**
   * 追加一条轨迹（append-only：单次 write 整行+'\n'，物理记录永不改写）。
   * 自动补全 id/createdAt/seq；assistant 条目自动编号 modelResponse（未显式给时）。
   */
  async record(input: TrajectoryRecordInput): Promise<TrajectoryEntry> {
    if (!isSessionEntryType(input.type)) {
      throw new TypeError(`非法条目类型: ${JSON.stringify(input.type ?? null)}`);
    }
    if (input.payload === undefined) {
      throw new TypeError("payload 不能为 undefined（JSON 值，空值请显式传 null）");
    }
    if (input.modelResponse !== undefined && input.type !== "assistant") {
      throw new TypeError("modelResponse 时序标记只允许出现在 assistant 条目上");
    }

    const entry: TrajectoryEntry = {
      id: input.id ?? uuid7(),
      parentId: input.parentId ?? null,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt ?? Date.now(),
      seq: input.seq ?? this.#seq + 1,
    };
    if (input.toolCallId !== undefined) entry.toolCallId = input.toolCallId;
    if (input.toolName !== undefined) entry.toolName = input.toolName;
    if (input.modelResponse !== undefined) {
      entry.modelResponse = { ...input.modelResponse };
    } else if (input.type === "assistant") {
      entry.modelResponse = { ordinal: this.#assistantCount + 1, at: entry.createdAt };
    }

    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(entry)}\n`, "utf8");
    this.#seq = Math.max(this.#seq, entry.seq);
    if (entry.type === "assistant") this.#assistantCount += 1;
    return entry;
  }

  /**
   * 加载轨迹（权威 Schema 严格校验：任何一行不合法即抛 TrajectoryFormatError；
   * 空文件返回空数组）。
   */
  static async load(path: string): Promise<TrajectoryEntry[]> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new TrajectoryFormatError(path, 0, "轨迹文件不存在");
      }
      throw error;
    }
    return parseTrajectoryContent(path, text);
  }
}

/**
 * 同步解析轨迹全文（权威 Schema 单点校验；TrajectoryRecorder.load 与
 * ShadowReplay 的同步重放共用）。任何一行不合法即抛 TrajectoryFormatError。
 */
export function parseTrajectoryContent(path: string, text: string): TrajectoryEntry[] {
  const entries: TrajectoryEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (raw === undefined || raw.trim().length === 0) continue; // 尾部空行容忍
    const entry = parseTrajectoryLine(path, index + 1, raw);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** 单行解析与白名单校验（不合法抛 TrajectoryFormatError）。 */
function parseTrajectoryLine(path: string, lineNo: number, raw: string): TrajectoryEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TrajectoryFormatError(path, lineNo, "不是合法 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TrajectoryFormatError(path, lineNo, "条目必须是 JSON 对象");
  }
  const rec = value as Record<string, unknown>;
  const { id, parentId, type, payload, createdAt, seq } = rec;
  if (typeof id !== "string" || id.length === 0) {
    throw new TrajectoryFormatError(path, lineNo, "id 缺失或非字符串");
  }
  if (!(parentId === null || (typeof parentId === "string" && parentId.length > 0))) {
    throw new TrajectoryFormatError(path, lineNo, "parentId 必须为 null 或非空字符串");
  }
  if (!isSessionEntryType(type)) {
    throw new TrajectoryFormatError(path, lineNo, `非法条目类型: ${JSON.stringify(type ?? null)}`);
  }
  if (!("payload" in rec)) {
    throw new TrajectoryFormatError(path, lineNo, "payload 缺失");
  }
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    throw new TrajectoryFormatError(path, lineNo, "createdAt 缺失或非有限数");
  }
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new TrajectoryFormatError(path, lineNo, "seq 必须为正整数");
  }
  const entry: TrajectoryEntry = {
    id,
    parentId,
    type: type as SessionEntryType,
    payload: payload as JsonValue,
    createdAt,
    seq,
  };
  if (typeof rec.toolCallId === "string") entry.toolCallId = rec.toolCallId;
  if (typeof rec.toolName === "string") entry.toolName = rec.toolName;
  if (rec.modelResponse !== undefined) {
    const mark = rec.modelResponse;
    if (typeof mark !== "object" || mark === null || Array.isArray(mark)) {
      throw new TrajectoryFormatError(path, lineNo, "modelResponse 必须为对象");
    }
    const m = mark as Record<string, unknown>;
    if (typeof m.ordinal !== "number" || !Number.isInteger(m.ordinal) || m.ordinal < 1) {
      throw new TrajectoryFormatError(path, lineNo, "modelResponse.ordinal 必须为正整数");
    }
    if (typeof m.at !== "number" || !Number.isFinite(m.at)) {
      throw new TrajectoryFormatError(path, lineNo, "modelResponse.at 缺失或非有限数");
    }
    if (entry.type !== "assistant") {
      throw new TrajectoryFormatError(path, lineNo, "modelResponse 只允许出现在 assistant 条目上");
    }
    entry.modelResponse = { ordinal: m.ordinal, at: m.at };
  }
  return entry;
}
