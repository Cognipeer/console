/**
 * Agent Run service — background execution core.
 *
 * See docs/guide/agent-background-execution.md, especially §5 (synchronous
 * ceiling), §7 (execution path), §12.12/§12.13 (why a deadline/cancel is
 * enforced by RACING `invoke()`, never by awaiting it and checking the clock
 * afterwards).
 *
 * Mirrors the crawler's job-runner shape (`crawlerJobService.ts`): claim
 * (CAS), heartbeat + a separate cancel poll, finalize (CAS), notify. The
 * deliberate divergence is crash-recovery policy (see `agentRunReconciler.ts`,
 * §7.1/§12.1), not the execution shape itself.
 *
 * Every API turn is a run (`startAgentRun`): executed inline in the request
 * process (mode `inline`, recorded and heartbeating, detaching when the
 * caller's wait window ends) or queued (mode `background`, on `agent-runs`
 * or, for the low-priority `deferred` class, `agent-runs-deferred`). Limits
 * resolve as min(env ceiling, tenant quota) — `resolveAgentRunLimits` — once,
 * at submit time; a run carries its resolved ceiling on the row
 * (`maxDurationMs`).
 */

import crypto from 'node:crypto';
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import {
  getDatabase,
  type DatabaseProvider,
  AgentRunConflictError,
  AgentRunIdempotencyKeyTakenError,
} from '@/lib/database';
import type { AgentResponseFormat, AgentRunClass, IAgentRun } from '@/lib/database';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { getThisNodeName } from '@/lib/core/cluster/nodeRegistry';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { assertPublicUrl } from '@/lib/security/outboundFetch';
import { sendSignedWebhook, signWebhookBody } from '@/lib/services/webhooks/webhookDeliverer';
import { publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { resolveEffectiveLimits, type QuotaContext } from '@/lib/quota/quotaGuard';
import { getUserAuthState } from '@/lib/services/users/userAuthState';
import { AgentRunTimeoutError, classifyAgentRunError } from './agentErrors';
import { enforceAgentRunQuota, settleAgentRun } from './agentQuota';
import { createRunUsageSink, runWithUsageSink } from './runUsage';
import {
  executeAgentChat,
  executeAgentChatLocal,
  type AgentChatRequest,
  type AgentChatResponse,
  type AgentRunCancellationCell,
  executeAgentContinueLocal,
  executeAgentResumeLocal,
} from './agentService';
import { createSessionEventWriter, toSessionStopReason, type SessionEventType } from './sessionEvents';
import { cancelPendingForNewMessage } from './agentPendingActions';
import { assertQueuedTurnSpendAllowed } from './agentSpendLimits';
import { abortLocalTurns, watchTurnCancellation } from './turnWatch';

export { agentDefaultCallback } from './agentCallbackConfig';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';

const logger = createLogger('agent-run');

/**
 * Background runs (and their callbacks) get a queue of their own, with its
 * own per-node concurrency (`AGENT_RUN_CONCURRENCY`) — sharing `cluster.agent`
 * let four 30-minute runs block every routed chat turn on the node.
 */
export const AGENT_RUN_QUEUE = 'agent-runs';
/** Deferred-class runs: their own queue and workers, fed by `dispatchDeferredRuns`. */
export const AGENT_RUN_DEFERRED_QUEUE = 'agent-runs-deferred';
/** Callback deliveries (seconds each) no longer wait behind runs that take up to 30 minutes. */
export const AGENT_RUN_CALLBACK_QUEUE = 'agent-run-callbacks';

async function withTenantDb(tenantDbName: string): Promise<DatabaseProvider> {
  const db = await getDatabase();
  await db.switchToTenant(tenantDbName);
  return db;
}

/**
 * Bind `fn` to the tenant DB for its ENTIRE execution via a real
 * AsyncLocalStorage scope (`db.runWithTenant`), not the bare
 * `switchToTenant` (`enterWith` + a process-global fallback field). A run can
 * still be executing when a concurrent request for a DIFFERENT tenant flips
 * that global fallback; without this, the flip would redirect the run's
 * in-flight writes into the wrong tenant's database.
 *
 * NOTE: intentionally NOT `@/lib/database`'s `runWithTenantScope`: its
 * internal `getDatabase()` is bound to that module's own import, which a
 * test's `vi.mock('@/lib/database', factory)` cannot rebind.
 */
export async function runWithTenantDb<T>(
  tenantDbName: string,
  fn: (db: DatabaseProvider) => T | Promise<T>,
): Promise<T> {
  const db = await getDatabase();
  if (db.runWithTenant) return db.runWithTenant(tenantDbName, () => fn(db));
  await db.switchToTenant(tenantDbName);
  return fn(db);
}

/** Resolves once `ms` has elapsed, with the given sentinel — never rejects. */
function delaySentinel<T>(ms: number, sentinel: T): { promise: Promise<T>; clear: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(sentinel), Math.max(0, ms));
    timer.unref?.();
  });
  return { promise, clear: () => { if (timer) clearTimeout(timer); } };
}

/** A value no real `AgentChatResponse` can equal — used to detect which side of a race won. */
const TIMEOUT_SENTINEL = Symbol('agent-run-deadline-timeout');
/** Wins the race the instant a cancel request is OBSERVED (tight poll), not when `invoke()` settles. */
const CANCEL_SENTINEL = Symbol('agent-run-cancel-observed');
/** The turn stopped on its own while the worker waited for it. */
const TURN_SETTLED = Symbol('agent-run-turn-settled');

/**
 * How often the worker checks `cancelRequestedAt`, independent of the slower
 * heartbeat write — a turn that finishes in a few seconds must still see a
 * cancel (the crawler's `cancelPollTimer` precedent).
 */
const CANCEL_POLL_INTERVAL_MS = 1_000;

/** A sync reservation older than its own ceiling plus this is abandoned, not live. */
const SYNC_RESERVATION_GRACE_MS = 60_000;

const MAX_CALLBACK_URL_LENGTH = 2_048;
const MIN_CALLBACK_SECRET_LENGTH = 16;
const MAX_CALLBACK_SECRET_LENGTH = 256;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

// ── Ids ─────────────────────────────────────────────────────────────────

/**
 * The API hands a run out as `run_<id>` and embeds its result as
 * `resp_<id>`; the store only knows `<id>`. Every lookup by a caller-supplied
 * id goes through this, or polling with the id the API itself returned 404s.
 */
export function normalizeAgentRunId(id: string): string {
  if (id.startsWith('run_')) return id.slice(4);
  if (id.startsWith('resp_')) return id.slice(5);
  return id;
}

export function publicAgentRunId(run: Pick<IAgentRun, '_id'>): string {
  return `run_${String(run._id)}`;
}

/** Text and parsed structured output lifted from a Responses-shaped result. */
function liftRunOutput(result: Record<string, unknown> | null | undefined): { text: string | null; parsed: unknown; error: string | null } {
  if (!result) return { text: null, parsed: null, error: null };
  const parsed = result.output_parsed ?? null;
  const error = typeof result.output_error === 'string' ? result.output_error : null;
  if (typeof result.output_text === 'string') return { text: result.output_text, parsed, error };
  const output = Array.isArray(result.output) ? result.output as Array<Record<string, unknown>> : [];
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return { text: parts.length > 0 ? parts.join('') : null, parsed, error };
}

/**
 * An `AgentRun` as the runs API (§4.9) and the dashboard return it — never the
 * sealed callback secret or the caller's runtime headers.
 */
export function serializeAgentRun(run: IAgentRun) {
  const toEpochSeconds = (value: Date | string | null | undefined) =>
    (value ? Math.floor(new Date(value).getTime() / 1000) : null);
  // A paused run's result is the Responses-shaped `requires_action` body: the
  // actions to resolve ride in its `required_action`.
  const result = run.status === 'succeeded' || run.status === 'requires_action' ? run.result ?? null : null;
  const output = liftRunOutput(run.status === 'succeeded' ? result : null);
  return {
    id: publicAgentRunId(run),
    object: 'agent.run' as const,
    status: run.status,
    class: run.runClass ?? 'default',
    agent: run.agentKey,
    version: run.version ?? null,
    session_id: run.conversationId,
    conversation_id: run.conversationId,
    channel: run.channel ?? null,
    trigger: run.trigger ?? null,
    routine_id: run.routineId ?? null,
    metadata: run.metadata ?? {},
    // How the agent turn ended (`end_turn` / `limit` / `requires_action` /
    // `cancelled` / `error`). Null while the run is active and on rows from
    // before the field existed.
    stop_reason: run.stopReason ?? null,
    result,
    output_text: output.text,
    output_parsed: output.parsed,
    output_error: output.error,
    error: run.status === 'failed' || run.status === 'canceled'
      ? { type: run.errorReason ?? 'agent_error', message: run.errorMessage ?? null }
      : null,
    scheduled_for: run.status === 'scheduled' || run.notBefore ? toEpochSeconds(run.notBefore) : null,
    created_at: toEpochSeconds(run.createdAt),
    started_at: toEpochSeconds(run.startedAt),
    completed_at: toEpochSeconds(run.completedAt),
    detached_at: toEpochSeconds(run.detachedAt),
    cancel_requested_at: toEpochSeconds(run.cancelRequestedAt),
    max_duration_ms: run.maxDurationMs ?? null,
    callback: run.callbackUrl
      ? {
        url: run.callbackUrl,
        status: run.callbackStatus ?? null,
        attempts: run.callbackAttempts ?? 0,
        signed: Boolean(run.callbackSecret),
      }
      : null,
  };
}

// ── Error envelopes ─────────────────────────────────────────────────────

/** The client API's `{ error: { type, message, code } }` envelope. */
export function apiErrorBody(type: string, message: string, code = type, extra?: Record<string, unknown>) {
  return { error: { type, message, code, ...extra } };
}

export function agentRunConflictErrorBody() {
  return apiErrorBody('agent_run_conflict', 'An active run (queued or running) already exists for this conversation.');
}

/** §12.15 — distinct from `agent_run_conflict` so a caller can tell the two 409s apart. */
export function idempotencyKeyConflictErrorBody() {
  return apiErrorBody(
    'idempotency_key_conflict',
    'This Idempotency-Key was already used with a different request (agentKey, conversationId, userMessage, or version).',
  );
}

export function agentRunConcurrencyLimitErrorBody(
  limit: number,
  scope: 'tenant' | 'project' = 'tenant',
  runClass: AgentRunClass = 'default',
) {
  return apiErrorBody(
    'rate_limit_error',
    runClass === 'deferred'
      ? `This ${scope} already has ${limit} deferred agent run(s) waiting, the configured limit.`
      : `This ${scope} already has ${limit} agent run(s) queued or running, the configured limit.`,
    'agent_run_concurrency_limit',
    { class: runClass, scope, limit },
  );
}

export function invalidRequestErrorBody(message: string, code = 'invalid_request') {
  return apiErrorBody('invalid_request_error', message, code);
}

export function agentRunNotFoundErrorBody() {
  return apiErrorBody('not_found_error', 'Agent run not found', 'agent_run_not_found');
}

// ── §4: shared background-signal detection ──────────────────────────────

/**
 * Header is canonical; the body field exists so an unmodified OpenAI SDK
 * client that sets `background: true` behaves the same. Saying neither = a
 * synchronous call (which detaches into a run when its wait window ends).
 */
export function isBackgroundModeRequested(
  headerValue: string | null | undefined,
  body: Record<string, unknown> | undefined,
): boolean {
  if (typeof headerValue === 'string') {
    const value = headerValue.trim();
    if (/^true$/i.test(value)) return true;
    if (/^false$/i.test(value)) return false;
  }
  return body?.background === true;
}

// ── Effective limits ────────────────────────────────────────────────────

export interface AgentRunLimits {
  /** How long a synchronous call waits before it answers 202 and the run continues. */
  syncWaitMs: number;
  /** Wall-clock ceiling of the run itself (any mode). */
  maxDurationMs: number;
  /** Default class: queued+running runs per tenant, every mode; 0 = no cap. */
  maxActivePerTenant: number;
  /** Default class: queued+running runs per project; 0 = off. */
  maxActivePerProject: number;
}

function positiveMin(...values: Array<number | undefined | null>): number | undefined {
  const usable = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return usable.length > 0 ? Math.min(...usable) : undefined;
}

/**
 * min(env ceiling, tenant quota) for every run knob. The env value is the hard
 * ceiling nothing can raise; a quota of 0/unset means "no tighter bound here".
 * Agents have no say (their Execution settings were removed): what a single
 * turn may take is `runtime.limits`, enforced inside the turn.
 */
export async function resolveAgentRunLimits(input: {
  quotaContext?: Omit<QuotaContext, 'domain'> | null;
} = {}): Promise<AgentRunLimits> {
  const env = getConfig().agent;
  let quotas: { maxAgentSyncTimeoutSeconds?: number; maxAgentBackgroundDurationMinutes?: number; maxConcurrentAgentRuns?: number } = {};
  if (input.quotaContext) {
    try {
      const limits = await resolveEffectiveLimits({ ...input.quotaContext, domain: 'global' });
      quotas = limits.quotas ?? {};
    } catch (error) {
      logger.warn('Could not resolve tenant quota for agent run limits; using env ceilings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const secondsToMs = (s?: number) => (typeof s === 'number' ? s * 1000 : undefined);
  const minutesToMs = (m?: number) => (typeof m === 'number' ? m * 60_000 : undefined);
  return {
    syncWaitMs: positiveMin(env.syncTimeoutMs, secondsToMs(quotas.maxAgentSyncTimeoutSeconds)) ?? env.syncTimeoutMs,
    maxDurationMs: positiveMin(env.backgroundMaxDurationMs, minutesToMs(quotas.maxAgentBackgroundDurationMinutes))
      ?? env.backgroundMaxDurationMs,
    maxActivePerTenant: positiveMin(env.runMaxActivePerTenant, quotas.maxConcurrentAgentRuns) ?? 0,
    maxActivePerProject: env.runMaxActivePerProject,
  };
}

/** The env ceilings alone (no tenant quota), for callers that resolve none. */
function envRunLimits(): AgentRunLimits {
  const env = getConfig().agent;
  return {
    syncWaitMs: env.syncTimeoutMs,
    maxDurationMs: env.backgroundMaxDurationMs,
    maxActivePerTenant: env.runMaxActivePerTenant,
    maxActivePerProject: env.runMaxActivePerProject,
  };
}

// ── Callback validation ─────────────────────────────────────────────────

/**
 * Submit-time check of a caller's callback: http(s), bounded, and resolving
 * to a public address — rejected with 400 now rather than accepted with 202
 * and silently failing (or worse, reaching an internal service) later.
 * Delivery re-checks through `safeFetch` (DNS pinning, per-hop checks), so a
 * name that is public now and rebinds later is still refused.
 */
export async function validateCallbackRequest(
  url: unknown,
  secret: unknown,
): Promise<{ ok: true; url?: string; secret?: string } | { ok: false; message: string }> {
  const hasSecret = secret !== undefined && secret !== null && secret !== '';
  if (url === undefined || url === null || url === '') {
    return hasSecret ? { ok: false, message: 'callback_secret requires callback_url' } : { ok: true };
  }
  if (typeof url !== 'string' || url.length > MAX_CALLBACK_URL_LENGTH) {
    return { ok: false, message: `callback_url must be a string of at most ${MAX_CALLBACK_URL_LENGTH} characters` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: 'callback_url is not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, message: 'callback_url must use http or https' };
  }
  try {
    await assertPublicUrl(url);
  } catch {
    return { ok: false, message: 'callback_url must resolve to a public address' };
  }
  if (!hasSecret) return { ok: true, url };
  if (typeof secret !== 'string' || secret.length < MIN_CALLBACK_SECRET_LENGTH || secret.length > MAX_CALLBACK_SECRET_LENGTH) {
    return { ok: false, message: `callback_secret must be ${MIN_CALLBACK_SECRET_LENGTH}–${MAX_CALLBACK_SECRET_LENGTH} characters` };
  }
  return { ok: true, url, secret };
}

// ── §5: synchronous ceiling + conversation reservation ──────────────────

/**
 * Reserve the conversation's single active-run slot with a `mode: 'sync'`
 * row. Returns `null` when a run (sync or background) already holds it.
 * `release` is idempotent.
 */
export async function reserveConversationForSyncTurn(
  db: DatabaseProvider,
  request: Pick<AgentChatRequest, 'tenantId' | 'tenantDbName' | 'projectId' | 'agentKey' | 'conversationId' | 'userMessage' | 'userId'>,
): Promise<{ run: IAgentRun; release: () => Promise<void> } | null> {
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
    if (error instanceof AgentRunConflictError) return null;
    throw error;
  }
  let released = false;
  return {
    run: reservation,
    release: async () => {
      if (released) return;
      released = true;
      await db.deleteAgentRun(String(reservation._id)).catch((error) => {
        logger.warn('Failed to delete sync AgentRun reservation row', {
          runId: reservation._id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  };
}

/**
 * `executeAgentChat` holding the conversation's slot for the whole turn;
 * throws `AgentRunConflictError` (→ 409 via `classifyAgentRunError`) when
 * another run holds it. For entry points that run a turn on an EXISTING
 * conversation outside the run engine: without the slot those turns could
 * overlap a background run on the same conversation and one would overwrite
 * the other's history.
 */
export async function executeAgentChatExclusive(request: AgentChatRequest): Promise<AgentChatResponse> {
  const reservation = await reserveConversationForSyncTurn(await getDatabase(), request);
  if (!reservation) throw new AgentRunConflictError(request.conversationId);
  // A Stop (or the caller's own signal) ends the turn; what it had streamed is kept as the answer.
  const watch = watchTurnCancellation({
    tenantDbName: request.tenantDbName,
    tenantId: request.tenantId,
    projectId: request.projectId,
    conversationId: request.conversationId,
    runId: String(reservation.run._id),
    parent: request.signal,
  });
  try {
    return await executeAgentChat({ ...request, signal: watch.signal });
  } finally {
    watch.stop();
    await reservation.release();
  }
}

// ── §4.1: one creation path ──────────────────────────────────────────────

/** Longest a run may be scheduled ahead (`run_at` / `delay_seconds`). */
export const MAX_RUN_SCHEDULE_AHEAD_MS = 30 * 86_400_000;
/** A `notBefore` closer than this is "now": the run is queued, not scheduled. */
const SCHEDULE_THRESHOLD_MS = 1_000;

const ACTIVE_RUN_STATUSES: ReadonlySet<IAgentRun['status']> = new Set(['scheduled', 'queued', 'running']);

/** A run still on its way (not finished, not paused). */
export function isAgentRunActive(run: Pick<IAgentRun, 'status'>): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

/**
 * Notifications rule (§4.2.6): `agent_run.*` webhook events and the per-run
 * callback are for runs nobody is waiting on — queued runs, and inline runs
 * whose caller stopped waiting (`detachedAt`). A turn answered inline (and a
 * dashboard reservation) emits none: its caller already has the answer.
 */
export function isAsyncAgentRun(run: Pick<IAgentRun, 'mode' | 'detachedAt'>): boolean {
  return run.mode === 'background' || (run.mode === 'inline' && Boolean(run.detachedAt));
}

export interface StartAgentRunStream {
  onTextChunk?: AgentChatRequest['onTextChunk'];
  onReasoningChunk?: AgentChatRequest['onReasoningChunk'];
}

export type StartAgentRunExecution =
  | {
    kind: 'inline';
    /** The caller's wait window (`AgentRunLimits.syncWaitMs`); ignored for a stream. */
    waitMs: number;
    /** A streaming caller: no window (it is receiving), bounded by the run ceiling only. */
    stream?: StartAgentRunStream;
    /** Aborts when the client disconnects. */
    signal?: AbortSignal;
    /** On disconnect: stop the run (a stream that did not ask for background) or keep it running detached. */
    cancelOnDisconnect: boolean;
    /** The admitted row, before the turn starts (a stream names its run up front). */
    onStarted?: (run: IAgentRun) => void;
  }
  | {
    kind: 'queued';
    /** Scheduled start (`run_at` / `delay_seconds`); more than 1 s ahead = a `scheduled` row. */
    notBefore?: Date;
  };

export interface StartAgentRunInput {
  tenantId: string;
  tenantDbName: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
  userMessage: string;
  /** Ids of the conversation files the message attaches. */
  attachments?: string[];
  /**
   * The part of `attachments` that identifies the request for idempotency: the
   * files the caller named by id. A file sent inline is stored under a new id
   * on every attempt, so it cannot be part of what makes a retry "the same".
   */
  idempotencyAttachments?: string[];
  userId: string;
  apiTokenId?: string;
  actorType?: IAgentRun['actorType'];
  version?: number;
  usePublished?: boolean;
  runtimeContext?: AgentRuntimeContext;
  /** Inline only (a queued run reads the model choice from its session). */
  modelKey?: string;
  /** Inline only. */
  requestReasoning?: AgentChatRequest['requestReasoning'];
  /** Inline only: a caller that cannot answer an approval (chat completions) — gated tools follow the agent's unattended policy. */
  unattended?: boolean;
  /** Inline only: the caller runs the agent's client tools (chat completions `tool_calls`). */
  answersClientTools?: boolean;
  responseFormat?: AgentResponseFormat | null;
  inputs?: Record<string, unknown> | null;
  /** Default `default`. A `deferred` run is always queued. */
  runClass?: AgentRunClass;
  channel?: IAgentRun['channel'];
  metadata?: Record<string, string> | null;
  routineId?: string | null;
  trigger?: IAgentRun['trigger'];
  /** A caller-supplied `Idempotency-Key` (every mode). */
  idempotencyKey?: string;
  /**
   * The conversationId folded into the idempotency hash, or `null` when the
   * run starts a brand-new conversation (a fresh id per attempt would make a
   * retry never match itself).
   */
  idempotencyConversationScope?: string | null;
  /** Plaintext secret; sealed before it is stored. */
  callback?: { url: string; secret?: string } | null;
  execution: StartAgentRunExecution;
  /** From `resolveAgentRunLimits`; default = the env ceilings. */
  limits?: AgentRunLimits;
}

export type StartAgentRunOutcome =
  /** Inline, finished inside the window (200). */
  | { kind: 'completed'; run: IAgentRun; response: AgentChatResponse }
  /** Inline, the window ended first: the run keeps going (202). */
  | { kind: 'detached'; run: IAgentRun }
  /** Queued / scheduled / deferred (202). */
  | { kind: 'accepted'; run: IAgentRun }
  /**
   * Same Idempotency-Key, same request: the stored run. For an inline call an
   * active run was waited on for the window first, so it may still be active (202).
   */
  | { kind: 'replay'; run: IAgentRun }
  | { kind: 'idempotency_conflict' }
  | { kind: 'conflict' }
  | { kind: 'concurrency_limit'; limit: number; scope: 'tenant' | 'project'; runClass: AgentRunClass };

/** Queue job payload for a run — the worker loads everything else off the AgentRun row. */
interface AgentRunJobPayload extends QueuePayload {
  runId: string;
  tenantId: string;
  tenantDbName: string;
  /** Set on deferred-queue jobs: the worker checks the class's running cap before it claims. */
  runClass?: AgentRunClass;
}

function idempotencyRequestHash(
  input: Pick<StartAgentRunInput, 'agentKey' | 'userMessage' | 'idempotencyAttachments' | 'version' | 'idempotencyConversationScope'>,
): string {
  const material = JSON.stringify({
    agentKey: input.agentKey,
    conversationScope: input.idempotencyConversationScope ?? null,
    userMessage: input.userMessage,
    version: input.version ?? null,
    // Only when present: a request without attachments hashes as it always did.
    ...(input.idempotencyAttachments?.length ? { attachments: [...input.idempotencyAttachments].sort() } : {}),
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/**
 * Header values in a runtime context are downstream credentials (bearer
 * tokens for tools/MCP) and must never sit in the store in plaintext
 * (runtimeContext.ts: "never logged or persisted"). The worker needs them,
 * so the row keeps them sealed and the finalize step erases them.
 */
function sealRuntimeContext(context: AgentRuntimeContext | undefined): Record<string, unknown> | null {
  if (!context) return null;
  return { sealed: encryptObject(context) };
}

/** An `encryptObject` value opened again; undefined when absent or unreadable (e.g. a rotated key). */
function openSealed<T>(sealed: unknown): T | undefined {
  if (typeof sealed !== 'string' || !sealed) return undefined;
  try {
    return decryptObject<T>(sealed);
  } catch {
    return undefined;
  }
}

/**
 * Replay/conflict check for an `Idempotency-Key` BEFORE the caller creates a
 * conversation — otherwise every retry of "start a new conversation" leaves
 * an orphan conversation behind even though the run itself is replayed.
 */
export async function lookupIdempotentAgentRun(input: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  userMessage: string;
  idempotencyAttachments?: string[];
  version?: number;
  idempotencyKey: string;
  idempotencyConversationScope: string | null;
}): Promise<{ kind: 'replay'; run: IAgentRun } | { kind: 'conflict' } | { kind: 'none' }> {
  const db = await withTenantDb(input.tenantDbName);
  const existing = await db.getAgentRunByIdempotencyKey(input.tenantId, input.projectId, input.idempotencyKey);
  if (!existing) return { kind: 'none' };
  return existing.idempotencyRequestHash === idempotencyRequestHash(input) ? { kind: 'replay', run: existing } : { kind: 'conflict' };
}

/** Run row identity for `waitForAgentRun` / `cancelAgentRun`. */
export interface AgentRunRef {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  /** `run_<id>`, `resp_<id>` or the bare id. */
  runId: string;
}

const WAIT_POLL_MIN_MS = 500;
const WAIT_POLL_MAX_MS = 2_000;

/**
 * Polls a run until it is terminal, paused (`requires_action`) or `timeoutMs`
 * passed (500 ms, backing off to 2 s). Returns the latest row; null when it
 * does not exist (or vanished).
 */
export async function waitForAgentRun(ref: AgentRunRef, timeoutMs: number): Promise<IAgentRun | null> {
  const runId = normalizeAgentRunId(ref.runId);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let delay = WAIT_POLL_MIN_MS;
  for (;;) {
    const run = await runWithTenantDb(ref.tenantDbName, (db) => db.getAgentRunById(runId, ref.tenantId, ref.projectId));
    if (!run || !isAgentRunActive(run)) return run;
    const left = deadline - Date.now();
    if (left <= 0) return run;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, left)));
    delay = Math.min(WAIT_POLL_MAX_MS, Math.round(delay * 1.5));
  }
}

/** Over the default class's active cap after this row's insert? (every mode counts, dashboard reservations included) */
async function defaultClassOverCap(
  db: DatabaseProvider,
  tenantId: string,
  projectId: string,
  limits: AgentRunLimits,
): Promise<{ limit: number; scope: 'tenant' | 'project' } | null> {
  if (limits.maxActivePerTenant > 0) {
    const active = await db.countActiveAgentRuns(tenantId, undefined, { runClass: 'default' });
    if (active > limits.maxActivePerTenant) return { limit: limits.maxActivePerTenant, scope: 'tenant' };
  }
  if (limits.maxActivePerProject > 0) {
    const active = await db.countActiveAgentRuns(tenantId, projectId, { runClass: 'default' });
    if (active > limits.maxActivePerProject) return { limit: limits.maxActivePerProject, scope: 'project' };
  }
  return null;
}

/**
 * Starts an agent turn as a run — the one way API callers, routines and the
 * runs API start one (§4.1). The dialect has already resolved and validated
 * the agent, session, files, budget, model and inputs.
 *
 * Order: idempotency (a replay must never be newly refused by the other
 * checks) → the insert itself (conversation slot + unique idempotency key) →
 * the class caps, checked AFTER the insert against the real count so a burst
 * of parallel requests cannot all pass a read-then-write check; the row that
 * tips a cap over is deleted again and reported as 429.
 */
export async function startAgentRun(input: StartAgentRunInput): Promise<StartAgentRunOutcome> {
  const runClass: AgentRunClass = input.runClass ?? 'default';
  if (runClass === 'deferred' && input.execution.kind === 'inline') {
    throw new Error('A deferred run is always queued');
  }
  const limits = input.limits ?? envRunLimits();
  const cfg = getConfig();

  return runWithTenantDb(input.tenantDbName, async (db) => {
    const requestHash = idempotencyRequestHash(input);
    const settleReplay = async (existing: IAgentRun | null): Promise<StartAgentRunOutcome> => {
      if (!existing || existing.idempotencyRequestHash !== requestHash) return { kind: 'idempotency_conflict' };
      // An inline caller retrying a run that is still going waits like a new call would.
      if (input.execution.kind === 'inline' && isAgentRunActive(existing)) {
        const waited = await waitForAgentRun(
          { tenantDbName: input.tenantDbName, tenantId: input.tenantId, projectId: input.projectId, runId: String(existing._id) },
          input.execution.waitMs,
        );
        return { kind: 'replay', run: waited ?? existing };
      }
      return { kind: 'replay', run: existing };
    };
    const lookupKey = () => db.getAgentRunByIdempotencyKey(input.tenantId, input.projectId, input.idempotencyKey!);

    if (input.idempotencyKey) {
      const existing = await lookupKey();
      if (existing) return settleReplay(existing);
    }

    if (input.execution.kind === 'queued') {
      // Agent-run quota (domain `agent`), counted HERE once for the whole run:
      // the worker executes `executeAgentChatLocal`, which does not count again,
      // and a caller over its limit gets the 429 now rather than a run that
      // fails later. An inline run is counted by `executeAgentChat` itself.
      // Throws `AgentQuotaExceededError` (classified as a 429).
      await enforceAgentRunQuota({
        tenantDbName: input.tenantDbName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        agentKey: input.agentKey,
        userId: input.userId,
        tokenId: input.apiTokenId,
      });
    }

    const base: Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt' | 'mode' | 'status'> = {
      tenantId: input.tenantId,
      tenantDbName: input.tenantDbName,
      projectId: input.projectId,
      agentKey: input.agentKey,
      conversationId: input.conversationId,
      userMessage: input.userMessage,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      version: input.version ?? null,
      usePublished: input.usePublished,
      runtimeContext: sealRuntimeContext(input.runtimeContext),
      idempotencyKey: input.idempotencyKey ?? null,
      idempotencyRequestHash: input.idempotencyKey ? requestHash : null,
      callbackUrl: input.callback?.url ?? null,
      callbackSecret: input.callback?.secret ? encryptObject(input.callback.secret) : null,
      callbackAttempts: 0,
      maxDurationMs: limits.maxDurationMs,
      userId: input.userId,
      ...(input.apiTokenId ? { apiTokenId: input.apiTokenId } : {}),
      actorType: input.actorType ?? (input.apiTokenId ? 'api_token' : input.userId.startsWith('system:') ? 'system' : 'user'),
      expiresAt: new Date(Date.now() + cfg.agent.runRetentionDays * 86_400_000),
      runClass,
      channel: input.channel ?? null,
      metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : null,
      routineId: input.routineId ?? null,
      trigger: input.trigger ?? 'request',
      responseFormat: input.responseFormat ?? null,
      inputs: input.inputs ?? null,
      queueGeneration: 1,
    };

    const insert = async (record: Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>): Promise<IAgentRun | StartAgentRunOutcome> => {
      try {
        return await db.createAgentRun(record);
      } catch (error) {
        if (error instanceof AgentRunIdempotencyKeyTakenError) return settleReplay(await lookupKey());
        if (error instanceof AgentRunConflictError) return { kind: 'conflict' };
        throw error;
      }
    };
    const isOutcome = (value: IAgentRun | StartAgentRunOutcome): value is StartAgentRunOutcome => 'kind' in value;

    if (input.execution.kind === 'inline') {
      const execution = input.execution;
      const now = new Date();
      const inserted = await insert({
        ...base,
        mode: 'inline',
        status: 'running',
        startedAt: now,
        heartbeatAt: now,
        workerId: getThisNodeName(),
        // No callback is owed unless the caller stops waiting (see isAsyncAgentRun);
        // `pending` here would make the reconciler send one for an answered turn.
        callbackStatus: null,
      });
      if (isOutcome(inserted)) return inserted;
      const cap = await defaultClassOverCap(db, input.tenantId, input.projectId, limits);
      if (cap) {
        await db.deleteAgentRun(String(inserted._id)).catch(() => undefined);
        return { kind: 'concurrency_limit', ...cap, runClass };
      }

      try {
        execution.onStarted?.(inserted);
      } catch (error) {
        logger.warn('Inline run start hook failed', { runId: inserted._id, error: error instanceof Error ? error.message : String(error) });
      }
      const handle = executeInlineRun(db, inserted, input, execution, limits.maxDurationMs);
      if (execution.stream) return inlineOutcome(await handle.settled);
      const window = delaySentinel(execution.waitMs, WINDOW_SENTINEL);
      try {
        const raced = await Promise.race([handle.settled, window.promise]);
        if (raced !== WINDOW_SENTINEL) return inlineOutcome(raced);
      } finally {
        window.clear();
      }
      const detached = await handle.detach();
      // Null = it finished between the window and the detach: answer it.
      if (!detached) return inlineOutcome(await handle.settled);
      return { kind: 'detached', run: detached };
    }

    const notBefore = input.execution.notBefore;
    const scheduled = Boolean(notBefore && notBefore.getTime() > Date.now() + SCHEDULE_THRESHOLD_MS);
    const inserted = await insert({
      ...base,
      mode: 'background',
      status: scheduled ? 'scheduled' : 'queued',
      notBefore: scheduled ? notBefore! : null,
      callbackStatus: input.callback?.url ? 'pending' : null,
    });
    if (isOutcome(inserted)) return inserted;
    const runId = String(inserted._id);

    if (runClass === 'deferred') {
      const waiting = await db.countAgentRunsByStatus(input.tenantId, { statuses: ['queued', 'scheduled'], runClass: 'deferred' });
      const total = (waiting.queued ?? 0) + (waiting.scheduled ?? 0);
      if (total > cfg.agent.deferredMaxQueuedPerTenant) {
        await db.deleteAgentRun(runId).catch(() => undefined);
        return { kind: 'concurrency_limit', limit: cfg.agent.deferredMaxQueuedPerTenant, scope: 'tenant', runClass };
      }
      // Deferred rows are not published at insert: the dispatcher hands them out within the class's running cap.
      if (!scheduled) {
        await dispatchDeferredRuns(input.tenantDbName, input.tenantId).catch((error) => {
          logger.warn('Deferred run dispatch failed; the reconciler retries it', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return { kind: 'accepted', run: inserted };
    }

    // A scheduled row is not active: no slot, no cap until it is promoted.
    if (scheduled) return { kind: 'accepted', run: inserted };
    const cap = await defaultClassOverCap(db, input.tenantId, input.projectId, limits);
    if (cap) {
      await db.deleteAgentRun(runId).catch(() => undefined);
      return { kind: 'concurrency_limit', ...cap, runClass };
    }
    try {
      await publishAgentRunJob(inserted);
    } catch (error) {
      // Nothing will ever pick this row up — free the conversation instead of
      // leaving it locked until a reconciler notices.
      await db.deleteAgentRun(runId).catch(() => undefined);
      throw error;
    }
    return { kind: 'accepted', run: inserted };
  });
}

// ── §4.2: inline execution ───────────────────────────────────────────────

/** Wins the race when the caller's wait window ends first. */
const WINDOW_SENTINEL = Symbol('agent-run-wait-window');

type InlineSettlement =
  | { kind: 'response'; run: IAgentRun; response: AgentChatResponse }
  | { kind: 'error'; run: IAgentRun; error: unknown }
  | { kind: 'timeout'; run: IAgentRun };

function inlineOutcome(settlement: InlineSettlement): StartAgentRunOutcome {
  if (settlement.kind === 'response') return { kind: 'completed', run: settlement.run, response: settlement.response };
  // The caller is still there: the turn's own error is its answer (the dialect
  // maps it, as for any failed call); the row is already finalized.
  if (settlement.kind === 'error') throw settlement.error;
  throw new AgentRunTimeoutError();
}

/** A run executing in this process (inline turn or queue worker) — what the shutdown drain waits for. */
interface LocalRun {
  runId: string;
  tenantId: string;
  tenantDbName: string;
  projectId: string;
  conversationId: string;
  cell: AgentRunCancellationCell;
  /** Stops the turn (signal / supersede). */
  abort: () => void;
  settled: Promise<unknown>;
}

const activeLocalRuns = new Map<string, LocalRun>();

/** Runs executing on this node right now (inline and worker). */
export function activeLocalAgentRunCount(): number {
  return activeLocalRuns.size;
}

/**
 * Executes an inline run's turn in this process: heartbeat (like a worker), the
 * conversation Stop / `cancelRequestedAt` watch (abort via the turn's signal),
 * the run's own ceiling (`maxDurationMs`, NOT the caller's window), finalize
 * once, notify when the caller is gone.
 */
function executeInlineRun(
  db: DatabaseProvider,
  run: IAgentRun,
  input: StartAgentRunInput,
  execution: Extract<StartAgentRunExecution, { kind: 'inline' }>,
  maxDurationMs: number,
): { settled: Promise<InlineSettlement>; detach: () => Promise<IAgentRun | null> } {
  const cfg = getConfig();
  const runId = String(run._id);
  const tenantId = run.tenantId;
  const workerId = run.workerId ?? getThisNodeName();
  const cancellationCell: AgentRunCancellationCell = { cancelled: false, deadlineAt: Date.now() + maxDurationMs };
  const stop = new AbortController();
  const watch = watchTurnCancellation({
    tenantDbName: run.tenantDbName,
    tenantId,
    projectId: run.projectId,
    conversationId: run.conversationId,
    runId,
    parent: stop.signal,
  });
  let cancelRequested = false;
  let superseded = false;

  const detach = async (): Promise<IAgentRun | null> => db.markAgentRunDetached(runId, tenantId, new Date()).catch((error) => {
    logger.warn('Could not mark the inline run detached', { runId, error: error instanceof Error ? error.message : String(error) });
    return null;
  });

  const onDisconnect = () => {
    if (execution.cancelOnDisconnect) {
      // The same as a Stop: the row says so, the turn ends at its next checkpoint.
      cancelRequested = true;
      void db.requestAgentRunCancel(runId, tenantId, run.projectId).catch(() => undefined);
      stop.abort();
      return;
    }
    // The caller left; the run carries on as an async one.
    void detach();
  };
  if (execution.signal?.aborted) onDisconnect();
  else execution.signal?.addEventListener('abort', onDisconnect, { once: true });

  const heartbeatTimer = setInterval(() => {
    void db.updateAgentRunHeartbeat(runId, workerId, new Date())
      .then((updated) => {
        // Null = the row is no longer ours and running (the reconciler failed
        // it, or the drain did): stop the turn instead of writing a result nobody records.
        if (!updated && !superseded) {
          logger.warn('Inline agent run is no longer owned by this node; stopping the turn', { runId });
          superseded = true;
          cancellationCell.cancelled = true;
          stop.abort();
        }
      })
      .catch((error) => {
        logger.warn('Agent run heartbeat update failed', { runId, error: error instanceof Error ? error.message : String(error) });
      });
  }, cfg.agent.runHeartbeatIntervalMs);
  heartbeatTimer.unref?.();
  const deadline = delaySentinel(maxDurationMs, TIMEOUT_SENTINEL);

  const invoke = executeAgentChat({
    tenantDbName: run.tenantDbName,
    tenantId,
    projectId: run.projectId,
    agentKey: run.agentKey,
    conversationId: run.conversationId,
    userMessage: run.userMessage,
    ...(run.attachments?.length ? { attachments: run.attachments } : {}),
    userId: input.userId,
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.usePublished !== undefined ? { usePublished: input.usePublished } : {}),
    ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
    ...(input.modelKey ? { modelKey: input.modelKey } : {}),
    ...(input.requestReasoning ? { requestReasoning: input.requestReasoning } : {}),
    ...(input.unattended ? { unattended: true } : {}),
    ...(input.answersClientTools ? { answersClientTools: true } : {}),
    ...(input.responseFormat ? { responseFormat: input.responseFormat } : {}),
    ...(input.inputs ? { inputs: input.inputs } : {}),
    ...(execution.stream?.onTextChunk ? { onTextChunk: execution.stream.onTextChunk } : {}),
    ...(execution.stream?.onReasoningChunk ? { onReasoningChunk: execution.stream.onReasoningChunk } : {}),
    runId,
    cancellationCell,
    signal: watch.signal,
  }).then(
    (response) => ({ ok: true as const, response }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const finalize = async (
    status: 'succeeded' | 'failed' | 'canceled' | 'requires_action',
    data: Pick<IAgentRun, 'errorReason' | 'errorMessage' | 'result' | 'stopReason'>,
    callbackData: Record<string, unknown> = {},
  ): Promise<IAgentRun | null> => {
    const paused = status === 'requires_action';
    const stopReason = data.stopReason
      ?? (status === 'failed' ? 'error' : status === 'canceled' ? 'cancelled' : undefined);
    const finalized = await db.finalizeAgentRun(runId, tenantId, {
      ...data,
      ...(stopReason ? { stopReason } : {}),
      status,
      // A paused run is not done; the sealed caller headers stay for its continuation.
      ...(paused ? {} : { completedAt: new Date(), runtimeContext: null }),
    }).catch((error) => {
      logger.warn('Could not finalize the inline agent run', { runId, error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (finalized) {
      await fireAgentRunCallback(finalized, status, callbackData).catch((error) => {
        logger.warn('Could not queue the run callback', { runId, error: error instanceof Error ? error.message : String(error) });
      });
    }
    return finalized;
  };

  const settled = (async (): Promise<InlineSettlement> => {
    try {
      const raced = await Promise.race([invoke, deadline.promise]);
      clearInterval(heartbeatTimer);
      deadline.clear();
      if (raced === TIMEOUT_SENTINEL) {
        cancellationCell.cancelled = true;
        // Finalized without waiting: the turn may still be inside a call and must
        // not write over whatever starts on the freed conversation.
        cancellationCell.abandoned = true;
        stop.abort();
        const minutes = Math.max(1, Math.round(maxDurationMs / 60_000));
        const finalized = await finalize('failed', {
          errorReason: 'max_duration_exceeded',
          errorMessage: `The run exceeded its ${minutes}-minute limit and was stopped.`,
        }, { errorReason: 'max_duration_exceeded' });
        return { kind: 'timeout', run: finalized ?? run };
      }
      if (!raced.ok) {
        if (superseded) return { kind: 'error', run, error: raced.error };
        const message = publicFailureMessage(raced.error);
        const finalized = await finalize('failed', { errorReason: 'agent_error', errorMessage: message }, { errorReason: 'agent_error', message });
        return { kind: 'error', run: finalized ?? run, error: raced.error };
      }
      const { _conversation_messages: _omitted, ...body } = raced.response;
      void _omitted;
      const result = { ...body, id: `resp_${runId}` } as unknown as Record<string, unknown>;
      if (superseded) return { kind: 'response', run, response: raced.response };
      if (raced.response.status === 'requires_action') {
        const paused = await finalize('requires_action', { result, stopReason: 'requires_action' }, { result });
        return { kind: 'response', run: paused ?? run, response: raced.response };
      }
      // A Stop ends the turn with what it had streamed: that is the answer, and the run is `canceled`.
      if (cancelRequested || watch.stopRequested()) {
        const canceled = await finalize('canceled', { errorReason: 'canceled_by_caller', result, stopReason: 'cancelled' });
        return { kind: 'response', run: canceled ?? run, response: raced.response };
      }
      const done = await finalize('succeeded', { result, stopReason: toSessionStopReason(raced.response.stop_reason) }, { result });
      return { kind: 'response', run: done ?? run, response: raced.response };
    } catch (error) {
      logger.error('Inline agent run failed unexpectedly', { runId, error: error instanceof Error ? error.message : String(error) });
      const finalized = await finalize('failed', { errorReason: 'agent_error', errorMessage: GENERIC_FAILURE_MESSAGE }, { errorReason: 'agent_error' });
      return { kind: 'error', run: finalized ?? run, error };
    } finally {
      clearInterval(heartbeatTimer);
      deadline.clear();
      watch.stop();
      execution.signal?.removeEventListener('abort', onDisconnect);
      activeLocalRuns.delete(runId);
    }
  })();

  activeLocalRuns.set(runId, {
    runId,
    tenantId,
    tenantDbName: run.tenantDbName,
    projectId: run.projectId,
    conversationId: run.conversationId,
    cell: cancellationCell,
    abort: () => stop.abort(),
    settled,
  });
  return { settled, detach };
}

// ── §4.3: deferred dispatch ──────────────────────────────────────────────

/**
 * Hands out deferred runs within the class's running cap: slots = cap −
 * running deferred; the oldest due queued deferred rows fill them. Called
 * after a deferred insert, after a deferred run finishes and on every
 * reconciler tick. Republishing a row already handed out is a no-op (same
 * dedup key); the worker's claim guard keeps the cap when two nodes race.
 */
export async function dispatchDeferredRuns(tenantDbName: string, tenantId: string): Promise<number> {
  return runWithTenantDb(tenantDbName, async (db) => {
    const cap = getConfig().agent.deferredMaxRunningPerTenant;
    const counts = await db.countAgentRunsByStatus(tenantId, { statuses: ['running'], runClass: 'deferred' });
    const slots = cap - (counts.running ?? 0);
    if (slots <= 0) return 0;
    const due = await db.listQueuedDeferredAgentRuns(tenantId, { limit: slots, dueBefore: new Date() });
    let published = 0;
    for (const run of due) {
      try {
        await publishAgentRunJob(run);
        published += 1;
      } catch (error) {
        logger.warn('Could not publish a deferred agent run', {
          runId: String(run._id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return published;
  });
}

// ── Continuing a paused turn in the background ───────────────────────────

/** The run owner of a continuation the timeout sweep starts — a synthetic actor, like the scheduler's. */
export const RESUME_TIMEOUT_ACTOR = 'system:agent-timeout';

/**
 * Marks a `resume` run that continues a session which stopped on its spend
 * budget rather than a pause: it carries no action ids to apply. Stored in the
 * run's `resumeActionIds`, so the queue, requeue and finalize paths that already
 * treat a run with `resumeActionIds` as a continuation need no new column.
 */
export const CONTINUE_RUN_MARKER = 'budget_continue';

export type QueueAgentRunResumeOutcome =
  | { kind: 'queued'; run: IAgentRun }
  | { kind: 'conflict' };

/**
 * Queues a run that continues a paused turn (every action it waited on is
 * answered). A paused run (queued or inline) is put back in the queue under
 * its own id, keeping its class, channel, labels, response format and inputs
 * (a new queue generation, so its job is not mistaken for the first one); a
 * turn that paused inside a dashboard call has no run, so a new `background`
 * one of the default class is created for it. `conflict` = another run holds
 * the conversation.
 *
 * Admission: a continuation is not refused by the class caps — it continues
 * work that was already admitted.
 */
export async function queueAgentRunResume(input: {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
  agentKey: string;
  conversationId: string;
  userId: string;
  resumeActionIds: string[];
  apiTokenId?: string;
  actorType?: IAgentRun['actorType'];
  /** Which config a budget continuation runs with (a pause's answers carry their own). */
  usePublished?: boolean;
  version?: number;
  runtimeContext?: AgentRuntimeContext;
  /** From `resolveAgentRunLimits`; resolved here (env ∧ tenant quota) when absent. */
  limits?: AgentRunLimits;
}): Promise<QueueAgentRunResumeOutcome> {
  const db = await withTenantDb(input.tenantDbName);
  const cfg = getConfig();
  let run: IAgentRun | null = null;
  try {
    const [paused] = await db.listAgentRuns({
      tenantId: input.tenantId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      status: ['requires_action'],
      mode: ['background', 'inline'],
      limit: 1,
    });
    if (paused) run = await db.requeueAgentRunForResume(String(paused._id), input.tenantId, input.resumeActionIds);
    if (!run) {
      const limits = input.limits ?? await resolveAgentRunLimits({
        quotaContext: {
          tenantDbName: input.tenantDbName,
          tenantId: input.tenantId,
          projectId: input.projectId,
          userId: input.userId,
          ...(input.apiTokenId ? { tokenId: input.apiTokenId } : {}),
        },
      });
      run = await db.createAgentRun({
        mode: 'background',
        tenantId: input.tenantId,
        tenantDbName: input.tenantDbName,
        projectId: input.projectId,
        agentKey: input.agentKey,
        conversationId: input.conversationId,
        // The turn continues from its stored state; there is no new message.
        userMessage: '',
        resumeActionIds: input.resumeActionIds,
        ...(input.usePublished !== undefined ? { usePublished: input.usePublished } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.runtimeContext ? { runtimeContext: sealRuntimeContext(input.runtimeContext) } : {}),
        status: 'queued',
        runClass: 'default',
        trigger: 'request',
        queueGeneration: 1,
        callbackAttempts: 0,
        maxDurationMs: limits.maxDurationMs,
        userId: input.userId,
        ...(input.apiTokenId ? { apiTokenId: input.apiTokenId } : {}),
        actorType: input.actorType ?? (input.userId.startsWith('system:') ? 'system' : 'user'),
        expiresAt: new Date(Date.now() + cfg.agent.runRetentionDays * 86_400_000),
      });
    }
  } catch (error) {
    if (error instanceof AgentRunConflictError) return { kind: 'conflict' };
    throw error;
  }
  if (run.runClass === 'deferred') {
    await dispatchDeferredRuns(input.tenantDbName, input.tenantId).catch(() => undefined);
  } else {
    await publishAgentRunJob(run);
  }
  return { kind: 'queued', run };
}

/**
 * Queues a background run that continues a session which stopped on its spend
 * budget (after the budget was raised). Same row, queue and worker as a resumed
 * pause; the run has no new user message and applies no answers.
 */
export async function queueAgentRunContinue(input: Omit<Parameters<typeof queueAgentRunResume>[0], 'resumeActionIds'>) {
  await assertQueuedTurnSpendAllowed(input);
  return queueAgentRunResume({ ...input, resumeActionIds: [CONTINUE_RUN_MARKER] });
}

/**
 * A continuation ran inline (the dashboard answered while a run was paused):
 * settle that run's row. Still waiting → it keeps `requires_action` with the
 * fresh actions; otherwise it ends `succeeded` like any finished run.
 */
export async function settlePausedAgentRuns(
  tenantDbName: string,
  scope: { tenantId: string; projectId: string; conversationId: string },
  response: AgentChatResponse,
): Promise<void> {
  const db = await withTenantDb(tenantDbName);
  const paused = await db.listAgentRuns({ ...scope, status: ['requires_action'], mode: ['background', 'inline'], limit: 5 });
  const { _conversation_messages: _omitted, ...body } = response;
  void _omitted;
  for (const run of paused) {
    const runId = String(run._id);
    const result = { ...body, id: `resp_${runId}` } as unknown as Record<string, unknown>;
    if (response.status === 'requires_action') {
      await db.finalizeAgentRun(runId, scope.tenantId, { status: 'requires_action', result, stopReason: 'requires_action' });
      continue;
    }
    const finalized = await db.finalizeAgentRun(runId, scope.tenantId, {
      status: 'succeeded',
      result,
      stopReason: toSessionStopReason(response.stop_reason),
      completedAt: new Date(),
      runtimeContext: null,
    });
    if (finalized) {
      await fireAgentRunCallback(finalized, 'succeeded', { result }).catch((error) => {
        logger.warn('Could not queue the run callback', { runId, error: error instanceof Error ? error.message : String(error) });
      });
    }
  }
}

/**
 * A paused run is cancelled: its open requests are cancelled and the conversation
 * is idle again — and the log and the webhook subscribers hear about it the way
 * they do when a new message cancels the requests (`action.resolved` per request,
 * then `session.status_idle`), so a consumer is not left believing the session
 * still waits.
 */
async function dropPausedConversation(db: DatabaseProvider, run: IAgentRun): Promise<void> {
  const runId = String(run._id);
  try {
    const conversation = await db.findAgentConversationById(run.conversationId);
    // Only a session that still waits on this pause is reset: one a newer message
    // has moved on (or that is idle already) is not this run's to touch.
    if (!conversation || conversation.runtimeStatus !== 'requires_action') return;

    const events: Array<{ type: SessionEventType; data: Record<string, unknown> }> = [];
    await cancelPendingForNewMessage(
      db,
      conversation,
      (type, data) => { events.push({ type, data: data ?? {} }); },
      'system:run_cancelled',
    ).catch((error) => {
      logger.warn('Could not cancel the open requests of a cancelled run', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    // The status goes in BEFORE the idle frame is published, so a follower that
    // reloads the session on it never reads 'requires_action'.
    await db.updateAgentConversationRuntime(run.conversationId, {
      runtimeStatus: 'idle',
      stopReason: 'cancelled',
      pendingActionIds: [],
    });
    const writer = createSessionEventWriter({
      db,
      tenantDbName: run.tenantDbName,
      tenantId: run.tenantId,
      projectId: run.projectId,
      agentKey: run.agentKey,
      conversationId: run.conversationId,
      runId,
    });
    for (const event of events) writer.emit(event.type, event.data);
    writer.emit('session.status_idle', { stopReason: 'cancelled' });
    await writer.close();
    await db.updateAgentConversationRuntime(run.conversationId, { lastEventSeq: writer.lastSeq() });
  } catch (error) {
    logger.warn('Could not reset the conversation of a cancelled paused run', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ── Status, listing, cancel ─────────────────────────────────────────────

export async function getAgentRunStatus(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  runId: string,
): Promise<IAgentRun | null> {
  const db = await withTenantDb(tenantDbName);
  return db.getAgentRunById(normalizeAgentRunId(runId), tenantId, projectId);
}

export async function listAgentRuns(
  tenantDbName: string,
  filter: Parameters<DatabaseProvider['listAgentRuns']>[0],
): Promise<IAgentRun[]> {
  const db = await withTenantDb(tenantDbName);
  return db.listAgentRuns(filter);
}

export type CancelAgentRunOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_terminal'; run: IAgentRun }
  | { kind: 'accepted'; run: IAgentRun };

/** @deprecated name kept for the routes not yet moved to `cancelAgentRun`. */
export type RequestAgentRunCancellationOutcome = CancelAgentRunOutcome;

/**
 * The canonical cancel (§4.7), behind every cancel route:
 *  - `scheduled` / `queued` → `canceled` now (nothing executes it yet);
 *  - `running` (inline or queued) → `cancelRequestedAt` is stamped and the
 *    executor stops at its next checkpoint (an inline turn on this node at
 *    once); the run comes back still `running`;
 *  - `requires_action` → `canceled`, its open requests cancelled and the
 *    conversation idle again;
 *  - anything else → `already_terminal`.
 * A dashboard reservation (`mode: 'sync'`) is not a run: `not_found`.
 */
export async function cancelAgentRun(ref: AgentRunRef): Promise<CancelAgentRunOutcome> {
  const runId = normalizeAgentRunId(ref.runId);
  const { tenantId, projectId } = ref;
  return runWithTenantDb(ref.tenantDbName, async (db) => {
    const owned = await db.getAgentRunById(runId, tenantId, projectId);
    if (!owned || owned.mode === 'sync') return { kind: 'not_found' };
    if (owned.status === 'requires_action') {
      // Paused for a person: nothing is executing, so cancelling settles the run
      // and drops the open requests.
      const cancelled = await db.finalizeAgentRun(runId, tenantId, {
        status: 'canceled',
        errorReason: 'canceled_by_caller',
        stopReason: 'cancelled',
        completedAt: new Date(),
        runtimeContext: null,
      });
      if (!cancelled) return { kind: 'already_terminal', run: owned };
      await dropPausedConversation(db, owned);
      await fireAgentRunCallback(cancelled, 'canceled', {}).catch((error) => {
        logger.warn('Could not queue the canceled callback', { runId, error: error instanceof Error ? error.message : String(error) });
      });
      return { kind: 'accepted', run: cancelled };
    }
    if (!isAgentRunActive(owned)) return { kind: 'already_terminal', run: owned };
    const result = await db.requestAgentRunCancel(runId, tenantId, projectId);
    if (!result) {
      const current = await db.getAgentRunById(runId, tenantId, projectId);
      return { kind: 'already_terminal', run: current ?? owned };
    }
    if (result.status === 'canceled') {
      await fireAgentRunCallback(result, 'canceled', {}).catch((error) => {
        logger.warn('Could not queue the canceled callback', { runId, error: error instanceof Error ? error.message : String(error) });
      });
    } else if (result.mode === 'inline') {
      // An inline turn on this node stops now, not on its next poll.
      abortLocalTurns(tenantId, result.conversationId);
    }
    return { kind: 'accepted', run: result };
  });
}

/** `cancelAgentRun` under its old name and argument list. */
export async function requestAgentRunCancellation(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  runIdInput: string,
): Promise<CancelAgentRunOutcome> {
  return cancelAgentRun({ tenantDbName, tenantId, projectId, runId: runIdInput });
}

function buildRequestFromRun(run: IAgentRun, cancellationCell: AgentRunCancellationCell): AgentChatRequest {
  return {
    tenantDbName: run.tenantDbName,
    tenantId: run.tenantId,
    projectId: run.projectId,
    agentKey: run.agentKey,
    conversationId: run.conversationId,
    userMessage: run.userMessage,
    ...(run.attachments?.length ? { attachments: run.attachments } : {}),
    userId: run.userId ?? '',
    version: run.version ?? undefined,
    usePublished: run.usePublished,
    runtimeContext: openSealed<AgentRuntimeContext>(run.runtimeContext?.sealed),
    ...(run.responseFormat ? { responseFormat: run.responseFormat } : {}),
    ...(run.inputs ? { inputs: run.inputs } : {}),
    cancellationCell,
    runId: String(run._id),
  };
}

/**
 * The submit-time checks, repeated when the worker picks the run up: a run
 * queued before its agent was disabled or its token revoked must not still
 * execute on the strength of a check that is no longer true.
 */
async function preconditionFailure(db: DatabaseProvider, run: IAgentRun): Promise<string | null> {
  const agent = await db.findAgentByKey(run.agentKey, run.projectId);
  if (!agent) return 'The agent no longer exists.';
  if (agent.status !== 'active') return 'The agent is not active.';
  if (run.apiTokenId) {
    const tokens = await db.listProjectApiTokens(run.tenantId, run.projectId).catch(() => null);
    if (tokens) {
      const token = tokens.find((t) => String(t._id) === run.apiTokenId);
      if (!token) return 'The API token that started this run was revoked.';
      if (token.expiresAt && new Date(token.expiresAt).getTime() < Date.now()) return 'The API token that started this run has expired.';
    }
  }
  return null;
}

const GENERIC_FAILURE_MESSAGE = 'The agent run failed. See the run trace for details.';

/** Run owners that are not user rows (agentScheduler, public A2A). */
function isSyntheticRunActor(userId: string): boolean {
  return userId.startsWith('system:') || userId === 'a2a-public';
}

/** Client-facing text for a failed run: classified errors keep their message, anything else is generic. */
function publicFailureMessage(error: unknown): string {
  const classified = classifyAgentRunError(error);
  const internal = classified.error.type === 'api_error' || classified.error.type === 'server_error' || classified.status >= 500;
  return internal ? GENERIC_FAILURE_MESSAGE : classified.error.message;
}

/**
 * §7 steps 3-8: claim, race against the run's ceiling, heartbeat (liveness)
 * + a separate tight cancel poll, finalize, notify. Every exit path stops the
 * timers and finalizes exactly once; an `invoke()` rejection is a finalized
 * `failed` run, never an escaped exception that leaves the row `running`.
 */
export async function runAgentJobLocal(payload: AgentRunJobPayload): Promise<void> {
  const { runId, tenantId, tenantDbName } = payload;
  let release: (() => void) | undefined;
  const settled = new Promise<void>((resolve) => { release = resolve; });
  try {
    await runAgentJobInTenant(payload, settled);
  } finally {
    activeLocalRuns.delete(runId);
    release?.();
  }
  void tenantId;
  void tenantDbName;
}

async function runAgentJobInTenant(payload: AgentRunJobPayload, settled: Promise<void>): Promise<void> {
  const { runId, tenantId, tenantDbName } = payload;
  return runWithTenantDb(tenantDbName, async (db) => {
    const cfg = getConfig();
    const workerId = getThisNodeName();
    const startedAt = new Date();

    // Deferred claim guard: the class's running cap holds even when two nodes
    // got a job each. Skipped = left queued; the dispatcher hands it out again.
    if (payload.runClass === 'deferred') {
      const counts = await db.countAgentRunsByStatus(tenantId, { statuses: ['running'], runClass: 'deferred' });
      if ((counts.running ?? 0) >= cfg.agent.deferredMaxRunningPerTenant) {
        logger.info('Deferred run cap reached; leaving the run queued', { runId });
        return;
      }
    }

    let claimed = await db.claimAgentRun(runId, tenantId, workerId, startedAt);
    if (!claimed) {
      logger.info('Agent run already claimed or not queued; skipping duplicate delivery', { runId });
      return;
    }
    // A paused inline turn continued by a worker has nobody waiting on it: from
    // here it is an async run (notifications follow it).
    if (claimed.mode === 'inline' && !claimed.detachedAt) {
      claimed = (await db.markAgentRunDetached(runId, tenantId, new Date()).catch(() => null)) ?? claimed;
    }
    const run = claimed;
    logger.info('Agent run started', { runId, agentKey: claimed.agentKey, conversationId: claimed.conversationId });
    const afterDeferred = () => {
      if (run.runClass !== 'deferred') return;
      // A slot of the class is free again.
      void dispatchDeferredRuns(tenantDbName, tenantId).catch((error) => {
        logger.warn('Deferred run dispatch failed', { runId, error: error instanceof Error ? error.message : String(error) });
      });
    };

    const finalize = async (
      status: 'succeeded' | 'failed' | 'canceled',
      data: Pick<IAgentRun, 'errorReason' | 'errorMessage' | 'result' | 'stopReason'>,
      callbackData: Record<string, unknown> = {},
    ) => {
      // A failed / canceled run says so; a succeeded one passes how its turn ended.
      const stopReason = data.stopReason
        ?? (status === 'failed' ? 'error' : status === 'canceled' ? 'cancelled' : undefined);
      // The sealed caller headers are only needed while the turn runs.
      const finalized = await db.finalizeAgentRun(runId, tenantId, {
        ...data,
        ...(stopReason ? { stopReason } : {}),
        status,
        completedAt: new Date(),
        runtimeContext: null,
        resumeActionIds: null,
      });
      // A continuation that died leaves the conversation marked as waiting;
      // its requests are answered, so there is nothing left to wait for.
      if (finalized && status !== 'succeeded' && claimed.resumeActionIds?.length) {
        await db.updateAgentConversationRuntime(claimed.conversationId, {
          runtimeStatus: 'idle',
          stopReason: status === 'canceled' ? 'cancelled' : 'error',
          pendingActionIds: [],
        }).catch(() => undefined);
      }
      if (finalized) {
        await fireAgentRunCallback(finalized, status, callbackData).catch((error) => {
          logger.warn('Could not queue the run callback', { runId, error: error instanceof Error ? error.message : String(error) });
        });
      }
      afterDeferred();
    };

    const blocked = await preconditionFailure(db, claimed).catch(() => null);
    if (blocked) {
      await finalize('failed', { errorReason: 'precondition_failed', errorMessage: blocked }, { errorReason: 'precondition_failed', message: blocked });
      return;
    }

    // A run queued by a user who has since been disabled must not execute on
    // that user's authority. Only 'disabled' blocks: 'missing' is expected for
    // synthetic actors (schedule actor, public A2A user) that have no user row;
    // those are skipped outright because a non-user id can make the lookup throw
    // on some providers. For a real user id an unreadable state fails closed.
    if (claimed.userId && !isSyntheticRunActor(claimed.userId)) {
      let ownerState: Awaited<ReturnType<typeof getUserAuthState>> | null = null;
      try {
        ownerState = await getUserAuthState(tenantDbName, tenantId, claimed.userId);
      } catch (error) {
        logger.warn('Could not verify agent run owner state; failing the run', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (ownerState === null) {
        const message = 'Run owner could not be verified';
        await finalize('failed', { errorReason: 'owner_unverifiable', errorMessage: message }, { errorReason: 'owner_unverifiable', message });
        return;
      }
      if (ownerState === 'disabled') {
        const message = 'Run owner is disabled';
        await finalize('failed', { errorReason: 'owner_disabled', errorMessage: message }, { errorReason: 'owner_disabled', message });
        return;
      }
    }

    const maxDurationMs = claimed.maxDurationMs && claimed.maxDurationMs > 0
      ? Math.min(claimed.maxDurationMs, cfg.agent.backgroundMaxDurationMs)
      : cfg.agent.backgroundMaxDurationMs;
    const deadlineAt = Date.now() + maxDurationMs;
    // deadlineAt makes the turn itself stop at the ceiling (SDK timeout +
    // no conversation write), not just the run record.
    const cancellationCell: AgentRunCancellationCell = { cancelled: false, deadlineAt };

    let resolveCancelObserved: (() => void) | undefined;
    // Set when the CALLER asked for the cancel (the poll saw `cancelRequestedAt`);
    // losing the row to the reconciler also trips the cell, but is not that.
    let cancelRequestedByCaller = false;
    const cancelObservedPromise = new Promise<typeof CANCEL_SENTINEL>((resolve) => {
      resolveCancelObserved = () => resolve(CANCEL_SENTINEL);
    });
    const markSuperseded = () => {
      if (cancellationCell.cancelled) return;
      cancellationCell.cancelled = true;
      resolveCancelObserved?.();
    };
    activeLocalRuns.set(runId, {
      runId,
      tenantId,
      tenantDbName,
      projectId: claimed.projectId,
      conversationId: claimed.conversationId,
      cell: cancellationCell,
      abort: markSuperseded,
      settled,
    });

    const heartbeatTimer = setInterval(() => {
      void db.updateAgentRunHeartbeat(runId, workerId, new Date())
        .then((updated) => {
          // Null = the row is no longer ours and running (the reconciler
          // failed it as worker_lost, or it was finalized elsewhere). Stop
          // the turn instead of letting it write a result nobody will record.
          if (!updated) {
            logger.warn('Agent run is no longer owned by this worker; stopping the turn', { runId });
            markSuperseded();
          }
        })
        .catch((error) => {
          logger.warn('Agent run heartbeat update failed', {
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, cfg.agent.runHeartbeatIntervalMs);
    heartbeatTimer.unref?.();

    const cancelPollTimer = setInterval(() => {
      void (async () => {
        try {
          const current = await db.getAgentRunById(runId, tenantId, claimed.projectId);
          if (current?.cancelRequestedAt && !cancellationCell.cancelled) {
            logger.info('Cancel request observed; stopping the turn', { runId });
            cancelRequestedByCaller = true;
            markSuperseded();
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

    const deadlineTimer = delaySentinel(deadlineAt - Date.now(), TIMEOUT_SENTINEL);
    const stopAllTimers = () => {
      clearInterval(heartbeatTimer);
      clearInterval(cancelPollTimer);
      deadlineTimer.clear();
    };

    try {
      const request = buildRequestFromRun(claimed, cancellationCell);
      // The tokens the turn's model calls spend are tallied as they happen, so a run that
      // fails, times out or is cancelled is still charged for them (runUsage.ts).
      const usage = createRunUsageSink();
      const quotaCaller = {
        tenantDbName: claimed.tenantDbName,
        tenantId: claimed.tenantId,
        projectId: claimed.projectId,
        agentKey: claimed.agentKey,
        userId: claimed.userId,
        tokenId: claimed.apiTokenId,
      };
      // Attribution: usage recorded by the turn reads the request context,
      // which a queue worker otherwise has none of. A rejection settles as a
      // value, so the race can finalize it instead of throwing past the timers.
      const resuming = Boolean(claimed.resumeActionIds?.length);
      const continuingBudget = claimed.resumeActionIds?.includes(CONTINUE_RUN_MARKER) === true;
      const invokePromise = runWithUsageSink(usage, () => runWithRequestContext(
        {
          tenantId: claimed.tenantId,
          projectId: claimed.projectId,
          userId: claimed.userId,
          apiTokenId: claimed.apiTokenId,
          actorType: claimed.actorType ?? 'api_token',
          source: 'api',
        },
        // A run queued to continue a paused turn picks that turn up where it
        // stopped; everything around it (heartbeat, ceiling, cancel, finalize,
        // callback) is the same.
        () => continuingBudget
          ? executeAgentContinueLocal({
            tenantDbName: request.tenantDbName,
            tenantId: request.tenantId,
            projectId: request.projectId,
            agentKey: request.agentKey,
            conversationId: request.conversationId,
            userId: request.userId,
            runId,
            runtimeContext: request.runtimeContext,
            ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
            ...(request.inputs ? { inputs: request.inputs } : {}),
            ...(request.inputsAsPromptVariables === false ? { inputsAsPromptVariables: false } : {}),
            cancellationCell,
            continuation: {
              source: 'agent',
              ...(request.usePublished !== undefined ? { usePublished: request.usePublished } : {}),
              ...(request.version !== undefined ? { version: request.version } : {}),
            },
          }).then((continued) => continued.response)
          : resuming
          ? executeAgentResumeLocal({
            tenantDbName: request.tenantDbName,
            tenantId: request.tenantId,
            projectId: request.projectId,
            agentKey: request.agentKey,
            conversationId: request.conversationId,
            userId: request.userId,
            trigger: request.userId === RESUME_TIMEOUT_ACTOR ? 'timeout' : 'resume',
            runId,
            runtimeContext: request.runtimeContext,
            ...(request.responseFormat ? { responseFormat: request.responseFormat } : {}),
            ...(request.inputs ? { inputs: request.inputs } : {}),
            ...(request.inputsAsPromptVariables === false ? { inputsAsPromptVariables: false } : {}),
            cancellationCell,
          }).then((resumed) => resumed.response)
          : executeAgentChatLocal(request),
      )).then(
        (response) => ({ ok: true as const, response }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const raced = await Promise.race([invokePromise, deadlineTimer.promise, cancelObservedPromise]);

      if (raced === CANCEL_SENTINEL || (cancellationCell.cancelled && raced !== TIMEOUT_SENTINEL)) {
        // The cancel cannot interrupt a tool or model call already in flight
        // (§12.2): the turn keeps going until its next checkpoint, and its tail
        // still writes — its events, the session's runtime fields, its spend.
        // The conversation stays reserved until that tail has landed: this row
        // keeps the slot (the heartbeat keeps running, so the reconciler leaves it
        // alone) and a message sent meanwhile gets the usual conflict instead of
        // starting a second turn the old one then writes over. The run's own
        // ceiling bounds the wait, so a hung call cannot hold the slot for good.
        if (cancelRequestedByCaller) {
          clearInterval(cancelPollTimer);
          const waited = await Promise.race([invokePromise.then(() => TURN_SETTLED), deadlineTimer.promise]);
          // The ceiling won: the slot is given up with the turn still hanging.
          if (waited !== TURN_SETTLED) cancellationCell.abandoned = true;
        }
        stopAllTimers();
        // What the turn's model calls spent counts, including the tail that
        // landed while the slot was held.
        settleAgentRun(quotaCaller, usage);
        await finalize('canceled', { errorReason: 'canceled_by_caller' });
        return;
      }
      stopAllTimers();

      if (raced === TIMEOUT_SENTINEL) {
        settleAgentRun(quotaCaller, usage);
        cancellationCell.cancelled = true;
        // Finalized without waiting: the turn may still be inside a call and must not
        // write over whatever starts on the freed conversation.
        cancellationCell.abandoned = true;
        const minutes = Math.round(maxDurationMs / 60_000);
        await finalize('failed', {
          errorReason: 'max_duration_exceeded',
          errorMessage: `The run exceeded its ${minutes}-minute limit and was stopped.`,
        }, { errorReason: 'max_duration_exceeded' });
        return;
      }

      if (!raced.ok) {
        settleAgentRun(quotaCaller, usage);
        logger.warn('Background agent turn failed', {
          runId,
          error: raced.error instanceof Error ? raced.error.message : String(raced.error),
        });
        const message = publicFailureMessage(raced.error);
        await finalize('failed', { errorReason: 'agent_error', errorMessage: message }, { errorReason: 'agent_error', message });
        return;
      }

      settleAgentRun(quotaCaller, usage, raced.response.usage?.total_tokens);

      const { _conversation_messages: _omitted, ...responseWithoutTranscript } = raced.response;
      const responseWithRunId: AgentChatResponse = { ...responseWithoutTranscript, id: `resp_${runId}` };
      if (responseWithRunId.status === 'requires_action') {
        // Paused for a person: not terminal. The run waits as `requires_action`
        // (the conversation's slot is free) until the actions are resolved.
        const paused = await db.finalizeAgentRun(runId, tenantId, {
          status: 'requires_action',
          result: responseWithRunId as unknown as Record<string, unknown>,
          stopReason: 'requires_action',
          resumeActionIds: null,
        });
        if (paused) {
          await fireAgentRunCallback(paused, 'requires_action', { result: responseWithRunId }).catch((error) => {
            logger.warn('Could not queue the run callback', { runId, error: error instanceof Error ? error.message : String(error) });
          });
        }
        afterDeferred();
        return;
      }
      await finalize('succeeded', {
        result: responseWithRunId as unknown as Record<string, unknown>,
        stopReason: toSessionStopReason(responseWithRunId.stop_reason),
      }, { result: responseWithRunId });
    } catch (error) {
      stopAllTimers();
      logger.error('Agent run worker failed unexpectedly', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
      await finalize('failed', { errorReason: 'agent_error', errorMessage: GENERIC_FAILURE_MESSAGE }, { errorReason: 'agent_error' })
        .catch(() => undefined);
    }
  });
}

// ── §7 step 8 / §12.6: callback notify — durable, queue-driven retry ──

const CALLBACK_JOB_NAME = 'callback';
/** Exponential backoff (2s, 4s, 8s, 16s, 32s) via the queue's own `attempts`/`backoff`. */
const CALLBACK_ATTEMPTS = 5;
const CALLBACK_BACKOFF_MS = 2_000;
const CALLBACK_TIMEOUT_MS = 10_000;

interface AgentRunCallbackJobPayload extends QueuePayload {
  runId: string;
  tenantId: string;
  tenantDbName: string;
  projectId: string;
  conversationId: string;
  callbackUrl: string;
  event: 'succeeded' | 'failed' | 'canceled' | 'requires_action';
  data: Record<string, unknown>;
}

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` — the crawler/OCR webhook scheme (shared with webhook subscriptions). */
export function signAgentRunCallback(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return signWebhookBody(secret, body, timestamp);
}

type AgentRunCallbackEvent = AgentRunCallbackJobPayload['event'];

export async function fireAgentRunCallback(
  run: IAgentRun,
  event: AgentRunCallbackEvent,
  data: Record<string, unknown>,
): Promise<void> {
  // Only runs nobody waits on notify (§4.2.6): a turn answered inline emits none.
  if (!isAsyncAgentRun(run)) return;
  // Webhook subscriptions hear about every transition of an async run, whether
  // or not the run carries a callback of its own. Ids and small fields only.
  // Never throws.
  await publishWebhookEvent({
    tenantDbName: run.tenantDbName,
    tenantId: run.tenantId,
    projectId: run.projectId,
    type: `agent_run.${event}`,
    data: {
      runId: publicAgentRunId(run),
      sessionId: run.conversationId,
      conversationId: run.conversationId,
      agentKey: run.agentKey,
      status: run.status,
      class: run.runClass ?? 'default',
      metadata: run.metadata ?? {},
      routineId: run.routineId ?? null,
    },
  });
  if (!run.callbackUrl) return;
  // A new event starts a new count: a run that was `requires_action` (callback
  // delivered) and later finishes owes a fresh `succeeded` callback, and the
  // reconciler keys off `pending` / `failed` to find callbacks that never made it.
  await runWithTenantDb(run.tenantDbName, (db) => db.updateAgentRunCallback(String(run._id), run.tenantId, {
    callbackStatus: 'pending',
    callbackAttempts: 0,
  })).catch(() => undefined);
  await enqueueAgentRunCallback(run, event, data, { attempts: CALLBACK_ATTEMPTS, backoffMs: CALLBACK_BACKOFF_MS });
}

async function enqueueAgentRunCallback(
  run: IAgentRun,
  event: AgentRunCallbackEvent,
  data: Record<string, unknown>,
  options: { attempts: number; backoffMs?: number },
): Promise<void> {
  const queue = await getQueue();
  const payload: AgentRunCallbackJobPayload = {
    runId: String(run._id),
    tenantId: run.tenantId,
    tenantDbName: run.tenantDbName,
    projectId: run.projectId,
    conversationId: run.conversationId,
    callbackUrl: run.callbackUrl!,
    event,
    data,
  };
  await queue.publish(AGENT_RUN_CALLBACK_QUEUE, CALLBACK_JOB_NAME, payload, options);
}

/** Callbacks are sent at most this many times per event before the reconciler stops trying. */
export const AGENT_RUN_CALLBACK_MAX_ATTEMPTS = CALLBACK_ATTEMPTS;

/**
 * Queues one more delivery of a callback that never settled (the queue lost
 * the job, or it ran out of retries early). The event and its data are
 * rebuilt from the run row — the receiver sees the same stable event id as
 * the first try. One attempt per call: the reconciler's tick is the retry cadence.
 */
export async function redeliverAgentRunCallback(run: IAgentRun): Promise<boolean> {
  if (!run.callbackUrl || !isAsyncAgentRun(run)) return false;
  const event: AgentRunCallbackEvent | null = run.status === 'succeeded' ? 'succeeded'
    : run.status === 'failed' ? 'failed'
      : run.status === 'canceled' ? 'canceled'
        : run.status === 'requires_action' ? 'requires_action'
          : null;
  if (!event) return false;
  const data: Record<string, unknown> = event === 'succeeded' || event === 'requires_action'
    ? { result: run.result ?? null }
    : event === 'failed'
      ? { errorReason: run.errorReason ?? 'agent_error', ...(run.errorMessage ? { message: run.errorMessage } : {}) }
      : {};
  // Touch the row first, so the next tick does not queue it again while this one is in flight.
  await runWithTenantDb(run.tenantDbName, (db) => db.updateAgentRunCallback(String(run._id), run.tenantId, {
    callbackStatus: run.callbackStatus === 'failed' ? 'failed' : 'pending',
    callbackAttempts: run.callbackAttempts ?? 0,
  })).catch(() => undefined);
  await enqueueAgentRunCallback(run, event, data, { attempts: 1 });
  return true;
}

/**
 * The callback job handler. Delivers through `safeFetch` (DNS-resolved,
 * pinned, every redirect hop re-checked — a callback URL is caller-supplied
 * and must never reach an internal service), signs with the run's secret
 * when it has one, and throws on failure so the queue retries.
 */
export async function deliverAgentRunCallbackJob(
  payload: AgentRunCallbackJobPayload,
): Promise<void> {
  return runWithTenantDb(payload.tenantDbName, async (db) => {
    const current = await db.getAgentRunById(payload.runId, payload.tenantId, payload.projectId);
    const nextAttempts = (current?.callbackAttempts ?? 0) + 1;
    const publicRunId = `run_${payload.runId}`;
    const eventName = `agent_run.${payload.event}`;
    // Stable per run+event, so a receiver can dedupe retries and queue redeliveries.
    const eventId = `evt_${payload.runId}_${payload.event}`;

    const body = JSON.stringify({
      id: eventId,
      event: eventName,
      createdAt: new Date().toISOString(),
      runId: publicRunId,
      sessionId: payload.conversationId,
      conversationId: payload.conversationId,
      data: payload.data,
    });
    const result = await sendSignedWebhook({
      url: payload.callbackUrl,
      body,
      eventName,
      eventId,
      userAgent: 'cognipeer-agent-runs/1.0',
      secret: openSealed<string>(current?.callbackSecret),
      timeoutMs: CALLBACK_TIMEOUT_MS,
    });
    let deliveryError: Error | undefined;
    if (!result.ok) {
      deliveryError = new Error(result.statusCode !== undefined
        ? `Callback endpoint answered HTTP ${result.statusCode}`
        : result.error ?? `Agent-run webhook delivery failed for run ${payload.runId}`);
      logger.warn('Agent-run webhook delivery attempt failed', {
        runId: payload.runId,
        event: payload.event,
        attempt: nextAttempts,
        error: result.error,
      });
    }

    // Callback bookkeeping only — not `finalizeAgentRun`, whose `running` CAS
    // would no-op on a run that already finished.
    await db.updateAgentRunCallback(payload.runId, payload.tenantId, {
      callbackStatus: deliveryError ? 'failed' : 'delivered',
      callbackAttempts: nextAttempts,
    }).catch(() => undefined);

    if (deliveryError) throw deliveryError;
  });
}

/** The job dedup key of a run's current execution: a republish of the same generation is a no-op. */
export function agentRunJobDedupKey(run: Pick<IAgentRun, '_id' | 'queueGeneration'>): string {
  return `ar_${String(run._id)}_${run.queueGeneration ?? 1}`;
}

/**
 * Queues a run's job — at submit, from the deferred dispatcher, and again from
 * the reconciler for a queued run no worker picked up. Deferred runs go to
 * their own queue.
 */
export async function publishAgentRunJob(run: IAgentRun): Promise<void> {
  const queue = await getQueue();
  const deferred = run.runClass === 'deferred';
  // A run queued to continue a paused turn is a `resume` job; the worker
  // dispatches on the row either way, so a requeue by the reconciler stays right.
  await queue.publish(deferred ? AGENT_RUN_DEFERRED_QUEUE : AGENT_RUN_QUEUE, run.resumeActionIds?.length ? 'resume' : 'run', {
    runId: String(run._id),
    tenantId: run.tenantId,
    tenantDbName: run.tenantDbName,
    ...(deferred ? { runClass: 'deferred' as const } : {}),
  } satisfies AgentRunJobPayload, {
    attempts: 1,
    // A deferred job the claim guard skipped has completed, and BullMQ keeps a
    // completed job id for an hour: a per-minute suffix lets the dispatcher hand
    // the row out again soon (a duplicate delivery no-ops at the claim CAS).
    dedupKey: deferred ? `${agentRunJobDedupKey(run)}_${Math.floor(Date.now() / 60_000)}` : agentRunJobDedupKey(run),
  });
  await runWithTenantDb(run.tenantDbName, (db) => db.markAgentRunPublished(String(run._id), run.tenantId, new Date()))
    .catch(() => undefined);
}

// ── §4.8: drain on shutdown ──────────────────────────────────────────────

export const INTERRUPTED_RUN_MESSAGE = 'The server restarted while this run was in progress. It was not completed; retry it.';

/**
 * Shutdown drain for the runs executing in this process (inline turns and
 * queue workers): waits up to `timeoutMs` for them to settle, then fails the
 * rest as `interrupted` (with their notifications) and trips their
 * cancellation cells so a late tail writes nothing. Not retried automatically:
 * a half-done turn may have had side effects. Queued rows are untouched (the
 * next boot's reconciler republishes them). The caller pauses the consumers
 * first so no new run starts meanwhile.
 */
export async function drainLocalAgentRuns(timeoutMs: number): Promise<{ settled: number; interrupted: number }> {
  const initial = [...activeLocalRuns.values()];
  if (initial.length === 0) return { settled: 0, interrupted: 0 };
  const timer = delaySentinel(timeoutMs, TIMEOUT_SENTINEL);
  try {
    await Promise.race([Promise.allSettled(initial.map((run) => run.settled)), timer.promise]);
  } finally {
    timer.clear();
  }
  const leftovers = [...activeLocalRuns.values()];
  let interrupted = 0;
  for (const local of leftovers) {
    try {
      const finalized = await runWithTenantDb(local.tenantDbName, (db) => db.finalizeAgentRun(local.runId, local.tenantId, {
        status: 'failed',
        errorReason: 'interrupted',
        errorMessage: INTERRUPTED_RUN_MESSAGE,
        stopReason: 'error',
        completedAt: new Date(),
        runtimeContext: null,
      }));
      if (finalized) {
        interrupted += 1;
        await fireAgentRunCallback(finalized, 'failed', { errorReason: 'interrupted', message: INTERRUPTED_RUN_MESSAGE }).catch(() => undefined);
      }
    } catch (error) {
      logger.warn('Could not mark an interrupted agent run', {
        runId: local.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Abandoned: the row is final; whatever the turn still does must not land.
    local.cell.cancelled = true;
    local.cell.abandoned = true;
    local.abort();
  }
  const result = { settled: initial.length - leftovers.length, interrupted };
  logger.info('Agent runs drained for shutdown', { ...result, timeoutMs });
  return result;
}

/** A sync reservation this old is abandoned, not live — see `SYNC_RESERVATION_GRACE_MS`. */
export function isAbandonedSyncReservation(run: IAgentRun, now = Date.now()): boolean {
  if (run.mode !== 'sync') return false;
  const started = run.startedAt ? new Date(run.startedAt).getTime() : 0;
  return now - started > getConfig().agent.syncTimeoutMs + SYNC_RESERVATION_GRACE_MS;
}
