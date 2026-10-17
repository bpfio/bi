/**
 * BI-07.3 · SubagentRunner 测试。
 *
 * 覆盖矩阵：
 * - 四 profile 工具策略矩阵（explore 只读 / coder 带写 / plan 结构化规划 / fork 克隆占位）；
 * - 视窗断路器（子事件全进 childSessionId、主会话只追加最终汇总、outbox steer）；
 * - fork 克隆保真（systemPrompt 字节级、精确工具集保序、历史切片透传、缺源结构化失败）；
 * - 防递归剥离（Agent/spawn/AskUserQuestion 剥离 + 审计 + 子会话 system 条目）；
 * - 失败隔离（子循环异常折叠为结构化失败，主会话不炸）；
 * - 并发派生隔离（子会话互斥、父会话结果互不串）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "../session/inbox";
import { SessionManager } from "../session/manager";
import type { SessionEntry } from "../session/types";
import {
  getSubagentProfile,
  RECURSION_HAZARD_TOOLS,
  SUBAGENT_PROFILES,
  SUBAGENT_PROFILE_TYPES,
} from "./profiles";
import {
  SubagentRunner,
  type LoopFactory,
  type SubLoopSessionCtx,
  type SubagentOutboxMessage,
  type SubagentRunnerDeps,
  type SubagentSessionWriter,
} from "./runner";

/* ------------------------------------------------------------------ */
/* 测试基座                                                             */
/* ------------------------------------------------------------------ */

let root = "";
let fixtureSeq = 0;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bi-subagent-")));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 会话写端口适配：自管 parentId tip 链，首写自动建会话。 */
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

function fakeEntry(id: string): SessionEntry {
  return { id, parentId: null, type: "user", payload: { text: id }, createdAt: 0, seq: 1 };
}

interface Harness {
  mgr: SessionManager;
  writer: SubagentSessionWriter;
  outbox: Inbox<SubagentOutboxMessage>;
  runner: SubagentRunner;
  /** loopFactory 捕获的子循环上下文（按 childSessionId 索引）。 */
  ctxs: Map<string, SubLoopSessionCtx>;
}

const textOf = (entry: SessionEntry): string =>
  (entry.payload as { text?: string }).text ?? "";

/** 默认回显循环：emit user + tool_call + tool_result，汇总 done:<prompt>。 */
const echoLoop: LoopFactory = (_profile, ctx) => ({
  async run() {
    await ctx.emit({ type: "user", payload: { text: ctx.prompt } });
    await ctx.emit({
      type: "tool_call",
      payload: { name: "Read", args: { path: "/a" } },
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
    generateSessionId: () => `child-${++seq}`,
    ...opts?.deps,
  });
  return { mgr, writer, outbox, runner, ctxs };
}

/** 预置主会话：meta + 一条根 user 条目。 */
async function seedMain(h: Harness, sessionId = "main"): Promise<void> {
  await h.mgr.createSession({ sessionId, title: "主会话" });
  await h.writer.append(sessionId, { type: "user", payload: { text: "开始主任务" } });
}

/* ------------------------------------------------------------------ */
/* profiles 工具策略矩阵                                                 */
/* ------------------------------------------------------------------ */

describe("profiles 工具策略矩阵", () => {
  test("explore 只读禁写：白名单仅只读工具", () => {
    const p = SUBAGENT_PROFILES.explore;
    expect([...p.toolPolicy]).toEqual(["Read", "Grep", "Glob"]);
    expect(p.toolPolicy).not.toContain("Write");
    expect(p.toolPolicy).not.toContain("Edit");
    expect(p.toolPolicy).not.toContain("Bash");
  });

  test("coder 带写：含 Write/Edit 与只读集", () => {
    const p = SUBAGENT_PROFILES.coder;
    expect(p.toolPolicy).toContain("Write");
    expect(p.toolPolicy).toContain("Edit");
    expect(p.toolPolicy).toContain("Read");
    expect(p.toolPolicy).not.toContain("Agent");
    expect(p.toolPolicy).not.toContain("AskUserQuestion");
  });

  test("plan 只读且 systemAddon 钉死结构化规划输出", () => {
    const p = SUBAGENT_PROFILES.plan;
    expect([...p.toolPolicy]).toEqual(["Read", "Grep", "Glob"]);
    expect(p.systemAddon).toContain("结构化规划");
  });

  test("fork 为克隆占位：空工具策略、无 systemAddon（保字节级克隆）", () => {
    const p = SUBAGENT_PROFILES.fork;
    expect([...p.toolPolicy]).toEqual([]);
    expect(p.systemAddon).toBeUndefined();
  });

  test("注册表冻结：运行期不可篡改策略面", () => {
    for (const type of SUBAGENT_PROFILE_TYPES) {
      expect(Object.isFrozen(SUBAGENT_PROFILES[type])).toBe(true);
    }
    expect(
      () =>
        ((SUBAGENT_PROFILES.explore as unknown as { toolPolicy: string[] }).toolPolicy = []),
    ).toThrow();
  });

  test("getSubagentProfile 已知四类命中、未知返回 undefined；危害名单齐备", () => {
    for (const type of SUBAGENT_PROFILE_TYPES) {
      expect(getSubagentProfile(type)?.type).toBe(type);
    }
    expect(getSubagentProfile("nope")).toBeUndefined();
    expect([...RECURSION_HAZARD_TOOLS]).toEqual(["Agent", "spawn", "AskUserQuestion"]);
  });
});

/* ------------------------------------------------------------------ */
/* 视窗断路器                                                           */
/* ------------------------------------------------------------------ */

describe("视窗断路器", () => {
  test("子循环全部事件写入 childSessionId，主会话不见子事件", async () => {
    const h = makeHarness();
    await seedMain(h);
    const result = await h.runner.spawn("explore", "扫盘 /src", { parentSessionId: "main" });

    const childEntries = await h.mgr.entries(result.childSessionId);
    expect(childEntries.map((e) => e.type)).toEqual(["user", "tool_call", "tool_result"]);
    expect(textOf(childEntries[0]!)).toBe("扫盘 /src");

    const mainEntries = await h.mgr.entries("main");
    // 主会话 = 预置 1 条 + 最终汇总 1 条，子事件零泄漏
    expect(mainEntries).toHaveLength(2);
    expect(mainEntries.map((e) => e.type)).toEqual(["user", "assistant"]);
  });

  test("主会话只追加最终汇总文本（含 childSessionId 溯源）", async () => {
    const h = makeHarness();
    await seedMain(h);
    const result = await h.runner.spawn("explore", "任务X", { parentSessionId: "main" });

    const mainEntries = await h.mgr.entries("main");
    const summary = mainEntries.at(-1)!;
    expect(textOf(summary)).toBe("done:任务X");
    const payload = summary.payload as { childSessionId?: string; subagentType?: string };
    expect(payload.childSessionId).toBe(result.childSessionId);
    expect(payload.subagentType).toBe("explore");
  });

  test("resultFor(parent) 返回 { summary, childSessionId, toolCalls }", async () => {
    const h = makeHarness();
    await seedMain(h);
    const spawned = await h.runner.spawn("explore", "数一下", { parentSessionId: "main" });
    const found = h.runner.resultFor("main");
    expect(found).toBeDefined();
    expect(found!.summary).toBe("done:数一下");
    expect(found!.childSessionId).toBe(spawned.childSessionId);
    expect(found!.toolCalls).toBe(1);
  });

  test("完成结果经 outbox steer 通道投递（BI-03.5 复用）", async () => {
    const h = makeHarness();
    await seedMain(h);
    await h.runner.spawn("coder", "改文件", { parentSessionId: "main" });

    expect(h.outbox.hasSteers()).toBe(true);
    expect(h.outbox.hasInputs()).toBe(false); // 只走 steer 通道
    const [msg] = h.outbox.takeSteers();
    expect(msg!.kind).toBe("subagent-result");
    expect(msg!.profileType).toBe("coder");
    expect(msg!.summary).toBe("done:改文件");
    expect(msg!.ok).toBe(true);
  });

  test("无 parentSessionId：不写主会话、resultFor 查不到，但 outbox 照常投递", async () => {
    const h = makeHarness();
    await seedMain(h);
    const before = (await h.mgr.entries("main")).length;
    const result = await h.runner.spawn("explore", "孤儿任务");

    expect(result.parentSessionId).toBeUndefined();
    expect((await h.mgr.entries("main")).length).toBe(before);
    expect(h.runner.resultFor("main")).toBeUndefined();
    expect(h.runner.resultByChild(result.childSessionId)?.ok).toBe(true);
    expect(h.outbox.sizes().steers).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* fork 克隆保真                                                        */
/* ------------------------------------------------------------------ */

describe("fork 克隆保真", () => {
  test("systemPrompt 字节级克隆（unicode/emoji/空白原样，零拼接）", async () => {
    const h = makeHarness();
    await seedMain(h);
    const parentPrompt = "父级 system\n\t带制表符与 emoji 🚀 中文 ✓  尾随空格  ";
    await h.runner.spawn("fork", "延续父任务", {
      parentSessionId: "main",
      parentSystemPrompt: parentPrompt,
      parentTools: ["Read"],
    });
    const ctx = [...h.ctxs.values()].at(-1)!;
    expect(ctx.systemPrompt).toBe(parentPrompt);
    expect(Buffer.from(ctx.systemPrompt, "utf8").equals(Buffer.from(parentPrompt, "utf8"))).toBe(
      true,
    );
    // 零拼接：不含任何 addon 字样
    expect(ctx.systemPrompt.includes("纪律")).toBe(false);
  });

  test("精确工具集克隆保序，危害工具仍被剥离", async () => {
    const h = makeHarness();
    await seedMain(h);
    const result = await h.runner.spawn("fork", "克隆", {
      parentSessionId: "main",
      parentSystemPrompt: "P",
      parentTools: ["Write", "Agent", "Read", "AskUserQuestion", "Bash"],
    });
    const ctx = h.ctxs.get(result.childSessionId)!;
    expect([...ctx.effectiveTools]).toEqual(["Write", "Read", "Bash"]); // 保序
    expect([...result.strippedTools]).toEqual(["Agent", "AskUserQuestion"]);
  });

  test("历史切片经 getHistorySlice 端口透传（含 tail 参数与父会话 id）", async () => {
    const h = makeHarness();
    await seedMain(h);
    const slice = { entries: [fakeEntry("e1"), fakeEntry("e2")] };
    let seenId = "";
    let seenOpts: { tail?: number } | undefined;
    const h2 = makeHarness({
      deps: {
        getHistorySlice: (id, o) => {
          seenId = id;
          seenOpts = o;
          return slice;
        },
      },
    });
    await seedMain(h2);
    const result = await h2.runner.spawn("fork", "带历史", {
      parentSessionId: "main",
      parentSystemPrompt: "P",
      parentTools: ["Read"],
      historyTail: 5,
    });
    const ctx = h2.ctxs.get(result.childSessionId)!;
    expect(ctx.historySlice).toBe(slice);
    expect(ctx.historySlice?.entries).toHaveLength(2);
    expect(seenId).toBe("main");
    expect(seenOpts?.tail).toBe(5);
  });

  test("fork 缺 parentSystemPrompt → 结构化失败不炸，主会话收失败汇总", async () => {
    const h = makeHarness();
    await seedMain(h);
    const result = await h.runner.spawn("fork", "残缺克隆", {
      parentSessionId: "main",
      parentTools: ["Read"],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("parentSystemPrompt");
    expect(result.summary).toContain("克隆校验失败");

    const mainEntries = await h.mgr.entries("main");
    expect(textOf(mainEntries.at(-1)!)).toBe(result.summary);
    expect(h.outbox.sizes().steers).toBe(1);
  });

  test("fork 缺历史切片端口 → 轻量克隆照常成功（historySlice undefined）", async () => {
    const h = makeHarness();
    await seedMain(h);
    const result = await h.runner.spawn("fork", "无切片", {
      parentSessionId: "main",
      parentSystemPrompt: "P",
      parentTools: ["Read"],
    });
    expect(result.ok).toBe(true);
    expect(h.ctxs.get(result.childSessionId)!.historySlice).toBeUndefined();
  });

  test("fork 成功路径：主会话照常只追加一条汇总", async () => {
    const h = makeHarness();
    await seedMain(h);
    await h.runner.spawn("fork", "延续", {
      parentSessionId: "main",
      parentSystemPrompt: "父级P",
      parentTools: ["Read", "Grep"],
    });
    const mainEntries = await h.mgr.entries("main");
    expect(mainEntries).toHaveLength(2);
    expect(mainEntries.at(-1)!.type).toBe("assistant");
    expect(textOf(mainEntries.at(-1)!)).toBe("done:延续");
  });
});

/* ------------------------------------------------------------------ */
/* 防递归剥离                                                           */
/* ------------------------------------------------------------------ */

describe("防递归剥离", () => {
  const orchestratorDeps = (): Partial<SubagentRunnerDeps> => ({
    extraProfiles: {
      orchestrator: {
        type: "explore",
        toolPolicy: ["Read", "Agent", "spawn", "AskUserQuestion"],
        systemAddon: "编排纪律",
      },
    },
  });

  test("自定义 profile 含 Agent/spawn → 全部剥离 + 审计", async () => {
    const h = makeHarness({ deps: orchestratorDeps() });
    await seedMain(h);
    const result = await h.runner.spawn("orchestrator", "编排", { parentSessionId: "main" });
    expect([...result.strippedTools]).toEqual(["Agent", "spawn", "AskUserQuestion"]);
    expect(h.ctxs.get(result.childSessionId)!.effectiveTools).toEqual(["Read"]);

    const audits = h.runner.stripAudits();
    expect(audits).toHaveLength(1);
    expect([...audits[0]!.stripped]).toEqual(["Agent", "spawn", "AskUserQuestion"]);
    expect(audits[0]!.childSessionId).toBe(result.childSessionId);
  });

  test("AskUserQuestion 一并剥离（子会话无人应答）", async () => {
    const h = makeHarness({
      deps: {
        extraProfiles: {
          asker: { type: "explore", toolPolicy: ["Read", "AskUserQuestion"] },
        },
      },
    });
    await seedMain(h);
    const result = await h.runner.spawn("asker", "想提问", { parentSessionId: "main" });
    expect([...result.strippedTools]).toEqual(["AskUserQuestion"]);
    expect(h.ctxs.get(result.childSessionId)!.effectiveTools).toEqual(["Read"]);
  });

  test("无危害工具的派生：零审计、零 strip 事件", async () => {
    const h = makeHarness();
    await seedMain(h);
    const result = await h.runner.spawn("explore", "干净任务", { parentSessionId: "main" });
    expect(result.strippedTools).toEqual([]);
    expect(h.runner.stripAudits()).toHaveLength(0);
    const childEntries = await h.mgr.entries(result.childSessionId);
    expect(childEntries.some((e) => e.type === "system")).toBe(false);
  });

  test("剥离在子会话留 system 条目（tool-policy-strip）", async () => {
    const h = makeHarness({ deps: orchestratorDeps() });
    await seedMain(h);
    const result = await h.runner.spawn("orchestrator", "留痕", { parentSessionId: "main" });
    const childEntries = await h.mgr.entries(result.childSessionId);
    const stripEntry = childEntries[0]!;
    expect(stripEntry.type).toBe("system");
    const payload = stripEntry.payload as { kind?: string; stripped?: string[] };
    expect(payload.kind).toBe("tool-policy-strip");
    expect(payload.stripped).toEqual(["Agent", "spawn", "AskUserQuestion"]);
  });

  test("fork 克隆源含危害工具 → 同样剥离 + 审计（递归根除）", async () => {
    const h = makeHarness();
    await seedMain(h);
    const result = await h.runner.spawn("fork", "克隆含Agent", {
      parentSessionId: "main",
      parentSystemPrompt: "P",
      parentTools: ["Read", "Agent", "spawn"],
    });
    expect([...result.strippedTools]).toEqual(["Agent", "spawn"]);
    expect(h.runner.stripAudits()).toHaveLength(1);
    expect(h.ctxs.get(result.childSessionId)!.effectiveTools).toEqual(["Read"]);
  });
});

/* ------------------------------------------------------------------ */
/* 失败隔离                                                             */
/* ------------------------------------------------------------------ */

describe("失败隔离", () => {
  test("子循环异常 → 结构化失败：spawn 不炸、主会话收失败汇总、outbox ok:false", async () => {
    const h = makeHarness({
      loop: () => ({
        run: async () => {
          throw new Error("模型连接中断");
        },
      }),
    });
    await seedMain(h);
    const result = await h.runner.spawn("explore", "会炸的任务", { parentSessionId: "main" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("模型连接中断");
    expect(result.summary).toContain("结构化失败");
    expect(result.summary).toContain("模型连接中断");

    const mainEntries = await h.mgr.entries("main");
    expect(textOf(mainEntries.at(-1)!)).toBe(result.summary);
    const [msg] = h.outbox.takeSteers();
    expect(msg!.ok).toBe(false);
  });

  test("子循环返回 ok:false → 原样透传 summary 与 error", async () => {
    const h = makeHarness({
      loop: () => ({
        run: async () => ({ ok: false, summary: "任务中止:预算耗尽", error: "预算耗尽" }),
      }),
    });
    await seedMain(h);
    const result = await h.runner.spawn("plan", "预算任务", { parentSessionId: "main" });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("任务中止:预算耗尽");
    expect(result.error).toBe("预算耗尽");
  });

  test("落盘故障（writer 拒绝）→ 结构化失败不炸", async () => {
    const h = makeHarness({
      deps: {
        sessionWriter: {
          append: async () => {
            throw new Error("盘满");
          },
        },
      },
    });
    const result = await h.runner.spawn("explore", "写不进");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("盘满");
    expect(result.summary).toContain("结构化失败");
  });
});

/* ------------------------------------------------------------------ */
/* 并发派生隔离                                                         */
/* ------------------------------------------------------------------ */

describe("并发派生隔离", () => {
  test("同父顺序多次派生：resultFor 取最新、resultsFor 保完成序", async () => {
    const h = makeHarness();
    await seedMain(h);
    await h.runner.spawn("explore", "第一单", { parentSessionId: "main" });
    await h.runner.spawn("explore", "第二单", { parentSessionId: "main" });
    expect(h.runner.resultsFor("main")).toHaveLength(2);
    expect(h.runner.resultFor("main")!.summary).toBe("done:第二单");
  });

  test("并发 spawn：子会话内容互斥、结果各自归属", async () => {
    const h = makeHarness();
    await seedMain(h);
    const [a, b] = await Promise.all([
      h.runner.spawn("explore", "并发A", { parentSessionId: "main" }),
      h.runner.spawn("explore", "并发B", { parentSessionId: "main" }),
    ]);
    expect(a.childSessionId).not.toBe(b.childSessionId);

    const entriesA = await h.mgr.entries(a.childSessionId);
    const entriesB = await h.mgr.entries(b.childSessionId);
    expect(entriesA.map(textOf)).toContain("并发A");
    expect(entriesA.map(textOf)).not.toContain("并发B");
    expect(entriesB.map(textOf)).toContain("并发B");
    expect(entriesB.map(textOf)).not.toContain("并发A");

    expect(h.runner.resultByChild(a.childSessionId)!.summary).toBe("done:并发A");
    expect(h.runner.resultByChild(b.childSessionId)!.summary).toBe("done:并发B");
  });

  test("双父隔离：resultFor(A) 与 resultFor(B) 互不串", async () => {
    const h = makeHarness();
    await seedMain(h, "parentA");
    await seedMain(h, "parentB");
    await h.runner.spawn("explore", "给A", { parentSessionId: "parentA" });
    await h.runner.spawn("explore", "给B", { parentSessionId: "parentB" });
    expect(h.runner.resultFor("parentA")!.summary).toBe("done:给A");
    expect(h.runner.resultFor("parentB")!.summary).toBe("done:给B");
    expect(h.runner.resultFor("parentC")).toBeUndefined();
  });

  test("toolCalls 计数：emit 计数优先于 outcome 兜底", async () => {
    const h = makeHarness({
      loop: (_profile, ctx) => ({
        async run() {
          await ctx.emit({ type: "tool_call", payload: {}, toolCallId: "1", toolName: "Read" });
          await ctx.emit({ type: "tool_call", payload: {}, toolCallId: "2", toolName: "Grep" });
          return { ok: true, summary: "s", toolCalls: 99 };
        },
      }),
    });
    await seedMain(h);
    const emitted = await h.runner.spawn("explore", "计数", { parentSessionId: "main" });
    expect(emitted.toolCalls).toBe(2);

    const h2 = makeHarness({
      loop: () => ({ run: async () => ({ ok: true, summary: "s", toolCalls: 7 }) }),
    });
    const silent = await h2.runner.spawn("explore", "静默计数");
    expect(silent.toolCalls).toBe(7);
  });

  test("子会话 id：默认 sub- 前缀；注入生成器逐次递增", async () => {
    const h = makeHarness();
    const a = await h.runner.spawn("explore", "id1");
    const b = await h.runner.spawn("explore", "id2");
    expect(a.childSessionId).toBe("child-1");
    expect(b.childSessionId).toBe("child-2");

    const h2 = makeHarness({ deps: { generateSessionId: undefined } });
    const c = await h2.runner.spawn("explore", "id3");
    expect(c.childSessionId.startsWith("sub-")).toBe(true);
  });

  test("未知 profileType 抛 TypeError（程序员错误，闭联集之外）", async () => {
    const h = makeHarness();
    await expect(
      h.runner.spawn("nope" as "explore", "x"),
    ).rejects.toBeInstanceOf(TypeError);
  });
});
