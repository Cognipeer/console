import { GUARDRAIL_CONTRACT_VERSION, HOOK_IDS } from '@/lib/services/guardrail/hooks/contract';
import type { HookId } from '@/lib/services/guardrail/hooks/contract';
import { CONSOLE_HOOK_MAP, PHASE_HOOKS, PLUGIN_REWRITE_FIELD, hookForPhase } from './hookMaps';
import { logger } from './logger';
import { isRecord, loadAgentSdk, readConsoleHookMap, readImplemented, resetAgentSdkCacheForTests, sdkMember, sdkVersionOf, unimplementedEntries } from './sdkLoader';
import type { LoadedAgentSdk } from './sdkLoader';
import type { SdkCapabilities, SdkHookCapability, SdkPlane } from './types';

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
  resetAgentSdkCacheForTests();
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
