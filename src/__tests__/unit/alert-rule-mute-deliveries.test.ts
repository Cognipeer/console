import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

type LooseDb = Record<string, import('vitest').Mock>;

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));
vi.mock('@/lib/services/alerts/metrics', () => ({
  collectMetric: vi.fn().mockResolvedValue({ value: 10, sampleCount: 5 }),
}));
vi.mock('@/lib/services/alerts/channels', () => ({
  dispatchNotification: vi.fn(),
}));
vi.mock('@/lib/services/webhooks/webhookService', () => ({
  publishWebhookEvent: vi.fn().mockResolvedValue({ eventId: null, deliveries: 0 }),
}));
vi.mock('@/lib/license/tenantLicense', () => ({
  isTenantEnterpriseLicensed: vi.fn().mockResolvedValue(false),
}));

import {
  __resetEvaluatorCachesForTests,
  evaluateTenantAlerts,
  lastEvaluationDue,
} from '@/lib/services/alerts/alertEvaluator';
import { getTenantDatabase } from '@/lib/database';
import { collectMetric } from '@/lib/services/alerts/metrics';
import { dispatchNotification } from '@/lib/services/alerts/channels';
import { publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import type { IAlertRule, IAlertState, IIncident } from '@/lib/database';

const ctx = { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', tenantSlug: 'acme', companyName: 'Acme Corp' };
const T0 = Date.UTC(2026, 9, 15, 12, 2, 30);
const MIN = 60_000;

const rule: IAlertRule = {
  _id: 'rule-1',
  tenantId: 'tenant-1',
  projectId: 'proj-1',
  name: 'High Error Rate',
  module: 'models',
  metric: 'error_rate',
  condition: { operator: 'gt', threshold: 5 },
  windowMinutes: 15,
  cooldownMinutes: 60,
  enabled: true,
  channels: [{ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['ops@acme.com'] }],
  createdBy: 'user-1',
};

interface Harness {
  db: LooseDb;
  rules: IAlertRule[];
  states: Map<string, IAlertState>;
  incidents: Map<string, Record<string, unknown>>;
  deliveries: Array<Record<string, unknown>>;
}

function createHarness(): Harness {
  const db = createMockDb() as unknown as LooseDb;
  const h: Harness = { db, rules: [], states: new Map(), incidents: new Map(), deliveries: [] };
  const events: Array<Record<string, unknown>> = [];
  (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.listAlertRules.mockImplementation(async () => h.rules);
  db.findAlertRuleById.mockImplementation(async (id: string) => h.rules.find((r) => String(r._id) === id) ?? null);
  db.findProjectById.mockResolvedValue({ _id: 'proj-1', name: 'Main Project', key: 'main', tenantId: 'tenant-1', createdBy: 'user-1' });
  db.listAlertStates.mockImplementation(async (filter: { ruleId?: string }) =>
    [...h.states.values()].filter((s) => !filter.ruleId || s.ruleId === filter.ruleId));
  db.upsertAlertState.mockImplementation(async (state: IAlertState) => {
    const stored = { ...state, _id: `${state.ruleId}|${state.entityKey}` };
    h.states.set(`${state.ruleId}|${state.entityKey}`, stored);
    return stored;
  });
  db.deleteAlertStates.mockResolvedValue(0);
  db.createAlertEvent.mockImplementation(async (event: Record<string, unknown>) => {
    const stored = { ...event, _id: `event-${events.length + 1}` };
    events.push(stored);
    return stored;
  });
  db.updateAlertEvent.mockResolvedValue(null);
  db.createIncident.mockImplementation(async (incident: Record<string, unknown>) => {
    const stored = { ...incident, _id: `incident-${h.incidents.size + 1}` };
    h.incidents.set(String(stored._id), stored);
    return stored;
  });
  db.findIncidentById.mockImplementation(async (id: string) => (h.incidents.get(id) ?? null) as IIncident | null);
  db.updateIncident.mockImplementation(async (id: string, data: Record<string, unknown>) => {
    const incident = h.incidents.get(id);
    if (incident) Object.assign(incident, data);
    return incident ?? null;
  });
  db.updateAlertRule.mockResolvedValue(null);
  db.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });
  db.createAlertDeliveries = vi.fn(async (rows: Array<Record<string, unknown>>) => { h.deliveries.push(...rows); });
  db.pruneAlertDeliveries = vi.fn().mockResolvedValue(0);
  return h;
}

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  __resetEvaluatorCachesForTests();
  (dispatchNotification as ReturnType<typeof vi.fn>).mockImplementation(async (notification: { kind: string }) => [
    { type: 'email', target: 'ops@acme.com', success: true, channelId: 'ch_aaaaaaaaaaaa', kind: notification.kind, at: new Date() },
  ]);
  (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 10, sampleCount: 5 });
  h = createHarness();
});

afterEach(() => {
  vi.useRealTimers();
});

async function tick(minutesLater = 0): Promise<number> {
  vi.setSystemTime(T0 + minutesLater * MIN);
  return evaluateTenantAlerts(ctx);
}

const dispatchedKinds = () => (dispatchNotification as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].kind);

describe('delivery log', () => {
  it('records fire, renotify and resolve deliveries with channel, trigger and status', async () => {
    h.rules = [{ ...rule, renotifyMinutes: 30 }];
    await tick();
    await tick(31);
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 1, sampleCount: 5 });
    await tick(32);
    await tick(33);

    expect(h.deliveries.map((d) => d.trigger)).toEqual(['fire', 'renotify', 'resolve']);
    expect(h.deliveries[0]).toMatchObject({
      tenantId: 'tenant-1', projectId: 'proj-1', ruleId: 'rule-1', incidentId: 'incident-1', eventId: 'event-1',
      channelId: 'ch_aaaaaaaaaaaa', channelKind: 'email', status: 'sent', reason: null,
    });
    expect(h.deliveries[2]).toMatchObject({ incidentId: 'incident-1', eventId: 'event-1', status: 'sent' });
  });

  it('stores failures with a clipped error', async () => {
    (dispatchNotification as ReturnType<typeof vi.fn>).mockResolvedValue([
      { type: 'slack', target: 'hooks.slack.com/…', success: false, error: 'x'.repeat(900), channelId: 'ch_bbbbbbbbbbbb', at: new Date() },
    ]);
    h.rules = [rule];
    await tick();
    expect(h.deliveries).toHaveLength(1);
    expect(h.deliveries[0]).toMatchObject({ status: 'failed', channelKind: 'slack' });
    expect((h.deliveries[0].error as string).length).toBeLessThanOrEqual(500);
  });

  it('never breaks the evaluation when the log cannot be written', async () => {
    h.db.createAlertDeliveries.mockRejectedValue(new Error('disk full'));
    h.rules = [rule];
    expect(await tick()).toBe(1);
  });
});

describe('rule mute', () => {
  const muted = (minutes: number): Partial<IAlertRule> => ({ mutedUntil: new Date(T0 + minutes * MIN), mutedBy: 'u1' });

  it('keeps evaluating (incident, event, state) but skips the channels and logs suppressed deliveries', async () => {
    h.rules = [{ ...rule, ...muted(120) }];
    expect(await tick()).toBe(1);
    expect(dispatchNotification).not.toHaveBeenCalled();
    expect(h.incidents.size).toBe(1);
    expect(h.states.get('rule-1|')).toMatchObject({ phase: 'firing', incidentId: 'incident-1' });
    expect(h.deliveries).toEqual([
      expect.objectContaining({ trigger: 'fire', status: 'suppressed', reason: 'rule_muted', channelId: 'ch_aaaaaaaaaaaa', incidentId: 'incident-1' }),
    ]);
    // integrations still get the event
    expect(publishWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert.fired' }));
  });

  it('suppresses resolve and renotify while muted, and notifies again once the mute expired', async () => {
    h.rules = [{ ...rule, renotifyMinutes: 30, ...muted(60) }];
    await tick();
    await tick(31);
    expect(h.deliveries.map((d) => [d.trigger, d.status])).toEqual([['fire', 'suppressed'], ['renotify', 'suppressed']]);

    // mute expires at +60: the next renotify goes out
    await tick(65);
    expect(dispatchedKinds()).toEqual(['renotify']);
    expect(h.deliveries.at(-1)).toMatchObject({ trigger: 'renotify', status: 'sent' });

    h.rules = [{ ...rule, renotifyMinutes: 30, ...muted(300) }];
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 1, sampleCount: 5 });
    await tick(66);
    await tick(67);
    expect(h.deliveries.at(-1)).toMatchObject({ trigger: 'resolve', status: 'suppressed', reason: 'rule_muted' });
    expect(dispatchedKinds()).toEqual(['renotify']);
  });

  it('an expired mute does not suppress', async () => {
    h.rules = [{ ...rule, ...muted(-5) }];
    await tick();
    expect(dispatchedKinds()).toEqual(['fired']);
  });
});

describe('incident snooze', () => {
  it('suppresses a renotify of a snoozed incident, advancing the renotify clock, and renotifies after the snooze', async () => {
    h.rules = [{ ...rule, renotifyMinutes: 30 }];
    await tick();
    h.incidents.get('incident-1')!.snoozedUntil = new Date(T0 + 45 * MIN);
    await tick(31);
    expect(dispatchedKinds()).toEqual(['fired']);
    expect(h.deliveries.at(-1)).toMatchObject({ trigger: 'renotify', status: 'suppressed', reason: 'incident_snoozed' });
    expect(h.states.get('rule-1|')!.lastNotifiedAt).toEqual(new Date(T0 + 31 * MIN));

    await tick(50); // 19 min after the suppressed one: not due
    expect(dispatchedKinds()).toEqual(['fired']);
    await tick(62); // snooze over, due again
    expect(dispatchedKinds()).toEqual(['fired', 'renotify']);
  });

  it('still tells about the resolution of a snoozed incident', async () => {
    h.rules = [rule];
    await tick();
    h.incidents.get('incident-1')!.snoozedUntil = new Date(T0 + 600 * MIN);
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 1, sampleCount: 5 });
    await tick(1);
    await tick(2);
    expect(dispatchedKinds()).toEqual(['fired', 'resolved']);
  });
});

describe('rule.lastEvaluation', () => {
  const evaluationWrites = () =>
    h.db.updateAlertRule.mock.calls.filter((call) => 'lastEvaluation' in (call[1] as Record<string, unknown>));

  it('is written when first seen, then only when it changed or is 15 minutes stale', async () => {
    h.rules = [rule];
    await tick();
    expect(evaluationWrites()).toHaveLength(1);
    expect(evaluationWrites()[0][1]).toEqual({ lastEvaluation: { at: new Date(T0), targets: 1, noDataTargets: 0 } });

    // the harness rule is not refreshed by the write; emulate the stored value
    h.rules = [{ ...rule, lastEvaluation: { at: new Date(T0), targets: 1, noDataTargets: 0 } }];
    await tick(5);
    expect(evaluationWrites()).toHaveLength(1);

    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 0, sampleCount: 0 });
    await tick(6);
    expect(evaluationWrites()).toHaveLength(2);
    expect(evaluationWrites()[1][1]).toEqual({ lastEvaluation: { at: new Date(T0 + 6 * MIN), targets: 1, noDataTargets: 1 } });
  });

  it('lastEvaluationDue: unchanged and fresh = skip, changed or stale = write', () => {
    const now = new Date(T0);
    const prev = { at: new Date(T0 - 14 * MIN), targets: 3, noDataTargets: 1 };
    expect(lastEvaluationDue(prev, { targets: 3, noDataTargets: 1 }, now)).toBe(false);
    expect(lastEvaluationDue(prev, { targets: 3, noDataTargets: 2 }, now)).toBe(true);
    expect(lastEvaluationDue(prev, { targets: 4, noDataTargets: 1 }, now)).toBe(true);
    expect(lastEvaluationDue({ ...prev, at: new Date(T0 - 15 * MIN) }, { targets: 3, noDataTargets: 1 }, now)).toBe(true);
    expect(lastEvaluationDue(undefined, { targets: 0, noDataTargets: 0 }, now)).toBe(true);
  });
});
