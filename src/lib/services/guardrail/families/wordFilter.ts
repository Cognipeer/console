/**
 * `word_filter` family adapter — a thin shell around the existing
 * `../wordFilter#scanWordFilter` (the report-carrying form of `runWordFilter`).
 *
 * The matcher itself is NOT reimplemented here. It is the one detector whose
 * behaviour a fleet of tenants already depends on (leetspeak folding, Turkish
 * diacritic folding, stretched letters, spaced-out letters, built-in list
 * selection, phrase matching, tenant regexes), and the legacy-lift golden test
 * compares `evaluateGuardrail`'s findings against this hook's finding-for-
 * finding INCLUDING ORDER. Anything other than a pass-through would have to
 * reproduce that ordering by accident.
 *
 * ── WHY `replace_value` AND NEVER `replace_span` ─────────────────────────────
 * `word_filter` is deliberately absent from `SPAN_CAPABLE` in ./../hooks/contract.
 * `foldChars` NFKD-normalises and strips combining marks, so the folded string
 * has a DIFFERENT LENGTH from the raw one and an offset into it does not map
 * back; `buildCandidates` additionally joins runs of single-character tokens
 * ("f u c k"), so one match can cover a non-contiguous region of the source.
 * There is no honest span to emit, which is also why this family is not
 * stream-eligible: the hold-back window is sized by a bounded raw match length
 * that this matcher cannot state.
 *
 * ── WHY THE SCAN IS FLAT, AND THE MUTATIONS ARE PER-SEGMENT ──────────────────
 * Detection runs once over `subject.text` (the '\n'-joined segments), exactly
 * as `evaluateGuardrail` runs it over the request text, so phrase matching and
 * single-letter-run joining still see the whole document. Locating the match
 * afterwards is a separate step: for each finding we look up which segments
 * literally contain its `value` and emit one `replace_value` per containing
 * segment, so the rewrite is addressed to real places instead of being a
 * document-wide `split(value).join(...)`.
 *
 * Emitting one mutation per containing segment rather than only the first is
 * deliberate for THIS family: a banned token is banned wherever it occurs, so
 * every occurrence is genuinely the thing the policy is about. That is not true
 * of PII or secrets, where a matched value can legitimately reappear as part of
 * something the finding was never about.
 *
 * ── PURITY ──────────────────────────────────────────────────────────────────
 * This adapter never decides an action. `ctx.action` is the EFFECTIVE action the
 * engine already folded (`policy.action ?? record.action`); it is handed straight
 * to `runWordFilter` as the policy action so the legacy `action`/`block` fields
 * come out byte-identical, and the engine folds the resulting findings into the
 * verdict. In particular this file does NOT re-apply the legacy
 * `wordFilter.action ?? 'block'` default: that default belongs to the legacy
 * lift (hooks/legacy.ts writes it onto the lifted policy), and re-applying it
 * here would silently re-block a v2 config whose operator chose 'flag' at record
 * level and left the policy inheriting.
 */

import type { IGuardrailWordFilterPolicy } from '@/lib/database/provider/types.domain';
import {
  POLICY_VALID_HOOKS,
  LEGACY_FINDING_TYPE,
  isMutating,
  toLegacyAction,
} from '../hooks/contract';
import type {
  PolicyFamily,
  HookId,
  HookScope,
  HookSubject,
  Mutation,
  SafetyAction,
  SafetyFinding,
  SubjectSegment,
  WordFilterPolicyConfig,
} from '../hooks/contract';
import { scanWordFilter } from '../wordFilter';
import type { ResolvedWordList } from '../wordFilter';
import { resolveCustomWordLists } from '../wordListService';

const FAMILY: PolicyFamily = 'word_filter';

/**
 * What every family adapter is handed besides its own subject and policy.
 *
 * NOTE FOR THE ENGINE AUTHOR: `hooks/contract.ts` declares no family-adapter
 * signature (see the report accompanying this file), so this shape is declared
 * locally and exported. TypeScript is structural, so an identical declaration in
 * `hooks/contract.ts` or in a sibling family is assignable in both directions —
 * the field NAMES are the contract, and they are taken verbatim from
 * `HookVerdict` so that a family result concatenates into one without a mapping
 * step.
 */
export interface FamilyContext {
  hook: HookId;
  scope: HookScope;
  /**
   * `policy.action ?? record.action`, ALREADY resolved by the engine. Families
   * cannot see the record, so this cannot be derived here — and must not be
   * guessed at, because a guessed default is how a 'flag' guardrail starts
   * blocking.
   */
  action: SafetyAction;
}

export interface FamilyResult {
  findings: SafetyFinding[];
  mutations: Mutation[];
  /** Policies that could not fully run. The engine applies `policy.failMode`. */
  degraded?: Array<{ policyId: string; family: PolicyFamily; reason: string }>;
}

/** Segments whose text literally contains `value`, in document order. */
function segmentPathsContaining(
  segments: readonly SubjectSegment[],
  value: string,
): string[] {
  const paths: string[] = [];
  for (const segment of segments) {
    if (segment.text.includes(value)) paths.push(segment.path);
  }
  return paths;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runWordFilterPolicy(
  subject: HookSubject,
  policy: WordFilterPolicyConfig,
  ctx: FamilyContext,
): Promise<FamilyResult> {
  const empty: FamilyResult = { findings: [], mutations: [] };
  if (!policy.enabled) return empty;

  // The save-time validator and the engine's own dispatch both keep this family
  // off `output.stream.delta` and `tool.pre`. If a config gets past them anyway,
  // running the matcher would be UNSOUND on a stream (no bounded raw match
  // length, so the hold-back guarantee does not hold), and silently skipping is
  // the failure this codebase already refuses elsewhere: "a policy that is
  // enabled but cannot run must never be invisible" (guardrailService.ts:325).
  // Reporting it degraded lets `failMode` decide, which is the safe direction in
  // both settings — closed blocks, open flags.
  if (!POLICY_VALID_HOOKS[FAMILY].includes(ctx.hook)) {
    return {
      findings: [],
      mutations: [],
      degraded: [
        {
          policyId: policy.id,
          family: FAMILY,
          reason: `word_filter is not valid on hook "${ctx.hook}"`,
        },
      ],
    };
  }

  // Same short-circuit as runWordFilter's own, hoisted so an empty subject does
  // not cost a word-list round trip.
  if (!subject.text.trim()) return empty;

  const degraded: NonNullable<FamilyResult['degraded']> = [];

  // Tenant lists are resolved through the existing cached resolver (60s TTL,
  // concurrent misses, project → tenant fallback), so N referenced lists still
  // cost one round trip of latency. Unknown/deleted keys resolve to empty lists
  // by design there — that is NOT a degraded state, because a guardrail must not
  // stop working because a list was removed.
  let extraLists: ResolvedWordList[] | undefined;
  const listKeys = policy.customListKeys ?? [];
  if (listKeys.length > 0) {
    try {
      extraLists = await resolveCustomWordLists(
        ctx.scope.tenantDbName,
        ctx.scope.projectId,
        listKeys,
      );
    } catch (error) {
      // Partial evaluation beats none: the built-in lists, the inline words and
      // the tenant regexes are all still enforceable without the uploaded lists.
      // The degraded entry is what stops that partial run from being reported as
      // a clean pass.
      degraded.push({
        policyId: policy.id,
        family: FAMILY,
        reason: `custom word lists unavailable: ${describeError(error)}`,
      });
    }
  }

  // `action` is threaded through the policy rather than patched onto the
  // findings afterwards, so `action` and its derived `block` flag are produced by
  // exactly the same line as today (wordFilter.ts:209) and cannot drift out of
  // agreement. `customListKeys` is deliberately not copied: the matcher ignores
  // it — resolution is the caller's job, and the resolved words arrive as
  // `extraLists`.
  const legacyPolicy: IGuardrailWordFilterPolicy = {
    enabled: true,
    action: toLegacyAction(ctx.action),
    builtinLists: policy.builtinLists,
    words: policy.words,
    regexes: policy.regexes,
  };

  const findings: SafetyFinding[] = [];
  const mutations: Mutation[] = [];
  const mutating = isMutating(ctx.action);
  /** `path\0value` pairs already claimed, so a repeated value is not proposed
   *  twice for the same segment (applyMutations would report the second as
   *  `value_already_rewritten`, which is log noise, not information). */
  const claimed = new Set<string>();

  const scan = scanWordFilter(subject.text, legacyPolicy, extraLists);

  // A tenant regex that did not run — over the source cap, uncompilable, or cut
  // off by the per-policy scan budget — is a DEGRADED policy, never a silent
  // pass: the matcher used to `continue` past these, which is how a pattern
  // stays dead behind a green UI, and a budget cut on `tool.post` text is the
  // one signal an operator has that a pattern is being fed adversarial input.
  for (const skip of scan.skipped) {
    degraded.push({
      policyId: policy.id,
      family: FAMILY,
      reason: `regex #${skip.index + 1} (${skip.pattern}): ${skip.reason}`,
    });
  }

  for (const finding of scan.findings) {
    const paths = finding.value
      ? segmentPathsContaining(subject.segments, finding.value)
      : [];

    findings.push({
      ...finding,
      // Restated from the contract's table rather than trusted from the matcher:
      // the legacy `type` a family persists under is a compatibility decision
      // (it is what keeps the findings.type aggregations counting), so it is
      // owned by one map. Today it is already 'word_filter' on both sides.
      type: LEGACY_FINDING_TYPE[FAMILY],
      family: FAMILY,
      hook: ctx.hook,
      policyId: policy.id,
      // The matcher's two categories ('banned_word', 'custom_pattern') are
      // already stable machine tokens, so the code is the category rather than a
      // second vocabulary that could disagree with it.
      code: finding.category,
      // A phrase finding carries the LOWERCASED list entry as its value, which
      // usually appears nowhere in the raw text (matching happened on the folded
      // view), so it legitimately resolves to no place at all. Omitting `path`
      // says that honestly; a fabricated one would point at the wrong segment.
      ...(paths.length > 0 ? { path: paths[0] } : {}),
    });

    // Mutations are proposed ONLY when the effective action is 'redact'. A
    // Mutation carries no back-reference to the finding that produced it, so an
    // engine could not filter unwanted rewrites out afterwards even if it wanted
    // to — the family has to not emit them in the first place.
    if (!mutating || !finding.value) continue;
    for (const path of paths) {
      const dedupeKey = `${path}\u0000${finding.value}`;
      if (claimed.has(dedupeKey)) continue;
      claimed.add(dedupeKey);
      mutations.push({
        op: 'replace_value',
        path,
        value: finding.value,
        // Byte-identical to redactFindings (piiDetector.ts:218), so a lifted
        // guardrail's redacted output does not change spelling on upgrade.
        replacement: `[REDACTED:${finding.category}]`,
        family: FAMILY,
        policyId: policy.id,
        category: finding.category,
      });
    }
  }

  return {
    findings,
    mutations,
    degraded: degraded.length > 0 ? degraded : undefined,
  };
}
