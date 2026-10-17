/**
 * Agent routines — a saved way of starting an agent: a prompt (+ inputs) and a
 * trigger (a cron schedule in a timezone, one time, or by hand). Every fire is
 * an ordinary AgentRun (`channel: 'routine'`, `routineId`), started through
 * `startAgentRun` like any API run, so a routine's history is the runs list
 * filtered by routine and its runs get the queue, caps, callbacks and webhooks
 * every other run gets.
 *
 * `fireRoutine` is the one way a routine starts a run — the scheduler tick
 * (`agentRoutineScheduler.ts`), Run now, and every other trigger type.
 */

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type { AgentResponseFormat, AgentRoutineTrigger, IAgentConfig, IAgentRoutine, IAgentRun } from '@/lib/database';
import { publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import { agentDefaultCallback, openAgentCallbackSecret } from './agentCallbackConfig';
import { AgentQuotaExceededError, AgentSpendLimitError } from './agentErrors';
import { resolveRunInputs, type InputIssue } from './agentInputs';
import { publicAgentRunId, resolveAgentRunLimits, startAgentRun } from './agentRunService';
import { createConversation, resolveAgentConfig } from './agentService';
import { assertQueuedTurnSpendAllowed } from './agentSpendLimits';
import { initialNextFireAt } from './routineSchedule';

const logger = createLogger('agent-routine');

/** The run owner of every routine fire: a synthetic actor, never a person (no token, no delegation). */
export const ROUTINE_ACTOR_PREFIX = 'system:routine:';

export function routineActorId(routineId: string): string {
  return `${ROUTINE_ACTOR_PREFIX}${routineId}`;
}

/** What starts a fire. `webhook` arrives with the incoming-webhook trigger. */
export type RoutineFireTrigger = Exclude<NonNullable<IAgentRun['trigger']>, 'request'>;

export interface RoutineTenant {
  tenantId: string;
  tenantDbName: string;
  licenseType?: string;
}

export interface FireRoutineInput {
  trigger: RoutineFireTrigger;
  /** The final user message. */
  message: string;
  /** Already validated against the agent's declared inputs. */
  inputs?: Record<string, unknown> | null;
  /** The message / inputs came from an external payload: inputs stay out of the system prompt. */
  externalContent?: boolean;
  /** Merged over the routine's metadata (≤ 16 keys together). */
  metadata?: Record<string, string> | null;
  idempotencyKey?: string;
  /** The slot this fire is for (the scheduler's); default now. */
  fireAt?: Date;
  /** A normalized event name, for the catalog event only. */
  event?: string;
}

export type FireRoutineResult =
  | { kind: 'accepted'; run: IAgentRun }
  /** The idempotency key already started a run of this routine (pre-check, or the engine's replay). */
  | { kind: 'duplicate'; run?: IAgentRun }
  | { kind: 'concurrency_limit' | 'spend_limit' | 'quota_exceeded'; reason: string; retryAfterSeconds: number }
  | { kind: 'failed'; reason: string };

const RUN_METADATA_MAX_KEYS = 16;

// ── Catalog events ───────────────────────────────────────────────────────

/** `routine.failed` is sent at most once per routine and reason per hour (a schedule over a limit refuses every tick). */
const FAILED_EVENT_THROTTLE_MS = 60 * 60 * 1000;
const lastFailedEventAt = new Map<string, number>();

async function publishRoutineEvent(
  routine: IAgentRoutine,
  tenant: RoutineTenant,
  type: 'routine.fired' | 'routine.failed',
  data: { trigger: RoutineFireTrigger; runId?: string; event?: string; reason?: string },
): Promise<void> {
  const routineId = String(routine._id);
  if (type === 'routine.failed') {
    const key = `${tenant.tenantId}:${routineId}:${data.reason ?? ''}`;
    const last = lastFailedEventAt.get(key);
    if (last !== undefined && Date.now() - last < FAILED_EVENT_THROTTLE_MS) return;
    lastFailedEventAt.set(key, Date.now());
    if (lastFailedEventAt.size > 10_000) lastFailedEventAt.clear();
  }
  await publishWebhookEvent({
    tenantDbName: tenant.tenantDbName,
    tenantId: tenant.tenantId,
    projectId: routine.projectId,
    type,
    data: {
      routineId,
      agentKey: routine.agentKey,
      trigger: data.trigger,
      ...(data.runId ? { runId: data.runId } : {}),
      ...(data.event ? { event: data.event } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
    },
  }).catch((error) => {
    logger.warn('Could not publish a routine event', { routineId, type, error: error instanceof Error ? error.message : String(error) });
  });
}

/** Test seam: forget which failure events were sent. */
export function resetRoutineEventThrottle(): void {
  lastFailedEventAt.clear();
}

// ── Fire ─────────────────────────────────────────────────────────────────

/**
 * Starts one run of a routine. Never throws. In order (§2.4a): the idempotency
 * pre-check (a run found counts only when it is this routine's), the spend
 * pre-check, a new session (source `routine`, the agent's own budget), the run
 * (queued; owned by the routine's synthetic actor; unattended), the session
 * removed again for anything but an accepted run, the outcome recorded on the
 * routine (accepted / failed only — the newest fire wins), the catalog event.
 */
export async function fireRoutine(routine: IAgentRoutine, tenant: RoutineTenant, input: FireRoutineInput): Promise<FireRoutineResult> {
  const routineId = String(routine._id);
  const fireAt = input.fireAt ?? new Date();
  const userId = routineActorId(routineId);
  const scope = { tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId, projectId: routine.projectId };
  let result: FireRoutineResult;
  try {
    result = await runWithTenantScope(tenant.tenantDbName, async (db): Promise<FireRoutineResult> => {
      // The session made for this fire, removed again when no run starts on it.
      let conversationId: string | null = null;
      const outcome = await (async (): Promise<FireRoutineResult> => {
        if (input.idempotencyKey) {
          const existing = await db.getAgentRunByIdempotencyKey(tenant.tenantId, routine.projectId, input.idempotencyKey);
          if (existing) {
            return existing.routineId === routineId ? { kind: 'duplicate', run: existing } : { kind: 'failed', reason: 'idempotency key in use' };
          }
        }

        const agent = await db.findAgentByKey(routine.agentKey, routine.projectId);
        if (!agent || agent.status !== 'active') return { kind: 'failed', reason: 'agent is not active' };

        const metadata = { ...(routine.metadata ?? {}), ...(input.metadata ?? {}) };
        if (Object.keys(metadata).length > RUN_METADATA_MAX_KEYS) {
          return { kind: 'failed', reason: `metadata can hold at most ${RUN_METADATA_MAX_KEYS} keys` };
        }

        try {
          await assertQueuedTurnSpendAllowed({ ...scope, agentKey: routine.agentKey, userId });
        } catch (error) {
          if (error instanceof AgentSpendLimitError) return { kind: 'spend_limit', reason: 'spend limit reached', retryAfterSeconds: 3600 };
          throw error;
        }

        const conversation = await createConversation(
          tenant.tenantDbName,
          tenant.tenantId,
          routine.projectId,
          userId,
          routine.agentKey,
          `${routine.name} · ${fireAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          { source: 'routine', routineId, trigger: input.trigger },
        );
        conversationId = String(conversation._id);

        const callback = routine.callback?.url
          ? { url: routine.callback.url, secret: openAgentCallbackSecret({ secretSealed: routine.callback.secretSealed ?? undefined }) }
          : agentDefaultCallback(agent.config);
        try {
          const started = await startAgentRun({
            ...scope,
            agentKey: routine.agentKey,
            conversationId,
            userMessage: input.message,
            userId,
            actorType: 'system',
            ...(routine.version != null ? { version: routine.version } : {}),
            usePublished: routine.version == null,
            responseFormat: routine.responseFormat ?? null,
            inputs: input.inputs ?? null,
            runClass: routine.runClass ?? 'default',
            channel: 'routine',
            metadata: Object.keys(metadata).length > 0 ? metadata : null,
            routineId,
            trigger: input.trigger,
            unattended: true,
            ...(input.externalContent ? { externalContent: true } : {}),
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            idempotencyConversationScope: null,
            callback: callback.url ? { url: callback.url, ...(callback.secret ? { secret: callback.secret } : {}) } : null,
            execution: { kind: 'queued' },
            limits: await resolveAgentRunLimits({
              quotaContext: { ...scope, ...(tenant.licenseType ? { licenseType: tenant.licenseType as never } : {}) },
            }),
          });
          switch (started.kind) {
            case 'accepted':
              return { kind: 'accepted', run: started.run };
            case 'replay':
              return started.run.routineId === routineId ? { kind: 'duplicate', run: started.run } : { kind: 'failed', reason: 'idempotency key in use' };
            case 'idempotency_conflict':
              return { kind: 'duplicate' };
            case 'concurrency_limit':
              return { kind: 'concurrency_limit', reason: 'agent run limit reached', retryAfterSeconds: 30 };
            default:
              return { kind: 'failed', reason: 'internal error' };
          }
        } catch (error) {
          if (error instanceof AgentQuotaExceededError) return { kind: 'quota_exceeded', reason: 'quota exceeded', retryAfterSeconds: 60 };
          throw error;
        }
      })().catch((error: unknown): FireRoutineResult => {
        logger.error('Routine fire failed', { routineId, error: error instanceof Error ? error.message : String(error) });
        return { kind: 'failed', reason: 'internal error' };
      });

      if (outcome.kind !== 'accepted' && conversationId) {
        await db.deleteAgentConversation(conversationId).catch((error) => {
          logger.warn('Could not remove the session of a routine fire that started no run', {
            routineId, conversationId, error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (outcome.kind === 'accepted' || outcome.kind === 'failed') {
        await db.setRoutineFireResult(routineId, outcome.kind === 'accepted'
          ? { fireAt, status: 'started', runId: String(outcome.run._id) }
          : { fireAt, status: 'failed', error: outcome.reason });
      }
      return outcome;
    });
  } catch (error) {
    // The tenant scope itself, or recording the result, failed.
    logger.error('Routine fire failed', { routineId, error: error instanceof Error ? error.message : String(error) });
    result = { kind: 'failed', reason: 'internal error' };
  }

  if (result.kind === 'accepted') {
    await publishRoutineEvent(routine, tenant, 'routine.fired', { trigger: input.trigger, runId: publicAgentRunId(result.run), event: input.event });
  } else if (result.kind !== 'duplicate') {
    await publishRoutineEvent(routine, tenant, 'routine.failed', { trigger: input.trigger, event: input.event, reason: result.reason });
  }
  return result;
}

// ── Inputs at fire time ──────────────────────────────────────────────────

/** The config a routine's runs execute: its pinned version, else the published one (the draft while none is). */
export async function routineAgentConfig(tenantDbName: string, routine: Pick<IAgentRoutine, 'agentKey' | 'projectId' | 'version'>): Promise<IAgentConfig | null> {
  try {
    return (await resolveAgentConfig(tenantDbName, routine.agentKey, routine.projectId, routine.version ?? undefined)).config;
  } catch {
    return null;
  }
}

/**
 * The routine's inputs (+ a Run now's overrides), checked against the inputs
 * the agent declares NOW — the agent may have been republished since the
 * routine was saved. Defaults applied.
 */
export function resolveRoutineInputs(
  config: Pick<IAgentConfig, 'inputs'> | null,
  routine: Pick<IAgentRoutine, 'inputs'>,
  overrides?: Record<string, unknown> | null,
): { ok: true; inputs: Record<string, unknown> | null } | { ok: false; errors: InputIssue[]; reason: string } {
  const merged = { ...(routine.inputs ?? {}), ...(overrides ?? {}) };
  const resolved = resolveRunInputs(config?.inputs, Object.keys(merged).length > 0 ? merged : null);
  if (resolved.ok) return resolved;
  const first = resolved.errors[0];
  return { ok: false, errors: resolved.errors, reason: `invalid inputs: ${first.field}: ${first.message}` };
}

// ── Store ────────────────────────────────────────────────────────────────

export type RoutineWrite = Partial<Pick<IAgentRoutine,
  'name' | 'description' | 'enabled' | 'trigger' | 'prompt' | 'inputs' | 'version' | 'runClass' | 'metadata' | 'callback' | 'responseFormat'>>;

export interface RoutineScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}

export function listAgentRoutines(scope: RoutineScope, agentKey?: string): Promise<IAgentRoutine[]> {
  return runWithTenantScope(scope.tenantDbName, (db) => db.listAgentRoutines({
    tenantId: scope.tenantId, projectId: scope.projectId, ...(agentKey ? { agentKey } : {}),
  }));
}

/** The routine `routineId` names, of this agent in this project, or null. */
export async function getAgentRoutine(scope: RoutineScope, agentKey: string, routineId: string): Promise<IAgentRoutine | null> {
  const routine = await runWithTenantScope(scope.tenantDbName, (db) => db.getAgentRoutine(routineId, scope.tenantId, scope.projectId));
  return routine && routine.agentKey === agentKey ? routine : null;
}

export function createAgentRoutine(
  scope: RoutineScope,
  agentKey: string,
  write: RoutineWrite & Pick<IAgentRoutine, 'name' | 'trigger' | 'prompt'>,
  userId: string,
  now = new Date(),
): Promise<IAgentRoutine> {
  const enabled = write.enabled ?? true;
  return runWithTenantScope(scope.tenantDbName, (db) => db.createAgentRoutine({
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    agentKey,
    name: write.name,
    description: write.description ?? null,
    enabled,
    trigger: write.trigger,
    prompt: write.prompt,
    inputs: write.inputs ?? null,
    version: write.version ?? null,
    runClass: write.runClass ?? 'default',
    metadata: write.metadata ?? null,
    callback: write.callback ?? null,
    responseFormat: write.responseFormat ?? null,
    nextFireAt: initialNextFireAt({ enabled, trigger: write.trigger }, now),
    createdBy: userId,
  }));
}

/** Saves a change; a new trigger or an enable / disable recomputes `nextFireAt` from now. */
export function updateAgentRoutine(
  scope: RoutineScope,
  existing: IAgentRoutine,
  write: RoutineWrite,
  userId: string,
  now = new Date(),
): Promise<IAgentRoutine | null> {
  const timing = write.trigger !== undefined || write.enabled !== undefined
    ? {
      nextFireAt: initialNextFireAt({
        enabled: write.enabled ?? existing.enabled,
        trigger: write.trigger ?? existing.trigger,
        lastFireAt: existing.lastFireAt,
      }, now),
    }
    : {};
  return runWithTenantScope(scope.tenantDbName, (db) => db.updateAgentRoutine(
    String(existing._id), scope.tenantId, scope.projectId, { ...write, ...timing, updatedBy: userId },
  ));
}

export function deleteAgentRoutine(scope: RoutineScope, routine: IAgentRoutine): Promise<boolean> {
  return runWithTenantScope(scope.tenantDbName, (db) => db.deleteAgentRoutine(String(routine._id), scope.tenantId, scope.projectId));
}

// ── Wire shape (§5.7) ────────────────────────────────────────────────────

const toEpochSeconds = (value: Date | string | null | undefined) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);

function serializeTrigger(trigger: AgentRoutineTrigger): Record<string, unknown> {
  switch (trigger.type) {
    case 'schedule': return { type: 'schedule', cron: trigger.cron, timezone: trigger.timezone };
    case 'once': return { type: 'once', run_at: new Date(trigger.runAt).toISOString() };
    default: return { type: trigger.type };
  }
}

/** A per-request structured output in the runs API's spelling. */
export function serializeResponseFormat(format: AgentResponseFormat | null | undefined): Record<string, unknown> | null {
  if (!format) return null;
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name ?? 'response',
      schema: format.schema ?? {},
      ...(format.strict !== undefined ? { strict: format.strict } : {}),
    },
  };
}

/** A routine as the client API and the dashboard return it — never the sealed callback secret. */
export function serializeAgentRoutine(routine: IAgentRoutine) {
  return {
    id: String(routine._id),
    object: 'agent.routine' as const,
    agent: routine.agentKey,
    name: routine.name,
    description: routine.description ?? null,
    enabled: routine.enabled,
    trigger: serializeTrigger(routine.trigger),
    prompt: routine.prompt,
    inputs: routine.inputs ?? null,
    version: routine.version ?? null,
    class: routine.runClass ?? 'default',
    metadata: routine.metadata ?? {},
    callback: routine.callback?.url ? { url: routine.callback.url, signed: Boolean(routine.callback.secretSealed) } : null,
    response_format: serializeResponseFormat(routine.responseFormat),
    next_fire_at: toEpochSeconds(routine.nextFireAt),
    last_fire_at: toEpochSeconds(routine.lastFireAt),
    last_run_id: routine.lastRunId ? publicAgentRunId({ _id: routine.lastRunId }) : null,
    last_status: routine.lastStatus ?? null,
    last_error: routine.lastError ?? null,
    created_at: toEpochSeconds(routine.createdAt),
    updated_at: toEpochSeconds(routine.updatedAt),
  };
}
