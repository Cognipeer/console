/**
 * View model of the IAM center "Overview": counts and wording derived from the
 * answers of the center's own endpoints. Pure (no React); covered by unit tests.
 */

import type { PolicyRow } from '../api';
import type { AuditItem } from '../audit/client';

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

// ── denials that name a policy ───────────────────────────────────────────

/**
 * Where a policy's name goes in a denial's sentence. An invisible separator: it
 * never occurs in a real sentence, and the row splits the sentence on it to give
 * the name (or the id that stands in for it) its own styling.
 */
export const POLICY_SLOT = '\u2063';

type DenialLike = Pick<AuditItem, 'policyId' | 'text' | 'summary'>;

/** The text of a denial between the quotes of `by policy "..."`: the server writes the name, or the raw id of a policy that is gone. */
const POLICY_SEPARATOR = '", "';

export interface DeletedPolicy {
  policyId: string;
  /** What the policy was called when it was deleted (from the policy-change trail); null when the trail no longer says. */
  name: string | null;
}

/**
 * The policy a denial names, when that policy no longer exists. The server
 * writes the sentence with the policy's current name, or with its raw id when
 * it is gone; the center's own list of policies says which. Null for a denial
 * of another kind, for a policy that exists, and when the list of policies is
 * not known (nothing can be said about a policy then).
 */
export function deletedPolicyOf(
  item: Pick<DenialLike, 'policyId' | 'text'>,
  known: ReadonlyMap<string, string> | null,
  stored: ReadonlyMap<string, string> = new Map(),
): DeletedPolicy | null {
  if (!known || !item.policyId || item.text?.key !== 'denied.policy') return null;
  if (known.has(item.policyId)) return null;
  return { policyId: item.policyId, name: stored.get(item.policyId) ?? null };
}

/** The ids of the policies the denials name that no longer exist, each once. */
export function deletedPolicyIds(
  denials: ReadonlyArray<Pick<DenialLike, 'policyId' | 'text'>>,
  known: ReadonlyMap<string, string> | null,
): string[] {
  const ids = new Set<string>();
  for (const item of denials) {
    const gone = deletedPolicyOf(item, known);
    if (gone) ids.add(gone.policyId);
  }
  return [...ids];
}

/**
 * `policyId -> name` from the policy-change trail (newest first): a policy keeps
 * the name its create / update / delete rows recorded after the policy itself
 * is gone. The first row that carries a name wins, so the newest name is kept.
 */
export function storedPolicyNames(changes: ReadonlyArray<Pick<AuditItem, 'policyId' | 'text'>>): Map<string, string> {
  const names = new Map<string, string>();
  for (const change of changes) {
    if (!change.policyId || names.has(change.policyId)) continue;
    const name = change.text?.params.name;
    if (typeof name === 'string' && name.trim() !== '') names.set(change.policyId, name);
  }
  return names;
}

/**
 * The denial with the gone policy's place in its sentence marked (POLICY_SLOT),
 * or null when the sentence does not name it by that id (the server already
 * wrote a name there).
 */
export function withPolicySlot(item: Pick<DenialLike, 'summary' | 'text'>, policyId: string): Pick<DenialLike, 'summary' | 'text'> | null {
  const text = item.text;
  if (!text || text.key !== 'denied.policy') return null;
  const names = String(text.params.policies ?? '').split(POLICY_SEPARATOR);
  if (!names.includes(policyId)) return null;
  return {
    summary: item.summary,
    text: { key: text.key, params: { ...text.params, policies: names.map((n) => (n === policyId ? POLICY_SLOT : n)).join(POLICY_SEPARATOR) } },
  };
}

/** A sentence cut at the policy's place: what comes before and after it; null when it has no such place. */
export function splitAtPolicySlot(sentence: string): [string, string] | null {
  const parts = sentence.split(POLICY_SLOT);
  return parts.length === 2 ? [parts[0]!, parts[1]!] : null;
}
