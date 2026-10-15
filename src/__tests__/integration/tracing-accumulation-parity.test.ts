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
      reasoningTokens: 15, finishReason: 'stop',
      eventType: 'ai_call', modelsUsed: ['gpt-5.4'],
    }, seed.projectId);
    await db.applyAgentTracingSessionEvent(seed.sessionId, {
      inputTokens: 200, outputTokens: 100, cachedInputTokens: 0, durationMs: 500,
      reasoningTokens: 25, finishReason: 'length',
      eventType: 'ai_call', modelsUsed: ['gpt-5.4'], toolsUsed: ['search'],
    }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.totalInputTokens).toBe(260);
    expect(session?.totalOutputTokens).toBe(140);
    expect(session?.totalCachedInputTokens).toBe(10);
    expect(session?.totalReasoningTokens).toBe(40);
    expect(session?.truncatedEvents).toBe(1);
    expect(session?.totalEvents).toBe(2);
    expect(session?.eventCounts).toEqual({ ai_call: 2 });
    expect(session?.modelsUsed).toEqual(['gpt-5.4']);
    expect(session?.toolsUsed).toEqual(['search']);
  });

  it('accumulates reasoningTokens and truncatedEvents identically across multiple event cycles', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    // Mixes normal completions (stop/tool_calls) with token-limit cutoffs
    // (length/max_tokens) — only the latter should bump truncatedEvents, and
    // reasoningTokens must keep accumulating even on events that reported none.
    const cycles: Array<{ reasoningTokens?: number; finishReason?: string }> = [
      { reasoningTokens: 20, finishReason: 'stop' },
      { reasoningTokens: 30, finishReason: 'length' },
      { reasoningTokens: 10, finishReason: 'max_tokens' },
      { finishReason: 'tool_calls' },
      { reasoningTokens: 5 }, // no finishReason reported this cycle
    ];

    for (const cycle of cycles) {
      await db.applyAgentTracingSessionEvent(seed.sessionId, {
        inputTokens: 100, outputTokens: 50, eventType: 'ai_call', ...cycle,
      }, seed.projectId);
    }

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.totalReasoningTokens).toBe(65);
    expect(session?.truncatedEvents).toBe(2);
    expect(session?.totalEvents).toBe(5);
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

describeForEachProvider('Agent tracing event update (migration primitive)', (getDb) => {
  let seed: SessionSeed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `tracing-evt-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Tracing Event',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { sessionId: `sess-${unique}`, projectId: `proj-${unique}`, tenantId: String(tenant._id) };
  });

  it('moves legacy metadata values into the columns and strips the consumed keys', async () => {
    const db = getDb();
    const eventId = `evt-${seed.sessionId}`;

    await db.createAgentTracingEvent({
      sessionId: seed.sessionId,
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      id: eventId,
      type: 'ai_call',
      metadata: { finishReason: 'stop', reasoningTokens: 42, keep: 'me' },
    });

    const updated = await db.updateAgentTracingEvent(
      seed.sessionId,
      eventId,
      { finishReason: 'stop', reasoningTokens: 42, metadata: { keep: 'me' } },
      seed.projectId,
    );

    expect(updated?.finishReason).toBe('stop');
    expect(updated?.reasoningTokens).toBe(42);
    expect(updated?.metadata).toEqual({ keep: 'me' });

    // Read back through the normal find path — must match what the update
    // call itself returned, on both providers.
    const reread = await db.findAgentTracingEventById(seed.sessionId, eventId, seed.projectId);
    expect(reread?.finishReason).toBe('stop');
    expect(reread?.reasoningTokens).toBe(42);
    expect(reread?.metadata).toEqual({ keep: 'me' });
  });

  it('returns null when the sessionId or eventId does not match', async () => {
    const db = getDb();
    const eventId = `evt-${seed.sessionId}`;

    await db.createAgentTracingEvent({
      sessionId: seed.sessionId,
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      id: eventId,
      type: 'ai_call',
      metadata: {},
    });

    const wrongSession = await db.updateAgentTracingEvent(
      `${seed.sessionId}-does-not-exist`,
      eventId,
      { finishReason: 'stop' },
      seed.projectId,
    );
    expect(wrongSession).toBeNull();

    const wrongEvent = await db.updateAgentTracingEvent(
      seed.sessionId,
      'evt-does-not-exist',
      { finishReason: 'stop' },
      seed.projectId,
    );
    expect(wrongEvent).toBeNull();
  });
});

describeForEachProvider('Agent tracing session error counters and late-error flip', (getDb) => {
  let seed: SessionSeed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `tracing-err-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Tracing Errors',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { sessionId: `sess-${unique}`, projectId: `proj-${unique}`, tenantId: String(tenant._id) };
  });

  it('accumulates errorEvents, toolErrors and aiErrors as top-level counters', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'tool_call', errorEvents: 1, toolErrors: 1 }, seed.projectId);
    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'ai_call', errorEvents: 1, aiErrors: 1 }, seed.projectId);
    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'ai_call' }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.errorEvents).toBe(2);
    expect(session?.toolErrors).toBe(1);
    expect(session?.aiErrors).toBe(1);
    expect(session?.totalEvents).toBe(3);
    // Counters never leak into `summary`: /end rewrites it wholesale.
    expect(Object.keys(session?.summary as object)).not.toContain('errorEvents');
  });

  it('starts counters at zero and tolerates a session created without them', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);
    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'ai_call' }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.errorEvents ?? 0).toBe(0);
    expect(session?.toolErrors ?? 0).toBe(0);
    expect(session?.aiErrors ?? 0).toBe(0);
  });

  it('survives concurrent error events without losing any', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'tool_call', errorEvents: 1, toolErrors: 1 }, seed.projectId)),
    );
    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.errorEvents).toBe(8);
    expect(session?.toolErrors).toBe(8);
  });

  it.each(['success', 'partial', 'unknown', 'completed'])(
    'flips a finished %s session to error when a late error event lands',
    async (status) => {
      const db = getDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.createAgentTracingSession({ ...seedDoc(seed), status } as any);

      await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'tool_call', errorEvents: 1, toolErrors: 1 }, seed.projectId);

      const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
      expect(session?.status).toBe('error');
    },
  );

  it.each(['in_progress', 'abandoned', 'error', 'cancelled'])(
    'does not touch a %s session on an error event',
    async (status) => {
      const db = getDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.createAgentTracingSession({ ...seedDoc(seed), status } as any);

      await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'tool_call', errorEvents: 1 }, seed.projectId);

      const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
      expect(session?.status).toBe(status);
    },
  );

  it('does not flip a session whose end status was supplied by the client', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession({ ...seedDoc(seed), status: 'success', statusExplicit: true } as any);
    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'tool_call', errorEvents: 1, toolErrors: 1 }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.status).toBe('success');
    expect(session?.errorEvents).toBe(1);
  });

  it('flips again once an update marks the status as derived', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession({ ...seedDoc(seed), status: 'success', statusExplicit: true } as any);
    await db.updateAgentTracingSession(seed.sessionId, { statusExplicit: false }, seed.projectId);
    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'tool_call', errorEvents: 1 }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.status).toBe('error');
  });

  it('does not flip a finished session on events without errors', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession({ ...seedDoc(seed), status: 'success' } as any);
    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'ai_call', errorEvents: 0 }, seed.projectId);
    await db.applyAgentTracingSessionEvent(seed.sessionId, { eventType: 'ai_call' }, seed.projectId);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.status).toBe('success');
  });

  it('round-trips counters and metricsOutcome through create and update', async () => {
    const db = getDb();
    const recordedAt = new Date('2026-10-01T10:00:00.000Z');
    await db.createAgentTracingSession({
      ...seedDoc(seed),
      errorEvents: 3,
      toolErrors: 2,
      aiErrors: 1,
      metricsOutcome: { status: 'error', latencyRecorded: false, recordedAt },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const created = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(created).toMatchObject({ errorEvents: 3, toolErrors: 2, aiErrors: 1 });
    expect(created?.metricsOutcome).toMatchObject({ status: 'error', latencyRecorded: false });
    expect(created?.metricsOutcome?.recordedAt.getTime()).toBe(recordedAt.getTime());

    const later = new Date('2026-10-01T10:05:00.000Z');
    await db.updateAgentTracingSession(seed.sessionId, {
      metricsOutcome: { status: 'success', latencyRecorded: true, recordedAt: later },
      errorEvents: 0,
    }, seed.projectId);
    const updated = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(updated?.metricsOutcome).toMatchObject({ status: 'success', latencyRecorded: true });
    expect(updated?.metricsOutcome?.recordedAt.getTime()).toBe(later.getTime());
    expect(updated?.errorEvents).toBe(0);

    await db.updateAgentTracingSession(seed.sessionId, { metricsOutcome: null }, seed.projectId);
    expect((await db.findAgentTracingSessionById(seed.sessionId, seed.projectId))?.metricsOutcome ?? null).toBeNull();
  });
});

describeForEachProvider('Stale agent tracing sessions (finalizer primitives)', (getDb) => {
  let seed: SessionSeed;
  const HOUR = 3_600_000;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `tracing-stale-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Tracing Stale',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { sessionId: `sess-${unique}`, projectId: `proj-${unique}`, tenantId: String(tenant._id) };
  });

  /** Creates a session, then back-dates its last activity (`updatedAt`) like an idle run. */
  async function seedIdle(
    sessionId: string,
    opts: { status?: string; idleMs: number; startedAgoMs?: number; projectId?: string; source?: string },
  ) {
    const db = getDb();
    const startedAt = new Date(Date.now() - (opts.startedAgoMs ?? opts.idleMs + HOUR));
    await db.createAgentTracingSession({
      ...seedDoc(seed),
      sessionId,
      projectId: opts.projectId ?? seed.projectId,
      status: opts.status ?? 'in_progress',
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      startedAt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await backdateUpdatedAt(db, sessionId, new Date(Date.now() - opts.idleMs));
  }

  async function backdateUpdatedAt(db: ReturnType<typeof getDb>, sessionId: string, at: Date) {
    const handle = (db as unknown as { getTenantDb(): unknown }).getTenantDb() as {
      prepare?: (sql: string) => { run: (p: unknown) => unknown };
      collection?: (n: string) => { updateOne: (f: unknown, u: unknown) => Promise<unknown> };
    };
    if (typeof handle.prepare === 'function') {
      handle.prepare('UPDATE agent_tracing_sessions SET updatedAt = @at WHERE sessionId = @sessionId').run({ at: at.toISOString(), sessionId });
    } else {
      await handle.collection!('agent_tracing_sessions').updateOne({ sessionId }, { $set: { updatedAt: at } });
    }
  }

  it('lists only in-progress sessions idle past the cutoff, oldest first, across projects', async () => {
    const db = getDb();
    await seedIdle(`${seed.sessionId}-old`, { idleMs: 10 * HOUR });
    await seedIdle(`${seed.sessionId}-older`, { idleMs: 20 * HOUR });
    await seedIdle(`${seed.sessionId}-fresh`, { idleMs: 1 * HOUR });
    await seedIdle(`${seed.sessionId}-done`, { idleMs: 30 * HOUR, status: 'success' });
    await seedIdle(`${seed.sessionId}-other`, { idleMs: 15 * HOUR, projectId: `${seed.projectId}-2` });

    const stale = await db.listStaleAgentTracingSessions({ updatedBefore: new Date(Date.now() - 6 * HOUR), limit: 100 });
    expect(stale.map((s) => s.sessionId)).toEqual([
      `${seed.sessionId}-older`,
      `${seed.sessionId}-other`,
      `${seed.sessionId}-old`,
    ]);
    expect(stale.every((s) => s.status === 'in_progress')).toBe(true);
    expect(typeof stale[0]._id).toBe('string');
    expect(stale[0].projectId).toBe(seed.projectId);

    const limited = await db.listStaleAgentTracingSessions({ updatedBefore: new Date(Date.now() - 6 * HOUR), limit: 1 });
    expect(limited.map((s) => s.sessionId)).toEqual([`${seed.sessionId}-older`]);
  });

  it('restricts the listing to one source, applied before the limit', async () => {
    const db = getDb();
    // The oldest idle sessions belong to other sources: they must not use up the limit of an OTLP-only listing.
    await seedIdle(`${seed.sessionId}-custom-1`, { idleMs: 20 * HOUR, source: 'custom' });
    await seedIdle(`${seed.sessionId}-custom-2`, { idleMs: 19 * HOUR, source: 'custom' });
    await seedIdle(`${seed.sessionId}-legacy`, { idleMs: 18 * HOUR });
    await seedIdle(`${seed.sessionId}-otlp-1`, { idleMs: 10 * HOUR, source: 'otlp' });
    await seedIdle(`${seed.sessionId}-otlp-2`, { idleMs: 8 * HOUR, source: 'otlp' });
    await seedIdle(`${seed.sessionId}-otlp-fresh`, { idleMs: 1 * HOUR, source: 'otlp' });
    await seedIdle(`${seed.sessionId}-otlp-done`, { idleMs: 30 * HOUR, source: 'otlp', status: 'success' });
    const updatedBefore = new Date(Date.now() - 6 * HOUR);

    const otlp = await db.listStaleAgentTracingSessions({ updatedBefore, limit: 100, source: 'otlp' });
    expect(otlp.map((s) => s.sessionId)).toEqual([`${seed.sessionId}-otlp-1`, `${seed.sessionId}-otlp-2`]);
    expect(otlp.every((s) => s.source === 'otlp' && s.status === 'in_progress')).toBe(true);

    const limited = await db.listStaleAgentTracingSessions({ updatedBefore, limit: 1, source: 'otlp' });
    expect(limited.map((s) => s.sessionId)).toEqual([`${seed.sessionId}-otlp-1`]);

    expect((await db.listStaleAgentTracingSessions({ updatedBefore, limit: 100, source: 'custom' })).map((s) => s.sessionId))
      .toEqual([`${seed.sessionId}-custom-1`, `${seed.sessionId}-custom-2`]);
    expect(await db.listStaleAgentTracingSessions({ updatedBefore, limit: 100, source: 'no-such-source' })).toEqual([]);

    // Without a source every source is listed, oldest first (the abandon pass).
    expect((await db.listStaleAgentTracingSessions({ updatedBefore, limit: 100 })).map((s) => s.sessionId)).toEqual([
      `${seed.sessionId}-custom-1`,
      `${seed.sessionId}-custom-2`,
      `${seed.sessionId}-legacy`,
      `${seed.sessionId}-otlp-1`,
      `${seed.sessionId}-otlp-2`,
    ]);
  });

  it('abandons a stale session: status, endedAt = last activity, durationMs = last activity - startedAt', async () => {
    const db = getDb();
    const sessionId = `${seed.sessionId}-a`;
    await seedIdle(sessionId, { idleMs: 10 * HOUR, startedAgoMs: 12 * HOUR });
    const before = await db.findAgentTracingSessionById(sessionId, seed.projectId);

    const abandoned = await db.abandonAgentTracingSession({
      projectId: seed.projectId,
      sessionId,
      updatedBefore: new Date(Date.now() - 6 * HOUR),
    });

    expect(abandoned?.status).toBe('abandoned');
    expect(abandoned?.endedAt?.getTime()).toBe(before!.updatedAt!.getTime());
    expect(abandoned?.durationMs).toBe(before!.updatedAt!.getTime() - before!.startedAt!.getTime());
    expect(abandoned?.durationMs).toBeGreaterThan(0);

    const reread = await db.findAgentTracingSessionById(sessionId, seed.projectId);
    expect(reread?.status).toBe('abandoned');
    expect(reread?.endedAt?.getTime()).toBe(before!.updatedAt!.getTime());

    // An abandoned session is no longer listed as stale.
    const stale = await db.listStaleAgentTracingSessions({ updatedBefore: new Date(), limit: 100 });
    expect(stale.map((s) => s.sessionId)).not.toContain(sessionId);
  });

  it('is a compare-and-set: a second abandon, a finished session and a fresh session are all left alone', async () => {
    const db = getDb();
    const cutoff = () => new Date(Date.now() - 6 * HOUR);
    await seedIdle(`${seed.sessionId}-b`, { idleMs: 10 * HOUR });
    await seedIdle(`${seed.sessionId}-done`, { idleMs: 10 * HOUR, status: 'success' });
    await seedIdle(`${seed.sessionId}-fresh`, { idleMs: 1 * HOUR });

    expect(await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId: `${seed.sessionId}-b`, updatedBefore: cutoff() })).not.toBeNull();
    expect(await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId: `${seed.sessionId}-b`, updatedBefore: cutoff() })).toBeNull();
    expect(await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId: `${seed.sessionId}-done`, updatedBefore: cutoff() })).toBeNull();
    expect(await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId: `${seed.sessionId}-fresh`, updatedBefore: cutoff() })).toBeNull();
    expect(await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId: 'does-not-exist', updatedBefore: cutoff() })).toBeNull();
    // The project is part of the identity.
    await seedIdle(`${seed.sessionId}-c`, { idleMs: 10 * HOUR });
    expect(await db.abandonAgentTracingSession({ projectId: `${seed.projectId}-x`, sessionId: `${seed.sessionId}-c`, updatedBefore: cutoff() })).toBeNull();

    expect((await db.findAgentTracingSessionById(`${seed.sessionId}-done`, seed.projectId))?.status).toBe('success');
    expect((await db.findAgentTracingSessionById(`${seed.sessionId}-fresh`, seed.projectId))?.status).toBe('in_progress');
  });

  it('loses the race to a late event: activity after the cutoff keeps the session in progress', async () => {
    const db = getDb();
    const sessionId = `${seed.sessionId}-race`;
    await seedIdle(sessionId, { idleMs: 10 * HOUR });
    const cutoff = new Date(Date.now() - 6 * HOUR);

    // The finalizer listed the session as stale, then an event arrived.
    expect((await db.listStaleAgentTracingSessions({ updatedBefore: cutoff, limit: 10 })).map((s) => s.sessionId)).toContain(sessionId);
    await db.applyAgentTracingSessionEvent(sessionId, { eventType: 'ai_call' }, seed.projectId);

    expect(await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId, updatedBefore: cutoff })).toBeNull();
    expect((await db.findAgentTracingSessionById(sessionId, seed.projectId))?.status).toBe('in_progress');
  });

  it('lets a late /end revive an abandoned session (update overwrites the status)', async () => {
    const db = getDb();
    const sessionId = `${seed.sessionId}-revive`;
    await seedIdle(sessionId, { idleMs: 10 * HOUR });
    await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId, updatedBefore: new Date(Date.now() - 6 * HOUR) });

    await db.updateAgentTracingSession(sessionId, { status: 'success', endedAt: new Date(), durationMs: 1234 }, seed.projectId);
    const session = await db.findAgentTracingSessionById(sessionId, seed.projectId);
    expect(session?.status).toBe('success');
    expect(session?.durationMs).toBe(1234);
  });

  it('keeps the thread listing in step when the abandoned session belongs to a thread', async () => {
    const db = getDb();
    const sessionId = `${seed.sessionId}-thread`;
    const threadId = `thread-${seed.sessionId}`;
    const startedAt = new Date(Date.now() - 12 * HOUR);
    await db.createAgentTracingSession({
      ...seedDoc(seed), sessionId, threadId, startedAt,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await backdateUpdatedAt(db, sessionId, new Date(Date.now() - 10 * HOUR));

    await db.abandonAgentTracingSession({ projectId: seed.projectId, sessionId, updatedBefore: new Date(Date.now() - 6 * HOUR) });

    const { threads } = await db.listAgentTracingThreads({ threadId }, seed.projectId);
    const thread = threads.find((t) => t.threadId === threadId);
    expect(thread).toBeDefined();
    // Only MongoDB materializes a thread status (SQLite derives threads from the
    // sessions on read): there the abandon must have refreshed the rollup.
    if (thread && 'latestStatus' in thread) {
      expect(thread.latestStatus).toBe('abandoned');
    }
  });
});
