/**
 * BI-20.5 — bi vis：本地 Web 会话交互可视化服务器。
 *
 * - Bun.serve 绑定 127.0.0.1，端口默认 0（内核随机分配）；
 * - 路由：
 *     GET /                    零依赖内联 HTML 骨架页（会话 DAG / 轮次水流 / 工具卡片 / Diff）
 *     GET /api/sessions        manager.listSessions() 透传
 *     GET /api/session/:id     会话全量条目（BI-03 SessionManager.entries 透传，404=会话不存在）
 *     GET /api/entry/:id       单条 history 条目（跨会话按条目 id 查找）
 * - 所有 /api/* 经访问令牌校验（?t= 或 Authorization: Bearer <token>），
 *   缺失或不匹配一律 401；非 GET 一律 405；
 * - 会话数据复用 BI-03 SessionManager（session/ 既有资产），零 npm 依赖。
 */

import { SessionNotFoundError, type SessionManager } from "../session/manager";
import type { SessionEntry } from "../session/types";

/** 令牌校验最小结构面：TokenRotator（packages/tui/src/vis/token-rotator.ts）天然满足。 */
export interface TokenAuthority {
  current(): string;
  validate(token: string | null | undefined): boolean;
}

export interface VisServerOptions {
  /** 会话数据源：BI-03 SessionManager 实例。 */
  manager: SessionManager;
  /** 令牌校验器。 */
  tokens: TokenAuthority;
  /** 监听地址，默认 127.0.0.1（仅本地回环）。 */
  hostname?: string;
  /** 监听端口，默认 0 = 内核随机端口。 */
  port?: number;
}

export interface VisServerInfo {
  url: string;
  hostname: string;
  port: number;
  /** 启动时刻快照的当前访问令牌（便利字段）。 */
  token: string;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS,
  });
}

/** 从请求中提取候选令牌：URL ?t= 优先，其次 Authorization（Bearer 或裸值）。 */
function extractTokenCandidates(request: Request, url: URL): string[] {
  const candidates: string[] = [];
  const urlToken = url.searchParams.get("t");
  if (urlToken !== null && urlToken.length > 0) {
    candidates.push(urlToken);
  }
  const auth = request.headers.get("authorization");
  if (auth !== null) {
    const trimmed = auth.trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(trimmed);
    candidates.push(bearer !== null ? (bearer[1]?.trim() ?? trimmed) : trimmed);
  }
  return candidates;
}

/**
 * 极简零依赖内联 HTML 骨架：会话 DAG 列表 + 轮次水流 + 工具卡片 + Diff 展示。
 * 样式与脚本全部内联，不引用任何外部资源；令牌经 ?t= 透传给 /api/* 调用，
 * 页面主体不内嵌令牌（避免无令牌访问者从 HTML 中读出凭据）。
 */
export function renderIndexHtml(): string {
  return INDEX_HTML;
}

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>bi vis · 会话交互可视化</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { font-family: ui-monospace, Menlo, Consolas, monospace; margin: 0; background: #0d1117; color: #e6edf3; }
header { padding: 12px 16px; border-bottom: 1px solid #21262d; display: flex; gap: 12px; align-items: baseline; }
header h1 { font-size: 16px; margin: 0; color: #79c0ff; }
header .hint { color: #8b949e; font-size: 12px; }
#error-box { display: none; margin: 8px 16px; padding: 8px 12px; border: 1px solid #f85149; border-radius: 6px; color: #f85149; font-size: 12px; }
main { display: grid; grid-template-columns: 300px 1fr; min-height: calc(100vh - 49px); }
nav#session-dag { border-right: 1px solid #21262d; padding: 12px; }
.panes section { padding: 12px 16px; border-bottom: 1px solid #21262d; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #8b949e; margin: 0 0 8px; }
ul#session-list, ol#turn-list { list-style: none; margin: 0; padding: 0; }
#session-list li { padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; gap: 8px; }
#session-list li:hover, #session-list li.active { background: #161b22; }
#session-list li.dag-child { margin-left: 16px; }
#session-list li.dag-child .sid::before { content: "\\2514 "; color: #8b949e; }
#session-list .sid { color: #7ee787; min-width: 42px; }
#session-list .stitle { color: #e6edf3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#turn-list li.turn { border-left: 2px solid #30363d; padding: 4px 10px; margin: 6px 0; }
#turn-list .role { color: #d2a8ff; margin-right: 8px; font-size: 12px; }
#turn-list .text { color: #c9d1d9; }
.tool-card { border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; margin: 8px 0; background: #161b22; display: flex; gap: 10px; align-items: baseline; }
.tool-card .name { color: #79c0ff; font-weight: 600; }
.tool-card .status-ok { color: #3fb950; }
.tool-card .status-err { color: #f85149; }
.tool-card .brief { color: #8b949e; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: #8b949e; font-size: 12px; }
pre.diff { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 10px; overflow: auto; margin: 0; }
pre.diff .add { color: #3fb950; }
pre.diff .del { color: #f85149; }
</style>
</head>
<body>
<header><h1>bi vis</h1><span class="hint">本地会话交互可视化 · 会话 DAG / 轮次水流 / 工具卡片 / Diff · 零外部依赖</span></header>
<div id="error-box"></div>
<main>
<nav id="session-dag"><h2>会话 DAG</h2><ul id="session-list"></ul></nav>
<div class="panes">
<section id="turn-flow"><h2>轮次水流</h2><ol id="turn-list"></ol></section>
<section id="tool-cards"><h2>工具卡片</h2><div id="tool-card-list"></div></section>
<section id="diff-view"><h2>Diff</h2><pre id="diff-content" class="diff"></pre></section>
</div>
</main>
<script>
(function () {
  'use strict';
  var TOKEN = new URLSearchParams(window.location.search).get('t') || '';
  function withToken(path) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(TOKEN);
  }
  function getJSON(path) {
    return fetch(withToken(path)).then(function (r) {
      if (r.status === 401) { throw new Error('401 令牌无效或已轮转，请使用带最新 ?t= 的访问链接'); }
      if (!r.ok) { throw new Error('HTTP ' + r.status + ' - ' + path); }
      return r.json();
    });
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined && text !== null) { node.textContent = String(text); }
    return node;
  }
  function showError(err) {
    var box = document.getElementById('error-box');
    box.textContent = String(err && err.message ? err.message : err);
    box.style.display = 'block';
  }
  function pick(obj) {
    for (var i = 1; i < arguments.length; i++) {
      var key = arguments[i];
      if (obj && obj[key] !== undefined && obj[key] !== null) { return obj[key]; }
    }
    return undefined;
  }
  function stringify(value) {
    if (value === undefined || value === null) { return ''; }
    if (typeof value === 'object') { return JSON.stringify(value); }
    return String(value);
  }
  function asList(payload, keys) {
    if (Array.isArray(payload)) { return payload; }
    for (var i = 0; i < keys.length; i++) {
      if (payload && Array.isArray(payload[keys[i]])) { return payload[keys[i]]; }
    }
    return [];
  }

  function loadSessions() {
    return getJSON('/api/sessions').then(function (payload) {
      var list = document.getElementById('session-list');
      list.textContent = '';
      asList(payload, ['sessions', 'items']).forEach(function (s) {
        var li = el('li', 'session-item');
        var id = String(pick(s, 'sessionId', 'id') || '');
        li.dataset.sessionId = id;
        var parent = pick(s, 'forkedFrom', 'parentId', 'parent_id', 'parent');
        if (parent !== undefined && parent !== null) {
          li.classList.add('dag-child');
          li.dataset.parentId = String(parent);
        }
        li.appendChild(el('span', 'sid', id));
        li.appendChild(el('span', 'stitle', String(pick(s, 'title', 'name', 'label') || '(未命名会话)')));
        li.addEventListener('click', function () {
          var prev = list.querySelector('.active');
          if (prev) { prev.classList.remove('active'); }
          li.classList.add('active');
          openSession(id);
        });
        list.appendChild(li);
      });
      if (list.children.length === 0) { list.appendChild(el('li', 'empty', '(暂无会话)')); }
    });
  }

  function openSession(id) {
    return getJSON('/api/session/' + encodeURIComponent(id)).then(function (history) {
      var entries = asList(history, ['entries', 'history', 'turns']);
      renderTurns(entries);
      renderTools(entries);
      renderDiff(entries);
    });
  }

  function renderTurns(entries) {
    var ol = document.getElementById('turn-list');
    ol.textContent = '';
    entries.forEach(function (entry, idx) {
      var li = el('li', 'turn');
      var role = String(pick(entry, 'type', 'role', 'kind') || 'entry');
      li.appendChild(el('span', 'role role-' + role, '#' + (idx + 1) + ' ' + role));
      var text = pick(entry, 'content', 'text', 'summary', 'title', 'payload');
      li.appendChild(el('span', 'text', stringify(text)));
      ol.appendChild(li);
    });
    if (entries.length === 0) { ol.appendChild(el('li', 'empty', '(暂无轮次)')); }
  }

  function renderTools(entries) {
    var box = document.getElementById('tool-card-list');
    box.textContent = '';
    entries.forEach(function (entry) {
      var tool = pick(entry, 'toolName', 'tool', 'tool_name', 'toolUse', 'tool_use');
      if (tool === undefined) { return; }
      var card = el('div', 'tool-card');
      card.appendChild(el('span', 'name', String(tool)));
      var status = String(pick(entry, 'status', 'state') || (entry.type === 'tool_result' ? 'result' : 'call'));
      card.appendChild(el('span', 'status status-' + (status === 'ok' || status === 'success' ? 'ok' : 'err'), status));
      card.appendChild(el('span', 'brief', stringify(pick(entry, 'input', 'args', 'brief', 'toolCallId'))));
      box.appendChild(card);
    });
    if (box.children.length === 0) { box.appendChild(el('div', 'empty', '(本会话暂无工具调用)')); }
  }

  function renderDiff(entries) {
    var pre = document.getElementById('diff-content');
    pre.textContent = '';
    var diffText = '';
    entries.forEach(function (entry) {
      var d = pick(entry, 'diff', 'patch', 'diffText');
      if (typeof d !== 'string' && entry.payload && typeof entry.payload === 'object') {
        d = pick(entry.payload, 'diff', 'patch', 'diffText');
      }
      if (typeof d === 'string' && d.length > 0) { diffText += (diffText ? '\\n' : '') + d; }
    });
    if (diffText.length > 0) {
      diffText.split('\\n').forEach(function (line) {
        var cls = '';
        if (line.indexOf('+') === 0) { cls = 'add'; }
        else if (line.indexOf('-') === 0) { cls = 'del'; }
        pre.appendChild(el('span', cls, line));
        pre.appendChild(document.createTextNode('\\n'));
      });
    } else {
      pre.textContent = '(无 diff)';
    }
  }

  loadSessions().catch(showError);
  window.setInterval(function () { loadSessions().catch(function () {}); }, 5000);
})();
</script>
</body>
</html>
`;

/** bi vis 本地可视化服务器。 */
export class VisServer {
  readonly manager: SessionManager;
  readonly tokens: TokenAuthority;
  readonly hostname: string;
  readonly requestedPort: number;

  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(options: VisServerOptions) {
    this.manager = options.manager;
    this.tokens = options.tokens;
    this.hostname = options.hostname ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
  }

  /** 是否已启动。 */
  get running(): boolean {
    return this.server !== null;
  }

  /** 实际监听端口（未启动时抛错）。 */
  get port(): number {
    if (this.server === null) {
      throw new Error("VisServer 尚未启动");
    }
    const port = this.server.port;
    if (port === undefined) {
      // TCP 监听下不会发生（bun-types 中 unix socket 形态的 port 为可空）。
      throw new Error("VisServer 监听端口不可用");
    }
    return port;
  }

  /** 启动服务器（幂等：重复调用返回现有实例信息）。 */
  start(): VisServerInfo {
    if (this.server !== null) {
      return this.info();
    }
    this.server = Bun.serve({
      hostname: this.hostname,
      port: this.requestedPort,
      fetch: (request: Request): Promise<Response> => this.dispatch(request),
    });
    return this.info();
  }

  /** 当前服务器信息。 */
  info(): VisServerInfo {
    const port = this.port;
    return {
      url: `http://${this.hostname}:${port}/`,
      hostname: this.hostname,
      port,
      token: this.tokens.current(),
    };
  }

  /** 停止服务器（幂等）。 */
  stop(): void {
    if (this.server !== null) {
      this.server.stop(true);
      this.server = null;
    }
  }

  /** 请求分发（export 供测试直测路由矩阵）。 */
  async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed", method: request.method }, 405);
    }
    // HTML 骨架页：非 API，不校验令牌（页面无内嵌令牌，数据面全部由 /api/* 把守）。
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(renderIndexHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    // 其余路径一律视为 API：先令牌，后路由（未授权优先于 404，避免路径探测）。
    if (!this.authorized(request, url)) {
      return json(
        { error: "unauthorized", hint: "令牌缺失或不匹配：请使用 accessUrls 提供的带 ?t= 链接" },
        401,
      );
    }
    if (url.pathname === "/api/sessions") {
      return json(await this.manager.listSessions());
    }
    const sessionRaw = /^\/api\/session\/([^/]+)$/.exec(url.pathname)?.[1];
    if (sessionRaw !== undefined) {
      const sessionId = decodeURIComponent(sessionRaw);
      let entries: SessionEntry[];
      try {
        entries = await this.manager.entries(sessionId);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          return json({ error: "session_not_found", sessionId }, 404);
        }
        throw error;
      }
      return json(entries);
    }
    const entryRaw = /^\/api\/entry\/([^/]+)$/.exec(url.pathname)?.[1];
    if (entryRaw !== undefined) {
      const entryId = decodeURIComponent(entryRaw);
      const entry = await this.findEntry(entryId);
      if (entry === undefined) {
        return json({ error: "entry_not_found", entryId }, 404);
      }
      return json(entry);
    }
    return json({ error: "not_found", path: url.pathname }, 404);
  }

  private authorized(request: Request, url: URL): boolean {
    const candidates = extractTokenCandidates(request, url);
    if (candidates.length === 0) {
      return false;
    }
    return candidates.some((candidate) => this.tokens.validate(candidate));
  }

  /** 跨会话按条目 id 查找单条（UUIDv7 全局唯一，首个命中即返回）。 */
  private async findEntry(entryId: string): Promise<SessionEntry | undefined> {
    const metas = await this.manager.listSessions();
    for (const meta of metas) {
      let entries: SessionEntry[];
      try {
        entries = await this.manager.entries(meta.sessionId);
      } catch {
        continue; // 单个损坏会话不拖垮查找（与 listSessions 容错口径一致）。
      }
      const found = entries.find((entry) => entry.id === entryId);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
}
