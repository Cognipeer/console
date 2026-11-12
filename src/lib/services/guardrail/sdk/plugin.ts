import { GUARDRAIL_CONTRACT_VERSION, HOOK_IDS } from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailFailMode, HookId, HookScope, HookSubject, HookVerdict } from '@/lib/services/guardrail/hooks/contract';
import type { AgentPlugin, HookRegistrations, Message } from '@cognipeer/agent-sdk';
import { probeSdkCapabilities } from './capabilities';
import { GUARDRAIL_PLUGIN_BUDGET_HEADROOM_MS, GUARDRAIL_PLUGIN_TIMEOUT_MS, evaluateSubject, resolveForCompile } from './evaluate';
import type { EvaluationKind, HookPlan } from './evaluate';
import { CONSOLE_HOOK_MAP, PLUGIN_REWRITE_FIELD } from './hookMaps';
import { logger } from './logger';
import { PAYLOAD_ADAPTERS } from './payloadAdapters';
import { carryMessageRewrites, pluginRunState, recordMessageRewrites } from './runState';
import { isRecord, loadAgentSdk, readConsoleHookMap } from './sdkLoader';
import type { RunScanState } from './subject';
import type { CallbackTransport, PluginHandlerContext, PluginHookHandler, PluginHookOutcome, PluginRewrite, SdkCapabilities, SdkGuardrailContext, SdkPlugin } from './types';
import { verdictDetails } from './verdict';

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
