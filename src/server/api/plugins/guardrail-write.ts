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
  GuardrailHooksConfig,
  GuardrailMode,
  GuardrailType,
} from '@/lib/database';
import { createGuardrail, updateGuardrail } from '@/lib/services/guardrail';
import type { GuardrailView } from '@/lib/services/guardrail';
import {
  GUARDRAIL_CONTRACT_VERSION,
  isPlainRecord,
  normalizeHooksConfig,
  readPolicyList,
} from '@/lib/services/guardrail/hooks/contract';
import type { PolicyFamily } from '@/lib/services/guardrail/hooks/contract';
import { validateGuardrailHooks } from '@/lib/services/guardrail/hooks/validate';
// Reached at its own path, like the hook-plane modules above: this is the
// family's own account of why a pattern will not run, and a configuration
// surface that rejects a rule owes its author that account rather than a
// second, drifting opinion of what JavaScript accepts.
import { explainRegexRuleError } from '@/lib/services/guardrail/families/regex';

/**
 * 'redact' is a first-class rung of the hook plane. Leaving it off this list
 * would make a round trip fail: the edit screen re-sends the action it was
 * given and would get a 400 for a value the server itself wrote.
 */
const VALID_ACTIONS: GuardrailAction[] = ['block', 'warn', 'flag', 'redact'];
/** The values the list routes accept for `?type=`: a stored label, not an input to create. */
export const VALID_TYPES: GuardrailType[] = ['preset', 'custom'];
const VALID_FAIL_MODES = ['open', 'closed'];
const VALID_MODES: GuardrailMode[] = ['enforce', 'monitor', 'disabled'];

/** The families evaluated by a model, i.e. the ones that need a `modelKey`. */
const LLM_POLICY_FAMILIES: ReadonlySet<string> = new Set<PolicyFamily>([
  'moderation',
  'prompt_shield',
  'custom',
]);

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
 * LLM-backed policies silently no-op without a model, which reads as "guardrail
 * active" while nothing runs. Reject configurations that enable an LLM policy
 * with no model to run it on.
 */
export function findLlmModelConfigError(body: Record<string, unknown>): string | null {
  const modelKey = typeof body.modelKey === 'string' && body.modelKey.trim() !== '' ? body.modelKey : undefined;

  // An enabled LLM family with no model reads as active while it evaluates
  // nothing, so it is refused here.
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
}

export type GuardrailCreateParseResult = { ok: true; value: ParsedGuardrailCreate } | GuardrailWriteError;

/**
 * Fields of the pre-hook guardrail model. Each one described what to enforce,
 * so a body that still carries one must fail loudly: ignoring it would store a
 * guardrail that enforces nothing while the caller believes it is configured.
 */
const RETIRED_BODY_FIELDS = ['policy', 'customPrompt'] as const;

function findRetiredField(body: Record<string, unknown>): string | null {
  for (const field of RETIRED_BODY_FIELDS) {
    if (body[field] !== undefined) {
      return `${field} is no longer supported: describe what the guardrail enforces in hooks.policies`;
    }
  }
  if (body.type !== undefined && body.type !== 'preset') {
    return 'type is no longer supported: omit it, or send "preset". A rule judged by an LLM is a custom policy in hooks.policies';
  }
  return null;
}

/** Validates a create body. Does not touch the database. */
export function parseGuardrailCreateBody(body: Record<string, unknown>): GuardrailCreateParseResult {
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return fail('name is required');
  }
  const retired = findRetiredField(body);
  if (retired) return fail(retired);
  if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
    return fail('action must be "block", "warn", "flag", or "redact"');
  }
  if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
    return fail('failMode must be "open" or "closed"');
  }

  const modeField = readModeField(body);
  if (modeField.error) return fail(modeField.error);
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
    },
  };
}

export async function createGuardrailFromRequest(
  ctx: GuardrailWriteContext,
  parsed: ParsedGuardrailCreate,
): Promise<GuardrailView> {
  const { body, name, action, enabled, mode, hooks } = parsed;

  return createGuardrail(ctx.tenantDbName, ctx.tenantId, ctx.actorId, {
    action,
    description: typeof body.description === 'string' ? body.description.trim() : undefined,
    enabled,
    failMode: body.failMode as 'open' | 'closed' | undefined,
    hooks,
    modelKey: body.modelKey as string | undefined,
    mode,
    name,
    projectId: ctx.projectId,
  });
}

export interface ParsedGuardrailPatch {
  /** The request body; `hooks` has been re-spelled in place by `readHooksField`. */
  body: Record<string, unknown>;
  mode?: GuardrailMode;
  hooks?: GuardrailHooksConfig;
}

export type GuardrailPatchParseResult = { ok: true; value: ParsedGuardrailPatch } | GuardrailWriteError;

/**
 * Validates the part of a PATCH body that does not depend on the stored
 * record. The model-configuration check needs the record and runs in
 * `updateGuardrailFromRequest`.
 */
export function parseGuardrailPatchBody(body: Record<string, unknown>): GuardrailPatchParseResult {
  const retired = findRetiredField(body);
  if (retired) return fail(retired);
  if (body.action !== undefined && !VALID_ACTIONS.includes(body.action as GuardrailAction)) {
    return fail('action must be "block", "warn", "flag", or "redact"');
  }
  if (body.failMode !== undefined && !VALID_FAIL_MODES.includes(body.failMode as string)) {
    return fail('failMode must be "open" or "closed"');
  }

  const modeField = readModeField(body);
  if (modeField.error) return fail(modeField.error);
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
  const { body, mode, hooks } = parsed;

  // The LLM-model gate needs the record's own modelKey when the body does not
  // restate it, or a PATCH that only edits `hooks` would be rejected for a
  // model the guardrail already has.
  const modelConfigError = findLlmModelConfigError({
    ...body,
    modelKey: body.modelKey ?? existing.modelKey,
  });
  if (modelConfigError) return fail(modelConfigError);

  const guardrail = await updateGuardrail(ctx.tenantDbName, existing.id, ctx.actorId, {
    action: body.action as GuardrailAction | undefined,
    description: body.description as string | undefined,
    enabled: body.enabled as boolean | undefined,
    failMode: body.failMode as 'open' | 'closed' | undefined,
    hooks,
    modelKey: body.modelKey as string | undefined,
    mode,
    name: body.name as string | undefined,
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
