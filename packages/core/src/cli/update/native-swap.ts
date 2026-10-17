/**
 * BI-20.7 —— 自升级引擎底层原语：staging 下载 / 二进制原子替换 / 安装锁。
 *
 * 三原语（全部可注入、零外部依赖）：
 *  1. stageDownload：fetch（可注入）流式下载到临时 staging 目录的 .part 文件，
 *     逐块累计 sha256（node:crypto），完成后校验期望哈希——不匹配删除 .part
 *     并抛结构化 hash-mismatch；匹配后原子 rename 为正式 staging 文件。
 *  2. swapBinary：Linux/macOS 原子替换语义——先 chmod 保证可执行位，再
 *     unlink(current)（ENOENT 宽容）→ rename(staged, current)。rename 不以写
 *     方式打开目标，天然规避「Text file busy」（ETXTBSY 只发生在对在跑二进制
 *     open(O_WRONLY) 时）；个别文件系统/挂载态仍可能报 EBUSY/ETXTBSY，此时
 *     短退避重试（默认 3 次 × 50ms，可注入时钟），重试耗尽抛 swap-busy，
 *     错误消息附带 doc 说明（勿用覆盖写，rename 才是原子面）。
 *  3. installLock：O_EXCL（flag:"wx"）锁文件 + { pid, ts } JSON，语义复用
 *     memory/dream.ts 房规——stale（超 staleMs，默认 1h）或内容不可解析可接管，
 *     他人持锁未过期返回 null；release 幂等。
 *
 * fs/now/pid/fetch 全部可注入；不读 references、不动既有文件。
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";

// ---------- 结构化错误 ----------

/** 升级域结构化错误码（判别：instanceof 或 code）。 */
export type UpgradeErrorCode =
	| "hash-mismatch"
	| "http-error"
	| "network-error"
	| "staged-missing"
	| "swap-failed"
	| "swap-busy"
	| "swap-permission"
	| "lock-held"
	| "aborted";

export class UpgradeError extends Error {
	readonly code: UpgradeErrorCode;
	readonly data?: unknown;

	constructor(code: UpgradeErrorCode, message: string, data?: unknown) {
		super(message);
		this.name = "UpgradeError";
		this.code = code;
		if (data !== undefined) {
			this.data = data;
		}
	}
}

// ---------- 常量与类型 ----------

/** 默认 staging 目录（进程临时目录下）。 */
export const DEFAULT_STAGING_DIR = nodePath.join(
	(() => {
		const tmp = typeof process !== "undefined" ? process.env["TMPDIR"] : undefined;
		return tmp !== undefined && tmp.length > 0 ? tmp : "/tmp";
	})(),
	"bi-upgrade-staging",
);

/** staging 文件下载中的临时后缀。 */
export const PART_SUFFIX = ".part";

/** installLock 默认 stale（可接管）阈值：与 dream.ts 房规一致（1 小时）。 */
export const DEFAULT_LOCK_STALE_MS = 60 * 60 * 1000;

/** stageDownload 选项。 */
export interface StageDownloadOptions {
	/** 期望 sha256（小写十六进制 64 位）；必填，无校验不落正式文件。 */
	sha256: string;
	/** fetch 替身（测试/代理注入；缺省全局 fetch）。 */
	fetchFn?: typeof fetch;
	/** staging 目录（缺省 DEFAULT_STAGING_DIR；不存在自动创建）。 */
	dir?: string;
	/** staging 文件名（缺省从 URL 路径末段推导）。 */
	fileName?: string;
	/** 协作取消信号。 */
	signal?: AbortSignal;
	/** fs 依赖替身（测试可注入；缺省 node:fs/promises 适配）。 */
	fs?: StageFs;
	/** rename 前赋给 staged 文件的权限模式（缺省 0o755，可执行位兜底）。 */
	mode?: number;
}

/** stageDownload 所需的最小 fs 面。 */
export interface StageFs {
	mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
	open(path: string, flags: string, mode?: number): Promise<{
		write(data: Uint8Array): Promise<unknown>;
		close(): Promise<unknown>;
	}>;
	readFile(path: string, encoding: "utf8"): Promise<string>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
	stat(path: string): Promise<{ isFile(): boolean; size: number }>;
	writeFile(path: string, data: string, opts?: { flag?: string }): Promise<void>;
}

/** 默认 fs 适配（node:fs/promises）。 */
export const DEFAULT_STAGE_FS: StageFs = {
	mkdir: (path, opts) => mkdir(path, opts),
	open: (path, flags, mode) => open(path, flags, mode),
	readFile: (path, encoding) => readFile(path, encoding),
	rename: (from, to) => rename(from, to),
	unlink: (path) => unlink(path),
	stat: (path) => stat(path),
	writeFile: (path, data, opts) => writeFile(path, data, opts),
};

export interface StagedDownload {
	/** staging 正式文件绝对路径。 */
	stagedPath: string;
	/** 字节数。 */
	bytes: number;
	/** 实测 sha256（与期望一致）。 */
	sha256: string;
}

/** 校验期望哈希形态（64 位小写十六进制）。 */
function assertSha256Shape(sha256: string): void {
	if (!/^[0-9a-f]{64}$/.test(sha256)) {
		throw new UpgradeError("hash-mismatch", `期望 sha256 形态非法: ${sha256}`, { sha256 });
	}
}

/** 从 URL 推导缺省文件名（路径末段；空段回退 staged-binary）。 */
function fileNameFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const last = parsed.pathname.split("/").filter(Boolean).pop();
		return last !== undefined && last.length > 0 ? last : "staged-binary";
	} catch {
		throw new UpgradeError("network-error", `URL 非法: ${url}`, { url });
	}
}

/**
 * 流式下载到 staging：.part 文件逐块写入并累计 sha256 → 校验 → 原子改名。
 * 校验不匹配删除 .part 并抛 hash-mismatch；HTTP 非 2xx 抛 http-error；
 * 网络层异常抛 network-error；以上失败均不留残file（.part 清理）。
 */
export async function stageDownload(
	url: string,
	opts: StageDownloadOptions,
): Promise<StagedDownload> {
	assertSha256Shape(opts.sha256);
	const fs = opts.fs ?? DEFAULT_STAGE_FS;
	const dir = opts.dir ?? DEFAULT_STAGING_DIR;
	const fileName = opts.fileName ?? fileNameFromUrl(url);
	const stagedPath = nodePath.join(dir, fileName);
	const partPath = `${stagedPath}${PART_SUFFIX}`;
	await fs.mkdir(dir, { recursive: true });

	let response: Response;
	try {
		response = await (opts.fetchFn ?? fetch)(url, {
			signal: opts.signal,
			headers: { accept: "application/octet-stream" },
		});
	} catch (cause) {
		throw new UpgradeError("network-error", `下载失败: ${String(cause)}`, { url, cause: String(cause) });
	}
	if (!response.ok) {
		throw new UpgradeError("http-error", `HTTP ${response.status}: ${url}`, {
			url,
			status: response.status,
		});
	}
	if (response.body === null) {
		throw new UpgradeError("network-error", "响应无 body", { url });
	}

	const handle = await fs.open(partPath, "w", opts.mode ?? 0o755);
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			if (opts.signal?.aborted) {
				throw new UpgradeError("aborted", "下载被取消", { url });
			}
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value !== undefined) {
				hash.update(value);
				bytes += value.byteLength;
				await handle.write(value);
			}
		}
		await handle.close();
	} catch (cause) {
		try {
			await handle.close();
		} catch {
			// 已关闭
		}
		await fs.unlink(partPath).catch(() => undefined); // 失败不留残file
		if (cause instanceof UpgradeError) {
			throw cause;
		}
		throw new UpgradeError("network-error", `读流失败: ${String(cause)}`, { url, cause: String(cause) });
	}

	const actual = hash.digest("hex");
	if (actual !== opts.sha256) {
		await fs.unlink(partPath).catch(() => undefined); // 哈希不匹配：删除即拒绝
		throw new UpgradeError("hash-mismatch", `sha256 不匹配：期望 ${opts.sha256}，实测 ${actual}`, {
			url,
			expected: opts.sha256,
			actual,
			bytes,
		});
	}
	await fs.rename(partPath, stagedPath); // .part → 正式 staging 文件（原子）
	return { stagedPath, bytes, sha256: actual };
}

// ---------- 二进制原子替换 ----------

export interface SwapOptions {
	/** rename 失败 EBUSY/ETXTBSY 的重试次数（缺省 3）。 */
	retries?: number;
	/** 重试退避毫秒（缺省 50；时钟可注入测试）。 */
	retryDelayMs?: number;
	/** 注入时钟（缺省 setTimeout）。 */
	sleep?: (ms: number) => Promise<void>;
	/** 权限模式（缺省 0o755：staged 必须可执行）。 */
	mode?: number;
	/** fs 替身（测试注入 EBUSY/EACCES 序列；缺省 node:fs/promises 适配）。 */
	fs?: SwapFs;
}

/** swapBinary 所需最小 fs 面。 */
export interface SwapFs {
	stat(path: string): Promise<{ isFile(): boolean; size: number }>;
	chmod(path: string, mode: number): Promise<void>;
	unlink(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}

/** 默认 swap fs 适配（node:fs/promises；chmod 失败宽容）。 */
export const DEFAULT_SWAP_FS: SwapFs = {
	stat: (path) => stat(path),
	chmod: async (path, mode) => {
		try {
			const { chmod } = await import("node:fs/promises");
			await chmod(path, mode);
		} catch {
			// 尽力而为：rename 仍可进行，仅可执行位可能缺失
		}
	},
	unlink: (path) => unlink(path),
	rename: (from, to) => rename(from, to),
};

/**
 * 原子替换当前二进制：
 *   chmod(staged, mode) → unlink(current)（ENOENT 宽容）→ rename(staged, current)。
 *
 * Text file busy（ETXTBSY）说明（doc）：
 *   ETXTBSY 仅在以写方式打开正在执行的二进制时出现；rename 对目标不是
 *   open-for-write，不触碰正文页缓存，因此本流程天然不触发。个别环境
 *   （网络文件系统/容器挂载层）rename 仍可能报 EBUSY/ETXTBSY——短退避重试，
 *   耗尽抛 swap-busy（绝不回退为「覆盖写」：那才是制造 ETXTBSY 的反模式）。
 */
export async function swapBinary(currentPath: string, stagedPath: string, opts: SwapOptions = {}): Promise<void> {
	const retries = opts.retries ?? 3;
	const retryDelayMs = opts.retryDelayMs ?? 50;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const fs = opts.fs ?? DEFAULT_SWAP_FS;
	const mode = opts.mode ?? 0o755;

	const staged = await fs.stat(stagedPath).catch(() => null);
	if (staged === null || !staged.isFile()) {
		throw new UpgradeError("staged-missing", `staged 文件不存在: ${stagedPath}`, { stagedPath });
	}
	await fs.chmod(stagedPath, mode);

	for (let attempt = 0; ; attempt++) {
		try {
			await fs.unlink(currentPath).catch((cause: unknown) => {
				const code = (cause as { code?: string }).code;
				if (code !== "ENOENT") {
					throw cause;
				}
			});
			await fs.rename(stagedPath, currentPath);
			return;
		} catch (cause) {
			const code = (cause as { code?: string }).code;
			if (code === "EACCES" || code === "EPERM") {
				throw new UpgradeError("swap-permission", `无权限替换 ${currentPath}`, {
					currentPath,
					stagedPath,
					cause: String(cause),
				});
			}
			const busy = code === "EBUSY" || code === "ETXTBSY";
			if (!busy || attempt >= retries) {
				if (busy) {
					throw new UpgradeError(
						"swap-busy",
						`替换 ${currentPath} 持续 EBUSY/ETXTBSY（Text file busy）：rename 是唯一原子面，` +
							`切勿以写方式覆盖在跑二进制；已重试 ${attempt + 1} 次`,
						{ currentPath, stagedPath, attempts: attempt + 1, cause: String(cause) },
					);
				}
				throw new UpgradeError("swap-failed", `替换失败: ${String(cause)}`, {
					currentPath,
					stagedPath,
					cause: String(cause),
				});
			}
			await sleep(retryDelayMs);
		}
	}
}

// ---------- 安装锁（dream.ts 房规语义） ----------

export interface InstallLockOptions {
	/** stale（可接管）阈值毫秒（缺省 DEFAULT_LOCK_STALE_MS = 1h）。 */
	staleMs?: number;
	/** 注入时钟（缺省 Date.now）。 */
	now?: () => number;
	/** 注入 pid（缺省 process.pid）。 */
	pid?: number;
	/** fs 替身（测试注入；缺省 node:fs/promises 适配）。 */
	fs?: LockFs;
}

/** installLock 所需最小 fs 面。 */
export interface LockFs {
	readFile(path: string, encoding: "utf8"): Promise<string>;
	writeFile(path: string, data: string, opts?: { flag?: string }): Promise<void>;
	unlink(path: string): Promise<void>;
}

/** 默认锁 fs 适配。 */
export const DEFAULT_LOCK_FS: LockFs = {
	readFile: (path, encoding) => readFile(path, encoding),
	writeFile: (path, data, opts) => writeFile(path, data, opts),
	unlink: (path) => unlink(path),
};

export interface InstallLockHandle {
	/** 锁文件绝对路径。 */
	path: string;
	/** 释放（幂等；重复调用安全）。 */
	release(): void;
}

/**
 * 原子获取安装锁（dream.ts acquireDreamLock 房规语义）：
 * O_EXCL（flag:"wx"）创建并写入 { pid, ts }；已存在且 stale
 * （now - ts > staleMs）或内容不可解析时接管；他人持锁未过期返回 null
 * （调用方以 lock-held 上报，本层不做轮询等待）。
 */
export async function installLock(
	path: string,
	opts: InstallLockOptions = {},
): Promise<InstallLockHandle | null> {
	const fs = opts.fs ?? DEFAULT_LOCK_FS;
	const now = opts.now ?? Date.now;
	const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
	const pid = opts.pid ?? process.pid;
	const payload = `${JSON.stringify({ pid, ts: now() })}\n`;

	let released = false;
	const handle: InstallLockHandle = {
		path,
		release(): void {
			if (released) {
				return; // 幂等
			}
			released = true;
			fs.unlink(path).catch(() => undefined); // 锁已被接管/清理：宽容
		},
	};

	try {
		await fs.writeFile(path, payload, { flag: "wx" }); // O_EXCL：互斥由原子创建保证
		return handle;
	} catch (cause) {
		if ((cause as { code?: string }).code !== "EEXIST") {
			throw cause;
		}
	}
	let existingTs: number | null = null;
	try {
		const parsed = JSON.parse(await fs.readFile(path, "utf8")) as { ts?: unknown };
		if (typeof parsed?.ts === "number" && Number.isFinite(parsed.ts)) {
			existingTs = parsed.ts;
		}
	} catch {
		existingTs = null; // 内容不可解析（含读失败）：按 stale 处置
	}
	if (existingTs !== null && now() - existingTs <= staleMs) {
		return null; // 他人持锁未过期
	}
	await fs.writeFile(path, payload); // stale 接管：覆写为己方锁
	return handle;
}
