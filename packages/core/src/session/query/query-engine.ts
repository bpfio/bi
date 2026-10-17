/**
 * BI-03.7 会话语料检索引擎（差异工单）—— Step-0 骨架落盘
 *
 * query/ 子目录为本卡专属：
 *  - filter-compiler.ts：最小过滤语法（type=/tool=/contains:/after:，and/or 组合）→ 谓词。
 *  - sqlite-corpus.ts：bun:sqlite WAL 语料库（entries 表），流式 ingest + keyset 分页。
 *  - query-engine.ts：组合 compileFilter + corpus，rebuildIndex 全量幂等重建。
 */

/** 语料条目（entries 表投影） */
export interface CorpusEntry {
  id: number;
  sessionId: string;
  type: string;
  tool: string | null;
  text: string;
  ts: string;
}

export type FilterPredicate = (entry: CorpusEntry) => boolean;

export interface FilterSyntaxErrorShape {
  code: 'empty-expr' | 'dangling-operator' | 'unknown-atom' | 'bad-atom';
  message: string;
  position?: number;
}

export class FilterSyntaxError extends Error {
  readonly code: FilterSyntaxErrorShape['code'];
  readonly position?: number;
  constructor(shape: FilterSyntaxErrorShape) {
    super(shape.message);
    this.name = 'FilterSyntaxError';
    this.code = shape.code;
    this.position = shape.position;
  }
}

export interface SearchOpts {
  cursor?: number;
  pageSize?: number;
}

export interface SearchResult {
  items: CorpusEntry[];
  nextCursor: number | null;
}

export class SessionQueryEngine {
  constructor(_opts: { dbPath: string }) {}
  search(_expr: string, _opts?: SearchOpts): SearchResult {
    throw new Error('BI-03.7: not implemented (Step-0 skeleton)');
  }
  rebuildIndex(_jsonlDir: string): { sessions: number; entries: number } {
    throw new Error('BI-03.7: not implemented (Step-0 skeleton)');
  }
}
