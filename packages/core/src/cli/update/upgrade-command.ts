/**
 * BI-20.7 —— `bi upgrade` 处理器：检查 → 下载 → 校验 → 替换流程编排。
 *
 * 全步注入可测：manifest 检查（checkFn/fetchFn）、下载校验（downloadFn →
 * native-swap.stageDownload）、替换（swapFn → native-swap.swapBinary）、
 * 安装锁（lockFn → native-swap.installLock）均有注入点；缺省装配即真实链路。
 *
 * 流程：
 *   1. check：manifestUrl 拉取 JSON { version, url, sha256 }（--check 语义 =
 *      checkOnly，返回 manifest 即止，不下载不替换）；
 *   2. 版本比对（无依赖轻量 semver：数字段逐位比较；相等 → up-to-date 短路）；
 *   3. installLock：他人持锁 → 结果 locked（不阻塞不轮询）；
 *   4. stageDownload（内置 sha256 校验，不匹配删 .part）；
 *   5. swapBinary（unlink→rename 原子替换）→ release 锁 → updated。
 *
 * 任何一步抛 UpgradeError 都向上透传（结构化 code），锁在 finally 释放；
 * currentVersion/currentBinaryPath 注入（缺省 process.execPath）。
 */

import { installLock, stageDownload, swapBinary, type InstallLockHandle } from "./native-swap";

// ---------- manifest 与版本比较 ----------

/** 升级 manifest（最小契约；KAP 头协议兼容字段预留：manifest.kap 透传）。 */
export interface UpgradeManifest {
	version: string;
	url: string;
	sha256: string;
	/** KAP 兼容预留：透传不解读。 */
	kap?: unknown;
}

/** 轻量版本比较（零依赖）：数字段逐位比较，段数不齐补 0；非数字段按 0。 */
export function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/i, "").split(".");
	const pb = b.replace(/^v/i, "").split(".");
	const length = Math.max(pa.length, pb.length);
	for (let index = 0; index < length; index++) {
		const left = Number.parseInt(pa[index] ?? "0", 10) || 0;
		const right = Number.parseInt(pb[index] ?? "0", 10) || 0;
		if (left !== right) {
			return left < right ? -1 : 1;
		}
	}
	return 0;
}

// ---------- 编排选项与结果 ----------

export interface UpgradeOptions {
	/** manifest 地址（检查步输入）。 */
	manifestUrl: string;
	/** 当前版本（比对基准；缺省 "0.0.0"）。 */
	currentVersion?: string;
	/** 仅检查（--check 语义）：拉 manifest 即返回，不下载不替换。 */
	checkOnly?: boolean;
	/** 当前二进制路径（缺省 process.execPath）。 */
	currentBinaryPath?: string;
	/** staging 目录（透传 stageDownload）。 */
	stagingDir?: string;
	/** 安装锁文件路径（缺省 stagingDir 下 bi-upgrade.lock）。 */
	lockPath?: string;
	/** 注入：manifest 检查步（缺省 fetchJsonManifest）。 */
	checkFn?: (url: string) => Promise<UpgradeManifest>;
	/** 注入：下载校验步（缺省 native-swap.stageDownload 适配）。 */
	downloadFn?: (
		url: string,
		opts: { sha256: string; dir?: string },
	) => Promise<{ stagedPath: string; bytes: number; sha256: string }>;
	/** 注入：替换步（缺省 native-swap.swapBinary 适配）。 */
	swapFn?: (currentPath: string, stagedPath: string) => Promise<void>;
	/** 注入：锁步（缺省 native-swap.installLock 适配）。 */
	lockFn?: (path: string) => Promise<InstallLockHandle | null>;
}

export type UpgradeOutcome =
	| { action: "up-to-date"; currentVersion: string; manifestVersion: string }
	| { action: "checked"; manifest: UpgradeManifest }
	| {
			action: "locked";
			/** 他人持锁未获取：本次未执行（结构化上报，不阻塞）。 */
			lockPath: string;
			manifestVersion: string;
	  }
	| {
			action: "updated";
			from: string;
			to: string;
			stagedPath: string;
			bytes: number;
			sha256: string;
	  };

/** 缺省 manifest 检查步：fetch + JSON 解析 + 最小契约校验。 */
export async function fetchJsonManifest(url: string): Promise<UpgradeManifest> {
	const response = await fetch(url, { headers: { accept: "application/json" } });
	if (!response.ok) {
		throw Object.assign(new Error(`manifest HTTP ${response.status}: ${url}`), {
			code: "http-error" as const,
			status: response.status,
		});
	}
	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch (cause) {
		throw Object.assign(new Error(`manifest 非合法 JSON: ${String(cause)}`), {
			code: "http-error" as const,
		});
	}
	const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	const version = record["version"];
	const downloadUrl = record["url"];
	const sha256 = record["sha256"];
	if (typeof version !== "string" || typeof downloadUrl !== "string" || typeof sha256 !== "string") {
		throw Object.assign(new Error("manifest 缺字段（需要 version/url/sha256）"), {
			code: "http-error" as const,
			parsed,
		});
	}
	const manifest: UpgradeManifest = { version, url: downloadUrl, sha256 };
	if (record["kap"] !== undefined) {
		manifest.kap = record["kap"]; // KAP 头协议兼容：预留透传
	}
	return manifest;
}

/** `bi upgrade` 处理器：流程编排（全步注入，缺省走 native-swap 真实链路）。 */
export async function runUpgradeCommand(options: UpgradeOptions): Promise<UpgradeOutcome> {
	const checkFn = options.checkFn ?? fetchJsonManifest;
	const downloadFn =
		options.downloadFn ??
		((url: string, opts: { sha256: string; dir?: string }) =>
			stageDownload(url, { sha256: opts.sha256, dir: opts.dir }));
	const swapFn =
		options.swapFn ??
		((currentPath: string, stagedPath: string) => swapBinary(currentPath, stagedPath));
	const lockFn = options.lockFn ?? ((path: string) => installLock(path));

	const currentVersion = options.currentVersion ?? "0.0.0";
	const manifest = await checkFn(options.manifestUrl);

	if (options.checkOnly === true) {
		return { action: "checked", manifest };
	}
	if (compareVersions(manifest.version, currentVersion) <= 0) {
		return { action: "up-to-date", currentVersion, manifestVersion: manifest.version };
	}

	const stagingDir = options.stagingDir;
	const lockPath =
		options.lockPath ??
		(stagingDir !== undefined
			? `${stagingDir.replace(/\/$/, "")}/bi-upgrade.lock`
			: "bi-upgrade.lock");
	const lock = await lockFn(lockPath);
	if (lock === null) {
		return { action: "locked", lockPath, manifestVersion: manifest.version };
	}
	try {
		const staged = await downloadFn(manifest.url, { sha256: manifest.sha256, dir: stagingDir });
		const currentPath = options.currentBinaryPath ?? process.execPath;
		await swapFn(currentPath, staged.stagedPath);
		return {
			action: "updated",
			from: currentVersion,
			to: manifest.version,
			stagedPath: staged.stagedPath,
			bytes: staged.bytes,
			sha256: staged.sha256,
		};
	} finally {
		lock.release(); // 幂等：任何失败路径都释放
	}
}

// re-export：命令面单点引入
export { installLock, stageDownload, swapBinary, UpgradeError, type UpgradeErrorCode } from "./native-swap";
