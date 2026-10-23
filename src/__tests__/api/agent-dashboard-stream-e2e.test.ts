/**
 * The dashboard's own session channel, end to end over its real route.
 *
 * Separated from the other channels because this one authenticates as a
 * dashboard SESSION rather than an API token, so it needs `fastify-utils`
 * mocked — and a module can only be mocked one way per file.
 *
 * What it locks down is the endpoint's whole reason to exist: a run that
 * reports itself while it happens. The completed turn is already covered
 * elsewhere; what is not, anywhere else, is that the tool calls, their
 * arguments and their durations actually reach the client before the answer
 * does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
    return {
        ...actual,
        requireProjectContextForRequest: vi.fn(),
        sendProjectContextError: vi.fn().mockReturnValue(null),
        // Who may touch a session somebody else started is the policy engine's question (agent-session-authz.test.ts); allowed here.
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
    AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getDatabase } from '@/lib/database';
import { executePlaygroundChat, getAgentById, getConversationById } from '@/lib/services/agents';
import { AgentRunConflictError } from '@/lib/database/provider/errors';
import { executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { sessionEventBus } from '@/lib/services/agents/sessionEvents';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const SESSION_CTX = {
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'owner' },
    session: {
        tenantDbName: 'tenant_acme',
        tenantId: 'tenant-1',
        userId: 'user-1',
    },
};

// The session the turns continue: the signed-in user's own, of this agent and project.
const CONVERSATION = { _id: 'conv-1', agentKey: 'field-ops', projectId: 'proj-1', createdBy: 'user-1', messages: [] };

const AGENT = {
    _id: 'agent-1',
    key: 'field-ops',
    name: 'Field Ops',
    status: 'active',
    projectId: 'proj-1',
    publishedVersion: 4,
    config: { modelKey: 'gpt-5-terra' },
};

function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
    return fn as ReturnType<typeof vi.fn>;
}

const PLAYGROUND_RESULT = {
    content: 'The database is down.',
    version: 4,
    latencyMs: 4200,
    usage: { inputTokens: 1200, outputTokens: 42, totalTokens: 1242, costUsd: 0.0182 },
    steps: [{ id: 'e1', name: 'web_search', args: { query: 'db status' }, status: 'success' }],
};

// A session turn holds the conversation's run slot (a `mode: 'sync'`
// AgentRun reservation) for its whole duration.
const createAgentRun = vi.fn();
const deleteAgentRun = vi.fn();

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    createAgentRun.mockImplementation(async (record: Record<string, unknown>) => ({ _id: 'reservation-1', ...record }));
    deleteAgentRun.mockResolvedValue(true);
    mockFn(getDatabase).mockResolvedValue({ createAgentRun, deleteAgentRun });
    mockFn(getAgentById).mockResolvedValue(AGENT);
    mockFn(getConversationById).mockResolvedValue(CONVERSATION);
    mockFn(executePlaygroundChatLocal).mockResolvedValue(PLAYGROUND_RESULT);
});

const build = async () => createFastifyApiTestApp(agentsApiPlugin);

/** Frames the SSE body back into the events a browser would see. */
function readEvents(body: string) {
    return body
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
            const event = /event: (.+)/.exec(block)?.[1];
            const data = /data: (.+)/.exec(block)?.[1];
            return { event, data: data ? JSON.parse(data) : undefined };
        });
}

describe('channel: dashboard session stream', () => {
    it('reports tool calls as they happen, then the finished turn', async () => {
        // The point of the whole endpoint: a forty-second run narrating
        // itself instead of one spinner.
        mockFn(executePlaygroundChatLocal).mockImplementation(
            async (request: {
                onToolEvent?: (e: Record<string, unknown>) => void;
                onTextChunk?: (t: string) => void;
            }) => {
                request.onToolEvent?.({ phase: 'start', name: 'web_search', id: 'c1', args: { query: 'db status' } });
                request.onToolEvent?.({ phase: 'success', name: 'web_search', id: 'c1', durationMs: 1700 });
                request.onTextChunk?.('The database ');
                request.onTextChunk?.('is down.');
                return PLAYGROUND_RESULT;
            },
        );

        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'what is broken?', conversationId: 'conv-1' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');

        const events = readEvents(res.body);

        const tools = events.filter((e) => e.event === 'tool');
        expect(tools).toHaveLength(2);
        expect(tools[0].data.phase).toBe('start');
        // The argument is what tells two calls of one tool apart.
        expect(tools[0].data.args).toEqual({ query: 'db status' });
        expect(tools[1].data.durationMs).toBe(1700);

        const text = events.filter((e) => e.event === 'text').map((e) => e.data.text).join('');
        expect(text).toBe('The database is down.');

        const result = events.find((e) => e.event === 'result');
        expect(result?.data.content).toBe('The database is down.');
        // Cost and latency ride on the turn, so a reopened session shows the
        // same numbers it showed live.
        expect(result?.data.usage.costUsd).toBeCloseTo(0.0182, 6);
        expect(result?.data.latencyMs).toBe(4200);
    });

    it('streams the model\'s thinking as `reasoning` events, ahead of the result that carries it whole', async () => {
        mockFn(executePlaygroundChatLocal).mockImplementation(
            async (request: { onReasoningChunk?: (t: string) => void; onTextChunk?: (t: string) => void }) => {
                request.onReasoningChunk?.('Checking the ');
                request.onReasoningChunk?.('status page.');
                request.onTextChunk?.('The database is down.');
                return { ...PLAYGROUND_RESULT, reasoning: 'Checking the status page.' };
            },
        );

        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'what is broken?', conversationId: 'conv-1' },
        });

        const events = readEvents(res.body);
        const names = events.map((e) => e.event);
        expect(events.filter((e) => e.event === 'reasoning').map((e) => e.data.text).join('')).toBe('Checking the status page.');
        expect(names.indexOf('reasoning')).toBeLessThan(names.indexOf('text'));
        expect(names.indexOf('text')).toBeLessThan(names.indexOf('result'));
        expect(events.find((e) => e.event === 'result')?.data.reasoning).toBe('Checking the status page.');
    });

    it('adds action and status events (with id: seq) for a session turn, and leaves the existing events alone', async () => {
        mockFn(executePlaygroundChatLocal).mockImplementation(
            async (request: { onToolEvent?: (e: Record<string, unknown>) => void }) => {
                const at = new Date().toISOString();
                sessionEventBus.publish('conv-1', { seq: 1, type: 'session.status_running', data: { trigger: 'message' }, createdAt: at });
                request.onToolEvent?.({ phase: 'start', name: 'sandbox_exec', id: 'c1' });
                sessionEventBus.publish('conv-1', { seq: 2, type: 'agent.tool_use', data: { name: 'sandbox_exec' }, createdAt: at });
                sessionEventBus.publish('conv-1', { seq: 3, type: 'action.required', data: { actionId: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec' }, createdAt: at });
                sessionEventBus.publish('conv-1', { seq: 4, type: 'session.status_idle', data: { stopReason: 'requires_action' }, createdAt: at });
                return PLAYGROUND_RESULT;
            },
        );

        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'run it', conversationId: 'conv-1' },
        });

        expect(res.body).toContain('id: 3\nevent: action\n');
        expect(res.body).toContain('id: 1\nevent: status\n');
        const events = readEvents(res.body);
        expect(events.find((e) => e.event === 'action')?.data).toMatchObject({ actionId: 'act_1', toolName: 'sandbox_exec' });
        expect(events.filter((e) => e.event === 'status').map((e) => e.data.type)).toEqual(['session.status_running', 'session.status_idle']);
        // Existing events are untouched: no ids, same names.
        expect(res.body).toContain('event: tool\ndata:');
        expect(events.some((e) => e.event === 'result')).toBe(true);
        // The tool_use bus frame is NOT re-sent as a second tool event.
        expect(events.filter((e) => e.event === 'tool')).toHaveLength(1);
    });

    it('a stateless turn (no conversation) gets no session events', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi' },
        });
        expect(res.body).not.toContain('event: status');
        expect(res.body).not.toContain('event: action');
    });

    it('sends a failure as an event, not as a dead socket', async () => {
        // The status line is long gone by the time a run fails, so a client
        // listening only for `result` would hang until the socket closed.
        mockFn(executePlaygroundChatLocal)
            .mockRejectedValue(new Error('model unavailable'));

        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi' },
        });

        expect(res.body).toContain('event: error');
        expect(res.body).toContain('model unavailable');
    });

    it('narrates a context summarization as it happens, and a limit stop on the result', async () => {
        const compaction = {
            at: '2026-09-23T10:00:00.000Z',
            messagesCompressed: 6,
            tokensBefore: 41000,
            tokensAfter: 7800,
            summary: { userDirectives: ['Always answer in Turkish.'], facts: [{ key: 'db_host', value: 'db-7' }] },
        };
        mockFn(executePlaygroundChatLocal).mockImplementation(
            async (request: { onCompaction?: (c: Record<string, unknown>) => void }) => {
                request.onCompaction?.(compaction);
                return {
                    ...PLAYGROUND_RESULT,
                    content: 'Checking the infra logs next…',
                    stopReason: 'limit',
                    stopDetail: 'maxWallClockMs (60000ms) exceeded',
                    compactions: [compaction],
                };
            },
        );

        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'dig deeper', conversationId: 'conv-1' },
        });
        const events = readEvents(res.body);

        const summary = events.find((e) => e.event === 'summary');
        expect(summary?.data.summary.userDirectives).toEqual(['Always answer in Turkish.']);
        // Live, before the turn finished — not only in the result.
        expect(events.findIndex((e) => e.event === 'summary')).toBeLessThan(events.findIndex((e) => e.event === 'result'));

        const result = events.find((e) => e.event === 'result');
        expect(result?.data.stopReason).toBe('limit');
        expect(result?.data.stopDetail).toMatch(/^maxWallClockMs/);
        expect(result?.data.compactions).toHaveLength(1);
    });

    it('streams the agent\'s plan, its sub-agents and a child\'s own pass as events of their own, before the result', async () => {
        const plan = { toolCallId: 'p1', version: 1, operation: 'write', steps: [{ id: 1, title: 'Gather', status: 'in-progress' }], at: '2026-10-23T10:00:00.000Z' };
        const start = { phase: 'start', id: 'sa_1', name: 'helper', parentToolCallId: 'd1', input: 'go', at: '2026-10-23T10:00:01.000Z' };
        const childPass = { at: '2026-10-23T10:00:02.000Z', messagesCompressed: 3, subagent: { id: 'sa_1', name: 'helper' } };
        const pending = { at: '2026-10-23T10:00:03.000Z', phase: 'start', id: 'call_summary_1' };
        mockFn(executePlaygroundChatLocal).mockImplementation(
            async (request: {
                onPlan?: (p: Record<string, unknown>) => void;
                onSubagent?: (e: Record<string, unknown>) => void;
                onCompaction?: (c: Record<string, unknown>) => void;
            }) => {
                request.onPlan?.(plan);
                request.onSubagent?.(start);
                request.onCompaction?.(childPass);
                request.onCompaction?.(pending);
                return { ...PLAYGROUND_RESULT, plans: [plan] };
            },
        );

        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'plan it', conversationId: 'conv-1' },
        });
        const events = readEvents(res.body);

        expect(events.map((e) => e.event).filter((name) => name !== 'status' && name !== 'action')).toEqual(['plan', 'subagent', 'summary', 'summary', 'result']);
        expect(events.find((e) => e.event === 'plan')?.data).toEqual(plan);
        expect(events.find((e) => e.event === 'subagent')?.data).toEqual(start);
        const summaries = events.filter((e) => e.event === 'summary');
        expect(summaries[0].data.subagent).toEqual({ id: 'sa_1', name: 'helper' });
        expect(summaries[1].data).toMatchObject({ phase: 'start', id: 'call_summary_1' });
        expect(events.find((e) => e.event === 'result')?.data.plans).toHaveLength(1);
    });

    it('classifies a provider key failure on the error event', async () => {
        mockFn(executePlaygroundChatLocal).mockRejectedValue(
            Object.assign(new Error('401 Incorrect API key provided'), { status: 401, agentModelKey: 'gpt-5-terra' }),
        );
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi' },
        });
        const error = readEvents(res.body).find((e) => e.event === 'error');
        expect(error?.data.type).toBe('provider_authentication_error');
        expect(error?.data.error).toContain('model "gpt-5-terra"');
    });

    it('refuses a message with no text', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: {},
        });
        expect(res.statusCode).toBe(400);
    });
});

describe('dashboard session turns share the conversation run slot', () => {
    it('reserves the session for the streamed turn and releases it when the stream ends', async () => {
        mockFn(executePlaygroundChatLocal).mockImplementation(async () => {
            expect(deleteAgentRun).not.toHaveBeenCalled();
            return PLAYGROUND_RESULT;
        });
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi', conversationId: 'conv-1' },
        });

        expect(res.statusCode).toBe(200);
        expect(createAgentRun).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'sync',
            conversationId: 'conv-1',
            agentKey: 'field-ops',
            projectId: 'proj-1',
            tenantId: 'tenant-1',
        }));
        expect(deleteAgentRun).toHaveBeenCalledWith('reservation-1');
    });

    it('releases the reservation when the streamed turn fails', async () => {
        mockFn(executePlaygroundChatLocal).mockRejectedValue(new Error('model unavailable'));
        const app = await build();
        await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi', conversationId: 'conv-1' },
        });
        expect(deleteAgentRun).toHaveBeenCalledWith('reservation-1');
    });

    it('REGRESSION: a session busy with another run (e.g. a background run) gets 409 and the turn never starts', async () => {
        createAgentRun.mockRejectedValue(new AgentRunConflictError('conv-1'));
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi', conversationId: 'conv-1' },
        });

        expect(res.statusCode).toBe(409);
        expect(JSON.parse(res.body).code).toBe('agent_run_conflict');
        expect(executePlaygroundChatLocal).not.toHaveBeenCalled();
        expect(deleteAgentRun).not.toHaveBeenCalled();
    });

    it('a stateless turn (no session) takes no reservation', async () => {
        const app = await build();
        const res = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat/stream',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi' },
        });
        expect(res.statusCode).toBe(200);
        expect(createAgentRun).not.toHaveBeenCalled();
    });

    it('the non-streamed /chat route also refuses a busy session with 409, and releases after a turn', async () => {
        const app = await build();
        mockFn(executePlaygroundChat).mockResolvedValue(PLAYGROUND_RESULT);
        const ok = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi', conversationId: 'conv-1' },
        });
        expect(ok.statusCode).toBe(200);
        expect(deleteAgentRun).toHaveBeenCalledWith('reservation-1');

        mockFn(executePlaygroundChat).mockClear();
        createAgentRun.mockRejectedValue(new AgentRunConflictError('conv-1'));
        const busy = await app.inject({
            method: 'POST',
            url: '/api/agents/agent-1/chat',
            headers: { authorization: 'Bearer tok' },
            payload: { message: 'hi', conversationId: 'conv-1' },
        });
        expect(busy.statusCode).toBe(409);
        expect(executePlaygroundChat).not.toHaveBeenCalled();
    });
});
