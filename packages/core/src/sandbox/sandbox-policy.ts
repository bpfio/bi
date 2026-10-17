/**
 * BI-06.10 — OS 级沙箱隔离底座：策略层（三后端参数生成）。
 *
 * 选型声明（为什么是这三个后端、各自何时生效）：
 *
 * | 后端      | 平台生效条件                                  | 隔离机理                          |
 * |-----------|-----------------------------------------------|-----------------------------------|
 * | landlock  | Linux ≥ 5.13 且内核 LSM 启用 landlock         | 内核 LSM：按 fd 层级的读/写权限表 |
 * | bwrap     | Linux，PATH 上存在 bubblewrap 且 userns 可用  | 挂载命名空间 + 绑定挂载视图       |
 * | seatbelt  | macOS（/usr/bin/sandbox-exec 在位）           | Apple Sandbox Profile (SBPL)      |
 *
 * 优先级：Linux 上 landlock > bwrap（landlock 无需 userns、无二进制依赖、
 * 内核态强制）；macOS 上仅 seatbelt。Windows 无支持（结构化 unavailable）。
 *
 * 路径语义（三后端统一的文档化约定）：
 * - readonly       : 全文件系统只读（landlock: 对 / 授 READ|EXEC；bwrap:
 *                    `--ro-bind / /`；seatbelt: `(allow file-read*)` 且无写授权）。
 *                    不授予任何写路径（含 /tmp）——纯最严解释；需要临时写请用
 *                    workspace-write。
 * - workspace-write: 读全 FS；写 = workspaceRoot + os.tmpdir() + extraWritePaths。
 * - extraReadOnly  : 在写路径集合上强制降级为只读的例外表。
 *                    · seatbelt：allow 之后追加 `(deny file-write* (subpath X))`
 *                      （SBPL 顺序语义，后规则覆盖先规则）。
 *                    · bwrap：在 `--bind X X` 之后追加 `--ro-bind X X`
 *                      （bubblewrap 挂载顺序语义，后挂载遮蔽先挂载）。
 *                    · landlock：**结构化记录但为 no-op**——landlock 是加法型
 *                      LSM，无法从已授予的层级收回权限（declared limitation）。
 *                      位于写路径内的 extraReadOnly 条目在 landlock 后端下不生效。
 * - off            : 三生成器返回空结构；os-sandbox 直接旁路执行，不加沙箱。
 *
 * 零依赖：仅 node 内建 + 同目录既有资产（path-jail 的 normalizePath）。
 */

import { tmpdir } from "node:os";
import { normalizePath } from "./path-jail";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SandboxMode = "off" | "readonly" | "workspace-write";

export interface SandboxPolicy {
  mode: SandboxMode;
  /** 追加只读路径（workspace-write 下从写集合降级；readonly 下为冗余记录）。 */
  extraReadOnly?: string[];
  /** 追加可写路径（workspace-write 下在 workspace/tmp 之外追加）。 */
  extraWritePaths?: string[];
}

/** 路径上下文：调用方显式给 workspace；home/tmp 可缺省按环境解析。 */
export interface SandboxPathContext {
  workspaceRoot: string;
  homeDir?: string;
  tmpDir?: string;
}

/** 策略无法归一化某个路径时的结构化错误（fail-closed，不静默丢路径）。 */
export class SandboxPolicyError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string) {
    super(`sandbox-policy: 无法归一化路径 "${path}": ${reason}`);
    this.name = "SandboxPolicyError";
    this.path = path;
    this.reason = reason;
  }
}

/**
 * landlock 加载器 profile（与 ABI 无关的纯路径数据）。
 * 访问位掩码由 os-sandbox 依探测到的内核 ABI 在运行期合成。
 */
export interface LandlockProfile {
  /** 只读层级（对每条授 READ_FILE|READ_DIR|EXECUTE）。 */
  readOnly: string[];
  /** 可写层级（授读位全集 + 写位全集，按 handledMask 截断）。 */
  readWrite: string[];
  /** extraReadOnly 原样记录（landlock no-op，见模块头声明）。 */
  extraReadOnlyRecorded: string[];
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function resolveBase(ctx: SandboxPathContext): { home: string; workspaceRoot: string; tmpDir: string } {
  if (typeof ctx.workspaceRoot !== "string" || ctx.workspaceRoot.trim().length === 0) {
    throw new SandboxPolicyError(String(ctx.workspaceRoot), "workspace-root-required");
  }
  return {
    home: ctx.homeDir ?? process.env["HOME"] ?? "",
    workspaceRoot: ctx.workspaceRoot,
    tmpDir: ctx.tmpDir ?? tmpdir(),
  };
}

/** 用 path-jail 的 normalizePath 归一化 + 绝对化 + 去重（保序）。 */
function normalizeList(raws: string[] | undefined, base: { home: string; workspaceRoot: string }): string[] {
  const out: string[] = [];
  for (const raw of raws ?? []) {
    const norm = normalizePath(raw, { home: base.home, workspaceRoot: base.workspaceRoot });
    if (!norm.ok) throw new SandboxPolicyError(raw, norm.reason);
    if (!out.includes(norm.path)) out.push(norm.path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// landlock 参数生成
// ---------------------------------------------------------------------------

/**
 * 生成 landlock 加载器消费的 profile 数据。
 * `landlockProfileArgs` 的 args[0] 即此对象的 JSON 序列化。
 */
export function landlockProfile(policy: SandboxPolicy, ctx: SandboxPathContext): LandlockProfile {
  if (policy.mode === "off") {
    return { readOnly: [], readWrite: [], extraReadOnlyRecorded: [] };
  }
  const base = resolveBase(ctx);
  const extraReadOnly = normalizeList(policy.extraReadOnly, base);
  const extraWritePaths = normalizeList(policy.extraWritePaths, base);
  if (policy.mode === "readonly") {
    return { readOnly: ["/"], readWrite: [], extraReadOnlyRecorded: extraReadOnly };
  }
  // workspace-write：写 = workspace + tmp + extraWritePaths
  const readWrite: string[] = [];
  for (const p of [base.workspaceRoot, base.tmpDir, ...extraWritePaths]) {
    if (!readWrite.includes(p)) readWrite.push(p);
  }
  return { readOnly: ["/"], readWrite, extraReadOnlyRecorded: extraReadOnly };
}

/**
 * landlock 后端包装参数：返回加载器 argv 尾参。
 * 本仓库加载器为 os-sandbox 内嵌的 `bun -e` 脚本，取 args[0] 作为 profile JSON；
 * 若替换为外部加载器二进制，可整段透传为它的命令行参数。
 * opts.handledMask：探测到的内核 ABI FS 掩码（16 进制字符串注入 profile）；
 * 缺省为 null（加载器自行按 ABI 决策——仅适用于内置 loader 的兜底路径）。
 * mode=off → 返回 []（os-sandbox 旁路）。
 */
export function landlockProfileArgs(
  policy: SandboxPolicy,
  ctx: SandboxPathContext,
  opts?: { handledMask?: bigint },
): string[] {
  if (policy.mode === "off") return [];
  const profile = landlockProfile(policy, ctx);
  const mask = opts?.handledMask;
  return [
    JSON.stringify({
      mask: mask === undefined ? null : "0x" + mask.toString(16),
      readOnly: profile.readOnly,
      readWrite: profile.readWrite,
      extraReadOnlyRecorded: profile.extraReadOnlyRecorded,
    }),
  ];
}

// ---------------------------------------------------------------------------
// seatbelt（macOS SBPL）参数生成
// ---------------------------------------------------------------------------

/** SBPL 转义：profile 是 Scheme 语法的字符串参数，双引号必须转义。 */
function sbplEscape(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sbplSubpaths(paths: string[]): string {
  return paths.map((p) => `(subpath "${sbplEscape(p)}")`).join(" ");
}

/**
 * macOS sandbox-exec 的 `-p` profile 字符串。
 * 平台生效条件：darwin 且 /usr/bin/sandbox-exec 存在（probe 负责确认）。
 * 语义：deny default → 放行读/进程/出站网络 → workspace-write 追加写授权 →
 * extraReadOnly 以 deny 覆盖（SBPL 后规则优先）。
 * 声明局限：未放行 IOKit/Mach lookup 全集，GUI 程序可能受限；本底座面向 CLI。
 */
export function seatbeltProfile(policy: SandboxPolicy, ctx: SandboxPathContext): string {
  if (policy.mode === "off") return "";
  const base = resolveBase(ctx);
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow network-outbound)",
    "(allow file-read*)",
  ];
  if (policy.mode === "workspace-write") {
    const extraWritePaths = normalizeList(policy.extraWritePaths, base);
    const writePaths = [base.workspaceRoot, base.tmpDir, ...extraWritePaths].filter(
      (p, i, a) => a.indexOf(p) === i,
    );
    lines.push(`(allow file-write* ${sbplSubpaths(writePaths)})`);
    const extraReadOnly = normalizeList(policy.extraReadOnly, base);
    for (const p of extraReadOnly) {
      lines.push(`(deny file-write* ${sbplSubpaths([p])})`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// bwrap（bubblewrap）参数生成
// ---------------------------------------------------------------------------

/**
 * Linux bubblewrap 包装参数（os-sandbox 在其后追加 `-- payload...`）。
 * 生效条件：Linux + bwrap 在 PATH + 非特权 userns 可用（probe 实测确认）。
 * 语义：
 * - 共同：`--ro-bind / /`（只读根视图）、`--dev /dev`、`--proc /proc`、
 *   `--die-with-parent`（父死回收）、`--new-session`（脱离 controlling tty）。
 * - readonly：仅以上——/tmp 保持只读（纯最严解释）。
 * - workspace-write：对 workspace/tmp/extraWritePaths 逐一 `--bind X X`；
 *   随后对 extraReadOnly 逐一 `--ro-bind X X`（后挂载遮蔽先挂载）。
 */
export function bwrapProfile(policy: SandboxPolicy, ctx: SandboxPathContext): string[] {
  if (policy.mode === "off") return [];
  const base = resolveBase(ctx);
  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--die-with-parent",
    "--new-session",
  ];
  if (policy.mode === "workspace-write") {
    const extraWritePaths = normalizeList(policy.extraWritePaths, base);
    const writePaths = [base.workspaceRoot, base.tmpDir, ...extraWritePaths].filter(
      (p, i, a) => a.indexOf(p) === i,
    );
    for (const p of writePaths) {
      args.push("--bind", p, p);
    }
    const extraReadOnly = normalizeList(policy.extraReadOnly, base);
    for (const p of extraReadOnly) {
      args.push("--ro-bind", p, p);
    }
  }
  return args;
}
