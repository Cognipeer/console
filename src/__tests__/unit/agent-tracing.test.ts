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

  it('hides tool details that are a stringified `undefined` spread into a record', async () => {
    // What agent-sdk < 0.9.5 persisted for an absent payload: sanitizeTracePayload
    // returned the literal string "undefined", and ingest spread it into
    // {0:'u',1:'n',…}. Those rows are already in the database, so the read path
    // has to hide them — the UI rendered them as a 9-key object of letters.
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'tool_call',
        timestamp: new Date(),
        toolName: 'list_todos',
        // `{...'undefined'}`, written out because TS will not spread a string.
        metadata: {
          toolDetails: Object.fromEntries(Array.from('undefined', (c, i) => [i, c])),
          finishReason: 'stop',
        },
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);
    // The mapper's return type is a summary|detail union; this suite asserts on
    // the detail shape.
    const event = result!.events[0] as Record<string, unknown>;

    // Neither the folded field nor the raw metadata bag (its own UI tab) may
    // carry the wreckage.
    expect(event.toolDetails).not.toHaveProperty('0');
    expect(event.metadata).not.toHaveProperty('toolDetails');
    // Unrelated metadata survives — this strips one bad value, not the bag.
    expect(event.metadata).toMatchObject({ finishReason: 'stop' });
  });

  it('keeps genuine tool details untouched', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'tool_call',
        timestamp: new Date(),
        metadata: { toolDetails: { name: 'list_todos', description: 'List todos' } },
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);

    expect((result!.events[0] as Record<string, unknown>).toolDetails).toMatchObject({
      name: 'list_todos',
      description: 'List todos',
    });
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

// ── finishReason / reasoningTokens (Phase 3 read path) ──────────────────────

describe('AgentTracingService — finishReason / reasoningTokens exposure', () => {
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb();
    (getDatabase as ReturnType<typeof vi.fn>).mockResolvedValue(db);
  });

  it('exposes first-class finishReason/reasoningTokens on the event DETAIL mapper', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'ai_call',
        timestamp: new Date(),
        finishReason: 'length',
        reasoningTokens: 42,
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);
    const event = result!.events[0] as Record<string, unknown>;

    expect(event.finishReason).toBe('length');
    expect(event.reasoningTokens).toBe(42);
  });

  it('exposes first-class finishReason/reasoningTokens on the event SUMMARY mapper', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        _id: 'event-1',
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'ai_call',
        timestamp: new Date(),
        finishReason: 'stop',
        reasoningTokens: 7,
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(
      TENANT_DB,
      PROJECT_ID,
      SESSION_ID,
      { includeEventContent: false },
    );
    const event = result!.events[0] as Record<string, unknown>;

    expect(event.finishReason).toBe('stop');
    expect(event.reasoningTokens).toBe(7);
  });

  it('falls back to legacy metadata.finishReason/metadata.reasoningTokens for pre-migration rows (detail)', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'ai_call',
        timestamp: new Date(),
        // No first-class finishReason/reasoningTokens columns — legacy row.
        metadata: { finishReason: 'STOP  ', reasoningTokens: 13 },
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);
    const event = result!.events[0] as Record<string, unknown>;

    // Normalized (trim + lowercase) so old un-normalized rows compare equal
    // to new ones.
    expect(event.finishReason).toBe('stop');
    expect(event.reasoningTokens).toBe(13);
  });

  it('falls back to legacy metadata for pre-migration rows (summary)', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        _id: 'event-1',
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'ai_call',
        timestamp: new Date(),
        metadata: { finishReason: 'Length', reasoningTokens: 9 },
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(
      TENANT_DB,
      PROJECT_ID,
      SESSION_ID,
      { includeEventContent: false },
    );
    const event = result!.events[0] as Record<string, unknown>;

    expect(event.finishReason).toBe('length');
    expect(event.reasoningTokens).toBe(9);
  });

  it('prefers the first-class field over legacy metadata when both are present', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'ai_call',
        timestamp: new Date(),
        finishReason: 'tool_calls',
        reasoningTokens: 5,
        metadata: { finishReason: 'stop', reasoningTokens: 999 },
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);
    const event = result!.events[0] as Record<string, unknown>;

    expect(event.finishReason).toBe('tool_calls');
    expect(event.reasoningTokens).toBe(5);
  });

  it('leaves finishReason/reasoningTokens undefined when neither source has a value', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(makeSession());
    db.listAgentTracingEvents.mockResolvedValue([
      {
        sessionId: SESSION_ID,
        tenantId: TENANT_ID,
        sequence: 1,
        type: 'ai_call',
        timestamp: new Date(),
      },
    ]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);
    const event = result!.events[0] as Record<string, unknown>;

    expect(event.finishReason).toBeUndefined();
    expect(event.reasoningTokens).toBeUndefined();
  });

  it('surfaces session-level totalReasoningTokens/truncatedEvents in getSessionDetail', async () => {
    db.findAgentTracingSessionById.mockResolvedValue(
      makeSession({ totalReasoningTokens: 123, truncatedEvents: 2 }),
    );
    db.listAgentTracingEvents.mockResolvedValue([]);

    const result = await AgentTracingService.getSessionDetail(TENANT_DB, PROJECT_ID, SESSION_ID);

    expect(result!.session.totalReasoningTokens).toBe(123);
    expect(result!.session.truncatedEvents).toBe(2);
  });

  it('surfaces session-level totalReasoningTokens/truncatedEvents in listSessions', async () => {
    db.listAgentTracingSessions.mockResolvedValue({
      sessions: [makeSession({ totalReasoningTokens: 8, truncatedEvents: 1 })],
      total: 1,
    });

    const result = await AgentTracingService.listSessions(TENANT_DB, PROJECT_ID);

    expect(result.sessions[0].totalReasoningTokens).toBe(8);
    expect(result.sessions[0].truncatedEvents).toBe(1);
  });

  it('passes the truncated=true filter through to db.listAgentTracingSessions', async () => {
    db.listAgentTracingSessions.mockResolvedValue({ sessions: [], total: 0 });

    await AgentTracingService.listSessions(TENANT_DB, PROJECT_ID, { truncated: true });

    expect(db.listAgentTracingSessions).toHaveBeenCalledWith(
      expect.objectContaining({ truncated: true }),
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
    db.aggregateAgentTracingDashboard.mockResolvedValue({
      recentSessions: [],
      recentAgents: [
        {
          name: 'beta-agent',
          label: 'beta-agent',
          latestSessionAt: new Date('2025-01-11T10:00:00Z'),
          latestStatus: 'success',
          sessionsCount: 1,
          totalEvents: 1,
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCachedInputTokens: 0,
          totalTokens: 15,
          averageInputTokensPerSession: 10,
          averageOutputTokensPerSession: 5,
          averageCachedInputTokensPerSession: 0,
          averageTokensPerSession: 15,
          averageDurationMs: 200,
        },
        {
          name: 'alpha-agent',
          label: 'alpha-agent',
          latestSessionAt: new Date('2025-01-10T10:00:00Z'),
          latestStatus: 'success',
          sessionsCount: 2,
          totalEvents: 6,
          totalInputTokens: 120,
          totalOutputTokens: 80,
          totalCachedInputTokens: 30,
          totalTokens: 200,
          averageInputTokensPerSession: 60,
          averageOutputTokensPerSession: 40,
          averageCachedInputTokensPerSession: 15,
          averageTokensPerSession: 100,
          averageDurationMs: 750,
        },
      ],
      recentAgentsTotal: 2,
      analytics: {
        totals: {
          sessionsCount: 3,
          totalEvents: 7,
          totalInputTokens: 130,
          totalOutputTokens: 85,
          totalCachedInputTokens: 30,
          totalTokens: 215,
          totalDurationMs: 1700,
          averageInputTokensPerSession: 43,
          averageOutputTokensPerSession: 28,
          averageCachedInputTokensPerSession: 10,
          averageTokensPerSession: 72,
          averageDurationMs: 567,
        },
        tools: {
          totals: {
            totalCalls: 0,
            errorCalls: 0,
            successCalls: 0,
            errorRate: 0,
          },
          items: [],
        },
        statuses: [],
        models: [],
        agents: [
          {
            name: 'alpha-agent',
            label: 'alpha-agent',
            latestSessionAt: new Date('2025-01-10T10:00:00Z'),
            latestStatus: 'success',
            sessionsCount: 2,
            totalEvents: 6,
            totalInputTokens: 120,
            totalOutputTokens: 80,
            totalCachedInputTokens: 30,
            totalTokens: 200,
            averageInputTokensPerSession: 60,
            averageOutputTokensPerSession: 40,
            averageCachedInputTokensPerSession: 15,
            averageTokensPerSession: 100,
            averageDurationMs: 750,
          },
          {
            name: 'beta-agent',
            label: 'beta-agent',
            latestSessionAt: new Date('2025-01-11T10:00:00Z'),
            latestStatus: 'success',
            sessionsCount: 1,
            totalEvents: 1,
            totalInputTokens: 10,
            totalOutputTokens: 5,
            totalCachedInputTokens: 0,
            totalTokens: 15,
            averageInputTokensPerSession: 10,
            averageOutputTokensPerSession: 5,
            averageCachedInputTokensPerSession: 0,
            averageTokensPerSession: 15,
            averageDurationMs: 200,
          },
        ],
        daily: [],
      },
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

  it('passes from/to filters directly to the dashboard aggregate query', async () => {
    await AgentTracingService.getDashboardOverview(TENANT_DB, PROJECT_ID, {
      from: '2025-01-01T00:00:00.000Z',
      to: '2025-01-31T23:59:59.999Z',
    });

    expect(db.aggregateAgentTracingDashboard).toHaveBeenCalledWith(
      {
        from: '2025-01-01T00:00:00.000Z',
        to: '2025-01-31T23:59:59.999Z',
      },
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
