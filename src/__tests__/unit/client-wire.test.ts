import { describe, expect, it } from 'vitest';
import {
  normalizeClientResolveBody,
  toClientErrorBody,
  toClientEventData,
  toClientEventFrame,
  toPublicRunId,
  toClientPendingAction,
  toSnakeCaseDeep,
  toSnakeKey,
} from '@/lib/services/agents/clientWire';

describe('client wire spelling', () => {
  it('snake_cases camelCase keys and leaves snake_case ones alone', () => {
    expect(toSnakeKey('toolCallId')).toBe('tool_call_id');
    expect(toSnakeKey('spentUsd')).toBe('spent_usd');
    expect(toSnakeKey('already_snake')).toBe('already_snake');
    expect(toSnakeKey('_truncated')).toBe('_truncated');
  });

  it('re-keys nested objects and arrays but not tool arguments or free-form answers', () => {
    expect(toSnakeCaseDeep({
      toolCallId: 'c1',
      args: { filePath: '/a', nested: { someKey: 1 } },
      budget: { maxCostUsd: 2, onReach: 'pause' },
      questions: [{ question: 'Q', multiSelect: true }],
      answers: { 'Which Env?': 'prod' },
    })).toEqual({
      tool_call_id: 'c1',
      args: { filePath: '/a', nested: { someKey: 1 } },
      budget: { max_cost_usd: 2, on_reach: 'pause' },
      questions: [{ question: 'Q', multi_select: true }],
      answers: { 'Which Env?': 'prod' },
    });
  });

  it('spells the data of a logged event for a client', () => {
    expect(toClientEventData({ toolCallId: 'c1', durationMs: 12, ok: true })).toEqual({
      tool_call_id: 'c1', duration_ms: 12, ok: true,
    });
    expect(toClientEventData({ stopReason: 'requires_action', pendingActionIds: ['act_1'] })).toEqual({
      stop_reason: 'requires_action', pending_action_ids: ['act_1'],
    });
  });

  it('spells a stream frame like the client event list', () => {
    expect(toClientEventFrame({
      seq: 7, type: 'agent.tool_result', data: { toolCallId: 'c1' }, runId: 'run_1', createdAt: '2024-01-01T00:00:00.000Z',
    })).toEqual({
      seq: 7, type: 'agent.tool_result', data: { tool_call_id: 'c1' }, run_id: 'run_1', created_at: '2024-01-01T00:00:00.000Z',
    });
    // The store holds the bare run id; a client sees the one `GET /agents/runs/{id}` takes.
    expect(toClientEventFrame({ type: 'session.status_idle', data: {}, runId: 'd90f17a3', createdAt: 'now' }).run_id).toBe('run_d90f17a3');
    expect(toPublicRunId('d90f17a3')).toBe('run_d90f17a3');
    expect(toPublicRunId('run_d90f17a3')).toBe('run_d90f17a3');
    // A live-only frame has no seq and no run.
    expect(toClientEventFrame({ type: 'agent.message.delta', data: { text: 'hi' }, createdAt: 'now' })).toEqual({
      type: 'agent.message.delta', data: { text: 'hi' }, created_at: 'now',
    });
  });

  it('spells a pending action for a client', () => {
    expect(toClientPendingAction({
      id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', args: { someArg: 1 }, status: 'pending',
      expiresAt: 'e', requestedAt: 'r',
    })).toEqual({
      id: 'act_1', kind: 'tool_approval', tool_name: 'sandbox_exec', args: { someArg: 1 }, status: 'pending',
      expires_at: 'e', requested_at: 'r',
    });
  });

  it('keeps tool_name off a question (it is not a tool call), on the action and in its event', () => {
    expect(toClientPendingAction({
      id: 'act_2', kind: 'user_question', toolName: 'ask_user_question', questions: [{ question: 'Which env?', multiSelect: false }],
      allowFreeText: true, status: 'pending',
    })).toEqual({
      id: 'act_2', kind: 'user_question', questions: [{ question: 'Which env?', multi_select: false }], allow_free_text: true, status: 'pending',
    });
    expect(toClientEventData({ actionId: 'act_2', kind: 'user_question', toolName: 'ask_user_question', allowFreeText: true })).toEqual({
      action_id: 'act_2', kind: 'user_question', allow_free_text: true,
    });
    // An approval keeps it.
    expect(toClientEventData({ actionId: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec' })).toEqual({
      action_id: 'act_1', kind: 'tool_approval', tool_name: 'sandbox_exec',
    });
  });

  it('keeps the delegating call id off the client event, as on the pending action', () => {
    expect(toClientEventData({ actionId: 'act_3', kind: 'tool_approval', toolName: 'lookup', subagent: 'helper', delegationToolCallId: 'd1' })).toEqual({
      action_id: 'act_3', kind: 'tool_approval', tool_name: 'lookup', subagent: 'helper',
    });
    expect(toClientPendingAction({
      id: 'act_3', kind: 'tool_approval', toolName: 'lookup', subagent: 'helper', delegationToolCallId: 'd1', status: 'pending',
    } as never)).not.toHaveProperty('delegation_tool_call_id');
  });

  it('reads the answer in either spelling, snake_case first', () => {
    expect(normalizeClientResolveBody({ decision: 'allow', approved_args: { a: 1 }, remember_for_session: true })).toEqual({
      decision: 'allow', approvedArgs: { a: 1 }, rememberForSession: true,
    });
    expect(normalizeClientResolveBody({ decision: 'deny', approvedArgs: { a: 2 } })).toEqual({ decision: 'deny', approvedArgs: { a: 2 } });
    expect(normalizeClientResolveBody({ answers: { Q: 'x' }, cancelled: false })).toEqual({ answers: { Q: 'x' }, cancelled: false });
  });

  it('spells the extra fields of an error body', () => {
    expect(toClientErrorBody({ message: 'm', type: 'pending_action', code: 'pending_action', pendingActionIds: ['a'] })).toEqual({
      message: 'm', type: 'pending_action', code: 'pending_action', pending_action_ids: ['a'],
    });
    expect(toClientErrorBody({ message: 'm', type: 'budget_reached', code: 'budget_reached', spentUsd: 1, maxCostUsd: 2 })).toEqual({
      message: 'm', type: 'budget_reached', code: 'budget_reached', spent_usd: 1, max_cost_usd: 2,
    });
    expect(toClientErrorBody({ message: 'm', type: 't' })).toEqual({ message: 'm', type: 't' });
  });
});

describe('compaction summary on the client wire', () => {
  it('keeps the keys of directive_sources verbatim (they are the directives)', () => {
    const wire = toSnakeCaseDeep<{ summary: { user_directives: string[]; directive_sources: Record<string, string> } }>({
      summary: { userDirectives: ['Always reply in TR'], directiveSources: { 'Always reply in TR': 'Lütfen Türkçe', 'FooBar baz': 'x' } },
    });
    expect(wire.summary.directive_sources).toEqual({ 'Always reply in TR': 'Lütfen Türkçe', 'FooBar baz': 'x' });
  });
});
