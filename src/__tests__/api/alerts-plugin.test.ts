/**
 * HTTP-level tests for the LIVE alerts dashboard plugin (`plugins/alerts.ts`),
 * injected over real SQLite. The sibling `alerts-*.test.ts` files drive the
 * unmounted `routes/**` duplicates; this one is what fails when the plugin that
 * serves traffic changes.
 *
 * Routes covered (method + path, as the endpoint-coverage gate reads them):
 *   GET    /alerts/rules                          POST /alerts/rules
 *   POST   /alerts/rules/preview                  GET  /alerts/entities
 *   POST   /alerts/channels/test
 *   GET    /alerts/rules/:ruleId                  PUT    /alerts/rules/:ruleId
 *   PATCH  /alerts/rules/:ruleId                  DELETE /alerts/rules/:ruleId
 *   GET    /alerts/history                        PATCH  /alerts/history/:eventId/acknowledge
 *   GET    /alerts/incidents                      POST   /alerts/incidents/bulk
 *   GET    /alerts/incidents/:incidentId          PATCH  /alerts/incidents/:incidentId
 *   POST   /alerts/incidents/:incidentId/notes
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// SQLite + tmp dir BEFORE getDatabase() is imported.
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-alerts-plugin-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'alerts_plugin_main';

const PROJECT_A = 'alerts-project-a';
const PROJECT_B = 'alerts-project-b';

/** Flipped per test: a member only reaches the active project, an owner reaches the tenant. */
let currentUserRole: 'owner' | 'admin' | 'member' = 'owner';
let currentProjectId = PROJECT_A;

vi.mock('@/lib/services/projects/projectContext', () => ({
  ProjectContextError: class extends Error {
    status = 400;
  },
  resolveProjectContext: vi.fn(async (ctx: { tenantId: string; userId: string }) => ({
    projectId: currentProjectId,
    project: {
      _id: currentProjectId,
      tenantId: ctx.tenantId,
      name: 'Alerts Project',
      key: 'alerts',
      status: 'active',
    },
    user: {
      _id: ctx.userId,
      tenantId: ctx.tenantId,
      email: 'tester@example.com',
      role: currentUserRole,
      status: 'active',
    },
    userProject: null,
  })),
  requireProjectContext: vi.fn(),
}));

// Outbound: nothing leaves the process. Hosts named *.internal.test are "private".
vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: vi.fn(async (url: string) => {
    if (url.includes('internal.test')) throw new Error('private address');
    return new URL(url);
  }),
  safeFetch: vi.fn(),
}));

vi.mock('@/lib/services/alerts/channels', () => ({
  dispatchNotification: vi.fn(async () => [{ type: 'email', target: 'ops@acme.com', success: true }]),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, getTenantDatabase } from '@/lib/database';
import { alertsApiPlugin } from '@/server/api/plugins/alerts';
import { IncidentService } from '@/lib/services/alerts';
import { dispatchNotification } from '@/lib/services/alerts/channels';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'alerts_plugin_tenant';
const TENANT_ID = 'tenant-alerts-1';
let USER_ID = 'pending';

const HEADERS: Record<string, string> = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'test',
  'x-user-id': USER_ID,
  'x-user-email': 'tester@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};
const JSON_HEADERS: Record<string, string> = { ...HEADERS, 'content-type': 'application/json' };

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXsecretABCD';

let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url: `/api${url}`,
    headers: body === undefined ? HEADERS : JSON_HEADERS,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: res.statusCode, body: (res.body ? parseJsonBody<Json>(res.body) : {}) as Json };
}

const ruleBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'High error rate',
  module: 'models',
  metric: 'error_rate',
  condition: { operator: 'gt', threshold: 5 },
  windowMinutes: 15,
  channels: [{ type: 'email', recipients: ['ops@acme.com'] }],
  ...overrides,
});

const agentRuleBody = (overrides: Record<string, unknown> = {}) =>
  ruleBody({
    name: 'Agent errors',
    module: 'agents',
    metric: 'agent_error_rate',
    entity: { entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] },
    ...overrides,
  });

async function createRule(body: Record<string, unknown> = ruleBody()): Promise<Json> {
  const res = await call('POST', '/alerts/rules', body);
  expect(res.status).toBe(201);
  return res.body.rule;
}

/** Seeds a rule of another project straight into the store (the API only creates in the active one). */
async function seedForeignRule(): Promise<string> {
  const db = await getTenantDatabase(TENANT_DB_NAME);
  const rule = await db.createAlertRule({
    tenantId: TENANT_ID,
    projectId: PROJECT_B,
    name: 'Foreign rule',
    module: 'models',
    metric: 'error_rate',
    condition: { operator: 'gt', threshold: 1 },
    windowMinutes: 15,
    cooldownMinutes: 60,
    enabled: true,
    channels: [{ id: 'ch_aaaaaaaaaaaa', type: 'email', recipients: ['x@y.co'] }],
    createdBy: USER_ID,
  } as never);
  return String(rule._id);
}

async function seedEvent(projectId: string, status: 'fired' | 'resolved' = 'fired', ruleId = 'rule-x'): Promise<string> {
  const db = await getTenantDatabase(TENANT_DB_NAME);
  const event = await db.createAlertEvent({
    tenantId: TENANT_ID,
    projectId,
    ruleId,
    ruleName: 'Seeded',
    metric: 'error_rate',
    threshold: 5,
    actualValue: 9,
    status,
    channels: [],
    firedAt: new Date(),
  } as never);
  return String(event._id);
}

async function seedIncident(projectId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const event = await seedEvent(projectId);
  const incident = await IncidentService.createIncident(TENANT_DB_NAME, {
    tenantId: TENANT_ID,
    projectId,
    alertEventId: event,
    ruleId: 'rule-x',
    ruleName: 'Seeded',
    metric: 'error_rate',
    threshold: 5,
    actualValue: 9,
    firedAt: new Date(),
    ...overrides,
  } as never);
  return String(incident._id);
}

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.createTenant({
    companyName: 'Alerts Plugin Test',
    slug: 'alerts-plugin-test',
    dbName: TENANT_DB_NAME,
    licenseType: 'FREE',
    ownerId: 'pending',
  });
  await db.switchToTenant(TENANT_DB_NAME);
  const owner = await db.createUser({
    tenantId: TENANT_ID,
    email: 'tester@example.com',
    name: 'Tester',
    password: '$2b$10$x',
    role: 'owner',
    licenseId: 'FREE',
    features: [],
  });
  USER_ID = String(owner._id);
  HEADERS['x-user-id'] = USER_ID;
  JSON_HEADERS['x-user-id'] = USER_ID;

  app = await createFastifyApiTestApp(alertsApiPlugin);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  currentUserRole = 'owner';
  currentProjectId = PROJECT_A;
  resetRateLimitStore();
  vi.mocked(dispatchNotification).mockClear();
});

describe('GET /alerts/rules (meta + list)', () => {
  it('returns the rules of the active project with the full meta block', async () => {
    const created = await createRule(ruleBody({ name: 'Listed rule' }));
    const res = await call('GET', '/alerts/rules');
    expect(res.status).toBe(200);

    const { meta, rules, states } = res.body;
    expect(rules.map((r: Json) => r._id)).toContain(created._id);
    // A rule that has never been non-ok has no state rows, so it has no entry.
    expect(states[created._id]).toBeUndefined();

    expect(meta.validWindows).toEqual([5, 15, 30, 60, 120, 240, 1440]);
    expect(meta.validModules).toEqual(expect.arrayContaining(['models', 'agents', 'tools']));
    expect(meta.validModules).not.toContain('aegis');
    expect(meta.moduleMetrics.agents).toContain('agent_error_rate');
    expect(meta.validMetrics).toContain('agent_error_rate');
    expect(Array.isArray(meta.catalog)).toBe(true);
    expect(meta.catalog.find((m: Json) => m.id === 'agent_error_rate')).toMatchObject({ module: 'agents' });
    expect(meta.channelTypes).toEqual(['email', 'webhook', 'slack', 'teams', 'pagerduty']);
    expect(Object.keys(meta.modes).sort()).toEqual(['absence', 'baseline', 'slo_burn', 'threshold']);
    expect(meta.modes.threshold).toEqual({ available: true });
    expect(meta.modes.baseline).toMatchObject({ available: false });
  });

  it('does not list the rules of another project', async () => {
    const foreign = await seedForeignRule();
    const res = await call('GET', '/alerts/rules');
    expect(res.body.rules.map((r: Json) => r._id)).not.toContain(foreign);
  });
});

describe('POST /alerts/rules', () => {
  it('creates a rule (201) with defaults and never returns channel secrets', async () => {
    const res = await call('POST', '/alerts/rules', ruleBody({
      name: 'Secret channels',
      channels: [
        { type: 'slack', url: SLACK_URL },
        { type: 'email', recipients: ['ops@acme.com'] },
      ],
    }));
    expect(res.status).toBe(201);
    const { rule } = res.body;
    expect(rule).toMatchObject({
      name: 'Secret channels', projectId: PROJECT_A, enabled: true, cooldownMinutes: 60, severity: 'auto', notifyOnResolve: true,
    });
    expect(rule.channels[0]).toMatchObject({ type: 'slack', urlHint: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain(SLACK_URL);
    expect(JSON.stringify(res.body)).not.toContain('sealed');

    // ...and not from the read routes either
    const read = await call('GET', `/alerts/rules/${rule._id}`);
    expect(JSON.stringify(read.body)).not.toContain(SLACK_URL);
    expect(JSON.stringify(read.body)).not.toContain('sealed');
    expect(JSON.stringify((await call('GET', '/alerts/rules')).body)).not.toContain(SLACK_URL);
  });

  it('creates an agent rule with an entity scope', async () => {
    const rule = await createRule(agentRuleBody());
    expect(rule.entity).toEqual({ entityType: 'agent', mode: 'selected', keys: ['Pulse Main'] });
  });

  it.each([
    ['a blank name', { name: ' ' }, 'invalid_name'],
    ['an unknown metric', { metric: 'nope' }, 'invalid_metric'],
    ['a metric of another module', { metric: 'agent_error_rate' }, 'metric_module_mismatch'],
    ['an unsupported window', { windowMinutes: 7 }, 'invalid_window'],
    ['no condition', { condition: undefined }, 'invalid_condition'],
    ['a bad operator', { condition: { operator: 'between', threshold: 1 } }, 'invalid_value'],
    ['an empty channel list', { channels: [] }, 'invalid_channel'],
    ['a malformed email', { channels: [{ type: 'email', recipients: ['nope'] }] }, 'invalid_channel'],
    ['a slack channel without url', { channels: [{ type: 'slack' }] }, 'invalid_channel'],
    ['a private webhook target', { channels: [{ type: 'webhook', url: 'https://hook.internal.test/x' }] }, 'invalid_channel'],
    ['an out-of-range renotify', { renotifyMinutes: 5 }, 'invalid_renotify'],
  ])('answers 400 for %s', async (_label, patch, code) => {
    const res = await call('POST', '/alerts/rules', ruleBody(patch));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe('string');
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/alerts/rules', headers: JSON_HEADERS, payload: '{nope' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('answers 402 for baseline and slo_burn in a build without the enterprise providers', async () => {
    for (const mode of ['baseline', 'slo_burn']) {
      const res = await call('POST', '/alerts/rules', agentRuleBody({
        name: `Gated ${mode}`,
        condition: { operator: 'gt', threshold: 0, mode },
      }));
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({
        error: 'Payment Required',
        requiresEnterprise: true,
        module: 'alerts-advanced',
        code: 'not_enterprise_build',
      });
    }
  });

  it('absence is available everywhere', async () => {
    const rule = await createRule(agentRuleBody({
      name: 'Silent agent',
      metric: 'agent_sessions',
      condition: { operator: 'lt', threshold: 1, mode: 'absence', absence: { lookbackHours: 24, minExpectedPerWindow: 1 } },
    }));
    expect(rule.condition).toMatchObject({ mode: 'absence', absence: { lookbackHours: 24, minExpectedPerWindow: 1 } });
  });
});

describe('POST /alerts/rules/preview', () => {
  it('evaluates a draft without storing anything', async () => {
    const before = (await call('GET', '/alerts/rules')).body.rules.length;
    const res = await call('POST', '/alerts/rules/preview', agentRuleBody({ name: undefined, channels: undefined }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ targets: expect.any(Array), notes: expect.any(Array) });
    expect((await call('GET', '/alerts/rules')).body.rules.length).toBe(before);
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it('validates the draft like create does and gates enterprise modes', async () => {
    expect((await call('POST', '/alerts/rules/preview', agentRuleBody({ windowMinutes: 7 }))).status).toBe(400);
    const gated = await call('POST', '/alerts/rules/preview', agentRuleBody({ condition: { operator: 'gt', threshold: 0, mode: 'baseline' } }));
    expect(gated.status).toBe(402);
  });
});

describe('GET /alerts/entities', () => {
  it('lists the entities of a type (empty without data)', async () => {
    const res = await call('GET', '/alerts/entities?entityType=agent&q=pul&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.entities).toEqual([]);
  });

  it('rejects a missing or unknown entity type', async () => {
    expect((await call('GET', '/alerts/entities')).status).toBe(400);
    expect((await call('GET', '/alerts/entities?entityType=planet')).status).toBe(400);
  });
});

describe('POST /alerts/channels/test', () => {
  it('sends a test through an unsaved channel and returns the delivery result', async () => {
    const res = await call('POST', '/alerts/channels/test', { channel: { type: 'email', recipients: ['ops@acme.com'] } });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ success: true });
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    const [notification] = vi.mocked(dispatchNotification).mock.calls[0];
    expect(notification).toMatchObject({ kind: 'test', projectName: 'Alerts Project' });
  });

  it('tests a stored channel of a rule of the project', async () => {
    const rule = await createRule(ruleBody({ name: 'Channel test rule' }));
    const res = await call('POST', '/alerts/channels/test', { ruleId: rule._id, channelId: rule.channels[0].id });
    expect(res.status).toBe(200);
  });

  it('404s a stored channel of a rule in another project for a member, and a missing channel', async () => {
    const foreign = await seedForeignRule();
    currentUserRole = 'member';
    const res = await call('POST', '/alerts/channels/test', { ruleId: foreign, channelId: 'ch_aaaaaaaaaaaa' });
    expect(res.status).toBe(404);
    currentUserRole = 'owner';
    const rule = await createRule(ruleBody({ name: 'Missing channel' }));
    expect((await call('POST', '/alerts/channels/test', { ruleId: rule._id, channelId: 'ch_ffffffffffff' })).status).toBe(404);
  });

  it('throttles tests per person: a sixth test within a minute is a 429 with Retry-After', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await call('POST', '/alerts/channels/test', { channel: { type: 'email', recipients: ['ops@acme.com'] } })).status).toBe(200);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/alerts/channels/test',
      headers: JSON_HEADERS,
      payload: JSON.stringify({ channel: { type: 'email', recipients: ['ops@acme.com'] } }),
    });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(parseJsonBody<Json>(res.body)).toMatchObject({ code: 'rate_limited' });
    expect(dispatchNotification).toHaveBeenCalledTimes(5);
  });

  it('refuses to test an unsaved email channel against a long recipient list', async () => {
    const recipients = Array.from({ length: 6 }, (_, i) => `person${i}@acme.com`);
    const res = await call('POST', '/alerts/channels/test', { channel: { type: 'email', recipients } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('too_many_recipients');
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it('rejects a malformed or private destination without sending', async () => {
    expect((await call('POST', '/alerts/channels/test', {})).status).toBe(400);
    expect((await call('POST', '/alerts/channels/test', { channel: { type: 'slack', url: 'https://x.internal.test/y' } })).status).toBe(400);
    expect((await call('POST', '/alerts/channels/test', { channel: { type: 'pagerduty', routingKey: 'bad' } })).status).toBe(400);
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

describe('/alerts/rules/:ruleId', () => {
  it('GET returns the rule with its states', async () => {
    const rule = await createRule(ruleBody({ name: 'Get me' }));
    const res = await call('GET', `/alerts/rules/${rule._id}`);
    expect(res.status).toBe(200);
    expect(res.body.rule._id).toBe(rule._id);
    expect(res.body.states).toEqual([]);
  });

  it('GET 404s an unknown id', async () => {
    expect((await call('GET', '/alerts/rules/does-not-exist')).status).toBe(404);
  });

  it('PUT updates, validates the merged rule, and keeps secrets of channels sent without a url', async () => {
    const rule = await createRule(ruleBody({ name: 'Put me', channels: [{ type: 'slack', url: SLACK_URL }] }));
    const res = await call('PUT', `/alerts/rules/${rule._id}`, {
      name: 'Renamed',
      windowMinutes: 30,
      channels: [{ id: rule.channels[0].id, type: 'slack' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.rule).toMatchObject({ name: 'Renamed', windowMinutes: 30 });
    expect(res.body.rule.channels[0]).toMatchObject({ id: rule.channels[0].id, type: 'slack' });
    expect(JSON.stringify(res.body)).not.toContain(SLACK_URL);

    const db = await getTenantDatabase(TENANT_DB_NAME);
    const stored = await db.findAlertRuleById(String(rule._id));
    expect((stored?.channels[0] as { sealed?: string }).sealed).toBeTruthy();
  });

  it('PUT clears the description and the scope when they come back empty', async () => {
    const rule = await createRule(ruleBody({ name: 'Clear me', description: 'something', scope: { modelKey: 'gpt-4o' } }));
    expect(rule.description).toBe('something');
    const res = await call('PUT', `/alerts/rules/${rule._id}`, { description: '', scope: {} });
    expect(res.status).toBe(200);
    expect(res.body.rule.description ?? '').toBe('');
    expect(res.body.rule.scope ?? {}).toEqual({});
  });

  it('PUT 400s an invalid merge (module/metric mismatch) and a bad window', async () => {
    const rule = await createRule(ruleBody({ name: 'Bad put' }));
    expect((await call('PUT', `/alerts/rules/${rule._id}`, { module: 'agents' })).status).toBe(400);
    expect((await call('PUT', `/alerts/rules/${rule._id}`, { windowMinutes: 0 })).status).toBe(400);
    expect((await call('PUT', `/alerts/rules/${rule._id}`, { channels: [] })).status).toBe(400);
  });

  it('PUT resets the persisted states when the rule is reshaped', async () => {
    const rule = await createRule(ruleBody({ name: 'Reshape' }));
    const db = await getTenantDatabase(TENANT_DB_NAME);
    await db.upsertAlertState({
      tenantId: TENANT_ID, projectId: PROJECT_A, ruleId: String(rule._id), entityKey: '', phase: 'firing', okStreak: 0, pendingSince: null,
    } as never);
    expect((await call('GET', `/alerts/rules/${rule._id}`)).body.states).toHaveLength(1);
    await call('PUT', `/alerts/rules/${rule._id}`, { condition: { operator: 'gt', threshold: 50 } });
    expect((await call('GET', `/alerts/rules/${rule._id}`)).body.states).toHaveLength(0);
  });

  it('PUT 404s an unknown id', async () => {
    expect((await call('PUT', '/alerts/rules/does-not-exist', { name: 'x' })).status).toBe(404);
  });

  it('PATCH toggles the rule and 400s a non-boolean', async () => {
    const rule = await createRule(ruleBody({ name: 'Toggle me' }));
    const off = await call('PATCH', `/alerts/rules/${rule._id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.rule.enabled).toBe(false);
    expect((await call('PATCH', `/alerts/rules/${rule._id}`, { enabled: 'no' })).status).toBe(400);
    expect((await call('PATCH', '/alerts/rules/does-not-exist', { enabled: true })).status).toBe(404);
  });

  it('DELETE removes the rule', async () => {
    const rule = await createRule(ruleBody({ name: 'Delete me' }));
    const res = await call('DELETE', `/alerts/rules/${rule._id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await call('GET', `/alerts/rules/${rule._id}`)).status).toBe(404);
    expect((await call('DELETE', `/alerts/rules/${rule._id}`)).status).toBe(404);
  });

  describe('project scoping', () => {
    it('a member gets 404 for a rule of another project on every by-id route', async () => {
      const foreign = await seedForeignRule();
      currentUserRole = 'member';
      expect((await call('GET', `/alerts/rules/${foreign}`)).status).toBe(404);
      expect((await call('PUT', `/alerts/rules/${foreign}`, { name: 'hijack' })).status).toBe(404);
      expect((await call('PATCH', `/alerts/rules/${foreign}`, { enabled: false })).status).toBe(404);
      expect((await call('DELETE', `/alerts/rules/${foreign}`)).status).toBe(404);

      currentUserRole = 'owner';
      const intact = await call('GET', `/alerts/rules/${foreign}`);
      expect(intact.status).toBe(200);
      expect(intact.body.rule).toMatchObject({ name: 'Foreign rule', enabled: true });
    });

    it('an owner keeps the tenant-wide reach', async () => {
      const foreign = await seedForeignRule();
      expect((await call('GET', `/alerts/rules/${foreign}`)).status).toBe(200);
      expect((await call('PATCH', `/alerts/rules/${foreign}`, { enabled: false })).body.rule.enabled).toBe(false);
      expect((await call('DELETE', `/alerts/rules/${foreign}`)).status).toBe(200);
    });

    it('a member reaches rules of the active project', async () => {
      const rule = await createRule(ruleBody({ name: 'Mine' }));
      currentUserRole = 'member';
      expect((await call('GET', `/alerts/rules/${rule._id}`)).status).toBe(200);
      currentProjectId = PROJECT_B;
      expect((await call('GET', `/alerts/rules/${rule._id}`)).status).toBe(404);
    });
  });
});

describe('GET /alerts/history', () => {
  it('lists the events of the project with the active count and filters by status', async () => {
    const fired = await seedEvent(PROJECT_A, 'fired');
    const resolved = await seedEvent(PROJECT_A, 'resolved');
    const foreign = await seedEvent(PROJECT_B, 'fired');

    const all = await call('GET', '/alerts/history?limit=100');
    expect(all.status).toBe(200);
    const ids = all.body.events.map((e: Json) => e._id);
    expect(ids).toEqual(expect.arrayContaining([fired, resolved]));
    expect(ids).not.toContain(foreign);
    expect(all.body.activeCount).toBeGreaterThanOrEqual(1);

    const onlyFired = await call('GET', '/alerts/history?status=fired&limit=100');
    expect(onlyFired.body.events.every((e: Json) => e.status === 'fired')).toBe(true);
  });

  it('400s an unknown status filter', async () => {
    expect((await call('GET', '/alerts/history?status=bogus')).status).toBe(400);
  });
});

describe('PATCH /alerts/history/:eventId/acknowledge', () => {
  it('records who acknowledged the event and acknowledges the linked incident', async () => {
    const incidentId = await seedIncident(PROJECT_A);
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const incident = await db.findIncidentById(incidentId);
    const res = await call('PATCH', `/alerts/history/${incident!.alertEventId}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ status: 'acknowledged', acknowledgedBy: USER_ID });
    expect((await call('GET', `/alerts/incidents/${incidentId}`)).body.incident.status).toBe('acknowledged');
  });

  it('leaves a resolved event resolved', async () => {
    const eventId = await seedEvent(PROJECT_A, 'resolved');
    const res = await call('PATCH', `/alerts/history/${eventId}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe('resolved');
  });

  it('404s an unknown event and, for a member, an event of another project', async () => {
    expect((await call('PATCH', '/alerts/history/does-not-exist/acknowledge')).status).toBe(404);
    const foreign = await seedEvent(PROJECT_B, 'fired');
    currentUserRole = 'member';
    expect((await call('PATCH', `/alerts/history/${foreign}/acknowledge`)).status).toBe(404);
    currentUserRole = 'owner';
    const db = await getTenantDatabase(TENANT_DB_NAME);
    expect((await db.findAlertEventById(foreign))?.status).toBe('fired');
  });
});

describe('GET /alerts/incidents', () => {
  it('lists incidents of the project with counts, openCount, total and hasMore', async () => {
    const a = await seedIncident(PROJECT_A, { severity: 'critical' });
    const b = await seedIncident(PROJECT_A, { ruleId: 'rule-y' });
    const foreign = await seedIncident(PROJECT_B);

    const res = await call('GET', '/alerts/incidents?limit=100');
    expect(res.status).toBe(200);
    const ids = res.body.incidents.map((i: Json) => i._id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    expect(ids).not.toContain(foreign);
    expect(res.body.openCount).toBe(res.body.counts.open);
    expect(res.body.counts).toMatchObject({ open: expect.any(Number), acknowledged: expect.any(Number), resolved: expect.any(Number), closed: expect.any(Number) });
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.hasMore).toBe(false);
  });

  it('names the acknowledger, assignee and resolver (ids only for unknown users, no emails)', async () => {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const other = await db.createUser({
      tenantId: TENANT_ID, email: 'ada@example.com', name: 'Ada Lovelace', password: '$2b$10$x',
      role: 'user', licenseId: 'FREE', features: [],
    });
    const id = await seedIncident(PROJECT_A, { ruleId: 'rule-names' });
    await call('PATCH', `/alerts/incidents/${id}`, { status: 'acknowledged' });
    await call('PATCH', `/alerts/incidents/${id}`, { assignedTo: String(other._id) });
    await call('PATCH', `/alerts/incidents/${id}`, { status: 'resolved' });

    const list = await call('GET', '/alerts/incidents?ruleId=rule-names');
    const row = list.body.incidents.find((i: Json) => i._id === id);
    expect(row).toMatchObject({ acknowledgedByName: 'Tester', assignedToName: 'Ada Lovelace', resolvedByName: 'Tester' });
    expect(JSON.stringify(list.body)).not.toContain('ada@example.com');

    const detail = await call('GET', `/alerts/incidents/${id}`);
    expect(detail.body.incident).toMatchObject({ acknowledgedByName: 'Tester', assignedToName: 'Ada Lovelace', resolvedByName: 'Tester' });

    // 'system' (automatic resolution) and unknown ids have no name.
    await call('PATCH', `/alerts/incidents/${id}`, { assignedTo: 'user-gone' });
    const unknown = await call('GET', `/alerts/incidents/${id}`);
    expect(unknown.body.incident).toMatchObject({ assignedTo: 'user-gone', assignedToName: null });
    const fresh = await seedIncident(PROJECT_A, { ruleId: 'rule-names-2' });
    const untouched = (await call('GET', `/alerts/incidents/${fresh}`)).body.incident;
    expect(untouched).toMatchObject({ acknowledgedByName: null, assignedToName: null, resolvedByName: null });
  });

  it('reads the users once per list, and not at all when nobody is named', async () => {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const spy = vi.spyOn(Object.getPrototypeOf(db), 'listUsers');
    await seedIncident(PROJECT_A, { ruleId: 'rule-nonames' });
    spy.mockClear();
    await call('GET', '/alerts/incidents?ruleId=rule-nonames');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('pages with hasMore', async () => {
    await seedIncident(PROJECT_A);
    await seedIncident(PROJECT_A);
    const page = await call('GET', '/alerts/incidents?limit=1');
    expect(page.body.incidents).toHaveLength(1);
    expect(page.body.hasMore).toBe(true);
    const next = await call('GET', '/alerts/incidents?limit=1&skip=1');
    expect(next.body.incidents).toHaveLength(1);
    expect(next.body.incidents[0]._id).not.toBe(page.body.incidents[0]._id);
  });

  it('filters by severity, rule and status, and 400s unknown enum values', async () => {
    await seedIncident(PROJECT_A, { severity: 'info', ruleId: 'rule-filter' });
    const bySeverity = await call('GET', '/alerts/incidents?severity=info&ruleId=rule-filter&limit=100');
    expect(bySeverity.status).toBe(200);
    expect(bySeverity.body.incidents.length).toBeGreaterThanOrEqual(1);
    expect(bySeverity.body.incidents.every((i: Json) => i.severity === 'info' && i.ruleId === 'rule-filter')).toBe(true);

    const none = await call('GET', '/alerts/incidents?status=closed&ruleId=rule-filter');
    expect(none.body.incidents).toEqual([]);

    expect((await call('GET', '/alerts/incidents?status=bogus')).status).toBe(400);
    expect((await call('GET', '/alerts/incidents?severity=bogus')).status).toBe(400);
    expect((await call('GET', '/alerts/incidents?module=bogus')).status).toBe(400);
  });
});

describe('/alerts/incidents/:incidentId', () => {
  it('GET returns the incident, 404 for unknown ones and for a member outside the project', async () => {
    const id = await seedIncident(PROJECT_A);
    expect((await call('GET', `/alerts/incidents/${id}`)).body.incident._id).toBe(id);
    expect((await call('GET', '/alerts/incidents/does-not-exist')).status).toBe(404);

    const foreign = await seedIncident(PROJECT_B);
    expect((await call('GET', `/alerts/incidents/${foreign}`)).status).toBe(200); // owner
    currentUserRole = 'member';
    expect((await call('GET', `/alerts/incidents/${foreign}`)).status).toBe(404);
  });

  it('PATCH walks the workflow, records the actor, and refuses an invalid transition', async () => {
    const id = await seedIncident(PROJECT_A);
    const ack = await call('PATCH', `/alerts/incidents/${id}`, { status: 'acknowledged' });
    expect(ack.status).toBe(200);
    expect(ack.body.incident).toMatchObject({ status: 'acknowledged', acknowledgedBy: USER_ID });

    const resolved = await call('PATCH', `/alerts/incidents/${id}`, { status: 'resolved' });
    expect(resolved.body.incident.status).toBe('resolved');

    const reopen = await call('PATCH', `/alerts/incidents/${id}`, { status: 'acknowledged' });
    expect(reopen.status).toBe(409);
    expect((await call('PATCH', `/alerts/incidents/${id}`, { status: 'bogus' })).status).toBe(400);
    expect((await call('PATCH', `/alerts/incidents/${id}`, {})).status).toBe(400);
  });

  it('PATCH assigns to a user id, to "me", and clears with null', async () => {
    const id = await seedIncident(PROJECT_A);
    expect((await call('PATCH', `/alerts/incidents/${id}`, { assignedTo: 'me' })).body.incident.assignedTo).toBe(USER_ID);
    expect((await call('PATCH', `/alerts/incidents/${id}`, { assignedTo: 'user-9' })).body.incident.assignedTo).toBe('user-9');
    const cleared = await call('PATCH', `/alerts/incidents/${id}`, { assignedTo: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.incident.assignedTo ?? null).toBeNull();
    expect((await call('PATCH', `/alerts/incidents/${id}`, { assignedTo: 5 })).status).toBe(400);
  });

  it('PATCH 404s an unknown incident and leaves another project untouched for a member', async () => {
    expect((await call('PATCH', '/alerts/incidents/does-not-exist', { status: 'acknowledged' })).status).toBe(404);
    const foreign = await seedIncident(PROJECT_B);
    currentUserRole = 'member';
    expect((await call('PATCH', `/alerts/incidents/${foreign}`, { status: 'acknowledged' })).status).toBe(404);
    currentUserRole = 'owner';
    expect((await call('GET', `/alerts/incidents/${foreign}`)).body.incident.status).toBe('open');
  });
});

describe('POST /alerts/incidents/:incidentId/notes', () => {
  it('adds a note authored by the caller', async () => {
    const id = await seedIncident(PROJECT_A);
    const res = await call('POST', `/alerts/incidents/${id}/notes`, { content: 'Looking into it' });
    expect(res.status).toBe(200);
    expect(res.body.incident.notes.at(-1)).toMatchObject({ content: 'Looking into it', userId: USER_ID });
  });

  it('rejects empty and oversized notes, and 404s unknown or foreign incidents', async () => {
    const id = await seedIncident(PROJECT_A);
    expect((await call('POST', `/alerts/incidents/${id}/notes`, { content: '  ' })).status).toBe(400);
    expect((await call('POST', `/alerts/incidents/${id}/notes`, { content: 'x'.repeat(4001) })).status).toBe(400);
    expect((await call('POST', '/alerts/incidents/does-not-exist/notes', { content: 'hi' })).status).toBe(404);

    const foreign = await seedIncident(PROJECT_B);
    currentUserRole = 'member';
    expect((await call('POST', `/alerts/incidents/${foreign}/notes`, { content: 'hi' })).status).toBe(404);
  });
});

describe('POST /alerts/incidents/bulk', () => {
  it('acknowledges the selected incidents of the active project', async () => {
    const [a, b] = [await seedIncident(PROJECT_A), await seedIncident(PROJECT_A)];
    const res = await call('POST', '/alerts/incidents/bulk', { ids: [a, b], action: 'acknowledge' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2 });
    expect((await call('GET', `/alerts/incidents/${a}`)).body.incident.status).toBe('acknowledged');
    expect((await call('GET', `/alerts/incidents/${b}`)).body.incident.status).toBe('acknowledged');
  });

  it('skips incidents that cannot make the move or live in another project, even for an owner', async () => {
    const mine = await seedIncident(PROJECT_A);
    const foreign = await seedIncident(PROJECT_B);
    const res = await call('POST', '/alerts/incidents/bulk', { ids: [mine, foreign, 'does-not-exist'], action: 'resolve' });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.failed.map((f: Json) => f.id).sort()).toEqual([foreign, 'does-not-exist'].sort());
    expect((await call('GET', `/alerts/incidents/${foreign}`)).body.incident.status).toBe('open');
  });

  it('validates the body', async () => {
    expect((await call('POST', '/alerts/incidents/bulk', { ids: 'a', action: 'resolve' })).status).toBe(400);
    expect((await call('POST', '/alerts/incidents/bulk', { ids: [1], action: 'resolve' })).status).toBe(400);
    expect((await call('POST', '/alerts/incidents/bulk', { ids: ['a'], action: 'explode' })).status).toBe(400);
    expect((await call('POST', '/alerts/incidents/bulk', { ids: ['a'] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    expect((await call('POST', '/alerts/incidents/bulk', { ids: tooMany, action: 'close' })).status).toBe(400);
  });
});
