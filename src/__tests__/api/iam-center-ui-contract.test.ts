/**
 * The IAM center UI against the REAL `/api/iam/*` handlers: what the plugin
 * answers goes through the UI's own normalizers and the plain-words model of the
 * access check, so a field the API renames or drops fails here instead of the
 * screen silently rendering zeros or a raw policy id.
 *
 *   engine health + counters    -> normalizeEngineStats
 *   policies (no mode)          -> normalizePolicyRow
 *   rule warnings               -> normalizeCompile + splitWarnings
 *   access check reasons        -> normalizeSimulate + parseBuiltInReason + projectLimitFrom
 *   denial trail + decisions    -> parseAuditPage + normalizeDecision
 *
 * Real plugin, real gate and engine, a real SQLite database.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ getDatabase: vi.fn() }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (tenantDbName: string, fn: (db: any) => unknown) => {
      const db = await hoisted.getDatabase();
      return db.runWithTenant(tenantDbName, () => fn(db));
    },
  };
});

import type { FastifyInstance } from 'fastify';
import type { DatabaseProvider, IUser } from '@/lib/database';
import { configureIamEngine, resetIamEngineForTests } from '@/lib/iam/engine';
import { resetPrincipalCacheForTests } from '@/lib/iam/principalCache';
import { primeProjectLevelsForTests } from '@/lib/iam/projectLevels';
import { authz } from '@/lib/iam/routeAuthz';
import { recordRegisteredRoute, resetRouteRegistryForTests } from '@/lib/iam/routeRegistry';
import { resetIamSettingsCacheForTests } from '@/lib/iam/settings';
import { drainPendingTasks } from '@/lib/core/asyncTask';
import { enqueueAuditLog } from '@/server/api/plugin';
import { iamApiPlugin } from '@/server/api/plugins/iam';
import {
  normalizeCompile,
  normalizeDecision,
  normalizeEngineStats,
  normalizePolicyRow,
  normalizePrincipalDetail,
  normalizeSimulate,
} from '@/components/iam/api';
import { splitWarnings } from '@/components/iam/policies/issues';
import { parseAuditPage } from '@/components/iam/audit/client';
import { formatAuditText } from '@/components/iam/audit/summaryText';
import { hasProjectLimit, parseBuiltInReason, projectLimitFrom } from '@/components/iam/check/reasonModel';
import { messages } from '@/lib/i18n/messages';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from '../integration/db-parity.helper';

interface Tenant {
  dbName: string;
  id: string;
  users: Record<string, IUser>;
  projects: Record<string, string>;
  tokens: Record<string, string>;
}

// One provider is enough: the UI contract does not depend on the database behind the API.
const skipMongo = process.env.PARITY_SKIP_MONGODB;
process.env.PARITY_SKIP_MONGODB = '1';

describeForEachProvider('IAM center UI contract', (getDb) => {
  let db: DatabaseProvider;
  let app: FastifyInstance;
  let T: Tenant;

  const headers = (user: IUser) => ({
    'x-tenant-db-name': T.dbName,
    'x-tenant-id': T.id,
    'x-tenant-slug': 'iam-ui-contract',
    'x-user-id': String(user._id),
    'x-user-role': String(user.role),
    'x-user-email': String(user.email),
    'x-license-type': 'FREE',
  });

  async function call(method: string, url: string, who: string, body?: unknown) {
    const h: Record<string, string> = headers(T.users[who]);
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await app.inject({ method: method as never, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: any = null;
    if (res.body) {
      try { parsed = parseJsonBody<any>(res.body); } catch { parsed = res.body; }
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  }

  beforeAll(async () => {
    hoisted.getDatabase.mockImplementation(async () => getDb());
    db = getDb();
    const slug = `iamui-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const dbName = `tenant_${slug}`;
    const row = await db.createTenant({ companyName: 'UI contract', slug, dbName, licenseType: 'FREE', ownerId: 'pending' });
    T = { dbName, id: String(row._id), users: {}, projects: {}, tokens: {} };
    await db.runWithTenant!(dbName, async () => {
      const mk = async (key: string, role: 'owner' | 'admin' | 'user', extra: Record<string, unknown> = {}) => {
        T.users[key] = await db.createUser({ tenantId: T.id, email: `${key}@ui.example`, name: `${key[0].toUpperCase()}${key.slice(1)} Ui`, password: '$2b$10$x', role, licenseId: 'FREE', features: [], ...extra });
      };
      await mk('owner', 'owner');
      await mk('admin', 'admin');
      await mk('plain', 'user');
      await mk('dave', 'user');
      await mk('bob', 'user', { servicePermissions: { agents: 'write' } });
      const p1 = await db.createProject({ tenantId: T.id, key: 'pj1', name: 'Retail', createdBy: 'x' });
      T.projects = { retail: String(p1._id) };
      // dave works in Retail, where the project limits Agents to Read
      await db.upsertUserProject({ tenantId: T.id, userId: String(T.users.dave._id), projectId: T.projects.retail, role: 'member', servicePermissions: { agents: 'read' } });
      const scoped = await db.createApiToken({ tenantId: T.id, userId: String(T.users.bob._id), label: 'bob-scoped', tokenHash: `h-${slug}`, tokenPrefix: 'cp_bob', servicePermissions: { agents: 'read' }, createdBy: String(T.users.bob._id) } as never);
      T.tokens = { bobScoped: String(scoped._id) };
    });

    app = await createFastifyApiTestApp(async (instance) => {
      instance.addHook('onResponse', async (request, reply) => { enqueueAuditLog(request, reply); });
      await instance.register(iamApiPlugin);
    });
    await app.ready();
    resetIamEngineForTests();
    resetPrincipalCacheForTests();
    resetRouteRegistryForTests();
    resetIamSettingsCacheForTests();
    // the project levels count from the start of time here (the grandfathering rule has its own tests)
    primeProjectLevelsForTests(dbName, 0);
    for (const route of [['GET', '/api/agents', 'agents', 'read'], ['POST', '/api/agents', 'agents', 'write']] as const) {
      recordRegisteredRoute(route[0], route[1], authz.service(route[2], route[3]));
    }
    configureIamEngine({ validateRequests: false });
  });

  afterAll(async () => {
    await drainPendingTasks();
    await app?.close();
  });

  it('engine statistics read as the overview needs them', async () => {
    const res = await call('GET', '/api/iam/engine/stats', 'admin');
    expect(res.status).toBe(200);
    const stats = normalizeEngineStats(res.body);
    expect(stats.health.status).toBe('ok');
    expect(['process', 'tenant']).toContain(stats.statsScope);
    expect(stats.policySet).toMatchObject({ custom: 0, skipped: [] });
    expect(stats.undeclaredRoutes.count).toBeGreaterThanOrEqual(0);
    // numbers, not NaN or undefined
    for (const n of [stats.decisions, stats.allows, stats.denies, stats.unavailable, stats.undeclaredDenies, stats.ownerSafety]) {
      expect(Number.isFinite(n)).toBe(true);
    }
    // the retired fields are gone for good
    expect(res.body).not.toHaveProperty('mode');
    expect(res.body).not.toHaveProperty('shadow');
    expect(res.body).not.toHaveProperty('killSwitches');
  });

  it('a policy is enabled or disabled and carries no mode', async () => {
    const created = await call('POST', '/api/iam/policies', 'admin', {
      name: 'Freeze agents',
      enabled: false,
      spec: { effect: 'forbid', principals: { users: [String(T.users.plain._id)] }, actions: ['agents.write'], resources: { any: true } },
    });
    expect(created.status).toBe(201);
    const row = normalizePolicyRow(created.body);
    expect(row).toMatchObject({ name: 'Freeze agents', enabled: false, effect: 'forbid' });
    expect(row).not.toHaveProperty('mode');
    expect(created.body).not.toHaveProperty('mode');
    expect(created.body).not.toHaveProperty('monitorStats');
    const listed = await call('GET', '/api/iam/policies', 'admin');
    expect(listed.body.custom.map(normalizePolicyRow).map((p: { name: string }) => p.name)).toContain('Freeze agents');
    // the retired dry-run mode is refused with a code the UI never sends
    const monitor = await call('POST', '/api/iam/policies', 'admin', {
      name: 'Dry run', mode: 'monitor',
      spec: { effect: 'forbid', principals: { any: true }, actions: ['agents.write'], resources: { any: true } },
    });
    expect(monitor.status).toBe(400);
    expect(monitor.body.details?.[0]).toMatchObject({ code: 'monitor_removed', field: 'mode' });
  });

  it('a rule about an action nothing in the product checks says so, in a code the screen sorts as "never applies"', async () => {
    const compile = async (actions: string[]) => normalizeCompile((await call('POST', '/api/iam/policies/compile', 'admin', {
      spec: { effect: 'forbid', principals: { any: true }, actions, resources: { any: true } },
    })).body);
    // the routes registered above ask for Agents (read and write) only
    const asked = await compile(['agents.write']);
    expect(asked.ok).toBe(true);
    expect(asked.warnings.map((w) => w.code)).not.toContain('not_asked_actions');

    const unasked = await compile(['models.admin']);
    expect(unasked.ok).toBe(true);
    const warning = unasked.warnings.find((w) => w.code === 'not_asked_actions');
    expect(warning).toMatchObject({ field: 'actions', params: { actions: 'models.admin', effect: 'forbid' } });
    expect(splitWarnings(unasked.warnings).inert.map((w) => w.code)).toContain('not_asked_actions');
  });

  it('an access check says its reasons in a way the plain-words model understands: role, project limit, token scope', async () => {
    const dave = String(T.users.dave._id);
    // allowed by the person's role (workspace access) - the project does not limit reading
    const allowed = normalizeSimulate((await call('POST', '/api/iam/simulate', 'admin', {
      principal: { type: 'user', id: dave }, action: 'agents.read', resource: { kind: 'service', service: 'agents' },
      context: { projectId: T.projects.retail },
    })).body);
    expect(allowed.allowed).toBe(true);
    expect(allowed.reasons.map((r) => parseBuiltInReason(r.cedarId).kind)).toContain('role');
    expect(allowed.projectId).toBe(T.projects.retail);

    // denied by the project's own limit: Agents = Read in Retail, so writing is refused
    const limited = normalizeSimulate((await call('POST', '/api/iam/simulate', 'admin', {
      principal: { type: 'user', id: dave }, action: 'agents.write', resource: { kind: 'service', service: 'agents' },
      context: { projectId: T.projects.retail },
    })).body);
    expect(limited.allowed).toBe(false);
    expect(hasProjectLimit(limited.reasons)).toBe(true);
    expect(parseBuiltInReason(limited.reasons.find((r) => r.managed)!.cedarId)).toEqual({ kind: 'projectLimit', level: 'write' });

    // the exact limit the card shows ("Agents = Read") comes from the member's effective permissions in that project
    const detail = normalizePrincipalDetail((await call('GET', `/api/iam/principals/user/${dave}?projectId=${T.projects.retail}`, 'admin')).body);
    expect(projectLimitFrom(detail.effective, 'agents')).toEqual({ level: 'read', projectName: 'Retail' });
    // and outside the project there is no such limit
    const workspaceWide = normalizePrincipalDetail((await call('GET', `/api/iam/principals/user/${dave}`, 'admin')).body);
    expect(projectLimitFrom(workspaceWide.effective, 'agents')).toBeNull();

    // a scoped token: the token's scope refuses the write
    const scoped = normalizeSimulate((await call('POST', '/api/iam/simulate', 'admin', {
      principal: { type: 'token', id: T.tokens.bobScoped }, action: 'agents.write', resource: { kind: 'service', service: 'agents' },
    })).body);
    expect(scoped.allowed).toBe(false);
    expect(scoped.reasons.map((r) => parseBuiltInReason(r.cedarId).kind)).toContain('tokenScope');
    expect(scoped.principalSummary.tokenScope).toEqual({ agents: 'read' });

    // nobody allows a plain member to write: a default deny, which the card words from the role and the level
    const none = normalizeSimulate((await call('POST', '/api/iam/simulate', 'admin', {
      principal: { type: 'user', id: String(T.users.plain._id) }, action: 'config.write', resource: { kind: 'service', service: 'config' },
    })).body);
    expect(none).toMatchObject({ allowed: false, defaultDeny: true });
    expect(none.principalSummary.role).toBe('user');
  });

  it('a refused request shows up in the denial trail with a decision id the Access check can replay', async () => {
    const denied = await call('GET', '/api/iam/policies', 'plain');
    expect(denied.status).toBe(403);
    const decisionId = denied.body.decisionId as string;
    expect(decisionId).toMatch(/^[0-9a-f-]{36}$/);
    await drainPendingTasks();

    const trail = parseAuditPage((await call('GET', '/api/iam/audit?kind=denials&limit=20', 'admin')).body, 'denials');
    const row = trail.items.find((item) => item.decisionId === decisionId);
    expect(row).toBeTruthy();
    expect(row!.principal?.label).toContain('Plain');
    // the sentence is data the UI words in the reader's language
    expect(row!.text).toBeTruthy();
    const lookup = (key: string) => key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages.en);
    const translate = (namespace: string) => (key: string, values?: Record<string, string | number | undefined | null>) => {
      const template = lookup(`${namespace}.${key}`);
      return typeof template === 'string'
        ? template.replace(/\{(\w+)\}/g, (m, name) => (values?.[name] === undefined || values?.[name] === null ? m : String(values[name])))
        : `${namespace}.${key}`;
    };
    const sentence = formatAuditText(row!, translate('iamAudit'), translate('iamCenter'));
    expect(sentence).not.toMatch(/^iamAudit\./);
    expect(sentence).toContain('iam');

    const decision = normalizeDecision((await call('GET', `/api/iam/decisions/${decisionId}`, 'admin')).body);
    expect(decision).toMatchObject({ decisionId, code: 'forbidden', service: 'iam' });
    expect(decision.simulateInput).not.toBeNull();
    // a replay of it answers "denied" with the reasons shown above
    const replay = normalizeSimulate((await call('POST', '/api/iam/simulate', 'admin', decision.simulateInput)).body);
    expect(replay.allowed).toBe(false);
  });
});

if (skipMongo === undefined) delete process.env.PARITY_SKIP_MONGODB;
else process.env.PARITY_SKIP_MONGODB = skipMongo;
