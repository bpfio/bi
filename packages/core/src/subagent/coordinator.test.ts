/**
 * BI-07.4 · 双向信令协调器与镜像观测总线测试。
 *
 * 覆盖：
 * - RespondToCoordinator：子→父阶段汇报进父 outbox steer 通道、不打断子任务、
 *   零落库、零退出、结构化拒绝（unknown/unroutable/invalid-input）、FIFO；
 * - SendMessage：父→子 steer 进子 Inbox、step boundary 消费、发送零落库、
 *   零退出、FIFO；
 * - MirrorSink：订阅者收全工具事件（source:"subagent"）、只镜工具事件、
 *   持久化流零镜像污染、退订、坏监听器隔离、多子隔离、seq/时钟、环形缓冲。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../session/inbox";
import { SessionManager } from "../session/manager";
import type { Clock } from "../guard/deadline";
import { RespondToCoordinatorTool, SendMessageTool } from "./coordinator";
import { MirrorSink, type MirrorEvent } from "./mirror-sink";
import {
  SubagentRunner,
  type LoopFactory,
  type SubLoopSessionCtx,
  type SubagentOutboxMessage,
  type SubagentResultMessage,
  type SubagentRunnerDeps,
  type SubagentSessionWriter,
  type SubagentSteerMessage,
} from "./runner";

const isReport = (m: SubagentOutboxMessage): m is SubagentSteerMessage =>
  m.kind === "child-report";
const isResult = (m: SubagentOutboxMessage): m is SubagentResultMessage =>
  m.kind === "subagent-result";

/* ------------------------------------------------------------------ */
/* 测试基座                                                             */
/* ------------------------------------------------------------------ */

let root = "";
let fixtureSeq = 0;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bi-coord-")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeWriter(mgr: SessionManager): SubagentSessionWriter {
  const tips = new Map<string, string | null>();
  return {
    async append(sessionId, draft) {
      if (!tips.has(sessionId)) {
        const meta = await mgr.getSessionMeta(sessionId);
        if (meta === undefined) {
          await mgr.createSession({ sessionId, title: `auto:${sessionId}` });
          tips.set(sessionId, null);
        } else {
          const entries = await mgr.entries(sessionId);
          tips.set(sessionId, entries.at(-1)?.id ?? null);
        }
      }
      const entry = await mgr.append(sessionId, tips.get(sessionId) ?? null, draft);
      tips.set(sessionId, entry.id);
      return entry;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeClock(start = 1000): Clock & { advance: (ms: number) => void; nowValue: () => number } {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setTimeout: (h, ms) => setTimeout(h, ms),
    nowValue: () => now,
  };
}

interface Harness {
  mgr: SessionManager;
  outbox: Inbox<SubagentOutboxMessage>;
  runner: SubagentRunner;
  ctxs: Map<string, SubLoopSessionCtx>;
}

/** 默认回显循环：user + tool_call + tool_result。 */
const echoLoop: LoopFactory = (_profile, ctx) => ({
  async run() {
    await ctx.emit({ type: "user", payload: { text: ctx.prompt } });
    await ctx.emit({
      type: "tool_call",
      payload: { name: "Read", args: {} },
      toolCallId: `${ctx.childSessionId}-t1`,
      toolName: "Read",
    });
    await ctx.emit({
      type: "tool_result",
      payload: { ok: true },
      toolCallId: `${ctx.childSessionId}-t1`,
      toolName: "Read",
    });
    return { ok: true, summary: `done:${ctx.prompt}` };
  },
});

function makeHarness(opts?: {
  loop?: LoopFactory;
  deps?: Partial<SubagentRunnerDeps>;
}): Harness {
  fixtureSeq += 1;
  const mgr = new SessionManager({ rootDir: join(root, `f${fixtureSeq}`) });
  const writer = makeWriter(mgr);
  const outbox = new Inbox<SubagentOutboxMessage>();
  const ctxs = new Map<string, SubLoopSessionCtx>();
  let seq = 0;
  const inner = opts?.loop ?? echoLoop;
  const loopFactory: LoopFactory = (profile, ctx) => {
    ctxs.set(ctx.childSessionId, ctx);
    return inner(profile, ctx);
  };
  const runner = new SubagentRunner({
    loopFactory,
    sessionWriter: writer,
    outbox,
    generateSessionId: () => `child-${fixtureSeq}-${++seq}`,
    ...opts?.deps,
  });
  return { mgr, outbox, runner, ctxs };
}

async function seedMain(h: Harness, sessionId = "main"): Promise<void> {
  await h.mgr.createSession({ sessionId, title: "主会话" });
  await h.mgr.append(sessionId, null, { type: "user", payload: { text: "开始主任务" } });
}

const types = async (mgr: SessionManager, id: string): Promise<string[]> =>
  (await mgr.entries(id)).map((e) => e.type);

/* ------------------------------------------------------------------ */
/* RespondToCoordinator：子→父阶段汇报                                   */
/* ------------------------------------------------------------------ */

describe("RespondToCoordinator 子→父阶段汇报", () => {
  test("阶段汇报 append 到父 outbox steer 通道（kind/from/to/text）", async () => {
    const h = makeHarness();
    await seedMain(h);
    const respond = new RespondToCoordinatorTool({ runner: h.runner });
    await h.runner.spawn("explore", "探查", { parentSessionId: "main" });
    const child = h.runner.runInfos()[0]!;

    const r = await respond.run(
      { message: "完成扫盘" },
      { childSessionId: child.childSessionId },
    );
    expect(r.ok).toBe(true);
    const all = h.outbox.takeSteers();
    expect(all.some(isResult)).toBe(true); // spawn 完成通知在前
    const [msg] = all.filter(isReport);
    expect(msg!.kind).toBe("child-report");
    expect(msg!.fromSessionId).toBe(child.childSessionId);
    expect(msg!.toSessionId).toBe("main");
    expect(msg!.text).toBe("完成扫盘");
    expect(msg!.phase).toBeUndefined();
  });

  test("phase 字段透传到汇报载荷", async () => {
    const h = makeHarness();
    await seedMain(h);
    const respond = new RespondToCoordinatorTool({ runner: h.runner, clock: fakeClock() });
    await h.runner.spawn("explore", "p", { parentSessionId: "main" });
    const child = h.runner.runInfos()[0]!;
    const r = await respond.run(
      { message: "扫描完毕", phase: "scanning" },
      { childSessionId: child.childSessionId },
    );
    expect(r.ok).toBe(true);
    const [msg] = h.outbox.takeSteers().filter(isReport);
    expect(msg!.kind).toBe("child-report");
    expect(msg!.fromSessionId).toBe(child.childSessionId);
    expect(msg!.toSessionId).toBe("main");
    expect(msg!.text).toBe("扫描完毕");
    expect(msg!.phase).toBe("scanning");
  });

  test("运行中汇报不打断子任务（零退出）：汇报后循环跑完 ok:true", async () => {
    let respond: RespondToCoordinatorTool | undefined;
    const loop: LoopFactory = (_p, ctx) => ({
      async run() {
        await ctx.emit({ type: "user", payload: { text: ctx.prompt } });
        const r = await respond!.run(
          { message: "阶段1完成", phase: "scanning" },
          { childSessionId: ctx.childSessionId },
        );
        if (!r.ok) throw new Error(`汇报失败: ${r.message}`);
        await ctx.emit({ type: "tool_call", payload: {}, toolCallId: "t", toolName: "Read" });
        return { ok: true, summary: "done:汇报后继续" };
      },
    });
    const h = makeHarness({ loop });
    await seedMain(h);
    respond = new RespondToCoordinatorTool({ runner: h.runner });

    const result = await h.runner.spawn("explore", "长任务", { parentSessionId: "main" });
    expect(result.ok).toBe(true); // 汇报未打断，任务照常收束
    expect(result.summary).toBe("done:汇报后继续");
    expect(await types(h.mgr, result.childSessionId)).toEqual(["user", "tool_call"]);

    const all = h.outbox.takeSteers();
    const report = all.find(isReport)!;
    const done = all.find(isResult)!;
    expect(report.kind).toBe("child-report");
    expect(report.text).toBe("阶段1完成");
    expect(done.ok).toBe(true); // 完成通知照常投递
  });

  test("汇报零落库：子会话 JSONL 不含汇报痕迹", async () => {
    let respond: RespondToCoordinatorTool | undefined;
    const loop: LoopFactory = (_p, ctx) => ({
      async run() {
        await ctx.emit({ type: "user", payload: { text: ctx.prompt } });
        await respond!.run({ message: "只走信令" }, { childSessionId: ctx.childSessionId });
        await ctx.emit({ type: "tool_result", payload: {}, toolCallId: "t", toolName: "Read" });
        return { ok: true, summary: "s" };
      },
    });
    const h = makeHarness({ loop });
    await seedMain(h);
    respond = new RespondToCoordinatorTool({ runner: h.runner });
    const result = await h.runner.spawn("explore", "零落库", { parentSessionId: "main" });

    const entries = await h.mgr.entries(result.childSessionId);
    expect(entries.map((e) => e.type)).toEqual(["user", "tool_result"]);
    expect(entries.every((e) => (e.payload as { text?: string }).text !== "只走信令")).toBe(true);
  });

  test("未知子会话 → unknown-subagent 结构化拒绝", async () => {
    const h = makeHarness();
    const respond = new RespondToCoordinatorTool({ runner: h.runner });
    const r = await respond.run({ message: "hi" }, { childSessionId: "ghost" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown-subagent");
  });

  test("无父归属（spawn 未带 parentSessionId）→ unroutable", async () => {
    const h = makeHarness();
    await h.runner.spawn("explore", "孤儿");
    const child = h.runner.runInfos()[0]!;
    const respond = new RespondToCoordinatorTool({ runner: h.runner });
    const r = await respond.run({ message: "hi" }, { childSessionId: child.childSessionId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unroutable");
  });

  test("缺/空 message → invalid-input", async () => {
    const h = makeHarness();
    const respond = new RespondToCoordinatorTool({ runner: h.runner });
    for (const bad of [undefined, { message: "" }, { message: 42 }]) {
      const r = await respond.run(bad, { childSessionId: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("invalid-input");
    }
  });

  test("多条汇报 FIFO 保序", async () => {
    const h = makeHarness();
    await seedMain(h);
    const respond = new RespondToCoordinatorTool({ runner: h.runner });
    await h.runner.spawn("explore", "f", { parentSessionId: "main" });
    const child = h.runner.runInfos()[0]!;
    h.outbox.takeSteers(); // 排干 spawn 完成通知
    await respond.run({ message: "一" }, { childSessionId: child.childSessionId });
    await respond.run({ message: "二" }, { childSessionId: child.childSessionId });
    await respond.run({ message: "三" }, { childSessionId: child.childSessionId });
    const texts = h.outbox.takeSteers().filter(isReport).map((m) => m.text);
    expect(texts).toEqual(["一", "二", "三"]);
  });

  test("汇报只走 steer 箱，不碰 input 箱", async () => {
    const h = makeHarness();
    await seedMain(h);
    const respond = new RespondToCoordinatorTool({ runner: h.runner });
    await h.runner.spawn("explore", "ch", { parentSessionId: "main" });
    const child = h.runner.runInfos()[0]!;
    await respond.run({ message: "m" }, { childSessionId: child.childSessionId });
    expect(h.outbox.hasSteers()).toBe(true);
    expect(h.outbox.hasInputs()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* SendMessage：父→子 steer                                             */
/* ------------------------------------------------------------------ */

describe("SendMessage 父→子 steer", () => {
  /** 挂起等 gate，再步界收割 steer 的感知循环。 */
  function steerAwareLoop(gate: { promise: Promise<void> }): LoopFactory {
    return (_p, ctx) => ({
      async run() {
        await ctx.emit({ type: "user", payload: { text: ctx.prompt } });
        await gate.promise;
        const steers = ctx.takeSteers(); // step boundary 消费（BI-03.5 语义）
        if (steers.length > 0) {
          await ctx.emit({
            type: "system",
            payload: { kind: "steers-applied", texts: steers.map((s) => s.text) },
          });
        }
        await ctx.emit({ type: "tool_call", payload: {}, toolCallId: "t", toolName: "Read" });
        return { ok: true, summary: "done:steer-aware" };
      },
    });
  }

  test("steer 到达子收件箱并在子步界被消费", async () => {
    const gate = deferred();
    let readyCtx!: (ctx: SubLoopSessionCtx) => void;
    const readyP = new Promise<SubLoopSessionCtx>((r) => {
      readyCtx = r;
    });
    const base = steerAwareLoop(gate);
    const loop: LoopFactory = (p, ctx) => {
      readyCtx(ctx);
      return base(p, ctx);
    };
    const h = makeHarness({ loop });
    await seedMain(h);
    const send = new SendMessageTool({ runner: h.runner });

    const spawnP = h.runner.spawn("explore", "长任务", { parentSessionId: "main" });
    const ctx = await readyP;

    const r = await send.run(
      { childSessionId: ctx.childSessionId, message: "改方向" },
      { parentSessionId: "main" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.from).toBe("main");
      expect(r.to).toBe(ctx.childSessionId);
    }

    gate.resolve();
    const result = await spawnP;
    expect(result.ok).toBe(true);

    const entries = await h.mgr.entries(ctx.childSessionId);
    const applied = entries.find((e) => e.type === "system");
    expect(applied).toBeDefined();
    expect((applied!.payload as { kind?: string; texts?: string[] }).kind).toBe("steers-applied");
    expect((applied!.payload as { texts?: string[] }).texts).toEqual(["改方向"]);
  });

  test("发送本身零落库：挂起期间子 JSONL 行数不变", async () => {
    const gate = deferred();
    let readyCtx!: (ctx: SubLoopSessionCtx) => void;
    const readyP = new Promise<SubLoopSessionCtx>((r) => {
      readyCtx = r;
    });
    const base = steerAwareLoop(gate);
    const loop: LoopFactory = (p, ctx) => {
      readyCtx(ctx);
      return base(p, ctx);
    };
    const h = makeHarness({ loop });
    await seedMain(h);
    const send = new SendMessageTool({ runner: h.runner });

    const spawnP = h.runner.spawn("explore", "零落库", { parentSessionId: "main" });
    const ctx = await readyP;
    // 等首条 user 落盘（emit 走微任务+真实 fs IO），再发信令校验零落库
    for (;;) {
      try {
        if ((await h.mgr.entries(ctx.childSessionId)).length >= 1) break;
      } catch {
        // 子会话文件尚未创建
      }
      await Bun.sleep(1);
    }
    await send.run({ childSessionId: ctx.childSessionId, message: "m" }, { parentSessionId: "main" });

    const entries = await h.mgr.entries(ctx.childSessionId);
    expect(entries).toHaveLength(1); // 只有首条 user，信令不入史
    gate.resolve();
    await spawnP;
  });

  test("多条 steer FIFO 消费", async () => {
    const gate = deferred();
    let readyCtx!: (ctx: SubLoopSessionCtx) => void;
    const readyP = new Promise<SubLoopSessionCtx>((r) => {
      readyCtx = r;
    });
    const base = steerAwareLoop(gate);
    const loop: LoopFactory = (p, ctx) => {
      readyCtx(ctx);
      return base(p, ctx);
    };
    const h = makeHarness({ loop });
    await seedMain(h);
    const send = new SendMessageTool({ runner: h.runner });

    const spawnP = h.runner.spawn("explore", "多steer", { parentSessionId: "main" });
    const ctx = await readyP;
    await send.run({ childSessionId: ctx.childSessionId, message: "一" }, { parentSessionId: "main" });
    await send.run({ childSessionId: ctx.childSessionId, message: "二" }, { parentSessionId: "main" });
    gate.resolve();
    await spawnP;

    const entries = await h.mgr.entries(ctx.childSessionId);
    const applied = entries.find((e) => e.type === "system");
    expect((applied!.payload as { texts?: string[] }).texts).toEqual(["一", "二"]);
  });

  test("零退出：steer 后子任务照常完成", async () => {
    const gate = deferred();
    let readyCtx!: (ctx: SubLoopSessionCtx) => void;
    const readyP = new Promise<SubLoopSessionCtx>((r) => {
      readyCtx = r;
    });
    const base = steerAwareLoop(gate);
    const loop: LoopFactory = (p, ctx) => {
      readyCtx(ctx);
      return base(p, ctx);
    };
    const h = makeHarness({ loop });
    await seedMain(h);
    const send = new SendMessageTool({ runner: h.runner });

    const spawnP = h.runner.spawn("explore", "不退出", { parentSessionId: "main" });
    const ctx = await readyP;
    await send.run({ childSessionId: ctx.childSessionId, message: "纠偏" }, { parentSessionId: "main" });
    gate.resolve();
    const result = await spawnP;
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("done:steer-aware");
  });

  test("未知子会话 → unknown-subagent；缺参 → invalid-input", async () => {
    const h = makeHarness();
    const send = new SendMessageTool({ runner: h.runner });
    const r1 = await send.run({ childSessionId: "ghost", message: "m" }, { parentSessionId: "main" });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("unknown-subagent");
    const r2 = await send.run({ childSessionId: "x" }, { parentSessionId: "main" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("invalid-input");
  });

  test("寻址面：runInfo 未知为 undefined；runner.outbox 暴露", () => {
    const h = makeHarness();
    expect(h.runner.runInfo("ghost")).toBeUndefined();
    expect(h.runner.outbox).toBe(h.outbox);
  });
});

/* ------------------------------------------------------------------ */
/* MirrorSink：实时镜像观测总线                                          */
/* ------------------------------------------------------------------ */

describe("MirrorSink 实时镜像总线", () => {
  test("订阅者收到全部子工具事件（source/childSessionId/type 正确）", async () => {
    const sink = new MirrorSink();
    const received: MirrorEvent[] = [];
    sink.subscribe((e) => received.push(e));
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    const result = await h.runner.spawn("explore", "镜像", { parentSessionId: "main" });

    expect(received).toHaveLength(2);
    expect(received.every((e) => e.source === "subagent")).toBe(true);
    expect(received.every((e) => e.childSessionId === result.childSessionId)).toBe(true);
    expect(received.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    expect(received.every((e) => e.toolName === "Read")).toBe(true);
  });

  test("只镜工具事件：user/assistant/system 不镜像", async () => {
    const sink = new MirrorSink();
    const received: MirrorEvent[] = [];
    sink.subscribe((e) => received.push(e));
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    await h.runner.spawn("explore", "非工具", { parentSessionId: "main" });
    // 默认 stub 只 emit user+tool_call+tool_result；user 不镜像
    expect(received.map((e) => e.type)).toEqual(["tool_call", "tool_result"]);
    expect(sink.snapshot().every((e) => e.type === "tool_call" || e.type === "tool_result")).toBe(
      true,
    );
  });

  test("持久化流零镜像污染：JSONL 精确等于 emit 序列且无 source 标记", async () => {
    const sink = new MirrorSink();
    sink.subscribe(() => undefined);
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    const result = await h.runner.spawn("explore", "纯净", { parentSessionId: "main" });

    const entries = await h.mgr.entries(result.childSessionId);
    expect(entries.map((e) => e.type)).toEqual(["user", "tool_call", "tool_result"]);
    expect(
      entries.every((e) => (e.payload as { source?: string }).source !== "subagent"),
    ).toBe(true);
    // 主会话汇总亦不受镜像污染（唯一 source 标记属主会话汇总自身语义）
    const mainEntries = await h.mgr.entries("main");
    expect(mainEntries).toHaveLength(2);
  });

  test("退订后不再收到，镜像计数照常累计", async () => {
    const sink = new MirrorSink();
    const received: MirrorEvent[] = [];
    const un = sink.subscribe((e) => received.push(e));
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    un();
    await h.runner.spawn("explore", "退订", { parentSessionId: "main" });
    expect(received).toHaveLength(0);
    expect(sink.totalMirrored()).toBe(2);
  });

  test("坏监听器异常隔离：好监听器仍全收，异常计数", async () => {
    const sink = new MirrorSink();
    sink.subscribe(() => {
      throw new Error("TUI 卡片炸了");
    });
    const received: MirrorEvent[] = [];
    sink.subscribe((e) => received.push(e));
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    const result = await h.runner.spawn("explore", "隔离", { parentSessionId: "main" });
    expect(result.ok).toBe(true); // 子任务不受观测面故障反噬
    expect(received).toHaveLength(2);
    expect(sink.listenerErrors()).toBe(2);
  });

  test("多子隔离：镜像事件按 childSessionId 各归其位", async () => {
    const sink = new MirrorSink();
    const received: MirrorEvent[] = [];
    sink.subscribe((e) => received.push(e));
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    const a = await h.runner.spawn("explore", "甲", { parentSessionId: "main" });
    const b = await h.runner.spawn("explore", "乙", { parentSessionId: "main" });

    expect(received).toHaveLength(4);
    const ids = received.map((e) => e.childSessionId);
    expect(ids.slice(0, 2)).toEqual([a.childSessionId, a.childSessionId]);
    expect(ids.slice(2)).toEqual([b.childSessionId, b.childSessionId]);
  });

  test("seq 单调递增 + 注入时钟打点", async () => {
    const clock = fakeClock(5000);
    const sink = new MirrorSink({ clock });
    const received: MirrorEvent[] = [];
    sink.subscribe((e) => received.push(e));
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    await h.runner.spawn("explore", "打点", { parentSessionId: "main" });
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
    expect(received.every((e) => e.at === 5000)).toBe(true);
    clock.advance(10);
    await h.runner.spawn("explore", "打点2", { parentSessionId: "main" });
    expect(received.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(received.every((e) => e.at === 5000 || e.at === 5010)).toBe(true);
  });

  test("环形观测缓冲按 capacity 截断（留最新），totalMirrored 不受影响", async () => {
    const sink = new MirrorSink({ capacity: 2 });
    sink.subscribe(() => undefined);
    const h = makeHarness({ deps: { mirror: sink } });
    await seedMain(h);
    await h.runner.spawn("explore", "截断", { parentSessionId: "main" });
    expect(sink.snapshot()).toHaveLength(2);
    expect(sink.totalMirrored()).toBe(2);
  });
});
