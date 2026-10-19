/**
 * Agent reminders as scheduled runs (agentReminders.ts): the session and
 * tenant caps before one is created, what the run row carries, cancel and
 * "fire now" — plus the effective settings and the config validation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  db: {
    listAgentRuns: vi.fn(),
    countAgentRunsByStatus: vi.fn(),
    getAgentRunById: vi.fn(),
    findAgentConversationById: vi.fn(),
    promoteScheduledAgentRun: vi.fn(),
  },
  startAgentRun: vi.fn(),
  cancelAgentRun: vi.fn(),
  publishAgentRunJob: vi.fn(),
  dispatchDeferredRuns: vi.fn(),
  resolveEffectiveLimits: vi.fn(),
  recordAuditLog: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentRunService', () => ({
  runWithTenantDb: (_name: string, fn: (db: unknown) => unknown) => fn(hoisted.db),
  startAgentRun: hoisted.startAgentRun,
  cancelAgentRun: hoisted.cancelAgentRun,
  publishAgentRunJob: hoisted.publishAgentRunJob,
  dispatchDeferredRuns: hoisted.dispatchDeferredRuns,
  resolveAgentRunLimits: vi.fn(async () => ({ syncWaitMs: 1, maxDurationMs: 2, maxActivePerTenant: 0, maxActivePerProject: 0 })),
  normalizeAgentRunId: (id: string) => id.replace(/^run_/, ''),
  publicAgentRunId: (run: { _id: string }) => `run_${run._id}`,
}));
vi.mock('@/lib/quota/quotaGuard', () => ({ resolveEffectiveLimits: hoisted.resolveEffectiveLimits }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
vi.mock('@/lib/core/asyncTask', () => ({ criticalFireAndForget: (_name: string, fn: () => unknown) => { void fn(); } }));

import { AgentRunConflictError } from '@/lib/database';
import { cancelReminder, fireReminderNow, scheduleReminder, type ScheduleReminderInput } from '@/lib/services/agents/agentReminders';
import { REMINDER_PLATFORM_DEFAULTS, resolveRemindersConfig } from '@/lib/services/agents/agentRemindersConfig';
import { validateAgentConfigShape } from '@/lib/services/agents/agentConfigValidation';

const SCOPE = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' };
const FIRE_AT = new Date('2026-10-19T15:00:00Z');

const input = (over: Partial<ScheduleReminderInput> = {}): ScheduleReminderInput => ({
  scope: SCOPE,
  agentKey: 'ops',
  conversationId: 'conv-1',
  agentConfig: { callback: { url: 'https://example.com/hook' } },
  settings: resolveRemindersConfig({ enabled: true, maxActivePerSession: 2, maxFiresPerSession: 3 }),
  fireAt: FIRE_AT,
  message: 'Check the deploy.',
  reason: 'deploy',
  creator: { userId: 'user-1', tokenId: 'tok-1', runId: 'run-7', wokenChain: 1, version: 4, usePublished: true },
  ...over,
});

const run = (over: Record<string, unknown> = {}) => ({
  _id: 'rem-1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'ops', conversationId: 'conv-1',
  status: 'scheduled', channel: 'reminder', userMessage: 'Check the deploy.', notBefore: FIRE_AT, metadata: {}, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.db.listAgentRuns.mockResolvedValue([]);
  hoisted.db.countAgentRunsByStatus.mockResolvedValue({});
  hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: {} });
  hoisted.startAgentRun.mockResolvedValue({ kind: 'accepted', run: run() });
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  hoisted.dispatchDeferredRuns.mockResolvedValue(0);
  hoisted.publishAgentRunJob.mockResolvedValue(undefined);
});

describe('scheduleReminder', () => {
  it('creates a scheduled, unattended reminder run that wakes the same session as the same person', async () => {
    const outcome = await scheduleReminder(input());
    expect(outcome).toEqual({ ok: true, run: run() });
    expect(hoisted.startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      ...SCOPE,
      agentKey: 'ops',
      conversationId: 'conv-1',
      userMessage: 'Check the deploy.',
      userId: 'user-1',
      apiTokenId: 'tok-1',
      version: 4,
      usePublished: true,
      unattended: true,
      runClass: 'deferred',
      channel: 'reminder',
      metadata: { reminder_chain: '2', reminder_reason: 'deploy', reminder_set_by_run: 'run_run-7' },
      callback: { url: 'https://example.com/hook' },
      execution: { kind: 'queued', notBefore: FIRE_AT },
    }));
    // Who the turn acts for — never the caller's headers or connections.
    const context = hoisted.startAgentRun.mock.calls[0][0].runtimeContext;
    expect(context).toEqual({ source: 'reminder', userId: 'user-1', tokenId: 'tok-1' });
    expect(hoisted.recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ event: 'agent.reminder.created', resourceId: 'run_rem-1', service: 'agents' }),
    );
  });

  it('refuses past the session caps, in words the model can act on', async () => {
    hoisted.db.listAgentRuns.mockResolvedValueOnce([run(), run({ _id: 'rem-2' })]);
    expect(await scheduleReminder(input())).toEqual({ ok: false, reason: expect.stringContaining('already has 2 reminder(s) waiting') });
    hoisted.db.listAgentRuns.mockResolvedValueOnce([run({ status: 'succeeded' }), run({ status: 'canceled' }), run({ status: 'failed' })]);
    expect(await scheduleReminder(input())).toEqual({ ok: false, reason: expect.stringContaining('used all 3') });
    expect(hoisted.startAgentRun).not.toHaveBeenCalled();
  });

  it('refuses past the tenant quotas (waiting reminders, reminders per day)', async () => {
    hoisted.resolveEffectiveLimits.mockResolvedValue({ quotas: { maxActiveAgentReminders: 5, maxAgentRemindersPerDay: 10 } });
    hoisted.db.countAgentRunsByStatus.mockResolvedValueOnce({ scheduled: 5 });
    expect(await scheduleReminder(input())).toEqual({ ok: false, reason: expect.stringContaining('limit of waiting reminders') });
    hoisted.db.countAgentRunsByStatus.mockResolvedValueOnce({ scheduled: 1 }).mockResolvedValueOnce({ scheduled: 1, succeeded: 9 });
    expect(await scheduleReminder(input())).toEqual({ ok: false, reason: expect.stringContaining('daily limit') });
    const perDay = hoisted.db.countAgentRunsByStatus.mock.calls.at(-1)![1];
    expect(perDay).toMatchObject({ channel: 'reminder', createdAfter: expect.any(Date) });
  });

  it('a full queue or an internal error is a refusal, never a throw', async () => {
    hoisted.startAgentRun.mockResolvedValueOnce({ kind: 'concurrency_limit', limit: 1, scope: 'tenant', runClass: 'deferred' });
    expect(await scheduleReminder(input())).toEqual({ ok: false, reason: expect.stringContaining('queue is full') });
    hoisted.startAgentRun.mockRejectedValueOnce(new Error('boom'));
    expect(await scheduleReminder(input())).toEqual({ ok: false, reason: 'The reminder could not be set right now.' });
  });
});

describe('cancelReminder / fireReminderNow', () => {
  const actor = { userId: 'user-1', via: 'dashboard' as const };

  it('cancel: only a reminder of the given session, only while it waits', async () => {
    hoisted.db.getAgentRunById.mockResolvedValue(run({ conversationId: 'conv-2' }));
    expect(await cancelReminder(SCOPE, 'run_rem-1', { conversationId: 'conv-1', actor })).toEqual({ kind: 'not_found' });
    hoisted.db.getAgentRunById.mockResolvedValue(run({ channel: 'runs' }));
    expect(await cancelReminder(SCOPE, 'run_rem-1', { actor })).toEqual({ kind: 'not_found' });
    hoisted.db.getAgentRunById.mockResolvedValue(run({ status: 'succeeded' }));
    expect(await cancelReminder(SCOPE, 'run_rem-1', { actor })).toMatchObject({ kind: 'not_scheduled' });
    hoisted.db.getAgentRunById.mockResolvedValue(run());
    hoisted.cancelAgentRun.mockResolvedValue({ kind: 'accepted', run: run({ status: 'canceled' }) });
    expect(await cancelReminder(SCOPE, 'run_rem-1', { actor })).toMatchObject({ kind: 'canceled' });
    expect(hoisted.recordAuditLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: 'agent.reminder.canceled' }));
  });

  it('fire now: refuses a session that waits on a person, promotes and publishes otherwise', async () => {
    hoisted.db.getAgentRunById.mockResolvedValue(run());
    hoisted.db.findAgentConversationById.mockResolvedValue({ _id: 'conv-1', projectId: 'proj-1', runtimeStatus: 'requires_action' });
    expect(await fireReminderNow(SCOPE, 'run_rem-1', { actor })).toMatchObject({ kind: 'busy' });

    hoisted.db.findAgentConversationById.mockResolvedValue({ _id: 'conv-1', projectId: 'proj-1', runtimeStatus: 'idle' });
    hoisted.db.promoteScheduledAgentRun.mockRejectedValueOnce(new AgentRunConflictError('conv-1'));
    expect(await fireReminderNow(SCOPE, 'run_rem-1', { actor })).toEqual({ kind: 'busy', message: 'Another run is active in this session.' });

    hoisted.db.promoteScheduledAgentRun.mockResolvedValueOnce(run({ status: 'queued', runClass: 'default' }));
    expect(await fireReminderNow(SCOPE, 'run_rem-1', { actor })).toMatchObject({ kind: 'fired' });
    expect(hoisted.publishAgentRunJob).toHaveBeenCalled();

    hoisted.db.promoteScheduledAgentRun.mockResolvedValueOnce(run({ status: 'queued', runClass: 'deferred' }));
    await fireReminderNow(SCOPE, 'run_rem-1', { actor });
    expect(hoisted.dispatchDeferredRuns).toHaveBeenCalledWith('tenant_acme', 'tenant-1');
  });
});

describe('resolveRemindersConfig', () => {
  it('is off unless the agent turns it on, and the platform can turn it off for everyone', () => {
    expect(resolveRemindersConfig(undefined)).toMatchObject({ enabled: false, available: false });
    expect(resolveRemindersConfig({ enabled: true })).toMatchObject({ enabled: true, available: true, runClass: 'deferred', whenBusy: 'postpone', afterUntrustedContent: 'approve' });
    expect(resolveRemindersConfig({ enabled: true }, { ...REMINDER_PLATFORM_DEFAULTS, enabled: false })).toMatchObject({ enabled: true, available: false });
  });

  it('clamps every limit by the platform', () => {
    const resolved = resolveRemindersConfig(
      { enabled: true, minDelaySeconds: 10, maxHorizonHours: 1000, maxActivePerSession: 50, maxFiresPerSession: 500 },
      { enabled: true, minDelaySeconds: 120, maxHorizonHours: 24, maxActivePerSession: 5, maxFiresPerSession: 40 },
    );
    expect(resolved).toMatchObject({ minDelaySeconds: 120, maxHorizonHours: 24, maxActivePerSession: 5, maxFiresPerSession: 40 });
  });
});

describe('config validation', () => {
  it('flags bad reminder settings and warns where the platform lowers them', () => {
    const issues = validateAgentConfigShape({
      reminders: {
        enabled: 'yes' as never,
        minDelaySeconds: 5,
        maxHorizonHours: 10_000,
        whenBusy: 'later' as never,
        instructions: 'x'.repeat(2001),
        maxActivePerSession: 500,
      },
    });
    const fields = issues.errors.map((issue) => issue.field);
    expect(fields).toEqual(expect.arrayContaining([
      'reminders.enabled', 'reminders.minDelaySeconds', 'reminders.maxHorizonHours', 'reminders.whenBusy', 'reminders.instructions',
    ]));
    expect(issues.warnings.map((issue) => issue.field)).toContain('reminders.maxActivePerSession');
  });

  it('accepts a valid block', () => {
    const issues = validateAgentConfigShape({ reminders: { enabled: true, minDelaySeconds: 120, maxHorizonHours: 24, runClass: 'default', afterUntrustedContent: 'deny' } });
    expect(issues.errors.filter((issue) => issue.field.startsWith('reminders'))).toEqual([]);
  });
});
