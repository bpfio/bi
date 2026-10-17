import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killProcessGroup } from "../tools/process-group";

/**
 * 持久 PTY 交互式 Shell 后端（非交互降级实现）。
 *
 * 核心事实：Node/Bun 无内建 PTY（零外部 npm 依赖约束下不能用 node-pty），
 * 因此用「常驻 bash 子进程 + RS 标记锚定协议」模拟持久会话：
 *
 * 1. 常驻进程：spawn `/bin/bash --norc`（无 -c，stdin 持续注入命令行），
 *   同一进程实例内 cd/export/别名语义自然保留——这是与一次性 bash.ts 的本质差异。
 *   detached:true 使 bash 自成进程组（PGID = bash pid），dispose/reset 时可整组击杀。
 * 2. 标记锚定协议：每个命令包装为一行
 *   `printf '<RS><prefix>:<nonce>:S<RS>'; eval $'<转义命令>' </dev/null; printf '<RS><prefix>:<nonce>:E:%s:%s<RS>' "$?" "$PWD"`
 *   - S/E 起止标记把用户输出夹在中间，帧外文本（后台任务迟到输出）归入噪声、
 *     拼接为下一条 exec 的 stdout 前缀；
 *   - E 帧携带 `$?`（退出码透传）与 `$PWD`（cwd 跟踪，冒号路径安全：PWD 是末字段可含冒号）；
 *   - eval + ANSI-C 引号转义把语法错误（未闭合引号等）封锁在 eval 内部，
 *     不会吞掉后续标记行；</dev/null 防止用户命令偷读协议 stdin（如裸 `cat`）。
 * 3. 超时裁定（持久会话 vs 一次性执行的取舍）：一次性执行器（bash.ts）可对子进程
 *   组整组击杀；常驻会话杀组 = 杀会话本身，且向管道写 Ctrl+C 字节 \x03 对不读
 *   stdin 的前台命令（如 sleep）无效（实测：字节滞留管道，sleep 跑满全程）。
 *   故超时流程为：先按合约发送 \x03 + 短宽限 → 仍无 E 帧（兜底）则 killProcessGroup
 *   整组击杀并递增 epoch 重建干净会话：cwd 由跟踪值恢复，env 丢失（导出变量
 *   无法可靠快照，此为持久会话超时的已知代价），旧 epoch 标记帧全部丢弃防串扰。
 * 4. stdout/stderr 有界环形缓冲（默认 64KB 房规）：超限丢头部并计数，保尾部。
 */

/** 默认单命令超时：120 秒（与 bash.ts 房规对齐）；显式传 0 表示不设超时。 */
export const DEFAULT_PTY_EXEC_TIMEOUT_MS = 120_000;
/** 单流（stdout/stderr 各自独立）输出缓冲上限：64KB。 */
export const DEFAULT_PTY_OUTPUT_CAP_BYTES = 65_536;
/** 超时发送 \x03 后等待 E 帧的宽限毫秒数。 */
export const DEFAULT_PTY_INTERRUPT_GRACE_MS = 400;

/** ASCII RS（0x1E）帧定界符——保留字符，用户输出中的裸 RS 会破坏分帧。 */
const RS = "\x1e";
/** 标记帧前缀，完整帧形如 RS + "bi-pty-v1:<epoch>.<seq>:S|E[:exit][:pwd]" + RS。 */
const FRAME_PREFIX = "bi-pty-v1";

const sleep = (ms: number): Promise<void> =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 有界环形缓冲：按字节计量的尾部保留窗口。
 * 超限时从头部按整块丢弃并累计 droppedBytes；单块超限时按字节截头。
 */
export class BoundedRing {
	private chunks: string[] = [];
	private sizeBytes = 0;
	private dropped = 0;

	constructor(readonly capBytes: number) {
		if (!Number.isInteger(capBytes) || capBytes <= 0) {
			throw new Error(`BoundedRing capBytes 必须为正整数，收到 ${capBytes}`);
		}
	}

	/** 追加文本；超限从头部丢弃（保尾部，cwd 标记帧永远在尾部不被截掉）。 */
	push(text: string): void {
		if (text.length === 0) return;
		this.chunks.push(text);
		this.sizeBytes += Buffer.byteLength(text);
		while (this.sizeBytes > this.capBytes && this.chunks.length > 1) {
			const head = this.chunks.shift();
			if (head === undefined) break;
			const headBytes = Buffer.byteLength(head);
			this.sizeBytes -= headBytes;
			this.dropped += headBytes;
		}
		if (this.sizeBytes > this.capBytes && this.chunks.length > 0) {
			// 单块仍超限：按字节截头（可能产生一个替换符，属可接受损耗）
			const only = this.chunks[0] ?? "";
			const buf = Buffer.from(only);
			const excess = buf.length - this.capBytes;
			if (excess > 0) {
				this.sizeBytes = this.capBytes;
				this.dropped += excess;
				this.chunks = [buf.subarray(excess).toString("utf8")];
			}
		}
	}

	/** 取走全部缓冲并复位（按调用方语义拼接/计数）。 */
	finalize(): { text: string; droppedBytes: number } {
		const text = this.chunks.join("");
		const result = { text, droppedBytes: this.dropped };
		this.chunks = [];
		this.sizeBytes = 0;
		this.dropped = 0;
		return result;
	}
}

/** 单条命令的执行选项。 */
export interface PtyExecOptions {
	/** 超时毫秒数；超时触发 \x03 + 兜底整组击杀重建。默认 120_000；0 表示不设超时。 */
	timeoutMs?: number;
	/** 流式输出回调（已剥离标记帧的用户文本）。 */
	onOutput?: (chunk: string, source: "stdout" | "stderr") => void;
	/** \x03 后等待 E 帧的宽限毫秒数，默认 DEFAULT_PTY_INTERRUPT_GRACE_MS。 */
	interruptGraceMs?: number;
}

/** 单条命令的执行结果。 */
export interface PtyExecResult {
	/** 用户 stdout（已剥离标记帧，含前缀噪声拼接）。 */
	stdout: string;
	/** 用户 stderr。 */
	stderr: string;
	/** 退出码；被信号终止或超时击杀时为 undefined。 */
	exitCode: number | undefined;
	/** 命令结束后的工作目录（E 帧 $PWD 跟踪值）。 */
	cwd: string;
	/** 是否因超时被中断（\x03 未果 → 兜底击杀重建）。 */
	timedOut: boolean;
	/** 终止信号（实际观测到的那次）；正常结束为 undefined。 */
	signal: NodeJS.Signals | undefined;
	/** stdout 环形缓冲丢弃的字节数（含前缀噪声丢弃）。 */
	stdoutDroppedBytes: number;
	/** stderr 环形缓冲丢弃的字节数。 */
	stderrDroppedBytes: number;
}

export interface PtyBackendOptions {
	/** 常驻 bash 的初始工作目录，缺省继承当前进程。 */
	cwd?: string;
	/** 在继承 process.env 基础上追加的环境变量。 */
	env?: Record<string, string | undefined>;
	/** 默认超时毫秒数（可被 exec 逐条覆盖）。 */
	timeoutMs?: number;
	/** 单流输出缓冲上限（字节）。默认 64KB。 */
	maxOutputBytes?: number;
	/** 默认 \x03 中断宽限毫秒数。 */
	interruptGraceMs?: number;
	/** @internal spawn 注入点（测试加速用），缺省 node:child_process#spawn。 */
	spawnImpl?: typeof nodeSpawn;
}

/** exec 在途等待器的解析结论。 */
type ExecOutcome =
	| { kind: "frame"; exitCode: number }
	| { kind: "died"; exitCode?: number; signal?: NodeJS.Signals }
	| { kind: "interrupted" };

interface PendingExec {
	nonce: string;
	outRing: BoundedRing;
	errRing: BoundedRing;
	onOutput?: PtyExecOptions["onOutput"];
	timer: NodeJS.Timeout | undefined;
	resolve(outcome: ExecOutcome): void;
	reject(error: Error): void;
}

/**
 * E 帧后的 stderr 沉降窗（毫秒）。stdout 与 stderr 是两条独立管道，
 * bash 先写 stderr 再打 E 帧，但事件轮询的投递顺序不保证——若 E 帧一到
 * 就结算，尾部 stderr 可能被误归噪声。沉降窗内 pending 保持存活，
 * 迟到数据仍落入本命令的 ring（一次性执行器 bash.ts 无此问题：
 * 它等 close，天然全流冲刷；这是持久会话按帧结算的代价）。
 */
const STDERR_SETTLE_MS = 15;

/** ANSI-C ($'...') 引用的转义：反斜杠、单引号、换行、回车。 */
function escapeAnsiC(raw: string): string {
	return raw
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r");
}

/**
 * 常驻 bash 持久会话后端。非线程安全：exec 内部按 Promise 链串行，
 * 供上层 PersistentShell 排队调用。
 */
export class PtyBackend {
	private bash: ChildProcess | null = null;
	private pending: PendingExec | null = null;
	private outBuf = "";
	private outDecoder = new StringDecoder("utf8");
	private errDecoder = new StringDecoder("utf8");
	private noiseOut!: BoundedRing;
	private noiseErr!: BoundedRing;
	private epoch = 0;
	private seq = 0;
	private disposed = false;
	private trackedCwd: string;
	private readonly initialCwd: string;
	private readonly spawnImpl: typeof nodeSpawn;
	private readonly initialEnv: Record<string, string | undefined>;
	private readonly defaultTimeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly interruptGraceMs: number;
	private readonly exitHook: () => void;

	constructor(options: PtyBackendOptions = {}) {
		if (process.platform === "win32") {
			throw new Error("PtyBackend 仅支持 POSIX（需要 /bin/bash 与进程组语义）");
		}
		this.spawnImpl = options.spawnImpl ?? nodeSpawn;
		this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_PTY_EXEC_TIMEOUT_MS;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PTY_OUTPUT_CAP_BYTES;
		this.interruptGraceMs =
			options.interruptGraceMs ?? DEFAULT_PTY_INTERRUPT_GRACE_MS;
		this.trackedCwd = options.cwd ?? process.cwd();
		this.initialCwd = this.trackedCwd;
		this.noiseOut = new BoundedRing(this.maxOutputBytes);
		this.noiseErr = new BoundedRing(this.maxOutputBytes);
		const { BASH_ENV: _bashEnv, ...mergedEnv } = { ...process.env, ...options.env };
		this.initialEnv = mergedEnv;
		// 兜底清道夫：宿主进程退出时同步击杀常驻 bash，防测试进程悬挂
		this.exitHook = () => {
			const proc = this.bash;
			if (proc?.pid) {
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					// 已退出：忽略
				}
			}
		};
		process.on("exit", this.exitHook);
	}

	/** 常驻 bash 的 pid；未 spawn 或已死亡时为 undefined。 */
	get pid(): number | undefined {
		return this.bash?.pid;
	}

	/** 跟踪的工作目录（E 帧 $PWD 或初始值）。 */
	get cwd(): string {
		return this.trackedCwd;
	}

	/** 常驻 bash 是否存活。 */
	get alive(): boolean {
		return this.bash !== null;
	}

	/** 确保常驻 bash 已派生（幂等）；已存活时无操作。 */
	spawn(): void {
		if (this.disposed) throw new Error("PtyBackend 已 dispose，禁止再 spawn");
		if (this.bash) return;
		this.spawnBash();
	}

	/**
	 * 执行一条命令（会话内串行由上层保证；此处再兜底串行）。
	 * cd/export 等 shell 内建语义作用于常驻 bash 实例，自然持久。
	 */
	exec(cmd: string, options: PtyExecOptions = {}): Promise<PtyExecResult> {
		const run = this.queueTail.then(
			() => this.#execNow(cmd, options),
			() => this.#execNow(cmd, options),
		);
		this.queueTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
	private queueTail: Promise<unknown> = Promise.resolve();

	/**
	 * 干净状态重建：cwd 回到构造时初始值、env 清零，旧实例整组击杀。
	 * 先同步重建新 bash 再异步击杀旧组——若先 await 击杀，排队中的 exec
	 * 会在空窗期 ensureAlive 触发第二次 spawn，产生孤儿常驻进程。
	 */
	async reset(): Promise<void> {
		if (this.disposed) throw new Error("PtyBackend 已 dispose，禁止 reset");
		const waiter = this.pending;
		this.pending = null;
		waiter?.reject(new Error("PtyBackend reset 打断了在途 exec"));
		const proc = this.bash;
		this.bash = null;
		this.trackedCwd = this.initialCwd;
		this.spawnBash();
		this.epoch += 1; // 旧实例残帧全部作废
		if (proc?.pid) {
			await killProcessGroup(proc.pid);
		}
	}

	/** 终结会话：拒绝在途 exec、整组击杀常驻 bash。幂等。 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		process.off("exit", this.exitHook);
		await this.killCurrent();
	}

	// ------------------------------------------------------------------

	private spawnBash(): void {
		const spawnOptions: SpawnOptions = {
			detached: true, // bash 自成进程组（PGID = pid），整组击杀依赖此语义
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.trackedCwd,
			env: this.initialEnv,
		};
		const proc = this.spawnImpl("/bin/bash", ["--norc"], spawnOptions);
		this.bash = proc;
		this.outBuf = "";
		this.outDecoder = new StringDecoder("utf8");
		this.errDecoder = new StringDecoder("utf8");
		// 进程死亡瞬间的 EPIPE 属预期路径（exec 会被 close/error 收尾），静默吸收
		proc.stdin?.on("error", () => {});
		proc.stdout?.on("data", (chunk: Buffer) => {
			this.feedStdout(chunk);
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			this.feedStderr(chunk);
		});
		proc.on("error", (error: Error) => {
			// spawn 失败（如 /bin/bash 缺失）：拒绝在途 exec 并标记死亡
			if (this.bash === proc) this.bash = null;
			const waiter = this.pending;
			if (waiter) {
				this.pending = null;
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
		});
		proc.on("close", (code, signal) => {
			if (this.bash !== proc) return; // 旧实例的迟到事件
			this.bash = null;
			const waiter = this.pending;
			if (waiter) {
				this.pending = null;
				clearTimeout(waiter.timer);
				waiter.resolve({
					kind: "died",
					exitCode: code ?? undefined,
					signal: signal ?? undefined,
				});
			}
		});
	}

	private async killCurrent(): Promise<void> {
		const waiter = this.pending;
		this.pending = null;
		if (waiter) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("PtyBackend 已 dispose，在途 exec 被拒绝"));
		}
		const proc = this.bash;
		this.bash = null;
		if (proc?.pid) {
			await killProcessGroup(proc.pid);
		}
	}

	private ensureAlive(): void {
		if (this.disposed) throw new Error("PtyBackend 已 dispose");
		if (!this.bash) this.spawnBash(); // 自愈：死亡/被 exit 后惰性重建
	}

	async #execNow(cmd: string, options: PtyExecOptions): Promise<PtyExecResult> {
		this.ensureAlive();
		const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
		const graceMs = options.interruptGraceMs ?? this.interruptGraceMs;
		const seq = ++this.seq;
		const nonce = `${this.epoch}.${seq}`;
		const outRing = new BoundedRing(this.maxOutputBytes);
		const errRing = new BoundedRing(this.maxOutputBytes);
		// 上一条命令结束后、本条 S 帧之前的迟到输出：拼为本条 stdout 前缀
		const carriedOut = this.noiseOut.finalize();
		const carriedErr = this.noiseErr.finalize();

		const line =
			`printf '${RS}${FRAME_PREFIX}:${nonce}:S${RS}'; ` +
			`eval $'${escapeAnsiC(cmd)}' </dev/null; ` +
			`printf '${RS}${FRAME_PREFIX}:${nonce}:E:%s:%s${RS}' "$?" "$PWD"\n`;

		const outcome = await new Promise<ExecOutcome>((resolve, reject) => {
			const waiter: PendingExec = {
				nonce,
				outRing,
				errRing,
				onOutput: options.onOutput,
				timer: undefined,
				resolve,
				reject,
			};
			this.pending = waiter;
			const proc = this.bash;
			if (!proc?.stdin) {
				this.pending = null;
				reject(new Error("常驻 bash stdin 不可写"));
				return;
			}
			proc.stdin.write(line);
			if (timeoutMs > 0) {
				waiter.timer = setTimeout(() => {
					void this.onTimeout(waiter, graceMs);
				}, timeoutMs);
				waiter.timer.unref();
			}
		});

		if (outcome.kind === "frame") {
			// stderr 沉降窗：pending 存活期间迟到 stderr 落入本命令 errRing
			await sleep(STDERR_SETTLE_MS);
		}
		if (this.pending?.nonce === nonce) {
			this.pending = null;
		}

		const out = outRing.finalize();
		const err = errRing.finalize();
		if (outcome.kind === "interrupted") {
			// 兜底击杀重建已发生（epoch 已递增）；cwd 用跟踪值，env 已丢失
			return {
				stdout: carriedOut.text + out.text,
				stderr: carriedErr.text + err.text,
				exitCode: undefined,
				cwd: this.trackedCwd,
				timedOut: true,
				signal: "SIGKILL",
				stdoutDroppedBytes: carriedOut.droppedBytes + out.droppedBytes,
				stderrDroppedBytes: carriedErr.droppedBytes + err.droppedBytes,
			};
		}

		return {
			stdout: carriedOut.text + out.text,
			stderr: carriedErr.text + err.text,
			exitCode: outcome.exitCode,
			cwd: this.trackedCwd,
			timedOut: false,
			signal: outcome.kind === "died" ? outcome.signal : undefined,
			stdoutDroppedBytes: carriedOut.droppedBytes + out.droppedBytes,
			stderrDroppedBytes: carriedErr.droppedBytes + err.droppedBytes,
		};
	}

	/**
	 * 超时裁定：先按合约发送 Ctrl+C 字节 \x03（对读取 stdin 的前台命令有效，
	 * 对 sleep 类命令实测无效——字节滞留管道）；宽限期内仍无 E 帧则整组击杀
	 * （killProcessGroup，SIGTERM→SIGKILL 升级）并递增 epoch 重建干净会话。
	 * 重建代价：env 丢失、cwd 由跟踪值恢复——此为持久会话与一次性执行的取舍。
	 */
	private async onTimeout(waiter: PendingExec, graceMs: number): Promise<void> {
		if (this.pending !== waiter) return; // 已结算/已重建
		const proc = this.bash;
		proc?.stdin?.write("\x03\n");
		await sleep(graceMs);
		if (this.pending !== waiter) return; // 宽限期内命令自然结束
		this.pending = null;
		clearTimeout(waiter.timer);
		const current = this.bash;
		this.bash = null;
		if (current?.pid) {
			await killProcessGroup(current.pid);
		}
		this.epoch += 1; // 旧 epoch 标记帧全部作废
		waiter.resolve({ kind: "interrupted" });
	}

	private feedStdout(chunk: Buffer): void {
		// StringDecoder 处理多字节字符跨 chunk 的增量解码
		this.outBuf += this.outDecoder.write(chunk);
		// 防失控输出撑爆缓冲：帧间噪声由 BoundedRing 兜底，此处仅防部分帧滞留
		if (this.outBuf.length > 1_048_576) {
			const keepFrom = this.outBuf.lastIndexOf(RS);
			const flushTo = keepFrom < 0 ? this.outBuf.length : keepFrom;
			this.emitUserText(this.outBuf.slice(0, flushTo));
			this.outBuf = this.outBuf.slice(flushTo);
		}
		this.pump();
	}

	private feedStderr(chunk: Buffer): void {
		const text = this.errDecoder.write(chunk);
		const waiter = this.pending;
		if (waiter) {
			waiter.errRing.push(text);
			waiter.onOutput?.(text, "stderr");
		} else {
			this.noiseErr.push(text);
		}
	}

	/** 扫描 stdout 流，拆出标记帧，剩余文本路由到在途 exec 或噪声缓冲。 */
	private pump(): void {
		const marker = RS + FRAME_PREFIX + ":";
		for (;;) {
			const buf = this.outBuf;
			const start = buf.indexOf(marker);
			if (start < 0) {
				// 无完整帧：只保留最后一个 RS 起的尾巴（防帧跨块被当作用户文本冲走）
				const keepFrom = buf.lastIndexOf(RS);
				const flushTo = keepFrom < 0 ? buf.length : keepFrom;
				if (flushTo > 0) this.emitUserText(buf.slice(0, flushTo));
				this.outBuf = flushTo < buf.length ? buf.slice(flushTo) : "";
				return;
			}
			const end = buf.indexOf(RS, start + marker.length);
			if (end < 0) {
				// 帧未收全：帧前文本先下发，帧体滞留等待后续块
				if (start > 0) this.emitUserText(buf.slice(0, start));
				this.outBuf = buf.slice(start);
				return;
			}
			if (start > 0) this.emitUserText(buf.slice(0, start));
			const payload = buf.slice(start + marker.length, end);
			this.outBuf = buf.slice(end + RS.length);
			this.handleFrame(payload);
		}
	}

	private emitUserText(text: string): void {
		if (text.length === 0) return;
		const waiter = this.pending;
		if (waiter) {
			waiter.outRing.push(text);
			waiter.onOutput?.(text, "stdout");
		} else {
			this.noiseOut.push(text);
		}
	}

	private handleFrame(payload: string): void {
		const parts = payload.split(":");
		const nonce = parts[0];
		const type = parts[1];
		if (nonce === undefined || type === undefined) return;
		if (!nonce.startsWith(`${this.epoch}.`)) return; // 旧 epoch 残帧：丢弃
		const waiter = this.pending;
		if (!waiter || nonce !== waiter.nonce) return; // 未知序号：丢弃
		if (type === "E") {
			const exitRaw = parts[2] ?? "";
			const exitCode = Number(exitRaw);
			const pwdParts = parts.slice(3);
			const pwd = pwdParts.join(":"); // PWD 是末字段，目录名可含冒号
			if (pwd.length > 0) this.trackedCwd = pwd;
			clearTimeout(waiter.timer);
			// 不在此处清 pending：#execNow 的 stderr 沉降窗结束后统一清理
			waiter.resolve({ kind: "frame", exitCode });
		}
		// type === "S"：起标记仅作锚定校验，不改变状态机
	}
}
