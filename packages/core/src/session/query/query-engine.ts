/**
 * 会话语料检索引擎（BI-03.7，差异工单）：`SessionQueryEngine`。
 *
 * 组合：compileFilter（query/filter-compiler.ts，最小过滤语法 → 谓词）+
 * SqliteCorpus（query/sqlite-corpus.ts，bun:sqlite WAL 语料 + keyset 分页）。
 *
 * search(expr, opts)：编译表达式为谓词后走语料分页检索；
 * 表达式非法 → FilterSyntaxError 透传（绝不静默放行为全匹配）。
 *
 * rebuildIndex(jsonlDir)：全量重建，幂等——清表重灌（clear + 逐文件 ingest）；
 * 每个合法 .jsonl 计一个会话；目录不存在返回 {0,0}（与 SessionManager.listSessions
 * 的 ENOENT 容错语义一致）。
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { compileFilter } from "./filter-compiler";
import type { FilterPredicate } from "./filter-compiler";
import { SqliteCorpus } from "./sqlite-corpus";
import type { CorpusEntry, SearchOpts, SearchResult } from "./sqlite-corpus";

export type { CorpusEntry, FilterPredicate, SearchOpts, SearchResult };
export { FilterSyntaxError, compileFilter } from "./filter-compiler";
export { SqliteCorpus } from "./sqlite-corpus";
export type { IngestProgress, IngestResult } from "./sqlite-corpus";

export interface SessionQueryEngineOptions {
  /** SQLite 数据库文件路径（目录须已存在）。 */
  dbPath: string;
}

export interface RebuildReport {
  /** 处理的会话文件数（.jsonl）。 */
  sessions: number;
  /** 灌入的条目数。 */
  entries: number;
}

export class SessionQueryEngine {
  readonly #corpus: SqliteCorpus;

  constructor(options: SessionQueryEngineOptions) {
    this.#corpus = new SqliteCorpus({ dbPath: options.dbPath });
  }

  /** 底层语料库（测试与运维用）。 */
  get corpus(): SqliteCorpus {
    return this.#corpus;
  }

  /** 编译过滤表达式并在语料上执行 keyset 分页检索。 */
  search(expr: string, opts?: SearchOpts): SearchResult {
    const predicate: FilterPredicate = compileFilter(expr);
    return this.#corpus.search(predicate, opts);
  }

  /** 全量重建索引（幂等）：清表后重灌目录下全部 .jsonl 会话文件。 */
  async rebuildIndex(jsonlDir: string): Promise<RebuildReport> {
    let names: string[];
    try {
      names = await readdir(jsonlDir);
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#corpus.clear();
        return { sessions: 0, entries: 0 };
      }
      throw error;
    }
    this.#corpus.clear();
    let sessions = 0;
    let entries = 0;
    for (const name of names.filter((file) => file.endsWith(".jsonl")).sort()) {
      const result = await this.#corpus.ingest(join(jsonlDir, name));
      sessions += 1;
      entries += result.inserted;
    }
    return { sessions, entries };
  }

  /** 关闭底层语料库句柄。 */
  close(): void {
    this.#corpus.close();
  }
}
