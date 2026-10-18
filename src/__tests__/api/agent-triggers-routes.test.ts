/**
 * The triggers API (§5.7) over its real Fastify handlers and a REAL SQLite
 * store: the client mount (`/api/client/v1/agents/:agentKey/triggers…`, API
 * token) and the dashboard mount (`/api/agents/:agentId/triggers…`, session).
 * Authentication and the run engine are stood in for: the token / session
 * context is given, and `fireTrigger` (its own tests: integration/agent-triggers)
 * is faked so Run now's answers can be checked one outcome at a time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  fireTrigger: vi.fn(),
  waitForAgentRun: vi.fn(),
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
    // Authentication and the service check are the gate's (its own tests); here the caller is given.
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
    waitForAgentRun: hoisted.waitForAgentRun,
    resolveAgentRunLimits: vi.fn(async () => ({ syncWaitMs: 60_000, maxDurationMs: 1_800_000, maxActivePerTenant: 250, maxActivePerProject: 0 })),
    // The real check resolves the host (public address); here a private literal stands for one that fails it.
    validateCallbackRequest: vi.fn(async (url: unknown, secret: unknown) => {
      if (typeof url === 'string' && url.includes('10.0.0.1')) return { ok: false, message: 'callback_url must resolve to a public address' };
      if (typeof secret === 'string' && secret.length < 16) return { ok: false, message: 'callback_secret must be 16–256 characters' };
      return { ok: true, url, ...(typeof secret === 'string' && secret ? { secret } : {}) };
    }),
  };
});

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { NewAgentTrigger } from '@/lib/database';
import { agentTriggersApiPlugin } from '@/server/api/plugins/agent-triggers';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const DB_NAME = 'tenant_trigger_routes';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'report-bot';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let agentId: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const client = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', suffix = '', payload?: unknown, headers: Record<string, string> = {}) => app.inject({
  method, url: `/api/client/v1/agents/${AGENT_KEY}/triggers${suffix}`,
  headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
  ...(payload !== undefined ? { payload: payload as never } : {}),
});
const dashboard = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', suffix = '', payload?: unknown) => app.inject({
  method, url: `/api/agents/${agentId}/triggers${suffix}`,
  headers: payload !== undefined ? { 'content-type': 'application/json' } : {},
  ...(payload !== undefined ? { payload: payload as never } : {}),
});
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);
const run = (overrides: Record<string, unknown> = {}) => ({
  _id: 'r1', mode: 'background', status: 'queued', runClass: 'default', tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY,
  conversationId: 'conv-1', userId: 'system:trigger:x', channel: 'trigger', trigger: 'manual', createdAt: new Date('2026-10-18T06:00:00Z'), ...overrides,
});

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'trigger-routes-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-trigger-routes', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  const agent = await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Reports', status: 'active', createdBy: 'user-1',
    config: { modelKey: 'gpt-4o', variables: [{ name: 'region', type: 'string', enum: ['eu', 'us'] }, { name: 'days', type: 'integer' }] },
  });
  agentId = String(agent._id);
  await db.createAgentVersion({
    tenantId, projectId: PROJECT_ID, agentId, agentKey: AGENT_KEY, version: 1,
    snapshot: { name: 'Reports', config: { modelKey: 'gpt-4o' }, status: 'active' }, publishedBy: 'user-1',
  } as never);
  hoisted.auth.current = {
    token: 'tok', tokenRecord: { _id: 'tok-1', userId: 'user-1' }, tenant: { licenseType: 'FREE' },
    tenantId, tenantSlug: 'acme', tenantDbName: DB_NAME, projectId: PROJECT_ID, user: { _id: 'user-1', role: 'owner', tenantId },
  };
  hoisted.session.current = {
    projectId: PROJECT_ID, user: { _id: 'user-2', role: 'user' }, session: { tenantDbName: DB_NAME, tenantId, userId: 'user-2', licenseType: 'FREE' },
  };
  app = await createFastifyApiTestApp(agentTriggersApiPlugin);
});

afterEach(async () => {
  await app?.close();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A trigger's type and the one settings object named after it. */
const SCHEDULE = { type: 'schedule', schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Istanbul' } };

describe('client API: /client/v1/agents/:agentKey/triggers', () => {
  it('POST creates a trigger (201) in the §5.7 shape; GET lists and reads it', async () => {
    const created = await client('POST', '', {
      name: 'Morning digest', description: 'Weekdays', ...SCHEDULE, prompt: 'Summarise.', variables: { region: 'eu' },
      class: 'deferred', metadata: { team: 'ops' }, callback: { url: 'https://example.com/hook', secret: 'a-signing-secret-1234' },
      response_format: { type: 'json_schema', json_schema: { name: 'digest', schema: { type: 'object', properties: { text: { type: 'string' } } } } },
    });
    expect(created.statusCode).toBe(201);
    const body = json(created);
    expect(body).toMatchObject({
      object: 'agent.trigger', agent: AGENT_KEY, name: 'Morning digest', description: 'Weekdays', enabled: true, ...SCHEDULE,
      prompt: 'Summarise.', variables: { region: 'eu' }, version: null, class: 'deferred', metadata: { team: 'ops' },
      callback: { url: 'https://example.com/hook', signed: true }, response_format: { type: 'json_schema', json_schema: { name: 'digest' } },
      last_fire_at: null, last_run_id: null, last_status: null, last_error: null,
    });
    expect(typeof body.next_fire_at).toBe('number');
    // Only the settings object of the trigger's own type is there.
    expect(['once', 'webhook'].some((key) => key in body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('a-signing-secret-1234');
    expect(JSON.stringify(body)).not.toContain('secretSealed');
    const stored = (await db.listAgentTriggers({ tenantId, projectId: PROJECT_ID }))[0];
    expect(stored.callback?.secretSealed).toBeTruthy();
    expect(stored.callback?.secretSealed).not.toBe('a-signing-secret-1234');
    expect(stored.createdBy).toBe('user-1');

    const list = await client('GET');
    expect(list.statusCode).toBe(200);
    expect(json<{ object: string; data: Array<{ id: string }> }>(list)).toMatchObject({ object: 'list', has_more: false, data: [{ id: body.id }] });
    const one = await client('GET', `/${String(body.id)}`);
    expect(one.statusCode).toBe(200);
    expect(json(one).id).toBe(body.id);
  });

  it('a once trigger takes run_at or delay_seconds; manual has no settings object and no next fire', async () => {
    const at = new Date(Date.now() + 3_600_000);
    const once = json(await client('POST', '', { name: 'Once', type: 'once', once: { run_at: at.toISOString() }, prompt: 'x' }));
    expect(once).toMatchObject({ type: 'once', once: { run_at: at.toISOString() } });
    expect(['schedule', 'webhook'].some((key) => key in once)).toBe(false);
    expect(once.next_fire_at).toBe(Math.floor(at.getTime() / 1000));
    const delayed = json(await client('POST', '', { name: 'Later', type: 'once', once: { delay_seconds: 600 }, prompt: 'x' }));
    expect(Math.abs(Number(delayed.next_fire_at) - (Date.now() / 1000 + 600))).toBeLessThan(5);
    const manual = json(await client('POST', '', { name: 'By hand', type: 'manual', prompt: 'x' }));
    expect(manual).toMatchObject({ type: 'manual', next_fire_at: null });
    expect(['schedule', 'once', 'webhook'].some((key) => key in manual)).toBe(false);
  });

  it('a trigger created without a type is manual', async () => {
    const created = json(await client('POST', '', { name: 'Untyped', prompt: 'x' }));
    expect(created).toMatchObject({ type: 'manual', next_fire_at: null });
    expect(json(await client('POST', '', { name: 'Nulled', type: null, prompt: 'x' }))).toMatchObject({ type: 'manual' });
  });

  it.each([
    [{ ...SCHEDULE, prompt: 'x' }, 'name'],
    [{ name: 'a', type: 'schedule', schedule: { cron: '0 0 9 * * *' }, prompt: 'x' }, 'schedule.cron'],
    [{ name: 'a', type: 'schedule', prompt: 'x' }, 'schedule.cron'],
    [{ name: 'a', type: 'schedule', schedule: { cron: '0 9 * * *', timezone: 'Mars/Olympus' }, prompt: 'x' }, 'schedule.timezone'],
    [{ name: 'a', type: 'once', once: { run_at: '2020-01-01T00:00:00Z' }, prompt: 'x' }, 'once.run_at'],
    [{ name: 'a', type: 'once', prompt: 'x' }, 'once.run_at'],
    [{ name: 'a', type: 'webhook', webhook: { preset: 'bitbucket' }, prompt: 'x' }, 'webhook.preset'],
    [{ name: 'a', type: 'bitbucket', prompt: 'x' }, 'type'],
    [{ name: 'a', type: 'schedule', schedule: 'daily', prompt: 'x' }, 'schedule'],
    [{ name: 'a', type: 'manual', schedule: { cron: '0 9 * * *' }, prompt: 'x' }, 'schedule'],
    [{ name: 'a', ...SCHEDULE, once: { delay_seconds: 60 }, prompt: 'x' }, 'once'],
    [{ name: 'a', ...SCHEDULE, prompt: '' }, 'prompt'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x'.repeat(32_001) }, 'prompt'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x', variables: { region: 'mars' } }, 'variables.region'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x', variables: { nope: 1 } }, 'variables.nope'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x', version: 9 }, 'version'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x', class: 'urgent' }, 'class'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x', metadata: { 'bad key': 'v' } }, 'metadata'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x', callback: { url: 'https://10.0.0.1/hook' } }, 'callback'],
    [{ name: 'a', ...SCHEDULE, prompt: 'x', response_format: { type: 'xml' } }, 'response_format'],
  ])('refuses %j (400 invalid_trigger on %s)', async (payload, field) => {
    const res = await client('POST', '', payload);
    expect(res.statusCode).toBe(400);
    const error = json<{ error: { type: string; code: string; errors: Array<{ field: string }> } }>(res).error;
    expect(error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_trigger' });
    expect(error.errors.map((issue) => issue.field)).toContain(field);
    expect(await db.listAgentTriggers({ tenantId, projectId: PROJECT_ID })).toEqual([]);
  });

  it('an empty prompt is fine when the trigger gives the variables the agent declares', async () => {
    const res = await client('POST', '', { name: 'Variables only', ...SCHEDULE, variables: { region: 'us', days: 7 } });
    expect(res.statusCode).toBe(201);
    expect(json(res)).toMatchObject({ prompt: '', variables: { region: 'us', days: 7 } });
  });

  it('a pinned version that exists is kept', async () => {
    const res = await client('POST', '', { name: 'Pinned', ...SCHEDULE, prompt: 'x', version: 1 });
    expect(res.statusCode).toBe(201);
    expect(json(res).version).toBe(1);
  });

  it('an agent outside the token’s project is a 404 in the client envelope', async () => {
    hoisted.auth.current = { ...(hoisted.auth.current as object), projectId: 'proj-2' };
    const res = await client('GET');
    expect(res.statusCode).toBe(404);
    expect(json<{ error: { code: string } }>(res).error.code).toBe('agent_not_found');
  });

  it('PATCH changes fields, recomputes nextFireAt on a new type or enable, and keeps the stored secret', async () => {
    const created = json(await client('POST', '', {
      name: 'Digest', ...SCHEDULE, prompt: 'x', callback: { url: 'https://example.com/hook', secret: 'a-signing-secret-1234' },
    }));
    const id = String(created.id);
    const sealed = (await db.getAgentTrigger(id, tenantId, PROJECT_ID))!.callback!.secretSealed;

    const renamed = await client('PATCH', `/${id}`, { name: 'Renamed', callback: { url: 'https://example.com/other' } });
    expect(renamed.statusCode).toBe(200);
    expect(json(renamed)).toMatchObject({ name: 'Renamed', callback: { url: 'https://example.com/other', signed: true }, next_fire_at: created.next_fire_at });
    expect((await db.getAgentTrigger(id, tenantId, PROJECT_ID))!.callback!.secretSealed).toBe(sealed);
    expect((await db.getAgentTrigger(id, tenantId, PROJECT_ID))!.updatedBy).toBe('user-1');

    const disabled = json(await client('PATCH', `/${id}`, { enabled: false }));
    expect(disabled).toMatchObject({ enabled: false, next_fire_at: null });
    const manual = json(await client('PATCH', `/${id}`, { enabled: true, type: 'manual' }));
    expect(manual).toMatchObject({ enabled: true, type: 'manual', next_fire_at: null });
    // The settings object of the type it left is gone.
    expect(manual).not.toHaveProperty('schedule');
    const again = json(await client('PATCH', `/${id}`, { type: 'schedule', schedule: { cron: '30 8 * * *', timezone: 'UTC' } }));
    expect(again).toMatchObject({ type: 'schedule', schedule: { cron: '30 8 * * *', timezone: 'UTC' } });
    expect(typeof again.next_fire_at).toBe('number');

    const unsigned = json(await client('PATCH', `/${id}`, { callback: { url: 'https://example.com/other', secret: '' } }));
    expect(unsigned.callback).toEqual({ url: 'https://example.com/other', signed: false });
    expect(json(await client('PATCH', `/${id}`, { callback: null })).callback).toBeNull();

    const bad = await client('PATCH', `/${id}`, { type: 'schedule', schedule: { cron: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(json<{ error: { errors: Array<{ field: string }> } }>(bad).error.errors.map((issue) => issue.field)).toContain('schedule.cron');
    // Settings travel with their type: a settings object alone is refused, not guessed at.
    const untyped = await client('PATCH', `/${id}`, { schedule: { cron: '0 7 * * *' } });
    expect(untyped.statusCode).toBe(400);
    expect(json<{ error: { errors: Array<{ field: string }> } }>(untyped).error.errors.map((issue) => issue.field)).toContain('type');
    expect((await client('PATCH', '/000000000000000000000000', { name: 'x' })).statusCode).toBe(404);
  });

  it('PATCH with the stored schedule sent back (a whole-form save) keeps nextFireAt; a new cron recomputes it', async () => {
    const created = json(await client('POST', '', { name: 'Digest', ...SCHEDULE, prompt: 'x' }));
    const id = String(created.id);
    const same = json(await client('PATCH', `/${id}`, { name: 'Renamed', ...SCHEDULE }));
    expect(same).toMatchObject({ name: 'Renamed', ...SCHEDULE, next_fire_at: created.next_fire_at });
    const changed = json(await client('PATCH', `/${id}`, { type: 'schedule', schedule: { cron: '*/5 * * * *', timezone: 'UTC' } }));
    expect(changed).toMatchObject({ type: 'schedule', schedule: { cron: '*/5 * * * *', timezone: 'UTC' } });
    expect(Number(changed.next_fire_at)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });

  it('PATCH with the stored once time sent back (a whole-form save) keeps its time even after it passed', async () => {
    const trigger = await db.createAgentTrigger({
      tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, name: 'Fired', enabled: true, runClass: 'default', createdBy: 'user-1', prompt: 'x',
      type: 'once', once: { runAt: new Date('2026-01-01T00:00:00Z') }, nextFireAt: null, lastFireAt: new Date('2026-01-01T00:00:00Z'),
    } as NewAgentTrigger);
    const res = await client('PATCH', `/${String(trigger._id)}`, { name: 'Fired (renamed)', type: 'once', once: { run_at: '2026-01-01T00:00:00.000Z' } });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ name: 'Fired (renamed)', next_fire_at: null });
  });

  it('DELETE removes it; a trigger of another agent is a 404', async () => {
    const id = String(json(await client('POST', '', { name: 'Gone', ...SCHEDULE, prompt: 'x' })).id);
    const other = await db.createAgentTrigger({
      tenantId, projectId: PROJECT_ID, agentKey: 'other-agent', name: 'Other', enabled: true, runClass: 'default', createdBy: 'u', prompt: 'x', type: 'manual',
    });
    expect((await client('GET', `/${String(other._id)}`)).statusCode).toBe(404);
    expect((await client('DELETE', `/${String(other._id)}`)).statusCode).toBe(404);
    const res = await client('DELETE', `/${id}`);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ id, object: 'agent.trigger.deleted', deleted: true });
    expect((await client('GET', `/${id}`)).statusCode).toBe(404);
  });

  describe('POST …/:triggerId/run (Run now)', () => {
    let id: string;
    beforeEach(async () => {
      id = String(json(await client('POST', '', { name: 'Digest', ...SCHEDULE, prompt: 'Summarise.', variables: { region: 'eu' } })).id);
    });

    it('fires the trigger (run trigger: manual) with the merged variables and metadata, and answers 202 with the run', async () => {
      hoisted.fireTrigger.mockResolvedValue({ kind: 'accepted', run: run() });
      const res = await client('POST', `/${id}/run`, { variables: { days: 3 }, metadata: { reason: 'manual' } }, { 'idempotency-key': 'k-1' });
      expect(res.statusCode).toBe(202);
      expect(res.headers.location).toBe('/api/client/v1/agents/runs/run_r1');
      expect(json(res)).toMatchObject({ id: 'run_r1', object: 'agent.run', status: 'queued' });
      const [trigger, tenant, input] = hoisted.fireTrigger.mock.calls[0];
      expect(String(trigger._id)).toBe(id);
      expect(tenant).toMatchObject({ tenantDbName: DB_NAME, tenantId });
      // Run now counts against the person and the token that pressed it.
      expect(input).toEqual({
        trigger: 'manual', message: 'Summarise.', variables: { region: 'eu', days: 3 }, metadata: { reason: 'manual' }, idempotencyKey: 'k-1',
        principal: { userId: 'user-1', apiTokenId: 'tok-1' },
      });
      expect(hoisted.waitForAgentRun).not.toHaveBeenCalled();
    });

    it('wait (or Prefer: wait=N) holds until the run finished: 200 with the run', async () => {
      hoisted.fireTrigger.mockResolvedValue({ kind: 'accepted', run: run() });
      hoisted.waitForAgentRun.mockResolvedValue(run({ status: 'succeeded', result: { output_text: 'done' }, completedAt: new Date() }));
      const res = await client('POST', `/${id}/run`, undefined, { prefer: 'wait=10' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['preference-applied']).toBe('wait=10');
      expect(json(res)).toMatchObject({ id: 'run_r1', status: 'succeeded' });
      expect(hoisted.waitForAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }), 10_000, expect.any(AbortSignal));
    });

    it('a reserved Idempotency-Key is refused before anything fires', async () => {
      const res = await client('POST', `/${id}/run`, {}, { 'idempotency-key': 'trigger:client-chosen' });
      expect(res.statusCode).toBe(400);
      expect(json<{ error: { code: string } }>(res).error.code).toBe('idempotency_key_reserved');
      expect(hoisted.fireTrigger).not.toHaveBeenCalled();
    });

    it('variables that no longer match the agent are a 400 invalid_variables', async () => {
      const res = await client('POST', `/${id}/run`, { variables: { region: 'mars' } });
      expect(res.statusCode).toBe(400);
      expect(json<{ error: { code: string; errors: unknown[] } }>(res).error).toMatchObject({ code: 'invalid_variables', errors: [expect.objectContaining({ field: 'region' })] });
      expect(hoisted.fireTrigger).not.toHaveBeenCalled();
    });

    it.each([
      [{ kind: 'concurrency_limit', reason: 'agent run limit reached', retryAfterSeconds: 30 }, 429, 'agent_run_concurrency_limit', '30'],
      [{ kind: 'spend_limit', reason: 'spend limit reached', retryAfterSeconds: 3600 }, 429, 'spend_limit_exceeded', '3600'],
      [{ kind: 'quota_exceeded', reason: 'quota exceeded', retryAfterSeconds: 60 }, 429, 'agent_quota_exceeded', '60'],
      [{ kind: 'failed', reason: 'agent is not active' }, 400, 'agent_inactive', undefined],
      [{ kind: 'failed', reason: 'idempotency key in use' }, 409, undefined, undefined],
      [{ kind: 'duplicate' }, 409, undefined, undefined],
      [{ kind: 'failed', reason: 'internal error' }, 500, 'internal_error', undefined],
    ])('a fire that is %j answers %i', async (outcome, status, code, retryAfter) => {
      hoisted.fireTrigger.mockResolvedValue(outcome);
      const res = await client('POST', `/${id}/run`, {});
      expect(res.statusCode).toBe(status);
      if (code) expect(json<{ error: { code: string } }>(res).error.code).toBe(code);
      expect(res.headers['retry-after']).toBe(retryAfter);
    });

    it('a duplicate that names its run answers with that run', async () => {
      hoisted.fireTrigger.mockResolvedValue({ kind: 'duplicate', run: run({ status: 'succeeded', completedAt: new Date() }) });
      const res = await client('POST', `/${id}/run`, {});
      expect(res.statusCode).toBe(200);
      expect(json(res)).toMatchObject({ id: 'run_r1', status: 'succeeded' });
    });
  });
});

describe('dashboard: /agents/:agentId/triggers', () => {
  it('GET, POST, PATCH, DELETE and POST …/run work the same way, as the signed-in user', async () => {
    const created = await dashboard('POST', '', { name: 'Studio trigger', ...SCHEDULE, prompt: 'x' });
    expect(created.statusCode).toBe(201);
    const id = String(json(created).id);
    expect((await db.getAgentTrigger(id, tenantId, PROJECT_ID))!.createdBy).toBe('user-2');

    expect(json<{ data: unknown[] }>(await dashboard('GET')).data).toHaveLength(1);
    expect(json(await dashboard('GET', `/${id}`)).name).toBe('Studio trigger');
    expect(json(await dashboard('PATCH', `/${id}`, { enabled: false })).enabled).toBe(false);

    hoisted.fireTrigger.mockResolvedValue({ kind: 'accepted', run: run() });
    const fired = await dashboard('POST', `/${id}/run`);
    expect(fired.statusCode).toBe(202);
    // The dashboard takes no Idempotency-Key.
    expect(hoisted.fireTrigger.mock.calls[0][2]).not.toHaveProperty('idempotencyKey');

    expect((await dashboard('DELETE', `/${id}`)).statusCode).toBe(200);
    expect(json<{ data: unknown[] }>(await dashboard('GET')).data).toHaveLength(0);
  });

  it('an agent outside the session’s project is a 404', async () => {
    hoisted.session.current = { ...(hoisted.session.current as object), projectId: 'proj-2' };
    const res = await dashboard('GET');
    expect(res.statusCode).toBe(404);
  });
});

describe('webhook trigger (SPEC-webhooks W6)', () => {
  /** The `webhook` settings object of a request. */
  const WEBHOOK = {
    preset: 'github', events: ['pull_request'],
    filter: [{ path: 'payload.action', op: 'in', value: ['opened', 'synchronize'] }],
  };
  const STANDARD = `whsec_${Buffer.alloc(32, 3).toString('base64')}`;
  type WebhookAnswer = { id: string; type: string; webhook: Record<string, unknown> & { url: string; secret?: string } };
  const create = async (webhook: Record<string, unknown> = WEBHOOK, extra: Record<string, unknown> = {}) => {
    const res = await client('POST', '', { name: 'PR review', type: 'webhook', webhook, prompt: 'Review PR {{payload.number}}.', variables: { days: '{{payload.number}}' }, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return json<WebhookAnswer>(res);
  };

  it('create answers with the URL and the generated secret once (webhook.secret); reads show only its hint', async () => {
    const created = await create();
    const secret = created.webhook.secret!;
    expect(created.type).toBe('webhook');
    expect(secret).toMatch(/^whsec_/);
    expect(created.webhook.url).toMatch(new RegExp(`/api/public/hooks/${tenantId}/wh_[A-Za-z0-9_-]{24}$`));
    expect(created.webhook).toEqual({
      url: created.webhook.url, preset: 'github', auth: 'github_signature', header_name: null,
      secret, secret_hint: secret.slice(-4), secret_source: 'generated', previous_secret_valid_until: null,
      events: ['pull_request'], filter: WEBHOOK.filter, include_payload: true,
    });
    expect(['schedule', 'once'].some((key) => key in created)).toBe(false);
    const read = await client('GET', `/${created.id}`);
    expect(read.body).not.toContain(secret);
    expect(read.body).not.toMatch(/secretSealed|secret_sealed/);
    expect(json<WebhookAnswer>(read).webhook).toMatchObject({ url: created.webhook.url, secret_hint: secret.slice(-4) });
    expect(json<WebhookAnswer>(read).webhook).not.toHaveProperty('secret');
    expect(json<{ next_fire_at: unknown }>(read).next_fire_at).toBeNull();
  });

  it('refuses a prompt template, filter or mapping the rules do not allow', async () => {
    for (const [body, field] of [
      [{ prompt: 'Hi {{{payload.title}}}' }, 'prompt'],
      [{ prompt: '{{> partial}}' }, 'prompt'],
      [{ prompt: '{{payload.labels.*.name}}' }, 'prompt'],
      [{ webhook: { ...WEBHOOK, filter: [{ path: 'payload.constructor', op: 'exists' }] } }, 'webhook.filter[0].path'],
      [{ webhook: { ...WEBHOOK, preset: 'gitlab', auth: 'standard_webhooks' } }, 'webhook.secret'],
      [{ webhook: { ...WEBHOOK, auth: 'bearer' } }, 'webhook.auth'],
      [{ variables: { days: '{{secret.x}}' } }, 'variables.days'],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await client('POST', '', { name: 'Bad', type: 'webhook', webhook: WEBHOOK, prompt: 'ok', variables: { days: '{{payload.number}}' }, ...body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(json<{ error: { code: string; errors: Array<{ field: string }> } }>(res).error).toMatchObject({ code: 'invalid_trigger', errors: [expect.objectContaining({ field })] });
    }
  });

  it('PATCH keeps the hook id and secret; to Standard Webhooks needs the sender’s secret; away from it generates one', async () => {
    const created = await create({ preset: 'gitlab' });
    const url = created.webhook.url;
    const kept = await client('PATCH', `/${created.id}`, { type: 'webhook', webhook: { preset: 'gitlab', events: ['merge_request'] } });
    expect(json<WebhookAnswer>(kept).webhook).toMatchObject({ url, events: ['merge_request'] });
    expect(json<WebhookAnswer>(kept).webhook).not.toHaveProperty('secret');

    const missing = await client('PATCH', `/${created.id}`, { type: 'webhook', webhook: { auth: 'standard_webhooks' } });
    expect(missing.statusCode).toBe(400);
    const signing = await client('PATCH', `/${created.id}`, { type: 'webhook', webhook: { auth: 'standard_webhooks', secret: STANDARD } });
    expect(signing.statusCode).toBe(200);
    expect(json<WebhookAnswer>(signing).webhook).toMatchObject({ url, auth: 'standard_webhooks', secret_source: 'provided' });
    expect(signing.body).not.toContain(STANDARD);
    expect(json<WebhookAnswer>(signing).webhook).not.toHaveProperty('secret');

    const back = await client('PATCH', `/${created.id}`, { type: 'webhook', webhook: { auth: 'gitlab_token' } });
    expect(json<WebhookAnswer>(back).webhook).toMatchObject({ url, secret: expect.stringMatching(/^whsec_/) });
  });

  it('the type alone, or no type at all, leaves the webhook as it is; settings without their type are refused', async () => {
    const created = await create();
    const renamed = await client('PATCH', `/${created.id}`, { name: 'Renamed' });
    expect(json<WebhookAnswer>(renamed).webhook).toMatchObject({ url: created.webhook.url, events: ['pull_request'] });
    const same = await client('PATCH', `/${created.id}`, { type: 'webhook', name: 'Renamed again' });
    expect(same.statusCode, same.body).toBe(200);
    expect(json<WebhookAnswer>(same).webhook).toMatchObject({ url: created.webhook.url, events: ['pull_request'] });
    expect(json<WebhookAnswer>(same).webhook).not.toHaveProperty('secret');
    const untyped = await client('PATCH', `/${created.id}`, { webhook: { events: ['push'] } });
    expect(untyped.statusCode).toBe(400);
    expect(json<{ error: { errors: Array<{ field: string }> } }>(untyped).error.errors.map((issue) => issue.field)).toContain('type');
    const foreign = await client('PATCH', `/${created.id}`, { type: 'webhook', schedule: { cron: '0 9 * * *' } });
    expect(foreign.statusCode).toBe(400);
    expect(json<{ error: { errors: Array<{ field: string }> } }>(foreign).error.errors.map((issue) => issue.field)).toContain('schedule');
  });

  it('switching to another type drops the hook id and the webhook object', async () => {
    const created = await create();
    const switched = await client('PATCH', `/${created.id}`, { type: 'manual', prompt: 'Plain prompt.', variables: null });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(json(switched)).toMatchObject({ type: 'manual' });
    expect(json(switched)).not.toHaveProperty('webhook');
    const hookId = created.webhook.url.split('/').pop()!;
    expect(await db.findAgentTriggerByHookId(hookId)).toBeNull();
  });

  it('rotate-secret answers the new secret and the end of the grace', async () => {
    const created = await create({ preset: 'generic' });
    const before = Math.floor(Date.now() / 1000);
    const res = await client('POST', `/${created.id}/webhook/rotate-secret`, { grace_seconds: 3600 });
    expect(res.statusCode).toBe(200);
    const body = json<{ object: string; secret: string; secret_hint: string; previous_valid_until: number }>(res);
    expect(body).toMatchObject({ object: 'agent.trigger.webhook_secret', secret: expect.stringMatching(/^whsec_/) });
    expect(body.secret).not.toBe(created.webhook.secret);
    expect(body.secret_hint).toBe(body.secret.slice(-4));
    expect(body.previous_valid_until).toBeGreaterThanOrEqual(before + 3600);
    expect(json<{ webhook: { previous_secret_valid_until: number } }>(await client('GET', `/${created.id}`)).webhook.previous_secret_valid_until).toBe(body.previous_valid_until);
    expect((await client('POST', `/${created.id}/webhook/rotate-secret`, { grace_seconds: 90_000 })).statusCode).toBe(400);
    const instant = json<{ previous_valid_until: unknown }>(await dashboard('POST', `/${created.id}/webhook/rotate-secret`, {}));
    expect(instant.previous_valid_until).toBeNull();

    const plain = json<{ id: string }>(await client('POST', '', { name: 'Plain', ...SCHEDULE, prompt: 'x' }));
    const refused = await client('POST', `/${plain.id}/webhook/rotate-secret`, {});
    expect(json<{ error: { code: string } }>(refused).error.code).toBe('trigger_not_webhook');
  });

  it('Run now with a sample payload builds the delivery’s turn (trigger manual, external content); dry_run creates nothing', async () => {
    const created = await create(WEBHOOK, { metadata: { team: 'platform' } });
    const payload = { action: 'opened', number: 7 };
    const dry = await client('POST', `/${created.id}/run`, { payload, headers: { 'X-GitHub-Event': 'pull_request', 'X-GitHub-Delivery': 'd-9' }, dry_run: true });
    expect(dry.statusCode).toBe(200);
    expect(json(dry)).toMatchObject({
      object: 'agent.trigger.dry_run', matched: true, reason: null, event: 'pull_request', delivery_id: 'd-9',
      variables: { days: 7 }, errors: [],
    });
    expect(json<{ prompt: string }>(dry).prompt).toContain('Review PR 7.');
    const missed = json(await client('POST', `/${created.id}/run`, { payload: { action: 'closed' }, headers: { 'x-github-event': 'pull_request' }, dry_run: true }));
    expect(missed).toMatchObject({ matched: false, reason: 'rule 1 (payload.action in) did not match (value: string, 6 chars)' });
    expect(hoisted.fireTrigger).not.toHaveBeenCalled();

    hoisted.fireTrigger.mockResolvedValue({ kind: 'accepted', run: run() });
    // Run now does not apply the events / filter: a closed PR still runs.
    const fired = await client('POST', `/${created.id}/run`, { payload: { action: 'closed', number: 8 }, headers: { 'x-github-event': 'pull_request' } });
    expect(fired.statusCode).toBe(202);
    const input = hoisted.fireTrigger.mock.calls[0][2];
    expect(input).toMatchObject({
      trigger: 'manual', externalContent: true, variables: { days: 8 }, literalVariables: [], metadata: { webhook_event: 'pull_request' },
    });
    expect(input.message).toMatch(/^This run was started by an incoming webhook \(github · pull_request\)\./);
    expect(input.message).toContain('Webhook event (JSON):');

    const plain = json<{ id: string }>(await client('POST', '', { name: 'Plain', ...SCHEDULE, prompt: 'x' }));
    const refused = await client('POST', `/${plain.id}/run`, { payload });
    expect(refused.statusCode).toBe(400);
  });

  it('Run now with a sample payload names the variables that are not event content (they fill the system prompt); the event\'s own stay in the message', async () => {
    const created = await create(WEBHOOK, { variables: { days: '{{payload.number}}', region: 'eu' } });
    const sample = { payload: { action: 'opened', number: 9 }, headers: { 'x-github-event': 'pull_request' } };
    hoisted.fireTrigger.mockResolvedValue({ kind: 'accepted', run: run() });

    // `region` is written in the trigger; `days` comes out of the event.
    await client('POST', `/${created.id}/run`, sample);
    expect(hoisted.fireTrigger.mock.calls[0][2]).toMatchObject({ externalContent: true, variables: { days: 9, region: 'eu' }, literalVariables: ['region'] });

    // A value the person pressing Run now types is theirs, not the event's.
    await client('POST', `/${created.id}/run`, { ...sample, variables: { days: 3 } });
    const overridden = hoisted.fireTrigger.mock.calls[1][2];
    expect(overridden).toMatchObject({ variables: { days: 3, region: 'eu' } });
    expect([...overridden.literalVariables].sort()).toEqual(['days', 'region']);

    // Without a payload this is a plain run of the trigger: no external content, nothing to separate.
    await client('POST', `/${created.id}/run`, {});
    const plain = hoisted.fireTrigger.mock.calls[2][2];
    expect(plain).not.toHaveProperty('externalContent');
    expect(plain).not.toHaveProperty('literalVariables');
  });

  it('lists the delivery log newest first with a cursor', async () => {
    const created = await create();
    for (let i = 0; i < 3; i += 1) {
      await db.recordAgentTriggerDelivery({
        tenantId, projectId: PROJECT_ID, triggerId: created.id, receivedAt: new Date(Date.UTC(2026, 9, 18, 10, i)),
        expiresAt: new Date(Date.UTC(2026, 9, 25)), outcome: i === 2 ? 'accepted' : 'filtered', httpStatus: i === 2 ? 202 : 200,
        event: 'pull_request', deliveryId: `d-${i}`, runId: i === 2 ? 'abc' : null, reason: null, bytes: 10,
      });
    }
    const page = json<{ object: string; data: Array<Record<string, unknown>>; has_more: boolean }>(await client('GET', `/${created.id}/deliveries?limit=2`));
    expect(page).toMatchObject({ object: 'list', has_more: true });
    expect(page.data[0]).toEqual({
      id: expect.any(String), object: 'agent.trigger.delivery', received_at: Math.floor(Date.UTC(2026, 9, 18, 10, 2) / 1000),
      outcome: 'accepted', http_status: 202, event: 'pull_request', delivery_id: 'd-2', run_id: 'run_abc', reason: null, bytes: 10,
    });
    const rest = json<{ data: Array<{ delivery_id: string }>; has_more: boolean }>(await dashboard('GET', `/${created.id}/deliveries?before=${String(page.data[1].id)}`));
    expect(rest.data.map((row) => row.delivery_id)).toEqual(['d-0']);
    expect(rest.has_more).toBe(false);
    expect((await client('GET', `/${created.id}/deliveries?limit=500`)).statusCode).toBe(400);

    // Deleting the trigger removes its log.
    await client('DELETE', `/${created.id}`);
    expect(await db.listAgentTriggerDeliveries({ tenantId, projectId: PROJECT_ID, triggerId: created.id, limit: 10 })).toHaveLength(0);
  });
});
