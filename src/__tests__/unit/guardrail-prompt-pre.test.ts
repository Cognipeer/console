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
 *   · THE LEGACY LIFT BINDS NOTHING TO IT. A row written before the hook existed
 *     never opted in, and the lifted set includes the LLM families — so lifting
 *     it there would hand every legacy tenant a new model call per run, plus a
 *     new evaluation-log row and a new usage event, on upgrade;
 *   · an AUTHORED config can bind to it, or the hook is decoration;
 *   · `input.pre` is unchanged, field for field. Adding a hook must not move an
 *     existing one, because bindings for it are already on disk.
 *
 * It also pins the three declarations that were being read structurally:
 * `runIf`, `redactBeforeSend`, and the single `POLICY_VALID_HOOKS` table that
 * the engine and the save-time validator now share.
 */

import { describe, expect, it, vi } from 'vitest';

// Sync factory only: an async `vi.mock` factory does not intercept in this
// repo. `hooks/legacy` reaches the barrel for `runWithTenantScope`, and the
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
import { liftLegacyBindings, liftLegacyHooks, validateGuardrailHooks } from '@/lib/services/guardrail/hooks/legacy';
import { parseHookId } from '@/server/api/plugins/guardrails';
import type { IGuardrail } from '@/lib/database/provider/types.domain';

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

/**
 * A pre-hook-plane preset row with every legacy family switched on, so the lift
 * produces one policy of each kind it can produce. `hooksVersion` is absent —
 * that is what makes it a legacy row.
 */
const LEGACY_PRESET: IGuardrail = {
  tenantId: 'tenant-1',
  key: 'legacy-guard',
  name: 'Legacy Guard',
  type: 'preset',
  target: 'input',
  action: 'block',
  enabled: true,
  failMode: 'open',
  modelKey: 'gpt-judge',
  policy: {
    pii: { enabled: true, action: 'redact', categories: { email: true, apiKey: true } },
    wordFilter: { enabled: true, action: 'block', words: ['forbidden'] },
    moderation: { enabled: true, categories: { hate: true } },
    promptShield: { enabled: true, sensitivity: 'balanced' },
  },
  createdBy: 'user-1',
};

/** An authored config: `hooksVersion >= 1`, so `ensureHooks` uses it verbatim
 *  and `validateGuardrailHooks` applies. */
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
    // The legacy `target` projection groups it with the other input-side hooks;
    // it never gates policy, but a user turn reading as 'output' would be a
    // guardrail list that files the hook under the model's answer.
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

// ── the lift must not grow ──────────────────────────────────────────────────

describe('the legacy lift binds nothing to prompt.pre', () => {
  it('enables exactly input.pre and output.pre, as it did before the hook existed', () => {
    expect(Object.keys(liftLegacyBindings()).sort()).toEqual(['input.pre', 'output.pre']);
  });

  it('names prompt.pre on no lifted policy, preset or custom', () => {
    const preset = liftLegacyHooks(LEGACY_PRESET, 'pii-migrated-legacy-guard');
    const custom = liftLegacyHooks({
      ...LEGACY_PRESET,
      type: 'custom',
      policy: undefined,
      customPrompt: 'Refuse anything about competitors.',
    });

    for (const config of [preset, custom]) {
      expect(config.policies.length).toBeGreaterThan(0);
      for (const policy of config.policies) {
        // A lifted policy that named the hook would be worse than a bound one:
        // the binding is off, so the UI would show a policy "on" at a hook that
        // never runs.
        expect(policy.hooks, policy.id).not.toContain('prompt.pre');
      }
      expect(config.bindings['prompt.pre']).toBeUndefined();
    }
  });

  it('does not bill a legacy row for a model call it never asked for', () => {
    // The concrete cost of getting the rule above wrong: the lifted set
    // includes the two LLM families, so a `prompt.pre` binding here would be a
    // moderation call and a prompt-shield call per run, fleet-wide, on upgrade.
    const llmPolicies = liftLegacyHooks(LEGACY_PRESET).policies.filter(
      (policy) => policy.family === 'moderation' || policy.family === 'prompt_shield',
    );
    expect(llmPolicies).toHaveLength(2);
    for (const policy of llmPolicies) expect(policy.hooks).toEqual(['input.pre', 'output.pre']);
  });
});

// ── input.pre is untouched ──────────────────────────────────────────────────

describe('input.pre is unchanged', () => {
  it('lifts a legacy preset to exactly the config it lifted to before', () => {
    // Field for field, not "contains input.pre": bindings for this hook are
    // already on disk across the fleet, so anything that moved here would move
    // enforcement on rows nobody edited.
    expect(liftLegacyHooks(LEGACY_PRESET, 'pii-migrated-legacy-guard')).toEqual({
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      policies: [
        {
          id: 'legacy:pii',
          family: 'pii',
          enabled: true,
          hooks: ['input.pre', 'output.pre'],
          schedule: SYNC_BLOCK,
          action: 'redact',
          failMode: 'open',
          piiPolicyKey: 'pii-migrated-legacy-guard',
          detectObfuscated: true,
          // `apiKey` is NOT mapped here: with the `legacy:secrets` policy
          // below enabled, the credential scan is the secrets family's alone
          // (the review's finding #15 — both sides scanning yielded two `high`
          // findings per key).
          legacyCategories: { email: true },
        },
        {
          id: 'legacy:secrets',
          family: 'secrets',
          enabled: true,
          hooks: ['input.pre', 'output.pre'],
          schedule: SYNC_BLOCK,
          action: 'redact',
          failMode: 'open',
          known: true,
          genericHighEntropy: true,
        },
        {
          id: 'legacy:word_filter',
          family: 'word_filter',
          enabled: true,
          hooks: ['input.pre', 'output.pre'],
          schedule: SYNC_BLOCK,
          action: 'block',
          failMode: 'open',
          builtinLists: undefined,
          customListKeys: undefined,
          words: ['forbidden'],
          regexes: undefined,
        },
        {
          id: 'legacy:moderation',
          family: 'moderation',
          enabled: true,
          hooks: ['input.pre', 'output.pre'],
          schedule: SYNC_BLOCK,
          action: 'block',
          failMode: 'open',
          modelKey: 'gpt-judge',
          categories: { hate: true },
        },
        {
          id: 'legacy:prompt_shield',
          family: 'prompt_shield',
          enabled: true,
          hooks: ['input.pre', 'output.pre'],
          schedule: SYNC_BLOCK,
          action: 'block',
          failMode: 'open',
          modelKey: 'gpt-judge',
          sensitivity: 'balanced',
        },
      ],
      bindings: {
        'input.pre': { enabled: true, schedule: SYNC_BLOCK, timeoutMs: 0 },
        'output.pre': { enabled: true, schedule: SYNC_BLOCK, timeoutMs: 0 },
      },
      stream: { enabled: false },
      shortCircuit: false,
    });
  });

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
