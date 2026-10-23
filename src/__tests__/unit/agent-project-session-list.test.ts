/**
 * The service behind the cross-agent Sessions list: cursors, and the stale-run check that is skipped for
 * sessions the caller already knows have a run in flight.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
    switchToTenant: vi.fn(),
    listProjectAgentConversations: vi.fn(),
    listAgentRuns: vi.fn(),
    updateAgentConversationRuntime: vi.fn(),
}));

vi.mock('@/lib/database', () => ({ getDatabase: vi.fn(async () => db) }));

import { Buffer } from 'node:buffer';
import { decodeActivityCursor, decodeSessionCursor, encodeActivityCursor, listProjectSessions } from '@/lib/services/agents/sessionList';

const cursorOf = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

describe('session cursors', () => {
    it('round-trips', () => {
        const updatedAt = new Date('2026-10-01T10:00:00Z');
        expect(decodeActivityCursor(encodeActivityCursor({ updatedAt, _id: 's1' }))).toEqual({ updatedAt, id: 's1' });
    });

    it('rejects a timestamp that is a finite number but no date', () => {
        expect(decodeSessionCursor(cursorOf([1e20, 'x']))).toBeNull();
        expect(decodeActivityCursor(cursorOf([1e20, 'x']))).toBeNull();
        expect(decodeSessionCursor(cursorOf([-1e20, 'x']))).toBeNull();
    });

    it('rejects what this service did not issue', () => {
        expect(decodeSessionCursor('not-a-cursor')).toBeNull();
        expect(decodeSessionCursor(cursorOf([1, '']))).toBeNull();
        expect(decodeSessionCursor(cursorOf(['1', 'x']))).toBeNull();
    });
});

describe('listProjectSessions stale-run check', () => {
    const staleRow = (id: string) => ({
        _id: id, tenantId: 't1', projectId: 'p1', agentKey: 'a', createdBy: 'u', messages: [],
        runtimeStatus: 'running', updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    beforeEach(() => {
        vi.clearAllMocks();
        db.listAgentRuns.mockResolvedValue([]);
        db.updateAgentConversationRuntime.mockResolvedValue(null);
        db.listProjectAgentConversations.mockResolvedValue([staleRow('known'), staleRow('unknown')]);
    });

    it('leaves a "running" row with a known run in flight alone and questions the others as before', async () => {
        const { sessions } = await listProjectSessions('tenant_x', { projectId: 'p1', limit: 10, knownInFlight: new Set(['known']) });
        expect(sessions.map((row) => [row._id, row.runtimeStatus])).toEqual([['known', 'running'], ['unknown', 'idle']]);
        expect(db.listAgentRuns).toHaveBeenCalledTimes(1);
        expect(db.listAgentRuns.mock.calls[0][0]).toMatchObject({ conversationId: 'unknown' });
    });

    it('is not a provider filter', async () => {
        await listProjectSessions('tenant_x', { projectId: 'p1', limit: 10, knownInFlight: new Set(['known']) });
        expect(db.listProjectAgentConversations.mock.calls[0][0]).not.toHaveProperty('knownInFlight');
        expect(db.listProjectAgentConversations.mock.calls[0][0]).toMatchObject({ projectId: 'p1', limit: 11 });
    });

    it('questions every stale row without the set', async () => {
        await listProjectSessions('tenant_x', { projectId: 'p1', limit: 10 });
        expect(db.listAgentRuns).toHaveBeenCalledTimes(2);
    });
});
