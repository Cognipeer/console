/**
 * Group B (docs/guide/agent-background-execution.md §13) — the
 * `AgentRunCancellationCell` guard actually gates the conversation write.
 *
 * §12.2's promoted spike (`agent-sdk-cancellation.test.ts`) proves the SDK's
 * own `cancellationToken`/`timeoutMs` cannot be trusted to interrupt an
 * in-flight call. This test proves the OTHER half of Phase 0 (§12.12): even
 * though `executeAgentChatLocal` has no way to stop `sdkAgent.invoke()`
 * early, it must still refuse to persist a turn whose deadline has already
 * passed or that has been explicitly canceled by the time `invoke()`
 * finally settles — regardless of how complete/successful that settled
 * result looks.
 *
 * End to end over the local agent path, SDK faked at the boundary (same
 * pattern as `guardrail-fix3-agent-chat-redaction.test.ts`): everything
 * console-side is real (guardrail plugin wiring, the conversation write
 * itself), only the SDK's `createSmartAgent`/`invoke` are stood in for.
 *
 * SYNC mock factories throughout, per this repo's vitest notes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  runHook: vi.fn(),
  resolveGuardrail: vi.fn(),
  getModelByKey: vi.fn(),
  buildModelRuntime: vi.fn(),
  /** Every `InvokeConfig` the fake SDK was called with, one per invoke. */
  invokeConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/models/modelService', () => ({
  getModelByKey: hoisted.getModelByKey,
}));

vi.mock('@/lib/services/models/runtimeService', () => ({
  buildModelRuntime: hoisted.buildModelRuntime,
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

/** The SDK at the boundary — a minimal stand-in, no plugin execution needed here. */
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

  const createSmartAgent = (_opts: { systemPrompt?: string; model: unknown }) => ({
    invoke: async (
      state: { messages: Array<{ role: string; content: unknown }> },
      config?: Record<string, unknown>,
    ) => {
      hoisted.invokeConfigs.push(config ?? {});
      const answer = { role: 'assistant', content: 'Noted, thanks.' };
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
    fromLangchainModel: (model: unknown) => model,
    createTool: (spec: unknown) => spec,
    customSink: (config: unknown) => config,
  };
});

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal } from '@/lib/services/agents/agentService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'support-agent';
const CONVERSATION_ID = 'conv-1';

function nativeAgent(): IAgent {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    key: AGENT_KEY,
    name: 'Support Agent',
    config: {
      modelKey: 'gpt-4o',
      systemPrompt: 'You are terse.',
    },
    createdBy: 'user-1',
  } as IAgent;
}

function conversation(messages: IAgentConversation['messages'] = []): IAgentConversation {
  return {
    _id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    title: 'New conversation',
    messages,
    createdBy: 'user-1',
  };
}

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.invokeConfigs.length = 0;
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentByKey.mockResolvedValue(nativeAgent());
  db.findAgentConversationById.mockResolvedValue(conversation());
  hoisted.getModelByKey.mockResolvedValue({
    key: 'gpt-4o',
    name: 'GPT-4o',
    category: 'llm',
    providerKey: 'openai',
    providerDriver: 'openai',
    modelId: 'gpt-4o',
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    settings: {},
  });
  hoisted.buildModelRuntime.mockResolvedValue({ runtime: { createChatModel: () => ({}) } });
});

function request(cancellationCell?: { deadlineAt?: number; cancelled: boolean }) {
  return {
    tenantDbName: TENANT_DB,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentKey: AGENT_KEY,
    conversationId: CONVERSATION_ID,
    userMessage: 'what are your hours?',
    userId: 'user-1',
    ...(cancellationCell ? { cancellationCell } : {}),
  };
}

describe('AgentRunCancellationCell gates the conversation write (§12.12)', () => {
  it('with no cancellationCell, the turn persists normally (control case)', async () => {
    await executeAgentChatLocal(request());

    expect(db.updateAgentConversation).toHaveBeenCalledTimes(1);
  });

  it('with a cancellationCell whose deadline has NOT passed, the turn persists normally', async () => {
    await executeAgentChatLocal(request({ deadlineAt: Date.now() + 60_000, cancelled: false }));

    expect(db.updateAgentConversation).toHaveBeenCalledTimes(1);
  });

  it('a deadline that has already passed by the time invoke() resolves skips the write entirely', async () => {
    // Simulates the sync ceiling firing: the HTTP handler already raced this
    // call and returned 504 before invoke() settled — deadlineAt is in the past.
    await executeAgentChatLocal(request({ deadlineAt: Date.now() - 1, cancelled: false }));

    expect(db.updateAgentConversation).not.toHaveBeenCalled();
  });

  it('an explicit cancel flag (background mode, §7 step 6) skips the write entirely', async () => {
    // Simulates a background worker's heartbeat-cadence poll having already
    // observed `cancelRequestedAt` and flipped `cancelled` before invoke()
    // settled — the late-arriving "success" must not be persisted.
    await executeAgentChatLocal(request({ cancelled: true }));

    expect(db.updateAgentConversation).not.toHaveBeenCalled();
  });

  it('passes a derived timeoutMs and a cancellationToken into the SDK invoke config', async () => {
    const deadlineAt = Date.now() + 5_000;
    await executeAgentChatLocal(request({ deadlineAt, cancelled: false }));

    expect(hoisted.invokeConfigs).toHaveLength(1);
    const config = hoisted.invokeConfigs[0];
    expect(typeof config.timeoutMs).toBe('number');
    expect(config.timeoutMs as number).toBeLessThanOrEqual(5_000);
    expect(config.cancellationToken).toBeInstanceOf(AbortSignal);
  });
});
