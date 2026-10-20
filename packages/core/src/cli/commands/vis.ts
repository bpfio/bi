/**
 * BI-20.5b — `vis` 子命令：本地 Web 会话可视化（kimi vis 对齐最小面，v1 封顶）。
 *
 * 设计要点（与 bi 零依赖哲学一致，主控裁定不采用侦察报告的 Vite+React 新包）：
 *   - Bun.serve 拉起，缺省绑 127.0.0.1（仅本地回环）；缺省端口 0 = 内核随机选空闲；
 *   - 控制台打印单条访问 URL，SIGINT 优雅退出（stop(true) + 退出码 0）；
 *   - 只读 API：
 *       GET /api/sessions            会话列表 + 元数据（manager.listSessions 透传）
 *       GET /api/sessions/:id        消息流 + 分支树（parentId 森林）+ 工具配对
 *                                    （tool_call / tool_result 按 toolCallId 配对）
 *       GET /                        单文件 vanilla HTML + 内联 CSS + 原生 JS
 *                                    （零构建 / 零 npm 依赖 / 零 CDN）
 *   - 安全：
 *       · 缺省只绑回环，无需令牌；
 *       · --host 传非 loopback 时，强制环境变量 BI_VIS_AUTH_TOKEN，缺失则拒绝启动；
 *       · 带 token 时，所有 /api/* 经令牌校验（?t= 或 Authorization: Bearer）；
 *       · sessionId 用既有白名单模式（manager 的 SESSION_ID_PATTERN 口径）校验，
 *         防路径穿越；未知 id 结构化 404（session_not_found）。
 *
 * v1 不做（照抄侦察报告第 5 节）：token 统计 / 上下文曲线 / agents 树 / cron /
 * logs / zip 导入 / 实时推送 / 富文本渲染 / 多网卡地址。
 *
 * BI-20.5 接线（可选增强，env 显式 opt-in）：令牌轮转。
 *   - 开关：环境变量 BI_VIS_TOKEN_ROTATE=1（config 不加键，默认面零变化）；
 *   - 开启且宿主注入轮转权威 → 令牌校验走权威（当前令牌恒真、上一代令牌在
 *     宽限期内双活）；关闭 → 走现状静态令牌路径（BI_VIS_AUTH_TOKEN）；
 *   - 依赖方向：轮转引擎在 tui 侧，core 不依赖 tui（不许倒置依赖）——core 只
 *     认「令牌权威端口」，由宿主（bin/bi.ts）把 tui 侧产物注入进来。
 *
 * 测试零外呼：VisServer 的 serve 工厂可注入，handler 纯函数可直测路由矩阵。
 */

import { SessionManager, SessionNotFoundError } from "../../session/manager";
import type { SessionEntry } from "../../session/types";
import type { TokenAuthority } from "../../web/vis-handler";

/** 会话 id 白名单（与 manager.SESSION_ID_PATTERN 同口径，防路径穿越）。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 缺省监听地址（仅本地回环）。 */
export const DEFAULT_HOST = "127.0.0.1";
/** 缺省端口 0 = 内核随机选空闲。 */
export const DEFAULT_PORT = 0;
/** 非回环绑定强制要求的环境变量。 */
export const AUTH_TOKEN_ENV = "BI_VIS_AUTH_TOKEN";
/**
 * BI-20.5 接线：令牌轮转开关环境变量（值恒为 "1" 才启用；缺省/他值 = 关闭，
 * 走现状静态令牌路径）。config 不加键——显式 env opt-in，避免默认面行为漂移。
 */
export const TOKEN_ROTATE_ENV = "BI_VIS_TOKEN_ROTATE";

/**
 * 令牌权威工厂端口：core 不依赖 tui（轮转引擎在 tui 侧，依赖方向不可倒置），
 * 由宿主注入「令牌权威」实现（TokenRotator 天然满足本端口）。
 * onRotate：轮转发生时回调（新令牌；宿主据此重印带令牌的访问链接）。
 */
export type VisTokenAuthorityFactory = (onRotate?: (token: string) => void) => TokenAuthority;


/**
 * 判定 host 是否为回环（loopback），仅回环时免令牌。
 * 注意：0.0.0.0 / :: 为"绑定全部接口"的通配符，会暴露到网络，
 * 不应视作回环——归类为需令牌的非回环，避免裸奔暴露。
 */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** 校验 sessionId 是否在白名单内（防路径穿越）。 */
export function isSafeSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** 从请求中提取候选令牌：URL ?t= 优先，其次 Authorization（Bearer 或裸值）。 */
function extractTokenCandidates(request: Request, url: URL): string[] {
  const candidates: string[] = [];
  const urlToken = url.searchParams.get("t");
  if (urlToken !== null && urlToken.length > 0) candidates.push(urlToken);
  const auth = request.headers.get("authorization");
  if (auth !== null) {
    const trimmed = auth.trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    candidates.push(bearer !== null ? (bearer[1]?.trim() ?? trimmed) : trimmed);
  }
  return candidates;
}

/** 分支树节点（parentId 森林；根节点 parentId=null）。 */
export interface BranchNode {
  id: string;
  parentId: string | null;
  type: string;
  depth: number;
}

/** 工具配对外形：tool_call 与 tool_result 按 toolCallId 配对。 */
export interface ToolPair {
  toolCallId: string;
  name: string | null;
  call: SessionEntry | null;
  result: SessionEntry | null;
}

/** GET /api/sessions/:id 的响应结构。 */
export interface SessionDetail {
  meta: unknown;
  entries: SessionEntry[];
  branchTree: BranchNode[];
  tools: ToolPair[];
}

/**
 * 由条目数组构建 parentId 森林的缩进树（按 seq 升序，depth 为到根距离）。
 * 缺失父节点视为根（容错，与 manager 加载口径一致）。
 */
export function buildBranchTree(entries: SessionEntry[]): BranchNode[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const nodes: BranchNode[] = entries.map((entry) => {
    let depth = 0;
    let cursor = entry.parentId;
    const seen = new Set<string>();
    while (cursor !== null && cursor !== undefined) {
      if (seen.has(cursor)) break; // 成环防御
      seen.add(cursor);
      depth += 1;
      const parent = byId.get(cursor);
      if (parent === undefined) break;
      cursor = parent.parentId;
    }
    return { id: entry.id, parentId: entry.parentId, type: entry.type, depth };
  });
  return nodes;
}

/** 由条目数组把 tool_call / tool_result 按 toolCallId 配对。 */
export function pairTools(entries: SessionEntry[]): ToolPair[] {
  const calls = new Map<string, SessionEntry>();
  const results = new Map<string, SessionEntry>();
  const order: string[] = [];
  for (const entry of entries) {
    if (entry.toolCallId === undefined) continue;
    if (!order.includes(entry.toolCallId)) order.push(entry.toolCallId);
    if (entry.type === "tool_call") calls.set(entry.toolCallId, entry);
    else if (entry.type === "tool_result") results.set(entry.toolCallId, entry);
  }
  return order.map((id) => ({
    toolCallId: id,
    name: calls.get(id)?.toolName ?? results.get(id)?.toolName ?? null,
    call: calls.get(id) ?? null,
    result: results.get(id) ?? null,
  }));
}

/** 校验并取会话详情；非法 id / 未知 id / 损坏等统一结构化。 */
export async function buildSessionDetail(
  manager: SessionManager,
  sessionId: string,
): Promise<SessionDetail> {
  if (!isSafeSessionId(sessionId)) {
    throw new VisBadSessionIdError(sessionId);
  }
  const meta = await manager.getSessionMeta(sessionId);
  if (meta === undefined) {
    throw new VisSessionNotFoundError(sessionId);
  }
  const entries = await manager.entries(sessionId);
  return {
    meta,
    entries,
    branchTree: buildBranchTree(entries),
    tools: pairTools(entries),
  };
}

/** 非法 / 穿越式 sessionId（结构化 400）。 */
export class VisBadSessionIdError extends Error {
  constructor(sessionId: string) {
    super(`非法会话 id（不允许路径穿越）: ${sessionId}`);
    this.name = "VisBadSessionIdError";
  }
}

/** 会话不存在（结构化 404）。 */
export class VisSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`会话不存在: ${sessionId}`);
    this.name = "VisSessionNotFoundError";
  }
}

export interface VisHandlerOptions {
  manager: SessionManager;
  /** 是否开启令牌校验（非回环绑定时为 true）。 */
  requireToken: boolean;
  /** 生效令牌（requireToken=false 时可为空）。 */
  token: string;
  /**
   * BI-20.5 接线：令牌权威端口（可选）。注入后令牌校验走权威的 validate
   * （轮转语义：当前令牌恒真、上一代令牌在宽限期内双活）；缺省走现状静态
   * 令牌比对（token 字符串相等）。
   */
  tokens?: TokenAuthority;
}

/** vis 请求处理器：纯函数，便于单测直测路由矩阵（不启真实 socket）。 */
export class VisHandler {
  readonly manager: SessionManager;
  readonly requireToken: boolean;
  readonly token: string;
  /** BI-20.5 接线：令牌权威端口（缺省 undefined = 静态令牌路径）。 */
  readonly tokens: TokenAuthority | undefined;

  constructor(options: VisHandlerOptions) {
    this.manager = options.manager;
    this.requireToken = options.requireToken;
    this.token = options.token;
    this.tokens = options.tokens;
  }

  async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed", method: request.method }, 405);
    }
    // 骨架页：非 API，不校验令牌（页面不含令牌，数据面全部由 /api/* 把守）。
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderIndexHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (!url.pathname.startsWith("/api/")) {
      return json({ error: "not_found", path: url.pathname }, 404);
    }
    // 令牌门禁（未授权优先于 404，防路径探测）。
    if (this.requireToken && !this.authorized(request, url)) {
      return json(
        { error: "unauthorized", hint: `请提供 ${AUTH_TOKEN_ENV} 对应的 ?t= 或 Authorization: Bearer` },
        401,
      );
    }
    if (url.pathname === "/api/sessions") {
      return json(await this.manager.listSessions());
    }
    const m = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (m !== null) {
      const sessionId = decodeURIComponent(m[1]!);
      try {
        return json(await buildSessionDetail(this.manager, sessionId));
      } catch (error) {
        if (error instanceof VisBadSessionIdError) {
          return json({ error: "invalid_session_id", sessionId }, 400);
        }
        if (error instanceof VisSessionNotFoundError) {
          return json({ error: "session_not_found", sessionId }, 404);
        }
        if (error instanceof SessionNotFoundError) {
          return json({ error: "session_not_found", sessionId }, 404);
        }
        throw error;
      }
    }
    return json({ error: "not_found", path: url.pathname }, 404);
  }

  private authorized(request: Request, url: URL): boolean {
    const candidates = extractTokenCandidates(request, url);
    // BI-20.5 接线：权威端口优先（轮转语义：宽限期内旧令牌仍过）；缺省静态比对。
    if (this.tokens !== undefined) {
      return candidates.some((c) => this.tokens!.validate(c));
    }
    if (this.token.length === 0) return false;
    return candidates.some((c) => c === this.token);
  }
}

export interface VisServerInfo {
  url: string;
  hostname: string;
  port: number;
}

export interface VisServerDeps {
  manager: SessionManager;
  hostname: string;
  port: number;
  requireToken: boolean;
  token: string;
  /** BI-20.5 接线：令牌权威端口（缺省 undefined = 静态令牌路径）。 */
  tokens?: TokenAuthority;
  /** 可注入的 serve 工厂（测试替身，避免真实监听）；缺省 Bun.serve。 */
  serve?: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Promise<Response>;
  }) => { port: number; stop: (close?: boolean) => void };
}

/** 本地可视化服务器封装（Bun.serve 包装，提供 info/stop）。 */
export class VisServer {
  private readonly deps: Required<Omit<VisServerDeps, "tokens">> & { tokens?: TokenAuthority };
  private server: { port: number; stop: (close?: boolean) => void } | null = null;
  private readonly handler: VisHandler;

  constructor(deps: VisServerDeps) {
    this.deps = {
      serve: defaultServe,
      ...deps,
    };
    this.handler = new VisHandler({
      manager: deps.manager,
      requireToken: deps.requireToken,
      token: deps.token,
      ...(deps.tokens !== undefined ? { tokens: deps.tokens } : {}),
    });
  }

  get running(): boolean {
    return this.server !== null;
  }

  start(): VisServerInfo {
    if (this.server !== null) return this.info();
    this.server = this.deps.serve({
      hostname: this.deps.hostname,
      port: this.deps.port,
      fetch: (request) => this.handler.dispatch(request),
    });
    return this.info();
  }

  info(): VisServerInfo {
    if (this.server === null) throw new Error("VisServer 尚未启动");
    return {
      url: `http://${this.deps.hostname}:${this.server.port}/`,
      hostname: this.deps.hostname,
      port: this.server.port,
    };
  }

  stop(): void {
    if (this.server !== null) {
      this.server.stop(true);
      this.server = null;
    }
  }
}

function defaultServe(options: {
  hostname: string;
  port: number;
  fetch: (request: Request) => Promise<Response>;
}): { port: number; stop: (close?: boolean) => void } {
  const server = Bun.serve(options);
  const port = server.port ?? 0;
  return { port, stop: (close?: boolean) => server.stop(close ?? true) };
}

export interface HandleVisArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/**
 * 解析 `bi vis [sessionId] [--port N] [--host H]` 旗标；未知旗标/缺值/重复 → SubUsageError。
 */
export function parseVisArgs(rest: readonly string[]): HandleVisArgs {
  const valueFlags = new Set<string>(["--port", "--host"]);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let i = 0;
  while (i < rest.length) {
    const token = rest[i]!;
    i += 1;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (valueFlags.has(flag)) {
      const rawValue = eq === -1 ? rest[i++] : token.slice(eq + 1);
      if (rawValue === undefined || rawValue === "" || rawValue.startsWith("-")) {
        throw new SubUsageError(`参数 ${flag} 缺少值`);
      }
      if (flags.has(flag)) throw new SubUsageError(`参数重复: ${flag}`);
      flags.set(flag, rawValue);
      continue;
    }
    throw new SubUsageError(`未知参数: ${token}`);
  }
  if (positionals.length > 1) {
    throw new SubUsageError("用法: bi vis [sessionId] [--port N] [--host H]");
  }
  return { positionals, flags };
}

/** vis 用法错误（handleVis 统一归 exit 2）。 */
export class SubUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubUsageError";
  }
}

export interface HandleVisOptions {
  /** 会话数据源（缺省按 deps.sessionsRoot 装配 SessionManager）。 */
  manager?: SessionManager;
  /** 缺省 127.0.0.1；可被 --host 覆盖。 */
  defaultHost?: string;
  /** 注入 serve 工厂（测试替身）；生产用真实 Bun.serve。 */
  serve?: VisServerDeps["serve"];
  /** 读环境变量的函数（测试注入）；缺省 process.env。 */
  getEnv?: (name: string) => string | undefined;
  /** 是否进入常驻监听（false=仅装配并返回 info，不绑定信号/不常驻）；测试用。 */
  attachSignals?: boolean;
  /**
   * BI-20.5 接线：令牌轮转权威工厂（注入面）。core 不依赖 tui——轮转引擎在
   * tui 侧，由宿主注入；本端口缺省时即便 env 开启也回退静态令牌路径（如实告警）。
   */
  tokenAuthority?: VisTokenAuthorityFactory;
}

/**
 * `bi vis [sessionId] [--port N] [--host H]` 处理器：
 *   - 解析旗标、装配 manager、校验 host/token 策略、启服、打印 URL、SIGINT 退出。
 *   - 非回环绑定且缺 BI_VIS_AUTH_TOKEN → 结构化拒绝启动（exit 1，不假冒）。
 *   - BI-20.5 接线：env BI_VIS_TOKEN_ROTATE=1 且宿主注入轮转权威 → 令牌校验走
 *     轮转（当前令牌恒真、上一代令牌宽限期内双活）；否则走现状静态令牌路径。
 */
export async function handleVis(
  rest: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void },
  deps: { manager?: SessionManager; sessionsRoot?: string } = {},
  options: HandleVisOptions = {},
): Promise<number> {
  const args = parseVisArgs(rest);
  const host = (typeof args.flags.get("--host") === "string"
    ? (args.flags.get("--host") as string)
    : (options.defaultHost ?? DEFAULT_HOST));
  const portRaw = args.flags.get("--port");
  const port = portRaw !== undefined ? Number.parseInt(portRaw as string, 10) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    io.err(`bi vis: --port 非法: ${String(portRaw)}（需 0-65535）`);
    io.err("运行 bi vis --help 查看用法");
    return 2;
  }

  const nonLoopback = !isLoopback(host);
  const getEnv = options.getEnv ?? ((name: string) => process.env[name]);
  // BI-20.5 接线：令牌轮转（可选增强，env 显式 opt-in）。轮转权威由宿主注入
  // （core 不依赖 tui）——未注入时回退静态令牌路径并如实告警，不静默降级。
  const rotateEnabled = getEnv(TOKEN_ROTATE_ENV) === "1";
  let startedUrl = "";
  let authority: TokenAuthority | undefined;
  if (rotateEnabled) {
    if (options.tokenAuthority !== undefined) {
      authority = options.tokenAuthority((token) => {
        io.out(`bi vis: 令牌已轮转 → 新访问链接 ${startedUrl}?t=${encodeURIComponent(token)}`);
      });
    } else {
      io.err(
        `bi vis: ${TOKEN_ROTATE_ENV}=1 但未装配令牌轮转权威（宿主未注入）——回退静态令牌路径`,
      );
    }
  }
  let token = "";
  if (authority !== undefined) {
    // 轮转权威自带令牌（当前令牌即访问凭据；轮转后由 onRotate 回调重印链接）。
    token = authority.current();
  } else if (nonLoopback) {
    token = getEnv(AUTH_TOKEN_ENV) ?? "";
    if (token.length === 0) {
      io.err(
        `bi vis: 非回环绑定 ${host} 需要环境变量 ${AUTH_TOKEN_ENV}（缺失则拒绝启动，避免裸奔暴露）`,
      );
      return 1;
    }
  }

  const manager =
    options.manager ?? deps.manager ?? new SessionManager(
      deps.sessionsRoot !== undefined ? { rootDir: deps.sessionsRoot } : {},
    );

  const server = new VisServer({
    manager,
    hostname: host,
    port,
    requireToken: authority !== undefined || nonLoopback,
    token,
    ...(authority !== undefined ? { tokens: authority } : {}),
    ...(options.serve !== undefined ? { serve: options.serve } : {}),
  });
  const info = server.start();
  startedUrl = info.url;
  io.out(`bi vis: 已启动 → ${info.url}`);
  if (authority !== undefined) {
    io.out(`bi vis: 访问链接（含令牌）→ ${info.url}?t=${encodeURIComponent(authority.current())}`);
    io.out(`bi vis: 已启用令牌轮转（${TOKEN_ROTATE_ENV}）——令牌定期轮转，旧令牌在宽限期内仍有效`);
  } else if (nonLoopback) {
    io.out(`bi vis: 已启用令牌校验（${AUTH_TOKEN_ENV}）；访问请带 ?t= 或 Authorization: Bearer`);
  }
  const deepLink = args.positionals[0];
  if (deepLink !== undefined && isSafeSessionId(deepLink)) {
    io.out(`bi vis: 会话深链 → ${info.url}?session=${encodeURIComponent(deepLink)}`);
  }

  if (options.attachSignals !== false) {
    const onSigint = () => {
      io.err("bi vis: 收到 SIGINT，正在优雅关闭…");
      server.stop();
      process.exit(0);
    };
    process.on("SIGINT", onSigint);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 单文件零依赖内联 HTML（vanilla + 内联 CSS + 原生 JS；零构建/零依赖/零 CDN）
// ---------------------------------------------------------------------------

/** 内联 HTML 骨架：会话列表 → 点开 → 消息流(按类型着色) + 分支树(缩进树) + 工具 <details> 折叠卡。 */
export function renderIndexHtml(): string {
  return INDEX_HTML;
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>bi vis · 会话可视化</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: ui-monospace, Menlo, Consolas, monospace; margin: 0; background: #0d1117; color: #e6edf3; }
header { padding: 12px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 12px; align-items: baseline; }
header h1 { font-size: 16px; margin: 0; color: #79c0ff; }
header .hint { color: #8b949e; font-size: 12px; }
#error-box { display: none; margin: 8px 16px; padding: 8px 12px; border: 1px solid #f85149; border-radius: 6px; color: #f85149; font-size: 12px; }
main { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 49px); }
#sidebar { border-right: 1px solid #21262d; padding: 12px; overflow: auto; }
#content { padding: 12px 16px; overflow: auto; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin: 0 0 8px; }
ul#session-list { list-style: none; margin: 0; padding: 0; }
#session-list li { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
#session-list li:hover, #session-list li.active { background: #161b22; }
#session-list .sid { color: #7ee787; }
#session-list .stitle { color: #e6edf3; margin-left: 8px; }
#session-list .fork { color: #8b949e; font-size: 11px; margin-left: 6px; }
.empty { color: #8b949e; font-size: 12px; }
.msg { border-left: 2px solid #30363d; padding: 6px 10px; margin: 8px 0; }
.msg .role { font-size: 12px; margin-right: 8px; font-weight: 600; }
.msg-user { border-color: #1f6feb; }
.msg-user .role { color: #79c0ff; }
.msg-assistant { border-color: #8957e5; }
.msg-assistant .role { color: #d2a8ff; }
.msg-system { border-color: #9e6a03; }
.msg-system .role { color: #e3b341; }
.msg-compaction { border-color: #6e7681; }
.msg-compaction .role { color: #8b949e; }
.msg-tool_call, .msg-tool_result { border-color: #2ea043; }
.msg-tool_call .role, .msg-tool_result .role { color: #3fb950; }
.msg .body { color: #c9d1d9; white-space: pre-wrap; word-break: break-word; }
.tree { font-size: 12px; line-height: 1.6; }
.tree .node { color: #e6edf3; }
.tree .node .t { color: #8b949e; }
details.tool { border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; margin: 8px 0; background: #161b22; }
details.tool summary { cursor: pointer; color: #79c0ff; font-weight: 600; }
details.tool pre { background: #0d1117; border-radius: 6px; padding: 8px; overflow: auto; margin: 8px 0 0; }
</style>
</head>
<body>
<header><h1>bi vis</h1><span class="hint">本地会话可视化 · 列表 / 消息流 / 分支树 / 工具折叠卡 · 零外部依赖</span></header>
<div id="error-box"></div>
<main>
<aside id="sidebar"><h2>会话列表</h2><ul id="session-list"></ul></aside>
<section id="content"><div class="empty">← 选择左侧会话查看消息流与分支树</div></section>
</main>
<script>
(function () {
  'use strict';
  var TOKEN = new URLSearchParams(window.location.search).get('t') || '';
  function withToken(path) {
    if (!TOKEN) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(TOKEN);
  }
  function getJSON(path) {
    return fetch(withToken(path)).then(function (r) {
      if (r.status === 401) { throw new Error('401 令牌无效或缺失，请使用带 ?t= 的访问链接'); }
      if (r.status === 404) { throw new Error('404 会话不存在'); }
      if (!r.ok) { throw new Error('HTTP ' + r.status + ' - ' + path); }
      return r.json();
    });
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function showError(err) {
    var box = document.getElementById('error-box');
    box.textContent = String(err && err.message ? err.message : err);
    box.style.display = 'block';
  }
  function fmtTime(ms) {
    if (typeof ms !== 'number') return '';
    try { return new Date(ms).toLocaleString(); } catch (e) { return ''; }
  }
  function brief(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      try { return JSON.stringify(value).slice(0, 400); } catch (e) { return ''; }
    }
    return String(value).slice(0, 400);
  }

  function loadSessions() {
    return getJSON('/api/sessions').then(function (metas) {
      var list = document.getElementById('session-list');
      list.textContent = '';
      if (!Array.isArray(metas) || metas.length === 0) {
        list.appendChild(el('li', 'empty', '(暂无会话)'));
        return;
      }
      metas.forEach(function (s) {
        var li = el('li');
        var id = String(s.sessionId || s.id || '');
        li.appendChild(el('span', 'sid', id));
        li.appendChild(el('span', 'stitle', String(s.title || '(未命名会话)')));
        if (s.forkedFrom) li.appendChild(el('span', 'fork', '(fork ' + s.forkedFrom + ')'));
        li.addEventListener('click', function () {
          var prev = list.querySelector('.active');
          if (prev) prev.classList.remove('active');
          li.classList.add('active');
          openSession(id);
        });
        list.appendChild(li);
      });
    });
  }

  function openSession(id) {
    return getJSON('/api/sessions/' + encodeURIComponent(id)).then(function (detail) {
      renderDetail(detail);
    });
  }

  function renderDetail(detail) {
    var content = document.getElementById('content');
    content.textContent = '';
    var meta = detail.meta || {};
    content.appendChild(el('h2', null, '会话 ' + (meta.sessionId || '') + (meta.title ? ' · ' + meta.title : '')));
    content.appendChild(el('div', 'empty', '创建于 ' + fmtTime(meta.createdAt) + (meta.cwd ? ' · cwd ' + meta.cwd : '') + (meta.forkedFrom ? ' · forkedFrom ' + meta.forkedFrom : '')));

    // 分支树（缩进树）
    var treeH = el('h2', null, '分支树（parentId 森林）');
    var tree = el('div', 'tree');
    (detail.branchTree || []).forEach(function (n) {
      var line = el('div', 'node');
      line.style.paddingLeft = (n.depth * 16) + 'px';
      line.appendChild(document.createTextNode('\\u2514 '.repeat(0) + ('  '.repeat(n.depth)) + n.id + ' '));
      line.appendChild(el('span', 't', '[' + n.type + (n.parentId ? '' : ', root') + ']'));
      tree.appendChild(line);
    });
    if ((detail.branchTree || []).length === 0) tree.appendChild(el('div', 'empty', '(空)'));
    content.appendChild(treeH);
    content.appendChild(tree);

    // 消息流（按类型着色）
    var msgsH = el('h2', null, '消息流（按类型着色）');
    content.appendChild(msgsH);
    (detail.entries || []).forEach(function (e) {
      var box = el('div', 'msg msg-' + e.type);
      box.appendChild(el('span', 'role', '#' + e.seq + ' ' + e.type + (e.toolName ? ' ' + e.toolName : '')));
      var body = el('div', 'body');
      body.textContent = brief(e.payload);
      box.appendChild(body);
      content.appendChild(box);
    });
    if ((detail.entries || []).length === 0) content.appendChild(el('div', 'empty', '(暂无消息)'));

    // 工具调用折叠卡
    var tools = detail.tools || [];
    if (tools.length > 0) {
      content.appendChild(el('h2', null, '工具调用（按 toolCallId 配对）'));
      tools.forEach(function (tp) {
        var d = document.createElement('details');
        d.className = 'tool';
        var summary = document.createElement('summary');
        summary.textContent = (tp.name || '(未知工具)') + ' · ' + tp.toolCallId;
        d.appendChild(summary);
        var inputPre = document.createElement('pre');
        inputPre.textContent = 'INPUT:\\n' + brief(tp.call ? tp.call.payload : null);
        var outputPre = document.createElement('pre');
        outputPre.textContent = 'OUTPUT:\\n' + brief(tp.result ? tp.result.payload : null);
        d.appendChild(inputPre);
        d.appendChild(outputPre);
        content.appendChild(d);
      });
    }
  }

  var deep = new URLSearchParams(window.location.search).get('session');
  loadSessions().then(function () {
    if (deep) openSession(deep);
  }).catch(showError);
})();
</script>
</body>
</html>
`;
