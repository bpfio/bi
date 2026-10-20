/**
 * mount/candidate-menu —— 候选与命令菜单（BI-27.4）。
 *
 * 斜杠草稿（"/" 开头且不含空白）的候选菜单状态机 + 候选面注入端口：
 * - **Candidate**：`{ name, description }`，name 不含前导 "/"——与 core
 *   discoverSlashCommands 的调度表面（SlashCommandSurfaceEntry，commands/
 *   custom-commands.ts）字段逐一同构，宿主侧用 slashCommandSurface(...)
 *   的产物直接作为 CandidatesProvider 回吐即可接上（装配归 bin/**，本包只立缝）；
 * - **CandidatesProvider**：给定当前草稿回吐候选全集（菜单内部做前缀/模糊
 *   过滤，provider 无须关心草稿）；缺省 = builtinSlashCandidates；
 * - **CandidateMenu**：纯状态机（不触终端）——sync(draft) 同步开合与过滤、
 *   up/down 移动选择、accept() 回吐补全草稿（"/name "）、dismiss() 关闭；
 *   lines(cols) 产出菜单显示行（`/name  描述` 对齐 + 按显示列宽截断），
 *   供 agent-tui.ts 的菜单视图组件落格（只画状态行上方区域，永不触碰
 *   状态行/提示行两行，BI-24.3 布局合约）；
 * - **非斜杠 Tab 补全**：completeFromProvider 把 provider 候选名按前缀延伸
 *   语义（repl.completeDraft 同判据）喂给非斜杠草稿的 Tab 路径；缺省 builtin
 *   列表为斜杠命令名，对非斜杠草稿天然无候选（no-op），宿主注入真实候选面
 *   （如历史/文件路径）后即生效。
 *
 * 过滤规则（务实子集）：查询串 = 草稿去前导 "/"；前缀命中（大小写不敏感）
 * 优先、provider 原序稳定；其后为子序列模糊命中（同样大小写不敏感、原序）；
 * 两类合并去重。过滤结果截断到 MAX_ITEMS。
 *
 * 诚实边界：
 * - 菜单不滚动：候选超过 MAX_ITEMS 时只展示前 MAX_ITEMS（选择钳在展示窗内）；
 * - 选择索引在每次 sync（草稿变化）后复位到 0（不做「选中项保持」启发式）；
 * - accept() 回吐 "/name "（尾随空格便于续填参数）；是否真正执行斜杠命令
 *   归宿主调度（本卡只管补全与菜单交互，不做命令分发）。
 */

import { charWidth, textWidth } from "../components/cjk-width";
import type { FileCompletionItem } from "./file-completion";
import { gateCommandCandidates } from "./gate-commands";
import { modeCommandCandidates } from "./mode-command";

/** 单条候选（与 core SlashCommandSurfaceEntry 字段同构；name 不含前导 "/"）。 */
export interface Candidate {
  readonly name: string;
  readonly description: string;
}

/**
 * 候选面：给定当前草稿回吐候选全集（菜单内部过滤）。宿主接线形态：
 * `(draft) => slashCommandSurface(discoverSlashCommands(...).commands)`。
 */
export type CandidatesProvider = (draft: string) => readonly Candidate[];

/**
 * 内置斜杠命令候选（BI-27.4 缺省面）：仅收录 tui 包内已存在的命令
 * （copy/config/reload/reload-tui，摘要取各自定义原文）。未立项命令不
 * 假冒条目；自定义命令经 CandidatesProvider 注入（bin/** 装配缝）。
 * BI-11 接线：手动门三命令（/compact /rewind /clear，mount/gate-commands.ts）
 * 与 BI-20 接线：diff 审查门入口（/diff，mount/diff-gate.ts）、四态工作模式
 * 入口（/mode，mount/mode-command.ts）一并入面。
 */
export const builtinSlashCandidates: readonly Candidate[] = [
  { name: "copy", description: "复制上一轮回答到系统剪贴板" },
  { name: "config", description: "打开交互式设置面板（查看 / 修改三级 TOML 配置）" },
  { name: "reload", description: "免重启热重载全部配置（config.toml / tui.toml / local.toml）" },
  { name: "reload-tui", description: "免重启热重载终端外观偏好（tui.toml）" },
  ...gateCommandCandidates,
  { name: "diff", description: "展示工作区未提交变更并过 diff 审查门" },
  ...modeCommandCandidates,
];

/** 缺省候选面：忽略草稿，恒回吐内置列表。 */
export function builtinCandidatesProvider(): CandidatesProvider {
  return () => builtinSlashCandidates;
}

/** 菜单展示条数上限（超出截断，选择钳在展示窗内）。 */
export const CANDIDATE_MENU_MAX_ITEMS = 8;

/** 大小写不敏感折叠（ASCII 主场景；非 ASCII 字符原样参与比较）。 */
function fold(text: string): string {
  return text.toLowerCase();
}

/** 子序列模糊命中：query 的码元逐个按序出现在 name 中（大小写不敏感）。 */
function fuzzyMatch(name: string, query: string): boolean {
  if (query.length === 0) return true;
  const hay = fold(name);
  const needle = fold(query);
  let at = 0;
  for (const ch of needle) {
    const found = hay.indexOf(ch, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

/**
 * 斜杠草稿过滤：前缀命中（原序）优先，其后子序列模糊命中（原序），去重后
 * 截断到 MAX_ITEMS。query 为空（草稿恰为 "/"）回吐前 MAX_ITEMS 全集。
 */
export function filterSlashCandidates(draft: string, candidates: readonly Candidate[]): Candidate[] {
  const query = fold(draft.startsWith("/") ? draft.slice(1) : draft);
  const prefix: Candidate[] = [];
  const fuzzy: Candidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.name)) continue;
    const name = fold(candidate.name);
    if (query === "" || name.startsWith(query)) {
      prefix.push(candidate);
      seen.add(candidate.name);
    } else if (fuzzyMatch(candidate.name, query)) {
      fuzzy.push(candidate);
      seen.add(candidate.name);
    }
  }
  return [...prefix, ...fuzzy].slice(0, CANDIDATE_MENU_MAX_ITEMS);
}

/** 候选集第一共同前缀（UTF-16 码元逐位；收尾高代理回退一位不劈开代理对）。 */
function firstCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0] ?? "";
  for (const value of values) {
    let i = 0;
    const n = Math.min(prefix.length, value.length);
    while (i < n && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === "") return "";
  }
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last !== undefined && last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix;
}

/**
 * 非斜杠草稿的 provider Tab 补全：候选名须为草稿的前缀延伸（startsWith(draft)
 * 且不等值才有进益）；唯一候选整稿补全、多候选取第一共同前缀（与
 * repl.completeDraft 同判据，此处独立实现避免 mount 内循环依赖）。
 * 斜杠草稿归菜单（返回 undefined）；空草稿不猜（返回 undefined）。
 */
export function completeFromProvider(draft: string, provider: CandidatesProvider): string | undefined {
  if (draft === "" || draft.startsWith("/")) return undefined;
  const names = provider(draft)
    .map((c) => c.name)
    .filter((name) => name.startsWith(draft) && name !== draft);
  if (names.length === 0) return undefined;
  const target = names.length === 1 ? (names[0] as string) : firstCommonPrefix(names);
  if (target === draft || !target.startsWith(draft)) return undefined;
  return target;
}

/** 按显示列宽截断（CJK 宽字符计 2 列；截断以 … 收尾，… 放不下时硬截）。 */
function truncateToWidth(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > maxWidth - 1) {
      return `${out}…`;
    }
    out += ch;
    used += w;
  }
  return out;
}

/**
 * 候选菜单状态机（BI-27.4）：斜杠草稿开合 + 过滤 + 选择 + 补全裁决。
 * 纯内态不触终端；渲染行经 lines(cols) 供视图组件落格。
 */
export class CandidateMenu {
  readonly #provider: CandidatesProvider;
  #items: readonly Candidate[] = [];
  #selected = 0;
  #visible = false;
  /**
   * 当前模式：slash = 斜杠命令候选（BI-27.4）；file = 文件/路径/@ 候选
   * （BI-19.8 快赢提案 B，经 repl.ts Tab 路由注入）；none = 关闭。两模式
   * 互斥，menu.visible 由各自路径置位，sync() 每次重算斜杠态时复位 file 态。
   */
  #mode: "none" | "slash" | "file" = "none";
  #fileItems: readonly FileCompletionItem[] = [];

  constructor(provider: CandidatesProvider = builtinCandidatesProvider()) {
    this.#provider = provider;
  }

  /** 菜单模式（none/slash/file）；宿主据此区分接受语义。 */
  get mode(): "none" | "slash" | "file" {
    return this.#mode;
  }

  /** 文件候选集（mode === "file" 时有效）。 */
  get fileItems(): readonly FileCompletionItem[] {
    return this.#fileItems;
  }

  /** 当前选中的文件候选（mode !== "file" 时为 undefined）。 */
  get selectedFileItem(): FileCompletionItem | undefined {
    if (this.#mode !== "file") return undefined;
    return this.#fileItems[this.#selected];
  }

  /** 菜单是否可见（有候选可展示）。 */
  get visible(): boolean {
    return this.#visible;
  }

  /** 当前过滤后的候选（展示窗内，≤ MAX_ITEMS）。 */
  get items(): readonly Candidate[] {
    return this.#items;
  }

  /** 当前选中下标（0 基；不可见时为 0）。 */
  get selectedIndex(): number {
    return this.#selected;
  }

  /** 当前选中候选（不可见/空集为 undefined）。 */
  get selected(): Candidate | undefined {
    return this.#items[this.#selected];
  }

  /**
   * 草稿同步（每次草稿变化后调用）：斜杠草稿（"/" 或 "/xxx"，不含空白）开启
   * 菜单并按草稿过滤；其余草稿关闭。草稿变化即复位选择到 0。
   */
  sync(draft: string): void {
    // 任何草稿变化都先复位文件候选态（编辑即关文件菜单），再重算斜杠态。
    this.#mode = "none";
    this.#fileItems = [];
    const active = draft === "/" || (draft.startsWith("/") && !/\s/.test(draft));
    if (!active) {
      this.#items = [];
      this.#selected = 0;
      this.#visible = false;
      return;
    }
    this.#items = filterSlashCandidates(draft, this.#provider(draft));
    this.#selected = 0;
    this.#visible = this.#items.length > 0;
    this.#mode = this.#visible ? "slash" : "none";
  }

  /**
   * 注入文件/路径/@ 候选集并显示菜单（BI-19.8；由 repl.ts Tab 多候选路径调用）。
   * 空集视为关闭；非空置 file 态并令 menu.visible=true（agent-tui 渲染组件
   * 已按 menu.visible/lines 通用渲染，无需改动 agent-tui.ts）。
   */
  showFileCandidates(items: readonly FileCompletionItem[]): void {
    this.#items = [];
    if (items.length === 0) {
      this.#visible = false;
      this.#mode = "none";
      this.#fileItems = [];
      this.#selected = 0;
      return;
    }
    this.#fileItems = items;
    this.#mode = "file";
    this.#selected = 0;
    this.#visible = true;
  }

  /** 上移选择（顶端钳制不绕回）。 */
  moveUp(): void {
    if (this.#mode === "file") {
      if (this.#selected > 0) this.#selected -= 1;
      return;
    }
    if (this.#selected > 0) this.#selected -= 1;
  }

  /** 下移选择（底端钳制不绕回）。 */
  moveDown(): void {
    if (this.#mode === "file") {
      if (this.#selected < this.#fileItems.length - 1) this.#selected += 1;
      return;
    }
    if (this.#selected < this.#items.length - 1) this.#selected += 1;
  }

  /**
   * 接受当前选中项：回吐补全草稿 `/${name} `（尾随空格便于续填参数）；
   * 菜单不可见/空集返回 undefined（调用方维持原路径，不吞键）。
   */
  accept(): string | undefined {
    if (!this.#visible || this.#mode !== "slash") return undefined;
    const item = this.#items[this.#selected];
    if (item === undefined) return undefined;
    return `/${item.name} `;
  }

  /** 接受当前选中的文件候选（mode !== "file" 时 undefined；调用方做 token 替换）。 */
  acceptFile(): FileCompletionItem | undefined {
    if (!this.#visible || this.#mode !== "file") return undefined;
    return this.#fileItems[this.#selected];
  }

  /** 关闭菜单（Esc 语义）；返回关闭前是否可见（供调用方判定键是否消费）。 */
  dismiss(): boolean {
    const was = this.#visible;
    this.#items = [];
    this.#selected = 0;
    this.#visible = false;
    this.#mode = "none";
    this.#fileItems = [];
    return was;
  }

  /**
   * 非斜杠草稿的 provider Tab 补全（绑定本菜单候选面；斜杠草稿归菜单，
   * 恒 undefined）。runRepl 在缺省历史补全无进益时调用本方法。
   */
  completeNonSlash(draft: string): string | undefined {
    return completeFromProvider(draft, this.#provider);
  }

  /**
   * 菜单显示行（自上而下）：`/name  描述`（name 列按最长名对齐），选中行
   * 前缀 "❯ "、其余 "  "；单行按 cols 显示列宽截断（… 收尾）。不可见返回
   * 空数组（视图组件据此不落格）。
   */
  lines(cols: number): string[] {
    if (!this.#visible) return [];
    const width = Math.max(1, Math.trunc(cols));
    if (this.#mode === "file") {
      const nameWidth = Math.max(...this.#fileItems.map((c) => textWidth(c.label)));
      return this.#fileItems.map((item, i) => {
        const marker = i === this.#selected ? "❯ " : "  ";
        const pad = " ".repeat(Math.max(0, nameWidth - textWidth(item.label)));
        const kind = item.isDirectory ? "(dir)" : "(file)";
        return truncateToWidth(`${marker}${item.label}${pad}  ${kind}`, width);
      });
    }
    const nameWidth = Math.max(...this.#items.map((c) => textWidth(c.name)));
    return this.#items.map((item, i) => {
      const marker = i === this.#selected ? "❯ " : "  ";
      const pad = " ".repeat(Math.max(0, nameWidth - textWidth(item.name)));
      return truncateToWidth(`${marker}/${item.name}${pad}  ${item.description}`, width);
    });
  }
}
