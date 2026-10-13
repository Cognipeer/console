/**
 * Cancelling a background run while its turn is inside a tool call.
 *
 * The cancel cannot interrupt the call (it runs on until the SDK's next
 * checkpoint), so the turn's tail — its events, the session's runtime fields, its
 * spend — is still to come after the run is "cancelled". It must land BEFORE the
 * conversation is free again; otherwise a message sent in between starts a second
 * turn that the old one then writes over.
 *
 * A REAL SQLite provider and the REAL agent-sdk loop driven by a scripted chat
 * model (every request costs exactly $0.01); the tool blocks until the test lets
 * it go. Faked at the boundary only: the model lookup, the sandbox toolbox, the
 * queue, the audit write and the webhook publisher.
 */

import { settlingModel } from '../helpers/fakeGatewayModel';
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
  sandboxTools: [] as unknown[],
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhook }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({ buildGatewayChatModel: hoisted.buildGatewayChatModel, isDynamicModel: () => false, }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
  buildAgentSandboxTools: vi.fn(async () => ({ tools: hoisted.sandboxTools, definitions: [], cleanup: async () => undefined })),
  destroyConversationSandbox: vi.fn(),
  resolveSandboxAvailability: vi.fn(),
}));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});

import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import { getDatabase } from '@/lib/database';
import type { IAgentConversation } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { executeAgentChatLocal } from '@/lib/services/agents/agentService';
import {
  createBackgroundAgentRun,
  requestAgentRunCancellation,
  reserveConversationForSyncTurn,
  runAgentJobLocal,
} from '@/lib/services/agents/agentRunService';
import { describeSessionRuntime } from '@/server/api/plugins/agent-session-events';

const DB_NAME = 'tenant_cancel_reservation';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'slow-agent';
const OWNER = 'user-1';
/** Each scripted model request: 5000 + 5000 tokens at $1 per 1M = exactly $0.01. */
const REQUEST_COST = 0.01;
const USAGE = { input_tokens: 5000, output_tokens: 5000, total_tokens: 10000 };

type Reply = Record<string, unknown>;

/** The first request asks for the slow tool; every later one answers. */
const script = (call: number): Reply => (call === 0
  ? {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sandbox_read_file', arguments: JSON.stringify({ path: '/slow' }) } }],
    usage_metadata: USAGE,
  }
  : { role: 'assistant', content: `answer ${call}`, usage_metadata: USAGE });

class ScriptedModel {
  readonly modelName = 'scripted-model';
  calls = 0;
  bindTools() { return this; }
  async invoke(): Promise<Reply> {
    return script(this.calls++);
  }
}

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let toolStarted: Promise<void>;
let releaseTool: () => void;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stored = async (id: string) => (await db.findAgentConversationById(id))!;
const logged = async (id: string) => db.listAgentSessionEvents(id);

async function newSession(withBudget = true): Promise<IAgentConversation> {
  return db.createAgentConversation({
    tenantId,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    title: 'New conversation',
    messages: [],
    metadata: { source: 'console' },
    createdBy: OWNER,
    ...(withBudget ? { budget: { maxCostUsd: 1, onReach: 'pause' as const }, spentUsd: 0 } : {}),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-cancel-reservation-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-cancel', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Slow', config: { modelKey: 'gpt-4o' }, status: 'active', createdBy: OWNER,
  });
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {},
    pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1, currency: 'USD' },
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.publishWebhook.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '20000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '1000';
  reloadConfig();

  const model = new ScriptedModel();
  hoisted.buildGatewayChatModel.mockImplementation(async (input: Parameters<typeof settlingModel>[0]) => settlingModel(input, model));
  // The tool holds the turn until the test releases it.
  let markStarted: () => void;
  toolStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseTool = resolve; });
  hoisted.sandboxTools = [createTool({
    name: 'sandbox_read_file',
    description: 'Read a file',
    schema: z.object({ path: z.string() }),
    func: async () => {
      markStarted();
      await gate;
      return { content: 'file text' };
    },
  })];
});

afterEach(async () => {
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('cancelling a background run that is inside a tool call', () => {
  it('keeps the conversation reserved until the cancelled turn has settled; nothing it writes lands on a newer turn, and no spend is lost', async () => {
    const id = String((await newSession())._id);
    const created = await createBackgroundAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'first', userId: OWNER,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const runId = String(created.run._id);
    const job = runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    await toolStarted;

    // Mid-run, the session's last_event_seq is the newest event in the log — not the row's stale stamp.
    await delay(400); // the batch with the tool call is flushed
    const midRun = await logged(id);
    expect(midRun.map((e) => e.type)).toEqual(['user.message', 'session.status_running', 'agent.tool_use']);
    expect((await stored(id)).lastEventSeq ?? 0).toBe(0);
    expect((await describeSessionRuntime(DB_NAME, await stored(id))).lastEventSeq).toBe(midRun.at(-1)!.seq);

    // Cancel. The worker sees it on its next poll; the tool call is still in flight.
    expect((await requestAgentRunCancellation(DB_NAME, tenantId, PROJECT_ID, runId)).kind).toBe('accepted');
    await delay(1400);

    // The run is not "cancelled" while its turn is still running: it keeps the conversation.
    const waiting = (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;
    expect(waiting.status).toBe('running');
    expect(waiting.cancelRequestedAt).toBeTruthy();
    // A new message meanwhile gets the usual conflict — a background run and a synchronous turn alike.
    expect((await createBackgroundAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'too soon', userId: OWNER,
    })).kind).toBe('conflict');
    expect(await reserveConversationForSyncTurn(db, {
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, userMessage: 'too soon', userId: OWNER,
    })).toBeNull();

    // The tool returns; the turn stops at its next checkpoint, writes its tail, and only then is the run cancelled.
    releaseTool();
    await job;
    const run = (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;
    expect(run.status).toBe('canceled');
    expect(run.errorReason).toBe('canceled_by_caller');
    const afterCancel = await stored(id);
    expect(afterCancel).toMatchObject({ runtimeStatus: 'idle', stopReason: 'cancelled' });
    expect(afterCancel.messages).toHaveLength(0); // a cancelled turn is not written to the transcript
    const firstTurnEvents = await logged(id);
    expect(firstTurnEvents.map((e) => e.type)).toEqual([
      'user.message', 'session.status_running', 'agent.tool_use', 'agent.tool_result', 'agent.message', 'session.status_idle',
    ]);
    expect(firstTurnEvents.at(-1)!.data).toMatchObject({ stopReason: 'cancelled' });
    expect(afterCancel.lastEventSeq).toBe(firstTurnEvents.at(-1)!.seq);
    // What the cancelled turn spent (its one model request) is already on the session.
    expect(afterCancel.spentUsd).toBeCloseTo(REQUEST_COST, 8);

    // Now the conversation is free: the next message runs as a turn of its own.
    const second = await executeAgentChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, userMessage: 'second', userId: OWNER,
    });
    expect(second.status).toBe('completed');

    const final = await stored(id);
    // Both turns' spend is on the session: the cancelled one's request and the second turn's.
    expect(final.spentUsd).toBeCloseTo(2 * REQUEST_COST, 8);
    expect(final).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    const events = await logged(id);
    // Per-turn coherent: the second turn's events follow the first turn's idle, none interleaved.
    expect(events.slice(firstTurnEvents.length).map((e) => e.type)).toEqual([
      'user.message', 'session.status_running', 'agent.message', 'session.usage', 'session.status_idle', 'session.work_done',
    ]);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(final.lastEventSeq).toBe(events.at(-1)!.seq);
  }, 20_000);

  it('a hung call cannot hold the conversation past the run\'s own ceiling', async () => {
    const id = String((await newSession())._id);
    const created = await createBackgroundAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'first', userId: OWNER,
      limits: { backgroundMaxDurationMs: 2_500, maxConcurrentRunsPerTenant: 0, maxConcurrentRunsPerProject: 0 },
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const runId = String(created.run._id);
    const startedAt = Date.now();
    const job = runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    await toolStarted;
    await requestAgentRunCancellation(DB_NAME, tenantId, PROJECT_ID, runId);

    await job; // the tool is never released

    expect(Date.now() - startedAt).toBeLessThan(6_000);
    const run = (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;
    expect(run.status).toBe('canceled');
    releaseTool(); // let the abandoned turn end
    await delay(100);
  }, 20_000);

  it('a turn abandoned at the ceiling that ends late writes nothing over the turn that followed it', async () => {
    const id = String((await newSession())._id);
    const created = await createBackgroundAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'first', userId: OWNER,
      limits: { backgroundMaxDurationMs: 2_500, maxConcurrentRunsPerTenant: 0, maxConcurrentRunsPerProject: 0 },
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const runId = String(created.run._id);
    const job = runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    await toolStarted;
    await requestAgentRunCancellation(DB_NAME, tenantId, PROJECT_ID, runId);
    await job; // the ceiling gave the slot up with the tool call still hanging

    // The conversation is free: a newer turn runs and finishes.
    const second = await executeAgentChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, userMessage: 'second', userId: OWNER,
    });
    expect(second.status).toBe('completed');
    const afterSecond = await stored(id);
    expect(afterSecond).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    const eventsAfterSecond = await logged(id);

    // The abandoned turn finally ends. Its end is not written over the newer turn's.
    releaseTool();
    await delay(500);
    const final = await stored(id);
    expect(final).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    expect(final.lastEventSeq).toBe(afterSecond.lastEventSeq);
    const events = await logged(id);
    // No `session.status_idle(cancelled)` / `agent.message` of the old turn after the newer turn's idle.
    expect(events.slice(eventsAfterSecond.length)).toEqual([]);
    expect(events.at(-1)!.type).toBe('session.work_done');
    // Both turns' spend still lands: one request each.
    expect(final.spentUsd).toBeCloseTo(2 * REQUEST_COST, 8);
  }, 20_000);

  it('a cancelled turn\'s spend is on the session even when the session has no budget', async () => {
    const id = String((await newSession(false))._id);
    const created = await createBackgroundAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'first', userId: OWNER,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const runId = String(created.run._id);
    const job = runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    await toolStarted;
    await requestAgentRunCancellation(DB_NAME, tenantId, PROJECT_ID, runId);
    await delay(1400);
    releaseTool();
    await job;

    const afterCancel = await stored(id);
    expect(afterCancel.budget).toBeUndefined();
    // A cancelled turn is not written to the transcript, but its one model request was billed.
    expect(afterCancel.messages).toHaveLength(0);
    expect(afterCancel.spentUsd).toBeCloseTo(REQUEST_COST, 8);

    const second = await executeAgentChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, userMessage: 'second', userId: OWNER,
    });
    expect(second.status).toBe('completed');
    const final = await stored(id);
    // spent_usd == the sum of what the turns cost: the cancelled turn's request plus the second turn's.
    const events = await logged(id);
    const reported = events.filter((e) => e.type === 'agent.message')
      .reduce((sum, e) => sum + ((e.data.usage as { costUsd?: number } | undefined)?.costUsd ?? 0), 0);
    expect(final.spentUsd).toBeCloseTo(2 * REQUEST_COST, 8);
    expect(final.spentUsd).toBeGreaterThanOrEqual(reported - 1e-9);
  }, 20_000);
});
