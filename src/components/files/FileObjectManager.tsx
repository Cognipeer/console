'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Center,
  Checkbox,
  FileInput,
  Group,
  Loader,
  Modal,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  IconCloudDownload,
  IconFileCheck,
  IconFileDownload,
  IconRefresh,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  FileBucketView,
  FileRecordView,
  ListFilesResponse,
  UploadFileResponse,
} from '@/lib/services/files';
import { ApiError, apiRequest } from '@/lib/api/client';

interface FileObjectManagerProps {
  bucket?: FileBucketView | null;
}

type UploadFormValues = {
  file: File | null;
  name: string;
  contentType: string;
  convertToMarkdown: boolean;
};

function formatBytes(size: number | undefined): string {
  if (!size || Number.isNaN(size)) {
    return '—';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value?: Date | string | null) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  return date.toLocaleString();
}

function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reader.abort();
      reject(new Error('Failed to read file.'));
    };
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.readAsDataURL(file);
  });
}

export default function FileObjectManager({ bucket }: FileObjectManagerProps) {
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const bucketKey = bucket?.key ?? null;

  const form = useForm<UploadFormValues>({
    initialValues: {
      file: null,
      name: '',
      contentType: '',
      convertToMarkdown: true,
    },
    validate: {
      file: (value) => (value ? null : 'Choose a file to upload'),
      name: (value) => (value.trim().length > 0 ? null : 'Name is required'),
    },
  });

  type FilesPage = { items: FileRecordView[]; nextCursor?: string };

  const filesQuery = useInfiniteQuery<FilesPage, ApiError>({
    queryKey: ['file-objects', bucketKey],
    enabled: Boolean(bucketKey),
    queryFn: async ({ pageParam }) => {
      if (!bucketKey) {
        return { items: [], nextCursor: undefined };
      }

      const params = new URLSearchParams();
      params.set('limit', '50');
      if (pageParam) {
        params.set('cursor', String(pageParam));
      }

      const response = await apiRequest<ListFilesResponse>(
        `/api/files/buckets/${encodeURIComponent(bucketKey)}/objects?${params.toString()}`,
      );

      return {
        items: response.items ?? [],
        nextCursor: response.nextCursor,
      };
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchOnMount: 'always',
    initialPageParam: undefined,
  });

  useEffect(() => {
    if (!filesQuery.isError) {
      return;
    }

    const error = filesQuery.error;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    notifications.show({
      color: 'red',
      title: 'Unable to load files',
      message,
    });
  }, [filesQuery.isError, filesQuery.error]);

  const records = useMemo(() => {
    if (!filesQuery.data) {
      return [] as FileRecordView[];
    }
    return filesQuery.data.pages.flatMap((page) => page.items ?? []);
  }, [filesQuery.data]);
  const recordCount = bucket ? records.length : 0;
  const isInitialLoading = filesQuery.isPending && Boolean(bucketKey);
  const isRefetching = filesQuery.isRefetching;
  const isFetchingNextPage = filesQuery.isFetchingNextPage;
  const hasNextPage = Boolean(filesQuery.hasNextPage);

  type UploadVariables = { bucketKey: string; values: UploadFormValues };
  type UploadResult = { bucketKey: string; record: FileRecordView; fileName: string };

  const uploadMutation = useMutation<UploadResult, Error | ApiError, UploadVariables>({
    mutationFn: async ({ bucketKey, values }) => {
      const file = values.file;
      if (!file) {
        throw new Error('Choose a file to upload');
      }

      const dataUrl = await fileToDataUrl(file);
      const body = {
        fileName: values.name.trim(),
        contentType: values.contentType || file.type,
        data: dataUrl,
        convertToMarkdown: values.convertToMarkdown,
        metadata: {
          originalFileName: file.name,
          lastModified: file.lastModified,
        },
        bucketKey,
      };

      const response = await apiRequest<UploadFileResponse>(
        `/api/files/buckets/${encodeURIComponent(bucketKey)}/objects`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );

      if (!response.record) {
        throw new Error('Upload response missing record');
      }

      return {
        bucketKey,
        record: response.record,
        fileName: values.name.trim() || file.name,
      };
    },
    onSuccess: async (result) => {
      notifications.show({
        color: 'green',
        title: 'File uploaded',
        message: `${result.fileName} uploaded successfully`,
      });
      await queryClient.invalidateQueries({ queryKey: ['file-objects', result.bucketKey] });
    },
  });

  type DeleteVariables = { bucketKey: string; record: FileRecordView };
  type DeleteResult = DeleteVariables;

  const deleteMutation = useMutation<DeleteResult, Error | ApiError, DeleteVariables>({
    mutationFn: async ({ bucketKey, record }) => {
      await apiRequest(
        `/api/files/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeKey(record.key)}`,
        {
          method: 'DELETE',
          parseJson: false,
        },
      );
      return { bucketKey, record };
    },
    onSuccess: async (result) => {
      notifications.show({
        color: 'green',
        title: 'File deleted',
        message: `${result.record.name} has been removed`,
      });
      await queryClient.invalidateQueries({ queryKey: ['file-objects', result.bucketKey] });
    },
    onError: (error) => {
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unexpected error';
      notifications.show({
        color: 'red',
        title: 'Failed to delete file',
        message,
      });
    },
  });

  const handleSubmit = async (values: UploadFormValues) => {
    if (!bucketKey || uploadMutation.isPending) {
      return;
    }

    try {
      await uploadMutation.mutateAsync({ bucketKey, values });
      setUploadModalOpen(false);
      form.reset();
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unexpected error';
      notifications.show({
        color: 'red',
        title: 'Upload failed',
        message,
      });
    }
  };

  const handleDelete = async (record: FileRecordView) => {
    if (!bucketKey || deleteMutation.isPending) {
      return;
    }

    const confirmed = window.confirm(`Delete file "${record.name}"? This cannot be undone.`);
    if (!confirmed) {
      return;
    }

    try {
      await deleteMutation.mutateAsync({ bucketKey, record });
    } catch (error) {
      console.error(error);
    }
  };

  const triggerDownload = async (record: FileRecordView, variant: 'original' | 'markdown') => {
    if (!bucketKey) return;

    const params = new URLSearchParams();
    params.set('download', variant);
    params.set('variant', variant);
    const response = await fetch(
      `/api/files/buckets/${encodeURIComponent(bucketKey)}/objects/${encodeKey(record.key)}?${params.toString()}`,
    );

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      notifications.show({
        color: 'red',
        title: 'Download failed',
        message: error.error ?? 'Unexpected error',
      });
      return;
    }

    const blob = await response.blob();
    const link = document.createElement('a');
    const objectUrl = window.URL.createObjectURL(blob);
    link.href = objectUrl;
    const inferredName = variant === 'markdown' ? `${record.name}.md` : record.name;
    link.download = inferredName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(objectUrl);
  };

  const uploadModal = (
    <Modal
      opened={uploadModalOpen}
      onClose={() => setUploadModalOpen(false)}
  title={`Upload file${bucket ? ` to ${bucket.name}` : ''}`}
      size="md"
    >
      <form
        onSubmit={form.onSubmit((values) => {
          void handleSubmit(values);
        })}
      >
        <Stack gap="md">
          {(() => {
            const fileInputProps = form.getInputProps('file');
            return (
              <FileInput
                label="File"
                placeholder="Select file"
                withAsterisk
                accept="*/*"
                {...fileInputProps}
                onChange={(file) => {
                  fileInputProps.onChange(file);
                  if (file) {
                    if (!form.values.name) {
                      form.setFieldValue('name', file.name);
                    }
                    if (!form.values.contentType) {
                      form.setFieldValue('contentType', file.type);
                    }
                  }
                }}
              />
            );
          })()}
          <TextInput
            label="Name"
            placeholder="marketing-assets.pdf"
            withAsterisk
            {...form.getInputProps('name')}
          />
          <TextInput
            label="Content type"
            placeholder="application/pdf"
            {...form.getInputProps('contentType')}
          />
          <Checkbox
            label="Convert to markdown"
            {...form.getInputProps('convertToMarkdown', { type: 'checkbox' })}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setUploadModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={uploadMutation.isPending}>
              Upload
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );

  const markdownBadgeColor = (status?: string | null) => {
    switch (status) {
      case 'succeeded':
        return 'green';
      case 'failed':
        return 'red';
      case 'pending':
        return 'yellow';
      default:
        return 'gray';
    }
  };

  const controls = (
    <Group gap="xs">
      <Tooltip label="Refresh">
        <ActionIcon
          variant="subtle"
          onClick={() => {
            if (!bucketKey) {
              return;
            }
            void queryClient.invalidateQueries({ queryKey: ['file-objects', bucketKey] });
          }}
          disabled={!bucketKey || isRefetching}
          aria-label="Refresh files"
        >
          {isRefetching ? <Loader size="xs" /> : <IconRefresh size={16} />}
        </ActionIcon>
      </Tooltip>
      <Button
        onClick={() => setUploadModalOpen(true)}
        disabled={!bucketKey}
        leftSection={<IconUpload size={16} />}
      >
        Upload file
      </Button>
    </Group>
  );

  return (
    <Card withBorder radius="md" shadow="sm">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <Stack gap={4}>
            <Group gap="xs" align="center">
              <Text fw={600}>Files</Text>
              <Badge size="sm" color="gray" variant="light">
                {recordCount}
              </Badge>
            </Group>
            <Text size="sm" c="dimmed">
              {bucket
                ? `Manage files stored in ${bucket.name}`
                : 'Select a bucket to inspect its stored files.'}
            </Text>
            {bucket ? (
              <Group gap="md" wrap="wrap">
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    Bucket key:
                  </Text>
                  <Badge color="gray" variant="light" size="sm">
                    {bucket.key}
                  </Badge>
                </Group>
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    Status:
                  </Text>
                  <Badge size="sm" color={bucket.status === 'active' ? 'green' : 'yellow'}>
                    {bucket.status}
                  </Badge>
                </Group>
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    Prefix:
                  </Text>
                  <Text size="xs">{bucket.prefix ?? '—'}</Text>
                </Group>
                {bucket.provider ? (
                  <Group gap={6}>
                    <Text size="xs" c="dimmed">
                      Provider:
                    </Text>
                    <Badge
                      size="sm"
                      color={bucket.provider.status === 'active' ? 'green' : 'yellow'}
                    >
                      {bucket.provider.label}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      Driver: {bucket.provider.driver}
                    </Text>
                  </Group>
                ) : null}
              </Group>
            ) : null}
          </Stack>
          {controls}
        </Group>

        {!bucket ? (
          <Center py="lg">
            <Text c="dimmed">Select a bucket to view its files.</Text>
          </Center>
        ) : isInitialLoading ? (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        ) : recordCount === 0 ? (
          <Center py="xl">
            <Stack gap="sm" align="center">
              <Text size="sm" c="dimmed">
                No files uploaded yet. Use the upload action to add your first file.
              </Text>
              <Button
                onClick={() => setUploadModalOpen(true)}
                leftSection={<IconUpload size={16} />}
                disabled={!bucketKey}
              >
                Upload file
              </Button>
            </Stack>
          </Center>
        ) : (
          <Table.ScrollContainer minWidth={720} type="native">
            <Table highlightOnHover striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Key</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Markdown</Table.Th>
                  <Table.Th>Updated</Table.Th>
                  <Table.Th style={{ width: 160 }}>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {records.map((record) => (
                  <Table.Tr key={record.key}>
                    <Table.Td>
                      <Stack gap={4}>
                        <Text fw={600}>{record.name}</Text>
                        <Text size="xs" c="dimmed">
                          Created by {record.createdBy ?? 'system'}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed" ff="monospace">
                        {record.key}
                      </Text>
                    </Table.Td>
                    <Table.Td>{formatBytes(record.size)}</Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        <Badge color={markdownBadgeColor(record.markdownStatus)}>
                          {record.markdownStatus ?? 'unknown'}
                        </Badge>
                        {record.markdownKey ? (
                          <Tooltip label="Download markdown">
                            <ActionIcon
                              variant="subtle"
                              onClick={() => void triggerDownload(record, 'markdown')}
                              aria-label="Download markdown"
                            >
                              <IconFileDownload size={16} />
                            </ActionIcon>
                          </Tooltip>
                        ) : null}
                      </Group>
                    </Table.Td>
                    <Table.Td>{formatDate(record.updatedAt ?? record.createdAt)}</Table.Td>
                    <Table.Td>
                      <Group gap="xs" justify="flex-end">
                        <Tooltip label="Download original">
                          <ActionIcon
                            variant="subtle"
                            onClick={() => void triggerDownload(record, 'original')}
                            aria-label="Download original"
                          >
                            <IconCloudDownload size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Download markdown" disabled={!record.markdownKey}>
                          <ActionIcon
                            variant="subtle"
                            disabled={!record.markdownKey}
                            onClick={() => void triggerDownload(record, 'markdown')}
                            aria-label="Download markdown"
                          >
                            <IconFileCheck size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Delete file">
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            onClick={() => void handleDelete(record)}
                            disabled={deleteMutation.isPending}
                            aria-label="Delete file"
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}

        {hasNextPage && bucket ? (
          <Center>
            <Button
              variant="light"
              onClick={() => void filesQuery.fetchNextPage()}
              loading={isFetchingNextPage}
              disabled={!hasNextPage}
            >
              Load more
            </Button>
          </Center>
        ) : null}
      </Stack>

      {uploadModal}
    </Card>
  );
}
