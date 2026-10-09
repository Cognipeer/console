import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';

const SRC = join(__dirname, '..', '..');

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

const NAMESPACES = {
  iamPrincipals: [
    'components/iam/principals/PrincipalsTab.tsx',
    'components/iam/principals/PrincipalDetailDrawer.tsx',
    'components/iam/principals/PrincipalPicker.tsx',
    'components/iam/principals/AttachedPolicies.tsx',
    'components/iam/principals/EffectivePermissions.tsx',
  ],
  iamAudit: ['components/iam/audit/AuditTab.tsx'],
} as const;

type Namespace = keyof typeof NAMESPACES;

const en = (ns: Namespace) => flatten(messages.en[ns] as Tree);
const tr = (ns: Namespace) => flatten(messages.tr[ns] as Tree);

describe.each(Object.keys(NAMESPACES) as Namespace[])('%s messages', (ns) => {
  it('has the same keys in English and Turkish', () => {
    expect([...tr(ns).keys()].sort()).toEqual([...en(ns).keys()].sort());
  });

  it('has the same placeholders in both languages and no empty text', () => {
    for (const [key, text] of en(ns)) {
      const turkish = tr(ns).get(key);
      expect(text.trim(), `${ns}.${key} (en) is empty`).not.toBe('');
      expect(turkish?.trim(), `${ns}.${key} (tr) is empty`).not.toBe('');
      expect(placeholders(turkish ?? ''), `${ns}.${key} placeholders`).toEqual(placeholders(text));
    }
  });

  it('is actually translated (no key is left in English)', () => {
    // Words that are legitimately the same in both languages.
    const SAME = /^(API token|Cedar policy|ID|CSV|IP|Token|Politika|LDAP|SSO \((OIDC|SAML)\))$/i;
    const untranslated = [...en(ns)].filter(([key, text]) => tr(ns).get(key) === text && !SAME.test(text));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });

  it('defines every message the components ask for with a literal key', () => {
    const keys = en(ns);
    const missing: string[] = [];
    for (const file of NAMESPACES[ns]) {
      const source = readFileSync(join(SRC, file), 'utf8');
      // t('some.key'…) and translateOr(t, NS, 'some.key', …) — dynamic (template) keys are checked below.
      for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
        if (!keys.has(match[1]!)) missing.push(`${file}: ${match[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('message families built from a value', () => {
  const principals = en('iamPrincipals');
  const audit = en('iamAudit');
  const has = (map: Map<string, string>, prefix: string, values: string[]) =>
    values.filter((v) => !map.has(`${prefix}.${v}`)).map((v) => `${prefix}.${v}`);

  it('covers every principal type, level, source kind and policy state', () => {
    expect([
      ...has(principals, 'segments', ['user', 'group', 'token']),
      ...has(principals, 'types', ['user', 'group', 'token']),
      ...has(principals, 'hint', ['user', 'group', 'token']),
      ...has(principals, 'search', ['user', 'group', 'token']),
      ...has(principals, 'empty.none', ['user', 'group', 'token']),
      ...has(principals, 'roles', ['owner', 'admin', 'project_admin', 'user']),
      ...has(principals, 'statuses', ['active', 'disabled', 'invited', 'expired', 'revoked', 'no_login']),
      ...has(principals, 'drawer.levels', ['none', 'read', 'write', 'admin']),
      ...has(principals, 'drawer.sources.kind', ['role', 'direct', 'group', 'token-scope', 'project', 'policy', 'other']),
      ...has(principals, 'drawer.sources.hint', ['role', 'direct', 'group', 'token-scope', 'project', 'policy', 'other']),
      ...has(principals, 'drawer.policies.effect', ['permit', 'forbid', 'mixed']),
      ...has(principals, 'drawer.policies.mode', ['monitor', 'enforce']),
      ...has(principals, 'drawer.policies.reach', ['everyone', 'anyUser', 'anyToken', 'direct', 'group', 'viaOwner', 'raw']),
      ...has(principals, 'drawer.projects.role', ['project_admin', 'member']),
    ]).toEqual([]);
  });

  it('covers every audit view, action, code and filter preset', () => {
    expect([
      ...has(audit, 'segments', ['denials', 'changes', 'monitor']),
      ...has(audit, 'hint', ['denials', 'changes', 'monitor']),
      ...has(audit, 'empty.denials', ['title', 'hint']),
      ...has(audit, 'empty.changes', ['title', 'hint']),
      ...has(audit, 'empty.monitor', ['title', 'hint', 'manageHint']),
      ...has(audit, 'actions', ['read', 'write', 'admin', 'security']),
      ...has(audit, 'codes', ['forbidden', 'route_not_declared', 'ip_not_allowed']),
      ...has(audit, 'filters.presets', ['today', 'week', 'month']),
    ]).toEqual([]);
  });
});
