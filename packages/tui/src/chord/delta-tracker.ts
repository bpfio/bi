/**
 * chord/delta-tracker —— 结构化 JSON Delta 状态追踪器。
 *
 * BI-19.7 合约：DeltaTracker<T extends object>
 * - snapshot(): readonly T —— 深冻结不可变视图，防篡改；
 * - mutate(fn): structuredClone 草稿 → fn → 与当前态深比对，自实现 diff 生成
 *   RFC 6902 JSON Patch（add/remove/replace；数组用序号指针、对象用转义指针）；
 * - history: 每次 mutate 的 patch 序列存档（时间旅行 undo 用）；
 * - apply(patches): RFC 6902 子集重放（数组 splice / 对象 set-delete）；
 * - travel(version): 按历史前缀正向重放实现任意版本时间旅行；
 * - onDelta: 订阅原始 delta 流（state-projection 层消费）。
 *
 * 零外部依赖：diff / patch / 冻结全部手写；structuredClone 为运行时内置。
 */

export type JsonPatchOp = "add" | "remove" | "replace";

export interface JsonPatch {
  op: JsonPatchOp;
  path: string;
  value?: unknown;
}

/** 深只读映射：snapshot/travel 返回的不可变视图类型。 */
export type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** JSON 值深相等（对象/数组递归，原始值 Object.is）。 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k) || !jsonEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

/** JSON Pointer token 转义：~ → ~0，/ → ~1（RFC 6901）。 */
function escapeToken(k: string): string {
  return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapeToken(t: string): string {
  return t.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * 深比对生成 RFC 6902 patch 序列。
 * 数组：逐元素递归，尾部多出按 add（升序）/ remove（降序，保证按序应用时
 * 索引不漂移）；对象：新增 add、缺失 remove、共存递归或 replace。
 */
function diffJson(a: unknown, b: unknown, path: string, out: JsonPatch[]): void {
  if (jsonEqual(a, b)) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    const min = Math.min(a.length, b.length);
    for (let i = 0; i < min; i++) {
      diffJson(a[i], b[i], `${path}/${i}`, out);
    }
    if (b.length > a.length) {
      for (let i = a.length; i < b.length; i++) {
        out.push({ op: "add", path: `${path}/${i}`, value: b[i] });
      }
    } else if (a.length > b.length) {
      for (let i = a.length - 1; i >= b.length; i--) {
        out.push({ op: "remove", path: `${path}/${i}` });
      }
    }
    return;
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    for (const k of Object.keys(b)) {
      const childPath = `${path}/${escapeToken(k)}`;
      if (!Object.prototype.hasOwnProperty.call(a, k)) {
        out.push({ op: "add", path: childPath, value: b[k] });
      } else {
        diffJson(a[k], b[k], childPath, out);
      }
    }
    for (const k of Object.keys(a)) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) {
        out.push({ op: "remove", path: `${path}/${escapeToken(k)}` });
      }
    }
    return;
  }
  out.push({ op: "replace", path, value: b });
}

/** 解析 JSON Pointer 为 token 序列（"" → 根）。 */
function pointerTokens(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error(`invalid JSON Pointer: "${path}"`);
  return path
    .split("/")
    .slice(1)
    .map((t) => unescapeToken(t));
}

/** 沿指针走一步（不含末 token）。 */
function stepPointer(cur: unknown, token: string): unknown {
  if (Array.isArray(cur)) {
    const i = Number(token);
    if (!Number.isInteger(i) || i < 0 || i >= cur.length) {
      throw new Error(`patch path index out of range: "${token}"`);
    }
    return cur[i];
  }
  if (isPlainObj(cur)) {
    if (!Object.prototype.hasOwnProperty.call(cur, token)) {
      throw new Error(`patch path key missing: "${token}"`);
    }
    return cur[token];
  }
  throw new Error("patch path descends into primitive");
}

/** RFC 6902 子集原地应用（数组 splice / 对象 set-delete，值深克隆防别名）。 */
function applyPatches(doc: unknown, patches: readonly JsonPatch[]): void {
  for (const p of patches) {
    const tokens = pointerTokens(p.path);
    if (tokens.length === 0) {
      throw new Error("root-level patch op not supported");
    }
    let parent: unknown = doc;
    for (let i = 0; i < tokens.length - 1; i++) {
      parent = stepPointer(parent, tokens[i]!);
    }
    const last = tokens[tokens.length - 1]!;
    if (Array.isArray(parent)) {
      const idx = last === "-" ? parent.length : Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
        throw new Error(`invalid array index: "${last}"`);
      }
      if (p.op === "add") {
        parent.splice(idx, 0, structuredClone(p.value));
      } else if (p.op === "remove") {
        if (idx >= parent.length) throw new Error(`remove index missing: ${idx}`);
        parent.splice(idx, 1);
      } else {
        if (idx >= parent.length) throw new Error(`replace index missing: ${idx}`);
        parent[idx] = structuredClone(p.value);
      }
    } else if (isPlainObj(parent)) {
      const rec = parent;
      if (p.op === "add") {
        rec[last] = structuredClone(p.value);
      } else if (p.op === "remove") {
        if (!Object.prototype.hasOwnProperty.call(rec, last)) {
          throw new Error(`remove key missing: "${last}"`);
        }
        delete rec[last];
      } else {
        if (!Object.prototype.hasOwnProperty.call(rec, last)) {
          throw new Error(`replace key missing: "${last}"`);
        }
        rec[last] = structuredClone(p.value);
      }
    } else {
      throw new Error(`patch path into primitive at "${p.path}"`);
    }
  }
}

/** 深冻结：snapshot 不可变视图（严格模式下写冻结对象抛 TypeError）。 */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v as object)) {
      deepFreeze((v as Record<string, unknown>)[k]);
    }
    Object.freeze(v);
  }
  return v;
}

type DeltaListener = (patches: JsonPatch[]) => void;

export class DeltaTracker<T extends object> {
  readonly #initial: T;
  #current: T;
  readonly #history: JsonPatch[][] = [];
  #version = 0;
  readonly #listeners = new Set<DeltaListener>();

  constructor(initial: T) {
    this.#initial = structuredClone(initial);
    this.#current = structuredClone(initial);
  }

  /** 当前态不可变视图：深冻结副本，外部篡改不影响追踪器。 */
  snapshot(): DeepReadonly<T> {
    return deepFreeze(structuredClone(this.#current)) as DeepReadonly<T>;
  }

  /**
   * 变更入口：克隆草稿 → fn → 深比对出 patch。无实际变化时空 patch 列表、
   * 不进历史、不发事件。fn 抛错则草稿丢弃、状态不变（错误原样上抛）。
   */
  mutate(fn: (draft: T) => void): JsonPatch[] {
    const draft = structuredClone(this.#current);
    fn(draft);
    const patches: JsonPatch[] = [];
    diffJson(this.#current, draft, "", patches);
    if (patches.length === 0) return patches;
    this.#current = draft;
    this.#history.push(patches);
    this.#version += 1;
    for (const l of [...this.#listeners]) l(patches);
    return patches;
  }

  /** 历史 patch 序列存档（只读投影；下标 i = 第 i+1 次 mutate）。 */
  get history(): readonly JsonPatch[][] {
    return this.#history;
  }

  /** 状态版本号：每次实际变更（mutate/apply）+1。 */
  get version(): number {
    return this.#version;
  }

  /** 重放外部 patch（undo/redo/时间旅行机制）；同样发 delta 事件。 */
  apply(patches: readonly JsonPatch[]): DeepReadonly<T> {
    const next = structuredClone(this.#current);
    applyPatches(next, patches);
    this.#current = next;
    this.#version += 1;
    for (const l of [...this.#listeners]) l([...patches]);
    return this.snapshot();
  }

  /** 时间旅行：按历史前缀 [0, version) 正向重放到任意版本（0 = 初态）。 */
  travel(version: number): DeepReadonly<T> {
    const target = Math.max(0, Math.min(Math.floor(version), this.#history.length));
    const doc = structuredClone(this.#initial);
    for (let i = 0; i < target; i++) {
      applyPatches(doc, this.#history[i]!);
    }
    return deepFreeze(doc) as DeepReadonly<T>;
  }

  /** 订阅原始 delta 流；返回退订函数。 */
  onDelta(fn: DeltaListener): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }
}
