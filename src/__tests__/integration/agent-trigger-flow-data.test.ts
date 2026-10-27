/**
 * A connector (or webhook) event reaches a FlowBase agent as trigger data.
 *
 * A REAL SQLite provider, the real event dispatch and run worker, and a stand-in
 * for the enterprise Flows module registered at its seam. The run row keeps the
 * event as `triggerData`; the worker hands it to the flow's `runAgentTurn`
 * (`FlowAgentTurnInput.triggerData`), where the flow's trigger node reads it.
 * A run without an event (a schedule, the runs API) hands over none.
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
import { reloadConfig } from '@/lib/core/config';
import { createAgentTrigger, fireTrigger, resetTriggerEventThrottle } from '@/lib/services/agents/agentTriggers';
import { dispatchTriggerEvent, resetDeliveryRecording } from '@/lib/services/agents/agentTriggerEventDispatch';
import { registerFlowsHost } from '@/enterprise/flows';
import { runAgentJobLocal } from '@/lib/services/agents/agentRunService';
import { resetRateLimitStore } from '@/lib/services/auth/rateLimiter';

const DB_NAME = 'tenant_trigger_flow';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'flow-bot';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
const runAgentTurn = vi.fn();

const scope = () => ({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID });
const runsOf = (triggerId: string) => db.listAgentRuns({ tenantId, projectId: PROJECT_ID, triggerId, excludeModes: ['sync'] });

const SETTINGS = {
  connectorId: 'conn-1', trigger: 'pull_request', params: {}, schedule: null, events: [], filter: [], includePayload: true,
  subscriptionId: 'sub_1', packageId: 'cognipeer.github', kind: 'webhook' as const, label: 'GitHub',
};
const SOURCE = {
  id: 'conn-1', key: 'gh', name: 'GitHub', packageId: 'cognipeer.github', packageName: 'GitHub', trigger: 'pull_request',
  triggerTitle: 'Pull request', kind: 'webhook' as const, subscriptionId: 'sub_1',
};

const savedProvider = process.env.DB_PROVIDER;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.DB_PROVIDER = 'sqlite';
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '10000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '1000';
  reloadConfig();
  resetTriggerEventThrottle();
  resetDeliveryRecording();
  resetRateLimitStore();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-trigger-flow-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  const tenant = await db.createTenant({ companyName: 'Acme', slug: 'acme-flow-data', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1' });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Flow bot', status: 'active', createdBy: 'user-1',
    config: { kind: 'flow', modelKey: 'gpt-4o', flow: { entryFlowId: 'flow-1' } },
  });
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {},
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  hoisted.publishWebhook.mockResolvedValue(undefined);
  runAgentTurn.mockResolvedValue({ content: 'flow answered' });
  registerFlowsHost({
    runAgentTurn,
    buildToolBindings: async () => ({ tools: [], definitions: [] }),
    describeFlow: async () => null,
    wakeAgentActionWaits: async () => undefined,
  });
});

afterEach(async () => {
  registerFlowsHost(null as never);
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS;
  process.env.DB_PROVIDER = savedProvider;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('trigger data on a FlowBase agent', () => {
  it('a connector event is handed to the flow as triggerData, next to the message', async () => {
    const trigger = await createAgentTrigger(scope(), AGENT_KEY, {
      name: 'On PR', type: 'connector', connector: SETTINGS, prompt: 'PR {{payload.number}} {{event}}.',
    }, 'user-1');
    const answer = await dispatchTriggerEvent(db, trigger, { tenantId, tenantDbName: DB_NAME }, {
      source: 'connector', event: 'pull_request.opened', deliveryId: 'e1', dedupMaterial: 'e1', payload: { number: 7 }, headers: {},
      receivedAt: new Date(), connector: SOURCE,
    });
    expect(answer.status).toBe(202);
    const [queued] = await runsOf(String(trigger._id));
    expect(queued.triggerData).toMatchObject({ event: 'pull_request.opened', payload: { number: 7 } });

    await runAgentJobLocal({ runId: String(queued._id), tenantId, tenantDbName: DB_NAME });
    expect((await db.getAgentRunById(String(queued._id), tenantId, PROJECT_ID))?.status).toBe('succeeded');
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const input = runAgentTurn.mock.calls[0][0];
    expect(input).toMatchObject({
      agentKey: AGENT_KEY, unattended: true, flow: { entryFlowId: 'flow-1' },
      triggerData: { event: 'pull_request.opened', delivery_id: 'e1', payload: { number: 7 }, connector: { id: 'conn-1', trigger: 'pull_request' } },
    });
    expect(input.message).toContain('PR 7 "pull_request.opened".');
  });

  it('a run without an event hands the flow no triggerData', async () => {
    const trigger = await createAgentTrigger(scope(), AGENT_KEY, { name: 'By hand', type: 'manual', prompt: 'Go.' }, 'user-1');
    const fired = await fireTrigger(trigger, { tenantId, tenantDbName: DB_NAME }, { trigger: 'manual', message: 'Go.', variables: null });
    if (fired.kind !== 'accepted') throw new Error(fired.kind);
    await runAgentJobLocal({ runId: String(fired.run._id), tenantId, tenantDbName: DB_NAME });
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(runAgentTurn.mock.calls[0][0]).not.toHaveProperty('triggerData');
  });
});
