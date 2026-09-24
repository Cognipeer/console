/**
 * AgentRun parity tests — Group A of the background-execution implementation
 * (docs/guide/agent-background-execution.md §13). Proves the partial unique
 * index on `conversationId` (active statuses) is enforced by the DATABASE
 * itself in both providers, not by application-level pre-checking (§12.14),
 * and that the claim/finalize CAS transitions behave identically in both.
 */

import { it, expect, beforeEach } from 'vitest';
import { AgentRunConflictError } from '@/lib/database/provider.interface';
import type { IAgentRun } from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('AgentRun — data model foundation (Group A)', (getDb) => {
  let slug: string;
  let dbName: string;
  let tenantId: string;
  const projectId = 'proj-1';
  const agentKey = 'support-bot';

  beforeEach(async () => {
    slug = `agentrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({
      companyName: 'Acme',
      slug,
      dbName,
      licenseType: 'FREE',
      ownerId: 'pending',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  function baseRecord(
    conversationId: string,
    overrides: Partial<Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>> = {},
  ): Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'> {
    return {
      mode: 'background',
      tenantId,
      tenantDbName: dbName,
      projectId,
      agentKey,
      conversationId,
      userMessage: 'hello',
      status: 'queued',
      ...overrides,
    };
  }

  it('rejects a second active (queued/running) run for the same conversationId with AgentRunConflictError', async () => {
    const db = getDb();
    const conversationId = `conv-${Math.random().toString(36).slice(2, 8)}`;

    const first = await db.createAgentRun(baseRecord(conversationId));
    expect(first._id).toBeTruthy();
    expect(first.status).toBe('queued');

    await expect(db.createAgentRun(baseRecord(conversationId))).rejects.toBeInstanceOf(
      AgentRunConflictError,
    );
  });

  it('allows a new active run once the prior one for the same conversationId is terminal', async () => {
    const db = getDb();
    const conversationId = `conv-${Math.random().toString(36).slice(2, 8)}`;

    const first = await db.createAgentRun(baseRecord(conversationId));
    const claimed = await db.claimAgentRun(String(first._id), tenantId, 'worker-1', new Date());
    expect(claimed?.status).toBe('running');

    const finalized = await db.finalizeAgentRun(String(first._id), tenantId, {
      status: 'succeeded',
      completedAt: new Date(),
    });
    expect(finalized?.status).toBe('succeeded');

    // The active-run slot for this conversation is now free.
    const second = await db.createAgentRun(baseRecord(conversationId));
    expect(second._id).toBeTruthy();
    expect(second._id).not.toBe(first._id);
  });

  it('claimAgentRun is an atomic queued -> running CAS: a second claim attempt returns null', async () => {
    const db = getDb();
    const conversationId = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const run = await db.createAgentRun(baseRecord(conversationId));

    const firstClaim = await db.claimAgentRun(String(run._id), tenantId, 'worker-1', new Date());
    expect(firstClaim?.status).toBe('running');
    expect(firstClaim?.workerId).toBe('worker-1');

    // Simulates a duplicate/redelivered queue message racing the first claim.
    const secondClaim = await db.claimAgentRun(String(run._id), tenantId, 'worker-2', new Date());
    expect(secondClaim).toBeNull();
  });

  it('finalizeAgentRun only applies while status is still running (CAS), preventing a late double-finalize', async () => {
    const db = getDb();
    const conversationId = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const run = await db.createAgentRun(baseRecord(conversationId));
    await db.claimAgentRun(String(run._id), tenantId, 'worker-1', new Date());

    const firstFinalize = await db.finalizeAgentRun(String(run._id), tenantId, {
      status: 'failed',
      errorReason: 'max_duration_exceeded',
      completedAt: new Date(),
    });
    expect(firstFinalize?.status).toBe('failed');

    // An abandoned invoke() call "finishing late" must not flip this back to
    // succeeded (§12.12/§12.13) — the CAS guard, not caller discipline, is
    // what prevents it.
    const secondFinalize = await db.finalizeAgentRun(String(run._id), tenantId, {
      status: 'succeeded',
      completedAt: new Date(),
    });
    expect(secondFinalize).toBeNull();

    const stillFailed = await db.getAgentRunById(String(run._id), tenantId, projectId);
    expect(stillFailed?.status).toBe('failed');
    expect(stillFailed?.errorReason).toBe('max_duration_exceeded');
  });

  it('getAgentRunById scopes by tenantId AND projectId (§12.11) — a different project cannot read the run', async () => {
    const db = getDb();
    const conversationId = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const run = await db.createAgentRun(baseRecord(conversationId));

    const ownProject = await db.getAgentRunById(String(run._id), tenantId, projectId);
    expect(ownProject?._id).toBe(run._id);

    const otherProject = await db.getAgentRunById(String(run._id), tenantId, 'proj-other');
    expect(otherProject).toBeNull();
  });

  it('listStaleAgentRuns finds a running row whose heartbeat is older than the cutoff', async () => {
    const db = getDb();
    const conversationId = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const run = await db.createAgentRun(baseRecord(conversationId));
    const staleHeartbeat = new Date(Date.now() - 60_000);
    await db.claimAgentRun(String(run._id), tenantId, 'worker-1', staleHeartbeat);

    const cutoff = new Date(Date.now() - 30_000);
    const stale = await db.listStaleAgentRuns(tenantId, cutoff);
    expect(stale.some((r) => String(r._id) === String(run._id))).toBe(true);

    const notYetStale = await db.listStaleAgentRuns(tenantId, new Date(Date.now() - 120_000));
    expect(notYetStale.some((r) => String(r._id) === String(run._id))).toBe(false);
  });

  it('deleteAgentRun unconditionally removes the row (sync-mode cleanup, §6)', async () => {
    const db = getDb();
    const conversationId = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const run = await db.createAgentRun(baseRecord(conversationId, { mode: 'sync', status: 'running' }));

    expect(await db.deleteAgentRun(String(run._id))).toBe(true);
    expect(await db.getAgentRunById(String(run._id), tenantId, projectId)).toBeNull();

    // The conversationId slot is free again immediately after deletion.
    const recreated = await db.createAgentRun(baseRecord(conversationId));
    expect(recreated._id).toBeTruthy();
  });

  it('countActiveAgentRuns counts only queued/running rows, scoped by tenant (+ optional project)', async () => {
    const db = getDb();
    const conv1 = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const conv2 = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const conv3 = `conv-${Math.random().toString(36).slice(2, 8)}`;

    const run1 = await db.createAgentRun(baseRecord(conv1));
    await db.createAgentRun(baseRecord(conv2));
    const run3 = await db.createAgentRun(baseRecord(conv3, { projectId: 'proj-other' }));

    await db.claimAgentRun(String(run1._id), tenantId, 'worker-1', new Date());
    await db.finalizeAgentRun(String(run1._id), tenantId, { status: 'canceled', completedAt: new Date() });
    void run3;

    expect(await db.countActiveAgentRuns(tenantId)).toBe(2);
    expect(await db.countActiveAgentRuns(tenantId, projectId)).toBe(1);
    expect(await db.countActiveAgentRuns(tenantId, 'proj-other')).toBe(1);
  });

  it('cleanupAgentRunRetention deletes only rows past their expiresAt cutoff', async () => {
    const db = getDb();
    const convExpired = `conv-${Math.random().toString(36).slice(2, 8)}`;
    const convFresh = `conv-${Math.random().toString(36).slice(2, 8)}`;

    const expired = await db.createAgentRun(
      baseRecord(convExpired, {
        status: 'succeeded',
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    const fresh = await db.createAgentRun(
      baseRecord(convFresh, {
        status: 'succeeded',
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );

    const result = await db.cleanupAgentRunRetention({ olderThan: new Date() });
    expect(result.deletedCount).toBeGreaterThanOrEqual(1);

    expect(await db.getAgentRunById(String(expired._id), tenantId, projectId)).toBeNull();
    expect(await db.getAgentRunById(String(fresh._id), tenantId, projectId)).not.toBeNull();
  });
});
