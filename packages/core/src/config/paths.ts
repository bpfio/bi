/**
 * 三级 TOML 配置的物理拓扑路径解析器。
 *
 * 三级拓扑（对齐工单）：
 * 1. 全局运行配置   `~/.bi/config.toml`   —— provider / model / 权限等运行时行为；
 * 2. 终端外观偏好   `~/.bi/tui.toml`      —— 主题、键位等外观偏好（与 config.toml 同优先级层，
 *                                            在 `tui` 分区上覆盖 config.toml）；
 * 3. 工作区私有覆盖 `<cwd>/.bi/local.toml` —— additional_dir、模型覆盖等工作区私有项
 *                                            （`.bi/` 已列入仓库根 .gitignore，不入版本库）。
 *
 * 测试注入：`homeDir` 与 `workDir` 均可覆盖；未注入时分别回退 `os.homedir()` 与 `process.cwd()`。
 * 测试必须注入临时目录，严禁读写真实 `~/.bi`。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ConfigPathOptions {
  /** 覆盖用户主目录（测试注入用）。 */
  homeDir?: string;
  /** 覆盖工作目录（测试注入用）。 */
  workDir?: string;
}

export interface ConfigPaths {
  /** 生效的用户主目录。 */
  homeDir: string;
  /** 生效的工作目录。 */
  workDir: string;
  /** BI 主目录 `~/.bi`。 */
  biHome: string;
  /** 全局运行配置 `~/.bi/config.toml`。 */
  globalConfig: string;
  /** 终端外观偏好 `~/.bi/tui.toml`。 */
  tuiConfig: string;
  /** 工作区私有目录 `<cwd>/.bi`。 */
  localDir: string;
  /** 工作区私有覆盖 `<cwd>/.bi/local.toml`。 */
  localConfig: string;
}

/** 解析三级配置文件路径；homeDir / workDir 可注入覆盖（测试必须注入临时目录）。 */
export function resolveConfigPaths(options: ConfigPathOptions = {}): ConfigPaths {
  const homeDir = options.homeDir !== undefined && options.homeDir !== "" ? resolve(options.homeDir) : homedir();
  const workDir = options.workDir !== undefined && options.workDir !== "" ? resolve(options.workDir) : process.cwd();
  const biHome = join(homeDir, ".bi");
  const localDir = join(workDir, ".bi");
  return {
    homeDir,
    workDir,
    biHome,
    localDir,
    globalConfig: join(biHome, "config.toml"),
    tuiConfig: join(biHome, "tui.toml"),
    localConfig: join(localDir, "local.toml"),
  };
}
