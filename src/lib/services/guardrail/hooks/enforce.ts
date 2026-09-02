/**
 * THE mandatory tool boundary.
 *
 * Every tool call that goes through this function is evaluated twice — its
 * arguments at `tool.pre` and its result at `tool.post` — and there is no
 * executor path that skips it. It replaces the enforcement plane's
 * `aegis/interceptor.ts` byte-for-byte at the call site: THREE POSITIONAL
 * arguments and a THREE-ARG sandbox adapter, verified against the live caller
 * `console-ee/overlay/src/server/api/plugins/client-sandbox-toolbox.ts:72-79`,
 * which passes
 *
 *     executeEnforcedTool(
 *       { tenantId, tenantDbName, actor: { id, roles: [] }, stage: 'tool.pre',
 *         resource: { type: 'sandbox_tool', name, arguments: body },
 *         context: { sandboxAvailable: true } },
 *       async (safeBody) => handler(ctx, safeBody, request),
 *       { execute: async (_request, safeBody, executor) => executor(safeBody) },
 *     )
 *
 * and then reads `enforced.pre.traceId`, `enforced.pre.decision`,
 * `enforced.post?.decision` and `enforced.result`. The ONLY edit that file
 * needs is its import line.
 *
 * ── NO `enforced` GUARD, DELIBERATELY ──────────────────────────────────────
 * `HookVerdict.decision` is the EFFECTIVE decision, already neutralised to
 * 'allow' when the guardrail is not in `enforce` mode (engine.ts, mirroring
 * aegis/engine.ts:289). Branching on `verdict.enforced` here as well would
 * hard-403 every monitor-mode tenant — the enforcement plane this replaces had
 * no such guard precisely because it relied on the same property.
 *
 * ── WHAT IS GONE FROM THE LADDER ───────────────────────────────────────────
 * `require_approval` and `sandbox` were decisions in the plane this replaces.
 * Neither survives: there is no approval store and no approval UI, and the one
 * sandbox adapter in the tree is a pass-through. `GuardrailEnforcementError`
 * still carries both codes so the caller's `code === 'approval_required' ? 202
 * : 403` keeps compiling and keeps meaning what it meant; nothing emits
 * 'approval_required' today.
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '@/lib/core/logger';

import {
  GUARDRAIL_CONTRACT_VERSION,
  GuardrailEnforcementError,
  allowVerdict,
  toolCallSubject,
  toolResultSubject,
} from './contract';
import type { PolicyFamily, HookActor, HookScope, HookSurface, HookVerdict } from './contract';
import { DEFAULT_TOOL_GUARDRAIL_KEY, ensureDefaultToolGuardrail, runHook } from './engine';
import { resolveTenantDbName } from './recordCache';

/**
 * RE-EXPORTED, never redeclared. Two `class` declarations compile perfectly
 * well and produce two distinct constructors, so a second copy here would make
 * `error instanceof AegisEnforcementError` at the sandbox toolbox false for
 * every error this module actually throws — a silent downgrade from 403 to the
 * generic 400 branch.
 */
export { GuardrailEnforcementError, AegisEnforcementError } from './contract';

const logger = createLogger('guardrail-enforce');

/**
 * The evaluation request, shaped exactly like the enforcement plane's
 * `AegisEvaluationRequest` in the fields the live caller sets.
 *
 * `tenantDbName` is optional because the plane it replaces made it optional
 * ("falls back to in-memory when absent"); here an absent value is resolved
 * from `tenantId` through the tenant cache, and only a tenant that cannot be
 * resolved at all degrades to unenforced.
 */
export interface EnforcedToolRequest {
  tenantId: string;
  /** Absent is tolerated and resolved from `tenantId`; see `resolveScope`. */
  tenantDbName?: string;
  /**
   * Which guardrails evaluate this call. Absent means the tenant's default tool
   * guardrail, which is what keeps the sandbox toolbox armed after the
   * enforcement plane's lazily-created `default` shield disappears — its call
   * site names no policy at all.
   */
  guardrailKeys?: string[];
  /**
   * MUST come from the authenticated context. The caller derives it from
   * `ctx.by`, never from a request header: an actor id a caller can choose is
   * an actor id a caller can borrow, and `allowedRoles` is keyed on it.
   */
  actor: { id: string; roles: string[]; kind?: HookActor['kind'] };
  /** Only `tool.pre` starts an enforced call; `tool.post` is this function's. */
  stage: 'tool.pre';
  resource: {
    type: string;
    /**
     * The CANONICAL policy name, derived from the route pattern with params
     * stripped (`sandbox.fs.read`, not `/api/.../sandboxes/abc/fs/read`). A
     * concrete URL leaks `:sid` values into policy and makes every
     * `sideEffects` entry like `sandbox.sessions.exec` silently miss.
     */
    name: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
  };
  context?: {
    projectId?: string;
    sandboxAvailable?: boolean;
    /** Correlates both hook rows with the HTTP request that produced them. */
    requestId?: string;
    /** Supply one to correlate with an outer trace; otherwise generated. */
    traceId?: string;
    /** `sandbox:<instanceId>` | `mcp:<serverKey>` | `agent:<agentKey>`. */
    providerRef?: string;
    /** Convenience: `sandbox:<instanceId>` is built from it when set. */
    instanceId?: string;
    /** Wall-clock budget for the SYNC policies of each hook. */
    budgetMs?: number;
    /** Persisted as `source` on the evaluation log. */
    source?: string;
    surface?: HookSurface;
    /** Run only these families — the latency escape hatch. */
    only?: PolicyFamily[];
    /** Structural on purpose: requiring `AbortSignal` would force `lib.dom`. */
    signal?: { readonly aborted: boolean };
    [key: string]: unknown;
  };
}

/**
 * Preserved from the enforcement plane, generic parameter and all, so the
 * caller's `{ execute: async (_request, safeBody, executor) => executor(safeBody) }`
 * object literal keeps contextually type-checking. Declared as a METHOD rather
 * than a property so parameter comparison stays bivariant, exactly as it was.
 */
export interface SandboxAdapter {
  execute<R>(
    request: EnforcedToolRequest,
    args: Record<string, unknown>,
    run: (sanitized: Record<string, unknown>) => Promise<R>,
  ): Promise<R>;
}

export interface EnforcedToolOutcome<T> {
  result: T;
  pre: HookVerdict;
  post: HookVerdict;
}

/**
 * Resolve the tenant database and the guardrail keys ONCE, before either hook.
 *
 * Returns `null` when the tenant cannot be resolved at all. That path runs the
 * tool UNENFORCED, loudly: the alternative is that a hiccup in the global
 * tenant registry takes down every sandbox operation for every tenant, and the
 * registry read is not the thing the guardrail is protecting. The live caller
 * always passes `tenantDbName` explicitly, so this is a test/edge path.
 */
async function resolveTarget(
  request: EnforcedToolRequest,
): Promise<{ tenantDbName: string; guardrailKeys: string[] } | null> {
  const tenantDbName = request.tenantDbName ?? (await resolveTenantDbName(request.tenantId));
  if (!tenantDbName) {
    logger.error('Tool guardrail could not resolve a tenant database; running unenforced', {
      tenantId: request.tenantId,
      tool: request.resource.name,
    });
    return null;
  }

  const named = (request.guardrailKeys ?? []).filter((key) => Boolean(key));
  if (named.length > 0) return { tenantDbName, guardrailKeys: named };

  try {
    const fallback = await ensureDefaultToolGuardrail(tenantDbName, request.tenantId);
    return { tenantDbName, guardrailKeys: [fallback.key] };
  } catch (error) {
    // The key is a pinned literal, so naming it anyway is strictly better than
    // giving up: if the row already exists and only the materialisation write
    // failed, the call is still enforced. If it genuinely does not exist,
    // `runHook` returns a vacuous allow verdict rather than throwing, and the
    // error above is the only record that the default could not be created.
    logger.error('Default tool guardrail could not be materialised', {
      tenantId: request.tenantId,
      error,
    });
    return { tenantDbName, guardrailKeys: [DEFAULT_TOOL_GUARDRAIL_KEY] };
  }
}

/** One scope for BOTH hooks, so `tool.pre` and `tool.post` share a trace id and
 *  the two evaluation-log rows of one call can be read as one call. */
function buildScope(
  request: EnforcedToolRequest,
  tenantDbName: string,
): HookScope {
  const context = request.context;
  return {
    tenantId: request.tenantId,
    tenantDbName,
    projectId: context?.projectId,
    actor: {
      id: request.actor.id,
      // The sandbox toolbox is mounted twice — under an API token and under a
      // dashboard cookie — and the request shape cannot tell them apart, so the
      // narrower of the two is the honest default. `kind` is descriptive only;
      // `allowedRoles` is keyed on `id` and `roles`.
      kind: request.actor.kind ?? 'api_token',
      roles: request.actor.roles,
    },
    surface: context?.surface ?? 'sandbox',
    source: context?.source ?? 'sandbox-toolbox',
    requestId: context?.requestId,
    traceId: typeof context?.traceId === 'string' && context.traceId ? context.traceId : randomUUID(),
    budgetMs: context?.budgetMs,
    signal: context?.signal,
  };
}

/** `sandbox:<instanceId>` when the caller knows the instance, otherwise the
 *  resource type — the contract wants a stable provider reference, and a
 *  fabricated one would be worse than a coarse one. */
function providerRefOf(request: EnforcedToolRequest): string {
  const context = request.context;
  if (typeof context?.providerRef === 'string' && context.providerRef) return context.providerRef;
  if (typeof context?.instanceId === 'string' && context.instanceId) {
    return `sandbox:${context.instanceId}`;
  }
  return request.resource.type;
}

/**
 * Evaluate a tool call, run it, evaluate its result.
 *
 * Throws `GuardrailEnforcementError('blocked', verdict)` from either side. The
 * caller maps that to 403 (or 202 for the vestigial 'approval_required') and
 * renders `error.evaluation`, which is the deprecated alias for
 * `error.verdict`.
 */
export async function executeEnforcedTool<T>(
  request: EnforcedToolRequest,
  execute: (args: Record<string, unknown>) => Promise<T>,
  sandbox?: SandboxAdapter,
): Promise<EnforcedToolOutcome<T>> {
  // Same literal as before: the caller turns a thrown non-enforcement error
  // into a 400 with this message, and a runbook greps for it.
  if (request.stage !== 'tool.pre') throw new Error('tool-pre-stage-required');

  const target = await resolveTarget(request);
  const toolName = request.resource.name;
  const providerRef = providerRefOf(request);
  const initialArgs = request.resource.arguments ?? {};

  // ── Unenforced degradation ────────────────────────────────────────────────
  // No tenant database means no policy to read. Running the tool with two
  // vacuous verdicts keeps the caller's contract intact (`pre.decision` and
  // `pre.traceId` still resolve, and `disabled: true` says why) instead of
  // failing a request over a registry read.
  if (!target) {
    const traceId = randomUUID();
    const result = sandbox
      ? await sandbox.execute(request, initialArgs, execute)
      : await execute(initialArgs);
    return {
      result,
      pre: allowVerdict({ hook: 'tool.pre', traceId }),
      post: allowVerdict({ hook: 'tool.post', traceId }),
    };
  }

  const { tenantDbName, guardrailKeys } = target;
  const scope = buildScope(request, tenantDbName);
  const only = request.context?.only;
  const shared = { contractVersion: GUARDRAIL_CONTRACT_VERSION, scope, guardrailKeys, only } as const;

  // ── tool.pre ──────────────────────────────────────────────────────────────
  const pre = await runHook({
    ...shared,
    hook: 'tool.pre',
    subject: toolCallSubject({
      toolName,
      args: initialArgs,
      providerRef,
      sandboxAvailable: request.context?.sandboxAvailable,
    }),
  });

  if (pre.decision === 'block') throw new GuardrailEnforcementError('blocked', pre);

  // The redacted arguments when the verdict rewrote them, the originals
  // otherwise. `applyMutations` rebuilds `args` as a fresh object graph, so the
  // caller's own body object is never mutated underneath it.
  const args = pre.subject?.kind === 'tool_call' ? pre.subject.args : initialArgs;

  // The adapter is invoked WHENEVER one is supplied, rather than only on a
  // 'sandbox' decision as the plane this replaces did — that rung no longer
  // exists on the action ladder, so there is no decision left to route on. The
  // one adapter in the tree is a pass-through, so this is a no-op today; the
  // alternative is accepting an isolation seam and then silently ignoring it.
  const result = sandbox ? await sandbox.execute(request, args, execute) : await execute(args);

  // ── tool.post ─────────────────────────────────────────────────────────────
  const post = await runHook({
    ...shared,
    hook: 'tool.post',
    subject: toolResultSubject({ toolName, args, result, providerRef }),
  });

  if (post.decision === 'block') throw new GuardrailEnforcementError('blocked', post);

  // A redaction rewrites strings INSIDE the result graph; its shape is
  // untouched (`applyMutations` clones containers and replaces string leaves),
  // so the cast restores the type the executor promised rather than widening
  // anything the caller can observe.
  const redacted = post.subject?.kind === 'tool_result' ? (post.subject.result as T) : result;

  return { result: redacted, pre, post };
}
