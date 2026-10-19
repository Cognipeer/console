/**
 * GET /api/agents/sessions - every agent's sessions of the project in one list (Agents → Sessions).
 *
 * The things that would hurt if they regressed: a viewer's scope must reach the database query (and be
 * reported back), the Active view must hold exactly the sessions that are doing something, a row whose
 * agent cannot be resolved must not be listed (nothing could open it), bad input is a 400, and the
 * engine's "cannot decide" is a 503 - never an empty list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/api/fastify-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/fastify-utils')>();
    return { ...actual, requireProjectContextForRequest: vi.fn() };
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
    updateAgentRecord: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
    executePlaygroundChatLocal: vi.fn(),
    checkAgentModel: vi.fn(),
    AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
    // Waiting sessions ask the store for their open requests: none unless a test says otherwise.
    return { ...actual, listAgentRuns: vi.fn(), runWithTenantDb: vi.fn(async (_db: string, fn: (db: unknown) => unknown) => fn({ listAgentPendingActions: vi.fn(async () => []) })) };
});

vi.mock('@/lib/services/agents/agentReminders', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentReminders')>();
    return { ...actual, activeRemindersBySession: vi.fn(async () => new Map()) };
});

// The page itself is the database's business (agent-project-sessions-parity.test.ts); here only what the route asks of it.
vi.mock('@/lib/services/agents/sessionList', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/sessionList')>();
    return { ...actual, listProjectSessions: vi.fn() };
});

vi.mock('@/server/api/plugins/agent-approval-authz', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/plugins/agent-approval-authz')>();
    return { ...actual, describeAnswerAbility: vi.fn() };
});

vi.mock('@/lib/services/agents/sessionOwners', () => ({ resolveSessionOwners: vi.fn(async () => new Map()) }));

// Who may see whose sessions is the policy engine's question (agent-session-authz.test.ts).
vi.mock('@/server/api/plugins/agent-session-access', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/server/api/plugins/agent-session-access')>();
    return { ...actual, sessionListScope: vi.fn() };
});

import { requireProjectContextForRequest, resourceRefusalError } from '@/server/api/fastify-utils';
import { sessionListScope } from '@/server/api/plugins/agent-session-access';
import { listAgents } from '@/lib/services/agents';
import { listAgentRuns, runWithTenantDb } from '@/lib/services/agents/agentRunService';
import { describeAnswerAbility } from '@/server/api/plugins/agent-approval-authz';
import { activeRemindersBySession } from '@/lib/services/agents/agentReminders';
import { encodeActivityCursor, listProjectSessions } from '@/lib/services/agents/sessionList';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const SESSION_CTX = {
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'user' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};

const agent = (id: string, key: string, projectId?: string) => ({ _id: id, key, name: `Agent ${key}`, projectId });
const OPS = agent('agent-1', 'field-ops', 'proj-1');
const SALES = agent('agent-2', 'sales', 'proj-1');

const row = (id: string, agentKey: string, extra: Record<string, unknown> = {}) => ({
    _id: id,
    agentKey,
    projectId: 'proj-1',
    title: `Session ${id}`,
    createdBy: 'user-1',
    metadata: { source: 'console' },
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok', latencyMs: 800, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 } },
    ],
    ...extra,
});

const page = (sessions: unknown[], extra: Record<string, unknown> = {}) => ({ sessions, hasMore: false, ...extra });
const run = (conversationId: string, status: string, extra: Record<string, unknown> = {}) => ({
    _id: `r-${conversationId}`, conversationId, status, channel: 'runs', mode: 'background', ...extra,
});

type Body = { sessions: Array<Record<string, unknown>>; hasMore: boolean; nextCursor?: string; scope: Record<string, unknown> };
const get = async (url: string) => {
    const app = await createFastifyApiTestApp(agentsApiPlugin);
    const res = await app.inject({ method: 'GET', url });
    return { res, body: res.statusCode === 200 ? parseJsonBody<Body>(res.body) : parseJsonBody<Record<string, unknown>>(res.body) };
};
const asBody = (value: unknown) => value as Body;
const lastQuery = () => mockFn(listProjectSessions).mock.calls.at(-1)![1] as Record<string, unknown>;

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    mockFn(sessionListScope).mockResolvedValue({ userId: 'user-1' });
    mockFn(listAgents).mockResolvedValue([OPS, SALES]);
    mockFn(listAgentRuns).mockResolvedValue([]);
    mockFn(activeRemindersBySession).mockResolvedValue(new Map());
    mockFn(listProjectSessions).mockResolvedValue(page([]));
});

describe('GET /api/agents/sessions', () => {
    it('lists every agent\'s sessions with the agent that opens them, summarised and without transcripts', async () => {
        mockFn(listProjectSessions).mockResolvedValue(page([
            row('s1', 'field-ops'),
            row('s2', 'sales', { metadata: { source: 'api' }, runtimeStatus: 'idle' }),
        ]));
        const { res, body } = await get('/api/agents/sessions');
        expect(res.statusCode).toBe(200);
        const { sessions, hasMore, scope } = asBody(body);
        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toMatchObject({
            _id: 's1', agentId: 'agent-1', agentKey: 'field-ops', agentName: 'Agent field-ops',
            source: 'console', turns: 1, totalTokens: 15, activeMs: 800, ownSession: true,
        });
        expect(sessions[1]).toMatchObject({ _id: 's2', agentId: 'agent-2', agentKey: 'sales', source: 'api', runtimeStatus: 'idle' });
        expect(sessions[0].messages).toBeUndefined();
        expect(hasMore).toBe(false);
        expect(scope).toEqual({ viewOthers: true });
        // the default view is "all", paged, in the project the caller works in
        expect(lastQuery()).toMatchObject({ projectId: 'proj-1', limit: 50 });
        expect(lastQuery().runtimeStatuses).toBeUndefined();
        // one query each, project-wide: not one per agent
        expect(mockFn(listAgentRuns).mock.calls[0][1]).not.toHaveProperty('agentKey');
        expect(mockFn(activeRemindersBySession).mock.calls[0][1]).toBeUndefined();
    });

    it('hands the ids of sessions with a queued or running run to the list, in both views (a scheduled wait is not one)', async () => {
        mockFn(listAgentRuns).mockResolvedValue([
            run('s1', 'running'), run('s2', 'queued'), run('s3', 'scheduled', { notBefore: new Date('2026-10-05T00:00:00Z') }),
        ]);
        await get('/api/agents/sessions');
        expect([...(lastQuery().knownInFlight as Set<string>)].sort()).toEqual(['s1', 's2']);
        mockFn(listProjectSessions).mockClear();
        await get('/api/agents/sessions?view=active');
        for (const call of mockFn(listProjectSessions).mock.calls) {
            expect([...(call[1].knownInFlight as Set<string>)].sort()).toEqual(['s1', 's2']);
        }
    });

    it('summarises a row that carries message tallies only, exactly as one with its transcript', async () => {
        const tallies = [
            { role: 'user', steps: [] },
            { role: 'assistant', latencyMs: 800, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.001 }, steps: [{ status: 'success' }, { status: 'error', error: 'boom' }] },
            { role: 'assistant', latencyMs: 200, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }, stopReason: 'limit', outputError: 'bad json', steps: [] },
        ];
        mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'field-ops', { messages: tallies, runtimeStatus: 'idle' })]));
        const { body } = await get('/api/agents/sessions');
        expect(asBody(body).sessions[0]).toMatchObject({
            messageCount: 3, turns: 2, inputTokens: 12, outputTokens: 6, totalTokens: 18, costUsd: 0.001, costComplete: false,
            activeMs: 1000, failedCalls: 1, status: 'error', runtimeStatus: 'idle',
        });
        expect(asBody(body).sessions[0].messages).toBeUndefined();
    });

    it('decorates a row with the run it is waiting on and its reminders', async () => {
        mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'field-ops')]));
        mockFn(listAgentRuns).mockResolvedValue([run('s1', 'queued')]);
        mockFn(activeRemindersBySession).mockResolvedValue(new Map([['s1', { active: 2, nextAt: new Date('2026-10-02T09:00:00Z') }]]));
        const { body } = await get('/api/agents/sessions');
        expect(asBody(body).sessions[0]).toMatchObject({
            activeRun: { id: 'run_r-s1', status: 'queued', cancelRequested: false },
            reminders: { active: 2, nextAt: '2026-10-02T09:00:00.000Z' },
        });
    });

    it('pages by cursor: hands the keyset to the query and returns the next cursor', async () => {
        const last = row('s9', 'sales', { updatedAt: new Date('2026-09-30T08:00:00Z') });
        mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'field-ops')], { hasMore: true, nextCursor: encodeActivityCursor(last) }));
        const cursor = encodeActivityCursor(row('s0', 'field-ops', { updatedAt: new Date('2026-10-02T00:00:00Z') }));
        const { res, body } = await get(`/api/agents/sessions?view=all&limit=1&cursor=${cursor}`);
        expect(res.statusCode).toBe(200);
        expect(asBody(body).hasMore).toBe(true);
        expect(asBody(body).nextCursor).toBe(encodeActivityCursor(last));
        expect(lastQuery()).toMatchObject({ limit: 1, before: { updatedAt: new Date('2026-10-02T00:00:00Z'), id: 's0' } });
    });

    describe('view=active', () => {
        it('merges the sessions in a running or waiting state with those that only have a run in flight', async () => {
            mockFn(listAgentRuns).mockResolvedValue([run('s3', 'queued'), run('s1', 'running')]);
            mockFn(listProjectSessions).mockImplementation(async (_db: string, filters: { ids?: string[]; runtimeStatuses?: string[] }) => {
                if (filters.ids) return page([row('s3', 'sales', { runtimeStatus: undefined, updatedAt: new Date('2026-10-01T12:00:00Z') })]);
                if (filters.runtimeStatuses?.includes('running')) {
                    return page([row('s1', 'field-ops', { runtimeStatus: 'running', updatedAt: new Date('2026-10-01T11:00:00Z') })]);
                }
                return page([
                    row('s2', 'sales', { runtimeStatus: 'requires_action', updatedAt: new Date('2026-10-01T13:00:00Z') }),
                    // a turn that died: read as idle by the service, with no run behind it
                    row('s4', 'sales', { runtimeStatus: 'idle', updatedAt: new Date('2026-10-01T14:00:00Z') }),
                ]);
            });
            const { res, body } = await get('/api/agents/sessions?view=active');
            expect(res.statusCode).toBe(200);
            expect(asBody(body).sessions.map((entry) => entry._id)).toEqual(['s2', 's3', 's1']);
            expect(asBody(body)).toMatchObject({ hasMore: false });
            expect(asBody(body).nextCursor).toBeUndefined();
            const [running, waiting, byRun] = mockFn(listProjectSessions).mock.calls.map((call) => call[1]);
            // running and waiting sessions are asked apart, so neither crowds out the other
            expect(running).toMatchObject({ projectId: 'proj-1', runtimeStatuses: ['running'], limit: 100 });
            expect(waiting).toMatchObject({ projectId: 'proj-1', runtimeStatuses: ['requires_action', 'budget_paused'], limit: 100 });
            // only the run-held session s3 is asked for: s1 is already in the running page
            expect(byRun).toMatchObject({ ids: ['s3'], limit: 100 });
        });

        it('keeps a running session when more waiting ones than fit are newer, and says the list was cut', async () => {
            const waitingRows = Array.from({ length: 100 }, (_, i) => row(`w${i}`, 'sales', {
                runtimeStatus: 'budget_paused', updatedAt: new Date(Date.UTC(2026, 9, 2, 0, 0, i)),
            }));
            mockFn(listProjectSessions).mockImplementation(async (_db: string, filters: { runtimeStatuses?: string[] }) => (
                filters.runtimeStatuses?.includes('running')
                    ? page([row('old-runner', 'field-ops', { runtimeStatus: 'running', updatedAt: new Date('2026-09-01T00:00:00Z') })])
                    : page(waitingRows, { hasMore: true })));
            const { res, body } = await get('/api/agents/sessions?view=active');
            expect(res.statusCode).toBe(200);
            const ids = asBody(body).sessions.map((entry) => entry._id);
            expect(ids).toHaveLength(100);
            expect(ids).toContain('old-runner');
            // cut by "ongoing first", shown newest first: the running (oldest) session closes the list
            expect(ids.at(-1)).toBe('old-runner');
            expect(asBody(body).hasMore).toBe(true);
            expect(asBody(body).nextCursor).toBeUndefined();
        });

        it('says the list was cut when more sessions are held by a run than the cap', async () => {
            const runs = Array.from({ length: 101 }, (_, i) => run(`q${i}`, 'queued'));
            mockFn(listAgentRuns).mockResolvedValue(runs);
            mockFn(listProjectSessions).mockImplementation(async (_db: string, filters: { ids?: string[] }) => page(
                (filters.ids ?? []).map((id) => row(id, 'sales', { runtimeStatus: undefined })),
            ));
            const { body } = await get('/api/agents/sessions?view=active');
            expect(asBody(body).sessions).toHaveLength(100);
            expect(asBody(body).hasMore).toBe(true);
        });

        it('does not look sessions up by run when no run is in flight; a scheduled wait is not active', async () => {
            mockFn(listAgentRuns).mockResolvedValue([run('s5', 'scheduled', { notBefore: new Date('2026-10-05T00:00:00Z') })]);
            mockFn(listProjectSessions).mockResolvedValue(page([row('s5', 'sales', { runtimeStatus: 'idle' })]));
            const { body } = await get('/api/agents/sessions?view=active');
            expect(asBody(body).sessions).toEqual([]);
            // the running and the waiting query only
            expect(mockFn(listProjectSessions)).toHaveBeenCalledTimes(2);
        });

        it('a session whose status is still "running" but whose run is gone stays in; a failing run lookup still serves the status rows', async () => {
            mockFn(listAgentRuns).mockRejectedValue(new Error('runs unavailable'));
            mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'field-ops', { runtimeStatus: 'budget_paused' })]));
            const { res, body } = await get('/api/agents/sessions?view=active');
            expect(res.statusCode).toBe(200);
            expect(asBody(body).sessions.map((entry) => entry._id)).toEqual(['s1']);
        });

        it('ignores a cursor and applies the viewer\'s scope to both lookups', async () => {
            mockFn(sessionListScope).mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: [] } });
            mockFn(listAgentRuns).mockResolvedValue([run('s3', 'queued')]);
            mockFn(listProjectSessions).mockResolvedValue(page([]));
            const { res } = await get('/api/agents/sessions?view=active&cursor=whatever-not-valid');
            expect(res.statusCode).toBe(200);
            const calls = mockFn(listProjectSessions).mock.calls.map((call) => call[1]);
            expect(calls).toHaveLength(3);
            for (const call of calls) expect(call).toMatchObject({ ownOnly: { userId: 'user-1', viewableAgentKeys: [] } });
            expect(calls.every((call) => call.before === undefined)).toBe(true);
        });
    });

    it('says whether the viewer could answer a waiting session, asked per row of the agent it belongs to', async () => {
        mockFn(runWithTenantDb).mockImplementation(async (_db: string, fn: (db: unknown) => unknown) => fn({ listAgentPendingActions: vi.fn(async () => [{ _id: 'a1', status: 'pending' }]) }));
        mockFn(describeAnswerAbility).mockResolvedValue(new Map([['a1', { canResolve: false, reason: 'approvers_owner' }]]));
        mockFn(listProjectSessions).mockResolvedValue(page([
            row('s1', 'sales', { runtimeStatus: 'requires_action' }),
            row('s2', 'field-ops', { runtimeStatus: 'idle' }),
        ]));
        const { body } = await get('/api/agents/sessions');
        expect(asBody(body).sessions[0]).toMatchObject({ _id: 's1', canResolve: false, resolveBlockedReason: 'approvers_owner' });
        expect(asBody(body).sessions[1].canResolve).toBeUndefined();
        expect(mockFn(describeAnswerAbility)).toHaveBeenCalledTimes(1);
        expect(mockFn(describeAnswerAbility).mock.calls[0][1]).toMatchObject({ agent: { key: 'sales' }, conversation: { _id: 's1' } });
    });

    describe('scope', () => {
        it('a viewer who may not see other people\'s sessions is cut in the query and told so', async () => {
            const ownOnly = { userId: 'user-1', viewableAgentKeys: [] as string[] };
            mockFn(sessionListScope).mockResolvedValue({ userId: 'user-1', ownOnly });
            mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'field-ops')]));
            const { body } = await get('/api/agents/sessions');
            expect(lastQuery().ownOnly).toEqual(ownOnly);
            expect(asBody(body).scope).toEqual({ viewOthers: false });
            // the scope is asked across the project's agents, not for one of them
            const [, input] = mockFn(sessionListScope).mock.calls[0];
            expect(input).toMatchObject({ projectId: 'proj-1', actor: { tenantDbName: 'tenant_acme', projectId: 'proj-1', userId: 'user-1' } });
            expect(input.agent).toBeUndefined();
        });

        it('says "partial" when the viewer may see other people\'s sessions of some agents', async () => {
            mockFn(sessionListScope).mockResolvedValue({ userId: 'user-1', ownOnly: { userId: 'user-1', viewableAgentKeys: ['sales'] } });
            const { body } = await get('/api/agents/sessions');
            expect(asBody(body).scope).toEqual({ viewOthers: false, partial: true });
        });

        it('answers 503 when the policy engine cannot decide, and never an empty list', async () => {
            mockFn(sessionListScope).mockImplementation(async (request: never) => {
                throw resourceRefusalError(request, { action: 'agent.session_view', level: 'read', unavailable: true, projectId: 'proj-1' } as never);
            });
            const { res } = await get('/api/agents/sessions');
            expect(res.statusCode).toBe(503);
            expect(mockFn(listProjectSessions)).not.toHaveBeenCalled();
        });

        it('answers 403 when the engine refuses', async () => {
            mockFn(sessionListScope).mockImplementation(async (request: never) => {
                throw resourceRefusalError(request, { action: 'agent.session_view', level: 'read', projectId: 'proj-1' } as never);
            });
            const { res } = await get('/api/agents/sessions');
            expect(res.statusCode).toBe(403);
            expect(mockFn(listProjectSessions)).not.toHaveBeenCalled();
        });

        it('answers 401 without a session', async () => {
            mockFn(requireProjectContextForRequest).mockRejectedValue(new Error('Unauthorized'));
            const { res } = await get('/api/agents/sessions');
            expect(res.statusCode).toBe(401);
        });
    });

    describe('agents', () => {
        it('drops a session whose agent cannot be found: nothing could open it', async () => {
            mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'field-ops'), row('s2', 'deleted-agent')]));
            const { body } = await get('/api/agents/sessions');
            expect(asBody(body).sessions.map((entry) => entry._id)).toEqual(['s1']);
        });

        it('does not adopt an agent that belongs to another project', async () => {
            mockFn(listAgents).mockImplementation(async (_db: string, filters?: { projectId?: string }) => (filters?.projectId
                ? [OPS]
                : [OPS, agent('agent-7', 'elsewhere', 'proj-other')]));
            mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'elsewhere')]));
            const { body } = await get('/api/agents/sessions');
            expect(asBody(body).sessions).toEqual([]);
        });

        it('resolves a tenant-wide agent (stored without a project) by one extra lookup', async () => {
            const shared = agent('agent-8', 'shared-helper');
            mockFn(listAgents).mockImplementation(async (_db: string, filters?: { projectId?: string }) => (filters?.projectId ? [OPS] : [OPS, shared]));
            mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'shared-helper')]));
            const { body } = await get('/api/agents/sessions');
            expect(asBody(body).sessions[0]).toMatchObject({ _id: 's1', agentId: 'agent-8', agentKey: 'shared-helper', agentName: 'Agent shared-helper' });
            expect(mockFn(listAgents)).toHaveBeenCalledTimes(2);
        });

        it('makes no tenant-wide lookup when the project\'s agents cover every row', async () => {
            mockFn(listProjectSessions).mockResolvedValue(page([row('s1', 'field-ops')]));
            await get('/api/agents/sessions');
            expect(mockFn(listAgents)).toHaveBeenCalledTimes(1);
        });
    });

    describe('input', () => {
        it.each([
            ['an unknown view', '?view=waiting'],
            ['a limit of zero', '?limit=0'],
            ['a limit over the maximum', '?limit=101'],
            ['a limit that is not a number', '?limit=many'],
            ['a fractional limit', '?limit=2.5'],
            ['a cursor this service did not issue', '?cursor=not-a-cursor'],
            ['a cursor whose timestamp is no date', `?cursor=${Buffer.from(JSON.stringify([1e20, 'x']), 'utf8').toString('base64url')}`],
        ])('answers 400 for %s', async (_what, query) => {
            const { res } = await get(`/api/agents/sessions${query}`);
            expect(res.statusCode).toBe(400);
            expect(mockFn(listProjectSessions)).not.toHaveBeenCalled();
        });

        it('accepts the limit bounds', async () => {
            expect((await get('/api/agents/sessions?limit=1')).res.statusCode).toBe(200);
            expect((await get('/api/agents/sessions?limit=100')).res.statusCode).toBe(200);
        });
    });
});
