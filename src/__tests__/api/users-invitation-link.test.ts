import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jwtVerify } from 'jose';
import { createMockDb } from '../helpers/db.mock';

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

import { getConfig } from '@/lib/core/config';
import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { INVITATION_TOKEN_PURPOSE } from '@/lib/services/auth/invitation';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const OWNER = { _id: 'owner-1', role: 'owner', tenantId: 'tenant-1', name: 'Owner', email: 'owner@acme.com' };
const TENANT = { _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'STARTER', companyName: 'Acme' };
const HEADERS = {
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'owner-1',
  'x-user-role': 'owner',
};
const LINK_HEADERS = {
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-id': 'owner-1',
  'x-user-role': 'owner',
};

type InvitationReply = {
  invitationEmailSent?: boolean;
  invitationUrl?: string;
};

describe('user invitation links', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantById.mockResolvedValue(TENANT as never);
    db.findUserByEmail.mockResolvedValue(null);
    db.findUserById.mockResolvedValue(OWNER as never);
    db.listUsers.mockResolvedValue([OWNER] as never);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({
      _id: 'invited-user-1',
      ...input,
    }) as never);
    app = await createFastifyApiTestApp(usersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a signed link and includes it in the invitation email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: HEADERS,
      payload: JSON.stringify({ email: 'new@acme.com', name: 'New User', role: 'user' }),
    });

    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<InvitationReply>(res.body);
    expect(body.invitationEmailSent).toBe(true);
    expect(body.invitationUrl).toBeTruthy();
    expect(sendEmail).toHaveBeenCalledWith('new@acme.com', 'user-invitation', expect.objectContaining({
      inviteUrl: body.invitationUrl,
    }));

    const token = new URL(body.invitationUrl!).searchParams.get('token');
    const secret = new TextEncoder().encode(getConfig().auth.jwtSecret);
    const { payload } = await jwtVerify(token!, secret);
    expect(payload).toMatchObject({
      purpose: INVITATION_TOKEN_PURPOSE,
      slug: 'acme',
      sub: 'invited-user-1',
    });
  });

  it('returns a copyable link when delivery is unavailable', async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce(false);
    const res = await app.inject({
      method: 'POST',
      url: '/api/users/invite',
      headers: HEADERS,
      payload: JSON.stringify({ email: 'new@acme.com', name: 'New User', role: 'user' }),
    });

    const body = parseJsonBody<InvitationReply>(res.body);
    expect(res.statusCode).toBe(201);
    expect(body.invitationEmailSent).toBe(false);
    expect(body.invitationUrl).toBeTruthy();
  });

  it('regenerates a link only for a pending invitation', async () => {
    const invitedUser = {
      _id: 'invited-user-1',
      canLogin: true,
      email: 'new@acme.com',
      invitedAt: new Date(),
      invitedBy: 'owner-1',
      name: 'New User',
      password: '$hash',
      role: 'user',
      tenantId: 'tenant-1',
    };
    db.findUserById.mockImplementation(async (id: string) => (
      id === OWNER._id ? OWNER : invitedUser
    ) as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/users/invited-user-1/invitation-link',
      headers: LINK_HEADERS,
    });

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<InvitationReply>(res.body).invitationUrl).toBeTruthy();
  });

  it('does not create a link for an active user', async () => {
    const activeUser = {
      _id: 'active-user-1',
      canLogin: true,
      email: 'active@acme.com',
      inviteAcceptedAt: new Date(),
      invitedBy: 'owner-1',
      name: 'Active User',
      password: '$hash',
      role: 'user',
      tenantId: 'tenant-1',
    };
    db.findUserById.mockImplementation(async (id: string) => (
      id === OWNER._id ? OWNER : activeUser
    ) as never);

    const res = await app.inject({
      method: 'POST',
      url: '/api/users/active-user-1/invitation-link',
      headers: LINK_HEADERS,
    });

    expect(res.statusCode).toBe(404);
  });
});