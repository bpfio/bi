/**
 * external-editor —— 外部编辑器唤醒（临时文件 + 注入 spawn）。
 *
 * BI-19.5 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 流程：初始文本落盘临时文件（默认名 prompt.md）→ 按编辑器探测顺序
 *   VISUAL > EDITOR > vi（空值视为未设）解析命令 → 注入 spawn 等待退出
 *   （exit code 非 0 抛结构化错误）→ 读回正文 → UTF-8 BOM 剥离 →
 *   返回 { text, modified }（modified 与剥离后的正文对比）；
 * - 临时文件清理在 finally 中执行（编辑器异常退出/写盘失败也保证清理）；
 * - 编辑器命令带参数支持：按 shell 风格 token 拆分（支持引号聚合空格，
 *   如 `code -w` → ["code","-w"]、`"my editor" -w` → ["my editor","-w"]）；
 * - 零外部 npm 依赖：缺省 fs/spawn 用 node 内建实现；测试全量注入
 *   fs/spawn stub（离屏，不真开编辑器）。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { writeFile as fsWriteFile, readFile as fsReadFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/** 编辑器子进程最小契约（node ChildProcess 或测试 stub 均可注入）。 */
export interface EditorProcessLike {
  on(event: "exit", listener: (code: number | null) => void): unknown;
}

export type EditorSpawnFn = (
  command: string,
  args: string[],
  opts: { readonly env: Record<string, string | undefined> },
) => EditorProcessLike;

/** 文件系统最小契约（缺省 node:fs 实现；测试注入 spy 记录调用）。 */
export interface EditorFileSystem {
  tmpPath(suffix?: string): string;
  writeFile(path: string, text: string): void | Promise<void>;
  readFile(path: string): string | Promise<string>;
  unlink(path: string): void | Promise<void>;
}

export interface ExternalEditorOptions {
  /** 环境快照（缺省 {...process.env}；测试显式注入 VISUAL/EDITOR）。 */
  readonly env?: Record<string, string | undefined>;
  /** spawn 注入（缺省 node:child_process.spawn，stdio inherit）。 */
  readonly spawn?: EditorSpawnFn;
  /** 文件系统注入（缺省 node:fs/promises + os.tmpdir）。 */
  readonly fs?: EditorFileSystem;
  /** 临时文件名（默认 prompt.md）。 */
  readonly fileName?: string;
}

export interface EditResult {
  /** 编辑后的正文（UTF-8 BOM 已剥离）。 */
  readonly text: string;
  /** 正文是否被编辑器修改（与初始文本对比）。 */
  readonly modified: boolean;
}

/** UTF-8 BOM（ZWNBSP）剥离。 */
export function stripUtf8Bom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 编辑器命令 token 拆分：空白分词，成对单/双引号聚合空格。
 * `code -w` → ["code","-w"]；`"my editor" -w` → ["my editor","-w"]。
 */
export function tokenizeEditorCommand(spec: string): string[] {
  const out: string[] = [];
  let cur = "";
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of spec) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (hasToken) {
        out.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) out.push(cur);
  return out;
}

/** 编辑器探测顺序 VISUAL > EDITOR > vi（空值/纯空白视为未设）。 */
export function resolveEditorSpec(env: Record<string, string | undefined>): string {
  for (const key of ["VISUAL", "EDITOR"] as const) {
    const value = env[key];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return "vi";
}

/** 缺省文件系统实现（unlink 容忍 ENOENT：文件未落盘时视为已清理）。 */
const defaultFs: EditorFileSystem = {
  tmpPath(suffix = "prompt.md"): string {
    return join(tmpdir(), `bi-edit-${process.pid}-${randomUUID()}-${suffix}`);
  },
  writeFile: (path, text) => fsWriteFile(path, text, "utf-8"),
  readFile: (path) => fsReadFile(path, "utf-8"),
  unlink: async (path) => {
    try {
      await fsUnlink(path);
    } catch {
      // 文件不存在即已清理，不掩盖主流程错误。
    }
  },
};

const defaultSpawn: EditorSpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, { env: opts.env, stdio: "inherit" });

/** 等待编辑器进程退出（exit 事件 → Promise）。 */
function runEditor(
  spawn: EditorSpawnFn,
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    let child: EditorProcessLike;
    try {
      child = spawn(command, args, { env });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    child.on("exit", (code) => resolve(code));
  });
}

/**
 * 唤起外部编辑器编辑 initialText，返回编辑结果。
 * 临时文件在 finally 中清理；编辑器异常退出（非 0/非 null）抛 Error 且
 * 仍保证清理。
 */
export async function editExternally(
  initialText: string,
  opts: ExternalEditorOptions = {},
): Promise<EditResult> {
  const env = opts.env ?? { ...process.env };
  const fs = opts.fs ?? defaultFs;
  const spawn = opts.spawn ?? defaultSpawn;
  const fileName = opts.fileName ?? "prompt.md";
  const spec = resolveEditorSpec(env);
  const [command = "", ...args] = tokenizeEditorCommand(spec);
  if (command.length === 0) {
    throw new Error(`外部编辑器命令解析为空: "${spec}"`);
  }
  const path = fs.tmpPath(fileName);
  try {
    await fs.writeFile(path, initialText);
    const code = await runEditor(spawn, command, args, env);
    if (code !== 0) {
      throw new Error(`外部编辑器异常退出: ${command} (exit ${String(code)})`);
    }
    const raw = await fs.readFile(path);
    const text = stripUtf8Bom(typeof raw === "string" ? raw : String(raw));
    return { text, modified: text !== initialText };
  } finally {
    await fs.unlink(path);
  }
}
