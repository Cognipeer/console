'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, Stack, Text, Loader, Center } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ProviderDomain } from '@/lib/database';
import type { ProviderDescriptor } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import type { ProviderConfigModalSubmitPayload } from './ProviderConfigModal';
import ProviderList from './ProviderList';
import ProviderConfigModal from './ProviderConfigModal';

type ProviderManagerProps = {
  domain: ProviderDomain;
  title: string;
  description?: string;
  onManageProvider?: (provider: ProviderConfigView) => void;
  manageLabel?: string;
};

type ModalState =
  | { mode: 'create'; provider?: undefined }
  | { mode: 'edit'; provider: ProviderConfigView };

export default function ProviderManager({
  domain,
  title,
  description,
  onManageProvider,
  manageLabel,
}: ProviderManagerProps) {
  const [providers, setProviders] = useState<ProviderConfigView[]>([]);
  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [modalState, setModalState] = useState<ModalState | null>(null);

  const loadProviders = useCallback(async () => {
    setLoadingProviders(true);
    try {
      const response = await fetch(`/api/providers?type=${domain}`);
      if (!response.ok) {
        throw new Error('Failed to load providers');
      }
      const data = await response.json();
      setProviders(data.providers ?? []);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load providers',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoadingProviders(false);
    }
  }, [domain]);

  const loadDrivers = useCallback(async () => {
    setLoadingDrivers(true);
    try {
      const response = await fetch(`/api/providers/drivers?domain=${domain}`);
      if (!response.ok) {
        throw new Error('Failed to load provider drivers');
      }
      const data = await response.json();
      setDrivers(data.drivers ?? []);
    } catch (error) {
      console.error(error);
      notifications.show({
        color: 'red',
        title: 'Unable to load drivers',
        message: error instanceof Error ? error.message : 'Unexpected error',
      });
    } finally {
      setLoadingDrivers(false);
    }
  }, [domain]);

  useEffect(() => {
    void loadProviders();
    void loadDrivers();
  }, [loadProviders, loadDrivers]);

  const handleCreateSubmit = async ({
    driver,
    values,
  }: ProviderConfigModalSubmitPayload) => {
    const payload: Record<string, unknown> = {
      key: values.base.key,
      label: values.base.label,
      description: values.base.description,
      driver,
      type: domain,
      status: values.base.status,
      credentials: values.credentials,
      settings: values.settings,
      metadata: values.metadata,
    };

    const response = await fetch('/api/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error ?? 'Failed to create provider');
    }

    notifications.show({
      color: 'green',
      title: 'Provider created',
      message: `${values.base.label} is now available.`,
    });
    await loadProviders();
  };

  const handleUpdateSubmit = async ({
    providerId,
    values,
  }: ProviderConfigModalSubmitPayload) => {
    if (!providerId) {
      throw new Error('Provider identifier missing');
    }

    const payload: Record<string, unknown> = {
      label: values.base.label,
      description: values.base.description,
      status: values.base.status,
      settings: values.settings,
      metadata: values.metadata,
    };

    if (Object.keys(values.credentials).length > 0) {
      payload.credentials = values.credentials;
    }

    const response = await fetch(`/api/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error ?? 'Failed to update provider');
    }

    notifications.show({
      color: 'green',
      title: 'Provider updated',
      message: `${values.base.label} was updated successfully.`,
    });
    await loadProviders();
  };

  const handleDelete = async (provider: ProviderConfigView) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete provider "${provider.label}"?`,
    );
    if (!confirmed) {
      return;
    }

    const response = await fetch(`/api/providers/${provider._id}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      notifications.show({
        color: 'red',
        title: 'Failed to delete provider',
        message: error.error ?? 'Unexpected error',
      });
      return;
    }

    notifications.show({
      color: 'green',
      title: 'Provider deleted',
      message: `${provider.label} has been removed.`,
    });
    await loadProviders();
  };

  const modalProps = modalState
    ? {
        opened: true,
        mode: modalState.mode,
        provider: modalState.mode === 'edit' ? modalState.provider : undefined,
      }
    : { opened: false };

  const combinedLoading = loadingProviders && providers.length === 0;

  return (
    <Card withBorder radius="md" shadow="sm">
      <Stack gap="md">
        <div>
          <Text fw={600}>{title}</Text>
          {description && (
            <Text size="sm" c="dimmed">
              {description}
            </Text>
          )}
        </div>

        {combinedLoading ? (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        ) : (
          <ProviderList
            providers={providers}
            loading={loadingProviders}
            onCreate={() => setModalState({ mode: 'create' })}
            onEdit={(provider) => setModalState({ mode: 'edit', provider })}
            onDelete={handleDelete}
            onManage={onManageProvider}
            manageLabel={manageLabel}
          />
        )}
      </Stack>

      <ProviderConfigModal
        opened={modalProps.opened}
        onClose={() => setModalState(null)}
        mode={modalState?.mode ?? 'create'}
        provider={modalState?.mode === 'edit' ? modalState.provider : undefined}
        drivers={drivers}
        driversLoading={loadingDrivers}
        onSubmit={async (options) => {
          if (modalState?.mode === 'edit') {
            await handleUpdateSubmit(options);
          } else {
            await handleCreateSubmit(options);
          }
        }}
      />
    </Card>
  );
}
