/**
 * BI-06.10 — OS 级沙箱隔离底座：执行层（后端探测 + 包装执行）。
 *
 * 职责：
 * - probe()：真实探测各后端可用性，产出结构化 verdict（绝不静默降级）。
 *   · landlock：真实内核探针——先 `landlock_create_ruleset(NULL,0,VERSION)`，
 *     失败则按 ABI 掩码（0xFFFF→5 … 0x1FFF→1）实创 ruleset 二分。两者都是
 *     真实 syscall 实测，不做 uname 字符串猜测。
 *   · bwrap：PATH 存在性 + 真实功能探针（`--ro-bind / / /bin/true` 退出 0），
 *     覆盖 userns 被禁的内核。
 *   · seatbelt：darwin 平台 + /usr/bin/sandbox-exec 存在性。
 * - runSandboxed(cmd, policy)：按后端包装执行命令；mode=off 旁路；
 *   全后端不可用且 mode≠off → fail-closed 结构化拒绝（kind:"refused"）。
 *
 * landlock 执行机理（零依赖、零外部文件）：自重执行——用当前 bun 可执行文件
 * 起子进程跑内嵌 loader（LANDLOCK_LOADER_SRC），loader 通过 bun:ffi 以固定
 * 元数声明调用 libc `syscall(2)` 完成 create_ruleset/add_rule/prctl(NNP)/
 * restrict_self，随后 pipe 转发 payload 的 stdout/stderr 并忠实回传退出码。
 *
 * 已实证（本机 kernel 7.0.0，landlock LSM 活跃）：
 *   写 /tmp（授权路径）→ 成功；写 $HOME（未授权）→ EACCES 拒绝。
 *
 * 声明局限（declared）：
 * - libc 固定元数声明调用变参 `syscall(2)` 依赖 x86_64 SysV ABI 的寄存器
 *   约定（变参包装器的 AL 副作用对纯整型调用无害）；非 x86_64 Linux 上探针
 *   可能失真——探针失败即结构化 unavailable，不会误报可用。
 * - loader 不是 execve 替换：payload 与 loader 是两进程，信号语义以 128+n
 *   约定回传；stdout/stderr 经 loader 中转（文本流，二进制输出不保真）。
 * - dlopen 目标依次尝试 libc.so.6（glibc）与 libc.musl-x86_64.so.1（musl）。
 * - landlock 只做文件系统访问位；网络/ABI6 scopes 不在本卡范围。
 */

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import {
  bwrapProfile,
  landlockProfileArgs,
  seatbeltProfile,
  type SandboxPathContext,
  type SandboxPolicy,
} from "./sandbox-policy";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SandboxBackendId = "landlock" | "bwrap" | "seatbelt";

export type SandboxProbeErrorKind =
  | "wrong-platform"
  | "binary-missing"
  | "kernel-unsupported"
  | "userns-unsupported"
  | "ffi-unavailable"
  | "workspace-root-missing"
  | "probe-failed";

/**
 * 探针真实可产出的 errorKind 全集(唯一事实源)。
 * 测试断言(如 D5 结构化探针白名单)必须引用此常量,杜绝"探针改串 / 测试硬编码
 * 同一语义不同字面量"的双源漂移——新增 errorKind 时只在此处改一处。
 * 注:`probe-failed` 仅在类型层声明,当前探针实现不产出,故未列入。
 */
export const SANDBOX_PROBE_ERROR_KINDS: readonly SandboxProbeErrorKind[] = [
  "wrong-platform",
  "binary-missing",
  "kernel-unsupported",
  "userns-unsupported",
  "ffi-unavailable",
  "workspace-root-missing",
];

export interface BackendProbe {
  backend: SandboxBackendId;
  available: boolean;
  /** 人类可读探测详情（ABI、版本、失败原因码）。 */
  detail: string;
  errorKind?: SandboxProbeErrorKind;
  /** landlock 专用：探测通过的真实 FS 掩码（"0x.."），供 profile 生成消费。 */
  handledMask?: string;
}

export interface SandboxProbe {
  platform: NodeJS.Platform;
  /** 至少一个后端可用。 */
  available: boolean;
  /** 首个可用后端（平台优先级序）。 */
  preferred: SandboxBackendId | null;
  backends: BackendProbe[];
}

export interface SandboxCommand {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SandboxRunOk {
  kind: "ran";
  backend: SandboxBackendId | "none";
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}

export interface SandboxRunRefused {
  kind: "refused";
  backend: null;
  exitCode: null;
  signal: null;
  stdout: "";
  stderr: "";
  /** 每个不可用后端一条结构化拒绝记录。 */
  refusals: BackendProbe[];
}

export type SandboxOutcome = SandboxRunOk | SandboxRunRefused;

/**
 * landlock syscall 面（可注入替身做测试矩阵）。
 * createRuleset(mask=0n) 即 VERSION 探针，返回值语义为 ABI 版本或 -1。
 */
export interface LandlockSyscalls {
  /** 创建 ruleset，返回 fd / ABI 版本（失败 -1）。 */
  createRuleset(handledMask: bigint): number;
  /** PATH_BENEATH 规则，返回 0 / -1。 */
  addRule(rulesetFd: number, dirFd: number, access: bigint): number;
  restrictSelf(rulesetFd: number): number;
  /** prctl(PR_SET_NO_NEW_PRIVS, 1)，返回 0 / -1。 */
  setNoNewPrivs(): number;
  close(fd: number): number;
}

// ---------------------------------------------------------------------------
// landlock 常量（uapi/linux/landlock.h）
// ---------------------------------------------------------------------------

const SYSCALL_CREATE_RULESET = 444;
const SYSCALL_ADD_RULE = 445;
const SYSCALL_RESTRICT_SELF = 446;
const SYSCALL_CLOSE = 3;
const SYSCALL_PRCTL = 157;
const PR_SET_NO_NEW_PRIVS = 38;
const LANDLOCK_CREATE_RULESET_VERSION = 1 << 4;
const LANDLOCK_RULE_PATH_BENEATH = 1;

/** 每档内核 ABI 覆盖的 FS 访问位全集（abi4 无新增 FS 位）。 */
const ABI_FS_MASKS: ReadonlyArray<{ abi: number; mask: bigint }> = [
  { abi: 5, mask: 0xffffn }, // + IOCTL_DEV
  { abi: 4, mask: 0x7fffn },
  { abi: 3, mask: 0x7fffn },
  { abi: 2, mask: 0x3fffn }, // + REFER
  { abi: 1, mask: 0x1fffn }, // 基础 13 位
];

/** 读位全集：EXECUTE|READ_FILE|READ_DIR = 0xD。 */
const FS_READ = 0xdn;

/** 按 VERSION 探针返回的 ABI 版本号取 FS 掩码；未知高档 ABI 按 ABI5+ 处理。 */
function maskForAbi(abi: number): string {
  const known = ABI_FS_MASKS.find((m) => m.abi === abi);
  return "0x" + (known?.mask ?? ABI_FS_MASKS[0]!.mask).toString(16);
}

// ---------------------------------------------------------------------------
// 默认 syscall 实现（bun:ffi，固定元数声明调用 libc syscall）
// ---------------------------------------------------------------------------

/** 实现说明与局限见模块头；libc 打开失败/非 bun 运行时 → null（结构化降级）。 */
export async function defaultLandlockSyscalls(): Promise<LandlockSyscalls | null> {
  let ffi: typeof import("bun:ffi");
  try {
    ffi = await import("bun:ffi");
  } catch {
    return null;
  }
  const L = ffi.FFIType.i64; // 运行期与 isize 同值（7），64 位有符号；d.ts 未列 isize
  for (const lib of ["libc.so.6", "libc.musl-x86_64.so.1"]) {
    try {
      const sc4 = ffi.dlopen(lib, { syscall: { args: [L, L, L, L], returns: L } }).symbols.syscall;
      const sc5 = ffi.dlopen(lib, { syscall: { args: [L, L, L, L, L], returns: L } }).symbols.syscall;
      const sc3 = ffi.dlopen(lib, { syscall: { args: [L, L, L], returns: L } }).symbols.syscall;
      const sc6 = ffi.dlopen(lib, { syscall: { args: [L, L, L, L, L, L], returns: L } }).symbols.syscall;
      const code = (v: number | bigint): number => (v < 0n || v < 0 ? -1 : Number(v));
      const u64buf = (v: bigint): ArrayBuffer => {
        const b = new ArrayBuffer(8);
        new DataView(b).setBigUint64(0, v, true);
        return b;
      };
      const rulebuf = (dirFd: number, access: bigint): ArrayBuffer => {
        const b = new ArrayBuffer(16);
        const dv = new DataView(b);
        dv.setBigUint64(0, access, true);
        dv.setInt32(8, dirFd, true);
        return b;
      };
      return {
        createRuleset: (mask) =>
          mask === 0n
            ? code(sc4(SYSCALL_CREATE_RULESET, 0, 0, LANDLOCK_CREATE_RULESET_VERSION))
            : code(sc4(SYSCALL_CREATE_RULESET, ffi.ptr(u64buf(mask)), 8, 0)),
        addRule: (rsFd, dirFd, access) =>
          code(sc5(SYSCALL_ADD_RULE, rsFd, LANDLOCK_RULE_PATH_BENEATH, ffi.ptr(rulebuf(dirFd, access)), 0)),
        restrictSelf: (rsFd) => code(sc3(SYSCALL_RESTRICT_SELF, rsFd, 0)),
        setNoNewPrivs: () => code(sc6(SYSCALL_PRCTL, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)),
        close: (fd) => code(sc3(SYSCALL_CLOSE, fd, 0)),
      };
    } catch {
      continue; // 换下一个 libc 名
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内嵌 landlock loader（零外部文件；由 OsSandbox 以 `bun -e` 执行）
// ---------------------------------------------------------------------------

/**
 * 环境变量协议：
 * - BI_SANDBOX_LL_PROFILE: { mask: "0x..", readOnly: string[], readWrite: string[] }
 * - BI_SANDBOX_LL_PAYLOAD: { command, args, cwd, env }
 * loader 依 mask 与读/写位全集在本地合成每条 PATH_BENEATH 规则的 access。
 */
export const LANDLOCK_LOADER_SRC = `
const fs = require("node:fs");
const cp = require("node:child_process");
function fail(code, msg) { process.stderr.write("[os-sandbox-loader] " + msg + "\\n"); process.exit(code); }
let profile, payload;
try {
  profile = JSON.parse(process.env.BI_SANDBOX_LL_PROFILE || "");
  payload = JSON.parse(process.env.BI_SANDBOX_LL_PAYLOAD || "");
} catch (e) { fail(125, "bad env json: " + String(e && e.message)); }
if (!profile || typeof profile.mask !== "string" || !Array.isArray(profile.readOnly) || !Array.isArray(profile.readWrite)) fail(125, "bad profile");
if (!payload || typeof payload.command !== "string") fail(125, "bad payload");
let ffi;
try { ffi = require("bun:ffi"); } catch (e) { fail(125, "bun:ffi unavailable"); }
const L = ffi.FFIType.isize;
let sym = null;
for (const lib of ["libc.so.6", "libc.musl-x86_64.so.1"]) {
  try {
    sym = {
      sc4: ffi.dlopen(lib, { syscall: { args: [L, L, L, L], returns: L } }).symbols.syscall,
      sc5: ffi.dlopen(lib, { syscall: { args: [L, L, L, L, L], returns: L } }).symbols.syscall,
      sc3: ffi.dlopen(lib, { syscall: { args: [L, L, L], returns: L } }).symbols.syscall,
      sc6: ffi.dlopen(lib, { syscall: { args: [L, L, L, L, L, L], returns: L } }).symbols.syscall,
    };
    break;
  } catch (e) { sym = null; }
}
if (!sym) fail(125, "libc dlopen failed");
const mask = BigInt(profile.mask);
const READ = 0xdn;
const ALL = 0xffffn;
const rbuf = new ArrayBuffer(8);
new DataView(rbuf).setBigUint64(0, mask, true);
const rs = Number(sym.sc4(444, ffi.ptr(rbuf), 8, 0));
if (rs < 0) fail(125, "create_ruleset failed");
const O_PATH = fs.constants.O_PATH || 0;
const O_DIR = fs.constants.O_DIRECTORY || 0;
const O_CLOEXEC = fs.constants.O_CLOEXEC || 0;
const rules = [];
for (const p of profile.readOnly) rules.push({ path: p, access: (mask & READ).toString() });
for (const p of profile.readWrite) rules.push({ path: p, access: (mask & ALL).toString() });
for (const rule of rules) {
  let fd = -1;
  try {
    fd = fs.openSync(rule.path, (O_PATH ? O_PATH : (fs.constants.O_RDONLY | O_DIR)) | O_CLOEXEC);
  } catch (e) { continue; }
  const ab = new ArrayBuffer(16);
  const dv = new DataView(ab);
  dv.setBigUint64(0, BigInt(rule.access), true);
  dv.setInt32(8, fd, true);
  const r = Number(sym.sc5(445, rs, 1, ffi.ptr(ab), 0));
  fs.closeSync(fd);
  if (r !== 0) fail(125, "add_rule failed for " + rule.path);
}
if (Number(sym.sc6(157, 38, 1, 0, 0, 0)) !== 0) fail(125, "prctl NO_NEW_PRIVS failed");
if (Number(sym.sc3(446, rs, 0)) !== 0) fail(125, "restrict_self failed");
Number(sym.sc3(3, rs, 0));
const run = cp.spawnSync(payload.command, payload.args || [], {
  cwd: payload.cwd || undefined,
  env: Object.assign({}, process.env, payload.env || {}),
  stdio: ["ignore", "pipe", "pipe"],
});
if (run.stdout && run.stdout.length > 0) process.stdout.write(run.stdout);
if (run.stderr && run.stderr.length > 0) process.stderr.write(run.stderr);
if (run.error) { process.stderr.write("[os-sandbox-loader] spawn: " + run.error.message + "\\n"); process.exit(127); }
const SIG = { SIGTERM: 15, SIGINT: 2, SIGKILL: 9, SIGHUP: 1, SIGQUIT: 3, SIGABRT: 6, SIGSEGV: 11, SIGPIPE: 13 };
process.exit(run.status !== null && run.status !== undefined ? run.status : 128 + (SIG[run.signal] || 31));
`;

// ---------------------------------------------------------------------------
// 零依赖 which
// ---------------------------------------------------------------------------

function whichSync(name: string, env: NodeJS.ProcessEnv): string | null {
  const path = env["PATH"] ?? "";
  for (const dir of path.split(":")) {
    if (dir.length === 0) continue;
    const candidate = dir.endsWith("/") ? dir + name : dir + "/" + name;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 信号 → 退出码约定
// ---------------------------------------------------------------------------

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9,
  SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15,
};

function signalToExitCode(signal: string): number {
  return 128 + (SIGNAL_NUMBERS[signal] ?? 31);
}

// ---------------------------------------------------------------------------
// OsSandbox
// ---------------------------------------------------------------------------

export interface OsSandboxDeps {
  platform: () => NodeJS.Platform;
  env: () => NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  landlockSyscalls: () => Promise<LandlockSyscalls | null>;
  /** bwrap 可执行文件路径；null = 不在位。 */
  bwrapBinary: () => string | null;
  /** bwrap 真实功能探针（默认实跑 --ro-bind / / /bin/true）。 */
  bwrapFunctional: (bin: string) => { ok: boolean; detail: string };
  sandboxExecBinary: () => string | null;
  spawn: typeof spawnSync;
  execPath: () => string;
}

function defaultDeps(): OsSandboxDeps {
  return {
    platform: () => process.platform,
    env: () => process.env,
    exists: (p) => existsSync(p),
    landlockSyscalls: defaultLandlockSyscalls,
    bwrapBinary: () => whichSync("bwrap", process.env),
    bwrapFunctional: (bin) => {
      const r = spawnSync(bin, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--", "/bin/true"], {
        stdio: "ignore",
        timeout: 10_000,
      });
      if (r.error) return { ok: false, detail: "bwrap-functional:" + ((r.error as NodeJS.ErrnoException).code ?? r.error.message) };
      if (r.status === 0) return { ok: true, detail: "functional-ok" };
      return { ok: false, detail: "exit=" + String(r.status) + " signal=" + String(r.signal) };
    },
    sandboxExecBinary: () => {
      if (process.platform !== "darwin") return null;
      return existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : null;
    },
    spawn: spawnSync,
    execPath: () => process.execPath,
  };
}

export class OsSandbox {
  private readonly deps: OsSandboxDeps;

  constructor(deps?: Partial<OsSandboxDeps>) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  // -- probe ---------------------------------------------------------------

  /** 真实探测所有平台候选后端；结构化 verdict，绝不静默。 */
  async probe(): Promise<SandboxProbe> {
    const platform = this.deps.platform();
    const backends: BackendProbe[] = [];
    if (platform === "linux") {
      backends.push(await this.probeLandlock());
      backends.push(this.probeBwrap());
      backends.push({ backend: "seatbelt", available: false, detail: "seatbelt 仅 macOS 生效", errorKind: "wrong-platform" });
    } else if (platform === "darwin") {
      backends.push({ backend: "landlock", available: false, detail: "landlock 仅 Linux 生效", errorKind: "wrong-platform" });
      backends.push({ backend: "bwrap", available: false, detail: "bwrap 仅 Linux 生效", errorKind: "wrong-platform" });
      backends.push(this.probeSeatbelt());
    } else {
      for (const backend of ["landlock", "bwrap", "seatbelt"] as const) {
        backends.push({
          backend,
          available: false,
          detail: "平台 " + platform + " 无沙箱后端",
          errorKind: "wrong-platform",
        });
      }
    }
    const preferred = backends.find((b) => b.available)?.backend ?? null;
    return { platform, available: preferred !== null, preferred, backends };
  }

  /** landlock 真实内核探针：VERSION 标志优先，失败按 ABI 掩码实创 ruleset 二分。 */
  private async probeLandlock(): Promise<BackendProbe> {
    const syscalls = await this.deps.landlockSyscalls();
    if (syscalls === null) {
      return { backend: "landlock", available: false, detail: "bun:ffi/libc 不可用", errorKind: "ffi-unavailable" };
    }
    // 第一档：VERSION 探针（部分内核变体上异常返回，失败不即判死）。
    const versioned = syscalls.createRuleset(0n);
    if (versioned > 0) {
      syscalls.close(versioned);
      return {
        backend: "landlock",
        available: true,
        detail: "abi=" + String(versioned) + " (version-probe)",
        handledMask: maskForAbi(versioned),
      };
    }
    // 第二档：掩码二分实创 ruleset（真实 syscall，非字符串推断）。
    for (const { abi, mask } of ABI_FS_MASKS) {
      const fd = syscalls.createRuleset(mask);
      if (fd > 0) {
        syscalls.close(fd);
        return {
          backend: "landlock",
          available: true,
          detail: "abi=" + String(abi) + " (mask-bisect)",
          handledMask: "0x" + mask.toString(16),
        };
      }
    }
    return { backend: "landlock", available: false, detail: "create_ruleset 全掩码失败", errorKind: "kernel-unsupported" };
  }

  private probeBwrap(): BackendProbe {
    const bin = this.deps.bwrapBinary();
    if (bin === null) {
      return { backend: "bwrap", available: false, detail: "bwrap 不在 PATH", errorKind: "binary-missing" };
    }
    const functional = this.deps.bwrapFunctional(bin);
    if (!functional.ok) {
      return { backend: "bwrap", available: false, detail: functional.detail, errorKind: "userns-unsupported" };
    }
    return { backend: "bwrap", available: true, detail: functional.detail };
  }

  private probeSeatbelt(): BackendProbe {
    const bin = this.deps.sandboxExecBinary();
    if (bin === null) {
      return { backend: "seatbelt", available: false, detail: "sandbox-exec 不在位", errorKind: "binary-missing" };
    }
    return { backend: "seatbelt", available: true, detail: bin };
  }

  // -- runSandboxed ----------------------------------------------------------

  /**
   * 按策略包装执行命令。
   * - mode=off：直接执行（backend "none"）。
   * - 有可用后端：按平台优先级选一个包装执行。
   * - 全不可用：fail-closed，返回 kind:"refused" 结构化拒绝（不执行命令）。
   */
  async runSandboxed(cmd: SandboxCommand, policy: SandboxPolicy, ctx: SandboxPathContext): Promise<SandboxOutcome> {
    if (typeof cmd.command !== "string" || cmd.command.length === 0) {
      throw new TypeError("runSandboxed: command 必须为非空字符串");
    }
    if (policy.mode === "off") {
      return this.spawnOutcome("none", this.deps.spawn(cmd.command, [...(cmd.args ?? [])], {
        cwd: cmd.cwd ?? undefined,
        env: { ...this.deps.env(), ...cmd.env },
        stdio: ["ignore", "pipe", "pipe"],
      }));
    }
    const probe = await this.probe();
    const preferredId = probe.preferred;
    if (preferredId === null) {
      return {
        kind: "refused",
        backend: null,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        refusals: probe.backends,
      };
    }
    if (!this.deps.exists(ctx.workspaceRoot)) {
      return {
        kind: "refused",
        backend: null,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        refusals: [
          { backend: preferredId, available: false, detail: ctx.workspaceRoot, errorKind: "workspace-root-missing" },
        ],
      };
    }
    const preferred = probe.backends.find((b) => b.backend === preferredId)!;
    if (preferredId === "landlock") return this.runLandlock(cmd, policy, ctx, preferred);
    if (preferredId === "bwrap") return this.runBwrap(cmd, policy, ctx);
    return this.runSeatbelt(cmd, policy, ctx);
  }

  private runLandlock(
    cmd: SandboxCommand,
    policy: SandboxPolicy,
    ctx: SandboxPathContext,
    probe: BackendProbe,
  ): SandboxOutcome {
    const handledMask = probe.handledMask ? BigInt(probe.handledMask) : ABI_FS_MASKS[0]!.mask;
    const profileJson = landlockProfileArgs(policy, ctx, { handledMask })[0];
    const env = {
      ...this.deps.env(),
      ...cmd.env,
      BI_SANDBOX_LL_PROFILE: profileJson ?? "",
      BI_SANDBOX_LL_PAYLOAD: JSON.stringify({
        command: cmd.command,
        args: [...(cmd.args ?? [])],
        cwd: cmd.cwd ?? null,
        env: {} as Record<string, string>,
      }),
    };
    return this.spawnOutcome("landlock", this.deps.spawn(this.deps.execPath(), ["-e", LANDLOCK_LOADER_SRC], {
      cwd: cmd.cwd ?? undefined,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  }

  private runBwrap(cmd: SandboxCommand, policy: SandboxPolicy, ctx: SandboxPathContext): SandboxOutcome {
    const bin = this.deps.bwrapBinary();
    if (bin === null) {
      return this.refuse({ backend: "bwrap", available: false, detail: "bwrap 消失于执行期", errorKind: "binary-missing" });
    }
    const args = [...bwrapProfile(policy, ctx), "--", cmd.command, ...(cmd.args ?? [])];
    return this.spawnOutcome("bwrap", this.deps.spawn(bin, args, {
      cwd: cmd.cwd ?? undefined,
      env: { ...this.deps.env(), ...cmd.env },
      stdio: ["ignore", "pipe", "pipe"],
    }));
  }

  private runSeatbelt(cmd: SandboxCommand, policy: SandboxPolicy, ctx: SandboxPathContext): SandboxOutcome {
    const bin = this.deps.sandboxExecBinary();
    if (bin === null) {
      return this.refuse({ backend: "seatbelt", available: false, detail: "sandbox-exec 消失于执行期", errorKind: "binary-missing" });
    }
    const args = ["-p", seatbeltProfile(policy, ctx), cmd.command, ...(cmd.args ?? [])];
    return this.spawnOutcome("seatbelt", this.deps.spawn(bin, args, {
      cwd: cmd.cwd ?? undefined,
      env: { ...this.deps.env(), ...cmd.env },
      stdio: ["ignore", "pipe", "pipe"],
    }));
  }

  // -- helpers ---------------------------------------------------------------

  private refuse(probe: BackendProbe): SandboxRunRefused {
    return { kind: "refused", backend: null, exitCode: null, signal: null, stdout: "", stderr: "", refusals: [probe] };
  }

  private spawnOutcome(backend: SandboxBackendId | "none", r: SpawnSyncReturns<Buffer>): SandboxRunOk {
    if (r.error !== undefined && r.error !== null) {
      return {
        kind: "ran",
        backend,
        exitCode: 127,
        signal: null,
        stdout: r.stdout?.toString("utf8") ?? "",
        stderr: "[os-sandbox] spawn error: " + r.error.message,
      };
    }
    return {
      kind: "ran",
      backend,
      exitCode: r.status ?? (r.signal !== null ? signalToExitCode(r.signal) : 255),
      signal: r.signal ?? null,
      stdout: r.stdout?.toString("utf8") ?? "",
      stderr: r.stderr?.toString("utf8") ?? "",
    };
  }
}
