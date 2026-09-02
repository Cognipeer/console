/**
 * Fix 3 / #8 — MODEL BINDING VALIDATION WARNS ABOUT AUDIT-ONLY STREAMS.
 *
 * A model binding that covers `output.pre` and not `output.stream.delta` is
 * legal — and turns every `stream: true` request into an audit-only pass for
 * that guardrail. `validateGuardrailBindingsDetailed` returns that as a
 * structured warning (never a 400) so the API and the UI can say so; the
 * string-returning `validateGuardrailBindings` keeps its contract.
 *
 * Also pins `carriedGuardrailFields` (Fix 3 / #9), the helper the agent routes
 * use to keep a connected agent's bindings on its config.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuardrailView } from '@/lib/services/guardrail';

const hoisted = vi.hoisted(() => ({
  guardrailByKeyInScope: vi.fn(),
}));

// The record reader lives in the guardrails route plugin; the validator is
// what is under test, so the plugin's DB reach is stubbed.
vi.mock('@/server/api/plugins/guardrails', () => ({
  guardrailByKeyInScope: hoisted.guardrailByKeyInScope,
  toGuardrailRecord: (view: unknown) => view,
}));

import {
  carriedGuardrailFields,
  validateGuardrailBindings,
  validateGuardrailBindingsDetailed,
} from '@/server/api/plugins/guardrail-bindings';

/** A guardrail whose secrets policy runs on the given hooks, all bound. */
function view(key: string, hooks: string[]): GuardrailView {
  const bindings: Record<string, { enabled: boolean; schedule: unknown }> = {};
  for (const hook of hooks) bindings[hook] = { enabled: true, schedule: { timing: 'sync', onFail: 'block' } };
  return {
    id: key,
    tenantId: 't1',
    key,
    name: key,
    type: 'custom',
    target: 'output',
    action: 'block',
    enabled: true,
    createdBy: 'u1',
    hooksVersion: 1,
    hooks: {
      contractVersion: 2,
      policies: [
        { id: 's1', family: 'secrets', enabled: true, hooks, schedule: { timing: 'sync', onFail: 'block' }, known: true },
      ],
      bindings,
    },
  } as unknown as GuardrailView;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.guardrailByKeyInScope.mockImplementation(async (_db: string, key: string) =>
    key === 'gr-both'
      ? view(key, ['output.pre', 'output.stream.delta'])
      : key === 'gr-pre-only'
        ? view(key, ['output.pre'])
        : null,
  );
});

describe('validateGuardrailBindingsDetailed — stream_unenforced', () => {
  it('warns when a model binding narrows a stream-capable guardrail to output.pre', async () => {
    const result = await validateGuardrailBindingsDetailed('t1', 'p1', [{ key: 'gr-both', hooks: ['output.pre'] }]);
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'stream_unenforced', key: 'gr-both' }),
    ]);
    expect(result.warnings[0].message).toContain('audit-only');
    expect(result.warnings[0].message).toContain('output.stream.delta');
  });

  it('warns when the hooks are omitted and the guardrail itself declares no stream hook', async () => {
    // Omitted hooks = "wherever the guardrail runs" — and this one never runs
    // on the stream, so streams are just as unenforced.
    const result = await validateGuardrailBindingsDetailed('t1', 'p1', [{ key: 'gr-pre-only' }]);
    expect(result.error).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toEqual(['stream_unenforced']);
  });

  it('is silent when the binding covers the stream hook too', async () => {
    const result = await validateGuardrailBindingsDetailed('t1', 'p1', [
      { key: 'gr-both', hooks: ['output.pre', 'output.stream.delta'] },
    ]);
    expect(result).toEqual({ error: null, warnings: [] });
  });

  it('is silent for an AGENT consumer, which never streams through the gate', async () => {
    const result = await validateGuardrailBindingsDetailed(
      't1', 'p1', [{ key: 'gr-both', hooks: ['output.pre'] }], undefined, { consumer: 'agent' },
    );
    expect(result.warnings).toEqual([]);
  });

  it('still 400s a missing guardrail and an unsupported hook', async () => {
    expect((await validateGuardrailBindingsDetailed('t1', 'p1', [{ key: 'gr-nope' }])).error)
      .toBe('Guardrail "gr-nope" does not exist in this project');
    expect((await validateGuardrailBindingsDetailed('t1', 'p1', [{ key: 'gr-pre-only', hooks: ['tool.pre'] }])).error)
      .toContain('has no enabled policy bound to tool.pre');
  });

  it('the string-returning validator does NOT turn the warning into a 400', async () => {
    expect(await validateGuardrailBindings('t1', 'p1', [{ key: 'gr-both', hooks: ['output.pre'] }])).toBeNull();
  });
});

describe('carriedGuardrailFields', () => {
  it('carries the binding list and the string legacy slots, and nothing else', () => {
    expect(carriedGuardrailFields({
      kind: 'external',
      connection: { url: 'x' },
      guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }],
      inputGuardrailKey: 'gr-in',
      outputGuardrailKey: 'gr-out',
      systemPrompt: 'dropped',
    })).toEqual({
      guardrails: [{ key: 'gr-in', hooks: ['input.pre'] }],
      inputGuardrailKey: 'gr-in',
      outputGuardrailKey: 'gr-out',
    });
  });

  it('leaves out fields of the wrong shape rather than guessing', () => {
    expect(carriedGuardrailFields({ guardrails: 'gr-in', inputGuardrailKey: 7 })).toEqual({});
  });
});
