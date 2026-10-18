/**
 * BI-25.2 —— acp 会话桥接面验收（session/new + session/prompt + session/end）。
 *
 * 全部走 runBi 主分发 + SubcommandDeps 注入（临时会话根 / 注入 IO /
 * 脚本化模型端口），零网络、零真实模型、绝不触碰 ~/.bi：
 *   - 模型端口一律注入替身（脚本化增量流 / 门控在飞 / 装配抛错）；
 *   - 帧 IO 全注入：acpInput 用可推流 ReadableStream（分阶段推帧），
 *     acpOutput 用字节收集器，按 Content-Length 解码断言帧序列。
 * 覆盖：initialize→session/new→prompt→update 帧序列→终态；连续两 prompt
 * 同会话续聊；在飞忙错误 -32004；session/end 与 SessionNotFound -32003；
 * 端口未注入/装配抛错 -32005（不假冒）；模型流错误 -32006；v1 错误面
 * （-32601/-32700/通知静默）回归。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBi } from "../main";
import type { SubcommandDeps } from "./dispatch";
import type { ModelPort } from "../headless";
import type { AgentMessage, StreamEvent } from "../../adapters/deepseek-adapter";
import { SessionManager } from "../../session/manager";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 帧编解码与推流注入（Content-Length 头帧，字节级）
// ---------------------------------------------------------------------------

function acpFrame(body: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(body));
  const head = new TextEncoder().encode(`Content-Length: ${payload.byteLength}\r\n\r\n`);
  const frame = new Uint8Array(head.byteLength + payload.byteLength);
  frame.set(head, 0);
  frame.set(payload, head.byteLength);
  return frame;
}

/** 可分阶段推帧的注入流（session/prompt 依赖 session/new 动态返回的 sessionId）。 */
function pushStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (chunk) => {
      if (!closed) controller.enqueue(chunk);
    },
    close: () => {
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const merged = new Uint8Array(a.byteLength + b.byteLength);
  merged.set(a, 0);
  merged.set(b, a.byteLength);
  return merged;
}

/** 从收集到的字节块解码全部 JSON-RPC 帧（按 Content-Length 切，兼容多字节中文）。 */
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

/** acp 连接测试把手：注入 IO 双通道 + runBi 后台起连接，分阶段推帧。 */
function startAcp(deps: SubcommandDeps = {}): {
  push: (frame: Uint8Array) => void;
  close: () => void;
  errs: string[];
  outs: string[];
  exit: Promise<number>;
  frames: () => unknown[];
  waitFor: <T>(probe: (frames: unknown[]) => T | undefined, label: string) => Promise<T>;
} {
  const chunks: Uint8Array[] = [];
  const outs: string[] = [];
  const errs: string[] = [];
  const pipe = pushStream();
  const exit = runBi(["acp"], {
    out: (line) => outs.push(line),
    err: (line) => errs.push(line),
    deps: {
      ...deps,
      acpInput: pipe.stream,
      acpOutput: { write: (chunk) => void chunks.push(chunk) },
    },
  });
  const frames = (): unknown[] => decodeFrames(chunks);
  return {
    push: pipe.push,
    close: pipe.close,
    errs,
    outs,
    exit,
    frames,
    waitFor: async <T>(probe: (frames: unknown[]) => T | undefined, label: string): Promise<T> => {
      const deadline = Date.now() + 2000;
      for (;;) {
        const value = probe(frames());
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`等待超时: ${label}（已收 ${frames().length} 帧）`);
        await sleep(5);
      }
    },
  };
}

/** 等待指定 id 的 result 帧（返回 result 对象）。 */
async function waitForResult(acp: ReturnType<typeof startAcp>, id: number): Promise<Record<string, unknown>> {
  return acp.waitFor(
    (frames) => {
      for (const frame of frames) {
        const record = frame as { id?: unknown; result?: unknown };
        if (record.id === id && typeof record.result === "object" && record.result !== null) {
          return record.result as Record<string, unknown>;
        }
      }
      return undefined;
    },
    `result#${id}`,
  );
}

/** 等待指定 id 的 error 帧（返回错误对象）。 */
async function waitForError(
  acp: ReturnType<typeof startAcp>,
  id: number | null,
): Promise<{ code: number; message: string }> {
  return acp.waitFor(
    (frames) => {
      for (const frame of frames) {
        const record = frame as { id?: unknown; error?: { code: number; message: string } };
        if (record.id === id && typeof record.error === "object" && record.error !== null) {
          return record.error;
        }
      }
      return undefined;
    },
    `error#${String(id)}`,
  );
}

/** 等 session/new 的 result 帧并抽取动态 sessionId。 */
async function waitForSessionId(acp: ReturnType<typeof startAcp>, id: number): Promise<string> {
  const result = await waitForResult(acp, id);
  const sessionId = result["sessionId"];
  if (typeof sessionId !== "string" || sessionId === "") throw new Error("session/new 未返回 sessionId");
  return sessionId;
}

/** session/prompt 请求帧。 */
function promptFrame(id: number, sessionId: string, text: string): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, content: [{ type: "text", text }] },
  };
}

// ---------------------------------------------------------------------------
// 脚本化模型端口（零外呼替身）
// ---------------------------------------------------------------------------

interface ScriptedPort {
  port: ModelPort;
  /** 每次 stream 调用收到的对话历史（轮序）。 */
  calls: AgentMessage[][];
}

/** 固定脚本端口：每轮回放同一组事件。 */
function scriptedPort(script: readonly StreamEvent[]): ScriptedPort {
  const calls: AgentMessage[][] = [];
  return {
    calls,
    port: {
      stream(input) {
        calls.push([...input.messages]);
        return (async function* () {
          for (const event of script) yield event;
        })();
      },
    },
  };
}

/** 按轮次取脚本的端口（连续两 prompt 用）。 */
function roundScriptedPort(rounds: ReadonlyArray<readonly StreamEvent[]>): ScriptedPort {
  const calls: AgentMessage[][] = [];
  return {
    calls,
    port: {
      stream(input) {
        const round = calls.length;
        calls.push([...input.messages]);
        const script = rounds[round];
        if (script === undefined) throw new Error(`脚本缺轮次: ${round}`);
        return (async function* () {
          for (const event of script) yield event;
        })();
      },
    },
  };
}

function delta(text: string): StreamEvent {
  return { type: "content_delta", delta: text };
}

function done(stopReason: "stop" | "length"): StreamEvent {
  return { type: "done", stopReason };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("BI-25.2 acp 会话桥接（session/new + prompt，注入 IO 零外呼）", () => {
  test("全链路：initialize → session/new → prompt → update 帧序列 → 终帧 end_turn；JSONL 落 user/assistant 链", async () => {
    const root = await tmpDir("bi-acp-");
    const { port, calls } = scriptedPort([delta("你好"), delta("，世界"), done("stop")]);
    const acp = startAcp({ sessionsRoot: root, buildModelPort: () => port });

    acp.push(acpFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    acp.push(
      acpFrame({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: root, title: "桥接会话" } }),
    );
    const sessionId = await waitForSessionId(acp, 2);
    acp.push(acpFrame(promptFrame(3, sessionId, "你好")));
    const terminal = await waitForResult(acp, 3);
    acp.close();
    expect(await acp.exit).toBe(0);

    // 帧序列：init 回应 → new 回应 → 两条 agent_message_chunk 通知 → 终帧
    const frames = acp.frames();
    expect(frames).toHaveLength(5);
    expect(frames[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    expect((frames[1] as { result: { sessionId: string } }).result.sessionId).toBe(sessionId);
    const update = frames[2] as {
      method: string;
      params: { sessionId: string; update: { sessionUpdate: string; content: { type: string; text: string } } };
    };
    expect(update.method).toBe("session/update");
    expect(update.params.sessionId).toBe(sessionId);
    expect(update.params.update.sessionUpdate).toBe("agent_message_chunk");
    expect(update.params.update.content).toEqual({ type: "text", text: "你好" });
    const update2 = frames[3] as typeof update;
    expect(update2.params.update.content).toEqual({ type: "text", text: "，世界" });
    expect(frames[4]).toEqual({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } });
    expect(terminal["stopReason"]).toBe("end_turn");

    // JSONL：同一会话链 user → assistant（parentId 链式追加）
    const manager = new SessionManager({ rootDir: root });
    const entries = await manager.entries(sessionId);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.type).toBe("user");
    expect(entries[0]!.parentId).toBeNull();
    expect(entries[0]!.payload).toEqual({ text: "你好" });
    expect(entries[1]!.type).toBe("assistant");
    expect(entries[1]!.parentId).toBe(entries[0]!.id);
    expect(entries[1]!.payload).toEqual({ content: [{ type: "text", text: "你好，世界" }] });
    // session/new 的 cwd/title 落元数据
    const meta = await manager.getSessionMeta(sessionId);
    expect(meta?.title).toBe("桥接会话");
    expect(meta?.cwd).toBe(root);
    // 端口收到 1 轮、对话历史即本轮 user
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([{ role: "user", content: "你好" }]);
    // 协议 stdout 纯净：io.out 零占用；汇总走 err
    expect(acp.outs).toHaveLength(0);
    expect(acp.errs.join("\n")).toContain("sessionNew=1");
    expect(acp.errs.join("\n")).toContain("prompt=1");
  });

  test("续聊：连续两 prompt 落同一 JSONL 会话链，第二轮携带首轮历史", async () => {
    const root = await tmpDir("bi-acp-");
    const { port, calls } = roundScriptedPort([
      [delta("二"), done("stop")],
      [delta("六"), done("stop")],
    ]);
    const acp = startAcp({ sessionsRoot: root, buildModelPort: () => port });

    acp.push(acpFrame({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
    const sessionId = await waitForSessionId(acp, 1);
    acp.push(acpFrame(promptFrame(2, sessionId, "一加一等于？")));
    await waitForResult(acp, 2);
    acp.push(acpFrame(promptFrame(3, sessionId, "那再乘三？")));
    const terminal = await waitForResult(acp, 3);
    acp.close();
    expect(await acp.exit).toBe(0);

    expect(terminal).toEqual({ stopReason: "end_turn" });
    // 第二轮模型输入 = [user1, assistant1, user2]（内存历史跨 prompt 续聊）
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(3);
    expect(calls[1]![0]).toEqual({ role: "user", content: "一加一等于？" });
    expect(calls[1]![1]).toEqual({ role: "assistant", content: [{ type: "text", text: "二" }] });
    expect(calls[1]![2]).toEqual({ role: "user", content: "那再乘三？" });
    // JSONL 四条目单链：user/assistant/user/assistant
    const manager = new SessionManager({ rootDir: root });
    const entries = await manager.entries(sessionId);
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(entries[0]!.parentId).toBeNull();
    expect(entries[1]!.parentId).toBe(entries[0]!.id);
    expect(entries[2]!.parentId).toBe(entries[1]!.id);
    expect(entries[3]!.parentId).toBe(entries[2]!.id);
    expect(acp.errs.join("\n")).toContain("prompt=2");
  });

  test("忙错误：在飞 prompt 期间同会话新请求 → -32004，不串流不假冒", async () => {
    const root = await tmpDir("bi-acp-");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: ModelPort = {
      stream() {
        return (async function* () {
          await gate; // 门控：第一轮卡在飞
          yield delta("慢");
          yield done("stop");
        })();
      },
    };
    const acp = startAcp({ sessionsRoot: root, buildModelPort: () => port });

    acp.push(acpFrame({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
    const sessionId = await waitForSessionId(acp, 1);
    acp.push(acpFrame(promptFrame(2, sessionId, "第一问")));
    acp.push(acpFrame(promptFrame(3, sessionId, "第二问"))); // 第一问在飞 → 忙拒绝
    const busy = await waitForError(acp, 3);
    expect(busy.code).toBe(-32004);
    expect(busy.message).toContain("在飞");
    release();
    await waitForResult(acp, 2);
    acp.close();
    expect(await acp.exit).toBe(0);

    // 帧序：忙错误帧先于第一轮全部 update（第二问未串流任何增量）
    const frames = acp.frames();
    const busyIndex = frames.findIndex(
      (f) => (f as { id?: unknown }).id === 3 && (f as { error?: unknown }).error !== undefined,
    );
    const firstUpdateIndex = frames.findIndex(
      (f) => (f as { method?: string }).method === "session/update",
    );
    expect(busyIndex).toBeGreaterThanOrEqual(0);
    expect(firstUpdateIndex).toBeGreaterThan(busyIndex);
    // 全连接仅第一问的 1 条 update + 1 条终帧（第二问零产出）
    expect(frames.filter((f) => (f as { method?: string }).method === "session/update")).toHaveLength(1);
    // 忙请求未写任何会话条目（不假冒）
    const manager = new SessionManager({ rootDir: root });
    const entries = await manager.entries(sessionId);
    expect(entries.map((e) => e.type)).toEqual(["user", "assistant"]);
    expect(acp.errs.join("\n")).toContain("busy=1");
  });

  test("session/end：优雅收束回 { ended: true }；随后同会话 prompt → -32003", async () => {
    const root = await tmpDir("bi-acp-");
    const { port } = scriptedPort([delta("好"), done("stop")]);
    const acp = startAcp({ sessionsRoot: root, buildModelPort: () => port });

    acp.push(acpFrame({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
    const sessionId = await waitForSessionId(acp, 1);
    acp.push(acpFrame({ jsonrpc: "2.0", id: 2, method: "session/end", params: { sessionId } }));
    const ended = await waitForResult(acp, 2);
    acp.push(acpFrame(promptFrame(3, sessionId, "再聊")));
    const notFound = await waitForError(acp, 3);
    acp.close();
    expect(await acp.exit).toBe(0);

    expect(ended).toEqual({ sessionId, ended: true });
    expect(notFound.code).toBe(-32003);
    expect(notFound.message).toContain(sessionId);
    // JSONL 已落盘不删除（优雅收束 ≠ 删历史）
    const manager = new SessionManager({ rootDir: root });
    const meta = await manager.getSessionMeta(sessionId);
    expect(meta?.sessionId).toBe(sessionId);
    expect(acp.errs.join("\n")).toContain("sessionEnd=1");
  });

  test("端口未注入：session/prompt → 结构化 -32005（不假冒），会话零条目", async () => {
    const root = await tmpDir("bi-acp-");
    const emptyHome = await tmpDir("bi-acp-home-");
    // 不注入 buildModelPort：runBi 默认工厂生效，但 homeDir 注入空目录——
    // 凭据门确定性失败（零外呼），装配失败仍走结构化 -32005。
    const acp = startAcp({ sessionsRoot: root, homeDir: emptyHome });

    acp.push(acpFrame({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
    const sessionId = await waitForSessionId(acp, 1);
    acp.push(acpFrame(promptFrame(2, sessionId, "没人接")));
    const missing = await waitForError(acp, 2);
    acp.close();
    expect(await acp.exit).toBe(0);

    expect(missing.code).toBe(-32005);
    expect(missing.message).toContain("模型端口装配失败");
    expect(acp.frames().filter((f) => (f as { method?: string }).method === "session/update")).toHaveLength(0);
    // 零条目：未发生任何假冒回合
    const manager = new SessionManager({ rootDir: root });
    expect(await manager.entries(sessionId)).toHaveLength(0);
    expect(acp.errs.join("\n")).toContain("prompt=0");
  });

  test("端口装配抛错：buildModelPort 投 ModelPortConfigError → -32005 携带原因", async () => {
    const root = await tmpDir("bi-acp-");
    const acp = startAcp({
      sessionsRoot: root,
      buildModelPort: () => {
        throw new Error("环境变量 BI_TEST_KEY 未设置");
      },
    });

    acp.push(acpFrame({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
    const sessionId = await waitForSessionId(acp, 1);
    acp.push(acpFrame(promptFrame(2, sessionId, "装配炸")));
    const failure = await waitForError(acp, 2);
    acp.close();
    expect(await acp.exit).toBe(0);

    expect(failure.code).toBe(-32005);
    expect(failure.message).toContain("模型端口装配失败");
    expect(failure.message).toContain("BI_TEST_KEY");
    const manager = new SessionManager({ rootDir: root });
    expect(await manager.entries(sessionId)).toHaveLength(0);
  });

  test("模型流错误事件 → -32006 PromptFailed；用户条目已入链、助手条目不落", async () => {
    const root = await tmpDir("bi-acp-");
    const { port } = scriptedPort([
      { type: "error", error: { code: "server", message: "上游 500" } },
    ]);
    const acp = startAcp({ sessionsRoot: root, buildModelPort: () => port });

    acp.push(acpFrame({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
    const sessionId = await waitForSessionId(acp, 1);
    acp.push(acpFrame(promptFrame(2, sessionId, "会炸")));
    const failure = await waitForError(acp, 2);
    acp.close();
    expect(await acp.exit).toBe(0);

    expect(failure.code).toBe(-32006);
    expect(failure.message).toContain("上游 500");
    const manager = new SessionManager({ rootDir: root });
    const entries = await manager.entries(sessionId);
    expect(entries.map((e) => e.type)).toEqual(["user"]);
  });

  test("v1 错误面回归：未知方法 -32601 / 坏 JSON -32700 / 通知静默 / stopReason length 映射", async () => {
    const root = await tmpDir("bi-acp-");
    const { port } = scriptedPort([delta("长"), done("length")]);
    const acp = startAcp({ sessionsRoot: root, buildModelPort: () => port });

    acp.push(acpFrame({ jsonrpc: "2.0", method: "initialized" })); // 通知：静默
    acp.push(acpFrame({ jsonrpc: "2.0", id: 2, method: "session/load", params: {} }));
    // 非法 JSON 帧（body 不是 JSON → ParseError，id null）
    const raw = new TextEncoder().encode("Content-Length: 9\r\n\r\nnot-json{");
    acp.push(raw);
    const notFound = await waitForError(acp, 2);
    const parseError = await waitForError(acp, null);
    // length 停止 → max_tokens 终帧
    acp.push(acpFrame({ jsonrpc: "2.0", id: 3, method: "session/new", params: {} }));
    const sessionId = await waitForSessionId(acp, 3);
    acp.push(acpFrame(promptFrame(4, sessionId, "数到一百")));
    const terminal = await waitForResult(acp, 4);
    acp.close();
    expect(await acp.exit).toBe(0);

    expect(notFound.code).toBe(-32601);
    expect(notFound.message).toContain("session/load");
    expect(parseError.code).toBe(-32700);
    expect(terminal).toEqual({ stopReason: "max_tokens" });
    // 通知零回执：全部帧里没有 initialized 的响应
    expect(acp.frames().filter((f) => (f as { id?: unknown }).id === undefined)).toHaveLength(1); // 仅 parseError(id null)
    expect(acp.errs.join("\n")).toContain("methodNotFound=1");
    expect(acp.errs.join("\n")).toContain("parseError=1");
  });
});
