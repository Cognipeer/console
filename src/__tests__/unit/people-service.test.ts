/**
 * The lookups and summaries the people endpoints share. (The endpoints themselves
 * are covered through the routes: users-patch, users-bulk, user-lifecycle-routes.)
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/database', () => ({ runWithTenantScope: vi.fn() }));

import { findUserByIdSafe, newBatchId, summarizeBulk, updatePerson } from '@/lib/services/users/peopleService';

const dbReturning = (value: unknown) => ({ findUserById: vi.fn().mockResolvedValue(value) });
const bsonError = () => Object.assign(new Error('input must be a 24 character hex string, 12 byte Uint8Array, or an integer'), { name: 'BSONError' });

describe('findUserByIdSafe', () => {
  it('finds a person of this workspace', async () => {
    const db = dbReturning({ _id: 'u1', tenantId: 't1', role: 'user' });
    expect(await findUserByIdSafe(db, 'u1', 't1')).toMatchObject({ _id: 'u1' });
    expect(db.findUserById).toHaveBeenCalledWith('u1');
  });

  it('treats a row without a workspace as this one (a row of an older database), and one of another as not found', async () => {
    expect(await findUserByIdSafe(dbReturning({ _id: 'u1' }), 'u1', 't1')).toMatchObject({ _id: 'u1' });
    expect(await findUserByIdSafe(dbReturning({ _id: 'u1', tenantId: 't2' }), 'u1', 't1')).toBeNull();
    expect(await findUserByIdSafe(dbReturning(null), 'u1', 't1')).toBeNull();
  });

  it('never asks the database for something that cannot be an id', async () => {
    const db = dbReturning({ _id: 'x', tenantId: 't1' });
    for (const id of [undefined, null, 7, {}, [], '', 'x'.repeat(257)]) expect(await findUserByIdSafe(db, id, 't1')).toBeNull();
    expect(db.findUserById).not.toHaveBeenCalled();
  });

  it('reads an id the database cannot parse as "no such person", and lets any other failure through', async () => {
    const bad = { findUserById: vi.fn().mockRejectedValue(bsonError()) };
    expect(await findUserByIdSafe(bad, 'not-an-id', 't1')).toBeNull();
    const down = { findUserById: vi.fn().mockRejectedValue(new Error('connection lost')) };
    await expect(findUserByIdSafe(down, 'u1', 't1')).rejects.toThrow('connection lost');
  });
});

describe('summarizeBulk', () => {
  it('counts the three outcomes', () => {
    expect(summarizeBulk([
      { id: 'a', outcome: 'ok' }, { id: 'b', outcome: 'ok' }, { id: 'c', outcome: 'skipped', code: 'self_not_allowed' }, { id: 'd', outcome: 'failed', code: 'failed' },
    ])).toEqual({ ok: 2, skipped: 1, failed: 1 });
    expect(summarizeBulk([])).toEqual({ ok: 0, skipped: 0, failed: 0 });
  });
});

describe('newBatchId', () => {
  it('is a fresh identifier each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newBatchId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('updatePerson', () => {
  it('writes nothing for a change that changes nothing', async () => {
    const before = { _id: 'u1', tenantId: 't1', role: 'user', name: 'Una', email: 'una@x.test', password: '', licenseId: 'FREE' } as never;
    const result = await updatePerson(
      { tenantDbName: 'tenant_acme', tenantId: 't1', actor: { type: 'user', userId: 'a1' } },
      before,
      {},
    );
    expect(result).toBe(before);
  });
});
