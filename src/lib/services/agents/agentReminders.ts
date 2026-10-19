/**
 * Agent reminders: a note an agent leaves itself to pick a session up again
 * later (`reminder_set`, agentReminderTools.ts).
 *
 * A reminder is not a store of its own. It is a scheduled AgentRun on the same
 * conversation (`channel: 'reminder'`, `notBefore` = when it fires,
 * `userMessage` = the note): the reconciler starts it when it comes due, waits
 * while another run holds the session and expires it after the deferred-wait
 * ceiling, and cancel, retention, callbacks and the owner / token checks are
 * the ones every run has. The reminder id is the run id (`run_<id>`).
 */

import { criticalFireAndForget } from '@/lib/core/asyncTask';
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import type { DatabaseProvider, IAgentConfig, IAgentRun } from '@/lib/database';
import { AgentRunConflictError } from '@/lib/database';
import { resolveEffectiveLimits } from '@/lib/quota/quotaGuard';
import { recordAuditLog } from '@/lib/services/audit/auditService';
import type { RequestVia } from '@/lib/core/requestContext';
import { agentDefaultCallback } from './agentCallbackConfig';
import { AgentQuotaExceededError } from './agentErrors';
import type { ResolvedRemindersConfig, ReminderPlatformLimits } from './agentRemindersConfig';
import {
  cancelAgentRun,
  dispatchDeferredRuns,
  normalizeAgentRunId,
  publicAgentRunId,
  publishAgentRunJob,
  resolveAgentRunLimits,
  runWithTenantDb,
  startAgentRun,
} from './agentRunService';

const logger = createLogger('agent-reminders');

export const REMINDER_CHANNEL = 'reminder' as const;

/** Run statuses a reminder can be in, in the order they happen. */
const ALL_STATUSES: IAgentRun['status'][] = ['scheduled', 'queued', 'running', 'requires_action', 'succeeded', 'failed', 'canceled'];

/** Run metadata keys of a reminder (strings, like every run's metadata). */
export const REMINDER_META = {
  reason: 'reminder_reason',
  setByRun: 'reminder_set_by_run',
  chain: 'reminder_chain',
} as const;

export interface ReminderScope {
  tenantDbName: string;
  tenantId: string;
  projectId: string;
}

/** Who did something to a reminder, for the audit log. */
export interface ReminderActor {
  userId?: string;
  tokenId?: string;
  email?: string;
  /** Where the action came from: the agent itself, the dashboard or the client API. */
  via: 'agent' | 'dashboard' | 'api' | 'portal';
}

/** The platform ceilings from the environment (`AGENT_REMINDER_*`). */
export function reminderPlatformLimits(): ReminderPlatformLimits {
  return { ...getConfig().agent.reminders };
}

export function isReminderRun(run: Pick<IAgentRun, 'channel'> | null | undefined): run is IAgentRun {
  return run?.channel === REMINDER_CHANNEL;
}

/** How many reminders in a row led to this one (1 = set by an ordinary turn). */
export function reminderChain(run: Pick<IAgentRun, 'metadata'>): number {
  const value = Number(run.metadata?.[REMINDER_META.chain]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/** When the reminder fires (or fired): its scheduled time, else when its run started. */
export function reminderFireAt(run: Pick<IAgentRun, 'notBefore' | 'startedAt' | 'createdAt'>): Date | null {
  const at = run.notBefore ?? run.startedAt ?? run.createdAt;
  return at ? new Date(at) : null;
}

/** A reminder as the dashboard, the client API and the portal return it. */
export function serializeReminder(run: IAgentRun) {
  const seconds = (value: Date | string | null | undefined) => (value ? Math.floor(new Date(value).getTime() / 1000) : null);
  return {
    id: publicAgentRunId(run),
    object: 'agent.reminder' as const,
    agent: run.agentKey,
    session_id: run.conversationId,
    status: run.status,
    fire_at: seconds(reminderFireAt(run)),
    message: run.userMessage,
    reason: run.metadata?.[REMINDER_META.reason] ?? null,
    set_by_run: run.metadata?.[REMINDER_META.setByRun] ?? null,
    chain: reminderChain(run),
    created_at: seconds(run.createdAt),
    completed_at: seconds(run.completedAt),
    error: run.status === 'failed' || run.status === 'canceled'
      ? { type: run.errorReason ?? 'agent_error', message: run.errorMessage ?? null }
      : null,
  };
}

export type SerializedReminder = ReturnType<typeof serializeReminder>;

export interface ListRemindersFilter {
  agentKey?: string;
  conversationId?: string;
  /** Only the reminders still waiting to fire. */
  active?: boolean;
  /** Only the reminders of sessions this user started (see `sessionListScope`). */
  userId?: string;
  limit?: number;
}

/** Reminders, newest first. */
export async function listReminders(scope: ReminderScope, filter: ListRemindersFilter = {}): Promise<IAgentRun[]> {
  return runWithTenantDb(scope.tenantDbName, (db) => db.listAgentRuns({
    tenantId: scope.tenantId,
    projectId: scope.projectId,
    channel: REMINDER_CHANNEL,
    ...(filter.agentKey ? { agentKey: filter.agentKey } : {}),
    ...(filter.conversationId ? { conversationId: filter.conversationId } : {}),
    ...(filter.active ? { status: ['scheduled'] as IAgentRun['status'][] } : {}),
    ...(filter.userId ? { userId: filter.userId } : {}),
    limit: Math.min(Math.max(filter.limit ?? 100, 1), 500),
  }));
}

/** Active reminders per session (and the next one), for the sessions list. */
export async function activeRemindersBySession(
  scope: ReminderScope,
  agentKey: string,
): Promise<Map<string, { active: number; nextAt: Date }>> {
  const runs = await listReminders(scope, { agentKey, active: true, limit: 500 });
  const out = new Map<string, { active: number; nextAt: Date }>();
  for (const run of runs) {
    const at = reminderFireAt(run);
    if (!at) continue;
    const entry = out.get(run.conversationId);
    if (!entry) out.set(run.conversationId, { active: 1, nextAt: at });
    else {
      entry.active += 1;
      if (at < entry.nextAt) entry.nextAt = at;
    }
  }
  return out;
}

/** One reminder by id; null when there is none, or it belongs to another agent / session. */
export async function findReminder(
  scope: ReminderScope,
  id: string,
  within: { agentKey?: string; conversationId?: string } = {},
): Promise<IAgentRun | null> {
  const run = await runWithTenantDb(scope.tenantDbName, (db) => db.getAgentRunById(normalizeAgentRunId(id), scope.tenantId, scope.projectId));
  if (!isReminderRun(run)) return null;
  if (within.agentKey && run.agentKey !== within.agentKey) return null;
  if (within.conversationId && run.conversationId !== within.conversationId) return null;
  return run;
}

function audit(scope: ReminderScope, actor: ReminderActor, event: string, run: IAgentRun, extra: Record<string, unknown> = {}): void {
  criticalFireAndForget('agent-reminder-audit', () => runWithTenantDb(scope.tenantDbName, () => recordAuditLog(
    { tenantDbName: scope.tenantDbName, tenantId: scope.tenantId },
    {
      projectId: scope.projectId,
      action: 'write',
      actorType: actor.via === 'agent' ? 'system' : actor.tokenId ? 'api_token' : 'user',
      ...(actor.userId ? { actorUserId: actor.userId } : {}),
      ...(actor.email ? { actorEmail: actor.email } : {}),
      ...(actor.tokenId ? { apiTokenId: actor.tokenId } : {}),
      event,
      outcome: 'success',
      resourceType: 'agent_reminder',
      resourceId: publicAgentRunId(run),
      service: 'agents',
      metadata: { agentKey: run.agentKey, sessionId: run.conversationId, via: actor.via, ...extra },
    },
  )));
}

export type CancelReminderOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_scheduled'; run: IAgentRun }
  | { kind: 'canceled'; run: IAgentRun };

/** Cancels a reminder that has not fired yet. One that is running or done is not touched. */
export async function cancelReminder(
  scope: ReminderScope,
  id: string,
  options: { agentKey?: string; conversationId?: string; actor: ReminderActor },
): Promise<CancelReminderOutcome> {
  const run = await findReminder(scope, id, options);
  if (!run) return { kind: 'not_found' };
  if (run.status !== 'scheduled') return { kind: 'not_scheduled', run };
  const outcome = await cancelAgentRun({ ...scope, runId: String(run._id) });
  if (outcome.kind === 'not_found') return { kind: 'not_found' };
  if (outcome.kind === 'already_terminal' || outcome.run.status !== 'canceled') {
    return { kind: 'not_scheduled', run: outcome.run };
  }
  audit(scope, options.actor, 'agent.reminder.canceled', outcome.run);
  return { kind: 'canceled', run: outcome.run };
}

/** Cancels every reminder of the agent still waiting to fire (optionally one session's). */
export async function cancelActiveReminders(
  scope: ReminderScope,
  options: { agentKey: string; conversationId?: string; userId?: string; actor: ReminderActor },
): Promise<number> {
  const runs = await listReminders(scope, { agentKey: options.agentKey, conversationId: options.conversationId, userId: options.userId, active: true, limit: 500 });
  let canceled = 0;
  for (const run of runs) {
    const outcome = await cancelReminder(scope, String(run._id), { agentKey: options.agentKey, actor: options.actor });
    if (outcome.kind === 'canceled') canceled += 1;
  }
  return canceled;
}

export type FireReminderOutcome =
  | { kind: 'not_found' }
  | { kind: 'not_scheduled'; run: IAgentRun }
  | { kind: 'busy'; message: string }
  | { kind: 'fired'; run: IAgentRun };

/** A session that is waiting on a person or its budget: a reminder turn would only be refused there. */
export function sessionBusyReason(conversation: { runtimeStatus?: string | null } | null | undefined): string | null {
  if (conversation?.runtimeStatus === 'requires_action') return 'The session is waiting for an approval or an answer.';
  if (conversation?.runtimeStatus === 'budget_paused') return 'The session is paused on its budget.';
  return null;
}

/** Starts a scheduled reminder now, through the same promotion the reconciler uses. */
export async function fireReminderNow(
  scope: ReminderScope,
  id: string,
  options: { agentKey?: string; conversationId?: string; actor: ReminderActor },
): Promise<FireReminderOutcome> {
  const run = await findReminder(scope, id, options);
  if (!run) return { kind: 'not_found' };
  if (run.status !== 'scheduled') return { kind: 'not_scheduled', run };
  return runWithTenantDb(scope.tenantDbName, async (db) => {
    const conversation = await db.findAgentConversationById(run.conversationId);
    if (!conversation || conversation.projectId !== scope.projectId) return { kind: 'not_found' } as const;
    const busy = sessionBusyReason(conversation);
    if (busy) return { kind: 'busy', message: busy } as const;
    let promoted: IAgentRun | null;
    try {
      // Its start time moves to now too: the deferred dispatcher only takes runs that are due.
      promoted = await db.promoteScheduledAgentRun(String(run._id), scope.tenantId, { notBefore: new Date() });
    } catch (error) {
      if (error instanceof AgentRunConflictError) return { kind: 'busy', message: 'Another run is active in this session.' } as const;
      throw error;
    }
    if (!promoted) {
      const current = await db.getAgentRunById(String(run._id), scope.tenantId, scope.projectId);
      return { kind: 'not_scheduled', run: current ?? run } as const;
    }
    if (promoted.runClass === 'deferred') {
      await dispatchDeferredRuns(scope.tenantDbName, scope.tenantId).catch((error) => {
        logger.warn('Deferred run dispatch failed; the reconciler retries it', { runId: String(run._id), error: error instanceof Error ? error.message : String(error) });
      });
    } else {
      await publishAgentRunJob(promoted);
    }
    audit(scope, options.actor, 'agent.reminder.fired_now', promoted);
    return { kind: 'fired', run: promoted } as const;
  });
}

/** The turn that sets a reminder: whose it is, and what the wake turn runs as. */
export interface ReminderCreator {
  /** The turn's actor (`request.userId`): the wake turn runs as them. */
  userId: string;
  /** The accountable person of a synthetic actor (a trigger run). */
  accountableUserId?: string;
  accountableTokenId?: string;
  /** The API token the turn came with: revoking it stops the wake turn. */
  tokenId?: string;
  via?: RequestVia;
  /** The creating run (`run_…`), when the turn runs as one. */
  runId?: string;
  /** The chain of the reminder that woke the creating turn, if one did (the new one is chain + 1). */
  wokenChain?: number;
  version?: number;
  usePublished?: boolean;
}

export interface ScheduleReminderInput {
  scope: ReminderScope;
  agentKey: string;
  conversationId: string;
  agentConfig: IAgentConfig;
  settings: ResolvedRemindersConfig;
  fireAt: Date;
  message: string;
  reason?: string;
  creator: ReminderCreator;
  licenseType?: string;
}

export type ScheduleReminderOutcome = { ok: true; run: IAgentRun } | { ok: false; reason: string };

async function countReminders(
  db: DatabaseProvider,
  tenantId: string,
  opts: { statuses: IAgentRun['status'][]; createdAfter?: Date },
): Promise<number> {
  const counts = await db.countAgentRunsByStatus(tenantId, { statuses: opts.statuses, channel: REMINDER_CHANNEL, ...(opts.createdAfter ? { createdAfter: opts.createdAfter } : {}) });
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

/**
 * Creates the reminder's scheduled run after the session and tenant caps.
 * Never throws for a cap or a quota: the outcome says why, in words the model
 * can act on.
 */
export async function scheduleReminder(input: ScheduleReminderInput): Promise<ScheduleReminderOutcome> {
  const { scope, settings, creator } = input;
  const quotaUserId = creator.accountableUserId ?? creator.userId;
  const quotaTokenId = creator.accountableUserId ? creator.accountableTokenId : creator.tokenId;
  const quotaContext = {
    ...scope,
    ...(input.licenseType ? { licenseType: input.licenseType as never } : {}),
    ...(quotaUserId ? { userId: quotaUserId } : {}),
    ...(quotaTokenId ? { tokenId: quotaTokenId } : {}),
  };

  const refusal = await runWithTenantDb(scope.tenantDbName, async (db): Promise<string | null> => {
    // The wake turn runs only for an active agent (agentRunService's precondition): say so now
    // instead of setting a reminder that would fail when it fires (a draft is tried in the playground).
    const agent = await db.findAgentByKey(input.agentKey, scope.projectId);
    if (agent && agent.status !== 'active') {
      return 'Not set: reminders only wake an active agent, and this one is not active yet. Activate or publish the agent first.';
    }
    const inSession = await db.listAgentRuns({
      tenantId: scope.tenantId,
      projectId: scope.projectId,
      conversationId: input.conversationId,
      channel: REMINDER_CHANNEL,
      limit: settings.maxFiresPerSession + 1,
    });
    const active = inSession.filter((run) => run.status === 'scheduled').length;
    if (active >= settings.maxActivePerSession) {
      return `This session already has ${active} reminder(s) waiting (the limit is ${settings.maxActivePerSession}). Cancel one with reminder_cancel or wait for it to fire.`;
    }
    if (inSession.length >= settings.maxFiresPerSession) {
      return `This session has used all ${settings.maxFiresPerSession} reminders it may set.`;
    }

    let quotas: { maxActiveAgentReminders?: number; maxAgentRemindersPerDay?: number } = {};
    try {
      quotas = (await resolveEffectiveLimits({ ...quotaContext, domain: 'global' })).quotas ?? {};
    } catch (error) {
      logger.warn('Could not resolve tenant quota for reminders; only the agent limits apply', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const cap = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);
    const maxActive = cap(quotas.maxActiveAgentReminders);
    if (maxActive !== undefined && await countReminders(db, scope.tenantId, { statuses: ['scheduled'] }) >= maxActive) {
      return 'The workspace has reached its limit of waiting reminders. Try again later.';
    }
    const perDay = cap(quotas.maxAgentRemindersPerDay);
    if (perDay !== undefined
      && await countReminders(db, scope.tenantId, { statuses: ALL_STATUSES, createdAfter: new Date(Date.now() - 86_400_000) }) >= perDay) {
      return 'The workspace has reached its daily limit of reminders. Try again later.';
    }
    return null;
  });
  if (refusal) return { ok: false, reason: refusal };

  const chain = (creator.wokenChain ?? 0) + 1;
  const metadata: Record<string, string> = { [REMINDER_META.chain]: String(chain) };
  if (input.reason) metadata[REMINDER_META.reason] = input.reason;
  if (creator.runId) metadata[REMINDER_META.setByRun] = creator.runId.startsWith('run_') ? creator.runId : `run_${creator.runId}`;
  const callback = agentDefaultCallback(input.agentConfig);

  try {
    const started = await startAgentRun({
      ...scope,
      agentKey: input.agentKey,
      conversationId: input.conversationId,
      userMessage: input.message,
      userId: creator.userId,
      ...(creator.tokenId ? { apiTokenId: creator.tokenId } : {}),
      ...(creator.accountableUserId
        ? { accountable: { userId: creator.accountableUserId, ...(creator.accountableTokenId ? { apiTokenId: creator.accountableTokenId } : {}) } }
        : {}),
      ...(creator.version != null ? { version: creator.version } : {}),
      usePublished: creator.usePublished,
      // Who the turn acts for, never the caller's headers or connections: those are secrets of the call that set it.
      runtimeContext: {
        source: 'reminder',
        ...(creator.userId ? { userId: creator.userId } : {}),
        ...(creator.tokenId ? { tokenId: creator.tokenId } : {}),
        ...(creator.via ? { via: creator.via } : {}),
      },
      unattended: true,
      runClass: settings.runClass,
      channel: REMINDER_CHANNEL,
      metadata,
      callback: callback.url ? { url: callback.url, ...(callback.secret ? { secret: callback.secret } : {}) } : null,
      execution: { kind: 'queued', notBefore: input.fireAt },
      limits: await resolveAgentRunLimits({ quotaContext }),
    });
    if (started.kind === 'accepted') {
      audit(scope, { userId: creator.userId, ...(creator.tokenId ? { tokenId: creator.tokenId } : {}), via: 'agent' }, 'agent.reminder.created', started.run, {
        fireAt: input.fireAt.toISOString(),
        chain,
        ...(creator.runId ? { setByRun: metadata[REMINDER_META.setByRun] } : {}),
      });
      return { ok: true, run: started.run };
    }
    if (started.kind === 'concurrency_limit') return { ok: false, reason: 'The agent queue is full right now. Try again later.' };
    logger.warn('Reminder run not created', { kind: started.kind, agentKey: input.agentKey });
    return { ok: false, reason: 'The reminder could not be set right now.' };
  } catch (error) {
    if (error instanceof AgentQuotaExceededError) return { ok: false, reason: 'The agent run quota is used up; the reminder was not set.' };
    logger.warn('Reminder could not be scheduled', { agentKey: input.agentKey, error: error instanceof Error ? error.message : String(error) });
    return { ok: false, reason: 'The reminder could not be set right now.' };
  }
}
