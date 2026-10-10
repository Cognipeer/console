/**
 * The dashboard's routes for pending approvals / questions:
 * `POST /agents/:agentId/sessions/:sessionId/actions/:actionId/resolve`
 * (JSON, and `?stream=1` as SSE in the `/chat/stream` event format), the 409 a
 * new message gets while a request is open, and the defaults a dashboard-created
 * agent is stored with. The resolution service itself is covered end to end in
 * `integration/agent-human-in-the-loop.test.ts`; faked here.
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
    AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

vi.mock('@/lib/services/agents/agentActionResolution', () => ({
    resolveAgentPendingAction: vi.fn(),
    pendingActionsBlockingMessage: vi.fn(),
}));

vi.mock('@/server/api/plugins/agent-config-write', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/plugins/agent-config-write')>();
    return { ...actual, prepareNewAgentConfig: vi.fn() };
});

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getDatabase } from '@/lib/database';
import { createAgentRecord, getAgentById, getConversationById } from '@/lib/services/agents';
import { executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { pendingActionsBlockingMessage, resolveAgentPendingAction } from '@/lib/services/agents/agentActionResolution';
import { prepareNewAgentConfig } from '@/server/api/plugins/agent-config-write';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { sessionEventBus } from '@/lib/services/agents/sessionEvents';
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
const CONVERSATION = { _id: 'conv-1', agentKey: 'field-ops', projectId: 'proj-1', messages: [], createdBy: 'user-1' };

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const RESULT = { content: 'Done.', version: null, steps: [] };
const URL = '/api/agents/agent-1/sessions/conv-1/actions/act_1/resolve';

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    mockFn(getAgentById).mockResolvedValue(AGENT);
    mockFn(getConversationById).mockResolvedValue(CONVERSATION);
    mockFn(pendingActionsBlockingMessage).mockResolvedValue(null);
    mockFn(getDatabase).mockResolvedValue({ createAgentRun: vi.fn(async () => ({ _id: 'res-1' })), deleteAgentRun: vi.fn() });
});

const build = async () => createFastifyApiTestApp(agentsApiPlugin);
const events = (body: string) => body.split('\n\n').filter(Boolean).map((block) => ({
    event: /event: (.+)/.exec(block)?.[1],
    data: /data: (.+)/.exec(block)?.[1] ? JSON.parse(/data: (.+)/.exec(block)![1]) : undefined,
}));

describe('POST …/actions/:actionId/resolve', () => {
    it('hands the body, the actor and the scope to the resolution service and returns the continuation', async () => {
        mockFn(resolveAgentPendingAction).mockResolvedValue({ kind: 'resumed', result: RESULT, response: {}, stopReason: 'end_turn' });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: URL, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow', comment: 'ok' } });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ status: 'resumed', result: RESULT });
        expect(resolveAgentPendingAction).toHaveBeenCalledWith(expect.objectContaining({
            tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1', conversationId: 'conv-1',
            actionId: 'act_1', agentKey: 'field-ops', mode: 'sync',
            body: { decision: 'allow', comment: 'ok' },
            // A project admin counts as an admin.
            actor: expect.objectContaining({ userId: 'user-1', isAdmin: true, channel: 'dashboard' }),
        }));
        expect(mockFn(resolveAgentPendingAction).mock.calls[0][0].stream).toBeUndefined();
    });

    it('reports the requests still open when others of the same pause remain', async () => {
        mockFn(resolveAgentPendingAction).mockResolvedValue({ kind: 'pending', pendingActions: [{ id: 'act_2', kind: 'tool_approval', status: 'pending' }] });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: URL, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow' } });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toMatchObject({ status: 'requires_action', pendingActions: [{ id: 'act_2' }] });
    });

    it.each([
        [{ kind: 'not_found' }, 404, undefined],
        [{ kind: 'not_pending', status: 'resolved' }, 409, 'action_not_pending'],
        // Cancelled elsewhere (a new message, a run cancel) and swept as expired say so: a portal shows "Cancelled" / "Expired", not "Answered".
        [{ kind: 'not_pending', status: 'cancelled' }, 409, 'action_cancelled'],
        [{ kind: 'not_pending', status: 'expired' }, 410, 'action_expired'],
        [{ kind: 'expired' }, 410, 'action_expired'],
        [{ kind: 'forbidden', message: 'nope' }, 403, undefined],
        [{ kind: 'invalid', message: 'bad body' }, 400, undefined],
        [{ kind: 'busy' }, 409, 'agent_run_conflict'],
    ])('answers %j with %i', async (outcome, status, code) => {
        mockFn(resolveAgentPendingAction).mockResolvedValue(outcome);
        const app = await build();
        const res = await app.inject({ method: 'POST', url: URL, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow' } });
        expect(res.statusCode).toBe(status);
        if (code) expect(JSON.parse(res.body).code).toBe(code);
    });

    it('404s a session that belongs to another agent or project', async () => {
        mockFn(getConversationById).mockResolvedValue({ ...CONVERSATION, agentKey: 'someone-else' });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: URL, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow' } });
        expect(res.statusCode).toBe(404);
        expect(resolveAgentPendingAction).not.toHaveBeenCalled();
    });

    it('?stream=1 streams the continuation in the /chat/stream format, then the result', async () => {
        mockFn(resolveAgentPendingAction).mockImplementation(async (input: {
            stream?: { onToolEvent?: (e: unknown) => void; onTextChunk?: (t: string) => void };
        }) => {
            const at = new Date().toISOString();
            sessionEventBus.publish('conv-1', { seq: 7, type: 'session.status_running', data: { trigger: 'resume' }, createdAt: at });
            input.stream?.onToolEvent?.({ phase: 'start', name: 'sandbox_exec', id: 'c1', args: { command: 'ls' } });
            input.stream?.onToolEvent?.({ phase: 'success', name: 'sandbox_exec', id: 'c1', durationMs: 12 });
            input.stream?.onTextChunk?.('Done.');
            sessionEventBus.publish('conv-1', { seq: 8, type: 'session.status_idle', data: { stopReason: 'end_turn' }, createdAt: at });
            return { kind: 'resumed', result: RESULT, response: {}, stopReason: 'end_turn' };
        });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: `${URL}?stream=1`, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow' } });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        const seen = events(res.body);
        expect(seen.filter((e) => e.event === 'tool')).toHaveLength(2);
        expect(seen.find((e) => e.event === 'text')?.data).toEqual({ text: 'Done.' });
        expect(seen.filter((e) => e.event === 'status').map((e) => e.data.type)).toEqual(['session.status_running', 'session.status_idle']);
        expect(res.body).toContain('id: 7\nevent: status\n');
        expect(seen.at(-1)).toMatchObject({ event: 'result', data: RESULT });
    });

    it('?stream=1 still answers a refusal as plain JSON (the stream only opens for a continuation)', async () => {
        mockFn(resolveAgentPendingAction).mockResolvedValue({ kind: 'forbidden', message: 'nope' });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: `${URL}?stream=1`, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow' } });
        expect(res.statusCode).toBe(403);
        expect(res.headers['content-type']).toContain('application/json');
    });

    it('?stream=1 sends a failure of the continuation as an error event', async () => {
        mockFn(resolveAgentPendingAction).mockImplementation(async (input: { stream?: { onTextChunk?: (t: string) => void } }) => {
            input.stream?.onTextChunk?.('Partial');
            throw new Error('model unavailable');
        });
        const app = await build();
        const res = await app.inject({ method: 'POST', url: `${URL}?stream=1`, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow' } });
        const seen = events(res.body);
        expect(seen.find((e) => e.event === 'error')?.data.error).toContain('model unavailable');
        expect(seen.some((e) => e.event === 'result')).toBe(false);
    });

    it('a continuation that fails before the stream opened is a normal error response', async () => {
        mockFn(resolveAgentPendingAction).mockRejectedValue(Object.assign(new Error('The paused state was not found.'), { name: 'AgentResumeError', status: 409 }));
        const app = await build();
        const res = await app.inject({ method: 'POST', url: `${URL}?stream=1`, headers: { authorization: 'Bearer t' }, payload: { decision: 'allow' } });
        expect(res.statusCode).toBe(409);
    });
});

describe('a new message while a request is open', () => {
    it('is answered 409 pending_action before the session is reserved', async () => {
        mockFn(pendingActionsBlockingMessage).mockResolvedValue(['act_1']);
        const app = await build();
        const res = await app.inject({
            method: 'POST', url: '/api/agents/agent-1/chat/stream', headers: { authorization: 'Bearer t' },
            payload: { message: 'hello?', conversationId: 'conv-1' },
        });
        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body)).toMatchObject({ type: 'pending_action', pendingActionIds: ['act_1'] });
        expect(executePlaygroundChatLocal).not.toHaveBeenCalled();
        expect(pendingActionsBlockingMessage).toHaveBeenCalledWith('tenant_acme', CONVERSATION, AGENT.config);
    });
});

describe('creating an agent from the dashboard', () => {
    const create = async (config: Record<string, unknown>) => {
        mockFn(prepareNewAgentConfig).mockResolvedValue({ config, warnings: [] });
        mockFn(createAgentRecord).mockResolvedValue({ _id: 'a1', key: 'k', name: 'N', config });
        const app = await build();
        await app.inject({ method: 'POST', url: '/api/agents', headers: { authorization: 'Bearer t' }, payload: { name: 'N', config: { modelKey: 'm' } } });
        return mockFn(createAgentRecord).mock.calls[0][4].config;
    };

    it('stores tool approval on (always) and questions off, explicitly', async () => {
        expect((await create({ modelKey: 'm' })).humanInTheLoop).toEqual({
            toolApproval: { enabled: true, defaultPolicy: 'always' },
            askUser: { enabled: false, allowFreeText: true },
        });
    });

    it('keeps what the form already chose', async () => {
        const chosen = { toolApproval: { enabled: false } };
        expect((await create({ modelKey: 'm', humanInTheLoop: chosen })).humanInTheLoop).toEqual(chosen);
    });

    it('leaves a connected (external) agent alone', async () => {
        expect((await create({ kind: 'external', connection: {} })).humanInTheLoop).toBeUndefined();
    });
});
