/**
 * clipboard-text —— 系统剪贴板文本读写（平台命令矩阵 + 可注入执行器）。
 *
 * BI-19.4 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 平台命令矩阵（读 / 写，按序探测，失败沿链回退）：
 *     darwin : pbpaste / pbcopy
 *     linux  : X11     xclip -selection clipboard -o（读） / -i（写）
 *              Wayland wl-paste --no-newline（读） / wl-copy（写）
 *              （WAYLAND_DISPLAY 非空 → Wayland 优先，失败回退 X11；反之亦然）
 *     win32  : powershell Get-Clipboard -Raw（读）
 *              powershell Set-Clipboard -Value ([Console]::In.ReadToEnd())（写，stdin 喂入，
 *              避开命令行参数转义；-Raw 保留换行不做修饰）
 *     其他平台：空命令矩阵（读 null / 写 false）
 * - 执行器可注入：TextClipboardRunner(command, args, input?) → { exitCode, stdout, stderr }；
 *   测试注入伪执行器（离屏，不碰真剪贴板）；缺省实现 bunTextClipboardRunner 基于 Bun.spawn；
 *   spawn 抛错（如 ENOENT）归一为 exitCode 127（command not found 惯例）；
 * - 失败语义：命令非零退出 / 执行器抛错 → 视为该命令不可用，试链内下一条；
 *   全链失败 → 读 null / 写 false；
 * - 语义约定：剪贴板为空时读取成功返回 ""（空判定交给调用方）；写方向 input 逐字节
 *   透传，读方向不做任何换行修饰（wl-paste 显式 --no-newline 保持原文）。
 */

/** 文本执行器单次运行结果。 */
export interface TextRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 文本剪贴板执行器（可注入伪实现）。
 * input === undefined 表示读方向（不喂 stdin）；string 表示写方向（input 即待写入文本）。
 */
export type TextClipboardRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<TextRunResult>;

/** 单条剪贴板命令规格。 */
export interface ClipboardCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
}

/** 平台命令矩阵：读 / 写各为一条按优先级排列的回退链。 */
export interface TextCommandMatrix {
  readonly read: readonly ClipboardCommandSpec[];
  readonly write: readonly ClipboardCommandSpec[];
}

/** 依赖集合（全部可注入；缺省取真实平台 / 环境与 Bun.spawn 执行器）。 */
export interface TextClipboardDeps {
  readonly runner: TextClipboardRunner;
  /** process.platform 语义（darwin / linux / win32 / ...）。 */
  readonly platform: string;
  /** 环境快照（用于 Wayland / X11 探测）。 */
  readonly env: Record<string, string | undefined>;
}

/** 缺省执行器：Bun.spawn，stdio 全 pipe；spawn 抛错归一为 127。 */
export const bunTextClipboardRunner: TextClipboardRunner = async (
  command,
  args,
  input,
) => {
  try {
    if (input === undefined) {
      const proc = Bun.spawn([command, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    }
    const proc = Bun.spawn([command, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      proc.stdin?.write(input);
      proc.stdin?.end();
    } catch {
      // 子进程提前退出（EPIPE 等）：交给 exited 收割退出码
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
};

function waylandActive(env: Record<string, string | undefined>): boolean {
  return typeof env["WAYLAND_DISPLAY"] === "string" && env["WAYLAND_DISPLAY"].length > 0;
}

/** 解析平台文本命令矩阵（纯函数，测试直接断言）。 */
export function resolveTextCommandMatrix(
  platform: string,
  env: Record<string, string | undefined>,
): TextCommandMatrix {
  if (platform === "darwin") {
    return {
      read: [{ command: "pbpaste", args: [] }],
      write: [{ command: "pbcopy", args: [] }],
    };
  }
  if (platform === "win32") {
    return {
      read: [
        {
          command: "powershell",
          args: ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
        },
      ],
      write: [
        {
          command: "powershell",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
          ],
        },
      ],
    };
  }
  if (platform === "linux") {
    const x11Read: ClipboardCommandSpec = {
      command: "xclip",
      args: ["-selection", "clipboard", "-o"],
    };
    const x11Write: ClipboardCommandSpec = {
      command: "xclip",
      args: ["-selection", "clipboard", "-i"],
    };
    const wlRead: ClipboardCommandSpec = {
      command: "wl-paste",
      args: ["--no-newline"],
    };
    const wlWrite: ClipboardCommandSpec = { command: "wl-copy", args: [] };
    const wl = waylandActive(env);
    return {
      read: wl ? [wlRead, x11Read] : [x11Read, wlRead],
      write: wl ? [wlWrite, x11Write] : [x11Write, wlWrite],
    };
  }
  return { read: [], write: [] };
}

function normalizeDeps(
  deps?: Partial<TextClipboardDeps>,
): Required<TextClipboardDeps> {
  return {
    runner: deps?.runner ?? bunTextClipboardRunner,
    platform: deps?.platform ?? process.platform,
    env: deps?.env ?? process.env,
  };
}

/**
 * 读取系统剪贴板文本。
 * 沿读链逐条尝试：非零退出 / 执行器抛错 → 下一条；全链失败 → null。
 */
export async function readClipboardText(
  deps?: Partial<TextClipboardDeps>,
): Promise<string | null> {
  const { runner, platform, env } = normalizeDeps(deps);
  const matrix = resolveTextCommandMatrix(platform, env);
  for (const spec of matrix.read) {
    let result: TextRunResult;
    try {
      result = await runner(spec.command, spec.args);
    } catch {
      continue; // 执行器抛错 = 该命令不可用
    }
    if (result.exitCode !== 0) continue;
    return result.stdout;
  }
  return null;
}

/**
 * 写入系统剪贴板文本。
 * 沿写链逐条尝试：零退出即成功（true）；全链失败 → false。
 */
export async function writeClipboardText(
  text: string,
  deps?: Partial<TextClipboardDeps>,
): Promise<boolean> {
  const { runner, platform, env } = normalizeDeps(deps);
  const matrix = resolveTextCommandMatrix(platform, env);
  for (const spec of matrix.write) {
    let result: TextRunResult;
    try {
      result = await runner(spec.command, spec.args, text);
    } catch {
      continue; // 执行器抛错 = 该命令不可用
    }
    if (result.exitCode === 0) return true;
  }
  return false;
}
