/**
 * What the Studio shows about a session's runtime: the one status (header, side
 * panel, drawer), why the last run stopped (and the session-budget stop's own
 * wording), the event log's entries, who may answer an open request, how the
 * turn strip colours paused turns, and that the new strings exist in both
 * languages. (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import PendingActionList from '@/components/agents/session/PendingActionCards';
import SessionSidePanel from '@/components/agents/session/SessionSidePanel';
import SessionStatusBadge from '@/components/agents/session/SessionStatusBadge';
import StopNotice from '@/components/agents/session/StopNotice';
import AgentRunSettingsPanel from '@/components/agents/studio/AgentRunSettingsPanel';
import AgentHumanInTheLoopPanel from '@/components/agents/studio/AgentHumanInTheLoopPanel';
import {
  answerBlockedById,
  answerBlockedReason,
  isAnswerLocked,
  isStaleActionRefusal,
  type PendingActionView,
} from '@/components/agents/session/pendingActions';
import {
  describeSessionEvent,
  mergeEventPage,
  sessionEventsUrl,
  sessionStatusKind,
  stopReasonBadge,
  stopReasonKey,
  waitingFor,
  type SessionLogEvent,
  type SessionStatusKind,
} from '@/components/agents/session/sessionActivityUi';
import { budgetStopAmounts, isBudgetStop } from '@/components/agents/session/sessionBudgetUi';
import { BLOCKED_BEFORE_RUN_ERROR, stepBlockedBeforeRun, stepFailed, type ChatMessage } from '@/components/agents/session/sessionTypes';
import { failedTurnFlags } from '@/components/agents/session/turnTimelineLayout';
import { CONFIG_SECTION_TITLES, configSectionTitle } from '@/components/agents/studio/configSections';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

describe('sessionStatusKind', () => {
  it('lets a live turn win, then an open request, then the stored status', () => {
    expect(sessionStatusKind({ live: true, openActions: 2, runtimeStatus: 'requires_action' })).toBe('running');
    expect(sessionStatusKind({ live: false, openActions: 1 })).toBe('waiting');
    expect(sessionStatusKind({ live: false, openActions: 0, runtimeStatus: 'requires_action' })).toBe('waiting');
    expect(sessionStatusKind({ live: false, openActions: 0, runtimeStatus: 'budget_paused' })).toBe('budget_paused');
    expect(sessionStatusKind({ live: false, openActions: 0, runtimeStatus: 'running' })).toBe('running');
    expect(sessionStatusKind({ live: false, openActions: 0, runtimeStatus: 'idle' })).toBe('idle');
    expect(sessionStatusKind({ live: false, openActions: 0 })).toBe('idle');
  });
});

describe('stopReasonBadge', () => {
  it('names the stops a person should notice and nothing else', () => {
    expect(stopReasonBadge('limit')).toMatchObject({ key: 'stopLimit' });
    expect(stopReasonBadge('budget_reached')).toMatchObject({ key: 'stopBudgetReached' });
    expect(stopReasonBadge('cancelled')).toMatchObject({ key: 'stopCancelled' });
    expect(stopReasonBadge('error')).toMatchObject({ key: 'stopError', color: 'red' });
    for (const quiet of ['end_turn', 'requires_action', undefined, null, 'whatever']) {
      expect(stopReasonBadge(quiet)).toBeNull();
    }
  });
});

describe('the status in the side panel', () => {
  const panel = (status: SessionStatusKind, stopReason?: string) =>
    render(h(SessionSidePanel, {
      agentId: 'a1',
      sessionId: 's1',
      status,
      stopReason,
      activityKey: '0',
      agentName: 'Agent',
      agentKey: 'agent',
      pinnedVersion: '',
      messages: [],
      onGoToTurn: noop,
    }));

  it('says running, waiting for you, budget reached or idle — not just running / idle', () => {
    expect(panel('running')).toContain('Running');
    expect(panel('waiting')).toContain('Waiting for you');
    expect(panel('waiting')).not.toContain('>Idle<');
    expect(panel('budget_paused')).toContain('Budget reached');
    expect(panel('idle')).toContain('>Idle<');
  });

  it('says it waits for an approver when the viewer may not answer what it waits for', () => {
    const html = render(h(SessionSidePanel, {
      agentId: 'a1', sessionId: 's1', status: 'waiting', waitingElsewhere: true, activityKey: '0', agentName: 'Agent', agentKey: 'agent',
      pinnedVersion: '', messages: [], onGoToTurn: noop,
    }));
    expect(html).toContain('Waiting for an approver');
    expect(html).not.toContain('Waiting for you');
  });

  it('adds how the last run ended to a settled session only', () => {
    expect(panel('idle', 'limit')).toContain('stopped by a limit');
    expect(panel('idle', 'end_turn')).not.toContain('stopped by');
    expect(panel('waiting', 'limit')).not.toContain('stopped by a limit');
  });

  it('has an Activity tab', () => {
    expect(panel('idle')).toContain('Activity');
    expect(render(h(SessionSidePanel, {
      agentId: 'a1', sessionId: 's1', status: 'idle', activityKey: '0', agentName: 'Agent', agentKey: 'agent',
      pinnedVersion: '', messages: [], onGoToTurn: noop,
    }), 'tr')).toContain('Etkinlik');
  });
});

describe('SessionStatusBadge', () => {
  it('reads the same in every place that shows it', () => {
    expect(render(h(SessionStatusBadge, { status: 'running' }))).toContain('Running');
    expect(render(h(SessionStatusBadge, { status: 'waiting', size: 'xs' }))).toContain('Waiting for you');
    expect(render(h(SessionStatusBadge, { status: 'budget_paused' }))).toContain('Budget reached');
    expect(render(h(SessionStatusBadge, { status: 'idle' }))).toContain('Idle');
    expect(render(h(SessionStatusBadge, { status: 'waiting' }), 'tr')).toContain('Sizi bekliyor');
  });

  it('says a session waits for an approver - not for the viewer - when the server says the viewer may not answer', () => {
    const html = render(h(SessionStatusBadge, { status: 'waiting', waitingElsewhere: true }));
    expect(html).toContain('Waiting for an approver');
    expect(html).not.toContain('Waiting for you');
    expect(render(h(SessionStatusBadge, { status: 'waiting', waitingElsewhere: true }), 'tr')).toContain('Onaylayıcı bekliyor');
    // only a waiting session is worded this way
    expect(render(h(SessionStatusBadge, { status: 'idle', waitingElsewhere: true }))).toContain('Idle');
  });
});

describe('the session event log', () => {
  const event = (type: string, data: Record<string, unknown> = {}, seq = 1): SessionLogEvent => ({ seq, type, data, created_at: '2026-10-11T10:00:00.000Z' });

  it('words approvals, answers and budget events', () => {
    expect(describeSessionEvent(event('action.required', { kind: 'tool_approval', toolName: 'sandbox_exec' })))
      .toMatchObject({ key: 'evApprovalRequested', values: { name: 'sandbox_exec' }, tone: 'orange' });
    expect(describeSessionEvent(event('action.required', { kind: 'user_question' }))).toMatchObject({ key: 'evQuestionAsked' });
    expect(describeSessionEvent(event('action.resolved', { kind: 'tool_approval', decision: 'allow' }))).toMatchObject({ key: 'evApprovalApproved', tone: 'green' });
    expect(describeSessionEvent(event('action.resolved', { kind: 'tool_approval', decision: 'deny' }))).toMatchObject({ key: 'evApprovalDenied', tone: 'red' });
    expect(describeSessionEvent(event('action.resolved', { kind: 'user_question' }))).toMatchObject({ key: 'evQuestionAnswered' });
    expect(describeSessionEvent(event('action.resolved', { kind: 'user_question', cancelled: true }))).toMatchObject({ key: 'evActionCancelled' });
    expect(describeSessionEvent(event('action.resolved', { kind: 'tool_approval', expired: true }))).toMatchObject({ key: 'evActionExpired' });
    expect(describeSessionEvent(event('budget.reached', { spentUsd: 0.6, maxCostUsd: 0.5 })))
      .toMatchObject({ key: 'evBudgetReached', values: { spent: '$0.60', max: '$0.50' }, tone: 'orange' });
    expect(describeSessionEvent(event('session.usage', { spentUsd: 0.2, budget: { maxCostUsd: 0.5, onReach: 'pause' } })))
      .toMatchObject({ key: 'evSpendOfBudget', values: { spent: '$0.20', max: '$0.50' } });
    expect(describeSessionEvent(event('session.usage', { spentUsd: 0.2 }))).toMatchObject({ key: 'evSpend' });
  });

  it('words tool calls, with an error shown as detail', () => {
    expect(describeSessionEvent(event('agent.tool_use', { name: 'echo' }))).toMatchObject({ key: 'evToolUse', values: { name: 'echo' } });
    expect(describeSessionEvent(event('agent.tool_result', { name: 'echo', ok: true }))).toMatchObject({ key: 'evToolResult' });
    expect(describeSessionEvent(event('agent.tool_result', { name: 'echo', ok: false, error: 'boom' })))
      .toMatchObject({ key: 'evToolFailed', tone: 'red', detail: 'boom' });
  });

  it('says why a run ended, in the words of the stop reason', () => {
    const ended = describeSessionEvent(event('session.status_idle', { stopReason: 'requires_action' }));
    expect(ended).toMatchObject({ key: 'evRunEnded', reasonKey: 'stopRequiresAction' });
    expect(stopReasonKey('limit')).toBe('stopLimit');
    expect(stopReasonKey('nope')).toBeUndefined();
    expect(describeSessionEvent(event('session.status_idle', { stopReason: 'error', detail: 'Provider down' })))
      .toMatchObject({ tone: 'red', detail: 'Provider down' });
  });

  it('excerpts long messages, drops events with nothing to say, and keeps unknown types visible', () => {
    const long = describeSessionEvent(event('user.message', { content: `${'word '.repeat(80)}` }));
    expect(long?.detail?.length).toBeLessThanOrEqual(141);
    expect(long?.detail?.endsWith('…')).toBe(true);
    expect(describeSessionEvent(event('session.work_done'))).toBeNull();
    expect(describeSessionEvent(event('something.new'))).toMatchObject({ key: 'evOther', values: { type: 'something.new' } });
  });

  it('appends a page once per seq, in order', () => {
    const first = [event('a', {}, 1), event('b', {}, 2)];
    const merged = mergeEventPage(first, [event('b', {}, 2), event('c', {}, 3)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(mergeEventPage(merged, [event('c', {}, 3)])).toBe(merged);
  });

  it('asks for the page after a seq', () => {
    expect(sessionEventsUrl('a1', 's1', 0, 50)).toBe('/api/agents/a1/sessions/s1/events?limit=50');
    expect(sessionEventsUrl('a1', 's1', 120, 50)).toBe('/api/agents/a1/sessions/s1/events?limit=50&after=120');
  });
});

describe('a stop on the session budget', () => {
  const stopped = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    role: 'assistant', content: '', stopReason: 'limit', stopDetail: 'session budget reached ($0.0600 of $0.0500)', ...over,
  });

  it('is told from the per-turn limits by its detail', () => {
    expect(isBudgetStop(stopped())).toBe(true);
    expect(isBudgetStop(stopped({ stopDetail: 'maxCostUsd (0.05) exceeded' }))).toBe(false);
    expect(isBudgetStop(stopped({ stopReason: 'paused' }))).toBe(false);
    expect(budgetStopAmounts('session budget reached ($0.0600 of $0.0500)')).toBe('$0.0600 of $0.0500');
    expect(budgetStopAmounts(undefined)).toBeUndefined();
  });

  it('points at the budget banner, not at Configure → Advanced', () => {
    const html = render(h(StopNotice, { message: stopped(), budgetBannerShown: true }));
    expect(html).toContain('Stopped by the session budget');
    expect(html).toContain('$0.0600 of $0.0500');
    expect(html).toContain('banner');
    expect(html).not.toContain('Configure');
    expect(html).not.toContain('Stopped by a run limit');
  });

  it('does not point at a banner that is gone once the budget was raised', () => {
    const html = render(h(StopNotice, { message: stopped(), budgetBannerShown: false }));
    expect(html).toContain('Stopped by the session budget');
    expect(html).not.toContain('banner');
    expect(html).not.toContain('Configure');
  });

  it('a budget that stops the session says a message goes on, not that the turn carries on', () => {
    const html = render(h(StopNotice, { message: stopped(), budgetBannerShown: true, budgetStops: true }));
    expect(html).toContain('then send a message to go on');
    expect(html).not.toContain('to carry on');
    const paused = render(h(StopNotice, { message: stopped(), budgetBannerShown: true, budgetStops: false }));
    expect(paused).toContain('to carry on');
    expect(paused).not.toContain('send a message');
    // ...and in Turkish.
    expect(render(h(StopNotice, { message: stopped(), budgetBannerShown: true, budgetStops: true }), 'tr')).toContain('bir mesaj gönderin');
  });

  it('keeps the per-turn hint for a per-turn limit', () => {
    const html = render(h(StopNotice, { message: stopped({ stopDetail: 'maxWallClockMs (30000ms) exceeded' }), budgetBannerShown: true }));
    expect(html).toContain('Stopped by a run limit');
    expect(html).toContain('maxWallClockMs (30000ms) exceeded');
    expect(html).toContain('Configure → Advanced');
  });

  it('is worded in Turkish too', () => {
    const html = render(h(StopNotice, { message: stopped(), budgetBannerShown: true }), 'tr');
    expect(html).toContain('Oturum bütçesinde durdu');
    expect(html).not.toContain('Stopped by');
  });
});

describe('a request that is no longer open', () => {
  it('is told from the refusals a person can act on: answered elsewhere, cancelled, timed out', () => {
    expect(isStaleActionRefusal(409, { code: 'action_not_pending' })).toBe(true);
    expect(isStaleActionRefusal(409, { type: 'action_not_pending' })).toBe(true);
    expect(isStaleActionRefusal(409, { code: 'action_cancelled', type: 'action_cancelled' })).toBe(true);
    expect(isStaleActionRefusal(410, { code: 'action_expired' })).toBe(true);
    expect(isStaleActionRefusal(410, null)).toBe(true);
  });

  it('is not any other failure', () => {
    expect(isStaleActionRefusal(409, { code: 'conversation_busy' })).toBe(false);
    expect(isStaleActionRefusal(409, undefined)).toBe(false);
    expect(isStaleActionRefusal(403, { code: 'action_cancelled' })).toBe(false);
    expect(isStaleActionRefusal(500, { code: 'action_not_pending' })).toBe(false);
  });

  it('both places that answer requests reload the session on one', () => {
    for (const file of ['agents/session/AgentSessionView.tsx', 'agents/studio/SessionDetailDrawer.tsx']) {
      const source = readFileSync(join(__dirname, '../../components', file), 'utf8');
      expect(source, file).toContain('isStaleActionRefusal(res.status, err)');
      expect(source, file).not.toContain("err.code === 'action_not_pending'");
    }
  });
});

describe('waitingFor (the Sessions list\'s badge and status filter)', () => {
  it('says "you" unless the server says the viewer may not answer - and nothing for a session that waits on nobody', () => {
    expect(waitingFor({ runtimeStatus: 'requires_action' })).toBe('you');
    expect(waitingFor({ runtimeStatus: 'requires_action', canResolve: true })).toBe('you');
    expect(waitingFor({ runtimeStatus: 'requires_action', canResolve: false })).toBe('elsewhere');
    for (const runtimeStatus of ['idle', 'running', 'budget_paused', undefined, null]) {
      expect(waitingFor({ runtimeStatus, canResolve: false }), String(runtimeStatus)).toBeNull();
    }
  });

  it('the list filters by it: "Waiting for you" does not list what only somebody else can answer', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/agents/studio/SessionList.tsx'), 'utf8');
    expect(source).toContain("waitingFor(session) !== (status === 'waiting' ? 'you' : 'elsewhere')");
    expect(source).toContain("value: 'waiting_elsewhere'");
    expect(source).not.toContain("if (session.runtimeStatus !== 'requires_action') return false;");
  });
});

describe('who may answer an open request', () => {
  // The server decides (the policy engine's rule) and says why when the viewer cannot; the page only words it.
  it('says nothing when the server says the viewer may answer every open request, or says nothing at all', () => {
    expect(answerBlockedReason(undefined)).toBeNull();
    expect(answerBlockedReason(null)).toBeNull();
    expect(answerBlockedReason([])).toBeNull();
    expect(answerBlockedReason([{ id: 'a' }, { id: 'b', canResolve: true }])).toBeNull();
  });

  it('names the first reason the server gave for a request the viewer cannot answer', () => {
    expect(answerBlockedReason([{ id: 'a', canResolve: true }, { id: 'b', canResolve: false, resolveBlockedReason: 'approvers_owner' }])).toBe('approvers_owner');
    expect(answerBlockedReason([{ id: 'a', canResolve: false, resolveBlockedReason: 'session_owner' }, { id: 'b', canResolve: false, resolveBlockedReason: 'policy' }])).toBe('session_owner');
    // a refusal without a reason is still a refusal: a rule of the workspace is the honest default
    expect(answerBlockedReason([{ id: 'a', canResolve: false }])).toBe('policy');
  });

  const open: PendingActionView = { id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', args: {}, status: 'pending' };
  const settled: PendingActionView = { ...open, id: 'act_2', status: 'resolved', resolution: { decision: 'allow' } };

  // The opening tag of the first <button> whose label is `label` (Mantine puts `disabled=""` on it when it is).
  const buttonTag = (html: string, label: string): string => {
    const chunk = html.split('<button').slice(1).find((part) => part.includes(`>${label}<`));
    return chunk === undefined ? '' : `<button${chunk.slice(0, chunk.indexOf('>') + 1)}`;
  };
  const disabled = (tag: string) => /\sdisabled(=|\s|>|\/)/.test(tag);
  /** Every <input> of this type (attribute order is the renderer's business). */
  const inputsOf = (html: string, type: string): string[] => (html.match(/<input[^>]*>/g) ?? []).filter((tag) => new RegExp(`type="${type}"`).test(tag));

  it('shows the notice above an open request', () => {
    const html = render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: 'approvers_admin' }));
    expect(html).toContain('Only the session owner, workspace admins and the admins of the project can approve');
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: 'approvers_owner' })))
      .toContain('Only the person who started this session can approve');
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: 'policy' })))
      .toContain('A rule of your workspace stops you');
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: 'session_owner' })))
      .toContain('Only its owner');
  });

  it('disables Approve, Deny, Edit arguments and Don\'t ask again for a viewer the server says may not answer - each with the reason', () => {
    for (const reason of ['approvers_owner', 'approvers_admin', 'approvers_member', 'policy'] as const) {
      const html = render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: reason }));
      for (const label of ['Approve', 'Deny', 'Edit arguments']) {
        const tag = buttonTag(html, label);
        expect(tag, `${label} / ${reason}`).not.toBe('');
        expect(disabled(tag), `${label} / ${reason}`).toBe(true);
        // the reason rides on the control itself, not only in the notice above
        expect(tag, `${label} / ${reason}`).toMatch(/title="[^"]{20,}"/);
      }
      const boxes = inputsOf(html, 'checkbox');
      expect(boxes).toHaveLength(1);
      expect(disabled(boxes[0])).toBe(true);
      expect(html).toContain('data-locked="true"');
    }
  });

  it('keeps every control usable for a viewer who may answer', () => {
    for (const blocked of [null, undefined]) {
      const html = render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked }));
      for (const label of ['Approve', 'Deny', 'Edit arguments']) expect(disabled(buttonTag(html, label)), label).toBe(false);
      expect(html).not.toContain('data-locked');
    }
  });

  it('does not lock on "unavailable": the server could not check, which is no "no" - the notice is shown and the server decides on send', () => {
    const html = render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: 'unavailable' }));
    expect(html).toContain('answer-blocked');
    expect(disabled(buttonTag(html, 'Approve'))).toBe(false);
    expect(disabled(buttonTag(html, 'Deny'))).toBe(false);
    expect(html).not.toContain('data-locked');
    expect(isAnswerLocked('unavailable')).toBe(false);
    expect(isAnswerLocked(null)).toBe(false);
    expect(isAnswerLocked('policy')).toBe(true);
  });

  it('locks a question the same way: Send, Skip and the inputs', () => {
    const question: PendingActionView = {
      id: 'q_1', kind: 'user_question', status: 'pending',
      questions: [{ question: 'Which environment?', options: [{ label: 'Staging' }, { label: 'Prod' }] }],
    };
    const html = render(h(PendingActionList, { actions: [question], busy: false, onResolve: noop, blocked: 'session_owner' }));
    expect(disabled(buttonTag(html, 'Send'))).toBe(true);
    expect(disabled(buttonTag(html, 'Skip'))).toBe(true);
    expect(buttonTag(html, 'Send')).toMatch(/title="[^"]{10,}"/);
    // every option and the free-text box
    expect(inputsOf(html, 'radio').every((tag) => disabled(tag))).toBe(true);
    expect(inputsOf(html, 'radio')).toHaveLength(2);
    const typed = (page: string) => (page.match(/<input[^>]*>/g) ?? []).filter((tag) => tag.includes('aria-label="Which environment?"'));
    expect(typed(html).map(disabled)).toEqual([true]);
    // the same question, answerable: nothing is disabled but Send (nothing picked yet)
    const open2 = render(h(PendingActionList, { actions: [question], busy: false, onResolve: noop, blocked: null }));
    expect(disabled(buttonTag(open2, 'Skip'))).toBe(false);
    expect(inputsOf(open2, 'radio').some(disabled)).toBe(false);
    expect(typed(open2).map(disabled)).toEqual([false]);
  });

  it('locks only the requests the viewer may not answer when the verdict is given per request', () => {
    const question: PendingActionView = { id: 'q_2', kind: 'user_question', status: 'pending', questions: [{ question: 'Which?', options: [{ label: 'A' }] }] };
    const approval: PendingActionView = { ...open, id: 'act_9' };
    const blockedById = answerBlockedById([
      { id: 'act_9', canResolve: false, resolveBlockedReason: 'approvers_admin' },
      { id: 'q_2', canResolve: true },
    ]);
    expect(blockedById).toEqual({ act_9: 'approvers_admin' });
    const html = render(h(PendingActionList, { actions: [approval, question], busy: false, onResolve: noop, blocked: 'approvers_admin', blockedById }));
    expect(disabled(buttonTag(html, 'Approve'))).toBe(true);
    expect(disabled(buttonTag(html, 'Skip'))).toBe(false);
    expect(html.match(/data-locked="true"/g)).toHaveLength(1);
  });

  it('the composer words its waiting for an approver in the badge\'s words, not "your response"', () => {
    for (const messages of [en, tr]) {
      const access = (messages as unknown as { agents: { sessionAccess: Record<string, string> } }).agents.sessionAccess;
      expect(access.composerWaitingElsewhere).toBe(access.waitingElsewhereBadge);
      expect(access.composerWaitingElsewhereNote.length).toBeGreaterThan(20);
    }
    expect(en.agents.sessionAccess.composerWaitingElsewhere).toBe('Waiting for an approver');
    expect(en.agents.sessionAccess.composerWaitingElsewhereNote).not.toMatch(/your response/i);
  });

  it('words the reason on the controls in Turkish too', () => {
    const html = render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: 'approvers_owner' }), 'tr');
    expect(buttonTag(html, 'Onayla')).toMatch(/title="Yalnızca bu oturumu başlatan kişi onaylayabilir/);
    expect(disabled(buttonTag(html, 'Onayla'))).toBe(true);
  });

  it('shows nothing extra without a reason, or when nothing is open', () => {
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: null }))).not.toContain('answer-blocked');
    expect(render(h(PendingActionList, { actions: [settled], busy: false, onResolve: noop, blocked: 'approvers_owner' }))).not.toContain('answer-blocked');
  });

  it('is worded in Turkish', () => {
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, blocked: 'approvers_owner' }), 'tr'))
      .toContain('Yalnızca bu oturumu başlatan kişi onaylayabilir');
  });
});

describe('the turn strip', () => {
  const turn = (over: Partial<ChatMessage>): ChatMessage => ({ role: 'assistant', content: 'x', ...over });

  it('does not draw a turn that paused for a person, or was cancelled, as a failure', () => {
    expect(failedTurnFlags([turn({ stopReason: 'paused' }), turn({ stopReason: 'cancelled' })])).toEqual([false, false]);
  });

  it('still draws a failure, a limit and a failed tool call', () => {
    expect(failedTurnFlags([
      { role: 'error', content: 'boom' },
      turn({ stopReason: 'limit' }),
      turn({ steps: [{ name: 'echo', status: 'error' }] }),
      turn({}),
    ])).toEqual([true, true, true, false]);
  });

  it('does not draw a call the person denied as a failure, but still a guardrail block', () => {
    const denied: PendingActionView = { id: 'a', kind: 'tool_approval', toolName: 'echo_note', status: 'resolved', resolution: { decision: 'deny' } };
    const rejected = turn({ steps: [{ name: 'echo_note', status: 'rejected' }] });
    expect(failedTurnFlags([turn({ stopReason: 'paused', pendingActions: [denied] }), rejected])).toEqual([false, false]);
    // No denial before it: the same rejected step is a block by a guardrail.
    expect(failedTurnFlags([rejected])).toEqual([true]);
    // A denial of another tool does not excuse it.
    expect(failedTurnFlags([turn({ stopReason: 'paused', pendingActions: [{ ...denied, toolName: 'other' }] }), rejected])).toEqual([false, true]);
  });

  it('reads a denied call the way turns stored before `rejected` existed wrote it: an error saying it was blocked before it ran', () => {
    const denied: PendingActionView = { id: 'a', kind: 'tool_approval', toolName: 'echo_note', status: 'resolved', resolution: { decision: 'deny' } };
    const paused = turn({ stopReason: 'paused', pendingActions: [denied] });
    const old = turn({ steps: [{ name: 'echo_note', status: 'error', error: BLOCKED_BEFORE_RUN_ERROR }] });
    expect(stepBlockedBeforeRun(old.steps![0])).toBe(true);
    expect(stepBlockedBeforeRun({ name: 'x', status: 'rejected' })).toBe(true);
    expect(failedTurnFlags([paused, old])).toEqual([false, false]);
    // The same text with no denial before it is still a block by something other than the person.
    expect(failedTurnFlags([old])).toEqual([true]);
    // A call that really failed, whatever it is called, is never excused by a denial of the same tool.
    const crashed = turn({ steps: [{ name: 'echo_note', status: 'error', error: 'connect ECONNREFUSED' }] });
    expect(stepBlockedBeforeRun(crashed.steps![0])).toBe(false);
    expect(failedTurnFlags([paused, crashed])).toEqual([false, true]);
  });

  it('does not draw a call flagged as denied by the person as a failure, with or without the pause before it', () => {
    const flagged = turn({ steps: [{ name: 'echo_note', status: 'rejected', deniedByUser: true }] });
    expect(failedTurnFlags([flagged])).toEqual([false]);
    expect(stepFailed(flagged.steps![0])).toBe(false);
    expect(stepFailed({ name: 'echo_note', status: 'rejected' })).toBe(true);
  });

  it('keeps a turn paused for a person, or cancelled, out of the failures even when its calls were stopped', () => {
    const paused = turn({ stopReason: 'paused', steps: [{ name: 'a', status: 'success' }] });
    expect(failedTurnFlags([paused, turn({ stopReason: 'cancelled', steps: [{ name: 'b', status: 'success' }] })])).toEqual([false, false]);
  });
});

describe('the session page’s own labels', () => {
  const tpKeys = ['compare', 'continue', 'delete', 'tabSession', 'tabEvents', 'tabTools', 'tabContext', 'enterToSend', 'contextOverride', 'contextOverrideHint'] as const;

  it('are in both languages, translated', () => {
    for (const key of tpKeys) {
      expect(en.agents.sessionPage[key], key).toBeTruthy();
      expect(tr.agents.sessionPage[key], key).toBeTruthy();
      expect(tr.agents.sessionPage[key], key).not.toBe(en.agents.sessionPage[key]);
    }
    expect(Object.keys(tr.agents.sessionPage).sort()).toEqual(Object.keys(en.agents.sessionPage).sort());
  });

  it('are what the session page draws, not English written into the markup', () => {
    const source = readFileSync(join(__dirname, '../../components/agents/session/AgentSessionView.tsx'), 'utf8');
    for (const key of ['compare', 'continue', 'delete', 'enterToSend', 'contextOverride', 'contextOverrideHint']) {
      expect(source, key).toContain(`tp('${key}')`);
    }
    for (const literal of ['>Compare<', 'Enter to send', '>Context override<', 'Applies to the next message only']) {
      expect(source, literal).not.toContain(literal);
    }
    expect(source).not.toMatch(/^\s+(?:Compare|Continue|Delete)\s*$/m);
  });

  it('turn the side panel’s tabs Turkish: Oturum, Olaylar, Araçlar, Bağlam', () => {
    const html = render(h(SessionSidePanel, {
      agentId: 'a1', sessionId: 's1', status: 'idle', activityKey: '0', agentName: 'Agent', agentKey: 'agent',
      pinnedVersion: '', messages: [], onGoToTurn: noop,
    }), 'tr');
    for (const label of ['Oturum', 'Olaylar', 'Araçlar', 'Bağlam']) expect(html).toContain(label);
    expect(html).not.toContain('>Events<');
    const english = render(h(SessionSidePanel, {
      agentId: 'a1', sessionId: 's1', status: 'idle', activityKey: '0', agentName: 'Agent', agentKey: 'agent',
      pinnedVersion: '', messages: [], onGoToTurn: noop,
    }));
    expect(english).toContain('Events');
  });
});

describe('Configure → Approvals & questions', () => {
  const translate = (language: typeof en | typeof tr) => (key: string) =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], language.agents) as string;

  it('has its heading in both languages, the others unchanged', () => {
    expect(CONFIG_SECTION_TITLES.hitl).toBe('Approvals & questions');
    expect(configSectionTitle('hitl', translate(en))).toBe('Approvals & questions');
    expect(configSectionTitle('hitl', translate(tr))).toBe('Onaylar ve sorular');
    expect(configSectionTitle('prompt', translate(tr))).toBe('Prompt');
    expect(configSectionTitle('unknown', translate(en))).toBe('unknown');
  });

  it('keeps the Approval column wide enough for the Ask / Never ask control', () => {
    const html = render(h(AgentHumanInTheLoopPanel, {
      value: { toolApproval: { enabled: true } }, onChange: noop, toolConfig: { sandbox: { enabled: true } },
    }));
    const approval = /<th style="width:calc\(([\d.]+)rem[^"]*"[^>]*>Approval<\/th>/.exec(html);
    expect(approval).not.toBeNull();
    expect(Number(approval![1]) * 16).toBeGreaterThanOrEqual(260);
    expect(html).toMatch(/mantine-SegmentedControl-root/);
  });
});

describe('Configure → Callback & budget, in Turkish', () => {
  const panel = (locale: 'en' | 'tr') => render(h(AgentRunSettingsPanel, {
    callback: { url: 'https://hooks.example.com/x' }, onCallbackChange: noop,
    budget: { maxCostUsd: 5, onReach: 'pause' }, onBudgetChange: noop,
  }), locale);

  it('translates the Session budget block, and no longer carries the file settings', () => {
    const html = panel('tr');
    for (const text of ['Oturum bütçesi', 'Oturum başına bütçe (USD)', 'Duraklat ve bekle', 'Bütçeye ulaşıldığında']) {
      expect(html).toContain(text);
    }
    for (const text of ['Varsayılan geri çağrı', 'Geri çağrı URL’si', 'İmzalama anahtarı']) {
      expect(html).toContain(text);
    }
    for (const text of ['Session budget', 'Budget per session', 'Default callback', 'Signing secret']) {
      expect(html).not.toContain(text);
    }
    // The file settings moved to their own Configure section (agent-files-ui.test.ts).
    for (const text of ['Ekler', 'Eklenen dosyaları kabul et', 'Oturum başına dosya sayısı', 'Accept attached files']) {
      expect(html).not.toContain(text);
    }
  });
});

describe('strings of the session runtime', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const pairs: Array<[string, Record<string, string>, Record<string, string>]> = [
    ['activity', en.agents.activity, tr.agents.activity],
    ['stopNotice', en.agents.stopNotice, tr.agents.stopNotice],
    ['hitl', en.agents.hitl, tr.agents.hitl],
    ['budget', en.agents.budget, tr.agents.budget],
    ['attachments', en.agents.attachments, tr.agents.attachments],
  ];

  it.each(pairs)('%s has the same keys and placeholders in English and Turkish, none empty', (_name, english, turkish) => {
    expect(Object.keys(turkish).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english)) {
      expect(turkish[key].trim(), key).not.toBe('');
      expect(placeholders(turkish[key]), key).toEqual(placeholders(english[key]));
    }
  });

  it('translates the new strings rather than copying the English', () => {
    const newKeys: Record<string, (key: string) => boolean> = {
      // `evOther` is just the event type.
      activity: (key) => key !== 'evOther',
      stopNotice: () => true,
      hitl: (key) => ['sectionTitle', 'blockedApproversOwner', 'blockedApproversAdmin', 'blockedApproversMember', 'blockedSessionOwner', 'blockedPolicy', 'blockedUnavailable'].includes(key),
      budget: (key) => key.startsWith('cfg') || key === 'failedHint',
      attachments: (key) => key.startsWith('cfg'),
    };
    for (const [name, english, turkish] of pairs) {
      const keys = Object.keys(english).filter(newKeys[name]);
      expect(keys.length, name).toBeGreaterThan(0);
      for (const key of keys) expect(turkish[key], `${name}.${key}`).not.toBe(english[key]);
    }
  });

  it('defines every key the event log and the stop badges can ask for', () => {
    const activity = en.agents.activity as Record<string, string>;
    const types = ['user.message', 'session.status_running', 'agent.tool_use', 'agent.tool_result', 'agent.compaction', 'action.required',
      'action.resolved', 'agent.message', 'session.usage', 'budget.reached', 'session.status_idle', 'session.error', 'whatever'];
    const datas: Array<Record<string, unknown>> = [
      {}, { kind: 'user_question' }, { kind: 'tool_approval', decision: 'deny' }, { cancelled: true }, { expired: true },
      { ok: false }, { budget: { maxCostUsd: 1 } }, { stopReason: 'error' },
    ];
    for (const type of types) {
      for (const data of datas) {
        const view = describeSessionEvent({ seq: 1, type, data });
        if (!view) continue;
        expect(activity[view.key], `${type} ${JSON.stringify(data)}`).toBeTruthy();
        if (view.reasonKey) expect(activity[view.reasonKey]).toBeTruthy();
      }
    }
    for (const reason of ['limit', 'budget_reached', 'cancelled', 'error']) {
      expect(activity[stopReasonBadge(reason)!.key]).toBeTruthy();
    }
  });
});

describe('keys the components ask for', () => {
  const lookup = (language: typeof en | typeof tr, key: string) =>
    key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], language);

  it('exist in English and Turkish, in every component of the session runtime UI', () => {
    const files = [
      'components/agents/session/AgentSessionView.tsx',
      'components/agents/session/PendingActionCards.tsx',
      'components/agents/session/SessionActivity.tsx',
      'components/agents/session/SessionSidePanel.tsx',
      'components/agents/session/SessionStatusBadge.tsx',
      'components/agents/session/StopNotice.tsx',
      'components/agents/studio/AgentRunSettingsPanel.tsx',
      'components/agents/studio/AgentFilesPanel.tsx',
      'components/agents/session/SessionFilesPanel.tsx',
      'components/agents/session/SessionAttachments.tsx',
      'components/agents/studio/SessionDetailDrawer.tsx',
    ];
    const missing: string[] = [];
    let checked = 0;
    for (const file of files) {
      const source = readFileSync(join(__dirname, '../..', file), 'utf8');
      const namespaces: Record<string, string> = {};
      for (const match of source.matchAll(/const\s+(\w+)\s*=\s*useTranslations\('([\w.]+)'\)/g)) namespaces[match[1]] = match[2];
      for (const match of source.matchAll(/\b(\w+)\(\s*'([\w.]+)'/g)) {
        const namespace = namespaces[match[1]];
        if (!namespace) continue;
        const key = `${namespace}.${match[2]}`;
        checked += 1;
        for (const [name, language] of [['en', en], ['tr', tr]] as const) {
          if (typeof lookup(language, key) !== 'string') missing.push(`${file}: ${key} (${name})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect(missing).toEqual([]);
  });
});
