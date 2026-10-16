/** One reading of a session / thread status for every tracing page. */
import React, { createElement as h } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import {
  isTracingStatusFilterValue,
  normalizeTracingStatus,
  TRACING_STATUS_FILTER_VALUES,
  tracingStatusBadgeKey,
  tracingStatusLabelId,
} from '@/components/tracing/sessionStatus';
import SessionStatusBadge from '@/components/tracing/SessionStatusBadge';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { I18nProvider } from '@/lib/i18n';
import { resolveStatusColor, statusVariant } from '@/lib/utils/tracingUtils';

(globalThis as { React?: typeof React }).React = React;

const render = (node: React.ReactNode, locale: 'en' | 'tr' = 'en') =>
  renderToStaticMarkup(h(MantineProvider, null, h(I18nProvider, { locale, children: node })));

describe('tracing status vocabulary', () => {
  it('reads running / in-progress as in_progress and a missing status as unknown', () => {
    expect(normalizeTracingStatus('running')).toBe('in_progress');
    expect(normalizeTracingStatus(' In-Progress ')).toBe('in_progress');
    expect(normalizeTracingStatus(undefined)).toBe('unknown');
    expect(normalizeTracingStatus('')).toBe('unknown');
    expect(normalizeTracingStatus('canceled')).toBe('cancelled');
  });

  it('offers success, error, in_progress, paused, cancelled and abandoned to the filters', () => {
    expect([...TRACING_STATUS_FILTER_VALUES]).toEqual(['success', 'error', 'in_progress', 'paused', 'cancelled', 'abandoned']);
    expect(isTracingStatusFilterValue('abandoned')).toBe(true);
    expect(isTracingStatusFilterValue('running')).toBe(false);
    expect(isTracingStatusFilterValue(null)).toBe(false);
  });

  it('gives each status its badge look', () => {
    expect(tracingStatusBadgeKey('success')).toBe('ok');
    expect(tracingStatusBadgeKey('completed')).toBe('ok');
    expect(tracingStatusBadgeKey('error')).toBe('err');
    expect(tracingStatusBadgeKey('failed')).toBe('err');
    expect(tracingStatusBadgeKey('in_progress')).toBe('running');
    expect(tracingStatusBadgeKey('running')).toBe('running');
    expect(tracingStatusBadgeKey('abandoned')).toBe('warn');
    expect(tracingStatusBadgeKey('partial')).toBe('warn');
    expect(tracingStatusBadgeKey(null)).toBe('paused');
    expect(tracingStatusBadgeKey('cancelled')).toBe('paused');
  });

  it('agrees with the shared tracing helpers about abandoned and in_progress', () => {
    expect(statusVariant('abandoned')).toBe('warn');
    expect(resolveStatusColor('abandoned')).toBe('yellow');
    expect(resolveStatusColor('in_progress')).toBe('blue');
  });

  it('has a translated label for every status the filters offer', () => {
    for (const value of TRACING_STATUS_FILTER_VALUES) expect(tracingStatusLabelId(value)).toBe(value);
    expect(tracingStatusLabelId('something-new')).toBeNull();
  });
});

describe('StatusBadge knows the tracing statuses', () => {
  it('draws in_progress in the running style and abandoned as a warning', () => {
    expect(render(h(StatusBadge, { status: 'in_progress' }))).toMatch(/ds-badge-teal[^>]*>.*In progress/);
    expect(render(h(StatusBadge, { status: 'abandoned' }))).toMatch(/ds-badge-warn[^>]*>.*Abandoned/);
  });
});

describe('SessionStatusBadge', () => {
  it('shows the status in the viewer’s language with the shared look', () => {
    expect(render(h(SessionStatusBadge, { status: 'in_progress' }))).toMatch(/ds-badge-teal[^>]*>.*In progress/);
    expect(render(h(SessionStatusBadge, { status: 'abandoned' }), 'tr')).toMatch(/ds-badge-warn[^>]*>.*Yarıda kaldı/);
    expect(render(h(SessionStatusBadge, { status: 'running' }))).toContain('In progress');
    expect(render(h(SessionStatusBadge, { status: undefined }))).toContain('Unknown');
    // A status the vocabulary does not know is shown as it came, readable.
    expect(render(h(SessionStatusBadge, { status: 'half_done' }))).toContain('half done');
  });
});
