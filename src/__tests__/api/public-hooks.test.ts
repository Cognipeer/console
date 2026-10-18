/**
 * Incoming trigger webhooks — `POST /api/public/hooks/:tenantId/:hookId` over
 * the real Fastify plugin, a REAL SQLite store and the real run engine (only
 * the queue and the catalog publisher are faked): the URL lookup and its
 * per-node negative cache, the body limit and media type, each preset's auth
 * (GitHub, GitLab, Azure DevOps, generic), ping / test / disabled / filtered
 * answers, the accepted run and its flags, de-duplication with the attempt
 * chain, the response policy per preset, the run rate, the abuse ceiling,
 * rotation grace and the delivery log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  publish: vi.fn(),
  publishWebhook: vi.fn(),
  db: { current: null as unknown },
}));

vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhook }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { AgentTriggerWebhook, IAgentTrigger } from '@/lib/database';
import { reloadConfig } from '@/lib/core/config';
import { createAgentTrigger, resetTriggerEventThrottle, updateAgentTrigger, type TriggerFields } from '@/lib/services/agents/agentTriggers';
import { composeUserMessageWithVariables } from '@/lib/services/agents/agentVariables';
import { resetDeliveryRecording } from '@/lib/services/agents/agentTriggerWebhookDelivery';
import { parseWebhookWrite, rotateWebhookSecret } from '@/lib/services/agents/agentTriggerWebhookIntake';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { publicHooksApiPlugin, resetPublicHookCaches } from '@/server/api/plugins/public-hooks';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const DB_NAME = 'tenant_public_hooks';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'pr-reviewer';
const STANDARD = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const scope = () => ({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID });
const json = <T = Record<string, unknown>>(res: { body: string }) => parseJsonBody<T>(res.body);
const runsOf = (triggerId: string) => db.listAgentRuns({ tenantId, projectId: PROJECT_ID, triggerId, excludeModes: ['sync'] });
const deliveriesOf = (triggerId: string) => db.listAgentTriggerDeliveries({ tenantId, projectId: PROJECT_ID, triggerId, limit: 100 });
const hmacHex = (secret: string, content: string) => createHmac('sha256', secret).update(content).digest('hex');

/** A webhook trigger from the `webhook` settings a request would carry. */
async function webhookTrigger(settings: Record<string, unknown>, write: TriggerFields = {}) {
  const parsed = parseWebhookWrite(settings, null);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const trigger = await createAgentTrigger(scope(), AGENT_KEY, {
    name: 'PR review', type: 'webhook', webhook: parsed.webhook, prompt: 'Review PR {{payload.number}} ({{payload.action}}).', ...write,
  }, 'user-1');
  return { trigger, secret: parsed.secret ?? STANDARD, webhook: parsed.webhook };
}

/** The `webhook` settings of a trigger the test made as a webhook one. */
function webhookOf(trigger: IAgentTrigger): AgentTriggerWebhook {
  if (trigger.type !== 'webhook') throw new Error('not a webhook trigger');
  return trigger.webhook;
}

const hookUrl = (trigger: IAgentTrigger) => `/api/public/hooks/${tenantId}/${webhookOf(trigger).hookId}`;

function post(url: string, body: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json', ...headers }, payload: body });
}

function github(trigger: IAgentTrigger, secret: string, payload: unknown, event = 'pull_request', delivery = 'd-1', extra: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return post(hookUrl(trigger), body, {
    'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${hmacHex(secret, body)}`, ...extra,
  });
}

const PR = { action: 'opened', number: 42, pull_request: { draft: false, author_association: 'MEMBER' } };

async function buildApp() {
  app = await createFastifyApiTestApp(publicHooksApiPlugin);
}

const savedProvider = process.env.DB_PROVIDER;

beforeEach(async () => {
  vi.clearAllMocks();
  // The store here is SQLite (its tenant ids are UUIDs, not ObjectIds).
  process.env.DB_PROVIDER = 'sqlite';
  reloadConfig();
  resetTriggerEventThrottle();
  resetPublicHookCaches();
  resetDeliveryRecording();
  resetRateLimitStore();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'public-hooks-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const created = await db.createTenant({ companyName: 'Acme', slug: 'acme-hooks', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(created._id);
  await db.switchToTenant(DB_NAME);
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'PR reviewer', status: 'active', createdBy: 'user-1',
    config: { modelKey: 'gpt-4o', variables: [{ name: 'pr', type: 'integer', required: true }, { name: 'title', type: 'string' }] },
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.publishWebhook.mockResolvedValue(undefined);
  await buildApp();
});

afterEach(async () => {
  await app.close();
  delete process.env.AGENT_WEBHOOK_BODY_LIMIT_BYTES;
  delete process.env.AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE;
  process.env.DB_PROVIDER = savedProvider;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/public/hooks/:tenantId/:hookId — lookup', () => {
  it('answers 404 for a malformed or unknown URL and remembers the miss', async () => {
    expect((await post(`/api/public/hooks/${tenantId}/short`, '{}')).statusCode).toBe(404);
    expect((await post('/api/public/hooks/bad.tenant/wh_abcdefghijklmnopqrstuvwx', '{}')).statusCode).toBe(404);
    const lookup = vi.spyOn(db, 'findAgentTriggerByHookId');
    const unknown = `/api/public/hooks/${tenantId}/wh_abcdefghijklmnopqrstuvwx`;
    const first = await post(unknown, '{}');
    expect(first.statusCode).toBe(404);
    expect(json(first)).toEqual({ error: { type: 'not_found_error', message: 'Unknown webhook.', code: 'webhook_not_found' } });
    expect((await post(unknown, '{}')).statusCode).toBe(404);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('on the MongoDB provider, a tenant id that is not an ObjectId is 404 without a lookup', async () => {
    process.env.DB_PROVIDER = 'mongodb';
    reloadConfig();
    const lookup = vi.spyOn(db, 'findTenantById');
    expect((await post(`/api/public/hooks/${tenantId}/wh_abcdefghijklmnopqrstuvwx`, '{}')).statusCode).toBe(404);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('answers 503 (Retry-After) when a lookup fails, and does not remember it', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'github' }, { variables: { pr: '{{payload.number}}' } });
    vi.spyOn(db, 'findTenantById').mockRejectedValueOnce(new Error('db down'));
    const failed = await github(trigger, secret, PR);
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['retry-after']).toBe('30');
    expect(json(failed)).toMatchObject({ error: { code: 'webhook_unavailable' } });
    vi.spyOn(db, 'findAgentTriggerByHookId').mockRejectedValueOnce(new Error('db down'));
    expect((await github(trigger, secret, PR)).statusCode).toBe(503);
    expect((await github(trigger, secret, PR)).statusCode).toBe(202);
  });

  it('answers 404 once the trigger is switched to another type or deleted', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'github' });
    await updateAgentTrigger(scope(), trigger, { type: 'manual' }, 'user-1');
    expect((await github(trigger, secret, PR)).statusCode).toBe(404);
  });
});

describe('body handling', () => {
  it('answers 415 for a form body, in the error envelope', async () => {
    const { trigger } = await webhookTrigger({ preset: 'github' });
    const res = await app.inject({ method: 'POST', url: hookUrl(trigger), headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'payload=%7B%7D' });
    expect(res.statusCode).toBe(415);
    expect(json(res)).toEqual({ error: { type: 'invalid_request_error', message: 'Send application/json. GitHub: set Content type to application/json.', code: 'unsupported_media_type' } });
  });

  it('answers 413 past AGENT_WEBHOOK_BODY_LIMIT_BYTES', async () => {
    process.env.AGENT_WEBHOOK_BODY_LIMIT_BYTES = '16384';
    reloadConfig();
    await app.close();
    await buildApp();
    const { trigger, secret } = await webhookTrigger({ preset: 'github' });
    const res = await github(trigger, secret, { ...PR, padding: 'x'.repeat(20_000) });
    expect(res.statusCode).toBe(413);
    expect(json(res)).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('a header mode is refused (401) before the body is read', async () => {
    process.env.AGENT_WEBHOOK_BODY_LIMIT_BYTES = '16384';
    reloadConfig();
    await app.close();
    await buildApp();
    const { trigger } = await webhookTrigger({ preset: 'generic' });
    const res = await post(hookUrl(trigger), JSON.stringify({ padding: 'x'.repeat(20_000) }), { authorization: 'Bearer wrong' });
    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual({ error: { type: 'authentication_error', message: 'The request is not authenticated for this webhook.', code: 'webhook_unauthorized' } });
    const [row] = await deliveriesOf(String(trigger._id));
    expect(row).toMatchObject({ outcome: 'unauthorized', httpStatus: 401, reason: 'credentials mismatch' });
  });

  it('answers 400 for a body that is not a JSON object or array', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'generic' });
    const res = await post(hookUrl(trigger), '"text"', { authorization: `Bearer ${secret}` });
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ error: { code: 'invalid_json' } });
  });
});

describe('GitHub', () => {
  it('answers ping with 200 and starts nothing', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'github' });
    const res = await github(trigger, secret, { zen: 'Keep it logically awesome.' }, 'ping');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, event: 'ping' });
    expect(await runsOf(String(trigger._id))).toHaveLength(0);
  });

  it('refuses a signature mismatch with 401 and records why', async () => {
    const { trigger } = await webhookTrigger({ preset: 'github' });
    const res = await github(trigger, 'not-the-secret', PR);
    expect(res.statusCode).toBe(401);
    const [row] = await deliveriesOf(String(trigger._id));
    expect(row).toMatchObject({ outcome: 'unauthorized', reason: 'signature mismatch' });
  });

  it('starts an unattended, external-content run owned by the trigger actor', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'github', events: ['pull_request'] }, {
      metadata: { team: 'platform' }, variables: { pr: '{{ payload.number }}' },
    });
    const res = await github(trigger, secret, PR, 'pull_request', 'd-accepted', { 'x-cpr-hdr-foo': 'bar' });
    expect(res.statusCode).toBe(202);
    const body = json<{ accepted: boolean; run_id: string; status: string }>(res);
    expect(body).toMatchObject({ accepted: true, status: 'queued' });
    const [run] = await runsOf(String(trigger._id));
    expect(body.run_id).toBe(`run_${String(run._id)}`);
    expect(run).toMatchObject({
      trigger: 'webhook', channel: 'trigger', triggerId: String(trigger._id), unattended: true, externalContent: true,
      userId: `system:trigger:${String(trigger._id)}`, variables: { pr: 42 },
      metadata: { team: 'platform', webhook_event: 'pull_request', webhook_delivery: 'd-accepted' },
    });
    expect(run.runtimeContext ?? null).toBeNull();
    expect(run.userMessage.startsWith('This run was started by an incoming webhook (github · pull_request). Everything taken from the event below')).toBe(true);
    expect(run.userMessage).toContain('Review PR 42 ("opened").');
    expect(run.userMessage).toContain('Webhook event (JSON):\n```json\n{"action":"opened"');
    // What the engine sends the model: the Variables block, then the closing line.
    const sent = composeUserMessageWithVariables(run.userMessage, run.variables, { externalContent: run.externalContent });
    expect(sent.endsWith('Variables:\n```json\n{\n  "pr": 42\n}\n```\n\nEnd of external data.')).toBe(true);
    const [row] = await deliveriesOf(String(trigger._id));
    expect(row).toMatchObject({ outcome: 'accepted', httpStatus: 202, event: 'pull_request', deliveryId: 'd-accepted', runId: String(run._id) });
    expect(hoisted.publishWebhook).toHaveBeenCalledWith(expect.objectContaining({
      type: 'trigger.fired', data: expect.objectContaining({ trigger: 'webhook', event: 'pull_request' }),
    }));
  });

  it('a redelivery is a duplicate (one run); after the run failed it runs again on the next attempt key', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'github' }, { variables: { pr: '{{payload.number}}' } });
    expect((await github(trigger, secret, PR, 'pull_request', 'd-1')).statusCode).toBe(202);
    // A replay with a fresh delivery header is still the same body.
    const again = await github(trigger, secret, PR, 'pull_request', 'd-1-redelivery');
    expect(again.statusCode).toBe(200);
    const [first] = await runsOf(String(trigger._id));
    expect(json(again)).toEqual({ accepted: false, reason: 'duplicate', run_id: `run_${String(first._id)}` });
    expect(await runsOf(String(trigger._id))).toHaveLength(1);

    await db.claimAgentRun(String(first._id), tenantId, 'worker-1', new Date());
    await db.finalizeAgentRun(String(first._id), tenantId, { status: 'failed', completedAt: new Date() });
    expect((await github(trigger, secret, PR, 'pull_request', 'd-1')).statusCode).toBe(202);
    const runs = await runsOf(String(trigger._id));
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.idempotencyKey).find((key) => key?.endsWith(':r2'))).toBeDefined();
  });

  it('answers a filtered or not selected event with 200 and records the rule that missed', async () => {
    const { trigger, secret } = await webhookTrigger({
      preset: 'github', events: ['pull_request'], filter: [{ path: 'payload.action', op: 'in', value: ['opened', 'synchronize'] }],
    });
    const notSelected = await github(trigger, secret, PR, 'push');
    expect(json(notSelected)).toEqual({ accepted: false, reason: 'event_not_selected' });
    const filtered = await github(trigger, secret, { ...PR, action: 'closed' });
    expect(filtered.statusCode).toBe(200);
    expect(json(filtered)).toEqual({ accepted: false, reason: 'filtered' });
    const rows = await deliveriesOf(String(trigger._id));
    expect(rows.map((row) => row.reason)).toEqual([
      'rule 1 (payload.action in) did not match (value: string, 6 chars)',
      'event "push" is not selected',
    ]);
    expect(await runsOf(String(trigger._id))).toHaveLength(0);
  });

  it('answers a disabled trigger with 200 accepted:false', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'github' }, { enabled: false });
    const res = await github(trigger, secret, PR);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ accepted: false, reason: 'disabled' });
  });

  it('answers a refused run with 429 (run rate)', async () => {
    process.env.AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE = '1';
    reloadConfig();
    const { trigger, secret } = await webhookTrigger({ preset: 'github' }, { variables: { pr: '{{payload.number}}' } });
    expect((await github(trigger, secret, PR)).statusCode).toBe(202);
    const limited = await github(trigger, secret, { ...PR, number: 43 });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(json(limited)).toMatchObject({ error: { type: 'rate_limit_error', code: 'webhook_rate_limited' } });
  });

  it('answers invalid variables with 400', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'github' }, { variables: { pr: '{{payload.missing}}' } });
    const res = await github(trigger, secret, PR);
    expect(res.statusCode).toBe(400);
    expect(json(res)).toMatchObject({ error: { type: 'invalid_request_error', code: 'invalid_variables' } });
    const [row] = await deliveriesOf(String(trigger._id));
    expect(row).toMatchObject({ outcome: 'failed', reason: 'invalid variables: pr: Required' });
  });
});

describe('GitLab', () => {
  it('a secret token starts a run; a run refused by the rate limit is answered 200 (GitLab disables failing hooks)', async () => {
    process.env.AGENT_WEBHOOK_RATE_LIMIT_PER_MINUTE = '1';
    reloadConfig();
    const { trigger, secret } = await webhookTrigger({ preset: 'gitlab' }, { variables: { pr: '{{payload.object_attributes.iid}}' } });
    const send = (iid: number) => post(hookUrl(trigger), JSON.stringify({ object_kind: 'merge_request', object_attributes: { iid, action: 'open' } }), {
      'x-gitlab-token': secret, 'x-gitlab-event': 'Merge Request Hook', 'idempotency-key': `key-${iid}`,
    });
    expect((await send(1)).statusCode).toBe(202);
    const limited = await send(2);
    expect(limited.statusCode).toBe(200);
    expect(json(limited)).toMatchObject({ accepted: false, reason: 'rate_limited' });
    const [run] = await runsOf(String(trigger._id));
    expect(run.metadata).toMatchObject({ webhook_event: 'merge_request', webhook_delivery: 'key-1' });
    expect((await post(hookUrl(trigger), '{}', { 'x-gitlab-token': 'wrong' })).statusCode).toBe(401);
  });

  it('a Standard Webhooks signing token (sender’s secret) is checked over the body', async () => {
    const { trigger } = await webhookTrigger({ preset: 'gitlab', auth: 'standard_webhooks', secret: STANDARD }, { variables: { pr: '{{payload.object_attributes.iid}}' } });
    const body = JSON.stringify({ object_kind: 'merge_request', object_attributes: { iid: 5 } });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', Buffer.alloc(32, 9)).update(`msg_1.${ts}.${body}`).digest('base64');
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${signature}` };
    expect((await post(hookUrl(trigger), body, headers)).statusCode).toBe(202);
    expect(json(await post(hookUrl(trigger), body, headers))).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect((await post(hookUrl(trigger), body, { ...headers, 'webhook-signature': 'v1,bm9wZQ==' })).statusCode).toBe(401);
  });

  it('invalid variables are answered 200 accepted:false', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'gitlab' }, { variables: { pr: '{{payload.nope}}' } });
    const res = await post(hookUrl(trigger), JSON.stringify({ object_kind: 'push' }), { 'x-gitlab-token': secret });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ accepted: false, reason: 'invalid_variables', message: 'invalid variables: pr: Required' });
  });
});

describe('Azure DevOps', () => {
  const sample = {
    subscriptionId: '00000000-0000-0000-0000-000000000000',
    notificationId: 1,
    id: '2ab4e3d3-b7a6-425e-92b1-5a9982c1269e',
    eventType: 'git.pullrequest.created',
    resource: { pullRequestId: 1, status: 'active', targetRefName: 'refs/heads/main' },
  };

  it('answers the test notification with 200 and starts nothing', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'azure_devops' });
    const res = await post(hookUrl(trigger), JSON.stringify(sample), { authorization: `Basic ${Buffer.from(`any:${secret}`).toString('base64')}` });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true, event: 'test' });
  });

  it('Basic auth (any user, password = secret) starts a run, de-duplicated by the event id', async () => {
    const { trigger, secret } = await webhookTrigger({
      preset: 'azure_devops', filter: [{ path: 'payload.resource.targetRefName', op: 'eq', value: 'refs/heads/main' }],
    }, { variables: { pr: '{{payload.resource.pullRequestId}}' } });
    const event = { ...sample, subscriptionId: '11111111-2222-3333-4444-555555555555', notificationId: 7 };
    const auth = { authorization: `Basic ${Buffer.from(`ado:${secret}`).toString('base64')}` };
    expect((await post(hookUrl(trigger), JSON.stringify(event), auth)).statusCode).toBe(202);
    // A retry re-sends the event with the same id (other fields may differ).
    const retry = await post(hookUrl(trigger), JSON.stringify({ ...event, notificationId: 8 }), auth);
    expect(json(retry)).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect((await post(hookUrl(trigger), JSON.stringify(event), { authorization: `Basic ${Buffer.from('ado:wrong').toString('base64')}` })).statusCode).toBe(401);
  });

  it('the header option checks the configured header', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'azure_devops', auth: 'header', header_name: 'x-ado-secret' }, { variables: { pr: '{{payload.resource.pullRequestId}}' } });
    const event = { ...sample, notificationId: 9, subscriptionId: '11111111-2222-3333-4444-555555555555' };
    expect((await post(hookUrl(trigger), JSON.stringify(event), { 'x-ado-secret': secret })).statusCode).toBe(202);
  });
});

describe('generic', () => {
  it('bearer without a delivery id: the same body twice starts two runs', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'generic' }, { prompt: 'Handle {{event}}.', variables: { pr: '{{payload.n}}' } });
    const body = JSON.stringify({ event: 'deploy.finished', n: 1 });
    expect((await post(hookUrl(trigger), body, { authorization: `Bearer ${secret}` })).statusCode).toBe(202);
    expect((await post(hookUrl(trigger), body, { authorization: `Bearer ${secret}` })).statusCode).toBe(202);
    expect(await runsOf(String(trigger._id))).toHaveLength(2);
    // With a delivery id it is de-duplicated.
    const withId = { authorization: `Bearer ${secret}`, 'x-cognipeer-event-id': 'evt_1' };
    expect((await post(hookUrl(trigger), body, withId)).statusCode).toBe(202);
    expect(json(await post(hookUrl(trigger), body, withId))).toMatchObject({ reason: 'duplicate' });
  });

  it('the signature mode checks t and v1 over the body', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'generic', auth: 'signature' }, { variables: { pr: '{{payload.n}}' } });
    const body = JSON.stringify({ n: 3 });
    const t = Math.floor(Date.now() / 1000);
    const sign = (at: number) => ({ 'x-cognipeer-signature': `t=${at},v1=${hmacHex(secret, `${at}.${body}`)}` });
    expect((await post(hookUrl(trigger), body, sign(t))).statusCode).toBe(202);
    const old = await post(hookUrl(trigger), body, sign(t - 600));
    expect(old.statusCode).toBe(401);
    const rows = await deliveriesOf(String(trigger._id));
    expect(rows[0]).toMatchObject({ outcome: 'unauthorized', reason: 'timestamp outside the 5 minute window' });
  });

  it('the abuse ceiling counts only failed header attempts and never refuses an authenticated request', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'generic' }, { variables: { pr: '{{payload.n}}' } });
    for (let i = 0; i < 600; i += 1) await post(hookUrl(trigger), '{}', { authorization: 'Bearer wrong' });
    const over = await post(hookUrl(trigger), '{}', { authorization: 'Bearer wrong' });
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
    expect((await post(hookUrl(trigger), JSON.stringify({ n: 1 }), { authorization: `Bearer ${secret}` })).statusCode).toBe(202);
    // At most 10 non-accepted rows a minute are recorded; the accepted one always is.
    const rows = await deliveriesOf(String(trigger._id));
    expect(rows.filter((row) => row.outcome !== 'accepted')).toHaveLength(10);
    expect(rows.filter((row) => row.outcome === 'accepted')).toHaveLength(1);
  }, 60_000);
});

describe('secret rotation', () => {
  it('keeps the previous secret during the grace, and refuses it after', async () => {
    const { trigger, secret } = await webhookTrigger({ preset: 'generic' }, { variables: { pr: '{{payload.n}}' } });
    const rotated = rotateWebhookSecret(webhookOf(trigger), { graceSeconds: 3600 });
    if (!rotated.ok) throw new Error('rotate');
    const updated = (await updateAgentTrigger(scope(), trigger, { type: 'webhook', webhook: rotated.webhook }, 'user-1'))!;
    expect((await post(hookUrl(updated), JSON.stringify({ n: 1 }), { authorization: `Bearer ${secret}` })).statusCode).toBe(202);
    expect((await post(hookUrl(updated), JSON.stringify({ n: 2 }), { authorization: `Bearer ${rotated.secret}` })).statusCode).toBe(202);

    const expired = { ...rotated.webhook, previousSecretExpiresAt: new Date(Date.now() - 1000) };
    await updateAgentTrigger(scope(), updated, { type: 'webhook', webhook: expired }, 'user-1');
    expect((await post(hookUrl(updated), JSON.stringify({ n: 3 }), { authorization: `Bearer ${secret}` })).statusCode).toBe(401);

    const instant = rotateWebhookSecret(rotated.webhook, { graceSeconds: 0 });
    if (!instant.ok) throw new Error('rotate');
    await updateAgentTrigger(scope(), updated, { type: 'webhook', webhook: instant.webhook }, 'user-1');
    expect((await post(hookUrl(updated), JSON.stringify({ n: 4 }), { authorization: `Bearer ${rotated.secret}` })).statusCode).toBe(401);
    expect((await post(hookUrl(updated), JSON.stringify({ n: 5 }), { authorization: `Bearer ${instant.secret}` })).statusCode).toBe(202);
  });
});
