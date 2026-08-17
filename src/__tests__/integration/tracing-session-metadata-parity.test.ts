/**
 * Session-level `metadata` (the dynamic attribution bag, sibling of `agent`),
 * run against BOTH providers.
 *
 * The defect being pinned: `IAgentTracingSession.metadata` reached the type
 * and the MongoDB provider (which persists arbitrary extra document fields
 * for free) but the SQLite provider never got a matching column — every
 * session created on SQLite silently dropped `metadata` on write, so it
 * never came back on read, never appeared in the UI, and could never be
 * searched. MongoDB's implicit persistence hid the gap in manual testing.
 */

import { it, expect, beforeEach } from 'vitest';

import { describeForEachProvider } from './db-parity.helper';

type SessionSeed = {
  sessionId: string;
  projectId: string;
  tenantId: string;
};

function seedDoc(seed: SessionSeed, metadata?: Record<string, string>) {
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
    ...(metadata ? { metadata } : {}),
  };
}

describeForEachProvider('Agent tracing session metadata', (getDb) => {
  let seed: SessionSeed;

  beforeEach(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const db = getDb();
    const slug = `tracing-md-${unique}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({
      companyName: 'Tracing Metadata',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    await db.switchToTenant(dbName);
    seed = { sessionId: `sess-${unique}`, projectId: `proj-${unique}`, tenantId: String(tenant._id) };
  });

  it('round-trips metadata through create and findById', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = seedDoc(seed, { complexity: 'complex', workspace: 'ws_1' }) as any;
    await db.createAgentTracingSession(doc);

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.metadata).toEqual({ complexity: 'complex', workspace: 'ws_1' });
  });

  it('round-trips metadata through updateAgentTracingSession', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed) as any);

    await db.updateAgentTracingSession(
      seed.sessionId,
      { metadata: { workspace: 'ws_2' } },
      seed.projectId,
    );

    const session = await db.findAgentTracingSessionById(seed.sessionId, seed.projectId);
    expect(session?.metadata).toEqual({ workspace: 'ws_2' });
  });

  it('finds a session by an exact metadata key/value match', async () => {
    const db = getDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(seedDoc(seed, { workspace: 'ws_target' }) as any);
    const otherSeed: SessionSeed = { ...seed, sessionId: `${seed.sessionId}-other` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const otherDoc = seedDoc(otherSeed, { workspace: 'ws_other' }) as any;
    await db.createAgentTracingSession(otherDoc);

    const result = await db.listAgentTracingSessions(
      { metadataKey: 'workspace', metadataValue: 'ws_target' },
      seed.projectId,
    );

    expect(result.sessions.map((s) => s.sessionId)).toEqual([seed.sessionId]);
  });

  it('finds a thread by an exact metadata key/value match on its sessions', async () => {
    const db = getDb();
    const threadSeed = { ...seedDoc(seed, { workspace: 'ws_target' }), threadId: `thr-${seed.sessionId}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(threadSeed as any);
    const otherSeed: SessionSeed = { ...seed, sessionId: `${seed.sessionId}-other` };
    const otherThreadSeed = {
      ...seedDoc(otherSeed, { workspace: 'ws_other' }),
      threadId: `thr-${otherSeed.sessionId}`,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.createAgentTracingSession(otherThreadSeed as any);

    const result = await db.listAgentTracingThreads(
      { metadataKey: 'workspace', metadataValue: 'ws_target' },
      seed.projectId,
    );

    expect(result.threads.map((t) => t.threadId)).toEqual([threadSeed.threadId]);
  });
});
