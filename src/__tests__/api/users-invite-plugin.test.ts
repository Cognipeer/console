/**
 * POST /api/users/invite through the live plugin: who may invite, the user quota (a
 * count of the workspace's people - never a read of the whole table), who the mail
 * says invited the person, and the two kinds of account it creates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
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
import { checkResourceQuota } from '@/lib/quota/quotaGuard';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = { _id: 'tenant-1', slug: 'acme', dbName: 'tenant_acme', licenseType: 'STARTER', companyName: 'Acme' };
const ACCOUNTS: Record<string, Record<string, unknown>> = {
  'owner-1': { _id: 'owner-1', role: 'owner', tenantId: 'tenant-1', name: 'Olivia Owner', email: 'owner@acme.com' },
  'admin-1': { _id: 'admin-1', role: 'admin', tenantId: 'tenant-1', name: 'Adam Admin', email: 'admin@acme.com' },
  'member-1': { _id: 'member-1', role: 'user', tenantId: 'tenant-1', name: 'Mia Member', email: 'member@acme.com' },
};
const headersFor = (userId: string, role: string) => ({
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-email': String(ACCOUNTS[userId]?.email ?? ''),
  'x-user-id': userId,
  'x-user-role': role,
});

describe('POST /api/users/invite', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findTenantById.mockResolvedValue(TENANT as never);
    db.findUserByEmail.mockResolvedValue(null);
    db.findUserById.mockImplementation(async (id: string) => (ACCOUNTS[id] ? { ...ACCOUNTS[id] } : null) as never);
    db.iamCountUsers.mockResolvedValue(42);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'invited-1', ...input }) as never);
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: true });
    app = await createFastifyApiTestApp(usersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const invite = (body: Record<string, unknown>, who: [string, string] = ['owner-1', 'owner']) => app.inject({
    method: 'POST', url: '/api/users/invite', headers: headersFor(...who), payload: JSON.stringify(body),
  });
  const person = { name: 'New Person', email: 'new@acme.com', role: 'user' };

  it('invites a person: a user who has to choose a password, and an invitation out by email', async () => {
    const res = await invite(person);
    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<{ message: string; invitationUrl: string }>(res.body).message).toBe('User invited successfully');
    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({
      email: 'new@acme.com', name: 'New Person', role: 'user', canLogin: true, mustChangePassword: true, invitedBy: 'owner-1', password: '$hash',
    }));
  });

  it('charges the user quota for the number of people, read as a count - not by reading the table', async () => {
    await invite(person);
    // seats: the workspace's own people (external accounts of a host application are portal users, not seats)
    expect(db.iamCountUsers).toHaveBeenCalledWith({ tenantId: 'tenant-1', external: false });
    expect(db.listUsers).not.toHaveBeenCalled();
    expect((checkResourceQuota as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('users');
    expect((checkResourceQuota as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(42);
  });

  it('answers 429 with a code when the plan has no room for another person, and creates nobody', async () => {
    (checkResourceQuota as ReturnType<typeof vi.fn>).mockResolvedValue({ allowed: false, reason: 'users limit reached' });
    const res = await invite(person);
    expect(res.statusCode).toBe(429);
    expect(parseJsonBody<{ code: string; error: string }>(res.body)).toMatchObject({ code: 'quota_exceeded', error: 'users limit reached' });
    expect(db.createUser).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('says in the mail who invited the person - by name, not by role', async () => {
    await invite(person, ['admin-1', 'admin']);
    expect(sendEmail).toHaveBeenCalledWith('new@acme.com', 'user-invitation', expect.objectContaining({ inviterName: 'Adam Admin' }));
    expect(sendEmail).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ inviterName: 'admin' }));
  });

  it('refuses an email that is taken, with a code', async () => {
    db.findUserByEmail.mockResolvedValue({ _id: 'other', email: 'new@acme.com' } as never);
    const res = await invite(person);
    expect([res.statusCode, parseJsonBody<{ code: string }>(res.body).code]).toEqual([409, 'email_taken']);
    expect(db.createUser).not.toHaveBeenCalled();
  });

  it('is for owners and admins - judged on the role the account has now', async () => {
    expect((await invite(person, ['member-1', 'user'])).statusCode).toBe(403);
    // the session says admin, the account is an ordinary member now
    expect((await invite(person, ['member-1', 'admin'])).statusCode).toBe(403);
    expect(db.createUser).not.toHaveBeenCalled();
    expect((await invite(person, ['admin-1', 'admin'])).statusCode).toBe(201);
  });

  it('lets an owner or admin give the admin role, never the owner role', async () => {
    expect((await invite({ ...person, role: 'admin' }, ['admin-1', 'admin'])).statusCode).toBe(201);
    expect((await invite({ ...person, role: 'owner' })).statusCode).toBe(400);
    expect((await invite({ ...person, role: 'root' })).statusCode).toBe(400);
  });

  it('creates a service account that cannot sign in: no invitation, a password shown once, an email optional', async () => {
    const res = await invite({ name: 'Build Bot', role: 'user', canLogin: false });
    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<{ message: string; generatedPassword: string; invitationUrl?: string }>(res.body);
    expect(body.message).toBe('User created successfully');
    expect(body.generatedPassword).toBeTruthy();
    expect(body.invitationUrl).toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ canLogin: false, email: '', mustChangePassword: false }));
  });

  it('needs an email from anyone who can sign in', async () => {
    const res = await invite({ name: 'No Mail', role: 'user' });
    expect([res.statusCode, parseJsonBody<{ code: string }>(res.body).code]).toEqual([400, 'email_required']);
    expect(db.createUser).not.toHaveBeenCalled();
  });

  it('names what is wrong with a code', async () => {
    const code = async (body: Record<string, unknown>) => parseJsonBody<{ code: string }>((await invite(body)).body).code;
    expect(await code({ email: 'a@acme.com' })).toBe('invalid_body'); // no name or role
    expect(await code({ ...person, email: 'not-an-email' })).toBe('invalid_body');
    expect(await code({ ...person, role: 'root' })).toBe('invalid_role');
  });
});
