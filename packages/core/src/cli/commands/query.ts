/**
 * F-ST-07 —— `bi query` 子命令：会话语料检索（SessionQueryEngine 的 CLI 薄壳）。
 *
 * 设计要点：
 *   - 检索本体在库（packages/core/src/session/query/：compileFilter + SqliteCorpus），
 *     本模块只做「argv → 重建索引 → 执行表达式 → 逐行 JSON」的外壳，不复制过滤语义：
 *       1) rebuildIndex(sessionsRoot) 重建 SQLite 语料（幂等，索引落临时目录，不污染会话根）；
 *       2) search(expr) 走库内谓词执行（keyset 分页，--limit 截断）；
 *       3) 命中逐行 JSON 写 stdout，汇总计数写 stderr（stdout 只出数据，管道友好）。
 *   - 退出码：0 成功（含「无会话 → 空集 + stderr 提示」）/ 2 用法错误
 *     （表达式非法复用 FilterSyntaxError 的结构化 code；参数缺失/非法同理）。
 *   - nodeId 说明：语料表（entries）不存条目 node id（schema 面固定），故本模块按
 *     与灌入完全同序同过滤的规则重扫会话文件，建「语料行号 → nodeId」映射
 *     （行号 = SQLite entries.id，自 1 起，与 ingest 插入序一致）。
 *
 * 测试零外呼：会话根、索引库均为临时目录，测试注入 sessionsRoot 即可。
 */
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSessionsRoot } from "../../session/manager";
import {
  FilterSyntaxError,
  SessionQueryEngine,
  compileFilter,
  type CorpusEntry,
} from "../../session/query/query-engine";

/** 语料检索页大小上限（与 SqliteCorpus 的 MAX_PAGE_SIZE 同口径）。 */
const MAX_PAGE_SIZE = 1000;
/** 摘要字段最大长度（超长截断，附省略标记）。 */
const SUMMARY_MAX_CHARS = 200;

/** query 用法错误（dispatch 按类名兜底捕获 → exit 2）。 */
export class SubUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubUsageError";
  }
}

/** 命中条目（stdout 每行一个 JSON）。 */
export interface QueryHit {
  /** 所属会话 id。 */
  sessionId: string;
  /** 会话树节点 id（条目 id；源条目缺 id 时为 null）。 */
  nodeId: string | null;
  /** 条目类型：user / assistant / tool_call / tool_result / system / compaction。 */
  type: string;
  /** 工具名（非工具条目为 null）。 */
  tool: string | null;
  /** 条目时间（ISO 8601）。 */
  ts: string;
  /** 文本摘要（空白折叠 + 超长截断）。 */
  summary: string;
}

/** 语料行号 → 节点信息（重扫会话文件建映射，见文件头说明）。 */
interface RowNode {
  nodeId: string | null;
  /** 条目正文（可读文本；语料文本的兜底在 toHit 里）。 */
  text: string;
}

/** 子命令轻量参数解析结果。 */
interface QueryArgs {
  positionals: string[];
  flags: Map<string, string>;
}

/**
 * 解析 `bi query "<表达式>" [--limit <n>]`：
 * 位置参数 = 过滤表达式（恰一个，含空格需引号）；`--limit <n>` / `--limit=<n>`。
 */
export function parseQueryArgs(rest: readonly string[]): QueryArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    i += 1;
    if (token === undefined) break;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (flag !== "--limit") throw new SubUsageError(`未知参数: ${token}`);
    const raw = eq === -1 ? rest[i++] : token.slice(eq + 1);
    if (raw === undefined || raw.length === 0) throw new SubUsageError("参数 --limit 缺少值");
    if (flags.has(flag)) throw new SubUsageError(`参数重复: ${flag}`);
    flags.set(flag, raw);
  }
  return { positionals, flags };
}

/** 折叠空白并截断（摘要字段）。 */
export function summarize(text: string, maxChars: number = SUMMARY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}...` : flat;
}

/** 单行扫描结果（与语料灌入的接受条件逐条对齐）。 */
type LineScan =
  | { kind: "meta"; sessionId: string }
  | { kind: "entry"; nodeId: string | null; text: string }
  | { kind: "skip" };

/**
 * 提取条目可读正文：常见文本键优先（text / result / summary / output / error），
 * content 文本块数组取块内 text；均无则退 JSON 串（与语料 extractText 同源，
 * 但对 content 数组更友好——assistant 条目的正文不被包成裸 JSON 串）。
 */
function extractDisplayText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    for (const key of ["text", "result", "summary", "output", "error"] as const) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
    const content = record.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (typeof block === "string") {
          parts.push(block);
          continue;
        }
        if (typeof block === "object" && block !== null) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") parts.push(text);
        }
      }
      if (parts.length > 0) return parts.join(" ");
    }
  }
  return JSON.stringify(payload) ?? "";
}

/**
 * 单行扫描：判该行是否进语料（进 → 返回条目 node id 与正文）。
 * 接受条件与 SqliteCorpus.ingest 一致：kind=entry + entry 为普通对象 +
 * type 为字符串 + createdAt 为数字 + 已见 meta 的 sessionId。
 */
function scanLine(line: string): LineScan {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "skip" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { kind: "skip" }; // 残缺行跳过
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "skip" };
  const record = value as Record<string, unknown>;
  if (record.kind === "meta") {
    return typeof record.sessionId === "string" && record.sessionId.length > 0
      ? { kind: "meta", sessionId: record.sessionId }
      : { kind: "skip" };
  }
  if (record.kind !== "entry") return { kind: "skip" };
  const entry = record.entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { kind: "skip" };
  const e = entry as Record<string, unknown>;
  if (typeof e.type !== "string" || typeof e.createdAt !== "number") return { kind: "skip" };
  const nodeId = typeof e.id === "string" && e.id.length > 0 ? e.id : null;
  return { kind: "entry", nodeId, text: extractDisplayText(e.payload) };
}

/**
 * 重扫会话文件 → 「语料行号 → nodeId」映射。
 * 行号口径：文件按名排序、逐行物理序、只计与语料灌入同条件的条目 = SQLite entries.id。
 */
export async function scanRowNodes(sessionsRoot: string): Promise<Map<number, RowNode>> {
  const map = new Map<number, RowNode>();
  let names: string[];
  try {
    names = await readdir(sessionsRoot);
  } catch {
    return map;
  }
  let rowId = 0;
  for (const name of names.filter((file) => file.endsWith(".jsonl")).sort()) {
    let sessionId = "";
    let buffer = "";
    try {
      const stream = createReadStream(join(sessionsRoot, name), { encoding: "utf8" });
      for await (const chunk of stream) {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          const scan = scanLine(line);
          if (scan.kind === "meta") {
            sessionId = scan.sessionId;
          } else if (scan.kind === "entry" && sessionId.length > 0) {
            rowId += 1;
            map.set(rowId, { nodeId: scan.nodeId, text: scan.text });
          }
        }
      }
      if (buffer.length > 0) {
        // 无换行结尾的末行：语料灌入照收，本扫描同口径。
        const scan = scanLine(buffer);
        if (scan.kind === "meta") {
          sessionId = scan.sessionId;
        } else if (scan.kind === "entry" && sessionId.length > 0) {
          rowId += 1;
          map.set(rowId, { nodeId: scan.nodeId, text: scan.text });
        }
      }
    } catch {
      continue; // 文件不可读：跳过（语料侧失败会在 rebuildIndex 阶段先报）
    }
  }
  return map;
}

/** 语料条目 → 命中记录（nodeId 缺失时为 null，绝不伪造）。 */
export function toHit(entry: CorpusEntry, nodes: Map<number, RowNode>): QueryHit {
  const row = nodes.get(entry.id);
  return {
    sessionId: entry.sessionId,
    nodeId: row?.nodeId ?? null,
    type: entry.type,
    tool: entry.tool,
    ts: entry.ts,
    summary: summarize(row?.text ?? entry.text),
  };
}

/** 按表达式检索（keyset 分页取全；--limit 截断）。 */
export function collectHits(
  engine: SessionQueryEngine,
  expr: string,
  limit: number | undefined,
): CorpusEntry[] {
  const items: CorpusEntry[] = [];
  if (limit === 0) return items;
  const pageSize = limit === undefined ? MAX_PAGE_SIZE : Math.min(limit, MAX_PAGE_SIZE);
  let cursor = 0;
  for (;;) {
    const page = engine.search(expr, { cursor, pageSize });
    items.push(...page.items);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    if (limit !== undefined && items.length >= limit) break;
  }
  if (limit !== undefined && items.length > limit) items.length = limit;
  return items;
}

/**
 * `bi query "<表达式>" [--limit <n>]`：重建索引 → 执行表达式 → 命中逐行 JSON（stdout）
 * + 汇总计数（stderr）。表达式非法 → 结构化 exit 2；无会话 → exit 0 空集 + stderr 提示。
 */
export async function handleQuery(
  rest: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void },
  deps: { sessionsRoot?: string } = {},
): Promise<number> {
  const args = parseQueryArgs(rest);
  if (args.positionals.length !== 1) {
    throw new SubUsageError('用法: bi query "<表达式>" [--limit <n>]（表达式含空格需加引号）');
  }
  const expr = args.positionals[0] as string;
  let limit: number | undefined;
  const rawLimit = args.flags.get("--limit");
  if (rawLimit !== undefined) {
    if (!/^\d+$/.test(rawLimit)) {
      throw new SubUsageError(`--limit 需要非负整数: ${rawLimit}`);
    }
    limit = Number.parseInt(rawLimit, 10);
  }

  // 表达式合法性前置校验（不因会话根为空而放过非法表达式）。
  try {
    compileFilter(expr);
  } catch (cause) {
    if (cause instanceof FilterSyntaxError) {
      io.err(`bi query: 表达式非法 [${cause.code}]: ${cause.message}`);
      return 2;
    }
    throw cause;
  }

  const sessionsRoot = deps.sessionsRoot ?? defaultSessionsRoot();
  // 索引库落临时目录（不污染会话根；用完即删）。
  const workDir = await mkdtemp(join(tmpdir(), "bi-query-"));
  try {
    const engine = new SessionQueryEngine({ dbPath: join(workDir, "index.db") });
    try {
      const rebuilt = await engine.rebuildIndex(sessionsRoot);
      if (rebuilt.sessions === 0) {
        io.err(`bi query: 会话根无会话文件（${sessionsRoot}）——索引 0 会话 / 0 条目`);
        return 0;
      }
      let items: CorpusEntry[];
      try {
        items = collectHits(engine, expr, limit);
      } catch (cause) {
        if (cause instanceof FilterSyntaxError) {
          io.err(`bi query: 表达式非法 [${cause.code}]: ${cause.message}`);
          return 2;
        }
        throw cause;
      }
      const nodes = await scanRowNodes(sessionsRoot);
      for (const item of items) {
        io.out(JSON.stringify(toHit(item, nodes)));
      }
      io.err(
        `bi query: 命中 ${items.length} 条（索引 ${rebuilt.sessions} 会话 / ${rebuilt.entries} 条目）`,
      );
      return 0;
    } finally {
      engine.close();
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
