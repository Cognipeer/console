/**
 * THE OPTION LISTS A POLICY'S `reference` FIELDS ARE DRAWN FROM.
 *
 * Not a component. It lives here rather than in the detail page because a Next
 * app-router `page.tsx` may not export anything but its default and the route
 * segment config — so a helper that stays in the page is a helper no test can
 * reach, and these two are the ones worth reaching.
 *
 * ── THE PROBLEM THEY SOLVE ──────────────────────────────────────────────────
 * Every per-family editor used to fetch its own picker: the PII section loaded
 * `/api/pii/policies`, the word-filter section `/api/guardrails/word-lists`.
 * The generic renderer cannot — it knows a field points at a `pii_policy`, not
 * what one is — so the page loads all four resources and hands them down.
 *
 * And a picker is not just a list of what EXISTS. A policy can point at a key
 * that has since been deleted, or that belongs to another project: the value is
 * still stored and still being evaluated, but it is not in the fetched list.
 * `PolicyFieldRenderer`'s `reference` control renders a value it cannot find as
 * an EMPTY select, which reads as "nothing configured" — and the fix an
 * operator then reaches for silently rewrites a setting they were never shown.
 * `withReferencedKeys` puts the orphan back, marked, exactly as the old
 * per-family editors did.
 */

import type { GuardrailPolicy } from '@/lib/services/guardrail/hooks/contract';
import { fieldsOf } from '@/lib/services/guardrail/catalog';
import type { PolicyFieldOption, PolicyFieldResource } from '@/lib/services/guardrail/catalog';
import type { PolicyFieldResources } from './PolicyFieldRenderer';

/**
 * Every tenant resource these policies POINT AT, harvested through the field
 * schema rather than by naming fields.
 *
 * Schema-driven on purpose: `fieldsOf` answers "which of this family's fields
 * point at a tenant resource, and which resource", so a tenth family's
 * references are preserved the day it has a catalog entry, with no edit here.
 * A family this build does not know contributes nothing rather than throwing —
 * `fieldsOf` returns an empty list for it.
 */
export function referencedResourceKeys(
  policies: readonly GuardrailPolicy[],
): Map<PolicyFieldResource, Set<string>> {
  const out = new Map<PolicyFieldResource, Set<string>>();
  for (const policy of policies) {
    const config = policy as unknown as Record<string, unknown>;
    for (const field of fieldsOf(policy.family)) {
      if (field.kind !== 'reference') continue;
      // `multiple` fields hold `string[]` (`word_filter.customListKeys`), the
      // rest a bare string. Read structurally rather than from the flag, so a
      // row written before the flag existed is still recovered.
      const raw = config[field.key];
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value !== 'string' || value.trim() === '') continue;
        const bucket = out.get(field.resource) ?? new Set<string>();
        bucket.add(value);
        out.set(field.resource, bucket);
      }
    }
  }
  return out;
}

/**
 * The fetched option lists, plus any key a policy already points at that the
 * tenant no longer offers.
 *
 * Non-mutating, and returns the SAME object when nothing needs adding — this
 * runs in a `useMemo` whose result is a prop on two components.
 *
 * A missing resource stays MISSING rather than becoming a list of orphans:
 * "this fetch failed / you have none yet" and "here are your word lists" are
 * different states, and the renderer's `emptyHint` is how the first one is
 * said. An orphan is only ever appended to a list that loaded.
 */
export function withReferencedKeys(
  resources: PolicyFieldResources,
  policies: readonly GuardrailPolicy[],
): PolicyFieldResources {
  const referenced = referencedResourceKeys(policies);
  if (referenced.size === 0) return resources;

  let merged: PolicyFieldResources | null = null;
  for (const [resource, keys] of referenced) {
    const known = resources[resource];
    if (known === undefined) continue;
    const missing: PolicyFieldOption[] = [...keys]
      .filter((key) => !known.some((option) => String(option.value) === key))
      .map((key) => ({ value: key, label: `${key} (not found)` }));
    if (missing.length === 0) continue;
    merged = merged ?? { ...resources };
    merged[resource] = [...known, ...missing];
  }
  return merged ?? resources;
}
