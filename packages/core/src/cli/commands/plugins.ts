/**
 * X4 波次二 —— `bi plugins [list|validate] [--dir <目录>]` 子命令：@bi/plugins
 * 声明层加载器的 CLI 面。
 *
 * 参数面：
 *   bi plugins [list|validate] [--dir <目录>]
 *
 * 行为：
 * - 扫描根：--dir 指定单一目录；缺省 ~/.bi/plugins 与 ./.bi/plugins（均不存在则静默跳过）；
 * - 用 @bi/plugins 加载器（probePluginManifest 探测双协议 + loadPlugin 解析声明 +
 *   validatePlugin 结构化校验），纯声明式、零代码执行；
 * - list：逐插件一行 JSON（name/version/来源协议/skills+mcpservers 计数/目录）；
 * - validate：逐插件一行结构化校验报告（ok + problems）；任一 ok=false → exit 1；
 * - 加载失败候选逐条结构化警告写 stderr，不阻塞其余插件（诚实不假冒）；
 * - install/marketplace 不做（无网络保证），list 尾注一行说明。
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SubcommandDeps, SubcommandIo } from "./dispatch";
import {
  loadPlugin,
  probePluginManifest,
  validatePlugin,
  type PluginManifest,
  type PluginProtocol,
} from "../../../../plugins/src/loader";

/** 单个成功加载的插件（附来源目录与探测到的协议）。 */
interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  protocol: PluginProtocol;
}

/** 加载失败候选（结构化警告；不阻塞其余插件）。 */
interface LoadWarning {
  dir: string;
  reason: string;
}

/** 用法错误（本 handler 自持解析，统一归 exit 2）。 */
class PluginsUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginsUsageError";
  }
}

/** 解析 `[list|validate] [--dir <目录>]`。 */
function parsePluginsArgs(rest: readonly string[]): { action: "list" | "validate"; dir?: string } {
  let action: "list" | "validate" | undefined;
  let dir: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) break;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const flag = eq === -1 ? token : token.slice(0, eq);
      if (flag !== "--dir") {
        throw new PluginsUsageError(`未知参数: ${token}`);
      }
      const raw = eq === -1 ? rest[++i] : token.slice(eq + 1);
      if (raw === undefined || raw === "") {
        throw new PluginsUsageError(`参数 ${flag} 缺少值`);
      }
      if (dir !== undefined) {
        throw new PluginsUsageError(`参数重复: ${flag}`);
      }
      dir = raw;
      continue;
    }
    if (token !== "list" && token !== "validate") {
      throw new PluginsUsageError(`未知动作 "${token}"（允许: list | validate）`);
    }
    if (action !== undefined) {
      throw new PluginsUsageError(`动作重复: ${token}`);
    }
    action = token;
  }
  return { action: action ?? "list", dir };
}

/** 缺省扫描根：~/.bi/plugins 与 ./.bi/plugins（去重保序）。 */
export function defaultPluginRoots(deps: SubcommandDeps): string[] {
  const home = deps.homeDir ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const roots = [join(home, ".bi", "plugins"), join(cwd, ".bi", "plugins")];
  return [...new Set(roots.map((r) => resolve(r)))];
}

/**
 * 扫描根目录集：每个根的一级子目录为候选；无清单的目录静默跳过；
 * 加载失败进 warnings（不抛、不阻塞）。重复 name 先到先得，后者进 warnings。
 */
async function scanPlugins(
  roots: readonly string[],
): Promise<{ plugins: LoadedPlugin[]; warnings: LoadWarning[] }> {
  const plugins: LoadedPlugin[] = [];
  const warnings: LoadWarning[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let dirents;
    try {
      dirents = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // 可选根：不存在/不可读即跳过
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dent of dirents) {
      if (!dent.isDirectory()) continue;
      const candidate = join(root, dent.name);
      const probe = await probePluginManifest(candidate);
      if (probe === null) continue; // 非插件目录（静默，与 discoverPlugins 同语义）
      try {
        const manifest = await loadPlugin(candidate);
        if (seen.has(manifest.name)) {
          warnings.push({
            dir: candidate,
            reason: `duplicate-name: 插件 '${manifest.name}' 已由更早的目录提供，后者拒绝（先到先得）`,
          });
          continue;
        }
        seen.add(manifest.name);
        plugins.push({ manifest, dir: candidate, protocol: probe.protocol });
      } catch (cause) {
        warnings.push({
          dir: candidate,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }
  return { plugins, warnings };
}

/**
 * `bi plugins [list|validate] [--dir <目录>]`。
 * 退出码：0 全部成功（validate 全 ok）/ 1 校验有发现项 / 2 用法错误。
 */
export async function handlePlugins(
  rest: readonly string[],
  io: SubcommandIo,
  deps: SubcommandDeps,
): Promise<number> {
  let parsed;
  try {
    parsed = parsePluginsArgs(rest);
  } catch (cause) {
    io.err(`bi plugins: ${(cause as Error).message}`);
    io.err("运行 bi plugins --help 查看用法");
    return 2;
  }
  const roots = parsed.dir !== undefined ? [resolve(parsed.dir)] : defaultPluginRoots(deps);
  const { plugins, warnings } = await scanPlugins(roots);

  if (parsed.action === "list") {
    for (const plugin of plugins) {
      io.out(
        JSON.stringify({
          name: plugin.manifest.name,
          version: plugin.manifest.version ?? "",
          protocol: plugin.protocol,
          skills: plugin.manifest.skills.length,
          mcpservers: Object.keys(plugin.manifest.mcpServers ?? {}).length,
          dir: plugin.dir,
        }),
      );
    }
    for (const warning of warnings) {
      io.err(`bi plugins: 警告: ${warning.dir}: ${warning.reason}`);
    }
    io.err(`bi plugins: 共 ${plugins.length} 个插件（${roots.length} 个扫描根）`);
    // 尾注：install/marketplace 本波不做（无网络保证）。
    io.err("bi plugins: install/marketplace 暂未提供（无网络保证，本波不做）");
    return 0;
  }

  // validate：逐插件结构化校验报告（含加载失败候选，报告 ok:false 不阻塞）。
  let allOk = true;
  for (const plugin of plugins) {
    const report = await validatePlugin(plugin.dir);
    if (!report.ok) allOk = false;
    io.out(
      JSON.stringify({
        name: plugin.manifest.name,
        dir: plugin.dir,
        ok: report.ok,
        problems: report.problems,
      }),
    );
  }
  for (const warning of warnings) {
    allOk = false;
    io.out(JSON.stringify({ name: null, dir: warning.dir, ok: false, problems: [warning.reason] }));
  }
  return allOk ? 0 : 1;
}
