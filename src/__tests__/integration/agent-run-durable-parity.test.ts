/**
 * Durable runs, data layer parity: requeueing a running run for recovery
 * (handoff vs orphan guards, generation and recovery bookkeeping) and the
 * run checkpoint store (reset, append, fencing by generation, delete).
 */

import { beforeEach, expect, it } from 'vitest';
import type { AgentRunCheckpointWrite, IAgentRun } from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('AgentRun — durable runs', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';
  let seq = 0;
  const conv = () => `conv-${Date.now()}-${seq++}`;

  beforeEach(async () => {
    const slug = `agentrun-durable-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const tenant = await getDb().createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await getDb().switchToTenant(dbName);
  });

  const id = (run: IAgentRun) => String(run._id);
  const deadlineAt = new Date('2030-01-01T00:00:00.000Z');
  const handoff = { reason: 'handoff' as const, deadlineAt };
  const orphaned = { reason: 'orphaned' as const, deadlineAt };
  const read = async (run: IAgentRun) => (await getDb().getAgentRunById(id(run), tenantId, projectId))!;
  const running = async (workerId = 'node-a', startedAt = new Date(), options?: { durable?: boolean }) => {
    const db = getDb();
    const run = await db.createAgentRun({
      mode: 'background',
      tenantId,
      tenantDbName: dbName,
      projectId,
      agentKey: 'support-bot',
      conversationId: conv(),
      userMessage: 'hello',
      status: 'queued',
      queueGeneration: 1,
    } as Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>);
    return (await db.claimAgentRun(id(run), tenantId, workerId, startedAt, options))!;
  };

  it('a claim records whether its execution checkpoints the turn, and the next claim says it again', async () => {
    const db = getDb();
    expect((await running('node-a')).durable ?? false).toBe(false);
    const run = await running('node-a', new Date(), { durable: true });
    expect(run.durable).toBe(true);
    expect((await read(run)).durable).toBe(true);
    // Continued by a node without durable runs: that execution does not checkpoint.
    await db.requeueAgentRunForRecovery(id(run), tenantId, { fromWorkerId: 'node-a' }, handoff);
    expect((await db.claimAgentRun(id(run), tenantId, 'node-b', new Date()))?.durable).toBe(false);
  });

  it('a handoff requeues only the run its worker still holds, and bumps the generation but not the orphan count', async () => {
    const db = getDb();
    const run = await running('node-a');
    expect(await db.requeueAgentRunForRecovery(id(run), tenantId, { fromWorkerId: 'node-b' }, handoff)).toBeNull();

    const requeued = await db.requeueAgentRunForRecovery(id(run), tenantId, { fromWorkerId: 'node-a' }, handoff);
    expect(requeued).toMatchObject({ status: 'queued', queueGeneration: 2, lastRecoveryReason: 'handoff' });
    expect(requeued!.workerId ?? null).toBeNull();
    expect(requeued!.recoveryCount ?? 0).toBe(0);
    expect(requeued!.lastRecoveredAt).toBeInstanceOf(Date);
    expect(new Date(requeued!.recoveryDeadlineAt!).toISOString()).toBe(deadlineAt.toISOString());

    // Not running any more: a second requeue does nothing, and the old worker's heartbeat is refused.
    expect(await db.requeueAgentRunForRecovery(id(run), tenantId, { fromWorkerId: 'node-a' }, handoff)).toBeNull();
    expect(await db.updateAgentRunHeartbeat(id(run), 'node-a', new Date())).toBeNull();

    // The next claim takes it like any queued run.
    expect(await db.claimAgentRun(id(run), tenantId, 'node-c', new Date())).toMatchObject({ status: 'running', workerId: 'node-c' });
  });

  it('an orphan requeue needs a stale heartbeat and counts toward the recovery limit', async () => {
    const db = getDb();
    const run = await running('node-a', new Date(Date.now() - 120_000));
    expect(await db.requeueAgentRunForRecovery(id(run), tenantId, { staleBefore: new Date(Date.now() - 300_000) }, orphaned)).toBeNull();

    const requeued = await db.requeueAgentRunForRecovery(id(run), tenantId, { staleBefore: new Date(Date.now() - 60_000) }, orphaned);
    expect(requeued).toMatchObject({ status: 'queued', queueGeneration: 2, recoveryCount: 1, lastRecoveryReason: 'orphaned' });
    expect((await read(run)).recoveryCount).toBe(1);
  });

  it('a resume after a recovered turn paused is a new turn, not a recovery', async () => {
    const db = getDb();
    const run = await running('node-a');
    await db.requeueAgentRunForRecovery(id(run), tenantId, { fromWorkerId: 'node-a' }, handoff);
    await db.claimAgentRun(id(run), tenantId, 'node-b', new Date());
    await db.finalizeAgentRun(id(run), tenantId, { status: 'requires_action', stopReason: 'requires_action' });

    const resumed = await db.requeueAgentRunForResume(id(run), tenantId, ['act-1']);
    expect(resumed).toMatchObject({ status: 'queued', lastRecoveredAt: null, lastRecoveryReason: null, recoveryDeadlineAt: null });
  });

  const write = (runId: string, overrides: Partial<AgentRunCheckpointWrite> = {}): AgentRunCheckpointWrite => ({
    runId,
    tenantId,
    conversationId: 'conv-1',
    generation: 1,
    schema: 1,
    mode: 'reset',
    head: 'h1',
    messageChunks: ['m1'],
    toolHistoryChunks: ['t1'],
    messageCount: 2,
    toolHistoryCount: 1,
    sizeBytes: 6,
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  });

  it('a checkpoint is written in full, appended to, and read back in order', async () => {
    const db = getDb();
    const runId = 'run-ckpt-1';
    expect(await db.writeAgentRunCheckpoint(write(runId))).toBe(true);
    // An append without a head keeps the stored one.
    expect(await db.writeAgentRunCheckpoint(write(runId, {
      mode: 'append', head: undefined, messageChunks: ['m2'], toolHistoryChunks: [], messageCount: 3, sizeBytes: 8,
    }))).toBe(true);
    expect(await db.writeAgentRunCheckpoint(write(runId, {
      mode: 'append', head: 'h2', messageChunks: ['m3'], toolHistoryChunks: ['t2'], messageCount: 4, toolHistoryCount: 2, sizeBytes: 12,
    }))).toBe(true);

    const stored = await db.findAgentRunCheckpoint(runId, tenantId);
    expect(stored).toMatchObject({
      runId, generation: 1, schema: 1, head: 'h2',
      messageChunks: ['m1', 'm2', 'm3'], toolHistoryChunks: ['t1', 't2'],
      messageCount: 4, toolHistoryCount: 2, sizeBytes: 12,
    });
    expect(stored!.sealed ?? null).toBeNull();

    // A reset replaces everything.
    expect(await db.writeAgentRunCheckpoint(write(runId, { head: 'h3', messageChunks: ['all'], toolHistoryChunks: [] }))).toBe(true);
    expect(await db.findAgentRunCheckpoint(runId, tenantId)).toMatchObject({ head: 'h3', messageChunks: ['all'], toolHistoryChunks: [] });
  });

  it('a write from an older execution is refused once a newer one has written', async () => {
    const db = getDb();
    const runId = 'run-ckpt-2';
    expect(await db.writeAgentRunCheckpoint(write(runId, { generation: 1 }))).toBe(true);
    expect(await db.writeAgentRunCheckpoint(write(runId, { generation: 2, head: 'new' }))).toBe(true);

    expect(await db.writeAgentRunCheckpoint(write(runId, { generation: 1, head: 'stale' }))).toBe(false);
    expect(await db.writeAgentRunCheckpoint(write(runId, { generation: 1, mode: 'append', messageChunks: ['x'] }))).toBe(false);
    expect(await db.findAgentRunCheckpoint(runId, tenantId)).toMatchObject({ generation: 2, head: 'new', messageChunks: ['m1'] });

    // Nothing to append to.
    expect(await db.writeAgentRunCheckpoint(write('run-none', { mode: 'append' }))).toBe(false);
  });

  it('a sealed checkpoint says so, and a deleted one is gone', async () => {
    const db = getDb();
    const runId = 'run-ckpt-3';
    await db.writeAgentRunCheckpoint(write(runId, { sealed: 'too_large', messageChunks: [], toolHistoryChunks: [] }));
    expect(await db.findAgentRunCheckpoint(runId, tenantId)).toMatchObject({ sealed: 'too_large' });
    await db.deleteAgentRunCheckpoint(runId, tenantId);
    expect(await db.findAgentRunCheckpoint(runId, tenantId)).toBeNull();
    // Another tenant does not see it.
    await db.writeAgentRunCheckpoint(write(runId));
    expect(await db.findAgentRunCheckpoint(runId, 'other-tenant')).toBeNull();
  });
});
