/**
 * TWO policy families — `cognipeer_guardrail_moderation` and
 * `cognipeer_guardrail_prompt_shield` — both bundled, offline classifiers over
 * the SAME `@cognipeer/guardrail` npm package (a from-scratch character-level
 * CNN, 1.4 MB, ONNX Runtime, no network call at load or scan time — the model
 * ships INSIDE the package).
 *
 * WHY TWO FAMILIES SHARING ONE FILE AND ONE MODEL INSTANCE, RATHER THAN ONE
 * FAMILY OR A THIRD `detector` ON `moderation`/`prompt_shield`: see the note
 * on `GuardrailCognipeerGuardrailModerationPolicyConfig` (types.domain.ts) and
 * the "ELEVEN families" comment in `hooks/contract.ts`. Short version: an
 * operator wants to bind, enable and tune the content gate independently of
 * the injection gate — the same independence `moderation` and `prompt_shield`
 * already have from each other — but the underlying classifier answers both
 * gates from ONE inference, so `getInstance` below is shared between the two
 * exported run functions rather than duplicated.
 *
 * ONE finding PER TRIGGERED CATEGORY, same shape `runModerationPolicy` /
 * `runPromptShieldPolicy` (the LLM path) and `runLexiconModerationPolicy` /
 * `runPatternPromptShieldPolicy` (the no-model paths) already produce, so a
 * caller can treat all four interchangeably.
 *
 * PURITY WITH RESPECT TO POLICY: this family reports findings; it does not
 * decide the action, except for the same G1 escalation `families/llm.ts`
 * applies for the same reason — a whole-text verdict carries no span, so a
 * `redact` action has nothing to remove and is escalated to `block` rather
 * than silently passing flagged content through unredacted.
 */

import type { GuardrailScanResult } from '@cognipeer/guardrail';
import { createLogger } from '@/lib/core/logger';
import { LEGACY_FINDING_TYPE, toLegacyAction } from '../hooks/contract';
import type {
  CognipeerGuardrailModerationPolicyConfig,
  CognipeerGuardrailPromptShieldPolicyConfig,
  HookId,
  HookScope,
  HookSubject,
  Mutation,
  PolicyFamily,
  SafetyAction,
  SafetyFinding,
} from '../hooks/contract';
import type { CognipeerGuardrailCategoryDefinition } from '../types';
import {
  COGNIPEER_GUARDRAIL_MODERATION_CATEGORIES,
  COGNIPEER_GUARDRAIL_PROMPT_SHIELD_CATEGORIES,
  buildEvaluationErrorFinding,
} from '../types';

const logger = createLogger('guardrail-family-cognipeer-guardrail');

/**
 * The shape every family adapter conforms to. DUPLICATED IN EVERY `families/*`
 * MODULE ON PURPOSE — see `families/secrets.ts`'s identical declaration for
 * why: `hooks/contract.ts` describes the call/verdict boundary, not the
 * per-policy one, and TypeScript's structural typing makes every copy
 * interchangeable. Generic over the two sibling config shapes, which differ
 * only in `family` and in which half of the model's categories they may hold.
 */
export interface FamilyRunInput<
  C extends CognipeerGuardrailModerationPolicyConfig | CognipeerGuardrailPromptShieldPolicyConfig,
> {
  policy: C;
  subject: HookSubject;
  hook: HookId;
  scope: HookScope;
  action: SafetyAction;
}

export interface FamilyRunResult {
  findings: SafetyFinding[];
  mutations: Mutation[];
  degraded?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
}

/** Distinguishes these detectors' findings from the LLM judges' and the
 *  lexicon/pattern paths' in logs and alert rules — all can fire on the same
 *  conceptual violation, and knowing which one did is real information. */
const VIOLATION_CODE: Readonly<Record<'moderation' | 'prompt_shield', string>> = {
  moderation: 'cognipeer_guardrail_moderation_flagged',
  prompt_shield: 'cognipeer_guardrail_prompt_shield_flagged',
};

/**
 * Bounds worst-case latency on a hot path these families share with every
 * other deterministic policy: the package's own `scan()` windows the WHOLE
 * input with no cap by default, so an unbounded message multiplies inference
 * calls (50%-overlap windows over the model's ~320-character max length,
 * doubled by its skeleton tower). NOT yet empirically tuned against this
 * model the way `DEFAULT_REGEX_BUDGET_MS` was for the regex sweep — a
 * conservative starting cap, not a measured one. `Guardrail.load`'s own
 * `maxScanChars` reports truncation on the result rather than hiding it,
 * which is why this is a cap and not a silent slice.
 */
const MAX_SCAN_CHARS = 8_000;

type Profile = CognipeerGuardrailModerationPolicyConfig['profile'];

/**
 * One classifier instance per THRESHOLD PROFILE, not a single shared one:
 * `Guardrail.load` bakes the profile's thresholds into the instance, and a
 * tenant may run these at different profiles (e.g. `strict` moderation next
 * to a `sensitive` prompt shield, or the same family twice at different
 * hooks). SHARED BETWEEN BOTH FAMILIES: whichever asks first for a given
 * profile loads it, and the other reuses the same instance and the same
 * `scan()` result shape — the classifier always scores all nine categories
 * regardless of which family is reading them out. Module-level and never
 * cleared — same lifetime as the process, same reasoning as
 * `services/pii/ner.ts`'s own model cache.
 */
const instances = new Map<string, ReturnType<typeof loadInstance>>();

function loadInstance(profile: Profile) {
  return import('@cognipeer/guardrail').then(({ Guardrail }) =>
    Guardrail.load({ profile, maxScanChars: MAX_SCAN_CHARS }),
  );
}

/** Exported for the families' own unit tests only, so a test can force a
 *  fresh load rather than reusing whatever a prior test cached. */
export function _resetCognipeerGuardrailCache(): void {
  instances.clear();
}

function getInstance(profile: Profile) {
  let cached = instances.get(profile);
  if (!cached) {
    cached = loadInstance(profile);
    instances.set(profile, cached);
  }
  return cached;
}

/** Same threshold-relative bucketing `runModerationClassifier`
 *  (llmEvaluator.ts) already uses for a real classifier's probability, applied
 *  to `risk` (already 0.5-centred on the decision boundary) rather than the
 *  raw sigmoid score. */
function severityFor(risk: number): SafetyFinding['severity'] {
  return risk >= 0.85 ? 'high' : risk >= 0.5 ? 'medium' : 'low';
}

/**
 * THE SHARED CORE both exported functions call, parameterised by which half
 * of the model's categories a given family may read. Not exported: each
 * family's own thin wrapper below is the public, dispatch-facing surface, so
 * that `hooks/engine.ts` has one call shape per family like every sibling.
 */
async function runGate(
  gate: 'moderation' | 'prompt_shield',
  allowed: readonly CognipeerGuardrailCategoryDefinition[],
  family: PolicyFamily,
  input: FamilyRunInput<CognipeerGuardrailModerationPolicyConfig | CognipeerGuardrailPromptShieldPolicyConfig>,
): Promise<FamilyRunResult> {
  // `scope` is unused by these families, same as `secrets` and `regex`: they
  // are pure, given a threshold profile and a string. Present on
  // `FamilyRunInput` so all adapters take one argument of one shape.
  const { policy, subject, hook } = input;
  const empty: FamilyRunResult = { findings: [], mutations: [] };
  if (!policy.enabled) return empty;

  const text = subject.text;
  if (!text.trim()) return empty;

  const categoryById = new Map(allowed.map((c) => [c.id, c]));
  const enabledCategories = Object.entries(policy.categories || {})
    .filter(([, on]) => on)
    .map(([id]) => id)
    .filter((id) => categoryById.has(id));
  if (enabledCategories.length === 0) return empty;

  // Idempotent, like `secrets.ts`'s own re-application: a no-op once the
  // engine has already resolved `policy.action ?? record.action`, and still
  // correct if a caller ever hands this family the record's action directly.
  const effective: SafetyAction = policy.action ?? input.action;
  const profile = policy.profile ?? 'strict';

  const failWith = (detail: string): FamilyRunResult => {
    const failMode = policy.failMode;
    const message = failMode === 'closed'
      ? `${family} could not run and this policy is configured to fail closed: ${detail}`
      : `${family} could not run (fail-open — content passed unchecked): ${detail}`;
    return {
      findings: [
        {
          ...buildEvaluationErrorFinding({
            type: LEGACY_FINDING_TYPE[family],
            failMode,
            action: toLegacyAction(effective),
            message,
          }),
          family,
          hook,
          policyId: policy.id,
          code: 'evaluation_error',
        },
      ],
      mutations: [],
      degraded: [{ policyId: policy.id, family, reason: message }],
    };
  };

  let guardrail: Awaited<ReturnType<typeof getInstance>>;
  try {
    guardrail = await getInstance(profile);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`${family} model failed to load`, { policyId: policy.id, hook, profile, error: detail });
    // The LOAD itself failed (missing/corrupt model files, a bad
    // onnxruntime-node native binding on this platform) — clear the cached
    // rejected promise so the NEXT request (from either family) retries
    // rather than replaying the same rejection forever, e.g. a transient
    // disk/permissions issue.
    instances.delete(profile);
    return failWith(`model failed to load: ${detail}`);
  }

  let scan: GuardrailScanResult;
  try {
    scan = await guardrail.scan(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`${family} classifier threw while scoring`, { policyId: policy.id, hook, profile, error: detail });
    // The model loaded fine; THIS input crashed one inference call. Leave the
    // cached instance alone — reloading it would not fix a bad input, and
    // would force every other in-flight request on this profile (from EITHER
    // family) to pay for a reload it does not need.
    return failWith(`classifier threw while scoring: ${detail}`);
  }

  const findings: SafetyFinding[] = [];
  for (const categoryId of enabledCategories) {
    const risk = scan.risk[categoryId];
    if (risk === undefined || risk < 0.5) continue; // not triggered

    const category = categoryById.get(categoryId);
    if (!category) continue; // unreachable: filtered against categoryById above

    // The G1 fix `families/llm.ts` applies for the same reason: a whole-text
    // verdict has nothing for a rewrite to remove, so `redact` is escalated to
    // `block` rather than the finding silently passing flagged content
    // through untouched.
    const action = effective === 'redact' ? 'block' : toLegacyAction(effective);

    findings.push({
      type: gate,
      category: categoryId,
      severity: severityFor(risk),
      message: `${category.label} detected (risk ${risk.toFixed(3)}, profile "${profile}")`,
      action,
      block: action === 'block',
      family,
      hook,
      policyId: policy.id,
      code: VIOLATION_CODE[gate],
    });
  }

  return { findings, mutations: [] };
}

export function runCognipeerGuardrailModerationPolicy(
  input: FamilyRunInput<CognipeerGuardrailModerationPolicyConfig>,
): Promise<FamilyRunResult> {
  return runGate('moderation', COGNIPEER_GUARDRAIL_MODERATION_CATEGORIES, 'cognipeer_guardrail_moderation', input);
}

export function runCognipeerGuardrailPromptShieldPolicy(
  input: FamilyRunInput<CognipeerGuardrailPromptShieldPolicyConfig>,
): Promise<FamilyRunResult> {
  return runGate(
    'prompt_shield',
    COGNIPEER_GUARDRAIL_PROMPT_SHIELD_CATEGORIES,
    'cognipeer_guardrail_prompt_shield',
    input,
  );
}
