/**
 * THE UPGRADE TEST: a guardrail saved BEFORE the `check` -> `policy` rename,
 * driven through the RUNTIME rather than through a helper.
 *
 * `guardrail-policy-rename-compat.test.ts` pins the pure re-speller
 * (`normalizeHooksConfig`, `readPolicyList`, `ensureHooks`, `serializeGuardrail`,
 * `readHooksField`). This file exists because passing all of that is not the
 * same as working: the engine had TWO of its own reads of
 * `record.hooks.policies` that never went near the re-speller, and both did
 * something worse than return the wrong answer.
 *
 * WHY A HELPER TEST COULD NOT HAVE CAUGHT EITHER. Both bugs read the RAW cached
 * record — the object as the database handed it back — at a point BEFORE the
 * normaliser runs. A test that starts from an already-normalised config is, by
 * construction, on the far side of the defect. So every fixture below is
 * written in the old spelling (`hooks.checks`, `family: 'tool_policy'`,
 * `policyKey`) and is handed to the engine through the record cache, exactly as
 * a real row arrives.
 *
 * The two failures pinned here, both invisible from every screen:
 *
 *  1. THE DEFAULT TOOL GUARDRAIL WAS SILENTLY RE-ARMED. `withDefaultHooks`
 *     tested `record.hooks?.policies?.length` on the raw row. That row is
 *     created once per tenant and read forever, so most on disk predate the
 *     rename and store `checks` — which made a healthy row look empty. The
 *     branch it then took DISCARDS the operator's stored configuration and
 *     forces `mode: 'enforce'`, so a default tool guardrail someone had turned
 *     down to `monitor` started blocking tool calls on upgrade, while logging a
 *     persistence bug that had not happened.
 *
 *  2. A PHANTOM PII POLICY WAS WRITTEN INTO THE TENANT. `evaluateGuardrailHook`
 *     decided `authored` the same raw way. A pre-rename authored row read as
 *     unauthored, so the engine ran `ensureLiftedPiiPolicy`, which CREATES a
 *     `pii-migrated-<key>` PII policy from the legacy `policy.pii` blob that the
 *     downward projection keeps populated on every authored save. `ensureHooks`
 *     then correctly took its authored branch and threw the lifted key away —
 *     so the only trace was a row the customer never asked for appearing in
 *     their PII policy list, plus a database round trip on the hook path.
 *
 * Both now ask the question through `readPolicyList`, which is the same
 * question `ensureHooks` asks after normalising.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IGuardrail, IPiiPolicy } from '@/lib/database/provider/types.domain';

/**
 * Sync factory only — an async `vi.mock` factory does not intercept in this
 * repo (see `reference-vitest-mock-importactual-trap`). Everything the engine
 * reaches the database for goes through `runWithTenantScope`, so one fake
 * provider serves the record cache, the PII lift and the evaluation log.
 */
const hoisted = vi.hoisted(() => ({
  findGuardrailByKey: vi.fn(),
  findPiiPolicyByKey: vi.fn(),
  createPiiPolicy: vi.fn(),
  createGuardrailEvaluationLog: vi.fn(),
  createGuardrail: vi.fn(),
}));

const fakeDb = {
  findGuardrailByKey: hoisted.findGuardrailByKey,
  findPiiPolicyByKey: hoisted.findPiiPolicyByKey,
  createPiiPolicy: hoisted.createPiiPolicy,
  createGuardrailEvaluationLog: hoisted.createGuardrailEvaluationLog,
  createGuardrail: hoisted.createGuardrail,
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => fakeDb),
  getTenantDatabase: vi.fn(async () => fakeDb),
  runWithTenantScope: vi.fn(
    async (_tenantDbName: string, fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
  ),
}));

/** The usage/eval sinks are fire-and-forget; stubbing them keeps the assertions
 *  about the verdict rather than about the telemetry that trails it. */
vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn(async () => undefined),
  resolveUsageAttribution: vi.fn(async () => ({})),
}));

import { toolCallSubject } from '@/lib/services/guardrail/hooks/contract';
import type { HookScope } from '@/lib/services/guardrail/hooks/contract';
import {
  DEFAULT_TOOL_GUARDRAIL_KEY,
  ensureDefaultToolGuardrail,
  runHook,
} from '@/lib/services/guardrail/hooks/engine';
import { ensureHooks, invalidateLiftedPiiPolicyCache } from '@/lib/services/guardrail/hooks/legacy';
import { resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';
import { serializeGuardrail } from '@/lib/services/guardrail/guardrailService';

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;

const scope: HookScope = {
  tenantId: 'tenant-a',
  tenantDbName: 't_tenant_a',
  actor: { id: 'u1', kind: 'user', roles: ['developer'] },
  surface: 'sandbox',
  source: 'unit-test',
  traceId: 'trace-legacy',
};

/**
 * A guardrail AS PERSISTED BY A PRE-RENAME BUILD.
 *
 * Three old spellings at once, because that is how one arrives: the array is
 * `checks`, the tool family is `tool_policy`, and the PII policy reference is
 * `policyKey`. `hooksVersion: 1` is what makes it authored — an operator sat
 * down and configured this. The legacy `policy` blob is populated too, which is
 * not decoration: `projectHooksToLegacy` writes those columns on every authored
 * save, so a real pre-rename row with a PII policy has BOTH. That combination
 * is precisely what armed the phantom-write bug, so leaving it out would make
 * this fixture unrepresentative in the one way that matters.
 *
 * Typed through `as unknown as IGuardrail` because the old spelling is, by
 * design, no longer expressible in the current types — which is the whole
 * reason a runtime bridge exists.
 */
function legacyRecord(overrides: Partial<IGuardrail> = {}): IGuardrail {
  return {
    _id: 'gr-legacy-1',
    tenantId: 'tenant-a',
    key: 'legacy-guard',
    name: 'Legacy Guard',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    mode: 'enforce',
    failMode: 'open',
    createdBy: 'user-1',
    policy: {
      pii: { enabled: true, action: 'redact', categories: { email: true } },
    },
    hooksVersion: 1,
    hooks: {
      contractVersion: 2,
      checks: [
        {
          id: 'chk-tools',
          family: 'tool_policy',
          enabled: true,
          hooks: ['tool.pre'],
          schedule: SYNC_BLOCK,
          deny: ['shell.exec'],
        },
        {
          id: 'chk-pii',
          family: 'pii',
          enabled: true,
          hooks: ['input.pre'],
          schedule: SYNC_BLOCK,
          policyKey: 'pii-hr',
        },
      ],
      bindings: {
        'tool.pre': { enabled: true, schedule: SYNC_BLOCK },
        'input.pre': { enabled: true, schedule: SYNC_BLOCK },
      },
    },
    ...overrides,
  } as unknown as IGuardrail;
}

beforeEach(() => {
  resetRecordCaches();
  // NOT optional bookkeeping. `ensureLiftedPiiPolicy` memoises per
  // (tenantDbName, guardrailKey) in a module-level map that `resetRecordCaches`
  // does not own, so a lift performed by an EARLIER test in this file leaves
  // the phantom-write assertion below satisfied by a cache hit rather than by
  // the fix. Verified: without this line that test passes even with the defect
  // reintroduced.
  invalidateLiftedPiiPolicyCache();
  vi.clearAllMocks();
  hoisted.findPiiPolicyByKey.mockResolvedValue(null);
  hoisted.createPiiPolicy.mockImplementation(
    async (input: Partial<IPiiPolicy>) => ({ ...input, _id: 'pii-new' }) as IPiiPolicy,
  );
  hoisted.createGuardrailEvaluationLog.mockResolvedValue(undefined);
});

afterEach(() => {
  resetRecordCaches();
});

// ── 1. It loads, with ALL of its policies ──────────────────────────────────

describe('a pre-rename guardrail still loads', () => {
  it('keeps BOTH policies, re-spelled, and stays authored', () => {
    const { hooks, hooksVersion } = ensureHooks(legacyRecord());

    // The headline: nothing was dropped. A count of 1 (or 0) here is the
    // customer-visible disaster — the legacy preset lift replacing an
    // operator's configuration while every screen keeps saying it saved.
    expect(hooks.policies).toHaveLength(2);
    expect(hooksVersion).toBe(1);

    const tool = hooks.policies.find((policy) => policy.id === 'chk-tools');
    const pii = hooks.policies.find((policy) => policy.id === 'chk-pii');
    expect(tool?.family).toBe('tool_access');
    expect(pii?.family).toBe('pii');
    // `policyKey` -> `piiPolicyKey`. Read under the old name the reference is
    // simply absent, and an enabled PII policy with no key detects nothing.
    expect(pii && 'piiPolicyKey' in pii ? pii.piiPolicyKey : undefined).toBe('pii-hr');
  });

  it('does not mutate the cached record while re-spelling it', () => {
    // The record cache hands the SAME object to every caller and freezes it
    // outside production, so a normaliser that wrote in place would either
    // throw here or publish a rewritten config to every other holder.
    const record = Object.freeze(legacyRecord());
    const before = JSON.stringify(record.hooks);

    expect(() => ensureHooks(record)).not.toThrow();
    expect(JSON.stringify(record.hooks)).toBe(before);
  });

  it('renders every policy on the screen path too', () => {
    // `serializeGuardrail` is the other read chokepoint — the one the dashboard
    // and both API surfaces come through. The engine and the screen must agree
    // about how many policies this guardrail has.
    const view = serializeGuardrail(legacyRecord());
    const policies = view.hooks?.policies ?? [];

    expect(policies).toHaveLength(2);
    expect(policies.map((policy) => policy.family).sort()).toEqual(['pii', 'tool_access']);
    // The list page counts `hooks.policies` off exactly this view and calls a
    // row with no usable array "derived", so an un-normalised view would render
    // an authored guardrail as a legacy one.
    expect((view.hooksVersion ?? 0) >= 1 && Array.isArray(view.hooks?.policies)).toBe(true);
  });
});

// ── 2. It still ENFORCES ───────────────────────────────────────────────────

describe('a pre-rename guardrail still enforces', () => {
  it('blocks a denied tool call through the real engine', async () => {
    hoisted.findGuardrailByKey.mockResolvedValue(legacyRecord());

    const verdict = await runHook({
      contractVersion: 2,
      hook: 'tool.pre',
      subject: toolCallSubject({
        toolName: 'shell.exec',
        args: { cmd: 'rm -rf /' },
        providerRef: 'sandbox:test',
      }),
      scope,
      guardrailKeys: ['legacy-guard'],
    });

    // A policy stored as `tool_policy` inside a `checks` array reaches the
    // dispatcher as a `tool_access` policy and denies the call. Anything less
    // than 'block' here means the rename disarmed a live guardrail.
    expect(verdict.decision).toBe('block');
    expect(verdict.enforced).toBe(true);
    expect(verdict.findings.length).toBeGreaterThan(0);
    // The wire carries the NEW spellings outward, per the compatibility rule:
    // accept the old name where we parse, emit only the new one.
    expect(verdict.findings.every((finding) => finding.family === 'tool_access')).toBe(true);
  });

  it('does NOT write a phantom PII policy into the tenant', async () => {
    // THE REGRESSION PIN for bug 2. The record is authored, so the legacy PII
    // lift must never run — reading `authored` off the raw `hooks.policies`
    // made this record look unauthored and provisioned a
    // `pii-migrated-legacy-guard` policy the operator never asked for.
    hoisted.findGuardrailByKey.mockResolvedValue(legacyRecord());

    await runHook({
      contractVersion: 2,
      hook: 'tool.pre',
      subject: toolCallSubject({
        toolName: 'shell.exec',
        args: { cmd: 'ls' },
        providerRef: 'sandbox:test',
      }),
      scope,
      guardrailKeys: ['legacy-guard'],
    });

    expect(hoisted.createPiiPolicy).not.toHaveBeenCalled();
  });

  it('still lifts for a genuinely unauthored row, so the guard is not simply off', () => {
    // The negative control. If `authored` were hardwired true the assertion
    // above would pass for the wrong reason, and every real legacy row would
    // lose its PII categories. `hooksVersion: 0` with no hooks at all is what
    // an actual pre-hook-plane row looks like.
    const preHookPlane = legacyRecord({ hooksVersion: 0, hooks: undefined });
    const { hooks, hooksVersion } = ensureHooks(preHookPlane, 'pii-migrated-legacy-guard');

    expect(hooksVersion).toBe(0);
    const pii = hooks.policies.find((policy) => policy.family === 'pii');
    expect(pii && 'piiPolicyKey' in pii ? pii.piiPolicyKey : undefined).toBe(
      'pii-migrated-legacy-guard',
    );
  });
});

// ── 3. One policy's message never becomes another's ────────────────────────

/**
 * `policy.message` exists because the layer below it is keyed by REASON CLASS,
 * and several families share one: `regex`, `webhook` and `custom` all resolve to
 * 'custom'. Before the engine read the blocking policy's own wording, two
 * policies in one guardrail could only ever produce the SAME body — while the
 * drawer displayed "This policy overrides it" and offered a Reset, so the
 * operator had written confirmation of something that never happened.
 *
 * Driven through `runHook` rather than through `resolveBlockMessage`, because
 * the defect was never in the resolver: it was that nothing passed the field to
 * it. A resolver test passes in both worlds.
 */
describe('a per-policy message is not shared with the policy next to it', () => {
  const rule = (id: string, pattern: string) => ({
    id,
    label: id,
    pattern,
    category: 'custom',
    severity: 'high' as const,
    maxMatchChars: 16,
  });

  /** Two regex policies, same guardrail, same reason class ('custom'). Exactly
   *  one of them says something of its own. */
  function twoCustomPolicies(): IGuardrail {
    return {
      _id: 'gr-msg',
      tenantId: 'tenant-a',
      key: 'msg-guard',
      name: 'Message Guard',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      mode: 'enforce',
      failMode: 'open',
      createdBy: 'user-1',
      hooksVersion: 1,
      hooks: {
        contractVersion: 2,
        policies: [
          {
            id: 'p-alpha',
            family: 'regex',
            enabled: true,
            hooks: ['input.pre'],
            schedule: SYNC_BLOCK,
            rules: [rule('r-alpha', 'ALPHA')],
            message: 'Alpha is not allowed in this workspace.',
          },
          {
            id: 'p-bravo',
            family: 'regex',
            enabled: true,
            hooks: ['input.pre'],
            schedule: SYNC_BLOCK,
            rules: [rule('r-bravo', 'BRAVO')],
          },
        ],
        bindings: { 'input.pre': { enabled: true, schedule: SYNC_BLOCK } },
      },
    } as unknown as IGuardrail;
  }

  async function blockBodyFor(text: string): Promise<string | undefined> {
    hoisted.findGuardrailByKey.mockResolvedValue(twoCustomPolicies());
    const verdict = await runHook({
      contractVersion: 2,
      hook: 'input.pre',
      subject: { kind: 'text', text, segments: [{ text, path: '/text', offset: 0 }] },
      scope,
      guardrailKeys: ['msg-guard'],
    });
    expect(verdict.decision).toBe('block');
    return verdict.message?.body;
  }

  it('gives each policy its own body, though both are reason class "custom"', async () => {
    const alpha = await blockBodyFor('this contains ALPHA somewhere');
    resetRecordCaches();
    const bravo = await blockBodyFor('this contains BRAVO somewhere');

    // `toContain`, not `toBe`: the renderer appends "\n\nReference: <traceId>"
    // to every body, which is a property of the message rather than of the
    // policy and is asserted on its own below.
    expect(alpha).toContain('Alpha is not allowed in this workspace.');
    expect(alpha).toContain(scope.traceId);

    // The one that wrote nothing still inherits the shared wording — clearing
    // the box must restore the inherited text, not ship the end user nothing.
    expect(bravo).toBeTruthy();
    expect(bravo).not.toContain('Alpha is not allowed');

    // THE PIN. Equal bodies here is the exact defect: one policy's wording
    // answering for the policy next to it, because both are reason class
    // 'custom' and the layer below `policy.message` is keyed by that class.
    expect(alpha).not.toBe(bravo);
  });

  it('never hands a message to a finding that names no policy', async () => {
    // `find((p) => p.id === undefined)` matches the first policy that also
    // lacks an id, which would attach a completely unrelated policy's wording
    // to a block. An absent id means "no policy owns this".
    const { policyOwnMessage } = await import('@/lib/services/guardrail/hooks/engine');
    const hooks = {
      contractVersion: 2,
      policies: [
        { family: 'regex', enabled: true, hooks: ['input.pre'], message: 'orphan wording' },
        { id: 'p-real', family: 'regex', enabled: true, hooks: ['input.pre'], message: 'mine' },
      ],
      bindings: {},
    } as unknown as Parameters<typeof policyOwnMessage>[0];

    expect(policyOwnMessage(hooks, undefined)).toBeUndefined();
    expect(policyOwnMessage(hooks, '')).toBeUndefined();
    expect(policyOwnMessage(hooks, 'p-real')).toBe('mine');
    expect(policyOwnMessage(hooks, 'p-missing')).toBeUndefined();
  });
});

// ── 4. The default tool guardrail keeps its configuration ──────────────────

describe('the pre-rename DEFAULT tool guardrail', () => {
  /**
   * The system row, as a pre-rename build wrote it: `checks` / `tool_policy`,
   * and an operator who turned it down to `monitor` and narrowed the deny list.
   */
  function legacyDefault(): IGuardrail {
    return {
      _id: 'gr-default',
      tenantId: 'tenant-a',
      key: DEFAULT_TOOL_GUARDRAIL_KEY,
      name: 'Tool safety (default)',
      type: 'preset',
      target: 'input',
      action: 'block',
      enabled: true,
      mode: 'monitor',
      failMode: 'open',
      createdBy: 'system',
      hooksVersion: 1,
      hooks: {
        contractVersion: 2,
        checks: [
          {
            id: 'tool-policy',
            family: 'tool_policy',
            enabled: true,
            hooks: ['tool.pre', 'tool.post'],
            schedule: SYNC_BLOCK,
            deny: ['sandbox.fs.delete'],
          },
        ],
        bindings: {
          'tool.pre': { enabled: true, schedule: SYNC_BLOCK },
          'tool.post': { enabled: true, schedule: SYNC_BLOCK },
        },
      },
      ...{},
    } as unknown as IGuardrail;
  }

  it('is returned as stored, not replaced by the built-in default', async () => {
    hoisted.findGuardrailByKey.mockResolvedValue(legacyDefault());

    const record = await ensureDefaultToolGuardrail('t_tenant_a', 'tenant-a');

    // THE REGRESSION PIN for bug 1, and the reason it mattered: `mode` was
    // forced back to 'enforce', so a guardrail an operator had deliberately put
    // in observe-only started blocking tool calls after an upgrade that was
    // supposed to be a rename.
    expect(record.mode).toBe('monitor');

    // And the operator's own policy survived rather than being overwritten by
    // `defaultToolGuardrailHooks()`.
    const { hooks } = ensureHooks(record);
    expect(hooks.policies).toHaveLength(1);
    expect(hooks.policies[0]?.id).toBe('tool-policy');
    expect(hooks.policies[0]?.family).toBe('tool_access');
    const deny = hooks.policies[0] && 'deny' in hooks.policies[0] ? hooks.policies[0].deny : undefined;
    expect(deny).toEqual(['sandbox.fs.delete']);

    // Nothing was created: the row already existed and was perfectly usable.
    expect(hoisted.createGuardrail).not.toHaveBeenCalled();
  });

  it('STILL repairs a row that genuinely lost its hook columns', async () => {
    // The negative control for the same guard. `withDefaultHooks` exists
    // because a SQLite mixin with a stale column whitelist silently drops
    // `hooks`/`hooksVersion` on insert, leaving a default guardrail that looks
    // configured and enforces nothing. Widening the gate to accept `checks`
    // must not disarm that repair.
    hoisted.findGuardrailByKey.mockResolvedValue({
      ...legacyDefault(),
      hooks: undefined,
      hooksVersion: 0,
    } as unknown as IGuardrail);

    const record = await ensureDefaultToolGuardrail('t_tenant_a', 'tenant-a');

    expect(record.hooksVersion).toBe(1);
    expect(record.mode).toBe('enforce');
    const { hooks } = ensureHooks(record);

    // The BUILT-IN set, not the operator's narrowed one — the tool gate plus
    // the DLP policies that make this guardrail worth having. Asserting the
    // families rather than a count keeps this honest if the default grows.
    expect(hooks.policies.map((policy) => policy.family)).toContain('tool_access');
    expect(hooks.policies.map((policy) => policy.family)).toContain('secrets');
    // And demonstrably NOT the row's own single policy, which is what the
    // repair is entitled to discard when the config really is missing.
    expect(hooks.policies.length).toBeGreaterThan(1);
  });

  it('treats an EMPTY policy array as lost, under either spelling', async () => {
    // `policies?.length` rather than `policies !== undefined`: a default
    // guardrail with zero policies enforces nothing, which is the same disarm
    // the repair exists for. The old spelling must not become a way to hold a
    // default guardrail open with an empty array.
    hoisted.findGuardrailByKey.mockResolvedValue({
      ...legacyDefault(),
      hooks: { contractVersion: 2, checks: [], bindings: {} },
    } as unknown as IGuardrail);

    const record = await ensureDefaultToolGuardrail('t_tenant_a', 'tenant-a');

    const { hooks } = ensureHooks(record);
    expect(hooks.policies.length).toBeGreaterThan(0);
  });
});
