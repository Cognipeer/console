/**
 * The `secrets` policy family — deterministic credential detection.
 *
 * PURITY IS A REQUIREMENT, NOT A STYLE CHOICE. `scanSecrets` is synchronous,
 * allocates nothing outside its own result and touches neither the database nor
 * the tenant ALS, because the AI App Gateway calls the credential scan directly
 * on its hot path — today it does so by importing `runPiiDetection` and handing
 * it `{ enabled: true, action: 'flag', categories: { apiKey: true } }`, which is
 * that gateway's entire secrets story. Anything that needed a tenant scope here
 * would either break that caller or force it to fabricate one.
 *
 * The patterns below are MOVED from `piiDetector.ts`, where they rode inside the
 * PII detector and fired only when the `apiKey` category happened to be enabled.
 * They keep two things from that home, deliberately:
 *
 *   · `type: 'pii'` on every finding (via LEGACY_FINDING_TYPE), so the gateway's
 *     `if (finding.type !== 'pii') continue` filter and both providers'
 *     `findings.type` aggregations keep seeing credentials.
 *   · `category: 'apiKey'`, so the redaction label stays `[REDACTED:apiKey]`,
 *     the dashboards keep bucketing the same way, and the gateway's dedup —
 *     one row per (category, segment) — still collapses forty keys in one file
 *     into one actionable finding. The credential CLASS is not lost: it is in
 *     the finding's `message`, and `code` separates the two detectors whose
 *     false-positive profiles differ.
 *
 * What this family adds over the old home is a real SPAN per match. The legacy
 * detector returned bare strings and redaction was `text.split(value).join(...)`,
 * which rewrote every occurrence of a matched value anywhere in the document —
 * including inside unrelated findings — and could not express two matches that
 * overlap. `secrets` is in SPAN_CAPABLE, so every match here proposes a
 * `replace_span` addressed at the place it was found.
 */

import { isMutating, LEGACY_FINDING_TYPE, toLegacyAction } from '../hooks/contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  HookId,
  HookScope,
  HookSubject,
  Mutation,
  SafetyAction,
  SafetyFinding,
  SecretsPolicyConfig,
} from '../hooks/contract';

// ── The pure scanner ────────────────────────────────────────────────────────

export interface SecretPattern {
  /** Stable id, surfaced on `SecretMatch.patternId`. Append-only. */
  id: string;
  /** Rendered as `<label> detected` in the finding message. */
  label: string;
  /** Must carry the `g` flag: the scanner iterates it. */
  pattern: RegExp;
}

/**
 * Well-known credential shapes, verbatim from `piiDetector.ts`. They fire
 * regardless of length and BYPASS the entropy floor, which is the whole point:
 * a short-but-unmistakable token (`AKIA…`, `xoxb-…`) has low character variety
 * and would never clear an entropy bar, yet there is no such thing as a false
 * positive on an AWS access key id.
 *
 * Order is the tie-break rank when two patterns claim the same offsets, so it
 * runs specific-before-general.
 */
export const KNOWN_SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    id: 'vendor_prefixed_key',
    label: 'API key',
    // Stripe / OpenAI / Anthropic-style `sk-`, `pk_`, `rk_` prefixes.
    pattern: /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}\b/g,
  },
  { id: 'aws_access_key_id', label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'github_token', label: 'GitHub token', pattern: /\bgh[oprsu]?p?_[A-Za-z0-9]{30,}\b/g },
  { id: 'slack_token', label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'console_api_token', label: 'Cognipeer API token', pattern: /\bcpeer_[A-Za-z0-9_-]{16,}\b/g },
  // AI App Gateway per-user credential: `cpgw_` + 32 random bytes as hex
  // (console-ee aiAppGateway/credentials.ts). It spends the organisation's
  // upstream credit, so a developer pasting it into a prompt is a real leak.
  { id: 'gateway_credential', label: 'Cognipeer gateway credential', pattern: /\bcpgw_[0-9a-f]{64}\b/g },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  },
  {
    id: 'private_key_block',
    label: 'PEM private key',
    /**
     * The HEADER only, exactly as before. Widening this to the whole armoured
     * block would put an unbounded string into `SecretMatch.value` and blow the
     * 512-character bound `policyMaxMatchChars` states for this family — the
     * number that sizes the streaming hold-back window. KNOWN LIMITATION: a
     * `redact` action therefore removes the BEGIN line and leaves the key body
     * behind. A PEM key should be blocked, not redacted.
     */
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
];

/** The generic long-token heuristic. Alone it fires on UUIDs, base64 blobs and
 *  content hashes, which is why it is gated behind the entropy floor below. */
export const GENERIC_TOKEN_PATTERN = /\b[A-Za-z0-9-_]{32,}\b/g;

export const GENERIC_SECRET_PATTERN_ID = 'generic_high_entropy';

/** TODAY'S value, and the reason it is a constant rather than a literal: the
 *  floor is configurable per policy, but changing the DEFAULT re-classifies
 *  every long token in the fleet at once. */
export const DEFAULT_SECRET_MIN_ENTROPY = 3.5;

/** Also today's value. Subsumed by the 32-character generic pattern, kept so
 *  the exported predicate behaves identically for callers that reach for it
 *  directly (the PII detector's `validateApiKey` does). */
export const DEFAULT_SECRET_MIN_LENGTH = 20;

export interface SecretMatch {
  /** Absolute offsets into the scanned string; `end` is exclusive. */
  start: number;
  end: number;
  value: string;
  /** `SecretPattern.id`, or GENERIC_SECRET_PATTERN_ID for the heuristic. */
  patternId: string;
  label: string;
  /** True for the entropy heuristic — the detector with false positives. */
  generic: boolean;
}

export interface ScanSecretsOptions {
  /** The named vendor patterns. Default true. */
  known?: boolean;
  /** The 32-character heuristic. Default true. */
  genericHighEntropy?: boolean;
  /** Shannon-entropy floor for the heuristic only. Default 3.5. */
  minEntropy?: number;
  /** Exact literals to ignore: documentation samples, test fixtures. */
  allowValues?: readonly string[];
}

/** Shannon entropy in bits per character over the value's own alphabet. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const frequency: Record<string, number> = {};
  for (const character of value) frequency[character] = (frequency[character] ?? 0) + 1;
  let entropy = 0;
  for (const count of Object.values(frequency)) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The floor the generic heuristic has always used: real secrets are
 * high-entropy, while repeated words, slugs and low-variety hex are mostly
 * false positives. Known-prefix matches bypass this entirely.
 */
export function hasSecretEntropy(value: string, minEntropy = DEFAULT_SECRET_MIN_ENTROPY): boolean {
  if (value.length < DEFAULT_SECRET_MIN_LENGTH) return false;
  return shannonEntropy(value) >= minEntropy;
}

/**
 * True when the value is a known credential shape on its own. This is the
 * anchored test the PII detector's `validateApiKey` performs by hand today; it
 * lives here so there is one definition of "known secret" rather than two that
 * drift the first time a pattern is added.
 */
export function isKnownSecret(value: string): boolean {
  for (const definition of KNOWN_SECRET_PATTERNS) {
    if (new RegExp(`^(?:${definition.pattern.source})$`).test(value)) return true;
  }
  return false;
}

interface Candidate extends SecretMatch {
  /** Declaration order; the last tie-break so the result is deterministic. */
  rank: number;
}

/**
 * The module-level patterns carry `g` and therefore carry `lastIndex`. Resetting
 * before each sweep is sufficient because every scan here is synchronous and
 * cannot interleave with another: there is no await between the reset and the
 * final `exec`. Cloning the RegExp per call (what the PII detector does) would
 * recompile fifteen patterns on every stream window for no benefit.
 */
function collect(
  pattern: RegExp,
  text: string,
  onMatch: (value: string, start: number) => void,
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[0];
    // A zero-length match never advances `lastIndex`, so without this the loop
    // never terminates. None of the patterns above can match empty, but the
    // export is public and a future pattern might.
    if (value.length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    onMatch(value, match.index);
  }
}

/**
 * Greedy left-to-right sweep keeping non-overlapping matches.
 *
 * Overlap is the normal case, not the exception: `ghp_AAAA…` is claimed by both
 * the GitHub pattern and the generic heuristic, and emitting both would double
 * every finding and every mutation for it. The order — specific detector first,
 * then longer span, then declaration order — means the credential keeps its
 * real label while the redaction still covers the widest claimed region.
 */
function resolveOverlaps(candidates: Candidate[]): SecretMatch[] {
  candidates.sort(
    (a, b) =>
      a.start - b.start ||
      Number(a.generic) - Number(b.generic) ||
      b.end - b.start - (a.end - a.start) ||
      a.rank - b.rank,
  );

  const kept: SecretMatch[] = [];
  let frontier = -1;
  for (const candidate of candidates) {
    if (candidate.start < frontier) continue;
    kept.push({
      start: candidate.start,
      end: candidate.end,
      value: candidate.value,
      patternId: candidate.patternId,
      label: candidate.label,
      generic: candidate.generic,
    });
    frontier = candidate.end;
  }
  return kept;
}

/**
 * Scan one string for credentials. Pure, synchronous, DB-free.
 *
 * Behaviour is byte-for-byte the legacy detector's for the same input: known
 * patterns always fire, the generic pattern fires only above the entropy floor.
 * The only difference is the shape of the answer — offsets instead of bare
 * strings, which is what lets a redaction hit the place the secret was found
 * rather than every occurrence of that text in the document.
 */
export function scanSecrets(text: string, options: ScanSecretsOptions = {}): SecretMatch[] {
  if (!text) return [];

  const scanKnown = options.known !== false;
  const scanGeneric = options.genericHighEntropy !== false;
  const minEntropy = options.minEntropy ?? DEFAULT_SECRET_MIN_ENTROPY;
  const allowed =
    options.allowValues && options.allowValues.length > 0
      ? new Set(options.allowValues)
      : undefined;

  const candidates: Candidate[] = [];

  if (scanKnown) {
    KNOWN_SECRET_PATTERNS.forEach((definition, rank) => {
      collect(definition.pattern, text, (value, start) => {
        if (allowed?.has(value)) return;
        candidates.push({
          start,
          end: start + value.length,
          value,
          patternId: definition.id,
          label: definition.label,
          generic: false,
          rank,
        });
      });
    });
  }

  if (scanGeneric) {
    collect(GENERIC_TOKEN_PATTERN, text, (value, start) => {
      if (allowed?.has(value)) return;
      if (!hasSecretEntropy(value, minEntropy)) return;
      candidates.push({
        start,
        end: start + value.length,
        value,
        patternId: GENERIC_SECRET_PATTERN_ID,
        label: 'High-entropy token',
        generic: true,
        rank: KNOWN_SECRET_PATTERNS.length,
      });
    });
  }

  return resolveOverlaps(candidates);
}

// ── The family adapter ──────────────────────────────────────────────────────

/**
 * The shape every family adapter conforms to. DECLARED HERE AND IN EVERY OTHER
 * `families/*` MODULE, identically and on purpose: `hooks/contract.ts` is the
 * leaf of the hook plane and describes the call/verdict boundary, not the
 * per-policy one, and nothing may be added to it from here. TypeScript's
 * structural typing makes these interchangeable with the sibling declarations;
 * they all collapse into a shared `families/types.ts` the moment one exists.
 *
 * `action` is the EFFECTIVE action the engine already resolved for this policy
 * (`policy.action ?? record.action`). Families stamp it onto their findings
 * because `GuardrailFinding.action` is a required field — they never choose it,
 * and they never look at the record. The engine folds the decision.
 *
 * `scope` is unused by this family and by `regex`: both are pure, and that is
 * the property the AI App Gateway depends on. It is present so all seven
 * adapters take one argument of one shape.
 */
export interface FamilyRunInput<C extends GuardrailPolicy = GuardrailPolicy> {
  policy: C;
  subject: HookSubject;
  hook: HookId;
  scope: HookScope;
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
  mutations: Mutation[];
  degraded?: FamilyDegradation[];
}

/**
 * The legacy spelling of this family's category, and the label a redaction
 * carries. Not `secrets`: changing it would re-bucket every dashboard, change
 * the redacted text an existing test asserts on, and break the gateway's
 * per-category dedup. The credential class lives in the message instead.
 */
export const SECRET_FINDING_CATEGORY = 'apiKey';

const SECRET_REDACTION = `[REDACTED:${SECRET_FINDING_CATEGORY}]`;

/** Machine codes. Two, not fifteen: they separate the detector that has no
 *  false positives from the one that does, which is the distinction an alert
 *  rule actually wants. The vendor is in the message. */
const CODE_KNOWN = 'secret_detected';
const CODE_GENERIC = 'secret_high_entropy';

export async function runSecretsPolicy(
  input: FamilyRunInput<SecretsPolicyConfig>,
): Promise<FamilyRunResult> {
  const { policy, subject } = input;
  const findings: SafetyFinding[] = [];
  const mutations: Mutation[] = [];
  if (!policy.enabled) return { findings, mutations };

  // Idempotent: when the engine has already resolved the effective action this
  // is a no-op, and when a caller passes the record's action it still honours
  // the per-policy override. Either way the family decides nothing.
  const effective: SafetyAction = policy.action ?? input.action;
  const action = toLegacyAction(effective);

  // Edits are PROPOSED only when the effective action is mutating.
  // `HookVerdict.mutations` has no third state between "proposed" and "will be
  // applied", so a policy acting at `flag` that contributed edits would have
  // them applied the moment it merged with a redacting guardrail. (Deciding
  // whether to produce edits from an action it was handed is not the same as
  // deciding the action.)
  const propose = isMutating(effective);

  const options: ScanSecretsOptions = {
    known: policy.known,
    genericHighEntropy: policy.genericHighEntropy,
    minEntropy: policy.minEntropy,
    allowValues: policy.allowValues,
  };

  for (const segment of subject.segments) {
    const matches = scanSecrets(segment.text, options);
    if (matches.length === 0) continue;

    // One FINDING per distinct value in this segment — the same dedup the
    // legacy detector applied, and what keeps a file full of one repeated key
    // from writing a thousand rows into the evaluation log. One MUTATION per
    // OCCURRENCE, though: a redaction that covered only the first occurrence
    // would leave the credential in the text while the verdict claimed it was
    // removed.
    const reported = new Set<string>();
    for (const match of matches) {
      if (propose) {
        mutations.push({
          op: 'replace_span',
          path: segment.path,
          start: match.start,
          end: match.end,
          replacement: SECRET_REDACTION,
          family: 'secrets',
          policyId: policy.id,
          category: SECRET_FINDING_CATEGORY,
        });
      }

      if (reported.has(match.value)) continue;
      reported.add(match.value);
      findings.push({
        type: LEGACY_FINDING_TYPE.secrets,
        category: SECRET_FINDING_CATEGORY,
        // Unchanged from the legacy detector, including for the generic
        // heuristic: lowering that one to 'medium' would quietly reduce the
        // risk score of every guardrail lifted from an existing record.
        severity: 'high',
        message: `${match.label} detected`,
        action,
        block: action === 'block',
        // The raw value. `logEvaluation` truncates it to a two-character hint
        // before persisting, and `maskTextForLogging` needs it to mask the
        // stored sample — so this is the shape the log layer expects, not a
        // leak. `critical` is deliberately NOT set: it would force 'block'
        // regardless of the configured action and silently escalate every
        // guardrail lifted from a legacy record.
        value: match.value,
        family: 'secrets',
        hook: input.hook,
        policyId: policy.id,
        code: match.generic ? CODE_GENERIC : CODE_KNOWN,
        path: segment.path,
        span: { start: match.start, end: match.end },
      });
    }
  }

  return { findings, mutations };
}
