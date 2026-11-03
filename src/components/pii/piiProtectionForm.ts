/**
 * The "PII protection" setting of a model or an agent, as the screens hold it: just the key of a PII policy of the
 * project (what to look for lives on the policy), or nothing for off. The pure rules here are shared by the field and
 * its tests.
 */

export interface PiiPolicyOption {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  engine?: string;
}

export interface PiiPolicyOptions {
  policies: PiiPolicyOption[];
  loading: boolean;
  failed: boolean;
}

export const NO_PII_POLICIES: PiiPolicyOptions = { policies: [], loading: false, failed: false };

/**
 * What a chosen key amounts to against the loaded policies:
 *  - 'off'       nothing chosen;
 *  - 'pending'   chosen, but the list is still loading or did not load (nothing to judge it by);
 *  - 'missing'   the key is not a policy of this project (deleted, or a value set through the API): calls FAIL;
 *  - 'disabled'  the policy is switched off: calls go out UNPROTECTED;
 *  - 'ok'.
 */
export type PiiPolicyState = 'off' | 'pending' | 'missing' | 'disabled' | 'ok';

export function piiPolicyState(key: string | null | undefined, options: PiiPolicyOptions): PiiPolicyState {
  if (!key) return 'off';
  if (options.loading || options.failed) return 'pending';
  const policy = options.policies.find((candidate) => candidate.key === key);
  if (!policy) return 'missing';
  return policy.enabled ? 'ok' : 'disabled';
}

/** The `piiProtection` value an API body carries: `null` turns protection off. */
export function piiProtectionPayload(key: string | null | undefined): { policyKey: string } | null {
  const trimmed = key?.trim();
  return trimmed ? { policyKey: trimmed } : null;
}

/** The stored value (`{ policyKey }`, null or absent) as the key the field edits. */
export function piiPolicyKeyOf(stored: unknown): string | null {
  if (!stored || typeof stored !== 'object') return null;
  const key = (stored as { policyKey?: unknown }).policyKey;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}
