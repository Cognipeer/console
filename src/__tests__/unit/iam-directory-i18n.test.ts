/**
 * The `iamDirectory` (people and access) and `accountPage` namespaces: English
 * and Turkish carry the same keys with the same placeholders, every message the
 * components ask for exists, and the old wording is gone for good.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '@/lib/i18n/messages';
import { KNOWN_ERROR_CODES } from '@/components/iam/principals/errors';
import { BULK_CODE_LIST } from '@/components/iam/principals/useBulkFlow';
import { PEOPLE_ERROR_CODES } from '@/lib/iam/identity';

const ROOT = path.resolve(__dirname, '../../..');

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(full, value);
    else for (const [k, v] of flatten(value, full)) out.set(k, v);
  }
  return out;
}

const NAMESPACES = ['iamDirectory', 'accountPage'] as const;
type Namespace = (typeof NAMESPACES)[number];
const en = (ns: Namespace) => flatten((messages.en as unknown as Record<string, Tree>)[ns]!);
const tr = (ns: Namespace) => flatten((messages.tr as unknown as Record<string, Tree>)[ns]!);
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe.each(NAMESPACES)('%s messages', (ns) => {
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
    const SAME = /^(LDAP|SSO \((OIDC|SAML)\)|CSV|ID|API token|Token|ci-pipeline|\{\w+\}[\s:→-]*(\{\w+\})?)$/i;
    const untranslated = [...en(ns)].filter(([key, text]) => tr(ns).get(key) === text && !SAME.test(text));
    expect(untranslated.map(([key]) => key)).toEqual([]);
  });

  it('addresses the reader formally in Turkish, like the rest of the product (sizin/siz, never senin/sen)', () => {
    // the informal forms that slipped in once: "Bunu yapmaya iznin yok." instead of "Bunu yapma izniniz yok."
    // (`\b` does not know Turkish letters, so the word edges are spelled out: "yapamazsınız" is formal, "yapamazsın" is not)
    const INFORMAL = /(?<![\p{L}])(iznin yok|yapabilirsin|edebilirsin|görebilirsin|seçebilirsin|istersen|sana|senin|seni|yapamazsın|değiştiremezsin)(?![\p{L}])/iu;
    for (const [key, text] of tr(ns)) expect(text, `${ns}.${key}`).not.toMatch(INFORMAL);
  });

  it('never calls an account that cannot sign in a "programmatic user"', () => {
    for (const map of [en(ns), tr(ns)]) {
      for (const [key, text] of map) expect(text, `${ns}.${key}`).not.toMatch(/programmat|programatik/i);
    }
  });
});

// ── every message the components ask for exists ────────────────────────────

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const SCANNED = [
  ...sourceFiles(path.join(ROOT, 'src/components/iam/principals')),
  ...sourceFiles(path.join(ROOT, 'src/components/account')),
  path.join(ROOT, 'src/app/dashboard/account/page.tsx'),
  path.join(ROOT, 'src/app/dashboard/tokens/page.tsx'),
  path.join(ROOT, 'src/components/layout/launcher/TopbarV2.tsx'),
];

/** Where a translator is a parameter, not a hook: the namespace its callers pass. */
const PARAM_DEFAULTS: Record<string, Record<string, string>> = {
  'detailParts.tsx': { t: 'iamPrincipals' },
  'PersonSections.tsx': { t: 'iamPrincipals' },
  'GroupMembersSection.tsx': { t: 'iamPrincipals' },
  'errors.tsx': { t: 'iamDirectory' },
};

interface Use {
  file: string;
  ns: string;
  key: string;
}

function collect(): { statics: Use[]; templates: Use[] } {
  const statics: Use[] = [];
  const templates: Use[] = [];
  for (const file of SCANNED) {
    const source = readFileSync(file, 'utf8');
    const consts = new Map<string, string>();
    for (const m of source.matchAll(/\bconst\s+(\w+)\s*=\s*'([^']+)';/g)) consts.set(m[1]!, m[2]!);
    const bindings = new Map<string, string>();
    for (const m of source.matchAll(/\bconst\s+(\w+)\s*=\s*useTranslations\(\s*(?:'([^']+)'|(\w+))\s*\)/g)) {
      bindings.set(m[1]!, m[2] ?? consts.get(m[3]!) ?? '');
    }
    const base = path.basename(file);
    for (const [name, ns] of Object.entries(PARAM_DEFAULTS[base] ?? {})) if (!bindings.has(name)) bindings.set(name, ns);
    if (!bindings.has('td')) bindings.set('td', 'iamDirectory');
    for (const [name, ns] of bindings) {
      if (ns !== 'iamDirectory' && ns !== 'accountPage') continue;
      const lit = new RegExp(`\\b${name}\\(\\s*'([^']+)'`, 'g');
      for (const m of source.matchAll(lit)) statics.push({ file: base, ns, key: m[1]! });
      const tpl = new RegExp(`\\b${name}\\(\\s*\`([^\`]+)\``, 'g');
      for (const m of source.matchAll(tpl)) templates.push({ file: base, ns, key: m[1]! });
    }
  }
  return { statics, templates };
}

describe('keys used by the components', () => {
  const { statics, templates } = collect();

  it('finds the calls it is meant to check', () => {
    expect(statics.length).toBeGreaterThan(300);
    expect(templates.length).toBeGreaterThan(30);
  });

  it('every static key exists', () => {
    const missing = statics
      .filter((u) => !en(u.ns as Namespace).has(u.key))
      .map((u) => `${u.file}: ${u.ns}.${u.key}`);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('every computed key matches messages of its namespace', () => {
    const unmatched = templates
      .filter((u) => {
        const pattern = new RegExp(`^${u.key.replace(/[.]/g, '\\.').replace(/\$\{[^}]+\}/g, '[^.]+')}$`);
        return ![...en(u.ns as Namespace).keys()].some((k) => pattern.test(k));
      })
      .map((u) => `${u.file}: ${u.ns}.${u.key}`);
    expect([...new Set(unmatched)]).toEqual([]);
  });
});

describe('message families built from a value', () => {
  const d = en('iamDirectory');
  const missing = (prefix: string, values: readonly string[]) =>
    values.filter((v) => !d.has(`${prefix}.${v}`)).map((v) => `${prefix}.${v}`);

  it('covers every role, kind, source, status and level', () => {
    expect([
      ...missing('roles', ['owner', 'admin', 'project_admin', 'user']),
      ...missing('roles.hints', ['owner', 'admin', 'project_admin', 'user']),
      ...missing('badges.kinds', ['person', 'service']),
      ...missing('badges.sources', ['local', 'directory', 'ldap', 'oidc', 'saml']),
      ...missing('badges.statuses', ['active', 'disabled', 'invited', 'expired']),
      ...missing('matrix.levels', ['none', 'read', 'write', 'admin']),
      ...missing('project.roles', ['member', 'project_admin']),
      ...missing('filters.scoped', ['true', 'false']),
      ...missing('filters.sorts', ['name', 'email', 'createdAt']),
    ]).toEqual([]);
  });

  it('words every reason an action can be unavailable', () => {
    expect(
      missing('reasons', ['forbidden', 'self', 'owner_immutable', 'higher_privileges', 'directory_managed', 'no_pending_invite', 'account_disabled']),
    ).toEqual([]);
  });

  it('words every code the people endpoints answer with, and every code the UI itself knows', () => {
    expect(missing('errors', PEOPLE_ERROR_CODES)).toEqual([]);
    expect(missing('errors', KNOWN_ERROR_CODES)).toEqual([]);
  });

  it('words every bulk action and every reason an item is skipped', () => {
    expect(missing('bulk.actions', ['disable', 'enable', 'revoke-tokens', 'add-to-group', 'remove-from-group', 'revokeTokens'])).toEqual([]);
    expect(missing('bulk.codes', BULK_CODE_LIST)).toEqual([]);
  });

  it('words every item of the add menu', () => {
    const items = ['person', 'service', 'import', 'group', 'token'];
    expect(items.flatMap((i) => [`add.items.${i}.label`, `add.items.${i}.hint`]).filter((k) => !d.has(k))).toEqual([]);
  });

  it('words the checks of the password form and the roles of the account page', () => {
    const a = en('accountPage');
    const need = [
      ...['length', 'upper', 'lower', 'digit', 'special'].map((r) => `password.rule.${r}`),
      ...['owner', 'admin', 'project_admin', 'user'].map((r) => `roles.${r}`),
      ...['local', 'ldap', 'oidc', 'saml'].map((p) => `providers.${p}`),
    ];
    expect(need.filter((k) => !a.has(k))).toEqual([]);
  });
});

describe('the retired wording is gone from the shared messages', () => {
  const english = JSON.stringify(messages.en);
  const turkish = JSON.stringify(messages.tr);

  it('has no old people namespaces and no "open in members" action', () => {
    const settings = (messages.en as unknown as { settings: Record<string, unknown> }).settings;
    expect(settings).not.toHaveProperty('userManagement');
    expect(settings).not.toHaveProperty('addUserModal');
    expect(english).not.toContain('Open in Members');
    expect(turkish).not.toContain('Üyeler\'de aç');
  });

  it('says "service account", never "programmatic user", for an account that cannot sign in', () => {
    expect(english).not.toMatch(/programmatic user/i);
    expect(english).not.toContain('Programmatic');
    expect(turkish).not.toMatch(/programatik kullan/i);
  });
});
