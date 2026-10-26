/**
 * The red-team agent target hands `executeAgentChat` the configuration selector
 * the scan pinned, and follows the published version when it has none.
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
});
