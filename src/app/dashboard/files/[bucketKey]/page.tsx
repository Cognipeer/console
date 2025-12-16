'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  ThemeIcon,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconRefresh, IconBook, IconFolder } from '@tabler/icons-react';
import FileObjectManager from '@/components/files/FileObjectManager';
import type { FileBucketView } from '@/lib/services/files';
import { useDocsDrawer } from '@/components/docs/DocsDrawerContext';

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
  const { openDocs } = useDocsDrawer();
  const bucketKeyParam = params.bucketKey;
  const bucketKey = useMemo(
    () => (Array.isArray(bucketKeyParam) ? bucketKeyParam[0] : bucketKeyParam) ?? '',
    [bucketKeyParam],
  );

  const [bucket, setBucket] = useState<FileBucketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadBucket = useCallback(async (isRefresh = false) => {
    if (!bucketKey) {
      setBucket(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
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
    void loadBucket(false);
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
    <Stack gap="lg">
      <Paper
        p="xl"
        radius="lg"
        withBorder
        style={{
          background:
            'linear-gradient(135deg, var(--mantine-color-cyan-0) 0%, var(--mantine-color-teal-0) 100%)',
          borderColor: 'var(--mantine-color-cyan-2)',
        }}
      >
        <Group justify="space-between" align="flex-start">
          <Group gap="md" align="flex-start">
            <ThemeIcon
              size={50}
              radius="xl"
              variant="gradient"
              gradient={{ from: 'cyan', to: 'teal', deg: 135 }}
            >
              <IconFolder size={26} />
            </ThemeIcon>
            <div>
              <Group gap={8} align="center">
                <Title order={2}>{bucket.name}</Title>
                <Badge color={bucket.status === 'active' ? 'green' : 'yellow'}>{bucket.status}</Badge>
              </Group>
              <Text size="sm" c="dimmed" mt={4}>
                Bucket key: {bucket.key}
              </Text>
            </div>
          </Group>
          <Group gap="xs">
            <Button
              onClick={() => openDocs('api-files')}
              variant="light"
              leftSection={<IconBook size={16} />}
            >
              Docs
            </Button>
            <Button
              variant="light"
              leftSection={<IconRefresh size={16} />}
              onClick={() => void loadBucket(true)}
              loading={refreshing}
            >
              Refresh
            </Button>
          </Group>
        </Group>
      </Paper>

      <Paper withBorder radius="lg" p="lg">
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
