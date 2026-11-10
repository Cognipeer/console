/**
 * Re-enabling a disabled account takes a seat again:
 * POST /users/:id/enable (session) and POST /client/v1/members/:id/enable (token).
 * on: refused with 402 seat_limit_reached and nothing is written; shadow: enabled and the
 * would-be refusal recorded; off: no seat is even counted. Accounts that take no seat are not checked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  db: null as unknown,
  plan: { tenantId: 'tenant-1', mode: 'on', limits: null } as any,
  events: [] as unknown[],
}));

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.status = status;
    }
  }
  return {
    ApiTokenAuthError,
    requireApiTokenFromHeader: vi.fn(),
    invalidateApiTokenAuthCache: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(async () => h.db),
  runWithTenantScope: vi.fn(async (_name: string, fn: (db: unknown) => unknown) => fn(h.db)),
}));
vi.mock('@/lib/core/cache', () => ({
  getCache: vi.fn(async () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() })),
}));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/services/projects/projectService', () => ({
  ensureDefaultProject: vi.fn().mockResolvedValue({ _id: 'proj-1', key: '__default__' }),
  DEFAULT_PROJECT_KEY: '__default__',
}));
vi.mock('@/lib/email/mailer', () => ({ sendEmail: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/limits/tenantLimits', () => ({ resolveTenantPlan: async () => h.plan }));
// A hosted deployment with plan limits on; each test sets the tenant's own mode through setPlan.
vi.mock('@/lib/limits/mode', () => ({
  deploymentPlanLimitsMode: () => 'on',
  planLimitsActive: () => true,
  effectivePlanLimitsMode: () => h.plan.mode,
}));
vi.mock('@/lib/limits/events', () => ({
  outcomeEventFor: (d: unknown) => h.events.push(d),
  recordLimitEvent: vi.fn(),
}));

import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientMembersApiPlugin } from '@/server/api/plugins/client-members';
import { usersApiPlugin } from '@/server/api/plugins/users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT = { _id: 'tenant-1', companyName: 'Acme', dbName: 'tenant_acme', licenseType: 'STARTER', slug: 'acme' };
const ADMIN = { _id: 'admin-1', email: 'admin@acme.com', role: 'admin', tenantId: 'tenant-1' };

const USERS: Record<string, Record<string, unknown>> = {
  'admin-1': ADMIN,
  'off-console': { _id: 'off-console', role: 'user', tenantId: 'tenant-1', status: 'disabled', email: 'a@acme.com' },
  'off-portal': { _id: 'off-portal', role: 'portal_user', tenantId: 'tenant-1', status: 'disabled', email: 'p@acme.com' },
  'off-nologin': { _id: 'off-nologin', role: 'user', tenantId: 'tenant-1', status: 'disabled', canLogin: false },
  'on-console': { _id: 'on-console', role: 'user', tenantId: 'tenant-1', email: 'c@acme.com' },
};

function setPlan(mode: 'on' | 'shadow' | 'off', seats: { console?: number; portal?: number }) {
  h.plan = { tenantId: 'tenant-1', mode, limits: { concurrency: {}, monthly: {}, seats, credits: {} } };
}

const SESSION_HEADERS = {
  'content-type': 'application/json',
  'x-license-type': 'STARTER',
  'x-tenant-db-name': 'tenant_acme',
  'x-tenant-id': 'tenant-1',
  'x-tenant-slug': 'acme',
  'x-user-email': 'admin@acme.com',
  'x-user-id': 'admin-1',
  'x-user-role': 'admin',
};

function authAsAdminToken() {
  (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue({
    projectId: 'proj-1',
    tenant: TENANT,
    tenantDbName: TENANT.dbName,
    tenantId: TENANT._id,
    tenantSlug: TENANT.slug,
    token: 'tok_test',
    tokenRecord: { _id: 'token-7', servicePermissions: null, userId: ADMIN._id },
    user: ADMIN,
  });
}

describe('seats when a disabled account is re-enabled', () => {
  let db: ReturnType<typeof createMockDb>;
  let usersApp: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let membersApp: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    h.events.length = 0;
    db = createMockDb();
    h.db = db;
    db.findUserById.mockImplementation(async (id: string) => (USERS[id] ? { ...USERS[id] } : null) as never);
    db.updateUser.mockImplementation(async (id: string, patch: object) => ({ ...USERS[id], ...patch }) as never);
    db.iamCountUsers.mockResolvedValue(3 as never);
    authAsAdminToken();
    usersApp = await createFastifyApiTestApp(usersApiPlugin);
    membersApp = await createFastifyApiTestApp(clientMembersApiPlugin);
  });

  afterEach(async () => {
    await usersApp.close();
    await membersApp.close();
  });

  const enableUser = (id: string) =>
    usersApp.inject({ method: 'POST', url: `/api/users/${id}/enable`, headers: SESSION_HEADERS, payload: '{}' });
  const enableMember = (id: string) =>
    membersApp.inject({
      method: 'POST',
      url: `/api/client/v1/members/${id}/enable`,
      headers: { authorization: 'Bearer tok_test', 'content-type': 'application/json' },
      payload: '{}',
    });

  const routes = [
    ['POST /users/:id/enable', enableUser],
    ['POST /client/v1/members/:id/enable', enableMember],
  ] as const;

  describe.each(routes)('%s', (_name, enable) => {
    it('is refused when every seat is in use (on), and nothing is written', async () => {
      setPlan('on', { console: 3, portal: 3 });
      const res = await enable('off-console');
      expect(res.statusCode).toBe(402);
      expect(res.headers['x-cognipeer-error-code']).toBe('seat_limit_reached');
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'seat_limit_reached', dimension: 'console' });
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('takes a portal seat for a portal user, counted against portal roles', async () => {
      setPlan('on', { console: 1, portal: 3 });
      const res = await enable('off-portal');
      expect(res.statusCode).toBe(402);
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ dimension: 'portal' });
      expect(db.iamCountUsers).toHaveBeenCalledWith(expect.objectContaining({ roles: ['portal_user'] }));
    });

    it('is allowed while a seat is free (on)', async () => {
      setPlan('on', { console: 4 });
      const res = await enable('off-console');
      expect(res.statusCode).toBe(200);
      expect(db.updateUser).toHaveBeenCalled();
    });

    it('is allowed and the would-be refusal recorded in shadow mode', async () => {
      setPlan('shadow', { console: 3 });
      const res = await enable('off-console');
      expect(res.statusCode).toBe(200);
      expect(h.events).toHaveLength(1);
      expect(db.updateUser).toHaveBeenCalled();
    });

    it('does not count anything when plan limits are off', async () => {
      setPlan('off', { console: 3 });
      const res = await enable('off-console');
      expect(res.statusCode).toBe(200);
      expect(db.iamCountUsers).not.toHaveBeenCalled();
    });

    it('does not check an account that cannot sign in, or one that is not disabled', async () => {
      setPlan('on', { console: 3 });
      expect((await enable('off-nologin')).statusCode).toBe(200);
      expect((await enable('on-console')).statusCode).toBe(200);
      expect(db.iamCountUsers).not.toHaveBeenCalled();
    });
  });

  describe('POST /users/bulk enable', () => {
    const OFF = ['off-console', 'off-console-2', 'off-console-3'];
    let used: number;
    beforeEach(() => {
      used = 3;
      db.findUserById.mockImplementation(async (id: string) =>
        (USERS[id] ? { ...USERS[id] } : OFF.includes(id) ? { ...USERS['off-console'], _id: id } : null) as never);
      // The live count follows the enables already written.
      db.iamCountUsers.mockImplementation(async () => used as never);
      db.updateUser.mockImplementation(async (id: string, patch: { status?: string }) => {
        if (patch.status === 'active') used += 1;
        return { ...USERS['off-console'], _id: id, ...patch } as never;
      });
    });
    const bulk = (dryRun: boolean) =>
      usersApp.inject({ method: 'POST', url: '/api/users/bulk', headers: SESSION_HEADERS, payload: JSON.stringify({ action: 'enable', ids: OFF, dryRun }) });

    it.each([false, true])('enables only as many as there are free seats (dryRun %s)', async (dryRun) => {
      setPlan('on', { console: 5 });
      const res = await bulk(dryRun);
      expect(res.statusCode).toBe(200);
      const results = parseJsonBody<{ results: Array<{ id: string; outcome: string; code?: string }> }>(res.body).results;
      expect(results.map((r) => r.outcome)).toEqual(['ok', 'ok', 'skipped']);
      expect(results[2]).toMatchObject({ code: 'seat_limit_reached' });
      expect(db.updateUser.mock.calls.filter((call) => (call[1] as { status?: string }).status === 'active')).toHaveLength(dryRun ? 0 : 2);
    });
  });

  describe('PATCH /users/:id role', () => {
    const patchRole = (id: string, role: string) =>
      usersApp.inject({ method: 'PATCH', url: `/api/users/${id}`, headers: SESSION_HEADERS, payload: JSON.stringify({ role }) });

    it('takes a portal seat when a console user becomes a portal user', async () => {
      setPlan('on', { console: 10, portal: 3 });
      const res = await patchRole('on-console', 'portal_user');
      expect(parseJsonBody<Record<string, unknown>>(res.body)).toMatchObject({ code: 'seat_limit_reached', dimension: 'portal' });
      expect(db.updateUser).not.toHaveBeenCalled();
    });

    it('takes no seat for a role of the same kind', async () => {
      setPlan('on', { console: 3, portal: 3 });
      const res = await patchRole('on-console', 'project_admin');
      expect(res.statusCode).toBe(200);
      expect(db.iamCountUsers).not.toHaveBeenCalled();
    });
  });
});
