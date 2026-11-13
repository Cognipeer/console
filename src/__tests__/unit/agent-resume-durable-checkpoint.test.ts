/**
 * Durable runs, a resumed turn (an approval answered): the SDK goes straight to
 * the approved tools without reporting a step first. The step that asked for
 * them must be stored before one runs; otherwise a node that stops right after
 * the tool finds no checkpoint, takes "no checkpoint" for "no side effect", and
 * runs the approved tool again.
 *
 * SYNC mock factories, per this repo's vitest notes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation, IAgentPendingAction } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  getModelByKey: vi.fn(),
  buildGatewayChatModel: vi.fn(),
  onInvoke: null as null | ((state: { messages: unknown[] }) => Promise<void>),
}));

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return {
    getDatabase,
    runWithTenantScope: vi.fn(async (_tenant: string, fn: (db: unknown) => unknown) => fn(await getDatabase())),
  };
});
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({
  buildGatewayChatModel: hoisted.buildGatewayChatModel,
  isDynamicModel: () => false,
}));

vi.mock('@cognipeer/agent-sdk', () => {
  const hookNames = [
    'userPromptSubmit', 'preModelCall', 'postModelCall', 'preToolUse', 'postToolUse',
    'preFinalAnswer', 'postFinalAnswer', 'onRunStart', 'onRunEnd', 'onError', 'onStateChange',
    'preCompact', 'postCompact',
  ];
  const hooks: Record<string, unknown> = {};
  for (const name of hookNames) hooks[name] = { implemented: true };
  const createSmartAgent = () => ({
    resolveToolApproval: (state: Record<string, unknown>) => ({ ...state, ctx: {}, pendingApprovals: [] }),
    invoke: async (state: { messages: unknown[] }) => {
      await hoisted.onInvoke?.(state);
      const messages = [...state.messages, { role: 'assistant', content: 'done' }];
      return { content: 'done', messages, state: { ...state, messages }, metadata: {} };
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
    CONSOLE_HOOK_MAP: {},
    GuardrailPhase: { Request: 'request', Response: 'response' },
    createSmartAgent,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentResumeLocal } from '@/lib/services/agents/agentService';
import { serializePausedState } from '@/lib/services/agents/agentPendingActions';
import type { RunCheckpointer } from '@/lib/services/agents/runCheckpoint';

const TENANT_ID = 'tenant-acme';
const CONVERSATION_ID = 'conv-1';
const ASKED = [
  { role: 'user', content: 'open a ticket' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'create_ticket', arguments: '{}' } }] },
];

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.onInvoke = null;
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentByKey.mockResolvedValue({
    tenantId: TENANT_ID, projectId: 'proj-1', key: 'triage-agent', name: 'Triage',
    config: { modelKey: 'gpt-4o', systemPrompt: 'You open tickets.' }, createdBy: 'user-1',
  } as IAgent);
  db.findAgentConversationById.mockResolvedValue({
    _id: CONVERSATION_ID, tenantId: TENANT_ID, projectId: 'proj-1', agentKey: 'triage-agent',
    title: 'New conversation', messages: [], createdBy: 'user-1', runtimeStatus: 'requires_action',
  } as unknown as IAgentConversation);
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o', name: 'GPT-4o', category: 'llm', providerKey: 'openai', providerDriver: 'openai',
    modelId: 'gpt-4o', tenantId: TENANT_ID, projectId: 'proj-1', settings: {},
  });
  hoisted.buildGatewayChatModel.mockResolvedValue({});
  const paused = serializePausedState({
    messages: ASKED,
    pendingApprovals: [{ id: 'ap-1', status: 'pending', toolName: 'create_ticket', args: {} }],
    ctx: { __awaitingApproval: true },
  } as never, 'agent', undefined)!;
  db.findAgentConversationState.mockResolvedValue({
    conversationId: CONVERSATION_ID, tenantId: TENANT_ID, projectId: 'proj-1', agentKey: 'triage-agent', sizeBytes: 0,
    messageCount: 0, snapshot: '{}', pausedSnapshot: paused,
  });
  db.listAgentPendingActions.mockResolvedValue([{
    sdkId: 'ap-1', status: 'resolved', resolution: { decision: 'allow' }, agentVersion: null, usePublished: false, createdBy: 'user-1',
  } as unknown as IAgentPendingAction]);
  db.writeAgentRunCheckpoint = vi.fn().mockResolvedValue(true);
});

describe('durable runs: a resumed turn', () => {
  it('stores the step that asked for the approved tool before that tool runs', async () => {
    const cell: { cancelled: boolean; deadlineAt: number; leaseRenewedAt: number; checkpointer?: RunCheckpointer } = {
      cancelled: false, deadlineAt: Date.now() + 60_000, leaseRenewedAt: performance.now(),
    };
    let writesBeforeTool = -1;
    // The SDK runs the approved tool first (no step reported): the wrapped tool asks the
    // checkpointer, as `withCheckpointBeforeTool` does.
    hoisted.onInvoke = async () => {
      await cell.checkpointer!.beforeTool('create_ticket');
      writesBeforeTool = (db.writeAgentRunCheckpoint as ReturnType<typeof vi.fn>).mock.calls.length;
      cell.checkpointer!.afterTool('create_ticket');
    };

    await executeAgentResumeLocal({
      tenantDbName: 'tenant_acme', tenantId: TENANT_ID, projectId: 'proj-1', agentKey: 'triage-agent',
      conversationId: CONVERSATION_ID, userId: 'user-1', trigger: 'resume',
      runId: 'run-1', durable: { generation: 3, turnKey: 'turn-1' }, cancellationCell: cell,
    } as never);

    expect(writesBeforeTool).toBe(1);
    const write = (db.writeAgentRunCheckpoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(write).toMatchObject({ runId: 'run-1', generation: 3, mode: 'reset', messageCount: ASKED.length });
  });
});
