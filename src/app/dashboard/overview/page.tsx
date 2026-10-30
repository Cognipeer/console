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
import { SkeletonText, StatGridSkeleton } from '@/components/common/ui/Skeletons';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import { CardLink } from '@/components/dashboard/CardLink';
import { useDocLink } from '@/components/docs/DocsDrawerContext';
import {
  ActivityListSkeleton,
  PinnedServicesSkeleton,
} from '@/components/dashboard/OverviewSkeletons';
import ActiveIncidentsCard from '@/components/alerts/ActiveIncidentsCard';
import { QuickStart } from '@/components/dashboard/QuickStart';
import { quickStartTiles } from '@/components/dashboard/quickStartModel';
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowRight,
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

interface DashboardStats {
  models: { total: number; llm: number; embedding: number };
  vectors: { providers: number; indexes: number };
  tracing: { totalSessions: number; totalTokens: number; activeSessions: number };
  apiCalls: { total: number; trend: number };
}

interface RecentActivity {
  id: string;
  type: string;
  service: string;
  endpoint: string;
  status: 'success' | 'error' | 'cancelled';
  timestamp: string;
}

interface DashboardData {
  stats: DashboardStats;
  recentActivity: RecentActivity[];
  user?: { name?: string; email: string; licenseType: string };
}

// Soft mock sparkline data — until the API surfaces time-series
const sparkSeries = (seed: number, length = 16, base = 40, vol = 12) =>
  Array.from({ length }, (_, i) =>
    Math.max(0, base + Math.sin((seed + i) * 0.6) * vol + (i / length) * 8),
  );

const SPARK_CALLS = sparkSeries(1, 16, 60, 18);
const SPARK_LAT = sparkSeries(2, 16, 420, 30);
const SPARK_SESSIONS = sparkSeries(3, 16, 28, 8);
const SPARK_INDEXES = sparkSeries(4, 16, 12, 4);

const SDK_PACKAGE_URL = 'https://www.npmjs.com/package/@cognipeer/agent-sdk';

// Height of a stat row with sparklines; keeps the error state in place.
const STAT_ROW_MIN_HEIGHT = 134;

const TILE_STYLE: CSSProperties = { background: 'var(--ds-surface-1)', textAlign: 'left' };

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
  const { pinnedServices, services, openLauncher, hydrated } = useLauncher();
  // Pinned services are restored from local storage after mount.
  const launcherReady = hydrated !== false;

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

  const activity = useMemo(() => {
    if (!data?.recentActivity) return [];
    return data.recentActivity.slice(0, 6).map((a) => ({
      ...a,
      relTime: formatRelativeTime(new Date(a.timestamp), t, locale),
    }));
  }, [data, t, locale]);

  const hasData = data !== null;
  // First load: data regions show skeletons. Later loads refresh in place.
  const firstLoad = !hasData && !failed;
  const refreshing = loading && hasData;

  const licenseType = data?.user?.licenseType ?? shellUser?.licenseType ?? '—';
  const userName =
    data?.user?.name || emailLocalPart(data?.user?.email) || emailLocalPart(shellUser?.email);
  const totalServices = services.filter(
    (s) => s.id !== 'services-home' && !s.isSettings,
  ).length;

  const trend = data?.stats?.apiCalls?.trend ?? 0;

  // What the person can open in the ACTIVE project (the launcher's list is the navigation's: roles, group grants,
  // custom policies and project limits, as the engine decides them). Nothing on this page links to a service
  // that is not in it.
  const offered = useMemo(() => new Set(services.map((s) => String(s.id))), [services]);
  const canOpen = (id: string) => offered.has(id);
  const tiles = useMemo(() => quickStartTiles(services), [services]);

  /** Quick links with their counts, for the services the person can open. */
  const topResources = [
    {
      service: 'models',
      icon: <IconBrain size={15} stroke={1.7} />,
      label: t('home.topResources.models'),
      href: '/dashboard/models',
      value: data ? data.stats.models.total : null,
      hint: data
        ? t('home.topResources.modelsHint', { llm: data.stats.models.llm, embedding: data.stats.models.embedding })
        : '—',
    },
    {
      service: 'vector',
      icon: <IconDatabase size={15} stroke={1.7} />,
      label: t('home.topResources.vectorIndexes'),
      href: '/dashboard/vector',
      value: data ? data.stats.vectors.indexes : null,
      hint: data
        ? t(data.stats.vectors.providers === 1 ? 'home.topResources.providerOne' : 'home.topResources.providerMany', {
            count: data.stats.vectors.providers,
          })
        : '—',
    },
    {
      service: 'tracing',
      icon: <IconActivity size={15} stroke={1.7} />,
      label: t('home.topResources.traceSessions'),
      href: '/dashboard/tracing',
      value: data ? data.stats.tracing.totalSessions : null,
      hint: data ? t('home.topResources.tokens', { count: data.stats.tracing.totalTokens.toLocaleString(locale) }) : '—',
    },
  ].filter((resource) => canOpen(resource.service));

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('home.eyebrow')}
        title={userName ? t('home.welcome', { name: userName }) : t('title')}
        subtitle={
          <>
            {t(totalServices === 1 ? 'home.summaryOne' : 'home.summary', {
              pinned: launcherReady ? pinnedServices.length : '–',
              total: totalServices,
            })}{' '}
            ·{' '}
            <span className="ds-mono">{licenseType}</span>
          </>
        }
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

      {/* Stat tiles */}
      <div
        style={{ position: 'relative', marginBottom: 16 }}
        aria-busy={loading || undefined}
      >
        <RefreshIndicator active={refreshing} />
        {failed ? (
          <SectionError
            message={t('statsError')}
            onRetry={retry}
            style={{ minHeight: STAT_ROW_MIN_HEIGHT }}
          />
        ) : firstLoad ? (
          <StatGridSkeleton count={4} spark />
        ) : (
          // `lang`: the page's own is "en", and the upper-cased tile labels would lose their Turkish dots.
          <div className="ds-stat-grid" lang={locale}>
            <StatTile
              label={t('stats.apiRequests')}
              icon={<IconBolt size={14} stroke={1.7} />}
              value={data?.stats.apiCalls.total.toLocaleString() ?? '—'}
              delta={trend ? t('home.trend', { value: `${trend > 0 ? '+' : ''}${trend.toFixed(1)}` }) : undefined}
              deltaDir={trend > 0 ? 'up' : trend < 0 ? 'down' : null}
              spark={SPARK_CALLS}
              sparkColor="var(--teal-500)"
            />
            <StatTile
              label={t('stats.activeSessions')}
              icon={<IconTimeline size={14} stroke={1.7} />}
              value={data?.stats.tracing.activeSessions.toLocaleString() ?? '—'}
              spark={SPARK_SESSIONS}
              sparkColor="#2a6fdb"
            />
            <StatTile
              label={t('stats.vectorIndexes')}
              icon={<IconDatabase size={14} stroke={1.7} />}
              value={data?.stats.vectors.indexes.toLocaleString() ?? '—'}
              spark={SPARK_INDEXES}
              sparkColor="#7c3aed"
            />
            <StatTile
              label={t('stats.models')}
              icon={<IconBrain size={14} stroke={1.7} />}
              value={data?.stats.models.total.toLocaleString() ?? '—'}
              spark={SPARK_LAT}
              sparkColor="#c97a16"
            />
          </div>
        )}
      </div>

      {/* Pinned services launcher */}
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
                  <div className="ds-muted" style={PINNED_DESCRIPTION_STYLE}>
                    {tNav(svc.navDescriptionKey)}
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
        </div>
      ) : null}

      {/* Open incidents (alerts service) */}
      {canOpen('alerts') ? (
        <div style={{ marginBottom: 16 }}>
          <ActiveIncidentsCard limit={5} />
        </div>
      ) : null}

      {/* Quick start + Activity */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 16,
          marginBottom: 16,
        }}
        className="ds-grid-two"
      >
        <QuickStart tiles={tiles} />

        <div
          className="ds-card ds-card-pad-lg"
          style={{
            position: 'relative',
            overflow: 'hidden',
            // Without the quick-start card beside it, the activity takes the whole row.
            ...(tiles.length === 0 ? { gridColumn: '1 / -1' } : {}),
          }}
          aria-busy={loading || undefined}
        >
          <RefreshIndicator active={refreshing} />
          <div className="ds-row-between" style={{ marginBottom: 12 }}>
            <div className="ds-h3">{t('home.activityHeading')}</div>
            {canOpen('tracing') ? (
              <Button
                component={Link}
                href="/dashboard/tracing"
                variant="subtle"
                size="xs"
                rightSection={<IconChevronRight size={12} />}
              >
                {t('activity.viewAll')}
              </Button>
            ) : null}
          </div>
          {failed ? (
            <SectionError bare message={t('activityError')} onRetry={retry} />
          ) : firstLoad ? (
            <ActivityListSkeleton />
          ) : (
            <Stack gap="xs">
              {activity.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('activity.empty')}
                </Text>
              ) : (
                activity.map((a) => (
                  <div
                    key={a.id}
                    className="ds-row"
                    style={{ gap: 10, padding: '4px 0', fontSize: 13 }}
                  >
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: '50%',
                        background:
                          a.status === 'success'
                            ? 'linear-gradient(135deg, var(--teal-500), var(--teal-4))'
                            : 'var(--ds-surface-2)',
                        color: 'white',
                        display: 'grid',
                        placeItems: 'center',
                        fontSize: 11,
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {a.service.charAt(0).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>
                      <span style={{ fontWeight: 500 }}>{a.service}</span>{' '}
                      <span className="ds-muted">{a.type}</span>{' '}
                      <span className="ds-mono" style={{ fontSize: 12.5 }}>
                        {a.endpoint}
                      </span>
                    </div>
                    <StatusBadge status={a.status} />
                    <span className="ds-faint" style={{ fontSize: 11.5 }}>
                      {a.relTime}
                    </span>
                  </div>
                ))
              )}
            </Stack>
          )}
        </div>
      </div>

      {/* Plan + Resources */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
          gap: 16,
        }}
        className="ds-grid-two"
      >
        {topResources.length > 0 ? (
          <div className="ds-card ds-card-pad-lg">
            <div className="ds-row-between" style={{ marginBottom: 14 }}>
              <div>
                <div className="ds-h3">{t('home.topResources.title')}</div>
                <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {t('home.topResources.subtitle')}
                </div>
              </div>
              {canOpen('models') ? (
                <Button
                  component={Link}
                  href="/dashboard/models"
                  variant="subtle"
                  size="xs"
                  rightSection={<IconArrowRight size={12} />}
                >
                  {t('home.topResources.allModels')}
                </Button>
              ) : null}
            </div>
            <Stack gap="xs">
              {topResources.map((resource) => (
                <ResourceRow key={resource.service} pending={firstLoad} {...resource} />
              ))}
            </Stack>
          </div>
        ) : null}

        <div
          className="ds-card ds-card-pad-lg"
          style={topResources.length === 0 ? { gridColumn: '1 / -1' } : undefined}
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
            <div style={{ marginTop: 4 }}>
              <Text size="xs" c="dimmed" mb={6}>
                {t('plan.title')}
              </Text>
              <Group gap={6}>
                <Badge variant="light" color="teal" size="sm">
                  {licenseType}
                </Badge>
                {(data?.stats.models.total ?? 0) > 0 ? (
                  <Badge variant="dot" color="teal" size="sm">
                    {t('home.planModels', { count: data!.stats.models.total })}
                  </Badge>
                ) : null}
                {(data?.stats.vectors.indexes ?? 0) > 0 ? (
                  <Badge variant="dot" color="violet" size="sm">
                    {t('home.planIndexes', { count: data!.stats.vectors.indexes })}
                  </Badge>
                ) : null}
              </Group>
            </div>
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

function ResourceRow({
  icon,
  label,
  value,
  hint,
  href,
  pending = false,
}: {
  icon: ReactNode;
  label: string;
  /** `null` when the value is unavailable. */
  value: number | null;
  hint: string;
  href: string;
  /** First load: draw placeholders for the data-driven parts. */
  pending?: boolean;
}) {
  return (
    <CardLink
      href={href}
      className="ds-link-row"
      style={{ ...RESOURCE_ROW_STYLE, background: 'var(--ds-surface-1)' }}
    >
      <ThemeIcon size={32} radius="md" variant="light" color="teal">
        {icon}
      </ThemeIcon>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Text size="xs" c="dimmed" component="div">
          {pending ? <SkeletonText width="55%" /> : hint}
        </Text>
      </div>
      <Text size="lg" fw={600} className="ds-mono" component="div">
        {pending ? <SkeletonText width={28} /> : value === null ? '—' : value.toLocaleString()}
      </Text>
      <IconChevronRight size={14} stroke={1.7} color="var(--ds-text-faint)" />
    </CardLink>
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

function formatRelativeTime(
  date: Date,
  t: (key: string, values?: Record<string, string | number>) => string,
  locale: string,
) {
  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('home.ago.justNow');
  if (min < 60) return t('home.ago.minutes', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('home.ago.hours', { count: hr });
  const days = Math.floor(hr / 24);
  if (days < 30) return t('home.ago.days', { count: days });
  return date.toLocaleDateString(locale);
}
