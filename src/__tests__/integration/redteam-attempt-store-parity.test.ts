/**
 * Red-team run storage behaves the same on both providers (SQLite, and MongoDB
 * through mongodb-memory-server): one row per attempt keyed by (runId,
 * attemptKey), the compare-and-set run update the worker lifecycle is built
 * on, the reaper's stale-run query, list/count filters, and by-id lookups that
 * treat a malformed id as "not found".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { IRedTeamReview, IRedTeamRun, IRedTeamRunAttempt, RedTeamRunStatus } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const NOT_AN_ID = 'not-an-id';
const ABSENT_ID = '0123456789abcdef01234567';

type AttemptInput = Omit<IRedTeamRunAttempt, '_id' | 'createdAt' | 'updatedAt'>;

describeForEachProvider('Red-team attempt rows and run lifecycle storage', (getDb) => {
  let tenantId: string;

  beforeEach(async () => {
    const slug = `rtstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Store Co', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const createRun = async (over: Partial<Omit<IRedTeamRun, '_id' | 'createdAt' | 'updatedAt'>> = {}) => {
    const run = await getDb().createRedTeamRun({
      tenantId,
      projectId: 'p1',
      campaignKey: 'nightly',
      targetKind: 'model',
      targetRef: 'gpt',
      status: 'pending',
      mode: 'async',
      progress: { total: 0, completed: 0, failed: 0 },
      attempts: [],
      createdBy: 'tester',
      ...over,
    });
    return { ...run, id: String(run._id) };
  };

  const attemptRow = (runId: string, probeKey: string, attemptId: string, seq: number, over: Partial<AttemptInput> = {}): AttemptInput => ({
    tenantId,
    projectId: 'p1',
    runId,
    attemptKey: `${probeKey}::${attemptId}`,
    seq,
    probeKey,
    attemptId,
    family: 'jailbreak',
    category: 'LLM01-prompt-injection',
    severity: 'high',
    outcome: 'safe',
    decidedBy: 'refusal',
    confidence: 0.9,
    transcript: [{ user: 'hi', assistant: 'no' }],
    signals: [{ detectorKey: 'refusal', kind: 'refusal', hit: false, score: 0, confidence: 0.9, rationale: 'declined' }],
    ...over,
  });

  const REVIEW: IRedTeamReview = {
    outcome: 'vulnerable',
    note: 'it leaked',
    reviewedBy: 'ann',
    reviewedAt: new Date('2026-01-02T03:04:05.000Z'),
  };

  describe('attempt rows', () => {
    it('upserts idempotently: the same attempt twice is one row', async () => {
      const db = getDb();
      const run = await createRun();
      const rows = [attemptRow(run.id, 'jb', 'a1', 0), attemptRow(run.id, 'jb', 'a2', 1)];

      await db.upsertRedTeamRunAttempts(rows);
      await db.upsertRedTeamRunAttempts(rows);

      expect(await db.countRedTeamRunAttempts(run.id)).toBe(2);
      expect((await db.listRedTeamRunAttempts(run.id)).map((r) => r.attemptKey)).toEqual(['jb::a1', 'jb::a2']);
    });

    it('an empty batch is a no-op', async () => {
      const run = await createRun();
      await getDb().upsertRedTeamRunAttempts([]);
      expect(await getDb().countRedTeamRunAttempts(run.id)).toBe(0);
    });

    it('stores a review carried by a new row, and never replaces one that exists', async () => {
      const db = getDb();
      const run = await createRun();
      const legacy: IRedTeamReview = { outcome: 'safe', reviewedBy: 'legacy', reviewedAt: new Date('2025-01-01T00:00:00.000Z') };

      await db.upsertRedTeamRunAttempts([
        attemptRow(run.id, 'jb', 'a1', 0, { review: legacy }),
        attemptRow(run.id, 'jb', 'a2', 1, { review: legacy }),
      ]);
      expect((await db.findRedTeamRunAttempt(run.id, 'jb::a1'))?.review).toEqual(legacy);

      // A review given after the row exists wins over a stale one carried by a later upsert.
      expect(await db.setRedTeamRunAttemptReview(run.id, 'jb::a2', REVIEW)).toBe(true);
      await db.upsertRedTeamRunAttempts([
        attemptRow(run.id, 'jb', 'a1', 0, { review: { ...legacy, reviewedBy: 'stale' } }),
        attemptRow(run.id, 'jb', 'a2', 1, { review: legacy }),
      ]);

      expect((await db.findRedTeamRunAttempt(run.id, 'jb::a1'))?.review).toEqual(legacy);
      expect((await db.findRedTeamRunAttempt(run.id, 'jb::a2'))?.review).toEqual(REVIEW);
    });

    it('a re-upsert replaces every field but keeps the review and the creation time', async () => {
      const db = getDb();
      const run = await createRun();
      await db.upsertRedTeamRunAttempts([attemptRow(run.id, 'jb', 'a1', 0, { error: 'boom', partial: true, latencyMs: 12, kbRestricted: ['kb1'] })]);
      const first = await db.findRedTeamRunAttempt(run.id, 'jb::a1');
      expect(first).toMatchObject({ error: 'boom', partial: true, latencyMs: 12, kbRestricted: ['kb1'] });
      expect(await db.setRedTeamRunAttemptReview(run.id, 'jb::a1', REVIEW)).toBe(true);
      await sleep(5);

      await db.upsertRedTeamRunAttempts([
        attemptRow(run.id, 'jb', 'a1', 3, {
          outcome: 'vulnerable',
          confidence: 0.4,
          transcript: [{ user: 'again', assistant: 'sure' }],
          review: { outcome: 'safe', reviewedBy: 'mallory', reviewedAt: new Date() },
        }),
      ]);

      const after = await db.findRedTeamRunAttempt(run.id, 'jb::a1');
      expect(after).toMatchObject({
        seq: 3,
        outcome: 'vulnerable',
        confidence: 0.4,
        transcript: [{ user: 'again', assistant: 'sure' }],
        review: REVIEW,
      });
      // Fields the new attempt does not carry do not survive from the old one.
      expect(after?.error).toBeUndefined();
      expect(after?.partial).toBeUndefined();
      expect(after?.latencyMs).toBeUndefined();
      expect(after?.kbRestricted).toBeUndefined();
      expect(after?.createdAt?.getTime()).toBe(first?.createdAt?.getTime());
      expect(after?.updatedAt?.getTime()).toBeGreaterThan(first?.updatedAt?.getTime() ?? 0);
    });

    it('lists in seq order whatever the write order, and pages', async () => {
      const db = getDb();
      const run = await createRun();
      const other = await createRun({ campaignKey: 'other' });
      await db.upsertRedTeamRunAttempts([
        attemptRow(run.id, 'p', 'c', 2),
        attemptRow(run.id, 'p', 'a', 0),
        attemptRow(other.id, 'p', 'z', 0),
        attemptRow(run.id, 'p', 'd', 3),
        attemptRow(run.id, 'p', 'b', 1),
      ]);

      expect((await db.listRedTeamRunAttempts(run.id)).map((r) => r.attemptId)).toEqual(['a', 'b', 'c', 'd']);
      expect((await db.listRedTeamRunAttempts(run.id, { limit: 2 })).map((r) => r.attemptId)).toEqual(['a', 'b']);
      expect((await db.listRedTeamRunAttempts(run.id, { limit: 2, skip: 2 })).map((r) => r.attemptId)).toEqual(['c', 'd']);
      expect((await db.listRedTeamRunAttempts(run.id, { skip: 3 })).map((r) => r.attemptId)).toEqual(['d']);
      // limit is clamped to at least 1 and skip to at least 0.
      expect(await db.listRedTeamRunAttempts(run.id, { limit: 0, skip: -4 })).toHaveLength(1);
      expect(await db.countRedTeamRunAttempts(run.id)).toBe(4);
      expect(await db.countRedTeamRunAttempts(other.id)).toBe(1);
      expect(await db.countRedTeamRunAttempts(ABSENT_ID)).toBe(0);
      expect(await db.listRedTeamRunAttempts(ABSENT_ID)).toEqual([]);
    });

    it('finds one attempt by run and key, with string ids', async () => {
      const db = getDb();
      const run = await createRun();
      await db.upsertRedTeamRunAttempts([attemptRow(run.id, 'jb', 'a1', 0)]);

      const found = await db.findRedTeamRunAttempt(run.id, 'jb::a1');
      expect(found).toMatchObject({ runId: run.id, attemptKey: 'jb::a1', probeKey: 'jb', attemptId: 'a1', projectId: 'p1', tenantId });
      expect(typeof found?._id).toBe('string');
      expect(found?.signals[0]).toMatchObject({ detectorKey: 'refusal', hit: false });
      expect(await db.findRedTeamRunAttempt(run.id, 'jb::nope')).toBeNull();
      expect(await db.findRedTeamRunAttempt(ABSENT_ID, 'jb::a1')).toBeNull();
    });

    it('sets and clears a review in place', async () => {
      const db = getDb();
      const run = await createRun();
      await db.upsertRedTeamRunAttempts([attemptRow(run.id, 'jb', 'a1', 0), attemptRow(run.id, 'jb', 'a2', 1)]);

      expect(await db.setRedTeamRunAttemptReview(run.id, 'jb::a1', REVIEW)).toBe(true);
      expect((await db.findRedTeamRunAttempt(run.id, 'jb::a1'))?.review).toEqual(REVIEW);
      expect((await db.findRedTeamRunAttempt(run.id, 'jb::a2'))?.review).toBeUndefined();

      expect(await db.setRedTeamRunAttemptReview(run.id, 'jb::a1', null)).toBe(true);
      expect((await db.findRedTeamRunAttempt(run.id, 'jb::a1'))?.review).toBeUndefined();

      expect(await db.setRedTeamRunAttemptReview(run.id, 'jb::missing', REVIEW)).toBe(false);
    });

    it('deleting a run deletes its attempt rows, and only its own', async () => {
      const db = getDb();
      const run = await createRun();
      const other = await createRun({ campaignKey: 'other' });
      await db.upsertRedTeamRunAttempts([attemptRow(run.id, 'jb', 'a1', 0), attemptRow(other.id, 'jb', 'a1', 0)]);

      expect(await db.deleteRedTeamRun(run.id)).toBe(true);

      expect(await db.findRedTeamRunById(run.id)).toBeNull();
      expect(await db.countRedTeamRunAttempts(run.id)).toBe(0);
      expect(await db.countRedTeamRunAttempts(other.id)).toBe(1);
      expect(await db.findRedTeamRunById(other.id)).not.toBeNull();
      expect(await db.deleteRedTeamRun(run.id)).toBe(false);
    });

    it('deletes the attempt rows of a run and reports how many', async () => {
      const db = getDb();
      const run = await createRun();
      await db.upsertRedTeamRunAttempts([attemptRow(run.id, 'jb', 'a1', 0), attemptRow(run.id, 'jb', 'a2', 1)]);

      expect(await db.deleteRedTeamRunAttempts(run.id)).toBe(2);
      expect(await db.deleteRedTeamRunAttempts(run.id)).toBe(0);
      expect(await db.findRedTeamRunById(run.id)).not.toBeNull();
    });
  });

  describe('updateRedTeamRunIf', () => {
    it('stores and returns the lifecycle fields', async () => {
      const db = getDb();
      const run = await createRun({ attemptStore: 'collection', warnings: ['w1'] });
      expect(await db.findRedTeamRunById(run.id)).toMatchObject({ attemptStore: 'collection', warnings: ['w1'] });

      const lease = new Date(Date.now() + 60_000);
      const cancelledAt = new Date();
      const updated = await db.updateRedTeamRunIf(run.id, { status: 'pending' }, {
        status: 'running',
        workerId: 'host:1:abcd1234',
        leaseUntil: lease,
        cancelRequested: true,
        cancelRequestedBy: 'ann',
        cancelledAt,
        skippedAttempts: 4,
        notApplicableAttempts: 2,
        warnings: ['a', 'b'],
        startedAt: new Date(),
      });

      expect(updated).toMatchObject({
        status: 'running',
        workerId: 'host:1:abcd1234',
        cancelRequested: true,
        cancelRequestedBy: 'ann',
        skippedAttempts: 4,
        notApplicableAttempts: 2,
        warnings: ['a', 'b'],
        attemptStore: 'collection',
      });
      expect(updated?.leaseUntil?.getTime()).toBe(lease.getTime());
      expect(updated?.cancelledAt?.getTime()).toBe(cancelledAt.getTime());
      expect(String(updated?._id)).toBe(run.id);
      expect(await db.findRedTeamRunById(run.id)).toMatchObject({ status: 'running', workerId: 'host:1:abcd1234', cancelRequested: true });
    });

    it('applies on a status match and misses (changing nothing) on a mismatch', async () => {
      const db = getDb();
      const run = await createRun();

      expect(await db.updateRedTeamRunIf(run.id, { status: 'running' }, { status: 'completed' })).toBeNull();
      expect((await db.findRedTeamRunById(run.id))?.status).toBe('pending');

      expect((await db.updateRedTeamRunIf(run.id, { status: 'pending' }, { status: 'running' }))?.status).toBe('running');
      // A second claim of the same pending run misses: only one worker wins it.
      expect(await db.updateRedTeamRunIf(run.id, { status: 'pending' }, { status: 'running', workerId: 'late' })).toBeNull();
      expect((await db.findRedTeamRunById(run.id))?.workerId).toBeUndefined();
    });

    it('accepts a list of statuses', async () => {
      const db = getDb();
      const run = await createRun();

      expect(await db.updateRedTeamRunIf(run.id, { status: ['running', 'completed'] }, { error: 'x' })).toBeNull();
      expect((await db.updateRedTeamRunIf(run.id, { status: ['pending', 'running'] }, { error: 'x' }))?.error).toBe('x');
      expect(await db.updateRedTeamRunIf(run.id, { status: [] }, { error: 'y' })).toBeNull();
    });

    it('matches on the worker id', async () => {
      const db = getDb();
      const run = await createRun();
      await db.updateRedTeamRunIf(run.id, { status: 'pending' }, { status: 'running', workerId: 'w1' });

      expect(await db.updateRedTeamRunIf(run.id, { status: 'running', workerId: 'w2' }, { leaseUntil: new Date() })).toBeNull();
      const lease = new Date(Date.now() + 30_000);
      const renewed = await db.updateRedTeamRunIf(run.id, { status: 'running', workerId: 'w1' }, { leaseUntil: lease });
      expect(renewed?.leaseUntil?.getTime()).toBe(lease.getTime());
      // A guard on the worker alone also works.
      expect((await db.updateRedTeamRunIf(run.id, { workerId: 'w1' }, { progress: { total: 3, completed: 1, failed: 0 } }))?.progress).toEqual({ total: 3, completed: 1, failed: 0 });
      expect(await db.updateRedTeamRunIf(run.id, { workerId: 'other' }, { progress: { total: 9, completed: 9, failed: 9 } })).toBeNull();
    });

    it('matches on updatedAt: a newer write makes the older snapshot miss', async () => {
      const db = getDb();
      const run = await createRun();
      await sleep(5);

      const first = await db.updateRedTeamRunIf(run.id, { updatedAt: run.updatedAt }, { progress: { total: 1, completed: 0, failed: 0 } });
      expect(first).not.toBeNull();
      expect(first?.updatedAt?.getTime()).toBeGreaterThan(run.updatedAt?.getTime() ?? 0);
      await sleep(5);

      // The snapshot taken at creation is stale now.
      expect(await db.updateRedTeamRunIf(run.id, { updatedAt: run.updatedAt }, { status: 'failed' })).toBeNull();
      expect((await db.findRedTeamRunById(run.id))?.status).toBe('pending');
      expect((await db.updateRedTeamRunIf(run.id, { updatedAt: first?.updatedAt }, { status: 'failed' }))?.status).toBe('failed');
    });

    it('needs every given guard field to hold', async () => {
      const db = getDb();
      const run = await createRun();
      await db.updateRedTeamRunIf(run.id, { status: 'pending' }, { status: 'running', workerId: 'w1' });

      expect(await db.updateRedTeamRunIf(run.id, { status: 'running', workerId: 'w2' }, { error: 'x' })).toBeNull();
      expect(await db.updateRedTeamRunIf(run.id, { status: 'pending', workerId: 'w1' }, { error: 'x' })).toBeNull();
      expect((await db.updateRedTeamRunIf(run.id, { status: 'running', workerId: 'w1' }, { error: 'x' }))?.error).toBe('x');
    });

    it('always sets updatedAt, and misses on unknown and malformed ids', async () => {
      const db = getDb();
      const run = await createRun();
      await sleep(5);

      const updated = await db.updateRedTeamRunIf(run.id, { status: 'pending' }, { status: 'cancelled' });
      expect(updated?.updatedAt?.getTime()).toBeGreaterThan(run.updatedAt?.getTime() ?? 0);
      expect(await db.updateRedTeamRunIf(ABSENT_ID, { status: 'pending' }, { status: 'cancelled' })).toBeNull();
      expect(await db.updateRedTeamRunIf(NOT_AN_ID, { status: 'pending' }, { status: 'cancelled' })).toBeNull();
    });

    it('leaves fields the update does not name alone', async () => {
      const db = getDb();
      const run = await createRun({ error: 'earlier', skippedAttempts: 7 });

      const updated = await db.updateRedTeamRunIf(run.id, { status: 'pending' }, { status: 'running', error: undefined });

      expect(updated).toMatchObject({ status: 'running', error: 'earlier', skippedAttempts: 7 });
    });
  });

  describe('listStaleRedTeamRuns', () => {
    it('returns expired leases, unleased running runs past the legacy window, and old pending runs', async () => {
      const db = getDb();
      const oldPending = await createRun({ campaignKey: 'old-pending' });
      await sleep(15);
      const pendingCutoff = new Date();
      await sleep(15);
      const freshPending = await createRun({ campaignKey: 'fresh-pending' });

      const expired = await createRun({ campaignKey: 'expired', status: 'running', attempts: [{ probeKey: 'x' } as never] });
      await db.updateRedTeamRunIf(expired.id, { status: 'running' }, { workerId: 'w', leaseUntil: new Date(Date.now() - 3_600_000) });
      const live = await createRun({ campaignKey: 'live', status: 'running' });
      await db.updateRedTeamRunIf(live.id, { status: 'running' }, { workerId: 'w', leaseUntil: new Date(Date.now() + 3_600_000) });
      const legacy = await createRun({ campaignKey: 'legacy', status: 'running' });
      const done = await createRun({ campaignKey: 'done', status: 'completed' });

      const stale = await db.listStaleRedTeamRuns({
        leaseExpiredBefore: new Date(),
        legacyUpdatedBefore: new Date(Date.now() + 60_000),
        pendingCreatedBefore: pendingCutoff,
      });
      const ids = stale.map((r) => String(r._id));

      expect(ids.sort()).toEqual([oldPending.id, expired.id, legacy.id].sort());
      expect(ids).not.toContain(freshPending.id);
      expect(ids).not.toContain(live.id);
      expect(ids).not.toContain(done.id);
      // Attempts are left out.
      for (const run of stale) expect(run.attempts).toEqual([]);
    });

    it('keeps an unleased running run that was written recently', async () => {
      const db = getDb();
      const legacy = await createRun({ campaignKey: 'legacy', status: 'running' });

      const recentOnly = await db.listStaleRedTeamRuns({
        leaseExpiredBefore: new Date(),
        legacyUpdatedBefore: new Date(0),
        pendingCreatedBefore: new Date(0),
      });
      expect(recentOnly.map((r) => String(r._id))).not.toContain(legacy.id);

      const past = await db.listStaleRedTeamRuns({
        leaseExpiredBefore: new Date(0),
        legacyUpdatedBefore: new Date(Date.now() + 60_000),
        pendingCreatedBefore: new Date(0),
      });
      expect(past.map((r) => String(r._id))).toContain(legacy.id);
    });

    it('does not read a lease as the legacy clock: a leased run is stale only by its lease', async () => {
      const db = getDb();
      const leased = await createRun({ status: 'running' });
      await db.updateRedTeamRunIf(leased.id, { status: 'running' }, { workerId: 'w', leaseUntil: new Date(Date.now() + 3_600_000) });

      const stale = await db.listStaleRedTeamRuns({
        leaseExpiredBefore: new Date(),
        legacyUpdatedBefore: new Date(Date.now() + 60_000),
        pendingCreatedBefore: new Date(Date.now() + 60_000),
      });

      expect(stale.map((r) => String(r._id))).not.toContain(leased.id);
    });

    it('honours the limit and lists the oldest first', async () => {
      const db = getDb();
      const a = await createRun({ campaignKey: 'a' });
      await sleep(5);
      await createRun({ campaignKey: 'b' });
      await sleep(5);
      await createRun({ campaignKey: 'c' });

      const stale = await db.listStaleRedTeamRuns({
        leaseExpiredBefore: new Date(),
        legacyUpdatedBefore: new Date(),
        pendingCreatedBefore: new Date(Date.now() + 60_000),
        limit: 2,
      });

      expect(stale).toHaveLength(2);
      expect(String(stale[0]._id)).toBe(a.id);
    });
  });

  describe('listRedTeamRuns and countRedTeamRuns', () => {
    const seedStatuses = async () => {
      const made: Record<string, string> = {};
      for (const status of ['pending', 'running', 'completed', 'failed'] as RedTeamRunStatus[]) {
        made[status] = (await createRun({ status, campaignKey: `c-${status}`, attempts: [{ probeKey: 'embedded' } as never] })).id;
        await sleep(3);
      }
      return made;
    };

    it('filters by one status or a list of statuses, newest first', async () => {
      const db = getDb();
      const made = await seedStatuses();

      const active = await db.listRedTeamRuns({ projectId: 'p1', status: ['pending', 'running'] });
      expect(active.map((r) => String(r._id))).toEqual([made.running, made.pending]);
      expect((await db.listRedTeamRuns({ status: 'failed' })).map((r) => String(r._id))).toEqual([made.failed]);
      expect(await db.listRedTeamRuns({ status: [] })).toEqual([]);

      expect(await db.countRedTeamRuns({ projectId: 'p1', status: ['pending', 'running'] })).toBe(2);
      expect(await db.countRedTeamRuns({ status: 'completed' })).toBe(1);
      expect(await db.countRedTeamRuns({ campaignKey: 'c-failed' })).toBe(1);
      expect(await db.countRedTeamRuns({ projectId: 'other-project' })).toBe(0);
      expect(await db.countRedTeamRuns({ status: [] })).toBe(0);
      expect(await db.countRedTeamRuns()).toBe(4);
    });

    it('leaves the embedded attempts out on request and keeps them otherwise', async () => {
      const db = getDb();
      const made = await seedStatuses();

      const lean = await db.listRedTeamRuns({ omitAttempts: true });
      expect(lean).toHaveLength(4);
      for (const run of lean) {
        expect(run.attempts).toEqual([]);
        expect(run.campaignKey).toBeTruthy();
        expect(run.progress).toBeTruthy();
      }
      const full = await db.listRedTeamRuns({});
      expect(full.every((r) => r.attempts.length === 1)).toBe(true);
      expect((await db.findRedTeamRunById(made.pending))?.attempts).toHaveLength(1);
    });

    it('clamps limit to 1..200 (default 50) and skip to a non-negative integer', async () => {
      const db = getDb();
      const made = await seedStatuses();

      expect(await db.listRedTeamRuns({ limit: 0 })).toHaveLength(1);
      expect(await db.listRedTeamRuns({ limit: -5 })).toHaveLength(1);
      expect(await db.listRedTeamRuns({ limit: 1_000_000 })).toHaveLength(4);
      expect(await db.listRedTeamRuns({ limit: Number.NaN })).toHaveLength(4);
      expect(await db.listRedTeamRuns({ limit: 2.9 })).toHaveLength(2);
      expect((await db.listRedTeamRuns({ skip: -3 })).map((r) => String(r._id))[0]).toBe(made.failed);
      expect(await db.listRedTeamRuns({ skip: 3 })).toHaveLength(1);
      expect(await db.listRedTeamRuns({ skip: 10 })).toEqual([]);
      expect((await db.listRedTeamRuns({ limit: 1, skip: 1 })).map((r) => String(r._id))).toEqual([made.completed]);
    });
  });

  describe('malformed ids', () => {
    it('finds, updates and deletes nothing for an id that is not an id', async () => {
      const db = getDb();

      for (const id of [NOT_AN_ID, '', '123', 'zzzzzzzzzzzzzzzzzzzzzzzz']) {
        expect(await db.findRedTeamCampaignById(id)).toBeNull();
        expect(await db.updateRedTeamCampaign(id, { name: 'x' })).toBeNull();
        expect(await db.deleteRedTeamCampaign(id)).toBe(false);

        expect(await db.findRedTeamRunById(id)).toBeNull();
        expect(await db.updateRedTeamRun(id, { status: 'failed' })).toBeNull();
        expect(await db.updateRedTeamRunIf(id, { status: 'pending' }, { status: 'failed' })).toBeNull();
        expect(await db.deleteRedTeamRun(id)).toBe(false);

        expect(await db.findRedTeamCustomProbeById(id)).toBeNull();
        expect(await db.updateRedTeamCustomProbe(id, { name: 'x' })).toBeNull();
        expect(await db.deleteRedTeamCustomProbe(id)).toBe(false);
      }
    });

    it('a well-formed id that does not exist behaves the same way', async () => {
      const db = getDb();

      expect(await db.findRedTeamCampaignById(ABSENT_ID)).toBeNull();
      expect(await db.updateRedTeamCampaign(ABSENT_ID, { name: 'x' })).toBeNull();
      expect(await db.deleteRedTeamCampaign(ABSENT_ID)).toBe(false);
      expect(await db.findRedTeamRunById(ABSENT_ID)).toBeNull();
      expect(await db.updateRedTeamRun(ABSENT_ID, { status: 'failed' })).toBeNull();
      expect(await db.deleteRedTeamRun(ABSENT_ID)).toBe(false);
      expect(await db.findRedTeamCustomProbeById(ABSENT_ID)).toBeNull();
      expect(await db.deleteRedTeamCustomProbe(ABSENT_ID)).toBe(false);
    });
  });
});
