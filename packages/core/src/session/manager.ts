/**
 * Append-only JSONL 树状会话引擎（BI-03）。
 *
 * 设计要点：
 *   - 落盘 `<rootDir>/<sessionId>.jsonl`（rootDir 可注入，默认 ~/.bi/sessions）；
 *   - 追加 = 单次 write(整行+`\n`) + fh.sync()（fsync），抗掉电；
 *   - 加载容忍末尾残缺行：丢弃残缺区、报告截断位点，下次追加前先物理截断到干净边界；
 *   - 树状结构：每条记录携带 UUIDv7 id/parentId，支持 append/fork/history/rewindTo；
 *   - append-only 铁律：rewindTo 与一切操作均不删除物理历史。
 *
 * 并发假设：单进程单实例持有会话目录（CLI 场景）；跨进程文件锁归属后续卡片。
 */
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatEntryRecord, formatMetaRecord, parseSessionFileContent } from "./jsonl";
import type {
  AppendEntryInput,
  ForkResult,
  LoadedSession,
  RewindCursor,
  SessionEntry,
  SessionMeta,
} from "./types";
import { isSessionEntryType } from "./types";
import { uuid7 } from "./uuid7";

/** 会话存储根目录默认值：~/.bi/sessions。 */
export function defaultSessionsRoot(): string {
  return join(homedir(), ".bi", "sessions");
}

/** 会话 id 即文件名，白名单字符防路径穿越。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const DEFAULT_TITLE = "未命名会话";

export interface SessionManagerOptions {
  /** 会话存储根目录；默认 ~/.bi/sessions。测试必须注入临时目录。 */
  rootDir?: string;
  /** 时间源（测试/回放注入）；默认 Date.now。 */
  now?: () => number;
  /** id 生成器（测试注入）；默认 uuid7。 */
  generateId?: () => string;
}

export interface CreateSessionInput {
  /** 会话标题；默认「未命名会话」。 */
  title?: string;
  /** 创建会话时的工作目录。 */
  cwd?: string;
  /** 显式指定会话 id（默认自动生成 UUIDv7）。 */
  sessionId?: string;
}

export interface ForkSessionInput {
  /** 新会话标题；默认「<源标题> (fork)」。 */
  title?: string;
}

/** 会话不存在。 */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`会话不存在: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

/** 会话文件结构性损坏（无法定位干净恢复点）。 */
export class SessionFileCorruptError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`会话文件损坏（${sessionId}）: ${detail}`);
    this.name = "SessionFileCorruptError";
  }
}

export class SessionManager {
  readonly #rootDir: string;
  readonly #now: () => number;
  readonly #generateId: () => string;

  constructor(options: SessionManagerOptions = {}) {
    this.#rootDir = options.rootDir ?? defaultSessionsRoot();
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? uuid7;
  }

  /** 存储根目录（测试与上层工具用）。 */
  get rootDir(): string {
    return this.#rootDir;
  }

  /** 创建新会话：写入 meta 首行并 fsync。文件以独占方式创建，不覆盖已有会话。 */
  async createSession(init: CreateSessionInput = {}): Promise<SessionMeta> {
    const sessionId = init.sessionId ?? this.#generateId();
    assertSafeSessionId(sessionId);
    const meta: SessionMeta = {
      sessionId,
      title: init.title ?? DEFAULT_TITLE,
      createdAt: this.#now(),
    };
    if (init.cwd !== undefined) meta.cwd = init.cwd;

    await mkdir(this.#rootDir, { recursive: true });
    let fh: FileHandle;
    try {
      fh = await open(this.#pathOf(sessionId), "wx");
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new Error(`会话已存在: ${sessionId}`);
      }
      throw error;
    }
    try {
      await fh.writeFile(Buffer.from(formatMetaRecord(meta) + "\n", "utf8"));
      await fh.sync();
    } finally {
      await fh.close();
    }
    return meta;
  }

  /**
   * 加载会话：解析全文件，容忍末尾残缺行（丢弃并返回截断位点 cleanLength，
   * 下次追加前会先物理截断到该干净边界）。
   */
  async loadSession(sessionId: string): Promise<LoadedSession> {
    assertSafeSessionId(sessionId);
    let buf: Buffer;
    try {
      buf = await readFile(this.#pathOf(sessionId));
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new SessionNotFoundError(sessionId);
      throw error;
    }
    const parsed = parseSessionFileContent(buf);
    if (!parsed.ok) {
      const detail = parsed.reason === "empty" ? "空文件（meta 行缺失）" : "meta 行残缺或损坏";
      throw new SessionFileCorruptError(sessionId, detail);
    }
    if (parsed.meta.sessionId !== sessionId) {
      throw new SessionFileCorruptError(
        sessionId,
        `meta.sessionId="${parsed.meta.sessionId}" 与文件名不符`,
      );
    }
    return {
      meta: parsed.meta,
      entries: parsed.entries,
      truncated: parsed.truncated,
      cleanLength: parsed.cleanLength,
    };
  }

  /** 会话全部干净条目（按 seq 升序）。 */
  async entries(sessionId: string): Promise<SessionEntry[]> {
    return (await this.loadSession(sessionId)).entries;
  }

  /** 会话元数据；不存在返回 undefined。 */
  async getSessionMeta(sessionId: string): Promise<SessionMeta | undefined> {
    try {
      return (await this.loadSession(sessionId)).meta;
    } catch (error) {
      if (error instanceof SessionNotFoundError) return undefined;
      throw error;
    }
  }

  /**
   * 追加条目：校验父节点存在（null 仅允许作为首条目根），分配 id/createdAt/seq，
   * 整行单次写入 + fsync；若文件存在崩溃残留区，先截断到干净边界。
   */
  async append(
    sessionId: string,
    parentId: string | null,
    input: AppendEntryInput,
  ): Promise<SessionEntry> {
    assertSafeSessionId(sessionId);
    if (!isSessionEntryType(input.type)) {
      throw new Error(`非法条目类型: ${JSON.stringify(input.type ?? null)}`);
    }
    if (input.payload === undefined) {
      throw new Error("payload 不能为 undefined（JSON 值，空值请显式传 null）");
    }

    const loaded = await this.loadSession(sessionId);
    if (parentId === null) {
      if (loaded.entries.length > 0) {
        throw new Error(
          `会话 ${sessionId} 已存在根条目，不允许第二个根（请把新条目挂到已有节点）`,
        );
      }
    } else if (!loaded.entries.some((entry) => entry.id === parentId)) {
      throw new Error(`父节点不存在: ${parentId}（会话 ${sessionId}）`);
    }

    const lastEntry = loaded.entries.at(-1);
    const entry: SessionEntry = {
      id: this.#generateId(),
      parentId,
      type: input.type,
      payload: input.payload,
      createdAt: this.#now(),
      seq: lastEntry !== undefined ? lastEntry.seq + 1 : 1,
    };
    if (input.toolCallId !== undefined) entry.toolCallId = input.toolCallId;
    if (input.toolName !== undefined) entry.toolName = input.toolName;

    await this.#appendLine(sessionId, formatEntryRecord(entry), loaded.cleanLength);
    return entry;
  }

  /**
   * 沿 parent 链从 nodeId 回溯到根，返回 根 → nodeId 顺序的路径。
   * 链断裂或成环按文件损坏处理。
   */
  async history(sessionId: string, nodeId: string): Promise<SessionEntry[]> {
    const entries = await this.entries(sessionId);
    const byId = new Map(
      entries.map((entry): [string, SessionEntry] => [entry.id, entry]),
    );
    const path: SessionEntry[] = [];
    const seen = new Set<string>();
    let cursor = byId.get(nodeId);
    while (cursor !== undefined) {
      if (seen.has(cursor.id)) {
        throw new SessionFileCorruptError(sessionId, `parentId 链成环（节点 ${cursor.id}）`);
      }
      seen.add(cursor.id);
      path.push(cursor);
      if (cursor.parentId === null) break;
      const parent = byId.get(cursor.parentId);
      if (parent === undefined) {
        throw new SessionFileCorruptError(
          sessionId,
          `节点 ${cursor.id} 的父节点 ${cursor.parentId} 缺失`,
        );
      }
      cursor = parent;
    }
    if (path.length === 0) {
      throw new Error(`节点不存在: ${nodeId}（会话 ${sessionId}）`);
    }
    return path.reverse();
  }

  /**
   * 从任意节点开分支：把源会话 根 → nodeId 路径整体拷贝进新会话文件
   * （append-only 复制，id/parentId 保持不变，seq 重排），返回新 sessionId。
   * 源会话文件不受影响。
   */
  async fork(sessionId: string, nodeId: string, init: ForkSessionInput = {}): Promise<ForkResult> {
    const source = await this.loadSession(sessionId);
    const path = await this.history(sessionId, nodeId);
    const newSessionId = this.#generateId();
    const meta: SessionMeta = {
      sessionId: newSessionId,
      title: init.title ?? `${source.meta.title} (fork)`,
      createdAt: this.#now(),
      forkedFrom: sessionId,
    };
    if (source.meta.cwd !== undefined) meta.cwd = source.meta.cwd;

    await mkdir(this.#rootDir, { recursive: true });
    let fh: FileHandle;
    try {
      fh = await open(this.#pathOf(newSessionId), "wx");
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        throw new Error(`会话已存在: ${newSessionId}`);
      }
      throw error;
    }
    try {
      const lines = [formatMetaRecord(meta)];
      path.forEach((entry, i) => {
        lines.push(formatEntryRecord({ ...entry, seq: i + 1 }));
      });
      await fh.writeFile(Buffer.from(lines.join("\n") + "\n", "utf8"));
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { sessionId: newSessionId, forkedFrom: sessionId, branchTip: nodeId, copied: path.length };
  }

  /**
   * 时光倒流：不删除任何物理历史，仅校验目标节点并返回应继续的分支游标。
   * 后续以 cursor.nextParentId 作为 append 的 parentId，即在 nodeId 下开新分支。
   */
  async rewindTo(sessionId: string, nodeId: string): Promise<RewindCursor> {
    const entries = await this.entries(sessionId);
    if (!entries.some((entry) => entry.id === nodeId)) {
      throw new Error(`节点不存在: ${nodeId}（会话 ${sessionId}）`);
    }
    const path = await this.history(sessionId, nodeId);
    return {
      sessionId,
      nodeId,
      nextParentId: nodeId,
      pathLength: path.length,
      totalEntries: entries.length,
    };
  }

  /** 列出全部会话元数据（最新在前；损坏文件跳过，不拖垮列表）。 */
  async listSessions(): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.#rootDir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      try {
        metas.push((await this.loadSession(sessionId)).meta);
      } catch {
        // 单个坏文件不拖垮会话列表。
      }
    }
    metas.sort((a, b) => b.createdAt - a.createdAt || (a.sessionId > b.sessionId ? -1 : 1));
    return metas;
  }

  /** 追加一行：若存在崩溃残留区先截断到干净边界；整行单次写入 + fsync。 */
  async #appendLine(sessionId: string, line: string, cleanLength: number): Promise<void> {
    const fh = await open(this.#pathOf(sessionId), "a");
    try {
      const size = (await fh.stat()).size;
      if (size > cleanLength) {
        // 超出旧净边界≠必为崩溃残留——并发写者可能刚追加了完整合法条目。
        // 重解析全文件:成功则以新净边界为准(保留并发数据,只截真正撕裂的尾巴);
        // 解析失败(meta 损坏)才回退旧口径截到旧边界。
        const reparsed = parseSessionFileContent(await readFile(this.#pathOf(sessionId)));
        const safeCut = reparsed.ok ? reparsed.cleanLength : cleanLength;
        if (size > safeCut) {
          await fh.truncate(safeCut);
        }
      }
      await fh.writeFile(Buffer.from(line + "\n", "utf8"));
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  #pathOf(sessionId: string): string {
    return join(this.#rootDir, `${sessionId}.jsonl`);
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`非法会话 id（只允许 [A-Za-z0-9._-]，且不以符号开头）: ${sessionId}`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}
