import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildSofficeCommand,
  convertOfficeToPdf,
  defaultCommandRunner,
  isPdf,
} from "./office-converter.ts";
import type { CommandRunner } from "./office-converter.ts";

// ---------------------------------------------------------------------------
// 伪 runner:模拟 soffice 行为(写产物 / 非零退出 / 抛错),不装 LibreOffice
// ---------------------------------------------------------------------------

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n%fake-for-test\n");

interface FakeOpts {
  exitCode?: number;
  stderr?: string;
  throws?: unknown;
  produce?: "pdf" | "text" | "none";
}

function fakeSoffice(opts: FakeOpts = {}): CommandRunner & { commands: string[][] } {
  const commands: string[][] = [];
  const runner = async (command: string[]) => {
    commands.push(command);
    if (opts.throws !== undefined) throw opts.throws;
    const outdirIndex = command.indexOf("--outdir");
    const outdir = outdirIndex >= 0 ? command[outdirIndex + 1] : undefined;
    if (outdir !== undefined && opts.produce !== undefined && opts.produce !== "none") {
      // 注意:path.join 不重置绝对段,这里必须先取 basename 再拼产物名
      const input = basename(command[command.length - 1] ?? "");
      const pdfPath = join(outdir, input.replace(/\.[^.]+$/, ".pdf"));
      await writeFile(
        pdfPath,
        opts.produce === "pdf" ? PDF_BYTES : new TextEncoder().encode("plain text, not a pdf"),
      );
    }
    return {
      exitCode: opts.exitCode ?? 0,
      stdout: "",
      stderr: opts.stderr ?? "",
    };
  };
  return { commands, runner: runner as CommandRunner };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "office-conv-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// convertOfficeToPdf
// ---------------------------------------------------------------------------

describe("convertOfficeToPdf —— 成功分支", () => {
  test("docx 转换成功:产物校验通过,返回 pdfPath 与字节数", async () => {
    const out = await tempDir();
    const input = join(out, "report.docx");
    await writeFile(input, "fake docx");
    const fake = fakeSoffice({ produce: "pdf" });
    const result = await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pdfPath).toBe(join(out, "report.pdf"));
      expect(result.bytes).toBe(PDF_BYTES.length);
      expect(result.command).toEqual(fake.commands[0]);
    }
  });

  test("pptx 输入 → 产物名为 slides.pdf", async () => {
    const out = await tempDir();
    const input = join(out, "slides.pptx");
    await writeFile(input, "fake pptx");
    const fake = fakeSoffice({ produce: "pdf" });
    const result = await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pdfPath).toBe(join(out, "slides.pdf"));
  });

  test("缺省命令模板 = soffice --headless --convert-to pdf --outdir", async () => {
    const out = await tempDir();
    const input = join(out, "report.docx");
    await writeFile(input, "x");
    const fake = fakeSoffice({ produce: "pdf" });
    await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(fake.commands[0]).toEqual(buildSofficeCommand(input, out));
    expect(fake.commands[0]?.slice(0, 4)).toEqual(["soffice", "--headless", "--convert-to", "pdf"]);
  });

  test("自定义 commandTemplate 被采用,expectedPdfPath 覆写产物定位", async () => {
    const out = await tempDir();
    const input = join(out, "report.docx");
    await writeFile(input, "x");
    const pdfPath = join(out, "custom-name.pdf");
    const commands: string[][] = [];
    const runner: CommandRunner = async (command) => {
      commands.push(command);
      await writeFile(pdfPath, PDF_BYTES);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const result = await convertOfficeToPdf(input, {
      outputDir: out,
      runner,
      commandTemplate: (inp) => ["/usr/bin/fake2office", inp, "-o", pdfPath],
      expectedPdfPath: pdfPath,
    });
    expect(result.ok).toBe(true);
    expect(commands[0]).toEqual(["/usr/bin/fake2office", input, "-o", pdfPath]);
    if (result.ok) expect(result.pdfPath).toBe(pdfPath);
  });

  test("输出目录不存在时自动递归创建", async () => {
    const out = await tempDir();
    const nested = join(out, "a", "b");
    const input = join(out, "report.docx");
    await writeFile(input, "x");
    const fake = fakeSoffice({ produce: "pdf" });
    const result = await convertOfficeToPdf(input, { outputDir: nested, runner: fake.runner });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pdfPath.startsWith(nested)).toBe(true);
  });
});

describe("convertOfficeToPdf —— 失败分支(结构化错误)", () => {
  test("命令非零退出:code=nonzero_exit,携带 exitCode 与 stderr", async () => {
    const out = await tempDir();
    const input = join(out, "report.docx");
    await writeFile(input, "x");
    const fake = fakeSoffice({ exitCode: 5, stderr: "Error: source file could not be loaded" });
    const result = await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("nonzero_exit");
      expect(result.error.exitCode).toBe(5);
      expect(result.error.stderr).toContain("could not be loaded");
    }
  });

  test("runner 抛错:code=spawn_failed(不向外抛异常)", async () => {
    const out = await tempDir();
    const input = join(out, "report.docx");
    await writeFile(input, "x");
    const fake = fakeSoffice({ throws: new Error("spawn ENOENT") });
    const result = await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("spawn_failed");
      expect(result.error.message).toContain("ENOENT");
    }
  });

  test("命令成功但无产物:code=missing_output", async () => {
    const out = await tempDir();
    const input = join(out, "report.docx");
    await writeFile(input, "x");
    const fake = fakeSoffice({ produce: "none" });
    const result = await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("missing_output");
  });

  test("产物缺 %PDF- 魔数:code=invalid_pdf", async () => {
    const out = await tempDir();
    const input = join(out, "report.docx");
    await writeFile(input, "x");
    const fake = fakeSoffice({ produce: "text" });
    const result = await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_pdf");
      expect(result.error.message).toContain("%PDF-");
    }
  });

  test("扩展名不受支持(.xlsx):code=bad_input", async () => {
    const out = await tempDir();
    const input = join(out, "book.xlsx");
    await writeFile(input, "x");
    const fake = fakeSoffice({ produce: "pdf" });
    const result = await convertOfficeToPdf(input, { outputDir: out, runner: fake.runner });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bad_input");
  });

  test("输入文件不存在:code=bad_input", async () => {
    const out = await tempDir();
    const fake = fakeSoffice({ produce: "pdf" });
    const result = await convertOfficeToPdf(join(out, "ghost.docx"), {
      outputDir: out,
      runner: fake.runner,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("bad_input");
  });
});

// ---------------------------------------------------------------------------
// isPdf 与缺省 runner
// ---------------------------------------------------------------------------

describe("isPdf —— PDF 魔数", () => {
  test("命中 %PDF- 头返回 true", () => {
    expect(isPdf(PDF_BYTES)).toBe(true);
  });

  test("非 PDF 字节与短字节返回 false", () => {
    expect(isPdf(new TextEncoder().encode("MZ........"))).toBe(false);
    expect(isPdf(new TextEncoder().encode("%PD"))).toBe(false);
  });
});

describe("defaultCommandRunner —— 缺省 Bun.spawn runner", () => {
  test("捕获退出码与 stderr", async () => {
    const result = await defaultCommandRunner(["/bin/sh", "-c", "echo boom >&2; exit 7"]);
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain("boom");
  });
});
