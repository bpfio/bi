/**
 * BI-05.2 —— `bi init` 子命令入口（无头模式）。
 *
 * 组合 detectStack + draftBiMd；交互确认归 TUI，本入口只做无头语义：
 *  - 缺省仅打印草稿到输出通道，不落盘（requiresReview 语义）；
 *  - 追加 --yes 才写 BI.md；
 *  - 目标 BI.md 已存在时拒绝覆盖（返回码 1，永不 clobber）；
 *  - 用法错误返回码 2，正常 0。
 * 未注册进 src/index.ts（租约限制），由 CLI 装配方后续接线。
 */
import { basename, join, resolve } from "node:path";
import { DEFAULT_FS, type FsLike } from "../../rules";
import { detectStack, draftBiMd, writeBiMd } from "../../rules/init-service";

export interface RunInitOptions {
  fs?: FsLike;
  /** 相对 --dir 与缺省目录的解析基准（缺省 process.cwd()）。 */
  cwd?: string;
  /** 输出通道（缺省 console.log；测试注入收集器）。 */
  log?: (line: string) => void;
}

/** 解析 `bi init` 参数并执行；返回进程退出码。 */
export function runInit(args: readonly string[], opts?: RunInitOptions): number {
  const log = opts?.log ?? ((line: string) => console.log(line));
  const base = opts?.cwd ?? process.cwd();
  let dir = base;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--dir") {
      const next = args[i + 1];
      if (next === undefined) {
        log("bi init：--dir 需要一个目录参数");
        return 2;
      }
      dir = resolve(base, next);
      i += 1;
      continue;
    }
    log(`bi init：未知参数 ${arg}（支持 --dir <目录> 与 --yes）`);
    return 2;
  }

  const fs = opts?.fs ?? DEFAULT_FS;
  const target = join(dir, "BI.md");
  if (fs.existsSync(target)) {
    log(`bi init：${target} 已存在，拒绝覆盖；如需重建请先手动移除。`);
    return 1;
  }

  const profile = detectStack(dir, fs);
  const { draft, requiresReview } = draftBiMd(profile, { projectName: basename(dir) });
  if (!yes) {
    log(draft);
    log("");
    log("bi init：以上为待审查草稿，确认无误后追加 --yes 落盘。");
    return 0;
  }
  void requiresReview; // 类型恒为 true，审查语义由 --yes 显式承载
  writeBiMd(target, draft, { fs });
  log(`bi init：草稿经 --yes 确认，已写入 ${target}`);
  return 0;
}
