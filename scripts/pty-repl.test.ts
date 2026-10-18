/**
 * BI-26.4 —— pty 真人面回归(REPL 布局/逐键渲染/真实回合,CI 与本机可跑)。
 *
 * 教训来源(BI-24.3):挂载层单测全用注入渲染面,虚拟终端布局缺陷只有 pty
 * 真机才显形(状态行/提示行同格叠写、尺寸硬编码)。本套件经 scripts/pty-probe.py
 * 在 40×100 真伪终端驱动真实 bin 入口(bin/bi.ts)+ BI-26.2 本地伪端点,断言:
 * ①状态行独占 rows-2(第 39 行)、提示行独占 rows-1(第 40 行);
 * ②无叠写乱码(历史缺陷标志 "anual]" 不得出现);
 * ③输入回环:提交 "hello" → 伪端点 ECHO:hello 经真实回合上屏。
 * 门控 BI_PTY_E2E=1(CI 置位;本地开发缺省跳过)。缺 python3 自动跳过。
 * 纪律:子进程 env 仅 PATH+HOME+BI_FAKE_KEY,零真实凭据零外呼。
 */
import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { startFakeEndpoint } from "./fake-endpoint.ts";

const ROOT = join(import.meta.dir, "..");
const RUN = process.env.BI_PTY_E2E === "1";
const run = promisify(execFile);

async function hasPython3(): Promise<boolean> {
	try {
		await run("python3", ["--version"], { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!RUN || !(await hasPython3()))("BI-26.4 pty 真人面回归", () => {
	test("40×100:行分离/无叠写/ECHO 真实回合上屏", async () => {
		const fake = startFakeEndpoint({ echo: true, mode: "anthropic" });
		const home = await mkdtemp(join(tmpdir(), "bi-pty-"));
		await mkdir(join(home, ".bi"), { recursive: true });
		const config = [
			"[providers.entries.fake]",
			'api_key_env = "BI_FAKE_KEY"',
			`base_url = "${fake.url}"`,
			'kind = "anthropic"',
			'models = ["fake-echo"]',
			"",
			"[providers]",
			'default = "fake"',
			"",
			"[models]",
			'default = "main"',
			"",
			"[models.entries.main]",
			'provider = "fake"',
			'model = "fake-echo"',
			"",
		].join("\n");
		await writeFile(join(home, ".bi", "config.toml"), config, { mode: 0o600 });
		try {
			// 异步执行:伪端点跑在本测试进程的 Bun.serve 里,同步阻塞会饿死事件
			// 循环导致子进程 fetch 永远挂起(实测教训)。
			const { stdout } = await run(
				"python3",
				[
					join(ROOT, "scripts", "pty-probe.py"),
					"--rows",
					"40",
					"--cols",
					"100",
					"--boot-wait",
					"2",
					"--tail-wait",
					"5",
					"--keys",
					"hello\\r",
					"--",
					"bun",
					join(ROOT, "bin", "bi.ts"),
				],
				{
					env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home, BI_FAKE_KEY: "dummy" },
					timeout: 45_000,
					maxBuffer: 16 * 1024 * 1024,
				},
			);

			// ① 布局:状态行第 39 行、提示行第 40 行(真实窗口尺寸生效)
			expect(stdout).toContain("\x1b[39;1H");
			expect(stdout).toContain("\x1b[40;1H");
			// ② 无同格叠写:真缺陷特征=❯ 后紧跟状态残字("anual]"是 "manual]" 的
			// 子串,任何正确状态行都含它——必须锚定提示符 ❯ 才是缺陷特异信号)
			expect(stdout).not.toMatch(/❯ anual/);
			// ③ 提示行与真实回合回环
			expect(stdout).toContain("❯");
			expect(stdout).toContain("ECHO:hello");
			// ④ 凭据门未误触(模型装配成功)
			expect(stdout).toContain("模型已装配");
		} finally {
			fake.close();
			await rm(home, { recursive: true, force: true });
		}
	}, 60_000);
});
