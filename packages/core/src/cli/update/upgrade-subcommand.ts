/**
 * BI-29.2 —— `bi upgrade` 自升级链真实挂载。
 *
 * 把 BI-20.7 库内器官(manifest 下载 → sha256 门 → native-swap 原子换装)接上
 * 命令面,退役母体替身(python3 upstream_sync.py 锚点循环门 —— 那是母体仓库的
 * RULE-BI-08 追踪脚本,不是 bi 的升级链)。
 *
 * manifest 源解析:--manifest-url > BI_UPGRADE_MANIFEST_URL > 无源 → 结构化
 * exit 4(不假冒检查成功;manifest 契约 {"version","url","sha256"})。
 * --check 只拉 manifest 比对版本,不下载不替换。全步注入可测
 * (checkFn/downloadFn/swapFn/lockFn),测试零外呼。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../index";
import {
  UpgradeError,
  runUpgradeCommand,
  type UpgradeManifest,
} from "./upgrade-command";
import type { InstallLockHandle } from "./native-swap";

/** 子命令输出汇(与 dispatch SubcommandIo 同形,避免反向依赖)。 */
export interface UpgradeSubIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface UpgradeSubcommandOptions {
  /** --check 语义:拉 manifest 即止,不下载不替换(注入面可省,旗标面承载)。 */
  checkOnly?: boolean;
  /** manifest 地址(--manifest-url / BI_UPGRADE_MANIFEST_URL;缺省空 = 未配置)。 */
  manifestUrl?: string;
  /** 当前版本(缺省 core VERSION 单一数字源)。 */
  currentVersion?: string;
  /** 当前二进制路径(缺省 process.execPath)。 */
  currentBinaryPath?: string;
  /** staging 目录(缺省 ~/.bi/upgrade-staging)。 */
  stagingDir?: string;
  /** 安装锁文件路径(缺省 stagingDir 下 bi-upgrade.lock)。 */
  lockPath?: string;
  /** 注入:manifest 检查步(缺省 fetchJsonManifest;测试一律注入,零外呼)。 */
  checkFn?: (url: string) => Promise<UpgradeManifest>;
  /** 注入:下载校验步(缺省 native-swap.stageDownload)。 */
  downloadFn?: (
    url: string,
    opts: { sha256: string; dir?: string },
  ) => Promise<{ stagedPath: string; bytes: number; sha256: string }>;
  /** 注入:替换步(缺省 native-swap.swapBinary)。 */
  swapFn?: (currentPath: string, stagedPath: string) => Promise<void>;
  /** 注入:锁步(缺省 native-swap.installLock)。 */
  lockFn?: (path: string) => Promise<InstallLockHandle | null>;
}

function defaultStagingDir(): string {
  return join(homedir(), ".bi", "upgrade-staging");
}

/** 升级链编排 + 结果面;退出码:0 成功 / 1 运行失败 / 4 能力不在位(无 manifest 源)。 */
export async function runUpgradeSubcommand(
  options: UpgradeSubcommandOptions,
  io: UpgradeSubIo,
): Promise<number> {
  const manifestUrl = (options.manifestUrl ?? "").trim();
  if (manifestUrl === "") {
    io.err("bi upgrade: 未配置 manifest 源 — 用 --manifest-url <url> 或导出 BI_UPGRADE_MANIFEST_URL。");
    io.err('manifest 契约: {"version","url","sha256"}(sha256 门 + native-swap 原子换装)。');
    return 4;
  }
  const currentVersion = options.currentVersion ?? VERSION;
  try {
    const outcome = await runUpgradeCommand({
      manifestUrl,
      currentVersion,
      checkOnly: options.checkOnly === true,
      stagingDir: options.stagingDir ?? defaultStagingDir(),
      ...(options.currentBinaryPath !== undefined
        ? { currentBinaryPath: options.currentBinaryPath }
        : {}),
      ...(options.lockPath !== undefined ? { lockPath: options.lockPath } : {}),
      ...(options.checkFn !== undefined ? { checkFn: options.checkFn } : {}),
      ...(options.downloadFn !== undefined ? { downloadFn: options.downloadFn } : {}),
      ...(options.swapFn !== undefined ? { swapFn: options.swapFn } : {}),
      ...(options.lockFn !== undefined ? { lockFn: options.lockFn } : {}),
    });
    switch (outcome.action) {
      case "checked":
        io.out(
          `最新版本 ${outcome.manifest.version};当前 ${currentVersion};去掉 --check 执行升级。`,
        );
        return 0;
      case "up-to-date":
        io.out(`bi 已是最新(当前 ${outcome.currentVersion} ≥ manifest ${outcome.manifestVersion})。`);
        return 0;
      case "locked":
        io.err(`bi upgrade: 另一升级进程持锁(${outcome.lockPath}),本次未执行。`);
        return 1;
      case "updated":
        io.out(
          `bi 已升级: ${outcome.from} → ${outcome.to}` +
            `(${(outcome.bytes / 1024).toFixed(1)} KiB,sha256 ${outcome.sha256.slice(0, 12)}…)。`,
        );
        io.out("重启 bi 生效。");
        return 0;
    }
  } catch (e) {
    if (e instanceof UpgradeError) {
      io.err(`bi upgrade: ${e.message}(code=${e.code})`);
      return 1;
    }
    io.err(`bi upgrade: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  return 1; // 不可达:UpgradeOutcome 四形态已在 switch 内穷尽
}
