/**
 * BI-08 · 单次工具输出 64KB 有界截断（boundToolText）——纯函数 + 可选落盘接缝。
 *
 * 两级预算（"行优先、字符兜底"，工单钉死）：
 *   1. 行级预算（主）：超限时按 \n 分行，保留头 200 行 + 尾 200 行，中间整体
 *      替换为一行标记 `[... output truncated: N chars / M lines omitted ...]`。
 *      行级保留对"大量短行"的输出最友好：头尾语义完整、行列号仍可对照原始输出。
 *   2. 字符级兜底（防 200 条超长行撑爆）：若头/尾各自侧的字符量超过其份额
 *      （(maxChars − 标记行上界 − 分隔符) 对半分），则对该侧**从内侧**按
 *      Unicode 码点边界二次收紧——整行放得下就整行保留；只放得下一部分就
 *      截该行（头侧取前缀、尾侧取后缀），被截的边界行仍计为 1 条保留行
 *      （有内容可见）。码点边界保证多字节字符（中文/emoji 代理对）绝不截半。
 *
 * 尾侧空侧的预算归属（F-EV-05 钉死）：行级切分后尾侧为空（行数 ≤ HEAD_LINES，
 * 如单行长文本）时，**尾侧字符预算整段并入头侧**（头侧拿满 available），
 * 不做对半分——否则单行 200KB 在 65536 上限下只留半预算（约 32K），
 * 白扔另一半预算。头尾都有行时维持对半分语义不变。
 *
 * 计数语义（钉死）：
 * - 一切 char 计数按 Unicode 码点（非 UTF-16 code unit）；一切行以 \n 分割
 *   （split("\n") 原义，尾部 \n 会产生最后一条空行，计入 originalLines）。
 * - originalChars ≤ maxChars → 原样返回 { bounded: false, text }（恰好等于
 *   上限**不截**；空串、纯空白同理走不截路径）。
 * - omittedChars = originalChars − 头侧实际保留码点数 − 尾侧实际保留码点数
 *   （头尾保留区是原始输出的逐字子串；标记行与两侧拼接用的 "\n" 是新增字符，
 *   不计入 kept，也不从 omitted 中扣除）。
 * - 被截断时标记行必在；M 可为 0（行全保留、仅字符被兜底收紧的情形）。
 *
 * 落盘接缝（BI-08.1 spill 卡的预留位）：
 * - 默认落盘器：写 options.logDir 下 `<sha1 前12 hex>-<Date.now()>.txt`，
 *   目录不存在自动递归创建；logDir 未配置 → 跳过落盘，fullOutputPath 为
 *   undefined。**fullOutputPath 的契约是"要么真实路径要么 undefined"，绝不
 *   假造**：因此落盘失败向上抛错（不静默吞成 undefined），上层若要 best-
 *   effort 语义可经 fullOutputLog 注入自己的容错 writer。
 * - 注入 fullOutputLog 时完全接管落盘（logDir 被忽略），返回值（string 路径
 *   或 undefined）原样成为 fullOutputPath。仅 bounded 分支才会调用落盘器。
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 默认上限：64,000 码点（工单钉死；十进制 64KB 语义，按字符而非字节）。 */
export const DEFAULT_MAX_CHARS = 64_000;

/** 行级预算：头/尾各保留 200 行（工单钉死）。 */
const HEAD_LINES = 200;
const TAIL_LINES = 200;

/** 落盘器：接收完整原始输出，返回落盘路径；返回 undefined 表示放弃落盘。 */
export type FullOutputWriter = (output: string) => string | undefined;

/** boundToolText 选项。 */
export interface BoundToolTextOptions {
  /** 字符上限（Unicode 码点），默认 64,000；非有限数或 < 1 抛 RangeError。 */
  readonly maxChars?: number;
  /** 默认落盘目录；未配置则跳过落盘（fullOutputPath 为 undefined）。 */
  readonly logDir?: string;
  /** 注入落盘器（完全接管默认落盘，logDir 被忽略）。 */
  readonly fullOutputLog?: FullOutputWriter;
}

/** 未超限：原样返回。 */
export interface UnboundedToolTextResult {
  readonly bounded: false;
  readonly text: string;
}

/** 已截断：文本 + 元数据（fullOutputPath 仅在落盘发生时存在）。 */
export interface BoundedToolTextResult {
  readonly bounded: true;
  readonly text: string;
  /** 原始输出码点数。 */
  readonly originalChars: number;
  /** 原始输出行数（split("\n") 语义）。 */
  readonly originalLines: number;
  /** 头侧保留行数（边界行被码点截断时仍计 1 行）。 */
  readonly keptHeadLines: number;
  /** 尾侧保留行数（同上）。 */
  readonly keptTailLines: number;
  /** 被省略的码点数 = originalChars − 头尾实际保留码点数。 */
  readonly omittedChars: number;
  /** 完整输出落盘路径（未落盘时缺省）。 */
  readonly fullOutputPath?: string;
}

/** boundToolText 结果：按 bounded 判别。 */
export type BoundedResult = UnboundedToolTextResult | BoundedToolTextResult;

/** 单侧收紧结果。 */
interface SideTrim {
  /** 该侧保留文本（原始输出的逐字子串，内部以 \n 连接）。 */
  text: string;
  /** 保留行数（部分截断的边界行计 1）。 */
  keptLines: number;
  /** 保留码点数（含行内 \n 与部分行内容）。 */
  chars: number;
}

/**
 * 统计 Unicode 码点数（非 UTF-16 code unit）。
 * 合法代理对计 1，孤立代理项计 1（与 for-of 迭代语义一致）。
 */
function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; ) {
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff;
    i += isPair ? 2 : 1;
    n++;
  }
  return n;
}

/**
 * 取字符串前 maxCodePoints 个码点（前缀），截断点必落在码点边界：
 * 预算耗尽处若正好是代理对中段，则整个代理对一起舍弃（绝不截半）。
 */
function takeCodePoints(s: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  let counted = 0;
  let i = 0;
  while (i < s.length) {
    if (counted + 1 > maxCodePoints) break;
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff;
    counted++;
    i += isPair ? 2 : 1;
  }
  return s.slice(0, i);
}

/**
 * 取字符串后 maxCodePoints 个码点（后缀），截断点必落在码点边界。
 * 实现转为"正向跳过 total − max 个完整码点后切片"，跳过时整对代理同进退。
 */
function takeLastCodePoints(s: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return "";
  const total = codePointLength(s);
  if (total <= maxCodePoints) return s;
  const skip = total - maxCodePoints;
  let counted = 0;
  let i = 0;
  while (counted < skip && i < s.length) {
    const code = s.charCodeAt(i);
    const isPair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < s.length &&
      s.charCodeAt(i + 1) >= 0xdc00 &&
      s.charCodeAt(i + 1) <= 0xdfff;
    i += isPair ? 2 : 1;
    counted++;
  }
  return s.slice(i);
}

/** 头侧收紧：从头开始逐行装入，超预算处整行丢弃或按码点截该行前缀。 */
function keepHeadLines(lines: readonly string[], budget: number): SideTrim {
  if (budget <= 0) return { text: "", keptLines: 0, chars: 0 };
  let chars = 0;
  const parts: string[] = [];
  for (const line of lines) {
    const sep = parts.length > 0 ? 1 : 0;
    const lineCp = codePointLength(line);
    if (chars + sep + lineCp <= budget) {
      parts.push(line);
      chars += sep + lineCp;
    } else {
      const remaining = budget - chars - sep;
      if (remaining > 0) {
        const partial = takeCodePoints(line, remaining);
        parts.push(partial);
        chars += sep + codePointLength(partial);
      }
      break;
    }
  }
  return { text: parts.join("\n"), keptLines: parts.length, chars };
}

/** 尾侧收紧：从尾向前逐行装入，超预算处整行丢弃或按码点截该行后缀。 */
function keepTailLines(lines: readonly string[], budget: number): SideTrim {
  if (budget <= 0) return { text: "", keptLines: 0, chars: 0 };
  let chars = 0;
  const parts: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    const sep = parts.length > 0 ? 1 : 0;
    const lineCp = codePointLength(line);
    if (chars + sep + lineCp <= budget) {
      parts.push(line);
      chars += sep + lineCp;
    } else {
      const remaining = budget - chars - sep;
      if (remaining > 0) {
        const partial = takeLastCodePoints(line, remaining);
        parts.push(partial);
        chars += sep + codePointLength(partial);
      }
      break;
    }
  }
  parts.reverse();
  return { text: parts.join("\n"), keptLines: parts.length, chars };
}

/** 截断标记行（工单钉死格式）。 */
function formatMarker(omittedChars: number, omittedLines: number): string {
  return `[... output truncated: ${omittedChars} chars / ${omittedLines} lines omitted ...]`;
}

/** 默认落盘器工厂：写 logDir 下 `<sha1 前12>-<ts>.txt`，目录自动递归创建。 */
function makeDefaultFullOutputWriter(logDir: string): FullOutputWriter {
  return (output: string) => {
    const hash = createHash("sha1").update(output, "utf8").digest("hex").slice(0, 12);
    const name = `${hash}-${Date.now()}.txt`;
    mkdirSync(logDir, { recursive: true });
    const fullPath = join(logDir, name);
    writeFileSync(fullPath, output, "utf8");
    return fullPath;
  };
}

/**
 * 单次工具输出有界截断。见文件头注释（两级预算 / 计数语义 / 落盘接缝）。
 *
 * @throws RangeError 当 maxChars 非有限数或 < 1（配置错误当场暴露，不留隐患）。
 */
export function boundToolText(output: string, options: BoundToolTextOptions = {}): BoundedResult {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars < 1) {
    throw new RangeError(`maxChars must be a finite integer >= 1, got ${String(maxChars)}`);
  }

  const totalChars = codePointLength(output);
  if (totalChars <= maxChars) {
    // 恰好等于上限不截；空串 / 纯空白同理原样返回。
    return { bounded: false, text: output };
  }

  // ── 第一级：行预算（头 200 + 尾 200，不足则全归头侧、尾侧为空）──────
  const lines = output.split("\n");
  const totalLines = lines.length;
  const headCount = Math.min(HEAD_LINES, totalLines);
  const tailCount = Math.min(TAIL_LINES, totalLines - headCount);
  const headSlice = lines.slice(0, headCount);
  const tailSlice = tailCount > 0 ? lines.slice(totalLines - tailCount) : [];

  // ── 第二级：字符兜底预算 ─────────────────────────────────────────
  // 标记行长度上界：用 N=totalChars、M=totalLines 格式化（实际 N/M ≤ 上界值，
  // 十进制位数只少不多，故实际标记行长度 ≤ markerLenMax，预算不会被打穿）。
  const markerLenMax = formatMarker(totalChars, totalLines).length;
  // 拼接分隔符：头侧与标记之间 1 个 \n；尾侧非空时标记与尾侧之间再 1 个。
  const separators = tailCount > 0 ? 2 : 1;
  const available = maxChars - markerLenMax - separators;
  // 对半分：头侧取整半，尾侧拿余量；可用预算为负（标记行本身超上限的极端
  // 配置）时钳到 0，此时结果只含标记行，允许略超 maxChars（退化配置，仅当
  // 调用方显式传入极小 maxChars 才可能发生）。
  // 尾侧为空（行数 ≤ HEAD_LINES，单行长文本）时：尾侧预算整段并入头侧，
  // 头侧拿满 available（保足 maxChars），不做对半分（F-EV-05）。
  const headBudget =
    tailCount > 0 ? Math.max(0, Math.floor(available / 2)) : Math.max(0, available);
  const tailBudget = Math.max(0, available - headBudget);

  const head = keepHeadLines(headSlice, headBudget);
  const tail = keepTailLines(tailSlice, tailBudget);

  // 省略行数必须按**最终可见行数**回算：字符兜底收紧可能把边界之外的整行
  // 全部丢掉（如"行少字多"场景头侧 200 行只装下 107 行），此时行级切片看似
  // 零省略、实际中间整段不可见——M 按 totalLines − 头尾实保留行数计才诚实。
  const omittedLines = totalLines - head.keptLines - tail.keptLines;
  const omittedChars = totalChars - head.chars - tail.chars;
  const marker = formatMarker(omittedChars, omittedLines);

  const pieces: string[] = [];
  if (head.text !== "") pieces.push(head.text);
  pieces.push(marker);
  if (tail.text !== "") pieces.push(tail.text);
  const text = pieces.join("\n");

  // ── 落盘接缝：仅 bounded 分支落盘；失败上抛，不假造 undefined ──────
  let fullOutputPath: string | undefined;
  if (options.fullOutputLog) {
    fullOutputPath = options.fullOutputLog(output);
  } else if (options.logDir !== undefined) {
    fullOutputPath = makeDefaultFullOutputWriter(options.logDir)(output);
  }

  const result: BoundedToolTextResult = {
    bounded: true,
    text,
    originalChars: totalChars,
    originalLines: totalLines,
    keptHeadLines: head.keptLines,
    keptTailLines: tail.keptLines,
    omittedChars,
  };
  if (fullOutputPath !== undefined) {
    return { ...result, fullOutputPath };
  }
  return result;
}
