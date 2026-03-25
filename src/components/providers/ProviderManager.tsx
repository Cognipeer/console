'use client';

import { useEffect, useState } from 'react';
import { Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import LoadingState from '@/components/common/LoadingState';
import SectionCard from '@/components/common/SectionCard';
import type { ProviderDomain } from '@/lib/database';
import type { ProviderDescriptor } from '@/lib/providers';
import type { ProviderConfigView } from '@/lib/services/providers/providerService';
import type { ProviderConfigModalSubmitPayload } from './ProviderConfigModal';
import ProviderList from './ProviderList';
import ProviderConfigModal from './ProviderConfigModal';
import { ApiError, apiRequest } from '@/lib/api/client';

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
  const [modalState, setModalState] = useState<ModalState | null>(null);
  const queryClient = useQueryClient();

  const providersQuery = useQuery<ProviderConfigView[], ApiError>({
    queryKey: ['providers', domain],
    queryFn: async () => {
      const response = await apiRequest<{ providers?: ProviderConfigView[] }>(
        `/api/providers?type=${domain}`,
      );
      return response.providers ?? [];
    },
    refetchOnMount: 'always',
  });

  const driversQuery = useQuery<ProviderDescriptor[], ApiError>({
    queryKey: ['provider-drivers', domain],
    queryFn: async () => {
      const response = await apiRequest<{ drivers?: ProviderDescriptor[] }>(
        `/api/providers/drivers?domain=${domain}`,
      );
      return response.drivers ?? [];
    },
    refetchOnMount: 'always',
  });

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
    if (!driversQuery.isError) {
      return;
    }

    const error = driversQuery.error;
    const message = error instanceof Error ? error.message : 'Unexpected error';
    notifications.show({
      color: 'red',
      title: 'Unable to load drivers',
      message,
    });
  }, [driversQuery.isError, driversQuery.error]);

  const createProviderMutation = useMutation({
    mutationFn: async (options: ProviderConfigModalSubmitPayload) => {
      const payload: Record<string, unknown> = {
        key: options.values.base.key,
        label: options.values.base.label,
        description: options.values.base.description,
        driver: options.driver,
        type: domain,
        status: options.values.base.status,
        credentials: options.values.credentials,
        settings: options.values.settings,
        metadata: options.values.metadata,
      };

      await apiRequest('/api/providers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      return options;
    },
    onSuccess: async (_, variables) => {
      notifications.show({
        color: 'green',
        title: 'Provider created',
        message: `${variables.values.base.label} is now available.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['providers', domain] });
    },
  });

  const updateProviderMutation = useMutation({
    mutationFn: async (options: ProviderConfigModalSubmitPayload) => {
      if (!options.providerId) {
        throw new Error('Provider identifier missing');
      }

      const payload: Record<string, unknown> = {
        label: options.values.base.label,
        description: options.values.base.description,
        status: options.values.base.status,
        settings: options.values.settings,
        metadata: options.values.metadata,
      };

      if (Object.keys(options.values.credentials).length > 0) {
        payload.credentials = options.values.credentials;
      }

      await apiRequest(`/api/providers/${options.providerId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });

      return options;
    },
    onSuccess: async (_, variables) => {
      notifications.show({
        color: 'green',
        title: 'Provider updated',
        message: `${variables.values.base.label} was updated successfully.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['providers', domain] });
    },
  });

  const deleteProviderMutation = useMutation({
    mutationFn: async (provider: ProviderConfigView) => {
      await apiRequest(`/api/providers/${provider._id}`, {
        method: 'DELETE',
        parseJson: false,
      });
      return provider;
    },
    onSuccess: async (_, provider) => {
      notifications.show({
        color: 'green',
        title: 'Provider deleted',
        message: `${provider.label} has been removed.`,
      });
      await queryClient.invalidateQueries({ queryKey: ['providers', domain] });
    },
    onError: (error) => {
      console.error(error);
      const message =
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Unexpected error';
      notifications.show({
        color: 'red',
        title: 'Failed to delete provider',
        message,
      });
    },
  });

  const providers = providersQuery.data ?? [];
  const drivers = driversQuery.data ?? [];
  const loadingProviders = providersQuery.isFetching;
  const loadingDrivers = driversQuery.isFetching;
  const combinedLoading = providersQuery.isPending && providers.length === 0;

  const handleDelete = (provider: ProviderConfigView) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete provider "${provider.label}"?`,
    );
    if (!confirmed || deleteProviderMutation.isPending) {
      return;
    }

    deleteProviderMutation.mutate(provider);
  };

  const modalProps = modalState
    ? {
        opened: true,
        mode: modalState.mode,
        provider: modalState.mode === 'edit' ? modalState.provider : undefined,
      }
    : { opened: false };

  return (
    <SectionCard title={title} description={description}>
      <Stack gap="md">
        {combinedLoading ? (
          <LoadingState label="Loading providers..." minHeight={200} />
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
            await updateProviderMutation.mutateAsync(options);
          } else {
            await createProviderMutation.mutateAsync(options);
          }
        }}
      />
    </SectionCard>
  );
}
