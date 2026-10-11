/**
 * The dashboard's feedback routes (the Feedback tab and the rating shown under an
 * answer in a session): who sees the words people wrote, what a filter becomes,
 * and what a refused query says. The storage and the services are covered in
 * `integration/agent-session-edit-and-feedback.test.ts`; faked here.
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

vi.mock('@/lib/services/agents/agentFeedback', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentFeedback')>();
    return { ...actual, listAgentFeedback: vi.fn(), listSessionFeedback: vi.fn(), summarizeAgentFeedback: vi.fn() };
});

vi.mock('@/server/api/plugins/agents-permission', () => ({ sessionHasAgentsPermission: vi.fn() }));

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getAgentById, getConversationById } from '@/lib/services/agents';
import {
    FeedbackError,
    listAgentFeedback,
    listSessionFeedback,
    summarizeAgentFeedback,
} from '@/lib/services/agents/agentFeedback';
import { sessionHasAgentsPermission } from '@/server/api/plugins/agents-permission';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { createFastifyApiTestApp } from '../helpers/fastify-api';

const SESSION_CTX = {
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'member', email: 'a@b.c' },
    userProject: { role: 'project_admin' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};
const AGENT = { _id: 'agent-1', key: 'field-ops', name: 'Field Ops', status: 'active', projectId: 'proj-1', config: { modelKey: 'm' } };
const CONVERSATION = { _id: 'conv-1', agentKey: 'field-ops', projectId: 'proj-1', messages: [], createdBy: 'user-1' };

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const row = (overrides: Record<string, unknown> = {}) => ({
    _id: 'fb_1', tenantId: 'tenant-1', projectId: 'proj-1', agentKey: 'field-ops', agentVersion: 2,
    conversationId: 'conv-1', messageId: 'msg_a', messageIndex: 1, userId: 'person-7', channel: 'portal', portalId: 'portal-1',
    rating: 'down', reasons: ['inaccurate'], comment: 'the date is wrong', removedAt: null,
    createdAt: new Date('2026-10-01T10:00:00Z'), updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    mockFn(getAgentById).mockResolvedValue(AGENT);
    mockFn(getConversationById).mockResolvedValue(CONVERSATION);
    mockFn(sessionHasAgentsPermission).mockResolvedValue(true);
});

const build = async () => createFastifyApiTestApp(agentsApiPlugin);
const get = async (url: string) => (await build()).inject({ method: 'GET', url, headers: { authorization: 'Bearer t' } });

describe('GET /agents/:agentId/feedback', () => {
    it('lists the ratings with their words for someone who can change the agent', async () => {
        mockFn(listAgentFeedback).mockResolvedValue({ items: [row()], total: 1 });
        const res = await get('/api/agents/agent-1/feedback?rating=down&reason=inaccurate&hasComment=true&days=7&limit=10&skip=5');

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.canReadComments).toBe(true);
        expect(body.total).toBe(1);
        expect(body.items[0]).toMatchObject({
            conversationId: 'conv-1', messageIndex: 1, rating: 'down', reasons: ['inaccurate'],
            comment: 'the date is wrong', userId: 'person-7', channel: 'portal', agentVersion: 2, removed: false,
        });
        const [tenantDbName, filter, paging] = mockFn(listAgentFeedback).mock.calls[0];
        expect(tenantDbName).toBe('tenant_acme');
        expect(filter).toMatchObject({ projectId: 'proj-1', agentKey: 'field-ops', rating: 'down', reason: 'inaccurate', hasComment: true });
        expect(filter.from).toBeInstanceOf(Date);
        expect(Date.now() - filter.from.getTime()).toBeGreaterThan(6.9 * 86_400_000);
        expect(Date.now() - filter.from.getTime()).toBeLessThan(7.1 * 86_400_000);
        expect(paging).toEqual({ limit: 10, skip: 5 });
    });

    it('hides the words and the people from someone who can only read the agent', async () => {
        mockFn(sessionHasAgentsPermission).mockResolvedValue(false);
        mockFn(listAgentFeedback).mockResolvedValue({ items: [row()], total: 1 });
        const res = await get('/api/agents/agent-1/feedback');
        const body = JSON.parse(res.body);
        expect(body.canReadComments).toBe(false);
        expect(body.items[0].comment).toBeUndefined();
        expect(body.items[0].userId).toBeUndefined();
        expect(body.items[0]).toMatchObject({ rating: 'down', reasons: ['inaccurate'] });
        expect(res.body).not.toContain('the date is wrong');
        expect(res.body).not.toContain('person-7');
    });

    it('caps the page and defaults the window to 30 days', async () => {
        mockFn(listAgentFeedback).mockResolvedValue({ items: [], total: 0 });
        await get('/api/agents/agent-1/feedback?limit=9999&days=9999');
        const [, filter, paging] = mockFn(listAgentFeedback).mock.calls[0];
        expect(paging.limit).toBe(100);
        expect(Math.round((Date.now() - filter.from.getTime()) / 86_400_000)).toBe(365);
        await get('/api/agents/agent-1/feedback');
        expect(Math.round((Date.now() - mockFn(listAgentFeedback).mock.calls[1][1].from.getTime()) / 86_400_000)).toBe(30);
    });

    it('answers 400 to a rating or a reason it does not know, and 404 to another project\'s agent', async () => {
        expect((await get('/api/agents/agent-1/feedback?rating=meh')).statusCode).toBe(400);
        expect((await get('/api/agents/agent-1/feedback?reason=rude')).statusCode).toBe(400);
        expect(listAgentFeedback).not.toHaveBeenCalled();
        mockFn(getAgentById).mockResolvedValue({ ...AGENT, projectId: 'proj-2' });
        expect((await get('/api/agents/agent-1/feedback')).statusCode).toBe(404);
    });
});

describe('GET /agents/:agentId/feedback/summary', () => {
    it('summarises with the same filter', async () => {
        const summary = { up: 3, down: 1, withComment: 1, reasons: { inaccurate: 1 }, total: 4, positiveRate: 0.75 };
        mockFn(summarizeAgentFeedback).mockResolvedValue(summary);
        const res = await get('/api/agents/agent-1/feedback/summary?days=90&rating=down');
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ summary, days: 90 });
        expect(mockFn(summarizeAgentFeedback).mock.calls[0][1]).toMatchObject({ projectId: 'proj-1', agentKey: 'field-ops', rating: 'down' });
    });

    it('is available to anyone who can read the agent, comments or not', async () => {
        mockFn(sessionHasAgentsPermission).mockResolvedValue(false);
        mockFn(summarizeAgentFeedback).mockResolvedValue({ up: 0, down: 0, withComment: 0, reasons: {}, total: 0, positiveRate: null });
        expect((await get('/api/agents/agent-1/feedback/summary')).statusCode).toBe(200);
    });
});

describe('GET /agents/:agentId/sessions/:sessionId/feedback', () => {
    it('lists the session\'s ratings, with words for those who may read them', async () => {
        mockFn(listSessionFeedback).mockResolvedValue([row(), row({ messageId: 'msg_b', messageIndex: 3, rating: 'up', reasons: [], comment: undefined })]);
        const res = await get('/api/agents/agent-1/sessions/conv-1/feedback');
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.canReadComments).toBe(true);
        expect(body.feedback.map((item: { messageIndex: number }) => item.messageIndex)).toEqual([1, 3]);
        expect(body.feedback[0].comment).toBe('the date is wrong');
        expect(mockFn(listSessionFeedback).mock.calls[0][0]).toMatchObject({
            tenantDbName: 'tenant_acme', projectId: 'proj-1', conversationId: 'conv-1', agentKey: 'field-ops',
        });
    });

    it('hides the words and the people from a read-only viewer', async () => {
        mockFn(sessionHasAgentsPermission).mockResolvedValue(false);
        mockFn(listSessionFeedback).mockResolvedValue([row()]);
        const res = await get('/api/agents/agent-1/sessions/conv-1/feedback');
        expect(res.body).not.toContain('the date is wrong');
        expect(res.body).not.toContain('person-7');
        expect(JSON.parse(res.body).feedback[0]).toMatchObject({ rating: 'down', reasons: ['inaccurate'] });
    });

    it('answers a service refusal with its status and code', async () => {
        mockFn(listSessionFeedback).mockRejectedValue(new FeedbackError(404, 'session_not_found', 'Session not found.'));
        const res = await get('/api/agents/agent-1/sessions/conv-1/feedback');
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body)).toEqual({ error: 'Session not found.', code: 'session_not_found' });
    });

    it('404s a session of another agent', async () => {
        mockFn(getConversationById).mockResolvedValue({ ...CONVERSATION, agentKey: 'other' });
        expect((await get('/api/agents/agent-1/sessions/conv-1/feedback')).statusCode).toBe(404);
        expect(listSessionFeedback).not.toHaveBeenCalled();
    });
});
