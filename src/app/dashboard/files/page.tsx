'use client';

import { useCallback, useEffect, useState } from 'react';
import { Group, Loader, Stack, Text, Paper, ThemeIcon, SimpleGrid, Badge, Center } from '@mantine/core';
import { IconFolder, IconCloud, IconFiles, IconCheck, IconBan, IconChartBar } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import FileBucketManager from '@/components/files/FileBucketManager';
import PageHeader from '@/components/layout/PageHeader';
import DashboardDateFilter from '@/components/layout/DashboardDateFilter';
import {
  buildDashboardDateSearchParams,
  defaultDashboardDateFilter,
} from '@/lib/utils/dashboardDateFilter';

interface FilesDashboardData {
  overview: { totalBuckets: number; activeBuckets: number; disabledBuckets: number };
  providerBreakdown: Array<{ providerKey: string; count: number; active: number }>;
  recentBuckets: Array<{ key: string; name: string; providerKey: string; status: string; createdAt: string }>;
}

export default function FilesDashboardPage() {
  const router = useRouter();
  const [dashboardData, setDashboardData] = useState<FilesDashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(defaultDashboardDateFilter);

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const params = buildDashboardDateSearchParams(dateFilter);
      const res = await fetch(`/api/files/dashboard?${params.toString()}`, { cache: 'no-store' });
      if (res.ok) setDashboardData(await res.json() as FilesDashboardData);
    } catch (err) {
      console.error('Failed to load files dashboard', err);
    } finally {
      setDashboardLoading(false);
    }
  }, [dateFilter]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  return (
    <Stack gap="md">
      {/* Header */}
      <PageHeader
        icon={<IconFolder size={18} />}
        title="File Buckets"
        subtitle="View and manage storage buckets connected to your tenant."
        actions={<DashboardDateFilter value={dateFilter} onChange={setDateFilter} />}
      />

      {/* Stats Overview */}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Total Buckets</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {dashboardLoading ? <Loader size="xs" /> : (dashboardData?.overview.totalBuckets ?? '—')}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="cyan"><IconFiles size={24} /></ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Active</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {dashboardLoading ? <Loader size="xs" /> : (dashboardData?.overview.activeBuckets ?? '—')}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal"><IconCheck size={24} /></ThemeIcon>
          </Group>
        </Paper>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>Disabled</Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="gray">
                {dashboardLoading ? <Loader size="xs" /> : (dashboardData?.overview.disabledBuckets ?? '—')}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="gray"><IconBan size={24} /></ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Analytics Panel */}
      {!dashboardLoading && dashboardData && dashboardData.overview.totalBuckets > 0 && (
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {/* Provider Breakdown */}
          <Paper withBorder radius="lg" p="lg">
            <Group gap="sm" mb="md">
              <ThemeIcon size={28} radius="md" variant="light" color="cyan"><IconCloud size={14} /></ThemeIcon>
              <Text fw={600} size="sm">By Provider</Text>
            </Group>
            {dashboardData.providerBreakdown.length === 0 ? (
              <Center py="sm"><Text size="sm" c="dimmed">No data</Text></Center>
            ) : (
              <Stack gap="xs">
                {dashboardData.providerBreakdown.map((p) => (
                  <Group key={p.providerKey} justify="space-between">
                    <Group gap="xs">
                      <ThemeIcon size={20} radius="md" variant="light" color="gray"><IconCloud size={10} /></ThemeIcon>
                      <Text size="sm" tt="uppercase" fw={500}>{p.providerKey}</Text>
                    </Group>
                    <Group gap="xs">
                      <Badge size="sm" variant="light" color="cyan">{p.count} total</Badge>
                      <Badge size="sm" variant="light" color="teal">{p.active} active</Badge>
                    </Group>
                  </Group>
                ))}
              </Stack>
            )}
          </Paper>

          {/* Recent Buckets */}
          <Paper withBorder radius="lg" p="lg">
            <Group gap="sm" mb="md">
              <ThemeIcon size={28} radius="md" variant="light" color="teal"><IconChartBar size={14} /></ThemeIcon>
              <Text fw={600} size="sm">Recently Added</Text>
            </Group>
            {dashboardData.recentBuckets.length === 0 ? (
              <Center py="sm"><Text size="sm" c="dimmed">No data</Text></Center>
            ) : (
              <Stack gap="sm">
                {dashboardData.recentBuckets.map((b) => (
                  <Group key={b.key} justify="space-between" wrap="nowrap"
                    style={{ cursor: 'pointer' }}
                    onClick={() => router.push(`/dashboard/files/${encodeURIComponent(b.key)}`)}
                  >
                    <Stack gap={2}>
                      <Text size="sm" fw={500}>{b.name}</Text>
                      <Badge size="xs" variant="light" color="gray">{b.providerKey}</Badge>
                    </Stack>
                    <Badge size="sm" variant="light" color={b.status === 'active' ? 'teal' : 'gray'}>{b.status}</Badge>
                  </Group>
                ))}
              </Stack>
            )}
          </Paper>
        </SimpleGrid>
      )}

      {/* Bucket Manager */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <div>
            <Text fw={600} size="lg">Your Buckets</Text>
            <Text size="sm" c="dimmed">Click on a bucket to browse its contents</Text>
          </div>
        </Group>
        <FileBucketManager
          onBucketClick={(bucket) => {
            router.push(`/dashboard/files/${encodeURIComponent(bucket.key)}`);
          }}
        />
      </Paper>
    </Stack>
  );
}
