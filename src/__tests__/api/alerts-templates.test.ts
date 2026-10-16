/**
 * HTTP-level tests for the default alert rules on the LIVE alerts dashboard plugin (`plugins/alerts.ts`), injected over
 * real SQLite and the real alert services. (The sibling alerts-rules.test.ts drives the unmounted `routes/**` handlers,
 * which have no template routes, so there is nothing to mock-drive there.) Spies check what the routes hand to the
 * services; the rest is read back through the API and the store.
 *
 * The app parses JSON bodies the way the server does (`registerBodyParsers`: the raw string, so an empty JSON body
 * reaches the handler as ''), not with Fastify's default parser, which refuses an empty JSON body before any handler.
 *
 * Routes covered (method + path, as the endpoint-coverage gate reads them):
 *   GET    /alerts/templates
 *   POST   /alerts/templates
 *   POST   /alerts/rules              (`templateKey`: the rule keeps the template mark)
 *   GET    /alerts/rules, /alerts/rules/:ruleId, PUT/PATCH/DELETE /alerts/rules/:ruleId (the mark across edits)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + tmp dir BEFORE getDatabase() is imported.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-alerts-templates-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'alerts_templates_main';

let currentProjectId = 'default-rules-project-0';

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status = 400;
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn(async (ctx: { tenantId: string; userId: string }) => ({
      projectId: currentProjectId,
      project: { _id: currentProjectId, tenantId: ctx.tenantId, name: 'Default Rules Project', key: 'template', status: 'active' },
      user: { _id: ctx.userId, tenantId: ctx.tenantId, email: 'owner@example.com', role: 'owner', status: 'active' },
      userProject: null,
    })),
    requireProjectContext: vi.fn(),
  };
});

// Outbound: nothing leaves the process.
vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: vi.fn(async (url: string) => new URL(url)),
  safeFetch: vi.fn(),
}));
vi.mock('@/lib/services/alerts/channels', () => ({
  dispatchNotification: vi.fn(async () => []),
}));

import type { FastifyPluginAsync } from 'fastify';
import { reloadConfig } from '@/lib/core/config';
import { getMetricDef } from '@/lib/services/alerts/metricCatalog';
import { disconnectDatabase, getDatabase, getTenantDatabase } from '@/lib/database';
import { AlertService } from '@/lib/services/alerts';
import { resetAlertEmailUserCache } from '@/lib/services/alerts/channels/emailChannel';
import {
  ALERT_TEMPLATES,
  DEFAULT_ALERT_TEMPLATE_KEYS,
  AlertTemplateService,
  templateRuleInput,
} from '@/lib/services/alerts/alertTemplates';
import { ProjectContextError, resolveProjectContext } from '@/lib/services/projects/projectContext';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { alertsApiPlugin } from '@/server/api/plugins/alerts';
import { registerBodyParsers } from '@/server/app';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const DEFAULT_TEMPLATES = ALERT_TEMPLATES.filter((def) => def.default);
const TENANT_DB_NAME = 'alerts_templates_tenant';
const TENANT_ID = 'tenant-templates-1';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const users: Record<'owner' | 'viewer' | 'blocked' | 'padmin', string> = { owner: '', viewer: '', blocked: '', padmin: '' };

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let projectSeq = 0;

const headersFor = (who: keyof typeof users, json: boolean): Record<string, string> => ({
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'templates',
  'x-user-id': users[who],
  'x-user-email': `${who}@example.com`,
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
  ...(json ? { 'content-type': 'application/json' } : {}),
});

/** A call as one of the users; a body goes out as JSON, no body goes out without a content type. */
async function callAs(who: keyof typeof users, method: Method, url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url: `/api${url}`,
    headers: headersFor(who, body !== undefined),
    ...(body === undefined ? {} : { payload: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: res.statusCode, body: (res.body ? parseJsonBody<Json>(res.body) : {}) as Json };
}

const call = (method: Method, url: string, body?: unknown) => callAs('owner', method, url, body);

/** A rule of the form's own shape (any rule of the project, not a template). */
const ruleBody = (overrides: Json = {}): Json => ({
  name: 'Agent errors (mine)',
  module: 'agents',
  metric: 'agent_error_rate',
  condition: { operator: 'gt', threshold: 10 },
  windowMinutes: 15,
  entity: { entityType: 'agent', mode: 'all' },
  channels: [{ type: 'email', recipients: ['ops@acme.com'] }],
  ...overrides,
});

async function createRule(overrides: Json = {}): Promise<Json> {
  const res = await call('POST', '/alerts/rules', ruleBody(overrides));
  expect(res.status).toBe(201);
  return res.body.rule;
}

const listRules = async (): Promise<Json[]> => (await call('GET', '/alerts/rules')).body.rules;
const templates = async (): Promise<Json> => (await call('GET', '/alerts/templates')).body;
const stateOf = (list: Json, key: string): Json => list.items.find((item: Json) => item.key === key);

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.createTenant({
    companyName: 'Alerts Templates Test',
    slug: 'alerts-templates-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  await db.switchToTenant(TENANT_DB_NAME);
  const person = (name: string, extra: Record<string, unknown> = {}) => db.createUser({
    tenantId: TENANT_ID,
    email: `${name}@example.com`,
    name,
    password: '$2b$10$x',
    role: 'user',
    licenseId: 'FREE',
    features: [],
    ...extra,
  });
  users.owner = String((await person('owner', { role: 'owner' }))._id);
  users.viewer = String((await person('viewer', { servicePermissions: { alerts: 'read' } }))._id);
  users.blocked = String((await person('blocked', { servicePermissions: { alerts: 'none' } }))._id);
  users.padmin = String((await person('padmin'))._id);

  // The server's own body parsers (the raw JSON string), under the same /api prefix as the other API tests.
  const serverBodies: FastifyPluginAsync = async (instance) => {
    registerBodyParsers(instance);
    await instance.register(alertsApiPlugin);
  };
  app = await createFastifyApiTestApp(serverBodies);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // every test gets a project of its own: the store outlives the tests
  projectSeq += 1;
  currentProjectId = `default-rules-project-${projectSeq}`;
  resetRateLimitStore();
  resetAlertEmailUserCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ALERT_DEFAULT_RULES_ON_CREATE;
  reloadConfig();
});

describe('GET /alerts/templates', () => {
  it('lists the whole catalog of a project without rules, with what adding each creates', async () => {
    const res = await call('GET', '/alerts/templates');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1, projectAdminRecipients: 0, defaultRulesOnNewProjects: true });
    expect(res.body.items.map((item: Json) => item.key)).toEqual(ALERT_TEMPLATES.map((def) => def.key));
    expect(res.body.items.filter((item: Json) => item.default).map((item: Json) => item.key)).toEqual([...DEFAULT_ALERT_TEMPLATE_KEYS]);
    for (const [index, item] of res.body.items.entries()) {
      const def = ALERT_TEMPLATES[index];
      expect(item).toMatchObject({
        key: def.key,
        version: 1,
        category: def.category,
        module: def.module,
        metric: def.metric,
        mode: def.condition.mode,
        default: def.default === true,
        name: def.name,
        description: def.description,
        state: 'available',
      });
      // Enterprise modes are listed too, with the reason they cannot be added here
      expect(item.availability).toEqual(
        def.condition.mode === 'baseline' || def.condition.mode === 'slo_burn'
          ? { available: false, reason: 'not_enterprise_build' }
          : { available: true },
      );
      expect(item.rule).toBeUndefined();
      // the prefill the rule form takes, exactly as the service defines it
      expect(item.input).toEqual(JSON.parse(JSON.stringify(templateRuleInput(def))));
    }
  });

  it('answers for the active project: the service gets the tenant database, tenant and project of the request', async () => {
    const list = vi.spyOn(AlertTemplateService, 'list');
    await call('GET', '/alerts/templates');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(TENANT_DB_NAME, TENANT_ID, currentProjectId);
  });

  it('reports a template as added, with its rule, once it was added, and only in that project', async () => {
    const added = await call('POST', '/alerts/templates', { keys: ['model-errors'] });
    const ruleId = added.body.created[0]._id;

    const list = await templates();
    expect(stateOf(list, 'model-errors')).toMatchObject({
      state: 'added',
      rule: { id: ruleId, name: 'Model error rate above 20%', enabled: true },
    });
    expect(list.items.filter((item: Json) => item.state === 'available')).toHaveLength(ALERT_TEMPLATES.length - 1);

    currentProjectId = `${currentProjectId}-other`;
    expect((await templates()).items.every((item: Json) => item.state === 'available')).toBe(true);
  });

  it('reports a template as covered by another enabled rule on the same metric over every entity', async () => {
    const mine = await createRule();

    const list = await templates();
    expect(stateOf(list, 'agent-errors')).toMatchObject({
      state: 'covered',
      rule: { id: mine._id, name: 'Agent errors (mine)', enabled: true },
    });
    expect(list.items.filter((item: Json) => item.state === 'covered').map((item: Json) => item.key)).toEqual(['agent-errors']);
    expect(list.items.filter((item: Json) => item.default && item.state === 'available').map((item: Json) => item.key))
      .toEqual(['model-errors', 'kb-errors', 'mcp-errors', 'tool-errors']);
  });

  it('does not count a rule that is disabled, that watches selected entities or another metric as covering', async () => {
    const disabled = await createRule();
    await call('PATCH', `/alerts/rules/${disabled._id}`, { enabled: false });
    expect(stateOf(await templates(), 'agent-errors').state).toBe('available');

    await createRule({ name: 'Pulse only', entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] } });
    expect(stateOf(await templates(), 'agent-errors').state).toBe('available');

    await createRule({ name: 'Sessions', metric: 'agent_sessions', condition: { operator: 'gt', threshold: 100 } });
    expect(stateOf(await templates(), 'agent-errors').state).toBe('available');
  });

  it('counts the project admins the rules would mail', async () => {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    await db.upsertUserProject({
      tenantId: TENANT_ID, userId: users.padmin, projectId: currentProjectId, role: 'project_admin', invitedBy: users.owner,
    });
    await db.upsertUserProject({
      tenantId: TENANT_ID, userId: users.viewer, projectId: currentProjectId, role: 'member', invitedBy: users.owner,
    });

    expect((await templates()).projectAdminRecipients).toBe(1);
    // another project has none: its rules go to the owners and admins
    currentProjectId = `${currentProjectId}-other`;
    expect((await templates()).projectAdminRecipients).toBe(0);
  });

  it('says whether new projects get the templates in this installation (ALERT_DEFAULT_RULES_ON_CREATE)', async () => {
    expect((await templates()).defaultRulesOnNewProjects).toBe(true);
    process.env.ALERT_DEFAULT_RULES_ON_CREATE = 'false';
    reloadConfig();
    expect((await templates()).defaultRulesOnNewProjects).toBe(false);
  });

  it('answers 400 without an active project and 500, without internals, when the service fails', async () => {
    vi.mocked(resolveProjectContext).mockRejectedValueOnce(new ProjectContextError('No active project'));
    const noProject = await call('GET', '/alerts/templates');
    expect(noProject.status).toBe(400);
    expect(noProject.body).toEqual({ error: 'No active project' });

    vi.spyOn(AlertTemplateService, 'list').mockRejectedValueOnce(new Error('secret database detail'));
    const failed = await call('GET', '/alerts/templates');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Internal error' });
  });
});

describe('POST /alerts/templates', () => {
  it('adds all five, enabled and marked as templates, when it has no body (201)', async () => {
    const res = await call('POST', '/alerts/templates');

    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.created).toHaveLength(5);
    for (const [index, rule] of res.body.created.entries()) {
      const def = DEFAULT_TEMPLATES[index];
      expect(rule).toMatchObject({
        name: def.name,
        description: def.description,
        module: def.module,
        metric: def.metric,
        projectId: currentProjectId,
        enabled: true,
        severity: 'auto',
        notifyOnResolve: true,
        windowMinutes: 30,
        cooldownMinutes: 120,
        condition: { mode: 'threshold', operator: 'gt', threshold: def.condition.threshold, forMinutes: 10, minSamples: 20 },
        entity: { entityType: getMetricDef(def.metric)?.entityType, mode: 'all' },
        template: { key: def.key, version: def.version },
        createdBy: users.owner,
      });
      // one email channel for the project admins, no address of its own
      expect(rule.channels).toEqual([{ id: expect.any(String), type: 'email', recipients: [], audience: 'project_admins' }]);
    }
  });

  it('stores them: the project lists the five rules, each with its mark, in the store and over the API', async () => {
    await call('POST', '/alerts/templates');

    const rules = await listRules();
    expect(rules).toHaveLength(5);
    expect(rules.map((rule) => rule.template?.key).sort()).toEqual([...DEFAULT_ALERT_TEMPLATE_KEYS].sort());

    const db = await getTenantDatabase(TENANT_DB_NAME);
    const stored = await db.listAlertRules(TENANT_ID, { projectId: currentProjectId });
    expect(stored).toHaveLength(5);
    expect(stored.every((rule) => rule.template?.version === 1 && rule.enabled)).toBe(true);

    const list = await templates();
    expect(list.items.filter((item: Json) => item.state === 'added').map((item: Json) => item.key)).toEqual([...DEFAULT_ALERT_TEMPLATE_KEYS]);
  });

  it.each([
    ['no body and no content type', undefined],
    ['an empty JSON body', ''],
    ['an empty object', {}],
    ['an object without keys', { somethingElse: true }],
  ] as const)('treats %s as "add what is available"', async (_label, body) => {
    const res = await call('POST', '/alerts/templates', body);
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(5);
  });

  it('hands the service the active project, the person and the keys, and leaves the keys out without a body', async () => {
    const apply = vi.spyOn(AlertTemplateService, 'apply');

    await call('POST', '/alerts/templates');
    expect(apply).toHaveBeenLastCalledWith(TENANT_DB_NAME, TENANT_ID, currentProjectId, users.owner, { keys: undefined });

    currentProjectId = `${currentProjectId}-keys`;
    await call('POST', '/alerts/templates', { keys: ['agent-errors', 'kb-errors'] });
    expect(apply).toHaveBeenLastCalledWith(TENANT_DB_NAME, TENANT_ID, currentProjectId, users.owner, { keys: ['agent-errors', 'kb-errors'] });
  });

  it('with keys, adds those only and leaves the others available', async () => {
    const res = await call('POST', '/alerts/templates', { keys: ['tool-errors', 'agent-errors'] });

    expect(res.status).toBe(201);
    expect(res.body.created.map((rule: Json) => rule.template.key).sort()).toEqual(['agent-errors', 'tool-errors']);
    expect(res.body.skipped).toEqual([]);
    expect(await listRules()).toHaveLength(2);

    const list = await templates();
    expect(list.items.filter((item: Json) => item.state === 'added').map((item: Json) => item.key).sort())
      .toEqual(['agent-errors', 'tool-errors']);
    expect(list.items.filter((item: Json) => item.state === 'available')).toHaveLength(ALERT_TEMPLATES.length - 2);
  });

  it('never adds a template twice: asking for one that exists answers 200 with it skipped', async () => {
    expect((await call('POST', '/alerts/templates', { keys: ['agent-errors'] })).status).toBe(201);

    const again = await call('POST', '/alerts/templates', { keys: ['agent-errors'] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ created: [], skipped: [{ key: 'agent-errors', reason: 'exists' }] });
    expect(await listRules()).toHaveLength(1);
  });

  it('answers 200 when there is nothing to add, naming every template as existing', async () => {
    expect((await call('POST', '/alerts/templates')).status).toBe(201);

    const again = await call('POST', '/alerts/templates');
    expect(again.status).toBe(200);
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toEqual(DEFAULT_ALERT_TEMPLATE_KEYS.map((key) => ({ key, reason: 'exists' })));
    expect(await listRules()).toHaveLength(5);
  });

  it('adds only the missing ones when some exist', async () => {
    await call('POST', '/alerts/templates', { keys: ['agent-errors', 'model-errors'] });

    const rest = await call('POST', '/alerts/templates');
    expect(rest.status).toBe(201);
    expect(rest.body.created.map((rule: Json) => rule.template.key).sort()).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
    expect(rest.body.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'exists' }]);
    expect(await listRules()).toHaveLength(5);
  });

  it('leaves a template covered by another rule out, unless it is asked for by key', async () => {
    const mine = await createRule();

    const all = await call('POST', '/alerts/templates');
    expect(all.status).toBe(201);
    expect(all.body.created.map((rule: Json) => rule.template.key)).not.toContain('agent-errors');
    expect(all.body.created).toHaveLength(4);
    expect(all.body.skipped).toEqual([{ key: 'agent-errors', reason: 'covered' }]);

    const asked = await call('POST', '/alerts/templates', { keys: ['agent-errors'] });
    expect(asked.status).toBe(201);
    expect(asked.body.created[0]).toMatchObject({ template: { key: 'agent-errors', version: 1 } });
    // next to the rule that covers it
    const rules = await listRules();
    expect(rules.map((rule) => rule._id)).toContain(mine._id);
    expect(rules.filter((rule) => rule.metric === 'agent_error_rate')).toHaveLength(2);
  });

  it('adds to the active project only', async () => {
    const first = currentProjectId;
    await call('POST', '/alerts/templates');
    currentProjectId = `${first}-second`;
    expect(await listRules()).toEqual([]);
    expect((await call('POST', '/alerts/templates', { keys: ['kb-errors'] })).body.created[0].projectId).toBe(currentProjectId);
    currentProjectId = first;
    expect(await listRules()).toHaveLength(5);
  });

  it('keeps a template added after it was disabled or edited, and adds it again once it was deleted', async () => {
    const first = await call('POST', '/alerts/templates', { keys: ['agent-errors'] });
    const ruleId = first.body.created[0]._id;

    // disabled: still added, not added again
    await call('PATCH', `/alerts/rules/${ruleId}`, { enabled: false });
    const disabled = await call('POST', '/alerts/templates', { keys: ['agent-errors'] });
    expect(disabled.status).toBe(200);
    expect(disabled.body.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }]);
    expect(stateOf(await templates(), 'agent-errors')).toMatchObject({ state: 'added', rule: { id: ruleId, enabled: false } });

    // edited: the mark stays
    const edited = await call('PUT', `/alerts/rules/${ruleId}`, { name: 'Our agent errors', condition: { operator: 'gt', threshold: 5 } });
    expect(edited.status).toBe(200);
    expect(edited.body.rule).toMatchObject({ name: 'Our agent errors', template: { key: 'agent-errors', version: 1 } });
    expect(stateOf(await templates(), 'agent-errors')).toMatchObject({ state: 'added', rule: { id: ruleId, name: 'Our agent errors' } });

    // deleted: available again, and added once more
    expect((await call('DELETE', `/alerts/rules/${ruleId}`)).status).toBe(200);
    expect(stateOf(await templates(), 'agent-errors').state).toBe('available');
    const readded = await call('POST', '/alerts/templates');
    expect(readded.status).toBe(201);
    expect(readded.body.created.map((rule: Json) => rule.template.key)).toContain('agent-errors');
  });

  it('adds each template once when two requests arrive together', async () => {
    const [a, b] = await Promise.all([call('POST', '/alerts/templates'), call('POST', '/alerts/templates')]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.created.length + b.body.created.length).toBe(5);
    expect(await listRules()).toHaveLength(5);
  });

  describe('refused bodies add nothing', () => {
    const rejected = async (body: unknown) => {
      const res = await call('POST', '/alerts/templates', body);
      expect(await listRules()).toEqual([]);
      return res;
    };

    it.each([
      ['an unknown key', { keys: ['nope'] }],
      ['a known key next to an unknown one', { keys: ['agent-errors', 'nope'] }],
      ['a key in the wrong case', { keys: ['Agent-Errors'] }],
      ['an empty list', { keys: [] }],
      ['a string instead of a list', { keys: 'agent-errors' }],
      ['an object instead of a list', { keys: { 0: 'agent-errors' } }],
      ['a key that is not a string', { keys: [1] }],
      ['more keys than there are templates', { keys: [...ALERT_TEMPLATES.map((def) => def.key), 'agent-errors'] }],
    ])('answers 400 invalid_value for %s', async (_label, body) => {
      const res = await rejected(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_value');
      expect(typeof res.body.error).toBe('string');
    });

    it('names the key when it is unknown', async () => {
      const res = await rejected({ keys: ['nope'] });
      expect(res.body.error).toBe('Unknown template key: nope');
    });

    it.each([
      ['null', 'null'],
      ['a list', '[]'],
      ['a number', '5'],
      ['a string', '"agent-errors"'],
    ])('answers 400 invalid_body for a JSON body that is %s', async (_label, raw) => {
      const res = await rejected(raw);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_body');
    });

    it('answers 400 for a body that is not JSON', async () => {
      const res = await rejected('{nope');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Request body must be valid JSON' });
    });
  });

  it('answers 400 without an active project and adds nothing', async () => {
    vi.mocked(resolveProjectContext).mockRejectedValueOnce(new ProjectContextError('No active project'));
    const res = await call('POST', '/alerts/templates');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No active project' });
    expect(await listRules()).toEqual([]);
  });

  it('answers 500, without internals, when the service fails unexpectedly', async () => {
    vi.spyOn(AlertTemplateService, 'apply').mockRejectedValueOnce(new Error('secret database detail'));
    const res = await call('POST', '/alerts/templates');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal error' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('keeps what was added when one rule cannot be written, and a retry completes the set', async () => {
    const real = AlertService.createRule.bind(AlertService);
    let calls = 0;
    vi.spyOn(AlertService, 'createRule').mockImplementation(async (...args: Parameters<typeof AlertService.createRule>) => {
      calls += 1;
      if (calls === 3) throw new Error('disk full');
      return real(...args);
    });

    const failed = await call('POST', '/alerts/templates');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Internal error' });
    // the first two went in before the failure
    expect(await listRules()).toHaveLength(2);

    vi.restoreAllMocks();
    const retry = await call('POST', '/alerts/templates');
    expect(retry.status).toBe(201);
    expect(retry.body.created).toHaveLength(3);
    expect(retry.body.skipped).toHaveLength(2);
    expect(await listRules()).toHaveLength(5);
  });
});

describe('POST /alerts/rules with a templateKey', () => {
  const customised = (overrides: Json = {}): Json => ({
    ...JSON.parse(JSON.stringify(templateRuleInput(DEFAULT_TEMPLATES[0]))),
    name: 'Agent errors, our way',
    condition: { mode: 'threshold', operator: 'gt', threshold: 35, forMinutes: 10, minSamples: 20 },
    channels: [{ type: 'email', recipients: ['oncall@acme.com'], audience: 'project_admins' }],
    ...overrides,
  });

  it('saves the rule with the template mark, and the mark is not an input of the rule', async () => {
    const res = await call('POST', '/alerts/rules', { ...customised(), templateKey: 'agent-errors' });

    expect(res.status).toBe(201);
    expect(res.body.rule).toMatchObject({
      name: 'Agent errors, our way',
      projectId: currentProjectId,
      template: { key: 'agent-errors', version: 1 },
      condition: { threshold: 35 },
    });
    expect(res.body.rule.channels[0]).toMatchObject({ type: 'email', recipients: ['oncall@acme.com'], audience: 'project_admins' });
    expect(res.body.rule).not.toHaveProperty('templateKey');

    const read = await call('GET', `/alerts/rules/${res.body.rule._id}`);
    expect(read.body.rule.template).toEqual({ key: 'agent-errors', version: 1 });
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const stored = await db.findAlertRuleById(String(res.body.rule._id));
    expect(stored?.template).toEqual({ key: 'agent-errors', version: 1 });
    expect(stored).not.toHaveProperty('templateKey');
  });

  it('makes the template added, and a later "add all" leaves it alone', async () => {
    const created = (await call('POST', '/alerts/rules', { ...customised(), templateKey: 'agent-errors' })).body.rule;

    expect(stateOf(await templates(), 'agent-errors')).toMatchObject({
      state: 'added',
      rule: { id: created._id, name: 'Agent errors, our way', enabled: true },
    });
    const all = await call('POST', '/alerts/templates');
    expect(all.body.created).toHaveLength(4);
    expect(all.body.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }]);
  });

  it('answers 409 template_exists when the project already has the template, and saves nothing more', async () => {
    expect((await call('POST', '/alerts/rules', { ...customised(), templateKey: 'agent-errors' })).status).toBe(201);

    const again = await call('POST', '/alerts/rules', { ...customised({ name: 'A second copy' }), templateKey: 'agent-errors' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'template_exists', error: 'This template is already added to the project' });
    expect(await listRules()).toHaveLength(1);

    // a template added by "add" counts too, and so does one that was disabled meanwhile
    expect((await call('POST', '/alerts/templates', { keys: ['model-errors'] })).status).toBe(201);
    const model = { ...customised({ module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }), templateKey: 'model-errors' };
    expect((await call('POST', '/alerts/rules', model)).status).toBe(409);
  });

  it('refuses a mark of a rule that is not on the template metric before it looks at the project', async () => {
    expect((await call('POST', '/alerts/templates', { keys: ['agent-errors'] })).status).toBe(201);
    const res = await call('POST', '/alerts/rules', {
      ...customised({ module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }),
      templateKey: 'agent-errors',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_value');
  });

  it('hands the service the body without the key, and the mark as the sixth argument', async () => {
    const create = vi.spyOn(AlertService, 'createRule');
    await call('POST', '/alerts/rules', { ...customised(), templateKey: 'agent-errors' });

    expect(create).toHaveBeenCalledTimes(1);
    const [dbName, tenantId, projectId, userId, input, options] = create.mock.calls[0];
    expect([dbName, tenantId, projectId, userId]).toEqual([TENANT_DB_NAME, TENANT_ID, currentProjectId, users.owner]);
    expect(input).not.toHaveProperty('templateKey');
    expect(input).toMatchObject({ name: 'Agent errors, our way' });
    expect(options).toEqual({ template: { key: 'agent-errors', version: 1 } });
  });

  it('adds no mark to a rule saved without a templateKey', async () => {
    const create = vi.spyOn(AlertService, 'createRule');
    const rule = await createRule();

    expect(rule.template ?? null).toBeNull();
    expect(create.mock.calls[0][5]).toBeUndefined();
    expect((await templates()).items.some((item: Json) => item.state === 'added')).toBe(false);
  });

  it.each([
    ['an unknown key', 'nope'],
    ['an empty string', ''],
    ['a key in the wrong case', 'AGENT-ERRORS'],
    ['a number', 42],
    ['a list of keys', ['agent-errors']],
    ['an object', { key: 'agent-errors' }],
  ])('answers 400 invalid_value for %s and saves nothing', async (_label, templateKey) => {
    const create = vi.spyOn(AlertService, 'createRule');
    const res = await call('POST', '/alerts/rules', { ...customised(), templateKey });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_value', error: expect.stringContaining('Unknown template key') });
    expect(create).not.toHaveBeenCalled();
    expect(await listRules()).toEqual([]);
  });

  it('answers 400 invalid_value when the rule watches another metric than the template', async () => {
    const create = vi.spyOn(AlertService, 'createRule');
    const res = await call('POST', '/alerts/rules', {
      ...customised({ module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }),
      templateKey: 'agent-errors',
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_value' });
    expect(create).not.toHaveBeenCalled();
    expect(await listRules()).toEqual([]);
  });

  it('validates the rule like any other: a bad rule with a good key is a 400 and has no mark', async () => {
    const res = await call('POST', '/alerts/rules', { ...customised({ windowMinutes: 7 }), templateKey: 'agent-errors' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_window');
    expect(await listRules()).toEqual([]);
    expect((await templates()).items.some((item: Json) => item.state === 'added')).toBe(false);
  });

  it('does not let a request body set the mark itself', async () => {
    const forged = await call('POST', '/alerts/rules', ruleBody({ template: { key: 'agent-errors', version: 9 } }));
    expect(forged.status).toBe(201);
    expect(forged.body.rule.template ?? null).toBeNull();
    expect(stateOf(await templates(), 'agent-errors').state).toBe('covered');

    // nor can an update add it to a rule, or change the version of a real one
    const plain = forged.body.rule;
    const put = await call('PUT', `/alerts/rules/${plain._id}`, { template: { key: 'agent-errors', version: 9 } });
    expect(put.status).toBe(200);
    expect(put.body.rule.template ?? null).toBeNull();

    const template = (await call('POST', '/alerts/templates', { keys: ['model-errors'] })).body.created[0];
    const putTemplate = await call('PUT', `/alerts/rules/${template._id}`, { template: { key: 'tool-errors', version: 9 } });
    expect(putTemplate.status).toBe(200);
    expect(putTemplate.body.rule.template).toEqual({ key: 'model-errors', version: 1 });
  });

  it('clears the mark when the rule is retargeted to another metric, and the template can be added again', async () => {
    const rule = (await call('POST', '/alerts/templates', { keys: ['agent-errors'] })).body.created[0];

    const moved = await call('PUT', `/alerts/rules/${rule._id}`, { metric: 'agent_p95_duration_ms', condition: { operator: 'gt', threshold: 60_000 } });
    expect(moved.status).toBe(200);
    expect(moved.body.rule.metric).toBe('agent_p95_duration_ms');
    expect(moved.body.rule.template ?? null).toBeNull();
    const db = await getTenantDatabase(TENANT_DB_NAME);
    expect((await db.findAlertRuleById(String(rule._id)))?.template ?? null).toBeNull();
    expect(stateOf(await templates(), 'agent-errors').state).toBe('available');

    const again = await call('POST', '/alerts/templates', { keys: ['agent-errors'] });
    expect(again.status).toBe(201);
    expect(again.body.created[0].template).toEqual({ key: 'agent-errors', version: 1 });
  });

  it('clears the mark when the rule is moved to another module', async () => {
    const rule = (await call('POST', '/alerts/templates', { keys: ['agent-errors'] })).body.created[0];
    const moved = await call('PUT', `/alerts/rules/${rule._id}`, {
      module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.rule).toMatchObject({ module: 'models', metric: 'model_error_rate' });
    expect(moved.body.rule.template ?? null).toBeNull();
  });

  it('keeps the mark when only the condition, the target or the name change on the same metric', async () => {
    const rule = (await call('POST', '/alerts/templates', { keys: ['agent-errors'] })).body.created[0];
    const edited = await call('PUT', `/alerts/rules/${rule._id}`, {
      name: 'Pulse only', condition: { operator: 'gt', threshold: 50 }, entity: { entityType: 'agent', mode: 'selected', keys: ['pulse'] },
    });
    expect(edited.body.rule).toMatchObject({ name: 'Pulse only', template: { key: 'agent-errors', version: 1 } });
    // still the template's rule, so it still counts as added although it watches one agent only
    expect(stateOf(await templates(), 'agent-errors')).toMatchObject({ state: 'added', rule: { id: rule._id } });
  });

  it('keeps the mark when the rule is toggled or edited', async () => {
    const rule = (await call('POST', '/alerts/rules', { ...customised(), templateKey: 'agent-errors' })).body.rule;

    const off = await call('PATCH', `/alerts/rules/${rule._id}`, { enabled: false });
    expect(off.body.rule).toMatchObject({ enabled: false, template: { key: 'agent-errors', version: 1 } });
    const renamed = await call('PUT', `/alerts/rules/${rule._id}`, { name: 'Renamed', windowMinutes: 60 });
    expect(renamed.body.rule).toMatchObject({ name: 'Renamed', windowMinutes: 60, template: { key: 'agent-errors', version: 1 } });
    expect((await listRules()).find((r) => r._id === rule._id)?.template).toEqual({ key: 'agent-errors', version: 1 });
  });
});

describe('templates outside the default set', () => {
  it('adds a picked template of the catalog, with its own window, cooldown and condition', async () => {
    const res = await call('POST', '/alerts/templates', { keys: ['model-latency', 'kb-ingestion-failures'] });
    expect(res.status).toBe(201);
    const byKey = Object.fromEntries(res.body.created.map((rule: Json) => [rule.template.key, rule]));
    expect(byKey['model-latency']).toMatchObject({
      module: 'models', metric: 'model_p95_latency_ms', windowMinutes: 30, cooldownMinutes: 120,
      condition: { mode: 'threshold', operator: 'gt', threshold: 20_000, forMinutes: 10, minSamples: 20 },
      entity: { entityType: 'model', mode: 'all' },
    });
    expect(byKey['kb-ingestion-failures']).toMatchObject({
      module: 'rag', metric: 'rag_failed_documents', windowMinutes: 60, cooldownMinutes: 360,
      condition: { mode: 'threshold', operator: 'gt', threshold: 0, forMinutes: 0, minSamples: 1 },
    });
    expect(byKey['kb-ingestion-failures'].entity).toBeUndefined();
  });

  it('skips a template this build cannot run, as unavailable, and still adds the others picked with it', async () => {
    const res = await call('POST', '/alerts/templates', { keys: ['agent-cost-spike', 'agent-daily-spend'] });
    expect(res.status).toBe(201);
    expect(res.body.created.map((rule: Json) => rule.template.key)).toEqual(['agent-daily-spend']);
    expect(res.body.skipped).toEqual([{ key: 'agent-cost-spike', reason: 'unavailable' }]);

    const only = await call('POST', '/alerts/templates', { keys: ['model-error-budget'] });
    expect(only.status).toBe(200);
    expect(only.body).toEqual({ created: [], skipped: [{ key: 'model-error-budget', reason: 'unavailable' }] });
  });

  it('adds a covered template when it is picked, and leaves it out of the default set', async () => {
    await createRule();
    const all = await call('POST', '/alerts/templates');
    expect(all.body.skipped).toEqual([{ key: 'agent-errors', reason: 'covered' }]);

    const picked = await call('POST', '/alerts/templates', { keys: ['agent-errors'] });
    expect(picked.status).toBe(201);
    expect(picked.body.created[0].template).toEqual({ key: 'agent-errors', version: 1 });
  });

  it('answers 409 busy when another process holds the project lock for longer than the wait', async () => {
    const { getCache } = await import('@/lib/core/cache');
    const cache = await getCache();
    const key = `alerts:templates:${TENANT_DB_NAME}:${currentProjectId}`;
    const token = await cache.acquireLock(key, 30);
    // only a cache that really locks (memory, redis) can be busy: with CACHE_PROVIDER=none every request is granted
    expect(token).toBeDefined();
    expect(await cache.acquireLock(key, 30)).toBeUndefined();
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const pending = call('POST', '/alerts/templates');
      await vi.advanceTimersByTimeAsync(5_500);
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'busy' });
      expect(await listRules()).toEqual([]);
    } finally {
      vi.useRealTimers();
      await cache.releaseLock(key, token as string);
    }
  });
});

describe('who may use the template routes', () => {
  it('lets a person with read access to alerts list the templates, not add them', async () => {
    const list = await callAs('viewer', 'GET', '/alerts/templates');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(ALERT_TEMPLATES.length);

    const add = await callAs('viewer', 'POST', '/alerts/templates');
    expect(add.status).toBe(403);
    const keyed = await callAs('viewer', 'POST', '/alerts/templates', { keys: ['agent-errors'] });
    expect(keyed.status).toBe(403);
    const rule = await callAs('viewer', 'POST', '/alerts/rules', { ...ruleBody(), templateKey: 'agent-errors' });
    expect(rule.status).toBe(403);
    expect(await listRules()).toEqual([]);
  });

  it('keeps a person without access to alerts out of both routes', async () => {
    expect((await callAs('blocked', 'GET', '/alerts/templates')).status).toBe(403);
    expect((await callAs('blocked', 'POST', '/alerts/templates')).status).toBe(403);
    expect(await listRules()).toEqual([]);
  });

  it('lets a person who may write alerts add the templates, as themselves', async () => {
    // padmin has the default permission of a person of the workspace: write on alerts
    const res = await callAs('padmin', 'POST', '/alerts/templates', { keys: ['agent-errors'] });
    expect(res.status).toBe(201);
    expect(res.body.created[0].createdBy).toBe(users.padmin);
  });
});
