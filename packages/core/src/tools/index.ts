/**
 * @bi/core tools 域 —— 受控进程执行设施。
 * BI-06：受控 Bash 执行器与 Linux PGID 进程组看门狗。
 */
export { runBash, buildBashScript, extractCwdFrame, AbortError } from "./bash";
export type {
	RunBashOptions,
	RunBashDeps,
	BashResult,
} from "./bash";
export {
	DEFAULT_BASH_TIMEOUT_MS,
	DEFAULT_BASH_KILL_GRACE_MS,
	DEFAULT_BASH_MAX_OUTPUT_BYTES,
} from "./bash";
export {
	killProcessGroup,
	isProcessAlive,
	listProcessGroupMembers,
	defaultProcessGroupDeps,
} from "./process-group";
export type {
	ProcessGroupDeps,
	KillProcessGroupOptions,
	KillProcessGroupResult,
	TerminationSignal,
} from "./process-group";
