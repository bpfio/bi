import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	defaultProcessGroupDeps,
	isProcessAlive,
	killProcessGroup,
	listProcessGroupMembers,
} from "./process-group";
import type { ProcessGroupDeps } from "./process-group";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 派生独立进程组并确保退出后被回收（挂 exit 监听即 reap）。 */
function spawnGroupLeader(script: string) {
	const child = spawn("/bin/bash", ["-c", script], { detached: true, stdio: "ignore" });
	child.once("exit", () => {});
	return child;
}

describe("isProcessAlive", () => {
	test("自身进程存活", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	test("已退出的进程为死（含僵尸态不计活）", async () => {
		const child = spawn("/bin/bash", ["-c", "true"]);
		const pid = child.pid;
		expect(pid).toBeDefined();
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		expect(isProcessAlive(pid as number)).toBe(false);
	});

	test("非法输入直接判死", () => {
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(Number.NaN)).toBe(false);
	});
});

describe("listProcessGroupMembers", () => {
	test("能枚举出进程组内的 bash 与全部 sleep 成员", async () => {
		const child = spawnGroupLeader("sleep 30 & sleep 30; wait");
		const pid = child.pid;
		expect(pid).toBeDefined();
		try {
			await delay(120);
			const members = listProcessGroupMembers(pid as number);
			expect(members).toContain(pid as number);
			expect(members.length).toBeGreaterThanOrEqual(3);
		} finally {
			await killProcessGroup(pid as number, { graceMs: 300 });
		}
	});
});

describe("killProcessGroup", () => {
	test("SIGTERM 即可击杀整组：bash + 前台 sleep + 后台 job 全部死亡，无需升级", async () => {
		const child = spawnGroupLeader("sleep 30 & sleep 30; wait");
		const pid = child.pid;
		expect(pid).toBeDefined();
		await delay(120);
		const members = listProcessGroupMembers(pid as number);
		expect(members.length).toBeGreaterThanOrEqual(3);

		const result = await killProcessGroup(pid as number, { graceMs: 300 });
		expect(result.dead).toBe(true);
		expect(result.escalated).toBe(false);
		for (const member of members) {
			expect(isProcessAlive(member)).toBe(false);
		}
		expect(listProcessGroupMembers(pid as number)).toEqual([]);
	});

	test("SIGTERM 被忽略时宽限期后升级 SIGKILL", async () => {
		// trap "" TERM 使 bash 及其子进程（继承忽略 disposition）对 SIGTERM 免疫
		const child = spawnGroupLeader('trap "" TERM; sleep 30');
		const pid = child.pid;
		expect(pid).toBeDefined();
		await delay(120);
		const members = listProcessGroupMembers(pid as number);
		expect(members.length).toBeGreaterThanOrEqual(1);

		const result = await killProcessGroup(pid as number, { graceMs: 200 });
		expect(result.escalated).toBe(true);
		expect(result.dead).toBe(true);
		for (const member of members) {
			expect(isProcessAlive(member)).toBe(false);
		}
	});

	test("目标进程组已不存在时安全返回，不抛错", async () => {
		const child = spawn("/bin/bash", ["-c", "true"]);
		const pid = child.pid;
		expect(pid).toBeDefined();
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
		const result = await killProcessGroup(pid as number, { graceMs: 50 });
		expect(result.dead).toBe(true);
		expect(result.escalated).toBe(false);
	});

	test("deps 可注入：假时钟/假成员列表下零真实等待，信号序列可断言", async () => {
		const sent: string[] = [];
		let t = 0;
		let members: number[] = [999_001];
		const deps: ProcessGroupDeps = {
			sendSignal: (_pid, sig) => {
				sent.push(sig);
				return true;
			},
			sleep: async () => {
				t += 50;
			},
			now: () => t,
			listGroupMembers: () => members,
		};

		// 组一直存活：宽限耗尽后必须升级 SIGKILL，且最终如实回报 dead=false
		const escalated = await killProcessGroup(4242, { graceMs: 100, deps });
		expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
		expect(escalated.escalated).toBe(true);
		expect(escalated.dead).toBe(false);

		// 组已空：仅发 SIGTERM，立即返回
		members = [];
		sent.length = 0;
		t = 0;
		const clean = await killProcessGroup(4242, { graceMs: 100, deps });
		expect(sent).toEqual(["SIGTERM"]);
		expect(clean.escalated).toBe(false);
		expect(clean.dead).toBe(true);
	});

	test("defaultProcessGroupDeps.sendSignal 对不存在的 pid 返回 false 而非抛错", () => {
		expect(defaultProcessGroupDeps.sendSignal(999_999_999, "SIGTERM")).toBe(false);
	});
});
