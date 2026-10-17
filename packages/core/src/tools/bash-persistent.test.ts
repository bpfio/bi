import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersistentShell } from "./bash-persistent";
import { isProcessAlive } from "./process-group";
import type { PersistentShellOptions } from "./bash-persistent";

/**
 * PersistentShell 会话生命周期测试（真实常驻 bash 进程，授权同 BI-06 前例）。
 * 覆盖合约钦定场景：cd 持久、export 持久、超时 \x03 恢复、stdout 环形上限、
 * 退出码透传、并发排队串行、dispose 清理、标记帧不可见。
 */

const created: PersistentShell[] = [];
const scratchDir = mkdtempSync(join(tmpdir(), "bi-persistent-shell-"));

function makeShell(options: PersistentShellOptions = {}): PersistentShell {
	const shell = new PersistentShell(options);
	created.push(shell);
	return shell;
}

afterAll(async () => {
	for (const shell of created.splice(0)) {
		await shell.dispose().catch(() => {});
	}
	rmSync(scratchDir, { recursive: true, force: true });
});

describe("PersistentShell：会话生命周期", () => {
	test("cd 持久：第一条 cd /tmp，第二条 pwd=/tmp", async () => {
		const shell = makeShell();
		const first = await shell.exec("cd /tmp");
		expect(first.cwd).toBe("/tmp");
		const second = await shell.exec("pwd");
		expect(second.stdout).toBe("/tmp\n");
		expect(second.cwd).toBe("/tmp");
		expect(shell.cwd).toBe("/tmp");
	}, 10_000);

	test("export 持久：跨命令可见", async () => {
		const shell = makeShell();
		await shell.exec("export BI_PSH_PROBE=persisted");
		const result = await shell.exec('printf "%s" "$BI_PSH_PROBE"');
		expect(result.stdout).toBe("persisted");
	}, 10_000);

	test("退出码透传：成功/失败/自定义码", async () => {
		const shell = makeShell();
		expect((await shell.exec("echo ok")).exitCode).toBe(0);
		expect((await shell.exec("sh -c 'exit 7'")).exitCode).toBe(7);
		expect((await shell.exec("false")).exitCode).toBe(1);
	}, 10_000);

	test("超时 \\x03 恢复：sleep 长命令中断后仍可用且 cwd 保留", async () => {
		const shell = makeShell();
		await shell.exec("cd /tmp");
		const startedAt = Date.now();
		const interrupted = await shell.exec("sleep 30", { timeoutMs: 250 });
		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(interrupted.timedOut).toBe(true);
		expect(interrupted.exitCode).toBeUndefined();
		const revived = await shell.exec("echo alive-after-timeout");
		expect(revived.stdout).toBe("alive-after-timeout\n");
		expect(revived.exitCode).toBe(0);
		const pwd = await shell.exec("pwd");
		expect(pwd.stdout).toBe("/tmp\n");
	}, 15_000);

	test("stdout 环形上限：64KB 封顶保尾部", async () => {
		const shell = makeShell();
		const result = await shell.exec(
			"for i in $(seq 1 20000); do echo ROW-$i-abcdefghij; done",
		);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65_536);
		expect(result.stdoutDroppedBytes).toBeGreaterThan(0);
		expect(result.stdout).toContain("ROW-20000-abcdefghij");
		expect(result.stdout).not.toContain("ROW-1-abcdefghij");
	}, 15_000);

	test("并发 exec 排队：Promise 链串行、结果按提交顺序、无交错", async () => {
		const shell = makeShell();
		const startedAt = Date.now();
		const promises = [
			shell.exec("echo start-1; sleep 0.12; echo end-1"),
			shell.exec("echo start-2; sleep 0.12; echo end-2"),
			shell.exec("echo start-3; sleep 0.12; echo end-3"),
			shell.exec("echo start-4; sleep 0.12; echo end-4"),
		];
		const results = await Promise.all(promises);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
		for (let i = 0; i < results.length; i++) {
			const index = i + 1;
			expect(results[i]?.stdout).toBe(`start-${index}\nend-${index}\n`);
		}
	}, 15_000);

	test("dispose 清理：进程死亡、在途 exec 拒绝、后续 exec 拒绝、幂等", async () => {
		const shell = makeShell();
		shell.spawn();
		const pid = shell.pid;
		expect(pid).toBeGreaterThan(0);
		await shell.exec("echo ready");
		const inFlight = shell.exec("sleep 30");
		await shell.dispose();
		// 僵尸未收割窗口内 kill(pid,0) 仍返回成功，必须按 /proc 实际状态判定
		if (pid !== undefined) {
			expect(isProcessAlive(pid)).toBe(false);
		}
		let rejection: unknown = null;
		try {
			await inFlight;
		} catch (error) {
			rejection = error;
		}
		expect(rejection).toBeInstanceOf(Error);
		let laterRejection: unknown = null;
		try {
			await shell.exec("echo after-dispose");
		} catch (error) {
			laterRejection = error;
		}
		expect(laterRejection).toBeInstanceOf(Error);
		await shell.dispose(); // 幂等
	}, 15_000);

	test("标记帧对用户输出不可见：精确相等 + onOutput 无 RS", async () => {
		const shell = makeShell();
		const streamed: string[] = [];
		const result = await shell.exec("echo marker-invisible", {
			onOutput: (chunk) => streamed.push(chunk),
		});
		expect(result.stdout).toBe("marker-invisible\n");
		expect(streamed.join("")).toBe("marker-invisible\n");
		for (const chunk of streamed) {
			expect(chunk.includes("\x1e")).toBe(false);
		}
	}, 10_000);

	test("spawn 幂等：重复调用返回同一实例与 pid", async () => {
		const shell = makeShell({ cwd: scratchDir });
		shell.spawn();
		const pidBefore = shell.pid;
		expect(pidBefore).toBeGreaterThan(0);
		shell.spawn();
		expect(shell.pid).toBe(pidBefore);
		const result = await shell.exec("pwd");
		expect(result.stdout).toBe(`${scratchDir}\n`);
	}, 10_000);

	test("reset：干净状态重建，cwd 恢复跟踪值、env 清零", async () => {
		const shell = makeShell({ cwd: scratchDir });
		await shell.exec("cd /tmp");
		await shell.exec("export BI_PSH_RESET_PROBE=gone");
		await shell.reset();
		const pwd = await shell.exec("pwd");
		expect(pwd.stdout).toBe(`${scratchDir}\n`);
		const probe = await shell.exec('printf "%s" "$BI_PSH_RESET_PROBE"');
		expect(probe.stdout).toBe("");
	}, 15_000);

	test("用户命令 exit N 后自动重建会话", async () => {
		const shell = makeShell();
		const first = await shell.exec("exit 9");
		expect(first.exitCode).toBe(9);
		const healed = await shell.exec("echo session-rebuilt");
		expect(healed.stdout).toBe("session-rebuilt\n");
		expect(healed.exitCode).toBe(0);
	}, 10_000);

	test("构造 env 注入", async () => {
		const shell = makeShell({ env: { BI_PSH_VAR: "env-option" } });
		const result = await shell.exec('printf "%s" "$BI_PSH_VAR"');
		expect(result.stdout).toBe("env-option");
	}, 10_000);

	test("结果字段齐全：stdout/stderr/exitCode/cwd/timedOut", async () => {
		const shell = makeShell();
		const result = await shell.exec("echo shape; echo shape-err >&2");
		expect(Object.keys(result).sort()).toEqual([
			"cwd",
			"exitCode",
			"signal",
			"stderr",
			"stderrDroppedBytes",
			"stdout",
			"stdoutDroppedBytes",
			"timedOut",
		]);
		expect(result.stderr).toBe("shape-err\n");
	}, 10_000);

	test("命令失败不影响后续排队命令继续执行", async () => {
		const shell = makeShell();
		await shell.exec("definitely-not-a-command-xyz");
		const after = await shell.exec("echo still-queued");
		expect(after.stdout).toBe("still-queued\n");
		expect(after.exitCode).toBe(0);
	}, 10_000);
});
