/**
 * AgentRun data layer parity for continuations and callback bookkeeping: the
 * continuation's trigger and actor, the accountable principal, the callback
 * event guard, the expiry of expired and finished runs — and, on MongoDB, the
 * idempotency lock documents.
 */

import { beforeEach, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { AgentRunIdempotencyKeyTakenError } from '@/lib/database/provider.interface';
import type { IAgentRun } from '@/lib/database/provider.interface';
import { MongoDBProvider } from '@/lib/database/mongodb.provider';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('AgentRun — continuations and callback events', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';
  let seq = 0;
  const conv = () => `conv-${Date.now()}-${seq++}`;

  beforeEach(async () => {
    const slug = `agentrun-cont-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const tenant = await getDb().createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await getDb().switchToTenant(dbName);
  });

  const rec = (overrides: Partial<Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>> = {}) => ({
    mode: 'background',
    tenantId,
    tenantDbName: dbName,
    projectId,
    agentKey: 'support-bot',
    conversationId: conv(),
    userMessage: 'hello',
    status: 'queued',
    ...overrides,
  }) as Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>;
  const id = (run: IAgentRun) => String(run._id);
  const read = async (run: IAgentRun) => (await getDb().getAgentRunById(id(run), tenantId, projectId))!;
  const paused = async (overrides: Parameters<typeof rec>[0] = {}) => {
    const db = getDb();
    const run = await db.createAgentRun(rec(overrides));
    await db.claimAgentRun(id(run), tenantId, 'node-1', new Date());
    return (await db.finalizeAgentRun(id(run), tenantId, { status: 'requires_action', stopReason: 'requires_action' }))!;
  };

  it('stores the accountable principal and the callback event id', async () => {
    const run = await getDb().createAgentRun(rec({ userId: 'system:routine:r1', accountableUserId: 'user-2', accountableTokenId: 'tok-2' }));
    expect(await read(run)).toMatchObject({ userId: 'system:routine:r1', accountableUserId: 'user-2', accountableTokenId: 'tok-2' });
    const plain = await read(await getDb().createAgentRun(rec()));
    expect(plain.accountableUserId ?? null).toBeNull();
    expect(plain.callbackEventId ?? null).toBeNull();
    expect(plain.resumeTrigger ?? null).toBeNull();
  });

  it('a requeue for resume records the continuation\'s trigger and actor; one without leaves them empty', async () => {
    const db = getDb();
    const run = await paused();
    await db.requeueAgentRunForResume(id(run), tenantId, ['act_1'], { trigger: 'timeout', userId: 'system:timeout', apiTokenId: null });
    expect(await read(run)).toMatchObject({ status: 'queued', queueGeneration: 2, resumeTrigger: 'timeout', resumeUserId: 'system:timeout' });

    const other = await paused();
    await db.requeueAgentRunForResume(id(other), tenantId, ['act_2'], { trigger: 'resume', userId: 'user-1', apiTokenId: 'tok-1' });
    expect(await read(other)).toMatchObject({ resumeTrigger: 'resume', resumeUserId: 'user-1', resumeApiTokenId: 'tok-1' });

    const bare = await paused();
    await db.requeueAgentRunForResume(id(bare), tenantId, ['act_3']);
    const stored = await read(bare);
    expect(stored.resumeTrigger ?? null).toBeNull();
    expect(stored.resumeUserId ?? null).toBeNull();
  });

  it('callback bookkeeping for an event is written only while that event is the current one', async () => {
    const db = getDb();
    const run = await db.createAgentRun(rec({ callbackUrl: 'https://example.com/cb' }));
    await db.updateAgentRunCallback(id(run), tenantId, { callbackStatus: 'pending', callbackAttempts: 0, callbackEventId: 'evt_a' });
    expect(await read(run)).toMatchObject({ callbackStatus: 'pending', callbackEventId: 'evt_a' });

    expect(await db.updateAgentRunCallback(id(run), tenantId, { callbackStatus: 'failed', callbackAttempts: 1 }, { onlyIfEventId: 'evt_a' })).not.toBeNull();
    await db.updateAgentRunCallback(id(run), tenantId, { callbackStatus: 'pending', callbackAttempts: 0, callbackEventId: 'evt_b' });

    expect(await db.updateAgentRunCallback(id(run), tenantId, { callbackStatus: 'delivered', callbackAttempts: 2 }, { onlyIfEventId: 'evt_a' })).toBeNull();
    expect(await read(run)).toMatchObject({ callbackStatus: 'pending', callbackAttempts: 0, callbackEventId: 'evt_b' });

    // A row from before event ids were stored takes the write.
    const legacy = await db.createAgentRun(rec({ callbackUrl: 'https://example.com/cb' }));
    expect(await db.updateAgentRunCallback(id(legacy), tenantId, { callbackStatus: 'delivered', callbackAttempts: 1 }, { onlyIfEventId: 'evt_x' })).not.toBeNull();
  });

  it('an expired run takes the expiry it is given', async () => {
    const db = getDb();
    const run = await db.createAgentRun(rec({ expiresAt: new Date(Date.now() + 1_000) }));
    const until = new Date(Date.now() + 7 * 86_400_000);
    const expired = (await db.expireWaitingAgentRun(id(run), tenantId, 'waited too long', until))!;
    expect(expired).toMatchObject({ status: 'failed', errorReason: 'expired' });
    expect(new Date((await read(run)).expiresAt!).getTime()).toBe(until.getTime());
  });

  it('MongoDB: an idempotency lock left without a run is reclaimed after the grace period, one bound to a run is not', async () => {
    const db = getDb();
    if (!(db instanceof MongoDBProvider)) return;
    const tenantDb = (db as unknown as { getTenantDb(): Db }).getTenantDb();
    const locks = tenantDb.collection<{ _id: string; runId: string | null; kind: string; createdAt: Date; expiresAt: Date | null }>('agent_run_locks');
    const lockId = (key: string) => `idem:${tenantId}:${projectId}:${key}`;

    await locks.insertOne({ _id: lockId('orphan'), runId: null, kind: 'idempotency', createdAt: new Date(Date.now() - 120_000), expiresAt: null });
    const created = await db.createAgentRun(rec({ idempotencyKey: 'orphan' }));
    expect((await locks.findOne({ _id: lockId('orphan') }))?.runId).toBe(id(created));

    await locks.insertOne({ _id: lockId('fresh'), runId: null, kind: 'idempotency', createdAt: new Date(), expiresAt: null });
    await expect(db.createAgentRun(rec({ idempotencyKey: 'fresh' }))).rejects.toBeInstanceOf(AgentRunIdempotencyKeyTakenError);

    await locks.updateOne({ _id: lockId('orphan') }, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    await expect(db.createAgentRun(rec({ idempotencyKey: 'orphan' }))).rejects.toBeInstanceOf(AgentRunIdempotencyKeyTakenError);
  });

  it('MongoDB: the idempotency lock expires with its run when a finish moves the run\'s expiry', async () => {
    const db = getDb();
    if (!(db instanceof MongoDBProvider)) return;
    const tenantDb = (db as unknown as { getTenantDb(): Db }).getTenantDb();
    const locks = tenantDb.collection<{ _id: string; expiresAt: Date | null }>('agent_run_locks');
    const run = await db.createAgentRun(rec({ idempotencyKey: 'k-finish', expiresAt: new Date(Date.now() + 1_000) }));
    await db.claimAgentRun(id(run), tenantId, 'node-1', new Date());
    const until = new Date(Date.now() + 7 * 86_400_000);
    await db.finalizeAgentRun(id(run), tenantId, { status: 'succeeded', completedAt: new Date(), expiresAt: until });
    expect((await locks.findOne({ _id: `idem:${tenantId}:${projectId}:k-finish` }))?.expiresAt?.getTime()).toBe(until.getTime());
  });
});
