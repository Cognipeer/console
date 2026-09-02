/**
 * The `pii` policy family — the hook plane's adapter onto the standalone PII
 * service (`@/lib/services/pii`).
 *
 * WHY AN ADAPTER RATHER THAN A DETECTOR: the PII service already owns the
 * category catalog, the checksum validators (Luhn, IBAN mod-97, TCKN), the
 * per-category mask strategies, the language filter and the tenant's custom
 * patterns. Re-implementing any of that here is exactly how two detection
 * engines drift apart, which is why `GuardrailPiiPolicyConfig` carries a
 * `piiPolicyKey` and no inline category list. This file only translates:
 * `HookSubject` in, `scanWithPolicy` findings out, `SafetyFinding` +
 * `Mutation` back.
 *
 * ── THE TWO PASSES, AND WHY THE MUTATION MODEL HAS TWO KINDS ──────────────
 *
 * 1. THE POLICY PASS runs `scanWithPolicy` over the subject's own text. Its
 *    findings carry `start`/`end` offsets INTO THAT TEXT, so they become
 *    `replace_span` mutations: they address a PLACE, and a rewrite hits that
 *    place and nothing else.
 *
 * 2. THE OBFUSCATION PASS exists because the PII service performs NO text
 *    normalisation of its own — that logic lives only in `../piiDetector`
 *    (`normalizeText` = NFKC + zero-width strip, `deobfuscateEmails` =
 *    "user (at) mail (dot) com" -> "user@mail.com"). Without it the migration
 *    off the legacy detector would silently lose obfuscation resistance for
 *    the whole fleet. But that pass scans a DIFFERENT STRING: NFKC can change
 *    a character's width in code units, the zero-width strip deletes
 *    characters outright, and the email rewrite collapses runs of them. Its
 *    offsets therefore do not map back onto the original text — a span
 *    computed there would redact the wrong bytes. So its findings are
 *    span-less and emit `replace_value`, which is resolved by SEARCHING the
 *    segment for the literal value instead of by offset.
 *
 * This asymmetry is the entire reason `Mutation` has both ops, and it is
 * stated as a contract in `SPAN_CAPABLE` (contract.ts): pii-by-policy is
 * span-capable, pii-by-obfuscation is not.
 *
 * A CONSEQUENCE WORTH STATING PLAINLY: an obfuscated value usually cannot be
 * redacted at all, because the string the detector matched ("user@mail.com")
 * is not the string in the document ("user (at) mail (dot) com"). The proposed
 * `replace_value` then lands in `applyMutations`' `skipped` list with a
 * reason, which is the audit trail the contract asks for — a redaction that
 * did not happen is recorded rather than a verdict claiming one that did. This
 * is NOT a regression: the legacy `redactFindings` (piiDetector.ts:212-221)
 * had the identical limitation, since it also `split()`s on the normalised
 * value. Obfuscation detection is there to BLOCK, not to rewrite.
 *
 * ── PURITY WITH RESPECT TO POLICY ─────────────────────────────────────────
 *
 * This family decides nothing. It is TOLD the effective enforcement action
 * (`FamilyRunInput.action`, already resolved by the engine as
 * `policy.action ?? record.action`), stamps it onto every finding it emits, and
 * lets the engine fold the verdict. In particular it ignores the PII policy's
 * own `defaultAction: 'block'`: `PiiFinding.block` is the PII service's
 * standalone-API semantics, and letting it reach a `SafetyFinding` would let a
 * policy shared by three guardrails silently override all three.
 */

import { runWithTenantScope } from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import type { PiiAction } from '@/lib/database/provider/types.domain';
import { scanWithPolicy } from '../../pii/piiService';
// The stateless twin of `scanWithPolicy`, used ONLY by the legacy fallback
// below. It is the same detector the policy path ends up calling; what it
// skips is the policy READ, which is precisely the step that can fail on a row
// whose lifted policy was never provisioned.
import {
  detect as detectPiiSpans,
  withCustomPatternBudget,
  type CustomPatternSkip,
} from '../../pii/detector';
import type { PiiFinding } from '../../pii/types';
// Both are re-exported from piiDetector.ts specifically for this pass; that
// file remains the single home of the normalisation rules so the legacy
// detector and this adapter can never disagree about what counts as evasion.
import { deobfuscateEmails, normalizeText } from '../piiDetector';
import {
  LEGACY_FINDING_TYPE,
  isBlocking,
  isMutating,
  joinSegments,
  toLegacyAction,
  type PolicyFamily,
  type GuardrailPolicy,
  type HookId,
  type HookScope,
  type HookSubject,
  type Mutation,
  type PiiPolicyConfig,
  type SafetyAction,
  type SafetyFinding,
} from '../hooks/contract';

const FAMILY: PolicyFamily = 'pii';

const logger = createLogger('guardrail:pii');

/**
 * Machine codes on the emitted findings. Append-only, and deliberately
 * distinct per pass: an operator reading the evaluation log can tell a value
 * that was written in the clear from one that was hidden behind zero-width
 * characters or a spelled-out `(at)`, which is a materially different signal
 * about the sender.
 */
export const PII_CODE_DETECTED = 'pii_detected';
export const PII_CODE_OBFUSCATED = 'pii_obfuscated';

// ── The shape every family adapter conforms to ─────────────────────────────
// NOTE: `hooks/contract.ts` does not declare this shape (it describes the
// call/verdict boundary, not the per-policy one), so it is declared here and
// kept deliberately minimal and structural — TypeScript's structural typing
// makes an identically-shaped declaration in a sibling family interchangeable
// with this one. It belongs in a shared `families/types.ts` the moment one
// exists; see the report accompanying this file.

export interface FamilyRunInput<C extends GuardrailPolicy = GuardrailPolicy> {
  policy: C;
  subject: HookSubject;
  hook: HookId;
  scope: HookScope;
  /**
   * The EFFECTIVE enforcement action for this policy, already resolved by the
   * engine (`policy.action ?? record.action`). Families never derive it: a
   * family that read the record would need the record, and a family that
   * defaulted it would disagree with the engine's fold the first time the two
   * defaults drifted.
   */
  action: SafetyAction;
}

/** A policy that could not run. `failMode` is applied by the ENGINE, not here. */
export interface FamilyDegradation {
  policyId: string;
  family: PolicyFamily;
  reason: string;
}

export interface FamilyRunResult {
  findings: SafetyFinding[];
  /**
   * PROPOSED edits. Emitted only when the effective action is mutating: there
   * is no third state between "proposed" and "will be applied" in
   * `HookVerdict.mutations`, so a policy acting at `flag` must not contribute
   * edits the engine would then apply. (Deciding *whether* to produce edits
   * from an action it was handed is not the same as deciding the action.)
   */
  mutations: Mutation[];
  degraded?: FamilyDegradation[];
}

// ── Scan units: segments plus their offsets in the flattened text ──────────

/**
 * One scannable string with the absolute offset at which it appears in the
 * text handed to the detector. `path` is absent only for the degenerate case
 * below, and a unit without a path can carry findings but never mutations —
 * `applyMutations` resolves a mutation by matching its `path` against a
 * segment, so an invented pointer would be silently skipped anyway.
 */
interface ScanUnit {
  path?: string;
  text: string;
  start: number;
}

function buildScanUnits(subject: HookSubject): { units: ScanUnit[]; text: string } {
  if (subject.segments.length > 0) {
    const units: ScanUnit[] = [];
    let cursor = 0;
    for (const segment of subject.segments) {
      units.push({ path: segment.path, text: segment.text, start: cursor });
      // +1 for the '\n' that `joinSegments` puts between segments. The offset
      // table and the scanned string MUST be derived from the same join, which
      // is why the text below comes from `joinSegments` rather than from
      // `subject.text`: a builder is free to set `text` independently, and a
      // one-character disagreement shifts every span in the subject.
      cursor += segment.text.length + 1;
    }
    return { units, text: joinSegments(subject.segments) };
  }

  // Degenerate: a hand-built subject with text but no segments. Scanning it
  // still reports (and can still block), it just cannot be rewritten. Losing
  // the detection entirely would be the worse of the two failures.
  if (subject.text.length > 0) {
    return { units: [{ text: subject.text, start: 0 }], text: subject.text };
  }
  return { units: [], text: '' };
}

/**
 * The unit a `[start, end)` match belongs to, or undefined when the match
 * straddles a segment boundary.
 *
 * A straddling match exists ONLY in the flattened view: the '\n' separator is
 * not part of any segment, so the matched string is not present in the
 * document, cannot be written back, and is almost always two unrelated fields
 * glued together (the `phone` and `address` patterns contain `\s`, which
 * matches the separator; the `\S`-based patterns cannot cross it at all). Such
 * matches are dropped rather than reported as unactionable findings that can
 * block a request. Subjects with a single segment — every `text` and
 * `stream_delta` hook — cannot reach this case.
 */
function locateUnit(units: readonly ScanUnit[], start: number, end: number): ScanUnit | undefined {
  let lo = 0;
  let hi = units.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid].start <= start) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return undefined;
  const unit = units[found];
  return end <= unit.start + unit.text.length ? unit : undefined;
}

// ── Action resolution ──────────────────────────────────────────────────────

/**
 * The `PiiAction` handed to the PII service, which controls only ONE thing we
 * consume: the `replacement` string computed for each finding (a
 * `[REDACTED_EMAIL]` tag under 'redact', the category's own mask strategy —
 * `j***@gmail.com` — otherwise).
 *
 * An action is ALWAYS passed, never left to the policy's `defaultAction`, so
 * this policy's behaviour is a function of the guardrail's configuration alone:
 *   · a policy defaulting to 'block' would otherwise stamp `block: true` onto
 *     findings, letting a policy shared by three guardrails override all three;
 *   · a policy defaulting to 'tokenize' would otherwise mint a vault that this
 *     layer has nowhere to keep, so the tokens would reach the model and
 *     nothing would ever detokenize the answer. 'tokenize' is therefore
 *     downgraded to 'redact' — an unreversible `[EMAIL_1]` is a redaction with
 *     a confusing label, and the honest spelling is the tag.
 * 'block' and 'detect' as overrides are enforcement words rather than
 * rendering ones; both fall through to the effective-action branch.
 */
function resolveScanAction(policy: PiiPolicyConfig, action: SafetyAction): PiiAction {
  const override = policy.actionOverride;
  if (override === 'mask' || override === 'redact') return override;
  if (override === 'tokenize') return 'redact';
  return isMutating(action) ? 'redact' : 'detect';
}

// ── Finding construction ───────────────────────────────────────────────────

/**
 * `category` is the PII SERVICE's id (`tc_kimlik`), not the legacy detector's
 * (`tckn`). It is the truth about which pattern matched, and mapping back
 * through `LEGACY_PII_CATEGORY_MAP` would be lossy in one direction anyway:
 * `tr_phone`, `tr_iban`, `de_phone` and every tenant custom pattern have no
 * legacy counterpart and would have to fall through as service ids regardless,
 * producing a category column with two spellings in it.
 *
 * `type` stays `'pii'` (via LEGACY_FINDING_TYPE) so the AI App Gateway's
 * PII-dimension filter and both providers' `findingsByType` aggregations keep
 * counting.
 */
function toSafetyFinding(params: {
  finding: PiiFinding;
  policyId: string;
  hook: HookId;
  action: SafetyAction;
  code: string;
  unit: ScanUnit | undefined;
  span?: { start: number; end: number };
}): SafetyFinding {
  const { finding, unit } = params;
  return {
    type: LEGACY_FINDING_TYPE.pii,
    category: finding.category,
    severity: finding.severity,
    // The obfuscation pass reuses the service's own message verbatim rather
    // than announcing "obfuscated ... detected": findings[0].message is
    // persisted and rendered to end users on some paths, and telling a sender
    // which of their evasions was noticed teaches the next one. The `code`
    // carries that distinction to the operator instead.
    message: finding.message,
    action: toLegacyAction(params.action),
    block: isBlocking(params.action),
    value: finding.value,
    family: FAMILY,
    hook: params.hook,
    policyId: params.policyId,
    code: params.code,
    path: unit?.path,
    span: params.span,
  };
}

/**
 * De-duplication key for the obfuscation pass, scoped to the SEGMENT. The same
 * value found in two different segments is two findings with two separate
 * rewrites, so the path has to be part of the key; the same value found twice
 * inside one segment is one `replace_value` (which rewrites every occurrence
 * in that segment), so it must not be.
 */
function dedupeKey(path: string | undefined, category: string, value: string): string {
  return `${path ?? ''}\u0000${category}\u0000${value}`;
}

// ── The adapter ────────────────────────────────────────────────────────────

export async function runPiiPolicy(input: FamilyRunInput<PiiPolicyConfig>): Promise<FamilyRunResult> {
  const { policy, subject, hook, scope, action } = input;

  const findings: SafetyFinding[] = [];
  const mutations: Mutation[] = [];
  const degraded: FamilyDegradation[] = [];
  const mutate = isMutating(action);

  const piiPolicyKey = policy.piiPolicyKey?.trim();
  if (!piiPolicyKey) {
    // `validateGuardrailHooks` rejects this at save time, so reaching it means
    // a hand-edited or externally-written row. Scanning with the service's
    // defaults instead would be the worst outcome available: a guardrail whose
    // UI shows a configured PII policy while it silently enforces a category set
    // nobody chose. Reported as a policy that could not run, and the ENGINE
    // applies `failMode` to it.
    degraded.push({
      policyId: policy.id,
      family: FAMILY,
      reason:
        `PII policy "${policy.id}" is enabled but has no piiPolicyKey. A PII policy ` +
        'scans through a stored PII policy; it has no inline category list to ' +
        'fall back on.',
    });
    return { findings, mutations, degraded };
  }

  const { units, text } = buildScanUnits(subject);
  // Nothing to scan: skip the policy round trip entirely. This hides an
  // unresolvable policy for empty subjects only, where the policy is vacuously
  // satisfied — there is no content a missing policy could have failed to see.
  if (text.length === 0) return { findings, mutations };

  const scanAction = resolveScanAction(policy, action);
  const seen = new Set<string>();

  /**
   * Both passes go through this rather than calling `scanWithPolicy` directly,
   * so the stateless fallback below re-runs IDENTICAL logic over a different
   * source of patterns. Duplicating the two passes for the fallback would let
   * them drift, and the fallback is the path that runs when something is
   * already wrong — the worst possible place for a second implementation.
   */
  type PiiScanFn = (value: string) => Promise<{ findings: PiiFinding[] }>;

  const policyScan: PiiScanFn = (value) =>
    scanWithPolicy({
      tenantDbName: scope.tenantDbName,
      // `policyKey` is the PII SERVICE's parameter name, not ours.
      policyKey: piiPolicyKey,
      projectId: scope.projectId,
      text: value,
      actionOverride: scanAction,
      locale: policy.locale,
    });

  // Present only on a lifted legacy row (see `legacyCategories` on the config).
  const legacyCategories =
    policy.legacyCategories && Object.keys(policy.legacyCategories).length > 0
      ? policy.legacyCategories
      : undefined;

  /**
   * The DB-free twin of `policyScan`. `scanWithPolicy` is exactly
   * `detect(text, config, action)` plus a policy read and, for `'block'`, a
   * pass that stamps `block: true`; reproducing those two steps here is what
   * lets a legacy guardrail keep detecting when its lifted policy row is
   * missing. `'tokenize'` is unreachable: it has no legacy action that maps to
   * it, so no lifted policy can ask for it.
   */
  const statelessScan: PiiScanFn | undefined = legacyCategories
    ? async (value) => {
        const found = detectPiiSpans(
          value,
          { categories: legacyCategories, locale: policy.locale },
          scanAction,
        );
        return {
          findings: scanAction === 'block' ? found.map((f) => ({ ...f, block: true })) : found,
        };
      }
    : undefined;

  const runPasses = async (scanText: PiiScanFn): Promise<void> => {
      // ── Pass 1: the policy scan, over the flattened subject text ────────
      // One round trip for the whole subject rather than one per segment: the
      // spans it returns are absolute into `text`, and the offset table built
      // alongside `units` maps each of them back to the segment that owns it.
      const scan = await scanText(text);

      for (const finding of scan.findings) {
        const unit = locateUnit(units, finding.start, finding.end);
        if (!unit) continue; // straddles a segment boundary — see locateUnit
        const span = { start: finding.start - unit.start, end: finding.end - unit.start };
        findings.push(
          toSafetyFinding({
            finding,
            policyId: policy.id,
            hook,
            action,
            code: PII_CODE_DETECTED,
            unit,
            span,
          }),
        );
        seen.add(dedupeKey(unit.path, finding.category, finding.value));
        if (mutate && unit.path) {
          mutations.push({
            op: 'replace_span',
            path: unit.path,
            start: span.start,
            end: span.end,
            replacement: finding.replacement,
            family: FAMILY,
            policyId: policy.id,
            category: finding.category,
          });
        }
      }

      // ── Pass 2: the obfuscation scan, per segment ───────────────────────
      // Default TRUE (contract: `detectObfuscated?: boolean` — "Default
      // true"). Turning it OFF is what makes `policyMaxMatchChars` return a
      // real bound and therefore what makes a PII policy bindable to
      // `output.stream.delta`.
      if (policy.detectObfuscated === false) return;

      // Per segment, unlike pass 1, and for a reason rather than by accident:
      // these findings have no usable offsets, so the only thing that can tell
      // us WHICH segment to rewrite is the segment we scanned. The cost is one
      // extra round trip per segment, paid only when that segment's normalised
      // view actually differs — i.e. only when the text contains fullwidth
      // characters, zero-width characters or a spelled-out `(at)`/`(dot)`.
      for (const unit of units) {
        if (scope.signal?.aborted) {
          degraded.push({
            policyId: policy.id,
            family: FAMILY,
            reason: 'Obfuscation pass did not complete: the hook budget expired.',
          });
          return;
        }
        if (unit.text.length === 0) continue;
        // `deobfuscateEmails` is applied unconditionally, where the legacy
        // detector gated it on the `email` category being enabled. That gate
        // cost nothing there because the legacy loop already had the category
        // list in hand; here it would cost a second read of the policy purely
        // to decide whether to collapse "(at)". The rewrite only touches
        // bracketed/spelled-out `at`/`dot` forms, so on text with no such
        // construct it is the identity and the whole pass is skipped below.
        const normalized = deobfuscateEmails(normalizeText(unit.text));
        if (normalized === unit.text) continue;

        const evasion = await scanText(normalized);

        for (const finding of evasion.findings) {
          const key = dedupeKey(unit.path, finding.category, finding.value);
          if (seen.has(key)) continue; // already reported verbatim by pass 1
          seen.add(key);
          // No `span`: the offsets are into `normalized`, a string of a
          // different length that exists nowhere but this loop.
          findings.push(
            toSafetyFinding({
              finding,
              policyId: policy.id,
              hook,
              action,
              code: PII_CODE_OBFUSCATED,
              unit,
            }),
          );
          if (mutate && unit.path) {
            // Proposed even though it will usually NOT land: the value the
            // detector matched is the de-obfuscated one, and the document
            // holds the obfuscated spelling. `applyMutations` records it in
            // `skipped` with a reason, which is a better audit trail than
            // quietly proposing nothing — the log then shows the redaction
            // that could not be performed instead of implying there was none
            // to perform.
            mutations.push({
              op: 'replace_value',
              path: unit.path,
              value: finding.value,
              replacement: finding.replacement,
              family: FAMILY,
              policyId: policy.id,
              category: finding.category,
            });
          }
        }
      }
  };

  /**
   * A tenant custom pattern the detector could not run to completion — over
   * the source cap, uncompilable, or cut off by the per-policy scan budget —
   * degrades THIS policy. `failMode` then decides; the alternative is a
   * pattern that silently stopped guarding. Deduplicated by reason: the same
   * pattern fails the same way on every segment of a tool result.
   */
  const reportSkips = (skipped: readonly CustomPatternSkip[]): void => {
    const seenReasons = new Set<string>();
    for (const entry of skipped) {
      const reason = `custom pattern "${entry.patternId}" (${entry.categoryId}): ${entry.reason}`;
      if (seenReasons.has(reason)) continue;
      seenReasons.add(reason);
      degraded.push({ policyId: policy.id, family: FAMILY, reason });
    }
  };

  try {
    // scanWithPolicy self-scopes with `switchToTenant`, which is `enterWith`
    // under the hood. Running it inside the canonical `.run()`-based wrapper
    // confines that binding to this call, so the adapter is safe to invoke
    // from a frame the console's request ALS does not own (the red-team
    // runner, a preview, a test) and cannot leave another tenant's handle
    // behind if it is.
    //
    // `withCustomPatternBudget` is the outer wrapper so BOTH passes — the
    // whole-subject scan and the per-segment obfuscation scans — spend one
    // custom-pattern budget between them.
    const { skipped } = await withCustomPatternBudget(() =>
      runWithTenantScope(scope.tenantDbName, () => runPasses(policyScan)),
    );
    reportSkips(skipped);
  } catch (error) {
    // The policy is missing, disabled-and-deleted, or the tenant DB is
    // unreachable. `scanWithPolicy` throws on a missing key, and a lifted
    // legacy policy deliberately points at a deterministic key that may not
    // have been provisioned yet — so this is a live path, not a can't-happen.
    const reason = error instanceof Error ? error.message : String(error);

    if (statelessScan) {
      // A lifted legacy row. Its category list travelled with the policy for
      // exactly this moment: re-run both passes with no database at all rather
      // than report a policy that could not run. Provisioning the policy is a
      // WRITE, and a write failure on a guardrail the operator never touched
      // must not turn its PII enforcement off.
      //
      // Everything pass 1 collected is discarded first. Those findings came
      // from a scan that threw partway, so keeping them would mix a partial
      // policy scan with a complete stateless one and double-report whatever
      // both saw — `seen` is keyed per value, but the mutation list is not.
      findings.length = 0;
      mutations.length = 0;
      seen.clear();
      try {
        // The stateless scan has no custom patterns (a lifted policy carries
        // categories only), so this reports nothing today; wrapped anyway so
        // the two paths stay the same shape.
        const { skipped } = await withCustomPatternBudget(() => runPasses(statelessScan));
        reportSkips(skipped);
        logger.warn('PII policy unavailable; scanned with the lifted legacy categories', {
          policyId: policy.id,
          piiPolicyKey,
          reason,
        });
        return degraded.length > 0 ? { findings, mutations, degraded } : { findings, mutations };
      } catch (fallbackError) {
        degraded.push({
          policyId: policy.id,
          family: FAMILY,
          reason:
            `PII policy "${piiPolicyKey}" could not be scanned (${reason}) and the ` +
            `legacy-category fallback also failed: ${
              fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
            }`,
        });
        return { findings, mutations, degraded };
      }
    }

    // An authored config: there is no inline category list to fall back on, by
    // design. Findings already collected are kept — a partial scan that found
    // something real must not lose it because a later pass failed.
    degraded.push({
      policyId: policy.id,
      family: FAMILY,
      reason: `PII policy "${piiPolicyKey}" could not be scanned: ${reason}`,
    });
  }

  return degraded.length > 0 ? { findings, mutations, degraded } : { findings, mutations };
}
