import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

/** The mock db with every method as a plain vitest mock: tests feed it partial rows. */
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
vi.mock('@/lib/services/alerts/metricCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/alerts/metricCatalog')>();
  return { ...actual, getMetricDef: vi.fn(actual.getMetricDef) };
});

import {
  __resetEvaluatorCachesForTests,
  advanceAlertState,
  evaluateTenantAlerts,
  type StateStepInput,
} from '@/lib/services/alerts/alertEvaluator';
import { getTenantDatabase } from '@/lib/database';
import { collectMetric } from '@/lib/services/alerts/metrics';
import { dispatchNotification } from '@/lib/services/alerts/channels';
import { publishWebhookEvent } from '@/lib/services/webhooks/webhookService';
import { isTenantEnterpriseLicensed } from '@/lib/license/tenantLicense';
import { getMetricDef } from '@/lib/services/alerts/metricCatalog';
import {
  __resetAlertExtensionsForTests,
  registerEntityBaselineProvider,
  registerIncidentEnricher,
  registerSloBurnEvaluator,
} from '@/enterprise/alert-extensions';
import type { IAlertRule, IAlertState, IIncident } from '@/lib/database';

const ctx = {
  tenantDbName: 'tenant_acme',
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  companyName: 'Acme Corp',
};

const T0 = Date.UTC(2026, 9, 15, 12, 2, 30); // 12:02:30 UTC
const MIN = 60_000;

const legacyRule: IAlertRule = {
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
  channels: [{ type: 'email', recipients: ['ops@acme.com'] }],
  createdBy: 'user-1',
};

const agentRule: IAlertRule = {
  ...legacyRule,
  _id: 'rule-agents',
  name: 'Agent errors',
  module: 'agents',
  metric: 'agent_error_rate',
  condition: { operator: 'gt', threshold: 10, mode: 'threshold' },
  windowMinutes: 15,
  cooldownMinutes: 0,
  entity: { entityType: 'agent', mode: 'all' },
};

interface Harness {
  db: LooseDb;
  rules: IAlertRule[];
  states: Map<string, IAlertState>;
  events: Array<Record<string, unknown>>;
  incidents: Map<string, Record<string, unknown>>;
  /** Counters served for the CURRENT window / the history window (absence). */
  current: Record<string, Record<string, number>>;
  history: Record<string, Record<string, number>>;
  aggregateCalls: Array<Record<string, unknown>>;
}

function stateKey(ruleId: string, entityKey: string) {
  return `${ruleId}|${entityKey}`;
}

function createHarness(): Harness {
  const db = createMockDb() as unknown as LooseDb;
  const h: Harness = {
    db,
    rules: [],
    states: new Map(),
    events: [],
    incidents: new Map(),
    current: {},
    history: {},
    aggregateCalls: [],
  };
  (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);

  db.listAlertRules.mockImplementation(async () => h.rules);
  db.findAlertRuleById.mockImplementation(async (id: string) => h.rules.find((rule) => String(rule._id) === id) ?? null);
  db.findProjectById.mockResolvedValue({ _id: 'proj-1', name: 'Main Project', key: 'main', tenantId: 'tenant-1', createdBy: 'user-1' });
  db.listAlertStates.mockImplementation(async (filter: { ruleId?: string }) =>
    [...h.states.values()].filter((s) => !filter.ruleId || s.ruleId === filter.ruleId));
  db.upsertAlertState.mockImplementation(async (state: IAlertState) => {
    const stored = { ...state, _id: stateKey(state.ruleId, state.entityKey) };
    h.states.set(stateKey(state.ruleId, state.entityKey), stored);
    return stored;
  });
  db.deleteAlertStates.mockImplementation(async (filter: { ruleId: string; entityKeys?: string[] }) => {
    let removed = 0;
    for (const [key, state] of h.states) {
      if (state.ruleId !== filter.ruleId) continue;
      if (filter.entityKeys && !filter.entityKeys.includes(state.entityKey)) continue;
      h.states.delete(key);
      removed += 1;
    }
    return removed;
  });
  db.createAlertEvent.mockImplementation(async (event: Record<string, unknown>) => {
    const stored = { ...event, _id: `event-${h.events.length + 1}` };
    h.events.push(stored);
    return stored;
  });
  db.updateAlertEvent.mockImplementation(async (id: string, data: Record<string, unknown>) => {
    const event = h.events.find((e) => e._id === id);
    if (!event) return null;
    Object.assign(event, data);
    return event;
  });
  db.createIncident.mockImplementation(async (incident: Record<string, unknown>) => {
    const stored = { ...incident, _id: `incident-${h.incidents.size + 1}` };
    h.incidents.set(String(stored._id), stored);
    return stored;
  });
  db.findIncidentById.mockImplementation(async (id: string) => (h.incidents.get(id) ?? null) as IIncident | null);
  db.updateIncident.mockImplementation(async (id: string, data: Record<string, unknown>) => {
    const incident = h.incidents.get(id);
    if (!incident) return null;
    Object.assign(incident, data);
    return incident;
  });
  db.updateAlertRule.mockResolvedValue(null);
  db.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });
  db.aggregateEntityMetrics.mockImplementation(async (q: { fromMs: number; toMs: number; entityKeys?: string[] }) => {
    h.aggregateCalls.push(q as unknown as Record<string, unknown>);
    const alignedNow = Date.now() - (Date.now() % 300_000);
    const source = q.toMs === alignedNow ? h.current : h.history;
    return Object.entries(source)
      .filter(([key]) => !q.entityKeys || q.entityKeys.includes(key))
      .map(([entityKey, counters]) => ({ entityKey, ...counters }));
  });
  return h;
}

/** All dispatched notifications, oldest first. */
function dispatched() {
  return (dispatchNotification as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
}

function kinds() {
  return dispatched().map((n) => n.kind);
}

let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
  __resetEvaluatorCachesForTests();
  (dispatchNotification as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: 'email', target: 'ops@acme.com', success: true }]);
  (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 10, sampleCount: 5 });
  (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  h = createHarness();
});

afterEach(() => {
  vi.useRealTimers();
  __resetAlertExtensionsForTests();
});

async function tick(minutesLater = 0): Promise<number> {
  vi.setSystemTime(T0 + minutesLater * MIN);
  return evaluateTenantAlerts(ctx);
}

// ── Pure state machine ──────────────────────────────────────────────────────

describe('advanceAlertState', () => {
  const now = new Date(T0);
  const base: Omit<StateStepInput, 'prev' | 'breached'> = {
    value: 20,
    now,
    forMinutes: 0,
    cooldownMinutes: 0,
    renotifyMinutes: 0,
    worse: 'max',
  };
  function state(partial: Partial<IAlertState>): IAlertState {
    return {
      tenantId: 't',
      projectId: 'p',
      ruleId: 'r',
      entityKey: 'e',
      phase: 'ok',
      phaseSince: new Date(T0 - 60 * MIN),
      breachStreak: 0,
      okStreak: 0,
      lastValue: null,
      lastBaseline: null,
      lastSampleCount: 0,
      lastEvaluatedAt: new Date(T0 - MIN),
      ...partial,
    };
  }

  it('ok -> firing in one step when forMinutes is 0', () => {
    const step = advanceAlertState({ ...base, prev: null, breached: true });
    expect(step).toMatchObject({ phase: 'firing', action: 'fire', breachStreak: 1, okStreak: 0, peakValue: 20 });
  });

  it('ok -> pending -> firing across forMinutes', () => {
    const first = advanceAlertState({ ...base, forMinutes: 10, prev: null, breached: true });
    expect(first).toMatchObject({ phase: 'pending', action: 'none', breachStreak: 1 });
    const mid = advanceAlertState({
      ...base, forMinutes: 10, now: new Date(T0 + 5 * MIN), breached: true,
      prev: state({ phase: 'pending', phaseSince: first.phaseSince, breachStreak: 1 }),
    });
    expect(mid).toMatchObject({ phase: 'pending', action: 'none', breachStreak: 2 });
    const due = advanceAlertState({
      ...base, forMinutes: 10, now: new Date(T0 + 10 * MIN), breached: true,
      prev: state({ phase: 'pending', phaseSince: first.phaseSince, breachStreak: 2 }),
    });
    expect(due).toMatchObject({ phase: 'firing', action: 'fire' });
  });

  it('pending falls back to ok when the breach clears before forMinutes', () => {
    const step = advanceAlertState({ ...base, prev: state({ phase: 'pending', breachStreak: 2 }), breached: false });
    expect(step).toMatchObject({ phase: 'ok', action: 'none', breachStreak: 0, okStreak: 1 });
  });

  it('firing resolves only after two ok evaluations; a new breach resets the streak', () => {
    const firing = state({ phase: 'firing', breachStreak: 5, peakValue: 30 });
    const one = advanceAlertState({ ...base, prev: firing, breached: false });
    expect(one).toMatchObject({ phase: 'firing', action: 'none', okStreak: 1 });
    const two = advanceAlertState({ ...base, prev: state({ ...firing, okStreak: 1 }), breached: false });
    expect(two).toMatchObject({ phase: 'ok', action: 'resolve', okStreak: 2 });
    const relapse = advanceAlertState({ ...base, prev: state({ ...firing, okStreak: 1 }), breached: true });
    expect(relapse).toMatchObject({ phase: 'firing', action: 'none', okStreak: 0 });
  });

  it('same-window evaluations count once towards resolving', () => {
    const firing = state({ phase: 'firing', okStreak: 1, detail: { windowKey: 1000 } });
    const same = advanceAlertState({ ...base, windowKey: 1000, prev: firing, breached: false });
    expect(same).toMatchObject({ phase: 'firing', action: 'none', okStreak: 1 });
    const next = advanceAlertState({ ...base, windowKey: 2000, prev: firing, breached: false });
    expect(next).toMatchObject({ phase: 'ok', action: 'resolve', okStreak: 2 });
    // No window recorded (legacy rules, older rows): every tick counts.
    const legacy = advanceAlertState({ ...base, prev: state({ phase: 'firing', okStreak: 1 }), breached: false });
    expect(legacy).toMatchObject({ action: 'resolve' });
  });

  it('peaks at the largest deviation from the baseline for two-sided rules', () => {
    const prev = state({ phase: 'firing', peakValue: 20 });
    const step = (value: number) => advanceAlertState({ ...base, worse: 'farthest', baseline: 10, value, prev, breached: true }).peakValue;
    expect(step(26)).toBe(26); // deviation 16 > 10
    expect(step(2)).toBe(20); // deviation 8 < 10: the earlier peak stays
    expect(step(-1)).toBe(-1); // deviation 11 > 10
  });

  it('tracks the worst value as the peak (max, or min for "less than" rules)', () => {
    const prev = state({ phase: 'firing', peakValue: 30 });
    expect(advanceAlertState({ ...base, value: 25, prev, breached: true }).peakValue).toBe(30);
    expect(advanceAlertState({ ...base, value: 45, prev, breached: true }).peakValue).toBe(45);
    expect(advanceAlertState({ ...base, value: 2, worse: 'min', prev: state({ phase: 'firing', peakValue: 5 }), breached: true }).peakValue).toBe(2);
  });

  it('holds a pending breach back while the last firing is inside the cooldown', () => {
    const lastFiredAt = new Date(T0 - 30 * MIN);
    const held = advanceAlertState({ ...base, cooldownMinutes: 60, prev: state({ lastFiredAt }), breached: true });
    expect(held).toMatchObject({ phase: 'pending', action: 'none' });
    const free = advanceAlertState({ ...base, cooldownMinutes: 60, prev: state({ lastFiredAt: new Date(T0 - 61 * MIN) }), breached: true });
    expect(free).toMatchObject({ phase: 'firing', action: 'fire' });
  });

  it('asks for a re-notification once renotifyMinutes elapsed since the last one', () => {
    const firing = (ago: number) => state({ phase: 'firing', lastNotifiedAt: new Date(T0 - ago * MIN) });
    expect(advanceAlertState({ ...base, renotifyMinutes: 30, prev: firing(29), breached: true }).action).toBe('none');
    expect(advanceAlertState({ ...base, renotifyMinutes: 30, prev: firing(31), breached: true }).action).toBe('renotify_due');
    expect(advanceAlertState({ ...base, renotifyMinutes: 0, prev: firing(600), breached: true }).action).toBe('none');
  });
});

// ── Legacy single-scope rules ───────────────────────────────────────────────

describe('evaluateTenantAlerts: legacy rules', () => {
  beforeEach(() => {
    h.rules = [legacyRule];
  });

  it('returns 0 when no rules exist', async () => {
    h.rules = [];
    expect(await tick()).toBe(0);
  });

  it('fetches only enabled rules', async () => {
    await tick();
    expect(h.db.listAlertRules).toHaveBeenCalledWith('tenant-1', { enabled: true });
  });

  it('fires on a breach: event, incident, notification, webhook, rule-level state', async () => {
    expect(await tick()).toBe(1);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      ruleId: 'rule-1', status: 'fired', kind: 'fired', actualValue: 10, threshold: 5, entityKey: null,
    });
    expect([...h.incidents.values()][0]).toMatchObject({
      ruleId: 'rule-1', module: 'models', status: 'open', alertEventId: 'event-1',
    });
    expect(kinds()).toEqual(['fired']);
    expect(dispatched()[0]).toMatchObject({
      rule: { id: 'rule-1', operator: 'gt', threshold: 5, mode: 'threshold', metricLabel: 'Error Rate', unit: '%' },
      projectName: 'Main Project',
      incidentUrl: expect.stringContaining('/dashboard/alerts/incidents?highlight=incident-1'),
    });
    expect(publishWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alert.fired',
      projectId: 'proj-1',
      data: expect.objectContaining({ ruleId: 'rule-1', metric: 'error_rate', incidentId: 'incident-1' }),
    }));
    expect(h.states.get(stateKey('rule-1', ''))).toMatchObject({
      phase: 'firing', incidentId: 'incident-1', eventId: 'event-1', peakValue: 10,
    });
    expect(h.db.updateAlertRule).toHaveBeenCalledWith('rule-1', expect.objectContaining({ lastTriggeredAt: expect.any(Date) }));
    expect(h.events[0].channels).toEqual([{ type: 'email', target: 'ops@acme.com', success: true }]);
  });

  it('stays firing without a second event or incident while the breach continues', async () => {
    await tick();
    expect(await tick(1)).toBe(0);
    expect(await tick(2)).toBe(0);
    expect(h.events).toHaveLength(1);
    expect(h.incidents.size).toBe(1);
    expect(kinds()).toEqual(['fired']);
  });

  it('resolves after two ok evaluations: event, incident, notification, webhook', async () => {
    await tick();
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 2, sampleCount: 5 });
    await tick(1);
    expect(h.events[0].status).toBe('fired');
    await tick(2);

    expect(h.events[0]).toMatchObject({ status: 'resolved', kind: 'resolved', resolvedAt: new Date(T0 + 2 * MIN) });
    expect([...h.incidents.values()][0]).toMatchObject({
      status: 'resolved', autoResolved: true, resolvedBy: 'system',
      notes: [expect.objectContaining({ userId: 'system', content: 'Automatically resolved: Error Rate back to 2%' })],
    });
    expect(kinds()).toEqual(['fired', 'resolved']);
    expect(publishWebhookEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'alert.resolved',
      data: expect.objectContaining({ incidentId: 'incident-1', resolvedAt: new Date(T0 + 2 * MIN).toISOString() }),
    }));
    expect(h.states.get(stateKey('rule-1', ''))).toMatchObject({ phase: 'ok', incidentId: null, eventId: null });
  });

  it('does not notify on resolve when notifyOnResolve is false', async () => {
    h.rules = [{ ...legacyRule, notifyOnResolve: false }];
    await tick();
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 2, sampleCount: 5 });
    await tick(1);
    await tick(2);
    expect(kinds()).toEqual(['fired']);
    expect(h.events[0].status).toBe('resolved');
  });

  it('a manual resolve while still breaching keeps the state firing and opens no new incident', async () => {
    await tick();
    h.incidents.get('incident-1')!.status = 'closed';
    for (const minute of [1, 2, 3]) expect(await tick(minute)).toBe(0);
    expect(h.incidents.size).toBe(1);
    expect(h.states.get(stateKey('rule-1', ''))).toMatchObject({ phase: 'firing', incidentId: 'incident-1' });

    // Recovery leaves the person's own resolution alone.
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 1, sampleCount: 5 });
    await tick(4);
    await tick(5);
    expect(h.incidents.get('incident-1')).toMatchObject({ status: 'closed' });
    expect(h.incidents.get('incident-1')!.autoResolved).toBeUndefined();
  });

  it('holds a re-breach inside the cooldown, then fires a new incident once it passed', async () => {
    h.rules = [{ ...legacyRule, cooldownMinutes: 60 }];
    await tick();
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 1, sampleCount: 5 });
    await tick(1);
    await tick(2); // resolved
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 10, sampleCount: 5 });
    expect(await tick(10)).toBe(0);
    expect(h.states.get(stateKey('rule-1', ''))).toMatchObject({ phase: 'pending' });
    expect(h.incidents.size).toBe(1);
    expect(await tick(63)).toBe(1);
    expect(h.incidents.size).toBe(2);
  });

  it('waits forMinutes in pending before firing', async () => {
    h.rules = [{ ...legacyRule, condition: { operator: 'gt', threshold: 5, forMinutes: 5 } }];
    expect(await tick()).toBe(0);
    expect(h.states.get(stateKey('rule-1', ''))).toMatchObject({ phase: 'pending' });
    expect(await tick(3)).toBe(0);
    expect(await tick(5)).toBe(1);
  });

  it('re-notifies after renotifyMinutes, but not while a person has acknowledged', async () => {
    h.rules = [{ ...legacyRule, renotifyMinutes: 30 }];
    await tick();
    await tick(29);
    expect(kinds()).toEqual(['fired']);
    await tick(31);
    expect(kinds()).toEqual(['fired', 'renotify']);

    h.incidents.get('incident-1')!.status = 'acknowledged';
    await tick(70);
    await tick(110);
    expect(kinds()).toEqual(['fired', 'renotify']);

    h.incidents.get('incident-1')!.status = 'investigating';
    await tick(150);
    expect(kinds()).toEqual(['fired', 'renotify']);
  });

  it('skips a rule with no data, a rule with too few samples and a rule that is not breached', async () => {
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 0, sampleCount: 0 });
    expect(await tick()).toBe(0);
    h.rules = [{ ...legacyRule, condition: { operator: 'gt', threshold: 5, minSamples: 10 } }];
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 50, sampleCount: 5 });
    expect(await tick(1)).toBe(0);
    h.rules = [legacyRule];
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 3, sampleCount: 5 });
    expect(await tick(2)).toBe(0);
    expect(h.events).toHaveLength(0);
  });

  it('evaluates an empty window as 0 for a zeroWhenEmpty legacy metric so "less than" rules fire', async () => {
    const actual = await vi.importActual<typeof import('@/lib/services/alerts/metricCatalog')>('@/lib/services/alerts/metricCatalog');
    (getMetricDef as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      const def = actual.getMetricDef(id);
      return def && id === 'total_requests' ? { ...def, zeroWhenEmpty: true } : def;
    });
    try {
      h.rules = [{ ...legacyRule, metric: 'total_requests', condition: { operator: 'lt', threshold: 1 } }];
      (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 0, sampleCount: 0 });
      expect(await tick()).toBe(1);
      expect(h.events[0]).toMatchObject({ actualValue: 0 });
    } finally {
      (getMetricDef as ReturnType<typeof vi.fn>).mockImplementation(actual.getMetricDef);
    }
  });

  it.each([
    ['gt', 5, 10, 1],
    ['gt', 10, 10, 0],
    ['gte', 10, 10, 1],
    ['lt', 20, 10, 1],
    ['lt', 10, 10, 0],
    ['lte', 10, 10, 1],
    ['eq', 10, 10, 1],
    ['eq', 11, 10, 0],
  ] as const)('operator %s with threshold %s and value %s fires %s time(s)', async (operator, threshold, value, expected) => {
    h.rules = [{ ...legacyRule, condition: { operator, threshold } }];
    (collectMetric as ReturnType<typeof vi.fn>).mockResolvedValue({ value, sampleCount: 5 });
    expect(await tick()).toBe(expected);
  });

  it('survives a bad rule and still evaluates the others', async () => {
    h.rules = [legacyRule, { ...legacyRule, _id: 'rule-2', metric: 'avg_latency_ms' }];
    (collectMetric as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('metric error'))
      .mockResolvedValueOnce({ value: 10, sampleCount: 5 });
    expect(await tick()).toBe(1);
    expect(h.states.get(stateKey('rule-2', ''))).toMatchObject({ phase: 'firing' });
  });

  it('survives a failing notification: the event and incident exist, the failure is stored', async () => {
    (dispatchNotification as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: 'email', target: 'ops@acme.com', success: false, error: 'smtp down' }]);
    expect(await tick()).toBe(1);
    expect(h.events[0].channels).toEqual([{ type: 'email', target: 'ops@acme.com', success: false, error: 'smtp down' }]);
  });

  it('the ruleFilter decides which rules run', async () => {
    h.rules = [legacyRule, { ...legacyRule, _id: 'rule-2' }];
    const fired = await evaluateTenantAlerts(ctx, { ruleFilter: (rule) => String(rule._id) === 'rule-2' });
    expect(fired).toBe(1);
    expect(h.states.has(stateKey('rule-1', ''))).toBe(false);
  });
});

// ── Entity fan-out ──────────────────────────────────────────────────────────

describe('evaluateTenantAlerts: entity fan-out', () => {
  const failing = { requests: 100, errors: 40 };
  const healthy = { requests: 100, errors: 1 };

  beforeEach(() => {
    h.rules = [agentRule];
  });

  it('keeps one state, event and incident per entity (all agents)', async () => {
    h.current = { pulse: failing, billing: healthy, support: failing };
    expect(await tick()).toBe(2);

    expect(h.events.map((e) => e.entityKey).sort()).toEqual(['pulse', 'support']);
    expect(h.events[0]).toMatchObject({ entityType: 'agent', metric: 'agent_error_rate', sampleCount: 100 });
    expect([...h.incidents.values()].map((i) => i.entityKey).sort()).toEqual(['pulse', 'support']);
    expect([...h.incidents.values()][0]).toMatchObject({ module: 'agents', entityType: 'agent' });
    // A healthy entity leaves no row behind.
    expect(h.states.has(stateKey('rule-agents', 'billing'))).toBe(false);
    expect(dispatched().map((n) => n.entity)).toEqual(
      expect.arrayContaining([{ type: 'agent', key: 'pulse' }, { type: 'agent', key: 'support' }]),
    );
    expect(dispatched()[0].entityUrl).toContain('/dashboard/tracing/agents/');
  });

  it('queries the project window aligned to rollup buckets', async () => {
    h.current = { pulse: failing };
    await tick();
    const call = h.aggregateCalls[0] as { fromMs: number; toMs: number; projectId: string; entityType: string; groupBy: string[] };
    const aligned = T0 - (T0 % 300_000);
    expect(call).toMatchObject({ projectId: 'proj-1', entityType: 'agent', toMs: aligned, fromMs: aligned - 15 * MIN, groupBy: ['entityKey'] });
  });

  it('an entity that appears later gets its own state; one that disappears resolves', async () => {
    h.current = { pulse: failing };
    expect(await tick()).toBe(1);

    h.current = { pulse: failing, support: failing };
    expect(await tick(1)).toBe(1);
    expect(h.states.get(stateKey('rule-agents', 'support'))).toMatchObject({ phase: 'firing' });

    // `pulse` stops reporting: its firing state still counts as a target, sees no data, resolves
    // after 2 evaluated windows (ticks 1-2 still judge the window of 12:00, tick 3 is the next one).
    h.current = { support: failing };
    await tick(2);
    expect(h.states.get(stateKey('rule-agents', 'pulse'))).toMatchObject({ phase: 'firing', okStreak: 1 });
    await tick(3);
    // Resolved: a settled healthy entity leaves no row behind.
    expect(h.states.has(stateKey('rule-agents', 'pulse'))).toBe(false);
    expect(kinds().filter((k) => k === 'resolved')).toHaveLength(1);
  });

  it('past the target cap the busiest entities are kept, and a firing entity always stays so it can resolve', async () => {
    const current: Record<string, { requests: number; errors: number }> = {};
    for (let i = 0; i < 2001; i += 1) current[`busy-${i}`] = { requests: 1000 + i, errors: 0 };
    // Lowest traffic of all, still failing, and already firing.
    current.quiet = { requests: 30, errors: 30 };
    h.current = current;
    h.states.set(stateKey('rule-agents', 'quiet'), {
      tenantId: 'tenant-1', projectId: 'proj-1', ruleId: 'rule-agents', entityKey: 'quiet', phase: 'firing',
      phaseSince: new Date(T0 - 5 * MIN), breachStreak: 5, okStreak: 0, lastValue: 1, lastBaseline: null, lastSampleCount: 30,
      lastEvaluatedAt: new Date(T0 - MIN), incidentId: 'incident-x', eventId: 'event-x', firedAt: new Date(T0 - 5 * MIN),
      lastFiredAt: new Date(T0 - 5 * MIN), lastNotifiedAt: new Date(T0 - 5 * MIN), peakValue: 1,
    } as IAlertState);
    await tick();
    // Still evaluated (its value is refreshed) although 2002 entities compete for 2000 slots.
    expect(h.states.get(stateKey('rule-agents', 'quiet'))).toMatchObject({ phase: 'firing', lastValue: 100 });
    // The least busy healthy entities were the ones left out.
    expect(h.states.has(stateKey('rule-agents', 'busy-0'))).toBe(false);
  });

  it('selected mode evaluates exactly the chosen keys and drops the states of the others', async () => {
    h.current = { pulse: failing, support: failing };
    h.rules = [{ ...agentRule, entity: { entityType: 'agent', mode: 'selected', keys: ['pulse', 'ghost'] } }];
    h.states.set(stateKey('rule-agents', 'old'), {
      tenantId: 'tenant-1', projectId: 'proj-1', ruleId: 'rule-agents', entityKey: 'old', phase: 'firing',
      phaseSince: new Date(T0), breachStreak: 3, okStreak: 0, lastValue: 50, lastBaseline: null, lastSampleCount: 10, lastEvaluatedAt: new Date(T0),
    });
    expect(await tick()).toBe(1);
    expect((h.aggregateCalls[0] as { entityKeys?: string[] }).entityKeys).toEqual(['pulse', 'ghost']);
    expect(h.events.map((e) => e.entityKey)).toEqual(['pulse']);
    expect(h.states.has(stateKey('rule-agents', 'old'))).toBe(false);
  });

  it('ignores an entity with too few samples (no data, not breached)', async () => {
    h.current = { tiny: { requests: 2, errors: 2 } };
    h.rules = [{ ...agentRule, condition: { operator: 'gt', threshold: 10, mode: 'threshold', minSamples: 20 } }];
    expect(await tick()).toBe(0);
  });

  it('count metrics evaluate an empty window as 0 so "less than" rules can fire', async () => {
    h.current = {};
    h.rules = [{
      ...agentRule,
      metric: 'agent_sessions',
      condition: { operator: 'lt', threshold: 1, mode: 'threshold' },
      entity: { entityType: 'agent', mode: 'selected', keys: ['pulse'] },
    }];
    expect(await tick()).toBe(1);
    expect(h.events[0]).toMatchObject({ entityKey: 'pulse', actualValue: 0 });
  });

  it('the incident carries the agent context (version change, error signatures, failing sessions link)', async () => {
    h.current = { pulse: failing };
    h.db.listAgentTracingSessions.mockImplementation(async (filters: { status?: string; from: string }) => {
      if (filters.status === 'error') {
        return {
          sessions: [{ errors: [{ message: 'Timeout after 3000 ms' }] }, { errors: [{ message: 'Timeout after 5000 ms' }] }],
          total: 2,
        };
      }
      return {
        sessions: [
          { agentVersion: '2.0.0', startedAt: new Date(T0 - 2 * MIN) },
          { agentVersion: '1.9.0', startedAt: new Date(T0 - 25 * MIN) },
        ],
        total: 2,
      };
    });
    await tick();
    const incident = [...h.incidents.values()][0] as { context: Record<string, unknown> };
    expect(incident.context).toMatchObject({
      mode: 'threshold',
      windowMinutes: 15,
      versionChange: { from: '1.9.0', to: '2.0.0', firstSeenAt: new Date(T0 - 2 * MIN).toISOString() },
      errorSignatures: [{ message: 'Timeout after <n> ms', count: 2 }],
      failingSessions: { count: 2, listPath: expect.stringContaining('/dashboard/tracing/sessions?agent=pulse&status=error') },
    });
  });

  it('merges what the enterprise enricher adds', async () => {
    h.current = { pulse: failing };
    registerIncidentEnricher(async () => ({
      correlations: [{ entityType: 'model', entityKey: 'gpt-x', metric: 'model_error_rate', value: 30, baseline: 2, ratio: 15 }],
    }));
    await tick();
    const incident = [...h.incidents.values()][0] as { context: { correlations: unknown[] } };
    expect(incident.context.correlations).toHaveLength(1);
  });

  it('severity follows the rule, or the breach when auto', async () => {
    h.current = { pulse: { requests: 100, errors: 40 }, support: { requests: 100, errors: 12 } };
    await tick();
    const bySeverity = Object.fromEntries([...h.incidents.values()].map((i) => [String(i.entityKey), i.severity]));
    // 40 vs threshold 10 -> ratio 4 (critical); 12 vs 10 -> ratio 1.2 (info)
    expect(bySeverity).toEqual({ pulse: 'critical', support: 'info' });

    h.states.clear();
    h.incidents.clear();
    h.events.length = 0;
    h.rules = [{ ...agentRule, severity: 'warning' }];
    await tick(30);
    expect([...h.incidents.values()].map((i) => i.severity)).toEqual(['warning', 'warning']);
  });
});

// ── Absence ─────────────────────────────────────────────────────────────────

describe('evaluateTenantAlerts: absence', () => {
  const absenceRule: IAlertRule = {
    ...agentRule,
    _id: 'rule-absent',
    metric: 'agent_sessions',
    windowMinutes: 15,
    condition: { operator: 'lt', threshold: 1, mode: 'absence', absence: { lookbackHours: 3, minExpectedPerWindow: 2 } },
  };

  beforeEach(() => {
    h.rules = [absenceRule];
  });

  it('fires for an entity that normally has traffic and has none now (critical), not for quiet ones', async () => {
    // 3h history = 12 windows of 15 min: 60 sessions -> 5 per window (>= 2); 6 -> 0.5 per window (< 2)
    h.history = { busy: { requests: 60 }, quiet: { requests: 6 } };
    h.current = {};
    expect(await tick()).toBe(1);
    expect(h.events.map((e) => e.entityKey)).toEqual(['busy']);
    expect([...h.incidents.values()][0]).toMatchObject({ severity: 'critical', entityKey: 'busy' });
  });

  it('resolves once traffic returns', async () => {
    h.history = { busy: { requests: 60 } };
    await tick();
    h.current = { busy: { requests: 7 } };
    await tick(1);
    await tick(6);
    expect(h.states.has(stateKey('rule-absent', 'busy'))).toBe(false);
    expect(kinds()).toEqual(['fired', 'resolved']);
  });

  it('stays firing while the entity is silent even after its traffic aged out of the lookback', async () => {
    h.history = { busy: { requests: 60 } };
    expect(await tick()).toBe(1);
    // The lookback no longer holds enough traffic: busy stops being a candidate, but it is still silent.
    h.history = { busy: { requests: 1 } };
    h.current = {};
    await tick(6);
    await tick(11);
    await tick(16);
    expect(h.states.get(stateKey('rule-absent', 'busy'))).toMatchObject({ phase: 'firing' });
    expect(kinds()).toEqual(['fired']);
    // Only returning traffic resolves it.
    h.current = { busy: { requests: 4 } };
    await tick(21);
    await tick(26);
    expect(kinds()).toEqual(['fired', 'resolved']);
  });

  it('rules with the same window share their aggregates within a sweep', async () => {
    h.rules = [absenceRule, { ...absenceRule, _id: 'rule-absent-2', name: 'Second' }];
    h.history = { busy: { requests: 60 } };
    await tick();
    // One current-window read and one lookback read, not one pair per rule.
    expect(h.aggregateCalls).toHaveLength(2);
  });

  it('an entity that has traffic is not breached', async () => {
    h.history = { busy: { requests: 60 } };
    h.current = { busy: { requests: 3 } };
    expect(await tick()).toBe(0);
  });
});

// ── Enterprise modes ────────────────────────────────────────────────────────

describe('evaluateTenantAlerts: baseline and SLO modes', () => {
  const baselineRule: IAlertRule = {
    ...agentRule,
    _id: 'rule-baseline',
    condition: {
      operator: 'gt', threshold: 0, mode: 'baseline',
      baseline: { direction: 'up', minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily' },
    },
  };

  const result = (partial: Record<string, unknown> = {}) => ({
    breached: true, baseline: 5, lower: 1, upper: 9, z: 8, ratio: 6, points: 14, insufficientHistory: false, ...partial,
  });

  beforeEach(() => {
    h.rules = [baselineRule];
    h.current = { pulse: { requests: 100, errors: 30 }, billing: { requests: 100, errors: 4 } };
  });

  it('without a licence the mode is skipped and the rule is marked, the provider is never called', async () => {
    const evaluate = vi.fn();
    registerEntityBaselineProvider({ evaluate, band: vi.fn() });
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await tick()).toBe(0);
    expect(evaluate).not.toHaveBeenCalled();
    expect(h.states.get(stateKey('rule-baseline', ''))).toMatchObject({
      phase: 'ok', detail: { licenseRequired: true, reason: 'license_required' },
    });
    // Marked once, not rewritten every sweep.
    await tick(1);
    expect(h.db.upsertAlertState).toHaveBeenCalledTimes(1);
  });

  it('without the provider (community build) the mode is skipped as well', async () => {
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    expect(await tick()).toBe(0);
    expect(h.states.get(stateKey('rule-baseline', ''))).toMatchObject({ detail: { reason: 'not_enterprise_build' } });
  });

  it('asks the provider once per rule with every judged target and fires on its verdict', async () => {
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const evaluate = vi.fn(async () => new Map([
      ['pulse', result()],
      ['billing', result({ breached: false, ratio: 0.8, z: 0.2 })],
    ]));
    registerEntityBaselineProvider({ evaluate, band: vi.fn() });
    expect(await tick()).toBe(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    const request = (evaluate.mock.calls[0] as unknown[])[0] as { current: Array<{ entityKey: string; value: number }>; metric: string };
    expect(request.metric).toBe('agent_error_rate');
    expect(request.current.map((c) => c.entityKey).sort()).toEqual(['billing', 'pulse']);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ entityKey: 'pulse', baselineValue: 5 });
    expect(h.states.get(stateKey('rule-baseline', 'pulse'))).toMatchObject({ phase: 'firing', lastBaseline: 5, detail: { z: 8, ratio: 6 } });
    // baseline severity: ratio 6 >= 2 x minRatio(2) -> critical
    expect([...h.incidents.values()][0]).toMatchObject({ severity: 'critical', baselineValue: 5 });
  });

  it('insufficient history never breaches', async () => {
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    registerEntityBaselineProvider({
      evaluate: async () => new Map([['pulse', result({ insufficientHistory: true })]]),
      band: vi.fn(),
    });
    expect(await tick()).toBe(0);
  });

  describe('count metrics', () => {
    const dropRule: IAlertRule = {
      ...agentRule,
      _id: 'rule-drop',
      metric: 'agent_sessions',
      condition: {
        operator: 'lt', threshold: 0, mode: 'baseline',
        baseline: { direction: 'down', minRatio: 2, minZ: 3, minDelta: 0, lookbackDays: 14, seasonality: 'daily' },
      },
    };

    beforeEach(() => {
      (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      h.rules = [dropRule];
    });

    it('judges a drop to 5 requests: the minSamples floor does not apply to the count itself', async () => {
      const evaluate = vi.fn(async () => new Map([['pulse', result({ ratio: 0.17, z: -6, baseline: 30 })]]));
      registerEntityBaselineProvider({ evaluate, band: vi.fn() });
      h.current = { pulse: { requests: 5 } };
      expect(await tick()).toBe(1);
      const request = (evaluate.mock.calls[0] as unknown[])[0] as { current: Array<{ entityKey: string; value: number }> };
      expect(request.current).toEqual([expect.objectContaining({ entityKey: 'pulse', value: 5 })]);
      // A drop to 17% of normal is critical, not just a warning.
      expect([...h.incidents.values()][0]).toMatchObject({ severity: 'critical', peakValue: 5 });
    });

    it('an entity that went completely silent joins as a zero-valued target', async () => {
      const evaluate = vi.fn(async () => new Map([['gone', result({ ratio: 0, z: -9, baseline: 40 })]]));
      registerEntityBaselineProvider({ evaluate, band: vi.fn() });
      h.history = { gone: { requests: 120 } };
      h.current = {};
      expect(await tick()).toBe(1);
      const request = (evaluate.mock.calls[0] as unknown[])[0] as { current: Array<{ entityKey: string; value: number }> };
      expect(request.current).toEqual([expect.objectContaining({ entityKey: 'gone', value: 0 })]);
      expect(h.events.map((e) => e.entityKey)).toEqual(['gone']);
    });

    it('an "up" rule does not look for silent entities', async () => {
      const evaluate = vi.fn(async () => new Map());
      registerEntityBaselineProvider({ evaluate, band: vi.fn() });
      h.rules = [{ ...dropRule, condition: { ...dropRule.condition, baseline: { ...dropRule.condition.baseline!, direction: 'up' } } }];
      h.history = { gone: { requests: 120 } };
      h.current = {};
      await tick();
      expect(evaluate).not.toHaveBeenCalled();
    });
  });

  it('baseline mode needs 20 samples by default', async () => {
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const evaluate = vi.fn(async () => new Map());
    registerEntityBaselineProvider({ evaluate, band: vi.fn() });
    h.current = { pulse: { requests: 10, errors: 9 } };
    await tick();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('SLO burn goes through the seam evaluator and is critical at twice the burn rate', async () => {
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const slo = vi.fn(async () => new Map([
      ['pulse', { breached: true, burnLong: 20, burnShort: 40, attainmentPct: 97, budgetRemainingPct: 10, sampleCount: 500 }],
      ['billing', { breached: false, burnLong: 0.5, burnShort: 0.2, attainmentPct: 99.9, budgetRemainingPct: 90, sampleCount: 500 }],
    ]));
    registerSloBurnEvaluator(slo);
    h.rules = [{
      ...agentRule,
      _id: 'rule-slo',
      condition: {
        operator: 'gt', threshold: 0, mode: 'slo_burn',
        slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 },
      },
    }];
    expect(await tick()).toBe(1);
    expect(slo).toHaveBeenCalledTimes(1);
    expect((slo.mock.calls[0] as unknown[])[0]).toMatchObject({ entityType: 'agent', metric: 'agent_error_rate' });
    expect([...h.incidents.values()][0]).toMatchObject({ entityKey: 'pulse', severity: 'critical' });
  });

  it('SLO burn below the sample floor does not fire', async () => {
    (isTenantEnterpriseLicensed as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    registerSloBurnEvaluator(async () => new Map([
      ['pulse', { breached: true, burnLong: 20, burnShort: 40, attainmentPct: 97, budgetRemainingPct: 10, sampleCount: 10 }],
    ]));
    h.rules = [{
      ...agentRule,
      _id: 'rule-slo',
      condition: { operator: 'gt', threshold: 0, mode: 'slo_burn', slo: { objectivePct: 99, windowDays: 30, burnRate: 14.4, longWindowMinutes: 60, shortWindowMinutes: 5 } },
    }];
    expect(await tick()).toBe(0);
  });
});

// ── Hardening: hysteresis, upgrade, races, storms ───────────────────────────

describe('evaluateTenantAlerts: hardening', () => {
  const failing = { requests: 100, errors: 40 };
  const healthy = { requests: 100, errors: 1 };

  it('counts ok evaluations per distinct data window: minute ticks of one 5-minute bucket resolve nothing', async () => {
    h.rules = [agentRule];
    h.current = { pulse: failing };
    expect(await tick()).toBe(1);
    h.current = { pulse: healthy };
    // 12:03:30 and 12:04:30 still judge the 12:00 window the alert fired on.
    await tick(1);
    await tick(2);
    expect(kinds()).toEqual(['fired']);
    expect(h.states.get(stateKey('rule-agents', 'pulse'))).toMatchObject({ phase: 'firing', okStreak: 1 });
    // 12:05:30 is the next window: the second ok evaluation.
    await tick(3);
    expect(kinds()).toEqual(['fired', 'resolved']);
  });

  it('a blip (bad, good, bad) does not resolve the alert', async () => {
    h.rules = [agentRule];
    h.current = { pulse: failing };
    await tick();
    h.current = { pulse: healthy };
    await tick(1);
    await tick(2);
    h.current = { pulse: failing };
    await tick(3);
    h.current = { pulse: healthy };
    await tick(4);
    expect(kinds()).toEqual(['fired']);
    expect(h.states.get(stateKey('rule-agents', 'pulse'))).toMatchObject({ phase: 'firing' });
  });

  it('an upgraded legacy rule keeps its cooldown from rule.lastTriggeredAt (no immediate re-fire)', async () => {
    h.rules = [{ ...legacyRule, lastTriggeredAt: new Date(T0 - 10 * MIN) }];
    expect(await tick()).toBe(0);
    expect(h.states.get(stateKey('rule-1', ''))).toMatchObject({ phase: 'pending' });
    expect(await tick(30)).toBe(0);
    // 10 + 51 minutes after the last firing the 60 minute cooldown is over.
    expect(await tick(51)).toBe(1);
    expect(kinds()).toEqual(['fired']);
  });

  it('a legacy rule that never fired starts without a cooldown', async () => {
    h.rules = [legacyRule];
    expect(await tick()).toBe(1);
  });

  it('a rule deleted while its notification is in flight leaves no state behind', async () => {
    h.rules = [agentRule];
    h.current = { a: failing, b: failing, c: failing };
    (dispatchNotification as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      h.rules = [];
      return [{ type: 'email', target: 'ops@acme.com', success: true }];
    });
    await tick();
    expect(h.states.size).toBe(0);
    expect(h.db.deleteAlertStates).toHaveBeenCalledWith({ ruleId: 'rule-agents' });
  });

  it('a rule disabled before its turn writes no state', async () => {
    h.rules = [agentRule];
    h.current = { a: failing };
    h.db.findAlertRuleById.mockResolvedValue({ ...agentRule, enabled: false });
    expect(await tick()).toBe(0);
    expect(h.states.size).toBe(0);
  });

  it('a rule whose scope was edited mid-sweep counts as reshaped', async () => {
    h.rules = [legacyRule];
    h.db.findAlertRuleById.mockResolvedValue({ ...legacyRule, scope: { modelKey: 'other' } });
    await tick();
    expect(h.states.size).toBe(0);
  });

  it('a notification storm is paced: at most 50 per rule and sweep, the rest waits with its state', async () => {
    h.rules = [agentRule];
    const current: Record<string, typeof failing> = {};
    for (let i = 0; i < 120; i += 1) current[`agent-${i}`] = failing;
    h.current = current;
    expect(await tick()).toBe(50);
    expect(dispatched()).toHaveLength(50);
    expect([...h.states.values()].filter((st) => st.phase === 'firing')).toHaveLength(50);
    expect([...h.states.values()].filter((st) => st.phase === 'pending')).toHaveLength(70);
    expect(await tick(1)).toBe(50);
    expect(await tick(2)).toBe(20);
    expect(h.events).toHaveLength(120);
    expect(new Set(h.events.map((e) => e.entityKey)).size).toBe(120);
    expect(await tick(3)).toBe(0);
  });

  it('only the first fires of a storm build an incident context', async () => {
    h.rules = [agentRule];
    const current: Record<string, typeof failing> = {};
    for (let i = 0; i < 30; i += 1) current[`agent-${i}`] = failing;
    h.current = current;
    await tick();
    expect(h.db.listAgentTracingSessions.mock.calls.length).toBeLessThan(30 * 3);
    expect(h.incidents.size).toBe(30);
  });

  it('past the tenant deadline no further notification is sent and nothing is lost', async () => {
    h.rules = [agentRule];
    const current: Record<string, typeof failing> = {};
    for (let i = 0; i < 20; i += 1) current[`agent-${i}`] = failing;
    h.current = current;
    (dispatchNotification as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 10_000); // a slow channel
      return [{ type: 'email', target: 'ops@acme.com', success: true }];
    });
    expect(await evaluateTenantAlerts(ctx, { deadlineMs: T0 + 5_000 })).toBe(8);
    expect([...h.states.values()].filter((st) => st.phase === 'pending')).toHaveLength(12);
    // The next sweep (fresh deadline) finishes the job.
    (dispatchNotification as ReturnType<typeof vi.fn>).mockResolvedValue([{ type: 'email', target: 'ops@acme.com', success: true }]);
    vi.setSystemTime(T0 + MIN);
    expect(await evaluateTenantAlerts(ctx)).toBe(12);
  });

  it('stops starting rules once the deadline passed', async () => {
    h.rules = [legacyRule, agentRule];
    expect(await evaluateTenantAlerts(ctx, { deadlineMs: T0 - 1 })).toBe(0);
    expect(h.db.listAlertStates).not.toHaveBeenCalled();
  });

  it('drops the rows of healthy entities once their cooldown is over', async () => {
    h.rules = [{ ...agentRule, cooldownMinutes: 30 }];
    h.current = { pulse: failing };
    await tick();
    h.current = { pulse: healthy };
    await tick(3);
    await tick(8);
    // Resolved, but the cooldown (30 min) still needs the row.
    expect(kinds()).toEqual(['fired', 'resolved']);
    expect(h.states.get(stateKey('rule-agents', 'pulse'))).toMatchObject({ phase: 'ok' });
    await tick(60);
    expect(h.states.has(stateKey('rule-agents', 'pulse'))).toBe(false);
  });

  it('drops healthy rows of entities that stopped reporting altogether', async () => {
    h.rules = [{ ...agentRule, cooldownMinutes: 0 }];
    h.states.set(stateKey('rule-agents', 'old'), {
      tenantId: 'tenant-1', projectId: 'proj-1', ruleId: 'rule-agents', entityKey: 'old', phase: 'ok',
      phaseSince: new Date(T0 - 600 * MIN), breachStreak: 0, okStreak: 3, lastValue: null, lastBaseline: null,
      lastSampleCount: 0, lastEvaluatedAt: new Date(T0 - 600 * MIN),
    } as IAlertState);
    h.current = { pulse: healthy };
    await tick();
    expect(h.states.has(stateKey('rule-agents', 'old'))).toBe(false);
  });
});
