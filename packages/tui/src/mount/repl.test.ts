/**
 * BI-24.2 —— 行编辑器 REPL 验收：注入键流断言（全离线，零网络，不触 stdin/raw mode）。
 *
 * 覆盖：
 * 1. LineEditor 键位单元：可见字符/回删/光标移动/提交自清、空行与纯空白忽略、
 *    控制字符过滤、paste 摊平、Ctrl+C 非空清空/空退出、Ctrl+D 弃稿退出、
 *    Ctrl+E 外编动作、Esc 不消费；
 * 2. runRepl 多回合：提交 → 帧序列出现 [user]/[assistant] → 再提交；
 * 3. 空 Enter（含纯空白）不提交；输入流 end() → eof 收场；
 * 4. Ctrl+C 非空清空草稿（清空后可继续输入）；Ctrl+C 空 / Ctrl+D 退出返回；
 * 5. 运行态 Esc 转发 session.handleKey（hangingModel：一段=cancelled）；
 * 6. 窗口内二段 Esc：会话 exit 终态 → REPL 同步终场（session-exited）；
 * 7. awaiting-approval 态按键经 TuiApp 派发（y=放行审批回路）；
 * 8. Ctrl+E 外编桥：回填多行摊平；编辑器异常保稿；
 * 9. TuiSessionOptions.writer 透传：提示行走 session 注入渲染面（DiffRenderer 字节）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentTuiSession } from "./agent-tui";
import { KeyStream, LineEditor, runRepl } from "./repl";
import { MemoryWriter } from "../testing";
import type { ModelPort, ToolBinding } from "../../../core/src/cli/headless";
import type { StreamEvent } from "../../../core/src/adapters/deepseek-adapter";
import type { Clock } from "../../../core/src/guard/deadline";
import type { ParsedKey } from "../engine/diff-renderer";

// ---------------------------------------------------------------------------
// fixture（与 agent-tui.test.ts 同构：脚本化模型 / 可中止挂起模型 / 帧探针）
// ---------------------------------------------------------------------------

/** 脚本化模型：按回合回放事件（离线，零网络）。 */
function scriptedModel(rounds: StreamEvent[][]): ModelPort {
  let cursor = 0;
  return {
    async *stream() {
      const round = rounds[cursor];
      cursor += 1;
      if (round === undefined) throw new Error(`scripted-model: 第 ${cursor} 回合无脚本`);
      for (const event of round) yield event;
    },
  };
}

/** 可中止挂起模型：abort 后被闸门放行再吐 error 事件（Esc 取消的确定性驱动）。 */
function hangingModel(gate: { promise: Promise<void>; open: () => void }): ModelPort {
  return {
    async *stream(input) {
      const signal = input.signal;
      if (signal?.aborted === true) {
        yield { type: "error", error: { code: "network", message: "request aborted" } } as StreamEvent;
        return;
      }
      const abortWait = new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
        if (signal?.aborted === true) resolve(); // 竞态兜底：已中止的信号不再派发 abort 事件
      });
      yield { type: "content_delta", delta: "进行中…" } as StreamEvent;
      await abortWait;
      await gate.promise;
      yield { type: "error", error: { code: "network", message: "stream aborted" } } as StreamEvent;
    },
  };
}

function echoBinding(name = "echo_tool"): ToolBinding {
  return {
    definition: {
      name,
      description: "回显工具",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    readOnly: false,
    argSummary: (args) => String((args as { text?: string }).text ?? ""),
    execute: async (args) => `echo:${(args as { text?: string }).text ?? ""}`,
  };
}

/** 可控时钟（Esc 二段取消窗口驱动；接口含 now/setTimeout/clearTimeout）。 */
function fakeClock(times: number[]): Clock {
  let i = 0;
  return {
    now: () => times[i++] ?? 1_000_000,
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  };
}

/** 键流小工具：可见文本 → char 键序列。 */
function text(value: string): ParsedKey[] {
  return [...value].map((ch): ParsedKey => ({ kind: "char", char: ch }));
}
const enter: ParsedKey = { kind: "enter" };
const ctrlC: ParsedKey = { kind: "ctrl", char: "c" };
const ctrlD: ParsedKey = { kind: "ctrl", char: "d" };
const ctrlE: ParsedKey = { kind: "ctrl", char: "e" };
const esc: ParsedKey = { kind: "esc" };

/** 轮询等待（微任务/宏任务双冲刷；超时即败）。 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
  expect(cond()).toBe(true);
}

function frameSink(): {
  frames: Array<{ lines: readonly string[]; state: string; approvalVisible: boolean }>;
  approvalFrames(): Array<{ lines: readonly string[]; state: string }>;
  hooks: { onFrame: (lines: readonly string[], info: { approvalVisible: boolean; state: string }) => void };
} {
  const frames: Array<{ lines: readonly string[]; state: string; approvalVisible: boolean }> = [];
  return {
    frames,
    approvalFrames: () => frames.filter((f) => f.approvalVisible),
    hooks: {
      onFrame: (lines, info) => frames.push({ lines, approvalVisible: info.approvalVisible, state: info.state }),
    },
  };
}

async function makeRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "bi-tui-repl-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// LineEditor 键位单元
// ---------------------------------------------------------------------------

describe("BI-24.2 · LineEditor 键位单元", () => {
  test("可见字符/回删/光标移动/提交自清", () => {
    const ed = new LineEditor();
    expect(ed.feed({ kind: "left" })).toEqual({ kind: "none" }); // 空稿光标已在最左
    expect(ed.feed({ kind: "backspace" })).toEqual({ kind: "none" });
    for (const key of text("abc")) expect(ed.feed(key)).toEqual({ kind: "edit" });
    expect(ed.draft).toBe("abc");
    expect(ed.feed({ kind: "left" })).toEqual({ kind: "edit" });
    expect(ed.cursor).toBe(2);
    expect(ed.feed({ kind: "char", char: "X" })).toEqual({ kind: "edit" });
    expect(ed.draft).toBe("abXc"); // 光标处插入
    expect(ed.feed({ kind: "right" })).toEqual({ kind: "edit" });
    expect(ed.cursor).toBe(4);
    expect(ed.feed({ kind: "backspace" })).toEqual({ kind: "edit" });
    expect(ed.draft).toBe("abX");
    expect(ed.feed({ kind: "end" })).toEqual({ kind: "none" }); // 光标已在行尾
    expect(ed.feed({ kind: "home" })).toEqual({ kind: "edit" });
    expect(ed.cursor).toBe(0);
    expect(ed.feed({ kind: "end" })).toEqual({ kind: "edit" });
    expect(ed.cursor).toBe(3);
    expect(ed.feed({ kind: "enter" })).toEqual({ kind: "submit", line: "abX" });
    expect(ed.draft).toBe(""); // 提交自清
  });

  test("空行忽略/纯空白忽略/控制字符过滤/paste 摊平/esc 与翻页键不消费", () => {
    const ed = new LineEditor();
    expect(ed.feed(enter)).toEqual({ kind: "none" }); // 空行忽略
    ed.insert("   ");
    expect(ed.feed(enter)).toEqual({ kind: "none" }); // 纯空白视同空行
    ed.clear();
    expect(ed.feed({ kind: "char", char: "\t" })).toEqual({ kind: "none" }); // 控制字符不入稿
    expect(ed.feed({ kind: "paste", text: "" })).toEqual({ kind: "none" });
    expect(ed.feed({ kind: "paste", text: "一\n二\r\n三" })).toEqual({ kind: "edit" });
    expect(ed.draft).toBe("一 二 三"); // 换行摊平为空格
    expect(ed.feed(esc)).toEqual({ kind: "none" }); // 取消语义归主回路路由
    expect(ed.feed({ kind: "up" })).toEqual({ kind: "none" });
    expect(ed.feed({ kind: "tab" })).toEqual({ kind: "none" });
  });

  test("Ctrl+C 非空清空/空退出；Ctrl+D 弃稿退出；Ctrl+E 外编动作保稿", () => {
    const ed = new LineEditor();
    ed.insert("草稿");
    expect(ed.feed(ctrlC)).toEqual({ kind: "edit" }); // 非空=清空
    expect(ed.draft).toBe("");
    expect(ed.feed(ctrlC)).toEqual({ kind: "exit", key: "ctrl-c" }); // 空=退出
    ed.insert("x");
    expect(ed.feed(ctrlD)).toEqual({ kind: "exit", key: "ctrl-d" });
    expect(ed.draft).toBe(""); // 弃稿
    ed.insert("y");
    expect(ed.feed(ctrlE)).toEqual({ kind: "external-edit" });
    expect(ed.draft).toBe("y"); // 草稿保留，由主回路执行外编桥回填
  });
});

// ---------------------------------------------------------------------------
// runRepl 交互主回路（注入键流）
// ---------------------------------------------------------------------------

describe("BI-24.2 · runRepl 主回路（注入键流）", () => {
  test("多回合：提交 → 帧序列 [user]/[assistant] → 再提交", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const sink = frameSink();
      const prompts: string[] = [];
      const session = new AgentTuiSession({
        model: scriptedModel([
          [{ type: "content_delta", delta: "回答一。" }, { type: "done", stopReason: "stop" }],
          [{ type: "content_delta", delta: "回答二。" }, { type: "done", stopReason: "stop" }],
        ]),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: sink.hooks,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream, title: "多回合", onPrompt: (d) => prompts.push(d) });

      for (const key of [...text("你好"), enter]) stream.push(key);
      await until(
        () => session.state === "idle" && sink.frames.some((f) => f.lines.some((l) => l.includes("[assistant] 回答一。"))),
      );
      for (const key of [...text("再问"), enter]) stream.push(key);
      await until(
        () => session.state === "idle" && sink.frames.some((f) => f.lines.some((l) => l.includes("[assistant] 回答二。"))),
      );
      stream.push(ctrlD);
      const result = await done;

      expect(result.endedAs).toBe("exit-key");
      expect(result.exitKey).toBe("ctrl-d");
      expect(result.submittedLines).toBe(2);
      expect(result.lastResult?.endedAs).toBe("finish");
      expect(result.sessionId).toBe(session.sessionId);
      const lineText = sink.frames.map((f) => f.lines.join("\n")).join("\n");
      expect(lineText).toContain("[user] 你好");
      expect(lineText).toContain("[user] 再问");
      expect(session.state).toBe("idle");
      expect(prompts[0]).toBe(""); // 初始提示行
    } finally {
      await cleanup();
    }
  });

  test("空 Enter（含纯空白）不提交；流 end() → eof 收场", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const sink = frameSink();
      const session = new AgentTuiSession({
        model: scriptedModel([]),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: sink.hooks,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream });
      stream.push(enter);
      for (const key of text("  ")) stream.push(key);
      stream.push(enter);
      stream.end(); // 输入流耗尽 → eof
      const result = await done;

      expect(result.endedAs).toBe("eof");
      expect(result.submittedLines).toBe(0);
      expect(result.lastResult).toBeUndefined();
      expect(sink.frames.some((f) => f.lines.some((l) => l.includes("[user]")))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("Ctrl+C 非空清空草稿，清空后可继续输入提交", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const sink = frameSink();
      const prompts: string[] = [];
      const session = new AgentTuiSession({
        model: scriptedModel([[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }]]),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: sink.hooks,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream, onPrompt: (d) => prompts.push(d) });

      for (const key of text("草稿")) stream.push(key);
      await until(() => prompts.at(-1) === "草稿");
      stream.push(ctrlC); // 非空 → 清空草稿，REPL 继续
      await until(() => prompts.at(-1) === "");
      for (const key of [...text("新"), enter]) stream.push(key);
      await until(
        () => session.state === "idle" && sink.frames.some((f) => f.lines.some((l) => l.includes("[user] 新"))),
      );
      stream.push(ctrlD);
      const result = await done;

      expect(result.submittedLines).toBe(1);
      expect(result.endedAs).toBe("exit-key");
      const cleared = prompts.indexOf("草稿");
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(prompts.slice(cleared + 1)).toContain(""); // 清空落到了提示行探针
      expect(sink.frames.some((f) => f.lines.some((l) => l.includes("[user] 草稿")))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test.each([
    { label: "Ctrl+C 空", key: ctrlC, exitKey: "ctrl-c" },
    { label: "Ctrl+D", key: ctrlD, exitKey: "ctrl-d" },
  ])("退出键返回：$label", async ({ key, exitKey }) => {
    const { root, cleanup } = await makeRoot();
    try {
      const sink = frameSink();
      const session = new AgentTuiSession({
        model: scriptedModel([]),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: sink.hooks,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream });
      stream.push(key);
      const result = await done;

      expect(result.endedAs).toBe("exit-key");
      expect(result.exitKey).toBe(exitKey);
      expect(result.submittedLines).toBe(0);
      expect(session.state).toBe("idle");
    } finally {
      await cleanup();
    }
  });
});

describe("BI-24.2 · runRepl 运行态键路由", () => {
  test("一段 Esc 转发取消：回合收束 endedAs=cancelled，REPL 可继续退出", async () => {
    const { root, cleanup } = await makeRoot();
    let release: () => void;
    const gate = { promise: new Promise<void>((r) => (release = r)), open: () => release() };
    try {
      const session = new AgentTuiSession({
        model: hangingModel(gate),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        cancelWindowMs: 800,
        clock: fakeClock([0]),
        rows: 6,
        cols: 40,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream });

      for (const key of [...text("长任务"), enter]) stream.push(key);
      await until(() => session.agentState === "thinking");
      stream.push(esc); // 运行态：转发 session.handleKey（二段取消第一段）
      gate.open(); // 放行挂起流的 abort 收束
      await until(() => session.state === "idle"); // 取消收束（paused→idle）
      stream.push(ctrlD);
      const result = await done;

      expect(result.submittedLines).toBe(1);
      expect(result.endedAs).toBe("exit-key");
      expect(result.lastResult?.endedAs).toBe("cancelled");
      expect(session.state).toBe("idle"); // 会话仍可用（REPL 未因取消终场）
    } finally {
      gate.open();
      await cleanup();
    }
  });

  test("窗口内二段 Esc：会话 exit 终态 → REPL 同步终场（session-exited）", async () => {
    const { root, cleanup } = await makeRoot();
    let release!: () => void;
    const gate = { promise: new Promise<void>((r) => (release = r)), open: () => release() };
    try {
      const session = new AgentTuiSession({
        model: hangingModel(gate),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        cancelWindowMs: 800,
        clock: fakeClock([0, 50]),
        rows: 6,
        cols: 40,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream });

      for (const key of [...text("长任务"), enter]) stream.push(key);
      await until(() => session.agentState === "thinking");
      stream.push(esc); // 一段 t=0：paused
      stream.push(esc); // 二段 t=50（窗口内）：exit
      gate.open(); // 放行流的 abort 收束
      const result = await done;

      expect(result.endedAs).toBe("session-exited"); // REPL 随会话终场
      expect(result.lastResult?.endedAs).toBe("exit");
      expect(session.state).toBe("exited");
      expect(result.submittedLines).toBe(1);
    } finally {
      gate.open();
      await cleanup();
    }
  });

  test("awaiting-approval 态按键经 TuiApp 派发：y=放行审批回路", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const sink = frameSink();
      const session = new AgentTuiSession({
        model: scriptedModel([
          [
            { type: "tool_call_delta", index: 0, id: "call_1", name: "echo_tool", argumentsDelta: '{"text":"机密"}' },
            { type: "done", stopReason: "tool_use" },
          ],
          [{ type: "content_delta", delta: "已放行。" }, { type: "done", stopReason: "stop" }],
        ]),
        tools: [echoBinding()],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "manual",
        rows: 8,
        cols: 60,
        hooks: sink.hooks,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream });

      for (const key of [...text("执行工具"), enter]) stream.push(key);
      await until(() => sink.approvalFrames().length > 0); // 审批浮层可见
      stream.push({ kind: "char", char: "y" }); // 经 dispatchKey 由浮层消费
      await until(() => session.state === "idle");
      stream.push(ctrlD);
      const result = await done;

      expect(result.submittedLines).toBe(1);
      expect(result.lastResult?.endedAs).toBe("finish");
      expect(result.lastResult?.toolResults[0]).toMatchObject({ ok: true, value: "echo:机密" });
      expect(result.lastResult?.permissionDecisions).toContainEqual({ tool: "echo_tool", decision: "ask" });
      expect(result.lastResult?.permissionDecisions).toContainEqual({ tool: "echo_tool", decision: "allow(approved)" });
    } finally {
      await cleanup();
    }
  });
});

describe("BI-24.2 · runRepl 外编桥与渲染面", () => {
  test("Ctrl+E 外编桥：回填多行摊平提交；编辑器异常保稿", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      // 场景一：外编回填多行文本（\n 摊平为空格）→ Enter 提交
      const sink1 = frameSink();
      const session1 = new AgentTuiSession({
        model: scriptedModel([[{ type: "content_delta", delta: "收到。" }, { type: "done", stopReason: "stop" }]]),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: sink1.hooks,
      });
      const stream1 = new KeyStream();
      const done1 = runRepl({
        session: session1,
        keys: stream1,
        editExternally: async () => ({ text: "第一行\n第二行", modified: true }),
      });
      stream1.push(ctrlE);
      stream1.push(enter);
      await until(
        () => session1.state === "idle" && sink1.frames.some((f) => f.lines.some((l) => l.includes("[user] 第一行 第二行"))),
      );
      stream1.push(ctrlD);
      const result1 = await done1;
      expect(result1.submittedLines).toBe(1);

      // 场景二：外编异常 → 取消保稿 → 原稿照常提交
      const sink2 = frameSink();
      const session2 = new AgentTuiSession({
        model: scriptedModel([[{ type: "content_delta", delta: "明白。" }, { type: "done", stopReason: "stop" }]]),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        hooks: sink2.hooks,
      });
      const stream2 = new KeyStream();
      const done2 = runRepl({
        session: session2,
        keys: stream2,
        editExternally: async () => {
          throw new Error("editor-boom");
        },
      });
      for (const key of text("原稿")) stream2.push(key);
      stream2.push(ctrlE); // 异常=取消，草稿保留
      stream2.push(enter);
      await until(
        () => session2.state === "idle" && sink2.frames.some((f) => f.lines.some((l) => l.includes("[user] 原稿"))),
      );
      stream2.push(ctrlD);
      const result2 = await done2;
      expect(result2.submittedLines).toBe(1);
      expect(sink2.frames.some((f) => f.lines.some((l) => l.includes("[user] 第一行")))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("TuiSessionOptions.writer 透传：提示行走 session 注入渲染面", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const writer = new MemoryWriter();
      const session = new AgentTuiSession({
        model: scriptedModel([]),
        tools: [],
        cwd: root,
        sessionsRoot: join(root, "sessions"),
        permissionMode: "auto",
        rows: 6,
        cols: 60,
        writer,
      });
      const stream = new KeyStream();
      const done = runRepl({ session, keys: stream });
      for (const key of text("hi")) stream.push(key);
      stream.push(ctrlD);
      await done;

      expect(writer.output).toContain("❯ hi"); // 提示行经 DiffRenderer 差分落到注入 writer
      expect(writer.output).toContain("\x1b["); // CUP/EL 最小 ANSI 输出
    } finally {
      await cleanup();
    }
  });
});
