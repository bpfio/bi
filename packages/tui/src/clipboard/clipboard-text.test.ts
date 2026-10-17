import { describe, expect, test } from "bun:test";
import {
  bunTextClipboardRunner,
  readClipboardText,
  resolveTextCommandMatrix,
  writeClipboardText,
} from "./clipboard-text";
import type { TextClipboardRunner, TextRunResult } from "./clipboard-text";

// ---------------------------------------------------------------------------
// 注入基建（全离屏，不碰真剪贴板）
// ---------------------------------------------------------------------------

interface ScriptedRunner {
  calls: { command: string; args: readonly string[]; input?: string }[];
  runner: TextClipboardRunner;
}

type ScriptStep = { code: number; stdout?: string; stderr?: string } | "throw";

function makeRunnerScript(steps: ScriptStep[]): ScriptedRunner {
  const calls: ScriptedRunner["calls"] = [];
  const queue = [...steps];
  const runner: TextClipboardRunner = async (command, args, input) => {
    calls.push({ command, args, input });
    const step = queue.shift();
    if (step === undefined || step === "throw") {
      throw new Error("runner-boom");
    }
    return { exitCode: step.code, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
  };
  return { calls, runner };
}

// ---------------------------------------------------------------------------
// resolveTextCommandMatrix —— 平台命令矩阵
// ---------------------------------------------------------------------------

describe("resolveTextCommandMatrix", () => {
  test("darwin → pbpaste 读 / pbcopy 写", () => {
    const m = resolveTextCommandMatrix("darwin", {});
    expect(m.read).toEqual([{ command: "pbpaste", args: [] }]);
    expect(m.write).toEqual([{ command: "pbcopy", args: [] }]);
  });

  test("win32 → powershell Get-Clipboard -Raw 读 / Set-Clipboard 写", () => {
    const m = resolveTextCommandMatrix("win32", {});
    expect(m.read).toHaveLength(1);
    expect(m.read[0]?.command).toBe("powershell");
    expect(m.read[0]?.args.join(" ")).toContain("Get-Clipboard -Raw");
    expect(m.write).toHaveLength(1);
    expect(m.write[0]?.command).toBe("powershell");
    expect(m.write[0]?.args.join(" ")).toContain("Set-Clipboard");
  });

  test("linux 无 WAYLAND_DISPLAY → xclip 优先，wl 回退", () => {
    const m = resolveTextCommandMatrix("linux", {});
    expect(m.read[0]?.command).toBe("xclip");
    expect(m.read[0]?.args).toEqual(["-selection", "clipboard", "-o"]);
    expect(m.read[1]?.command).toBe("wl-paste");
    expect(m.write[0]?.command).toBe("xclip");
    expect(m.write[0]?.args).toEqual(["-selection", "clipboard", "-i"]);
    expect(m.write[1]?.command).toBe("wl-copy");
  });

  test("linux 有 WAYLAND_DISPLAY → wl 优先，xclip 回退", () => {
    const m = resolveTextCommandMatrix("linux", { WAYLAND_DISPLAY: "wayland-0" });
    expect(m.read[0]?.command).toBe("wl-paste");
    expect(m.read[1]?.command).toBe("xclip");
    expect(m.write[0]?.command).toBe("wl-copy");
    expect(m.write[1]?.command).toBe("xclip");
  });

  test("未知平台 → 空命令矩阵", () => {
    const m = resolveTextCommandMatrix("freebsd", {});
    expect(m.read).toHaveLength(0);
    expect(m.write).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readClipboardText —— 读方向
// ---------------------------------------------------------------------------

describe("readClipboardText", () => {
  test("首条命令成功 → 返回其 stdout", async () => {
    const { calls, runner } = makeRunnerScript([{ code: 0, stdout: "hello clipboard" }]);
    const out = await readClipboardText({ runner, platform: "darwin", env: {} });
    expect(out).toBe("hello clipboard");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("pbpaste");
  });

  test("首条失败 → 回退链内下一条（linux xclip → wl-paste）", async () => {
    const { calls, runner } = makeRunnerScript([
      { code: 1, stderr: "no X server" },
      { code: 0, stdout: "wayland text" },
    ]);
    const out = await readClipboardText({ runner, platform: "linux", env: {} });
    expect(out).toBe("wayland text");
    expect(calls.map((c) => c.command)).toEqual(["xclip", "wl-paste"]);
  });

  test("全链失败 → null", async () => {
    const { runner } = makeRunnerScript([
      { code: 1 },
      { code: 127, stderr: "not found" },
    ]);
    const out = await readClipboardText({ runner, platform: "linux", env: {} });
    expect(out).toBeNull();
  });

  test("执行器抛错视同命令不可用 → 链内下一条", async () => {
    const { calls, runner } = makeRunnerScript(["throw", { code: 0, stdout: "ok" }]);
    const out = await readClipboardText({ runner, platform: "linux", env: {} });
    expect(out).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("未知平台 → null 且不调用执行器", async () => {
    const { calls, runner } = makeRunnerScript([]);
    const out = await readClipboardText({ runner, platform: "freebsd", env: {} });
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("空剪贴板（成功 + 空 stdout）→ 返回空串", async () => {
    const { runner } = makeRunnerScript([{ code: 0, stdout: "" }]);
    const out = await readClipboardText({ runner, platform: "darwin", env: {} });
    expect(out).toBe("");
  });
});

// ---------------------------------------------------------------------------
// writeClipboardText —— 写方向
// ---------------------------------------------------------------------------

describe("writeClipboardText", () => {
  test("写入成功 → true，input 透传给执行器", async () => {
    const { calls, runner } = makeRunnerScript([{ code: 0 }]);
    const ok = await writeClipboardText("要复制的文本", { runner, platform: "darwin", env: {} });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("pbcopy");
    expect(calls[0]?.input).toBe("要复制的文本");
  });

  test("首条失败 → 回退第二条且 input 一致 → true", async () => {
    const { calls, runner } = makeRunnerScript([{ code: 1 }, { code: 0 }]);
    const ok = await writeClipboardText("fallback text", { runner, platform: "linux", env: {} });
    expect(ok).toBe(true);
    expect(calls.map((c) => c.command)).toEqual(["xclip", "wl-copy"]);
    expect(calls[0]?.input).toBe("fallback text");
    expect(calls[1]?.input).toBe("fallback text");
  });

  test("全链失败 → false", async () => {
    const { runner } = makeRunnerScript([{ code: 1 }, { code: 1 }]);
    const ok = await writeClipboardText("x", { runner, platform: "linux", env: {} });
    expect(ok).toBe(false);
  });

  test("未知平台 → false 且不调用执行器", async () => {
    const { calls, runner } = makeRunnerScript([]);
    const ok = await writeClipboardText("x", { runner, platform: "freebsd", env: {} });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 回路与缺省执行器
// ---------------------------------------------------------------------------

describe("文本读写回路与 bunTextClipboardRunner", () => {
  test("注入对称伪执行器：write → read 原样取回", async () => {
    const store: { text?: string } = {};
    const runner: TextClipboardRunner = async (command, _args, input) => {
      if (command === "pbcopy") {
        if (input === undefined) return { exitCode: 1, stdout: "", stderr: "no input" };
        store.text = input;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command === "pbpaste") {
        return { exitCode: 0, stdout: store.text ?? "", stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: "unknown" };
    };
    const deps = { runner, platform: "darwin", env: {} };
    expect(await writeClipboardText("第一行\n第二行\n", deps)).toBe(true);
    expect(await readClipboardText(deps)).toBe("第一行\n第二行\n");
  });

  test("缺省执行器：cat 透传 stdin → stdout（真实 spawn，离屏最小用例）", async () => {
    const r = await bunTextClipboardRunner("cat", [], "spawn-input-194");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("spawn-input-194");
  });

  test("缺省执行器：不存在的命令 → 归一 exitCode 127（Bun.spawn 抛 ENOENT）", async () => {
    const r = await bunTextClipboardRunner("bi-no-such-binary-194", []);
    expect(r.exitCode).toBe(127);
    expect(r.stdout).toBe("");
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("缺省执行器：cat 读方向（无 stdin）→ exit 0 空 stdout", async () => {
    const r = await bunTextClipboardRunner("cat", []);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
  });
});

// 类型守卫：TextRunResult 形状不漂移
const _shape: TextRunResult = { exitCode: 0, stdout: "", stderr: "" };
void _shape;
