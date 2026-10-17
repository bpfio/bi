/**
 * BI-03.6 离线阴影会话回放与非回归验证引擎 测试。
 *
 * 覆盖面（工单要求 ≥16 用例）：
 *  - Golden Trajectory 录制往返（SessionEntry 超集 + modelResponse 时序标记）；
 *  - stub 接管零副作用断言（0 真实 API）；
 *  - 决策一致性比对（一致/分歧各态：决策分歧、耗尽、多余、缺存根）；
 *  - divergences 结构与 assertNoRegression 阈值门；
 *  - 空轨迹。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowReplay } from "./shadow-replay";
import type { ReplayModelResponse } from "./shadow-replay";
import { TrajectoryFormatError, TrajectoryRecorder } from "./trajectory";
import type { TrajectoryRecordInput } from "./trajectory";

let dir: string | undefined;

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function makeDir(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "bi-shadow-replay-"));
  return dir;
}

/** 有限响应队列的 responseSequencer（逐决策点消耗，耗尽返回 undefined）。 */
function makeSequencer(responses: ReplayModelResponse[]): () => ReplayModelResponse | undefined {
  let i = 0;
  return () => (i < responses.length ? responses[i++] : undefined);
}

async function recordAll(
  path: string,
  inputs: TrajectoryRecordInput[],
): Promise<TrajectoryRecorder> {
  const recorder = new TrajectoryRecorder(path);
  for (const input of inputs) await recorder.record(input);
  return recorder;
}

/* --------------------------------- 轨迹录制与加载 --------------------------------- */

describe("TrajectoryRecorder（权威 Schema 备案）", () => {
  test("录制往返：record 后 load 深相等，JSONL 物理行数一致", async () => {
    const d = await makeDir();
    const path = join(d, "golden.jsonl");
    const recorder = new TrajectoryRecorder(path);
    const e1 = await recorder.record({ type: "user", payload: { text: "列出会话域资产" } });
    const e2 = await recorder.record({
      type: "assistant",
      payload: { text: "好的", toolCalls: [{ name: "list_dir", args: { dir: "/tmp" } }] },
    });
    const e3 = await recorder.record({
      type: "tool_call",
      payload: { args: { dir: "/tmp" } },
      toolName: "list_dir",
      toolCallId: "tc-1",
    });
    const loaded = await TrajectoryRecorder.load(path);
    expect(loaded).toEqual([e1, e2, e3]);
    const text = await readFile(path, "utf8");
    expect(text.trimEnd().split("\n").length).toBe(3);
  });

  test("record 自动补全：id 非空、createdAt 数值、seq 从 1 递增", async () => {
    const d = await makeDir();
    const recorder = new TrajectoryRecorder(join(d, "auto.jsonl"));
    const e1 = await recorder.record({ type: "user", payload: { text: "一" } });
    const e2 = await recorder.record({ type: "user", payload: { text: "二" } });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.id.length).toBeGreaterThan(0);
    expect(e2.id.length).toBeGreaterThan(0);
    expect(e1.parentId).toBeNull(); // Golden 线性主链
    expect(typeof e1.createdAt).toBe("number");
  });

  test("assistant 条目自动编号 modelResponse（ordinal 从 1 递增）", async () => {
    const d = await makeDir();
    const recorder = new TrajectoryRecorder(join(d, "marks.jsonl"));
    const a1 = await recorder.record({ type: "assistant", payload: { text: "决策一" } });
    const a2 = await recorder.record({ type: "assistant", payload: { text: "决策二" } });
    expect(a1.modelResponse?.ordinal).toBe(1);
    expect(a2.modelResponse?.ordinal).toBe(2);
    expect(typeof a1.modelResponse?.at).toBe("number");
    const user = await recorder.record({ type: "user", payload: { text: "非决策点" } });
    expect(user.modelResponse).toBeUndefined();
  });

  test("modelResponse 只允许出现在 assistant 条目（结构门禁）", async () => {
    const d = await makeDir();
    const recorder = new TrajectoryRecorder(join(d, "bad-mark.jsonl"));
    // 类型面 modelResponse 为可选宽进，运行时按权威 Schema 拒绝非 assistant 携带。
    expect(() =>
      recorder.record({
        type: "user",
        payload: { text: "x" },
        modelResponse: { ordinal: 1, at: 1 },
      }),
    ).toThrow(TypeError);
  });

  test("非法条目类型 / undefined payload → TypeError", async () => {
    const d = await makeDir();
    const recorder = new TrajectoryRecorder(join(d, "bad-type.jsonl"));
    expect(() =>
      recorder.record({
        // @ts-expect-error 故意越界：非法类型
        type: "hallucination",
        payload: null,
      }),
    ).toThrow(TypeError);
    expect(() =>
      recorder.record({
        type: "user",
        // @ts-expect-error 故意越界：payload undefined
        payload: undefined,
      }),
    ).toThrow(TypeError);
  });

  test("load 空文件 → 空数组；残缺行 → TrajectoryFormatError 带行号；缺文件 → line 0", async () => {
    const d = await makeDir();
    const empty = join(d, "empty.jsonl");
    await writeFile(empty, "", "utf8");
    expect(await TrajectoryRecorder.load(empty)).toEqual([]);

    const broken = join(d, "broken.jsonl");
    const good = await recordAll(broken, [{ type: "user", payload: { text: "好行" } }]);
    void good;
    await readFile(broken, "utf8"); // 确认存在
    const recorder = new TrajectoryRecorder(broken);
    await recorder.record({ type: "user", payload: { text: "第二行好行" } });
    const text = await readFile(broken, "utf8");
    await writeFile(broken, `${text.split("\n")[0]}\n这不是JSON\n`, "utf8");
    try {
      await TrajectoryRecorder.load(broken);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TrajectoryFormatError);
      expect((error as TrajectoryFormatError).line).toBe(2);
    }

    try {
      await TrajectoryRecorder.load(join(d, "missing.jsonl"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(TrajectoryFormatError);
      expect((error as TrajectoryFormatError).line).toBe(0);
    }
  });
});

/* --------------------------------- 阴影回放 --------------------------------- */

describe("ShadowReplay.replay 决策一致性", () => {
  test("一致场景：决策相同 + 存根齐全 → passed，步数与决策点数正确", async () => {
    const d = await makeDir();
    const path = join(d, "ok.jsonl");
    await recordAll(path, [
      { type: "user", payload: { text: "查看目录" } },
      { type: "assistant", payload: { toolCalls: [{ name: "list_dir", args: { dir: "/tmp" } }] } },
      { type: "tool_call", payload: { args: { dir: "/tmp" } }, toolName: "list_dir", toolCallId: "tc-1" },
      { type: "tool_result", payload: { result: "..." }, toolCallId: "tc-1", toolName: "list_dir" },
    ]);
    const replay = new ShadowReplay({
      trajectoryPath: path,
      toolStubs: { list_dir: () => ["a", "b"] },
      responseSequencer: makeSequencer([{ toolCalls: [{ name: "list_dir", args: { dir: "/tmp" } }] }]),
    });
    const report = replay.replay();
    expect(report.passed).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.steps).toBe(4);
    expect(report.decisionSteps).toBe(1);
  });

  test("决策分歧：工具名不同 → decision-mismatch（expected/actual 为规范 JSON）", async () => {
    const d = await makeDir();
    const path = join(d, "diverge.jsonl");
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "read_file", args: { path: "a" } }] } },
    ]);
    const replay = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([{ toolCalls: [{ name: "write_file", args: { path: "a" } }] }]),
    });
    const report = replay.replay();
    expect(report.passed).toBe(false);
    expect(report.divergences.length).toBe(1);
    const div = report.divergences[0];
    expect(div?.kind).toBe("decision-mismatch");
    expect(div?.step).toBe(1);
    expect(div?.expected).toContain("read_file");
    expect(div?.actual).toContain("write_file");
  });

  test("args 键序不同不算分歧；args 语义不同算分歧", async () => {
    const d = await makeDir();
    const path = join(d, "args.jsonl");
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "t", args: { a: 1, b: 2 } }] } },
    ]);
    const same = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([{ toolCalls: [{ name: "t", args: { b: 2, a: 1 } }] }]),
    });
    expect(same.replay().passed).toBe(true);

    const diff = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([{ toolCalls: [{ name: "t", args: { a: 1, b: 3 } }] }]),
    });
    const report = diff.replay();
    expect(report.divergences[0]?.kind).toBe("decision-mismatch");
  });

  test("sequencer 耗尽 → sequencer-exhausted；多余响应 → extra-decision", async () => {
    const d = await makeDir();
    const path = join(d, "seq.jsonl");
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "t1", args: null }] } },
      { type: "assistant", payload: { toolCalls: [{ name: "t2", args: null }] } },
    ]);
    const exhausted = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([{ toolCalls: [{ name: "t1", args: null }] }]),
    });
    const reportA = exhausted.replay();
    expect(reportA.divergences.map((x) => x.kind)).toContain("sequencer-exhausted");

    const extra = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([
        { toolCalls: [{ name: "t1", args: null }] },
        { toolCalls: [{ name: "t2", args: null }] },
        { toolCalls: [{ name: "t3", args: null }] },
      ]),
    });
    const reportB = extra.replay();
    expect(reportB.divergences.length).toBe(1);
    expect(reportB.divergences[0]?.kind).toBe("extra-decision");
    expect(reportB.divergences[0]?.expected).toBe("无更多决策点");
    expect(reportB.divergences[0]?.actual).toContain("t3");
  });

  test("未注入 sequencer：决策点只计步不比对", async () => {
    const d = await makeDir();
    const path = join(d, "noseq.jsonl");
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "t", args: 1 }] } },
    ]);
    const report = new ShadowReplay({ trajectoryPath: path }).replay();
    expect(report.decisionSteps).toBe(1);
    expect(report.divergences).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe("ShadowReplay 沙箱存根（0 真实 API、0 副作用）", () => {
  test("stub 按录制 args 被调用；真实工具路径零触碰；结果不做比对", async () => {
    const d = await makeDir();
    const path = join(d, "stub.jsonl");
    const recordedArgs = { path: "/tmp/会话.md", encoding: "utf8" };
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "read_file", args: recordedArgs }] } },
      { type: "tool_call", payload: { args: recordedArgs }, toolName: "read_file", toolCallId: "tc-9" },
      { type: "tool_result", payload: { result: "录制时的旧结果" }, toolCallId: "tc-9", toolName: "read_file" },
    ]);

    const stubCalls: unknown[] = [];
    let realToolTouched = false;
    const replay = new ShadowReplay({
      trajectoryPath: path,
      toolStubs: {
        read_file: (args) => {
          stubCalls.push(args);
          return "stub 影子结果（与录制结果不同也不算分歧）";
        },
      },
      // 「真实工具」路径只存在于测试闭包中，引擎无从触达：
      responseSequencer: makeSequencer([{ toolCalls: [{ name: "read_file", args: recordedArgs }] }]),
    });
    const report = replay.replay();
    expect(report.passed).toBe(true); // 决策一致，结果不比对
    expect(stubCalls.length).toBe(1);
    expect(stubCalls[0]).toEqual(recordedArgs);
    expect(realToolTouched).toBe(false);
  });

  test("缺存根 → missing-stub 分歧（其余步照常重演）", async () => {
    const d = await makeDir();
    const path = join(d, "no-stub.jsonl");
    await recordAll(path, [
      { type: "tool_call", payload: { args: {} }, toolName: "bash", toolCallId: "tc-1" },
      { type: "tool_call", payload: { args: {} }, toolName: "list_dir", toolCallId: "tc-2" },
    ]);
    const replay = new ShadowReplay({
      trajectoryPath: path,
      toolStubs: { list_dir: () => [] },
    });
    const report = replay.replay();
    expect(report.passed).toBe(false);
    expect(report.divergences.length).toBe(1);
    const div = report.divergences[0];
    expect(div?.kind).toBe("missing-stub");
    expect(div?.expected).toContain("bash");
  });
});

describe("ShadowReplay prompt 一致性与空轨迹", () => {
  test("promptSource 一致 → 通过；不一致 → prompt-mismatch（expected/actual）", async () => {
    const d = await makeDir();
    const path = join(d, "prompts.jsonl");
    await recordAll(path, [
      { type: "user", payload: { text: "第一问" } },
      { type: "user", payload: { text: "第二问" } },
    ]);
    const promptQueue = ["第一问", "第二问"];
    const same = new ShadowReplay({
      trajectoryPath: path,
      promptSource: () => promptQueue.shift(),
    });
    expect(same.replay().passed).toBe(true);
    expect(promptQueue.length).toBe(0); // 两条 prompt 都被消费

    const shifted: string[] = ["第一问", "被实现改掉的输入"];
    const mismatch = new ShadowReplay({
      trajectoryPath: path,
      promptSource: () => shifted.shift(),
    });
    const report = mismatch.replay();
    expect(report.passed).toBe(false);
    const div = report.divergences[0];
    expect(div?.kind).toBe("prompt-mismatch");
    expect(div?.expected).toBe("第二问");
    expect(div?.actual).toBe("被实现改掉的输入");
  });

  test("空轨迹（空文件/缺文件）→ passed、零步", async () => {
    const d = await makeDir();
    const empty = join(d, "empty.jsonl");
    await writeFile(empty, "", "utf8");
    const report = new ShadowReplay({ trajectoryPath: empty }).replay();
    expect(report).toEqual({ passed: true, steps: 0, decisionSteps: 0, divergences: [] });
    const missing = new ShadowReplay({ trajectoryPath: join(d, "ghost.jsonl") }).replay();
    expect(missing.passed).toBe(true);
    expect(missing.steps).toBe(0);
  });

  test("中文 args 的决策一致与分歧", async () => {
    const d = await makeDir();
    const path = join(d, "zh.jsonl");
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "grep", args: { pattern: "时光倒流", 目标: "会话" } }] } },
    ]);
    const same = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([
        { toolCalls: [{ name: "grep", args: { 目标: "会话", pattern: "时光倒流" } }] },
      ]),
    });
    expect(same.replay().passed).toBe(true);

    const diff = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([
        { toolCalls: [{ name: "grep", args: { pattern: "别的词", 目标: "会话" } }] },
      ]),
    });
    expect(diff.replay().passed).toBe(false);
  });
});

/* --------------------------------- 非回归阈值门 --------------------------------- */

describe("assertNoRegression 差异率阈值门", () => {
  test("1 分歧 / 1 决策点 → rate=1；threshold 0 拒绝、threshold 1 放行", async () => {
    const d = await makeDir();
    const path = join(d, "gate.jsonl");
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "t", args: 1 }] } },
    ]);
    const replay = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([{ toolCalls: [{ name: "other", args: 1 }] }]),
    });
    expect(replay.assertNoRegression(0)).toEqual({ ok: false, rate: 1, threshold: 0 });
    expect(replay.assertNoRegression(1).ok).toBe(true);
  });

  test("部分分歧：2 决策点 1 分歧 → rate=0.5，threshold 0.5 恰好放行", async () => {
    const d = await makeDir();
    const path = join(d, "half.jsonl");
    await recordAll(path, [
      { type: "assistant", payload: { toolCalls: [{ name: "a", args: 1 }] } },
      { type: "assistant", payload: { toolCalls: [{ name: "b", args: 2 }] } },
    ]);
    const replay = new ShadowReplay({
      trajectoryPath: path,
      responseSequencer: makeSequencer([
        { toolCalls: [{ name: "a", args: 1 }] },
        { toolCalls: [{ name: "CHANGED", args: 2 }] },
      ]),
    });
    const gate = replay.assertNoRegression(0.5);
    expect(gate.rate).toBe(0.5);
    expect(gate.ok).toBe(true);
    expect(replay.assertNoRegression(0.49).ok).toBe(false);
  });

  test("threshold 非法 → RangeError；零分歧空轨迹 rate=0 恒放行", async () => {
    const d = await makeDir();
    const path = join(d, "range.jsonl");
    await recordAll(path, [{ type: "user", payload: { text: "无决策点" } }]);
    const replay = new ShadowReplay({ trajectoryPath: path });
    expect(() => replay.assertNoRegression(1.5)).toThrow(RangeError);
    expect(() => replay.assertNoRegression(Number.NaN)).toThrow(RangeError);
    expect(replay.assertNoRegression(0)).toEqual({ ok: true, rate: 0, threshold: 0 });
  });
});
