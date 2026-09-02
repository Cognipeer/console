/**
 * The guardrail service — CRUD, plus the LEGACY DOOR into the hook plane.
 *
 * `evaluateGuardrail` no longer evaluates anything. It resolves the record,
 * builds a `HookCall` and hands it to `runHook`; detection, ordering, fail
 * modes, redaction and the evaluation-log write all live in `hooks/engine.ts`.
 * That is the whole point of this file's shape: there is exactly ONE
 * evaluation path, so a guardrail cannot decide one thing when it is reached
 * through this function and another when it is reached through a tool hook, a
 * stream gate or the MCP seam.
 *
 * Everything the previous implementation did that callers can observe is
 * preserved deliberately, not incidentally — the thrown "not found" message,
 * the vacuous `disabled: true` result, `passed` meaning "no blocking finding"
 * rather than "not blocked", and `redactedText` appearing only when something
 * was actually rewritten. The tests and the two API plugins match on all four.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@/lib/database';
import type { IGuardrail, GuardrailType } from '@/lib/database';
import { resolveUsageAttribution } from '@/lib/services/usage/usageEvents';
import { generateUniqueSlugKey } from './keyGeneration';
import type {
  CreateGuardrailInput,
  UpdateGuardrailInput,
  GuardrailView,
  GuardrailEvaluationResult,
} from './types';
import {
  PII_CATEGORIES,
  MODERATION_CATEGORIES,
  WORD_FILTER_BUILTIN_LISTS,
} from './types';
import {
  GUARDRAIL_CONTRACT_VERSION,
  normalizeHooksConfig,
  textSubject,
} from './hooks/contract';
import type {
  PolicyFamily,
  GuardrailHooksConfig,
  HookActor,
  HookId,
  HookScope,
} from './hooks/contract';
import { DEFAULT_TOOL_GUARDRAIL_KEY, resolveGuardrail, runHook } from './hooks/engine';
import { invalidateGuardrailCache } from './hooks/recordCache';

// ── Serialization ─────────────────────────────────────────────────────────

export function serializeGuardrail(record: IGuardrail): GuardrailView {
  const { _id, ...rest } = record;
  const view = {
    ...rest,
    id: typeof _id === 'string' ? _id : (_id?.toString() ?? ''),
  } as GuardrailView;
  // The other read chokepoint for the `check` -> `policy` rename (the engine's
  // is `ensureHooks`). Every view the dashboard and both API surfaces return
  // comes through here, and the guardrail list counts `hooks.policies` off the
  // raw view — so without this a guardrail authored before the rename renders
  // as "0 policies" and its edit screen would save that back. Assigned in place
  // rather than spread so an absent config stays absent instead of becoming an
  // explicit `hooks: undefined`.
  if (view.hooks !== undefined) view.hooks = normalizeHooksConfig(view.hooks);
  return view;
}

// ── Key generation ────────────────────────────────────────────────────────

async function generateUniqueKey(
  tenantDbName: string,
  projectId: string | undefined,
  desiredKey: string,
): Promise<string> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return generateUniqueSlugKey(desiredKey, 'guardrail', async (candidate) => {
    // RESERVED. The default tool guardrail is pinned to this literal and
    // `ensureDefaultToolGuardrail` materialises it lazily as a tenant-wide row,
    // so an operator who named a guardrail "Tool safety (default)" first would
    // own the row every unbound tool call in the tenant is evaluated against —
    // and a `mode: 'disabled'` copy of it would disarm the sandbox toolbox.
    if (candidate === DEFAULT_TOOL_GUARDRAIL_KEY) return true;
    if (await db.findGuardrailByKey(candidate, projectId)) return true;
    // A project-scoped key must not shadow a tenant-wide one either: the
    // engine resolves project first and then falls back to the tenant-wide
    // row, so both would be reachable from one binding and which one answered
    // would depend on what the cache happened to hold. (A tenant-wide create
    // passes `undefined`, which already collides with a row of ANY project.)
    if (projectId !== undefined && (await db.findGuardrailByKey(candidate, null))) return true;
    return false;
  });
}

// ── Default policy builder ────────────────────────────────────────────────

export function buildDefaultPresetPolicy(): IGuardrail['policy'] {
  const piiCategories: Record<string, boolean> = {};
  for (const cat of PII_CATEGORIES) {
    piiCategories[cat.id] = cat.defaultEnabled;
  }

  const moderationCategories: Record<string, boolean> = {};
  for (const cat of MODERATION_CATEGORIES) {
    moderationCategories[cat.id] = cat.defaultEnabled;
  }

  const builtinLists: Record<string, boolean> = {};
  for (const list of WORD_FILTER_BUILTIN_LISTS) {
    builtinLists[list.id] = list.defaultEnabled;
  }

  return {
    pii: {
      enabled: true,
      action: 'block',
      categories: piiCategories,
    },
    wordFilter: {
      enabled: false,
      action: 'block',
      builtinLists,
      words: [],
      regexes: [],
    },
    moderation: {
      enabled: false,
      categories: moderationCategories,
    },
    promptShield: {
      enabled: false,
      sensitivity: 'balanced',
    },
  };
}

// ── Hook config on the write path ─────────────────────────────────────────

/**
 * Normalises an AUTHORED hook config on its way into the store.
 *
 * Two things are stamped here rather than left to the caller, because getting
 * either wrong is silent:
 *
 * 1. `hooksVersion`. `ensureHooks` re-derives the whole config from the legacy
 *    policy columns whenever the stored version is 0 — so a config saved with
 *    `hooks` but no `hooksVersion` would be written to the row, read back, and
 *    then thrown away on every evaluation while the edit screen kept showing
 *    it. There is no error anywhere in that loop.
 *
 * 2. `stream.enabled`. `DEFAULT_STREAM_SETTINGS.enabled` is FALSE — the right
 *    default for a LIFTED legacy row, which is what that constant exists for
 *    (a fleet of existing guardrails must not silently start holding back
 *    streamed tokens on upgrade). A newly AUTHORED guardrail is the opposite
 *    case: someone chose these policies now, and real-time blocking is the
 *    behaviour they expect. Only `create` applies it — re-defaulting on update
 *    would turn streaming back on for an operator who deliberately switched it
 *    off, which is the more expensive mistake of the two.
 */
function normalizeAuthoredHooks(
  hooks: GuardrailHooksConfig,
  options: { defaultStreamEnabled: boolean },
): GuardrailHooksConfig {
  return {
    ...hooks,
    contractVersion: hooks.contractVersion ?? GUARDRAIL_CONTRACT_VERSION,
    stream:
      hooks.stream ??
      (options.defaultStreamEnabled ? { enabled: true } : undefined),
  };
}

// ── CRUD operations ───────────────────────────────────────────────────────

export async function createGuardrail(
  tenantDbName: string,
  tenantId: string,
  createdBy: string,
  input: CreateGuardrailInput,
): Promise<GuardrailView> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  const key = await generateUniqueKey(tenantDbName, input.projectId, input.name);

  let policy = input.policy;
  if (input.type === 'preset' && !policy) {
    policy = buildDefaultPresetPolicy();
  }

  // A create with no `hooks` stays legacy-shaped on disk and is lifted on first
  // read. That is not a transitional wart: the legacy policy columns are still
  // what the preset editor writes, and a row that carries both would need the
  // two kept in sync by every future writer.
  const hooks = input.hooks
    ? normalizeAuthoredHooks(input.hooks, { defaultStreamEnabled: true })
    : undefined;

  const guardrail = await db.createGuardrail({
    tenantId,
    projectId: input.projectId,
    key,
    name: input.name,
    description: input.description,
    type: input.type,
    target: input.target ?? 'input',
    action: input.action,
    enabled: input.enabled ?? true,
    failMode: input.failMode ?? 'open',
    modelKey: input.modelKey,
    policy: input.type === 'preset' ? policy : undefined,
    customPrompt: input.type === 'custom' ? input.customPrompt : undefined,
    hooks,
    hooksVersion: hooks ? (input.hooksVersion ?? GUARDRAIL_CONTRACT_VERSION) : undefined,
    mode: input.mode,
    createdBy,
  });

  // The read path caches MISSES for 5s, so a key someone evaluated moments
  // before creating it would otherwise report "not found" — and the facade
  // turns that into a thrown error and a 404 — for several seconds after the
  // UI said the guardrail exists.
  invalidateGuardrailCache(tenantDbName, guardrail.key);

  return serializeGuardrail(guardrail);
}

export async function updateGuardrail(
  tenantDbName: string,
  id: string,
  updatedBy: string,
  input: UpdateGuardrailInput,
): Promise<GuardrailView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);

  // `hooks` is spread through verbatim when absent, so an update that only
  // renames a guardrail cannot clear its hook config. When it IS present the
  // version marker is stamped alongside it — writing the config without the
  // marker is the same silent discard described on `normalizeAuthoredHooks`.
  const hooks = input.hooks
    ? normalizeAuthoredHooks(input.hooks, { defaultStreamEnabled: false })
    : undefined;

  const updated = await db.updateGuardrail(id, {
    ...input,
    ...(hooks
      ? { hooks, hooksVersion: input.hooksVersion ?? GUARDRAIL_CONTRACT_VERSION }
      : {}),
    updatedBy,
  });

  if (!updated) return null;

  // THE invalidation that matters. The engine resolves records through a 60s
  // TTL cache, so without this an operator who disables a guardrail, softens
  // its action or edits its policies watches the old policy keep enforcing for
  // up to a minute with a UI that says otherwise. It lives here rather than in
  // the API plugin so every caller of this function is covered — including the
  // ones that do not exist yet.
  invalidateGuardrailCache(tenantDbName, updated.key);

  return serializeGuardrail(updated);
}

export async function deleteGuardrail(
  tenantDbName: string,
  id: string,
): Promise<boolean> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const deleted = await db.deleteGuardrail(id);
  if (deleted) {
    // The whole TENANT, not one key: this signature takes an id and the row is
    // gone by the time we could ask it for its key. Reading the record first
    // purely to name it would add a round trip to every delete, and clearing a
    // tenant's slice of a 500-entry cache costs one re-read per guardrail that
    // is actually in use. A guardrail that keeps enforcing after it was
    // deleted is the failure worth paying that for.
    invalidateGuardrailCache(tenantDbName);
  }
  return deleted;
}

export async function getGuardrail(
  tenantDbName: string,
  id: string,
): Promise<GuardrailView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailById(id);
  if (!record) return null;
  return serializeGuardrail(record);
}

/** `projectId` keeps the provider contract's three-way meaning: a string for
 *  that project's row, `null` for the tenant-wide row, `undefined` for the
 *  first row of any project. */
export async function getGuardrailByKey(
  tenantDbName: string,
  key: string,
  projectId?: string | null,
): Promise<GuardrailView | null> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const record = await db.findGuardrailByKey(key, projectId);
  if (!record) return null;
  return serializeGuardrail(record);
}

export async function listGuardrails(
  tenantDbName: string,
  filters?: {
    projectId?: string;
    type?: GuardrailType;
    enabled?: boolean;
    search?: string;
  },
): Promise<GuardrailView[]> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  const records = await db.listGuardrails(filters);
  return records.map(serializeGuardrail);
}

// ── Evaluation ────────────────────────────────────────────────────────────

/**
 * The actor a legacy `evaluateGuardrail` call is made on behalf of.
 *
 * `HookActor.id` is required to come from the AUTHENTICATED context and never
 * from a caller-supplied field, so it is read from the same request-scoped
 * attribution `recordUsageEvent` already uses rather than invented here. When
 * there is no ambient request (a queued job, a unit test) the actor degrades to
 * an anonymous system actor — which is safe for this door specifically, because
 * `input.pre` / `output.pre` reach no policy that reads the actor: `allowedRoles`
 * belongs to `tool_access`, and POLICY_VALID_HOOKS keeps that family on the two
 * tool hooks.
 */
function legacyActor(): HookActor {
  const attribution = resolveUsageAttribution();
  const kind: HookActor['kind'] =
    attribution.actorType === 'user'
      ? 'user'
      : attribution.actorType === 'api_token'
        ? 'api_token'
        : 'system';
  return {
    id: attribution.userId ?? attribution.apiTokenId ?? '',
    kind,
    roles: [],
  };
}

export async function evaluateGuardrail(params: {
  tenantDbName: string;
  tenantId: string;
  projectId?: string;
  guardrailKey: string;
  text: string;
  /** Which side of the model call is being checked. Defaults to 'input'. */
  phase?: 'input' | 'output';
  /** Caller tag persisted in evaluation logs, e.g. 'chat.completions', 'agent', 'evaluate-api'. */
  source?: string;
  requestId?: string;
  /** Set true to skip writing an evaluation log (e.g. nested/duplicate calls). */
  skipLogging?: boolean;
  /**
   * Run ONLY these policy families. This is what lets a latency-sensitive caller
   * ask for just the deterministic part — the AI App Gateway races the whole
   * evaluation against a hardcoded 4s timeout today precisely because there was
   * no way to ask for less than everything.
   */
  only?: PolicyFamily[];
  /**
   * Wall-clock budget for synchronous policies. On expiry the policy's `failMode`
   * decides, which is a REAL behaviour difference from the gateway's timeout
   * race: that one skips the guardrail (fail-open regardless of configuration),
   * this one honours a fail-closed guardrail's configured intent.
   */
  budgetMs?: number;
  /**
   * Evaluate without recording anything: no evaluation-log row and no usage
   * event. For previews and the red-team runner, where a "would this block?"
   * question must not land in the tenant's audit trail or on their bill.
   */
  shadow?: boolean;
}): Promise<GuardrailEvaluationResult> {
  const { tenantDbName, tenantId, projectId, guardrailKey, text } = params;

  // Direction comes from the SLOT the caller occupies, never from
  // `record.target` — which the previous implementation also ignored, and which
  // the API has never been able to set. `output.pre` is the post-model hook.
  const hook: HookId = params.phase === 'output' ? 'output.pre' : 'input.pre';

  // Resolved HERE rather than inside runHook, for two reasons that both matter:
  // runHook deliberately never throws (a hook that throws takes a chat
  // completion down with it) and returns a vacuous verdict for an unknown key,
  // but plugins/guardrails.ts and plugins/client-guardrails.ts both map this
  // exact message to a 404; and a DISABLED record must produce the vacuous
  // result below without running — or paying for — a hook call.
  const record = await resolveGuardrail(tenantDbName, guardrailKey, projectId);
  if (!record) {
    throw new Error(`Guardrail with key "${guardrailKey}" not found`);
  }

  if (!record.enabled) {
    return {
      passed: true,
      blocked: false,
      guardrailKey: record.key,
      guardrailName: record.name,
      action: record.action,
      findings: [],
      disabled: true,
    };
  }

  const scope: HookScope = {
    tenantId,
    tenantDbName,
    projectId,
    actor: legacyActor(),
    // This door is reached from the client API, the dashboard test panel, the
    // inference path and the agent runtime alike, and none of them tells us
    // which. 'api' is the honest answer for a call that arrived through the
    // service layer; the callers that DO know their surface build their own
    // HookCall (the stream gate, the tool hook, the MCP seam).
    surface: 'api',
    // HookScope declares `source` as a required string, but the column is
    // nullable and every caller that omits it stores NULL today. Writing ''
    // instead would introduce a second, indistinguishable "no source" value
    // into every existing `source` filter and GROUP BY, so the omission is
    // preserved rather than papered over with an empty string.
    source: params.source as string,
    requestId: params.requestId,
    // The evaluation log has no traceId column; this only ties the findings of
    // one call together and appears in the block message's {{traceId}}. Reusing
    // requestId when we have one keeps those two identifiers aligned.
    traceId: params.requestId ?? randomUUID(),
    budgetMs: params.budgetMs,
  };

  const verdict = await runHook({
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook,
    subject: textSubject(text),
    scope,
    guardrailKeys: [guardrailKey],
    only: params.only,
    shadow: params.shadow,
    skipLogging: params.skipLogging,
  });

  return {
    // LEGACY SEMANTICS, preserved on purpose: `passed` answers "was there a
    // blocking finding", NOT "was the request blocked". The two diverge in
    // monitor mode, where `verdict.decision` is neutralised to 'allow' while
    // the findings still say what would have happened — and every existing
    // caller reads `passed` expecting the first meaning.
    passed: !verdict.findings.some((finding) => finding.block),
    // The ENFORCEMENT answer, and the only one a caller may throw on. Taken
    // from `verdict.decision`, which runHook has ALREADY neutralised to 'allow'
    // for a monitor-mode guardrail — so a guardrail set to Monitor stops
    // refusing traffic, which is what the Mode control has always claimed.
    blocked: verdict.decision === 'block',
    guardrailKey: verdict.guardrailKey || record.key,
    guardrailName: verdict.guardrailName || record.name,
    // The record's action, still the legacy 4-value GuardrailAction. NOT
    // `verdict.decision`, which is a SafetyAction and can be 'allow'.
    action: record.action,
    findings: verdict.findings,
    // `false` would be a new value for a field every caller reads as
    // "absent = the guardrail ran"; an enabled guardrail that is simply not
    // bound to this hook still reports disabled, which is what the test panel
    // needs to avoid rendering "content is safe" for a guardrail that ran
    // nothing.
    disabled: verdict.disabled || undefined,
    // Present iff `applyMutations` actually rewrote something. The engine drops
    // proposals when the verdict blocks (there is nothing to hand back when the
    // request is refused) and when the guardrail is not enforcing, so this is
    // absent in exactly the cases it was absent before.
    redactedText: verdict.text,
    verdict,
  };
}


// ── Re-exports ────────────────────────────────────────────────────────────

export { PII_CATEGORIES, MODERATION_CATEGORIES, PROMPT_SHIELD_ISSUES, WORD_FILTER_BUILTIN_LISTS } from './types';
export { buildDefaultPresetPolicy as buildDefaultPolicy };
