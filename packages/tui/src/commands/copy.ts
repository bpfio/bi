/**
 * /copy —— 上一轮 Assistant 最终回答回写系统剪贴板。
 *
 * BI-19.4 合约（未读取 /home/yupeng/references/ 下任何源码；设计依据本工单）：
 * - 输入：上一轮 Assistant 最终回答文本（可缺失 / 为空 / 纯空白）；
 * - 格式化（formatForClipboard，保留代码块）：
 *     1) CRLF / 孤立 CR 归一为 LF；
 *     2) 裁掉首尾空行（正文区）；
 *     3) 正文区连续 ≥3 空行折叠为 2 行；
 *     4) 围栏代码块（``` … ```，容忍 ≤3 空格缩进）内部逐字节保留——
 *        空行折叠与空白处理一律不进入代码块；未闭合围栏视为块内，保守保全。
 * - 写回：deps.write（通常 bind clipboard-text 的 writeClipboardText；测试注入 spy /
 *   伪执行器）；write 返回 false 或抛错均为失败路径；
 * - 返回结果摘要字符串（成功 / 空输入 / 写失败三种文案，测试逐字断言前缀）：
 *     成功   → `/copy：已复制 N 字符、M 行到系统剪贴板`
 *     空输入 → `/copy：没有可复制的内容（上一轮回答为空）`
 *     写失败 → `/copy：写入系统剪贴板失败（…）`
 */

/** /copy 命令名。 */
export const COPY_COMMAND_NAME = "copy";

/** 空输入错误文案（无内容可复制）。 */
export const COPY_EMPTY_MESSAGE = "/copy：没有可复制的内容（上一轮回答为空）";

/** 写失败错误文案前缀（布尔失败路径）。 */
export const COPY_WRITE_FAILED_MESSAGE =
  "/copy：写入系统剪贴板失败（请检查 pbcopy / xclip / wl-copy / powershell 剪贴板命令是否可用）";

/** 剪贴板写入器（通常 bind clipboard-text 的 writeClipboardText；测试注入 spy）。 */
export type CopyWriter = (text: string) => Promise<boolean>;

export interface CopyCommandDeps {
  /** 剪贴板写入执行。 */
  readonly write: CopyWriter;
}

/**
 * 复制前格式化：CRLF/CR → LF；裁首尾空行；正文区 ≥3 连续空行折叠为 2；
 * 围栏代码块内部逐字节保留（不折叠空行、不触碰空白）。
 */
export function formatForClipboard(text: string): string {
  const lf = text.replace(/\r\n?/g, "\n");
  const lines = lf.split("\n");
  const out: string[] = [];
  let inFence = false;
  let blankRun = 0;
  const flushBlanks = (): void => {
    if (out.length === 0) {
      blankRun = 0; // 首部空行直接裁掉
      return;
    }
    const keep = Math.min(blankRun, 2);
    for (let i = 0; i < keep; i++) out.push("");
    blankRun = 0;
  };
  for (const line of lines) {
    const isFenceMark = line.trimStart().startsWith("```");
    if (inFence) {
      if (isFenceMark) inFence = false; // 闭合围栏（容忍缩进）
      out.push(line); // 块内逐字节保留
      continue;
    }
    if (isFenceMark) {
      flushBlanks(); // 围栏开行前的正文区空行照常折叠/裁剪
      inFence = true;
      out.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      blankRun += 1;
      continue;
    }
    flushBlanks();
    out.push(line);
  }
  // 末尾空行不输出（= 裁掉尾部空行）
  return out.join("\n");
}

/**
 * /copy 主流程：输入上一轮 Assistant 最终回答文本 → 格式化（保留代码块）→
 * 写系统剪贴板 → 返回结果摘要字符串。
 */
export async function runCopyCommand(
  lastAssistantText: string | null | undefined,
  deps: CopyCommandDeps,
): Promise<string> {
  if (
    lastAssistantText === null ||
    lastAssistantText === undefined ||
    lastAssistantText.trim().length === 0
  ) {
    return COPY_EMPTY_MESSAGE;
  }
  const formatted = formatForClipboard(lastAssistantText);
  let ok: boolean;
  try {
    ok = await deps.write(formatted);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return `/copy：写入系统剪贴板失败（${reason}）`;
  }
  if (!ok) {
    return COPY_WRITE_FAILED_MESSAGE;
  }
  const chars = formatted.length;
  const lineCount = formatted.split("\n").length;
  return `/copy：已复制 ${chars} 字符、${lineCount} 行到系统剪贴板`;
}
