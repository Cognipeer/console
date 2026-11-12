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
 *
 * ── LAYOUT ────────────────────────────────────────────────────────────────
 * This file is the public facade. The implementation lives in `./sdk/`:
 * `types` (shared shapes), `sdkLoader` (the lazy SDK import and its feature
 * probes), `hookMaps`, `capabilities` (capability tables + probe cache),
 * `verdict`, `subject` (message slicing), `runState`, `evaluate` (plan and
 * endpoint evaluation), `payloadAdapters`, `plugin` (plugin plane) and
 * `legacy` (ConversationGuardrail plane + the runtime choice). Modules under
 * `./sdk/` never import this file.
 */

export type {
  SdkRuleResult,
  SdkCallbackOutcome,
  SdkPlane,
  SdkHookCapability,
  SdkCapabilities,
  CallbackTransport,
  SdkGuardrailContext,
  PluginMessageRewrite,
  PluginHookOutcome,
  PluginRewrite,
  PluginHandlerContext,
  PluginHookHandler,
  SdkPlugin,
  CompiledConsoleGuardrail,
} from './sdk/types';

export {
  toCallbackOutcome,
  toDisposition,
  verdictToRuleResult,
} from './sdk/verdict';

export {
  CONSOLE_HOOK_MAP,
  PLUGIN_REWRITE_FIELD,
} from './sdk/hookMaps';

export {
  HOOK_CAPABILITY_REASON,
  resetSdkCapabilityCacheForTests,
  capabilities,
  probeSdkCapabilities,
} from './sdk/capabilities';

export {
  HOOK_EVALUATE_PATH,
  GUARDRAIL_PLUGIN_TIMEOUT_MS,
} from './sdk/evaluate';

export {
  SdkPluginLayerUnavailableError,
  compileToSdkPlugin,
  toAgentPlugin,
  denyingSdkPlugin,
  consoleGuardrailPlugins,
} from './sdk/plugin';

export {
  compileToSdkGuardrail,
  consoleConversationGuardrail,
  compileConsoleGuardrail,
} from './sdk/legacy';
