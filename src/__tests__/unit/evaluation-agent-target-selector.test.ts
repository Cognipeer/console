/**
 * Unit tests — which agent configuration an `agent` evaluation target runs.
 *
 * A run pins its config up front and hands the selector to the invoker
 * (`options.agentRun`); without one the invoker follows the target's stored
 * default. What reaches `executeAgentChat` decides whether an item answers from
 * a published version, the published version as it is, or the saved draft.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// TRAP: factories must be synchronous — an async vi.mock factory silently
// fails to intercept under this setup.
const h = vi.hoisted(() => ({
  createConversation: vi.fn(),
  executeAgentChat: vi.fn(),
  getDatabase: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  createConversation: h.createConversation,
  executeAgentChat: h.executeAgentChat,
}));
vi.mock('@/lib/services/models/inferenceService', () => ({
  handleChatCompletion: vi.fn(),
  handleEmbeddingRequest: vi.fn(),
}));
vi.mock('@/lib/services/models/usageLogger', () => ({ calculateCost: vi.fn(() => ({ totalCost: 0 })) }));
vi.mock('@/lib/database', () => ({ getDatabase: h.getDatabase }));

import { buildTargetInvoker, type EvaluationModelContext } from '@/lib/services/evaluation/adapters';
import type { IEvaluationTarget } from '@/lib/database';
import type { DatasetItem } from '@/lib/services/evaluation/types';

const CTX: EvaluationModelContext = { tenantDbName: 'tenant_db', tenantId: 't1', projectId: 'p1', userId: 'u1' };
const ITEM: DatasetItem = { id: 'q1', input: [{ role: 'user', content: 'Hello' }] };

function agentTarget(overrides: Partial<IEvaluationTarget> = {}): IEvaluationTarget {
  return { tenantId: 't1', projectId: 'p1', key: 'bot-target', name: 'Bot', kind: 'agent', agentKey: 'bot', createdBy: 'u1', ...overrides };
}

async function lastChatParams(target: IEvaluationTarget, options?: Parameters<typeof buildTargetInvoker>[2]) {
  const output = await buildTargetInvoker(target, CTX, options)(ITEM);
  expect(output.text).toBe('hi there');
  return h.executeAgentChat.mock.calls.at(-1)![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.createConversation.mockResolvedValue({ _id: 'c1' });
  h.executeAgentChat.mockResolvedValue({ output: [{ content: [{ type: 'output_text', text: 'hi there' }] }] });
});

describe('agent target invoker — which config it asks the runtime for', () => {
  it('runs the version the run pinned, whatever the target says', async () => {
    const params = await lastChatParams(agentTarget({ agentVersion: 'draft' }), { agentRun: { version: 4 } });
    expect(params.version).toBe(4);
    expect(params).not.toHaveProperty('usePublished');
    expect(params.agentKey).toBe('bot');
    expect(params.conversationId).toBe('c1');
  });

  it('runs the draft when the run pinned an empty selector', async () => {
    const params = await lastChatParams(agentTarget({ agentVersion: 3 }), { agentRun: {} });
    expect(params).not.toHaveProperty('version');
    expect(params).not.toHaveProperty('usePublished');
  });

  it('follows the published version when the run pinned that', async () => {
    const params = await lastChatParams(agentTarget(), { agentRun: { usePublished: true } });
    expect(params.usePublished).toBe(true);
    expect(params).not.toHaveProperty('version');
  });

  it('without a run, follows a pinned default version', async () => {
    const params = await lastChatParams(agentTarget({ agentVersion: 3 }));
    expect(params.version).toBe(3);
    expect(params).not.toHaveProperty('usePublished');
  });

  it('without a run, follows a default of the draft', async () => {
    const params = await lastChatParams(agentTarget({ agentVersion: 'draft' }));
    expect(params).not.toHaveProperty('version');
    expect(params).not.toHaveProperty('usePublished');
  });

  it('without a run, follows the published version when no default is stored', async () => {
    for (const agentVersion of [undefined, null]) {
      const params = await lastChatParams(agentTarget({ agentVersion }));
      expect(params.usePublished).toBe(true);
      expect(params).not.toHaveProperty('version');
    }
  });

  it('refuses a system-prompt override without claiming the agent runs its published prompt', async () => {
    const invoke = buildTargetInvoker(agentTarget({ systemPrompt: 'override' }), CTX);
    await expect(invoke(ITEM)).rejects.toThrow(/system-prompt override/);
    await expect(invoke(ITEM)).rejects.not.toThrow(/published prompt/);
    expect(h.executeAgentChat).not.toHaveBeenCalled();
  });
});
