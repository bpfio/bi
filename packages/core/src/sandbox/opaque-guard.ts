/**
 * BI-06.8 — Opaque guard: pure composition layer over `scanShell`.
 *
 * `assertExecutable` turns a `ScanResult` into an allow/block verdict:
 * any `opaque` or `dangerous` statement blocks execution. `formatVerdict`
 * renders the verdict for humans. No IO, deterministic.
 */

import type { ScanResult, ShellStatement } from "./shell-scan";

export interface GuardVerdict {
  allowed: boolean;
  reasons: string[];
}

function statementLabel(statement: ShellStatement): string {
  const text = statement.text.trim();
  const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return clipped;
}

/** Block when any statement is opaque or dangerous; allow otherwise. */
export function assertExecutable(result: ScanResult): GuardVerdict {
  const reasons: string[] = [];
  for (const reason of result.reasons) {
    reasons.push(`scan:${reason}`);
  }
  for (const statement of result.statements) {
    if (statement.kind === "safe") continue;
    reasons.push(
      `${statement.kind}:${statementLabel(statement)}::${statement.reasons.join(",")}`,
    );
  }
  return { allowed: reasons.length === 0, reasons };
}

/** Human-readable one-line rendering of a verdict. */
export function formatVerdict(verdict: GuardVerdict): string {
  if (verdict.allowed) return "allow: no opaque or dangerous statements";
  return `block: ${verdict.reasons.join("; ")}`;
}
