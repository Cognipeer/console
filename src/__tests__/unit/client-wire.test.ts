import { describe, expect, it } from 'vitest';
import {
  normalizeClientResolveBody,
  toClientErrorBody,
  toClientEventData,
  toClientEventFrame,
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
