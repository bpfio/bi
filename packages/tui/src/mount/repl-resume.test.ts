/**
 * FIX-A F4 · REPL 续会话验收（--resume → 复用既有会话）。
 *
 * 关注面：
 * 1. 给了 initialSession：REPL 复用既有会话——会话 id 连续（result.sessionId
 *    === 既有 id）、JSONL 续写同一份会话文件（不新建会话文件、不覆盖既有历史）。
 * 2. 未给 initialSession：新建会话（缺省路径逐字节等价）。
 * 3. 续会话首条新条目挂到既有末条目（追加链连续，不开第二个根）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTuiSession } from "./agent-tui";
import { KeyStream, runRepl } from "./repl";
import { SessionManager } from "../../../core/src/session/manager";
import type { ModelPort } from "../../../core/src/cli/headless";
import type { StreamEvent } from "../../../core/src/adapters/deepseek-adapter";
import type { ParsedKey } from "../engine/diff-renderer";

/** 脚本化模型：每回合吐一段文本（离线，零网络）。 */
function scriptedModel(): ModelPort {
  return {
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "content_delta", delta: "回答。" };
      yield { type: "done", stopReason: "stop" };
    },
  };
}

/** 键流小工具：可见文本 → char 键序列。 */
function text(value: string): ParsedKey[] {
  return [...value].map((ch): ParsedKey => ({ kind: "char", char: ch }));
}
const enter: ParsedKey = { kind: "enter" };
const ctrlD: ParsedKey = { kind: "ctrl", char: "d" };

/** 轮询等待（超时即败）。 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

/** 帧探针：等回合真正收束（assistant 行上屏）再退出。 */
function frameSink(): {
  frames: Array<{ lines: readonly string[] }>;
  hooks: { onFrame: (lines: readonly string[]) => void };
} {
  const frames: Array<{ lines: readonly string[] }> = [];
  return { frames, hooks: { onFrame: (lines) => frames.push({ lines }) } };
}

async function makeRoot(): Promise<{ root: string; sessionsRoot: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "bi-tui-resume-"));
  return { root, sessionsRoot: join(root, "sessions"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("FIX-A F4 · REPL 续会话（initialSession）", () => {
  test("给了 initialSession：会话 id 连续 + JSONL 续写既有会话文件", async () => {
    const { root, sessionsRoot, cleanup } = await makeRoot();
    try {
      // 既有会话：一条 user + 一条 assistant。
      const manager = new SessionManager({ rootDir: sessionsRoot });
      const meta = await manager.createSession({ title: "旧会话" });
      const e1 = await manager.append(meta.sessionId, null, { type: "user", payload: { text: "旧问" } });
      await manager.append(meta.sessionId, e1.id, { type: "assistant", payload: { text: "旧答" } });

      const sink = frameSink();
      const session = new AgentTuiSession({
        model: scriptedModel(),
        tools: [],
        cwd: root,
        sessionsRoot,
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: { onFrame: (lines) => sink.hooks.onFrame(lines) },
      });
      const stream = new KeyStream();
      const done = runRepl({
        session,
        keys: stream,
        title: "bi repl",
        initialSession: { sessionId: meta.sessionId, title: meta.title },
      });

      for (const key of [...text("续问"), enter]) stream.push(key);
      await until(() => sink.frames.some((f) => f.lines.some((l) => l.includes("[assistant] 回答。"))));
      stream.push(ctrlD);
      const result = await done;

      // 会话 id 连续：REPL 用的就是既有会话。
      expect(result.sessionId).toBe(meta.sessionId);
      expect(session.sessionId).toBe(meta.sessionId);
      // 未新建第二个会话文件。
      const files = await readdir(sessionsRoot);
      expect(files.filter((f) => f.endsWith(".jsonl"))).toEqual([`${meta.sessionId}.jsonl`]);
      // 续写：既有两条 + 本回合两条（user/assistant）；首条新条目挂到既有末条目。
      const entries = await manager.entries(meta.sessionId);
      expect(entries).toHaveLength(4);
      expect(entries[2]!.parentId).toBe(entries[1]!.id);
      expect(entries[2]!.payload).toEqual({ text: "续问" });
      expect(entries[3]!.parentId).toBe(entries[2]!.id);
    } finally {
      await cleanup();
    }
  });

  test("未给 initialSession：新建会话（缺省路径零行为差）", async () => {
    const { root, sessionsRoot, cleanup } = await makeRoot();
    try {
      const sink = frameSink();
      const session = new AgentTuiSession({
        model: scriptedModel(),
        tools: [],
        cwd: root,
        sessionsRoot,
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: { onFrame: (lines) => sink.hooks.onFrame(lines) },
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream, title: "bi repl" });
      for (const key of [...text("你好"), enter]) stream.push(key);
      await until(() => sink.frames.some((f) => f.lines.some((l) => l.includes("[assistant] 回答。"))));
      stream.push(ctrlD);
      const result = await done;

      expect(result.sessionId).toBeDefined();
      expect(result.sessionId).not.toBe("");
      const files = await readdir(sessionsRoot);
      expect(files.filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
