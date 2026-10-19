/**
 * AgentRun run-engine data layer parity: new fields, scheduled rows, run
 * classes, listing filters / cursor, queue-visibility counts, detach /
 * publish bookkeeping and the retention guard behave identically on SQLite
 * and MongoDB.
 */

import { it, expect, beforeEach, describe } from 'vitest';
import { AgentRunConflictError } from '@/lib/database/provider.interface';
import type { IAgentRun } from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('AgentRun — run engine data layer', (getDb) => {
  let tenantId: string;
  let dbName: string;
  const projectId = 'proj-1';
  let seq = 0;
  const conv = () => `conv-${Date.now()}-${seq++}`;

  beforeEach(async () => {
    const slug = `agentrun-engine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  function rec(overrides: Partial<Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>> = {}) {
    return {
      mode: 'background',
      tenantId,
      tenantDbName: dbName,
      projectId,
      agentKey: 'support-bot',
      conversationId: conv(),
      userMessage: 'hello',
      status: 'queued',
      ...overrides,
    } as Omit<IAgentRun, '_id' | 'createdAt' | 'updatedAt'>;
  }
  const id = (run: IAgentRun) => String(run._id);

  it('persists and reads back every new field; queueGeneration defaults to 1; old-style rows read as absent', async () => {
    const db = getDb();
    const notBefore = new Date(Date.now() + 60_000);
    const created = await db.createAgentRun(rec({
      status: 'scheduled',
      runClass: 'deferred',
      notBefore,
      metadata: { team: 'ops', 'a.b-c': 'x' },
      channel: 'trigger',
      triggerId: 'trigger-1',
      trigger: 'schedule',
      responseFormat: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true },
      variables: { city: 'Paris', n: 2 },
    }));
    const read = (await db.getAgentRunById(id(created), tenantId, projectId))!;
    expect(read.runClass).toBe('deferred');
    expect(new Date(read.notBefore!).getTime()).toBe(notBefore.getTime());
    expect(read.metadata).toEqual({ team: 'ops', 'a.b-c': 'x' });
    expect(read.channel).toBe('trigger');
    expect(read.triggerId).toBe('trigger-1');
    expect(read.trigger).toBe('schedule');
    expect(read.responseFormat).toEqual({ type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true });
    expect(read.variables).toEqual({ city: 'Paris', n: 2 });
    expect(read.queueGeneration).toBe(1);
    expect(read.detachedAt ?? null).toBeNull();
    expect(read.lastPublishedAt ?? null).toBeNull();

    // The request's `background: true` on a run that streams inline.
    const asked = await db.createAgentRun(rec({ mode: 'inline', status: 'running', conversationId: 'conv-bg', background: true }));
    expect((await db.getAgentRunById(id(asked), tenantId, projectId))!.background).toBe(true);

    const plain = (await db.getAgentRunById(id(await db.createAgentRun(rec())), tenantId, projectId))!;
    expect(plain.runClass ?? null).toBeNull();
    expect(plain.metadata ?? null).toBeNull();
    expect(plain.responseFormat ?? null).toBeNull();
    expect(plain.variables ?? null).toBeNull();
    expect(plain.channel ?? null).toBeNull();
    expect(plain.background ?? false).toBe(false);
  });

  it('a scheduled row takes no conversation slot; an inline row holds it like an active row', async () => {
    const db = getDb();
    const c = conv();
    const scheduled = await db.createAgentRun(rec({ conversationId: c, status: 'scheduled', notBefore: new Date(Date.now() + 1000) }));
    // The slot is free: an active run and a second scheduled run both fit.
    const inline = await db.createAgentRun(rec({ conversationId: c, mode: 'inline', status: 'running' }));
    await db.createAgentRun(rec({ conversationId: c, status: 'scheduled', notBefore: new Date(Date.now() + 1000) }));
    await expect(db.createAgentRun(rec({ conversationId: c }))).rejects.toBeInstanceOf(AgentRunConflictError);
    expect(id(scheduled)).not.toBe(id(inline));
    expect(await db.countActiveAgentRuns(tenantId, projectId, { mode: 'inline' })).toBe(1);
  });

  it('countActiveAgentRuns filters by runClass (default matches rows without a class) and mode', async () => {
    const db = getDb();
    await db.createAgentRun(rec());
    await db.createAgentRun(rec({ runClass: 'default' }));
    await db.createAgentRun(rec({ runClass: 'deferred' }));
    await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date() }));
    await db.createAgentRun(rec({ mode: 'inline', status: 'running' }));
    expect(await db.countActiveAgentRuns(tenantId)).toBe(4);
    expect(await db.countActiveAgentRuns(tenantId, undefined, { runClass: 'default' })).toBe(3);
    expect(await db.countActiveAgentRuns(tenantId, undefined, { runClass: 'deferred' })).toBe(1);
    expect(await db.countActiveAgentRuns(tenantId, undefined, { mode: 'inline', runClass: 'default' })).toBe(1);
    expect(await db.countActiveAgentRuns(tenantId, 'proj-other', { runClass: 'default' })).toBe(0);
  });

  it('countAgentRunsByStatus returns every requested status, scoped by class and project', async () => {
    const db = getDb();
    await db.createAgentRun(rec({ runClass: 'deferred' }));
    await db.createAgentRun(rec({ runClass: 'deferred' }));
    await db.createAgentRun(rec({ runClass: 'deferred', status: 'scheduled', notBefore: new Date() }));
    await db.createAgentRun(rec());
    await db.createAgentRun(rec({ runClass: 'deferred', projectId: 'proj-other' }));
    const counts = await db.countAgentRunsByStatus(tenantId, { runClass: 'deferred', statuses: ['queued', 'scheduled', 'running'] });
    expect(counts).toEqual({ queued: 3, scheduled: 1, running: 0 });
    const scoped = await db.countAgentRunsByStatus(tenantId, { runClass: 'deferred', statuses: ['queued'], projectId });
    expect(scoped).toEqual({ queued: 2 });
    const defaults = await db.countAgentRunsByStatus(tenantId, { runClass: 'default', statuses: ['queued'] });
    expect(defaults).toEqual({ queued: 1 });
  });

  it('countAgentRunsByStatus narrows by channel and creation time (the reminder quotas)', async () => {
    const db = getDb();
    const before = new Date(Date.now() - 1000);
    await db.createAgentRun(rec({ channel: 'reminder', status: 'scheduled', notBefore: new Date(Date.now() + 60_000) }));
    await db.createAgentRun(rec({ channel: 'reminder', status: 'succeeded' }));
    await db.createAgentRun(rec({ channel: 'runs', status: 'scheduled', notBefore: new Date(Date.now() + 60_000) }));
    expect(await db.countAgentRunsByStatus(tenantId, { statuses: ['scheduled', 'succeeded'], channel: 'reminder' })).toEqual({ scheduled: 1, succeeded: 1 });
    expect(await db.countAgentRunsByStatus(tenantId, { statuses: ['scheduled'], channel: 'reminder', createdAfter: before })).toEqual({ scheduled: 1 });
    expect(await db.countAgentRunsByStatus(tenantId, { statuses: ['scheduled'], channel: 'reminder', createdAfter: new Date(Date.now() + 60_000) })).toEqual({ scheduled: 0 });
  });

  describe('listAgentRuns', () => {
    it('filters by mode (single / array / excluded), class, channel, trigger, metadata pairs and created window', async () => {
      const db = getDb();
      const a = await db.createAgentRun(rec({ mode: 'inline', status: 'succeeded', channel: 'responses', metadata: { team: 'a', 'k.dot': '1' } }));
      const b = await db.createAgentRun(rec({ mode: 'background', status: 'succeeded', runClass: 'deferred', channel: 'runs', metadata: { team: 'b' } }));
      const c = await db.createAgentRun(rec({ mode: 'sync', status: 'running', triggerId: 'r-1', channel: 'trigger' }));
      const ids = async (f: Record<string, unknown>) =>
        (await db.listAgentRuns({ tenantId, projectId, ...f } as never)).map(id).sort();
      expect(await ids({ mode: 'inline' })).toEqual([id(a)]);
      expect(await ids({ mode: ['inline', 'background'] })).toEqual([id(a), id(b)].sort());
      expect(await ids({ excludeModes: ['sync'] })).toEqual([id(a), id(b)].sort());
      expect(await ids({ runClass: 'deferred' })).toEqual([id(b)]);
      expect(await ids({ runClass: 'default' })).toEqual([id(a), id(c)].sort());
      expect(await ids({ channel: 'trigger' })).toEqual([id(c)]);
      expect(await ids({ triggerId: 'r-1' })).toEqual([id(c)]);
      expect(await ids({ metadata: { team: 'a' } })).toEqual([id(a)]);
      expect(await ids({ metadata: { team: 'a', 'k.dot': '1' } })).toEqual([id(a)]);
      expect(await ids({ metadata: { 'k.dot': '1' } })).toEqual([id(a)]);
      expect(await ids({ metadata: { team: 'a', 'k.dot': '2' } })).toEqual([]);
      expect(await ids({ metadata: { team: 'zzz' } })).toEqual([]);
      expect(await ids({ createdAfter: new Date(Date.now() - 60_000), createdBefore: new Date(Date.now() + 60_000) })).toHaveLength(3);
      expect(await ids({ createdAfter: new Date(Date.now() + 60_000) })).toEqual([]);
      expect(await ids({ createdBefore: new Date(Date.now() - 60_000) })).toEqual([]);
    });

    it('pages newest first with a stable cursor even when rows share a timestamp', async () => {
      const db = getDb();
      const created: string[] = [];
      for (let i = 0; i < 7; i += 1) created.push(id(await db.createAgentRun(rec({ status: 'succeeded' }))));
      const newestFirst = [...created].reverse();
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const rows = await db.listAgentRuns({ tenantId, projectId, limit: 3, cursor });
        if (rows.length === 0) break;
        seen.push(...rows.map(id));
        cursor = id(rows[rows.length - 1]);
      }
      expect(seen).toEqual(newestFirst);
      // An unknown cursor ends the listing instead of restarting it.
      expect(await db.listAgentRuns({ tenantId, projectId, cursor: 'does-not-exist', limit: 3 })).toEqual([]);
    });

    it('never leaks across projects through the cursor', async () => {
      const db = getDb();
      const other = await db.createAgentRun(rec({ projectId: 'proj-other', status: 'succeeded' }));
      await db.createAgentRun(rec({ status: 'succeeded' }));
      expect(await db.listAgentRuns({ tenantId, projectId, cursor: id(other) })).toEqual([]);
    });
  });

  describe('scheduled promotion', () => {
    it('listDueScheduledAgentRuns returns only due scheduled rows, oldest due first, bounded', async () => {
      const db = getDb();
      const now = new Date();
      const due2 = await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(now.getTime() - 1000) }));
      const due1 = await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(now.getTime() - 5000) }));
      await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(now.getTime() + 60_000) }));
      await db.createAgentRun(rec());
      expect((await db.listDueScheduledAgentRuns(tenantId, now, 10)).map(id)).toEqual([id(due1), id(due2)]);
      expect(await db.listDueScheduledAgentRuns(tenantId, now, 1)).toHaveLength(1);
    });

    it('promote is a scheduled -> queued CAS that takes the conversation slot', async () => {
      const db = getDb();
      const c = conv();
      const run = await db.createAgentRun(rec({ conversationId: c, status: 'scheduled', notBefore: new Date(Date.now() - 1000) }));
      const promoted = await db.promoteScheduledAgentRun(id(run), tenantId);
      expect(promoted?.status).toBe('queued');
      // Lost CAS: nothing left to promote.
      expect(await db.promoteScheduledAgentRun(id(run), tenantId)).toBeNull();
      // The slot is held now.
      await expect(db.createAgentRun(rec({ conversationId: c }))).rejects.toBeInstanceOf(AgentRunConflictError);
      // And released when the run settles.
      await db.claimAgentRun(id(run), tenantId, 'w1', new Date());
      await db.finalizeAgentRun(id(run), tenantId, { status: 'succeeded', completedAt: new Date() });
      await expect(db.createAgentRun(rec({ conversationId: c }))).resolves.toBeTruthy();
    });

    it('promote can move the start time to now, so the deferred dispatcher takes it at once', async () => {
      const db = getDb();
      const later = new Date(Date.now() + 10 * 60_000);
      const run = await db.createAgentRun(rec({ conversationId: conv(), status: 'scheduled', runClass: 'deferred', notBefore: later }));
      const now = new Date();
      const promoted = await db.promoteScheduledAgentRun(id(run), tenantId, { notBefore: now });
      expect(promoted?.status).toBe('queued');
      expect(new Date(promoted!.notBefore!).getTime()).toBe(now.getTime());
      expect((await db.listQueuedDeferredAgentRuns(tenantId, { limit: 10, dueBefore: new Date(now.getTime() + 1) })).map(id)).toContain(id(run));
    });

    it('promote throws AgentRunConflictError while another run holds the conversation, and the row stays scheduled', async () => {
      const db = getDb();
      const c = conv();
      const scheduled = await db.createAgentRun(rec({ conversationId: c, status: 'scheduled', notBefore: new Date(Date.now() - 1000) }));
      const holder = await db.createAgentRun(rec({ conversationId: c }));
      await expect(db.promoteScheduledAgentRun(id(scheduled), tenantId)).rejects.toBeInstanceOf(AgentRunConflictError);
      expect((await db.getAgentRunById(id(scheduled), tenantId, projectId))?.status).toBe('scheduled');
      // The holder's slot is untouched by the failed attempt; once it ends, promotion works.
      await db.requestAgentRunCancel(id(holder), tenantId, projectId);
      expect((await db.promoteScheduledAgentRun(id(scheduled), tenantId))?.status).toBe('queued');
    });

    it('promote ignores a run of another tenant id and a run that is not scheduled', async () => {
      const db = getDb();
      const queued = await db.createAgentRun(rec());
      expect(await db.promoteScheduledAgentRun(id(queued), tenantId)).toBeNull();
      const scheduled = await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date() }));
      expect(await db.promoteScheduledAgentRun(id(scheduled), 'other-tenant')).toBeNull();
    });

    it('cancel settles a scheduled row immediately', async () => {
      const db = getDb();
      const run = await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(Date.now() + 60_000) }));
      const canceled = await db.requestAgentRunCancel(id(run), tenantId, projectId);
      expect(canceled?.status).toBe('canceled');
      expect(canceled?.errorReason).toBe('canceled_by_caller');
      expect(await db.promoteScheduledAgentRun(id(run), tenantId)).toBeNull();
    });
  });

  describe('deferred class queue', () => {
    it('listQueuedDeferredAgentRuns returns due queued deferred rows oldest first', async () => {
      const db = getDb();
      const now = new Date();
      const first = await db.createAgentRun(rec({ runClass: 'deferred' }));
      await db.createAgentRun(rec({ runClass: 'deferred', notBefore: new Date(now.getTime() + 60_000) }));
      const second = await db.createAgentRun(rec({ runClass: 'deferred', notBefore: new Date(now.getTime() - 1000) }));
      await db.createAgentRun(rec());
      await db.createAgentRun(rec({ runClass: 'deferred', status: 'scheduled', notBefore: new Date(now.getTime() - 1000) }));
      expect((await db.listQueuedDeferredAgentRuns(tenantId, { limit: 10, dueBefore: now })).map(id)).toEqual([id(first), id(second)]);
      expect(await db.listQueuedDeferredAgentRuns(tenantId, { limit: 1, dueBefore: now })).toHaveLength(1);
    });

    it('the requeue sweep excludes deferred rows (and scheduled ones)', async () => {
      const db = getDb();
      const normal = await db.createAgentRun(rec());
      await db.createAgentRun(rec({ runClass: 'deferred' }));
      await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(0) }));
      const swept = await db.listQueuedAgentRuns(tenantId, { createdBefore: new Date(Date.now() + 1000) });
      expect(swept.map(id)).toEqual([id(normal)]);
    });

    it('listExpiredWaitingAgentRuns finds deferred queued and overdue scheduled rows past the due cutoff', async () => {
      const db = getDb();
      const old = new Date(Date.now() - 3 * 86_400_000);
      const cutoff = new Date(Date.now() - 86_400_000);
      // Deferred queued: due = createdAt (just now) -> not expired; with an old notBefore -> expired.
      const queuedOld = await db.createAgentRun(rec({ runClass: 'deferred', notBefore: old }));
      await db.createAgentRun(rec({ runClass: 'deferred' }));
      const scheduledOld = await db.createAgentRun(rec({ status: 'scheduled', notBefore: old }));
      await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(Date.now() + 60_000) }));
      // A default-class queued row is the requeue sweep's, never expired here.
      await db.createAgentRun(rec({ notBefore: old }));
      const expired = await db.listExpiredWaitingAgentRuns(tenantId, { dueBefore: cutoff, limit: 10 });
      expect(expired.map(id).sort()).toEqual([id(queuedOld), id(scheduledOld)].sort());
      expect(await db.listExpiredWaitingAgentRuns(tenantId, { dueBefore: cutoff, limit: 1 })).toHaveLength(1);
      // Created long ago without a notBefore counts from createdAt.
      expect(await db.listExpiredWaitingAgentRuns(tenantId, { dueBefore: new Date(Date.now() + 30_000), limit: 10 })).toHaveLength(3);
    });

    it('expireWaitingAgentRun fails a queued / scheduled row as expired, frees the slot, and leaves other states alone', async () => {
      const db = getDb();
      const conversationId = conv();
      const queued = await db.createAgentRun(rec({ runClass: 'deferred', conversationId }));
      const expired = await db.expireWaitingAgentRun(id(queued), tenantId, 'too late');
      expect(expired).toMatchObject({ status: 'failed', errorReason: 'expired', errorMessage: 'too late' });
      expect(expired!.completedAt).toBeTruthy();
      // The slot is free again.
      await expect(db.createAgentRun(rec({ conversationId }))).resolves.toBeTruthy();

      const scheduled = await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(0) }));
      expect((await db.expireWaitingAgentRun(id(scheduled), tenantId, 'x'))?.status).toBe('failed');
      const running = await db.createAgentRun(rec({ status: 'running' }));
      expect(await db.expireWaitingAgentRun(id(running), tenantId, 'x')).toBeNull();
      expect(await db.expireWaitingAgentRun(id(queued), tenantId, 'x')).toBeNull();
    });
  });

  it('markAgentRunDetached is a CAS on running; markAgentRunPublished stamps lastPublishedAt', async () => {
    const db = getDb();
    const run = await db.createAgentRun(rec({ mode: 'inline', status: 'running' }));
    const at = new Date();
    const detached = await db.markAgentRunDetached(id(run), tenantId, at);
    expect(new Date(detached!.detachedAt!).getTime()).toBe(at.getTime());
    const queued = await db.createAgentRun(rec());
    expect(await db.markAgentRunDetached(id(queued), tenantId, at)).toBeNull();
    expect(await db.markAgentRunDetached(id(run), 'other-tenant', at)).toBeNull();

    const publishedAt = new Date();
    const published = await db.markAgentRunPublished(id(queued), tenantId, publishedAt);
    expect(new Date(published!.lastPublishedAt!).getTime()).toBe(publishedAt.getTime());
    expect(published?.status).toBe('queued');
  });

  it('requeueAgentRunForResume increments queueGeneration and keeps the run class and labels', async () => {
    const db = getDb();
    const run = await db.createAgentRun(rec({ runClass: 'deferred', metadata: { k: 'v' }, variables: { a: 1 } }));
    await db.claimAgentRun(id(run), tenantId, 'w1', new Date());
    await db.finalizeAgentRun(id(run), tenantId, { status: 'requires_action', stopReason: 'approval_required' } as never);
    const resumed = (await db.requeueAgentRunForResume(id(run), tenantId, ['act-1']))!;
    expect(resumed.status).toBe('queued');
    expect(resumed.queueGeneration).toBe(2);
    expect(resumed.runClass).toBe('deferred');
    expect(resumed.metadata).toEqual({ k: 'v' });
    expect(resumed.variables).toEqual({ a: 1 });
    // The resumed wait counts from now, not from the original creation.
    expect(resumed.notBefore).toBeTruthy();
  });

  it('listStaleAgentRuns includes inline running rows', async () => {
    const db = getDb();
    const run = await db.createAgentRun(rec({ mode: 'inline', status: 'running', heartbeatAt: new Date(Date.now() - 120_000) }));
    const stale = await db.listStaleAgentRuns(tenantId, new Date(Date.now() - 30_000));
    expect(stale.map(id)).toContain(id(run));
  });

  it('cleanupAgentRunRetention never deletes queued, running, scheduled or requires_action rows', async () => {
    const db = getDb();
    const past = new Date(Date.now() - 1000);
    const keep: IAgentRun[] = [];
    keep.push(await db.createAgentRun(rec({ expiresAt: past })));
    keep.push(await db.createAgentRun(rec({ status: 'running', expiresAt: past })));
    keep.push(await db.createAgentRun(rec({ status: 'scheduled', notBefore: new Date(), expiresAt: past })));
    keep.push(await db.createAgentRun(rec({ status: 'requires_action', expiresAt: past })));
    const done = await db.createAgentRun(rec({ status: 'succeeded', expiresAt: past }));
    const { deletedCount } = await db.cleanupAgentRunRetention({ olderThan: new Date() });
    expect(deletedCount).toBe(1);
    expect(await db.getAgentRunById(id(done), tenantId, projectId)).toBeNull();
    for (const run of keep) expect(await db.getAgentRunById(id(run), tenantId, projectId)).not.toBeNull();
  });
});
