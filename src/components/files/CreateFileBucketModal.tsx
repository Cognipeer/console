'use client';

import { useEffect, useMemo } from 'react';
import { Select, TextInput, Textarea } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBucket, IconCheck } from '@tabler/icons-react';
import FormShell, {
  Checklist,
  ChipPicker,
  FormField,
  FormRow,
  FormSection,
  SummaryGroup,
  SummaryKV,
  ToggleList,
  ToggleRow,
} from '@/components/common/ui/FormShell';
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

  const providers = useMemo(
    () => providersQuery.data ?? [],
    [providersQuery.data],
  );
  const providersLoading = providersQuery.isPending || providersQuery.isRefetching;

  const providerChipOptions = useMemo(
    () =>
      providers.map((provider) => ({
        value: provider.key,
        label: provider.label,
      })),
    [providers],
  );

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

  const submit = () => {
    const validation = form.validate();
    if (validation.hasErrors) return;
    void handleSubmit(form.getValues());
  };

  const selectedProvider = useMemo(
    () => providers.find((p) => p.key === form.values.providerKey),
    [providers, form.values.providerKey],
  );

  const validProvider = Boolean(form.values.providerKey);
  const validKey =
    form.values.key.trim().length > 0 && !/[^a-z0-9-_]/.test(form.values.key);
  const validName = form.values.name.trim().length > 0;

  const checklist = [
    { id: 1, label: 'Storage provider selected', done: validProvider },
    { id: 2, label: 'Bucket key & name set', done: validKey && validName },
    { id: 3, label: 'Status configured', done: true },
  ];

  const summary = (
    <>
      <SummaryGroup title="Provider">
        {selectedProvider ? (
          <>
            <SummaryKV label="Name" value={selectedProvider.label} />
            <SummaryKV label="Driver" value={selectedProvider.driver} mono />
            <SummaryKV label="Status" value={selectedProvider.status} />
          </>
        ) : (
          <SummaryKV label="—" value="Select a provider" />
        )}
      </SummaryGroup>

      <SummaryGroup title="Bucket">
        <SummaryKV
          label="Key"
          value={form.values.key || <span className="ds-faint">—</span>}
          mono
        />
        <SummaryKV
          label="Name"
          value={form.values.name || <span className="ds-faint">—</span>}
        />
        <SummaryKV
          label="Prefix"
          value={form.values.prefix || <span className="ds-faint">default</span>}
          mono
        />
        <SummaryKV
          label="Status"
          value={form.values.status ? 'active' : 'disabled'}
        />
      </SummaryGroup>

      <SummaryGroup title="Pre-flight">
        <Checklist items={checklist} />
      </SummaryGroup>
    </>
  );

  const noProviders = !providersLoading && providers.length === 0;
  const canSubmit = !noProviders && validProvider && validKey && validName;

  return (
    <FormShell
      open={opened}
      onClose={onClose}
      icon={<IconBucket size={16} />}
      title="Add bucket"
      subtitle="Group related files and map them to a storage provider."
      summary={summary}
      footerStatus={`${checklist.filter((c) => c.done).length} of ${checklist.length} ready`}
      primaryAction={{
        label: 'Create bucket',
        icon: <IconCheck size={13} />,
        loading: createBucketMutation.isPending,
        disabled: !canSubmit,
        onClick: submit,
      }}
    >
      <FormSection
        number={1}
        title="Storage provider"
        description="Pick the storage backend that will hold the objects in this bucket."
        done={validProvider}
      >
        {noProviders ? (
          <div
            className="ds-card ds-card-pad"
            style={{ background: 'var(--ds-surface-1)' }}
          >
            <span className="ds-muted" style={{ fontSize: 13 }}>
              No storage providers configured. Ask a tenant admin to add one
              under Tenant Settings.
            </span>
          </div>
        ) : providerChipOptions.length <= 4 ? (
          <FormField label="Provider" required>
            <ChipPicker<string>
              options={providerChipOptions}
              value={form.values.providerKey}
              onChange={(v) => form.setFieldValue('providerKey', v as string)}
            />
          </FormField>
        ) : (
          <FormField label="Provider" required>
            <Select
              placeholder={providersLoading ? 'Loading providers…' : 'Select a provider'}
              data={providerChipOptions}
              value={form.values.providerKey}
              onChange={(value) => form.setFieldValue('providerKey', value ?? '')}
              searchable
            />
          </FormField>
        )}
      </FormSection>

      <FormSection
        number={2}
        title="Identity"
        description="How this bucket is identified across the console and SDK."
        done={validKey && validName}
      >
        <FormRow cols={2}>
          <FormField label="Bucket key" required hint="Lowercase letters, numbers, hyphen, or underscore.">
            <TextInput
              placeholder="documents"
              {...form.getInputProps('key')}
            />
          </FormField>
          <FormField label="Bucket name" required>
            <TextInput
              placeholder="Customer Documents"
              {...form.getInputProps('name')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField
            label="Prefix"
            optional
            hint="Overrides the default prefix derived from the bucket key."
          >
            <TextInput
              placeholder="Optional path prefix"
              {...form.getInputProps('prefix')}
            />
          </FormField>
        </FormRow>
        <FormRow cols={1}>
          <FormField label="Description" optional>
            <Textarea
              placeholder="Optional description"
              minRows={2}
              autosize
              {...form.getInputProps('description')}
            />
          </FormField>
        </FormRow>
      </FormSection>

      <FormSection
        number={3}
        title="Status"
        description="Inactive buckets cannot be used for uploads or downloads."
        done
      >
        <ToggleList>
          <ToggleRow
            label="Active"
            description="Allow this bucket to accept uploads and serve downloads."
            checked={form.values.status}
            onChange={(v) => form.setFieldValue('status', v)}
          />
        </ToggleList>
      </FormSection>
    </FormShell>
  );
}
