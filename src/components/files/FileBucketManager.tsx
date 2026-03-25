'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import CreateFileBucketModal from '@/components/files/CreateFileBucketModal';
import type { FileBucketView } from '@/lib/services/files';
import { ApiError, apiRequest } from '@/lib/api/client';

function formatDate(value?: Date | string | null) {
  if (!value) {
    return '—';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

type FileBucketManagerProps = {
  onBucketClick?: (bucket: FileBucketView) => void;
  showHeader?: boolean;
  showCreateButton?: boolean;
  showRefreshButton?: boolean;
  onCreateBucketRequest?: () => void;
};

export default function FileBucketManager({
  onBucketClick,
  showHeader = true,
  showCreateButton = true,
  showRefreshButton = true,
  onCreateBucketRequest,
}: FileBucketManagerProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const queryClient = useQueryClient();

  const bucketsQuery = useQuery<FileBucketView[], ApiError>({
    queryKey: ['file-buckets'],
    queryFn: async () => {
      const response = await apiRequest<{ buckets?: FileBucketView[] }>(
        '/api/files/buckets',
      );
      return response.buckets ?? [];
    },
  });

  useEffect(() => {
    if (!bucketsQuery.isError) {
      return;
    }

    const error = bucketsQuery.error;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    notifications.show({
      color: 'red',
      title: 'Unable to load buckets',
      message,
    });
  }, [bucketsQuery.isError, bucketsQuery.error]);

  const handleBucketCreated = (bucket: FileBucketView) => {
    queryClient.setQueryData<FileBucketView[]>(['file-buckets'], (current = []) => {
      const existingIndex = current.findIndex((item) => item.key === bucket.key);
      if (existingIndex >= 0) {
        return current.map((item, index) => (index === existingIndex ? bucket : item));
      }
      return [bucket, ...current];
    });
    onBucketClick?.(bucket);
    setModalOpen(false);
  };

  const deleteBucket = useMutation({
    mutationFn: async (bucket: FileBucketView) => {
      await apiRequest(`/api/files/buckets/${encodeURIComponent(bucket.key)}`, {
        method: 'DELETE',
        parseJson: false,
      });
      return bucket;
    },
    onSuccess: (_, bucket) => {
      notifications.show({
        color: 'green',
        title: 'Bucket deleted',
        message: `${bucket.name} has been removed.`,
      });

      queryClient.setQueryData<FileBucketView[]>(['file-buckets'], (current = []) =>
        current.filter((item) => item.key !== bucket.key),
      );

      // no-op for navigation mode
    },
    onError: (error, bucket) => {
      console.error(error);
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unexpected error';
      notifications.show({
        color: 'red',
        title: 'Unable to delete bucket',
        message,
      });
      if (bucket) {
        // Ensure stale data gets refreshed on failure
        void bucketsQuery.refetch();
      }
    },
  });

  const handleDeleteBucket = async (bucket: FileBucketView) => {
    if (deleteBucket.isPending) {
      return;
    }

    const confirmed = window.confirm(
      `Delete bucket "${bucket.name}"? Files within the bucket must be removed first.`,
    );
    if (!confirmed) {
      return;
    }

    deleteBucket.mutate(bucket);
  };

  const buckets = useMemo(
    () => bucketsQuery.data ?? [],
    [bucketsQuery.data],
  );
  const isPending = bucketsQuery.isPending;
  const isRefetching = bucketsQuery.isRefetching;
  const rows = buckets;
  const bucketCount = rows.length;

  const requestCreateBucket = () => {
    if (onCreateBucketRequest) {
      onCreateBucketRequest();
      return;
    }

    setModalOpen(true);
  };

  return (
    <Stack gap="md">
      {showHeader ? (
        <Group justify="space-between" align="flex-start">
          <Stack gap={4}>
            <Group gap="xs" align="center">
              <Text fw={600}>Buckets</Text>
              <Badge size="sm" color="gray" variant="light">
                {bucketCount}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              Organize files by bucket and route them to the appropriate storage provider.
            </Text>
          </Stack>
          <Group gap="xs">
            {showRefreshButton ? (
              <Tooltip label="Refresh">
                <ActionIcon
                  variant="subtle"
                  onClick={() => void bucketsQuery.refetch()}
                  disabled={isRefetching}
                  aria-label="Refresh buckets"
                >
                  {isRefetching ? <Loader size="xs" /> : <IconRefresh size={16} />}
                </ActionIcon>
              </Tooltip>
            ) : null}

            {showCreateButton ? (
              <Button onClick={requestCreateBucket} leftSection={<IconPlus size={16} />}>
                Create bucket
              </Button>
            ) : null}
          </Group>
        </Group>
      ) : null}

      <Paper withBorder radius="md" shadow="sm">
        {isPending ? (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        ) : rows.length === 0 ? (
          <Center py="xl">
            <Stack gap="sm" align="center">
              <Text size="sm" c="dimmed">
                No buckets yet. Create one to start managing files.
              </Text>
              {showCreateButton ? (
                <Button onClick={requestCreateBucket} leftSection={<IconPlus size={16} />}>
                  Create bucket
                </Button>
              ) : null}
            </Stack>
          </Center>
        ) : (
          <Table.ScrollContainer minWidth={720} type="native">
            <Table highlightOnHover striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Provider</Table.Th>
                  <Table.Th>Prefix</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Updated</Table.Th>
                  <Table.Th style={{ width: 80 }}></Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((bucket: FileBucketView) => (
                  <Table.Tr
                    key={bucket.key}
                    onClick={() => {
                      onBucketClick?.(bucket);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onBucketClick?.(bucket);
                      }
                    }}
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                  >
                    <Table.Td>
                      <Stack gap={4}>
                        <Group gap={6}>
                          <Text fw={600}>{bucket.name}</Text>
                          <Badge size="sm" variant="light" color="gray">
                            {bucket.key}
                          </Badge>
                        </Group>
                        {bucket.description ? (
                          <Text size="xs" c="dimmed">
                            {bucket.description}
                          </Text>
                        ) : null}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {bucket.provider ? (
                        <Stack gap={4}>
                          <Group gap={6}>
                            <Text size="sm" fw={500}>
                              {bucket.provider.label}
                            </Text>
                            <Badge
                              size="sm"
                              color={bucket.provider.status === 'active' ? 'green' : 'yellow'}
                            >
                              {bucket.provider.status}
                            </Badge>
                          </Group>
                          <Text size="xs" c="dimmed">
                            Driver: {bucket.provider.driver}
                          </Text>
                        </Stack>
                      ) : (
                        <Text size="sm" c="dimmed">
                          Provider unavailable
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{bucket.prefix ?? '—'}</Table.Td>
                    <Table.Td>
                      <Badge size="sm" color={bucket.status === 'active' ? 'green' : 'yellow'}>
                        {bucket.status}
                      </Badge>
                    </Table.Td>
                    <Table.Td>{formatDate(bucket.updatedAt ?? bucket.createdAt)}</Table.Td>
                    <Table.Td>
                      <Tooltip label="Delete bucket">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label="Delete bucket"
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleDeleteBucket(bucket);
                          }}
                          disabled={deleteBucket.isPending}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>

      <CreateFileBucketModal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleBucketCreated}
      />
    </Stack>
  );
}
