/**
 * Default alert rules and the alert cleanup on the two project surfaces: the dashboard plugin and the token-authenticated
 * client API. What the rules are and how they are added is covered in unit/alert-templates.test.ts and
 * unit/alert-project-cleanup.test.ts (and against the live alerts plugin in api/alerts-templates.test.ts); this pins
 * WHEN the project routes call them and what they answer:
 *
 *   POST   /api/projects                    seeds unless `defaultAlertRules: false`; omitted follows the installation default
 *   DELETE /api/projects/:projectId         removes the project's alerts after the delete
 *   POST   /api/client/v1/projects          seeds only with `defaultAlertRules: true`
 *   DELETE /api/client/v1/projects/:projectId
 *
 * The two alert services are replaced by hoisted plain mocks (a sync factory: an async one that calls importActual does
 * not intercept in this repo), so the arguments they receive and the order of the calls can be asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDb } from '../helpers/db.mock';

const h = vi.hoisted(() => ({
  seedDefaultAlertRules: vi.fn(),
  defaultAlertRulesOnCreate: vi.fn(),
  removeDeletedProjectAlerts: vi.fn(),
}));

vi.mock('@/lib/services/apiTokenAuth', () => {
  class ApiTokenAuthError extends Error {
    status: number;
    constructor(message: string, status = 401) {
      super(message);
      this.name = 'ApiTokenAuthError';
      this.status = status;
    }
  }
  return { ApiTokenAuthError, requireApiTokenFromHeader: vi.fn() };
});
vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  // The request gate reads the caller through a tenant-scoped handle.
  return {
    getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()),
  };
});
vi.mock('@/lib/core/lifecycle', () => ({ isShuttingDown: vi.fn().mockReturnValue(false) }));
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('@/lib/services/alerts/alertTemplates', () => ({
  seedDefaultAlertRules: h.seedDefaultAlertRules,
  defaultAlertRulesOnCreate: h.defaultAlertRulesOnCreate,
}));
vi.mock('@/lib/services/alerts/alertService', () => ({
  removeDeletedProjectAlerts: h.removeDeletedProjectAlerts,
}));

import { getDatabase } from '@/lib/database';
import { requireApiTokenFromHeader } from '@/lib/services/apiTokenAuth';
import { clientProjectsApiPlugin } from '@/server/api/plugins/client-projects';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

type App = Awaited<ReturnType<typeof createFastifyApiTestApp>>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type MockDb = ReturnType<typeof createMockDb>;

const TENANT = 'tenant-1';
const TENANT_DB = 'tenant_acme';
const NEW_PROJECT = 'proj-new';
const PROJECT = 'proj-1';

const OWNER = { _id: 'owner-1', role: 'owner', tenantId: TENANT, canLogin: true };
const PLAIN_USER = { _id: 'user-1', role: 'user', tenantId: TENANT, canLogin: true, projectIds: [PROJECT] };

const sessionHeaders = (userId = 'owner-1') => ({
  'x-license-type': 'ENTERPRISE',
  'x-tenant-db-name': TENANT_DB,
  'x-tenant-id': TENANT,
  'x-tenant-slug': 'acme',
  'x-user-id': userId,
  'x-user-role': 'owner',
});

const TOKEN_HEADERS = { authorization: 'Bearer tok_abc' };
const JSON_TYPE = { 'content-type': 'application/json' };

function tokenContext(user: Json) {
  return {
    token: 'tok_abc',
    tokenRecord: { _id: 'tok-1', userId: String(user._id), servicePermissions: null },
    tenant: { licenseType: 'ENTERPRISE' },
    tenantId: TENANT,
    tenantSlug: 'acme',
    tenantDbName: TENANT_DB,
    projectId: PROJECT,
    user,
  };
}

function primeDb(db: MockDb): void {
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findUserById.mockImplementation(async (id: string) => (
    ({ 'owner-1': OWNER, 'user-1': PLAIN_USER } as Record<string, unknown>)[id] as never
  ) ?? null);
  db.createProject.mockImplementation(async (data: Json) => ({ _id: NEW_PROJECT, ...data }) as never);
  db.findProjectById.mockResolvedValue({ _id: PROJECT, tenantId: TENANT, key: 'alpha', name: 'Alpha' } as never);
  db.deleteProject.mockResolvedValue(true);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seedDefaultAlertRules.mockResolvedValue(5);
  h.defaultAlertRulesOnCreate.mockReturnValue(true);
  h.removeDeletedProjectAlerts.mockResolvedValue(undefined);
});

// ── dashboard ────────────────────────────────────────────────────────────────

describe('dashboard: POST /api/projects', () => {
  let app: App;
  let db: MockDb;

  beforeEach(async () => {
    db = createMockDb();
    primeDb(db);
    app = await createFastifyApiTestApp(projectsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (payload: Json, userId = 'owner-1') => app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { ...sessionHeaders(userId), ...JSON_TYPE },
    payload: JSON.stringify(payload),
  });

  it('seeds the default alert rules by default, for the new project, and says how many it added', async () => {
    const res = await create({ name: 'New project' });

    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<Json>(res.body);
    expect(body).toMatchObject({ project: { _id: NEW_PROJECT, name: 'New project' }, warnings: [], defaultAlertRules: 5 });
    expect(h.seedDefaultAlertRules).toHaveBeenCalledTimes(1);
    // tenant database, tenant, the NEW project, the person who creates it
    expect(h.seedDefaultAlertRules).toHaveBeenCalledWith(TENANT_DB, TENANT, NEW_PROJECT, 'owner-1');
  });

  it('seeds after the project exists', async () => {
    await create({ name: 'New project' });
    expect(db.createProject.mock.invocationCallOrder[0]).toBeLessThan(h.seedDefaultAlertRules.mock.invocationCallOrder[0]);
  });

  it('answers how many rules were added, whatever the number: 0 when the project already has them', async () => {
    h.seedDefaultAlertRules.mockResolvedValue(0);
    const res = await create({ name: 'New project' });
    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<Json>(res.body)).toMatchObject({ warnings: [], defaultAlertRules: 0 });
  });

  it('skips them with defaultAlertRules: false, even when the installation default is on', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(true);
    const res = await create({ name: 'Quiet project', defaultAlertRules: false });

    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<Json>(res.body)).toMatchObject({ project: { _id: NEW_PROJECT }, warnings: [], defaultAlertRules: 0 });
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
    // an explicit answer does not ask for the default
    expect(h.defaultAlertRulesOnCreate).not.toHaveBeenCalled();
  });

  it('follows the installation default when the field is omitted: off skips', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(false);
    const res = await create({ name: 'Default off' });

    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<Json>(res.body)).toMatchObject({ project: { _id: NEW_PROJECT }, warnings: [], defaultAlertRules: 0 });
    expect(h.defaultAlertRulesOnCreate).toHaveBeenCalledTimes(1);
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });

  it('follows the installation default when the field is omitted: on seeds', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(true);
    await create({ name: 'Default on' });
    expect(h.defaultAlertRulesOnCreate).toHaveBeenCalledTimes(1);
    expect(h.seedDefaultAlertRules).toHaveBeenCalledTimes(1);
  });

  it('seeds with defaultAlertRules: true even when the installation default is off', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(false);
    const res = await create({ name: 'Asked for them', defaultAlertRules: true });

    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<Json>(res.body)).toMatchObject({ defaultAlertRules: 5 });
    expect(h.seedDefaultAlertRules).toHaveBeenCalledWith(TENANT_DB, TENANT, NEW_PROJECT, 'owner-1');
    expect(h.defaultAlertRulesOnCreate).not.toHaveBeenCalled();
  });

  it('still answers 201 and warns when the rules could not be added', async () => {
    h.seedDefaultAlertRules.mockResolvedValue(null);
    const res = await create({ name: 'No rules this time' });

    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<Json>(res.body);
    expect(body.project).toMatchObject({ _id: NEW_PROJECT });
    expect(body.defaultAlertRules).toBe(0);
    expect(body.warnings).toEqual(['The default alert rules could not be added; add them from Alerts → Templates.']);
  });

  it('keeps the other warnings of the create next to the default-rules one', async () => {
    h.seedDefaultAlertRules.mockResolvedValue(null);
    const res = await create({ name: 'Mixed', members: [{ userId: 'nobody', role: 'member' }] });

    expect(res.statusCode).toBe(201);
    const { warnings } = parseJsonBody<Json>(res.body);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings[0]).not.toContain('default alert rules');
    expect(warnings[warnings.length - 1]).toContain('default alert rules');
  });

  it('does not seed a project that was refused: name missing, or a caller who cannot create projects', async () => {
    expect((await create({ name: 'x' })).statusCode).toBe(400);
    expect((await create({ name: 'Not allowed' }, 'user-1')).statusCode).toBe(403);
    expect(db.createProject).not.toHaveBeenCalled();
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });

  it.each([['a string', 'false'], ['a number', 0], ['null', null], ['a list', [true]]])(
    'answers 400 for defaultAlertRules that is %s, and creates nothing',
    async (_label, value) => {
      const res = await create({ name: 'Bad flag', defaultAlertRules: value });
      expect(res.statusCode).toBe(400);
      expect(parseJsonBody<Json>(res.body)).toEqual({ error: 'defaultAlertRules must be a boolean' });
      expect(db.createProject).not.toHaveBeenCalled();
      expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
    },
  );

  it('does not seed when the project cannot be created', async () => {
    db.createProject.mockRejectedValue(new Error('db down'));
    const res = await create({ name: 'Broken' });
    expect(res.statusCode).toBe(500);
    expect(parseJsonBody<Json>(res.body)).toEqual({ error: 'Internal server error' });
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });
});

describe('dashboard: DELETE /api/projects/:projectId', () => {
  let app: App;
  let db: MockDb;

  beforeEach(async () => {
    db = createMockDb();
    primeDb(db);
    app = await createFastifyApiTestApp(projectsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const remove = (userId = 'owner-1') => app.inject({
    method: 'DELETE',
    url: `/api/projects/${PROJECT}`,
    headers: sessionHeaders(userId),
  });

  it('removes the alerts of the project after it deleted it', async () => {
    const res = await remove();

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Json>(res.body)).toEqual({ success: true });
    expect(db.deleteProject).toHaveBeenCalledWith(PROJECT);
    expect(h.removeDeletedProjectAlerts).toHaveBeenCalledTimes(1);
    expect(h.removeDeletedProjectAlerts).toHaveBeenCalledWith(TENANT_DB, TENANT, PROJECT);
    expect(db.deleteProject.mock.invocationCallOrder[0]).toBeLessThan(h.removeDeletedProjectAlerts.mock.invocationCallOrder[0]);
  });

  it('removes the memberships of the project as well', async () => {
    const res = await remove();
    expect(res.statusCode).toBe(200);
    expect(db.deleteUserProjectsByProject).toHaveBeenCalledWith(PROJECT);
    expect(h.removeDeletedProjectAlerts).toHaveBeenCalledTimes(1);
  });

  it('leaves the alerts alone when the project is not found', async () => {
    db.findProjectById.mockResolvedValue(null);
    expect((await remove()).statusCode).toBe(404);
    expect(db.deleteProject).not.toHaveBeenCalled();
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });

  it('leaves the alerts of the default project alone: it cannot be deleted', async () => {
    db.findProjectById.mockResolvedValue({ _id: PROJECT, tenantId: TENANT, key: 'default', name: 'Default Project' } as never);
    const res = await remove();
    expect(res.statusCode).toBe(400);
    expect(parseJsonBody<Json>(res.body)).toEqual({ error: 'Cannot delete the default project' });
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });

  it('leaves the alerts alone when the delete did not happen', async () => {
    db.deleteProject.mockResolvedValue(false);
    const res = await remove();
    expect(res.statusCode).toBe(500);
    expect(parseJsonBody<Json>(res.body)).toEqual({ error: 'Failed to delete project' });
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });

  it('leaves the alerts alone for a caller who cannot delete projects', async () => {
    expect((await remove('user-1')).statusCode).toBe(403);
    expect(db.deleteProject).not.toHaveBeenCalled();
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });
});

// ── client API ───────────────────────────────────────────────────────────────

describe('client API: POST /api/client/v1/projects', () => {
  let app: App;
  let db: MockDb;

  beforeEach(async () => {
    db = createMockDb();
    primeDb(db);
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(tokenContext(OWNER));
    app = await createFastifyApiTestApp(clientProjectsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (payload: Json) => app.inject({
    method: 'POST',
    url: '/api/client/v1/projects',
    headers: { ...TOKEN_HEADERS, ...JSON_TYPE },
    payload: JSON.stringify(payload),
  });

  it('seeds the default alert rules with defaultAlertRules: true, as the token owner', async () => {
    const res = await create({ name: 'Integration project', defaultAlertRules: true });

    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<Json>(res.body)).toMatchObject({ project: { _id: NEW_PROJECT, name: 'Integration project' }, defaultAlertRules: 5 });
    expect(parseJsonBody<Json>(res.body).warnings).toBeUndefined();
    expect(h.seedDefaultAlertRules).toHaveBeenCalledTimes(1);
    expect(h.seedDefaultAlertRules).toHaveBeenCalledWith(TENANT_DB, TENANT, NEW_PROJECT, 'owner-1');
    expect(db.createProject.mock.invocationCallOrder[0]).toBeLessThan(h.seedDefaultAlertRules.mock.invocationCallOrder[0]);
  });

  it('adds no rules without the opt-in, whatever the installation default is', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(true);
    const res = await create({ name: 'Integration project' });

    expect(res.statusCode).toBe(201);
    const body = parseJsonBody<Json>(res.body);
    expect(body.project).toMatchObject({ _id: NEW_PROJECT });
    // the answer keeps its old shape: nothing about default alert rules
    expect(body).not.toHaveProperty('defaultAlertRules');
    expect(body).not.toHaveProperty('warnings');
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
    expect(h.defaultAlertRulesOnCreate).not.toHaveBeenCalled();
  });

  it('adds no rules with defaultAlertRules: false', async () => {
    const res = await create({ name: 'Integration project', defaultAlertRules: false });
    expect(res.statusCode).toBe(201);
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });

  it.each([['the string "true"', 'true'], ['the number 1', 1], ['a string', 'yes']])(
    'adds no rules for %s: only a real true opts in',
    async (_label, value) => {
      const res = await create({ name: 'Integration project', defaultAlertRules: value });
      expect(res.statusCode).toBe(201);
      expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
    },
  );

  it('opts in even when the installation default is off', async () => {
    h.defaultAlertRulesOnCreate.mockReturnValue(false);
    const res = await create({ name: 'Integration project', defaultAlertRules: true });
    expect(res.statusCode).toBe(201);
    expect(h.seedDefaultAlertRules).toHaveBeenCalledTimes(1);
  });

  it('still answers 201 and warns when the rules could not be added', async () => {
    h.seedDefaultAlertRules.mockResolvedValue(null);
    const res = await create({ name: 'Integration project', defaultAlertRules: true });

    expect(res.statusCode).toBe(201);
    expect(parseJsonBody<Json>(res.body)).toMatchObject({
      project: { _id: NEW_PROJECT },
      defaultAlertRules: 0,
      warnings: ['The default alert rules could not be added.'],
    });
  });

  it('answers 0 and no warning when it added nothing because the rules were there', async () => {
    h.seedDefaultAlertRules.mockResolvedValue(0);
    const res = await create({ name: 'Integration project', defaultAlertRules: true });
    const body = parseJsonBody<Json>(res.body);
    expect(body.defaultAlertRules).toBe(0);
    expect(body.warnings).toBeUndefined();
  });

  it('seeds nothing for a refused request: a name that is too short, or a token owner who is not an admin', async () => {
    expect((await create({ name: 'x', defaultAlertRules: true })).statusCode).toBe(400);

    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(tokenContext(PLAIN_USER));
    expect((await create({ name: 'Integration project', defaultAlertRules: true })).statusCode).toBe(403);

    expect(db.createProject).not.toHaveBeenCalled();
    expect(h.seedDefaultAlertRules).not.toHaveBeenCalled();
  });
});

describe('client API: DELETE /api/client/v1/projects/:projectId', () => {
  let app: App;
  let db: MockDb;

  beforeEach(async () => {
    db = createMockDb();
    primeDb(db);
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(tokenContext(OWNER));
    app = await createFastifyApiTestApp(clientProjectsApiPlugin);
  });

  afterEach(async () => {
    await app.close();
  });

  const remove = () => app.inject({ method: 'DELETE', url: `/api/client/v1/projects/${PROJECT}`, headers: TOKEN_HEADERS });

  it('removes the alerts of the project after it deleted it', async () => {
    const res = await remove();

    expect(res.statusCode).toBe(200);
    expect(parseJsonBody<Json>(res.body)).toEqual({ success: true });
    expect(db.deleteProject).toHaveBeenCalledWith(PROJECT);
    expect(db.deleteUserProjectsByProject).toHaveBeenCalledWith(PROJECT);
    expect(h.removeDeletedProjectAlerts).toHaveBeenCalledTimes(1);
    expect(h.removeDeletedProjectAlerts).toHaveBeenCalledWith(TENANT_DB, TENANT, PROJECT);
    expect(db.deleteProject.mock.invocationCallOrder[0]).toBeLessThan(h.removeDeletedProjectAlerts.mock.invocationCallOrder[0]);
  });

  it('leaves the alerts alone for a project of another workspace', async () => {
    db.findProjectById.mockResolvedValue({ _id: PROJECT, tenantId: 'tenant-2', key: 'alpha' } as never);
    expect((await remove()).statusCode).toBe(404);
    expect(db.deleteProject).not.toHaveBeenCalled();
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });

  it('leaves the alerts alone when the project is not found', async () => {
    db.findProjectById.mockResolvedValue(null);
    expect((await remove()).statusCode).toBe(404);
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });

  it('leaves the alerts of the default project alone: it cannot be deleted', async () => {
    db.findProjectById.mockResolvedValue({ _id: PROJECT, tenantId: TENANT, key: 'default' } as never);
    expect((await remove()).statusCode).toBe(400);
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });

  it('leaves the alerts alone when the delete did not happen', async () => {
    db.deleteProject.mockResolvedValue(false);
    expect((await remove()).statusCode).toBe(500);
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });

  it('leaves the alerts alone for a token owner who is not an admin', async () => {
    (requireApiTokenFromHeader as ReturnType<typeof vi.fn>).mockResolvedValue(tokenContext(PLAIN_USER));
    expect((await remove()).statusCode).toBe(403);
    expect(db.deleteProject).not.toHaveBeenCalled();
    expect(h.removeDeletedProjectAlerts).not.toHaveBeenCalled();
  });
});
