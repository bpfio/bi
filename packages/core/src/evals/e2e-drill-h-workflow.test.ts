/**
 * BI-21 工位 H 域级演练 H —— 工作流状态机全链。
 *
 * 链路:DAG engine 三节点图(parseWorkflow 最小 DSL → MemoryDurableStore →
 * DurableScheduler → 分层驱动)+ 跨实例恢复(同 store 新引擎幂等续跑 +
 * recover() 孤儿重放)→ plan-mode 只读降级状态机 → mode-mutex 互斥强退
 * → todo 前向迁移 → goal-driver 轮次提醒(RepeatReminder)。
 *
 * 注入仅限 I/O 边界(内存存储/时钟);状态机、转移表、解析器全部真实代码。
 */

import { describe, expect, test } from "bun:test";

import {
	parseWorkflow,
	DagEngine,
	makeWfStepHandler,
	stepTaskId,
	WF_STEP_KIND,
} from "../../../workflow/src/engine";
import type { StepHandler } from "../../../workflow/src/engine";
import { DurableScheduler } from "../../../workflow/src/durable/durable-scheduler";
import { MemoryDurableStore } from "../../../workflow/src/durable/storage";
import type { TaskRecord } from "../../../workflow/src/durable/task-state";
import { PlanModeService } from "../../../workflow/src/plan/plan-mode";
import { ModeMutexCoordinator, WORKFLOW_MODES } from "../../../workflow/src/mode-mutex";
import { TodoService, todoStatusRank } from "../../../workflow/src/todo/todo-service";
import { GoalDriver, RepeatReminder, GOAL_TRANSITIONS } from "../../../workflow/src/goal-driver";
import type { GoalKVStore } from "../../../workflow/src/goal-driver";

/** 内存 KV(goal-driver 端口,I/O 边界)。 */
function memoryKV(): GoalKVStore {
	const rows = new Map<string, string>();
	return {
		get: async (k) => rows.get(k),
		set: async (k, v) => void rows.set(k, v),
		delete: async (k) => void rows.delete(k),
		scan: async (prefix) => [...rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
	};
}

describe("BI-21 域 H —— 工作流状态机", () => {
	test("H1 DAG engine:三节点图跑通 + outputs 下传 + 跨实例恢复", async () => {
		const store = new MemoryDurableStore();
		const calls: string[] = [];
		const handlers: Record<string, StepHandler> = {
			fetch: () => "953680 亿元",
			checkA: (p) => `A:${p.results.fetch}`,
			checkB: (p) => `B:${(p.results.fetch as string).slice(0, 6)}`,
		};
		const makeRig = () => {
			const scheduler = new DurableScheduler({
				store,
				handlers: { [WF_STEP_KIND]: makeWfStepHandler(handlers) },
				sleep: async () => {},
			});
			return new DagEngine({ scheduler, handlers });
		};

		// 最小 DSL 解析:三节点(fetch → checkA / checkB)
		const spec = parseWorkflow(
			[
				"steps:",
				"  - id: fetch",
				"    run: fetch",
				"  - id: checkA",
				"    run: checkA",
				"    depends_on: [fetch]",
				"  - id: checkB",
				"    run: checkB",
				"    depends_on: [fetch]",
			].join("\n"),
		);
		const engine1 = makeRig();
		const r1 = await engine1.run("drill-dag", spec);
		expect(r1.status).toBe("completed");
		expect(r1.outputs).toEqual({ fetch: "953680 亿元", checkA: "A:953680 亿元", checkB: "B:953680" });
		expect(r1.failedStep).toBeNull();
		expect(calls.length).toBe(0);

		// 跨实例恢复:同 store 换新引擎幂等续跑,已完成步不重执行(outputs 复原)
		const engine2 = makeRig();
		const r2 = await engine2.run("drill-dag", spec);
		expect(r2.status).toBe("completed");
		expect(r2.outputs).toEqual(r1.outputs);
		// checkpoint 权威在 store:每步 completed 且带结果信封
		for (const id of ["fetch", "checkA", "checkB"]) {
			const rec = engine2.store.get(stepTaskId("drill-dag", id));
			expect(rec?.state).toBe("completed");
		}

		// 孤儿恢复:手工落一条 running 孤儿(模拟崩溃在途),recover 重放至收敛
		store.put({
			id: stepTaskId("drill-orphan", "solo"),
			kind: WF_STEP_KIND,
			state: "running",
			checkpoint: { workflowId: "drill-orphan", stepId: "solo", run: "fetch", params: {}, dependsOn: [], results: {} },
			attempts: 1,
			maxAttempts: 2,
			updatedAt: Date.now(),
		} satisfies TaskRecord);
		const engine3 = makeRig();
		const rec = await engine3.recover("drill-orphan", parseWorkflow("steps:\n  - id: solo\n    run: fetch\n"));
		expect(rec.status).toBe("completed");
		expect(rec.outputs.solo).toBe("953680 亿元");

		// 规格错误:环依赖 → 结构化解析错误
		expect(() =>
			parseWorkflow("steps:\n  - id: x\n    run: fetch\n    depends_on: [y]\n  - id: y\n    run: fetch\n    depends_on: [x]"),
		).toThrow();
	}, 30_000);

	test("H2 plan-mode:只读降级状态机规划→提交→驳回→修订→批准", () => {
		const policy = {
			isReadOnly: (tool: string) => ["Read", "Grep", "Glob"].includes(tool),
		};
		const plan = new PlanModeService({ policy, now: () => 1_700_000_000_000 });

		// idle 态直接 exit → 结构化拒绝
		const earlyExit = plan.exit({ approved: true });
		expect(earlyExit.ok).toBe(false);

		const enter = plan.enter("sess-drill");
		expect(enter.ok).toBe(true);

		// 只读降级裁决:读放行,写拒绝且带固定 reason
		expect(plan.gate("Read", { path: "a.ts" }).allowed).toBe(true);
		const write = plan.gate("Write", { path: "a.ts" });
		expect(write.allowed).toBe(false);
		expect(write.reason).toBe("plan-mode-readonly");

		// 提交计划 v1 → awaiting-review
		const submit1 = plan.submitPlan({
			title: "公报审计实施计划",
			changeFiles: ["docs/audit.md"],
			design: "三链数字勾稽后写台账",
			risks: ["数字漂移"],
			createdAt: 1_700_000_000_000,
		});
		expect(submit1.ok).toBe(true);
		if (submit1.ok) {
			expect(submit1.version).toBe(1);
			expect(submit1.status).toBe("awaiting-review"); // 服务态;版本态为 pending-review
		}

		// 驳回 → 回 planning,反馈挂到当前轮
		const reject = plan.exit({ approved: false, feedback: "数字要逐字对源" });
		expect(reject.ok).toBe(true);
		if (reject.ok) expect(reject.status).toBe("planning"); // 驳回回 planning 续改

		// 修订重提 v2 → 批准 → executing
		const submit2 = plan.submitPlan({
			title: "公报审计实施计划 v2",
			changeFiles: ["docs/audit.md"],
			design: "逐字比对 953680/4.8% 后写台账",
			risks: [],
			createdAt: 1_700_000_000_001,
		});
		expect(submit2.ok).toBe(true);
		if (submit2.ok) expect(submit2.version).toBe(2);
		const approve = plan.exit({ approved: true });
		expect(approve.ok).toBe(true);
		if (approve.ok) expect(approve.status).toBe("executing"); // 批准进入执行态
	}, 30_000);

	test("H3 mode-mutex:同会话互斥强退 + 幂等重入 + 事件序", () => {
		const mutex = new ModeMutexCoordinator();
		const events: string[] = [];
		mutex.on("enter", (e) => {
			if (e.type === "enter") events.push(`enter:${e.mode}`);
		});
		mutex.on("exit", (e) => {
			if (e.type === "exit") events.push(`exit:${e.mode}:${e.reason}`);
		});
		mutex.on("forced-exit", (e) => {
			if (e.type === "forced-exit") events.push(`forced:${e.mode}←${e.exitedBy}`);
		});

		// plan 进入;goal 与 plan 互斥 → 强退 plan
		const r1 = mutex.enter("plan", "sess-1");
		expect(r1.forcedExits).toEqual([]);
		const r2 = mutex.enter("goal", "sess-1");
		expect(r2.forcedExits.map((f) => f.mode)).toEqual(["plan"]);
		expect(events).toEqual(["enter:plan", "exit:plan:forced", "forced:plan←goal", "enter:goal"]);

		// 幂等重入:同模式零事件
		events.length = 0;
		const r3 = mutex.enter("goal", "sess-1");
		expect(r3.forcedExits).toEqual([]);
		expect(events).toEqual([]);

		// 两两互斥语义:独立会话 sess-2 中 plan→swarm 强退 plan;与 sess-1 互不干扰
		expect(WORKFLOW_MODES).toContain("plan");
		expect(mutex.enter("plan", "sess-2").forcedExits).toEqual([]);
		expect(mutex.enter("swarm", "sess-2").forcedExits.map((f) => f.mode)).toEqual(["plan"]);
		// 显式退出
		mutex.exit("goal", "sess-1");
		expect(events).toContain("exit:goal:explicit");
	}, 30_000);

	test("H4 todo:pending→in_progress→completed 前向迁移与非法回退拒绝", () => {
		const todo = new TodoService();
		const t = todo.add("T1", "核对公报指标");
		expect(t.status).toBe("pending");
		expect(todo.update("T1", "in_progress").status).toBe("in_progress");
		expect(todo.update("T1", "completed").status).toBe("completed");

		// 前向单调:completed 无出边,回退 in_progress 结构化拒绝
		expect(() => todo.update("T1", "in_progress")).toThrow();
		// rank 单调序:pending < in_progress < completed
		expect(todoStatusRank("pending")).toBeLessThan(todoStatusRank("in_progress"));
		expect(todoStatusRank("in_progress")).toBeLessThan(todoStatusRank("completed"));
		// 未知 id / 空 content 结构化拒绝
		expect(() => todo.update("ghost", "pending")).toThrow();
		expect(() => todo.add("T2", "")).toThrow(); // 空 content 结构化拒绝
		expect(todo.list().map((i) => i.id)).toContain("T1");
	}, 30_000);

	test("H5 goal-driver + RepeatReminder:轮次续行与升级提醒", async () => {
		// 目标状态机:judge 达成判定注入 → done 终态
		let auditDone = false;
		const driver = new GoalDriver(memoryKV(), {
			judge: () => auditDone,
			maxRounds: 3,
		});
		const goal = await driver.createGoal("完成三链 0 误差比对", "checkpoint:v1");
		expect(goal.state).toBe("active");
		expect(goal.rounds).toBe(0);

		const d1 = await driver.nextRound(goal);
		expect(d1.continue).toBe(true);
		expect(d1.prompt).toContain("剩余 2 轮");

		auditDone = true;
		const current = (await driver.getGoal(goal.id))!;
		const d2 = await driver.nextRound(current);
		expect(d2.continue).toBe(false);
		expect(d2.prompt).toContain("目标已完成");
		expect((await driver.getGoal(goal.id))!.state).toBe("done");

		// done 为终态:再次续行不重置
		const d3 = await driver.nextRound((await driver.getGoal(goal.id))!);
		expect(d3.continue).toBe(false);
		// done 为吸收态:无 active/paused 出边(仅自环)
		expect(GOAL_TRANSITIONS.done).not.toContain("active");
		expect(GOAL_TRANSITIONS.done).not.toContain("paused");
		// 非空文本门禁
		await expect(driver.createGoal("   ")).rejects.toMatchObject({ code: "invalid-goal" });

		// RepeatReminder:同参累计 3 次首提醒、5 次升级;异参重置
		const reminder = new RepeatReminder({ firstAt: 3, escalateAt: 5 });
		const args = { cmd: "bun test" };
		expect(reminder.record("Bash", args)).toBeNull();
		expect(reminder.record("Bash", args)).toBeNull();
		expect(reminder.record("Bash", args)).toContain("3");
		expect(reminder.record("Bash", args)).toBeNull();
		const escalate = reminder.record("Bash", args);
		expect(escalate).not.toBeNull();
		expect(escalate).toContain("5");
		// 异参 → 计数重置为 1,回 null
		expect(reminder.record("Bash", { cmd: "ls" })).toBeNull();
		expect(reminder.countOf("Bash")).toBe(1);
		reminder.reset();
		expect(reminder.countOf("Bash")).toBe(0);
	}, 30_000);
});
