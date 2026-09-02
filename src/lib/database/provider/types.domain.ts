import type { ObjectId } from 'mongodb';
import type { IUsageAttributionFields } from './types.base';

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
  modelKey?: string;
  categories: Record<string, boolean>;
}

export interface IGuardrailPromptShieldPolicy {
  enabled: boolean;
  modelKey?: string;
  sensitivity: 'low' | 'balanced' | 'high';
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

/** The nine policy families a hook can run. */
export type GuardrailPolicyFamily =
  | 'pii'
  | 'secrets'
  | 'word_filter'
  | 'regex'
  | 'moderation'
  | 'prompt_shield'
  | 'custom'
  | 'tool_access'
  | 'webhook';

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

export interface GuardrailModerationPolicyConfig extends GuardrailPolicyBase<'moderation'> {
  modelKey?: string;
  categories: Record<string, boolean>;
}

export interface GuardrailPromptShieldPolicyConfig extends GuardrailPolicyBase<'prompt_shield'> {
  modelKey?: string;
  sensitivity: 'low' | 'balanced' | 'high';
}

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

export type GuardrailPolicy =
  | GuardrailPiiPolicyConfig
  | GuardrailSecretsPolicyConfig
  | GuardrailWordFilterPolicyConfig
  | GuardrailRegexPolicyConfig
  | GuardrailModerationPolicyConfig
  | GuardrailPromptShieldPolicyConfig
  | GuardrailCustomPolicyConfig
  | GuardrailToolAccessPolicyConfig
  | GuardrailWebhookPolicyConfig;

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

export type AlertModule = 'models' | 'inference' | 'guardrails' | 'rag' | 'mcp' | 'analysis' | 'evaluation' | 'redteam' | 'aegis' | 'ai-app-gateway';

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
  | 'appgw_requests_per_user';

export type AlertConditionOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq';

export interface IAlertCondition {
  operator: AlertConditionOperator;
  threshold: number;
}

export type IAlertChannel =
  | { type: 'email'; recipients: string[] };

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
  channels: IAlertChannel[];
  lastTriggeredAt?: Date;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
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

export interface IAgentConfig {
  /** Required for native agents; omitted/empty for connected (external) agents. */
  modelKey?: string;
  systemPrompt?: string;
  promptKey?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  /** RAG module key – attached as a retrieval tool */
  knowledgeEngineKey?: string;
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

export interface IAgentConversation {
  _id?: ObjectId | string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  title?: string;
  messages: Array<{
    role: string;
    content: string;
    /** Reasoning / "thinking" trace for assistant messages from reasoning models. */
    reasoning?: string;
    timestamp: Date;
  }>;
  metadata?: Record<string, unknown>;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ── Incident types ──────────────────────────────────────────────────────

export type IncidentStatus = 'open' | 'acknowledged' | 'investigating' | 'resolved' | 'closed';
export type IncidentSeverity = 'critical' | 'warning' | 'info';

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
  metadata?: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
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
  /** Auto-close after this many ms of inactivity. Defaults via config. */
  idleTimeoutMs?: number;
  /** Hard upper bound on session lifetime (ms). */
  maxLifetimeMs?: number;
  /** Default per-action timeout (click/hover/type/snapshot). Defaults via config. */
  actionTimeoutMs?: number;
  /** Default navigation timeout (goto). Defaults via config. */
  navigationTimeoutMs?: number;
  access?: IBrowserAccessRules;
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
  /** Narrow extraction to the main content region (drops nav/header/footer). */
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
  /** Built-in categories toggled on/off. Keys are category ids (e.g. 'email'). */
  categories: Record<string, boolean>;
  /** Custom regex patterns defined per tenant. */
  customPatterns?: IPiiCustomPattern[];
  /** Languages to scan for. 'global' is always included. Empty = all. */
  languages?: PiiLanguage[];
  /** Whether the policy is enabled overall. */
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
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
