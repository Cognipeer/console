import { describe, expect, it } from 'vitest';

import { collectPauseEntries, toMessagePendingAction, toPublicPendingAction } from '@/lib/services/agents/agentPendingActions';
import { toClientPendingAction } from '@/lib/services/agents/clientWire';

const tag = { __subagent: { parentToolCallId: 'd1', name: 'researcher' } };

describe('a pause that came from a sub-agent', () => {
  it('names the sub-agent on the approval and on the question the SDK surfaced', () => {
    const entries = collectPauseEntries({
      pendingApprovals: [
        { id: 'a1', status: 'pending', toolCallId: 'c1', toolName: 'crm_lookup', args: {}, metadata: tag },
        { id: 'a2', status: 'pending', toolCallId: 'c2', toolName: 'own_tool', args: {} },
      ],
      pendingUserQuestions: [{ id: 'q1', status: 'pending', toolCallId: 'c3', toolName: 'ask_user_question', questions: [], metadata: tag }],
    } as never);
    expect(entries.map((e) => e.subagent)).toEqual(['researcher', undefined, 'researcher']);
    expect(entries.map((e) => e.delegationToolCallId)).toEqual(['d1', undefined, 'd1']);
  });

  it('carries the name to every shape a client reads', () => {
    const action = {
      _id: 'act_1', kind: 'tool_approval', toolName: 'crm_lookup', subagent: 'researcher', status: 'pending', requestedAt: new Date(),
    } as never;
    expect(toPublicPendingAction(action).subagent).toBe('researcher');
    expect(toMessagePendingAction(action).subagent).toBe('researcher');
    const delegating = { ...(action as object), delegationToolCallId: 'd1' } as never;
    expect(toPublicPendingAction(delegating).delegationToolCallId).toBe('d1');
    expect(toMessagePendingAction(delegating).delegationToolCallId).toBe('d1');
    expect('delegationToolCallId' in toPublicPendingAction(action)).toBe(false);
    expect(toClientPendingAction(toPublicPendingAction(action)).subagent).toBe('researcher');
  });

  it('adds nothing for the agent\'s own pause', () => {
    const action = { _id: 'act_1', kind: 'tool_approval', toolName: 'x', status: 'pending', requestedAt: new Date() } as never;
    expect('subagent' in toPublicPendingAction(action)).toBe(false);
    expect('subagent' in toClientPendingAction(toPublicPendingAction(action))).toBe(false);
  });
});
