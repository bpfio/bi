/**
 * 分工声明：BI-06.8（shell-scan.ts / opaque-guard.ts）= 语法/动态执行守卫（opaque 判定）；
 * 本卡（BI-06.1 path-jail.ts）= 路径/策略守卫（哪里不许碰）——双引擎互补。
 *
 * BI-06.8 已把 Bash 解析成语句树（scanShell → ScanResult.statements）并完成
 * 语法分级（safe / opaque / dangerous）与动态性判定；本卡不再解析语法、不重复
 * 判定动态性，而是遍历该语句树，提取「命令词 + 参数词 + 重定向目标」，逐词
 * normalizePath 后按路径/模式策略裁决。
 *
 * ## checkScan 的裁决语义（双引擎分工的落点）
 *
 * - checkScan 只裁决「路径/策略」维度：allowed=false 当且仅当存在路径违规。
 * - opaque 语句（06.8 已判）直接透传：ScanVerdict.opaque 原样携带 scan.opaque，
 *   且跳过 opaque 语句的逐词检查（其 token 流不可信，本卡不重复判动态性）。
 *   整体放行与否由 assertSafe 组合 opaque-guard（assertExecutable）后给出：
 *   opaque 或 dangerous 或 path 违规 → { allowed:false, reasons }。
 * - dangerous 语句（如 rm -rf /）的词仍是可静态理解的，本卡照常做路径检查；
 *   其危险性本身由 06.8 的分级与 assertSafe 的组合层负责。
 * - 与 06.8 的 REASONS.dangerousCredentialPath 互补：那是语法分级层凭内容特征
 *   判 dangerous；本卡是工作区/家目录/读写模式维度的位置策略，原因码独立命名。
 *
 * ## 保守近似声明（有意为之，宁误报不漏报）
 *
 * - normalizePath 是纯字符串处理（不触 fs、无副作用）。相对路径按「命令在
 *   workspaceRoot 执行」的假设解析。
 * - 仅展开 $HOME / ${HOME}（保守字面替换）；其余变量、命令替换 $(...)、反引号、
 *   ~user 一律不可解析 → checkPath / checkScan 判违规（unresolvable-path）。
 *   例如 `cat $KEY`、`cat $(find / -name id_rsa)` 这类运行期才知道路径的词，
 *   静态层无法证明其安全，一律拦下；代价是 `echo $PATH` 之类的良性词也会被拦。
 * - 凭据文件名特征按 basename 粗匹配（大小写敏感）：id_rsa / id_ed25519 /
 *   credentials 精确、*.pem 后缀、secret* 前缀——`grep secret notes.txt`、
 *   `secret-manager login` 这类词会误伤，属声明过的保守取舍。含通配符（* ?）
 *   的词与凭据样本名做 glob 匹配，只要可能展开成凭据名即违规（如 `*`、`*.pem`）。
 * - 工作区 .env 仅拦 workspaceRoot/.env 本体（不递归 .env.local 等）。
 * - /etc/** 只拦「读」；写 /etc 由「工作区外写拦」覆盖。
 * - 写目标启发式（保守）：重定向目标是写；cp/mv/install/ln 的最后一个非旗标
 *   操作数是写目标；tee 的全部非旗标操作数是写目标；dd 的 of= 值是写目标。
 *   其余参数词一律按「读」裁决——这意味着 `cp build.zip /tmp/` 这类「把普通
 *   工作区文件拷出」仍会被末位操作数规则拦下，而纯读参数不会误判写。
 * - 已知边界（声明不覆盖）：`sh -c '…'` 内嵌脚本的路径策略不在本卡单层遍历
 *   范围内（06.8 已对内嵌脚本递归分级并透传 opaque/dangerous，上层组合裁决）；
 *   scp/rsync 的 `host:/path` 远程目标不在文件系统路径语义内。
 * - 重定向目标词不会在参数词清单里重复出现（按 token span 排除），一个词一个
 *   权威裁决模式。
 */

import { assertExecutable } from "./opaque-guard";
import type { ScanResult, ShellStatement } from "./shell-scan";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** 路径访问模式。 */
export type PathMode = "read" | "write";

export interface NormalizeOptions {
  home: string;
  workspaceRoot: string;
}

/**
 * normalizePath 结果：不可解析（空、无法静态求值的变量/命令替换、~user 等）
 * 返回 { ok:false, reason }，绝不猜测。
 */
export type NormalizeResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** 单路径裁决。 */
export interface PathVerdict {
  allowed: boolean;
  /** 违规原因码：unresolvable-path / extra-protected / protected-home-path /
   *  protected-etc-read / workspace-env / credential-filename / outside-workspace */
  reason?: string;
  /** 归一化后的绝对路径（可解析时）。 */
  path?: string;
}

/** 语句级路径违规（定位到 06.8 语句原文）。 */
export interface ScanViolation {
  path: string;
  mode: PathMode;
  reason: string;
  /** 违规所在的语句文本（ScanResult.statements[].text）。 */
  statement: string;
}

/** 整条 scan 的路径策略裁决。 */
export interface ScanVerdict {
  allowed: boolean;
  violations: ScanViolation[];
  /** 06.8 判定存在 opaque 语句的原样透传（本卡不重复判动态性）。 */
  opaque: boolean;
}

/** assertSafe 组合裁决（opaque-guard + 路径策略）。 */
export interface AssertSafeResult {
  allowed: boolean;
  reasons: string[];
}

export interface PathJailOptions {
  home: string;
  workspaceRoot: string;
  /** 额外保护路径（目录或文件，双模式全拦）。 */
  extraProtected?: string[];
}

// ---------------------------------------------------------------------------
// normalizePath — 纯字符串路径归一化
// ---------------------------------------------------------------------------

/**
 * 归一化一个路径词：引号剥离 → $HOME/${HOME} 保守字面展开 → ~ 展开 →
 * 相对→绝对（按 workspaceRoot 执行假设）→ `..` 折叠。
 * 不可解析（空、其余变量/命令替换/反引号、~user）→ { ok:false }。
 */
export function normalizePath(raw: string, opts: NormalizeOptions): NormalizeResult {
  if (raw.length === 0) return { ok: false, reason: "empty-path" };
  let s = stripQuotes(raw);
  if (s.length === 0) return { ok: false, reason: "empty-path" };
  // 残余引号字符（如 ~/'.ssh'/id_rsa）：直接剥掉。
  s = s.replace(/['"]/g, "");
  if (s.length === 0) return { ok: false, reason: "empty-path" };
  // $HOME / ${HOME} 保守字面展开（带词边界，避免 $HOMEx 误展开）。
  s = s.replace(/\$\{HOME\}/g, opts.home);
  s = s.replace(/\$HOME(?![A-Za-z0-9_])/g, opts.home);
  // 其余变量、命令替换 $(...)、反引号 → 不可解析（保守 fail-closed）。
  if (/[$`]/.test(s)) return { ok: false, reason: "unresolvable-expansion" };
  // ~ 展开：仅前导 ~ 或 ~/；~user 无法静态解析。
  if (s === "~") {
    s = opts.home;
  } else if (s.startsWith("~/")) {
    s = `${opts.home}${s.slice(1)}`;
  } else if (s.startsWith("~")) {
    return { ok: false, reason: "unresolvable-tilde-user" };
  }
  // 相对 → 绝对（假设在工作区根执行），随后折叠 .. / . / 重复斜杠。
  const root = stripTrailingSlashes(opts.workspaceRoot);
  if (root.length === 0) return { ok: false, reason: "missing-workspace-root" };
  const isAbsolute = s.startsWith("/");
  const baseAbsolute = isAbsolute || opts.workspaceRoot.startsWith("/");
  const full = isAbsolute ? s : `${root}/${s}`;
  const out: string[] = [];
  for (const seg of full.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!baseAbsolute) {
        // 相对基底的越界必须保留 ..（逃逸检测依赖它），绝对基底在根处钳制。
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  const path = baseAbsolute
    ? joined.length === 0
      ? "/"
      : `/${joined}`
    : joined.length === 0
      ? "."
      : joined;
  return { ok: true, path };
}

/** 反复剥离成对包裹引号（'…"…"…' 之类嵌套逐层剥）。 */
function stripQuotes(raw: string): string {
  let s = raw.trim();
  while (
    s.length >= 2 &&
    ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function stripTrailingSlashes(p: string): string {
  let out = p;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** 折叠 .. / . / 重复斜杠 / 尾斜杠；不做 ~ 或变量展开（供构造器归一 home/root）。 */
function foldPath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (absolute) return joined.length === 0 ? "/" : `/${joined}`;
  return joined.length === 0 ? "." : joined;
}

function pathWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

// ---------------------------------------------------------------------------
// 凭据文件名特征（保守近似，见文件头声明）
// ---------------------------------------------------------------------------

const HOME_PROTECTED_ENTRIES = [".ssh", ".gnupg", ".aws", ".kube", ".bash_history", ".env"] as const;

const CREDENTIAL_EXACT_NAMES = new Set(["id_rsa", "id_ed25519", "credentials"]);

/** 含通配符的词与这些凭据样本名做 glob 匹配：可能命中即违规。 */
const CREDENTIAL_GLOB_SAMPLES = ["id_rsa", "id_ed25519", "credentials", "secret.key", "server.pem"];

function isCredentialBasename(base: string): boolean {
  if (base.length === 0) return false;
  if (CREDENTIAL_EXACT_NAMES.has(base)) return true;
  if (base.startsWith("secret")) return true; // secret*
  if (base.endsWith(".pem") && base.length > ".pem".length) return true; // *.pem
  if (base.includes("*") || base.includes("?")) return globMayMatchCredential(base);
  return false;
}

function globMayMatchCredential(pattern: string): boolean {
  const re = globToRegExp(pattern);
  return CREDENTIAL_GLOB_SAMPLES.some((sample) => re.test(sample));
}

/** 文件名 glob（* 不跨 /，? 单字符）→ 正则；其余字符按字面转义。 */
function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

// ---------------------------------------------------------------------------
// PathJail
// ---------------------------------------------------------------------------

export class PathJail {
  private readonly home: string;
  private readonly workspaceRoot: string;
  private readonly extraProtected: readonly string[];

  constructor(opts: PathJailOptions) {
    if (opts.home.length === 0) {
      throw new Error("PathJail: home must be a non-empty path");
    }
    if (opts.workspaceRoot.length === 0) {
      throw new Error("PathJail: workspaceRoot must be a non-empty path");
    }
    this.home = foldPath(opts.home);
    this.workspaceRoot = foldPath(opts.workspaceRoot);
    this.extraProtected = (opts.extraProtected ?? []).map((raw) => {
      const norm = normalizePath(raw, { home: this.home, workspaceRoot: this.workspaceRoot });
      return norm.ok ? norm.path : raw.trim();
    });
  }

  /**
   * 单路径裁决：先归一化，再按保护清单裁决。
   * 顺序：extraProtected → home 保护清单 → /etc 读拦 → 工作区 .env →
   * 凭据文件名特征 → 工作区外写拦。
   */
  checkPath(path: string, mode: PathMode): PathVerdict {
    const norm = normalizePath(path, { home: this.home, workspaceRoot: this.workspaceRoot });
    if (!norm.ok) return { allowed: false, reason: "unresolvable-path", path };
    return this.judgeNormalized(norm.path, mode, this.workspaceRoot);
  }

  /**
   * 在 06.8 语句树上做路径策略：遍历 statements → 提取命令词 + 参数词 +
   * 重定向目标 → 逐词 normalizePath → checkPath。任何语句违规即
   * { allowed:false, violations }，violation.statement 定位到语句原文。
   * opaque 语句跳过逐词检查并透传 scan.opaque（不重复判动态性）。
   */
  checkScan(scan: ScanResult, opts: { workspaceRoot?: string } = {}): ScanVerdict {
    const workspaceRoot = opts.workspaceRoot ?? this.workspaceRoot;
    const violations: ScanViolation[] = [];
    const seen = new Set<string>();
    const record = (violation: ScanViolation): void => {
      const key = `${violation.mode}\u0000${violation.path}\u0000${violation.reason}\u0000${violation.statement}`;
      if (seen.has(key)) return;
      seen.add(key);
      violations.push(violation);
    };
    for (const statement of scan.statements) {
      if (statement.kind === "opaque") continue; // 06.8 已判，透传，不重复判
      // 重定向目标词同时会作为 word token 出现：按 span 排除，交给 redirect
      // 分支以 op 推导的权威模式裁决，避免同一词被读/写各判一次。
      const targetSpans = new Set(
        statement.redirects.map((r) => `${r.targetStart}:${r.targetEnd}`),
      );
      for (const word of collectArgWords(statement, targetSpans)) {
        this.judgeWord(word.text, word.mode, statement.text, workspaceRoot, record);
      }
      for (const redirect of statement.redirects) {
        const mode = redirectMode(redirect.op);
        if (mode === null) continue; // fd 复制（>& <&）与 heredoc 定界符不是路径
        this.judgeWord(redirect.target, mode, statement.text, workspaceRoot, record);
      }
    }
    return { allowed: violations.length === 0, violations, opaque: scan.opaque };
  }

  /**
   * 组合裁决：opaque-guard（06.8 opaque/dangerous/scan 级原因）+ 本卡路径违规。
   * opaque 或 path 违规 → { allowed:false, reasons }。
   */
  assertSafe(scan: ScanResult): AssertSafeResult {
    const guard = assertExecutable(scan);
    const pathVerdict = this.checkScan(scan);
    const reasons: string[] = [];
    for (const reason of guard.reasons) reasons.push(reason);
    for (const violation of pathVerdict.violations) {
      reasons.push(`path:${violation.mode}:${violation.path}:${violation.reason}`);
    }
    return { allowed: guard.allowed && pathVerdict.allowed, reasons };
  }

  // -- internals ------------------------------------------------------------

  private judgeNormalized(path: string, mode: PathMode, workspaceRoot: string): PathVerdict {
    for (const guarded of this.extraProtected) {
      if (guarded.length > 0 && pathWithin(path, guarded)) {
        return { allowed: false, reason: "extra-protected", path };
      }
    }
    for (const entry of HOME_PROTECTED_ENTRIES) {
      if (pathWithin(path, `${this.home}/${entry}`)) {
        return { allowed: false, reason: "protected-home-path", path };
      }
    }
    if (mode === "read" && pathWithin(path, "/etc")) {
      return { allowed: false, reason: "protected-etc-read", path };
    }
    if (pathWithin(path, `${workspaceRoot}/.env`)) {
      return { allowed: false, reason: "workspace-env", path };
    }
    if (isCredentialBasename(basenameOf(path))) {
      return { allowed: false, reason: "credential-filename", path };
    }
    if (mode === "write" && !pathWithin(path, workspaceRoot)) {
      return { allowed: false, reason: "outside-workspace", path };
    }
    return { allowed: true, path };
  }

  private judgeWord(
    word: string,
    mode: PathMode,
    statementText: string,
    workspaceRoot: string,
    record: (violation: ScanViolation) => void,
  ): void {
    const norm = normalizePath(word, { home: this.home, workspaceRoot });
    if (!norm.ok) {
      record({ path: word, mode, reason: "unresolvable-path", statement: statementText });
      return;
    }
    const verdict = this.judgeNormalized(norm.path, mode, workspaceRoot);
    if (!verdict.allowed) {
      record({
        path: norm.path,
        mode,
        reason: verdict.reason ?? "unknown",
        statement: statementText,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 语句词提取 + 写目标启发式
// ---------------------------------------------------------------------------

/** POSIX 语义下「最后一个非旗标操作数是写目标」的命令。 */
const LAST_DEST_COMMANDS = new Set(["cp", "mv", "install", "ln"]);

/** 「全部非旗标操作数都是写目标」的命令（tee 同时写 stdout 与所有文件）。 */
const ALL_DEST_COMMANDS = new Set(["tee"]);

interface ArgWord {
  text: string;
  mode: PathMode;
}

/**
 * 从 06.8 语句中提取需要路径裁决的参数词（命令词、赋值前缀、旗标、重定向
 * 目标词均已排除）。写目标启发式见文件头声明；其余参数一律按「读」裁决。
 */
function collectArgWords(statement: ShellStatement, targetSpans: Set<string>): ArgWord[] {
  const command = statement.commands[0] ?? "";
  const operands: string[] = [];
  const ddWriteTargets: string[] = [];
  let commandSeen = false;
  for (const token of statement.tokens) {
    if (token.kind !== "word") continue;
    if (targetSpans.has(`${token.start}:${token.end}`)) continue;
    if (!commandSeen) {
      // 命令词之前的词都是赋值前缀/修饰词，与命令词本身一样不作路径检查。
      if (command.length > 0 && token.text === command) commandSeen = true;
      continue;
    }
    if (token.text.startsWith("-")) continue;
    if (command === "dd" && token.text.startsWith("of=")) {
      ddWriteTargets.push(token.text.slice(3));
      continue;
    }
    operands.push(token.text);
  }
  const out: ArgWord[] = [];
  if (LAST_DEST_COMMANDS.has(command)) {
    for (let i = 0; i < operands.length - 1; i++) {
      out.push({ text: operands[i]!, mode: "read" });
    }
    if (operands.length > 0) {
      out.push({ text: operands[operands.length - 1]!, mode: "write" });
    }
  } else if (ALL_DEST_COMMANDS.has(command)) {
    for (const operand of operands) out.push({ text: operand, mode: "write" });
  } else {
    for (const operand of operands) out.push({ text: operand, mode: "read" });
  }
  for (const target of ddWriteTargets) out.push({ text: target, mode: "write" });
  return out;
}

/**
 * 重定向操作符 → 路径访问模式。
 * `<` 是读；`>` `>>` `>|` `<>` `&>` `&>>` 是写；`>&`/`<&`（fd 复制）与
 * `<<`/`<<-`/`<<<`（heredoc 定界符）不指向路径，返回 null 跳过。
 */
function redirectMode(op: string): PathMode | null {
  switch (op) {
    case "<":
      return "read";
    case ">":
    case ">>":
    case ">|":
    case "<>":
    case "&>":
    case "&>>":
      return "write";
    default:
      return null;
  }
}
