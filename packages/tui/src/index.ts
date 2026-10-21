/** @bi/tui —— TUI 域：BI 终端用户界面与交互组件。 */
export const DESCRIPTION = "TUI 域：BI 终端用户界面与交互组件。";

// —— 引擎层：离屏终端 / 差分渲染 / 输入与粘贴看门狗（BI-19）——
export { VirtualTerminal } from "./engine/virtual-terminal";
export type { Cell, CellStyle, FrameOp } from "./engine/virtual-terminal";
export {
  DiffRenderer,
  InputLoop,
  cup,
  EL,
  ESC_ALONE_TIMEOUT_MS,
} from "./engine/diff-renderer";
export type { Writer, ParsedKey } from "./engine/diff-renderer";
export {
  PasteBurst,
  defaultClock,
  defaultScheduler,
  PASTE_SIZE_THRESHOLD,
  PASTE_GAP_MS,
} from "./engine/paste-burst";
export type {
  Clock,
  Scheduler,
  Timer,
  PasteBurstDeps,
} from "./engine/paste-burst";

// —— 组件层：组件模型 + 最小组件集（BI-19）——
export { TuiApp } from "./components/tui-app";
export type { Component } from "./components/tui-app";
export { PasteBanner } from "./components/paste-banner";
export type { PasteBannerCallbacks } from "./components/paste-banner";
export { ReadGroup } from "./components/read-group";
export { SwarmProgress } from "./components/swarm-progress";
export type { SwarmTask } from "./components/swarm-progress";
export { ThoughtCard } from "./components/thought-card";
export { charWidth, textWidth } from "./components/cjk-width";

// —— 同构 Transcript 投影层（BI-19.1）——
export {
  TranscriptProjection,
  assertProjectionInvariants,
  DEFAULT_VIEW_WIDTH,
} from "./transcript-projection";
export type {
  TranscriptEntry,
  TranscriptKind,
  TranscriptProjectionOptions,
  HistoryLine,
  ViewLine,
} from "./transcript-projection";

// —— 流式输出缓冲与帧率节流（BI-19.2）——
export { OutputBuffer, DEFAULT_CAPACITY_BYTES } from "./engine/output-buffer";
export type { OutputBufferOptions } from "./engine/output-buffer";
export {
  PacedProgress,
  DEFAULT_RENDER_INTERVAL_MS,
} from "./engine/paced-progress";
export type { PacedProgressOptions } from "./engine/paced-progress";

// —— 桌面通知与催办看门狗（BI-19.3）——
export { sendDesktopNotify } from "./notify/desktop-notify";
export type {
  DesktopNotifyOptions,
  NotifyOutcome,
  NotifySpawn,
} from "./notify/desktop-notify";
export {
  NudgeService,
  DEFAULT_NUDGE_TIMEOUT_MS,
  TERMINAL_BELL,
} from "./notify/nudge-service";
export type {
  NudgeBellWriter,
  NudgeDeps,
  NudgeNotifier,
  NudgeStatus,
} from "./notify/nudge-service";

// —— 外部编辑器与长提示词命令桥（BI-19.5）——
export {
  editExternally,
  resolveEditorSpec,
  stripUtf8Bom,
  tokenizeEditorCommand,
} from "./editor/external-editor";
export type {
  EditorFileSystem,
  EditorProcessLike,
  EditorSpawnFn,
  EditResult,
  ExternalEditorOptions,
} from "./editor/external-editor";
export { editPromptCommand } from "./commands/edit-prompt";
export type {
  EditPromptDeps,
  PromptCancelReason,
  PromptEditOutcome,
} from "./commands/edit-prompt";

// —— 装配挂载层：TUI 会话驱动器（BI-23.2，双缓冲投影/审批 ask 回路/Esc 二段取消）——
export { AgentTuiSession, TuiSessionError } from "./mount/agent-tui";
export type {
  TuiSessionOptions,
  TuiSessionResult,
  TuiSessionHooks,
  TuiSessionState,
  FrameInfo,
} from "./mount/agent-tui";

// —— 装配挂载层：行编辑器 REPL 交互主回路（BI-24.2 LineEditor/KeyStream/runRepl；BI-25.3 历史翻页/tab 补全/多行语义）——
export {
  LineEditor,
  KeyStream,
  runRepl,
  PromptHistory,
  historyCompletions,
  completeDraft,
  commonPrefix,
} from "./mount/repl";
export type { LineEditAction, ReplOptions, ReplResult, CompletionsFn } from "./mount/repl";

// —— BI-11 接线：TokenHud 状态跟踪（usage 读数 → 状态行 HUD 段）——
export { TokenHudTracker, DEFAULT_CONTEXT_TOKENS } from "./mount/token-hud";

// —— BI-11 接线：手动门三命令（/compact /rewind /clear）候选面与分发面——
export {
  GATE_COMMAND_NAMES,
  gateCommandCandidates,
  gateCommandName,
  isGateCommandLine,
  dispatchGateCommand,
} from "./mount/gate-commands";
export type { GateDispatchResult, GateCommandOverrides } from "./mount/gate-commands";

// —— BI-20 接线：diff 审查门器官（parseDiff/renderDiff/presentDiff）——
export {
  ANSI,
  buildDiffFromFiles,
  formatHunkHeader,
  parseDiff,
  presentDiff,
  renderDiff,
} from "./diff-view";
export type {
  DiffFile,
  DiffFileStatus,
  DiffGateDecision,
  DiffGateOptions,
  DiffGateSummary,
  DiffHunk,
  DiffLine,
  DiffLineKind,
  DiffModel,
} from "./diff-view";

// —— BI-20 接线：diff 审查门入口（/diff 命令面）——
export { defaultGitRunner, parseDiffArgs, runDiffGate, stripAnsi } from "./mount/diff-gate";
export type { DiffCommandResult, DiffGatePorts, GitRunner } from "./mount/diff-gate";

// —— FIX-B F5 接线：diff 审查门交互确认浮层（/diff 真交互 y/n 裁决）——
export { buildReviewLines, DiffReviewOverlay, DIFF_REVIEW_HINT } from "./mount/diff-review";
export type { DiffReviewVerdict } from "./mount/diff-review";

// —— BI-20.1 接线：四态工作模式命令面（/mode）+ 模式徽标 ——
export {
	DEFAULT_WORK_MODE,
	MODE_COMMAND_NAME,
	dispatchModeCommand,
	isModeCommandLine,
	isModeId,
	modeCommandCandidates,
	modeCommandName,
} from "./mount/mode-command";
export type { ModeCommandError, ModeCommandErrorCode, ModeCommandResult } from "./mount/mode-command";
export { renderModeIndicator } from "./components/mode-indicator";
export type { IndicatorMode } from "./components/mode-indicator";

// —— BI-20.5 接线：vis 令牌轮转权威（tui 侧装配；core 侧只认端口）——
export { createVisTokenAuthority } from "./vis/vis-token-authority";
export type { VisTokenAuthority, VisTokenAuthorityOptions } from "./vis/vis-token-authority";
