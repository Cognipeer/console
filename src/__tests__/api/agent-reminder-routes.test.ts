/**
 * The dashboard routes of agent reminders: the reminders list, "fire now",
 * the platform limits, the cancel route on a reminder, and what the sessions
 * list adds to its rows (the active run, waiting reminders, a trigger filter).
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

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn() }));

vi.mock('@/lib/services/agents', () => ({
    getAgentById: vi.fn(),
    getConversationById: vi.fn(),
    listConversations: vi.fn(),
}));

vi.mock('@/lib/services/agents/agentService', () => ({
    executePlaygroundChatLocal: vi.fn(),
    checkAgentModel: vi.fn(),
    AgentGuardrailBlockedError: class AgentGuardrailBlockedError extends Error {},
}));

vi.mock('@/lib/services/agents/agentRunService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentRunService')>();
    return { ...actual, listAgentRuns: vi.fn(), getAgentRunStatus: vi.fn(), requestAgentRunCancellation: vi.fn() };
});

vi.mock('@/lib/services/agents/agentReminders', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/services/agents/agentReminders')>();
    return {
        ...actual,
        listReminders: vi.fn(),
        fireReminderNow: vi.fn(),
        cancelReminder: vi.fn(),
        activeRemindersBySession: vi.fn(),
    };
});

vi.mock('@/lib/services/agents/sessionOwners', () => ({
    resolveSessionOwners: vi.fn(async (ids: string[]) => new Map(ids.filter(Boolean).map((id) => [id, { id, kind: 'user', name: 'Ada' }]))),
}));

import { requireProjectContextForRequest } from '@/server/api/fastify-utils';
import { getDatabase } from '@/lib/database';
import { getAgentById, getConversationById, listConversations } from '@/lib/services/agents';
import { getAgentRunStatus, listAgentRuns, requestAgentRunCancellation } from '@/lib/services/agents/agentRunService';
import { activeRemindersBySession, cancelReminder, fireReminderNow, listReminders } from '@/lib/services/agents/agentReminders';
import { agentsApiPlugin } from '@/server/api/plugins/agents';
import { createFastifyApiTestApp, parseJsonBody } from '../helpers/fastify-api';

const mockFn = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const SESSION_CTX = {
    projectId: 'proj-1',
    user: { _id: 'user-1', role: 'user' },
    session: { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', userId: 'user-1' },
};
const AGENT = { _id: 'agent-1', key: 'field-ops', name: 'Field Ops', status: 'active', projectId: 'proj-1', config: {} };
const FOREIGN_AGENT = { ...AGENT, _id: 'agent-9', projectId: 'proj-other' };
const CONVERSATION = { _id: 'conv-1', agentKey: 'field-ops', projectId: 'proj-1', createdBy: 'user-1', title: 'Deploy check', messages: [] };

const reminder = (over: Record<string, unknown> = {}) => ({
    _id: 'rem-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    agentKey: 'field-ops',
    conversationId: 'conv-1',
    mode: 'background',
    status: 'scheduled',
    channel: 'reminder',
    userId: 'user-1',
    userMessage: 'Check whether the deploy finished.',
    notBefore: new Date('2026-10-19T15:00:00Z'),
    metadata: { reminder_chain: '1', reminder_reason: 'deploy' },
    createdAt: new Date('2026-10-19T14:00:00Z'),
    ...over,
});

beforeEach(() => {
    vi.clearAllMocks();
    mockFn(requireProjectContextForRequest).mockResolvedValue(SESSION_CTX);
    mockFn(getDatabase).mockResolvedValue({});
    mockFn(getAgentById).mockImplementation(async (_db: string, id: string) =>
        (id === AGENT._id ? AGENT : id === FOREIGN_AGENT._id ? FOREIGN_AGENT : null));
    mockFn(getConversationById).mockResolvedValue(CONVERSATION);
});

const agentsApp = () => createFastifyApiTestApp(agentsApiPlugin);

describe('GET /agents/reminder-limits', () => {
    it('returns the platform ceilings', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/reminder-limits' });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody<{ limits: Record<string, unknown> }>(res.body).limits).toMatchObject({
            enabled: expect.any(Boolean),
            minDelaySeconds: expect.any(Number),
            maxHorizonHours: expect.any(Number),
            maxActivePerSession: expect.any(Number),
            maxFiresPerSession: expect.any(Number),
        });
    });
});

describe('GET /agents/:agentId/reminders', () => {
    it('lists the waiting reminders with owner, session title and the active count', async () => {
        mockFn(listReminders).mockResolvedValue([reminder()]);
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/reminders' });
        expect(res.statusCode).toBe(200);
        const body = parseJsonBody<{ reminders: Array<Record<string, unknown>>; summary: { active: number }; scope: { viewOthers: boolean } }>(res.body);
        expect(body.reminders[0]).toMatchObject({
            id: 'run_rem-1',
            object: 'agent.reminder',
            session_id: 'conv-1',
            status: 'scheduled',
            fire_at: Math.floor(Date.parse('2026-10-19T15:00:00Z') / 1000),
            message: 'Check whether the deploy finished.',
            reason: 'deploy',
            chain: 1,
            owner: { id: 'user-1' },
            session_title: 'Deploy check',
        });
        expect(body.summary.active).toBe(1);
        expect(body.scope.viewOthers).toBe(true);
        expect(mockFn(listReminders)).toHaveBeenCalledWith(
            { tenantDbName: 'tenant_acme', tenantId: 'tenant-1', projectId: 'proj-1' },
            expect.objectContaining({ agentKey: 'field-ops', active: true }),
        );
    });

    it('status=all lists finished ones too; sessionId narrows to one session', async () => {
        mockFn(listReminders).mockResolvedValue([]);
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/reminders?status=all&sessionId=conv-1' });
        expect(res.statusCode).toBe(200);
        expect(mockFn(listReminders)).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ active: false, conversationId: 'conv-1' }));
    });

    it('404s for another project\'s agent', async () => {
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-9/reminders' });
        expect(res.statusCode).toBe(404);
        expect(mockFn(listReminders)).not.toHaveBeenCalled();
    });
});

describe('POST /agents/:agentId/runs/:runId/fire', () => {
    it('refuses a run that is not a reminder of this agent', async () => {
        mockFn(getAgentRunStatus).mockResolvedValue(reminder({ channel: 'runs' }));
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/runs/run_rem-1/fire' });
        expect(res.statusCode).toBe(404);
        expect(mockFn(fireReminderNow)).not.toHaveBeenCalled();
    });

    it('starts a waiting reminder now, and says why when it cannot', async () => {
        mockFn(getAgentRunStatus).mockResolvedValue(reminder());
        mockFn(fireReminderNow).mockResolvedValueOnce({ kind: 'fired', run: reminder({ status: 'queued' }) });
        const app = await agentsApp();
        const ok = await app.inject({ method: 'POST', url: '/api/agents/agent-1/runs/run_rem-1/fire' });
        expect(ok.statusCode).toBe(200);
        expect(parseJsonBody<{ reminder: { status: string } }>(ok.body).reminder.status).toBe('queued');
        expect(mockFn(fireReminderNow)).toHaveBeenCalledWith(
            expect.objectContaining({ projectId: 'proj-1' }),
            'run_rem-1',
            expect.objectContaining({ agentKey: 'field-ops', actor: expect.objectContaining({ userId: 'user-1', via: 'dashboard' }) }),
        );

        mockFn(fireReminderNow).mockResolvedValueOnce({ kind: 'busy', message: 'The session is waiting for an approval or an answer.' });
        const busy = await app.inject({ method: 'POST', url: '/api/agents/agent-1/runs/run_rem-1/fire' });
        expect(busy.statusCode).toBe(409);
        expect(parseJsonBody<{ error: string }>(busy.body).error).toContain('waiting');
    });
});

describe('POST /agents/:agentId/runs/:runId/cancel on a reminder', () => {
    it('cancels a waiting reminder through the reminder service (audited)', async () => {
        mockFn(getAgentRunStatus).mockResolvedValue(reminder());
        mockFn(cancelReminder).mockResolvedValue({ kind: 'canceled', run: reminder({ status: 'canceled' }) });
        const app = await agentsApp();
        const res = await app.inject({ method: 'POST', url: '/api/agents/agent-1/runs/run_rem-1/cancel' });
        expect(res.statusCode).toBe(200);
        expect(parseJsonBody<{ run: { status: string } }>(res.body).run.status).toBe('canceled');
        expect(mockFn(requestAgentRunCancellation)).not.toHaveBeenCalled();
    });
});

describe('GET /agents/:agentId/sessions rows', () => {
    it('carry the active run and the waiting reminders; a reminder\'s own wait is not an active run', async () => {
        mockFn(listConversations).mockResolvedValue([CONVERSATION, { ...CONVERSATION, _id: 'conv-2' }]);
        mockFn(listAgentRuns).mockResolvedValue([
            reminder(),
            { ...reminder({ _id: 'run-2', conversationId: 'conv-2', channel: 'runs', status: 'running' }), notBefore: null },
        ]);
        mockFn(activeRemindersBySession).mockResolvedValue(new Map([['conv-1', { active: 2, nextAt: new Date('2026-10-19T15:00:00Z') }]]));
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/sessions' });
        expect(res.statusCode).toBe(200);
        const rows = parseJsonBody<{ sessions: Array<Record<string, unknown>> }>(res.body).sessions;
        expect(rows[0].activeRun).toBeUndefined();
        expect(rows[0].reminders).toEqual({ active: 2, nextAt: '2026-10-19T15:00:00.000Z' });
        expect(rows[1].activeRun).toEqual({ id: 'run_run-2', status: 'running', cancelRequested: false });
        expect(rows[1].reminders).toBeUndefined();
    });

    it('triggerId lists the sessions that trigger\'s runs ran in', async () => {
        mockFn(listAgentRuns).mockImplementation(async (_db: string, filter: { triggerId?: string }) => (
            filter.triggerId ? [reminder({ _id: 'run-3', channel: 'trigger', status: 'succeeded', triggerId: 'trg-1' })] : []
        ));
        mockFn(activeRemindersBySession).mockResolvedValue(new Map());
        const app = await agentsApp();
        const res = await app.inject({ method: 'GET', url: '/api/agents/agent-1/sessions?triggerId=trg-1' });
        expect(res.statusCode).toBe(200);
        const rows = parseJsonBody<{ sessions: Array<{ _id: string }> }>(res.body).sessions;
        expect(rows.map((row) => row._id)).toEqual(['conv-1']);
        expect(mockFn(listConversations)).not.toHaveBeenCalled();
    });
});
