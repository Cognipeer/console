/**
 * The part of an alert rule that decides what its per-entity states MEAN.
 * Editing any of it makes stored states meaningless (they describe another
 * condition, window, target or scope), so they are retired; the evaluator also
 * compares shapes to notice that a rule was edited under a running sweep.
 */

import type { IAlertRule } from '@/lib/database';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with sorted keys and no undefined members, so equal shapes compare equal. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Scope with empty members dropped: a stored legacy `{}` equals its normalised form. */
function scopeShape(scope: IAlertRule['scope']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(scope ?? {})) {
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/**
 * Defaults are filled in first, so a stored legacy condition equals its
 * normalised form.
 */
export function evaluationShapeOf(
  rule: Pick<IAlertRule, 'metric' | 'module' | 'entity' | 'condition' | 'windowMinutes'> & { scope?: IAlertRule['scope'] },
): string {
  return stableStringify([
    rule.metric,
    rule.module,
    rule.entity ?? null,
    { ...rule.condition, mode: rule.condition?.mode ?? 'threshold', forMinutes: rule.condition?.forMinutes ?? 0 },
    rule.windowMinutes,
    scopeShape(rule.scope),
  ]);
}
