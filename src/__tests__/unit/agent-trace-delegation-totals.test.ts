/**
 * A turn that delegated: its trace session totals take in the sub-agents' model
 * calls (they add no trace steps), and the approval steps of a child's tool name
 * the child.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/database', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/database')>();
  const db = {
    switchToTenant: vi.fn(async () => undefined),
    findAgentTracingSessionById: vi.fn(async (id: string) => hoisted.sessions.get(id) ?? null),
    listAgentTracingEvents: vi.fn(async () => []),
    createAgentTracingSession: vi.fn(async (doc: Record<string, unknown>) => { hoisted.sessions.set(String(doc.sessionId), doc); return doc; }),
    updateAgentTracingSession: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      hoisted.sessions.set(id, { ...hoisted.sessions.get(id), ...patch });
      return hoisted.sessions.get(id);
    }),
    deleteAgentTracingEvents: vi.fn(async () => 0),
    createAgentTracingEvent: vi.fn(async (doc: Record<string, unknown>) => { hoisted.events.push(doc); return doc; }),
  };
  return { ...actual, getDatabase: vi.fn(async () => db) };
});
vi.mock('@/lib/services/tracing/traceEntityMetrics', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/services/tracing/traceEntityMetrics')>()),
  recordAgentSessionOutcome: vi.fn(async () => undefined),
  recordTraceEventMetrics: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/agentTracing', () => ({ recordTracingSessionCreated: vi.fn(() => ({})) }));

import { createInternalTracingSink, reconcileTraceTotals } from '@/lib/services/agents/agentService';
import { nameSubagentOnApprovalStep } from '@/lib/services/agents/subagentEvents';

beforeEach(() => {
  hoisted.sessions.clear();
  hoisted.events.length = 0;
});

describe('reconcileTraceTotals', () => {
  it('raises the session totals to the turn usage and never lowers them', async () => {
    hoisted.sessions.set('s1', { sessionId: 's1', totalInputTokens: 24, totalOutputTokens: 14, totalCachedInputTokens: 0 });
    await reconcileTraceTotals('t', 'p', 's1', { inputTokens: 48, outputTokens: 28 });
    expect(hoisted.sessions.get('s1')).toMatchObject({ totalInputTokens: 48, totalOutputTokens: 28 });
    await reconcileTraceTotals('t', 'p', 's1', { inputTokens: 10, outputTokens: 10 });
    expect(hoisted.sessions.get('s1')).toMatchObject({ totalInputTokens: 48, totalOutputTokens: 28 });
  });

  it('does nothing without a saved session or usage', async () => {
    await expect(reconcileTraceTotals('t', 'p', undefined, { inputTokens: 5 })).resolves.toBeUndefined();
    await expect(reconcileTraceTotals('t', 'p', 'missing', { inputTokens: 5 })).resolves.toBeUndefined();
  });
});

describe('the approval step of a child tool', () => {
  const step = {
    type: 'tool_approval', label: 'Approval requested · get_weather #3', sequence: 3,
    sections: [{ kind: 'metadata', data: { approvalId: 'ap1', status: 'pending' } }],
  };

  it('names the sub-agent in the label and metadata', () => {
    const named = nameSubagentOnApprovalStep(step, new Map([['ap1', 'worker']]));
    expect(named.label).toBe('Approval requested · get_weather (sub-agent worker) #3');
    expect(named.metadata).toMatchObject({ subagent: 'worker' });
  });

  it('leaves the parent\'s own approvals alone', () => {
    expect(nameSubagentOnApprovalStep(step, new Map([['other', 'worker']])).label).toBe(step.label);
  });

  it('is applied when the sink saves the session', async () => {
    const sink = await createInternalTracingSink('t', 'tn', 'p', undefined, 'agent-1', undefined, new Map([['ap1', 'worker']]));
    await (sink as unknown as { onSession: (s: unknown) => Promise<void> }).onSession({
      sessionId: 's2', traceId: 'tr', agent: { name: 'a' }, startedAt: new Date().toISOString(), summary: {}, errors: [],
      events: [{ id: 'e3', type: 'tool_approval', label: step.label, sequence: 3, sections: step.sections, actor: {} }],
    });
    expect(hoisted.events[0]).toMatchObject({ label: 'Approval requested · get_weather (sub-agent worker) #3', metadata: { subagent: 'worker' } });
  });
});
