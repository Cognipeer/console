/**
 * Settings → Webhooks, the parts that are not markup: how the event checkboxes
 * edit a subscription (exact types and `group.*` patterns), what the list
 * shows, and that every event, group, reason and state has a label in both
 * languages. (createElement, not JSX: the suite only collects `.test.ts`.)
 */

import React, { createElement as h } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The grid prefetches through the Next router, which a static render has none of.
vi.mock('@/components/common/navigation/useNavigationFeedback', () => ({
  useNavigationFeedback: () => ({ push: () => undefined }),
  usePendingNavigationKey: () => null,
  useIntentPrefetch: () => ({ getIntentProps: () => ({}) }),
}));

import { MantineProvider } from '@mantine/core';
import WebhookManagement from '@/components/settings/WebhookManagement';
import {
  eventGroups,
  eventLabelKey,
  groupEvents,
  isEventSelected,
  isGroupSelected,
  isValidWebhookUrl,
  scopeOf,
  summarizeEvents,
  toggleEvent,
  toggleGroup,
} from '@/components/settings/webhooksUi';
import { WEBHOOK_EVENT_CATALOG } from '@/lib/services/webhooks/webhookEvents';
import { en } from '@/lib/i18n/messages/en';
import { tr } from '@/lib/i18n/messages/tr';

(globalThis as { React?: typeof React }).React = React;

const catalog = WEBHOOK_EVENT_CATALOG.map((event) => ({ ...event }));

describe('editing the event list', () => {
  it('groups the catalog in order', () => {
    expect(eventGroups(catalog)).toEqual(['session', 'action', 'budget', 'agent_run', 'schedule']);
    expect(groupEvents(catalog, 'schedule')).toEqual(['schedule.fired', 'schedule.failed']);
  });

  it('ticks and unticks single events', () => {
    let events = toggleEvent([], catalog, 'budget.reached');
    expect(events).toEqual(['budget.reached']);
    expect(isEventSelected(events, 'budget.reached')).toBe(true);
    events = toggleEvent(events, catalog, 'budget.reached');
    expect(events).toEqual([]);
  });

  it('ticking a group stores its pattern (so later events of the group are covered) and replaces the group\'s exact entries', () => {
    const events = toggleGroup(['agent_run.failed', 'session.idled'], catalog, 'agent_run');
    expect(events).toEqual(['session.idled', 'agent_run.*']);
    expect(isGroupSelected(events, catalog, 'agent_run')).toBe(true);
    expect(isGroupSelected(events, catalog, 'schedule')).toBe(false);
  });

  it('unticking a group drops the pattern and every exact entry of it, leaving other groups alone', () => {
    expect(toggleGroup(['session.idled', 'agent_run.*'], catalog, 'agent_run')).toEqual(['session.idled']);
    // Only the group's entries go: here every event of it is spelled out, and the group is fully selected.
    const all = ['budget.reached', ...groupEvents(catalog, 'agent_run')];
    expect(toggleGroup(all, catalog, 'agent_run')).toEqual(['budget.reached']);
  });

  it('unticking one event a pattern covers expands the pattern to the others, so only that one goes', () => {
    const events = toggleEvent(['agent_run.*'], catalog, 'agent_run.canceled');
    expect(events.sort()).toEqual(['agent_run.failed', 'agent_run.requires_action', 'agent_run.succeeded']);
    expect(isEventSelected(events, 'agent_run.canceled')).toBe(false);
  });

  it('unticking one event under * keeps every other catalog event', () => {
    const events = toggleEvent(['*'], catalog, 'session.idled');
    expect(events).toHaveLength(catalog.length - 1);
    expect(events).not.toContain('session.idled');
    expect(events).not.toContain('*');
  });
});

describe('the list', () => {
  it('shows the first events and a count; * is "all events"', () => {
    expect(summarizeEvents(['a.b', 'c.d', 'e.f', 'g.h'])).toEqual({ shown: ['a.b', 'c.d'], more: 2, all: false });
    expect(summarizeEvents(['session.idled'])).toEqual({ shown: ['session.idled'], more: 0, all: false });
    expect(summarizeEvents(['*', 'x.y'])).toEqual({ shown: [], more: 0, all: true });
  });

  it('reads scope from projectId (null = every project)', () => {
    expect(scopeOf({ projectId: null })).toBe('all');
    expect(scopeOf({ projectId: 'proj-1' })).toBe('project');
  });

  it('accepts only http(s) URLs in the form', () => {
    expect(isValidWebhookUrl('https://hooks.example.com/in')).toBe(true);
    expect(isValidWebhookUrl(' http://example.com ')).toBe(true);
    expect(isValidWebhookUrl('ftp://example.com')).toBe(false);
    expect(isValidWebhookUrl('example.com')).toBe(false);
    expect(isValidWebhookUrl('')).toBe(false);
  });

  it('mounts with its toolbar, before any data arrives', () => {
    const html = renderToStaticMarkup(h(MantineProvider, null, h(WebhookManagement)));
    expect(html).toContain('New webhook');
    expect(html).toContain('Search webhooks');
  });
});

describe('strings', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const leaves = (value: unknown, prefix = ''): string[] => (value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, inner]) => leaves(inner, `${prefix}${prefix ? '.' : ''}${key}`))
    : [prefix]);

  it('carry a label for every event, group, disabled reason, delivery state and scope — in English and Turkish', () => {
    for (const messages of [en.webhooks, tr.webhooks]) {
      for (const event of catalog) expect(messages.events[eventLabelKey(event.type) as keyof typeof messages.events]).toBeTruthy();
      for (const group of eventGroups(catalog)) expect(messages.groups[group as keyof typeof messages.groups]).toBeTruthy();
      for (const reason of ['manual', 'redirect', 'blocked_address', 'sustained_failure']) {
        expect(messages.reasons[reason as keyof typeof messages.reasons]).toBeTruthy();
      }
      for (const state of ['pending', 'delivered', 'failed']) expect(messages.deliveries.states[state as keyof typeof messages.deliveries.states]).toBeTruthy();
      expect(messages.scope.project).toBeTruthy();
      expect(messages.scope.all).toBeTruthy();
    }
  });

  it('Turkish translates the whole namespace (no key falls back to English)', () => {
    expect(leaves(tr.webhooks).sort()).toEqual(leaves(en.webhooks).sort());
    const english = new Set(leaves(en.webhooks).map((key) => key.split('.').reduce<any>((v, k) => v[k], en.webhooks)));
    const untranslated = leaves(tr.webhooks).filter((key) => {
      const value = key.split('.').reduce<any>((v, k) => v[k], tr.webhooks);
      return english.has(value) && !['url', 'urlPlaceholder', 'summaryUrl', 'title'].some((ok) => key.endsWith(ok)) && !/^[a-z_.]+$/.test(String(value));
    });
    expect(untranslated).toEqual([]);
  });

  it('name the page in navigation and breadcrumbs', () => {
    expect(en.navigation.webhooks).toBe('Webhooks');
    expect(tr.navigation.webhooks).toBeTruthy();
    expect(en.breadcrumbs.webhooks).toBeTruthy();
    expect(tr.breadcrumbs.webhooks).toBeTruthy();
  });
});
