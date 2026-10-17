import { PtyBackend } from "../terminal/pty-backend";
import type { PtyExecResult } from "../terminal/pty-backend";

/**
 * 持久交互式 Shell 工具层（BI-06.7）。
 *
 * 职责：在 PtyBackend（常驻 bash + RS 标记锚定协议）之上提供会话生命周期
 * { spawn, exec, reset, dispose } 与并发治理：
 * 1. cwd 跟踪：来自标记帧 $PWD（E 帧），cd 内建语义自然持久；
 * 2. env 持久：export 作用于同一常驻 bash 实例，自然保留
 *   （reset/超时重建例外——env 无法可靠快照，属持久会话已知取舍）；
 * 3. 并发 exec 排队：Promise 链串行（同文件房规），结果按提交顺序完成；
 * 4. 自愈：用户命令 `exit N` 杀死常驻 bash 后，结果透传 N，
 *   下一次 exec 惰性重建会话（cwd 恢复，env 丢失）。
 */

/** 单条命令执行选项。 */
export interface ShellExecOptions {
	/** 超时毫秒数；0 表示不设超时。默认 120_000。 */
	timeoutMs?: number;
	/** 流式输出回调（已剥离标记帧的用户文本）。 */
	onOutput?: (chunk: string, source: "stdout" | "stderr") => void;
	/** \x03 中断宽限毫秒数（测试加速用）。 */
	interruptGraceMs?: number;
}

/** 单条命令执行结果（标记帧对用户不可见）。 */
export interface ShellExecResult {
	stdout: string;
	stderr: string;
	/** 退出码；被信号终止或超时击杀时为 undefined。 */
	exitCode: number | undefined;
	/** 命令结束后的工作目录（标记帧跟踪值）。 */
	cwd: string;
	/** 是否因超时被中断（\x03 未果 → 兜底整组击杀 + 会话重建）。 */
	timedOut: boolean;
	signal: NodeJS.Signals | undefined;
	stdoutDroppedBytes: number;
	stderrDroppedBytes: number;
}

export interface PersistentShellOptions {
	/** 常驻 bash 初始工作目录，缺省继承当前进程。 */
	cwd?: string;
	/** 追加环境变量（在 process.env 基础上合并）。 */
	env?: Record<string, string | undefined>;
	/** 默认超时毫秒数。 */
	timeoutMs?: number;
	/** 单流输出缓冲上限（字节），默认 64KB 房规。 */
	maxOutputBytes?: number;
	/** 默认 \x03 中断宽限毫秒数。 */
	interruptGraceMs?: number;
}

/** PtyExecResult → ShellExecResult 的纯投影（字段同名透传）。 */
function toShellResult(result: PtyExecResult): ShellExecResult {
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		cwd: result.cwd,
		timedOut: result.timedOut,
		signal: result.signal,
		stdoutDroppedBytes: result.stdoutDroppedBytes,
		stderrDroppedBytes: result.stderrDroppedBytes,
	};
}

/**
 * 持久 Shell 会话。一个实例对应一个常驻 bash 进程；
 * exec 串行排队，dispose 后拒绝一切后续 exec。
 */
export class PersistentShell {
	private backend: PtyBackend | null = null;
	private queueTail: Promise<unknown> = Promise.resolve();
	private disposed = false;
	private readonly options: PersistentShellOptions;

	constructor(options: PersistentShellOptions = {}) {
		this.options = options;
	}

	/** 当前跟踪工作目录（标记帧 $PWD）。 */
	get cwd(): string {
		return this.backend?.cwd ?? this.options.cwd ?? process.cwd();
	}

	/** 常驻 bash pid；未 spawn 时为 undefined。 */
	get pid(): number | undefined {
		return this.backend?.pid;
	}

	/** 确保会话已派生（幂等）。 */
	spawn(): void {
		this.assertUsable();
		if (!this.backend) {
			this.backend = this.createBackend();
		}
		this.backend.spawn();
	}

	/**
	 * 执行一条命令。并发调用按提交顺序串行执行（Promise 链）；
	 * 任一命令失败不影响后续命令排队。
	 * backend 在调用时同步捕获：若延迟到队列推进时再取，dispose 置空后会
	 * 意外新建第二个常驻 bash（在途长命令挂死 dispose 的根因）。
	 */
	exec(cmd: string, options: ShellExecOptions = {}): Promise<ShellExecResult> {
		if (this.disposed) {
			return Promise.reject(new Error("PersistentShell 已 dispose，禁止再使用"));
		}
		const backend = this.ensureBackend();
		const run = this.queueTail.then(() =>
			backend.exec(cmd, options).then(toShellResult),
		);
		this.queueTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * 干净状态重建：整组击杀旧实例并回到构造时初始 cwd 重新派生。
	 * env 不保留（无法可靠快照），cwd 恢复到初始值（区别于超时重建的
	 * 「跟踪 cwd 恢复」语义——超时重建保持会话连续性，reset 是干净重置）。
	 */
	async reset(): Promise<void> {
		this.assertUsable();
		const backend = this.ensureBackend();
		const tail = this.queueTail.then(() => backend.reset());
		this.queueTail = tail.then(
			() => undefined,
			() => undefined,
		);
		await tail;
	}

	/**
	 * 终结会话：立即拒绝在途/排队 exec 并整组击杀常驻 bash。幂等。
	 * 注意必须先击杀再等队列——排队链依赖在途 exec 被拒绝才能继续推进，
	 * 若先等队列会与未设超时的在途命令互相等待形成死锁。
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const backend = this.backend;
		this.backend = null;
		if (backend) {
			await backend.dispose();
		}
		try {
			await this.queueTail;
		} catch {
			// 排队命令的拒绝属预期，不阻塞 dispose
		}
	}

	// ------------------------------------------------------------------

	private ensureBackend(): PtyBackend {
		if (!this.backend) {
			this.backend = this.createBackend();
		}
		return this.backend;
	}

	private createBackend(): PtyBackend {
		return new PtyBackend({
			cwd: this.options.cwd,
			env: this.options.env,
			timeoutMs: this.options.timeoutMs,
			maxOutputBytes: this.options.maxOutputBytes,
			interruptGraceMs: this.options.interruptGraceMs,
		});
	}

	private assertUsable(): void {
		if (this.disposed) {
			throw new Error("PersistentShell 已 dispose，禁止再使用");
		}
	}
}
