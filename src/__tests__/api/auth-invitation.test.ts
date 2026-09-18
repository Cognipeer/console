import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$new-hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$new-hash'),
  compare: vi.fn(),
}));
vi.mock('@/lib/services/auth/rateLimiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth/rateLimiter')>();
  return { ...actual, checkRateLimit: vi.fn().mockReturnValue({ allowed: true }) };
});

import { getDatabase } from '@/lib/database';
import { createInvitationUrl } from '@/lib/services/auth/invitation';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const TENANT = {
  _id: 'tenant-1',
  companyName: 'Acme',
  slug: 'acme',
  dbName: 'tenant_acme',
  licenseType: 'FREE',
};
const INVITED_USER = {
  _id: 'user-1',
  canLogin: true,
  email: 'new@acme.com',
  invitedAt: new Date(),
  invitedBy: 'owner-1',
  licenseId: 'FREE',
  name: 'New User',
  password: '$hash',
  role: 'user' as const,
  tenantId: 'tenant-1',
};

describe('invitation password setup', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantBySlug.mockResolvedValue(TENANT as never);
    db.findUserById.mockResolvedValue(INVITED_USER as never);
    db.updateUser.mockResolvedValue(INVITED_USER as never);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('sets the password and accepts the pending invitation', async () => {
    const invitationUrl = await createInvitationUrl(INVITED_USER, TENANT.slug);
    const token = new URL(invitationUrl).searchParams.get('token');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token, newPassword: 'Str0ng!Passw0rd#2026' }),
    });

    expect(res.statusCode).toBe(200);
    expect(db.updateUser).toHaveBeenCalledWith('user-1', expect.objectContaining({
      inviteAcceptedAt: expect.any(Date),
      mustChangePassword: false,
      password: '$new-hash',
    }));
  });

  it('rejects a link once the invitation was accepted', async () => {
    db.findUserById.mockResolvedValue({
      ...INVITED_USER,
      inviteAcceptedAt: new Date(),
    } as never);
    const invitationUrl = await createInvitationUrl(INVITED_USER, TENANT.slug);
    const token = new URL(invitationUrl).searchParams.get('token');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/reset-password',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ token, newPassword: 'Str0ng!Passw0rd#2026' }),
    });

    expect(res.statusCode).toBe(400);
    expect(db.updateUser).not.toHaveBeenCalled();
  });
});