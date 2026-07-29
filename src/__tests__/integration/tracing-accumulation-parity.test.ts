/**
 * Tracing session accumulation, run against BOTH providers.
 *
 * These cover the code the production Fastify plugin actually calls. The
 * existing client-tracing-stream tests import the legacy `server/api/routes/**`
 * handlers and mock the database away, so they cannot see what the provider
 * mixins do — and the mixins are where the accounting lives.
 *
 * The defect being pinned: an SDK agent opens a trace session per `invoke()`, so
 * one logical run posts several `start`/`events`/`end` cycles under a single
 * caller-supplied sessionId. Anything that resets or overwrites the running
 * totals on a later cycle silently discards the earlier ones.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { describeForEachProvider } from './db-parity.helper';

type SessionSeed = {
  sessionId: string;
  projectId: string;
  tenantId: string;
};

function seedDoc(seed: SessionSeed) {
  return {
    sessionId: seed.sessionId,
    projectId: seed.projectId,
    tenantId: seed.tenantId,
    agentName: 'Pulse Worker Agent',
    status: 'in_progress',
    startedAt: new Date(),
    errors: [],
    modelsUsed: [],
    toolsUsed: [],
    eventCounts: {},
    totalEvents: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    summary: {
      totalDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCachedInputTokens: 0,
      eventCounts: {},
    },
  };
}

describeForEachProvider('Agent tracing session accumulation', (getDb) => {
  let seed: SessionSeed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `tracing-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Tracing',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { sessionId: `sess-${unique}`, projectId: `proj-${unique}`, tenantId: String(tenant._id) };
  });

  it('adds every event to the running totals', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    await db.applyAgentTracingSessionEvent(seed.sessionId, {
      inputTokens: 60, outputTokens: 40, cachedInputTokens: 10, durationMs: 700,
      eventType: 'ai_call', modelsUsed: ['gpt-5.4'],
    }, seed.projectId);
    await db.applyAgentTracingSessionEvent(seed.sessionId, {
      inputTokens: 200, outputTokens: 100, cachedInputTokens: 0, durationMs: 500,
      eventType: 'ai_call', modelsUsed: ['gpt-5.4'], toolsUsed: ['search'],
    }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.totalInputTokens).toBe(260);
    expect(session?.totalOutputTokens).toBe(140);
    expect(session?.totalCachedInputTokens).toBe(10);
    expect(session?.totalEvents).toBe(2);
    expect(session?.eventCounts).toEqual({ ai_call: 2 });
    expect(session?.modelsUsed).toEqual(['gpt-5.4']);
    expect(session?.toolsUsed).toEqual(['search']);
  });

  it('keeps the summary equal to the denormalized columns', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    await db.applyAgentTracingSessionEvent(seed.sessionId, {
      inputTokens: 25, outputTokens: 5, durationMs: 100, eventType: 'ai_call',
    }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    const summary = session?.summary as Record<string, unknown>;
    expect(summary.totalInputTokens).toBe(session?.totalInputTokens);
    expect(summary.totalOutputTokens).toBe(session?.totalOutputTokens);
    expect(summary.totalDurationMs).toBe(100);
    expect(summary.eventCounts).toEqual({ ai_call: 1 });
  });

  it('still accumulates when a stored total is not a number', async () => {
    // Session fields come from unvalidated client JSON, and the batch ingest path
    // stores `summary` verbatim. A single string in there used to make the whole
    // event update fail, so the session stopped counting entirely.
    const db = getDb();
    const doc = seedDoc(seed);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (doc.summary as any).totalInputTokens = '500';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(doc as any);

    await db.applyAgentTracingSessionEvent(seed.sessionId, {
      inputTokens: 10, eventType: 'ai_call',
    }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.totalInputTokens).toBe(10);
    expect(session?.totalEvents).toBe(1);
  });

  it('normalizes event types that would otherwise read as a field path', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'ai.call' }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.eventCounts).toEqual({ ai_call: 1 });
  });

  it('ignores a token value that is not a number rather than counting it', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    await db.applyAgentTracingSessionEvent(seed.sessionId, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputTokens: '100' as any,
      eventType: 'ai_call',
    }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.totalInputTokens).toBe(0);
    expect(session?.totalEvents).toBe(1);
  });

  it('survives concurrent events without losing any of them', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.applyAgentTracingSessionEvent(seed.sessionId, {
          inputTokens: 10, outputTokens: 5, eventType: 'ai_call',
        }, seed.projectId)),
    );

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.totalEvents).toBe(8);
    expect(session?.totalInputTokens).toBe(80);
    expect(session?.totalOutputTokens).toBe(40);
  });
});
