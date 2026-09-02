/**
 * The write side of `guardrails: IGuardrailBinding[]` — the multi-guardrail
 * binding an operator attaches to a model or an agent.
 *
 * `@/lib/services/guardrail/hooks/binding` owns the READ side (which guardrail
 * runs on which hook, legacy fallback included) and is pure. This module owns
 * the four things only the API layer can do, because they need the request's
 * tenant/project scope and the guardrail records themselves:
 *
 *   1. parse an untrusted body field into `IGuardrailBinding[]`,
 *   2. check every referenced key exists in the caller's scope,
 *   3. check a binding's `hooks` against what that guardrail actually declares,
 *   4. keep the deprecated `inputGuardrailKey` / `outputGuardrailKey` columns
 *      in sync so an older console binary on the same tenant DB still enforces.
 *
 * It lives beside the route plugins rather than inside one because FOUR of them
 * write bindings — `models`, `client-models`, `agents`, `client-agents`. A
 * per-plugin copy of the validator is how a dashboard write and an API write
 * end up accepting different payloads, and the field that one of them silently
 * drops is a guardrail that stops running with a green UI. `guardrails.ts`
 * already exports `guardrailByKeyInScope` for exactly this kind of cross-plugin
 * reuse (`client-guardrails.ts:202`).
 */

import type { IAgentConfig, IUser } from '@/lib/database';
import type {
  GuardrailHookId,
  IGuardrailBinding,
} from '@/lib/database/provider/types.domain';
import { createLogger } from '@/lib/core/logger';
import { HOOK_IDS } from '@/lib/services/guardrail/hooks/contract';
import { projectBindingsToLegacy } from '@/lib/services/guardrail/hooks/binding';
import { ensureHooks } from '@/lib/services/guardrail/hooks/legacy';
import type { GuardrailView } from '@/lib/services/guardrail';
import { guardrailByKeyInScope, toGuardrailRecord } from './guardrails';

const HOOK_LIST = HOOK_IDS.join(', ');
const logger = createLogger('api:guardrail-bindings');

/**
 * A legacy slot that carries no guardrail. `''` rather than `undefined`:
 * `updateModel` skips an `undefined` field (sqlite/model.mixin.ts:76-79), so
 * `undefined` would leave a stale key in the column and an older binary would
 * keep enforcing a guardrail the operator has just unbound.
 */
const CLEARED_SLOT = '';

// ── 1. Parse ──────────────────────────────────────────────────────────────

export interface GuardrailBindingsField {
  /** Present only when the body carried the field AND it parsed. */
  bindings?: IGuardrailBinding[];
  error?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHookId(value: unknown): value is GuardrailHookId {
  return typeof value === 'string' && (HOOK_IDS as readonly string[]).includes(value);
}

/**
 * Read `guardrails` off a write body.
 *
 * Returns `{}` for an absent field — "not mentioned", which every caller must
 * keep distinct from `{ bindings: [] }`, "bound to nothing". `[]` is a real
 * operator action (disarm every binding) and the resolver honours it literally;
 * conflating the two would silently re-arm the legacy fallback.
 *
 * Each accepted entry is REBUILT as `{ key, hooks }` rather than passed through,
 * so a caller cannot smuggle extra properties into a column that is persisted
 * as opaque JSON and read back structurally.
 */
export function readGuardrailBindingsField(raw: unknown): GuardrailBindingsField {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) {
    return { error: '`guardrails` must be an array of { key, hooks? } objects' };
  }

  const bindings: IGuardrailBinding[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < raw.length; index += 1) {
    const entry: unknown = raw[index];
    if (!isPlainRecord(entry)) {
      return { error: `\`guardrails[${index}]\` must be an object with a \`key\`` };
    }

    const key = entry.key;
    if (typeof key !== 'string' || key.trim() === '') {
      return { error: `\`guardrails[${index}].key\` must be a non-empty guardrail key` };
    }

    // A repeated key is not merged: `resolveBindings` de-duplicates keeping the
    // FIRST occurrence, so a second entry for the same guardrail is config that
    // is stored, rendered and never applied. Rejecting it is the whole reason
    // this validator exists.
    if (seen.has(key)) {
      return {
        error: `\`guardrails\` lists "${key}" more than once — give each guardrail a single entry with one \`hooks\` list`,
      };
    }
    seen.add(key);

    if (entry.hooks === undefined) {
      // Omitted = every hook the guardrail itself declares. Deliberately kept
      // as an ABSENT property rather than materialised here: materialising it
      // would freeze today's declaration, so a later edit to the guardrail
      // would stop reaching a consumer that never asked to be pinned.
      bindings.push({ key });
      continue;
    }

    if (!Array.isArray(entry.hooks)) {
      return {
        error: `\`guardrails[${index}].hooks\` must be an array of hook ids (${HOOK_LIST})`,
      };
    }

    const hooks: GuardrailHookId[] = [];
    for (const hook of entry.hooks) {
      if (!isHookId(hook)) {
        return {
          error: `\`guardrails[${index}].hooks\` contains "${String(hook)}", which is not a hook id — expected one of ${HOOK_LIST}`,
        };
      }
      if (!hooks.includes(hook)) hooks.push(hook);
    }

    bindings.push({ key, hooks });
  }

  return { bindings };
}

// ── 2/3. Validate against the referenced guardrails ───────────────────────

/**
 * Which hooks a guardrail will ACTUALLY do something on: the hook needs an
 * enabled binding in the guardrail's own config AND an enabled policy naming it.
 * This is the same test `projectHooksToLegacy` applies (`activeHooks`,
 * legacy.ts:578) — a policy with no enabled binding, or a binding with no
 * enabled policy, is the "configured and never runs" state the hook matrix
 * exists to make visible.
 *
 * `ensureHooks` lifts a legacy row on the way through, so a guardrail written
 * before the hook plane reports `input.pre` + `output.pre` — exactly the two
 * slots it was bindable to — rather than nothing at all.
 */
export function declaredGuardrailHooks(view: GuardrailView): GuardrailHookId[] {
  const { hooks } = ensureHooks(toGuardrailRecord(view));
  const policies = hooks.policies ?? [];
  return HOOK_IDS.filter(
    (hook) =>
      hooks.bindings?.[hook]?.enabled === true &&
      policies.some((policy) => policy.enabled && policy.hooks?.includes(hook)),
  );
}

/**
 * A binding that is VALID but will not do what the operator most likely
 * expects. Not a 400 — the configuration is legal and may be intended — but a
 * structured note the API and the UI can surface next to the saved binding.
 *
 * `stream_unenforced`: a MODEL binding covers `output.pre` and not
 * `output.stream.delta`. The gateway enforces `output.pre` on non-streaming
 * completions only; a `stream: true` request delivers the whole answer and then
 * writes an AUDIT row for that guardrail (`inferenceService` — the post-hoc
 * pass). The natural migration from `outputGuardrailKey` (which projects onto
 * BOTH hooks) to `guardrails: [{ key, hooks: ['output.pre'] }]` therefore
 * silently turns enforcement off for every streaming client, with a green UI.
 */
export interface GuardrailBindingWarning {
  code: 'stream_unenforced';
  key: string;
  message: string;
}

export interface GuardrailBindingsValidation {
  /** The operator-facing 400 message, or `null` when the list is bindable. */
  error: string | null;
  /** Non-blocking notes about bindable-but-surprising configurations. */
  warnings: GuardrailBindingWarning[];
}

/**
 * Which consumer the bindings are being validated for. Agents never stream
 * through the gateway's stream gate (the agent SDK has no awaitable stream
 * hook, and `warnUnservableStreamBinding` already says so per run), so the
 * stream warning applies to MODELS only.
 */
export interface ValidateGuardrailBindingsOptions {
  consumer?: 'model' | 'agent';
}

/** One WARN per (tenant, key) per process — this runs on every binding write. */
const warnedStreamUnenforced = new Set<string>();

/**
 * Existence + hook-subset validation, WITH warnings.
 *
 * The subset test runs only when a binding names its `hooks` explicitly. An
 * omitted list delegates the choice to the guardrail, so there is nothing to be
 * a subset of — and validating it would reject attaching a guardrail whose
 * policies are still being authored, which is the normal order of work.
 *
 * Warnings are computed over the EFFECTIVE hooks — the binding's own list, or
 * the guardrail's declared hooks when the list is omitted — because a guardrail
 * whose own config never enables the stream hook is just as unenforced on a
 * stream as one whose binding narrows it away.
 */
export async function validateGuardrailBindingsDetailed(
  tenantDbName: string,
  projectId: string,
  bindings: readonly IGuardrailBinding[],
  user?: Pick<IUser, 'role'>,
  options: ValidateGuardrailBindingsOptions = {},
): Promise<GuardrailBindingsValidation> {
  const consumer = options.consumer ?? 'model';
  const warnings: GuardrailBindingWarning[] = [];

  for (const binding of bindings) {
    const view = await guardrailByKeyInScope(tenantDbName, binding.key, projectId, user);
    if (!view) {
      return { error: `Guardrail "${binding.key}" does not exist in this project`, warnings };
    }

    const declared = declaredGuardrailHooks(view);

    if (binding.hooks !== undefined && binding.hooks.length > 0) {
      const unsupported = binding.hooks.filter((hook) => !declared.includes(hook));
      if (unsupported.length > 0) {
        const available = declared.length > 0 ? declared.join(', ') : 'no hooks at all';
        return {
          error: `Guardrail "${binding.key}" has no enabled policy bound to ${unsupported.join(', ')} — it runs on ${available}`,
          warnings,
        };
      }
    }

    if (consumer !== 'model') continue;
    const effective = binding.hooks === undefined ? declared : binding.hooks;
    if (effective.includes('output.pre') && !effective.includes('output.stream.delta')) {
      const warning: GuardrailBindingWarning = {
        code: 'stream_unenforced',
        key: binding.key,
        message:
          `Guardrail "${binding.key}" is bound to output.pre but not output.stream.delta: `
          + 'streaming requests are audit-only for this binding — the answer is delivered in full '
          + 'and only an evaluation row is written. Bind output.stream.delta as well to gate streams.',
      };
      warnings.push(warning);
      const once = `${tenantDbName}/${binding.key}`;
      if (!warnedStreamUnenforced.has(once)) {
        warnedStreamUnenforced.add(once);
        logger.warn('Model guardrail binding leaves streaming requests audit-only', {
          tenantDbName,
          projectId,
          guardrailKey: binding.key,
          hooks: effective,
          code: warning.code,
        });
      }
    }
  }

  return { error: null, warnings };
}

/**
 * Existence + hook-subset validation. Returns the operator-facing message for a
 * 400, or `null` when the list is bindable.
 *
 * The string-returning shape every route already consumes; warnings are still
 * computed (and logged once) — callers that want to surface them use
 * `validateGuardrailBindingsDetailed`.
 */
export async function validateGuardrailBindings(
  tenantDbName: string,
  projectId: string,
  bindings: readonly IGuardrailBinding[],
  user?: Pick<IUser, 'role'>,
  options?: ValidateGuardrailBindingsOptions,
): Promise<string | null> {
  const { error } = await validateGuardrailBindingsDetailed(tenantDbName, projectId, bindings, user, options);
  return error;
}

/**
 * The guardrail fields a CONNECTED (external) agent config carries through.
 *
 * `normalizeAgentConfig` rebuilds an external config as `{ kind, connection }`
 * so nothing but the validated connection is stored — which also dropped
 * `guardrails` and the two legacy slots on the floor. The dashboard still
 * rendered the binding list for connected agents, so an operator could attach a
 * guardrail, see a 200, and never be enforced: `executeAgentChatLocal`'s
 * external branch reads exactly these fields and found nothing. They are carried
 * as sent here and VALIDATED by `resolveConfigGuardrailBindings` right after,
 * which replaces `guardrails` with the rebuilt, checked list (or 400s).
 */
export function carriedGuardrailFields(
  cfg: Record<string, unknown>,
): Pick<IAgentConfig, 'guardrails' | 'inputGuardrailKey' | 'outputGuardrailKey'> {
  const carried: Pick<IAgentConfig, 'guardrails' | 'inputGuardrailKey' | 'outputGuardrailKey'> = {};
  // Raw at this point; the validator rebuilds every entry as `{ key, hooks }`
  // and rejects anything else before the config is stored.
  if (Array.isArray(cfg.guardrails)) carried.guardrails = cfg.guardrails as IGuardrailBinding[];
  if (typeof cfg.inputGuardrailKey === 'string') carried.inputGuardrailKey = cfg.inputGuardrailKey;
  if (typeof cfg.outputGuardrailKey === 'string') carried.outputGuardrailKey = cfg.outputGuardrailKey;
  return carried;
}

// ── 4. Keep the deprecated slots in sync ──────────────────────────────────

/**
 * The two legacy columns a binding list projects to, ready to WRITE: an unbound
 * slot comes back as `''` rather than `undefined` so the column is actually
 * blanked instead of left untouched.
 *
 * A binding scoped only to `output.stream.delta` or to `tool.*` has no legacy
 * representation and is not projected — see `projectBindingsToLegacy`.
 */
export function legacyGuardrailSlots(bindings: readonly IGuardrailBinding[]): {
  inputGuardrailKey: string;
  outputGuardrailKey: string;
} {
  const projected = projectBindingsToLegacy([...bindings]);
  return {
    inputGuardrailKey: projected.inputGuardrailKey ?? CLEARED_SLOT,
    outputGuardrailKey: projected.outputGuardrailKey ?? CLEARED_SLOT,
  };
}

/**
 * The agent flavour: parse, validate and normalise `config.guardrails` in one
 * step, returning the patch to merge back onto the config.
 *
 * The legacy slots are projected as `undefined` here, not `''`: an agent's
 * config is persisted as ONE JSON blob and replaced wholesale on write, so an
 * absent property IS a cleared slot — an empty string would only add a field
 * every reader then has to treat as falsy.
 *
 * Returns `{}` when `config.guardrails` is absent, leaving whatever legacy keys
 * the caller sent untouched. That needs no conflict guard: unlike a model
 * update, a config write replaces the whole object, so a client that omits
 * `guardrails` clears it rather than being silently overruled by it.
 */
export async function resolveConfigGuardrailBindings(
  tenantDbName: string,
  projectId: string,
  rawGuardrails: unknown,
  user?: Pick<IUser, 'role'>,
): Promise<{
  patch?: {
    guardrails: IGuardrailBinding[];
    inputGuardrailKey: string | undefined;
    outputGuardrailKey: string | undefined;
  };
  error?: string;
}> {
  const field = readGuardrailBindingsField(rawGuardrails);
  if (field.error) return { error: field.error };
  if (!field.bindings) return {};

  // Agents do not stream through the gateway's gate, so the model-only stream
  // warning does not apply here; `warnUnservableStreamBinding` covers the agent
  // side per run.
  const invalid = await validateGuardrailBindings(
    tenantDbName,
    projectId,
    field.bindings,
    user,
    { consumer: 'agent' },
  );
  if (invalid) return { error: invalid };

  return {
    patch: {
      guardrails: field.bindings,
      ...projectBindingsToLegacy(field.bindings),
    },
  };
}

/**
 * Guard for the ONE way the two binding generations can silently disagree.
 *
 * A model update is per-field, so a client that writes `inputGuardrailKey`
 * alone leaves a stored `guardrails` array untouched — and `resolveBindings`
 * treats that array as authoritative and ignores the legacy keys. The write
 * would report 200, the screen would re-read the column it just set, and the
 * guardrail it named would never run.
 *
 * An ECHO is allowed: a client that resends the legacy columns it loaded is
 * changing nothing, and those columns are kept in sync by
 * `legacyGuardrailSlots`, so an unrelated edit (a rename, a price change) still
 * goes through. Only a legacy write that would actually CHANGE the binding is
 * rejected, and the message names the field to send instead.
 *
 * The model edit screen no longer sends those columns at all — it posts
 * `guardrails` through the binding overlay — but the allowance is still load
 * bearing for the token API, the client API and any older integration that
 * round-trips a whole model record.
 *
 * Agents need no equivalent: their `config` is replaced wholesale, so a config
 * without `guardrails` clears it rather than being ignored — the same semantics
 * every other config field already has.
 */
export function legacyGuardrailWriteConflict(
  existing: { guardrails?: IGuardrailBinding[] },
  body: { inputGuardrailKey?: unknown; outputGuardrailKey?: unknown },
): string | null {
  const current = existing.guardrails;
  if (!Array.isArray(current) || current.length === 0) return null;

  const projected = legacyGuardrailSlots(current);
  const conflicting = (['inputGuardrailKey', 'outputGuardrailKey'] as const).filter(
    (slot) =>
      body[slot] !== undefined && String(body[slot] ?? CLEARED_SLOT) !== projected[slot],
  );
  if (conflicting.length === 0) return null;

  return `This model's guardrails are bound as a list, so \`${conflicting.join('` and `')}\` cannot be changed on its own — send the full \`guardrails\` array instead`;
}
