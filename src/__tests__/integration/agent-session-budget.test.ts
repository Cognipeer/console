/**
 * A session budget that pauses, and agent spend counting toward the tenant's
 * spend limits — end to end.
 *
 * A REAL SQLite provider and the REAL agent-sdk loop, driven by a scripted chat
 * model that reports token usage (every model request costs exactly $0.01).
 * Faked at the boundary only: the model lookup, the sandbox toolbox (stands in
 * for "a tool Console builds"), the queue and the audit write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getModelByKey: vi.fn(),
  buildModelRuntime: vi.fn(),
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
// What the session log tells webhook subscribers (the subscriptions themselves are covered elsewhere).
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhook }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/models/runtimeService', () => ({ buildModelRuntime: hoisted.buildModelRuntime }));
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
import type { IAgentConfig, IAgentConversation } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import {
  createConversation,
  executeAgentChatLocal,
  executeAgentContinueLocal,
  executePlaygroundChatLocal,
} from '@/lib/services/agents/agentService';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import { updateSessionBudget } from '@/lib/services/agents/sessionBudgetService';
import {
  createBackgroundAgentRun,
  queueAgentRunContinue,
  runAgentJobLocal,
  serializeAgentRun,
} from '@/lib/services/agents/agentRunService';
import { getBudgetUsage, settleUsageBudget, type QuotaContext } from '@/lib/quota/quotaGuard';
import { destroyCache } from '@/lib/core/cache';

const DB_NAME = 'tenant_budget';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'ops-agent';
const OWNER = 'user-1';
/** Each scripted model request: 5000 + 5000 tokens at $1 per 1M = exactly $0.01. */
const REQUEST_COST = 0.01;

type Reply = Record<string, unknown>;

const readCall = (n: number): Reply => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'sandbox_read_file', arguments: JSON.stringify({ path: `/f${n}` }) } }],
  usage_metadata: { input_tokens: 5000, output_tokens: 5000, total_tokens: 10000 },
});
const finalAnswer = (text = 'all done'): Reply => ({
  role: 'assistant',
  content: text,
  usage_metadata: { input_tokens: 5000, output_tokens: 5000, total_tokens: 10000 },
});

/** A chat model that replies from a script and remembers what it was shown. */
class ScriptedModel {
  readonly modelName = 'scripted-model';
  seen: Array<Array<{ role: string; content: unknown }>> = [];
  constructor(private readonly script: (call: number) => Reply) {}
  bindTools() { return this; }
  async invoke(messages: Array<{ role: string; content: unknown }>): Promise<Reply> {
    const reply = this.script(this.seen.length);
    this.seen.push(messages);
    return reply;
  }
}

/** Three tool-calling requests, then an answer: four requests in all. */
const fourRequestScript = (call: number): Reply => (call < 3 ? readCall(call + 1) : finalAnswer());

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let executed: string[];

function scriptModel(script: (call: number) => Reply): ScriptedModel {
  const model = new ScriptedModel(script);
  hoisted.buildModelRuntime.mockResolvedValue({ runtime: { createChatModel: () => model } });
  return model;
}

async function createAgent(config: Partial<IAgentConfig> = {}) {
  await db.createAgent({
    tenantId,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Ops',
    config: { modelKey: 'gpt-4o', ...config },
    status: 'active',
    createdBy: OWNER,
  });
}

async function newConversation(extra: Partial<IAgentConversation> = {}): Promise<IAgentConversation> {
  return db.createAgentConversation({
    tenantId,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    title: 'New conversation',
    messages: [],
    metadata: { source: 'console' },
    createdBy: OWNER,
    ...extra,
  });
}

const chat = (conversationId: string, userMessage: string, extra: Record<string, unknown> = {}) => executeAgentChatLocal({
  tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId, userMessage, userId: OWNER, ...extra,
});

const playground = (conversationId: string, userMessage: string) => executePlaygroundChatLocal({
  tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId, userMessage,
});

const continueSession = (conversationId: string, source: 'agent' | 'agent-playground' = 'agent') => executeAgentContinueLocal({
  tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId, userId: OWNER,
  continuation: { source },
});

const raise = (conversationId: string, budget: unknown) => updateSessionBudget({
  tenantDbName: DB_NAME, projectId: PROJECT_ID, conversationId, budget,
});

const stored = async (id: string) => (await db.findAgentConversationById(id))!;
const eventTypes = async (id: string) => (await db.listAgentSessionEvents(id)).map((event) => event.type);

/** Settles are fire-and-forget; let them land. */
const settleTicks = () => new Promise((resolve) => setTimeout(resolve, 50));

const quotaContext = (): QuotaContext => ({
  domain: 'llm', licenseType: 'FREE', projectId: PROJECT_ID, resourceKey: 'gpt-4o',
  tenantDbName: DB_NAME, tenantId, userId: OWNER,
});

beforeEach(async () => {
  vi.clearAllMocks();
  await destroyCache();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-budget-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-budget', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {},
    pricing: { inputTokenPer1M: 1, outputTokenPer1M: 1, currency: 'USD' },
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  hoisted.publishWebhook.mockResolvedValue(undefined);
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '10000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '1000';
  reloadConfig();
  executed = [];
  hoisted.sandboxTools = [createTool({
    name: 'sandbox_read_file',
    description: 'Read a file',
    schema: z.object({ path: z.string() }),
    func: async (args: { path: string }) => {
      executed.push(args.path);
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

describe('a session budget that pauses', () => {
  it('stops the turn at the budget, pauses the session, and keeps the work done', async () => {
    await createAgent();
    scriptModel(fourRequestScript);
    const conversation = await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } });
    const id = String(conversation._id);

    const response = await chat(id, 'go through the files');

    // Three requests ran; the budget was crossed by the third (at most one request of overshoot).
    expect(executed).toEqual(['/f1', '/f2', '/f3']);
    expect(response.status).toBe('incomplete');
    expect(response.stop_reason).toBe('budget_reached');
    expect(response.incomplete_details?.reason).toBe('budget_reached');
    expect(response.stop_detail).toContain('session budget reached');

    const after = await stored(id);
    expect(after).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
    expect(after.spentUsd).toBeCloseTo(3 * REQUEST_COST, 8);
    expect(after.messages).toHaveLength(2);
    expect(after.messages[1]).toMatchObject({ role: 'assistant', stopReason: 'limit' });
    expect(after.messages[1].usage?.costUsd).toBeCloseTo(3 * REQUEST_COST, 8);
    // The state survived: the tool calls and results are what a continuation resumes from.
    expect(JSON.parse((await db.findAgentConversationState(id))!.snapshot).messages.at(-1)).toMatchObject({ role: 'tool' });

    expect(await eventTypes(id)).toEqual([
      'user.message', 'session.status_running',
      'agent.tool_use', 'agent.tool_result', 'agent.tool_use', 'agent.tool_result', 'agent.tool_use', 'agent.tool_result',
      'agent.message', 'session.usage', 'budget.reached', 'session.status_idle',
    ]);
    const logged = await db.listAgentSessionEvents(id);
    expect(logged.find((e) => e.type === 'session.usage')?.data).toMatchObject({
      spentUsd: expect.closeTo(0.03, 8), budget: { maxCostUsd: 0.025, onReach: 'pause' },
    });
    expect(logged.find((e) => e.type === 'budget.reached')?.data).toMatchObject({ maxCostUsd: 0.025 });
    expect(logged.find((e) => e.type === 'session.status_idle')?.data).toMatchObject({ stopReason: 'budget_reached' });
  });

  it('refuses a new message while the budget is used up, without calling the model', async () => {
    await createAgent();
    const model = scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go');
    const callsBefore = model.seen.length;

    const refusal = await chat(id, 'one more thing').catch((error) => error);
    expect(refusal).toMatchObject({ name: 'AgentBudgetReachedError', status: 402 });
    expect(classifyAgentRunError(refusal)).toMatchObject({
      status: 402,
      error: { type: 'budget_reached', spentUsd: expect.closeTo(0.03, 8), maxCostUsd: 0.025 },
    });
    expect(model.seen).toHaveLength(callsBefore);
    // The refusal did not touch the session: it still waits for a budget.
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
  });

  it('raise + continue finishes the turn on the carried state, with NO new user message', async () => {
    await createAgent();
    const model = scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go through the files');

    const tooLow = await raise(id, { maxCostUsd: 0.03, onReach: 'pause' });
    expect(tooLow).toMatchObject({ kind: 'invalid', message: expect.stringContaining('greater than') });

    const raised = await raise(id, { maxCostUsd: 0.1, onReach: 'pause' });
    expect(raised.kind).toBe('ok');
    if (raised.kind !== 'ok') return;
    expect(raised.wasBudgetPaused).toBe(true);
    expect(raised.conversation.budget).toEqual({ maxCostUsd: 0.1, onReach: 'pause' });

    const continued = await continueSession(id);

    // The model carried on from the last tool results: its fourth request saw them, and no user turn was added.
    expect(model.seen).toHaveLength(4);
    expect(model.seen[3].at(-1)).toMatchObject({ role: 'tool' });
    expect(model.seen[3].filter((m) => m.role === 'user')).toHaveLength(1);
    expect(continued.response.status).toBe('completed');
    expect(continued.result.content).toBe('all done');

    const after = await stored(id);
    expect(after.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(after).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    expect(after.spentUsd).toBeCloseTo(4 * REQUEST_COST, 8);
    const types = await eventTypes(id);
    expect(types.slice(-4)).toEqual(['agent.message', 'session.usage', 'session.status_idle', 'session.work_done']);
    // A continuation is not a new message: exactly one user.message in the whole log.
    expect(types.filter((t) => t === 'user.message')).toHaveLength(1);
    // Only the first turn's tool calls ran; the answer needed none.
    expect(executed).toEqual(['/f1', '/f2', '/f3']);
  });

  it('refuses to continue while the budget is still used up, and a session that did not stop on its budget', async () => {
    await createAgent();
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go');
    expect(await continueSession(id).catch((e) => e)).toMatchObject({ name: 'AgentBudgetReachedError', status: 402 });

    scriptModel(() => finalAnswer('hi'));
    const done = String((await newConversation())._id);
    await chat(done, 'hello');
    expect(await continueSession(done).catch((e) => e)).toMatchObject({ name: 'AgentResumeError', status: 409 });
  });

  it('behaves the same for a dashboard (playground) session, including the continuation', async () => {
    await createAgent();
    const model = scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);

    const result = await playground(id, 'go through the files');
    expect(result.stopReason).toBe('limit');
    expect(result.stopDetail).toContain('session budget reached');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
    expect(await playground(id, 'more').catch((e) => e)).toMatchObject({ name: 'AgentBudgetReachedError' });

    expect((await raise(id, { maxCostUsd: 1, onReach: 'pause' })).kind).toBe('ok');
    const continued = await continueSession(id, 'agent-playground');
    expect(continued.result.content).toBe('all done');
    expect(model.seen).toHaveLength(4);
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
  });

  it('a continuation can be queued as a background run (the client API resume)', async () => {
    await createAgent();
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go');
    await raise(id, { maxCostUsd: 1, onReach: 'pause' });

    const queued = await queueAgentRunContinue({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id,
      userId: OWNER, usePublished: false,
    });
    expect(queued.kind).toBe('queued');
    if (queued.kind !== 'queued') return;
    const runId = String(queued.run._id);
    expect(hoisted.publish.mock.calls.some((call) => call[1] === 'resume' && (call[2] as { runId: string }).runId === runId)).toBe(true);

    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const run = (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;
    expect(run.status).toBe('succeeded');
    expect(run.stopReason).toBe('end_turn');
    expect(serializeAgentRun(run)).toMatchObject({ status: 'succeeded', stop_reason: 'end_turn' });
    const after = await stored(id);
    expect(after.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(after).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
  });
});

/** The text of the answer in a Responses-shaped reply. */
const answerText = (response: { output: Array<{ type: string; content?: Array<{ text?: string }> }> }) =>
  response.output.filter((item) => item.type === 'message').map((item) => item.content?.[0]?.text).join('');
/** The webhook events published so far, as `type:stopReason?`. */
const webhookTypes = () => hoisted.publishWebhook.mock.calls.map((call) => (call[0] as { type: string }).type);

describe('a turn that crosses the budget while finishing normally', () => {
  // One model request costs $0.01, more than the $0.005 that is left: the turn is a single
  // request that the SDK has no reason to stop — the common case for a plain chat turn.
  const TINY = { maxCostUsd: 0.005, onReach: 'pause' as const };

  it('is flagged exactly like a capped one: budget_reached, budget_paused, the event, the idle and the webhook — and the answer is delivered', async () => {
    await createAgent();
    scriptModel(() => finalAnswer('here is your answer'));
    const id = String((await newConversation({ budget: TINY }))._id);

    const response = await chat(id, 'spend it');

    expect(answerText(response)).toBe('here is your answer');
    expect(response.status).toBe('incomplete');
    expect(response.stop_reason).toBe('budget_reached');
    expect(response.stop_detail).toContain('session budget reached');

    const after = await stored(id);
    expect(after).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
    expect(after.spentUsd).toBeCloseTo(REQUEST_COST, 8);
    // The answer is in the transcript, as an ordinary finished message.
    expect(after.messages[1]).toMatchObject({ role: 'assistant', content: 'here is your answer' });
    expect(after.messages[1].stopReason).toBeUndefined();

    expect(await eventTypes(id)).toEqual([
      'user.message', 'session.status_running', 'agent.message', 'session.usage', 'budget.reached', 'session.status_idle',
    ]);
    const logged = await db.listAgentSessionEvents(id);
    expect(logged.find((e) => e.type === 'budget.reached')?.data).toMatchObject({ spentUsd: expect.closeTo(0.01, 8), maxCostUsd: 0.005 });
    expect(logged.find((e) => e.type === 'session.status_idle')?.data).toMatchObject({ stopReason: 'budget_reached' });
    expect(webhookTypes()).toEqual(['budget.reached', 'session.idled']);
    expect(hoisted.publishWebhook.mock.calls.at(-1)?.[0]).toMatchObject({ data: { stopReason: 'budget_reached' } });

    // The first signal is no longer the 402 on the next message: the session already says so.
    expect(await chat(id, 'more').catch((e) => e)).toMatchObject({ name: 'AgentBudgetReachedError', status: 402 });
  });

  it('a stopping budget ends the session idle with budget_reached', async () => {
    await createAgent();
    scriptModel(() => finalAnswer());
    const id = String((await newConversation({ budget: { ...TINY, onReach: 'stop' } }))._id);

    const response = await chat(id, 'go');

    expect(response.stop_reason).toBe('budget_reached');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'budget_reached' });
    expect(await eventTypes(id)).toContain('budget.reached');
  });

  it('landing exactly on the budget uses it up', async () => {
    await createAgent();
    scriptModel(() => finalAnswer());
    const id = String((await newConversation({ budget: { maxCostUsd: REQUEST_COST, onReach: 'pause' } }))._id);

    expect((await chat(id, 'go')).stop_reason).toBe('budget_reached');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
  });

  it('a turn that stays under the budget is untouched', async () => {
    await createAgent();
    scriptModel(() => finalAnswer());
    const id = String((await newConversation({ budget: { maxCostUsd: 1, onReach: 'pause' } }))._id);

    const response = await chat(id, 'go');

    expect(response.status).toBe('completed');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    expect(await eventTypes(id)).not.toContain('budget.reached');
    expect(webhookTypes()).toEqual(['session.idled', 'session.work_done']);
  });

  it('is the same for a dashboard (playground) session', async () => {
    await createAgent();
    scriptModel(() => finalAnswer('playground answer'));
    const id = String((await newConversation({ budget: TINY }))._id);

    const result = await playground(id, 'go');

    expect(result.content).toBe('playground answer');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
    expect((await stored(id)).spentUsd).toBeCloseTo(REQUEST_COST, 8);
    expect(await eventTypes(id)).toEqual([
      'user.message', 'session.status_running', 'agent.message', 'session.usage', 'budget.reached', 'session.status_idle',
    ]);
    expect(webhookTypes()).toEqual(['budget.reached', 'session.idled']);
  });

  it('is the same for a background run: it ends succeeded with stop_reason budget_reached', async () => {
    await createAgent();
    scriptModel(() => finalAnswer('background answer'));
    const id = String((await newConversation({ budget: TINY }))._id);
    const created = await createBackgroundAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'go', userId: OWNER,
    });
    if (created.kind !== 'created') throw new Error(created.kind);
    const runId = String(created.run._id);

    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });

    const run = (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;
    expect(run.status).toBe('succeeded'); // unchanged: old SDK clients poll for terminal states
    expect(run.stopReason).toBe('budget_reached');
    expect(answerText(run.result as never)).toBe('background answer');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
    expect(webhookTypes()).toEqual(expect.arrayContaining(['budget.reached', 'session.idled', 'agent_run.succeeded']));
  });

  it('a continuation whose last request crosses the budget is flagged too', async () => {
    await createAgent();
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go'); // three requests: $0.03, stopped by the cap
    await raise(id, { maxCostUsd: 0.035, onReach: 'pause' }); // room for 0.005 more; the fourth request costs 0.01

    const continued = await continueSession(id);

    expect(continued.result.content).toBe('all done');
    expect(continued.response.stop_reason).toBe('budget_reached');
    expect(continued.stopReason).toBe('budget_reached');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
    expect((await stored(id)).spentUsd).toBeCloseTo(4 * REQUEST_COST, 8);
    const types = await eventTypes(id);
    expect(types.slice(-4)).toEqual(['agent.message', 'session.usage', 'budget.reached', 'session.status_idle']);
  });

  it('a turn that pauses for an approval keeps its pause even when it is past the budget', async () => {
    await createAgent({
      humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'always', tools: { sandbox_read_file: 'always' } } },
    });
    scriptModel((call) => (call === 0 ? readCall(1) : finalAnswer()));
    const id = String((await newConversation({ budget: TINY }))._id);

    const response = await chat(id, 'read it');

    expect(response.status).toBe('requires_action');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'requires_action', stopReason: 'requires_action' });
    expect(await db.listAgentPendingActions(id, { status: 'pending' })).toHaveLength(1);
    expect(await eventTypes(id)).not.toContain('budget.reached');
    expect(webhookTypes()).not.toContain('budget.reached');
  });

  it('raising the budget of a session whose turn had finished puts it back to idle — there is nothing to continue', async () => {
    await createAgent();
    scriptModel(() => finalAnswer('done already'));
    const id = String((await newConversation({ budget: TINY }))._id);
    await chat(id, 'go');

    const raised = await raise(id, { maxCostUsd: 1, onReach: 'pause' });

    expect(raised.kind).toBe('ok');
    if (raised.kind !== 'ok') return;
    // The client API resumes only a session that has something to carry on.
    expect(raised.wasBudgetPaused).toBe(false);
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    // ...and it takes messages again.
    scriptModel(() => finalAnswer('and another'));
    expect((await chat(id, 'next')).status).toBe('completed');
  });

  it('removing the budget of such a session does the same', async () => {
    await createAgent();
    scriptModel(() => finalAnswer());
    const id = String((await newConversation({ budget: TINY }))._id);
    await chat(id, 'go');

    const removed = await raise(id, null);

    expect(removed.kind === 'ok' && removed.wasBudgetPaused).toBe(false);
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
  });

  it('a session stopped mid-turn (tool results last) is still continuable after a raise', async () => {
    await createAgent();
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go');

    const raised = await raise(id, { maxCostUsd: 1, onReach: 'pause' });

    expect(raised.kind === 'ok' && raised.wasBudgetPaused).toBe(true);
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
  });
});

describe('stop mode', () => {
  it('ends the turn idle with budget_reached, refuses messages, and can be raised and continued', async () => {
    await createAgent();
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'stop' } }))._id);

    const response = await chat(id, 'go');
    expect(response.stop_reason).toBe('budget_reached');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'budget_reached' });
    expect(await chat(id, 'again').catch((e) => e)).toMatchObject({ name: 'AgentBudgetReachedError' });

    const raised = await raise(id, { maxCostUsd: 1, onReach: 'stop' });
    // Not paused, so the client API would not auto-resume it.
    expect(raised.kind === 'ok' && raised.wasBudgetPaused).toBe(false);
    const continued = await continueSession(id);
    expect(continued.result.content).toBe('all done');
  });
});

describe('the budget is a setting of the session', () => {
  it('can be added to a session that has none; it counts what was already spent', async () => {
    await createAgent();
    scriptModel((call) => (call === 0 ? readCall(1) : finalAnswer()));
    const id = String((await newConversation())._id);
    await chat(id, 'first');
    const before = await stored(id);
    expect(before.budget).toBeUndefined();
    expect(before.messages[1].usage?.costUsd).toBeCloseTo(2 * REQUEST_COST, 8);
    expect(await eventTypes(id)).not.toContain('session.usage'); // no budget, no budget events

    expect(await raise(id, { maxCostUsd: 0.02, onReach: 'pause' })).toMatchObject({ kind: 'invalid' });
    const added = await raise(id, { maxCostUsd: 0.03, onReach: 'pause' });
    expect(added.kind === 'ok' && added.conversation.spentUsd).toBeCloseTo(2 * REQUEST_COST, 8);

    // One request ($0.01) is left; the session budget — not an unset per-turn limit — binds the next turn.
    scriptModel(fourRequestScript);
    const response = await chat(id, 'second');
    expect(response.stop_reason).toBe('budget_reached');
    expect((await stored(id)).spentUsd).toBeCloseTo(0.04, 8);
  });

  it('can be removed (null): the paused session takes messages again, and no more budget events are written', async () => {
    await createAgent();
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go');

    const removed = await raise(id, null);
    expect(removed.kind === 'ok' && removed.conversation.budget).toBeFalsy();
    const eventsBefore = (await eventTypes(id)).length;

    scriptModel(() => finalAnswer('fine'));
    const response = await chat(id, 'carry on');
    expect(response.status).toBe('completed');
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    expect((await eventTypes(id)).slice(eventsBefore)).not.toContain('session.usage');
  });

  it('starts from the agent default and can be overridden or switched off at creation', async () => {
    await createAgent({ execution: { sessionBudget: { maxCostUsd: 2, onReach: 'stop' } } });
    const inherited = await createConversation(DB_NAME, tenantId, PROJECT_ID, OWNER, AGENT_KEY);
    expect(inherited.budget).toEqual({ maxCostUsd: 2, onReach: 'stop' });
    const own = await createConversation(DB_NAME, tenantId, PROJECT_ID, OWNER, AGENT_KEY, undefined, undefined, { maxCostUsd: 5, onReach: 'pause' });
    expect(own.budget).toEqual({ maxCostUsd: 5, onReach: 'pause' });
    const none = await createConversation(DB_NAME, tenantId, PROJECT_ID, OWNER, AGENT_KEY, undefined, undefined, null);
    expect(none.budget).toBeUndefined();
    expect((await stored(String(inherited._id))).budget).toEqual({ maxCostUsd: 2, onReach: 'stop' });
  });

  it('the agent per-turn limit still wins when it is the tighter one', async () => {
    await createAgent({ runtime: { limits: { maxCostUsd: 0.015 } } });
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 5, onReach: 'pause' } }))._id);

    const response = await chat(id, 'go');

    expect(response.stop_reason).toBe('limit');
    expect(response.incomplete_details?.reason).toBe('max_cost');
    // A per-turn stop is not a budget stop: the session carries on.
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'limit' });
    expect(await eventTypes(id)).not.toContain('budget.reached');
  });

  it('rejects a budget that is not a positive amount', async () => {
    await createAgent();
    const id = String((await newConversation())._id);
    for (const bad of [{ maxCostUsd: 0, onReach: 'pause' }, { maxCostUsd: -1 }, { maxCostUsd: 1, onReach: 'later' }, 'cheap', []]) {
      expect(await raise(id, bad)).toMatchObject({ kind: 'invalid' });
    }
  });
});

describe('no budget: nothing changes', () => {
  it('a session without a budget runs and reports exactly as before', async () => {
    await createAgent();
    const model = scriptModel(fourRequestScript);
    const id = String((await newConversation())._id);

    const response = await chat(id, 'go');

    expect(response.status).toBe('completed');
    expect(response.stop_reason).toBe('completed');
    expect(model.seen).toHaveLength(4);
    expect(await eventTypes(id)).toEqual([
      'user.message', 'session.status_running',
      'agent.tool_use', 'agent.tool_result', 'agent.tool_use', 'agent.tool_result', 'agent.tool_use', 'agent.tool_result',
      'agent.message', 'session.status_idle', 'session.work_done',
    ]);
    const after = await stored(id);
    expect(after).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    // Nothing is capped, but what the turn cost is still on the session: `spent_usd` is the sum of the turns.
    expect(after.spentUsd).toBeGreaterThan(0);
    expect(after.spentUsd).toBeCloseTo(after.messages[1].usage!.costUsd!, 8);
    expect(after.budget).toBeUndefined();
  });
});

describe('agent spend counts toward the tenant spend limits', () => {
  const setLimit = (monthlySpendLimit: number) => db.createQuotaPolicy({
    tenantId, projectId: PROJECT_ID, domain: 'llm', scope: 'tenant', priority: 10, enabled: true,
    limits: { budget: { monthlySpendLimit, dailySpendLimit: -1 } },
  });

  it('refuses a turn once the monthly spend limit is used up, in the inference path\'s error shape, without calling the model', async () => {
    await createAgent();
    await setLimit(0.05);
    await settleUsageBudget(quotaContext(), { currency: 'USD', totalCost: 0.05 }); // used elsewhere (e.g. direct model calls)
    const model = scriptModel(() => finalAnswer());
    const id = String((await newConversation())._id);

    const refusal = await chat(id, 'hello').catch((error) => error);

    expect(refusal).toMatchObject({ name: 'AgentSpendLimitError', status: 429 });
    expect(classifyAgentRunError(refusal)).toMatchObject({
      status: 429,
      error: { type: 'rate_limit_error', message: expect.stringContaining('Budget exceeded') },
    });
    expect(model.seen).toHaveLength(0);
    // The playground channel is gated the same way.
    expect(await playground(id, 'hello').catch((e) => e)).toMatchObject({ name: 'AgentSpendLimitError' });
  });

  it('a resumed turn (after an approval) and a continued session are gated too', async () => {
    // `sandbox_read_file` is read-only, so ask for it explicitly: the first turn pauses after one request.
    await createAgent({
      humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'always', tools: { sandbox_read_file: 'always' } } },
    });
    await setLimit(0.05);
    scriptModel((call) => (call === 0 ? readCall(1) : finalAnswer()));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'read it');
    expect(paused.status).toBe('requires_action');

    // The limit is used up while the turn waits for its approval (other spend in the tenant).
    await settleUsageBudget(quotaContext(), { currency: 'USD', totalCost: 0.05 });
    const { resolveAgentPendingAction } = await import('@/lib/services/agents/agentActionResolution');
    const [action] = await db.listAgentPendingActions(id, { status: 'pending' });
    await expect(resolveAgentPendingAction({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, conversationId: id, actionId: String(action._id),
      body: { decision: 'allow' }, actor: { userId: OWNER, channel: 'api' }, authorize: async () => ({ allowed: true }), mode: 'sync',
    })).rejects.toMatchObject({ name: 'AgentSpendLimitError' });
    expect(executed).toEqual([]); // the approved tool did not run
    // The answer was not spent: the reviewer can give it again once the limit is lifted.
    expect(await db.listAgentPendingActions(id, { status: 'pending' })).toHaveLength(1);
  });

  it('a session that stopped on its own budget cannot be continued while the tenant limit is used up', async () => {
    await createAgent();
    await setLimit(0.05);
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);
    await chat(id, 'go'); // $0.03 of the $0.05 limit
    await raise(id, { maxCostUsd: 1, onReach: 'pause' });

    await settleUsageBudget(quotaContext(), { currency: 'USD', totalCost: 0.05 });
    const model = scriptModel(() => finalAnswer());
    expect(await continueSession(id).catch((e) => e)).toMatchObject({ name: 'AgentSpendLimitError', status: 429 });
    expect(model.seen).toHaveLength(0);
    // Still paused on its budget: it continues once the tenant limit allows.
    expect(await stored(id)).toMatchObject({ runtimeStatus: 'budget_paused', stopReason: 'budget_reached' });
  });

  it('debits each priced model request once: a turn, and a turn continued after the budget stop', async () => {
    await createAgent();
    await setLimit(100);
    scriptModel(fourRequestScript);
    const id = String((await newConversation({ budget: { maxCostUsd: 0.025, onReach: 'pause' } }))._id);

    await chat(id, 'go'); // three requests
    await settleTicks();
    const afterTurn = await getBudgetUsage(quotaContext());
    expect(afterTurn.perMonth.usedUsd).toBeCloseTo(3 * REQUEST_COST, 6);

    await raise(id, { maxCostUsd: 1, onReach: 'pause' });
    await continueSession(id); // one more request
    await settleTicks();
    const afterContinue = await getBudgetUsage(quotaContext());
    expect(afterContinue.perMonth.usedUsd).toBeCloseTo(4 * REQUEST_COST, 6);
    // The session's own total agrees with the tenant counter: one number, counted once.
    expect((await stored(id)).spentUsd).toBeCloseTo(afterContinue.perMonth.usedUsd, 6);
  });

  it('counts the requests of a turn that fails midway (the provider billed them)', async () => {
    await createAgent();
    await setLimit(100);
    scriptModel((call) => {
      if (call === 0) return readCall(1);
      throw new Error('upstream exploded');
    });
    const id = String((await newConversation())._id);

    await expect(chat(id, 'go')).rejects.toThrow();
    await settleTicks();
    expect((await getBudgetUsage(quotaContext())).perMonth.usedUsd).toBeCloseTo(REQUEST_COST, 6);
  });

  it('a tenant without spend limits is not affected', async () => {
    await createAgent();
    scriptModel(() => finalAnswer());
    const id = String((await newConversation())._id);
    expect((await chat(id, 'hello')).status).toBe('completed');
  });
});

describe('a turn that is not persisted still counts against the session budget', () => {
  it('a turn that throws midway: the requests the provider billed are in spentUsd', async () => {
    await createAgent();
    scriptModel((call) => {
      if (call < 2) return readCall(call + 1);
      throw new Error('upstream exploded');
    });
    const id = String((await newConversation({ budget: { maxCostUsd: 1, onReach: 'pause' } }))._id);

    await expect(chat(id, 'go')).rejects.toThrow();
    const after = await stored(id);
    expect(after.messages).toHaveLength(0);
    expect(after.spentUsd).toBeCloseTo(2 * REQUEST_COST, 8);

    // The next turn starts from that total, not from zero.
    scriptModel(() => finalAnswer());
    await chat(id, 'again');
    expect((await stored(id)).spentUsd).toBeCloseTo(3 * REQUEST_COST, 8);
  });

  it('a caller abort mid-turn: the requests made before it are counted', async () => {
    await createAgent();
    const controller = new AbortController();
    scriptModel((call) => {
      if (call === 1) {
        controller.abort();
        throw new Error('aborted');
      }
      return readCall(call + 1);
    });
    const id = String((await newConversation({ budget: { maxCostUsd: 1, onReach: 'pause' } }))._id);

    await chat(id, 'go', { signal: controller.signal });
    const after = await stored(id);
    expect(after.messages).toHaveLength(0);
    expect(after.spentUsd ?? 0).toBeGreaterThan(0);
  });

  it('a dashboard (playground) turn that throws is counted too', async () => {
    await createAgent();
    scriptModel((call) => {
      if (call < 1) return readCall(1);
      throw new Error('upstream exploded');
    });
    const id = String((await newConversation({ budget: { maxCostUsd: 1, onReach: 'pause' } }))._id);

    await expect(playground(id, 'go')).rejects.toThrow();
    expect((await stored(id)).spentUsd).toBeCloseTo(REQUEST_COST, 8);
  });

  it('a persisted turn is counted once, not twice', async () => {
    await createAgent();
    scriptModel(() => finalAnswer());
    const id = String((await newConversation({ budget: { maxCostUsd: 1, onReach: 'pause' } }))._id);
    await chat(id, 'hello');
    expect((await stored(id)).spentUsd).toBeCloseTo(REQUEST_COST, 8);
  });
});

describe('a budget that cannot be measured is not run unmetered', () => {
  it('refuses the turn (409) when the agent model has no pricing', async () => {
    await createAgent();
    hoisted.getModelByKey.mockResolvedValue({
      key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
      modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {},
    });
    const model = scriptModel(() => finalAnswer());
    const id = String((await newConversation({ budget: { maxCostUsd: 1, onReach: 'pause' } }))._id);

    const error = await chat(id, 'hello').catch((e: unknown) => e);
    expect(classifyAgentRunError(error)).toMatchObject({ status: 409, error: { code: 'session_budget_unenforceable' } });
    expect(model.seen).toHaveLength(0);
  });
});
