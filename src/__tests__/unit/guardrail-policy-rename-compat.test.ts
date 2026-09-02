/**
 * The `check` -> `policy` rename's COMPATIBILITY RULE, pinned end to end.
 *
 * WHY THIS FILE EXISTS. The rename touched three names that are on disk, not
 * just in the source: the policy array (`hooks.checks`), the tool-gate family
 * (`tool_policy`) and the PII policy reference (`policyKey`). Every guardrail a
 * tenant authored before it still carries those, and the failure mode is
 * SILENT and total — `ensureHooks` sees no `hooks.policies`, decides the config
 * was never authored, and lifts the legacy preset columns over the top of it.
 * The guardrail keeps evaluating; it just stops evaluating what the operator
 * configured, and the dashboard reports "0 policies" while doing so.
 *
 * So the rule is: the READ path accepts both spellings and normalises to the
 * new one, the WRITE path emits only the new one, and nothing rewrites a stored
 * row. The fixtures below are deliberately in the OLD spelling — a fixture
 * written in the new one proves nothing about the rows that exist today.
 *
 * `normalizeHooksConfig` is the single implementation; `ensureHooks`,
 * `serializeGuardrail` and `readHooksField` are the three doors that call it,
 * and each is covered here because each is the ONLY door for one caller (the
 * engine, the dashboard, the two write APIs respectively).
 */

import { describe, expect, it, vi } from 'vitest';

// Sync factory only: an async `vi.mock` factory does not intercept in this
// repo. `hooks/legacy` and `guardrailService` reach the barrel, which
// constructs providers and registers shutdown handlers the moment it loads.
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
  runWithTenantScope: vi.fn(),
}));

import {
  LEGACY_POLICY_FAMILY,
  normalizeHooksConfig,
  readPolicyFamily,
  readPolicyId,
  readPolicyList,
} from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailHooksConfig } from '@/lib/services/guardrail/hooks/contract';
import { ensureHooks } from '@/lib/services/guardrail/hooks/legacy';
import { serializeGuardrail } from '@/lib/services/guardrail/guardrailService';
import { readHooksField } from '@/server/api/plugins/guardrails';
import type { IGuardrail } from '@/lib/database/provider/types.domain';
import type { GuardrailPolicy, PiiPolicyConfig } from '@/lib/services/guardrail/hooks/contract';
import {
  describePolicyCard,
  filterPolicyCards,
} from '@/components/guardrails/GuardrailPolicyCards';
import {
  collectPolicyIssues,
  policyFormLayout,
} from '@/components/guardrails/GuardrailPolicyDrawer';
import {
  referencedResourceKeys,
  withReferencedKeys,
} from '@/components/guardrails/policyResources';
import type { PolicyFieldResources } from '@/components/guardrails/PolicyFieldRenderer';

/**
 * A hook config EXACTLY as a build before the rename wrote it: `checks`, not
 * `policies`; `tool_policy`, not `tool_access`; `policyKey`, not
 * `piiPolicyKey`. Returned fresh each time because the assertions mutate
 * nothing but the callers must not share a frozen fixture.
 */
function storedInOldSpelling(): Record<string, unknown> {
  return {
    contractVersion: 2,
    checks: [
      {
        id: 'chk-pii',
        family: 'pii',
        enabled: true,
        hooks: ['input.pre'],
        schedule: { timing: 'sync', onFail: 'block' },
        policyKey: 'customer-pii',
      },
      {
        id: 'chk-tools',
        family: 'tool_policy',
        enabled: true,
        hooks: ['tool.pre'],
        schedule: { timing: 'sync', onFail: 'block' },
        deny: ['shell.exec'],
      },
    ],
    bindings: {
      'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
      'tool.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
    },
  };
}

function legacyRecord(hooks: unknown): IGuardrail {
  return {
    tenantId: 'tenant-1',
    key: 'gr-renamed',
    name: 'Renamed',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    hooks: hooks as GuardrailHooksConfig,
    hooksVersion: 2,
    createdBy: 'user-1',
  };
}

describe('normalizeHooksConfig: the stored spellings', () => {
  it('lifts `checks` onto `policies` and drops the old key', () => {
    const normalized = normalizeHooksConfig(storedInOldSpelling());
    expect(Array.isArray(normalized.policies)).toBe(true);
    expect((normalized.policies as unknown[]).length).toBe(2);
    expect(normalized.checks).toBeUndefined();
  });

  it('renames the tool_policy family to tool_access', () => {
    const normalized = normalizeHooksConfig(storedInOldSpelling());
    const families = (normalized.policies as Array<{ family: string }>).map((p) => p.family);
    expect(families).toEqual(['pii', 'tool_access']);
    // The map is the single source of the old->new spelling, so a second
    // legacy family added later cannot be handled in one place and missed in
    // another.
    expect(LEGACY_POLICY_FAMILY.tool_policy).toBe('tool_access');
  });

  it('renames the pii policy reference to piiPolicyKey', () => {
    const normalized = normalizeHooksConfig(storedInOldSpelling());
    const pii = (normalized.policies as Array<Record<string, unknown>>)[0];
    expect(pii.piiPolicyKey).toBe('customer-pii');
    expect(pii.policyKey).toBeUndefined();
  });

  it('does not touch a config already in the new spelling, and returns it BY IDENTITY', () => {
    // Identity matters twice: records come out of a TTL cache that is frozen
    // outside production, and this runs on the read path of every hook call.
    const current = {
      contractVersion: 2,
      policies: [{ id: 'p', family: 'secrets', enabled: true, hooks: ['output.pre'] }],
      bindings: {},
    };
    expect(normalizeHooksConfig(current)).toBe(current);
  });

  it('never mutates the input', () => {
    const stored = storedInOldSpelling();
    const before = JSON.stringify(stored);
    normalizeHooksConfig(stored);
    expect(JSON.stringify(stored)).toBe(before);
  });

  it('prefers `policies` when a round-trip left both keys behind', () => {
    const both = { policies: [{ id: 'new' }], checks: [{ id: 'old' }] };
    const normalized = normalizeHooksConfig(both);
    expect((normalized.policies as Array<{ id: string }>)[0].id).toBe('new');
  });

  it('passes non-configs straight through', () => {
    expect(normalizeHooksConfig(undefined)).toBeUndefined();
    expect(normalizeHooksConfig(null)).toBeNull();
    // No usable array under either name: the callers all read that as "no
    // authored config", and inventing one here would hide it.
    const empty = { contractVersion: 2, bindings: {} };
    expect(normalizeHooksConfig(empty)).toBe(empty);
  });
});

describe('readPolicyList', () => {
  it('reads either spelling and rejects anything that is not an array', () => {
    expect(readPolicyList({ policies: [1] })).toEqual([1]);
    expect(readPolicyList({ checks: [2] })).toEqual([2]);
    expect(readPolicyList({ checks: 'nope' })).toBeUndefined();
    expect(readPolicyList(null)).toBeUndefined();
  });
});

describe('ensureHooks: the engine read path', () => {
  it('keeps an old-spelling AUTHORED config authored, re-spelled', () => {
    const resolved = ensureHooks(legacyRecord(storedInOldSpelling()));
    // hooksVersion 2, not 0: dropping to 0 is the silent disaster — it means
    // the lift replaced the operator's configuration with the preset columns.
    expect(resolved.hooksVersion).toBe(2);
    expect(resolved.hooks.policies.map((p) => p.id)).toEqual(['chk-pii', 'chk-tools']);
    expect(resolved.hooks.policies[1].family).toBe('tool_access');
    const pii = resolved.hooks.policies[0];
    expect(pii.family === 'pii' ? pii.piiPolicyKey : undefined).toBe('customer-pii');
  });

  it('still lifts a genuinely unauthored row', () => {
    const record = legacyRecord(undefined);
    record.hooksVersion = 0;
    record.policy = { pii: { enabled: true, action: 'block', categories: { email: true } } };
    const resolved = ensureHooks(record);
    expect(resolved.hooksVersion).toBe(0);
    expect(resolved.hooks.policies.some((p) => p.id === 'legacy:pii')).toBe(true);
  });
});

describe('serializeGuardrail: every view the dashboard and the APIs return', () => {
  it('re-spells the config so a list page counting `hooks.policies` sees them', () => {
    const view = serializeGuardrail(legacyRecord(storedInOldSpelling()));
    expect(view.hooks?.policies).toHaveLength(2);
    expect((view.hooks as unknown as Record<string, unknown>).checks).toBeUndefined();
  });

  it('leaves an absent config absent rather than adding an explicit undefined', () => {
    const record = legacyRecord(undefined);
    delete record.hooks;
    const view = serializeGuardrail(record);
    expect('hooks' in view).toBe(false);
  });
});

describe('readHooksField: the write path', () => {
  it('accepts a body from a pre-rename client and persists the NEW spelling', () => {
    const body: Record<string, unknown> = { hooks: storedInOldSpelling() };
    const result = readHooksField(body);
    expect(result.errors).toBeUndefined();
    expect(result.hooks?.policies.map((p) => p.family)).toEqual(['pii', 'tool_access']);
    // The stored blob is the object this returns, so the old key must be gone
    // from it — otherwise the next read would find both.
    expect((result.hooks as unknown as Record<string, unknown>).checks).toBeUndefined();
  });

  it('still names the field `hooks.policies` when neither spelling is an array', () => {
    expect(readHooksField({ hooks: { bindings: {} } }).errors).toEqual([
      'hooks.policies must be an array',
    ]);
  });

  /**
   * THE WITHDRAWN LANE FIELDS TAKE THE SAME DOOR. `policy.layer` and
   * `hooks.layerSettings` were persisted inside this blob while the policy-lane
   * model existed, so they are on disk exactly as `hooks.checks` is — and they
   * set the same trap: a dashboard that GETs a guardrail and PATCHes it back
   * would write them straight in again, forever, if the write door did not drop
   * them. `normalizeHooksConfig` is the one implementation, so this is the same
   * rule as above rather than a second one; what is pinned here is that the
   * WRITE door actually calls it.
   */
  it('drops the withdrawn lane fields from a body that round-tripped an old row', () => {
    const body: Record<string, unknown> = {
      hooks: {
        contractVersion: 2,
        policies: [
          {
            id: 'chk-pii',
            family: 'pii',
            enabled: true,
            hooks: ['input.pre'],
            schedule: { timing: 'sync', onFail: 'block' },
            piiPolicyKey: 'customer-pii',
            layer: 20,
          },
        ],
        bindings: {
          'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
        },
        layerSettings: { 20: { stopOnBlock: false, label: 'Deterministic' } },
      },
    };

    const result = readHooksField(body);

    expect(result.errors).toBeUndefined();
    const stored = result.hooks as unknown as Record<string, unknown>;
    expect('layerSettings' in stored).toBe(false);
    const policy = result.hooks?.policies[0] as unknown as Record<string, unknown>;
    expect('layer' in policy).toBe(false);
    // The rest of the policy is untouched — this is a field withdrawal, not a
    // rewrite of the row.
    expect(policy.id).toBe('chk-pii');
    expect(policy.family).toBe('pii');
  });
});

describe('the wire: findings, mutations and degraded entries', () => {
  it('reads a policy id under either name', () => {
    expect(readPolicyId({ policyId: 'p1' })).toBe('p1');
    expect(readPolicyId({ checkId: 'c1' })).toBe('c1');
    expect(readPolicyId({ policyId: 'p1', checkId: 'c1' })).toBe('p1');
    expect(readPolicyId({})).toBe('');
  });

  it('reads a family under either name and rejects an unknown one', () => {
    expect(readPolicyFamily('tool_policy')).toBe('tool_access');
    expect(readPolicyFamily('tool_access')).toBe('tool_access');
    expect(readPolicyFamily('word_filter')).toBe('word_filter');
    expect(readPolicyFamily('not_a_family')).toBeUndefined();
    expect(readPolicyFamily(undefined)).toBeUndefined();
  });
});

/**
 * THE SCREENS, driven from a row in the OLD spelling.
 *
 * Everything above proves the normaliser and its three doors. None of it
 * proves the thing a customer would actually hit, because the Config tab was
 * rebuilt AFTER the rename: cards, a catalog and a drawer that read a policy's
 * `family` to find its catalog entry and its field schema. A `tool_policy`
 * reaching `catalogFor` finds nothing and degrades to an empty form; a
 * `policyKey` that never became `piiPolicyKey` is a reference the field schema
 * cannot see, so the drawer draws an EMPTY select over a policy that is still
 * scanning through that PII policy — and the fix an operator reaches for
 * overwrites a setting they were never shown.
 *
 * Neither failure raises anything. Both are invisible until a customer opens
 * the screen, which is why the chain is asserted here from the stored blob all
 * the way to the card and the form, rather than stopping at the normaliser.
 */
describe('a guardrail authored before the rename, as its screens render it', () => {
  /**
   * The read path every dashboard screen is behind.
   *
   * THE LENGTH ASSERTION IS LOAD-BEARING, not a sanity check. The failure this
   * whole block exists to catch makes this list EMPTY, and every assertion
   * below iterates it — so without this, three of them would pass vacuously
   * over zero policies and report the screens healthy at the exact moment they
   * render nothing. Verified by breaking `normalizeHooksConfig`: with it, the
   * loops fail; without it, they passed.
   */
  function policiesAsRendered(): GuardrailPolicy[] {
    const view = serializeGuardrail(legacyRecord(storedInOldSpelling()));
    const policies = (view.hooks?.policies ?? []) as GuardrailPolicy[];
    expect(policies).toHaveLength(2);
    return policies;
  }

  it('arrives with BOTH policies, re-spelled, and nothing lifted over them', () => {
    const view = serializeGuardrail(legacyRecord(storedInOldSpelling()));
    // hooksVersion 2 must survive: dropping to 0 is the silent disaster, and
    // it is what the card grid reads to decide a policy is "migrated".
    expect(view.hooksVersion).toBe(2);
    const policies = policiesAsRendered();
    expect(policies.map((policy) => policy.id)).toEqual(['chk-pii', 'chk-tools']);
    expect(policies.map((policy) => policy.family)).toEqual(['pii', 'tool_access']);
  });

  it('renders a real card per policy — a known family, a label and a summary', () => {
    for (const policy of policiesAsRendered()) {
      const card = describePolicyCard(policy, { guardrailAction: 'block' });
      expect(card.family).toBe(policy.family);
      // The catalog's own copy. An unknown family degrades to a blank label and
      // an empty summary, which is exactly how `tool_policy` would arrive.
      expect(card.familyLabel.trim()).not.toBe('');
      expect(card.summary.trim()).not.toBe('');
      expect(card.icon.trim()).not.toBe('');
      expect(card.hooks.length).toBeGreaterThan(0);
      expect(card.noHook).toBe(false);
    }
  });

  it('summarises the tool gate from the config the operator actually stored', () => {
    const tools = policiesAsRendered()[1];
    const card = describePolicyCard(tools, { guardrailAction: 'block' });
    // Not just "non-empty": the summary has to describe THIS policy's rule, so
    // a family whose config keys stopped lining up cannot pass by rendering a
    // generic sentence.
    expect(card.summary).toContain('1');
    expect(card.hooks.map((badge) => badge.hook)).toEqual(['tool.pre']);
  });

  it('finds the tool policy under its NEW family filter and its new name', () => {
    const policies = policiesAsRendered();
    // The grid's family filter is built from the catalog, so it can only ever
    // offer `tool_access`. A policy still spelled `tool_policy` would be
    // unreachable through it — present in the list, filtered out of every view.
    expect(filterPolicyCards(policies, { family: 'tool_access' })).toHaveLength(1);
    expect(filterPolicyCards(policies, { query: 'tool access' })).toHaveLength(1);
    expect(filterPolicyCards(policies, { hook: 'tool.pre' })).toHaveLength(1);
  });

  it('opens a populated form for each policy rather than an empty one', () => {
    for (const policy of policiesAsRendered()) {
      const layout = policyFormLayout(policy);
      expect(layout.config.length + layout.configAdvanced.length).toBeGreaterThan(0);
    }
  });

  it('keeps the PII reference visible in the form and in the option lists', () => {
    const pii = policiesAsRendered()[0];
    // The renamed key has to be the one the field schema names, or the control
    // is bound to a property nothing wrote.
    const layout = policyFormLayout(pii);
    const reference = layout.config.find((field) => field.key === 'piiPolicyKey');
    expect(reference?.kind).toBe('reference');
    expect((pii as PiiPolicyConfig).piiPolicyKey).toBe('customer-pii');

    // ...and the page's option-list merge has to harvest it, or the drawer
    // renders an empty select over a policy that is still scanning through it.
    expect(referencedResourceKeys([pii]).get('pii_policy')).toEqual(new Set(['customer-pii']));
    const resources: PolicyFieldResources = { pii_policy: [{ value: 'other', label: 'Other' }] };
    expect(withReferencedKeys(resources, [pii]).pii_policy).toEqual([
      { value: 'other', label: 'Other' },
      { value: 'customer-pii', label: 'customer-pii (not found)' },
    ]);
  });

  it('reports no validation complaint that the rename itself caused', () => {
    for (const policy of policiesAsRendered()) {
      const malformed = collectPolicyIssues(policy, {
        bindings: {
          'input.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
          'tool.pre': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
        },
      }).filter((issue) => issue.reason === 'invalid');
      expect(malformed).toEqual([]);
    }
  });

  /**
   * The negative control. Every assertion above would also pass if the screens
   * had learned the old spelling themselves — which is the one fix that must
   * NOT be made, because it spreads the compatibility rule across three
   * components instead of keeping it at the read path. This pins that they did
   * not: fed the raw stored blob, the screens see nothing at all.
   */
  it('is the NORMALISER doing this, not the screens knowing the old names', () => {
    const raw = storedInOldSpelling();
    expect((raw as { policies?: unknown[] }).policies).toBeUndefined();

    const unnormalized = (raw.checks as GuardrailPolicy[])[1];
    expect(unnormalized.family).toBe('tool_policy' as unknown as GuardrailPolicy['family']);

    // It DEGRADES rather than throwing — a card that dies takes the grid with
    // it and leaves no way to reach the policy — but it degrades to the raw
    // family id and an empty form, which is nothing like the populated
    // `tool_access` card the normalised policy produces above.
    const card = describePolicyCard(unnormalized, { guardrailAction: 'block' });
    expect(card.familyLabel).toBe('tool_policy');
    expect(card.familyLabel).not.toBe(
      describePolicyCard(policiesAsRendered()[1], { guardrailAction: 'block' }).familyLabel,
    );
    expect(card.summary).toBe('');
    expect(card.hooks.every((badge) => badge.tone === 'ineligible')).toBe(true);
    expect(policyFormLayout(unnormalized).config).toEqual([]);
  });
});
