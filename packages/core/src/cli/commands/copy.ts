/**
 * BI-24.x —— `bi copy` 子命令：低频清账，把会话字段复制到剪贴板（或 stdout 降级）。
 *
 * 动作面：
 *   bi copy [sessionId] [-f field]   缺省复制「最近会话」的 id 到剪贴板；
 *                                     field 可选 id | title | last-reply
 *                                     （last-reply = 会话末条 assistant 文本）；
 *                                     sessionId 给定则复制该会话对应字段。
 *
 * 剪贴板落地策略（诚实，不假冒）：
 *   按平台探测 OSTYPE——
 *     Linux   走 xclip / wl-copy（存在才用，run(<tool>, ["-version"], 2>/dev/null) 探活）；
 *     macOS   走 pbcopy；
 *     Windows 走 clip；
 *   全部缺失 = 降级为 stdout 直出 + 结构化提示「剪贴板工具缺失，已打印到 stdout」。
 *
 * 注入面：
 *   - cmdRunner：执行外部命令（探活 + 写入剪贴板）；测试注入替身，零外呼真实进程；
 *   - platform / osType：平台覆盖（缺省由 OSTYPE/process.platform 探测），测试注入以
 *     覆盖三平台分派与全缺失降级；绝不触碰真实 ~/.bi 与真实剪贴板。
 *
 * 结构化错误（对齐 config/fork 既有子命令风格）：
 *   session-missing   会话不存在；
 *   invalid-field    -f 非法字段（允许 id | title | last-reply）；
 *   copy-tool-missing 三平台剪贴板全缺失，已降级 stdout（非致命，exit 0）。
 */
import type { SubcommandDeps, SubcommandIo } from "./dispatch";
import { SessionManager } from "../../session/manager";

/** 可复制字段（单一事实来源）。 */
export const COPY_FIELDS = ["id", "title", "last-reply"] as const;
export type CopyField = (typeof COPY_FIELDS)[number];

/** 平台枚举（写入剪贴板分派用）。 */
export type ClipboardPlatform = "linux" | "macos" | "windows" | "unknown";

/** 命令执行替身面：探活与写入剪贴板都经它，测试零外呼。 */
export interface CmdRunner {
  /** 执行命令；input 非空时作为 stdin 喂入（写剪贴板用）；返回进程退出码（0 = 成功）。 */
  run(command: string, args: readonly string[], input?: string): Promise<{ exitCode: number }>;
}

/** copy 用法错误（handleSubcommand 统一归 exit 2）。 */
class CopyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyUsageError";
  }
}

/** 未知/缺失会话（结构化错误，归 exit 1）。 */
export class SessionMissingError extends Error {
  readonly code = "session-missing" as const;
  constructor(sessionId: string) {
    super(`会话不存在: ${sessionId}`);
    this.name = "SessionMissingError";
  }
}

/** 非法字段（结构化错误，归 exit 2）。 */
class InvalidFieldError extends Error {
  readonly code = "invalid-field" as const;
  constructor(field: string) {
    super(`非法字段 "${field}"（允许: ${COPY_FIELDS.join(" | ")}）`);
    this.name = "InvalidFieldError";
  }
}

// ---------------------------------------------------------------------------
// 平台探测
// ---------------------------------------------------------------------------

/**
 * 探测剪贴板平台：优先级 OSTYPE 环境变量 > process.platform。
 * GitBash/MSYS/Cygwin 的 OSTYPE 常含 "cygwin"/"msys"/"win"；process.platform 为
 * "win32"；Linux 含 "linux"；Darwin/macOS 为 "darwin"。
 * 可被 deps.osPlatform / deps.osType 覆盖（测试三平台分派与全缺失降级）。
 */
export function detectPlatform(deps: SubcommandDeps): ClipboardPlatform {
  const osType = deps.osType ?? process.env.OSTYPE ?? "";
  const osPlatform = deps.osPlatform ?? process.platform;
  if (osPlatform === "darwin" || /darwin|macos|apple/i.test(osType)) return "macos";
  if (osPlatform === "win32" || /cygwin|msys|win/i.test(osType)) return "windows";
  if (osPlatform === "linux" || /linux/i.test(osType)) return "linux";
  return "unknown";
}

// ---------------------------------------------------------------------------
// 剪贴板写入（依赖注入 CmdRunner，诚实探活不假冒）
// ---------------------------------------------------------------------------

/**
 * 把文本写入剪贴板；返回 { written, tool }。
 *   written=false 表示三平台剪贴板全缺失（调用方应降级 stdout，exit 0）。
 * 探活逻辑（仅 Linux 需要二选一）：先试 xclip，再试 wl-copy；macOS/windows
 * 直接走 pbcopy/clip（存在性由 CmdRunner 实际执行结果反映，不强探）。
 */
export async function copyToClipboard(
  text: string,
  platform: ClipboardPlatform,
  runner: CmdRunner,
): Promise<{ written: boolean; tool: string }> {
  if (platform === "linux") {
    // xclip：需 -selection clipboard；探活用 -version（stderr 由 runner 抑制）
    const xclip = await runner.run("xclip", ["-selection", "clipboard", "-version"]);
    if (xclip.exitCode === 0) {
      const write = await runner.run("xclip", ["-selection", "clipboard", "-in"], text);
      return { written: write.exitCode === 0, tool: "xclip" };
    }
    const wlcopy = await runner.run("wl-copy", ["--version"]);
    if (wlcopy.exitCode === 0) {
      const write = await runner.run("wl-copy", [], text);
      return { written: write.exitCode === 0, tool: "wl-copy" };
    }
    return { written: false, tool: "(none)" };
  }
  if (platform === "macos") {
    const write = await runner.run("pbcopy", [], text);
    return { written: write.exitCode === 0, tool: "pbcopy" };
  }
  if (platform === "windows") {
    const write = await runner.run("clip", [], text);
    return { written: write.exitCode === 0, tool: "clip" };
  }
  return { written: false, tool: "(none)" };
}

// ---------------------------------------------------------------------------
// 字段提取
// ---------------------------------------------------------------------------

/**
 * 末条 assistant 文本；无 assistant 条目返回空串（诚实，非错误）。
 * 兼容两种 payload 形态：`{text}` 直出（user/旧形态）与
 * `{content:[{type:"text",text}]}` 块数组（assistant 回复的实际落盘形态——
 * 0.3.0 自助测试 B6b 发现：旧实现只认前者，对 assistant 条目恒空）。
 */
function lastReplyText(entries: { type: string; payload: unknown }[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type === "assistant") {
      const payload = entry.payload as { text?: unknown; content?: unknown } | null;
      if (payload === null || typeof payload !== "object") continue;
      if (typeof payload.text === "string") return payload.text;
      if (Array.isArray(payload.content)) {
        const text = payload.content
          .filter(
            (block): block is { type: string; text: string } =>
              block !== null && typeof block === "object" &&
              (block as { type?: unknown }).type === "text" &&
              typeof (block as { text?: unknown }).text === "string",
          )
          .map((block) => block.text)
          .join("");
        if (text.length > 0) return text;
      }
    }
  }
  return "";
}

/** 取会话某字段的复制文本；会话不存在抛 SessionMissingError。 */
async function resolveField(
  manager: SessionManager,
  sessionId: string,
  field: CopyField,
): Promise<string> {
  const meta = await manager.getSessionMeta(sessionId);
  if (meta === undefined) {
    throw new SessionMissingError(sessionId);
  }
  if (field === "id") return meta.sessionId;
  if (field === "title") return meta.title;
  // last-reply：需加载条目
  const entries = await manager.entries(sessionId);
  return lastReplyText(entries);
}

// ---------------------------------------------------------------------------
// 派发入口
// ---------------------------------------------------------------------------

/**
 * `bi copy [sessionId] [-f field]`：复制会话字段到剪贴板；全缺失降级 stdout。
 * 退出码：0 成功（含 stdout 降级）/ 2 用法错误与非法字段 / 1 未知会话。
 */
export async function handleCopy(
  rest: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps,
): Promise<number> {
  let args: { sessionId?: string; field: CopyField };
  try {
    args = parseCopyArgs(rest);
  } catch (cause) {
    if (cause instanceof CopyUsageError) {
      io.err(`bi copy: ${cause.message}`);
      io.err("运行 bi copy --help 查看用法");
      return 2;
    }
    if (cause instanceof InvalidFieldError) {
      io.err(`bi copy: ${cause.message}`);
      io.err("运行 bi copy --help 查看用法");
      return 2;
    }
    throw cause;
  }
  const field = args.field;

  const manager = new SessionManager(
    deps.sessionsRoot !== undefined ? { rootDir: deps.sessionsRoot } : {},
  );

  // 目标会话：缺省 = listSessions 首条（createdAt 降序已排序 = 最近会话）
  let targetId: string;
  if (args.sessionId !== undefined) {
    targetId = args.sessionId;
  } else {
    const all = await manager.listSessions();
    if (all.length === 0) {
      io.err("bi copy: 无会话（无法缺省定位「最近会话」）；请显式指定 sessionId。");
      return 1;
    }
    targetId = all[0]!.sessionId;
  }

  let value: string;
  try {
    value = await resolveField(manager, targetId, field);
  } catch (cause) {
    if (cause instanceof SessionMissingError) {
      io.err(`bi copy: 会话不存在: ${targetId}`);
      return 1;
    }
    throw cause;
  }

  const platform = detectPlatform(deps);
  const runner: CmdRunner = deps.cmdRunner ?? realCmdRunner;
  const result = await copyToClipboard(value, platform, runner);

  if (result.written) {
    io.out(value);
    io.err(
      `bi copy: 已复制 ${field}（会话 ${targetId}）至剪贴板（${result.tool}）。`,
    );
    return 0;
  }

  // 降级链：三平台剪贴板全缺失 → stdout 直出 + 结构化提示（exit 0，不假冒）
  io.out(value);
  io.err("bi copy: 剪贴板工具缺失，已打印到 stdout。");
  return 0;
}

/** 真实命令执行（生产路径）；测试经 deps.cmdRunner 注入替身。 */
const realCmdRunner: CmdRunner = {
  async run(command: string, args: readonly string[], input?: string) {
    const { spawnSync } = await import("node:child_process");
    // input 非空时经 stdin 喂入（写剪贴板语义）;stdout/stderr 抑制（探活不污染输出）。
    const res = spawnSync(command, args, {
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
      stdio: input !== undefined ? undefined : ["ignore", "ignore", "ignore"],
    });
    return { exitCode: res.status ?? 1 };
  },
};

/** 解析 copy 子命令参数：`[sessionId] [-f field]`。 */
function parseCopyArgs(rest: readonly string[]): { sessionId?: string; field: CopyField } {
  let sessionId: string | undefined;
  let field: CopyField = "id";
  const rest2 = [...rest];
  // 先扫 -f / --field 旗标（值可 = 形式）
  for (let i = 0; i < rest2.length; i++) {
    const token = rest2[i]!;
    if (token === "-f" || token === "--field") {
      const val = rest2[i + 1];
      if (val === undefined || val.startsWith("-")) {
        throw new CopyUsageError("参数 -f 缺少值");
      }
      if (!COPY_FIELDS.includes(val as CopyField)) {
        throw new InvalidFieldError(val);
      }
      field = val as CopyField;
      rest2.splice(i, 2);
      i -= 1;
    } else if (token.startsWith("--field=")) {
      const val = token.slice("--field=".length);
      if (!COPY_FIELDS.includes(val as CopyField)) {
        throw new InvalidFieldError(val);
      }
      field = val as CopyField;
      rest2.splice(i, 1);
      i -= 1;
    } else if (token.startsWith("-f=")) {
      const val = token.slice("-f=".length);
      if (!COPY_FIELDS.includes(val as CopyField)) {
        throw new InvalidFieldError(val);
      }
      field = val as CopyField;
      rest2.splice(i, 1);
      i -= 1;
    }
  }
  // 未知旗标：PROD-2 验收补漏——此前 --bogus 之类被静默吞掉（违反「未知用法 exit 2」）
  const unknownFlags = rest2.filter((t) => t.startsWith("-"));
  if (unknownFlags.length > 0) {
    throw new CopyUsageError(`未知旗标: ${unknownFlags.join(" ")}`);
  }
  // 剩余裸词：至多一个位置参数 = sessionId
  const positionals = rest2.filter((t) => !t.startsWith("-"));
  if (positionals.length > 1) {
    throw new CopyUsageError(`copy 至多接受一个位置参数（sessionId），收到: ${positionals.join(" ")}`);
  }
  if (positionals.length === 1) sessionId = positionals[0];
  return { sessionId, field };
}
