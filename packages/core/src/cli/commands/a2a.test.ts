/**
 * X4 波次二 —— `bi a2a host` 子命令验收。
 *
 * - enabled=false（缺省配置）→ 结构化 exit 4（能力未配置语义）；
 * - 回环 host 启动 + SIGINT 收尾：子进程探针（真实 SIGINT 投递，exit 0 + stdout
 *   结构化单行 + 探活可达）；另配注入 AbortSignal 的进程内快速路径。
 * 测试零外呼：配置经临时 homeDir 注入，监听恒回环。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleA2a } from "./a2a";
import type { SubcommandIo } from "./dispatch";

async function makeHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "bi-a2a-cmd-"));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** 写全局 config.toml（ConfigService 读 <home>/.bi/config.toml）。 */
async function writeGlobalConfig(home: string, body: string): Promise<void> {
  await mkdir(join(home, ".bi"), { recursive: true });
  await writeFile(join(home, ".bi", "config.toml"), body, "utf8");
}

function captureIo(): { io: SubcommandIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

describe("X4 · bi a2a host", () => {
  test("enabled=false（缺省）→ 结构化 exit 4", async () => {
    const { home, cleanup } = await makeHome();
    try {
      const { io, out, err } = captureIo();
      const code = await handleA2a(["host"], io, { homeDir: home });
      expect(code).toBe(4);
      expect(out).toEqual([]);
      expect(err[0]).toContain("a2a-disabled");
    } finally {
      await cleanup();
    }
  });

  test("注入 AbortSignal：回环 host 起 + 干净收尾（stdout 结构化单行）", async () => {
    const { home, cleanup } = await makeHome();
    try {
      await writeGlobalConfig(home, '[a2a]\nenabled = true\nlisten = "127.0.0.1:0"\n');
      const { io, out, err } = captureIo();
      const controller = new AbortController();
      const pending = handleA2a(["host"], io, { homeDir: home }, { signal: controller.signal });
      controller.abort();
      const code = await pending;
      expect(code).toBe(0);
      expect(out).toHaveLength(1);
      const line = JSON.parse(out[0]!) as { event: string; address: string; port: number; token: string };
      expect(line.event).toBe("bi-a2a-host");
      expect(line.address.startsWith("127.0.0.1:")).toBe(true);
      expect(line.port).toBeGreaterThan(0);
      expect(line.token).toBe("ephemeral");
      expect(err.at(-1)).toContain("已关闭");
    } finally {
      await cleanup();
    }
  });

  test("子进程探针：真实 SIGINT 收尾（exit 0 + 探活可达）", async () => {
    const { home, cleanup } = await makeHome();
    try {
      await writeGlobalConfig(home, '[a2a]\nenabled = true\nlisten = "127.0.0.1:0"\n');
      const driver = join(home, "driver.ts");
      await writeFile(
        driver,
        [
          `import { handleA2a } from "${join(import.meta.dir, "a2a")}";`,
          `const io = { out: (l: string) => console.log(l), err: (l: string) => console.error(l) };`,
          `process.exitCode = await handleA2a(["host"], io, { homeDir: process.env.BI_TEST_HOME! });`,
        ].join("\n"),
        "utf8",
      );
      const proc = Bun.spawn(["bun", "run", driver], {
        env: { ...process.env, BI_TEST_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      // 等 stdout 首行结构化监听地址
      const reader = proc.stdout.getReader();
      let buffered = "";
      let line = "";
      const deadline = Date.now() + 15_000;
      while (!line && Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("探针超时")), 5_000)),
        ]);
        buffered += new TextDecoder().decode((chunk as ReadableStreamReadResult<Uint8Array>).value ?? new Uint8Array());
        const nl = buffered.indexOf("\n");
        if (nl !== -1) line = buffered.slice(0, nl);
      }
      expect(line).toContain("bi-a2a-host");
      const listening = JSON.parse(line) as { address: string; token: string };
      expect(listening.address.startsWith("127.0.0.1:")).toBe(true);
      expect(listening.token).toBe("ephemeral");
      // 探活可达
      const probe = await fetch(`http://${listening.address}/`);
      expect(((await probe.json()) as { service: string }).service).toBe("bi-a2a");
      // SIGINT → exit 0
      proc.kill("SIGINT");
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      await reader.cancel().catch(() => {});
    } finally {
      await cleanup();
    }
  });
});
