/**
 * Studio's side of the experience settings, feedback and client tools: how the
 * Experience section edits the stored object, what the Feedback tab asks for and
 * draws, how a session shows a rating and a tool the host page runs, and that
 * every string exists in both languages. (createElement, not JSX: the suite only
 * collects `.test.ts`.)
 */

import React, { createElement as h, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { I18nProvider } from '@/lib/i18n';
import AgentExperiencePanel from '@/components/agents/studio/AgentExperiencePanel';
import MessageFeedbackRow from '@/components/agents/session/MessageFeedbackRow';
import PendingActionList from '@/components/agents/session/PendingActionCards';
import {
  addStarter,
  experienceForSave,
  experienceSaveErrors,
  moveStarter,
  patchExperience,
  removeStarter,
  updateStarter,
  AGENT_STARTERS_MAX,
} from '@/components/agents/studio/experienceSettings';
import {
  DEFAULT_FEEDBACK_FILTER,
  FEEDBACK_REASON_ORDER,
  feedbackForMessage,
  feedbackQuery,
  formatPositiveRate,
  persistedIndexOf,
  reasonBars,
  screenIndexOf,
  type SessionMessageFeedback,
} from '@/components/agents/studio/feedbackUi';
import { CONFIG_SECTION_KEYS, CONFIG_SECTION_TITLES, changedConfigSections, configSectionTitle } from '@/components/agents/studio/configSections';
import {
  applyLocalResolution,
  openActionsOf,
  resolutionFromBody,
  resolvedKind,
  type PendingActionView,
} from '@/components/agents/session/pendingActions';
import { describeSessionEvent } from '@/components/agents/session/sessionActivityUi';
import type { ChatMessage } from '@/components/agents/session/sessionTypes';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const render = (node: ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));
const noop = () => undefined;

describe('editing the Experience section', () => {
  it('nothing in, nothing out: an untouched agent stores no experience', () => {
    expect(patchExperience(undefined, {})).toBeUndefined();
    expect(patchExperience(undefined, { welcome: '  ' })).toBeUndefined();
    expect(patchExperience(undefined, { starters: [] })).toBeUndefined();
    expect(experienceForSave(undefined)).toBeUndefined();
    expect(experienceForSave({ starters: [{ text: '  ' }] })).toBeUndefined();
  });

  it('a welcome text and starters are edited in place', () => {
    let value = patchExperience(undefined, { welcome: 'Hi {{user.firstName}}' });
    expect(value).toEqual({ welcome: 'Hi {{user.firstName}}' });
    value = addStarter(value);
    value = updateStarter(value, 0, { text: 'What can you do?', label: 'Abilities', autoSend: true });
    value = addStarter(value);
    value = updateStarter(value, 1, { text: 'Show my invoices' });
    expect(value?.starters).toEqual([{ text: 'What can you do?', label: 'Abilities', autoSend: true }, { text: 'Show my invoices' }]);

    // Turning a switch off or clearing a label removes the key rather than storing false / empty.
    value = updateStarter(value, 0, { autoSend: false, label: '' });
    expect(value?.starters?.[0]).toEqual({ text: 'What can you do?' });

    value = moveStarter(value, 1, 0);
    expect(value?.starters?.map((starter) => starter.text)).toEqual(['Show my invoices', 'What can you do?']);
    expect(moveStarter(value, 0, 9)).toBe(value);
    value = removeStarter(value, 0);
    expect(value?.starters?.map((starter) => starter.text)).toEqual(['What can you do?']);
    expect(removeStarter(removeStarter(value, 0), 0)).toEqual({ welcome: 'Hi {{user.firstName}}' });
  });

  it('cannot add past the limit', () => {
    let value = undefined as ReturnType<typeof addStarter>;
    for (let i = 0; i < AGENT_STARTERS_MAX + 3; i += 1) value = addStarter(value);
    expect(value?.starters).toHaveLength(AGENT_STARTERS_MAX);
  });

  it('saves without a blank starter that is still being typed, and says what would stop a save', () => {
    const value = { welcome: ' Hello ', starters: [{ text: 'one ' }, { text: '' }, { text: 'x'.repeat(600) }] };
    expect(experienceForSave(value)).toEqual({ welcome: 'Hello', starters: [{ text: 'one' }, { text: 'x'.repeat(600) }] });
    expect(experienceSaveErrors(experienceForSave(value))).toEqual([{ field: 'experience.starters.1.text', code: 'starter_text_too_long' }]);
    expect(experienceSaveErrors(value).map((issue) => issue.code)).toEqual(['starter_text_required', 'starter_text_too_long']);
    expect(experienceSaveErrors({ starters: [{ text: 'ok', label: 'y'.repeat(100) }] })[0]).toMatchObject({ code: 'starter_label_too_long' });
    expect(experienceSaveErrors({ welcome: 'w'.repeat(3000) })[0]).toMatchObject({ code: 'welcome_too_long' });
    expect(experienceSaveErrors(undefined)).toEqual([]);
  });

  it('is its own Configure section, flagged when it differs from the published version', () => {
    expect(CONFIG_SECTION_KEYS.experience).toEqual(['experience']);
    expect(CONFIG_SECTION_TITLES.experience).toBe('Experience');
    expect(configSectionTitle('experience', (key) => (key === 'experience.sectionTitle' ? 'Deneyim' : key))).toBe('Deneyim');
    const published = { modelKey: 'm' };
    expect([...changedConfigSections({ modelKey: 'm', experience: { welcome: 'Hi' } }, published)]).toEqual(['experience']);
    expect([...changedConfigSections({ modelKey: 'm', experience: {} }, published)]).toEqual([]);
  });

  it('renders the welcome box, the starters and the preview in both languages', () => {
    const value = { welcome: 'Hi', starters: [{ text: 'What can you do?', label: 'Abilities' }, { text: 'Second' }] };
    const english = render(h(AgentExperiencePanel, { value, onChange: noop }));
    expect(english).toContain('Welcome text');
    expect(english).toContain('Conversation starters');
    expect(english).toContain('{{user.firstName}}');
    expect(english).toContain('Send at once');
    expect(english).toContain('Abilities');
    expect(english).toContain('How the chips look');
    const turkish = render(h(AgentExperiencePanel, { value, onChange: noop }), 'tr');
    expect(turkish).toContain('Karşılama metni');
    expect(turkish).toContain('Konuşma başlatıcıları');
    expect(turkish).not.toContain('Welcome text');
  });

  it('shows the problems of a refused save only when asked', () => {
    const value = { starters: [{ text: '' }] };
    expect(render(h(AgentExperiencePanel, { value, onChange: noop }))).not.toContain('Write the message this starter puts in the box.');
    expect(render(h(AgentExperiencePanel, { value, onChange: noop, showErrors: true }))).toContain('Write the message this starter puts in the box.');
  });
});

describe('the Feedback tab\'s queries and bars', () => {
  it('a filter becomes the query the routes read', () => {
    expect(feedbackQuery(DEFAULT_FEEDBACK_FILTER)).toBe('days=30');
    expect(feedbackQuery({ days: 7, rating: 'down', reason: 'too_long', onlyWithComment: true }, { limit: 20, skip: 40 }))
      .toBe('days=7&rating=down&reason=too_long&hasComment=true&limit=20&skip=40');
  });

  it('draws the reasons that were named, most named first, ties in the usual order', () => {
    expect(reasonBars(undefined)).toEqual([]);
    expect(reasonBars({ other: 0 })).toEqual([]);
    expect(reasonBars({ other: 2, inaccurate: 4, unsafe: 2, too_long: 1 })).toEqual([
      { reason: 'inaccurate', count: 4, percent: 100 },
      { reason: 'unsafe', count: 2, percent: 50 },
      { reason: 'other', count: 2, percent: 50 },
      { reason: 'too_long', count: 1, percent: 25 },
    ]);
    expect(FEEDBACK_REASON_ORDER).toEqual(['inaccurate', 'incomplete', 'off_topic', 'too_long', 'unsafe', 'other']);
  });

  it('formats the share of thumbs up', () => {
    expect(formatPositiveRate(0.8333)).toBe('83%');
    expect(formatPositiveRate(1)).toBe('100%');
    expect(formatPositiveRate(null)).toBe('—');
    expect(formatPositiveRate(undefined)).toBe('—');
  });
});

describe('a rating under an answer in the session', () => {
  const rating = (overrides: Partial<SessionMessageFeedback> = {}): SessionMessageFeedback => ({
    messageId: 'msg_a', messageIndex: 1, rating: 'down', reasons: ['inaccurate'], comment: 'the date is wrong', userId: 'u1',
    channel: 'portal', removed: false, createdAt: '2026-10-11T10:00:00.000Z', updatedAt: '2026-10-11T10:00:00.000Z', ...overrides,
  });

  it('finds the ratings of the message at a stored index, newest first, and not the removed ones', () => {
    const rows = [
      rating({ updatedAt: '2026-10-11T10:00:00.000Z' }),
      rating({ userId: 'u2', updatedAt: '2026-10-11T11:00:00.000Z' }),
      rating({ messageIndex: 3 }),
      rating({ removed: true }),
    ];
    expect(feedbackForMessage(rows, 1).map((row) => row.userId)).toEqual(['u2', 'u1']);
    expect(feedbackForMessage(rows, 3)).toHaveLength(1);
    expect(feedbackForMessage(rows, 5)).toEqual([]);
  });

  it('maps the on-screen list to the stored transcript, which has no client-only error turns', () => {
    const screen = [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'error' }, { role: 'user' }, { role: 'assistant' }];
    expect(persistedIndexOf(screen, 1)).toBe(1);
    expect(persistedIndexOf(screen, 4)).toBe(3);
    expect(persistedIndexOf(screen, 5)).toBe(4);
    expect(screenIndexOf(screen, 4)).toBe(5);
    expect(screenIndexOf(screen, 3)).toBe(4);
    expect(screenIndexOf(screen, 9)).toBe(-1);
  });

  it('draws the thumb, the reasons and the words', () => {
    const html = render(h(MessageFeedbackRow, { rows: [rating()] }));
    expect(html).toContain('Not helpful');
    expect(html).toContain('Inaccurate');
    expect(html).toContain('the date is wrong');
    expect(render(h(MessageFeedbackRow, { rows: [rating({ rating: 'up', reasons: [], comment: undefined })] }))).toContain('Helpful');
    // No ratings, nothing drawn (the provider's own styles aside).
    expect(render(h(MessageFeedbackRow, { rows: [] }))).not.toContain('message-feedback');
    expect(render(h(MessageFeedbackRow, { rows: [rating()] }), 'tr')).toContain('Faydalı değil');
  });
});

describe('a tool the host page runs, in a session', () => {
  const waiting: PendingActionView = { id: 'act_1', kind: 'client_tool', toolName: 'get_selection', args: { max: 3 }, timeoutSeconds: 30, status: 'pending' };
  const transcript = (action: PendingActionView): ChatMessage[] => [{ role: 'assistant', content: '', pendingActions: [action] }];

  it('is an open request like the others', () => {
    expect(openActionsOf(transcript(waiting))).toHaveLength(1);
  });

  it('shows what is being asked of the page, not an approval', () => {
    const html = render(h(PendingActionList, { actions: [waiting], busy: false, onResolve: noop }));
    expect(html).toContain('Waiting for the page');
    expect(html).toContain('get_selection');
    expect(html).toContain('times out after 30 s');
    expect(html).toContain('Give up on it');
    expect(html).not.toContain('Approve');
    expect(render(h(PendingActionList, { actions: [waiting], busy: false, onResolve: noop }), 'tr')).toContain('Sayfa bekleniyor');
  });

  it('giving up is an error answer, shown at once as the tool failing', () => {
    const body = { error: 'The call was given up in Studio.' };
    expect(resolutionFromBody(body)).toEqual({ error: 'The call was given up in Studio.' });
    expect(resolutionFromBody({ output: { text: 'x' } })).toEqual({ output: { text: 'x' } });
    const settled = applyLocalResolution(transcript(waiting), 'act_1', body)[0].pendingActions![0];
    expect(resolvedKind(settled)).toBe('tool_failed');
    expect(resolvedKind({ ...waiting, status: 'resolved', resolution: { output: 1 } })).toBe('tool_ran');
  });

  it('a settled call reads as one line', () => {
    const ran = render(h(PendingActionList, { actions: [{ ...waiting, status: 'resolved', resolution: { output: 1 } }], busy: false, onResolve: noop }));
    expect(ran).toContain('The page ran it');
    const late = render(h(PendingActionList, {
      actions: [{ ...waiting, status: 'resolved', resolution: { error: 'The host page did not answer.', timedOut: true } }], busy: false, onResolve: noop,
    }));
    expect(late).toContain('The page did not answer in time');
    const failed = render(h(PendingActionList, { actions: [{ ...waiting, status: 'resolved', resolution: { error: 'nothing selected' } }], busy: false, onResolve: noop }));
    expect(failed).toContain('The page could not run it');
  });

  it('the event log words the call, its answer, its failure and a cut', () => {
    const event = (type: string, data: Record<string, unknown>) => ({ seq: 1, type, data });
    expect(describeSessionEvent(event('action.required', { kind: 'client_tool', toolName: 'get_selection' })))
      .toMatchObject({ key: 'evClientToolRequested', values: { name: 'get_selection' }, tone: 'blue' });
    expect(describeSessionEvent(event('action.resolved', { kind: 'client_tool', toolName: 'get_selection', ok: true })))
      .toMatchObject({ key: 'evClientToolAnswered', tone: 'green' });
    expect(describeSessionEvent(event('action.resolved', { kind: 'client_tool', toolName: 'get_selection', ok: false, timedOut: true })))
      .toMatchObject({ key: 'evClientToolFailed', tone: 'red' });
    expect(describeSessionEvent(event('session.truncated', { removedMessages: 4 }))).toMatchObject({ key: 'evTruncated', values: { removed: '4' } });
    const activity = en.agents.activity as Record<string, string>;
    for (const key of ['evClientToolRequested', 'evClientToolAnswered', 'evClientToolFailed', 'evTruncated']) expect(activity[key]).toBeTruthy();
  });
});

describe('strings', () => {
  const flatten = (node: unknown, prefix = ''): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'string') out[`${prefix}${key}`] = value;
      else if (value && typeof value === 'object') Object.assign(out, flatten(value, `${prefix}${key}.`));
    }
    return out;
  };
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it.each([
    ['experience', en.agents.experience, tr.agents.experience],
    ['feedback', en.agents.feedback, tr.agents.feedback],
  ])('%s has the same keys and placeholders in English and Turkish, none empty, translated', (_name, english, turkish) => {
    const a = flatten(english);
    const b = flatten(turkish);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const key of Object.keys(a)) {
      expect(b[key].trim(), key).not.toBe('');
      expect(placeholders(b[key]), key).toEqual(placeholders(a[key]));
      // Proper nouns and loanwords may match; everything else is translated.
      if (!['portal', 'preview'].includes(key)) expect(b[key], key).not.toBe(a[key]);
    }
  });

  it('the host page tool strings are in both languages', () => {
    const hitl = en.agents.hitl as Record<string, string>;
    const hitlTr = tr.agents.hitl as Record<string, string>;
    for (const key of Object.keys(hitl).filter((name) => name.startsWith('clientTool'))) {
      expect(hitlTr[key], key).toBeTruthy();
      expect(hitlTr[key], key).not.toBe(hitl[key]);
      expect(placeholders(hitlTr[key])).toEqual(placeholders(hitl[key]));
    }
    expect(Object.keys(hitl).filter((name) => name.startsWith('clientTool')).length).toBeGreaterThanOrEqual(8);
    expect(en.agents.tabs.feedback).toBe('Feedback');
    expect(tr.agents.tabs.feedback).toBe('Geri bildirim');
  });

  it('every key the new components ask for exists in both languages', () => {
    const lookup = (language: typeof en | typeof tr, key: string) =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], language);
    const files = [
      'components/agents/studio/AgentExperiencePanel.tsx',
      'components/agents/studio/AgentFeedbackPanel.tsx',
      'components/agents/session/MessageFeedbackRow.tsx',
      'components/agents/session/PendingActionCards.tsx',
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
        checked += 1;
        for (const [name, language] of [['en', en], ['tr', tr]] as const) {
          if (typeof lookup(language, `${namespace}.${match[2]}`) !== 'string') missing.push(`${file}: ${namespace}.${match[2]} (${name})`);
        }
      }
      // Reasons are looked up by a built key.
      if (file.endsWith('MessageFeedbackRow.tsx') || file.endsWith('AgentFeedbackPanel.tsx')) {
        for (const reason of FEEDBACK_REASON_ORDER) {
          for (const [name, language] of [['en', en], ['tr', tr]] as const) {
            if (typeof lookup(language, `agents.feedback.reason.${reason}`) !== 'string') missing.push(`reason.${reason} (${name})`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(missing).toEqual([]);
  });
});
