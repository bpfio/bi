/**
 * @bi/mcp —— stdio 传输通道。
 *
 * spawn 子进程承载 MCP 服务器：stdin 写入 newline-delimited JSON-RPC，
 * stdout 逐行解析入站消息，stderr 捕获为有界诊断缓冲。
 * 进程退出时通知客户端（未决请求由客户端据此统一 reject），
 * 并按重启策略自动拉起新进程（SIGTERM→宽限→SIGKILL 逻辑自实现，
 * 不依赖任何跨包能力）。
 */
import type {
	JsonRpcMessage,
	McpTransport,
	RestartableTransport,
	StdioRestartEvent,
	TransportCloseEvent,
} from "../protocol";
import { LineSplitter, McpError, parseJsonRpcLine } from "../protocol";

/**
 * 重启策略：
 * - "never"：进程退出即终态（默认）；
 * - "once"：自动重启一次（立即拉起，无退避）；
 * - 对象形式：最多 maxRetries 次，每次间隔 backoffMs。
 */
export type RestartPolicy = "never" | "once" | { maxRetries: number; backoffMs: number };

export interface StdioTransportOptions {
	/** 服务器可执行命令（如 bun / node / uvx 的绝对或 PATH 可解析路径）。 */
	command: string;
	/** 命令参数。 */
	args?: string[];
	/**
	 * 子进程环境变量增量覆盖。缺省继承父进程完整环境；
	 * 传入时在 process.env 基础上合并（同名键以传入值为准）。
	 */
	env?: Record<string, string>;
	/** 子进程工作目录。 */
	cwd?: string;
	/** 重启策略，默认 "never"。 */
	restartPolicy?: RestartPolicy;
	/** 重启退避休眠注入点（测试加速用），缺省真实 setTimeout。 */
	restartBackoffSleep?: (ms: number) => Promise<void>;
	/** 优雅关闭宽限期毫秒数（SIGTERM→SIGKILL 的升级阈值），默认 5000。 */
	killGraceMs?: number;
	/** stderr 诊断缓冲上限（字节），默认 65536；超出后仅保留尾部并标记截断。 */
	maxStderrBytes?: number;
}

interface ResolvedRestartPolicy {
	maxRestarts: number;
	backoffMs: number;
}

function resolveRestartPolicy(policy: RestartPolicy): ResolvedRestartPolicy {
	if (policy === "never") {
		return { maxRestarts: 0, backoffMs: 0 };
	}
	if (policy === "once") {
		return { maxRestarts: 1, backoffMs: 0 };
	}
	if (
		typeof policy !== "object" ||
		!Number.isInteger(policy.maxRetries) ||
		policy.maxRetries < 0 ||
		!Number.isFinite(policy.backoffMs) ||
		policy.backoffMs < 0
	) {
		throw new McpError(
			"invalid-state",
			`非法重启策略: ${JSON.stringify(policy)}（要求 "never" | "once" | {maxRetries>=0, backoffMs>=0}）`,
		);
	}
	return { maxRestarts: policy.maxRetries, backoffMs: policy.backoffMs };
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** stdio 传输：一条传输实例对应一个（可能多次重启的）服务器进程。 */
export class StdioClientTransport implements McpTransport, RestartableTransport {
	private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
	private readonly messageCallbacks: Array<(message: JsonRpcMessage) => void> = [];
	private readonly closeCallbacks: Array<(event: TransportCloseEvent) => void> = [];
	private readonly restartCallbacks: Array<(event: StdioRestartEvent) => void> = [];
	private readonly stdoutSplitter = new LineSplitter();
	private readonly maxRestarts: number;
	private readonly restartBackoffMs: number;
	private readonly killGraceMs: number;
	private readonly maxStderrBytes: number;
	private readonly sleepImpl: (ms: number) => Promise<void>;

	private stderrTail = "";
	private stderrTruncated = false;
	private malformedCount = 0;
	private startedOnce = false;
	private closing = false;
	private terminalEmitted = false;
	private restartCount = 0;

	constructor(private readonly opts: StdioTransportOptions) {
		const resolved = resolveRestartPolicy(opts.restartPolicy ?? "never");
		this.maxRestarts = resolved.maxRestarts;
		this.restartBackoffMs = resolved.backoffMs;
		this.killGraceMs = opts.killGraceMs ?? 5000;
		this.maxStderrBytes = opts.maxStderrBytes ?? 65536;
		this.sleepImpl = opts.restartBackoffSleep ?? defaultSleep;
	}

	async start(): Promise<void> {
		if (this.startedOnce) {
			throw new McpError("invalid-state", "stdio 传输已启动过，重启请依赖 restartPolicy 或新建实例");
		}
		this.startedOnce = true;
		this.spawnProcess();
	}

	/** 发送一条消息：向子进程 stdin 写入一行 JSON（带换行）。 */
	async send(message: JsonRpcMessage): Promise<void> {
		const proc = this.proc;
		if (proc === null || proc.exitCode !== null) {
			throw new McpError("not-connected", "stdio 传输未连接（进程未启动或已退出）");
		}
		const line = `${JSON.stringify(message)}\n`;
		try {
			proc.stdin.write(line);
			proc.stdin.flush();
		} catch (cause) {
			throw new McpError("server-exited", "写入 stdin 失败（服务器进程可能已退出）", {
				cause: String(cause),
			});
		}
	}

	onMessage(callback: (message: JsonRpcMessage) => void): void {
		this.messageCallbacks.push(callback);
	}

	onClose(callback: (event: TransportCloseEvent) => void): void {
		this.closeCallbacks.push(callback);
	}

	/** 注册重启回调：新进程已拉起、等待客户端重新握手。 */
	onRestart(callback: (event: StdioRestartEvent) => void): void {
		this.restartCallbacks.push(callback);
	}

	/** stderr 诊断尾部（有界，最多 maxStderrBytes 字节）。 */
	getStderrTail(): string {
		return this.stderrTail;
	}

	/** stderr 是否发生过截断。 */
	isStderrTruncated(): boolean {
		return this.stderrTruncated;
	}

	/** 被跳过的畸形入站行数（含非 JSON 与非 JSON-RPC 行；空行不计）。 */
	getMalformedCount(): number {
		return this.malformedCount;
	}

	/** 子进程 pid（若在运行）。 */
	get pid(): number | undefined {
		const proc = this.proc;
		return proc !== null && proc.exitCode === null ? proc.pid : undefined;
	}

	/**
	 * 优雅关闭：SIGTERM → 宽限期 → SIGKILL，随后投递终态 close 事件。
	 * 宽限计时使用真实定时器（不受 restartBackoffSleep 注入影响）。
	 * 幂等：重复调用或与进程退出竞态时终态只投递一次。
	 */
	async close(): Promise<void> {
		this.closing = true;
		const proc = this.proc;
		if (proc !== null && proc.exitCode === null) {
			try {
				proc.kill("SIGTERM");
			} catch {
				// 进程恰在kill前退出：忽略
			}
			const graceDeadline = new Promise<boolean>((resolve) => {
				setTimeout(() => resolve(false), this.killGraceMs);
			});
			const exitedInGrace = await Promise.race([
				proc.exited.then(
					() => true,
					() => true,
				),
				graceDeadline,
			]);
			if (!exitedInGrace && proc.exitCode === null) {
				try {
					proc.kill("SIGKILL");
				} catch {
					// 同上
				}
			}
			await proc.exited;
		}
		this.emitTerminal({
			code: "closed",
			restarting: false,
			exitCode: proc?.exitCode ?? null,
			signal: proc?.signalCode ?? null,
		});
	}

	private spawnProcess(): void {
		let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
		try {
			proc = Bun.spawn({
				cmd: [this.opts.command, ...(this.opts.args ?? [])],
				env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
				cwd: this.opts.cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (cause) {
			throw new McpError(
				"spawn-failed",
				`无法启动 MCP 服务器进程: ${this.opts.command}`,
				{ cause: String(cause) },
			);
		}
		this.proc = proc;
		void this.pumpStdout(proc);
		void this.pumpStderr(proc);
		void this.watchExit(proc);
	}

	private async pumpStdout(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				for (const line of this.stdoutSplitter.push(decoder.decode(value, { stream: true }))) {
					this.dispatchLine(line);
				}
			}
			for (const line of this.stdoutSplitter.flush()) {
				this.dispatchLine(line);
			}
		} catch {
			// 流读失败即进程异常退出，交给 watchExit 处理
		}
	}

	private dispatchLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			return;
		}
		const parsed = parseJsonRpcLine(trimmed);
		if (!parsed.ok) {
			this.malformedCount++;
			return;
		}
		for (const callback of this.messageCallbacks) {
			callback(parsed.message);
		}
	}

	private async pumpStderr(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const reader = proc.stderr.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				this.appendStderr(decoder.decode(value, { stream: true }));
			}
		} catch {
			// 同 stdout：交给 watchExit
		}
	}

	private appendStderr(text: string): void {
		this.stderrTail += text;
		if (this.stderrTail.length > this.maxStderrBytes) {
			this.stderrTail = this.stderrTail.slice(this.stderrTail.length - this.maxStderrBytes);
			this.stderrTruncated = true;
		}
	}

	private async watchExit(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
		const exitCode = await proc.exited;
		if (this.proc !== proc || this.closing) {
			return; // 过期实例或 close() 接管终态
		}
		this.proc = null;
		await this.handleUnexpectedExit(proc, exitCode);
	}

	private async handleUnexpectedExit(
		proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
		exitCode: number,
	): Promise<void> {
		const signal = proc.signalCode ?? null;
		const detail = `MCP 服务器进程退出 (code=${exitCode}${signal === null ? "" : `, signal=${signal}`})`;
		if (this.restartCount < this.maxRestarts) {
			this.emitClose({
				code: "server-exited",
				restarting: true,
				exitCode,
				signal,
				message: `${detail}；将按 restartPolicy 自动重启`,
			});
			this.restartCount++;
			const attempt = this.restartCount;
			if (this.restartBackoffMs > 0) {
				await this.sleepImpl(this.restartBackoffMs);
			}
			if (this.closing || this.terminalEmitted) {
				return;
			}
			this.spawnProcess();
			const restarted = this.proc;
			for (const callback of this.restartCallbacks) {
				callback({ attempt, pid: restarted?.pid });
			}
			return;
		}
		const code = this.maxRestarts > 0 ? "restart-exhausted" : "server-exited";
		const message =
			code === "restart-exhausted"
				? `${detail}；重启次数（${this.maxRestarts}）已用尽`
				: detail;
		this.emitTerminal({ code, restarting: false, exitCode, signal, message });
	}

	private emitClose(event: TransportCloseEvent): void {
		for (const callback of this.closeCallbacks) {
			callback(event);
		}
	}

	private emitTerminal(event: TransportCloseEvent): void {
		if (this.terminalEmitted) {
			return;
		}
		this.terminalEmitted = true;
		this.emitClose(event);
	}
}
