'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Container,
  Grid,
  Card,
  Title,
  Badge,
  SimpleGrid,
  Stack,
  Group,
  Text,
  Paper,
} from '@mantine/core';
import {
  IconRobot,
  IconDatabase,
  IconBrain,
  IconActivity,
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
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');

  useEffect(() => {
    // In a real app, you'd fetch user data from an API endpoint
    // For now, we'll just check if the user is logged in
    const checkAuth = async () => {
      try {
        // This would be replaced with actual user info endpoint
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
      } catch (error) {
        router.push('/login');
      }
    };

    checkAuth();
  }, [router]);

  const stats = useMemo(
    () => [
      {
        title: t('stats.apiRequests'),
        value: '12,453',
        icon: IconActivity,
        color: 'blue',
      },
      {
        title: t('stats.activeAgents'),
        value: '8',
        icon: IconRobot,
        color: 'green',
      },
      {
        title: t('stats.vectorStores'),
        value: '3',
        icon: IconDatabase,
        color: 'violet',
      },
      {
        title: t('stats.llmCalls'),
        value: '8,921',
        icon: IconBrain,
        color: 'orange',
      },
    ],
    [t],
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

  if (!user) {
    return null;
  }

  return (
    <Stack gap="md">
      <div>
        <Title order={2} mb="xs">
          {t('hero.title', { name: user.name })}
        </Title>
        <Text c="dimmed">{t('hero.subtitle')}</Text>
      </div>

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        {stats.map((stat) => (
          <Card
            key={stat.title}
            shadow="sm"
            padding="lg"
            radius="md"
            withBorder>
            <Group justify="space-between">
              <div>
                <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                  {stat.title}
                </Text>
                <Text size="xl" fw={700} mt="xs">
                  {stat.value}
                </Text>
              </div>
              <stat.icon
                size={32}
                color={`var(--mantine-color-${stat.color}-6)`}
              />
            </Group>
          </Card>
        ))}
      </SimpleGrid>

      <Grid>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Paper shadow="sm" p="lg" radius="md" withBorder>
            <Title order={3} mb="md">
              {t('recentActivity.title')}
            </Title>
            <DataTable
              columns={[
                {
                  accessor: 'service',
                  title: t('recentActivity.table.service'),
                },
                {
                  accessor: 'endpoint',
                  title: t('recentActivity.table.endpoint'),
                },
                {
                  accessor: 'status',
                  title: t('recentActivity.table.status'),
                  render: (record) => (
                    <Badge
                      color={
                        record.status === tCommon('status.success')
                          ? 'green'
                          : 'red'
                      }>
                      {record.status}
                    </Badge>
                  ),
                },
                {
                  accessor: 'timestamp',
                  title: t('recentActivity.table.time'),
                },
              ]}
              records={recentActivity}
              highlightOnHover
            />
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper shadow="sm" p="lg" radius="md" withBorder>
            <Title order={3} mb="md">
              {t('plan.title')}
            </Title>
            <Stack gap="md">
              <div>
                <Text size="sm" c="dimmed">
                  {t('plan.licenseLabel')}
                </Text>
                <Badge size="lg" variant="filled" mt="xs">
                  {user.licenseType}
                </Badge>
              </div>

              <div>
                <Text size="sm" c="dimmed" mb="xs">
                  {t('plan.featuresLabel')}
                </Text>
                <Stack gap="xs">
                  {user.features.map((feature) => (
                    <Badge key={feature} variant="light" size="sm">
                      {feature.replace(/_/g, ' ')}
                    </Badge>
                  ))}
                </Stack>
              </div>

              <Button variant="light" fullWidth mt="md">
                {t('plan.upgradeCta')}
              </Button>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
