import type { GuardrailFailMode, HookId, HookScope } from '@/lib/services/guardrail/hooks/contract';
import type { ConversationGuardrail, GuardrailDisposition, HookContext, HookMap } from '@cognipeer/agent-sdk';

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
