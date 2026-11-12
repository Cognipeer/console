import { GUARDRAIL_CONTRACT_VERSION } from '@/lib/services/guardrail/hooks/contract';
import type { GuardrailFailMode, HookId, HookScope } from '@/lib/services/guardrail/hooks/contract';
import type { ConversationGuardrail, GuardrailContext, GuardrailPhase, GuardrailRule } from '@cognipeer/agent-sdk';
import { capabilities, probeSdkCapabilities } from './capabilities';
import { evaluateSubject, resolveForCompile } from './evaluate';
import type { EvaluationKind, HookPlan } from './evaluate';
import { SERVABLE_HOOKS, hookForPhase } from './hookMaps';
import { logger } from './logger';
import { compileToSdkPlugin } from './plugin';
import { runStateFor } from './runState';
import { loadAgentSdk } from './sdkLoader';
import type { LoadedAgentSdk } from './sdkLoader';
import { buildSubject, sliceForEvaluation } from './subject';
import type { RunScanState } from './subject';
import type { CompiledConsoleGuardrail, SdkGuardrailContext, SdkRuleResult } from './types';
import { toCallbackOutcome, verdictToRuleResult } from './verdict';

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
