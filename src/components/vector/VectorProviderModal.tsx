'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Divider,
  Group,
  Loader,
  Select,
  Stack,
  Switch,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle } from '@tabler/icons-react';
import FormShell, { FormSection } from '@/components/common/ui/FormShell';
import type { VectorProviderView } from '@/lib/services/vector';
import { errorMessage } from '@/lib/api/client';
import { useCreateVectorProvider, useVectorDriverForm, useVectorDrivers } from '@/lib/api/queries/vector';
import ProviderFormRenderer from '../providers/ProviderFormRenderer';
import { partitionProviderValues } from '../providers/providerFormModel';

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

export default function VectorProviderModal({
  opened,
  onClose,
  onCreated,
}: VectorProviderModalProps) {
  const [selectedDriver, setSelectedDriver] = useState<string>('');
  const driversQuery = useVectorDrivers(opened);
  const formQuery = useVectorDriverForm(selectedDriver, opened);
  const createProvider = useCreateVectorProvider();
  const drivers = useMemo(() => driversQuery.data ?? [], [driversQuery.data]);
  const driversLoading = driversQuery.isLoading;
  const schema = opened && selectedDriver ? (formQuery.data ?? null) : null;
  const schemaLoading = formQuery.isLoading;
  const schemaError = opened && selectedDriver && formQuery.isError ? errorMessage(formQuery.error, 'Unable to load form schema') : null;
  const submitting = createProvider.isPending;
  const formRef = useRef<HTMLFormElement>(null);

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

  // Each time the modal opens (and the drivers arrive) the first driver is selected.
  useEffect(() => {
    if (!opened || drivers.length === 0) return;
    const defaultDriver = drivers[0]?.id ?? '';
    setSelectedDriver(defaultDriver);
    setFieldValue('driver', defaultDriver);
  }, [opened, drivers, setFieldValue]);

  const driversError = driversQuery.error;
  useEffect(() => {
    if (!opened || !driversError) return;
    notifications.show({
      color: 'red',
      title: 'Unable to load drivers',
      message: errorMessage(driversError, 'Unexpected error'),
    });
  }, [opened, driversError]);

  const handleClose = () => {
    onClose();
    reset();
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

    const buckets = partitionProviderValues(schema, values);

    try {
      const provider = await createProvider.mutateAsync({
        key: values.key,
        label: values.label,
        description: values.description,
        driver: selectedDriver,
        status: values.status ? 'active' : 'disabled',
        credentials: buckets.credentials,
        settings: buckets.settings,
        metadata: buckets.metadata,
      });

      notifications.show({
        color: 'green',
        title: 'Provider created',
        message: `${values.label} is ready to use`,
      });
      onCreated(provider);
      handleClose();
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to create provider',
        message: errorMessage(error, 'Unexpected error occurred'),
      });
    }
  });

  return (
    <FormShell
      open={opened}
      onClose={handleClose}
      title="Add Vector Provider"
      subtitle="Indexes live in a vector provider. After it is created you can add the first index."
      primaryAction={{
        label: 'Create Provider',
        loading: submitting,
        disabled: driversLoading || schemaLoading || submitting,
        onClick: () => formRef.current?.requestSubmit(),
      }}
      secondaryAction={{ label: 'Cancel', onClick: handleClose, disabled: submitting }}
    >
      <form ref={formRef} onSubmit={handleSubmit}>
        <FormSection title="Provider">
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
          </Stack>
        </FormSection>
      </form>
    </FormShell>
  );
}
