/**
 * The client API's event vocabulary does not grow with the session view's plan,
 * sub-agent groups and positioned summaries: those are dashboard and portal
 * features. What a client reads (event rows, transcript messages, webhooks) keeps
 * the shape it was documented with.
 */

import { describe, expect, it } from 'vitest';

import {
  isClientSessionEvent,
  toClientEventData,
  toClientEventFrame,
  toClientTranscriptMessage,
} from '@/lib/services/agents/clientWire';
import { sessionWebhookEvents } from '@/lib/services/webhooks/sessionWebhookEvents';

describe('which log rows a client sees', () => {
  it('hides the plan and sub-agent rows, and a sub-agent\'s own summarization pass', () => {
    expect(isClientSessionEvent('agent.plan', { version: 1 })).toBe(false);
    expect(isClientSessionEvent('agent.subagent', { phase: 'start' })).toBe(false);
    expect(isClientSessionEvent('agent.compaction', { at: 't', subagent: { name: 'helper' } })).toBe(false);
  });

  it('keeps every row that existed before, including the agent\'s own pass', () => {
    for (const type of ['user.message', 'agent.tool_use', 'agent.tool_result', 'agent.message', 'session.status_idle', 'action.required']) {
      expect(isClientSessionEvent(type, {})).toBe(true);
    }
    expect(isClientSessionEvent('agent.compaction', { at: 't', index: 1, afterToolCallId: null })).toBe(true);
    expect(isClientSessionEvent('agent.compaction', undefined)).toBe(true);
  });
});

describe('the data of a row for a client', () => {
  it('drops what only the session view reads, by type, and snake_cases the rest as before', () => {
    expect(toClientEventData(
      { toolCallId: 'c1', name: 'x', subagent: 'helper', subagentId: 'sa_1', parentToolCallId: 'd1', parallel: true },
      'agent.tool_use',
    )).toEqual({ tool_call_id: 'c1', name: 'x', subagent: 'helper' });
    expect(toClientEventData(
      { at: 't', messagesCompressed: 3, id: 'p', index: 1, afterToolCallId: 'a', trigger: 'pre_leg', compactedTools: [] },
      'agent.compaction',
    )).toEqual({ at: 't', messages_compressed: 3 });
  });

  it('without a type behaves as it did, and a type with nothing to hide changes nothing', () => {
    expect(toClientEventData({ toolCallId: 'c1', parentToolCallId: 'd1' })).toEqual({ tool_call_id: 'c1', parent_tool_call_id: 'd1' });
    expect(toClientEventData({ stopReason: 'end_turn' }, 'session.status_idle')).toEqual({ stop_reason: 'end_turn' });
  });

  it('a stream frame is cleaned by the type it carries', () => {
    const frame = toClientEventFrame({
      seq: 4, type: 'agent.tool_result', data: { toolCallId: 'c1', ok: true, subagentId: 'sa_1', parentToolCallId: 'd1' },
      runId: 'abc', createdAt: '2026-10-23T10:00:00.000Z',
    });
    expect(frame).toEqual({
      seq: 4, type: 'agent.tool_result', data: { tool_call_id: 'c1', ok: true }, run_id: 'run_abc', created_at: '2026-10-23T10:00:00.000Z',
    });
  });
});

describe('what else a client reads', () => {
  it('a transcript message carries none of the plan or sub-agent records', () => {
    const message = {
      role: 'assistant',
      content: 'done',
      timestamp: new Date('2026-10-23T10:00:00Z'),
      plans: [{ version: 1, operation: 'write', steps: [{ id: 1, title: 'x', status: 'completed' }], at: 'now' }],
      subagentRuns: [{ id: 'sa_1', name: 'helper', phase: 'result', steps: [{ name: 'lookup', status: 'success' }] }],
      subagentRunsDropped: 2,
      compactions: [{ at: 'now', id: 'pass-1', index: 1, afterToolCallId: null }],
    };
    const wire = toClientTranscriptMessage('conv-1', 1, message, 'msg_1');
    expect(JSON.stringify(wire)).not.toMatch(/plans|subagent|compaction|steps|afterToolCallId/);
    expect(wire).toMatchObject({ id: 'msg_1', role: 'assistant', content: 'done', index: 1 });
  });

  it('no webhook event is made from a plan, sub-agent or summarization row', () => {
    const rows = [
      { type: 'agent.plan', data: { version: 1 } },
      { type: 'agent.subagent', data: { phase: 'start' } },
      { type: 'agent.compaction', data: { at: 't' } },
    ];
    expect(sessionWebhookEvents(rows, { agentKey: 'a', conversationId: 'c' })).toEqual([]);
  });
});
