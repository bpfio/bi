/**
 * desktop-notify —— 桌面通知命令构造与分发。
 *
 * BI-19.3 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 平台探测：linux → notify-send，darwin → osascript，win32 → powershell；
 *   其余平台 → 结构化 { status: "unavailable", reason }；
 * - 注入安全：命令一律以参数数组直达 spawn（不经 shell，linux 下标题/正文
 *   含 $(…) 等元字符时保持字面量）；darwin 的 AppleScript 字符串字面量就地
 *   转义（\ → \\、" → \"）；win32 的 PowerShell 单引号字面量就地转义
 *   （' → ''，单引号串不插值）；
 * - dryRun: true → 只返回构造出的 command/args，不执行（spawn 不被调用）；
 * - spawn 可注入（测试注入 spy 逐项断言命令与参数）；缺省用
 *   node:child_process.spawn（stdio ignore + unref，error 静默——通知通道
 *   故障不阻塞主流程）。
 */

import { spawn as nodeSpawn } from "node:child_process";

/** 通知分发用的最小 spawn 契约（参数数组直达，不经 shell）。 */
export type NotifySpawn = (command: string, args: readonly string[]) => unknown;

export interface DesktopNotifyOptions {
  /** 平台覆盖（缺省 process.platform；测试显式注入）。 */
  readonly platform?: NodeJS.Platform;
  /** true 时只构造命令不执行。 */
  readonly dryRun?: boolean;
  /** spawn 注入（缺省 node:child_process.spawn）。 */
  readonly spawn?: NotifySpawn;
}

export type NotifyOutcome =
  | { readonly status: "sent"; readonly command: string; readonly args: readonly string[] }
  | { readonly status: "dry-run"; readonly command: string; readonly args: readonly string[] }
  | { readonly status: "unavailable"; readonly reason: string };

/** AppleScript 字符串字面量转义。 */
function appleScriptQuote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** PowerShell 单引号字面量转义（单引号串内不插值）。 */
function powerShellQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** 平台 → (command, args) 构造；不支持的平台返回 null。 */
function buildCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): { command: string; args: string[] } | null {
  switch (platform) {
    case "linux":
      // notify-send <summary> [body]：参数数组直达，无 shell 插值面。
      return { command: "notify-send", args: [title, body] };
    case "darwin":
      return {
        command: "osascript",
        args: [
          "-e",
          `display notification ${appleScriptQuote(body)} with title ${appleScriptQuote(title)}`,
        ],
      };
    case "win32":
      return {
        command: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName System.Drawing; " +
            "Add-Type -AssemblyName System.Windows.Forms; " +
            "$n = New-Object System.Windows.Forms.NotifyIcon; " +
            "$n.Icon = [System.Drawing.SystemIcons]::Information; " +
            "$n.Visible = $true; " +
            `$n.ShowBalloonTip(5000, ${powerShellQuote(title)}, ${powerShellQuote(body)}, ` +
            "[System.Windows.Forms.ToolTipIcon]::None)",
        ],
      };
    default:
      return null;
  }
}

/** 缺省真实分发：stdio ignore + unref，error 静默。 */
function defaultSpawn(command: string, args: readonly string[]): unknown {
  const child = nodeSpawn(command, [...args], { stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return child;
}

/** 发送桌面通知：平台探测 → 命令构造 → 转义安全分发（或 dry-run/unavailable）。 */
export function sendDesktopNotify(
  title: string,
  body: string,
  opts: DesktopNotifyOptions = {},
): NotifyOutcome {
  const platform = opts.platform ?? process.platform;
  const built = buildCommand(platform, title, body);
  if (built === null) {
    return { status: "unavailable", reason: `unsupported platform: ${String(platform)}` };
  }
  if (opts.dryRun) {
    return { status: "dry-run", command: built.command, args: built.args };
  }
  const spawn = opts.spawn ?? defaultSpawn;
  spawn(built.command, built.args);
  return { status: "sent", command: built.command, args: built.args };
}
