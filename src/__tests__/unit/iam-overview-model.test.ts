/**
 * The Overview's view model for denials by a policy that has been deleted
 * since: which denials name such a policy, the name the policy-change trail
 * still has for it, and where in the sentence that name goes.
 */
import { describe, expect, it } from 'vitest';
import {
  POLICY_SLOT,
  deletedPolicyIds,
  deletedPolicyOf,
  splitAtPolicySlot,
  storedPolicyNames,
  withPolicySlot,
} from '@/components/iam/overview/overviewModel';
import { formatAuditText } from '@/components/iam/audit/summaryText';
import { messages } from '@/lib/i18n/messages';

const denial = (policyId: string | null, policies: string, key = 'denied.policy') => ({
  policyId,
  summary: `Denied GET /api/x: models needs write by policy "${policies}"`,
  text: { key, params: { route: 'GET /api/x', service: 'models', required: 'write', policies } },
});

const KNOWN = new Map([['p-live', 'Contractors cannot write']]);

describe('deletedPolicyOf', () => {
  it('finds the policy of a denial when the center\'s list no longer has it', () => {
    expect(deletedPolicyOf(denial('p-gone', 'p-gone'), KNOWN)).toEqual({ policyId: 'p-gone', name: null });
  });

  it('carries the name the trail stored for it', () => {
    expect(deletedPolicyOf(denial('p-gone', 'p-gone'), KNOWN, new Map([['p-gone', 'Block deletes']]))).toEqual({ policyId: 'p-gone', name: 'Block deletes' });
  });

  it('has nothing to say about a policy that exists', () => {
    expect(deletedPolicyOf(denial('p-live', 'Contractors cannot write'), KNOWN)).toBeNull();
  });

  it('has nothing to say when the list of policies is not known', () => {
    expect(deletedPolicyOf(denial('p-gone', 'p-gone'), null)).toBeNull();
  });

  it('has nothing to say about a denial that is not by a policy', () => {
    expect(deletedPolicyOf(denial(null, ''), KNOWN)).toBeNull();
    expect(deletedPolicyOf(denial('p-gone', '', 'denied.noRule'), KNOWN)).toBeNull();
    expect(deletedPolicyOf({ policyId: 'p-gone', text: null }, KNOWN)).toBeNull();
  });
});

describe('deletedPolicyIds', () => {
  it('lists each policy that is gone once, in first-seen order', () => {
    const items = [denial('p-b', 'p-b'), denial('p-live', 'Contractors cannot write'), denial('p-a', 'p-a'), denial('p-b', 'p-b'), denial(null, '')];
    expect(deletedPolicyIds(items, KNOWN)).toEqual(['p-b', 'p-a']);
  });

  it('lists none when the list of policies is not known', () => {
    expect(deletedPolicyIds([denial('p-b', 'p-b')], null)).toEqual([]);
    expect(deletedPolicyIds([], KNOWN)).toEqual([]);
  });
});

describe('storedPolicyNames', () => {
  const change = (policyId: string | null, name: unknown) => ({
    policyId,
    text: name === undefined ? null : { key: 'policy.updated', params: { name: name as string } },
  });

  it('keeps the newest name of each policy (the trail is newest first)', () => {
    const names = storedPolicyNames([change('p-a', 'Newest'), change('p-b', 'B'), change('p-a', 'Older'), change('p-a', 'Oldest')]);
    expect(names.get('p-a')).toBe('Newest');
    expect(names.get('p-b')).toBe('B');
  });

  it('reads on past a row that carries no name', () => {
    expect(storedPolicyNames([change('p-a', ''), change('p-a', '   '), change('p-a', undefined), change('p-a', 'Earlier name')]).get('p-a')).toBe('Earlier name');
  });

  it('skips rows that are not about a policy', () => {
    expect([...storedPolicyNames([change(null, 'Nobody')]).keys()]).toEqual([]);
  });
});

describe('withPolicySlot', () => {
  it('marks where the policy goes in the sentence the server wrote', () => {
    const marked = withPolicySlot(denial('p-gone', 'p-gone'), 'p-gone');
    expect(marked?.text?.params.policies).toBe(POLICY_SLOT);
    // The rest of the denial is untouched.
    expect(marked?.text?.params.route).toBe('GET /api/x');
  });

  it('marks only that policy when the denial names several', () => {
    const marked = withPolicySlot(denial('p-gone', 'Block deletes", "p-gone'), 'p-gone');
    expect(marked?.text?.params.policies).toBe(`Block deletes", "${POLICY_SLOT}`);
  });

  it('does nothing when the server already wrote a name there', () => {
    expect(withPolicySlot(denial('p-gone', 'Block deletes'), 'p-gone')).toBeNull();
  });

  it('does nothing for a denial that is not by a policy', () => {
    expect(withPolicySlot(denial('p-gone', 'p-gone', 'denied.noRule'), 'p-gone')).toBeNull();
    expect(withPolicySlot({ summary: 'x', text: null }, 'p-gone')).toBeNull();
  });
});

describe('the sentence around the slot', () => {
  const t = (locale: 'en' | 'tr') => {
    const lookup = (key: string, values: Record<string, string | number | undefined | null> = {}) => {
      let node: unknown = messages[locale].iamAudit;
      for (const part of key.split('.')) node = (node as Record<string, unknown> | undefined)?.[part];
      return typeof node === 'string' ? node.replace(/\{(\w+)\}/g, (m, name) => String(values[name] ?? m)) : `iamAudit.${key}`;
    };
    return lookup;
  };
  const tCenter = () => '';

  it.each([
    ['en', 'Denied GET /api/x: models needs write by policy "', '"'],
    ['tr', 'Reddedildi GET /api/x: models için "', '" politikası nedeniyle write izni gerekiyor'],
  ] as const)('is cut in two at the policy, in %s', (locale, before, after) => {
    const marked = withPolicySlot(denial('p-gone', 'p-gone'), 'p-gone')!;
    const sentence = formatAuditText(marked, t(locale) as never, tCenter as never);
    expect(splitAtPolicySlot(sentence)).toEqual([before, after]);
  });

  it('is not cut when the sentence has no place for it', () => {
    expect(splitAtPolicySlot('Denied GET /api/x')).toBeNull();
    expect(splitAtPolicySlot(`${POLICY_SLOT}a${POLICY_SLOT}`)).toBeNull();
  });
});
