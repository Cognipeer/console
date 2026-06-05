'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Group,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import LoadingState from '@/components/common/LoadingState';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import { useLauncher } from '@/components/layout/launcher/LauncherContext';
import PageContainer, { PageHeader } from '@/components/common/ui/PageContainer';
import StatTile from '@/components/common/ui/StatTile';
import StatusBadge from '@/components/common/ui/StatusBadge';
import {
  IconActivity,
  IconArrowRight,
  IconBolt,
  IconBook,
  IconBrain,
  IconChevronRight,
  IconDatabase,
  IconDownload,
  IconPlus,
  IconRobot,
  IconRocket,
  IconSparkles,
  IconTimeline,
} from '@tabler/icons-react';
import { useTranslations } from '@/lib/i18n';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

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
  status: 'success' | 'error';
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

export default function DashboardOverviewPage() {
  const router = useRouter();
  const t = useTranslations('dashboardOverview');
  const tNav = useTranslations('navigation');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);
  const { pinnedServices, services, openLauncher } = useLauncher();

  const fetchDashboard = useCallback(async () => {
    try {
      setLoading(true);
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/dashboard?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const activity = useMemo(() => {
    if (!data?.recentActivity) return [];
    return data.recentActivity.slice(0, 6).map((a) => ({
      ...a,
      relTime: formatRelativeTime(new Date(a.timestamp)),
    }));
  }, [data]);

  const licenseType = data?.user?.licenseType ?? '—';
  const userName = data?.user?.name
    || (data?.user?.email ? data.user.email.split('@')[0] : null);
  const totalServices = services.filter((s) => s.id !== 'services-home').length;

  const trend = data?.stats?.apiCalls?.trend ?? 0;

  const quickStart = [
    {
      step: '01',
      icon: IconBrain,
      title: 'Deploy a model',
      desc: 'Choose a provider and create an inference endpoint.',
      href: '/dashboard/models',
    },
    {
      step: '02',
      icon: IconSparkles,
      title: 'Publish a prompt',
      desc: 'Version-controlled templates with test cases.',
      href: '/dashboard/prompts',
    },
    {
      step: '03',
      icon: IconRobot,
      title: 'Wire up an agent',
      desc: 'Connect tools and memory into a runnable agent.',
      href: '/dashboard/agents',
    },
  ];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Overview"
        title={userName ? `Welcome back, ${userName}` : t('title')}
        subtitle={
          <>
            {pinnedServices.length} pinned · {totalServices} services available ·{' '}
            <span className="ds-mono">{licenseType}</span>
          </>
        }
        actions={
          <>
            <DashboardDateFilter value={dateFilter} onChange={setDateFilter} />
            <Button
              variant="default"
              size="sm"
              leftSection={<IconDownload size={14} stroke={1.7} />}
            >
              Export
            </Button>
            <Button
              color="teal"
              size="sm"
              leftSection={<IconPlus size={14} stroke={1.7} />}
              onClick={() => router.push('/dashboard/models')}
            >
              Deploy model
            </Button>
          </>
        }
      />

      {/* Stat tiles */}
      {loading ? (
        <LoadingState
          label={t('commonLoading', { defaultValue: 'Loading dashboard overview...' })}
          minHeight={260}
        />
      ) : (
        <>
          <div className="ds-stat-grid" style={{ marginBottom: 16 }}>
            <StatTile
              label={t('stats.apiRequests')}
              icon={<IconBolt size={14} stroke={1.7} />}
              value={data?.stats.apiCalls.total.toLocaleString() ?? '—'}
              delta={trend ? `${trend > 0 ? '+' : ''}${trend.toFixed(1)}% vs last 24h` : undefined}
              deltaDir={trend > 0 ? 'up' : trend < 0 ? 'down' : null}
              spark={SPARK_CALLS}
              sparkColor="var(--teal-6)"
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

          {/* Pinned services launcher */}
          {pinnedServices.length > 0 ? (
            <div className="ds-card ds-card-pad-lg" style={{ marginBottom: 16 }}>
              <div className="ds-row-between" style={{ marginBottom: 14 }}>
                <div>
                  <div className="ds-h3">Your pinned services</div>
                  <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    {pinnedServices.length} pinned ·{' '}
                    {Math.max(0, totalServices - pinnedServices.length)} more available
                  </div>
                </div>
                <Button
                  variant="subtle"
                  size="xs"
                  leftSection={<IconPlus size={12} />}
                  onClick={openLauncher}
                >
                  Pin more
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
                    <UnstyledButton
                      key={svc.id}
                      onClick={() => router.push(svc.href)}
                      className="ds-card ds-card-pad-sm interactive"
                      style={{ background: 'var(--ds-surface-1)', textAlign: 'left' }}
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
                        className="ds-muted"
                        style={{ fontSize: 11.5, lineHeight: 1.4 }}
                      >
                        {tNav(svc.navDescriptionKey)}
                      </div>
                    </UnstyledButton>
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
                    <Text size="sm">Add service</Text>
                  </Group>
                </UnstyledButton>
              </div>
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
            <div className="ds-card ds-card-pad-lg">
              <div className="ds-row-between" style={{ marginBottom: 14 }}>
                <div className="ds-h3">Get started</div>
                <Text size="xs" c="dimmed">
                  Quick paths into your project
                </Text>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                  gap: 12,
                }}
              >
                {quickStart.map((s) => {
                  const Icon = s.icon;
                  return (
                    <UnstyledButton
                      key={s.step}
                      onClick={() => router.push(s.href)}
                      className="ds-card ds-card-pad-sm interactive"
                      style={{ background: 'var(--ds-surface-1)', textAlign: 'left' }}
                    >
                      <div className="ds-row ds-gap-sm" style={{ marginBottom: 10 }}>
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
                        <span className="ds-eyebrow">Step {s.step}</span>
                      </div>
                      <div className="ds-h4" style={{ marginBottom: 4 }}>
                        {s.title}
                      </div>
                      <div
                        className="ds-muted"
                        style={{ fontSize: 12.5, lineHeight: 1.45 }}
                      >
                        {s.desc}
                      </div>
                    </UnstyledButton>
                  );
                })}
              </div>
            </div>

            <div className="ds-card ds-card-pad-lg">
              <div className="ds-row-between" style={{ marginBottom: 12 }}>
                <div className="ds-h3">Activity</div>
                <Button
                  variant="subtle"
                  size="xs"
                  rightSection={<IconChevronRight size={12} />}
                  onClick={() => router.push('/dashboard/tracing')}
                >
                  {t('activity.viewAll')}
                </Button>
              </div>
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
                              ? 'linear-gradient(135deg, var(--teal-6), var(--teal-4))'
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
                      <StatusBadge status={a.status === 'success' ? 'ok' : 'err'} />
                      <span className="ds-faint" style={{ fontSize: 11.5 }}>
                        {a.relTime}
                      </span>
                    </div>
                  ))
                )}
              </Stack>
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
            <div className="ds-card ds-card-pad-lg">
              <div className="ds-row-between" style={{ marginBottom: 14 }}>
                <div>
                  <div className="ds-h3">Top resources</div>
                  <div className="ds-muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                    Quick links into your build surface
                  </div>
                </div>
                <Button
                  variant="subtle"
                  size="xs"
                  rightSection={<IconArrowRight size={12} />}
                  onClick={() => router.push('/dashboard/models')}
                >
                  All models
                </Button>
              </div>
              <Stack gap="xs">
                <ResourceRow
                  icon={<IconBrain size={15} stroke={1.7} />}
                  label="Models"
                  value={data?.stats.models.total ?? 0}
                  hint={`${data?.stats.models.llm ?? 0} LLM · ${data?.stats.models.embedding ?? 0} embedding`}
                  onClick={() => router.push('/dashboard/models')}
                />
                <ResourceRow
                  icon={<IconDatabase size={15} stroke={1.7} />}
                  label="Vector indexes"
                  value={data?.stats.vectors.indexes ?? 0}
                  hint={`${data?.stats.vectors.providers ?? 0} provider${(data?.stats.vectors.providers ?? 0) === 1 ? '' : 's'}`}
                  onClick={() => router.push('/dashboard/vector')}
                />
                <ResourceRow
                  icon={<IconActivity size={15} stroke={1.7} />}
                  label="Trace sessions"
                  value={data?.stats.tracing.totalSessions ?? 0}
                  hint={`${(data?.stats.tracing.totalTokens ?? 0).toLocaleString()} tokens`}
                  onClick={() => router.push('/dashboard/tracing')}
                />
              </Stack>
            </div>

            <div className="ds-card ds-card-pad-lg">
              <div className="ds-h3" style={{ marginBottom: 12 }}>
                Resources
              </div>
              <Stack gap="xs">
                <ResourceLink
                  icon={<IconBook size={16} stroke={1.7} />}
                  title={t('resources.docs')}
                  description={t('resources.docsDesc')}
                  onClick={() => router.push('/dashboard/docs')}
                />
                <ResourceLink
                  icon={<IconRocket size={16} stroke={1.7} />}
                  title={t('resources.sdk')}
                  description={t('resources.sdkDesc')}
                  onClick={() =>
                    window.open(
                      'https://www.npmjs.com/package/@cognipeer/agent-sdk',
                      '_blank',
                      'noopener,noreferrer',
                    )
                  }
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
                        {data!.stats.models.total} Models
                      </Badge>
                    ) : null}
                    {(data?.stats.vectors.indexes ?? 0) > 0 ? (
                      <Badge variant="dot" color="violet" size="sm">
                        {data!.stats.vectors.indexes} Indexes
                      </Badge>
                    ) : null}
                  </Group>
                </div>
              </Stack>
            </div>
          </div>
        </>
      )}
    </PageContainer>
  );
}

function ResourceRow({
  icon,
  label,
  value,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: 'var(--ds-surface-1)',
        border: '1px solid var(--ds-border-soft)',
        borderRadius: 'var(--ds-r-sm)',
        cursor: 'pointer',
      }}
    >
      <ThemeIcon size={32} radius="md" variant="light" color="teal">
        {icon}
      </ThemeIcon>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        {hint ? (
          <Text size="xs" c="dimmed">
            {hint}
          </Text>
        ) : null}
      </div>
      <Text size="lg" fw={600} className="ds-mono">
        {value.toLocaleString()}
      </Text>
      <IconChevronRight size={14} stroke={1.7} color="var(--ds-text-faint)" />
    </UnstyledButton>
  );
}

function ResourceLink({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick?: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        border: '1px solid var(--ds-border-soft)',
        borderRadius: 'var(--ds-r-sm)',
        background: 'transparent',
        cursor: 'pointer',
      }}
    >
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
    </UnstyledButton>
  );
}

function formatRelativeTime(date: Date) {
  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
