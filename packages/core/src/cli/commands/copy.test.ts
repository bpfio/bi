/**
 * BI-24.x · `copy` 子命令测试。
 *
 * 覆盖：四字段语义（id/title/last-reply + 非法字段 invalid-field）、最近会话缺省、
 * 显式 sessionId、剪贴板三平台分派（CmdRunner 替身记录被调用的命令）、
 * 全缺失降级 stdout、未知会话 session-missing。
 * 全部用例注入临时会话目录与 CmdRunner 替身，绝不触碰 ~/.bi 或真实剪贴板。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../session/manager";
import { type CmdRunner, type ClipboardPlatform, copyToClipboard, detectPlatform, handleCopy } from "./copy";
import { runBi } from "../main";
import type { SubcommandDeps } from "./dispatch";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

// —— 收集型 IO 替身 ——
interface Collector {
  out: string[];
  err: string[];
  io: { out: (l: string) => void; err: (l: string) => void };
}
function collector(): Collector {
  const c: Collector = { out: [], err: [], io: { out: () => {}, err: () => {} } };
  c.io = {
    out: (l) => c.out.push(l),
    err: (l) => c.err.push(l),
  };
  return c;
}

// —— CmdRunner 替身：记录被调用的命令，并按规则决定 exitCode ——
function fakeRunner(opts: {
  /** 视为「存在且成功」的命令名子集（其余视为缺失 exit 1）。 */
  available?: string[];
  /** 记录调用序列。 */
  log?: string[];
} = {}): CmdRunner {
  const available = new Set(opts.available ?? []);
  return {
    async run(command: string, _args: readonly string[]) {
      opts.log?.push(command);
      return { exitCode: available.has(command) ? 0 : 1 };
    },
  };
}

const FIXED_NOW = () => 1700000000000;
function makeIdGen(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
}
async function tmpManager(): Promise<SessionManager> {
  const root = await mkdtemp(join(tmpdir(), "bi-copy-"));
  dirs.push(root);
  return new SessionManager({ rootDir: join(root, "sessions"), now: FIXED_NOW, generateId: makeIdGen() });
}

/** 构造会话：含 user→assistant→user→assistant 链，末条 assistant 文本为给定值。 */
async function setupSession(lastReply: string): Promise<{ mgr: SessionManager; sessionId: string }> {
  const mgr = await tmpManager();
  const meta = await mgr.createSession({ sessionId: "s1", title: "我的会话" });
  const e1 = await mgr.append(meta.sessionId, null, { type: "user", payload: { text: "问1" } });
  const e2 = await mgr.append(meta.sessionId, e1.id, { type: "assistant", payload: { text: "答1" } });
  const e3 = await mgr.append(meta.sessionId, e2.id, { type: "user", payload: { text: "问2" } });
  await mgr.append(meta.sessionId, e3.id, { type: "assistant", payload: { text: lastReply } });
  return { mgr, sessionId: meta.sessionId };
}

function deps(over: Partial<SubcommandDeps> & { sessionsRoot: string }): SubcommandDeps {
  return over;
}

describe("BI-24.x copy：字段语义", () => {
  test("field=id 默认复制会话 id", async () => {
    const { mgr } = await setupSession("末条回复");
    const c = collector();
    const code = await handleCopy([], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("s1");
  });

  test("field=title 复制会话标题", async () => {
    const { mgr } = await setupSession("末条回复");
    const c = collector();
    const code = await handleCopy(["s1", "-f", "title"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("我的会话");
  });

  test("field=last-reply 复制末条 assistant 文本", async () => {
    const { mgr } = await setupSession("末条回复文本");
    const c = collector();
    const code = await handleCopy(["s1", "-f", "last-reply"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["pbcopy"] }),
      osPlatform: "darwin",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("末条回复文本");
  });

  test("last-reply 无 assistant 条目时返回空串（不报错）", async () => {
    const mgr = await tmpManager();
    const meta = await mgr.createSession({ sessionId: "s-empty", title: "空" });
    const e1 = await mgr.append(meta.sessionId, null, { type: "user", payload: { text: "只问不答" } });
    await mgr.append(meta.sessionId, e1.id, { type: "user", payload: { text: "再问" } });
    const c = collector();
    const code = await handleCopy(["s-empty", "-f", "last-reply"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("");
  });

  test("非法字段 -f bogus 触发 invalid-field 归 exit 2", async () => {
    const { mgr } = await setupSession("末条回复");
    const c = collector();
    const code = await handleCopy(["s1", "-f", "bogus"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(2);
    expect(c.err.join(" ")).toContain("非法字段");
  });

  test("--field= 等号形式同样生效", async () => {
    const { mgr } = await setupSession("末条回复");
    const c = collector();
    const code = await handleCopy(["s1", "--field=title"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("我的会话");
  });
});

describe("BI-24.x copy：最近会话缺省与显式 id", () => {
  test("缺省位置参数 = 复制最近会话（listSessions 首条）id", async () => {
    const mgr = await tmpManager();
    // 先建旧会话（createdAt 较早），再建新会话（时间戳递增，确保最近排序在前）
    let t = 1700000000000;
    const mgr2 = new SessionManager({ rootDir: mgr.rootDir, now: () => t, generateId: makeIdGen() });
    const old = await mgr2.createSession({ sessionId: "old", title: "旧" });
    await mgr2.append(old.sessionId, null, { type: "user", payload: { text: "x" } });
    t += 1000;
    const newer = await mgr2.createSession({ sessionId: "new", title: "新" });
    await mgr2.append(newer.sessionId, null, { type: "user", payload: { text: "y" } });
    const c = collector();
    const code = await handleCopy([], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("new");
  });

  test("无会话且未指定 id → exit 1 结构化提示", async () => {
    const mgr = await tmpManager();
    const c = collector();
    const code = await handleCopy([], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(1);
    expect(c.err.join(" ")).toContain("无会话");
  });

  test("显式 sessionId 定位正确会话（不受最近会话影响）", async () => {
    const mgr = await tmpManager();
    await mgr.createSession({ sessionId: "a", title: "A" });
    await mgr.createSession({ sessionId: "b", title: "B" });
    const c = collector();
    const code = await handleCopy(["a", "-f", "title"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["pbcopy"] }),
      osPlatform: "darwin",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("A");
  });
});

describe("BI-24.x copy：未知会话", () => {
  test("显式不存在的 sessionId → session-missing 归 exit 1", async () => {
    const mgr = await tmpManager();
    const c = collector();
    const code = await handleCopy(["ghost", "-f", "id"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"] }),
      osPlatform: "linux",
    }));
    expect(code).toBe(1);
    expect(c.err.join(" ")).toContain("会话不存在");
  });
});

describe("BI-24.x copy：剪贴板三平台分派（CmdRunner 替身）", () => {
  test("Linux：xclip 可用 → 调用 xclip 写入", async () => {
    const { mgr } = await setupSession("末条");
    const log: string[] = [];
    const c = collector();
    const code = await handleCopy(["s1"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["xclip"], log }),
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    expect(log[0]).toBe("xclip");
    expect(c.err.join(" ")).toContain("xclip");
  });

  test("Linux：xclip 缺失但 wl-copy 可用 → 调用 wl-copy 写入", async () => {
    const { mgr } = await setupSession("末条");
    const log: string[] = [];
    const c = collector();
    const code = await handleCopy(["s1"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["wl-copy"], log }),
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    // 探活调用过 xclip（exit 1 → 不可用），最终写入工具为 wl-copy
    expect(log[0]).toBe("xclip");
    expect(log.at(-1)).toBe("wl-copy");
    expect(c.err.join(" ")).toContain("wl-copy");
  });

  test("macOS：调用 pbcopy 写入", async () => {
    const { mgr } = await setupSession("末条");
    const log: string[] = [];
    const c = collector();
    const code = await handleCopy(["s1"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["pbcopy"], log }),
      osPlatform: "darwin",
    }));
    expect(code).toBe(0);
    expect(log[0]).toBe("pbcopy");
    expect(c.err.join(" ")).toContain("pbcopy");
  });

  test("Windows(GitBash)：osType=msys → 调用 clip 写入", async () => {
    const { mgr } = await setupSession("末条");
    const log: string[] = [];
    const c = collector();
    const code = await handleCopy(["s1"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: ["clip"], log }),
      osType: "msys",
      osPlatform: "win32",
    }));
    expect(code).toBe(0);
    expect(log[0]).toBe("clip");
    expect(c.err.join(" ")).toContain("clip");
  });

  test("detectPlatform：OSTYPE 覆盖优先于 process.platform", async () => {
    expect(detectPlatform({ osType: "msys", osPlatform: "linux" })).toBe("windows");
    expect(detectPlatform({ osType: "darwin", osPlatform: "linux" })).toBe("macos");
    expect(detectPlatform({ osPlatform: "linux" })).toBe("linux");
    expect(detectPlatform({ osPlatform: "darwin" })).toBe("macos");
    expect(detectPlatform({ osPlatform: "win32" })).toBe("windows");
    expect(detectPlatform({ osPlatform: "freebsd" })).toBe("unknown");
  });
});

describe("BI-24.x copy：全缺失降级 stdout", () => {
  test("三平台剪贴板全缺失 → 降级 stdout 直出 + 结构化提示，exit 0", async () => {
    const { mgr } = await setupSession("末条回复");
    const c = collector();
    const code = await handleCopy(["s1", "-f", "id"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: [] }), // 无任何剪贴板工具
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("s1");
    expect(c.err.join(" ")).toContain("剪贴板工具缺失，已打印到 stdout");
  });

  test("unknown 平台（无 OSTYPE/无匹配）→ 同样降级 stdout", async () => {
    const { mgr } = await setupSession("末条回复");
    const c = collector();
    const code = await handleCopy(["s1", "-f", "title"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: fakeRunner({ available: [] }),
      osPlatform: "freebsd",
    }));
    expect(code).toBe(0);
    expect(c.out).toContain("我的会话");
    expect(c.err.join(" ")).toContain("剪贴板工具缺失");
  });

  test("剪贴板可用时文本经 stdin input 喂入(主控验收回归:管道不可缺)", async () => {
    const { mgr } = await setupSession("末条回复");
    const c = collector();
    const seen: Array<{ command: string; input?: string }> = [];
    const recordingRunner: CmdRunner = {
      async run(command: string, _args: readonly string[], input?: string) {
        seen.push({ command, input });
        return { exitCode: 0 };
      },
    };
    const code = await handleCopy(["s1", "-f", "last-reply"], c.io, deps({
      sessionsRoot: mgr.rootDir,
      cmdRunner: recordingRunner,
      osPlatform: "linux",
    }));
    expect(code).toBe(0);
    const probe = seen.find((s) => s.command === "xclip" && s.input === undefined);
    const write = seen.find((s) => s.command === "xclip" && s.input === "末条回复");
    expect(probe).toBeDefined(); // 探活不带 stdin
    expect(write).toBeDefined(); // 写入必须喂入文本,不许空管道
  });
});

describe("copyToClipboard 纯函数（不依赖 handleCopy）", () => {
  test("unknown 平台 → written=false", async () => {
    const r = await copyToClipboard("x", "unknown", fakeRunner({ available: [] }));
    expect(r.written).toBe(false);
  });
  test("windows 平台 → 调用 clip 且 written=true", async () => {
    const log: string[] = [];
    const r = await copyToClipboard("x", "windows" as ClipboardPlatform, fakeRunner({ available: ["clip"], log }));
    expect(r.written).toBe(true);
    expect(log[0]).toBe("clip");
  });
});

describe("PROD-2 copy · help 面与用法提示", () => {
  test("bi copy --help → exit 0 且含 -f <field>", async () => {
    const c = collector();
    const code = await runBi(["copy", "--help"], { ...c.io });
    expect(code).toBe(0);
    expect(c.out.join("\n")).toContain("-f <field>");
    expect(c.out.join("\n")).not.toContain("运行 bi copy --help 查看用法");
  });

  test("用法错误尾部追加 help 提示（非法字段 → exit 2）", async () => {
    const mgr = await tmpManager();
    const c = collector();
    const code = await handleCopy(["s1", "-f", "bogus"], c.io, deps({ sessionsRoot: mgr.rootDir, cmdRunner: fakeRunner({ available: [] }) }));
    expect(code).toBe(2);
    expect(c.err.join("\n")).toContain("运行 bi copy --help 查看用法");
  });

  test("PROD-2 验收补漏：未知旗标不再静默吞掉 → exit 2 + help 提示", async () => {
    const mgr = await tmpManager();
    const c = collector();
    const code = await handleCopy(["--bogus"], c.io, deps({ sessionsRoot: mgr.rootDir, cmdRunner: fakeRunner({ available: [] }) }));
    expect(code).toBe(2);
    expect(c.err.join("\n")).toContain("未知旗标: --bogus");
    expect(c.err.join("\n")).toContain("运行 bi copy --help 查看用法");
  });
});
