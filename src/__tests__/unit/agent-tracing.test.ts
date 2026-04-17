/**
 * Unit tests — AgentTracingService
 * Tests: listThreads, getThreadDetail, ingestBatch,
 *        startStreamingSession, endStreamingSession
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/database', () => ({
  getDatabase: vi.fn(),
}));

import { getDatabase } from '@/lib/database';
import { createMockDb } from '../helpers/db.mock';
import { AgentTracingService } from '@/lib/services/agentTracing';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TENANT_DB = 'tenant_acme';
const TENANT_ID = 'tenant-1';
const PROJECT_ID = 'proj-1';
const SESSION_ID = 'session-abc-123';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    agentName: 'my-agent',
    agentVersion: '1.0.0',
    status: 'success',
    startedAt: new Date('2025-01-10T10:00:00Z'),
    endedAt: new Date('2025-01-10T10:01:00Z'),
    durationMs: 60_000,
    totalEvents: 5,
    totalInputTokens: 100,
    totalOutputTokens: 200,
    totalCachedInputTokens: 0,
    modelsUsed: ['gpt-4o'],
    toolsUsed: ['search'],
    metadata: {},
    ...overrides,
  };
}

// ── listThreads ───────────────────────────────────────────────────────────────

describe('AgentTracingService.listThreads', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listAgentTracingThreads.mockResolvedValue({ threads: [], total: 0 });
  });

  it('calls switchToTenant with correct database name', async () => {
    await AgentTracingService.listThreads(TENANT_DB, PROJECT_ID);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('returns threads from db', async () => {
    const thread = { threadId: 'thread-1', sessionsCount: 2, totalEvents: 10 };
    db.listAgentTracingThreads.mockResolvedValue({ threads: [thread], total: 1 });

    const result = await AgentTracingService.listThreads(TENANT_DB, PROJECT_ID);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].threadId).toBe('thread-1');
    expect(result.total).toBe(1);
  });

  it('passes filter options to db.listAgentTracingThreads', async () => {
    await AgentTracingService.listThreads(TENANT_DB, PROJECT_ID, {
      agent: 'my-agent',
      status: 'success',
      limit: '10',
    });

    expect(db.listAgentTracingThreads).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'my-agent', status: 'success', limit: '10' }),
      PROJECT_ID,
    );
  });

  it('defaults limit to 50 when not provided', async () => {
    await AgentTracingService.listThreads(TENANT_DB, PROJECT_ID);
    expect(db.listAgentTracingThreads).toHaveBeenCalledWith(
      expect.objectContaining({ limit: '50', skip: '0' }),
      PROJECT_ID,
    );
  });
});

// ── getThreadDetail ───────────────────────────────────────────────────────────

describe('AgentTracingService.getThreadDetail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns null when no sessions found for thread', async () => {
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });

    const result = await AgentTracingService.getThreadDetail(TENANT_DB, PROJECT_ID, 'thread-x');
    expect(result).toBeNull();
  });

  it('returns aggregated thread detail when sessions exist', async () => {
    const session1 = makeSession({ startedAt: new Date('2025-01-10T10:00:00Z'), endedAt: new Date('2025-01-10T10:01:00Z') });
    const session2 = makeSession({
      sessionId: 'session-2',
      startedAt: new Date('2025-01-10T10:02:00Z'),
      endedAt: new Date('2025-01-10T10:03:00Z'),
      totalInputTokens: 50,
      totalOutputTokens: 100,
    });
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session1, session2], total: 2 });

    const result = await AgentTracingService.getThreadDetail(TENANT_DB, PROJECT_ID, 'thread-1');

    expect(result).not.toBeNull();
    expect(result!.sessionsCount).toBe(2);
    expect(result!.totalInputTokens).toBe(150); // 100 + 50
    expect(result!.totalOutputTokens).toBe(300); // 200 + 100
    expect(db.listAgentTracingSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        includeTotal: false,
        limit: 1000,
        threadId: 'thread-1',
      }),
      PROJECT_ID,
    );
  });

  it('computes overallStatus as error when any session has error', async () => {
    const session1 = makeSession({ status: 'success' });
    const session2 = makeSession({ sessionId: 'session-2', status: 'error' });
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session1, session2], total: 2 });

    const result = await AgentTracingService.getThreadDetail(TENANT_DB, PROJECT_ID, 'thread-err');
    expect(result!.status).toBe('error');
  });

  it('computes overallStatus as success when all sessions are complete', async () => {
    const session = makeSession({ status: 'success' });
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session], total: 1 });

    const result = await AgentTracingService.getThreadDetail(TENANT_DB, PROJECT_ID, 'thread-ok');
    expect(result!.status).toBe('success');
  });

  it('merges modelsUsed and toolsUsed across sessions', async () => {
    const session1 = makeSession({ modelsUsed: ['gpt-4o'], toolsUsed: ['search'] });
    const session2 = makeSession({ sessionId: 's2', modelsUsed: ['claude-3'], toolsUsed: ['search', 'calculator'] });
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [session1, session2], total: 2 });

    const result = await AgentTracingService.getThreadDetail(TENANT_DB, PROJECT_ID, 'thread-models');
    expect(result!.modelsUsed).toContain('gpt-4o');
    expect(result!.modelsUsed).toContain('claude-3');
    expect(result!.toolsUsed).toContain('search');
    expect(result!.toolsUsed).toContain('calculator');
    // Unique values only
    expect(result!.toolsUsed.filter((t) => t === 'search')).toHaveLength(1);
  });
});

// ── listSessions ──────────────────────────────────────────────────────────────

describe('AgentTracingService.listSessions', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });
  });

  it('calls switchToTenant with correct db name', async () => {
    await AgentTracingService.listSessions(TENANT_DB, PROJECT_ID);
    expect(db.switchToTenant).toHaveBeenCalledWith(TENANT_DB);
  });

  it('returns mapped sessions with aggregated token totals', async () => {
    db.listAgentTracingSessions.mockResolvedValue({
      sessions: [makeSession({ totalInputTokens: 100, totalOutputTokens: 200 })],
      total: 1,
    });

    const result = await AgentTracingService.listSessions(TENANT_DB, PROJECT_ID);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].totalTokens).toBe(300); // 100 + 200
    expect(result.total).toBe(1);
  });

  it('passes filter options to db.listAgentTracingSessions', async () => {
    await AgentTracingService.listSessions(TENANT_DB, PROJECT_ID, {
      agent: 'my-agent',
      status: 'error',
    });

    expect(db.listAgentTracingSessions).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'my-agent', status: 'error' }),
      PROJECT_ID,
    );
  });

  it('defaults limit to 50 when not provided', async () => {
    await AgentTracingService.listSessions(TENANT_DB, PROJECT_ID);
    expect(db.listAgentTracingSessions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: '50', skip: '0' }),
      PROJECT_ID,
    );
  });
});

// ── getSessionDetail ──────────────────────────────────────────────────────────

describe('AgentTracingService.getSessionDetail', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns null when session not found', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(null);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);
    expect(result).toBeNull();
  });

  it('returns session and events when session exists', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'llm_call',
        label: 'LLM Call',
        timestamp: new Date(),
        status: 'success',
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);

    expect(result).not.toBeNull();
    expect(result!.session.sessionId).toBe(SESSION_ID);
    expect(result!.events).toHaveLength(1);
    expect(result!.events[0].type).toBe('llm_call');
  });

  it('calls db with correct sessionId and projectId', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([]);

    await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);

    expect(db.findAgentTracingSessionById).toHaveBeenCalledWith(SESSION_ID, PROJECT_ID);
    expect(db.listAgentTracingEvents).toHaveBeenCalledWith(SESSION_ID, PROJECT_ID, undefined);
  });

  it('supports summary event mode for faster initial loads', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        _id: 'event-1',
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'llm_call',
        label: 'LLM Call',
        status: 'success',
        timestamp: new Date(),
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(
      TENANT_DB,
      PROJECT_ID,
      SESSION_ID,
      { includeEventContent: false },
    );

    expect(result?.events[0]).not.toHaveProperty('metadata');
    expect(db.listAgentTracingEvents).toHaveBeenCalledWith(
      SESSION_ID,
      PROJECT_ID,
      expect.objectContaining({ projection: expect.any(Object) }),
    );
  });

  it('returns a single event detail when requested', async () => {
    db.findAgentTracingEventById.mockResolvedValue({
      _id: 'event-1',
      id: 'external-event-1',
      sessionId: SESSION_ID,
      tenantId: TENANT_ID,
      sequence: 1,
      type: 'llm_call',
      label: 'LLM Call',
      status: 'success',
      metadata: { requestId: 'req-1' },
    });

    const result = await AgentTracingService.getSessionEventDetail(
      TENANT_DB,
      PROJECT_ID,
      SESSION_ID,
      'external-event-1',
    );

    expect(result).toEqual({
      event: expect.objectContaining({
        id: 'external-event-1',
        metadata: { requestId: 'req-1' },
        type: 'llm_call',
      }),
    });
    expect(db.findAgentTracingEventById).toHaveBeenCalledWith(
      SESSION_ID,
      'external-event-1',
      PROJECT_ID,
    );
  });
});

// ── getDashboardOverview ─────────────────────────────────────────────────────

describe('AgentTracingService.getDashboardOverview', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('aggregates token usage per agent for dashboard reporting', async () => {
    db.listAgentTracingSessions.mockImplementation(async (filters?: { limit?: number }) => {
      const sessions = [
        makeSession({
          agentName: 'alpha-agent',
          startedAt: new Date('2025-01-10T10:00:00Z'),
          status: 'success',
          totalEvents: 4,
          totalInputTokens: 100,
          totalOutputTokens: 50,
          totalCachedInputTokens: 25,
          durationMs: 1_000,
        }),
        makeSession({
          sessionId: 'session-2',
          agentName: 'alpha-agent',
          startedAt: new Date('2025-01-09T10:00:00Z'),
          status: 'error',
          totalEvents: 2,
          totalInputTokens: 20,
          totalOutputTokens: 30,
          totalCachedInputTokens: 5,
          durationMs: 500,
        }),
        makeSession({
          sessionId: 'session-3',
          agentName: 'beta-agent',
          startedAt: new Date('2025-01-11T10:00:00Z'),
          status: 'success',
          totalEvents: 1,
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCachedInputTokens: 0,
          durationMs: 200,
        }),
      ];

      if (filters?.limit === 10) {
        return { sessions: sessions.slice(0, 3), total: 3 };
      }

      return { sessions, total: sessions.length };
    });

    const result = await AgentTracingService.getDashboardOverview(TENANT_DB, PROJECT_ID);

    expect(result.analytics.totals.totalInputTokens).toBe(130);
    expect(result.analytics.totals.totalOutputTokens).toBe(85);
    expect(result.analytics.totals.totalCachedInputTokens).toBe(30);
    expect(result.analytics.totals.totalTokens).toBe(215);

    expect(result.recentAgents[0].name).toBe('beta-agent');
    expect(result.recentAgents[1].name).toBe('alpha-agent');

    const alphaAgent = result.analytics.agents.find((item) => item.name === 'alpha-agent');
    expect(alphaAgent).toBeDefined();
    expect(alphaAgent?.totalTokens).toBe(200);
    expect(alphaAgent?.averageTokensPerSession).toBe(100);
    expect(alphaAgent?.latestStatus).toBe('success');

    expect(result.analytics.agents[0].name).toBe('alpha-agent');
    expect(result.analytics.agents[1].name).toBe('beta-agent');
  });

  it('passes from/to filters directly to session queries', async () => {
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });

    await AgentTracingService.getDashboardOverview(TENANT_DB, PROJECT_ID, {
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-01-31T23:59:59.999Z',
    });

    expect(db.listAgentTracingSessions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        from: '2025-01-01T00:00:00.000Z',
        includeTotal: false,
        limit: 10,
        to: '2025-01-31T23:59:59.999Z',
      }),
      PROJECT_ID,
    );
    expect(db.listAgentTracingSessions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        from: '2025-01-01T00:00:00.000Z',
        includeTotal: false,
        limit: 1000,
        to: '2025-01-31T23:59:59.999Z',
      }),
      PROJECT_ID,
    );
  });
});

// ── getAgentOverview ─────────────────────────────────────────────────────────

describe('AgentTracingService.getAgentOverview', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('returns input, output, cached, and average token totals for an agent', async () => {
    db.listAgentTracingSessions.mockResolvedValue({
      sessions: [
        makeSession({
          startedAt: new Date('2025-01-11T10:00:00Z'),
          totalEvents: 3,
          totalInputTokens: 100,
          totalOutputTokens: 40,
          totalCachedInputTokens: 10,
          durationMs: 1_000,
        }),
        makeSession({
          sessionId: 'session-2',
          startedAt: new Date('2025-01-10T10:00:00Z'),
          totalEvents: 2,
          totalInputTokens: 50,
          totalOutputTokens: 10,
          totalCachedInputTokens: 5,
          durationMs: 500,
        }),
      ],
      total: 2,
    });

    const result = await AgentTracingService.getAgentOverview(
      TENANT_DB,
      PROJECT_ID,
      'my-agent',
    );

    expect(result.analytics.totals.totalInputTokens).toBe(150);
    expect(result.analytics.totals.totalOutputTokens).toBe(50);
    expect(result.analytics.totals.totalCachedInputTokens).toBe(15);
    expect(result.analytics.totals.totalTokens).toBe(200);
    expect(result.analytics.totals.averageInputTokensPerSession).toBe(75);
    expect(result.analytics.totals.averageOutputTokensPerSession).toBe(25);
    expect(result.analytics.totals.averageCachedInputTokensPerSession).toBe(8);
    expect(result.analytics.totals.averageTokensPerSession).toBe(100);
    expect(result.analytics.totals.averageDurationMs).toBe(750);
    expect(db.listAgentTracingSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        agentNameExact: 'my-agent',
        includeTotal: false,
        limit: 1000,
      }),
      PROJECT_ID,
    );
  });
});
