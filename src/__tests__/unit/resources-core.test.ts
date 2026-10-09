import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: {
    listProjects: vi.fn(),
    listUsers: vi.fn(),
  },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
// The community providers have their own tests; the service tests register
// their own fixture types.
vi.mock('@/lib/resources/providers', () => ({
  ensureCommunityResourceTypesRegistered: vi.fn(),
}));

import { buildCrn, parseCrn } from '@/lib/resources/crn';
import {
  getResourceTypeDefinition,
  listResourceTypeDefinitions,
  registerResourceTypes,
  resetResourceRegistryForTests,
} from '@/lib/resources/registry';
import {
  CACHE_MAX_TENANTS,
  CACHE_MAX_TOTAL_RECORDS,
  MIN_REFRESH_INTERVAL_MS,
  CACHE_TTL_MS,
  PROVIDER_TIMEOUT_MS,
  ResourceQueryError,
  SOFT_CAP_PER_TYPE,
  clearResourceCache,
  getResource,
  listResources,
} from '@/lib/resources/service';
import type { ResourceRecord, ResourceTypeDefinition } from '@/lib/resources/types';

function rec(over: Partial<ResourceRecord> & { type: string; id: string }): ResourceRecord {
  return {
    key: null,
    name: over.id,
    description: null,
    projectId: null,
    status: null,
    statusTone: 'neutral',
    createdBy: null,
    updatedBy: null,
    createdAt: null,
    updatedAt: null,
    attributes: [],
    ...over,
  };
}

function def(type: string, list: ResourceTypeDefinition['list'], extra: Partial<ResourceTypeDefinition> = {}): ResourceTypeDefinition {
  return { type, service: 'agents', category: 'agents', scope: 'project', edition: 'community', list, ...extra };
}

const base = { tenantDbName: 'tenant_acme', tenantId: 't1' };

describe('crn', () => {
  it('round-trips project and tenant-wide CRNs', () => {
    const crn = buildCrn({ tenantId: 't1', projectId: 'p1', type: 'agent', id: 'a1' });
    expect(crn).toBe('crn:cpr:t1:p1:agent/a1');
    expect(parseCrn(crn)).toEqual({ tenantId: 't1', projectId: 'p1', type: 'agent', id: 'a1' });

    const wide = buildCrn({ tenantId: 't1', projectId: null, type: 'tool', id: 'x' });
    expect(wide).toBe('crn:cpr:t1:-:tool/x');
    expect(parseCrn(wide)).toEqual({ tenantId: 't1', projectId: null, type: 'tool', id: 'x' });
  });

  it('keeps an id that contains ":" or "/" intact', () => {
    const crn = buildCrn({ tenantId: 't1', projectId: 'p1', type: 'file-bucket', id: 'a:b/c' });
    expect(parseCrn(crn)?.id).toBe('a:b/c');
  });

  it('returns null for malformed input', () => {
    for (const bad of ['', 'crn:cpr:', 'crn:cpr:t1', 'crn:cpr:t1:p1', 'crn:cpr:t1:p1:agent', 'crn:cpr:t1:p1:agent/', 'arn:aws:x', null, 42]) {
      expect(parseCrn(bad)).toBeNull();
    }
  });
});

describe('registry', () => {
  beforeEach(() => resetResourceRegistryForTests());

  it('registers and looks up types', () => {
    registerResourceTypes([def('a', async () => [])]);
    expect(getResourceTypeDefinition('a')?.type).toBe('a');
    expect(listResourceTypeDefinitions()).toHaveLength(1);
    expect(getResourceTypeDefinition('nope')).toBeUndefined();
  });

  it('throws on a duplicate type id and registers nothing from the failing batch', () => {
    registerResourceTypes([def('a', async () => [])]);
    expect(() => registerResourceTypes([def('b', async () => []), def('a', async () => [])])).toThrow(/already registered/);
    expect(getResourceTypeDefinition('b')).toBeUndefined();
    expect(() => registerResourceTypes([def('c', async () => []), def('c', async () => [])])).toThrow(/already registered/);
  });
});

describe('resource service', () => {
  beforeEach(() => {
    resetResourceRegistryForTests();
    clearResourceCache();
    h.db.listProjects.mockReset().mockResolvedValue([
      { _id: 'p1', name: 'Alpha' },
      { _id: 'p2', name: 'Beta' },
    ]);
    h.db.listUsers.mockReset().mockResolvedValue([
      { _id: 'u1', email: 'ann@x.io', name: 'Ann' },
      { _id: 'u2', email: '', name: 'Bob' },
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isolates a failing provider and keeps the others', async () => {
    registerResourceTypes([
      def('good', async () => [rec({ type: 'good', id: '1' })]),
      def('bad', async () => {
        throw new Error('mongodb://user:secret@host/db exploded');
      }),
    ]);
    const res = await listResources(base);
    expect(res.items.map((i) => i.id)).toEqual(['1']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].type).toBe('bad');
    expect(JSON.stringify(res.errors)).not.toMatch(/secret|mongodb/);
    expect(res.counts).toEqual({ good: 1, bad: 0 });
  });

  it('times a slow provider out after 10s without blocking the others', async () => {
    vi.useFakeTimers();
    registerResourceTypes([
      def('good', async () => [rec({ type: 'good', id: '1' })]),
      def('slow', () => new Promise<ResourceRecord[]>(() => undefined)),
    ]);
    const pending = listResources(base);
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.items).toHaveLength(1);
    expect(res.errors).toEqual([{ type: 'slow', message: expect.stringMatching(/timed out/i) }]);
  });

  it('keeps the newest 5000 rows per type and reports truncation', async () => {
    const rows = Array.from({ length: SOFT_CAP_PER_TYPE + 10 }, (_, i) =>
      rec({ type: 'big', id: String(i), updatedAt: new Date(1_700_000_000_000 + i * 1000).toISOString() }),
    );
    registerResourceTypes([def('big', async () => rows)]);
    const res = await listResources({ ...base, limit: 200 });
    expect(res.total).toBe(SOFT_CAP_PER_TYPE);
    expect(res.truncated).toEqual([{ type: 'big', limit: SOFT_CAP_PER_TYPE }]);
    // newest first, and the 10 oldest are the ones dropped
    expect(res.items[0].id).toBe(String(SOFT_CAP_PER_TYPE + 9));
    const all = await listResources({ ...base, limit: 200, offset: SOFT_CAP_PER_TYPE - 1 });
    expect(all.items.map((i) => i.id)).toEqual(['10']);
  });

  it('drops a record that claims another tenant', async () => {
    registerResourceTypes([
      def('x', async () => [
        rec({ type: 'x', id: 'mine', tenantId: 't1' }),
        rec({ type: 'x', id: 'untagged' }),
        rec({ type: 'x', id: 'foreign', tenantId: 'other' }),
      ]),
    ]);
    const res = await listResources(base);
    expect(res.items.map((i) => i.id).sort()).toEqual(['mine', 'untagged']);
    expect(await getResource({ ...base, type: 'x', id: 'foreign' })).toBeNull();
  });

  it('caches mapped records per tenant and refresh bypasses and repopulates', async () => {
    const list = vi.fn(async () => [rec({ type: 'x', id: '1' })]);
    registerResourceTypes([def('x', list)]);
    await listResources(base);
    await listResources({ ...base, q: 'anything' });
    expect(list).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + MIN_REFRESH_INTERVAL_MS + 1);
    await listResources({ ...base, refresh: true });
    expect(list).toHaveBeenCalledTimes(2);
    await listResources(base);
    expect(list).toHaveBeenCalledTimes(2);

    // another tenant has its own entry
    await listResources({ tenantDbName: 'tenant_other', tenantId: 't2' });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it('rate-limits refresh=1 per tenant and joins a build already running', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const list = vi.fn(async () => {
      await gate;
      return [rec({ type: 'x', id: '1' })];
    });
    registerResourceTypes([def('x', list)]);
    // Three parallel callers, two of them asking for a refresh: ONE build.
    const calls = Promise.all([
      listResources(base),
      listResources({ ...base, refresh: true }),
      listResources({ ...base, refresh: true }),
    ]);
    release?.();
    await calls;
    expect(list).toHaveBeenCalledTimes(1);
    // A snapshot younger than the minimum interval is served even with refresh=1.
    await listResources({ ...base, refresh: true });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache by total record count, keeping the newest entry', async () => {
    // Each type is soft-capped, so spread the rows over enough types for one
    // tenant to hold ~60% of the bound.
    const typeCount = Math.ceil((CACHE_MAX_TOTAL_RECORDS * 0.6) / SOFT_CAP_PER_TYPE);
    const rows = Array.from({ length: SOFT_CAP_PER_TYPE }, (_, i) => rec({ type: 't', id: String(i) }));
    const list = vi.fn(async () => rows);
    registerResourceTypes(Array.from({ length: typeCount }, (_, i) => def(`t${i}`, list)));
    await listResources({ tenantDbName: 'db_a', tenantId: 'ta' });
    await listResources({ tenantDbName: 'db_b', tenantId: 'tb' }); // pushes the total over the bound
    expect(list).toHaveBeenCalledTimes(typeCount * 2);
    await listResources({ tenantDbName: 'db_b', tenantId: 'tb' }); // newest stays cached
    expect(list).toHaveBeenCalledTimes(typeCount * 2);
    await listResources({ tenantDbName: 'db_a', tenantId: 'ta' }); // oldest was evicted
    expect(list).toHaveBeenCalledTimes(typeCount * 3);
  });

  it('clips very long names and descriptions', async () => {
    registerResourceTypes([
      def('x', async () => [rec({ type: 'x', id: '1', name: 'n'.repeat(1000), description: 'd'.repeat(5000) })]),
    ]);
    const res = await listResources(base);
    expect(res.items[0].name.length).toBeLessThan(250);
    expect(res.items[0].description!.length).toBeLessThan(550);
  });

  it('ranks rows without updatedAt by createdAt, like the soft cap does', async () => {
    registerResourceTypes([
      def('x', async () => [
        rec({ type: 'x', id: 'old', createdAt: '2020-01-01T00:00:00.000Z' }),
        rec({ type: 'x', id: 'new', createdAt: '2024-01-01T00:00:00.000Z' }),
      ]),
    ]);
    expect((await listResources(base)).items.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('expires the cache after the TTL', async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => [rec({ type: 'x', id: '1' })]);
    registerResourceTypes([def('x', list)]);
    await listResources(base);
    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1);
    await listResources(base);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('holds at most 50 tenants (least recently used evicted)', async () => {
    const list = vi.fn(async () => []);
    registerResourceTypes([def('x', list)]);
    for (let i = 0; i < CACHE_MAX_TENANTS + 1; i++) {
      await listResources({ tenantDbName: `db_${i}`, tenantId: `t${i}` });
    }
    expect(list).toHaveBeenCalledTimes(CACHE_MAX_TENANTS + 1);
    await listResources({ tenantDbName: 'db_1', tenantId: 't1' }); // still cached
    expect(list).toHaveBeenCalledTimes(CACHE_MAX_TENANTS + 1);
    await listResources({ tenantDbName: 'db_0', tenantId: 't0' }); // evicted
    expect(list).toHaveBeenCalledTimes(CACHE_MAX_TENANTS + 2);
  });

  describe('filters, facets, sorting, pagination', () => {
    beforeEach(() => {
      registerResourceTypes([
        def('agent', async () => [
          rec({ type: 'agent', id: 'a1', key: 'sales-bot', name: 'Sales bot', projectId: 'p1', status: 'active', statusTone: 'ok', updatedAt: '2026-01-03T00:00:00.000Z', createdBy: 'u1' }),
          rec({ type: 'agent', id: 'a2', name: 'Draft helper', description: 'Handles SALES drafts', projectId: 'p2', status: 'draft', statusTone: 'off', updatedAt: '2026-01-02T00:00:00.000Z' }),
        ]),
        def('tool', async () => [
          rec({ type: 'tool', id: 't1', name: 'Zeta', projectId: null, status: 'active', statusTone: 'ok', updatedAt: '2026-01-03T00:00:00.000Z' }),
          rec({ type: 'tool', id: 't2', name: 'Alpha', projectId: 'p1', status: 'disabled', statusTone: 'off', updatedAt: '2026-01-03T00:00:00.000Z', createdBy: 'u2' }),
        ]),
      ]);
    });

    it('sorts by updatedAt desc then name', async () => {
      const res = await listResources(base);
      // 2026-01-03: Alpha(t2) < Sales bot(a1) < Zeta(t1); then 2026-01-02: a2
      expect(res.items.map((i) => i.id)).toEqual(['t2', 'a1', 't1', 'a2']);
    });

    it('matches a record assigned to several projects on any of them', async () => {
      registerResourceTypes([
        def('x', async () => [rec({ type: 'x', id: 'multi', projectId: 'p1', projectIds: ['p1', 'p2'] })]),
      ]);
      expect((await listResources({ ...base, type: 'x', projectId: 'p2' })).items.map((i) => i.id)).toEqual(['multi']);
      expect((await listResources({ ...base, projectId: 'p2' })).counts.x).toBe(1);
      expect((await listResources({ ...base, type: 'x', projectId: 'tenant' })).total).toBe(0);
    });

    it('filters by project (exact, and "tenant" = tenant-wide only)', async () => {
      expect((await listResources({ ...base, projectId: 'p1' })).items.map((i) => i.id).sort()).toEqual(['a1', 't2']);
      expect((await listResources({ ...base, projectId: 'tenant' })).items.map((i) => i.id)).toEqual(['t1']);
    });

    it('q matches name/key/description/id case-insensitively', async () => {
      expect((await listResources({ ...base, q: 'sales' })).items.map((i) => i.id).sort()).toEqual(['a1', 'a2']);
      expect((await listResources({ ...base, q: 'SALES-BOT' })).items.map((i) => i.id)).toEqual(['a1']);
      expect((await listResources({ ...base, q: 'T2' })).items.map((i) => i.id)).toEqual(['t2']);
    });

    it('status filter is exact on the raw status', async () => {
      expect((await listResources({ ...base, status: 'draft' })).items.map((i) => i.id)).toEqual(['a2']);
    });

    it('facet counts apply project/q/status filters but NOT the type filter', async () => {
      const res = await listResources({ ...base, type: 'tool', projectId: 'p1' });
      expect(res.counts).toEqual({ agent: 1, tool: 1 });
      expect(res.total).toBe(1);
      expect(res.items.map((i) => i.id)).toEqual(['t2']);

      const byStatus = await listResources({ ...base, status: 'active', type: 'agent' });
      expect(byStatus.counts).toEqual({ agent: 1, tool: 1 });
      expect(byStatus.total).toBe(1);
    });

    it('statuses reflect project/q/type but not the status filter', async () => {
      const res = await listResources({ ...base, type: 'tool', status: 'active' });
      expect(res.statuses).toEqual(['active', 'disabled']);
    });

    it('paginates with limit/offset and reports the unpaginated total', async () => {
      const first = await listResources({ ...base, limit: 3, offset: 0 });
      const second = await listResources({ ...base, limit: 3, offset: 3 });
      expect(first.total).toBe(4);
      expect(first.items).toHaveLength(3);
      expect(second.items).toHaveLength(1);
      expect([...first.items, ...second.items].map((i) => i.id)).toEqual(['t2', 'a1', 't1', 'a2']);
    });

    it('accepts an oversized limit (clamped to 200 by the service)', async () => {
      const res = await listResources({ ...base, limit: 9999 });
      expect(res.items).toHaveLength(4);
    });

    it('rejects an unknown type id', async () => {
      await expect(listResources({ ...base, type: 'nope' })).rejects.toBeInstanceOf(ResourceQueryError);
    });

    it('enriches rows with project name, owner label and a CRN', async () => {
      const res = await listResources({ ...base, q: 'sales-bot' });
      expect(res.items[0]).toMatchObject({
        projectName: 'Alpha',
        createdByLabel: 'ann@x.io',
        crn: 'crn:cpr:t1:p1:agent/a1',
      });
      const wide = (await listResources({ ...base, projectId: 'tenant' })).items[0];
      expect(wide).toMatchObject({ projectId: null, projectName: null, crn: 'crn:cpr:t1:-:tool/t1' });
      // email missing -> falls back to name
      const bob = (await listResources({ ...base, q: 'Alpha' })).items.find((i) => i.id === 't2');
      expect(bob?.createdByLabel).toBe('Bob');
    });

    it('does exactly one projects read and one users read per load, however many rows', async () => {
      await listResources(base);
      await listResources({ ...base, q: 'a' });
      expect(h.db.listProjects).toHaveBeenCalledTimes(1);
      expect(h.db.listUsers).toHaveBeenCalledTimes(1);
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + MIN_REFRESH_INTERVAL_MS + 1);
      await listResources({ ...base, refresh: true });
      expect(h.db.listProjects).toHaveBeenCalledTimes(2);
      expect(h.db.listUsers).toHaveBeenCalledTimes(2);
    });
  });

  describe('getResource', () => {
    it('finds a record via list() by default and returns the detail shape', async () => {
      registerResourceTypes([
        def('x', async () => [rec({ type: 'x', id: '1', projectId: 'p1', updatedBy: 'u1', attributes: [{ key: 'k', value: 1 }] })], {
          detailUrl: (r) => `/dashboard/x/${r.id}`,
        }),
      ]);
      const detail = await getResource({ ...base, type: 'x', id: '1' });
      expect(detail).toMatchObject({
        id: '1',
        updatedBy: 'u1',
        updatedByLabel: 'ann@x.io',
        projectName: 'Alpha',
        detailUrl: '/dashboard/x/1',
        attributes: [{ key: 'k', value: 1 }],
      });
      expect(await getResource({ ...base, type: 'x', id: 'missing' })).toBeNull();
      expect(await getResource({ ...base, type: 'unknown', id: '1' })).toBeNull();
    });

    it('falls through to the provider when a warm cache does not hold the id', async () => {
      const rows = [rec({ type: 'x', id: '1' })];
      registerResourceTypes([def('x', async () => rows)]);
      await listResources(base); // warm cache without id "2"
      rows.push(rec({ type: 'x', id: '2' })); // created after the snapshot
      expect((await getResource({ ...base, type: 'x', id: '2' }))?.id).toBe('2');
      expect(await getResource({ ...base, type: 'x', id: 'nope' })).toBeNull();
    });

    it('shares one provider read between concurrent identical detail requests and skips users for a 404', async () => {
      const list = vi.fn(async () => [rec({ type: 'x', id: '1' })]);
      registerResourceTypes([def('x', list)]);
      await Promise.all([1, 2, 3].map(() => getResource({ ...base, type: 'x', id: '1' })));
      expect(list).toHaveBeenCalledTimes(1);
      expect(h.db.listUsers).toHaveBeenCalledTimes(1);
      h.db.listUsers.mockClear();
      expect(await getResource({ ...base, type: 'x', id: 'missing' })).toBeNull();
      expect(h.db.listUsers).not.toHaveBeenCalled();
    });

    it('prefers a type-specific get() when the cache is cold', async () => {
      const get = vi.fn(async () => rec({ type: 'x', id: '9' }));
      const list = vi.fn(async () => []);
      registerResourceTypes([def('x', list, { get })]);
      expect((await getResource({ ...base, type: 'x', id: '9' }))?.id).toBe('9');
      expect(get).toHaveBeenCalledTimes(1);
      expect(list).not.toHaveBeenCalled();
    });
  });
});
