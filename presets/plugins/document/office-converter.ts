/**
 * office-converter —— .docx/.pptx → PDF 转换(BI-18.3 / 卡 2)
 *
 * 设计:runner 可注入。缺省实现用 Bun.spawn 调外部命令
 * (`soffice --headless --convert-to pdf`,命令模板可整体替换);
 * 产物校验 PDF 魔数(%PDF- 头);一切失败返回结构化错误,不抛异常。
 * 测试注入伪 runner,无需安装 LibreOffice。
 */

import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export const OFFICE_INPUT_EXTENSIONS = [".docx", ".pptx"] as const;

/** 进程执行结果(runner 合约的最小面)。 */
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 命令执行端口:可注入伪 runner,测试不装 LibreOffice。 */
export type CommandRunner = (command: string[]) => Promise<ProcessResult>;

/** 缺省 runner:Bun.spawn 捕获 stdout/stderr,等待退出码。 */
export const defaultCommandRunner: CommandRunner = async (command) => {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export type OfficeErrorCode =
  | "bad_input"
  | "spawn_failed"
  | "nonzero_exit"
  | "missing_output"
  | "invalid_pdf";

export interface OfficeConvertError {
  code: OfficeErrorCode;
  message: string;
  /** 本次尝试的完整命令,便于人工复核。 */
  command?: string[];
  exitCode?: number;
  stderr?: string;
}

export type OfficeConvertResult =
  | { ok: true; pdfPath: string; bytes: number; command: string[] }
  | { ok: false; error: OfficeConvertError };

export interface OfficeConvertOptions {
  /** 输出目录(缺省不建则自动递归创建)。 */
  outputDir: string;
  /** 命令执行端口;缺省 Bun.spawn。 */
  runner?: CommandRunner;
  /** 命令模板注入:整体替换 soffice 缺省命令。 */
  commandTemplate?: (inputPath: string, outputDir: string) => string[];
  /** 产物路径覆写:自定义命令模板的产物名不规则时显式指明。 */
  expectedPdfPath?: string;
}

/** 缺省命令模板:soffice 无头转 PDF。 */
export function buildSofficeCommand(
  inputPath: string,
  outputDir: string,
): string[] {
  return [
    "soffice",
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    outputDir,
    inputPath,
  ];
}

/** PDF 魔数判定:文件头 5 字节为 "%PDF-"。 */
export function isPdf(bytes: Uint8Array): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/**
 * .docx/.pptx → PDF。
 * 全失败路径返回 { ok:false, error },不抛异常;
 * 只有 options 本身非法(如 outputDir 缺失)才会以编程错误抛出。
 */
export async function convertOfficeToPdf(
  inputPath: string,
  options: OfficeConvertOptions,
): Promise<OfficeConvertResult> {
  const command = (options.commandTemplate ?? buildSofficeCommand)(
    inputPath,
    options.outputDir,
  );
  const runner = options.runner ?? defaultCommandRunner;
  const fail = (error: OfficeConvertError): OfficeConvertResult => ({
    ok: false,
    error,
  });

  // 1. 输入校验:存在 + 常规文件 + 受支持扩展名
  try {
    const st = await stat(inputPath);
    if (!st.isFile()) {
      return fail({
        code: "bad_input",
        message: `输入不是常规文件: ${inputPath}`,
        command,
      });
    }
  } catch {
    return fail({
      code: "bad_input",
      message: `输入文件不存在: ${inputPath}`,
      command,
    });
  }
  const ext = basename(inputPath).replace(/^.*(\.[^.]+)$/, "$1").toLowerCase();
  if (!(OFFICE_INPUT_EXTENSIONS as readonly string[]).includes(ext)) {
    return fail({
      code: "bad_input",
      message: `仅支持 ${OFFICE_INPUT_EXTENSIONS.join("/")} 输入,收到 ${ext || "(无扩展名)"}`,
      command,
    });
  }

  // 2. 环境准备 + 调外部命令
  try {
    await mkdir(options.outputDir, { recursive: true });
  } catch (e) {
    return fail({
      code: "spawn_failed",
      message: `输出目录创建失败: ${String(e)}`,
      command,
    });
  }
  let result: ProcessResult;
  try {
    result = await runner(command);
  } catch (e) {
    return fail({
      code: "spawn_failed",
      message: `转换命令未能启动: ${String(e)}`,
      command,
    });
  }
  if (result.exitCode !== 0) {
    return fail({
      code: "nonzero_exit",
      message: `转换命令非零退出(${result.exitCode})`,
      command,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  // 3. 产物校验:存在 + %PDF- 魔数
  const stem = basename(inputPath).replace(/\.[^.]+$/, "");
  const pdfPath =
    options.expectedPdfPath ?? join(options.outputDir, `${stem}.pdf`);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(pdfPath));
  } catch {
    return fail({
      code: "missing_output",
      message: `转换产物不存在: ${pdfPath}`,
      command,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  if (!isPdf(bytes)) {
    return fail({
      code: "invalid_pdf",
      message: `转换产物缺 %PDF- 魔数,不是有效 PDF: ${pdfPath}`,
      command,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }

  return { ok: true, pdfPath, bytes: bytes.length, command };
}
