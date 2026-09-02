import { createHash, randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  GuardrailAction,
  GuardrailPolicy,
  GuardrailHooksConfig,
  GuardrailMode,
  GuardrailType,
  IGuardrail,
  IUser,
} from '@/lib/database';
import { createLogger } from '@/lib/core/logger';
import { getDatabase } from '@/lib/database';
import { getPiiPolicyByKey } from '@/lib/services/pii';
import {
  buildDefaultPresetPolicy,
  createGuardrail,
  deleteGuardrail,
  evaluateGuardrail,
  getGuardrail,
  getGuardrailByKey,
  listGuardrails,
  MODERATION_CATEGORIES,
  PII_CATEGORIES,
  PROMPT_SHIELD_ISSUES,
  WORD_FILTER_BUILTIN_LISTS,
  runHook,
  updateGuardrail,
  createWordList,
  updateWordList,
  deleteWordList,
  getWordList,
  listWordLists,
  parseWordListContent,
  normalizeWordArray,
  WordListValidationError,
} from '@/lib/services/guardrail';
import type { GuardrailView, WordListView } from '@/lib/services/guardrail';
// The service barrel deliberately re-exports only the hook plane's ENTRY
// POINTS (`runHook` and friends); the contract's constants, the legacy
// projection and the red-team battery are reached at their own paths. See the
// "Deliberately NOT re-exported" note in services/guardrail/index.ts — this
// plugin is a configuration surface, not a second evaluation path, so it is on
// the allowed side of that line.
import {
  POLICY_FAMILIES,
  DEFAULT_VERDICT_VISIBILITY,
  GUARDRAIL_CONTRACT_VERSION,
  HOOK_IDS,
  HOOK_SUBJECT_KIND,
  isPlainRecord,
  normalizeHooksConfig,
  textSubject,
  toolCallSubject,
  toolResultSubject,
  VERDICT_HEADERS,
  VERDICT_STATUS,
} from '@/lib/services/guardrail/hooks/contract';
import type {
  PolicyFamily,
  HookActor,
  HookId,
  HookScope,
  HookSubject,
  HookSurface,
  HookVerdict,
  VerdictVisibility,
} from '@/lib/services/guardrail/hooks/contract';
import {
  ensureHooks,
  projectHooksToLegacy,
  validateGuardrailHooks,
} from '@/lib/services/guardrail/hooks/legacy';
import type { LegacyProjectionContext } from '@/lib/services/guardrail/hooks/legacy';
import { runGuardrailRedTeam } from '@/lib/services/guardrail/hooks/redteam';
import { capabilities as sdkGuardrailCapabilities } from '@/lib/services/guardrail/sdkAdapter';
import { parseDashboardDateFilterFromSearchParams } from '@/lib/utils/dashboardDateFilter';
import {
  parseBooleanQuery,
  readJsonBody,
  requireProjectContextForRequest,
  safeReadJsonBody,
  sendProjectContextError,
  withApiRequestContext,
} from '../fastify-utils';

const logger = createLogger('api:guardrails');

type GuardrailsQuery = {
  enabled?: string;
  includeTemplates?: string;
  search?: string;
  type?: GuardrailType;
};

type EvaluationsQuery = {
  from?: string;
  groupBy?: 'hour' | 'day' | 'month';
  limit?: string;
  passed?: string;
  skip?: string;
  to?: string;
};

/**
 * 'redact' has always been part of `GuardrailAction`, and the hook plane makes
 * it a first-class rung: `projectHooksToLegacy` folds a redacting policy down
 * onto this column, so a guardrail saved with one comes back carrying
 * `action: 'redact'`. Leaving it off this list made the round trip fail — the
 * edit screen re-sends the action it was given and gets a 400 for a value the
 * server itself wrote.
 */
const VALID_ACTIONS: GuardrailAction[] = ['block', 'warn', 'flag', 'redact'];
const VALID_TYPES: GuardrailType[] = ['preset', 'custom'];
const VALID_FAIL_MODES = ['open', 'closed'];
const VALID_MODES: GuardrailMode[] = ['enforce', 'monitor', 'disabled'];

/** The families evaluated by a model, i.e. the ones that need a `modelKey`. */
const LLM_POLICY_FAMILIES: ReadonlySet<string> = new Set<PolicyFamily>([
  'moderation',
  'prompt_shield',
  'custom',
]);

/** The only `?target=` the compiled-policy endpoint knows how to emit. */
const COMPILE_TARGETS = ['agent-sdk'] as const;
type CompileTarget = (typeof COMPILE_TARGETS)[number];

/**
 * Resolve a guardrail by id within the caller's project scope.
 *
 * getGuardrail is scoped only by the tenant database, so without this any
 * member of one project could read another project's guardrail, disable it
 * (enabled:false / failMode:'open') or delete it — silently removing another
 * team's safety control — and read the flagged text in its evaluation logs.
 * Returns null for an out-of-scope id so it is indistinguishable from a
 * missing one. Owners and admins keep tenant-wide reach, which
 * resolveProjectContext already grants them, and legacy rows stored before
 * guardrails carried a projectId stay reachable.
 */
async function guardrailInProjectScope(
  tenantDbName: string,
  id: string,
  projectId: string,
  user: Pick<IUser, 'role'>,
): Promise<GuardrailView | null> {
  const guardrail = await getGuardrail(tenantDbName, id);
  if (!guardrail) return null;
  if (user.role === 'owner' || user.role === 'admin') return guardrail;
  if (!guardrail.projectId) return guardrail;
  return String(guardrail.projectId) === String(projectId) ? guardrail : null;
}

/**
 * The same scoping, by KEY — what the hook-plane routes address a guardrail by,
 * because a key is what an enforcement point has in its configuration.
 *
 * The tenant-wide second lookup is not a convenience: `findGuardrailByKey`
 * with a project emits `projectId = @projectId`, a predicate that EXCLUDES
 * NULL, so a workspace-level guardrail is invisible to every project-scoped
 * caller. `resolveGuardrail` (hooks/engine.ts) falls back for exactly that
 * reason, and without the same fallback here this API would report "not
 * found" for a guardrail the engine happily enforces.
 *
 * The fallback asks for the tenant-wide row by name (`null`), never for "any
 * row with this key" (`undefined`): two projects can legitimately hold the same
 * key (keys are unique per project), and on an authenticated surface the
 * first-match answer would hand one project another project's policy — or,
 * once filtered, hide the workspace-wide row behind it. Only an owner or admin,
 * who already have tenant-wide reach, get the any-project lookup as a last
 * resort.
 */
export async function guardrailByKeyInScope(
  tenantDbName: string,
  key: string,
  projectId: string,
  user?: Pick<IUser, 'role'>,
): Promise<GuardrailView | null> {
  const scoped = await getGuardrailByKey(tenantDbName, key, projectId);
  if (scoped) return scoped;

  const tenantWide = await getGuardrailByKey(tenantDbName, key, null);
  if (tenantWide) return tenantWide;

  if (user?.role === 'owner' || user?.role === 'admin') {
    return getGuardrailByKey(tenantDbName, key);
  }
  return null;
}

/** Same project scoping as guardrailInProjectScope, for word lists. */
async function wordListInProjectScope(
  tenantDbName: string,
  id: string,
  projectId: string,
  user: Pick<IUser, 'role'>,
): Promise<WordListView | null> {
  const wordList = await getWordList(tenantDbName, id);
  if (!wordList) return null;
  if (user.role === 'owner' || user.role === 'admin') return wordList;
  if (!wordList.projectId) return wordList;
  return String(wordList.projectId) === String(projectId) ? wordList : null;
}

/**
 * `GuardrailView` back to the record shape the hook plane's pure helpers take.
 *
 * `serializeGuardrail` swaps `_id` for `id` and widens the timestamps to
 * `Date | string`, so a view is not assignable to `IGuardrail` even though it
 * carries every field these helpers read. The timestamps are omitted rather
 * than coerced: nothing in `projectHooksToLegacy` or `ensureHooks` reads them,
 * and `policyVersionOf`'s job is done here by `policyVersionOfView`.
 *
 * `metadata` is NOT on `GuardrailView`, so it cannot be carried across — see
 * the note on the update route about what that costs.
 */
export function toGuardrailRecord(view: GuardrailView): IGuardrail {
  return {
    _id: view.id,
    tenantId: view.tenantId,
    projectId: view.projectId,
    key: view.key,
    name: view.name,
    description: view.description,
    type: view.type,
    target: view.target,
    action: view.action,
    enabled: view.enabled,
    failMode: view.failMode,
    modelKey: view.modelKey,
    policy: view.policy,
    customPrompt: view.customPrompt,
    hooks: view.hooks,
    hooksVersion: view.hooksVersion,
    mode: view.mode,
    createdBy: view.createdBy,
    updatedBy: view.updatedBy,
  };
}

/** `${key}@${updatedAt}`, the engine's own policy version string
 *  (hooks/engine.ts:1133) computed over a view's widened timestamps. */
function policyVersionOfView(view: GuardrailView): string {
  const stamped = view.updatedAt ?? view.createdAt;
  const iso =
    stamped instanceof Date
      ? stamped.toISOString()
      : typeof stamped === 'string'
        ? stamped
        : undefined;
  return iso ? `${view.key}@${iso}` : view.key;
}

// ── Hook config on the write path ─────────────────────────────────────────

interface HooksFieldResult {
  hooks?: GuardrailHooksConfig;
  errors?: string[];
}

/**
 * The narrowing step, and ONLY that: the branches in `readHooksField` test the
 * same three conditions and own the error messages.
 *
 * It is a predicate rather than a `as GuardrailHooksConfig` cast (which TS
 * refuses across an index signature) and rather than rebuilding the object
 * field by field. Rebuilding would compile forever and SILENTLY DROP any field
 * added to `GuardrailHooksConfig` later — every one of them is optional, so
 * nothing would fail — which is precisely the class of bug the single-blob
 * design exists to avoid.
 */
function isHooksConfigShape(
  value: Record<string, unknown>,
): value is Record<string, unknown> & GuardrailHooksConfig {
  return (
    Array.isArray(value.policies)
    && value.policies.every((policy) => isPlainRecord(policy))
    && isPlainRecord(value.bindings)
  );
}

/**
 * Read, structurally policy and VALIDATE the `hooks` field of a write body.
 *
 * The structural pass is not paranoia about hostile input: `validateGuardrailHooks`
 * indexes `policy.id` and `policy.family` without a null guard, so a
 * `policies: [null]` body would be a TypeError inside the validator — a 500 —
 * instead of the 400 it exists to produce.
 *
 * `validateGuardrailHooks` also MUTATES `hooks.stream.holdBackChars` upward
 * when a bound streaming policy needs a bigger window, which is why the object
 * returned here is the one that gets persisted rather than a copy of the body.
 */
export function readHooksField(body: Record<string, unknown>): HooksFieldResult {
  if (body.hooks === undefined) return {};
  if (!isPlainRecord(body.hooks)) return { errors: ['hooks must be an object'] };
  // A client written against the pre-rename contract still sends
  // `hooks.checks` / `family: 'tool_policy'` / `policyKey`. Re-spelled here, on
  // the way IN, so exactly one spelling reaches the validator and the store —
  // and so a PATCH that round-trips a GET response cannot re-introduce the old
  // one. Written back onto the body because the routes hand the same object to
  // their other diagnostics.
  const raw = normalizeHooksConfig(body.hooks);
  body.hooks = raw;
  if (!Array.isArray(raw.policies)) return { errors: ['hooks.policies must be an array'] };
  if (raw.bindings !== undefined && !isPlainRecord(raw.bindings)) {
    return { errors: ['hooks.bindings must be an object keyed by hook id'] };
  }
  for (const [index, policy] of raw.policies.entries()) {
    if (!isPlainRecord(policy)) {
      return { errors: [`hooks.policies[${index}] must be an object`] };
    }
  }

  // Stamped rather than demanded: a client that omits the version is speaking
  // THIS build's contract, and the validator rejects any other value — so
  // requiring it would only make every hand-written request fail once. Both
  // defaults land here, before the narrowing, because the fields are still
  // `unknown` at this point and can be tested against undefined honestly.
  if (raw.contractVersion === undefined) raw.contractVersion = GUARDRAIL_CONTRACT_VERSION;
  if (raw.bindings === undefined) raw.bindings = {};

  if (!isHooksConfigShape(raw)) {
    // Unreachable — the branches above cover every condition the predicate
    // tests — but a silent `hooks: undefined` here would read to the caller as
    // "no hook config was sent", i.e. a save that quietly dropped the config.
    return { errors: ['hooks is not a valid hook configuration'] };
  }

  const errors = validateGuardrailHooks(raw);
  return errors.length > 0 ? { errors } : { hooks: raw };
}

/**
 * `hooksVersion` 0 means "derived from the legacy columns, re-derive on every
 * read". An API caller can never mean that: the config it is sending was
 * authored by someone. Accepting a 0 here would write the config to the row and
 * have `ensureHooks` throw it away on every evaluation while the edit screen
 * kept showing it — with no error anywhere in the loop.
 */
export function readHooksVersionField(
  body: Record<string, unknown>,
): { hooksVersion?: number; error?: string } {
  const raw = body.hooksVersion;
  if (raw === undefined) return {};
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { error: 'hooksVersion must be an integer >= 1' };
  }
  return { hooksVersion: raw };
}

export function readModeField(
  body: Record<string, unknown>,
): { mode?: GuardrailMode; error?: string } {
  const raw = body.mode;
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || !VALID_MODES.includes(raw as GuardrailMode)) {
    return { error: 'mode must be "enforce", "monitor", or "disabled"' };
  }
  return { mode: raw as GuardrailMode };
}

/**
 * The resolved PII policy the downward projection needs.
 *
 * `projectHooksToLegacy` is synchronous and DB-free by design, so it cannot
 * fetch this itself; without it the projection preserves whatever category map
 * the legacy blob already carried, which on a freshly authored config is
 * nothing at all — leaving an older console binary with
 * `policy.pii.enabled: true` and an empty category map, i.e. a PII guardrail
 * that scans for nothing.
 *
 * The context holds ONE policy, so this is the FIRST enabled pii policy's. A
 * config with two pii policies projects the first one's categories downward; the
 * hook plane still runs both.
 */
async function resolveProjectionPiiPolicy(
  tenantDbName: string,
  hooks: GuardrailHooksConfig,
  projectId: string,
): Promise<LegacyProjectionContext['piiPolicy']> {
  const piiPolicy = (hooks.policies ?? []).find(
    (policy): policy is Extract<GuardrailPolicy, { family: 'pii' }> =>
      policy.enabled && policy.family === 'pii',
  );
  const key = piiPolicy?.piiPolicyKey?.trim();
  if (!key) return undefined;

  const scoped = await getPiiPolicyByKey(tenantDbName, key, projectId);
  if (scoped) return scoped;
  // `findPiiPolicyByKey` has the same NULL-excluding projectId predicate the
  // guardrail lookup does, so a workspace-level policy needs the same fallback.
  // `null` = the row NO project owns; an unscoped lookup could return another
  // project's same-key policy first and hide the tenant-wide one.
  return (await getPiiPolicyByKey(tenantDbName, key, null)) ?? undefined;
}

/**
 * Recompute the legacy columns from an authored hook config.
 *
 * This is what keeps `type` / `target` / `action` / `failMode` / `modelKey` /
 * `policy` / `customPrompt` permanently populated, and it has to run on EVERY
 * save that touches `hooks`. The readers that depend on those columns are not
 * hypothetical: `moderationApi`'s discovery scan matches on
 * `type === 'preset' && policy.moderation.enabled`, the AI App Gateway filters
 * findings by the legacy shape, and an older console binary sharing the tenant
 * database reads nothing else.
 */
export async function projectLegacyColumns(
  tenantDbName: string,
  hooks: GuardrailHooksConfig,
  current: IGuardrail,
  projectId: string,
): Promise<ReturnType<typeof projectHooksToLegacy>> {
  return projectHooksToLegacy(hooks, current, {
    piiPolicy: await resolveProjectionPiiPolicy(tenantDbName, hooks, projectId),
  });
}

/**
 * LLM-backed policies silently no-op without a model, which reads as "guardrail
 * active" while nothing runs. Reject configurations that enable an LLM policy
 * with no model to run it on.
 */
export function findLlmModelConfigError(body: Record<string, unknown>): string | null {
  const modelKey = typeof body.modelKey === 'string' && body.modelKey.trim() !== '' ? body.modelKey : undefined;
  if (body.type === 'custom' && !modelKey) {
    return 'modelKey is required for custom guardrails (the rule is evaluated by an LLM)';
  }
  const policy = body.policy as {
    moderation?: { enabled?: boolean; modelKey?: string };
    promptShield?: { enabled?: boolean; modelKey?: string };
  } | undefined;
  if (policy?.moderation?.enabled && !policy.moderation.modelKey && !modelKey) {
    return 'Content moderation is enabled but no model is configured (set policy.moderation.modelKey or the guardrail modelKey)';
  }
  if (policy?.promptShield?.enabled && !policy.promptShield.modelKey && !modelKey) {
    return 'Prompt shield is enabled but no model is configured (set policy.promptShield.modelKey or the guardrail modelKey)';
  }

  // The same rule over the hook plane's own shape. An authored config keeps its
  // LLM families in `hooks.policies` and may carry no legacy `policy` at all, so
  // without this a guardrail saved through the hook editor skips the gate
  // entirely and reads as active while its moderation policy evaluates nothing.
  //
  // The record-level `modelKey` counts as a model here because that is how the
  // ENGINE resolves one (`llmPolicyModelKey`, families/llm.ts:420 —
  // `policy.modelKey || recordModelKey || undefined`). `validateGuardrailHooks`
  // is stricter and demands a per-policy key; both run on every write, so an
  // author sees the stricter message and this pass never fires a FALSE one.
  const hooks = body.hooks;
  if (isPlainRecord(hooks) && Array.isArray(hooks.policies)) {
    for (const policy of hooks.policies) {
      if (!isPlainRecord(policy) || policy.enabled !== true) continue;
      const family = policy.family;
      if (typeof family !== 'string' || !LLM_POLICY_FAMILIES.has(family)) continue;
      const policyModelKey =
        typeof policy.modelKey === 'string' && policy.modelKey.trim() !== ''
          ? policy.modelKey
          : undefined;
      if (!policyModelKey && !modelKey) {
        const label = typeof policy.id === 'string' && policy.id !== '' ? policy.id : family;
        return `Policy "${label}" (${family}) is enabled but no model is configured (set the policy's modelKey or the guardrail modelKey)`;
      }
    }
  }

  return null;
}

// ── Hook evaluation over the wire ─────────────────────────────────────────

/**
 * Build the subject a hook expects out of a request body.
 *
 * The shape is driven by `HOOK_SUBJECT_KIND`, not by a hand-written switch over
 * hook ids, so a hook added to the contract lands here as a compile error
 * rather than as a route that silently accepts the wrong payload.
 */
export function buildHookSubject(
  hook: HookId,
  body: Record<string, unknown>,
): { subject?: HookSubject; error?: string } {
  const kind = HOOK_SUBJECT_KIND[hook];
  switch (kind) {
    case 'text': {
      if (typeof body.text !== 'string') {
        return { error: `text is required for hook "${hook}"` };
      }
      return { subject: textSubject(body.text) };
    }
    case 'tool_call':
    case 'tool_result': {
      if (typeof body.tool_name !== 'string' || body.tool_name.trim() === '') {
        return { error: `tool_name is required for hook "${hook}"` };
      }
      if (body.tool_args !== undefined && !isPlainRecord(body.tool_args)) {
        return { error: 'tool_args must be an object' };
      }
      const args = isPlainRecord(body.tool_args) ? body.tool_args : {};
      // Informational only — it reaches the webhook family's wire body and
      // nothing that gates a decision — so it defaults rather than 400s.
      const providerRef = typeof body.provider_ref === 'string' ? body.provider_ref : 'api';
      if (kind === 'tool_result') {
        if (body.tool_result === undefined) {
          return { error: `tool_result is required for hook "${hook}"` };
        }
        return {
          subject: toolResultSubject({
            toolName: body.tool_name,
            args,
            result: body.tool_result,
            providerRef,
          }),
        };
      }
      return {
        subject: toolCallSubject({
          toolName: body.tool_name,
          requestedName:
            typeof body.requested_name === 'string' ? body.requested_name : undefined,
          args,
          providerRef,
          sandboxAvailable:
            typeof body.sandbox_available === 'boolean' ? body.sandbox_available : undefined,
        }),
      };
    }
    case 'stream_delta': {
      if (typeof body.buffer !== 'string') {
        return {
          error:
            'buffer is required for hook "output.stream.delta" (the full accumulated channel text; spans are absolute into it)',
        };
      }
      const buffer = body.buffer;
      const releasedTo =
        typeof body.released_to === 'number' && Number.isFinite(body.released_to)
          ? Math.max(0, Math.min(Math.trunc(body.released_to), buffer.length))
          : 0;
      // There is no `streamDeltaSubject` builder in the contract — the stream
      // gate is the only in-process producer and builds it inline — so the
      // INVARIANT is reproduced here explicitly: exactly ONE segment covering
      // the whole buffer, at the gate's own `/buffer` pointer, so `text ===
      // buffer` and `applyMutations` can write a redaction back into the string
      // the caller actually emits.
      return {
        subject: {
          kind: 'stream_delta',
          text: buffer,
          segments: [{ path: '/buffer', text: buffer }],
          delta: typeof body.delta === 'string' ? body.delta : buffer.slice(releasedTo),
          buffer,
          releasedTo,
          seq: typeof body.seq === 'number' && Number.isFinite(body.seq) ? body.seq : 0,
          final: body.final === true,
        },
      };
    }
  }
}

interface HookEvaluationOptions {
  only?: PolicyFamily[];
  shadow?: boolean;
  budgetMs?: number;
  requestId?: string;
}

/**
 * What the AUTHENTICATED CONTEXT — never the body — allows an evaluation
 * request to ask for.
 */
export interface HookEvaluationAccess {
  /**
   * May this caller run in `shadow`? Shadow suppresses BOTH the evaluation-log
   * row and the usage event (`engine.ts`), so honouring it for a client API
   * token would let a tenant integration evaluate for free and off the record
   * by adding one body field — and "every evaluation is logged" would not hold
   * for that route. Only a dashboard session held by an admin may preview; for
   * everyone else the flag is silently forced OFF rather than rejected, so a
   * caller that copied the dashboard's request body still gets its verdict, on
   * the record. Defaults to false: a route has to opt in.
   */
  allowShadow: boolean;
}

/**
 * The roles that may suppress the audit trail for a preview. `user` is a
 * project member with no administrative standing; the three admin roles are
 * the ones who could, in any case, read and delete the log rows a shadow run
 * would not have written.
 */
export function canRequestShadowEvaluation(user: Pick<IUser, 'role'> | undefined): boolean {
  return user?.role === 'owner' || user?.role === 'admin' || user?.role === 'project_admin';
}

export function readHookEvaluationOptions(
  body: Record<string, unknown>,
  access: HookEvaluationAccess = { allowShadow: false },
): { options?: HookEvaluationOptions; error?: string } {
  let only: PolicyFamily[] | undefined;
  if (body.only !== undefined) {
    if (!Array.isArray(body.only)) return { error: 'only must be an array of policy families' };
    const families: PolicyFamily[] = [];
    for (const entry of body.only) {
      if (typeof entry !== 'string' || !POLICY_FAMILIES.includes(entry as PolicyFamily)) {
        return { error: `only contains an unknown policy family "${String(entry)}"` };
      }
      families.push(entry as PolicyFamily);
    }
    only = families;
  }

  let budgetMs: number | undefined;
  if (body.budget_ms !== undefined) {
    if (typeof body.budget_ms !== 'number' || !Number.isFinite(body.budget_ms) || body.budget_ms <= 0) {
      return { error: 'budget_ms must be a positive number of milliseconds' };
    }
    budgetMs = Math.trunc(body.budget_ms);
  }

  return {
    options: {
      only,
      // Opt-IN, and GATED. A remotely-connected enforcement point is real
      // traffic: its evaluations belong in the audit trail and on the bill.
      // Only a preview ("would this block?") asks for shadow, it has to say
      // so, and the caller has to be one `access` lets ask — the client API
      // token route never is.
      shadow: access.allowShadow && body.shadow === true,
      budgetMs,
      requestId: typeof body.request_id === 'string' ? body.request_id : undefined,
    },
  };
}

/**
 * Verdict visibility, defaults filled in field by field.
 *
 * Not a spread over `DEFAULT_VERDICT_VISIBILITY`: every field of the stored
 * object is optional, so `{ ...defaults, ...stored }` would overwrite a default
 * with `undefined` for any key the operator has not touched.
 */
export function resolveVerdictVisibility(
  hooks: GuardrailHooksConfig | undefined,
): Required<VerdictVisibility> {
  const visibility = hooks?.visibility;
  return {
    headers: visibility?.headers ?? DEFAULT_VERDICT_VISIBILITY.headers,
    useVerdictStatusCodes:
      visibility?.useVerdictStatusCodes ?? DEFAULT_VERDICT_VISIBILITY.useVerdictStatusCodes,
    detailedHeaders: visibility?.detailedHeaders ?? DEFAULT_VERDICT_VISIBILITY.detailedHeaders,
    aegisCompatHeaders:
      visibility?.aegisCompatHeaders ?? DEFAULT_VERDICT_VISIBILITY.aegisCompatHeaders,
  };
}

/** The alphabet a finding code may use on the wire, per code and in total. */
const HEADER_CODE_FORBIDDEN = /[^A-Za-z0-9_.:-]/g;
const HEADER_CODE_MAX_CHARS = 64;
const HEADER_CODES_MAX_CHARS = 1024;

/**
 * Finding codes come from policy configs AND from webhook responses — remote
 * text. Node refuses a header value containing CR/LF (`ERR_INVALID_CHAR`), so
 * one webhook answering `code: "x\r\n"` would turn every hook response for
 * that guardrail into a 500. Restricted to a token alphabet and capped —
 * rather than merely stripped of CR/LF — so the header stays a comma-separated
 * list of tokens whatever a remote sends; a code that sanitises to nothing is
 * dropped, duplicates are folded, and the total is cut at a token boundary.
 * Returns undefined when nothing survives, so no empty header is set.
 */
export function headerSafeCodes(codes: readonly string[]): string | undefined {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const code of codes) {
    const token = code.replace(HEADER_CODE_FORBIDDEN, '').slice(0, HEADER_CODE_MAX_CHARS);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  let joined = tokens.join(',');
  if (joined.length > HEADER_CODES_MAX_CHARS) {
    joined = joined.slice(0, HEADER_CODES_MAX_CHARS).replace(/,[^,]*$/, '');
  }
  return joined || undefined;
}

/**
 * Describe the verdict in response headers.
 *
 * The core set is ALWAYS emitted — that is the owner's call, and it is the
 * cheap half of the deal that makes the status codes opt-in: an integrator can
 * always see what a guardrail decided without having to opt into a status code
 * their HTTP client may not survive. `visibility.headers` therefore gates
 * nothing here; `detailedHeaders` still gates the two that carry policy detail
 * (risk score and finding codes) into a place proxies log by default.
 *
 * Names come from `VERDICT_HEADERS` rather than being spelled out, so the
 * contract stays the single description of this wire surface.
 */
export function applyVerdictHeaders(
  reply: FastifyReply,
  verdict: HookVerdict,
  visibility: Required<VerdictVisibility>,
): void {
  reply.header(VERDICT_HEADERS.decision, verdict.decision);
  reply.header(
    VERDICT_HEADERS.key,
    verdict.guardrailKeys.length > 0 ? verdict.guardrailKeys.join(',') : verdict.guardrailKey,
  );
  reply.header(VERDICT_HEADERS.hook, verdict.hook);
  reply.header(VERDICT_HEADERS.mode, verdict.mode);
  reply.header(VERDICT_HEADERS.enforced, verdict.enforced ? 'true' : 'false');
  reply.header(VERDICT_HEADERS.trace, verdict.traceId);

  if (visibility.detailedHeaders) {
    reply.header(VERDICT_HEADERS.risk, String(verdict.riskScore));
    const codes = headerSafeCodes(verdict.codes);
    if (codes) {
      reply.header(VERDICT_HEADERS.codes, codes);
    }
  }

  if (visibility.aegisCompatHeaders) {
    // Deprecated aliases, removed in contract v3. Deployed SDK clients read
    // them today, and `x-aegis-post-decision` is specifically the one they read
    // after a tool has run.
    reply.header(VERDICT_HEADERS.legacyDecision, verdict.decision);
    reply.header(VERDICT_HEADERS.legacyTrace, verdict.traceId);
    if (verdict.hook === 'tool.post') {
      reply.header(VERDICT_HEADERS.legacyPost, verdict.decision);
    }
  }
}

/**
 * 246 / 446 are NON-STANDARD and therefore opt-in per guardrail: a block is
 * HTTP 400 (or a plain 200 on the evaluate endpoints) today and every deployed
 * client parses that. `verdict.decision` is already neutralised for a
 * monitor-mode guardrail, so a monitored block reports 246 "passed with
 * findings" — which is the truth: nothing was blocked.
 */
export function verdictStatusCode(
  verdict: HookVerdict,
  visibility: Required<VerdictVisibility>,
): number {
  if (!visibility.useVerdictStatusCodes) return 200;
  if (verdict.decision === 'block') return VERDICT_STATUS.blocked;
  return verdict.findings.length > 0 ? VERDICT_STATUS.passedWithFindings : 200;
}

/**
 * The wire shape of a hook verdict.
 *
 * snake_case and `guardrail_key` / `redacted_text` / `message` are deliberate:
 * they are the keys `/guardrails/evaluate` already returns, so a caller that
 * knows one guardrail endpoint can parse them all. Everything the hook plane
 * adds on top of that response is a new key, never a changed one.
 */
export function hookVerdictResponse(verdict: HookVerdict): Record<string, unknown> {
  const blocking = verdict.findings.filter((finding) => finding.block);
  return {
    hook: verdict.hook,
    contract_version: verdict.contractVersion,
    decision: verdict.decision,
    would_be_decision: verdict.wouldBeDecision,
    enforced: verdict.enforced,
    mode: verdict.mode,
    disabled: verdict.disabled,
    // The legacy meaning, kept: "was there a blocking finding", NOT "was the
    // request blocked". The two diverge in monitor mode and every existing
    // caller reads the first.
    passed: blocking.length === 0,
    findings: verdict.findings,
    mutations: verdict.mutations,
    // Present only when `applyMutations` actually rewrote something, which is
    // the only case where a caller must substitute it for what it sent.
    subject: verdict.subject ?? null,
    redacted_text: verdict.text ?? null,
    risk_score: verdict.riskScore,
    codes: verdict.codes,
    // The rendered end-user message plus its reason class, mode and status —
    // what a remote enforcement point needs to refuse the call in its own
    // client's dialect.
    blocked_message: verdict.message ?? null,
    message: blocking.length > 0 ? buildUserMessage(verdict.findings) : null,
    guardrail_key: verdict.guardrailKey,
    guardrail_keys: verdict.guardrailKeys,
    guardrail_name: verdict.guardrailName,
    policy_version: verdict.policyVersion,
    trace_id: verdict.traceId,
    latency_ms: verdict.latencyMs,
    degraded: verdict.degraded ?? [],
    // BESIDE `degraded`, AND FOR THE SAME REASON. A policy that could not run
    // and a policy we stopped waiting for are both policies whose absence from
    // `findings` needs explaining, and dropping either one at the process
    // boundary is what turns "two runs of the same input returned different
    // finding counts" into a mystery. Additive, like every other key this
    // plane added: a caller that ignores it is exactly where it was.
    cancelled: verdict.cancelled ?? [],
  };
}

/**
 * Run one hook for one guardrail and answer with the verdict.
 *
 * Shared by both API surfaces so the two cannot drift: a remote enforcement
 * point that works against the dashboard route must parse the token route
 * identically, and the whole point of this endpoint is that the SAME policy
 * decision is available from wherever the enforcement actually happens.
 */
export async function respondWithHookVerdict(params: {
  reply: FastifyReply;
  hook: HookId;
  subject: HookSubject;
  scope: HookScope;
  guardrailKeys: string[];
  visibility: Required<VerdictVisibility>;
  options: HookEvaluationOptions;
}): Promise<FastifyReply> {
  const verdict = await runHook({
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook: params.hook,
    subject: params.subject,
    scope: params.scope,
    guardrailKeys: params.guardrailKeys,
    only: params.options.only,
    shadow: params.options.shadow,
  });

  applyVerdictHeaders(params.reply, verdict, params.visibility);
  return params.reply
    .code(verdictStatusCode(verdict, params.visibility))
    .send(hookVerdictResponse(verdict));
}

/**
 * A hook id off the wire — a route param on the dashboard surface, a body field
 * on the token one.
 *
 * Hook ids contain dots (`output.stream.delta`), which are ordinary characters
 * inside one path segment; that was verified against the router rather than
 * assumed.
 */
export function parseHookId(value: unknown): { hook?: HookId; error?: string } {
  if (typeof value === 'string' && (HOOK_IDS as readonly string[]).includes(value)) {
    return { hook: value as HookId };
  }
  return { error: `hook must be one of ${HOOK_IDS.join(', ')}` };
}

/**
 * An actor id MUST come from the authenticated context and never from the
 * request body: an actor id a caller can choose is an actor id a caller can
 * borrow, and `tool_access.allowedRoles` is keyed on it. There is deliberately
 * no wire field for either the id or the roles.
 */
function dashboardActor(session: { userId: string }, user: Pick<IUser, 'role'>): HookActor {
  return { id: session.userId, kind: 'user', roles: [user.role] };
}

function hookScope(input: {
  tenantId: string;
  tenantDbName: string;
  projectId?: string;
  actor: HookActor;
  surface: HookSurface;
  source: string;
  options: HookEvaluationOptions;
}): HookScope {
  return {
    tenantId: input.tenantId,
    tenantDbName: input.tenantDbName,
    projectId: input.projectId,
    actor: input.actor,
    surface: input.surface,
    source: input.source,
    requestId: input.options.requestId,
    // Reusing requestId when we have one keeps the block message's {{traceId}}
    // and the caller's own correlation id aligned, exactly as the legacy
    // facade does.
    traceId: input.options.requestId ?? randomUUID(),
    budgetMs: input.options.budgetMs,
  };
}

export const guardrailsApiPlugin: FastifyPluginAsync = async (app) => {
  app.get('/guardrails', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as GuardrailsQuery;

      const guardrails = await listGuardrails(session.tenantDbName, {
        enabled: parseBooleanQuery(query.enabled),
        projectId,
        search: query.search,
        type: query.type,
      });

      const payload: Record<string, unknown> = { guardrails };

      if (query.includeTemplates === 'true') {
        payload.templates = {
          defaultPresetPolicy: buildDefaultPresetPolicy(),
          moderationCategories: MODERATION_CATEGORIES,
          piiCategories: PII_CATEGORIES,
          promptShieldIssues: PROMPT_SHIELD_ISSUES,
          wordFilterLists: WORD_FILTER_BUILTIN_LISTS,
        };
      }

      return reply.code(200).send(payload);
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      if (!VALID_TYPES.includes(body.type as GuardrailType)) {
        return reply.code(400).send({ error: 'type must be "preset" or "custom"' });
      }

      if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
        return reply.code(400).send({ error: 'action must be "block", "warn", "flag", or "redact"' });
      }

      if (body.type === 'custom' && (typeof body.customPrompt !== 'string' || body.customPrompt.trim() === '')) {
        return reply.code(400).send({ error: 'customPrompt is required for custom guardrails' });
      }

      if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
        return reply.code(400).send({ error: 'failMode must be "open" or "closed"' });
      }

      const modeField = readModeField(body);
      if (modeField.error) {
        return reply.code(400).send({ error: modeField.error });
      }

      const hooksVersionField = readHooksVersionField(body);
      if (hooksVersionField.error) {
        return reply.code(400).send({ error: hooksVersionField.error });
      }

      const hooksField = readHooksField(body);
      if (hooksField.errors) {
        return reply.code(400).send({ error: hooksField.errors[0], errors: hooksField.errors });
      }

      const modelConfigError = findLlmModelConfigError(body);
      if (modelConfigError) {
        return reply.code(400).send({ error: modelConfigError });
      }

      const action = (body.action as GuardrailAction | undefined) ?? 'block';
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

      // With `hooks` in the body the legacy columns are DERIVED from it rather
      // than taken from the request, so the two descriptions of the same
      // policy cannot be saved disagreeing with each other. The draft below is
      // what the row would have been without hooks — `projectHooksToLegacy`
      // reads it for the fields the projection cannot derive (an unchanged
      // `customPrompt`, a preserved category selection, the operator's `type`
      // when nothing is enabled).
      const legacy = hooksField.hooks
        ? await projectLegacyColumns(
            session.tenantDbName,
            hooksField.hooks,
            {
              tenantId: session.tenantId,
              projectId,
              // Assigned by createGuardrail from the name; the projection never
              // reads it.
              key: '',
              name: body.name.trim(),
              type: body.type as GuardrailType,
              // createGuardrail's own default, so the projection's "nothing
              // enabled" branch preserves the same value the row would get.
              target: 'input',
              action,
              enabled,
              failMode: body.failMode as 'open' | 'closed' | undefined,
              modelKey: body.modelKey as string | undefined,
              policy: body.policy as IGuardrail['policy'],
              customPrompt: body.customPrompt as string | undefined,
              createdBy: session.userId,
            },
            projectId,
          )
        : undefined;

      const guardrail = await createGuardrail(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        {
          action: legacy?.action ?? action,
          customPrompt: legacy?.customPrompt ?? (body.customPrompt as string | undefined),
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          enabled,
          failMode: legacy?.failMode ?? (body.failMode as 'open' | 'closed' | undefined),
          hooks: hooksField.hooks,
          hooksVersion: hooksVersionField.hooksVersion,
          modelKey: legacy?.modelKey ?? (body.modelKey as string | undefined),
          mode: modeField.mode,
          name: body.name.trim(),
          policy: (legacy?.policy ?? body.policy) as Record<string, unknown> | undefined,
          projectId,
          target: legacy?.target,
          type: legacy?.type ?? (body.type as GuardrailType),
        },
      );

      return reply.code(201).send({ guardrail });
    } catch (error) {
      logger.error('Create guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails/evaluate', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.guardrail_key !== 'string') {
        return reply.code(400).send({ error: 'guardrail_key is required' });
      }

      if (typeof body.text !== 'string') {
        return reply.code(400).send({ error: 'text is required' });
      }

      const result = await evaluateGuardrail({
        guardrailKey: body.guardrail_key,
        projectId,
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        text: body.text,
        source: 'dashboard-evaluate',
      });

      // Headers only. This endpoint's STATUS is part of its published shape —
      // it has always answered 200, findings or not — so the opt-in 246/446
      // codes are confined to the hook routes below, where nothing is
      // depending on the old one.
      if (result.verdict) {
        applyVerdictHeaders(reply, result.verdict, resolveVerdictVisibility(undefined));
      }

      return reply.code(200).send({
        action: result.action,
        findings: result.findings,
        guardrail_key: result.guardrailKey,
        guardrail_name: result.guardrailName,
        message: result.passed ? null : buildUserMessage(result.findings),
        passed: result.passed,
        disabled: result.disabled ?? false,
        redacted_text: result.redactedText ?? null,
        // ADDITIVE: spans, mutations, risk score, response codes and
        // `wouldBeDecision`. Every key above keeps its exact meaning.
        verdict: result.verdict ?? null,
      });
    } catch (error) {
      logger.error('Evaluate guardrail error', { error });
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  // ── Word lists (tenant-managed banned-word lists) ──
  // Registered as static /guardrails/word-lists* paths; Fastify prefers
  // static segments over :id params, so these never shadow guardrail ids.

  app.get('/guardrails/word-lists', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const query = (request.query ?? {}) as { search?: string };
      const lists = await listWordLists(session.tenantDbName, {
        projectId,
        search: query.search,
      });
      return reply.code(200).send({ wordLists: lists });
    } catch (error) {
      logger.error('List word lists error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.post('/guardrails/word-lists', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, session } = await requireProjectContextForRequest(request);
      const body = readJsonBody<Record<string, unknown>>(request);

      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return reply.code(400).send({ error: 'name is required' });
      }

      // Accept either a parsed `words` array or raw CSV/TXT `content`.
      let words: string[];
      if (typeof body.content === 'string') {
        words = parseWordListContent(body.content);
      } else if (body.words !== undefined) {
        words = normalizeWordArray(body.words);
      } else {
        return reply.code(400).send({ error: 'Provide `words` (string array) or `content` (raw CSV/TXT)' });
      }

      if (words.length === 0) {
        return reply.code(400).send({ error: 'The list contains no usable entries' });
      }

      const wordList = await createWordList(
        session.tenantDbName,
        session.tenantId,
        session.userId,
        {
          name: body.name.trim(),
          description: typeof body.description === 'string' ? body.description.trim() : undefined,
          language: typeof body.language === 'string' ? body.language.trim() : undefined,
          words,
          projectId,
        },
      );

      return reply.code(201).send({ wordList });
    } catch (error) {
      if (error instanceof WordListValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Create word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const wordList = await wordListInProjectScope(session.tenantDbName, id, projectId, user);
      if (!wordList) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ wordList });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await wordListInProjectScope(session.tenantDbName, id, projectId, user))) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);

      let words: string[] | undefined;
      if (typeof body.content === 'string') {
        words = parseWordListContent(body.content);
      } else if (body.words !== undefined) {
        words = normalizeWordArray(body.words);
      }
      if (words !== undefined && words.length === 0) {
        return reply.code(400).send({ error: 'The list contains no usable entries' });
      }

      const wordList = await updateWordList(session.tenantDbName, id, session.userId, {
        name: typeof body.name === 'string' ? body.name.trim() : undefined,
        description: typeof body.description === 'string' ? body.description.trim() : undefined,
        language: typeof body.language === 'string' ? body.language.trim() : undefined,
        words,
      });

      if (!wordList) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ wordList });
    } catch (error) {
      if (error instanceof WordListValidationError) {
        return reply.code(400).send({ error: error.message });
      }
      logger.error('Update word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/guardrails/word-lists/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await wordListInProjectScope(session.tenantDbName, id, projectId, user))) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      const deleted = await deleteWordList(session.tenantDbName, id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Word list not found' });
      }
      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete word list error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  // ── Hook plane ────────────────────────────────────────────────────────────
  //
  // `:key` beside `:id` on sibling routes is fine — Fastify keeps param names
  // on the route, not on the radix node, and hook ids containing dots stay one
  // path segment. Both were verified against the router before these were
  // written.

  /**
   * Evaluate ONE hook of ONE guardrail, directly.
   *
   * This is the remote half of the enforcement plane: a point that runs a model
   * or a tool somewhere else asks the console what the policy says, instead of
   * shipping the policy to it. That is also why the answer carries
   * `policy_version` — paired with the compiled endpoint's ETag it is how a
   * remote point knows its cached policy is still the current one.
   */
  app.post('/guardrails/:key/hooks/:hook', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { key, hook: hookParam } = request.params as { key: string; hook: string };

      const hookField = parseHookId(hookParam);
      if (!hookField.hook) {
        return reply.code(400).send({ error: hookField.error });
      }

      const guardrail = await guardrailByKeyInScope(session.tenantDbName, key, projectId, user);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const body = safeReadJsonBody<Record<string, unknown>>(request);

      const subjectField = buildHookSubject(hookField.hook, body);
      if (!subjectField.subject) {
        return reply.code(400).send({ error: subjectField.error });
      }

      // The dashboard is the ONE surface where `shadow` may be honoured, and
      // only for an admin session; the client API token route calls
      // `readHookEvaluationOptions` with the default and never gets it.
      const optionsField = readHookEvaluationOptions(body, {
        allowShadow: canRequestShadowEvaluation(user),
      });
      if (!optionsField.options) {
        return reply.code(400).send({ error: optionsField.error });
      }

      return await respondWithHookVerdict({
        reply,
        hook: hookField.hook,
        subject: subjectField.subject,
        scope: hookScope({
          tenantId: session.tenantId,
          tenantDbName: session.tenantDbName,
          projectId,
          actor: dashboardActor(session, user),
          surface: 'dashboard',
          source: 'dashboard-hook',
          options: optionsField.options,
        }),
        guardrailKeys: [guardrail.key],
        visibility: resolveVerdictVisibility(ensureHooks(toGuardrailRecord(guardrail)).hooks),
        options: optionsField.options,
      });
    } catch (error) {
      logger.error('Evaluate guardrail hook error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  /**
   * The compiled policy for a remote enforcement point, with an `ETag` it can
   * revalidate against.
   *
   * This is what makes "switch this hook to log mode remotely" work without a
   * deploy: the point holds the compiled config, polls with `If-None-Match`,
   * gets a 304 while nothing has changed and a fresh body the moment an
   * operator edits a schedule, an action or the mode.
   *
   * A LEGACY row compiles too. `ensureHooks` lifts it exactly as the engine
   * does, so what comes back is what would actually be enforced rather than an
   * empty config — and, deliberately, nothing is written: a GET must not
   * provision the lifted PII policy, which the engine does for itself on the
   * evaluate path.
   */
  app.get('/guardrails/:key/compiled', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { key } = request.params as { key: string };
      const query = (request.query ?? {}) as { target?: string };

      const target = (query.target ?? 'agent-sdk') as CompileTarget;
      if (!(COMPILE_TARGETS as readonly string[]).includes(target)) {
        return reply.code(400).send({
          error: `target must be one of ${COMPILE_TARGETS.join(', ')}`,
        });
      }

      const guardrail = await guardrailByKeyInScope(session.tenantDbName, key, projectId, user);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const record = toGuardrailRecord(guardrail);
      const resolved = ensureHooks(record);
      const payload = {
        target,
        contractVersion: GUARDRAIL_CONTRACT_VERSION,
        policyVersion: policyVersionOfView(guardrail),
        guardrail: {
          key: guardrail.key,
          name: guardrail.name,
          description: guardrail.description ?? null,
          enabled: guardrail.enabled,
          // The stored mode, plus what it resolves to once `enabled` is folded
          // in — a disabled guardrail is 'disabled' whatever its mode column
          // says, and a remote point must not have to re-derive that rule.
          mode: guardrail.mode ?? null,
          action: guardrail.action,
          failMode: guardrail.failMode ?? null,
          modelKey: guardrail.modelKey ?? null,
          // 0 (or absent) means the config below was DERIVED from the legacy
          // columns and will be re-derived on every read, so a later fix to the
          // projection reaches this guardrail without an edit.
          hooksVersion: resolved.hooksVersion,
          authored: resolved.hooksVersion >= 1,
        },
        hooks: resolved.hooks,
        // Which hooks the installed agent SDK can actually serve. Synchronous
        // and SDK-free, so this stays a cheap GET.
        capabilities: sdkGuardrailCapabilities(),
      };

      const body = JSON.stringify(payload);
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;

      if (etagMatches(request, etag)) {
        // 304 carries no body; the validators still have to be on it, or the
        // next request revalidates against nothing.
        return reply.code(304).header('ETag', etag).header('Cache-Control', 'no-cache').send();
      }

      return reply
        .code(200)
        .header('ETag', etag)
        // The policy must never be served from a cache without asking: an
        // operator switching a hook to log mode expects the next poll to see it.
        .header('Cache-Control', 'no-cache')
        .header('Content-Type', 'application/json; charset=utf-8')
        .send(body);
    } catch (error) {
      logger.error('Compile guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const guardrail = await guardrailInProjectScope(session.tenantDbName, id, projectId, user);

      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ guardrail });
    } catch (error) {
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.patch('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const existing = await guardrailInProjectScope(session.tenantDbName, id, projectId, user);
      if (!existing) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }
      const body = readJsonBody<Record<string, unknown>>(request);

      if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
        return reply.code(400).send({ error: 'action must be "block", "warn", "flag", or "redact"' });
      }

      if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
        return reply.code(400).send({ error: 'failMode must be "open" or "closed"' });
      }

      const modeField = readModeField(body);
      if (modeField.error) {
        return reply.code(400).send({ error: modeField.error });
      }

      const hooksVersionField = readHooksVersionField(body);
      if (hooksVersionField.error) {
        return reply.code(400).send({ error: hooksVersionField.error });
      }

      const hooksField = readHooksField(body);
      if (hooksField.errors) {
        return reply.code(400).send({ error: hooksField.errors[0], errors: hooksField.errors });
      }

      // The LLM-model gate needs the record's own modelKey when the body does
      // not restate it, or a PATCH that only edits `hooks` would be rejected
      // for a model the guardrail already has.
      const modelConfigError = findLlmModelConfigError({
        ...body,
        modelKey: body.modelKey ?? existing.modelKey,
      });
      if (modelConfigError) {
        return reply.code(400).send({ error: modelConfigError });
      }

      // Projected against the record AS IT WILL BE, not as it is: the fields
      // this PATCH also changes are the ones the projection falls back to for
      // anything it cannot derive, so folding them in first is what stops a
      // combined edit ("soften the action AND change a policy") from projecting
      // the old action.
      const legacy = hooksField.hooks
        ? await projectLegacyColumns(
            session.tenantDbName,
            hooksField.hooks,
            {
              ...toGuardrailRecord(existing),
              action: (body.action as GuardrailAction | undefined) ?? existing.action,
              enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
              failMode:
                (body.failMode as 'open' | 'closed' | undefined) ?? existing.failMode,
              modelKey: (body.modelKey as string | undefined) ?? existing.modelKey,
              policy: (body.policy as IGuardrail['policy']) ?? existing.policy,
              customPrompt: (body.customPrompt as string | undefined) ?? existing.customPrompt,
            },
            projectId,
          )
        : undefined;

      // `type`, `target` and `metadata` are computed by the projection but have
      // no slot on UpdateGuardrailInput, so they cannot be written here. See
      // the report: an authored config that turns a `custom` guardrail into a
      // moderation one leaves `type: 'custom'` on the row, and
      // `moderationApi`'s discovery scan (which requires `type === 'preset'`)
      // keeps missing it.
      const guardrail = await updateGuardrail(session.tenantDbName, id, session.userId, {
        action: legacy?.action ?? (body.action as GuardrailAction | undefined),
        customPrompt: legacy?.customPrompt ?? (body.customPrompt as string | undefined),
        description: body.description as string | undefined,
        enabled: body.enabled as boolean | undefined,
        failMode: legacy?.failMode ?? (body.failMode as 'open' | 'closed' | undefined),
        hooks: hooksField.hooks,
        hooksVersion: hooksVersionField.hooksVersion,
        modelKey: legacy?.modelKey ?? (body.modelKey as string | undefined),
        mode: modeField.mode,
        name: body.name as string | undefined,
        policy: (legacy?.policy ?? body.policy) as Record<string, unknown> | undefined,
      });

      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ guardrail });
    } catch (error) {
      logger.error('Update guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.delete('/guardrails/:id', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      if (!(await guardrailInProjectScope(session.tenantDbName, id, projectId, user))) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }
      const deleted = await deleteGuardrail(session.tenantDbName, id);

      if (!deleted) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      return reply.code(200).send({ success: true });
    } catch (error) {
      logger.error('Delete guardrail error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  /**
   * Fire the red-team battery at one guardrail.
   *
   * Every probe runs with `shadow: true`, so a diagnostic never lands in the
   * tenant's audit trail or on their bill — that is the runner's own guarantee,
   * not something this route can grant or revoke.
   */
  app.post('/guardrails/:id/redteam', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const guardrail = await guardrailInProjectScope(session.tenantDbName, id, projectId, user);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const report = await runGuardrailRedTeam({
        tenantDbName: session.tenantDbName,
        tenantId: session.tenantId,
        projectId,
        guardrailKey: guardrail.key,
      });

      return reply.code(200).send(report);
    } catch (error) {
      logger.error('Guardrail red-team error', { error });
      // The runner throws the facade's own "not found" message when the record
      // disappears between the scope policy and the run.
      if (error instanceof Error && error.message.toLowerCase().includes('not found')) {
        return reply.code(404).send({ error: error.message });
      }
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));

  app.get('/guardrails/:id/evaluations', withApiRequestContext(async (request, reply) => {
    try {
      const { projectId, user, session } = await requireProjectContextForRequest(request);
      const { id } = request.params as { id: string };
      const query = (request.query ?? {}) as EvaluationsQuery;

      const db = await getDatabase();
      await db.switchToTenant(session.tenantDbName);

      const guardrail = await guardrailInProjectScope(session.tenantDbName, id, projectId, user);
      if (!guardrail) {
        return reply.code(404).send({ error: 'Guardrail not found' });
      }

      const filter = parseDashboardDateFilterFromSearchParams(
        new URLSearchParams(query as Record<string, string>),
      );
      const limit = Math.min(Number.parseInt(query.limit ?? '50', 10), 200);
      const skip = Number.parseInt(query.skip ?? '0', 10);
      const from = query.from ?? filter.from?.toISOString();
      const to = query.to ?? filter.to?.toISOString();
      const passed = parseBooleanQuery(query.passed);
      const groupBy = query.groupBy ?? 'day';

      const [logs, aggregate] = await Promise.all([
        db.listGuardrailEvaluationLogs(id, {
          from: from ? new Date(from) : undefined,
          limit,
          passed,
          skip,
          to: to ? new Date(to) : undefined,
        }),
        db.aggregateGuardrailEvaluations(id, {
          from: from ? new Date(from) : undefined,
          groupBy,
          to: to ? new Date(to) : undefined,
        }),
      ]);

      return reply.code(200).send({ aggregate, logs });
    } catch (error) {
      logger.error('List guardrail evaluations error', { error });
      return sendProjectContextError(reply, error)
        ?? reply.code(500).send({
          error: error instanceof Error ? error.message : 'Internal error',
        });
    }
  }));
};

/** `If-None-Match` may carry several validators and a weak prefix; a strict
 *  equality test against the raw header answers 304 far less often than it
 *  should, and a cache that never revalidates successfully is a cache that
 *  re-downloads the whole policy on every poll. */
function etagMatches(request: FastifyRequest, etag: string): boolean {
  const header = request.headers['if-none-match'];
  if (typeof header !== 'string') return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === etag || candidate === '*');
}

function buildUserMessage(findings: Array<{ block: boolean; category: string; message: string }>) {
  const blocking = findings.filter((finding) => finding.block);
  if (blocking.length === 0) {
    return 'Content flagged by guardrail.';
  }

  const lines = blocking.map((finding) => {
    const category = finding.category
      .replace(/[_/-]+/g, ' ')
      .replace(/(^|\s)\w/g, (segment) => segment.toUpperCase());

    return `• ${category}: ${finding.message}`;
  });

  return `Content blocked by guardrail:\n${lines.join('\n')}`;
}
