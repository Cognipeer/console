/**
 * The pure half of the approval / question cards and of following a turn from
 * the event log: what is sent to the resolve endpoint, what is refused before
 * it is sent, how the transcript reflects an answer, and what the composer does
 * while the session waits.
 */

import { describe, expect, it } from 'vitest';
import {
  applyLocalResolution,
  argsDiffer,
  answerText,
  buildAnswers,
  buildApprovalBody,
  cancelOpenActions,
  composerGate,
  emptyDraft,
  openActionsOf,
  parseEditedArgs,
  pickOption,
  resolvedKind,
  typeAnswer,
  type PendingActionView,
} from '@/components/agents/session/pendingActions';
import { interpretSessionEvent } from '@/components/agents/session/sessionFollow';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import type { IAgentUserQuestion } from '@/lib/database/provider/types.domain';

const approval = (over: Partial<PendingActionView> = {}): PendingActionView => ({
  id: 'act_1',
  kind: 'tool_approval',
  toolName: 'sandbox_exec',
  args: { command: 'ls', cwd: '/work' },
  status: 'pending',
  ...over,
});

const question = (over: Partial<PendingActionView> = {}): PendingActionView => ({
  id: 'act_2',
  kind: 'user_question',
  questions: [{ question: 'Which env?', options: [{ label: 'Staging' }, { label: 'Prod', value: 'production' }] }],
  status: 'pending',
  ...over,
});

const paused = (...actions: PendingActionView[]): ChatMessage[] => [
  { role: 'user', content: 'deploy' },
  { role: 'assistant', content: '', stopReason: 'paused', pendingActions: actions },
];

describe('open actions in the transcript', () => {
  it('lists only the actions still waiting', () => {
    const messages = paused(approval(), question({ status: 'resolved' }));
    expect(openActionsOf(messages).map((a) => a.id)).toEqual(['act_1']);
  });

  it('marks one action answered without touching its neighbours or other messages', () => {
    const messages = paused(approval(), question());
    const next = applyLocalResolution(messages, 'act_1', { decision: 'allow', rememberForSession: true });
    expect(next[0]).toBe(messages[0]);
    const [a, q] = next[1].pendingActions!;
    expect(a).toMatchObject({ status: 'resolved', resolution: { decision: 'allow', rememberForSession: true } });
    expect(q.status).toBe('pending');
  });

  it('cancels every open action and leaves settled ones alone', () => {
    const messages = paused(approval(), question({ status: 'resolved', resolution: { answers: { 'Which env?': 'Staging' } } }));
    const next = cancelOpenActions(messages);
    expect(next[1].pendingActions!.map((a) => a.status)).toEqual(['cancelled', 'resolved']);
  });
});

describe('resolvedKind', () => {
  it('is null while pending', () => {
    expect(resolvedKind(approval())).toBeNull();
  });

  it.each([
    [approval({ status: 'resolved', resolution: { decision: 'allow' } }), 'approved'],
    [approval({ status: 'resolved', resolution: { decision: 'allow', approvedArgs: { command: 'pwd' } } }), 'approved_edited'],
    [approval({ status: 'resolved', resolution: { decision: 'deny', comment: 'no' } }), 'denied'],
    [question({ status: 'resolved', resolution: { answers: { q: 'a' } } }), 'answered'],
    [question({ status: 'resolved', resolution: { cancelled: true } }), 'skipped'],
    [approval({ status: 'expired' }), 'expired'],
    [question({ status: 'cancelled' }), 'cancelled'],
  ])('reads %#', (action, kind) => {
    expect(resolvedKind(action)).toBe(kind);
  });
});

describe('edited arguments', () => {
  it('accepts a JSON object and nothing else', () => {
    expect(parseEditedArgs('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseEditedArgs('{nope')).toEqual({ ok: false, error: 'invalid_json' });
    expect(parseEditedArgs('[1,2]')).toEqual({ ok: false, error: 'not_object' });
    expect(parseEditedArgs('"text"')).toEqual({ ok: false, error: 'not_object' });
    expect(parseEditedArgs('null')).toEqual({ ok: false, error: 'not_object' });
  });

  it('does not count key order as a change', () => {
    expect(argsDiffer({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(false);
    expect(argsDiffer({ a: 1 }, { a: 2 })).toBe(true);
    expect(argsDiffer(undefined, {})).toBe(false);
  });
});

describe('buildApprovalBody', () => {
  it('sends a plain approval as just the decision', () => {
    expect(buildApprovalBody({ decision: 'allow', original: { a: 1 } })).toEqual({ decision: 'allow' });
  });

  it('sends approvedArgs only when they changed', () => {
    expect(buildApprovalBody({ decision: 'allow', original: { a: 1 }, edited: { a: 1 } })).toEqual({ decision: 'allow' });
    expect(buildApprovalBody({ decision: 'allow', original: { a: 1 }, edited: { a: 2 } }))
      .toEqual({ decision: 'allow', approvedArgs: { a: 2 } });
  });

  it('carries the reason, and the standing permission only on an allow', () => {
    expect(buildApprovalBody({ decision: 'deny', original: {}, comment: '  too risky ', remember: true, edited: { a: 9 } }))
      .toEqual({ decision: 'deny', comment: 'too risky' });
    expect(buildApprovalBody({ decision: 'allow', original: {}, remember: true }))
      .toEqual({ decision: 'allow', rememberForSession: true });
  });
});

describe('answering questions', () => {
  const single: IAgentUserQuestion = {
    question: 'Which env?',
    options: [{ label: 'Staging' }, { label: 'Prod', value: 'production' }],
  };
  const multi: IAgentUserQuestion = {
    question: 'Which checks?',
    multiSelect: true,
    required: false,
    options: [{ label: 'Lint' }, { label: 'Tests' }],
  };

  it('sends an option by its value, falling back to its label', () => {
    let draft = emptyDraft([single]);
    draft = pickOption(draft, 0, single, 'production');
    expect(buildAnswers([single], draft)).toEqual({ ok: true, answers: { 'Which env?': 'production' } });
    draft = pickOption(draft, 0, single, 'Staging');
    expect(buildAnswers([single], draft)).toEqual({ ok: true, answers: { 'Which env?': 'Staging' } });
  });

  it('reports a required question left empty by index instead of sending', () => {
    expect(buildAnswers([single, multi], emptyDraft([single, multi]))).toEqual({ ok: false, missing: [0] });
  });

  it('treats a question as required unless it says otherwise', () => {
    const optional = { ...single, required: false };
    expect(buildAnswers([optional], emptyDraft([optional]))).toEqual({ ok: true, answers: {} });
  });

  it('lets typed text replace the picked option in a single-select, and the other way round', () => {
    let draft = pickOption(emptyDraft([single]), 0, single, 'Staging');
    draft = typeAnswer(draft, 0, single, 'my own');
    expect(buildAnswers([single], draft)).toEqual({ ok: true, answers: { 'Which env?': 'my own' } });
    draft = pickOption(draft, 0, single, 'Staging');
    expect(buildAnswers([single], draft)).toEqual({ ok: true, answers: { 'Which env?': 'Staging' } });
  });

  it('toggles options in a multi-select and appends typed text', () => {
    let draft = emptyDraft([multi]);
    draft = pickOption(draft, 0, multi, 'Lint');
    draft = pickOption(draft, 0, multi, 'Tests');
    draft = pickOption(draft, 0, multi, 'Lint');
    draft = typeAnswer(draft, 0, multi, ' e2e ');
    expect(buildAnswers([multi], draft)).toEqual({ ok: true, answers: { 'Which checks?': ['Tests', 'e2e'] } });
  });

  it('shows an answer as one line', () => {
    expect(answerText(['a', 'b'])).toBe('a, b');
    expect(answerText('a')).toBe('a');
    expect(answerText(undefined)).toBe('');
  });
});

describe('composerGate', () => {
  it('is open when nothing waits, whatever the policy', () => {
    expect(composerGate(0, 'reject')).toBe('open');
    expect(composerGate(0, 'cancel_pending')).toBe('open');
  });

  it('blocks under reject (the default) and warns under cancel_pending', () => {
    expect(composerGate(1, undefined)).toBe('blocked');
    expect(composerGate(2, 'reject')).toBe('blocked');
    expect(composerGate(1, 'cancel_pending')).toBe('cancel');
  });
});

describe('interpretSessionEvent', () => {
  const frame = (type: string, data: Record<string, unknown>) => ({ seq: 1, type, data });

  it('turns tool events into the live view updates', () => {
    expect(interpretSessionEvent('agent.tool_use', frame('agent.tool_use', { toolCallId: 'c1', name: 'search', args: { q: 'x' } })))
      .toEqual({ kind: 'tool', event: { phase: 'start', name: 'search', id: 'c1', args: { q: 'x' } } });
    expect(interpretSessionEvent('agent.tool_result', frame('agent.tool_result', { toolCallId: 'c1', name: 'search', ok: true, durationMs: 12 })))
      .toEqual({ kind: 'tool', event: { phase: 'success', name: 'search', id: 'c1', durationMs: 12 } });
    expect(interpretSessionEvent('agent.tool_result', frame('agent.tool_result', { name: 'search', ok: false, error: 'boom' })))
      .toEqual({ kind: 'tool', event: { phase: 'error', name: 'search', error: 'boom' } });
  });

  it('reads text, the user message and the end of the turn', () => {
    expect(interpretSessionEvent('agent.message.delta', frame('agent.message.delta', { text: 'hi' }))).toEqual({ kind: 'text', text: 'hi' });
    expect(interpretSessionEvent('user.message', frame('user.message', { content: 'go' }))).toEqual({ kind: 'user', content: 'go' });
    expect(interpretSessionEvent('session.status_idle', frame('session.status_idle', { stopReason: 'requires_action' })))
      .toEqual({ kind: 'idle', stopReason: 'requires_action' });
    expect(interpretSessionEvent('session.error', frame('session.error', { message: 'bad' }))).toEqual({ kind: 'error', message: 'bad' });
  });

  it('ignores events it does not render and malformed frames', () => {
    expect(interpretSessionEvent('action.required', frame('action.required', {}))).toEqual({ kind: 'ignore' });
    expect(interpretSessionEvent('agent.tool_use', 'not a frame')).toEqual({ kind: 'ignore' });
    expect(interpretSessionEvent('agent.message.delta', null)).toEqual({ kind: 'ignore' });
  });
});
