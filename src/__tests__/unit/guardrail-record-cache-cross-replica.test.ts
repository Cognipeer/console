/**
 * Saving a guardrail or PII policy reaches every replica, not just the one that
 * wrote it. Two module instances stand in for two replicas; they share one fake
 * shared cache (the stand-in for Redis) and one fake database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  findGuardrailByKey: vi.fn(),
  findPiiPolicyByKey: vi.fn(),
  shared: new Map<string, unknown>(),
  sharedFails: { get: false, set: false },
}));

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => ({})),
  runWithTenantScope: vi.fn(async (_tenant: string, fn: (db: unknown) => unknown) => fn({
    findGuardrailByKey: hoisted.findGuardrailByKey,
    findPiiPolicyByKey: hoisted.findPiiPolicyByKey,
  })),
}));

vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({
    get: vi.fn(async (key: string) => {
      if (hoisted.sharedFails.get) throw new Error('redis down');
      return hoisted.shared.get(key);
    }),
    set: vi.fn(async (key: string, value: unknown) => {
      if (hoisted.sharedFails.set) throw new Error('redis down');
      hoisted.shared.set(key, value);
    }),
  })),
}));

type RecordCacheModule = typeof import('@/lib/services/guardrail/hooks/recordCache');

const TENANT = 'tenant_a';
const row = (mode: string) => ({ key: 'g1', mode }) as never;

/** A fresh module instance: its own local caches, the same shared cache. */
async function newReplica(): Promise<RecordCacheModule> {
  vi.resetModules();
  return import('@/lib/services/guardrail/hooks/recordCache');
}

/** Lets the fire-and-forget publish settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('guardrail record cache across replicas', () => {
  let writer: RecordCacheModule;
  let reader: RecordCacheModule;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
    hoisted.shared.clear();
    hoisted.sharedFails.get = false;
    hoisted.sharedFails.set = false;
    hoisted.findGuardrailByKey.mockReset();
    hoisted.findPiiPolicyByKey.mockReset();
    hoisted.findGuardrailByKey.mockResolvedValue(row('block'));
    writer = await newReplica();
    reader = await newReplica();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('another replica serves the old record until its next look, then reloads after a save', async () => {
    expect((await reader.getCachedGuardrail(TENANT, 'g1', 'p1'))?.mode).toBe('block');
    hoisted.findGuardrailByKey.mockResolvedValue(row('monitor'));

    writer.invalidateGuardrailCache(TENANT, 'g1');
    await settle();

    // Inside the check interval the reader does not even ask the shared cache.
    vi.setSystemTime(Date.now() + reader.RECORD_GENERATION_CHECK_MS - 100);
    expect((await reader.getCachedGuardrail(TENANT, 'g1', 'p1'))?.mode).toBe('block');

    vi.setSystemTime(Date.now() + 200);
    expect((await reader.getCachedGuardrail(TENANT, 'g1', 'p1'))?.mode).toBe('monitor');
  });

  it('a save by a replica that never saw the tenant still reaches readers, for PII policies too', async () => {
    hoisted.findPiiPolicyByKey.mockResolvedValue({ key: 'pol', enabled: true });
    expect((await reader.getCachedPiiPolicy(TENANT, 'pol', 'p1'))?.enabled).toBe(true);
    hoisted.findPiiPolicyByKey.mockResolvedValue({ key: 'pol', enabled: false });

    writer.invalidatePiiPolicyCache(TENANT, 'pol');
    await settle();
    vi.setSystemTime(Date.now() + reader.RECORD_GENERATION_CHECK_MS + 1);

    expect((await reader.getCachedPiiPolicy(TENANT, 'pol', 'p1'))?.enabled).toBe(false);
  });

  it('keeps hits local: no shared-cache read per lookup inside the interval, and no reload without a save', async () => {
    await reader.getCachedGuardrail(TENANT, 'g1', 'p1');
    await reader.getCachedGuardrail(TENANT, 'g1', 'p1');
    vi.setSystemTime(Date.now() + reader.RECORD_GENERATION_CHECK_MS + 1);
    await reader.getCachedGuardrail(TENANT, 'g1', 'p1');
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(1);
  });

  it('does not drop its own fresh entries again after it published a save', async () => {
    await writer.getCachedGuardrail(TENANT, 'g1', 'p1');
    writer.invalidateGuardrailCache(TENANT, 'g1');
    await settle();
    await writer.getCachedGuardrail(TENANT, 'g1', 'p1');
    vi.setSystemTime(Date.now() + writer.RECORD_GENERATION_CHECK_MS + 1);
    await writer.getCachedGuardrail(TENANT, 'g1', 'p1');
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(2);
  });

  it('other tenants are untouched by a save', async () => {
    await reader.getCachedGuardrail('tenant_b', 'g1', 'p1');
    writer.invalidateGuardrailCache(TENANT, 'g1');
    await settle();
    vi.setSystemTime(Date.now() + reader.RECORD_GENERATION_CHECK_MS + 1);
    await reader.getCachedGuardrail('tenant_b', 'g1', 'p1');
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(1);
  });

  it('falls back to the TTL when the shared cache fails, without throwing', async () => {
    hoisted.sharedFails.get = true;
    hoisted.sharedFails.set = true;
    expect((await reader.getCachedGuardrail(TENANT, 'g1', 'p1'))?.mode).toBe('block');
    expect(() => writer.invalidateGuardrailCache(TENANT, 'g1')).not.toThrow();
    await settle();
    hoisted.findGuardrailByKey.mockResolvedValue(row('monitor'));
    vi.setSystemTime(Date.now() + reader.RECORD_GENERATION_CHECK_MS + 1);
    expect((await reader.getCachedGuardrail(TENANT, 'g1', 'p1'))?.mode).toBe('block');
    vi.setSystemTime(Date.now() + reader.RECORD_CACHE_TTL_MS + 1);
    expect((await reader.getCachedGuardrail(TENANT, 'g1', 'p1'))?.mode).toBe('monitor');
  });

  it('resetRecordCaches clears the local entries', async () => {
    await reader.getCachedGuardrail(TENANT, 'g1', 'p1');
    reader.resetRecordCaches();
    await reader.getCachedGuardrail(TENANT, 'g1', 'p1');
    expect(hoisted.findGuardrailByKey).toHaveBeenCalledTimes(2);
  });
});
