/**
 * The reads a chat turn needs before any model work (the conversation, the spend scope, the attachments, the
 * pending-action check, the spend limit) are started early (agentChatRun.ts `runAgentChatTurn`). The checks are still
 * judged in their original order, so the same refusal wins as before: pending actions, then attachments, then the
 * spend limit; and a missing conversation before any of them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgent, IAgentConversation } from '@/lib/database';

const hoisted = vi.hoisted(() => ({
  resolveSpendScope: vi.fn(),
  assertSpend: vi.fn(),
  resolveAttachments: vi.fn(),
}));

vi.mock('@/lib/database', () => {
  const getDatabase = vi.fn();
  return { getDatabase, runWithTenantScope: async (_tenantDbName: string, fn: (db: unknown) => unknown) => fn(await getDatabase()) };
});

vi.mock('@/lib/services/agents/agentSpendLimits', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveAgentSpendScope: hoisted.resolveSpendScope,
  assertAgentTurnSpendAllowed: hoisted.assertSpend,
}));
vi.mock('@/lib/services/agents/agentAttachments', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMessageAttachments: hoisted.resolveAttachments,
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { executeAgentChatLocal } from '@/lib/services/agents/agentService';

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-acme';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'librarian';
const CONVERSATION_ID = 'conv-1';

const agent = (config: Record<string, unknown> = {}) => ({
  tenantId: TENANT_ID, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Librarian', createdBy: 'user-1',
  config: { modelKey: 'main', systemPrompt: 'Look things up.', ...config },
}) as IAgent;

const conversation = (extra: Partial<IAgentConversation> = {}) => ({
  _id: CONVERSATION_ID, tenantId: TENANT_ID, projectId: PROJECT_ID, agentKey: AGENT_KEY,
  title: 'New conversation', messages: [], createdBy: 'user-1', ...extra,
}) as IAgentConversation;

const request = {
  tenantDbName: TENANT_DB,
  tenantId: TENANT_ID,
  projectId: PROJECT_ID,
  agentKey: AGENT_KEY,
  conversationId: CONVERSATION_ID,
  userMessage: 'hello',
  userId: 'user-1',
};

let db: ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
  (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  db.findAgentByKey.mockResolvedValue(agent());
  db.findAgentConversationById.mockResolvedValue(conversation());
  hoisted.resolveSpendScope.mockResolvedValue({ tenantDbName: TENANT_DB, tenantId: TENANT_ID, projectId: PROJECT_ID, licenseType: 'FREE' });
  hoisted.assertSpend.mockResolvedValue(undefined);
  hoisted.resolveAttachments.mockResolvedValue([]);
});

const run = (extra: Record<string, unknown> = {}) => executeAgentChatLocal({ ...request, ...extra } as never);

describe('a refusal is the same one as when the checks ran one after the other', () => {
  it('a missing conversation is reported, not the spend refusal that was already being checked', async () => {
    db.findAgentConversationById.mockResolvedValue(null);
    hoisted.assertSpend.mockRejectedValue(new Error('spend limit used up'));

    await expect(run()).rejects.toThrow(`Conversation "${CONVERSATION_ID}" not found`);
  });

  it('a conversation of another project is reported as missing', async () => {
    db.findAgentConversationById.mockResolvedValue(conversation({ projectId: 'other-project' }));
    hoisted.assertSpend.mockRejectedValue(new Error('spend limit used up'));

    await expect(run()).rejects.toThrow(`Conversation "${CONVERSATION_ID}" not found`);
  });

  it('a missing agent is reported before the conversation', async () => {
    db.findAgentByKey.mockResolvedValue(null);
    db.findAgentConversationById.mockResolvedValue(null);

    await expect(run()).rejects.toThrow(`Agent "${AGENT_KEY}" not found`);
  });

  it('an attachment problem is reported before the spend refusal', async () => {
    hoisted.resolveAttachments.mockRejectedValue(new Error('attachment not found'));
    hoisted.assertSpend.mockRejectedValue(new Error('spend limit used up'));

    await expect(run()).rejects.toThrow('attachment not found');
  });

  it('a message that waits on an open approval is refused before an attachment problem', async () => {
    db.findAgentByKey.mockResolvedValue(agent({ humanInTheLoop: { onUserMessageWhilePending: 'reject' } }));
    db.findAgentConversationById.mockResolvedValue(conversation({ runtimeStatus: 'requires_action' }));
    db.listAgentPendingActions.mockResolvedValue([{ _id: 'action-1' }] as never);
    hoisted.resolveAttachments.mockRejectedValue(new Error('attachment not found'));
    hoisted.assertSpend.mockRejectedValue(new Error('spend limit used up'));

    await expect(run()).rejects.toMatchObject({ name: 'AgentPendingActionError' });
  });

  it('the spend refusal is reported when nothing before it failed', async () => {
    hoisted.assertSpend.mockRejectedValue(new Error('spend limit used up'));

    await expect(run()).rejects.toThrow('spend limit used up');
  });

  it('a turn that calls no model is not checked against the spend limit', async () => {
    db.findAgentByKey.mockResolvedValue(agent({ kind: 'flow' }));
    hoisted.assertSpend.mockRejectedValue(new Error('spend limit used up'));

    await run().catch(() => undefined);

    expect(hoisted.resolveSpendScope).not.toHaveBeenCalled();
    expect(hoisted.assertSpend).not.toHaveBeenCalled();
  });
});

describe('the reads start early', () => {
  it('reads the spend scope and the attachments while the conversation is still being read', async () => {
    let releaseConversation: (value: IAgentConversation | null) => void = () => undefined;
    db.findAgentConversationById.mockReturnValue(new Promise((resolve) => { releaseConversation = resolve; }));
    hoisted.assertSpend.mockRejectedValue(new Error('spend limit used up'));

    const turn = run();
    // The agent resolves first; the spend scope is read before the conversation comes back.
    await vi.waitFor(() => expect(hoisted.resolveSpendScope).toHaveBeenCalledTimes(1));
    expect(db.findAgentConversationById).toHaveBeenCalledTimes(1);
    releaseConversation(conversation());

    await expect(turn).rejects.toThrow('spend limit used up');
    // Both the attachment read and the spend check had started before their turn to be judged.
    expect(hoisted.resolveAttachments).toHaveBeenCalledTimes(1);
    expect(hoisted.assertSpend).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveSpendScope).toHaveBeenCalledTimes(1);
  });
});
