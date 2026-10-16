/**
 * Unit tests — a turn traced across a pause (agent-sdk ≥ 0.14): the approval,
 * question and client-tool steps as the session view reads them, the
 * continued-part merge both write paths use, and the closing of a paused
 * trace nobody will resume.
 */

import { describe, expect, it, vi } from 'vitest';

const metrics = vi.hoisted(() => ({ recordAgentSessionOutcome: vi.fn<(params: unknown) => Promise<null>>(async () => null) }));
vi.mock('@/lib/services/tracing/traceEntityMetrics', () => metrics);

import { buildSessionModel, flattenTree, humanOutcomeText, stepCategory, type TraceEventInput } from '@/components/tracing/sessionModel';
import { humanStep } from '@/lib/shared/tracingSections';
import { mergeContinuedSessionDoc, readTraceContinuationMarker } from '@/lib/services/tracingContinuation';
import { closePausedTrace } from '@/lib/services/agents/pausedTraceClosure';

const T0 = Date.parse('2026-10-15T12:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

/** The event stream agent-sdk 0.14 writes for: model asks → approval waits 60s → tool runs → model answers. */
function approvalTurn(): TraceEventInput[] {
  return [
    { id: 'e1', sequence: 1, type: 'agent_iteration', label: 'Iteration 1', timestamp: at(0), spanId: 'it1', parentSpanId: 'root' },
    { id: 'e2', sequence: 2, type: 'ai_call', label: 'AI Call', timestamp: at(1_000), durationMs: 1_000, spanId: 'a1', parentSpanId: 'it1', model: 'gpt-5' },
    {
      id: 'e3', sequence: 3, type: 'tool_approval', label: 'Approval requested · send_mail', timestamp: at(1_010), status: 'pending', spanId: 'ap1', parentSpanId: 'it1',
      sections: [{ kind: 'metadata', label: 'Approval', data: { approvalId: 'ap_1', status: 'pending' } } as never],
    },
    { id: 'e4', sequence: 4, type: 'agent_iteration', label: 'Iteration 2', timestamp: at(61_020), spanId: 'it2', parentSpanId: 'root' },
    {
      id: 'e5', sequence: 5, type: 'tool_approval', label: 'Approved · send_mail', timestamp: at(61_010), durationMs: 60_000, status: 'success', spanId: 'ap2', parentSpanId: 'it2',
      sections: [{ kind: 'metadata', label: 'Decision', data: { approvalId: 'ap_1', decision: 'approved', decidedBy: 'ayse' } } as never],
    },
    { id: 'e6', sequence: 6, type: 'tool_call', label: 'Tool Execution - send_mail', toolName: 'send_mail', timestamp: at(61_500), durationMs: 480, spanId: 't1', parentSpanId: 'it2' },
    { id: 'e7', sequence: 7, type: 'ai_call', label: 'AI Call', timestamp: at(62_500), durationMs: 990, spanId: 'a2', parentSpanId: 'it2', model: 'gpt-5' },
  ];
}

describe('humanStep', () => {
  it('reads the request and the decision of an approval', () => {
    const [, , pending, , decided] = approvalTurn();
    expect(humanStep(pending)).toEqual({ kind: 'approval', key: 'ap_1', state: 'pending', by: undefined });
    expect(humanStep(decided)).toEqual({ kind: 'approval', key: 'ap_1', state: 'approved', by: 'ayse' });
  });

  it('reads an answered question and a host-run tool', () => {
    expect(humanStep({
      type: 'user_question',
      status: 'success',
      sections: [{ kind: 'metadata', data: { questionId: 'q1', status: 'answered', answeredBy: 'user_1' } }],
    })).toEqual({ kind: 'question', key: 'q1', state: 'answered', by: 'user_1' });
    expect(humanStep({
      type: 'tool_call',
      status: 'pending',
      sections: [{ kind: 'metadata', label: 'Client tool', data: { questionId: 'q2', status: 'pending' } }],
    })).toEqual({ kind: 'client_tool', key: 'q2', state: 'pending', by: undefined });
  });

  it('leaves ordinary tool calls alone and still reads an approval from another integration', () => {
    expect(humanStep({ type: 'tool_call', status: 'success', sections: [{ kind: 'tool_call' }] })).toBeUndefined();
    // No ids, no decision field: the event's own status is all there is.
    expect(humanStep({ type: 'tool_approval', status: 'skipped' })).toEqual({ kind: 'approval', key: undefined, state: 'cancelled', by: undefined });
  });

  it('treats an approval as a person\'s step, not a tool', () => {
    expect(stepCategory('tool_approval')).toBe('human');
    expect(stepCategory('user_question')).toBe('human');
    expect(stepCategory('tool_call')).toBe('tool');
  });
});

describe('session view of a paused-and-resumed turn', () => {
  it('folds the request into its decision and books the wait as waiting, not agent time', () => {
    const model = buildSessionModel(approvalTurn(), { startedAt: at(0), durationMs: 63_500 });
    const rows = flattenTree(model.tree).map(({ node }) => node);
    expect(rows.map((node) => node.event?.id)).not.toContain('e3');
    const approval = rows.find((node) => node.event?.id === 'e5')!;
    expect(approval.category).toBe('human');
    expect(approval.waiting).toBe(false);
    expect(humanOutcomeText(approval.human!)).toBe('→ approved by ayse');
    expect(model.breakdown!.byCategory.waiting).toBe(60_000);
    // The slowest step is the agent's, not the person's.
    expect(model.breakdown!.slowest!.node.category).not.toBe('human');
    expect(model.resumed).toBe(false);
  });

  it('keeps a request nobody answered, marked waiting', () => {
    const model = buildSessionModel(approvalTurn().slice(0, 3), { startedAt: at(0) });
    const pending = flattenTree(model.tree).map(({ node }) => node).find((node) => node.event?.id === 'e3')!;
    expect(pending.waiting).toBe(true);
    expect(humanOutcomeText(pending.human!)).toBe('→ waiting');
  });
});

describe('continued trace parts', () => {
  it('reads only a valid continuation marker', () => {
    expect(readTraceContinuationMarker({ continuation: { part: 2, firstSequence: 4 } })).toEqual({ part: 2, firstSequence: 4 });
    expect(readTraceContinuationMarker({ continuation: { part: 1, firstSequence: 1 } })).toBeUndefined();
    expect(readTraceContinuationMarker({ continuation: { part: 2, firstSequence: 0 } })).toBeUndefined();
    expect(readTraceContinuationMarker({})).toBeUndefined();
    expect(readTraceContinuationMarker(null)).toBeUndefined();
  });

  it('adds what the part derived to what earlier parts stored, keeping the first start', () => {
    const doc = {
      sessionId: 's1',
      startedAt: new Date(at(61_000)),
      modelsUsed: ['gpt-5'],
      toolsUsed: ['send_mail'],
      totalReasoningTokens: 10,
      truncatedEvents: 0,
      metadata: { part: 2 },
      agentModel: 'unknown-model',
      agent: { name: 'mailer' },
    } as never;
    const existing = {
      sessionId: 's1',
      startedAt: new Date(at(0)),
      modelsUsed: ['gpt-5'],
      toolsUsed: ['search'],
      totalReasoningTokens: 5,
      truncatedEvents: 1,
      metadata: { tag: 'x' },
      agentModel: 'gpt-5',
      agent: { id: 'a1' },
    } as never;
    mergeContinuedSessionDoc(doc, existing, { storedEvents: 3, newEvents: 4 });
    expect(doc).toMatchObject({
      modelsUsed: ['gpt-5'],
      toolsUsed: ['search', 'send_mail'],
      totalReasoningTokens: 15,
      truncatedEvents: 1,
      totalEvents: 7,
      metadata: { tag: 'x', part: 2 },
      agentModel: 'gpt-5',
      agent: { id: 'a1', name: 'mailer' },
    });
    expect((doc as { startedAt: Date }).startedAt.toISOString()).toBe(at(0));
  });
});

describe('closePausedTrace', () => {
  const pausedCtx = { __traceContinuation: { v: 1, sessionId: 's1', traceId: 't1', rootSpanId: 'root', nextSequence: 4 } };
  const action = {
    kind: 'tool_approval',
    sdkId: 'ap_1',
    toolCallId: 'call_1',
    toolName: 'send_mail',
    requestedAt: new Date(at(1_010)),
  };

  function fakeDb(status: string) {
    return {
      findAgentTracingSessionById: vi.fn().mockResolvedValue({ sessionId: 's1', agentName: 'mailer', status, startedAt: new Date(at(0)), totalEvents: 3, eventCounts: { ai_call: 1, tool_approval: 1 }, totalInputTokens: 10, totalOutputTokens: 5 }),
      createAgentTracingEvent: vi.fn().mockResolvedValue(undefined),
      updateAgentTracingSession: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('appends the ending and closes a session still paused', async () => {
    const db = fakeDb('paused');
    await closePausedTrace(db as never, {
      projectId: 'p1',
      tenantId: 'tn',
      pausedCtx,
      closure: { outcome: 'cancelled', resolvedBy: 'user:u1', actions: [action as never] },
    });
    const event = db.createAgentTracingEvent.mock.calls[0][0];
    expect(event).toMatchObject({ sessionId: 's1', sequence: 4, type: 'tool_approval', status: 'skipped', parentSpanId: 'root' });
    expect(humanStep(event)).toEqual({ kind: 'approval', key: 'ap_1', state: 'cancelled', by: 'user:u1' });
    expect(db.updateAgentTracingSession.mock.calls[0][1]).toMatchObject({
      status: 'cancelled',
      totalEvents: 4,
      eventCounts: { ai_call: 1, tool_approval: 2 },
    });
  });

  it('books the run once it is closed, as it will never resume', async () => {
    metrics.recordAgentSessionOutcome.mockClear();
    const db = { ...fakeDb('paused'), getCurrentTenantDbName: vi.fn(() => 'tenant_scoped') };
    await closePausedTrace(db as never, {
      projectId: 'p1', tenantId: 'tn', pausedCtx, closure: { outcome: 'expired', resolvedBy: 'system:timeout', actions: [action as never] },
    });
    expect(metrics.recordAgentSessionOutcome).toHaveBeenCalledTimes(1);
    expect(metrics.recordAgentSessionOutcome.mock.calls[0][0]).toMatchObject({
      tenantDbName: 'tenant_scoped', tenantId: 'tn', projectId: 'p1', source: 'hosted',
      session: { sessionId: 's1', agentName: 'mailer', status: 'expired', totalInputTokens: 10, totalOutputTokens: 5 },
    });

    metrics.recordAgentSessionOutcome.mockClear();
    await closePausedTrace(fakeDb('paused') as never, {
      projectId: 'p1', tenantId: 'tn', tenantDbName: 'tenant_given', pausedCtx, closure: { outcome: 'cancelled', actions: [action as never] },
    });
    expect(metrics.recordAgentSessionOutcome.mock.calls[0][0]).toMatchObject({ tenantDbName: 'tenant_given', session: { status: 'cancelled' } });
  });

  it('leaves a session a resume already finished, and a run with no continuation', async () => {
    const finished = fakeDb('success');
    await closePausedTrace(finished as never, { projectId: 'p1', tenantId: 'tn', pausedCtx, closure: { outcome: 'expired', actions: [action as never] } });
    expect(finished.createAgentTracingEvent).not.toHaveBeenCalled();
    expect(finished.updateAgentTracingSession).not.toHaveBeenCalled();

    const untraced = fakeDb('paused');
    await closePausedTrace(untraced as never, { projectId: 'p1', tenantId: 'tn', pausedCtx: {}, closure: { outcome: 'expired', actions: [action as never] } });
    expect(untraced.findAgentTracingSessionById).not.toHaveBeenCalled();
  });
});
