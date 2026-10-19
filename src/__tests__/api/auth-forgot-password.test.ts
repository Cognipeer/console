/**
 * Forgot password finds the account's organizations from the email address,
 * the way login does, and mails one message with a reset link for each of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { decodeJwt } from 'jose';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/services/auth/rateLimiter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/auth/rateLimiter')>();
  return { ...actual, checkRateLimit: vi.fn().mockReturnValue({ allowed: true }) };
});

import { getDatabase } from '@/lib/database';
import { sendEmail } from '@/lib/email/mailer';
import { authApiPlugin } from '@/server/api/plugins/auth';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const acme = { _id: 'tenant-1', companyName: 'Acme', slug: 'acme-corp', dbName: 'tenant_acme-corp', licenseType: 'FREE' };
const globex = { _id: 'tenant-2', companyName: 'Globex', slug: 'globex', dbName: 'tenant_globex', licenseType: 'FREE' };

const userIn = (tenant: typeof acme, overrides: Record<string, unknown> = {}) => ({
  _id: `user-of-${tenant.slug}`,
  email: 'jane@example.com',
  name: 'Jane',
  role: 'user' as const,
  tenantId: tenant._id,
  password: '$2a$12$hash',
  licenseId: 'FREE',
  features: [],
  ...overrides,
});

const entryFor = (tenant: { _id: string; slug: string; dbName: string; companyName: string }) => ({
  email: 'jane@example.com',
  tenantId: tenant._id,
  tenantSlug: tenant.slug,
  tenantDbName: tenant.dbName,
  tenantCompanyName: tenant.companyName,
});

describe('POST /api/auth/forgot-password: organizations from the email', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;
  let usersByDb: Record<string, unknown>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as Mock).mockResolvedValue(db);
    db.findTenantById.mockImplementation(async (id: string) => ([acme, globex].find((t) => t._id === id) ?? null) as never);
    // The user lookup answers for the organization whose scope it runs in.
    let scope = '';
    (db.runWithTenant as Mock).mockImplementation(async (dbName: string, fn: () => unknown) => {
      scope = dbName;
      return fn();
    });
    usersByDb = {};
    db.findUserByEmail.mockImplementation(async () => (usersByDb[scope] ?? null) as never);
    app = await createFastifyApiTestApp(authApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const forgot = () => app.inject({
    method: 'POST',
    url: '/api/auth/forgot-password',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: 'jane@example.com' }),
  });

  // What each mailed link would reset: read back from its token.
  const mailedLinks = () => {
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const data = (sendEmail as Mock).mock.calls[0][2] as { organizations: Array<{ name: string; resetUrl: string }> };
    return data.organizations.map(({ name, resetUrl }) => {
      const { slug, sub } = decodeJwt(new URL(resetUrl).searchParams.get('token')!);
      return { name, slug, sub };
    });
  };

  it('needs only the email and mails one message with a link for every organization', async () => {
    db.listTenantsForUser.mockResolvedValue([entryFor(acme), entryFor(globex)]);
    usersByDb = { [acme.dbName]: userIn(acme), [globex.dbName]: userIn(globex) };

    const res = await forgot();

    expect(res.statusCode).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith('jane@example.com', 'password-reset', expect.objectContaining({ name: 'Jane' }));
    expect(mailedLinks()).toEqual([
      { name: 'Acme', slug: 'acme-corp', sub: 'user-of-acme-corp' },
      { name: 'Globex', slug: 'globex', sub: 'user-of-globex' },
    ]);
  });

  it('leaves out an organization whose account cannot reset its password', async () => {
    db.listTenantsForUser.mockResolvedValue([entryFor(acme), entryFor(globex)]);
    usersByDb = { [acme.dbName]: userIn(acme, { canLogin: false }), [globex.dbName]: userIn(globex) };

    await forgot();

    expect(mailedLinks()).toEqual([{ name: 'Globex', slug: 'globex', sub: 'user-of-globex' }]);
  });

  it('skips a directory entry whose organization no longer exists', async () => {
    const removed = { _id: 'tenant-gone', slug: 'gone', dbName: 'tenant_gone', companyName: 'Gone' };
    db.listTenantsForUser.mockResolvedValue([entryFor(removed), entryFor(globex)]);
    usersByDb = { [removed.dbName]: userIn(acme), [globex.dbName]: userIn(globex) };

    await forgot();

    expect(mailedLinks()).toEqual([{ name: 'Globex', slug: 'globex', sub: 'user-of-globex' }]);
  });
});
