/**
 * The policy drawer's pure half.
 *
 * Four things are worth pinning here, and they are the four the drawer can get
 * wrong WITHOUT anything looking broken on screen:
 *
 *   1. WHICH FIELDS A POLICY RENDERS. A control that is silently not drawn is a
 *      setting an operator cannot see or change while it goes on being enforced.
 *      That includes the generic-renderer rule itself: block 3 must come from
 *      `spec.fields`, so a family the drawer has never heard of still gets a
 *      complete form.
 *   2. HOW ISSUES AGGREGATE. `collectPolicyIssues` is what the footer counts and
 *      what each block shows. Missing an issue promises a save the server will
 *      refuse; inventing one blocks a save the server would accept.
 *   3. WHICH MESSAGE IS IN FORCE. `policy.message` was added precisely because
 *      `regex`, `custom` and `webhook` share the reason class 'custom', so an
 *      operator editing "the regex message" was rewriting the webhook one. The
 *      drawer's label has to say which of the two is happening, or the field
 *      does not solve the problem it was added for.
 *   4. WHAT IS BEHIND THE DISCLOSURE, AND WHAT IT ADMITS TO. The form now asks
 *      four questions and collapses the rest, which is only an improvement if
 *      the collapsed part (a) contains everything the basic part left out,
 *      (b) says what is in it and which of it is not at its default, and
 *      (c) cannot swallow a validation issue. Get any of those wrong and this
 *      is not a simplification, it is a hiding place.
 *
 * A plain `.ts` test against a `.tsx` module: every export under test is pure —
 * no React, no Mantine, no DOM — which is the property that lets the same code
 * serve the drawer and this file.
 */

import { describe, expect, it } from 'vitest';
import {
  ADVANCED_SECTION_ORDER,
  BLOCK_REASON_LABEL,
  ENFORCEMENT_OPTIONS,
  advancedContentsLine,
  advancedInDrawOrder,
  advancedSection,
  asFieldConfig,
  blockMessageSourceLabel,
  collectPolicyIssues,
  commonField,
  describeFieldValue,
  describeMessageInheritance,
  enforcementSummaryLabel,
  groupConfigFields,
  isAdvancedIssue,
  isKnownFamily,
  isOutcomeField,
  issuesForSection,
  outcomeFieldsElsewhere,
  partitionIssuesByDisclosure,
  policyAdvancedChanges,
  policyAdvancedControls,
  policyDraftIsDirty,
  policyFormLayout,
  policyHookOptions,
  unknownMessageVars,
  visiblePolicyFields,
} from '@/components/guardrails/GuardrailPolicyDrawer';
import type { PolicyAdvancedControl } from '@/components/guardrails/GuardrailPolicyDrawer';
import {
  fieldPath,
  issueForField,
  numberPlaceholder,
  optionValueOf,
  recordEntries,
  renameKey,
  selectData,
  switchValue,
} from '@/components/guardrails/PolicyFieldRenderer';
import {
  COMMON_POLICY_FIELDS,
  SAFETY_ACTION_OPTIONS,
  advancedFields,
  basicFields,
  basicOptions,
  catalogFor,
  defaultPolicy,
  familyNeedsFailMode,
  familyNeedsModel,
  fieldsOf,
} from '@/lib/services/guardrail/catalog';
import type { PolicyFieldSpec } from '@/lib/services/guardrail/catalog';
import {
  BLOCK_MESSAGE_VARS,
  GUARDRAIL_ENFORCEMENTS,
  HOOK_IDS,
  POLICY_FAMILIES,
  fromEnforcement,
  toEnforcement,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  BlockedMessageSettings,
  GuardrailPolicy,
  HookBinding,
  HookId,
  PiiPolicyConfig,
  RegexPolicyConfig,
  SecretsPolicyConfig,
  WebhookPolicyConfig,
} from '@/lib/services/guardrail/hooks/contract';
import { BLOCK_REASON_FOR_FAMILY } from '@/lib/services/guardrail/hooks/messages';
import {
  ENFORCEMENT_COPY,
  ENFORCEMENT_VOCABULARY,
} from '@/components/guardrails/guardrailVocabulary';

// ── fixtures ────────────────────────────────────────────────────────────────

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

const PII: PiiPolicyConfig = {
  id: 'pii-outbound',
  family: 'pii',
  enabled: true,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  label: 'Outbound personal data',
  piiPolicyKey: 'default',
};

const SECRETS: SecretsPolicyConfig = {
  id: 'secrets',
  family: 'secrets',
  enabled: true,
  hooks: ['input.pre', 'output.pre'],
  schedule: SYNC_BLOCK,
};

const REGEX: RegexPolicyConfig = {
  id: 'regex-case',
  family: 'regex',
  enabled: true,
  hooks: ['output.pre'],
  schedule: SYNC_BLOCK,
  label: 'Case numbers',
  rules: [
    {
      id: 'case-no',
      label: 'case number',
      pattern: '\\bcase-\\d{6}\\b',
      category: 'custom',
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
  url: 'https://example.test/guardrail',
  send: 'text',
};

/** The regex rule with no declared match bound — what makes a regex policy
 *  refuse the streaming hook. Omitted, not set to `undefined`: the interface
 *  requires the property, and "absent" is the state the engine actually sees. */
function unboundedRule(): RegexPolicyConfig['rules'][number] {
  const rule = { ...REGEX.rules[0] };
  delete (rule as Partial<typeof rule>).maxMatchChars;
  return rule;
}

// ═══ 1. WHICH FIELDS A POLICY RENDERS ═══════════════════════════════════════

describe('policyFormLayout — which controls a policy draws', () => {
  it('draws every family field from the catalog, and nothing it invented', () => {
    // The generic-renderer promise, stated as an assertion: block 3's contents
    // ARE `spec.fields`. If the drawer ever hand-rolls a control for a family,
    // this is the test that notices.
    for (const family of POLICY_FAMILIES) {
      const policy = defaultPolicy(family);
      expect(policy, `${family} has no catalog entry`).toBeDefined();
      const layout = policyFormLayout(policy as GuardrailPolicy);
      const drawn = [...layout.config, ...layout.configAdvanced, ...layout.outcome].map((f) => f.key);
      const expected = visiblePolicyFields(
        fieldsOf(family),
        asFieldConfig(policy as GuardrailPolicy),
      ).map((f) => f.key);
      expect(drawn.sort()).toEqual(expected.sort());
    }
  });

  it('every field lands in exactly one of the three buckets', () => {
    for (const family of POLICY_FAMILIES) {
      const layout = policyFormLayout(defaultPolicy(family) as GuardrailPolicy);
      const keys = [...layout.config, ...layout.configAdvanced, ...layout.outcome].map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('holds an advanced field back from the main list', () => {
    const layout = policyFormLayout({ ...SECRETS, genericHighEntropy: true });
    expect(layout.config.map((f) => f.key)).toContain('genericHighEntropy');
    expect(layout.config.map((f) => f.key)).not.toContain('minEntropy');
    expect(layout.configAdvanced.map((f) => f.key)).toContain('minEntropy');
  });

  it('honours visibleWhen — the entropy floor disappears with the scan it configures', () => {
    // The one real progressive-disclosure rule in the catalog. A number field
    // that stays on screen after the switch it belongs to is turned off reads as
    // a setting that still does something.
    const on = policyFormLayout({ ...SECRETS, genericHighEntropy: true });
    const off = policyFormLayout({ ...SECRETS, genericHighEntropy: false });
    expect(on.configAdvanced.map((f) => f.key)).toContain('minEntropy');
    expect(off.configAdvanced.map((f) => f.key)).not.toContain('minEntropy');
    // …and it is back the moment the switch is absent, because the engine's
    // default for `genericHighEntropy` is on.
    const unset = policyFormLayout(SECRETS);
    expect(unset.configAdvanced.map((f) => f.key)).toContain('minEntropy');
  });

  it('a family with no catalog entry degrades to three empty lists, not an exception', () => {
    const alien = { ...SECRETS, family: 'not_a_family' } as unknown as GuardrailPolicy;
    expect(() => policyFormLayout(alien)).not.toThrow();
    expect(policyFormLayout(alien)).toEqual({ config: [], configAdvanced: [], outcome: [] });
  });

  it('groups config fields under their headings, ungrouped ones first', () => {
    const layout = policyFormLayout(defaultPolicy('tool_access') as GuardrailPolicy);
    const grouped = groupConfigFields(layout.config);
    expect(grouped.length).toBeGreaterThan(1);
    // tool_access happens to group ALL of its fields, so the ungrouped-first
    // rule is asserted structurally: no ungrouped section may follow a grouped
    // one, whether or not this family has any.
    const firstGrouped = grouped.findIndex((section) => section.group !== undefined);
    expect(grouped.slice(firstGrouped).every((section) => section.group !== undefined)).toBe(true);
    // Every field survives the grouping — a heading must never eat a control.
    expect(grouped.flatMap((section) => section.fields).map((f) => f.key).sort()).toEqual(
      layout.config.map((f) => f.key).sort(),
    );
    // A group appears once, not once per run of fields.
    const names = grouped.map((section) => section.group);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('isOutcomeField — block 4 without a family branch', () => {
  it('is decided by option identity, never by family or key', () => {
    const lifted: PolicyFieldSpec = {
      kind: 'select',
      key: 'whatever',
      label: 'What to do',
      options: SAFETY_ACTION_OPTIONS,
    };
    expect(isOutcomeField(lifted)).toBe(true);

    // A structurally identical option list that is NOT the shared array is a
    // different question — this is exactly PII's `actionOverride`, which picks a
    // rendering strategy rather than a safety action.
    const lookalike: PolicyFieldSpec = {
      ...lifted,
      options: SAFETY_ACTION_OPTIONS.map((option) => ({ ...option })),
    };
    expect(isOutcomeField(lookalike)).toBe(false);
  });

  it('leaves a grouped action field with its group', () => {
    const grouped: PolicyFieldSpec = {
      kind: 'key_enum',
      key: 'sideEffectActions',
      label: 'What to do about each side effect',
      group: 'Side effects',
      options: SAFETY_ACTION_OPTIONS,
    };
    expect(isOutcomeField(grouped)).toBe(false);
  });

  it('lifts nothing today, and says where the outcome fields actually are', () => {
    // Documented behaviour, asserted so the day it changes is a deliberate day.
    for (const family of POLICY_FAMILIES) {
      expect(policyFormLayout(defaultPolicy(family) as GuardrailPolicy).outcome).toEqual([]);
    }

    // tool_access decides an outcome under a heading; regex decides one per rule.
    const tool = outcomeFieldsElsewhere(defaultPolicy('tool_access') as GuardrailPolicy);
    expect(tool.map((entry) => entry.where)).toContain('under Side effects');
    const regex = outcomeFieldsElsewhere(REGEX);
    expect(regex.map((entry) => entry.where)).toContain('per rule');

    // A family that decides its outcome only through the common `action` has
    // nothing to point at, and must not invent a line saying it does.
    expect(outcomeFieldsElsewhere(SECRETS)).toEqual([]);
  });

  it('says which of them are behind the disclosure, because "under Side effects" is not directions', () => {
    // `tool_access.sideEffectActions` is an advanced field, so pointing an
    // operator at it without saying "open Advanced first" sends them looking
    // for a control that is collapsed.
    const table = outcomeFieldsElsewhere(defaultPolicy('tool_access') as GuardrailPolicy).find(
      (entry) => entry.where === 'under Side effects',
    );
    expect(table?.advanced).toBe(true);

    // A regex rule's own action is advanced WITHIN its card, but the card is
    // reached through `rules`, which is basic — so the operator does not have
    // to open this disclosure to get to it.
    const perRule = outcomeFieldsElsewhere(REGEX).find((entry) => entry.where === 'per rule');
    expect(perRule?.advanced).toBe(false);
  });
});

describe('the common fields come from the catalog', () => {
  it('has the five block-4 and block-1 controls the drawer names', () => {
    for (const key of ['label', 'enabled', 'action', 'failMode', 'timeoutMs', 'runIf', 'message']) {
      expect(commonField(key), `${key} is missing from COMMON_POLICY_FIELDS`).toBeDefined();
    }
  });

  it('`action` and `message` are the kinds the drawer re-labels', () => {
    // The drawer narrows both before spreading a new value onto them. A kind
    // change here would silently drop the guardrail's inherited action from the
    // placeholder and the inherited wording from the message box.
    expect(commonField('action')?.kind).toBe('select');
    expect(commonField('message')?.kind).toBe('textarea');
  });

  it('does not expose `id` or `schedule` as configuration', () => {
    // Identity is not configuration, and `schedule` is ONE field precisely so
    // `{ timing: 'async', onFail: 'block' }` stays unrepresentable.
    expect(commonField('id')).toBeUndefined();
    expect(commonField('schedule')).toBeUndefined();
  });
});

// ═══ 1b. THE ONE DISCLOSURE ═════════════════════════════════════════════════

/**
 * The three common fields the form still asks for outright. Everything else on
 * `COMMON_POLICY_FIELDS` has to be inside the disclosure, or it is a control
 * that vanished.
 */
const BASIC_COMMON = ['label', 'hooks', 'action'];

/** The whole basic surface, counted the way an operator meets it: three common
 *  questions plus whatever the family asks for outright. */
function basicControlCount(policy: GuardrailPolicy): number {
  const layout = policyFormLayout(policy);
  return BASIC_COMMON.length + layout.config.length + layout.outcome.length;
}

describe('the basic surface is four questions, not fourteen', () => {
  it('asks for a name, a placement, the family basics and one action — and nothing else', () => {
    for (const family of POLICY_FAMILIES) {
      const policy = defaultPolicy(family) as GuardrailPolicy;
      // Nine is the ceiling today and tool_access is the one that reaches it
      // (six allow/deny fields of its own). A tenth family that arrives with
      // twelve basic fields has not made the split its author thought it made.
      expect(basicControlCount(policy), `${family} asks too much up front`).toBeLessThanOrEqual(9);
    }
  });

  it('every basic family field is one the CATALOG calls basic', () => {
    // The partition is the catalog's (`basicFields` / `advancedFields`), not a
    // filter this screen writes — that is the whole reason a tenth family's
    // split arrives with its fields instead of in a switch somebody forgets.
    for (const family of POLICY_FAMILIES) {
      const policy = defaultPolicy(family) as GuardrailPolicy;
      const layout = policyFormLayout(policy);
      const basic = new Set(basicFields(fieldsOf(family)).map((field) => field.key));
      const advanced = new Set(advancedFields(fieldsOf(family)).map((field) => field.key));
      for (const field of layout.config) expect(basic.has(field.key), field.key).toBe(true);
      for (const field of layout.configAdvanced) expect(advanced.has(field.key), field.key).toBe(true);
    }
  });

  it('leads the action ladder with Block / Redact / Flag, and keeps a stored edge rung visible', () => {
    // The drawer narrows the shared array with `basicOptions` before handing it
    // to the renderer. Three questions become one; five stored values stay five.
    const action = commonField('action');
    expect(action?.kind).toBe('select');
    if (action?.kind !== 'select') throw new Error('action is not a select');
    // Still the SHARED array on the spec — `basicOptions` narrows a copy, and a
    // derived array left on a FAMILY field would silently stop being recognised
    // as an action field by `isOutcomeField`.
    expect(action.options).toBe(SAFETY_ACTION_OPTIONS);

    expect(basicOptions(action.options).map((option) => option.value)).toEqual([
      'block',
      'redact',
      'flag',
    ]);
    // A policy saved with 'warn' opens on a control that can show 'warn',
    // instead of displaying the wrong rung and rewriting it on the next save.
    expect(basicOptions(action.options, 'warn').map((option) => option.value)).toEqual([
      'block',
      'redact',
      'flag',
      'warn',
    ]);
  });
});

describe('policyAdvancedControls — what is behind the chevron', () => {
  it('holds every common field the basic form does not ask for', () => {
    for (const family of POLICY_FAMILIES) {
      const policy = defaultPolicy(family) as GuardrailPolicy;
      const keys = policyAdvancedControls(policy).map((control) => control.key);
      for (const field of visiblePolicyFields(COMMON_POLICY_FIELDS, asFieldConfig(policy))) {
        if (BASIC_COMMON.includes(field.key)) {
          expect(keys, `${family}: ${field.key} is asked twice`).not.toContain(field.key);
          continue;
        }
        // `runIf` is the one legitimate omission, and it is catalog-derived:
        // only the families that call a model read it at all.
        if (field.key === 'runIf' && !familyNeedsModel(family)) {
          expect(keys).not.toContain('runIf');
          continue;
        }
        expect(keys, `${family}: ${field.key} is drawn nowhere`).toContain(field.key);
      }
    }
  });

  it('holds every family field the catalog calls advanced, and each one only once', () => {
    for (const family of POLICY_FAMILIES) {
      const policy = defaultPolicy(family) as GuardrailPolicy;
      const controls = policyAdvancedControls(policy);
      const keys = controls.map((control) => control.key);
      expect(new Set(keys).size, `${family} draws a control twice`).toBe(keys.length);
      for (const field of policyFormLayout(policy).configAdvanced) {
        expect(keys, `${family}: ${field.key}`).toContain(field.key);
      }
    }
  });

  it('offers a failure mode exactly where one can occur', () => {
    // The condition is the catalog's `needsFailMode`, read through the field's
    // own `visibleWhen` rather than restated here — a regex and a word list scan
    // a string in memory, so a failure mode for them is a control for a state
    // that does not happen.
    for (const family of POLICY_FAMILIES) {
      const keys = policyAdvancedControls(defaultPolicy(family) as GuardrailPolicy).map(
        (control) => control.key,
      );
      expect(keys.includes('failMode'), family).toBe(familyNeedsFailMode(family));
    }
  });

  it('always carries the enforcement control and the id', () => {
    for (const family of POLICY_FAMILIES) {
      const controls = policyAdvancedControls(defaultPolicy(family) as GuardrailPolicy);
      expect(controls.find((control) => control.key === 'schedule')?.kind).toBe('enforcement');
      expect(controls.find((control) => control.key === 'id')?.kind).toBe('id');
    }
  });

  it('assigns every control to a band the form actually draws', () => {
    // The failure this catches: a control with a band that is not in
    // `ADVANCED_SECTION_ORDER` renders NOWHERE, and looks from the outside
    // exactly like a control somebody deleted.
    const bands = new Set<string>(ADVANCED_SECTION_ORDER);
    for (const family of POLICY_FAMILIES) {
      const controls = policyAdvancedControls(defaultPolicy(family) as GuardrailPolicy);
      const banded = ADVANCED_SECTION_ORDER.flatMap((section) =>
        advancedSection(controls, section),
      );
      for (const control of controls) {
        expect(bands.has(control.section), `${family}: ${control.key}`).toBe(true);
      }
      // The bands PARTITION the list: nothing drawn twice, nothing dropped.
      expect(banded).toHaveLength(controls.length);
      expect(new Set(banded.map((control) => control.key)).size).toBe(controls.length);
    }
  });

  it('degrades for a family this build does not know, and shows its stored settings anyway', () => {
    const alien = { ...SECRETS, family: 'not_a_family' } as unknown as GuardrailPolicy;
    const keys = policyAdvancedControls(alien).map((control) => control.key);
    // No catalog entry, so no family fields — but every common one is offered,
    // `runIf` included: a policy authored by a newer console should show what it
    // has rather than have it quietly hidden.
    expect(keys).toEqual(['schedule', 'enabled', 'failMode', 'timeoutMs', 'runIf', 'message', 'id']);
  });
});

describe('the enforcement control — one select where there were two', () => {
  it('offers the contract’s three values, strongest first, each with prose', () => {
    expect(ENFORCEMENT_OPTIONS.map((option) => option.value)).toEqual([...GUARDRAIL_ENFORCEMENTS]);
    expect(ENFORCEMENT_OPTIONS.every((option) => Boolean(option.description))).toBe(true);
    // Three, because the type has three. The fourth combination the two selects
    // advertised — async that blocks — is not a setting anybody was refused, it
    // is one that cannot exist: the response has already gone.
    expect(ENFORCEMENT_OPTIONS).toHaveLength(3);
  });

  it('writes the STORED schedule and reads it back unchanged', () => {
    for (const value of GUARDRAIL_ENFORCEMENTS) {
      expect(toEnforcement(fromEnforcement(value))).toBe(value);
    }
    // The mapping the drawer's comment claims, asserted rather than described.
    expect(fromEnforcement('block')).toEqual({ timing: 'sync', onFail: 'block' });
    expect(fromEnforcement('observe')).toEqual({ timing: 'sync', onFail: 'log' });
    expect(fromEnforcement('observe_no_wait')).toEqual({ timing: 'async', onFail: 'log' });
  });

  it('is NOT a catalog field, and must not become one', () => {
    // A field spec binds a control to a stored property of the same shape. This
    // one's screen value is a string and its stored value is an object, so
    // declaring `key: 'schedule'` as a select would write the string straight
    // over `{ timing, onFail }`.
    expect(commonField('schedule')).toBeUndefined();
  });

  it('summarises to a phrase short enough for a badge', () => {
    expect(enforcementSummaryLabel('block')).toBe('Block');
    expect(enforcementSummaryLabel('observe')).toBe('Observe');
    // WAS 'Observe, without waiting', produced by splitting the drawer's own
    // long label on its em-dash. That made the summary a THIRD spelling of this
    // option: the policy cards' badge already read 'Observe, no wait' (the
    // hooks matrix' short register) while this one read 'Observe, without
    // waiting' — two badges for one stored `schedule`, worded differently, in
    // the same feature. The two now come off one table.
    expect(enforcementSummaryLabel('observe_no_wait')).toBe('Observe, no wait');
  });

  /**
   * The property the test above is NAMED for, asserted instead of described —
   * a literal alone would let the next rewording quietly produce a sentence in
   * a badge and still pass by being updated to match.
   */
  it('is the shared short register, and stays badge-width', () => {
    for (const value of GUARDRAIL_ENFORCEMENTS) {
      expect(enforcementSummaryLabel(value)).toBe(ENFORCEMENT_COPY[value].short);
      // Badge-width. The long register is the one with room for a clause, and
      // it is what the SELECT renders; this one has to fit beside a policy name.
      expect(enforcementSummaryLabel(value).length).toBeLessThanOrEqual(20);
      expect(enforcementSummaryLabel(value)).not.toContain('—');
    }
  });

  /**
   * ONE VOCABULARY, which is the whole point of the pass. The drawer's select
   * and the hooks matrix' select used to carry independent phrasings of these
   * three options; both now read from `guardrailVocabulary`, so this pins that
   * they cannot drift apart again without a test failing.
   */
  it('renders the same three options the rest of the feature does', () => {
    expect(ENFORCEMENT_OPTIONS.map((option) => option.value)).toEqual(
      ENFORCEMENT_VOCABULARY.map((entry) => entry.value),
    );
    expect(ENFORCEMENT_OPTIONS.map((option) => option.label)).toEqual(
      ENFORCEMENT_VOCABULARY.map((entry) => entry.long),
    );
  });
});

describe('policyAdvancedChanges — what a closed section admits to', () => {
  it('is silent for a policy straight out of the catalog', () => {
    // The load-bearing case. If a fresh policy showed badges, the badges would
    // mean nothing and the operator would stop reading them.
    for (const family of POLICY_FAMILIES) {
      expect(policyAdvancedChanges(defaultPolicy(family) as GuardrailPolicy), family).toEqual([]);
    }
    expect(policyAdvancedChanges(PII)).toEqual([]);
  });

  it('names a fail mode, an enforcement and a time limit in the control’s own words', () => {
    const changes = policyAdvancedChanges({
      ...PII,
      failMode: 'closed',
      timeoutMs: 2000,
      schedule: { timing: 'sync', onFail: 'log' },
    });
    expect(changes.map((entry) => entry.key).sort()).toEqual(['failMode', 'schedule', 'timeoutMs']);
    // 'Block it', not 'closed': the operator chose a sentence and the database
    // holds a token, and the badge is for the operator.
    expect(changes.find((entry) => entry.key === 'failMode')?.value).toBe('Block it');
    expect(changes.find((entry) => entry.key === 'timeoutMs')?.value).toBe('2000 ms');
    expect(changes.find((entry) => entry.key === 'schedule')?.value).toBe('Observe');
  });

  it('reports a parked policy and a family field left off its default', () => {
    expect(policyAdvancedChanges({ ...PII, enabled: false })).toEqual([
      { key: 'enabled', label: 'Enabled', value: 'off' },
    ]);
    expect(
      policyAdvancedChanges({ ...SECRETS, minEntropy: 4.2 }).map((entry) => entry.value),
    ).toEqual(['4.2 bits/char']);
  });

  it('never badges the id — identity is not a setting', () => {
    expect(policyAdvancedChanges({ ...PII, id: 'renamed' }).map((entry) => entry.key)).not.toContain(
      'id',
    );
  });

  it('over-reports rather than under-reports for a family it has no defaults for', () => {
    // No catalog entry means no `defaults()` to compare against, so anything
    // present counts as set. Over-reporting an unknown policy's settings is the
    // safe direction: the alternative is a badge that goes quiet exactly when
    // the console is least sure what it is looking at.
    const alien = { ...SECRETS, family: 'not_a_family' } as unknown as GuardrailPolicy;
    expect(policyAdvancedChanges(alien).map((entry) => entry.key)).toEqual(['enabled']);
  });

  it('is not fooled by key order or a cleared optional', () => {
    expect(policyAdvancedChanges({ ...PII, failMode: undefined })).toEqual([]);
    expect(policyAdvancedChanges({ ...PII, timeoutMs: undefined })).toEqual([]);
  });
});

describe('describeFieldValue — a badge that says what the control says', () => {
  it('answers with the option label, never the stored token', () => {
    const failMode = commonField('failMode');
    expect(describeFieldValue(failMode, 'closed')).toBe('Block it');
    expect(describeFieldValue(failMode, 'open')).toBe('Let the content through');
  });

  it('reads a switch, a number with its unit, and a list by its size', () => {
    expect(describeFieldValue(commonField('enabled'), true)).toBe('on');
    expect(describeFieldValue(commonField('enabled'), false)).toBe('off');
    expect(describeFieldValue(commonField('timeoutMs'), 250)).toBe('250 ms');
    expect(describeFieldValue(undefined, ['a', 'b'])).toBe('2 entries');
    expect(describeFieldValue(undefined, ['a'])).toBe('1 entry');
    expect(describeFieldValue(undefined, { a: 1 })).toBe('1 entry');
    expect(describeFieldValue(undefined, undefined)).toBe('not set');
  });

  it('truncates prose rather than letting one badge eat the row', () => {
    const long = 'x'.repeat(80);
    expect(describeFieldValue(commonField('message'), long)).toHaveLength(40);
    expect(describeFieldValue(commonField('message'), long).endsWith('…')).toBe(true);
    expect(describeFieldValue(commonField('message'), '  keep   me  ')).toBe('keep me');
  });
});

describe('advancedContentsLine — the closed section’s table of contents', () => {
  const control = (label: string): PolicyAdvancedControl => ({
    key: label,
    label,
    kind: 'field',
    section: 'behaviour',
  });

  it('names them all while there are few enough to read', () => {
    expect(advancedContentsLine([control('How it runs'), control('Id')])).toBe('how it runs, id');
  });

  it('caps the list and counts the remainder', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(control);
    expect(advancedContentsLine(many, 3)).toBe('a, b, c, and 4 more');
  });

  it('says something for every family, because a nameless "Advanced" is a section you open every time', () => {
    for (const family of POLICY_FAMILIES) {
      const controls = policyAdvancedControls(defaultPolicy(family) as GuardrailPolicy);
      const drawn = advancedInDrawOrder(controls);
      // Named in the order they are DRAWN. A table of contents that disagrees
      // with the page it describes is worse than none.
      expect(new Set(drawn.map((control) => control.key))).toEqual(
        new Set(controls.map((control) => control.key)),
      );
      expect(drawn[0].key, family).toBe('schedule');
      expect(advancedContentsLine(drawn).length, family).toBeGreaterThan(0);
    }
  });
});

describe('a disclosure cannot swallow an issue', () => {
  const partition = (policy: GuardrailPolicy) =>
    partitionIssuesByDisclosure(policyAdvancedControls(policy), collectPolicyIssues(policy));

  it('puts the id behind the chevron and the placement in front of it', () => {
    const { basic, advanced } = partition({ ...PII, id: '', hooks: [] });
    expect(advanced.map((issue) => issue.key)).toEqual(['id']);
    expect(basic.map((issue) => issue.key)).toEqual(['hooks']);
  });

  it('loses nothing and duplicates nothing', () => {
    const broken: PiiPolicyConfig = {
      ...PII,
      id: '',
      hooks: [],
      piiPolicyKey: '',
      message: '{{nope}}',
    };
    const issues = collectPolicyIssues(broken);
    const { basic, advanced } = partition(broken);
    expect(basic.length + advanced.length).toBe(issues.length);
    expect(new Set([...basic, ...advanced].map((issue) => issue.key)).size).toBe(issues.length);
    // The block message is behind the disclosure, so its complaint has to be too
    // — otherwise block 4 shows an error for a box that is not on screen.
    expect(advanced.map((issue) => issue.key).sort()).toEqual(['id', 'message']);
  });

  it('catches a REQUIRED advanced field, which is why the section opens itself', () => {
    // `validatePolicyFields` never reads `advanced`, so an advanced field can be
    // required and can fail — `custom.onMissingModel` is exactly that.
    const custom = { ...(defaultPolicy('custom') as GuardrailPolicy) } as Record<string, unknown>;
    delete custom.onMissingModel;
    const policy = custom as unknown as GuardrailPolicy;

    const { basic, advanced } = partition(policy);
    expect(advanced.map((issue) => issue.key)).toContain('onMissingModel');
    // …and the family's own required basics stay where the operator can see them.
    expect(basic.map((issue) => issue.key)).toContain('modelKey');
  });

  it('keeps a nested issue with the list that owns it', () => {
    // `regex.rules` is basic, so a broken rule is a basic issue.
    const broken: RegexPolicyConfig = {
      ...REGEX,
      rules: [{ ...REGEX.rules[0], pattern: '([unclosed' }],
    };
    expect(partition(broken).basic.map((issue) => issue.key)).toContain('rules[0].pattern');

    // The rule is the predicate, not the family: were `rules` ever marked
    // advanced, its rows would follow it behind the chevron rather than
    // reporting against a control that is no longer on screen.
    const asAdvanced: PolicyAdvancedControl[] = [
      { key: 'rules', label: 'Rules', kind: 'field', section: 'family' },
    ];
    expect(
      isAdvancedIssue(asAdvanced, {
        key: 'rules[0].pattern',
        label: 'Rules',
        message: '',
        reason: 'invalid',
      }),
    ).toBe(true);
    // …and a key that merely starts with the same letters is not a match.
    expect(
      isAdvancedIssue(asAdvanced, { key: 'rulesets', label: '', message: '', reason: 'invalid' }),
    ).toBe(false);
  });
});

// ═══ 2. WHERE IT RUNS ═══════════════════════════════════════════════════════

describe('policyHookOptions — a disabled toggle always says why', () => {
  it('returns one option per hook, in pipeline order', () => {
    expect(policyHookOptions(PII).map((option) => option.hook)).toEqual([...HOOK_IDS]);
  });

  it('never disables a hook without a reason', () => {
    for (const family of POLICY_FAMILIES) {
      for (const option of policyHookOptions(defaultPolicy(family) as GuardrailPolicy)) {
        if (option.eligible) continue;
        expect(option.reason, `${family} @ ${option.hook}`).toBeTruthy();
        // The row's own description carries it too, because a tooltip on a
        // disabled control is not always reachable.
        expect(option.description).toBe(option.reason);
      }
    }
  });

  it('marks a bound-but-switched-off hook without disabling it', () => {
    const bindings: Partial<Record<HookId, HookBinding>> = {
      'output.pre': { enabled: false } as HookBinding,
    };
    const option = policyHookOptions(PII, bindings).find((entry) => entry.hook === 'output.pre');
    expect(option?.checked).toBe(true);
    expect(option?.eligible).toBe(true);
    expect(option?.hookDisabled).toBe(true);
    expect(option?.description).toContain('switched off on the Hooks tab');
  });

  it('does not nag about a switched-off hook for a disabled policy', () => {
    // A parked policy runs nowhere by design; telling the operator its hook is
    // off is noise about a state they chose.
    const bindings: Partial<Record<HookId, HookBinding>> = {
      'output.pre': { enabled: false } as HookBinding,
    };
    const option = policyHookOptions({ ...PII, enabled: false }, bindings).find(
      (entry) => entry.hook === 'output.pre',
    );
    expect(option?.hookDisabled).toBe(false);
  });

  it('degrades instead of throwing for a family this build does not know', () => {
    // `familyMeta` indexes a frozen record and `canBindToHook` dereferences the
    // result, so an unknown family used to be a TypeError thrown from inside the
    // render — i.e. an operator with no way to even READ the policy. It happens:
    // an older console rendering hooks a newer one authored.
    expect(isKnownFamily('pii')).toBe(true);
    expect(isKnownFamily('not_a_family')).toBe(false);

    const alien = { ...SECRETS, family: 'not_a_family' } as unknown as GuardrailPolicy;
    const options = policyHookOptions(alien);
    expect(options).toHaveLength(HOOK_IDS.length);
    expect(options.every((option) => !option.eligible)).toBe(true);
    for (const option of options) {
      expect(option.reason).toContain('not_a_family');
    }
  });

  it('refuses the streaming hook for an unbounded regex rule, and allows a bounded one', () => {
    const streaming = (policy: RegexPolicyConfig) =>
      policyHookOptions(policy).find((option) => option.hook === 'output.stream.delta');

    expect(streaming(REGEX)?.eligible).toBe(true);

    const unbounded: RegexPolicyConfig = { ...REGEX, rules: [unboundedRule()] };
    expect(streaming(unbounded)?.eligible).toBe(false);
    expect(streaming(unbounded)?.reason).toContain('maxMatchChars');
  });
});

// ═══ 3. VALIDATION AGGREGATION ══════════════════════════════════════════════

describe('collectPolicyIssues', () => {
  it('is silent on a fully configured policy', () => {
    expect(collectPolicyIssues(PII)).toEqual([]);
    expect(collectPolicyIssues(SECRETS)).toEqual([]);
    expect(collectPolicyIssues(REGEX)).toEqual([]);
  });

  it('reports a missing id against identity and a missing hook against placement', () => {
    const issues = collectPolicyIssues({ ...PII, id: '', hooks: [] });
    expect(issuesForSection(issues, 'identity').map((issue) => issue.key)).toEqual(['id']);
    expect(issuesForSection(issues, 'placement').map((issue) => issue.key)).toEqual(['hooks']);
  });

  it('reports a required family field only while the policy is enabled', () => {
    const blank = { ...PII, piiPolicyKey: '' };
    const enabled = collectPolicyIssues(blank);
    expect(enabled.map((issue) => issue.key)).toContain('piiPolicyKey');
    expect(enabled.find((issue) => issue.key === 'piiPolicyKey')?.reason).toBe('required');
    expect(enabled.find((issue) => issue.key === 'piiPolicyKey')?.section).toBe('config');

    // Mirrors the server exactly: a disabled policy's configuration is not
    // validated, so a half-built one can be parked instead of finished or
    // thrown away.
    expect(
      collectPolicyIssues({ ...blank, enabled: false }).map((issue) => issue.key),
    ).not.toContain('piiPolicyKey');
  });

  it('reports a MALFORMED value even while disabled', () => {
    // Wrong is wrong whether or not it runs today, and nobody should be
    // surprised by it the day they switch the policy back on.
    const broken: RegexPolicyConfig = {
      ...REGEX,
      enabled: false,
      rules: [{ ...REGEX.rules[0], pattern: '([unclosed' }],
    };
    const issues = collectPolicyIssues(broken);
    const rule = issues.find((issue) => issue.key === 'rules[0].pattern');
    expect(rule?.reason).toBe('invalid');
    expect(rule?.section).toBe('config');
    // Named per rule, so an operator with twelve rules knows which one.
    expect(rule?.label).toContain('case number');
  });

  it('reports an ineligible bound hook with the reason canBindToHook gives', () => {
    const unbounded: RegexPolicyConfig = {
      ...REGEX,
      hooks: ['output.pre', 'output.stream.delta'],
      rules: [unboundedRule()],
    };
    const placement = issuesForSection(collectPolicyIssues(unbounded), 'placement');
    expect(placement).toHaveLength(1);
    expect(placement[0].message).toContain('output.stream.delta');
    expect(placement[0].message).toContain('maxMatchChars');
  });

  it('reports a plaintext webhook url', () => {
    const issues = collectPolicyIssues({ ...WEBHOOK, url: 'http://example.test/guardrail' });
    const url = issues.find((issue) => issue.key === 'url');
    expect(url?.reason).toBe('invalid');
    expect(url?.message).toContain('https');
  });

  it('rejects an unknown template variable in the block message, and says which', () => {
    // The rule the client-side validator on the old editor does not have. The
    // interpolator leaves an unknown `{{var}}` verbatim, which is the right
    // RENDER behaviour and the wrong thing to discover in a stranger's chat.
    const issues = collectPolicyIssues({ ...PII, message: 'Blocked {{value}} at {{traceId}}.' });
    const message = issuesForSection(issues, 'message');
    expect(message).toHaveLength(1);
    expect(message[0].message).toContain('{{value}}');
    expect(message[0].message).not.toContain('{{traceId}}');
  });

  it('accepts every variable the contract allows', () => {
    const every = BLOCK_MESSAGE_VARS.map((name) => `{{${name}}}`).join(' ');
    expect(collectPolicyIssues({ ...PII, message: every })).toEqual([]);
  });

  it('validates the message rule for a DISABLED policy too', () => {
    expect(
      issuesForSection(
        collectPolicyIssues({ ...PII, enabled: false, message: '{{nope}}' }),
        'message',
      ),
    ).toHaveLength(1);
  });

  it('every default policy reports only required issues, never invalid ones', () => {
    // The catalog has no tenant, so a fresh policy legitimately opens missing a
    // PII policy key or a model. An INVALID issue on a value the catalog itself
    // produced would be a bug in the catalog.
    for (const family of POLICY_FAMILIES) {
      const issues = collectPolicyIssues(defaultPolicy(family) as GuardrailPolicy);
      expect(
        issues.filter((issue) => issue.reason === 'invalid'),
        `${family}: ${JSON.stringify(issues)}`,
      ).toEqual([]);
    }
  });

  it('a family with no catalog entry still validates its identity and hooks', () => {
    const alien = { ...SECRETS, family: 'not_a_family', id: '', hooks: [] } as unknown as GuardrailPolicy;
    const issues = collectPolicyIssues(alien);
    expect(issues.map((issue) => issue.section).sort()).toEqual(['identity', 'placement']);
  });
});

describe('unknownMessageVars', () => {
  it('finds each unknown name once, and tolerates spacing', () => {
    expect(unknownMessageVars('{{ value }} and {{value}} and {{ other }}')).toEqual([
      'value',
      'other',
    ]);
  });

  it('is empty for nothing, for plain text and for a known set', () => {
    expect(unknownMessageVars(undefined)).toEqual([]);
    expect(unknownMessageVars('')).toEqual([]);
    expect(unknownMessageVars('no variables at all')).toEqual([]);
    expect(unknownMessageVars('{{guardrailName}} {{traceId}}')).toEqual([]);
  });

  it('ignores something that is not a variable reference', () => {
    expect(unknownMessageVars('{ single } and {{ 9lives }} and {{}}')).toEqual([]);
  });
});

// ═══ 4. THE MESSAGE-INHERITANCE LABEL ═══════════════════════════════════════

describe('describeMessageInheritance', () => {
  const workspace: BlockedMessageSettings = {
    templates: { pii: 'Our own wording for personal data.' },
  };

  it('says INHERITED when the policy has no message of its own', () => {
    const described = describeMessageInheritance({ policy: PII });
    expect(described.overridden).toBe(false);
    expect(described.statusLabel).toBe('Inherited from the Personal data default');
    expect(described.canReset).toBe(false);
    expect(described.inheritedFrom).toBe('builtin');
    expect(described.effective).toBe(described.placeholder);
    expect(described.effective).toContain('personal information');
  });

  it('names the workspace row an inherited message came from', () => {
    const described = describeMessageInheritance({ policy: PII, settings: workspace });
    expect(described.overridden).toBe(false);
    expect(described.inheritedFrom).toBe('category');
    expect(described.inheritedFromLabel).toBe('the “Personal data” message on the Messages tab');
    expect(described.statusHelp).toContain('Messages tab');
    expect(described.effective).toBe('Our own wording for personal data.');
  });

  it('says OVERRIDDEN when the policy carries its own, and keeps the inherited one as the placeholder', () => {
    const described = describeMessageInheritance({
      policy: { ...PII, message: 'Mine only.' },
      settings: workspace,
    });
    expect(described.overridden).toBe(true);
    expect(described.statusLabel).toBe('This policy overrides it');
    expect(described.canReset).toBe(true);
    expect(described.effective).toBe('Mine only.');
    // Reset has to restore something real, and the placeholder is the promise
    // of what it restores. Computing it any other way would mean the drawer
    // describing a resolution the engine does not perform.
    expect(described.placeholder).toBe('Our own wording for personal data.');
    expect(described.statusHelp).toContain('Clear the box');
  });

  it('treats a blank message as inherit, not as an empty message', () => {
    // The engine SKIPS a whitespace layer, so clearing the box restores the
    // inherited wording rather than shipping an end user nothing. The label has
    // to agree with that or Reset looks like it did not work.
    const described = describeMessageInheritance({ policy: { ...PII, message: '   ' } });
    expect(described.overridden).toBe(false);
    expect(described.statusLabel).toBe('Inherited from the Personal data default');
  });

  it('is the answer to the problem the field was added for', () => {
    // regex, custom and webhook all land on 'custom'. Before `policy.message`,
    // editing "the regex policy's message" rewrote the webhook policy's too.
    expect(BLOCK_REASON_FOR_FAMILY.regex).toBe('custom');
    expect(BLOCK_REASON_FOR_FAMILY.webhook).toBe('custom');

    const settings: BlockedMessageSettings = { templates: { custom: 'Workspace voice.' } };
    const regex = describeMessageInheritance({
      policy: { ...REGEX, message: 'A case number was in there.' },
      settings,
    });
    const webhook = describeMessageInheritance({ policy: WEBHOOK, settings });

    expect(regex.effective).toBe('A case number was in there.');
    expect(webhook.effective).toBe('Workspace voice.');
    expect(regex.overridden).toBe(true);
    expect(webhook.overridden).toBe(false);
  });

  it('names the neighbours that share the reason class, and nothing else', () => {
    const described = describeMessageInheritance({ policy: REGEX });
    expect(described.sharedWith.sort()).toEqual(['custom', 'webhook']);
    expect(described.sharedWith).not.toContain('regex');
    // A family that owns its reason class alone has no neighbours to warn about.
    expect(describeMessageInheritance({ policy: PII }).sharedWith).toEqual([]);
  });

  it('the in-process byPolicy map stays BELOW the workspace category layer', () => {
    // Different things despite the similar name: that map is assembled by a
    // caller describing somebody else's policies (a preset, a red-team
    // preview), and letting a preset outrank a workspace's own voice is the
    // inversion the order exists to prevent.
    const described = describeMessageInheritance({
      policy: PII,
      settings: { templates: { pii: 'Workspace wording.' } },
      templates: { byPolicy: { 'pii-outbound': 'Preset wording.' } },
    });
    expect(described.effective).toBe('Workspace wording.');
    expect(described.inheritedFrom).toBe('category');
  });

  it('has a label for every reason class, and a source label for every source', () => {
    for (const family of POLICY_FAMILIES) {
      const reason = BLOCK_REASON_FOR_FAMILY[family];
      expect(BLOCK_REASON_LABEL[reason], `no label for ${reason}`).toBeTruthy();
    }
    for (const source of [
      'policy',
      'locale_category',
      'locale_policy',
      'locale_default',
      'category',
      'policy_template',
      'default',
      'builtin',
    ] as const) {
      expect(blockMessageSourceLabel(source, 'pii')).toBeTruthy();
    }
    // Every source label names a place, so "inherited from …" is actionable.
    expect(blockMessageSourceLabel('category', 'secrets')).toContain('Credentials');
    expect(blockMessageSourceLabel('builtin', 'injection')).toContain('built-in');
  });
});

// ═══ 5. THE DRAFT ═══════════════════════════════════════════════════════════

describe('policyDraftIsDirty — what "ask before closing" is built on', () => {
  it('is false for the same policy and for a re-keyed clone', () => {
    expect(policyDraftIsDirty(PII, { ...PII })).toBe(false);
    const reordered = Object.fromEntries(
      Object.entries(PII).reverse(),
    ) as unknown as GuardrailPolicy;
    expect(policyDraftIsDirty(PII, reordered)).toBe(false);
  });

  it('treats a cleared optional as unchanged, not as an edit', () => {
    // Otherwise every drawer that so much as touches a select nags on close.
    expect(policyDraftIsDirty(PII, { ...PII, action: undefined })).toBe(false);
  });

  it('sees a real edit, including one nested inside a rule', () => {
    expect(policyDraftIsDirty(PII, { ...PII, action: 'block' })).toBe(true);
    expect(policyDraftIsDirty(PII, { ...PII, message: 'x' })).toBe(true);
    expect(
      policyDraftIsDirty(REGEX, {
        ...REGEX,
        rules: [{ ...REGEX.rules[0], maxMatchChars: 64 }],
      }),
    ).toBe(true);
  });

  it('sees a hook added or removed', () => {
    expect(policyDraftIsDirty(PII, { ...PII, hooks: ['output.pre', 'input.pre'] })).toBe(true);
    // Order is meaning here — `hooks` is a list the operator sees — so it is
    // NOT sorted away.
    expect(policyDraftIsDirty(SECRETS, { ...SECRETS, hooks: ['output.pre', 'input.pre'] })).toBe(true);
  });
});

// ═══ 6. THE RENDERER'S OWN HELPERS ══════════════════════════════════════════

describe('PolicyFieldRenderer helpers', () => {
  it('builds the path validatePolicyFields keys nested issues by', () => {
    // These two must agree exactly or every nested error renders in the summary
    // list and none of them appears under the box the operator is looking at.
    expect(fieldPath(undefined, 'pattern')).toBe('pattern');
    expect(fieldPath('rules[0]', 'pattern')).toBe('rules[0].pattern');

    const issues = collectPolicyIssues({
      ...REGEX,
      rules: [{ ...REGEX.rules[0], pattern: '([unclosed' }],
    });
    expect(issueForField(issues, 'rules[0]', 'pattern')).toBeDefined();
    expect(issueForField(issues, 'rules[1]', 'pattern')).toBeUndefined();
    expect(issueForField(issues, undefined, 'pattern')).toBeUndefined();
  });

  it('renders an unset switch at its documented default, not at off', () => {
    // The whole reason `defaultValue` is mandatory on the spec: three of the
    // catalog's booleans are TRUE when absent, and a control that draws unset as
    // off turns two security-relevant defaults off on the first save.
    expect(switchValue(undefined, true)).toBe(true);
    expect(switchValue(undefined, false)).toBe(false);
    expect(switchValue(false, true)).toBe(false);
    expect(switchValue(true, false)).toBe(true);

    const obfuscated = fieldsOf('pii').find((field) => field.key === 'detectObfuscated');
    expect(obfuscated?.kind).toBe('switch');
    expect(obfuscated?.kind === 'switch' && obfuscated.defaultValue).toBe(true);
  });

  it('round-trips a numeric option value through the DOM', () => {
    // `webhook.retries` is genuinely `0 | 1 | 2`, and the DOM only speaks
    // strings. Storing `"0"` would fail the shape validator.
    const retries = fieldsOf('webhook').find((field) => field.key === 'retries');
    expect(retries?.kind).toBe('select');
    if (retries?.kind !== 'select') throw new Error('retries is not a select');

    expect(selectData(retries.options).map((option) => option.value)).toEqual(['0', '1', '2']);
    expect(optionValueOf(retries.options, '0')).toBe(0);
    expect(typeof optionValueOf(retries.options, '2')).toBe('number');
    expect(optionValueOf(retries.options, null)).toBeUndefined();
    expect(optionValueOf(retries.options, 'nonsense')).toBeUndefined();
  });

  it('places a number field with no value where its meaning is', () => {
    expect(numberPlaceholder({ defaultValue: 3.5, unit: 'bits/char' })).toBe('3.5 bits/char');
    expect(numberPlaceholder({ zeroMeans: 'no limit' })).toBe('no limit');
    expect(numberPlaceholder({})).toBeUndefined();
  });

  it('reads a record and refuses to read an array as one', () => {
    expect(recordEntries({ a: 1, b: 2 })).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(recordEntries([])).toEqual([]);
    expect(recordEntries(null)).toEqual([]);
    expect(recordEntries('x')).toEqual([]);
  });

  it('renames a key IN PLACE', () => {
    // delete + re-add sends the row to the bottom of the list mid-keystroke,
    // which reads as the form losing it.
    expect(Object.keys(renameKey({ a: 1, b: 2, c: 3 }, 'b', 'z'))).toEqual(['a', 'z', 'c']);
    expect(renameKey({ a: 1 }, 'a', 'a')).toEqual({ a: 1 });
  });
});

// ═══ 7. THE GENERIC-RENDERER CONTRACT ═══════════════════════════════════════

describe('the drawer stays generic', () => {
  it('every field kind the catalog uses is one the renderer switches on', () => {
    // The renderer's switch is exhaustive over `PolicyFieldSpec['kind']` at
    // compile time; this is the runtime half — a kind that reaches a policy
    // form with no arm would render as "no control in this version", which is a
    // setting an operator can neither see nor change.
    const used = new Set<string>();
    const walk = (fields: readonly PolicyFieldSpec[]) => {
      for (const field of fields) {
        used.add(field.kind);
        if (field.kind === 'item_list') walk(field.itemFields);
      }
    };
    for (const family of POLICY_FAMILIES) walk(fieldsOf(family));
    walk(
      ['label', 'enabled', 'action', 'failMode', 'timeoutMs', 'runIf', 'message', 'hooks']
        .map((key) => commonField(key))
        .filter((field): field is PolicyFieldSpec => field !== undefined),
    );

    const RENDERED = new Set([
      'text',
      'textarea',
      'number',
      'switch',
      'select',
      'multi_select',
      'string_list',
      'flag_map',
      'key_value',
      'key_enum',
      'key_list',
      'item_list',
      'reference',
      'json',
    ]);
    for (const kind of used) expect(RENDERED.has(kind), `no control for kind "${kind}"`).toBe(true);
  });

  it('a family the drawer has never seen still gets a full form from its spec', () => {
    // The extension-point assertion. Nothing about the shape of a policy form
    // is written down in the drawer; it is all read from the catalog entry.
    for (const family of POLICY_FAMILIES) {
      const spec = catalogFor(family);
      expect(spec).toBeDefined();
      const layout = policyFormLayout(defaultPolicy(family) as GuardrailPolicy);
      const total = layout.config.length + layout.configAdvanced.length + layout.outcome.length;
      const visible = visiblePolicyFields(
        spec!.fields,
        asFieldConfig(defaultPolicy(family) as GuardrailPolicy),
      ).length;
      expect(total).toBe(visible);
    }
  });
});
