/**
 * POST /api/client/v1/users with projects: the programmatic account gets its memberships with the account, the legacy
 * single projectId works, an admin gets none, and a project of another workspace is refused before anything is created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    constructor(message: string, readonly status = 401) { super(message); }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$hash'), compare: vi.fn() },
  hash: vi.fn().mockResolvedValue('$hash'),
  compare: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientUsersApiPlugin } from '@/server/api/plugins/client-users';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const OWNER = { _id: 'owner-1', role: 'owner', tenantId: 'tenant-1' };

describe('POST /client/v1/users with projects', () => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.findUserByEmail.mockResolvedValue(null);
    db.listProjects.mockResolvedValue([
      { _id: 'p1', tenantId: 'tenant-1', name: 'One' },
      { _id: 'p2', tenantId: 'tenant-1', name: 'Two' },
      { _id: 'x', tenantId: 'tenant-2', name: 'Foreign' },
    ] as never);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => ({ _id: 'new-user', ...input }) as never);
    db.findUserById.mockResolvedValue(OWNER as never);
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue({
      token: 'tok_abc',
      tokenRecord: { _id: 'tok-1', userId: 'owner-1', servicePermissions: null },
      tenant: { licenseType: 'STARTER' },
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
      tenantDbName: 'tenant_acme',
      projectId: 'p1',
      user: OWNER,
    });
    app = await createFastifyApiTestApp(clientUsersApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (body: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: '/api/client/v1/users',
    headers: { authorization: 'Bearer tok_abc', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Svc Bot', ...body }),
  });

  it('stays what it was without projects: an account that cannot sign in, no memberships', async () => {
    const res = await create({});
    expect(res.statusCode).toBe(201);
    expect(db.upsertUserProject).not.toHaveBeenCalled();
    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ canLogin: false, projectIds: undefined }));
  });

  it('creates the memberships with the account, each with its role, as manual rows recorded to the token owner', async () => {
    const res = await create({ projects: [{ projectId: 'p1', role: 'member' }, { projectId: 'p2', role: 'project_admin' }] });
    expect(res.statusCode).toBe(201);
    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['p1', 'p2'] }));
    expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p2', role: 'project_admin', userId: 'new-user', invitedBy: 'owner-1', source: 'manual', tenantId: 'tenant-1',
    }));
    expect(db.upsertUserProject).toHaveBeenCalledTimes(2);
  });

  it('takes the legacy single projectId, with the role of the account', async () => {
    await create({ role: 'project_admin', projectId: 'p2' });
    expect(db.upsertUserProject).toHaveBeenCalledTimes(1);
    expect(db.upsertUserProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p2', role: 'project_admin' }));
  });

  it('gives an admin none', async () => {
    await create({ role: 'admin', projects: [{ projectId: 'p1', role: 'member' }] });
    expect(db.upsertUserProject).not.toHaveBeenCalled();
  });

  it('refuses a project of another workspace, or a malformed list, before creating anybody', async () => {
    expect((await create({ projects: [{ projectId: 'x', role: 'member' }] })).statusCode).toBe(400);
    expect((await create({ projects: [{ projectId: 'p1', role: 'root' }] })).statusCode).toBe(400);
    expect(parseJsonBody<{ error: string }>((await create({ projectId: 'nope' })).body).error).toMatch(/Unknown project/);
    expect(db.createUser).not.toHaveBeenCalled();
  });
});
