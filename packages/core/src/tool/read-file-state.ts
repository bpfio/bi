/**
 * BI-07.2 · Read-Before-Write 门禁与 mtime 防脏写看门狗。
 *
 * 职责（工单钉死）：维护 `ReadFileStateMap`——未读过的文件严禁编辑修改；
 * 写前校验磁盘真实 stat，一旦与读取时不符（外部并发篡改）立即阻断并强制
 * 重新读取。
 *
 * 三态判定（assertCleanForWrite）：
 *  1) not-read           —— 该路径从未 recordRead：拒绝（Read-Before-Write 铁律）；
 *  2) externally-modified —— 磁盘 mtimeMs 或 size 任一字段与读取基线不符：
 *                           拒绝（外部篡改，必须重读刷新认知后再写）；
 *  3) allowed            —— 两字段全等：放行。
 *
 * 基线维护：
 * - recordRead(path, stat)   —— 记录/刷新读取基线（最新一次读取生效，last-write-wins）；
 * - noteEdited(path, newStat)—— 自己的编辑落盘后刷新基线（写者自知内容，等同重新认知；
 *                              对从未 recordRead 的路径同样建立基线——编辑本身
 *                              意味着写者已掌握该文件状态）；
 * - snapshot()/restoreForTests() —— 全量状态导出/导入（测试隔离与跨段断言）。
 *
 * 纯内存状态机：所有 stat 一律由调用方注入（磁盘探测在调用侧），本模块零 IO、
 * 零时钟依赖，判定完全可测。路径键统一经 path.resolve 归一化——同一物理文件的
 * 相对/绝对两种写法落在同一条目上。mtimeMs/size 采用严格相等比较：注入什么
 * 判定什么，不做浮点容差（容差属调用方 stat 函数的职责边界）。
 */
import { resolve } from "node:path";

/** 注入的文件 stat 快照（判定所需的最小字段集）。 */
export interface FileStat {
  /** 最后修改时间（毫秒）。 */
  readonly mtimeMs: number;
  /** 文件字节大小。 */
  readonly size: number;
}

/** 拒绝原因。 */
export type DenyReason = "not-read" | "externally-modified";

/** 写前校验裁决：allowed=false 时给出结构化 reason。 */
export type CleanForWriteResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenyReason };

/** snapshot() 的导出形态：路径键 → 读取基线。 */
export type ReadFileStateSnapshot = ReadonlyMap<string, FileStat>;

export class ReadFileStateMap {
  readonly #baselines = new Map<string, FileStat>();

  /** 记录/刷新一次读取基线（同路径重复读取以最新为准）。 */
  recordRead(path: string, stat: FileStat): void {
    this.#baselines.set(resolve(path), { ...stat });
  }

  /**
   * 写前三态门禁：
   * - 未读过 → { allowed: false, reason: "not-read" }；
   * - 磁盘 stat 与读取基线任一字段不符 → { allowed: false, reason: "externally-modified" }；
   * - 全等 → { allowed: true }。
   */
  assertCleanForWrite(path: string, currentStat: FileStat): CleanForWriteResult {
    const key = resolve(path);
    const baseline = this.#baselines.get(key);
    if (baseline === undefined) {
      return { allowed: false, reason: "not-read" };
    }
    if (baseline.mtimeMs !== currentStat.mtimeMs || baseline.size !== currentStat.size) {
      return { allowed: false, reason: "externally-modified" };
    }
    return { allowed: true };
  }

  /**
   * 自己的编辑落盘后刷新基线（noteEdited）：编辑者自知最新内容，
   * 后续写前校验以编辑后的 stat 为新基线。对未 recordRead 过的路径
   * 同样建立基线（编辑本身即证明写者已掌握文件状态）。
   */
  noteEdited(path: string, newStat: FileStat): void {
    this.#baselines.set(resolve(path), { ...newStat });
  }

  /** 该路径是否已有读取基线。 */
  isKnown(path: string): boolean {
    return this.#baselines.has(resolve(path));
  }

  /** 读取某路径的当前基线（无则 undefined；只读，不共享内部对象）。 */
  baselineOf(path: string): FileStat | undefined {
    const baseline = this.#baselines.get(resolve(path));
    return baseline === undefined ? undefined : { ...baseline };
  }

  /** 全量导出（深拷贝，外部改动不回流内部状态）。 */
  snapshot(): ReadFileStateSnapshot {
    return new Map(
      [...this.#baselines].map(([key, stat]) => [key, { ...stat }] as const),
    );
  }

  /** 用 snapshot() 的导出整体替换内部状态（仅供测试隔离使用）。 */
  restoreForTests(snapshot: ReadFileStateSnapshot): void {
    this.#baselines.clear();
    for (const [key, stat] of snapshot) {
      this.#baselines.set(key, { ...stat });
    }
  }

  /** 清空全部基线（测试隔离用）。 */
  clear(): void {
    this.#baselines.clear();
  }
}
