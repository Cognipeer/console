/**
 * The three LLM policy families — `moderation`, `prompt_shield` and `custom` —
 * as hook-plane adapters over the existing evaluators in `../llmEvaluator`.
 *
 * The prompts, the untrusted-content wrapping and the JSON parsing are NOT
 * re-implemented here: `runModerationPolicy` / `runPromptShieldPolicy` /
 * `runCustomPromptPolicy` are the tuned, hardened article and stay the single
 * source of truth for what an evaluator asks a model. This file adds only what
 * a policy-level plane needs and the legacy evaluator has no place for:
 *
 *   1. `runIf` GATING — the cost lever. An LLM judge on every request is what
 *      makes guardrails too expensive to leave on; `onFinding` /
 *      `onSideEffect` run it only when a cheap deterministic pass already saw
 *      something. This generalises the enforcement plane's `judge.onlyHighRisk`
 *      (aegis/engine.ts:253-254), which gated on exactly two signals.
 *   2. A REAL TIMEOUT, per policy. Today the only budget in the fleet is a
 *      hardcoded `GUARDRAIL_TIMEOUT_MS = 4_000` inside the AI App Gateway
 *      (aiAppGateway/policy/engine.ts:45), applied by racing the WHOLE
 *      guardrail — deterministic passes included — because there was no way to
 *      ask for just the fast part. A per-policy budget plus `only` retires it.
 *   3. PER-POLICY `failMode`. The record-level one fails the whole guardrail
 *      closed when one flaky moderation model hiccups, taking the deterministic
 *      PII pass down with it.
 *   4. The G1 FIX — see `stampFinding`. An LLM finding whose resolved action is
 *      `redact` neither blocks nor redacts today, so flagged hate speech passes
 *      through untouched. It is escalated to `block`.
 *
 * PURITY WITH RESPECT TO POLICY: this family reports findings; it does not
 * decide the action. The engine resolves the record's action and hands it in
 * as `ctx.action` (a per-policy `policy.action` still wins); the finding is
 * stamped with it and the engine folds. The one thing decided here is the
 * redact escalation, which is not a policy choice but a CAPABILITY fact only
 * the family knows: there is nothing for a rewrite to remove when a judge
 * condemns a whole message.
 *
 * MUTATIONS: always empty. A whole-text verdict carries no span and no value
 * (see SPAN_CAPABLE in ../hooks/contract), so there is nothing to propose.
 */

import type { GuardrailAction } from '@/lib/database/provider/types.domain';
import { createLogger } from '@/lib/core/logger';
import { LEGACY_FINDING_TYPE, toLegacyAction } from '../hooks/contract';
import type {
  PolicyFamily,
  CustomPolicyConfig,
  GuardrailPolicy,
  GuardrailFailMode,
  HookId,
  HookScope,
  HookSubject,
  ModerationPolicyConfig,
  Mutation,
  PromptShieldPolicyConfig,
  SafetyAction,
  SafetyFinding,
  SideEffect,
} from '../hooks/contract';
import type { GuardrailFinding } from '../types';
import { buildEvaluationErrorFinding } from '../types';
import {
  runCustomPromptPolicy,
  runModerationPolicy,
  runPromptShieldPolicy,
} from '../llmEvaluator';

const logger = createLogger('guardrail-family-llm');

// ── Shared family shape ───────────────────────────────────────────────────

/** The three configs this file handles. */
export type LlmPolicyConfig = ModerationPolicyConfig | PromptShieldPolicyConfig | CustomPolicyConfig;
export type LlmPolicyFamily = LlmPolicyConfig['family'];

/**
 * The uniform shape every policy family is dispatched through:
 * `run<Family>Policy(subject, policy, ctx)`.
 *
 * DUPLICATED IN EVERY `families/*` MODULE ON PURPOSE, for now — the same note
 * `secrets.ts` carries. `hooks/contract` declares the subject, the finding and
 * the mutation but no runner type, and nothing may be added to it from here.
 * The interfaces are structural, so this copy and the sibling copies are the
 * same type; when a shared one lands in the contract, delete them all.
 *
 * `action` is the EFFECTIVE action the engine already resolved for this policy.
 * Families stamp it because `GuardrailFinding.action` is required — they never
 * choose it. The engine folds the decision.
 */
export interface FamilyRunContext {
  hook: HookId;
  action: SafetyAction;
}

/** What a family hands back. `findings` and `mutations` merge into the verdict
 *  as-is; the other two are audit surfaces the engine logs. */
export interface FamilyRunResult {
  findings: SafetyFinding[];
  mutations: Mutation[];
  /** Could not run; `failMode` has already been applied to `findings`. */
  degraded?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
  /**
   * Deliberately not run — a `runIf` gate that was not met. Additive over the
   * sibling families' result type, and separate from `degraded` because a gate
   * is a policy decision working as configured: folding it into the degraded
   * list would paint every correctly-tuned guardrail as unhealthy. It is
   * reported rather than dropped so that "the judge never runs" is
   * diagnosable instead of invisible.
   */
  gated?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
}

/**
 * WHEN this policy is allowed to spend a model call.
 *
 * DERIVED from the persisted field rather than restated, so the two cannot
 * drift: `GuardrailPolicyBase.runIf` (provider/types.domain.ts) is the
 * declaration, and this is the same union with `undefined` resolved away.
 * Absent means `'always'`, which is exactly what every lifted legacy policy
 * needs, because `evaluateGuardrail` has always run its LLM policies
 * unconditionally.
 */
export type GuardrailPolicyRunIf = NonNullable<GuardrailPolicy['runIf']>;

/**
 * The extra context an LLM family needs and a deterministic one does not: a
 * tenant scope to resolve the model in, the record-level fallbacks, and the
 * two runtime facts the `runIf` gate reads.
 *
 * It EXTENDS the uniform context rather than replacing it, so the engine can
 * build ONE object and pass it to every family — `runSecretsPolicy` simply
 * ignores the fields it has no use for.
 */
export interface LlmFamilyRunContext extends FamilyRunContext {
  scope: HookScope;
  /** Record-level fallback; `policy.failMode` wins when both are set. */
  failMode?: GuardrailFailMode;
  /** Record-level `modelKey`; the policy's own wins. Mirrors llmEvaluator's
   *  `policy.modelKey || ctx.modelKey` precedence exactly. */
  modelKey?: string;
  /**
   * Findings the DETERMINISTIC families already produced on this hook call —
   * the input to the `onFinding` gate. The engine runs those families first
   * (the normative execution order), so by the time an LLM family is
   * dispatched this list is complete.
   */
  priorFindings?: readonly SafetyFinding[];
  /**
   * The tool's classified side effect, for the `onSideEffect` gate.
   *
   * `undefined` MUST mean "this tool is not classified", not "no side effect":
   * an unknown tool is itself the risk signal the enforcement plane gated on
   * (`!shield.rules.sideEffects?.[name]`, aegis/engine.ts:253). A caller that
   * substitutes `tool_access.defaultSideEffect` here erases that signal and
   * turns the judge off for exactly the calls it was kept on for.
   */
  sideEffect?: SideEffect;
  /**
   * Wall-clock REMAINING for sync policies, from `HookScope.budgetMs` minus what
   * the deterministic pass already spent.
   *
   * Note the deliberate asymmetry with `policy.timeoutMs`, where 0 or absent
   * means NO timeout (the legacy contract — `liftLegacyBindings` writes
   * `timeoutMs: 0` so no tenant's slow-but-passing moderation model starts
   * failing on upgrade). Here, absent means unbounded but `<= 0` means the
   * budget is already spent and the policy does not start. Two conventions for
   * the same number would be a trap, so they live on two differently named
   * fields.
   */
  budgetMs?: number;
}


// ── runIf gating ──────────────────────────────────────────────────────────

/**
 * Side effects that count as "high risk" for the `onSideEffect` gate. Exactly
 * the two the enforcement plane raised a `side_effect_*` finding for
 * (aegis/engine.ts:132) — `read` and `write` did not wake the judge there and
 * do not here, so the gate's cost profile is the one operators already have.
 */
const HIGH_RISK_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set<SideEffect>([
  'destructive',
  'external',
]);

/**
 * Absent field, unrecognised value and explicit `'always'` all mean "run".
 *
 * The field is declared now, so this reads it by name rather than through a
 * cast — which is the whole point of declaring it: a rename becomes a compile
 * error instead of every gated policy silently reverting to `'always'`. The
 * value is still WIDENED to `unknown` before the comparison, because a stored
 * blob is not a type: a hand-edited row or one written by a newer build can
 * carry anything, and coercing it to "run" is the fail-safe reading — the same
 * reasoning that types the evaluation log's `hook` / `decision` columns as
 * plain strings.
 */
export function resolveRunIf(policy: LlmPolicyConfig): GuardrailPolicyRunIf {
  const raw: unknown = policy.runIf;
  return raw === 'onFinding' || raw === 'onSideEffect' ? raw : 'always';
}

type GateOutcome = { run: true } | { run: false; reason: string };

function evaluateRunIf(
  subject: HookSubject,
  policy: LlmPolicyConfig,
  ctx: LlmFamilyRunContext,
): GateOutcome {
  const runIf = resolveRunIf(policy);
  if (runIf === 'always') return { run: true };

  if (runIf === 'onFinding') {
    // An `evaluation_error` finding counts. It means a cheap deterministic
    // policy could NOT run, so the content is currently unchecked — the one
    // moment where the expensive pass is most worth its money. Outages are
    // rare, so this costs nothing in the steady state.
    const found = (ctx.priorFindings ?? []).length > 0;
    return found
      ? { run: true }
      : { run: false, reason: 'runIf=onFinding and no deterministic policy flagged anything' };
  }

  // onSideEffect
  if (subject.kind !== 'tool_call' && subject.kind !== 'tool_result') {
    // There is no tool here, so the condition can never be met. Reported
    // instead of quietly returning nothing: a policy configured this way and
    // bound to `input.pre` would otherwise be a guardrail that shows green in
    // the UI and has never once evaluated anything. The save-time validator
    // should refuse the combination outright — see the report accompanying
    // this file.
    return {
      run: false,
      reason: `runIf=onSideEffect but hook ${ctx.hook} carries no tool call`,
    };
  }
  if (ctx.sideEffect === undefined) {
    // Unclassified tool — the "unknown is suspicious" branch of the rule this
    // generalises. Runs the judge.
    return { run: true };
  }
  if (HIGH_RISK_SIDE_EFFECTS.has(ctx.sideEffect)) return { run: true };
  if ((ctx.priorFindings ?? []).some((f) => f.code?.startsWith('side_effect'))) {
    return { run: true };
  }
  return {
    run: false,
    reason: `runIf=onSideEffect and ${subject.toolName} is classified '${ctx.sideEffect}'`,
  };
}

// ── Budget ────────────────────────────────────────────────────────────────

/**
 * The effective wall-clock budget, or `undefined` for unbounded.
 *
 * Both bounds apply and the tighter one wins: a policy may not outlive the
 * hook's remaining window, and a hook's window does not license a policy to
 * exceed its own configured timeout.
 */
export function resolveBudgetMs(
  policy: LlmPolicyConfig,
  ctx: Pick<LlmFamilyRunContext, 'budgetMs'>,
): number | undefined {
  const bounds: number[] = [];
  const configured = policy.timeoutMs;
  // 0 / absent = no timeout, per GuardrailPolicyBase — today's behaviour.
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    bounds.push(configured);
  }
  if (typeof ctx.budgetMs === 'number' && Number.isFinite(ctx.budgetMs)) {
    // A non-positive remaining budget is meaningful (already spent) and must
    // survive the min(), so it is pushed rather than filtered.
    bounds.push(ctx.budgetMs);
  }
  return bounds.length > 0 ? Math.min(...bounds) : undefined;
}

type BudgetOutcome<T> = { timedOut: true } | { timedOut: false; value: T };

/**
 * Races `work` against `budgetMs`.
 *
 * The loser is NOT cancelled: `chatModel.invoke` takes no signal, so the call
 * keeps running to completion in the background and its result is discarded.
 * That is the honest description of what the gateway's `Promise.race` has been
 * doing for a year — the timeout bounds the REQUEST, not the model call — and
 * pretending otherwise would need an abort path through langchain that does
 * not exist. The timer is always cleared, because an outstanding one holds the
 * event loop open for the rest of the budget after a fast answer.
 */
async function withBudget<T>(work: Promise<T>, budgetMs: number | undefined): Promise<BudgetOutcome<T>> {
  if (budgetMs === undefined) return { timedOut: false, value: await work };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<BudgetOutcome<T>>([
      work.then((value) => ({ timedOut: false as const, value })),
      new Promise<BudgetOutcome<T>>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── Findings ──────────────────────────────────────────────────────────────

/**
 * Stamps a legacy `GuardrailFinding` into a `SafetyFinding` — and applies the
 * G1 fix.
 *
 * G1: `runModerationPolicy` & co. stamp `action: globalAction` and
 * `block: globalAction === 'block'`, and never set `value`. With a guardrail
 * configured `action: 'redact'` that produces a finding which does not block
 * (`block: false`) and cannot be redacted either, because
 * `evaluateGuardrail`'s redaction step filters on `f.value`
 * (guardrailService.ts:365) and there is no value to mask. Flagged hate speech
 * is reported and then delivered verbatim.
 *
 * The fix is escalation, not downgrade: a judge condemning a whole message is
 * saying the message is the problem, so there is no substring a rewrite could
 * remove. An operator who wants an LLM family to be advisory has `'warn'` and
 * `'flag'` — both of which survive this untouched — and can now set them
 * per-policy, which is precisely why `GuardrailPolicyBase.action` exists.
 *
 * `block` is re-derived rather than carried, so the two fields cannot disagree
 * after the escalation.
 */
function stampFinding(
  finding: GuardrailFinding,
  ctx: { family: LlmPolicyFamily; hook: HookId; policyId: string; code: string },
): SafetyFinding {
  const action: GuardrailAction = finding.action === 'redact' ? 'block' : finding.action;
  return {
    ...finding,
    action,
    block: action === 'block',
    family: ctx.family,
    hook: ctx.hook,
    policyId: ctx.policyId,
    // An evaluation error keeps its own code whatever the family is: the
    // dashboards and alert rules that count outages key on it.
    code: finding.category === 'evaluation_error' ? 'evaluation_error' : ctx.code,
  };
}

/** The machine code a violation from each family carries. Coarse on purpose:
 *  the specific category rides on `finding.category`, and `codes` is a value
 *  that reaches response headers and block-message templates, where naming the
 *  exact injection technique that was caught would teach an attacker what to
 *  vary next. Append-only. */
const VIOLATION_CODE: Readonly<Record<LlmPolicyFamily, string>> = {
  moderation: 'moderation_flagged',
  prompt_shield: 'prompt_shield_flagged',
  custom: 'custom_rule_failed',
};

/** The names the legacy evaluator logs under (llmEvaluator.ts:227/320/381), so
 *  a grep for "Moderation policy" still finds every occurrence. */
const LABEL: Readonly<Record<LlmPolicyFamily, string>> = {
  moderation: 'Moderation policy',
  prompt_shield: 'Prompt shield policy',
  custom: 'Custom prompt policy',
};

/** Mirrors `failModeFindings`' wording (llmEvaluator.ts:147-151) so an outage
 *  reads the same whether the evaluator noticed it or this adapter did. */
function errorMessage(
  family: LlmPolicyFamily,
  failMode: GuardrailFailMode | undefined,
  detail: string,
): string {
  return failMode === 'closed'
    ? `${LABEL[family]} could not run and this policy is configured to fail closed: ${detail}`
    : `${LABEL[family]} could not run (fail-open — content passed unchecked): ${detail}`;
}

/**
 * The "this policy could not run" finding, built by the same helper the legacy
 * evaluator uses so fail-open still emits a visible non-blocking flag and
 * fail-closed still produces a real violation. Exported because the engine
 * needs the identical finding for its missing-model pre-pass (see
 * `llmPolicyModelKey`).
 */
export function buildLlmErrorFinding(params: {
  family: LlmPolicyFamily;
  hook: HookId;
  policyId: string;
  action: SafetyAction;
  failMode: GuardrailFailMode | undefined;
  message: string;
}): SafetyFinding {
  return stampFinding(
    buildEvaluationErrorFinding({
      type: LEGACY_FINDING_TYPE[params.family],
      failMode: params.failMode,
      action: toLegacyAction(params.action),
      message: params.message,
    }),
    {
      family: params.family,
      hook: params.hook,
      policyId: params.policyId,
      code: 'evaluation_error',
    },
  );
}

// ── Model resolution ──────────────────────────────────────────────────────

/**
 * `policy.modelKey || record.modelKey`, verbatim from llmEvaluator.ts:204/299
 * and guardrailService.ts:337/345.
 *
 * Exported because the ENGINE must resolve it too: the normative execution
 * order puts every "enabled but no evaluation model" finding BEFORE any LLM
 * result (guardrailService.ts:326-340), which a family running inside
 * `Promise.all` cannot do for itself — its result lands in family order, not
 * ahead of the batch. The engine calls this in its pre-pass and skips
 * dispatching the policy when it returns undefined. `runLlmPolicy` handles the
 * same case anyway, so a caller that dispatches regardless gets the finding
 * rather than a silent pass; the two cannot double-emit, because the engine's
 * contract is to skip dispatch once it has emitted.
 */
export function llmPolicyModelKey(policy: LlmPolicyConfig, recordModelKey?: string): string | undefined {
  return policy.modelKey || recordModelKey || undefined;
}

/** The message text guardrailService.ts:330-334 produces, kept word for word:
 *  it is what today's evaluation logs and test panel already show. */
export function missingModelMessage(failMode: GuardrailFailMode | undefined): string {
  return failMode === 'closed'
    ? 'Policy is enabled but no evaluation model is configured; guardrail fails closed.'
    : 'Policy is enabled but no evaluation model is configured (fail-open — content passed unchecked).';
}

// ── Entry point ───────────────────────────────────────────────────────────

/**
 * Runs one moderation / prompt-shield / custom policy.
 *
 * NEVER THROWS. A family that throws takes the whole hook down, so every
 * failure path — a rejecting evaluator, an expired budget, a missing model —
 * comes back as a `failMode`-shaped finding plus a `degraded` entry.
 */
export async function runLlmPolicy(
  subject: HookSubject,
  policy: LlmPolicyConfig,
  ctx: LlmFamilyRunContext,
): Promise<FamilyRunResult> {
  const { hook, scope } = ctx;
  const family = policy.family;
  const policyId = policy.id;
  const failMode = policy.failMode ?? ctx.failMode;
  // Idempotent, and identical to `runSecretsPolicy`: when the engine has
  // already resolved the effective action this is a no-op, and when a caller
  // passes the record's action it still honours the per-policy override.
  const action: SafetyAction = policy.action ?? ctx.action;

  const empty = (): FamilyRunResult => ({ findings: [], mutations: [] });
  const degrade = (reason: string, findings: SafetyFinding[] = []): FamilyRunResult => ({
    findings,
    mutations: [],
    degraded: [{ policyId, family, reason }],
  });
  const failure = (reason: string, message: string): FamilyRunResult =>
    degrade(reason, [
      buildLlmErrorFinding({ family, hook, policyId, action, failMode, message }),
    ]);

  // The engine filters, but a family must never run a policy it was handed
  // disabled — the red-team runner and the test panel dispatch directly.
  if (!policy.enabled) return empty();

  // Same guard as every underlying evaluator (llmEvaluator.ts:201/296/371):
  // whitespace has nothing to judge and a model call for it is pure cost.
  if (!subject.text.trim()) return empty();

  // Hard refusal on the streaming hook. LLM families are excluded from
  // STREAM_ELIGIBLE_FAMILIES because a judge call per hold-back window
  // multiplies latency and model spend by the number of windows; a config that
  // reached here would be a runaway bill. Deliberately the ONLY hook
  // restriction enforced by this family: every other one is POLICY_VALID_HOOKS,
  // which the engine and the save-time validator now share, so a second
  // opinion here could only disagree with both.
  if (hook === 'output.stream.delta') {
    return degrade('LLM families never run per stream window; they run post-hoc on output.pre');
  }

  const gate = evaluateRunIf(subject, policy, ctx);
  if (!gate.run) {
    return { findings: [], mutations: [], gated: [{ policyId, family, reason: gate.reason }] };
  }

  const modelKey = llmPolicyModelKey(policy, ctx.modelKey);
  if (!modelKey) {
    // Preserved quirk, and the reason `onMissingModel` exists: a legacy custom
    // guardrail with no model evaluates nothing and passes
    // (guardrailService.ts:358), so lifted policies carry 'skip' and only
    // newly-authored ones fail visibly. The skip is still recorded — the whole
    // point of the flag is that the quirk is named rather than hidden.
    if (family === 'custom' && policy.onMissingModel === 'skip') {
      return degrade('no evaluation model configured; policy declares onMissingModel=skip');
    }
    return failure('no evaluation model configured', missingModelMessage(failMode));
  }

  // Authoring holes that make the underlying evaluator a silent no-op
  // (llmEvaluator.ts:211 returns [] for zero categories, :371 for an empty
  // prompt). No model call is made in either case today either, so this
  // changes no cost and no verdict — it only stops the policy from reading as
  // "passed" when it never ran. The save-time validator rejects both.
  if (family === 'moderation' && !Object.values(policy.categories ?? {}).some(Boolean)) {
    return degrade('moderation policy has no enabled category');
  }
  if (family === 'custom' && !policy.prompt?.trim()) {
    return degrade('custom policy has no prompt');
  }

  if (scope.signal?.aborted) {
    // Treated exactly like an expired budget rather than as a silent skip. The
    // caller is usually gone, but `aborted` is not a signal an attacker can
    // raise, and a fail-closed guardrail that quietly passes content whenever
    // an abort races the policy would be a hole worth finding.
    return failure('request aborted before the policy started', errorMessage(family, failMode, 'the request was aborted'));
  }

  const budgetMs = resolveBudgetMs(policy, ctx);
  if (budgetMs !== undefined && budgetMs <= 0) {
    return failure(
      'hook budget exhausted before the policy started',
      errorMessage(family, failMode, 'the guardrail budget was already spent'),
    );
  }

  const startedAt = Date.now();
  let raw: GuardrailFinding[];
  try {
    const outcome = await withBudget(dispatch(subject, policy, action, modelKey, failMode, scope), budgetMs);
    if (outcome.timedOut) {
      logger.warn(`${LABEL[family]} exceeded its budget`, {
        policyId,
        family,
        hook,
        modelKey,
        budgetMs,
        failMode,
      });
      return failure(
        `timed out after ${budgetMs}ms`,
        errorMessage(family, failMode, `it did not answer within ${budgetMs}ms`),
      );
    }
    raw = outcome.value;
  } catch (error) {
    // The evaluators catch their own failures, so reaching here means
    // something upstream of them broke (a rejected model build, a provider
    // credential that will not decrypt). Same treatment, so no failure mode is
    // load-bearing on which layer noticed.
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`${LABEL[family]} threw`, { policyId, family, hook, modelKey, error: detail });
    return failure('evaluator threw', errorMessage(family, failMode, detail));
  }

  const findings = raw.map((finding) =>
    stampFinding(finding, { family, hook, policyId, code: VIOLATION_CODE[family] }),
  );

  logger.debug(`${LABEL[family]} completed`, {
    policyId,
    hook,
    modelKey,
    latencyMs: Date.now() - startedAt,
    findings: findings.length,
  });

  return { findings, mutations: [] };
}

/**
 * Hands the policy's config to the existing evaluator in the legacy policy
 * shape it expects. The synthesized policies are built fresh per call and
 * never handed back, so nothing here can alias a cached guardrail record.
 *
 * The subject's flattened `text` is what gets judged, which is what lets a
 * moderation policy bound to `tool.post` work with no changes: the segments a
 * tool result was walked into join into one string.
 *
 * The engine is expected to hand this family a subject the DETERMINISTIC
 * families' redactions have already been applied to, so PII and credentials
 * the tenant configured a guardrail to strip are not then shipped to a
 * third-party judge model. That was explicit in the enforcement plane it
 * replaces (aegis/engine.ts:255-258) and is invisible from here.
 */
function dispatch(
  subject: HookSubject,
  policy: LlmPolicyConfig,
  effectiveAction: SafetyAction,
  modelKey: string,
  failMode: GuardrailFailMode | undefined,
  scope: HookScope,
): Promise<GuardrailFinding[]> {
  const ctx = {
    tenantDbName: scope.tenantDbName,
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    modelKey,
    failMode,
  };
  // The evaluators stamp this onto every finding they produce; `stampFinding`
  // then applies the redact escalation over the top. Passing the escalated
  // action in instead would hide the fix inside the legacy evaluator, where
  // the next reader would have no way to see that it happened.
  const action = toLegacyAction(effectiveAction);
  const text = subject.text;

  switch (policy.family) {
    case 'moderation':
      return runModerationPolicy(
        text,
        { enabled: true, modelKey, categories: policy.categories ?? {} },
        ctx,
        action,
      );
    case 'prompt_shield':
      return runPromptShieldPolicy(
        text,
        { enabled: true, modelKey, sensitivity: policy.sensitivity ?? 'balanced' },
        ctx,
        action,
      );
    case 'custom':
      return runCustomPromptPolicy(text, policy.prompt, ctx, action);
  }
}
