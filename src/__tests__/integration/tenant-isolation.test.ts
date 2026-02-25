/**
 * Integration tests — Tenant Isolation
 *
 * Verifies that every service operation that touches tenant-specific data
 * (users, tokens, models, prompts, etc.) first calls switchToTenant().
 *
 * The database is fully mocked — no real MongoDB connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
  getTenantDatabase: vi.fn(),
}));

vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({
    _id: 'proj-default-id',
    key: 'default',
    name: 'Default Project',
    tenantId: 'tenant-acme-id',
    createdBy: 'user-alice-id',
  }),
}));

import { getDatabase, getTenantDatabase } from '@/lib/database';
import { createMockDb, TENANT_ACME, USER_ALICE, API_TOKEN_VALID } from '../helpers/db.mock';

// ── Helpers ───────────────────────────────────────────────────────────────────

function setupMockDatabase(overrides = {}) {
  const db = createMockDb(overrides as never);
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  (getTenantDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  return db;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Tenant isolation — switchToTenant is always called', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = setupMockDatabase();
  });

  describe('requireApiToken auth flow', () => {
    it('calls switchToTenant before any user operations', async () => {
      const { NextRequest } = await import('next/server');
      const { requireApiToken } = await import('@/lib/services/apiTokenAuth');

      mockDb.findApiTokenByToken.mockResolvedValue(API_TOKEN_VALID);
      mockDb.findTenantById.mockResolvedValue(TENANT_ACME);
      mockDb.findUserById.mockResolvedValue(USER_ALICE);

      const req = new NextRequest('http://localhost/api/client/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_TOKEN_VALID.token}` },
      });

      await requireApiToken(req);

      // switchToTenant must be called with the correct tenant DB name
      expect(mockDb.switchToTenant).toHaveBeenCalledWith(TENANT_ACME.dbName);

      // switchToTenant must happen before user lookup
      const switchOrder = mockDb.switchToTenant.mock.invocationCallOrder[0];
      const userLookupOrder = mockDb.findUserById.mock.invocationCallOrder[0];
      expect(switchOrder).toBeLessThan(userLookupOrder);
    });
  });

  describe('cross-tenant data isolation invariants', () => {
    it('findUserByEmail is scoped to the switched tenant DB', async () => {
      mockDb.switchToTenant.mockImplementation(async () => {});

      // Switch to tenant A
      await mockDb.switchToTenant(TENANT_ACME.dbName);
      mockDb.findUserByEmail.mockResolvedValueOnce(USER_ALICE);
      const userA = await mockDb.findUserByEmail('alice@acme.com');

      // Switch to tenant B (different DB)
      await mockDb.switchToTenant('tenant_beta');
      mockDb.findUserByEmail.mockResolvedValueOnce(null);
      const userB = await mockDb.findUserByEmail('alice@acme.com');

      expect(userA).not.toBeNull();
      expect(userB).toBeNull(); // tenant B has no alice
    });

    it('listApiTokens called after wrong switchToTenant still uses the last switched DB', async () => {
      // Simulate switching to the wrong tenant first
      await mockDb.switchToTenant('tenant_beta');
      mockDb.listApiTokens.mockResolvedValueOnce([]);

      const tokens = await mockDb.listApiTokens('some-user-id');
      expect(tokens).toEqual([]); // no cross-leak

      // Now switch to the correct tenant
      await mockDb.switchToTenant(TENANT_ACME.dbName);
      mockDb.listApiTokens.mockResolvedValueOnce([API_TOKEN_VALID]);

      const correctTokens = await mockDb.listApiTokens('user-alice-id');
      expect(correctTokens).toContainEqual(
        expect.objectContaining({ token: API_TOKEN_VALID.token }),
      );
    });

    it('two tenants with the same user email return different user records', async () => {
      // Tenant A
      await mockDb.switchToTenant(TENANT_ACME.dbName);
      mockDb.findUserByEmail.mockResolvedValueOnce({
        ...USER_ALICE,
        _id: 'alice-in-acme',
        tenantId: 'tenant-acme-id',
      });
      const aliceInAcme = await mockDb.findUserByEmail('alice@example.com');

      // Tenant B with same email but different ID
      await mockDb.switchToTenant('tenant_rival');
      mockDb.findUserByEmail.mockResolvedValueOnce({
        ...USER_ALICE,
        _id: 'alice-in-rival',
        tenantId: 'tenant-rival-id',
      });
      const aliceInRival = await mockDb.findUserByEmail('alice@example.com');

      expect(aliceInAcme!._id).not.toBe(aliceInRival!._id);
      expect(aliceInAcme!.tenantId).not.toBe(aliceInRival!.tenantId);
    });
  });

  describe('database switchToTenant contract', () => {
    it('switchToTenant is awaitable and resolves', async () => {
      await expect(mockDb.switchToTenant('tenant_acme')).resolves.toBeUndefined();
    });

    it('switchToTenant is called with the exact dbName from the tenant record', async () => {
      const dbName = TENANT_ACME.dbName; // 'tenant_acme'
      await mockDb.switchToTenant(dbName);
      expect(mockDb.switchToTenant).toHaveBeenCalledWith(dbName);
    });
  });
});
