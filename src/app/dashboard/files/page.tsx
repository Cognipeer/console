'use client';

import { useMemo, useState } from 'react';
import {
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconBook,
  IconCloud,
  IconFiles,
  IconFolder,
  IconPlus,
  IconRefresh,
} from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import CreateFileBucketModal from '@/components/files/CreateFileBucketModal';
import FileBucketManager from '@/components/files/FileBucketManager';
import { getModuleDocId } from '@/lib/docs/sdkDocs';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';
import { ApiError, apiRequest } from '@/lib/api/client';
import type { FileBucketView } from '@/lib/services/files';

export default function FilesDashboardPage() {
  const router = useRouter();
  const { openDocs } = useDocsDrawer();
  const queryClient = useQueryClient();
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const bucketsQuery = useQuery<FileBucketView[], ApiError>({
    queryKey: ['file-buckets'],
    queryFn: async () => {
      const response = await apiRequest<{ buckets?: FileBucketView[] }>('/api/files/buckets');
      return response.buckets ?? [];
    },
  });

  const buckets = useMemo(() => bucketsQuery.data ?? [], [bucketsQuery.data]);
  const bucketCount = buckets.length;
  const activeBucketCount = useMemo(
    () => buckets.filter((bucket) => bucket.status === 'active').length,
    [buckets],
  );
  const providerCount = useMemo(() => {
    const keys = new Set<string>();
    buckets.forEach((bucket) => {
      if (bucket.provider?.key) {
        keys.add(bucket.provider.key);
      }
    });
    return keys.size;
  }, [buckets]);

  const handleRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['file-buckets'] });
  };

  const handleBucketCreated = (bucket: FileBucketView) => {
    queryClient.setQueryData<FileBucketView[]>(['file-buckets'], (current = []) => {
      const existingIndex = current.findIndex((item) => item.key === bucket.key);
      if (existingIndex >= 0) {
        return current.map((item, index) => (index === existingIndex ? bucket : item));
      }
      return [bucket, ...current];
    });
    router.push(`/dashboard/files/${encodeURIComponent(bucket.key)}`);
  };

  return (
    <Stack gap="lg">
      {/* Header */}
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background: 'linear-gradient(135deg, var(--mantine-color-cyan-0) 0%, var(--mantine-color-teal-0) 100%)',
          borderColor: 'var(--mantine-color-cyan-2)',
        }}>
        <Group justify="space-between" align="flex-start">
          <Group gap="md">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'cyan', to: 'teal', deg: 135 }}>
              <IconFolder size={26} />
            </ThemeIcon>
            <div>
              <Title order={2}>File Buckets</Title>
              <Text size="sm" c="dimmed" mt={4}>
                View and manage storage buckets connected to your tenant.
              </Text>
            </div>
          </Group>

          <Group gap="xs">
            <Button
              variant="light"
              leftSection={<IconBook size={16} />}
              onClick={() => openDocs(getModuleDocId('files'))}
            >
              Docs
            </Button>
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={() => void handleRefresh()}
              loading={bucketsQuery.isFetching}
            >
              Refresh
            </Button>
            <Button
              onClick={() => setCreateModalOpen(true)}
              leftSection={<IconPlus size={16} />}
              variant="gradient"
              gradient={{ from: 'cyan', to: 'teal', deg: 90 }}
            >
              Create bucket
            </Button>
          </Group>
        </Group>
      </Paper>

      {/* Simple Analytics */}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Buckets
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {bucketCount}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="cyan">
              <IconFolder size={24} />
            </ThemeIcon>
          </Group>
        </Paper>

        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Active buckets
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }} c="teal">
                {activeBucketCount}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="teal">
              <IconCloud size={24} />
            </ThemeIcon>
          </Group>
        </Paper>

        <Paper withBorder radius="lg" p="lg">
          <Group justify="space-between">
            <Stack gap={4}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: '0.5px' }}>
                Providers used
              </Text>
              <Text fw={700} size="xl" style={{ fontSize: '1.75rem' }}>
                {providerCount}
              </Text>
            </Stack>
            <ThemeIcon size={48} radius="xl" variant="light" color="blue">
              <IconFiles size={24} />
            </ThemeIcon>
          </Group>
        </Paper>
      </SimpleGrid>

      {/* Bucket Manager */}
      <Paper p="lg" radius="lg" withBorder>
        <Group justify="space-between" mb="md">
          <div>
            <Text fw={600} size="lg">Your Buckets</Text>
            <Text size="sm" c="dimmed">Click on a bucket to browse its contents</Text>
          </div>
        </Group>
        <FileBucketManager
          showHeader={false}
          onCreateBucketRequest={() => setCreateModalOpen(true)}
          onBucketClick={(bucket) => {
            router.push(`/dashboard/files/${encodeURIComponent(bucket.key)}`);
          }}
        />
      </Paper>

      <CreateFileBucketModal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onCreated={handleBucketCreated}
      />
    </Stack>
  );
}
