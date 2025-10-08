'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Stack,
  Button,
  Select,
  TextInput,
  Textarea,
  Switch,
  Group,
  Text,
  Divider,
  Alert,
  Loader,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import type {
  ProviderDescriptor,
  ProviderFormField,
  ProviderFormSchema,
} from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import ProviderFormRenderer from './ProviderFormRenderer';

type FormValues = Record<string, string | number | boolean | null | undefined> & {
  key: string;
  label: string;
  description?: string;
  driver: string;
  status: boolean;
};

export type ProviderConfigModalSubmitPayload = {
  providerId?: string;
  driver: string;
  values: {
    base: {
      key: string;
      label: string;
      description?: string;
      status: 'active' | 'disabled' | 'errored';
    };
    credentials: Record<string, unknown>;
    settings: Record<string, unknown>;
    metadata: Record<string, unknown>;
  };
};

export type ProviderConfigModalProps = {
  opened: boolean;
  onClose: () => void;
  mode: 'create' | 'edit';
  drivers: ProviderDescriptor[];
  driversLoading?: boolean;
  provider?: ProviderConfigView;
  onSubmit: (options: ProviderConfigModalSubmitPayload) => Promise<void>;
};

type FieldBuckets = {
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

function partitionValues(
  schema: ProviderFormSchema | null,
  values: Record<string, unknown>,
): FieldBuckets {
  const buckets: FieldBuckets = {
    credentials: {},
    settings: {},
    metadata: {},
  };

  if (!schema) {
    return buckets;
  }

  schema.sections.forEach((section) => {
    section.fields.forEach((field) => {
      const scope = field.scope ?? 'credentials';
      const value = values[field.name];
      if (
        value === undefined ||
        value === null ||
        (typeof value === 'string' && value.trim() === '')
      ) {
        return;
      }
      buckets[scope as keyof FieldBuckets][field.name] = value;
    });
  });

  return buckets;
}

function resolveInitialFieldValue(
  field: ProviderFormField,
  provider?: ProviderConfigView,
  mode: 'create' | 'edit' = 'create',
) {
  const scope = field.scope ?? 'credentials';
  if (mode === 'edit' && provider) {
    if (scope === 'settings') {
      return provider.settings?.[field.name] ?? field.defaultValue ?? '';
    }
    if (scope === 'metadata') {
      return provider.metadata?.[field.name] ?? field.defaultValue ?? '';
    }
    // Credentials are not returned for security; default to empty.
    return field.defaultValue ?? '';
  }

  return field.defaultValue ?? '';
}

export default function ProviderConfigModal({
  opened,
  onClose,
  mode,
  drivers,
  driversLoading = false,
  provider,
  onSubmit,
}: ProviderConfigModalProps) {
  const [schema, setSchema] = useState<ProviderFormSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<string>(
    provider?.driver ?? drivers[0]?.id ?? '',
  );

  const driverOptions = useMemo(
    () => drivers.map((driver) => ({
      value: driver.id,
      label: driver.display.label,
    })),
    [drivers],
  );

  const form = useForm<FormValues>({
    initialValues: {
      key: provider?.key ?? '',
      label: provider?.label ?? '',
      description: provider?.description ?? '',
      driver: provider?.driver ?? drivers[0]?.id ?? '',
      status: provider?.status !== 'disabled',
    },
  });

  useEffect(() => {
    if (!opened) {
      return;
    }
    setSelectedDriver(provider?.driver ?? drivers[0]?.id ?? '');
    form.setValues({
      key: provider?.key ?? '',
      label: provider?.label ?? '',
      description: provider?.description ?? '',
      driver: provider?.driver ?? drivers[0]?.id ?? '',
      status: provider?.status !== 'disabled',
    });
  }, [opened, provider, drivers, form]);

  useEffect(() => {
    if (!opened || !selectedDriver) {
      setSchema(null);
      return;
    }

    let aborted = false;

    async function loadSchema() {
      setSchemaError(null);
      setSchemaLoading(true);
      try {
        const response = await fetch(
          `/api/providers/drivers/${selectedDriver}/form`,
        );
        if (!response.ok) {
          throw new Error('Failed to load provider form schema');
        }
        const data = await response.json();
        if (!aborted) {
          setSchema(data.schema);
        }
      } catch (error) {
        if (!aborted) {
          console.error(error);
          setSchemaError(
            error instanceof Error ? error.message : 'Unable to load form',
          );
          setSchema(null);
        }
      } finally {
        if (!aborted) {
          setSchemaLoading(false);
        }
      }
    }

    loadSchema();
    return () => {
      aborted = true;
    };
  }, [opened, selectedDriver]);

  useEffect(() => {
    if (!schema) {
      return;
    }
    const fieldValues: Record<string, FormValues[keyof FormValues]> = {};
    schema.sections.forEach((section) => {
      section.fields.forEach((field) => {
        fieldValues[field.name] = resolveInitialFieldValue(
          field,
          provider,
          mode,
        ) as FormValues[keyof FormValues];
      });
    });
    form.setValues((current) => ({
      ...current,
      ...fieldValues,
    }));
  }, [schema, provider, mode, form]);

  const handleSubmit = async (values: FormValues) => {
    if (!selectedDriver) {
      notifications.show({
        color: 'red',
        title: 'Driver missing',
        message: 'Please select a provider driver before saving.',
      });
      return;
    }

    const buckets = partitionValues(schema, values);

    try {
      await onSubmit({
        providerId: provider?._id as string | undefined,
        driver: selectedDriver,
        values: {
          base: {
            key: values.key,
            label: values.label,
            description: values.description,
            status: values.status ? 'active' : 'disabled',
          },
          credentials: buckets.credentials,
          settings: buckets.settings,
          metadata: buckets.metadata,
        },
      });
      onClose();
      form.reset();
      setSchema(null);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Failed to save provider',
        message:
          error instanceof Error ? error.message : 'Unexpected error occurred',
      });
    }
  };

  const modalTitle =
    mode === 'create' ? 'Add Provider' : `Edit Provider — ${provider?.label}`;

  const selectedDriverDescriptor = drivers.find(
    (driver) => driver.id === selectedDriver,
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={modalTitle}
      size="lg"
      keepMounted={false}
    >
      <form
        onSubmit={form.onSubmit((values) => {
          void handleSubmit(values);
        })}
      >
        <Stack gap="md">
          <Stack gap="sm">
            <Select
              label="Driver"
              placeholder={driversLoading ? 'Loading drivers…' : 'Select a provider driver'}
              data={driverOptions}
              value={selectedDriver}
              onChange={(value) => setSelectedDriver(value ?? '')}
              disabled={mode === 'edit' || driversLoading}
              required
            />
            <TextInput
              label="Key"
              placeholder="unique-key"
              {...form.getInputProps('key')}
              required
              disabled={mode === 'edit'}
            />
            <TextInput
              label="Label"
              placeholder="Display name"
              {...form.getInputProps('label')}
              required
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
              description="Inactive providers cannot be used by dependent modules."
              {...form.getInputProps('status', { type: 'checkbox' })}
            />
          </Stack>

          <Divider label="Configuration" labelPosition="left" />

          {selectedDriverDescriptor?.display.description && (
            <Text size="sm" c="dimmed">
              {selectedDriverDescriptor.display.description}
            </Text>
          )}

          {schemaLoading && (
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          )}

          {schemaError && (
            <Alert
              icon={<IconAlertCircle size={16} />}
              color="red"
              title="Configuration unavailable"
            >
              {schemaError}
            </Alert>
          )}

          {schema && !schemaLoading && !schemaError && (
            <ProviderFormRenderer schema={schema} form={form} />
          )}

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={driversLoading}>
              {mode === 'create' ? 'Create Provider' : 'Save Changes'}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
