/**
 * MCP gateway bridge — the community implementation of the `McpGuardrailHook`
 * seam declared at `src/enterprise/registry.ts:196-207`.
 *
 * Every MCP tool call on a server whose binding is not 'off' is evaluated by
 * the guardrail hook plane: arguments at `tool.pre`, the result at `tool.post`.
 * It replaces `aegis/mcpGuardrailHook.ts` with the SAME seam — the interface,
 * the context shape and the `{ current }` ref are untouched, so
 * `mcpService.ts:1710-1727` and `:1780-1786` keep working and the enterprise
 * overlay's registry only has to stop assigning its own implementation.
 *
 * ── `ctx.shieldId` IS DEAD AND IS IGNORED ──────────────────────────────────
 * Every persisted value in that field is an id from the `aegis_shields` table,
 * which no longer exists. Passing one to the engine as a guardrail key would
 * resolve nothing; passing it to the LEGACY facade would throw
 * `Guardrail with key "..." not found`, and that throw propagates out of
 * `beforeToolCall` into `executeMcpTool` — breaking EVERY tool call on every
 * server whose binding is not 'off'. The binding is resolved from the SERVER
 * record instead (`server.guardrail?.guardrailKey`), falling back to the
 * tenant's default tool guardrail.
 *
 * ── NOTHING HERE THROWS ────────────────────────────────────────────────────
 * A missing guardrail is not an error: `runHook` returns a vacuous allow
 * verdict for an unresolvable key, so a stale binding degrades to "not
 * evaluated" rather than to a broken server. Only a genuine engine failure
 * reaches the catch, and there the fail posture of the plane this replaces is
 * preserved exactly: closed in 'enforce', open otherwise.
 */

import { randomUUID } from 'node:crypto';

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import { mcpGuardrailHook } from '@/enterprise/registry';
import type { McpGuardrailContext, McpGuardrailHook } from '@/enterprise/registry';

import { GUARDRAIL_CONTRACT_VERSION, toolCallSubject, toolResultSubject } from './contract';
import type { HookScope, HookSubject, HookVerdict } from './contract';
import { DEFAULT_TOOL_GUARDRAIL_KEY, ensureDefaultToolGuardrail, runHook } from './engine';
import { resolveTenantDbName } from './recordCache';

const logger = createLogger('guardrail-mcp-hook');

// ═══════════════════════════════════════════════════════════════════════════
// Server binding cache
// ═══════════════════════════════════════════════════════════════════════════

/** Same window as every other guardrail read cache: one staleness story. */
const BINDING_TTL_MS = 60_000;
/** A miss usually means "no binding configured yet"; remembering that for a
 *  minute would make a freshly bound server look unguarded for a minute. */
const BINDING_MISS_TTL_MS = 5_000;
/** A TTL alone never shrinks a Map — an expired entry is only replaced when its
 *  key is read again — so a map keyed by tenant x server grows with the fleet. */
const MAX_BINDING_ENTRIES = 500;

/** Written as an ESCAPE, never as a literal NUL: a raw NUL byte makes the file
 *  read as binary to `grep`, `file` and every diff viewer. */
const SEP = '\u0000';

interface BindingEntry {
  /** `undefined` = the server names no guardrail; fall back to the default. */
  guardrailKey: string | undefined;
  expiresAt: number;
}

const bindingCache = new Map<string, BindingEntry>();

/**
 * Loads in progress, keyed like `bindingCache`; the token is the load's WRITE
 * PERMIT. `invalidateMcpGuardrailBinding` drops matching tokens, and a load
 * whose token is gone (or replaced) by the time its read resolves returns the
 * answer to its own caller but does NOT cache it — otherwise a rebind racing a
 * cold read would be undone for a minute by the pre-save read it raced.
 */
const inflightBinding = new Map<string, symbol>();

function bindingCacheKey(tenantDbName: string, serverKey: string, projectId?: string): string {
  return `${tenantDbName}${SEP}${serverKey}${SEP}${projectId ?? ''}`;
}

/**
 * Which guardrail evaluates this server's tool calls.
 *
 * `McpGuardrailContext` is FROZEN and carries no guardrail key — it carries the
 * dead `shieldId` instead — so the binding has to be read back off the server
 * record. That is one extra read per server per minute, which is why it is
 * cached; the alternative is a `guardrailKey` field nothing can set and a
 * per-server binding that silently never applies.
 *
 * Project-scoped first and then tenant-wide, mirroring `resolveGuardrail`:
 * `findMcpServerByKey` adds `projectId = @projectId`, a predicate that EXCLUDES
 * NULL, so a tenant-level server would otherwise be invisible to a
 * project-scoped call.
 */
async function resolveServerGuardrailKey(
  tenantDbName: string,
  ctx: McpGuardrailContext,
): Promise<string | undefined> {
  const cacheKey = bindingCacheKey(tenantDbName, ctx.serverKey, ctx.projectId);
  const cached = bindingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.guardrailKey;

  const token = Symbol('mcp-binding-load');
  inflightBinding.set(cacheKey, token);

  let server;
  try {
    server = await runWithTenantScope(tenantDbName, async (db) => {
      const scoped = await db.findMcpServerByKey(ctx.serverKey, ctx.projectId);
      if (scoped || ctx.projectId === undefined) return scoped;
      // TENANT-WIDE ONLY (`null` = `projectId IS NULL`). Server keys are unique
      // per project, not per tenant, so an unscoped lookup could answer with
      // ANOTHER project's row and evaluate this project's calls against that
      // project's binding. The `null` spelling asks for the row no project owns.
      return db.findMcpServerByKey(ctx.serverKey, null);
    });
  } catch (error) {
    if (inflightBinding.get(cacheKey) === token) inflightBinding.delete(cacheKey);
    throw error;
  }

  const bound = server?.guardrail?.guardrailKey;
  const guardrailKey = typeof bound === 'string' && bound ? bound : undefined;

  // Invalidated or superseded while the read was in flight: this answer may
  // predate a save, so it is returned but never cached.
  if (inflightBinding.get(cacheKey) !== token) return guardrailKey;
  inflightBinding.delete(cacheKey);

  if (bindingCache.size >= MAX_BINDING_ENTRIES) {
    // Insertion-order (FIFO) eviction. The working set of a busy process is a
    // handful of servers per tenant, and the penalty for evicting a hot key is
    // one read.
    const oldest = bindingCache.keys().next();
    if (!oldest.done) bindingCache.delete(oldest.value);
  }
  bindingCache.set(cacheKey, {
    guardrailKey,
    expiresAt: Date.now() + (server ? BINDING_TTL_MS : BINDING_MISS_TTL_MS),
  });
  return guardrailKey;
}

/**
 * Call from every path that writes an MCP server record. Omitting `serverKey`
 * clears the tenant; omitting both clears everything (tests, provider swap).
 * Without it, rebinding a server keeps evaluating against the old guardrail for
 * up to a minute.
 */
export function invalidateMcpGuardrailBinding(tenantDbName?: string, serverKey?: string): void {
  if (!tenantDbName) {
    bindingCache.clear();
    inflightBinding.clear();
    return;
  }
  const prefix = serverKey
    ? `${tenantDbName}${SEP}${serverKey}${SEP}`
    : `${tenantDbName}${SEP}`;
  // Revoking the permit is what stops a load started before this save from
  // writing its stale answer back; the load itself still completes.
  for (const key of inflightBinding.keys()) {
    if (key.startsWith(prefix)) inflightBinding.delete(key);
  }
  for (const key of bindingCache.keys()) {
    if (key.startsWith(prefix)) bindingCache.delete(key);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Evaluation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One trace id per TOOL CALL rather than per hook.
 *
 * `mcpService` builds its guardrail context ONCE and hands the same object to
 * `beforeToolCall` and `afterToolCall`, so keying on its identity correlates
 * the two evaluation-log rows of a single call without touching the frozen
 * seam. A caller that builds two objects simply gets two trace ids — the
 * degradation is invisible and harmless.
 */
const traceIds = new WeakMap<McpGuardrailContext, string>();

function traceIdFor(ctx: McpGuardrailContext): string {
  const existing = traceIds.get(ctx);
  if (existing) return existing;
  const traceId = randomUUID();
  traceIds.set(ctx, traceId);
  return traceId;
}

function buildScope(ctx: McpGuardrailContext, tenantDbName: string): HookScope {
  return {
    tenantId: ctx.tenantId,
    tenantDbName,
    projectId: ctx.projectId,
    // Same actor identity the plane this replaces used. The gateway calls tools
    // on behalf of whoever authenticated to the MCP endpoint, and the seam
    // carries no principal — so `allowedRoles` on an MCP tool can only be
    // written against the gateway role until the seam grows one.
    actor: { id: 'mcp-gateway', kind: 'mcp_gateway', roles: ['mcp'] },
    surface: 'mcp',
    source: 'mcp-gateway',
    traceId: traceIdFor(ctx),
  };
}

/**
 * The human-readable half of the seam's `reason`, which `mcpService` renders as
 * `Blocked by Aegis shield: <reason>`.
 *
 * Finding messages are preferred over codes because the tool-policy family
 * kept the enforcement plane's own sentences verbatim (`Tool X is not allowed`,
 * `Domain H is deny-listed`), so an operator's existing runbook still reads.
 * Blocking findings first: a warn-level message from another policy would
 * explain the wrong thing.
 */
function reasonOf(verdict: HookVerdict): string | undefined {
  const messages = verdict.findings.filter((f) => f.block).map((f) => f.message);
  const fallback = messages.length > 0 ? messages : verdict.findings.map((f) => f.message);
  const unique = [...new Set(fallback.filter(Boolean))];
  if (unique.length > 0) return unique.join('; ');
  if (verdict.codes.length > 0) return verdict.codes.join(', ');
  return verdict.decision === 'allow' ? undefined : verdict.decision;
}

function logVerdict(ctx: McpGuardrailContext, verdict: HookVerdict, denied: boolean): void {
  if (!denied && verdict.findings.length === 0) return;
  logger.info('MCP guardrail verdict', {
    serverKey: ctx.serverKey,
    tool: ctx.toolName,
    hook: verdict.hook,
    decision: verdict.decision,
    wouldBeDecision: verdict.wouldBeDecision,
    enforced: verdict.enforced,
    riskScore: verdict.riskScore,
    guardrailKey: verdict.guardrailKey,
    mode: ctx.mode,
    traceId: verdict.traceId,
  });
}

/**
 * Resolve the target and run one hook. Returns `null` when there is nothing to
 * evaluate against — a tenant whose database cannot be resolved — which the
 * callers turn into "allowed, nothing checked".
 */
async function evaluate<S extends HookSubject>(
  ctx: McpGuardrailContext,
  hook: 'tool.pre' | 'tool.post',
  subject: S,
): Promise<HookVerdict<S> | null> {
  const tenantDbName = await resolveTenantDbName(ctx.tenantId);
  if (!tenantDbName) {
    // The tenant registry is not the thing this guardrail protects. Failing the
    // tool call over a registry read would take every MCP server in the
    // process down with it.
    logger.warn('MCP guardrail could not resolve a tenant database', {
      tenantId: ctx.tenantId,
      serverKey: ctx.serverKey,
    });
    return null;
  }

  const bound = await resolveServerGuardrailKey(tenantDbName, ctx);
  let guardrailKey = bound;
  if (!guardrailKey) {
    try {
      guardrailKey = (await ensureDefaultToolGuardrail(tenantDbName, ctx.tenantId)).key;
    } catch (error) {
      // The key is a pinned literal, so naming it anyway still enforces when
      // the row exists and only the materialisation write failed. When it does
      // not exist, `runHook` answers with a vacuous allow rather than throwing.
      logger.error('Default tool guardrail could not be materialised for MCP', {
        tenantId: ctx.tenantId,
        serverKey: ctx.serverKey,
        error,
      });
      guardrailKey = DEFAULT_TOOL_GUARDRAIL_KEY;
    }
  }

  return runHook<S>({
    contractVersion: GUARDRAIL_CONTRACT_VERSION,
    hook,
    subject,
    scope: buildScope(ctx, tenantDbName),
    guardrailKeys: [guardrailKey],
  });
}

/**
 * `ctx.mode` is the SERVER-level binding (off / monitor / enforce) and is a
 * SEPARATE dimension from the guardrail record's own mode, which the engine has
 * already applied to `verdict.decision`. Both have to say "enforce" before
 * anything binding happens — otherwise a server an operator put in monitor mode
 * would still have its arguments rewritten by an enforcing guardrail, because
 * `mcpService` applies `verdict.args` unconditionally while it only honours
 * `allowed` in 'enforce'.
 */
function isEnforcing(ctx: McpGuardrailContext): boolean {
  return ctx.mode === 'enforce';
}

export const consoleMcpGuardrailHook: McpGuardrailHook = {
  async beforeToolCall(ctx, args) {
    try {
      const verdict = await evaluate(
        ctx,
        'tool.pre',
        toolCallSubject({
          // The canonical policy name, exactly as the plane this replaces built
          // it. `toolName` is already the resolved (real) name — `mcpService`
          // maps an exposed alias back before it builds the context — so a
          // `sideEffects` entry written against the stored name matches.
          toolName: `${ctx.serverKey}/${ctx.toolName}`,
          args,
          providerRef: `mcp:${ctx.serverKey}`,
        }),
      );
      if (!verdict) return { allowed: true };

      const enforcing = isEnforcing(ctx);
      const denied = enforcing && verdict.decision === 'block';
      logVerdict(ctx, verdict, denied);

      return {
        allowed: !denied,
        reason: denied ? reasonOf(verdict) : undefined,
        args:
          enforcing && verdict.decision === 'redact' && verdict.subject?.kind === 'tool_call'
            ? verdict.subject.args
            : undefined,
      };
    } catch (error) {
      // Fail-closed in enforce, open otherwise — the posture of the plane this
      // replaces, kept verbatim. Note that this is NOT the missing-guardrail
      // path: an unresolvable key produces a vacuous allow verdict inside the
      // engine and never reaches here.
      logger.error('MCP guardrail pre-hook failed', { serverKey: ctx.serverKey, error });
      return isEnforcing(ctx)
        ? { allowed: false, reason: 'Guardrail evaluation failed' }
        : { allowed: true };
    }
  },

  async afterToolCall(ctx, result) {
    try {
      const verdict = await evaluate(
        ctx,
        'tool.post',
        toolResultSubject({
          toolName: `${ctx.serverKey}/${ctx.toolName}`,
          // The seam hands back only the result. The arguments ride on a
          // `tool_result` subject purely so a `tool_access` policy can see them,
          // and every argument-shaped rule already ran at `tool.pre`; passing
          // an empty object here loses nothing and invents nothing.
          args: {},
          result,
          providerRef: `mcp:${ctx.serverKey}`,
        }),
      );
      if (!verdict) return { allowed: true };

      const enforcing = isEnforcing(ctx);
      const denied = enforcing && verdict.decision === 'block';
      logVerdict(ctx, verdict, denied);

      return {
        allowed: !denied,
        reason: denied ? reasonOf(verdict) : undefined,
        result:
          enforcing && verdict.decision === 'redact' && verdict.subject?.kind === 'tool_result'
            ? verdict.subject.result
            : undefined,
      };
    } catch (error) {
      logger.error('MCP guardrail post-hook failed', { serverKey: ctx.serverKey, error });
      return isEnforcing(ctx)
        ? { allowed: false, reason: 'Guardrail evaluation failed' }
        : { allowed: true };
    }
  },
};

/**
 * Resolve the live MCP guardrail hook, filling the seam with the community
 * bridge on first read. Idempotent, cheap, and the ONE way to reach the seam:
 * call it on every tool call rather than caching the result.
 *
 * ── WHY THIS IS LAZY AND NOT A MODULE-LOAD SIDE EFFECT ─────────────────────
 * Because the only safe time to touch `mcpGuardrailHook` is at CALL time.
 * `registry.ts` is imported at module scope by both DB providers, and in the
 * enterprise overlay it additionally imports ~20 Fastify plugins whose graphs
 * reach straight back into the MCP service:
 *   registry -> plugins/realtime -> realtime/index -> realtimeModelService
 *            -> agents/index -> agentService -> mcp/index -> mcpService
 * ES module imports are hoisted, so that whole chain runs BEFORE any of
 * registry's own body — including the `export const mcpGuardrailHook = ...`
 * initialiser. A module-scope read anywhere in that chain therefore observes
 * the binding before it exists and takes the process down at boot:
 *   TypeError: Cannot read properties of undefined (reading 'current')
 * Deferring the read to first use sidesteps the ordering question entirely,
 * and is why no module may read the ref at module scope.
 *
 * Do NOT "fix" that crash by optional-chaining the read (`mcpGuardrailHook?.`)
 * — during registry's import phase the ref is undefined, so the guard would
 * simply skip registration and the seam would stay empty for the life of the
 * process. That converts a loud boot crash into every MCP tool call silently
 * running UNGUARDED, which is the exact failure this plane exists to end.
 *
 * GUARDED so an overlay still wins: a non-null ref means something already
 * claimed the seam, and is handed back untouched.
 */
export function ensureMcpGuardrailHook(): McpGuardrailHook {
  const claimed = mcpGuardrailHook.current;
  if (claimed) return claimed;
  mcpGuardrailHook.current = consoleMcpGuardrailHook;
  return consoleMcpGuardrailHook;
}
