/**
 * Evaluation DB layer parity (SQLite + MongoDB): run lifecycle primitives
 * (claim / heartbeat / cancel / stale), summaries + counts, the atomic dataset
 * metadata patch, invalid-id handling, item field whitelisting and
 * per-project key scoping.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Evaluation DB layer', (getDb) => {
  let tenantId: string;

  beforeEach(async () => {
    const slug = `evaldb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Eval Co', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const seedRun = (overrides: Record<string, unknown> = {}) =>
    getDb().createEvaluationRun({
      tenantId,
      projectId: 'p1',
      suiteKey: 'smoke',
      targetKey: 't',
      datasetKey: 'd',
      status: 'pending',
      mode: 'single',
      progress: { total: 1, completed: 0, failed: 0 },
      items: [],
      createdBy: 'tester',
      ...overrides,
    } as never);

  const seedDataset = (metadata: Record<string, unknown> = {}) =>
    getDb().createEvaluationDataset({
      tenantId,
      projectId: 'p1',
      key: `ds-${Math.random().toString(36).slice(2, 8)}`,
      name: 'DS',
      source: 'manual',
      metadata,
      items: [{ id: 'a', input: [{ role: 'user', content: 'hi' }] }],
      createdBy: 'tester',
    } as never);

  describe('who started a run', () => {
    it('keeps the caller a run was started by through every read, and none for a run that records none', async () => {
      const db = getDb();
      const token = await seedRun({ actorType: 'api_token', apiTokenId: 'tok-1', createdBy: 'owner-1' });
      const person = await seedRun({ actorType: 'user', createdBy: 'person-1' });
      const legacy = await seedRun();
      const ids = [token, person, legacy].map((run) => String(run._id));

      expect(await db.findEvaluationRunById(ids[0])).toMatchObject({ actorType: 'api_token', apiTokenId: 'tok-1', createdBy: 'owner-1' });
      const pending = await db.listEvaluationRunsByStatus(['pending'], { limit: 10 });
      const listed = new Map(pending.map((run) => [String(run._id), run]));
      expect(listed.get(ids[0])).toMatchObject({ actorType: 'api_token', apiTokenId: 'tok-1' });
      expect(listed.get(ids[1])).toMatchObject({ actorType: 'user' });
      expect(listed.get(ids[1])?.apiTokenId).toBeUndefined();
      expect(listed.get(ids[2])?.actorType).toBeUndefined();
      expect(listed.get(ids[2])?.apiTokenId).toBeUndefined();

      const claimed = await db.claimEvaluationRun(ids[0], new Date());
      expect(claimed).toMatchObject({ status: 'running', actorType: 'api_token', apiTokenId: 'tok-1' });
      // Later writes leave it as it was.
      await db.updateEvaluationRun(ids[0], { status: 'completed', finishedAt: new Date() });
      expect(await db.findEvaluationRunById(ids[0])).toMatchObject({ status: 'completed', actorType: 'api_token', apiTokenId: 'tok-1' });
      const summaries = await db.listEvaluationRunSummaries({ projectId: 'p1', limit: 10 });
      expect(summaries.find((run) => String(run._id) === ids[0])).toMatchObject({ actorType: 'api_token', apiTokenId: 'tok-1' });
    });
  });

  describe('run lifecycle', () => {
    it('claims a pending run exactly once', async () => {
      const db = getDb();
      const run = await seedRun();
      const at = new Date('2026-01-01T10:00:00.000Z');
      const claimed = await db.claimEvaluationRun(String(run._id), at);
      expect(claimed?.status).toBe('running');
      expect(claimed?.startedAt?.toISOString()).toBe(at.toISOString());
      expect(claimed?.heartbeatAt?.toISOString()).toBe(at.toISOString());
      expect(await db.claimEvaluationRun(String(run._id), new Date())).toBeNull();
    });

    it('touches the heartbeat only while running', async () => {
      const db = getDb();
      const run = await seedRun();
      const id = String(run._id);
      expect(await db.touchEvaluationRun(id, new Date())).toBe(false);
      await db.claimEvaluationRun(id, new Date('2026-01-01T10:00:00.000Z'));
      const later = new Date('2026-01-01T10:05:00.000Z');
      expect(await db.touchEvaluationRun(id, later)).toBe(true);
      expect((await db.findEvaluationRunById(id))?.heartbeatAt?.toISOString()).toBe(later.toISOString());
    });

    it('cancels pending runs, flags running runs and leaves finished ones alone', async () => {
      const db = getDb();
      const at = new Date('2026-01-01T11:00:00.000Z');

      const pending = await seedRun();
      const cancelled = await db.requestEvaluationRunCancel(String(pending._id), at);
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.error).toBe('Cancelled before it started');
      expect(cancelled?.finishedAt?.toISOString()).toBe(at.toISOString());

      const running = await seedRun();
      await db.claimEvaluationRun(String(running._id), new Date());
      const flagged = await db.requestEvaluationRunCancel(String(running._id), at);
      expect(flagged?.status).toBe('running');
      expect(flagged?.cancelRequestedAt?.toISOString()).toBe(at.toISOString());

      const done = await seedRun({ status: 'completed' });
      const unchanged = await db.requestEvaluationRunCancel(String(done._id), at);
      expect(unchanged?.status).toBe('completed');
      expect(unchanged?.cancelRequestedAt).toBeUndefined();

      expect(await db.requestEvaluationRunCancel('000000000000000000000000', at)).toBeNull();
    });

    it('fails only runs whose heartbeat is older than the cutoff', async () => {
      const db = getDb();
      const stale = await seedRun();
      const fresh = await seedRun();
      await db.claimEvaluationRun(String(stale._id), new Date('2026-01-01T10:00:00.000Z'));
      await db.claimEvaluationRun(String(fresh._id), new Date('2026-01-01T10:00:00.000Z'));
      await db.touchEvaluationRun(String(fresh._id), new Date('2026-01-01T10:09:00.000Z'));
      const pending = await seedRun();

      const changed = await db.failStaleEvaluationRuns(new Date('2026-01-01T10:05:00.000Z'), 'stopped responding');
      expect(changed).toBe(1);
      const staleAfter = await db.findEvaluationRunById(String(stale._id));
      expect(staleAfter?.status).toBe('failed');
      expect(staleAfter?.error).toBe('stopped responding');
      expect(staleAfter?.finishedAt).toBeInstanceOf(Date);
      expect((await db.findEvaluationRunById(String(fresh._id)))?.status).toBe('running');
      expect((await db.findEvaluationRunById(String(pending._id)))?.status).toBe('pending');
    });

    it('expires only runs still pending and older than the cutoff, never one a worker has claimed', async () => {
      const db = getDb();
      const claimed = await seedRun();
      const waiting = await seedRun();
      // Claimed after the runs were created (and after any sweep could have selected them): it is running now.
      expect(await db.claimEvaluationRun(String(claimed._id), new Date())).not.toBeNull();

      expect(await db.expirePendingEvaluationRuns(new Date('2000-01-01'), 'never started')).toBe(0);
      expect(await db.expirePendingEvaluationRuns(new Date(Date.now() + 60_000), 'never started')).toBe(1);

      const expired = await db.findEvaluationRunById(String(waiting._id));
      expect(expired?.status).toBe('failed');
      expect(expired?.error).toBe('never started');
      expect(expired?.finishedAt).toBeInstanceOf(Date);
      expect((await db.findEvaluationRunById(String(claimed._id)))?.status).toBe('running');
      // And the other order: once expired, a late claim finds nothing to run.
      expect(await db.claimEvaluationRun(String(waiting._id), new Date())).toBeNull();
    });

    it('falls back to startedAt when a running run never wrote a heartbeat', async () => {
      const db = getDb();
      const legacy = await seedRun({ status: 'running', startedAt: new Date('2026-01-01T09:00:00.000Z') });
      expect(await db.failStaleEvaluationRuns(new Date('2026-01-01T10:00:00.000Z'), 'x')).toBe(1);
      expect((await db.findEvaluationRunById(String(legacy._id)))?.status).toBe('failed');
    });
  });

  describe('run listing', () => {
    it('projects items out of summaries, filters by statuses and counts', async () => {
      const db = getDb();
      const item = { index: 0, itemId: 'a', input: [], scores: [], score: 1, passed: true };
      await seedRun({ status: 'completed', items: [item] });
      await seedRun({ status: 'failed', items: [item] });
      await seedRun({ status: 'running' });
      await seedRun({ status: 'completed', projectId: 'other' });

      const summaries = await db.listEvaluationRunSummaries({ projectId: 'p1', statuses: ['completed', 'failed'] });
      expect(summaries).toHaveLength(2);
      for (const s of summaries) expect(s.items).toEqual([]);

      const full = await db.listEvaluationRuns({ projectId: 'p1', status: 'completed' });
      expect(full).toHaveLength(1);
      expect(full[0].items).toHaveLength(1);

      expect(await db.countEvaluationRuns({ projectId: 'p1' })).toBe(3);
      expect(await db.countEvaluationRuns({ projectId: 'p1', statuses: ['running', 'failed'] })).toBe(2);

      const page = await db.listEvaluationRunSummaries({ projectId: 'p1', limit: 2, skip: 2 });
      expect(page).toHaveLength(1);
    });

    it('lists runs tenant-wide by status without items', async () => {
      const db = getDb();
      await seedRun({ status: 'running', projectId: 'a' });
      await seedRun({ status: 'pending', projectId: 'b' });
      await seedRun({ status: 'completed', projectId: 'c' });
      const rows = await db.listEvaluationRunsByStatus(['running', 'pending']);
      expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'running']);
      for (const r of rows) expect(r.items).toEqual([]);
      expect(await db.listEvaluationRunsByStatus(['pending'], { createdBefore: new Date('2000-01-01') })).toEqual([]);
      expect(await db.listEvaluationRunsByStatus([])).toEqual([]);
    });

    it('pages pending runs after the last one read, without skipping any when runs leave the set meanwhile', async () => {
      const db = getDb();
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) ids.push(String((await seedRun())._id));

      const seen: string[] = [];
      let after: { createdAt: Date; id: string } | undefined;
      for (let page = 0; page < 10; page += 1) {
        const rows = await db.listEvaluationRunsByStatus(['pending'], { limit: 3, ...(after ? { after } : {}) });
        seen.push(...rows.map((r) => String(r._id)));
        // A run of a later page is claimed while this one is processed: the next page must not shift past others.
        if (page === 0) await db.claimEvaluationRun(ids.find((id) => !seen.includes(id))!, new Date());
        if (rows.length < 3) break;
        const last = rows[rows.length - 1];
        after = { createdAt: new Date(last.createdAt!), id: String(last._id) };
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(6);
      const claimed = ids.filter((id) => !seen.includes(id));
      expect(claimed).toHaveLength(1);
      expect((await db.findEvaluationRunById(claimed[0]))?.status).toBe('running');
    });

    it('round-trips itemsTruncated and the new aggregate fields', async () => {
      const db = getDb();
      const run = await seedRun();
      const updated = await db.updateEvaluationRun(String(run._id), {
        itemsTruncated: true,
        aggregate: { total: 1, completed: 1, failed: 0, passed: 1, passRate: 1, avgScore: 1, skipped: 0, errorRate: 0 } as never,
      });
      expect(updated?.itemsTruncated).toBe(true);
      expect(updated?.aggregate).toMatchObject({ skipped: 0, errorRate: 0 });
      const old = await seedRun();
      expect((await db.findEvaluationRunById(String(old._id)))?.itemsTruncated ?? undefined).toBeUndefined();
    });
  });

  describe('invalid ids', () => {
    it('returns null / false instead of throwing for malformed ids', async () => {
      const db = getDb();
      const bad = 'not-an-object-id';
      expect(await db.findEvaluationRunById(bad)).toBeNull();
      expect(await db.updateEvaluationRun(bad, { status: 'failed' })).toBeNull();
      expect(await db.claimEvaluationRun(bad, new Date())).toBeNull();
      expect(await db.touchEvaluationRun(bad, new Date())).toBe(false);
      expect(await db.requestEvaluationRunCancel(bad, new Date())).toBeNull();
      expect(await db.findEvaluationDatasetById(bad)).toBeNull();
      expect(await db.updateEvaluationDataset(bad, { name: 'x' })).toBeNull();
      expect(await db.deleteEvaluationDataset(bad)).toBe(false);
      expect(await db.patchEvaluationDatasetMetadata(bad, { a: 1 })).toBeNull();
      expect(await db.findEvaluationSuiteById(bad)).toBeNull();
      expect(await db.deleteEvaluationSuite(bad)).toBe(false);
      expect(await db.findEvaluationTargetById(bad)).toBeNull();
      expect(await db.deleteEvaluationTarget(bad)).toBe(false);
    });
  });

  describe('dataset metadata patch', () => {
    it('merges one block and leaves the others alone', async () => {
      const db = getDb();
      const ds = await seedDataset({ generation: { status: 'done' }, labeling: { status: 'idle' } });
      const patched = await db.patchEvaluationDatasetMetadata(String(ds._id), { labeling: { status: 'running', n: 2 } });
      expect(patched?.metadata).toEqual({ generation: { status: 'done' }, labeling: { status: 'running', n: 2 } });
      expect(patched?.itemCount).toBe(1);
    });

    it('unsets a block when the value is undefined', async () => {
      const db = getDb();
      const ds = await seedDataset({ generation: { status: 'done' }, labeling: { status: 'idle' } });
      const patched = await db.patchEvaluationDatasetMetadata(String(ds._id), { generation: undefined });
      expect(patched?.metadata).toEqual({ labeling: { status: 'idle' } });
    });

    it('rejects unsafe keys', async () => {
      const db = getDb();
      const ds = await seedDataset();
      await expect(db.patchEvaluationDatasetMetadata(String(ds._id), { 'a.b': 1 })).rejects.toThrow(/Invalid dataset metadata key/);
      await expect(db.patchEvaluationDatasetMetadata(String(ds._id), { '$set': 1 })).rejects.toThrow();
    });

    it('honours unlessParityStatusIn as a lost-claim guard', async () => {
      const db = getDb();
      const ds = await seedDataset({ parity: { status: 'running' } });
      const id = String(ds._id);
      expect(await db.patchEvaluationDatasetMetadata(id, { parity: { status: 'running', by: 'b' } }, { unlessParityStatusIn: ['running'] })).toBeNull();
      const ok = await db.patchEvaluationDatasetMetadata(id, { parity: { status: 'done' } }, { unlessParityStatusIn: ['queued'] });
      expect(ok?.metadata).toEqual({ parity: { status: 'done' } });

      const fresh = await seedDataset({});
      const claimed = await db.patchEvaluationDatasetMetadata(String(fresh._id), { parity: { status: 'running' } }, { unlessParityStatusIn: ['running'] });
      expect(claimed?.metadata).toEqual({ parity: { status: 'running' } });
    });
  });

  describe('dataset items', () => {
    it('drops unknown keys on insert and update', async () => {
      const db = getDb();
      const ds = await seedDataset();
      const id = String(ds._id);
      await db.createEvaluationDatasetItems(id, [
        { id: 'b', input: [{ role: 'user', content: 'x' }], tags: ['t'], evil: 'x', $set: { a: 1 } } as never,
      ]);
      const found = await db.findEvaluationDatasetItem(id, 'b');
      expect(found?.tags).toEqual(['t']);
      expect((found as unknown as Record<string, unknown>).evil).toBeUndefined();
      expect((found as unknown as Record<string, unknown>).$set).toBeUndefined();

      const updated = await db.updateEvaluationDatasetItem(id, 'b', { tags: ['u'], datasetId: 'other', position: 99, bogus: 1 } as never);
      expect(updated?.tags).toEqual(['u']);
      expect(updated?.datasetId).toBe(id);
      expect(updated?.position).not.toBe(99);
      expect((updated as unknown as Record<string, unknown>).bogus).toBeUndefined();
    });

    it('keeps the old items when a replace fails on a duplicate id', async () => {
      const db = getDb();
      const ds = await seedDataset();
      const id = String(ds._id);
      await expect(
        db.updateEvaluationDataset(id, {
          items: [
            { id: 'x', input: [] },
            { id: 'x', input: [] },
          ],
        }),
      ).rejects.toThrow();
      const items = await db.listEvaluationDatasetItems(id);
      expect(items.map((i) => i.id)).toEqual(['a']);
      expect((await db.findEvaluationDatasetById(id))?.itemCount).toBe(1);
    });
  });

  describe('key scoping', () => {
    it('allows the same suite/target/dataset key in two projects', async () => {
      const db = getDb();
      const mk = (projectId: string) =>
        db.createEvaluationSuite({
          tenantId, projectId, key: 'shared', name: 'S', targetKey: 't', datasetKey: 'd', scorers: [], createdBy: 'u',
        } as never);
      await mk('p1');
      await expect(mk('p2')).resolves.toMatchObject({ key: 'shared', projectId: 'p2' });

      const mkTarget = (projectId: string) =>
        db.createEvaluationTarget({ tenantId, projectId, key: 'shared', name: 'T', kind: 'model', modelKey: 'm', createdBy: 'u' } as never);
      await mkTarget('p1');
      await expect(mkTarget('p2')).resolves.toMatchObject({ projectId: 'p2' });

      const mkDs = (projectId: string) =>
        db.createEvaluationDataset({ tenantId, projectId, key: 'shared', name: 'D', source: 'manual', createdBy: 'u' } as never);
      await mkDs('p1');
      await expect(mkDs('p2')).resolves.toMatchObject({ projectId: 'p2' });
      expect(await db.findEvaluationSuiteByKey('shared', 'p2')).toMatchObject({ projectId: 'p2' });
    });
  });
});

describe('evaluation item field whitelist', () => {
  it('copies only known, defined fields', async () => {
    const { pickEvaluationItemFields, assertMetadataPatchKeys } = await import('@/lib/database/provider/evaluationItemFields');
    expect(
      pickEvaluationItemFields({ id: 'z', input: [], expected: undefined, tags: ['a'], labelMeta: { k: 1 }, evil: 1 }),
    ).toEqual({ input: [], tags: ['a'], labelMeta: { k: 1 } });
    expect(() => assertMetadataPatchKeys({ ok_key: 1, 'a-b': 2 })).not.toThrow();
    expect(() => assertMetadataPatchKeys({ 'a.b': 1 })).toThrow();
  });
});
