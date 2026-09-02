/**
 * The editor half of the multi-guardrail binding.
 *
 * WHAT THIS PINS, and why it is worth a test file of its own: an
 * `IGuardrailBinding` may OMIT `hooks`, and that omission is load-bearing —
 * it means "wherever this guardrail declares it runs", so a later edit to the
 * guardrail's own policies reaches every consumer bound that way. `[]` means the
 * opposite ("attached but parked, runs nowhere").
 *
 * Both edit screens used to flatten the first into the second on load
 * (`hooks: row.hooks ?? []`) and then POST the flattened rows back. Opening a
 * model or an agent and saving ANY unrelated field therefore disarmed such a
 * binding silently, with its row still rendered as attached — the exact
 * "green UI, nothing enforced" failure the hook plane exists to prevent. The
 * mapping now lives once, in the shared control, and is asserted here.
 */

import { describe, expect, it } from 'vitest';
import {
  bindingRowsFromStored,
  declaredHooks,
  effectiveHooks,
  type GuardrailBindingOption,
} from '@/components/guardrails/GuardrailBindingList';
import type {
  GuardrailHooksConfig,
  HookId,
} from '@/lib/services/guardrail/hooks/contract';

/**
 * A hooks config declaring exactly `bound` and carrying one enabled policy over
 * `checked`. Split so the "both halves required" rule below can supply a
 * binding with no policy and a policy with no binding.
 */
function hooksConfig(bound: HookId[], checked: HookId[]): GuardrailHooksConfig {
  return {
    contractVersion: 2,
    bindings: Object.fromEntries(bound.map((hook) => [hook, { enabled: true }])),
    policies: [
      {
        id: 'c1',
        family: 'word_filter',
        enabled: true,
        hooks: checked,
        schedule: { timing: 'sync', onFail: 'block' },
      },
    ],
  };
}

/** A guardrail whose config declares exactly `hooks`. */
function guardrail(key: string, hooks: HookId[]): GuardrailBindingOption {
  return { key, name: key, enabled: true, hooksVersion: 1, hooks: hooksConfig(hooks, hooks) };
}

describe('bindingRowsFromStored', () => {
  it('keeps an omitted hooks list omitted', () => {
    const rows = bindingRowsFromStored([{ key: 'pii' }]);
    expect(rows).toEqual([{ key: 'pii' }]);
    // Not merely equal-by-value: the property must be ABSENT, because
    // JSON.stringify drops an absent key and serialises an explicit
    // `undefined`… also as absent, but `hooks: []` as `[]`. The distinction the
    // server reads is array-vs-nothing.
    expect('hooks' in rows[0]).toBe(false);
  });

  it('keeps an explicitly empty hooks list empty', () => {
    // A parked binding is a real operator decision and must survive a reload.
    const rows = bindingRowsFromStored([{ key: 'pii', hooks: [] }]);
    expect(rows).toEqual([{ key: 'pii', hooks: [] }]);
    expect(rows[0].hooks).toEqual([]);
  });

  it('copies an explicit hooks list rather than aliasing the response', () => {
    const stored = [{ key: 'pii', hooks: ['input.pre' as HookId] }];
    const rows = bindingRowsFromStored(stored);
    rows[0].hooks?.push('output.pre');
    expect(stored[0].hooks).toEqual(['input.pre']);
  });

  it('round-trips a mixed list unchanged', () => {
    const stored: Array<{ key: string; hooks?: HookId[] }> = [
      { key: 'follows-guardrail' },
      { key: 'parked', hooks: [] },
      { key: 'explicit', hooks: ['tool.pre', 'tool.post'] },
    ];
    // What the screens POST back is exactly what they loaded, so a save of an
    // unrelated field cannot change what is enforced.
    expect(JSON.parse(JSON.stringify(bindingRowsFromStored(stored)))).toEqual(
      JSON.parse(JSON.stringify(stored)),
    );
  });
});

describe('effectiveHooks', () => {
  const option = guardrail('pii', ['input.pre', 'output.pre']);

  it('resolves an omitted list to what the guardrail declares', () => {
    // Same answer `bindingCoversHook` gives on the server for an absent list.
    expect(effectiveHooks({ key: 'pii' }, option)).toEqual(['input.pre', 'output.pre']);
  });

  it('resolves an explicitly empty list to nothing', () => {
    expect(effectiveHooks({ key: 'pii', hooks: [] }, option)).toEqual([]);
  });

  it('returns an explicit list verbatim, declaration or not', () => {
    // A hook the guardrail no longer declares stays visible so it can be
    // cleared — the control keeps such a box enabled for that reason.
    expect(effectiveHooks({ key: 'pii', hooks: ['tool.pre'] }, option)).toEqual(['tool.pre']);
  });

  it('resolves an omitted list to nothing when the guardrail is unknown', () => {
    // A deleted or out-of-scope key declares nothing, which is also what the
    // server would resolve it to.
    expect(effectiveHooks({ key: 'gone' }, undefined)).toEqual([]);
  });
});

describe('declaredHooks', () => {
  it('needs BOTH an enabled binding and an enabled policy naming the hook', () => {
    // Both hooks have an enabled binding, but only input.pre is named by an
    // enabled policy — output.pre is the "configured and never runs" state, and
    // offering it as a tickable box is how an operator ends up believing they
    // are protected.
    const halfConfigured: GuardrailBindingOption = {
      key: 'half',
      name: 'half',
      hooksVersion: 1,
      hooks: hooksConfig(['input.pre', 'output.pre'], ['input.pre']),
    };
    expect(declaredHooks(halfConfigured)).toEqual(['input.pre']);

    // …and the mirror image: a policy naming a hook with no enabled binding.
    expect(
      declaredHooks({
        key: 'other-half',
        name: 'other-half',
        hooksVersion: 1,
        hooks: hooksConfig(['input.pre'], ['input.pre', 'output.pre']),
      }),
    ).toEqual(['input.pre']);
  });

  it('lifts a pre-hook-plane guardrail to the two slots it was bindable to', () => {
    // Rendering such a guardrail as covering NOTHING would disable every
    // checkbox on the one guardrail most consumers are actually bound to.
    expect(declaredHooks({ key: 'legacy', name: 'legacy' })).toEqual([
      'input.pre',
      'output.pre',
    ]);
  });

  it('treats a version marker with no usable policies as absent', () => {
    expect(
      declaredHooks({
        key: 'broken',
        name: 'broken',
        hooksVersion: 1,
        hooks: { contractVersion: 2, bindings: {} } as GuardrailHooksConfig,
      }),
    ).toEqual(['input.pre', 'output.pre']);
  });
});
