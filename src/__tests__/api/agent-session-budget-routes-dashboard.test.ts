/**
 * The dashboard's session-budget routes: `PATCH /agents/:agentId/sessions/:sessionId`
 * (add / raise / remove), `POST …/sessions/:sessionId/continue` (JSON and
 * `?stream=1` SSE), the budget on a new session, and the 402 a chat message gets
 * once the budget is used up. The budget logic itself is covered end to end in
 * `integration/agent-session-budget.test.ts`; faked here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
    return {
        ...actual,
        requireProjectContextForRequest: vi.fn(),
        sendProjectContextError: vi.fn().mockReturnValue(null),
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

vi.mock('@/lib/services/agents/agentActionResolution', () => ({
    resolveAgentPendingAction: vi.fn(),
    pendingActionsBlockingMessage: vi.fn(),
}));

vi.mock('@/lib/services/agents/sessionBudgetService', () => ({ updateSessionBudget: vi.fn() }));

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getDatabase } from '@/lib/database';
import { createConversation, getAgentById, getConversationById } from '@/lib/services/agents';
import { executeAgentContinueLocal, executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { pendingActionsBlockingMessage } from '@/lib/services/agents/agentActionResolution';
import { updateSessionBudget } from '@/lib/services/agents/sessionBudgetService';
import { AgentBudgetReachedError } from '@/lib/services/agents/agentErrors';
import { AgentResumeError } from '@/lib/services/agents/agentPendingActions';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const SESSION_CTX = {
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'member', email: 'a@b.c' },
    userProject: { role: 'project_admin' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};
const AGENT = {
    _id: 'agent-1', key: 'field-ops', name: 'Field Ops', status: 'active', projectId: 'proj-1',
    config: { modelKey: 'gpt-5-terra' },
};
const CONVERSATION = {
    _id: 'conv-1', agentKey: 'field-ops', projectId: 'proj-1', messages: [], createdBy: 'user-1', metadata: { source: 'console' },
};
const headers = { authorization: 'Bearer t' };
const SESSION_URL = '/api/agents/agent-1/sessions/conv-1';
const RESULT = { content: 'Done.', version: null, steps: [] };

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const createDb = () => ({ createAgentRun: vi.fn(async () => ({ _id: 'res-1' })), deleteAgentRun: vi.fn() });
let db: ReturnType<typeof createDb>;

beforeEach(() => {
    vi.clearAllMocks();
    db = createDb();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    mockFn(getAgentById).mockResolvedValue(AGENT);
    mockFn(getConversationById).mockResolvedValue(CONVERSATION);
    mockFn(pendingActionsBlockingMessage).mockResolvedValue(null);
    mockFn(getDatabase).mockResolvedValue(db);
});

const build = async () => createFastifyApiTestApp(agentsApiPlugin);
const events = (body: string) => body.split('\n\n').filter(Boolean).map((block) => ({
    event: /event: (.+)/.exec(block)?.[1],
    data: /data: (.+)/.exec(block)?.[1] ? JSON.parse(/data: (.+)/.exec(block)![1]) : undefined,
}));

describe('PATCH …/sessions/:sessionId', () => {
    it('hands the budget to the service and returns the updated session', async () => {
        mockFn(updateSessionBudget).mockResolvedValue({ kind: 'ok', wasBudgetPaused: true, conversation: { ...CONVERSATION, budget: { maxCostUsd: 5, onReach: 'pause' } } });
        const app = await build();
        const res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { maxCostUsd: 5, onReach: 'pause' } } });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).session.budget).toEqual({ maxCostUsd: 5, onReach: 'pause' });
        expect(updateSessionBudget).toHaveBeenCalledWith({
            tenantDbName: 'tenant_acme', projectId: 'proj-1', conversationId: 'conv-1', budget: { maxCostUsd: 5, onReach: 'pause' },
        });
    });

    it('null removes the budget; a body without one is a 400; the service\'s refusal is a 400', async () => {
        mockFn(updateSessionBudget).mockResolvedValue({ kind: 'ok', wasBudgetPaused: false, conversation: CONVERSATION });
        const app = await build();
        expect((await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: null } })).statusCode).toBe(200);
        expect(mockFn(updateSessionBudget).mock.calls[0][0].budget).toBeNull();

        expect((await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: {} })).statusCode).toBe(400);

        mockFn(updateSessionBudget).mockResolvedValue({ kind: 'invalid', message: 'budget.maxCostUsd must be greater than what the session has already spent ($2).' });
        const res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: { maxCostUsd: 1 } } });
        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toContain('greater than');
    });

    it('404s a session of another agent', async () => {
        mockFn(getConversationById).mockResolvedValue({ ...CONVERSATION, agentKey: 'someone-else' });
        const app = await build();
        const res = await app.inject({ method: 'PATCH', url: SESSION_URL, headers, payload: { budget: null } });
        expect(res.statusCode).toBe(404);
        expect(updateSessionBudget).not.toHaveBeenCalled();
    });
});

describe('POST …/sessions/:sessionId/continue', () => {
    it('continues the session with no message and holds the session\'s run slot meanwhile', async () => {
        mockFn(executeAgentContinueLocal).mockResolvedValue({ result: RESULT, response: {}, stopReason: 'end_turn' });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: `${SESSION_URL}/continue`, headers, payload: {} });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ status: 'continued', result: RESULT });
        expect(executeAgentContinueLocal).toHaveBeenCalledWith(expect.objectContaining({
            tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'field-ops',
            conversationId: 'conv-1', userId: 'user-1',
            continuation: { source: 'agent-playground' },
        }));
        expect(db.createAgentRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'sync', conversationId: 'conv-1', userMessage: '' }));
        expect(db.deleteAgentRun).toHaveBeenCalled(); // the slot is released
    });

    it('streams the continuation as SSE in the chat/stream event format', async () => {
        mockFn(executeAgentContinueLocal).mockImplementation(async (request: { onToolEvent?: (e: unknown) => void; onTextChunk?: (t: string) => void }) => {
            request.onToolEvent?.({ phase: 'start', name: 'sandbox_read_file' });
            request.onTextChunk?.('Do');
            return { result: RESULT, response: {}, stopReason: 'end_turn' };
        });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: `${SESSION_URL}/continue?stream=1`, headers, payload: {} });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        const sent = events(res.body);
        expect(sent.map((e) => e.event)).toEqual(['tool', 'text', 'result']);
        expect(sent[2].data).toEqual(RESULT);
    });

    it.each([
        [new AgentBudgetReachedError(2.1, 2), 402, 'budget_reached'],
        [new AgentResumeError('This session did not stop on its budget, so there is nothing to continue.'), 409, undefined],
    ])('answers %s as a normal JSON refusal, even with ?stream=1, and releases the slot', async (error, status, type) => {
        mockFn(executeAgentContinueLocal).mockRejectedValue(error);
        const app = await build();
        const res = await app.inject({ method: 'POST', url: `${SESSION_URL}/continue?stream=1`, headers, payload: {} });

        expect(res.statusCode).toBe(status);
        expect(res.headers['content-type']).toContain('application/json');
        if (type) expect(JSON.parse(res.body)).toMatchObject({ type, spentUsd: 2.1, maxCostUsd: 2 });
        expect(db.deleteAgentRun).toHaveBeenCalled();
    });

    it('is refused for a read-only (API) session and while another run holds the session', async () => {
        mockFn(getConversationById).mockResolvedValue({ ...CONVERSATION, metadata: { source: 'api' } });
        const app = await build();
        expect((await app.inject({ method: 'POST', url: `${SESSION_URL}/continue`, headers, payload: {} })).statusCode).toBe(409);

        mockFn(getConversationById).mockResolvedValue(CONVERSATION);
        const { AgentRunConflictError } = await import('@/lib/database/provider/errors');
        db.createAgentRun.mockRejectedValueOnce(new AgentRunConflictError('conv-1'));
        expect((await app.inject({ method: 'POST', url: `${SESSION_URL}/continue`, headers, payload: {} })).statusCode).toBe(409);
        expect(executeAgentContinueLocal).not.toHaveBeenCalled();
    });
});

describe('a session\'s budget on the other routes', () => {
    it('POST /sessions passes a budget on (null = none, absent = the agent default) and rejects a bad one', async () => {
        mockFn(createConversation).mockResolvedValue({ _id: 'conv-new' });
        const app = await build();
        const url = '/api/agents/agent-1/sessions';

        let res = await app.inject({ method: 'POST', url, headers, payload: { budget: { maxCostUsd: 3, onReach: 'stop' } } });
        expect(res.statusCode).toBe(201);
        expect(mockFn(createConversation).mock.calls[0][7]).toEqual({ maxCostUsd: 3, onReach: 'stop' });

        await app.inject({ method: 'POST', url, headers, payload: { budget: null } });
        expect(mockFn(createConversation).mock.calls[1][7]).toBeNull();

        await app.inject({ method: 'POST', url, headers, payload: {} });
        expect(mockFn(createConversation).mock.calls[2][7]).toBeUndefined();

        res = await app.inject({ method: 'POST', url, headers, payload: { budget: { maxCostUsd: 0 } } });
        expect(res.statusCode).toBe(400);
    });

    it('a chat message to a session whose budget is used up is a 402 with the amounts; no turn runs', async () => {
        mockFn(getConversationById).mockResolvedValue({
            ...CONVERSATION, budget: { maxCostUsd: 1, onReach: 'pause' }, spentUsd: 1.5, runtimeStatus: 'budget_paused',
        });
        const app = await build();
        const res = await app.inject({
            method: 'POST', url: '/api/agents/agent-1/chat/stream', headers, payload: { message: 'more', conversationId: 'conv-1' },
        });
        expect(res.statusCode).toBe(402);
        expect(JSON.parse(res.body)).toMatchObject({ type: 'budget_reached', code: 'budget_reached', spentUsd: 1.5, maxCostUsd: 1 });
        expect(executePlaygroundChatLocal).not.toHaveBeenCalled();
        expect(db.createAgentRun).not.toHaveBeenCalled();
    });

    it('the sessions list shows the budget and spend of a session that has one', async () => {
        const { listConversations } = await import('@/lib/services/agents');
        mockFn(listConversations).mockResolvedValue([
            { ...CONVERSATION, _id: 'a', budget: { maxCostUsd: 2, onReach: 'pause' }, spentUsd: 0.5, messages: [] },
            { ...CONVERSATION, _id: 'b', messages: [] },
        ]);
        const app = await build();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/sessions', headers });
        const [withBudget, without] = JSON.parse(res.body).sessions;
        expect(withBudget).toMatchObject({ budget: { maxCostUsd: 2, onReach: 'pause' }, spentUsd: 0.5 });
        expect(without.budget).toBeUndefined();
    });
});
