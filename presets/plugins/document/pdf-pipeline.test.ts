import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SKIP_AUDIT_NOTE,
  auditPdfPages,
  buildPdftoppmCommand,
  slicePdfToPageImages,
  type DocumentAuditIssue,
  type VisionJudgeLike,
} from "./pdf-pipeline.ts";
import type { CommandRunner } from "./office-converter.ts";

// ---------------------------------------------------------------------------
// 伪 runner:模拟 pdftoppm 行为(按页数写 PNG 产物),不装 poppler
// ---------------------------------------------------------------------------

function pngBytes(payload: number): Uint8Array {
  const head = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = new Uint8Array(head.length + 1);
  bytes.set(head, 0);
  bytes[head.length] = payload;
  return bytes;
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%fake-pdf-for-slice\n");
const NOT_PDF_BYTES = new TextEncoder().encode("definitely not a pdf");

interface FakeOpts {
  pageCount: number;
  exitCode?: number;
  stderr?: string;
  /** 用两位补零命名(page-01.png),模拟 pdftoppm 的补零行为。 */
  pad?: boolean;
}

function fakePdftoppm(opts: FakeOpts): CommandRunner & { commands: string[][] } {
  const commands: string[][] = [];
  const runner = async (command: string[]) => {
    commands.push(command);
    if (opts.exitCode !== undefined) {
      return { exitCode: opts.exitCode, stdout: "", stderr: opts.stderr ?? "" };
    }
    // 缺省命令形如 pdftoppm -png -r <density> <pdf> <outdir>/<prefix>,前缀路径是末参
    const prefix = command[command.length - 1] ?? "";
    for (let i = 1; i <= opts.pageCount; i++) {
      const name = opts.pad
        ? `${prefix}-${String(i).padStart(2, "0")}.png`
        : `${prefix}-${i}.png`;
      await writeFile(name, pngBytes(i));
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { commands, runner: runner as CommandRunner };
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdf-pipe-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makePdf(dir: string, bytes: Uint8Array = PDF_BYTES): Promise<string> {
  const pdfPath = join(dir, "doc.pdf");
  await writeFile(pdfPath, bytes);
  return pdfPath;
}

function judgeStub(script: Array<{ pass: boolean; issues: DocumentAuditIssue[] }>): VisionJudgeLike & { seen: Uint8Array[] } {
  const seen: Uint8Array[] = [];
  const queue = [...script];
  return {
    seen,
    judge: async (png: Uint8Array) => {
      seen.push(png);
      const next = queue.shift();
      if (next !== undefined) return next;
      return { pass: true, issues: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// slicePdfToPageImages
// ---------------------------------------------------------------------------

describe("slicePdfToPageImages —— 切片", () => {
  test("缺省参数:3 页产物按页码升序返回", async () => {
    const dir = await tempDir();
    const out = join(dir, "slices");
    const fake = fakePdftoppm({ pageCount: 3 });
    const result = await slicePdfToPageImages(await makePdf(dir), out, { runner: fake.runner });
    expect(result.ok).toBe(true);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[0]?.endsWith("page-1.png")).toBe(true);
    expect(result.pages[1]?.endsWith("page-2.png")).toBe(true);
    expect(result.pages[2]?.endsWith("page-3.png")).toBe(true);
  });

  test("缺省命令:pdftoppm -png -r 150 <pdf> <outdir>/page", async () => {
    const dir = await tempDir();
    const pdfPath = await makePdf(dir);
    const fake = fakePdftoppm({ pageCount: 1 });
    const result = await slicePdfToPageImages(pdfPath, join(dir, "s"), { runner: fake.runner });
    expect(result.ok).toBe(true);
    expect(fake.commands[0]).toEqual(
      buildPdftoppmCommand(pdfPath, join(dir, "s"), 150, "page"),
    );
    expect(fake.commands[0]?.slice(0, 4)).toEqual(["pdftoppm", "-png", "-r", "150"]);
  });

  test("自定义密度:density=100 传入 -r 100", async () => {
    const dir = await tempDir();
    const fake = fakePdftoppm({ pageCount: 1 });
    await slicePdfToPageImages(await makePdf(dir), join(dir, "s"), {
      runner: fake.runner,
      density: 100,
    });
    expect(fake.commands[0]?.[3]).toBe("100");
  });

  test("补零命名(page-01…page-12):按数值序而非字典序", async () => {
    const dir = await tempDir();
    const out = join(dir, "s");
    const fake = fakePdftoppm({ pageCount: 12, pad: true });
    const result = await slicePdfToPageImages(await makePdf(dir), out, { runner: fake.runner });
    expect(result.ok).toBe(true);
    expect(result.pages).toHaveLength(12);
    expect(result.pages[0]?.endsWith("page-01.png")).toBe(true);
    expect(result.pages[9]?.endsWith("page-10.png")).toBe(true);
    expect(result.pages[11]?.endsWith("page-12.png")).toBe(true);
    const n10 = result.pages[9]!;
    expect(n10 < result.pages[10]!).toBe(true);
  });

  test("自定义 pagePrefix 生效", async () => {
    const dir = await tempDir();
    const out = join(dir, "s");
    const fake = fakePdftoppm({ pageCount: 2 });
    const result = await slicePdfToPageImages(await makePdf(dir), out, {
      runner: fake.runner,
      pagePrefix: "sheet",
    });
    expect(result.ok).toBe(true);
    expect(result.pages[0]?.endsWith("sheet-1.png")).toBe(true);
  });

  test("失败分支:非零退出 → code=nonzero_exit 且携带 stderr", async () => {
    const dir = await tempDir();
    const fake = fakePdftoppm({ pageCount: 0, exitCode: 9, stderr: "Syntax Error: Could not open" });
    const result = await slicePdfToPageImages(await makePdf(dir), join(dir, "s"), {
      runner: fake.runner,
    });
    expect(result.ok).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.error?.code).toBe("nonzero_exit");
    expect(result.error?.stderr).toContain("Could not open");
  });

  test("失败分支:输入缺 %PDF- 魔数 → code=bad_input", async () => {
    const dir = await tempDir();
    const fake = fakePdftoppm({ pageCount: 1 });
    const result = await slicePdfToPageImages(await makePdf(dir, NOT_PDF_BYTES), join(dir, "s"), {
      runner: fake.runner,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad_input");
    expect(result.error?.message).toContain("%PDF-");
  });

  test("失败分支:输入不存在 → code=bad_input", async () => {
    const dir = await tempDir();
    const fake = fakePdftoppm({ pageCount: 1 });
    const result = await slicePdfToPageImages(join(dir, "ghost.pdf"), join(dir, "s"), {
      runner: fake.runner,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("bad_input");
  });

  test("失败分支:命令成功但零产物 → code=missing_output", async () => {
    const dir = await tempDir();
    const fake = fakePdftoppm({ pageCount: 0 });
    const result = await slicePdfToPageImages(await makePdf(dir), join(dir, "s"), {
      runner: fake.runner,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("missing_output");
  });
});

// ---------------------------------------------------------------------------
// auditPdfPages —— 逐页审计回路(红头/印章/表格)
// ---------------------------------------------------------------------------

describe("auditPdfPages —— 注入 judge 的交叉审计", () => {
  test("逐页审计:第 2 页 fail,issues 透传,汇总 failedPages=1", async () => {
    const dir = await tempDir();
    const issue: DocumentAuditIssue = {
      type: "overlap",
      detail: "印章压住正文表格线",
      fixHint: "印章右上移 20pt",
    };
    const judge = judgeStub([{ pass: true, issues: [] }, { pass: false, issues: [issue] }]);
    const summary = await auditPdfPages(await makePdf(dir), join(dir, "s"), {
      runner: fakePdftoppm({ pageCount: 2 }).runner,
      judge,
    });
    expect(summary.ok).toBe(false);
    expect(summary.degraded).toBe(false);
    expect(summary.totalPages).toBe(2);
    expect(summary.auditedPages).toBe(2);
    expect(summary.failedPages).toBe(1);
    expect(summary.pages[0]?.pass).toBe(true);
    expect(summary.pages[1]?.pass).toBe(false);
    expect(summary.pages[1]?.issues).toEqual([issue]);
    expect(summary.aspects).toEqual(["redhead", "seal", "table"]);
  });

  test("全部 pass:ok=true,每页 audited=true", async () => {
    const dir = await tempDir();
    const summary = await auditPdfPages(await makePdf(dir), join(dir, "s"), {
      runner: fakePdftoppm({ pageCount: 3 }).runner,
      judge: judgeStub([{ pass: true, issues: [] }]),
    });
    expect(summary.ok).toBe(true);
    expect(summary.failedPages).toBe(0);
    expect(summary.pages.every((p) => p.audited && p.pass === true)).toBe(true);
  });

  test("judge 按页序收到每页 PNG 字节(页载荷可区分)", async () => {
    const dir = await tempDir();
    const judge = judgeStub([{ pass: true, issues: [] }]);
    await auditPdfPages(await makePdf(dir), join(dir, "s"), {
      runner: fakePdftoppm({ pageCount: 3 }).runner,
      judge,
    });
    expect(judge.seen).toHaveLength(3);
    expect(judge.seen[0]?.[8]).toBe(1);
    expect(judge.seen[1]?.[8]).toBe(2);
    expect(judge.seen[2]?.[8]).toBe(3);
  });

  test("自定义 aspects 记录进汇总报告", async () => {
    const dir = await tempDir();
    const summary = await auditPdfPages(await makePdf(dir), join(dir, "s"), {
      runner: fakePdftoppm({ pageCount: 1 }).runner,
      judge: judgeStub([]),
      aspects: ["redhead"],
    });
    expect(summary.aspects).toEqual(["redhead"]);
  });

  test("切片失败时汇总携带 sliceError,pages 为空", async () => {
    const dir = await tempDir();
    const summary = await auditPdfPages(join(dir, "ghost.pdf"), join(dir, "s"), {
      runner: fakePdftoppm({ pageCount: 1 }).runner,
      judge: judgeStub([]),
    });
    expect(summary.ok).toBe(false);
    expect(summary.sliceError?.code).toBe("bad_input");
    expect(summary.pages).toEqual([]);
    expect(summary.degraded).toBe(false);
  });
});

describe("auditPdfPages —— judge 未注入的优雅降级", () => {
  test("逐页报告标注跳过审计,切片结果照常交付", async () => {
    const dir = await tempDir();
    const out = join(dir, "s");
    const summary = await auditPdfPages(await makePdf(dir), out, {
      runner: fakePdftoppm({ pageCount: 2 }).runner,
    });
    expect(summary.ok).toBe(true);
    expect(summary.degraded).toBe(true);
    expect(summary.totalPages).toBe(2);
    expect(summary.auditedPages).toBe(0);
    expect(summary.failedPages).toBe(0);
    for (const page of summary.pages) {
      expect(page.audited).toBe(false);
      expect(page.pass).toBeNull();
      expect(page.issues).toEqual([]);
      expect(page.note).toBe(SKIP_AUDIT_NOTE);
      expect(page.note).toContain("visualize");
    }
    // 切片产物仍真实存在于磁盘
    const first = summary.pages[0]?.image;
    expect(first).toBeDefined();
    const bytes = new Uint8Array(await readFile(first!));
    expect(bytes[0]).toBe(0x89);
  });

  test("judge 未注入且切片失败:degraded=true 且 sliceError 可见", async () => {
    const dir = await tempDir();
    const summary = await auditPdfPages(await makePdf(dir, NOT_PDF_BYTES), join(dir, "s"), {
      runner: fakePdftoppm({ pageCount: 1 }).runner,
    });
    expect(summary.ok).toBe(false);
    expect(summary.degraded).toBe(true);
    expect(summary.sliceError?.code).toBe("bad_input");
  });
});
