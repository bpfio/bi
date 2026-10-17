/**
 * clipboard-image —— 跨平台剪贴板图片探测与内容寻址落盘。
 *
 * BI-19.4 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 探测命令矩阵（按平台与环境排序，失败沿链回退）：
 *     linux/x11     : xclip -selection clipboard -t image/png -o  → stdout PNG 字节
 *     linux/wayland : wl-paste --type image/png                   → stdout PNG 字节
 *                     （WAYLAND_DISPLAY 非空 → Wayland 优先，失败回退 X11；反之亦然）
 *     darwin        : pngpaste -（stdout PNG 字节）
 *                     回退 osascript（«class PNGf» 写临时 PNG 文件）→ readFile 读取后清理
 *     win32         : powershell Get-Clipboard -Format Image → Save(Png) 临时文件
 *                     → readFile 读取后清理；无图时命令显式 exit 1
 *     其他平台      ：空探测链 → null
 * - 执行器可注入：ImageClipboardRunner(command, args) → { exitCode, stdout: Uint8Array, stderr }；
 *   测试注入伪执行器（离屏，不依赖真剪贴板）；缺省实现 bunImageClipboardRunner 基于 Bun.spawn；
 *   spawn 抛错（如 ENOENT）归一为 exitCode 127；
 * - PNG 魔数校验：\x89PNG\r\n\x1a\n（8 字节）；不匹配视为探测失败（链内下一条）；
 * - 落盘：SHA-256 内容寻址 ~/.bi/attachments/<hash>.png；已存在直接复用（去重，不重写）；
 * - 成功返回 { path, hash, bytes }（bytes = 字节数）；全链探测失败返回 null。
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile as fsReadFile,
  stat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 图片执行器单次运行结果（stdout 为原始字节）。 */
export interface ImageRunResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

/**
 * 图片剪贴板执行器（可注入伪实现；读方向，无 stdin 喂入）。
 */
export type ImageClipboardRunner = (
  command: string,
  args: readonly string[],
) => Promise<ImageRunResult>;

/** 单条图片探测规格。readFile 设置时：命令成功后从该路径读取字节（osascript / PowerShell 落盘模式）。 */
export interface ImageProbeSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly readFile?: string;
}

/** 文件系统最小契约（缺省 node:fs/promises；测试注入伪 fs）。 */
export interface ImageClipboardFs {
  exists(path: string): boolean | Promise<boolean>;
  mkdirp(dir: string): void | Promise<void>;
  writeFile(path: string, data: Uint8Array): void | Promise<void>;
  readFile(path: string): Uint8Array | Promise<Uint8Array>;
  unlink(path: string): void | Promise<void>;
}

/** 依赖集合（全部可注入；缺省取真实平台 / 环境 / 家目录 / Bun.spawn / node:fs）。 */
export interface ImageClipboardDeps {
  readonly runner: ImageClipboardRunner;
  readonly fs: ImageClipboardFs;
  /** process.platform 语义（darwin / linux / win32 / ...）。 */
  readonly platform: string;
  /** 环境快照（用于 Wayland / X11 探测）。 */
  readonly env: Record<string, string | undefined>;
  /** 用户家目录（落盘根）。 */
  readonly homeDir: string;
}

/** grabClipboardImage 可选参数（依赖注入 + 临时文件路径固定）。 */
export interface GrabClipboardImageOptions extends Partial<ImageClipboardDeps> {
  /** darwin/win32 落盘模式探测的临时 PNG 路径（缺省 os.tmpdir() 下；测试可固定断言）。 */
  readonly tmpPngPath?: string;
}

/** 剪贴板图片抓取结果。 */
export interface ClipboardImage {
  /** 已落盘文件绝对路径（~/.bi/attachments/<hash>.png）。 */
  readonly path: string;
  /** 内容 SHA-256 十六进制摘要。 */
  readonly hash: string;
  /** PNG 字节数。 */
  readonly bytes: number;
}

const PNG_MAGIC: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG 魔数校验（\x89PNG\r\n\x1a\n）。 */
export function isPngBytes(data: Uint8Array): boolean {
  if (data.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (data[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

/** SHA-256 十六进制摘要（内容寻址主键）。 */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 缺省执行器：Bun.spawn（stdin ignore，stdout 字节）；spawn 抛错归一为 127。 */
export const bunImageClipboardRunner: ImageClipboardRunner = async (command, args) => {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdoutBuf, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout: new Uint8Array(stdoutBuf), stderr };
  } catch (err) {
    return {
      exitCode: 127,
      stdout: new Uint8Array(0),
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
};

/** 缺省 fs：node:fs/promises（stat 探在 / mkdir -p / 读写删）。 */
export const nodeImageClipboardFs: ImageClipboardFs = {
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false,
    ),
  mkdirp: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: async (path, data) => {
    await fsWriteFile(path, data);
  },
  readFile: async (path) => new Uint8Array(await fsReadFile(path)),
  unlink: async (path) => {
    await fsUnlink(path);
  },
};

function defaultTmpPngPath(): string {
  return join(tmpdir(), "bi-clipboard-image.png");
}

/**
 * 构建平台图片探测链（纯函数，测试直接断言顺序与 readFile 标注）。
 */
export function buildImageProbeChain(
  platform: string,
  env: Record<string, string | undefined>,
  opts: { readonly tmpPngPath?: string } = {},
): readonly ImageProbeSpec[] {
  if (platform === "darwin") {
    const tmp = opts.tmpPngPath ?? defaultTmpPngPath();
    return [
      // pngpaste 直出 stdout（brew 安装场景，最快路径）
      { command: "pngpaste", args: ["-"] },
      // osascript 回退：«class PNGf» 原始字节写临时文件（macOS 自带，无需额外依赖）
      {
        command: "osascript",
        args: [
          "-e",
          "set pngData to (the clipboard as «class PNGf»)",
          "-e",
          `set fileHandle to open for access POSIX file "${tmp}" with write permission`,
          "-e",
          "set eof of fileHandle to 0",
          "-e",
          "write pngData to fileHandle",
          "-e",
          "close access fileHandle",
        ],
        readFile: tmp,
      },
    ];
  }
  if (platform === "win32") {
    const tmp = opts.tmpPngPath ?? defaultTmpPngPath();
    const psPath = tmp.replace(/'/g, "''");
    return [
      {
        command: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; " +
            "Add-Type -AssemblyName System.Drawing; " +
            "$img = Get-Clipboard -Format Image; " +
            "if ($img -eq $null) { exit 1 } " +
            `$img.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
        ],
        readFile: tmp,
      },
    ];
  }
  if (platform === "linux") {
    const x11: ImageProbeSpec = {
      command: "xclip",
      args: ["-selection", "clipboard", "-t", "image/png", "-o"],
    };
    const wl: ImageProbeSpec = {
      command: "wl-paste",
      args: ["--type", "image/png"],
    };
    const wayland =
      typeof env["WAYLAND_DISPLAY"] === "string" && env["WAYLAND_DISPLAY"].length > 0;
    return wayland ? [wl, x11] : [x11, wl];
  }
  return [];
}

/** 单条探测：exit 0 + 字节有效（stdout 直出或 readFile 落盘）→ 字节；否则 null。 */
async function probeOnce(
  runner: ImageClipboardRunner,
  fs: ImageClipboardFs,
  spec: ImageProbeSpec,
): Promise<Uint8Array | null> {
  let result: ImageRunResult;
  try {
    result = await runner(spec.command, spec.args);
  } catch {
    return null; // 执行器抛错 = 该命令不可用
  }
  if (result.exitCode !== 0) return null;
  if (spec.readFile === undefined) {
    return isPngBytes(result.stdout) ? result.stdout : null;
  }
  try {
    const data = await fs.readFile(spec.readFile);
    try {
      await fs.unlink(spec.readFile); // 尽力清理临时文件
    } catch {
      // 清理失败不影响结果
    }
    return isPngBytes(data) ? data : null;
  } catch {
    return null; // 临时文件缺失 / 不可读
  }
}

/** 内容寻址落盘：SHA-256 → ~/.bi/attachments/<hash>.png；已存在直接复用。 */
async function storeContentAddressed(
  png: Uint8Array,
  fs: ImageClipboardFs,
  homeDir: string,
): Promise<ClipboardImage> {
  const hash = sha256Hex(png);
  const dir = join(homeDir, ".bi", "attachments");
  const path = join(dir, `${hash}.png`);
  if (await fs.exists(path)) {
    return { path, hash, bytes: png.byteLength }; // 去重：已存在直接复用，不重写
  }
  await fs.mkdirp(dir);
  await fs.writeFile(path, png);
  return { path, hash, bytes: png.byteLength };
}

/**
 * 抓取系统剪贴板图片并内容寻址落盘。
 * 探测链全失败 / 无有效 PNG → null；成功 → { path, hash, bytes }（同内容二次抓取复用同一盘上文件）。
 */
export async function grabClipboardImage(
  opts: GrabClipboardImageOptions = {},
): Promise<ClipboardImage | null> {
  const runner = opts.runner ?? bunImageClipboardRunner;
  const fs = opts.fs ?? nodeImageClipboardFs;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();
  const chain = buildImageProbeChain(platform, env, { tmpPngPath: opts.tmpPngPath });

  let png: Uint8Array | null = null;
  for (const spec of chain) {
    png = await probeOnce(runner, fs, spec);
    if (png !== null) break;
  }
  if (png === null) return null;
  return storeContentAddressed(png, fs, homeDir);
}
