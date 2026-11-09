/**
 * The red-team agent target hands `executeAgentChat` the configuration selector
 * the scan pinned, and follows the published version when it has none. Each
 * attempt has its own conversation, also when attempts run in parallel, and the
 * call's abort signal reaches the agent turn.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const agent = vi.hoisted(() => ({
  executeAgentChat: vi.fn(async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] })),
  createConversation: vi.fn(async () => ({ _id: 'conv-1' })),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
  executeAgentChat: agent.executeAgentChat,
  createConversation: agent.createConversation,
}));
vi.mock('@/lib/services/models/inferenceService', () => ({ handleChatCompletion: vi.fn() }));

import { buildTargetInvoker } from '@/lib/services/redteam/adapters';

const ctx = { tenantDbName: 'db', tenantId: 't1', projectId: 'p1', userId: 'u1' };
const messages = [{ role: 'user' as const, content: 'hello' }];

async function callArgs(spec: Parameters<typeof buildTargetInvoker>[0]) {
  await buildTargetInvoker(spec, ctx)(messages);
  return (agent.executeAgentChat.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
}

describe('red-team agent target selector', () => {
  beforeEach(() => {
    agent.executeAgentChat.mockClear();
    agent.createConversation.mockClear();
  });

  it('follows the published version when the scan pinned nothing', async () => {
    const args = await callArgs({ kind: 'agent', key: 'c', agentKey: 'bot' });
    expect(args.usePublished).toBe(true);
    expect(args.version).toBeUndefined();
  });

  it('runs a pinned version', async () => {
    const args = await callArgs({ kind: 'agent', key: 'c', agentKey: 'bot', agentRun: { version: 3 } });
    expect(args.version).toBe(3);
    expect(args.usePublished).toBeUndefined();
  });

  it('runs the draft when the selector is empty', async () => {
    const args = await callArgs({ kind: 'agent', key: 'c', agentKey: 'bot', agentRun: {} });
    expect(args.version).toBeUndefined();
    expect(args.usePublished).toBeUndefined();
    expect(args.unattended).toBe(true);
  });

  describe('conversations', () => {
    const conversationIds = (() => {
      let n = 0;
      return () => `conv-${(n += 1)}`;
    })();
    type ExecArgs = { conversationId: string; userMessage: string; signal?: AbortSignal };
    const executed = () => (agent.executeAgentChat.mock.calls as unknown as Array<[ExecArgs]>).map((c) => c[0]);

    beforeEach(() => {
      agent.createConversation.mockImplementation(async () => ({ _id: conversationIds() }));
    });

    it('opens one conversation per attempt and keeps its turns in it, under concurrency', async () => {
      const invoke = buildTargetInvoker({ kind: 'agent', key: 'c', agentKey: 'bot' }, ctx);
      const attempt = async (key: string) => {
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        for (let turn = 0; turn < 3; turn += 1) {
          history.push({ role: 'user', content: `${key}-${turn}` });
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          await invoke(history, { attemptKey: key, turnIndex: turn });
          history.push({ role: 'assistant', content: 'ok' });
        }
      };
      await Promise.all(['p::a1', 'p::a2', 'p::a3', 'p::a4'].map(attempt));

      expect(agent.createConversation).toHaveBeenCalledTimes(4);
      const byAttempt = new Map<string, Set<string>>();
      for (const call of executed()) {
        const key = call.userMessage.slice(0, call.userMessage.lastIndexOf('-'));
        byAttempt.set(key, (byAttempt.get(key) ?? new Set()).add(call.conversationId));
      }
      expect(byAttempt.size).toBe(4);
      for (const ids of byAttempt.values()) expect(ids.size).toBe(1);
      expect(new Set([...byAttempt.values()].map((ids) => [...ids][0])).size).toBe(4);
    });

    it('starts a new conversation at turn 0 even when the history already has an assistant turn', async () => {
      const invoke = buildTargetInvoker({ kind: 'agent', key: 'c', agentKey: 'bot' }, ctx);
      const withAssistant = [
        { role: 'user' as const, content: 'x' },
        { role: 'assistant' as const, content: 'y' },
        { role: 'user' as const, content: 'z' },
      ];
      await invoke(withAssistant, { attemptKey: 'p::a1', turnIndex: 0 });
      expect(agent.createConversation).toHaveBeenCalledTimes(1);
    });

    it('without a call context starts a conversation when there is no assistant turn yet', async () => {
      const invoke = buildTargetInvoker({ kind: 'agent', key: 'c', agentKey: 'bot' }, ctx);
      await invoke([{ role: 'user', content: 'one' }]);
      await invoke([
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'two' },
      ]);
      await invoke([{ role: 'user', content: 'fresh' }]);
      const ids = executed().map((c) => c.conversationId);
      expect(agent.createConversation).toHaveBeenCalledTimes(2);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
    });

    it('hands the call signal to the agent turn', async () => {
      const controller = new AbortController();
      await buildTargetInvoker({ kind: 'agent', key: 'c', agentKey: 'bot' }, ctx)(messages, {
        attemptKey: 'p::a1',
        turnIndex: 0,
        signal: controller.signal,
      });
      expect(executed()[0].signal).toBe(controller.signal);
    });
  });
});
