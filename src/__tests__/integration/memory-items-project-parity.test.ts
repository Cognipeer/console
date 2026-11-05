/**
 * Memory items: store keys are unique only within a project, so two projects of one tenant can both have
 * `mem-notes`. Dedup lookups, deletes and counts must stay inside the caller's project, the same on SQLite
 * and MongoDB. Also covers the vector-id lookup search uses and the expiry filter agent recall uses.
 */
import { beforeEach, expect, it } from 'vitest';
import type { DatabaseProvider, IMemoryItem } from '@/lib/database';
import { describeForEachProvider } from './db-parity.helper';

describeForEachProvider('Memory items stay inside their project', (getDb) => {
  let db: DatabaseProvider;
  let tenantId: string;
  const STORE = 'mem-notes';

  const item = (projectId: string, vectorId: string, extra: Partial<IMemoryItem> = {}) => ({
    tenantId,
    projectId,
    storeKey: STORE,
    content: `content ${vectorId}`,
    contentHash: 'same-hash',
    scope: 'global' as const,
    metadata: {},
    tags: [],
    source: 'api' as const,
    importance: 0.5,
    accessCount: 0,
    embeddingVersion: 'emb',
    vectorId,
    status: 'active' as const,
    ...extra,
  });

  beforeEach(async () => {
    db = getDb();
    const slug = `memory-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dbName = `tenant_${slug}`;
    const tenant = await db.createTenant({ companyName: 'Acme', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    tenantId = String(tenant._id);
    await db.switchToTenant(dbName);
    await db.createMemoryItem(item('proj-a', 'vec-a1'));
    await db.createMemoryItem(item('proj-b', 'vec-b1'));
  });

  it('finds a duplicate only in the same project', async () => {
    expect((await db.findMemoryItemByHash(STORE, 'same-hash', 'proj-a'))?.vectorId).toBe('vec-a1');
    expect((await db.findMemoryItemByHash(STORE, 'same-hash', 'proj-b'))?.vectorId).toBe('vec-b1');
    expect(await db.findMemoryItemByHash(STORE, 'same-hash', 'proj-c')).toBeNull();
  });

  it('deletes and counts only the project items', async () => {
    expect(await db.deleteMemoryItems(STORE, { projectId: 'proj-a' })).toBe(1);
    expect(await db.countMemoryItems(STORE, 'proj-a')).toBe(0);
    expect(await db.countMemoryItems(STORE, 'proj-b')).toBe(1);
  });

  it('loads items by vector id within the project', async () => {
    await db.createMemoryItem(item('proj-a', 'vec-a2'));
    const found = await db.findMemoryItemsByVectorIds(STORE, ['vec-a1', 'vec-a2', 'vec-b1', 'vec-missing'], 'proj-a');
    expect(found.map((row) => row.vectorId).sort()).toEqual(['vec-a1', 'vec-a2']);
    expect(await db.findMemoryItemsByVectorIds(STORE, [], 'proj-a')).toEqual([]);
  });

  it('leaves expired items out when asked', async () => {
    const now = new Date();
    await db.createMemoryItem(item('proj-a', 'vec-old', { expiresAt: new Date(now.getTime() - 60_000) }));
    await db.createMemoryItem(item('proj-a', 'vec-later', { expiresAt: new Date(now.getTime() + 60_000) }));

    const all = await db.listMemoryItems(STORE, { projectId: 'proj-a' });
    expect(all.items.map((row) => row.vectorId).sort()).toEqual(['vec-a1', 'vec-later', 'vec-old']);

    const live = await db.listMemoryItems(STORE, { projectId: 'proj-a', notExpiredAt: now });
    expect(live.items.map((row) => row.vectorId).sort()).toEqual(['vec-a1', 'vec-later']);
    expect(live.total).toBe(2);
  });
});
