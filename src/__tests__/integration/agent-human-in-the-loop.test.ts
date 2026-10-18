/**
 * Human in the loop, end to end: an agent that stops for an approval or a
 * question, the answer, and the SAME turn continuing.
 *
 * A REAL SQLite provider (action rows, the paused state, the conversation lock
 * and the run queue are genuinely exercised) and the REAL agent-sdk loop driven
 * by a scripted chat model that issues tool calls. Faked at the boundary: the
 * model lookup, the sandbox toolbox (stands in for "a tool Console builds"),
 * the queue and the audit write.
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
  sandboxTools: [] as unknown[],
  model: { current: null as unknown },
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
// What the session log tells webhook subscribers (the subscriptions themselves are covered elsewhere).
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhook }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({ buildGatewayChatModel: hoisted.buildGatewayChatModel, isDynamicModel: () => false, }));
vi.mock('@/lib/services/agents/agentSandboxTools', () => ({
  buildAgentSandboxTools: vi.fn(async () => ({ tools: hoisted.sandboxTools, definitions: [], cleanup: async () => undefined, collectOutputs: async () => ({ attachments: [], warnings: [] }) })),
  destroyConversationSandbox: vi.fn(),
  resolveSandboxAvailability: vi.fn(),
}));
vi.mock('@/lib/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/database')>();
  return {
    ...actual,
    getDatabase: hoisted.getDatabase,
    // The audit write binds the tenant through the barrel's own getDatabase.
    runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(hoisted.db.current),
  };
});

import { z } from 'zod';
import { createTool } from '@cognipeer/agent-sdk';
import { getDatabase } from '@/lib/database';
import type { IAgentConfig, IAgentConversation, IAgentPendingAction } from '@/lib/database';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { reloadConfig } from '@/lib/core/config';
import { executeAgentChatLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { classifyAgentRunError } from '@/lib/services/agents/agentErrors';
import {
  checkAgentPendingActionResolution,
  resolveAgentPendingAction,
  sweepExpiredPendingActions,
  type ApprovalAuthorizer,
  type ApprovalRequest,
  type ResolveActor,
} from '@/lib/services/agents/agentActionResolution';
import { RESUME_TIMEOUT_ACTOR, runAgentJobLocal, serializeAgentRun } from '@/lib/services/agents/agentRunService';
import { truncateSessionAfterMessage } from '@/lib/services/agents/sessionTruncate';
import { queueAgentRun } from '../helpers/agent-runs';

const DB_NAME = 'tenant_hitl';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'ops-agent';
const OWNER = 'user-1';

type Reply = Record<string, unknown>;
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** A chat model that replies from a script and remembers what it was shown. */
class ScriptedModel {
  readonly modelName = 'scripted-model';
  seen: Array<Array<{ role: string; content: unknown; tool_calls?: unknown }>> = [];
  /** The names of the tools the agent offered the model, per bind. */
  offered: string[][] = [];
  constructor(private readonly script: (call: number, messages: Array<{ role: string; content: unknown }>) => Reply) {}
  bindTools(tools?: Array<{ name?: string; function?: { name?: string } }>) {
    this.offered.push((tools ?? []).map((tool) => String(tool.function?.name ?? tool.name)));
    return this;
  }
  async invoke(messages: Array<{ role: string; content: unknown }>): Promise<Reply> {
    const reply = this.script(this.seen.length, messages);
    this.seen.push(messages);
    return reply;
  }
}

let db: SQLiteProvider;
let tmpDir: string;
let tenantId: string;
let executed: Array<{ tool: string; args: Record<string, unknown> }>;

function buildTools() {
  executed = [];
  const exec = createTool({
    name: 'sandbox_exec',
    description: 'Run a command',
    schema: z.object({ command: z.string() }),
    func: async (args: { command: string }) => {
      executed.push({ tool: 'sandbox_exec', args });
      return { exitCode: 0, stdout: `ran ${args.command}` };
    },
  });
  const read = createTool({
    name: 'sandbox_read_file',
    description: 'Read a file',
    schema: z.object({ path: z.string() }),
    func: async (args: { path: string }) => {
      executed.push({ tool: 'sandbox_read_file', args });
      return { content: 'file text' };
    },
  });
  hoisted.sandboxTools = [exec, read];
}

function scriptModel(script: ConstructorParameters<typeof ScriptedModel>[0]): ScriptedModel {
  const model = new ScriptedModel(script);
  hoisted.buildGatewayChatModel.mockResolvedValue(model);
  return model;
}

const HITL_ON: NonNullable<IAgentConfig['humanInTheLoop']> = {
  toolApproval: { enabled: true, defaultPolicy: 'always' },
  askUser: { enabled: true, allowFreeText: true },
};

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

async function newConversation(metadata?: Record<string, unknown>): Promise<IAgentConversation> {
  return db.createAgentConversation({
    tenantId,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    title: 'New conversation',
    messages: [],
    ...(metadata ? { metadata } : {}),
    createdBy: OWNER,
  });
}

function chat(conversationId: string, userMessage: string, extra: Record<string, unknown> = {}) {
  return executeAgentChatLocal({
    tenantDbName: DB_NAME,
    tenantId,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId,
    userMessage,
    userId: OWNER,
    ...extra,
  });
}

const ownerActor: ResolveActor = { userId: OWNER, channel: 'api' };

/**
 * Who may answer is the policy engine's decision, asked by the route through the authorizer it hands to the
 * service (the engine's own behaviour is iam-agent-approve.test.ts). Here the authorizer is a stand-in that
 * allows, or refuses and remembers what it was asked.
 */
const allow: ApprovalAuthorizer = async () => ({ allowed: true });
function refuseAndRecord(asked: ApprovalRequest[], decisionId?: string): ApprovalAuthorizer {
  return async (request) => {
    asked.push(request);
    return { allowed: false, ...(decisionId ? { decisionId } : {}) };
  };
}

function resolve(
  conversationId: string,
  actionId: string,
  body: Record<string, unknown>,
  actor: ResolveActor = ownerActor,
  mode: 'sync' | 'background' = 'sync',
  authorize: ApprovalAuthorizer = allow,
) {
  return resolveAgentPendingAction({
    tenantDbName: DB_NAME,
    tenantId,
    projectId: PROJECT_ID,
    conversationId,
    actionId,
    body,
    actor,
    authorize,
    mode,
  });
}

/** A model that asks to run `command` once, then answers with what it learned. */
function oneToolScript(command = 'ls') {
  return (call: number, messages: Array<{ role: string; content: unknown }>): Reply => {
    if (call === 0) return { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'sandbox_exec', { command })] };
    const toolMessage = [...messages].reverse().find((m) => m.role === 'tool');
    return { role: 'assistant', content: `done: ${String(toolMessage?.content ?? '')}` };
  };
}

function extractAnswer(response: { output?: Array<{ type: string; content?: Array<{ text?: string }> }> }): string {
  return (response.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? '')
    .join('');
}

async function storedConversation(id: string) {
  return (await db.findAgentConversationById(id))!;
}

async function events(conversationId: string) {
  return db.listAgentSessionEvents(conversationId);
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-hitl-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-hitl', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
  });
  tenantId = String(tenant._id);
  await db.switchToTenant(DB_NAME);
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId, projectId: PROJECT_ID, settings: {},
  });
  hoisted.publish.mockResolvedValue(undefined);
  hoisted.getUserAuthState.mockResolvedValue('active');
  hoisted.recordAuditLog.mockResolvedValue(undefined);
  hoisted.publishWebhook.mockResolvedValue(undefined);
  process.env.AGENT_BACKGROUND_MAX_DURATION_MS = '10000';
  process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS = '1000';
  reloadConfig();
  buildTools();
});

afterEach(async () => {
  delete process.env.AGENT_BACKGROUND_MAX_DURATION_MS;
  delete process.env.AGENT_RUN_HEARTBEAT_INTERVAL_MS;
  reloadConfig();
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('a tool that needs approval pauses the turn', () => {
  it('(a) stores the action row, the paused state and the transcript, and reports requires_action', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('rm -rf /tmp/x'));
    const conversation = await newConversation();
    const id = String(conversation._id);

    const response = await chat(id, 'clean up');

    expect(executed).toEqual([]); // the tool did not run
    expect(response.status).toBe('requires_action');
    expect(response.stop_reason).toBe('requires_action');
    expect(response.required_action?.type).toBe('agent_actions');
    expect(response.required_action?.actions).toHaveLength(1);
    expect(response.required_action?.actions[0]).toMatchObject({
      kind: 'tool_approval', tool_name: 'sandbox_exec', args: { command: 'rm -rf /tmp/x' }, status: 'pending',
    });

    const [action] = await db.listAgentPendingActions(id, { status: 'pending' });
    expect(action.sdkId).toBeTruthy();
    expect(action.toolName).toBe('sandbox_exec');
    expect(action.createdBy).toBe(OWNER);
    expect(action.expiresAt).toBeTruthy(); // default 1440 minutes

    const stored = await db.findAgentConversationState(id);
    expect(stored?.pausedSnapshot).toBeTruthy();
    const paused = JSON.parse(stored!.pausedSnapshot!);
    expect(paused.state.pendingApprovals[0]).toMatchObject({ toolName: 'sandbox_exec', status: 'pending' });
    expect(paused.state.ctx.__awaitingApproval).toBeTruthy();
    // The unanswered call stays in the paused transcript; the normal snapshot repaired it away.
    const pausedAssistant = paused.state.messages.find((m: { tool_calls?: unknown }) => m.tool_calls);
    expect(pausedAssistant).toBeTruthy();
    const normal = JSON.parse(stored!.snapshot);
    expect(normal.messages.some((m: { tool_calls?: unknown }) => m.tool_calls)).toBe(false);

    const after = await storedConversation(id);
    expect(after.runtimeStatus).toBe('requires_action');
    expect(after.pendingActionIds).toEqual([String(action._id)]);
    expect(after.messages).toHaveLength(2);
    expect(after.messages[1]).toMatchObject({ role: 'assistant', stopReason: 'paused' });
    expect(after.messages[1].pendingActions?.[0]).toMatchObject({ id: String(action._id), status: 'pending', toolName: 'sandbox_exec' });

    const logged = await events(id);
    // The pause comes before the tool runs, so there is no tool_use / tool_result.
    expect(logged.map((e) => e.type)).toEqual([
      'user.message', 'session.status_running', 'action.required', 'session.status_idle',
    ]);
    expect(logged.find((e) => e.type === 'action.required')?.data).toMatchObject({ actionId: String(action._id), kind: 'tool_approval', toolName: 'sandbox_exec' });
    expect(logged.find((e) => e.type === 'session.status_idle')?.data).toMatchObject({
      stopReason: 'requires_action', pendingActionIds: [String(action._id)],
    });
  });

  it('a read-only tool is not asked about', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel((call) => call === 0
      ? { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'sandbox_read_file', { path: '/etc/hosts' })] }
      : { role: 'assistant', content: 'read it' });
    const response = await chat(String((await newConversation())._id), 'show hosts');
    expect(response.status).toBe('completed');
    expect(executed).toEqual([{ tool: 'sandbox_read_file', args: { path: '/etc/hosts' } }]);
  });

  it('a per-tool "never" overrides the default, and "always" can ask about a read-only tool', async () => {
    await createAgent({
      humanInTheLoop: {
        toolApproval: { enabled: true, defaultPolicy: 'always', tools: { sandbox_exec: 'never', sandbox_read_file: 'always' } },
      },
    });
    scriptModel((call) => call === 0
      ? { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'sandbox_exec', { command: 'ls' })] }
      : { role: 'assistant', content: 'listed' });
    expect((await chat(String((await newConversation())._id), 'ls')).status).toBe('completed');
    expect(executed).toHaveLength(1);

    scriptModel((call) => call === 0
      ? { role: 'assistant', content: '', tool_calls: [toolCall('c9', 'sandbox_read_file', { path: '/a' })] }
      : { role: 'assistant', content: 'read' });
    expect((await chat(String((await newConversation())._id), 'read')).status).toBe('requires_action');
  });
});

describe('unattended callers', () => {
  const DENIED = 'This tool needs human approval and no approver is available in this run.';

  it('the default is deny: the tool never runs, the model reads an error result and the run goes on', async () => {
    await createAgent({ humanInTheLoop: HITL_ON }); // no `unattended` setting
    const model = scriptModel(oneToolScript('rm -rf /'));
    const id = String((await newConversation())._id);

    const response = await chat(id, 'clean up', { unattended: true });

    expect(response.status).toBe('completed');
    expect(response.required_action).toBeUndefined();
    expect(executed).toEqual([]); // never executed
    // The model was told, as a tool result, and answered from it.
    const toolResult = model.seen.at(-1)!.find((m) => m.role === 'tool');
    expect(String(toolResult?.content)).toContain(DENIED);
    expect(extractAnswer(response)).toContain(DENIED);
    expect(model.seen).toHaveLength(2);
    // No request was opened, nothing is parked.
    expect(await db.listAgentPendingActions(id)).toEqual([]);
    const conversation = await storedConversation(id);
    expect(conversation).toMatchObject({ runtimeStatus: 'idle', stopReason: 'end_turn' });
    expect((await db.findAgentConversationState(id))?.pausedSnapshot).toBeUndefined();
  });

  it('shows the denied call as a failed tool step and in the session events', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);

    await chat(id, 'list', { unattended: true });

    const assistant = (await storedConversation(id)).messages[1];
    expect(assistant.steps).toHaveLength(1);
    expect(assistant.steps?.[0]).toMatchObject({ name: 'sandbox_exec', status: 'error', args: { command: 'ls' } });
    expect(String(assistant.steps?.[0].output)).toContain(DENIED);

    const logged = await events(id);
    expect(logged.map((e) => e.type)).toEqual([
      'user.message', 'session.status_running', 'agent.tool_use', 'agent.tool_result',
      'agent.message', 'session.status_idle', 'session.work_done',
    ]);
    expect(logged.find((e) => e.type === 'agent.tool_use')?.data).toMatchObject({ name: 'sandbox_exec', args: { command: 'ls' } });
    expect(logged.find((e) => e.type === 'agent.tool_result')?.data).toMatchObject({
      name: 'sandbox_exec', ok: false, error: expect.stringContaining(DENIED),
    });
  });

  it('tools that would not have asked still run, and so does a tool allowed for the session', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel((call) => call === 0
      ? { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'sandbox_read_file', { path: '/etc/hosts' })] }
      : { role: 'assistant', content: 'read it' });
    expect((await chat(String((await newConversation())._id), 'show', { unattended: true })).status).toBe('completed');
    expect(executed).toEqual([{ tool: 'sandbox_read_file', args: { path: '/etc/hosts' } }]);

    executed.length = 0;
    scriptModel(oneToolScript('ls'));
    const allowed = String((await newConversation({ hitlAllowedTools: ['sandbox_exec'] }))._id);
    expect((await chat(allowed, 'list', { unattended: true })).status).toBe('completed');
    expect(executed).toEqual([{ tool: 'sandbox_exec', args: { command: 'ls' } }]);
  });

  it('does not offer the ask-user tool when nobody can answer; an attended run still does', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const unattendedModel = scriptModel(() => ({ role: 'assistant', content: 'ok' }));
    await chat(String((await newConversation())._id), 'hello', { unattended: true });
    expect(unattendedModel.offered.flat()).not.toContain('ask_user_question');

    const attendedModel = scriptModel(() => ({ role: 'assistant', content: 'ok' }));
    await chat(String((await newConversation())._id), 'hello');
    expect(attendedModel.offered.flat()).toContain('ask_user_question');
  });

  it('"pause" behaves like an attended run: an action is created and Studio can approve it later', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, unattended: 'pause' } });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);

    const response = await chat(id, 'list files', { unattended: true });

    expect(executed).toEqual([]);
    expect(response.status).toBe('requires_action');
    expect(response.required_action?.actions[0]).toMatchObject({ kind: 'tool_approval', tool_name: 'sandbox_exec', status: 'pending' });
    const [action] = await db.listAgentPendingActions(id, { status: 'pending' });
    expect(action.expiresAt).toBeTruthy(); // the usual timeout applies
    expect(await storedConversation(id)).toMatchObject({ runtimeStatus: 'requires_action', pendingActionIds: [String(action._id)] });

    const outcome = await resolve(id, String(action._id), { decision: 'allow' });
    expect(outcome.kind).toBe('resumed');
    expect(executed).toEqual([{ tool: 'sandbox_exec', args: { command: 'ls' } }]);
  });

  it('"pause" offers the ask-user tool too', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, unattended: 'pause' } });
    const model = scriptModel(() => ({ role: 'assistant', content: 'ok' }));
    await chat(String((await newConversation())._id), 'hello', { unattended: true });
    expect(model.offered.flat()).toContain('ask_user_question');
  });

  it('"allow" is the explicit opt-in to running gated tools with nobody approving: the tool runs, no action is created', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, unattended: 'allow' } });
    const model = scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);

    const response = await chat(id, 'list files', { unattended: true });

    expect(response.status).toBe('completed');
    expect(executed).toEqual([{ tool: 'sandbox_exec', args: { command: 'ls' } }]);
    expect(await db.listAgentPendingActions(id)).toEqual([]);
    expect(model.offered.flat()).not.toContain('ask_user_question');
  });

  it('an agent with no human-in-the-loop settings is unaffected by being unattended', async () => {
    await createAgent();
    scriptModel(oneToolScript('ls'));
    const response = await chat(String((await newConversation())._id), 'list', { unattended: true });
    expect(response.status).toBe('completed');
    expect(executed).toHaveLength(1);
  });

  it('an attended run ignores the unattended setting', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, unattended: 'allow' } });
    scriptModel(oneToolScript('ls'));
    expect((await chat(String((await newConversation())._id), 'list')).status).toBe('requires_action');
    expect(executed).toEqual([]);
  });

  it('a continuation that fails before the model runs re-opens the answer so it can be retried', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'list files');
    const actionId = paused.required_action!.actions[0].id;

    hoisted.buildGatewayChatModel.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(resolve(id, actionId, { decision: 'allow' })).rejects.toThrow('model unavailable');

    const [reopened] = await db.listAgentPendingActions(id, { status: 'pending' });
    expect(String(reopened._id)).toBe(actionId);
    expect(reopened.resolvedBy ?? null).toBeNull();
    expect(reopened.resolution ?? null).toBeNull();

    scriptModel(() => ({ role: 'assistant', content: 'done' }));
    expect((await resolve(id, actionId, { decision: 'allow' })).kind).toBe('resumed');
    expect(executed).toHaveLength(1);
  });
});

describe('resolving an approval', () => {
  it('(b) allow continues the SAME turn: the tool runs and the answer is a new assistant message', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const model = scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'list files');
    const actionId = paused.required_action!.actions[0].id;

    const outcome = await resolve(id, actionId, { decision: 'allow' });

    expect(outcome.kind).toBe('resumed');
    if (outcome.kind !== 'resumed') return;
    expect(executed).toEqual([{ tool: 'sandbox_exec', args: { command: 'ls' } }]);
    expect(outcome.response.status).toBe('completed');
    expect(outcome.result.content).toContain('done:');
    expect(outcome.result.content).toContain('ran ls');
    expect(outcome.result.steps?.map((step) => step.name)).toEqual(['sandbox_exec']);
    // The model was asked ONCE more, not asked to redo the turn.
    expect(model.seen).toHaveLength(2);

    const conversation = await storedConversation(id);
    expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(conversation.messages[1].pendingActions?.[0]).toMatchObject({ status: 'resolved', resolution: { decision: 'allow' } });
    expect(conversation.runtimeStatus).toBe('idle');
    expect(conversation.stopReason).toBe('end_turn');
    expect(conversation.pendingActionIds).toEqual([]);
    expect((await db.findAgentConversationState(id))?.pausedSnapshot).toBeUndefined();

    const action = await db.findAgentPendingActionById(actionId);
    expect(action).toMatchObject({ status: 'resolved', resolvedBy: OWNER, resolution: { decision: 'allow' } });

    const types = (await events(id)).map((e) => e.type);
    expect(types).toContain('action.resolved');
    expect(types.filter((t) => t === 'session.status_running')).toHaveLength(2);
    expect(types.at(-1)).toBe('session.work_done');
    await vi.waitFor(() => expect(hoisted.recordAuditLog).toHaveBeenCalledWith(
      { tenantDbName: DB_NAME, tenantId },
      expect.objectContaining({ event: 'agent.tool_approval.resolve', actorUserId: OWNER, resourceId: actionId }),
    ));
  });

  it('allow with edited arguments runs the tool with them', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('rm -rf /'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');

    const outcome = await resolve(id, paused.required_action!.actions[0].id, {
      decision: 'allow', approvedArgs: { command: 'ls' },
    });
    expect(outcome.kind).toBe('resumed');
    expect(executed).toEqual([{ tool: 'sandbox_exec', args: { command: 'ls' } }]);
  });

  it('edited arguments that break the tool schema are a 400-style refusal and the request stays open', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;

    const outcome = await resolve(id, actionId, { decision: 'allow', approvedArgs: { cmd: 'ls' } });
    expect(outcome.kind).toBe('invalid');
    expect((await db.findAgentPendingActionById(actionId))?.status).toBe('pending');
    expect(executed).toEqual([]);
  });

  it('(c) deny continues the turn without running the tool, and the model sees the refusal', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const model = scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'list files');

    const outcome = await resolve(id, paused.required_action!.actions[0].id, { decision: 'deny', comment: 'not on prod' });

    expect(outcome.kind).toBe('resumed');
    expect(executed).toEqual([]);
    const lastCall = model.seen.at(-1)!;
    const refusal = lastCall.find((m) => m.role === 'tool');
    expect(String(refusal?.content)).toContain('rejected');
    expect(String(refusal?.content)).toContain('not on prod');
    if (outcome.kind === 'resumed') expect(outcome.result.content).toContain('done:');
  });

  it('rememberForSession allows the tool for the rest of the session', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel((call, messages) => {
      // First turn: one call, then an answer. Second turn: the same call again.
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const turnTwo = String(lastUser?.content).includes('again');
      const hasToolResult = messages.some((m) => m.role === 'tool' && !String(m.content).includes('SUMMARIZED'));
      if (!hasToolResult || (turnTwo && messages.filter((m) => m.role === 'tool').length < 2)) {
        return { role: 'assistant', content: '', tool_calls: [toolCall(`c${call}`, 'sandbox_exec', { command: turnTwo ? 'second' : 'first' })] };
      }
      return { role: 'assistant', content: 'ok' };
    });
    const conversation = await newConversation();
    const id = String(conversation._id);
    const paused = await chat(id, 'first');
    const outcome = await resolve(id, paused.required_action!.actions[0].id, { decision: 'allow', rememberForSession: true });
    expect(outcome.kind).toBe('resumed');
    expect((await storedConversation(id)).metadata?.hitlAllowedTools).toEqual(['sandbox_exec']);

    const second = await chat(id, 'again');
    expect(second.status).toBe('completed'); // not asked a second time
    expect(executed.map((e) => e.args.command)).toEqual(['first', 'second']);
  });

  it('refuses an answer for an action that is already answered (409) or unknown (404)', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;

    expect((await resolve(id, actionId, { decision: 'allow' })).kind).toBe('resumed');
    expect(await resolve(id, actionId, { decision: 'allow' })).toMatchObject({ kind: 'not_pending', status: 'resolved' });
    expect((await resolve(id, 'act_missing', { decision: 'allow' })).kind).toBe('not_found');
    expect((await resolve('another-conversation', actionId, { decision: 'allow' })).kind).toBe('not_found');
  });

  it('a pause whose stored state is gone cannot be continued, and the session stops saying it is waiting', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    await db.deleteAgentConversationState(id);

    await expect(resolve(id, paused.required_action!.actions[0].id, { decision: 'allow' })).rejects.toMatchObject({
      name: 'AgentResumeError', status: 409,
    });
    expect(executed).toEqual([]);
    expect(await storedConversation(id)).toMatchObject({ runtimeStatus: 'idle', stopReason: 'error' });
    // The slot was released: a new message goes through.
    scriptModel(() => ({ role: 'assistant', content: 'hi' }));
    expect((await chat(id, 'hello')).status).toBe('completed');
  });

  it('answers 410 for a request that ran out of time', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, timeoutMinutes: 1 } });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;
    await db.updateAgentPendingAction(actionId, { expiresAt: new Date(Date.now() - 1000) });
    expect((await resolve(id, actionId, { decision: 'allow' })).kind).toBe('expired');
  });
});

describe('(d) a question to the user', () => {
  const questions = [{
    question: 'Which environment?',
    header: 'Env',
    options: [{ label: 'staging' }, { label: 'prod', description: 'careful' }],
  }];
  const askScript = (call: number, messages: Array<{ role: string; content: unknown }>): Reply => {
    if (call === 0) return { role: 'assistant', content: '', tool_calls: [toolCall('q1', 'ask_user_question', { questions })] };
    const answer = [...messages].reverse().find((m) => m.role === 'tool');
    return { role: 'assistant', content: `deploying to ${String(answer?.content)}` };
  };

  it('pauses with the questions, and the answer reaches the model as the tool result', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const model = scriptModel(askScript);
    const id = String((await newConversation())._id);

    const paused = await chat(id, 'deploy');
    expect(paused.status).toBe('requires_action');
    const action = paused.required_action!.actions[0];
    expect(action.kind).toBe('user_question');
    expect(action.questions?.[0]).toMatchObject({ question: 'Which environment?', header: 'Env' });
    expect(action.allow_free_text).toBe(true);

    const outcome = await resolve(id, action.id, { answers: { 'Which environment?': 'prod' } });
    expect(outcome.kind).toBe('resumed');
    const toolMessage = model.seen.at(-1)!.find((m) => m.role === 'tool');
    expect(String(toolMessage?.content)).toContain('answered');
    expect(String(toolMessage?.content)).toContain('prod');
    if (outcome.kind === 'resumed') expect(outcome.result.content).toContain('deploying to');
  });

  it('skipping (cancelled) still lets the turn continue', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const model = scriptModel(askScript);
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'deploy');
    const outcome = await resolve(id, paused.required_action!.actions[0].id, { cancelled: true });
    expect(outcome.kind).toBe('resumed');
    expect(String(model.seen.at(-1)!.find((m) => m.role === 'tool')?.content)).toContain('cancelled');
  });

  it('a free-text answer is refused when the agent turned free text off, and the question stays open', async () => {
    await createAgent({ humanInTheLoop: { askUser: { enabled: true, allowFreeText: false } } });
    scriptModel(askScript);
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'deploy');
    const actionId = paused.required_action!.actions[0].id;
    const outcome = await resolve(id, actionId, { answers: { 'Which environment?': 'somewhere else' } });
    expect(outcome.kind).toBe('invalid');
    expect((await db.findAgentPendingActionById(actionId))?.status).toBe('pending');
  });

  it('an answer body without answers is invalid', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(askScript);
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'deploy');
    expect((await resolve(id, paused.required_action!.actions[0].id, {})).kind).toBe('invalid');
  });
});

describe('(e) several requests', () => {
  it('two approval-needing calls in one reply are asked one by one', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel((call, messages) => {
      if (call === 0) {
        return {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall('c1', 'sandbox_exec', { command: 'one' }), toolCall('c2', 'sandbox_exec', { command: 'two' })],
        };
      }
      return { role: 'assistant', content: `ran ${messages.filter((m) => m.role === 'tool').length}` };
    });
    const id = String((await newConversation())._id);

    const first = await chat(id, 'do both');
    expect(first.required_action!.actions).toHaveLength(1);
    expect(first.required_action!.actions[0].args).toEqual({ command: 'one' });

    const afterFirst = await resolve(id, first.required_action!.actions[0].id, { decision: 'allow' });
    expect(afterFirst.kind).toBe('resumed');
    if (afterFirst.kind !== 'resumed') return;
    expect(executed.map((e) => e.args.command)).toEqual(['one']);
    // It paused AGAIN, on the second call.
    expect(afterFirst.response.status).toBe('requires_action');
    const second = afterFirst.response.required_action!.actions[0];
    expect(second.args).toEqual({ command: 'two' });
    expect((await storedConversation(id)).pendingActionIds).toEqual([second.id]);

    const afterSecond = await resolve(id, second.id, { decision: 'allow' });
    expect(afterSecond.kind).toBe('resumed');
    expect(executed.map((e) => e.args.command)).toEqual(['one', 'two']);
    expect((await storedConversation(id)).runtimeStatus).toBe('idle');
  });

  it('with several requests open in one pause, the turn waits for all of them', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const model = scriptModel((call) => call === 0
      ? {
        role: 'assistant',
        content: '',
        tool_calls: [toolCall('c1', 'sandbox_exec', { command: 'one' }), toolCall('c2', 'sandbox_exec', { command: 'two' })],
      }
      : { role: 'assistant', content: 'both done' });
    const id = String((await newConversation())._id);
    const first = await chat(id, 'do both');
    const firstAction = (await db.listAgentPendingActions(id, { status: 'pending' }))[0];

    // Put a second request into the same pause.
    const stored = (await db.findAgentConversationState(id))!;
    const paused = JSON.parse(stored.pausedSnapshot!);
    paused.state.pendingApprovals.push({
      id: 'sdk-second', toolCallId: 'c2', toolName: 'sandbox_exec', args: { command: 'two' }, status: 'pending',
      requestedAt: new Date().toISOString(),
    });
    await db.saveAgentConversationState({ ...stored, pausedSnapshot: JSON.stringify(paused) });
    const [secondAction] = await db.createAgentPendingActions([{
      tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, kind: 'tool_approval',
      sdkId: 'sdk-second', toolCallId: 'c2', toolName: 'sandbox_exec', args: { command: 'two' },
      status: 'pending', requestedAt: new Date(), createdBy: OWNER,
    }]);
    await db.updateAgentConversationRuntime(id, { pendingActionIds: [String(firstAction._id), String(secondAction._id)] });
    void first;

    const callsBefore = model.seen.length;
    const one = await resolve(id, String(firstAction._id), { decision: 'allow' });
    expect(one.kind).toBe('pending');
    if (one.kind === 'pending') expect(one.pendingActions.map((a) => a.id)).toEqual([String(secondAction._id)]);
    expect(model.seen.length).toBe(callsBefore); // nothing was invoked
    expect((await storedConversation(id)).pendingActionIds).toEqual([String(secondAction._id)]);

    const two = await resolve(id, String(secondAction._id), { decision: 'allow' });
    expect(two.kind).toBe('resumed');
    expect(executed.map((e) => e.args.command).sort()).toEqual(['one', 'two']);
  });
});

describe('(f) a new message while a request is open', () => {
  it('"reject" (the default) answers 409 pending_action and leaves the session waiting', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;
    const eventsBefore = (await events(id)).length;

    const error = await chat(id, 'actually, hello').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const classified = classifyAgentRunError(error);
    expect(classified.status).toBe(409);
    expect(classified.error).toMatchObject({ type: 'pending_action', pendingActionIds: [actionId] });

    const conversation = await storedConversation(id);
    expect(conversation.runtimeStatus).toBe('requires_action'); // not flipped to idle by the refusal
    expect(conversation.messages).toHaveLength(2);
    expect((await db.findAgentPendingActionById(actionId))?.status).toBe('pending');
    expect((await events(id)).length).toBe(eventsBefore); // no session.error written
  });

  it('"cancel_pending" cancels the request, drops the paused state and runs the message normally', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, onUserMessageWhilePending: 'cancel_pending' } });
    const model = scriptModel((call, messages) => {
      if (call === 0) return { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'sandbox_exec', { command: 'ls' })] };
      return { role: 'assistant', content: `fresh (${messages.some((m) => m.role === 'tool') ? 'saw tool' : 'no tool'})` };
    });
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;

    const next = await chat(id, 'never mind, say hi');
    expect(next.status).toBe('completed');
    expect(next.output.at(-1)).toMatchObject({ content: [{ text: 'fresh (no tool)' }] });
    expect(model.seen.at(-1)!.some((m) => m.tool_calls)).toBe(false); // the unanswered call was dropped

    expect(await db.findAgentPendingActionById(actionId)).toMatchObject({ status: 'cancelled' });
    const conversation = await storedConversation(id);
    expect(conversation.runtimeStatus).toBe('idle');
    expect(conversation.messages[1].pendingActions?.[0].status).toBe('cancelled');
    expect((await db.findAgentConversationState(id))?.pausedSnapshot).toBeUndefined();
    expect((await events(id)).some((e) => e.type === 'action.resolved' && (e.data as { cancelled?: boolean }).cancelled)).toBe(true);
    expect(executed).toEqual([]);
  });

  it('a session whose requests were all answered is not blocked even if its status is stale', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel((call) => ({ role: 'assistant', content: `hi ${call}` }));
    const conversation = await newConversation();
    const id = String(conversation._id);
    await db.updateAgentConversationRuntime(id, { runtimeStatus: 'requires_action', pendingActionIds: ['act_gone'] });
    expect((await chat(id, 'hello')).status).toBe('completed');
    expect((await storedConversation(id)).runtimeStatus).toBe('idle');
  });
});

describe('(g) back-compat: an agent without humanInTheLoop never pauses', () => {
  it('runs the tool straight away and writes none of the new fields', async () => {
    await createAgent(); // no humanInTheLoop
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const response = await chat(id, 'list');

    expect(response.status).toBe('completed');
    expect(response.required_action).toBeUndefined();
    expect(executed).toHaveLength(1);
    expect(await db.listAgentPendingActions(id)).toEqual([]);
    const conversation = await storedConversation(id);
    expect(conversation.messages.some((m) => m.pendingActions)).toBe(false);
    expect((await db.findAgentConversationState(id))?.pausedSnapshot).toBeUndefined();
  });

  it('toolApproval switched off ignores the per-tool table', async () => {
    await createAgent({ humanInTheLoop: { toolApproval: { enabled: false, tools: { sandbox_exec: 'always' } } } });
    scriptModel(oneToolScript('ls'));
    expect((await chat(String((await newConversation())._id), 'list')).status).toBe('completed');
    expect(executed).toHaveLength(1);
  });

  it('a stateless playground call has nowhere to park a pause, so a gated tool is denied (never silently run)', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const model = scriptModel(oneToolScript('ls'));
    const result = await executePlaygroundChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, userMessage: 'list',
    });
    expect(result.pendingActions).toBeUndefined();
    expect(result.stopReason).toBeUndefined();
    expect(executed).toEqual([]);
    expect(String(model.seen.at(-1)!.find((m) => m.role === 'tool')?.content)).toContain('no approver is available');
    expect(model.offered.flat()).not.toContain('ask_user_question');
  });

  it('a stateless playground call runs the tool only when the owner chose "allow"', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, unattended: 'allow' } });
    scriptModel(oneToolScript('ls'));
    await executePlaygroundChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, userMessage: 'list',
    });
    expect(executed).toHaveLength(1);
  });
});

describe('(h) who may answer', () => {
  async function pausedSession(humanInTheLoop = HITL_ON) {
    await createAgent({ humanInTheLoop });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    return { id, actionId: paused.required_action!.actions[0].id };
  }
  const stranger: ResolveActor = { userId: 'user-2', channel: 'dashboard' };

  it('asks the authorizer with the session, the request and the agent\'s own setting, and stops on a refusal', async () => {
    const { id, actionId } = await pausedSession();
    const asked: ApprovalRequest[] = [];
    expect(await resolve(id, actionId, { decision: 'allow' }, stranger, 'sync', refuseAndRecord(asked, 'dec-1')))
      .toMatchObject({ kind: 'forbidden', decisionId: 'dec-1' });
    // Asked about THIS session (who started it), THIS request (who raised it) and the setting the turn ran with.
    expect(asked).toHaveLength(1);
    expect(asked[0].conversation).toMatchObject({ _id: id, agentKey: AGENT_KEY, projectId: PROJECT_ID, createdBy: OWNER });
    expect(asked[0].action).toMatchObject({ _id: actionId, createdBy: OWNER });
    expect(asked[0].approvers).toBe('owner_or_admin');
    // A refused answer changes nothing: the request is still open and nothing ran.
    expect((await db.findAgentPendingActionById(actionId))?.status).toBe('pending');
    expect(executed).toEqual([]);
    expect(await storedConversation(id)).toMatchObject({ runtimeStatus: 'requires_action' });
    // ...and the reviewer the engine accepts still can.
    expect((await resolve(id, actionId, { decision: 'allow' }, stranger)).kind).toBe('resumed');
    expect((await db.findAgentPendingActionById(actionId))?.resolvedBy).toBe('user-2');
  });

  it.each(['owner', 'owner_or_admin', 'project_members'] as const)('hands the %s setting of the agent to the authorizer', async (approvers) => {
    const { id, actionId } = await pausedSession({ ...HITL_ON, approvers });
    const asked: ApprovalRequest[] = [];
    await resolve(id, actionId, { decision: 'allow' }, stranger, 'sync', refuseAndRecord(asked));
    expect(asked.map((request) => request.approvers)).toEqual([approvers]);
  });

  it('an engine outage answers nothing and leaves the request open - as a verdict, or as an error the authorizer throws', async () => {
    const { id, actionId } = await pausedSession();
    // the verdict form (what the route and portal authorizers return): the outcome is `unavailable`, never `forbidden`
    expect(await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync', async () => ({ allowed: false, unavailable: true, decisionId: 'dec-9' })))
      .toEqual({ kind: 'unavailable', decisionId: 'dec-9' });
    // the thrown form (a gate's 503, or an ApprovalUnavailableError): read the same way, the id kept when it names one
    const outage = Object.assign(new Error('Authorization is temporarily unavailable'), { status: 503 });
    expect(await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync', async () => { throw outage; })).toEqual({ kind: 'unavailable' });
    const named = Object.assign(new Error('unavailable'), { code: 'authorization_unavailable', decisionId: 'dec-10' });
    expect(await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync', async () => { throw named; })).toEqual({ kind: 'unavailable', decisionId: 'dec-10' });
    expect((await db.findAgentPendingActionById(actionId))?.status).toBe('pending');
    expect(executed).toEqual([]);
  });

  it('any other failure of the authorizer is a bug and propagates (nothing is recorded)', async () => {
    const { id, actionId } = await pausedSession();
    const bug = new Error('boom');
    await expect(resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync', async () => { throw bug; })).rejects.toBe(bug);
    expect((await db.findAgentPendingActionById(actionId))?.status).toBe('pending');
  });

  it('tells the authorizer what kind of request it is: an approval and a question are governed differently', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel((call) => (call === 0
      ? { role: 'assistant', content: '', tool_calls: [toolCall('q1', 'ask_user_question', { questions: [{ question: 'Which?', header: 'H', options: [{ label: 'a' }, { label: 'b' }] }] })] }
      : { role: 'assistant', content: 'done' }));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'ask');
    const asked: ApprovalRequest[] = [];
    await resolve(id, paused.required_action!.actions[0].id, { answers: { 'Which?': 'a' } }, stranger, 'sync', refuseAndRecord(asked));
    expect(asked).toHaveLength(1);
    expect(asked[0].action).toMatchObject({ kind: 'user_question', createdBy: OWNER });
  });

  it('uses the approvers setting of the agent VERSION the request was raised under, not the live config', async () => {
    const { id, actionId } = await pausedSession({ ...HITL_ON, approvers: 'project_members' });
    const agent = (await db.findAgentByKey(AGENT_KEY, PROJECT_ID))!;
    // version 1 (what the paused turn ran with) accepts only the starter; the live config was loosened since
    await db.createAgentVersion({
      tenantId, projectId: PROJECT_ID, agentId: String(agent._id), agentKey: AGENT_KEY, version: 1,
      snapshot: { name: 'Ops', config: { modelKey: 'gpt-4o', humanInTheLoop: { ...HITL_ON, approvers: 'owner' } }, status: 'active' },
      publishedBy: OWNER,
    });
    await db.updateAgentPendingAction(actionId, { agentVersion: 1 });
    const asked: ApprovalRequest[] = [];
    await resolve(id, actionId, { decision: 'allow' }, stranger, 'sync', refuseAndRecord(asked));
    expect(asked.map((request) => request.approvers)).toEqual(['owner']);
  });

  it('judges a request by the agent version it was raised under, and still can when the agent is gone', async () => {
    const { id, actionId } = await pausedSession({ ...HITL_ON, approvers: 'owner' });
    // the agent is deleted after the request was raised: the question is still decidable (the defaults apply)
    const agent = await db.findAgentByKey(AGENT_KEY, PROJECT_ID);
    await db.deleteAgent(String(agent!._id));
    const asked: ApprovalRequest[] = [];
    await resolve(id, actionId, { decision: 'allow' }, stranger, 'sync', refuseAndRecord(asked));
    expect(asked).toHaveLength(1);
    expect(asked[0].conversation).toMatchObject({ agentKey: AGENT_KEY, projectId: PROJECT_ID });
    expect(asked[0].approvers).toBe('owner_or_admin');
  });
});

describe('the read-only preflight (checkAgentPendingActionResolution)', () => {
  function check(
    conversationId: string,
    actionId: string,
    body: Record<string, unknown>,
    extra: { authorize?: ApprovalAuthorizer; agentKey?: string; projectId?: string } = {},
  ) {
    return checkAgentPendingActionResolution({
      tenantDbName: DB_NAME,
      tenantId,
      projectId: extra.projectId ?? PROJECT_ID,
      conversationId,
      actionId,
      agentKey: extra.agentKey,
      body,
      authorize: extra.authorize ?? allow,
      actor: ownerActor,
    });
  }

  async function paused(humanInTheLoop: NonNullable<IAgentConfig['humanInTheLoop']> = HITL_ON) {
    await createAgent({ humanInTheLoop });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const response = await chat(id, 'go');
    return { id, actionId: response.required_action!.actions[0].id };
  }

  it('is null for an answer that would go ahead, and changes nothing', async () => {
    const { id, actionId } = await paused();
    const eventsBefore = (await events(id)).length;
    const stateBefore = (await db.findAgentConversationState(id))?.pausedSnapshot;
    const modelCalls = hoisted.buildGatewayChatModel.mock.calls.length;

    expect(await check(id, actionId, { decision: 'allow' })).toBeNull();
    expect(await check(id, actionId, { decision: 'deny', comment: 'no' }, { agentKey: AGENT_KEY })).toBeNull();

    expect((await db.findAgentPendingActionById(actionId))?.status).toBe('pending');
    expect((await events(id)).length).toBe(eventsBefore);
    expect((await db.findAgentConversationState(id))?.pausedSnapshot).toBe(stateBefore);
    expect(await storedConversation(id)).toMatchObject({ runtimeStatus: 'requires_action' });
    expect(hoisted.buildGatewayChatModel.mock.calls.length).toBe(modelCalls);
    expect(executed).toEqual([]);
    // ...and the real answer still goes through afterwards.
    expect((await resolve(id, actionId, { decision: 'allow' })).kind).toBe('resumed');
  });

  it('says not_found for an unknown action, another conversation, another project or another agent', async () => {
    const { id, actionId } = await paused();
    expect(await check(id, 'act_missing', { decision: 'allow' })).toEqual({ kind: 'not_found' });
    expect(await check('another-conversation', actionId, { decision: 'allow' })).toEqual({ kind: 'not_found' });
    expect(await check(id, actionId, { decision: 'allow' }, { projectId: 'proj-other' })).toEqual({ kind: 'not_found' });
    expect(await check(id, actionId, { decision: 'allow' }, { agentKey: 'someone-else' })).toEqual({ kind: 'not_found' });
  });

  it('says not_pending once the action is answered', async () => {
    const { id, actionId } = await paused();
    expect((await resolve(id, actionId, { decision: 'allow' })).kind).toBe('resumed');
    expect(await check(id, actionId, { decision: 'allow' })).toEqual({ kind: 'not_pending', status: 'resolved' });
  });

  it('says expired when the time of the request is up', async () => {
    const { id, actionId } = await paused({ ...HITL_ON, timeoutMinutes: 1 });
    await db.updateAgentPendingAction(actionId, { expiresAt: new Date(Date.now() - 1000) });
    expect(await check(id, actionId, { decision: 'allow' })).toEqual({ kind: 'expired' });
  });

  it('says forbidden for someone the approvers setting leaves out', async () => {
    const { id, actionId } = await paused();
    const asked: ApprovalRequest[] = [];
    expect(await check(id, actionId, { decision: 'allow' }, { authorize: refuseAndRecord(asked, 'dec-2') })).toMatchObject({ kind: 'forbidden', decisionId: 'dec-2' });
    expect(asked[0]).toMatchObject({ approvers: 'owner_or_admin', conversation: { createdBy: OWNER } });
    expect(await check(id, actionId, { decision: 'allow' })).toBeNull();
  });

  it('says invalid for a body the resolve flow would refuse', async () => {
    const { id, actionId } = await paused();
    expect(await check(id, actionId, {})).toMatchObject({ kind: 'invalid' });
    expect(await check(id, actionId, { decision: 'maybe' })).toMatchObject({ kind: 'invalid' });
  });

  it('checks the answers of a question against the agent free-text setting', async () => {
    await createAgent({ humanInTheLoop: { askUser: { enabled: true, allowFreeText: false } } });
    const questions = [{ question: 'Which environment?', options: [{ label: 'staging' }, { label: 'prod' }] }];
    scriptModel((call) => call === 0
      ? { role: 'assistant', content: '', tool_calls: [toolCall('q1', 'ask_user_question', { questions })] }
      : { role: 'assistant', content: 'ok' });
    const id = String((await newConversation())._id);
    const actionId = (await chat(id, 'deploy')).required_action!.actions[0].id;

    expect(await check(id, actionId, { answers: { 'Which environment?': 'somewhere else' } })).toMatchObject({ kind: 'invalid' });
    expect(await check(id, actionId, { answers: { 'Which environment?': 'prod' } })).toBeNull();
    expect(await check(id, actionId, { cancelled: true })).toBeNull();
  });
});

describe('timeouts', () => {
  const expire = async (actionId: string) => {
    await db.updateAgentPendingAction(actionId, { expiresAt: new Date(Date.now() - 60_000) });
  };

  it('onTimeout "cancel" expires the request and sets the session idle again', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, onTimeout: 'cancel' } });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;
    await expire(actionId);

    const swept = await sweepExpiredPendingActions(db, DB_NAME, new Date());
    expect(swept).toMatchObject({ expired: 1, denied: 0, continued: 0 });
    expect(await db.findAgentPendingActionById(actionId)).toMatchObject({ status: 'expired' });
    const conversation = await storedConversation(id);
    expect(conversation).toMatchObject({ runtimeStatus: 'idle', stopReason: 'cancelled', pendingActionIds: [] });
    expect(conversation.messages[1].pendingActions?.[0].status).toBe('expired');
    const logged = await events(id);
    expect(logged.find((e) => e.type === 'action.resolved')?.data).toMatchObject({ expired: true, channel: 'timeout' });
    expect(logged.at(-1)).toMatchObject({ type: 'session.status_idle', data: { stopReason: 'cancelled' } });
    expect(hoisted.publish).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    // the system ended it, outside the policy engine - and the audit trail says so (not as a person)
    await vi.waitFor(() => expect(hoisted.recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tenantDbName: DB_NAME }),
      expect.objectContaining({
        actorType: 'system', actorUserId: 'system:timeout', event: 'agent.tool_approval.timeout', resourceId: actionId,
        metadata: expect.objectContaining({ channel: 'timeout', status: 'expired', cancelled: true }),
      }),
    ));
  });

  it('onTimeout "deny" (default) denies and continues the turn as a background job', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    const model = scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;
    await expire(actionId);

    const swept = await sweepExpiredPendingActions(db, DB_NAME, new Date());
    expect(swept).toMatchObject({ expired: 0, denied: 1, continued: 1 });
    expect(await db.findAgentPendingActionById(actionId)).toMatchObject({
      status: 'resolved', resolvedBy: 'system:timeout', resolution: { decision: 'deny', comment: 'timed out' },
    });
    await vi.waitFor(() => expect(hoisted.recordAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'system', actorUserId: 'system:timeout', event: 'agent.tool_approval.timeout',
        metadata: expect.objectContaining({ decision: 'deny', status: 'resolved' }),
      }),
    ));

    const [, jobName, payload] = hoisted.publish.mock.calls.find((call) => call[1] === 'resume')!;
    expect(jobName).toBe('resume');
    const { runId } = payload as { runId: string };

    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const run = await db.getAgentRunById(runId, tenantId, PROJECT_ID);
    expect(run?.status).toBe('succeeded');
    expect(run?.stopReason).toBe('end_turn');
    expect(executed).toEqual([]); // denied
    expect(String(model.seen.at(-1)!.find((m) => m.role === 'tool')?.content)).toContain('timed out');
    const conversation = await storedConversation(id);
    expect(conversation.messages).toHaveLength(3);
    expect(conversation.runtimeStatus).toBe('idle');
    expect((await events(id)).find((e) => e.type === 'session.status_running' && (e.data as { trigger?: string }).trigger === 'timeout')).toBeTruthy();
  });

  it('timeoutMinutes 0 never expires', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, timeoutMinutes: 0 } });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const action = await db.findAgentPendingActionById(paused.required_action!.actions[0].id);
    expect(action?.expiresAt ?? null).toBeNull();
    expect(await sweepExpiredPendingActions(db, DB_NAME, new Date(Date.now() + 10 * 365 * 86_400_000))).toMatchObject({ expired: 0, denied: 0 });
  });
});

describe('background runs', () => {
  it('a run that pauses is requires_action (not terminal); answering queues it again and it finishes', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const conversation = await newConversation();
    const id = String(conversation._id);
    const created = await queueAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'list files', userId: OWNER,
      callbackUrl: 'https://example.com/hook',
    });
    if (created.kind !== 'accepted') throw new Error(created.kind);
    const runId = String(created.run._id);

    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const paused = (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;
    expect(paused.status).toBe('requires_action');
    expect(paused.stopReason).toBe('requires_action');
    expect(serializeAgentRun(paused)).toMatchObject({ status: 'requires_action', stop_reason: 'requires_action' });
    const body = serializeAgentRun(paused).result as { status: string; required_action: { actions: Array<{ id: string }> } };
    expect(body.status).toBe('requires_action');
    expect(hoisted.publish.mock.calls.some((call) => call[1] === 'callback'
      && (call[2] as { event: string }).event === 'requires_action')).toBe(true);
    // The pause freed the conversation's run slot.
    const reservation = await db.createAgentRun({
      mode: 'sync', tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'x', status: 'running', callbackAttempts: 0,
    });
    await db.deleteAgentRun(String(reservation._id));

    const outcome = await resolve(id, body.required_action.actions[0].id, { decision: 'allow' }, ownerActor, 'background');
    expect(outcome.kind).toBe('queued');
    if (outcome.kind !== 'queued') return;
    expect(String(outcome.run._id)).toBe(runId); // the same run, queued again
    expect(outcome.run.status).toBe('queued');
    expect(hoisted.publish.mock.calls.some((call) => call[1] === 'resume' && (call[2] as { runId: string }).runId === runId)).toBe(true);

    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const done = (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;
    expect(done.status).toBe('succeeded');
    expect(done.stopReason).toBe('end_turn');
    expect(executed).toHaveLength(1);
    expect((await storedConversation(id)).messages).toHaveLength(3);
  });

  describe('a trigger run with external content (§2.4a)', () => {
    const SECRET = 'NORTHPOLE7';
    const systemTexts = (model: ScriptedModel) => model.seen.flatMap((messages) => messages.filter((m) => m.role === 'system').map((m) => String(m.content)));
    const triggerAgent = () => createAgent({
      systemPrompt: 'Serve region {{variables.region}}.',
      variables: [{ name: 'region', type: 'string' }],
      humanInTheLoop: { ...HITL_ON, unattended: 'pause' },
    });
    const startPaused = async (id: string, external: boolean, extra: { variables?: Record<string, unknown>; literalVariables?: string[] } = {}) => {
      const created = await queueAgentRun({
        tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
        conversationId: id, userMessage: 'list files', userId: 'system:trigger:trg1', actorType: 'system',
        channel: 'trigger', triggerId: 'trg1', trigger: 'manual', unattended: true, variables: extra.variables ?? { region: SECRET },
        ...(external ? { externalContent: true } : {}),
        ...(extra.literalVariables ? { literalVariables: extra.literalVariables } : {}),
      });
      if (created.kind !== 'accepted') throw new Error(created.kind);
      await runAgentJobLocal({ runId: String(created.run._id), tenantId, tenantDbName: DB_NAME });
      const [action] = await db.listAgentPendingActions(id, { status: 'pending' });
      return { runId: String(created.run._id), actionId: String(action._id) };
    };

    it('answered from the dashboard (inline), the continuation keeps the input out of the system prompt', async () => {
      await triggerAgent();
      const model = scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { actionId } = await startPaused(id, true);

      const outcome = await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync');
      expect(outcome.kind).toBe('resumed');
      expect(model.seen).toHaveLength(2);
      expect(systemTexts(model).length).toBeGreaterThan(0);
      for (const text of systemTexts(model)) expect(text).not.toContain(SECRET);
    });

    it('answered from the dashboard, the paused run\'s own external-content mark keeps the input out even when the paused state carries no flag', async () => {
      await triggerAgent();
      const model = scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { runId, actionId } = await startPaused(id, true);
      // The stored paused state remembers the flag; take it out so only the run row's mark is left to carry it.
      const stored = (await db.findAgentConversationState(id))!;
      const envelope = JSON.parse(stored.pausedSnapshot!);
      expect(envelope.turn.variablesInPrompt).toBe(false);
      delete envelope.turn.variablesInPrompt;
      await db.saveAgentConversationState({ ...stored, pausedSnapshot: JSON.stringify(envelope) });
      expect((await db.getAgentRunById(runId, tenantId, PROJECT_ID))?.externalContent).toBe(true);

      const outcome = await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync');
      expect(outcome.kind).toBe('resumed');
      expect(model.seen).toHaveLength(2);
      for (const text of systemTexts(model)) expect(text).not.toContain(SECRET);
    });

    it('answered in the background (worker resume), the same holds', async () => {
      await triggerAgent();
      const model = scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { runId, actionId } = await startPaused(id, true);

      const outcome = await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'background');
      expect(outcome.kind).toBe('queued');
      await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
      expect((await db.getAgentRunById(runId, tenantId, PROJECT_ID))?.status).toBe('succeeded');
      expect(model.seen).toHaveLength(2);
      for (const text of systemTexts(model)) expect(text).not.toContain(SECRET);
    });

    it('without external content the input is a prompt variable as usual (the check above is meaningful)', async () => {
      await triggerAgent();
      const model = scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { actionId } = await startPaused(id, false);
      await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync');
      expect(systemTexts(model).every((text) => text.includes(SECRET))).toBe(true);
    });

    describe('what the trigger fixed itself still fills the prompt: the declared defaults and its literal values, never the event\'s', () => {
      const EVENT_MODE = 'EVENTMODE9';
      const RENDERED = 'Serve region  for platform in careful mode.';
      const mixedAgent = () => createAgent({
        systemPrompt: 'Serve region {{variables.region}} for {{variables.team}} in {{variables.mode}} mode.',
        variables: [
          { name: 'region', type: 'string' },
          { name: 'team', type: 'string' },
          { name: 'mode', type: 'string', default: 'careful' },
        ],
        humanInTheLoop: { ...HITL_ON, unattended: 'pause' },
      });
      // region and mode came from the event; team is a fixed value of the trigger.
      const startMixed = (id: string) => startPaused(id, true, {
        variables: { region: SECRET, team: 'platform', mode: EVENT_MODE },
        literalVariables: ['team'],
      });
      const expectOnlyOwnValues = (model: ScriptedModel, turns: number) => {
        expect(model.seen).toHaveLength(turns);
        const texts = systemTexts(model);
        expect(texts).toHaveLength(turns);
        for (const text of texts) {
          expect(text).toContain(RENDERED);
          expect(text).not.toContain(SECRET);
          expect(text).not.toContain(EVENT_MODE);
        }
      };

      it('on the first turn and after an inline answer', async () => {
        await mixedAgent();
        const model = scriptModel(oneToolScript('ls'));
        const id = String((await newConversation())._id);
        const { actionId } = await startMixed(id);
        expect((await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync')).kind).toBe('resumed');
        expectOnlyOwnValues(model, 2);
      });

      it('the paused state keeps the literal names; the run row carries them when the stored state does not', async () => {
        await mixedAgent();
        const model = scriptModel(oneToolScript('ls'));
        const id = String((await newConversation())._id);
        const { runId, actionId } = await startMixed(id);
        const stored = (await db.findAgentConversationState(id))!;
        const envelope = JSON.parse(stored.pausedSnapshot!);
        expect(envelope.turn).toMatchObject({ variablesInPrompt: false, literalVariables: ['team'] });
        delete envelope.turn.literalVariables;
        await db.saveAgentConversationState({ ...stored, pausedSnapshot: JSON.stringify(envelope) });
        expect((await db.getAgentRunById(runId, tenantId, PROJECT_ID))?.literalVariables).toEqual(['team']);

        expect((await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync')).kind).toBe('resumed');
        expectOnlyOwnValues(model, 2);
      });

      it('after a background answer (worker resume)', async () => {
        await mixedAgent();
        const model = scriptModel(oneToolScript('ls'));
        const id = String((await newConversation())._id);
        const { runId, actionId } = await startMixed(id);
        expect((await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'background')).kind).toBe('queued');
        await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
        expect((await db.getAgentRunById(runId, tenantId, PROJECT_ID))?.status).toBe('succeeded');
        expectOnlyOwnValues(model, 2);
      });

      it('a run that fixed nothing reads only the declared defaults', async () => {
        await mixedAgent();
        const model = scriptModel(oneToolScript('ls'));
        const id = String((await newConversation())._id);
        const { actionId } = await startPaused(id, true, { variables: { region: SECRET, team: 'from-event', mode: EVENT_MODE } });
        await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'sync');
        const texts = systemTexts(model);
        expect(texts).toHaveLength(2);
        for (const text of texts) {
          expect(text).toContain('Serve region  for  in careful mode.');
          expect(text).not.toContain('from-event');
          expect(text).not.toContain(SECRET);
        }
      });
    });
  });

  it('answering a paused background run inline settles its run row', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const created = await queueAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'list files', userId: OWNER,
    });
    if (created.kind !== 'accepted') throw new Error(created.kind);
    const runId = String(created.run._id);
    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const [action] = await db.listAgentPendingActions(id, { status: 'pending' });

    const outcome = await resolve(id, String(action._id), { decision: 'allow' }, ownerActor, 'sync');
    expect(outcome.kind).toBe('resumed');
    expect((await db.getAgentRunById(runId, tenantId, PROJECT_ID))?.status).toBe('succeeded');
  });

  it('cancelling a paused run ends it and drops the open request', async () => {
    const { requestAgentRunCancellation } = await import('@/lib/services/agents/agentRunService');
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const created = await queueAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'list files', userId: OWNER,
    });
    if (created.kind !== 'accepted') throw new Error(created.kind);
    const runId = String(created.run._id);
    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const [action] = await db.listAgentPendingActions(id, { status: 'pending' });

    const outcome = await requestAgentRunCancellation(DB_NAME, tenantId, PROJECT_ID, runId);
    expect(outcome.kind).toBe('accepted');
    expect((await db.getAgentRunById(runId, tenantId, PROJECT_ID))?.status).toBe('canceled');
    expect((await db.findAgentPendingActionById(String(action._id)))?.status).toBe('cancelled');
    expect((await storedConversation(id)).runtimeStatus).toBe('idle');
  });

  it('cancelling a paused run is written to the log and sent to the webhook subscribers, like a request cancelled by a new message', async () => {
    const { requestAgentRunCancellation } = await import('@/lib/services/agents/agentRunService');
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const created = await queueAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'list files', userId: OWNER,
    });
    if (created.kind !== 'accepted') throw new Error(created.kind);
    const runId = String(created.run._id);
    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const [action] = await db.listAgentPendingActions(id, { status: 'pending' });
    const before = (await events(id)).map((e) => e.type);
    expect(before.at(-1)).toBe('session.status_idle'); // idle(requires_action): what a consumer last saw
    hoisted.publishWebhook.mockClear();

    await requestAgentRunCancellation(DB_NAME, tenantId, PROJECT_ID, runId);

    const logged = await events(id);
    const fresh = logged.slice(before.length);
    expect(fresh.map((e) => e.type)).toEqual(['action.resolved', 'session.status_idle']);
    expect(fresh[0].data).toMatchObject({ actionId: String(action._id), kind: 'tool_approval', cancelled: true, resolvedBy: 'system:run_cancelled' });
    expect(fresh[1].data).toEqual({ stopReason: 'cancelled' });
    expect(fresh.every((e) => e.runId === runId)).toBe(true);
    // The seqs carry on from the log, and the session's stamp is the last one.
    expect(fresh.map((e) => e.seq)).toEqual([before.length + 1, before.length + 2]);
    expect(await storedConversation(id)).toMatchObject({
      runtimeStatus: 'idle', stopReason: 'cancelled', pendingActionIds: [], lastEventSeq: logged.at(-1)!.seq,
    });
    expect(await db.findAgentPendingActionById(String(action._id))).toMatchObject({ status: 'cancelled', resolvedBy: 'system:run_cancelled' });
    expect((await storedConversation(id)).messages[1].pendingActions?.[0].status).toBe('cancelled');
    // ...and the subscribers: session.idled(cancelled), then the run's own agent_run.canceled.
    const hooks = hoisted.publishWebhook.mock.calls.map((call) => call[0] as { type: string; data: Record<string, unknown> });
    expect(hooks.map((h) => h.type)).toEqual(['session.idled', 'agent_run.canceled']);
    expect(hooks[0].data).toMatchObject({ conversationId: id, stopReason: 'cancelled' });
    // A late answer is refused for what it is.
    const late = await resolve(id, String(action._id), { decision: 'allow' });
    expect(late).toEqual({ kind: 'not_pending', status: 'cancelled' });
  });

  it('cancelling a stale paused run does not reset a session a newer message has already moved on', async () => {
    const { requestAgentRunCancellation } = await import('@/lib/services/agents/agentRunService');
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const created = await queueAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'list files', userId: OWNER,
    });
    if (created.kind !== 'accepted') throw new Error(created.kind);
    const runId = String(created.run._id);
    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    // A newer turn is running on the conversation now.
    await db.updateAgentConversationRuntime(id, { runtimeStatus: 'running' });
    const eventsBefore = (await events(id)).length;

    await requestAgentRunCancellation(DB_NAME, tenantId, PROJECT_ID, runId);

    expect((await db.getAgentRunById(runId, tenantId, PROJECT_ID))?.status).toBe('canceled');
    expect((await storedConversation(id)).runtimeStatus).toBe('running');
    expect(await events(id)).toHaveLength(eventsBefore);
  });
});

describe('who resolved it: the channel rides on the event', () => {
  it('a portal resolution is told apart from a Studio one in the log and the audit entry', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const paused = await chat(id, 'go');
    const portalUser: ResolveActor = { userId: OWNER, channel: 'portal' };

    const outcome = await resolve(id, paused.required_action!.actions[0].id, { decision: 'allow' }, portalUser);

    expect(outcome.kind).toBe('resumed');
    const resolved = (await events(id)).find((e) => e.type === 'action.resolved');
    expect(resolved?.data).toMatchObject({ resolvedBy: OWNER, channel: 'portal', decision: 'allow' });
    await vi.waitFor(() => expect(hoisted.recordAuditLog).toHaveBeenCalledWith(
      { tenantDbName: DB_NAME, tenantId },
      expect.objectContaining({ metadata: expect.objectContaining({ channel: 'portal' }) }),
    ));
  });
});

describe('session playground path', () => {
  it('pauses a dashboard session turn, with pendingActions on the result and message, and resolves it', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const conversation = await newConversation({ source: 'console' });
    const id = String(conversation._id);

    const result = await executePlaygroundChatLocal({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      userMessage: 'list', conversationId: id,
      runtimeContext: { userId: OWNER, source: 'playground' } as never,
    });
    expect(result.stopReason).toBe('paused');
    expect(result.pendingActions).toHaveLength(1);
    expect(result.pendingActions?.[0]).toMatchObject({ kind: 'tool_approval', toolName: 'sandbox_exec', status: 'pending' });
    expect(executed).toEqual([]);
    const after = await storedConversation(id);
    expect(after.runtimeStatus).toBe('requires_action');
    expect(after.messages[1].pendingActions).toHaveLength(1);

    const outcome = await resolve(id, result.pendingActions![0].id, { decision: 'allow' });
    expect(outcome.kind).toBe('resumed');
    expect(executed).toHaveLength(1);
    const finished = await storedConversation(id);
    expect(finished.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(finished.runtimeStatus).toBe('idle');
  });
});

describe('the pending action as stored', () => {
  it('lists open actions through the database contract', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    await chat(id, 'go');
    const open: IAgentPendingAction[] = await db.listAgentPendingActions(id, { status: 'pending' });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, kind: 'tool_approval' });
  });
});

describe('a paused run follows its pause', () => {
  const callbackJobs = () => hoisted.publish.mock.calls
    .filter((call) => call[1] === 'callback')
    .map((call) => call[2] as { runId: string; event: string });
  const webhookTypes = () => hoisted.publishWebhook.mock.calls.map(([input]) => (input as { type: string }).type);
  const expire = (actionId: string) => db.updateAgentPendingAction(actionId, { expiresAt: new Date(Date.now() - 60_000) });

  /** A queued run (with a callback) that paused on one approval. */
  const pausedQueuedRun = async (id: string) => {
    const created = await queueAgentRun({
      tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'list files', userId: OWNER, callbackUrl: 'https://example.com/hook',
    });
    if (created.kind !== 'accepted') throw new Error(created.kind);
    const runId = String(created.run._id);
    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    const [action] = await db.listAgentPendingActions(id, { status: 'pending' });
    expect(action.runId).toBe(runId);
    hoisted.publish.mockClear();
    hoisted.publishWebhook.mockClear();
    return { runId, actionId: String(action._id) };
  };

  /** A run row left paused on the conversation by an earlier turn, owned by somebody else. */
  const stalePausedRun = async (id: string) => {
    const run = await db.createAgentRun({
      mode: 'background', tenantId, tenantDbName: DB_NAME, projectId: PROJECT_ID, agentKey: AGENT_KEY,
      conversationId: id, userMessage: 'earlier', status: 'running', callbackAttempts: 0,
      userId: 'user-a', callbackUrl: 'https://a.example/cb',
    });
    await db.finalizeAgentRun(String(run._id), tenantId, { status: 'requires_action', stopReason: 'requires_action' });
    return String(run._id);
  };
  const statusOf = async (runId: string) => (await db.getAgentRunById(runId, tenantId, PROJECT_ID))!;

  it('a new message that drops the pause (cancel_pending) ends the paused run canceled, with its callback and webhook event', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, onUserMessageWhilePending: 'cancel_pending' } });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const { runId } = await pausedQueuedRun(id);

    await chat(id, 'never mind, say hi');

    expect(await statusOf(runId)).toMatchObject({ status: 'canceled', errorReason: 'canceled_by_caller', stopReason: 'cancelled' });
    expect(callbackJobs()).toEqual([expect.objectContaining({ runId, event: 'canceled' })]);
    expect(webhookTypes()).toContain('agent_run.canceled');
  });

  it('a session truncate that drops the pause ends the paused run canceled, with its callback', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const { runId } = await pausedQueuedRun(id);

    await truncateSessionAfterMessage({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, conversationId: id, keepThrough: -1,
      actor: { userId: OWNER, channel: 'api' },
    });

    expect(await statusOf(runId)).toMatchObject({ status: 'canceled', errorReason: 'canceled_by_caller' });
    expect(callbackJobs()).toEqual([expect.objectContaining({ runId, event: 'canceled' })]);
  });

  it('a timeout that cancels the pause (onTimeout "cancel") fires the run callback and the agent_run.canceled event', async () => {
    await createAgent({ humanInTheLoop: { ...HITL_ON, onTimeout: 'cancel' } });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const { runId, actionId } = await pausedQueuedRun(id);
    await expire(actionId);

    expect(await sweepExpiredPendingActions(db, DB_NAME, new Date())).toMatchObject({ expired: 1 });

    expect(await statusOf(runId)).toMatchObject({ status: 'canceled', stopReason: 'cancelled' });
    expect(callbackJobs()).toEqual([expect.objectContaining({ runId, event: 'canceled' })]);
    expect(webhookTypes()).toContain('agent_run.canceled');
  });

  it('answered inline, the continuation is the paused run\'s: it settles only that run, writes its events with the run id and answers resp_<runId>', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const stale = await stalePausedRun(id);
    const { runId, actionId } = await pausedQueuedRun(id);

    const outcome = await resolve(id, actionId, { decision: 'allow' });
    expect(outcome.kind).toBe('resumed');
    if (outcome.kind !== 'resumed') return;
    expect(outcome.runId).toBe(runId);
    expect(outcome.response.id).toBe(`resp_${runId}`);

    expect(await statusOf(runId)).toMatchObject({ status: 'succeeded' });
    // The other paused row is not this pause's: it is neither settled nor sent this run's answer.
    expect(await statusOf(stale)).toMatchObject({ status: 'requires_action' });
    expect(callbackJobs().map((job) => job.runId)).toEqual([runId]);

    const runEvents = await db.listAgentSessionEvents(id, { runId });
    expect(runEvents.map((event) => event.type)).toContain('agent.tool_result');
    expect(runEvents.filter((event) => event.type === 'session.status_idle').at(-1)?.data).toMatchObject({ stopReason: 'end_turn' });
  });

  describe('the answer to a pause is in the paused run\'s own event stream: its events do not skip it', () => {
    /** The run's events and the session's, in order: a session with one run has nothing outside it. */
    const logs = async (id: string, runId: string) => {
      const run = await db.listAgentSessionEvents(id, { runId });
      const session = await db.listAgentSessionEvents(id);
      return { run, session, types: run.map((event) => event.type) };
    };

    it('answered inline: the pause, the answer, then the continuation', async () => {
      await createAgent({ humanInTheLoop: HITL_ON });
      scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { runId, actionId } = await pausedQueuedRun(id);

      expect((await resolve(id, actionId, { decision: 'allow' })).kind).toBe('resumed');

      const { run, session, types } = await logs(id, runId);
      const required = types.indexOf('action.required');
      const resolved = types.indexOf('action.resolved');
      expect(required).toBeGreaterThanOrEqual(0);
      expect(resolved).toBeGreaterThan(required);
      expect(types.indexOf('session.status_running', resolved)).toBeGreaterThan(resolved);
      expect(run[resolved].data).toMatchObject({ actionId, kind: 'tool_approval', decision: 'allow', resolvedBy: OWNER, channel: 'api' });
      expect(run.map((event) => event.seq)).toEqual(session.map((event) => event.seq));
    });

    it('answered in the background: the worker\'s continuation follows the answer in the same stream', async () => {
      await createAgent({ humanInTheLoop: HITL_ON });
      scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { runId, actionId } = await pausedQueuedRun(id);

      expect((await resolve(id, actionId, { decision: 'deny' }, ownerActor, 'background')).kind).toBe('queued');
      await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });

      const { run, session, types } = await logs(id, runId);
      const resolved = types.indexOf('action.resolved');
      expect(resolved).toBeGreaterThan(types.indexOf('action.required'));
      expect(types.indexOf('session.status_running', resolved)).toBeGreaterThan(resolved);
      expect(run[resolved].data).toMatchObject({ actionId, decision: 'deny' });
      expect(run.map((event) => event.seq)).toEqual(session.map((event) => event.seq));
    });

    it('a request that timed out and was denied: the timeout is in the stream before the run goes on', async () => {
      await createAgent({ humanInTheLoop: HITL_ON });
      scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { runId, actionId } = await pausedQueuedRun(id);
      await expire(actionId);

      expect(await sweepExpiredPendingActions(db, DB_NAME, new Date())).toMatchObject({ denied: 1, continued: 1 });
      await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });

      const { run, session, types } = await logs(id, runId);
      const resolved = types.indexOf('action.resolved');
      expect(resolved).toBeGreaterThan(types.indexOf('action.required'));
      expect(types.indexOf('session.status_running', resolved)).toBeGreaterThan(resolved);
      expect(run[resolved].data).toMatchObject({ actionId, expired: true, channel: 'timeout', resolvedBy: 'system:timeout' });
      expect(run.map((event) => event.seq)).toEqual(session.map((event) => event.seq));
    });

    it('a request that timed out and ended the pause: the stream says so and then goes idle, once', async () => {
      await createAgent({ humanInTheLoop: { ...HITL_ON, onTimeout: 'cancel' } });
      scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const { runId, actionId } = await pausedQueuedRun(id);
      await expire(actionId);

      expect(await sweepExpiredPendingActions(db, DB_NAME, new Date())).toMatchObject({ expired: 1 });

      const { run, session, types } = await logs(id, runId);
      expect(types.slice(-2)).toEqual(['action.resolved', 'session.status_idle']);
      expect(run.at(-2)?.data).toMatchObject({ actionId, expired: true, cancelled: true, channel: 'timeout' });
      expect(run.at(-1)?.data).toEqual({ stopReason: 'cancelled' });
      expect(run.filter((event) => event.type === 'session.status_idle' && (event.data as { stopReason?: string }).stopReason === 'cancelled')).toHaveLength(1);
      expect(run.map((event) => event.seq)).toEqual(session.map((event) => event.seq));
    });

    it('a pause no run owns (a dashboard turn) keeps its answer outside every run, as before', async () => {
      await createAgent({ humanInTheLoop: HITL_ON });
      scriptModel(oneToolScript('ls'));
      const id = String((await newConversation())._id);
      const paused = await chat(id, 'go');

      expect((await resolve(id, paused.required_action!.actions[0].id, { decision: 'allow' })).kind).toBe('resumed');

      const resolved = (await events(id)).find((event) => event.type === 'action.resolved');
      expect(resolved).toBeDefined();
      expect(resolved?.runId).toBeUndefined();
    });
  });

  it('answered with another request of the pause still open, the answer names the paused run', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const { runId, actionId } = await pausedQueuedRun(id);
    // A second request of the same pause, still open.
    await db.createAgentPendingActions([{
      tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, runId, kind: 'tool_approval',
      sdkId: 'sdk-second', toolCallId: 'c2', toolName: 'sandbox_exec', args: { command: 'two' },
      status: 'pending', requestedAt: new Date(), createdBy: OWNER,
    }]);

    const outcome = await resolve(id, actionId, { decision: 'allow' });
    expect(outcome).toMatchObject({ kind: 'pending', runId });
  });

  it('a pause no run owns (a dashboard turn) is continued by a new run, never by another paused row of the session', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const stale = await stalePausedRun(id);
    const paused = await chat(id, 'go');
    const actionId = paused.required_action!.actions[0].id;

    const outcome = await resolve(id, actionId, { decision: 'allow' }, ownerActor, 'background');
    expect(outcome.kind).toBe('queued');
    if (outcome.kind !== 'queued') return;
    expect(String(outcome.run._id)).not.toBe(stale);
    expect(outcome.run.userId).toBe(OWNER);
    expect(await statusOf(stale)).toMatchObject({ status: 'requires_action', userId: 'user-a' });
  });

  it('a timeout "deny" continuation of a paused run is recorded as a timeout, answered by the timeout actor', async () => {
    await createAgent({ humanInTheLoop: HITL_ON });
    scriptModel(oneToolScript('ls'));
    const id = String((await newConversation())._id);
    const { runId, actionId } = await pausedQueuedRun(id);
    await expire(actionId);

    expect(await sweepExpiredPendingActions(db, DB_NAME, new Date())).toMatchObject({ denied: 1, continued: 1 });
    const requeued = await statusOf(runId);
    expect(requeued).toMatchObject({ status: 'queued', userId: OWNER, resumeTrigger: 'timeout', resumeUserId: RESUME_TIMEOUT_ACTOR });

    await runAgentJobLocal({ runId, tenantId, tenantDbName: DB_NAME });
    expect(await statusOf(runId)).toMatchObject({ status: 'succeeded' });
    const running = (await db.listAgentSessionEvents(id, { runId })).filter((event) => event.type === 'session.status_running');
    expect(running.at(-1)?.data).toMatchObject({ trigger: 'timeout' });
  });
});
