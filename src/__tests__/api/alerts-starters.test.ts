/**
 * HTTP-level tests for the starter alert rules on the LIVE alerts dashboard plugin (`plugins/alerts.ts`), injected over
 * real SQLite and the real alert services. (The sibling alerts-rules.test.ts drives the unmounted `routes/**` handlers,
 * which have no starter routes, so there is nothing to mock-drive there.) Spies check what the routes hand to the
 * services; the rest is read back through the API and the store.
 *
 * The app parses JSON bodies the way the server does (`registerBodyParsers`: the raw string, so an empty JSON body
 * reaches the handler as ''), not with Fastify's default parser, which refuses an empty JSON body before any handler.
 *
 * Routes covered (method + path, as the endpoint-coverage gate reads them):
 *   GET    /alerts/starters
 *   POST   /alerts/starters
 *   POST   /alerts/rules              (`starterKey`: the rule keeps the starter mark)
 *   GET    /alerts/rules, /alerts/rules/:ruleId, PUT/PATCH/DELETE /alerts/rules/:ruleId (the mark across edits)
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + tmp dir BEFORE getDatabase() is imported.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-alerts-starters-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'alerts_starters_main';

let currentProjectId = 'starter-project-0';

vi.mock('@/lib/services/projects/projectContext', () => {
  class ProjectContextError extends Error {
    status = 400;
  }
  return {
    ProjectContextError,
    resolveProjectContext: vi.fn(async (ctx: { tenantId: string; userId: string }) => ({
      projectId: currentProjectId,
      project: { _id: currentProjectId, tenantId: ctx.tenantId, name: 'Starter Project', key: 'starter', status: 'active' },
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
import { disconnectDatabase, getDatabase, getTenantDatabase } from '@/lib/database';
import { AlertService } from '@/lib/services/alerts';
import { resetAlertEmailUserCache } from '@/lib/services/alerts/channels/emailChannel';
import {
  STARTER_ALERT_KEYS,
  STARTER_ALERTS,
  StarterAlertService,
  starterRuleInput,
} from '@/lib/services/alerts/starterAlerts';
import { ProjectContextError, resolveProjectContext } from '@/lib/services/projects/projectContext';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { alertsApiPlugin } from '@/server/api/plugins/alerts';
import { registerBodyParsers } from '@/server/app';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'alerts_starters_tenant';
const TENANT_ID = 'tenant-starters-1';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const users: Record<'owner' | 'viewer' | 'blocked' | 'padmin', string> = { owner: '', viewer: '', blocked: '', padmin: '' };

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let projectSeq = 0;

const headersFor = (who: keyof typeof users, json: boolean): Record<string, string> => ({
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'starters',
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

/** A rule of the form's own shape (any rule of the project, not a starter). */
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
const starters = async (): Promise<Json> => (await call('GET', '/alerts/starters')).body;
const stateOf = (list: Json, key: string): Json => list.items.find((item: Json) => item.key === key);

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.createTenant({
    companyName: 'Alerts Starters Test',
    slug: 'alerts-starters-test',
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
  currentProjectId = `starter-project-${projectSeq}`;
  resetRateLimitStore();
  resetAlertEmailUserCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ALERT_STARTER_RULES_ON_CREATE;
  reloadConfig();
});

describe('GET /alerts/starters', () => {
  it('lists the five starters of a project without rules, all available, with what adding them creates', async () => {
    const res = await call('GET', '/alerts/starters');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 1, projectAdminRecipients: 0, addedToNewProjects: true });
    expect(res.body.items.map((item: Json) => item.key)).toEqual([...STARTER_ALERT_KEYS]);
    for (const [index, item] of res.body.items.entries()) {
      const def = STARTER_ALERTS[index];
      expect(item).toMatchObject({
        key: def.key,
        version: 1,
        module: def.module,
        metric: def.metric,
        name: def.name,
        description: def.description,
        threshold: def.threshold,
        windowMinutes: 30,
        forMinutes: 10,
        minSamples: 20,
        cooldownMinutes: 120,
        state: 'available',
      });
      expect(item.rule).toBeUndefined();
      // the prefill the rule form takes, exactly as the service defines it
      expect(item.input).toEqual(JSON.parse(JSON.stringify(starterRuleInput(def))));
    }
  });

  it('answers for the active project: the service gets the tenant database, tenant and project of the request', async () => {
    const list = vi.spyOn(StarterAlertService, 'list');
    await call('GET', '/alerts/starters');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(TENANT_DB_NAME, TENANT_ID, currentProjectId);
  });

  it('reports a starter as added, with its rule, once it was added, and only in that project', async () => {
    const added = await call('POST', '/alerts/starters', { keys: ['model-errors'] });
    const ruleId = added.body.created[0]._id;

    const list = await starters();
    expect(stateOf(list, 'model-errors')).toMatchObject({
      state: 'added',
      rule: { id: ruleId, name: 'Model error rate above 20%', enabled: true },
    });
    expect(list.items.filter((item: Json) => item.state === 'available')).toHaveLength(4);

    currentProjectId = `${currentProjectId}-other`;
    expect((await starters()).items.every((item: Json) => item.state === 'available')).toBe(true);
  });

  it('reports a starter as covered by another enabled rule on the same metric over every entity', async () => {
    const mine = await createRule();

    const list = await starters();
    expect(stateOf(list, 'agent-errors')).toMatchObject({
      state: 'covered',
      rule: { id: mine._id, name: 'Agent errors (mine)', enabled: true },
    });
    expect(list.items.filter((item: Json) => item.state === 'available').map((item: Json) => item.key))
      .toEqual(['model-errors', 'kb-errors', 'mcp-errors', 'tool-errors']);
  });

  it('does not count a rule that is disabled, that watches selected entities or another metric as covering', async () => {
    const disabled = await createRule();
    await call('PATCH', `/alerts/rules/${disabled._id}`, { enabled: false });
    expect(stateOf(await starters(), 'agent-errors').state).toBe('available');

    await createRule({ name: 'Pulse only', entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] } });
    expect(stateOf(await starters(), 'agent-errors').state).toBe('available');

    await createRule({ name: 'Sessions', metric: 'agent_sessions', condition: { operator: 'gt', threshold: 100 } });
    expect(stateOf(await starters(), 'agent-errors').state).toBe('available');
  });

  it('counts the project admins the rules would mail', async () => {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    await db.upsertUserProject({
      tenantId: TENANT_ID, userId: users.padmin, projectId: currentProjectId, role: 'project_admin', invitedBy: users.owner,
    });
    await db.upsertUserProject({
      tenantId: TENANT_ID, userId: users.viewer, projectId: currentProjectId, role: 'member', invitedBy: users.owner,
    });

    expect((await starters()).projectAdminRecipients).toBe(1);
    // another project has none: its rules go to the owners and admins
    currentProjectId = `${currentProjectId}-other`;
    expect((await starters()).projectAdminRecipients).toBe(0);
  });

  it('says whether new projects get the starters in this installation (ALERT_STARTER_RULES_ON_CREATE)', async () => {
    expect((await starters()).addedToNewProjects).toBe(true);
    process.env.ALERT_STARTER_RULES_ON_CREATE = 'false';
    reloadConfig();
    expect((await starters()).addedToNewProjects).toBe(false);
  });

  it('answers 400 without an active project and 500, without internals, when the service fails', async () => {
    vi.mocked(resolveProjectContext).mockRejectedValueOnce(new ProjectContextError('No active project'));
    const noProject = await call('GET', '/alerts/starters');
    expect(noProject.status).toBe(400);
    expect(noProject.body).toEqual({ error: 'No active project' });

    vi.spyOn(StarterAlertService, 'list').mockRejectedValueOnce(new Error('secret database detail'));
    const failed = await call('GET', '/alerts/starters');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Internal error' });
  });
});

describe('POST /alerts/starters', () => {
  it('adds all five, enabled and marked as starters, when it has no body (201)', async () => {
    const res = await call('POST', '/alerts/starters');

    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.created).toHaveLength(5);
    for (const [index, rule] of res.body.created.entries()) {
      const def = STARTER_ALERTS[index];
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
        condition: { mode: 'threshold', operator: 'gt', threshold: def.threshold, forMinutes: 10, minSamples: 20 },
        entity: { entityType: def.entityType, mode: 'all' },
        starter: { key: def.key, version: def.version },
        createdBy: users.owner,
      });
      // one email channel for the project admins, no address of its own
      expect(rule.channels).toEqual([{ id: expect.any(String), type: 'email', recipients: [], audience: 'project_admins' }]);
    }
  });

  it('stores them: the project lists the five rules, each with its mark, in the store and over the API', async () => {
    await call('POST', '/alerts/starters');

    const rules = await listRules();
    expect(rules).toHaveLength(5);
    expect(rules.map((rule) => rule.starter?.key).sort()).toEqual([...STARTER_ALERT_KEYS].sort());

    const db = await getTenantDatabase(TENANT_DB_NAME);
    const stored = await db.listAlertRules(TENANT_ID, { projectId: currentProjectId });
    expect(stored).toHaveLength(5);
    expect(stored.every((rule) => rule.starter?.version === 1 && rule.enabled)).toBe(true);

    const list = await starters();
    expect(list.items.every((item: Json) => item.state === 'added')).toBe(true);
  });

  it.each([
    ['no body and no content type', undefined],
    ['an empty JSON body', ''],
    ['an empty object', {}],
    ['an object without keys', { somethingElse: true }],
  ] as const)('treats %s as "add what is available"', async (_label, body) => {
    const res = await call('POST', '/alerts/starters', body);
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(5);
  });

  it('hands the service the active project, the person and the keys, and leaves the keys out without a body', async () => {
    const apply = vi.spyOn(StarterAlertService, 'apply');

    await call('POST', '/alerts/starters');
    expect(apply).toHaveBeenLastCalledWith(TENANT_DB_NAME, TENANT_ID, currentProjectId, users.owner, { keys: undefined });

    currentProjectId = `${currentProjectId}-keys`;
    await call('POST', '/alerts/starters', { keys: ['agent-errors', 'kb-errors'] });
    expect(apply).toHaveBeenLastCalledWith(TENANT_DB_NAME, TENANT_ID, currentProjectId, users.owner, { keys: ['agent-errors', 'kb-errors'] });
  });

  it('with keys, adds those only and leaves the others available', async () => {
    const res = await call('POST', '/alerts/starters', { keys: ['tool-errors', 'agent-errors'] });

    expect(res.status).toBe(201);
    expect(res.body.created.map((rule: Json) => rule.starter.key).sort()).toEqual(['agent-errors', 'tool-errors']);
    expect(res.body.skipped).toEqual([]);
    expect(await listRules()).toHaveLength(2);

    const list = await starters();
    expect(list.items.filter((item: Json) => item.state === 'added').map((item: Json) => item.key).sort())
      .toEqual(['agent-errors', 'tool-errors']);
    expect(list.items.filter((item: Json) => item.state === 'available')).toHaveLength(3);
  });

  it('never adds a starter twice: asking for one that exists answers 200 with it skipped', async () => {
    expect((await call('POST', '/alerts/starters', { keys: ['agent-errors'] })).status).toBe(201);

    const again = await call('POST', '/alerts/starters', { keys: ['agent-errors'] });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ created: [], skipped: [{ key: 'agent-errors', reason: 'exists' }] });
    expect(await listRules()).toHaveLength(1);
  });

  it('answers 200 when there is nothing to add, naming every starter as existing', async () => {
    expect((await call('POST', '/alerts/starters')).status).toBe(201);

    const again = await call('POST', '/alerts/starters');
    expect(again.status).toBe(200);
    expect(again.body.created).toEqual([]);
    expect(again.body.skipped).toEqual(STARTER_ALERT_KEYS.map((key) => ({ key, reason: 'exists' })));
    expect(await listRules()).toHaveLength(5);
  });

  it('adds only the missing ones when some exist', async () => {
    await call('POST', '/alerts/starters', { keys: ['agent-errors', 'model-errors'] });

    const rest = await call('POST', '/alerts/starters');
    expect(rest.status).toBe(201);
    expect(rest.body.created.map((rule: Json) => rule.starter.key).sort()).toEqual(['kb-errors', 'mcp-errors', 'tool-errors']);
    expect(rest.body.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }, { key: 'model-errors', reason: 'exists' }]);
    expect(await listRules()).toHaveLength(5);
  });

  it('leaves a starter covered by another rule out, unless it is asked for by key', async () => {
    const mine = await createRule();

    const all = await call('POST', '/alerts/starters');
    expect(all.status).toBe(201);
    expect(all.body.created.map((rule: Json) => rule.starter.key)).not.toContain('agent-errors');
    expect(all.body.created).toHaveLength(4);
    expect(all.body.skipped).toEqual([{ key: 'agent-errors', reason: 'covered' }]);

    const asked = await call('POST', '/alerts/starters', { keys: ['agent-errors'] });
    expect(asked.status).toBe(201);
    expect(asked.body.created[0]).toMatchObject({ starter: { key: 'agent-errors', version: 1 } });
    // next to the rule that covers it
    const rules = await listRules();
    expect(rules.map((rule) => rule._id)).toContain(mine._id);
    expect(rules.filter((rule) => rule.metric === 'agent_error_rate')).toHaveLength(2);
  });

  it('adds to the active project only', async () => {
    const first = currentProjectId;
    await call('POST', '/alerts/starters');
    currentProjectId = `${first}-second`;
    expect(await listRules()).toEqual([]);
    expect((await call('POST', '/alerts/starters', { keys: ['kb-errors'] })).body.created[0].projectId).toBe(currentProjectId);
    currentProjectId = first;
    expect(await listRules()).toHaveLength(5);
  });

  it('keeps a starter added after it was disabled or edited, and adds it again once it was deleted', async () => {
    const first = await call('POST', '/alerts/starters', { keys: ['agent-errors'] });
    const ruleId = first.body.created[0]._id;

    // disabled: still added, not added again
    await call('PATCH', `/alerts/rules/${ruleId}`, { enabled: false });
    const disabled = await call('POST', '/alerts/starters', { keys: ['agent-errors'] });
    expect(disabled.status).toBe(200);
    expect(disabled.body.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }]);
    expect(stateOf(await starters(), 'agent-errors')).toMatchObject({ state: 'added', rule: { id: ruleId, enabled: false } });

    // edited: the mark stays
    const edited = await call('PUT', `/alerts/rules/${ruleId}`, { name: 'Our agent errors', condition: { operator: 'gt', threshold: 5 } });
    expect(edited.status).toBe(200);
    expect(edited.body.rule).toMatchObject({ name: 'Our agent errors', starter: { key: 'agent-errors', version: 1 } });
    expect(stateOf(await starters(), 'agent-errors')).toMatchObject({ state: 'added', rule: { id: ruleId, name: 'Our agent errors' } });

    // deleted: available again, and added once more
    expect((await call('DELETE', `/alerts/rules/${ruleId}`)).status).toBe(200);
    expect(stateOf(await starters(), 'agent-errors').state).toBe('available');
    const readded = await call('POST', '/alerts/starters');
    expect(readded.status).toBe(201);
    expect(readded.body.created.map((rule: Json) => rule.starter.key)).toContain('agent-errors');
  });

  it('adds each starter once when two requests arrive together', async () => {
    const [a, b] = await Promise.all([call('POST', '/alerts/starters'), call('POST', '/alerts/starters')]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.created.length + b.body.created.length).toBe(5);
    expect(await listRules()).toHaveLength(5);
  });

  describe('refused bodies add nothing', () => {
    const rejected = async (body: unknown) => {
      const res = await call('POST', '/alerts/starters', body);
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
      ['more keys than there are starters', { keys: [...STARTER_ALERT_KEYS, 'agent-errors'] }],
    ])('answers 400 invalid_value for %s', async (_label, body) => {
      const res = await rejected(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_value');
      expect(typeof res.body.error).toBe('string');
    });

    it('names the valid keys when a key is unknown', async () => {
      const res = await rejected({ keys: ['nope'] });
      for (const key of STARTER_ALERT_KEYS) expect(res.body.error).toContain(key);
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
    const res = await call('POST', '/alerts/starters');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No active project' });
    expect(await listRules()).toEqual([]);
  });

  it('answers 500, without internals, when the service fails unexpectedly', async () => {
    vi.spyOn(StarterAlertService, 'apply').mockRejectedValueOnce(new Error('secret database detail'));
    const res = await call('POST', '/alerts/starters');
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

    const failed = await call('POST', '/alerts/starters');
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Internal error' });
    // the first two went in before the failure
    expect(await listRules()).toHaveLength(2);

    vi.restoreAllMocks();
    const retry = await call('POST', '/alerts/starters');
    expect(retry.status).toBe(201);
    expect(retry.body.created).toHaveLength(3);
    expect(retry.body.skipped).toHaveLength(2);
    expect(await listRules()).toHaveLength(5);
  });
});

describe('POST /alerts/rules with a starterKey', () => {
  const customised = (overrides: Json = {}): Json => ({
    ...JSON.parse(JSON.stringify(starterRuleInput(STARTER_ALERTS[0]))),
    name: 'Agent errors, our way',
    condition: { mode: 'threshold', operator: 'gt', threshold: 35, forMinutes: 10, minSamples: 20 },
    channels: [{ type: 'email', recipients: ['oncall@acme.com'], audience: 'project_admins' }],
    ...overrides,
  });

  it('saves the rule with the starter mark, and the mark is not an input of the rule', async () => {
    const res = await call('POST', '/alerts/rules', { ...customised(), starterKey: 'agent-errors' });

    expect(res.status).toBe(201);
    expect(res.body.rule).toMatchObject({
      name: 'Agent errors, our way',
      projectId: currentProjectId,
      starter: { key: 'agent-errors', version: 1 },
      condition: { threshold: 35 },
    });
    expect(res.body.rule.channels[0]).toMatchObject({ type: 'email', recipients: ['oncall@acme.com'], audience: 'project_admins' });
    expect(res.body.rule).not.toHaveProperty('starterKey');

    const read = await call('GET', `/alerts/rules/${res.body.rule._id}`);
    expect(read.body.rule.starter).toEqual({ key: 'agent-errors', version: 1 });
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const stored = await db.findAlertRuleById(String(res.body.rule._id));
    expect(stored?.starter).toEqual({ key: 'agent-errors', version: 1 });
    expect(stored).not.toHaveProperty('starterKey');
  });

  it('makes the starter added, and a later "add all" leaves it alone', async () => {
    const created = (await call('POST', '/alerts/rules', { ...customised(), starterKey: 'agent-errors' })).body.rule;

    expect(stateOf(await starters(), 'agent-errors')).toMatchObject({
      state: 'added',
      rule: { id: created._id, name: 'Agent errors, our way', enabled: true },
    });
    const all = await call('POST', '/alerts/starters');
    expect(all.body.created).toHaveLength(4);
    expect(all.body.skipped).toEqual([{ key: 'agent-errors', reason: 'exists' }]);
  });

  it('hands the service the body without the key, and the mark as the sixth argument', async () => {
    const create = vi.spyOn(AlertService, 'createRule');
    await call('POST', '/alerts/rules', { ...customised(), starterKey: 'agent-errors' });

    expect(create).toHaveBeenCalledTimes(1);
    const [dbName, tenantId, projectId, userId, input, options] = create.mock.calls[0];
    expect([dbName, tenantId, projectId, userId]).toEqual([TENANT_DB_NAME, TENANT_ID, currentProjectId, users.owner]);
    expect(input).not.toHaveProperty('starterKey');
    expect(input).toMatchObject({ name: 'Agent errors, our way' });
    expect(options).toEqual({ starter: { key: 'agent-errors', version: 1 } });
  });

  it('adds no mark to a rule saved without a starterKey', async () => {
    const create = vi.spyOn(AlertService, 'createRule');
    const rule = await createRule();

    expect(rule.starter ?? null).toBeNull();
    expect(create.mock.calls[0][5]).toEqual({});
    expect((await starters()).items.some((item: Json) => item.state === 'added')).toBe(false);
  });

  it.each([
    ['an unknown key', 'nope'],
    ['an empty string', ''],
    ['a key in the wrong case', 'AGENT-ERRORS'],
    ['a number', 42],
    ['a list of keys', ['agent-errors']],
    ['an object', { key: 'agent-errors' }],
  ])('answers 400 invalid_value for %s and saves nothing', async (_label, starterKey) => {
    const create = vi.spyOn(AlertService, 'createRule');
    const res = await call('POST', '/alerts/rules', { ...customised(), starterKey });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_value', error: 'starterKey is not a starter rule' });
    expect(create).not.toHaveBeenCalled();
    expect(await listRules()).toEqual([]);
  });

  it('answers 400 invalid_value when the rule watches another metric than the starter', async () => {
    const create = vi.spyOn(AlertService, 'createRule');
    const res = await call('POST', '/alerts/rules', {
      ...customised({ module: 'models', metric: 'model_error_rate', entity: { entityType: 'model', mode: 'all' } }),
      starterKey: 'agent-errors',
    });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_value' });
    expect(create).not.toHaveBeenCalled();
    expect(await listRules()).toEqual([]);
  });

  it('validates the rule like any other: a bad rule with a good key is a 400 and has no mark', async () => {
    const res = await call('POST', '/alerts/rules', { ...customised({ windowMinutes: 7 }), starterKey: 'agent-errors' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_window');
    expect(await listRules()).toEqual([]);
    expect((await starters()).items.some((item: Json) => item.state === 'added')).toBe(false);
  });

  it('does not let a request body set the mark itself', async () => {
    const forged = await call('POST', '/alerts/rules', ruleBody({ starter: { key: 'agent-errors', version: 9 } }));
    expect(forged.status).toBe(201);
    expect(forged.body.rule.starter ?? null).toBeNull();
    expect(stateOf(await starters(), 'agent-errors').state).toBe('covered');

    // nor can an update add it to a rule, or change the version of a real one
    const plain = forged.body.rule;
    const put = await call('PUT', `/alerts/rules/${plain._id}`, { starter: { key: 'agent-errors', version: 9 } });
    expect(put.status).toBe(200);
    expect(put.body.rule.starter ?? null).toBeNull();

    const starter = (await call('POST', '/alerts/starters', { keys: ['model-errors'] })).body.created[0];
    const putStarter = await call('PUT', `/alerts/rules/${starter._id}`, { starter: { key: 'tool-errors', version: 9 } });
    expect(putStarter.status).toBe(200);
    expect(putStarter.body.rule.starter).toEqual({ key: 'model-errors', version: 1 });
  });

  it('keeps the mark when the rule is toggled or edited', async () => {
    const rule = (await call('POST', '/alerts/rules', { ...customised(), starterKey: 'agent-errors' })).body.rule;

    const off = await call('PATCH', `/alerts/rules/${rule._id}`, { enabled: false });
    expect(off.body.rule).toMatchObject({ enabled: false, starter: { key: 'agent-errors', version: 1 } });
    const renamed = await call('PUT', `/alerts/rules/${rule._id}`, { name: 'Renamed', windowMinutes: 60 });
    expect(renamed.body.rule).toMatchObject({ name: 'Renamed', windowMinutes: 60, starter: { key: 'agent-errors', version: 1 } });
    expect((await listRules()).find((r) => r._id === rule._id)?.starter).toEqual({ key: 'agent-errors', version: 1 });
  });
});

describe('who may use the starter routes', () => {
  it('lets a person with read access to alerts list the starters, not add them', async () => {
    const list = await callAs('viewer', 'GET', '/alerts/starters');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(5);

    const add = await callAs('viewer', 'POST', '/alerts/starters');
    expect(add.status).toBe(403);
    const keyed = await callAs('viewer', 'POST', '/alerts/starters', { keys: ['agent-errors'] });
    expect(keyed.status).toBe(403);
    const rule = await callAs('viewer', 'POST', '/alerts/rules', { ...ruleBody(), starterKey: 'agent-errors' });
    expect(rule.status).toBe(403);
    expect(await listRules()).toEqual([]);
  });

  it('keeps a person without access to alerts out of both routes', async () => {
    expect((await callAs('blocked', 'GET', '/alerts/starters')).status).toBe(403);
    expect((await callAs('blocked', 'POST', '/alerts/starters')).status).toBe(403);
    expect(await listRules()).toEqual([]);
  });

  it('lets a person who may write alerts add the starters, as themselves', async () => {
    // padmin has the default permission of a person of the workspace: write on alerts
    const res = await callAs('padmin', 'POST', '/alerts/starters', { keys: ['agent-errors'] });
    expect(res.status).toBe(201);
    expect(res.body.created[0].createdBy).toBe(users.padmin);
  });
});
