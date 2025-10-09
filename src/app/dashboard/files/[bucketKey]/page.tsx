'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconRefresh } from '@tabler/icons-react';
import FileObjectManager from '@/components/files/FileObjectManager';
import type { FileBucketView } from '@/lib/services/files';

function safeString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export default function FileBucketDetailPage() {
  const params = useParams();
  const router = useRouter();
  const bucketKeyParam = params.bucketKey;
  const bucketKey = useMemo(
    () => (Array.isArray(bucketKeyParam) ? bucketKeyParam[0] : bucketKeyParam) ?? '',
    [bucketKeyParam],
  );

  const [bucket, setBucket] = useState<FileBucketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadBucket = useCallback(async () => {
    if (!bucketKey) {
      setBucket(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    setRefreshing(true);
    try {
      const response = await fetch(`/api/files/buckets/${encodeURIComponent(bucketKey)}`, {
        cache: 'no-store',
      });

      if (!response.ok) {
        if (response.status === 404) {
          notifications.show({
            color: 'red',
            title: 'Bucket not found',
            message: 'The requested bucket is no longer available.',
          });
          router.push('/dashboard/files');
          return;
        }

        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to load bucket');
      }

      const data = await response.json();
      setBucket((data.bucket as FileBucketView | null) ?? null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load bucket',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [bucketKey, router]);

  useEffect(() => {
    void loadBucket();
  }, [loadBucket]);

  if (loading) {
    return (
      <Center py="xl">
        <Loader size="sm" />
      </Center>
    );
  }

  if (!bucket) {
    return (
      <Center py="xl">
        <Stack gap="sm" align="center">
          <Text c="dimmed">Bucket not found.</Text>
          <Button leftSection={<IconArrowLeft size={16} />} onClick={() => router.push('/dashboard/files')}>
            Back to buckets
          </Button>
        </Stack>
      </Center>
    );
  }

  const providerLabel = safeString(bucket.provider?.label);
  const providerDriver = safeString(bucket.provider?.driver);

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <Group gap="xs" align="flex-start">
          <ActionIcon variant="light" onClick={() => router.push('/dashboard/files')}>
            <IconArrowLeft size={16} />
          </ActionIcon>
          <Stack gap={4}>
            <Group gap={8} align="center">
              <Title order={2}>{bucket.name}</Title>
              <Badge color={bucket.status === 'active' ? 'green' : 'yellow'}>{bucket.status}</Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Bucket key: {bucket.key}
            </Text>
          </Stack>
        </Group>
        <Tooltip label="Refresh">
          <ActionIcon
            variant="subtle"
            onClick={() => void loadBucket()}
            disabled={refreshing}
            aria-label="Refresh bucket"
          >
            {refreshing ? <Loader size="xs" /> : <IconRefresh size={16} />}
          </ActionIcon>
        </Tooltip>
      </Group>

      <Paper withBorder radius="md" shadow="sm" p="md">
        <Stack gap="sm">
          {safeString(bucket.description) ? (
            <Text size="sm">{bucket.description}</Text>
          ) : null}
          <Group gap="lg" wrap="wrap">
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                Prefix:
              </Text>
              <Text size="xs">{bucket.prefix ?? '—'}</Text>
            </Group>
            <Group gap={6}>
              <Text size="xs" c="dimmed">
                Status:
              </Text>
              <Badge size="sm" color={bucket.status === 'active' ? 'green' : 'yellow'}>
                {bucket.status}
              </Badge>
            </Group>
            {providerLabel ? (
              <Group gap={6}>
                <Text size="xs" c="dimmed">
                  Provider:
                </Text>
                <Badge size="sm" color={bucket.provider?.status === 'active' ? 'green' : 'yellow'}>
                  {providerLabel}
                </Badge>
                {providerDriver ? (
                  <Text size="xs" c="dimmed">
                    Driver: {providerDriver}
                  </Text>
                ) : null}
              </Group>
            ) : null}
          </Group>
        </Stack>
      </Paper>

      <FileObjectManager bucket={bucket} />
    </Stack>
  );
}
