import { describe, expect, test } from "bun:test";
import {
  createCommandCapturePort,
  DEFAULT_MAX_ROUNDS,
  isPng,
  runVisualJudge,
  VISUAL_JUDGE_ISSUE_TYPES,
} from "./visual-judge.ts";
import type {
  CapturePort,
  JudgeIssue,
  JudgeVerdict,
  VisionJudgePort,
} from "./visual-judge.ts";

// ---------------------------------------------------------------------------
// 伪端口脚手架
// ---------------------------------------------------------------------------

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);

function makeIssue(type: JudgeIssue["type"], detail: string, fixHint: string): JudgeIssue {
  return { type, detail, fixHint };
}

/** 伪 CapturePort:恒返回给定字节(或 null),记录 chartRef 调用轨迹。 */
function captureStub(bytes: Uint8Array | null = PNG_BYTES): CapturePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    capture: async (chartRef: string) => {
      calls.push(chartRef);
      return bytes;
    },
  };
}

/** 伪 VisionJudgePort:按剧本逐轮出判定,耗尽后复读最后一轮;记录收到的 PNG。 */
function judgeStub(script: JudgeVerdict[]): VisionJudgePort & { seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  const queue = [...script];
  return {
    seen,
    judge: async (png: Uint8Array) => {
      seen.push(png);
      const next = queue.shift();
      if (next !== undefined) return next;
      return script.length > 0 ? script[script.length - 1]! : { pass: true, issues: [] };
    },
  };
}

const OK: JudgeVerdict = { pass: true, issues: [] };

// ---------------------------------------------------------------------------
// runVisualJudge 状态机
// ---------------------------------------------------------------------------

describe("runVisualJudge —— 核验自愈闭环", () => {
  test("一次过:首轮 pass,交付 passed 报告,issues 归零", async () => {
    let renders = 0;
    const judge = judgeStub([OK]);
    const report = await runVisualJudge({
      params: { fontSize: 12 },
      render: () => {
        renders += 1;
      },
      chartRef: "chart:main",
      capture: captureStub(),
      judge,
    });
    expect(renders).toBe(1);
    expect(report.status).toBe("passed");
    expect(report.rounds).toBe(1);
    expect(report.issues).toEqual([]);
    expect(report.verdict).not.toBeNull();
    expect(report.verdict?.pass).toBe(true);
  });

  test("一次过:history 单轮留痕,round 从 0 计", async () => {
    const report = await runVisualJudge({
      params: {},
      render: () => {},
      chartRef: "c",
      capture: captureStub(),
      judge: judgeStub([OK]),
    });
    expect(report.history).toHaveLength(1);
    expect(report.history[0]).toEqual({ round: 0, pass: true, issues: [] });
  });

  test("纠偏重跑后过:fail → retune → pass,交付纠偏后参数", async () => {
    const renders: string[] = [];
    const failRound = {
      pass: false,
      issues: [makeIssue("legend", "图例遮挡柱体", "图例移至顶部")],
    };
    const judge = judgeStub([failRound, OK]);
    const retuned: string[] = [];
    const report = await runVisualJudge<string>({
      params: "layout=default",
      render: (p) => {
        renders.push(p);
      },
      chartRef: "c",
      capture: captureStub(),
      judge,
      retune: (p, issues) => {
        retuned.push(issues[0]?.fixHint ?? "");
        return `${p}|legend=top`;
      },
    });
    expect(renders).toEqual(["layout=default", "layout=default|legend=top"]);
    expect(retuned).toEqual(["图例移至顶部"]);
    expect(report.status).toBe("passed");
    expect(report.rounds).toBe(2);
    expect(report.params).toBe("layout=default|legend=top");
    expect(report.issues).toEqual([]);
  });

  test("纠偏重跑:retune 收到首轮 issues 全量(type/detail/fixHint)", async () => {
    const issue = makeIssue("clip", "y 轴标签被裁", "扩大左侧留白");
    const judge = judgeStub([{ pass: false, issues: [issue] }, OK]);
    let seenIssues: readonly JudgeIssue[] = [];
    await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(),
      judge,
      retune: (_p, issues) => {
        seenIssues = issues;
        return _p;
      },
    });
    expect(seenIssues).toEqual([issue]);
  });

  test("retune 第三参 round 依次递增 0,1", async () => {
    const judge = judgeStub([
      { pass: false, issues: [makeIssue("overlap", "a", "b")] },
      { pass: false, issues: [makeIssue("overlap", "c", "d")] },
      OK,
    ]);
    const roundsSeen: number[] = [];
    await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(),
      judge,
      retune: (_p, _i, round) => {
        roundsSeen.push(round);
        return _p + 1;
      },
    });
    expect(roundsSeen).toEqual([0, 1]);
  });

  test("retune 未注入:原参数原样重跑(同对象引用)", async () => {
    const params = { a: 1 };
    let renderCount = 0;
    const judge = judgeStub([
      { pass: false, issues: [makeIssue("contrast", "浅色看不清", "加深")] },
      { pass: false, issues: [makeIssue("contrast", "仍看不清", "加深")] },
      OK,
    ]);
    const report = await runVisualJudge({
      params,
      render: () => {
        renderCount += 1;
      },
      chartRef: "c",
      capture: captureStub(),
      judge,
    });
    expect(renderCount).toBe(3);
    expect(report.status).toBe("passed");
    expect(report.params).toBe(params);
  });

  test("轮次超限升级:默认 maxRounds=2,连续 fail 三轮后 failed", async () => {
    let renders = 0;
    const fail = {
      pass: false,
      issues: [makeIssue("overlap", "标签始终重叠", "仍未解")] as JudgeIssue[],
    };
    const judge = judgeStub([fail]);
    const report = await runVisualJudge({
      params: 0,
      render: () => {
        renders += 1;
      },
      chartRef: "c",
      capture: captureStub(),
      judge,
    });
    expect(renders).toBe(3);
    expect(report.status).toBe("failed");
    expect(report.rounds).toBe(3);
    expect(report.history).toHaveLength(3);
  });

  test("超限升级:failed 报告携带终轮 issues,结构完整(type/detail/fixHint)", async () => {
    const issues = [
      makeIssue("clip", "右侧被裁 12px", "grid.right 调至 40"),
      makeIssue("contrast", "浅灰对白底 2.1:1", "前景加深至 #333"),
    ];
    const judge = judgeStub([{ pass: false, issues }]);
    const report = await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(),
      judge,
      retune: (p) => p,
    });
    expect(report.status).toBe("failed");
    expect(report.issues).toEqual(issues);
    for (const issue of report.issues) {
      expect(VISUAL_JUDGE_ISSUE_TYPES).toContain(issue.type);
      expect(typeof issue.detail).toBe("string");
      expect(issue.detail.length).toBeGreaterThan(0);
      expect(typeof issue.fixHint).toBe("string");
      expect(issue.fixHint.length).toBeGreaterThan(0);
    }
  });

  test("maxRounds=0:首轮 fail 立即升级,不重跑", async () => {
    let renders = 0;
    const judge = judgeStub([{ pass: false, issues: [makeIssue("clip", "x", "y")] }]);
    const report = await runVisualJudge({
      params: 0,
      render: () => {
        renders += 1;
      },
      chartRef: "c",
      capture: captureStub(),
      judge,
      maxRounds: 0,
    });
    expect(renders).toBe(1);
    expect(report.status).toBe("failed");
    expect(report.rounds).toBe(1);
  });

  test("maxRounds=1:重跑一次仍 fail 即升级(共 2 轮)", async () => {
    const judge = judgeStub([
      { pass: false, issues: [makeIssue("legend", "a", "b")] },
      { pass: false, issues: [makeIssue("legend", "a2", "b2")] },
    ]);
    const report = await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(),
      judge,
      maxRounds: 1,
    });
    expect(report.status).toBe("failed");
    expect(report.rounds).toBe(2);
    expect(report.issues[0]?.detail).toBe("a2");
  });

  test("maxRounds=1:重跑一次 pass 则交付", async () => {
    const judge = judgeStub([
      { pass: false, issues: [makeIssue("legend", "a", "b")] },
      OK,
    ]);
    const report = await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(),
      judge,
      maxRounds: 1,
    });
    expect(report.status).toBe("passed");
    expect(report.rounds).toBe(2);
  });

  test("DEFAULT_MAX_ROUNDS 常量为 2", () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(2);
  });

  test("maxRounds 非法值(负数)抛 RangeError", async () => {
    await expect(
      runVisualJudge({
        params: 0,
        render: () => {},
        chartRef: "c",
        capture: captureStub(),
        judge: judgeStub([OK]),
        maxRounds: -1,
      }),
    ).rejects.toThrow(RangeError);
  });

  test("judge 收到的 PNG 字节与 capture 产出一致", async () => {
    const judge = judgeStub([OK]);
    await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(PNG_BYTES),
      judge,
    });
    expect(judge.seen).toHaveLength(1);
    expect(Array.from(judge.seen[0]!)).toEqual(Array.from(PNG_BYTES));
  });

  test("chartRef 原样透传给 CapturePort", async () => {
    const capture = captureStub();
    await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "echarts:#main-sales",
      capture,
      judge: judgeStub([OK]),
    });
    expect(capture.calls).toEqual(["echarts:#main-sales"]);
  });
});

// ---------------------------------------------------------------------------
// 降级路径:capture null
// ---------------------------------------------------------------------------

describe("runVisualJudge —— capture 不可用降级", () => {
  test("capture 返回 null:status=capture_unavailable,judge 不被调用", async () => {
    const judge = judgeStub([OK]);
    const report = await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(null),
      judge,
    });
    expect(report.status).toBe("capture_unavailable");
    expect(judge.seen).toHaveLength(0);
    expect(report.verdict).toBeNull();
    expect(report.issues).toEqual([]);
  });

  test("降级不计入 rounds,history 为空,render 已执行一次", async () => {
    let renders = 0;
    const report = await runVisualJudge({
      params: 0,
      render: () => {
        renders += 1;
      },
      chartRef: "c",
      capture: captureStub(null),
      judge: judgeStub([OK]),
    });
    expect(renders).toBe(1);
    expect(report.rounds).toBe(0);
    expect(report.history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// issues 结构断言
// ---------------------------------------------------------------------------

describe("issues 结构断言", () => {
  test("四类 issue.type 全部合法并原样透传", async () => {
    const issues = [
      makeIssue("overlap", "标签重叠", "旋转 45°"),
      makeIssue("clip", "被裁", "加留白"),
      makeIssue("legend", "图例挡柱", "图例外置"),
      makeIssue("contrast", "对比度低", "加深前景"),
    ];
    const judge = judgeStub([{ pass: false, issues }]);
    const report = await runVisualJudge({
      params: 0,
      render: () => {},
      chartRef: "c",
      capture: captureStub(),
      judge,
      retune: (p) => p,
    });
    expect(report.status).toBe("failed");
    expect(report.issues.map((i) => i.type)).toEqual([
      "overlap",
      "clip",
      "legend",
      "contrast",
    ]);
  });

  test("issue.type 白名单恰为四型", () => {
    expect([...VISUAL_JUDGE_ISSUE_TYPES]).toEqual([
      "overlap",
      "clip",
      "legend",
      "contrast",
    ]);
  });
});

// ---------------------------------------------------------------------------
// isPng 与缺省命令端口
// ---------------------------------------------------------------------------

describe("isPng —— PNG 魔数判定", () => {
  test("命中魔数返回 true", () => {
    expect(isPng(PNG_BYTES)).toBe(true);
  });

  test("首字节即错返回 false", () => {
    const bytes = new Uint8Array([0x00, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(isPng(bytes)).toBe(false);
  });

  test("短于 8 字节返回 false", () => {
    expect(isPng(new Uint8Array([0x89, 0x50]))).toBe(false);
  });
});

describe("createCommandCapturePort —— 缺省外部命令端口", () => {
  test("未配置命令:capture 返回 null,不 spawn", async () => {
    const port = createCommandCapturePort();
    expect(await port.capture("c")).toBeNull();
    const port2 = createCommandCapturePort({ command: "" });
    expect(await port2.capture("c")).toBeNull();
  });

  test("命令成功产出 PNG:返回字节且通过魔数校验", async () => {
    const port = createCommandCapturePort({
      // printf 八进制转义写出 PNG 魔数(伪截图工具)
      command: "printf '\\211PNG\\r\\n\\032\\npayload' > {output}",
    });
    const bytes = await port.capture("chart:main");
    expect(bytes).not.toBeNull();
    expect(isPng(bytes!)).toBe(true);
  });

  test("命令非零退出:返回 null(不抛错)", async () => {
    const port = createCommandCapturePort({ command: "exit 3" });
    expect(await port.capture("c")).toBeNull();
  });

  test("产物缺 PNG 魔数:返回 null", async () => {
    const port = createCommandCapturePort({ command: "echo not-a-png > {output}" });
    expect(await port.capture("c")).toBeNull();
  });

  test("命令模板占位符替换:{input}/{output} 均被渲染", async () => {
    const port = createCommandCapturePort({
      // 把 chartRef 写进 PNG 头之后,借产物回读验证 {input} 已被替换
      command: 'printf \'\\211PNG\\r\\n\\032\\n%s\' "{input}" > {output}',
    });
    const bytes = await port.capture("ref-xyz");
    expect(bytes).not.toBeNull();
    const text = new TextDecoder().decode(bytes!);
    expect(text.slice(8)).toBe("ref-xyz");
  });
});
