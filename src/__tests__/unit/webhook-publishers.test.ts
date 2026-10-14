/**
 * Where webhook events come from: the session event writer (idle, work done,
 * action required, budget reached — every path that writes the log), a turn's
 * finish / fail, and schedule fires. The webhook service is faked; what is
 * checked is which events are published, in what order, and that a failure
 * there never reaches the code that published.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  publishWebhookEvent: vi.fn(),
  createConversation: vi.fn(),
  executeAgentChat: vi.fn(),
}));

vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhookEvent }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/services/agents/agentService', () => ({
  createConversation: hoisted.createConversation,
  executeAgentChat: hoisted.executeAgentChat,
}));

import { createSessionEventWriter } from '@/lib/services/agents/sessionEvents';
import { startSessionTurnEvents } from '@/lib/services/agents/sessionTurnEvents';
import { runAgentSchedule } from '@/lib/services/agents/agentScheduleService';
import type { IAgent, IAgentSchedule } from '@/lib/database';

const calls = () => hoisted.publishWebhookEvent.mock.calls.map(([input]) => input as { type: string; data: Record<string, unknown>; projectId: string; tenantDbName: string });

function fakeDb(order: string[] = []) {
  return {
    appendAgentSessionEvents: vi.fn(async () => { order.push('stored'); }),
    getAgentSessionMaxSeq: vi.fn(async () => 0),
    updateAgentConversationRuntime: vi.fn(async () => undefined),
  };
}

const scope = { tenantId: 't-1', projectId: 'p-1', agentKey: 'bot', conversationId: 'conv-1' };

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.publishWebhookEvent.mockResolvedValue({ eventId: null, deliveries: 0 });
});

describe('session event writer', () => {
  it('publishes the webhook events of a batch only after the batch is stored', async () => {
    const order: string[] = [];
    hoisted.publishWebhookEvent.mockImplementation(async () => { order.push('published'); });
    const writer = createSessionEventWriter({ db: fakeDb(order), ...scope, tenantDbName: 'tenant_acme' });

    writer.emit('agent.message', { content: 'hi' });
    writer.emit('session.status_idle', { stopReason: 'end_turn' });
    writer.emit('session.work_done', {});
    await writer.close();

    expect(order).toEqual(['stored', 'published', 'published']);
    expect(calls().map((c) => c.type)).toEqual(['session.idled', 'session.work_done']);
    expect(calls()[0]).toMatchObject({
      tenantDbName: 'tenant_acme', projectId: 'p-1',
      data: { sessionId: 'conv-1', conversationId: 'conv-1', agentKey: 'bot', stopReason: 'end_turn' },
    });
  });

  it('publishes nothing without a tenantDbName, or for events that are not webhook events', async () => {
    const plain = createSessionEventWriter({ db: fakeDb(), ...scope });
    plain.emit('session.status_idle', { stopReason: 'end_turn' });
    await plain.close();

    const noisy = createSessionEventWriter({ db: fakeDb(), ...scope, tenantDbName: 'tenant_acme' });
    noisy.emit('agent.tool_use', { name: 'x' });
    noisy.emit('user.message', { content: 'hello' });
    await noisy.close();

    expect(hoisted.publishWebhookEvent).not.toHaveBeenCalled();
  });

  it('survives a publisher that fails', async () => {
    hoisted.publishWebhookEvent.mockRejectedValue(new Error('webhooks down'));
    const db = fakeDb();
    const writer = createSessionEventWriter({ db, ...scope, tenantDbName: 'tenant_acme' });
    writer.emit('session.status_idle', { stopReason: 'end_turn' });
    await expect(writer.close()).resolves.toBeUndefined();
    expect(db.appendAgentSessionEvents).toHaveBeenCalledTimes(1);
  });
});

describe('a turn', () => {
  const turn = () => startSessionTurnEvents({
    db: fakeDb(), tenantDbName: 'tenant_acme', ...scope, userMessage: 'hi', trigger: 'message',
  });

  it('finishing normally publishes session.idled then session.work_done', async () => {
    const events = turn();
    await events.finish({ stopReason: 'end_turn', content: 'done' });
    expect(calls().map((c) => [c.type, c.data.stopReason])).toEqual([
      ['session.idled', 'end_turn'],
      ['session.work_done', undefined],
    ]);
  });

  it('stopping for an approval publishes action.required (ids only) and an idle of requires_action — no work_done', async () => {
    const events = turn();
    events.emitInTurn('action.required', { actionId: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', args: { cmd: 'ls' } });
    await events.finish({ stopReason: 'requires_action', content: '', pendingActionIds: ['act_1'] });
    expect(calls().map((c) => c.type)).toEqual(['action.required', 'session.idled']);
    expect(calls()[0].data).toEqual({ sessionId: 'conv-1', conversationId: 'conv-1', agentKey: 'bot', actionId: 'act_1', kind: 'tool_approval' });
    expect(calls()[1].data.stopReason).toBe('requires_action');
  });

  it('hitting the session budget publishes budget.reached before the idle', async () => {
    const events = turn();
    await events.finish({
      stopReason: 'budget_reached',
      content: 'partial',
      budget: {
        spentUsd: 1.2, turnCostUsd: 0.4, reached: true, budget: { maxCostUsd: 1, onReach: 'pause' },
      } as never,
    });
    expect(calls().map((c) => c.type)).toEqual(['budget.reached', 'session.idled']);
    expect(calls()[0].data).toMatchObject({ spentUsd: 1.2, maxCostUsd: 1 });
  });

  it('a thrown turn publishes session.idled with stopReason error', async () => {
    const events = turn();
    await events.fail(new Error('boom'));
    expect(calls().map((c) => [c.type, c.data.stopReason])).toEqual([['session.idled', 'error']]);
  });
});

describe('schedules', () => {
  const agent = { _id: 'agent-1', key: 'report-bot', projectId: 'p-1' } as unknown as IAgent;
  const schedule = { id: 'sch_1', name: 'Nightly', message: 'run' } as unknown as IAgentSchedule;
  const ctx = (trigger: 'schedule' | 'manual' = 'schedule') => ({
    tenantDbName: 'tenant_acme', tenantId: 't-1', projectId: 'p-1', agent, schedule, trigger, userId: 'system:schedule',
  });

  it('a fire publishes schedule.fired with the conversation it created', async () => {
    hoisted.createConversation.mockResolvedValue({ _id: 'conv-77' });
    hoisted.executeAgentChat.mockResolvedValue({ output: [{ content: [{ text: 'report' }] }] });

    await expect(runAgentSchedule(ctx())).resolves.toEqual({ conversationId: 'conv-77', content: 'report' });

    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({
      type: 'schedule.fired', projectId: 'p-1', tenantDbName: 'tenant_acme',
      data: { scheduleId: 'sch_1', agentKey: 'report-bot', conversationId: 'conv-77', trigger: 'schedule' },
    });
  });

  it('a failed fire publishes schedule.failed with the conversation (when one was made) and a client-safe error, and rethrows', async () => {
    hoisted.createConversation.mockResolvedValue({ _id: 'conv-78' });
    hoisted.executeAgentChat.mockRejectedValue(new Error('upstream exploded at 10.0.0.7:5432 password=hunter2'));

    await expect(runAgentSchedule(ctx('manual'))).rejects.toThrow('upstream exploded');

    const [event] = calls();
    expect(event.type).toBe('schedule.failed');
    expect(event.data).toMatchObject({ scheduleId: 'sch_1', conversationId: 'conv-78', trigger: 'manual' });
    expect(String(event.data.error)).not.toContain('hunter2');
  });

  it('a failure before any conversation exists omits conversationId', async () => {
    hoisted.createConversation.mockRejectedValue(new Error('db down'));
    await expect(runAgentSchedule(ctx())).rejects.toThrow();
    expect(calls()[0].type).toBe('schedule.failed');
    expect(calls()[0].data).not.toHaveProperty('conversationId');
  });
});
