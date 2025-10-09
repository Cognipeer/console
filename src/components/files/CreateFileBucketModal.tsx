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
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ProviderConfigModal, {
  type ProviderConfigModalSubmitPayload,
} from '@/components/providers/ProviderConfigModal';
import type { ProviderDescriptor } from '@/lib/providers';
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
  const [providerModalOpen, setProviderModalOpen] = useState(false);
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


  const providerDriversQuery = useQuery<ProviderDescriptor[], ApiError>({
    queryKey: ['provider-drivers', 'file'],
    queryFn: async () => {
      const response = await apiRequest<{ drivers?: ProviderDescriptor[] }>(
        '/api/files/providers/drivers',
      );
      return response.drivers ?? [];
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
  const providerDrivers = providerDriversQuery.data ?? [];
  const providerDriversLoading =
    providerDriversQuery.isPending || providerDriversQuery.isRefetching;

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
    if (!providerDriversQuery.isError) {
      return;
    }

    const error = providerDriversQuery.error;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    notifications.show({
      color: 'red',
      title: 'Unable to load provider drivers',
      message,
    });
  }, [providerDriversQuery.isError, providerDriversQuery.error]);

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

  const createProviderMutation = useMutation({
    mutationFn: async ({
      driver,
      values,
    }: ProviderConfigModalSubmitPayload) => {
      const payload: Record<string, unknown> = {
        key: values.base.key,
        label: values.base.label,
        description: values.base.description,
        driver,
        type: 'file',
        status: values.base.status,
        credentials: values.credentials,
        settings: values.settings,
        metadata: values.metadata,
      };

      await apiRequest('/api/files/providers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      return values.base;
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

  const handleProviderModalSubmit = async ({
    driver,
    values,
  }: ProviderConfigModalSubmitPayload) => {
    if (createProviderMutation.isPending) {
      return;
    }
    try {
      const base = await createProviderMutation.mutateAsync({ driver, values });
      notifications.show({
        color: 'green',
        title: 'Provider created',
        message: `${values.base.label} is now available.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['providers', 'file'] });
      form.setFieldValue('providerKey', base.key);
      setProviderModalOpen(false);
    } catch (error) {
      console.error(error);
      throw error;
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
                <Tooltip label="Add provider">
                  <Button
                    variant="light"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => setProviderModalOpen(true)}
                  >
                    Provider
                  </Button>
                </Tooltip>
              </Group>
              <Text size="xs" c="dimmed">
                Need a new storage provider? Add one without leaving this flow.
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

      <ProviderConfigModal
        opened={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        mode="create"
        drivers={providerDrivers}
        driversLoading={providerDriversLoading}
        onSubmit={async (options) => {
          try {
            await handleProviderModalSubmit(options);
            setProviderModalOpen(false);
          } catch (error) {
            console.error(error);
            notifications.show({
              color: 'red',
              title: 'Unable to create provider',
              message: error instanceof Error ? error.message : 'Unexpected error',
            });
          }
        }}
      />
    </>
  );
}
