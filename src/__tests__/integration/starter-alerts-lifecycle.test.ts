/**
 * Starter alert rules over real databases, run against BOTH providers, through the real project routes: creating a
 * project adds the starter rules (dashboard: by default, client API: on request), and deleting one removes its alert
 * rules and closes the incidents someone still had to act on, in pages, leaving everything of other projects and the
 * history alone. The unit and API tests pin the decisions with mocks; this proves the pieces work together on SQLite
 * and MongoDB (rule store, incident paging and closing, the marks, the channel audience).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseProvider, IIncident, IUser } from '@/lib/database';

const h = vi.hoisted(() => ({ db: null as DatabaseProvider | null }));

// Route every `getDatabase()` / `getTenantDatabase()` / `runWithTenantScope()` in the code under test to the provider
// the parity harness is currently running against (a sync factory on purpose).
vi.mock('@/lib/database', () => {
  const current = async (): Promise<DatabaseProvider> => {
    if (!h.db) throw new Error('database provider not initialised');
    return h.db;
  };
  return {
    getDatabase: current,
    getTenantDatabase: async (tenantDbName: string) => {
      const db = await current();
      await db.switchToTenant(tenantDbName);
      return db;
    },
    runWithTenantScope: async <T>(tenantDbName: string, fn: (db: DatabaseProvider) => T | Promise<T>): Promise<T> => {
      const db = await current();
      if (typeof db.runWithTenant === 'function') return db.runWithTenant(tenantDbName, () => fn(db));
      await db.switchToTenant(tenantDbName);
      return fn(db);
    },
  };
});
vi.mock('@/lib/quota/quotaGuard', () => ({ checkResourceQuota: vi.fn().mockResolvedValue({ allowed: true }) }));

import { reloadConfig } from '@/lib/core/config';
import { createApiTokenSecret, getApiTokenPrefix, hashApiToken } from '@/lib/services/apiTokens/tokenHashing';
import { STARTER_ALERT_KEYS, STARTER_ALERTS, seedStarterAlerts } from '@/lib/services/alerts/starterAlerts';
import { clientProjectsApiPlugin } from '@/server/api/plugins/client-projects';
import { projectsApiPlugin } from '@/server/api/plugins/projects';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { describeForEachProvider } from './db-parity.helper';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const apiUnderTest: FastifyPluginAsync = async (app) => {
  await app.register(projectsApiPlugin);
  await app.register(clientProjectsApiPlugin);
};

const uid = (): string => Math.random().toString(36).slice(2, 10);
const CLOSING_NOTE = 'Closed: the project was deleted';

describeForEachProvider('Starter alert rules and project cleanup', (getDb) => {
  let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
  let tenantId = '';
  let tenantDbName = '';
  let owner: IUser;
  let homeProjectId = '';
  let token = '';

  beforeAll(async () => {
    const db = getDb();
    h.db = db;
    const suffix = uid();
    tenantDbName = `tenant_sal_${suffix}`;
    const tenant = await db.createTenant({
      companyName: 'Starter Lifecycle Co',
      slug: `sal-${suffix}`,
      dbName: tenantDbName,
      licenseType: 'enterprise',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(tenantDbName);
    owner = await db.createUser({
      email: `owner-${suffix}@example.com`,
      password: 'x',
      name: 'owner',
      tenantId,
      role: 'owner',
      licenseId: 'test',
    });
    const home = await db.createProject({ tenantId, key: 'home', name: 'Home', createdBy: String(owner._id) });
    homeProjectId = String(home._id);

    const secret = createApiTokenSecret();
    await db.createApiToken({
      userId: String(owner._id),
      tenantId,
      projectId: homeProjectId,
      label: `token-${uid()}`,
      tokenHash: hashApiToken(secret),
      tokenPrefix: getApiTokenPrefix(secret),
    });
    token = secret;

    app = await createFastifyApiTestApp(apiUnderTest);
    return async () => {
      await app.close();
      h.db = null;
    };
  });

  afterAll(() => {
    delete process.env.ALERT_STARTER_RULES_ON_CREATE;
    reloadConfig();
  });

  beforeEach(async () => {
    await getDb().switchToTenant(tenantDbName);
    delete process.env.ALERT_STARTER_RULES_ON_CREATE;
    reloadConfig();
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const sessionHeaders = (json = true) => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    'x-license-type': 'ENTERPRISE',
    'x-tenant-db-name': tenantDbName,
    'x-tenant-id': tenantId,
    'x-tenant-slug': 'sal',
    'x-user-email': owner.email,
    'x-user-id': String(owner._id),
    'x-user-role': owner.role,
  });
  const tokenHeaders = (json = true) => ({ authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) });

  const createViaDashboard = (payload: Json) => app.inject({
    method: 'POST', url: '/api/projects', headers: sessionHeaders(), payload: JSON.stringify(payload),
  });
  const createViaClientApi = (payload: Json) => app.inject({
    method: 'POST', url: '/api/client/v1/projects', headers: tokenHeaders(), payload: JSON.stringify(payload),
  });
  const deleteViaDashboard = (projectId: string) => app.inject({
    method: 'DELETE', url: `/api/projects/${projectId}`, headers: sessionHeaders(false),
  });
  const deleteViaClientApi = (projectId: string) => app.inject({
    method: 'DELETE', url: `/api/client/v1/projects/${projectId}`, headers: tokenHeaders(false),
  });

  const rulesOf = (projectId: string) => getDb().listAlertRules(tenantId, { projectId });

  /** A project with the starter rules (made the way a person does it), and the rules' ids. */
  async function projectWithStarters(name: string): Promise<{ projectId: string; ruleIds: string[] }> {
    const res = await createViaDashboard({ name });
    expect(res.statusCode).toBe(201);
    const projectId = String(parseJsonBody<Json>(res.body).project._id);
    const ruleIds = (await rulesOf(projectId)).map((rule) => String(rule._id));
    expect(ruleIds).toHaveLength(5);
    return { projectId, ruleIds };
  }

  async function addIncident(projectId: string, ruleId: string, status: IIncident['status'], over: Partial<IIncident> = {}) {
    return getDb().createIncident({
      tenantId,
      projectId,
      alertEventId: `evt-${uid()}`,
      ruleId,
      ruleName: 'Agent error rate above 20%',
      metric: 'agent_error_rate',
      threshold: 20,
      actualValue: 35,
      severity: 'warning',
      status,
      notes: [],
      firedAt: new Date('2026-10-01T10:00:00.000Z'),
      ...over,
    });
  }

  const statusOfIncident = async (id: unknown) => (await getDb().findIncidentById(String(id)))?.status;
  const incidentsOf = (projectId: string, status: IIncident['status']) =>
    getDb().listIncidents(tenantId, { projectId, status, limit: 200 });

  // ── creating a project ─────────────────────────────────────────────────────

  describe('creating a project', () => {
    it('adds the five starter rules, enabled and marked, to a project created from the dashboard', async () => {
      const res = await createViaDashboard({ name: 'Alpha Starters' });

      expect(res.statusCode).toBe(201);
      const body = parseJsonBody<Json>(res.body);
      expect(body).toMatchObject({ warnings: [], starterAlerts: 5 });

      const rules = await rulesOf(String(body.project._id));
      expect(rules.map((rule) => rule.starter?.key).sort()).toEqual([...STARTER_ALERT_KEYS].sort());
      for (const rule of rules) {
        const def = STARTER_ALERTS.find((d) => d.key === rule.starter?.key)!;
        expect(rule).toMatchObject({
          tenantId,
          projectId: String(body.project._id),
          name: def.name,
          module: def.module,
          metric: def.metric,
          enabled: true,
          windowMinutes: 30,
          cooldownMinutes: 120,
          condition: { mode: 'threshold', operator: 'gt', threshold: def.threshold, forMinutes: 10, minSamples: 20 },
          entity: { entityType: def.entityType, mode: 'all' },
          starter: { key: def.key, version: 1 },
          createdBy: String(owner._id),
        });
        expect(rule.channels).toEqual([
          { id: expect.stringMatching(/^ch_[0-9a-f]{12}$/), type: 'email', recipients: [], audience: 'project_admins' },
        ]);
      }
    });

    it('adds none with starterAlerts: false', async () => {
      const res = await createViaDashboard({ name: 'Quiet Project', starterAlerts: false });
      expect(res.statusCode).toBe(201);
      const body = parseJsonBody<Json>(res.body);
      expect(body.starterAlerts).toBe(0);
      expect(await rulesOf(String(body.project._id))).toEqual([]);
    });

    it('follows the installation default when the request does not say, and the request when it does', async () => {
      process.env.ALERT_STARTER_RULES_ON_CREATE = 'false';
      reloadConfig();

      const off = parseJsonBody<Json>((await createViaDashboard({ name: 'Default Off' })).body);
      expect(off.starterAlerts).toBe(0);
      expect(await rulesOf(String(off.project._id))).toEqual([]);

      const asked = parseJsonBody<Json>((await createViaDashboard({ name: 'Asked For Them', starterAlerts: true })).body);
      expect(asked.starterAlerts).toBe(5);
      expect(await rulesOf(String(asked.project._id))).toHaveLength(5);
    });

    it('adds the rules to a project of the client API only on request', async () => {
      const plain = await createViaClientApi({ name: 'Integration Plain' });
      expect(plain.statusCode).toBe(201);
      const plainBody = parseJsonBody<Json>(plain.body);
      expect(plainBody).not.toHaveProperty('starterAlerts');
      expect(await rulesOf(String(plainBody.project._id))).toEqual([]);

      const asked = await createViaClientApi({ name: 'Integration With Rules', starterAlerts: true });
      expect(asked.statusCode).toBe(201);
      const askedBody = parseJsonBody<Json>(asked.body);
      expect(askedBody.starterAlerts).toBe(5);
      const rules = await rulesOf(String(askedBody.project._id));
      expect(rules).toHaveLength(5);
      expect(rules.every((rule) => rule.createdBy === String(owner._id) && rule.starter?.version === 1)).toBe(true);
    });

    it('adds nothing a second time: the rules of a project are never doubled', async () => {
      const { projectId } = await projectWithStarters('Seeded Once');
      expect(await seedStarterAlerts(tenantDbName, tenantId, projectId, String(owner._id))).toBe(0);
      expect(await rulesOf(projectId)).toHaveLength(5);
    });

    it('adds the rules to the project it creates and to no other', async () => {
      const before = await rulesOf(homeProjectId);
      const { projectId } = await projectWithStarters('Only Here');
      expect(await rulesOf(homeProjectId)).toHaveLength(before.length);
      expect(await rulesOf(projectId)).toHaveLength(5);
    });
  });

  // ── deleting a project ─────────────────────────────────────────────────────

  const surfaces: Array<[string, (projectId: string) => ReturnType<typeof deleteViaDashboard>]> = [
    ['dashboard', (projectId) => deleteViaDashboard(projectId)],
    ['client API', (projectId) => deleteViaClientApi(projectId)],
  ];

  describe.each(surfaces)('deleting a project: %s', (_label, remove) => {
    it('removes its rules and closes its open, acknowledged and investigating incidents, and nothing else', async () => {
      const doomed = await projectWithStarters(`Doomed ${uid()}`);
      const kept = await projectWithStarters(`Kept ${uid()}`);
      const [ruleId] = doomed.ruleIds;

      const open = await addIncident(doomed.projectId, ruleId, 'open', { snoozedUntil: new Date(Date.now() + 3_600_000), snoozedBy: 'someone' });
      const acknowledged = await addIncident(doomed.projectId, ruleId, 'acknowledged');
      const investigating = await addIncident(doomed.projectId, ruleId, 'investigating');
      const resolved = await addIncident(doomed.projectId, ruleId, 'resolved', { resolvedAt: new Date('2026-10-02T10:00:00.000Z') });
      const closed = await addIncident(doomed.projectId, ruleId, 'closed', { closedAt: new Date('2026-10-03T10:00:00.000Z') });
      const keptOpen = await addIncident(kept.projectId, kept.ruleIds[0], 'open');
      const event = await getDb().createAlertEvent({
        tenantId, projectId: doomed.projectId, ruleId, ruleName: 'Agent error rate above 20%', metric: 'agent_error_rate',
        threshold: 20, actualValue: 35, status: 'fired', channels: [], firedAt: new Date('2026-10-01T10:00:00.000Z'),
      });
      await getDb().createAlertDeliveries([{
        tenantId, projectId: doomed.projectId, ruleId, incidentId: String(open._id), eventId: String(event._id), channelId: 'ch_aaaaaaaaaaaa',
        channelKind: 'email', channelName: null, trigger: 'fire', status: 'sent', reason: null, error: null,
        attemptAt: new Date('2026-10-01T10:00:05.000Z'),
      }]);
      // a rule that is firing: its incident is noted when the rule goes
      await getDb().upsertAlertState({
        tenantId, projectId: doomed.projectId, ruleId, entityKey: 'agent-a', phase: 'firing', phaseSince: new Date(),
        breachStreak: 3, okStreak: 0, lastValue: 35, lastBaseline: null, lastSampleCount: 40, lastEvaluatedAt: new Date(),
        incidentId: String(open._id),
      } as never);

      const res = await remove(doomed.projectId);
      expect(res.statusCode).toBe(200);

      // the project and its rules are gone, the states with them
      expect(await getDb().findProjectById(doomed.projectId)).toBeNull();
      expect(await rulesOf(doomed.projectId)).toEqual([]);
      expect(await getDb().listAlertStates({ ruleId })).toEqual([]);

      // what someone still had to act on is closed, with the system's note
      for (const incident of [open, acknowledged, investigating]) {
        const found = await getDb().findIncidentById(String(incident._id));
        expect(found?.status).toBe('closed');
        expect(found?.closedAt).toBeInstanceOf(Date);
        expect(found?.snoozedUntil ?? null).toBeNull();
        expect(found?.notes.map((note) => note.content).pop()).toBe(CLOSING_NOTE);
        expect(found?.notes.every((note) => note.userId === 'system')).toBe(true);
      }
      expect((await getDb().findIncidentById(String(open._id)))?.notes.map((note) => note.content)).toEqual(['Rule deleted', CLOSING_NOTE]);

      // what was settled stays as it was
      expect(await statusOfIncident(resolved._id)).toBe('resolved');
      expect((await getDb().findIncidentById(String(resolved._id)))?.notes).toEqual([]);
      const closedAfter = await getDb().findIncidentById(String(closed._id));
      expect(closedAfter?.status).toBe('closed');
      expect(closedAfter?.closedAt?.toISOString()).toBe('2026-10-03T10:00:00.000Z');
      expect(closedAfter?.notes).toEqual([]);
      // the history stays: the event and the delivery log
      expect(await getDb().findAlertEventById(String(event._id))).not.toBeNull();
      expect(await getDb().listAlertDeliveries(tenantId, { incidentId: String(open._id), limit: 10 })).toHaveLength(1);

      // another project is untouched
      expect(await rulesOf(kept.projectId)).toHaveLength(5);
      expect(await statusOfIncident(keptOpen._id)).toBe('open');
    });

    it('closes more incidents than fit in a page', async () => {
      const doomed = await projectWithStarters(`Busy ${uid()}`);
      const [ruleId] = doomed.ruleIds;
      const ids: string[] = [];
      for (let i = 0; i < 230; i += 1) {
        ids.push(String((await addIncident(doomed.projectId, ruleId, i % 3 === 0 ? 'acknowledged' : 'open', { alertEventId: `evt-${uid()}-${i}` }))._id));
      }

      expect((await remove(doomed.projectId)).statusCode).toBe(200);

      expect(await incidentsOf(doomed.projectId, 'open')).toEqual([]);
      expect(await incidentsOf(doomed.projectId, 'acknowledged')).toEqual([]);
      const closed = await incidentsOf(doomed.projectId, 'closed');
      expect(closed).toHaveLength(200); // the page limit of this read; the rest are checked one by one below
      for (const id of ids) expect(await statusOfIncident(id)).toBe('closed');
    });

    it('is a plain delete for a project that never had rules or incidents', async () => {
      const created = await createViaDashboard({ name: `Bare ${uid()}`, starterAlerts: false });
      const projectId = String(parseJsonBody<Json>(created.body).project._id);
      expect((await remove(projectId)).statusCode).toBe(200);
      expect(await getDb().findProjectById(projectId)).toBeNull();
    });
  });
});
