/**
 * The compatibility contract between the legacy guardrail columns and the v2
 * hook plane, in BOTH directions.
 *
 * Every guardrail row written before the hook plane shipped goes through
 * `ensureHooks()` on every read, and every save that touches `hooks` goes back
 * through `projectHooksToLegacy()`. Those two functions are why this change
 * needs no data migration and why an older console binary pointed at the same
 * tenant database keeps working.
 *
 * READ PATH (lift) — pure, deterministic, side-effect free, and NEVER
 * persisted from the evaluate path. `hooksVersion` 0/absent means "derived",
 * so the derivation re-runs on every read and a later fix to it reaches every
 * un-edited record. Deriving-and-persisting per evaluation would be a write
 * per request against Cosmos (an RU outage) AND would freeze each row against
 * the next fix.
 *
 * WRITE PATH (projection) — runs on every save that touches `hooks`, so the
 * legacy columns are never stale. The readers that depend on them are the ones
 * it is not safe to edit:
 *   · moderationApi.ts:88-90 — the /v1/moderations fallback scan, which
 *     requires `type === 'preset' && policy.moderation.enabled`
 *   · the AI App Gateway's finding-shape filter (`finding.type !== 'pii'`)
 *   · the dashboard list/edit screens and `GuardrailView`
 *   · an OLDER console binary running against the same tenant DB
 *
 * THE DIRECTION RULE is the single most dangerous line in this file; see
 * `liftLegacyPolicies` for the four-way verification behind it.
 */

// The barrel is imported for `runWithTenantScope` ONLY, and only the two async
// functions at the bottom of this file reach for it. `switchToTenant` is not an
// option here: it is `enterWith` under the hood, whose documented failure mode
// under concurrency is cross-tenant reads, and the lift runs from SDK and tool
// frames that the console's request ALS does not own. Types come from the
// narrow `provider/types.domain` path so the pure half of this file stays
// independent of a module that constructs providers on load.
import { runWithTenantScope } from '@/lib/database';
import type {
  GuardrailAction,
  GuardrailFailMode,
  IGuardrail,
  IGuardrailModerationPolicy,
  IGuardrailPiiPolicy,
  IGuardrailPresetPolicy,
  IGuardrailPromptShieldPolicy,
  IGuardrailWordFilterPolicy,
  IPiiPolicy,
  PiiAction,
} from '@/lib/database/provider/types.domain';
import { createLogger } from '@/lib/core/logger';
import {
  POLICY_VALID_HOOKS,
  BLOCK_MESSAGE_VARS,
  DEFAULT_STREAM_SETTINGS,
  GUARDRAIL_CONTRACT_VERSION,
  HOOK_IDS,
  REGEX_MAX_MATCH_CHARS,
  STREAM_ELIGIBLE_FAMILIES,
  normalizeHooksConfig,
  policyMaxMatchChars,
  foldActions,
  hookDirection,
  toLegacyAction,
} from './contract';
import type {
  PolicyFamily,
  CustomPolicyConfig,
  GuardrailPolicy,
  GuardrailHooksConfig,
  HookBinding,
  HookId,
  HookSchedule,
  IGuardrailV2,
  ModerationPolicyConfig,
  PiiPolicyConfig,
  PromptShieldPolicyConfig,
  SafetyAction,
  SecretsPolicyConfig,
  WordFilterPolicyConfig,
} from './contract';

const logger = createLogger('guardrail-legacy-lift');

// ── PII category translation ──────────────────────────────────────────────

/**
 * LEGACY PII CATEGORY MAP. Verified id-by-id against BOTH catalogs:
 * `guardrail/types.ts:12-103` (the 15 legacy ids) and
 * `pii/categories.ts:97-318` (the 18 PII-service ids).
 *
 * FOUR ids differ, and copying the map verbatim disables exactly those four
 * with no error and a green UI: the PII service's `pickActiveBuiltins`
 * (`pii/detector.ts:98-106`) keeps only catalog categories whose id is
 * `=== true` in the map, so an id it does not recognise is silently ignored
 * rather than rejected.
 *
 * `tckn` is the fleet-wide one: it is `defaultEnabled: true` (`types.ts:53`)
 * and `buildDefaultPresetPolicy()` (`guardrailService.ts:54-92`) writes every
 * catalog id into every preset, so essentially every guardrail in existence
 * carries `tckn: true`. Getting this wrong takes Turkish national-ID detection
 * to zero across the whole fleet.
 *
 * The map is TOTAL over the legacy catalog (all 15 ids appear) and INJECTIVE
 * (15 distinct targets), which is what makes the inverse below well-defined.
 * `tr_phone`, `tr_iban` and `de_phone` have no legacy counterpart and are
 * therefore unreachable from a lifted policy — they are opt-in additions an
 * operator makes on the generated policy afterwards.
 */
export const LEGACY_PII_CATEGORY_MAP: Readonly<Record<string, string>> = {
  email: 'email',
  phone: 'phone',
  creditCard: 'creditCard',
  iban: 'iban',
  swift: 'swift',
  birthDate: 'birthDate',
  ipAddress: 'ipAddress',
  url: 'url',
  socialHandle: 'socialHandle',
  apiKey: 'apiKey',
  cryptoWallet: 'cryptoWallet',
  // ── the four that differ ──
  nationalId: 'ssn_us',
  tckn: 'tc_kimlik',
  passport: 'passport_en',
  address: 'address_en',
};

/** Derived, so the two directions can never disagree. */
const PII_CATEGORY_MAP_REVERSE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LEGACY_PII_CATEGORY_MAP).map(([legacyId, serviceId]) => [serviceId, legacyId]),
);

/**
 * Legacy category map -> PII-service category map.
 *
 * Only enabled entries survive: the PII detector treats an absent id and an id
 * set to `false` identically (`config.categories?.[c.id] === true`), so
 * dropping the `false` entries is lossless and keeps the generated policy
 * readable. An id in neither catalog (a hand-edited row, or one written by a
 * build that had a category this one does not) is dropped — there is nothing
 * to map it onto, and inventing a passthrough id would produce a policy whose
 * UI shows a category that can never match.
 */
export function mapLegacyPiiCategories(
  src: Record<string, boolean> | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [legacyId, on] of Object.entries(src ?? {})) {
    const mapped = LEGACY_PII_CATEGORY_MAP[legacyId];
    if (mapped && on) out[mapped] = true;
  }
  return out;
}

/**
 * The reverse, for the downward projection. Service ids with no legacy
 * counterpart (`tr_phone`, `tr_iban`, `de_phone`, and any tenant custom
 * pattern) are dropped: the legacy detector has no pattern for them, so
 * naming them in the legacy column would advertise a policy an older binary
 * cannot run.
 */
export function invertPiiCategories(
  src: Record<string, boolean> | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [serviceId, on] of Object.entries(src ?? {})) {
    const legacyId = PII_CATEGORY_MAP_REVERSE[serviceId];
    if (legacyId && on) out[legacyId] = true;
  }
  return out;
}

/**
 * `GuardrailAction` -> `PiiAction`. `warn` and `flag` both become `detect`:
 * the PII service has no non-enforcing-but-noisy rung, and `detect` is the one
 * that reports findings without touching the text — which is exactly what the
 * legacy detector did for those two actions (it emitted findings with
 * `block: false` and no redaction).
 */
export function legacyPiiAction(action: GuardrailAction | undefined): PiiAction {
  switch (action) {
    case 'block':
      return 'block';
    case 'redact':
      return 'redact';
    default:
      return 'detect';
  }
}

// ── The generated PII policy ──────────────────────────────────────────────

/**
 * DETERMINISTIC, so the lift is idempotent and so `liftLegacyPolicies` can name
 * the policy a policy will reference before provisioning has been attempted (or
 * after it has failed). Deliberately NOT routed through
 * `generateUniqueSlugKey`, which would silently produce
 * `pii-migrated-x-1` on a collision and point the policy at a key nobody
 * created. Guardrail keys are already slugs, so the result is one too.
 */
export function liftedPiiPolicyKey(guardrailKey: string): string {
  return `pii-migrated-${guardrailKey}`;
}

/**
 * A short TTL memo of provisioning outcomes. `ensureLiftedPiiPolicy` sits on
 * the READ path (every evaluation of a legacy PII guardrail), so without this
 * every request pays a `findPiiPolicyByKey` round trip — the same reasoning as
 * `wordListService.ts:219-268`.
 *
 * Failures are cached far more briefly than successes so a transient DB
 * outage self-heals within seconds instead of pinning the guardrail into its
 * degraded state for a minute, while still preventing a create-storm against a
 * database that is refusing writes.
 */
const POLICY_CACHE_TTL_MS = 60_000;
const POLICY_CACHE_FAILURE_TTL_MS = 5_000;
const liftedPolicyCache = new Map<string, { policyKey: string | null; expiresAt: number }>();

/**
 * Provisioning runs in progress, keyed like `liftedPolicyCache`; the token is
 * the run's WRITE PERMIT. Invalidation drops matching tokens, and a run whose
 * token is gone by the time it would `remember` returns its answer to its own
 * caller but does not cache it — a save racing a cold read must not be undone
 * for a minute by the pre-save read it raced.
 */
const liftInflight = new Map<string, symbol>();

function policyCacheKey(tenantDbName: string, guardrailKey: string): string {
  return `${tenantDbName}:${guardrailKey}`;
}

/** Called by the save path when a guardrail or PII policy changes. */
export function invalidateLiftedPiiPolicyCache(tenantDbName?: string, guardrailKey?: string): void {
  if (tenantDbName && guardrailKey) {
    const cacheKey = policyCacheKey(tenantDbName, guardrailKey);
    liftedPolicyCache.delete(cacheKey);
    liftInflight.delete(cacheKey);
    return;
  }
  if (tenantDbName) {
    const prefix = `${tenantDbName}:`;
    for (const key of liftedPolicyCache.keys()) {
      if (key.startsWith(prefix)) liftedPolicyCache.delete(key);
    }
    for (const key of liftInflight.keys()) {
      if (key.startsWith(prefix)) liftInflight.delete(key);
    }
    return;
  }
  liftedPolicyCache.clear();
  liftInflight.clear();
}

/**
 * Provisions (once, idempotently) the PII policy a lifted `pii` policy
 * references, and returns its key.
 *
 * `languages` is OMITTED, not narrowed. Verified at `pii/categories.ts:336-343`:
 * `filterCategoriesByLanguages` returns the FULL catalog when the requested set
 * is empty, and `tc_kimlik` / `tr_phone` / `tr_iban` are `languages: ['tr']`, so
 * ANY narrower set silently drops Turkish national-ID detection. The legacy
 * detector was language-independent, so "all languages" is the only
 * behaviour-preserving choice.
 *
 * FAIL CLOSED. On failure this returns null, and the caller does NOT drop the
 * policy: `liftLegacyPolicies` still emits the `pii` policy pointing at the
 * deterministic key, the engine finds no policy behind it, applies the policy's
 * `failMode` and records a `degraded` entry. A guardrail that was blocking PII
 * yesterday must never fall silent — and because the key is deterministic, the
 * policy starts working again by itself the moment provisioning succeeds on a
 * later read.
 */
export async function ensureLiftedPiiPolicy(
  tenantDbName: string,
  tenantId: string,
  record: IGuardrail,
): Promise<string | null> {
  const pii = record.policy?.pii;
  if (!pii?.enabled) return null;

  const key = liftedPiiPolicyKey(record.key);
  const cacheKey = policyCacheKey(tenantDbName, record.key);
  const now = Date.now();
  const cached = liftedPolicyCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.policyKey;

  const token = Symbol('lifted-pii-policy-load');
  liftInflight.set(cacheKey, token);

  const remember = (policyKey: string | null): string | null => {
    // Invalidated or superseded while this run was in flight: the answer is
    // still THIS caller's, but it may predate a save, so it is not cached.
    if (liftInflight.get(cacheKey) !== token) return policyKey;
    liftInflight.delete(cacheKey);
    liftedPolicyCache.set(cacheKey, {
      policyKey,
      expiresAt:
        Date.now() + (policyKey ? POLICY_CACHE_TTL_MS : POLICY_CACHE_FAILURE_TTL_MS),
    });
    return policyKey;
  };

  try {
    return await runWithTenantScope(tenantDbName, async (db) => {
      // Project first, then tenant-wide — the same fallback
      // `resolveCustomWordLists` uses, because `findPiiPolicyByKey` with a
      // project emits `projectId = @projectId` and would otherwise miss a
      // tenant-level policy from a project-scoped guardrail. `null`, not
      // undefined, for the fallback: it must match the row NO project owns,
      // never the first row of some other project that shares the key.
      const existing =
        (await db.findPiiPolicyByKey(key, record.projectId)) ??
        (record.projectId !== undefined ? await db.findPiiPolicyByKey(key, null) : null);
      if (existing) return remember(existing.key);

      const created = await db.createPiiPolicy({
        tenantId,
        projectId: record.projectId,
        key,
        name: `PII (migrated from “${record.name}”)`,
        description:
          'Generated from a pre-hook-plane guardrail’s inline PII category list. ' +
          'Editing it changes what that guardrail detects.',
        defaultAction: legacyPiiAction(pii.action),
        // `apiKey` is served by the lifted `legacy:secrets` policy (the secrets
        // family IS the legacy credential detector); keeping it here too made
        // the DB-backed PII pass scan every credential a second time.
        categories: (() => {
          const cats = mapLegacyPiiCategories(pii.categories);
          if (pii.categories?.apiKey) delete cats.apiKey;
          return cats;
        })(),
        customPatterns: [],
        // `languages` is intentionally absent — see the doc comment. Writing
        // [] means the same thing today, but writing a NARROWER set later
        // would be the silent regression this comment exists to prevent.
        enabled: true,
        metadata: { generatedBy: 'guardrail-hook-lift', sourceGuardrailKey: record.key },
        createdBy: record.createdBy,
      });
      return remember(created.key);
    });
  } catch (error) {
    // A concurrent lift for the same guardrail is the expected loser here:
    // re-read before giving up, so a create race resolves to the winner's row
    // instead of degrading a guardrail that is perfectly fine.
    try {
      const recovered = await runWithTenantScope(tenantDbName, (db) =>
        db.findPiiPolicyByKey(key, record.projectId),
      );
      if (recovered) return remember(recovered.key);
    } catch {
      // fall through to the degraded path below
    }
    logger.error('Failed to provision lifted PII policy', {
      error,
      guardrailKey: record.key,
      policyKey: key,
      tenantDbName,
    });
    return remember(null);
  }
}

// ── LEGACY -> HOOKS ───────────────────────────────────────────────────────

/**
 * Lifted policies and bindings are synchronous and blocking, which is what today
 * is: `evaluateGuardrail` awaits every policy inline and a `block: true` finding
 * stops the request.
 *
 * Every consumer gets its OWN copy of this (and of the hooks array, and of the
 * binding) rather than a shared reference. The lifted config is handed straight
 * to the edit screen, where toggling one policy's schedule must not toggle all
 * five — an aliasing bug that only shows up in the UI, after a lift, on a row
 * nobody has saved yet.
 */
const SYNC_BLOCK: HookSchedule = { timing: 'sync', onFail: 'block' };
const syncBlock = (): HookSchedule => ({ ...SYNC_BLOCK });

/**
 * THE DIRECTION RULE. Every lifted policy binds to BOTH `input.pre` AND
 * `output.pre`, regardless of `record.target`. Verified four ways:
 *
 *   · `guardrailService.ts:264-396` (`evaluateGuardrail`) NEVER reads
 *     `record.target`. Direction comes purely from the binding SLOT —
 *     `inferenceService.ts:1066` (`inputGuardrailKey`) / `:1579`
 *     (`outputGuardrailKey`), `agentService.ts:1421` / `:1510` — and the
 *     evaluation log persists `target: phase` (`:247`), not `record.target`.
 *   · `inferenceService.ts:81-84` says so in prose: "The direction is decided
 *     by the slot it is bound to".
 *   · `target` is not settable through the API at all: the string does not
 *     appear anywhere in `plugins/guardrails.ts`, and `guardrailService.ts:119`
 *     defaults `target: input.target ?? 'input'` — so essentially EVERY
 *     existing row is `target: 'input'`.
 *   · `provider/types.extended.ts:73` documents the phase as "decided by the
 *     binding slot, not the guardrail".
 *
 * A target-driven lift would therefore bind essentially the entire fleet to
 * `input.pre` only, and every guardrail attached through `outputGuardrailKey`
 * would evaluate zero policies: silent, total loss of output enforcement on
 * upgrade, with a green UI. `record.target` survives only as
 * `metadata.legacyTarget`, for UI defaults.
 */
export function liftLegacyPolicies(
  record: IGuardrail,
  piiPolicyKey: string | undefined,
): GuardrailPolicy[] {
  const out: GuardrailPolicy[] = [];
  // The two hooks `liftLegacyBindings` enables, and no others — a lifted policy
  // naming a hook with no binding would be the silent no-op the save-time
  // validator exists to reject. `prompt.pre` is deliberately not among them;
  // see `liftLegacyBindings`.
  const both = (): HookId[] => ['input.pre', 'output.pre'];

  if (record.type === 'preset' && record.policy) {
    const { pii, wordFilter, moderation, promptShield } = record.policy;

    // The order below IS the execution order AND the finding order. Do not
    // sort: `logEvaluation` persists `findings[0]?.message`
    // (guardrailService.ts:259) and both `buildUserMessage` copies render from
    // the head of the list, so re-ordering changes what an end user is told.
    if (pii?.enabled) {
      // `apiKey` is the one legacy category whose detector was never the PII
      // pattern table alone: it ran KNOWN_SECRET_PATTERNS plus the entropy
      // heuristic, which is exactly the `secrets` policy emitted below. When
      // that policy is on, the credential scan belongs to it ALONE — mapping
      // `apiKey` onto the PII side as well scanned every key twice and reported
      // two `high` findings (risk 70 for one credential, double-counted logs).
      const secretsEnabled = Boolean(pii.categories?.apiKey);
      const legacyCategories = mapLegacyPiiCategories(pii.categories);
      if (secretsEnabled) delete legacyCategories.apiKey;

      out.push({
        id: 'legacy:pii',
        family: 'pii',
        enabled: true,
        hooks: both(),
        schedule: syncBlock(),
        action: pii.action ?? 'block', // piiDetector.ts:232
        failMode: record.failMode,
        // Never undefined: falling back to the deterministic key keeps the
        // policy in the list when provisioning failed, so the engine degrades
        // it under `failMode` instead of the lift silently dropping the only
        // PII enforcement this guardrail had.
        piiPolicyKey: piiPolicyKey ?? liftedPiiPolicyKey(record.key),
        detectObfuscated: true,
        // The DB-free fallback. Provisioning the policy above is a write, and a
        // write can fail on a row that has been enforcing PII without one for
        // months; carrying the mapped categories on the policy means such a
        // failure degrades to "scanned statelessly with exactly the legacy
        // category set" instead of "PII silently stopped being detected".
        legacyCategories,
      } satisfies PiiPolicyConfig);

      // KNOWN_SECRET_PATTERNS (piiDetector.ts:56-64) used to ride INSIDE
      // runPiiDetection and fired only for the `apiKey` category
      // (`findMatches`, :100-104). Split out into its own family so it can run
      // without a database, gated on exactly what selected it before.
      out.push({
        id: 'legacy:secrets',
        family: 'secrets',
        enabled: secretsEnabled,
        hooks: both(),
        schedule: syncBlock(),
        action: pii.action ?? 'block',
        failMode: record.failMode,
        known: true,
        genericHighEntropy: true,
      } satisfies SecretsPolicyConfig);
    }

    if (wordFilter?.enabled) {
      out.push({
        id: 'legacy:word_filter',
        family: 'word_filter',
        enabled: true,
        hooks: both(),
        schedule: syncBlock(),
        // VERIFIED wordFilter.ts:209 — `const action = (policy.action ??
        // 'block')`, NOT `record.action`. The word filter has always defaulted
        // to blocking independently of the record, so a tenant with
        // `action: 'flag'` and `wordFilter.enabled: true` is blocking banned
        // words today (:223, :242, :265 emit `block: action === 'block'`).
        // Using `record.action` here silently un-blocks every one of them.
        action: wordFilter.action ?? 'block',
        failMode: record.failMode,
        builtinLists: wordFilter.builtinLists,
        customListKeys: wordFilter.customListKeys,
        words: wordFilter.words,
        regexes: wordFilter.regexes,
      } satisfies WordFilterPolicyConfig);
    }

    if (moderation?.enabled) {
      out.push({
        id: 'legacy:moderation',
        family: 'moderation',
        enabled: true,
        hooks: both(),
        schedule: syncBlock(),
        // The LLM families DO take the record action: it is what
        // `guardrailService.ts:339` hands `runModerationPolicy`.
        action: record.action,
        failMode: record.failMode,
        modelKey: moderation.modelKey ?? record.modelKey,
        categories: moderation.categories ?? {},
      } satisfies ModerationPolicyConfig);
    }

    if (promptShield?.enabled) {
      out.push({
        id: 'legacy:prompt_shield',
        family: 'prompt_shield',
        enabled: true,
        hooks: both(),
        schedule: syncBlock(),
        action: record.action,
        failMode: record.failMode,
        modelKey: promptShield.modelKey ?? record.modelKey,
        sensitivity: promptShield.sensitivity ?? 'balanced',
      } satisfies PromptShieldPolicyConfig);
    }
  }

  if (record.type === 'custom' && record.customPrompt) {
    out.push({
      id: 'legacy:custom',
      family: 'custom',
      enabled: true,
      hooks: both(),
      schedule: syncBlock(),
      action: record.action,
      failMode: record.failMode,
      modelKey: record.modelKey,
      prompt: record.customPrompt,
      // Reproduces guardrailService.ts:358 exactly: `record.type === 'custom'
      // && record.customPrompt && llmCtx` — with no modelKey there is no
      // llmCtx, the policy evaluates nothing and the content passes. The quirk
      // is preserved for lifted rows and dies for authored ones, which get
      // 'error_finding'.
      onMissingModel: 'skip',
    } satisfies CustomPolicyConfig);
  }

  return out;
}

/**
 * Both directions, no timeout. `timeoutMs: 0` matches today exactly —
 * `evaluateGuardrail` awaits its LLM policies with a bare `Promise.all` and no
 * budget. Introducing one here would be a behaviour change on upgrade (a slow
 * moderation model that passes today would start failing under `failMode`);
 * the fix belongs on the authored path, where `budgetMs` is opt-in.
 *
 * EXACTLY TWO HOOKS, and the list does not grow when the contract does. It
 * binds nothing to `tool.pre`/`tool.post`, and — for the same reason — nothing
 * to `prompt.pre`: a row written before a hook existed never opted into it, and
 * lifting it there would hand the tenant a new evaluation, a new evaluation-log
 * row and a new usage event per run for a policy they did not ask for. Worse
 * for `prompt.pre` specifically, the lifted policies include the LLM families, so
 * the surprise would be a model call. An operator who wants the new hook binds
 * it deliberately, on an authored config.
 */
export function liftLegacyBindings(): Partial<Record<HookId, HookBinding>> {
  const binding = (): HookBinding => ({ enabled: true, schedule: syncBlock(), timeoutMs: 0 });
  return { 'input.pre': binding(), 'output.pre': binding() };
}

export function liftLegacyHooks(record: IGuardrail, piiPolicyKey?: string): GuardrailHooksConfig {
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    policies: liftLegacyPolicies(record, piiPolicyKey),
    bindings: liftLegacyBindings(),
    // Real-time streaming enforcement stays OFF for lifted rows, so no
    // tenant's streaming behaviour changes on upgrade: today a streamed answer
    // is audited post-hoc, never held back. Newly created guardrails default
    // to true.
    stream: { enabled: false },
    // FALSE, deliberately, even though `true` is the default for authored
    // configs: `evaluateGuardrail` runs every policy and collects every
    // finding, and stopping at the first block would shorten the persisted
    // findings array of every legacy row. That is observable — the evaluation
    // log is an audit trail, and `/v1/moderations` builds its category map
    // from the moderation findings (moderationApi.ts:100-107), which a PII
    // block earlier in the list would short-circuit away.
    shortCircuit: false,
  };
}

/**
 * The read-path resolver, and the ONLY way the engine obtains a hooks config.
 * Pure, synchronous and non-mutating: the record it is handed comes out of a
 * shared TTL cache, so writing `hooks` onto it in place would publish a
 * derived config to every other holder of that object.
 *
 * `hooksVersion >= 1` means an operator authored the config and it is used
 * verbatim. A version marker with no usable `policies` array is treated as
 * absent rather than trusted — that is the same fail-safe the SQLite row
 * mapper applies when it maps an empty `'{}'` column to `undefined`, and the
 * alternative is a guardrail that evaluates nothing because a write dropped
 * one column.
 */
export function ensureHooks(
  record: IGuardrailV2,
  piiPolicyKey?: string,
): IGuardrailV2 & { hooks: GuardrailHooksConfig; hooksVersion: number } {
  const version = record.hooksVersion ?? 0;
  // THE read-path chokepoint for the `check` -> `policy` rename. A row authored
  // before it stores `hooks.checks` / `family: 'tool_policy'` / `policyKey`;
  // without this the `Array.isArray` gate below sees no policies, decides the
  // config is unauthored, and lifts the legacy columns over the top of an
  // operator's actual configuration. Non-mutating, and it returns the same
  // object when there is nothing to re-spell.
  const hooks = normalizeHooksConfig(record.hooks);
  if (version >= 1 && hooks && Array.isArray(hooks.policies)) {
    return { ...record, hooks, hooksVersion: version };
  }
  return { ...record, hooks: liftLegacyHooks(record, piiPolicyKey), hooksVersion: 0 };
}

// ── HOOKS -> LEGACY ───────────────────────────────────────────────────────

/**
 * Extra facts the downward projection cannot derive from `hooks` alone.
 *
 * `projectHooksToLegacy` is synchronous and DB-free by design (it runs inside
 * the same save that writes the row), so the RESOLVED PII policy has to be
 * handed in. Without it the projection preserves the legacy category map it
 * found rather than guessing — losing an operator's category selection to a
 * caller that simply did not fetch the policy would be worse than leaving it
 * one save stale.
 */
export interface LegacyProjectionContext {
  piiPolicy?: Pick<IPiiPolicy, 'categories'>;
}

/** A hook runs iff it has an ENABLED binding and an enabled policy names it. */
function activeHooks(hooks: GuardrailHooksConfig): HookId[] {
  const policies = hooks.policies ?? [];
  return HOOK_IDS.filter(
    (hook) =>
      hooks.bindings?.[hook]?.enabled === true &&
      policies.some((policy) => policy.enabled && policy.hooks?.includes(hook)),
  );
}

function enabledOfFamily<F extends PolicyFamily>(
  hooks: GuardrailHooksConfig,
  family: F,
): Array<Extract<GuardrailPolicy, { family: F }>> {
  return (hooks.policies ?? []).filter(
    (policy): policy is Extract<GuardrailPolicy, { family: F }> =>
      policy.enabled && policy.family === family,
  );
}

/**
 * A policy with no explicit `action` inherits the record-level one, so the
 * record action is the right value to fold in for it — that inheritance is
 * semantic, not the seeded reduce this projection exists to avoid.
 */
function foldPolicyActions(
  policies: readonly GuardrailPolicy[],
  recordAction: GuardrailAction,
): SafetyAction {
  return foldActions(policies.map((policy): SafetyAction => policy.action ?? recordAction));
}

/**
 * `'closed'` wins over `'open'`. The legacy column is read by builds that
 * apply ONE fail mode to the whole guardrail, and of the two errors —
 * over-blocking on an evaluator outage vs. silently passing content the
 * operator marked fail-closed — only the second defeats the control.
 */
function foldFailModes(
  policies: readonly GuardrailPolicy[],
  current: GuardrailFailMode | undefined,
): GuardrailFailMode | undefined {
  const declared = policies.map((policy) => policy.failMode).filter(Boolean);
  if (declared.length === 0) return current;
  return declared.includes('closed') ? 'closed' : 'open';
}

/**
 * A family-level model pin is only written when it actually differs from the
 * record-level key. The lift copies `moderation.modelKey ?? record.modelKey`
 * into the policy, so writing that back unconditionally would PIN a policy that
 * had merely inherited — and the pin would then survive the operator changing
 * the guardrail's model, which reads as "my model change did nothing".
 */
function projectPin(
  policyModelKey: string | undefined,
  recordModelKey: string | undefined,
  currentPin: string | undefined,
): string | undefined {
  if (policyModelKey === undefined) return currentPin;
  if (policyModelKey === recordModelKey) return currentPin;
  return policyModelKey;
}

/** Families with no legacy representation at all. */
const HOOK_ONLY_FAMILIES: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>([
  'regex',
  'tool_access',
  'webhook',
]);

/**
 * HOOKS -> LEGACY. Runs on EVERY create/update that touches `hooks`, so the
 * legacy columns never go stale.
 *
 * `action` is RECOMPUTED FROM SCRATCH each time, never reduced from the
 * current value. Seeding the fold with `current.action` and only swapping
 * upward — the obvious implementation — means softening a guardrail from
 * `block` to `flag` leaves `action: 'block'` in the column forever, so the AI
 * App Gateway that reads the column keeps blocking on findings the operator
 * downgraded months ago.
 *
 * `type` is `'custom'` only when the single enabled policy IS a custom prompt;
 * otherwise `'preset'`, because `moderationApi.ts:88-90`'s fallback scan
 * requires `type === 'preset'` and a mis-typed row silently removes the
 * guardrail from `/v1/moderations` discovery.
 *
 * Lossy downward by construction: `regex`, `tool_access` and `webhook` have no
 * legacy shape. Their ids go in `metadata.hookOnlyPolicies` so the UI can say
 * "this guardrail has policies an older build cannot run" instead of an older
 * build simply not running them.
 */
export function projectHooksToLegacy(
  hooks: GuardrailHooksConfig,
  current: IGuardrail,
  context: LegacyProjectionContext = {},
): Pick<
  IGuardrail,
  'type' | 'target' | 'action' | 'failMode' | 'modelKey' | 'policy' | 'customPrompt' | 'metadata'
> {
  const policies = hooks.policies ?? [];
  const enabled = policies.filter((policy) => policy.enabled);

  const piiPolicies = enabledOfFamily(hooks, 'pii');
  const secretPolicies = enabledOfFamily(hooks, 'secrets');
  const wordFilterPolicies = enabledOfFamily(hooks, 'word_filter');
  const moderationPolicies = enabledOfFamily(hooks, 'moderation');
  const promptShieldPolicies = enabledOfFamily(hooks, 'prompt_shield');
  const customPolicies = enabledOfFamily(hooks, 'custom');

  // ── type ──
  // With nothing enabled there is nothing to derive from, so the operator's
  // choice stands rather than being churned to 'preset' on every save.
  const type: IGuardrail['type'] =
    enabled.length === 0
      ? current.type
      : enabled.length === 1 && enabled[0].family === 'custom'
        ? 'custom'
        : 'preset';

  // ── target ──
  // Recomputed, and safe to recompute: nothing reads it. `evaluateGuardrail`
  // never consults it, the API never sets it, and the dashboard never renders
  // it — it exists as a UI hint, which is why the original value is preserved
  // in metadata.legacyTarget below.
  const active = activeHooks(hooks);
  const target: IGuardrail['target'] =
    active.length === 0
      ? current.target
      : active.some((hook) => hookDirection(hook) === 'input')
        ? 'input'
        : 'output';

  // ── action ──
  const action: GuardrailAction =
    enabled.length === 0 ? current.action : toLegacyAction(foldPolicyActions(enabled, current.action));

  // ── modelKey ──
  // Only ever filled in, never cleared: an older binary evaluating a
  // `type: 'custom'` row needs `record.modelKey` to build its LLM context at
  // all (guardrailService.ts:302-304, :358), so dropping it disables the policy
  // outright.
  const llmModelKey =
    [...moderationPolicies, ...promptShieldPolicies, ...customPolicies]
      .map((policy) => policy.modelKey)
      .find((key): key is string => Boolean(key));
  const modelKey = current.modelKey ?? llmModelKey;

  // ── policy ──
  // Each family keeps whatever configuration the legacy blob already carried
  // and only its `enabled` flag and its own fields are recomputed, so
  // disabling a policy does not destroy the category selections behind it.
  const currentPolicy: IGuardrailPresetPolicy = current.policy ?? {};

  // Every branch produces a FRESH map. The preserved one would otherwise be
  // the very object hanging off the caller's record, and `apiKey` is written
  // into it below — a projection has no business mutating a cached row.
  const preservedPiiCategories = { ...(currentPolicy.pii?.categories ?? {}) };
  const piiCategories: Record<string, boolean> =
    piiPolicies.length > 0
      ? // Without the resolved policy there is nothing to invert, so the legacy
        // map stands: one save stale beats losing an operator's selection to a
        // caller that simply did not fetch the policy.
        (context.piiPolicy ? invertPiiCategories(context.piiPolicy.categories) : preservedPiiCategories)
      : secretPolicies.length > 0
        ? // A standalone `secrets` policy has an honest legacy spelling — the
          // `apiKey` category IS the secret scan (piiDetector.ts:100-104 runs
          // KNOWN_SECRET_PATTERNS for it and nothing else) — so projecting it
          // keeps the gateway's PII-dimension filter seeing credentials on an
          // older build. Only that one category: carrying the rest over would
          // make an old build scan for PII this config no longer asks for.
          { apiKey: true }
        : // Nothing enabled: the selection is kept beside `enabled: false` so
          // re-enabling the policy later restores it, exactly as the other
          // families below behave.
          preservedPiiCategories;
  if (secretPolicies.length > 0) piiCategories.apiKey = true;

  const piiAndSecrets = [...piiPolicies, ...secretPolicies];
  const pii: IGuardrailPiiPolicy = {
    enabled: piiAndSecrets.length > 0,
    action:
      piiAndSecrets.length > 0
        ? toLegacyAction(foldPolicyActions(piiAndSecrets, current.action))
        : (currentPolicy.pii?.action ?? current.action),
    categories: piiCategories,
  };

  const wordFilter: IGuardrailWordFilterPolicy = {
    ...currentPolicy.wordFilter,
    enabled: wordFilterPolicies.length > 0,
    ...(wordFilterPolicies.length > 0
      ? {
          action: toLegacyAction(foldPolicyActions(wordFilterPolicies, current.action)),
          // The legacy blob has room for ONE word filter; several enabled
          // policies project as the UNION of their lists. A union can only make
          // an older build enforce more, never less.
          builtinLists: mergeFlags(wordFilterPolicies.map((policy) => policy.builtinLists)),
          customListKeys: mergeLists(wordFilterPolicies.map((policy) => policy.customListKeys)),
          words: mergeLists(wordFilterPolicies.map((policy) => policy.words)),
          regexes: mergeLists(wordFilterPolicies.map((policy) => policy.regexes)),
        }
      : {}),
  };

  const moderation: IGuardrailModerationPolicy = {
    enabled: moderationPolicies.length > 0,
    categories:
      moderationPolicies.length > 0
        ? mergeFlags(moderationPolicies.map((policy) => policy.categories))
        : (currentPolicy.moderation?.categories ?? {}),
    modelKey: projectPin(
      moderationPolicies[0]?.modelKey,
      modelKey,
      currentPolicy.moderation?.modelKey,
    ),
  };

  const promptShield: IGuardrailPromptShieldPolicy = {
    enabled: promptShieldPolicies.length > 0,
    sensitivity:
      promptShieldPolicies[0]?.sensitivity ?? currentPolicy.promptShield?.sensitivity ?? 'balanced',
    modelKey: projectPin(
      promptShieldPolicies[0]?.modelKey,
      modelKey,
      currentPolicy.promptShield?.modelKey,
    ),
  };

  // ── metadata ──
  // Returned MERGED, because both providers `$set` / overwrite the whole
  // column: returning only the new keys would delete everything else the
  // record carried.
  const currentMetadata = current.metadata ?? {};
  const hookOnlyPolicies = enabled
    .filter((policy) => HOOK_ONLY_FAMILIES.has(policy.family))
    .map((policy) => policy.id);
  const metadata: Record<string, unknown> = {
    ...currentMetadata,
    // Captured once, on the first projection, so the operator's original
    // direction survives the recomputation above.
    legacyTarget: currentMetadata.legacyTarget ?? current.target,
  };
  if (hookOnlyPolicies.length > 0) metadata.hookOnlyPolicies = hookOnlyPolicies;
  else delete metadata.hookOnlyPolicies;
  // The pre-rename key. Dropped unconditionally so a row that carried it does
  // not keep a second, stale copy of this list once it is re-saved.
  delete metadata.hookOnlyChecks;

  return {
    type,
    target,
    action,
    failMode: foldFailModes(enabled, current.failMode),
    modelKey,
    policy: { pii, wordFilter, moderation, promptShield },
    customPrompt: customPolicies[0]?.prompt ?? current.customPrompt,
    metadata,
  };
}

function mergeFlags(sources: Array<Record<string, boolean> | undefined>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const source of sources) {
    for (const [id, on] of Object.entries(source ?? {})) {
      out[id] = Boolean(out[id]) || on;
    }
  }
  return out;
}

function mergeLists(sources: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  for (const source of sources ?? []) {
    for (const value of source ?? []) if (!out.includes(value)) out.push(value);
  }
  return out;
}

// There is deliberately NO lazy "upgrade in place" here. A legacy row gains an
// authored `hooks` config only when an operator saves one through
// `PUT/PATCH /api/guardrails/:id`, which projects the legacy columns
// (`projectLegacyColumns`) and, via `guardrailService.updateGuardrail`,
// invalidates the record cache. A separate upgrader once lived here with no
// caller and no cache invalidation; the evaluate path lifts on every read
// instead (see the file header), so nothing needs it.

// ── Authoring-time validation ─────────────────────────────────────────────

/**
 * Applied ONLY to `hooksVersion >= 1`. Lifted rows pin detector-compatibility
 * settings that these rules would reject — a legacy moderation policy with no
 * model is a preserved quirk, not an authoring mistake — so running this over
 * a derived config would make un-editable exactly the rows that most need
 * editing.
 *
 * It also MUTATES `hooks.stream.holdBackChars` upward when a bound streaming
 * policy needs a bigger window. That is deliberate rather than a returned copy:
 * the hold-back is the entire streaming guarantee (no match can begin before
 * the write frontier and end after it if the withheld tail is at least as long
 * as the longest possible match), and a normalisation the caller has to
 * remember to apply is one a caller will eventually forget, leaving a stream
 * that reports enforcement it cannot deliver.
 */
/**
 * `GuardrailPolicy.message` — the per-policy block message.
 *
 * ONE rule: every `{{variable}}` must be in the CLOSED set. The interpolator
 * leaves an unrecognised one verbatim on purpose, so an operator who hoped for
 * `{{value}}` sees braces in the output rather than a hole; that is the right
 * runtime behaviour for a row already on disk, and the wrong thing to let
 * someone save on purpose. Rejecting it here costs nothing — the field is new,
 * so no stored row can carry one — and turns a message that renders as
 * `{{userName}}` in front of a customer into a 400 at save time.
 *
 * Blank is NOT an error: `selectBlockMessageTemplate` skips a whitespace layer,
 * so clearing the box means "go back to the inherited wording", which is the
 * behaviour the editor's Reset control depends on.
 *
 * The closed set exists because a template is tenant-editable and its output is
 * shown to end users: an interpolatable matched value would turn the guardrail
 * into an exfiltration channel for the data it exists to protect.
 */
function blockMessageErrors(message: unknown, label: string): string[] {
  if (message === undefined || message === null) return [];
  if (typeof message !== 'string') {
    return [`Policy "${label}" has a block message that is not text`];
  }
  const unknown = new Set<string>();
  // Constructed per call: a module-level /g regex carries `lastIndex` state.
  const pattern = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
  for (const match of message.matchAll(pattern)) {
    const name = match[1];
    if (name && !(BLOCK_MESSAGE_VARS as readonly string[]).includes(name)) unknown.add(name);
  }
  if (unknown.size === 0) return [];
  return [
    `Policy "${label}" has a block message using ${[...unknown]
      .map((name) => `{{${name}}}`)
      .join(', ')}, which ${unknown.size === 1 ? 'is not a' : 'are not'} available variable${
      unknown.size === 1 ? '' : 's'
    }. Available: ${BLOCK_MESSAGE_VARS.map((name) => `{{${name}}}`).join(', ')}`,
  ];
}

export function validateGuardrailHooks(hooks: GuardrailHooksConfig): string[] {
  const errors: string[] = [];

  if (hooks.contractVersion !== GUARDRAIL_CONTRACT_VERSION) {
    errors.push(
      `hooks.contractVersion must be ${GUARDRAIL_CONTRACT_VERSION} (got ${String(hooks.contractVersion)})`,
    );
  }

  const policies = Array.isArray(hooks.policies) ? hooks.policies : [];
  const bindings = hooks.bindings ?? {};
  const seenIds = new Set<string>();
  let requiredHoldBack = 0;

  for (const policy of policies) {
    const label = policy.id || `<unnamed ${policy.family}>`;

    if (!policy.id) {
      errors.push(`Every policy needs an id (${policy.family})`);
    } else if (seenIds.has(policy.id)) {
      // Ids appear on every finding and in the evaluation log; two policies
      // sharing one makes a finding untraceable to the rule that raised it.
      errors.push(`Duplicate policy id "${policy.id}"`);
    }
    if (policy.id) seenIds.add(policy.id);

    const validHooks = POLICY_VALID_HOOKS[policy.family];
    if (!validHooks) {
      errors.push(`Policy "${label}" has unknown family "${String(policy.family)}"`);
      continue;
    }

    if (!policy.hooks?.length) {
      errors.push(`Policy "${label}" is bound to no hook, so it can never run`);
    }
    for (const hook of policy.hooks ?? []) {
      if (!validHooks.includes(hook)) {
        errors.push(`Policy "${label}" (${policy.family}) cannot run on hook "${hook}"`);
      } else if (policy.enabled && bindings[hook]?.enabled !== true) {
        // An enabled policy whose hook is not bound is the silent no-op this
        // whole design exists to prevent: the UI shows it on, nothing runs it.
        errors.push(
          `Policy "${label}" is bound to "${hook}", which has no enabled binding on this guardrail`,
        );
      }
    }

    // Checked for a DISABLED policy too, unlike everything below it. The rules
    // below are "this policy cannot do its job"; this one is "this string is
    // wrong", and a wrong string is wrong whether or not it runs today. It also
    // means an operator cannot park a broken message and be surprised by it the
    // day they switch the policy back on.
    for (const error of blockMessageErrors(policy.message, label)) errors.push(error);

    if (!policy.enabled) continue;

    switch (policy.family) {
      case 'pii':
        // OWNER RULE, enforced here and nowhere else: an enabled PII policy
        // references a policy. There is no inline category list on new
        // configs — the PII service owns categories, languages, custom
        // patterns, checksum validators and mask strategies, and duplicating
        // any of that is how the two engines drift apart.
        if (!policy.piiPolicyKey?.trim()) {
          errors.push(`Policy "${label}" is a PII policy and needs a piiPolicyKey`);
        }
        break;
      case 'moderation':
      case 'prompt_shield':
      case 'custom':
        // Mirrors plugins/guardrails.ts:97-116: an LLM-backed policy with no
        // model reads as "guardrail active" while nothing runs.
        if (!policy.modelKey?.trim()) {
          errors.push(
            `Policy "${label}" (${policy.family}) is enabled but has no model to evaluate it`,
          );
        }
        if (policy.family === 'custom' && !policy.prompt?.trim()) {
          errors.push(`Policy "${label}" is a custom policy and needs a prompt`);
        }
        break;
      case 'regex':
        if (!policy.rules?.length) {
          errors.push(`Policy "${label}" is a regex policy with no rules`);
        }
        for (const rule of policy.rules ?? []) {
          // An uncompilable pattern is the worst kind of dead rule: the
          // matcher swallows the error and the rule simply never fires
          // (wordFilter.ts:253-257 does exactly that today).
          try {
            new RegExp(rule.pattern, rule.flags ?? '');
          } catch {
            errors.push(`Regex rule "${rule.id || rule.label}" is not a valid pattern`);
          }
          const declared = Number(rule.maxMatchChars);
          if (!Number.isFinite(declared) || declared <= 0) {
            errors.push(
              `Regex rule "${rule.id || rule.label}" must declare a positive maxMatchChars`,
            );
          } else if (declared > REGEX_MAX_MATCH_CHARS) {
            errors.push(
              `Regex rule "${rule.id || rule.label}" declares maxMatchChars ${declared}, above the ${REGEX_MAX_MATCH_CHARS} limit`,
            );
          }
        }
        break;
      case 'webhook':
        // https only: the verdict decides whether a request is blocked, so a
        // plaintext hop is an enforcement bypass, not just a privacy leak.
        if (!/^https:\/\//i.test(policy.url ?? '')) {
          errors.push(`Policy "${label}" must use an https:// webhook url`);
        }
        break;
      default:
        break;
    }

    if (policy.hooks?.includes('output.stream.delta')) {
      if (!STREAM_ELIGIBLE_FAMILIES.has(policy.family)) {
        errors.push(
          `Policy "${label}" (${policy.family}) cannot run on a stream: its matches have no bounded length in raw characters`,
        );
      } else {
        const max = policyMaxMatchChars(policy);
        if (max <= 0) {
          errors.push(
            `Policy "${label}" declares no bounded match length, so no hold-back window can make it correct on a stream`,
          );
        } else {
          requiredHoldBack = Math.max(requiredHoldBack, max);
        }
      }
    }
  }

  if (requiredHoldBack > 0) {
    // A policy bound to the delta hook with no stream block at all is a config
    // that asked for streaming enforcement without saying so; the binding is
    // the stronger statement of intent, so the block is created enabled.
    if (!hooks.stream) hooks.stream = { enabled: true };
    const configured = hooks.stream.holdBackChars ?? DEFAULT_STREAM_SETTINGS.holdBackChars;
    if (configured < requiredHoldBack) hooks.stream.holdBackChars = requiredHoldBack;
  }

  return errors;
}
