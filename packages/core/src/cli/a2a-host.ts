/**
 * A2aHost 配置→启动胶水模块：把 config 的 A2aSection 翻译成 @bi/a2a 的
 * HostOptions 并拉起 TCP 探活面，回实际绑定地址。
 *
 * - listen 解析 "ip:port"（port 0 = 内核随机，回真实 port）；
 * - allow 白名单透传为 HostOptions.allowFrom（空 = 宿主缺省全角色）；
 * - 共享令牌从环境变量读（缺省 BI_A2A_TOKEN，可用 tokenEnv 覆盖）；
 *   缺省空时回环绑定用一次性随机密钥（不出进程）；
 * - 安全对齐 bi vis 先例（BI_VIS_AUTH_TOKEN）：非回环 listen 且无令牌 →
 *   结构化拒绝，不启动（0.0.0.0/:: 属通配绑定，视作非回环）；
 * - enabled=false 或 listen 非法 → 结构化 { ok:false, reason } 不抛。
 *
 * 分层声明：本模块只做配置翻译与监听探活面；角色派生/传输接线/dispatch
 * 归后续工单（子命令装配波次），此处不碰。
 */

import { randomUUID } from "node:crypto";
import { a2aSecret } from "../../../a2a/src/auth";
import { A2aHost } from "../../../a2a/src/host";
import type { A2aSection } from "../config/schema";

/** 缺省令牌环境变量名（对齐 bi vis 的 BI_VIS_AUTH_TOKEN 先例）。 */
export const A2A_TOKEN_ENV = "BI_A2A_TOKEN";

/** 启动成功句柄：host 实例 + 实际绑定地址 + 干净关闭。 */
export interface A2aHostStart {
  readonly ok: true;
  readonly host: A2aHost;
  /** 实际绑定端口（listen port=0 时为内核分配的真实端口）。 */
  readonly port: number;
  /** 实际绑定地址 "ip:port"。 */
  readonly address: string;
  /** 关闭监听（含活动连接），幂等安全。 */
  close(): void;
}

/** 结构化拒绝（不抛异常；reason 稳定可编程判断）。 */
export interface A2aHostRefused {
  readonly ok: false;
  readonly reason: string;
}

export type A2aHostStartResult = A2aHostStart | A2aHostRefused;

/** 启动选项：cwd 预留给子命令装配波次；tokenEnv 覆盖令牌环境变量名。 */
export interface StartA2aHostOptions {
  cwd?: string;
  tokenEnv?: string;
}

/** 判定 listen 主机是否回环（0.0.0.0/:: 通配绑定视作非回环，对齐 vis）。 */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** 解析 "ip:port"（IPv4/localhost/::1 字面量；port 0-65535，0=随机）。 */
export function parseListen(listen: string): { hostname: string; port: number } | { error: string } {
  const idx = listen.lastIndexOf(":");
  if (idx <= 0 || idx === listen.length - 1) {
    return { error: `listen 非法（需 "ip:port"）: ${listen}` };
  }
  const hostname = listen.slice(0, idx).trim();
  const portRaw = listen.slice(idx + 1).trim();
  if (hostname.length === 0) {
    return { error: `listen 主机为空: ${listen}` };
  }
  const port = Number.parseInt(portRaw, 10);
  if (!/^\d+$/.test(portRaw) || !Number.isInteger(port) || port < 0 || port > 65535) {
    return { error: `listen 端口非法（需 0-65535）: ${listen}` };
  }
  return { hostname, port };
}

/**
 * 把 A2aSection 翻译成 HostOptions 并启动探活监听。
 * 返回成功句柄（host/port/address/close）或结构化拒绝，不抛。
 */
export async function startA2aHost(
  section: A2aSection,
  opts: StartA2aHostOptions = {},
): Promise<A2aHostStartResult> {
  if (!section.enabled) {
    return { ok: false, reason: "a2a-disabled" };
  }
  const parsed = parseListen(section.listen);
  if ("error" in parsed) {
    return { ok: false, reason: parsed.error };
  }
  const { hostname, port } = parsed;

  const tokenEnv = opts.tokenEnv ?? A2A_TOKEN_ENV;
  const token = process.env[tokenEnv] ?? "";
  if (!isLoopbackHost(hostname) && token.length === 0) {
    return {
      ok: false,
      reason: `非回环绑定 ${hostname} 需要环境变量 ${tokenEnv}（缺失则拒绝启动，避免裸奔暴露）`,
    };
  }
  // 共享密钥：令牌即密钥；回环无令牌时用一次性随机密钥（不出进程）。
  const secret = a2aSecret(token.length > 0 ? token : randomUUID());
  const host = new A2aHost({
    secret,
    ...(section.allow.length > 0 ? { allowFrom: section.allow } : {}),
  });

  const server = Bun.serve({
    hostname,
    port,
    fetch: () =>
      new Response(JSON.stringify({ service: "bi-a2a", status: "ok" }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });
  return {
    ok: true,
    host,
    port: server.port ?? 0,
    address: `${server.hostname}:${server.port ?? 0}`,
    close(): void {
      server.stop(true);
    },
  };
}
