import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  buildImageProbeChain,
  grabClipboardImage,
  isPngBytes,
  sha256Hex,
} from "./clipboard-image";
import type {
  ImageClipboardFs,
  ImageClipboardRunner,
  ImageProbeSpec,
  ImageRunResult,
} from "./clipboard-image";

// ---------------------------------------------------------------------------
// 注入基建（全离屏，不依赖真剪贴板）
// ---------------------------------------------------------------------------

/** 合成 PNG 字节：魔数 + 4 字节 tag + 填充（同 tag 内容一致，用于去重断言）。 */
function makePng(tag: number): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  new DataView(bytes.buffer).setUint32(8, tag);
  return bytes;
}

function makeTextBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface FakeFsHarness {
  fs: ImageClipboardFs;
  files: Map<string, Uint8Array>;
  writes: { path: string; data: Uint8Array }[];
  mkdirs: string[];
  unlinks: string[];
  reads: string[];
}

function makeFs(seed: Record<string, Uint8Array> = {}): FakeFsHarness {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const writes: FakeFsHarness["writes"] = [];
  const mkdirs: string[] = [];
  const unlinks: string[] = [];
  const reads: string[] = [];
  const fs: ImageClipboardFs = {
    exists: async (p) => files.has(p),
    mkdirp: async (d) => {
      mkdirs.push(d);
    },
    writeFile: async (p, d) => {
      writes.push({ path: p, data: d });
      files.set(p, d);
    },
    readFile: async (p) => {
      reads.push(p);
      const f = files.get(p);
      if (f === undefined) throw new Error("ENOENT: no such file");
      return f;
    },
    unlink: async (p) => {
      unlinks.push(p);
      files.delete(p);
    },
  };
  return { fs, files, writes, mkdirs, unlinks, reads };
}

interface FakeRunnerHarness {
  calls: string[];
  runner: ImageClipboardRunner;
}

/** 按命令名路由的伪执行器：路由缺失或 "throw" 视为不可用（抛错）。 */
function makeImageRunner(routes: Record<string, ImageRunResult | "throw">): FakeRunnerHarness {
  const calls: string[] = [];
  const runner: ImageClipboardRunner = async (command) => {
    calls.push(command);
    const r = routes[command];
    if (r === undefined || r === "throw") {
      throw new Error(`unexpected command: ${command}`);
    }
    return r;
  };
  return { calls, runner };
}

function okBytes(stdout: Uint8Array): ImageRunResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(code: number, stderr = ""): ImageRunResult {
  return { exitCode: code, stdout: new Uint8Array(0), stderr };
}

const deps = (over: {
  runner: ImageClipboardRunner;
  fs: ImageClipboardFs;
  platform?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  tmpPngPath?: string;
}) => over;

// ---------------------------------------------------------------------------
// 探测链构建
// ---------------------------------------------------------------------------

describe("buildImageProbeChain", () => {
  test("darwin：pngpaste stdout 优先，osascript 临时文件回退（readFile 标注）", () => {
    const chain = buildImageProbeChain("darwin", {}, { tmpPngPath: "/t/fake.png" });
    expect(chain).toHaveLength(2);
    expect(chain[0]?.command).toBe("pngpaste");
    expect(chain[0]?.args).toEqual(["-"]);
    expect(chain[1]?.command).toBe("osascript");
    expect(chain[1]?.readFile).toBe("/t/fake.png");
  });

  test("linux 无 WAYLAND_DISPLAY → xclip -t image/png -o 优先，wl-paste 回退", () => {
    const chain = buildImageProbeChain("linux", {});
    expect(chain.map((s: ImageProbeSpec) => s.command)).toEqual(["xclip", "wl-paste"]);
    expect(chain[0]?.args).toEqual(["-selection", "clipboard", "-t", "image/png", "-o"]);
    expect(chain[1]?.args).toEqual(["--type", "image/png"]);
  });

  test("linux 有 WAYLAND_DISPLAY → wl-paste 优先", () => {
    const chain = buildImageProbeChain("linux", { WAYLAND_DISPLAY: "wayland-0" });
    expect(chain.map((s: ImageProbeSpec) => s.command)).toEqual(["wl-paste", "xclip"]);
  });

  test("win32 → powershell 落盘模式；未知平台 → 空链", () => {
    const win = buildImageProbeChain("win32", {}, { tmpPngPath: "C:\\t\\x.png" });
    expect(win).toHaveLength(1);
    expect(win[0]?.command).toBe("powershell");
    expect(win[0]?.args.join(" ")).toContain("Get-Clipboard -Format Image");
    expect(win[0]?.readFile).toBe("C:\\t\\x.png");
    expect(buildImageProbeChain("freebsd", {})).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// grabClipboardImage —— 探测、校验与落盘
// ---------------------------------------------------------------------------

describe("grabClipboardImage：linux 探测与落盘", () => {
  test("x11 探测成功 → SHA-256 内容寻址落盘 ~/.bi/attachments/<hash>.png", async () => {
    const png = makePng(1);
    const { calls, runner } = makeImageRunner({ xclip: okBytes(png) });
    const { fs, writes, mkdirs } = makeFs();
    const img = await grabClipboardImage(deps({ runner, fs, platform: "linux", env: {}, homeDir: "/home/tester" }));
    expect(img).not.toBeNull();
    const hash = createHash("sha256").update(png).digest("hex");
    expect(img?.hash).toBe(hash);
    expect(img?.bytes).toBe(png.byteLength);
    expect(img?.path).toBe(`/home/tester/.bi/attachments/${hash}.png`);
    expect(calls).toEqual(["xclip"]);
    expect(mkdirs).toEqual(["/home/tester/.bi/attachments"]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(img?.path);
    expect(writes[0]?.data).toEqual(png);
  });

  test("两次同内容只落一盘（去重复用，不重写）", async () => {
    const png = makePng(2);
    const { calls, runner } = makeImageRunner({ xclip: okBytes(png) });
    const { fs, writes, mkdirs } = makeFs();
    const d = deps({ runner, fs, platform: "linux", env: {}, homeDir: "/home/u" });
    const first = await grabClipboardImage(d);
    const second = await grabClipboardImage(d);
    expect(first).not.toBeNull();
    expect(second?.path).toBe(first?.path);
    expect(second?.hash).toBe(first?.hash);
    expect(second?.bytes).toBe(first?.bytes);
    expect(writes).toHaveLength(1);
    expect(mkdirs).toHaveLength(1);
    expect(calls).toHaveLength(2); // 每次都会重新探测剪贴板
  });

  test("盘上已存在同哈希文件 → 直接复用，不 mkdir 不重写", async () => {
    const png = makePng(3);
    const hash = sha256Hex(png);
    const existing = `/home/u/.bi/attachments/${hash}.png`;
    const { runner } = makeImageRunner({ xclip: okBytes(png) });
    const { fs, writes, mkdirs } = makeFs({ [existing]: png });
    const img = await grabClipboardImage(deps({ runner, fs, platform: "linux", env: {}, homeDir: "/home/u" }));
    expect(img?.path).toBe(existing);
    expect(img?.hash).toBe(hash);
    expect(writes).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
  });

  test("首条探测返回非 PNG 字节 → 链内下一条补位成功", async () => {
    const png = makePng(4);
    const { calls, runner } = makeImageRunner({
      xclip: okBytes(makeTextBytes("plain text, not png")),
      "wl-paste": okBytes(png),
    });
    const { fs, writes } = makeFs();
    const img = await grabClipboardImage(deps({ runner, fs, platform: "linux", env: {}, homeDir: "/home/u" }));
    expect(img?.hash).toBe(sha256Hex(png));
    expect(calls).toEqual(["xclip", "wl-paste"]);
    expect(writes).toHaveLength(1);
  });

  test("全链失败（非零退出）→ null 且无任何落盘", async () => {
    const { runner } = makeImageRunner({
      xclip: fail(1, "no X server"),
      "wl-paste": fail(1, "no compositor"),
    });
    const { fs, writes, mkdirs } = makeFs();
    const img = await grabClipboardImage(deps({ runner, fs, platform: "linux", env: {}, homeDir: "/home/u" }));
    expect(img).toBeNull();
    expect(writes).toHaveLength(0);
    expect(mkdirs).toHaveLength(0);
  });

  test("exit 0 但 stdout 为空字节 → 视为失败走下一条", async () => {
    const png = makePng(5);
    const { calls, runner } = makeImageRunner({
      xclip: okBytes(new Uint8Array(0)),
      "wl-paste": okBytes(png),
    });
    const { fs } = makeFs();
    const img = await grabClipboardImage(deps({ runner, fs, platform: "linux", env: {}, homeDir: "/home/u" }));
    expect(img?.bytes).toBe(png.byteLength);
    expect(calls).toEqual(["xclip", "wl-paste"]);
  });

  test("WAYLAND_DISPLAY 优先：两条都成功时取 wl-paste 字节", async () => {
    const wlPng = makePng(6);
    const x11Png = makePng(7);
    const { calls, runner } = makeImageRunner({
      "wl-paste": okBytes(wlPng),
      xclip: okBytes(x11Png),
    });
    const { fs } = makeFs();
    const img = await grabClipboardImage(
      deps({ runner, fs, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, homeDir: "/home/u" }),
    );
    expect(img?.hash).toBe(sha256Hex(wlPng));
    expect(calls[0]).toBe("wl-paste");
  });

  test("未知平台（空探测链）→ null 且不调用执行器", async () => {
    const { calls, runner } = makeImageRunner({});
    const { fs } = makeFs();
    const img = await grabClipboardImage(deps({ runner, fs, platform: "freebsd", env: {}, homeDir: "/home/u" }));
    expect(img).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("grabClipboardImage：darwin / win32 落盘模式", () => {
  test("darwin pngpaste stdout 直出成功，无临时文件读取", async () => {
    const png = makePng(8);
    const { calls, runner } = makeImageRunner({ pngpaste: okBytes(png) });
    const { fs, writes, unlinks, reads } = makeFs();
    const img = await grabClipboardImage(deps({ runner, fs, platform: "darwin", env: {}, homeDir: "/Users/u" }));
    expect(img?.hash).toBe(sha256Hex(png));
    expect(img?.path).toBe(`/Users/u/.bi/attachments/${sha256Hex(png)}.png`);
    expect(calls).toEqual(["pngpaste"]);
    expect(reads).toHaveLength(0);
    expect(unlinks).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  test("darwin pngpaste 失败 → osascript 写临时文件 → readFile 取字节并清理", async () => {
    const png = makePng(9);
    const tmp = "/tmp/fake-osascript-194.png";
    const { calls, runner } = makeImageRunner({
      pngpaste: fail(1),
      osascript: okBytes(new Uint8Array(0)),
    });
    const { fs, reads, unlinks, writes } = makeFs({ [tmp]: png });
    const img = await grabClipboardImage(
      deps({ runner, fs, platform: "darwin", env: {}, homeDir: "/Users/u", tmpPngPath: tmp }),
    );
    expect(img?.hash).toBe(sha256Hex(png));
    expect(img?.bytes).toBe(png.byteLength);
    expect(calls).toEqual(["pngpaste", "osascript"]);
    expect(reads).toEqual([tmp]);
    expect(unlinks).toEqual([tmp]);
    expect(writes).toHaveLength(1);
  });

  test("darwin osascript 成功但临时文件缺失 → 继续链 / 最终 null", async () => {
    const tmp = "/tmp/missing-osascript-194.png";
    const { runner } = makeImageRunner({ pngpaste: fail(1), osascript: okBytes(new Uint8Array(0)) });
    const { fs, unlinks } = makeFs();
    const img = await grabClipboardImage(
      deps({ runner, fs, platform: "darwin", env: {}, homeDir: "/Users/u", tmpPngPath: tmp }),
    );
    expect(img).toBeNull();
    expect(unlinks).toHaveLength(0);
  });

  test("win32 powershell 落盘模式 → readFile 取字节成功落 attachments", async () => {
    const png = makePng(10);
    const tmp = "C:\\tmp\\bi-ps-194.png";
    const { calls, runner } = makeImageRunner({ powershell: okBytes(new Uint8Array(0)) });
    const { fs, reads, writes } = makeFs({ [tmp]: png });
    const img = await grabClipboardImage(
      deps({ runner, fs, platform: "win32", env: {}, homeDir: "C:\\Users\\u", tmpPngPath: tmp }),
    );
    expect(img?.hash).toBe(sha256Hex(png));
    expect(calls).toEqual(["powershell"]);
    expect(reads).toEqual([tmp]);
    expect(writes).toHaveLength(1);
  });

  test("win32 无图（exit 1）→ null", async () => {
    const { runner } = makeImageRunner({ powershell: fail(1) });
    const { fs, writes } = makeFs();
    const img = await grabClipboardImage(
      deps({ runner, fs, platform: "win32", env: {}, homeDir: "C:\\Users\\u", tmpPngPath: "C:\\t\\x.png" }),
    );
    expect(img).toBeNull();
    expect(writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 单元：PNG 魔数 / SHA-256
// ---------------------------------------------------------------------------

describe("isPngBytes / sha256Hex", () => {
  test("PNG 魔数：合法通过，过短 / 文本 / 首字节不符拒绝", () => {
    expect(isPngBytes(makePng(11))).toBe(true);
    expect(isPngBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isPngBytes(makeTextBytes("hello"))).toBe(false);
    expect(isPngBytes(new Uint8Array(0))).toBe(false);
  });

  test("sha256Hex 与 node:crypto 基准一致，且内容寻址同内容同哈希", () => {
    const data = makeTextBytes("bi-19.4 hash me");
    expect(sha256Hex(data)).toBe(createHash("sha256").update(data).digest("hex"));
    expect(sha256Hex(makePng(12))).toBe(sha256Hex(makePng(12)));
  });
});
