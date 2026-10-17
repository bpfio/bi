/**
 * BI-20.4 —— `bi export --sanitize <id>` / `bi import <archive.json>` 处理器。
 *
 * 形态对齐 BI-20.2 export.ts 的渲染管线（json 直出 + out 落盘 + 结构化错误），
 * 但自含实现，不 import 其私有函数。差异边界：
 *   - export 只走脱敏通道：--sanitize <sessionId>（space / = 两种传值），
 *     缺省输出 `{ meta, entries }` 归档 JSON（2 空格缩进 + 末尾换行）；
 *   - --out <path> 指定则写盘（目录不存在自动创建），content 仍随结果返回；
 *   - import 读取归档文件（JSON.parse），经 importSanitized 重放重建；
 *   - 错误结构化：usage / session-missing / session-corrupt / invalid-archive /
 *     session-exists / file-missing / io-error。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionManager } from "../../session/manager";
import {
  exportSanitized,
  importSanitized,
  TransferError,
} from "../../session/transfer";

export interface TransferExportResult {
  command: "export";
  sessionId: string;
  /** 归档条目数。 */
  entries: number;
  /** 归档 JSON 内容（无论是否落盘都返回）。 */
  content: string;
  /** 指定 --out 时为落盘的绝对路径。 */
  writtenTo?: string;
}

export interface TransferImportResult {
  command: "import";
  sessionId: string;
  /** 重建的条目数。 */
  entries: number;
}

export type TransferCommandResult = TransferExportResult | TransferImportResult;

const USAGE =
  "用法: bi export --sanitize <sessionId> [--out <path>] | bi import <archive.json>";

/** 脱敏导出 / 归档导入的 CLI 处理器。 */
export async function transferCommand(
  manager: SessionManager,
  args: readonly string[],
): Promise<TransferCommandResult> {
  const sub = args[0];
  if (sub === "export") return exportHandler(manager, args.slice(1));
  if (sub === "import") return importHandler(manager, args.slice(1));
  throw new TransferError("usage", USAGE);
}

function usageError(message: string): TransferError {
  return new TransferError("usage", `${message}\n${USAGE}`);
}

async function exportHandler(
  manager: SessionManager,
  rest: readonly string[],
): Promise<TransferExportResult> {
  let sanitize: string | undefined;
  let out: string | undefined;
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    i += 1;
    if (token === undefined) break; // noUncheckedIndexedAccess 防御
    if (token === "--sanitize" || token.startsWith("--sanitize=")) {
      // space 形式消费下一个 token；等号形式不额外前进。
      const value = token === "--sanitize" ? rest[i++] : token.slice("--sanitize=".length);
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw usageError("--sanitize 需要 <sessionId>");
      }
      if (sanitize !== undefined) throw usageError("--sanitize 重复出现");
      sanitize = value;
      continue;
    }
    if (token === "--out" || token.startsWith("--out=")) {
      const value = token === "--out" ? rest[i++] : token.slice("--out=".length);
      if (value === undefined || value === "" || value.startsWith("-")) {
        throw usageError("--out 需要 <path>");
      }
      if (out !== undefined) throw usageError("--out 重复出现");
      out = value;
      continue;
    }
    throw usageError(`未知参数: ${token}`);
  }
  if (sanitize === undefined) throw usageError("缺少 --sanitize <sessionId>");

  const archive = await exportSanitized(manager, sanitize);
  const content = `${JSON.stringify(archive, null, 2)}\n`;
  const result: TransferExportResult = {
    command: "export",
    sessionId: sanitize,
    entries: archive.entries.length,
    content,
  };

  if (out !== undefined) {
    const target = resolve(out);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    } catch (error) {
      throw new TransferError("io-error", `归档写盘失败 (${target}): ${errorMessage(error)}`);
    }
    result.writtenTo = target;
  }
  return result;
}

async function importHandler(
  manager: SessionManager,
  rest: readonly string[],
): Promise<TransferImportResult> {
  if (rest.length !== 1) throw usageError("import 需要恰好一个归档路径");
  const path = rest[0];
  if (path === undefined || path === "" || path.startsWith("-")) {
    throw usageError("import 需要 <archive.json> 路径");
  }

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new TransferError("file-missing", `归档文件不存在: ${path}`);
    }
    throw new TransferError("io-error", `归档读取失败 (${path}): ${errorMessage(error)}`);
  }

  let archive: unknown;
  try {
    archive = JSON.parse(text) as unknown;
  } catch {
    throw new TransferError("invalid-archive", `归档不是合法 JSON: ${path}`);
  }

  const imported = await importSanitized(archive, manager);
  return {
    command: "import",
    sessionId: imported.sessionId,
    entries: imported.entries.length,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
