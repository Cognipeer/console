/**
 * HTTP-level tests (live plugin, real SQLite) for the alerts channel library,
 * the rule backtest and the entity-link lookup.
 *
 * Routes covered (method + path, as the endpoint-coverage gate reads them):
 *   GET    /alerts/channels/library              POST   /alerts/channels/library
 *   PATCH  /alerts/channels/library/:id          DELETE /alerts/channels/library/:id
 *   POST   /alerts/channels/library/:id/test
 *   POST   /alerts/rules/backtest
 *   POST   /alerts/entities/links
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'cognipeer-alerts-library-'));
process.env.DB_PROVIDER = 'sqlite';
process.env.SQLITE_DATA_DIR = tmpRoot;
process.env.MAIN_DB_NAME = 'alerts_library_main';

const PROJECT_A = 'library-project-a';
let currentUserRole: 'owner' | 'admin' | 'member' = 'owner';

vi.mock('@/lib/services/projects/projectContext', () => ({
  ProjectContextError: class extends Error {
    status = 400;
  },
  resolveProjectContext: vi.fn(async (ctx: { tenantId: string; userId: string }) => ({
    projectId: PROJECT_A,
    project: { _id: PROJECT_A, tenantId: ctx.tenantId, name: 'Library Project', key: 'lib', status: 'active' },
    user: { _id: ctx.userId, tenantId: ctx.tenantId, email: 'tester@example.com', role: currentUserRole, status: 'active' },
    userProject: null,
  })),
  requireProjectContext: vi.fn(),
}));

vi.mock('@/lib/security/outboundFetch', () => ({
  assertPublicUrl: vi.fn(async (url: string) => {
    if (url.includes('internal.test')) throw new Error('private address');
    return new URL(url);
  }),
  safeFetch: vi.fn(),
}));

import { reloadConfig } from '@/lib/core/config';
import { disconnectDatabase, getDatabase, getTenantDatabase } from '@/lib/database';
import type { IAlertChannel } from '@/lib/database';
import { alertsApiPlugin } from '@/server/api/plugins/alerts';
import { dispatchNotification, registerChannel } from '@/lib/services/alerts/channels';
import type { AlertContext, AlertNotification, IAlertDispatcher } from '@/lib/services/alerts/channels';
import { unsealChannel } from '@/lib/services/alerts/channels/channelSecrets';
import { __resetAlertExtensionsForTests, registerEntityLinkResolver } from '@/enterprise/alert-extensions';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const TENANT_DB_NAME = 'alerts_library_tenant';
const TENANT_ID = 'tenant-library-1';
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/XXXXsecretABCD';
const HEADERS: Record<string, string> = {
  'x-tenant-db-name': TENANT_DB_NAME,
  'x-tenant-id': TENANT_ID,
  'x-tenant-slug': 'test',
  'x-user-id': 'pending',
  'x-user-email': 'tester@example.com',
  'x-user-role': 'owner',
  'x-license-type': 'FREE',
};
const JSON_HEADERS: Record<string, string> = { ...HEADERS, 'content-type': 'application/json' };

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

const delivered: Array<{ channel: IAlertChannel; notification: AlertNotification }> = [];
const fakeSlack: IAlertDispatcher = {
  type: 'slack',
  async dispatch(notification, channel) {
    delivered.push({ channel, notification });
    return [{ type: 'slack', target: 'fake slack', success: true }];
  },
};

beforeAll(async () => {
  reloadConfig();
  const db = await getDatabase();
  await db.createTenant({
    companyName: 'Alerts Library Test',
    slug: 'alerts-library-test',
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
  HEADERS['x-user-id'] = String(owner._id);
  JSON_HEADERS['x-user-id'] = String(owner._id);
  registerChannel(fakeSlack);
  app = await createFastifyApiTestApp(alertsApiPlugin);
}, 30_000);

afterAll(async () => {
  await app.close();
  await disconnectDatabase();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  currentUserRole = 'owner';
  delivered.length = 0;
  resetRateLimitStore();
  __resetAlertExtensionsForTests();
});

async function createLibraryChannel(name = 'Ops Slack'): Promise<Json> {
  const res = await call('POST', '/alerts/channels/library', { name, kind: 'slack', config: { url: SLACK_URL } });
  expect(res.status).toBe(201);
  return res.body.channel;
}

const ruleBody = (channels: unknown[], name = 'Uses library') => ({
  name,
  module: 'models',
  metric: 'error_rate',
  condition: { operator: 'gt', threshold: 5 },
  windowMinutes: 15,
  channels,
});

describe('channel library routes', () => {
  it('creates, lists, updates and deletes entries with secrets always masked', async () => {
    const created = await createLibraryChannel('Library A');
    expect(created).toMatchObject({ name: 'Library A', kind: 'slack', usedBy: [] });
    expect(JSON.stringify(created)).not.toContain('XXXXsecretABCD');
    expect(created.config.sealed).toBeUndefined();
    expect(created.config.urlHint).toContain('hooks.slack.com');

    const list = await call('GET', '/alerts/channels/library');
    expect(list.status).toBe(200);
    expect(list.body.channels.map((c: Json) => c.id)).toContain(created.id);
    expect(JSON.stringify(list.body)).not.toContain('XXXXsecretABCD');

    // a rename keeps the stored URL (secret omitted from config)
    const renamed = await call('PATCH', `/alerts/channels/library/${created.id}`, { name: 'Library A2' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.channel.name).toBe('Library A2');
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const stored = await db.findAlertChannelLibraryEntry(created.id);
    expect(unsealChannel(stored!.config)).toMatchObject({ type: 'slack', url: SLACK_URL });

    const rotated = await call('PATCH', `/alerts/channels/library/${created.id}`, {
      config: { url: 'https://hooks.slack.com/services/T111/B111/NEWsecretWXYZ' },
    });
    expect(rotated.status).toBe(200);
    expect(JSON.stringify(rotated.body)).not.toContain('NEWsecretWXYZ');
    expect(unsealChannel((await db.findAlertChannelLibraryEntry(created.id))!.config)).toMatchObject({
      url: 'https://hooks.slack.com/services/T111/B111/NEWsecretWXYZ',
    });

    expect((await call('PATCH', `/alerts/channels/library/${created.id}`, { kind: 'teams' })).status).toBe(400);

    expect((await call('DELETE', `/alerts/channels/library/${created.id}`)).status).toBe(200);
    expect((await call('DELETE', `/alerts/channels/library/${created.id}`)).status).toBe(404);
  });

  it('validates input and rejects duplicate names and private destinations', async () => {
    await createLibraryChannel('Unique name');
    expect((await call('POST', '/alerts/channels/library', { name: 'unique NAME', kind: 'slack', config: { url: SLACK_URL } })).status).toBe(409);
    expect((await call('POST', '/alerts/channels/library', { name: '', kind: 'slack', config: { url: SLACK_URL } })).status).toBe(400);
    expect((await call('POST', '/alerts/channels/library', { name: 'Bad kind', kind: 'sms', config: {} })).status).toBe(400);
    expect((await call('POST', '/alerts/channels/library', { name: 'Internal', kind: 'webhook', config: { url: 'https://hook.internal.test/x' } })).status).toBe(400);
  });

  it('lets only owners and admins change the library; members may read it', async () => {
    const created = await createLibraryChannel('Admin only');
    currentUserRole = 'member';
    expect((await call('GET', '/alerts/channels/library')).status).toBe(200);
    expect((await call('POST', '/alerts/channels/library', { name: 'x', kind: 'slack', config: { url: SLACK_URL } })).status).toBe(403);
    expect((await call('PATCH', `/alerts/channels/library/${created.id}`, { name: 'y' })).status).toBe(403);
    expect((await call('DELETE', `/alerts/channels/library/${created.id}`)).status).toBe(403);
    expect((await call('POST', `/alerts/channels/library/${created.id}/test`)).status).toBe(403);
    currentUserRole = 'admin';
    expect((await call('PATCH', `/alerts/channels/library/${created.id}`, { name: 'Admin renamed' })).status).toBe(200);
  });

  it('refuses to delete an entry a rule uses (409 with the rule names) and frees it once detached', async () => {
    const entry = await createLibraryChannel('In use');
    const rule = await call('POST', '/alerts/rules', ruleBody([{ type: 'library', libraryId: entry.id }], 'Rule using library'));
    expect(rule.status).toBe(201);
    expect(rule.body.rule.channels).toEqual([expect.objectContaining({ type: 'library', libraryId: entry.id })]);

    const listed = await call('GET', '/alerts/channels/library');
    expect(listed.body.channels.find((c: Json) => c.id === entry.id).usedBy).toEqual([
      expect.objectContaining({ ruleId: rule.body.rule._id, ruleName: 'Rule using library' }),
    ]);

    const blocked = await call('DELETE', `/alerts/channels/library/${entry.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('channel_in_use');
    expect(blocked.body.rules).toEqual([{ id: rule.body.rule._id, name: 'Rule using library' }]);

    const detach = await call('PUT', `/alerts/rules/${rule.body.rule._id}`, { channels: [{ type: 'email', recipients: ['ops@acme.com'] }] });
    expect(detach.status).toBe(200);
    expect((await call('DELETE', `/alerts/channels/library/${entry.id}`)).status).toBe(200);
  });

  it('shows a member only the rules of the active project among the users of an entry', async () => {
    const entry = await createLibraryChannel('Scoped usage');
    const mine = await call('POST', '/alerts/rules', ruleBody([{ type: 'library', libraryId: entry.id }], 'Rule here'));
    const theirs = await call('POST', '/alerts/rules', ruleBody([{ type: 'library', libraryId: entry.id }], 'Rule elsewhere'));
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const db = await getTenantDatabase(TENANT_DB_NAME);
    await db.updateAlertRule(theirs.body.rule._id, { projectId: 'library-project-b' });

    const usedBy = async () => (await call('GET', '/alerts/channels/library')).body.channels.find((c: Json) => c.id === entry.id).usedBy;
    expect((await usedBy()).map((u: Json) => u.ruleName).sort()).toEqual(['Rule elsewhere', 'Rule here']);
    currentUserRole = 'member';
    expect(await usedBy()).toEqual([expect.objectContaining({ ruleId: mine.body.rule._id, ruleName: 'Rule here' })]);
  });

  it('lets only owners and admins test a shared channel, whichever route is used', async () => {
    const entry = await createLibraryChannel('Shared test');
    const rule = await call('POST', '/alerts/rules', ruleBody([{ type: 'library', libraryId: entry.id }], 'Rule with shared'));
    const channelId = rule.body.rule.channels[0].id;
    expect(channelId).toBeTruthy();

    currentUserRole = 'member';
    const byLibrary = await call('POST', '/alerts/channels/test', { libraryChannelId: entry.id });
    expect(byLibrary.status).toBe(403);
    expect(byLibrary.body.code).toBe('forbidden');
    expect((await call('POST', '/alerts/channels/test', { ruleId: rule.body.rule._id, channelId })).status).toBe(403);
    expect(delivered).toHaveLength(0);

    currentUserRole = 'admin';
    expect((await call('POST', '/alerts/channels/test', { libraryChannelId: entry.id })).status).toBe(200);
    expect((await call('POST', '/alerts/channels/test', { ruleId: rule.body.rule._id, channelId })).status).toBe(200);
    expect(delivered).toHaveLength(2);
  });

  it('tests a library channel through its resolved credentials', async () => {
    const entry = await createLibraryChannel('Testable');
    const res = await call('POST', `/alerts/channels/library/${entry.id}/test`);
    expect(res.status).toBe(200);
    expect(res.body.result.success).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].notification.kind).toBe('test');
    expect(unsealChannel(delivered[0].channel)).toMatchObject({ type: 'slack', url: SLACK_URL });
    expect((await call('POST', '/alerts/channels/library/000000000000000000000000/test')).status).toBe(404);
  });
});

describe('library references at dispatch time', () => {
  const notification = { kind: 'fired' } as AlertNotification;
  const ctx = (): AlertContext => ({ tenantDbName: TENANT_DB_NAME, tenantId: TENANT_ID } as AlertContext);

  it('delivers through the stored entry, keeping the rule-local channel id', async () => {
    const entry = await createLibraryChannel('Dispatch target');
    const results = await dispatchNotification(
      notification,
      [{ id: 'ch_111111111111', type: 'library', libraryId: entry.id }],
      ctx(),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ success: true, channelId: 'ch_111111111111', channelName: 'Dispatch target' });
    expect(unsealChannel(delivered[0].channel)).toMatchObject({ type: 'slack', url: SLACK_URL });
  });

  it('picks up an edit of the library entry on the next dispatch', async () => {
    const entry = await createLibraryChannel('Rotating');
    await call('PATCH', `/alerts/channels/library/${entry.id}`, { config: { url: 'https://hooks.slack.com/services/T9/B9/ROTATEDkeyQQQQ' } });
    await dispatchNotification(notification, [{ type: 'library', libraryId: entry.id }], ctx());
    expect(unsealChannel(delivered[0].channel)).toMatchObject({ url: 'https://hooks.slack.com/services/T9/B9/ROTATEDkeyQQQQ' });
  });

  it('turns a missing entry into a failed delivery with reason channel_missing, never a throw', async () => {
    const results = await dispatchNotification(
      notification,
      [
        { id: 'ch_222222222222', type: 'library', libraryId: '000000000000000000000000' },
        { id: 'ch_333333333333', type: 'library', libraryId: 'not-an-id' },
      ],
      ctx(),
    );
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({ success: false, error: 'channel_missing', reason: 'channel_missing', type: 'library' });
    }
    expect(results[0].channelId).toBe('ch_222222222222');
    expect(delivered).toHaveLength(0);
  });

  it('does not resolve an entry of another tenant', async () => {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const foreign = await db.createAlertChannelLibraryEntry({
      tenantId: 'someone-else',
      name: 'Foreign',
      kind: 'email',
      config: { id: 'ch_444444444444', type: 'email', recipients: ['x@y.co'] },
      createdBy: 'x',
    });
    const results = await dispatchNotification(notification, [{ type: 'library', libraryId: String(foreign._id) }], ctx());
    expect(results[0]).toMatchObject({ success: false, reason: 'channel_missing' });
  });
});

describe('POST /alerts/rules/backtest', () => {
  const STEP = 300_000;
  const endMs = () => {
    const settled = Date.now() - 30_000;
    return settled - (settled % STEP);
  };

  async function seedAgent(entityKey: string, errorPctByHoursAgo: Record<number, number>) {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const end = endMs();
    const rows = [];
    // 36 h of steady traffic, with a two-bucket error spike starting at each requested hour offset
    for (let t = end - 36 * 3_600_000; t < end; t += STEP) {
      const age = end - t;
      const spike = Object.entries(errorPctByHoursAgo).find(([hours]) => age >= Number(hours) * 3_600_000 && age < Number(hours) * 3_600_000 + 2 * STEP);
      const spikePct = spike?.[1];
      const inSpike = spikePct !== undefined;
      rows.push({
        tenantId: TENANT_ID,
        projectId: PROJECT_A,
        entityType: 'agent' as const,
        entityKey,
        source: 'hosted' as const,
        bucketMs: t,
        requests: 100,
        errors: inSpike ? spikePct : 0,
      });
    }
    await db.incrementEntityMetrics(rows);
  }

  const rule = (overrides: Record<string, unknown> = {}) => ({
    name: 'Agent errors',
    module: 'agents',
    metric: 'agent_error_rate',
    condition: { operator: 'gt', threshold: 50 },
    windowMinutes: 5,
    cooldownMinutes: 5,
    ...overrides,
  });

  it('replays the rollup, counts would-have-fired incidents and suggests a quieter threshold', async () => {
    // Four episodes (peaks 60/70/80/90 %) 3 h apart, all inside the last 24 h
    await seedAgent('bt-bot', { 3: 60, 6: 70, 9: 80, 12: 90 });
    const res = await call('POST', '/alerts/rules/backtest', {
      rule: rule({ entity: { entityType: 'agent', mode: 'selected', keys: ['bt-bot'] } }),
      days: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(true);
    expect(res.body.fires).toBe(4);
    expect(res.body.firesPerEntity).toEqual([{ entityKey: 'bt-bot', fires: 4 }]);
    expect(res.body.incidents).toHaveLength(4);
    expect(res.body.incidents.every((i: Json) => i.entityKey === 'bt-bot' && i.resolvedAt)).toBe(true);
    expect(res.body.evaluations).toBeGreaterThan(100);
    expect(res.body.suggestion).toMatchObject({ threshold: 70, firesAtThreshold: 2 });
    expect(res.body.suggestion.note).toContain('70');
  });

  it('is read-only and honours a pending duration (forMinutes)', async () => {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const before = await db.listAlertRules(TENANT_ID);
    const res = await call('POST', '/alerts/rules/backtest', {
      rule: rule({ condition: { operator: 'gt', threshold: 50, forMinutes: 240 }, entity: { entityType: 'agent', mode: 'selected', keys: ['bt-bot'] } }),
      days: 2,
    });
    expect(res.status).toBe(200);
    expect(res.body.fires).toBe(0);
    expect(res.body.suggestion).toBeUndefined();
    expect(await db.listAlertRules(TENANT_ID)).toHaveLength(before.length);
    expect(await db.listAlertStates({ ruleId: 'preview' } as never)).toEqual([]);
  });

  it('covers every entity of the project when the rule targets all', async () => {
    await seedAgent('bt-quiet', {});
    const res = await call('POST', '/alerts/rules/backtest', { rule: rule({ entity: { entityType: 'agent', mode: 'all' } }), days: 1 });
    expect(res.status).toBe(200);
    expect(res.body.firesPerEntity.map((e: Json) => e.entityKey)).toEqual(['bt-bot']);
    expect(res.body.evaluations).toBeGreaterThan(0);
  });

  it('answers supported:false for legacy metrics and non-replayable modes', async () => {
    const legacy = await call('POST', '/alerts/rules/backtest', {
      rule: { name: 'x', module: 'models', metric: 'error_rate', condition: { operator: 'gt', threshold: 5 }, windowMinutes: 15 },
    });
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ supported: false, reason: 'legacy_metric', fires: 0, incidents: [] });

    const baseline = await call('POST', '/alerts/rules/backtest', {
      rule: rule({ condition: { operator: 'gt', threshold: 0, mode: 'baseline', baseline: { lookbackDays: 14, sensitivity: 3, direction: 'up' } } }),
    });
    expect(baseline.status).toBe(200);
    expect(baseline.body).toMatchObject({ supported: false, reason: 'mode_not_replayable' });
  });

  it('replays absence rules from the lookback history', async () => {
    const db = await getTenantDatabase(TENANT_DB_NAME);
    const end = endMs();
    // busy until 6 h ago, then silent
    const rows = [];
    for (let t = end - 30 * 3_600_000; t < end - 6 * 3_600_000; t += STEP) {
      rows.push({ tenantId: TENANT_ID, projectId: PROJECT_A, entityType: 'agent' as const, entityKey: 'bt-gone', source: 'hosted' as const, bucketMs: t, requests: 50, errors: 0 });
    }
    await db.incrementEntityMetrics(rows);
    const res = await call('POST', '/alerts/rules/backtest', {
      rule: rule({
        metric: 'agent_sessions',
        condition: { operator: 'lt', threshold: 1, mode: 'absence', absence: { lookbackHours: 24, minExpectedPerWindow: 1 } },
        windowMinutes: 15,
        entity: { entityType: 'agent', mode: 'selected', keys: ['bt-gone'] },
      }),
      days: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.supported).toBe(true);
    expect(res.body.fires).toBe(1);
    expect(res.body.incidents[0]).toMatchObject({ entityKey: 'bt-gone' });
    expect(res.body.incidents[0].resolvedAt).toBeUndefined();
  });

  it('validates days and the rule, and is allowed for readers', async () => {
    expect((await call('POST', '/alerts/rules/backtest', { rule: rule(), days: 8 })).status).toBe(400);
    expect((await call('POST', '/alerts/rules/backtest', { rule: rule(), days: 0 })).status).toBe(400);
    expect((await call('POST', '/alerts/rules/backtest', { rule: { name: 'x' } })).status).toBe(400);
    expect((await call('POST', '/alerts/rules/backtest', { days: 1 })).status).toBe(400);
    currentUserRole = 'member';
    expect((await call('POST', '/alerts/rules/backtest', { rule: rule({ entity: { entityType: 'agent', mode: 'all' } }), days: 1 })).status).toBe(200);
  });

  it('is throttled', async () => {
    let last = 200;
    for (let i = 0; i < 12; i += 1) {
      last = (await call('POST', '/alerts/rules/backtest', { rule: rule({ entity: { entityType: 'agent', mode: 'all' } }), days: 1 })).status;
    }
    expect(last).toBe(429);
  });
});

describe('POST /alerts/entities/links', () => {
  it('links agents and knowledge bases by key, models/MCP/tools by record id, and unknown records to null', async () => {
    const res = await call('POST', '/alerts/entities/links', {
      entities: [
        { type: 'agent', key: 'Pulse Main' },
        { type: 'kb', key: 'docs-kb' },
        { type: 'model', key: 'traces-only-model' },
        { type: 'mcp', key: 'no-such-server' },
        { type: 'tool', key: 'no-such-tool' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.links).toEqual({
      'agent:Pulse Main': '/dashboard/tracing/agents/Pulse%20Main',
      'kb:docs-kb': '/dashboard/rag/docs-kb',
      'model:traces-only-model': null,
      'mcp:no-such-server': null,
      'tool:no-such-tool': null,
    });
  });

  it('prefers the enterprise resolver and falls back to the core page', async () => {
    registerEntityLinkResolver((type, key) => (type === 'kb' ? `/dashboard/tracing/health/kb/${key}` : null));
    const res = await call('POST', '/alerts/entities/links', { entities: [{ type: 'kb', key: 'k1' }, { type: 'agent', key: 'a1' }] });
    expect(res.body.links).toEqual({
      'kb:k1': '/dashboard/tracing/health/kb/k1',
      'agent:a1': '/dashboard/tracing/agents/a1',
    });
  });

  it('rejects malformed requests', async () => {
    expect((await call('POST', '/alerts/entities/links', {})).status).toBe(400);
    expect((await call('POST', '/alerts/entities/links', { entities: [{ type: 'robot', key: 'x' }] })).status).toBe(400);
    expect((await call('POST', '/alerts/entities/links', { entities: [{ type: 'kb' }] })).status).toBe(400);
    expect((await call('POST', '/alerts/entities/links', { entities: Array.from({ length: 101 }, (_, i) => ({ type: 'kb', key: `k${i}` })) })).status).toBe(400);
  });
});
