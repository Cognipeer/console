/**
 * Entity-health signals from every tracing ingest path, against the live
 * Fastify plugin and both real backends:
 *
 *  - session status and error counters (stream start/events/end, batch, OTLP,
 *    the hosted-agent sink),
 *  - the entity metrics each path records (agent / model / tool rows),
 *  - a late error flipping a finished session, an abandoned session revived by
 *    a late `/end`, the stale-session finalizer's compare-and-set,
 *  - OTLP root-span terminal detection.
 *
 * Every ingest write is fire-and-forget, so each step awaits
 * `drainPendingTasks()` and flushes the entity metrics buffer before reading.
 * (The older HTTP tracing tests import the unmounted `server/api/routes`.)
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  tokens: new Map<string, unknown>(),
}));

import type { DatabaseProvider } from '@/lib/database';
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: DatabaseProvider) => unknown) => {
      const db: DatabaseProvider = await hoisted.getDatabase();
      return db.runWithTenant?.(tenantDbName, () => fn(db));
    },
  };
});

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: async (header: string | null) => {
      const ctx = hoisted.tokens.get(String(header).replace(/^Bearer /, ''));
      if (!ctx) throw new ApiTokenAuthError('Invalid API token', 401);
      return ctx;
    },
  };
});

import { drainPendingTasks } from '@/lib/core/asyncTask';
import { createInternalTracingSink } from '@/lib/services/agents/agentService';
import { runWithTurnSignal } from '@/lib/core/turnSignal';
import {
  __resetEntityMetricsRollupForTests,
  flushEntityMetricsRollup,
} from '@/lib/services/entityMetrics/entityMetricsRollup';
import {
  sweepStaleTracingSessions,
  triggerTracingSessionFinalizerRun,
} from '@/lib/services/tracing/sessionFinalizer';
import { flushUsageRollup, pendingUsageRollupRows } from '@/lib/services/usage/usageRollup';
import type { EntityMetricType, IEntityMetricAggregate } from '@/lib/database/provider/types.base';
import { clientTracingApiPlugin } from '@/server/api/plugins/client-tracing';
import { createFastifyApiTestApp } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';
import sdkLegsLeg1 from '../fixtures/otlp-sdk/legs-paused.leg1.both.json';
import sdkLegsLeg2 from '../fixtures/otlp-sdk/legs-paused.leg2.both.json';
import sdkSubagentLeg1 from '../fixtures/otlp-sdk/subagent-pending.leg1.both.json';
import sdkSubagentLeg2 from '../fixtures/otlp-sdk/subagent-pending.leg2.both.json';
import sdkGenAiRun from '../fixtures/otlp-sdk/run-success.gen_ai.json';

const DAY_MS = 86_400_000;

type Json = Record<string, unknown>;

describeForEachProvider('tracing ingest feeds entity health', (getDb) => {
  let db: DatabaseProvider;
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let dbName: string;
  let tenantId: string;
  let projectId: string;
  let sequence = 0;
  let agent: string;

  beforeEach(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    hoisted.tokens.clear();
    __resetEntityMetricsRollupForTests();
    base = Date.now();
    db = getDb();

    sequence += 1;
    const slug = `health-${Date.now()}-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
    dbName = `tenant_${slug}`;
    agent = `agent-${sequence}-${Math.random().toString(36).slice(2, 6)}`;
    const tenant = await db.createTenant({ companyName: 'Health', slug, dbName, licenseType: 'ENTERPRISE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    const owner = await db.createUser({
      tenantId, email: 'owner@x.io', name: 'Owner', password: '$2b$10$x', role: 'owner', licenseId: 'ENTERPRISE', features: [],
    });
    projectId = String((await db.createProject({ tenantId, key: 'main', name: 'Main', createdBy: 'test' }))._id);
    await db.createModel({
      tenantId,
      projectId,
      name: 'GPT hub',
      key: 'gpt-hub',
      providerKey: 'mock-llm',
      providerDriver: 'openai-compatible',
      category: 'llm' as never,
      modelId: 'gpt-x',
      settings: {},
      pricing: { inputTokenPer1M: 1, outputTokenPer1M: 2 },
      createdBy: 'seed',
    } as never);

    app = await createFastifyApiTestApp(async (instance) => {
      await instance.register(clientTracingApiPlugin);
    });
    await app.ready();
    hoisted.tokens.set('tok-main', {
      token: 'tok-main',
      tokenRecord: { _id: 'tok-main-id', userId: String(owner._id), servicePermissions: null, projectId },
      tenant: { licenseType: 'ENTERPRISE' },
      tenantId,
      tenantSlug: slug,
      tenantDbName: dbName,
      projectId,
      user: owner,
    });
  });

  afterEach(async () => {
    await app.close();
    await drainPendingTasks();
    // Write the usage counters this test buffered while its provider is still up: otherwise the rollup's
    // interval flushes them after the provider is torn down, and that rejection fails the whole run.
    await flushUsageRollup();
    expect(pendingUsageRollupRows()).toBe(0);
    __resetEntityMetricsRollupForTests();
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer tok-main', 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

  /** Wait for the fire-and-forget ingest bodies, then move the buffered metrics into the database. */
  async function settle() {
    await drainPendingTasks();
    await flushEntityMetricsRollup();
  }

  async function metrics(entityType: EntityMetricType, groupBy: Array<'entityKey' | 'source'> = ['entityKey']) {
    await db.switchToTenant(dbName);
    const rows = await db.aggregateEntityMetrics({
      tenantId,
      projectId,
      entityType,
      fromMs: Date.now() - 2 * DAY_MS,
      toMs: Date.now() + DAY_MS,
      groupBy,
      limit: 50_000,
    });
    return rows;
  }

  async function row(entityType: EntityMetricType, key: string): Promise<IEntityMetricAggregate | undefined> {
    return (await metrics(entityType)).find((candidate) => candidate.entityKey === key);
  }

  async function session(sessionId: string) {
    await db.switchToTenant(dbName);
    return db.findAgentTracingSessionById(sessionId, projectId);
  }

  let eventSeq = 0;
  const aiCall = (over: Json = {}): Json => {
    eventSeq += 1;
    return {
      id: `ev-${eventSeq}`,
      type: 'ai_call',
      status: 'success',
      model: 'gpt-x',
      inputTokens: 1000,
      outputTokens: 500,
      durationMs: 300,
      sequence: eventSeq,
      timestamp: new Date().toISOString(),
      ...over,
    };
  };
  const toolCall = (name: string, over: Json = {}): Json => {
    eventSeq += 1;
    return {
      id: `ev-${eventSeq}`,
      type: 'tool_call',
      status: 'success',
      toolName: name,
      actor: { scope: 'tool', name },
      durationMs: 50,
      sequence: eventSeq,
      timestamp: new Date().toISOString(),
      ...over,
    };
  };

  const streamStart = (sessionId: string) =>
    post(`/api/client/v1/tracing/sessions/stream/${sessionId}/start`, {
      sessionId, agent: { name: agent }, startedAt: new Date().toISOString(),
    });
  const streamEvent = (sessionId: string, event: Json) =>
    post(`/api/client/v1/tracing/sessions/stream/${sessionId}/events`, { event });
  const streamEnd = (sessionId: string, payload: Json = {}) =>
    post(`/api/client/v1/tracing/sessions/stream/${sessionId}/end`, payload);

  // ── stream ────────────────────────────────────────────────────────────────

  it('stream: counts error events, derives the status at /end and records agent, model and tool rows', async () => {
    const sessionId = `stream-${sequence}`;
    expect((await streamStart(sessionId)).statusCode).toBe(200);
    await drainPendingTasks();
    const ok = await streamEvent(sessionId, aiCall());
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await streamEvent(sessionId, toolCall('search'))).statusCode).toBe(200);
    expect((await streamEvent(sessionId, toolCall('flaky', { status: 'error', error: { message: 'boom' } }))).statusCode).toBe(200);
    await drainPendingTasks();

    const running = await session(sessionId);
    expect(running).toMatchObject({ status: 'in_progress', errorEvents: 1, toolErrors: 1, aiErrors: 0 });

    // The client sends no status: the counters decide.
    const end = await streamEnd(sessionId, { durationMs: 4000 });
    expect(end.statusCode, end.body).toBe(200);
    expect(JSON.parse(end.body).status).toBe('error');
    await settle();

    const finished = await session(sessionId);
    expect(finished?.status).toBe('error');
    expect(finished?.metricsOutcome).toMatchObject({ status: 'error', latencyRecorded: true });

    expect(await row('agent', agent)).toMatchObject({
      requests: 1, errors: 1, abandoned: 0, aiCalls: 1, aiErrors: 0, toolCalls: 2, toolErrors: 1, errorEvents: 1,
      latencyCount: 1, latencyMsSum: 4000,
    });
    const model = await row('model', 'gpt-hub');
    expect(model).toMatchObject({ requests: 1, errors: 0, inputTokens: 1000, outputTokens: 500, latencyCount: 1, latencyMsSum: 300 });
    expect(model?.costUsd).toBeCloseTo(0.002, 6);
    expect(await row('tool', 'search')).toMatchObject({ requests: 1, errors: 0, latencyCount: 1 });
    // A failed call counts as a request and an error but never as a latency sample.
    expect(await row('tool', 'flaky')).toMatchObject({ requests: 1, errors: 1, latencyCount: 0 });
  });

  it('stream: a client "success" with error events stays a success while the counters keep the errors', async () => {
    const sessionId = `recovered-${sequence}`;
    await streamStart(sessionId);
    await drainPendingTasks();
    await streamEvent(sessionId, toolCall('flaky', { status: 'error', error: { message: 'retried' } }));
    await drainPendingTasks();
    await streamEnd(sessionId, { status: 'success', durationMs: 900 });
    await settle();

    expect(await session(sessionId)).toMatchObject({ status: 'success', errorEvents: 1, toolErrors: 1 });
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0, errorEvents: 1, toolErrors: 1 });
  });

  it('stream: an error landing after a /end without a status flips the derived status and books one correction', async () => {
    const sessionId = `late-${sequence}`;
    await streamStart(sessionId);
    await drainPendingTasks();
    await streamEvent(sessionId, aiCall());
    await drainPendingTasks();
    // The client sends no status: the counters derive 'success' (nothing failed yet), and the status stays flippable.
    await streamEnd(sessionId, { durationMs: 1000 });
    await settle();

    expect(await session(sessionId)).toMatchObject({ status: 'success', statusExplicit: false });
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0 });

    // The SDK does not wait for /events before /end: this one arrives late.
    const late = await streamEvent(sessionId, toolCall('late-tool', { status: 'error', error: { message: 'late' } }));
    expect(late.statusCode).toBe(200);
    await settle();

    const flipped = await session(sessionId);
    expect(flipped).toMatchObject({ status: 'error', errorEvents: 1, toolErrors: 1 });
    expect(flipped?.metricsOutcome?.status).toBe('error');
    // Still ONE request: only the error is added.
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1, toolErrors: 1, errorEvents: 1 });

    // A second late error does not book a second correction.
    await streamEvent(sessionId, toolCall('late-tool-2', { status: 'error', error: { message: 'later' } }));
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1, toolErrors: 2, errorEvents: 2 });
  });

  it('stream: an error landing after a client "success" keeps it a success while the counters keep the error', async () => {
    const sessionId = `late-explicit-${sequence}`;
    await streamStart(sessionId);
    await drainPendingTasks();
    await streamEvent(sessionId, aiCall());
    await drainPendingTasks();
    await streamEnd(sessionId, { status: 'success', durationMs: 1000 });
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'success', statusExplicit: true });

    // Same late event as above, but the client itself called the run a success: that outcome never depends on
    // whether /events or /end arrives first.
    const late = await streamEvent(sessionId, toolCall('late-tool', { status: 'error', error: { message: 'late' } }));
    expect(late.statusCode).toBe(200);
    await settle();

    const kept = await session(sessionId);
    expect(kept).toMatchObject({ status: 'success', statusExplicit: true, errorEvents: 1, toolErrors: 1 });
    expect(kept?.metricsOutcome?.status).toBe('success');
    // No correction: the run is still one successful request; only the event-level error counters moved.
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0, errorEvents: 1, toolErrors: 1 });
  });

  it('stream: re-starting an ended session re-arms it, and the next /end decides whether its status is explicit', async () => {
    const sessionId = `reopen-${sequence}`;
    await streamStart(sessionId);
    await drainPendingTasks();
    await streamEnd(sessionId, { status: 'success', durationMs: 500 });
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'success', statusExplicit: true });

    // A second leg of the same logical run: open again, the first leg's client status no longer describes it.
    await streamStart(sessionId);
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress', statusExplicit: false });

    await streamEnd(sessionId, { durationMs: 700 });
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'success', statusExplicit: false });
  });

  it('stream: an error landing while /end has stored the status but not yet its outcome marker is still booked', async () => {
    const sessionId = `race-${sequence}`;
    await streamStart(sessionId);
    await drainPendingTasks();
    await streamEvent(sessionId, aiCall());
    await drainPendingTasks();

    // /end wrote status=success and is still pricing the session: no marker is stored yet.
    await db.switchToTenant(dbName);
    await db.updateAgentTracingSession(sessionId, { status: 'success', endedAt: new Date(), durationMs: 1000 }, projectId);
    expect((await session(sessionId))?.metricsOutcome).toBeFalsy();

    await streamEvent(sessionId, toolCall('late-tool', { status: 'error', error: { message: 'late' } }));
    await settle();

    const flipped = await session(sessionId);
    expect(flipped).toMatchObject({ status: 'error', errorEvents: 1 });
    expect(flipped?.metricsOutcome?.status).toBe('error');
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1 });
  });

  // ── abandoned sessions and the finalizer ──────────────────────────────────

  /** A moment far enough ahead that every session started now counts as idle. */
  const later = () => Date.now() + 7 * 3_600_000;

  it('finalizer: abandons an idle session once and books it as abandoned, not as an error', async () => {
    const sessionId = `idle-${sequence}`;
    await streamStart(sessionId);
    await settle();
    expect((await session(sessionId))?.status).toBe('in_progress');

    // Nothing is stale yet for the real clock.
    await triggerTracingSessionFinalizerRun();
    expect((await session(sessionId))?.status).toBe('in_progress');

    await sweepStaleTracingSessions(later());
    await settle();

    const abandoned = await session(sessionId);
    expect(abandoned?.status).toBe('abandoned');
    expect(abandoned?.metricsOutcome).toMatchObject({ status: 'abandoned', latencyRecorded: false });
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0, abandoned: 1, latencyCount: 0 });
  });

  it('finalizer: the OTLP pass lists OTLP sessions only (filtered by the database), the abandon pass every source', async () => {
    const listed = vi.spyOn(db, 'listStaleAgentTracingSessions');
    try {
      await sweepStaleTracingSessions(later());
      const inputs = listed.mock.calls.map(([input]) => input);
      const withSource = inputs.filter((input) => input.source !== undefined);
      const withoutSource = inputs.filter((input) => input.source === undefined);
      // Every tenant is swept: one OTLP listing and at least one abandon listing each.
      expect(withSource.length).toBeGreaterThan(0);
      expect(withSource.every((input) => input.source === 'otlp')).toBe(true);
      expect(withoutSource.length).toBeGreaterThan(0);
      // The OTLP pass looks at a shorter idle window than the abandon pass.
      const oldestOtlpCutoff = Math.min(...withSource.map((input) => input.updatedBefore.getTime()));
      const newestAbandonCutoff = Math.max(...withoutSource.map((input) => input.updatedBefore.getTime()));
      expect(oldestOtlpCutoff).toBeGreaterThan(newestAbandonCutoff);
    } finally {
      listed.mockRestore();
    }
  });

  it('finalizer: a session stranded for more than a day is closed as history and books nothing', async () => {
    const stranded = `stranded-${sequence}`;
    await streamStart(stranded);
    await settle();

    // Three days later: the run is history, not current health.
    await sweepStaleTracingSessions(Date.now() + 3 * DAY_MS);
    await settle();

    const closed = await session(stranded);
    expect(closed?.status).toBe('abandoned');
    expect(closed?.metricsOutcome).toBeFalsy();
    expect(await row('agent', agent)).toBeUndefined();
  });

  it('finalizer: a late /end revives an abandoned session and only the difference is booked', async () => {
    const sessionId = `revive-${sequence}`;
    await streamStart(sessionId);
    await settle();
    await sweepStaleTracingSessions(later());
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, abandoned: 1, latencyCount: 0 });

    const end = await streamEnd(sessionId, { status: 'success', durationMs: 5000 });
    expect(end.statusCode, end.body).toBe(200);
    await settle();

    const revived = await session(sessionId);
    expect(revived).toMatchObject({ status: 'success' });
    expect(revived?.metricsOutcome).toMatchObject({ status: 'success', latencyRecorded: true });
    expect(await row('agent', agent)).toMatchObject({
      requests: 1, errors: 0, abandoned: 0, latencyCount: 1, latencyMsSum: 5000,
    });

    // A retried /end changes nothing.
    await streamEnd(sessionId, { status: 'success', durationMs: 5000 });
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, abandoned: 0, latencyCount: 1 });
  });

  it('finalizer: two concurrent sweeps abandon each session exactly once (compare-and-set)', async () => {
    const ids = [`cas-a-${sequence}`, `cas-b-${sequence}`, `cas-c-${sequence}`];
    for (const id of ids) await streamStart(id);
    await settle();

    const cutoff = later();
    const [first, second] = await Promise.all([sweepStaleTracingSessions(cutoff), sweepStaleTracingSessions(cutoff)]);
    await settle();

    // Sessions of other tenants in the shared test database may be swept too, so only a lower bound is stable.
    expect(first.abandoned + second.abandoned).toBeGreaterThanOrEqual(3);
    for (const id of ids) expect((await session(id))?.status).toBe('abandoned');
    expect(await row('agent', agent)).toMatchObject({ requests: 3, abandoned: 3, errors: 0 });
  });

  // ── batch ─────────────────────────────────────────────────────────────────

  const batch = (payload: Json) => post('/api/client/v1/tracing/sessions', payload);

  it('batch: derives the status when the client omits it, keeps a client status, and is idempotent on re-posts', async () => {
    const startedAt = new Date(Date.now() - 4000).toISOString();
    const endedAt = new Date().toISOString();
    const okEvent = aiCall({ durationMs: 200 });
    const toolOk = toolCall('lookup');
    const toolBad = toolCall('broken', { status: 'error', error: 'exploded' });
    const gatewayServed = aiCall({ model: 'gpt-x', metadata: { gatewayRequestId: 'gw-1' } });

    const sessionId = `batch-${sequence}`;
    const payload = {
      sessionId, agent: { name: agent }, startedAt, endedAt,
      events: [okEvent, toolOk, toolBad, gatewayServed],
    };
    expect((await batch(payload)).statusCode).toBe(200);
    await settle();

    const stored = await session(sessionId);
    expect(stored).toMatchObject({ status: 'error', errorEvents: 1, toolErrors: 1, aiErrors: 0, statusExplicit: false });
    // Duration comes from the client's own start and end when it sends none.
    expect(stored?.durationMs).toBeGreaterThanOrEqual(3900);
    expect(stored?.durationMs).toBeLessThanOrEqual(4100);

    const agentRow = await row('agent', agent);
    expect(agentRow).toMatchObject({ requests: 1, errors: 1, aiCalls: 2, toolCalls: 2, toolErrors: 1, errorEvents: 1 });
    // The gateway-served call is an agent call but never a model-row call (the gateway already counted it).
    expect(await row('model', 'gpt-hub')).toMatchObject({ requests: 1, inputTokens: 1000 });
    expect(await row('tool', 'broken')).toMatchObject({ requests: 1, errors: 1 });

    // Re-posting the same session contributes nothing new.
    expect((await batch(payload)).statusCode).toBe(200);
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1, aiCalls: 2, toolCalls: 2, toolErrors: 1 });
    expect(await row('model', 'gpt-hub')).toMatchObject({ requests: 1 });

    // The client calls a recovered session a success: that wins, the errors stay counted.
    const recoveredId = `batch-recovered-${sequence}`;
    expect((await batch({ ...payload, sessionId: recoveredId, status: 'success' })).statusCode).toBe(200);
    await settle();
    expect(await session(recoveredId)).toMatchObject({ status: 'success', errorEvents: 1, statusExplicit: true });

    // No errors and no status: an ended session is a success, never 'unknown'.
    const cleanId = `batch-clean-${sequence}`;
    expect((await batch({ sessionId: cleanId, agent: { name: agent }, startedAt, endedAt, events: [aiCall()] })).statusCode).toBe(200);
    await settle();
    expect(await session(cleanId)).toMatchObject({ status: 'success', errorEvents: 0, statusExplicit: false });
  });

  it('batch: a re-post that adds a failed call books only the new call and the status change', async () => {
    const sessionId = `batch-grow-${sequence}`;
    const startedAt = new Date(Date.now() - 2000).toISOString();
    const first = aiCall();
    expect((await batch({ sessionId, agent: { name: agent }, startedAt, endedAt: new Date().toISOString(), events: [first] })).statusCode).toBe(200);
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0, aiCalls: 1 });

    const failed = aiCall({ status: 'error', error: { message: 'rate limited' }, inputTokens: 0, outputTokens: 0 });
    expect((await batch({ sessionId, agent: { name: agent }, startedAt, endedAt: new Date().toISOString(), events: [first, failed] })).statusCode).toBe(200);
    await settle();

    expect(await session(sessionId)).toMatchObject({ status: 'error', aiErrors: 1 });
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1, aiCalls: 2, aiErrors: 1 });
    // The failed call shows up on the model row even though it carried no tokens.
    expect(await row('model', 'gpt-hub')).toMatchObject({ requests: 2, errors: 1 });
  });

  // ── OTLP ──────────────────────────────────────────────────────────────────

  const nano = (ms: number) => String(BigInt(Math.round(ms)) * BigInt(1_000_000));
  const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });
  const intAttr = (key: string, value: number) => ({ key, value: { intValue: String(value) } });

  function otlp(traceId: string, sessionId: string, spans: Json[]) {
    return {
      resourceSpans: [{
        resource: { attributes: [attr('service.name', agent), attr('cognipeer.session.id', sessionId)] },
        scopeSpans: [{ spans: spans.map((span) => ({ traceId, ...span })) }],
      }],
    };
  }
  // One fixed instant per test: span times must not drift between exports of the same trace.
  let base = 0;
  const now = () => base;
  const llmSpan = (spanId: string, over: Json = {}) => ({
    spanId, parentSpanId: 'root', name: 'chat',
    startTimeUnixNano: nano(now() - 3000), endTimeUnixNano: nano(now() - 2700),
    attributes: [
      attr('openinference.span.kind', 'LLM'), attr('llm.model_name', 'gpt-x'),
      intAttr('llm.token_count.prompt', 1000), intAttr('llm.token_count.completion', 500),
    ],
    ...over,
  });
  const toolSpan = (spanId: string, name: string, over: Json = {}) => ({
    spanId, parentSpanId: 'root', name: `tool ${name}`,
    startTimeUnixNano: nano(now() - 2600), endTimeUnixNano: nano(now() - 2550),
    attributes: [attr('cognipeer.event.type', 'tool_call'), attr('cognipeer.actor.scope', 'tool'), attr('cognipeer.actor.name', name)],
    ...over,
  });
  const rootSpan = (over: Json = {}) => ({
    spanId: 'root', name: 'agent_session',
    startTimeUnixNano: nano(now() - 3500), endTimeUnixNano: nano(now() - 1500),
    ...over,
  });
  const exportTraces = (body: unknown) => post('/api/client/v1/traces', body);

  it('otlp: a session stays in progress until the root span arrives, then it is booked once', async () => {
    const sessionId = `otlp-${sequence}`;
    const traceId = `trace-${sequence}-aaaaaaaaaaaaaaaa`;
    const children = otlp(traceId, sessionId, [llmSpan('llm-1'), toolSpan('tool-1', 'otlp-search')]);

    expect((await exportTraces(children)).statusCode).toBe(200);
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress', errorEvents: 0 });
    // Event counters flow immediately; the run itself is not booked yet.
    expect(await row('agent', agent)).toMatchObject({ requests: 0, aiCalls: 1, toolCalls: 1 });
    expect(await row('model', 'gpt-hub')).toMatchObject({ requests: 1, inputTokens: 1000 });
    expect(await row('tool', 'otlp-search')).toMatchObject({ requests: 1, errors: 0 });

    // The root span ends: the run is over.
    expect((await exportTraces(otlp(traceId, sessionId, [rootSpan()]))).statusCode).toBe(200);
    await settle();
    const done = await session(sessionId);
    expect(done).toMatchObject({ status: 'success' });
    // OTLP carries no client status, so a late error span may always flip it.
    expect(done?.statusExplicit ?? false).toBe(false);
    expect(done?.metricsOutcome).toMatchObject({ status: 'success', latencyRecorded: true });
    expect(await row('agent', agent)).toMatchObject({
      requests: 1, errors: 0, aiCalls: 1, toolCalls: 1, latencyCount: 1, latencyMsSum: 2000,
    });

    // The whole export again: deduplicated by span, nothing is counted twice.
    expect((await exportTraces(otlp(traceId, sessionId, [rootSpan(), llmSpan('llm-1'), toolSpan('tool-1', 'otlp-search')]))).statusCode).toBe(200);
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, aiCalls: 1, toolCalls: 1 });
    expect(await row('model', 'gpt-hub')).toMatchObject({ requests: 1 });
    expect((await row('agent', agent))?.costUsd).toBeCloseTo(0.002, 6);
  });

  it('otlp: an error on a child span, on the root status or as a root exception makes the session an error', async () => {
    const childFail = `otlp-child-${sequence}`;
    expect((await exportTraces(otlp(`t-${sequence}-child-aaaaaaaa`, childFail, [
      rootSpan(), toolSpan('bad-tool', 'otlp-bad', { status: { code: 2, message: 'nope' } }),
    ]))).statusCode).toBe(200);

    const rootFail = `otlp-root-${sequence}`;
    expect((await exportTraces(otlp(`t-${sequence}-root-aaaaaaaaa`, rootFail, [rootSpan({ status: { code: 2 } })]))).statusCode).toBe(200);

    const rootException = `otlp-exc-${sequence}`;
    expect((await exportTraces(otlp(`t-${sequence}-exc-aaaaaaaaaa`, rootException, [
      rootSpan({ events: [{ name: 'exception', timeUnixNano: nano(now()), attributes: [attr('exception.message', 'crashed')] }] }),
    ]))).statusCode).toBe(200);

    const okId = `otlp-ok-${sequence}`;
    expect((await exportTraces(otlp(`t-${sequence}-ok-aaaaaaaaaaa`, okId, [rootSpan()]))).statusCode).toBe(200);
    await settle();

    expect(await session(childFail)).toMatchObject({ status: 'error', errorEvents: 1, toolErrors: 1 });
    expect(await session(rootFail)).toMatchObject({ status: 'error' });
    const exceptionSession = await session(rootException);
    expect(exceptionSession?.status).toBe('error');
    expect(exceptionSession?.errors?.some((error) => error.message === 'crashed')).toBe(true);
    expect(await session(okId)).toMatchObject({ status: 'success' });
    expect(await row('agent', agent)).toMatchObject({ requests: 4, errors: 3 });
  });

  it('otlp: an error span that arrives after the root flips the booked session', async () => {
    const sessionId = `otlp-late-${sequence}`;
    const traceId = `t-${sequence}-late-aaaaaaaaaa`;
    await exportTraces(otlp(traceId, sessionId, [rootSpan(), llmSpan('late-llm')]));
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'success' });
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0 });

    await exportTraces(otlp(traceId, sessionId, [toolSpan('late-tool', 'otlp-late', { status: { code: 2 } })]));
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'error', errorEvents: 1 });
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1, toolErrors: 1 });
  });

  // ── OTLP without an exported root ─────────────────────────────────────────

  /** An agent span whose parent lives in another service (remote W3C parent): no span of the trace is parentless. */
  const remoteAgentSpan = (over: Json = {}) => ({
    spanId: 'agent-span', parentSpanId: 'remote-parent', name: 'invoke_agent',
    startTimeUnixNano: nano(now() - 3500), endTimeUnixNano: nano(now() - 1500),
    ...over,
  });
  /** Past the OTLP quiet window (10 min) but well before the 6 h stale window. */
  const quietLater = () => Date.now() + 11 * 60_000;

  it('otlp: a run whose root span is never exported is finalized as success after the quiet window and booked once', async () => {
    const sessionId = `otlp-remote-ok-${sequence}`;
    const traceId = `t-${sequence}-remote-ok-aaaaaa`;
    const idleStream = `idle-stream-${sequence}`;
    await streamStart(idleStream);
    expect((await exportTraces(otlp(traceId, sessionId, [remoteAgentSpan(), llmSpan('r-llm', { parentSpanId: 'agent-span' })]))).statusCode).toBe(200);
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress' });
    expect(await row('agent', agent)).toMatchObject({ requests: 0, aiCalls: 1 });

    const first = await sweepStaleTracingSessions(quietLater());
    await settle();
    expect(first.finalized).toBeGreaterThanOrEqual(1);
    const done = await session(sessionId);
    expect(done).toMatchObject({ status: 'success' });
    expect(done?.metricsOutcome).toMatchObject({ status: 'success' });
    // A non-OTLP run is only abandoned after the stale window.
    expect((await session(idleStream))?.status).toBe('in_progress');
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0, abandoned: 0 });

    await sweepStaleTracingSessions(quietLater());
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0, abandoned: 0 });
  });

  it('otlp: a run without an exported root that saw a child error stays in progress, then is finalized as error and booked once', async () => {
    const sessionId = `otlp-remote-err-${sequence}`;
    const traceId = `t-${sequence}-remote-err-aaaaa`;
    expect((await exportTraces(otlp(traceId, sessionId, [
      remoteAgentSpan(),
      toolSpan('r-bad', 'otlp-remote-bad', { parentSpanId: 'agent-span', status: { code: 2, message: 'boom' } }),
    ]))).statusCode).toBe(200);
    await settle();
    // Not terminal yet, so the booking gate cannot strand it; the error is already counted per event.
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress', errorEvents: 1, toolErrors: 1 });
    expect(await row('agent', agent)).toMatchObject({ requests: 0, errorEvents: 1, toolErrors: 1 });

    await sweepStaleTracingSessions(quietLater());
    await settle();
    const done = await session(sessionId);
    expect(done).toMatchObject({ status: 'error' });
    expect(done?.metricsOutcome).toMatchObject({ status: 'error' });
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1, abandoned: 0 });

    await sweepStaleTracingSessions(quietLater());
    await settle();
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 1 });
  });

  // ── OTLP from the SDK, a run exported in legs ────────────────────────────

  /**
   * A copy of an SDK golden request under this test's own session and trace id, so legs of one run still share
   * both and different tests never meet. The SDK leaves the root out of a leg that ends in a pause.
   */
  function sdkLeg(fixture: unknown, sessionId: string, traceId: string) {
    const request = JSON.parse(JSON.stringify(fixture)) as {
      resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeSpans: Array<{ spans: Array<Json> }> }>;
    };
    for (const resource of request.resourceSpans) {
      for (const attribute of resource.resource.attributes) {
        if (attribute.key === 'cognipeer.session.id') attribute.value.stringValue = sessionId;
        if (attribute.key === 'service.name') attribute.value.stringValue = agent;
      }
      for (const scope of resource.scopeSpans) for (const span of scope.spans) span.traceId = traceId;
    }
    return request;
  }
  const sdkRootSpanId = (fixture: unknown) =>
    (fixture as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ spanId: string; attributes: Array<{ key: string }> }> }> }> })
      .resourceSpans[0].scopeSpans[0].spans.find((span) => span.attributes.some((a) => a.key === 'cognipeer.session.status'))!.spanId;
  async function eventsOf(sessionId: string) {
    await db.switchToTenant(dbName);
    return db.listAgentTracingEvents(sessionId, projectId);
  }

  it('otlp sdk legs: a run paused for a person and resumed stays one session, the real root replaces the fallback, container durations are not added', async () => {
    const sessionId = `sdk-legs-${sequence}`;
    const traceId = `0af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    expect((await exportTraces(sdkLeg(sdkLegsLeg1, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    const paused = await session(sessionId);
    expect(paused).toMatchObject({ status: 'in_progress' });
    expect(paused?.rootSpanId).not.toBe(sdkRootSpanId(sdkLegsLeg2));
    expect(await eventsOf(sessionId)).toHaveLength(3);

    expect((await exportTraces(sdkLeg(sdkLegsLeg2, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    const done = await session(sessionId);
    expect(done).toMatchObject({ status: 'success', totalEvents: 7 });
    expect(done?.rootSpanId).toBe(sdkRootSpanId(sdkLegsLeg2));
    const events = await eventsOf(sessionId);
    expect(events.map((event) => event.sequence).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Iterations are widened to cover their children by the exporter; only the leaves add up.
    const leafMs = events
      .filter((event) => event.type !== 'agent_iteration' && event.type !== 'span')
      .reduce((total, event) => total + (event.durationMs ?? 0), 0);
    const containerMs = events
      .filter((event) => event.type === 'agent_iteration' || event.type === 'span')
      .reduce((total, event) => total + (event.durationMs ?? 0), 0);
    expect(containerMs).toBeGreaterThan(0);
    expect(done?.summary?.totalDurationMs).toBe(leafMs);

    // The same legs again change nothing (deduplicated by the events' identity).
    expect((await exportTraces(sdkLeg(sdkLegsLeg2, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    expect(await eventsOf(sessionId)).toHaveLength(7);
  });

  it('otlp sdk legs: a session waiting for an approval is neither finalized nor abandoned until it is history', async () => {
    const sessionId = `sdk-wait-${sequence}`;
    const traceId = `1af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    expect((await exportTraces(sdkLeg(sdkSubagentLeg1, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    expect((await eventsOf(sessionId)).find((event) => event.type === 'tool_approval')?.status).toBe('pending');

    // Past the OTLP quiet window, and past the stale window: a person may take that long.
    await sweepStaleTracingSessions(quietLater());
    await sweepStaleTracingSessions(later());
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress' });
    expect((await session(sessionId))?.metricsOutcome).toBeFalsy();

    // The answer arrives after the quiet window: it lands in the same session and finishes it.
    expect((await exportTraces(sdkLeg(sdkSubagentLeg2, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    const done = await session(sessionId);
    expect(done).toMatchObject({ status: 'success' });
    expect(done?.rootSpanId).toBe(sdkRootSpanId(sdkSubagentLeg2));
    expect(await eventsOf(sessionId)).toHaveLength(13);
  });

  it('otlp sdk legs: a pause nobody answers is closed once it is history', async () => {
    const sessionId = `sdk-wait-history-${sequence}`;
    const traceId = `2af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    expect((await exportTraces(sdkLeg(sdkSubagentLeg1, sessionId, traceId))).statusCode).toBe(200);
    await settle();

    await sweepStaleTracingSessions(Date.now() + 3 * DAY_MS);
    await settle();
    const closed = await session(sessionId);
    expect(closed?.status).not.toBe('in_progress');
    // History books nothing.
    expect(closed?.metricsOutcome).toBeFalsy();
  });

  it('otlp sdk legs: a session whose latest event is not pending is still finalized after the quiet window', async () => {
    const sessionId = `sdk-quiet-${sequence}`;
    const traceId = `3af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    // The second leg without its root: the run answered, did more work, and the root never arrived.
    const request = sdkLeg(sdkLegsLeg2, sessionId, traceId);
    request.resourceSpans[0].scopeSpans[0].spans = request.resourceSpans[0].scopeSpans[0].spans
      .filter((span) => (span.spanId as string) !== sdkRootSpanId(sdkLegsLeg2));
    expect((await exportTraces(sdkLeg(sdkLegsLeg1, sessionId, traceId))).statusCode).toBe(200);
    expect((await exportTraces(request)).statusCode).toBe(200);
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress' });

    await sweepStaleTracingSessions(quietLater());
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'success' });
  });

  it('otlp sdk legs: an approval stays open when another record is written after the request', async () => {
    const sessionId = `sdk-wait-late-${sequence}`;
    const traceId = `4af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    // A sibling tool (or a parallel sub-agent) finishes after the approval was recorded: the request is not the last event.
    const request = sdkLeg(sdkLegsLeg1, sessionId, traceId);
    const spans = request.resourceSpans[0].scopeSpans[0].spans as Array<{ spanId: string; attributes: Array<{ key: string; value: Record<string, string> }> }>;
    const model = JSON.parse(JSON.stringify(spans.find((span) => span.attributes.some((a) => a.key === 'cognipeer.event.type' && a.value.stringValue === 'ai_call')))) as typeof spans[number];
    model.spanId = 'a0000000000000f1';
    for (const attribute of model.attributes) {
      if (attribute.key === 'cognipeer.event.sequence') attribute.value = { intValue: '4' };
      if (attribute.key === 'cognipeer.event.id') attribute.value = { stringValue: 'evt_late_ai_call' };
    }
    spans.push(model);
    expect((await exportTraces(request)).statusCode).toBe(200);
    await settle();
    const stored = await eventsOf(sessionId);
    expect(stored.map((event) => [event.sequence, event.type, event.status])).toEqual([
      [1, 'agent_iteration', 'success'], [2, 'ai_call', 'success'], [3, 'tool_approval', 'pending'], [4, 'ai_call', 'success'],
    ]);

    await sweepStaleTracingSessions(quietLater());
    await sweepStaleTracingSessions(later());
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress' });

    // The answer lands in the same session.
    expect((await exportTraces(sdkLeg(sdkLegsLeg2, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'success' });
  });

  it('otlp sdk legs: a waiting session costs one small read per sweep, not an event list, and is not read again in the stale pass', async () => {
    const sessionId = `sdk-wait-cost-${sequence}`;
    const traceId = `8af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    expect((await exportTraces(sdkLeg(sdkSubagentLeg1, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    const proto = Object.getPrototypeOf(db) as { getAgentTracingWaitState: (...args: unknown[]) => unknown; listAgentTracingEvents: (...args: unknown[]) => unknown };
    const waitState = vi.spyOn(proto, 'getAgentTracingWaitState');
    const eventList = vi.spyOn(proto, 'listAgentTracingEvents');
    try {
      // Past the quiet window AND the stale window: both passes meet the session.
      await sweepStaleTracingSessions(later());
      const forSession = waitState.mock.calls.filter((call) => call[0] === sessionId);
      expect(forSession).toHaveLength(1);
      expect(eventList.mock.calls.filter((call) => call[0] === sessionId)).toHaveLength(0);
    } finally {
      waitState.mockRestore();
      eventList.mockRestore();
    }
    expect(await session(sessionId)).toMatchObject({ status: 'in_progress' });
  });

  it('otlp sdk legs: a resolved approval followed by later work does not keep the session open', async () => {
    const sessionId = `sdk-wait-done-${sequence}`;
    const traceId = `5af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    // Both legs without the root: the person answered, the run went on, and the root never arrived.
    const second = sdkLeg(sdkLegsLeg2, sessionId, traceId);
    second.resourceSpans[0].scopeSpans[0].spans = second.resourceSpans[0].scopeSpans[0].spans
      .filter((span) => (span.spanId as string) !== sdkRootSpanId(sdkLegsLeg2));
    expect((await exportTraces(sdkLeg(sdkLegsLeg1, sessionId, traceId))).statusCode).toBe(200);
    expect((await exportTraces(second)).statusCode).toBe(200);
    await settle();
    await sweepStaleTracingSessions(quietLater());
    await settle();
    expect(await session(sessionId)).toMatchObject({ status: 'success' });
  });

  it('otlp sdk legs: the session total counts the parent run only, not the delegated work', async () => {
    const sessionId = `sdk-total-${sequence}`;
    const traceId = `6af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    expect((await exportTraces(sdkLeg(sdkSubagentLeg1, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    expect((await exportTraces(sdkLeg(sdkSubagentLeg2, sessionId, traceId))).statusCode).toBe(200);
    await settle();
    const events = await eventsOf(sessionId);
    const ms = (event: (typeof events)[number]) => event.durationMs ?? 0;
    // The parent's own model calls (leg 1 and the closing one); the delegation call, the child span and everything under it are the child's.
    const parentCalls = events.filter((event) => event.type === 'ai_call' && event.model === 'gpt-4o');
    expect(parentCalls).toHaveLength(2);
    const delegation = events.find((event) => event.toolName === 'delegate_to')!;
    expect(ms(delegation)).toBeGreaterThan(30_000);
    expect((await session(sessionId))?.summary?.totalDurationMs).toBe(parentCalls.reduce((total, event) => total + ms(event), 0));
  });

  it('otlp gen_ai-only legs: a later request continues the numbering instead of colliding with the first', async () => {
    const traceId = `7af7651916cd43dd8448eb211c${String(sequence).padStart(6, '0')}`;
    const sessionId = `otlp_${traceId.slice(0, 16)}`;
    type Raw = { spanId: string; parentSpanId?: string };
    const leg = (suffix: string) => {
      const request = sdkLeg(sdkGenAiRun, sessionId, traceId);
      const scope = request.resourceSpans[0].scopeSpans[0];
      const root = (sdkGenAiRun.resourceSpans[0].scopeSpans[0].spans as Raw[])[0].spanId;
      // No root (a leg that ends in a pause has none), and span ids of their own for this leg.
      scope.spans = (scope.spans as Raw[]).filter((span) => span.spanId !== root).map((span) => ({
        ...span,
        spanId: `${suffix}${span.spanId.slice(1)}`,
        ...(span.parentSpanId && span.parentSpanId !== root ? { parentSpanId: `${suffix}${span.parentSpanId.slice(1)}` } : {}),
      }));
      return request;
    };
    expect((await exportTraces(leg('0'))).statusCode).toBe(200);
    await settle();
    expect((await exportTraces(leg('1'))).statusCode).toBe(200);
    await settle();
    const stored = await eventsOf(sessionId);
    expect(stored).toHaveLength(10);
    expect(stored.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The same request again is deduplicated by span and does not move the numbering on.
    expect((await exportTraces(leg('1'))).statusCode).toBe(200);
    await settle();
    expect((await eventsOf(sessionId)).map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  // ── hosted-agent sink ─────────────────────────────────────────────────────

  /** The SDK custom sink as the console builds it: `onSession` is what the hosted run posts at its end. */
  const onSession = (sink: unknown, hostedSession: unknown) =>
    (sink as { onSession: (value: unknown) => Promise<void> }).onSession(hostedSession);

  it('hosted sink: counts errors, derives the status, stamps the agent key and emits agent rows only', async () => {
    const sink = await createInternalTracingSink(dbName, tenantId, projectId, undefined, 'agent-key-1');
    const startedAt = new Date(Date.now() - 2000).toISOString();
    const events = [
      aiCall({ actor: { scope: 'agent' } }),
      toolCall('hosted-tool', { status: 'error', error: { message: 'tool down' } }),
    ];
    const sessionId = `hosted-${sequence}`;
    const hostedSession = {
      sessionId, traceId: sessionId, agent: { name: agent }, startedAt, endedAt: new Date().toISOString(),
      durationMs: 2000, summary: {}, errors: [], events,
    };
    await onSession(sink, hostedSession as never);
    await settle();

    const stored = await session(sessionId);
    expect(stored).toMatchObject({ status: 'error', errorEvents: 1, toolErrors: 1 });
    expect(stored?.metadata?.agentKey).toBe('agent-key-1');
    expect(stored?.metricsOutcome).toMatchObject({ status: 'error', latencyRecorded: true });

    const rows = await metrics('agent', ['entityKey', 'source']);
    const hosted = rows.find((candidate) => candidate.entityKey === agent && candidate.source === 'hosted');
    expect(hosted).toMatchObject({ requests: 1, errors: 1, aiCalls: 1, toolCalls: 1, toolErrors: 1, latencyCount: 1 });
    // Hosted model and tool calls are counted where they execute, not from the trace.
    expect(await metrics('model')).toHaveLength(0);
    expect(await metrics('tool')).toHaveLength(0);

    // The sink posts the whole session each time: a repeat adds nothing.
    await onSession(sink, hostedSession as never);
    await settle();
    expect(await metrics('agent', ['entityKey', 'source'])).toEqual(rows);
  });

  it('hosted sink: records whether the status came from the SDK, so only a derived status can be flipped later', async () => {
    const sink = await createInternalTracingSink(dbName, tenantId, projectId, undefined, 'agent-key-3');
    const finished = {
      agent: { name: agent }, startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(),
      durationMs: 500, summary: {}, errors: [],
    };
    const failing = [toolCall('flaky-hosted', { status: 'error', error: { message: 'retried' } })];

    await onSession(sink, { ...finished, sessionId: `h-sdk-${sequence}`, status: 'success', events: failing } as never);
    await onSession(sink, { ...finished, sessionId: `h-derived-${sequence}`, events: failing } as never);
    await onSession(sink, { ...finished, sessionId: `h-paused-flag-${sequence}`, status: 'in_progress', events: [aiCall()] } as never);
    await settle();

    // The SDK called the run a success: that wins over the error event, and it is remembered as explicit.
    expect(await session(`h-sdk-${sequence}`)).toMatchObject({ status: 'success', errorEvents: 1, statusExplicit: true });
    expect(await session(`h-derived-${sequence}`)).toMatchObject({ status: 'error', errorEvents: 1, statusExplicit: false });
    expect(await session(`h-paused-flag-${sequence}`)).toMatchObject({ status: 'in_progress', statusExplicit: false });
  });

  it('hosted sink: an SDK status wins, sink failures are not run failures, an in-progress post is not booked', async () => {
    const sink = await createInternalTracingSink(dbName, tenantId, projectId, undefined, 'agent-key-2');
    const base = { agent: { name: agent }, startedAt: new Date(Date.now() - 1000).toISOString(), summary: {}, events: [aiCall()] };

    await onSession(sink, { ...base, sessionId: `h-paused-${sequence}`, status: 'in_progress', errors: [] } as never);
    await onSession(sink, {
      ...base, sessionId: `h-sinkfail-${sequence}`, endedAt: new Date().toISOString(), durationMs: 800,
      errors: [{ type: 'sink', message: 'flush failed' }],
    } as never);
    await settle();

    expect((await session(`h-paused-${sequence}`))?.status).toBe('in_progress');
    expect(await session(`h-sinkfail-${sequence}`)).toMatchObject({ status: 'success' });
    // Only the finished run is booked.
    expect(await row('agent', agent)).toMatchObject({ requests: 1, errors: 0 });
  });
  it('hosted sink: a turn the caller stopped ends its session cancelled, not success', async () => {
    const sink = await createInternalTracingSink(dbName, tenantId, projectId, undefined, 'agent-key-4');
    const finished = {
      agent: { name: agent }, startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(),
      durationMs: 500, summary: {}, errors: [], events: [aiCall()], status: 'success',
    };
    const controller = new AbortController();
    controller.abort();
    await runWithTurnSignal(controller.signal, () => onSession(sink, { ...finished, sessionId: `h-cancel-${sequence}` } as never));
    await onSession(sink, { ...finished, sessionId: `h-ok-${sequence}` } as never);
    await settle();

    expect(await session(`h-cancel-${sequence}`)).toMatchObject({ status: 'cancelled', statusExplicit: true });
    expect(await session(`h-ok-${sequence}`)).toMatchObject({ status: 'success' });
  });

  it('hosted sink: a session a trigger started is stored with source trigger', async () => {
    const sink = await createInternalTracingSink(dbName, tenantId, projectId, undefined, 'agent-key-5');
    const base = {
      agent: { name: agent }, startedAt: new Date(Date.now() - 1000).toISOString(), endedAt: new Date().toISOString(),
      durationMs: 500, summary: {}, errors: [], events: [aiCall()], status: 'success',
    };
    await onSession(sink, { ...base, sessionId: `h-trig-${sequence}`, metadata: { source: 'trigger', triggerId: 'trg_9', trigger: 'webhook' } } as never);
    await onSession(sink, { ...base, sessionId: `h-api-${sequence}`, metadata: { source: 'api' } } as never);
    await settle();
    expect(await session(`h-trig-${sequence}`)).toMatchObject({ source: 'trigger', metadata: { triggerId: 'trg_9', trigger: 'webhook' } });
    expect((await session(`h-api-${sequence}`))?.source).toBe('custom');
  });
});
