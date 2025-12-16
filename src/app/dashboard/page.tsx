'use client';

import { useMemo, type ComponentType } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Grid,
  Card,
  Title,
  Badge,
  SimpleGrid,
  Stack,
  Group,
  Text,
  Paper,
  Box,
  ThemeIcon,
  Progress,
  Transition,
  Skeleton,
  Divider,
  Alert,
} from '@mantine/core';
import {
  IconRobot,
  IconDatabase,
  IconBrain,
  IconActivity,
  IconArrowUpRight,
  IconArrowDownRight,
  IconSparkles,
  IconKey,
  IconChevronRight,
  IconCode,
  IconChartBar,
  IconRocket,
  IconBook,
  IconExternalLink,
  IconAlertCircle,
  IconVectorBezier,
} from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from '@/lib/i18n';
import type { SdkDocId } from '@/lib/docs/sdkDocs';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

interface User {
  name: string;
  email: string;
  licenseType: string;
  features: string[];
}

interface DashboardStats {
  models: {
    total: number;
    llm: number;
    embedding: number;
  };
  vectors: {
    providers: number;
    indexes: number;
  };
  tracing: {
    totalSessions: number;
    totalTokens: number;
    activeSessions: number;
  };
  apiCalls: {
    total: number;
    trend: number;
  };
}

interface RecentActivity {
  id: string;
  type: 'chat' | 'embedding' | 'vector' | 'agent';
  service: string;
  endpoint: string;
  status: 'success' | 'error';
  timestamp: string;
  details?: string;
}

interface DashboardData {
  stats: DashboardStats;
  recentActivity: RecentActivity[];
  recentSessions: any[];
  daily: Array<{
    date: string;
    sessionsCount: number;
    totalTokens: number;
  }>;
  user?: {
    email: string;
    licenseType: string;
  };
}

export default function DashboardPage() {
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');

  // Fetch dashboard data using React Query - automatically refreshes when project changes
  const { data: dashboardData, isLoading: loading, error: queryError, refetch } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const response = await fetch('/api/dashboard');
      if (!response.ok) {
        throw new Error('Failed to fetch dashboard data');
      }
      return response.json();
    },
    refetchOnMount: 'always',
    staleTime: 30000, // 30 seconds
  });

  const error = queryError instanceof Error ? queryError.message : queryError ? 'Unknown error' : null;

  // Build user object from API response or translations
  const user: User = useMemo(() => ({
    name: dashboardData?.user?.email?.split('@')[0] || t('mockUser.name'),
    email: dashboardData?.user?.email || t('mockUser.email'),
    licenseType: dashboardData?.user?.licenseType || t('mockUser.licenseType'),
    features: [
      t('mockUser.features.llmChat'),
      t('mockUser.features.agentOrchestration'),
      t('mockUser.features.analytics'),
    ],
  }), [dashboardData?.user, t]);

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const stats = useMemo(() => {
    const data = dashboardData?.stats;
    return [
      {
        title: t('stats.apiRequests'),
        value: data ? formatNumber(data.apiCalls.total) : '—',
        icon: IconActivity,
        color: 'teal',
        trend: data && data.apiCalls.trend !== 0 ? `${data.apiCalls.trend > 0 ? '+' : ''}${data.apiCalls.trend}%` : null,
        trendUp: data ? data.apiCalls.trend > 0 : null,
        description: t('stats.vsLastWeek'),
      },
      {
        title: t('stats.activeAgents'),
        value: data ? data.tracing.activeSessions.toString() : '—',
        icon: IconRobot,
        color: 'blue',
        trend: data ? `${data.tracing.totalSessions} total` : null,
        trendUp: null,
        description: t('stats.agentsRunning'),
      },
      {
        title: t('stats.vectorStores'),
        value: data ? data.vectors.indexes.toString() : '—',
        icon: IconVectorBezier,
        color: 'violet',
        trend: data ? `${data.vectors.providers} providers` : null,
        trendUp: null,
        description: t('stats.totalIndexes'),
      },
      {
        title: t('stats.llmModels'),
        value: data ? data.models.total.toString() : '—',
        icon: IconBrain,
        color: 'orange',
        trend: data ? `${data.models.llm} LLM, ${data.models.embedding} emb.` : null,
        trendUp: null,
        description: t('stats.configuredModels'),
      },
    ];
  }, [dashboardData, t]);

  const quickActions = useMemo(
    () => [
      {
        title: t('quickActions.configureModels'),
        description: t('quickActions.configureModelsDesc'),
        icon: IconBrain,
        color: 'blue',
        href: '/dashboard/models',
      },
      {
        title: t('quickActions.vectorIndexes'),
        description: t('quickActions.vectorIndexesDesc'),
        icon: IconDatabase,
        color: 'violet',
        href: '/dashboard/vector',
      },
      {
        title: t('quickActions.agentTracing'),
        description: t('quickActions.agentTracingDesc'),
        icon: IconChartBar,
        color: 'teal',
        href: '/dashboard/tracing',
      },
      {
        title: t('quickActions.apiTokens'),
        description: t('quickActions.apiTokensDesc'),
        icon: IconKey,
        color: 'orange',
        href: '/dashboard/settings',
      },
    ],
    [t],
  );

  const recentActivity = useMemo(() => {
    if (!dashboardData?.recentActivity?.length) {
      return [];
    }
    return dashboardData.recentActivity.map((activity) => ({
      id: activity.id,
      service: activity.service,
      endpoint: activity.endpoint,
      status: activity.status === 'error' ? tCommon('status.error') : tCommon('status.success'),
      timestamp: new Date(activity.timestamp).toLocaleString(),
    }));
  }, [dashboardData, tCommon]);

  const resources: Array<{
    title: string;
    description: string;
    icon: ComponentType<{ size?: number }>;
    docId?: SdkDocId;
    href?: string;
  }> = [
    {
      title: t('resources.apiDocs'),
      description: t('resources.apiDocsDesc'),
      icon: IconBook,
      docId: 'api-client',
    },
    {
      title: t('resources.sdkExamples'),
      description: t('resources.sdkExamplesDesc'),
      icon: IconCode,
      docId: 'examples-chat',
    },
  ];

  if (loading) {
    return (
      <Stack gap="lg">
        <Skeleton height={100} radius="md" />
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={120} radius="md" />
          ))}
        </SimpleGrid>
        <Skeleton height={200} radius="md" />
      </Stack>
    );
  }

  if (error) {
    return (
      <Stack gap="lg">
        <Alert icon={<IconAlertCircle size={16} />} title={t('error.title')} color="red">
          {error}
        </Alert>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      {/* Welcome Hero Section */}
      <Transition mounted transition="fade" duration={400}>
        {(styles) => (
          <Paper
            style={{
              ...styles,
              background:
                'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-blue-0) 100%)',
              borderColor: 'var(--mantine-color-teal-2)',
              position: 'relative',
              overflow: 'hidden',
            }}
            p="xl"
            radius="lg"
            withBorder
          >
            <Box
              style={{
                position: 'absolute',
                top: -50,
                right: -50,
                width: 200,
                height: 200,
                borderRadius: '50%',
                background: 'var(--mantine-color-teal-1)',
                opacity: 0.5,
              }}
            />
            <Box
              style={{
                position: 'absolute',
                bottom: -30,
                right: 100,
                width: 100,
                height: 100,
                borderRadius: '50%',
                background: 'var(--mantine-color-blue-1)',
                opacity: 0.5,
              }}
            />
            <Group justify="space-between" align="flex-start" style={{ position: 'relative', zIndex: 1 }}>
              <Stack gap="xs">
                <Group gap="sm">
                  <ThemeIcon
                    size={44}
                    radius="xl"
                    variant="gradient"
                    gradient={{ from: 'teal', to: 'blue', deg: 135 }}>
                    <IconSparkles size={24} />
                  </ThemeIcon>
                  <div>
                    <Title order={2} fw={700}>
                      {t('hero.title', { name: user.name })}
                    </Title>
                    <Text c="dimmed" size="sm">
                      {t('hero.subtitle')}
                    </Text>
                  </div>
                </Group>
              </Stack>
              <Group gap="xs">
                <Badge
                  size="lg"
                  variant="gradient"
                  gradient={{ from: 'teal', to: 'cyan', deg: 90 }}
                  leftSection={<IconRocket size={14} />}>
                  {user.licenseType}
                </Badge>
              </Group>
            </Group>
          </Paper>
        )}
      </Transition>

      {/* Stats Grid */}
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {stats.map((stat, index) => (
          <Transition
            key={stat.title}
            mounted
            transition="slide-up"
            duration={400}
            timingFunction="ease"
            enterDelay={index * 50}>
            {(styles) => (
              <Card
                style={styles}
                padding="lg"
                radius="lg"
                withBorder
                className="hover-lift">
                <Group justify="space-between" align="flex-start">
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                      {stat.title}
                    </Text>
                    <Text size="xl" fw={700} style={{ fontSize: '1.75rem', lineHeight: 1.2 }}>
                      {stat.value}
                    </Text>
                    <Group gap={4}>
                      {stat.trendUp !== null && (
                        <ThemeIcon
                          size={16}
                          radius="xl"
                          variant="light"
                          color={stat.trendUp ? 'teal' : 'red'}>
                          {stat.trendUp ? (
                            <IconArrowUpRight size={12} />
                          ) : (
                            <IconArrowDownRight size={12} />
                          )}
                        </ThemeIcon>
                      )}
                      <Text size="xs" c={stat.trendUp ? 'teal' : stat.trendUp === false ? 'red' : 'dimmed'} fw={500}>
                        {stat.trend}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {stat.description}
                      </Text>
                    </Group>
                  </Stack>
                  <ThemeIcon
                    size={48}
                    radius="xl"
                    variant="light"
                    color={stat.color}>
                    <stat.icon size={24} stroke={1.5} />
                  </ThemeIcon>
                </Group>
              </Card>
            )}
          </Transition>
        ))}
      </SimpleGrid>

      {/* Quick Actions */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <div>
            <Text fw={600} size="lg">{t('quickActions.title')}</Text>
            <Text size="sm" c="dimmed">{t('quickActions.subtitle')}</Text>
          </div>
        </Group>
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          {quickActions.map((action) => (
            <Paper
              key={action.title}
              p="md"
              radius="md"
              withBorder
              onClick={() => router.push(action.href)}
              style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
              className="hover-lift">
              <Group gap="sm">
                <ThemeIcon size={40} radius="md" variant="light" color={action.color}>
                  <action.icon size={20} />
                </ThemeIcon>
                <Stack gap={2} style={{ flex: 1 }}>
                  <Text size="sm" fw={600}>
                    {action.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {action.description}
                  </Text>
                </Stack>
                <IconChevronRight size={16} color="var(--mantine-color-dimmed)" />
              </Group>
            </Paper>
          ))}
        </SimpleGrid>
      </Paper>

      <Grid>
        {/* Recent Activity */}
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Paper p="lg" radius="lg" withBorder>
            <Group justify="space-between" mb="md">
              <div>
                <Text fw={600} size="lg">{t('recentActivity.title')}</Text>
                <Text size="sm" c="dimmed">{t('recentActivity.subtitle')}</Text>
              </div>
              <Button
                variant="subtle"
                size="xs"
                rightSection={<IconChevronRight size={14} />}
                onClick={() => router.push('/dashboard/tracing')}>
                {t('recentActivity.viewAll')}
              </Button>
            </Group>
            {recentActivity.length === 0 ? (
              <Text c="dimmed" ta="center" py="xl">
                {t('recentActivity.empty')}
              </Text>
            ) : (
            <DataTable
              columns={[
                {
                  accessor: 'service',
                  title: t('recentActivity.table.service'),
                  render: (record) => (
                    <Group gap="xs">
                      <ThemeIcon size={24} radius="md" variant="light" color="gray">
                        <IconActivity size={14} />
                      </ThemeIcon>
                      <Text size="sm" fw={500}>{record.service}</Text>
                    </Group>
                  ),
                },
                {
                  accessor: 'endpoint',
                  title: t('recentActivity.table.endpoint'),
                  render: (record) => (
                    <Text size="xs" ff="monospace" c="dimmed">
                      {record.endpoint}
                    </Text>
                  ),
                },
                {
                  accessor: 'status',
                  title: t('recentActivity.table.status'),
                  render: (record) => (
                    <Badge
                      size="sm"
                      variant="light"
                      color={
                        record.status === tCommon('status.success')
                          ? 'teal'
                          : 'red'
                      }>
                      {record.status}
                    </Badge>
                  ),
                },
                {
                  accessor: 'timestamp',
                  title: t('recentActivity.table.time'),
                  render: (record) => (
                    <Text size="xs" c="dimmed">{record.timestamp}</Text>
                  ),
                },
              ]}
              records={recentActivity}
              highlightOnHover
              borderRadius="md"
              withTableBorder={false}
              rowStyle={() => ({
                '&:hover': {
                  backgroundColor: 'var(--mantine-color-gray-0)',
                },
              })}
            />
            )}
          </Paper>
        </Grid.Col>

        {/* Right Column */}
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Stack gap="lg">
            {/* Usage Summary Card */}
            <Paper p="lg" radius="lg" withBorder>
              <Group justify="space-between" mb="md">
                <Text fw={600} size="lg">{t('usage.title')}</Text>
                <Badge variant="light" color="teal" size="sm">{t('usage.active')}</Badge>
              </Group>
              <Stack gap="md">
                <Box>
                  <Group justify="space-between" mb={8}>
                    <Text size="sm" c="dimmed">{t('usage.totalTokens')}</Text>
                    <Text size="sm" fw={500}>
                      {dashboardData?.stats.tracing.totalTokens 
                        ? formatNumber(dashboardData.stats.tracing.totalTokens) 
                        : '0'}
                    </Text>
                  </Group>
                  <Progress 
                    value={Math.min((dashboardData?.stats.tracing.totalTokens || 0) / 10000, 100)} 
                    color="teal" 
                    radius="xl" 
                    size="sm" 
                  />
                </Box>
                
                <Divider />
                
                <div>
                  <Text size="sm" c="dimmed" mb="xs">
                    {t('usage.summary')}
                  </Text>
                  <Stack gap={4}>
                    <Group justify="space-between">
                      <Text size="xs">{t('usage.totalSessions')}</Text>
                      <Text size="xs" fw={500}>{dashboardData?.stats.tracing.totalSessions || 0}</Text>
                    </Group>
                    <Group justify="space-between">
                      <Text size="xs">{t('usage.modelsConfigured')}</Text>
                      <Text size="xs" fw={500}>{dashboardData?.stats.models.total || 0}</Text>
                    </Group>
                    <Group justify="space-between">
                      <Text size="xs">{t('usage.vectorIndexes')}</Text>
                      <Text size="xs" fw={500}>{dashboardData?.stats.vectors.indexes || 0}</Text>
                    </Group>
                  </Stack>
                </div>

                <Button
                  variant="light"
                  fullWidth
                  rightSection={<IconChevronRight size={16} />}
                  onClick={() => router.push('/dashboard/settings')}>
                  {t('usage.viewDetails')}
                </Button>
              </Stack>
            </Paper>

            {/* Resources */}
            <Paper p="lg" radius="lg" withBorder>
              <Text fw={600} size="lg" mb="md">{t('resources.title')}</Text>
              <Stack gap="xs">
                {resources.map((resource) => (
                  <Paper
                    key={resource.title}
                    p="sm"
                    radius="md"
                    withBorder
                    style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                    onClick={() => {
                      if (resource.docId) {
                        openDocs(resource.docId);
                        return;
                      }
                      if (!resource.href) {
                        return;
                      }
                      if (resource.href.startsWith('http')) {
                        window.open(resource.href, '_blank');
                        return;
                      }
                      router.push(resource.href);
                    }}>
                    <Group gap="sm">
                      <ThemeIcon size={32} radius="md" variant="light" color="gray">
                        <resource.icon size={16} />
                      </ThemeIcon>
                      <Stack gap={0} style={{ flex: 1 }}>
                        <Text size="sm" fw={500}>{resource.title}</Text>
                        <Text size="xs" c="dimmed">{resource.description}</Text>
                      </Stack>
                      <IconExternalLink size={14} color="var(--mantine-color-dimmed)" />
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
