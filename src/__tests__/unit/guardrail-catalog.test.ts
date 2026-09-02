/**
 * THE CATALOG CONTRACT, pinned.
 *
 * The catalog exists so that adding a tenth policy family is ONE entry in
 * `catalog/families.ts` and no UI change at all. That promise is only worth
 * something if it is checked, and every failure it can have is silent in a
 * different way:
 *
 *  · A family with no catalog entry is a family an operator cannot add. The
 *    engine runs it, the API accepts it, and the picker simply does not list
 *    it — the exact gap the regex / webhook / secrets / tool_access families
 *    were in before this wave.
 *  · A field the catalog does not describe is a field the form cannot show.
 *    The value keeps round-tripping through the JSON blob, so nothing breaks;
 *    the operator just has no way to set it and no way to see that it is set.
 *  · A validator that rejects its own defaults opens every newly added policy
 *    with a red error the operator cannot clear, because the thing it is
 *    complaining about is what the catalog itself produced.
 *  · A restated `validHooks` / `streamSafe` / `blockReason` is a copy that
 *    will eventually disagree with the engine. The streaming hold-back
 *    guarantee is not somewhere to find that out.
 *
 * The per-policy block message is checked here too, because its whole reason
 * for existing is a resolution ORDER, and an order is exactly the kind of thing
 * that is easy to get right once and lose in a refactor.
 */

import { describe, expect, it, vi } from 'vitest';

// Sync factory only: an async `vi.mock` factory does not intercept in this
// repo. `hooks/legacy` reaches the barrel, which constructs providers and
// registers shutdown handlers the moment it loads. The catalog itself reaches
// nothing behind it — that is a rule, and `catalog/index.ts` states it.
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

import {
  BLOCK_MESSAGE_VARS,
  GUARDRAIL_ENFORCEMENTS,
  POLICY_FAMILIES,
  POLICY_VALID_HOOKS,
  STREAM_ELIGIBLE_FAMILIES,
  fromEnforcement,
  readGuardrailMode,
  toEnforcement,
  toGuardrailMode,
  writeGuardrailMode,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  CustomPolicyConfig,
  GuardrailEnforcement,
  GuardrailHooksConfig,
  GuardrailMode,
  GuardrailPolicy,
  HookBinding,
  HookId,
  HookSchedule,
  ModerationPolicyConfig,
  PiiPolicyConfig,
  PolicyBase,
  PolicyFamily,
  PromptShieldPolicyConfig,
  RegexPolicyConfig,
  RegexRule,
  SecretsPolicyConfig,
  ToolAccessPolicyConfig,
  WebhookPolicyConfig,
  WordFilterPolicyConfig,
} from '@/lib/services/guardrail/hooks/contract';
import {
  BLOCK_REASON_FOR_FAMILY,
  BUILTIN_BLOCK_MESSAGES,
  describePolicyBlockMessage,
  resolveBlockMessage,
  resolveBlockMessageTemplate,
} from '@/lib/services/guardrail/hooks/messages';
// The engine reaches the `@/lib/database` barrel, which is why the mock above
// has to be in place before this import. `policyOwnMessage` itself is pure.
import { policyOwnMessage } from '@/lib/services/guardrail/hooks/engine';
import { validateGuardrailHooks } from '@/lib/services/guardrail/hooks/legacy';
import { familyMeta, familyLabel } from '@/components/guardrails/policyFamilyMeta';
import {
  COMMON_POLICY_FIELDS,
  POLICY_CATALOG_GROUPS,
  POLICY_FIELD_KINDS,
  SAFETY_ACTION_OPTIONS,
  advancedFields,
  basicFields,
  basicOptions,
  catalogEntries,
  catalogFor,
  defaultPolicy,
  familiesMissingFromCatalog,
  familyNeedsFailMode,
  familyNeedsModel,
  fieldsOf,
  searchCatalog,
  summarisePolicy,
  validatePolicyFields,
} from '@/lib/services/guardrail/catalog';
import type {
  AnyPolicyFamilySpec,
  PolicyFieldConfig,
  PolicyFieldKind,
  PolicyFieldSpec,
} from '@/lib/services/guardrail/catalog';

// ── helpers ─────────────────────────────────────────────────────────────────

/** Family fields only — the base is described once, by `COMMON_POLICY_FIELDS`. */
type FamilyKeys<C> = Exclude<keyof C, keyof PolicyBase<PolicyFamily>>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

const keysOf = (fields: readonly PolicyFieldSpec[]): string[] => fields.map((field) => field.key);

const spec = (family: PolicyFamily): AnyPolicyFamilySpec => {
  const found = catalogFor(family);
  if (!found) throw new Error(`no catalog entry for ${family}`);
  return found;
};

/** A hooks config carrying one policy, with a binding enabled for every hook it
 *  names — so `validateGuardrailHooks` judges the POLICY rather than tripping
 *  on a missing binding. */
const hooksAround = (policy: GuardrailPolicy): GuardrailHooksConfig => ({
  contractVersion: 2,
  policies: [policy],
  bindings: Object.fromEntries(
    policy.hooks.map((hook) => [
      hook,
      { enabled: true, schedule: { timing: 'sync', onFail: 'block' } } satisfies HookBinding,
    ]),
  ) as Partial<Record<HookId, HookBinding>>,
});

// ── 1. every family is in the catalog ───────────────────────────────────────

describe('the catalog covers every family', () => {
  it('has an entry for each family the engine knows about', () => {
    expect(familiesMissingFromCatalog()).toEqual([]);
    expect(catalogEntries()).toHaveLength(POLICY_FAMILIES.length);
  });

  /**
   * The guard itself, proved rather than assumed.
   *
   * `familiesMissingFromCatalog()` is the only thing standing between "someone
   * added a family to the contract" and "the picker silently does not list it",
   * so a test that only ever sees the healthy state proves nothing about it.
   * `POLICY_FAMILIES` is `Object.keys(LEGACY_FINDING_TYPE)` — a plain array
   * behind a `readonly` type — so a tenth family can be simulated by pushing
   * one on, and is removed again in `finally` whatever the assertions do.
   */
  it('reports a family that reaches the contract without a catalog entry', () => {
    const mutable = POLICY_FAMILIES as PolicyFamily[];
    mutable.push('deepfake_detector' as PolicyFamily);
    try {
      expect(familiesMissingFromCatalog()).toEqual(['deepfake_detector']);
      // And it degrades rather than throwing: a renderer walking the catalog
      // sees one fewer card, not a null label nine screens deep.
      expect(catalogFor('deepfake_detector' as PolicyFamily)).toBeUndefined();
      expect(fieldsOf('deepfake_detector' as PolicyFamily)).toEqual([]);
      expect(defaultPolicy('deepfake_detector' as PolicyFamily)).toBeUndefined();
      expect(catalogEntries()).toHaveLength(POLICY_FAMILIES.length - 1);
    } finally {
      mutable.pop();
    }
    expect(familiesMissingFromCatalog()).toEqual([]);
  });

  it('gives every entry the copy a card needs', () => {
    for (const entry of catalogEntries()) {
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(entry.description.trim().length).toBeGreaterThan(0);
      expect(entry.icon).toMatch(/^[a-z][a-z0-9-]*$/); // a name, never a component
      expect(entry.color.trim().length).toBeGreaterThan(0);
      expect(POLICY_CATALOG_GROUPS).toContain(entry.catalog.group);
      expect(entry.catalog.keywords.length).toBeGreaterThan(0);
      expect(entry.catalog.keywords.every((word) => word === word.toLowerCase())).toBe(true);
    }
  });

  it('orders the picker by group, then by the group’s own order', () => {
    const entries = catalogEntries();
    const rank = entries.map(
      (entry) => POLICY_CATALOG_GROUPS.indexOf(entry.catalog.group) * 1000 + entry.catalog.order,
    );
    expect(rank).toEqual([...rank].sort((a, b) => a - b));
  });

  it('finds a family by a word an operator would actually type', () => {
    expect(searchCatalog('gdpr').map((entry) => entry.family)).toContain('pii');
    expect(searchCatalog('jailbreak').map((entry) => entry.family)).toContain('prompt_shield');
    expect(searchCatalog('ssrf').map((entry) => entry.family)).toContain('tool_access');
    expect(searchCatalog('   ')).toHaveLength(POLICY_FAMILIES.length);
    expect(searchCatalog('nothing-matches-this')).toEqual([]);
  });
});

// ── 2. the contract is read, not restated ───────────────────────────────────

describe('the catalog reads the contract instead of restating it', () => {
  it('takes validHooks, streamSafe and blockReason from the contract tables', () => {
    for (const family of POLICY_FAMILIES) {
      const entry = spec(family);
      expect(entry.validHooks).toBe(POLICY_VALID_HOOKS[family]);
      expect(entry.streamSafe).toBe(STREAM_ELIGIBLE_FAMILIES.has(family));
      expect(entry.blockReason).toBe(BLOCK_REASON_FOR_FAMILY[family]);
    }
  });

  it('derives "needs a model" from the fields rather than declaring it', () => {
    // The three LLM families, and only those: `validateGuardrailHooks` refuses
    // to save exactly these three without a model.
    const needing = POLICY_FAMILIES.filter((family) => familyNeedsModel(family));
    expect(needing.sort()).toEqual(['custom', 'moderation', 'prompt_shield']);
  });
});

// ── 3. every field of every config is described ─────────────────────────────

/**
 * The interface -> catalog link, checked at COMPILE time.
 *
 * The runtime half below asserts the catalog declares exactly these keys; this
 * half asserts these keys are exactly the interface's. Adding a property to
 * `GuardrailToolAccessPolicyConfig` and forgetting the catalog therefore fails
 * `tsc`, not just a test run — which matters, because the symptom in production
 * is a setting that persists happily and can never be seen or changed.
 */
const PII_KEYS = [
  'piiPolicyKey',
  'actionOverride',
  'locale',
  'detectObfuscated',
  'legacyCategories',
] as const;
const SECRETS_KEYS = ['known', 'genericHighEntropy', 'minEntropy', 'allowValues'] as const;
const WORD_FILTER_KEYS = ['builtinLists', 'customListKeys', 'words', 'regexes'] as const;
const REGEX_KEYS = ['rules'] as const;
const REGEX_RULE_KEYS = [
  'id',
  'label',
  'pattern',
  'flags',
  'category',
  'severity',
  'action',
  'captureGroup',
  'maxMatchChars',
] as const;
const MODERATION_KEYS = ['modelKey', 'categories'] as const;
const PROMPT_SHIELD_KEYS = ['modelKey', 'sensitivity'] as const;
const CUSTOM_KEYS = ['modelKey', 'prompt', 'onMissingModel'] as const;
const TOOL_ACCESS_KEYS = [
  'allow',
  'deny',
  'sideEffects',
  'allowedRoles',
  'allowedDomains',
  'deniedDomains',
  'allowedPathPrefixes',
  'deniedPathPrefixes',
  'argumentSchemas',
  'maxArgBytes',
  'maxResultBytes',
  'maxArgDepth',
  'urlArgPaths',
  'pathArgPaths',
  'scanUndeclaredStrings',
  'fsRoot',
  'denyPrivateNetworks',
  'defaultSideEffect',
  'sideEffectActions',
] as const;
const WEBHOOK_KEYS = [
  'url',
  'headers',
  'credentialProviderKey',
  'signingSecretRef',
  'send',
  'redactBeforeSend',
  'retries',
] as const;

/**
 * `id`, `family` and `schedule` are the base fields `COMMON_POLICY_FIELDS`
 * deliberately omits: the first two are identity rather than configuration, and
 * `schedule` is ONE field precisely so `{ timing: 'async', onFail: 'block' }` is
 * unrepresentable — a pair of selects would put that illegal state back.
 */
const COMMON_KEYS = [
  'label',
  'enabled',
  'hooks',
  'action',
  'failMode',
  'timeoutMs',
  'runIf',
  'message',
] as const;
const COMMON_KEYS_OMITTED = ['id', 'family', 'schedule'] as const;

/**
 * The assertion is the PARAMETER TYPE; the call is what keeps it from being an
 * unused declaration. `Expect<Equal<…>>` resolves to `true` while the two key
 * sets agree, and to a type error the moment they do not.
 */
function assertEveryConfigKeyIsDescribed(
  _checks: [
    Expect<Equal<FamilyKeys<PiiPolicyConfig>, (typeof PII_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<SecretsPolicyConfig>, (typeof SECRETS_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<WordFilterPolicyConfig>, (typeof WORD_FILTER_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<RegexPolicyConfig>, (typeof REGEX_KEYS)[number]>>,
    Expect<Equal<keyof RegexRule, (typeof REGEX_RULE_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<ModerationPolicyConfig>, (typeof MODERATION_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<PromptShieldPolicyConfig>, (typeof PROMPT_SHIELD_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<CustomPolicyConfig>, (typeof CUSTOM_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<ToolAccessPolicyConfig>, (typeof TOOL_ACCESS_KEYS)[number]>>,
    Expect<Equal<FamilyKeys<WebhookPolicyConfig>, (typeof WEBHOOK_KEYS)[number]>>,
    Expect<
      Equal<
        keyof PolicyBase<PolicyFamily>,
        (typeof COMMON_KEYS)[number] | (typeof COMMON_KEYS_OMITTED)[number]
      >
    >,
    // And the kind list itself is complete: a kind added to the union but left
    // out of `POLICY_FIELD_KINDS` would slip past the runtime check below,
    // because that check only sees the kinds some field actually uses.
    Expect<Equal<PolicyFieldKind, (typeof POLICY_FIELD_KINDS)[number]>>,
  ],
): void {
  void _checks;
}

describe('every field of every configuration has a control', () => {
  it('agrees with the interfaces at compile time', () => {
    assertEveryConfigKeyIsDescribed([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(true).toBe(true);
  });

  it.each([
    ['pii', PII_KEYS],
    ['secrets', SECRETS_KEYS],
    ['word_filter', WORD_FILTER_KEYS],
    ['regex', REGEX_KEYS],
    ['moderation', MODERATION_KEYS],
    ['prompt_shield', PROMPT_SHIELD_KEYS],
    ['custom', CUSTOM_KEYS],
    ['tool_access', TOOL_ACCESS_KEYS],
    ['webhook', WEBHOOK_KEYS],
  ] as const)('describes every %s field exactly once', (family, expected) => {
    const keys = keysOf(fieldsOf(family));
    expect(keys.slice().sort()).toEqual([...expected].slice().sort());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('describes every regex rule field', () => {
    const rules = fieldsOf('regex').find((field) => field.key === 'rules');
    expect(rules?.kind).toBe('item_list');
    if (rules?.kind !== 'item_list') throw new Error('unreachable');
    expect(keysOf(rules.itemFields).slice().sort()).toEqual([...REGEX_RULE_KEYS].slice().sort());
  });

  it('describes the base fields once, for every family at once', () => {
    const keys = keysOf(COMMON_POLICY_FIELDS);
    expect(keys.slice().sort()).toEqual([...COMMON_KEYS].slice().sort());
    // And keeps out the three it must: identity is not configuration, and
    // `schedule` stays one field so its illegal pair cannot be re-introduced.
    for (const omitted of COMMON_KEYS_OMITTED) expect(keys).not.toContain(omitted);
  });

  it('gives every control a label, and every kind a user', () => {
    const used = new Set<string>();
    const walk = (fields: readonly PolicyFieldSpec[]): void => {
      for (const field of fields) {
        used.add(field.kind);
        expect(field.key.trim().length).toBeGreaterThan(0);
        expect(field.label.trim().length).toBeGreaterThan(0);
        if (field.kind === 'item_list') walk(field.itemFields);
      }
    };
    walk(COMMON_POLICY_FIELDS);
    for (const family of POLICY_FAMILIES) walk(fieldsOf(family));

    // A kind nothing uses is a kind to delete: the field set is derived from the
    // nine persisted interfaces, not invented ahead of them.
    expect([...used].sort()).toEqual([...POLICY_FIELD_KINDS].sort());
  });
});

// ── 4. defaults are a usable starting point ─────────────────────────────────

describe('every family’s defaults', () => {
  it.each(POLICY_FAMILIES)('are well-formed for %s', (family) => {
    const policy = defaultPolicy(family);
    expect(policy).toBeDefined();
    if (!policy) throw new Error('unreachable');

    expect(policy.family).toBe(family);
    expect(policy.id.trim().length).toBeGreaterThan(0);
    expect(policy.hooks.length).toBeGreaterThan(0);
    // Never the streaming hook: it costs the caller latency and needs a config
    // that declares a bounded match length, so it is a deliberate choice.
    expect(policy.hooks).not.toContain('output.stream.delta');
    for (const hook of policy.hooks) expect(POLICY_VALID_HOOKS[family]).toContain(hook);
    expect(policy.schedule).toEqual({ timing: 'sync', onFail: 'block' });
  });

  it('hands back a fresh object every time', () => {
    const first = defaultPolicy('regex') as RegexPolicyConfig;
    const second = defaultPolicy('regex') as RegexPolicyConfig;
    expect(first).not.toBe(second);
    first.rules.push({
      id: 'r1',
      label: 'x',
      pattern: 'x',
      category: 'c',
      severity: 'low',
      maxMatchChars: 8,
    });
    // Aliasing here only shows up in the UI, after adding two policies, on a
    // guardrail nobody has saved yet.
    expect(second.rules).toEqual([]);
  });

  /**
   * THE CENTRAL INVARIANT. Every field spec must accept the value its own
   * family's defaults produce.
   *
   * A 'required' issue is legitimate and expected: the catalog has no tenant,
   * so it cannot know a PII policy key, a model, or which patterns an operator
   * wants. An 'invalid' one is not — it means a validator rejects a value the
   * catalog itself wrote, i.e. a new policy opens with an error the operator
   * has no way to clear.
   */
  it.each(POLICY_FAMILIES)('are accepted by their own validators (%s)', (family) => {
    const policy = defaultPolicy(family) as unknown as PolicyFieldConfig;
    const issues = [
      ...validatePolicyFields(COMMON_POLICY_FIELDS, policy),
      ...validatePolicyFields(fieldsOf(family), policy),
    ];
    expect(issues.filter((issue) => issue.reason === 'invalid')).toEqual([]);
  });

  /**
   * And the same thing again through the SERVER's validator, which is the
   * authority. Only the families whose defaults deliberately leave a required
   * field empty may report anything, and what they report has to be exactly
   * that field.
   */
  it.each(POLICY_FAMILIES)('are accepted by validateGuardrailHooks (%s)', (family) => {
    const policy = defaultPolicy(family);
    if (!policy) throw new Error('unreachable');
    const errors = validateGuardrailHooks(hooksAround(policy));

    const outstanding = validatePolicyFields(fieldsOf(family), policy as unknown as PolicyFieldConfig)
      .filter((issue) => issue.reason === 'required')
      .map((issue) => issue.key);

    if (outstanding.length === 0) {
      expect(errors).toEqual([]);
    } else {
      // A family with an unfillable required field: the server must complain,
      // and about that field rather than about something the catalog got wrong.
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.length).toBe(outstanding.length);
    }
  });

  /**
   * The same invariant one level down. A freshly added regex rule must be
   * structurally sound and unique — its id appears on every finding, and two
   * rules sharing one makes a finding untraceable to the rule that raised it.
   */
  it('produces a nested item that only lacks what the operator must type', () => {
    const rules = fieldsOf('regex').find((field) => field.key === 'rules');
    if (rules?.kind !== 'item_list') throw new Error('unreachable');

    const first = rules.newItem([]);
    const second = rules.newItem([first]);
    expect(first.id).not.toBe(second.id);
    expect(rules.itemTitle(first, 0).trim().length).toBeGreaterThan(0);

    const issues = validatePolicyFields(rules.itemFields, first);
    expect(issues.filter((issue) => issue.reason === 'invalid')).toEqual([]);
    // Only the pattern: everything else a rule needs, the catalog can supply.
    expect(issues.map((issue) => issue.key)).toEqual(['pattern']);
  });

  it('summarises a fresh policy and a configured one without throwing', () => {
    for (const family of POLICY_FAMILIES) {
      const policy = defaultPolicy(family);
      if (!policy) throw new Error('unreachable');
      expect(summarisePolicy(policy).length).toBeGreaterThan(0);
    }

    // A webhook summary names the HOST and never the path: a webhook url
    // routinely carries a token, and a card is the last place to leak one.
    const webhook = defaultPolicy('webhook') as WebhookPolicyConfig;
    webhook.url = 'https://guard.example.com/evaluate?token=sk_live_secret';
    const line = summarisePolicy(webhook);
    expect(line).toContain('guard.example.com');
    expect(line).not.toContain('sk_live_secret');
    expect(line).not.toContain('/evaluate');
  });

  it('survives a stored config that is missing everything optional', () => {
    // What a hand-written PATCH, or a row from an older build, can look like.
    for (const family of POLICY_FAMILIES) {
      const bare = { id: 'x', family, enabled: true, hooks: [], schedule: {} } as unknown as GuardrailPolicy;
      expect(() => summarisePolicy(bare)).not.toThrow();
      expect(() => validatePolicyFields(fieldsOf(family), bare as unknown as PolicyFieldConfig)).not.toThrow();
    }
  });
});

// ── 5. the validators themselves ────────────────────────────────────────────

describe('field validation', () => {
  const piiFields = fieldsOf('pii');

  it('treats false and zero as answers, not as emptiness', () => {
    const policy = { ...(defaultPolicy('secrets') as SecretsPolicyConfig), known: false };
    const issues = validatePolicyFields(fieldsOf('secrets'), policy as unknown as PolicyFieldConfig);
    expect(issues).toEqual([]);
  });

  it('asks for a required field only while the policy is enabled', () => {
    const enabled = defaultPolicy('pii') as PiiPolicyConfig;
    expect(
      validatePolicyFields(piiFields, enabled as unknown as PolicyFieldConfig).map((i) => i.key),
    ).toEqual(['piiPolicyKey']);

    // Mirrors the server: a disabled policy's configuration is not validated, so
    // a half-built one can be parked instead of finished or thrown away.
    const parked = { ...enabled, enabled: false };
    expect(validatePolicyFields(piiFields, parked as unknown as PolicyFieldConfig)).toEqual([]);
  });

  it('reports a malformed value even while the policy is disabled', () => {
    const parked = { ...(defaultPolicy('secrets') as SecretsPolicyConfig), enabled: false, allowValues: 'not-a-list' };
    const issues = validatePolicyFields(fieldsOf('secrets'), parked as unknown as PolicyFieldConfig);
    expect(issues.map((issue) => ({ key: issue.key, reason: issue.reason }))).toEqual([
      { key: 'allowValues', reason: 'invalid' },
    ]);
  });

  it('rejects a regex rule that cannot compile, naming the rule', () => {
    const policy = defaultPolicy('regex') as RegexPolicyConfig;
    policy.rules = [
      { id: 'good', label: 'Good', pattern: '\\d+', category: 'c', severity: 'low', maxMatchChars: 8 },
      { id: 'bad', label: 'Bad', pattern: '(unclosed', category: 'c', severity: 'low', maxMatchChars: 8 },
    ];
    const issues = validatePolicyFields(fieldsOf('regex'), policy as unknown as PolicyFieldConfig);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('rules[1].pattern');
    expect(issues[0]?.label).toContain('Bad');
    expect(issues[0]?.reason).toBe('invalid');
  });

  it('refuses a plaintext webhook, and accepts an https one', () => {
    const policy = defaultPolicy('webhook') as WebhookPolicyConfig;
    policy.url = 'http://guard.example.com/evaluate';
    const insecure = validatePolicyFields(fieldsOf('webhook'), policy as unknown as PolicyFieldConfig);
    expect(insecure.map((issue) => issue.key)).toEqual(['url']);
    expect(insecure[0]?.message).toMatch(/https/);

    policy.url = 'https://guard.example.com/evaluate';
    expect(validatePolicyFields(fieldsOf('webhook'), policy as unknown as PolicyFieldConfig)).toEqual([]);
  });

  it('refuses a value that is not one of a select’s choices', () => {
    const policy = { ...(defaultPolicy('prompt_shield') as PromptShieldPolicyConfig), sensitivity: 'paranoid' };
    const issues = validatePolicyFields(fieldsOf('prompt_shield'), policy as unknown as PolicyFieldConfig);
    // `modelKey` is also outstanding here, and legitimately so — the catalog has
    // no tenant. The malformed value is what this case is about.
    expect(issues.filter((issue) => issue.reason === 'invalid').map((issue) => issue.key)).toEqual([
      'sensitivity',
    ]);
  });

  it('refuses a flag map that holds something other than a flag', () => {
    const policy = {
      ...(defaultPolicy('moderation') as ModerationPolicyConfig),
      categories: { hate: 'yes' },
    };
    const issues = validatePolicyFields(fieldsOf('moderation'), policy as unknown as PolicyFieldConfig);
    expect(issues.filter((issue) => issue.reason === 'invalid').map((issue) => issue.key)).toEqual([
      'categories',
    ]);
  });

  it('refuses a key→enum map holding an unknown action', () => {
    const policy = {
      ...(defaultPolicy('tool_access') as ToolAccessPolicyConfig),
      sideEffectActions: { destructive: 'quarantine' },
    };
    const issues = validatePolicyFields(fieldsOf('tool_access'), policy as unknown as PolicyFieldConfig);
    expect(issues.map((issue) => issue.key)).toEqual(['sideEffectActions']);
  });

  it('refuses a key→list map whose entry is not a list', () => {
    const policy = {
      ...(defaultPolicy('tool_access') as ToolAccessPolicyConfig),
      allowedRoles: { 'files.delete': 'admin' },
    };
    const issues = validatePolicyFields(fieldsOf('tool_access'), policy as unknown as PolicyFieldConfig);
    expect(issues.map((issue) => issue.key)).toEqual(['allowedRoles']);
    expect(issues[0]?.message).toContain('files.delete');
  });

  it('counts a word_filter list as empty rather than required', () => {
    const policy = defaultPolicy('word_filter') as WordFilterPolicyConfig;
    expect(validatePolicyFields(fieldsOf('word_filter'), policy as unknown as PolicyFieldConfig)).toEqual([]);
  });
});

// ── 6. the per-policy block message ─────────────────────────────────────────

/**
 * THE ENGINE ACTUALLY USING IT.
 *
 * Everything in the next block proves `resolveBlockMessage` HONOURS a
 * `policyMessage`. None of it proves anything hands one over, and for a while
 * nothing did: `renderBlock` resolved from the reason class alone, so a message
 * written on a regex policy was silently replaced by the wording shared with
 * every other 'custom'-class policy on the guardrail.
 *
 * That is the specific failure this layer exists to prevent, and it was
 * invisible from every screen that could have caught it — the drawer read the
 * stored field back, said "This policy overrides it", and offered a Reset.
 */
describe('the engine hands the blocking policy its own message', () => {
  const REGEX: GuardrailPolicy = {
    id: 'case-numbers',
    family: 'regex',
    enabled: true,
    hooks: ['output.pre'],
    schedule: { timing: 'sync', onFail: 'block' },
    rules: [],
    message: 'That looks like an internal case number.',
  };
  const WEBHOOK: GuardrailPolicy = {
    id: 'legal-review',
    family: 'webhook',
    enabled: true,
    hooks: ['output.pre'],
    schedule: { timing: 'sync', onFail: 'block' },
    url: 'https://example.test/hook',
    send: 'text',
  };
  const hooks = { contractVersion: 2, policies: [REGEX, WEBHOOK] } as GuardrailHooksConfig;

  it('picks the message off the policy that raised the finding', () => {
    expect(policyOwnMessage(hooks, 'case-numbers')).toBe(REGEX.message);
  });

  it('does not lend one policy\'s message to another sharing its reason class', () => {
    // Both are reason class 'custom'. Before the wiring existed they rendered
    // the same body; the webhook policy must still inherit, not borrow.
    expect(BLOCK_REASON_FOR_FAMILY.regex).toBe(BLOCK_REASON_FOR_FAMILY.webhook);
    expect(policyOwnMessage(hooks, 'legal-review')).toBeUndefined();
  });

  it('resolves NO message for a finding that names no policy', () => {
    // The guard that matters: `find((p) => p.id === undefined)` would match the
    // first policy that also lacks an id and put a stranger's wording on the
    // block. An absent id means no policy owns this finding.
    const idless = { contractVersion: 2, policies: [{ ...REGEX, id: '' }] } as GuardrailHooksConfig;
    expect(policyOwnMessage(idless, undefined)).toBeUndefined();
    expect(policyOwnMessage(idless, '')).toBeUndefined();
    expect(policyOwnMessage(hooks, 'no-such-policy')).toBeUndefined();
  });

  it('degrades on a config with no policies at all', () => {
    expect(policyOwnMessage({ contractVersion: 2 } as GuardrailHooksConfig, 'x')).toBeUndefined();
  });

  it('feeds the resolver, so the two policies render DIFFERENT bodies', () => {
    const render = (policyId: string) =>
      resolveBlockMessage({
        reasonClass: 'custom',
        settings: { templates: { custom: 'Workspace-wide wording.' } },
        policyId,
        policyMessage: policyOwnMessage(hooks, policyId),
        traceId: 'gr_test_0001',
      }).body;

    expect(render('case-numbers')).toContain('That looks like an internal case number.');
    expect(render('legal-review')).toContain('Workspace-wide wording.');
    expect(render('case-numbers')).not.toBe(render('legal-review'));
  });
});

describe('per-policy block message', () => {
  const traceId = 'gr_test_0001';

  it('wins over the reason-class template and over the built-in', () => {
    const rendered = resolveBlockMessage({
      reasonClass: 'custom',
      settings: { templates: { custom: 'Workspace-wide wording.' } },
      policyId: 'regex-1',
      policyMessage: 'That looks like an internal case number.',
      traceId,
    });
    expect(rendered.body).toContain('That looks like an internal case number.');
    expect(rendered.body).not.toContain('Workspace-wide wording.');
  });

  it('falls back to the reason-class template, then to the built-in', () => {
    const category = resolveBlockMessage({
      reasonClass: 'custom',
      settings: { templates: { custom: 'Workspace-wide wording.' } },
      policyId: 'regex-1',
      traceId,
    });
    expect(category.body).toContain('Workspace-wide wording.');

    const builtin = resolveBlockMessage({ reasonClass: 'custom', policyId: 'regex-1', traceId });
    expect(builtin.body).toContain(BUILTIN_BLOCK_MESSAGES.en.custom);
  });

  it('treats a blank message as "inherit" rather than as an empty message', () => {
    for (const blank of ['', '   ', '\n\t']) {
      const rendered = resolveBlockMessage({
        reasonClass: 'pii',
        settings: { templates: { pii: 'Please take the personal details out.' } },
        policyMessage: blank,
        traceId,
      });
      expect(rendered.body).toContain('Please take the personal details out.');
    }
  });

  it('interpolates the closed variable set, and leaves an unknown one verbatim', () => {
    const rendered = resolveBlockMessage({
      reasonClass: 'custom',
      policyMessage: '{{guardrailName}} stopped this. {{value}} stays put.',
      vars: { guardrailName: 'Outbound safety' },
      traceId,
    });
    expect(rendered.body).toContain('Outbound safety stopped this.');
    expect(rendered.body).toContain('{{value}} stays put.');
  });

  /**
   * `RenderedBlockMessage` is a frozen wire shape. A new field here would be a
   * new field on the block body a partner SDK parses.
   */
  it('leaves the rendered shape byte-identical', () => {
    const rendered = resolveBlockMessage({
      reasonClass: 'pii',
      policyMessage: 'Own wording.',
      traceId,
    });
    expect(Object.keys(rendered).sort()).toEqual(['body', 'mode', 'reasonClass', 'status', 'traceId']);
    expect(rendered.reasonClass).toBe('pii');
    expect(rendered.mode).toBe('error');
    expect(rendered.status).toBe(400);
    expect(rendered.traceId).toBe(traceId);
  });

  it('keeps the in-process byPolicy map BELOW the workspace’s category wording', () => {
    // A preset describing somebody else's policies must not override a
    // workspace's own voice; a message authored ON the policy may.
    const resolved = resolveBlockMessageTemplate(
      { byCategory: { custom: 'Workspace voice.' }, byPolicy: { 'regex-1': 'Preset voice.' } },
      'custom',
      'regex-1',
      'en',
    );
    expect(resolved).toEqual({ template: 'Workspace voice.', source: 'category', reasonClass: 'custom' });
  });
});

// ── 7. what the drawer shows ────────────────────────────────────────────────

describe('describePolicyBlockMessage', () => {
  const settings = { templates: { custom: 'Workspace policy stopped this.' } };

  it('says "inherited" when the policy has no message of its own', () => {
    const origin = describePolicyBlockMessage({ family: 'regex', policyId: 'regex-1', settings });
    expect(origin).toEqual({
      reasonClass: 'custom',
      overridden: false,
      source: 'category',
      effective: 'Workspace policy stopped this.',
      inherited: 'Workspace policy stopped this.',
      inheritedFrom: 'category',
    });
  });

  it('says "overridden", and still reports what it is overriding', () => {
    const origin = describePolicyBlockMessage({
      family: 'regex',
      policyId: 'regex-1',
      message: 'That looks like an internal case number.',
      settings,
    });
    expect(origin.overridden).toBe(true);
    expect(origin.source).toBe('policy');
    expect(origin.effective).toBe('That looks like an internal case number.');
    // What "Reset to inherited" restores, and the drawer's placeholder.
    expect(origin.inherited).toBe('Workspace policy stopped this.');
    expect(origin.inheritedFrom).toBe('category');
  });

  /**
   * THE REASON THE FIELD EXISTS. `regex`, `custom` and `webhook` all collapse
   * onto the `custom` reason class, so before this an operator editing one of
   * them silently rewrote the other two.
   */
  it('separates two families that share one reason class', () => {
    const regex = describePolicyBlockMessage({
      family: 'regex',
      policyId: 'regex-1',
      message: 'Internal reference numbers cannot be sent here.',
      settings,
    });
    const webhook = describePolicyBlockMessage({ family: 'webhook', policyId: 'hook-1', settings });

    expect(regex.reasonClass).toBe('custom');
    expect(webhook.reasonClass).toBe('custom');
    expect(regex.effective).not.toBe(webhook.effective);
    // ...and the shared layer is untouched: the webhook policy still shows the
    // workspace's wording, which is what the reason-class layer is for.
    expect(webhook.effective).toBe('Workspace policy stopped this.');
    expect(webhook.overridden).toBe(false);
  });

  it('falls all the way through to the built-in when nothing is set', () => {
    const origin = describePolicyBlockMessage({ family: 'pii' });
    expect(origin.source).toBe('builtin');
    expect(origin.effective).toBe(BUILTIN_BLOCK_MESSAGES.en.pii);
  });

  it('answers in the requested locale, and ignores one it does not have', () => {
    expect(describePolicyBlockMessage({ family: 'pii', locale: 'tr' }).effective).toBe(
      BUILTIN_BLOCK_MESSAGES.tr.pii,
    );
    expect(describePolicyBlockMessage({ family: 'pii', locale: 'kl' }).effective).toBe(
      BUILTIN_BLOCK_MESSAGES.en.pii,
    );
  });

  it('has a reason class for every family', () => {
    for (const family of POLICY_FAMILIES) {
      expect(describePolicyBlockMessage({ family }).effective.length).toBeGreaterThan(0);
    }
  });
});

// ── 8. the message is validated where it is saved ───────────────────────────

describe('validateGuardrailHooks and the per-policy message', () => {
  const withMessage = (message: unknown): GuardrailHooksConfig => {
    const policy = defaultPolicy('secrets');
    if (!policy) throw new Error('unreachable');
    return hooksAround({ ...policy, message } as GuardrailPolicy);
  };

  it('accepts a message using the closed variable set', () => {
    expect(validateGuardrailHooks(withMessage('{{guardrailName}} stopped this — {{traceId}}'))).toEqual([]);
  });

  it('accepts no message at all, and a blank one', () => {
    expect(validateGuardrailHooks(withMessage(undefined))).toEqual([]);
    expect(validateGuardrailHooks(withMessage('   '))).toEqual([]);
  });

  /**
   * The variable set is closed because a template is tenant-editable and its
   * output is shown to end users: an interpolatable matched value would turn
   * the guardrail into an exfiltration channel for the data it protects.
   */
  it('refuses a message reaching for a variable that does not exist', () => {
    const errors = validateGuardrailHooks(withMessage('We found {{value}} in {{userName}}.'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('{{value}}');
    expect(errors[0]).toContain('{{userName}}');
    for (const name of BLOCK_MESSAGE_VARS) expect(errors[0]).toContain(`{{${name}}}`);
  });

  it('refuses a message that is not text', () => {
    expect(validateGuardrailHooks(withMessage(42))).toHaveLength(1);
  });

  it('checks the message of a DISABLED policy too', () => {
    const policy = defaultPolicy('secrets');
    if (!policy) throw new Error('unreachable');
    const hooks = hooksAround({ ...policy, enabled: false, message: 'Leaks {{value}}.' } as GuardrailPolicy);
    // A wrong string is wrong whether or not it runs today, and an operator
    // should not be surprised by it the day they switch the policy back on.
    expect(validateGuardrailHooks(hooks).some((error) => error.includes('{{value}}'))).toBe(true);
  });
});

/**
 * THE SECOND FAMILY TABLE.
 *
 * `components/guardrails/policyFamilyMeta.ts` predates this catalog and still
 * carries the other half of a family's display data (`short`, the icon
 * COMPONENT, `needsModel`, `needsFailMode`). Two tables describing one family
 * is one table that will eventually disagree — and it already had: the catalog
 * called `pii` "Personal data" and `secrets` "Credentials" while `META` called
 * them "PII" and "Secrets", so a single policy drawer titled itself "PII
 * policy" and then said "Inherited from the Personal data default" a few
 * hundred pixels below. The seven other families matched, which is what made it
 * look like a considered difference rather than drift.
 *
 * `label` is now READ from the catalog and removed from `META`'s row type, so
 * the divergence is unrepresentable. This pins the property rather than the
 * mechanism: whatever either file does later, one family may not have two
 * names.
 */
describe('the catalog is the single source for a family label', () => {
  it('agrees with policyFamilyMeta on every family, by construction', () => {
    for (const family of POLICY_FAMILIES) {
      expect(familyMeta(family)?.label).toBe(catalogFor(family)?.label);
      // Not vacuous: `toBe(undefined) === toBe(undefined)` would pass for a
      // family neither table knows.
      expect(catalogFor(family)?.label?.trim()).toBeTruthy();
    }
  });

  it('degrades to the raw family id rather than an empty heading', () => {
    // The runtime case the optional return type exists for: a policy authored
    // by a newer console. `familyLabel` must still produce the one string that
    // lets an operator recognise what to delete.
    const mutable = POLICY_FAMILIES as PolicyFamily[];
    mutable.push('zzz_unknown' as PolicyFamily);
    try {
      expect(familyLabel('zzz_unknown' as PolicyFamily)).toBe('zzz_unknown');
      expect(familyMeta('zzz_unknown' as PolicyFamily)).toBeUndefined();
    } finally {
      mutable.pop();
    }
  });
});

// ── 9. the two controls that replaced six ───────────────────────────────────

/**
 * THE SIMPLIFICATION, pinned as a MAPPING rather than as a screenshot.
 *
 * Two collapses happened, and both are presentation-only:
 *   · `timing` x `onFail`  -> one `GuardrailEnforcement` with three values.
 *   · `mode` + `enabled`   -> one `GuardrailMode`, written as a coherent pair.
 *
 * Nothing about the STORED shapes moved, which is exactly what makes these
 * tests worth having: a future edit that "simplifies" by dropping `onFail` or
 * by writing `mode` without `enabled` changes what a partner SDK reads and what
 * an older console binary on the same tenant database enforces. Every case
 * below asserts a stored shape, not a label.
 */

/**
 * Every schedule the type can hold, as a TOTAL record so the case list cannot
 * fall behind the union — the same reason `HOOK_IDS` is derived from
 * `HOOK_SUBJECT_KIND`'s keys.
 *
 * The distributed conditional is what makes it three keys and not four: it
 * expands each member of the union separately, so the `async` member
 * contributes only its one legal `onFail` and 'async:block' is not a key this
 * record could have.
 */
type ScheduleKey<S extends HookSchedule = HookSchedule> = S extends S
  ? `${S['timing']}:${S['onFail']}`
  : never;

const STORED_SCHEDULES: Readonly<
  Record<ScheduleKey, { schedule: HookSchedule; enforcement: GuardrailEnforcement }>
> = {
  'sync:block': { schedule: { timing: 'sync', onFail: 'block' }, enforcement: 'block' },
  'sync:log': { schedule: { timing: 'sync', onFail: 'log' }, enforcement: 'observe' },
  'async:log': { schedule: { timing: 'async', onFail: 'log' }, enforcement: 'observe_no_wait' },
};

describe('the enforcement control maps onto the stored schedule', () => {
  it('offers exactly three values, and the type has exactly three', () => {
    expect([...GUARDRAIL_ENFORCEMENTS]).toEqual(['block', 'observe', 'observe_no_wait']);
    // The fourth combination two selects advertised: an async check has already
    // let the response go, so there is nothing left for it to stop.
    expect(Object.keys(STORED_SCHEDULES)).toHaveLength(3);
  });

  it.each(Object.entries(STORED_SCHEDULES))(
    'round-trips the stored schedule %s',
    (_key, { schedule, enforcement }) => {
      expect(toEnforcement(schedule)).toBe(enforcement);
      // Back to the SAME stored object, byte for byte. This is the assertion
      // that fails if anyone "simplifies" the persisted shape.
      expect(fromEnforcement(enforcement)).toEqual(schedule);
    },
  );

  it('round-trips every screen value back to itself', () => {
    for (const value of GUARDRAIL_ENFORCEMENTS) {
      expect(toEnforcement(fromEnforcement(value))).toBe(value);
    }
  });

  it('hands back a fresh schedule every call', () => {
    const first = fromEnforcement('block');
    const second = fromEnforcement('block');
    expect(first).not.toBe(second);
    // A schedule is copied from a binding onto every policy bound to the hook;
    // a shared constant there means one later edit rewrites all of them.
    expect(first).toEqual(second);
  });

  /**
   * The shapes the TYPE forbids and a stored row can still contain: a
   * hand-written PATCH, or a policy an older build persisted without one. The
   * screen has to say what the ENGINE will do with them, and the engine's
   * fallback is `SYNC_BLOCK` (`policyTiming`, hooks/engine) with
   * `onFail: schedule?.onFail ?? 'block'` on the wire.
   */
  it('agrees with the engine on a schedule that is missing or malformed', () => {
    expect(toEnforcement(undefined)).toBe('block');
    expect(toEnforcement(null)).toBe('block');
    expect(toEnforcement({} as HookSchedule)).toBe('block');
    expect(toEnforcement({ timing: 'sync' } as HookSchedule)).toBe('block');

    // Async with no onFail: async has one legal onFail, so there is nothing
    // else it could mean.
    expect(toEnforcement({ timing: 'async' } as HookSchedule)).toBe('observe_no_wait');

    // TIMING WINS over a contradictory onFail. The response has already gone,
    // so this row logs whatever it claims; showing 'block' would promise
    // enforcement the engine does not deliver.
    expect(toEnforcement({ timing: 'async', onFail: 'block' } as unknown as HookSchedule)).toBe(
      'observe_no_wait',
    );
  });

  it('falls towards enforcement on a value that is not one of the three', () => {
    expect(fromEnforcement('nonsense' as GuardrailEnforcement)).toEqual({
      timing: 'sync',
      onFail: 'block',
    });
  });

  /** The catalog still refuses to describe `schedule` as a field: the control is
   *  one select, the stored value is an object, and a select bound to `schedule`
   *  would write the string over it. */
  it('is not a field spec, because its stored value is not a string', () => {
    expect(keysOf(COMMON_POLICY_FIELDS)).not.toContain('schedule');
  });
});

describe('mode is one control written to two columns', () => {
  const MODES: readonly GuardrailMode[] = ['enforce', 'monitor', 'disabled'];

  it.each(MODES)('writes %s as a coherent pair', (mode) => {
    const fields = writeGuardrailMode(mode);
    expect(fields).toEqual({ mode, enabled: mode !== 'disabled' });
    // The pair can never disagree, checked through the ENGINE's own fold rather
    // than by restating it: `toGuardrailMode` opens with
    // `if (!enabled) return 'disabled'`.
    expect(toGuardrailMode(fields.mode, fields.enabled)).toBe(mode);
    expect(readGuardrailMode(fields)).toBe(mode);
  });

  it('reads a stored row the way the engine does', () => {
    // `enabled: false` wins over any stored word — the disagreement this pair
    // exists to make impossible, read from a row that already has it.
    expect(readGuardrailMode({ mode: 'enforce', enabled: false })).toBe('disabled');
    // Absent `mode`: derived from `enabled`, which is what every row written
    // before the column existed carries.
    expect(readGuardrailMode({ enabled: true })).toBe('enforce');
    expect(readGuardrailMode({ enabled: false })).toBe('disabled');
    // The two aliases stored rows carry: the enforcement plane wrote
    // 'simulate', the MCP binding writes 'off'.
    expect(readGuardrailMode({ mode: 'simulate', enabled: true })).toBe('monitor');
    expect(readGuardrailMode({ mode: 'off', enabled: true })).toBe('disabled');
    // A PARTIAL — a PATCH body naming only `mode` — must not read as "turn it
    // off"; an absent property means "leave it alone".
    expect(readGuardrailMode({ mode: 'monitor' })).toBe('monitor');
  });
});

// ── 10. the basic / advanced split ──────────────────────────────────────────

/**
 * WHAT THE OPERATOR IS ASKED FIRST.
 *
 * The split lives on the field specs so the screens inherit it, and the point
 * of testing it is the SIZE: an "advanced" disclosure that hides two fields out
 * of nineteen has not simplified anything, and a basic surface that grows one
 * field at a time is how fourteen controls happened in the first place.
 *
 * The other half of the pin is that hiding is PRESENTATION: every advanced
 * field is still stored, still validated, and still selectable.
 */
describe('the basic surface is small, and advanced hides nothing that is stored', () => {
  it('partitions every field list exactly once, in declaration order', () => {
    for (const fields of [COMMON_POLICY_FIELDS, ...POLICY_FAMILIES.map((f) => fieldsOf(f))]) {
      const basic = basicFields(fields);
      const advanced = advancedFields(fields);
      expect(basic.length + advanced.length).toBe(fields.length);
      expect(basic.some((field) => advanced.includes(field))).toBe(false);
      // Order is preserved, so a form renders its controls in the order the
      // family author wrote them rather than in filter order.
      expect(keysOf(basic)).toEqual(keysOf(fields.filter((field) => field.advanced !== true)));
    }
  });

  /**
   * THE FOUR QUESTIONS. Three live on the base — a name, where it runs, and what
   * a finding does — and the fourth is the family's own basic fields.
   *
   * `enabled` is advanced deliberately: a policy is switched on and off from its
   * card in one click, so the switch in the form is a second route to a decision
   * that is already made elsewhere.
   */
  it('asks three questions on the base of every policy', () => {
    expect(keysOf(basicFields(COMMON_POLICY_FIELDS))).toEqual(['label', 'hooks', 'action']);
    expect(keysOf(advancedFields(COMMON_POLICY_FIELDS)).sort()).toEqual(
      ['enabled', 'failMode', 'message', 'runIf', 'timeoutMs'].sort(),
    );
  });

  it.each(POLICY_FAMILIES)('keeps %s’s basic surface small', (family) => {
    const basic = basicFields(fieldsOf(family));
    // Six is `tool_access`, and it is six because the family genuinely is three
    // allow/deny pairs: tools, domains, paths. A family that reaches eight has
    // defeated the exercise.
    expect(basic.length).toBeLessThanOrEqual(6);
    // ...and never zero: a form whose first screen is empty reads as broken.
    expect(basic.length).toBeGreaterThan(0);
  });

  it('splits a nested regex rule too', () => {
    const rules = fieldsOf('regex').find((field) => field.key === 'rules');
    if (rules?.kind !== 'item_list') throw new Error('unreachable');
    expect(keysOf(basicFields(rules.itemFields))).toEqual([
      'label',
      'pattern',
      'category',
      'severity',
      'maxMatchChars',
    ]);
    // `id` is generated by `newItem`, so it is identity rather than a question;
    // `action` is an override of the policy's own action one level up.
    expect(keysOf(advancedFields(rules.itemFields)).sort()).toEqual(
      ['action', 'captureGroup', 'flags', 'id'].sort(),
    );
  });

  /**
   * NOTHING BEHIND THE DISCLOSURE IS OUTSTANDING.
   *
   * An advanced field may be `required` — `custom.onMissingModel` is, and a
   * regex rule's `id` is — but only where the catalog itself supplies the value,
   * so a fresh policy never opens with an error the operator can only clear by
   * finding a control that is hidden. Everything still outstanding on a new
   * policy has to be on the FIRST screen.
   */
  it('leaves nothing outstanding behind the disclosure', () => {
    for (const family of POLICY_FAMILIES) {
      const policy = defaultPolicy(family);
      if (!policy) throw new Error('unreachable');
      const fields = [...COMMON_POLICY_FIELDS, ...fieldsOf(family)];
      const advanced = new Set(keysOf(advancedFields(fields)));
      const outstanding = validatePolicyFields(fields, policy as unknown as PolicyFieldConfig)
        .filter((issue) => issue.reason === 'required')
        .map((issue) => issue.key);
      expect(outstanding.filter((key) => advanced.has(key))).toEqual([]);
    }
  });

  it('leaves nothing outstanding behind the disclosure of a nested rule', () => {
    const rules = fieldsOf('regex').find((field) => field.key === 'rules');
    if (rules?.kind !== 'item_list') throw new Error('unreachable');
    const advanced = new Set(keysOf(advancedFields(rules.itemFields)));
    const outstanding = validatePolicyFields(rules.itemFields, rules.newItem([]))
      .filter((issue) => issue.reason === 'required')
      .map((issue) => issue.key);
    // Only the pattern, and the pattern is on the first screen.
    expect(outstanding).toEqual(['pattern']);
    expect(outstanding.filter((key) => advanced.has(key))).toEqual([]);
  });

  /**
   * PRESENTATION, NOT REMOVAL. Every advanced field is a stored property with a
   * control; `validatePolicyFields` never reads `advanced`, so hiding one
   * changes nothing about what saves.
   */
  it('validates an advanced field exactly as it did before', () => {
    const policy = {
      ...(defaultPolicy('secrets') as SecretsPolicyConfig),
      // `minEntropy` is advanced; a malformed one is still reported.
      minEntropy: 'high',
    };
    const issues = validatePolicyFields(fieldsOf('secrets'), policy as unknown as PolicyFieldConfig);
    expect(issues.map((issue) => ({ key: issue.key, reason: issue.reason }))).toEqual([
      { key: 'minEntropy', reason: 'invalid' },
    ]);
  });

  /**
   * `failMode` is offered ONLY where it answers a question that can arise. A
   * regex, a word list and the secret patterns scan a string in memory — a
   * failure mode for them is a control for a state that does not occur.
   */
  it('shows "if it cannot run" only for a family that can fail to run', () => {
    const failMode = COMMON_POLICY_FIELDS.find((field) => field.key === 'failMode');
    if (!failMode) throw new Error('unreachable');
    for (const family of POLICY_FAMILIES) {
      const visible = failMode.visibleWhen?.({ family }) ?? true;
      expect(visible).toBe(familyNeedsFailMode(family));
      expect(visible).toBe(catalogFor(family)?.needsFailMode);
    }
    // A family this build has never heard of shows its stored setting rather
    // than having it quietly hidden.
    expect(failMode.visibleWhen?.({ family: 'deepfake_detector' })).toBe(true);
    expect(failMode.visibleWhen?.({})).toBe(true);
  });
});

describe('the action ladder leads with three rungs and stores five', () => {
  it('still carries every stored rung', () => {
    expect(SAFETY_ACTION_OPTIONS.map((option) => option.value)).toEqual([
      'block',
      'redact',
      'flag',
      'warn',
      'allow',
    ]);
  });

  it('offers the three an operator picks between', () => {
    expect(basicOptions(SAFETY_ACTION_OPTIONS).map((option) => option.value)).toEqual([
      'block',
      'redact',
      'flag',
    ]);
  });

  /**
   * THE HALF THAT MATTERS. A policy saved with 'warn' must open on a control
   * that can show 'warn' — otherwise the drawer displays the wrong rung and the
   * next save silently rewrites a stored decision.
   */
  it('keeps an edge rung visible for exactly as long as it is in use', () => {
    expect(basicOptions(SAFETY_ACTION_OPTIONS, 'warn').map((option) => option.value)).toEqual([
      'block',
      'redact',
      'flag',
      'warn',
    ]);
    expect(basicOptions(SAFETY_ACTION_OPTIONS, 'allow').map((option) => option.value)).toEqual([
      'block',
      'redact',
      'flag',
      'allow',
    ]);
  });

  it('accepts a stored value the basic control does not offer', () => {
    const policy = { ...(defaultPolicy('secrets') as SecretsPolicyConfig), action: 'warn' };
    expect(
      validatePolicyFields(COMMON_POLICY_FIELDS, policy as unknown as PolicyFieldConfig),
    ).toEqual([]);
  });

  /**
   * ONE ARRAY, BY IDENTITY. `isOutcomeField` and `outcomeFieldsElsewhere`
   * (GuardrailPolicyDrawer) recognise an action field by
   * `options === SAFETY_ACTION_OPTIONS`, so a family that pointed at a derived
   * copy would silently stop being an action field and block 4 would stop
   * pointing at it.
   *
   * `tool_access.sideEffectActions` therefore shares the array and renders it in
   * FULL: the collapse is for basic controls, this one is advanced, and its own
   * defaults are two of the rungs the basic control hides — 'allow' for
   * none/read/write and 'warn' for destructive/external.
   */
  it('shares the one array with the side-effect table', () => {
    const sideEffectActions = fieldsOf('tool_access').find(
      (field) => field.key === 'sideEffectActions',
    );
    if (sideEffectActions?.kind !== 'key_enum') throw new Error('unreachable');
    expect(sideEffectActions.options).toBe(SAFETY_ACTION_OPTIONS);
    expect(sideEffectActions.advanced).toBe(true);

    const ruleAction = (() => {
      const rules = fieldsOf('regex').find((field) => field.key === 'rules');
      if (rules?.kind !== 'item_list') throw new Error('unreachable');
      return rules.itemFields.find((field) => field.key === 'action');
    })();
    if (ruleAction?.kind !== 'select') throw new Error('unreachable');
    expect(ruleAction.options).toBe(SAFETY_ACTION_OPTIONS);
  });
});
