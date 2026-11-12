import type { HookVerdict, SafetyAction } from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailDisposition } from '@cognipeer/agent-sdk';
import type { SdkCallbackOutcome, SdkRuleResult } from './types';

export function toCallbackOutcome(result: SdkRuleResult): SdkCallbackOutcome {
  return {
    allow: result.passed,
    reason: result.reason,
    disposition: result.disposition,
    details: result.details,
  };
}

/**
 * `SafetyAction` -> the SDK's three-value disposition, for the LEGACY plane
 * only. Lossy BY DESIGN, and the loss is in one direction: `redact` cannot be
 * delivered there (no mutation channel) and `flag`/`warn` have no separate rung,
 * so all three land on 'warn' — an incident that is recorded and surfaced but
 * does not halt the run. Only 'block' halts, and only 'allow' is discarded.
 *
 * The plugin plane does NOT go through this function: it rewrites instead. That
 * asymmetry is the whole point of the migration and is why `toDisposition` is
 * not reused there.
 */
export function toDisposition(action: SafetyAction): GuardrailDisposition {
  if (action === 'block') return 'block';
  if (action === 'allow') return 'allow';
  return 'warn'; // flag | warn | redact
}

// ═══════════════════════════════════════════════════════════════════════════
// Verdict -> rule result (LEGACY plane)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `verdict.decision` is ALREADY the effective decision — the engine neutralises
 * it to 'allow' whenever the guardrail is not in `enforce` mode — so this
 * function needs no `enforced` guard of its own and must not grow one.
 */
export function verdictToRuleResult(
  verdict: HookVerdict,
  observed?: { phase?: string; roles?: string[] },
): SdkRuleResult {
  // The ONE place the legacy plane's limits are attached to a verdict. `redact`
  // is the only one that is decision-dependent; the rest of what this plane
  // cannot do is per-hook and therefore already in `capabilities()`. On the
  // PLUGIN plane this limitation does not exist — the rewrite lands.
  const limitations = verdict.decision === 'redact' ? ['redact_unsupported'] : undefined;

  return {
    passed: verdict.decision !== 'block',
    // This string is what the SDK writes into the transcript as the guardrail's
    // assistant message (index.mjs:6187), i.e. it is USER-FACING. The rendered
    // block message is written for exactly that and is deliberately vague for
    // the families where a specific reason would teach evasion; a raw finding
    // message is the fallback only because a block with no explanation at all is
    // worse.
    reason: verdict.message?.body ?? verdict.findings[0]?.message,
    disposition: toDisposition(verdict.decision),
    // NEVER the raw findings. `details` lands in `state.messages[].metadata` and
    // in `state.guardrailResult`, both of which `captureSnapshot` persists — and
    // `SafetyFinding.value` holds the MATCHED STRING, which the evaluation
    // logger deliberately masks before it reaches storage. Categories and codes
    // are policy identifiers, not content, so they are safe to carry.
    details: {
      ...verdictDetails(verdict),
      // Which SDK phase fired and which message roles were in the scanned slice.
      // Without them an operator reading an incident cannot tell whether a
      // finding came from the user's question or from a tool result that arrived
      // three iterations later — and those call for different fixes.
      phase: observed?.phase,
      roles: observed?.roles,
      // What the console decided but this plane could not deliver. A verdict
      // that claims enforcement it did not perform is the one outcome the whole
      // hook plane exists to prevent, so the gap travels WITH the incident
      // rather than only into a log line.
      limitations,
    },
  };
}

/** The content-free part of a verdict, shared by both planes' incident payloads. */
export function verdictDetails(verdict: HookVerdict): Record<string, unknown> {
  return {
    hook: verdict.hook,
    decision: verdict.decision,
    wouldBeDecision: verdict.wouldBeDecision,
    enforced: verdict.enforced,
    mode: verdict.mode,
    riskScore: verdict.riskScore,
    traceId: verdict.traceId,
    codes: verdict.codes,
    categories: [...new Set(verdict.findings.map((finding) => finding.category).filter(Boolean))],
    guardrailKey: verdict.guardrailKey,
    policyVersion: verdict.policyVersion,
    degraded: verdict.degraded?.map((entry) => `${entry.family}:${entry.policyId}`),
  };
}
