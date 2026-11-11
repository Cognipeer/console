import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  plan: { tenantId: 't1', mode: 'on', limits: null } as any,
  db: {
    sumFileRecordBytes: vi.fn(async () => 0),
    sumVectorIndexStoredBytes: vi.fn(async () => 0),
    iamCountUsers: vi.fn(async (_f: unknown) => 0),
  },
  events: [] as any[],
}));

vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
vi.mock('@/lib/database', () => ({ getDatabase: async () => h.db }));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: unknown, c: unknown) => h.events.push({ d, c }),
  recordLimitEvent: vi.fn(),
}));

import {
  assertStorageStock,
  checkStorageStock,
  clearStorageCacheForTests,
  getStoredBytes,
  noteStoredBytes,
} from '@/lib/limits/storage';
import { assertSeats, checkSeats } from '@/lib/limits/seats';

function setPlan(mode: 'on' | 'off', patch: Record<string, unknown>) {
  h.plan = {
    tenantId: 't1',
    mode,
    limits: { concurrency: {}, monthly: {}, seats: {}, credits: {}, ...patch },
  };
}

beforeEach(() => {
  clearStorageCacheForTests();
  h.events.length = 0;
  h.db.sumFileRecordBytes.mockReset();
  h.db.sumFileRecordBytes.mockResolvedValue(0);
  h.db.sumVectorIndexStoredBytes.mockReset();
  h.db.sumVectorIndexStoredBytes.mockResolvedValue(0);
  h.db.iamCountUsers.mockReset();
  h.db.iamCountUsers.mockResolvedValue(0);
});

describe('checkStorageStock', () => {
  it('skips the database when there is no limit or limits are off', async () => {
    setPlan('on', {});
    expect((await checkStorageStock({ tenantId: 't1', incomingBytes: 10 })).allowed).toBe(true);
    setPlan('off', { storageBytes: 1 });
    expect((await checkStorageStock({ tenantId: 't1', incomingBytes: 10 })).allowed).toBe(true);
    expect(h.db.sumFileRecordBytes).not.toHaveBeenCalled();
  });

  it('refuses when used plus incoming passes the limit (on)', async () => {
    setPlan('on', { storageBytes: 1000 });
    h.db.sumFileRecordBytes.mockResolvedValue(900);
    expect((await checkStorageStock({ tenantId: 't1', incomingBytes: 100 })).allowed).toBe(true);
    const d = await checkStorageStock({ tenantId: 't1', incomingBytes: 101 });
    expect(d).toMatchObject({ allowed: false, outcome: 'refused', kind: 'storage', limit: 1000, used: 900 });
    expect(h.events).toHaveLength(1);
  });

  it('caches the sum and noteStoredBytes adjusts it', async () => {
    setPlan('on', { storageBytes: 1000 });
    h.db.sumFileRecordBytes.mockResolvedValue(500);
    await checkStorageStock({ tenantId: 't1', incomingBytes: 1 });
    noteStoredBytes('t1', 450);
    const d = await checkStorageStock({ tenantId: 't1', incomingBytes: 100 });
    expect(d.allowed).toBe(false);
    expect(d.used).toBe(950);
    expect(h.db.sumFileRecordBytes).toHaveBeenCalledTimes(1);
    noteStoredBytes('t1', -5000);
    expect((await checkStorageStock({ tenantId: 't1', incomingBytes: 1 })).used).toBe(0);
  });

  it('counts the vectors on platform providers with the files', async () => {
    setPlan('on', { storageBytes: 1000 });
    h.db.sumFileRecordBytes.mockResolvedValue(400);
    h.db.sumVectorIndexStoredBytes.mockResolvedValue(550);
    expect(await getStoredBytes('t1')).toBe(950);
    const d = await checkStorageStock({ tenantId: 't1', incomingBytes: 100 });
    expect(d).toMatchObject({ allowed: false, used: 950 });
    h.db.sumVectorIndexStoredBytes.mockResolvedValue(0);
  });

  it('fails open when the sum cannot be read', async () => {
    setPlan('on', { storageBytes: 1 });
    h.db.sumFileRecordBytes.mockRejectedValue(new Error('db'));
    expect((await checkStorageStock({ tenantId: 't1', incomingBytes: 100 })).allowed).toBe(true);
  });

  it('assertStorageStock throws storage_quota_exceeded with GB message', async () => {
    setPlan('on', { storageBytes: 2_000_000_000 });
    h.db.sumFileRecordBytes.mockResolvedValue(1_990_000_000);
    const err = await assertStorageStock({ tenantId: 't1', incomingBytes: 20_000_000 }).catch((e) => e);
    expect(err.code).toBe('storage_quota_exceeded');
    expect(err.status).toBe(413);
    expect(err.message).toBe('Storage is full (1.99 of 2 GB).');
  });
});

describe('checkSeats', () => {
  it('counts console seats with the console roles', async () => {
    setPlan('on', { seats: { console: 3 } });
    h.db.iamCountUsers.mockResolvedValue(2);
    expect((await checkSeats({ tenantId: 't1', kind: 'console' })).allowed).toBe(true);
    expect(h.db.iamCountUsers).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', roles: ['owner', 'admin', 'project_admin', 'user'], status: 'active' }),
    );
    h.db.iamCountUsers.mockResolvedValue(3);
    expect(await checkSeats({ tenantId: 't1', kind: 'console' })).toMatchObject({ allowed: false, used: 3, limit: 3 });
  });

  it('counts portal seats with portal_user and honours adding', async () => {
    setPlan('on', { seats: { portal: 10 } });
    h.db.iamCountUsers.mockResolvedValue(8);
    expect((await checkSeats({ tenantId: 't1', kind: 'portal', adding: 2 })).allowed).toBe(true);
    expect((await checkSeats({ tenantId: 't1', kind: 'portal', adding: 3 })).allowed).toBe(false);
    expect(h.db.iamCountUsers).toHaveBeenCalledWith(expect.objectContaining({ roles: ['portal_user'] }));
  });

  it('does not count when there is no seat limit, and fails open on errors', async () => {
    setPlan('on', { seats: {} });
    expect((await checkSeats({ tenantId: 't1', kind: 'console' })).allowed).toBe(true);
    expect(h.db.iamCountUsers).not.toHaveBeenCalled();
    setPlan('on', { seats: { console: 1 } });
    h.db.iamCountUsers.mockRejectedValue(new Error('db'));
    expect((await checkSeats({ tenantId: 't1', kind: 'console' })).allowed).toBe(true);
  });

  it('assertSeats throws seat_limit_reached (402) at the limit', async () => {
    setPlan('on', { seats: { console: 1 } });
    h.db.iamCountUsers.mockResolvedValue(1);
    const err = await assertSeats({ tenantId: 't1', kind: 'console' }).catch((e) => e);
    expect(err.code).toBe('seat_limit_reached');
    expect(err.status).toBe(402);
  });
});
