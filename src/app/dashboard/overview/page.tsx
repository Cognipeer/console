'use client';

/**
 * The dashboard home: where a person starts, not a report. Each block is there only when it has something to show:
 *
 * - the first steps of a new project, until they are done (or hidden);
 * - what needs attention now (`HomeAttention`: the project's open incidents; the Enterprise overlay adds entity
 *   health);
 * - "Pick up where you left off": the services this browser opened last and the project's latest agent sessions;
 * - "Your services": the services the person can open, the recently opened first, each with its counts where the page
 *   has them, else what it is for.
 *
 * Numbers over time (key metrics, charts, the per-service dashboards) are in Reports, the docs under Help in the menu.
 * Nothing links to a service the person cannot open, and no number is shown for one (`/api/dashboard` sends 0 for it).
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle, IconChevronRight, IconRefresh } from '@tabler/icons-react';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useLauncher } from '@/components/layout/launcher/LauncherContext';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import { CardLink } from '@/components/dashboard/CardLink';
import { ActivityListSkeleton, HOME_SERVICE_GRID, HomeServicesSkeleton } from '@/components/dashboard/OverviewSkeletons';
import HomeAttention from '@/components/dashboard/HomeAttention';
import { GetStarted, useGetStartedHidden } from '@/components/dashboard/GetStarted';
import { useActiveProjectName } from '@/components/dashboard/OverviewSubtitle';
import { RecentSessionList } from '@/components/dashboard/RecentSessions';
import {
  getStartedComplete,
  getStartedSteps,
  homeServices,
  recentlyOpenedServices,
  type OverviewSession,
  type OverviewStats,
} from '@/components/dashboard/overviewModel';
import { useLocale, useTranslations } from '@/lib/i18n';

interface DashboardData {
  stats: OverviewStats;
  recentSessions?: OverviewSession[];
  user?: { name?: string; email: string; licenseType: string };
}

/** The whole project: the get-started steps are ticked from counts that cover all of it. */
const DASHBOARD_URL = '/api/dashboard?period=total';

/**
 * Service descriptions always take two lines (clamped, space reserved), so card heights do not depend on copy length
 * and match the skeleton cards.
 */
const SERVICE_TEXT_STYLE: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.4,
  minHeight: '2.8em',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
};

const SERVICE_CARD_STYLE: CSSProperties = { background: 'var(--ds-surface-1)', textAlign: 'left' };

const SERVICE_ICON_STYLE: CSSProperties = {
  width: 32,
  height: 32,
  flexShrink: 0,
  borderRadius: 8,
  background: 'var(--ds-accent-soft)',
  color: 'var(--ds-accent)',
  display: 'grid',
  placeItems: 'center',
};

function emailLocalPart(email?: string | null): string | null {
  return email ? email.split('@')[0] : null;
}

export default function DashboardOverviewPage() {
  const t = useTranslations('dashboardOverview');
  const tNav = useTranslations('navigation');
  const locale = useLocale();
  const shellUser = useDashboardUser();
  const project = useActiveProjectName();
  const { services, recents, hydrated } = useLauncher();
  // The services opened last are restored from local storage after mount.
  const launcherReady = hydrated !== false;
  const [getStartedHidden, hideGetStarted] = useGetStartedHidden();
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(DASHBOARD_URL, { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Dashboard request failed with status ${res.status}`);
        return (await res.json()) as DashboardData;
      })
      .then((json) => {
        if (!controller.signal.aborted) setData(json);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.error('Failed to fetch dashboard data:', err);
        setFailed(true);
      });
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  const firstLoad = data === null && !failed;
  const stats = data?.stats;
  const userName =
    data?.user?.name || shellUser?.name || emailLocalPart(data?.user?.email) || emailLocalPart(shellUser?.email);

  // What the person can open in the ACTIVE project (the launcher's list is the navigation's: roles, group grants,
  // custom policies and project limits, as the engine decides them).
  const offered = useMemo(() => new Set(services.map((s) => String(s.id))), [services]);
  const canOpen = useCallback((id: string) => offered.has(id), [offered]);

  const steps = useMemo(() => (stats ? getStartedSteps(services, stats) : []), [stats, services]);
  const showGetStarted = !getStartedHidden && steps.length > 0 && !getStartedComplete(steps);

  const recent = useMemo(
    () => (launcherReady ? recentlyOpenedServices(services, recents) : []),
    [launcherReady, services, recents],
  );
  const yours = useMemo(() => homeServices(services, launcherReady ? recents : []), [services, recents, launcherReady]);

  const sessions = data?.recentSessions ?? [];
  // The sessions only with Tracing, and only when there is one to show (or it is still loading, or failed).
  const showSessions = canOpen('tracing') && (firstLoad || failed || sessions.length > 0);
  const showPickUp = recent.length > 0 || showSessions;

  /** The counts under a service on its card, in place of its description (only services the page has numbers for). */
  const serviceCounts = (id: string): string | null => {
    if (!stats) return null;
    switch (id) {
      case 'models':
        return t('home.serviceCounts.models', { llm: stats.models.llm, embedding: stats.models.embedding });
      case 'vector':
        return t(stats.vectors.indexes === 1 ? 'home.serviceCounts.indexOne' : 'home.serviceCounts.indexMany', {
          count: stats.vectors.indexes,
        });
      case 'tracing':
        return t(stats.tracing.totalSessions === 1 ? 'home.serviceCounts.sessionOne' : 'home.serviceCounts.sessionMany', {
          count: stats.tracing.totalSessions.toLocaleString(locale),
        });
      default:
        return null;
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title={userName ? t('home.welcome', { name: userName }) : t('title')}
        subtitle={project ? <span data-testid="home-project">{t('home.project', { project })}</span> : undefined}
      />

      {/* First steps of a new project. */}
      {showGetStarted ? (
        <GetStarted steps={steps} onHide={hideGetStarted} style={{ marginBottom: 16 }} />
      ) : null}

      {/* Only when something needs attention. */}
      <HomeAttention canOpen={canOpen} />

      {showPickUp ? (
        <section className="ds-card ds-card-pad-lg" style={{ marginBottom: 16 }} data-testid="home-pick-up">
          <div className="ds-h3" style={{ marginBottom: 12 }}>
            {t('home.pickUp.title')}
          </div>
          {recent.length > 0 ? (
            <div style={{ marginBottom: showSessions ? 18 : 0 }}>
              <div className="ds-eyebrow plain">{t('home.pickUp.recentlyOpened')}</div>
              <Group gap={6} mt={8} data-testid="recently-opened">
                {recent.map((svc) => {
                  const Icon = svc.icon;
                  return (
                    <Button
                      key={svc.id}
                      component={Link}
                      href={svc.href}
                      variant="default"
                      size="compact-sm"
                      radius="xl"
                      leftSection={<Icon size={14} stroke={1.7} />}
                    >
                      {tNav(svc.navLabelKey)}
                    </Button>
                  );
                })}
              </Group>
            </div>
          ) : null}
          {showSessions ? (
            <div aria-busy={firstLoad || undefined} data-testid="home-sessions">
              <div className="ds-row-between" style={{ marginBottom: 6 }}>
                <div className="ds-eyebrow plain">{t('recentSessions.title')}</div>
                <Button
                  component={Link}
                  href="/dashboard/tracing"
                  variant="subtle"
                  size="xs"
                  rightSection={<IconChevronRight size={12} />}
                >
                  {t('recentSessions.viewAll')}
                </Button>
              </div>
              {failed ? (
                <SectionError message={t('activityError')} onRetry={retry} />
              ) : firstLoad ? (
                <ActivityListSkeleton rows={3} />
              ) : (
                <RecentSessionList sessions={sessions} />
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* The person's services, the recently opened first; every one of them is in the menu. */}
      {!launcherReady ? (
        <HomeServicesSkeleton />
      ) : yours.shown.length > 0 ? (
        <section className="ds-card ds-card-pad-lg" style={{ marginBottom: 16 }} data-testid="home-services">
          <div className="ds-row-between" style={{ marginBottom: 14, gap: 12 }}>
            <div className="ds-h3">{t('home.services.title')}</div>
            {yours.more > 0 ? (
              <span className="ds-muted" style={{ fontSize: 12.5 }}>
                {t('home.services.more', { count: yours.more })}
              </span>
            ) : null}
          </div>
          <div style={HOME_SERVICE_GRID}>
            {yours.shown.map((svc) => {
              const Icon = svc.icon;
              const counts = serviceCounts(String(svc.id));
              return (
                <CardLink
                  key={svc.id}
                  href={svc.href}
                  className="ds-card ds-card-pad-sm interactive"
                  style={SERVICE_CARD_STYLE}
                >
                  <div className="ds-row ds-gap-sm" style={{ marginBottom: 8 }}>
                    <div style={SERVICE_ICON_STYLE}>
                      <Icon size={16} stroke={1.7} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1, fontSize: 13, fontWeight: 500 }}>{tNav(svc.navLabelKey)}</div>
                  </div>
                  <div
                    className={counts ? 'ds-mono' : 'ds-muted'}
                    style={counts ? { ...SERVICE_TEXT_STYLE, color: 'var(--ds-text)' } : SERVICE_TEXT_STYLE}
                    data-counts={counts ? svc.id : undefined}
                  >
                    {counts ?? tNav(svc.navDescriptionKey)}
                  </div>
                </CardLink>
              );
            })}
          </div>
        </section>
      ) : null}
    </PageContainer>
  );
}

/** Inline error with a retry action, inside a card. */
function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tFeedback = useTranslations('navigationFeedback');
  return (
    <div role="alert" style={{ display: 'flex', alignItems: 'center' }}>
      <Group gap="sm" wrap="wrap">
        <IconAlertTriangle size={16} stroke={1.7} color="var(--ds-err)" />
        <Text size="sm">{message}</Text>
        <Button variant="default" size="xs" leftSection={<IconRefresh size={12} stroke={1.7} />} onClick={onRetry}>
          {tFeedback('retry')}
        </Button>
      </Group>
    </div>
  );
}
