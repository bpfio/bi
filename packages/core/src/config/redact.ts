/**
 * 结构化密钥脱敏（对齐工单 BI-01.1 第 5 点）。
 *
 * 核心机制：凭据值以 `SecretValue` 标记（`role === "secret"`）进入运行时对象；
 * 该标记值在所有隐式字符串化出口上（模板字符串 / JSON 序列化 / console 检查器）
 * 自动呈现为遮蔽形态（如 `ze-***last4`），不可逆——原始值只能通过显式 `reveal()` 取得。
 * 因此跨进程 / TUI / A2A 传输（JSON 边界）时密钥不会泄漏，也不会进入日志。
 *
 * `redactSecrets` 是传输边界的通用兜底：深遍历任意 JSON 可达结构，
 * 将 SecretValue 实例与命中敏感键名的明文字符串一并遮蔽，返回全新对象（不修改原对象）。
 */

const SECRET_STORE = new WeakMap<SecretValue, string>();

/** Node/Bun 控制台检查器协议键（避免 class 计算属性对 unique symbol 的要求）。 */
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

/** 敏感标记角色的规范取值。 */
export const SECRET_ROLE = "secret";

/** 遮蔽占位（短密钥整体遮蔽，避免 last4 泄漏短凭据）。 */
export const SECRET_MASK = "***";

/** 视为敏感凭据的键名（防御纵深：Schema 不落明文，但传输对象里若出现这些键名也兜底遮蔽）。 */
export const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  "api_key",
  "apikey",
  "api-key",
  "api_key_env_value",
  "password",
  "passwd",
  "secret",
  "client_secret",
  "token",
  "access_token",
  "refresh_token",
  "private_key",
]);

/**
 * 遮蔽单个凭据字符串：保留协议前缀与最后 4 位，中间不可逆地替换为 `***`。
 * 例：`ze-1234567890abcd` → `ze-***abcd`；长度 < 8 的凭据整体遮蔽为 `***`。
 */
export function redactSecret(raw: string): string {
  if (raw.length < 8) return SECRET_MASK;
  const last4 = raw.slice(-4);
  const prefix = /^([A-Za-z][A-Za-z0-9]{0,11})[-_]/.exec(raw)?.[1];
  return prefix !== undefined ? `${prefix}-***${last4}` : `${SECRET_MASK}${last4}`;
}

/** role('secret') 标记凭据。所有隐式字符串化出口自动遮蔽。 */
export class SecretValue {
  readonly role = SECRET_ROLE;

  constructor(raw: string) {
    SECRET_STORE.set(this, raw);
  }

  /** 显式取回原始凭据值（唯一可逆出口；仅限实际调用上游 API 时使用）。 */
  reveal(): string {
    return SECRET_STORE.get(this) ?? "";
  }

  /** 模板字符串 / String() 出口：自动遮蔽。 */
  toString(): string {
    return redactSecret(this.reveal());
  }

  /** JSON 序列化出口（跨进程 / TUI / A2A 传输边界）：自动遮蔽，不可逆。 */
  toJSON(): string {
    return redactSecret(this.reveal());
  }
}

// console.log / util.inspect 出口：自动遮蔽。
Object.defineProperty(SecretValue.prototype, INSPECT_CUSTOM, {
  enumerable: false,
  configurable: true,
  value(this: SecretValue): string {
    return `SecretValue(${redactSecret(this.reveal())})`;
  },
});

/** 判断值是否为 role('secret') 标记凭据。 */
export function isSecret(value: unknown): value is SecretValue {
  return value instanceof SecretValue;
}

/** 键名是否命中敏感凭据名（防御纵深兜底用）。 */
export function isSecretKey(name: string): boolean {
  return SECRET_KEY_NAMES.has(name);
}

export interface RedactOptions {
  /** 是否同时按 SECRET_KEY_NAMES 遮蔽明文字符串（默认 true）。 */
  byKeyNames?: boolean;
}

/**
 * 深遍历任意 JSON 可达结构，遮蔽其中所有凭据：
 * - SecretValue 实例 → 遮蔽字符串（role('secret') 标记值自动生效）；
 * - 命中 SECRET_KEY_NAMES 的键上的明文字符串 → 遮蔽（防御纵深，默认开启）。
 * 返回全新对象，不修改入参；Date / RegExp 等非 JSON 结构原样透传。
 */
export function redactSecrets<T>(value: T, options?: RedactOptions): T {
  const byKeyNames = options?.byKeyNames !== false;
  return redactWalk(value, byKeyNames) as T;
}

function redactWalk(value: unknown, byKeyNames: boolean): unknown {
  if (isSecret(value)) return redactSecret(value.reveal());
  if (Array.isArray(value)) {
    return value.map((element) => redactWalk(element, byKeyNames));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = value[key];
      if (byKeyNames && isSecretKey(key) && typeof child === "string") {
        out[key] = redactSecret(child);
      } else {
        out[key] = redactWalk(child, byKeyNames);
      }
    }
    return out;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
