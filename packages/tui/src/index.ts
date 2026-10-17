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
