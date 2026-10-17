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
