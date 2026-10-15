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
import {
  __resetEntityMetricsRollupForTests,
  flushEntityMetricsRollup,
} from '@/lib/services/entityMetrics/entityMetricsRollup';
import {
  sweepStaleTracingSessions,
  triggerTracingSessionFinalizerRun,
} from '@/lib/services/tracing/sessionFinalizer';
import type { EntityMetricType, IEntityMetricAggregate } from '@/lib/database/provider/types.base';
import { clientTracingApiPlugin } from '@/server/api/plugins/client-tracing';
import { createFastifyApiTestApp } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

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

  it('stream: an error landing after /end flips the finished session and books one correction', async () => {
    const sessionId = `late-${sequence}`;
    await streamStart(sessionId);
    await drainPendingTasks();
    await streamEvent(sessionId, aiCall());
    await drainPendingTasks();
    await streamEnd(sessionId, { status: 'success', durationMs: 1000 });
    await settle();

    expect(await session(sessionId)).toMatchObject({ status: 'success' });
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
    expect(stored).toMatchObject({ status: 'error', errorEvents: 1, toolErrors: 1, aiErrors: 0 });
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
    expect(await session(recoveredId)).toMatchObject({ status: 'success', errorEvents: 1 });

    // No errors and no status: an ended session is a success, never 'unknown'.
    const cleanId = `batch-clean-${sequence}`;
    expect((await batch({ sessionId: cleanId, agent: { name: agent }, startedAt, endedAt, events: [aiCall()] })).statusCode).toBe(200);
    await settle();
    expect(await session(cleanId)).toMatchObject({ status: 'success', errorEvents: 0 });
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
});
