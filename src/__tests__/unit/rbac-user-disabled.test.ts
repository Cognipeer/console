/**
 * Defense in depth behind the global session hook: the RBAC user loader (also
 * the entry point for realtime cookie auth via resolveSessionRbacContext)
 * rejects a disabled account on its own with a 401.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { resolveSessionRbacContext, type ApiSessionContext } from '@/server/api/fastify-utils';

const session = {
  requestId: 'r1',
  tenantDbName: 'tenant_acme',
  tenantId: 't1',
  tenantSlug: 'acme',
  userId: 'u1',
  userRole: 'admin',
  licenseType: 'FREE',
} as ApiSessionContext;

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
});

describe('resolveSessionRbacContext: account state', () => {
  it('rejects a disabled user with a 401', async () => {
    db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'admin', status: 'disabled' } as never);
    await expect(resolveSessionRbacContext(session)).rejects.toMatchObject({
      message: 'Account is disabled',
      status: 401,
    });
  });

  it('loads an active user and a legacy status-less user', async () => {
    for (const status of ['active', undefined] as const) {
      db.findUserById.mockResolvedValue({ _id: 'u1', tenantId: 't1', role: 'admin', status } as never);
      const { user } = await resolveSessionRbacContext(session);
      expect(String(user._id)).toBe('u1');
    }
  });
});
