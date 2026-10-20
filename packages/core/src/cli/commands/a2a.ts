/**
 * X4 波次二 —— `bi a2a host` 子命令：config [a2a] 分区 → startA2aHost 装配面。
 *
 * 参数面：
 *   bi a2a host [--listen <ip:port>]
 *
 * 行为：
 * - 经 ConfigService 装载全局配置（与 handleConfig 同姿势：homeDir 经 deps 注入），
 *   读 [a2a] 分区；--listen 旗标优先于 config listen；
 * - enabled=false → 结构化 exit 4（能力未配置语义，对齐 upgrade 无 manifest 源）；
 * - 启动成功 → stdout 回结构化单行（实际绑定地址 + token 状态），保持前台运行；
 *   SIGINT/SIGTERM 干净 close 后 exit 0（测试可注入 AbortSignal 替代真实信号）；
 * - 启动拒绝（listen 非法 / 非回环无令牌）→ 结构化 stderr + exit 1，不假冒。
 *
 * 本文件只做子命令装配：host 语义（探活面/令牌规则）归 ../a2a-host，不在此重复。
 */
import type { SubcommandDeps, SubcommandIo } from "./dispatch";
import { ConfigService } from "../../config/config-service";
import { A2A_TOKEN_ENV, startA2aHost } from "../a2a-host";

/** 用法错误（本 handler 自持解析，统一归 exit 2）。 */
class A2aUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "A2aUsageError";
  }
}

/** 信号等待注入面：缺省挂 process SIGINT/SIGTERM（生产前台语义）；测试注入 AbortSignal。 */
export interface A2aCommandOptions {
  signal?: AbortSignal;
}

/** 轻量旗标解析（`--flag value` / `--flag=value`），只认 --listen。 */
function parseA2aArgs(rest: readonly string[]): { positional: string | undefined; listen?: string } {
  let positional: string | undefined;
  let listen: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) break;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const flag = eq === -1 ? token : token.slice(0, eq);
      if (flag !== "--listen") {
        throw new A2aUsageError(`未知参数: ${token}`);
      }
      const raw = eq === -1 ? rest[++i] : token.slice(eq + 1);
      if (raw === undefined || raw === "") {
        throw new A2aUsageError(`参数 ${flag} 缺少值`);
      }
      if (listen !== undefined) {
        throw new A2aUsageError(`参数重复: ${flag}`);
      }
      listen = raw;
      continue;
    }
    if (positional !== undefined) {
      throw new A2aUsageError(`多余位置参数: ${token}`);
    }
    positional = token;
  }
  return { positional, listen };
}

/**
 * `bi a2a host [--listen <ip:port>]`：装配 [a2a] 分区并前台运行。
 * 退出码：0 成功收束 / 1 启动失败 / 2 用法错误 / 4 能力未配置（enabled=false）。
 */
export async function handleA2a(
  rest: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps,
  opts: A2aCommandOptions = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseA2aArgs(rest);
  } catch (cause) {
    io.err(`bi a2a: ${(cause as Error).message}`);
    io.err("运行 bi a2a --help 查看用法");
    return 2;
  }
  if (parsed.positional !== "host") {
    io.err("bi a2a: 缺少动作 host（用法: bi a2a host [--listen <ip:port>]）");
    return 2;
  }

  // 配置装载：与 handleConfig 同姿势（homeDir 注入；测试走临时目录，不触真实 ~/.bi）。
  const service = new ConfigService({
    ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
    ...(deps.cwd !== undefined ? { workDir: deps.cwd } : {}),
  });
  const config = await service.load();
  const section = config.a2a;
  if (section.enabled !== true) {
    io.err("bi a2a: [a2a-disabled] config [a2a] enabled=false（能力未配置；设 enabled=true 后可用）");
    return 4;
  }

  const tokenEnvConfigured = (process.env[A2A_TOKEN_ENV] ?? "").length > 0;
  const listen = parsed.listen ?? section.listen;
  const result = await startA2aHost({ ...section, listen });
  if (!result.ok) {
    if (result.reason === "a2a-disabled") {
      io.err("bi a2a: [a2a-disabled] config [a2a] enabled=false（能力未配置；设 enabled=true 后可用）");
      return 4;
    }
    io.err(`bi a2a: 启动失败: ${result.reason}`);
    return 1;
  }

  // 结构化单行：实际绑定地址 + token 状态（configured = 环境变量令牌；ephemeral = 回环一次性随机密钥）。
  io.out(
    JSON.stringify({
      event: "bi-a2a-host",
      address: result.address,
      port: result.port,
      token: tokenEnvConfigured ? "configured" : "ephemeral",
    }),
  );

  // 前台运行：SIGINT/SIGTERM 干净 close（幂等）后 exit 0。
  await new Promise<void>((resolveWait) => {
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        resolveWait();
      } else {
        opts.signal.addEventListener("abort", () => resolveWait(), { once: true });
      }
      return;
    }
    const onSignal = () => resolveWait();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  result.close();
  io.err(`bi a2a: host 已关闭（${result.address}）`);
  return 0;
}
