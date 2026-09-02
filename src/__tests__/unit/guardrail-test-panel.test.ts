import { describe, expect, it } from 'vitest';
import {
  MODE_HOOK,
  TEXT_HOOKS,
  absoluteFindings,
  assignPolicyColors,
  blockMessageGap,
  buildOverlay,
  buildRequestBody,
  chunkText,
  describeDecision,
  describeNarrowing,
  describeShape,
  messageSource,
  parseBatchInput,
  parseToolArgs,
  parseToolResult,
  planPolicies,
  planStreamWindow,
  readHookVerdict,
  resolveModeHook,
  resolveOnly,
  resolveStreamPlan,
  spliceWindowRedaction,
  splitCsvLine,
  subjectSegments,
  summarizeBatch,
  summarizeRun,
} from '@/components/guardrails/testPanelHelpers';
import type {
  PolicyPlanRow,
  HookVerdictResponse,
} from '@/components/guardrails/testPanelHelpers';
import {
  DEFERRED_PHASE_FAMILIES,
  POLICY_FAMILIES,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  GuardrailPolicy,
  GuardrailHooksConfig,
  PolicyFamily,
  RegexPolicyConfig,
  HookId,
  SafetyFinding,
} from '@/lib/services/guardrail/hooks/contract';

// ── fixtures ───────────────────────────────────────────────────────────────

const finding = (patch: Partial<SafetyFinding> = {}): SafetyFinding => ({
  type: 'pii',
  category: 'email',
  severity: 'high',
  message: 'email address',
  action: 'redact',
  block: false,
  family: 'pii',
  hook: 'input.pre',
  policyId: 'pii:default',
  ...patch,
});

const verdict = (patch: Partial<HookVerdictResponse> = {}): HookVerdictResponse => ({
  hook: 'input.pre',
  contract_version: 2,
  decision: 'allow',
  would_be_decision: 'allow',
  enforced: true,
  mode: 'enforce',
  disabled: false,
  passed: true,
  findings: [],
  mutations: [],
  subject: null,
  redacted_text: null,
  risk_score: 0,
  codes: [],
  blocked_message: null,
  message: null,
  guardrail_key: 'gr',
  guardrail_keys: ['gr'],
  guardrail_name: 'Guardrail',
  policy_version: 'gr@1',
  trace_id: 'trace',
  latency_ms: 4,
  degraded: [],
  cancelled: [],
  ...patch,
});

const policy = (patch: Partial<GuardrailPolicy> & { id: string }): GuardrailPolicy =>
  ({
    family: 'regex',
    enabled: true,
    hooks: ['input.pre'],
    schedule: { timing: 'sync', onFail: 'block' },
    rules: [],
    ...patch,
  }) as GuardrailPolicy;

const config = (policies: GuardrailPolicy[], hook: HookId = 'input.pre'): GuardrailHooksConfig => ({
  contractVersion: 2,
  policies,
  bindings: { [hook]: { enabled: true, schedule: { timing: 'sync', onFail: 'block' } } },
});

// ═══════════════════════════════════════════════════════════════════════════
// Span overlay
// ═══════════════════════════════════════════════════════════════════════════

describe('buildOverlay', () => {
  const segments = [{ path: '/text', text: 'hello brave world' }];

  it('returns the whole text as one plain run when nothing was found', () => {
    const overlay = buildOverlay(segments, []);
    expect(overlay.segments[0]?.runs).toEqual([{ text: 'hello brave world', findings: [] }]);
    expect(overlay.unpositioned).toEqual([]);
    expect(overlay.dropped).toEqual([]);
  });

  it('slices the text around a single span', () => {
    const overlay = buildOverlay(segments, [{ path: '/text', span: { start: 6, end: 11 } }]);
    expect(overlay.segments[0]?.runs).toEqual([
      { text: 'hello ', findings: [] },
      { text: 'brave', findings: [0] },
      { text: ' world', findings: [] },
    ]);
  });

  it('keeps BOTH owners on the characters two spans share', () => {
    const overlay = buildOverlay(segments, [
      { path: '/text', span: { start: 0, end: 11 } },
      { path: '/text', span: { start: 6, end: 17 } },
    ]);
    expect(overlay.segments[0]?.runs).toEqual([
      { text: 'hello ', findings: [0] },
      { text: 'brave', findings: [0, 1] },
      { text: ' world', findings: [1] },
    ]);
  });

  it('nests a span wholly inside another without losing the outer one', () => {
    const overlay = buildOverlay(segments, [
      { path: '/text', span: { start: 0, end: 17 } },
      { path: '/text', span: { start: 6, end: 11 } },
    ]);
    expect(overlay.segments[0]?.runs.map((run) => run.findings)).toEqual([[0], [0, 1], [0]]);
  });

  it('reassembles the original text exactly, whatever the spans', () => {
    const overlay = buildOverlay(segments, [
      { path: '/text', span: { start: 2, end: 9 } },
      { path: '/text', span: { start: 6, end: 6 } },
      { path: '/text', span: { start: 12, end: 40 } },
    ]);
    const joined = overlay.segments[0]?.runs.map((run) => run.text).join('');
    expect(joined).toBe('hello brave world');
  });

  it('clamps a span that runs off the end rather than dropping it', () => {
    const overlay = buildOverlay(segments, [{ path: '/text', span: { start: 12, end: 900 } }]);
    expect(overlay.dropped).toEqual([]);
    expect(overlay.segments[0]?.runs).toEqual([
      { text: 'hello brave ', findings: [] },
      { text: 'world', findings: [0] },
    ]);
  });

  it('drops a span that lies entirely outside the text, with a reason', () => {
    const overlay = buildOverlay(segments, [{ path: '/text', span: { start: 40, end: 50 } }]);
    expect(overlay.dropped).toHaveLength(1);
    expect(overlay.dropped[0]?.reason).toMatch(/outside/);
    expect(overlay.segments[0]?.runs).toEqual([{ text: 'hello brave world', findings: [] }]);
  });

  it('drops an inverted span instead of producing a negative run', () => {
    const overlay = buildOverlay(segments, [{ path: '/text', span: { start: 9, end: 3 } }]);
    expect(overlay.dropped).toHaveLength(1);
    expect(overlay.segments[0]?.runs).toEqual([{ text: 'hello brave world', findings: [] }]);
  });

  it('lists span-less findings separately — they are not a defect', () => {
    const overlay = buildOverlay(segments, [
      { path: '/text' },
      { path: '/text', span: { start: 0, end: 5 } },
    ]);
    expect(overlay.unpositioned).toEqual([0]);
    expect(overlay.dropped).toEqual([]);
    expect(overlay.segments[0]?.runs[0]).toEqual({ text: 'hello', findings: [1] });
  });

  it('places a path-less finding on the sole segment of a text subject', () => {
    const overlay = buildOverlay(segments, [{ span: { start: 0, end: 5 } }]);
    expect(overlay.segments[0]?.runs[0]?.findings).toEqual([0]);
  });

  it('refuses to guess a segment when the subject has several', () => {
    const overlay = buildOverlay(
      [
        { path: '/args/url', text: 'https://x.internal' },
        { path: '/args/note', text: 'hello' },
      ],
      [{ span: { start: 0, end: 5 } }],
    );
    expect(overlay.dropped[0]?.reason).toMatch(/several segments/);
  });

  it('routes each finding to the segment its path names', () => {
    const overlay = buildOverlay(
      [
        { path: '/args/url', text: 'https://x.internal' },
        { path: '/args/note', text: 'hello' },
      ],
      [
        { path: '/args/note', span: { start: 0, end: 5 } },
        { path: '/args/nope', span: { start: 0, end: 2 } },
      ],
    );
    expect(overlay.segments[1]?.runs).toEqual([{ text: 'hello', findings: [0] }]);
    expect(overlay.dropped[0]).toEqual({ index: 1, reason: 'no segment at /args/nope' });
  });

  it('emits no runs for an empty segment', () => {
    expect(buildOverlay([{ path: '/text', text: '' }], []).segments[0]?.runs).toEqual([]);
  });
});

describe('assignPolicyColors', () => {
  it('gives each policy its own colour, stable and repeat-tolerant', () => {
    const colors = assignPolicyColors(['regex:sqli', 'regex:internal-url', 'regex:sqli']);
    expect(colors['regex:sqli']).not.toBe(colors['regex:internal-url']);
    expect(Object.keys(colors)).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The run plan
// ═══════════════════════════════════════════════════════════════════════════

describe('planPolicies', () => {
  it('runs an enabled policy bound to the hook', () => {
    const plan = planPolicies({
      hooks: config([policy({ id: 'regex:sqli' })]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(plan[0]?.willRun).toBe(true);
    expect(plan[0]?.skipReason).toBeUndefined();
  });

  it('reports a disabled guardrail once, against every policy', () => {
    const plan = planPolicies({
      hooks: config([policy({ id: 'a' }), policy({ id: 'b' })]),
      hook: 'input.pre',
      mode: 'disabled',
    });
    expect(plan.every((row) => row.skipReason === 'guardrail-disabled')).toBe(true);
  });

  it('stops everything when the hook binding is off', () => {
    const hooks = config([policy({ id: 'a' })]);
    hooks.bindings = {};
    const plan = planPolicies({ hooks, hook: 'input.pre', mode: 'enforce' });
    expect(plan[0]?.skipReason).toBe('binding-off');
  });

  it('separates “switched off” from “not bound to this hook”', () => {
    const plan = planPolicies({
      hooks: config([
        policy({ id: 'off', enabled: false }),
        policy({ id: 'elsewhere', hooks: ['output.pre'] }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(plan[0]?.skipReason).toBe('policy-disabled');
    expect(plan[1]?.skipReason).toBe('not-bound');
  });

  it('marks a family the caller filtered out', () => {
    const plan = planPolicies({
      hooks: config([policy({ id: 'r', family: 'regex' }), policy({ id: 's', family: 'secrets' })]),
      hook: 'input.pre',
      mode: 'enforce',
      only: ['secrets'],
    });
    expect(plan[0]?.skipReason).toBe('family-filtered');
    expect(plan[1]?.willRun).toBe(true);
  });

  it('rejects a non-span-capable family on a stream window', () => {
    const hooks = config(
      [policy({ id: 'w', family: 'word_filter', hooks: ['output.stream.delta'] })],
      'output.stream.delta',
    );
    const plan = planPolicies({ hooks, hook: 'output.stream.delta', mode: 'enforce' });
    expect(plan[0]?.skipReason).toBe('not-stream-eligible');
  });

  it('rejects a family that is invalid on the hook it names', () => {
    const hooks = config([policy({ id: 't', family: 'tool_access', hooks: ['input.pre'] })]);
    const plan = planPolicies({ hooks, hook: 'input.pre', mode: 'enforce' });
    expect(plan[0]?.skipReason).toBe('invalid-for-hook');
  });

  it('mirrors the ENGINE on prompt_shield at output.pre', () => {
    // There is ONE table now: `POLICY_VALID_HOOKS` lists `output.pre` for
    // prompt_shield, and both the engine's dispatch and this predictor index
    // it directly. The panel used to mirror a widened runtime copy; the copy is
    // gone, and the assertion is unchanged because the answer never differed.
    const hooks = config(
      [policy({ id: 'ps', family: 'prompt_shield', hooks: ['output.pre'], modelKey: 'm' })],
      'output.pre',
    );
    const plan = planPolicies({ hooks, hook: 'output.pre', mode: 'enforce' });
    expect(plan[0]?.willRun).toBe(true);
  });

  it('classifies phases the way the engine does', () => {
    const plan = planPolicies({
      hooks: config([
        policy({ id: 'r', family: 'regex' }),
        policy({ id: 'm', family: 'moderation', modelKey: 'm' }),
        policy({ id: 'w', family: 'webhook', url: 'https://x', send: 'text' }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(plan.map((row) => row.deterministic)).toEqual([true, false, false]);
  });

  it('has nothing to plan when the config could not be loaded', () => {
    expect(planPolicies({ hooks: null, hook: 'input.pre', mode: 'enforce' })).toEqual([]);
  });

  it('lifts a LEGACY policy like any other — legacy: ids are not special', () => {
    const plan = planPolicies({
      hooks: config([policy({ id: 'legacy:pii', family: 'pii', piiPolicyKey: 'p' })]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(plan[0]).toMatchObject({ policyId: 'legacy:pii', label: 'legacy:pii', willRun: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Which hook the SUB-MODE implies
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The panel no longer asks which hook to run. The subject KIND is the one thing
 * it cannot infer — a tool call is not a sentence — and the hook follows from
 * it. These pin the following: a sub-mode that admits one hook offers no
 * choice, a text subject lands on the earliest hook the guardrail actually
 * serves, an explicit pick wins, and a pick the sub-mode cannot carry is
 * dropped rather than sent.
 */
const boundTo = (hooks: HookId[], policies: GuardrailPolicy[]): GuardrailHooksConfig => ({
  contractVersion: 2,
  policies,
  bindings: Object.fromEntries(
    hooks.map((hook) => [hook, { enabled: true, schedule: { timing: 'sync', onFail: 'block' } }]),
  ),
});

describe('resolveModeHook', () => {
  it('pins a tool sub-mode to its one hook and offers no choice', () => {
    const resolved = resolveModeHook({
      mode: 'tool_call',
      hooks: boundTo(['tool.pre'], [policy({ id: 't', family: 'tool_access', hooks: ['tool.pre'] })]),
      guardrailMode: 'enforce',
    });
    expect(resolved.hook).toBe('tool.pre');
    expect(resolved.fixed).toBe(true);
    expect(resolved.offers).toHaveLength(1);
    expect(resolved.reason).toMatch(/only ever adjudicated at tool\.pre/);
    expect(resolved.reason).toMatch(/1 policy runs there/);
  });

  it('takes the EARLIEST text hook the guardrail actually serves', () => {
    // Bound to both, but only output.pre carries a policy: input.pre would be
    // a vacuous allow, and defaulting to it is how the old panel let an
    // operator conclude the guardrail does nothing.
    const resolved = resolveModeHook({
      mode: 'text',
      hooks: boundTo(
        ['input.pre', 'output.pre'],
        [policy({ id: 'r', hooks: ['output.pre'] })],
      ),
      guardrailMode: 'enforce',
    });
    expect(resolved.hook).toBe('output.pre');
    expect(resolved.chosen).toBe(false);
    expect(resolved.served).toBe(true);
    expect(resolved.reason).toMatch(/earliest text hook this guardrail serves/);
  });

  it('prefers prompt.pre over input.pre when both are served — chronological order', () => {
    const resolved = resolveModeHook({
      mode: 'text',
      hooks: boundTo(
        ['prompt.pre', 'input.pre'],
        [policy({ id: 'a', hooks: ['prompt.pre'] }), policy({ id: 'b', hooks: ['input.pre'] })],
      ),
      guardrailMode: 'enforce',
    });
    expect(resolved.hook).toBe('prompt.pre');
    // …and it says the other one is there, so the operator is not left to
    // discover it by opening the Hooks tab.
    expect(resolved.reason).toMatch(/also runs on input\.pre/);
  });

  it('counts, per offer, what would run there with no filter', () => {
    const resolved = resolveModeHook({
      mode: 'text',
      hooks: boundTo(
        ['input.pre', 'output.pre'],
        [
          policy({ id: 'a', hooks: ['input.pre'] }),
          policy({ id: 'b', hooks: ['input.pre'] }),
          policy({ id: 'c', hooks: ['output.pre'], enabled: false }),
        ],
      ),
      guardrailMode: 'enforce',
    });
    expect(resolved.offers).toEqual([
      { hook: 'prompt.pre', runs: 0, served: false },
      { hook: 'input.pre', runs: 2, served: true },
      { hook: 'output.pre', runs: 0, served: false },
    ]);
  });

  it('honours an explicit pick, and says it was the operator’s', () => {
    const resolved = resolveModeHook({
      mode: 'text',
      hooks: boundTo(['input.pre', 'output.pre'], [policy({ id: 'a', hooks: ['input.pre'] })]),
      guardrailMode: 'enforce',
      preferred: 'output.pre',
    });
    expect(resolved.hook).toBe('output.pre');
    expect(resolved.chosen).toBe(true);
    expect(resolved.served).toBe(false);
    expect(resolved.reason).toMatch(/You picked output\.pre/);
    expect(resolved.reason).toMatch(/vacuous allow/);
  });

  it('DROPS a pick the sub-mode cannot carry rather than sending it', () => {
    // output.pre left over from Text, then a switch to Tool call. Sending it
    // would ask the server for a hook whose subject is not a tool call.
    const resolved = resolveModeHook({
      mode: 'tool_result',
      hooks: boundTo(['tool.post'], [policy({ id: 't', family: 'tool_access', hooks: ['tool.post'] })]),
      guardrailMode: 'enforce',
      preferred: 'output.pre',
    });
    expect(resolved.hook).toBe('tool.post');
    expect(resolved.chosen).toBe(false);
  });

  it('says plainly when no text hook is served at all', () => {
    const resolved = resolveModeHook({
      mode: 'batch',
      hooks: boundTo(['tool.pre'], [policy({ id: 't', family: 'tool_access', hooks: ['tool.pre'] })]),
      guardrailMode: 'enforce',
    });
    expect(resolved.served).toBe(false);
    expect(resolved.hook).toBe('input.pre');
    expect(resolved.reason).toMatch(/runs no policy on any text hook/);
  });

  it('serves nothing anywhere while the guardrail is disabled', () => {
    const resolved = resolveModeHook({
      mode: 'text',
      hooks: boundTo(['input.pre'], [policy({ id: 'a' })]),
      guardrailMode: 'disabled',
    });
    expect(resolved.offers.every((offer) => offer.served)).toBe(false);
    expect(resolved.reason).toMatch(/vacuous allow/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The guardrail's own shape
// ═══════════════════════════════════════════════════════════════════════════

describe('describeShape', () => {
  it('lists the rows in the order the ENGINE reaches them, not the stored one', () => {
    // The deterministic pass runs first, one policy after another in stored
    // order; the model-backed and webhook families run last, started together.
    // A card that showed the stored order would tell an operator the judge
    // adjudicates before the regex policy, which is the opposite of the truth.
    const shape = describeShape({
      hooks: config([
        policy({ id: 'judge', family: 'custom', prompt: 'x', modelKey: 'm' }),
        policy({ id: 'regex' }),
        policy({ id: 'hook', family: 'webhook', url: 'https://x.example' }),
        policy({ id: 'words', family: 'word_filter', words: ['x'] }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(shape.rows.map((r) => r.policyId)).toEqual(['regex', 'words', 'judge', 'hook']);
    expect(shape.rows.map((r) => r.deterministic)).toEqual([true, true, false, false]);
    expect(shape.runs).toBe(4);
    expect(shape.total).toBe(4);
  });

  it('keeps the stored order WITHIN a phase, because that is the finding order', () => {
    const shape = describeShape({
      hooks: config([
        policy({ id: 'second' }),
        policy({ id: 'first', family: 'word_filter', words: ['x'] }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(shape.rows.map((r) => r.policyId)).toEqual(['second', 'first']);
  });

  it('puts a family this build has never heard of in the FIRST phase, as the engine does', () => {
    // `runsInDeterministicPhase` asks "is it NOT deferred" precisely so that a
    // row written by a newer console lands in phase 1 — the phase whose
    // dispatcher turns an unknown family into a degraded entry. The panel reads
    // the same exported set for the same reason. Asking
    // `DETERMINISTIC_POLICY_FAMILIES.has(family)` here instead would order this
    // policy LAST while the server ran it FIRST, and a predictor that
    // contradicts the engine is worse than no predictor at all.
    const shape = describeShape({
      hooks: config([
        policy({ id: 'hook', family: 'webhook', url: 'https://x.example' }),
        policy({ id: 'from-the-future', family: 'quantum_shield' as PolicyFamily }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(shape.rows.map((r) => r.policyId)).toEqual(['from-the-future', 'hook']);
    expect(shape.rows.map((r) => r.deterministic)).toEqual([true, false]);
    // And it is predicted to RUN: an enabled policy must never go invisible
    // just because this build cannot name its family.
    expect(shape.runs).toBe(2);
  });

  it('splits EVERY family the same way the engine does, read from the engine’s own set', () => {
    // THE DRIFT GUARD. The panel used to re-list the deferred families locally,
    // so a family added to `DEFERRED_PHASE_FAMILIES` would have moved phase in
    // the engine and stayed put here — the card then claiming a remote round
    // trip runs before the cheap local checks. Comparing against the exported
    // set across the whole family table is what makes that divergence a test
    // failure instead of a support ticket.
    const shape = describeShape({
      hooks: config(POLICY_FAMILIES.map((family) => policy({ id: family, family }))),
      hook: 'input.pre',
      mode: 'enforce',
    });
    const byId = new Map(shape.rows.map((row) => [row.policyId, row.deterministic]));
    for (const family of POLICY_FAMILIES) {
      expect([family, byId.get(family)]).toEqual([family, !DEFERRED_PHASE_FAMILIES.has(family)]);
    }
  });

  it('lists every policy that will NOT run, with the reason it will not', () => {
    const shape = describeShape({
      hooks: config([
        policy({ id: 'runs' }),
        policy({ id: 'off', enabled: false }),
        policy({ id: 'elsewhere', hooks: ['output.pre'] }),
        policy({ id: 'tool', family: 'tool_access', hooks: ['input.pre'] }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    expect(shape.runs).toBe(1);
    expect(shape.skipped.map((row) => [row.policyId, row.skipReason])).toEqual([
      ['off', 'policy-disabled'],
      ['elsewhere', 'not-bound'],
      ['tool', 'invalid-for-hook'],
    ]);
  });

  it('reports the policy filter as the reason, so an isolated run explains itself', () => {
    const shape = describeShape({
      hooks: config([policy({ id: 'r', family: 'regex' }), policy({ id: 's', family: 'secrets' })]),
      hook: 'input.pre',
      mode: 'enforce',
      only: ['secrets'],
    });
    expect(shape.skipped.map((row) => row.skipReason)).toEqual(['family-filtered']);
  });

  it('calls an onSideEffect gate on a text hook what it is: unmeetable', () => {
    const shape = describeShape({
      hooks: config([
        policy({ id: 'judge', family: 'custom', runIf: 'onSideEffect', prompt: 'x', modelKey: 'm' }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    const row = shape.rows[0];
    expect(row?.willRun).toBe(true);
    expect(row?.gateUnmeetable).toBe(true);
    expect(row?.gateNote).toMatch(/can never be met here/);
  });

  it('states an onFinding gate as a condition rather than guessing at it', () => {
    const shape = describeShape({
      hooks: config([
        policy({ id: 'judge', family: 'custom', runIf: 'onFinding', prompt: 'x', modelKey: 'm' }),
      ]),
      hook: 'input.pre',
      mode: 'enforce',
    });
    const row = shape.rows[0];
    expect(row?.gateUnmeetable).toBeUndefined();
    expect(row?.gateNote).toMatch(/only once a cheaper policy/);
  });

  it('reports shortCircuit, defaulted the way the engine defaults it', () => {
    // TRUE unless the config says otherwise — and every lifted legacy config
    // says otherwise, so the two answers are both real and both common.
    const hooks = config([policy({ id: 'a' })]);
    expect(describeShape({ hooks, hook: 'input.pre', mode: 'enforce' }).stopsOnBlock).toBe(true);
    hooks.shortCircuit = false;
    expect(describeShape({ hooks, hook: 'input.pre', mode: 'enforce' }).stopsOnBlock).toBe(false);
  });

  it('has a shape to show even when the compiled config never loaded', () => {
    const shape = describeShape({ hooks: null, hook: 'input.pre', mode: 'enforce' });
    expect(shape).toMatchObject({ rows: [], runs: 0, total: 0, skipped: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reconciling the plan with the verdict
// ═══════════════════════════════════════════════════════════════════════════

const row = (patch: Partial<PolicyPlanRow> & { policyId: string }): PolicyPlanRow => ({
  family: 'regex',
  label: patch.policyId,
  deterministic: true,
  sync: true,
  runIf: 'always',
  willRun: true,
  ...patch,
});

describe('summarizeRun', () => {
  it('never lets a skipped policy read as a clean one', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'a' }), row({ policyId: 'b', willRun: false, skipReason: 'policy-disabled' })],
      verdict: verdict(),
    });
    expect(rows[0]?.status).toBe('clean');
    expect(rows[1]?.status).toBe('skipped');
    expect(rows[1]?.detail).toMatch(/switched off/);
  });

  it('attributes findings to the policy that produced them', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'a' }), row({ policyId: 'b' })],
      verdict: verdict({ findings: [finding({ policyId: 'b' }), finding({ policyId: 'b' })] }),
    });
    expect(rows[0]?.status).toBe('clean');
    expect(rows[1]).toMatchObject({ status: 'findings', findingIndexes: [0, 1] });
  });

  it('marks everything after the first blocking sync policy short-circuited', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'a' }), row({ policyId: 'b' }), row({ policyId: 'c' })],
      verdict: verdict({
        decision: 'block',
        would_be_decision: 'block',
        findings: [finding({ policyId: 'b', block: true, action: 'block' })],
      }),
    });
    expect(rows.map((r) => r.status)).toEqual(['clean', 'findings', 'short-circuited']);
  });

  it('prefers a CANCELLED entry the engine reported over its own replay of the cut', () => {
    // No verdict this build produces carries one — the engine awaits every
    // policy it starts — but the key is still on the wire and a remote
    // enforcement point may populate it. A policy DECLARED BEFORE the blocker
    // that was abandoned is exactly what no reconstruction from
    // `index > cutAfter` can produce, so the engine's own answer wins and its
    // reason is quoted rather than paraphrased.
    const rows = summarizeRun({
      plan: [row({ policyId: 'a' }), row({ policyId: 'b' }), row({ policyId: 'c' })],
      verdict: verdict({
        decision: 'block',
        would_be_decision: 'block',
        // 'c' blocked; 'a' — declared FIRST — never finished.
        findings: [finding({ policyId: 'c', block: true, action: 'block' })],
        cancelled: [{ policyId: 'a', family: 'regex', reason: 'the hook budget ran out' }],
      }),
    });

    expect(rows[0]?.status).toBe('short-circuited');
    expect(rows[0]?.detail).toMatch(/abandoned/);
    expect(rows[0]?.detail).toContain('the hook budget ran out');
    expect(rows[2]?.status).toBe('findings');
  });

  it('stops the LLM phase too — it never starts once a policy blocked', () => {
    const rows = summarizeRun({
      plan: [
        row({ policyId: 'judge', family: 'moderation', deterministic: false }),
        row({ policyId: 'regex', family: 'regex' }),
      ],
      verdict: verdict({
        decision: 'block',
        findings: [finding({ policyId: 'regex', block: true, action: 'block' })],
      }),
    });
    // The judge is FIRST in the array but runs in phase 3, so a phase-1 block
    // still cuts it — which an index-only rule would have got wrong.
    expect(rows[0]?.status).toBe('short-circuited');
    expect(rows[1]?.status).toBe('findings');
  });

  it('does not short-circuit when the operator turned it off', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'a' }), row({ policyId: 'b' })],
      shortCircuit: false,
      verdict: verdict({
        decision: 'block',
        findings: [finding({ policyId: 'a', block: true, action: 'block' })],
      }),
    });
    expect(rows.map((r) => r.status)).toEqual(['findings', 'clean']);
  });

  it('does not short-circuit on an ASYNC policy, however blocking its finding', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'a', sync: false }), row({ policyId: 'b' })],
      verdict: verdict({
        findings: [finding({ policyId: 'a', block: true, action: 'block' })],
      }),
    });
    expect(rows[1]?.status).toBe('clean');
  });

  it('treats a critical finding as blocking even when block is false', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'a' }), row({ policyId: 'b' })],
      verdict: verdict({
        findings: [finding({ policyId: 'a', block: false, critical: true })],
      }),
    });
    expect(rows[1]?.status).toBe('short-circuited');
  });

  it('reports a policy that could not run as degraded, with the reason', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'judge', family: 'moderation', deterministic: false, sync: true })],
      verdict: verdict({
        findings: [finding({ policyId: 'judge', category: 'evaluation_error', block: false })],
        degraded: [{ policyId: 'judge', family: 'moderation', reason: 'model unavailable' }],
      }),
    });
    expect(rows[0]).toMatchObject({ status: 'degraded', detail: 'model unavailable' });
  });

  it('explains an onSideEffect gate on a hook that carries no tool', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'judge', family: 'custom', deterministic: false, runIf: 'onSideEffect' })],
      verdict: verdict(),
    });
    expect(rows[0]?.status).toBe('gated');
    expect(rows[0]?.detail).toMatch(/no tool call/);
  });

  it('explains an onFinding gate that nothing woke', () => {
    const rows = summarizeRun({
      plan: [
        row({ policyId: 'regex' }),
        row({ policyId: 'judge', family: 'custom', deterministic: false, runIf: 'onFinding' }),
      ],
      verdict: verdict(),
    });
    expect(rows[1]?.status).toBe('gated');
  });

  it('admits it cannot tell whether an onSideEffect gate was met on a tool hook', () => {
    const rows = summarizeRun({
      plan: [row({ policyId: 'judge', family: 'custom', deterministic: false, runIf: 'onSideEffect' })],
      verdict: verdict({ hook: 'tool.pre' }),
    });
    expect(rows[0]?.status).toBe('unknown');
    expect(rows[0]?.detail).toMatch(/classified/);
  });

  it('does not claim the gate fired when a deterministic policy did find something', () => {
    const rows = summarizeRun({
      plan: [
        row({ policyId: 'regex' }),
        row({ policyId: 'judge', family: 'custom', deterministic: false, runIf: 'onFinding' }),
      ],
      verdict: verdict({ findings: [finding({ policyId: 'regex' })] }),
    });
    expect(rows[1]?.status).toBe('clean');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Decision + message
// ═══════════════════════════════════════════════════════════════════════════

describe('describeDecision', () => {
  it('reads a monitored block as “would have blocked”', () => {
    const summary = describeDecision(
      verdict({ decision: 'allow', would_be_decision: 'block', enforced: false, mode: 'monitor' }),
    );
    expect(summary.wouldHaveBlocked).toBe(true);
    expect(summary.label).toBe('would have blocked');
    expect(summary.detail).toMatch(/not enforced/);
  });

  it('reads an enforced block as a block', () => {
    const summary = describeDecision(
      verdict({ decision: 'block', would_be_decision: 'block', enforced: true }),
    );
    expect(summary.wouldHaveBlocked).toBe(false);
    expect(summary.label).toBe('block');
  });

  it('calls a vacuous allow what it is', () => {
    const summary = describeDecision(verdict({ disabled: true, enforced: false, mode: 'disabled' }));
    expect(summary.vacuous).toBe(true);
    expect(summary.detail).toMatch(/nothing was checked/);
  });

  it('spells a suppressed non-block decision as a word', () => {
    const summary = describeDecision(
      verdict({ decision: 'allow', would_be_decision: 'flag', enforced: false, mode: 'monitor' }),
    );
    expect(summary.label).toBe('would have flagged');
  });
});

describe('messageSource', () => {
  it('names the first BLOCKING finding, not the first finding', () => {
    const result = messageSource(
      verdict({
        findings: [finding({ policyId: 'pii' }), finding({ policyId: 'legal', block: true })],
      }),
    );
    expect(result?.policyId).toBe('legal');
  });

  it('falls back to the first finding when none blocks — as renderBlock does', () => {
    expect(messageSource(verdict({ findings: [finding({ policyId: 'pii' })] }))?.policyId).toBe('pii');
  });

  it('has nothing to name when there are no findings', () => {
    expect(messageSource(verdict())).toBeNull();
  });
});

describe('blockMessageGap', () => {
  it('flags the monitor-mode block whose message the server never rendered', () => {
    expect(blockMessageGap(verdict({ decision: 'allow', would_be_decision: 'block' }))).toBe(true);
  });
  it('is silent when the message is there', () => {
    expect(
      blockMessageGap(
        verdict({
          decision: 'block',
          would_be_decision: 'block',
          blocked_message: {
            reasonClass: 'pii',
            body: 'no',
            mode: 'error',
            status: 400,
            traceId: 't',
          },
        }),
      ),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Isolating a rule
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveOnly', () => {
  const policies = [
    policy({ id: 'regex:sqli', family: 'regex' }),
    policy({ id: 'regex:internal-url', family: 'regex' }),
    policy({ id: 'webhook:legal', family: 'webhook' }),
  ];

  it('sends no filter when nothing is selected', () => {
    expect(resolveOnly(policies, [])).toEqual({ families: [], pulledIn: [] });
  });

  it('names the policies that ride along, because only filters by family', () => {
    const plan = resolveOnly(policies, ['regex:sqli']);
    expect(plan.families).toEqual(['regex']);
    expect(plan.pulledIn).toEqual(['regex:internal-url']);
  });

  it('has nothing to warn about once every policy in the family is selected', () => {
    const plan = resolveOnly(policies, ['regex:sqli', 'regex:internal-url']);
    expect(plan.pulledIn).toEqual([]);
  });

  it('does not count a disabled sibling — it would not have run anyway', () => {
    const plan = resolveOnly(
      [policy({ id: 'a', family: 'regex' }), policy({ id: 'b', family: 'regex', enabled: false })],
      ['a'],
    );
    expect(plan.pulledIn).toEqual([]);
  });
});

/**
 * THE BANNER CONDITION.
 *
 * Narrowing is a debug affordance now, not the front door, and the price of
 * keeping it is that a narrowed run must never be mistaken for production. The
 * distinction these pin is `narrowed` (a filter is on the wire) versus `differs`
 * (the filter actually changes what runs on this hook) — a banner that shouts at
 * a run which IS production is one operators learn to skip.
 */
describe('describeNarrowing', () => {
  const policies = [
    policy({ id: 'regex:sqli', family: 'regex' }),
    policy({ id: 'regex:url', family: 'regex' }),
    policy({ id: 'secrets:keys', family: 'secrets' }),
  ];
  const plan = () => planPolicies({ hooks: config(policies), hook: 'input.pre', mode: 'enforce' });

  it('is silent when nothing is selected — the default IS production', () => {
    const narrowing = describeNarrowing({ policies, selectedPolicyIds: [], plan: plan() });
    expect(narrowing).toEqual({
      narrowed: false,
      differs: false,
      families: [],
      excluded: [],
      pulledIn: [],
      banner: null,
    });
  });

  it('names what production would run and this will not', () => {
    const narrowing = describeNarrowing({
      policies,
      selectedPolicyIds: ['secrets:keys'],
      plan: plan(),
    });
    expect(narrowing).toMatchObject({ narrowed: true, differs: true, families: ['secrets'] });
    expect(narrowing.excluded).toEqual(['regex:sqli', 'regex:url']);
    expect(narrowing.banner).toMatch(/not what production will run/);
    expect(narrowing.banner).toMatch(/regex:sqli, regex:url/);
  });

  it('names the family-mates that ride along, because only filters by family', () => {
    const narrowing = describeNarrowing({
      policies,
      selectedPolicyIds: ['regex:sqli'],
      plan: plan(),
    });
    expect(narrowing.pulledIn).toEqual(['regex:url']);
    expect(narrowing.banner).toMatch(/regex:url still runs/);
  });

  it('does NOT cry wolf when the filter excludes nothing that would have run', () => {
    const narrowing = describeNarrowing({
      policies,
      selectedPolicyIds: ['regex:sqli', 'regex:url', 'secrets:keys'],
      plan: plan(),
    });
    expect(narrowing.narrowed).toBe(true);
    expect(narrowing.differs).toBe(false);
    expect(narrowing.banner).toMatch(/matches production/);
  });

  it('counts only the policies that would have run on THIS hook', () => {
    // The secrets policy is bound elsewhere, so filtering it out costs nothing
    // on input.pre and the banner must not claim otherwise.
    const elsewhere = [
      policy({ id: 'regex:sqli', family: 'regex' }),
      policy({ id: 'secrets:keys', family: 'secrets', hooks: ['output.pre'] }),
    ];
    const narrowing = describeNarrowing({
      policies: elsewhere,
      selectedPolicyIds: ['regex:sqli'],
      plan: planPolicies({ hooks: config(elsewhere), hook: 'input.pre', mode: 'enforce' }),
    });
    expect(narrowing.differs).toBe(false);
    expect(narrowing.excluded).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Request bodies
// ═══════════════════════════════════════════════════════════════════════════

describe('buildRequestBody', () => {
  it('omits an empty only — the server reads [] as “no filter” anyway', () => {
    const body = buildRequestBody({ kind: 'text', text: 'hi' }, { only: [], shadow: true });
    expect(body).toEqual({ shadow: true, text: 'hi' });
  });

  it('sends a tool call the way buildHookSubject reads it', () => {
    const body = buildRequestBody(
      { kind: 'tool_call', toolName: 'fs/read', args: { path: '/etc' } },
      { only: ['tool_access'], shadow: false },
    );
    expect(body).toEqual({
      shadow: false,
      only: ['tool_access'],
      tool_name: 'fs/read',
      tool_args: { path: '/etc' },
    });
  });

  it('always sends tool_result, since the route 400s without it', () => {
    const body = buildRequestBody(
      { kind: 'tool_result', toolName: 't', args: {}, result: undefined },
      { shadow: true },
    );
    expect(body.tool_result).toBeNull();
  });

  it('sends the stream window fields the subject builder requires', () => {
    const body = buildRequestBody(
      { kind: 'stream', buffer: 'abcdef', delta: 'def', releasedTo: 3, seq: 2, final: true },
      { shadow: true },
    );
    expect(body).toMatchObject({ buffer: 'abcdef', released_to: 3, seq: 2, final: true });
  });
});

describe('subjectSegments', () => {
  it('addresses a text subject at /text', () => {
    expect(subjectSegments({ kind: 'text', text: 'hi' })).toEqual([{ path: '/text', text: 'hi' }]);
  });

  it('walks tool arguments to one segment per string leaf', () => {
    expect(
      subjectSegments({
        kind: 'tool_call',
        toolName: 't',
        args: { url: 'https://x', nested: { a: ['deep', 4] }, empty: '' },
      }),
    ).toEqual([
      { path: '/args/url', text: 'https://x' },
      { path: '/args/nested/a/0', text: 'deep' },
    ]);
  });

  it('escapes a pointer token containing a slash', () => {
    expect(subjectSegments({ kind: 'tool_call', toolName: 't', args: { 'a/b': 'x' } })).toEqual([
      { path: '/args/a~1b', text: 'x' },
    ]);
  });
});

describe('parseToolArgs / parseToolResult', () => {
  it('accepts an empty editor as an empty object', () => {
    expect(parseToolArgs('   ')).toEqual({ args: {} });
  });
  it('refuses a non-object, the way the route does', () => {
    expect(parseToolArgs('[1,2]').error).toMatch(/object/);
  });
  it('reports a syntax error instead of sending a request', () => {
    expect(parseToolArgs('{oops').error).toBeTruthy();
  });
  it('lets a tool result be any JSON value, including a bare string', () => {
    expect(parseToolResult('"plain"')).toBe('plain');
    expect(parseToolResult('not json')).toBe('not json');
  });
});

describe('hook/sub-mode wiring', () => {
  it('offers exactly the hooks whose subject is text', () => {
    // UPDATED when `prompt.pre` was added to the contract. `TEXT_HOOKS` is
    // DERIVED from `HOOK_SUBJECT_KIND`, and `prompt.pre` carries a text
    // subject, so it belongs here — the derivation doing this by itself is the
    // behaviour the comment on `TEXT_HOOKS` promises. It matters more than
    // usual for this hook: no console surface emits `prompt.pre`, so the test
    // panel is the ONLY way an operator can exercise a binding on it.
    expect([...TEXT_HOOKS]).toEqual(['prompt.pre', 'input.pre', 'output.pre']);
  });
  it('pins each other sub-mode to one hook', () => {
    expect(MODE_HOOK).toEqual({
      tool_call: 'tool.pre',
      tool_result: 'tool.post',
      stream: 'output.stream.delta',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reading the wire
// ═══════════════════════════════════════════════════════════════════════════

describe('readHookVerdict', () => {
  it('rejects anything that is not a verdict', () => {
    expect(readHookVerdict({ error: 'Guardrail not found' })).toBeNull();
    expect(readHookVerdict(null)).toBeNull();
  });

  it('fills in what an older build omitted rather than failing the render', () => {
    const parsed = readHookVerdict({ decision: 'block', hook: 'tool.pre' });
    expect(parsed).toMatchObject({
      decision: 'block',
      would_be_decision: 'block',
      enforced: false,
      findings: [],
      degraded: [],
    });
  });

  it('keeps findings intact, spans included', () => {
    const parsed = readHookVerdict({
      decision: 'redact',
      findings: [{ policyId: 'x', span: { start: 1, end: 2 } }],
    });
    expect(parsed?.findings[0]?.span).toEqual({ start: 1, end: 2 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Streaming
// ═══════════════════════════════════════════════════════════════════════════

const streamConfig = (patch: Partial<GuardrailHooksConfig> = {}): GuardrailHooksConfig => ({
  contractVersion: 2,
  policies: [
    policy({
      id: 'regex:card',
      family: 'regex',
      hooks: ['output.stream.delta'],
      rules: [
        {
          id: 'r',
          label: 'card',
          pattern: '\\d{16}',
          category: 'card',
          severity: 'high',
          maxMatchChars: 32,
        },
      ],
    }),
  ],
  bindings: {
    'output.stream.delta': { enabled: true, schedule: { timing: 'sync', onFail: 'block' } },
  },
  stream: { enabled: true, holdBackChars: 16, overlapChars: 8, maxHeldChars: 64 },
  ...patch,
});

describe('resolveStreamPlan', () => {
  it('gates the stream when everything lines up', () => {
    const result = resolveStreamPlan(streamConfig(), 'enforce');
    expect(result.plan?.eligiblePolicyIds).toEqual(['regex:card']);
    // overlap is raised to max(policyMaxMatchChars) and hold-back to the overlap.
    expect(result.plan?.requiredOverlap).toBe(32);
    expect(result.plan?.settings.overlapChars).toBe(32);
    expect(result.plan?.settings.holdBackChars).toBe(32);
    expect(result.plan?.settings.maxHeldChars).toBe(64);
  });

  it('does not gate a monitor-mode guardrail, and says why', () => {
    const result = resolveStreamPlan(streamConfig(), 'monitor');
    expect(result.plan).toBeUndefined();
    expect(result.reason).toMatch(/enforcing/);
  });

  it('refuses a policy with no bounded match length instead of under-scanning', () => {
    const hooks = streamConfig({
      policies: [
        policy({
          id: 'regex:loose',
          family: 'regex',
          hooks: ['output.stream.delta'],
          // No maxMatchChars: policyMaxMatchChars returns 0, i.e. "unbounded".
          rules: [
            { id: 'r', label: 'any', pattern: '.*', category: 'any', severity: 'low' },
          ] as RegexPolicyConfig['rules'],
        }),
      ],
    });
    const result = resolveStreamPlan(hooks, 'enforce');
    expect(result.plan).toBeUndefined();
    expect(result.reason).toMatch(/bounded match length/);
  });

  it('distinguishes “no eligible policy” from “streaming off”', () => {
    expect(resolveStreamPlan(streamConfig({ stream: { enabled: false } }), 'enforce').reason).toMatch(
      /switched off/,
    );
    expect(
      resolveStreamPlan(
        streamConfig({
          policies: [
            policy({ id: 'w', family: 'word_filter', hooks: ['output.stream.delta'], words: ['x'] }),
          ],
        }),
        'enforce',
      ).reason,
    ).toMatch(/stream-eligible/);
  });
});

describe('planStreamWindow', () => {
  const settings = {
    enabled: true as const,
    holdBackChars: 10,
    overlapChars: 4,
    holdBackMs: 200,
    maxHeldChars: 40,
    onBudgetExceeded: 'release' as const,
    onBlock: 'truncate' as const,
  };

  it('emits nothing while less than the hold-back has arrived', () => {
    expect(
      planStreamWindow({ buffer: 'abcdefgh', releasedTo: 0, seq: 0, final: false, settings }),
    ).toBeNull();
  });

  it('scans back into released text by the overlap, so a straddling match is seen whole', () => {
    const win = planStreamWindow({
      buffer: 'a'.repeat(30),
      releasedTo: 10,
      seq: 1,
      final: false,
      settings,
    });
    expect(win).toMatchObject({ windowStart: 6, releasedInWindow: 4, unadjudicated: 0 });
    expect(win?.windowText).toHaveLength(24);
    expect(win?.releaseTo).toBe(20);
  });

  it('releases everything on the final window', () => {
    const win = planStreamWindow({
      buffer: 'a'.repeat(20),
      releasedTo: 18,
      seq: 2,
      final: true,
      settings,
    });
    expect(win?.releaseTo).toBe(20);
  });

  it('reports characters that maxHeldChars forces out unadjudicated', () => {
    const win = planStreamWindow({
      buffer: 'a'.repeat(100),
      releasedTo: 5,
      seq: 3,
      final: false,
      settings,
    });
    expect(win?.windowStart).toBe(60);
    expect(win?.unadjudicated).toBe(55);
  });
});

describe('chunkText', () => {
  it('splits into fixed-size chunks that rejoin exactly', () => {
    expect(chunkText('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
  });
  it('never produces a zero-length step', () => {
    expect(chunkText('ab', 0)).toEqual(['a', 'b']);
  });
  it('yields one empty chunk for empty text, so the final window still runs', () => {
    expect(chunkText('', 4)).toEqual(['']);
  });
});

describe('absoluteFindings', () => {
  it('lifts window offsets onto the whole stream', () => {
    const lifted = absoluteFindings([finding({ span: { start: 2, end: 5 } }), finding()], 100);
    expect(lifted[0]?.span).toEqual({ start: 102, end: 105 });
    expect(lifted[1]?.span).toBeUndefined();
  });
  it('is a no-op for the first window', () => {
    const input = [finding({ span: { start: 2, end: 5 } })];
    expect(absoluteFindings(input, 0)[0]?.span).toEqual({ start: 2, end: 5 });
  });
});

describe('spliceWindowRedaction', () => {
  const win = {
    seq: 0,
    final: false,
    windowStart: 4,
    windowText: 'HEADtail',
    releasedInWindow: 4,
    unadjudicated: 0,
    releaseTo: 12,
  };

  it('writes the rewrite into the pending region only', () => {
    const result = spliceWindowRedaction({
      buffer: 'xxxxHEADtail',
      releasedTo: 8,
      window: win,
      redacted: 'HEAD[REDACTED]',
    });
    expect(result.buffer).toBe('xxxxHEAD[REDACTED]');
    expect(result.unreachable).toBe(false);
  });

  it('reports a rewrite that targets already-released text', () => {
    const result = spliceWindowRedaction({
      buffer: 'xxxxHEADtail',
      releasedTo: 8,
      window: win,
      redacted: '****tail',
    });
    expect(result.unreachable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Batch
// ═══════════════════════════════════════════════════════════════════════════

describe('splitCsvLine', () => {
  it('respects quotes and escaped quotes', () => {
    expect(splitCsvLine('a,"b,c","say ""hi""",d')).toEqual(['a', 'b,c', 'say "hi"', 'd']);
  });
});

describe('parseBatchInput', () => {
  it('reads one subject per line', () => {
    const parsed = parseBatchInput('first\n\n# a comment\nsecond');
    expect(parsed.format).toBe('plain');
    expect(parsed.rows).toEqual([
      { line: 1, text: 'first' },
      { line: 4, text: 'second' },
    ]);
  });

  it('reads JSONL and picks up the expectation', () => {
    const parsed = parseBatchInput('{"text":"a","expected":"block"}\n{"prompt":"b"}');
    expect(parsed.format).toBe('jsonl');
    expect(parsed.rows).toEqual([
      { line: 1, text: 'a', expected: 'block' },
      { line: 2, text: 'b', expected: undefined },
    ]);
  });

  it('keeps a bad JSONL line as an error instead of dropping it silently', () => {
    const parsed = parseBatchInput('{"text":"a"}\n{broken');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors).toEqual([{ line: 2, reason: 'not valid JSON' }]);
  });

  it('reads a CSV with a header', () => {
    const parsed = parseBatchInput('text,expected\n"hello, world",allow\nbad,block');
    expect(parsed.format).toBe('csv');
    expect(parsed.rows).toEqual([
      { line: 2, text: 'hello, world', expected: 'allow' },
      { line: 3, text: 'bad', expected: 'block' },
    ]);
  });

  it('falls back to the first column when the CSV has no header', () => {
    const parsed = parseBatchInput('one,x\ntwo,y');
    expect(parsed.format).toBe('csv');
    expect(parsed.rows.map((r) => r.text)).toEqual(['one', 'two']);
  });

  it('has nothing to run for empty input', () => {
    expect(parseBatchInput('  \n\n# only comments')).toEqual({
      format: 'plain',
      rows: [],
      errors: [],
    });
  });
});

describe('summarizeBatch', () => {
  it('counts blocked and would-have-blocked apart', () => {
    const summary = summarizeBatch([
      { row: { line: 1, text: 'a' }, verdict: verdict({ decision: 'block' }) },
      {
        row: { line: 2, text: 'b' },
        verdict: verdict({ decision: 'allow', would_be_decision: 'block', enforced: false }),
      },
      { row: { line: 3, text: 'c' }, verdict: verdict({ findings: [finding()] }) },
      { row: { line: 4, text: 'd' }, verdict: verdict() },
      { row: { line: 5, text: 'e' }, verdict: verdict({ disabled: true }) },
      { row: { line: 6, text: 'f' }, error: 'boom' },
    ]);
    expect(summary).toEqual({
      total: 6,
      blocked: 1,
      wouldBlock: 1,
      flagged: 1,
      clean: 1,
      notEvaluated: 1,
      failed: 1,
    });
  });

  it('has an all-zero shape for an empty run', () => {
    expect(summarizeBatch([])).toMatchObject({ total: 0, blocked: 0, failed: 0 });
  });
});
