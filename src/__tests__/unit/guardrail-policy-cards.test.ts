/**
 * THE CARD GRID AND THE CATALOG, pinned.
 *
 * Two screens are under test, and both exist to keep one promise: adding a
 * tenth policy family is ONE entry in `catalog/families.ts` and no UI change at
 * all. Every way that promise can break is silent in its own way:
 *
 *  · A family the catalog picker does not list is a family an operator cannot
 *    add. That is not hypothetical — the engine shipped four families
 *    (patterns, credentials, tool access, webhook) that no screen offered, so
 *    they could only be configured by writing to the API by hand.
 *  · A card that renders a family name it wrote down itself agrees with the
 *    catalog exactly until the day it does not, and the day it does not is a
 *    card describing one thing while the engine runs another.
 *  · A search that walks a per-family switch answers "no results" for the
 *    tenth family's configuration, which is indistinguishable from "you have
 *    no such policy" — so the operator writes the rule a second time.
 *  · A search that walks EVERYTHING indexes the token somebody pasted into a
 *    webhook header. A search index is still a place a secret gets copied to.
 *  · A duplicate that copies nested state by reference gives two policies one
 *    array. Editing either moves both, and nothing says so until a guardrail
 *    blocks traffic the operator thought they had scoped to one hook.
 *
 * The strongest guard here is the SOURCE SCAN at the bottom: both components
 * are read off disk and checked for any family id or family label appearing as
 * a literal. It is the one check that fails when someone solves a problem by
 * typing a family name into the UI, which is how every one of the above starts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  describePolicyCard,
  duplicatePolicy,
  filterPolicyCards,
  nextPolicyId,
  policyCardName,
  policyCardSearchText,
  policyFamilyLabel,
  unboundHooks,
} from '@/components/guardrails/GuardrailPolicyCards';
import {
  FALLBACK_POLICY_ICON,
  POLICY_CATALOG_GROUP_META,
  catalogGroupMeta,
  catalogSections,
  describeCatalogEntry,
  hasRegisteredIcon,
  policyFamilyIcon,
} from '@/components/guardrails/PolicyCatalogModal';
import {
  POLICY_CATALOG_GROUPS,
  catalogEntries,
  catalogFor,
  defaultPolicy,
  summarisePolicy,
} from '@/lib/services/guardrail/catalog';
import type { PolicyCatalogGroup } from '@/lib/services/guardrail/catalog';
import {
  HOOK_IDS,
  POLICY_FAMILIES,
  POLICY_VALID_HOOKS,
} from '@/lib/services/guardrail/hooks/contract';
import { canBindToHook, familyLabel, familyMeta } from '@/components/guardrails/policyFamilyMeta';
import type {
  CustomPolicyConfig,
  GuardrailPolicy,
  HookBinding,
  HookId,
  ModerationPolicyConfig,
  PiiPolicyConfig,
  PolicyFamily,
  RegexPolicyConfig,
  SecretsPolicyConfig,
  ToolAccessPolicyConfig,
  WebhookPolicyConfig,
  WordFilterPolicyConfig,
} from '@/lib/services/guardrail/hooks/contract';

// ── fixtures ────────────────────────────────────────────────────────────────

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

/** The pair the whole card grid exists for: one family, two instances, two
 *  hooks, two different things to look for. */
const SQLI: RegexPolicyConfig = {
  id: 'regex:sqli',
  family: 'regex',
  enabled: true,
  hooks: ['tool.pre'],
  schedule: SYNC_BLOCK,
  label: 'SQL injection · tool args',
  action: 'block',
  rules: [
    {
      id: 'union-select',
      label: 'union select',
      pattern: '\\b(?:union\\s+select|;\\s*drop\\s+table)\\b',
      category: 'sqli',
      severity: 'high',
      maxMatchChars: 64,
    },
  ],
};

const INTERNAL_URL: RegexPolicyConfig = {
  id: 'regex:internal-url',
  family: 'regex',
  enabled: true,
  hooks: ['output.pre', 'output.stream.delta'],
  schedule: SYNC_BLOCK,
  label: 'Internal URL leak',
  action: 'redact',
  rules: [
    {
      id: 'internal-host',
      label: 'internal host',
      pattern: 'https?://[a-z0-9.-]+\\.internal\\b',
      category: 'internal_url',
      severity: 'high',
      maxMatchChars: 120,
    },
  ],
};

const LEGAL_WEBHOOK: WebhookPolicyConfig = {
  id: 'webhook:legal',
  family: 'webhook',
  enabled: true,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  label: 'Legal review',
  url: 'https://legal.example.com/evaluate?team=contracts',
  send: 'text',
  headers: {
    'x-authorization': 'Bearer zzztopsecrettoken',
    'x-region': 'eu-west',
  },
};

const CUSTOMER_PII: PiiPolicyConfig = {
  id: 'legacy:pii',
  family: 'pii',
  enabled: true,
  hooks: ['input.pre', 'output.stream.delta'],
  schedule: SYNC_BLOCK,
  piiPolicyKey: 'customer-records',
  detectObfuscated: true,
};

const BANNED_WORDS: WordFilterPolicyConfig = {
  id: 'words',
  family: 'word_filter',
  enabled: false,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  label: 'Banned wording',
  words: ['zzzforbiddenphrase'],
};

const TOOLS: ToolAccessPolicyConfig = {
  id: 'tools',
  family: 'tool_access',
  enabled: true,
  hooks: ['tool.pre'],
  schedule: SYNC_BLOCK,
  allow: ['files.read'],
  allowedDomains: ['zzzallowed.example.com'],
  argumentSchemas: {
    // The nested value is a real schema; only the ENUM entry is a marker, so
    // the test can tell "indexed the tool name" from "walked the whole schema".
    'files.read': {
      type: 'object',
      properties: { path: { type: 'string', enum: ['zzznestedschema'] } },
    },
  },
  maxArgDepth: 12,
};

const ENTROPY: SecretsPolicyConfig = {
  id: 'creds',
  family: 'secrets',
  enabled: true,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  genericHighEntropy: true,
  minEntropy: 4.25,
  allowValues: ['zzzdocumentationsample'],
};

const OFF_TOPIC: CustomPolicyConfig = {
  id: 'off-topic',
  family: 'custom',
  enabled: true,
  hooks: ['input.pre'],
  schedule: SYNC_BLOCK,
  modelKey: 'zzzjudgemodel',
  prompt: 'Flag anything that promises a zzzdeliverydate.',
  onMissingModel: 'error_finding',
};

const HARMFUL: ModerationPolicyConfig = {
  id: 'harmful',
  family: 'moderation',
  enabled: true,
  hooks: ['input.pre'],
  schedule: SYNC_BLOCK,
  modelKey: 'zzzclassifier',
  categories: { zzzcategorykey: true },
};

const ALL: GuardrailPolicy[] = [
  SQLI,
  INTERNAL_URL,
  LEGAL_WEBHOOK,
  CUSTOMER_PII,
  BANNED_WORDS,
  TOOLS,
  ENTROPY,
  OFF_TOPIC,
  HARMFUL,
];

const ids = (policies: GuardrailPolicy[]): string[] => policies.map((policy) => policy.id);

// ── the catalog covers the engine ───────────────────────────────────────────

describe('the catalog picker covers every family', () => {
  it('lists every family the engine knows about, exactly once', () => {
    const listed = catalogSections('').flatMap((section) =>
      section.entries.map((spec) => spec.family),
    );
    expect([...listed].sort()).toEqual([...POLICY_FAMILIES].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('renders every catalog entry and nothing else', () => {
    const listed = catalogSections('').flatMap((section) => section.entries);
    expect(listed).toEqual(catalogEntries());
  });

  it('orders the shelves the way the catalog does, and the cards within a shelf by their own order', () => {
    const sections = catalogSections('');
    const groupOrder = sections.map((section) => section.group);
    expect(groupOrder).toEqual(
      POLICY_CATALOG_GROUPS.filter((group) => groupOrder.includes(group)),
    );

    for (const section of sections) {
      const orders = section.entries.map((spec) => spec.catalog.order);
      expect(orders).toEqual([...orders].sort((a, b) => a - b));
      for (const spec of section.entries) expect(spec.catalog.group).toBe(section.group);
    }
  });

  it('gives every shelf a heading and a line of copy', () => {
    for (const section of catalogSections('')) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
    }
  });

  it('names every group the catalog declares, and degrades on one it has not met', () => {
    for (const group of POLICY_CATALOG_GROUPS) {
      const meta = POLICY_CATALOG_GROUP_META[group];
      expect(meta).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
    }
    // A fifth shelf is a compile error on the map above; at runtime it still has
    // to render rather than throw inside a click handler.
    const unknown = catalogGroupMeta('brand_new_shelf' as PolicyCatalogGroup);
    expect(unknown.label).toBe('Brand new shelf');
    expect(() => catalogGroupMeta('brand_new_shelf' as PolicyCatalogGroup)).not.toThrow();
  });
});

// ── searching the catalog ───────────────────────────────────────────────────

describe('searching the catalog', () => {
  /** Picks a keyword straight out of the catalog rather than naming a family,
   *  so this test cannot fall behind the entries it is checking. */
  const entryWithKeyword = (keyword: string) =>
    catalogEntries().find((spec) => spec.catalog.keywords.includes(keyword));

  it('finds a family by a keyword it never shows on the card', () => {
    for (const keyword of ['gdpr', 'jailbreak', 'ssrf']) {
      const expected = entryWithKeyword(keyword);
      expect(expected, `no catalog entry claims the keyword ${keyword}`).toBeDefined();
      const found = catalogSections(keyword).flatMap((section) =>
        section.entries.map((spec) => spec.family),
      );
      expect(found).toContain(expected?.family);
    }
  });

  it('finds a family by its label and by its description', () => {
    const first = catalogEntries()[0];
    expect(first).toBeDefined();
    const byLabel = catalogSections(first.label).flatMap((section) => section.entries);
    expect(byLabel.map((spec) => spec.family)).toContain(first.family);
  });

  it('drops a shelf with no match instead of rendering an empty heading', () => {
    const sections = catalogSections('gdpr');
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) expect(section.entries.length).toBeGreaterThan(0);
    expect(sections.length).toBeLessThan(catalogSections('').length);
  });

  it('returns nothing at all for a query nothing matches, so the screen can say so', () => {
    expect(catalogSections('zzznothingmatchesthis')).toEqual([]);
  });
});

// ── icons ───────────────────────────────────────────────────────────────────

describe('family icons', () => {
  it('resolves an icon for every catalog entry', () => {
    for (const spec of catalogEntries()) {
      const icon = policyFamilyIcon(spec.icon);
      expect(icon, `${spec.family} has no icon`).toBeTruthy();
      expect(['function', 'object']).toContain(typeof icon);
    }
  });

  it('falls back rather than rendering nothing for an icon name nobody registered', () => {
    // THE TENTH-FAMILY CASE. A new family naming a glyph this registry has not
    // been taught still gets a card — the icon is the one part of a catalog
    // entry that cannot be data, and a missing glyph must not be what keeps a
    // family unreachable.
    expect(policyFamilyIcon('a-glyph-nobody-registered')).toBe(FALLBACK_POLICY_ICON);
    expect(policyFamilyIcon(undefined)).toBe(FALLBACK_POLICY_ICON);
    expect(policyFamilyIcon('')).toBe(FALLBACK_POLICY_ICON);
    expect(hasRegisteredIcon('a-glyph-nobody-registered')).toBe(false);
  });

  it('describes a catalog card entirely from its spec', () => {
    for (const spec of catalogEntries()) {
      const view = describeCatalogEntry(spec);
      expect(view.label).toBe(spec.label);
      expect(view.description).toBe(spec.description);
      expect(view.color).toBe(spec.color);
      expect(view.group).toBe(spec.catalog.group);
      // Read from the contract by the catalog, and never restated by the card.
      expect(view.hooks).toEqual(POLICY_VALID_HOOKS[spec.family]);
      expect(view.streamSafe).toBe(spec.streamSafe);
      expect(view.hooks.length).toBeGreaterThan(0);
    }
  });
});

// ── what picking a card produces ────────────────────────────────────────────

describe('picking a catalog card', () => {
  it('produces a policy of that family, from the catalog defaults', () => {
    for (const family of POLICY_FAMILIES) {
      const created = defaultPolicy(family);
      expect(created, `${family} has no defaults`).toBeDefined();
      if (!created) continue;
      expect(created.family).toBe(family);
      expect(created.id.length).toBeGreaterThan(0);
      expect(created.enabled).toBe(true);
      expect(created.hooks.length).toBeGreaterThan(0);
      for (const hook of created.hooks) {
        expect(POLICY_VALID_HOOKS[family]).toContain(hook);
      }
      // Never bound to the streaming hook on creation: it costs the caller
      // latency and needs a config that declares a bounded match length, so it
      // is a decision rather than a starting state.
      expect(created.hooks).not.toContain('output.stream.delta');
    }
  });

  it('gives the second policy of a family an id of its own', () => {
    // The flow the grid performs: the catalog seeds an id from the family name,
    // the grid mints a free one. Two policies sharing an id makes a finding
    // untraceable to the rule that raised it, and the server refuses the save.
    const family = POLICY_FAMILIES[0];
    const first = defaultPolicy(family);
    expect(first).toBeDefined();
    if (!first) return;

    const taken: string[] = [];
    const a = nextPolicyId(first.id, taken);
    taken.push(a);
    const b = nextPolicyId(first.id, taken);
    taken.push(b);
    const c = nextPolicyId(first.id, taken);

    expect(a).toBe(first.id);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('mints a free id near the seed', () => {
    expect(nextPolicyId('rule', [])).toBe('rule');
    expect(nextPolicyId('rule', ['rule'])).toBe('rule-2');
    expect(nextPolicyId('rule', ['rule', 'rule-2'])).toBe('rule-3');
    expect(nextPolicyId('  ', [])).toBe('policy');
  });
});

// ── search over the policies on the guardrail ───────────────────────────────

describe('searching the grid', () => {
  const finds = (term: string) => ids(filterPolicyCards(ALL, { query: term }));

  it('matches the name an operator gave the policy', () => {
    expect(finds('legal review')).toEqual(['webhook:legal']);
  });

  it('matches the family, by id and by the name the catalog gives it', () => {
    expect(finds('regex')).toEqual(['regex:sqli', 'regex:internal-url']);
    const label = policyFamilyLabel('webhook');
    expect(finds(label.toLowerCase())).toContain('webhook:legal');
  });

  it('matches a hook id', () => {
    expect(finds('tool.pre')).toEqual(['regex:sqli', 'tools']);
  });

  it('matches CONFIG CONTENT, which is what an operator actually remembers', () => {
    // Nobody remembers the name they gave a policy six weeks ago. They remember
    // the pattern, the host, the key and the word they typed.
    expect(finds('union')).toEqual(['regex:sqli']);
    expect(finds('legal.example.com')).toEqual(['webhook:legal']);
    expect(finds('customer-records')).toEqual(['legacy:pii']);
    expect(finds('zzzforbiddenphrase')).toEqual(['words']);
    expect(finds('zzzallowed.example.com')).toEqual(['tools']);
    expect(finds('zzzdocumentationsample')).toEqual(['creds']);
    expect(finds('zzzdeliverydate')).toEqual(['off-topic']);
    expect(finds('zzzjudgemodel')).toEqual(['off-topic']);
    expect(finds('zzzcategorykey')).toEqual(['harmful']);
  });

  it('never indexes the value of a field the schema marks secret', () => {
    const haystack = policyCardSearchText(LEGAL_WEBHOOK);
    // The header NAME is searchable — an operator does look for "which policy
    // sends that header?".
    expect(haystack).toContain('x-authorization');
    // Its value is not. A search index is still a place a token gets copied to,
    // and a token that matches a query is a token on somebody's screen.
    expect(haystack).not.toContain('zzztopsecrettoken');
    expect(finds('zzztopsecrettoken')).toEqual([]);
    // And the card's own summary never carries it either.
    expect(summarisePolicy(LEGAL_WEBHOOK)).not.toContain('zzztopsecrettoken');
  });

  it('indexes the names in a JSON field but not the schema vocabulary inside it', () => {
    const haystack = policyCardSearchText(TOOLS);
    expect(haystack).toContain('files.read');
    // Walking a map of JSON Schema documents would make `object`, `string` and
    // `required` match nearly every tool policy on the guardrail.
    expect(haystack).not.toContain('zzznestedschema');
  });

  it('does not index a bare number, which only ever matches by accident', () => {
    // With a substring haystack, a query of `12` would hit a nesting limit, a
    // match bound and a timeout on unrelated policies, and the one useful hit
    // would be somewhere in the middle of them.
    expect(TOOLS.maxArgDepth).toBe(12);
    expect(policyCardSearchText(TOOLS)).not.toContain('12');

    // A number the CARD says out loud is a different matter: it is on screen,
    // so an operator can reasonably search for it. That comes from the
    // catalog's summary line, not from walking the stored value.
    expect(summarisePolicy(ENTROPY)).toContain('4.25');
    expect(policyCardSearchText(ENTROPY)).toContain('4.25');
  });

  it('walks the field SCHEMA, not the stored object', () => {
    // A property no field declares is a property the form cannot show and the
    // engine does not read. Indexing it would let a search find a policy by a
    // value that has no effect on anything.
    const smuggled = { ...ENTROPY, undeclaredExtra: 'zzzsmuggledvalue' } as SecretsPolicyConfig;
    expect(policyCardSearchText(smuggled)).not.toContain('zzzsmuggledvalue');
  });

  it('narrows with every term rather than widening', () => {
    expect(finds('regex tool.pre')).toEqual(['regex:sqli']);
    expect(finds('regex output.pre')).toEqual(['regex:internal-url']);
  });

  it('is case-insensitive', () => {
    expect(finds('UNION')).toEqual(['regex:sqli']);
    expect(finds('Legal Review')).toEqual(['webhook:legal']);
    expect(finds('CUSTOMER-RECORDS')).toEqual(['legacy:pii']);
  });
});

describe('filtering the grid', () => {
  it('filters by family', () => {
    expect(ids(filterPolicyCards(ALL, { family: 'regex' }))).toEqual([
      'regex:sqli',
      'regex:internal-url',
    ]);
  });

  it('filters by hook', () => {
    expect(ids(filterPolicyCards(ALL, { hook: 'output.stream.delta' }))).toEqual([
      'regex:internal-url',
      'legacy:pii',
    ]);
  });

  it('combines a family, a hook and a query', () => {
    expect(
      ids(filterPolicyCards(ALL, { family: 'regex', hook: 'output.pre', query: 'internal' })),
    ).toEqual(['regex:internal-url']);
  });

  it('never reorders — the stored order IS the execution order', () => {
    expect(ids(filterPolicyCards(ALL, {}))).toEqual(ids(ALL));
    const reversed = [...ALL].reverse();
    expect(ids(filterPolicyCards(reversed, {}))).toEqual(ids(reversed));
  });

  it('returns everything for an empty query', () => {
    expect(filterPolicyCards(ALL, { query: '   ' })).toHaveLength(ALL.length);
  });
});

// ── the card itself ─────────────────────────────────────────────────────────

describe('the card', () => {
  it('takes its identity from the catalog and nowhere else', () => {
    for (const policy of ALL) {
      const spec = catalogFor(policy.family);
      const view = describePolicyCard(policy);
      expect(view.familyLabel).toBe(spec?.label);
      expect(view.color).toBe(spec?.color);
      expect(view.icon).toBe(spec?.icon);
      // The one line the grid exists for: what this policy is configured to DO.
      expect(view.summary).toBe(summarisePolicy(policy));
      expect(view.summary.length).toBeGreaterThan(0);
    }
  });

  it('never shows a nameless card', () => {
    expect(policyCardName(SQLI)).toBe('SQL injection · tool args');
    // No label of its own: the family plus the id, never an empty heading.
    const nameless = { ...SQLI, label: '   ' };
    expect(policyCardName(nameless)).toContain(policyFamilyLabel('regex'));
    expect(policyCardName(nameless)).toContain('regex:sqli');
  });

  it('says whether the action is the policy’s own or the guardrail’s', () => {
    const own = describePolicyCard(SQLI, { guardrailAction: 'warn' });
    expect(own.action).toBe('block');
    expect(own.actionInherited).toBe(false);

    const inherited = describePolicyCard(CUSTOMER_PII, { guardrailAction: 'warn' });
    expect(inherited.action).toBe('warn');
    expect(inherited.actionInherited).toBe(true);

    // Neither set: the engine's own default, not a blank badge.
    expect(describePolicyCard(CUSTOMER_PII).action).toBe('block');
  });

  it('distinguishes "no telemetry loaded" from "ran zero times"', () => {
    expect(describePolicyCard(SQLI).callsLabel).toBe('—');
    expect(describePolicyCard(SQLI, { calls: 0 }).callsLabel).toBe('0');
    expect(describePolicyCard(SQLI, { calls: 1500 }).callsLabel).toBe('1.5k');
    expect(describePolicyCard(SQLI, { calls: 2_400_000 }).callsLabel).toBe('2.4M');
  });

  it('keeps a disabled policy visible, and says it is disabled', () => {
    const view = describePolicyCard(BANNED_WORDS);
    expect(view.enabled).toBe(false);
    // Nothing in the view model hides it. Dimming happens in the card; hiding
    // is how someone concludes a rule was deleted and writes it a second time.
    expect(view.summary.length).toBeGreaterThan(0);
    expect(view.name).toBe('Banned wording');
  });

  it('marks a policy the migration lifted rather than one somebody authored', () => {
    expect(describePolicyCard(CUSTOMER_PII).migrated).toBe(true);
    expect(describePolicyCard(SQLI).migrated).toBe(false);
  });

  it('warns about a policy bound to no hook', () => {
    const orphan = { ...SQLI, hooks: [] as HookId[] };
    const view = describePolicyCard(orphan);
    expect(view.noHook).toBe(true);
    expect(view.hooks).toEqual([]);
  });

  describe('hook badges', () => {
    const bindings: Partial<Record<HookId, HookBinding>> = {
      'tool.pre': { enabled: true, schedule: SYNC_BLOCK },
      'output.pre': { enabled: false, schedule: SYNC_BLOCK },
      'output.stream.delta': { enabled: true, schedule: SYNC_BLOCK },
      'input.pre': { enabled: true, schedule: SYNC_BLOCK },
    };

    it('is neutral for a hook that actually runs', () => {
      const badge = describePolicyCard(SQLI, { bindings }).hooks[0];
      expect(badge.hook).toBe('tool.pre');
      expect(badge.tone).toBe('neutral');
      expect(badge.reason.length).toBeGreaterThan(0);
    });

    it('flags a hook that is switched off on the Hooks tab', () => {
      // The silent no-op the whole hook plane exists to make visible: the
      // policy is configured, enabled, and never runs.
      const view = describePolicyCard(INTERNAL_URL, { bindings });
      const badge = view.hooks.find((entry) => entry.hook === 'output.pre');
      expect(badge?.tone).toBe('off');
      expect(badge?.reason).toContain('Hooks tab');
    });

    it('flags a hook this policy can never serve, with the reason', () => {
      // A folding matcher on the streaming hook: the normalised text it matches
      // has a different length from the raw text, so no hold-back window can
      // guarantee a match cannot straddle the release frontier.
      const streaming = { ...BANNED_WORDS, enabled: true, hooks: ['output.stream.delta'] as HookId[] };
      const badge = describePolicyCard(streaming, { bindings }).hooks[0];
      expect(badge.tone).toBe('ineligible');
      expect(badge.reason.length).toBeGreaterThan(20);
    });

    it('reports a binding as off only while the policy could otherwise run', () => {
      expect(unboundHooks(INTERNAL_URL, bindings)).toEqual(['output.pre']);
      expect(unboundHooks(INTERNAL_URL, undefined)).toEqual([]);
      // A disabled policy is not "silently not running"; it is switched off,
      // and saying both at once is two warnings for one fact.
      expect(unboundHooks({ ...INTERNAL_URL, enabled: false }, bindings)).toEqual([]);
    });
  });
});

// ── duplicate ───────────────────────────────────────────────────────────────

describe('duplicate', () => {
  it('gives the copy an id of its own', () => {
    const copy = duplicatePolicy(SQLI, ids(ALL));
    expect(copy.id).not.toBe(SQLI.id);
    expect(ids(ALL)).not.toContain(copy.id);
    expect(copy.family).toBe(SQLI.family);
  });

  it('copies nested configuration by value, not by reference', () => {
    // The classic "I changed one and both moved". A shallow copy leaves two
    // policies editing the same rules array, and nothing says so until a
    // guardrail blocks traffic somebody thought they had scoped to one hook.
    const copy = duplicatePolicy(SQLI, ids(ALL)) as RegexPolicyConfig;
    copy.rules[0].pattern = 'changed';
    expect(SQLI.rules[0].pattern).not.toBe('changed');
    expect(copy.rules).not.toBe(SQLI.rules);
  });

  it('names the copy so the two are distinguishable', () => {
    expect(duplicatePolicy(SQLI, ids(ALL)).label).toBe('SQL injection · tool args (copy)');
    // Nothing to suffix: an empty label would be worse than none, because the
    // card falls back to the family plus the id and that IS distinguishable.
    expect(duplicatePolicy({ ...SQLI, label: undefined }, ids(ALL)).label).toBeUndefined();
  });

  it('drops the migration prefix, because a copy was authored', () => {
    const copy = duplicatePolicy(CUSTOMER_PII, ids(ALL));
    expect(copy.id.startsWith('legacy:')).toBe(false);
    expect(describePolicyCard(copy).migrated).toBe(false);
  });
});

// ── THE CONTRACT ────────────────────────────────────────────────────────────

/**
 * A POLICY OF A FAMILY THIS BUILD DOES NOT KNOW.
 *
 * It reaches the grid by several unremarkable routes: a guardrail authored by a
 * newer console and read by an older one, a family removed in a later release,
 * a row written straight to the API, or the pre-rename `tool_policy` spelling
 * arriving somewhere the read-path normaliser does not cover.
 *
 * `familyMeta` used to promise a `PolicyFamilyMeta` for any `PolicyFamily` —
 * true of the compile-time union, false of the runtime strings above — and
 * `canBindToHook` dereferenced it. So ONE such policy threw out of
 * `describePolicyCard` and took the entire grid down with it, leaving the
 * operator unable to read the guardrail at all, let alone delete the policy
 * causing it. The blast radius is the whole screen; the cause is one row.
 *
 * The contract now matches `catalogFor`/`fieldsOf`: answer `undefined`, let the
 * caller say what it does about that, and keep the screen up.
 */
describe('a policy whose family this build does not know', () => {
  const ALIEN = {
    id: 'from-the-future',
    family: 'quantum_shield',
    enabled: true,
    hooks: ['input.pre'],
    schedule: SYNC_BLOCK,
  } as unknown as GuardrailPolicy;

  it('renders a card instead of taking the grid down', () => {
    expect(() => describePolicyCard(ALIEN)).not.toThrow();
  });

  it('names the policy well enough to be found and removed', () => {
    const card = describePolicyCard(ALIEN);
    // The raw family id is a poor label but a TRUE one, and it is the only
    // string that lets an operator recognise what they are looking at.
    expect(card.familyLabel).toBe('quantum_shield');
    // No label of its own, so the row falls back to family + id — and both
    // halves survive, which is what makes the policy identifiable.
    expect(card.name).toBe('quantum_shield · from-the-future');
    // The catalog has no entry, so there is no icon NAME — and the registry
    // resolves that to the generic shield rather than rendering nothing.
    expect(card.icon).toBe('');
    expect(policyFamilyIcon(card.icon)).toBe(FALLBACK_POLICY_ICON);
  });

  it('says the hook is unservable rather than claiming it works', () => {
    const [badge] = describePolicyCard(ALIEN).hooks;
    expect(badge.hook).toBe('input.pre');
    expect(badge.tone).toBe('ineligible');
    // Never a greyed badge with no explanation: that is indistinguishable from
    // a broken screen, and the true reason is one the operator can act on.
    expect(badge.reason).toContain('quantum_shield');
  });

  it('degrades the metadata accessors instead of throwing', () => {
    const family = ALIEN.family as PolicyFamily;
    expect(familyMeta(family)).toBeUndefined();
    expect(familyLabel(family)).toBe('quantum_shield');
    // EVERY hook, not just the one it names: an operator opening this policy
    // must get a reason at each toggle rather than a screen that throws at the
    // first one it draws.
    for (const hook of HOOK_IDS) {
      const eligible = canBindToHook(ALIEN, hook);
      expect(eligible.ok).toBe(false);
      expect(eligible.reason ?? '').not.toBe('');
    }
  });

  it('leaves every known family exactly as it was', () => {
    for (const policy of ALL) {
      expect(familyMeta(policy.family)).toBeDefined();
      expect(familyLabel(policy.family)).toBe(familyMeta(policy.family)?.label);
      expect(describePolicyCard(policy).familyLabel).not.toBe(policy.family);
    }
  });
});

describe('neither screen knows what a family is', () => {
  /**
   * Comments are stripped first, so the files can EXPLAIN themselves in prose
   * — this is a check on the code, not on the writing.
   *
   * Naive by design: block comments, and lines that begin with `//` or a
   * continuation `*`. It never has to survive a `//` inside a string literal,
   * because neither file contains one.
   */
  const stripComments = (source: string): string =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');

  const read = (file: string): string =>
    stripComments(readFileSync(join(process.cwd(), 'src/components/guardrails', file), 'utf8'));

  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const FILES = ['PolicyCatalogModal.tsx', 'GuardrailPolicyCards.tsx'];

  it.each(FILES)('%s names no family id', (file) => {
    const source = read(file);
    for (const family of POLICY_FAMILIES) {
      const literal = new RegExp(`['"]${escape(family)}['"]`);
      expect(
        literal.test(source),
        `${file} contains the family id "${family}" as a literal. The catalog is the only place a family may be named — if something is missing, add a field to catalog/families.ts rather than a branch here, or the tenth family arrives invisible.`,
      ).toBe(false);
    }
  });

  it.each(FILES)('%s writes no family label', (file) => {
    const source = read(file);
    for (const spec of catalogEntries()) {
      const literal = new RegExp(`['"]${escape(spec.label)}['"]`);
      expect(
        literal.test(source),
        `${file} contains the label "${spec.label}" as a literal. It comes from catalog/families.ts, and a second copy is one that will eventually describe something the engine no longer does.`,
      ).toBe(false);
    }
  });

  it('reads the files it claims to be checking', () => {
    // A scan over an empty string passes every assertion above.
    for (const file of FILES) {
      expect(read(file).length).toBeGreaterThan(1000);
      expect(read(file)).toContain('export');
    }
  });
});
