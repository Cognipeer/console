/**
 * Connector triggers over the triggers API: the client mount
 * (`/api/client/v1/agents/:agentKey/triggers…`) and the dashboard mount
 * (`/api/agents/:agentId/triggers…`), real Fastify handlers over a REAL SQLite
 * store, with a stand-in for the enterprise Connectors module
 * (`helpers/fakeConnectorHost`) registered at the seam, or none.
 *
 * What is pinned: create / update / type change / delete call the host in the
 * documented order (prepare, then attach; detach while the row still exists),
 * a vendor failure never fails a write, a subscription shared by several
 * triggers survives until the last one is gone, the answers carry
 * `connector_subscription`, retry / rotate / Run now behave the same on both
 * mounts, the community edition (no host) refuses connector writes, and a
 * trigger stored with a retired vendor preset is read-only except to convert.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  fireTrigger: vi.fn(),
  db: { current: null as unknown },
  auth: { current: null as unknown },
  session: { current: null as unknown },
}));

vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});
vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
  type Handler = (request: unknown, reply: unknown, ctx?: unknown) => unknown;
  return {
    ...actual,
    withClientApiRequestContext: (handler: Handler) => async (request: unknown, reply: unknown) => handler(request, reply, hoisted.auth.current),
    withApiRequestContext: (handler: Handler) => async (request: unknown, reply: unknown) => handler(request, reply),
    requireProjectContextForRequest: vi.fn(async () => hoisted.session.current),
  };
});
vi.mock('@/lib/services/agents/agentTriggers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentTriggers')>();
  return { ...actual, fireTrigger: hoisted.fireTrigger };
});
vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
  return {
    ...actual,
    waitForAgentRun: vi.fn(),
    resolveAgentRunLimits: vi.fn(async () => ({ syncWaitMs: 60_000, maxDurationMs: 1_800_000, maxActivePerTenant: 250, maxActivePerProject: 0 })),
  };
});

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAgentTrigger } from '@/lib/database';
import { __resetConnectorTriggerHostForTests, registerConnectorTriggerHost } from '@/enterprise/connector-triggers';
import { createAgentTrigger } from '@/lib/services/agents/agentTriggers';
import { persistConnectorSettings } from '@/lib/services/agents/agentTriggerConnectorHost';
import { parseWebhookWrite } from '@/lib/services/agents/agentTriggerWebhookIntake';
import { deleteAgentRecord } from '@/lib/services/agents/agentService';
import { agentTriggersApiPlugin } from '@/server/api/plugins/agent-triggers';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';
import { createFakeConnectorHost, type FakeConnectorHost } from '../helpers/fakeConnectorHost';
import { shapeProblems } from '../helpers/openapiShape';

const DB_NAME = 'tenant_connector_routes';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'pr-bot';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let agentId: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;
let fake: FakeConnectorHost;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Reply = { statusCode: number; body: string; headers: Record<string, unknown> };
type Call = (method: Method, suffix?: string, payload?: unknown) => Promise<Reply>;

const client: Call = async (method, suffix = '', payload) => app.inject({
  method, url: `/api/client/v1/agents/${AGENT_KEY}/triggers${suffix}`,
  headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
  ...(payload !== undefined ? { payload: payload as never } : {}),
});
const dashboard: Call = async (method, suffix = '', payload) => app.inject({
  method, url: `/api/agents/${agentId}/triggers${suffix}`,
  headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
  ...(payload !== undefined ? { payload: payload as never } : {}),
});
const json = <T = Record<string, any>>(res: { body: string }) => parseJsonBody<T>(res.body); // eslint-disable-line @typescript-eslint/no-explicit-any

const CONNECTOR = {
  connector_id: 'conn-1', trigger: 'pull_request', params: { repository: 'acme/api' },
  events: ['pull_request.opened'], filter: [{ path: 'payload.action', op: 'eq', value: 'opened' }],
};
const body = (extra: Record<string, unknown> = {}, connector: Record<string, unknown> = CONNECTOR) => ({
  name: 'PR reviewer', type: 'connector', connector, prompt: 'Review PR {{payload.number}} ({{event}}).', ...extra,
});

const storedTriggers = () => db.listAgentTriggers({ tenantId, projectId: PROJECT_ID });
const storedConnector = async (id: string) => {
  const row = (await storedTriggers()).find((item) => String(item._id) === id);
  if (!row || row.type !== 'connector') throw new Error('not a connector trigger');
  return row.connector;
};

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'connector-routes-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-connector-routes', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  const agent = await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'PR bot', status: 'active', createdBy: 'user-1',
    config: { modelKey: 'gpt-4o', variables: [{ name: 'days', type: 'integer' }] },
  });
  agentId = String(agent._id);
  await db.createAgentVersion({
    tenantId, projectId: PROJECT_ID, agentId, agentKey: AGENT_KEY, version: 1,
    snapshot: { name: 'PR bot', config: { modelKey: 'gpt-4o' }, status: 'active' }, publishedBy: 'user-1',
  } as never);
  hoisted.auth.current = {
    token: 'tok', tokenRecord: { _id: 'tok-1', userId: 'user-1' }, tenant: { licenseType: 'FREE' },
    tenantId, tenantSlug: 'acme', tenantDbName: DB_NAME, projectId: PROJECT_ID, user: { _id: 'user-1', role: 'owner', tenantId },
  };
  hoisted.session.current = {
    projectId: PROJECT_ID, user: { _id: 'user-2', role: 'user' }, session: { tenantDbName: DB_NAME, tenantId, userId: 'user-2', licenseType: 'FREE' },
  };
  fake = createFakeConnectorHost();
  app = await createFastifyApiTestApp(agentTriggersApiPlugin);
});

afterEach(async () => {
  __resetConnectorTriggerHostForTests();
  await app?.close();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe.each([
  ['client mount', client],
  ['dashboard mount', dashboard],
] as const)('connector triggers: %s', (_name, call) => {
  describe('with the Connectors module', () => {
    beforeEach(() => registerConnectorTriggerHost(fake.host));

    it('create: prepare, then attach; the answer carries the connector and its subscription (secret once)', async () => {
      const res = await call('POST', '', body());
      expect(res.statusCode, res.body).toBe(201);
      const created = json(res);
      expect(fake.calls).toEqual(['prepare', `attach:${created.id}`]);
      expect(created).toMatchObject({
        object: 'agent.trigger', type: 'connector', connector_available: true, enabled: true,
        connector: {
          connector_id: 'conn-1', trigger: 'pull_request', params: { repository: 'acme/api' }, events: ['pull_request.opened'],
          filter: CONNECTOR.filter, include_payload: true, subscription_id: 'sub_1', package_id: 'cognipeer.github', kind: 'webhook', label: 'GitHub - Pull request',
        },
        connector_subscription: { subscription_id: 'sub_1', status: 'active', kind: 'webhook', bindings: 1, secret: expect.stringMatching(/^whsec_/) },
      });
      expect(['schedule', 'once', 'webhook'].some((key) => key in created)).toBe(false);
      expect(created.next_fire_at).toBeNull();
      // Stored with the subscription the host handed back, and the host saw the caller's project.
      expect((await storedConnector(created.id)).subscriptionId).toBe('sub_1');
      expect(fake.scopes[0]).toMatchObject({ tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID });
      // A read shows the subscription again, without the secret.
      const read = json(await call('GET', `/${created.id}`));
      expect(read.connector_subscription).toMatchObject({ subscription_id: 'sub_1', status: 'active' });
      expect(read.connector_subscription.secret ?? null).toBeNull();
      expect(JSON.stringify(read)).not.toContain(created.connector_subscription.secret);
    });

    it('the list marks connector triggers available and does not call the host', async () => {
      await call('POST', '', body());
      fake.calls.length = 0;
      const list = json<{ data: Array<Record<string, any>> }>(await call('GET')); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(list.data[0]).toMatchObject({ type: 'connector', connector_available: true, connector: { connector_id: 'conn-1' } });
      expect(fake.calls).toEqual([]);
    });

    it('the host refuses the settings: 400 invalid_trigger with the host\'s field errors, nothing stored, no attach', async () => {
      const unknown = await call('POST', '', body({}, { ...CONNECTOR, connector_id: 'conn-x' }));
      expect(unknown.statusCode).toBe(400);
      expect(json(unknown).error).toMatchObject({ code: 'invalid_trigger', errors: [{ field: 'connector.connector_id' }] });
      const badTrigger = await call('POST', '', body({}, { ...CONNECTOR, trigger: 'nope' }));
      expect(json(badTrigger).error.errors[0].field).toBe('connector.trigger');
      const badParams = await call('POST', '', body({}, { ...CONNECTOR, params: { bad: 1 } }));
      expect(json(badParams).error.errors[0].field).toBe('connector.params.bad');
      expect(await storedTriggers()).toEqual([]);
      expect(fake.calls.filter((entry) => entry.startsWith('attach'))).toEqual([]);
    });

    it('core validates what the host does not see: ids, params size, events, filter, prompt template and the settings object', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [body({}, { trigger: 'pull_request' }), 'connector.connector_id'],
        [body({}, { connector_id: 'conn-1' }), 'connector.trigger'],
        [body({}, { ...CONNECTOR, events: ['bad event'] }), 'connector.events'],
        [body({}, { ...CONNECTOR, events: 'pull_request.opened' }), 'connector.events'],
        [body({}, { ...CONNECTOR, filter: [{ path: 'payload.constructor', op: 'exists' }] }), 'connector.filter[0].path'],
        [body({}, { ...CONNECTOR, include_payload: 'yes' }), 'connector.include_payload'],
        [body({}, { ...CONNECTOR, params: { big: 'x'.repeat(70_000) } }), 'connector.params'],
        [body({}, { ...CONNECTOR, schedule: 'daily' }), 'connector.schedule'],
        [body({ prompt: 'Hi {{{payload.title}}}' }), 'prompt'],
        [body({ variables: { days: '{{secret.x}}' } }), 'variables.days'],
        [{ name: 'x', type: 'manual', connector: CONNECTOR, prompt: 'x' }, 'connector'],
        [{ name: 'x', type: 'connector', prompt: 'x' }, 'connector.connector_id'],
      ];
      for (const [payload, field] of cases) {
        const res = await call('POST', '', payload);
        expect(res.statusCode, JSON.stringify(payload).slice(0, 120)).toBe(400);
        expect(json(res).error, field).toMatchObject({ code: 'invalid_trigger', errors: expect.arrayContaining([expect.objectContaining({ field })]) });
      }
      expect(await storedTriggers()).toEqual([]);
    });

    it('a poll trigger takes a schedule; the cron is checked by core', async () => {
      const poll = { connector_id: 'conn-poll', trigger: 'issue_updated', params: {}, schedule: { cron: '*/15 * * * *', timezone: 'Europe/Istanbul' } };
      const res = await call('POST', '', body({}, poll));
      expect(res.statusCode, res.body).toBe(201);
      expect(json(res).connector).toMatchObject({ kind: 'poll', schedule: { cron: '*/15 * * * *', timezone: 'Europe/Istanbul' } });
      const bad = await call('POST', '', body({}, { ...poll, schedule: { cron: '0 0 9 * * *' } }));
      expect(json(bad).error.errors[0].field).toBe('connector.schedule.cron');
    });

    it('an attach failure never fails the write: the trigger is stored and reads as a failed subscription', async () => {
      fake.failing.add('attach');
      const res = await call('POST', '', body());
      expect(res.statusCode, res.body).toBe(201);
      const created = json(res);
      expect(created.connector_subscription).toMatchObject({ status: 'failed' });
      expect(created.connector.subscription_id).toBeNull();
      expect((await storedConnector(created.id)).subscriptionId ?? null).toBeNull();
      // The retry route has nothing to retry yet (no subscription): 409, not a server error.
      const retry = await call('POST', `/${created.id}/connector/retry`);
      expect(retry.statusCode).toBe(409);
      expect(json(retry).error.code).toBe('connector_subscription_missing');
    });

    it('a rename or an events change keeps the subscription: attach again, no detach', async () => {
      const created = json(await call('POST', '', body()));
      fake.calls.length = 0;
      const renamed = await call('PATCH', `/${created.id}`, { name: 'Renamed', type: 'connector', connector: { events: ['pull_request.opened', 'pull_request.reopened'] } });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(json(renamed).connector).toMatchObject({ subscription_id: 'sub_1', events: ['pull_request.opened', 'pull_request.reopened'] });
      expect(fake.calls).toEqual(['prepare', `attach:${created.id}`]);
      expect(fake.boundTo('sub_1')).toEqual([created.id]);
      // A PATCH without the type or the connector touches only the trigger.
      fake.calls.length = 0;
      await call('PATCH', `/${created.id}`, { enabled: false });
      expect(fake.calls.filter((entry) => entry.startsWith('detach'))).toEqual([]);
      expect((await storedConnector(created.id)).subscriptionId).toBe('sub_1');
    });

    it('changing the params detaches the old subscription (row still there), then attaches a new one', async () => {
      const created = json(await call('POST', '', body()));
      fake.calls.length = 0;
      const moved = await call('PATCH', `/${created.id}`, { type: 'connector', connector: { params: { repository: 'acme/web' } } });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(fake.calls).toEqual(['prepare', `detach:${created.id}`, `attach:${created.id}`]);
      expect(json(moved).connector.subscription_id).toBe('sub_2');
      expect([...fake.subscriptions.keys()]).toEqual(['sub_2']);
      expect((await storedConnector(created.id)).subscriptionId).toBe('sub_2');
    });

    it('a detach failure is logged and ignored', async () => {
      const created = json(await call('POST', '', body()));
      fake.failing.add('detach');
      const res = await call('DELETE', `/${created.id}`);
      expect(res.statusCode).toBe(200);
      expect(await storedTriggers()).toEqual([]);
    });

    it('away from connector: detach once, the row loses its connector; back to connector: attach', async () => {
      const created = json(await call('POST', '', body()));
      fake.calls.length = 0;
      const manual = await call('PATCH', `/${created.id}`, { type: 'manual', prompt: 'Plain.' });
      expect(manual.statusCode, manual.body).toBe(200);
      expect(json(manual)).toMatchObject({ type: 'manual' });
      expect(json(manual)).not.toHaveProperty('connector');
      expect(fake.calls).toEqual([`detach:${created.id}`]);
      expect(fake.subscriptions.size).toBe(0);

      fake.calls.length = 0;
      const back = await call('PATCH', `/${created.id}`, { type: 'connector', connector: CONNECTOR, prompt: 'Review {{payload.number}}.' });
      expect(back.statusCode, back.body).toBe(200);
      expect(fake.calls).toEqual(['prepare', `attach:${created.id}`]);
      expect(json(back).connector_subscription).toMatchObject({ status: 'active' });
    });

    it('delete detaches while the trigger still exists; a subscription shared by two triggers goes with the last one', async () => {
      const first = json(await call('POST', '', body({ name: 'A' })));
      const second = json(await call('POST', '', body({ name: 'B' })));
      expect(second.connector.subscription_id).toBe(first.connector.subscription_id);
      expect(json(await call('GET', `/${second.id}`)).connector_subscription.bindings).toBe(2);
      fake.calls.length = 0;
      expect((await call('DELETE', `/${first.id}`)).statusCode).toBe(200);
      expect(fake.calls).toEqual([`detach:${first.id}`]);
      expect(fake.boundTo('sub_1')).toEqual([second.id]);
      expect((await call('DELETE', `/${second.id}`)).statusCode).toBe(200);
      expect(fake.subscriptions.size).toBe(0);
      expect(await storedTriggers()).toEqual([]);
    });

    it('retry: the trigger with its subscription after the host acted; 400 for another type; 502 when the host throws', async () => {
      fake.attachStatus = 'failed';
      const created = json(await call('POST', '', body()));
      expect(created.connector_subscription.status).toBe('failed');
      const retried = await call('POST', `/${created.id}/connector/retry`);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(json(retried)).toMatchObject({ id: created.id, type: 'connector', connector_subscription: { status: 'active' } });
      expect(fake.calls.at(-1)).toBe(`retry:${created.id}`);

      const manual = json(await call('POST', '', { name: 'Hand', type: 'manual', prompt: 'x' }));
      const wrong = await call('POST', `/${manual.id}/connector/retry`);
      expect(wrong.statusCode).toBe(400);
      expect(json(wrong).error.code).toBe('trigger_not_connector');

      fake.failing.add('retry');
      const down = await call('POST', `/${created.id}/connector/retry`);
      expect(down.statusCode).toBe(502);
      expect(json(down).error.code).toBe('connector_retry_failed');
      expect((await call('POST', '/nope/connector/retry')).statusCode).toBe(404);
    });

    it('retry of a trigger whose subscription is gone: the host binds it again and the answer names the new subscription, the one stored', async () => {
      const created = json(await call('POST', '', body()));
      expect(created.connector.subscription_id).toBe('sub_1');
      // The stand-in binds again like the real module does: a new subscription, its id stored on the trigger.
      registerConnectorTriggerHost({
        ...fake.host,
        retry: async (scope, trigger) => {
          const attached = await fake.host.attach(scope, trigger);
          await persistConnectorSettings(DB_NAME, trigger, attached.settings);
          return attached.view;
        },
      });
      fake.subscriptions.clear();
      const retried = await call('POST', `/${created.id}/connector/retry`);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(json(retried).connector.subscription_id).toBe('sub_2');
      expect(json(retried).connector_subscription).toMatchObject({ subscription_id: 'sub_2', status: 'active' });
      expect((await storedConnector(created.id)).subscriptionId).toBe('sub_2');
      expect(json(await call('GET', `/${created.id}`)).connector.subscription_id).toBe('sub_2');
    });

    it('a store failure after the old subscription was given up stores nothing: the row keeps its settings and names the lost subscription; the same change sent again binds a new one', async () => {
      const created = json(await call('POST', '', body()));
      fake.calls.length = 0;
      const change = { type: 'connector', connector: { params: { repository: 'acme/web' } } };
      const spy = vi.spyOn(db, 'updateAgentTrigger').mockRejectedValueOnce(new Error('the store is down'));
      const failed = await call('PATCH', `/${created.id}`, change);
      spy.mockRestore();
      expect(failed.statusCode).toBe(500);
      // The host gave the old subscription up before the write, and was not asked to bind anything.
      expect(fake.calls).toEqual(['prepare', `detach:${created.id}`]);
      expect(fake.subscriptions.size).toBe(0);
      expect(await storedConnector(created.id)).toMatchObject({ subscriptionId: 'sub_1', params: { repository: 'acme/api' } });

      const again = await call('PATCH', `/${created.id}`, change);
      expect(again.statusCode, again.body).toBe(200);
      expect(json(again).connector).toMatchObject({ subscription_id: 'sub_2', params: { repository: 'acme/web' } });
      expect(json(again).connector_subscription).toMatchObject({ subscription_id: 'sub_2', status: 'active' });
      expect([...fake.subscriptions.keys()]).toEqual(['sub_2']);
      expect(await storedConnector(created.id)).toMatchObject({ subscriptionId: 'sub_2', params: { repository: 'acme/web' } });
    });

    it('rotate-secret goes through the host: a new secret once; 502 on a host error; a poll has none (400)', async () => {
      const created = json(await call('POST', '', body()));
      const rotated = await call('POST', `/${created.id}/webhook/rotate-secret`, { grace_seconds: 60 });
      expect(rotated.statusCode, rotated.body).toBe(200);
      expect(json(rotated)).toMatchObject({
        object: 'agent.trigger.webhook_secret', secret: expect.stringMatching(/^whsec_rotated_/),
        connector_subscription: { subscription_id: 'sub_1' },
      });
      fake.failing.add('rotate');
      expect((await call('POST', `/${created.id}/webhook/rotate-secret`, {})).statusCode).toBe(502);
      fake.failing.clear();
      const poll = json(await call('POST', '', body({ name: 'Poll' }, { connector_id: 'conn-poll', trigger: 'issue_updated', params: {}, schedule: { cron: '*/15 * * * *' } })));
      const none = await call('POST', `/${poll.id}/webhook/rotate-secret`, {});
      expect(none.statusCode).toBe(200);
      expect(json(none)).not.toHaveProperty('secret');
    });

    it('rotate-secret says when the previous secret stops working, on the answer and on the subscription', async () => {
      const created = json(await call('POST', '', body()));
      const before = Math.floor(Date.now() / 1000);
      const graced = json(await call('POST', `/${created.id}/webhook/rotate-secret`, { grace_seconds: 3600 }));
      expect(graced.previous_valid_until).toBeGreaterThanOrEqual(before + 3600);
      expect(graced.previous_valid_until).toBeLessThanOrEqual(before + 3600 + 10);
      expect(graced.connector_subscription.previous_secret_valid_until).toBe(graced.previous_valid_until);
      // A read of the trigger shows the same expiry, and no secret.
      const read = json(await call('GET', `/${created.id}`));
      expect(read.connector_subscription.previous_secret_valid_until).toBe(graced.previous_valid_until);
      expect(read.connector_subscription.secret ?? null).toBeNull();
      // Without a grace period the old secret stops at once: nothing to wait for.
      const now = json(await call('POST', `/${created.id}/webhook/rotate-secret`, {}));
      expect(now.previous_valid_until).toBeNull();
      expect(now.connector_subscription.previous_secret_valid_until).toBeNull();
      expect(json(await call('GET', `/${created.id}`)).connector_subscription.previous_secret_valid_until).toBeNull();
    });

    // The Connectors module throws its ConnectorError for a call it will not make: a 4xx status and a code (the licence guard: 402 / 403).
    const refusal = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

    describe.each([
      ['retry', (id: string) => call('POST', `/${id}/connector/retry`), 'connector_retry_failed'],
      ['rotate-secret', (id: string) => call('POST', `/${id}/webhook/rotate-secret`, {}), 'connector_rotate_failed'],
    ] as const)('%s when the host refuses', (method, send, failedCode) => {
      const hostMethod = method === 'retry' ? 'retry' : 'rotate';
      let id = '';
      beforeEach(async () => {
        id = json(await call('POST', '', body())).id;
      });

      it.each([
        [402, 'permission_error', 'service_unavailable', 'Connectors require an active ENTERPRISE license.'],
        [403, 'permission_error', 'service_unavailable', 'Connector triggers start agent runs, and the Agents service is off for this workspace.'],
        [409, 'invalid_request_error', 'account_required', 'The connector "GitHub" has no connected account'],
        [404, 'not_found_error', 'NOT_FOUND', 'Connector not found'],
        [429, 'rate_limit_error', 'rate_limited', 'Too many tries; wait a minute'],
        [400, 'invalid_request_error', 'credential_rejected', 'GitHub refused the credential'],
      ])('answers a %i with its own message and code as a %s', async (status, type, code, message) => {
        fake.failWith.set(hostMethod, refusal(status, code, message));
        const res = await send(id);
        expect(res.statusCode, res.body).toBe(status);
        expect(json(res)).toEqual({ error: { type, message, code } });
        expect(shapeProblems(json(res), 'Error')).toEqual([]);
        expect(fake.calls.at(-1)).toBe(`${hostMethod}:${id}`);
      });

      it.each([
        ['an error without a status', new Error('boom')],
        ['a 500 with a code', refusal(500, 'internal_error', 'boom')],
        ['a 502 with a code', refusal(502, 'vendor_unavailable', 'boom')],
        ['a 503 with a code', refusal(503, 'connector_unavailable', 'boom')],
        ['a status below 400 with a code', refusal(399, 'redirected', 'boom')],
        ['a 4xx status without a code', Object.assign(new Error('boom'), { status: 402 })],
        ['a 4xx status with an empty code', refusal(402, '', 'boom')],
        ['a 4xx status with a code that is a number', Object.assign(new Error('boom'), { status: 402, code: 11000 })],
        ['a status that is a string', Object.assign(new Error('boom'), { status: '402', code: 'service_unavailable' })],
        ['a status that is not a whole number', refusal(402.5, 'service_unavailable', 'boom')],
        ['a thrown string', 'boom'],
        ['a thrown null', null],
      ])('stays a 502 for %s, and says nothing of what the host said', async (_what, thrown) => {
        fake.failWith.set(hostMethod, thrown);
        const res = await send(id);
        expect(res.statusCode, res.body).toBe(502);
        expect(json(res)).toEqual({ error: expect.objectContaining({ type: 'api_error', code: failedCode }) });
        expect(res.body).not.toContain('boom');
      });
    });

    it('tells the Connectors module the reader\'s language (?locale=tr|en) on every call it makes for the request', async () => {
      const localesOf = async (run: () => Promise<unknown>) => {
        fake.scopes.length = 0;
        await run();
        return fake.scopes.map((scope) => ('locale' in scope ? scope.locale : '(none)'));
      };
      let id = '';
      expect(await localesOf(async () => { id = json(await call('POST', '?locale=tr', body())).id; })).toEqual(['tr', 'tr']); // prepare, attach
      expect(await localesOf(() => call('GET', `/${id}?locale=en`))).toEqual(['en']);
      expect(await localesOf(() => call('PATCH', `/${id}?locale=tr`, { type: 'connector', connector: { params: { repository: 'acme/web' } } }))).toEqual(['tr', 'tr', 'tr']); // prepare, detach, attach
      expect(await localesOf(() => call('POST', `/${id}/webhook/rotate-secret?locale=en`, {}))).toEqual(['en']);
      expect(await localesOf(() => call('POST', `/${id}/connector/retry?locale=tr`))).toEqual(['tr']);
      expect(await localesOf(() => call('POST', `/${id}/run?locale=tr`, { dry_run: true }))).toEqual(['tr']);
      expect(await localesOf(() => call('DELETE', `/${id}?locale=en`))).toEqual(['en']);
    });

    it('leaves the language out when the request names none, or one the Connectors module has no texts for', async () => {
      for (const query of ['', '?locale=de', '?locale=', '?locale=TR', '?locale[]=tr']) {
        fake.scopes.length = 0;
        const res = await call('POST', query, body({ name: `Locale ${query}` }, { ...CONNECTOR, params: { repository: `acme/${query.length}` } }));
        expect(res.statusCode, query).toBe(201);
        expect(fake.scopes.length, query).toBeGreaterThan(0);
        for (const scope of fake.scopes) expect(scope, query).not.toHaveProperty('locale');
      }
    });

    it('a subscription gives the reason as a stable code as well as a sentence; none when nothing is wrong', async () => {
      const ok = json(await call('POST', '', body({ name: 'Fine' })));
      expect(ok.connector_subscription).toMatchObject({ status: 'active', reason: null, reason_code: null });

      // The host answers a failed view of its own.
      fake.attachStatus = 'failed';
      const refused = json(await call('POST', '', body({ name: 'Refused' }, { ...CONNECTOR, params: { repository: 'acme/web' } })));
      expect(refused.connector_subscription).toMatchObject({ status: 'failed', reason: 'The vendor refused the registration.', reason_code: 'subscribe_failed' });
      fake.attachStatus = 'active';

      // The host itself fails: core stores the trigger and reports the failure with its own code.
      fake.failing.add('attach');
      const down = json(await call('POST', '', body({ name: 'Down' }, { ...CONNECTOR, params: { repository: 'acme/db' } })));
      expect(down.connector_subscription).toMatchObject({
        status: 'failed', reason: 'The connection to the connector could not be set up. Retry.', reason_code: 'attach_failed',
      });
    });

    it('the answers fit the schemas openapi.yaml documents: no undeclared field, no null where none is allowed', async () => {
      const created = json(await call('POST', '', body()));
      expect(shapeProblems(created, 'AgentTrigger')).toEqual([]);
      expect(shapeProblems(json(await call('GET', `/${created.id}`)), 'AgentTrigger')).toEqual([]);
      const list = json<{ data: unknown[] }>(await call('GET'));
      for (const item of list.data) expect(shapeProblems(item, 'AgentTrigger')).toEqual([]);

      const patched = json(await call('PATCH', `/${created.id}`, { name: 'Renamed', type: 'connector', connector: { events: ['pull_request.opened'] } }));
      expect(shapeProblems(patched, 'AgentTrigger')).toEqual([]);

      // Every state of a subscription the API can answer.
      for (const rotation of [{}, { grace_seconds: 600 }]) {
        const rotated = json(await call('POST', `/${created.id}/webhook/rotate-secret`, rotation));
        expect(shapeProblems(rotated, 'AgentTriggerWebhookSecret')).toEqual([]);
        expect(shapeProblems(rotated.connector_subscription, 'ConnectorSubscription')).toEqual([]);
      }
      fake.attachStatus = 'failed';
      const failed = json(await call('POST', '', body({ name: 'Refused' }, { ...CONNECTOR, params: { repository: 'acme/web' } })));
      expect(shapeProblems(failed, 'AgentTrigger')).toEqual([]);
      fake.attachStatus = 'active';
      const retried = json(await call('POST', `/${failed.id}/connector/retry`));
      expect(shapeProblems(retried, 'AgentTrigger')).toEqual([]);

      fake.failing.add('attach');
      const down = json(await call('POST', '', body({ name: 'Down' }, { ...CONNECTOR, params: { repository: 'acme/db' } })));
      expect(shapeProblems(down, 'AgentTrigger')).toEqual([]);
      fake.failing.clear();

      const poll = json(await call('POST', '', body({ name: 'Poll' }, { connector_id: 'conn-poll', trigger: 'issue_updated', params: {}, schedule: { cron: '*/15 * * * *' } })));
      expect(shapeProblems(poll, 'AgentTrigger')).toEqual([]);
      expect(shapeProblems(json(await call('POST', `/${poll.id}/webhook/rotate-secret`, {})), 'AgentTriggerWebhookSecret')).toEqual([]);
    });

    it('Run now uses the package\'s sample without a payload, and the given payload and event with one; dry_run fires nothing', async () => {
      const created = json(await call('POST', '', body({ variables: { days: '{{payload.number}}' } })));
      const dry = await call('POST', `/${created.id}/run`, { dry_run: true });
      expect(dry.statusCode, dry.body).toBe(200);
      expect(json(dry)).toMatchObject({
        object: 'agent.trigger.dry_run', matched: true, event: 'pull_request.opened', variables: { days: 42 }, errors: [],
      });
      expect(json(dry).prompt).toContain('Review PR 42 ("pull_request.opened").');
      expect(fake.calls).toContain(`sample:${created.id}`);
      expect(hoisted.fireTrigger).not.toHaveBeenCalled();

      // The trigger's events list and filter are not applied by Run now.
      const miss = json(await call('POST', `/${created.id}/run`, { dry_run: true, event: 'pull_request.closed', payload: { action: 'closed', number: 5 } }));
      expect(miss).toMatchObject({ matched: false, event: 'pull_request.closed' });

      hoisted.fireTrigger.mockResolvedValue({ kind: 'accepted', run: { _id: 'r1', mode: 'background', status: 'queued', runClass: 'default', tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: 'c', userId: 'system:trigger:x', channel: 'trigger', trigger: 'manual', createdAt: new Date() } });
      const fired = await call('POST', `/${created.id}/run`, { event: 'pull_request.opened', payload: { action: 'opened', number: 7 } });
      expect(fired.statusCode, fired.body).toBe(202);
      const input = hoisted.fireTrigger.mock.calls[0][2];
      expect(input).toMatchObject({
        trigger: 'manual', externalContent: true, variables: { days: 7 },
        metadata: { connector_id: 'conn-1', connector_trigger: 'pull_request', event_type: 'pull_request.opened' },
        triggerData: { event: 'pull_request.opened', payload: { action: 'opened', number: 7 } },
      });
      expect(input.message).toMatch(/^This run was started by a connector trigger \(/);
      expect(input.message).toContain('Connector event (JSON):');
    });

    it('Run now refuses what a connector trigger does not take, and a bad event name', async () => {
      const created = json(await call('POST', '', body()));
      expect((await call('POST', `/${created.id}/run`, { headers: { 'x-a': 'b' } })).statusCode).toBe(400);
      expect((await call('POST', `/${created.id}/run`, { event: 'bad event!' })).statusCode).toBe(400);
      expect((await call('POST', `/${created.id}/run`, { payload: 'text' })).statusCode).toBe(400);
      const manual = json(await call('POST', '', { name: 'Hand', type: 'manual', prompt: 'x' }));
      const event = await call('POST', `/${manual.id}/run`, { event: 'push' });
      expect(event.statusCode).toBe(400);
      expect(json(event).error.code).toBe('invalid_request');
    });

    it('deleting the agent gives every connector trigger its subscription back', async () => {
      const first = json(await call('POST', '', body({ name: 'A' })));
      const second = json(await call('POST', '', body({ name: 'B' }, { ...CONNECTOR, trigger: 'workflow_run' })));
      fake.calls.length = 0;
      expect(await deleteAgentRecord(DB_NAME, agentId)).toBe(true);
      expect(fake.calls.sort()).toEqual([`detach:${first.id}`, `detach:${second.id}`].sort());
      expect(fake.subscriptions.size).toBe(0);
      expect(await storedTriggers()).toEqual([]);
    });
  });

  describe('without the Connectors module (community edition)', () => {
    it('refuses to create a connector trigger: 400 invalid_trigger on the type', async () => {
      const res = await call('POST', '', body());
      expect(res.statusCode).toBe(400);
      expect(json(res).error).toMatchObject({ code: 'invalid_trigger', errors: [{ field: 'type', message: 'Connector triggers need the enterprise Connectors module.' }] });
      expect(await storedTriggers()).toEqual([]);
    });

    it('a stored connector trigger reads as unavailable; retry, rotate and Run now say so (409); it can still be deleted or switched', async () => {
      // Stored while a module was present, read after it is gone.
      registerConnectorTriggerHost(fake.host);
      const created = json(await call('POST', '', body()));
      __resetConnectorTriggerHostForTests();

      const read = json(await call('GET', `/${created.id}`));
      expect(read).toMatchObject({ type: 'connector', connector_available: false, connector_subscription: null, connector: { connector_id: 'conn-1' } });
      for (const [suffix, payload] of [['/connector/retry', undefined], ['/webhook/rotate-secret', {}], ['/run', {}]] as const) {
        const res = await call('POST', `/${created.id}${suffix}`, payload);
        expect(res.statusCode, suffix).toBe(409);
        expect(json(res).error.code, suffix).toBe('connector_triggers_unavailable');
      }
      const manual = await call('PATCH', `/${created.id}`, { type: 'manual', prompt: 'Plain.' });
      expect(manual.statusCode, manual.body).toBe(200);
      expect((await call('DELETE', `/${created.id}`)).statusCode).toBe(200);
    });
  });
});

describe('retired vendor presets through the API', () => {
  /** A trigger stored the way the removed vendor presets left it. */
  async function retired(preset: 'github' | 'gitlab' | 'azure_devops' = 'github', auth: 'github_signature' | 'gitlab_token' | 'basic' = 'github_signature'): Promise<IAgentTrigger> {
    const parsed = parseWebhookWrite({ preset: 'generic' }, null);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    return createAgentTrigger({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID }, AGENT_KEY, {
      name: 'legacy', type: 'webhook', webhook: { ...parsed.webhook, preset, auth }, prompt: 'Review.',
    }, 'user-1');
  }

  it('reads with webhook.retired true; the old preset and auth are still shown', async () => {
    const row = await retired('gitlab', 'gitlab_token');
    const read = json(await client('GET', `/${String(row._id)}`));
    expect(read).toMatchObject({ type: 'webhook', webhook: { retired: true, preset: 'gitlab', auth: 'gitlab_token' } });
    expect(read.webhook).not.toHaveProperty('secret');
  });

  it('creating a webhook with a retired preset or auth is refused', async () => {
    for (const webhook of [{ preset: 'github' }, { preset: 'gitlab' }, { preset: 'azure_devops' }, { preset: 'generic', auth: 'github_signature' }, { preset: 'generic', auth: 'basic' }]) {
      const res = await client('POST', '', { name: 'x', type: 'webhook', webhook, prompt: 'x' });
      expect(res.statusCode, JSON.stringify(webhook)).toBe(400);
    }
    expect(await storedTriggers()).toEqual([]);
  });

  it('Run now and rotate-secret are 410 webhook_preset_retired; a name change still works', async () => {
    const row = await retired();
    const id = String(row._id);
    const run = await client('POST', `/${id}/run`, { payload: { a: 1 } });
    expect(run.statusCode).toBe(410);
    expect(json(run).error).toMatchObject({ type: 'gone', code: 'webhook_preset_retired' });
    const rotate = await client('POST', `/${id}/webhook/rotate-secret`, {});
    expect(rotate.statusCode).toBe(410);
    expect(json(rotate).error.code).toBe('webhook_preset_retired');
    expect(hoisted.fireTrigger).not.toHaveBeenCalled();
    expect((await client('PATCH', `/${id}`, { name: 'legacy (retired)' })).statusCode).toBe(200);
  });

  it('writing the webhook object of a retired trigger makes it a generic webhook with a new hook (new URL and secret); a retired preset in the write is refused', async () => {
    const row = await retired();
    const id = String(row._id);
    const oldUrl = json(await client('GET', `/${id}`)).webhook.url;
    const stillRetired = await client('PATCH', `/${id}`, { type: 'webhook', webhook: { preset: 'github', events: ['push'] } });
    expect(stillRetired.statusCode).toBe(400);
    const rewritten = await client('PATCH', `/${id}`, { type: 'webhook', webhook: { events: ['push'] } });
    expect(rewritten.statusCode, rewritten.body).toBe(200);
    const view = json(rewritten);
    expect(view.webhook).toMatchObject({ preset: 'generic', auth: 'bearer', retired: false, secret: expect.stringMatching(/^whsec_/) });
    expect(view.webhook.url).not.toBe(oldUrl);
    // The old URL is gone.
    expect(await db.findAgentTriggerByHookId(String(oldUrl).split('/').pop()!)).toBeNull();
  });

  it('converting to another type is allowed (manual here; connector with a module)', async () => {
    const row = await retired();
    const manual = await client('PATCH', `/${String(row._id)}`, { type: 'manual', prompt: 'Plain.' });
    expect(manual.statusCode, manual.body).toBe(200);
    expect(json(manual)).toMatchObject({ type: 'manual' });

    registerConnectorTriggerHost(fake.host);
    const other = await retired('azure_devops', 'basic');
    const converted = await client('PATCH', `/${String(other._id)}`, { type: 'connector', connector: CONNECTOR, prompt: 'Review {{payload.number}}.' });
    expect(converted.statusCode, converted.body).toBe(200);
    expect(json(converted)).toMatchObject({ type: 'connector', connector_subscription: { status: 'active' } });
    expect(json(converted)).not.toHaveProperty('webhook');
  });
});
