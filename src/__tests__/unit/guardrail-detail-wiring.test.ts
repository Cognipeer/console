/**
 * The Config tab's wiring: the two facts the page can get wrong while every
 * screen still looks correct.
 *
 *   1. AN OPTION LIST THAT DROPS A STORED KEY. `PolicyFieldRenderer`'s
 *      `reference` control renders a value it cannot find in its options as an
 *      EMPTY select. The value is still stored and still being evaluated, so a
 *      PII policy whose policy key was deleted reads as unconfigured — and the
 *      fix an operator reaches for silently rewrites a setting they were never
 *      shown. `withReferencedKeys` is what keeps that key on screen, and it has
 *      to do it without inventing a list that never loaded.
 *   2. A DEFAULT MESSAGE NOBODY READS. A policy's own `message` outranks the
 *      reason-class default, so the Default messages panel has to say how many
 *      policies have taken themselves out of the row being edited.
 *
 * Both live outside `page.tsx` because a Next app-router page may export
 * nothing but its default — a helper left in the page is a helper no test can
 * reach.
 */

import { describe, expect, it } from 'vitest';
import {
  referencedResourceKeys,
  withReferencedKeys,
} from '@/components/guardrails/policyResources';
import type { PolicyFieldResources } from '@/components/guardrails/PolicyFieldRenderer';
import { policyMessageOverrides } from '@/components/guardrails/GuardrailDefaultMessages';
import { POLICY_FAMILIES } from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailPolicy,
  PiiPolicyConfig,
  RegexPolicyConfig,
  WebhookPolicyConfig,
  WordFilterPolicyConfig,
} from '@/lib/services/guardrail/hooks/contract';
import { fieldsOf } from '@/lib/services/guardrail/catalog';

// ── fixtures ────────────────────────────────────────────────────────────────

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

const PII: PiiPolicyConfig = {
  id: 'pii-outbound',
  family: 'pii',
  enabled: true,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  label: 'Outbound personal data',
  piiPolicyKey: 'eu-strict',
};

const WORDS: WordFilterPolicyConfig = {
  id: 'words',
  family: 'word_filter',
  enabled: true,
  hooks: ['input.pre'],
  schedule: SYNC_BLOCK,
  customListKeys: ['brand-terms', 'competitors'],
};

const REGEX: RegexPolicyConfig = {
  id: 'regex-case',
  family: 'regex',
  enabled: true,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  rules: [
    {
      id: 'case-no',
      label: 'Case numbers',
      pattern: 'CASE-\\d{6}',
      category: 'internal-id',
      severity: 'medium',
      maxMatchChars: 32,
    },
  ],
};

const WEBHOOK: WebhookPolicyConfig = {
  id: 'webhook',
  family: 'webhook',
  enabled: true,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  url: 'https://verdict.example.com/check',
  send: 'text',
  credentialProviderKey: 'verdict-token',
};

// ── which keys a set of policies points at ──────────────────────────────────

describe('referencedResourceKeys', () => {
  it('harvests every resource a policy points at, by resource and not by family', () => {
    const found = referencedResourceKeys([PII, WORDS, WEBHOOK]);

    expect(found.get('pii_policy')).toEqual(new Set(['eu-strict']));
    // The one `multiple` reference in the catalog: a string ARRAY, and every
    // element of it counts.
    expect(found.get('word_list')).toEqual(new Set(['brand-terms', 'competitors']));
    // A webhook credential is a `'secret'`, not a `'provider'`: `'provider'`
    // means a Model Hub LLM record, and pointing this field there is what once
    // offered an operator a list of Azure deployments to sign a webhook with.
    expect(found.get('secret')).toEqual(new Set(['verdict-token']));
    expect(found.get('provider')).toBeUndefined();
  });

  it('reports nothing for policies that point at nothing', () => {
    expect(referencedResourceKeys([REGEX]).size).toBe(0);
    expect(referencedResourceKeys([]).size).toBe(0);
  });

  it('ignores blanks — an empty string is not a reference', () => {
    const blank = Object.assign({}, PII, { piiPolicyKey: '   ' });
    expect(referencedResourceKeys([blank]).size).toBe(0);
  });

  it('degrades for a family this build does not know instead of throwing', () => {
    const alien = Object.assign({}, PII, { family: 'zzz-unknown' }) as unknown as GuardrailPolicy;
    expect(() => referencedResourceKeys([alien])).not.toThrow();
    expect(referencedResourceKeys([alien]).size).toBe(0);
  });

  it('is schema-driven: every reference field of every family is reachable', () => {
    // The guard on the claim "a tenth family's references are preserved with no
    // edit here". If this walk ever stopped reading `fieldsOf`, a family whose
    // reference field is not one of the four in the fixtures above would lose
    // its stored key silently.
    const declared = POLICY_FAMILIES.flatMap((family) =>
      fieldsOf(family)
        .filter((field) => field.kind === 'reference')
        .map((field) => ({ family, key: field.key, resource: field.resource })),
    );
    expect(declared.length).toBeGreaterThan(0);

    for (const field of declared) {
      const policy = {
        id: `probe-${field.family}-${field.key}`,
        family: field.family,
        enabled: true,
        hooks: [],
        schedule: SYNC_BLOCK,
        [field.key]: 'probe-value',
      } as unknown as GuardrailPolicy;
      expect(referencedResourceKeys([policy]).get(field.resource)).toContain('probe-value');
    }
  });
});

// ── the merge that keeps a deleted key visible ──────────────────────────────

describe('withReferencedKeys', () => {
  const loaded: PolicyFieldResources = {
    pii_policy: [{ value: 'default', label: 'Default' }],
    word_list: [{ value: 'brand-terms', label: 'Brand terms (12 words)' }],
    secret: [],
    model: [{ value: 'gpt-4o', label: 'GPT-4o' }],
  };

  it('adds back a stored key the tenant no longer offers, marked', () => {
    const merged = withReferencedKeys(loaded, [PII]);
    expect(merged.pii_policy).toEqual([
      { value: 'default', label: 'Default' },
      { value: 'eu-strict', label: 'eu-strict (not found)' },
    ]);
  });

  it('adds back only the missing half of a multi-valued reference', () => {
    const merged = withReferencedKeys(loaded, [WORDS]);
    expect(merged.word_list?.map((option) => option.value)).toEqual([
      'brand-terms',
      'competitors',
    ]);
    expect(merged.word_list?.find((option) => option.value === 'brand-terms')?.label).toBe(
      'Brand terms (12 words)',
    );
  });

  it('appends to an EMPTY list — "you have none" is still a list that loaded', () => {
    const merged = withReferencedKeys(loaded, [WEBHOOK]);
    expect(merged.secret).toEqual([{ value: 'verdict-token', label: 'verdict-token (not found)' }]);
  });

  it('leaves a resource that never loaded ABSENT rather than filling it with orphans', () => {
    // The distinction the renderer draws with `emptyHint`: a fetch that failed
    // is not the same as a tenant with no word lists, and a single
    // "(not found)" option in a list that never loaded would claim the key was
    // deleted when nothing of the sort is known.
    const merged = withReferencedKeys({ model: loaded.model }, [PII, WORDS, WEBHOOK]);
    expect(merged.pii_policy).toBeUndefined();
    expect(merged.word_list).toBeUndefined();
    // `secret`, not `provider`: this has to name the resource the WEBHOOK
    // fixture actually points at, or it asserts nothing about the orphan rule.
    expect(merged.secret).toBeUndefined();
    expect(merged.model).toBe(loaded.model);
  });

  it('returns the SAME object when nothing needs adding', () => {
    // It feeds a `useMemo` whose result is a prop on two components; a fresh
    // object per render would re-seed the drawer's draft.
    const resolved: PolicyFieldResources = {
      pii_policy: [{ value: 'eu-strict', label: 'EU strict' }],
    };
    expect(withReferencedKeys(resolved, [PII])).toBe(resolved);
    expect(withReferencedKeys(loaded, [])).toBe(loaded);
    expect(withReferencedKeys(loaded, [REGEX])).toBe(loaded);
  });

  it('does not mutate the lists it was given', () => {
    const before = JSON.stringify(loaded);
    withReferencedKeys(loaded, [PII, WORDS, WEBHOOK]);
    expect(JSON.stringify(loaded)).toBe(before);
  });

  it('compares by option VALUE, not by label', () => {
    const numeric: PolicyFieldResources = { pii_policy: [{ value: 'eu-strict', label: 'x' }] };
    expect(withReferencedKeys(numeric, [PII]).pii_policy).toHaveLength(1);
  });
});

// ── who has taken themselves out of the default ─────────────────────────────

describe('policyMessageOverrides', () => {
  const withMessage = (policy: GuardrailPolicy, message: string): GuardrailPolicy =>
    Object.assign({}, policy, { message });

  it('counts per REASON CLASS, so families that share one are counted together', () => {
    // regex and webhook both land on 'custom'. That collapse is exactly why
    // `policy.message` exists, and why the panel has to report it.
    const counts = policyMessageOverrides([
      withMessage(REGEX, 'Our case numbers cannot leave this system.'),
      withMessage(WEBHOOK, 'Our adjudicator declined this.'),
      withMessage(PII, 'That looked like personal data.'),
    ]);
    expect(counts.custom).toBe(2);
    expect(counts.pii).toBe(1);
  });

  it('ignores a policy with no message, and a blank one', () => {
    expect(policyMessageOverrides([PII, REGEX])).toEqual({});
    expect(policyMessageOverrides([withMessage(PII, '   ')])).toEqual({});
    expect(policyMessageOverrides(undefined)).toEqual({});
  });

  it('drops a family with no reason class instead of inventing a row', () => {
    const alien = Object.assign({}, PII, {
      family: 'zzz-unknown',
      message: 'hello',
    }) as unknown as GuardrailPolicy;
    expect(policyMessageOverrides([alien])).toEqual({});
  });
});
