/**
 * BI-07.9 · 模型可见 `Skill({ skill, input })` 工具处理器。
 *
 * 执行语义（声明式技能，工单钉死）：
 * - **执行 = 展开 SKILL.md 正文为 prompt 注入返回**：`{{param}}` 占位被
 *   已验证参数替换（未知占位原样保留），prompt 交回调用方注入上下文；
 * - unknown 技能 → 结构化拒绝并附相似候选（registry.similar）；
 * - 参数 mini 校验（房规手写：type/required/未知键），拒绝不走异常控制流；
 * - **allowed-tools 仅声明透传**：脚本执行资格由后续装配层经 BI-06.5
 *   权限门执行（本卡不做脚本执行——见 skill-executor.ts 头注释）。
 */
import type { JsonValue } from "../session/types";
import type { SkillParamSpec, SkillRegistry } from "./skill-executor";

export interface SkillToolSpec {
  readonly name: "Skill";
  readonly description: string;
  readonly inputSchema: unknown;
}

export const SKILL_TOOL_SPEC: SkillToolSpec = {
  name: "Skill",
  description:
    "调用一个声明式技能：查注册表、校验参数、展开 SKILL.md 正文为注入 prompt 返回。" +
    "技能内声明 allowed-tools 的脚本动作由执行环境按权限门放行。",
  inputSchema: {
    type: "object",
    properties: {
      skill: { type: "string", description: "技能名（注册表内的 name）" },
      input: {
        type: "object",
        description: "技能参数对象（按该技能 frontmatter params 块校验）",
      },
    },
    required: ["skill"],
  },
};

export type SkillToolResult =
  | {
      readonly ok: true;
      readonly skill: string;
      /** 展开后的注入 prompt（确定性：同输入逐字节同输出）。 */
      readonly prompt: string;
      /** allowed-tools 声明透传（装配层据此接 BI-06.5 权限门执行脚本）。 */
      readonly allowedTools: readonly string[];
      /** 校验通过的参数副本。 */
      readonly params: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly ok: false;
      readonly code: "invalid-input" | "unknown-skill" | "schema-violation";
      readonly message: string;
      /** unknown-skill 时的相似候选。 */
      readonly candidates?: readonly string[];
      /** schema-violation 时的违规明细。 */
      readonly violations?: readonly string[];
    };

export interface SkillToolDeps {
  readonly registry: SkillRegistry;
}

/**
 * 参数 mini 校验（房规）：先查 required/类型（按 schema 声明序），
 * 再查未知键（按输入序）；返回违规明细（空数组 = 通过）。
 */
export function validateSkillParams(
  schema: Readonly<Record<string, SkillParamSpec>>,
  input: Readonly<Record<string, JsonValue>>,
): string[] {
  const violations: string[] = [];
  for (const [key, spec] of Object.entries(schema)) {
    const value = input[key];
    if (value === undefined) {
      if (spec.required) violations.push(`缺少必填参数: ${key}`);
      continue;
    }
    if (spec.type === "number" && typeof value !== "number") {
      violations.push(`参数 ${key} 类型应为 number，实为 ${typeof value}`);
    } else if (spec.type === "string" && typeof value !== "string") {
      violations.push(`参数 ${key} 类型应为 string，实为 ${typeof value}`);
    } else if (spec.type === "boolean" && typeof value !== "boolean") {
      violations.push(`参数 ${key} 类型应为 boolean，实为 ${typeof value}`);
    }
  }
  for (const key of Object.keys(input)) {
    if (schema[key] === undefined) violations.push(`未知参数: ${key}`);
  }
  return violations;
}

/** 正文模板展开：{{param}} → String(value)；未提供的占位原样保留。 */
export function expandSkillBody(
  body: string,
  params: Readonly<Record<string, JsonValue>>,
): string {
  return body.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match: string, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

function plainArgs(args: unknown): Record<string, unknown> | undefined {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : undefined;
}

export class SkillTool {
  readonly spec = SKILL_TOOL_SPEC;
  readonly #registry: SkillRegistry;

  constructor(deps: SkillToolDeps) {
    this.#registry = deps.registry;
  }

  /** 工具入口。结构化结果，绝不 throw。 */
  async run(args: unknown): Promise<SkillToolResult> {
    const input = plainArgs(args);
    if (input === undefined || typeof input.skill !== "string" || input.skill.length === 0) {
      return { ok: false, code: "invalid-input", message: "Skill 需要 skill（非空字符串）" };
    }
    const skillName: string = input.skill;

    let params: Record<string, JsonValue> = {};
    if (input.input !== undefined) {
      const raw: unknown = input.input;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ok: false, code: "invalid-input", message: "input 必须是参数对象" };
      }
      params = raw as Record<string, JsonValue>;
    }

    const meta = this.#registry.get(skillName);
    if (meta === undefined) {
      return {
        ok: false,
        code: "unknown-skill",
        message: `未知技能: ${skillName}`,
        candidates: this.#registry.similar(skillName),
      };
    }

    const violations = validateSkillParams(meta.paramsSchema, params);
    if (violations.length > 0) {
      return {
        ok: false,
        code: "schema-violation",
        message: `参数校验失败: ${violations.join("；")}`,
        violations,
      };
    }

    return {
      ok: true,
      skill: meta.name,
      prompt: expandSkillBody(meta.body, params),
      allowedTools: meta.allowedTools,
      params: { ...params },
    };
  }
}
