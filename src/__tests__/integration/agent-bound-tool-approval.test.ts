/**
 * Tool approval for bound tools, end to end: ONE rule for every source. A call that is not marked read-only
 * asks (an OpenAPI action by its HTTP method, an MCP tool by its annotations, a managed tool by the markings
 * its owner set); the agent's own per-tool setting wins; an agent without any humanInTheLoop config asks like
 * a dashboard agent and refuses the call on a run nobody can answer. REAL SQLite provider and agent-sdk loop,
 * scripted model; only the tool executor is faked.
 */

import { settlingModel } from '../helpers/fakeGatewayModel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ScriptedModel, answer, callTools, shownText, toolCall, type Script } from '../helpers/subagentRun';

const hoisted = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  publish: vi.fn(),
  getUserAuthState: vi.fn(),
  recordAuditLog: vi.fn(),
  publishWebhook: vi.fn(),
  db: { current: null as unknown },
  executeToolAction: vi.fn(),
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
vi.mock('@/lib/services/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/tools')>();
  return { ...actual, executeToolAction: hoisted.executeToolAction };
});
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

const DB_NAME = 'tenant_bound_approval';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'ops';
const OWNER = 'user-1';

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let model: ScriptedModel;
/** The scripted model of a sub-agent (model key `worker`). */
let worker: ScriptedModel;

const schema = { type: 'object', properties: { to: { type: 'string' } } };

async function createTools() {
  const base = { tenantId, projectId: PROJECT_ID, status: 'active', createdBy: OWNER };
  await db.createTool({
    ...base, key: 'crm', name: 'CRM', type: 'openapi',
    actions: [
      { key: 'get_customer', name: 'get_customer', description: 'Reads', inputSchema: schema, executionType: 'openapi_http', httpMethod: 'GET', httpPath: '/c' },
      { key: 'create_customer', name: 'create_customer', description: 'Creates', inputSchema: schema, executionType: 'openapi_http', httpMethod: 'POST', httpPath: '/c' },
      { key: 'delete_customer', name: 'delete_customer', description: 'Deletes', inputSchema: schema, executionType: 'openapi_http', httpMethod: 'DELETE', httpPath: '/c',
        annotations: { readOnlyHint: false, destructiveHint: true } },
    ],
  } as never);
  await db.createTool({
    ...base, key: 'web', name: 'Web', type: 'mcp',
    actions: [
      { key: 'fetch', name: 'fetch', description: 'No annotations', inputSchema: schema, executionType: 'mcp_call', mcpToolName: 'fetch' },
      { key: 'search', name: 'search', description: 'Read-only', inputSchema: schema, executionType: 'mcp_call', mcpToolName: 'search', annotations: { readOnlyHint: true } },
    ],
  } as never);
  // Shaped like a managed tool: the markings come from its owner.
  await db.createTool({
    ...base, key: 'mail', name: 'Mail', type: 'connector', upstreamAuth: { type: 'connector', connectorId: 'c1' },
    actions: [
      { key: 'send_email', name: 'send_email', description: 'Sends', inputSchema: schema, executionType: 'connector_action', annotations: { readOnlyHint: false, destructiveHint: false } },
      { key: 'draft_email', name: 'draft_email', description: 'Drafts', inputSchema: schema, executionType: 'connector_action', annotations: { readOnlyHint: true } },
    ],
  } as never);
}

const bindings = [
  { source: 'tool', sourceKey: 'crm', toolNames: ['get_customer', 'create_customer', 'delete_customer'] },
  { source: 'tool', sourceKey: 'web', toolNames: ['fetch', 'search'] },
  { source: 'tool', sourceKey: 'mail', toolNames: ['send_email', 'draft_email'] },
];

async function createAgent(config: Partial<IAgentConfig> = {}) {
  return db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: AGENT_KEY,
    config: { modelKey: 'main', systemPrompt: 'You operate.', toolBindings: bindings, ...config } as IAgentConfig,
    status: 'active', createdBy: OWNER,
  });
}

async function newConversation(metadata: Record<string, unknown> = {}): Promise<IAgentConversation> {
  return db.createAgentConversation({
    tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'New conversation', messages: [],
    metadata: { source: 'console', ...metadata }, createdBy: OWNER,
  });
}

/** The model calls `tool` once with `args`, then answers. */
function callsOnce(tool: string, args: Record<string, unknown> = { to: 'a@example.com' }) {
  const replies: Script = (call) => (call === 0 ? callTools([toolCall('c1', tool, args)]) : answer('done'));
  model = new ScriptedModel('main-id', replies);
}

const chat = (conversationId: string, extra: Record<string, unknown> = {}) => executeAgentChatLocal({
  tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId, userMessage: 'go', userId: OWNER, ...extra,
});
const actionsOf = (result: unknown) => ((result as { required_action?: { actions?: Array<Record<string, unknown>> } }).required_action?.actions ?? []);

describe('approval of bound tools by their markings', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await destroyCache();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-bound-approval-'));
    db = new SQLiteProvider(tmpDir, 'test_main');
    await db.connect();
    hoisted.getDatabase.mockResolvedValue(db);
    hoisted.db.current = db;
    (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    const tenant = await db.createTenant({
      companyName: 'Acme', slug: 'acme-bound-approval', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
    });
    tenantId = String(tenant._id);
    await db.switchToTenant(DB_NAME);
    hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => ({
      key, name: key, category: 'llm', providerKey: 'openai', providerDriver: 'openai', modelId: `${key}-id`, tenantId, projectId: PROJECT_ID, settings: {},
    }));
    hoisted.buildGatewayChatModel.mockImplementation(async (input: { model: { key: string } }) => settlingModel(input as Parameters<typeof settlingModel>[0], input.model.key === 'worker' ? worker : model));
    hoisted.executeToolAction.mockResolvedValue({ result: 'ok', latencyMs: 1 });
    hoisted.publish.mockResolvedValue(undefined);
    hoisted.getUserAuthState.mockResolvedValue('active');
    hoisted.recordAuditLog.mockResolvedValue(undefined);
    hoisted.publishWebhook.mockResolvedValue(undefined);
    reloadConfig();
    await createTools();
  });

  afterEach(async () => {
    reloadConfig();
    await db.disconnect();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('an agent without humanInTheLoop (created through the client API)', () => {
    it.each(['create_customer', 'delete_customer', 'fetch', 'send_email'])('pauses for %s: POST, destructive, no annotations, managed write', async (tool) => {
      await createAgent();
      callsOnce(tool);
      const id = String((await newConversation())._id);

      const result = await chat(id);

      expect(actionsOf(result)).toHaveLength(1);
      expect(actionsOf(result)[0]).toMatchObject({ kind: 'tool_approval', tool_name: tool });
      expect(hoisted.executeToolAction).not.toHaveBeenCalled();
    });

    it.each(['get_customer', 'search', 'draft_email'])('runs %s straight away: a GET, a read-only MCP tool, a read-only managed action', async (tool) => {
      await createAgent();
      callsOnce(tool);
      const id = String((await newConversation())._id);

      const result = await chat(id);

      expect(actionsOf(result)).toEqual([]);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);
    });

    it('refuses the call on a run without an approver, and the message names the fix', async () => {
      await createAgent();
      callsOnce('send_email');
      const id = String((await newConversation())._id);

      const result = await chat(id, { unattended: true });

      expect(actionsOf(result)).toEqual([]);
      expect(hoisted.executeToolAction).not.toHaveBeenCalled();
      const seen = shownText(model);
      expect(seen).toContain('no approver is available');
      expect(seen).toContain('Never ask');
      expect(seen).toContain('humanInTheLoop');
    });

    it('a stateless playground call has nowhere to park a pause: refused, never run', async () => {
      await createAgent();
      callsOnce('create_customer');

      await executePlaygroundChatLocal({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, userMessage: 'go' });

      expect(hoisted.executeToolAction).not.toHaveBeenCalled();
      expect(shownText(model)).toContain('no approver is available');
    });

    it('a playground call with a session asks, like any session run', async () => {
      await createAgent();
      callsOnce('create_customer');
      const id = String((await newConversation())._id);

      const result = await executePlaygroundChatLocal({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, userMessage: 'go' });

      expect((result as { pendingActions?: unknown[] }).pendingActions).toHaveLength(1);
      expect(hoisted.executeToolAction).not.toHaveBeenCalled();
    });
  });

  describe("the agent's own setting", () => {
    it('a per-tool "never" runs a write without asking, also unattended', async () => {
      await createAgent({ humanInTheLoop: { toolApproval: { enabled: true, tools: { send_email: 'never' } } } });
      callsOnce('send_email');

      const result = await chat(String((await newConversation())._id), { unattended: true });

      expect(actionsOf(result)).toEqual([]);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);
    });

    it('a per-tool "always" asks about a read-only tool too', async () => {
      await createAgent({ humanInTheLoop: { toolApproval: { enabled: true, tools: { get_customer: 'always' } } } });
      callsOnce('get_customer');

      const result = await chat(String((await newConversation())._id));

      expect(actionsOf(result)[0]).toMatchObject({ tool_name: 'get_customer' });
      expect(hoisted.executeToolAction).not.toHaveBeenCalled();
    });

    it('the global switch off means nothing asks (the owner\'s explicit choice)', async () => {
      await createAgent({ humanInTheLoop: { toolApproval: { enabled: false } } });
      callsOnce('delete_customer');

      const result = await chat(String((await newConversation())._id), { unattended: true });

      expect(actionsOf(result)).toEqual([]);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);
    });

    it('a default policy of "never" lets writes run; an explicit "always" still asks', async () => {
      await createAgent({ humanInTheLoop: { toolApproval: { enabled: true, defaultPolicy: 'never', tools: { delete_customer: 'always' } } } });
      callsOnce('create_customer');
      expect(actionsOf(await chat(String((await newConversation())._id)))).toEqual([]);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);

      callsOnce('delete_customer');
      expect(actionsOf(await chat(String((await newConversation())._id)))).toHaveLength(1);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);
    });

    it('"remember for this session" lets the tool through for that session', async () => {
      await createAgent();
      callsOnce('send_email');
      const id = String((await newConversation({ hitlAllowedTools: ['send_email'] }))._id);

      const result = await chat(id);

      expect(actionsOf(result)).toEqual([]);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);
    });

    it('argument exceptions still decide on a write: allow for one recipient, deny for another', async () => {
      const humanInTheLoop = {
        toolApproval: {
          enabled: true,
          exceptions: { send_email: [
            { field: 'to', pattern: '*@example.com', action: 'allow' as const },
            { field: 'to', pattern: '*@rival.example', action: 'deny' as const },
          ] },
        },
      };
      await createAgent({ humanInTheLoop });

      callsOnce('send_email', { to: 'a@example.com' });
      expect(actionsOf(await chat(String((await newConversation())._id)))).toEqual([]);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);

      callsOnce('send_email', { to: 'x@rival.example' });
      expect(actionsOf(await chat(String((await newConversation())._id)))).toEqual([]);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);

      callsOnce('send_email', { to: 'x@other.test' });
      expect(actionsOf(await chat(String((await newConversation())._id)))).toHaveLength(1);
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);
    });
  });

  describe('sub-agents', () => {
    const helper = {
      kind: 'inline', name: 'helper', header: 'Does the legwork', systemPrompt: 'You do the legwork.', modelKey: 'worker', enabled: true,
      toolBindings: [{ source: 'tool', sourceKey: 'mail', toolNames: ['send_email', 'draft_email'] }],
    };
    const delegating = (childTool: string) => {
      model = new ScriptedModel('main-id', (call) => (call === 0 ? callTools([toolCall('d1', 'delegate_to', { subagent: 'helper', input: 'go' })]) : answer('done')));
      worker = new ScriptedModel('worker-id', (call) => (call === 0 ? callTools([toolCall('t1', childTool, { to: 'a@example.com' })]) : answer('child done')));
    };

    it('asks about a write of an inline sub-agent and names the sub-agent', async () => {
      await createAgent({ toolBindings: undefined, subagents: [helper] as never });
      delegating('send_email');

      const result = await chat(String((await newConversation())._id));

      expect(actionsOf(result)).toHaveLength(1);
      expect(actionsOf(result)[0]).toMatchObject({ tool_name: 'send_email', subagent: 'helper' });
    });

    it('refuses the sub-agent\'s write on a run nobody can answer; a read-only action of the same tool runs', async () => {
      await createAgent({ toolBindings: undefined, subagents: [helper] as never });
      delegating('send_email');
      await chat(String((await newConversation())._id), { unattended: true });
      expect(hoisted.executeToolAction).not.toHaveBeenCalled();

      delegating('draft_email');
      await chat(String((await newConversation())._id), { unattended: true });
      expect(hoisted.executeToolAction).toHaveBeenCalledTimes(1);
    });
  });
});
