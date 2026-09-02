/**
 * Regression — an authored `hooks` config whose policies omit `schedule`.
 *
 * `GuardrailPolicyBase.schedule` is typed as required and every policy the legacy
 * lift produces carries one, so nothing in the fleet exercised the gap. But the
 * write path never enforced it: a hand-authored config posted to
 * `POST /guardrails` without a per-policy `schedule` persisted happily, and the
 * engine then read `.timing` off `undefined` and threw. That surfaced as a 500
 * on EVERY evaluation of that guardrail — and a caller treating 5xx as
 * retryable fails closed after its retry, so the observable symptom was "every
 * tool call is blocked" with "transport error" as the stated reason.
 *
 * The fix is inheritance rather than a guard: a policy's schedule OVERRIDES the
 * hook binding's, exactly as `action` overrides the record's, so a policy that
 * declares none inherits. These tests pin both halves — no throw, and the
 * inherited timing actually drives short-circuit behaviour.
 */

import { describe, it, expect } from 'vitest';
import { policyTiming } from '@/lib/services/guardrail/hooks/engine';
import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailPolicy } from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailHooksConfig } from '@/lib/database/provider/types.domain';

/** The shape the SDK team actually posted: bindings carry a schedule, policies do not. */
function authoredHooksWithoutPolicySchedule(): GuardrailHooksConfig {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    bindings: {
      'tool.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
    },
    policies: [
      {
        id: 'secrets:tool-args',
        family: 'secrets',
        enabled: true,
        hooks: ['tool.pre'],
        action: 'block',
        known: true,
        genericHighEntropy: true,
        // schedule deliberately ABSENT — this is the regression.
      },
    ],
    stream: { enabled: false },
  } as unknown as GuardrailHooksConfig;
}

describe('a policy without its own schedule', () => {
  it('is representable — the persisted JSON simply has no `schedule` key', () => {
    const hooks = authoredHooksWithoutPolicySchedule();
    const policy = hooks.policies[0] as { schedule?: unknown };

    // If this ever fails, the fixture stopped reproducing the bug: a policy that
    // HAS a schedule cannot exercise the fallback, and the test would pass for
    // the wrong reason.
    expect(policy.schedule).toBeUndefined();
  });

  it('round-trips through JSON without gaining one', () => {
    // The record reaches the engine via a JSON column on both backends, so the
    // absence has to survive serialisation — a default applied by a mapper
    // would hide the gap in tests while production still hit it.
    const parsed = JSON.parse(JSON.stringify(authoredHooksWithoutPolicySchedule()));
    expect(parsed.policies[0].schedule).toBeUndefined();
    expect(parsed.bindings['tool.pre'].schedule.timing).toBe('sync');
  });

  it('inherits the hook binding\'s timing', () => {
    const hooks = authoredHooksWithoutPolicySchedule();
    const policy = hooks.policies[0];
    const binding = hooks.bindings!['tool.pre'];

    // Before the fix this read `.timing` off undefined and threw, which the
    // API surfaced as a 500 on every evaluation of the guardrail.
    expect(() => policyTiming(policy, binding)).not.toThrow();
    expect(policyTiming(policy, binding)).toBe('sync');
  });

  it('falls back to sync when the binding has no schedule either', () => {
    const policy = authoredHooksWithoutPolicySchedule().policies[0];

    // `sync` rather than `async` on purpose: an unschedulable policy that
    // silently became async would stop blocking, so the safe default is the
    // one that still enforces.
    expect(policyTiming(policy, undefined)).toBe('sync');
  });

  it('lets an explicit policy schedule OVERRIDE the binding', () => {
    const hooks = authoredHooksWithoutPolicySchedule();
    const binding = hooks.bindings!['tool.pre'];
    const policy = {
      ...hooks.policies[0],
      schedule: { timing: 'async', onFail: 'log' },
    } as unknown as GuardrailPolicy;

    // The whole point of the fallback is that the policy's schedule is an
    // OVERRIDE, not a duplicate of the binding's — inheritance must not
    // outrank an explicit value.
    expect(policyTiming(policy, binding)).toBe('async');
  });
});
