/**
 * Unit — `resolveBindings` / `projectBindingsToLegacy`.
 *
 * The resolver is pure, so it can be pinned exactly, and it deserves to be:
 * it is the single seam where the legacy one-slot binding and the new
 * `guardrails[]` array meet. Every case below is a way an upgrade could
 * silently change what runs — either enforcing something nobody wrote, or
 * quietly disarming something that was enforcing yesterday.
 */

import { describe, it, expect } from 'vitest';
import type { IGuardrailBinding } from '@/lib/database/provider/types.domain';
import {
  projectBindingsToLegacy,
  resolveBindings,
} from '@/lib/services/guardrail/hooks/binding';

describe('resolveBindings — legacy projection (no `guardrails`)', () => {
  const legacy = { inputGuardrailKey: 'gr-in', outputGuardrailKey: 'gr-out' };

  it('projects inputGuardrailKey onto input.pre only', () => {
    expect(resolveBindings(legacy, 'input.pre')).toEqual(['gr-in']);
  });

  it('projects outputGuardrailKey onto BOTH output.pre and output.stream.delta', () => {
    // The streaming gate is the same policy applied before the bytes leave.
    // Dropping it here would let a client that switches to stream:true bypass
    // a guardrail that was enforcing the day before.
    expect(resolveBindings(legacy, 'output.pre')).toEqual(['gr-out']);
    expect(resolveBindings(legacy, 'output.stream.delta')).toEqual(['gr-out']);
  });

  it('binds NOTHING to tool.pre / tool.post', () => {
    // A pre-hook-plane row never opted into tool enforcement. Inventing that
    // binding on upgrade starts blocking tool calls on a policy nobody wrote.
    expect(resolveBindings(legacy, 'tool.pre')).toEqual([]);
    expect(resolveBindings(legacy, 'tool.post')).toEqual([]);
  });

  it('returns [] for an unbound direction and for a fully empty source', () => {
    expect(resolveBindings({ outputGuardrailKey: 'gr-out' }, 'input.pre')).toEqual([]);
    expect(resolveBindings({}, 'input.pre')).toEqual([]);
    expect(resolveBindings({}, 'output.pre')).toEqual([]);
  });

  it('treats a blank/whitespace legacy key as unbound', () => {
    // A cleared slot reaches us as '' from SQLite on some write paths; an
    // empty key would otherwise become a guardrail lookup that can only fail.
    expect(resolveBindings({ inputGuardrailKey: '' }, 'input.pre')).toEqual([]);
    expect(resolveBindings({ inputGuardrailKey: '   ' }, 'input.pre')).toEqual([]);
  });

  it('collapses the same key bound to both directions to one entry per hook', () => {
    const both = { inputGuardrailKey: 'gr-x', outputGuardrailKey: 'gr-x' };
    expect(resolveBindings(both, 'input.pre')).toEqual(['gr-x']);
    expect(resolveBindings(both, 'output.pre')).toEqual(['gr-x']);
  });
});

describe('resolveBindings — `guardrails` is authoritative', () => {
  it('IGNORES the legacy keys entirely when `guardrails` is present', () => {
    // Merging would double-run any guardrail an operator moved into the array
    // while the deprecated column was still written for compatibility — and a
    // double run is a double evaluation log and a double bill.
    const source = {
      guardrails: [{ key: 'gr-new' }],
      inputGuardrailKey: 'gr-legacy',
      outputGuardrailKey: 'gr-legacy',
    };
    expect(resolveBindings(source, 'input.pre')).toEqual(['gr-new']);
    expect(resolveBindings(source, 'output.pre')).toEqual(['gr-new']);
  });

  it('an EMPTY array means bound to nothing, not "fall back to legacy"', () => {
    const source = {
      guardrails: [],
      inputGuardrailKey: 'gr-legacy',
      outputGuardrailKey: 'gr-legacy',
    };
    expect(resolveBindings(source, 'input.pre')).toEqual([]);
    expect(resolveBindings(source, 'output.pre')).toEqual([]);
  });

  it('an omitted `hooks` list activates on every hook', () => {
    const source = { guardrails: [{ key: 'gr-all' }] };
    for (const hook of [
      'input.pre',
      'output.pre',
      'output.stream.delta',
      'tool.pre',
      'tool.post',
    ] as const) {
      expect(resolveBindings(source, hook)).toEqual(['gr-all']);
    }
  });

  it('an explicit `hooks` list filters, including the tool hooks', () => {
    const source = {
      guardrails: [
        { key: 'gr-in', hooks: ['input.pre' as const] },
        { key: 'gr-tools', hooks: ['tool.pre' as const, 'tool.post' as const] },
      ],
    };
    expect(resolveBindings(source, 'input.pre')).toEqual(['gr-in']);
    expect(resolveBindings(source, 'output.pre')).toEqual([]);
    expect(resolveBindings(source, 'tool.pre')).toEqual(['gr-tools']);
    expect(resolveBindings(source, 'tool.post')).toEqual(['gr-tools']);
  });

  it('an explicitly EMPTY `hooks` list parks the binding without deleting it', () => {
    const source = { guardrails: [{ key: 'gr-parked', hooks: [] }] };
    expect(resolveBindings(source, 'input.pre')).toEqual([]);
    expect(resolveBindings(source, 'tool.pre')).toEqual([]);
  });

  it('preserves binding order and de-duplicates keeping the FIRST occurrence', () => {
    // runHook folds verdicts with max(), so order cannot change the decision —
    // but it decides whose blocked-message the end user reads, and an operator
    // who put the friendlier guardrail first meant it.
    const source = {
      guardrails: [
        { key: 'gr-b' },
        { key: 'gr-a' },
        { key: 'gr-b', hooks: ['input.pre' as const] },
        { key: 'gr-c' },
      ],
    };
    expect(resolveBindings(source, 'input.pre')).toEqual(['gr-b', 'gr-a', 'gr-c']);
  });

  it('drops a blank key rather than emitting an unresolvable lookup', () => {
    const source = { guardrails: [{ key: '' }, { key: '  ' }, { key: 'gr-real' }] };
    expect(resolveBindings(source, 'input.pre')).toEqual(['gr-real']);
  });
});

describe('projectBindingsToLegacy', () => {
  it('picks the first binding covering each legacy direction', () => {
    const bindings: IGuardrailBinding[] = [
      { key: 'gr-in', hooks: ['input.pre'] },
      { key: 'gr-in-2', hooks: ['input.pre'] },
      { key: 'gr-out', hooks: ['output.pre'] },
    ];
    expect(projectBindingsToLegacy(bindings)).toEqual({
      inputGuardrailKey: 'gr-in',
      outputGuardrailKey: 'gr-out',
    });
  });

  it('projects an unscoped binding onto both slots', () => {
    expect(projectBindingsToLegacy([{ key: 'gr-all' }])).toEqual({
      inputGuardrailKey: 'gr-all',
      outputGuardrailKey: 'gr-all',
    });
  });

  it('does NOT project a stream-only binding onto outputGuardrailKey', () => {
    // The old binary has no stream gate; it would run the guardrail as a full
    // post-hoc output policy — enforcing exactly what the operator narrowed.
    expect(projectBindingsToLegacy([{ key: 'gr-stream', hooks: ['output.stream.delta'] }]))
      .toEqual({ inputGuardrailKey: undefined, outputGuardrailKey: undefined });
  });

  it('leaves both slots undefined for tool-only bindings (no legacy slot exists)', () => {
    expect(projectBindingsToLegacy([{ key: 'gr-tools', hooks: ['tool.pre', 'tool.post'] }]))
      .toEqual({ inputGuardrailKey: undefined, outputGuardrailKey: undefined });
  });

  it('always reports both keys, so "no longer bound" is distinguishable', () => {
    for (const bindings of [undefined, [] as IGuardrailBinding[]]) {
      const legacy = projectBindingsToLegacy(bindings);
      expect(Object.keys(legacy).sort()).toEqual(['inputGuardrailKey', 'outputGuardrailKey']);
      expect(legacy.inputGuardrailKey).toBeUndefined();
      expect(legacy.outputGuardrailKey).toBeUndefined();
    }
  });

  it('round-trips: projecting then resolving reproduces the legacy behaviour', () => {
    const bindings: IGuardrailBinding[] = [
      { key: 'gr-in', hooks: ['input.pre'] },
      { key: 'gr-out', hooks: ['output.pre', 'output.stream.delta'] },
    ];
    const legacy = projectBindingsToLegacy(bindings);
    expect(resolveBindings(legacy, 'input.pre')).toEqual(['gr-in']);
    expect(resolveBindings(legacy, 'output.pre')).toEqual(['gr-out']);
    expect(resolveBindings(legacy, 'output.stream.delta')).toEqual(['gr-out']);
  });
});
