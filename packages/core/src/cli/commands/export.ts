/**
 * BI-20.2 / BI-20.3 —— `export` 子命令（会话导出：markdown / json / html）。
 *
 * kimi 对应物: apps/kimi-code/src/cli/sub/export.ts
 * 差异边界:
 *   - 会话读取一律经 BI-03 SessionManager（loadSession，含末尾残缺行容忍），
 *     CLI 层不重复实现存储解析；
 *   - markdown 渲染：user/assistant/tool 分节标题 + 正文；工具调用折叠为
 *     单行 `> tool: name(args 摘要)`（args 摘要超长截断，见 ARGS_SUMMARY_MAX）；
 *   - json 为 `{ meta, entries }` 结构化直出（2 空格缩进 + 末尾换行）；
 *   - html 为单文件自含会话报告（见 ../../export/html-exporter.ts：
 *     内联 CSS、Dark 默认、工具调用 <details> 折叠、代码/diff <pre><code> 纯文本、
 *     零依赖零外链）；分支持渲染复用本文件既有 entries 链路；
 *   - out 指定则写盘（目录不存在自动创建），content 仍随结果返回；
 *     缺省只返回字符串不落盘；
 *   - 错误结构化：session-missing / session-corrupt / invalid-format / io-error
 *     （引擎级 SessionFileCorruptError 归一为 session-corrupt）。
 *
 * 消费接线（CLI argv → 本模块）归属 BI-20.1 / 后续装配方；本卡只提供库面。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  SessionFileCorruptError,
  SessionNotFoundError,
  type SessionManager,
} from "../../session/manager";
import type { JsonValue, LoadedSession, SessionEntry, SessionMeta } from "../../session/types";
import { renderHtml } from "../../export/html-exporter";

export type ExportFormat = "markdown" | "json" | "html";

const EXPORT_FORMATS: readonly ExportFormat[] = ["markdown", "json", "html"];

/** tool_call 参数摘要的截断上限（JSON 字符数，超长以 … 结尾）。 */
const ARGS_SUMMARY_MAX = 120;

export interface ExportOptions {
  /** 输出格式，缺省 markdown。 */
  format?: ExportFormat;
  /** 输出文件路径（目录不存在自动创建）；缺省只返回字符串。 */
  out?: string;
}

export interface ExportResult {
  /** 导出内容（无论是否落盘都返回）。 */
  content: string;
  /** 指定 out 时为落盘的绝对路径。 */
  writtenTo?: string;
}

export type ExportErrorCode =
  | "session-missing"
  | "session-corrupt"
  | "invalid-format"
  | "io-error";

export class ExportError extends Error {
  constructor(
    readonly code: ExportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

/** 导出会话：markdown 渲染或 json 直出；out 指定时落盘。 */
export async function exportSession(
  manager: SessionManager,
  sessionId: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const format = opts.format ?? "markdown";
  if (!EXPORT_FORMATS.includes(format)) {
    throw new ExportError(
      "invalid-format",
      `非法导出格式: ${String(format)}（允许: ${EXPORT_FORMATS.join(", ")}）`,
    );
  }

  let loaded: LoadedSession;
  try {
    loaded = await manager.loadSession(sessionId);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new ExportError("session-missing", `会话不存在: ${sessionId}`);
    }
    if (error instanceof SessionFileCorruptError) {
      throw new ExportError("session-corrupt", errorMessage(error));
    }
    throw error;
  }

  const content =
    format === "json"
      ? renderJson(loaded.meta, loaded.entries)
      : format === "html"
        ? renderHtml(loaded.meta, loaded.entries)
        : renderMarkdown(loaded.meta, loaded.entries);

  if (opts.out === undefined) {
    return { content };
  }
  const target = resolve(opts.out);
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  } catch (error) {
    throw new ExportError("io-error", `导出写盘失败 (${target}): ${errorMessage(error)}`);
  }
  return { content, writtenTo: target };
}

/** markdown 渲染：头部元信息 + 每条目分节（工具调用折叠单行）。 */
function renderMarkdown(meta: SessionMeta, entries: readonly SessionEntry[]): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title}`, "");
  lines.push(`- 会话: ${meta.sessionId}`);
  lines.push(`- 创建: ${new Date(meta.createdAt).toISOString()}`);
  if (meta.cwd !== undefined) lines.push(`- 工作目录: ${meta.cwd}`);
  if (meta.forkedFrom !== undefined) lines.push(`- 分叉自: ${meta.forkedFrom}`);
  lines.push(`- 条目: ${entries.length}`, "");

  if (entries.length === 0) {
    lines.push("（空会话：无条目）", "");
  }
  for (const entry of entries) {
    lines.push("---", "");
    const nameSuffix = entry.toolName !== undefined ? ` ${entry.toolName}` : "";
    lines.push(`## [${entry.type}]${nameSuffix} #${entry.seq}`, "");
    if (entry.type === "tool_call") {
      lines.push(`> tool: ${entry.toolName ?? "unknown"}(${argsSummary(entry.payload)})`, "");
    } else {
      lines.push(entryBody(entry.payload), "");
    }
  }
  return lines.join("\n");
}

/** json 直出：{ meta, entries }，稳定缩进 + 末尾换行。 */
function renderJson(meta: SessionMeta, entries: readonly SessionEntry[]): string {
  return `${JSON.stringify({ meta, entries }, null, 2)}\n`;
}

/** 正文提取：字符串原样；对象取 text 字段；其余 JSON 缩进打印。 */
function entryBody(payload: JsonValue): string {
  if (typeof payload === "string") return payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const text = payload["text"];
    if (typeof text === "string") return text;
  }
  return JSON.stringify(payload, null, 2);
}

/** tool_call 参数摘要：优先 payload.args，紧凑 JSON，超长截断。 */
function argsSummary(payload: JsonValue): string {
  let raw: JsonValue = payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const args = payload["args"];
    if (args !== undefined) raw = args;
  }
  const text = JSON.stringify(raw);
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX)}…` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
