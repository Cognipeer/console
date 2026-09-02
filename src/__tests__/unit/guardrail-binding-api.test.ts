/**
 * Unit — the API write path for `guardrails: IGuardrailBinding[]`
 * (`server/api/plugins/guardrail-bindings.ts`).
 *
 * `guardrail-binding.test.ts` pins the pure READ resolver. This pins the write
 * side, which is where the two ways a binding silently stops working live:
 * a field a whitelist drops, and a legacy write that a stored list overrules.
 */

import { describe, it, expect } from 'vitest';
import type { GuardrailView } from '@/lib/services/guardrail';
import {
  declaredGuardrailHooks,
  legacyGuardrailSlots,
  legacyGuardrailWriteConflict,
  readGuardrailBindingsField,
} from '@/server/api/plugins/guardrail-bindings';

describe('readGuardrailBindingsField', () => {
  it('distinguishes an absent field from an empty list', () => {
    // `undefined` = "not mentioned, leave it alone"; `[]` = "bound to nothing",
    // a real operator action the resolver honours literally. Conflating them
    // re-arms the legacy fallback on a consumer that was deliberately disarmed.
    expect(readGuardrailBindingsField(undefined)).toEqual({});
    expect(readGuardrailBindingsField([])).toEqual({ bindings: [] });
  });

  it('rejects a non-array', () => {
    expect(readGuardrailBindingsField({ key: 'gr' }).error)
      .toBe('`guardrails` must be an array of { key, hooks? } objects');
  });

  it('rejects an entry that is not an object, and a blank key', () => {
    expect(readGuardrailBindingsField(['gr']).error).toContain('`guardrails[0]`');
    expect(readGuardrailBindingsField([{ key: '   ' }]).error)
      .toContain('`guardrails[0].key`');
  });

  it('rejects a repeated key', () => {
    // `resolveBindings` de-duplicates keeping the FIRST occurrence, so a second
    // entry is config that is stored, rendered, and never applied.
    const result = readGuardrailBindingsField([
      { key: 'gr', hooks: ['input.pre'] },
      { key: 'gr', hooks: ['tool.pre'] },
    ]);
    expect(result.error).toContain('lists "gr" more than once');
    expect(result.bindings).toBeUndefined();
  });

  it('rejects an unknown hook id and names the valid set', () => {
    const result = readGuardrailBindingsField([{ key: 'gr', hooks: ['retrieval.post'] }]);
    expect(result.error).toContain('"retrieval.post"');
    expect(result.error).toContain('input.pre');
  });

  it('keeps an omitted `hooks` ABSENT rather than materialising it', () => {
    // Omitted means "wherever the guardrail declares it runs". Materialising
    // today's declaration would pin the binding, so a later edit to the
    // guardrail would stop reaching a consumer that never asked to be pinned.
    const result = readGuardrailBindingsField([{ key: 'gr' }]);
    expect(result.bindings).toEqual([{ key: 'gr' }]);
    expect(Object.prototype.hasOwnProperty.call(result.bindings?.[0] ?? {}, 'hooks')).toBe(false);
  });

  it('de-duplicates hooks, preserves order, and drops unknown properties', () => {
    const result = readGuardrailBindingsField([
      { key: 'gr', hooks: ['tool.post', 'input.pre', 'tool.post'], mode: 'enforce' },
    ]);
    expect(result.bindings).toEqual([{ key: 'gr', hooks: ['tool.post', 'input.pre'] }]);
  });
});

describe('declaredGuardrailHooks', () => {
  const base: GuardrailView = {
    id: 'g1',
    tenantId: 't1',
    key: 'gr',
    name: 'Guardrail',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    createdBy: 'u1',
  } as GuardrailView;

  const legacyPolicy = {
    pii: { enabled: true, action: 'block', categories: { email: true } },
  };

  it('lifts a legacy row to input.pre + output.pre', () => {
    // What the row was bindable to before the hook plane. Reporting "nothing"
    // would disable every checkbox on the guardrails most consumers are on.
    const legacy = { ...base, policy: legacyPolicy } as GuardrailView;
    expect(declaredGuardrailHooks(legacy)).toEqual(['input.pre', 'output.pre']);
  });

  it('declares nothing for a legacy row whose policy enables no policy', () => {
    // Honest, not a bug: such a guardrail evaluates nothing wherever it is
    // bound, and the UI greys out every hook rather than promising protection.
    expect(declaredGuardrailHooks(base)).toEqual([]);
  });

  it('needs BOTH an enabled binding and an enabled policy naming the hook', () => {
    const authored: GuardrailView = {
      ...base,
      hooksVersion: 1,
      hooks: {
        contractVersion: 2,
        policies: [
          {
            id: 'c1',
            family: 'secrets',
            enabled: true,
            hooks: ['input.pre', 'output.pre'],
            schedule: { timing: 'sync', onFail: 'block' },
            known: true,
          },
          // Enabled, but its hook has no enabled binding — the classic
          // "configured and never runs" state.
          {
            id: 'c2',
            family: 'tool_access',
            enabled: true,
            hooks: ['tool.pre'],
            schedule: { timing: 'sync', onFail: 'block' },
          },
        ],
        bindings: {
          'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
          // Bound but no enabled policy names it.
          'output.stream.delta': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
          'tool.pre': { enabled: false, schedule: { timing: 'sync', onFail: 'block' } },
        },
      },
    } as GuardrailView;
    expect(declaredGuardrailHooks(authored)).toEqual(['input.pre']);
  });

  it('treats a version marker with no usable policies as a legacy row', () => {
    // The same fail-safe `ensureHooks` applies: a write that dropped one column
    // must not turn into a guardrail that declares nothing.
    const broken = { ...base, policy: legacyPolicy, hooksVersion: 3 } as GuardrailView;
    expect(declaredGuardrailHooks(broken)).toEqual(['input.pre', 'output.pre']);
  });
});

describe('legacyGuardrailSlots', () => {
  it('projects the first covering binding onto each slot', () => {
    expect(
      legacyGuardrailSlots([
        { key: 'gr-in', hooks: ['input.pre'] },
        { key: 'gr-out', hooks: ['output.pre', 'output.stream.delta'] },
      ]),
    ).toEqual({ inputGuardrailKey: 'gr-in', outputGuardrailKey: 'gr-out' });
  });

  it('blanks an unbound slot with `` rather than undefined', () => {
    // `updateModel` skips an `undefined` field, so `undefined` would leave a
    // stale key in the column and an older binary would keep enforcing a
    // guardrail the operator has just unbound.
    expect(legacyGuardrailSlots([{ key: 'gr-tool', hooks: ['tool.pre'] }]))
      .toEqual({ inputGuardrailKey: '', outputGuardrailKey: '' });
    expect(legacyGuardrailSlots([]))
      .toEqual({ inputGuardrailKey: '', outputGuardrailKey: '' });
  });
});

describe('legacyGuardrailWriteConflict', () => {
  const listed = { guardrails: [{ key: 'gr-in', hooks: ['input.pre' as const] }] };

  it('is silent on a row that is still on the legacy slots', () => {
    expect(legacyGuardrailWriteConflict({}, { inputGuardrailKey: 'gr-x' })).toBeNull();
    expect(legacyGuardrailWriteConflict({ guardrails: [] }, { inputGuardrailKey: 'gr-x' }))
      .toBeNull();
  });

  it('allows a client that echoes back the legacy columns it loaded', () => {
    // A client resending what it read is changing nothing, so an unrelated edit
    // (a rename, a price change) must still go through. The model edit screen
    // no longer sends these columns; the token and client APIs, and any older
    // integration that round-trips a whole model record, still do.
    expect(
      legacyGuardrailWriteConflict(listed, {
        inputGuardrailKey: 'gr-in',
        outputGuardrailKey: '',
      }),
    ).toBeNull();
  });

  it('rejects a legacy write that would actually change the binding', () => {
    // Without this the write returns 200, the screen re-reads the column it
    // just set, and the guardrail it named never runs — `resolveBindings`
    // ignores the legacy keys while `guardrails` is present.
    const message = legacyGuardrailWriteConflict(listed, { inputGuardrailKey: 'gr-other' });
    expect(message).toContain('`inputGuardrailKey`');
    expect(message).toContain('guardrails');
  });

  it('names every conflicting slot, not just the first', () => {
    const message = legacyGuardrailWriteConflict(listed, {
      inputGuardrailKey: 'gr-other',
      outputGuardrailKey: 'gr-out',
    });
    expect(message).toContain('`inputGuardrailKey` and `outputGuardrailKey`');
  });
});
