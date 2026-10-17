/**
 * visual-judge —— 研报图表视觉核验自愈闭环(BI-18.2 / 卡 1 合约基准)
 *
 * 定位:对 ECharts/SVG/HTML 渲染产物做"截图 → 视觉判定 → 纠偏重跑"的闭环核验。
 * 设计铁律:端口化。本模块不绑定任何截图工具与视觉模型,外部能力全部走端口注入:
 *   - CapturePort    :图表 → PNG 字节;不可用返回 null(降级,不计核验失败)。
 *   - VisionJudgePort:PNG → { pass, issues };issues 四型:overlap/clip/legend/contrast。
 *
 * 状态机:render → capture → judge
 *   ├─ pass          → 交付(passed 报告)
 *   ├─ fail 且未超限 → 按 fixHint 纠偏参数(retune)→ 重跑
 *   └─ fail 且超限   → 升级:返回带 issues 的 failed 报告
 * 纠偏重跑轮次上限可配(maxRounds,缺省 2,即最多渲染 1 + 2 次)。
 * 全部端口可注入;本文件不含任何具体视觉模型依赖。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 合约类型(卡 2 pdf-pipeline 等下游直接 import 本节,禁止复制粘贴)
// ---------------------------------------------------------------------------

/** 视觉问题四型:重叠 / 截断(含穿模出界) / 图例遮挡 / 对比度不足。 */
export const VISUAL_JUDGE_ISSUE_TYPES = [
  "overlap",
  "clip",
  "legend",
  "contrast",
] as const;

export type JudgeIssueType = (typeof VISUAL_JUDGE_ISSUE_TYPES)[number];

/** 单条视觉问题:type 归类 + detail 现象描述 + fixHint 纠偏方向(供 retune 消费)。 */
export interface JudgeIssue {
  type: JudgeIssueType;
  detail: string;
  fixHint: string;
}

/** 视觉判定结论。pass=true 时 issues 应为空数组。 */
export interface JudgeVerdict {
  pass: boolean;
  issues: JudgeIssue[];
}

/** 图表 → PNG 字节。返回 null 表示当前环境无法截图(降级路径,不算核验失败)。 */
export interface CapturePort {
  capture(chartRef: string): Promise<Uint8Array | null>;
}

/** PNG → 视觉判定。注入点:可接多模态模型、启发式像素检查或测试伪端口。 */
export interface VisionJudgePort {
  judge(png: Uint8Array): Promise<JudgeVerdict>;
}

/** 单轮判定留痕:round 从 0 计(0 = 首轮渲染,无纠偏)。 */
export interface JudgeRoundRecord {
  round: number;
  pass: boolean;
  issues: JudgeIssue[];
}

export type VisualJudgeStatus = "passed" | "failed" | "capture_unavailable";

export interface VisualJudgeReport {
  status: VisualJudgeStatus;
  /** 实际执行的 judge 轮数;capture_unavailable 时不完整,故以 history 为准。 */
  rounds: number;
  /** 终态参数:passed 时为通过参数;failed 时为最后一次纠偏后的参数。 */
  params: unknown;
  /** 终轮判定;capture_unavailable 降级时为 null。 */
  verdict: JudgeVerdict | null;
  /** 终态 issues:passed 恒为空数组;failed 携带终轮 issues 供升级处置。 */
  issues: JudgeIssue[];
  history: JudgeRoundRecord[];
}

/**
 * 纠偏函数:按 fixHint 调整渲染参数后返回新参数。
 * 实现应当纯(不落副作用),否则重跑不可复现。
 */
export type RetuneFn<P> = (
  params: P,
  issues: readonly JudgeIssue[],
  round: number,
) => P;

export interface VisualJudgeOptions<P> {
  /** 初始渲染参数。 */
  params: P;
  /** 渲染动作:把 params 渲染为可供 capture 的图表产物(ECharts/SVG/HTML)。 */
  render(params: P): Promise<void> | void;
  /** 图表引用(ECharts 容器选择器 / HTML 路径 / SVG id),原样透传给 CapturePort。 */
  chartRef: string;
  capture: CapturePort;
  judge: VisionJudgePort;
  /** 纠偏函数;缺省为恒等(原参数重跑)。 */
  retune?: RetuneFn<P>;
  /** 纠偏重跑轮次上限,缺省 2。0 表示禁止重跑,首轮 fail 即升级。 */
  maxRounds?: number;
}

export const DEFAULT_MAX_ROUNDS = 2;

// ---------------------------------------------------------------------------
// 核验状态机
// ---------------------------------------------------------------------------

/**
 * 核验自愈闭环。
 *
 * 轮次语义:maxRounds 限制的是"纠偏重跑"次数,总渲染次数上限为 maxRounds + 1。
 * 例:maxRounds=2 时最多 render 三次(首轮 + 两轮纠偏),三轮皆 fail 才升级 failed。
 *
 * 错误传播:render / judge 抛错原样上抛(端口契约内不可用应返回 null / fail,
 * 抛错属于端口自身 bug,不吞);capture 抛错同理——缺省命令端口已把一切失败归一为 null。
 */
export async function runVisualJudge<P>(
  options: VisualJudgeOptions<P>,
): Promise<VisualJudgeReport> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 0) {
    throw new RangeError(`maxRounds 必须为非负整数,收到 ${String(maxRounds)}`);
  }
  const retune: RetuneFn<P> = options.retune ?? ((params) => params);

  let params = options.params;
  const history: JudgeRoundRecord[] = [];
  let round = 0;

  for (;;) {
    await options.render(params);

    const png = await options.capture.capture(options.chartRef);
    if (png === null) {
      // 降级:截图通道不可用,无法核验;不算 pass 也不算 fail,交由上游决定人工介入。
      return {
        status: "capture_unavailable",
        rounds: round,
        params,
        verdict: null,
        issues: [],
        history,
      };
    }

    const verdict = await options.judge.judge(png);
    history.push({ round, pass: verdict.pass, issues: verdict.issues });

    if (verdict.pass) {
      return {
        status: "passed",
        rounds: round + 1,
        params,
        verdict,
        issues: [],
        history,
      };
    }

    if (round >= maxRounds) {
      // 超限升级:终轮 issues 原样带出,供人工或上游管线处置。
      return {
        status: "failed",
        rounds: round + 1,
        params,
        verdict,
        issues: [...verdict.issues],
        history,
      };
    }

    params = retune(params, verdict.issues, round);
    round += 1;
  }
}

// ---------------------------------------------------------------------------
// 缺省 CapturePort:外部命令截图(可配置,不可用降级 null)
// ---------------------------------------------------------------------------

export const PNG_MAGIC_LENGTH = 8;

/** PNG 魔数判定:\x89PNG\r\n\x1a\n */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC_LENGTH) return false;
  const head = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ];
  for (let i = 0; i < PNG_MAGIC_LENGTH; i++) {
    if (bytes[i] !== head[i]) return false;
  }
  return true;
}

export interface CommandCaptureConfig {
  /**
   * 截图命令模板(shell 单串)。占位符:{input} → chartRef,{output} → 临时 PNG 落盘路径。
   * 例:"shotctl render --chart {input} --out {output}"
   * 未配置(undefined/空串)→ capture 直接返回 null,不 spawn 任何进程。
   */
  command?: string;
  /** 命令超时毫秒,缺省 30_000。 */
  timeoutMs?: number;
}

/**
 * 缺省 CapturePort 工厂:调可配置外部命令截图。
 * 命令未配置、非零退出、超时、产物缺魔数——一律返回 null(降级,不抛错)。
 */
export function createCommandCapturePort(
  config: CommandCaptureConfig = {},
): CapturePort {
  return {
    async capture(chartRef: string): Promise<Uint8Array | null> {
      const command = config.command;
      if (!command) return null;
      let dir: string | null = null;
      try {
        dir = await mkdtemp(join(tmpdir(), "visual-judge-"));
        const output = join(dir, "chart.png");
        const rendered = command
          .replaceAll("{input}", chartRef)
          .replaceAll("{output}", output);
        const proc = Bun.spawn(["/bin/sh", "-c", rendered], {
          stdout: "pipe",
          stderr: "pipe",
          timeout: config.timeoutMs ?? 30_000,
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) return null;
        const bytes = new Uint8Array(await readFile(output));
        if (!isPng(bytes)) return null;
        return bytes;
      } catch {
        return null;
      } finally {
        if (dir !== null) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    },
  };
}
