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
 * Limits resolve as min(env ceiling, tenant quota, agent `execution`
 * setting) — `resolveAgentExecutionLimits` — once, at submit time; a
 * background run carries its resolved ceiling on the row (`maxDurationMs`).
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
import type { IAgentConfig, IAgentRun } from '@/lib/database';
import { getQueue, type QueuePayload } from '@/lib/core/queue';
import { getThisNodeName } from '@/lib/core/cluster/nodeRegistry';
import { runWithRequestContext } from '@/lib/core/requestContext';
import { assertPublicUrl, safeFetch } from '@/lib/security/outboundFetch';
import { decryptObject, encryptObject } from '@/lib/utils/crypto';
import { resolveEffectiveLimits, type QuotaContext } from '@/lib/quota/quotaGuard';
import { classifyAgentRunError } from './agentErrors';
import { openAgentCallbackSecret } from './agentSandboxSecrets';
import {
  executeAgentChat,
  executeAgentChatLocal,
  type AgentChatRequest,
  type AgentChatResponse,
  type AgentRunCancellationCell,
} from './agentService';
import type { AgentRuntimeContext } from '@/lib/services/runtimeContext';

const logger = createLogger('agent-run');

/**
 * Background runs (and their callbacks) get a queue of their own, with its
 * own per-node concurrency (`AGENT_RUN_CONCURRENCY`) — sharing `cluster.agent`
 * let four 30-minute runs block every routed chat turn on the node.
 */
export const AGENT_RUN_QUEUE = 'agent-runs';

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

/**
 * An `AgentRun` as the client API (§8 status shape) and the dashboard return
 * it — never the sealed callback secret or the caller's runtime headers.
 */
export function serializeAgentRun(run: IAgentRun) {
  const toEpochSeconds = (value: Date | string | null | undefined) =>
    (value ? Math.floor(new Date(value).getTime() / 1000) : null);
  return {
    id: publicAgentRunId(run),
    object: 'agent.run' as const,
    status: run.status,
    agent: run.agentKey,
    conversation_id: run.conversationId,
    result: run.status === 'succeeded' ? run.result ?? null : null,
    error: run.status === 'failed' || run.status === 'canceled'
      ? { type: run.errorReason ?? 'agent_error', message: run.errorMessage ?? null }
      : null,
    created_at: toEpochSeconds(run.createdAt),
    started_at: toEpochSeconds(run.startedAt),
    completed_at: toEpochSeconds(run.completedAt),
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

export function agentSyncTimeoutErrorBody() {
  return apiErrorBody(
    'timeout',
    'The agent turn exceeded the synchronous timeout and was terminated. '
      + 'Side effects from tool calls already in flight may have occurred; this request was not retried automatically.',
    'timeout',
    { side_effects_possible: true, retryable: false },
  );
}

export function idempotencyKeyRequiresBackgroundErrorBody() {
  return invalidRequestErrorBody(
    'Idempotency-Key requires background: true. Synchronous mode persists no record to key a retry against.',
    'idempotency_key_sync_not_supported',
  );
}

/** §12.15 — distinct from `agent_run_conflict` so a caller can tell the two 409s apart. */
export function idempotencyKeyConflictErrorBody() {
  return apiErrorBody(
    'idempotency_key_conflict',
    'This Idempotency-Key was already used with a different request (agentKey, conversationId, userMessage, or version).',
  );
}

export function agentRunConcurrencyLimitErrorBody(limit: number, scope: 'tenant' | 'project' = 'tenant') {
  return apiErrorBody(
    'rate_limit_error',
    `This ${scope} already has ${limit} background agent run(s) queued or running, the configured limit.`,
    'agent_run_concurrency_limit',
  );
}

export function backgroundDisabledErrorBody() {
  return invalidRequestErrorBody('Background execution is disabled for this agent.', 'agent_background_disabled');
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
 * client that sets `background: true` behaves the same. `defaultMode` is the
 * agent's own choice for a call that says neither — an explicit
 * `background: false` still wins over it.
 */
export function isBackgroundModeRequested(
  headerValue: string | null | undefined,
  body: Record<string, unknown> | undefined,
  defaultMode: 'sync' | 'background' = 'sync',
): boolean {
  if (typeof headerValue === 'string') {
    const value = headerValue.trim();
    if (/^true$/i.test(value)) return true;
    if (/^false$/i.test(value)) return false;
  }
  if (body?.background === true) return true;
  if (body?.background === false) return false;
  return defaultMode === 'background';
}

// ── Effective limits ────────────────────────────────────────────────────

export interface EffectiveAgentExecutionLimits {
  syncTimeoutMs: number;
  backgroundEnabled: boolean;
  backgroundMaxDurationMs: number;
  defaultMode: 'sync' | 'background';
  /** 0 = no cap. */
  maxConcurrentRunsPerTenant: number;
  maxConcurrentRunsPerProject: number;
}

function positiveMin(...values: Array<number | undefined | null>): number | undefined {
  const usable = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return usable.length > 0 ? Math.min(...usable) : undefined;
}

/**
 * min(env ceiling, tenant quota, agent setting) for every execution knob.
 * The env value is the hard ceiling nothing can raise; a quota or agent
 * setting of 0/unset means "no tighter bound here".
 */
export async function resolveAgentExecutionLimits(input: {
  agentConfig?: IAgentConfig | null;
  quotaContext?: Omit<QuotaContext, 'domain'> | null;
}): Promise<EffectiveAgentExecutionLimits> {
  const env = getConfig().agent;
  let quotas: { maxAgentSyncTimeoutSeconds?: number; maxAgentBackgroundDurationMinutes?: number; maxConcurrentAgentRuns?: number } = {};
  if (input.quotaContext) {
    try {
      const limits = await resolveEffectiveLimits({ ...input.quotaContext, domain: 'global' });
      quotas = limits.quotas ?? {};
    } catch (error) {
      logger.warn('Could not resolve tenant quota for agent execution limits; using env ceilings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const execution = input.agentConfig?.execution;
  const secondsToMs = (s?: number) => (typeof s === 'number' ? s * 1000 : undefined);
  const minutesToMs = (m?: number) => (typeof m === 'number' ? m * 60_000 : undefined);
  return {
    syncTimeoutMs: positiveMin(env.syncTimeoutMs, secondsToMs(quotas.maxAgentSyncTimeoutSeconds), secondsToMs(execution?.syncTimeoutSeconds))
      ?? env.syncTimeoutMs,
    backgroundEnabled: execution?.backgroundEnabled !== false,
    backgroundMaxDurationMs: positiveMin(
      env.backgroundMaxDurationMs,
      minutesToMs(quotas.maxAgentBackgroundDurationMinutes),
      minutesToMs(execution?.backgroundMaxDurationMinutes),
    ) ?? env.backgroundMaxDurationMs,
    defaultMode: execution?.defaultMode === 'background' && execution?.backgroundEnabled !== false ? 'background' : 'sync',
    maxConcurrentRunsPerTenant: positiveMin(env.backgroundMaxConcurrentRunsPerTenant, quotas.maxConcurrentAgentRuns) ?? 0,
    maxConcurrentRunsPerProject: env.backgroundMaxConcurrentRunsPerProject,
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

/** The agent's own default callback (Build → Execution), with its sealed secret opened. */
export function agentDefaultCallback(agentConfig?: IAgentConfig | null): { url?: string; secret?: string } {
  const execution = agentConfig?.execution;
  if (!execution?.callbackUrl) return {};
  return { url: execution.callbackUrl, secret: openAgentCallbackSecret(execution) };
}

// ── §5: synchronous ceiling + conversation reservation ──────────────────

export type SyncRunOutcome =
  | { kind: 'ok'; response: AgentChatResponse }
  | { kind: 'conflict' }
  | { kind: 'timeout' };

export interface RunSyncAgentTurnInput {
  request: AgentChatRequest;
  /** Effective ceiling (`resolveAgentExecutionLimits`); defaults to the env value. */
  syncTimeoutMs?: number;
}

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
 * conversation outside the /responses ceiling (OpenAI bridge, A2A,
 * Assistants): without the slot those turns could overlap a background run on
 * the same conversation and one would overwrite the other's history.
 */
export async function executeAgentChatExclusive(request: AgentChatRequest): Promise<AgentChatResponse> {
  const reservation = await reserveConversationForSyncTurn(await getDatabase(), request);
  if (!reservation) throw new AgentRunConflictError(request.conversationId);
  try {
    return await executeAgentChat(request);
  } finally {
    await reservation.release();
  }
}

/**
 * Runs a turn inline with a hard wall-clock ceiling (§5).
 *
 * - Reserves the conversation first (§12.14).
 * - Races the turn against the deadline (§12.13). When the deadline wins the
 *   caller gets 504 at once, but the reservation is held until the abandoned
 *   turn actually settles: freeing it earlier let the next request start a
 *   turn on the same conversation while the old one's tools were still
 *   running. The cancellation cell (deadlineAt) keeps the late result from
 *   being persisted and aborts the SDK loop at its next step.
 */
export async function runSyncAgentTurn(input: RunSyncAgentTurnInput): Promise<SyncRunOutcome> {
  const { request } = input;
  return runWithTenantDb(request.tenantDbName, async (db) => {
    const deadlineAt = Date.now() + (input.syncTimeoutMs ?? getConfig().agent.syncTimeoutMs);

    const reservation = await reserveConversationForSyncTurn(db, request);
    if (!reservation) return { kind: 'conflict' };

    const cancellationCell: AgentRunCancellationCell = { deadlineAt, cancelled: false };
    const invokePromise = executeAgentChat({ ...request, cancellationCell });
    const settled = invokePromise.then(() => undefined, (error) => {
      logger.warn('Synchronous agent turn failed or was abandoned after its ceiling', {
        conversationId: request.conversationId,
        agentKey: request.agentKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const timer = delaySentinel(deadlineAt - Date.now(), TIMEOUT_SENTINEL);
    try {
      const raced: AgentChatResponse | typeof TIMEOUT_SENTINEL = await Promise.race([invokePromise, timer.promise]);
      if (raced === TIMEOUT_SENTINEL) {
        cancellationCell.cancelled = true;
        // Released when the abandoned turn really stops — see the doc above.
        void settled.finally(() => reservation.release());
        return { kind: 'timeout' };
      }
      await reservation.release();
      return { kind: 'ok', response: raced };
    } catch (error) {
      await reservation.release();
      throw error;
    } finally {
      timer.clear();
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
  /** Plaintext; sealed before it is stored. */
  callbackSecret?: string;
  /** §9/§12.15 — background-mode-only; a caller-supplied `Idempotency-Key` header. */
  idempotencyKey?: string;
  /**
   * The conversationId folded into the idempotency hash, or `null` when the
   * run starts a brand-new conversation (a fresh id per attempt would make a
   * retry never match itself).
   */
  idempotencyConversationScope?: string | null;
  /** From `resolveAgentExecutionLimits`; default = env. */
  limits?: Pick<EffectiveAgentExecutionLimits, 'backgroundMaxDurationMs' | 'maxConcurrentRunsPerTenant' | 'maxConcurrentRunsPerProject'>;
}

export type CreateBackgroundAgentRunOutcome =
  | { kind: 'created'; run: IAgentRun }
  | { kind: 'idempotent_replay'; run: IAgentRun }
  | { kind: 'idempotency_conflict' }
  | { kind: 'conflict' }
  | { kind: 'concurrency_limit'; limit: number; scope: 'tenant' | 'project' };

/** Queue job payload for a background run — the worker loads everything else off the AgentRun row. */
interface AgentRunJobPayload extends QueuePayload {
  runId: string;
  tenantId: string;
  tenantDbName: string;
}

function idempotencyRequestHash(
  input: Pick<CreateBackgroundAgentRunInput, 'agentKey' | 'userMessage' | 'version' | 'idempotencyConversationScope'>,
): string {
  const material = JSON.stringify({
    agentKey: input.agentKey,
    conversationScope: input.idempotencyConversationScope ?? null,
    userMessage: input.userMessage,
    version: input.version ?? null,
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
  version?: number;
  idempotencyKey: string;
  idempotencyConversationScope: string | null;
}): Promise<{ kind: 'replay'; run: IAgentRun } | { kind: 'conflict' } | { kind: 'none' }> {
  const db = await withTenantDb(input.tenantDbName);
  const existing = await db.getAgentRunByIdempotencyKey(input.tenantId, input.projectId, input.idempotencyKey);
  if (!existing) return { kind: 'none' };
  return existing.idempotencyRequestHash === idempotencyRequestHash(input) ? { kind: 'replay', run: existing } : { kind: 'conflict' };
}

/**
 * Creates the `AgentRun` (atomic, §12.14) and queues it.
 *
 * Order: idempotency (a replay must never be newly rejected by the other
 * checks) → the insert itself (conversation lock + unique idempotency key) →
 * concurrency caps, checked AFTER the insert against the real count so a
 * burst of parallel requests cannot all pass a read-then-write check; the
 * row that tips a cap over is deleted again and reported as 429.
 */
export async function createBackgroundAgentRun(
  input: CreateBackgroundAgentRunInput,
): Promise<CreateBackgroundAgentRunOutcome> {
  const db = await withTenantDb(input.tenantDbName);
  const cfg = getConfig();
  const limits = input.limits ?? {
    backgroundMaxDurationMs: cfg.agent.backgroundMaxDurationMs,
    maxConcurrentRunsPerTenant: cfg.agent.backgroundMaxConcurrentRunsPerTenant,
    maxConcurrentRunsPerProject: cfg.agent.backgroundMaxConcurrentRunsPerProject,
  };
  const requestHash = idempotencyRequestHash(input);

  const resolveIdempotencyClash = async (): Promise<CreateBackgroundAgentRunOutcome> => {
    const existing = input.idempotencyKey
      ? await db.getAgentRunByIdempotencyKey(input.tenantId, input.projectId, input.idempotencyKey)
      : null;
    if (existing && existing.idempotencyRequestHash === requestHash) return { kind: 'idempotent_replay', run: existing };
    return { kind: 'idempotency_conflict' };
  };

  if (input.idempotencyKey) {
    const existing = await db.getAgentRunByIdempotencyKey(input.tenantId, input.projectId, input.idempotencyKey);
    if (existing) return resolveIdempotencyClash();
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
      runtimeContext: sealRuntimeContext(input.runtimeContext),
      status: 'queued',
      idempotencyKey: input.idempotencyKey ?? null,
      idempotencyRequestHash: input.idempotencyKey ? requestHash : null,
      callbackUrl: input.callbackUrl ?? null,
      callbackSecret: input.callbackSecret ? encryptObject(input.callbackSecret) : null,
      callbackStatus: input.callbackUrl ? 'pending' : null,
      callbackAttempts: 0,
      maxDurationMs: limits.backgroundMaxDurationMs,
      userId: input.userId,
      apiTokenId: input.apiTokenId,
      actorType: 'api_token',
      expiresAt,
    });
  } catch (error) {
    if (error instanceof AgentRunIdempotencyKeyTakenError) return resolveIdempotencyClash();
    if (error instanceof AgentRunConflictError) return { kind: 'conflict' };
    throw error;
  }

  const overCap = async (): Promise<{ limit: number; scope: 'tenant' | 'project' } | null> => {
    if (limits.maxConcurrentRunsPerTenant > 0) {
      const active = await db.countActiveAgentRuns(input.tenantId, undefined, 'background');
      if (active > limits.maxConcurrentRunsPerTenant) return { limit: limits.maxConcurrentRunsPerTenant, scope: 'tenant' };
    }
    if (limits.maxConcurrentRunsPerProject > 0) {
      const active = await db.countActiveAgentRuns(input.tenantId, input.projectId, 'background');
      if (active > limits.maxConcurrentRunsPerProject) return { limit: limits.maxConcurrentRunsPerProject, scope: 'project' };
    }
    return null;
  };
  const cap = await overCap();
  if (cap) {
    await db.deleteAgentRun(String(run._id)).catch(() => undefined);
    return { kind: 'concurrency_limit', ...cap };
  }

  try {
    await publishAgentRunJob(run);
  } catch (error) {
    // Nothing will ever pick this row up — free the conversation instead of
    // leaving it locked until a reconciler notices.
    await db.deleteAgentRun(String(run._id)).catch(() => undefined);
    throw error;
  }

  return { kind: 'created', run };
}

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

export type RequestAgentRunCancellationOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_terminal'; run: IAgentRun }
  | { kind: 'accepted'; run: IAgentRun };

/**
 * Scoped lookup first, then "no such run" (404) vs "already terminal" (409).
 * A run canceled while still queued never reaches a worker, so its callback
 * is fired here.
 */
export async function requestAgentRunCancellation(
  tenantDbName: string,
  tenantId: string,
  projectId: string,
  runIdInput: string,
): Promise<RequestAgentRunCancellationOutcome> {
  const runId = normalizeAgentRunId(runIdInput);
  const db = await withTenantDb(tenantDbName);
  const owned = await db.getAgentRunById(runId, tenantId, projectId);
  if (!owned || owned.mode !== 'background') return { kind: 'not_found' };
  if (owned.status !== 'queued' && owned.status !== 'running') {
    return { kind: 'already_terminal', run: owned };
  }
  const result = await db.requestAgentRunCancel(runId, tenantId, projectId);
  if (!result) return { kind: 'already_terminal', run: owned };
  if (result.status === 'canceled') {
    await fireAgentRunCallback(result, 'canceled', {}).catch((error) => {
      logger.warn('Could not queue the canceled callback', { runId, error: error instanceof Error ? error.message : String(error) });
    });
  }
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
    runtimeContext: openSealed<AgentRuntimeContext>(run.runtimeContext?.sealed),
    cancellationCell,
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
  return runWithTenantDb(tenantDbName, async (db) => {
    const cfg = getConfig();
    const workerId = getThisNodeName();
    const startedAt = new Date();

    const claimed = await db.claimAgentRun(runId, tenantId, workerId, startedAt);
    if (!claimed) {
      logger.info('Agent run already claimed or not queued; skipping duplicate delivery', { runId });
      return;
    }
    logger.info('Agent run started', { runId, agentKey: claimed.agentKey, conversationId: claimed.conversationId });

    const finalize = async (
      status: 'succeeded' | 'failed' | 'canceled',
      data: Pick<IAgentRun, 'errorReason' | 'errorMessage' | 'result'>,
      callbackData: Record<string, unknown> = {},
    ) => {
      // The sealed caller headers are only needed while the turn runs.
      const finalized = await db.finalizeAgentRun(runId, tenantId, { ...data, status, completedAt: new Date(), runtimeContext: null });
      if (finalized) {
        await fireAgentRunCallback(finalized, status, callbackData).catch((error) => {
          logger.warn('Could not queue the run callback', { runId, error: error instanceof Error ? error.message : String(error) });
        });
      }
    };

    const blocked = await preconditionFailure(db, claimed).catch(() => null);
    if (blocked) {
      await finalize('failed', { errorReason: 'precondition_failed', errorMessage: blocked }, { errorReason: 'precondition_failed', message: blocked });
      return;
    }

    const maxDurationMs = claimed.maxDurationMs && claimed.maxDurationMs > 0
      ? Math.min(claimed.maxDurationMs, cfg.agent.backgroundMaxDurationMs)
      : cfg.agent.backgroundMaxDurationMs;
    const deadlineAt = Date.now() + maxDurationMs;
    // deadlineAt makes the turn itself stop at the ceiling (SDK timeout +
    // no conversation write), not just the run record.
    const cancellationCell: AgentRunCancellationCell = { cancelled: false, deadlineAt };

    let resolveCancelObserved: (() => void) | undefined;
    const cancelObservedPromise = new Promise<typeof CANCEL_SENTINEL>((resolve) => {
      resolveCancelObserved = () => resolve(CANCEL_SENTINEL);
    });
    const markSuperseded = () => {
      if (cancellationCell.cancelled) return;
      cancellationCell.cancelled = true;
      resolveCancelObserved?.();
    };

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
            logger.info('Cancel request observed; finalizing without waiting for invoke()', { runId });
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
      // Attribution: usage recorded by the turn reads the request context,
      // which a queue worker otherwise has none of. A rejection settles as a
      // value, so the race can finalize it instead of throwing past the timers.
      const invokePromise = runWithRequestContext(
        {
          tenantId: claimed.tenantId,
          projectId: claimed.projectId,
          userId: claimed.userId,
          apiTokenId: claimed.apiTokenId,
          actorType: claimed.actorType ?? 'api_token',
          source: 'api',
        },
        () => executeAgentChatLocal(request),
      ).then(
        (response) => ({ ok: true as const, response }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      const raced = await Promise.race([invokePromise, deadlineTimer.promise, cancelObservedPromise]);
      stopAllTimers();

      if (raced === CANCEL_SENTINEL || (cancellationCell.cancelled && raced !== TIMEOUT_SENTINEL)) {
        await finalize('canceled', { errorReason: 'canceled_by_caller' });
        return;
      }

      if (raced === TIMEOUT_SENTINEL) {
        cancellationCell.cancelled = true;
        const minutes = Math.round(maxDurationMs / 60_000);
        await finalize('failed', {
          errorReason: 'max_duration_exceeded',
          errorMessage: `The background run exceeded its ${minutes}-minute limit and was stopped.`,
        }, { errorReason: 'max_duration_exceeded' });
        return;
      }

      if (!raced.ok) {
        logger.warn('Background agent turn failed', {
          runId,
          error: raced.error instanceof Error ? raced.error.message : String(raced.error),
        });
        const message = publicFailureMessage(raced.error);
        await finalize('failed', { errorReason: 'agent_error', errorMessage: message }, { errorReason: 'agent_error', message });
        return;
      }

      const { _conversation_messages: _omitted, ...responseWithoutTranscript } = raced.response;
      const responseWithRunId: AgentChatResponse = { ...responseWithoutTranscript, id: `resp_${runId}` };
      await finalize('succeeded', { result: responseWithRunId as unknown as Record<string, unknown> }, { result: responseWithRunId });
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
  event: 'succeeded' | 'failed' | 'canceled';
  data: Record<string, unknown>;
}

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` — the crawler/OCR webhook scheme. */
export function signAgentRunCallback(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

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
  await queue.publish(AGENT_RUN_QUEUE, CALLBACK_JOB_NAME, payload, {
    attempts: CALLBACK_ATTEMPTS,
    backoffMs: CALLBACK_BACKOFF_MS,
  });
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

    let deliveryError: Error | undefined;
    try {
      const body = JSON.stringify({
        id: eventId,
        event: eventName,
        createdAt: new Date().toISOString(),
        runId: publicRunId,
        conversationId: payload.conversationId,
        data: payload.data,
      });
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'user-agent': 'cognipeer-agent-runs/1.0',
        'x-cognipeer-event': eventName,
        'x-cognipeer-event-id': eventId,
      };
      const secret = openSealed<string>(current?.callbackSecret);
      if (secret) headers['x-cognipeer-signature'] = signAgentRunCallback(secret, body);

      const response = await safeFetch(payload.callbackUrl, { method: 'POST', headers, body }, { timeoutMs: CALLBACK_TIMEOUT_MS });
      await response.body?.cancel().catch(() => undefined);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Callback endpoint answered HTTP ${response.status}`);
      }
    } catch (error) {
      deliveryError = error instanceof Error ? error : new Error(`Agent-run webhook delivery failed for run ${payload.runId}`);
      logger.warn('Agent-run webhook delivery attempt failed', {
        runId: payload.runId,
        event: payload.event,
        attempt: nextAttempts,
        error: error instanceof Error ? error.message : String(error),
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

/** Queues a run's job — at submit, and again from the reconciler for a queued run no worker picked up. */
export async function publishAgentRunJob(run: IAgentRun): Promise<void> {
  const queue = await getQueue();
  await queue.publish(AGENT_RUN_QUEUE, 'run', {
    runId: String(run._id),
    tenantId: run.tenantId,
    tenantDbName: run.tenantDbName,
  } satisfies AgentRunJobPayload, { attempts: 1 });
}

/** A sync reservation this old is abandoned, not live — see `SYNC_RESERVATION_GRACE_MS`. */
export function isAbandonedSyncReservation(run: IAgentRun, now = Date.now()): boolean {
  if (run.mode !== 'sync') return false;
  const started = run.startedAt ? new Date(run.startedAt).getTime() : 0;
  return now - started > getConfig().agent.syncTimeoutMs + SYNC_RESERVATION_GRACE_MS;
}
