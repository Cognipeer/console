/**
 * The metered size of a vector index on a platform provider - the contract both database providers keep (SQLite and
 * MongoDB via mongodb-memory-server): `adjustVectorIndexStorage` adds atomically and never goes below 0,
 * `sumVectorIndexStoredBytes` adds up the tenant, and neither number can be written through a create or an update.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { IVectorIndexRecord } from '@/lib/database/provider.interface';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Vector index stored size', (getDb) => {
  let tenantId: string;

  beforeEach(async () => {
    const slug = `vstore-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const db = getDb();
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
  });

  const create = (key: string, extra: Partial<IVectorIndexRecord> = {}) => getDb().createVectorIndex({
    tenantId, projectId: 'p1', providerKey: 'platform-vector', key, name: key, externalId: `ext-${key}`,
    dimension: 4, metric: 'cosine', createdBy: 'u1', ...extra,
  });
  const id = (record: IVectorIndexRecord) => String(record._id);

  it('starts with no metered size', async () => {
    const index = await create('docs');
    expect(index.storedBytes ?? 0).toBe(0);
    const read = await getDb().findVectorIndexById(id(index));
    expect(read?.storedBytes ?? 0).toBe(0);
    expect(read?.storedVectors ?? 0).toBe(0);
    expect(await getDb().sumVectorIndexStoredBytes()).toBe(0);
  });

  it('adds and removes, and answers the record after the change', async () => {
    const index = await create('docs');
    const first = await getDb().adjustVectorIndexStorage(id(index), 300, 3);
    expect(first).toMatchObject({ storedBytes: 300, storedVectors: 3 });
    const second = await getDb().adjustVectorIndexStorage(id(index), -100, -1);
    expect(second).toMatchObject({ storedBytes: 200, storedVectors: 2 });
    expect(await getDb().findVectorIndexById(id(index))).toMatchObject({ storedBytes: 200, storedVectors: 2 });
  });

  it('never goes below 0, each number on its own', async () => {
    const index = await create('docs');
    await getDb().adjustVectorIndexStorage(id(index), 50, 5);
    const after = await getDb().adjustVectorIndexStorage(id(index), -500, -1);
    expect(after).toMatchObject({ storedBytes: 0, storedVectors: 4 });
    const again = await getDb().adjustVectorIndexStorage(id(index), -1, -10);
    expect(again).toMatchObject({ storedBytes: 0, storedVectors: 0 });
  });

  it('is atomic: concurrent adjustments all land', async () => {
    const index = await create('docs');
    await Promise.all(Array.from({ length: 20 }, () => getDb().adjustVectorIndexStorage(id(index), 10, 1)));
    expect(await getDb().findVectorIndexById(id(index))).toMatchObject({ storedBytes: 200, storedVectors: 20 });
  });

  it('answers null for an index that does not exist', async () => {
    const index = await create('docs');
    await getDb().deleteVectorIndex(id(index));
    expect(await getDb().adjustVectorIndexStorage(id(index), 10, 1)).toBeNull();
  });

  it('adds up every index of the tenant and leaves out a deleted one', async () => {
    const a = await create('a');
    const b = await create('b');
    await create('c');
    await getDb().adjustVectorIndexStorage(id(a), 100, 1);
    await getDb().adjustVectorIndexStorage(id(b), 250, 2);
    expect(await getDb().sumVectorIndexStoredBytes()).toBe(350);
    await getDb().deleteVectorIndex(id(b));
    expect(await getDb().sumVectorIndexStoredBytes()).toBe(100);
  });

  it('is not written by a create or an update: only the adjustment writes it', async () => {
    const index = await create('docs', { storedBytes: 999, storedVectors: 9 });
    expect(await getDb().sumVectorIndexStoredBytes()).toBe(0);
    const read = await getDb().findVectorIndexById(id(index));
    expect(read?.storedBytes ?? 0).toBe(0);
    await getDb().adjustVectorIndexStorage(id(index), 40, 2);
    const updated = await getDb().updateVectorIndex(id(index), { name: 'renamed', storedBytes: 5000, storedVectors: 50 });
    expect(updated).toMatchObject({ name: 'renamed', storedBytes: 40, storedVectors: 2 });
    expect(await getDb().sumVectorIndexStoredBytes()).toBe(40);
  });
});
