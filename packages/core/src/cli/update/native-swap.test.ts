/**
 * BI-20.7 —— 升级原语测试：staging 下载与哈希失败删除 / swap 原子语义（fixture）/
 * 锁互斥与 stale 接管 / EBUSY 重试与结构化错误。
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_LOCK_STALE_MS,
	UpgradeError,
	installLock,
	stageDownload,
	swapBinary,
} from "./native-swap";

// ---------- 脚手架 ----------

const dirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "bi-upgrade-test-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fetchOf(body: Uint8Array, status = 200): typeof fetch {
	return (async (_input: string | URL | Request, _init?: RequestInit) =>
		new Response(new Blob([new Uint8Array(body)]), {
			status,
		})) as unknown as typeof fetch;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// ---------- stageDownload ----------

describe("stageDownload：staging 下载与校验", () => {
	test("下载落盘 staging 文件，字节数与 sha256 返回值一致", async () => {
		const dir = await tempDir();
		const content = new TextEncoder().encode("#!/usr/bin/env sh\necho hi\n");
		const staged = await stageDownload("https://dl.example/bi-v2/bi", {
			sha256: sha256(content),
			dir,
			fetchFn: fetchOf(content),
		});
		expect(staged.bytes).toBe(content.byteLength);
		expect(staged.sha256).toBe(sha256(content));
		expect(staged.stagedPath).toBe(join(dir, "bi"));
		const onDisk = await readFile(staged.stagedPath);
		expect([...onDisk]).toEqual([...content]);
	});

	test("成功后无 .part 残留，staged 文件可执行位就绪", async () => {
		const dir = await tempDir();
		const content = new TextEncoder().encode("binary-bytes");
		const staged = await stageDownload("https://dl.example/x/agent.bin", {
			sha256: sha256(content),
			dir,
			fetchFn: fetchOf(content),
		});
		const info = await stat(staged.stagedPath);
		expect(info.isFile()).toBe(true);
		await expect(stat(`${staged.stagedPath}.part`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("sha256 不匹配 → hash-mismatch 且 .part 被删除（不落正式文件）", async () => {
		const dir = await tempDir();
		const content = new TextEncoder().encode("tampered-content");
		let caught: UpgradeError | undefined;
		try {
			await stageDownload("https://dl.example/bi", {
				sha256: "0".repeat(64),
				dir,
				fetchFn: fetchOf(content),
			});
		} catch (cause) {
			caught = cause as UpgradeError;
		}
		expect(caught?.code).toBe("hash-mismatch");
		expect((caught?.data as { actual?: string }).actual).toBe(sha256(content));
		await expect(stat(`${join(dir, "bi")}.part`)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(join(dir, "bi"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("HTTP 非 2xx → http-error，无任何文件落盘", async () => {
		const dir = await tempDir();
		let caught: UpgradeError | undefined;
		try {
			await stageDownload("https://dl.example/missing", {
				sha256: "0".repeat(64),
				dir,
				fetchFn: fetchOf(new TextEncoder().encode("nope"), 404),
			});
		} catch (cause) {
			caught = cause as UpgradeError;
		}
		expect(caught?.code).toBe("http-error");
		expect((caught?.data as { status?: number }).status).toBe(404);
		expect(await Array.fromAsync(new Bun.Glob("*").scan({ cwd: dir }))).toEqual([]);
	});

	test("fetch 抛网络异常 → network-error", async () => {
		const dir = await tempDir();
		const failing = (async (_input: string | URL | Request, _init?: RequestInit) => {
			throw new Error("ECONNRESET");
		}) as unknown as typeof fetch;
		try {
			await stageDownload("https://dl.example/x", {
				sha256: "0".repeat(64),
				dir,
				fetchFn: failing,
			});
			expect.unreachable();
		} catch (cause) {
			expect((cause as UpgradeError).code).toBe("network-error");
		}
	});

	test("fileName 注入覆盖 URL 推导；期望哈希形态非法即拒绝", async () => {
		const dir = await tempDir();
		const content = new TextEncoder().encode("named");
		const staged = await stageDownload("https://dl.example/weird/path?v=2", {
			sha256: sha256(content),
			dir,
			fileName: "custom-name",
			fetchFn: fetchOf(content),
		});
		expect(staged.stagedPath).toBe(join(dir, "custom-name"));
		const caught = await stageDownload("https://dl.example/x", {
			sha256: "zzz",
			dir,
			fetchFn: fetchOf(content),
		}).catch((cause: UpgradeError) => cause);
		expect(caught).toBeInstanceOf(UpgradeError);
		expect((caught as UpgradeError).code).toBe("hash-mismatch");
	});
});

// ---------- swapBinary ----------

describe("swapBinary：原子替换语义（fixture 文件）", () => {
	test("unlink→rename：current 变为新内容，staged 消失（移动而非拷贝）", async () => {
		const dir = await tempDir();
		const current = join(dir, "bi");
		const staged = join(dir, "bi.staged");
		await writeFile(current, "old-binary-v1");
		await writeFile(staged, "new-binary-v2");
		await swapBinary(current, staged);
		expect(await readFile(current, "utf8")).toBe("new-binary-v2");
		await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("current 不存在（ENOENT 宽容）→ 照常落位", async () => {
		const dir = await tempDir();
		const current = join(dir, "fresh");
		const staged = join(dir, "fresh.staged");
		await writeFile(staged, "first-install");
		await swapBinary(current, staged);
		expect(await readFile(current, "utf8")).toBe("first-install");
	});

	test("staged 缺失 → staged-missing，current 不被破坏", async () => {
		const dir = await tempDir();
		const current = join(dir, "bi");
		await writeFile(current, "keep-me");
		try {
			await swapBinary(current, join(dir, "ghost.staged"));
			expect.unreachable();
		} catch (cause) {
			expect((cause as UpgradeError).code).toBe("staged-missing");
		}
		expect(await readFile(current, "utf8")).toBe("keep-me");
	});

	test("staged 路径是目录 → staged-missing", async () => {
		const dir = await tempDir();
		const subdir = join(dir, "a-dir");
		await Bun.write(join(subdir, "placeholder"), "x");
		await expect(swapBinary(join(dir, "bi"), subdir)).rejects.toMatchObject({
			code: "staged-missing",
		});
	});

	test("EBUSY 重试：两次 busy 后成功（sleep 注入计数），最终落位", async () => {
		const dir = await tempDir();
		const current = join(dir, "bi");
		const staged = join(dir, "bi.staged");
		await writeFile(current, "old");
		await writeFile(staged, "new");
		let renameAttempts = 0;
		const sleeps: number[] = [];
		await swapBinary(current, staged, {
			fs: {
				stat: async () => ({ isFile: () => true, size: 3 }),
				chmod: async () => undefined,
				unlink: async () => undefined,
				rename: async (from, to) => {
					renameAttempts += 1;
					if (renameAttempts <= 2) {
						throw Object.assign(new Error("device or resource busy"), { code: "EBUSY" });
					}
					await writeFile(to, await readFile(from, "utf8"));
				},
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(renameAttempts).toBe(3);
		expect(sleeps).toEqual([50, 50]);
		expect(await readFile(current, "utf8")).toBe("new");
	});

	test("EBUSY 重试耗尽 → swap-busy，错误消息携带 Text file busy doc 说明", async () => {
		const dir = await tempDir();
		const busyError = () => Object.assign(new Error("text file busy"), { code: "ETXTBSY" });
		try {
			await swapBinary(join(dir, "bi"), join(dir, "staged"), {
				retries: 1,
				sleep: async () => undefined,
				fs: {
					stat: async () => ({ isFile: () => true, size: 3 }),
					chmod: async () => undefined,
					unlink: async () => undefined,
					rename: async () => {
						throw busyError();
					},
				},
			});
			expect.unreachable();
		} catch (cause) {
			const error = cause as UpgradeError;
			expect(error.code).toBe("swap-busy");
			expect(error.message).toContain("Text file busy");
			expect(error.message).toContain("rename");
		}
	});

	test("EACCES → 立即 swap-permission（不重试）", async () => {
		const dir = await tempDir();
		let attempts = 0;
		try {
			await swapBinary(join(dir, "bi"), join(dir, "staged"), {
				fs: {
					stat: async () => ({ isFile: () => true, size: 3 }),
					chmod: async () => undefined,
					unlink: async () => {
						attempts += 1;
						throw Object.assign(new Error("denied"), { code: "EACCES" });
					},
					rename: async () => undefined,
				},
			});
			expect.unreachable();
		} catch (cause) {
			expect((cause as UpgradeError).code).toBe("swap-permission");
		}
		expect(attempts).toBe(1);
	});
});

// ---------- installLock ----------

describe("installLock：O_EXCL 互斥 + stale 接管（dream.ts 房规）", () => {
	test("先手得锁；他人持锁未过期 → null（互斥）", async () => {
		const dir = await tempDir();
		const lockPath = join(dir, "bi-upgrade.lock");
		let now = 1_000_000;
		const first = await installLock(lockPath, { now: () => now });
		expect(first).not.toBeNull();
		const second = await installLock(lockPath, { now: () => now + 1 });
		expect(second).toBeNull();
		expect(await readFile(lockPath, "utf8")).toContain('"pid"');
		first!.release();
	});

	test("stale 锁（超 staleMs）→ 接管并覆写为己方", async () => {
		const dir = await tempDir();
		const lockPath = join(dir, "bi-upgrade.lock");
		let now = 2_000_000;
		const stale = await installLock(lockPath, { now: () => now, staleMs: DEFAULT_LOCK_STALE_MS });
		stale!.release();
		// 手工放一枚陈旧锁
		await writeFile(lockPath, `${JSON.stringify({ pid: 999, ts: now - DEFAULT_LOCK_STALE_MS - 1 })}\n`);
		now = 3_000_000;
		const taken = await installLock(lockPath, { now: () => now, staleMs: DEFAULT_LOCK_STALE_MS });
		expect(taken).not.toBeNull();
		const content = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number; ts: number };
		expect(content.ts).toBe(now);
		expect(content.pid).toBe(process.pid);
		taken!.release();
	});

	test("锁内容不可解析 → 按 stale 处置可接管", async () => {
		const dir = await tempDir();
		const lockPath = join(dir, "bi-upgrade.lock");
		await writeFile(lockPath, "not-json{");
		const handle = await installLock(lockPath, { now: () => 5_000_000 });
		expect(handle).not.toBeNull();
		handle!.release();
	});

	test("release 幂等：二次 release 不抛，锁文件消失后可重新获取", async () => {
		const dir = await tempDir();
		const lockPath = join(dir, "bi-upgrade.lock");
		const handle = await installLock(lockPath, { now: () => 7_000_000 });
		handle!.release();
		handle!.release(); // 幂等
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
		const again = await installLock(lockPath, { now: () => 7_000_001 });
		expect(again).not.toBeNull();
		again!.release();
	});
});
