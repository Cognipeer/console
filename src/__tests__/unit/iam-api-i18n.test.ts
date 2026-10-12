/**
 * Every label key the Authorization center API hands to the UI resolves, in
 * English and in Turkish: services, actions, resource types, managed policies,
 * the error codes the API returns, the codes of the policy compiler's issues, the
 * sentences of the audit feed and the codes of its denials. A key that does not
 * resolve would render as a raw key in the center.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '@/lib/iam/catalog';
import { listManagedPolicyViews } from '@/lib/iam/policyRows';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

const resolve = (messages: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages);

const locales = { en, tr } as const;

describe.each(Object.entries(locales))('iamApi labels [%s]', (_name, messages) => {
  const catalog = buildCatalog();

  it('resolves every service label key', () => {
    for (const s of catalog.services) {
      expect(typeof resolve(messages, s.labelKey), s.labelKey).toBe('string');
    }
  });

  it('resolves every action label key (groups, service levels, resource verbs)', () => {
    const seen = new Set<string>();
    for (const a of catalog.actions) {
      if (seen.has(a.labelKey)) continue;
      seen.add(a.labelKey);
      expect(typeof resolve(messages, a.labelKey), a.labelKey).toBe('string');
    }
    expect(seen.size).toBeGreaterThanOrEqual(3 + 3 + 6);
  });

  it('resolves every resource type label key', () => {
    for (const t of catalog.resourceTypes) {
      expect(typeof resolve(messages, t.labelKey), t.labelKey).toBe('string');
    }
  });

  it('resolves the name and description of every managed policy', () => {
    const views = listManagedPolicyViews();
    expect(views).toHaveLength(16);
    for (const v of views) {
      expect(typeof resolve(messages, v.nameKey), v.nameKey).toBe('string');
      expect(typeof resolve(messages, v.descriptionKey), v.descriptionKey).toBe('string');
      expect(v.name).toBeTruthy();
      expect(v.description).toBeTruthy();
    }
  });

  it('has a message for every error code the API can return', () => {
    const codes = [
      'validation', 'not_found', 'conflict', 'limit_reached', 'rate_limited', 'permit_requires_admin', 'principal_not_found', 'resource_not_found', 'engine_unavailable',
      'authorization_unavailable', 'invalid_cursor', 'invalid_type', 'invalid_kind', 'invalid_date', 'invalid_principal', 'invalid_service', 'invalid_project', 'internal',
    ];
    for (const code of codes) expect(typeof resolve(messages, `iamApi.errors.${code}`), code).toBe('string');
  });
});

describe('iamApi english text matches what the API sends', () => {
  it('uses the same managed policy wording', () => {
    for (const v of listManagedPolicyViews()) {
      const key = v.nameKey.replace(/\.name$/, '');
      expect(resolve(en, `${key}.name`)).toBe(v.name);
      expect(resolve(en, `${key}.description`)).toBe(v.description);
    }
  });
});

// ── the sentences the API sends as data ─────────────────────────────────────

const ROOT = process.cwd();
const sourceOf = (file: string) => readFileSync(join(ROOT, file), 'utf8');
const uniq = (items: Iterable<string>) => [...new Set(items)].sort();

describe.each(Object.entries(locales))('issues the policy compiler can raise [%s]', (_name, messages) => {
  it('has a sentence for every issue code (so the editor words it in the reader\'s language)', () => {
    const codes = uniq([...sourceOf('src/lib/iam/policySpec.ts').matchAll(/\bcode: '([a-z_]+)'/g)].map((m) => m[1]));
    // the scan itself must see the codes it is meant to (an empty scan would pass vacuously)
    expect(codes).toEqual(expect.arrayContaining([
      'not_enforced_actions', 'partly_enforced_actions', 'admin_checked_as_write', 'trusted_proxies_unset', 'not_asked_actions', 'partly_not_asked_actions',
      'portal_access_list_grants', 'partly_portal_access_list_grants', 'portal_wrong_channel', 'portal_wrong_scope',
    ]));
    const missing = codes.filter((code) => typeof resolve(messages, `iamCenter.issueCodes.${code}`) !== 'string');
    expect(missing).toEqual([]);
  });

  it('keeps the placeholders of the English sentence in the translation too', () => {
    const tokens = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const codes = ['admin_checked_as_write', 'not_asked_actions', 'partly_not_asked_actions'];
    for (const code of codes) {
      expect(tokens(resolve(messages, `iamCenter.issueCodes.${code}`) as string), code).toEqual(tokens(resolve(en, `iamCenter.issueCodes.${code}`) as string));
    }
    // what the API sends as params for the new codes is what the sentence interpolates
    expect(tokens(resolve(messages, 'iamCenter.issueCodes.not_asked_actions') as string).every((t) => ['actions', 'effect'].includes(t))).toBe(true);
    expect(tokens(resolve(messages, 'iamCenter.issueCodes.partly_not_asked_actions') as string).every((t) => ['actions'].includes(t))).toBe(true);
  });
});

describe.each(Object.entries(locales))('audit feed sentences [%s]', (_name, messages) => {
  it('has a sentence for every key the feed emits', () => {
    const source = sourceOf('src/lib/iam/auditFeed.ts');
    const literal = [...source.matchAll(/\btext\s*[:=]\s*\{\s*key: '([A-Za-z.]+)'/g)].map((m) => m[1]);
    const denied = ['policy', 'tokenScope', 'project', 'noRule'].map((reason) => `denied.${reason}`); // key: `denied.${reason}`
    const portal = ['portalUse', 'portalUsePolicy', 'portalInvoke', 'portalInvokePolicy'].map((key) => `denied.${key}`); // a refusal of the portal runtime
    const ip = ['ipNotAllowed', 'ipNotAllowedAt']; // key: row.path ? 'ipNotAllowedAt' : 'ipNotAllowed'
    // a call that tried to act for a person and was refused: one sentence per typed reason (DELEGATION_SENTENCES)
    const delegation = [...source.matchAll(/'(delegationRefused\.[A-Za-z]+)'/g)].map((m) => m[1]);
    expect(delegation.length).toBeGreaterThanOrEqual(12);
    const keys = uniq([...literal, ...denied, ...portal, ...ip, ...delegation]);
    expect(keys).toEqual(expect.arrayContaining(['undeclared', 'unavailable', 'ipNotAllowed', 'policy.created', 'policy.updated', 'policy.deleted', 'settings.updated', 'token.restrictions', 'denied.noRule']));
    const missing = keys.filter((key) => typeof resolve(messages, `iamAudit.summaries.${key}`) !== 'string');
    expect(missing).toEqual([]);
  });

  it('words a denial with no named level too (the sentences without the required level)', () => {
    for (const reason of ['policy', 'tokenScope', 'project', 'noRule']) {
      expect(typeof resolve(messages, `iamAudit.summaries.denied.${reason}NoLevel`), reason).toBe('string');
    }
  });

  it('names every code a denial can carry, "authorization unavailable" included', () => {
    for (const code of ['forbidden', 'route_not_declared', 'ip_not_allowed', 'authorization_unavailable', 'delegation_refused']) {
      expect(typeof resolve(messages, `iamAudit.codes.${code}`), code).toBe('string');
    }
  });

  it('has nothing left to say about modes: the audit has two views, denials and changes', () => {
    expect(Object.keys(resolve(messages, 'iamAudit.segments') as object).filter((k) => k !== 'label').sort()).toEqual(['changes', 'denials']);
    expect(resolve(messages, 'iamAudit.summaries.mode')).toBeUndefined();
    expect(resolve(messages, 'iamAudit.summaries.monitor')).toBeUndefined();
  });
});
