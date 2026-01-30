'use client';

import { useEffect, useMemo, useState } from 'react';
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
} from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { useTranslations } from '@/lib/i18n';

interface User {
  name: string;
  email: string;
  licenseType: string;
  features: string[];
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [mounted, setMounted] = useState(false);
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');

  useEffect(() => {
    setMounted(true);
    const checkAuth = async () => {
      try {
        const mockUser: User = {
          name: t('mockUser.name'),
          email: t('mockUser.email'),
          licenseType: t('mockUser.licenseType'),
          features: [
            t('mockUser.features.llmChat'),
            t('mockUser.features.agentOrchestration'),
            t('mockUser.features.analytics'),
          ],
        };
        setUser(mockUser);
      } catch {
        router.push('/login');
      }
    };

    checkAuth();
  }, [router, t]);

  const stats = useMemo(
    () => [
      {
        title: t('stats.apiRequests'),
        value: '12,453',
        icon: IconActivity,
        color: 'teal',
        trend: '+12.5%',
        trendUp: true,
        description: 'vs. last month',
      },
      {
        title: t('stats.activeAgents'),
        value: '8',
        icon: IconRobot,
        color: 'blue',
        trend: '+2',
        trendUp: true,
        description: 'agents running',
      },
      {
        title: t('stats.vectorStores'),
        value: '3',
        icon: IconDatabase,
        color: 'violet',
        trend: '2.4GB',
        trendUp: null,
        description: 'total storage',
      },
      {
        title: t('stats.llmCalls'),
        value: '8,921',
        icon: IconBrain,
        color: 'orange',
        trend: '+8.2%',
        trendUp: true,
        description: 'vs. last month',
      },
    ],
    [t],
  );

  const quickActions = useMemo(
    () => [
      {
        title: 'Configure Models',
        description: 'Add or manage LLM providers',
        icon: IconBrain,
        color: 'blue',
        href: '/dashboard/models',
      },
      {
        title: 'Vector Indexes',
        description: 'Create and query vector stores',
        icon: IconDatabase,
        color: 'violet',
        href: '/dashboard/vector',
      },
      {
        title: 'Agent Tracing',
        description: 'Monitor agent sessions',
        icon: IconChartBar,
        color: 'teal',
        href: '/dashboard/tracing',
      },
      {
        title: 'API Tokens',
        description: 'Manage access credentials',
        icon: IconKey,
        color: 'orange',
        href: '/dashboard/settings',
      },
    ],
    [],
  );

  const recentActivity = useMemo(
    () => [
      {
        id: 1,
        service: t('recentActivity.items.llmChat.service'),
        endpoint: '/api/llm/chat',
        status: tCommon('status.success'),
        timestamp: t('recentActivity.items.llmChat.timestamp'),
      },
      {
        id: 2,
        service: t('recentActivity.items.agentRun.service'),
        endpoint: '/api/agents/execute',
        status: tCommon('status.success'),
        timestamp: t('recentActivity.items.agentRun.timestamp'),
      },
      {
        id: 3,
        service: t('recentActivity.items.vectorQuery.service'),
        endpoint: '/api/vectors/search',
        status: tCommon('status.success'),
        timestamp: t('recentActivity.items.vectorQuery.timestamp'),
      },
      {
        id: 4,
        service: t('recentActivity.items.embeddings.service'),
        endpoint: '/api/llm/embeddings',
        status: tCommon('status.success'),
        timestamp: t('recentActivity.items.embeddings.timestamp'),
      },
      {
        id: 5,
        service: t('recentActivity.items.analytics.service'),
        endpoint: '/api/analytics/report',
        status: tCommon('status.success'),
        timestamp: t('recentActivity.items.analytics.timestamp'),
      },
    ],
    [t, tCommon],
  );

  const resources = [
    {
      title: 'API Documentation',
      description: 'Learn how to integrate with our APIs',
      icon: IconBook,
      href: '#',
    },
    {
      title: 'SDK Examples',
      description: 'Code samples for quick start',
      icon: IconCode,
      href: '#',
    },
    {
      title: 'Agent SDK',
      description: 'Instrument your agents',
      icon: IconRocket,
      href: 'https://www.npmjs.com/package/@cognipeer/agent-sdk',
    },
  ];

  if (!user) {
    return (
      <Stack gap="lg">
        <Skeleton height={100} radius="md" />
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={120} radius="md" />
          ))}
        </SimpleGrid>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      {/* Welcome Hero Section */}
      <Transition mounted={mounted} transition="fade" duration={400}>
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
            mounted={mounted}
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
                className="hover-lift"
              >
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
            <Text fw={600} size="lg">Quick Actions</Text>
            <Text size="sm" c="dimmed">Jump to common tasks</Text>
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
              className="hover-lift"
            >
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
                <Text size="sm" c="dimmed">Latest API calls and events</Text>
              </div>
              <Button
                variant="subtle"
                size="xs"
                rightSection={<IconChevronRight size={14} />}
                onClick={() => router.push('/dashboard/tracing')}>
                View All
              </Button>
            </Group>
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
          </Paper>
        </Grid.Col>

        {/* Right Column */}
        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Stack gap="lg">
            {/* Plan Card */}
            <Paper p="lg" radius="lg" withBorder>
              <Group justify="space-between" mb="md">
                <Text fw={600} size="lg">{t('plan.title')}</Text>
                <Badge variant="light" color="teal" size="sm">Active</Badge>
              </Group>
              <Stack gap="md">
                <Box>
                  <Group justify="space-between" mb={8}>
                    <Text size="sm" c="dimmed">API Usage</Text>
                    <Text size="sm" fw={500}>75%</Text>
                  </Group>
                  <Progress value={75} color="teal" radius="xl" size="sm" />
                </Box>
                
                <Divider />
                
                <div>
                  <Text size="sm" c="dimmed" mb="xs">
                    {t('plan.featuresLabel')}
                  </Text>
                  <Group gap={6}>
                    {user.features.slice(0, 3).map((feature) => (
                      <Badge key={feature} variant="dot" color="teal" size="sm">
                        {feature.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                    {user.features.length > 3 && (
                      <Badge variant="light" color="gray" size="sm">
                        +{user.features.length - 3}
                      </Badge>
                    )}
                  </Group>
                </div>

                <Button
                  variant="light"
                  fullWidth
                  rightSection={<IconArrowUpRight size={16} />}>
                  {t('plan.upgradeCta')}
                </Button>
              </Stack>
            </Paper>

            {/* Resources */}
            <Paper p="lg" radius="lg" withBorder>
              <Text fw={600} size="lg" mb="md">Resources</Text>
              <Stack gap="xs">
                {resources.map((resource) => (
                  <Paper
                    key={resource.title}
                    p="sm"
                    radius="md"
                    withBorder
                    style={{ cursor: 'pointer', transition: 'all 0.2s ease' }}
                    onClick={() => resource.href.startsWith('http') ? window.open(resource.href, '_blank') : router.push(resource.href)}>
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
