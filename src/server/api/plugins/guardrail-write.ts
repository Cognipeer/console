/**
 * Guardrail write path shared by the dashboard (`guardrails.ts`) and the
 * token-authenticated client (`client-guardrails.ts`) plugins.
 *
 * The body parsers and validators here are pure: no request, reply or auth
 * access. Callers resolve identity and project scope themselves, pass them in
 * as an explicit context, and keep the response envelope and the order of
 * their own lookups (by id vs by key) to themselves.
 */
import type {
  GuardrailAction,
  GuardrailPolicy,
  GuardrailHooksConfig,
  GuardrailMode,
  GuardrailType,
  IGuardrail,
} from '@/lib/database';
import { getPiiPolicyByKey } from '@/lib/services/pii';
import { createGuardrail, updateGuardrail } from '@/lib/services/guardrail';
import type { GuardrailView } from '@/lib/services/guardrail';
import {
  GUARDRAIL_CONTRACT_VERSION,
  isPlainRecord,
  normalizeHooksConfig,
  readPolicyList,
} from '@/lib/services/guardrail/hooks/contract';
import type { PolicyFamily } from '@/lib/services/guardrail/hooks/contract';
import {
  projectHooksToLegacy,
  validateGuardrailHooks,
} from '@/lib/services/guardrail/hooks/legacy';
import type { LegacyProjectionContext } from '@/lib/services/guardrail/hooks/legacy';
// Reached at its own path, like the hook-plane modules above: this is the
// family's own account of why a pattern will not run, and a configuration
// surface that rejects a rule owes its author that account rather than a
// second, drifting opinion of what JavaScript accepts.
import { explainRegexRuleError } from '@/lib/services/guardrail/families/regex';

/**
 * 'redact' has always been part of `GuardrailAction`, and the hook plane makes
 * it a first-class rung: `projectHooksToLegacy` folds a redacting policy down
 * onto this column, so a guardrail saved with one comes back carrying
 * `action: 'redact'`. Leaving it off this list made the round trip fail — the
 * edit screen re-sends the action it was given and gets a 400 for a value the
 * server itself wrote.
 */
const VALID_ACTIONS: GuardrailAction[] = ['block', 'warn', 'flag', 'redact'];
export const VALID_TYPES: GuardrailType[] = ['preset', 'custom'];
const VALID_FAIL_MODES = ['open', 'closed'];
const VALID_MODES: GuardrailMode[] = ['enforce', 'monitor', 'disabled'];

/** The families evaluated by a model, i.e. the ones that need a `modelKey`. */
const LLM_POLICY_FAMILIES: ReadonlySet<string> = new Set<PolicyFamily>([
  'moderation',
  'prompt_shield',
  'custom',
]);

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

/**
 * The first regex rule in a write body that cannot run, explained.
 *
 * `validateGuardrailHooks` refuses it too, with `Regex rule "x" is not a valid
 * pattern` — true, and useless to the author of `(?i)secret`, who is told
 * nothing about which part is invalid or what JavaScript wants instead. This
 * runs first so the actionable message is the one that reaches them.
 *
 * ENABLED policies only, exactly like the shared validator's family rules: a rule
 * inside a disabled policy runs nowhere, and refusing to save one would block an
 * operator from parking a work-in-progress policy, with no enforcement gain.
 *
 * Structural guards throughout: the body is unvalidated at this point, and a
 * diagnostic that throws on `policies: [null]` would turn a 400 into a 500.
 */
export function findRegexRuleError(body: Record<string, unknown>): string | null {
  const hooks = body.hooks;
  if (!isPlainRecord(hooks)) return null;
  // Runs BEFORE `readHooksField` re-spells the body, so it reads the list
  // through the shared accessor and sees a pre-rename `hooks.checks` too.
  const policies = readPolicyList(hooks);
  if (policies === undefined) return null;

  for (const policy of policies) {
    if (!isPlainRecord(policy) || policy.enabled !== true) continue;
    if (policy.family !== 'regex' || !Array.isArray(policy.rules)) continue;
    for (const rule of policy.rules) {
      if (!isPlainRecord(rule) || typeof rule.pattern !== 'string') continue;
      const reason = explainRegexRuleError({
        pattern: rule.pattern,
        flags: typeof rule.flags === 'string' ? rule.flags : undefined,
      });
      if (!reason) continue;
      const label =
        (typeof rule.id === 'string' && rule.id !== '' && rule.id)
        || (typeof rule.label === 'string' && rule.label !== '' && rule.label)
        || '(unnamed)';
      return `Regex rule "${label}": ${reason}`;
    }
  }
  return null;
}

// ── Create / update ───────────────────────────────────────────────────────

/** Who is writing and where: built by each adapter from its own auth. */
export interface GuardrailWriteContext {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** Recorded as `createdBy` / `updatedBy`. */
  actorId: string;
}

export interface GuardrailWriteError {
  ok: false;
  status: 400;
  error: string;
  errors?: string[];
}

/** The JSON body a route sends for a failed parse. */
export function guardrailWriteErrorBody(failure: GuardrailWriteError): { error: string; errors?: string[] } {
  return failure.errors ? { error: failure.error, errors: failure.errors } : { error: failure.error };
}

function fail(error: string, errors?: string[]): GuardrailWriteError {
  return { ok: false, status: 400, error, ...(errors ? { errors } : {}) };
}

export interface ParsedGuardrailCreate {
  /** The request body; `hooks` has been re-spelled in place by `readHooksField`. */
  body: Record<string, unknown>;
  name: string;
  action: GuardrailAction;
  enabled: boolean;
  mode?: GuardrailMode;
  hooks?: GuardrailHooksConfig;
  hooksVersion?: number;
}

export type GuardrailCreateParseResult = { ok: true; value: ParsedGuardrailCreate } | GuardrailWriteError;

/** Validates a create body. Does not touch the database. */
export function parseGuardrailCreateBody(body: Record<string, unknown>): GuardrailCreateParseResult {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return fail('name is required');
  }
  if (!VALID_TYPES.includes(body.type as GuardrailType)) {
    return fail('type must be "preset" or "custom"');
  }
  if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
    return fail('action must be "block", "warn", "flag", or "redact"');
  }
  if (body.type === 'custom' && (typeof body.customPrompt !== 'string' || body.customPrompt.trim() === '')) {
    return fail('customPrompt is required for custom guardrails');
  }
  if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
    return fail('failMode must be "open" or "closed"');
  }

  const modeField = readModeField(body);
  if (modeField.error) return fail(modeField.error);
  const hooksVersionField = readHooksVersionField(body);
  if (hooksVersionField.error) return fail(hooksVersionField.error);
  // Ahead of the shared validator, which rejects the same rule with a message
  // that does not say why. See findRegexRuleError.
  const regexRuleError = findRegexRuleError(body);
  if (regexRuleError) return fail(regexRuleError);
  const hooksField = readHooksField(body);
  if (hooksField.errors) return fail(hooksField.errors[0], hooksField.errors);

  const modelConfigError = findLlmModelConfigError(body);
  if (modelConfigError) return fail(modelConfigError);

  return {
    ok: true,
    value: {
      body,
      name: body.name.trim(),
      action: (body.action as GuardrailAction | undefined) ?? 'block',
      enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
      mode: modeField.mode,
      hooks: hooksField.hooks,
      hooksVersion: hooksVersionField.hooksVersion,
    },
  };
}

export async function createGuardrailFromRequest(
  ctx: GuardrailWriteContext,
  parsed: ParsedGuardrailCreate,
  /** Server-set record fields a request body may not carry (a template marker). */
  extras: { metadata?: Record<string, unknown> } = {},
): Promise<GuardrailView> {
  const { body, name, action, enabled, mode, hooks, hooksVersion } = parsed;

  // With `hooks` in the body the legacy columns are DERIVED from it rather
  // than taken from the request, so the two descriptions of one policy can
  // never be saved disagreeing. The draft is the row this create would have
  // produced without hooks: the projection reads it for what it cannot derive
  // (a preserved category selection, the operator's `type` when nothing is
  // enabled).
  const legacy = hooks
    ? await projectLegacyColumns(
        ctx.tenantDbName,
        hooks,
        {
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          // Assigned by createGuardrail from the name; never read by the
          // projection.
          key: '',
          name,
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
          createdBy: ctx.actorId,
        },
        ctx.projectId,
      )
    : undefined;

  return createGuardrail(ctx.tenantDbName, ctx.tenantId, ctx.actorId, {
    action: legacy?.action ?? action,
    customPrompt: legacy?.customPrompt ?? (body.customPrompt as string | undefined),
    description: typeof body.description === 'string' ? body.description.trim() : undefined,
    enabled,
    failMode: legacy?.failMode ?? (body.failMode as 'open' | 'closed' | undefined),
    hooks,
    hooksVersion,
    modelKey: legacy?.modelKey ?? (body.modelKey as string | undefined),
    mode,
    name,
    policy: (legacy?.policy ?? body.policy) as Record<string, unknown> | undefined,
    projectId: ctx.projectId,
    target: legacy?.target,
    type: legacy?.type ?? (body.type as GuardrailType),
    ...(extras.metadata ? { metadata: extras.metadata } : {}),
  });
}

export interface ParsedGuardrailPatch {
  /** The request body; `hooks` has been re-spelled in place by `readHooksField`. */
  body: Record<string, unknown>;
  mode?: GuardrailMode;
  hooks?: GuardrailHooksConfig;
  hooksVersion?: number;
}

export type GuardrailPatchParseResult = { ok: true; value: ParsedGuardrailPatch } | GuardrailWriteError;

/**
 * Validates the part of a PATCH body that does not depend on the stored
 * record. The model-configuration check needs the record and runs in
 * `updateGuardrailFromRequest`.
 */
export function parseGuardrailPatchBody(body: Record<string, unknown>): GuardrailPatchParseResult {
  if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
    return fail('action must be "block", "warn", "flag", or "redact"');
  }
  if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
    return fail('failMode must be "open" or "closed"');
  }

  const modeField = readModeField(body);
  if (modeField.error) return fail(modeField.error);
  const hooksVersionField = readHooksVersionField(body);
  if (hooksVersionField.error) return fail(hooksVersionField.error);
  const regexRuleError = findRegexRuleError(body);
  if (regexRuleError) return fail(regexRuleError);
  const hooksField = readHooksField(body);
  if (hooksField.errors) return fail(hooksField.errors[0], hooksField.errors);

  return {
    ok: true,
    value: {
      body,
      mode: modeField.mode,
      hooks: hooksField.hooks,
      hooksVersion: hooksVersionField.hooksVersion,
    },
  };
}

export type GuardrailUpdateResult =
  | { ok: true; guardrail: GuardrailView | null }
  | GuardrailWriteError;

export async function updateGuardrailFromRequest(
  ctx: GuardrailWriteContext,
  existing: GuardrailView,
  parsed: ParsedGuardrailPatch,
): Promise<GuardrailUpdateResult> {
  const { body, mode, hooks, hooksVersion } = parsed;

  // The LLM-model gate needs the record's own modelKey when the body does not
  // restate it, or a PATCH that only edits `hooks` would be rejected for a
  // model the guardrail already has.
  const modelConfigError = findLlmModelConfigError({
    ...body,
    modelKey: body.modelKey ?? existing.modelKey,
  });
  if (modelConfigError) return fail(modelConfigError);

  // Projected against the record AS IT WILL BE, not as it is: the fields this
  // PATCH also changes are the ones the projection falls back to for anything
  // it cannot derive, so folding them in first is what stops a combined edit
  // ("soften the action AND change a policy") from projecting the old action.
  const legacy = hooks
    ? await projectLegacyColumns(
        ctx.tenantDbName,
        hooks,
        {
          ...toGuardrailRecord(existing),
          action: (body.action as GuardrailAction | undefined) ?? existing.action,
          enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
          failMode: (body.failMode as 'open' | 'closed' | undefined) ?? existing.failMode,
          modelKey: (body.modelKey as string | undefined) ?? existing.modelKey,
          policy: (body.policy as IGuardrail['policy']) ?? existing.policy,
          customPrompt: (body.customPrompt as string | undefined) ?? existing.customPrompt,
        },
        ctx.projectId,
      )
    : undefined;

  // `type`, `target` and `metadata` are computed by the projection but have no
  // slot on UpdateGuardrailInput, so they cannot be written here.
  const guardrail = await updateGuardrail(ctx.tenantDbName, existing.id, ctx.actorId, {
    action: legacy?.action ?? (body.action as GuardrailAction | undefined),
    customPrompt: legacy?.customPrompt ?? (body.customPrompt as string | undefined),
    description: body.description as string | undefined,
    enabled: body.enabled as boolean | undefined,
    failMode: legacy?.failMode ?? (body.failMode as 'open' | 'closed' | undefined),
    hooks,
    hooksVersion,
    modelKey: legacy?.modelKey ?? (body.modelKey as string | undefined),
    mode,
    name: body.name as string | undefined,
    policy: (legacy?.policy ?? body.policy) as Record<string, unknown> | undefined,
  });

  return { ok: true, guardrail };
}

/** The caller-facing summary line for a set of guardrail findings. */
export function buildUserMessage(findings: Array<{ block: boolean; category: string; message: string }>) {
  const blocking = findings.filter((finding) => finding.block);
  if (blocking.length === 0) {
    return 'Content flagged by guardrail.';
  }

  return `Content blocked by guardrail:\n${blocking
    .map((finding) => `• ${formatCategory(finding.category)}: ${finding.message}`)
    .join('\n')}`;
}

function formatCategory(category: string): string {
  return category
    .replace(/[_/-]+/g, ' ')
    .replace(/(^|\s)\w/g, (segment) => segment.toUpperCase())
    .trim();
}
