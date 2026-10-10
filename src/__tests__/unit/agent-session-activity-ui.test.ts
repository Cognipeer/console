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
import AgentExecutionPanel from '@/components/agents/studio/AgentExecutionPanel';
import AgentHumanInTheLoopPanel from '@/components/agents/studio/AgentHumanInTheLoopPanel';
import {
  answerRestriction,
  type PendingActionView,
} from '@/components/agents/session/pendingActions';
import {
  describeSessionEvent,
  mergeEventPage,
  sessionEventsUrl,
  sessionStatusKind,
  stopReasonBadge,
  stopReasonKey,
  type SessionLogEvent,
  type SessionStatusKind,
} from '@/components/agents/session/sessionActivityUi';
import { budgetStopAmounts, isBudgetStop } from '@/components/agents/session/sessionBudgetUi';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
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

describe('who may answer an open request', () => {
  it('says nothing when the viewer is clearly allowed, or when the page cannot tell', () => {
    expect(answerRestriction({ approvers: 'project_members', viewerId: 'u2', viewerRole: 'user', ownerId: 'u1' })).toBeNull();
    expect(answerRestriction({ approvers: 'owner', viewerId: 'u1', viewerRole: 'user', ownerId: 'u1' })).toBeNull();
    expect(answerRestriction({ viewerId: 'u1', viewerRole: 'user', ownerId: 'u1' })).toBeNull();
    expect(answerRestriction({ approvers: 'owner_or_admin', viewerId: 'u2', viewerRole: 'admin', ownerId: 'u1' })).toBeNull();
    expect(answerRestriction({ approvers: 'owner_or_admin', viewerRole: 'user', ownerId: 'u1' })).toBeNull();
    expect(answerRestriction({ approvers: 'owner_or_admin', viewerId: 'u2', viewerRole: 'user' })).toBeNull();
  });

  it('names the limit when someone else looks (owner_or_admin is the default)', () => {
    expect(answerRestriction({ viewerId: 'u2', viewerRole: 'user', ownerId: 'u1' })).toBe('owner_or_admin');
    expect(answerRestriction({ approvers: 'owner_or_admin', viewerId: 'u2', viewerRole: 'user', ownerId: 'u1' })).toBe('owner_or_admin');
    expect(answerRestriction({ approvers: 'owner', viewerId: 'u2', viewerRole: 'user', ownerId: 'u1' })).toBe('owner');
    // An admin is not the owner, and `owner` means the owner.
    expect(answerRestriction({ approvers: 'owner', viewerId: 'u2', viewerRole: 'admin', ownerId: 'u1' })).toBe('owner');
  });

  const open: PendingActionView = { id: 'act_1', kind: 'tool_approval', toolName: 'sandbox_exec', args: {}, status: 'pending' };
  const settled: PendingActionView = { ...open, id: 'act_2', status: 'resolved', resolution: { decision: 'allow' } };

  it('shows the notice above an open request, and keeps Approve usable', () => {
    const html = render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, restriction: 'owner_or_admin' }));
    expect(html).toContain('Only the session owner and project admins can answer');
    expect(html).toContain('Approve');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Approve/);
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, restriction: 'owner' })))
      .toContain('Only the person who started this session can answer');
  });

  it('shows nothing extra without a restriction, or when nothing is open', () => {
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, restriction: null }))).not.toContain('can answer');
    expect(render(h(PendingActionList, { actions: [settled], busy: false, onResolve: noop, restriction: 'owner' }))).not.toContain('can answer');
  });

  it('is worded in Turkish', () => {
    expect(render(h(PendingActionList, { actions: [open], busy: false, onResolve: noop, restriction: 'owner' }), 'tr'))
      .toContain('Yalnızca bu oturumu başlatan kişi yanıtlayabilir');
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

  it('keeps the Approval column wide enough for the control and the badge, and lets them wrap', () => {
    const html = render(h(AgentHumanInTheLoopPanel, {
      value: { toolApproval: { enabled: true } }, onChange: noop, toolConfig: { sandbox: { enabled: true } },
    }));
    const approval = /<th style="width:calc\(([\d.]+)rem[^"]*"[^>]*>Approval<\/th>/.exec(html);
    expect(approval).not.toBeNull();
    expect(Number(approval![1]) * 16).toBeGreaterThanOrEqual(340);
    // The cell's group may wrap, so the badge drops below instead of being cut off.
    expect(html).toMatch(/--group-wrap:wrap[^>]*><div[^>]*mantine-SegmentedControl-root/);
  });
});

describe('Configure → Execution, in Turkish', () => {
  const panel = (locale: 'en' | 'tr') => render(h(AgentExecutionPanel, {
    value: { sessionBudget: { maxCostUsd: 5, onReach: 'pause' } }, onChange: noop, attachments: undefined, onAttachmentsChange: noop,
  }), locale);

  it('translates the Session budget and Attachments blocks', () => {
    const html = panel('tr');
    for (const text of ['Oturum bütçesi', 'Oturum başına bütçe (USD)', 'Duraklat ve bekle', 'Ekler', 'Eklenen dosyaları kabul et',
      'Oturum başına dosya sayısı', 'İzin verilen dosya türleri', 'Bütçeye ulaşıldığında']) {
      expect(html).toContain(text);
    }
    for (const text of ['Session budget', 'Budget per session', 'Accept attached files', 'Allowed file types', 'Storage bucket']) {
      expect(html).not.toContain(text);
    }
  });

  it('describes the inline rule as all-or-nothing, as the guide does', () => {
    expect(panel('en')).toContain('is added up');
    expect(panel('en')).toContain('none of it is');
    expect(panel('en')).not.toContain('files that fit');
    expect(panel('tr')).toContain('hiçbiri konmaz');
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
      hitl: (key) => ['sectionTitle', 'answerRestrictedOwner', 'answerRestrictedOwnerOrAdmin'].includes(key),
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
      'components/agents/studio/AgentExecutionPanel.tsx',
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
