import type { HookId } from '@/lib/services/guardrail/hooks/contract';

/**
 * Console hook -> PLUGIN hook. The SDK exports this table as
 * `CONSOLE_HOOK_MAP`; this is the fallback copy, used when the installed build
 * has no plugin layer to ask (and asserted against the SDK's own when it does).
 *
 * SINGLE-VALUED IN BOTH DIRECTIONS, which is what makes the reverse lookup
 * unambiguous. `output.stream.delta` maps to null — an explicit "there is no
 * plugin hook here", not a missing entry, so a hook that gains one later is a
 * value change rather than a new key nobody notices is absent.
 */
export const CONSOLE_HOOK_MAP: Readonly<Record<HookId, string | null>> = {
  'prompt.pre': 'userPromptSubmit',
  'input.pre': 'preModelCall',
  'output.pre': 'postModelCall',
  'output.stream.delta': null,
  'tool.pre': 'preToolUse',
  'tool.post': 'postToolUse',
};

/**
 * Which payload field each plugin hook lets a handler REWRITE, per the SDK
 * team's list. A hook absent from this table can block but not rewrite, and a
 * `redact` verdict there is reported as not-landed rather than silently dropped.
 *
 * `preModelCall.messages` IS writable (the host declares `mutable: ["messages",
 * "tools"]`, dist/index.mjs:6341) and the adapter now rewrites it PER MESSAGE:
 * the scanned slice is segmented by message index, so a redacted span maps back
 * to the exact message it came from. What lands is the WIRE transcript — the
 * host sends `gate.input.messages` to the provider and leaves `state.messages`
 * alone (dist/index.mjs:4070) — so the console persists the rewritten user turn
 * through `SdkGuardrailContext.onMessageRewrite` rather than by reading it back
 * out of `result.messages`.
 *
 * `preFinalAnswer.content` is listed for completeness even though no console
 * hook binds it; `preFinalAnswer.continueWith` is deliberately NOT here,
 * because the SDK accepts it in the type and does not implement it.
 */
export const PLUGIN_REWRITE_FIELD: Readonly<Record<string, string>> = {
  userPromptSubmit: 'text',
  preModelCall: 'messages',
  postModelCall: 'message',
  preToolUse: 'args',
  postToolUse: 'output',
  preFinalAnswer: 'content',
};

/**
 * LEGACY plane. Keyed by the SDK phase's STRING NAME rather than by an enum
 * member, on purpose: the members are only reachable from the loaded module,
 * while `GuardrailPhase` is a STRING enum whose values are what the SDK's own
 * compiled output compares against.
 *
 * `userPromptSubmit` and `preModelCall` appear as two entries rather than one:
 * they are two different moments, and collapsing them is exactly the conflation
 * `prompt.pre` was added to end.
 */
export const PHASE_HOOKS: Readonly<Record<string, HookId>> = {
  userPromptSubmit: 'prompt.pre',
  preModelCall: 'input.pre',
  response: 'output.pre',
};

/**
 * OLDER SPELLINGS of a surface in `PHASE_HOOKS`, resolved before the lookup.
 *
 * `GuardrailPhase.Request` ("request") is the installed SDK's name for the
 * pre-model-call seam, and it is that seam — the partner team measured it: the
 * phase's own de-duplication gate is `store.lastRequestLength !==
 * state.messages.length`, so it re-fires whenever the transcript grows, tool
 * results included. Aliasing rather than renaming is what keeps `input.pre`
 * byte-identical on the SDK version that is actually installed: drop the alias
 * and every agent-side input guardrail in the fleet stops being served, with a
 * green UI and no error.
 */
const PHASE_ALIASES: Readonly<Record<string, string>> = {
  request: 'preModelCall',
};

/** The ONE resolution of "which console hook does this SDK phase drive". */
export function hookForPhase(phase: string): HookId | undefined {
  return PHASE_HOOKS[PHASE_ALIASES[phase] ?? phase];
}

/** Every hook `PHASE_HOOKS` can serve, for the legacy compile-time plan. */
export const SERVABLE_HOOKS: ReadonlySet<HookId> = new Set<HookId>(Object.values(PHASE_HOOKS));
