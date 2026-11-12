/**
 * `prompt.pre` — the sixth hook — and the three type gaps that shipped with it.
 *
 * WHY THIS FILE EXISTS. The console had exactly one hook for "before a model
 * call" and it was doing two jobs. The SDK's legacy `Request` phase fires
 * before EVERY model call (its de-duplication gate reads
 * `state.messages.length`, which grows with each tool result inside one
 * invoke), so `input.pre` bound to an LLM moderation policy costs one model call
 * per loop iteration and, after the first one, judges a TOOL RESULT rather than
 * anything a person typed. `prompt.pre` is the other rule: once per run, the
 * incoming user turn.
 *
 * What is pinned here, and why each one is a real failure mode:
 *   · `prompt.pre` is a real hook id off the wire — an id the contract knows and
 *     the request parser refuses is a binding an operator can save and nothing
 *     can ever evaluate;
 *   · a stored config can bind to it, or the hook is decoration;
 *   · `input.pre` is unchanged, field for field. Adding a hook must not move an
 *     existing one, because bindings for it are already on disk.
 *
 * It also pins the three declarations that were being read structurally:
 * `runIf`, `redactBeforeSend`, and the single `POLICY_VALID_HOOKS` table that
 * the engine and the save-time validator now share.
 */

import { describe, expect, it, vi } from 'vitest';

// Sync factory only: an async `vi.mock` factory does not intercept in this
// repo. The guardrail modules reach the barrel for `runWithTenantScope`, and the
// barrel constructs providers and registers shutdown handlers the moment it
// loads — nothing below evaluates anything, so a stub is enough.
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

import {
  POLICY_FAMILIES,
  POLICY_VALID_HOOKS,
  GUARDRAIL_CONTRACT_VERSION,
  HOOK_IDS,
  HOOK_SUBJECT_KIND,
  hookDirection,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailPolicy,
  GuardrailHooksConfig,
  HookId,
} from '@/lib/services/guardrail/hooks/contract';
import { validateGuardrailHooks } from '@/lib/services/guardrail/hooks/validate';
import { parseHookId } from '@/server/api/plugins/guardrails';

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

/** A stored hooks config, as `validateGuardrailHooks` sees it. */
function authored(policies: GuardrailPolicy[], hooks: HookId[]): GuardrailHooksConfig {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    policies,
    bindings: Object.fromEntries(
      hooks.map((hook) => [hook, { enabled: true, schedule: { ...SYNC_BLOCK } }]),
    ),
    stream: { enabled: false },
    shortCircuit: false,
  };
}

// ── the hook itself ─────────────────────────────────────────────────────────

describe('prompt.pre is a first-class hook', () => {
  it('is in the contract, carries a text subject, and runs on the input side', () => {
    expect(HOOK_IDS).toContain('prompt.pre');
    expect(HOOK_SUBJECT_KIND['prompt.pre']).toBe('text');
    // A user turn reading as 'output' would be a guardrail list that files the
    // hook under the model's answer.
    expect(hookDirection('prompt.pre')).toBe('input');
  });

  it('is accepted off the wire by the request parser', () => {
    // A hook the contract declares and the parser refuses is a binding an
    // operator can save and no enforcement point can ever evaluate — the
    // silent-no-op failure the whole plane exists to remove.
    expect(parseHookId('prompt.pre')).toEqual({ hook: 'prompt.pre' });
    // …and the parser still names it, so a caller that sent a typo is told what
    // the legal values are.
    expect(parseHookId('prompt.pree').error).toContain('prompt.pre');
  });

  it('allows exactly what input.pre allows, minus the family that needs a tool', () => {
    for (const family of POLICY_FAMILIES) {
      const valid = POLICY_VALID_HOOKS[family];
      // Both hooks carry one `text` subject, so any family that can adjudicate
      // a string at one can adjudicate it at the other. `tool_access` is on
      // neither, for the same reason on both: its subject is a tool call.
      expect(valid.includes('prompt.pre'), family).toBe(valid.includes('input.pre'));
    }
    expect(POLICY_VALID_HOOKS.tool_access).not.toContain('prompt.pre');
  });

  it('accepts an authored binding', () => {
    const config = authored(
      [
        {
          id: 'turn-moderation',
          family: 'moderation',
          enabled: true,
          hooks: ['prompt.pre'],
          schedule: { ...SYNC_BLOCK },
          modelKey: 'gpt-judge',
          categories: { hate: true },
        },
      ],
      ['prompt.pre'],
    );
    expect(validateGuardrailHooks(config)).toEqual([]);
  });

  it('refuses a tool_access policy bound to it, because a user turn has no tool call', () => {
    const config = authored(
      [
        {
          id: 'tools',
          family: 'tool_access',
          enabled: true,
          hooks: ['prompt.pre'],
          schedule: { ...SYNC_BLOCK },
        },
      ],
      ['prompt.pre'],
    );
    expect(validateGuardrailHooks(config)).toEqual([
      'Policy "tools" (tool_access) cannot run on hook "prompt.pre"',
    ]);
  });
});

// ── input.pre is untouched ──────────────────────────────────────────────────

describe('input.pre is unchanged', () => {
  it('is still a text hook the parser accepts, and still first among the model hooks', () => {
    expect(parseHookId('input.pre')).toEqual({ hook: 'input.pre' });
    expect(HOOK_SUBJECT_KIND['input.pre']).toBe('text');
    expect(hookDirection('input.pre')).toBe('input');
    // Pipeline order: the turn, then every model call it causes.
    expect(HOOK_IDS.indexOf('prompt.pre')).toBeLessThan(HOOK_IDS.indexOf('input.pre'));
  });
});

// ── the three declarations ──────────────────────────────────────────────────

describe('the fields the engine was reading structurally', () => {
  it('accepts a declared runIf on a policy', () => {
    // Declared on `GuardrailPolicyBase`, so this object literal is a compile-time
    // assertion as much as a runtime one: undeclared, `runIf` would be an excess
    // property and every gated policy would silently resolve to 'always'.
    const config = authored(
      [
        {
          id: 'judge',
          family: 'custom',
          enabled: true,
          hooks: ['prompt.pre'],
          schedule: { ...SYNC_BLOCK },
          runIf: 'onFinding',
          modelKey: 'gpt-judge',
          prompt: 'Is this a support request?',
          onMissingModel: 'error_finding',
        },
      ],
      ['prompt.pre'],
    );
    expect(validateGuardrailHooks(config)).toEqual([]);
    expect(config.policies[0].runIf).toBe('onFinding');
  });

  it('accepts a declared redactBeforeSend on a webhook policy', () => {
    const config = authored(
      [
        {
          id: 'partner',
          family: 'webhook',
          enabled: true,
          hooks: ['prompt.pre'],
          schedule: { ...SYNC_BLOCK },
          url: 'https://partner.example.com/guard',
          send: 'text',
          // The family defaults this to true; the point of declaring it is that
          // an operator turning it OFF — shipping text the guardrail already
          // decided to redact to a third party — is a visible choice.
          redactBeforeSend: false,
        },
      ],
      ['prompt.pre'],
    );
    expect(validateGuardrailHooks(config)).toEqual([]);
  });

  it('has one prompt_shield table, and it is the wider one the engine already ran', () => {
    // The save-time validator used to refuse `output.pre` while the engine
    // dispatched it, so a hand-written row did something the UI called illegal.
    expect(POLICY_VALID_HOOKS.prompt_shield).toContain('output.pre');
    const config = authored(
      [
        {
          id: 'shield',
          family: 'prompt_shield',
          enabled: true,
          hooks: ['input.pre', 'output.pre'],
          schedule: { ...SYNC_BLOCK },
          modelKey: 'gpt-judge',
          sensitivity: 'balanced',
        },
      ],
      ['input.pre', 'output.pre'],
    );
    expect(validateGuardrailHooks(config)).toEqual([]);
  });
});
