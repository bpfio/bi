/**
 * BI-07.6 · /btw 旁路零干扰问答微服务测试。
 *
 * 覆盖：只读工具硬锁、上下文切片透传、主态零干扰快照（主会话 JSONL /
 * 主 outbox / 主 runner 三面）、结果只返回调用方不落主史、并发排队 FIFO
 * 无交叠、失败结构化（循环异常 / 取料失败 / 空问题）、双 runner 独立记账。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../session/inbox";
import { SessionManager } from "../session/manager";
import type { JsonValue } from "../session/types";
import {
  SubagentRunner,
  type LoopFactory,
  type SubLoopSessionCtx,
  type SubagentOutboxMessage,
  type SubagentProfile,
  type SubagentSessionWriter,
} from "./runner";
import { BtwService, BTW_TOOL_LOCK, type BtwMainState } from "./btw-service";

/* ------------------------------------------------------------------ */
/* 测试基座                                                             */
/* ------------------------------------------------------------------ */

let root = "";
let fixtureSeq = 0;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bi-btw-")));
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

interface Rec {
  ctxs: SubLoopSessionCtx[];
  profiles: SubagentProfile[];
  order: string[];
}

/** 捕获 ctx 的旁路回显循环。 */
const btwLoop = (rec: Rec): LoopFactory => (_profile, ctx) => ({
  async run() {
    rec.ctxs.push(ctx);
    rec.order.push(`enter:${ctx.prompt}`);
    await ctx.emit({ type: "user", payload: { text: ctx.prompt } });
    await ctx.emit({
      type: "tool_call",
      payload: { name: "Read", args: {} },
      toolCallId: "t1",
      toolName: "Read",
    });
    await ctx.emit({
      type: "tool_result",
      payload: { ok: true },
      toolCallId: "t1",
      toolName: "Read",
    });
    rec.order.push(`exit:${ctx.prompt}`);
    return { ok: true, summary: `btw答:${ctx.prompt}` };
  },
});

interface Rig {
  mgr: SessionManager;
  mainOutbox: Inbox<SubagentOutboxMessage>;
  mainRunner: SubagentRunner;
  btw: BtwService;
  rec: Rec;
  sliceCalls: string[];
}

/** 装配：主会话 + 主 outbox/主 runner（模拟主循环侧）+ btw 微服务。 */
async function makeRig(loop?: LoopFactory): Promise<Rig> {
  fixtureSeq += 1;
  const mgr = new SessionManager({ rootDir: join(root, `f${fixtureSeq}`) });
  const writer = makeWriter(mgr);
  await mgr.createSession({ sessionId: "main", title: "主会话" });
  await writer.append("main", { type: "user", payload: { text: "长任务进行中" } });

  const mainOutbox = new Inbox<SubagentOutboxMessage>();
  const mainRunner = new SubagentRunner({
    loopFactory: (_p, ctx) => ({ run: async () => ({ ok: true, summary: ctx.prompt }) }),
    sessionWriter: writer,
    outbox: mainOutbox,
  });

  const rec: Rec = { ctxs: [], profiles: [], order: [] };
  const sliceCalls: string[] = [];
  let btwSeq = 0;
  const inner = loop ?? btwLoop(rec);
  const recordingLoop: LoopFactory = (profile, ctx) => {
    rec.profiles.push(profile);
    return inner(profile, ctx);
  };
  const btw = new BtwService({
    loopFactory: recordingLoop,
    sessionWriter: writer,
    getContextSlice: (id) => {
      sliceCalls.push(id);
      return { kind: "slice", sessionId: id, entries: 42 } as JsonValue;
    },
    generateSessionId: () => `btw-child-${fixtureSeq}-${++btwSeq}`,
  });
  return { mgr, mainOutbox, mainRunner, btw, rec, sliceCalls };
}

const MAIN: BtwMainState = { sessionId: "main", loopState: "tool-executing" };

/** 主态三面快照（零干扰断言的对照基线）。 */
async function snapshotMain(rig: Rig, state: BtwMainState): Promise<string> {
  const entries = await rig.mgr.entries(state.sessionId);
  return JSON.stringify({
    entries: entries.map((e) => [e.type, e.payload]),
    outbox: rig.mainOutbox.snapshot(),
    outboxSizes: rig.mainOutbox.sizes(),
    mainResults: rig.mainRunner.resultsFor(state.sessionId).map((r) => r.childSessionId),
    mainRuns: rig.mainRunner.runInfos().map((r) => r.childSessionId),
  });
}

/* ------------------------------------------------------------------ */
/* 用例                                                                 */
/* ------------------------------------------------------------------ */

describe("BtwService /btw 旁路问答", () => {
  test("ask 返回结构化回答（ok/answer/childSessionId/toolCalls）", async () => {
    const rig = await makeRig();
    const answer = await rig.btw.ask("这个函数是干嘛的？", MAIN);
    expect(answer.ok).toBe(true);
    expect(answer.answer).toBe("btw答:这个函数是干嘛的？");
    expect(answer.childSessionId).toBeDefined();
    expect(answer.toolCalls).toBe(1);
    expect(typeof answer.queuedMs).toBe("number");
  });

  test("工具硬锁：ctx.effectiveTools 精确等于 Read/Grep/Glob", async () => {
    const rig = await makeRig();
    const answer = await rig.btw.ask("锁面检查", MAIN);
    expect(answer.ok).toBe(true);
    const ctx = rig.rec.ctxs[0]!;
    expect([...ctx.effectiveTools]).toEqual([...BTW_TOOL_LOCK]);
    expect([...ctx.effectiveTools]).toEqual(["Read", "Grep", "Glob"]);
  });

  test("只读角色：经 explore profile 派生且无写工具", async () => {
    const rig = await makeRig();
    await rig.btw.ask("角色检查", MAIN);
    expect(rig.rec.profiles[0]!.type).toBe("explore");
    const ctx = rig.rec.ctxs[0]!;
    expect(ctx.effectiveTools).not.toContain("Write");
    expect(ctx.effectiveTools).not.toContain("Edit");
    expect(ctx.effectiveTools).not.toContain("Bash");
  });

  test("上下文切片透传：getContextSlice 以主会话 id 调用并进入 ctx", async () => {
    const rig = await makeRig();
    await rig.btw.ask("上下文", MAIN);
    expect(rig.sliceCalls).toEqual(["main"]);
    const ctx = rig.rec.ctxs[0]!;
    expect(ctx.contextSlice).toEqual({ kind: "slice", sessionId: "main", entries: 42 });
  });

  test("主态零干扰：ask 前后主会话 JSONL / 主 outbox / 主 runner 快照不变", async () => {
    const rig = await makeRig();
    const before = await snapshotMain(rig, MAIN);
    await rig.btw.ask("零干扰", MAIN);
    const after = await snapshotMain(rig, MAIN);
    expect(after).toBe(before);
  });

  test("btw 结果只返回调用方：answer 不落主会话，子会话正常记录", async () => {
    const rig = await makeRig();
    const answer = await rig.btw.ask("答案去向", MAIN);
    const mainEntries = await rig.mgr.entries("main");
    expect(mainEntries).toHaveLength(1); // 仍只有预置长任务条目
    expect(mainEntries.some((e) => JSON.stringify(e.payload).includes("答案去向"))).toBe(false);

    const childEntries = await rig.mgr.entries(answer.childSessionId!);
    expect(childEntries.map((e) => e.type)).toEqual(["user", "tool_call", "tool_result"]);
  });

  test("并发 ask 串行排队：执行零交叠、完成 FIFO", async () => {
    const rig = await makeRig();
    const [a, b, c] = await Promise.all([
      rig.btw.ask("问一", MAIN),
      rig.btw.ask("问二", MAIN),
      rig.btw.ask("问三", MAIN),
    ]);
    expect(rig.rec.order).toEqual([
      "enter:问一",
      "exit:问一",
      "enter:问二",
      "exit:问二",
      "enter:问三",
      "exit:问三",
    ]);
    expect(a.answer).toBe("btw答:问一");
    expect(b.answer).toBe("btw答:问二");
    expect(c.answer).toBe("btw答:问三");
  });

  test("并发 btw 各自独立子会话、互不串扰", async () => {
    const rig = await makeRig();
    const [a, b] = await Promise.all([rig.btw.ask("并行甲", MAIN), rig.btw.ask("并行乙", MAIN)]);
    expect(a.childSessionId).not.toBe(b.childSessionId);
    const entriesA = await rig.mgr.entries(a.childSessionId!);
    expect((entriesA[0]!.payload as { text?: string }).text).toBe("并行甲");
    const entriesB = await rig.mgr.entries(b.childSessionId!);
    expect((entriesB[0]!.payload as { text?: string }).text).toBe("并行乙");
  });

  test("子循环异常 → 结构化失败回答，主态仍零干扰", async () => {
    const boom: LoopFactory = () => ({
      run: async () => {
        throw new Error("旁路模型失联");
      },
    });
    const rig = await makeRig(boom);
    const before = await snapshotMain(rig, MAIN);
    const answer = await rig.btw.ask("会炸吗", MAIN);
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe("旁路模型失联");
    expect(answer.answer).toContain("结构化失败");
    const after = await snapshotMain(rig, MAIN);
    expect(after).toBe(before);
  });

  test("getContextSlice 抛异常 → 结构化失败，未派生子会话", async () => {
    fixtureSeq += 1;
    const mgr = new SessionManager({ rootDir: join(root, `f${fixtureSeq}`) });
    const writer = makeWriter(mgr);
    await mgr.createSession({ sessionId: "main", title: "主会话" });
    const btw = new BtwService({
      loopFactory: btwLoop({ ctxs: [], profiles: [], order: [] }),
      sessionWriter: writer,
      getContextSlice: () => {
        throw new Error("主会话不可读");
      },
    });
    const answer = await btw.ask("取不到料", MAIN);
    expect(answer.ok).toBe(false);
    expect(answer.error).toBe("主会话不可读");
    expect(answer.childSessionId).toBeUndefined();
    expect(btw.runner.runInfos()).toHaveLength(0); // 未派生
  });

  test("空问题 → 结构化拒绝，不派生子会话", async () => {
    const rig = await makeRig();
    const answer = await rig.btw.ask("", MAIN);
    expect(answer.ok).toBe(false);
    expect(answer.error).toContain("不能为空");
    expect(rig.btw.runner.runInfos()).toHaveLength(0);
    expect(rig.rec.ctxs).toHaveLength(0);
  });

  test("旁路 runner 结构隔离：无 outbox，子会话 id 前缀 btw-", async () => {
    const rig = await makeRig();
    const answer = await rig.btw.ask("前缀", MAIN);
    expect(rig.btw.runner.outbox).toBeUndefined();
    expect(answer.childSessionId!.startsWith("btw-")).toBe(true);
  });

  test("主任务自身派生子代理不受 btw 干扰（双 runner 独立记账）", async () => {
    const rig = await makeRig();
    const btwAnswer = await rig.btw.ask("旁路一问", MAIN);
    const mainResult = await rig.mainRunner.spawn("explore", "主任务子代理");
    expect(mainResult.ok).toBe(true);
    // btw 的记账在私有 runner 上，主 runner 无污染
    expect(rig.mainRunner.runInfos().some((r) => r.childSessionId === btwAnswer.childSessionId)).toBe(
      false,
    );
    expect(rig.btw.runner.runInfos().some((r) => r.childSessionId === mainResult.childSessionId)).toBe(
      false,
    );
  });
});
