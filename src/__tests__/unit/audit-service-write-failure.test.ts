/**
 * Regression tests for F-07 (finance-institution assessment, 2026-09-05):
 * `recordAuditLog` used to catch its own DB error and log it at `warn`,
 * resolving normally either way — so even a caller that awaited it could
 * never tell an audit write was lost. It must now propagate the failure so
 * `criticalFireAndForget` (its only caller today) can log it loudly and
 * count it against the critical pending set.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

import { getDatabase } from '@/lib/database';
import { recordAuditLog } from '@/lib/services/audit/auditService';

describe('recordAuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates a DB write failure instead of swallowing it', async () => {
    const db = {
      switchToTenant: vi.fn().mockResolvedValue(undefined),
      createAuditLog: vi.fn().mockRejectedValue(new Error('connection reset')),
    };
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    await expect(
      recordAuditLog(
        { tenantDbName: 'tenant_acme', tenantId: 'tenant-1' },
        {
          action: 'read',
          actorType: 'user',
          event: 'GET /api/client/v1/rag/docs',
          method: 'GET',
          outcome: 'success',
          path: '/api/client/v1/rag/docs',
          service: 'rag',
          statusCode: 200,
        },
      ),
    ).rejects.toThrow('connection reset');
  });

  it('still writes the row and resolves cleanly on success', async () => {
    const db = {
      switchToTenant: vi.fn().mockResolvedValue(undefined),
      createAuditLog: vi.fn().mockResolvedValue({ _id: 'log-1' }),
    };
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);

    await recordAuditLog(
      { tenantDbName: 'tenant_acme', tenantId: 'tenant-1' },
      {
        action: 'write',
        actorType: 'user',
        event: 'POST /api/client/v1/rag/docs',
        method: 'POST',
        outcome: 'success',
        path: '/api/client/v1/rag/docs',
        service: 'rag',
        statusCode: 201,
      },
    );

    expect(db.switchToTenant).toHaveBeenCalledWith('tenant_acme');
    expect(db.createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', event: 'POST /api/client/v1/rag/docs' }),
    );
  });
});
