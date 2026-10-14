/**
 * The moment a workspace's project-level permissions started counting in full
 * (src/lib/iam/projectLevels.ts), on BOTH backends: one small document in
 * `iam_meta`, created by the first evaluation of a workspace, read back so every
 * node settles on the same value, cached for good, and never guessed when the
 * store cannot answer. Nothing is migrated and nothing is created for a workspace
 * that is never evaluated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import type { DatabaseProvider } from '@/lib/database';
import {
  PROJECT_LEVELS_DOC_ID,
  getProjectLevelsSince,
  primeProjectLevelsForTests,
  resetProjectLevelsForTests,
} from '@/lib/iam/projectLevels';
import { describeForEachProvider } from './db-parity.helper';

describe('the document', () => {
  it('has a fixed id inside iam_meta', () => {
    expect(PROJECT_LEVELS_DOC_ID).toBe('project_levels_since');
  });
});

describeForEachProvider('Project-levels moment', (getDb) => {
  let db: DatabaseProvider;
  let tenant: string;
  const stored = () => db.runWithTenant!(tenant, () => db.iamDocGet('iam_meta', PROJECT_LEVELS_DOC_ID));

  beforeEach(() => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    tenant = `tenant_pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    resetProjectLevelsForTests();
  });

  it('is created by the first call, as an ISO date, and is "now"', async () => {
    expect(await stored()).toBeNull();
    const before = Date.now();
    const since = await getProjectLevelsSince(tenant);
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(Date.now());
    const doc = await stored();
    expect(doc?.data).toEqual({ since: new Date(since).toISOString() });
  });

  it('is cached after that: later calls read nothing', async () => {
    const since = await getProjectLevelsSince(tenant);
    const get = vi.spyOn(db, 'iamDocGet');
    const put = vi.spyOn(db, 'iamDocPut');
    for (let i = 0; i < 5; i++) expect(await getProjectLevelsSince(tenant)).toBe(since);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('survives a restart or another node: the stored value is read, never rewritten', async () => {
    const since = await getProjectLevelsSince(tenant);
    resetProjectLevelsForTests(); // another process
    const put = vi.spyOn(db, 'iamDocPut');
    expect(await getProjectLevelsSince(tenant)).toBe(since);
    expect(put).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('concurrent first calls share one creation', async () => {
    const put = vi.spyOn(db, 'iamDocPut');
    const values = await Promise.all(Array.from({ length: 12 }, () => getProjectLevelsSince(tenant)));
    expect(new Set(values).size).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it('when two nodes race on the very first evaluation, both settle on the value that was stored last', async () => {
    // Node B writes its moment between node A's write and A's read-back.
    const original = db.iamDocPut.bind(db);
    const later = Date.now() + 60_000;
    let raced = false;
    vi.spyOn(db, 'iamDocPut').mockImplementation(async (...args: Parameters<typeof original>) => {
      const out = await original(...args);
      if (!raced) {
        raced = true;
        await original('iam_meta', PROJECT_LEVELS_DOC_ID, { since: new Date(later).toISOString() });
      }
      return out;
    });
    expect(await getProjectLevelsSince(tenant)).toBe(later);
    vi.restoreAllMocks();
    resetProjectLevelsForTests();
    expect(await getProjectLevelsSince(tenant)).toBe(later);
  });

  it('is per workspace', async () => {
    const a = await getProjectLevelsSince(tenant);
    await new Promise((r) => setTimeout(r, 5));
    const other = `${tenant}_other`;
    const b = await getProjectLevelsSince(other);
    expect(b).toBeGreaterThan(a);
    expect(await getProjectLevelsSince(tenant)).toBe(a);
  });

  it('a stored value that is not a usable date is treated as absent and replaced', async () => {
    for (const garbage of [{ since: 12345 }, { since: 'not a date' }, { other: true }, {}]) {
      resetProjectLevelsForTests();
      await db.runWithTenant!(tenant, () => db.iamDocPut('iam_meta', PROJECT_LEVELS_DOC_ID, garbage));
      const since = await getProjectLevelsSince(tenant);
      expect(Number.isFinite(since), JSON.stringify(garbage)).toBe(true);
      expect(typeof (await stored())?.data.since, JSON.stringify(garbage)).toBe('string');
      expect(Date.parse(String((await stored())?.data.since))).toBe(since);
    }
  });

  it('is never guessed: when the store cannot be read or written the call fails, nothing is cached, and it recovers', async () => {
    vi.spyOn(db, 'iamDocGet').mockRejectedValue(new Error('store down'));
    await expect(getProjectLevelsSince(tenant)).rejects.toThrow('store down');
    vi.restoreAllMocks();

    vi.spyOn(db, 'iamDocPut').mockRejectedValue(new Error('cannot write'));
    await expect(getProjectLevelsSince(tenant)).rejects.toThrow('cannot write');
    expect(await stored()).toBeNull();
    vi.restoreAllMocks();

    const since = await getProjectLevelsSince(tenant);
    expect(Number.isFinite(since)).toBe(true);
    expect(await stored()).not.toBeNull();
  });

  it('can be pinned for a test and reset again', async () => {
    primeProjectLevelsForTests(tenant, 42);
    expect(await getProjectLevelsSince(tenant)).toBe(42);
    expect(await stored()).toBeNull(); // pinning writes nothing
    resetProjectLevelsForTests();
    expect(await getProjectLevelsSince(tenant)).toBeGreaterThan(42);
  });
});
