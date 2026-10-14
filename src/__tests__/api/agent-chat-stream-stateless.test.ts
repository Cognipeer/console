/**
 * `POST /agents/:id/chat/stream` as Compare versions uses it: a stateless turn pinned to a
 * version that carries its own history, asks for the thinking text on the operator's say-so,
 * streams it as `reasoning` events beside `text`, and ends when the client goes away.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
    return {
        ...actual,
        requireProjectContextForRequest: vi.fn(),
        sendProjectContextError: vi.fn().mockReturnValue(null),
        authorizeResourceForRequest: vi.fn(async () => ({ allowed: true, source: 'engine', reasons: [], policyIds: [] })),
    };
});

vi.mock('@/lib/database', async () => {
    const errors = await import('@/lib/database/provider/errors');
    return {
        getDatabase: vi.fn(),
        AgentRunConflictError: errors.AgentRunConflictError,
        AgentRunIdempotencyKeyTakenError: errors.AgentRunIdempotencyKeyTakenError,
    };
});

vi.mock('@/lib/services/agents', () => ({
    createAgentRecord: vi.fn(),
    createConversation: vi.fn(),
    deleteAgentRecord: vi.fn(),
    deleteConversation: vi.fn(),
    executePlaygroundChat: vi.fn(),
    getAgentById: vi.fn(),
    getAgentVersion: vi.fn(),
    getConversationById: vi.fn(),
    listAgents: vi.fn(),
    listAgentVersions: vi.fn(),
    listConversations: vi.fn(),
    normalizeA2aMetadataUpdate: vi.fn(),
    prepareConnectionForStorage: vi.fn(),
    publishAgent: vi.fn(),
    updateAgentRecord: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
    executePlaygroundChatLocal: vi.fn(),
    executeAgentContinueLocal: vi.fn(),
    AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

vi.mock('@/lib/services/agents/agentQuota', () => ({
    enforceAgentRunQuota: vi.fn(async () => undefined),
    settleAgentRun: vi.fn(),
}));

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getAgentById } from '@/lib/services/agents';
import { executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const CTX = {
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'member', email: 'a@b.c' },
    userProject: { role: 'project_admin' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};
const AGENT = { _id: 'agent-1', key: 'field-ops', name: 'Field Ops', status: 'active', projectId: 'proj-1', config: { modelKey: 'm', showReasoning: false } };
const headers = { authorization: 'Bearer t' };
const URL = '/api/agents/agent-1/chat/stream';
const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const events = (body: string) => body.split('\n\n').filter(Boolean).map((block) => ({
    event: /event: (.+)/.exec(block)?.[1],
    data: /data: (.+)/.exec(block)?.[1] ? JSON.parse(/data: (.+)/.exec(block)![1]) : undefined,
}));

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(CTX);
    mockFn(getAgentById).mockResolvedValue(AGENT);
});

describe('POST /agents/:id/chat/stream, stateless', () => {
    it('hands the version, the history and the operator-view flag to the run and streams reasoning beside text', async () => {
        mockFn(executePlaygroundChatLocal).mockImplementation(async (request: { onTextChunk: (t: string) => void; onReasoningChunk: (t: string) => void }) => {
            request.onReasoningChunk('Let me think. ');
            request.onTextChunk('Answer');
            return { content: 'Answer', reasoning: 'Let me think. ', version: 3 };
        });
        const app = await createFastifyApiTestApp(agentsApiPlugin);
        const res = await app.inject({
            method: 'POST', url: URL, headers,
            payload: {
                message: 'and now?', version: 3, showReasoning: true,
                history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'assistant' }, null],
            },
        });

        expect(res.statusCode).toBe(200);
        expect(events(res.body).map((entry) => entry.event)).toEqual(['reasoning', 'text', 'result']);
        expect(events(res.body)[0].data).toEqual({ text: 'Let me think. ' });
        expect(events(res.body)[2].data).toMatchObject({ content: 'Answer', reasoning: 'Let me think. ' });
        expect(executePlaygroundChatLocal).toHaveBeenCalledWith(expect.objectContaining({
            version: 3,
            revealReasoning: true,
            history: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }],
        }));
        expect(mockFn(executePlaygroundChatLocal).mock.calls[0][0].conversationId).toBeUndefined();
    });

    it('does not reveal reasoning unless asked, and still streams a normal turn', async () => {
        mockFn(executePlaygroundChatLocal).mockResolvedValue({ content: 'ok', version: null });
        const app = await createFastifyApiTestApp(agentsApiPlugin);
        const res = await app.inject({ method: 'POST', url: URL, headers, payload: { message: 'hi' } });
        expect(res.statusCode).toBe(200);
        const call = mockFn(executePlaygroundChatLocal).mock.calls[0][0];
        expect(call.revealReasoning).toBeUndefined();
        expect(call.history).toBeUndefined();
    });

    it('a stateless turn carries an abort signal, which a closed stream fires (that is its Stop)', async () => {
        mockFn(executePlaygroundChatLocal).mockResolvedValue({ content: 'ok', version: null });
        const app = await createFastifyApiTestApp(agentsApiPlugin);
        await app.inject({ method: 'POST', url: URL, headers, payload: { message: 'hi' } });
        const signal = mockFn(executePlaygroundChatLocal).mock.calls[0][0].signal as AbortSignal;
        expect(signal).toBeInstanceOf(AbortSignal);
        // The run finished normally: the stream ending afterwards is not a Stop.
        expect(signal.aborted).toBe(false);
    });
});
