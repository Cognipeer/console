/**
 * View model of the IAM center "Overview": counts and wording derived from the
 * answers of the center's own endpoints. Pure (no React); covered by unit tests.
 */

import type { PolicyRow } from '../api';

export interface PolicyCounts {
  total: number;
  enabled: number;
  disabled: number;
  /** Enabled policies that only allow, only deny, or both. */
  allowRules: number;
  denyRules: number;
}

export function countPolicies(custom: readonly PolicyRow[]): PolicyCounts {
  const enabledRows = custom.filter((p) => p.enabled);
  return {
    total: custom.length,
    enabled: enabledRows.length,
    disabled: custom.length - enabledRows.length,
    allowRules: enabledRows.filter((p) => p.effect === 'permit' || p.effect === 'mixed').length,
    denyRules: enabledRows.filter((p) => p.effect === 'forbid' || p.effect === 'mixed').length,
  };
}

/** `custom:<policyId>#<statement>` -> `<policyId>`; null for anything else. */
export function policyIdOfCedarId(cedarId: string): string | null {
  const match = /^custom:(.+?)(?:#\d+)?$/.exec(cedarId);
  return match ? match[1]! : null;
}

/** The distinct policies behind a list of Cedar statement ids, in first-seen order. */
export function skippedPolicies(
  cedarIds: readonly string[],
  custom: readonly Pick<PolicyRow, 'policyId' | 'name'>[],
): Array<{ policyId: string; name: string }> {
  const names = new Map(custom.map((p) => [p.policyId, p.name]));
  const seen = new Set<string>();
  const out: Array<{ policyId: string; name: string }> = [];
  for (const cedarId of cedarIds) {
    const policyId = policyIdOfCedarId(cedarId);
    if (!policyId || seen.has(policyId)) continue;
    seen.add(policyId);
    out.push({ policyId, name: names.get(policyId) ?? policyId });
  }
  return out;
}

/** A directory count read from one page: exact up to the page size, "N+" when there is more. */
export function countLabel(shown: number, more: boolean, locale?: string): string {
  const text = shown.toLocaleString(locale);
  return more ? `${text}+` : text;
}

/** 1500 -> "1.50 ms", 420 -> "420 µs"; an em dash when the figure does not exist. */
export function formatMicros(us: number | null): string {
  if (us === null) return '—';
  return us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${Math.round(us)} µs`;
}

/** 0.874 -> "87%"; an em dash when the figure does not exist. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}
