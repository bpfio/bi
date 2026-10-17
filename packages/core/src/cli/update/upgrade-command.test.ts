/**
 * BI-20.7 —— `bi upgrade` 流程编排测试：检查→下载→校验→替换 mock 全链 /
 * up-to-date 短路 / 锁互斥与 finally 释放 / checkOnly / 版本比较。
 */
import { describe, expect, test } from "bun:test";
import {
	UpgradeError,
	compareVersions,
	fetchJsonManifest,
	runUpgradeCommand,
} from "./upgrade-command";

// ---------- 脚手架：mock 全链 ----------

function makeChain(manifest: { version: string; url: string; sha256: string }) {
	const log: string[] = [];
	let released = false;
	return {
		log,
		released: () => released,
		checkFn: async (url: string) => {
			log.push(`check:${url}`);
			return { ...manifest };
		},
		lockFn: async (path: string) => {
			log.push(`lock:${path}`);
			return {
				path,
				release: () => {
					released = true;
					log.push(`release:${path}`);
				},
			};
		},
		downloadFn: async (url: string, opts: { sha256: string; dir?: string }) => {
			log.push(`download:${url}:${opts.sha256.slice(0, 8)}:${opts.dir ?? "default"}`);
			return { stagedPath: "/tmp/staging/bi.new", bytes: 1024, sha256: opts.sha256 };
		},
		swapFn: async (currentPath: string, stagedPath: string) => {
			log.push(`swap:${currentPath}<-${stagedPath}`);
		},
	};
}

const MANIFEST = { version: "0.2.0", url: "https://dl.example/bi-v2/bi", sha256: "a".repeat(64) };

// ---------- 流程编排 ----------

describe("runUpgradeCommand：流程编排（mock 全链）", () => {
	test("全链次序 check→lock→download→swap，updated 结果携带版本/字节/哈希", async () => {
		const chain = makeChain(MANIFEST);
		const outcome = await runUpgradeCommand({
			manifestUrl: "https://dl.example/manifest.json",
			currentVersion: "0.1.0",
			currentBinaryPath: "/usr/local/bin/bi",
			stagingDir: "/tmp/staging",
			checkFn: chain.checkFn,
			lockFn: chain.lockFn,
			downloadFn: chain.downloadFn,
			swapFn: chain.swapFn,
		});
		expect(outcome).toEqual({
			action: "updated",
			from: "0.1.0",
			to: "0.2.0",
			stagedPath: "/tmp/staging/bi.new",
			bytes: 1024,
			sha256: "a".repeat(64),
		});
		expect(chain.log).toEqual([
			"check:https://dl.example/manifest.json",
			"lock:/tmp/staging/bi-upgrade.lock",
			"download:https://dl.example/bi-v2/bi:aaaaaaaa:/tmp/staging",
			"swap:/usr/local/bin/bi<-/tmp/staging/bi.new",
			"release:/tmp/staging/bi-upgrade.lock",
		]);
		expect(chain.released()).toBe(true);
	});

	test("版本相同 → up-to-date 短路：不锁不下载不替换", async () => {
		const chain = makeChain(MANIFEST);
		const outcome = await runUpgradeCommand({
			manifestUrl: "u",
			currentVersion: "0.2.0",
			checkFn: chain.checkFn,
			lockFn: chain.lockFn,
			downloadFn: chain.downloadFn,
			swapFn: chain.swapFn,
		});
		expect(outcome).toEqual({ action: "up-to-date", currentVersion: "0.2.0", manifestVersion: "0.2.0" });
		expect(chain.log).toEqual(["check:u"]);
	});

	test("manifest 更旧 → 同样 up-to-date（不回退）", async () => {
		const chain = makeChain({ ...MANIFEST, version: "0.0.9" });
		const outcome = await runUpgradeCommand({
			manifestUrl: "u",
			currentVersion: "0.1.0",
			checkFn: chain.checkFn,
		});
		expect(outcome).toMatchObject({ action: "up-to-date", currentVersion: "0.1.0" });
	});

	test("checkOnly（--check 语义）→ checked 即止，不比较版本不下载", async () => {
		const chain = makeChain(MANIFEST);
		const outcome = await runUpgradeCommand({
			manifestUrl: "u",
			currentVersion: "9.9.9",
			checkOnly: true,
			checkFn: chain.checkFn,
			lockFn: chain.lockFn,
			downloadFn: chain.downloadFn,
			swapFn: chain.swapFn,
		});
		expect(outcome).toEqual({ action: "checked", manifest: MANIFEST });
		expect(chain.log).toEqual(["check:u"]);
	});

	test("他人持锁 → locked 结果：下载替换均未执行", async () => {
		const chain = makeChain(MANIFEST);
		const outcome = await runUpgradeCommand({
			manifestUrl: "u",
			currentVersion: "0.1.0",
			checkFn: chain.checkFn,
			lockFn: async (path) => {
				chain.log.push(`lock:${path}`);
				return null; // 他人持锁
			},
			downloadFn: chain.downloadFn,
			swapFn: chain.swapFn,
		});
		expect(outcome).toEqual({
			action: "locked",
			lockPath: "bi-upgrade.lock",
			manifestVersion: "0.2.0",
		});
		expect(chain.log).toEqual(["check:u", "lock:bi-upgrade.lock"]);
	});

	test("下载哈希失败 → UpgradeError 透传且锁仍被 finally 释放", async () => {
		const chain = makeChain(MANIFEST);
		let released = false;
		try {
			await runUpgradeCommand({
				manifestUrl: "u",
				currentVersion: "0.1.0",
				checkFn: chain.checkFn,
				lockFn: async () => ({ path: "lock", release: () => (released = true) }),
				downloadFn: async () => {
					throw new UpgradeError("hash-mismatch", "sha256 不匹配");
				},
				swapFn: chain.swapFn,
			});
			expect.unreachable();
		} catch (cause) {
			expect((cause as UpgradeError).code).toBe("hash-mismatch");
		}
		expect(released).toBe(true);
	});

	test("替换失败 → UpgradeError 透传且锁释放；swap 收到的是下载步产物路径", async () => {
		const chain = makeChain(MANIFEST);
		let released = false;
		const swappedPaths: Array<[string, string]> = [];
		try {
			await runUpgradeCommand({
				manifestUrl: "u",
				currentVersion: "0.1.0",
				currentBinaryPath: "/bin/bi",
				checkFn: chain.checkFn,
				lockFn: async () => ({ path: "lock", release: () => (released = true) }),
				downloadFn: async () => ({ stagedPath: "/tmp/s/bi.new", bytes: 1, sha256: MANIFEST.sha256 }),
				swapFn: async (current, staged) => {
					swappedPaths.push([current, staged]);
					throw new UpgradeError("swap-busy", "持续 EBUSY");
				},
			});
			expect.unreachable();
		} catch (cause) {
			expect((cause as UpgradeError).code).toBe("swap-busy");
		}
		expect(swappedPaths).toEqual([["/bin/bi", "/tmp/s/bi.new"]]);
		expect(released).toBe(true);
	});
});

// ---------- 版本比较 ----------

describe("compareVersions：零依赖轻量 semver", () => {
	test("逐段数字比较与 v 前缀宽容", () => {
		expect(compareVersions("0.2.0", "0.1.0")).toBe(1);
		expect(compareVersions("1.2.3", "1.10.0")).toBe(-1);
		expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
		expect(compareVersions("0.2", "0.2.0")).toBe(0);
		expect(compareVersions("2", "1.9.9")).toBe(1);
	});
});

// ---------- 缺省检查步（fetchJsonManifest） ----------

describe("fetchJsonManifest：缺省检查步", () => {
	test("Bun.serve 真链路：合法 manifest 解析 + kap 预留透传", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					JSON.stringify({
						version: "0.3.0",
						url: "https://dl.example/bi",
						sha256: "b".repeat(64),
						kap: { route: "stable" },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		});
		try {
			const manifest = await fetchJsonManifest(`http://localhost:${server.port}/manifest.json`);
			expect(manifest.version).toBe("0.3.0");
			expect(manifest.url).toBe("https://dl.example/bi");
			expect(manifest.sha256).toBe("b".repeat(64));
			expect(manifest.kap).toEqual({ route: "stable" });
		} finally {
			server.stop(true);
		}
	});

	test("HTTP 500 → http-error 形态错误", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
		try {
			await expect(fetchJsonManifest(`http://localhost:${server.port}/m`)).rejects.toMatchObject({
				code: "http-error",
			});
		} finally {
			server.stop(true);
		}
	});

	test("缺字段 manifest → http-error（最小契约校验）", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response(JSON.stringify({ version: "1.0" }), { status: 200 }),
		});
		try {
			await expect(fetchJsonManifest(`http://localhost:${server.port}/m`)).rejects.toMatchObject({
				code: "http-error",
			});
		} finally {
			server.stop(true);
		}
	});
});
