import { spawn as nodeSpawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessGroup, defaultProcessGroupDeps } from "./process-group";
import type { KillProcessGroupResult } from "./process-group";

/**
 * 受控 Bash 执行器。
 *
 * 设计要点：
 * 1. 以 `detached: true` 派生 /bin/bash，使其自成进程组（PGID = 子 pid），
 *   超时/取消时可对 `-pid` 整组击杀，孙进程（后台 job）一并终结，杜绝孤儿。
 * 2. stdout/stderr 走有界环形缓冲（默认各 1MB），超限从头部丢弃并计数，防内存膨胀；
 *   保留尾部保证 cwd 标记帧（位于输出最末）永远不被截掉。
 * 3. cwd 捕获：进程退出后 /proc/<pid>/cwd 已不可用，改为在命令尾部追加标记帧
 *   包装（先记录 `$?` 再打印 `$PWD`、最后 `exit` 还原退出码），从 stdout 尾部
 *   拆包剥离，对用户输出零污染。
 */

/** 默认超时：120 秒。 */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
/** 默认 SIGTERM → SIGKILL 宽限期：1500ms。 */
export const DEFAULT_BASH_KILL_GRACE_MS = 1_500;
/** 单个流（stdout/stderr 各自独立）的默认缓冲上限：1MB。 */
export const DEFAULT_BASH_MAX_OUTPUT_BYTES = 1_048_576;
/** 进程退出后等待 stdio 管道关闭的兜底时限：防止 daemon 化的孙进程持有管道导致挂起。 */
const DEFAULT_DRAIN_MS = 500;

/** ASCII RS（0x1E）作为标记帧定界符——正常文本输出几乎不可能出现。 */
const RS = "\x1e";
/** 标记帧版本前缀，格式：RS + "bi-cwd-v1:" + nonce + ":" + $PWD + RS。 */
const CWD_FRAME_PREFIX = "bi-cwd-v1:";

/** runBash 被外部 AbortSignal 取消时抛出的错误。 */
export class AbortError extends Error {
	constructor(message = "runBash 已被外部 AbortSignal 取消") {
		super(message);
		this.name = "AbortError";
	}
}

export interface RunBashOptions {
	/** 子进程工作目录，缺省继承当前进程。 */
	cwd?: string;
	/** 在继承 process.env 的基础上追加的环境变量。 */
	env?: Record<string, string | undefined>;
	/** 超时毫秒数，超时触发进程组击杀。默认 120_000；显式传 0 表示不设超时。 */
	timeoutMs?: number;
	/** 击杀宽限期（SIGTERM → 等待 → SIGKILL）。默认 1500。 */
	killGraceMs?: number;
	/** 单流输出缓冲上限（字节），超出环形丢弃并计数。默认 1MB。 */
	maxOutputBytes?: number;
	/** 外部取消信号；触发后整组击杀并以 killed 元数据返回（不 reject）。 */
	signal?: AbortSignal;
	/** @internal spawn 完成后同步回调（测试观测 pid 用）。 */
	onSpawn?: (pid: number | undefined) => void;
	/** @internal 依赖注入：spawn/时钟/击杀均可替换，测试加速用。 */
	deps?: RunBashDeps;
}

export interface RunBashDeps {
	/** 派生函数，默认 node:child_process#spawn。 */
	spawn?: typeof nodeSpawn;
	/** 单调时钟（毫秒），用于 durationMs 取样。 */
	now?: () => number;
	/** 击杀实现，默认复用 process-group#killProcessGroup。 */
	killProcessGroup?: typeof killProcessGroup;
}

export interface BashResult {
	/** 退出码；进程被信号终止时为 undefined（与 signal 互斥）。 */
	exitCode: number | undefined;
	/** 终止信号（实际观测到的那次）；正常退出为 undefined。 */
	signal: NodeJS.Signals | undefined;
	/** 用户 stdout（已剥离 cwd 标记帧）。 */
	stdout: string;
	/** 用户 stderr。 */
	stderr: string;
	/** stdout 环形缓冲丢弃的字节数。 */
	stdoutDroppedBytes: number;
	/** stderr 环形缓冲丢弃的字节数。 */
	stderrDroppedBytes: number;
	/** 最终工作目录：优先取标记帧捕获值；帧缺失（被信号击杀/exit 提前退出/exec 替换）时回退为初始 cwd。 */
	cwd: string;
	/** 从 spawn 到进程退出的耗时（毫秒）。 */
	durationMs: number;
	/** 是否由本执行器主动击杀（超时或外部取消）。 */
	killed: boolean;
	/** 是否因超时击杀（killed 的子集）。 */
	timedOut: boolean;
	/** 子进程（进程组组长）pid。 */
	pid: number | undefined;
}

/** 保留尾部的有界环形字节缓冲：超限从头部丢弃并累计丢弃量。 */
class BoundedRingBuffer {
	private chunks: Buffer[] = [];
	private size = 0;
	private droppedCount = 0;

	constructor(private readonly cap: number) {}

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.size += chunk.length;
		let overflow = this.size - this.cap;
		while (overflow > 0) {
			const head = this.chunks[0];
			if (head === undefined) break;
			if (overflow >= head.length) {
				this.chunks.shift();
				this.size -= head.length;
				this.droppedCount += head.length;
				overflow -= head.length;
			} else {
				this.chunks[0] = head.subarray(overflow);
				this.size -= overflow;
				this.droppedCount += overflow;
				overflow = 0;
			}
		}
	}

	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}

	get dropped(): number {
		return this.droppedCount;
	}
}

/** 组装发往 bash -c 的最终脚本：用户命令 + 换行 + cwd 标记帧包装。 */
export function buildBashScript(command: string, nonce: string): string {
	// 先取 $? 再打印 $PWD 最后 exit 还原退出码，保证包装不改变用户命令的退出语义；
	// 用换行而非分号衔接，规避用户命令以 &/&& 结尾时的语法冲突。
	const framePrefix = `${RS}${CWD_FRAME_PREFIX}${nonce}:`;
	const wrapper = `__bi_rc=$?; printf '${framePrefix}%s${RS}' "$PWD"; exit $__bi_rc`;
	return `${command}\n${wrapper}`;
}

/** 从 stdout 文本中定位并剥离 cwd 标记帧，返回最终 cwd 与用户净输出。 */
export function extractCwdFrame(
	stdoutText: string,
	nonce: string,
): { cwd: string | undefined; userOutput: string } {
	const marker = `${RS}${CWD_FRAME_PREFIX}${nonce}:`;
	const start = stdoutText.lastIndexOf(marker);
	if (start < 0) return { cwd: undefined, userOutput: stdoutText };
	const valueStart = start + marker.length;
	const end = stdoutText.indexOf(RS, valueStart);
	if (end < 0) return { cwd: undefined, userOutput: stdoutText };
	const cwd = stdoutText.slice(valueStart, end);
	const userOutput = stdoutText.slice(0, start) + stdoutText.slice(end + RS.length);
	return { cwd: cwd.length > 0 ? cwd : undefined, userOutput };
}

interface ExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
}

/**
 * 执行 bash 命令并返回结构化结果。
 *
 * - 进程组整组生命周期受控：超时/取消时 SIGTERM 全组 → 宽限 → SIGKILL 全组。
 * - stdin 恒为 ignore（关闭），不透传宿主输入。
 * - 取消语义：中途 abort 返回 killed 元数据而不抛错；spawn 前 signal 已 aborted 则抛 AbortError。
 */
export async function runBash(command: string, options: RunBashOptions = {}): Promise<BashResult> {
	const signal = options.signal;
	if (signal?.aborted) throw new AbortError();

	const timeoutMs = options.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
	const killGraceMs = options.killGraceMs ?? DEFAULT_BASH_KILL_GRACE_MS;
	const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_BASH_MAX_OUTPUT_BYTES;
	const initialCwd = options.cwd ?? process.cwd();
	const doKill = options.deps?.killProcessGroup ?? killProcessGroup;
	const doSpawn = options.deps?.spawn ?? nodeSpawn;
	const now = options.deps?.now ?? (() => Date.now());

	const nonce = randomUUID().replaceAll("-", "").slice(0, 16);
	const script = buildBashScript(command, nonce);

	const spawnOptions: SpawnOptions = {
		detached: true,
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		// stdin 恒关闭：不透传宿主输入，避免子进程挂起等待管道。
		stdio: ["ignore", "pipe", "pipe"] as const,
	};
	const startedAt = now();
	const child = doSpawn("/bin/bash", ["-c", script], spawnOptions);
	options.onSpawn?.(child.pid);

	const stdout = new BoundedRingBuffer(maxOutputBytes);
	const stderr = new BoundedRingBuffer(maxOutputBytes);
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

	// spawn 失败（如 /bin/bash 缺失）只会发 error 事件而无 exit 事件，必须显式接住。
	let spawnError: Error | undefined;
	const errorPromise = new Promise<void>((resolve) => {
		child.once("error", (error) => {
			spawnError = error;
			resolve();
		});
	});
	const exitPromise = new Promise<ExitInfo>((resolve) => {
		child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
	});
	// close 事件可能紧随 exit 甚至同 tick 触发（bun 实测如此），
	// 必须与 exit/error 监听一并前置挂载，错过即永久丢失（一次性事件）。
	const closePromise = new Promise<void>((resolve) => {
		child.once("close", () => resolve());
	});

	let killed = false;
	let timedOut = false;
	let killTask: Promise<KillProcessGroupResult> | undefined;
	const triggerKill = (cause: "timeout" | "abort"): void => {
		if (killTask !== undefined) return; // 超时与取消竞争时只击杀一次
		if (cause === "timeout") timedOut = true;
		killed = true;
		if (child.pid !== undefined) {
			killTask = doKill(child.pid, { graceMs: killGraceMs, deps: defaultProcessGroupDeps });
		}
	};

	const timer = timeoutMs > 0 ? setTimeout(() => triggerKill("timeout"), timeoutMs) : undefined;
	const onAbort = (): void => triggerKill("abort");
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const outcome = await Promise.race([
			exitPromise.then((exit) => ({ kind: "exit" as const, exit })),
			errorPromise.then(() => ({ kind: "error" as const })),
		]);
		if (outcome.kind === "error") {
			throw spawnError ?? new Error("bash 进程启动失败");
		}

		// 确认整组（含后台 job 孙进程）已被回收后再收尾输出流，
		// 这样管道写端全部关闭，close 事件能立即到达。
		if (killTask !== undefined) await killTask;

		const closed = await Promise.race([
			closePromise.then(() => true as const),
			defaultProcessGroupDeps.sleep(DEFAULT_DRAIN_MS).then(() => false as const),
		]);
		if (!closed) {
			// 极少数场景（用户命令 daemon 化并持有管道）：强制收尾，不无限等待。
			// 注意 bun 在 destroy 后不保证补发 close，这里也做有界等待。
			child.stdout?.destroy();
			child.stderr?.destroy();
			await Promise.race([
				closePromise,
				defaultProcessGroupDeps.sleep(DEFAULT_DRAIN_MS).then(() => undefined),
			]);
		}

		const { cwd: capturedCwd, userOutput } = extractCwdFrame(stdout.text(), nonce);
		return {
			exitCode: outcome.exit.code === null ? undefined : outcome.exit.code,
			signal: outcome.exit.signal ?? undefined,
			stdout: userOutput,
			stderr: stderr.text(),
			stdoutDroppedBytes: stdout.dropped,
			stderrDroppedBytes: stderr.dropped,
			cwd: capturedCwd ?? initialCwd,
			durationMs: now() - startedAt,
			killed,
			timedOut,
			pid: child.pid,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
