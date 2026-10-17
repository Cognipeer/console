import type { ObjectId } from 'mongodb';
import type { EntityMetricType, IUsageAttributionFields } from './types.base';

// ── Guardrail types ────────────────────────────────────────────────────────

export type GuardrailType = 'preset' | 'custom';
export type GuardrailTarget = 'input' | 'output';
export type GuardrailAction = 'block' | 'warn' | 'flag' | 'redact';
/** What happens when an LLM-backed policy errors out: pass content (open) or block it (closed). */
export type GuardrailFailMode = 'open' | 'closed';

export interface IGuardrailPiiPolicy {
  enabled: boolean;
  action: GuardrailAction;
  categories: Record<string, boolean>;
}

export interface IGuardrailWordFilterPolicy {
  enabled: boolean;
  action?: GuardrailAction;
  /** Built-in lists to activate, e.g. { 'profanity-en': true, 'profanity-tr': true }. */
  builtinLists?: Record<string, boolean>;
  /** Keys of tenant-uploaded word lists (guardrail_word_lists) to apply. */
  customListKeys?: string[];
  /** Tenant-defined banned words (matched after normalization). */
  words?: string[];
  /** Tenant-defined regular expressions (evaluated case-insensitively). */
  regexes?: string[];
}

/** A reusable, tenant-managed banned-word list (uploaded via CSV/text or edited inline). */
export interface IGuardrailWordList {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  /** Informational language tag, e.g. 'tr', 'en', 'mixed'. */
  language?: string;
  words: string[];
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IGuardrailModerationPolicy {
  enabled: boolean;
  /**
   * Which detector runs this policy.
   *  - `llm` (default): the chat model named by `modelKey` judges the text.
   *  - `model`: the moderation-category model named by `modelKey` classifies it.
   *  - `lexicon`: no model call at all — `moderationLexicon.ts`'s built-in,
   *    category-scoped keyword lists (reusing the word-filter matcher) plus
   *    a structural `child_safety` check. Zero cost/latency, materially
   *    lower recall on figurative/coded/novel phrasing than either model
   *    path — see `moderationLexicon.ts`'s header for the categories it
   *    covers and the ones it deliberately doesn't.
   *
   * The judge is the universal fallback — it works against any chat model —
   * but it costs a full completion on the hot path of every guarded
   * request, and it can only report a coarse severity. Where the provider
   * has a real classifier, `model` is both far cheaper and the only path
   * that yields true per-category probabilities. `lexicon` is cheaper
   * still, and — per `families/llm.ts`'s `runIf` gating — a natural
   * pre-filter for either model path rather than only a standalone choice.
   */
  detector?: 'llm' | 'model' | 'lexicon';
  /** Chat model (detector `llm`) or moderation model (detector `model`). Unused by `lexicon`. */
  modelKey?: string;
  categories: Record<string, boolean>;
  /**
   * detector `lexicon` only: tenant word-list keys (the existing
   * `guardrail_word_lists` feature) mapped onto a moderation category id.
   * This is how `hate`/`harassment`/`sexual`/`sexual/minors` — which ship
   * with no built-in lexicon, see `moderationWordLists.ts` — get real
   * coverage, and how any built-in category's seed list can be extended.
   */
  lexiconCustomLists?: Record<string, string[]>;
}

export interface IGuardrailPromptShieldPolicy {
  enabled: boolean;
  modelKey?: string;
  sensitivity: 'low' | 'balanced' | 'high';
  /**
   * `llm` (default): the judge in `llmEvaluator.ts`. `pattern`: no model
   * call — `promptShieldLexicon.ts`'s mechanical/structural pattern set
   * (override phrases, fake system blocks, exfiltration requests, encoding
   * tricks). Covers roughly a third of `PROMPT_SHIELD_ISSUES` — the
   * categories that turn on textual SHAPE rather than intent; see that
   * file's header for exactly which and why the rest stay LLM-only.
   */
  detector?: 'llm' | 'pattern';
}

export interface IGuardrailPresetPolicy {
  pii?: IGuardrailPiiPolicy;
  wordFilter?: IGuardrailWordFilterPolicy;
  moderation?: IGuardrailModerationPolicy;
  promptShield?: IGuardrailPromptShieldPolicy;
}

// ── Guardrail hook plane (contract v2) ─────────────────────────────────────
/**
 * The PERSISTED shape of a guardrail's hook configuration.
 *
 * It lives in the persistence layer rather than next to the evaluator because
 * `IGuardrail.hooks` has to name it, and nothing under `provider/` may import
 * from `@/lib/services/**` — that direction is what keeps these types safe to
 * pull into a pure module (importing the `@/lib/database` barrel instead
 * constructs providers and registers shutdown handlers on load).
 *
 * The split is deliberate: what is *stored* is described here, and the
 * *runtime* contract — HookCall / HookVerdict / SafetyFinding / Mutation plus
 * every constant and helper — is owned by
 * `@/lib/services/guardrail/hooks/contract`, which re-exports these rather
 * than redeclaring them. Two independent descriptions of a policy would drift,
 * and a drifted policy shape is a policy that silently stops running.
 *
 * Everything below is types only; this file has no runtime values.
 */

/** Bumped only on a breaking change to the hook call/verdict shape. */
export type GuardrailContractVersion = 2;

/**
 * The six hook points. A string union rather than an enum, which is exactly how
 * `prompt.pre` arrived: additive, invalidating no stored record. A seventh
 * (`retrieval.post`) would land the same way.
 *
 * `prompt.pre` and `input.pre` ARE NOT TWO NAMES FOR ONE THING, and the
 * difference is both semantics and money. `prompt.pre` is the incoming user
 * turn, once per run. `input.pre` fires before every model call — the agent
 * loop re-enters it after each tool round trip — so on a run with four tool
 * calls an `input.pre` moderation policy spends five model calls where a
 * `prompt.pre` one spends one, and the newest message it sees is a TOOL result
 * rather than anything a human typed. `input.pre` keeps its existing meaning
 * because persisted bindings depend on it; `prompt.pre` is the rule that had
 * nowhere to live.
 *
 * Direction is carried by the hook id itself. `IGuardrail.target` is NOT
 * consulted when a guardrail runs — the binding slot decides — which is why a
 * legacy record lifts onto BOTH `input.pre` and `output.pre` regardless of
 * what its `target` column says. It lifts onto NEITHER `prompt.pre` nor the
 * tool hooks: a row written before they existed never opted into them, and
 * gaining an evaluation (and a bill) on upgrade is not a migration, it is a
 * surprise.
 */
export type GuardrailHookId =
  | 'prompt.pre'
  | 'input.pre'
  | 'output.pre'
  | 'output.stream.delta'
  | 'tool.pre'
  | 'tool.post';

/**
 * Timing x failure handling as ONE discriminated field, so
 * `{ timing: 'async', onFail: 'block' }` is unrepresentable rather than merely
 * rejected by a validator: an async policy has by definition already let the
 * flow continue, so it cannot block. Two independent optionals would leak the
 * illegal pair into every level (policy, binding, webhook).
 */
export type GuardrailHookSchedule =
  | { timing: 'sync'; onFail: 'block' | 'log' }
  | { timing: 'async'; onFail: 'log' };

/**
 * Enforcement posture. `monitor` evaluates and logs but neutralises the
 * decision to 'allow' before anyone acts on it.
 *
 * Stored rows may carry older vocabularies for the same three states — the
 * enterprise enforcement plane wrote 'simulate', the MCP binding writes 'off'
 * — so this union stays at three canonical words and the read-time normaliser
 * folds the aliases in. Widening it here would push the aliases into every
 * comparison instead.
 */
export type GuardrailMode = 'enforce' | 'monitor' | 'disabled';

/**
 * `'allow'` plus the existing four actions, and deliberately nothing else.
 * No 'mask'/'tokenize' (they live per-category on IPiiPolicy, where promoting
 * them to this ladder would make `mask < redact` and silently escalate a
 * masking guardrail merged with a redacting one) and no 'sandbox'/
 * 'require_approval' (neither has a store). Keeping this a strict superset of
 * GuardrailAction by construction is what lets a hook verdict project back
 * onto the legacy `action` column without a lossy table.
 */
export type GuardrailSafetyAction = 'allow' | GuardrailAction;

/** The eleven policy families a hook can run. */
export type GuardrailPolicyFamily =
  | 'pii'
  | 'secrets'
  | 'word_filter'
  | 'regex'
  | 'moderation'
  | 'prompt_shield'
  | 'custom'
  | 'tool_access'
  | 'webhook'
  | 'cognipeer_guardrail_moderation'
  | 'cognipeer_guardrail_prompt_shield';

export interface GuardrailPolicyBase<F extends GuardrailPolicyFamily> {
  /** Stable within the guardrail and never reused — it appears on every finding. */
  id: string;
  family: F;
  enabled: boolean;
  /** Must be a subset of the family's valid hooks; enforced at save time. */
  hooks: GuardrailHookId[];
  schedule: GuardrailHookSchedule;
  /** Overrides the record-level `action` for this policy's findings. */
  action?: GuardrailSafetyAction;
  /**
   * Per-POLICY, unlike the record-level `failMode`: today one flaky moderation
   * model fails the whole guardrail closed and takes its deterministic PII
   * pass down with it.
   */
  failMode?: GuardrailFailMode;
  /** 0 / absent = no timeout, which is exactly today's behaviour. */
  timeoutMs?: number;
  /**
   * WHEN this policy is allowed to spend a model call — the single biggest cost
   * lever in the design. `'onFinding'` runs it only once a cheap deterministic
   * policy has already flagged something; `'onSideEffect'` only for a
   * destructive or external tool call (and for an UNCLASSIFIED one, because an
   * unknown tool is itself the risk signal). Absent — and any unrecognised
   * stored value — means `'always'`, which is what every lifted legacy policy
   * needs, since `evaluateGuardrail` has always run its LLM policies
   * unconditionally.
   *
   * Only the three LLM families read it (`resolveRunIf`,
   * services/guardrail/families/llm.ts): the deterministic families cost a pass
   * over a string, so gating them would add nothing but a way to switch them
   * off by accident.
   *
   * DECLARED HERE, and not merely read structurally, because the engine and
   * three editor screens all depend on the name. An undeclared field is one
   * rename away from reverting every conditional policy to `'always'` with no
   * compile error, no runtime error and a green UI — i.e. from silently
   * multiplying a tenant's guardrail model spend.
   */
  runIf?: 'always' | 'onFinding' | 'onSideEffect';
  label?: string;
  /**
   * What an end user is told when THIS policy blocks something, overriding the
   * per-reason template on `GuardrailBlockedMessageSettings.templates`.
   *
   * WHY IT EXISTS. Messages are keyed by `GuardrailBlockReasonClass`, and
   * `BLOCK_REASON_FOR_FAMILY` collapses `regex`, `custom` and `webhook` all
   * onto `'custom'` — deliberately, because an authored regex rule could be
   * about anything and guessing a specific reason for it produces a message
   * that is confidently wrong. But the consequence is that an operator editing
   * "the regex policy's message" is also rewriting the webhook policy's, with
   * nothing on screen saying so. This field is the narrow override that makes
   * the two separable.
   *
   * RESOLUTION ORDER, normative: this field, then
   * `blockedMessage.templates[reasonClass]`, then the built-in default for the
   * locale. The reason-class layer STAYS — it is how an operator sets one
   * message for every personal-data block at once — and this only outranks it
   * because it is the narrower statement of the same intent, authored on the
   * policy itself rather than on a preset.
   *
   * BLANK MEANS INHERIT, not "an empty message": `selectBlockMessageTemplate`
   * skips a layer whose string is whitespace, so clearing the box restores the
   * inherited wording instead of showing an end user nothing.
   *
   * Same closed variable set as every other template (`BLOCK_MESSAGE_VARS`),
   * and for the same reason: the output is shown to end users, so an
   * interpolatable matched value would turn the guardrail into an exfiltration
   * channel for the data it exists to protect. `validateGuardrailHooks` rejects
   * an unrecognised one at save time.
   */
  message?: string;
}

/**
 * `piiPolicyKey` is required once the policy is enabled, and there is deliberately
 * no inline category list: the PII service owns categories, languages, custom
 * patterns, checksum validators, per-category mask strategies and the tokenize
 * vault. Duplicating any of that here is how the two engines drift. Legacy
 * rows are lifted onto a generated policy instead of keeping their inline map.
 */
export interface GuardrailPiiPolicyConfig extends GuardrailPolicyBase<'pii'> {
  /**
   * The `IPiiPolicy.key` this policy scans through. NOT a guardrail policy id:
   * a PII policy is a separate, reusable tenant asset (`pii_policies`) that
   * this guardrail policy REFERENCES, which is why the field is prefixed —
   * `policy.piiPolicyKey` names the thing it points at, where the unprefixed
   * `policy.policyKey` read as if a policy carried its own key.
   */
  piiPolicyKey: string;
  actionOverride?: PiiAction;
  locale?: PiiLanguage;
  /**
   * Runs the legacy NFKC + zero-width-strip + de-obfuscated-email second pass
   * on top of the policy scan. The PII service performs no normalisation of
   * its own, so without this the migration silently loses obfuscation
   * resistance. Findings from that pass are span-less. Default true.
   */
  detectObfuscated?: boolean;
  /**
   * Set ONLY by the legacy lift, never by an authored config: the guardrail's
   * inline `policy.pii.categories`, already mapped onto the PII service's
   * catalog ids (`tckn` -> `tc_kimlik` and friends).
   *
   * It exists because provisioning the lifted policy is a DATABASE WRITE on a
   * row that has enforced PII for months without one. If that write fails —
   * a throttled tenant, a read-only replica, a permissions gap — the policy
   * would degrade to `evaluation_error`, i.e. fail OPEN on the single most
   * sensitive detector, on rows the operator never touched. With this list the
   * scan falls back to the stateless `detectPii` API, which needs no policy row
   * and no tenant scope, and reproduces exactly the categories the legacy
   * detector ran.
   *
   * An AUTHORED config has no legacy columns to lift and therefore no fallback:
   * enabling `pii` there requires a real `piiPolicyKey`, which is the point.
   */
  legacyCategories?: Record<string, boolean>;
}

/**
 * Deterministic credential scan, split out of the PII detector so it can run
 * without a database. It keeps the legacy `pii` finding type on the wire, so
 * consumers that filter findings down to the PII dimension still see secrets.
 */
export interface GuardrailSecretsPolicyConfig extends GuardrailPolicyBase<'secrets'> {
  /** The named vendor patterns (Stripe / OpenAI / AWS / GitHub / Slack / JWT / PEM). */
  known?: boolean;
  /**
   * The `\b[A-Za-z0-9-_]{32,}\b` heuristic. It fires on ordinary base64 and on
   * UUIDs, so it is gated behind an entropy floor rather than shipped bare.
   */
  genericHighEntropy?: boolean;
  minEntropy?: number;
  /** Known-safe literals: test fixtures, documentation samples. */
  allowValues?: string[];
}

export interface GuardrailWordFilterPolicyConfig extends GuardrailPolicyBase<'word_filter'> {
  builtinLists?: Record<string, boolean>;
  customListKeys?: string[];
  words?: string[];
  /**
   * Carried verbatim from `IGuardrailWordFilterPolicy.regexes` so the legacy
   * lift is behaviour-identical. Newly authored patterns belong in the `regex`
   * family, which is span-capable and stream-eligible; these are not.
   */
  regexes?: string[];
}

export interface GuardrailRegexRule {
  id: string;
  label: string;
  pattern: string;
  flags?: string;
  category: string;
  /** Same three levels as GuardrailFinding.severity — never widened. */
  severity: 'low' | 'medium' | 'high';
  action?: GuardrailSafetyAction;
  /** Redact only this capture group instead of the whole match. */
  captureGroup?: number;
  /**
   * Longest string this rule can match. Required, and rejected above 4096:
   * it is what sizes the streaming hold-back window, and an unbounded rule
   * would make the stream silently unenforceable at window boundaries.
   */
  maxMatchChars: number;
}

export interface GuardrailRegexPolicyConfig extends GuardrailPolicyBase<'regex'> {
  rules: GuardrailRegexRule[];
}

export interface GuardrailModerationPolicyConfig
  extends GuardrailPolicyBase<'moderation'>, IGuardrailModerationPolicy {}

export interface GuardrailPromptShieldPolicyConfig
  extends GuardrailPolicyBase<'prompt_shield'>, IGuardrailPromptShieldPolicy {}

export interface GuardrailCustomPolicyConfig extends GuardrailPolicyBase<'custom'> {
  modelKey?: string;
  prompt: string;
  /**
   * Preserves an existing quirk rather than silently changing it: today a
   * custom guardrail with no model evaluates nothing and passes. Lifted policies
   * get 'skip' so no tenant's behaviour moves; newly authored ones default to
   * 'error_finding', so the quirk dies for new configs only.
   */
  onMissingModel: 'skip' | 'error_finding';
}

export type GuardrailSideEffect = 'none' | 'read' | 'write' | 'destructive' | 'external';

/**
 * A deliberate subset of JSON Schema — no $ref, no remote schemas, no Ajv.
 * Exactly what the enforcement plane's 12-line validator already supported, so
 * the migration of stored argument schemas is 1:1.
 */
export interface GuardrailJsonSchemaLite {
  type?: 'object' | 'string' | 'number' | 'boolean' | 'array';
  required?: string[];
  properties?: Record<string, GuardrailJsonSchemaLite>;
  enum?: unknown[];
  additionalProperties?: boolean;
}

export interface GuardrailToolAccessPolicyConfig extends GuardrailPolicyBase<'tool_access'> {
  allow?: string[];
  deny?: string[];
  sideEffects?: Record<string, GuardrailSideEffect>;
  allowedRoles?: Record<string, string[]>;
  allowedDomains?: string[];
  deniedDomains?: string[];
  allowedPathPrefixes?: string[];
  deniedPathPrefixes?: string[];
  argumentSchemas?: Record<string, GuardrailJsonSchemaLite>;
  maxArgBytes?: number;
  maxResultBytes?: number;
  /** JSON-bomb defence. Default 32. */
  maxArgDepth?: number;
  /**
   * Which tool arguments actually carry a URL / a filesystem path, per tool
   * name. Declared paths are authoritative; scraping every string for
   * `https?://` or a leading `/` both missed real targets (`//evil.com`,
   * `file:`, `data:`, scheme-less hosts) and false-positived on any prose
   * containing a slash.
   */
  urlArgPaths?: Record<string, string[]>;
  pathArgPaths?: Record<string, string[]>;
  /**
   * The old scrape, kept as a clamped fallback. Default false; when on, its
   * findings are clamped to 'medium'/'flag' and never trigger DNS resolution.
   */
  scanUndeclaredStrings?: boolean;
  /**
   * Root that path prefixes resolve against. Matching is on a POSIX-normalised
   * path, because raw `startsWith` lets `/workspace/../etc/shadow` walk
   * straight through an allowed prefix.
   */
  fsRoot?: string;
  /**
   * SSRF guard on declared URL arguments only. It resolves DNS, so it never
   * runs on scraped strings and never on a streaming hook.
   */
  denyPrivateNetworks?: boolean;
  /** Default 'read'. Defaulting undeclared tools to 'external' made every unknown tool suspicious. */
  defaultSideEffect?: GuardrailSideEffect;
  /**
   * Side effect -> action. Defaults to warn (not block) for destructive and
   * external, which reproduces today's ACTUAL behaviour: the sandbox adapter
   * those rungs resolved to is a pass-through, so the tool ran anyway.
   */
  sideEffectActions?: Partial<Record<GuardrailSideEffect, GuardrailSafetyAction>>;
}

/**
 * The extension point. Its request body IS a hook call and its response body
 * IS a hook verdict — one documented contract for in-process, remote and
 * customer transports, instead of a bespoke envelope to keep in sync.
 */
export interface GuardrailWebhookPolicyConfig extends GuardrailPolicyBase<'webhook'> {
  /** https only, enforced at save. Outbound calls go through the SSRF-guarded fetch. */
  url: string;
  headers?: Record<string, string>;
  /** Provider key holding the encrypted bearer, same pattern as IEvaluationExternalTarget. */
  credentialProviderKey?: string;
  /** Config key of the HMAC secret used to sign `${timestamp}.${body}`. */
  signingSecretRef?: string;
  /** 'text' keeps structured PII off the wire unless the operator opts in. */
  send: 'text' | 'subject';
  /**
   * Apply the redactions THIS hook run has already computed before serialising
   * the body. Default TRUE, and the default is the security-relevant half: by
   * the time a webhook runs, the deterministic families have already located
   * the credentials and the PII, and shipping the raw text to a third party
   * after deciding it must be redacted is a data leak the guardrail itself
   * caused. Set it false only for a receiver that has to see the original.
   *
   * It can only remove what another enabled policy FOUND, so it is not a promise
   * that the payload is clean — which is why the request carries an
   * `x-cognipeer-guardrail-redactions` count of the rewrites actually applied
   * rather than a bare "redacted: true".
   */
  redactBeforeSend?: boolean;
  retries?: 0 | 1 | 2;
}

/**
 * Two bundled, offline classifiers — split across TWO families rather than
 * one, deliberately mirroring the `moderation` / `prompt_shield` split above
 * even though both run the SAME `@cognipeer/guardrail` npm package model:
 * an operator configures, binds, and enables/disables the content gate and
 * the injection gate independently (same reason a hosted moderation model and
 * an LLM prompt-shield judge are two separate policies today, not one), and
 * this pair is meant to sit ALONGSIDE `moderation`/`prompt_shield` — an
 * additional, no-model detector an operator can turn on next to them — not to
 * be folded into either.
 *
 * The model itself answers both gates from ONE inference regardless of which
 * family calls it — see `families/cognipeerGuardrail.ts`'s shared instance
 * cache — so running both costs one extra classifier call, not two model
 * loads.
 *
 * NO `modelKey` on either: the model ships inside the npm package, so there
 * is nothing for an operator to register or point at.
 */
export interface GuardrailCognipeerGuardrailModerationPolicyConfig
  extends GuardrailPolicyBase<'cognipeer_guardrail_moderation'> {
  /** Six content category ids, verbatim from the package's `manifest.json`:
   *  `insult`, `hate`, `sexual`, `violence`, `self_harm`, `illegal`. */
  categories: Record<string, boolean>;
  /**
   * A false-positive BUDGET, not a raw cutoff — see `Guardrail.load`'s own doc
   * comment in the package. `sexual`/`violence`/`self_harm`/`illegal` score
   * identically in every profile; only the noisier `insult`/`hate` move.
   */
  profile: 'strict' | 'balanced' | 'sensitive';
}

export interface GuardrailCognipeerGuardrailPromptShieldPolicyConfig
  extends GuardrailPolicyBase<'cognipeer_guardrail_prompt_shield'> {
  /** Three prompt-shield category ids, verbatim from the package's
   *  `manifest.json`: `jailbreak`, `prompt_injection`, `data_exfiltration`. */
  categories: Record<string, boolean>;
  /** Same budget as the moderation twin; here it is the shield categories
   *  that move between profiles. */
  profile: 'strict' | 'balanced' | 'sensitive';
}

export type GuardrailPolicy =
  | GuardrailPiiPolicyConfig
  | GuardrailSecretsPolicyConfig
  | GuardrailWordFilterPolicyConfig
  | GuardrailRegexPolicyConfig
  | GuardrailModerationPolicyConfig
  | GuardrailPromptShieldPolicyConfig
  | GuardrailCustomPolicyConfig
  | GuardrailToolAccessPolicyConfig
  | GuardrailWebhookPolicyConfig
  | GuardrailCognipeerGuardrailModerationPolicyConfig
  | GuardrailCognipeerGuardrailPromptShieldPolicyConfig;

export interface GuardrailHookBinding {
  enabled: boolean;
  schedule: GuardrailHookSchedule;
  failMode?: GuardrailFailMode;
  /** Whole-hook budget. 0 / absent = no timeout, matching today. */
  timeoutMs?: number;
}

export interface GuardrailStreamSettings {
  /**
   * Opt-in. Lifted legacy rows get false so the existing post-hoc audit is
   * reproduced exactly and no tenant's streaming behaviour changes on upgrade;
   * newly created guardrails default to true.
   */
  enabled: boolean;
  /**
   * Characters withheld behind the write frontier. The engine RAISES this to
   * the longest match any enabled stream-eligible policy can produce, because
   * that is what makes the guarantee true: no such match can begin before the
   * frontier and end after it if the withheld tail is at least as long.
   * Default 256.
   */
  holdBackChars?: number;
  /** ...or this long, whichever comes first. Default 200. */
  holdBackMs?: number;
  /**
   * Characters before the release point re-scanned each window, so a match
   * starting in already-scanned text is re-found with a correct absolute span.
   * Default 64.
   */
  overlapChars?: number;
  /** Cap on the held region; on overflow `onBudgetExceeded` decides. Default 4000. */
  maxHeldChars?: number;
  onBudgetExceeded?: 'release' | 'terminate';
  /**
   * 'truncate' ends the stream after the block message. 'replace' is only
   * honest when nothing has been flushed to the client yet. Default 'truncate'.
   */
  onBlock?: 'truncate' | 'replace';
}

/** Coarse reason shown to an end user — never the matched value. */
export type GuardrailBlockReasonClass =
  | 'pii'
  | 'secrets'
  | 'profanity'
  | 'moderation'
  | 'injection'
  | 'tool_denied'
  | 'custom'
  | 'unavailable';

export interface GuardrailBlockedMessageSettings {
  /**
   * 'error' returns the OpenAI-shaped error body that clients parse today.
   * 'replace' returns a normal 200 whose assistant content IS the message,
   * with finish_reason 'content_filter' — what a chat UI can actually render.
   */
  mode?: 'error' | 'replace';
  /**
   * Per-reason overrides. The variable set is closed and excludes the matched
   * text: a template is tenant-editable and its output is shown to end users,
   * so an interpolatable matched value turns the guardrail into an
   * exfiltration channel for the data it exists to protect.
   */
  templates?: Partial<Record<GuardrailBlockReasonClass, string>>;
  /** Default true — support cannot debug a block without the trace id. */
  includeTraceId?: boolean;
}

export interface GuardrailVerdictVisibility {
  /** Response headers describing the verdict. Default true. */
  headers?: boolean;
  /**
   * Opt-in, and off by default: a block is HTTP 400 with
   * `{ error: { type: 'guardrail_block' } }` today and every deployed
   * OpenAI-compatible client parses that.
   */
  useVerdictStatusCodes?: boolean;
  detailedHeaders?: boolean;
  /** Keep the pre-rename `x-aegis-*` header aliases for one release. */
  aegisCompatHeaders?: boolean;
}

/**
 * The whole v2 configuration in ONE persisted blob, and therefore ONE SQLite
 * column. Splitting policies / bindings / stream / message / visibility into
 * separate fields would cost four call sites per field in each of the two
 * provider mixins, and missing one of them fails silently: Mongo accepts the
 * write, SQLite drops it, and the UI shows it saved because it re-reads the
 * row it just failed to update.
 */
export interface GuardrailHooksConfig {
  contractVersion: GuardrailContractVersion;
  policies: GuardrailPolicy[];
  bindings: Partial<Record<GuardrailHookId, GuardrailHookBinding>>;
  stream?: GuardrailStreamSettings;
  blockedMessage?: GuardrailBlockedMessageSettings;
  visibility?: GuardrailVerdictVisibility;
  /**
   * Stop after the first synchronous `block`. Default true.
   *
   * WHOLE-CONFIG, and the only ordering knob there is: a policy declares WHERE
   * it runs with `hooks`, and the engine's phase order (deterministic families
   * first, then the model-backed ones and `webhook`) is fixed. This says only
   * whether the work after a blocking finding is still worth doing.
   *
   * Every legacy-lifted row and the default tool guardrail carry `false`, to
   * keep their whole findings array for the audit trail and for the
   * /v1/moderations category map.
   */
  shortCircuit?: boolean;
}

/**
 * ONE guardrail attached to a consumer (a model, an agent), plus which hooks
 * it may fire on there. A consumer holds an ARRAY of these, which is the whole
 * point: the single `inputGuardrailKey`/`outputGuardrailKey` slots it replaces
 * make composing two reusable guardrails impossible and can bind nothing at
 * all to `tool.pre`/`tool.post`.
 *
 * The reference is by `key`, never by id — that is what the legacy columns
 * already store, what the API payloads carry and what survives a tenant
 * export/import, so the two generations stay comparable and
 * `projectBindingsToLegacy()` is a pure rename rather than a lookup.
 *
 * Resolution lives in `@/lib/services/guardrail/hooks/binding`, not here: this
 * file is types-only and both call sites must share one implementation or they
 * will disagree about what a legacy row binds to.
 */
export interface IGuardrailBinding {
  key: string;
  /**
   * Hooks this binding activates. Omitted = every hook the guardrail itself
   * declares (its own `hooks.bindings`), which is what "just attach it"
   * should mean. An explicitly EMPTY array is honoured literally: bound to
   * nothing, i.e. parked without being deleted.
   */
  hooks?: GuardrailHookId[];
}

export interface IGuardrail {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: GuardrailType;
  target: GuardrailTarget;
  action: GuardrailAction;
  enabled: boolean;
  /** LLM-backed policy failure behavior. Defaults to 'open' (content passes if the evaluator errors). */
  failMode?: GuardrailFailMode;
  modelKey?: string;
  /**
   * The legacy preset blob, and a real COLUMN on both backends.
   *
   * NOT a policy in the `hooks.policies` sense, despite the name — this is the
   * pre-hook-plane pii/wordFilter/moderation/promptShield bundle that
   * `liftLegacyHooks` derives a policy list FROM and `projectHooksToLegacy`
   * writes back TO. The two are told apart by number: singular `policy` is the
   * legacy blob, plural `policies` is the hook plane's list. It is kept and
   * kept current because an older console binary on the same tenant database
   * still reads it.
   *
   * @deprecated Author `hooks.policies` instead. Still WRITTEN on every save
   * (see `projectHooksToLegacy`) and still READ by `moderationApi` and by
   * older binaries, so it cannot be dropped.
   */
  policy?: IGuardrailPresetPolicy;
  // For custom prompt guardrails
  customPrompt?: string;
  /**
   * v2 hook plane. Absent on every row written before it shipped, so it is
   * OPTIONAL and the legacy columns above stay permanently populated: they are
   * what an older console binary on the same tenant database, and the
   * finding-shape consumers that scan `policy`, still read.
   */
  hooks?: GuardrailHooksConfig;
  /**
   * 0 / absent means `hooks` was DERIVED from the legacy columns and must be
   * re-derived on every read, so a later fix to the projection reaches every
   * un-edited record. >= 1 means an operator authored it and it is used
   * verbatim. Deriving-and-persisting on the evaluate path instead would be a
   * write per evaluation and would freeze the derivation.
   */
  hooksVersion?: number;
  /** Absent = derived from `enabled` ('enforce' when on, 'disabled' when off). */
  mode?: GuardrailMode;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Evaluation types ─────────────────────────────────────────────────────────

export type EvaluationTargetKind = 'agent' | 'model' | 'external' | 'rag';
export type EvaluationRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type EvaluationRunMode = 'sync' | 'async';
export type EvaluationDatasetSource = 'manual' | 'file' | 'generated' | 'imported';
export type EvaluationScorerType =
  | 'assertion'
  | 'llm-judge'
  | 'semantic'
  | 'tool-call'
  | 'json-shape'
  /**
   * Retrieval quality, all three judged by embedding cosine similarity rather
   * than string overlap — a chunk that answers the question in different words
   * is a hit, and an exact-match scorer would call it a miss.
   */
  | 'context-recall'
  | 'context-precision'
  | 'groundedness';

/**
 * How a multi-turn dataset item is replayed against the target.
 *
 * `single` (default) sends the item's whole recorded prefix and calls the model
 * ONCE — every earlier assistant turn is the one production actually produced.
 * `perTurn` drives the conversation turn by turn and feeds the model its OWN
 * answers back, so errors compound the way they do in a live session.
 *
 * They measure different things and both are needed: `single` isolates each
 * decision against a known-good history (a clean regression signal, cheap), and
 * `perTurn` is the only mode that can catch drift — an agent that answers every
 * turn correctly in isolation but loses the thread once it is reading its own
 * output. A single-turn dataset behaves identically under both.
 */
export type EvaluationTurnMode = 'single' | 'perTurn';

export interface IEvaluationExternalTarget {
  protocol: 'openai-chat' | 'webhook';
  url: string;
  headers?: Record<string, string>;
  /** Provider key holding encrypted credentials for the external endpoint. */
  credentialProviderKey?: string;
  /** Dot-path used to pull the assistant text out of a webhook response. */
  responsePath?: string;
}

export interface IEvaluationTarget {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  kind: EvaluationTargetKind;
  agentKey?: string;
  /**
   * `agent` targets: pin the run to one published version instead of following
   * whatever is published now.
   *
   * Absent means "the published version", which is the right default for a
   * suite that guards production. Pinning is what makes a comparison run
   * meaningful: two targets on the same agent at v3 and v4 answer "did the new
   * version regress?", and that question is unanswerable while both silently
   * follow the same moving pointer.
   *
   * `null` is how a PATCH clears an existing pin: both provider mixins treat
   * `undefined` as "leave this field alone", so an absent key cannot unpin.
   */
  agentVersion?: number | null;
  modelKey?: string;
  external?: IEvaluationExternalTarget;
  /** `rag` targets: which module to retrieve from, and how much. */
  ragModuleKey?: string;
  retrievalTopK?: number;
  retrievalMinScore?: number;
  /**
   * System prompt to run this target with, overriding whatever system turn the
   * dataset items carry. Needed to evaluate a prompt CHANGE against traffic
   * captured with the old prompt: snapshot items embed the system prompt they
   * were recorded with, so without an override every run re-tests the prompt
   * already in production. `promptKey` pulls the template from the Prompts
   * module (resolved per run, so promoting a new version changes what is
   * tested); `systemPrompt` is a literal. `promptKey` wins if both are set.
   * `model` targets only — see the note on agent targets in adapters.ts.
   */
  systemPrompt?: string;
  promptKey?: string;
  promptVersion?: number;
  /**
   * Structured-output contract sent with every call for this target, mirroring
   * the OpenAI `response_format` field. A suite that omits it is not testing
   * production: an agent whose JSON envelope is enforced on the wire behaves
   * very differently from the same model asked in prose, and the difference
   * only shows up as malformed output once it is live.
   */
  responseFormat?: Record<string, unknown>;
  /** Output-token ceiling. Left unset, a long structured answer can truncate mid-object. */
  maxTokens?: number;
  defaultParams?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEvaluationDatasetItem {
  id: string;
  input: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** Assistant turns: tool calls issued in this turn. */
    toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
    /** Tool turns: id of the assistant tool call this responds to. */
    toolCallId?: string;
    /** Tool turns: tool name, when recorded. */
    name?: string;
  }>;
  expected?: Record<string, unknown>;
  /** Tools exposed to the target for trajectory testing (never executed). */
  tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  /** Canned tool results; key format: `name + '(' + canonicalJson(args) + ')'`. */
  toolResults?: Record<string, unknown>;
  /**
   * Structured-output contract this item was recorded under (OpenAI
   * `response_format` shape), captured from the trace / gateway log by Traffic
   * Snapshots. Replaying an item without the contract production enforced
   * measures a different system — see the note in evaluation/types.ts.
   */
  responseFormat?: Record<string, unknown>;
  tags?: string[];
  /**
   * Structured labels keyed by an analysis definition's field keys (intent,
   * complexity, language, …). Written either by an AI labeling run (an
   * analysis definition run against this dataset) or by a human in the item
   * editor; `labelMeta.source` says which. Unlike free-form `tags` these are
   * queryable key→value pairs, so runs and reports can slice by segment.
   */
  labels?: Record<string, unknown>;
  labelMeta?: IDatasetItemLabelMeta;
}

/**
 * Provenance for `IEvaluationDatasetItem.labels`. A human edit always wins: AI
 * labeling runs skip items whose meta says `source: 'human'`, so reviewer
 * corrections survive re-runs and can be used as ground truth for scoring the
 * labeler itself (accuracy mode).
 */
export interface IDatasetItemLabelMeta {
  source: 'ai' | 'human';
  /** Analysis definition that produced these labels (AI runs). */
  definitionKey?: string;
  /** Analysis run that produced these labels (AI runs). */
  runId?: string;
  /** Extraction model used (AI runs). */
  modelKey?: string;
  /** LLM-judge verdict for the item, when the definition enables judge mode. */
  judge?: { score: number; passed?: boolean; reasoning?: string };
  /** ISO timestamp — stored as a string so both providers round-trip it identically. */
  labeledAt?: string;
  /** User id for human labels. */
  labeledBy?: string;
}

/**
 * Query options for listing/counting dataset items. `label` and `labeled`
 * make labels a first-class filter dimension — the point of labeling being to
 * slice a dataset by segment (and to find what still needs labeling) without
 * pulling every item into memory.
 */
export interface EvaluationDatasetItemQuery {
  skip?: number;
  limit?: number;
  search?: string;
  /** Match one label; `value` omitted means "has this label key at all". */
  label?: { key: string; value?: string };
  /** true → only items carrying labels; false → only unlabeled items. */
  labeled?: boolean;
}

export interface IEvaluationDataset {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  source: EvaluationDatasetSource;
  /**
   * LEGACY embedded storage. Live items are rows in the separate
   * `evaluation_dataset_items` collection/table (see
   * IEvaluationDatasetItemRecord); this field survives only on documents
   * created before the split and is migrated (then cleared) on the first
   * item write. Writers may still PASS `items` to create/update — the
   * provider routes them to the item collection — but readers must use the
   * item methods, never this field.
   */
  items?: IEvaluationDatasetItem[];
  /** Denormalised item count, maintained by the provider's item methods. */
  itemCount?: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * One dataset item as persisted in the dedicated `evaluation_dataset_items`
 * collection/table. Items used to live embedded on the dataset document,
 * which capped a whole dataset at one Mongo document (16MB) and forced every
 * read/write to ship the full array; each item is now its own row keyed by
 * (datasetId, itemId) with a stable `position` for ordering.
 */
export interface IEvaluationDatasetItemRecord extends IEvaluationDatasetItem {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Parent dataset `_id` (string form). */
  datasetId: string;
  /** Stable sort position within the dataset (0-based). */
  position: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEvaluationScorerConfig {
  type: EvaluationScorerType;
  weight?: number;
  rubric?: string;
  threshold?: number;
  // tool-call scorer component weights (selection F1 / order / arg matching)
  selectionWeight?: number;
  sequenceWeight?: number;
  argsWeight?: number;
}

export interface IEvaluationSuite {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  targetKey: string;
  datasetKey: string;
  scorers: IEvaluationScorerConfig[];
  /** Model used to back any llm-judge scorers. */
  judgeModelKey?: string;
  /** Embedding model used to back any semantic (vector) scorers. */
  embeddingModelKey?: string;
  runConfig?: { concurrency?: number; turnMode?: EvaluationTurnMode };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IEvaluationScore {
  scorerType: EvaluationScorerType;
  score: number;
  passed: boolean;
  weight: number;
  detail?: Record<string, unknown>;
  error?: string;
}

/** Token / cost usage captured for one run item's target invocation. */
export interface IEvaluationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
}

export interface IEvaluationRunItem {
  itemId: string;
  output?: {
    text: string;
    latencyMs?: number;
    /** Tool calls emitted by the target (trajectory scoring / display). */
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
    /**
     * `perTurn` runs only: what the model said at every turn. Only the last
     * turn is scored, so without this a failed multi-turn item is
     * unexplainable — the turn where the model lost the thread is invisible.
     * Capped (see EVAL_RUN_TURNS_CAP) because a run is one document.
     */
    turns?: Array<{
      index: number;
      question: string;
      text: string;
      toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
      latencyMs?: number;
    }>;
  };
  scores: IEvaluationScore[];
  score: number;
  passed: boolean;
  latencyMs?: number;
  usage?: IEvaluationUsage;
  error?: string;
}

export interface IEvaluationRunAggregate {
  total: number;
  completed: number;
  failed: number;
  passed: number;
  passRate: number;
  avgScore: number;
  avgLatencyMs: number | null;
  /** Present only when at least one item reported provider usage. */
  totalCostUsd?: number;
  totalTokens?: number;
}

export interface IEvaluationRun {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  suiteKey: string;
  targetKey: string;
  datasetKey: string;
  status: EvaluationRunStatus;
  mode: EvaluationRunMode;
  progress: { total: number; completed: number; failed: number };
  aggregate?: IEvaluationRunAggregate;
  items: IEvaluationRunItem[];
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Red-team (adversarial agent testing) types ───────────────────────────────

export type RedTeamTargetKind = 'agent' | 'model';
export type RedTeamRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RedTeamRunMode = 'sync' | 'async';
export type RedTeamOutcome = 'safe' | 'vulnerable' | 'needs_review';
export type RedTeamSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Decision-policy overrides; mirrors the engine's DecisionPolicyConfig. */
export interface IRedTeamPolicyConfig {
  deterministicConfidence?: number;
  reviewBand?: [number, number];
  maxJudgeVariance?: number;
}

/**
 * A red-team campaign: what to attack (agent/model), which probes to run, and
 * how to judge. Probes and detectors are code-defined (built-in catalog), so a
 * campaign only stores the selection — there is no separate dataset entity.
 */
export interface IRedTeamCampaign {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  targetKind: RedTeamTargetKind;
  agentKey?: string;
  modelKey?: string;
  /** Selected built-in probe keys; empty selects the whole catalog. */
  probeKeys: string[];
  /** Model backing any llm-judge detectors (required if probes use them). */
  judgeModelKey?: string;
  runConfig?: { concurrency?: number };
  policy?: IRedTeamPolicyConfig;
  /** Optional cron schedule for unattended (e.g. nightly) regression scans. */
  schedule?: { cron: string; enabled: boolean };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRedTeamSignal {
  detectorKey: string;
  kind: string;
  hit: boolean;
  score: number;
  confidence: number;
  gate?: 'safe';
  rationale: string;
  modelRef?: string;
  error?: string;
}

export interface IRedTeamTurn {
  user: string;
  assistant: string;
}

/** Optional human-in-the-loop override of a machine verdict. */
export interface IRedTeamReview {
  outcome: RedTeamOutcome;
  note?: string;
  reviewedBy: string;
  reviewedAt: Date;
}

export interface IRedTeamAttemptResult {
  probeKey: string;
  attemptId: string;
  family: string;
  category: string;
  severity: RedTeamSeverity;
  outcome: RedTeamOutcome;
  decidedBy: string;
  confidence: number;
  transcript: IRedTeamTurn[];
  signals: IRedTeamSignal[];
  latencyMs?: number;
  error?: string;
  review?: IRedTeamReview;
}

export interface IRedTeamCategoryBreakdown {
  total: number;
  vulnerable: number;
  needsReview: number;
}

export interface IRedTeamAggregate {
  total: number;
  completed: number;
  failed: number;
  vulnerable: number;
  safe: number;
  needsReview: number;
  attackSuccessRate: number;
  resilienceScore: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, IRedTeamCategoryBreakdown>;
  avgLatencyMs: number | null;
}

export interface IRedTeamRun {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  campaignKey: string;
  targetKind: RedTeamTargetKind;
  /** agentKey or modelKey of the target under test (for display). */
  targetRef: string;
  status: RedTeamRunStatus;
  mode: RedTeamRunMode;
  progress: { total: number; completed: number; failed: number };
  aggregate?: IRedTeamAggregate;
  attempts: IRedTeamAttemptResult[];
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Red-team custom probes ─────────────────────────────────────────────────────

/** One adversarial attempt of a user-authored custom probe. */
export interface IRedTeamCustomAttempt {
  id: string;
  /** User turns (length ≥ 1). Only the first is used as the seed when adaptive. */
  turns: string[];
  /** Optional system prompt. `{{canary}}` is substituted with the canary value. */
  system?: string;
  /** A secret planted in the system turn that the target must never reveal. */
  canary?: string;
  /** Substrings / regex sources whose presence in output indicates a hit. */
  forbiddenPatterns?: string[];
  /** Whether a refusal is the safe outcome (default true). */
  refusalExpected?: boolean;
  /** Drive an adaptive multi-turn attack when an attacker model is available. */
  adaptive?: boolean;
  /** The attacker's goal, used to steer the adaptive loop. */
  objective?: string;
}

/** One LLM-judge lens configured on a custom probe. */
export interface IRedTeamCustomJudgeLens {
  lens: string;
  rubric: string;
  /** Hit threshold on the normalised 0..1 success score (default 0.5). */
  threshold?: number;
}

/** Which detectors a custom probe attaches to each of its attempts. */
export interface IRedTeamCustomDetectors {
  /** Include the cheap explicit-refusal "safe" gate. */
  refusal?: boolean;
  /** Include the deterministic canary / forbidden-pattern detector. */
  pattern?: boolean;
  /** A perspective-diverse panel of llm-judge lenses (needs a judge model). */
  judges?: IRedTeamCustomJudgeLens[];
}

/**
 * A user-authored adversarial probe. Built-in probes are code-defined; custom
 * probes are persisted definitions resolved into runtime Probe instances at scan
 * time. The `key` is namespaced with a `custom:` prefix so it never clashes with
 * the built-in catalog and a campaign's `probeKeys` can mix both.
 */
export interface IRedTeamCustomProbe {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Unique, `custom:`-prefixed selection key. */
  key: string;
  name: string;
  description: string;
  family: string;
  /** OWASP category string (mirrors OwaspLlmCategory). */
  category: string;
  severity: RedTeamSeverity;
  attempts: IRedTeamCustomAttempt[];
  detectors: IRedTeamCustomDetectors;
  enabled?: boolean;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Analysis types ───────────────────────────────────────────────────────────

export type AnalysisFieldType = 'string' | 'number' | 'boolean' | 'enum';
export type AnalysisRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AnalysisRunMode = 'sync' | 'async';
export type AnalysisConversationSource = 'imported' | 'platform' | 'manual';

export interface IAnalysisFieldDef {
  key: string;
  type: AnalysisFieldType;
  description?: string;
  enumValues?: string[];
  required?: boolean;
}

export interface IAnalysisModes {
  /** Persist extracted fields back onto each conversation. */
  store?: boolean;
  /** Grade conversation quality against a rubric with an LLM judge. */
  judge?: { rubric: string; threshold?: number };
  /** Compare extracted fields against each conversation's referenceFields. */
  accuracy?: boolean;
}

export interface IAnalysisDefinition {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  fieldSet: IAnalysisFieldDef[];
  extractionInstructions?: string;
  modes: IAnalysisModes;
  /** Model used for field extraction. */
  extractionModelKey?: string;
  /** Model used to back the llm-judge mode. */
  judgeModelKey?: string;
  runConfig?: { concurrency?: number };
  /** Optional cron schedule for unattended (e.g. nightly) runs. */
  schedule?: { cron: string; enabled: boolean };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAnalysisTranscriptMessage {
  role: string;
  content: string;
}

export interface IAnalysisConversation {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name?: string;
  description?: string;
  transcript: IAnalysisTranscriptMessage[];
  source: AnalysisConversationSource;
  /** Free-form tags for grouping/filtering conversations (e.g. by campaign, channel). */
  tags?: string[];
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  /** Ground-truth field values for accuracy scoring. */
  referenceFields?: Record<string, unknown>;
  /** Latest extracted fields (store mode). */
  extractedFields?: Record<string, unknown>;
  lastAnalyzedAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAnalysisFieldAccuracy {
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface IAnalysisItemResult {
  conversationKey: string;
  extractedFields: Record<string, unknown>;
  missing: string[];
  judge?: { score: number; passed?: boolean; reasoning?: string; error?: string };
  accuracy?: { score: number; perField: Record<string, IAnalysisFieldAccuracy>; comparedCount: number };
  passed: boolean;
  error?: string;
}

export interface IAnalysisRunAggregate {
  total: number;
  completed: number;
  failed: number;
  passed: number;
  passRate: number;
  avgJudgeScore: number | null;
  avgExtractionAccuracy: number | null;
}

/**
 * What a run analyzed. Absent/`conversations` is the original behaviour (the
 * `analysis_conversations` corpus); `dataset` points the same engine at an
 * evaluation dataset's items, which is how AI labeling works — extraction
 * fields become the items' `labels`.
 */
export type IAnalysisRunTarget =
  | { kind: 'conversations' }
  | { kind: 'dataset'; datasetId: string; datasetKey?: string; datasetName?: string };

export interface IAnalysisRun {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  definitionKey: string;
  /** Defaults to the conversation corpus when absent (pre-dataset-target runs). */
  target?: IAnalysisRunTarget;
  status: AnalysisRunStatus;
  mode: AnalysisRunMode;
  progress: { total: number; completed: number; failed: number };
  aggregate?: IAnalysisRunAggregate;
  items: IAnalysisItemResult[];
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IInferenceServerMetrics {
  _id?: ObjectId | string;
  tenantId: string;
  serverKey: string;
  timestamp: Date;
  numRequestsRunning?: number;
  numRequestsWaiting?: number;
  gpuCacheUsagePercent?: number;
  cpuCacheUsagePercent?: number;
  promptTokensThroughput?: number;
  generationTokensThroughput?: number;
  timeToFirstTokenSeconds?: number;
  timePerOutputTokenSeconds?: number;
  e2eRequestLatencySeconds?: number;
  requestsPerSecond?: number;
  runningModels?: string[];
  raw?: Record<string, unknown>;
  createdAt?: Date;
}

// ── RAG Module types ────────────────────────────────────────────────────

/**
 * How a document is split before embedding.
 *
 * `recursive_character` and `token` differ in the UNIT `chunkSize`/`chunkOverlap`
 * are measured in — characters vs. real tokens. The rest change where the
 * boundaries are allowed to fall.
 */
export type RagChunkStrategy =
  /** Split on separators, largest first, falling back to a hard cut. Sizes in characters. */
  | 'recursive_character'
  /** Same boundaries, but sized in real tokens of `encoding`. */
  | 'token'
  /** Never cross a markdown heading; each chunk carries its heading path. */
  | 'markdown'
  /** Never cut mid-sentence. */
  | 'sentence'
  /** Cut where the topic shifts, measured by embedding distance between sentences. */
  | 'semantic';

export interface IRagChunkConfig {
  strategy: RagChunkStrategy;
  /**
   * Target chunk size. Characters for every strategy except `token`, which
   * counts real tokens of `encoding`. This is a HARD cap: a run of text with no
   * usable boundary is cut rather than emitted oversized.
   */
  chunkSize: number;
  /** Overlap carried into the next chunk, in the same unit as chunkSize. Must be < chunkSize. */
  chunkOverlap: number;
  /** recursive_character / markdown: boundary preferences, best first. `sentence` splits on punctuation and ignores this. */
  separators?: string[];
  /** token: tiktoken encoding name (cl100k_base, p50k_base, o200k_base). */
  encoding?: string;
  /**
   * semantic: cosine distance between neighbouring sentences above which a new
   * chunk starts. 0..1, default 0.35. Higher = fewer, larger chunks.
   */
  semanticThreshold?: number;
  /**
   * Small-to-big retrieval. Embed the small chunk, but return a window of this
   * many characters centred on it, resolved from the stored source at query
   * time. 0 or unset disables it.
   */
  parentWindowSize?: number;
  /**
   * Prefix each chunk with one LLM-written sentence situating it in its
   * document, which measurably improves retrieval on chunks that would
   * otherwise be context-free. Costs one model call per chunk at ingest.
   */
  contextualHeader?: {
    enabled: boolean;
    /** Model used to write the header. Falls back to the module's answer model. */
    modelKey?: string;
    /** How much of the document to show the model as context. Default 8000. */
    maxDocumentChars?: number;
  };
}

export type RagDocumentStatus = 'pending' | 'processing' | 'indexed' | 'failed';

/**
 * One vector similarity query, recorded for the index analytics panel
 * (query volume, latency, score, filter usage).
 */
export interface IVectorQueryLog {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  providerKey: string;
  /** Index key, matching `IVectorIndexRecord.key`. */
  indexKey: string;
  topK: number;
  matchCount: number;
  latencyMs: number;
  /** Mean similarity score across the returned matches. */
  avgScore?: number;
  /** Whether the caller supplied a metadata filter. */
  filterApplied: boolean;
  /** Whether the query ran dense+keyword rather than dense only. */
  hybrid?: boolean;
  userId?: string;
  apiTokenId?: string;
  actorType?: string;
  timestamp: Date;
}

/** Aggregated query analytics for one vector index, over a time window. */
export interface IVectorQueryStats {
  daily: Array<{
    /** UTC day, `YYYY-MM-DD`. */
    date: string;
    queryCount: number;
    avgLatencyMs: number;
    /** Null when no query in the bucket returned a score. */
    avgScore: number | null;
    filterCount: number;
  }>;
  totals: {
    totalQueries: number;
    avgLatencyMs: number | null;
    avgScore: number | null;
    minLatencyMs: number | null;
    maxLatencyMs: number | null;
  };
  topKDistribution: Array<{ topK: number; count: number }>;
}

export interface IRagModule {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  embeddingModelKey: string;
  vectorProviderKey: string;
  vectorIndexKey: string;
  fileBucketKey?: string;
  fileProviderKey?: string;
  chunkConfig: IRagChunkConfig;
  status: 'active' | 'disabled';
  /** Optional reference to a Reranker service that re-orders vector matches before returning. */
  rerankerKey?: string;
  /** When reranker is enabled, fetch this many candidates from vector store before re-ranking down to topK. */
  rerankerOversample?: number;
  /** Default number of matches a query returns when the request doesn't specify topK. */
  defaultTopK?: number;
  /** Default minimum similarity score a match must meet when the request doesn't specify minScore. */
  defaultMinScore?: number;
  /**
   * Metadata filter ANDed into every query against this module. Lets several
   * sources share one vector index while each module only ever retrieves its
   * own slice.
   */
  defaultFilter?: Record<string, unknown>;
  /**
   * Metadata keys callers may filter on. When set, a query filtering on any
   * other key is rejected; also advertised to agents and MCP clients so they
   * know what is filterable.
   */
  filterableFields?: string[];
  /**
   * How much of each match a query response carries. 'full' (default) keeps the
   * scores/ids/metadata; 'text' returns only the chunk text.
   */
  responseDetail?: 'full' | 'text';
  /**
   * Dense + keyword retrieval, for the providers whose store can do it.
   * Pure vector search misses exact terms — error codes, SKUs, acronyms, proper
   * nouns — because they carry little semantic signal.
   */
  hybrid?: {
    enabled: boolean;
    /** How the two rankings are combined. Default 'rrf'. */
    mode?: 'rrf' | 'weighted';
    /** weighted mode: 1 = pure dense, 0 = pure keyword. Default 0.5. */
    alpha?: number;
    /** rrf mode: rank constant. Default 60. */
    k?: number;
  };
  /**
   * AND `_ragModule` into every query so a vector index shared by several
   * modules cannot leak between them. Defaults on for modules we ingest into;
   * must stay off for an index populated by someone else's pipeline, whose
   * vectors carry no `_ragModule`.
   */
  isolateByModule?: boolean;
  /**
   * Set when chunkConfig or the embedding model changed and the stored vectors
   * no longer match it. Queries keep working against the old vectors until the
   * re-index run finishes.
   */
  reindexRequired?: boolean;
  /** Key of the re-index run currently rebuilding this module, if any. */
  activeReindexRunKey?: string;
  lastReindexAt?: Date;
  totalDocuments?: number;
  totalChunks?: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRagDocument {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  fileKey?: string;
  /** Bucket the original bytes were stored in, alongside fileKey. */
  fileBucketKey?: string;
  fileProviderKey?: string;
  fileName: string;
  contentType?: string;
  size?: number;
  status: RagDocumentStatus;
  chunkCount?: number;
  errorMessage?: string;
  lastIndexedAt?: Date;
  /**
   * Per-document override of the module's chunkConfig. A 200-page PDF and a FAQ
   * CSV rarely want the same splitter. Unset means "use the module's".
   */
  chunkConfig?: IRagChunkConfig;
  /**
   * The extracted text this document was last indexed from, so a re-index never
   * has to reconstruct it from overlapping chunks. Stored inline only when it
   * fits INLINE_SOURCE_MAX_CHARS; larger sources live in the file bucket under
   * sourceTextKey.
   */
  sourceText?: string;
  sourceTextKey?: string;
  /** sha256 of the extracted text — lets a re-ingest skip unchanged content. */
  sourceHash?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRagChunk {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  documentId: string;
  chunkIndex: number;
  vectorId: string;
  content: string;
  /**
   * Offsets of this chunk in the document's source text. These are what make a
   * parent window resolvable without duplicating the text on every child row.
   */
  charStart?: number;
  charEnd?: number;
  /** Markdown heading breadcrumb the chunk sits under, outermost first. */
  headingPath?: string[];
  /** Real token count of `content`, when the strategy computed one. */
  tokenCount?: number;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export interface IRagQueryLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  ragModuleKey: string;
  query: string;
  topK: number;
  /** Matches actually returned, i.e. after minScore and the final topK slice. */
  matchCount: number;
  /**
   * Matches the store returned BEFORE the minScore filter. Together with
   * matchCount this separates the two very different failures a zero-result
   * panel has to tell apart: nothing was retrieved at all, versus plenty was
   * retrieved and the score threshold discarded all of it.
   */
  preFilterMatchCount?: number;
  /** Best score among the returned matches, 0 when there were none. */
  topScore?: number;
  /** Mean score of the returned matches. */
  avgScore?: number;
  /** The minScore actually in force for this query, whatever its source. */
  minScoreApplied?: number;
  /** Whether the query ran dense+keyword rather than dense only. */
  hybrid?: boolean;
  latencyMs?: number;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

/**
 * One run of "rebuild every document in this module".
 *
 * The record is the source of truth, not the queue: the queue driver is only
 * durable when Redis is configured, so a boot-time sweep re-drives whatever is
 * still marked running. `progress` carries the resume cursor.
 */
export interface IRagReindexRun {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  ragModuleKey: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Why the run was created — shown in the UI banner. */
  reason?: 'chunk-config' | 'embedding-model' | 'manual';
  attempt: number;
  totalDocuments: number;
  processedDocuments: number;
  failedDocuments: number;
  batchSize: number;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  /** Resume checkpoint: `{ lastDocumentId, heartbeatAt }`. */
  progress?: Record<string, unknown>;
  /**
   * Cross-process ownership. The queue is in-process unless Redis is
   * configured, so after a rolling restart every replica's boot sweep sees the
   * same running run; without a claim held in the record they would all
   * re-embed the same corpus at once. A claim whose heartbeat has gone silent
   * is reclaimable, so a SIGKILLed worker does not strand its run.
   */
  claimedBy?: string;
  claimedAt?: Date;
  heartbeatAt?: Date;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Reranker types ──────────────────────────────────────────────────────

/**
 * Reranker strategies determine how candidate documents are re-scored.
 * - dedicated-model: calls a model with `category: 'rerank'` (Cohere/Jina/Voyage/BGE).
 * - llm-judge: prompts an LLM (category 'llm') with each candidate to produce a 0–1 score.
 * - llm-listwise: prompts an LLM once with the entire candidate list and asks for a ranked order.
 * - heuristic: keyword overlap / recency boost — no model required.
 */
export type RerankerStrategy =
  | 'dedicated-model'
  | 'llm-judge'
  | 'llm-listwise'
  | 'heuristic';

export type RerankerStatus = 'active' | 'disabled';

export interface IRerankerConfig {
  /** Model key (from Model Hub) — required for dedicated-model / llm-judge / llm-listwise. */
  modelKey?: string;
  /** Default topN returned by the reranker. If undefined, returns the same count as input. */
  topN?: number;
  /** Optional score threshold — drop candidates below this normalized [0,1] score. */
  scoreThreshold?: number;
  /** Batch size for llm-judge mode (parallel scoring). */
  batchSize?: number;
  /** Temperature for LLM strategies. */
  temperature?: number;
  /** Custom prompt template (llm-judge / llm-listwise). Supports {{query}} and {{document}} placeholders. */
  promptTemplate?: string;
  /** Score normalization — 'minmax' rescales scores to [0,1]. */
  scoreNormalization?: 'none' | 'minmax';
  /** Heuristic config: weights for keyword overlap vs recency, etc. */
  heuristicWeights?: {
    keyword?: number;
    recency?: number;
    originalScore?: number;
  };
}

export interface IReranker {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  strategy: RerankerStrategy;
  config: IRerankerConfig;
  status: RerankerStatus;
  totalRuns?: number;
  avgLatencyMs?: number;
  lastUsedAt?: Date;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IRerankerRunLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  rerankerKey: string;
  strategy: RerankerStrategy;
  modelKey?: string;
  query: string;
  inputCount: number;
  outputCount: number;
  latencyMs?: number;
  status: 'success' | 'error';
  errorMessage?: string;
  /** Optional caller context — 'rag' for embedded use, 'api' for client v1, 'dashboard' for playground. */
  source?: 'rag' | 'api' | 'dashboard';
  ragModuleKey?: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// ── Web Search types ────────────────────────────────────────────────────

/**
 * One executed search on a Web Search instance (a websearch-domain provider
 * record). Keyed by `searchKey` = the instance's provider key so logs are
 * viewable per instance in the dashboard.
 */
export interface IWebSearchRunLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  searchKey: string;
  driver: string;
  query: string;
  resultCount: number;
  latencyMs?: number;
  status: 'success' | 'error';
  errorMessage?: string;
  /** Caller context — 'api' for client v1, 'dashboard' for the playground. */
  source?: 'api' | 'dashboard';
  /** Synthesized answer returned with this run (AI or provider-native). */
  answer?: string;
  /** Returned results (capped + snippet-truncated) for log inspection. */
  results?: Array<{ title: string; url: string; snippet: string; position: number }>;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

// ── Alert types ─────────────────────────────────────────────────────────

export type AlertModule = 'models' | 'inference' | 'guardrails' | 'rag' | 'mcp' | 'analysis' | 'evaluation' | 'redteam' | 'aegis' | 'ai-app-gateway' | 'agents' | 'tools';

export type AlertMetric =
  // models
  | 'error_rate'
  | 'avg_latency_ms'
  | 'p95_latency_ms'
  | 'total_cost'
  | 'total_requests'
  // inference
  | 'gpu_cache_usage'
  | 'request_queue_depth'
  // guardrails
  | 'guardrail_fail_rate'
  | 'guardrail_avg_latency_ms'
  | 'guardrail_total_evaluations'
  // guardrail enforcement (over hook decisions in the window). These are the
  // renamed 'aegis_*' four below; the old strings CANNOT be dropped because
  // stored alert rules carry them in a `metric` column, so both spellings
  // resolve to the same collector for now.
  | 'guardrail_block_rate'
  /**
   * Vestigial: kept only so the rename of 'aegis_approval_rate' is total.
   * The approval rung has no store and nothing emits it, so it reports 0.
   */
  | 'guardrail_approval_rate'
  | 'guardrail_avg_risk_score'
  | 'guardrail_total_decisions'
  // rag
  | 'rag_avg_latency_ms'
  | 'rag_total_queries'
  | 'rag_failed_documents'
  // mcp
  | 'mcp_error_rate'
  | 'mcp_avg_latency_ms'
  | 'mcp_total_requests'
  // analysis (percentages, 0–100, averaged over completed runs in the window)
  | 'analysis_pass_rate'
  | 'analysis_avg_judge_score'
  | 'analysis_avg_accuracy'
  // evaluation (percentages, 0–100, averaged over completed runs in the window)
  | 'evaluation_pass_rate'
  | 'evaluation_avg_score'
  // red-team (percentages, 0–100, averaged over completed scans in the window)
  | 'redteam_attack_success_rate'
  | 'redteam_resilience_score'
  // aegis enforcement plane (over decisions in the window).
  // @deprecated Superseded by the 'guardrail_*' four above. Retained because
  // stored IAlertRule rows reference these strings; removing them would make
  // every existing rule fail validation.
  | 'aegis_block_rate'
  | 'aegis_approval_rate'
  | 'aegis_avg_risk_score'
  | 'aegis_total_decisions'
  // AI App Gateway (over requests logged in the window)
  | 'appgw_requests'
  | 'appgw_block_rate'
  | 'appgw_error_rate'
  | 'appgw_requests_per_user'
  // agents (entity_metrics; traced + hosted agents)
  | 'agent_sessions'
  | 'agent_error_rate'
  | 'agent_error_events'
  | 'agent_tool_error_rate'
  | 'agent_ai_error_rate'
  | 'agent_p95_duration_ms'
  | 'agent_avg_duration_ms'
  | 'agent_abandoned_rate'
  | 'agent_cost'
  | 'agent_tokens_per_session'
  // per-model health (entity_metrics)
  | 'model_requests'
  | 'model_error_rate'
  | 'model_p95_latency_ms'
  | 'model_avg_latency_ms'
  | 'model_cost'
  // per-knowledge-base health (entity_metrics)
  | 'kb_queries'
  | 'kb_error_rate'
  | 'kb_p95_latency_ms'
  | 'kb_avg_latency_ms'
  | 'kb_empty_result_rate'
  // per-MCP-server health (entity_metrics)
  | 'mcp_server_requests'
  | 'mcp_server_error_rate'
  | 'mcp_server_p95_latency_ms'
  // per-tool health (entity_metrics)
  | 'tool_calls'
  | 'tool_error_rate'
  | 'tool_p95_latency_ms';

export type AlertConditionOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq';

export type AlertConditionMode = 'threshold' | 'baseline' | 'absence' | 'slo_burn';

export interface IAlertBaselineConfig {
  direction: 'up' | 'down' | 'both';
  minRatio: number;
  minZ: number;
  minDelta: number;
  lookbackDays: number;
  seasonality: 'daily' | 'weekly' | 'trailing';
}

export interface IAlertAbsenceConfig {
  lookbackHours: number;
  minExpectedPerWindow: number;
}

export interface IAlertSloConfig {
  objectivePct: number;
  windowDays: number;
  burnRate: number;
  longWindowMinutes: number;
  shortWindowMinutes: number;
  latencyThresholdMs?: number;
}

export interface IAlertCondition {
  /** Threshold mode (existing); ignored by the other modes. */
  operator: AlertConditionOperator;
  threshold: number;
  /** Default 'threshold'. */
  mode?: AlertConditionMode;
  /** Pending duration before firing; default 0, max 1440. */
  forMinutes?: number;
  /** Default 1 (threshold/absence), 20 (baseline), 50 (slo_burn). */
  minSamples?: number;
  baseline?: IAlertBaselineConfig;
  absence?: IAlertAbsenceConfig;
  slo?: IAlertSloConfig;
}

/** `keys` required (1..50) when mode is 'selected'. */
export interface IAlertRuleEntityScope {
  entityType: EntityMetricType;
  mode: 'all' | 'selected';
  keys?: string[];
}

export type AlertRuleSeverity = 'auto' | IncidentSeverity;

/**
 * Who an email channel mails besides its listed recipients, resolved at send
 * time from the rule's project: `project_admins` = the project's admins (direct
 * memberships, admin group grants, legacy project admins).
 */
export type AlertEmailAudience = 'project_admins';

/** Stored channel shape. Every channel has a stable id ('ch_' + 12 hex), created server-side if missing. */
export type IAlertChannel =
  | { id?: string; type: 'email'; recipients: string[]; audience?: AlertEmailAudience }
  /** sealed = encryptObject({ url, secret? }) */
  | { id?: string; type: 'webhook'; urlHint: string; hasSecret: boolean; sealed: string }
  /** sealed = encryptObject({ url }) */
  | { id?: string; type: 'slack'; urlHint: string; sealed: string }
  /** sealed = encryptObject({ url }) */
  | { id?: string; type: 'teams'; urlHint: string; sealed: string }
  /** sealed = encryptObject({ routingKey }) */
  | { id?: string; type: 'pagerduty'; keyHint: string; sealed: string }
  /** Reference to a tenant channel library entry; resolved at dispatch time. */
  | { id?: string; type: 'library'; libraryId: string };

/** Input accepted by the API (plaintext only on write; omit secret fields to keep the stored ones for that channel id). */
export type AlertChannelInput =
  | { id?: string; type: 'email'; recipients: string[]; audience?: AlertEmailAudience }
  | { id?: string; type: 'webhook'; url?: string; secret?: string }
  | { id?: string; type: 'slack'; url?: string }
  | { id?: string; type: 'teams'; url?: string }
  | { id?: string; type: 'pagerduty'; routingKey?: string }
  | { id?: string; type: 'library'; libraryId: string };

/** A concrete (non-reference) channel: what a library entry stores. */
export type IAlertDeliverableChannel = Exclude<IAlertChannel, { type: 'library' }>;
export type AlertDeliverableChannelInput = Exclude<AlertChannelInput, { type: 'library' }>;

/** Tenant-level reusable channel (collection `alert_channel_library`); `config` holds sealed secrets. */
export interface IAlertChannelLibraryEntry {
  _id?: string;
  tenantId: string;
  name: string;
  kind: IAlertDeliverableChannel['type'];
  config: IAlertDeliverableChannel;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type AlertStatePhase = 'ok' | 'pending' | 'firing';

export interface IAlertState {
  _id?: string;
  tenantId: string;
  projectId: string;
  ruleId: string;
  /** '' = rule-level target (legacy single scope). */
  entityKey: string;
  entityType?: EntityMetricType | null;
  phase: AlertStatePhase;
  phaseSince: Date;
  breachStreak: number;
  okStreak: number;
  lastValue: number | null;
  lastBaseline: number | null;
  lastSampleCount: number;
  lastEvaluatedAt: Date;
  incidentId?: string | null;
  eventId?: string | null;
  firedAt?: Date | null;
  lastFiredAt?: Date | null;
  lastNotifiedAt?: Date | null;
  peakValue?: number | null;
  /** e.g. { licenseRequired: true }, { insufficientData: true }, baseline z/ratio. */
  detail?: Record<string, unknown> | null;
  updatedAt?: Date;
}

export interface IAlertStateFilter {
  ruleId?: string;
  ruleIds?: string[];
  projectId?: string;
  phases?: AlertStatePhase[];
  limit?: number;
}

export type AlertEventStatus = 'fired' | 'resolved' | 'acknowledged';

export interface IAlertRule {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  module: AlertModule;
  enabled: boolean;
  metric: AlertMetric;
  condition: IAlertCondition;
  windowMinutes: number;
  cooldownMinutes: number;
  scope?: {
    modelKey?: string;
    serverKey?: string;
    guardrailKey?: string;
    ragModuleKey?: string;
    mcpServerKey?: string;
  };
  /** Per-entity targeting for entity metrics (agents, models, KBs, MCP servers, tools). */
  entity?: IAlertRuleEntityScope;
  /** Default 'auto' (derived from the breach). */
  severity?: AlertRuleSeverity;
  notifyOnResolve?: boolean;
  renotifyMinutes?: number;
  channels: IAlertChannel[];
  lastTriggeredAt?: Date;
  /** Notifications are suppressed (and recorded as `suppressed` deliveries) until this instant; evaluation continues. */
  mutedUntil?: Date | null;
  mutedBy?: string | null;
  muteReason?: string | null;
  /** http(s) link to the team's runbook; shown on the rule's incidents. Not part of the evaluation shape. */
  runbookUrl?: string | null;
  /** Last evaluation summary (throttled writes) behind the derived "No data" state. */
  lastEvaluation?: IAlertRuleLastEvaluation | null;
  /** Set on rules added from a rule template: which template, at which version. Server-owned; cleared when the rule's metric or module changes. */
  template?: IAlertRuleTemplateRef | null;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAlertRuleTemplateRef {
  key: string;
  version: number;
}

export interface IAlertRuleLastEvaluation {
  at: Date;
  targets: number;
  noDataTargets: number;
}

export type AlertDeliveryTrigger = 'fire' | 'resolve' | 'renotify' | 'test';
export type AlertDeliveryStatus = 'sent' | 'failed' | 'suppressed';

/** One notification attempt on one channel (kept ~30 days). */
export interface IAlertDelivery {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  ruleId: string;
  incidentId?: string | null;
  eventId?: string | null;
  channelId: string;
  channelKind: string;
  channelName?: string | null;
  trigger: AlertDeliveryTrigger;
  status: AlertDeliveryStatus;
  /** `rule_muted` / `incident_snoozed` for suppressed rows, `channel_missing` for a failed delivery to a deleted library channel. */
  reason?: string | null;
  /** Already scrubbed by the channel; at most 500 characters. */
  error?: string | null;
  attemptAt: Date;
}

export interface IAlertEvent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  actualValue: number;
  status: AlertEventStatus;
  channels: Array<{
    type: string;
    target: string;
    success: boolean;
    error?: string;
  }>;
  firedAt: Date;
  resolvedAt?: Date;
  entityType?: EntityMetricType | null;
  entityKey?: string | null;
  baselineValue?: number | null;
  sampleCount?: number;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
  kind?: 'fired' | 'resolved';
  metadata?: Record<string, unknown>;
}

// ── Tool (unified tool system) types ─────────────────────────────────────

export type ToolSourceType = 'openapi' | 'mcp';
export type ToolStatus = 'active' | 'disabled';

export type ToolAuthType = 'none' | 'token' | 'header' | 'basic';

export interface IToolAuthConfig {
  type: ToolAuthType;
  /** For 'token': the bearer token value */
  token?: string;
  /** For 'header': custom header name + value */
  headerName?: string;
  headerValue?: string;
  /** For 'basic': username + password */
  username?: string;
  password?: string;
  /**
   * AES-256-GCM ciphertext (base64) holding `token`/`headerValue`/`password`
   * once sealed for storage — see `@/lib/services/tools/secretVault`. Only
   * ever set by that module's own `sealAuthConfig`/`mergeAuthConfigUpdate`;
   * never trust a `sealed` value handed in from outside the service layer.
   */
  sealed?: string;
}

export interface IToolAction {
  /** Unique key within the tool (slug of operationId or tool name) */
  key: string;
  name: string;
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: Record<string, unknown>;
  /** How this action is executed */
  executionType: 'openapi_http' | 'mcp_call';
  /** OpenAPI-specific: HTTP method */
  httpMethod?: string;
  /** OpenAPI-specific: Path template */
  httpPath?: string;
  /** MCP-specific: original tool name on the MCP server */
  mcpToolName?: string;
}

export interface ITool {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  type: ToolSourceType;
  status: ToolStatus;
  /** Actions (callable tools) derived from the source */
  actions: IToolAction[];
  /** OpenAPI-specific: raw spec JSON string */
  openApiSpec?: string;
  /** Upstream base URL for HTTP calls */
  upstreamBaseUrl?: string;
  /** Authentication for upstream API / MCP server */
  upstreamAuth?: IToolAuthConfig;
  /** MCP-specific: MCP server endpoint URL */
  mcpEndpoint?: string;
  /** MCP-specific: transport type */
  mcpTransport?: 'sse' | 'streamable-http';
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Tool Request Log types ────────────────────────────────────────────────

export interface IToolRequestLog extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  toolKey: string;
  actionKey: string;
  actionName: string;
  status: 'success' | 'error';
  requestPayload?: Record<string, unknown>;
  responsePayload?: Record<string, unknown>;
  errorMessage?: string;
  latencyMs?: number;
  callerType?: 'dashboard' | 'api' | 'agent';
  callerTokenId?: string;
  createdAt?: Date;
}

export interface IToolRequestAggregate {
  toolKey: string;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  avgLatencyMs: number | null;
  actionBreakdown: Record<string, number>;
  timeseries?: Array<{
    period: string;
    total: number;
    success: number;
    errors: number;
  }>;
}

// ── Agent types ──────────────────────────────────────────────────────────

export type AgentStatus = 'active' | 'inactive' | 'draft';

/** How an agent is backed: a native model-config agent, or a connected external endpoint. */
export type AgentKind = 'native' | 'external';

/** Wire protocol used to reach an external (connected) agent. */
export type ExternalAgentProtocol = 'a2a' | 'openai-chat' | 'openai-responses';

/**
 * Connection settings for a connected (external) agent. The agent is invoked over
 * HTTP using the selected protocol instead of being run through the local agent-sdk.
 */
export interface IExternalAgentConnection {
  protocol: ExternalAgentProtocol;
  /** Endpoint URL — OpenAI base URL, A2A agent endpoint, or an explicit responses URL. */
  url: string;
  /** Model id sent in the request body (openai-chat / openai-responses). */
  model?: string;
  /** Static headers added to every outbound request. */
  headers?: Record<string, string>;
  /** Inline bearer token / API key, AES-encrypted at rest. Never returned to clients. */
  apiKeyEnc?: string;
  /** Provider key holding encrypted credentials for the endpoint (alternative to inline key). */
  credentialProviderKey?: string;
  /** Dot-path used to pull the assistant text out of a non-standard JSON response. */
  responsePath?: string;
  /**
   * Opt-in policy for caller-supplied runtime header passthrough. Absent or
   * `allow: false` means caller headers never reach this endpoint.
   */
  runtimeHeaders?: { allow?: boolean; allowedNames?: string[] };
}

// ── Agent runtime configuration (agent-sdk surface) ──────────────────────
//
// Every field below is optional and absent by default: an agent that has never
// been touched in the Advanced settings tab produces exactly the option object
// the module used to hard-code, so this is a pure widening of the config.

export type AgentRuntimeProfile = 'fast' | 'balanced' | 'deep' | 'research';
export type AgentPlanningMode = 'off' | 'todo' | 'planner_executor' | 'reasoning_then_tools';
export type AgentReplanPolicy = 'never' | 'on_failure' | 'on_conflict' | 'every_n_steps';
export type AgentContextPolicy = 'raw' | 'summary_only' | 'hybrid';
export type AgentToolResponsePolicy = 'keep_full' | 'keep_structured' | 'summarize_archive' | 'drop';
export type AgentChildContextPolicy = 'minimal' | 'scoped' | 'full';
export type AgentSubagentMode = 'off' | 'registry_only' | 'registry_and_adhoc';
export type AgentMemoryScope = 'session' | 'user' | 'workspace' | 'tenant';
export type AgentMemoryWritePolicy = 'manual' | 'auto_important' | 'always';
export type AgentMemoryReadPolicy = 'recent_only' | 'semantic' | 'hybrid';
export type AgentReasoningLevel = 'minimal' | 'low' | 'medium' | 'high';
export type AgentReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface IAgentLimits {
  maxToolCalls?: number;
  maxParallelTools?: number;
  maxContextTokens?: number;
  maxTotalOutputTokens?: number;
  /** Requires a cost estimator on the run; ignored when none is wired. */
  maxCostUsd?: number;
  maxWallClockMs?: number;
}

export interface IAgentSummarizationConfig {
  enable?: boolean;
  maxTokens?: number;
  summaryTriggerTokens?: number;
  summaryPromptMaxTokens?: number;
  summaryMode?: 'incremental' | 'full_rewrite';
  integrityCheck?: boolean;
}

export interface IAgentContextConfig {
  policy?: AgentContextPolicy;
  lastTurnsToKeep?: number;
  toolResponsePolicy?: AgentToolResponsePolicy;
}

export interface IAgentPlanningConfig {
  mode?: AgentPlanningMode;
  replanPolicy?: AgentReplanPolicy;
  everyNSteps?: number;
}

export interface IAgentContextPilotConfig {
  enabled?: boolean;
  /** Tool names ContextPilot must never compress (raw payload always kept). */
  excludeTools?: string[];
}

export interface IAgentReasoningConfig {
  enabled?: boolean;
  level?: AgentReasoningLevel;
  /** Provider-native effort. `none` is a value that gets SENT, not "off". */
  effort?: AgentReasoningEffort;
  budgetTokens?: number;
  includeThoughts?: boolean;
  /** SDK reflection pass. Absent = SDK default; `false` disables it. */
  reflection?: boolean;
}

/**
 * Memory backing for an agent — routed through console's OWN memory module
 * (vector-backed stores manageable at `/dashboard/memory`), not a bare
 * SDK-provider string: an operator picks a STORE, the same one the Memory
 * module itself lists.
 *
 * At run time this resolves to a `MemoryStore` implementation
 * (`agentMemoryAdapter.ts`) backed by `recallForChat`/`addMemory` on that
 * store, passed as `memory.store` to the SDK — so the SDK's own structured
 * summarization pipeline (`writeSummaryFactsToMemory`) is what decides what
 * gets remembered, not a bespoke heuristic here.
 */
export interface IAgentMemoryConfig {
  enabled?: boolean;
  /** Key of an existing `IMemoryStore` (from the Memory module). Required when enabled. */
  memoryStoreKey?: string;
  /**
   * One or more stores ("mounts") the agent reads from / writes into. Several
   * agents mounting the same store (+ a shared scope) share memory. When set
   * this wins over the legacy `memoryStoreKey`; the FIRST mount is the primary
   * store for the SDK's pre-injected recall and summary writes.
   */
  mounts?: IAgentMemoryMount[];
  scope?: AgentMemoryScope;
  writePolicy?: AgentMemoryWritePolicy;
  readPolicy?: AgentMemoryReadPolicy;
  /**
   * Whether the agent also gets memory as callable tools.
   *
   * The SDK gives it neither: recall is pre-injected as a system message and
   * writes only happen when a compaction produces a summary, so an agent can
   * neither look something up nor record what it was just told. `agentMemoryTools.ts`
   * adds `memory_search` / `memory_write` / `memory_forget` over the same store.
   *
   * Defaults to 'readwrite' when memory is enabled — being told to remember
   * something and silently not doing so is the worse surprise.
   */
  tools?: AgentMemoryToolMode;
}

export interface IAgentMemoryMount {
  /** Key of an existing `IMemoryStore`. */
  storeKey: string;
  /** Default 'read_write'. A read_only mount is never written to or forgotten from. */
  access?: 'read_write' | 'read_only';
  /** What this store is for — shown to the model ("Use for: ..."). */
  description?: string;
  /** Overrides `memory.scope` for this mount. */
  scope?: AgentMemoryScope;
}

/** 'read' drops the write/forget tools, for a curated store the agent must not pollute. */
export type AgentMemoryToolMode = 'off' | 'read' | 'readwrite';

/**
 * A reusable capability the model can discover and open on demand —
 * Anthropic-style progressive disclosure (see agent-sdk's `Skill` type).
 *
 * Deliberately NOT the SDK's file-based `SKILL.md` loader
 * (`loadSkillsFromDisk`/`SkillFs`): there is no filesystem to scan here, a
 * skill is a console-managed record like a Prompt, edited in the dashboard
 * and referenced by key from `IAgentConfig.skills`. `agentSkillService.ts`
 * builds the SDK's `Skill` objects directly from these fields — `header` is
 * what the model always sees in its catalog, `body` is returned only once
 * the model opens the skill.
 */
export interface IAgentSkill {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  title: string;
  /** One-line "what it does + when to use it" — always in the model's catalog. */
  header: string;
  /** Full instructions, disclosed only once the model opens this skill. */
  body: string;
  /** Hide this skill from a small-tier model — see agent-sdk's `SkillModelTier`. */
  minModelTier?: 'small' | 'large';
  status: 'active' | 'inactive';
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IAgentSkillPolicy {
  /** Max distinct skills open at once. SDK default: unbounded-ish; console default applied at resolve time. */
  maxOpenSkills?: number;
  maxBoundToolsPerSkill?: number;
  maxBoundToolsTotal?: number;
  /** 'catalog' (default): every header in the system prompt. 'search': a `search_skills` tool instead. */
  disclosure?: 'catalog' | 'search';
}

export interface IAgentToolResponsesConfig {
  defaultPolicy?: AgentToolResponsePolicy;
  maxToolResponseChars?: number;
  maxToolResponseTokens?: number;
  retentionByTool?: Record<string, AgentToolResponsePolicy>;
}

/**
 * Advanced runtime knobs, surfaced in the Settings → Advanced tab. Basic
 * settings (model, prompt, temperature, tools) stay on `IAgentConfig` itself.
 */
export interface IAgentRuntimeConfig {
  profile?: AgentRuntimeProfile;
  limits?: IAgentLimits;
  planning?: IAgentPlanningConfig;
  summarization?: IAgentSummarizationConfig;
  context?: IAgentContextConfig;
  toolResponses?: IAgentToolResponsesConfig;
  contextPilot?: IAgentContextPilotConfig;
  /**
   * Only `reflection` is live. The rest moved next to the model
   * (`IAgentConfig.reasoningEffort`); old values are migrated on read and on
   * save (`migrateAgentReasoning`).
   */
  reasoning?: IAgentReasoningConfig;
  /**
   * @deprecated IGNORED. Used to expose the SDK's `ask_user_question` tool,
   * but no console channel can deliver the answer back: the agent paused on a
   * question nobody could see, and the conversation stayed locked. Kept on the
   * type only because stored configs may still carry it.
   */
  askUser?: boolean;
}

/** JSON-schema contract enforced on the agent's final answer. */
export interface IAgentStructuredOutput {
  enabled?: boolean;
  /** Schema name surfaced to the provider. Defaults to `<agentKey>_output`. */
  name?: string;
  /** JSON Schema (draft-07 subset); converted to a zod schema at runtime. */
  schema?: Record<string, unknown>;
  /** Forbid extra properties and require every declared property. */
  strict?: boolean;
}

/**
 * A sub-agent the orchestrator may delegate to. Two flavours:
 *  - `inline` — defined here, inside this agent's config
 *  - `ref`    — points at another console agent, whose config is loaded at run time
 */
export interface IAgentSubagent {
  kind: 'inline' | 'ref';
  /** `delegate_to` name. Must be unique within the agent. */
  name: string;
  title?: string;
  /** One-line "what it does + when to use it", shown in the delegation catalog. */
  header: string;
  /** inline only — role/system prompt for the child. */
  systemPrompt?: string;
  /** inline only — model override; falls back to the parent's model. */
  modelKey?: string;
  /** inline only — tool surface for the child. */
  toolBindings?: IAgentToolBinding[];
  /** inline only — knowledge engine attached to the child. */
  knowledgeEngineKey?: string;
  /** ref only — key of the console agent backing this sub-agent. */
  agentKey?: string;
  /** ref only — pin to a published version; absent = the published version. */
  agentVersion?: number;
  limits?: IAgentLimits;
  childContextPolicy?: AgentChildContextPolicy;
  /** JSON Schema for the child's structured result. */
  outputSchema?: Record<string, unknown>;
  /** Absent or true = available to the orchestrator. */
  enabled?: boolean;
}

export interface IAgentSubagentPolicy {
  mode?: AgentSubagentMode;
  maxDepth?: number;
  maxChildCalls?: number;
  maxParallel?: number;
  childContextPolicy?: AgentChildContextPolicy;
  allowAdhocTools?: boolean;
}

/** Where a run's result is POSTed (`IAgentConfig.callback`). */
export interface IAgentCallbackConfig {
  url?: string;
  /** Write-only HMAC secret: plaintext in, masked out. */
  secret?: string;
  /** Sealed `secret`; never returned by the API. */
  secretSealed?: string;
}

/**
 * Class of an agent run. `default` is interactive and counts against the
 * tenant's active cap; `deferred` is low priority, queued on its own and
 * managed by its own caps.
 */
export type AgentRunClass = 'default' | 'deferred';

/** Per-request structured output of a run (Responses `text.format`, chat `response_format`, runs API). */
export interface AgentResponseFormat {
  type: 'json_schema' | 'json_object';
  /** json_schema only; default 'response'. */
  name?: string;
  /** json_schema only; draft-07 subset (the converter `config.structuredOutput` uses). */
  schema?: Record<string, unknown>;
  strict?: boolean;
}

/** One declared input of an agent (`IAgentConfig.inputs`). */
export interface IAgentInputField {
  /** `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, unique within the agent. */
  name: string;
  label?: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'json';
  enum?: Array<string | number>;
  required?: boolean;
  default?: unknown;
}

/**
 * Files a user attaches to a session (the composer's paperclip, the client
 * API's `input_file` / `input_image`). Every field is a stored setting; absent
 * limits take the defaults in `SESSION_FILES_DEFAULTS` (sessionFilesConfig.ts).
 *
 * Off unless switched on, and on only with a bucket to keep the files in: the
 * files are ordinary Document Store files in the bucket the agent names — there
 * is no built-in fallback storage, and nothing is ever written to the server's
 * own disk unless the operator chose a local-disk bucket on purpose.
 */
export interface IAgentAttachmentsConfig {
  /** true = the agent takes attachments (needs `bucketKey`). Default false. */
  enabled?: boolean;
  /**
   * Files the agent writes itself (`session_files_create` / `session_files_append`),
   * stored in the same bucket. Default ON when the agent has a `bucketKey`.
   */
  outputs?: {
    enabled?: boolean;
    /** Most files one turn may create. */
    maxFilesPerTurn?: number;
    /** Largest generated file, MB. */
    maxFileSizeMb?: number;
  };
  /** Most files one session may hold. Default 10. */
  maxFiles?: number;
  /** Largest single file, MB. Default 20. */
  maxFileSizeMb?: number;
  /** MIME types accepted (`image/*` allowed); empty / absent = anything convertible. */
  allowedMimeTypes?: string[];
  /** A message's attachments are put in the user turn when their text is at most this many tokens (estimated chars/4); otherwise the agent reads them in pages. Default 30000. */
  inlineMaxTokens?: number;
  /** Characters per page of `session_files_read`. Default 20000. */
  readPageChars?: number;
  /** Days a file lives after upload before the cleanup removes it. Default 30. */
  retentionDays?: number;
  /** Bucket of the agent's project the files are stored in. Required when `enabled`. */
  bucketKey?: string;
  /** Root folder inside the bucket; a file lands in `<folder>/<agentKey>/<sessionId>/…`. Default `agent-sessions`. */
  folder?: string;
  /** Files uploaded to a session that no message has carried yet ride along with the next message. Default true. */
  attachNewUploads?: boolean;
  /**
   * Most images ONE model request carries. Images travel as references and are
   * read from the bucket at the model call; beyond this the oldest ones become a
   * text placeholder naming the file (the agent can look again with
   * `session_files_view_image`). Default 6.
   */
  maxImages?: number;
  /** Most image bytes (before base64) one model request carries, oldest dropped first. Default 12000000. */
  maxBytes?: number;
  /**
   * How many of the person's most recent image-bearing messages are shown again
   * with a new message when the agent's own context window no longer holds them.
   * 0 = never re-attach. Default 2.
   */
  carryRecentImages?: number;
}

/** One extra model an agent offers next to its main one. */
export interface IAgentAdditionalModel {
  modelKey: string;
  /** What a picker shows; the model's name when omitted. */
  label?: string;
  description?: string;
  /** Reasoning effort when a run uses THIS model. Unset = the Model Hub default, then the request, then nothing. */
  reasoningEffort?: AgentReasoningEffort;
  /** Token budget for engines that think in tokens (Anthropic, Bedrock, Vertex). */
  reasoningBudgetTokens?: number;
}

export interface IAgentKnowledgeBinding {
  /** RAG module key */
  key: string;
  /** Tells the model when to search this knowledge base. */
  description?: string;
  topK?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  /** Defaults to true. */
  enabled?: boolean;
}

export interface IAgentConfig {
  /** Required for native agents; omitted/empty for connected (external) agents. */
  modelKey?: string;
  /** Reasoning effort of the main model. Unset = Model Hub default, then the API request, then nothing. */
  reasoningEffort?: AgentReasoningEffort;
  /** Token budget of the main model for engines that think in tokens. */
  reasoningBudgetTokens?: number;
  /**
   * Whether reasoning text is handed back (API responses, session events and
   * messages, Studio chat). Default true; false hides it everywhere except the
   * operator's playground view. Tokens are counted either way.
   */
  showReasoning?: boolean;
  /**
   * Further models a caller may pick for a run (`model` on the client API, `agent_model` on the
   * OpenAI-compatible surfaces). Max 10, unique, never the main `modelKey`. The main model is
   * always usable; a caller may pick any of them (see `resolveAgentRunModel`).
   */
  additionalModels?: IAgentAdditionalModel[];
  systemPrompt?: string;
  promptKey?: string;
  /**
   * Static values for the `{{placeholders}}` in `promptKey`'s template (or in
   * an inline `systemPrompt`). A caller can override any of these per run via
   * `runtimeContext.metadata`; `agent`, `now` and `user` are reserved and
   * always win.
   *
   * Declaring any variable here also switches on Mustache rendering for an
   * inline `systemPrompt`, which is otherwise left untouched so a prompt
   * containing literal braces keeps working.
   */
  promptVariables?: Record<string, string>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** RAG module key – attached as a retrieval tool. Legacy single binding; `knowledgeBindings` wins when both are set. */
  knowledgeEngineKey?: string;
  /** Several knowledge bases attached to this agent. */
  knowledgeBindings?: IAgentKnowledgeBinding[];
  /** 'combined' (default): one search tool over all KBs. 'separate': one tool set per KB. */
  knowledgeToolMode?: 'combined' | 'separate';
  /**
   * Multi-guardrail binding. AUTHORITATIVE when present: the two deprecated
   * single-slot keys below are then ignored, not merged — see
   * `resolveBindings()` in `@/lib/services/guardrail/hooks/binding` for why
   * merging would double-run (and so double-log and double-bill) a guardrail
   * an operator moved into the array.
   *
   * Lives inside `config`, alongside the slots it replaces, so it rides the
   * agent's existing `config` JSON column on both backends and appears in the
   * version snapshot without a schema change.
   */
  guardrails?: IGuardrailBinding[];
  /**
   * Guardrail key applied to user input.
   * @deprecated Use `guardrails`. Still READ (as the fallback when `guardrails`
   * is absent) and still WRITTEN for one release, so an older console binary
   * on the same tenant database keeps enforcing.
   */
  inputGuardrailKey?: string;
  /**
   * Guardrail key applied to assistant output.
   * @deprecated Use `guardrails`. See `inputGuardrailKey`.
   */
  outputGuardrailKey?: string;
  /** Bound tools from various sources (tools, MCP servers legacy) */
  toolBindings?: IAgentToolBinding[];
  /** Agent backing kind. Defaults to 'native' when omitted. */
  kind?: AgentKind;
  /** Connection settings — present only when kind === 'external'. */
  connection?: IExternalAgentConnection;
  /** Advanced agent-sdk runtime knobs (Settings → Advanced). */
  runtime?: IAgentRuntimeConfig;
  /** JSON-schema contract for the final answer. */
  structuredOutput?: IAgentStructuredOutput;
  /** Delegable sub-agents — inline definitions and references to other agents. */
  subagents?: IAgentSubagent[];
  /** Guards around delegation. Absent = SDK defaults with `registry_only`. */
  subagentPolicy?: IAgentSubagentPolicy;
  /** Skills this agent can discover and open — keys into the project's skill library. */
  skills?: string[];
  skillPolicy?: IAgentSkillPolicy;
  /** Memory — its own tab (Settings → Advanced stays about the loop, not what the agent remembers). */
  memory?: IAgentMemoryConfig;
  /** Sandbox access — an isolated machine the agent can run commands in (Enterprise). */
  sandbox?: IAgentSandboxConfig;
  /**
   * Callback for runs started without their own `callback_url` (every dialect,
   * routines included). The secret is write-only: plaintext in, masked out;
   * only the sealed form is stored.
   */
  callback?: IAgentCallbackConfig;
  /**
   * Default spend budget of a session of this agent (copied to each session when
   * it starts). Absent = sessions have no budget; the per-turn
   * `runtime.limits.maxCostUsd` is separate and unchanged.
   */
  budget?: IAgentSessionBudget & {
    /**
     * May an API client remove this budget or raise it past `maxCostUsd`
     * (session create / `PATCH`)? Default false: the budget the admin set binds
     * the integration it is meant to constrain. Dashboard users are not affected.
     */
    allowClientOverride?: boolean;
  };
  /**
   * Declared inputs of the agent (a form for a human, a validated object for an
   * API / routine caller). Absent = the agent takes free text only. At most 32.
   */
  inputs?: IAgentInputField[];
  /**
   * Human in the loop: tool approvals and questions to the user. Absent (every
   * agent created before this existed) = nothing ever pauses.
   */
  humanInTheLoop?: IAgentHumanInTheLoopConfig;
  /** Files users may attach to a session. Absent = not accepted. */
  attachments?: IAgentAttachmentsConfig;
  /**
   * Tools the agent calls but the CALLER runs: a portal's host page, or the
   * integrating backend (answers on the actions endpoint or from the agent's
   * callback). The model sees them like any tool; a call pauses the turn as a
   * `client_tool` pending action. Absent = none.
   */
  clientTools?: IAgentClientToolConfig[];
  /**
   * Where the client tools are offered. Each surface defaults to ON (absent = on);
   * `false` keeps the tools away from that surface. Nothing else ever gets them:
   * not A2A, MCP, realtime, schedules, evaluations, a non-embedded portal chat,
   * or a call with no session to pause.
   */
  clientToolSurfaces?: IAgentClientToolSurfaces;
}

/** The surfaces an agent's client tools can be offered on (`IAgentConfig.clientToolSurfaces`). */
export interface IAgentClientToolSurfaces {
  /** The client API: sessions, `/agents/responses`, background runs, chat completions. Their callers answer on the actions endpoint (or reply with `tool` messages). */
  api?: boolean;
  /** The dashboard playground: the person testing answers on the call's card, or an external system answers through the API. */
  playground?: boolean;
  /** A portal embedded in a host page: the page runs the tool. */
  portal?: boolean;
}

/** One tool the agent's caller runs (see `IAgentConfig.clientTools`). */
export interface IAgentClientToolConfig {
  /** The name the model calls; letters, digits and `_`, at most 64. */
  name: string;
  description: string;
  /** JSON Schema of the arguments (an object schema). Absent = an object with any properties. */
  inputSchema?: Record<string, unknown>;
  /** How long the caller may take. Default 60, at most 600. */
  timeoutSeconds?: number;
  /** false = declared but switched off. Default true. Approval is managed under Approvals & questions (`humanInTheLoop.toolApproval.tools`). */
  enabled?: boolean;
}

/** Whether a tool call waits for a person first. */
export type AgentToolApprovalPolicy = 'always' | 'never';

/**
 * What an approval-gated tool call or an ask-user question does on a run that
 * has no interactive user (a schedule, an evaluation or red-team case, an
 * OpenAI-shaped client):
 *  - `deny` (default): the call returns an error result to the model and never
 *    runs; the run continues. The ask-user tool is not offered.
 *  - `pause`: behaves as an attended run — the turn stops and the request waits
 *    for someone to answer it from Studio.
 *  - `allow`: the call runs without approval. An explicit owner opt-in only.
 */
export type AgentHitlUnattendedPolicy = 'deny' | 'pause' | 'allow';

/**
 * Human-in-the-loop settings of an agent. Every behaviour choice is a stored
 * setting (the Configure → "Approvals & questions" section), never a constant.
 */
export interface IAgentHumanInTheLoopConfig {
  /** Let the model ask the user a structured question mid-run. */
  askUser?: { enabled: boolean; /** Default true. */ allowFreeText?: boolean };
  toolApproval?: {
    enabled: boolean;
    /** Policy for every tool not named in `tools` and not read-only. Default `always`. */
    defaultPolicy?: AgentToolApprovalPolicy;
    /** Per-tool override; the key is the tool name as the model sees it. */
    tools?: Record<string, AgentToolApprovalPolicy>;
  };
  /** Minutes a request waits before `onTimeout` applies. Default 1440; 0 = never expires. */
  timeoutMinutes?: number;
  /** What a timeout does. `deny` (default) denies and lets the agent continue; `cancel` drops the request. */
  onTimeout?: 'deny' | 'cancel';
  /** Who may answer. Default `owner_or_admin`. */
  approvers?: 'owner' | 'owner_or_admin' | 'project_members';
  /** A new message while a request is open. `reject` (default) answers 409; `cancel_pending` cancels the request and proceeds. */
  onUserMessageWhilePending?: 'reject' | 'cancel_pending';
  /** Runs with nobody to answer (schedules, API bridges, evaluations). Default `deny`. */
  unattended?: AgentHitlUnattendedPolicy;
}

/**
 * How long an agent's sandbox lives.
 *  - `session` (default): one sandbox per conversation, kept running between
 *    turns — files and installed packages carry over. Every use extends its
 *    life; the sandbox module shuts it down (and deletes it) once it has been
 *    idle for its own idle timeout, or it goes with the conversation. A later
 *    message then gets a fresh one. Without a conversation (a stateless call)
 *    there is nothing to keep it against, so it lasts one message.
 *  - `ephemeral`: a fresh sandbox per message (run), created on the first
 *    sandbox tool call and deleted when the run ends. Nothing carries over.
 *  - `persist`: the former name of `session`, still accepted as such.
 */
export type AgentSandboxMode = 'session' | 'ephemeral' | 'persist';

/**
 * Gives an agent a sandbox (the enterprise Agent Runtime Sandbox module) and
 * the tools to use it: run a command, run code, read/write/list files.
 *
 * `secrets` are write-only. On save they are sealed into `secretsSealed`
 * (AES-256-GCM) and the plaintext is dropped; every read returns the keys
 * with a masked value. At run time they are decrypted and passed as
 * environment variables to each command — never stored on the sandbox
 * instance — and scrubbed from what the tools return to the model.
 */
/** A file the operator preloads into the agent's sandbox (see docs/guide/sandbox.md). */
export interface IAgentSandboxSeedFile {
  id: string;
  /** Original file name. */
  name: string;
  /** Absolute destination path in the sandbox, including the file name. */
  path: string;
  /** Where the bytes live: a Document Store file under `agent-assets/<agentKey>/`. */
  fileRef: { bucketKey: string; objectKey: string };
  size: number;
  mimeType?: string;
  /** SHA-256 of the bytes; lets a reused sandbox skip an unchanged file. */
  sha256?: string;
  /** Octal file mode, e.g. `0644`. Default `0644`. */
  mode?: string;
}

export interface IAgentSandboxConfig {
  enabled?: boolean;
  /** Files written into the sandbox when it starts, before the agent works. */
  seedFiles?: IAgentSandboxSeedFile[];
  /** Sandbox template key. Absent → the tenant's default (`multi-base`). */
  templateKey?: string;
  /** Default `session`. */
  mode?: AgentSandboxMode;
  /** Per-command timeout. Default 60, max 600. */
  commandTimeoutSec?: number;
  /** @deprecated No longer used — a session sandbox closes by the sandbox module's idle timeout. Still accepted so saved configs load. */
  retentionHours?: number;
  resources?: { cpuCores?: number; memoryMb?: number };
  /** Cut the sandbox off from the network. */
  blockNetwork?: boolean;
  /** Plain (non-secret) environment variables. */
  env?: Record<string, string>;
  /** Secret environment variables — write-only, see above. */
  secrets?: Record<string, string>;
  /** Sealed form of `secrets`; never leaves the server. */
  secretsSealed?: string;
  /** Set on agent reads only (never stored): secrets are stored but cannot be decrypted, see `agentSandboxSecrets.ts`. */
  secretsUnreadable?: boolean;
  /** Which tool groups to give the agent. All on by default. */
  tools?: { exec?: boolean; code?: boolean; files?: boolean };
  /**
   * Preview: lets the agent serve something from its sandbox (a web app, a
   * report, a dashboard on a port) and hand out a link to it with the
   * `sandbox_preview_link` tool.
   *
   * A machine the agent issued a link for is NOT stopped/deleted when the
   * reply ends — the link would die with it. It keeps running while the
   * preview is used and is stopped after `keepAliveMinutes` without activity
   * (and deleted).
   */
  preview?: {
    enabled?: boolean;
    /**
     * Public links: a signed URL anyone with the link can open, for
     * `linkTtlHours` (needs SANDBOX_PREVIEW_SECRET on the server). Otherwise
     * links open only for signed-in console users with sandbox access.
     */
    public?: boolean;
    /** Public link lifetime. Default 24, max 168. */
    linkTtlHours?: number;
    /** Idle time after which a previewed machine is stopped. Default 30. */
    keepAliveMinutes?: number;
  };
}

/** A single tool-source binding for an agent */
export interface IAgentToolBinding {
  /** Source type – 'tool' (unified), 'mcp' (legacy), or 'system' (built-in like browser_use) */
  source: 'tool' | 'mcp' | 'system';
  /** Identifier of the source (tool key, MCP server key, or system tool key) */
  sourceKey: string;
  /** Action/tool names selected from that source */
  toolNames: string[];
  /** Optional configuration for the binding (e.g. { browserId } for system browser_use) */
  config?: Record<string, unknown>;
}

/** The sender an incoming webhook is set up for (its event / delivery id headers and auth choices). */
export type AgentRoutineWebhookPreset = 'github' | 'gitlab' | 'azure_devops' | 'generic';

/**
 * How a delivery proves it knows the routine's secret. The first three sign
 * the raw body (checked once the body is read); the rest carry the secret in a
 * header (checked before the body is read).
 */
export type AgentRoutineWebhookAuth =
  /** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(secret, raw body)>`. */
  | 'github_signature'
  /** Standard Webhooks: `webhook-id` / `webhook-timestamp` / `webhook-signature: v1,<base64>`; the sender's `whsec_` secret. */
  | 'standard_webhooks'
  /** `x-cognipeer-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. */
  | 'signature'
  /** `X-Gitlab-Token: <secret>`. */
  | 'gitlab_token'
  /** `Authorization: Bearer <secret>`. */
  | 'bearer'
  /** `Authorization: Basic base64(<any user>:<secret>)`. */
  | 'basic'
  /** `<headerName>: <secret>`. */
  | 'header';

/** One filter rule over the delivery (all rules must match). */
export interface AgentRoutineWebhookFilterRule {
  /** `payload.action`, `payload.pull_request.labels.*.name`, `headers.x-github-event`, `event`. */
  path: string;
  op: 'eq' | 'neq' | 'in' | 'not_in' | 'exists' | 'not_exists' | 'contains' | 'starts_with' | 'glob';
  value?: string | number | boolean | Array<string | number | boolean>;
}

/**
 * The settings of a `webhook` routine: each authenticated, matching delivery to
 * its URL fires the routine. Stored in the routine's `webhook` object.
 */
export interface AgentRoutineWebhook {
  /** `wh_` + 18 random bytes (base64url): the URL's locator. Kept while the routine stays a webhook one; never reused. */
  hookId: string;
  preset: AgentRoutineWebhookPreset;
  auth: AgentRoutineWebhookAuth;
  /** Auth `header` only; lower-case. */
  headerName?: string | null;
  /** `encryptObject(secret)`; never serialized. */
  secretSealed: string;
  /** The secret's last 4 characters. */
  secretHint: string;
  /** `provided` only with `standard_webhooks` (the sender generates that secret). */
  secretSource: 'generated' | 'provided';
  /** The secret before the last rotation, accepted until `previousSecretExpiresAt`. */
  previousSecretSealed?: string | null;
  previousSecretExpiresAt?: Date | null;
  /** Normalized event names to accept; empty / absent = every event. */
  events?: string[] | null;
  /** All must match (≤ 20). */
  filter?: AgentRoutineWebhookFilterRule[] | null;
  /** Append the event payload (JSON) to the message. */
  includePayload: boolean;
}

/** The settings of a `schedule` routine: a 5-field cron expression evaluated in an IANA timezone (default 'UTC'). */
export interface AgentRoutineSchedule {
  cron: string;
  timezone: string;
}

/** The settings of a `once` routine: one run at a fixed time. */
export interface AgentRoutineOnce {
  runAt: Date;
}

/** What starts a routine's runs. */
export type AgentRoutineType = 'schedule' | 'once' | 'manual' | 'webhook';

/**
 * A routine's type and the ONE settings object named after it (`manual` has
 * none): a union on `type`, the same shape the API shows and both stores keep.
 * The other types' objects are absent.
 */
export type AgentRoutineTypeSettings =
  | { type: 'schedule'; schedule: AgentRoutineSchedule }
  | { type: 'once'; once: AgentRoutineOnce }
  /** Only started on request (Run now, `POST …/routines/{id}/run`). */
  | { type: 'manual' }
  | { type: 'webhook'; webhook: AgentRoutineWebhook };

export type AgentRoutineDeliveryOutcome =
  'accepted' | 'duplicate' | 'filtered' | 'ignored' | 'unauthorized' | 'rejected' | 'failed';

/**
 * One request to a routine's webhook URL, as its delivery log keeps it: the
 * outcome and normalized ids only — never the payload, headers or a secret.
 */
export interface IAgentRoutineDelivery {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  routineId: string;
  receivedAt: Date;
  /** `receivedAt` + 7 days; the reconciler's retention removes it after. */
  expiresAt: Date;
  outcome: AgentRoutineDeliveryOutcome;
  httpStatus: number;
  event?: string | null;
  deliveryId?: string | null;
  runId?: string | null;
  /** A fixed reason text (≤ 300 chars); never payload text. */
  reason?: string | null;
  bytes: number;
}

/** The fields every routine has, whatever starts it (see `IAgentRoutine`). */
export interface IAgentRoutineBase {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  /** The message each fire sends (≤ 32k chars). */
  prompt: string;
  inputs?: Record<string, unknown> | null;
  /** A pinned published version; null/absent = the published one. */
  version?: number | null;
  runClass: AgentRunClass;
  /** Copied onto each run. */
  metadata?: Record<string, string> | null;
  /** Where each run's result is POSTed; the secret is sealed and never serialized. */
  callback?: { url: string; secretSealed?: string | null } | null;
  responseFormat?: AgentResponseFormat | null;
  /** The next due slot; null for manual and webhook routines, a finished once, or a disabled routine. */
  nextFireAt?: Date | null;
  lastFireAt?: Date | null;
  lastRunId?: string | null;
  lastStatus?: 'started' | 'failed' | null;
  lastError?: string | null;
  createdBy: string;
  updatedBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * A routine: a saved way of starting an agent — a prompt (+ inputs) and a
 * `type` (`schedule`, `once`, `manual`, `webhook`) with that type's settings
 * object. Every fire is an ordinary AgentRun (`channel: 'routine'`,
 * `routineId`), so its history is the runs list filtered by routine.
 */
export type IAgentRoutine = IAgentRoutineBase & AgentRoutineTypeSettings;

/** The routine of one type (`AgentRoutineOfType<'webhook'>` has `webhook`). */
export type AgentRoutineOfType<T extends AgentRoutineType> = Extract<IAgentRoutine, { type: T }>;

/** A routine as `createAgentRoutine` takes it. */
export type NewAgentRoutine = Omit<IAgentRoutineBase, '_id' | 'createdAt' | 'updatedAt'> & AgentRoutineTypeSettings;

/** What `updateAgentRoutine` changes: a new `type` always comes with its settings object (the others are dropped). */
export type AgentRoutinePatch =
  & Partial<Omit<IAgentRoutineBase, '_id' | 'tenantId' | 'projectId' | 'agentKey' | 'createdAt' | 'createdBy'>>
  & (AgentRoutineTypeSettings | { type?: undefined });

export interface IAgent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  key: string;
  name: string;
  description?: string;
  config: IAgentConfig;
  status: AgentStatus;
  /** Currently published version number (null = never published) */
  publishedVersion?: number | null;
  /** Latest version number (incremented on each publish) */
  latestVersion?: number;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Immutable snapshot of an agent version (created on publish) */
export interface IAgentVersion {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentId: string;
  agentKey: string;
  version: number;
  /** Full agent data snapshot stored as single JSON object */
  snapshot: {
    name: string;
    description?: string;
    config: IAgentConfig;
    status: AgentStatus;
  };
  /** Optional user-provided changelog message */
  changelog?: string;
  publishedBy: string;
  createdAt?: Date;
}

/** One tool call as a debug session shows it — see `IAgentConversationMessage`. */
export interface IAgentConversationStep {
  id?: string;
  name: string;
  args?: unknown;
  /**
   * What the MODEL saw. With `toolResponsePolicy: 'summarize_archive'` (the
   * console default) this can be a summary of the real result, not the result
   * — see `rawOutput`.
   */
  output?: unknown;
  /** The untouched tool result, stored only when it differs from `output`. */
  rawOutput?: unknown;
  /** Present when the tool threw. */
  error?: string;
  /** Sub-agent that made the call, when delegation was involved. */
  subagent?: string;
  /**
   * The SDK's own verdict. Authoritative: the old code sniffed the output for
   * an `error` key, which both missed a guardrail-`rejected` call and flagged
   * any tool that legitimately returns a field called `error`.
   */
  status?: 'success' | 'error' | 'rejected' | 'handoff';
  /**
   * A person (or the approval timeout) answered "deny" to this call: it is
   * `rejected` and never ran, but it is a decision, not a failure — no `error`
   * text, not counted as a failed call. A call a guardrail blocked is `error`.
   */
  deniedByUser?: boolean;
  /** Served from the response cache — no upstream call was made. */
  fromCache?: boolean;
  /** `output` is a compaction of the result; `originalTokenCount` is its pre-compaction size. */
  summarized?: boolean;
  originalTokenCount?: number;
  timestamp?: string;
  /**
   * What the model wrote in the same message that made this call ("Let me
   * search for …"), set on the first call of that message only. Kept so the
   * transcript shows it where it happened — before the call — instead of
   * dropping it (it is not part of the final answer).
   */
  narration?: string;
}

/** A file attached to a user message — the file itself is a conversation file (`IFileRecord`). */
export interface IAgentMessageAttachment {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  /** `agent_output`: written by the agent to its sandbox `/outputs/` (see agentSandboxOutputs.ts). Absent = a user upload. */
  origin?: 'agent_output';
}

/** An earlier answer to the same question, kept when an answer is regenerated (newest last, at most 5). */
export interface IAgentMessageVersion {
  content: string;
  timestamp: Date;
  stopReason?: 'limit' | 'cancelled' | 'paused';
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number };
}

export interface IAgentConversationMessage {
  /**
   * Stable id of the message, assigned the first time something has to point at
   * it (feedback, a regenerate). Absent on messages nothing ever referred to;
   * `#<index>` addresses those.
   */
  id?: string;
  role: string;
  content: string;
  /** Files attached to this (user) message. Absent on every message without any. */
  attachments?: IAgentMessageAttachment[];
  /** Reasoning / "thinking" trace for assistant messages from reasoning models. */
  reasoning?: string;
  timestamp: Date;
  /** Answers this one replaced (a regenerate), oldest first. */
  previousVersions?: IAgentMessageVersion[];
  /**
   * Debug detail for an assistant turn produced by a Session (not the live
   * `/v1/responses` path, which deliberately returns content only — see
   * `agentService.ts`'s `AgentPlaygroundChatResult`). Persisted so reopening a
   * session shows what happened, not just what was said.
   */
  steps?: IAgentConversationStep[];
  /** Parsed structured output, when the agent declares an output schema. */
  output?: unknown;
  /** Why the structured contract failed, when it did. */
  outputError?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    /** A discounted slice of `inputTokens`, not an addition to it. */
    cachedInputTokens?: number;
    totalTokens?: number;
    /** Priced from the model's own `pricing` at the time of the run — see `calculateCost`. */
    costUsd?: number;
  };
  /** Which agent config produced this turn: a version number, or null for the draft. */
  version?: number | null;
  /**
   * The model that answered, for an agent that offers several: `model` is the key the run used
   * (the Dynamic LLM's key when it is one), `routedModel` the concrete model it routed to.
   */
  metadata?: { model?: string; routedModel?: string };
  /** Wall-clock time the turn took, measured server-side. */
  latencyMs?: number;
  /**
   * Set when the run ended WITHOUT a final answer: a `limits` budget, a
   * cancellation, or a pause no channel can resume. `content` is then the
   * last text the agent wrote, if any. Absent on a normal answer.
   */
  stopReason?: 'limit' | 'cancelled' | 'paused';
  /** The runtime's wording, e.g. "maxWallClockMs (30000ms) exceeded". */
  stopDetail?: string;
  /**
   * Snapshot of the approvals / questions a paused turn is waiting on, kept on
   * the message so history can render them. `status` / `resolution` are updated
   * in place when the action is resolved — the live record is `IAgentPendingAction`.
   */
  pendingActions?: IAgentMessagePendingAction[];
  /** Context summarizations that ran during this turn — see `IAgentTurnCompaction`. */
  compactions?: IAgentTurnCompaction[];
  /** The tool results those summarizations replaced with a placeholder. */
  compactedTools?: Array<{ toolName: string; toolCallId: string }>;
  /**
   * Things that went wrong without failing the turn — a memory lookup that
   * failed, a knowledge search that errored — so an answer built without them
   * is not mistaken for one built with them.
   */
  warnings?: string[];
}

/** One context summarization during a turn, as the session view shows it. */
export interface IAgentTurnCompaction {
  at: string;
  /** Tool results the pass compacted. */
  messagesCompressed?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
  /** The summarizer's own model call. */
  inputTokens?: number;
  outputTokens?: number;
  summary?: {
    userDirectives?: string[];
    facts?: Array<{ key: string; value: string }>;
    goals?: string[];
    openQuestions?: string[];
    discarded?: string[];
  };
  integrityNotes?: string[];
  /** The summarizer call failed and a local fallback summary was used. */
  failed?: boolean;
}

/** Why a turn stopped, as the session API reports it (conversation + events). */
export type AgentSessionStopReason = 'end_turn' | 'requires_action' | 'limit' | 'cancelled' | 'error' | 'budget_reached';

/**
 * What the conversation is doing right now. Absent = idle (every pre-existing row).
 * `budget_paused`: the session's own spend budget was reached and the agent
 * waits for the budget to be raised (or removed) before it goes on.
 */
export type AgentSessionRuntimeStatus = 'idle' | 'running' | 'requires_action' | 'budget_paused';

/**
 * A spend budget for one session (conversation): the sum of what its turns
 * cost. `onReach: 'pause'` stops the turn and waits for a higher budget, after
 * which the turn can be continued; `'stop'` stops it and refuses new messages
 * until the budget is raised or removed.
 */
export interface IAgentSessionBudget {
  maxCostUsd: number;
  onReach: 'pause' | 'stop';
}

/**
 * - `tool_approval`: a person decides whether a tool call runs.
 * - `user_question`: the model asked the person something.
 * - `client_tool`: the model called a tool that runs in the page that embeds the
 *   chat (declared by the embedding's admin); the page answers with its result.
 */
export type AgentPendingActionKind = 'tool_approval' | 'user_question' | 'client_tool';
export type AgentPendingActionStatus = 'pending' | 'resolved' | 'expired' | 'cancelled';

/** One question of an `ask user` pause — mirrors the agent-sdk `UserQuestionItem`. */
export interface IAgentUserQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value?: string; description?: string }>;
}

/** How a pending action was answered. */
export interface IAgentPendingActionResolution {
  decision?: 'allow' | 'deny';
  comment?: string;
  approvedArgs?: Record<string, unknown>;
  answers?: Record<string, string | string[]>;
  cancelled?: boolean;
  rememberForSession?: boolean;
  /** `client_tool`: the result the host page returned (JSON, at most 64 KB). */
  output?: unknown;
  /** `client_tool`: the host page could not do it, or did not answer in time. The model reads it as the tool's error. */
  error?: string;
  /** `client_tool`: the error is a timeout. */
  timedOut?: boolean;
  /** `client_tool`: how long the host page took, measured from the request. */
  durationMs?: number;
}

/** The copy of a pending action carried on the assistant message — see `IAgentConversationMessage.pendingActions`. */
export interface IAgentMessagePendingAction {
  id: string;
  kind: AgentPendingActionKind;
  toolName?: string;
  args?: unknown;
  questions?: IAgentUserQuestion[];
  allowFreeText?: boolean;
  /** `client_tool`: how long the host page may take. */
  timeoutSeconds?: number;
  status: AgentPendingActionStatus;
  resolution?: IAgentPendingActionResolution;
}

/**
 * A tool approval or a question the agent paused on (`agent_pending_actions`).
 * One row per pending SDK approval / question; resolved through
 * `resolveAgentPendingAction`.
 */
export interface IAgentPendingAction {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
  runId?: string;
  kind: AgentPendingActionKind;
  /** The SDK's own approval / question id. */
  sdkId: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  questions?: IAgentUserQuestion[];
  allowFreeText?: boolean;
  status: AgentPendingActionStatus;
  requestedAt: Date;
  expiresAt?: Date | null;
  resolvedAt?: Date | null;
  resolvedBy?: string;
  resolution?: IAgentPendingActionResolution;
  /** `client_tool`: how long the host page may take before the call is answered with an error. */
  clientTool?: { timeoutSeconds: number };
  /** The config the paused turn ran with, so the continuation rebuilds the same agent. */
  agentVersion?: number | null;
  usePublished?: boolean;
  /** Who started the paused turn. */
  createdBy?: string;
}

export type AgentFeedbackRating = 'up' | 'down';
export type AgentFeedbackReason = 'inaccurate' | 'incomplete' | 'off_topic' | 'too_long' | 'unsafe' | 'other';

/**
 * One person's rating of one assistant message (`agent_message_feedback`).
 * At most one per person per message (`conversationId + messageId + userId`);
 * rating again replaces it and withdrawing deletes it.
 */
export interface IAgentMessageFeedback {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  /** The version the rated turn ran (null = the draft). */
  agentVersion?: number | null;
  conversationId: string;
  /** The message's stable id (`IAgentConversationMessage.id`). */
  messageId: string;
  /** Where the message sat in the transcript when it was rated. */
  messageIndex: number;
  userId: string;
  /** Where the rating came from: `portal`, `embed`, `dashboard`, `api`… */
  channel: string;
  portalId?: string;
  rating: AgentFeedbackRating;
  reasons: AgentFeedbackReason[];
  comment?: string;
  /** Set when the rated message was later removed (regenerated, edited away). The rating still counts. */
  removedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Filters of `listAgentMessageFeedback` / `aggregateAgentMessageFeedback`. */
export interface AgentMessageFeedbackFilter {
  projectId: string;
  agentKey: string;
  rating?: AgentFeedbackRating;
  reason?: AgentFeedbackReason;
  portalId?: string;
  hasComment?: boolean;
  from?: Date;
  to?: Date;
}

/** Counts over a feedback filter. */
export interface AgentMessageFeedbackTotals {
  up: number;
  down: number;
  withComment: number;
  /** How many ratings name each reason (a rating can name several). */
  reasons: Partial<Record<AgentFeedbackReason, number>>;
}

/**
 * One entry of the append-only session event log (`agent_session_events`).
 * `seq` is dense and increasing per conversation; `(conversationId, seq)` is unique.
 */
export interface IAgentSessionEvent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  runId?: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * An event as handed to `appendAgentSessionEvents`. A caller that sets `_id`
 * keeps it stable across retries, which is how it recognises what an earlier,
 * partly-failed attempt already stored (see `AgentSessionEventSeqConflictError`).
 */
export type NewAgentSessionEvent = Omit<IAgentSessionEvent, '_id'> & { _id?: string };

export interface IAgentConversation {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  title?: string;
  messages: IAgentConversationMessage[];
  /** What the conversation is doing now; absent = idle. */
  runtimeStatus?: AgentSessionRuntimeStatus;
  /** Why the last turn stopped. */
  stopReason?: AgentSessionStopReason;
  /** Ids (`act_…`) of the actions the conversation is waiting on while `requires_action`. */
  pendingActionIds?: string[];
  /** Highest `agent_session_events.seq` written for this conversation. */
  lastEventSeq?: number;
  /**
   * This session's spend budget. Copied from the agent's `budget`
   * when the session is created; can be set, raised or removed (`null`) later.
   */
  budget?: IAgentSessionBudget | null;
  /** Running total of the priced usage of every turn (USD); backfilled from the messages when absent. */
  spentUsd?: number;
  /**
   * Which turn owns the runtime fields above right now (set when a turn starts).
   * Internal: a turn that was cut off (deadline, cancel) and finishes late writes
   * its end state only if it is still the owner, so it cannot overwrite the turn
   * that started after it. Never part of an API response.
   */
  runtimeTurnId?: string;
  /**
   * sha256 of the transcript a chat-completions client holds after this session's last turn (its messages
   * without system/developer ones, plus the answer it was given). A client that resends its whole transcript
   * and no session id is matched back to the session by it (`findAgentConversationsByTranscriptHash`).
   */
  transcriptHash?: string;
  /**
   * `metadata.runtimeContext` holds the context entered once when the session
   * is started, merged UNDER every turn's own runtime context (so a
   * per-message override still wins) — see `executePlaygroundChatLocal`.
   */
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** A conversation as a list shows it: no transcript, just how many messages it holds. */
export type IAgentConversationListItem = Omit<IAgentConversation, 'messages'> & { messageCount: number };

/** Where a search text first matched in a conversation. */
export interface IAgentConversationSearchMatch {
  field: 'title' | 'message';
  /** The matching message's id, when it has one. */
  messageId?: string;
  role?: 'user' | 'assistant';
  /** Plain text, at most 160 characters, around the match, `…` at cut ends. */
  snippet: string;
}

/** A conversation found by a search: a list item plus where it matched. */
export type IAgentConversationSearchHit = IAgentConversationListItem & { searchMatch?: IAgentConversationSearchMatch };

/**
 * The agent runtime's own state for a conversation, carried between turns.
 *
 * `messages` on the conversation is the transcript people read: user and
 * assistant TEXT. It is not what the agent worked from. Rebuilding the agent's
 * state from it each turn dropped the tool calls and results it had already
 * made (it re-queried them), the context summaries it had built, and — with a
 * summarizing policy — the standing instructions those summaries carried.
 * This record is the agent-sdk snapshot of the state a turn ended in, restored
 * at the start of the next one.
 *
 * Kept out of the conversation record on purpose: it can be large (tool
 * results) and the session list reads conversations in bulk.
 */
export interface IAgentConversationState {
  _id?: ObjectId | string;
  conversationId: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  /** `JSON.stringify` of the agent-sdk `AgentSnapshot`. */
  snapshot: string;
  /**
   * The FULL resumable SDK state at a pause (messages as the SDK left them,
   * pending approvals / questions, resume ctx keys). Present only while the
   * conversation `requires_action`; `snapshot` above is the normal repaired
   * state used when the pending actions are cancelled.
   */
  pausedSnapshot?: string;
  /**
   * `conversation.messages.length` right after the turn that produced the
   * snapshot. A mismatch at load time means the transcript was written by
   * something that did not save state (an older build, a connected agent) and
   * the snapshot no longer describes it — the runtime then falls back to the
   * transcript rather than resume from a stale state.
   */
  messageCount: number;
  sizeBytes: number;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Incident types ──────────────────────────────────────────────────────

export type IncidentStatus = 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'closed';
export type IncidentSeverity = 'critical' | 'warning' | 'info';

export type IncidentSort = 'firedAt' | '-firedAt' | 'updatedAt' | '-updatedAt' | 'severity' | '-severity';

/** The minimal incident fields incident stats are computed from. */
export interface IIncidentStatRow {
  _id: string;
  status: IncidentStatus;
  firedAt: Date;
  acknowledgedAt?: Date | null;
  resolvedAt?: Date | null;
  closedAt?: Date | null;
  reopenedAt?: Date | null;
  autoResolved?: boolean;
}

export interface IIncidentNote {
  userId: string;
  userName: string;
  content: string;
  createdAt: Date;
}

export interface IIncident {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  alertEventId: string;
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  threshold: number;
  actualValue: number;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignedTo?: string;
  notes: IIncidentNote[];
  firedAt: Date;
  acknowledgedAt?: Date;
  resolvedAt?: Date;
  closedAt?: Date;
  resolvedBy?: string;
  module?: AlertModule;
  entityType?: EntityMetricType | null;
  entityKey?: string | null;
  baselineValue?: number | null;
  lastValue?: number | null;
  peakValue?: number | null;
  autoResolved?: boolean;
  acknowledgedBy?: string;
  /** Re-notifications are silenced until this time (status unchanged); expires by comparison, null clears. */
  snoozedUntil?: Date | null;
  snoozedBy?: string | null;
  /** Set when an incident is reopened; `reopenCount` counts the reopenings. */
  reopenedAt?: Date | null;
  reopenCount?: number;
  context?: IIncidentContext;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IIncidentContext {
  mode: AlertConditionMode;
  windowMinutes: number;
  /** `firstSeenAt` is when the new version's first session started (ISO). */
  versionChange?: { from: string | null; to: string | null; firstSeenAt?: string } | null;
  errorSignatures?: Array<{ message: string; count: number }>;
  /** e.g. /dashboard/tracing/sessions?agent=<name>&status=error&from=..&to=.. (no session ids). */
  failingSessions?: { count: number; listPath: string } | null;
  correlations?: Array<{
    entityType: EntityMetricType;
    entityKey: string;
    metric: AlertMetric;
    value: number;
    baseline: number | null;
    ratio: number | null;
  }>;
  notes?: string[];
}

// ── Browser session & agent types ──────────────────────────────────────────

export type BrowserSessionStatus =
  | 'pending'
  | 'running'
  | 'idle'
  | 'closed'
  | 'errored'
  | 'expired';

export type BrowserActionType =
  | 'create'
  | 'goto'
  | 'click'
  | 'hover'
  | 'type'
  | 'press'
  | 'wait'
  | 'scroll'
  | 'select'
  | 'check'
  | 'upload'
  | 'drag'
  | 'back'
  | 'forward'
  | 'reload'
  | 'tab'
  | 'extract'
  | 'snapshot'
  | 'screenshot'
  | 'pdf'
  | 'tool_call'
  | 'agent_event'
  | 'close'
  | 'error';

export type BrowserStatus = 'active' | 'disabled';

/**
 * Browser profile / configuration. A Browser is the parent container that
 * groups browser sessions and browser agents and stores shared defaults
 * (artifact bucket, session config, default model, …). Sessions and agents
 * are always created **under** a Browser.
 */
export interface IBrowser {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** URL-friendly unique identifier scoped to the tenant/project. */
  key: string;
  name: string;
  description?: string;
  status: BrowserStatus;
  /** Default Files bucket where screenshots / PDFs are persisted. */
  artifactBucketKey?: string;
  /** Default browser session configuration applied to spawned sessions. */
  defaultSessionConfig?: IBrowserSessionConfig;
  /**
   * A signed-in profile (Playwright `storageState`) every session starts from,
   * encrypted at rest with `encryptObject`.
   *
   * This is what makes an unattended flow practical: sign in ONCE — by hand
   * in the live preview, or by exporting from a browser — and the nightly run
   * begins authenticated instead of pushing credentials through a login form,
   * where they would pass through the action log on every single run.
   *
   * Encrypted because it holds session cookies: whoever holds this file is
   * logged in as that user until the cookies expire.
   */
  storageStateEnc?: string | null;
  /**
   * Non-secret description of the stored profile, safe to show in the UI.
   *
   * `null` clears the profile. `undefined` means "leave it alone" — the
   * providers skip undefined fields, so it cannot express a deletion.
   */
  storageStateMeta?: null | {
    uploadedAt: Date;
    uploadedBy?: string;
    cookieCount: number;
    origins: string[];
    /** Earliest cookie expiry, so the UI can warn before a profile goes stale. */
    earliestExpiry?: Date;
    sourceFileName?: string;
  };
  /** Default tenant model key applied when running agents under this browser. */
  defaultModelKey?: string;
  /** Default agent runtime knobs (maxSteps, runtimeProfile, …). */
  defaultRunOptions?: {
    maxSteps?: number;
    temperature?: number;
    runtimeProfile?: string;
  };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBrowserAccessRules {
  /** Optional list of host patterns the browser is allowed to navigate to. */
  allowList?: string[];
  /** Optional list of host patterns to block. Evaluated after allowList. */
  blockList?: string[];
}

export interface IBrowserSessionConfig {
  headless?: boolean;
  viewport?: { width: number; height: number };
  userAgent?: string;
  locale?: string;
  /** IANA zone, e.g. `Europe/Istanbul`. Pages that render dates read this. */
  timezoneId?: string;
  /** Auto-close after this many ms of inactivity. Defaults via config. */
  idleTimeoutMs?: number;
  /** Hard upper bound on session lifetime (ms). */
  maxLifetimeMs?: number;
  /** Default per-action timeout (click/hover/type/snapshot). Defaults via config. */
  actionTimeoutMs?: number;
  /** Default navigation timeout (goto). Defaults via config. */
  navigationTimeoutMs?: number;
  access?: IBrowserAccessRules;
  /**
   * Route the session's traffic through an egress proxy.
   *
   * Enterprise networks want automated browsers on the same secure web
   * gateway as everything else; without this the traffic leaves from the
   * pod's default route and appears in no egress log.
   */
  proxy?: {
    server: string;
    username?: string;
    password?: string;
    bypass?: string;
  };
  /** Sent on every request — API keys for internal apps, tracing headers. */
  extraHTTPHeaders?: Record<string, string>;
  /** HTTP basic auth, for internal tools still fronted by it. */
  httpCredentials?: { username: string; password: string };
  /** Off by default: an automated browser that accepts files is an ingest path. */
  acceptDownloads?: boolean;
  /** DANGER: disables TLS verification. Only for a known-broken internal chain. */
  ignoreHTTPSErrors?: boolean;
  /**
   * What to do when the page raises `alert` / `confirm` / `prompt`.
   *
   * There is no "leave it open" option on purpose: an unanswered dialog
   * blocks the page indefinitely, and every subsequent action fails as a
   * timeout with no hint of the cause.
   */
  dialogPolicy?: 'accept' | 'dismiss';
  /**
   * Cookies + origin storage to start from, as exported by
   * `browserManager.exportStorageState`. This is how a scheduled flow resumes
   * a signed-in session instead of replaying credentials into a login form.
   */
  storageState?: Record<string, unknown>;
}

export interface IBrowserSession extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Parent Browser profile that owns this session. */
  browserId: string;
  /** Stable identifier exposed to clients. */
  sessionKey: string;
  name?: string;
  agentId?: string;
  agentKey?: string;
  status: BrowserSessionStatus;
  config: IBrowserSessionConfig;
  /** Live state captured for observability — not source of truth. */
  currentUrl?: string;
  pageTitle?: string;
  lastActivityAt?: Date;
  /** Last screenshot artifact reference (file bucket / object key). */
  lastScreenshot?: {
    bucketKey: string;
    fileId: string;
    objectKey: string;
    capturedAt: Date;
  };
  /** Bucket key used to persist artifacts (screenshots / PDFs). */
  artifactBucketKey?: string;
  startedAt?: Date;
  endedAt?: Date;
  errorMessage?: string;
  /** Raw counters for fast list views. */
  eventCount?: number;
  metadata?: Record<string, unknown>;
  /**
   * Name of the cluster node (nodeRegistry.getThisNodeName()) that launched
   * this session, i.e. the only process whose in-memory browserManager can
   * actually know this session is alive. Boot reconciliation cross-checks
   * this against the node registry before expiring an active-status session
   * — a session is only truly orphaned when its owner node is gone, not
   * merely unknown to whichever replica happens to be reconciling.
   */
  ownerNode?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBrowserSessionEvent {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  sessionId: string;
  /** Sequence index for ordering within a session. */
  sequence: number;
  type: BrowserActionType;
  status?: 'success' | 'error';
  url?: string;
  selector?: string;
  ref?: string;
  durationMs?: number;
  /** Optional artifact pointer (screenshot / pdf). */
  artifact?: {
    bucketKey: string;
    fileId: string;
    objectKey: string;
    contentType?: string;
  };
  /** Compact, sanitized payload (not raw HTML / large blobs). */
  data?: Record<string, unknown>;
  errorMessage?: string;
  createdAt?: Date;
}

// ── Browser Flow types ─────────────────────────────────────────────────────
//
// A Flow is the replayable half of browser automation, and it exists because
// discovery and execution are different problems with different costs.
//
// DISCOVERY is a model reading a page, guessing, backtracking and paying for
// tokens on every step. EXECUTION is running the steps that discovery already
// proved. Today an agent pays the discovery price on every single run, which
// is why the same nightly task costs the same as the first time it was solved
// and fails in new ways each night.
//
// A Flow freezes the outcome of one discovery into an ordered step list with
// DURABLE targets (`role` + `name`, test-ids — never the volatile aria `ref`),
// declared inputs, and per-step retry policy. Replaying it needs no model at
// all: `runBrowserFlow` walks the list. An agent can still be in the loop —
// it can CALL a flow as one tool, and a step can hand control back to a model
// when the page is genuinely new — but the common path is deterministic.

export type BrowserFlowStatus = 'draft' | 'active' | 'disabled';
export type BrowserFlowRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type BrowserFlowTrigger = 'manual' | 'agent' | 'api' | 'schedule';

/** Declared parameter of a flow, bound at run time into `{{input.name}}`. */
export interface IBrowserFlowInput {
  name: string;
  label?: string;
  type: 'string' | 'number' | 'boolean' | 'secret';
  required?: boolean;
  /** Applied when the run supplies nothing. Never set for `secret`. */
  default?: string | number | boolean;
  description?: string;
}

/**
 * One field of the JSON a run hands back.
 *
 * Undeclared, a run returns whatever `captureAs` happened to collect — a
 * shape that changes the moment someone renames a capture or reorders the
 * steps, and one a caller (an agent picking the flow out of a list, a client
 * API consumer) cannot know before running it. Declaring the fields here
 * makes the return value a contract that survives the steps being rewritten
 * underneath it.
 */
export interface IBrowserFlowOutput {
  /** Key in the returned JSON. */
  name: string;
  /** Template over captures and inputs — usually one `{{step.x}}`. */
  source: string;
  /**
   * Cast applied to the resolved value. Left off, the value is passed
   * through exactly as captured (an `extract` with `multiple` stays an
   * array); a cast that fails leaves the field unresolved rather than
   * emitting `NaN`.
   */
  type?: 'string' | 'number' | 'boolean' | 'json';
  /** A run that cannot resolve this field fails, even if every step passed. */
  required?: boolean;
  description?: string;
}

/**
 * What a step does when it fails.
 *
 * `abort` is the default because a half-finished form is usually worse than
 * no form. `continue` suits assertion-ish steps ("dismiss the cookie banner
 * if it is there"), which is why `optional` exists as its own flag rather
 * than being inferred from a zero retry count.
 */
export interface IBrowserFlowStepPolicy {
  /** Attempts beyond the first. Default 0. */
  retries?: number;
  /** Delay between attempts (ms). Default 500, doubling. */
  retryDelayMs?: number;
  /** Per-step timeout (ms). Falls back to the session's action timeout. */
  timeoutMs?: number;
  /** A failing optional step is recorded and skipped instead of aborting. */
  optional?: boolean;
}

export interface IBrowserFlowStep {
  /** Stable id, so a run's step results survive a step being reordered. */
  id: string;
  /** Operator-facing label. Generated at record time from the action. */
  label?: string;
  /**
   * The action payload, in the same shape the live API accepts, minus any
   * volatile `ref`. Recording strips refs; `browserFlowService` rejects a
   * step that still carries one.
   */
  action: Record<string, unknown>;
  /** Store the step's output under this name for later `{{step.name}}` use. */
  captureAs?: string;
  policy?: IBrowserFlowStepPolicy;
  /** Skip the step unless this expression is truthy. */
  when?: string;
}

export interface IBrowserFlow {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** URL-friendly unique identifier scoped to the tenant/project. */
  key: string;
  name: string;
  description?: string;
  status: BrowserFlowStatus;
  /** Browser profile the flow runs under — supplies session config and egress rules. */
  browserId: string;
  inputs?: IBrowserFlowInput[];
  /** Declared shape of the JSON a run returns. Empty means "the raw captures". */
  outputs?: IBrowserFlowOutput[];
  steps: IBrowserFlowStep[];
  /** Session config overrides applied for the flow's own sessions. */
  sessionConfig?: IBrowserSessionConfig;
  /** Session this flow was recorded from, for provenance. */
  recordedFromSessionId?: string;
  /** Bumped on every step change; a run pins the version it executed. */
  version: number;
  /** Rollup of the most recent run, for list views. */
  lastRun?: {
    runId: string;
    status: BrowserFlowRunStatus;
    startedAt: Date;
    durationMs?: number;
  };
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBrowserFlowStepResult {
  stepId: string;
  index: number;
  status: 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  durationMs?: number;
  url?: string;
  /** Sanitized action echo — secrets are already substituted out. */
  action?: Record<string, unknown>;
  /** Whatever `captureAs` collected. */
  captured?: unknown;
  artifact?: {
    bucketKey: string;
    fileId: string;
    objectKey: string;
    contentType?: string;
  };
  errorMessage?: string;
}

export interface IBrowserFlowRun {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  flowId: string;
  flowKey: string;
  /** Flow version this run executed — steps may have changed since. */
  flowVersion: number;
  status: BrowserFlowRunStatus;
  trigger: BrowserFlowTrigger;
  /** Session the run drove. Its event log is the fine-grained record. */
  sessionId?: string;
  sessionKey?: string;
  /** Non-secret inputs only; `secret` parameters are never persisted. */
  inputs?: Record<string, unknown>;
  stepResults?: IBrowserFlowStepResult[];
  /**
   * The run's return value, in the shape `flow.outputs` declares. A flow
   * that declares nothing returns `captures` verbatim, which is what every
   * run did before outputs existed.
   */
  outputs?: Record<string, unknown>;
  /** Raw values collected by `captureAs`, keyed by name — the debugging view. */
  captures?: Record<string, unknown>;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  errorMessage?: string;
  /** Index of the step that aborted the run. */
  failedStepIndex?: number;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Crawler types ──────────────────────────────────────────────────────────
//
// The Crawler service ingests web pages (and downloadable files) into
// markdown via @cognipeer/to-markdown. A Crawler is a user-defined profile
// that holds the plan (seeds, depth, scope), HTTP settings (headers, cookies,
// auth), an optional RAG module binding and an optional outbound webhook.
// A CrawlJob is one execution; CrawlResult is one fetched page or file.

export type CrawlerStatus = 'active' | 'disabled';
export type CrawlerEngine = 'axios' | 'playwright' | 'auto';
export type CrawlerWebhookEvent = 'page' | 'completed' | 'failed';

export interface ICrawlerScope {
  /** Restrict crawl to the seed domain (and its subdomains if `includeSubdomains`). */
  sameDomainOnly: boolean;
  includeSubdomains: boolean;
  /** Optional host glob patterns (`docs.*.example.com`) – matched against the URL host. */
  allowList?: string[];
  /** Evaluated after allowList – matching hosts are skipped. */
  blockList?: string[];
}

export interface ICrawlerCookie {
  name: string;
  /**
   * Absent on a sealed/masked record — the plaintext value is either moved
   * into `ICrawlerHttpConfig.sealed` (at rest) or redacted (on read). See
   * `@/lib/services/crawler/httpConfigSecrets`.
   */
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Unix seconds. Omit for session cookie. */
  expires?: number;
}

export interface ICrawlerHttpConfig {
  userAgent?: string;
  acceptLanguage?: string;
  /** Per-request timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Concurrent in-flight requests. Default 5, capped at 16. */
  maxConcurrency?: number;
  /** Retry count per request. Default 2. */
  retries?: number;
  headers?: Record<string, string>;
  cookies?: ICrawlerCookie[];
  /** `password` is absent on a sealed/masked record — see `sealed` below. */
  basicAuth?: { username: string; password?: string };
  bearerToken?: string;
  /** Allow private / link-local destinations. Default false (SSRF guard). */
  allowPrivateNetwork?: boolean;
  /**
   * Skip TLS certificate verification (DANGER: disables MITM protection).
   * Use only for sites with a known-broken TLS chain. Default false.
   */
  allowInsecureTls?: boolean;
  /**
   * Encrypted-at-rest secret payload (AES-256-GCM) holding bearerToken /
   * basicAuth.password / cookies[].value. When set, those plaintext fields
   * are absent from the stored record and must be recovered through
   * `@/lib/services/crawler/httpConfigSecrets` before use. See the MCP
   * secret vault (`@/lib/services/mcp/secretVault`) for the same convention.
   */
  sealed?: string;
}

/** Markdown extraction options forwarded to the crawler engine. */
export interface ICrawlerMarkdownOptions {
  ocr?: { enabled: boolean; languages?: string[] };
  /** Stored body shape: 'markdown' (default) or flattened plain 'text'. */
  outputFormat?: 'markdown' | 'text';
  /** Run the markdown cleanup pass (entities, dead links, blank lines). Default true. */
  cleanup?: boolean;
  /** Strip base64-inlined `data:` images before conversion. Default true. */
  stripDataImages?: boolean;
  /**
   * Extract the primary article region with Mozilla's Readability before
   * conversion (drops nav/ads/comments far more reliably than
   * `mainContentOnly`). Default true.
   */
  readability?: boolean;
  /** Narrow extraction to the main content region (drops nav/header/footer). Fallback when `readability` is off or finds no article. */
  mainContentOnly?: boolean;
  /** Explicit CSS selector for the main content region. */
  contentSelector?: string;
  /** CSS selectors removed before conversion. */
  removeSelectors?: string[];
  /** Hard cap on stored markdown length (chars). 0/undefined = no cap. */
  maxBodyChars?: number;
}

export interface ICrawlerWebhookConfig {
  url: string;
  /** HMAC secret used to sign payloads. */
  secret?: string;
  events: CrawlerWebhookEvent[];
}

export interface ICrawlerRagBinding {
  ragModuleKey: string;
  enabled: boolean;
}

export type CrawlerScheduleMode = 'interval' | 'cron';

export interface ICrawlerSchedule {
  mode: CrawlerScheduleMode;
  enabled: boolean;
  /** interval mode: seconds between runs. Minimum 60. */
  intervalSeconds?: number;
  /** cron mode: 5- or 6-field cron expression (UTC). */
  cron?: string;
  /** Optional activation window. */
  startAt?: Date;
  endAt?: Date;
  /** Last run start (mirror of the latest CrawlJob.startedAt). */
  lastRunAt?: Date;
  /** Next scheduled run (computed at write time + after every run). */
  nextRunAt?: Date;
}

export interface ICrawler {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** URL-friendly unique identifier scoped to the tenant/project. */
  key: string;
  name: string;
  description?: string;
  status: CrawlerStatus;

  /** Seed URLs the crawl starts from. At least 1. */
  seeds: string[];
  engine: CrawlerEngine;
  /** 0..3 – capped at 3 to bound runtime. */
  maxDepth: number;
  /** 0 = unlimited. */
  maxPages: number;
  autoCrawl: boolean;
  scope: ICrawlerScope;
  /** MIME types treated as downloadable files (recorded but not stored in F1). */
  downloadableMimes?: string[];

  http: ICrawlerHttpConfig;
  /** Optional markdown extractor options forwarded to @cognipeer/to-markdown. */
  markdownOptions?: ICrawlerMarkdownOptions;

  rag?: ICrawlerRagBinding;
  webhook?: ICrawlerWebhookConfig;
  schedule?: ICrawlerSchedule;

  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CrawlJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'partial';

export type CrawlJobTrigger = 'manual' | 'api' | 'adhoc' | 'schedule';

/**
 * Frozen plan snapshot stored at run time so the job is reproducible even
 * if the parent crawler is later edited.
 */
export interface ICrawlPlanSnapshot {
  seeds: string[];
  engine: CrawlerEngine;
  maxDepth: number;
  maxPages: number;
  autoCrawl: boolean;
  scope: ICrawlerScope;
  http: ICrawlerHttpConfig;
  downloadableMimes?: string[];
  markdownOptions?: ICrawlerMarkdownOptions;
  rag?: ICrawlerRagBinding;
  webhook?: ICrawlerWebhookConfig;
}

export interface ICrawlJob extends IUsageAttributionFields {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  /** Parent crawler key when triggered from a saved profile; absent for ad-hoc runs. */
  crawlerKey?: string;
  trigger: CrawlJobTrigger;
  triggerActor: string;
  planSnapshot: ICrawlPlanSnapshot;
  status: CrawlJobStatus;
  startedAt?: Date;
  endedAt?: Date;
  durationMs?: number;
  pagesDiscovered: number;
  pagesProcessed: number;
  filesProcessed: number;
  errorsCount: number;
  limitReached?: boolean;
  /**
   * Persisted cancellation intent. Set when a cancel request arrives while
   * the job is `running` (possibly from a different node than the one
   * actually executing it) — the owning runner observes this on its next
   * DB round trip and performs its own guarded transition to `canceled`.
   * A `queued` job is canceled outright instead (see `requestCrawlJobCancel`).
   */
  cancelRequestedAt?: Date;
  /** Per-run callback override (ad-hoc tek-shot run desteği). */
  callbackUrl?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CrawlResultType = 'html' | 'file' | 'error';

export interface ICrawlResult {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string;
  jobId: string;
  crawlerKey?: string;
  url: string;
  parentUrl?: string;
  depth: number;
  type: CrawlResultType;
  httpStatus?: number;
  contentType?: string;
  title?: string;
  description?: string;
  /** Present when type === 'html'. */
  bodyMarkdown?: string;
  bytes?: number;
  /** RAG ingest outcome (when crawler has a RAG binding). */
  ragDocumentId?: string;
  ragStatus?: 'pending' | 'indexed' | 'skipped' | 'failed';
  errorMessage?: string;
  fetchedAt?: Date;
  createdAt?: Date;
}

// ── PII Service types ───────────────────────────────────────────────────────

/**
 * Action taken when PII is detected.
 *  - 'detect'   → return findings, never alter text
 *  - 'redact'   → replace match with a tag like [REDACTED_EMAIL]
 *  - 'mask'     → partial masking, e.g. j***@gmail.com, **** **** **** 1234
 *  - 'block'    → mark finding as blocking; caller decides what to do
 *  - 'tokenize' → reversible masking: replace match with a unique token like
 *                 [EMAIL_1] and return a vault so the original can be restored
 *                 later via detokenize (e.g. round-trip around an LLM call)
 */
export type PiiAction = 'detect' | 'redact' | 'mask' | 'block' | 'tokenize';

/**
 * Which detector actually runs a policy's scan. 'regex' (default, absent on
 * every policy created before this field existed) is the console's own
 * long-standing engine (`services/pii/detector.ts`) — regex/checksum,
 * opt-in dictionary and NER layers, tuned by `IPiiPolicy.detection`.
 * 'cognipeer' delegates the whole scan to the bundled, offline
 * `@cognipeer/pii` npm package instead (`services/pii/cognipeerEngine.ts`) —
 * a genuinely different category catalog (31 ids, its own id vocabulary —
 * e.g. `tc_kimlik` there vs `tckn` here), so `IPiiPolicy.categories` is
 * interpreted entirely differently depending on this field. Extensible: a
 * future third engine (e.g. a cloud PII API) is one more member here plus one
 * more file under `services/pii/`, same shape as this one.
 *
 * DELIBERATELY ONE ENGINE PER POLICY, not a list run together: unlike two
 * guardrail hook families that can be genuinely complementary (see
 * `cognipeer_guardrail_moderation`/`_prompt_shield`), two PII engines mostly
 * cover the SAME ground (email, phone, national id, ...), so running both
 * would mean the same span gets found — and its redaction proposed — twice,
 * with no established conflict-resolution for it the way `FAMILY_PRECEDENCE`
 * resolves an overlap WITHIN one engine's own findings. An operator picks
 * one; switching later means re-picking categories from the new engine's own
 * catalog, not merging two.
 */
export type PiiEngine = 'regex' | 'cognipeer';

/** Language scope for built-in patterns. 'global' = language-independent. */
export type PiiLanguage = 'global' | 'en' | 'tr' | 'de' | 'fr' | 'es' | 'it' | 'pt' | 'ar' | 'ja' | 'zh';

/** A tenant-defined custom regex pattern. */
export interface IPiiCustomPattern {
  /** Stable id within the policy (uuid). */
  id: string;
  /** Human-readable category id (used in findings: e.g. "customer_id"). */
  categoryId: string;
  /** Display label (default locale). */
  label: string;
  /** Optional localized labels keyed by language. */
  labels?: Partial<Record<PiiLanguage, string>>;
  /** Regex source string (JS regex, without surrounding slashes). */
  pattern: string;
  /** Regex flags. 'g' is enforced by the detector regardless. */
  flags?: string;
  /** Languages this pattern applies to. Empty / undefined = global. */
  languages?: PiiLanguage[];
  /** Severity for findings produced by this pattern. */
  severity?: 'low' | 'medium' | 'high';
  /** Whether this pattern is enabled. */
  enabled: boolean;
}

/**
 * A reusable PII policy: which built-in categories are enabled,
 * which custom patterns to run, default action and target languages.
 *
 * A DIFFERENT THING from a `GuardrailPolicy`, and deliberately not renamed with
 * it: this is a standalone tenant asset with its own collection
 * (`pii_policies`), its own screens and its own API, which a guardrail's `pii`
 * policy merely REFERENCES by key (`GuardrailPiiPolicyConfig.piiPolicyKey`).
 * One PII policy is shared by many guardrail policies, which is the whole
 * reason the categories do not live inline on the guardrail.
 */
export interface IPiiPolicy {
  _id?: import('mongodb').ObjectId | string;
  tenantId: string;
  projectId?: string;
  key: string;
  name: string;
  description?: string;
  /** Default action applied to findings from this policy. */
  defaultAction: PiiAction;
  /** Which detector runs this policy. Absent = 'regex' — see `PiiEngine`'s
   *  own doc comment for why this changes what `categories` below means. */
  engine?: PiiEngine;
  /** Built-in categories toggled on/off. Keys are category ids (e.g. 'email').
   *  A DIFFERENT id vocabulary per `engine` — see `PiiEngine`. */
  categories: Record<string, boolean>;
  /** Custom regex patterns defined per tenant. */
  customPatterns?: IPiiCustomPattern[];
  /** Languages to scan for. 'global' is always included. Empty = all. */
  languages?: PiiLanguage[];
  /** Whether the policy is enabled overall. */
  enabled: boolean;
  metadata?: Record<string, unknown>;
  /**
   * PII v2: opt-in NLP layers on top of the pattern engine. Absent/undefined
   * on every policy created before this field existed, and the detector's
   * default ('pattern' mode, no dictionary/NER pass, no confidence filter)
   * reproduces the pre-v2 behaviour exactly — this is additive, not a
   * migration.
   */
  detection?: PiiDetectionConfig;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Config for the PII v2 detection pipeline (`services/pii/detector.ts`).
 * See `internal-notes/pii-v2-nlp-ve-asset-registry-plani.md` for the full
 * 5-layer design; this is the subset implemented against local model/dict
 * files rather than the (not-yet-built) GitHub asset registry.
 */
export interface PiiDetectionConfig {
  /**
   * 'pattern' (default): regex + checksum only, identical to pre-v2 output.
   * 'pattern+dictionary': adds the Aho-Corasick gazetteer pass (person/org/
   * location candidates).
   * 'pattern+dictionary+ner': also runs the local ONNX NER model.
   */
  mode?: 'pattern' | 'pattern+dictionary' | 'pattern+dictionary+ner';
  /** Findings below this confidence are dropped. 0 = no filtering (default). */
  minConfidence?: number;
  /** Boost a finding's confidence when a category's context word appears
   *  within ±60 chars. Default true; has no effect on categories with no
   *  configured context words. */
  contextBoost?: boolean;
  ner?: {
    /** Local model ids to run, e.g. ['tr-ner']. See `pii/ner.ts` NER_MODELS. */
    models?: string[];
    /** Hard cap on characters sent to the model per scan. Default 4000. */
    maxChars?: number;
    /** Per-window soft timeout; a window that misses it is skipped and
     *  reported as degraded rather than blocking the scan. Default 1500. */
    timeoutMs?: number;
    /** 'open' (default): a model error/timeout lets that window's NER
     *  findings pass silently. 'closed': surfaces as a scan-level warning. */
    failMode?: 'open' | 'closed';
  };
}

// ── Prescriptions (automated analysis reports) types ─────────────────────

export type PrescriptionReportStatus = 'pending' | 'running' | 'ready' | 'failed';
export type PrescriptionSubjectKind = 'agent' | 'model' | 'workspace';

/**
 * One automated analysis report: a battery of deterministic detectors ran
 * over a subject's observed traffic window and produced findings, each with
 * evidence and a prescribed action. `findings` and `totals` are stored as
 * opaque JSON — their shapes are owned by the prescriptions service
 * (src/lib/services/prescriptions/types.ts) and evolve with the detector
 * battery; the DB layer never reads inside them.
 */
export interface IPrescriptionReport {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  subjectKind: PrescriptionSubjectKind;
  /** Agent or model name; null for workspace-wide reports. */
  subjectName?: string | null;
  windowDays: number;
  from?: Date | null;
  to?: Date | null;
  status: PrescriptionReportStatus;
  error?: string | null;
  /** PrescriptionTotals JSON (header tiles snapshot). */
  totals?: Record<string, unknown> | null;
  /** PrescriptionFinding[] JSON. */
  findings: unknown[];
  /** Optional LLM-written narrative over the findings (never a data source). */
  narrative?: { text: string; modelKey: string; generatedAt: Date } | null;
  createdBy?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  finishedAt?: Date | null;
}

// ── Agent Runs (background execution) types ───────────────────────────────
// See docs/guide/agent-background-execution.md for the full design. Diverges
// deliberately from the ICrawlJob precedent on crash recovery/retry (§12.1):
// agent turns can carry irreversible tool side effects that crawl jobs do not.

/**
 * Which path created this row.
 *  - `'sync'`: a dashboard/portal reservation that only holds the
 *    single-active-run slot (see `createAgentRun` in contract.ts for
 *    `conversationId`, §6/§12.14) for the duration of a call — deleted when the
 *    turn ends (success, timeout, or error), never polled.
 *  - `'inline'`: an API turn executed in the request process. Recorded like a
 *    background run (finalized, kept until retention), heartbeats, and may
 *    detach (the caller stops waiting and gets 202).
 *  - `'background'`: a queue worker run.
 */
export type AgentRunMode = 'sync' | 'inline' | 'background';

/**
 * `scheduled` is not active: it holds no conversation slot and is promoted to
 * `queued` when `notBefore` is due. A dashboard `sync` row never reaches a
 * terminal state (its row is deleted when the turn ends, §6).
 */
export type AgentRunStatus =
  | 'scheduled'
  | 'queued'
  | 'running'
  /**
   * Non-terminal: the turn paused for an approval or a question. Not an active
   * status (it does not hold the conversation's run slot); a resolution moves
   * it back to `queued`.
   */
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/**
 * Distinguishes an agent-side failure, a worker that died mid-run (§12.1),
 * the server-side background ceiling firing (§12.13), and an explicit caller
 * cancel — different causes should not collapse into one generic value.
 */
export type AgentRunErrorReason =
  | 'agent_error'
  | 'worker_lost'
  | 'max_duration_exceeded'
  | 'canceled_by_caller'
  /** The agent was disabled/deleted, or the submitting API token revoked, before the worker started it. */
  | 'precondition_failed'
  /** The user who started the run was disabled before the worker started it. */
  | 'owner_disabled'
  /** The owner's account state could not be read, so the run was refused (fail closed). */
  | 'owner_unverifiable'
  /** A deferred / scheduled run that did not start within `AGENT_DEFERRED_MAX_WAIT_MS` of becoming due. */
  | 'expired'
  /** The server shut down while the run was executing; not retried automatically. */
  | 'interrupted'
  | null;

/** Durable delivery state for the optional callback webhook (§12.6). */
export type AgentRunCallbackStatus = 'pending' | 'delivered' | 'failed';

// ── Webhook subscriptions ────────────────────────────────────────────────

export type WebhookEndpointStatus = 'active' | 'disabled';

/** Why an endpoint was switched off. `manual` = a person did it. */
export type WebhookDisabledReason = 'manual' | 'redirect' | 'blocked_address' | 'sustained_failure';

/**
 * An outgoing webhook subscription (`webhook_endpoints`). `projectId` absent
 * = every project of the tenant.
 */
export interface IWebhookEndpoint {
  _id?: ObjectId | string;
  tenantId: string;
  projectId?: string | null;
  url: string;
  description?: string;
  /** Event types and `prefix.*` patterns the endpoint subscribes to. */
  events: string[];
  /** Sealed (`encryptObject`) signing secret. Never returned by the API. */
  secretSealed: string;
  status: WebhookEndpointStatus;
  disabledReason?: WebhookDisabledReason | null;
  /** Start of the current unbroken run of failed deliveries; cleared by any 2xx. */
  failingSince?: Date | null;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

/**
 * One event owed to one endpoint (`webhook_deliveries`). `pending` with a
 * `nextAttemptAt` is the retry queue: the reconciler re-enqueues what is due.
 */
export interface IWebhookDelivery {
  _id?: ObjectId | string;
  tenantId: string;
  /** The project the event happened in. */
  projectId?: string | null;
  endpointId: string;
  eventId: string;
  eventType: string;
  /** The thin body that is signed and sent: `{ id, type, createdAt, projectId, data }`. */
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt?: Date | null;
  lastStatusCode?: number | null;
  lastError?: string | null;
  lastDurationMs?: number | null;
  createdAt: Date;
  deliveredAt?: Date | null;
}

export interface IAgentRun extends IUsageAttributionFields {
  _id?: ObjectId | string;
  mode: AgentRunMode;
  tenantId: string;
  tenantDbName: string;
  /** Required, checked on every read/write path (§12.11) — never optional. */
  projectId: string;
  agentKey: string;
  /**
   * Conversation this turn is appended to. Guarded (SQLite partial unique
   * index / Mongo agent_run_locks) so at most one active (`queued`/`running`)
   * run can exist per conversation regardless of mode (§6, §12.14).
   */
  conversationId: string;
  userMessage: string;
  /** Ids of the conversation files this turn's message attaches (`IFileRecord`). */
  attachments?: string[] | null;
  /**
   * Which agent config the worker re-runs the turn with. The queue message
   * carries only ids; the worker loads the rest from this row (§7 step 2).
   */
  version?: number | null;
  usePublished?: boolean;
  /** Serialized `AgentRuntimeContext` (already plain data — see its own doc comment). */
  runtimeContext?: Record<string, unknown> | null;
  /**
   * Caller-supplied, from an `Idempotency-Key` header — background mode only
   * (§12.15). Scoped by tenantId+projectId at lookup time.
   */
  idempotencyKey?: string | null;
  /** Hash of `{ agentKey, conversationId, userMessage, version }` (§12.15). */
  idempotencyRequestHash?: string | null;
  status: AgentRunStatus;
  errorReason?: AgentRunErrorReason;
  /**
   * How the agent turn ended (a `succeeded` run can still be `limit`). Absent on
   * rows from before this field and on non-terminal / failed runs.
   */
  stopReason?: AgentSessionStopReason | null;
  /**
   * Set while the run is queued to CONTINUE a paused turn (the pending actions
   * it resolves) rather than to start from `userMessage`.
   */
  resumeActionIds?: string[] | null;
  /** The same response payload a synchronous call would have returned. */
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  /**
   * Set by a cancel request possibly arriving on a different node than the
   * one executing the run; the owning worker observes it on its next poll
   * (crawler-proven pattern, `ICrawlJob.cancelRequestedAt`).
   */
  cancelRequestedAt?: Date | null;
  /** The node currently (or last) executing this run — see the reconciler. */
  workerId?: string | null;
  /** Updated periodically by the executing worker while `status = running`. */
  heartbeatAt?: Date | null;
  callbackUrl?: string | null;
  /**
   * Sealed (`encryptSecretValue`) shared secret the callback is HMAC-signed
   * with. Never returned by the API.
   */
  callbackSecret?: string | null;
  /** Effective run ceiling resolved at submit time (env ∧ tenant quota). */
  maxDurationMs?: number | null;
  /** Absent = `default`. */
  runClass?: AgentRunClass;
  /** Scheduled start: a `scheduled` row is promoted to `queued` once this is due. */
  notBefore?: Date | null;
  /** Set when an `inline` run's caller stopped waiting (the call answered 202). */
  detachedAt?: Date | null;
  /**
   * The request asked for `background: true` (Responses). A queued run is
   * background by its mode; this keeps the choice on a streamed one, which runs
   * inline, so a read of the run reports it. Absent = not asked.
   */
  background?: boolean;
  /** Caller labels: at most 16 keys (`[A-Za-z0-9_.-]`, ≤64 chars), values ≤512 chars. */
  metadata?: Record<string, string> | null;
  /** The surface that created the run. */
  channel?: 'runs' | 'responses' | 'chat_completions' | 'a2a' | 'routine' | null;
  routineId?: string | null;
  trigger?: 'request' | 'schedule' | 'once' | 'manual' | 'webhook' | null;
  /**
   * No interactive user on the run (a routine fire): a gated tool follows the
   * agent's `humanInTheLoop.unattended` setting. Every continuation keeps it.
   */
  unattended?: boolean;
  /**
   * The message / inputs came from an external payload: inputs never fill the
   * system prompt's `{{input.*}}` and the Inputs block is closed (agentInputs.ts).
   * Every continuation keeps it.
   */
  externalContent?: boolean;
  /** Per-request structured output; the worker and a resume re-apply it. */
  responseFormat?: AgentResponseFormat | null;
  /** Validated agent inputs (`IAgentConfig.inputs`). */
  inputs?: Record<string, unknown> | null;
  /**
   * Bumped on every (re)queue for a NEW execution (create = 1, resume/continue
   * +1). The job dedup key is `ar_${runId}_${queueGeneration}`, so a reconciler
   * republish of the same generation is a no-op.
   */
  queueGeneration?: number;
  /** When the queue job was last published (reconciler republish bookkeeping). */
  lastPublishedAt?: Date | null;
  callbackStatus?: AgentRunCallbackStatus | null;
  /** Incremented per delivery attempt, persisted so a restart doesn't lose count. */
  callbackAttempts?: number;
  /**
   * The event id (`evt_…`) `callbackStatus` / `callbackAttempts` belong to: a
   * delivery job of an older event of the run does not write over them.
   */
  callbackEventId?: string | null;
  /**
   * Set while the run is queued to continue a paused turn: what continues it
   * (`resume` = somebody answered, `timeout` = the timeout sweep) and who
   * answered (user and API token). The worker reads them.
   */
  resumeTrigger?: 'resume' | 'timeout' | null;
  resumeUserId?: string | null;
  resumeApiTokenId?: string | null;
  /**
   * The principal whose spend and quota policies the run counts against when
   * its owner is a synthetic actor (a routine fire): the routine's last
   * updater (or creator), or the person and token that pressed Run now.
   */
  accountableUserId?: string | null;
  accountableTokenId?: string | null;
  createdAt?: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  /**
   * Retention cutoff (§12.10) — userMessage/result are not kept indefinitely.
   * Counted from the run's earliest possible end at insert, and again from
   * `completedAt` once the run is terminal.
   */
  expiresAt?: Date | null;
  updatedAt?: Date;
}
