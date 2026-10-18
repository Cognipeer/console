/**
 * Delegation (sub-agents) at run time, end to end: a REAL SQLite provider and the
 * REAL agent-sdk loop, driven by scripted chat models (one per model key) that
 * report token usage. Faked at the boundary only: the model lookup, the gateway
 * model itself (`settlingModel` plays what the gateway does for an agent's
 * bookkeeping: the cost of each request and the run's token tally), the queue,
 * the audit write and the sandbox toolbox.
 *
 * The delegation hardening these tests rely on is agent-sdk 0.15.0; against an
 * older SDK the suite is skipped (package.json moves to ^0.15.0 on release).
 */

import { settlingModel } from '../helpers/fakeGatewayModel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SDK_HAS_DELEGATION_HARDENING,
  ScriptedModel,
  answer,
  delegateTo,
  type Script,
} from '../helpers/subagentRun';

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
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
  buildAgentSandboxTools: vi.fn(async () => ({ tools: [], definitions: [], cleanup: async () => undefined, collectOutputs: async () => ({ attachments: [], warnings: [] }) })),
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

import { getDatabase } from '@/lib/database';
import type { IAgentConfig, IAgentConversation } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { executeAgentChatLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { destroyCache } from '@/lib/core/cache';

const DB_NAME = 'tenant_delegation';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'orchestrator';
const OWNER = 'user-1';

/** Per 1M tokens. The worker model is ten times the price of the main one. */
const MAIN_PRICING = { inputTokenPer1M: 1, outputTokenPer1M: 2, currency: 'USD' };
const WORKER_PRICING = { inputTokenPer1M: 10, outputTokenPer1M: 20, currency: 'USD' };

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
/** The scripted model of each model key, as the run asked for it. */
let models: Record<string, ScriptedModel>;
/** The models' own pricing by key (a test may add a model). */
let pricing: Record<string, typeof MAIN_PRICING | undefined>;

const modelRecord = (key: string) => ({
  key, name: key, category: 'llm', providerKey: 'openai', providerDriver: 'openai',
  modelId: `${key}-id`, tenantId, projectId: PROJECT_ID, settings: {},
  ...(pricing[key] ? { pricing: pricing[key] } : {}),
});

/** Registers what a model key says, and makes the "gateway" hand the run that script. */
function script(key: string, replies: Script, streamChunks?: (call: number) => unknown[] | undefined): ScriptedModel {
  const model = new ScriptedModel(`${key}-id`, replies, streamChunks);
  models[key] = model;
  return model;
}

type Subagent = NonNullable<IAgentConfig['subagents']>[number];

const inlineHelper = (extra: Partial<Subagent> = {}): Subagent => ({
  kind: 'inline', name: 'helper', header: 'Does the legwork', systemPrompt: 'You do the legwork.', modelKey: 'worker', enabled: true, ...extra,
} as Subagent);

async function createAgent(config: Partial<IAgentConfig> = {}, key = AGENT_KEY) {
  return db.createAgent({
    tenantId,
    projectId: PROJECT_ID,
    key,
    name: key,
    config: { modelKey: 'main', systemPrompt: 'You orchestrate.', ...config },
    status: 'active',
    createdBy: OWNER,
  });
}

async function newConversation(extra: Partial<IAgentConversation> = {}, agentKey = AGENT_KEY): Promise<IAgentConversation> {
  return db.createAgentConversation({
    tenantId,
    projectId: PROJECT_ID,
    agentKey,
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

const playground = (conversationId: string, userMessage: string, extra: Record<string, unknown> = {}) => executePlaygroundChatLocal({
  tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId, userMessage, ...extra,
});

const stored = async (id: string) => (await db.findAgentConversationById(id))!;
const events = async (id: string) => db.listAgentSessionEvents(id);

describe.skipIf(!SDK_HAS_DELEGATION_HARDENING)('delegation at run time', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await destroyCache();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-delegation-'));
    db = new SQLiteProvider(tmpDir, 'test_main');
    await db.connect();
    hoisted.getDatabase.mockResolvedValue(db);
    hoisted.db.current = db;
    (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    const tenant = await db.createTenant({
      companyName: 'Acme', slug: 'acme-delegation', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(DB_NAME);
    models = {};
    pricing = { main: MAIN_PRICING, worker: WORKER_PRICING };
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => modelRecord(key));
    hoisted.buildGatewayChatModel.mockImplementation(async (input: { model: { key: string } }) => {
      const model = models[input.model.key];
      if (!model) throw new Error(`no scripted model for "${input.model.key}"`);
      return settlingModel(input as Parameters<typeof settlingModel>[0], model);
    });
    hoisted.publish.mockResolvedValue(undefined);
    hoisted.getUserAuthState.mockResolvedValue('active');
    hoisted.recordAuditLog.mockResolvedValue(undefined);
    hoisted.publishWebhook.mockResolvedValue(undefined);
    reloadConfig();
  });

  afterEach(async () => {
    reloadConfig();
    await db.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('usage and cost of a turn that delegated (CON-14)', () => {
    // The parent asks for one delegation (100 + 20 tokens), the child answers (1000 + 500), the parent finishes (150 + 30).
    const ASK = { input: 100, output: 20 };
    const CHILD = { input: 1000, output: 500 };
    const FINISH = { input: 150, output: 30 };
    const price = (usage: { input: number; output: number }, rates: typeof MAIN_PRICING) =>
      (usage.input * rates.inputTokenPer1M + usage.output * rates.outputTokenPer1M) / 1e6;
    const PARENT_COST = price(ASK, MAIN_PRICING) + price(FINISH, MAIN_PRICING);
    const CHILD_COST = price(CHILD, WORKER_PRICING);

    function delegatingRun() {
      const main = script('main', (call) => (call === 0 ? delegateTo('d1', 'helper', 'do the legwork', ASK) : answer('all done', FINISH)));
      const worker = script('worker', () => answer('legwork done', CHILD));
      return { main, worker };
    }

    /** What every model call of the turn reported: the sum a gateway would have recorded. */
    function reported({ main, worker }: { main: ScriptedModel; worker: ScriptedModel }) {
      const a = main.reportedTokens();
      const b = worker.reportedTokens();
      return { input: a.input + b.input, output: a.output + b.output };
    }

    it('counts the turn tokens once: the parent calls and the child calls, each a single time', async () => {
      await createAgent({ subagents: [inlineHelper()] });
      const run = delegatingRun();
      const id = String((await newConversation())._id);

      const response = await chat(id, 'get it done');

      const total = reported(run);
      expect(total).toEqual({ input: 1250, output: 550 });
      expect(response.output.find((item) => item.type === 'message')).toBeTruthy();
      expect(response.usage).toMatchObject({
        input_tokens: total.input,
        output_tokens: total.output,
        total_tokens: total.input + total.output,
      });
      // The stored message carries the same totals as the response.
      expect((await stored(id)).messages.at(-1)!.usage).toMatchObject({ inputTokens: total.input, outputTokens: total.output });
    });

    it('prices the child calls at the child model, not at the main model', async () => {
      await createAgent({ subagents: [inlineHelper()] });
      delegatingRun();
      const id = String((await newConversation())._id);

      await chat(id, 'get it done');

      const message = (await stored(id)).messages.at(-1)!;
      expect(message.usage?.costUsd).toBeCloseTo(PARENT_COST + CHILD_COST, 8);
      // What the "gateway" recorded for the three requests is the same sum: the turn is not billed twice.
      expect((await stored(id)).spentUsd).toBeCloseTo(PARENT_COST + CHILD_COST, 8);
    });

    it('the playground reports the same totals and cost as the live chat', async () => {
      await createAgent({ subagents: [inlineHelper()] });
      const run = delegatingRun();
      const id = String((await newConversation())._id);

      const result = await playground(id, 'get it done');

      const total = reported(run);
      expect(result.usage).toMatchObject({ inputTokens: total.input, outputTokens: total.output });
      expect(result.usage?.costUsd).toBeCloseTo(PARENT_COST + CHILD_COST, 8);
      expect((await stored(id)).spentUsd).toBeCloseTo(PARENT_COST + CHILD_COST, 8);
    });

    it('prices a sub-agent with no model of its own at the parent\'s rates', async () => {
      await createAgent({ subagents: [inlineHelper({ modelKey: undefined })] });
      // One model serves both: the parent asks, the child answers on the same model, the parent finishes.
      const main = script('main', (call) => {
        if (call === 0) return delegateTo('d1', 'helper', 'do the legwork', ASK);
        if (call === 1) return answer('legwork done', CHILD);
        return answer('all done', FINISH);
      });
      const id = String((await newConversation())._id);

      const response = await chat(id, 'get it done');

      expect(response.usage).toMatchObject({ input_tokens: 1250, output_tokens: 550 });
      const message = (await stored(id)).messages.at(-1)!;
      expect(message.usage?.costUsd).toBeCloseTo(price({ input: 1250, output: 550 }, MAIN_PRICING), 8);
      expect(main.replies).toHaveLength(3);
    });

    it('leaves a turn unpriced when its own model has no price, rather than a cost without the parent\'s calls', async () => {
      pricing.main = undefined;
      await createAgent({ subagents: [inlineHelper()] });
      delegatingRun();
      const id = String((await newConversation())._id);

      await chat(id, 'get it done');

      const message = (await stored(id)).messages.at(-1)!;
      expect(message.usage).toMatchObject({ inputTokens: 1250, outputTokens: 550 });
      expect(message.usage?.costUsd).toBeUndefined();
    });

    it('a session budget sees the child spend of the turn that made it', async () => {
      await createAgent({ subagents: [inlineHelper()] });
      delegatingRun();
      // The child alone costs $0.02: more than the whole session budget.
      const id = String((await newConversation({ budget: { maxCostUsd: 0.015, onReach: 'stop' } }))._id);

      const response = await chat(id, 'get it done');

      expect(response.stop_reason).toBe('budget_reached');
      const logged = await events(id);
      // The parent's first call and the child's call were made; the budget stopped the run before the parent's second.
      expect(logged.find((event) => event.type === 'session.usage')?.data).toMatchObject({
        turnCostUsd: expect.closeTo(price(ASK, MAIN_PRICING) + CHILD_COST, 8),
      });
      expect(logged.some((event) => event.type === 'budget.reached')).toBe(true);
    });
  });
  describe('what a sub-agent streams while it works (CON-3)', () => {
    const thought = (text: string) => ({ type: 'reasoning', reasoning_content: text });

    /** A parent that thinks, delegates, thinks again and answers; a child that thinks and writes. All of it streams. */
    function streamingRun() {
      script(
        'main',
        (call) => (call === 0 ? delegateTo('d1', 'helper', 'do the legwork') : answer('')),
        (call) => (call === 0 ? [thought('Parent plans.')] : [thought('Parent concludes.'), 'all ', 'done']),
      );
      script('worker', () => answer(''), () => [thought('Child thinks.'), 'child words']);
    }

    it('keeps the child\'s thinking out of the live reasoning and out of the reasoning the turn stores', async () => {
      await createAgent({ subagents: [inlineHelper()] });
      streamingRun();
      const id = String((await newConversation())._id);
      const live: string[] = [];

      await chat(id, 'get it done', { onReasoningChunk: (text: string) => live.push(text) });

      expect(live.join('')).toBe('Parent plans.\n\nParent concludes.');
      expect((await stored(id)).messages.at(-1)!.reasoning).toBe('Parent plans.\n\nParent concludes.');
    });

    it('keeps the child\'s words out of the answer stream and out of the answer', async () => {
      await createAgent({ subagents: [inlineHelper()] });
      streamingRun();
      const id = String((await newConversation())._id);
      const text: string[] = [];

      const response = await chat(id, 'get it done', { onTextChunk: (chunk: string) => text.push(chunk) });

      expect(text.join('')).toBe('all done');
      expect(JSON.stringify(response.output)).not.toContain('child words');
      expect((await stored(id)).messages.at(-1)!.content).toBe('all done');
    });

    it('the playground stream is as clean as the live chat\'s', async () => {
      await createAgent({ subagents: [inlineHelper()] });
      streamingRun();
      const id = String((await newConversation())._id);
      const live: string[] = [];
      const text: string[] = [];

      const result = await playground(id, 'get it done', {
        onReasoningChunk: (chunk: string) => live.push(chunk),
        onTextChunk: (chunk: string) => text.push(chunk),
      });

      expect(live.join('')).toBe('Parent plans.\n\nParent concludes.');
      expect(text.join('')).toBe('all done');
      expect(result.reasoning).toBe('Parent plans.\n\nParent concludes.');
    });
  });
});
