import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AbortError,
	buildBashScript,
	extractCwdFrame,
	isProcessAlive,
	listProcessGroupMembers,
	runBash,
} from "./index";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("buildBashScript / extractCwdFrame（纯函数）", () => {
	const nonce = "deadbeefdeadbeef";

	test("脚本 = 用户命令 + cwd 标记帧包装", () => {
		const script = buildBashScript("echo hi", nonce);
		expect(script.startsWith("echo hi\n")).toBe(true);
		expect(script).toContain("__bi_rc=$?");
		expect(script).toContain(`bi-cwd-v1:${nonce}:`);
		expect(script.endsWith('exit $__bi_rc')).toBe(true);
	});

	test("标记帧拆包：剥离帧、还原 cwd，用户输出零污染（含无尾换行黏连场景）", () => {
		const frame = `\x1ebi-cwd-v1:${nonce}:/tmp/some dir\x1e`;
		const { cwd, userOutput } = extractCwdFrame(`hi\nabc${frame}`, nonce);
		expect(cwd).toBe("/tmp/some dir");
		expect(userOutput).toBe("hi\nabc");
	});

	test("帧缺失时 cwd 为 undefined 且原文透传", () => {
		const r = extractCwdFrame("plain output", "不存在 的 nonce");
		expect(r.cwd).toBeUndefined();
		expect(r.userOutput).toBe("plain output");
	});
});

describe("runBash", () => {
	let dir: string | undefined;

	afterEach(async () => {
		if (dir) {
			await rm(dir, { recursive: true, force: true });
			dir = undefined;
		}
	});

	const makeDir = async (prefix: string): Promise<string> => {
		dir = await mkdtemp(join(tmpdir(), prefix));
		return dir;
	};

	test("echo 回显、stderr 捕获、退出码与元数据，正常退出无进程残留", async () => {
		const workdir = await makeDir("bi-bash-echo-");
		const result = await runBash('echo out-hello; echo err-world >&2', { cwd: workdir });
		expect(result.exitCode).toBe(0);
		expect(result.signal).toBeUndefined();
		expect(result.stdout).toBe("out-hello\n");
		expect(result.stderr).toBe("err-world\n");
		expect(result.cwd).toBe(workdir);
		expect(result.killed).toBe(false);
		expect(result.timedOut).toBe(false);
		expect(result.stdoutDroppedBytes).toBe(0);
		expect(result.stderrDroppedBytes).toBe(0);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		expect(result.pid).toBeDefined();
		expect(isProcessAlive(result.pid as number)).toBe(false);
	});

	test("cwd 捕获：cd 到子目录后最终 cwd 正确，帧对用户输出无感（含无尾换行）", async () => {
		const workdir = await makeDir("bi-bash-cwd-");
		await mkdir(join(workdir, "a/b"), { recursive: true });
		const result = await runBash('printf "abc"; cd a/b', { cwd: workdir });
		expect(result.exitCode).toBe(0);
		expect(result.cwd).toBe(join(workdir, "a/b"));
		expect(result.stdout).toBe("abc");
	});

	test("exit 提前退出时帧缺失，cwd 回退初始值且退出码保真", async () => {
		const workdir = await makeDir("bi-bash-exit-");
		const result = await runBash("exit 7", { cwd: workdir });
		expect(result.exitCode).toBe(7);
		expect(result.signal).toBeUndefined();
		expect(result.cwd).toBe(workdir);
	});

	test("stdin 默认关闭：cat 立即读到 EOF 而非挂起", async () => {
		await makeDir("bi-bash-stdin-");
		const result = await runBash("cat");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.durationMs).toBeLessThan(4_000);
	});

	test("环境继承 + 注入增量", async () => {
		await makeDir("bi-bash-env-");
		const result = await runBash('printf "%s|%s" "$BI_TEST_VALUE" "$PATH"', {
			env: { BI_TEST_VALUE: "bì-42" },
		});
		expect(result.exitCode).toBe(0);
		const [injected, path] = result.stdout.split("|");
		expect(injected).toBe("bì-42");
		expect(path).toBe(process.env.PATH);
	});

	test("超时杀绝：bash 与后台 job 孙进程整组死亡，证明进程组击杀而非单杀", async () => {
		const workdir = await makeDir("bi-bash-timeout-");
		const bgPidFile = join(workdir, "bg.pid");
		let leaderPid: number | undefined;
		const pending = runBash(`sleep 30 & printf '%s' "$!" > "${bgPidFile}"; sleep 30`, {
			cwd: workdir,
			timeoutMs: 300,
			killGraceMs: 300,
			onSpawn: (pid) => {
				leaderPid = pid;
			},
		});

		// 飞行中：组长 pid 已同步可得，进程组内应有 bash + 两个 sleep
		expect(leaderPid).toBeDefined();
		await delay(120);
		const members = listProcessGroupMembers(leaderPid as number);
		expect(members).toContain(leaderPid as number);
		expect(members.length).toBeGreaterThanOrEqual(3);

		const result = await pending;
		expect(result.timedOut).toBe(true);
		expect(result.killed).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(["SIGTERM", "SIGKILL"]).toContain(result.signal as string);
		expect(result.durationMs).toBeGreaterThanOrEqual(300);
		expect(result.durationMs).toBeLessThan(4_000);

		// 组长与全部成员（含后台 sleep 孙进程）全部死亡
		const bgPid = Number((await readFile(bgPidFile, "utf8")).trim());
		expect(bgPid).toBeGreaterThan(0);
		expect(members).toContain(bgPid);
		expect(isProcessAlive(leaderPid as number)).toBe(false);
		expect(isProcessAlive(bgPid)).toBe(false);
		for (const member of members) {
			expect(isProcessAlive(member)).toBe(false);
		}
		expect(listProcessGroupMembers(leaderPid as number)).toEqual([]);
	});

	test("AbortSignal 取消路径：同样整组击杀", async () => {
		const workdir = await makeDir("bi-bash-abort-");
		const bgPidFile = join(workdir, "bg.pid");
		let leaderPid: number | undefined;
		const controller = new AbortController();
		const abortTimer = setTimeout(() => controller.abort(), 150);

		const result = await runBash(`sleep 30 & printf '%s' "$!" > "${bgPidFile}"; sleep 30`, {
			cwd: workdir,
			killGraceMs: 300,
			signal: controller.signal,
			onSpawn: (pid) => {
				leaderPid = pid;
			},
		});
		clearTimeout(abortTimer);

		expect(result.killed).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBeUndefined();
		expect(["SIGTERM", "SIGKILL"]).toContain(result.signal as string);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");

		const bgPid = Number((await readFile(bgPidFile, "utf8")).trim());
		expect(bgPid).toBeGreaterThan(0);
		expect(isProcessAlive(leaderPid as number)).toBe(false);
		expect(isProcessAlive(bgPid)).toBe(false);
		expect(listProcessGroupMembers(leaderPid as number)).toEqual([]);
	});

	test("spawn 前 signal 已 aborted：直接抛 AbortError，不派生进程", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(runBash("echo nope", { signal: controller.signal })).rejects.toThrow(
			AbortError,
		);
	});

	test("输出缓冲上限：>1MB 输出环形丢弃计数，不 OOM，元数据正确，cwd 帧仍存活", async () => {
		const workdir = await makeDir("bi-bash-flood-");
		const result = await runBash(
			`node -e 'process.stdout.write("x".repeat(2097152)); process.stderr.write("e".repeat(1572864))'`,
			{ cwd: workdir, timeoutMs: 20_000 },
		);
		expect(result.exitCode).toBe(0);
		expect(result.killed).toBe(false);
		expect(result.timedOut).toBe(false);

		// stdout：2MiB 写入 → 保留尾部 1MiB，头部丢弃并计数
		expect(result.stdout).toMatch(/^x+$/);
		expect(result.stdout.length).toBeGreaterThan(1_000_000);
		expect(result.stdout.length).toBeLessThanOrEqual(1_048_576);
		expect(result.stdoutDroppedBytes).toBeGreaterThanOrEqual(1_048_576);

		// stderr：1.5MiB 写入 → 丢弃 0.5MiB
		expect(result.stderr).toMatch(/^e+$/);
		expect(result.stderrDroppedBytes).toBeGreaterThanOrEqual(524_288);

		// 环形保留尾部 → 标记帧不被截掉，拆包后 cwd 正确
		expect(result.cwd).toBe(workdir);
		expect(result.stdout.includes("bi-cwd-v1")).toBe(false);
		expect(isProcessAlive(result.pid as number)).toBe(false);
	});

	test("并发互不串扰：同一时刻多条 runBash 各自返回正确结果", async () => {
		const workdir = await makeDir("bi-bash-par-");
		await mkdir(join(workdir, "s1"), { recursive: true });
		const results = await Promise.all([
			runBash("echo one", { cwd: workdir }),
			runBash("cd s1 && echo two", { cwd: workdir }),
			runBash("echo three >&2; exit 5", { cwd: workdir }),
		]);
		expect(results[0]?.stdout).toBe("one\n");
		expect(results[1]?.stdout).toBe("two\n");
		expect(results[1]?.cwd).toBe(join(workdir, "s1"));
		expect(results[2]?.exitCode).toBe(5);
		expect(results[2]?.stderr).toBe("three\n");
	});
});
