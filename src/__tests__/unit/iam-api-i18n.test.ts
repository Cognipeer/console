/**
 * Every label key the Authorization center API hands to the UI resolves, in
 * English and in Turkish: services, actions, resource types, managed policies and
 * the error codes the API returns. A key that does not resolve would render as a
 * raw key in the center.
 */
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
    expect(views).toHaveLength(12);
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
      'invalid_cursor', 'invalid_type', 'invalid_kind', 'invalid_date', 'invalid_principal', 'invalid_service', 'invalid_project', 'internal',
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
