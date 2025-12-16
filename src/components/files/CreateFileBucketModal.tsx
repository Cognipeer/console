'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Divider,
  Group,
  Modal,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileBucketView, FileProviderView } from '@/lib/services/files';
import { ApiError, apiRequest } from '@/lib/api/client';

type CreateFileBucketModalProps = {
  opened: boolean;
  onClose: () => void;
  onCreated: (bucket: FileBucketView) => void;
};

type FormValues = {
  key: string;
  name: string;
  description: string;
  prefix: string;
  providerKey: string;
  status: boolean;
};

export default function CreateFileBucketModal({
  opened,
  onClose,
  onCreated,
}: CreateFileBucketModalProps) {
  const queryClient = useQueryClient();

  const providersQuery = useQuery<FileProviderView[], ApiError>({
    queryKey: ['providers', 'file'],
    queryFn: async () => {
      const response = await apiRequest<{ providers?: FileProviderView[] }>(
        '/api/files/providers',
      );
      return response.providers ?? [];
    },
    enabled: opened,
    refetchOnMount: 'always',
  });

  const form = useForm<FormValues>({
    initialValues: {
      key: '',
      name: '',
      description: '',
      prefix: '',
      providerKey: '',
      status: true,
    },
    validate: {
      key: (value) =>
        value.trim().length === 0
          ? 'Bucket key is required'
          : /[^a-z0-9-_]/.test(value)
            ? 'Use lowercase letters, numbers, hyphen, or underscore'
            : null,
      name: (value) => (value.trim().length === 0 ? 'Bucket name is required' : null),
      providerKey: (value) => (value ? null : 'Select a provider'),
    },
  });

  const providerOptions = useMemo(
    () =>
      (providersQuery.data ?? []).map((provider) => ({
        value: provider.key,
        label: provider.label,
      })),
    [providersQuery.data],
  );

  const providers = useMemo(
    () => providersQuery.data ?? [],
    [providersQuery.data],
  );
  const providersLoading = providersQuery.isPending || providersQuery.isRefetching;

  useEffect(() => {
    if (!providersQuery.isError) {
      return;
    }

    const error = providersQuery.error;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    notifications.show({
      color: 'red',
      title: 'Unable to load providers',
      message,
    });
  }, [providersQuery.isError, providersQuery.error]);

  useEffect(() => {
    if (!opened) {
      form.reset();
      return;
    }
    form.setValues((current) => ({
      ...current,
      key: '',
      name: '',
      description: '',
      prefix: '',
      status: true,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  useEffect(() => {
    if (!opened) {
      return;
    }

    if (providers.length > 0 && !form.values.providerKey) {
      form.setFieldValue('providerKey', providers[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, providers]);

  const createBucketMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = {
        key: values.key.trim(),
        name: values.name.trim(),
        providerKey: values.providerKey,
        description: values.description.trim() || undefined,
        prefix: values.prefix.trim() || undefined,
        status: values.status ? 'active' : 'disabled',
      };

      const body = await apiRequest<{ bucket?: FileBucketView }>(
        '/api/files/buckets',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );

      const bucket = body.bucket;
      if (!bucket) {
        throw new Error('Bucket response missing');
      }

      return bucket;
    },
  });

  const handleSubmit = async (values: FormValues) => {
    try {
      const bucket = await createBucketMutation.mutateAsync(values);
      notifications.show({
        color: 'green',
        title: 'Bucket created',
        message: `${bucket.name} is now available.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['file-buckets'] });
      onCreated(bucket);
      onClose();
      form.reset();
    } catch (error) {
      console.error(error);
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unexpected error';
      notifications.show({
        color: 'red',
        title: 'Unable to create bucket',
        message,
      });
    }
  };

  return (
    <>
      <Modal
        opened={opened}
        onClose={onClose}
        title="Add Bucket"
        size="lg"
        keepMounted={false}
      >
        <form
          onSubmit={form.onSubmit((values) => {
            void handleSubmit(values);
          })}
        >
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              Buckets group related files together and map them to a storage provider. Configure the
              provider and prefix to control where objects are stored.
            </Text>

            <Stack gap="sm">
              <Group align="flex-end" gap="xs">
                <Select
                  label="Provider"
                  placeholder={providersLoading ? 'Loading providers…' : 'Select a provider'}
                  data={providerOptions}
                  value={form.values.providerKey}
                  onChange={(value) => form.setFieldValue('providerKey', value ?? '')}
                  searchable
                  withAsterisk
                  style={{ flex: 1 }}
                />
              </Group>
              <Text size="xs" c="dimmed">
                Need a new storage provider? Ask a tenant admin to add one in Tenant Settings.
              </Text>
            </Stack>

            <Group grow align="flex-start">
              <TextInput
                label="Bucket key"
                placeholder="documents"
                withAsterisk
                {...form.getInputProps('key')}
              />
              <TextInput
                label="Bucket name"
                placeholder="Customer Documents"
                withAsterisk
                {...form.getInputProps('name')}
              />
            </Group>

            <TextInput
              label="Prefix"
              placeholder="Optional path prefix"
              description="Overrides the default prefix derived from the bucket key."
              {...form.getInputProps('prefix')}
            />

            <Textarea
              label="Description"
              placeholder="Optional description"
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />

            <Switch
              label="Active"
              description="Inactive buckets cannot be used for uploads or downloads."
              {...form.getInputProps('status', { type: 'checkbox' })}
            />

            <Divider />

            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={createBucketMutation.isPending}>
                Create bucket
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
