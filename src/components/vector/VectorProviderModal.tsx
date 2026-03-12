'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import type { ProviderDescriptor, ProviderFormSchema } from '@/lib/providers';
import type { VectorProviderView } from '@/lib/services/vector';
import ProviderFormRenderer from '../providers/ProviderFormRenderer';

interface VectorProviderModalProps {
  opened: boolean;
  onClose: () => void;
  onCreated: (provider: VectorProviderView) => void;
}

interface FormValues extends Record<string, unknown> {
  driver: string;
  key: string;
  label: string;
  description?: string;
  status: boolean;
}

interface FieldBuckets {
  credentials: Record<string, unknown>;
  settings: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

function partitionValues(
  schema: ProviderFormSchema | null,
  values: FormValues,
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

export default function VectorProviderModal({
  opened,
  onClose,
  onCreated,
}: VectorProviderModalProps) {
  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  const [schema, setSchema] = useState<ProviderFormSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<string>('');

  const form = useForm<FormValues>({
    initialValues: {
      driver: '',
      key: '',
      label: '',
      description: '',
      status: true,
    },
  });
  const { setFieldValue, reset } = form;

  const driverOptions = useMemo(
    () =>
      drivers.map((driver) => ({
        value: driver.id,
        label: driver.display.label,
      })),
    [drivers],
  );

  useEffect(() => {
    if (!opened) {
      return;
    }
    let aborted = false;
    async function loadDrivers() {
      setDriversLoading(true);
      try {
        const response = await fetch('/api/vector/providers/drivers');
        if (!response.ok) {
          throw new Error('Failed to load vector provider drivers');
        }
        const data = await response.json();
        if (!aborted) {
          setDrivers(data.drivers ?? []);
          const defaultDriver = data.drivers?.[0]?.id ?? '';
          setSelectedDriver(defaultDriver);
          setFieldValue('driver', defaultDriver);
        }
      } catch (error) {
        console.error(error);
        if (!aborted) {
          notifications.show({
            color: 'red',
            title: 'Unable to load drivers',
            message: error instanceof Error ? error.message : 'Unexpected error',
          });
        }
      } finally {
        if (!aborted) {
          setDriversLoading(false);
        }
      }
    }

    loadDrivers();
    return () => {
      aborted = true;
    };
  }, [opened, setFieldValue]);

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
          `/api/vector/providers/drivers/${selectedDriver}/form`,
        );
        if (!response.ok) {
          throw new Error('Failed to load provider form schema');
        }
        const data = await response.json();
        if (!aborted) {
          setSchema(data.schema ?? null);
        }
      } catch (error) {
        console.error(error);
        if (!aborted) {
          setSchemaError(
            error instanceof Error ? error.message : 'Unable to load form schema',
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

  const handleClose = () => {
    onClose();
    reset();
    setSchema(null);
    setSchemaError(null);
  };

  const handleSubmit = form.onSubmit(async (values) => {
    if (!selectedDriver) {
      notifications.show({
        color: 'red',
        title: 'Driver missing',
        message: 'Please select a provider driver',
      });
      return;
    }

    const buckets = partitionValues(schema, values);

    try {
      const response = await fetch('/api/vector/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: values.key,
          label: values.label,
          description: values.description,
          driver: selectedDriver,
          status: values.status ? 'active' : 'disabled',
          credentials: buckets.credentials,
          settings: buckets.settings,
          metadata: buckets.metadata,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error ?? 'Failed to create provider');
      }

      const data = await response.json();
      notifications.show({
        color: 'green',
        title: 'Provider created',
        message: `${values.label} is ready to use`,
      });
      onCreated(data.provider as VectorProviderView);
      handleClose();
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to create provider',
        message: error instanceof Error ? error.message : 'Unexpected error occurred',
      });
    }
  });

  return (
    <Modal opened={opened} onClose={handleClose} title="Add Vector Provider" size="lg">
      <form onSubmit={handleSubmit}>
        <Stack gap="md">
          <Stack gap="sm">
            <Select
              label="Driver"
              placeholder={driversLoading ? 'Loading drivers…' : 'Select a provider driver'}
              data={driverOptions}
              value={selectedDriver}
              onChange={(value) => {
                const next = value ?? '';
                setSelectedDriver(next);
                setFieldValue('driver', next);
              }}
              required
              disabled={driversLoading}
            />
            <TextInput
              label="Key"
              placeholder="unique-provider-key"
              required
              {...form.getInputProps('key')}
            />
            <TextInput
              label="Label"
              placeholder="Provider name"
              required
              {...form.getInputProps('label')}
            />
            <Textarea
              label="Description"
              placeholder="Optional description"
              autosize
              minRows={2}
              {...form.getInputProps('description')}
            />
            <Switch
              label="Active"
              description="Inactive providers cannot be used to create indexes."
              {...form.getInputProps('status', { type: 'checkbox' })}
            />
          </Stack>

          <Divider label="Configuration" labelPosition="left" />

          {schemaLoading && (
            <Group justify="center" py="md">
              <Loader size="sm" />
            </Group>
          )}

          {schemaError && (
            <Alert icon={<IconAlertCircle size={16} />} color="red" title="Configuration unavailable">
              {schemaError}
            </Alert>
          )}

          {schema && !schemaLoading && !schemaError && (
            <ProviderFormRenderer schema={schema} form={form} />
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={driversLoading || schemaLoading}>
              Create Provider
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
