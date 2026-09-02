/**
 * THE @cognipeer/agent-sdk BRIDGE — the only file in the guardrail plane that
 * touches the SDK, and it touches it exclusively through `await import()`.
 *
 * WHY THE DYNAMIC IMPORT. A static `import { createGuardrail } from
 * '@cognipeer/agent-sdk'` links the whole SDK — providers, tracing sinks,
 * ContextPilot, the skill loader — into every bundle that transitively reaches
 * the guardrail service, which is the gateway hot path, the MCP bridge and the
 * moderation API. None of those run an agent. `agentService.ts:1441` already
 * establishes the idiom for exactly this reason; this file follows it. The
 * module-level `import type` below is erased at compile time and links nothing.
 *
 * ── TWO PLANES, AND WHICH ONE IS PRIMARY ──────────────────────────────────
 *
 * The SDK has a PLUGIN layer, and since 0.10.0 it is what the console's own
 * agent path actually runs on (`agentService.buildAgentGuardrailPlugins`). The
 * older `ConversationGuardrail` bridge stays as the FALLBACK — not for us, but
 * because it is the published integration surface a customer on an older SDK
 * still uses.
 *
 * Nothing here may ASSUME either plane. Every fact about the plugin layer is
 * feature-detected at runtime through `probeSdkCapabilities()`, and
 * `compileConsoleGuardrail()` picks the plane per process from what it finds.
 * That is not defensive habit: the console ships to self-hosted installs that
 * pin their own SDK version, and the plane has to be decided from the module
 * that is actually loaded.
 *
 *   PLUGIN plane (`compileToSdkPlugin`) — the primary path.
 *     · Five of the six console hooks have a plugin hook behind them, through
 *       the SDK's own `CONSOLE_HOOK_MAP`: prompt.pre→userPromptSubmit,
 *       input.pre→preModelCall, output.pre→postModelCall, tool.pre→preToolUse,
 *       tool.post→postToolUse. `output.stream.delta` maps to null.
 *     · A `redact` verdict is a REAL REWRITE. `preToolUse.args`,
 *       `postToolUse.output`, `postModelCall.message`,
 *       `userPromptSubmit.text|content` and `preModelCall.messages` (per
 *       message, on the WIRE transcript — see `PLUGIN_REWRITE_FIELD`) are
 *       writable, and rewrites CHAIN in `priority` order — handler N sees N-1's
 *       output — so several plugins rewriting the same payload compose instead
 *       of last-writer-wins. This is the capability `GuardrailDisposition` never
 *       had and the reason the move is worth making.
 *     · Plugins are FORWARDED TO SUB-AGENTS (`buildChild` passes
 *       `pluginHost.childPlugins()`); `inheritToSubagents: false` opts out. The
 *       legacy `guardrails` array is NOT forwarded, which is the decisive
 *       argument: on the legacy plane a tool policy is bypassable by delegating
 *       the call to a child agent.
 *     · `failureMode` is set EXPLICITLY from the console record's own
 *       `failMode`. The SDK defaults to `'closed'` and the console defaults to
 *       OPEN, so leaving it implicit would make one guardrail behave oppositely
 *       on two surfaces.
 *
 *   LEGACY plane (`compileToSdkGuardrail`) — kept, not deprecated away.
 *     · Serves prompt.pre / input.pre / output.pre only, through
 *       `GuardrailPhase`. That enum has two members, so there is no tool seam
 *       and no mutation channel on this plane — but those are limits of THIS
 *       PLANE, not of the agent path, and the capability strings now say so.
 *
 * ── WHAT IS UNSERVABLE ON BOTH ────────────────────────────────────────────
 * `output.stream.delta`. The SDK's own plugin capability report states it, and
 * the string is quoted verbatim in `HOOK_CAPABILITY_REASON`: "There is no hook
 * on stream deltas. onStream is synchronous and void, so a chunk cannot be held
 * back or blocked in real time. A postModelCall rewrite fixes the transcript,
 * never what was already emitted." The console enforces streaming in the
 * gateway, where it owns the socket.
 *
 * ── THE THREE HOOK CAVEATS the SDK team called out ────────────────────────
 * They change what an operator should EXPECT, so they travel in the capability
 * strings rather than in a design doc:
 *   · `userPromptSubmit` does not fire on RESUME — the resumed transcript's
 *     tail is a tool result, not a user message.
 *   · `postToolUse` does not fire for a call that PARKS the run for approval.
 *   · `preFinalAnswer.continueWith` is accepted by the type but not
 *     implemented. Nothing here binds `preFinalAnswer`; it is recorded in the
 *     probe's diagnostics so a future binding does not rediscover it.
 *
 * TOTALITY IS LOAD-BEARING, on both planes. `evaluateGuardrails` wraps
 * `rule.evaluate` in try/catch and converts ANY throw into
 * `{passed:false, disposition:'block'}` (index.mjs:5243-5250) — FAIL-CLOSED,
 * unconditionally — and the plugin host applies the plugin's own `failureMode`.
 * A tenant-database blip must not block every agent turn while the identical
 * guardrail on the gateway fails OPEN, so every handler body here catches
 * everything and applies the record's own `failMode` itself; nothing escapes.
 */

import { createLogger } from '@/lib/core/logger';

import {
  POLICY_FAMILIES,
  DETERMINISTIC_POLICY_FAMILIES,
  GUARDRAIL_CONTRACT_VERSION,
  HOOK_IDS,
  HOOK_SUBJECT_KIND,
  joinSegments,
  textSubject,
  toolCallSubject,
  toolResultSubject,
} from './hooks/contract';
import type {
  PolicyFamily,
  GuardrailPolicy,
  GuardrailFailMode,
  HookBinding,
  HookId,
  HookScope,
  HookSubject,
  HookVerdict,
  SafetyAction,
  SubjectSegment,
} from './hooks/contract';
import { resolveGuardrail, runHook } from './hooks/engine';
import { ensureHooks } from './hooks/legacy';

// TYPE-ONLY. Erased by the compiler, so this line links nothing at runtime —
// the values (`createGuardrail`, `customCallbackRule`, the `GuardrailPhase`
// enum object, and on a plugin build `pluginCapabilities` / `CONSOLE_HOOK_MAP`)
// all arrive through `loadAgentSdk()` below.
import type {
  AIMessage,
  AgentPlugin,
  ConversationGuardrail,
  GuardrailContext,
  GuardrailDisposition,
  GuardrailPhase,
  GuardrailRule,
  HookContext,
  HookMap,
  HookRegistrations,
  Message,
  SmartState,
} from '@cognipeer/agent-sdk';

const logger = createLogger('guardrail-sdk-adapter');

// ═══════════════════════════════════════════════════════════════════════════
// SDK loading
// ═══════════════════════════════════════════════════════════════════════════

type AgentSdkModule = typeof import('@cognipeer/agent-sdk');

/**
 * The plugin layer as this file uses it, declared STRUCTURALLY.
 *
 * Structural rather than imported ON PURPOSE, even though 0.10.0 exports most
 * of these names now. This file has to compile and behave correctly against an
 * SDK it did not choose — a self-hosted install pins its own version — so every
 * member below stays optional and every read of it stays guarded. Importing the
 * types would move the failure from a runtime `undefined` this code already
 * handles to a build error on someone else's machine.
 *
 * `SdkCapabilities` is the one name to be careful with: this file exports its
 * OWN type by that name, keyed by console `HookId`, while the SDK exports a
 * different one keyed by its `HookName`. Alias on import, always.
 */
interface AgentSdkPluginSurface {
  pluginCapabilities?: () => unknown;
  CONSOLE_HOOK_MAP?: unknown;
  // `definePlugin` is deliberately NOT declared here. It exists in 0.10.0 but
  // is curried (`(factory) => (config) => plugin`) and takes a factory, not a
  // literal — declaring it with the wrong shape is what let the compiler bless
  // a call that could only ever fail. Nothing in this file may call it.

  version?: unknown;
  VERSION?: unknown;
}

type LoadedAgentSdk = AgentSdkModule & AgentSdkPluginSurface;

/**
 * The import PROMISE is memoised, not the module. Two reasons, one of them a
 * trap this repo has already paid for: concurrent `await import()` calls for the
 * same MOCKED module deadlock under vitest, so a single shared promise is the
 * only shape that is safe to await from several rules at once. A rejection is
 * deliberately NOT memoised — a transient module-load failure must not disable
 * the bridge for the life of the process.
 */
let sdkPromise: Promise<LoadedAgentSdk> | null = null;

function loadAgentSdk(): Promise<LoadedAgentSdk> {
  if (!sdkPromise) {
    sdkPromise = (import('@cognipeer/agent-sdk') as Promise<LoadedAgentSdk>).catch(
      (error: unknown) => {
        sdkPromise = null;
        throw error;
      },
    );
  }
  return sdkPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// The rule result shape (LEGACY plane)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Structurally identical to the SDK's `GuardrailRuleResult`, declared locally.
 *
 * 0.10.0 DOES export that name (it did not at 0.9.4, which is why this copy
 * exists), but the copy stays for the same reason the plugin surface above is
 * structural: this file must compile against whatever SDK an install pins.
 *
 * STANDING RULE for this file: any type it imports from the SDK must be checked
 * against the `export { ... }` line, not against a `declare type` line. A
 * `declare` is not a promise that the name is reachable — and the reverse trap
 * cost us this round: `definePlugin` IS exported, and had a shape nothing here
 * had checked.
 */
export interface SdkRuleResult {
  passed: boolean;
  reason?: string;
  details?: Record<string, unknown>;
  disposition?: GuardrailDisposition;
}

/**
 * What `customCallbackRule`'s callback returns. Note the field is `allow`, not
 * `passed` (index.mjs, `customCallbackRule`) — the two shapes are one rename
 * apart and mixing them up produces a rule that always passes, so the
 * conversion lives in one named function rather than at each return site.
 */
export interface SdkCallbackOutcome {
  allow: boolean;
  reason?: string;
  disposition?: GuardrailDisposition;
  details?: Record<string, unknown>;
}

export function toCallbackOutcome(result: SdkRuleResult): SdkCallbackOutcome {
  return {
    allow: result.passed,
    reason: result.reason,
    disposition: result.disposition,
    details: result.details,
  };
}

/**
 * `SafetyAction` -> the SDK's three-value disposition, for the LEGACY plane
 * only. Lossy BY DESIGN, and the loss is in one direction: `redact` cannot be
 * delivered there (no mutation channel) and `flag`/`warn` have no separate rung,
 * so all three land on 'warn' — an incident that is recorded and surfaced but
 * does not halt the run. Only 'block' halts, and only 'allow' is discarded.
 *
 * The plugin plane does NOT go through this function: it rewrites instead. That
 * asymmetry is the whole point of the migration and is why `toDisposition` is
 * not reused there.
 */
export function toDisposition(action: SafetyAction): GuardrailDisposition {
  if (action === 'block') return 'block';
  if (action === 'allow') return 'allow';
  return 'warn'; // flag | warn | redact
}

// ═══════════════════════════════════════════════════════════════════════════
// The two planes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Which SDK surface the console is actually compiling against.
 *
 * `'unknown'` is not a placeholder for "probably legacy": it is the state
 * before `probeSdkCapabilities()` has answered, and every capability string it
 * produces says so rather than guessing. A capability screen that guesses is
 * exactly how `tool.pre` came to be reported as impossible on a build that
 * serves it.
 */
export type SdkPlane = 'plugin' | 'legacy' | 'unknown';

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
const PHASE_HOOKS: Readonly<Record<string, HookId>> = {
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
function hookForPhase(phase: string): HookId | undefined {
  return PHASE_HOOKS[PHASE_ALIASES[phase] ?? phase];
}

/** Every hook `PHASE_HOOKS` can serve, for the legacy compile-time plan. */
const SERVABLE_HOOKS: ReadonlySet<HookId> = new Set<HookId>(Object.values(PHASE_HOOKS));

// ═══════════════════════════════════════════════════════════════════════════
// Capability strings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Not servable ANYWHERE on the agent path, and the reason is the SDK's own.
 * The first three sentences are `features.streamGate`'s note VERBATIM from
 * `pluginCapabilities()`; quoting rather than paraphrasing is deliberate, so
 * that an operator reading this screen and an engineer reading the SDK's
 * capability report are reading the same sentence.
 */
const STREAM_GATE_NOTE =
  'There is no hook on stream deltas. onStream is synchronous and void, so a chunk '
  + 'cannot be held back or blocked in real time. A postModelCall rewrite fixes the '
  + 'transcript, never what was already emitted.';

const STREAM_REASON =
  `Not servable on either SDK plane. The SDK reports it itself: "${STREAM_GATE_NOTE}" `
  + 'Streaming enforcement happens in the gateway, which owns the socket and can therefore '
  + 'withhold bytes until a window is adjudicated.';

/**
 * WHY EACH HOOK IS OR IS NOT SERVED, keyed by PLANE first.
 *
 * These strings are surfaced in the guardrail Usage tab and in
 * `metadata.capabilities` on the compiled artifact, so they are written for an
 * operator asking "why is my tool policy not firing on agent runs?" — and the
 * answer to that question is DIFFERENT on the two planes. Keying them by plane
 * is the fix for the bug this rewrite exists to close: the old table stated
 * `ConversationGuardrail`'s limits ("GuardrailPhase has no tool-level member")
 * as though they were the agent path's, so a plugin build that serves
 * `preToolUse` and `postToolUse` still reported both as impossible.
 *
 * RULE for editing: a string may only claim what the plane it is filed under
 * can actually do. Never say "not servable" where the correct sentence is "the
 * INSTALLED build is too old"; the two send an operator to different places.
 */
export const HOOK_CAPABILITY_REASON: Readonly<
  Record<SdkPlane, Readonly<Record<HookId, string>>>
> = {
  plugin: {
    'prompt.pre':
      'Served by the plugin hook userPromptSubmit, which fires once for the turn the '
      + 'person actually typed — not again after each tool result. A redact verdict '
      + 'rewrites userPromptSubmit.text (or the text parts of its content) before the '
      + 'prompt is submitted. CAVEAT: it does NOT fire on resume — a resumed run picks up '
      + 'with a tool result as the transcript tail, so a rule that must see every turn '
      + 'needs input.pre as well.',
    'input.pre':
      'Served by the plugin hook preModelCall, which fires before EVERY model call, not '
      + 'once per user turn. Each message is scanned exactly once, so a tool result '
      + 'reaching the model is evaluated on the call that appended it. A redact verdict '
      + 'rewrites preModelCall.messages PER MESSAGE (the slice is segmented by message '
      + 'index, so a redacted span lands on the message it came from and non-text parts '
      + 'are untouched). CAVEAT: the rewrite reaches the WIRE transcript the provider '
      + 'sees; the host does not write it back into the run state, so the console '
      + 'persists the rewritten user turn through onMessageRewrite. A redaction that '
      + 'cannot be placed is reported as not applied, never as a pass.',
    'output.pre':
      'Served by the plugin hook postModelCall, which fires after every model call, '
      + 'including turns that produced only tool calls. A redact verdict rewrites '
      + 'postModelCall.message, so the transcript carries the redacted text — but only the '
      + 'transcript: bytes already streamed to the caller are gone (see '
      + 'output.stream.delta).',
    'output.stream.delta': STREAM_REASON,
    'tool.pre':
      'Served by the plugin hook preToolUse. The arguments are adjudicated before the tool '
      + 'runs: a block stops the call, and a redact verdict rewrites preToolUse.args, so '
      + 'the tool executes against the redacted arguments rather than the originals. '
      + 'Plugins are forwarded to sub-agents, so a delegated tool call is covered too — '
      + 'unless this plugin is compiled with inheritToSubagents: false.',
    'tool.post':
      'Served by the plugin hook postToolUse. The result is adjudicated before the model '
      + 'sees it, and a redact verdict rewrites postToolUse.output. CAVEAT: postToolUse '
      + 'does NOT fire for a call that parks the run for approval, so a result delivered '
      + 'through an approval is not scanned by this hook — bind input.pre as well if that '
      + 'path matters.',
  },
  legacy: {
    'prompt.pre':
      'Served by the SDK hook named userPromptSubmit, which fires once for the turn the '
      + 'person actually typed. An installed build whose GuardrailPhase does not declare '
      + 'it cannot serve this hook at all; probeSdkCapabilities() reports what the '
      + 'installed build declares.',
    'input.pre':
      'Served by the pre-model-call phase (GuardrailPhase.Request in the installed SDK), '
      + 'which fires once per agent loop iteration — before EVERY model call, not once per '
      + 'user turn. Each message is scanned exactly once. Bind prompt.pre instead when the '
      + 'rule is about what the person asked.',
    'output.pre':
      'Served by GuardrailPhase.Response, which fires after every model call — including '
      + 'turns that produced only tool calls, where the assistant message has no text to '
      + 'scan. A redact verdict cannot be applied on this plane: ConversationGuardrail '
      + 'results carry no mutation channel, so it is recorded as a warning with '
      + 'redact_unsupported.',
    'output.stream.delta': STREAM_REASON,
    'tool.pre':
      'The INSTALLED @cognipeer/agent-sdk is too old to serve this hook: this build exposes '
      + 'only the ConversationGuardrail plane, whose GuardrailPhase enum has two members '
      + 'and no tool-level seam. It is NOT unservable — an SDK build carrying the plugin '
      + 'layer serves it with preToolUse, and upgrading is the fix. Until then tool calls '
      + 'are guarded where the console constructs the tool, and — because the legacy '
      + 'guardrails array is not forwarded to sub-agents — a tool call delegated to a child '
      + 'agent is NOT covered by this guardrail.',
    'tool.post':
      'The INSTALLED @cognipeer/agent-sdk is too old to serve this hook, for the same '
      + 'reason as tool.pre; the plugin layer serves it with postToolUse. On this build a '
      + 'tool RESULT is still scanned, but on the next pre-model-call evaluation and '
      + 'therefore under the input.pre hook — after the result has already entered the '
      + 'transcript, and with no way to rewrite it.',
  },
  unknown: {
    'prompt.pre':
      'Served on both SDK planes (plugin hook userPromptSubmit, or the same-named '
      + 'GuardrailPhase surface on an older build). Which one this process is using has not '
      + 'been determined yet — probeSdkCapabilities() answers for the installed build.',
    'input.pre':
      'Served on both SDK planes (plugin hook preModelCall, or GuardrailPhase.Request on an '
      + 'older build), before every model call rather than once per user turn. Which plane '
      + 'this process is using has not been determined yet.',
    'output.pre':
      'Served on both SDK planes (plugin hook postModelCall, or GuardrailPhase.Response on '
      + 'an older build), after every model call. Whether a redact verdict can be applied '
      + 'depends on the plane, which has not been determined yet.',
    'output.stream.delta': STREAM_REASON,
    'tool.pre':
      'Depends on the installed build, which has not been probed yet. An SDK carrying the '
      + 'plugin layer serves this hook with preToolUse; the older ConversationGuardrail '
      + 'plane has no tool-level seam and cannot. Reported as unserved until the probe '
      + 'answers, so nothing here promises enforcement that may not exist.',
    'tool.post':
      'Depends on the installed build, which has not been probed yet. An SDK carrying the '
      + 'plugin layer serves this hook with postToolUse; the older ConversationGuardrail '
      + 'plane cannot. Reported as unserved until the probe answers.',
  },
};

export interface SdkHookCapability {
  supported: boolean;
  /**
   * The SDK surface that serves it: a PLUGIN HOOK NAME on the plugin plane
   * (`preToolUse`), a `GuardrailPhase` value on the legacy one (`request`).
   * Kept spelled `phase` because the compiled-policy payload is already
   * published with that key; `sdkHook` is the same value under a name that is
   * not a lie on the plugin plane.
   */
  phase?: string;
  sdkHook?: string;
  /** True when a redact verdict lands as a rewrite on this hook's payload. */
  rewrites?: boolean;
  reason: string;
}

export interface SdkCapabilities {
  contractVersion: number;
  /** Which SDK surface these answers are about. */
  plane: SdkPlane;
  /** False until `probeSdkCapabilities()` has actually asked the installed SDK. */
  probed: boolean;
  /** `pluginCapabilities().hookContractVersion`, when there is a plugin layer. */
  hookContractVersion?: number;
  hooks: Record<HookId, SdkHookCapability>;
  /** Whether a verdict can rewrite content at all on this plane. */
  mutations: boolean;
  /** The console hooks whose payload a redact verdict actually rewrites. */
  mutableHooks: HookId[];
  /**
   * Mutation provenance is PLUGIN-LEVEL, not span-level: `GateResult.mutatedBy`
   * names which plugins rewrote the payload and in what order, and nothing
   * finer. An operator asking "which policy redacted this span" cannot be
   * answered from the agent path.
   */
  mutationProvenance: 'plugin' | 'none';
  /** A block can never be delivered before bytes reach the caller. */
  streamHoldBack: boolean;
  /**
   * Whether this plane's artifact reaches SUB-AGENTS. True for plugins
   * (`buildChild` forwards `pluginHost.childPlugins()`), false for the legacy
   * `guardrails` array — which is why a tool policy on the legacy plane is
   * bypassable by delegating.
   */
  subagentInheritance: boolean;
  /** Installed package version, when the module reports one. */
  sdkVersion?: string;
  /**
   * Phase values the INSTALLED SDK declares that `PHASE_HOOKS` does not map.
   * Only `probeSdkCapabilities()` can fill this in; a non-empty list means the
   * SDK grew a surface this adapter is not yet using.
   */
  unmappedPhases?: string[];
  /**
   * Plugin slots and features the installed build reports as NOT implemented,
   * dotted (`slots.summarizer`, `features.streamGate`). Diagnostic: it is how a
   * capability the console might reach for next shows up before someone builds
   * against it and finds out at runtime.
   */
  unimplemented?: string[];
}

// ── the static (unprobed) view ────────────────────────────────────────────

function hookCapabilityFor(hook: HookId, plane: SdkPlane): SdkHookCapability {
  const reason = HOOK_CAPABILITY_REASON[plane][hook];

  if (plane === 'plugin') {
    const sdkHook = CONSOLE_HOOK_MAP[hook];
    if (!sdkHook) return { supported: false, reason };
    return {
      supported: true,
      phase: sdkHook,
      sdkHook,
      rewrites: PLUGIN_REWRITE_FIELD[sdkHook] !== undefined,
      reason,
    };
  }

  // legacy AND unknown report the conservative set: only what the
  // ConversationGuardrail plane can serve without any probe. `unknown` must
  // never over-promise — a tool hook reported as supported before anyone has
  // asked the SDK is precisely the failure this table is being rewritten for.
  const phaseForHook = new Map<HookId, string>();
  for (const [phase, mapped] of Object.entries(PHASE_HOOKS)) phaseForHook.set(mapped, phase);
  const phase = phaseForHook.get(hook);
  return phase === undefined
    ? { supported: false, reason }
    : { supported: true, phase, sdkHook: phase, rewrites: false, reason };
}

function staticCapabilities(plane: SdkPlane): SdkCapabilities {
  const hooks = {} as Record<HookId, SdkHookCapability>;
  for (const hook of HOOK_IDS) hooks[hook] = hookCapabilityFor(hook, plane);

  const mutableHooks = HOOK_IDS.filter((hook) => hooks[hook].supported && hooks[hook].rewrites);

  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    plane,
    probed: false,
    hooks,
    mutations: mutableHooks.length > 0,
    mutableHooks,
    mutationProvenance: mutableHooks.length > 0 ? 'plugin' : 'none',
    streamHoldBack: false,
    subagentInheritance: plane === 'plugin',
  };
}

// ── the probe cache ───────────────────────────────────────────────────────

/**
 * The last answer `probeSdkCapabilities()` got, so the SYNCHRONOUS
 * `capabilities()` can report the truth about the installed build instead of a
 * static guess.
 *
 * WHY A CACHE AND A BACKGROUND KICK. `capabilities()` has to stay synchronous
 * and SDK-free — the compiled-policy GET (`server/api/plugins/guardrails.ts`)
 * calls it inline, and the config screen calls it on a request that will never
 * run an agent. But an unprobed answer is exactly the stale-capability text the
 * Usage tab was showing. So the first call returns the honest `plane: 'unknown',
 * probed: false` view AND schedules one probe; every later call — including the
 * next poll of that endpoint, which is served `Cache-Control: no-cache` — gets
 * the probed table. The probe is fire-and-forget and swallows its own failure,
 * because a caller that only wanted to render a badge must not be broken by a
 * module-load error.
 */
let probedCapabilities: SdkCapabilities | null = null;
let autoProbeStarted = false;

function scheduleAutoProbe(): void {
  if (autoProbeStarted) return;
  autoProbeStarted = true;
  void probeSdkCapabilities().catch(() => {
    // `probeSdkCapabilities` already logs and already degrades to the static
    // view; this catch only stops an unhandled rejection.
  });
}

/** Test seam: drops the memoised probe so a suite can exercise both planes. */
export function resetSdkCapabilityCacheForTests(): void {
  probedCapabilities = null;
  autoProbeStarted = false;
  sdkPromise = null;
}

/**
 * What the agent path can actually enforce. SYNCHRONOUS and SDK-FREE.
 *
 * Returns the PROBED table once `probeSdkCapabilities()` has answered in this
 * process, and the honest unprobed view before that. Pass `plane` explicitly to
 * ask what a given plane would do regardless of what is installed — the
 * compilers do exactly that, so the metadata on a compiled artifact describes
 * the plane it was actually compiled for.
 */
export function capabilities(plane?: SdkPlane): SdkCapabilities {
  if (plane !== undefined) return staticCapabilities(plane);
  if (probedCapabilities) return probedCapabilities;
  scheduleAutoProbe();
  return staticCapabilities('unknown');
}

// ── reading `pluginCapabilities()` ────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an OPTIONAL export off the loaded module.
 *
 * Never `sdk.pluginCapabilities` directly. A module namespace is not always a
 * plain object: an ESM namespace proxy — and the one vitest substitutes for a
 * mocked module — THROWS on a property that is not an export ("No X export is
 * defined on the mock") instead of answering `undefined`. Feature detection is
 * the one place that is guaranteed to hit, because the whole point is to ask
 * about names the installed build may not have; a throw there would turn "this
 * is 0.9.4, use the legacy bridge" into "the SDK could not be loaded at all"
 * and take every capability answer with it.
 */
function sdkMember(sdk: object, name: string): unknown {
  try {
    return (sdk as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * One entry of a plugin capability report.
 *
 * TOLERANT ON PURPOSE. The report is produced by an UNPUBLISHED build, so its
 * exact entry shape cannot be verified from this repo. Both spellings that
 * shape could plausibly take are accepted — a bare boolean, or a record with
 * `implemented` — and anything else reads as "not implemented" rather than as
 * an optimistic default. Guessing generously here would put the original bug
 * back, pointing the other way.
 */
function readImplemented(entry: unknown): { implemented: boolean; note?: string } {
  if (typeof entry === 'boolean') return { implemented: entry };
  if (!isRecord(entry)) return { implemented: false };
  // `notes`, not `note`: the SDK writes the field plural (dist/index.d.ts:3403-3407).
  // Reading the singular silently dropped EVERY capability note the SDK ships,
  // leaving the panel showing only the console's hand-written copy — which is
  // precisely the drift this adapter exists to detect.
  const note = typeof entry.notes === 'string' ? entry.notes : undefined;
  return { implemented: entry.implemented === true, note };
}

/** `{ hooks: {...}, slots: {...}, features: {...} }`, flattened to dotted keys. */
function unimplementedEntries(report: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const group of ['slots', 'features', 'hooks'] as const) {
    const table = report[group];
    if (!isRecord(table)) continue;
    for (const [name, entry] of Object.entries(table)) {
      if (!readImplemented(entry).implemented) out.push(`${group}.${name}`);
    }
  }
  return out.sort();
}

/**
 * The SDK's own `CONSOLE_HOOK_MAP` when it exports one, this file's copy
 * otherwise.
 *
 * The SDK's wins on every key it declares: it is the build that will actually
 * dispatch the handlers, so a disagreement means this file is stale, and
 * silently preferring the stale copy would register handlers under names
 * nothing calls. A disagreement is logged rather than swallowed.
 */
function readConsoleHookMap(sdk: LoadedAgentSdk): Readonly<Record<HookId, string | null>> {
  const declared = sdkMember(sdk, 'CONSOLE_HOOK_MAP');
  if (!isRecord(declared)) return CONSOLE_HOOK_MAP;

  const map: Record<HookId, string | null> = { ...CONSOLE_HOOK_MAP };
  const drift: string[] = [];
  for (const hook of HOOK_IDS) {
    if (!(hook in declared)) continue;
    const value = declared[hook];
    const resolved = typeof value === 'string' && value !== '' ? value : null;
    if (resolved !== CONSOLE_HOOK_MAP[hook]) {
      drift.push(`${hook}: console=${CONSOLE_HOOK_MAP[hook] ?? 'null'} sdk=${resolved ?? 'null'}`);
    }
    map[hook] = resolved;
  }
  if (drift.length > 0) {
    logger.warn('CONSOLE_HOOK_MAP drift: the SDK spells a hook differently than this adapter', {
      drift,
    });
  }
  return map;
}

/**
 * `capabilities()` plus what the INSTALLED SDK says about itself.
 *
 * ASKS, rather than infers. The previous version read the `GuardrailPhase` enum
 * and concluded that tool hooks were impossible — a conclusion about the wrong
 * plane, and the reason the Usage tab told operators a served hook could never
 * be served. So: if the build exports `pluginCapabilities()`, that report is the
 * authority and `supported` is derived from what IT says is implemented. Only a
 * build with no plugin layer falls back to the enum probe, and its unsupported
 * hooks then read "the installed SDK is too old" rather than "not servable".
 */
export async function probeSdkCapabilities(): Promise<SdkCapabilities> {
  try {
    const sdk = await loadAgentSdk();
    const pluginCapabilities = sdkMember(sdk, 'pluginCapabilities');
    const probed =
      typeof pluginCapabilities === 'function'
        ? probePluginPlane(sdk, pluginCapabilities as () => unknown)
        : probeLegacyPlane(sdk);
    probedCapabilities = probed;
    autoProbeStarted = true;
    return probed;
  } catch (error) {
    // The probe is diagnostic; a load failure must not propagate to a caller
    // that only wanted to render a capability badge. It is also NOT cached —
    // a transient module-load failure must not pin this process to 'unknown'.
    logger.warn('Could not load @cognipeer/agent-sdk to probe guardrail capabilities', {
      error: error instanceof Error ? error.message : String(error),
    });
    autoProbeStarted = false;
    return staticCapabilities('unknown');
  }
}

function sdkVersionOf(sdk: LoadedAgentSdk): string | undefined {
  const raw = sdkMember(sdk, 'VERSION') ?? sdkMember(sdk, 'version');
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

function probePluginPlane(sdk: LoadedAgentSdk, pluginCapabilities: () => unknown): SdkCapabilities {
  const reportRaw = pluginCapabilities();
  const report = isRecord(reportRaw) ? reportRaw : {};
  const hookTable = isRecord(report.hooks) ? report.hooks : {};
  const features = isRecord(report.features) ? report.features : {};
  const map = readConsoleHookMap(sdk);

  const hooks = {} as Record<HookId, SdkHookCapability>;
  for (const hook of HOOK_IDS) {
    const sdkHook = map[hook];
    const base = HOOK_CAPABILITY_REASON.plugin[hook];
    if (!sdkHook) {
      // The map says there is no plugin hook here. `output.stream.delta` is the
      // only such entry today, and the SDK's own streamGate note is preferred
      // over this file's copy of it whenever the build supplies one.
      const note = readImplemented(features.streamGate).note;
      hooks[hook] = {
        supported: false,
        reason: note
          ? `Not servable on either SDK plane. The SDK reports it itself: "${note}" `
            + 'Streaming enforcement happens in the gateway, which owns the socket.'
          : base,
      };
      continue;
    }

    const entry = readImplemented(hookTable[sdkHook]);
    if (!entry.implemented) {
      // The map points at a hook the installed plugin build does not implement.
      // Downgraded rather than trusted: reporting `supported` from the table
      // alone would promise enforcement this build cannot deliver.
      hooks[hook] = {
        supported: false,
        phase: sdkHook,
        sdkHook,
        reason:
          `${base} The installed build's pluginCapabilities() reports ${sdkHook} as not `
          + 'implemented, so this hook is inert on it.',
      };
      continue;
    }

    hooks[hook] = {
      supported: true,
      phase: sdkHook,
      sdkHook,
      rewrites: PLUGIN_REWRITE_FIELD[sdkHook] !== undefined,
      // `note` here is the NORMALISED field `readImplemented` produces; the
      // SDK's own raw field is `notes`, and the translation happens there.
      reason: entry.note ? `${base} SDK note: ${entry.note}` : base,
    };
  }

  const mutableHooks = HOOK_IDS.filter((hook) => hooks[hook].supported && hooks[hook].rewrites);
  const unimplemented = unimplementedEntries(report);
  const hookContractVersion =
    typeof report.hookContractVersion === 'number' ? report.hookContractVersion : undefined;

  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    plane: 'plugin',
    probed: true,
    hookContractVersion,
    hooks,
    mutations: mutableHooks.length > 0,
    mutableHooks,
    mutationProvenance: mutableHooks.length > 0 ? 'plugin' : 'none',
    // Never inferred from "there is a plugin layer": it is whatever the build
    // says about features.streamGate, and today it says false.
    streamHoldBack: readImplemented(features.streamGate).implemented,
    subagentInheritance: true,
    sdkVersion: sdkVersionOf(sdk),
    unimplemented: unimplemented.length > 0 ? unimplemented : undefined,
  };
}

/**
 * The original enum probe, unchanged in mechanism and now correctly SCOPED: it
 * answers for the ConversationGuardrail plane, and it is only reached on a build
 * that has no plugin layer to ask.
 */
function probeLegacyPlane(sdk: LoadedAgentSdk): SdkCapabilities {
  const base = staticCapabilities('legacy');
  // A build with neither plane declares nothing; every hook then downgrades
  // below, which is the honest answer rather than a crash.
  const phaseEnum = sdkMember(sdk, 'GuardrailPhase');
  const declared = isRecord(phaseEnum) ? Object.values(phaseEnum).map((phase) => String(phase)) : [];
  const unmapped = declared.filter((phase) => hookForPhase(phase) === undefined);

  // The static table says which surface WOULD serve a hook; only the loaded
  // module says whether this build has that surface. A hook whose surface is
  // absent is downgraded here, with a reason that names the missing surface —
  // which is what makes `prompt.pre` honest on SDK 0.9.x, whose GuardrailPhase
  // has no `userPromptSubmit`.
  const servedHooks = new Set(
    declared
      .map((phase) => hookForPhase(phase))
      .filter((hook): hook is HookId => hook !== undefined),
  );
  const hooks = { ...base.hooks };
  for (const hook of HOOK_IDS) {
    const entry = hooks[hook];
    if (!entry.supported || servedHooks.has(hook)) continue;
    hooks[hook] = {
      supported: false,
      reason:
        `${entry.reason} The installed @cognipeer/agent-sdk does not declare `
        + `${entry.phase ?? 'that surface'}, so this hook is inert on this build.`,
    };
  }

  return {
    ...base,
    probed: true,
    hooks,
    sdkVersion: sdkVersionOf(sdk),
    ...(unmapped.length > 0 ? { unmappedPhases: unmapped } : {}),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Verdict -> rule result (LEGACY plane)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * `verdict.decision` is ALREADY the effective decision — the engine neutralises
 * it to 'allow' whenever the guardrail is not in `enforce` mode — so this
 * function needs no `enforced` guard of its own and must not grow one.
 */
export function verdictToRuleResult(
  verdict: HookVerdict,
  observed?: { phase?: string; roles?: string[] },
): SdkRuleResult {
  // The ONE place the legacy plane's limits are attached to a verdict. `redact`
  // is the only one that is decision-dependent; the rest of what this plane
  // cannot do is per-hook and therefore already in `capabilities()`. On the
  // PLUGIN plane this limitation does not exist — the rewrite lands.
  const limitations = verdict.decision === 'redact' ? ['redact_unsupported'] : undefined;

  return {
    passed: verdict.decision !== 'block',
    // This string is what the SDK writes into the transcript as the guardrail's
    // assistant message (index.mjs:6187), i.e. it is USER-FACING. The rendered
    // block message is written for exactly that and is deliberately vague for
    // the families where a specific reason would teach evasion; a raw finding
    // message is the fallback only because a block with no explanation at all is
    // worse.
    reason: verdict.message?.body ?? verdict.findings[0]?.message,
    disposition: toDisposition(verdict.decision),
    // NEVER the raw findings. `details` lands in `state.messages[].metadata` and
    // in `state.guardrailResult`, both of which `captureSnapshot` persists — and
    // `SafetyFinding.value` holds the MATCHED STRING, which the evaluation
    // logger deliberately masks before it reaches storage. Categories and codes
    // are policy identifiers, not content, so they are safe to carry.
    details: {
      ...verdictDetails(verdict),
      // Which SDK phase fired and which message roles were in the scanned slice.
      // Without them an operator reading an incident cannot tell whether a
      // finding came from the user's question or from a tool result that arrived
      // three iterations later — and those call for different fixes.
      phase: observed?.phase,
      roles: observed?.roles,
      // What the console decided but this plane could not deliver. A verdict
      // that claims enforcement it did not perform is the one outcome the whole
      // hook plane exists to prevent, so the gap travels WITH the incident
      // rather than only into a log line.
      limitations,
    },
  };
}

/** The content-free part of a verdict, shared by both planes' incident payloads. */
function verdictDetails(verdict: HookVerdict): Record<string, unknown> {
  return {
    hook: verdict.hook,
    decision: verdict.decision,
    wouldBeDecision: verdict.wouldBeDecision,
    enforced: verdict.enforced,
    mode: verdict.mode,
    riskScore: verdict.riskScore,
    traceId: verdict.traceId,
    codes: verdict.codes,
    categories: [...new Set(verdict.findings.map((finding) => finding.category).filter(Boolean))],
    guardrailKey: verdict.guardrailKey,
    policyVersion: verdict.policyVersion,
    degraded: verdict.degraded?.map((entry) => `${entry.family}:${entry.policyId}`),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Subject construction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mirrors the SDK's own extractor (`extractLatestUserQuery`, index.mjs:3685) for
 * multi-part content, except it joins with '\n' instead of ' ' — the same
 * separator `joinSegments` uses, so the flattened text a policy sees has one
 * shape no matter which builder produced it.
 */
function messageText(message: Message | undefined): string {
  if (!message) return '';
  return contentText(message.content);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = (part as { text?: unknown } | null | undefined)?.text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * A text subject over a message's `content`, with ONE SEGMENT PER TEXT PART
 * rather than one over the flattened string.
 *
 * The segmentation exists so a redaction can be written BACK: `applyMutations`
 * rewrites each segment at its own pointer, so `/content/2/text` comes back
 * rewritten in place and the other parts (an image, a tool_use block) are
 * untouched. Flattening first and rewriting the flattened string would leave no
 * way to reassemble multi-part content, which is exactly how a redact verdict
 * degrades into "we detected it and did nothing".
 *
 * A plain string content still produces a single segment, so the common case is
 * identical to `textSubject`.
 */
function contentSubject(content: unknown, base: string): (HookSubject & { kind: 'text' }) | null {
  if (typeof content === 'string') {
    return content ? textSubject(content, base) : null;
  }
  if (!Array.isArray(content)) return null;

  const segments: SubjectSegment[] = [];
  content.forEach((part, index) => {
    const text = (part as { text?: unknown } | null | undefined)?.text;
    if (typeof text === 'string' && text !== '') {
      segments.push({ path: `${base}/${index}/text`, text });
    }
  });
  if (segments.length === 0) return null;

  return { kind: 'text', text: segments.map((segment) => segment.text).join('\n'), segments };
}

/**
 * The inverse of `contentSubject`: put the rewritten segments back where they
 * came from, by pointer, and leave every non-text part alone.
 *
 * Returns `undefined` when nothing could be placed, which the caller reports as
 * a redaction that did not land — never as a silent success.
 */
function rewriteContent(
  original: unknown,
  subject: HookSubject,
  base: string,
): string | unknown[] | undefined {
  if (typeof original === 'string') {
    // PATH-EXACT, not `subject.text`. A single-content subject has one segment
    // at `base` and the two agree; a multi-message subject (preModelCall) joins
    // several messages into `text`, and handing that whole string to one
    // message would splice the other messages into it.
    const exact = subject.segments.find((segment) => segment.path === base);
    if (exact) return exact.text;
    return subject.segments.length === 1 ? subject.text : undefined;
  }
  if (!Array.isArray(original)) return undefined;

  const byIndex = new Map<number, string>();
  for (const segment of subject.segments) {
    if (!segment.path.startsWith(`${base}/`)) continue;
    const index = Number(segment.path.slice(base.length + 1).split('/')[0]);
    if (Number.isInteger(index)) byIndex.set(index, segment.text);
  }
  if (byIndex.size === 0) return undefined;

  return original.map((part, index) => {
    const text = byIndex.get(index);
    if (text === undefined || !isRecord(part)) return part;
    return { ...part, text };
  });
}

/** How many trailing messages one evaluation will scan, whatever the state says.
 *  A summarisation or a restored snapshot can move `messages` under us; this cap
 *  bounds the damage to a large-but-finite scan instead of an unbounded one. */
const MAX_MESSAGES_PER_EVALUATION = 32;

interface ScanSlice {
  /** `${phase}:${messages.length}` — identifies ONE evaluation pass. */
  key: string;
  text: string;
  roles: string[];
  /**
   * ONE SEGMENT PER TEXT PART PER MESSAGE, addressed by
   * `/messages/<index>/content` (string content) or
   * `/messages/<index>/content/<part>/text` (multi-part). `<index>` is the
   * message's position in the payload's `messages` array — the WIRE array — so
   * a redaction can be written back to exactly the message it came from.
   * `text` is `joinSegments(segments)`, which equals the old flattened string.
   */
  segments: SubjectSegment[];
}

interface RunScanState {
  /** High-water mark: messages before this index have already been scanned. */
  scanned: number;
  /** The slice computed for the evaluation currently in flight. */
  current?: ScanSlice;
  /** Rule invocations already logged and billed, by `${hook}:${ruleKind}`. */
  billed: Set<string>;
  /** Gaps already reported for this run, so a 40-iteration agent turn does not
   *  emit the same "could not redact" line 80 times. */
  warned: Set<string>;
  /**
   * `preModelCall` rewrites this run has landed, keyed by the flattened text of
   * the ORIGINAL message, valued by the rewritten `content`.
   *
   * Needed because the host applies a `messages` mutation to the wire only and
   * rebuilds the wire from the unrewritten `state.messages` on EVERY model call
   * — while the high-water mark (correctly) scans each message once. Without
   * this, iteration 2 of a tool loop would re-send the raw user turn that
   * iteration 1 had redacted. Keyed by content rather than index because a
   * compaction can move indices under us.
   */
  rewrites: Map<string, unknown>;
}

/**
 * WHY EACH MESSAGE IS SCANNED EXACTLY ONCE, rather than re-scanning the
 * transcript on every iteration:
 *   · re-scanning re-reports the same finding on every subsequent iteration,
 *     and each repeat is a fresh evaluation-log row and a fresh usage event;
 *   · the SDK's own gate (`store.lastRequestLength !== state.messages.length`)
 *     already guarantees an evaluation only happens when the transcript GREW,
 *     so "what grew" is exactly the content that has not been adjudicated yet;
 *   · and it means multi-tool turns are covered. `context.latestMessage` is only
 *     the LAST appended message, so a parallel tool call that appended three
 *     results would have two of them scanned by nobody.
 *
 * The high-water mark is initialised to "everything but the newest message", NOT
 * to zero: at the first evaluation of a run the state already holds the system
 * prompt and the whole prior conversation, and scanning those would flag the
 * operator's own instructions and re-report findings from turns that were
 * already adjudicated.
 */
function sliceMessages(
  messages: readonly (Message | undefined)[],
  key: string,
  state: RunScanState,
): ScanSlice {
  // Both rules of one guardrail run inside the SAME evaluation pass and must
  // see the SAME slice. Without this memo the first rule would advance the
  // high-water mark and the second — the LLM/webhook half — would find nothing
  // left to scan and silently pass everything.
  if (state.current?.key === key) return state.current;

  // `scanned` beyond the end means the array was replaced under us
  // (summarisation compacts the transcript, a restored snapshot rewinds it).
  // Falling back to "the newest message" keeps the guardrail scanning something
  // real; leaving the mark alone would make the slice empty forever.
  const start =
    state.scanned > messages.length
      ? Math.max(0, messages.length - 1)
      : Math.max(state.scanned, messages.length - MAX_MESSAGES_PER_EVALUATION);

  // The system prompt is the OPERATOR's text, not the conversation's: scanning
  // it would flag the instructions themselves as an injection attempt on every
  // single run, which is the fastest way to teach a tenant to switch the
  // guardrail off.
  const scannable: Array<{ index: number; message: Message }> = [];
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === 'system') continue;
    scannable.push({ index, message });
  }

  // Segmented PER MESSAGE so a redaction maps back to the message it came from
  // (`PAYLOAD_ADAPTERS.preModelCall.rewrite`). A PII match never straddles two
  // messages, so per-message segmentation loses no detection — unlike the
  // legacy plane's `buildSubject`, which joins into ONE segment because it can
  // never act on a pointer anyway.
  const segments: SubjectSegment[] = [];
  for (const { index, message } of scannable) {
    const subject = contentSubject(message.content, `/messages/${index}/content`);
    if (!subject) continue;
    const role = String(message.role ?? 'unknown');
    for (const segment of subject.segments) segments.push({ ...segment, role });
  }

  const slice: ScanSlice = {
    key,
    text: joinSegments(segments),
    segments,
    roles: scannable.map(({ message }) => String(message.role ?? 'unknown')),
  };

  state.scanned = messages.length;
  state.current = slice;
  return slice;
}

function sliceForEvaluation(context: GuardrailContext, state: RunScanState): ScanSlice {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  return sliceMessages(messages, `${String(context.phase)}:${messages.length}`, state);
}

/**
 * ONE segment covering the joined text, rather than one segment per message.
 * Per-message pointers would be prettier in a finding, but they buy nothing the
 * LEGACY plane can spend: mutations are unsupported there, so no finding will
 * ever be acted on by path — and a multi-segment subject makes the PII family
 * drop any match that straddles a segment boundary, which on a two-message slice
 * is a real detection loss for a real reason nobody would ever guess.
 */
function buildSubject(hook: HookId, slice: ScanSlice): HookSubject | null {
  if (!slice.text) return null;
  if (HOOK_SUBJECT_KIND[hook] !== 'text') return null;
  return textSubject(slice.text);
}

// ═══════════════════════════════════════════════════════════════════════════
// Compilation — shared plan
// ═══════════════════════════════════════════════════════════════════════════

/** Everything that is not deterministic: the model judges and the webhook. Derived
 *  rather than listed, so a new family lands in exactly one of the two sets and
 *  cannot silently fall out of both. */
const CALLBACK_FAMILIES: ReadonlySet<PolicyFamily> = new Set<PolicyFamily>(
  POLICY_FAMILIES.filter((family) => !DETERMINISTIC_POLICY_FAMILIES.has(family)),
);

type RuleKind = 'local' | 'callback';
/** `'single'` is not a rule kind — it is the ABSENCE of a family filter. */
type EvaluationKind = RuleKind | 'single';

/** Which families this guardrail actually has enabled, per servable hook. */
type HookPlan = Partial<Record<HookId, Record<RuleKind, PolicyFamily[]>>>;

/**
 * How the LLM and webhook families are reached.
 *
 * `'in-process'` (default) calls `runHook` directly, which is right when the
 * agent runs where the console runs — the compiled artifact is a console module,
 * not a published client, so a self-addressed HTTP round trip would buy nothing
 * and cost a token.
 *
 * `'endpoint'` moves the EXPENSIVE half over the documented API: moderation,
 * prompt_shield, custom and webhook — the families whose verdicts come from an
 * evaluation model or a tenant endpoint — POST to
 * `/api/client/v1/guardrails/hooks/evaluate` instead. Same engine, same verdict,
 * same audit row; only the process boundary moves, which is what lets an agent
 * worker run without the outbound model and webhook credentials.
 *
 * WHAT IT IS NOT. It does not make this compiler usable from outside the
 * console: the deterministic half still calls `runHook`, and pii and
 * word_filter read their catalog and word lists from the tenant database. An
 * agent with no console process behind it evaluates nothing locally — it calls
 * the Hook endpoint for every hook, which is that endpoint's whole purpose.
 */
export type CallbackTransport =
  | { mode: 'in-process' }
  | {
      mode: 'endpoint';
      /** Console origin, e.g. `https://console.example`. No trailing slash needed. */
      baseUrl: string;
      /** An API token. The tenant and the actor come from it and from nowhere else. */
      token: string;
      /** Injectable for tests; defaults to the global `fetch`. */
      fetchImpl?: typeof fetch;
    };

export const HOOK_EVALUATE_PATH = '/api/client/v1/guardrails/hooks/evaluate';

export interface SdkGuardrailContext {
  /**
   * The console-side scope every evaluation runs under. `tenantDbName` and the
   * actor MUST come from the authenticated context — an actor id a caller can
   * choose is an actor id a caller can borrow, and `allowedRoles` is keyed on
   * it. `surface` is expected to be 'agent'.
   */
  scope: HookScope;
  /**
   * Restrict the bridge to these hooks. Defaults to every hook the chosen plane
   * can serve; anything outside it is ignored with a warning rather than
   * silently accepted, because "I bound it to the stream" must not read as "it
   * is enforced on the stream".
   */
  hooks?: HookId[];
  /**
   * 'split' (default) evaluates the deterministic families first and the
   * model/webhook families second, so a block from the cheap pass halts the
   * guardrail before the expensive one runs. 'single' evaluates every family in
   * one `runHook` call: one audit row, one usage event, and the engine's own
   * ordering — which is what a policy with `runIf: 'onFinding'` needs, since
   * under 'split' the judge's `priorFindings` list is empty.
   */
  evaluation?: 'split' | 'single';
  /**
   * TOOL NAMES THIS PLUGIN MUST NOT ADJUDICATE, because something else already
   * does.
   *
   * The plugin's `preToolUse`/`postToolUse` see EVERY tool the agent calls,
   * including MCP ones — and MCP tools are already guarded inside
   * `executeMcpToolLocal`, against the SERVER's own guardrail binding rather
   * than the agent's (`mcpService.ts`, `resolveMcpGuardrailBinding`). Letting
   * both run would evaluate each MCP call twice, write two evaluation-log rows
   * per hook, and bill the model-backed families twice — under two DIFFERENT
   * tool names, since the MCP layer renames the call to
   * `<serverKey>/<toolName>` after applying any override.
   *
   * The MCP guard is the one that stays, because it also covers the surfaces
   * that have no agent at all (public MCP, MCP Hub). Removing it to let the
   * plugin take over would leave those unguarded.
   */
  excludeToolNames?: ReadonlySet<string>;
  /**
   * 'per-evaluation' (default) logs and bills every rule invocation.
   * 'first-per-hook' logs and bills only the first invocation of each hook per
   * run — cheaper, but it also suppresses the evaluation-log rows for later
   * iterations, which are exactly the ones a tool result would have blocked on.
   */
  usage?: 'per-evaluation' | 'first-per-hook';
  /** Default true: a block stops the remaining rules of this guardrail. */
  haltOnViolation?: boolean;
  /** Where the model/webhook families are adjudicated. See `CallbackTransport`. */
  callback?: CallbackTransport;
  /**
   * PLUGIN PLANE ONLY. Default true, which is the decisive difference from the
   * legacy plane: plugins ride into sub-agents, so a tool policy cannot be
   * bypassed by delegating the call. Set false ONLY when a child agent is meant
   * to run under different policy — and know that it then runs under none of
   * this guardrail's.
   */
  inheritToSubagents?: boolean;
  /** PLUGIN PLANE ONLY. Handler order; rewrites chain in this order. */
  priority?: number;
  /**
   * PLUGIN PLANE ONLY. Called once per message a `preModelCall` redaction
   * rewrote, with the text before and after.
   *
   * Why a callback and not `result.messages`: the host applies a `preModelCall`
   * mutation to the WIRE transcript only (`wireMessages = gate.input.messages`,
   * dist/index.mjs:4070) and never writes it back into `state.messages`, so the
   * run result still carries the ORIGINAL user turn. A caller that persists the
   * conversation needs this channel to store what the model actually saw —
   * otherwise the raw text is written to the conversation and replayed as
   * history on every later turn, where no hook re-scans it.
   */
  onMessageRewrite?: (rewrite: PluginMessageRewrite) => void;
}

/** One message the `preModelCall` adapter rewrote. See `onMessageRewrite`. */
export interface PluginMessageRewrite {
  guardrailKey: string;
  hook: HookId;
  sdkHook: string;
  /** Index into the payload's `messages` — the WIRE array, not the persisted one. */
  index: number;
  role: string;
  /** Flattened text before and after, so a caller can match by content. */
  before: string;
  after: string;
}

/**
 * The per-handler timeout the compiled plugin declares to the host.
 *
 * The host's default is 10 s (agent-sdk `plugins/host.ts` `DEFAULT_TIMEOUT_MS`),
 * and a handler that outruns it is killed OUTSIDE the handler's own try/catch:
 * `failureMode` decides silently, `runHook` keeps running in the background,
 * bills the judge, and writes an evaluation-log row for a turn that already
 * proceeded. The console's LLM families default to NO timeout (`timeoutMs: 0`),
 * so under provider latency the 10 s default was the effective policy and
 * nobody had written it.
 *
 * So the plugin declares its own budget: a floor of 30 s, raised to the sum of
 * the bound callback policies' declared budgets plus a margin — and the scope
 * handed to `runHook` gets `budgetMs` slightly BELOW it, so the engine's own
 * per-policy degradation (`evaluation_error`, `failMode` applied, row written)
 * fires before the host's timer does.
 */
export const GUARDRAIL_PLUGIN_TIMEOUT_MS = 30_000;
/** Added on top of the policies' declared budgets, so the sum is not the deadline. */
const GUARDRAIL_PLUGIN_TIMEOUT_MARGIN_MS = 5_000;
/** How far below `timeoutMs` the engine budget sits, so the engine degrades first. */
const GUARDRAIL_PLUGIN_BUDGET_HEADROOM_MS = 1_000;
/** `families/webhook.ts` DEFAULT_BUDGET_MS — what a webhook policy with no `timeoutMs` spends. */
const WEBHOOK_DEFAULT_BUDGET_MS = 800;

/**
 * Per-handler timeout for a plan: the WORST hook's callback budgets summed,
 * never below the floor. Per hook rather than across hooks because one handler
 * invocation runs one hook's policies. A policy with `timeoutMs: 0` (unbounded
 * on the console side) contributes nothing — the floor then IS its bound, which
 * is the point.
 */
function pluginTimeoutMs(policies: readonly GuardrailPolicy[], hooks: readonly HookId[]): number {
  let worstHook = 0;
  for (const hook of hooks) {
    let sum = 0;
    for (const policy of policies) {
      if (!policy.enabled || !policy.hooks?.includes(hook)) continue;
      if (!CALLBACK_FAMILIES.has(policy.family)) continue;
      const declared =
        typeof policy.timeoutMs === 'number' && Number.isFinite(policy.timeoutMs) && policy.timeoutMs > 0
          ? policy.timeoutMs
          : policy.family === 'webhook'
            ? WEBHOOK_DEFAULT_BUDGET_MS
            : 0;
      sum += declared;
    }
    worstHook = Math.max(worstHook, sum);
  }
  return Math.max(GUARDRAIL_PLUGIN_TIMEOUT_MS, worstHook + GUARDRAIL_PLUGIN_TIMEOUT_MARGIN_MS);
}

/** Which families are enabled on which servable hook. A hook with no enabled
 *  policy, or whose BINDING is off, gets no entry at all — so the handler body
 *  can return without touching the database. */
function buildPlan(
  policies: readonly GuardrailPolicy[],
  hooks: readonly HookId[],
  bindings: Partial<Record<HookId, HookBinding>>,
): HookPlan {
  const plan: HookPlan = {};
  for (const hook of hooks) {
    // A hook runs IFF its binding is enabled AND an enabled policy names it —
    // the same rule the engine and the save-time validator use. Treating a
    // MISSING binding as "run" here would make this bridge enforce a hook the
    // console's own projection reports as off.
    if (bindings[hook]?.enabled !== true) continue;

    const local: PolicyFamily[] = [];
    const callback: PolicyFamily[] = [];
    for (const policy of policies) {
      if (!policy.enabled || !policy.hooks?.includes(hook)) continue;
      // A family in NEITHER set is one a newer console wrote and this build has
      // never heard of. It goes to the callback rule, which passes no `only`
      // entry for it — so the engine sees the policy, reports it as degraded and
      // `failMode` decides. Dropping it here would make an enabled policy
      // invisible, which is the failure this whole plane exists to remove.
      const known =
        DETERMINISTIC_POLICY_FAMILIES.has(policy.family) || CALLBACK_FAMILIES.has(policy.family);
      const bucket = known && DETERMINISTIC_POLICY_FAMILIES.has(policy.family) ? local : callback;
      if (!bucket.includes(policy.family)) bucket.push(policy.family);
    }
    if (local.length > 0 || callback.length > 0) plan[hook] = { local, callback };
  }
  return plan;
}

interface ResolvedGuardrail {
  name: string;
  description?: string;
  mode?: string;
  failMode?: GuardrailFailMode;
  plan: HookPlan;
  /** PLUGIN PLANE: the per-handler timeout derived from the plan's policies. */
  timeoutMs: number;
}

/**
 * Record -> plan, shared by both compilers so the two planes can never disagree
 * about which policies are enabled on which hook.
 *
 * A MISSING GUARDRAIL THROWS, matching the legacy facade (which turns an unknown
 * key into a thrown error and a 404) and matching the point of the whole design:
 * a binding that points at nothing must not compile into a guardrail that
 * quietly enforces nothing.
 */
async function resolveForCompile(
  guardrailKey: string,
  ctx: SdkGuardrailContext,
  servable: ReadonlySet<HookId>,
  plane: SdkPlane,
): Promise<ResolvedGuardrail> {
  const { scope } = ctx;
  const record = await resolveGuardrail(scope.tenantDbName, guardrailKey, scope.projectId);
  if (!record) {
    throw new Error(`Guardrail with key "${guardrailKey}" not found`);
  }

  // `ensureHooks` derives the v2 config for a legacy row. The generated PII
  // policy key is deliberately NOT resolved here: the lift emits the pii policy
  // pointing at its deterministic key whether or not provisioning has happened,
  // and `runHook` does the provisioning on the evaluate path.
  const hooks = ensureHooks(record).hooks;

  const requested = ctx.hooks ?? [...servable];
  const unservable = requested.filter((hook) => !servable.has(hook));
  if (unservable.length > 0) {
    logger.warn('Guardrail hooks requested that this SDK plane cannot serve', {
      guardrailKey,
      plane,
      hooks: unservable,
      reason: unservable.map((hook) => HOOK_CAPABILITY_REASON[plane][hook]),
    });
  }

  const served = requested.filter((hook) => servable.has(hook));
  return {
    name: record.name,
    description: record.description,
    mode: record.mode,
    failMode: record.failMode,
    plan: buildPlan(hooks.policies, served, hooks.bindings),
    timeoutMs: pluginTimeoutMs(hooks.policies, served),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The evaluation core, shared by both planes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Adjudicate one subject and hand back the verdict, whichever transport the
 * callback families use.
 *
 * `only` is omitted for the single-rule shape so the engine runs its own
 * normative order — deterministic families first, their findings feeding the
 * judge's gate and their mutations feeding the webhook's redaction.
 */
async function evaluateSubject(params: {
  guardrailKey: string;
  hook: HookId;
  kind: EvaluationKind;
  subject: HookSubject;
  families?: PolicyFamily[];
  ctx: SdkGuardrailContext;
  skipLogging: boolean;
  /**
   * PLUGIN PLANE: the per-invocation budget and the run's cancellation signal,
   * layered over `ctx.scope`. The budget keeps the engine's own degradation
   * ahead of the host's timer (`GUARDRAIL_PLUGIN_TIMEOUT_MS`); the signal is
   * `HookContext.signal`, so a cancelled run stops its judge and webhook calls
   * instead of letting them run on and bill after the caller has gone.
   */
  budgetMs?: number;
  signal?: HookScope['signal'];
}): Promise<HookVerdict> {
  const { guardrailKey, hook, kind, subject, families, skipLogging } = params;
  const ctx: SdkGuardrailContext = {
    ...params.ctx,
    scope: {
      ...params.ctx.scope,
      ...(params.budgetMs === undefined ? {} : { budgetMs: params.budgetMs }),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    },
  };
  const transport = ctx.callback ?? { mode: 'in-process' };

  // Only the CALLBACK half crosses the boundary. `single` deliberately does not:
  // its whole point is one call in which the engine's own deterministic-then-judge
  // ordering is intact, and splitting it across a process would be two calls
  // again, with the ordering lost and the audit row doubled.
  if (kind === 'callback' && transport.mode === 'endpoint') {
    return evaluateViaEndpoint({ guardrailKey, hook, subject, families, transport, ctx, skipLogging });
  }

  return runHook({
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook,
    subject,
    scope: ctx.scope,
    guardrailKeys: [guardrailKey],
    only: families,
    skipLogging,
  });
}

/**
 * The model/webhook half, over the wire.
 *
 * The response is the SAME verdict object the in-process call returns, only
 * snake_cased by `hookVerdictResponse` — including `subject`, which is the
 * REWRITTEN subject when a redaction landed. That field is why a remote agent
 * can still apply a redaction rather than degrading to a block: the rewrite is
 * computed where the policy lives and travels back with the verdict.
 */
async function evaluateViaEndpoint(params: {
  guardrailKey: string;
  hook: HookId;
  subject: HookSubject;
  families?: PolicyFamily[];
  transport: Extract<CallbackTransport, { mode: 'endpoint' }>;
  ctx: SdkGuardrailContext;
  skipLogging: boolean;
}): Promise<HookVerdict> {
  const { guardrailKey, hook, subject, families, transport, ctx, skipLogging } = params;
  const doFetch = transport.fetchImpl ?? fetch;
  const url = `${transport.baseUrl.replace(/\/+$/, '')}${HOOK_EVALUATE_PATH}`;

  const body: Record<string, unknown> = {
    hook,
    guardrail_key: guardrailKey,
    // There is deliberately NO tenant field: the tenant and the actor come from
    // the API token. A caller-supplied tenant would be a cross-tenant read
    // carrying a valid signature.
    request_id: ctx.scope.requestId ?? ctx.scope.traceId,
    ...(families && families.length > 0 ? { only: families } : {}),
    // `shadow` is the wire spelling of `skipLogging` — both suppress the
    // evaluation-log row AND the usage event. Omitting it would double-bill
    // `usage: 'first-per-hook'`, which is the setting a caller chose precisely
    // to stop that.
    ...(skipLogging ? { shadow: true } : {}),
    ...hookBodyForSubject(subject),
  };

  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${transport.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // 246 and 446 are the opt-in verdict status codes; both carry a verdict body.
  // Anything else is an auth, key or server error and must not be read as a
  // pass — the caller's catch applies the record's own failMode to it.
  if (![200, 246, 446].includes(response.status)) {
    throw new Error(`${HOOK_EVALUATE_PATH} answered HTTP ${response.status}`);
  }

  return fromHookResponse((await response.json()) as Record<string, unknown>, hook);
}

/** Subject -> the wire fields `buildHookSubject` reads for that subject kind. */
function hookBodyForSubject(subject: HookSubject): Record<string, unknown> {
  switch (subject.kind) {
    case 'text':
      return { text: subject.text };
    case 'tool_call':
      return {
        tool_name: subject.toolName,
        tool_args: subject.args,
        provider_ref: subject.providerRef,
      };
    case 'tool_result':
      return {
        tool_name: subject.toolName,
        tool_args: subject.args,
        tool_result: subject.result,
        provider_ref: subject.providerRef,
      };
    case 'stream_delta':
      return { buffer: subject.buffer, released_to: subject.releasedTo, seq: subject.seq };
  }
}

/** The snake_case response -> the verdict shape the handlers already speak. */
function fromHookResponse(payload: Record<string, unknown>, hook: HookId): HookVerdict {
  const decision = payload.decision as SafetyAction;
  const rewritten = isRecord(payload.subject) ? (payload.subject as unknown as HookSubject) : undefined;
  return {
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook,
    mode: (payload.mode as HookVerdict['mode']) ?? 'enforce',
    decision,
    wouldBeDecision: (payload.would_be_decision as SafetyAction) ?? decision,
    enforced: payload.enforced === true,
    disabled: payload.disabled === true,
    findings: Array.isArray(payload.findings) ? (payload.findings as HookVerdict['findings']) : [],
    mutations: Array.isArray(payload.mutations) ? (payload.mutations as HookVerdict['mutations']) : [],
    subject: rewritten,
    text: typeof payload.redacted_text === 'string' ? payload.redacted_text : undefined,
    riskScore: typeof payload.risk_score === 'number' ? payload.risk_score : 0,
    codes: Array.isArray(payload.codes) ? (payload.codes as string[]) : [],
    message: (payload.blocked_message as HookVerdict['message']) ?? undefined,
    guardrailKeys: Array.isArray(payload.guardrail_keys) ? (payload.guardrail_keys as string[]) : [],
    guardrailKey: typeof payload.guardrail_key === 'string' ? payload.guardrail_key : '',
    guardrailName: typeof payload.guardrail_name === 'string' ? payload.guardrail_name : '',
    policyVersion: typeof payload.policy_version === 'string' ? payload.policy_version : '',
    traceId: typeof payload.trace_id === 'string' ? payload.trace_id : '',
    latencyMs: typeof payload.latency_ms === 'number' ? payload.latency_ms : 0,
    degraded: Array.isArray(payload.degraded)
      ? (payload.degraded as HookVerdict['degraded'])
      : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PLUGIN plane — the primary compiler
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What a plugin handler hands back.
 *
 * `decision` is the gate vocabulary; `block` is the boolean spelling of the same
 * fact. BOTH are emitted deliberately: the plugin build is unpublished, so which
 * of the two its host reads cannot be verified from this repo, and a guardrail
 * that fails to block because it named the field the other way is the worst
 * possible outcome. They are written from one value, so they cannot disagree.
 *
 * The rewrite rides on the hook's own payload key (`args`, `output`, `message`,
 * `text`) — see `PLUGIN_REWRITE_FIELD` — which is what makes a redact verdict a
 * real rewrite instead of a warning. The rewrite fields come from
 * `PluginRewrite`, typed against the SDK's own hook outputs.
 */
export interface PluginHookOutcome extends PluginRewrite {
  /**
   * THE SDK'S WORD, NOT THE CONSOLE'S. `deny`, never `block`.
   *
   * The host ranks decisions with `DECISION_RANK = { allow: 0, ask: 1, deny: 2 }`
   * and escalates on `DECISION_RANK[next] > DECISION_RANK[current]`
   * (dist/index.mjs:6366-6368). `DECISION_RANK['block']` is `undefined`, and
   * `undefined > 0` is false — so a handler returning `'block'` leaves the gate
   * at `allow`, and enforcement only ever reads `gate.decision === 'deny'`
   * (dist/index.mjs:4072, :4199).
   *
   * A guardrail returning the console's own vocabulary here therefore evaluates,
   * logs its findings, bills its judge models, and blocks nothing — with no
   * error and no warning anywhere. The `block` boolean below stays for the
   * console's own readers; this field belongs to the SDK.
   */
  decision: 'allow' | 'deny';
  block: boolean;
  reason?: string;
  metadata: Record<string, unknown>;
}

/**
 * The rewrite half of an outcome, one optional field per writable payload key
 * (`PLUGIN_REWRITE_FIELD`), TYPED AGAINST THE SDK'S OWN `HookMap` outputs. This
 * is what lets `toAgentPlugin` hand a handler to the host without a cast: an
 * outcome carrying these fields is assignable to every hook output the console
 * registers for, so a payload rename in the SDK is a tsc error here rather than
 * a redaction that silently stops landing.
 */
export interface PluginRewrite {
  text?: HookMap['userPromptSubmit']['output']['text'];
  content?: HookMap['userPromptSubmit']['output']['content'];
  messages?: HookMap['preModelCall']['output']['messages'];
  message?: HookMap['postModelCall']['output']['message'];
  args?: HookMap['preToolUse']['output']['args'];
  output?: HookMap['postToolUse']['output']['output'];
}

/**
 * What a handler reads off the host's `HookContext`: the per-run `store`, the
 * run's cancellation `signal`, and the identifiers. Everything optional, because
 * the unit tests call handlers with a partial context and a host that predates
 * `HookContext` passes none — but every name is the SDK's own, so a renamed
 * field fails to compile rather than silently reading `undefined`.
 */
export type PluginHandlerContext = Partial<
  Pick<HookContext, 'runId' | 'hookName' | 'traceId' | 'store' | 'signal' | 'depth'>
>;

export type PluginHookHandler = (
  payload: unknown,
  ctx?: PluginHandlerContext,
) => Promise<PluginHookOutcome | undefined>;

export interface SdkPlugin {
  name: string;
  /** Console contract version, so a host can refuse a plugin it cannot read. */
  version: number;
  priority?: number;
  /**
   * EXPLICIT, always. The SDK defaults this to 'closed' and the console's own
   * `failMode` defaults to OPEN; inheriting the SDK default would make the same
   * guardrail block on the agent path and pass on the gateway during the exact
   * same outage. Written from the record, never omitted.
   */
  failureMode: GuardrailFailMode;
  /**
   * EXPLICIT, always — see `GUARDRAIL_PLUGIN_TIMEOUT_MS`. The host's 10 s
   * default would otherwise be the effective judge timeout on every agent.
   */
  timeoutMs: number;
  inheritToSubagents: boolean;
  /** Always false — see the literal for why. Declared so it cannot be omitted. */
  mayRequireApproval: false;
  metadata: Record<string, unknown>;
  hooks: Record<string, PluginHookHandler>;
}

/** Thrown when `compileToSdkPlugin` is called against a build with no plugin layer. */
export class SdkPluginLayerUnavailableError extends Error {
  constructor(public readonly capabilities: SdkCapabilities) {
    super(
      'The installed @cognipeer/agent-sdk exposes no plugin layer '
      + `(plane: ${capabilities.plane}${capabilities.sdkVersion ? `, version ${capabilities.sdkVersion}` : ''}). `
      + 'Use compileToSdkGuardrail, or compileConsoleGuardrail to choose automatically.',
    );
    this.name = 'SdkPluginLayerUnavailableError';
  }
}

/**
 * Compile ONE console guardrail into an agent-SDK PLUGIN. The primary path.
 *
 * WHAT IS FROZEN AT COMPILE TIME and what is not: the family/hook PLAN is read
 * once, so a policy added mid-run is not picked up until the next run. The
 * POLICY is not frozen — every handler invocation calls `runHook`, which
 * re-resolves the record through its own cache, so an action change, a mode
 * change or a disable takes effect within that cache's TTL even mid-run.
 *
 * Handlers are registered under the PLUGIN HOOK NAMES the installed build
 * declares (`CONSOLE_HOOK_MAP`, read from the SDK when it exports one), and only
 * for hooks that build reports as implemented. A hook the build does not
 * implement gets no handler at all rather than one that never fires.
 */
export async function compileToSdkPlugin(
  guardrailKey: string,
  ctx: SdkGuardrailContext,
): Promise<SdkPlugin> {
  const caps = await probeSdkCapabilities();
  if (caps.plane !== 'plugin') throw new SdkPluginLayerUnavailableError(caps);

  const sdk = await loadAgentSdk();
  const map = readConsoleHookMap(sdk);

  // Only hooks the INSTALLED build actually implements. `caps.hooks[h].supported`
  // is already the probe's answer, so a build that ships the plugin layer with
  // `preToolUse` unimplemented produces no tool handler — instead of one that is
  // registered and never called.
  const servable = new Set<HookId>(
    HOOK_IDS.filter((hook) => map[hook] !== null && caps.hooks[hook]?.supported === true),
  );

  const resolved = await resolveForCompile(guardrailKey, ctx, servable, 'plugin');
  const plan = resolved.plan;

  // The console's own default is OPEN; only an explicit 'closed' closes.
  const failureMode: GuardrailFailMode = resolved.failMode === 'closed' ? 'closed' : 'open';

  // The engine budget sits BELOW the host timeout on purpose; see
  // `GUARDRAIL_PLUGIN_TIMEOUT_MS`.
  const timeoutMs = resolved.timeoutMs;
  const budgetMs = Math.max(GUARDRAIL_PLUGIN_BUDGET_HEADROOM_MS, timeoutMs - GUARDRAIL_PLUGIN_BUDGET_HEADROOM_MS);

  const runStates = new WeakMap<object, RunScanState>();
  const warned = new Set<string>();

  const hooks: SdkPlugin['hooks'] = {};
  for (const hook of HOOK_IDS) {
    const sdkHook = map[hook];
    if (!sdkHook || !servable.has(hook) || plan[hook] === undefined) continue;
    hooks[sdkHook] = makePluginHandler({
      guardrailKey,
      hook,
      sdkHook,
      plan,
      ctx,
      name: resolved.name,
      failClosed: failureMode === 'closed',
      runStates,
      warned,
      excludeToolNames: ctx.excludeToolNames,
      budgetMs,
    });
  }

  const plugin: SdkPlugin = {
    name: `cognipeer-guardrail:${guardrailKey}`,
    version: GUARDRAIL_CONTRACT_VERSION,
    ...(ctx.priority === undefined ? {} : { priority: ctx.priority }),
    failureMode,
    timeoutMs,
    // SCHEDULING, NOT POLICY. The host defaults this to true for any plugin
    // registering `preToolUse` (dist/index.d.ts:699-707), because such a
    // handler MAY pause for a human — and a call that can pause has to run in
    // the sequential group, since the parallel fan-out has already started its
    // siblings by the time a pause is raised.
    //
    // The console never returns `ask`: its action union is
    // block|warn|flag|redact (`types.domain.ts:8`), with no HITL path behind
    // it. Leaving the default in place would therefore serialise every tool
    // batch on every guarded agent to buy an outcome this plugin cannot
    // produce — a pure latency regression, with no error and nothing in the
    // log. The SDK's own guardrail plugin declares false for this reason
    // (dist/index.mjs:11537-11545).
    mayRequireApproval: false,
    // Default TRUE. A tool policy that stops at the parent agent is a tool
    // policy an agent can walk around by delegating, and the legacy plane's
    // inability to forward is the main reason this path exists.
    inheritToSubagents: ctx.inheritToSubagents !== false,
    metadata: {
      guardrailKey,
      guardrailName: resolved.name,
      description: resolved.description,
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      hookContractVersion: caps.hookContractVersion,
      mode: resolved.mode,
      plan,
      // The plane's capability table, not the process-wide one: this artifact
      // was compiled for the plugin plane and its metadata must describe it.
      capabilities: caps,
    },
    hooks,
  };

  if (Object.keys(hooks).length === 0) {
    // A real configuration — an output-only guardrail handed to the tool
    // binding, or one whose only policies sit on the stream hook. It compiles to
    // a plugin with no handlers, which is inert and SAYS so, rather than to
    // something that looks armed.
    logger.info('Guardrail compiled to an inert SDK plugin', {
      guardrailKey,
      reason: 'no enabled policy on a hook this build serves',
    });
    plugin.metadata.inert = true;
  }

  // THE LITERAL IS THE PLUGIN. Never hand it to `definePlugin`.
  //
  // This used to call `createPlugin ?? definePlugin` on the theory that some
  // build might want to wrap the literal. 0.10.0 has no `createPlugin`, and its
  // `definePlugin` is CURRIED — `definePlugin(factory) => (config) => plugin`
  // (dist/index.mjs:11069-11077). Passing a plugin literal to it therefore
  // returns an anonymous closure whose `.name` is `""`, and `createPluginHost`
  // rejects a nameless plugin by throwing (dist/index.mjs:6421-6426). So the
  // wrapper that existed to be safe was, on the only build that has the
  // function, a guaranteed 500 on every agent construction.
  //
  // Nothing caught it: the `as` cast hid it from tsc, and the test mock never
  // defined `definePlugin`, so every test took the `: plugin` branch. That is
  // why `guardrail-sdk-adapter.test.ts` now exercises the REAL host.
  return plugin;
}

/**
 * The console plugin as the SDK's own `AgentPlugin` type, WITHOUT A CAST.
 *
 * `SdkPlugin` is the console's view (numeric contract version, a `metadata` bag,
 * hooks keyed by string). The host wants `AgentPlugin`: `version` is a string,
 * `metadata` is not a field, and `hooks` is `HookRegistrations`, whose handler
 * types are per hook. Assigning the record to that mapped type is impossible to
 * express without `as`, so each handler is placed under its own literal key —
 * which is exactly the place where tsc checks that `PluginHookOutcome` is
 * assignable to THAT hook's output. A hook name the bridge does not carry is
 * dropped loudly rather than smuggled through.
 *
 * Callers building an agent (`buildAgentGuardrailPlugins`) go through this;
 * the tests keep working against `SdkPlugin` because that is where `metadata`
 * lives.
 */
export function toAgentPlugin(plugin: SdkPlugin): AgentPlugin {
  const hooks: HookRegistrations = {};
  for (const [hookName, handler] of Object.entries(plugin.hooks)) {
    switch (hookName) {
      case 'userPromptSubmit':
        hooks.userPromptSubmit = handler;
        break;
      case 'preModelCall':
        hooks.preModelCall = handler;
        break;
      case 'postModelCall':
        hooks.postModelCall = handler;
        break;
      case 'preToolUse':
        hooks.preToolUse = handler;
        break;
      case 'postToolUse':
        hooks.postToolUse = handler;
        break;
      default:
        logger.warn('Guardrail plugin registered a hook the SDK bridge does not carry; dropped', {
          plugin: plugin.name,
          hook: hookName,
        });
    }
  }
  return {
    name: plugin.name,
    version: String(plugin.version),
    ...(plugin.priority === undefined ? {} : { priority: plugin.priority }),
    failureMode: plugin.failureMode,
    timeoutMs: plugin.timeoutMs,
    inheritToSubagents: plugin.inheritToSubagents,
    mayRequireApproval: plugin.mayRequireApproval,
    hooks,
  };
}

/**
 * A plugin that DENIES every hook it is asked about — what a fail-CLOSED
 * guardrail becomes when it cannot be compiled.
 *
 * `compileToSdkPlugin` throws when the record is missing, unreadable or the
 * probe fails, and a thrown compile used to take the whole agent's plugin list
 * down with it (`Promise.all`), so every OTHER guardrail on the agent vanished
 * too. The caller now compiles per key; for a key whose record says (or cannot
 * be read to say otherwise) `failMode: 'closed'`, this stands in: it registers
 * a handler for each hook the binding asked for and refuses the turn with the
 * compile error as the reason, so the outage is a visible block in the
 * transcript rather than a run that quietly proceeded unguarded.
 *
 * `hooks` are mapped through `CONSOLE_HOOK_MAP`, the same table the compiler
 * uses; a hook with no plugin counterpart (the stream hook) gets no handler.
 */
export function denyingSdkPlugin(opts: {
  guardrailKey: string;
  hooks: readonly HookId[];
  reason: string;
  priority?: number;
  inheritToSubagents?: boolean;
}): SdkPlugin {
  const name = `cognipeer-guardrail:${opts.guardrailKey}`;
  const hooks: SdkPlugin['hooks'] = {};
  for (const hook of opts.hooks) {
    const sdkHook = CONSOLE_HOOK_MAP[hook];
    if (!sdkHook) continue;
    hooks[sdkHook] = async () => ({
      decision: 'deny',
      block: true,
      reason: `Guardrail "${opts.guardrailKey}" could not be evaluated and is configured to fail closed.`,
      metadata: {
        guardrailKey: opts.guardrailKey,
        plane: 'plugin',
        sdkHook,
        hook,
        failMode: 'closed',
        compileError: opts.reason,
      },
    });
  }
  return {
    name,
    version: GUARDRAIL_CONTRACT_VERSION,
    ...(opts.priority === undefined ? {} : { priority: opts.priority }),
    failureMode: 'closed',
    timeoutMs: GUARDRAIL_PLUGIN_TIMEOUT_MS,
    inheritToSubagents: opts.inheritToSubagents !== false,
    mayRequireApproval: false,
    metadata: {
      guardrailKey: opts.guardrailKey,
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      inert: Object.keys(hooks).length === 0,
      compileError: opts.reason,
      denying: true,
    },
    hooks,
  };
}

/** Per-plugin-hook payload plumbing: what to scan, and where a rewrite goes. */
interface PayloadAdapter {
  subject: (payload: Record<string, unknown>, state: RunScanState) => {
    subject: HookSubject | null;
    roles?: string[];
  };
  /**
   * Build the rewritten payload field(s) from the verdict's rewritten subject,
   * under the hook's own writable key. `undefined` when the rewrite has nowhere
   * to land, which the handler reports rather than treating as a pass.
   */
  rewrite?: (
    payload: Record<string, unknown>,
    rewritten: HookSubject,
    verdict: HookVerdict,
  ) => PluginRewrite | undefined;
}

/** First present string among several plausible payload spellings. */
function pickString(payload: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickRecord(
  payload: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (isRecord(value)) return value;
  }
  return undefined;
}

function pickAny(payload: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key];
  }
  return undefined;
}

/**
 * READ-side field names are tolerant, WRITE-side names are not.
 *
 * The rewrite key is fixed by the SDK team's own list (`preToolUse.args`,
 * `postToolUse.output`, `postModelCall.message`, `userPromptSubmit.text`) — a
 * rewrite returned under a name the host does not read is a redaction that
 * silently does not happen. The names a payload is READ under are guessed
 * generously in the other direction, because failing to find the arguments only
 * costs a scan, and the alternative is a handler that silently sees nothing on a
 * build that spells the field `input` rather than `args`.
 */
const PAYLOAD_ADAPTERS: Readonly<Record<string, PayloadAdapter>> = {
  userPromptSubmit: {
    subject: (payload) => {
      const text = pickString(payload, ['text', 'prompt']);
      if (text !== undefined) return { subject: textSubject(text, '/text'), roles: ['user'] };
      return { subject: contentSubject(payload.content, '/content'), roles: ['user'] };
    },
    rewrite: (payload, rewritten) => {
      if (typeof payload.text === 'string') return { text: rewritten.text };
      const content = rewriteContent(payload.content, rewritten, '/content');
      if (content === undefined) return undefined;
      // `rewriteContent` preserves the parts array's shape (non-text parts are
      // returned untouched, text parts get a new `text`), so this is the same
      // `ContentPart[]` the host handed in.
      return { content: content as HookMap['userPromptSubmit']['output']['content'] };
    },
  },

  // PER-MESSAGE REWRITE. The slice's segments are addressed by message index
  // (`/messages/<i>/content[...]`), so each rewritten segment goes back to the
  // message it came from and every other message — and every non-text part —
  // is returned by identity. The host sends the result to the provider as the
  // wire transcript; see `PLUGIN_REWRITE_FIELD` for why that is not the same as
  // the persisted one.
  preModelCall: {
    subject: (payload, state) => {
      const messages = Array.isArray(payload.messages)
        ? (payload.messages as (Message | undefined)[])
        : [];
      const slice = sliceMessages(messages, `preModelCall:${messages.length}`, state);
      return {
        subject: slice.segments.length > 0
          ? { kind: 'text', text: slice.text, segments: slice.segments }
          : null,
        roles: slice.roles,
      };
    },
    rewrite: (payload, rewritten) => {
      if (!Array.isArray(payload.messages)) return undefined;
      const messages = payload.messages as (Message | undefined)[];
      let landed = false;
      const next = messages.map((message, index) => {
        if (!message) return message;
        const base = `/messages/${index}/content`;
        const touched = rewritten.segments.some(
          (segment) => segment.path === base || segment.path.startsWith(`${base}/`),
        );
        if (!touched) return message;
        const content = rewriteContent(message.content, rewritten, base);
        if (content === undefined) return message;
        const candidate = { ...message, content } as Message;
        // Identity for an untouched message: the host's `mutated` flag and the
        // rewrite ledger both key on "did this entry change".
        if (messageText(candidate) === messageText(message)) return message;
        landed = true;
        return candidate;
      });
      return landed ? { messages: next.filter((message): message is Message => message !== undefined) } : undefined;
    },
  },

  postModelCall: {
    subject: (payload) => {
      const message = pickRecord(payload, ['message', 'assistantMessage', 'response']);
      const content = message ? message.content : payload.content;
      return {
        subject: contentSubject(content, '/content'),
        roles: [String(message?.role ?? 'assistant')],
      };
    },
    rewrite: (payload, rewritten) => {
      const message = pickRecord(payload, ['message', 'assistantMessage', 'response']);
      if (!message) return undefined;
      const content = rewriteContent(message.content, rewritten, '/content');
      // Same record the host handed in, with only `content` replaced — which is
      // what makes it still the `AIMessage` the host expects back.
      return content === undefined ? undefined : { message: { ...message, content } as AIMessage };
    },
  },

  preToolUse: {
    subject: (payload) => {
      const args = pickRecord(payload, ['args', 'input', 'arguments', 'parameters']) ?? {};
      const subject = toolCallSubject({
        toolName: pickString(payload, ['toolName', 'tool_name', 'name', 'tool']) ?? 'unknown',
        args,
        providerRef: pickString(payload, ['providerRef', 'provider_ref', 'server']) ?? 'agent:plugin',
      });
      return { subject, roles: ['tool'] };
    },
    // `verdict.subject.args` is the CLONE `applyMutations` rewrote; returning it
    // is what makes the tool execute against the redacted arguments.
    rewrite: (_payload, rewritten) =>
      rewritten.kind === 'tool_call' ? { args: rewritten.args } : undefined,
  },

  postToolUse: {
    subject: (payload) => {
      const result = pickAny(payload, ['output', 'result', 'toolResult', 'tool_result']);
      const subject = toolResultSubject({
        toolName: pickString(payload, ['toolName', 'tool_name', 'name', 'tool']) ?? 'unknown',
        args: pickRecord(payload, ['args', 'input', 'arguments']) ?? {},
        result,
        providerRef: pickString(payload, ['providerRef', 'provider_ref', 'server']) ?? 'agent:plugin',
      });
      return { subject, roles: ['tool'] };
    },
    rewrite: (_payload, rewritten) =>
      rewritten.kind === 'tool_result' ? { output: rewritten.result } : undefined,
  },
};

/**
 * The per-run store, keyed on whichever stable object the payload offers.
 *
 * On the legacy plane this is `state.ctx`, the one object the SDK keeps across
 * iterations. The plugin payload's equivalent is guessed in the same spirit and
 * degrades safely: with no stable key, the fallback state scans only the newest
 * message on each call, which over-scans nothing and under-scans only a
 * parallel multi-tool turn.
 */
const RUN_STATE_STORE_KEY = 'cognipeerGuardrailRunState';

function pluginRunState(
  hookCtx: PluginHandlerContext | undefined,
  payload: Record<string, unknown>,
  fallback: WeakMap<object, RunScanState>,
): RunScanState {
  // THE REAL STORE, first. `HookContext.store` is per-plugin and per-run
  // scratch space that the host creates in `beginRun` and drops when the
  // invoke ends (dist/index.d.ts:298-299), which is exactly the lifetime this
  // state wants — and it is isolated per plugin, so two guardrails on the same
  // agent cannot read each other's high-water mark.
  //
  // Before this, the state was guessed out of the PAYLOAD
  // (`payload.ctx/context/state/run/session`). No hook input in 0.10.0 carries
  // any of those keys, so every call fell through to `freshRunState()` — whose
  // `MAX_SAFE_INTEGER` means "scan only the newest message". Harmless while the
  // plugin plane was unused; a cost incident the moment `input.pre` is bound,
  // because `preModelCall` fires once per MODEL CALL rather than once per turn
  // and the per-run billing set was being thrown away between them.
  if (hookCtx?.store && isRecord(hookCtx.store)) {
    const store = hookCtx.store;
    const existing = store[RUN_STATE_STORE_KEY];
    if (isRunScanState(existing)) return existing;
    const fresh = freshRunState();
    store[RUN_STATE_STORE_KEY] = fresh;
    return fresh;
  }

  // No context — a host that predates `HookContext`, or a direct unit-test
  // call. Keyed on whatever stable object the payload offers, which is what
  // this function did before and still degrades the same safe way.
  const candidates = [payload.ctx, payload.context, payload.state, payload.run, payload.session];
  const key = candidates.find((value): value is object => isRecord(value));
  if (!key) return freshRunState();
  const existing = fallback.get(key);
  if (existing) return existing;
  const fresh = freshRunState();
  fallback.set(key, fresh);
  return fresh;
}

/**
 * Checked rather than cast: `store` is a shared bag typed `unknown`, and a
 * value under our key that is not our shape means something else wrote there.
 * Trusting it would corrupt the scan window rather than fail.
 */
function isRunScanState(value: unknown): value is RunScanState {
  return (
    isRecord(value)
    && typeof value.scanned === 'number'
    && value.billed instanceof Set
    && value.warned instanceof Set
    && value.rewrites instanceof Map
  );
}

function freshRunState(): RunScanState {
  // MAX_SAFE_INTEGER, not 0: the first evaluation of a run must scan only the
  // newest message, and `sliceMessages`'s out-of-range branch is exactly that
  // rule. Starting at 0 would scan the system prompt and every prior turn.
  return { scanned: Number.MAX_SAFE_INTEGER, billed: new Set(), warned: new Set(), rewrites: new Map() };
}

/**
 * Remember what a `preModelCall` rewrite changed — in the run state, so later
 * model calls of the same run can re-apply it (`carryMessageRewrites`), and
 * through `onMessageRewrite`, so the caller can persist it.
 */
function recordMessageRewrites(input: {
  before: readonly (Message | undefined)[];
  after: readonly Message[];
  state: RunScanState;
  report: ((rewrite: PluginMessageRewrite) => void) | undefined;
  guardrailKey: string;
  hook: HookId;
  sdkHook: string;
}): void {
  input.after.forEach((rewritten, index) => {
    const original = input.before[index];
    if (!original || rewritten === original) return;
    const beforeText = messageText(original);
    const afterText = messageText(rewritten);
    if (beforeText === afterText) return;
    input.state.rewrites.set(beforeText, rewritten.content);
    input.report?.({
      guardrailKey: input.guardrailKey,
      hook: input.hook,
      sdkHook: input.sdkHook,
      index,
      role: String(original.role ?? 'unknown'),
      before: beforeText,
      after: afterText,
    });
  });
}

/**
 * Re-apply this run's earlier rewrites to a wire transcript. Returns the new
 * array only when something changed, so a clean pass stays free of a
 * GateResult entry. Never touches the system prompt.
 */
function carryMessageRewrites(
  messages: readonly (Message | undefined)[],
  state: RunScanState,
): Message[] | undefined {
  if (state.rewrites.size === 0) return undefined;
  let changed = false;
  const next: Message[] = [];
  for (const message of messages) {
    if (!message) continue;
    if (message.role === 'system') {
      next.push(message);
      continue;
    }
    const recorded = state.rewrites.get(messageText(message));
    if (recorded === undefined) {
      next.push(message);
      continue;
    }
    changed = true;
    next.push({ ...message, content: recorded } as Message);
  }
  return changed ? next : undefined;
}

function makePluginHandler(params: {
  guardrailKey: string;
  hook: HookId;
  sdkHook: string;
  plan: HookPlan;
  ctx: SdkGuardrailContext;
  name: string;
  failClosed: boolean;
  runStates: WeakMap<object, RunScanState>;
  excludeToolNames?: ReadonlySet<string>;
  warned: Set<string>;
  /** Engine budget per invocation; see `GUARDRAIL_PLUGIN_TIMEOUT_MS`. */
  budgetMs: number;
}): PluginHookHandler {
  const { guardrailKey, hook, sdkHook, plan, ctx, name, failClosed, runStates, warned, budgetMs } = params;
  const excludeToolNames = params.excludeToolNames;
  const isToolHook = hook === 'tool.pre' || hook === 'tool.post';
  const adapter = PAYLOAD_ADAPTERS[sdkHook];
  const rewriteField = PLUGIN_REWRITE_FIELD[sdkHook];

  // `(input, ctx)` is the host's handler signature (dist/index.d.ts:550). The
  // second argument was previously ignored, which is what put the run state on
  // a guess; see `pluginRunState`.
  return async (raw: unknown, hookCtx?: PluginHandlerContext): Promise<PluginHookOutcome | undefined> => {
    try {
      const payload = isRecord(raw) ? raw : {};
      const entry = plan[hook];
      if (!entry || !adapter) return undefined;

      // Skip BEFORE any work: an excluded tool must cost no evaluation, no log
      // row and no usage event, because another guard is already paying for it.
      if (isToolHook && excludeToolNames?.size) {
        const toolName = typeof payload.name === 'string'
          ? payload.name
          : typeof payload.toolName === 'string'
            ? payload.toolName
            : undefined;
        if (toolName && excludeToolNames.has(toolName)) return undefined;
      }

      const state = pluginRunState(hookCtx, payload, runStates);
      const built = adapter.subject(payload, state);
      // Nothing new to adjudicate — an assistant turn that produced only tool
      // calls, a message whose content is an image, a tool called with no string
      // arguments. Evaluating an empty subject would still cost an
      // evaluation-log row and a usage event.
      if (!built.subject) return undefined;

      // 'split' runs the deterministic families first so a block from the cheap
      // pass never pays for the model judge; 'single' runs one pass so the
      // engine's own ordering — and therefore `runIf: 'onFinding'` — survives.
      const kinds: EvaluationKind[] =
        ctx.evaluation === 'single'
          ? ['single']
          : ([
              entry.local.length > 0 ? 'local' : undefined,
              entry.callback.length > 0 ? 'callback' : undefined,
            ].filter(Boolean) as EvaluationKind[]);

      let subject = built.subject;
      let rewritten: HookSubject | undefined;
      let last: HookVerdict | undefined;

      for (const kind of kinds) {
        const families = kind === 'single' ? undefined : entry[kind];
        const billingKey = `${hook}:${kind}`;
        const skipLogging = ctx.usage === 'first-per-hook' && state.billed.has(billingKey);

        const verdict = await evaluateSubject({
          guardrailKey,
          hook,
          kind,
          subject,
          families,
          ctx,
          skipLogging,
          budgetMs,
          // The run's own cancellation: a client that hung up must not keep
          // paying for a judge that is adjudicating a turn nobody will read.
          signal: hookCtx?.signal,
        });
        // Marked only once the call actually returned: marking before it would
        // let a first invocation that threw suppress the logging of every
        // subsequent one.
        state.billed.add(billingKey);
        last = verdict;

        if (verdict.decision === 'block') {
          return {
            // `deny` is the host's word; see `PluginHookOutcome.decision`.
            decision: 'deny',
            block: true,
            // USER-FACING: the host writes it into the transcript. The rendered
            // block message is deliberately vague for the families where a
            // specific reason would teach evasion.
            reason: verdict.message?.body ?? verdict.findings[0]?.message,
            metadata: {
              ...verdictDetails(verdict),
              plane: 'plugin',
              sdkHook,
              roles: built.roles,
            },
          };
        }

        // THE REWRITE CHAIN. A landed redaction from the deterministic pass
        // becomes the subject the model/webhook pass sees, so the two compose
        // instead of the second silently re-adjudicating the unredacted text.
        if (verdict.subject) {
          rewritten = verdict.subject;
          subject = verdict.subject;
        }
      }

      const decision = last?.decision ?? 'allow';

      // THIS pass's rewrite, if the verdict carried one and the adapter could
      // place it on the payload.
      let landed: PluginRewrite | undefined;
      let placed = false;
      if (rewritten && last && adapter.rewrite && rewriteField) {
        landed = adapter.rewrite(payload, rewritten, last);
        placed = landed !== undefined;
        if (landed?.messages && Array.isArray(payload.messages)) {
          // Tell the caller which messages changed, so the persisted transcript
          // can carry what the model saw — the host only rewrites the wire.
          recordMessageRewrites({
            before: payload.messages as (Message | undefined)[],
            after: landed.messages,
            state,
            report: ctx.onMessageRewrite,
            guardrailKey,
            hook,
            sdkHook,
          });
        }
      }

      // EARLIER passes' rewrites, re-applied. The host rebuilds the wire from
      // the unrewritten state on every model call, so without this a tool loop
      // would send the raw user turn on iteration 2. Applied on top of this
      // pass's rewrite (a message rewritten now is not in the map under its
      // NEW text, so it is not touched twice), and regardless of this pass's
      // verdict — a clean tool result must not un-redact the turn before it.
      let carried = false;
      if (sdkHook === 'preModelCall' && Array.isArray(payload.messages)) {
        const wire = landed?.messages ?? (payload.messages as (Message | undefined)[]);
        const reapplied = carryMessageRewrites(wire, state);
        if (reapplied) {
          landed = { ...(landed ?? {}), messages: reapplied };
          carried = true;
        }
      }

      // Detected, decided, and NOT applied — either this hook has no writable
      // payload field or the payload shape gave the rewrite nowhere to land (a
      // message whose text lives somewhere the adapter cannot address). It must
      // never look like a clean pass, and it must not become a block either:
      // escalating a redaction into a refusal changes the operator's policy on
      // their behalf.
      const notApplied = decision === 'redact' && !placed;
      if (notApplied) {
        const gap = `${hook}:redact`;
        if (!warned.has(gap)) {
          warned.add(gap);
          logger.warn('Guardrail redaction not applied on the plugin plane', {
            guardrailKey,
            hook,
            sdkHook,
            rewritable: rewriteField !== undefined,
            traceId: last?.traceId,
          });
        }
      }

      if (landed !== undefined) {
        // The whole reason for the plugin plane: the redaction LANDS on the
        // payload the host is about to use, rather than being downgraded to a
        // warning or — worse — escalated to a block.
        return {
          decision: 'allow',
          block: false,
          ...landed,
          metadata: {
            ...(last ? verdictDetails(last) : {}),
            plane: 'plugin',
            sdkHook,
            roles: built.roles,
            rewrittenField: rewriteField,
            ...(carried ? { carriedRewrites: true } : {}),
            ...(notApplied ? { limitations: ['redact_not_applied'] } : {}),
            // Provenance is PLUGIN-level: the host's GateResult.mutatedBy names
            // this plugin, and nothing finer. The span detail lives in the
            // evaluation log, keyed by traceId.
            mutatedBy: `cognipeer-guardrail:${guardrailKey}`,
          },
        };
      }

      if (notApplied) {
        return {
          decision: 'allow',
          block: false,
          metadata: {
            ...(last ? verdictDetails(last) : {}),
            plane: 'plugin',
            sdkHook,
            roles: built.roles,
            limitations: ['redact_not_applied'],
          },
        };
      }

      // 'allow' with no findings is the overwhelmingly common case; returning
      // nothing keeps it free of an object allocation and of a GateResult entry.
      if (!last || (decision === 'allow' && last.findings.length === 0)) return undefined;

      return {
        decision: 'allow',
        block: false,
        metadata: {
          ...verdictDetails(last),
          plane: 'plugin',
          sdkHook,
          roles: built.roles,
        },
      };
    } catch (error) {
      // `runHook` documents that it never throws; this is the backstop for the
      // day something upstream of it does. Without it the plugin host's own
      // failureMode decides — which we set from the record, so the two agree —
      // but resolving it HERE also keeps the incident, and an outage that leaves
      // no trace is how a guardrail ends up dead for a year behind a green UI.
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Guardrail plugin handler failed', { guardrailKey, hook, sdkHook, error: message });
      return {
        decision: failClosed ? 'deny' : 'allow',
        block: failClosed,
        reason: failClosed ? `${name} could not be evaluated.` : undefined,
        metadata: {
          guardrailKey,
          plane: 'plugin',
          sdkHook,
          error: message,
          failMode: failClosed ? 'closed' : 'open',
        },
      };
    }
  };
}

/**
 * Several guardrail keys, one plugin each.
 *
 * One plugin per key rather than one merged plugin: `failureMode` is per-plugin
 * and per-record, and merging would force one key's fail posture onto another's.
 * Rewrites chain across them in `priority` order, so the plural case composes.
 */
export async function consoleGuardrailPlugins(opts: {
  scope: HookScope;
  guardrailKeys: string[];
  evaluation?: SdkGuardrailContext['evaluation'];
  usage?: SdkGuardrailContext['usage'];
  hooks?: HookId[];
  callback?: CallbackTransport;
  inheritToSubagents?: boolean;
  excludeToolNames?: ReadonlySet<string>;
  onMessageRewrite?: SdkGuardrailContext['onMessageRewrite'];
}): Promise<SdkPlugin[]> {
  const keys = [...new Set(opts.guardrailKeys.filter(Boolean))];
  return Promise.all(
    keys.map((key, index) =>
      compileToSdkPlugin(key, {
        scope: opts.scope,
        hooks: opts.hooks,
        evaluation: opts.evaluation,
        usage: opts.usage,
        callback: opts.callback,
        inheritToSubagents: opts.inheritToSubagents,
        excludeToolNames: opts.excludeToolNames,
        onMessageRewrite: opts.onMessageRewrite,
        // Deterministic order, so a rewrite chain over several guardrails is
        // reproducible rather than dependent on registration order.
        priority: index,
      }),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY plane — the fallback, kept
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compile ONE console guardrail into a `ConversationGuardrail`.
 *
 * STILL LOAD-BEARING: the installed build is 0.9.4 and has no plugin layer, so
 * this is the published customer integration surface. It is the FALLBACK, not
 * what the console's own agent path runs (that is the plugin plane) — it
 * cannot serve the tool hooks and cannot apply a redaction — but deleting it
 * would leave every current deployment with no agent-side enforcement at all.
 *
 * ASYNC, unavoidably. `appliesTo` is typed `GuardrailPhase[]`, and
 * `GuardrailPhase` is a string ENUM: its members are only obtainable from the
 * loaded module, and faking them with `['request'] as unknown as GuardrailPhase[]`
 * would be a cast asserting something this file has no way to check.
 */
export async function compileToSdkGuardrail(
  guardrailKey: string,
  ctx: SdkGuardrailContext,
): Promise<ConversationGuardrail> {
  const resolved = await resolveForCompile(guardrailKey, ctx, SERVABLE_HOOKS, 'legacy');
  const plan = resolved.plan;

  const sdk = await loadAgentSdk();
  const phases = (Object.values(sdk.GuardrailPhase) as GuardrailPhase[]).filter((phase) => {
    const hook = hookForPhase(String(phase));
    return hook !== undefined && plan[hook] !== undefined;
  });

  const rules = buildRules({
    guardrailKey,
    record: { name: resolved.name, failMode: resolved.failMode },
    plan,
    ctx,
    sdk,
  });

  if (phases.length === 0 || rules.length === 0) {
    // NOT `createGuardrail({ appliesTo: [] })`: that factory reads an empty
    // array as "unspecified" and substitutes BOTH phases (index.mjs,
    // `createGuardrail`), so the inert case has to be built as a literal.
    logger.info('Guardrail compiled to an inert SDK guardrail', {
      guardrailKey,
      reason: phases.length === 0 ? 'no enabled policy on a servable hook' : 'no rules',
    });
    return {
      id: guardrailKey,
      title: resolved.name,
      description: 'No policy in this guardrail can run on an agent conversation phase.',
      appliesTo: [],
      rules: [],
      metadata: { guardrailKey, inert: true, capabilities: capabilities('legacy') },
    };
  }

  return sdk.createGuardrail({
    id: guardrailKey,
    title: resolved.name,
    description: resolved.description,
    appliesTo: phases,
    // `checks` is the AGENT SDK's own field name on `CreateGuardrailOptions`,
    // not ours — it stays spelled the way `@cognipeer/agent-sdk` declares it.
    checks: rules,
    // A block from the deterministic rule stops the model-judge rule from
    // running. That is the whole economic argument for the split.
    haltOnViolation: ctx.haltOnViolation ?? true,
    metadata: {
      guardrailKey,
      contractVersion: GUARDRAIL_CONTRACT_VERSION,
      mode: resolved.mode,
      plan,
      capabilities: capabilities('legacy'),
    },
  });
}

/**
 * The contract's plural entry point: several guardrail keys, one
 * `ConversationGuardrail`. Rules from every key are concatenated in the order
 * given, so `haltOnViolation` makes the first key's block stop the rest — which
 * is the same precedence the engine's own short-circuit uses.
 */
export async function consoleConversationGuardrail(opts: {
  scope: HookScope;
  guardrailKeys: string[];
  evaluation?: SdkGuardrailContext['evaluation'];
  usage?: SdkGuardrailContext['usage'];
  hooks?: HookId[];
}): Promise<ConversationGuardrail> {
  const keys = [...new Set(opts.guardrailKeys.filter(Boolean))];
  const compiled = await Promise.all(
    keys.map((key) =>
      compileToSdkGuardrail(key, {
        scope: opts.scope,
        hooks: opts.hooks,
        evaluation: opts.evaluation,
        usage: opts.usage,
      }),
    ),
  );

  const phases = new Map<string, GuardrailPhase>();
  const rules: GuardrailRule[] = [];
  for (const guardrail of compiled) {
    for (const phase of guardrail.appliesTo) phases.set(String(phase), phase);
    rules.push(...guardrail.rules);
  }

  return {
    id: keys.join('+') || 'guardrails',
    title: compiled.map((guardrail) => guardrail.title).filter(Boolean).join(' + ') || 'Guardrails',
    appliesTo: [...phases.values()],
    rules,
    haltOnViolation: true,
    metadata: { guardrailKeys: keys, capabilities: capabilities('legacy') },
  };
}

/**
 * THE TWO RULE KINDS (legacy plane).
 *
 * 'local' carries the deterministic families — pii, secrets, word_filter, regex,
 * tool_access — adjudicated in process with no model call and no outbound hop.
 * 'callback' carries moderation, prompt_shield, custom and webhook, and is built
 * with `customCallbackRule` because those verdicts come from somewhere else.
 *
 * WHAT THE SPLIT COSTS, stated rather than hidden: two rules means two `runHook`
 * calls per evaluation, hence two evaluation-log rows and two usage events for
 * one logical evaluation; and because the second call is filtered to the
 * callback families, its `priorFindings` list is empty — so a policy set to
 * `runIf: 'onFinding'` never fires under 'split', silently.
 * `evaluation: 'single'` exists for exactly that.
 */
function buildRules(params: {
  guardrailKey: string;
  record: { name: string; failMode?: GuardrailFailMode };
  plan: HookPlan;
  ctx: SdkGuardrailContext;
  sdk: LoadedAgentSdk;
}): GuardrailRule[] {
  const { guardrailKey, record, plan, ctx, sdk } = params;

  // Per COMPILED GUARDRAIL, not module-global: two guardrails compiled for the
  // same run must not share a high-water mark, or each would scan half the
  // messages and neither would say so.
  const runStates = new WeakMap<object, RunScanState>();

  const evaluateFor = async (
    kind: EvaluationKind,
    context: GuardrailContext,
  ): Promise<SdkRuleResult> => {
    try {
      const hook = hookForPhase(String(context.phase));
      // A phase this adapter does not map cannot be adjudicated, and inventing
      // a verdict for it would be a guess about what the SDK is asking. `passed`
      // with 'allow' is the one result `evaluateGuardrails` discards entirely,
      // so it leaves no misleading incident behind.
      if (!hook) return { passed: true, disposition: 'allow' };

      const entry = plan[hook];
      const families = kind === 'single' ? undefined : entry?.[kind];
      if (!entry || (families !== undefined && families.length === 0)) {
        return { passed: true, disposition: 'allow' };
      }

      const state = runStateFor(runStates, context.state);
      const slice = sliceForEvaluation(context, state);
      const subject = buildSubject(hook, slice);
      // Nothing new to adjudicate — an assistant turn that produced only tool
      // calls, or a message whose content is an image.
      if (!subject) return { passed: true, disposition: 'allow' };

      const billingKey = `${hook}:${kind}`;
      const skipLogging = ctx.usage === 'first-per-hook' && state.billed.has(billingKey);

      const verdict = await evaluateSubject({
        guardrailKey,
        hook,
        kind,
        subject,
        families,
        ctx,
        skipLogging,
      });

      // Marked only once the call actually returned: marking before it would
      // let a first invocation that threw suppress the logging of every
      // subsequent one, so the outage AND the evaluations after it would both be
      // missing from the audit.
      state.billed.add(billingKey);

      if (verdict.decision === 'redact' && !state.warned.has(billingKey)) {
        // The console decided a rewrite and THIS PLANE cannot perform one, so
        // the content reaches the model unredacted. The plugin plane can; that
        // is the upgrade this line is arguing for.
        state.warned.add(billingKey);
        logger.warn(
          'Guardrail redaction not applied: the ConversationGuardrail plane has no mutation channel',
          { guardrailKey, hook, traceId: verdict.traceId },
        );
      }

      return verdictToRuleResult(verdict, {
        phase: String(context.phase),
        roles: slice.roles,
      });
    } catch (error) {
      // Without this the SDK's own try/catch turns any failure into an
      // unconditional BLOCK, so a tenant-database blip would fail every agent
      // turn closed while the identical guardrail on the gateway failed open.
      // The record's own `failMode` decides instead.
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Guardrail rule failed', { guardrailKey, kind, error: message });
      const failClosed = record.failMode === 'closed';
      return {
        // Fail-open still produces an INCIDENT (passed with a 'warn'
        // disposition), because `passed && allow` is the one combination
        // `evaluateGuardrails` throws away.
        passed: !failClosed,
        disposition: failClosed ? 'block' : 'warn',
        reason: failClosed ? `${record.name} could not be evaluated.` : undefined,
        details: { guardrailKey, error: message, failMode: failClosed ? 'closed' : 'open' },
      };
    }
  };

  if (ctx.evaluation === 'single') {
    return [
      {
        id: `${guardrailKey}:guardrail`,
        title: record.name,
        description: 'Cognipeer guardrail (all policy families, one evaluation).',
        evaluate: (context: GuardrailContext) => evaluateFor('single', context),
      },
    ];
  }

  const rules: GuardrailRule[] = [];
  const hasLocal = Object.values(plan).some((entry) => (entry?.local.length ?? 0) > 0);
  const hasCallback = Object.values(plan).some((entry) => (entry?.callback.length ?? 0) > 0);

  // Order is the point: the deterministic rule runs first, and `haltOnViolation`
  // means its block stops the model judge from ever being called.
  if (hasLocal) {
    rules.push({
      id: `${guardrailKey}:local`,
      title: `${record.name} (deterministic)`,
      description:
        'PII, secrets, word lists, regex and tool policy — adjudicated in process, no model call.',
      evaluate: (context: GuardrailContext) => evaluateFor('local', context),
    });
  }

  if (hasCallback) {
    rules.push(
      sdk.customCallbackRule({
        id: `${guardrailKey}:callback`,
        title: `${record.name} (model & webhook)`,
        description: 'Moderation, prompt shield, custom prompt and webhook verdicts.',
        // Unreachable: every return path from `evaluateFor` sets `disposition`
        // explicitly. It is 'block' rather than 'allow' so that if a future SDK
        // version ever reached it, the failure would be visible.
        defaultDisposition: 'block',
        callback: async (context: GuardrailContext) =>
          toCallbackOutcome(await evaluateFor('callback', context)),
      }),
    );
  }

  return rules;
}

/**
 * The per-run store, keyed on `state.ctx` — the ONE object the SDK keeps stable
 * across iterations. `state` itself is replaced on every iteration
 * (`state = { ...state, messages }`), so keying on it would reset the high-water
 * mark every time and re-scan the whole transcript.
 */
function runStateFor(store: WeakMap<object, RunScanState>, state: SmartState): RunScanState {
  const key: object = state.ctx ?? state;
  const existing = store.get(key);
  if (existing) return existing;
  const fresh = freshRunState();
  store.set(key, fresh);
  return fresh;
}

// ═══════════════════════════════════════════════════════════════════════════
// The runtime choice
// ═══════════════════════════════════════════════════════════════════════════

export type CompiledConsoleGuardrail =
  | { plane: 'plugin'; plugin: SdkPlugin; guardrail?: undefined; capabilities: SdkCapabilities }
  | {
      plane: 'legacy';
      guardrail: ConversationGuardrail;
      plugin?: undefined;
      capabilities: SdkCapabilities;
    };

/**
 * Compile against WHATEVER IS INSTALLED: the plugin layer when this build has
 * one, the `ConversationGuardrail` bridge when it does not.
 *
 * This is the entry point a caller should use. The two artifacts are handed to
 * the SDK differently — `createSmartAgent({ plugins: [...] })` versus
 * `createSmartAgent({ guardrails: [...] })` — so the discriminant is returned
 * rather than hidden: a caller that must know whether tool policy is enforced,
 * or whether it reaches sub-agents, reads `capabilities` instead of guessing
 * from the SDK version.
 */
export async function compileConsoleGuardrail(
  guardrailKey: string,
  ctx: SdkGuardrailContext,
): Promise<CompiledConsoleGuardrail> {
  const caps = await probeSdkCapabilities();
  if (caps.plane === 'plugin') {
    return { plane: 'plugin', plugin: await compileToSdkPlugin(guardrailKey, ctx), capabilities: caps };
  }
  return {
    plane: 'legacy',
    guardrail: await compileToSdkGuardrail(guardrailKey, ctx),
    capabilities: caps,
  };
}
