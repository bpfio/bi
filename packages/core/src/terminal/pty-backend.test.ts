import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../tools/process-group";
import {
	BoundedRing,
	PtyBackend,
	DEFAULT_PTY_EXEC_TIMEOUT_MS,
	DEFAULT_PTY_OUTPUT_CAP_BYTES,
} from "./pty-backend";
import type { PtyBackendOptions } from "./pty-backend";

/**
 * PtyBackend 真实常驻 bash 进程测试（真实进程授权同 BI-06 前例：bash/printf）。
 * 全部后端统一登记，afterAll 兜底 dispose，防泄漏 bash 挂住测试进程。
 */

const created: PtyBackend[] = [];
const scratchDir = mkdtempSync(join(tmpdir(), "bi-pty-backend-"));

function makeBackend(options: PtyBackendOptions = {}): PtyBackend {
	const backend = new PtyBackend(options);
	created.push(backend);
	return backend;
}

afterAll(async () => {
	for (const backend of created.splice(0)) {
		await backend.dispose().catch(() => {});
	}
	rmSync(scratchDir, { recursive: true, force: true });
});

describe("BoundedRing（64KB 环形缓冲）", () => {
	test("未超限时文本原样保留且无丢弃", () => {
		const ring = new BoundedRing(1024);
		ring.push("hello ");
		ring.push("world");
		expect(ring.finalize()).toEqual({ text: "hello world", droppedBytes: 0 });
	});

	test("多块超限时丢头部保尾部并计数", () => {
		const ring = new BoundedRing(64);
		for (let i = 0; i < 20; i++) {
			ring.push(`CHUNK-${String(i).padStart(2, "0")}-xxxxxxxx\n`);
		}
		const { text, droppedBytes } = ring.finalize();
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64);
		expect(droppedBytes).toBeGreaterThan(0);
		expect(text.endsWith("CHUNK-19-xxxxxxxx\n")).toBe(true);
		expect(text).not.toContain("CHUNK-00");
	});

	test("单块超限时按字节截头", () => {
		const ring = new BoundedRing(16);
		ring.push("a".repeat(64));
		const { text, droppedBytes } = ring.finalize();
		expect(Buffer.byteLength(text)).toBe(16);
		expect(droppedBytes).toBe(48);
		expect(text).toBe("a".repeat(16));
	});
});

describe("PtyBackend：常驻 bash 会话", () => {
	test("echo 基本执行与退出码", async () => {
		const backend = makeBackend();
		backend.spawn();
		const result = await backend.exec("echo hello");
		expect(result.stdout).toBe("hello\n");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.signal).toBeUndefined();
	}, 10_000);

	test("退出码透传（非零/失败/成功）", async () => {
		const backend = makeBackend();
		expect((await backend.exec("sh -c 'exit 7'")).exitCode).toBe(7);
		expect((await backend.exec("false")).exitCode).toBe(1);
		expect((await backend.exec("true")).exitCode).toBe(0);
	}, 10_000);

	test("stderr 独立捕获不混入 stdout", async () => {
		const backend = makeBackend();
		const result = await backend.exec("echo oops >&2; echo out");
		expect(result.stderr).toBe("oops\n");
		expect(result.stdout).toBe("out\n");
	}, 10_000);

	test("cd 跨命令持久（同一进程实例）", async () => {
		const backend = makeBackend();
		const first = await backend.exec("cd /tmp");
		expect(first.cwd).toBe("/tmp");
		const second = await backend.exec("pwd");
		expect(second.stdout).toBe("/tmp\n");
		expect(second.cwd).toBe("/tmp");
		expect(backend.cwd).toBe("/tmp");
	}, 10_000);

	test("子 shell 内 cd 不影响跟踪 cwd", async () => {
		const backend = makeBackend({ cwd: scratchDir });
		await backend.exec("(cd /)");
		const result = await backend.exec("pwd");
		expect(result.stdout).toBe(`${scratchDir}\n`);
	}, 10_000);

	test("export 跨命令持久", async () => {
		const backend = makeBackend();
		await backend.exec("export BI_PTY_PROBE=injected-value");
		const result = await backend.exec('printf "%s" "$BI_PTY_PROBE"');
		expect(result.stdout).toBe("injected-value");
	}, 10_000);

	test("构造 env 注入且不污染协议（剔除 BASH_ENV）", async () => {
		const backend = makeBackend({ env: { BI_PTY_ENV: "from-options" } });
		const result = await backend.exec('printf "%s" "$BI_PTY_ENV"');
		expect(result.stdout).toBe("from-options");
	}, 10_000);

	test("多行命令字符串完整执行", async () => {
		const backend = makeBackend();
		const result = await backend.exec("echo a\necho b\necho c");
		expect(result.stdout).toBe("a\nb\nc\n");
	}, 10_000);

	test("单引号/双引号混排转义无失真", async () => {
		const backend = makeBackend();
		const result = await backend.exec(`printf '%s\\n' "it's a test"`);
		expect(result.stdout).toBe("it's a test\n");
	}, 10_000);

	test("标记帧对用户输出不可见（精确相等 + 无 RS 字节）", async () => {
		const backend = makeBackend();
		const result = await backend.exec("echo visible");
		expect(result.stdout).toBe("visible\n");
		expect(result.stdout.includes("\x1e")).toBe(false);
		expect(result.stderr.includes("\x1e")).toBe(false);
	}, 10_000);

	test("onOutput 流式回调与最终 stdout 一致且无帧", async () => {
		const backend = makeBackend();
		const chunks: string[] = [];
		const result = await backend.exec("for i in 1 2 3; do echo n$i; done", {
			onOutput: (chunk) => chunks.push(chunk),
		});
		expect(chunks.join("")).toBe(result.stdout);
		expect(result.stdout).toBe("n1\nn2\nn3\n");
		for (const chunk of chunks) {
			expect(chunk.includes("\x1e")).toBe(false);
		}
	}, 10_000);

	test("UTF-8 多字节输出无失真", async () => {
		const backend = makeBackend();
		const result = await backend.exec("printf '中文abc——'");
		expect(result.stdout).toBe("中文abc——");
	}, 10_000);

	test("stdout 环形上限：64KB 封顶、丢头保尾、丢弃计数", async () => {
		const backend = makeBackend();
		const result = await backend.exec(
			"for i in $(seq 1 20000); do echo LINE-$i-0123456789; done",
		);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
			DEFAULT_PTY_OUTPUT_CAP_BYTES,
		);
		expect(result.stdoutDroppedBytes).toBeGreaterThan(0);
		expect(result.stdout).toContain("LINE-20000-0123456789");
		expect(result.stdout).not.toContain("LINE-1-0123456789");
	}, 15_000);

	test("超时：\\x03 未果后兜底击杀重建，会话恢复可用", async () => {
		const backend = makeBackend();
		const startedAt = Date.now();
		const timedOut = await backend.exec("sleep 30", { timeoutMs: 250 });
		const elapsed = Date.now() - startedAt;
		expect(timedOut.timedOut).toBe(true);
		expect(timedOut.exitCode).toBeUndefined();
		expect(elapsed).toBeLessThan(5_000);
		const revived = await backend.exec("echo revived");
		expect(revived.stdout).toBe("revived\n");
		expect(revived.exitCode).toBe(0);
	}, 15_000);

	test("超时重建后 cwd 由跟踪值恢复", async () => {
		const backend = makeBackend();
		await backend.exec("cd /tmp");
		await backend.exec("sleep 30", { timeoutMs: 200 });
		const result = await backend.exec("pwd");
		expect(result.stdout).toBe("/tmp\n");
	}, 15_000);

	test("用户命令 exit N：退出码透传且下次 exec 自愈重建", async () => {
		const backend = makeBackend();
		const dead = await backend.exec("exit 5");
		expect(dead.exitCode).toBe(5);
		expect(backend.alive).toBe(false);
		const healed = await backend.exec("echo rebuilt");
		expect(healed.stdout).toBe("rebuilt\n");
		expect(healed.exitCode).toBe(0);
	}, 10_000);

	test("读 stdin 的命令不偷协议流（stdin 重定向 /dev/null）", async () => {
		const backend = makeBackend();
		const cat = await backend.exec("cat");
		expect(cat.exitCode).toBe(0);
		const after = await backend.exec("echo protocol-intact");
		expect(after.stdout).toBe("protocol-intact\n");
	}, 10_000);

	test("后台任务迟到输出进入后续 exec 的 stdout 且不污染帧同步", async () => {
		const backend = makeBackend();
		// 后台子 shell 在 E 帧之后（约 250ms）才产出 "late-bg"
		const first = await backend.exec("(sleep 0.25; echo late-bg) & echo now");
		expect(first.stdout).toBe("now\n");
		// 第二条命令运行 400ms，迟到输出落在其窗口内，顺序保持 late-bg → third
		const second = await backend.exec("sleep 0.4; echo third");
		const lines = second.stdout.split("\n").filter((line) => line.length > 0);
		expect(lines).toEqual(["late-bg", "third"]);
	}, 15_000);

	test("并发 exec 在后端层亦串行（输出无交错）", async () => {
		const backend = makeBackend();
		const startedAt = Date.now();
		const results = await Promise.all([
			backend.exec("echo s1; sleep 0.15; echo e1"),
			backend.exec("echo s2; sleep 0.15; echo e2"),
		]);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(280);
		expect(results[0]?.stdout).toBe("s1\ne1\n");
		expect(results[1]?.stdout).toBe("s2\ne2\n");
	}, 15_000);

	test("dispose 整组击杀常驻 bash 且幂等、后续 exec 拒绝", async () => {
		const backend = makeBackend();
		backend.spawn();
		const pid = backend.pid;
		expect(pid).toBeGreaterThan(0);
		await backend.exec("echo ready");
		await backend.dispose();
		expect(backend.alive).toBe(false);
		expect(backend.pid).toBeUndefined();
		// 僵尸未收割窗口内 kill(pid,0) 仍返回成功，按 /proc 实际状态判定
		if (pid !== undefined) {
			expect(isProcessAlive(pid)).toBe(false);
		}
		await backend.dispose(); // 幂等
		expect(backend.exec("echo x")).rejects.toThrow(/dispose/);
	}, 10_000);

	test("空命令返回 0 且无输出", async () => {
		const backend = makeBackend();
		const result = await backend.exec("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	}, 10_000);

	test("默认常量房规：120s 超时 / 64KB 输出上限", () => {
		expect(DEFAULT_PTY_EXEC_TIMEOUT_MS).toBe(120_000);
		expect(DEFAULT_PTY_OUTPUT_CAP_BYTES).toBe(65_536);
	});
});
