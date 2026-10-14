/**
 * The bounds of the principal cache (src/lib/iam/principalCache.ts), with an
 * in-memory stand-in for the database: a full cache sweeps what has expired
 * before it evicts anything that is still live, a load in flight is never swept,
 * and the cold load of a user in several groups is a handful of reads however
 * many groups there are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first decision of a file loads the Cedar WASM module and builds the schema; on a busy machine the default 5 s is too tight.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Record<string, ReturnType<typeof import('vitest').vi.fn>>,
  hang: null as null | Promise<never>,
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return { ...actual, runWithTenantScope: async (_tenant: string, fn: (db: unknown) => unknown) => fn(hoisted.db) };
});

import { PRINCIPAL_CACHE_TTL_MS, getPrincipalCacheStats, getPrincipalContext, resetPrincipalCacheForTests } from '@/lib/iam/principalCache';

const TENANT = 'tenant_cache';
const load = (userId: string, extra: { withProjects?: boolean; tenant?: string } = {}) =>
  getPrincipalContext({ tenantDbName: extra.tenant ?? TENANT, tenantId: 't1', userId, withProjects: extra.withProjects });
const MAX_ENTRIES = 5_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T10:00:00.000Z'));
  hoisted.hang = null;
  hoisted.db = {
    findUserById: vi.fn(async (id: string) => (hoisted.hang && id === 'slow' ? hoisted.hang : { _id: id, role: 'user' })),
    listGroupMembersByUser: vi.fn(async () => []),
    iamListGroups: vi.fn(async () => ({ items: [], hasMore: false })),
    findGroupById: vi.fn(async () => null),
    listUserProjectsByUser: vi.fn(async () => []),
    listGroupProjectsByGroup: vi.fn(async () => []),
    listProjects: vi.fn(async () => []),
  } as never;
  resetPrincipalCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a full cache', () => {
  it('sweeps what has expired before it evicts anything that is still live', async () => {
    for (let i = 0; i < 3_000; i++) await load(`old-${i}`);
    vi.setSystemTime(Date.now() + PRINCIPAL_CACHE_TTL_MS + 1_000);
    for (let i = 0; i < MAX_ENTRIES - 3_000; i++) await load(`live-${i}`);
    expect(getPrincipalCacheStats().entries).toBe(MAX_ENTRIES);

    await load('one-more');
    // the 3,000 expired entries went; not one live entry was pushed out for the newcomer
    expect(getPrincipalCacheStats().entries).toBe(MAX_ENTRIES - 3_000 + 1);
    const loads = getPrincipalCacheStats().loads;
    for (let i = 0; i < MAX_ENTRIES - 3_000; i += 97) await load(`live-${i}`);
    await load('one-more');
    expect(getPrincipalCacheStats().loads).toBe(loads); // all still cached
  }, 60_000);

  it('when every entry is live it makes room by dropping the oldest, and never grows past its cap', async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) await load(`u-${i}`);
    expect(getPrincipalCacheStats().entries).toBe(MAX_ENTRIES);
    for (let i = 0; i < 50; i++) await load(`newer-${i}`);
    expect(getPrincipalCacheStats().entries).toBe(MAX_ENTRIES);
    const loads = getPrincipalCacheStats().loads;
    await load('newer-49'); // newest: still there
    expect(getPrincipalCacheStats().loads).toBe(loads);
    await load('u-0'); // oldest: gone, loaded again
    expect(getPrincipalCacheStats().loads).toBe(loads + 1);
  }, 60_000);

  it('never sweeps a load that is still in flight, however long it has been running', async () => {
    let release!: (value: never) => void;
    hoisted.hang = new Promise<never>((resolve) => { release = resolve; });
    const slow = load('slow'); // never answers until released
    for (let i = 0; i < MAX_ENTRIES - 1; i++) await load(`u-${i}`);
    vi.setSystemTime(Date.now() + PRINCIPAL_CACHE_TTL_MS + 5_000);
    await load('trigger'); // the cache is full of expired entries: they are swept
    // the slow load is still the one entry that was kept
    expect(getPrincipalCacheStats().entries).toBe(2);
    release({ _id: 'slow', role: 'user' } as never);
    expect((await slow).userId).toBe('slow');
  }, 60_000);

  it('keeps tenants apart: the same user id in two workspaces is two entries', async () => {
    await load('shared');
    await load('shared', { tenant: 'tenant_other' });
    expect(getPrincipalCacheStats().entries).toBe(2);
    expect((hoisted.db.findUserById as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});

describe('the cold load of a user in several groups', () => {
  const groups = (n: number) => Array.from({ length: n }, (_, i) => `g${i}`);

  beforeEach(() => {
    hoisted.db.listGroupMembersByUser = vi.fn(async () => groups(7).map((groupId) => ({ groupId, userId: 'u', role: 'member' })));
    hoisted.db.iamListGroups = vi.fn(async (query: { ids: string[] }) => ({
      items: query.ids.map((id) => ({ _id: id, name: id, ...(id === 'g2' ? { tenantRole: 'admin' } : {}) })),
      hasMore: false,
    }));
    hoisted.db.listGroupProjectsByGroup = vi.fn(async (groupId: string) => (groupId === 'g1' ? [{ projectId: 'pg', role: 'project_admin', servicePermissions: {}, groupId }] : []));
    hoisted.db.listUserProjectsByUser = vi.fn(async () => [{ projectId: 'pd', role: 'member', servicePermissions: { agents: 'read' }, updatedAt: new Date() }]);
  });

  it('is the user once, the memberships once, ONE group query, the direct rows once and each group\'s rows once', async () => {
    const ctx = await load('u', { withProjects: true });
    const calls = (name: string) => (hoisted.db[name] as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls('findUserById')).toBe(1);
    expect(calls('listGroupMembersByUser')).toBe(1);
    expect(calls('iamListGroups')).toBe(1);
    expect(calls('findGroupById')).toBe(0);
    expect(calls('listUserProjectsByUser')).toBe(1);
    expect(calls('listGroupProjectsByGroup')).toBe(7);
    expect(ctx.groupIds).toEqual(groups(7));
    expect(ctx.groupGrants).toEqual([expect.objectContaining({ tenantRole: 'admin' })]);
    expect(ctx.projects?.sort()).toEqual(['pd', 'pg']);
    expect(ctx.adminProjects).toEqual(['pg']);
    expect(ctx.userProjects).toEqual([expect.objectContaining({ projectId: 'pd', role: 'member', servicePermissions: { agents: 'read' } })]);
    expect(ctx.groupProjects).toEqual([expect.objectContaining({ projectId: 'pg', groupId: 'g1', role: 'project_admin' })]);
  });

  it('a user the caller already loaded, with the groups it already has, costs only the project reads', async () => {
    const listGroups = hoisted.db.iamListGroups as unknown as (query: unknown) => Promise<{ items: never[] }>;
    const given = (await listGroups({ ids: groups(2) })).items;
    (hoisted.db.iamListGroups as ReturnType<typeof vi.fn>).mockClear();
    await getPrincipalContext({
      tenantDbName: TENANT, tenantId: 't1', userId: 'u2', withProjects: true, user: { role: 'user' }, groups: given,
    });
    const calls = (name: string) => (hoisted.db[name] as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls('findUserById')).toBe(0);
    expect(calls('listGroupMembersByUser')).toBe(0);
    expect(calls('iamListGroups')).toBe(0);
    expect(calls('listUserProjectsByUser')).toBe(1);
    expect(calls('listGroupProjectsByGroup')).toBe(2);
  });
});
