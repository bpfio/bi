/**
 * BI-07.5 测试 — RepeatReminder 软提醒阈值矩阵 + GoalDriver 状态机/续行决策/KV 注入往返。
 */
import { describe, expect, test } from "bun:test";
import {
	GOAL_TRANSITIONS,
	GOAL_KEY_PREFIX,
	GoalDriver,
	GoalError,
	RepeatReminder,
	repeatEscalateMessage,
	repeatFirstMessage,
	type Goal,
	type GoalKVStore,
} from "./goal-driver";

/** 内存 KVStore（BI-02.3 Outbox 形态，记录调用踪迹供注入断言）。 */
class MemoryKV implements GoalKVStore {
	readonly rows = new Map<string, string>();
	readonly trace: Array<{ op: "get" | "set" | "delete" | "scan"; key: string }> = [];

	async get(key: string): Promise<string | undefined> {
		this.trace.push({ op: "get", key });
		return this.rows.get(key);
	}

	async set(key: string, value: string): Promise<void> {
		this.trace.push({ op: "set", key });
		this.rows.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.trace.push({ op: "delete", key });
		this.rows.delete(key);
	}

	async scan(prefix: string): Promise<Array<{ key: string; value: string }>> {
		this.trace.push({ op: "scan", key: prefix });
		const out: Array<{ key: string; value: string }> = [];
		for (const [key, value] of this.rows) {
			if (key.startsWith(prefix)) out.push({ key, value });
		}
		return out;
	}
}

function freshDriver(
	kv: GoalKVStore,
	options?: { judge?: (goal: Goal) => boolean; maxRounds?: number },
): GoalDriver {
	let n = 0;
	let clock = 1_700_000_000_000;
	return new GoalDriver(kv, {
		...options,
		now: () => ++clock,
		idGen: () => `goal-${++n}`,
	});
}

describe("BI-07.5 · RepeatReminder 软提醒（硬门归 07.13，本卡只注入提示文本）", () => {
	test("阈值下（第 1、2 次同参）返回 null，不打扰 prompt", () => {
		const r = new RepeatReminder();
		expect(r.record("bash", { cmd: "ls" })).toBeNull();
		expect(r.record("bash", { cmd: "ls" })).toBeNull();
		expect(r.countOf("bash")).toBe(2);
	});

	test("第 3 次同参 → 首次提醒（含工具名与计数）", () => {
		const r = new RepeatReminder();
		r.record("bash", { cmd: "ls" });
		r.record("bash", { cmd: "ls" });
		const msg = r.record("bash", { cmd: "ls" });
		expect(msg).toBe(repeatFirstMessage("bash", 3));
		expect(msg).toContain("bash");
		expect(msg).toContain("3");
	});

	test("第 4 次（阈值间隙）返回 null", () => {
		const r = new RepeatReminder();
		for (let i = 0; i < 3; i++) r.record("bash", { cmd: "ls" });
		expect(r.record("bash", { cmd: "ls" })).toBeNull();
	});

	test("第 5 次同参 → 升级提醒；第 6 次起持续升级提醒", () => {
		const r = new RepeatReminder();
		for (let i = 0; i < 4; i++) r.record("bash", { cmd: "ls" });
		expect(r.record("bash", { cmd: "ls" })).toBe(repeatEscalateMessage("bash", 5));
		const sixth = r.record("bash", { cmd: "ls" });
		expect(sixth).toBe(repeatEscalateMessage("bash", 6));
		expect(r.record("bash", { cmd: "ls" })).toBe(repeatEscalateMessage("bash", 7));
	});

	test("换参数重置计数：异参归 1，需重新累计才再提醒", () => {
		const r = new RepeatReminder();
		r.record("bash", { cmd: "ls" });
		r.record("bash", { cmd: "ls" });
		expect(r.record("bash", { cmd: "ls" })).not.toBeNull(); // 3 → 提醒
		expect(r.record("bash", { cmd: "pwd" })).toBeNull(); // 异参 → 归 1
		expect(r.countOf("bash")).toBe(1);
		expect(r.record("bash", { cmd: "pwd" })).toBeNull();
		expect(r.record("bash", { cmd: "pwd" })).not.toBeNull(); // 重新累计到 3
	});

	test("工具间隔离：A 工具达阈值不影响 B 工具首调", () => {
		const r = new RepeatReminder();
		r.record("bash", { cmd: "ls" });
		r.record("bash", { cmd: "ls" });
		expect(r.record("bash", { cmd: "ls" })).not.toBeNull();
		expect(r.record("read", { path: "/a" })).toBeNull();
		expect(r.countOf("read")).toBe(1);
	});

	test("canonicalHash 复用：键序扰动视为同参（累计），toolName 参与隔离", () => {
		const r = new RepeatReminder();
		r.record("bash", { cmd: "ls", flags: ["-la"] });
		r.record("bash", { flags: ["-la"], cmd: "ls" });
		expect(r.countOf("bash")).toBe(2); // 键序扰动同哈希 → 累计
		const r2 = new RepeatReminder();
		r2.record("bash", { cmd: "ls" });
		expect(r2.record("grep", { cmd: "ls" })).toBeNull(); // 异工具各自计数
	});

	test("reset()：全量清零后重新计数；reset(tool) 单工具清账", () => {
		const r = new RepeatReminder();
		r.record("bash", { cmd: "ls" });
		r.record("bash", { cmd: "ls" });
		r.record("read", { path: "/a" });
		r.reset("bash");
		expect(r.countOf("bash")).toBe(0);
		expect(r.countOf("read")).toBe(1);
		r.reset();
		expect(r.countOf("read")).toBe(0);
		expect(r.record("bash", { cmd: "ls" })).toBeNull();
	});

	test("注入阈值覆盖：firstAt=2/escalateAt=3 生效", () => {
		const r = new RepeatReminder({ firstAt: 2, escalateAt: 3 });
		expect(r.record("bash", { cmd: "ls" })).toBeNull();
		expect(r.record("bash", { cmd: "ls" })).toBe(repeatFirstMessage("bash", 2));
		expect(r.record("bash", { cmd: "ls" })).toBe(repeatEscalateMessage("bash", 3));
	});

	test("escalateAt < firstAt 注入值被钳制（对齐 RepeatBreaker 房规：升级档在等值处优先）", () => {
		const r = new RepeatReminder({ firstAt: 4, escalateAt: 2 });
		for (let i = 0; i < 3; i++) expect(r.record("bash", { cmd: "ls" })).toBeNull();
		expect(r.record("bash", { cmd: "ls" })).toBe(repeatEscalateMessage("bash", 4));
		expect(r.record("bash", { cmd: "ls" })).toBe(repeatEscalateMessage("bash", 5));
	});
});

describe("BI-07.5 · GoalDriver 状态机与 KVStore 注入存储", () => {
	test("createGoal：默认 active、rounds=0，字段齐备", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		const goal = await d.createGoal("修复 CI", "初查失败用例");
		expect(goal.state).toBe("active");
		expect(goal.rounds).toBe(0);
		expect(goal.text).toBe("修复 CI");
		expect(goal.checkpoint).toBe("初查失败用例");
		expect(goal.createdAt).toBe(goal.updatedAt);
		expect(goal.id).toBe("goal-1");
	});

	test("getGoal 往返：create 后可按 id 读回同值", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		const created = await d.createGoal("写周报");
		const loaded = await d.getGoal(created.id);
		expect(loaded).toEqual(created);
		expect(await d.getGoal("goal-none")).toBeNull();
	});

	test("KVStore 注入踪迹：经 GOAL_KEY_PREFIX 命名空间 set/get", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		const goal = await d.createGoal("t");
		await d.getGoal(goal.id);
		expect(kv.trace.some((t) => t.op === "set" && t.key === GOAL_KEY_PREFIX + goal.id)).toBe(true);
		expect(kv.trace.some((t) => t.op === "get" && t.key === GOAL_KEY_PREFIX + goal.id)).toBe(true);
	});

	test("跨实例持久化：新 GoalDriver 接同一 KVStore 续读同目标", async () => {
		const kv = new MemoryKV();
		const d1 = freshDriver(kv);
		const created = await d1.createGoal("跨实例目标");
		await d1.updateGoal(created.id, { checkpoint: "进行到一半" });
		const d2 = freshDriver(kv);
		const loaded = await d2.getGoal(created.id);
		expect(loaded?.text).toBe("跨实例目标");
		expect(loaded?.checkpoint).toBe("进行到一半");
		expect(loaded?.state).toBe("active");
	});

	test("updateGoal 补丁：checkpoint/rounds 更新、updatedAt 前移", async () => {
		const kv = new MemoryKV();
		let clock = 1_000;
		const d = new GoalDriver(kv, { now: () => clock++, idGen: () => "goal-1" });
		const goal = await d.createGoal("t");
		const patched = await d.updateGoal(goal.id, { checkpoint: "c1", rounds: 2 });
		expect(patched.checkpoint).toBe("c1");
		expect(patched.rounds).toBe(2);
		expect(patched.updatedAt).toBeGreaterThan(goal.updatedAt);
		expect((await d.getGoal(goal.id))?.rounds).toBe(2);
	});

	test("合法转移矩阵：active/paused 全对、done/abandoned 仅自环", () => {
		expect(GOAL_TRANSITIONS.active).toContain("paused");
		expect(GOAL_TRANSITIONS.active).toContain("done");
		expect(GOAL_TRANSITIONS.active).toContain("abandoned");
		expect(GOAL_TRANSITIONS.paused).toContain("active");
		expect(GOAL_TRANSITIONS.done).toEqual(["done"]);
		expect(GOAL_TRANSITIONS.abandoned).toEqual(["abandoned"]);
	});

	test("active → paused → active：暂停与恢复", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		const goal = await d.createGoal("t");
		const paused = await d.updateGoal(goal.id, { state: "paused" });
		expect(paused.state).toBe("paused");
		const resumed = await d.updateGoal(goal.id, { state: "active" });
		expect(resumed.state).toBe("active");
	});

	test("active → abandoned 合法；abandoned 终态出边拒绝（invalid-transition）", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		const goal = await d.createGoal("t");
		await d.updateGoal(goal.id, { state: "abandoned" });
		expect((await d.getGoal(goal.id))?.state).toBe("abandoned");
		await expect(d.updateGoal(goal.id, { state: "active" })).rejects.toMatchObject({
			name: "GoalError",
			code: "invalid-transition",
		});
	});

	test("done 为终态：active → done 后再 → paused 拒绝", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		const goal = await d.createGoal("t");
		await d.updateGoal(goal.id, { state: "done" });
		await expect(d.updateGoal(goal.id, { state: "paused" })).rejects.toBeInstanceOf(GoalError);
	});

	test("updateGoal 未知 id → unknown-goal；createGoal 空文本 → invalid-goal", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		await expect(d.updateGoal("goal-none", { state: "done" })).rejects.toMatchObject({
			code: "unknown-goal",
		});
		await expect(d.createGoal("   ")).rejects.toMatchObject({ code: "invalid-goal" });
		await expect(d.createGoal("t").then((g) => d.updateGoal(g.id, { rounds: -1 }))).rejects.toMatchObject({
			code: "invalid-goal",
		});
	});

	test("listGoals：scan 端口返回全部目标并按 createdAt 升序", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		const a = await d.createGoal("第一");
		const b = await d.createGoal("第二");
		const list = await d.listGoals();
		expect(list.map((g) => g.id)).toEqual([a.id, b.id]);
		expect(kv.trace.some((t) => t.op === "scan" && t.key === GOAL_KEY_PREFIX)).toBe(true);
	});
});

describe("BI-07.5 · nextRound 续行决策（确定性渲染 / 达成 / maxRounds 耗尽）", () => {
	test("未达且 rounds<max：continue=true，prompt 确定性含目标文本与已完成/剩余", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv, { maxRounds: 5 });
		const goal = await d.createGoal("巡检集群");
		const first = await d.nextRound(goal);
		expect(first.continue).toBe(true);
		expect(first.prompt).toContain("巡检集群");
		expect(first.prompt).toContain("已完成 1 轮");
		expect(first.prompt).toContain("剩余 4 轮");
		const goal2 = await d.getGoal(goal.id);
		const again = await d.nextRound(goal2!);
		expect(again.prompt).toBe(
			"继续目标: 巡检集群（已完成 2 轮，剩余 3 轮）",
		);
	});

	test("nextRound 累进 rounds 并经 KVStore 持久化", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv, { maxRounds: 5 });
		const goal = await d.createGoal("t");
		await d.nextRound(goal);
		await d.nextRound((await d.getGoal(goal.id))!);
		expect((await d.getGoal(goal.id))?.rounds).toBe(2);
	});

	test("注入判定达成 → done + 完成摘要（continue=false），state 落库", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv, { judge: () => true, maxRounds: 5 });
		const goal = await d.createGoal("收尾任务");
		const decision = await d.nextRound(goal);
		expect(decision.continue).toBe(false);
		expect(decision.prompt).toBe("目标已完成: 收尾任务（共 1 轮）");
		expect((await d.getGoal(goal.id))?.state).toBe("done");
	});

	test("判定按当前记录评估：完成 1 轮后 judge 才达成 → 第二次调用落 done", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv, { judge: (g) => g.rounds >= 1, maxRounds: 5 });
		const goal = await d.createGoal("两轮任务");
		expect((await d.nextRound(goal)).continue).toBe(true); // judge 见 rounds=0 → 未达
		const second = await d.nextRound((await d.getGoal(goal.id))!); // judge 见 rounds=1 → 达成
		expect(second.continue).toBe(false);
		expect(second.prompt).toBe("目标已完成: 两轮任务（共 2 轮）");
		expect((await d.getGoal(goal.id))?.state).toBe("done");
	});

	test("maxRounds 耗尽：continue=false + 耗尽提示；重复调用稳定不增轮、state 不变", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv, { maxRounds: 2 });
		const goal = await d.createGoal("长任务");
		expect((await d.nextRound(goal)).continue).toBe(true);
		const last = await d.nextRound((await d.getGoal(goal.id))!);
		expect(last.continue).toBe(false);
		expect(last.prompt).toContain("已达最大轮数 2");
		expect(last.prompt).toContain("长任务");
		const again = await d.nextRound((await d.getGoal(goal.id))!);
		expect(again.prompt).toBe(last.prompt);
		const stored = await d.getGoal(goal.id);
		expect(stored?.rounds).toBe(2);
		expect(stored?.state).toBe("active");
	});

	test("paused/abandoned：不续行、不增轮", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv, { maxRounds: 5 });
		const goal = await d.createGoal("t");
		await d.updateGoal(goal.id, { state: "paused" });
		const decision = await d.nextRound((await d.getGoal(goal.id))!);
		expect(decision.continue).toBe(false);
		expect(decision.prompt).toContain("paused");
		expect((await d.getGoal(goal.id))?.rounds).toBe(0);
	});

	test("已 done 目标幂等返回完成摘要（不重复计数）", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv, { judge: () => true, maxRounds: 5 });
		const goal = await d.createGoal("t");
		await d.nextRound(goal);
		const done = (await d.getGoal(goal.id))!;
		expect(done.state).toBe("done");
		const twice = await d.nextRound(done);
		expect(twice.continue).toBe(false);
		expect(twice.prompt).toBe("目标已完成: t（共 1 轮）");
	});

	test("缺省判定恒未达：耗尽前一路续行到 maxRounds（缺省 10）", async () => {
		const kv = new MemoryKV();
		const d = freshDriver(kv);
		let goal = await d.createGoal("无判定目标");
		let continues = 0;
		for (;;) {
			const decision = await d.nextRound(goal);
			if (!decision.continue) break;
			continues++;
			goal = (await d.getGoal(goal.id))!;
		}
		expect(continues).toBe(9); // 第 10 轮收尾即达上限（续行 1..9）
		goal = (await d.getGoal(goal.id))!;
		expect(goal.rounds).toBe(10);
		expect(goal.state).toBe("active");
	});
});
