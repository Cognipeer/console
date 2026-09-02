/**
 * Review finding #15 — the legacy lift DOUBLE-SCANNED credentials.
 *
 * With `pii.categories.apiKey` on, the lifted `pii` policy mapped `apiKey` onto
 * the PII service's `apiKey` category AND a `legacy:secrets` policy was
 * enabled. One key yielded two `high` findings (risk 70 instead of 35, alert
 * thresholds drifting, the evaluation log double-counting).
 *
 * The credential scan belongs to the `secrets` family: it IS the legacy
 * `apiKey` detector (KNOWN_SECRET_PATTERNS plus the entropy heuristic, moved
 * out of `runPiiDetection`), where the PII service's `apiKey` category is a
 * bare `\b[A-Za-z0-9_-]{32,}\b` with no entropy gate. So when the secrets
 * policy is emitted, `apiKey` is dropped from the PII side of the lift.
 */

import { describe, expect, it, vi } from 'vitest';

import type { IGuardrail } from '@/lib/database/provider/types.domain';

// The lift itself touches no database; the barrel is imported for the
// provisioning path this test never reaches.
vi.mock('@/lib/database', () => ({
  runWithTenantScope: vi.fn(),
}));

import { liftLegacyPolicies } from '@/lib/services/guardrail/hooks/legacy';

function legacyRecord(categories: Record<string, boolean>): IGuardrail {
  return {
    _id: 'g1',
    tenantId: 'tenant-a',
    key: 'corp-pii',
    name: 'Corporate PII',
    type: 'preset',
    action: 'block',
    failMode: 'closed',
    mode: 'enforce',
    enabled: true,
    target: 'input',
    policy: {
      pii: { enabled: true, action: 'block', categories },
    },
  } as unknown as IGuardrail;
}

describe('legacy lift: one credential scanner, not two', () => {
  it('with apiKey ON, the secrets policy is enabled and apiKey leaves the PII side', () => {
    const policies = liftLegacyPolicies(legacyRecord({ email: true, apiKey: true, tckn: true }), 'pii-key');

    const pii = policies.find((p) => p.id === 'legacy:pii');
    const secrets = policies.find((p) => p.id === 'legacy:secrets');
    expect(pii?.family).toBe('pii');
    expect(secrets?.family).toBe('secrets');
    expect(secrets?.enabled).toBe(true);

    // The other categories still map (including the renamed one); apiKey does not.
    expect(pii && 'legacyCategories' in pii ? pii.legacyCategories : undefined).toEqual({
      email: true,
      tc_kimlik: true,
    });
  });

  it('with apiKey OFF, nothing scans credentials on either side', () => {
    const policies = liftLegacyPolicies(legacyRecord({ email: true, apiKey: false }), 'pii-key');

    const pii = policies.find((p) => p.id === 'legacy:pii');
    const secrets = policies.find((p) => p.id === 'legacy:secrets');
    expect(secrets?.enabled).toBe(false);
    expect(pii && 'legacyCategories' in pii ? pii.legacyCategories : undefined).toEqual({ email: true });
  });

  it('keeps the policy order the evaluation log and user message depend on', () => {
    const policies = liftLegacyPolicies(legacyRecord({ apiKey: true }), 'pii-key');
    expect(policies.map((p) => p.id)).toEqual(['legacy:pii', 'legacy:secrets']);
  });
});
