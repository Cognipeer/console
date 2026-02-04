'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Box,
  Button,
  Card,
  Grid,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconActivity,
  IconArrowUpRight,
  IconBook,
  IconBrain,
  IconDatabase,
  IconRocket,
  IconTimeline,
} from '@tabler/icons-react';
import { DataTable } from 'mantine-datatable';
import { useTranslations } from '@/lib/i18n';

export default function DashboardOverviewPage() {
  const router = useRouter();
  const t = useTranslations('dashboardOverview');

  const stats = useMemo(
    () => [
      {
        title: t('stats.apiRequests'),
        value: '—',
        icon: IconActivity,
        color: 'teal',
        trend: '—',
      },
      {
        title: t('stats.activeSessions'),
        value: '—',
        icon: IconTimeline,
        color: 'blue',
        trend: '—',
      },
      {
        title: t('stats.vectorIndexes'),
        value: '—',
        icon: IconDatabase,
        color: 'violet',
        trend: '—',
      },
      {
        title: t('stats.models'),
        value: '—',
        icon: IconBrain,
        color: 'orange',
        trend: '—',
      },
    ],
    [t],
  );

  const activity = useMemo(
    () => [] as Array<{ service: string; endpoint: string; status: string; timestamp: string }>,
    [],
  );

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

  return (
    <Stack gap="lg">
      <Paper 
        p="xl" 
        radius="lg" 
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-teal-0) 0%, var(--mantine-color-cyan-0) 100%)',
          borderColor: 'var(--mantine-color-teal-2)',
        }}
      >
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={2}>{t('title')}</Title>
            <Text size="sm" c="dimmed" mt={6}>
              {t('subtitle')}
            </Text>
          </div>
        </Group>
      </Paper>

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
                  <ThemeIcon size={16} radius="xl" variant="light" color="gray">
                    <IconArrowUpRight size={12} />
                  </ThemeIcon>
                  <Text size="xs" c="dimmed">
                    {stat.trend}
                  </Text>
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
                },
                {
                  accessor: 'status',
                  title: t('activity.table.status'),
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
                  {t('plan.status')}
                </Badge>
              </Group>
              <Stack gap="md">
                <Box>
                  <Group justify="space-between" mb={8}>
                    <Text size="sm" c="dimmed">
                      {t('plan.usage')}
                    </Text>
                    <Text size="sm" fw={500}>
                      —
                    </Text>
                  </Group>
                  <Progress value={0} color="teal" radius="xl" size="sm" />
                </Box>

                <div>
                  <Text size="sm" c="dimmed" mb="xs">
                    {t('plan.features')}
                  </Text>
                  <Group gap={6}>
                    <Badge variant="dot" color="teal" size="sm">
                      —
                    </Badge>
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
    </Stack>
  );
}
