'use client';

import type { CSSProperties } from 'react';
import { Text } from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { useLocale, useTranslations } from '@/lib/i18n';
import { CardLink } from './CardLink';
import { sessionHref, type OverviewSession } from './overviewModel';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "5m ago" and the like, from the `dashboardOverview.home.ago` texts. */
export function formatRelativeTime(date: Date, t: Translate, locale: string): string {
  const diff = Math.max(0, Date.now() - date.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('home.ago.justNow');
  if (min < 60) return t('home.ago.minutes', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('home.ago.hours', { count: hr });
  const days = Math.floor(hr / 24);
  if (days < 30) return t('home.ago.days', { count: days });
  return date.toLocaleDateString(locale);
}

/** "850 ms", "3.2 s", "4 min". */
export function formatDuration(ms: number, locale: string): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toLocaleString(locale, { maximumFractionDigits: seconds < 10 ? 1 : 0 })} s`;
  }
  return `${Math.round(seconds / 60).toLocaleString(locale)} min`;
}

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '6px 8px',
  margin: '0 -8px',
  borderRadius: 'var(--ds-r-sm)',
  fontSize: 13,
  flexWrap: 'nowrap',
};

/**
 * The project's latest agent sessions, newest first, each a link to its session page. Only for a person who can
 * open Tracing: the API sends no sessions to anyone else.
 */
export function RecentSessionList({ sessions, limit = 5 }: { sessions: readonly OverviewSession[]; limit?: number }) {
  const t = useTranslations('dashboardOverview');
  const locale = useLocale();
  if (sessions.length === 0) {
    return (
      <Text size="sm" c="dimmed">
        {t('recentSessions.empty')}
      </Text>
    );
  }
  return (
    <div data-testid="recent-sessions" style={{ display: 'grid', gap: 2 }}>
      {sessions.slice(0, limit).map((session) => {
        const name = session.agentName || t('recentSessions.unnamed');
        const details = [
          typeof session.durationMs === 'number' ? formatDuration(session.durationMs, locale) : null,
          typeof session.totalTokens === 'number'
            ? t('recentSessions.tokens', { count: session.totalTokens.toLocaleString(locale) })
            : null,
        ].filter(Boolean);
        return (
          <CardLink
            key={session.sessionId}
            href={sessionHref(session.sessionId)}
            className="ds-link-row"
            style={ROW_STYLE}
          >
            <span
              aria-hidden
              style={{
                width: 26,
                height: 26,
                borderRadius: '50%',
                background: session.status === 'error' ? 'var(--ds-surface-2)' : 'var(--ds-accent-soft)',
                color: session.status === 'error' ? 'var(--ds-text-muted)' : 'var(--ds-accent)',
                display: 'grid',
                placeItems: 'center',
                fontSize: 11,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              {name.charAt(0).toUpperCase()}
            </span>
            <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
              <span style={{ display: 'block', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {name}
              </span>
              {details.length > 0 ? (
                <span className="ds-faint" style={{ display: 'block', fontSize: 11.5 }}>
                  {details.join(' · ')}
                </span>
              ) : null}
            </span>
            {session.status ? <StatusBadge status={session.status} /> : null}
            {session.startedAt ? (
              <span className="ds-faint" style={{ fontSize: 11.5, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {formatRelativeTime(new Date(session.startedAt), t, locale)}
              </span>
            ) : null}
            <IconChevronRight size={14} stroke={1.7} color="var(--ds-text-faint)" style={{ flexShrink: 0 }} />
          </CardLink>
        );
      })}
    </div>
  );
}
