/**
 * FIX-A F1 · cron 调度核适配器（装配层）。
 *
 * CronService 只认 CronCorePort 端口（core 器官不 import workflow——依赖方向单向，
 * 见 cron/cron-service.ts 头注）。本文件是**组装方适配器**：把仓库现成 cron 解析核
 * （packages/workflow/src/schedule 的 parseCron / nextFire，BI-07.14）接到端口上，
 * 使 config [cron] enabled 的会话内 cron 走真实解析/推算（不重造 cron 公式）。
 *
 * 时区口径：cron 表达式按**本地墙钟**解释（"0 9 * * *" = 本地 9:00，符合用户直觉）；
 * 本地时区取系统时区，解析失败回落 UTC。调度核的 tz 语义见 workflow schedule-domain。
 */
import { nextFire, parseCron } from "../../../workflow/src/schedule/schedule-domain";
import type { CronCorePort } from "../cron/cron-service";

/** 系统本地时区（解析失败回落 UTC；cron 表达式按本地墙钟解释）。 */
export function localCronTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/**
 * 工作流调度核适配器：parseCron / nextFire 委托 workflow（BI-07.14）。
 * - parseCron：非法表达式抛错（CronService 包装为结构化 invalid-expr）。
 * - nextFire：返回严格晚于 fromMs 的下一次触发时刻；不可命中（400 年硬边界）
 *   抛错（CronService 包装为结构化 unreachable-schedule）。
 */
export function workflowCronCorePort(tz: string = localCronTimeZone()): CronCorePort {
	return {
		parseCron: (expr: string) => parseCron(expr),
		nextFire: (parsed: unknown, fromMs: number): number => {
			const expr = (parsed as { expr?: unknown } | null)?.expr;
			if (typeof expr !== "string") {
				throw new Error("cron 解析产物缺 expr 字段（调度核端口契约违约）");
			}
			const next = nextFire({ kind: "cron", expr, tz }, fromMs);
			if (next === null) {
				throw new Error(`cron 表达式无可命中触发时刻（400 年硬边界）: ${expr}`);
			}
			return next;
		},
	};
}
