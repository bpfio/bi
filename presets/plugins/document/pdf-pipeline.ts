/**
 * pdf-pipeline —— PDF → 页面图片切片 → 逐页视觉交叉审计(BI-18.3 / 卡 2)
 *
 * 切片:调 `pdftoppm -png -r 150`(密度/命令均可注入),产物按页码数值序返回。
 * 审计:把每页 PNG 交给注入的视觉判定端口,产出 per-page 审计报告数组,
 * 聚焦红头公文/印章位置/表格三类公文要素(aspects 记录在汇总报告)。
 *
 * 插件独立性(工单修订):视觉判定端口用**本地结构类型**(形状对齐
 * presets/plugins/visualize/visual-judge.ts 的 VisionJudgePort 合约,零 import 耦合)。
 * judge 未注入 → 逐页报告标注"visualize 插件不可用,跳过视觉审计"并照常返回
 * 切片结果(优雅降级,degraded=true)。
 */

import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultCommandRunner,
  isPdf,
  type CommandRunner,
  type ProcessResult,
} from "./office-converter.ts";

// ---------------------------------------------------------------------------
// 本地结构类型:与 visualize 插件 VisionJudgePort 合约形状对齐(禁止跨插件 import)
// ---------------------------------------------------------------------------

export interface DocumentAuditIssue {
  type: "overlap" | "clip" | "legend" | "contrast";
  detail: string;
  fixHint: string;
}

/** 视觉判定端口(结构等价 VisionJudgeLike):宿主把 visualize 插件的判庭装配进来。 */
export interface VisionJudgeLike {
  judge(png: Uint8Array): Promise<{ pass: boolean; issues: DocumentAuditIssue[] }>;
}

/** 公文审计聚焦要素。 */
export const DOCUMENT_AUDIT_ASPECTS = ["redhead", "seal", "table"] as const;
export type DocumentAuditAspect = (typeof DOCUMENT_AUDIT_ASPECTS)[number];

export const SKIP_AUDIT_NOTE = "visualize 插件不可用,跳过视觉审计";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPngBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 切片:pdftoppm
// ---------------------------------------------------------------------------

export interface SlicePdfOptions {
  /** 渲染密度(dpi),缺省 150,对应 pdftoppm -r 150。 */
  density?: number;
  /** 产物文件名前缀,缺省 "page"(产出 page-1.png …)。 */
  pagePrefix?: string;
  runner?: CommandRunner;
  /** 命令模板注入:整体替换 pdftoppm 缺省命令。 */
  buildCommand?: (
    pdfPath: string,
    outputDir: string,
    density: number,
    prefix: string,
  ) => string[];
}

export type SliceErrorCode =
  | "bad_input"
  | "spawn_failed"
  | "nonzero_exit"
  | "missing_output";

export interface SlicePdfError {
  code: SliceErrorCode;
  message: string;
  exitCode?: number;
  stderr?: string;
}

export interface SlicePdfResult {
  ok: boolean;
  /** 页面图片绝对路径,按页码数值升序。 */
  pages: string[];
  command: string[];
  error?: SlicePdfError;
}

/** 缺省命令模板:pdftoppm -png -r <density> <pdf> <outdir>/<prefix> */
export function buildPdftoppmCommand(
  pdfPath: string,
  outputDir: string,
  density: number,
  prefix: string,
): string[] {
  return ["pdftoppm", "-png", "-r", String(density), pdfPath, join(outputDir, prefix)];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * PDF → 页面 PNG 切片。
 * 输入校验 %PDF- 魔数;失败返回结构化错误,不抛异常。
 */
export async function slicePdfToPageImages(
  pdfPath: string,
  outputDir: string,
  options: SlicePdfOptions = {},
): Promise<SlicePdfResult> {
  const density = options.density ?? 150;
  const prefix = options.pagePrefix ?? "page";
  const command =
    options.buildCommand?.(pdfPath, outputDir, density, prefix) ??
    buildPdftoppmCommand(pdfPath, outputDir, density, prefix);
  const runner = options.runner ?? defaultCommandRunner;
  const fail = (error: SlicePdfError): SlicePdfResult => ({
    ok: false,
    pages: [],
    command,
    error,
  });

  // 输入校验:存在 + %PDF- 魔数
  try {
    const st = await stat(pdfPath);
    if (!st.isFile()) {
      return fail({ code: "bad_input", message: `输入不是常规文件: ${pdfPath}` });
    }
    const head = new Uint8Array(await readFile(pdfPath));
    if (!isPdf(head)) {
      return fail({ code: "bad_input", message: `输入缺 %PDF- 魔数,不是 PDF: ${pdfPath}` });
    }
  } catch {
    return fail({ code: "bad_input", message: `输入文件不存在: ${pdfPath}` });
  }

  try {
    await mkdir(outputDir, { recursive: true });
  } catch (e) {
    return fail({ code: "spawn_failed", message: `输出目录创建失败: ${String(e)}` });
  }

  let result: ProcessResult;
  try {
    result = await runner(command);
  } catch (e) {
    return fail({ code: "spawn_failed", message: `切片命令未能启动: ${String(e)}` });
  }
  if (result.exitCode !== 0) {
    return fail({
      code: "nonzero_exit",
      message: `切片命令非零退出(${result.exitCode})`,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  // 产物收集:prefix-<页码>.png,按页码数值升序(容忍 pdftoppm 的 01/001 补零)
  const pattern = new RegExp(`^${escapeRegex(prefix)}-(\\d+)\\.png$`);
  const entries = await readdir(outputDir);
  const pages: { n: number; path: string }[] = [];
  for (const name of entries) {
    const m = pattern.exec(name);
    if (m !== null) {
      pages.push({ n: Number.parseInt(m[1] ?? "0", 10), path: join(outputDir, name) });
    }
  }
  pages.sort((a, b) => a.n - b.n);
  if (pages.length === 0) {
    return fail({
      code: "missing_output",
      message: `切片产物不存在(在 ${outputDir} 下未找到 ${prefix}-*.png)`,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return { ok: true, pages: pages.map((p) => p.path), command };
}

// ---------------------------------------------------------------------------
// 逐页审计:红头公文 / 印章位置 / 表格
// ---------------------------------------------------------------------------

export interface PageAuditReport {
  /** 页码,从 1 计。 */
  page: number;
  /** 页面图片路径。 */
  image: string;
  /** 是否真正执行了视觉审计(降级页为 false)。 */
  audited: boolean;
  /** 审计结论;null 表示未审计(降级/产物异常)。 */
  pass: boolean | null;
  issues: DocumentAuditIssue[];
  /** 备注(降级说明等)。 */
  note?: string;
}

export interface PdfAuditSummary {
  ok: boolean;
  totalPages: number;
  auditedPages: number;
  failedPages: number;
  /** true = 未注入 judge,整体跳过视觉审计(切片照常交付)。 */
  degraded: boolean;
  /** 本次审计聚焦的公文要素。 */
  aspects: readonly DocumentAuditAspect[];
  pages: PageAuditReport[];
  /** 切片失败时的结构化错误;此时 pages 为空数组。 */
  sliceError?: SlicePdfError;
  command: string[];
}

export interface AuditPdfOptions extends SlicePdfOptions {
  /**
   * 视觉判定端口(结构等价 visualize 插件的 VisionJudgePort)。
   * 缺省(未提供)→ 优雅降级:跳过逐页审计,报告标注 SKIP_AUDIT_NOTE。
   */
  judge?: VisionJudgeLike;
  /** 审计聚焦要素,缺省红头/印章/表格三类。 */
  aspects?: readonly DocumentAuditAspect[];
}

/**
 * 切片 + 逐页审计回路:每页 PNG 依次交给 judge,聚合 per-page 审计报告数组。
 * 切片失败 → 汇总 ok=false 并携带 sliceError;审计失败页计入 failedPages。
 */
export async function auditPdfPages(
  pdfPath: string,
  outputDir: string,
  options: AuditPdfOptions = {},
): Promise<PdfAuditSummary> {
  const aspects = options.aspects ?? DOCUMENT_AUDIT_ASPECTS;
  const slice = await slicePdfToPageImages(pdfPath, outputDir, options);
  if (!slice.ok) {
    return {
      ok: false,
      totalPages: 0,
      auditedPages: 0,
      failedPages: 0,
      degraded: options.judge === undefined,
      aspects,
      pages: [],
      sliceError: slice.error,
      command: slice.command,
    };
  }

  const judge = options.judge;
  const pages: PageAuditReport[] = [];
  let pageNumber = 0;
  for (const image of slice.pages) {
    pageNumber += 1;
    if (judge === undefined) {
      pages.push({
        page: pageNumber,
        image,
        audited: false,
        pass: null,
        issues: [],
        note: SKIP_AUDIT_NOTE,
      });
      continue;
    }
    const png = new Uint8Array(await readFile(image));
    if (!isPngBytes(png)) {
      pages.push({
        page: pageNumber,
        image,
        audited: false,
        pass: null,
        issues: [],
        note: "切片产物不是有效 PNG,无法审计",
      });
      continue;
    }
    const verdict = await judge.judge(png);
    pages.push({
      page: pageNumber,
      image,
      audited: true,
      pass: verdict.pass,
      issues: verdict.issues,
    });
  }

  const failedPages = pages.filter((p) => p.pass === false).length;
  const auditedPages = pages.filter((p) => p.audited).length;
  return {
    ok: failedPages === 0,
    totalPages: pages.length,
    auditedPages,
    failedPages,
    degraded: judge === undefined,
    aspects,
    pages,
    command: slice.command,
  };
}
