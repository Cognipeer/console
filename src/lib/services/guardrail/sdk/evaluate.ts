import { POLICY_FAMILIES, DETERMINISTIC_POLICY_FAMILIES, GUARDRAIL_CONTRACT_VERSION, readHooks } from '@/lib/services/guardrail/hooks/contract';
import type { PolicyFamily, GuardrailPolicy, GuardrailFailMode, HookBinding, HookId, HookScope, HookSubject, HookVerdict, SafetyAction } from '@/lib/services/guardrail/hooks/contract';
import { resolveGuardrail, runHook } from '@/lib/services/guardrail/hooks/engine';
import { HOOK_CAPABILITY_REASON } from './capabilities';
import { logger } from './logger';
import { isRecord } from './sdkLoader';
import type { CallbackTransport, SdkGuardrailContext, SdkPlane } from './types';

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
export type EvaluationKind = RuleKind | 'single';

/** Which families this guardrail actually has enabled, per servable hook. */
export type HookPlan = Partial<Record<HookId, Record<RuleKind, PolicyFamily[]>>>;

export const HOOK_EVALUATE_PATH = '/api/client/v1/guardrails/hooks/evaluate';

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
export const GUARDRAIL_PLUGIN_BUDGET_HEADROOM_MS = 1_000;

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
export async function resolveForCompile(
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

  const hooks = readHooks(record);

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
export async function evaluateSubject(params: {
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
