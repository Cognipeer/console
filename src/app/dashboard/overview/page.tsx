'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  Group,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import DashboardDateFilter, { useDashboardDateFilterState } from '@/components/layout/DashboardDateFilter';
import { useDashboardUser } from '@/components/layout/DashboardUserContext';
import { useLauncher } from '@/components/layout/launcher/LauncherContext';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import RefreshIndicator from '@/components/common/ui/RefreshIndicator';
import { StatGridSkeleton } from '@/components/common/ui/Skeletons';
import StatTile from '@/components/common/ui/StatTile';
import { CardLink } from '@/components/dashboard/CardLink';
import { useDocLink } from '@/components/docs/DocsDrawerContext';
import {
  ActivityListSkeleton,
  PinnedServicesSkeleton,
} from '@/components/dashboard/OverviewSkeletons';
import ActiveIncidentsCard from '@/components/alerts/ActiveIncidentsCard';
import { GetStarted, useGetStartedHidden } from '@/components/dashboard/GetStarted';
import { OverviewSubtitle } from '@/components/dashboard/OverviewSubtitle';
import { RecentSessionList } from '@/components/dashboard/RecentSessions';
import {
  dailyLine,
  getStartedComplete,
  getStartedSteps,
  overviewTiles,
  type OverviewDailyPoint,
  type OverviewSession,
  type OverviewStats,
  type OverviewTileId,
} from '@/components/dashboard/overviewModel';
import {
  IconAlertTriangle,
  IconBell,
  IconBolt,
  IconBook,
  IconBrain,
  IconChevronRight,
  IconDatabase,
  IconPlus,
  IconRefresh,
  IconRocket,
  IconTimeline,
} from '@tabler/icons-react';
import { useLocale, useTranslations } from '@/lib/i18n';
import { buildDashboardDateSearchParams } from '@/lib/utils/dashboardDateFilter';

interface DashboardData {
  stats: OverviewStats;
  recentSessions?: OverviewSession[];
  daily?: OverviewDailyPoint[];
  user?: { name?: string; email: string; licenseType: string };
}

const SDK_PACKAGE_URL = 'https://www.npmjs.com/package/@cognipeer/agent-sdk';

// Height of a stat row with sparklines; keeps the error state in place.
const STAT_ROW_MIN_HEIGHT = 134;

const TILE_STYLE: CSSProperties = { background: 'var(--ds-surface-1)', textAlign: 'left' };

const TWO_COLUMNS: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
  gap: 16,
};

/**
 * Tile descriptions always take two lines (clamped, space reserved), so tile
 * heights do not depend on copy length and match the skeleton tiles.
 */
function twoLineText(fontSize: number, lineHeight: number): CSSProperties {
  return {
    fontSize,
    lineHeight,
    minHeight: `${lineHeight * 2}em`,
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    overflow: 'hidden',
  };
}

const PINNED_DESCRIPTION_STYLE = twoLineText(11.5, 1.4);

const RESOURCE_ROW_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  border: '1px solid var(--ds-border-soft)',
  borderRadius: 'var(--ds-r-sm)',
  cursor: 'pointer',
};

const TILE_ICONS: Record<OverviewTileId, ReactNode> = {
  sessions: <IconTimeline size={14} stroke={1.7} />,
  tokens: <IconBolt size={14} stroke={1.7} />,
  models: <IconBrain size={14} stroke={1.7} />,
  indexes: <IconDatabase size={14} stroke={1.7} />,
};

function emailLocalPart(email?: string | null): string | null {
  return email ? email.split('@')[0] : null;
}

export default function DashboardOverviewPage() {
  const t = useTranslations('dashboardOverview');
  const apiDocsLink = useDocLink('api-overview');
  const tNav = useTranslations('navigation');
  const locale = useLocale();
  const shellUser = useDashboardUser();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const [dateFilter, setDateFilter] = useDashboardDateFilterState();
  const { pinnedServices, recentServices, services, openLauncher, hydrated } = useLauncher();
  // Pinned services are restored from local storage after mount.
  const launcherReady = hydrated !== false;
  const [getStartedHidden, hideGetStarted] = useGetStartedHidden();

  const fetchDashboard = useCallback(async () => {
    // Latest request wins: a newer date range aborts the one in flight.
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/dashboard?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Dashboard request failed with status ${res.status}`);
      const json = (await res.json()) as DashboardData;
      if (!controller.signal.aborted) setData(json);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('Failed to fetch dashboard data:', err);
      setFailed(true);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [dateFilter]);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const retry = useCallback(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  const hasData = data !== null;
  // First load: data regions show skeletons. Later loads refresh in place.
  const firstLoad = !hasData && !failed;
  const refreshing = loading && hasData;
  const stats = data?.stats;

  const licenseType = data?.user?.licenseType ?? shellUser?.licenseType ?? '—';
  const userName =
    data?.user?.name || emailLocalPart(data?.user?.email) || emailLocalPart(shellUser?.email);
  const totalServices = services.filter(
    (s) => s.id !== 'services-home' && !s.isSettings,
  ).length;

  const trend = stats?.apiCalls?.trend ?? 0;

  // What the person can open in the ACTIVE project (the launcher's list is the navigation's: roles, group grants,
  // custom policies and project limits, as the engine decides them). Nothing on this page links to a service
  // that is not in it, and no number is shown for a service the person cannot read (the API sends 0 for it).
  const offered = useMemo(() => new Set(services.map((s) => String(s.id))), [services]);
  const canOpen = (id: string) => offered.has(id);
  const tiles = overviewTiles(offered);

  // Progress is read from the whole project: under a date range the counts cover that range only.
  const steps = useMemo(
    () => (stats && dateFilter.period === 'total' ? getStartedSteps(services, stats) : []),
    [stats, dateFilter.period, services],
  );
  const showGetStarted = !getStartedHidden && steps.length > 0 && !getStartedComplete(steps);

  const compact = useMemo(
    () => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }),
    [locale],
  );

  const renderTile = (tile: OverviewTileId) => {
    switch (tile) {
      case 'sessions':
        return (
          <StatTile
            key={tile}
            label={t('stats.sessions')}
            icon={TILE_ICONS[tile]}
            value={stats ? stats.tracing.totalSessions.toLocaleString(locale) : '—'}
            delta={trend ? t('home.trend', { value: `${trend > 0 ? '+' : ''}${trend.toFixed(1)}` }) : undefined}
            deltaDir={trend > 0 ? 'up' : trend < 0 ? 'down' : null}
            spark={dailyLine(data?.daily, 'sessionsCount')}
            sparkColor="var(--teal-500)"
          />
        );
      case 'tokens':
        return (
          <StatTile
            key={tile}
            label={t('stats.tokens')}
            icon={TILE_ICONS[tile]}
            value={stats ? compact.format(stats.tracing.totalTokens) : '—'}
            spark={dailyLine(data?.daily, 'totalTokens')}
            sparkColor="#2a6fdb"
          />
        );
      case 'models':
        return (
          <StatTile
            key={tile}
            label={t('stats.modelsTotal')}
            icon={TILE_ICONS[tile]}
            value={stats ? stats.models.total.toLocaleString(locale) : '—'}
            delta={stats ? t('home.serviceCounts.models', { llm: stats.models.llm, embedding: stats.models.embedding }) : undefined}
          />
        );
      case 'indexes':
        return (
          <StatTile
            key={tile}
            label={t('stats.indexes')}
            icon={TILE_ICONS[tile]}
            value={stats ? stats.vectors.indexes.toLocaleString(locale) : '—'}
            delta={
              stats
                ? t(stats.vectors.providers === 1 ? 'home.serviceCounts.providerOne' : 'home.serviceCounts.providerMany', {
                    count: stats.vectors.providers,
                  })
                : undefined
            }
          />
        );
    }
  };

  /** The counts under a pinned service, in place of its description (only services the page has numbers for). */
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

  const pinnedIds = new Set(pinnedServices.map((s) => String(s.id)));
  const recentlyOpened = recentServices.filter((s) => !pinnedIds.has(String(s.id))).slice(0, 4);
  const showSessions = canOpen('tracing');

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('home.eyebrow')}
        title={userName ? t('home.welcome', { name: userName }) : t('title')}
        subtitle={<OverviewSubtitle dateFilter={dateFilter} />}
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            {canOpen('models') ? (
              <Button
                component={Link}
                href="/dashboard/models"
                color="teal"
                size="sm"
                leftSection={<IconPlus size={14} stroke={1.7} />}
              >
                {t('home.deployModel')}
              </Button>
            ) : null}
          </>
        }
      />

      {/* First steps of a new project: above the numbers, which are still zero then. */}
      {showGetStarted ? (
        <GetStarted steps={steps} onHide={hideGetStarted} style={{ marginBottom: 16 }} />
      ) : null}

      {/* Stat tiles: one per number the person can read */}
      {tiles.length > 0 || failed ? (
        <div
          style={{ position: 'relative', marginBottom: 16 }}
          aria-busy={loading || undefined}
        >
          <RefreshIndicator active={refreshing} />
          {failed ? (
            <SectionError
              message={t('statsError')}
              onRetry={retry}
              style={{ minHeight: tiles.length > 0 ? STAT_ROW_MIN_HEIGHT : undefined }}
            />
          ) : firstLoad ? (
            <StatGridSkeleton count={tiles.length} spark />
          ) : (
            // `lang`: the page's own is "en", and the upper-cased tile labels would lose their Turkish dots.
            <div className="ds-stat-grid" lang={locale}>
              {tiles.map(renderTile)}
            </div>
          )}
        </div>
      ) : null}

      {/* Open incidents (alerts service) */}
      {canOpen('alerts') ? (
        <div style={{ marginBottom: 16 }}>
          <ActiveIncidentsCard limit={5} />
        </div>
      ) : null}

      {/* The person's services, with their counts */}
      {!launcherReady ? (
        <PinnedServicesSkeleton />
      ) : pinnedServices.length > 0 ? (
        <div className="ds-card ds-card-pad-lg" style={{ marginBottom: 16 }}>
          <div className="ds-row-between" style={{ marginBottom: 14 }}>
            <div>
              <div className="ds-h3">{t('home.pinned.title')}</div>
              <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                {t('home.pinned.summary', {
                  pinned: pinnedServices.length,
                  more: Math.max(0, totalServices - pinnedServices.length),
                })}
              </div>
            </div>
            <Button
              variant="subtle"
              size="xs"
              leftSection={<IconPlus size={12} />}
              onClick={openLauncher}
            >
              {t('home.pinned.pinMore')}
            </Button>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
              gap: 10,
            }}
          >
            {pinnedServices.map((svc) => {
              const Icon = svc.icon;
              const counts = serviceCounts(String(svc.id));
              return (
                <CardLink
                  key={svc.id}
                  href={svc.href}
                  className="ds-card ds-card-pad-sm interactive"
                  style={TILE_STYLE}
                >
                  <div className="ds-row ds-gap-sm" style={{ marginBottom: 8 }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        background: 'var(--ds-accent-soft)',
                        color: 'var(--ds-accent)',
                        display: 'grid',
                        placeItems: 'center',
                      }}
                    >
                      <Icon size={16} stroke={1.7} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>
                        {tNav(svc.navLabelKey)}
                      </div>
                      <div
                        className="ds-faint"
                        style={{ fontSize: 10.5, textTransform: 'capitalize' }}
                      >
                        {svc.category}
                      </div>
                    </div>
                  </div>
                  <div
                    className={counts ? 'ds-mono' : 'ds-muted'}
                    style={counts ? { ...PINNED_DESCRIPTION_STYLE, color: 'var(--ds-text)' } : PINNED_DESCRIPTION_STYLE}
                    data-counts={counts ? svc.id : undefined}
                  >
                    {counts ?? tNav(svc.navDescriptionKey)}
                  </div>
                </CardLink>
              );
            })}
            <UnstyledButton
              onClick={openLauncher}
              className="ds-card ds-card-pad-sm interactive"
              style={{
                background: 'transparent',
                borderStyle: 'dashed',
                display: 'grid',
                placeItems: 'center',
                color: 'var(--ds-text-muted)',
              }}
            >
              <Group gap={6}>
                <IconPlus size={14} />
                <Text size="sm">{t('home.pinned.addService')}</Text>
              </Group>
            </UnstyledButton>
          </div>
          {recentlyOpened.length > 0 ? (
            <Group gap={6} mt={12} data-testid="recently-opened">
              <Text size="xs" c="dimmed">
                {t('home.recentlyOpened')}
              </Text>
              {recentlyOpened.map((svc) => (
                <Button
                  key={svc.id}
                  component={Link}
                  href={svc.href}
                  variant="default"
                  size="compact-xs"
                  radius="xl"
                >
                  {tNav(svc.navLabelKey)}
                </Button>
              ))}
            </Group>
          ) : null}
        </div>
      ) : null}

      {/* Recent agent sessions + Resources */}
      <div style={TWO_COLUMNS} className="ds-grid-two">
        {showSessions ? (
          <div
            className="ds-card ds-card-pad-lg"
            style={{ position: 'relative', overflow: 'hidden' }}
            aria-busy={loading || undefined}
          >
            <RefreshIndicator active={refreshing} />
            <div className="ds-row-between" style={{ marginBottom: 12 }}>
              <div className="ds-h3">{t('recentSessions.title')}</div>
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
              <SectionError bare message={t('activityError')} onRetry={retry} />
            ) : firstLoad ? (
              <ActivityListSkeleton rows={5} />
            ) : (
              <RecentSessionList sessions={data?.recentSessions ?? []} />
            )}
          </div>
        ) : null}

        <div
          className="ds-card ds-card-pad-lg"
          style={showSessions ? undefined : { gridColumn: '1 / -1' }}
        >
          <div className="ds-h3" style={{ marginBottom: 12 }}>
            {t('resources.title')}
          </div>
          <Stack gap="xs">
            <ResourceLink
              icon={<IconBook size={16} stroke={1.7} />}
              title={t('resources.docs')}
              description={t('resources.docsDesc')}
              href={apiDocsLink.href}
              onClick={apiDocsLink.onClick}
              external
            />
            <ResourceLink
              icon={<IconRocket size={16} stroke={1.7} />}
              title={t('resources.sdk')}
              description={t('resources.sdkDesc')}
              href={SDK_PACKAGE_URL}
              external
            />
            {canOpen('alerts') ? (
              <ResourceLink
                icon={<IconBell size={16} stroke={1.7} />}
                title={t('resources.alerts')}
                description={t('resources.alertsDesc')}
                href="/dashboard/alerts"
              />
            ) : null}
            <Group gap={8} mt={4}>
              <Text size="xs" c="dimmed">
                {t('resources.license')}
              </Text>
              <Badge variant="light" color="teal" size="sm">
                {licenseType}
              </Badge>
            </Group>
          </Stack>
        </div>
      </div>
    </PageContainer>
  );
}

/** Inline error with a retry action for a data region. */
function SectionError({
  message,
  onRetry,
  bare = false,
  style,
}: {
  message: string;
  onRetry: () => void;
  /** Render without the card chrome (inside an existing card). */
  bare?: boolean;
  style?: CSSProperties;
}) {
  const tFeedback = useTranslations('navigationFeedback');
  return (
    <div
      role="alert"
      className={bare ? undefined : 'ds-card ds-card-pad'}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: bare ? 'flex-start' : 'center',
        ...style,
      }}
    >
      <Group gap="sm" wrap="wrap">
        <IconAlertTriangle size={16} stroke={1.7} color="var(--ds-err)" />
        <Text size="sm">{message}</Text>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconRefresh size={12} stroke={1.7} />}
          onClick={onRetry}
        >
          {tFeedback('retry')}
        </Button>
      </Group>
    </div>
  );
}

function ResourceLink({
  icon,
  title,
  description,
  href,
  external = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
  /** Opens outside the app, in a new tab. */
  external?: boolean;
  /** For an external link that opens in the app instead (a docs page, in the docs panel). */
  onClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const content = (
    <>
      <ThemeIcon size={32} radius="md" variant="light" color="gray">
        {icon}
      </ThemeIcon>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {title}
        </Text>
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      </div>
      <IconChevronRight size={14} stroke={1.7} color="var(--ds-text-faint)" />
    </>
  );
  const style: CSSProperties = { ...RESOURCE_ROW_STYLE, background: 'transparent' };

  return external ? (
    <UnstyledButton
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onClick}
      className="ds-link-row"
      style={style}
    >
      {content}
    </UnstyledButton>
  ) : (
    <CardLink href={href} className="ds-link-row" style={style}>
      {content}
    </CardLink>
  );
}
