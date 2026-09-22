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
    };
});

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

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
import { getAgentById } from '@/lib/services/agents';
import { executePlaygroundChatLocal } from '@/lib/services/agents/agentService';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
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

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    mockFn(getDatabase).mockResolvedValue({});
    mockFn(getAgentById).mockResolvedValue(AGENT);
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
