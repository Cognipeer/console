/**
 * Cutting a session back, running a message again, rating an answer and naming a
 * conversation — the services a chat surface (a portal, an embedded widget) builds
 * its message actions on.
 *
 * A REAL SQLite provider; the model is scripted (the same boundary as the
 * human-in-the-loop suite). Faked: the model lookup, usage rows, the audit write
 * and webhook publishing, so what the services TELL those can be asserted.
 */

import { settlingModel } from '../helpers/fakeGatewayModel';
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
  logModelUsage: vi.fn(),
  db: { current: null as unknown },
}));

vi.mock('@/lib/services/users/userAuthState', () => ({ getUserAuthState: hoisted.getUserAuthState }));
vi.mock('@/lib/core/queue', () => ({ getQueue: vi.fn(async () => ({ publish: hoisted.publish })) }));
vi.mock('@/lib/services/audit/auditService', () => ({ recordAuditLog: hoisted.recordAuditLog }));
vi.mock('@/lib/services/webhooks/webhookService', () => ({ publishWebhookEvent: hoisted.publishWebhook }));
vi.mock('@/lib/services/models/modelService', () => ({ getModelByKey: hoisted.getModelByKey }));
vi.mock('@/lib/services/agents/gatewayChatModel', () => ({ buildGatewayChatModel: hoisted.buildGatewayChatModel, isDynamicModel: () => false, }));
vi.mock('@/lib/services/models/usageLogger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/models/usageLogger')>();
  return { ...actual, logModelUsage: hoisted.logModelUsage };
});
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
import type { IAgentConversation } from '@/lib/database';
import type { IAgentConversationMessage } from '@/lib/database/provider/types.domain';
import { SQLiteProvider } from '@/lib/database/sqlite.provider';
import { executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import {
  FeedbackError,
  listAgentFeedback,
  listSessionFeedback,
  messageIdOf,
  recordMessageFeedback,
  summarizeAgentFeedback,
  toFeedbackView,
} from '@/lib/services/agents/agentFeedback';
import {
  SessionEditError,
  planRerun,
  rerunSessionTurn,
  truncateSessionAfterMessage,
} from '@/lib/services/agents/sessionTruncate';
import {
  cleanGeneratedTitle,
  generateAndStoreConversationTitle,
  generateConversationTitle,
  resolveTitleModelKey,
} from '@/lib/services/agents/conversationTitle';

const DB_NAME = 'tenant_session_edit';
const PROJECT_ID = 'proj-1';
const AGENT_KEY = 'chat-agent';
const OWNER = 'user-1';

type Reply = Record<string, unknown>;

class ScriptedModel {
  readonly modelName = 'scripted-model';
  seen: Array<Array<{ role: string; content: unknown }>> = [];
  constructor(private readonly script: (call: number, messages: Array<{ role: string; content: unknown }>) => Reply) {}
  bindTools() {
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

function scriptModel(script: ConstructorParameters<typeof ScriptedModel>[0]): ScriptedModel {
  const model = new ScriptedModel(script);
  hoisted.buildGatewayChatModel.mockImplementation(async (input: Parameters<typeof settlingModel>[0]) => settlingModel(input, model));
  return model;
}

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 9, minutes, 0));

function message(role: 'user' | 'assistant', content: string, minutes: number, extra: Partial<IAgentConversationMessage> = {}): IAgentConversationMessage {
  return { role, content, timestamp: at(minutes), ...extra };
}

async function createAgent() {
  await db.createAgent({
    tenantId, projectId: PROJECT_ID, key: AGENT_KEY, name: 'Chat agent', config: { modelKey: 'gpt-4o' }, status: 'active', createdBy: OWNER,
  });
}

async function conversationWith(messages: IAgentConversationMessage[], extra: Partial<IAgentConversation> = {}): Promise<string> {
  const conversation = await db.createAgentConversation({
    tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, title: 'New conversation', messages, createdBy: OWNER, ...extra,
  });
  return String(conversation._id);
}

const scope = (conversationId: string) => ({ tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, conversationId });
const actor = { userId: OWNER, channel: 'portal' };

/** user, assistant, user, assistant, user, assistant */
const THREE_TURNS = () => [
  message('user', 'first question', 1),
  message('assistant', 'first answer', 2),
  message('user', 'second question', 3, { attachments: [{ fileId: 'file-2', name: 'b.pdf', mimeType: 'application/pdf', size: 10 }] }),
  message('assistant', 'second answer', 4),
  message('user', 'third question', 5),
  message('assistant', 'third answer', 6),
];

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(tmpdir(), 'agent-session-edit-'));
  db = new SQLiteProvider(tmpDir, 'test_main');
  await db.connect();
  hoisted.getDatabase.mockResolvedValue(db);
  hoisted.db.current = db;
  (getDatabase as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  const tenant = await db.createTenant({
    companyName: 'Acme', slug: 'acme-session-edit', dbName: DB_NAME, licenseType: 'FREE', ownerId: 'owner-1',
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
  hoisted.logModelUsage.mockResolvedValue(undefined);
});

afterEach(async () => {
  await db.disconnect();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Truncate ──────────────────────────────────────────────────────────

describe('truncateSessionAfterMessage', () => {
  it('keeps the messages up to the index, drops the carried state, logs session.truncated and remembers the files it cut', async () => {
    await createAgent();
    const id = await conversationWith(THREE_TURNS());
    await db.saveAgentConversationState({
      conversationId: id, tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, snapshot: '{"messages":[]}', messageCount: 6, sizeBytes: 14,
    });

    const result = await truncateSessionAfterMessage({ ...scope(id), keepThrough: 1, actor });

    expect(result.kept.map((m) => m.content)).toEqual(['first question', 'first answer']);
    expect(result.removed.map((m) => m.content)).toEqual(['second question', 'second answer', 'third question', 'third answer']);
    const stored = (await db.findAgentConversationById(id))!;
    expect(stored.messages.map((m) => m.content)).toEqual(['first question', 'first answer']);
    expect(await db.findAgentConversationState(id)).toBeNull(); // the next turn rebuilds from the transcript
    // The file the cut message carried was sent already: it must not ride along on the next message.
    expect(stored.metadata?.sentFileIds).toEqual(['file-2']);

    const logged = (await db.listAgentSessionEvents(id)).filter((e) => e.type === 'session.truncated');
    expect(logged).toHaveLength(1);
    expect(logged[0].data).toMatchObject({
      reason: 'truncate', keptMessages: 2, removedMessages: 4, removedFrom: 2, cancelledActions: 0, by: OWNER, channel: 'portal',
    });
    const audit = hoisted.recordAuditLog.mock.calls.map((call) => call[1]).find((entry) => entry.event === 'agent.session.truncate');
    expect(audit?.metadata).toMatchObject({ keptMessages: 2, removedMessages: 4, channel: 'portal' });
  });

  it('marks the ratings of the messages it cut, and leaves the others', async () => {
    await createAgent();
    const messages = THREE_TURNS();
    const id = await conversationWith(messages);
    for (const index of [1, 3, 5]) {
      await recordMessageFeedback({
        ...scope(id), message: { index }, userId: 'u9', channel: 'portal', rating: 'down', reasons: ['other'],
      });
    }
    await truncateSessionAfterMessage({ ...scope(id), keepThrough: 3, actor });
    const rows = await db.listAgentMessageFeedbackByConversation(id);
    expect(rows.map((row) => [row.messageIndex, Boolean(row.removedAt)])).toEqual([[1, false], [3, false], [5, true]]);
  });

  it('removing nothing is not an error and writes nothing', async () => {
    await createAgent();
    const id = await conversationWith(THREE_TURNS());
    const result = await truncateSessionAfterMessage({ ...scope(id), keepThrough: 5, actor });
    expect(result.removed).toEqual([]);
    expect((await db.listAgentSessionEvents(id)).filter((e) => e.type === 'session.truncated')).toEqual([]);
    expect((await db.findAgentConversationById(id))!.messages).toHaveLength(6);
  });

  it('-1 clears the transcript', async () => {
    await createAgent();
    const id = await conversationWith(THREE_TURNS());
    await truncateSessionAfterMessage({ ...scope(id), keepThrough: -1, actor });
    expect((await db.findAgentConversationById(id))!.messages).toEqual([]);
  });

  it('refuses a session that is another project\'s, another agent\'s, running, or an index it does not have', async () => {
    await createAgent();
    const id = await conversationWith(THREE_TURNS());
    const refused = async (input: Parameters<typeof truncateSessionAfterMessage>[0]) => {
      try {
        await truncateSessionAfterMessage(input);
        return null;
      } catch (error) {
        return error as SessionEditError;
      }
    };
    expect(await refused({ ...scope(id), projectId: 'proj-2', keepThrough: 1, actor })).toMatchObject({ status: 404, code: 'session_not_found' });
    expect(await refused({ ...scope(id), agentKey: 'someone-else', keepThrough: 1, actor })).toMatchObject({ status: 404, code: 'session_not_found' });
    expect(await refused({ ...scope('missing'), keepThrough: 1, actor })).toMatchObject({ status: 404, code: 'session_not_found' });
    expect(await refused({ ...scope(id), keepThrough: 99, actor })).toMatchObject({ status: 404, code: 'message_not_found' });
    expect(await refused({ ...scope(id), keepThrough: -2, actor })).toMatchObject({ status: 404, code: 'message_not_found' });

    await db.updateAgentConversationRuntime(id, { runtimeStatus: 'running', runtimeTurnId: 'turn-1' });
    expect(await refused({ ...scope(id), keepThrough: 1, actor })).toMatchObject({ status: 409, code: 'conversation_busy' });
    expect((await db.findAgentConversationById(id))!.messages).toHaveLength(6);
  });

  it('cancels a request that was open on the messages it cut and shows it cancelled on the one it kept', async () => {
    await createAgent();
    const paused = message('assistant', '', 2, {
      stopReason: 'paused',
      pendingActions: [{ id: 'act-1', kind: 'client_tool', toolName: 'get_selection', status: 'pending' }],
    });
    const id = await conversationWith([message('user', 'q', 1), paused, message('user', 'later', 3)], {
      runtimeStatus: 'requires_action', pendingActionIds: ['act-1'],
    });
    const [action] = await db.createAgentPendingActions([{
      tenantId, projectId: PROJECT_ID, agentKey: AGENT_KEY, conversationId: id, kind: 'client_tool', sdkId: 'sdk-1',
      toolName: 'get_selection', status: 'pending', requestedAt: new Date(), createdBy: OWNER,
    }]);

    const result = await truncateSessionAfterMessage({ ...scope(id), keepThrough: 1, actor });

    expect(result.cancelledActions).toBe(1);
    expect((await db.findAgentPendingActionById(String(action._id)))?.status).toBe('cancelled');
    const stored = (await db.findAgentConversationById(id))!;
    expect(stored.runtimeStatus).toBe('idle');
    expect(stored.pendingActionIds ?? []).toEqual([]);
    expect(stored.messages).toHaveLength(2);
  });
});

// ── Re-running ────────────────────────────────────────────────────────

describe('planRerun', () => {
  it('regenerate: the latest answer, the user message before it, the files it carried, and what it replaces', () => {
    const messages = [
      message('user', 'q', 1, { attachments: [{ fileId: 'f1', name: 'a.txt', mimeType: 'text/plain', size: 1 }] }),
      message('assistant', 'old answer', 2, { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, previousVersions: [{ content: 'older', timestamp: at(0) }] }),
    ];
    const plan = planRerun(messages, { mode: 'regenerate', messageIndex: 1 });
    expect(plan).toMatchObject({ mode: 'regenerate', userMessage: 'q', fileIds: ['f1'], userIndex: 0 });
    expect(plan.previousVersions.map((v) => v.content)).toEqual(['older', 'old answer']);
    expect(plan.previousVersions[1].usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
  });

  it('regenerate keeps the cache and reasoning split of the answer it replaces', () => {
    const usage = { inputTokens: 550, outputTokens: 40, cachedInputTokens: 500, cachedWriteTokens: 30, reasoningTokens: 12, totalTokens: 590, costUsd: 0.02 };
    const plan = planRerun([message('user', 'q', 1), message('assistant', 'old answer', 2, { usage })], { mode: 'regenerate', messageIndex: 1 });
    expect(plan.previousVersions[0].usage).toEqual(usage);
  });

  it('keeps at most five earlier answers', () => {
    const versions = Array.from({ length: 5 }, (_, i) => ({ content: `v${i}`, timestamp: at(i) }));
    const plan = planRerun([message('user', 'q', 1), message('assistant', 'now', 2, { previousVersions: versions })], { mode: 'regenerate', messageIndex: 1 });
    expect(plan.previousVersions.map((v) => v.content)).toEqual(['v1', 'v2', 'v3', 'v4', 'now']);
  });

  it('refuses to regenerate anything but the latest answer, a user message, or an answer with nothing before it', () => {
    const messages = THREE_TURNS();
    expect(() => planRerun(messages, { mode: 'regenerate', messageIndex: 3 })).toThrow(expect.objectContaining({ code: 'not_latest_answer', status: 409 }));
    expect(() => planRerun(messages, { mode: 'regenerate', messageIndex: 4 })).toThrow(expect.objectContaining({ code: 'not_an_assistant_message' }));
    expect(() => planRerun([message('assistant', 'hi', 1)], { mode: 'regenerate', messageIndex: 0 })).toThrow(expect.objectContaining({ code: 'message_not_found' }));
    expect(() => planRerun(messages, { mode: 'regenerate', messageIndex: 40 })).toThrow(expect.objectContaining({ code: 'message_not_found' }));
  });

  it('edit: only a user message; the new text, and the original files unless others are given', () => {
    const messages = THREE_TURNS();
    expect(planRerun(messages, { mode: 'edit', messageIndex: 2, content: '  edited  ' })).toMatchObject({
      mode: 'edit', userMessage: 'edited', fileIds: ['file-2'], userIndex: 2, previousVersions: [],
    });
    expect(planRerun(messages, { mode: 'edit', messageIndex: 2, content: 'x', fileIds: [] }).fileIds).toEqual([]);
    expect(() => planRerun(messages, { mode: 'edit', messageIndex: 1, content: 'x' })).toThrow(expect.objectContaining({ code: 'not_a_user_message' }));
    expect(() => planRerun(messages, { mode: 'edit', messageIndex: 0, content: '   ', fileIds: [] })).toThrow(expect.objectContaining({ code: 'empty_message' }));
  });
});

describe('rerunSessionTurn', () => {
  const run = (id: string, target: Parameters<typeof rerunSessionTurn>[0]['target']) => rerunSessionTurn({
    ...scope(id),
    target,
    actor,
    run: (prepared) => executePlaygroundChatLocal({
      ...scope(id),
      agentKey: AGENT_KEY,
      userMessage: prepared.userMessage,
      ...(prepared.fileIds.length > 0 ? { attachments: prepared.fileIds } : {}),
      previousVersions: prepared.previousVersions,
      runtimeContext: { userId: OWNER, source: 'playground' },
    }),
  });

  it('regenerate runs the user message again; the answer is replaced and the old one remembered', async () => {
    await createAgent();
    const model = scriptModel(() => ({ role: 'assistant', content: 'a better answer' }));
    const id = await conversationWith([message('user', 'what is 2+2?', 1), message('assistant', 'five', 2)]);
    await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u9', channel: 'portal', rating: 'down', reasons: ['inaccurate'], comment: 'wrong' });

    const result = await run(id, { mode: 'regenerate', messageIndex: 1 });

    expect(result.content).toBe('a better answer');
    const stored = (await db.findAgentConversationById(id))!;
    expect(stored.messages.map((m) => [m.role, m.content])).toEqual([['user', 'what is 2+2?'], ['assistant', 'a better answer']]);
    expect(stored.messages[1].previousVersions?.map((v) => v.content)).toEqual(['five']);
    // The model was shown the question once, not twice.
    expect(model.seen[0].filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['what is 2+2?']);
    // The rating of the replaced answer still counts, marked as removed.
    const [rating] = await db.listAgentMessageFeedbackByConversation(id);
    expect(rating.removedAt).toBeTruthy();
    expect((await summarizeAgentFeedback(DB_NAME, { projectId: PROJECT_ID, agentKey: AGENT_KEY })).down).toBe(1);
    // The new answer is a different message: it can be rated afresh.
    const next = await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u9', channel: 'portal', rating: 'up' });
    expect(next.messageId).not.toBe(rating.messageId);
    const events = (await db.listAgentSessionEvents(id)).map((e) => e.type);
    expect(events).toContain('session.truncated');
  });

  it('edit drops everything after the message and runs the new text from the earlier context', async () => {
    await createAgent();
    const model = scriptModel(() => ({ role: 'assistant', content: 'reply to the edit' }));
    const id = await conversationWith(THREE_TURNS());

    // The message carried a file; the edit drops it (this agent takes no files).
    await run(id, { mode: 'edit', messageIndex: 2, content: 'second question, reworded', fileIds: [] });

    const stored = (await db.findAgentConversationById(id))!;
    expect(stored.messages.map((m) => m.content)).toEqual([
      'first question', 'first answer', 'second question, reworded', 'reply to the edit',
    ]);
    const shown = model.seen[0].filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => String(m.content));
    expect(shown).toEqual(['first question', 'first answer', 'second question, reworded']);
    expect(stored.messages[3].previousVersions).toBeUndefined();
  });

  it('puts the transcript back when the new turn cannot run, and does not mark any rating', async () => {
    await createAgent();
    hoisted.buildGatewayChatModel.mockRejectedValue(new Error('provider is down'));
    const id = await conversationWith(THREE_TURNS());
    await recordMessageFeedback({ ...scope(id), message: { index: 5 }, userId: 'u9', channel: 'portal', rating: 'up' });

    await expect(run(id, { mode: 'regenerate', messageIndex: 5 })).rejects.toThrow('provider is down');

    const stored = (await db.findAgentConversationById(id))!;
    expect(stored.messages.map((m) => m.content)).toEqual(THREE_TURNS().map((m) => m.content));
    expect((await db.listAgentMessageFeedbackByConversation(id))[0].removedAt ?? null).toBeNull();
  });

  it('refuses before changing anything', async () => {
    await createAgent();
    const id = await conversationWith(THREE_TURNS());
    await expect(run(id, { mode: 'regenerate', messageIndex: 3 })).rejects.toMatchObject({ code: 'not_latest_answer' });
    expect((await db.findAgentConversationById(id))!.messages).toHaveLength(6);
    expect((await db.listAgentSessionEvents(id)).some((e) => e.type === 'session.truncated')).toBe(false);
  });

  it('files the cut messages carried do not ride along on the re-run message', async () => {
    await createAgent();
    scriptModel(() => ({ role: 'assistant', content: 'ok' }));
    const id = await conversationWith(THREE_TURNS());
    const seen: Array<string[] | undefined> = [];
    await rerunSessionTurn({
      ...scope(id),
      target: { mode: 'edit', messageIndex: 0, content: 'first question, reworded' },
      actor,
      run: async (prepared) => {
        seen.push(prepared.fileIds);
        return null;
      },
    });
    expect(seen).toEqual([[]]);
    const stored = (await db.findAgentConversationById(id))!;
    expect(stored.metadata?.sentFileIds).toEqual(['file-2']);
  });
});

// ── Feedback ──────────────────────────────────────────────────────────

describe('recordMessageFeedback', () => {
  async function rated() {
    await createAgent();
    const id = await conversationWith([message('user', 'q', 1), message('assistant', 'an answer', 2, { version: 4 })]);
    return id;
  }

  it('stores the rating with its reasons and comment, and tells the webhook, the audit trail and the trace', async () => {
    const id = await rated();
    // Two turns of the thread: the second one began after the answer was written, so it is not the answer's turn.
    const session = (sessionId: string, startedAt: Date) => db.createAgentTracingSession({
      sessionId, traceId: `trace-${sessionId}`, rootSpanId: `root-${sessionId}`, threadId: id, tenantId, projectId: PROJECT_ID,
      source: 'custom', agent: {}, config: {}, metadata: {}, summary: {}, status: 'success', startedAt, errors: [],
      modelsUsed: [], toolsUsed: [], eventCounts: {}, totalEvents: 3, totalInputTokens: 0, totalOutputTokens: 0,
      totalCachedInputTokens: 0, totalReasoningTokens: 0, truncatedEvents: 0,
    });
    await session('turn-1', at(1));
    await session('turn-2', at(30));

    const result = await recordMessageFeedback({
      ...scope(id), message: { index: 1 }, userId: 'u9', email: 'u9@example.com', channel: 'portal', portalId: 'portal-1',
      rating: 'down', reasons: ['inaccurate', 'too_long', 'inaccurate'], comment: '  the date is wrong  ',
    });

    expect(result).toMatchObject({ withdrawn: false, created: true, messageIndex: 1 });
    expect(result.feedback).toMatchObject({
      rating: 'down', reasons: ['inaccurate', 'too_long'], comment: 'the date is wrong', agentVersion: 4, portalId: 'portal-1', channel: 'portal',
    });
    expect(result.messageId).toBe(messageIdOf(id, 1, (await db.findAgentConversationById(id))!.messages[1]));

    await vi.waitFor(() => expect(hoisted.publishWebhook).toHaveBeenCalled());
    const published = hoisted.publishWebhook.mock.calls[0][0];
    expect(published).toMatchObject({ type: 'feedback.recorded', projectId: PROJECT_ID });
    expect(published.data).toMatchObject({
      conversationId: id, agentKey: AGENT_KEY, rating: 'down', reasons: ['inaccurate', 'too_long'], hasComment: true, channel: 'portal', portalId: 'portal-1',
    });
    expect(JSON.stringify(published.data)).not.toContain('date is wrong'); // the words stay out of the webhook

    await vi.waitFor(() => expect(hoisted.recordAuditLog).toHaveBeenCalled());
    const audit = hoisted.recordAuditLog.mock.calls.map((call) => call[1]).find((entry) => entry.event === 'agent.message.feedback');
    expect(audit).toMatchObject({ actorUserId: 'u9', resourceId: id });
    expect(JSON.stringify(audit.metadata)).not.toContain('date is wrong');

    await vi.waitFor(async () => expect((await db.listAgentTracingEvents('turn-1', PROJECT_ID)).length).toBe(1));
    const [traceEvent] = await db.listAgentTracingEvents('turn-1', PROJECT_ID);
    expect(traceEvent).toMatchObject({ type: 'feedback', label: 'Feedback: not helpful', sequence: 4 });
    expect(traceEvent.metadata).toMatchObject({ rating: 'down', messageIndex: 1, hasComment: true });
    expect(await db.listAgentTracingEvents('turn-2', PROJECT_ID)).toEqual([]);
  });

  it('rating again replaces it; thumbs up carry no reasons', async () => {
    const id = await rated();
    await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u9', channel: 'portal', rating: 'down', reasons: ['unsafe'] });
    const again = await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u9', channel: 'portal', rating: 'up', reasons: ['unsafe'] });
    expect(again.created).toBe(false);
    expect(again.feedback).toMatchObject({ rating: 'up', reasons: [] });
    expect(await db.listAgentMessageFeedbackByConversation(id)).toHaveLength(1);
  });

  it('null withdraws the person\'s rating, and says so', async () => {
    const id = await rated();
    await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u9', channel: 'portal', rating: 'down' });
    const result = await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u9', channel: 'portal', rating: null });
    expect(result).toMatchObject({ withdrawn: true, feedback: null });
    expect(await db.listAgentMessageFeedbackByConversation(id)).toEqual([]);
    await vi.waitFor(() => expect(hoisted.publishWebhook).toHaveBeenCalledTimes(2));
    expect(hoisted.publishWebhook.mock.calls[1][0].data).toMatchObject({ rating: null, withdrawn: true });
    // Withdrawing what was never rated is not an error.
    await expect(recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u2', channel: 'portal', rating: null })).resolves.toMatchObject({ withdrawn: true });
  });

  it('a message is addressed by its stable id or by its index', async () => {
    const id = await rated();
    const byIndex = await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u9', channel: 'portal', rating: 'up' });
    const byId = await recordMessageFeedback({ ...scope(id), message: { id: byIndex.messageId }, userId: 'u9', channel: 'portal', rating: 'down' });
    expect(byId.created).toBe(false);
    expect(byId.messageIndex).toBe(1);
    expect(await db.listAgentMessageFeedbackByConversation(id)).toHaveLength(1);
  });

  it('refuses what it cannot take, each with a code', async () => {
    const id = await rated();
    const base = { ...scope(id), userId: 'u9', channel: 'portal' };
    const refused = async (input: Parameters<typeof recordMessageFeedback>[0]) => {
      try {
        await recordMessageFeedback(input);
        return null;
      } catch (error) {
        return error as FeedbackError;
      }
    };
    expect(await refused({ ...base, message: { index: 0 }, rating: 'up' })).toMatchObject({ status: 400, code: 'not_an_answer' });
    expect(await refused({ ...base, message: { index: 9 }, rating: 'up' })).toMatchObject({ status: 404, code: 'message_not_found' });
    expect(await refused({ ...base, message: { id: 'msg_nope' }, rating: 'up' })).toMatchObject({ status: 404, code: 'message_not_found' });
    expect(await refused({ ...base, message: { index: 1 }, rating: 'meh' as never })).toMatchObject({ status: 400, code: 'invalid_rating' });
    expect(await refused({ ...base, message: { index: 1 }, rating: 'down', reasons: ['rude'] })).toMatchObject({ status: 400, code: 'invalid_reasons' });
    expect(await refused({ ...base, message: { index: 1 }, rating: 'down', reasons: 'inaccurate' })).toMatchObject({ status: 400, code: 'invalid_reasons' });
    expect(await refused({ ...base, message: { index: 1 }, rating: 'down', comment: 'x'.repeat(1001) })).toMatchObject({ status: 400, code: 'comment_too_long' });
    expect(await refused({ ...base, message: { index: 1 }, rating: 'down', comment: 42 })).toMatchObject({ status: 400, code: 'invalid_comment' });
    expect(await refused({ ...base, message: { index: 1 }, rating: 'down', comment: 'why', commentsAllowed: false })).toMatchObject({ status: 400, code: 'comments_disabled' });
    expect(await refused({ ...base, projectId: 'proj-2', message: { index: 1 }, rating: 'up' })).toMatchObject({ status: 404, code: 'session_not_found' });
    expect(await refused({ ...base, agentKey: 'someone-else', message: { index: 1 }, rating: 'up' })).toMatchObject({ status: 404, code: 'session_not_found' });
    // Nothing was stored by any of them, and an exactly-limit comment is fine.
    expect(await db.listAgentMessageFeedbackByConversation(id)).toEqual([]);
    expect((await recordMessageFeedback({ ...base, message: { index: 1 }, rating: 'down', comment: 'x'.repeat(1000) })).feedback?.comment).toHaveLength(1000);
  });

  it('an empty comment is no comment; a comment is stripped of control characters', async () => {
    const id = await rated();
    const base = { ...scope(id), userId: 'u9', channel: 'portal', message: { index: 1 } };
    expect((await recordMessageFeedback({ ...base, rating: 'down', comment: '   ' })).feedback?.comment).toBeUndefined();
    expect((await recordMessageFeedback({ ...base, rating: 'down', comment: 'bad\u0000 \u0007answer' })).feedback?.comment).toBe('bad answer');
  });
});

describe('reading feedback back', () => {
  it('lists a session\'s ratings and an agent\'s, hides the words when asked, and summarises', async () => {
    await createAgent();
    const id = await conversationWith([message('user', 'q', 1), message('assistant', 'a', 2), message('user', 'q2', 3), message('assistant', 'a2', 4)]);
    await recordMessageFeedback({ ...scope(id), message: { index: 1 }, userId: 'u1', channel: 'portal', rating: 'up' });
    await recordMessageFeedback({ ...scope(id), message: { index: 3 }, userId: 'u1', channel: 'portal', rating: 'down', reasons: ['incomplete'], comment: 'missing the numbers' });
    await recordMessageFeedback({ ...scope(id), message: { index: 3 }, userId: 'u2', channel: 'embed', rating: 'down', reasons: ['incomplete', 'other'] });

    const session = await listSessionFeedback({ tenantDbName: DB_NAME, projectId: PROJECT_ID, conversationId: id, agentKey: AGENT_KEY });
    expect(session.map((row) => [row.messageIndex, row.userId, row.rating])).toEqual([[1, 'u1', 'up'], [3, 'u1', 'down'], [3, 'u2', 'down']]);
    await expect(listSessionFeedback({ tenantDbName: DB_NAME, projectId: 'proj-2', conversationId: id })).rejects.toMatchObject({ status: 404 });
    expect((await listSessionFeedback({ tenantDbName: DB_NAME, projectId: PROJECT_ID, conversationId: id, userId: 'u2' }))).toHaveLength(1);

    const withWords = toFeedbackView(session[1], { includeComment: true });
    const withoutWords = toFeedbackView(session[1], { includeComment: false });
    expect(withWords.comment).toBe('missing the numbers');
    expect(withoutWords.comment).toBeUndefined();
    expect(withWords).toMatchObject({ messageIndex: 3, rating: 'down', reasons: ['incomplete'], removed: false, channel: 'portal' });

    const page = await listAgentFeedback(DB_NAME, { projectId: PROJECT_ID, agentKey: AGENT_KEY }, { limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);

    expect(await summarizeAgentFeedback(DB_NAME, { projectId: PROJECT_ID, agentKey: AGENT_KEY })).toEqual({
      up: 1, down: 2, withComment: 1, reasons: { incomplete: 2, other: 1 }, total: 3, positiveRate: 1 / 3,
    });
    expect((await summarizeAgentFeedback(DB_NAME, { projectId: PROJECT_ID, agentKey: 'nobody' })).positiveRate).toBeNull();
  });

  it('a message keeps its id while the transcript grows, and a replacement message has another', () => {
    const first = message('assistant', 'a', 2);
    expect(messageIdOf('c1', 1, first)).toBe(messageIdOf('c1', 1, { ...first }));
    expect(messageIdOf('c1', 1, first)).not.toBe(messageIdOf('c1', 3, first));
    expect(messageIdOf('c1', 1, first)).not.toBe(messageIdOf('c2', 1, first));
    expect(messageIdOf('c1', 1, first)).not.toBe(messageIdOf('c1', 1, message('assistant', 'a', 9)));
    expect(messageIdOf('c1', 1, { ...first, id: 'explicit' })).toBe('explicit');
    // The same instant as a string (a stored transcript) gives the same id.
    expect(messageIdOf('c1', 1, { timestamp: at(2).toISOString() as unknown as Date })).toBe(messageIdOf('c1', 1, first));
  });
});

// ── Titles ────────────────────────────────────────────────────────────

describe('titles', () => {
  it('cleans what a model says into a short title', () => {
    expect(cleanGeneratedTitle('"Quarterly sales report analysis".')).toBe('Quarterly sales report analysis');
    expect(cleanGeneratedTitle('Title: Refund policy question')).toBe('Refund policy question');
    expect(cleanGeneratedTitle('**Reset my password**\nSure, here is why…')).toBe('Reset my password');
    expect(cleanGeneratedTitle('one two three four five six seven eight')).toBe('one two three four five six');
    expect(cleanGeneratedTitle('one two three four', 3)).toBe('one two three');
    expect(cleanGeneratedTitle('   ')).toBeNull();
    expect(cleanGeneratedTitle('""')).toBeNull();
    expect(cleanGeneratedTitle('x'.repeat(200))?.length).toBeLessThanOrEqual(80);
    expect(cleanGeneratedTitle('Fatura iade süreci nasıl işler?')).toBe('Fatura iade süreci nasıl işler');
  });

  it('picks the model from the surface\'s setting', () => {
    expect(resolveTitleModelKey('off', { modelKey: 'gpt-4o' })).toBeNull();
    expect(resolveTitleModelKey(undefined, { modelKey: 'gpt-4o' })).toBeNull();
    expect(resolveTitleModelKey('agent_model', { modelKey: 'gpt-4o' })).toBe('gpt-4o');
    expect(resolveTitleModelKey('agent_model', { modelKey: 'gpt-4o', kind: 'external' })).toBeNull();
    expect(resolveTitleModelKey('agent_model', undefined)).toBeNull();
    expect(resolveTitleModelKey('small-model', { modelKey: 'gpt-4o' })).toBe('small-model');
  });

  it('asks the model in the conversation\'s language and records the call as a title, for the person', async () => {
    const model = scriptModel(() => ({ role: 'assistant', content: '"Fatura iade süreci".' }));
    const title = await generateConversationTitle({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, modelKey: 'gpt-4o', userId: OWNER, agentKey: AGENT_KEY,
      exchange: { user: 'Faturamı nasıl iade ederim?', assistant: 'Önce iade formunu doldurmalısınız.' },
    });
    expect(title).toBe('Fatura iade süreci');
    const sent = model.seen[0];
    expect(String(sent[0].content)).toContain('at most 6 words');
    expect(String(sent[0].content)).toContain('language');
    expect(String(sent[1].content)).toContain('Faturamı nasıl iade ederim?');
    expect(String(sent[1].content)).toContain('Önce iade formunu');

    // The usage row is the gateway's (gateway-agent-model.test.ts): the title only says whose call it is.
    expect(hoisted.buildGatewayChatModel.mock.calls[0][0]).toMatchObject({
      route: 'agent.title', purpose: 'title', agentKey: AGENT_KEY, userId: OWNER, model: { key: 'gpt-4o' },
    });
  });

  it('is "no title" — never an error — when the model is gone, fails or says nothing', async () => {
    const input = {
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, modelKey: 'gpt-4o', exchange: { user: 'hi', assistant: 'hello' },
    };
    // Looked up twice: for the title's reasoning, and again to build the model.
    hoisted.getModelByKey.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await generateConversationTitle(input)).toBeNull();
    hoisted.buildGatewayChatModel.mockRejectedValueOnce(new Error('down'));
    expect(await generateConversationTitle(input)).toBeNull();
    scriptModel(() => ({ role: 'assistant', content: '   ' }));
    expect(await generateConversationTitle(input)).toBeNull();
    expect(await generateConversationTitle({ ...input, exchange: { user: ' ', assistant: '' } })).toBeNull();
  });

  describe('naming a stored conversation', () => {
    const name = (id: string) => generateAndStoreConversationTitle({
      tenantDbName: DB_NAME, tenantId, projectId: PROJECT_ID, modelKey: 'gpt-4o', userId: OWNER, conversationId: id,
    });

    it('replaces the default title after the first exchange, once', async () => {
      await createAgent();
      scriptModel(() => ({ role: 'assistant', content: 'Refund policy' }));
      const id = await conversationWith([message('user', 'how do refunds work', 1), message('assistant', 'within 14 days', 2)], { title: 'how do refunds work' });

      expect(await name(id)).toBe('Refund policy');
      const stored = (await db.findAgentConversationById(id))!;
      expect(stored.title).toBe('Refund policy');
      expect(stored.metadata?.titleSource).toBe('generated');
      // Once: a second call does nothing.
      expect(await name(id)).toBeNull();
    });

    it('leaves a title a person chose, a conversation that moved on, and one with no answer yet', async () => {
      await createAgent();
      scriptModel(() => ({ role: 'assistant', content: 'Generated' }));
      const exchange = [message('user', 'q', 1), message('assistant', 'a', 2)];

      const renamed = await conversationWith(exchange, { title: 'My own title' });
      expect(await name(renamed)).toBeNull();
      const marked = await conversationWith(exchange, { title: 'q', metadata: { titleSource: 'user' } });
      expect(await name(marked)).toBeNull();
      const movedOn = await conversationWith([...exchange, message('user', 'q2', 3), message('assistant', 'a2', 4)], { title: 'q' });
      expect(await name(movedOn)).toBeNull();
      const unanswered = await conversationWith([message('user', 'q', 1)], { title: 'q' });
      expect(await name(unanswered)).toBeNull();
      expect((await db.findAgentConversationById(renamed))!.title).toBe('My own title');
    });

    it('does not overwrite a rename that happened while the model was thinking', async () => {
      await createAgent();
      const id = await conversationWith([message('user', 'q', 1), message('assistant', 'a', 2)], { title: 'q' });
      scriptModel(() => {
        // The person renames it while the title is being written.
        void db.updateAgentConversation(id, { title: 'Renamed', metadata: { titleSource: 'user' } });
        return { role: 'assistant', content: 'Generated' };
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await name(id);
      const stored = (await db.findAgentConversationById(id))!;
      expect(stored.title === 'Renamed' ? result === null : stored.title === 'Generated').toBe(true);
    });
  });
});
