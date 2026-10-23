/**
 * The plan, the sub-agents and the summarization passes of a turn on the two
 * invoke paths that fake well (background/API `executeAgentChatLocal` and the
 * playground `executePlaygroundChatLocal`): the stored message, the session log
 * and the live callbacks all come from the same tracker, so they agree.
 *
 * SDK faked at the boundary (same pattern as agent-reasoning-run); each test
 * scripts the events `invoke()` reports. The resume path is covered by the
 * delegation integration test, which runs the real loop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  scripted: { events: [] as Array<Record<string, unknown>> },
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: hoisted.getModelByKey,
}));

vi.mock('@/lib/services/agents/gatewayChatModel', () => ({
  buildGatewayChatModel: hoisted.buildGatewayChatModel,
  isDynamicModel: () => false,
}));

vi.mock('@/lib/services/guardrail/hooks/engine', () => ({
  runHook: hoisted.runHook,
  resolveGuardrail: hoisted.resolveGuardrail,
  ensureDefaultToolGuardrail: vi.fn(async () => ({ key: 'tool-safety-default' })),
  DEFAULT_TOOL_GUARDRAIL_KEY: 'tool-safety-default',
  mergeVerdicts: vi.fn(),
  assertContractVersion: vi.fn(),
}));

vi.mock('@/lib/services/guardrail/hooks/legacy', () => ({
  ensureHooks: () => ({
    hooksVersion: 1,
    hooks: {
      contractVersion: 2,
      policies: [],
      bindings: {},
    },
  }),
}));

/** The SDK at the boundary; each test scripts what `invoke()` reports. */
vi.mock('@cognipeer/agent-sdk', () => {
  const hookNames = [
    'userPromptSubmit', 'preModelCall', 'postModelCall', 'preToolUse', 'postToolUse',
    'preFinalAnswer', 'postFinalAnswer', 'onRunStart', 'onRunEnd', 'onError', 'onStateChange',
    'preCompact', 'postCompact',
  ];
  const hooks: Record<string, unknown> = {};
  for (const name of hookNames) hooks[name] = { implemented: true };
  const CONSOLE_HOOK_MAP = {
    'prompt.pre': 'userPromptSubmit',
    'input.pre': 'preModelCall',
    'output.pre': 'postModelCall',
    'output.stream.delta': null,
    'tool.pre': 'preToolUse',
    'tool.post': 'postToolUse',
  };

  const createSmartAgent = () => ({
    invoke: async (state: { messages: Array<{ role: string; content: unknown }> }, config?: { onEvent?: (event: Record<string, unknown>) => void }) => {
      for (const event of hoisted.scripted.events) config?.onEvent?.(event);
      const answer = { role: 'assistant', content: 'all done' };
      const messages = [...state.messages, answer];
      return { content: answer.content, messages, state: { ...state, messages }, metadata: {} };
    },
  });

  return {
    version: '0.10.1',
    pluginCapabilities: () => ({
      hookContractVersion: 1,
      hooks,
      slots: {},
      features: { streamGate: { implemented: false }, traceSinkContribution: { implemented: false } },
    }),
    CONSOLE_HOOK_MAP,
    GuardrailPhase: { Request: 'request', Response: 'response' },
    createSmartAgent,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'planner';
const CONVERSATION_ID = 'conv-1';

const agent = {
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  key: AGENT_KEY,
  name: 'Planner',
  config: {
    modelKey: 'main',
    systemPrompt: 'Plan.',
  },
  createdBy: 'user-1',
} as unknown as IAgent;

const conversation = (): IAgentConversation => ({
  _id: CONVERSATION_ID,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  agentKey: AGENT_KEY,
  title: 'New conversation',
  messages: [],
  createdBy: 'user-1',
});

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.scripted = { events: [] };
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentConversationById.mockResolvedValue(conversation());
  db.findAgentByKey.mockResolvedValue(agent);
  hoisted.getModelByKey.mockImplementation(async (_db: string, key: string) => ({
    key, name: key, category: 'llm', providerKey: 'openai', providerDriver: 'openai', modelId: key,
    tenantId: TENANT_ID, projectId: PROJECT_ID, settings: {},
  }));
  hoisted.buildGatewayChatModel.mockResolvedValue({});
});

const base = {
  tenantDbName: TENANT_DB,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  agentKey: AGENT_KEY,
  conversationId: CONVERSATION_ID,
  userMessage: 'plan it',
  userId: 'user-1',
};

const child = { subagentName: 'helper', subagentId: 'sa_1' };
const step = (id: number, status: string) => ({ id, step: `Step ${id}`, owner: 'agent', exitCriteria: 'done', status });

/** A turn that plans, delegates (the child calls a tool and compacts its context), compacts its own and updates the plan. */
function plannedTurn(): Array<Record<string, unknown>> {
  return [
    { type: 'tool_call', phase: 'start', name: 'manage_plan', id: 'p1' },
    { type: 'plan', source: 'manage_plan', operation: 'write', version: 1, todoList: [step(1, 'in-progress'), step(2, 'not-started')], adherenceScore: 0 },
    { type: 'tool_call', phase: 'success', name: 'manage_plan', id: 'p1' },
    { type: 'tool_call', phase: 'start', name: 'delegate_to', id: 'd1' },
    { type: 'subagent', phase: 'start', id: 'sa_1', name: 'helper', mode: 'registry', parentToolCallId: 'd1', input: 'do the legwork' },
    { type: 'tool_call', phase: 'start', name: 'lookup', id: 'c1', args: { q: 'acme' }, ...child },
    { type: 'plan', source: 'manage_plan', operation: 'write', version: 1, todoList: [step(9, 'completed')], ...child },
    { type: 'tool_call', phase: 'success', name: 'lookup', id: 'c1', result: { hits: 2 }, durationMs: 7, ...child },
    { type: 'summarization', summary: 'child pass', messagesCompressed: 3, ...child },
    { type: 'subagent', phase: 'result', id: 'sa_1', name: 'helper', mode: 'registry', parentToolCallId: 'd1', content: 'legwork done', status: 'ok', durationMs: 900 },
    { type: 'tool_call', phase: 'success', name: 'delegate_to', id: 'd1' },
    { type: 'summarization', phase: 'start', id: 'call_summary_1', pass: 1, trigger: 'post_tools', summary: '' },
    {
      type: 'summarization', phase: 'done', id: 'call_summary_1', pass: 1, trigger: 'post_tools', status: 'ok',
      summary: 'parent pass', messagesCompressed: 6, tokenCountBefore: 8000, tokenCountAfter: 1500,
      compactedTools: [{ toolCallId: 'd1', toolName: 'delegate_to' }],
    },
    { type: 'tool_call', phase: 'start', name: 'manage_plan', id: 'p2' },
    { type: 'plan', source: 'manage_plan', operation: 'update', version: 2, todoList: [step(1, 'completed'), step(2, 'in-progress')], adherenceScore: 0.5 },
    { type: 'plan', source: 'manage_plan', operation: 'read', version: 2, todoList: [step(1, 'completed'), step(2, 'in-progress')] },
    { type: 'tool_call', phase: 'success', name: 'manage_plan', id: 'p2' },
  ];
}

/** A turn that called its plan tool to look at the plan: the call succeeds and no version is written. */
function planReadTurn(): Array<Record<string, unknown>> {
  return [
    { type: 'tool_call', phase: 'start', name: 'manage_plan', id: 'p1' },
    { type: 'plan', source: 'manage_plan', operation: 'read', version: 1, todoList: [step(1, 'in-progress')] },
    { type: 'tool_call', phase: 'success', name: 'manage_plan', id: 'p1' },
  ];
}

const persistedAssistantTurn = () => {
  const update = db.updateAgentConversation.mock.calls[0][1] as unknown as { messages: Array<Record<string, any>> };
  return update.messages[update.messages.length - 1];
};

/** Everything the turn wrote to the event log, in order. */
const loggedEvents = () => db.appendAgentSessionEvents.mock.calls
  .flatMap((call) => call[0] as Array<{ seq: number; type: string; data: Record<string, any> }>);

/** What the stored assistant message must say about the turn above, whichever path wrote it. */
function expectRecordedFlow(message: Record<string, any>) {
  expect(message.plans.map((p: any) => [p.version, p.operation, p.toolCallId])).toEqual([[1, 'write', 'p1'], [2, 'update', 'p2']]);
  expect(message.plans[0].steps).toEqual([
    { id: 1, title: 'Step 1', status: 'in-progress', owner: 'agent', exitCriteria: 'done' },
    { id: 2, title: 'Step 2', status: 'not-started', owner: 'agent', exitCriteria: 'done' },
  ]);
  expect(message.plans[1].completion).toBe(0.5);

  expect(message.subagentRuns).toHaveLength(1);
  expect(message.subagentRuns[0]).toMatchObject({
    id: 'sa_1',
    name: 'helper',
    mode: 'registry',
    parentToolCallId: 'd1',
    phase: 'result',
    status: 'ok',
    input: 'do the legwork',
    result: 'legwork done',
    steps: [{ id: 'c1', name: 'lookup', status: 'success', args: { q: 'acme' }, output: { hits: 2 }, durationMs: 7 }],
  });
  // The child's own pass is on its run; the message's passes are the agent's.
  expect(message.subagentRuns[0].compactions).toHaveLength(1);
  expect(message.compactions).toHaveLength(1);
  expect(message.compactions[0]).toMatchObject({
    id: 'call_summary_1', index: 1, afterToolCallId: 'd1', trigger: 'post_tools', messagesCompressed: 6,
    compactedTools: [{ toolName: 'delegate_to', toolCallId: 'd1' }],
  });
}

describe('executeAgentChatLocal: the turn flow of a background / API turn', () => {
  it('stores the plan versions, the sub-agent run and the positioned pass on the assistant message', async () => {
    hoisted.scripted.events = plannedTurn();
    await executeAgentChatLocal(base);
    expectRecordedFlow(persistedAssistantTurn());
  });

  it('leaves the fields off a turn that had none', async () => {
    hoisted.scripted.events = [{ type: 'tool_call', phase: 'start', name: 'lookup', id: 'x' }];
    await executeAgentChatLocal(base);
    const message = persistedAssistantTurn();
    for (const key of ['plans', 'subagentRuns', 'subagentRunsDropped', 'compactions']) expect(message).not.toHaveProperty(key);
  });

  it('stores an empty plan list on a turn that only read its plan, so a reader leaves the read call out as the live view does', async () => {
    hoisted.scripted.events = planReadTurn();
    await executeAgentChatLocal(base);
    const message = persistedAssistantTurn();
    expect(message.plans).toEqual([]);
    for (const key of ['subagentRuns', 'subagentRunsDropped', 'compactions']) expect(message).not.toHaveProperty(key);
  });

  it('keeps the plans field off a turn whose only plan call failed', async () => {
    hoisted.scripted.events = [
      { type: 'tool_call', phase: 'start', name: 'manage_plan', id: 'p1' },
      { type: 'tool_call', phase: 'error', name: 'manage_plan', id: 'p1', error: { message: 'bad plan' } },
    ];
    await executeAgentChatLocal(base);
    expect(persistedAssistantTurn()).not.toHaveProperty('plans');
  });

  it('logs the plan once per version, the sub-agent lifecycle, the child rows with their delegation and both kinds of pass', async () => {
    hoisted.scripted.events = plannedTurn();
    await executeAgentChatLocal(base);
    const events = loggedEvents();
    expect(events.map((e) => e.type)).toEqual([
      'user.message', 'session.status_running',
      'agent.tool_use', 'agent.plan', 'agent.tool_result',
      'agent.tool_use', 'agent.subagent',
      'agent.tool_use', 'agent.tool_result', 'agent.compaction',
      'agent.subagent', 'agent.tool_result',
      'agent.compaction',
      'agent.tool_use', 'agent.plan', 'agent.tool_result',
      'agent.message', 'session.status_idle', 'session.work_done',
    ]);
    const by = (type: string) => events.filter((e) => e.type === type);
    expect(by('agent.plan').map((e) => [e.data.version, e.data.toolCallId])).toEqual([[1, 'p1'], [2, 'p2']]);
    expect(by('agent.subagent').map((e) => [e.data.phase, e.data.id, e.data.parentToolCallId])).toEqual([
      ['start', 'sa_1', 'd1'], ['result', 'sa_1', 'd1'],
    ]);
    const childRows = events.filter((e) => e.data.name === 'lookup');
    expect(childRows).toHaveLength(2);
    for (const row of childRows) expect(row.data).toMatchObject({ subagent: 'helper', subagentId: 'sa_1', parentToolCallId: 'd1' });
    // The agent's own rows carry none of that.
    const own = events.filter((e) => e.data.name === 'delegate_to');
    for (const row of own) {
      expect(row.data).not.toHaveProperty('subagentId');
      expect(row.data).not.toHaveProperty('parentToolCallId');
    }
    const passes = by('agent.compaction');
    expect(passes[0].data).toMatchObject({ subagent: { id: 'sa_1', name: 'helper' }, messagesCompressed: 3 });
    expect(passes[1].data).toMatchObject({ id: 'call_summary_1', index: 1, afterToolCallId: 'd1', trigger: 'post_tools' });
    expect(passes[1].data).not.toHaveProperty('subagent');
  });

  it('never logs a live-only start / skipped frame', async () => {
    hoisted.scripted.events = [
      { type: 'summarization', phase: 'start', id: 'x', summary: '' },
      { type: 'summarization', phase: 'skipped', id: 'x', summary: '' },
    ];
    await executeAgentChatLocal(base);
    expect(loggedEvents().some((e) => e.type === 'agent.compaction')).toBe(false);
    expect(persistedAssistantTurn()).not.toHaveProperty('compactions');
  });

  it('merges the double report of a failed summarizer on an older SDK into one stored pass', async () => {
    const failure = { type: 'summarization', summary: 'fallback text', messagesCompressed: 4, integrity: { notes: ['Used fallback summary'] } };
    hoisted.scripted.events = [failure, { ...failure }];
    await executeAgentChatLocal(base);
    expect(persistedAssistantTurn().compactions).toHaveLength(1);
    expect(persistedAssistantTurn().compactions[0]).toMatchObject({ failed: true, index: 1 });
    expect(loggedEvents().filter((e) => e.type === 'agent.compaction')).toHaveLength(1);
  });
});

describe('executePlaygroundChatLocal: the turn flow of a playground turn', () => {
  function listeners() {
    const seen = {
      tools: [] as Array<Record<string, any>>,
      plans: [] as Array<Record<string, any>>,
      subagents: [] as Array<Record<string, any>>,
      passes: [] as Array<Record<string, any>>,
    };
    return {
      seen,
      callbacks: {
        onToolEvent: (e: Record<string, any>) => seen.tools.push(e),
        onPlan: (e: Record<string, any>) => seen.plans.push(e),
        onSubagent: (e: Record<string, any>) => seen.subagents.push(e),
        onCompaction: (e: Record<string, any>) => seen.passes.push(e),
      },
    };
  }

  it('forwards each kind live and carries the same record on the result and the stored message', async () => {
    hoisted.scripted.events = plannedTurn();
    const { seen, callbacks } = listeners();
    const result = await executePlaygroundChatLocal({ ...base, ...callbacks });

    expect(seen.plans.map((p) => [p.version, p.operation, p.toolCallId])).toEqual([[1, 'write', 'p1'], [2, 'update', 'p2']]);
    expect(seen.subagents.map((e) => [e.phase, e.id, e.parentToolCallId])).toEqual([['start', 'sa_1', 'd1'], ['result', 'sa_1', 'd1']]);
    expect(seen.subagents[0]).toMatchObject({ name: 'helper', input: 'do the legwork' });
    expect(seen.subagents[1]).toMatchObject({ content: 'legwork done', status: 'ok', durationMs: 900 });

    // The child's call is stamped with its delegation; the delegation call itself is not.
    const lookups = seen.tools.filter((e) => e.name === 'lookup');
    expect(lookups).toHaveLength(2);
    for (const e of lookups) expect(e.subagent).toEqual({ id: 'sa_1', name: 'helper', parentToolCallId: 'd1' });
    expect(seen.tools.filter((e) => e.name === 'delegate_to').every((e) => e.subagent === undefined)).toBe(true);

    // Passes: the child's (named), then the agent's start frame and finished pass, sharing an id.
    expect(seen.passes.map((p) => [p.phase, p.id, p.subagent?.name])).toEqual([
      [undefined, 'pass-sa_1-1', 'helper'],
      ['start', 'call_summary_1', undefined],
      [undefined, 'call_summary_1', undefined],
    ]);

    expectRecordedFlow(result as Record<string, any>);
    expectRecordedFlow(persistedAssistantTurn());
  });

  it('carries the empty plan list of a plan read on the result and on the stored message', async () => {
    hoisted.scripted.events = planReadTurn();
    const result = await executePlaygroundChatLocal({ ...base });
    expect((result as Record<string, any>).plans).toEqual([]);
    expect(persistedAssistantTurn().plans).toEqual([]);
  });

  it('has no plans field on a turn that made no plan call', async () => {
    hoisted.scripted.events = [{ type: 'tool_call', phase: 'start', name: 'lookup', id: 'x' }];
    const result = await executePlaygroundChatLocal({ ...base });
    expect(result).not.toHaveProperty('plans');
    expect(persistedAssistantTurn()).not.toHaveProperty('plans');
  });

  it('a stateless turn (no session) still forwards and returns the flow, and logs nothing', async () => {
    hoisted.scripted.events = plannedTurn();
    const { seen, callbacks } = listeners();
    const result = await executePlaygroundChatLocal({ ...base, conversationId: undefined, ...callbacks });
    expect(seen.plans).toHaveLength(2);
    expectRecordedFlow(result as Record<string, any>);
    expect(db.appendAgentSessionEvents).not.toHaveBeenCalled();
    expect(db.updateAgentConversation).not.toHaveBeenCalled();
  });

  it('a callback that throws never breaks the run', async () => {
    hoisted.scripted.events = plannedTurn();
    const boom = vi.fn(() => { throw new Error('boom'); });
    const result = await executePlaygroundChatLocal({ ...base, onPlan: boom, onSubagent: boom, onCompaction: boom, onToolEvent: boom });
    expect(boom).toHaveBeenCalled();
    expectRecordedFlow(result as Record<string, any>);
  });

  it('asks nothing of a caller that listens to none of it', async () => {
    hoisted.scripted.events = plannedTurn();
    const result = await executePlaygroundChatLocal({ ...base });
    expectRecordedFlow(result as Record<string, any>);
  });
});
