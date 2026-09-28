import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/quota/quotaGuard', () => ({
  checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$hash'),
  compare: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { clientMembersApiPlugin } from '@/server/api/plugins/client-members';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = {
  _id: 'tenant-1',
  companyName: 'Acme',
  dbName: 'tenant_acme',
  licenseType: 'STARTER',
  slug: 'acme',
};
const OWNER = { _id: 'owner-1', email: 'owner@acme.com', role: 'owner', tenantId: 'tenant-1' };

describe('client member invitations', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantById.mockResolvedValue(TENANT as never);
    db.findUserByEmail.mockResolvedValue(null);
    db.listUsers.mockResolvedValue([OWNER] as never);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({
      _id: 'invited-user-1',
      ...input,
    }) as never);
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectId: 'proj-1',
      tenant: TENANT,
      tenantDbName: TENANT.dbName,
      tenantId: TENANT._id,
      tenantSlug: TENANT.slug,
      token: 'tok_test',
      tokenRecord: { _id: 'token-1', servicePermissions: null, userId: OWNER._id },
      user: OWNER,
    });
    app = await createFastifyApiTestApp(clientMembersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns and emails a secure invitation link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/client/v1/members/invite',
      headers: { authorization: 'Bearer tok_test', 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'new@acme.com', name: 'New User', role: 'user' }),
    });

    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<{
      invitationEmailSent: boolean;
      invitationUrl: string;
    }>(res.body);
    expect(body.invitationEmailSent).toBe(true);
    expect(body.invitationUrl).toContain('/reset-password?token=');
    expect(sendEmail).toHaveBeenCalledWith('new@acme.com', 'user-invitation', expect.objectContaining({
      inviteUrl: body.invitationUrl,
    }));
  });
});