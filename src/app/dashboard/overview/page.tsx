'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Box,
  Button,
  Card,
  Grid,
  Group,
  Loader,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import {
  IconActivity,
  IconArrowUpRight,
  IconArrowDownRight,
  IconBook,
  IconBrain,
  IconDatabase,
  IconRocket,
  IconTimeline,
} from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
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
  user?: { email: string; licenseType: string };
}

export default function DashboardOverviewPage() {
  const router = useRouter();
  const t = useTranslations('dashboardOverview');
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

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

  const stats = useMemo(() => {
    const s = data?.stats;
    return [
      {
        title: t('stats.apiRequests'),
        value: s ? s.apiCalls.total.toLocaleString() : '—',
        icon: IconActivity,
        color: 'teal',
        trend: s ? s.apiCalls.trend : 0,
      },
      {
        title: t('stats.activeSessions'),
        value: s ? s.tracing.activeSessions.toLocaleString() : '—',
        icon: IconTimeline,
        color: 'blue',
        trend: 0,
      },
      {
        title: t('stats.vectorIndexes'),
        value: s ? s.vectors.indexes.toLocaleString() : '—',
        icon: IconDatabase,
        color: 'violet',
        trend: 0,
      },
      {
        title: t('stats.models'),
        value: s ? s.models.total.toLocaleString() : '—',
        icon: IconBrain,
        color: 'orange',
        trend: 0,
      },
    ];
  }, [data, t]);

  const activity = useMemo(() => {
    if (!data?.recentActivity) return [];
    return data.recentActivity.map((a) => ({
      ...a,
      timestamp: new Date(a.timestamp).toLocaleString(),
    }));
  }, [data]);

  const resources = [
    {
      title: t('resources.docs'),
      description: t('resources.docsDesc'),
      icon: IconBook,
      href: '/dashboard/docs',
    },
    {
      title: t('resources.sdk'),
      description: t('resources.sdkDesc'),
      icon: IconRocket,
      href: 'https://www.npmjs.com/package/@cognipeer/agent-sdk',
    },
  ];

  const licenseType = data?.user?.licenseType ?? '—';

  return (
    <Stack gap="md">
      <PageHeader
        icon={<IconActivity size={18} />}
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <DashboardDateFilter
            value={dateFilter}
            onChange={setDateFilter}
          />
        }
      />

      {loading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            {stats.map((stat) => (
              <Card key={stat.title} padding="lg" radius="lg" withBorder>
                <Group justify="space-between" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                      {stat.title}
                    </Text>
                    <Text size="xl" fw={700} style={{ fontSize: '1.75rem', lineHeight: 1.2 }}>
                      {stat.value}
                    </Text>
                    <Group gap={4}>
                      {stat.trend !== 0 && (
                        <>
                          <ThemeIcon
                            size={16}
                            radius="xl"
                            variant="light"
                            color={stat.trend > 0 ? 'teal' : 'red'}
                          >
                            {stat.trend > 0 ? (
                              <IconArrowUpRight size={12} />
                            ) : (
                              <IconArrowDownRight size={12} />
                            )}
                          </ThemeIcon>
                          <Text size="xs" c={stat.trend > 0 ? 'teal' : 'red'}>
                            {stat.trend > 0 ? '+' : ''}
                            {stat.trend.toFixed(1)}%
                          </Text>
                        </>
                      )}
                    </Group>
                  </Stack>
                  <ThemeIcon size={48} radius="xl" variant="light" color={stat.color}>
                    <stat.icon size={24} stroke={1.5} />
                  </ThemeIcon>
                </Group>
              </Card>
            ))}
          </SimpleGrid>

          <Grid>
            <Grid.Col span={{ base: 12, lg: 8 }}>
              <Paper p="lg" radius="lg" withBorder>
                <Group justify="space-between" mb="md">
                  <div>
                    <Text fw={600} size="lg">
                      {t('activity.title')}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {t('subtitle')}
                    </Text>
                  </div>
                  <Button variant="subtle" size="xs" onClick={() => router.push('/dashboard/tracing')}>
                    {t('activity.viewAll')}
                  </Button>
                </Group>
                <DataTable
                  columns={[
                    {
                      accessor: 'service',
                      title: t('activity.table.service'),
                    },
                    {
                      accessor: 'endpoint',
                      title: t('activity.table.endpoint'),
                      render: (record) => (
                        <Text size="sm" lineClamp={1} style={{ maxWidth: 260 }}>
                          {(record as { endpoint: string }).endpoint}
                        </Text>
                      ),
                    },
                    {
                      accessor: 'status',
                      title: t('activity.table.status'),
                      render: (record) => (
                        <Badge
                          variant="light"
                          size="sm"
                          color={(record as { status: string }).status === 'success' ? 'teal' : 'red'}
                        >
                          {(record as { status: string }).status}
                        </Badge>
                      ),
                    },
                    {
                      accessor: 'timestamp',
                      title: t('activity.table.time'),
                    },
                  ]}
                  records={activity}
                  highlightOnHover
                  borderRadius="md"
                  withTableBorder={false}
                  minHeight={200}
                  noRecordsText={t('activity.empty')}
                />
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, lg: 4 }}>
              <Stack gap="lg">
                <Paper p="lg" radius="lg" withBorder>
                  <Group justify="space-between" mb="md">
                    <Text fw={600} size="lg">
                      {t('plan.title')}
                    </Text>
                    <Badge variant="light" color="teal" size="sm">
                      {licenseType}
                    </Badge>
                  </Group>
                  <Stack gap="md">
                    <Box>
                      <Group justify="space-between" mb={8}>
                        <Text size="sm" c="dimmed">
                          {t('plan.usage')}
                        </Text>
                        <Text size="sm" fw={500}>
                          {data?.stats.apiCalls.total.toLocaleString() ?? '—'}
                        </Text>
                      </Group>
                      <Progress
                        value={Math.min((data?.stats.apiCalls.total ?? 0) / 100, 100)}
                        color="teal"
                        radius="xl"
                        size="sm"
                      />
                    </Box>

                    <div>
                      <Text size="sm" c="dimmed" mb="xs">
                        {t('plan.features')}
                      </Text>
                      <Group gap={6}>
                        {(data?.stats.models.total ?? 0) > 0 && (
                          <Badge variant="dot" color="teal" size="sm">
                            {data!.stats.models.total} Models
                          </Badge>
                        )}
                        {(data?.stats.vectors.indexes ?? 0) > 0 && (
                          <Badge variant="dot" color="violet" size="sm">
                            {data!.stats.vectors.indexes} Indexes
                          </Badge>
                        )}
                        {(data?.stats.tracing.totalSessions ?? 0) > 0 && (
                          <Badge variant="dot" color="blue" size="sm">
                            {data!.stats.tracing.totalSessions} Sessions
                          </Badge>
                        )}
                        {!data && (
                          <Badge variant="dot" color="gray" size="sm">
                            —
                          </Badge>
                        )}
                      </Group>
                    </div>
                  </Stack>
                </Paper>

                <Paper p="lg" radius="lg" withBorder>
                  <Text fw={600} size="lg" mb="md">
                    {t('resources.title')}
                  </Text>
                  <Stack gap="xs">
                    {resources.map((resource) => (
                      <Paper
                        key={resource.title}
                        p="sm"
                        radius="md"
                        withBorder
                        style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                        onClick={() =>
                          resource.href.startsWith('http')
                            ? window.open(resource.href, '_blank')
                            : router.push(resource.href)
                        }
                      >
                        <Group gap="sm">
                          <ThemeIcon size={32} radius="md" variant="light" color="gray">
                            <resource.icon size={16} />
                          </ThemeIcon>
                          <Stack gap={0} style={{ flex: 1 }}>
                            <Text size="sm" fw={500}>
                              {resource.title}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {resource.description}
                            </Text>
                          </Stack>
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                </Paper>
              </Stack>
            </Grid.Col>
          </Grid>
        </>
      )}
    </Stack>
  );
}
