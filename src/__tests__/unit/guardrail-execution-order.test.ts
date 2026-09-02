/**
 * THE ENGINE'S EXECUTION ORDER, driven through `runHook`.
 *
 * The order is normative and every compatibility claim in the hook plane rests
 * on it:
 *   1. the DETERMINISTIC families, SEQUENTIALLY, in `policies` array order;
 *   2. "enabled but no evaluation model" findings, in array order, BEFORE any
 *      LLM result;
 *   3. the LLM and webhook families started TOGETHER and awaited with
 *      `Promise.all`, their findings appended in array order.
 * On top of that, `hooks.shortCircuit` (default true) stops the remaining work
 * once a SYNC policy has put a blocking finding into the list.
 *
 * WHY EVERY TEST HERE GOES THROUGH `runHook` RATHER THAN A HELPER. The
 * properties are only observable in the engine's own loop: that phase 3 never
 * STARTS is a statement about a spy that was not called; that phase 1 is
 * sequential is a statement about a policy that had not started YET; and that
 * findings come back in declaration order is only meaningful when the promises
 * resolve in some other order.
 *
 * The family adapters are mocked so that resolution ORDER is scripted rather
 * than raced. Deferred promises, not timers: the interleavings these tests pin
 * are exact, and a timing-based version of them would be the flaky test that
 * teaches everyone to rerun the suite.
 *
 * The last section is not about order but lives here for the same reason: what
 * a family is DISPATCHED WITH is visible only from inside that loop, and the
 * one thing the loop hands a remote family beyond its input — the caller's
 * abort signal — is what makes the family's own cancellation reachable at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IGuardrail } from '@/lib/database/provider/types.domain';

/**
 * Sync factory only — an async `vi.mock` factory does not intercept in this
 * repo. Every family adapter funnels into ONE dispatcher, so a test scripts
 * behaviour per POLICY ID instead of per module, and `started` is a single
 * ordered record of which policies the engine actually began.
 *
 * A PLAIN FUNCTION, NOT A `vi.fn()`, and that is load-bearing rather than
 * stylistic. A `vi.fn` with an async implementation records its own settlement
 * for `mock.settledResults`, and that bookkeeping RE-ORDERS the promises: three
 * mocked calls resolved 3-2-1 come back to the caller 1-2-3. The phase-3
 * ordering test below scripts an inverted resolution order, so a spy in this
 * position would silently hand the engine the very order the test is trying to
 * prove it does not depend on — i.e. it would pass identically against an
 * engine that collected by completion order.
 */
const hoisted = vi.hoisted(() => {
  const started: string[] = [];
  const behaviours = new Map<string, (input: Record<string, unknown>) => unknown>();
  const dispatch = (id: string, input: Record<string, unknown>): unknown => {
    started.push(id);
    const behaviour = behaviours.get(id);
    return behaviour ? behaviour(input) : Promise.resolve({ findings: [], mutations: [] });
  };
  return {
    findGuardrailByKey: vi.fn(),
    createGuardrailEvaluationLog: vi.fn(),
    started,
    behaviours,
    /**
     * The four object-argument adapters and the one positional adapter. Built
     * INSIDE `vi.hoisted` because a `vi.mock` factory is hoisted above every
     * top-level `const`, so a shared helper declared out here would be a
     * use-before-initialization at mock time rather than a shared helper.
     */
    objectAdapter: (input: { policy: { id: string } } & Record<string, unknown>): unknown =>
      dispatch(input.policy.id, input),
    positionalAdapter: (
      _subject: unknown,
      policy: { id: string },
      ctx: Record<string, unknown>,
    ): unknown => dispatch(policy.id, { policy, ...ctx }),
  };
});

const fakeDb = {
  findGuardrailByKey: hoisted.findGuardrailByKey,
  createGuardrailEvaluationLog: hoisted.createGuardrailEvaluationLog,
};

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => fakeDb),
  getTenantDatabase: vi.fn(async () => fakeDb),
  runWithTenantScope: vi.fn(
    async (_tenantDbName: string, fn: (db: typeof fakeDb) => unknown) => fn(fakeDb),
  ),
}));

vi.mock('@/lib/services/usage/usageEvents', () => ({
  recordUsageEvent: vi.fn(() => ({})),
  resolveUsageAttribution: vi.fn(() => ({})),
}));

vi.mock('@/lib/services/guardrail/families/pii', () => ({ runPiiPolicy: hoisted.objectAdapter }));
vi.mock('@/lib/services/guardrail/families/secrets', () => ({
  runSecretsPolicy: hoisted.objectAdapter,
}));
vi.mock('@/lib/services/guardrail/families/regex', () => ({
  runRegexPolicy: hoisted.objectAdapter,
}));
vi.mock('@/lib/services/guardrail/families/webhook', () => ({
  runWebhookPolicy: hoisted.objectAdapter,
}));

/** `word_filter` is the one positional adapter — see `dispatchPolicy`'s note on
 *  the two calling conventions the engine reconciles. */
vi.mock('@/lib/services/guardrail/families/wordFilter', () => ({
  runWordFilterPolicy: hoisted.positionalAdapter,
}));

import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailPolicy,
  HookAbortSignal,
  HookScope,
  HookVerdict,
  Mutation,
  SafetyFinding,
} from '@/lib/services/guardrail/hooks/contract';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { runHook } from '@/lib/services/guardrail/hooks/engine';
import { ensureHooks, validateGuardrailHooks } from '@/lib/services/guardrail/hooks/legacy';
import { resetRecordCaches } from '@/lib/services/guardrail/hooks/recordCache';

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const SYNC_BLOCK = { timing: 'sync', onFail: 'block' } as const;
const ASYNC_LOG = { timing: 'async', onFail: 'log' } as const;

function scopeWith(signal?: HookAbortSignal, budgetMs?: number): HookScope {
  return {
    tenantId: 'tenant-a',
    tenantDbName: 't_tenant_a',
    actor: { id: 'u1', kind: 'user', roles: ['developer'] },
    surface: 'api',
    source: 'unit-test',
    traceId: 'trace-order',
    signal,
    budgetMs,
  };
}

/** What a family hands back. Every field the engine reads, nothing it does not. */
interface FamilyOutcome {
  findings: SafetyFinding[];
  mutations: Mutation[];
  degraded?: Array<{ policyId: string; family: string; reason: string }>;
}

const nothing = (): FamilyOutcome => ({ findings: [], mutations: [] });

/** A finding that does NOT block — the engine folds it to 'flag'. */
function flag(policyId: string, message = `${policyId} flagged`): SafetyFinding {
  return {
    type: 'custom',
    category: 'test',
    severity: 'low',
    message,
    action: 'flag',
    block: false,
    family: 'regex',
    hook: 'input.pre',
    policyId,
  };
}

/** A finding that DOES block. `block: true` is what `isBlockingFinding` reads. */
function blocks(policyId: string, message = `${policyId} blocked`): SafetyFinding {
  return { ...flag(policyId, message), action: 'block', block: true, severity: 'high' };
}

/** A finding that asks for a rewrite. Deliberately NOT blocking — the point of
 *  the "redact does not short-circuit" test. */
function redacts(policyId: string): SafetyFinding {
  return { ...flag(policyId, `${policyId} redacted`), action: 'redact' };
}

/**
 * Every policy in these fixtures is bound to `input.pre`. The FAMILY is what
 * decides which phase it runs in — the deterministic families first, then the
 * remote round trips (`webhook` and the LLM family `custom`) in the deferred
 * phase — so it is always stated explicitly rather than defaulted.
 *
 * A `custom` policy is given NO `modelKey`, and the guardrail record carries
 * none either, so it is the "enabled but no evaluation model" case phase 2
 * answers by itself. That is deliberate: it keeps the LLM family unmocked,
 * because the pre-pass resolves the model and never dispatches such a policy.
 */
function policy(
  id: string,
  family: 'pii' | 'secrets' | 'regex' | 'word_filter' | 'webhook' | 'custom',
  extra: Record<string, unknown> = {},
): GuardrailPolicy {
  return {
    id,
    family,
    enabled: true,
    hooks: ['input.pre'],
    schedule: SYNC_BLOCK,
    ...(family === 'webhook' ? { url: 'https://example.test/hook', send: 'text' } : {}),
    ...(family === 'custom' ? { prompt: 'Is this a support request?' } : {}),
    ...extra,
  } as unknown as GuardrailPolicy;
}

function guardrail(policies: GuardrailPolicy[], hooks: Record<string, unknown> = {}): IGuardrail {
  return {
    _id: 'gr-order',
    tenantId: 'tenant-a',
    key: 'ordered',
    name: 'Ordered Guard',
    type: 'preset',
    target: 'input',
    action: 'block',
    enabled: true,
    mode: 'enforce',
    failMode: 'open',
    createdBy: 'user-1',
    hooksVersion: 1,
    hooks: {
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      policies,
      bindings: { 'input.pre': { enabled: true, schedule: SYNC_BLOCK } },
      ...hooks,
    },
  } as unknown as IGuardrail;
}

function evaluate(signal?: HookAbortSignal, budgetMs?: number): Promise<HookVerdict> {
  const text = 'subject text';
  return runHook({
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook: 'input.pre',
    subject: { kind: 'text', text, segments: [{ path: '/text', text }] },
    scope: scopeWith(signal, budgetMs),
    guardrailKeys: ['ordered'],
  });
}

/** The policy ids the engine actually STARTED, in the order it started them. */
function started(): string[] {
  return [...hoisted.started];
}

/** A promise a test resolves by hand, so resolution ORDER is scripted. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Script the family dispatcher per policy id. An id with no entry resolves to
 *  nothing, so a test only writes down the policies it is actually about. */
function script(
  behaviours: Record<
    string,
    (input: Record<string, unknown>) => FamilyOutcome | Promise<FamilyOutcome>
  >,
): void {
  hoisted.behaviours.clear();
  for (const [id, behaviour] of Object.entries(behaviours)) {
    hoisted.behaviours.set(id, behaviour);
  }
}

/** Let the engine run until it is parked. A fixed number of microtask turns
 *  would be a guess — the record lookup alone is several. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  resetRecordCaches();
  vi.clearAllMocks();
  hoisted.started.length = 0;
  hoisted.behaviours.clear();
  hoisted.createGuardrailEvaluationLog.mockResolvedValue(undefined);
});

afterEach(() => {
  resetRecordCaches();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The phase order
// ═══════════════════════════════════════════════════════════════════════════

describe('the deterministic families run before the remote ones', () => {
  it('runs the deterministic policy before the webhook even when it is declared second', async () => {
    // Declaration order is deliberately the WRONG order: an engine that simply
    // walked `policies` would start the webhook first. It is the PHASE split
    // that reorders them.
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('hook-first', 'webhook'), policy('secrets-second', 'secrets')]),
    );
    script({
      'secrets-second': () => ({ findings: [flag('secrets-second')], mutations: [] }),
      'hook-first': () => ({ findings: [flag('hook-first')], mutations: [] }),
    });

    const verdict = await evaluate();

    expect(started()).toEqual(['secrets-second', 'hook-first']);
    // And the findings follow, which is what makes `findings[0].message` — the
    // string the evaluation log persists and the end user reads — stable.
    expect(verdict.findings.map((finding) => finding.policyId)).toEqual([
      'secrets-second',
      'hook-first',
    ]);
  });

  it('runs the deterministic phase SEQUENTIALLY, not all at once', async () => {
    // THE PIN ON PHASE 1 BEING SEQUENTIAL. Starting them together would make
    // the budget re-check below unreachable and would put the findings list at
    // the mercy of which detector finished first. `p2` must not have been
    // touched while `p1` is still parked.
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('p1', 'regex'), policy('p2', 'secrets')]),
    );
    const first = deferred<FamilyOutcome>();
    script({ p1: () => first.promise });

    const pending = evaluate();
    await settle();

    expect(started()).toEqual(['p1']);

    first.resolve(nothing());
    await pending;

    expect(started()).toEqual(['p1', 'p2']);
  });

  it('hands the deferred phase the deterministic phase’s mutations, not the caller’s original', async () => {
    // `redactBeforeSend` is what stops a credential the tenant asked to redact
    // from being shipped verbatim to a third-party classifier, and it can only
    // work if the webhook is handed what the deterministic phase produced.
    const mutation: Mutation = {
      op: 'replace_value',
      path: '/text',
      value: 'secret',
      replacement: '[redacted]',
      family: 'secrets',
      policyId: 'redactor',
    };
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('redactor', 'secrets'), policy('sender', 'webhook')]),
    );
    let seen: readonly Mutation[] | undefined;
    script({
      redactor: () => ({ findings: [redacts('redactor')], mutations: [mutation] }),
      sender: (input) => {
        seen = input.priorMutations as readonly Mutation[] | undefined;
        return nothing();
      },
    });

    await evaluate();

    expect(seen).toEqual([mutation]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The missing-model pre-pass, ahead of the deferred batch
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PHASE 2 IS THE HALF OF THE ORDER THAT LOOKS LIKE AN IMPLEMENTATION DETAIL
 * AND IS NOT. An LLM policy with no model resolves its own finding inside the
 * deferred batch, and a member of that batch cannot append ahead of the batch
 * — so the engine resolves `llmPolicyModelKey` itself, BEFORE any of it starts.
 * Drop the pre-pass and the finding merely moves later in the list, which is
 * invisible until it stops being `findings[0]` and the end user is told about
 * a different policy than the one that actually stopped them.
 */
describe('an LLM policy with no evaluation model', () => {
  it('reports ahead of the deferred batch even when it is declared after it', async () => {
    // Declaration order is the WRONG order on purpose. The webhook is declared
    // FIRST and answers normally; the model-less judge is declared SECOND. So
    // array order cannot produce the assertion below — only a pre-pass that
    // runs before phase 3 starts can.
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('sender', 'webhook'), policy('judge', 'custom')]),
    );
    script({ sender: () => ({ findings: [flag('sender')], mutations: [] }) });

    const verdict = await evaluate();

    expect(verdict.findings.map((finding) => finding.policyId)).toEqual(['judge', 'sender']);
    // Word for word what `missingModelMessage` produces for a fail-OPEN
    // guardrail — this fixture's `failMode` — because it is `findings[0]` and
    // therefore the string the evaluation log persists and the end user reads.
    expect(verdict.findings[0]?.message).toBe(
      'Policy is enabled but no evaluation model is configured (fail-open — content passed unchecked).',
    );
    // And it was never DISPATCHED: the pre-pass answers it, so the LLM family
    // is not reached at all. That is why this file mocks no LLM adapter.
    expect(started()).toEqual(['sender']);
  });

  it('is skipped entirely by a blocking finding from phase 1', async () => {
    // `shortCircuit` stops "the remaining work", and the pre-pass is part of
    // it. A run cut short must not still be told about a model it was never
    // going to consult.
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('blocker', 'regex'), policy('judge', 'custom')]),
    );
    script({ blocker: () => ({ findings: [blocks('blocker')], mutations: [] }) });

    const verdict = await evaluate();

    expect(verdict.findings.map((finding) => finding.policyId)).toEqual(['blocker']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. shortCircuit
// ═══════════════════════════════════════════════════════════════════════════

describe('a blocking finding from a sync policy', () => {
  it('stops the remaining deterministic policies and the whole deferred phase', async () => {
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([
        policy('gate', 'regex'),
        policy('never-runs', 'secrets'),
        policy('never-called', 'webhook'),
      ]),
    );
    script({ gate: () => ({ findings: [blocks('gate')], mutations: [] }) });

    const verdict = await evaluate();

    // The spy is the assertion: "did not contribute a finding" would also be
    // true of a policy that ran and found nothing, and those are the two things
    // this whole design exists to keep apart.
    expect(started()).toEqual(['gate']);
    expect(verdict.decision).toBe('block');
  });

  it('keeps running everything when `shortCircuit: false` — the legacy-row shape', async () => {
    // Every legacy-lifted guardrail and the default tool guardrail carry
    // `shortCircuit: false`, to keep the whole findings array for the audit
    // trail and for the /v1/moderations category map. If a block started
    // truncating them, a PII block would silently delete the moderation
    // findings from every one.
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail(
        [policy('pii-blocks', 'pii'), policy('still-runs', 'regex'), policy('sender', 'webhook')],
        { shortCircuit: false },
      ),
    );
    script({ 'pii-blocks': () => ({ findings: [blocks('pii-blocks')], mutations: [] }) });

    const verdict = await evaluate();

    expect(started()).toEqual(['pii-blocks', 'still-runs', 'sender']);
    expect(verdict.decision).toBe('block');
  });

  it('does NOT stop for `redact` or `flag`', async () => {
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([
        policy('masker', 'secrets'),
        policy('sibling', 'regex'),
        policy('later', 'webhook'),
      ]),
    );
    script({
      masker: () => ({ findings: [redacts('masker')], mutations: [] }),
      sibling: () => ({ findings: [flag('sibling')], mutations: [] }),
    });

    const verdict = await evaluate();

    // Cutting a redaction policy short would leave its mask unapplied while the
    // verdict still claimed a redaction it never made, so only a BLOCK may stop
    // the run.
    expect(started()).toEqual(['masker', 'sibling', 'later']);
    expect(verdict.decision).toBe('redact');
  });

  it('stops for an error that `failMode: "closed"` resolved to a block', async () => {
    // A deterministic family reports a failure as a bare `degraded` entry and
    // the ENGINE builds the failMode finding for it, so an outcome with an
    // EMPTY findings array can still block. Testing `outcome.findings` instead
    // of the accumulated list would silently soften exactly the case an
    // operator chose fail-closed for.
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([
        policy('broken', 'secrets', { failMode: 'closed', action: 'block' }),
        policy('after', 'regex'),
      ]),
    );
    script({
      broken: () => ({
        findings: [],
        mutations: [],
        degraded: [{ policyId: 'broken', family: 'secrets', reason: 'detector unavailable' }],
      }),
    });

    const verdict = await evaluate();

    expect(started()).toEqual(['broken']);
    expect(verdict.decision).toBe('block');
    expect(verdict.degraded).toHaveLength(1);
  });

  it('is never raised by an ASYNC policy — it has already let the flow continue', async () => {
    // An async policy cannot be what stops the flow, so a block from one does
    // not end the run at its own boundary. (It is still in the accumulated
    // list, so the NEXT sync policy to finish does stop the run — which is why
    // this fixture has exactly one policy after it.)
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([
        policy('async-blocker', 'regex', { schedule: ASYNC_LOG }),
        policy('still-runs', 'secrets'),
      ]),
    );
    script({ 'async-blocker': () => ({ findings: [blocks('async-blocker')], mutations: [] }) });

    const verdict = await evaluate();

    expect(started()).toEqual(['async-blocker', 'still-runs']);
    expect(verdict.decision).toBe('block');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The deferred phase collects by declaration index
// ═══════════════════════════════════════════════════════════════════════════

describe('findings leave the deferred phase in declaration order', () => {
  /** Runs three webhook policies, resolving them in the given id order. */
  async function runResolvingIn(order: string[]): Promise<HookVerdict> {
    hoisted.started.length = 0;
    resetRecordCaches();
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('w1', 'webhook'), policy('w2', 'webhook'), policy('w3', 'webhook')]),
    );
    const gates = new Map(order.map((id) => [id, deferred<FamilyOutcome>()]));
    script(
      Object.fromEntries(
        order.map((id) => [
          id,
          () => {
            const gate = gates.get(id);
            if (!gate) throw new Error(`unscripted policy ${id}`);
            return gate.promise;
          },
        ]),
      ),
    );

    const pending = evaluate();
    // Wait until all three are actually PARKED. Resolving a gate before its
    // policy was dispatched would hand that policy an already-resolved promise,
    // collapsing the scripted order back into declaration order and making this
    // whole test pass vacuously.
    await settle();
    expect(started().slice().sort()).toEqual([...order].slice().sort());

    for (const id of order) gates.get(id)?.resolve({ findings: [flag(id)], mutations: [] });
    return pending;
  }

  it('is stable however the promises resolve', async () => {
    const forwards = await runResolvingIn(['w1', 'w2', 'w3']);
    const backwards = await runResolvingIn(['w3', 'w2', 'w1']);

    const order = ['w1', 'w2', 'w3'];
    expect(forwards.findings.map((finding) => finding.policyId)).toEqual(order);
    // THE PIN: collected by declaration index, never by completion order.
    expect(backwards.findings.map((finding) => finding.policyId)).toEqual(order);
    // And so is the one string the end user reads.
    expect(backwards.findings[0]?.message).toBe(forwards.findings[0]?.message);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The budget is re-checked before every policy
// ═══════════════════════════════════════════════════════════════════════════

describe('a budget that runs out mid-phase', () => {
  it('degrades every policy it overtook, and does NOT end the run', async () => {
    // THE PIN ON THE PER-POLICY RE-CHECK. Dispatching a phase all at once
    // resolves `exhausted()` once, before any of them starts, so a budget spent
    // DURING the phase goes unnoticed and every policy runs anyway — a change
    // in the fail-OPEN direction. Checking per policy is what makes a spent
    // budget visible.
    //
    // The signal is used rather than a wall clock because `exhausted()` reads
    // both and only the signal is deterministic in a unit test.
    const signal = { aborted: false };
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('p1', 'regex'), policy('p2', 'secrets'), policy('p3', 'pii')]),
    );
    script({
      p1: () => {
        signal.aborted = true;
        return { findings: [flag('p1')], mutations: [] };
      },
    });

    const verdict = await evaluate(signal);

    // p2 and p3 were never started...
    expect(started()).toEqual(['p1']);
    // ...but neither of them vanished: a policy that could not run must never
    // look like a policy that found nothing, so each carries its own degraded
    // entry AND its own `evaluation_error` finding, in declaration order.
    expect(verdict.degraded?.map((entry) => entry.policyId)).toEqual(['p2', 'p3']);
    expect(verdict.findings.map((finding) => finding.policyId)).toEqual(['p1', 'p2', 'p3']);
    expect(verdict.findings.slice(1).every((finding) => finding.code === 'evaluation_error')).toBe(
      true,
    );
    // Fail-OPEN, so the errors flag rather than block — the run degraded, it
    // did not stop at the first one.
    expect(verdict.decision).toBe('flag');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The audit trail of a short-circuited run
// ═══════════════════════════════════════════════════════════════════════════

describe('the evaluation log row a short-circuited run writes', () => {
  it('never reports a shortened findings list as a pass', async () => {
    // The row has no column for the policies that never ran, so the question is
    // whether dropping them can make the row LIE rather than merely be
    // incomplete. It cannot, and this is why: the run only stops because
    // something blocked, so the blocking finding is always in the list `passed`
    // and `decision` are computed from.
    hoisted.findGuardrailByKey.mockResolvedValue(
      guardrail([policy('blocker', 'regex'), policy('skipped', 'secrets')]),
    );
    script({ blocker: () => ({ findings: [blocks('blocker')], mutations: [] }) });

    const verdict = await evaluate();
    await drainPendingTasks(2_000);

    expect(started()).toEqual(['blocker']);
    expect(hoisted.createGuardrailEvaluationLog).toHaveBeenCalledTimes(1);
    const row = hoisted.createGuardrailEvaluationLog.mock.calls[0]?.[0] as {
      passed: boolean;
      decision: string;
      message: string | null;
      findings: Array<{ policyId?: string }>;
    };

    expect(verdict.decision).toBe('block');
    expect(row.passed).toBe(false);
    expect(row.decision).toBe('block');
    // `message` is `findings[0].message`, and it has to name a policy that
    // actually ran — a row whose message came from a policy that never ran
    // would be the audit trail describing work that never happened.
    expect(row.message).toBe('blocker blocked');
    expect(row.findings.map((finding) => finding.policyId)).toEqual(['blocker']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. A stored row that still carries the withdrawn lane fields
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `policy.layer` and `hooks.layerSettings` were persisted inside the hooks blob
 * while the policy-lane model existed, so rows on disk carry them and NOTHING
 * migrates them away. The read path has to tolerate and ignore them rather than
 * choke, and the write path has to stop emitting them — both of which happen in
 * `normalizeHooksConfig`, the same chokepoint that re-spells `hooks.checks`.
 *
 * The fixture is written to be REVERSED by the lanes it declares: the webhook
 * sits in lane 10 and the deterministic policy in lane 20, so a build that
 * still read them would start the remote round trip first. It is the strongest
 * available statement that the fields are inert.
 */
describe('a stored row written while lanes existed', () => {
  const lanedRow = () =>
    guardrail(
      [
        policy('sender', 'webhook', { layer: 10 }),
        policy('scanner', 'secrets', { layer: 20 }),
      ],
      { layerSettings: { 20: { stopOnBlock: false, label: 'Deterministic' }, 30: {} } },
    );

  it('runs in the normative order, not the order its lanes asked for', async () => {
    hoisted.findGuardrailByKey.mockResolvedValue(lanedRow());
    script({
      scanner: () => ({ findings: [flag('scanner')], mutations: [] }),
      sender: () => ({ findings: [flag('sender')], mutations: [] }),
    });

    const verdict = await evaluate();

    expect(started()).toEqual(['scanner', 'sender']);
    expect(verdict.findings.map((finding) => finding.policyId)).toEqual(['scanner', 'sender']);
  });

  it('short-circuits anyway — a lane knob is not a `shortCircuit`', async () => {
    // `layerSettings[20].stopOnBlock: false` is exactly the knob that used to
    // turn this off. The config's own `shortCircuit` is absent, so the default
    // (true) applies and the webhook is never called.
    hoisted.findGuardrailByKey.mockResolvedValue(lanedRow());
    script({ scanner: () => ({ findings: [blocks('scanner')], mutations: [] }) });

    const verdict = await evaluate();

    expect(started()).toEqual(['scanner']);
    expect(verdict.decision).toBe('block');
  });

  it('comes back off the read path without them, and saves again without them', () => {
    const { hooks } = ensureHooks(JSON.parse(JSON.stringify(lanedRow())));

    // Ignored, not rejected: the policies themselves survive intact.
    expect(hooks.policies.map((entry) => entry.id)).toEqual(['sender', 'scanner']);
    expect(hooks.policies.every((entry) => !('layer' in entry))).toBe(true);
    expect('layerSettings' in hooks).toBe(false);
    // And what the read path hands back is something the save gate accepts, so
    // the next edit of a laned row cannot fail on a field nothing reads.
    expect(validateGuardrailHooks(hooks)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The scope a remote family is dispatched with
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE OTHER HALF OF THE ABORT FIX, and the half no other test covers.
 *
 * `guardrail-webhook-abort.test.ts` proves the webhook family links the signal
 * it is HANDED to its per-attempt `AbortController`, so an abandoned request is
 * cancelled rather than merely ignored. It calls the family directly, so it
 * cannot see where that signal came from — and the engine is what supplies it.
 * The two together are the whole property; either alone is satisfied by a build
 * where an in-flight webhook still runs to completion.
 *
 * The second case is the one a future tidy-up would break. `dispatchPolicy`
 * narrows the budget for the families that can block on time by SPREADING the
 * scope, and a spread is the kind of line someone rewrites as a fresh literal
 * with the fields they happened to be thinking about. The signal is not one of
 * them, and dropping it is invisible: every assertion about findings and
 * ordering still passes, and only a caller that walks away pays.
 */
describe('the scope a remote family is dispatched with', () => {
  /** The `scope` the webhook policy was handed. */
  async function scopeSeenByWebhook(
    signal: HookAbortSignal,
    budgetMs?: number,
  ): Promise<HookScope> {
    hoisted.findGuardrailByKey.mockResolvedValue(guardrail([policy('sender', 'webhook')]));
    let seen: HookScope | undefined;
    script({
      sender: (input) => {
        seen = input.scope as HookScope;
        return nothing();
      },
    });

    await evaluate(signal, budgetMs);

    if (!seen) throw new Error('the webhook policy was never dispatched');
    return seen;
  }

  it('is the caller’s own signal, subscribable rather than only pollable', async () => {
    // A REAL `AbortSignal`, which is what a request-scoped caller already has
    // and the only kind that can be subscribed to. The engine must pass it
    // through unwrapped: a copy carrying `{ aborted }` alone would type-check,
    // and would silently degrade the family back to polling.
    const controller = new AbortController();

    const scope = await scopeSeenByWebhook(controller.signal);

    expect(scope.signal).toBe(controller.signal);
    expect(typeof scope.signal?.addEventListener).toBe('function');
    expect(typeof scope.signal?.removeEventListener).toBe('function');
  });

  it('still carries it once the engine narrows the budget', async () => {
    const controller = new AbortController();

    const scope = await scopeSeenByWebhook(controller.signal, 5_000);

    // The narrowing happened — this is the branch that rebuilds the object...
    expect(scope.budgetMs).toBeGreaterThan(0);
    expect(scope.budgetMs).toBeLessThanOrEqual(5_000);
    // ...and the signal survived it, still the caller's own.
    expect(scope.signal).toBe(controller.signal);
  });
});
