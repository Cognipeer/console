/**
 * Agent Run service — background execution core.
 *
 * See docs/guide/agent-background-execution.md, especially §5 (synchronous
 * ceiling), §7 (execution path), §12.12/§12.13 (why a deadline/cancel is
 * enforced by RACING `invoke()`, never by awaiting it and checking the clock
 * afterwards).
 *
 * Mirrors the crawler's job-runner shape (`crawlerJobService.ts`): claim
 * (CAS), heartbeat + piggy-backed cancel poll, finalize (CAS), notify. The
 * deliberate divergence is crash-recovery policy (see `agentRunReconciler.ts`,
 * §7.1/§12.1), not the execution shape itself.
 */

import crypto, { randomUUID } from 'node:crypto';
import axios from 'axios';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { getDatabase, type DatabaseProvider, AgentRunConflictError } from '@/lib/database';
import type { IAgentRun, AgentRunErrorReason } from '@/lib/database';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { queueNameFor } from '@/lib/core/cluster';
import { getThisNodeName } from '@/lib/core/cluster/nodeRegistry';
import { fireAndForget } from '@/lib/core/asyncTask';
import { assertSafeUrl } from '@/lib/services/crawler/engine/ssrf';
import { classifyAgentRunError } from './agentErrors';
import {
  executeAgentChat,
  executeAgentChatLocal,
  type AgentChatRequest,
  type AgentChatResponse,
  type AgentRunCancellationCell,
} from './agentService';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';

const logger = createLogger('agent-run');

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

/**
 * Bind `fn` to the tenant DB for its ENTIRE execution via a real
 * AsyncLocalStorage scope (`db.runWithTenant`), not the bare
 * `switchToTenant` (`enterWith` + a process-global fallback field) that
 * short CRUD helpers in this file use. A background run — or even a
 * synchronous one racing a multi-minute ceiling — can legitimately still be
 * executing when a concurrent request for a DIFFERENT tenant calls
 * `switchToTenant` and flips that global fallback; without this, the flip
 * would redirect this run's still-in-flight writes (heartbeat, finalize,
 * and everything `executeAgentChatLocal` itself does) into the wrong
 * tenant's database.
 *
 * NOTE: intentionally NOT `@/lib/database`'s `runWithTenantScope`, even
 * though it exists for exactly this purpose and its own doc comment warns
 * against hand-rolling clones. `runWithTenantScope`'s internal `getDatabase()`
 * call is bound to that module's own top-level `getDatabase`, which a test's
 * `vi.mock('@/lib/database', factory)` cannot override for a re-exported
 * REAL function without also breaking every OTHER caller of the mocked
 * module in this file — only a DIRECT top-level `import { getDatabase }`
 * inside this file is what vitest's per-module mock actually rebinds.
 */
async function runWithTenantDb<T>(
  tenantDbName: string,
  fn: (db: DatabaseProvider) => T | Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  if (db.runWithTenant) return db.runWithTenant(tenantDbName, () => fn(db));
  await db.switchToTenant(tenantDbName);
  return fn(db);
}

/** Resolves once `ms` has elapsed, with the given sentinel — never rejects. */
function delaySentinel<T>(ms: number, sentinel: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(sentinel), Math.max(0, ms));
    timer.unref?.();
  });
}

/** A value no real `AgentChatResponse`/finalize decision can equal — used to detect which side of a race won. */
const TIMEOUT_SENTINEL = Symbol('agent-run-deadline-timeout');
/** Wins the race the instant a cancel request is OBSERVED (heartbeat-cadence poll), not when `invoke()` eventually settles or the max-duration deadline fires. */
const CANCEL_SENTINEL = Symbol('agent-run-cancel-observed');
/**
 * How often the worker checks `cancelRequestedAt`, INDEPENDENT of the (much
 * slower, configurable) heartbeat write interval. The heartbeat exists for
 * liveness/staleness reporting to the crash reconciler (§7.1) and
 * legitimately only needs to be infrequent; cancellation responsiveness is a
 * different concern entirely — piggy-backing it onto a 15s+ heartbeat meant
 * a turn that naturally finishes in a few seconds (the common case for a
 * simple, tool-free turn) could settle and get WRITTEN before the flag was
 * ever observed, silently defeating cancel. Mirrors the crawler's own
 * `cancelPollTimer` precedent (`crawlerJobService.ts`, 250ms) of a tight,
 * dedicated poll rather than reusing a slower unrelated timer.
 */
const CANCEL_POLL_INTERVAL_MS = 1_000;

// ── Error envelopes ─────────────────────────────────────────────────────
// Matches the `{ error: { type, message, ... } }` shape already used by
// `classifyAgentRunError`/guardrail blocks in `client-agents.ts` (Group G).

export function agentRunConflictErrorBody() {
  return {
    error: {
      type: 'agent_run_conflict',
      message: 'An active run (queued or running) already exists for this conversation.',
      code: 'agent_run_conflict',
    },
  };
}

export function agentSyncTimeoutErrorBody() {
  return {
    error: {
      type: 'timeout',
      message: 'The agent turn exceeded the synchronous timeout and was terminated. '
        + 'Side effects from tool calls already in flight may have occurred; this request was not retried automatically.',
      code: 'timeout',
      side_effects_possible: true,
      retryable: false,
    },
  };
}

export function idempotencyKeyRequiresBackgroundErrorBody() {
  return {
    error: {
      type: 'invalid_request_error',
      message: 'Idempotency-Key requires background: true. Synchronous mode persists no record to key a retry against.',
      code: 'idempotency_key_sync_not_supported',
    },
  };
}

/** §12.15 — distinct from `agent_run_conflict` so a caller can tell the two 409s apart. */
export function idempotencyKeyConflictErrorBody() {
  return {
    error: {
      type: 'idempotency_key_conflict',
      message: 'This Idempotency-Key was already used with a different request (agentKey, conversationId, userMessage, or version).',
      code: 'idempotency_key_conflict',
    },
  };
}

/** §12.8 — a simple per-tenant cap on simultaneous queued+running background runs. */
export function agentRunConcurrencyLimitErrorBody(limit: number) {
  return {
    error: {
      type: 'rate_limit_error',
      message: `This tenant already has ${limit} background agent run(s) queued or running, the configured limit.`,
      code: 'agent_run_concurrency_limit',
    },
  };
}

// ── §4: shared background-signal detection ──────────────────────────────

/**
 * Resolution order (§4): header is canonical (invocation-shape-agnostic);
 * the body field exists so an unmodified OpenAI SDK client that already
 * knows how to set `background: true` gets the same behavior. Either
 * present and truthy → background mode. Callers resolve the header value
 * themselves (e.g. Fastify's `getHeaderValue(request, 'x-cognipeer-background')`)
 * so this stays usable from every current/future entry point without
 * depending on any one wire framework's request shape.
 */
export function isBackgroundModeRequested(
  headerValue: string | null | undefined,
  body: Record<string, unknown> | undefined,
): boolean {
  if (typeof headerValue === 'string' && /^true$/i.test(headerValue.trim())) return true;
  if (body?.background === true) return true;
  return false;
}

// ── §5: synchronous ceiling ───────────────────────────────────────────────

export type SyncRunOutcome =
  | { kind: 'ok'; response: AgentChatResponse }
  | { kind: 'conflict' }
  | { kind: 'timeout' };

export interface RunSyncAgentTurnInput {
  request: AgentChatRequest;
}

/**
 * Runs a turn inline, enforced with a hard wall-clock ceiling (§5).
 *
 * - Atomically reserves the single-active-run slot for this conversation
 *   first (§12.14) — a `mode: 'sync'` row, `status: 'running'`, deleted
 *   unconditionally on every exit path below (§6).
 * - Races `executeAgentChat` against the deadline (§12.13) rather than
 *   awaiting it — the deadline timer winning does NOT wait for the
 *   turn to actually stop; `executeAgentChatLocal`'s own
 *   `cancellationCell` guard (§12.12, Group B) is what keeps a late
 *   result from being persisted once that happens.
 */
export async function runSyncAgentTurn(input: RunSyncAgentTurnInput): Promise<SyncRunOutcome> {
  const { request } = input;
  return runWithTenantDb(request.tenantDbName, async (db) => {
    const cfg = getConfig();
    const deadlineAt = Date.now() + cfg.agent.syncTimeoutMs;

    let reservation: IAgentRun;
    try {
      reservation = await db.createAgentRun({
        mode: 'sync',
        tenantId: request.tenantId,
        tenantDbName: request.tenantDbName,
        projectId: request.projectId,
        agentKey: request.agentKey,
        conversationId: request.conversationId,
        userMessage: request.userMessage,
        status: 'running',
        startedAt: new Date(),
        heartbeatAt: new Date(),
        callbackAttempts: 0,
        userId: request.userId,
      });
    } catch (error) {
      if (error instanceof AgentRunConflictError) return { kind: 'conflict' };
      throw error;
    }

    const cancellationCell: AgentRunCancellationCell = { deadlineAt, cancelled: false };
    const requestWithCell: AgentChatRequest = { ...request, cancellationCell };

    try {
      const invokePromise = executeAgentChat(requestWithCell);
      // Attach a rejection handler immediately and unconditionally — if the
      // deadline wins the race below, this promise keeps running server-side
      // (Node cannot cancel it) and an eventual rejection must never become an
      // unhandled rejection. `executeAgentChatLocal`'s own guard (Group B) has
      // already ensured its SETTLED value (success or failure) is never
      // persisted once `deadlineAt` has passed, regardless of this handler.
      invokePromise.catch((error) => {
        logger.warn('Abandoned synchronous agent turn settled after the sync ceiling had already timed it out', {
          conversationId: request.conversationId,
          agentKey: request.agentKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      const remainingMs = deadlineAt - Date.now();
      const raced = await Promise.race([
        invokePromise,
        delaySentinel(remainingMs, TIMEOUT_SENTINEL),
      ]);
      if (raced === TIMEOUT_SENTINEL) {
        return { kind: 'timeout' };
      }
      return { kind: 'ok', response: raced as AgentChatResponse };
    } finally {
      // Unconditional, on every exit path (success, timeout, thrown error) —
      // a `mode: 'sync'` row is a reservation slot, never a terminal record
      // (§6). Freed immediately so a caller is never blocked behind their own
      // just-terminated call.
      await db.deleteAgentRun(String(reservation._id)).catch((error) => {
        logger.warn('Failed to delete sync AgentRun reservation row', {
          runId: reservation._id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
}

// ── §7: background execution ─────────────────────────────────────────────

export interface CreateBackgroundAgentRunInput {
  tenantId: string;
  tenantDbName: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
  userMessage: string;
  userId: string;
  version?: number;
  usePublished?: boolean;
  runtimeContext?: AgentRuntimeContext;
  apiTokenId?: string;
  callbackUrl?: string;
  /** §9/§12.15 — background-mode-only; a caller-supplied `Idempotency-Key` header. */
  idempotencyKey?: string;
  /**
   * The conversationId to fold into the idempotency comparison hash, or
   * `null` when `conversationId` above is a BRAND NEW conversation created
   * fresh for this specific attempt (no `previous_response_id` supplied).
   * A caller retrying "start a new conversation" gets a different, fresh
   * `conversationId` every attempt — hashing that would make the exact same
   * logical retry never match itself. Only set this to the real
   * conversationId when the caller explicitly continued an EXISTING
   * conversation, so a genuine retry (same key, same existing conversation,
   * same message) still compares correctly.
   */
  idempotencyConversationScope?: string | null;
}

export type CreateBackgroundAgentRunOutcome =
  | { kind: 'created'; run: IAgentRun }
  | { kind: 'idempotent_replay'; run: IAgentRun }
  | { kind: 'idempotency_conflict' }
  | { kind: 'conflict' }
  | { kind: 'concurrency_limit'; limit: number };

/** Queue job payload for a background run — the worker loads everything else off the AgentRun row (§7 step 2). */
interface AgentRunJobPayload extends QueuePayload {
  runId: string;
  tenantId: string;
  tenantDbName: string;
}

/**
 * §12.15's comparison key: same `Idempotency-Key` + same request body (this
 * hash) replays the existing run; same key + a DIFFERENT body is a genuine
 * conflict, not silently resolved either way. `conversationScope` is
 * deliberately NOT the raw, possibly-freshly-minted `conversationId` — see
 * `CreateBackgroundAgentRunInput.idempotencyConversationScope`.
 */
function idempotencyRequestHash(input: {
  agentKey: string;
  conversationScope: string | null;
  userMessage: string;
  version?: number;
}): string {
  const material = JSON.stringify({
    agentKey: input.agentKey,
    conversationScope: input.conversationScope,
    userMessage: input.userMessage,
    version: input.version ?? null,
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * Creates the `AgentRun` reservation (atomic insert, §12.14) and hands the
 * turn to the queue as a fire-and-forget job (§7 steps 1-2). A losing
 * request never creates a row and never reaches the queue — there is no
 * "stuck in queued forever" state (§12.14).
 *
 * Order of checks, each a distinct v1-minimum-bar concern (§11):
 *  1. Idempotency-Key replay/conflict (§12.15) — resolved BEFORE the
 *     concurrency cap and the single-active-run insert, since a replay of
 *     an already-accepted request must not be newly rejected by either.
 *  2. Concurrency cap (§12.8) — a simple per-tenant count check.
 *  3. The atomic single-active-run insert itself (§12.14).
 */
export async function createBackgroundAgentRun(
  input: CreateBackgroundAgentRunInput,
): Promise<CreateBackgroundAgentRunOutcome> {
  const db = await withTenantDb(input.tenantDbName);
  const cfg = getConfig();
  const requestHash = idempotencyRequestHash({
    agentKey: input.agentKey,
    conversationScope: input.idempotencyConversationScope ?? null,
    userMessage: input.userMessage,
    version: input.version,
  });

  if (input.idempotencyKey) {
    const existing = await db.getAgentRunByIdempotencyKey(
      input.tenantId,
      input.projectId,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.idempotencyRequestHash === requestHash) {
        return { kind: 'idempotent_replay', run: existing };
      }
      return { kind: 'idempotency_conflict' };
    }
  }

  const activeCount = await db.countActiveAgentRuns(input.tenantId);
  const limit = cfg.agent.backgroundMaxConcurrentRunsPerTenant;
  if (limit > 0 && activeCount >= limit) {
    return { kind: 'concurrency_limit', limit };
  }

  const expiresAt = new Date(Date.now() + cfg.agent.runRetentionDays * 86_400_000);

  let run: IAgentRun;
  try {
    run = await db.createAgentRun({
      mode: 'background',
      tenantId: input.tenantId,
      tenantDbName: input.tenantDbName,
      projectId: input.projectId,
      agentKey: input.agentKey,
      conversationId: input.conversationId,
      userMessage: input.userMessage,
      version: input.version ?? null,
      usePublished: input.usePublished,
      runtimeContext: (input.runtimeContext as Record<string, unknown> | undefined) ?? null,
      status: 'queued',
      idempotencyKey: input.idempotencyKey ?? null,
      idempotencyRequestHash: input.idempotencyKey ? requestHash : null,
      callbackUrl: input.callbackUrl ?? null,
      callbackStatus: input.callbackUrl ? 'pending' : null,
      callbackAttempts: 0,
      userId: input.userId,
      apiTokenId: input.apiTokenId,
      actorType: 'api_token',
      expiresAt,
    });
  } catch (error) {
    if (error instanceof AgentRunConflictError) return { kind: 'conflict' };
    throw error;
  }

  const queue = await getQueue();
  const payload: AgentRunJobPayload = {
    runId: String(run._id),
    tenantId: input.tenantId,
    tenantDbName: input.tenantDbName,
  };
  await queue.publish(queueNameFor('agent'), 'run', payload, { attempts: 1 });

  // §12.10 — best-effort, non-blocking; each row already carries its own
  // `expiresAt` set above, so this is simply "delete anything already past
  // its own expiry", the same write-path trigger `cleanupAgentTracingRetention`
  // uses in client-tracing.ts.
  fireAndForget('agent-run-retention-cleanup', async () => {
    await db.cleanupAgentRunRetention({ projectId: input.projectId, olderThan: new Date() });
  });

  return { kind: 'created', run };
}

export async function getAgentRunStatus(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  runId: string,
): Promise<IAgentRun | null> {
  const db = await withTenantDb(tenantDbName);
  return db.getAgentRunById(runId, tenantId, projectId);
}

export type RequestAgentRunCancellationOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_terminal'; run: IAgentRun }
  | { kind: 'accepted'; run: IAgentRun };

/**
 * §12.11's scoping check first (a run belonging to a different tenant or
 * project never even reaches the cancel-request write), THEN distinguishes
 * "no such run" (404) from "found, but already in a terminal state" (409) —
 * two different callers' mistakes, not one collapsed error.
 */
export async function requestAgentRunCancellation(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  runId: string,
): Promise<RequestAgentRunCancellationOutcome> {
  const db = await withTenantDb(tenantDbName);
  const owned = await db.getAgentRunById(runId, tenantId, projectId);
  if (!owned) return { kind: 'not_found' };
  if (owned.status !== 'queued' && owned.status !== 'running') {
    return { kind: 'already_terminal', run: owned };
  }
  const result = await db.requestAgentRunCancel(runId, tenantId, projectId);
  // Only reachable if a concurrent finalize raced this exact call between
  // the status check above and the CAS write — vanishingly narrow, but
  // still "already terminal" from this caller's point of view, not "gone".
  if (!result) return { kind: 'already_terminal', run: owned };
  return { kind: 'accepted', run: result };
}

function buildRequestFromRun(run: IAgentRun, cancellationCell: AgentRunCancellationCell): AgentChatRequest {
  return {
    tenantDbName: run.tenantDbName,
    tenantId: run.tenantId,
    projectId: run.projectId,
    agentKey: run.agentKey,
    conversationId: run.conversationId,
    userMessage: run.userMessage,
    userId: run.userId ?? '',
    version: run.version ?? undefined,
    usePublished: run.usePublished,
    runtimeContext: (run.runtimeContext as AgentRuntimeContext | null) ?? undefined,
    cancellationCell,
  };
}

/**
 * §7 steps 3-8: claim, race against `AGENT_BACKGROUND_MAX_DURATION_MS`,
 * heartbeat (liveness) + a separate tight cancel poll, finalize, notify.
 *
 * Called by the queue consumer with only `{ runId, tenantId, tenantDbName }`
 * — everything else (agent, conversation, message, runtime context) is
 * loaded from the `AgentRun` row itself (§7 step 2).
 */
export async function runAgentJobLocal(payload: AgentRunJobPayload): Promise<void> {
  const { runId, tenantId, tenantDbName } = payload;
  return runWithTenantDb(tenantDbName, async (db) => {
    const cfg = getConfig();
    const workerId = getThisNodeName();
    const startedAt = new Date();

    // Atomic queued -> running CAS (§7 step 4). A redelivered/duplicate queue
    // message must never double-execute the same run and repeat its tool
    // side effects.
    const claimed = await db.claimAgentRun(runId, tenantId, workerId, startedAt);
    if (!claimed) {
      logger.info('Agent run already claimed or not queued; skipping duplicate delivery', { runId });
      return;
    }
    logger.info('Agent run started', { runId, agentKey: claimed.agentKey, conversationId: claimed.conversationId });

    const cancellationCell: AgentRunCancellationCell = { cancelled: false };
    // Resolved the instant a cancel request is OBSERVED (via the tight
    // cancel-poll timer below) so the race further down can finalize
    // immediately — NOT wait for `invoke()` to naturally settle or for the
    // (up to 30-minute) max-duration deadline. Cancellation only stops the
    // SDK's own loop between steps (§12.2) — it does not interrupt an
    // in-flight call — but the RUN's own recorded status must not depend on
    // that call ever returning: the same "race, don't await" principle
    // §12.13 already applies to the deadline applies here too.
    let resolveCancelObserved: (() => void) | undefined;
    const cancelObservedPromise = new Promise<typeof CANCEL_SENTINEL>((resolve) => {
      resolveCancelObserved = () => resolve(CANCEL_SENTINEL);
    });

    let heartbeatStopped = false;
    const heartbeatTimer = setInterval(() => {
      void db.updateAgentRunHeartbeat(runId, workerId, new Date()).catch((error) => {
        logger.warn('Agent run heartbeat update failed', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, cfg.agent.runHeartbeatIntervalMs);
    heartbeatTimer.unref?.();

    // Cross-node cancellation: a cancel request may have been recorded by a
    // different node than the one running this job (§7 step 6) — checked on
    // its OWN tight cadence (§ note on `CANCEL_POLL_INTERVAL_MS` above),
    // deliberately not the heartbeat's slower one.
    let cancelPollStopped = false;
    const cancelPollTimer = setInterval(() => {
      void (async () => {
        try {
          const current = await db.getAgentRunById(runId, tenantId, claimed.projectId);
          if (current?.cancelRequestedAt && !cancellationCell.cancelled) {
            logger.info('Cancel request observed; finalizing without waiting for invoke() or the max-duration deadline', { runId });
            cancellationCell.cancelled = true;
            resolveCancelObserved?.();
          }
        } catch (error) {
          logger.warn('Agent run cancel poll failed', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, CANCEL_POLL_INTERVAL_MS);
    cancelPollTimer.unref?.();

    const stopHeartbeat = () => {
      if (heartbeatStopped) return;
      heartbeatStopped = true;
      clearInterval(heartbeatTimer);
    };
    const stopCancelPoll = () => {
      if (cancelPollStopped) return;
      cancelPollStopped = true;
      clearInterval(cancelPollTimer);
    };
    const stopAllTimers = () => {
      stopHeartbeat();
      stopCancelPoll();
    };

    const request = buildRequestFromRun(claimed, cancellationCell);
    const deadlineAt = Date.now() + cfg.agent.backgroundMaxDurationMs;

    const invokePromise = executeAgentChatLocal(request);
    invokePromise.catch((error) => {
      logger.warn('Abandoned background agent turn settled after the max-duration ceiling had already timed it out', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const raced = await Promise.race([
      invokePromise,
      delaySentinel(Math.max(0, deadlineAt - Date.now()), TIMEOUT_SENTINEL),
      cancelObservedPromise,
    ]);

    if (raced === CANCEL_SENTINEL) {
      // §12.12: finalize as canceled WITHOUT waiting for the abandoned
      // `invoke()` call — its eventual result (success or failure) is
      // discarded regardless (the cancellationCell guard inside
      // `executeAgentChatLocal` already skips the conversation write).
      stopAllTimers();
      const finalized = await db.finalizeAgentRun(runId, tenantId, {
        status: 'canceled',
        errorReason: 'canceled_by_caller' as AgentRunErrorReason,
        completedAt: new Date(),
      });
      if (finalized) {
        await fireAgentRunCallback(finalized, 'canceled', {});
      }
      return;
    }

    if (raced === TIMEOUT_SENTINEL) {
      // Stop the heartbeat immediately so the reconciler does not separately
      // fail this run later as `worker_lost` once its heartbeat goes stale —
      // one run, one terminal cause (§7 step 5, §12.13).
      stopAllTimers();
      const finalized = await db.finalizeAgentRun(runId, tenantId, {
        status: 'failed',
        errorReason: 'max_duration_exceeded' as AgentRunErrorReason,
        errorMessage: 'The background run exceeded AGENT_BACKGROUND_MAX_DURATION_MS and was terminated.',
        completedAt: new Date(),
      });
      if (finalized) {
        await fireAgentRunCallback(finalized, 'failed', { errorReason: 'max_duration_exceeded' });
      }
      return;
    }

    stopAllTimers();

    // §12.12: a cancel recorded in the same tick invoke() resolved wins
    // regardless of whether `invoke()` itself ended up resolving cleanly or
    // throwing — "canceled" is the honest outcome, not "succeeded" just
    // because the call happened to finish before the race above noticed
    // (belt-and-suspenders backstop; the CANCEL_SENTINEL branch above is
    // what normally catches this).
    if (cancellationCell.cancelled) {
      const finalized = await db.finalizeAgentRun(runId, tenantId, {
        status: 'canceled',
        errorReason: 'canceled_by_caller' as AgentRunErrorReason,
        completedAt: new Date(),
      });
      if (finalized) {
        await fireAgentRunCallback(finalized, 'canceled', {});
      }
      return;
    }

    try {
      const response = raced as AgentChatResponse;
      // §8: background/run responses get a per-run id, unique per run —
      // unlike the synchronous scheme's conversation-scoped
      // `resp_<conversationId>`. `_conversation_messages` is a
      // dashboard-playground-only field (see its own doc comment on
      // `AgentChatResponse`) and must never leave the client API surface —
      // stripped here exactly like the synchronous handler already strips
      // it in `client-agents.ts` before persisting/returning.
      const { _conversation_messages: _omitted, ...responseWithoutTranscript } = response;
      const responseWithRunId: AgentChatResponse = { ...responseWithoutTranscript, id: `resp_${runId}` };
      const finalized = await db.finalizeAgentRun(runId, tenantId, {
        status: 'succeeded',
        result: responseWithRunId as unknown as Record<string, unknown>,
        completedAt: new Date(),
      });
      if (finalized) {
        await fireAgentRunCallback(finalized, 'succeeded', { result: responseWithRunId });
      }
    } catch (error) {
      const classified = classifyAgentRunError(error);
      const finalized = await db.finalizeAgentRun(runId, tenantId, {
        status: 'failed',
        errorReason: 'agent_error' as AgentRunErrorReason,
        errorMessage: classified.error.message,
        completedAt: new Date(),
      });
      if (finalized) {
        await fireAgentRunCallback(finalized, 'failed', { errorReason: 'agent_error', message: classified.error.message });
      }
    }
  });
}

// ── §7 step 8 / §12.6: callback notify — durable, queue-driven retry ──

/** Job name for callback delivery, sharing the `agent` queue with `chat`/`playground`/`run`. */
const CALLBACK_JOB_NAME = 'callback';
/** Exponential backoff (2s, 4s, 8s, 16s, 32s) — durable via the queue's own `attempts`/`backoff`, not an in-process `setTimeout` chain. */
const CALLBACK_ATTEMPTS = 5;
const CALLBACK_BACKOFF_MS = 2_000;

interface AgentRunCallbackJobPayload extends QueuePayload {
  runId: string;
  tenantId: string;
  tenantDbName: string;
  projectId: string;
  conversationId: string;
  callbackUrl: string;
  event: 'succeeded' | 'failed' | 'canceled';
  data: Record<string, unknown>;
}

/**
 * Enqueues callback delivery as a fire-and-forget queue job (§12.6) rather
 * than delivering in-process — the queue's own `attempts`/`backoff` is what
 * makes delivery durable across a process restart mid-retry, not an
 * in-process `setTimeout` chain (the crawler's `sendCrawlerWebhook`
 * precedent, deliberately not repeated here).
 *
 * NOT HMAC-signed: `IAgentRun` has no per-run/per-tenant secret field to
 * sign with (unlike `ICrawlerWebhookConfig.secret`) — an open follow-up
 * pending a secret-storage decision, unchanged from the original v1 note.
 */
export async function fireAgentRunCallback(
  run: IAgentRun,
  event: 'succeeded' | 'failed' | 'canceled',
  data: Record<string, unknown>,
): Promise<void> {
  if (!run.callbackUrl) return;
  const queue = await getQueue();
  const payload: AgentRunCallbackJobPayload = {
    runId: String(run._id),
    tenantId: run.tenantId,
    tenantDbName: run.tenantDbName,
    projectId: run.projectId,
    conversationId: run.conversationId,
    callbackUrl: run.callbackUrl,
    event,
    data,
  };
  await queue.publish(queueNameFor('agent'), CALLBACK_JOB_NAME, payload, {
    attempts: CALLBACK_ATTEMPTS,
    backoffMs: CALLBACK_BACKOFF_MS,
  });
}

/**
 * The callback queue job's actual handler (registered in `agentConsumer.ts`).
 * Re-reads `callbackAttempts` fresh from the DB on every invocation (rather
 * than trusting the original payload) since the QUEUE itself calls this
 * function again on each retry — persisting cumulative attempts here is
 * what survives a process restart mid-retry (§12.6).
 *
 * Throws on delivery failure so the queue's own `attempts`/`backoff`
 * retries the job; the LAST attempt's failure is what remains as the
 * durable `callbackStatus: 'failed'` record once retries are exhausted.
 */
export async function deliverAgentRunCallbackJob(
  payload: AgentRunCallbackJobPayload,
): Promise<void> {
  const db = await withTenantDb(payload.tenantDbName);
  const current = await db.getAgentRunById(payload.runId, payload.tenantId, payload.projectId);
  const nextAttempts = (current?.callbackAttempts ?? 0) + 1;

  let delivered = false;
  let deliveryError: unknown;
  try {
    assertSafeUrl(payload.callbackUrl, false);
    const body = {
      id: `evt_${randomUUID().replace(/-/g, '')}`,
      event: `agent_run.${payload.event}`,
      createdAt: new Date().toISOString(),
      runId: payload.runId,
      tenantId: payload.tenantId,
      projectId: payload.projectId,
      conversationId: payload.conversationId,
      data: payload.data,
    };
    await axios.post(payload.callbackUrl, body, {
      headers: { 'content-type': 'application/json', 'user-agent': 'cognipeer-agent-runs/1.0' },
      timeout: 10_000,
      validateStatus: (s) => s >= 200 && s < 300,
      maxRedirects: 0,
    });
    delivered = true;
  } catch (error) {
    deliveryError = error;
    logger.warn('Agent-run webhook delivery attempt failed', {
      runId: payload.runId,
      event: payload.event,
      attempt: nextAttempts,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Callback bookkeeping only — deliberately NOT via `finalizeAgentRun`,
  // whose `status = 'running'` CAS guard would silently no-op here since
  // the run's lifecycle status has already moved on by this point.
  await db.updateAgentRunCallback(payload.runId, payload.tenantId, {
    callbackStatus: delivered ? 'delivered' : 'failed',
    callbackAttempts: nextAttempts,
  }).catch(() => undefined);

  if (!delivered) {
    throw deliveryError instanceof Error
      ? deliveryError
      : new Error(`Agent-run webhook delivery failed for run ${payload.runId}`);
  }
}
