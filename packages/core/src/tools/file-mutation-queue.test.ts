import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalPath,
	getQueueStats,
	resetFileMutationQueueForTests,
	withFileMutationQueue,
} from "./file-mutation-queue";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 手动放行的栅栏：观察"已开始"与"保持运行"两个时点。 */
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

let root = "";

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "bi-fmq-")));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

// 测试隔离的正规用法：每个用例开始前队列必须是一张白纸。
beforeEach(() => {
	resetFileMutationQueueForTests();
});

/** 建一个用例专属子目录，避免用例间共享键。 */
async function newCaseDir(name: string) {
	const dir = join(root, name);
	await mkdir(dir);
	return realpath(dir);
}

/** 注入延迟并统计并发峰值的写操作体。 */
function trackedWork(ms: number, counters: { inFlight: number; maxInFlight: number }) {
	return async () => {
		counters.inFlight += 1;
		counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
		await delay(ms);
		counters.inFlight -= 1;
	};
}

describe("canonicalPath", () => {
	test("已存在的文件解析为物理真实路径（与 fs.realpath 一致）", async () => {
		const dir = await newCaseDir("existing-file");
		const file = join(dir, "a.txt");
		await writeFile(file, "x");
		expect(await canonicalPath(file)).toBe(await realpath(file));
	});

	test("已存在的目录同样解析为物理路径", async () => {
		const dir = await newCaseDir("existing-dir");
		const sub = join(dir, "sub");
		await mkdir(sub);
		expect(await canonicalPath(sub)).toBe(await realpath(sub));
	});

	test("软链路径消解到目标物理路径", async () => {
		const dir = await newCaseDir("sym");
		const target = join(dir, "target.txt");
		await writeFile(target, "x");
		const link = join(dir, "link.txt");
		await symlink(target, link);
		expect(await canonicalPath(link)).toBe(await realpath(target));
		expect(await canonicalPath(link)).toBe(await canonicalPath(target));
	});

	test("不存在文件经软链祖先：软链被消解 + 余段拼接", async () => {
		const dir = await newCaseDir("sym-ancestor");
		const link = join(dir, "dirlink");
		await symlink(dir, link); // 指向自身的软链，便于断言
		const phantom = join(link, "not-yet.txt");
		expect(await canonicalPath(phantom)).toBe(join(dir, "not-yet.txt"));
	});

	test("不存在文件（祖先存在）：最近存在祖先 + 余段", async () => {
		const dir = await newCaseDir("ancestor");
		const phantom = join(dir, "new.txt");
		expect(await canonicalPath(phantom)).toBe(join(dir, "new.txt"));
	});

	test("多层不存在祖先全部保留在余段中", async () => {
		const dir = await newCaseDir("deep-missing");
		const phantom = join(dir, "m1", "m2", "f.txt");
		expect(await canonicalPath(phantom)).toBe(join(dir, "m1", "m2", "f.txt"));
	});

	test("含 . 与 .. 的写法折叠后再规范化", async () => {
		const dir = await newCaseDir("dotdot");
		const phantom = join(dir, "missing-sub", "..", "fresh.txt");
		expect(await canonicalPath(phantom)).toBe(join(dir, "fresh.txt"));
	});
});

describe("withFileMutationQueue", () => {
	test("返回值原样透传", async () => {
		const dir = await newCaseDir("passthrough");
		const file = join(dir, "f.txt");
		const value = await withFileMutationQueue(file, async () => ({ written: 42 }));
		expect(value).toEqual({ written: 42 });
	});

	test("异常原样透传到本次调用", async () => {
		const dir = await newCaseDir("reject");
		const file = join(dir, "f.txt");
		const boom = withFileMutationQueue(file, async () => {
			throw new Error("write-failed");
		});
		let message = "";
		try {
			await boom;
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toBe("write-failed");
	});

	test("同文件 5 个并发写按到达顺序串行完成", async () => {
		const dir = await newCaseDir("serial-order");
		const file = join(dir, "f.txt");
		const order: number[] = [];
		const counters = { inFlight: 0, maxInFlight: 0 };
		const ops = [0, 1, 2, 3, 4].map((i) =>
			withFileMutationQueue(file, async () => {
				counters.inFlight += 1;
				counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
				order.push(i);
				await delay(5);
				counters.inFlight -= 1;
				return i;
			}),
		);
		const results = await Promise.all(ops);
		expect(order).toEqual([0, 1, 2, 3, 4]);
		expect(counters.maxInFlight).toBe(1);
		expect(results).toEqual([0, 1, 2, 3, 4]);
	});

	test("串行链中 1 个抛错：其余照常执行，错误只落在对应调用", async () => {
		const dir = await newCaseDir("error-isolation");
		const file = join(dir, "f.txt");
		const executed: string[] = [];
		const outcomes = await Promise.all(
			[0, 1, 2, 3, 4].map((i) =>
				withFileMutationQueue(file, async () => {
					executed.push(String(i));
					await delay(3);
					if (i === 2) throw new Error(`boom-${i}`);
					return i * 10;
				}).then(
					(value) => ({ ok: true as const, value }),
					(error) => ({ ok: false as const, error }),
				),
			),
		);
		// 失败没有堵死队列：5 个全部按到达顺序执行
		expect(executed).toEqual(["0", "1", "2", "3", "4"]);
		for (const [i, outcome] of outcomes.entries()) {
			if (i === 2) {
				expect(outcome?.ok).toBe(false);
			} else {
				expect(outcome?.ok).toBe(true);
			}
		}
		const failed = outcomes[2];
		expect(failed && !failed.ok ? (failed.error as Error).message : "").toBe("boom-2");
		// 成功调用的返回值也原样
		expect(outcomes[0]?.ok && outcomes[0].ok ? outcomes[0].value : undefined).toBe(0);
		expect(outcomes[4]?.ok && outcomes[4].ok ? outcomes[4].value : undefined).toBe(40);
	});

	test("不同文件真并行：峰值并发 2，总耗时约等于单个而非求和", async () => {
		const dir = await newCaseDir("parallel");
		const counters = { inFlight: 0, maxInFlight: 0 };
		const started = Date.now();
		await Promise.all([
			withFileMutationQueue(join(dir, "a.txt"), trackedWork(150, counters)),
			withFileMutationQueue(join(dir, "b.txt"), trackedWork(150, counters)),
		]);
		const elapsed = Date.now() - started;
		expect(counters.maxInFlight).toBe(2); // 精确证明时间窗重叠
		expect(elapsed).toBeGreaterThanOrEqual(140);
		expect(elapsed).toBeLessThan(250); // 串行会 ≈300
	});

	test("异键不阻塞：长任务占用 A 键时 B 键短任务先完成", async () => {
		const dir = await newCaseDir("cross-key");
		const done: string[] = [];
		const slow = withFileMutationQueue(join(dir, "a.txt"), async () => {
			await delay(120);
			done.push("slow");
		});
		const quick = withFileMutationQueue(join(dir, "b.txt"), async () => {
			await delay(5);
			done.push("quick");
		});
		await Promise.all([slow, quick]);
		expect(done).toEqual(["quick", "slow"]);
	});

	test("软链路径与目标路径的写被同一队列串行（本原语核心价值）", async () => {
		const dir = await newCaseDir("sym-mutex");
		const target = join(dir, "target.txt");
		await writeFile(target, "x");
		const link = join(dir, "link.txt");
		await symlink(target, link);
		const counters = { inFlight: 0, maxInFlight: 0 };
		const started = Date.now();
		await Promise.all([
			withFileMutationQueue(link, trackedWork(80, counters)),
			withFileMutationQueue(target, trackedWork(80, counters)),
		]);
		const elapsed = Date.now() - started;
		expect(counters.maxInFlight).toBe(1); // 两条路径归一到同一物理键，绝不重叠
		expect(elapsed).toBeGreaterThanOrEqual(150); // 串行 2×80；若漏判并行会 ≈80
	});

	test("fn 同步抛错同样不堵死队列", async () => {
		const dir = await newCaseDir("sync-throw");
		const file = join(dir, "f.txt");
		const executed: string[] = [];
		const boom = withFileMutationQueue(file, () => {
			executed.push("boom");
			throw new Error("sync-boom");
		});
		const after = withFileMutationQueue(file, async () => {
			executed.push("after");
			return "fine";
		});
		let message = "";
		try {
			await boom;
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toBe("sync-boom");
		expect(await after).toBe("fine");
		expect(executed).toEqual(["boom", "after"]);
	});

	test("getQueueStats 反映排队深度，队列清空后自动回收条目", async () => {
		const dir = await newCaseDir("stats");
		const file = join(dir, "f.txt");
		const key = await canonicalPath(file);
		const started = deferred();
		const gate = deferred();
		const running = withFileMutationQueue(file, async () => {
			started.resolve();
			await gate.promise;
		});
		await started.promise; // 第一个操作已开始
		const queuedA = withFileMutationQueue(file, async () => {});
		const queuedB = withFileMutationQueue(file, async () => {});
		// 入队发生在 realpath 解析之后（异步）：并入同一路径的在途解析作为栅栏，
		// 其恢复时机排在队列自身的入队回调之后，保证此刻两个排队操作已入账。
		await canonicalPath(file);
		const stats = getQueueStats();
		expect(stats.activeKeys).toBe(1);
		expect(stats.pendingCounts.get(key)).toBe(2); // 两个排队未开始
		gate.resolve();
		await Promise.all([running, queuedA, queuedB]);
		await delay(2); // 等清理微任务走完
		const settled = getQueueStats();
		expect(settled.activeKeys).toBe(0);
		expect(settled.pendingCounts.size).toBe(0);
	});
});

describe("resetFileMutationQueueForTests", () => {
	test("reset 清空状态后，新提交不被旧链阻塞且统计重新从零计", async () => {
		const dir = await newCaseDir("reset");
		const file = join(dir, "f.txt");
		const events: string[] = [];
		const started = deferred();
		const gate = deferred();
		const running = withFileMutationQueue(file, async () => {
			events.push("s1");
			started.resolve();
			await gate.promise;
			events.push("e1");
		});
		await started.promise;
		const preReset = withFileMutationQueue(file, async () => {
			events.push("s2");
			events.push("e2");
		});
		// 与 stats 用例同理：并入在途路径解析作为栅栏，确保 preReset 此刻已真正入队，
		// 否则同步紧随的 reset 会抢在入队之前执行，测试就测不到目标语义。
		await canonicalPath(file);

		resetFileMutationQueueForTests();
		expect(getQueueStats().activeKeys).toBe(0); // 状态即时清空

		// reset 后的新提交立即执行，不等 reset 前的链
		const postReset = withFileMutationQueue(file, async () => {
			events.push("s3");
			events.push("e3");
		});
		await postReset;
		expect(events).toContain("e3");
		expect(events).not.toContain("e1"); // 栅栏仍关着，e1 未发生 → 新提交显然没等旧链
		expect(events).not.toContain("s2"); // reset 前已入队的 preReset 仍守旧链，未抢跑

		// reset 前已入队的操作不受干扰，仍按旧链完整执行
		gate.resolve();
		await Promise.all([running, preReset]);
		expect(events).toContain("s2");
		expect(events.indexOf("e2")).toBeGreaterThan(events.indexOf("e1"));

		// 新统计周期照常工作且结束后归零
		await withFileMutationQueue(file, async () => {});
		await delay(2);
		expect(getQueueStats().activeKeys).toBe(0);
	});
});
