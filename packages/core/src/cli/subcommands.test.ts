/**
 * BI-24.1 —— 八子命令分发接线验收（init/session/fork/export/transfer/acp/upgrade/doctor）。
 *
 * 全部用例走 runBi 主分发 + SubcommandDeps 注入（临时目录 / 注入 IO / 替身检查），
 * 零网络、零真实子进程、绝不触碰 ~/.bi：
 *   - upgrade 只跑注入 probe/check 替身（真实 python3 子进程仅生产路径）；
 *   - doctor 只跑注入检查项（缺省端口有网络探测，测试绝不走到）；
 *   - acp 用注入 ReadableStream/收集器验证 Content-Length 握手帧。
 * 退出码语义：0 成功 / 1 运行期失败 / 2 用法错误 / 4 能力不在位。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "./main";
import { SessionManager } from "../session/manager";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function collect(): { io: { out: (line: string) => void; err: (line: string) => void }; outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { io: { out: (l) => outs.push(l), err: (l) => errs.push(l) }, outs, errs };
}

/** 会话夹具：临时根目录里创建 count 个会话（各带一条 user 根条目）。 */
async function makeSessions(count: number): Promise<{ root: string; ids: string[]; nodeIds: string[] }> {
  const root = await tmpDir("bi-sub-");
  const manager = new SessionManager({ rootDir: root });
  const ids: string[] = [];
  const nodeIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const meta = await manager.createSession({ title: `会话${i}` });
    ids.push(meta.sessionId);
    const entry = await manager.append(meta.sessionId, null, { type: "user", payload: { text: "问" } });
    nodeIds.push(entry.id);
  }
  return { root, ids, nodeIds };
}

// ---------------------------------------------------------------------------
// ACP 握手帧工具（Content-Length 头帧，字节级编解码）
// ---------------------------------------------------------------------------

function acpFrame(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj));
  const head = new TextEncoder().encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(head.byteLength + body.byteLength);
  frame.set(head, 0);
  frame.set(body, head.byteLength);
  return frame;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = new Uint8Array(a.byteLength + b.byteLength);
  merged.set(a, 0);
  merged.set(b, a.byteLength);
  return merged;
}

/** 从收集到的字节块解码全部 JSON-RPC 帧（按 Content-Length 字节数切，兼容多字节中文）。 */
function decodeFrames(chunks: Uint8Array[]): unknown[] {
  const all = chunks.reduce((acc, c) => concatBytes(acc, c), new Uint8Array(0));
  const frames: unknown[] = [];
  let cursor = 0;
  while (cursor < all.byteLength) {
    let headerEnd = -1;
    for (let i = cursor; i + 4 <= all.byteLength; i++) {
      if (all[i] === 13 && all[i + 1] === 10 && all[i + 2] === 13 && all[i + 3] === 10) {
        headerEnd = i;
        break;
      }
    }
    if (headerEnd === -1) break;
    const header = new TextDecoder("ascii").decode(all.subarray(cursor, headerEnd));
    const match = /content-length:\s*(\d+)/i.exec(header);
    if (match === null) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    frames.push(JSON.parse(new TextDecoder().decode(all.subarray(bodyStart, bodyStart + length))));
    cursor = bodyStart + length;
  }
  return frames;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe("BI-24.1 init（脚手架 .bi/local.toml 模板）", () => {
  test("happy：写入模板并报告路径；再次运行已存在不覆盖（幂等）", async () => {
    const root = await tmpDir("bi-init-");
    const first = collect();
    expect(await runBi(["init"], { ...first.io, deps: { cwd: root, homeDir: root } })).toBe(0);
    const target = join(root, ".bi", "local.toml");
    const template = await readFile(target, "utf8");
    expect(template).toContain("[workspace]");
    expect(template).toContain("additional_dir");
    expect(first.outs.join("\n")).toContain(target);

    const second = collect();
    expect(await runBi(["init"], { ...second.io, deps: { cwd: root, homeDir: root } })).toBe(0);
    expect(await readFile(target, "utf8")).toBe(template); // 内容原封不动
    expect(second.outs.join("\n")).toContain("已存在");
  });

  test("边界：--dir 重定向 + 未知参数 exit 2", async () => {
    const root = await tmpDir("bi-init-");
    const sub = join(root, "ws");
    const first = collect();
    expect(await runBi(["init", "--dir", sub], { ...first.io, deps: { cwd: root, homeDir: root } })).toBe(0);
    expect(await readFile(join(sub, ".bi", "local.toml"), "utf8")).toContain("[workspace]");

    const bad = collect();
    expect(await runBi(["init", "--bogus"], { ...bad.io, deps: { cwd: root, homeDir: root } })).toBe(2);
    expect(bad.errs.join("\n")).toContain("未知参数");
  });
});

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

describe("BI-24.1 session（列表 + 元数据）", () => {
  test("happy：JSON 行逐条输出元数据；--limit 截断", async () => {
    const { root, ids } = await makeSessions(2);
    const all = collect();
    expect(await runBi(["session"], { ...all.io, deps: { sessionsRoot: root } })).toBe(0);
    expect(all.outs).toHaveLength(2);
    const metas = all.outs.map((line) => JSON.parse(line) as { sessionId: string; title: string });
    expect(metas.map((m) => m.sessionId).sort()).toEqual([...ids].sort());

    const limited = collect();
    expect(await runBi(["session", "--limit", "1"], { ...limited.io, deps: { sessionsRoot: root } })).toBe(0);
    expect(limited.outs).toHaveLength(1);
  });

  test("边界：--limit 非整数 exit 2；空目录 exit 0 零条", async () => {
    const { root } = await makeSessions(1);
    const bad = collect();
    expect(await runBi(["session", "--limit", "abc"], { ...bad.io, deps: { sessionsRoot: root } })).toBe(2);
    expect(bad.errs.join("\n")).toContain("--limit");

    const empty = await tmpDir("bi-sub-empty-");
    const none = collect();
    expect(await runBi(["session"], { ...none.io, deps: { sessionsRoot: empty } })).toBe(0);
    expect(none.outs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fork
// ---------------------------------------------------------------------------

describe("BI-24.1 fork（会话分支）", () => {
  test("happy：从节点分叉出新会话，forkedFrom/title 记录", async () => {
    const { root, ids, nodeIds } = await makeSessions(1);
    const { io, outs } = collect();
    expect(
      await runBi(["fork", ids[0]!, nodeIds[0]!, "--title", "分支线"], { ...io, deps: { sessionsRoot: root } }),
    ).toBe(0);
    const manager = new SessionManager({ rootDir: root });
    const metas = await manager.listSessions();
    expect(metas).toHaveLength(2);
    const forked = metas.find((m) => m.sessionId !== ids[0]);
    expect(forked?.forkedFrom).toBe(ids[0]);
    expect(forked?.title).toBe("分支线");
    expect(outs.join("\n")).toContain(forked!.sessionId);
  });

  test("边界：源会话缺失 exit 1 结构化；缺位置参数 exit 2", async () => {
    const { root } = await makeSessions(1);
    const missing = collect();
    expect(await runBi(["fork", "no-such-session", "n1"], { ...missing.io, deps: { sessionsRoot: root } })).toBe(1);
    expect(missing.errs.join("\n")).toContain("源会话不存在");

    const usage = collect();
    expect(await runBi(["fork", "only-one-arg"], { ...usage.io, deps: { sessionsRoot: root } })).toBe(2);
    expect(usage.errs.join("\n")).toContain("用法");
  });
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe("BI-24.1 export（markdown/json 导出）", () => {
  test("happy：json 直出结构化内容；--out 落盘", async () => {
    const { root, ids } = await makeSessions(1);
    const direct = collect();
    expect(
      await runBi(["export", ids[0]!, "--format", "json"], { ...direct.io, deps: { sessionsRoot: root } }),
    ).toBe(0);
    const parsed = JSON.parse(direct.outs[0]!) as { meta: { sessionId: string }; entries: unknown[] };
    expect(parsed.meta.sessionId).toBe(ids[0]!);
    expect(parsed.entries).toHaveLength(1);

    const target = join(root, "out", "exp.md");
    const toFile = collect();
    expect(await runBi(["export", ids[0]!, "--out", target], { ...toFile.io, deps: { sessionsRoot: root } })).toBe(0);
    expect(toFile.outs.join("\n")).toContain("已写入");
    expect(await readFile(target, "utf8")).toContain(`# 会话0`);
  });

  test("边界：会话缺失 exit 1；非法格式 exit 2", async () => {
    const { root, ids } = await makeSessions(1);
    const missing = collect();
    expect(await runBi(["export", "no-such"], { ...missing.io, deps: { sessionsRoot: root } })).toBe(1);
    expect(missing.errs.join("\n")).toContain("会话不存在");

    const badFormat = collect();
    expect(
      await runBi(["export", ids[0]!, "--format", "xml"], { ...badFormat.io, deps: { sessionsRoot: root } }),
    ).toBe(2);
    expect(badFormat.errs.join("\n")).toContain("--format");
  });
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

describe("BI-24.1 transfer（脱敏导出 / 归档导入）", () => {
  test("happy：export --sanitize 落盘归档", async () => {
    const { root, ids } = await makeSessions(1);
    const archivePath = join(root, "arch.json");
    const { io, outs, errs } = collect();
    expect(
      await runBi(["transfer", "export", "--sanitize", ids[0]!, "--out", archivePath], {
        ...io,
        deps: { sessionsRoot: root },
      }),
    ).toBe(0);
    const archive = JSON.parse(await readFile(archivePath, "utf8")) as { meta: { sessionId: string } };
    expect(archive.meta.sessionId).toBe(ids[0]!);
    expect(outs.join("\n")).toContain("已写入");
    expect(errs.join("\n")).toContain(ids[0]!);
  });

  test("边界：无子命令 exit 2（结构化用法）", async () => {
    const { root } = await makeSessions(1);
    const { io, errs } = collect();
    expect(await runBi(["transfer"], { ...io, deps: { sessionsRoot: root } })).toBe(2);
    expect(errs.join("\n")).toContain("用法");
  });
});

// ---------------------------------------------------------------------------
// acp
// ---------------------------------------------------------------------------

describe("BI-24.1 acp（最小握手帧，注入 IO）", () => {
  test("happy：initialize → 能力协商回应帧（protocolVersion/agentCapabilities/authMethods）", async () => {
    const outChunks: Uint8Array[] = [];
    const input = streamOf([acpFrame({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} })]);
    const { io, errs } = collect();
    expect(
      await runBi(["acp"], {
        ...io,
        deps: {
          acpInput: input,
          acpOutput: { write: (chunk) => void outChunks.push(chunk) },
        },
      }),
    ).toBe(0);
    const frames = decodeFrames(outChunks);
    expect(frames).toHaveLength(1);
    const response = frames[0]! as {
      id: number;
      result: { protocolVersion: number; agentCapabilities: object; authMethods: unknown[] };
    };
    expect(response.id).toBe(7);
    expect(response.result.protocolVersion).toBe(1);
    expect(response.result.agentCapabilities).toEqual({});
    expect(response.result.authMethods).toEqual([]);
    expect(errs.join("\n")).toContain("initialize=1");
  });

  test("边界：未知方法 → MethodNotFound(-32601) 错误帧；通知静默", async () => {
    const outChunks: Uint8Array[] = [];
    const input = streamOf([
      acpFrame({ jsonrpc: "2.0", method: "initialized" }), // 通知：不回执
      acpFrame({ jsonrpc: "2.0", id: 8, method: "session/new", params: {} }),
    ]);
    const { io } = collect();
    expect(
      await runBi(["acp"], {
        ...io,
        deps: {
          acpInput: input,
          acpOutput: { write: (chunk) => void outChunks.push(chunk) },
        },
      }),
    ).toBe(0);
    const frames = decodeFrames(outChunks);
    expect(frames).toHaveLength(1); // 通知零回执
    const response = frames[0]! as { id: number; error: { code: number; message: string } };
    expect(response.id).toBe(8);
    expect(response.error.code).toBe(-32601);
    expect(response.error.message).toContain("session/new");
  });
});

// ---------------------------------------------------------------------------
// upgrade
// ---------------------------------------------------------------------------

describe("BI-24.1 upgrade（BI-00 锚点循环门，注入替身零外呼）", () => {
  test("happy：probe 在位 + check 替身 code 0 → 透传 stdout；--no-net 透传给 check", async () => {
    const seen: Array<{ scriptPath: string; args: readonly string[] }> = [];
    const { io, outs } = collect();
    const code = await runBi(["upgrade", "--no-net"], {
      ...io,
      deps: {
        upgradeProbe: () => true,
        upgradeCheck: async (input) => {
          seen.push(input);
          return { code: 0, stdout: "check ok: 6 trees", stderr: "" };
        },
      },
    });
    expect(code).toBe(0);
    expect(outs.join("\n")).toContain("check ok: 6 trees");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.args).toEqual(["check", "--no-net"]);
    expect(seen[0]!.scriptPath).toContain("upstream_sync.py");
  });

  test("边界：锚点引擎脚本缺失 → 结构化 exit 4，check 不执行", async () => {
    let checkRan = false;
    const { io, errs } = collect();
    const code = await runBi(["upgrade"], {
      ...io,
      deps: {
        upgradeProbe: () => false,
        upgradeCheck: async () => {
          checkRan = true;
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(code).toBe(4);
    expect(checkRan).toBe(false);
    expect(errs.join("\n")).toContain("锚点引擎不在位");
  });

  test("边界：check 非零退出 → exit 1 结构化透传 stderr", async () => {
    const { io, errs, outs } = collect();
    const code = await runBi(["upgrade"], {
      ...io,
      deps: {
        upgradeProbe: () => true,
        upgradeCheck: async () => ({ code: 2, stdout: "", stderr: "upstream-moved: zcode" }),
      },
    });
    expect(code).toBe(1);
    expect(outs).toHaveLength(0);
    expect(errs.join("\n")).toContain("upstream-moved");
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

describe("BI-24.1 doctor（体检器官接线，注入检查项零外呼）", () => {
  test("happy：全绿检查项 → exit 0 结构化报告", async () => {
    const { io, outs } = collect();
    const code = await runBi(["doctor"], {
      ...io,
      deps: {
        doctorChecks: [() => ({ name: "网络可达", ok: true, detail: "注入探测" })],
      },
    });
    expect(code).toBe(0);
    expect(outs.join("\n")).toContain("1/1 通过");
    expect(outs.join("\n")).toContain("全部健康");
  });

  test("边界：存在异常发现项 → exit 1，报告携带修复建议", async () => {
    const { io, outs } = collect();
    const code = await runBi(["doctor"], {
      ...io,
      deps: {
        doctorChecks: [
          () => ({ name: "网络可达", ok: false, detail: "断网注入", fix: "检查本机网络" }),
          () => ({ name: "凭据有效期", ok: true, detail: "有效" }),
        ],
      },
    });
    expect(code).toBe(1);
    const text = outs.join("\n");
    expect(text).toContain("1/2 通过");
    expect(text).toContain("修复建议");
    expect(text).toContain("检查本机网络");
  });
});
