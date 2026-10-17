/**
 * Agent triggers — a saved way of starting an agent: a prompt (+ inputs) and a
 * `type` with that type's settings object (a cron `schedule` in a timezone,
 * `once`, `manual`, or an incoming `webhook`). Every fire is an ordinary
 * AgentRun (`channel: 'trigger'`, `triggerId`), started through `startAgentRun`
 * like any API run, so a trigger's history is the runs list filtered by
 * trigger and its runs get the queue, caps, callbacks and webhooks every other
 * run gets.
 *
 * `fireTrigger` is the one way a trigger starts a run — the scheduler tick
 * (`agentTriggerScheduler.ts`), Run now, and every other type.
 */

import { createLogger } from '@/lib/core/logger';
import { runWithTenantScope } from '@/lib/database';
import type {
  AgentResponseFormat,
  AgentTriggerTypeSettings,
  IAgentConfig,
  IAgentTrigger,
  IAgentTriggerBase,
  IAgentRun,
} from '@/lib/database';
import { publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import { agentDefaultCallback, openAgentCallbackSecret } from './agentCallbackConfig';
import { AgentQuotaExceededError, AgentSpendLimitError } from './agentErrors';
import { resolveRunInputs, type InputIssue } from './agentInputs';
import { publicAgentRunId, resolveAgentRunLimits, startAgentRun } from './agentRunService';
import { createConversation, resolveAgentConfig } from './agentService';
import { assertQueuedTurnSpendAllowed } from './agentSpendLimits';
import { initialNextFireAt } from './agentTriggerSchedule';
import { serializeWebhook } from './agentTriggerWebhookIntake';

const logger = createLogger('agent-trigger');

/** The run owner of every trigger fire: a synthetic actor, never a person (no token, no delegation). */
export const TRIGGER_ACTOR_PREFIX = 'system:trigger:';

export function triggerActorId(triggerId: string): string {
  return `${TRIGGER_ACTOR_PREFIX}${triggerId}`;
}

/** What started a fire: the run's `trigger` field (a request never starts a fire). */
export type TriggerFireSource = Exclude<NonNullable<IAgentRun['trigger']>, 'request'>;

export interface TriggerTenant {
  tenantId: string;
  tenantDbName: string;
  licenseType?: string;
}

export interface FireTriggerInput {
  /** What started this fire: the run's `trigger` and the `trigger` of the `trigger.fired` / `trigger.failed` events. */
  trigger: TriggerFireSource;
  /** The final user message. */
  message: string;
  /** Already validated against the agent's declared inputs. */
  inputs?: Record<string, unknown> | null;
  /** The message / inputs came from an external payload: inputs stay out of the system prompt. */
  externalContent?: boolean;
  /** Merged over the trigger's metadata (≤ 16 keys together). */
  metadata?: Record<string, string> | null;
  idempotencyKey?: string;
  /** The slot this fire is for (the scheduler's); default now. */
  fireAt?: Date;
  /** A normalized event name, for the catalog event only. */
  event?: string;
  /**
   * Who the fire counts against (spend limits, run quota, run caps): the
   * person and token that pressed Run now. Default: the trigger's accountable
   * person (`triggerAccountableUserId`).
   */
  principal?: { userId: string; apiTokenId?: string };
}

/**
 * The person a trigger's own fires (schedule, once, webhook) count against:
 * whoever last changed it, else whoever created it. The run itself stays owned
 * by the trigger's synthetic actor.
 */
export function triggerAccountableUserId(trigger: Pick<IAgentTrigger, 'createdBy' | 'updatedBy'>): string {
  return trigger.updatedBy || trigger.createdBy;
}

export type FireTriggerResult =
  | { kind: 'accepted'; run: IAgentRun }
  /** The idempotency key already started a run of this trigger (pre-check, or the engine's replay). */
  | { kind: 'duplicate'; run?: IAgentRun }
  | { kind: 'concurrency_limit' | 'spend_limit' | 'quota_exceeded'; reason: string; retryAfterSeconds: number }
  | { kind: 'failed'; reason: string };

const RUN_METADATA_MAX_KEYS = 16;

// ── Catalog events ───────────────────────────────────────────────────────

/** `trigger.failed` is sent at most once per trigger and reason per hour (a schedule over a limit refuses every tick). */
const FAILED_EVENT_THROTTLE_MS = 60 * 60 * 1000;
const lastFailedEventAt = new Map<string, number>();

async function publishTriggerEvent(
  trigger: IAgentTrigger,
  tenant: TriggerTenant,
  type: 'trigger.fired' | 'trigger.failed',
  data: { trigger: TriggerFireSource; runId?: string; event?: string; reason?: string },
): Promise<void> {
  const triggerId = String(trigger._id);
  if (type === 'trigger.failed') {
    const key = `${tenant.tenantId}:${triggerId}:${data.reason ?? ''}`;
    const last = lastFailedEventAt.get(key);
    if (last !== undefined && Date.now() - last < FAILED_EVENT_THROTTLE_MS) return;
    lastFailedEventAt.set(key, Date.now());
    if (lastFailedEventAt.size > 10_000) lastFailedEventAt.clear();
  }
  await publishWebhookEvent({
    tenantDbName: tenant.tenantDbName,
    tenantId: tenant.tenantId,
    projectId: trigger.projectId,
    type,
    data: {
      triggerId,
      agentKey: trigger.agentKey,
      trigger: data.trigger,
      ...(data.runId ? { runId: data.runId } : {}),
      ...(data.event ? { event: data.event } : {}),
      ...(data.reason ? { reason: data.reason } : {}),
    },
  }).catch((error) => {
    logger.warn('Could not publish a trigger event', { triggerId, type, error: error instanceof Error ? error.message : String(error) });
  });
}

/** Test seam: forget which failure events were sent. */
export function resetTriggerEventThrottle(): void {
  lastFailedEventAt.clear();
}

// ── Fire ─────────────────────────────────────────────────────────────────

/**
 * Starts one run of a trigger. Never throws. In order (§2.4a): the idempotency
 * pre-check (a run found counts only when it is this trigger's), the spend
 * pre-check, a new session (source `trigger`, the agent's own budget), the run
 * (queued; owned by the trigger's synthetic actor; unattended; counted against
 * the accountable principal's spend and quota policies), the session
 * removed again for anything but an accepted run, the outcome recorded on the
 * trigger (accepted / failed only — the newest fire wins), the catalog event.
 */
export async function fireTrigger(trigger: IAgentTrigger, tenant: TriggerTenant, input: FireTriggerInput): Promise<FireTriggerResult> {
  const triggerId = String(trigger._id);
  const fireAt = input.fireAt ?? new Date();
  const userId = triggerActorId(triggerId);
  const principal = input.principal ?? { userId: triggerAccountableUserId(trigger) };
  const scope = { tenantDbName: tenant.tenantDbName, tenantId: tenant.tenantId, projectId: trigger.projectId };
  let result: FireTriggerResult;
  try {
    result = await runWithTenantScope(tenant.tenantDbName, async (db): Promise<FireTriggerResult> => {
      // The session made for this fire, removed again when no run starts on it.
      let conversationId: string | null = null;
      const outcome = await (async (): Promise<FireTriggerResult> => {
        if (input.idempotencyKey) {
          const existing = await db.getAgentRunByIdempotencyKey(tenant.tenantId, trigger.projectId, input.idempotencyKey);
          if (existing) {
            return existing.triggerId === triggerId ? { kind: 'duplicate', run: existing } : { kind: 'failed', reason: 'idempotency key in use' };
          }
        }

        const agent = await db.findAgentByKey(trigger.agentKey, trigger.projectId);
        if (!agent || agent.status !== 'active') return { kind: 'failed', reason: 'agent is not active' };

        const metadata = { ...(trigger.metadata ?? {}), ...(input.metadata ?? {}) };
        if (Object.keys(metadata).length > RUN_METADATA_MAX_KEYS) {
          return { kind: 'failed', reason: `metadata can hold at most ${RUN_METADATA_MAX_KEYS} keys` };
        }

        try {
          await assertQueuedTurnSpendAllowed({ ...scope, agentKey: trigger.agentKey, userId: principal.userId });
        } catch (error) {
          if (error instanceof AgentSpendLimitError) return { kind: 'spend_limit', reason: 'spend limit reached', retryAfterSeconds: 3600 };
          throw error;
        }

        const conversation = await createConversation(
          tenant.tenantDbName,
          tenant.tenantId,
          trigger.projectId,
          userId,
          trigger.agentKey,
          `${trigger.name} · ${fireAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          { source: 'trigger', triggerId, trigger: input.trigger },
        );
        conversationId = String(conversation._id);

        const callback = trigger.callback?.url
          ? { url: trigger.callback.url, secret: openAgentCallbackSecret({ secretSealed: trigger.callback.secretSealed ?? undefined }) }
          : agentDefaultCallback(agent.config);
        try {
          const started = await startAgentRun({
            ...scope,
            agentKey: trigger.agentKey,
            conversationId,
            userMessage: input.message,
            userId,
            actorType: 'system',
            accountable: principal,
            ...(trigger.version != null ? { version: trigger.version } : {}),
            usePublished: trigger.version == null,
            responseFormat: trigger.responseFormat ?? null,
            inputs: input.inputs ?? null,
            runClass: trigger.runClass ?? 'default',
            channel: 'trigger',
            metadata: Object.keys(metadata).length > 0 ? metadata : null,
            triggerId,
            trigger: input.trigger,
            unattended: true,
            ...(input.externalContent ? { externalContent: true } : {}),
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            idempotencyConversationScope: null,
            callback: callback.url ? { url: callback.url, ...(callback.secret ? { secret: callback.secret } : {}) } : null,
            execution: { kind: 'queued' },
            limits: await resolveAgentRunLimits({
              quotaContext: {
                ...scope,
                ...(tenant.licenseType ? { licenseType: tenant.licenseType as never } : {}),
                userId: principal.userId,
                ...(principal.apiTokenId ? { tokenId: principal.apiTokenId } : {}),
              },
            }),
          });
          switch (started.kind) {
            case 'accepted':
              return { kind: 'accepted', run: started.run };
            case 'replay':
              return started.run.triggerId === triggerId ? { kind: 'duplicate', run: started.run } : { kind: 'failed', reason: 'idempotency key in use' };
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
      })().catch((error: unknown): FireTriggerResult => {
        logger.error('Trigger fire failed', { triggerId, error: error instanceof Error ? error.message : String(error) });
        return { kind: 'failed', reason: 'internal error' };
      });

      if (outcome.kind !== 'accepted' && conversationId) {
        await db.deleteAgentConversation(conversationId).catch((error) => {
          logger.warn('Could not remove the session of a trigger fire that started no run', {
            triggerId, conversationId, error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (outcome.kind === 'accepted' || outcome.kind === 'failed') {
        await db.setTriggerFireResult(triggerId, outcome.kind === 'accepted'
          ? { fireAt, status: 'started', runId: String(outcome.run._id) }
          : { fireAt, status: 'failed', error: outcome.reason });
      }
      return outcome;
    });
  } catch (error) {
    // The tenant scope itself, or recording the result, failed.
    logger.error('Trigger fire failed', { triggerId, error: error instanceof Error ? error.message : String(error) });
    result = { kind: 'failed', reason: 'internal error' };
  }

  if (result.kind === 'accepted') {
    await publishTriggerEvent(trigger, tenant, 'trigger.fired', { trigger: input.trigger, runId: publicAgentRunId(result.run), event: input.event });
  } else if (result.kind !== 'duplicate') {
    await publishTriggerEvent(trigger, tenant, 'trigger.failed', { trigger: input.trigger, event: input.event, reason: result.reason });
  }
  return result;
}

// ── Inputs at fire time ──────────────────────────────────────────────────

/** The config a trigger's runs execute: its pinned version, else the published one (the draft while none is). */
export async function triggerAgentConfig(tenantDbName: string, trigger: Pick<IAgentTrigger, 'agentKey' | 'projectId' | 'version'>): Promise<IAgentConfig | null> {
  try {
    return (await resolveAgentConfig(tenantDbName, trigger.agentKey, trigger.projectId, trigger.version ?? undefined)).config;
  } catch {
    return null;
  }
}

/**
 * The trigger's inputs (+ a Run now's overrides), checked against the inputs
 * the agent declares NOW — the agent may have been republished since the
 * trigger was saved. Defaults applied.
 */
export function resolveTriggerInputs(
  config: Pick<IAgentConfig, 'inputs'> | null,
  trigger: Pick<IAgentTrigger, 'inputs'>,
  overrides?: Record<string, unknown> | null,
): { ok: true; inputs: Record<string, unknown> | null } | { ok: false; errors: InputIssue[]; reason: string } {
  const merged = { ...(trigger.inputs ?? {}), ...(overrides ?? {}) };
  const resolved = resolveRunInputs(config?.inputs, Object.keys(merged).length > 0 ? merged : null);
  if (resolved.ok) return resolved;
  const first = resolved.errors[0];
  return { ok: false, errors: resolved.errors, reason: `invalid inputs: ${first.field}: ${first.message}` };
}

// ── Store ────────────────────────────────────────────────────────────────

/** The fields of a write that do not depend on the trigger's type. */
export type TriggerFields = Partial<Pick<IAgentTriggerBase,
  'name' | 'description' | 'enabled' | 'prompt' | 'inputs' | 'version' | 'runClass' | 'metadata' | 'callback' | 'responseFormat'>>;

/**
 * What a create or an update saves. A `type` always comes with its settings
 * object (the other types' objects are dropped), so changing the type replaces
 * them as a whole.
 */
export type TriggerWrite = TriggerFields & (AgentTriggerTypeSettings | { type?: undefined });

/** A write that makes a new trigger: it has a name, a prompt and a type with its settings. */
export type NewTriggerWrite = TriggerWrite & Pick<IAgentTriggerBase, 'name' | 'prompt'> & AgentTriggerTypeSettings;

/** `type` and its settings object, without any other field of a write or a trigger. */
function typeSettingsOf(source: AgentTriggerTypeSettings): AgentTriggerTypeSettings {
  switch (source.type) {
    case 'schedule': return { type: 'schedule', schedule: source.schedule };
    case 'once': return { type: 'once', once: source.once };
    case 'webhook': return { type: 'webhook', webhook: source.webhook };
    default: return { type: 'manual' };
  }
}

export interface TriggerScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}

export function listAgentTriggers(scope: TriggerScope, agentKey?: string): Promise<IAgentTrigger[]> {
  return runWithTenantScope(scope.tenantDbName, (db) => db.listAgentTriggers({
    tenantId: scope.tenantId, projectId: scope.projectId, ...(agentKey ? { agentKey } : {}),
  }));
}

/** The trigger `triggerId` names, of this agent in this project, or null. */
export async function getAgentTrigger(scope: TriggerScope, agentKey: string, triggerId: string): Promise<IAgentTrigger | null> {
  const trigger = await runWithTenantScope(scope.tenantDbName, (db) => db.getAgentTrigger(triggerId, scope.tenantId, scope.projectId));
  return trigger && trigger.agentKey === agentKey ? trigger : null;
}

export function createAgentTrigger(
  scope: TriggerScope,
  agentKey: string,
  write: NewTriggerWrite,
  userId: string,
  now = new Date(),
): Promise<IAgentTrigger> {
  const enabled = write.enabled ?? true;
  const typeSettings = typeSettingsOf(write);
  return runWithTenantScope(scope.tenantDbName, (db) => db.createAgentTrigger({
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    agentKey,
    name: write.name,
    description: write.description ?? null,
    enabled,
    ...typeSettings,
    prompt: write.prompt,
    inputs: write.inputs ?? null,
    version: write.version ?? null,
    runClass: write.runClass ?? 'default',
    metadata: write.metadata ?? null,
    callback: write.callback ?? null,
    responseFormat: write.responseFormat ?? null,
    nextFireAt: initialNextFireAt({ enabled, ...typeSettings }, now),
    createdBy: userId,
  }));
}

/** Saves a change; a new type (with its settings) or an enable / disable recomputes `nextFireAt` from now. */
export function updateAgentTrigger(
  scope: TriggerScope,
  existing: IAgentTrigger,
  write: TriggerWrite,
  userId: string,
  now = new Date(),
): Promise<IAgentTrigger | null> {
  const timing = write.type !== undefined || write.enabled !== undefined
    ? {
      nextFireAt: initialNextFireAt({
        enabled: write.enabled ?? existing.enabled,
        ...typeSettingsOf(write.type !== undefined ? write : existing),
        lastFireAt: existing.lastFireAt,
      }, now),
    }
    : {};
  return runWithTenantScope(scope.tenantDbName, (db) => db.updateAgentTrigger(
    String(existing._id), scope.tenantId, scope.projectId, { ...write, ...timing, updatedBy: userId },
  ));
}

/** Removes the trigger and its webhook delivery log. */
export function deleteAgentTrigger(scope: TriggerScope, trigger: IAgentTrigger): Promise<boolean> {
  return runWithTenantScope(scope.tenantDbName, async (db) => {
    const deleted = await db.deleteAgentTrigger(String(trigger._id), scope.tenantId, scope.projectId);
    if (deleted) await db.deleteAgentTriggerDeliveries(String(trigger._id));
    return deleted;
  });
}

// ── Wire shape (§5.7) ────────────────────────────────────────────────────

const toEpochSeconds = (value: Date | string | null | undefined) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);

/** `type` and the one settings object of that type (manual has none), as the API spells them. */
function serializeTypeSettings(trigger: IAgentTrigger) {
  switch (trigger.type) {
    case 'schedule': return { type: 'schedule' as const, schedule: { cron: trigger.schedule.cron, timezone: trigger.schedule.timezone } };
    case 'once': return { type: 'once' as const, once: { run_at: new Date(trigger.once.runAt).toISOString() } };
    case 'webhook': return { type: 'webhook' as const, webhook: serializeWebhook(trigger.webhook, trigger.tenantId) };
    default: return { type: 'manual' as const };
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

/** A trigger as the client API and the dashboard return it — never a sealed callback or webhook secret. Only the settings object of its own type is present. */
export function serializeAgentTrigger(trigger: IAgentTrigger) {
  return {
    id: String(trigger._id),
    object: 'agent.trigger' as const,
    agent: trigger.agentKey,
    name: trigger.name,
    description: trigger.description ?? null,
    enabled: trigger.enabled,
    ...serializeTypeSettings(trigger),
    prompt: trigger.prompt,
    inputs: trigger.inputs ?? null,
    version: trigger.version ?? null,
    class: trigger.runClass ?? 'default',
    metadata: trigger.metadata ?? {},
    callback: trigger.callback?.url ? { url: trigger.callback.url, signed: Boolean(trigger.callback.secretSealed) } : null,
    response_format: serializeResponseFormat(trigger.responseFormat),
    next_fire_at: toEpochSeconds(trigger.nextFireAt),
    last_fire_at: toEpochSeconds(trigger.lastFireAt),
    last_run_id: trigger.lastRunId ? publicAgentRunId({ _id: trigger.lastRunId }) : null,
    last_status: trigger.lastStatus ?? null,
    last_error: trigger.lastError ?? null,
    created_at: toEpochSeconds(trigger.createdAt),
    updated_at: toEpochSeconds(trigger.updatedAt),
  };
}
