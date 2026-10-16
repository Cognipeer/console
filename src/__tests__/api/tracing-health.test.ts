/**
 * `GET /tracing/agents/health` and `GET /tracing/agents/:agentName/health` on the live tracing
 * plugin: the agent health scoreboard and the per-agent series (entity-metrics rollup), plus the
 * path-param decoding of the plugin's other agent/model handlers.
 *
 * The rollup read service runs for real over a fake tenant db, so zero-filling, sparklines and
 * previous-period handling are the actual ones; only the db and the project context are faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  return {
    ...actual,
    authorizeServiceForRequest: vi.fn(),
    requireProjectContextForRequest: vi.fn(),
    sendProjectContextError: vi.fn().mockReturnValue(null),
  };
});

const fakeDb = vi.hoisted(() => ({
  aggregateEntityMetrics: vi.fn(),
  listAlertRules: vi.fn(),
  listAlertStates: vi.fn(),
  findIncidentById: vi.fn(),
  listIncidents: vi.fn(),
  listAgentTracingSessions: vi.fn(),
}));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: typeof fakeDb) => unknown) => fn(fakeDb)),
}));
vi.mock('@/lib/services/agentTracing', () => ({
  AgentTracingService: { getAgentOverview: vi.fn(), getModelOverview: vi.fn() },
}));
vi.mock('@/lib/services/agents/traceSession', () => ({ resolveTraceSession: vi.fn() }));

import { registerEntityBaselineProvider } from '@/enterprise/alert-extensions';
import { AgentTracingService } from '@/lib/services/agentTracing';
import { authorizeServiceForRequest, requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { tracingApiPlugin } from '@/server/api/plugins/tracing';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CTX = {
  projectId: 'proj-1',
  user: { _id: 'user-1', role: 'member', email: 'a@b.c' },
  session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};

type Range = { fromMs: number; toMs: number; bucketMs: number; sparkFromMs?: number };
type Derived = { requests: number; errors: number; errorRate: number | null; p95Ms: number | null };
type ListBody = {
  range: Range;
  total: number;
  agents: Array<{
    name: string;
    totals: Derived;
    previous: Derived | null;
    spark: { requests: number[]; errorRate: (number | null)[]; p95Ms: (number | null)[] };
    alert: { phase: 'firing' | 'pending' | null; severity?: string; incidentId?: string; covered: boolean };
  }>;
  alertsAvailable: boolean;
};
type DetailBody = {
  range: Range;
  buckets: Array<{ t: number } & Derived>;
  totals: Derived;
  previous: Derived | null;
  baseline: { errorRate: unknown[]; p95Ms: unknown[] } | null;
  markers: Array<{ t: number; type: string; label: string; href?: string }>;
  markersPartial: boolean;
  alerts: { firing: number; pending: number; covered: boolean };
  alertsAvailable: boolean;
};

/** Aggregate rows as the db returns them: `bucketMs` only when the query was bucketed. */
function aggregateRows(spec: {
  current?: Array<{ entityKey: string; bucketMs: number; requests: number; errors?: number; latencyCount?: number; lat2?: number }>;
  previous?: Array<{ entityKey: string; requests: number; errors?: number }>;
}) {
  fakeDb.aggregateEntityMetrics.mockImplementation(async (q: { bucketMs?: number; fromMs: number; entityKeys?: string[] }) => {
    const rows = q.bucketMs !== undefined ? spec.current ?? [] : spec.previous ?? [];
    // Like the db: a keyed query only returns those entities.
    return rows.filter((r) => !q.entityKeys || q.entityKeys.includes(r.entityKey)).map((r) => ({ ...r }));
  });
}

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: parseJsonBody<Record<string, unknown>>(res.body) };
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  mockFn(requireProjectContextForRequest).mockResolvedValue(CTX);
  mockFn(authorizeServiceForRequest).mockResolvedValue({ allowed: true });
  fakeDb.aggregateEntityMetrics.mockResolvedValue([]);
  fakeDb.listAlertRules.mockResolvedValue([]);
  fakeDb.listAlertStates.mockResolvedValue([]);
  fakeDb.findIncidentById.mockResolvedValue(null);
  fakeDb.listIncidents.mockResolvedValue([]);
  fakeDb.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });
  registerEntityBaselineProvider(null);
  app = await createFastifyApiTestApp(async (instance) => {
    await instance.register(tracingApiPlugin);
  });
});

afterEach(async () => {
  registerEntityBaselineProvider(null);
  await app.close();
  vi.useRealTimers();
});

describe('GET /tracing/agents/health', () => {
  it('lists agents busiest first with totals, previous period, sparkline and the aggregate query scope', async () => {
    const t0 = NOW - 24 * HOUR;
    aggregateRows({
      current: [
        { entityKey: 'quiet', bucketMs: t0, requests: 2 },
        { entityKey: '50%off', bucketMs: t0 + 3 * HOUR, requests: 8, errors: 2, latencyCount: 8, lat2: 8 },
        { entityKey: '50%off', bucketMs: t0 + 5 * HOUR, requests: 2, errors: 0, latencyCount: 2, lat2: 2 },
      ],
      previous: [{ entityKey: '50%off', requests: 5, errors: 0 }],
    });

    const { status, body } = await get('/api/tracing/agents/health');
    const data = body as unknown as ListBody;

    expect(status).toBe(200);
    expect(data.range).toEqual({ fromMs: t0, toMs: NOW, bucketMs: HOUR, sparkFromMs: t0 });
    expect(data.total).toBe(2);
    expect(data.agents.map((a) => a.name)).toEqual(['50%off', 'quiet']);
    const busy = data.agents[0]!;
    expect(busy.totals.requests).toBe(10);
    expect(busy.totals.errors).toBe(2);
    expect(busy.totals.errorRate).toBe(20);
    expect(busy.totals.p95Ms).not.toBeNull();
    expect(busy.previous?.requests).toBe(5);
    expect(busy.spark.requests).toHaveLength(24);
    expect(busy.spark.requests[3]).toBe(8);
    expect(busy.spark.requests[5]).toBe(2);
    expect(busy.spark.errorRate[3]).toBe(25);
    expect(busy.spark.errorRate[4]).toBeNull();
    expect(data.agents[1]!.previous).toBeNull();
    expect(data.agents.every((a) => a.alert.phase === null)).toBe(true);

    const queries = fakeDb.aggregateEntityMetrics.mock.calls.map((c) => c[0]);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q).toMatchObject({ tenantId: 'tenant-1', projectId: 'proj-1', entityType: 'agent' });
    }
  });

  it('answers an empty list when nothing was recorded', async () => {
    const { status, body } = await get('/api/tracing/agents/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ agents: [], total: 0 });
  });

  it('resolves the period: default 24h, last_7_days, total bounded to 30 days, explicit from/to', async () => {
    const range = async (query: string) =>
      ((await get(`/api/tracing/agents/health${query}`)).body as unknown as ListBody).range;

    expect(await range('')).toMatchObject({ fromMs: NOW - DAY, toMs: NOW, bucketMs: HOUR });
    expect(await range('?period=last_day')).toMatchObject({ fromMs: NOW - DAY, toMs: NOW });
    expect(await range('?period=last_7_days')).toMatchObject({ fromMs: NOW - 7 * DAY, toMs: NOW, bucketMs: 7 * HOUR });
    expect(await range('?period=total')).toMatchObject({ fromMs: NOW - 30 * DAY, toMs: NOW });
    expect(await range('?period=nonsense')).toMatchObject({ fromMs: NOW - DAY, toMs: NOW });

    const from = '2026-10-14T00:00:00.000Z';
    const to = '2026-10-14T12:00:00.000Z';
    expect(await range(`?period=custom&from=${from}&to=${to}`)).toMatchObject({
      fromMs: Date.parse(from),
      toMs: Date.parse(to),
      bucketMs: 30 * 60_000,
    });
  });

  it('never reads beyond the retention window', async () => {
    const { body } = await get(`/api/tracing/agents/health?from=${encodeURIComponent('2020-01-01T00:00:00Z')}`);
    const data = body as unknown as ListBody;
    expect(data.range.fromMs).toBeGreaterThanOrEqual(NOW - 45 * DAY);
    expect(data.range.toMs).toBe(NOW);
  });

  it('rejects an unusable range with 400', async () => {
    expect((await get('/api/tracing/agents/health?from=not-a-date')).status).toBe(400);
    const reversed = `?from=${encodeURIComponent('2026-10-14T12:00:00Z')}&to=${encodeURIComponent('2026-10-14T06:00:00Z')}`;
    expect((await get(`/api/tracing/agents/health${reversed}`)).status).toBe(400);
    expect(fakeDb.aggregateEntityMetrics).not.toHaveBeenCalled();
  });

  it('applies limit (default 200, max 500) while total stays the full count', async () => {
    const t0 = NOW - 24 * HOUR;
    aggregateRows({
      current: ['a', 'b', 'c'].map((k, i) => ({ entityKey: k, bucketMs: t0, requests: 10 - i })),
    });

    const limited = (await get('/api/tracing/agents/health?limit=2')).body as unknown as ListBody;
    expect(limited.agents.map((a) => a.name)).toEqual(['a', 'b']);
    expect(limited.total).toBe(3);

    for (const limit of ['0', 'abc', '99999']) {
      const res = await get(`/api/tracing/agents/health?limit=${limit}`);
      expect(res.status).toBe(200);
      expect((res.body as unknown as ListBody).agents).toHaveLength(3);
    }
  });

  it('reports the firing and pending alert phase of agent-module rules only', async () => {
    const t0 = NOW - 24 * HOUR;
    aggregateRows({
      current: ['hot', 'warming', 'calm', 'other'].map((k, i) => ({ entityKey: k, bucketMs: t0, requests: 10 - i })),
    });
    fakeDb.listAlertRules.mockResolvedValue([
      { _id: 'rule-agent', module: 'agents', enabled: true, severity: 'auto', entity: { entityType: 'agent', mode: 'all' } },
      { _id: 'rule-model', module: 'models', enabled: true },
    ]);
    fakeDb.listAlertStates.mockResolvedValue([
      { ruleId: 'rule-agent', entityKey: 'hot', phase: 'firing', incidentId: 'inc-1' },
      { ruleId: 'rule-agent', entityKey: 'warming', phase: 'pending' },
      { ruleId: 'rule-agent', entityKey: 'hot', phase: 'pending' },
    ]);
    fakeDb.findIncidentById.mockResolvedValue({ _id: 'inc-1', severity: 'critical' });

    const data = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    const alert = (name: string) => data.agents.find((a) => a.name === name)!.alert;

    expect(alert('hot')).toEqual({ phase: 'firing', severity: 'critical', incidentId: 'inc-1', covered: true });
    expect(alert('warming')).toEqual({ phase: 'pending', covered: true });
    expect(alert('calm')).toEqual({ phase: null, covered: true });
    expect(alert('other')).toEqual({ phase: null, covered: true });

    expect(fakeDb.listAlertRules).toHaveBeenCalledWith('tenant-1', { projectId: 'proj-1', enabled: true });
    expect(fakeDb.listAlertStates).toHaveBeenCalledWith({
      projectId: 'proj-1',
      ruleIds: ['rule-agent'],
      phases: ['pending', 'firing'],
    });
  });

  it('picks the alert to show: rule severity fallback, firing over pending, most severe wins', async () => {
    const t0 = NOW - 24 * HOUR;
    aggregateRows({
      current: ['fallback', 'mixed', 'sev', 'off'].map((k, i) => ({ entityKey: k, bucketMs: t0, requests: 10 - i })),
    });
    fakeDb.listAlertRules.mockResolvedValue([
      { _id: 'r-warn', module: 'agents', enabled: true, severity: 'warning' },
      { _id: 'r-crit', module: 'agents', enabled: true, severity: 'critical' },
    ]);
    // Like the db: only the states of the requested rules come back.
    const allStates = [
      // No incident: the configured severity of the rule is the fallback.
      { ruleId: 'r-warn', entityKey: 'fallback', phase: 'firing' },
      // A pending critical never outranks a firing warning.
      { ruleId: 'r-crit', entityKey: 'mixed', phase: 'pending' },
      { ruleId: 'r-warn', entityKey: 'mixed', phase: 'firing', incidentId: 'inc-w' },
      // Two firing alerts: the most severe one wins.
      { ruleId: 'r-warn', entityKey: 'sev', phase: 'firing', incidentId: 'inc-w2' },
      { ruleId: 'r-crit', entityKey: 'sev', phase: 'firing', incidentId: 'inc-c' },
      // A disabled rule is not listed, so its state never reaches the scoreboard.
      { ruleId: 'r-disabled', entityKey: 'off', phase: 'firing', incidentId: 'inc-x' },
    ];
    fakeDb.listAlertStates.mockImplementation(async (q: { ruleIds: string[] }) =>
      allStates.filter((state) => q.ruleIds.includes(state.ruleId)));
    const incidents: Record<string, { _id: string; severity: string }> = {
      'inc-w': { _id: 'inc-w', severity: 'warning' },
      'inc-w2': { _id: 'inc-w2', severity: 'warning' },
      'inc-c': { _id: 'inc-c', severity: 'critical' },
    };
    fakeDb.findIncidentById.mockImplementation(async (id: string) => incidents[id] ?? null);

    const data = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    const alert = (name: string) => data.agents.find((a) => a.name === name)!.alert;

    expect(alert('fallback')).toMatchObject({ phase: 'firing', severity: 'warning' });
    expect(alert('mixed')).toMatchObject({ phase: 'firing', severity: 'warning', incidentId: 'inc-w' });
    expect(alert('sev')).toMatchObject({ phase: 'firing', severity: 'critical', incidentId: 'inc-c' });
    expect(alert('off')).toMatchObject({ phase: null });
  });

  it('reads incidents only for the firing agents of the returned page', async () => {
    const t0 = NOW - 24 * HOUR;
    aggregateRows({
      current: ['a', 'b', 'c'].map((k, i) => ({ entityKey: k, bucketMs: t0, requests: 10 - i })),
    });
    fakeDb.listAlertRules.mockResolvedValue([{ _id: 'r', module: 'agents', enabled: true, severity: 'auto' }]);
    fakeDb.listAlertStates.mockResolvedValue([
      { ruleId: 'r', entityKey: 'a', phase: 'firing', incidentId: 'inc-a' },
      { ruleId: 'r', entityKey: 'b', phase: 'pending', incidentId: 'inc-b' },
      { ruleId: 'r', entityKey: 'c', phase: 'firing', incidentId: 'inc-c' },
    ]);
    fakeDb.findIncidentById.mockResolvedValue({ _id: 'inc-a', severity: 'info' });

    await get('/api/tracing/agents/health?limit=2');
    expect(fakeDb.findIncidentById.mock.calls.map((c) => c[0])).toEqual(['inc-a']);
  });

  it('still lists an agent that went silent for longer than the range but has an active alert', async () => {
    const t0 = NOW - 24 * HOUR;
    aggregateRows({ current: [{ entityKey: 'busy', bucketMs: t0, requests: 5 }] });
    fakeDb.listAlertRules.mockResolvedValue([{ _id: 'r', module: 'agents', enabled: true, severity: 'critical' }]);
    fakeDb.listAlertStates.mockResolvedValue([{ ruleId: 'r', entityKey: 'gone-quiet', phase: 'firing' }]);

    const data = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    expect(data.agents.map((a) => a.name)).toEqual(['busy', 'gone-quiet']);
    expect(data.total).toBe(2);
    expect(data.agents[1]!.totals.requests).toBe(0);
    expect(data.agents[1]!.alert).toMatchObject({ phase: 'firing', severity: 'critical' });
    const keyed = fakeDb.aggregateEntityMetrics.mock.calls.map((c) => c[0]).filter((q) => q.entityKeys);
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed[0]).toMatchObject({ entityKeys: ['gone-quiet'] });
  });

  it('tells where the sparkline starts when the range is not aligned to its bucket', async () => {
    const from = '2026-10-08T13:00:00.000Z';
    const data = (await get(`/api/tracing/agents/health?from=${encodeURIComponent(from)}`)).body as unknown as ListBody;
    const { fromMs, bucketMs, sparkFromMs } = data.range;
    expect(bucketMs).toBe(7 * HOUR);
    expect(sparkFromMs).toBe(Math.floor(fromMs / bucketMs) * bucketMs);
    expect(sparkFromMs!).toBeLessThan(fromMs);
    expect(fromMs - sparkFromMs!).toBeLessThan(bucketMs);
  });

  it('keeps answering the scoreboard when the alert lookup fails', async () => {
    aggregateRows({ current: [{ entityKey: 'a', bucketMs: NOW - 24 * HOUR, requests: 1 }] });
    fakeDb.listAlertRules.mockRejectedValue(new Error('alerts down'));
    const res = await get('/api/tracing/agents/health');
    expect(res.status).toBe(200);
    const body = res.body as unknown as ListBody;
    expect(body.agents[0]!.alert).toEqual({ phase: null, covered: false });
    expect(body.alertsAvailable).toBe(false);
  });

  it('says which agents an enabled rule watches: all, selected keys, never disabled or legacy-scoped rules', async () => {
    aggregateRows({ current: ['a', 'b', 'c'].map((k) => ({ entityKey: k, bucketMs: NOW - 24 * HOUR, requests: 1 })) });

    // No enabled agent rule: nobody is covered, and the read itself worked.
    let body = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    expect(body.alertsAvailable).toBe(true);
    expect(body.agents.map((a) => a.alert.covered)).toEqual([false, false, false]);

    // Selected rule covers only its keys; a legacy-scoped (no entity) and a models rule cover nothing.
    fakeDb.listAlertRules.mockResolvedValue([
      { _id: 'r1', module: 'agents', enabled: true, entity: { entityType: 'agent', mode: 'selected', keys: ['b'] } },
      { _id: 'r2', module: 'agents', enabled: true },
      { _id: 'r3', module: 'models', enabled: true, entity: { entityType: 'model', mode: 'all' } },
    ]);
    body = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    expect(Object.fromEntries(body.agents.map((a) => [a.name, a.alert.covered]))).toEqual({ a: false, b: true, c: false });

    // A disabled rule never covers.
    fakeDb.listAlertRules.mockResolvedValue([
      { _id: 'r4', module: 'agents', enabled: false, entity: { entityType: 'agent', mode: 'all' } },
    ]);
    body = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    expect(body.agents.every((a) => a.alert.covered === false)).toBe(true);

    // An 'all' rule covers everyone.
    fakeDb.listAlertRules.mockResolvedValue([
      { _id: 'r5', module: 'agents', enabled: true, entity: { entityType: 'agent', mode: 'all' } },
    ]);
    body = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    expect(body.agents.every((a) => a.alert.covered === true)).toBe(true);
  });

  it('hides incident ids from callers without alerts read and keeps phase and severity', async () => {
    aggregateRows({ current: [{ entityKey: 'hot', bucketMs: NOW - 24 * HOUR, requests: 1 }] });
    fakeDb.listAlertRules.mockResolvedValue([
      { _id: 'rule-agent', module: 'agents', enabled: true, entity: { entityType: 'agent', mode: 'all' } },
    ]);
    fakeDb.listAlertStates.mockResolvedValue([{ ruleId: 'rule-agent', entityKey: 'hot', phase: 'firing', incidentId: 'inc-1' }]);
    fakeDb.findIncidentById.mockResolvedValue({ _id: 'inc-1', severity: 'critical' });
    mockFn(authorizeServiceForRequest).mockResolvedValue({ allowed: false });

    const body = (await get('/api/tracing/agents/health')).body as unknown as ListBody;
    expect(body.agents[0]!.alert).toEqual({ phase: 'firing', severity: 'critical', covered: true });
    expect(mockFn(authorizeServiceForRequest).mock.calls[0]!.slice(1)).toEqual(['alerts', { level: 'read' }]);
  });

  it('answers 500 when the rollup read fails', async () => {
    fakeDb.aggregateEntityMetrics.mockRejectedValue(new Error('db down'));
    expect((await get('/api/tracing/agents/health')).status).toBe(500);
  });
});

describe('GET /tracing/agents/:agentName/health', () => {
  it('zero-fills an agent without data and answers empty context', async () => {
    const { status, body } = await get('/api/tracing/agents/ghost/health');
    const data = body as unknown as DetailBody;

    expect(status).toBe(200);
    expect(data.range).toEqual({ fromMs: NOW - DAY, toMs: NOW, bucketMs: HOUR });
    expect(data.buckets).toHaveLength(24);
    expect(data.buckets[0]!.t).toBe(NOW - DAY);
    expect(data.buckets[23]!.t).toBe(NOW - HOUR);
    for (const bucket of data.buckets) {
      expect(bucket.requests).toBe(0);
      expect(bucket.errorRate).toBeNull();
      expect(bucket.p95Ms).toBeNull();
    }
    expect(data.totals.requests).toBe(0);
    expect(data.previous).toBeNull();
    expect(data.baseline).toBeNull();
    expect(data.markers).toEqual([]);
    expect(data.alerts).toEqual({ firing: 0, pending: 0, covered: false });
    expect(data.alertsAvailable).toBe(true);
  });

  it('reports coverage of this agent by an enabled rule', async () => {
    fakeDb.listAlertRules.mockResolvedValue([
      { _id: 'r1', module: 'agents', enabled: true, entity: { entityType: 'agent', mode: 'selected', keys: ['pulse'] } },
      { _id: 'r2', module: 'agents', enabled: false, entity: { entityType: 'agent', mode: 'all' } },
    ]);
    const covered = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;
    expect(covered.alerts.covered).toBe(true);
    const other = (await get('/api/tracing/agents/other/health')).body as unknown as DetailBody;
    expect(other.alerts.covered).toBe(false);
    expect(other.alertsAvailable).toBe(true);
  });

  it('drops incident markers for callers without alerts read', async () => {
    fakeDb.listIncidents.mockResolvedValue([{ _id: 'inc-in', ruleName: 'Secret rule', firedAt: new Date(NOW - 2 * HOUR) }]);
    mockFn(authorizeServiceForRequest).mockResolvedValue({ allowed: false });
    const data = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;
    expect(data.markers.some((m) => m.type === 'incident')).toBe(false);
    expect(fakeDb.listIncidents).not.toHaveBeenCalled();
  });

  it('returns the bucketed series, totals and previous period of the agent', async () => {
    const t0 = NOW - 24 * HOUR;
    aggregateRows({
      current: [
        { entityKey: 'pulse', bucketMs: t0 + 2 * HOUR, requests: 4, errors: 1, latencyCount: 4, lat2: 4 },
        { entityKey: 'pulse', bucketMs: t0 + 9 * HOUR, requests: 6, errors: 0, latencyCount: 6, lat2: 6 },
      ],
      previous: [{ entityKey: 'pulse', requests: 3, errors: 3 }],
    });

    const data = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;

    expect(data.buckets[2]).toMatchObject({ t: t0 + 2 * HOUR, requests: 4, errors: 1, errorRate: 25 });
    expect(data.buckets[2]!.p95Ms).not.toBeNull();
    expect(data.buckets[3]).toMatchObject({ requests: 0, errorRate: null });
    expect(data.totals).toMatchObject({ requests: 10, errors: 1, errorRate: 10 });
    expect(data.previous).toMatchObject({ requests: 3, errors: 3, errorRate: 100 });

    const queries = fakeDb.aggregateEntityMetrics.mock.calls.map((c) => c[0]);
    for (const q of queries) {
      expect(q).toMatchObject({ entityType: 'agent', entityKeys: ['pulse'], tenantId: 'tenant-1', projectId: 'proj-1' });
    }
  });

  it('uses the agent name as sent, decoded once (50%off, 100%25)', async () => {
    mockFn(AgentTracingService.getAgentOverview).mockResolvedValue({ ok: true });
    mockFn(AgentTracingService.getModelOverview).mockResolvedValue({ ok: true });

    const health = await get('/api/tracing/agents/50%25off/health');
    expect(health.status).toBe(200);
    expect(fakeDb.aggregateEntityMetrics.mock.calls[0]![0]).toMatchObject({ entityKeys: ['50%off'] });
    expect(fakeDb.listAgentTracingSessions.mock.calls[0]![0]).toMatchObject({ agentNameExact: '50%off' });

    // The same name reaches the other handlers of the plugin untouched by a second decode.
    expect((await get('/api/tracing/agents/50%25off/overview')).status).toBe(200);
    expect(mockFn(AgentTracingService.getAgentOverview).mock.calls[0]![2]).toBe('50%off');
    expect((await get('/api/tracing/agents/100%2525/overview')).status).toBe(200);
    expect(mockFn(AgentTracingService.getAgentOverview).mock.calls[1]![2]).toBe('100%25');
    expect((await get('/api/tracing/models/gpt%2525x/overview')).status).toBe(200);
    expect(mockFn(AgentTracingService.getModelOverview).mock.calls[0]![2]).toBe('gpt%25x');
  });

  it('marks the first time each version was seen and the incidents opened in the range', async () => {
    const t0 = NOW - 24 * HOUR;
    const iso = (ms: number) => new Date(ms).toISOString();
    fakeDb.listAgentTracingSessions.mockResolvedValue({
      total: 5,
      sessions: [
        { agentVersion: '2', startedAt: new Date(t0 + 10 * HOUR) },
        { agentVersion: '2', startedAt: iso(t0 + 8 * HOUR) },
        { agentVersion: '1', startedAt: new Date(t0 + 1 * HOUR) },
        { agentVersion: null, startedAt: new Date(t0 + 2 * HOUR) },
        { agentVersion: 'v3.1', startedAt: new Date(t0 + 12 * HOUR) },
      ],
    });
    fakeDb.listIncidents.mockResolvedValue([
      { _id: 'inc-in', ruleName: 'Error rate high', firedAt: new Date(t0 + 9 * HOUR) },
      { _id: 'inc-old', ruleName: 'Too old', firedAt: new Date(t0 - 3 * DAY) },
    ]);

    const data = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;

    expect(data.markers).toEqual([
      { t: t0 + 1 * HOUR, type: 'version', label: 'v1', href: '/dashboard/tracing/sessions?agent=pulse' },
      { t: t0 + 8 * HOUR, type: 'version', label: 'v2', href: '/dashboard/tracing/sessions?agent=pulse' },
      { t: t0 + 9 * HOUR, type: 'incident', label: 'Error rate high', href: '/dashboard/alerts/incidents/inc-in' },
      { t: t0 + 12 * HOUR, type: 'version', label: 'v3.1', href: '/dashboard/tracing/sessions?agent=pulse' },
    ]);

    expect(fakeDb.listAgentTracingSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentNameExact: 'pulse',
        limit: '5000',
        includeTotal: false,
        from: iso(NOW - DAY),
        to: iso(NOW),
      }),
      'proj-1',
    );
    expect(fakeDb.listIncidents).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      projectId: 'proj-1',
      module: 'agents',
      entityKey: 'pulse',
    }));
  });

  it('flags partial version markers and drops the versions it cannot date when the session read hit its bound', async () => {
    const sessions = Array.from({ length: 5000 }, (_, i) => ({
      // Newest first, as the db returns them: v3 is the newest, v2 the bulk, v1 only starts the oldest bucket.
      agentVersion: i < 100 ? '3' : i < 4990 ? '2' : '1',
      startedAt: new Date(NOW - HOUR - i * 1000),
    }));
    fakeDb.listAgentTracingSessions.mockResolvedValue({ sessions, total: 9000 });

    const data = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;
    expect(data.markersPartial).toBe(true);
    const versions = data.markers.filter((m) => m.type === 'version');
    // v1 and v2 begin at (or within a bucket of) the oldest session read, so their start is unknown: only v3 is dated.
    expect(versions.map((m) => m.label)).toEqual(['v3']);
    expect(versions[0]!.t).toBe(NOW - HOUR - 99 * 1000);
  });

  it('does not flag the version markers as partial below the bound', async () => {
    fakeDb.listAgentTracingSessions.mockResolvedValue({
      sessions: [{ agentVersion: '1', startedAt: new Date(NOW - 2 * HOUR) }],
      total: 1,
    });
    const data = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;
    expect(data.markersPartial).toBe(false);
    expect(data.markers).toHaveLength(1);
  });

  it('reads no incidents for the alert counts of one agent', async () => {
    fakeDb.listAlertRules.mockResolvedValue([{ _id: 'r', module: 'agents', enabled: true }]);
    fakeDb.listAlertStates.mockResolvedValue([{ ruleId: 'r', entityKey: 'pulse', phase: 'firing', incidentId: 'inc-1' }]);
    await get('/api/tracing/agents/pulse/health');
    expect(fakeDb.findIncidentById).not.toHaveBeenCalled();
  });

  it('counts the firing and pending alerts of this agent only', async () => {
    fakeDb.listAlertRules.mockResolvedValue([{ _id: 'rule-agent', module: 'agents', enabled: true }]);
    fakeDb.listAlertStates.mockResolvedValue([
      { ruleId: 'rule-agent', entityKey: 'pulse', phase: 'firing' },
      { ruleId: 'rule-agent', entityKey: 'pulse', phase: 'pending' },
      { ruleId: 'rule-agent', entityKey: 'pulse', phase: 'pending' },
      { ruleId: 'rule-agent', entityKey: 'someone-else', phase: 'firing' },
    ]);
    const data = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;
    expect(data.alerts).toEqual({ firing: 1, pending: 2, covered: false });
    expect(data.alertsAvailable).toBe(true);
  });

  it('adds the baseline band of the seam for error rate and p95, and falls back to null on failure', async () => {
    const band = vi.fn(async (req: { metric: string }) => [
      { t: NOW - DAY, median: req.metric === 'agent_error_rate' ? 1 : 900, lower: 0, upper: 2 },
    ]);
    registerEntityBaselineProvider({ evaluate: vi.fn(), band } as never);

    const data = (await get('/api/tracing/agents/pulse/health')).body as unknown as DetailBody;
    expect(data.baseline).toEqual({
      errorRate: [{ t: NOW - DAY, median: 1, lower: 0, upper: 2 }],
      p95Ms: [{ t: NOW - DAY, median: 900, lower: 0, upper: 2 }],
    });
    expect(band).toHaveBeenCalledTimes(2);
    expect(band.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({
        metric: 'agent_error_rate',
        entityType: 'agent',
        entityKey: 'pulse',
        tenantDbName: 'tenant_acme',
        tenantId: 'tenant-1',
        projectId: 'proj-1',
        fromMs: NOW - DAY,
        toMs: NOW,
        bucketMs: HOUR,
        lookbackDays: 14,
      }),
      expect.objectContaining({ metric: 'agent_p95_duration_ms' }),
    ]);

    registerEntityBaselineProvider({ evaluate: vi.fn(), band: vi.fn().mockRejectedValue(new Error('no history')) } as never);
    const failed = await get('/api/tracing/agents/pulse/health');
    expect(failed.status).toBe(200);
    expect((failed.body as unknown as DetailBody).baseline).toBeNull();
  });

  it('keeps the series when markers and alerts cannot be read', async () => {
    fakeDb.listAgentTracingSessions.mockRejectedValue(new Error('sessions down'));
    fakeDb.listIncidents.mockRejectedValue(new Error('incidents down'));
    fakeDb.listAlertRules.mockRejectedValue(new Error('alerts down'));
    const res = await get('/api/tracing/agents/pulse/health');
    expect(res.status).toBe(200);
    const data = res.body as unknown as DetailBody;
    expect(data.buckets).toHaveLength(24);
    expect(data.markers).toEqual([]);
    expect(data.alerts).toEqual({ firing: 0, pending: 0, covered: false });
    expect(data.alertsAvailable).toBe(false);
  });

  it('parses the period like the list endpoint and rejects an unusable range', async () => {
    const week = (await get('/api/tracing/agents/pulse/health?period=last_7_days')).body as unknown as DetailBody;
    expect(week.range).toEqual({ fromMs: NOW - 7 * DAY, toMs: NOW, bucketMs: DAY });
    // Daily buckets are UTC-aligned, so a week that starts mid-day touches 8 of them.
    expect(week.buckets).toHaveLength(8);

    expect((await get('/api/tracing/agents/pulse/health?to=garbage')).status).toBe(400);
  });

  it('answers 500 when the rollup read fails', async () => {
    fakeDb.aggregateEntityMetrics.mockRejectedValue(new Error('db down'));
    expect((await get('/api/tracing/agents/pulse/health')).status).toBe(500);
  });
});
