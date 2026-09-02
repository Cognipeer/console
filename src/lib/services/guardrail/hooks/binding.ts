/**
 * `resolveBindings` — the ONE place that answers "which guardrails run on this
 * hook, for this model / this agent?".
 *
 * Two binding generations exist and must coexist for at least one release:
 *
 *  1. LEGACY, one slot per direction: `inputGuardrailKey` and
 *     `outputGuardrailKey`, both on `IModel` and inside `IAgentConfig`. Every
 *     row written before the hook plane carries these and nothing else.
 *  2. `guardrails: IGuardrailBinding[]` — an ordered list, each entry naming
 *     the hooks it fires on, so several reusable guardrails compose and
 *     `tool.pre`/`tool.post` become bindable at all (the legacy shape has no
 *     slot for them).
 *
 * Both call sites (the gateway's model binding and the agent's config binding)
 * go through this function. Two hand-rolled copies of the fallback would drift,
 * and a drifted fallback is a guardrail that silently stops running on one
 * surface while the UI still shows it attached.
 *
 * Pure: no I/O, no database, no guardrail record needed. Whether the named
 * guardrail exists, is enabled, or actually declares the hook is the engine's
 * business (`resolveGuardrail` / `runHook`) — this function only answers which
 * KEYS the consumer points at.
 */

import type {
  GuardrailHookId,
  IGuardrailBinding,
} from '@/lib/database/provider/types.domain';

/**
 * The shape both consumers share. Deliberately structural rather than
 * `IModel | IAgentConfig`: the resolver needs three fields, and typing it to
 * the two records would force every caller with a partial (an unsaved form, a
 * version snapshot, a test fixture) to fabricate the rest.
 */
export interface GuardrailBindingSource {
  guardrails?: IGuardrailBinding[];
  /** @deprecated Legacy single slot — read only when `guardrails` is absent. */
  inputGuardrailKey?: string;
  /** @deprecated Legacy single slot — read only when `guardrails` is absent. */
  outputGuardrailKey?: string;
}

/**
 * Hooks a legacy `outputGuardrailKey` projects onto.
 *
 * `output.stream.delta` is included because the legacy slot means "check what
 * the assistant says", and the streaming gate is the same policy applied before
 * the bytes leave rather than after. Omitting it would make an upgrade to a
 * streaming client silently bypass the guardrail that was enforcing yesterday.
 */
const LEGACY_OUTPUT_HOOKS: readonly GuardrailHookId[] = [
  'output.pre',
  'output.stream.delta',
];

/** Hooks a legacy `inputGuardrailKey` projects onto. */
const LEGACY_INPUT_HOOKS: readonly GuardrailHookId[] = ['input.pre'];

/**
 * Guardrail keys bound to `hook` on `source`, in binding order, de-duplicated.
 *
 * Order is preserved and duplicates are dropped keeping the FIRST occurrence.
 * `runHook` folds verdicts with max(), so order cannot change the decision —
 * but it does decide which guardrail's blocked-message the end user sees, and
 * an operator who put the friendlier guardrail first meant it.
 */
export function resolveBindings(
  source: GuardrailBindingSource,
  hook: GuardrailHookId,
): string[] {
  // `guardrails` PRESENT is authoritative and the legacy keys are IGNORED, not
  // merged. Merging would double-run any guardrail an operator moved into the
  // array while the deprecated column was still being written for
  // compatibility — and a double run is a double evaluation log and a double
  // bill for the model-backed families.
  //
  // An empty array is therefore honest: "authored, bound to nothing". That is
  // exactly why an absent column must map to `undefined` and never to `[]` in
  // the persistence layer — `[]` would read as an operator decision to disarm.
  if (source.guardrails) {
    return dedupe(
      source.guardrails
        .filter((binding) => bindingCoversHook(binding, hook))
        .map((binding) => binding.key),
    );
  }

  // No `guardrails`: project the legacy slots. Nothing legacy binds to
  // `tool.pre`/`tool.post` — a row written before the hook plane never opted
  // into tool enforcement, and inventing that binding on upgrade would start
  // blocking tool calls that worked yesterday, on a policy nobody wrote.
  if (LEGACY_INPUT_HOOKS.includes(hook)) {
    return dedupe([source.inputGuardrailKey]);
  }
  if (LEGACY_OUTPUT_HOOKS.includes(hook)) {
    return dedupe([source.outputGuardrailKey]);
  }
  return [];
}

/**
 * The deprecated single slots, derived from `bindings`, so a save that writes
 * the array keeps the legacy columns in sync for one release: an older console
 * binary reading the same tenant database sees only those columns, and a
 * consumer whose guardrails moved into the array must not silently stop being
 * guarded there.
 *
 * BOTH keys are always present in the result, valued `undefined` when nothing
 * covers that hook, so a caller can tell "no longer bound" apart from "not
 * mentioned". That distinction matters: the SQLite update mixins treat a
 * `undefined` field as "leave the column alone", so a caller that wants to
 * CLEAR a slot has to write an explicit empty value rather than spread this
 * result blindly.
 *
 * Only `input.pre` and `output.pre` project. A binding scoped to
 * `output.stream.delta` alone does NOT become `outputGuardrailKey`: the old
 * binary has no stream gate and would run it as a full post-hoc output policy,
 * i.e. enforce something the operator explicitly narrowed. Tool-only bindings
 * have no legacy slot at all and are simply not representable.
 */
export function projectBindingsToLegacy(bindings?: IGuardrailBinding[]): {
  inputGuardrailKey: string | undefined;
  outputGuardrailKey: string | undefined;
} {
  const first = (hook: GuardrailHookId): string | undefined =>
    bindings
      ?.filter((binding) => bindingCoversHook(binding, hook))
      .map((binding) => binding.key)
      .find(isNonEmptyKey);

  return {
    inputGuardrailKey: first('input.pre'),
    outputGuardrailKey: first('output.pre'),
  };
}

/**
 * An omitted `hooks` list delegates the choice to the guardrail itself — the
 * binding activates wherever the guardrail declares it runs, which is what
 * attaching one without further configuration should mean. An explicitly empty
 * list is honoured literally (bound to nothing), so an operator can park a
 * binding without deleting it.
 */
function bindingCoversHook(
  binding: IGuardrailBinding,
  hook: GuardrailHookId,
): boolean {
  if (!isNonEmptyKey(binding.key)) return false;
  return binding.hooks === undefined || binding.hooks.includes(hook);
}

/**
 * A blank key is not a binding. SQLite stores a cleared legacy slot as `''`
 * rather than NULL on some write paths, and an empty key would otherwise reach
 * `resolveGuardrail` as a lookup that can only fail — noise in the logs at
 * best, a fail-closed block at worst.
 */
function isNonEmptyKey(key: string | undefined): key is string {
  return typeof key === 'string' && key.trim().length > 0;
}

/** Keeps first occurrence; drops blanks. */
function dedupe(keys: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (!isNonEmptyKey(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
