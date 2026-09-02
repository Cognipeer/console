/**
 * Bulk import insert loop.
 *
 * Two properties that only matter at scale and are invisible in a three-row
 * test: one bcrypt hash per batch rather than per row (a 2 000-row file at
 * cost 12 is minutes of event-loop time otherwise), and a quota re-check that
 * stops the loop when a concurrent import consumed the headroom the up-front
 * check saw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn(), compare: vi.fn() },
  hash: vi.fn(),
  compare: vi.fn(),
}));

import bcrypt from 'bcryptjs';
import { getDatabase } from '@/lib/database';
import {
  importProgrammaticUsers,
  QUOTA_RECHECK_EVERY,
  rowAlreadyExists,
} from '@/lib/services/users/csvImport';

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@x.com` }));

describe('importProgrammaticUsers', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listUsers.mockResolvedValue([]);
    db.createUser.mockImplementation(async (input) => ({ _id: `id-${input.name}`, ...input }) as never);
    (bcrypt.hash as ReturnType<typeof vi.fn>).mockResolvedValue('$2a$12$shared');
  });

  it('hashes ONE password for the whole batch and reuses it on every row', async () => {
    const { created, halted } = await importProgrammaticUsers({
      tenantId: 't1',
      rows: rowsOf(3),
      licenseId: 'FREE',
    });
    expect(created).toHaveLength(3);
    expect(halted).toBeUndefined();
    expect(bcrypt.hash).toHaveBeenCalledTimes(1);
    for (const call of db.createUser.mock.calls) {
      expect((call[0] as { password: string; canLogin: boolean }).password).toBe('$2a$12$shared');
      expect((call[0] as { canLogin: boolean }).canLogin).toBe(false);
    }
  });

  it('does not hash at all when every row already exists', async () => {
    db.listUsers.mockResolvedValue([{ _id: 'u', name: 'Person 0', email: 'p0@x.com' }] as never);
    const { created } = await importProgrammaticUsers({ tenantId: 't1', rows: rowsOf(1), licenseId: 'FREE' });
    expect(created).toEqual([]);
    expect(bcrypt.hash).not.toHaveBeenCalled();
  });

  it(`re-checks the quota every ${QUOTA_RECHECK_EVERY} creations and halts, keeping what was created`, async () => {
    const limit = 100;
    const checkQuota = vi.fn(async (currentCount: number) => ({
      allowed: currentCount < limit,
      reason: `users limit reached (${currentCount}/${limit})`,
    }));

    const { created, halted } = await importProgrammaticUsers({
      tenantId: 't1',
      rows: rowsOf(120),
      licenseId: 'FREE',
      checkQuota,
    });

    // Checked at 50 (allowed) and at 100 (refused); never on row 0.
    expect(checkQuota.mock.calls.map((c) => c[0])).toEqual([50, 100]);
    expect(created).toHaveLength(100);
    expect(halted).toEqual({ reason: `users limit reached (${limit}/${limit})`, remaining: 20 });
    expect(db.createUser).toHaveBeenCalledTimes(100);
  });

  it('skips rows by the same rule the route charges the quota with', () => {
    const byEmail = new Set(['known@x.com']);
    const byName = new Set(['known name']);
    expect(rowAlreadyExists({ name: 'Any', email: 'KNOWN@x.com' }, byEmail, byName)).toBe(true);
    expect(rowAlreadyExists({ name: 'Known Name' }, byEmail, byName)).toBe(true);
    // A row WITH an email is matched on email only — a namesake with a
    // different address is a different person.
    expect(rowAlreadyExists({ name: 'Known Name', email: 'new@x.com' }, byEmail, byName)).toBe(false);
  });
});
