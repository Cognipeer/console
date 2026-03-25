/**
 * Unit tests — ApiTokenAuth service
 * Covers: missing header, malformed token, invalid token, tenant not found, valid token flow.
 *
 * The database is fully mocked — no real MongoDB connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
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

import { getDatabase } from '@/lib/database';
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';
import {
  createMockDb,
  TENANT_ACME,
  USER_ALICE,
  API_TOKEN_VALID,
} from '../helpers/db.mock';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildRequest(authHeader?: string): NextRequest {
  return new NextRequest('http://localhost/api/client/v1/chat/completions', {
    method: 'POST',
    headers: authHeader ? { Authorization: authHeader } : {},
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('requireApiToken', () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(mockDb);
  });

  describe('authorization header validation', () => {
    it('throws 401 when Authorization header is missing', async () => {
      const req = buildRequest();
      await expect(requireApiToken(req)).rejects.toMatchObject({
        name: 'ApiTokenAuthError',
        status: 401,
      });
    });

    it('throws 401 when Authorization header does not start with Bearer', async () => {
      const req = buildRequest('Basic abc123');
      await expect(requireApiToken(req)).rejects.toMatchObject({
        name: 'ApiTokenAuthError',
        status: 401,
      });
    });

    it('throws 401 when Bearer token is empty', async () => {
      const req = buildRequest('Bearer ');
      await expect(requireApiToken(req)).rejects.toMatchObject({
        name: 'ApiTokenAuthError',
        status: 401,
      });
    });
  });

  describe('token lookup', () => {
    it('throws 401 when token is not found in database', async () => {
      mockDb.findApiTokenByToken.mockResolvedValue(null);
      const req = buildRequest('Bearer sk-unknown-token');
      await expect(requireApiToken(req)).rejects.toMatchObject({
        name: 'ApiTokenAuthError',
        status: 401,
        message: expect.stringMatching(/invalid api token/i),
      });
      expect(mockDb.findApiTokenByToken).toHaveBeenCalledWith('sk-unknown-token');
    });

    it('throws 404 when tenant is not found for the token', async () => {
      mockDb.findApiTokenByToken.mockResolvedValue(API_TOKEN_VALID);
      mockDb.findTenantById.mockResolvedValue(null);
      const req = buildRequest(`Bearer ${API_TOKEN_VALID.token}`);
      await expect(requireApiToken(req)).rejects.toMatchObject({
        name: 'ApiTokenAuthError',
        status: 404,
      });
    });
  });

  describe('successful authentication', () => {
    beforeEach(() => {
      mockDb.findApiTokenByToken.mockResolvedValue(API_TOKEN_VALID);
      mockDb.findTenantById.mockResolvedValue(TENANT_ACME);
      mockDb.findUserById.mockResolvedValue(USER_ALICE);
    });

    it('returns ApiTokenContext with correct tenant references', async () => {
      const req = buildRequest(`Bearer ${API_TOKEN_VALID.token}`);
      const ctx = await requireApiToken(req);

      expect(ctx.token).toBe(API_TOKEN_VALID.token);
      expect(ctx.tenantId).toBe(TENANT_ACME._id);
      expect(ctx.tenantSlug).toBe(TENANT_ACME.slug);
      expect(ctx.tenantDbName).toBe(TENANT_ACME.dbName);
    });

    it('calls switchToTenant with the correct dbName', async () => {
      const req = buildRequest(`Bearer ${API_TOKEN_VALID.token}`);
      await requireApiToken(req);

      expect(mockDb.switchToTenant).toHaveBeenCalledWith(TENANT_ACME.dbName);
    });

    it('updates last-used timestamp for the token', async () => {
      const req = buildRequest(`Bearer ${API_TOKEN_VALID.token}`);
      await requireApiToken(req);

      expect(mockDb.updateTokenLastUsed).toHaveBeenCalledWith(API_TOKEN_VALID.token);
    });

    it('resolves user via findUserById', async () => {
      const req = buildRequest(`Bearer ${API_TOKEN_VALID.token}`);
      const ctx = await requireApiToken(req);

      expect(ctx.user).toMatchObject({ email: USER_ALICE.email });
    });

    it('gracefully returns null user when findUserById throws', async () => {
      mockDb.findUserById.mockRejectedValue(new Error('DB error'));
      const req = buildRequest(`Bearer ${API_TOKEN_VALID.token}`);
      const ctx = await requireApiToken(req);

      expect(ctx.user).toBeNull();
    });
  });

  describe('ApiTokenAuthError', () => {
    it('defaults to status 401', () => {
      const err = new ApiTokenAuthError('bad token');
      expect(err.status).toBe(401);
      expect(err.name).toBe('ApiTokenAuthError');
    });

    it('accepts a custom status code', () => {
      const err = new ApiTokenAuthError('not found', 404);
      expect(err.status).toBe(404);
    });

    it('is an instance of Error', () => {
      expect(new ApiTokenAuthError('x')).toBeInstanceOf(Error);
    });
  });
});
