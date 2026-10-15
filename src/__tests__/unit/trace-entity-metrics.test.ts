/**
 * Entity-health emitters for traced agents (`recordTraceEventMetrics`) and the
 * 'abandoned' status in the service-level consumers. The end-to-end paths
 * (HTTP ingest, finalizer) are covered by integration/tracing-entity-health-ingest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  recordEntityMetric: vi.fn((_input: Record<string, unknown>) => undefined),
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/entityMetrics/entityMetricsRollup', () => ({ recordEntityMetric: hoisted.recordEntityMetric }));
vi.mock('@/lib/database', () => ({ getDatabase: hoisted.getDatabase, runWithTenantScope: vi.fn() }));

import { AgentTracingService, type TraceModelPricerLoader } from '@/lib/services/agentTracing';
import { matchesTracingStatus } from '@/lib/services/snapshots/snapshotService';
import { runWithTenantScope } from '@/lib/database';
import { recordAgentSessionOutcome, recordTraceEventMetrics } from '@/lib/services/tracing/traceEntityMetrics';
import { resolveStatusColor, statusVariant } from '@/lib/utils/tracingUtils';
import { createMockDb } from '../helpers/db.mock';

const base = { tenantDbName: 'tenant_x', tenantId: 't-1', projectId: 'p-1', agentName: 'Pulse Main' };

/** Prices every model at 1 USD per 1M input tokens and resolves "GPT-4o" to the Hub key "gpt-hub". */
const pricerLoader: TraceModelPricerLoader = async () => ({
  price: (name, tokens) => ({
    refKey: name.toLowerCase() === 'gpt-4o' ? 'gpt-hub' : name,
    costUsd: tokens.inputTokens / 1_000_000,
  }),
});

const at = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const calls = () => hoisted.recordEntityMetric.mock.calls.map((call) => call[0]);
const byType = (type: string) => calls().filter((call) => call.entityType === type);

describe('recordTraceEventMetrics', () => {
  beforeEach(() => hoisted.recordEntityMetric.mockClear());

  it('emits agent counters plus a model row per ai_call and a tool row per tool_call for external traces', async () => {
    await recordTraceEventMetrics({
      ...base,
      source: 'tracing',
      pricerLoader,
      events: [
        { id: 'a', type: 'ai_call', status: 'success', model: 'GPT-4o', inputTokens: 2_000_000, outputTokens: 10, durationMs: 120, timestamp: at() },
        { id: 'b', type: 'ai_call', status: 'error', error: { message: 'x' }, model: 'other-model', durationMs: 30, timestamp: at() },
        { id: 'c', type: 'tool_call', status: 'success', toolName: 'search', durationMs: 40, timestamp: at() },
        { id: 'd', type: 'tool_call', status: 'error', error: 'bad', actor: { scope: 'tool', name: 'broken' }, timestamp: at() },
      ],
    });

    const agentRows = byType('agent');
    expect(agentRows.reduce((sum, row) => sum + Number(row.aiCalls ?? 0), 0)).toBe(2);
    expect(agentRows.reduce((sum, row) => sum + Number(row.aiErrors ?? 0), 0)).toBe(1);
    expect(agentRows.reduce((sum, row) => sum + Number(row.toolCalls ?? 0), 0)).toBe(2);
    expect(agentRows.reduce((sum, row) => sum + Number(row.toolErrors ?? 0), 0)).toBe(1);
    expect(agentRows.every((row) => row.entityKey === 'Pulse Main' && row.outcome === 'none' && row.source === 'tracing')).toBe(true);

    const models = byType('model');
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({ entityKey: 'gpt-hub', outcome: 'ok', latencyMs: 120, inputTokens: 2_000_000, costUsd: 2, source: 'tracing' });
    expect(models[1]).toMatchObject({ entityKey: 'other-model', outcome: 'error' });

    const tools = byType('tool');
    expect(tools).toHaveLength(2);
    expect(tools.find((row) => row.entityKey === 'search')).toMatchObject({ outcome: 'ok', latencyMs: 40 });
    expect(tools.find((row) => row.entityKey === 'broken')).toMatchObject({ outcome: 'error' });
  });

  it('skips gateway-served calls and skipped events on model and tool rows, and anything older than a day', async () => {
    await recordTraceEventMetrics({
      ...base,
      source: 'tracing',
      pricerLoader,
      events: [
        { id: 'g', type: 'ai_call', status: 'success', model: 'gpt-4o', metadata: { gatewayRequestId: 'r-1' }, timestamp: at() },
        { id: 's', type: 'tool_call', status: 'skipped', toolName: 'skipped-tool', timestamp: at() },
        { id: 'old', type: 'ai_call', status: 'error', model: 'm', timestamp: at(-2 * 86_400_000) },
      ],
    });

    expect(byType('model')).toHaveLength(0);
    expect(byType('tool')).toHaveLength(0);
    // The gateway-served call is still one of the agent's calls; the skipped tool and the old event are not.
    const agentRows = byType('agent');
    expect(agentRows.reduce((sum, row) => sum + Number(row.aiCalls ?? 0), 0)).toBe(1);
    expect(agentRows.reduce((sum, row) => sum + Number(row.toolCalls ?? 0), 0)).toBe(0);
  });

  it('hosted runs emit agent rows only', async () => {
    await recordTraceEventMetrics({
      ...base,
      source: 'hosted',
      pricerLoader,
      events: [
        { id: 'a', type: 'ai_call', status: 'success', model: 'gpt-4o', timestamp: at() },
        { id: 'c', type: 'tool_call', status: 'success', toolName: 'search', timestamp: at() },
      ],
    });
    expect(byType('model')).toHaveLength(0);
    expect(byType('tool')).toHaveLength(0);
    expect(byType('agent').every((row) => row.source === 'hosted')).toBe(true);
    expect(byType('agent').length).toBeGreaterThan(0);
  });

  it('subtracts a previous post by event identity: identical events add nothing, dropped events are reversed', async () => {
    const kept = { id: 'k', type: 'ai_call', status: 'success', model: 'm', timestamp: at() };
    const dropped = { id: 'd', type: 'tool_call', status: 'error', error: 'x', toolName: 't', timestamp: at() };
    const added = { id: 'n', type: 'tool_call', status: 'success', toolName: 't', timestamp: at() };

    await recordTraceEventMetrics({ ...base, source: 'hosted', pricerLoader, events: [kept], previousEvents: [kept] });
    expect(calls()).toHaveLength(0);

    await recordTraceEventMetrics({ ...base, source: 'hosted', pricerLoader, events: [kept, added], previousEvents: [kept, dropped] });
    const agentRows = byType('agent');
    expect(agentRows.reduce((sum, row) => sum + Number(row.toolCalls ?? 0), 0)).toBe(0); // +1 added, -1 dropped
    expect(agentRows.reduce((sum, row) => sum + Number(row.toolErrors ?? 0), 0)).toBe(-1);
    expect(agentRows.reduce((sum, row) => sum + Number(row.errorEvents ?? 0), 0)).toBe(-1);
  });

  it('keeps going without prices and never throws', async () => {
    const failing: TraceModelPricerLoader = async () => { throw new Error('hub down'); };
    await expect(recordTraceEventMetrics({
      ...base, source: 'tracing', pricerLoader: failing,
      events: [{ id: 'a', type: 'ai_call', status: 'success', model: 'GPT-4o', inputTokens: 5, timestamp: at() }],
    })).resolves.toBeUndefined();
    expect(byType('model')[0]).toMatchObject({ entityKey: 'GPT-4o', costUsd: 0 });

    hoisted.recordEntityMetric.mockImplementationOnce(() => { throw new Error('buffer'); });
    await expect(recordTraceEventMetrics({
      ...base, source: 'tracing', pricerLoader,
      events: [{ id: 'z', type: 'tool_call', status: 'error', toolName: 't', timestamp: at() }],
    })).resolves.toBeUndefined();
  });
});

describe('recordTraceEventMetrics booking time of client-sent events', () => {
  const HOUR = 3_600_000;
  const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
  const stamped = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
  const sum = (rows: Array<Record<string, unknown>>, field: string) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);

  beforeEach(() => {
    hoisted.recordEntityMetric.mockClear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('books an event 10 h old at now - 3 h on the agent, model and tool rows, keeping its counts', async () => {
    await recordTraceEventMetrics({
      ...base,
      source: 'tracing',
      pricerLoader,
      events: [
        { id: 'old-ai', type: 'ai_call', status: 'success', model: 'm', durationMs: 5, timestamp: stamped(-10 * HOUR) },
        { id: 'old-tool', type: 'tool_call', status: 'error', error: 'x', toolName: 't', timestamp: stamped(-10 * HOUR) },
      ],
    });

    expect(byType('agent').length).toBeGreaterThan(0);
    expect(byType('model')).toHaveLength(1);
    expect(byType('tool')).toHaveLength(1);
    expect(calls().every((row) => row.at === NOW - 3 * HOUR)).toBe(true);
    // Only the time moved: nothing is dropped.
    expect(sum(byType('agent'), 'aiCalls')).toBe(1);
    expect(sum(byType('agent'), 'toolCalls')).toBe(1);
    expect(sum(byType('agent'), 'toolErrors')).toBe(1);
    expect(byType('tool')[0]).toMatchObject({ entityKey: 't', outcome: 'error' });
  });

  it('keeps an event 2 min in the future at its own time and books one 30 min ahead at now + 5 min', async () => {
    await recordTraceEventMetrics({
      ...base,
      source: 'tracing',
      pricerLoader,
      events: [
        { id: 'soon', type: 'tool_call', status: 'success', toolName: 'soon-tool', timestamp: stamped(2 * 60_000) },
        { id: 'later', type: 'tool_call', status: 'success', toolName: 'later-tool', timestamp: stamped(30 * 60_000) },
      ],
    });

    const toolAt = (key: string) => byType('tool').find((row) => row.entityKey === key)?.at;
    expect(toolAt('soon-tool')).toBe(NOW + 2 * 60_000);
    expect(toolAt('later-tool')).toBe(NOW + 5 * 60_000);
    // The agent counters follow the same clamp, one row per event.
    expect(byType('agent').map((row) => row.at)).toEqual([NOW + 2 * 60_000, NOW + 5 * 60_000]);
  });

  it('keeps every time inside the window as given, whatever the 3 h bound', async () => {
    await recordTraceEventMetrics({
      ...base,
      source: 'tracing',
      pricerLoader,
      events: [
        { id: 'a', type: 'tool_call', status: 'success', toolName: 'one-hour', timestamp: stamped(-HOUR) },
        { id: 'b', type: 'tool_call', status: 'success', toolName: 'three-hours', timestamp: stamped(-3 * HOUR) },
        { id: 'c', type: 'tool_call', status: 'success', toolName: 'no-time' },
      ],
    });
    const toolAt = (key: string) => byType('tool').find((row) => row.entityKey === key)?.at;
    expect(toolAt('one-hour')).toBe(NOW - HOUR);
    expect(toolAt('three-hours')).toBe(NOW - 3 * HOUR);
    // No usable time: the rollup books it at "now" itself.
    const noTime = byType('tool').find((row) => row.entityKey === 'no-time');
    expect(noTime).toBeDefined();
    expect(noTime?.at).toBeUndefined();
  });

  it('still skips anything older than a day, and leaves hosted runs their own times', async () => {
    await recordTraceEventMetrics({
      ...base,
      source: 'tracing',
      pricerLoader,
      events: [{ id: 'ancient', type: 'tool_call', status: 'success', toolName: 'ancient', timestamp: stamped(-25 * HOUR) }],
    });
    expect(calls()).toHaveLength(0);

    // A long hosted run reports its early events well past 3 h: those are the console's own times, not client input.
    await recordTraceEventMetrics({
      ...base,
      source: 'hosted',
      pricerLoader,
      events: [{ id: 'long-run', type: 'tool_call', status: 'success', toolName: 'hosted-tool', timestamp: stamped(-10 * HOUR) }],
    });
    expect(byType('agent').map((row) => row.at)).toEqual([NOW - 10 * HOUR]);
  });
});

describe('recordTraceEventMetrics bounds and identity', () => {
  beforeEach(() => hoisted.recordEntityMetric.mockClear());

  it('caps distinct model and tool keys per ingest by first appearance', async () => {
    const events = [
      ...Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, type: 'ai_call', status: 'success', model: `model-${i}`, timestamp: at() })),
      ...Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, type: 'tool_call', status: 'success', toolName: `tool-${i}`, timestamp: at() })),
      // A repeat of an already admitted key is still counted.
      { id: 'again', type: 'ai_call', status: 'success', model: 'model-0', timestamp: at() },
    ];
    await recordTraceEventMetrics({ ...base, source: 'tracing', pricerLoader, events });

    const modelKeys = new Set(byType('model').map((row) => row.entityKey));
    const toolKeys = new Set(byType('tool').map((row) => row.entityKey));
    expect(modelKeys.size).toBe(50);
    expect(toolKeys.size).toBe(50);
    expect(modelKeys.has('model-0') && modelKeys.has('model-49') && !modelKeys.has('model-50')).toBe(true);
    expect(byType('model').filter((row) => row.entityKey === 'model-0')).toHaveLength(2);
    // Agent counters are not capped: every call is still one of the agent's calls.
    expect(byType('agent').reduce((sum, row) => sum + Number(row.aiCalls ?? 0), 0)).toBe(61);
  });

  it('does not recount id-less events re-posted with a freshly stamped timestamp', async () => {
    const first = [
      { type: 'tool_call', status: 'error', error: 'x', toolName: 't', label: 'call', sequence: 0, timestamp: at(-1000) },
      { type: 'ai_call', status: 'success', model: 'm', label: 'llm', sequence: 1, timestamp: at(-1000) },
    ];
    // Same events, but the ingest stamped them "now" again (no timestamp in the payload).
    const repost = first.map((event) => ({ ...event, timestamp: at(0) }));
    await recordTraceEventMetrics({ ...base, source: 'tracing', pricerLoader, events: repost, previousEvents: first });
    expect(calls()).toHaveLength(0);
  });
});

describe('recordAgentSessionOutcome', () => {
  const db = createMockDb();
  const stored = (over: Record<string, unknown> = {}) => ({
    sessionId: 's-1', agentName: 'Pulse Main', status: 'error', tenantId: 't-1', ...over,
  }) as never;
  const params = (over: Record<string, unknown> = {}) => ({
    ...base,
    source: 'tracing' as const,
    pricerLoader,
    events: [],
    session: { sessionId: 's-1', agentName: 'Pulse Main', status: 'success', durationMs: 1000, totalInputTokens: 10, totalOutputTokens: 5 } as never,
    ...over,
  });

  beforeEach(() => {
    hoisted.recordEntityMetric.mockClear();
    db.findAgentTracingSessionById.mockReset();
    db.updateAgentTracingSession.mockReset();
    db.listAgentTracingEvents.mockReset();
    vi.mocked(runWithTenantScope).mockImplementation((async (_name: string, fn: (d: unknown) => unknown) => fn(db)) as never);
  });

  it('books the stored terminal status when it differs from the status the caller passed', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(stored({ status: 'error' }));
    const next = await recordAgentSessionOutcome(params());
    expect(next).toMatchObject({ status: 'error' });
    expect(db.updateAgentTracingSession).toHaveBeenCalledWith('s-1', { metricsOutcome: expect.objectContaining({ status: 'error' }) }, 'p-1');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ outcome: 'error', requests: 1 });
  });

  it('falls back to the passed status when the stored one is not terminal', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(stored({ status: 'in_progress' }));
    expect(await recordAgentSessionOutcome(params())).toMatchObject({ status: 'success' });
    expect(calls()[0]).toMatchObject({ outcome: 'ok' });
  });

  it('still books the outcome (without cost) when the session events cannot be loaded', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(stored({ status: 'success' }));
    db.listAgentTracingEvents.mockRejectedValue(new Error('db down'));
    const next = await recordAgentSessionOutcome(params({ events: undefined }));
    expect(next).toMatchObject({ status: 'success' });
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toMatchObject({ requests: 1, costUsd: 0, outcome: 'ok' });
  });

  it('does not mark the session as counted when the events load is not the failure but the marker write is', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(stored({ status: 'success' }));
    db.updateAgentTracingSession.mockRejectedValue(new Error('write failed'));
    expect(await recordAgentSessionOutcome(params())).toBeNull();
    expect(calls()).toHaveLength(0);
  });

  it('pins the known limitation: tokens and cost are booked with the first outcome only', async () => {
    const previous = { status: 'success', latencyRecorded: true, recordedAt: new Date() };
    db.findAgentTracingSessionById.mockResolvedValue(stored({ status: 'success', metricsOutcome: previous }));
    const next = await recordAgentSessionOutcome(params({
      session: { sessionId: 's-1', agentName: 'Pulse Main', status: 'success', durationMs: 1000, totalInputTokens: 9999, totalOutputTokens: 9999 } as never,
    }));
    expect(next).toBe(previous);
    expect(calls()).toHaveLength(0);
  });
});

describe("'abandoned' sessions in the service-level consumers", () => {
  it('is warning-styled in the status helpers', () => {
    expect(resolveStatusColor('abandoned')).not.toBe('gray');
    expect(resolveStatusColor('abandoned')).not.toBe('red');
    expect(resolveStatusColor('in_progress')).toBe('blue');
    expect(statusVariant('abandoned')).toBe('warn');
    expect(statusVariant('in_progress')).toBe('info');
  });

  it('is neither an error nor a success for dataset status filters', () => {
    const abandoned = { status: 'abandoned' } as never;
    expect(matchesTracingStatus(abandoned, 'error')).toBe(false);
    expect(matchesTracingStatus(abandoned, 'success')).toBe(false);
    expect(matchesTracingStatus(abandoned, undefined)).toBe(true);
    expect(matchesTracingStatus({ status: 'error' } as never, 'error')).toBe(true);
    expect(matchesTracingStatus({ status: 'success' } as never, 'success')).toBe(true);
  });

  it('lets a thread finish once every session ended or was abandoned', async () => {
    const db = createMockDb();
    hoisted.getDatabase.mockResolvedValue(db);
    const session = (sessionId: string, status: string) => ({
      sessionId, status, agentName: 'a', startedAt: new Date('2025-01-10T10:00:00Z'), totalEvents: 1,
    }) as never;

    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session('1', 'success'), session('2', 'abandoned')], total: 2 });
    expect((await AgentTracingService.getThreadDetail('tenant_x', 'p-1', 'th'))?.status).toBe('success');

    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session('1', 'success'), session('2', 'in_progress')], total: 2 });
    expect((await AgentTracingService.getThreadDetail('tenant_x', 'p-1', 'th'))?.status).toBe('in_progress');

    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session('1', 'abandoned'), session('2', 'error')], total: 2 });
    expect((await AgentTracingService.getThreadDetail('tenant_x', 'p-1', 'th'))?.status).toBe('error');

    // Every session went quiet without an end: the conversation is abandoned, not a success.
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session('1', 'abandoned'), session('2', 'abandoned')], total: 2 });
    expect((await AgentTracingService.getThreadDetail('tenant_x', 'p-1', 'th'))?.status).toBe('abandoned');
  });
});
