/**
 * What a run's SYSTEM prompt may read of its variables, end to end.
 *
 * A REAL SQLite provider, the real trigger fire, webhook delivery (over the real
 * Fastify plugin), scheduler tick and run worker, and the real agent loop driven
 * by a scripted chat model that records what it was shown. Faked at the boundary:
 * the model lookup, the queue, the audit write and the catalog publisher.
 *
 * The rule under test: content that came from outside (a webhook delivery) never
 * reaches the system prompt, whose `{{variables.*}}` read the agent's declared
 * defaults plus the values the trigger wrote itself; the event's own values reach
 * the model only in the message. The same holds for a connector event handed to
 * `dispatchTriggerEvent`. A schedule trigger and a runs-API call have no
 * outside content, so every variable fills the prompt as it always did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  publish: vi.fn(),
  getUserAuthState: vi.fn(),
  recordAuditLog: vi.fn(),
  publishWebhook: vi.fn(),
  db: { current: null as unknown },
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhook }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({ buildGatewayChatModel: hoisted.buildGatewayChatModel, isDynamicModel: () => false }));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});

import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import type { IAgentConversation, IAgentRun } from '@/lib/database';
import { reloadConfig } from '@/lib/core/config';
import { createAgentTrigger, resetTriggerEventThrottle } from '@/lib/services/agents/agentTriggers';
import { tickAgentTriggers } from '@/lib/services/agents/agentTriggerScheduler';
import { resetDeliveryRecording } from '@/lib/services/agents/agentTriggerWebhookDelivery';
import { dispatchTriggerEvent } from '@/lib/services/agents/agentTriggerEventDispatch';
import { parseWebhookWrite } from '@/lib/services/agents/agentTriggerWebhookIntake';
import { runAgentJobLocal } from '@/lib/services/agents/agentRunService';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';
import { publicHooksApiPlugin, resetPublicHookCaches } from '@/server/api/plugins/public-hooks';
import { createFastifyApiTestApp } from '../helpers/fastify-api';
import { queueAgentRun } from '../helpers/agent-runs';

const DB_NAME = 'tenant_trigger_prompt';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'serve-bot';
/** What an outside sender writes into the event; it must reach the model in the message only. */
const FROM_EVENT = 'EVENTREGION42';

type Message = { role: string; content: unknown };

/** A chat model that answers once and remembers every message list it was shown. */
class ScriptedModel {
  readonly modelName = 'scripted-model';
  seen: Message[][] = [];
  bindTools() {
    return this;
  }
  async invoke(messages: Message[]) {
    this.seen.push(messages);
    return { role: 'assistant', content: 'ok' };
  }
}

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let model: ScriptedModel;
let app: Awaited<ReturnType<typeof createFastifyApiTestApp>>;

const scope = () => ({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID });
const runsOf = (triggerId: string) => db.listAgentRuns({ tenantId, projectId: PROJECT_ID, triggerId, excludeModes: ['sync'] });
const textOf = (message: Message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
const systemText = () => model.seen.at(-1)!.filter((message) => message.role === 'system').map(textOf).join('\n');
const userText = () => model.seen.at(-1)!.filter((message) => message.role === 'user').map(textOf).join('\n');

/** Runs the queued run through the worker and checks it finished. */
async function work(run: IAgentRun) {
  await runAgentJobLocal({ runId: String(run._id), tenantId, tenantDbName: DB_NAME });
  const done = await db.getAgentRunById(String(run._id), tenantId, PROJECT_ID);
  expect(done?.status).toBe('succeeded');
  expect(model.seen).toHaveLength(1);
  return done!;
}

const savedProvider = process.env.DB_PROVIDER;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.DB_PROVIDER = 'sqlite';
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '10000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '1000';
  reloadConfig();
  resetTriggerEventThrottle();
  resetPublicHookCaches();
  resetDeliveryRecording();
  resetRateLimitStore();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-trigger-prompt-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-prompt', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Serve bot', status: 'active', createdBy: 'user-1',
    config: {
      modelKey: 'gpt-4o',
      systemPrompt: 'Serve region {{variables.region}} for {{variables.team}} in {{variables.mode}} mode.',
      variables: [
        { name: 'region', type: 'string' },
        { name: 'team', type: 'string' },
        { name: 'mode', type: 'string', default: 'careful' },
      ],
    },
  });
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {},
  });
  model = new ScriptedModel();
  hoisted.buildGatewayChatModel.mockResolvedValue(model);
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  hoisted.publishWebhook.mockResolvedValue(undefined);
  app = await createFastifyApiTestApp(publicHooksApiPlugin);
});

afterEach(async () => {
  await app.close();
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS;
  process.env.DB_PROVIDER = savedProvider;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A webhook trigger (generic preset, bearer secret) and what it takes to post to it. */
async function webhookTrigger(variables: Record<string, unknown> | null) {
  const parsed = parseWebhookWrite({ preset: 'generic' }, null);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const trigger = await createAgentTrigger(scope(), AGENT_KEY, {
    name: 'Deploy hook', type: 'webhook', webhook: parsed.webhook, prompt: 'Handle {{event}}.', ...(variables ? { variables } : {}),
  }, 'user-1');
  const hookId = trigger.type === 'webhook' ? trigger.webhook.hookId : '';
  const deliver = (payload: Record<string, unknown>) => app.inject({
    method: 'POST',
    url: `/api/public/hooks/${tenantId}/${hookId}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${parsed.secret}` },
    payload: JSON.stringify(payload),
  });
  return { trigger, deliver };
}

describe('a schedule trigger: everything it fixes is its own, so every variable fills the system prompt', () => {
  it('reads its values and the declared default, with nothing marked as outside content', async () => {
    const created = new Date('2026-10-18T05:59:00.000Z');
    const trigger = await createAgentTrigger(scope(), AGENT_KEY, {
      name: 'Nightly', type: 'schedule', schedule: { cron: '0 9 * * *', timezone: 'UTC' }, prompt: 'Report.',
      variables: { region: 'eu', team: 'platform' },
    }, 'user-1', created);
    expect(await tickAgentTriggers(new Date('2026-10-18T09:00:10.000Z'))).toMatchObject({ fired: 1 });
    const [queued] = await runsOf(String(trigger._id));
    expect(queued.externalContent ?? false).toBe(false);
    expect(queued.literalVariables ?? null).toBeNull();

    await work(queued);
    expect(systemText()).toContain('Serve region eu for platform in careful mode.');
  });
});

describe('a webhook trigger: the prompt reads what the trigger wrote, never what the event brought', () => {
  it('a mixed mapping: the fixed value and the default fill the prompt, the event\'s value stays in the message', async () => {
    const { trigger, deliver } = await webhookTrigger({ region: '{{payload.region}}', team: 'platform' });
    const res = await deliver({ event: 'deploy.finished', region: FROM_EVENT });
    expect(res.statusCode).toBe(202);

    const [queued] = await runsOf(String(trigger._id));
    expect(queued).toMatchObject({ externalContent: true, variables: { region: FROM_EVENT, team: 'platform', mode: 'careful' } });
    expect([...(queued.literalVariables ?? [])].sort()).toEqual(['mode', 'team']);

    await work(queued);
    expect(systemText()).toContain('Serve region  for platform in careful mode.');
    expect(systemText()).not.toContain(FROM_EVENT);
    // The event's own value is shown to the model, as data, inside the message.
    expect(userText()).toContain(FROM_EVENT);
    expect(userText()).toContain('End of external data.');
  });

  it('a trigger that fixes nothing: only the declared default reaches the prompt', async () => {
    const { trigger, deliver } = await webhookTrigger({ region: '{{payload.region}}', team: '{{payload.team}}', mode: '{{payload.mode}}' });
    expect((await deliver({ event: 'deploy.finished', region: FROM_EVENT, team: 'EVENTTEAM', mode: 'EVENTMODE' })).statusCode).toBe(202);

    const [queued] = await runsOf(String(trigger._id));
    expect(queued.literalVariables ?? []).toEqual([]);
    await work(queued);
    expect(systemText()).toContain('Serve region  for  in careful mode.');
    for (const value of [FROM_EVENT, 'EVENTTEAM', 'EVENTMODE']) {
      expect(systemText()).not.toContain(value);
      expect(userText()).toContain(value);
    }
  });
});

describe('a connector trigger: same rule, the event\'s values stay in the message', () => {
  it('the fixed value and the default fill the prompt; the event\'s value is data in the message', async () => {
    const trigger = await createAgentTrigger(scope(), AGENT_KEY, {
      name: 'On event', type: 'connector',
      connector: { connectorId: 'conn-1', trigger: 'pull_request', params: {}, schedule: null, events: [], filter: [], includePayload: true, subscriptionId: 'sub_1', packageId: 'cognipeer.github', kind: 'webhook', label: 'GitHub' },
      prompt: 'Handle {{event}}.', variables: { region: '{{payload.region}}', team: 'platform' },
    }, 'user-1');
    const answer = await dispatchTriggerEvent(db, trigger, { tenantId, tenantDbName: DB_NAME }, {
      source: 'connector', event: 'pull_request.opened', deliveryId: 'e1', dedupMaterial: 'e1', payload: { region: FROM_EVENT },
      headers: {}, receivedAt: new Date(),
      connector: { id: 'conn-1', key: 'gh', name: 'GitHub', packageId: 'cognipeer.github', packageName: 'GitHub', trigger: 'pull_request', triggerTitle: 'Pull request', kind: 'webhook', subscriptionId: 'sub_1' },
    });
    expect(answer.status).toBe(202);

    const [queued] = await runsOf(String(trigger._id));
    expect(queued).toMatchObject({ trigger: 'connector', externalContent: true, variables: { region: FROM_EVENT, team: 'platform', mode: 'careful' } });
    expect([...(queued.literalVariables ?? [])].sort()).toEqual(['mode', 'team']);

    await work(queued);
    expect(systemText()).toContain('Serve region  for platform in careful mode.');
    expect(systemText()).not.toContain(FROM_EVENT);
    expect(userText()).toContain(FROM_EVENT);
    expect(userText()).toContain('End of external data.');
  });
});

describe('the runs API: a caller\'s own variables are not outside content, so nothing changes', () => {
  it('every variable the call supplies fills the system prompt', async () => {
    const conversation: IAgentConversation = await db.createAgentConversation({
      tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'New conversation', messages: [], createdBy: 'user-1',
    });
    const outcome = await queueAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: String(conversation._id),
      userMessage: 'Serve.', userId: 'user-1', variables: { region: 'us', team: 'core', mode: 'fast' },
    });
    if (outcome.kind !== 'accepted') throw new Error(outcome.kind);
    expect(outcome.run.externalContent ?? false).toBe(false);
    expect(outcome.run.literalVariables ?? null).toBeNull();

    await work(outcome.run);
    expect(systemText()).toContain('Serve region us for core in fast mode.');
  });
});
