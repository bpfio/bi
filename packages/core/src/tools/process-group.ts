import { readdirSync, readFileSync } from "node:fs";

/**
 * Linux PGID 进程组看门狗辅助层。
 *
 * 核心事实：POSIX 下 `kill(-pgid, sig)` 会把信号投递给整个进程组的所有成员
 * （组长、直接子进程、后台 job 孙进程），因此只需拿到组长 pid 即可整组击杀。
 * 僵尸进程（state=Z）对 `kill(pid, 0)` 表现为"存活"，本模块统一按 /proc 的
 * 实际状态判定，避免把僵尸误判为活进程导致看门狗空转。
 */

/** bash 执行器与看门狗只会使用的两种终止信号。 */
export type TerminationSignal = "SIGTERM" | "SIGKILL";

/**
 * 进程组看门狗依赖注入点：信号发送、时钟、休眠与 /proc 枚举均可替换，
 * 测试可注入假时钟/假成员列表实现零等待加速，后续工位（BI-06.3/06.7）复用时
 * 也可在此接入各自的进程管理设施。
 */
export interface ProcessGroupDeps {
	/** 向目标 pid 发送信号（目标可为负数表示进程组）；目标不存在时返回 false 而非抛错。 */
	sendSignal(pid: number, signal: TerminationSignal): boolean;
	/** 休眠指定毫秒。 */
	sleep(ms: number): Promise<void>;
	/** 单调时钟（毫秒），用于宽限期 deadline 计算。 */
	now(): number;
	/** 枚举 /proc 中属于指定进程组的存活（非僵尸）成员 pid。 */
	listGroupMembers(pgid: number): number[];
}

export interface KillProcessGroupOptions {
	/** SIGTERM 后等待进程组退出的宽限期（毫秒），超时仍未退出则升级 SIGKILL。默认 1500。 */
	graceMs?: number;
	/** 存活轮询间隔（毫秒）。默认 10。 */
	pollMs?: number;
	/** 依赖注入点，缺省使用真实信号与时钟。 */
	deps?: ProcessGroupDeps;
}

export interface KillProcessGroupResult {
	/** 进程组内已无存活成员。 */
	dead: boolean;
	/** SIGTERM 宽限期内未退尽、被迫升级 SIGKILL。 */
	escalated: boolean;
}

/** 默认真实依赖：process.kill + setTimeout + Date.now + /proc 扫描。 */
export const defaultProcessGroupDeps: ProcessGroupDeps = {
	sendSignal(pid, signal) {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	},
	sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
	listGroupMembers: listProcessGroupMembers,
};

interface ProcStat {
	/** 进程状态字符（R/S/D/Z/T/…），Z 为僵尸。 */
	state: string;
	/** 所属进程组 id。 */
	pgrp: number;
}

/**
 * 读取 /proc/<pid>/stat。注意 comm 字段是带括号且可含空格/括号的自由文本，
 * 必须以最后一个 `)` 为界切分，之后的字段依次是 state(3)、ppid(4)、pgrp(5)。
 */
function readProcStat(pid: number): ProcStat | undefined {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = raw.lastIndexOf(")");
		if (closeParen < 0) return undefined;
		const rest = raw
			.slice(closeParen + 1)
			.trim()
			.split(/\s+/);
		const state = rest[0];
		const pgrpRaw = rest[2];
		if (state === undefined || pgrpRaw === undefined) return undefined;
		const pgrp = Number(pgrpRaw);
		if (!Number.isInteger(pgrp)) return undefined;
		return { state, pgrp };
	} catch {
		// 进程恰好退出或 /proc 不可读：视为无法判定
		return undefined;
	}
}

/**
 * 扫描 /proc 找出属于指定进程组的全部存活（非僵尸）成员。
 * /proc 不可用时退化为仅检查组长是否存活。
 */
export function listProcessGroupMembers(pgid: number): number[] {
	try {
		const members: number[] = [];
		for (const entry of readdirSync("/proc")) {
			const pid = Number(entry);
			if (!Number.isInteger(pid) || pid <= 0) continue;
			const stat = readProcStat(pid);
			if (stat && stat.pgrp === pgid && stat.state !== "Z") members.push(pid);
		}
		return members;
	} catch {
		const leader = readProcStat(pgid);
		if (leader && leader.state !== "Z") return [pgid];
		try {
			process.kill(pgid, 0);
			return [pgid];
		} catch {
			return [];
		}
	}
}

/**
 * 判断进程是否"真正存活"：优先读 /proc 状态（僵尸计为死亡），
 * /proc 不可用时退化为 kill(pid, 0) 探测（EPERM 视为存活——存在但无权探查）。
 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const stat = readProcStat(pid);
	if (stat) return stat.state !== "Z";
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * 进程组击杀：向 `-pgid` 整组发 SIGTERM → 宽限期内轮询整组成员是否退尽 →
 * 仍有存活则升级 SIGKILL → 再次等待回收。全程不向组外进程发任何信号。
 *
 * 以组长 pid 作为 PGID 使用（detached 派生的子进程即组长）。
 */
export async function killProcessGroup(
	pid: number,
	options: KillProcessGroupOptions = {},
): Promise<KillProcessGroupResult> {
	const deps = options.deps ?? defaultProcessGroupDeps;
	const graceMs = options.graceMs ?? 1_500;
	const pollMs = options.pollMs ?? 10;
	const pgid = pid;

	deps.sendSignal(-pgid, "SIGTERM");
	let escalated = false;
	let deadline = deps.now() + graceMs;
	while (deps.listGroupMembers(pgid).length > 0 && deps.now() < deadline) {
		await deps.sleep(pollMs);
	}

	if (deps.listGroupMembers(pgid).length > 0) {
		escalated = true;
		deps.sendSignal(-pgid, "SIGKILL");
		deadline = deps.now() + graceMs;
		while (deps.listGroupMembers(pgid).length > 0 && deps.now() < deadline) {
			await deps.sleep(pollMs);
		}
	}

	return { dead: deps.listGroupMembers(pgid).length === 0, escalated };
}
