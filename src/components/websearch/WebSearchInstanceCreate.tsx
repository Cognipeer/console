'use client';

import { useEffect, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { ProviderDescriptor } from '@/lib/providers/types';
import type { WebSearchInstanceView } from '@/lib/services/webSearch/webSearchInstanceView';
import { useTranslations } from '@/lib/i18n';
import ProviderConfigModal, { type CreatedProviderSummary } from '@/components/providers/ProviderConfigModal';
import { useTenantProjects } from '@/components/providers/ProviderAssignStep';
import { providerRequestError } from '@/components/providers/providerFormModel';
import { isApiError } from '@/lib/api/client';
import { useCreateProvider, useProvidersOfType } from '@/lib/api/queries/providers';
import { useWebSearchDrivers } from '@/lib/api/queries/websearch';
import WebSearchInstanceFormModal from './WebSearchInstanceFormModal';
import type { WebSearchProviderOption } from './webSearchModel';

const WEBSEARCH_DOMAIN = 'websearch' as const;
const NO_PROVIDERS: WebSearchProviderOption[] = [];
const NO_DRIVERS: ProviderDescriptor[] = [];

export interface WebSearchInstanceCreateProps {
  /** Owners and admins only: the API refuses a create from anyone else. */
  opened: boolean;
  onClose: () => void;
  /** The provider picked when the form opens (a provider that has no instance yet). */
  initialProviderKey?: string | null;
  onCreated: (instance: WebSearchInstanceView) => void;
}

/**
 * Creating an instance: the instance form, over the web search providers of the project. "New provider" steps aside
 * to the provider form (connection only, assigned to this project unless changed there) and comes back with the new
 * provider picked and what was typed kept.
 */
export default function WebSearchInstanceCreate({
  opened,
  onClose,
  initialProviderKey = null,
  onCreated,
}: WebSearchInstanceCreateProps) {
  const t = useTranslations('webSearch.form');
  const [resetKey, setResetKey] = useState(0);
  const providersQuery = useProvidersOfType<WebSearchProviderOption>(WEBSEARCH_DOMAIN, opened);
  const providers = providersQuery.data ?? NO_PROVIDERS;
  const providersLoading = opened && providersQuery.isFetching;
  const createProvider = useCreateProvider();
  const [providerKey, setProviderKey] = useState<string | null>(null);

  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const driversQuery = useWebSearchDrivers(providerFormOpen);
  const drivers = driversQuery.data ?? NO_DRIVERS;
  const driversLoading = providerFormOpen && driversQuery.isFetching;
  // A new provider is assigned to the project the instance is made in.
  const { activeProjectId } = useTenantProjects(opened);

  useEffect(() => {
    if (!opened) return;
    setResetKey((current) => current + 1);
    setProviderKey(initialProviderKey);
    setProviderFormOpen(false);
    // A create starts from the provider it was opened for; a change of that while it is open is not one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  return (
    <>
      <WebSearchInstanceFormModal
        opened={opened && !providerFormOpen}
        onClose={onClose}
        mode="create"
        providers={providers}
        providersLoading={providersLoading}
        providerKey={providerKey}
        onProviderKeyChange={setProviderKey}
        onNewProvider={() => setProviderFormOpen(true)}
        canSetTenantWide
        resetKey={resetKey}
        onSaved={onCreated}
      />
      <ProviderConfigModal
        opened={opened && providerFormOpen}
        onClose={() => setProviderFormOpen(false)}
        mode="create"
        drivers={drivers}
        driversLoading={driversLoading}
        domain={WEBSEARCH_DOMAIN}
        initialProjectIds={activeProjectId ? [activeProjectId] : []}
        onSubmit={async (options): Promise<CreatedProviderSummary> => {
          let created: { _id?: string; key?: string; label?: string } | undefined;
          try {
            created = await createProvider.mutateAsync({
              key: options.values.base.key,
              label: options.values.base.label,
              description: options.values.base.description,
              driver: options.driver,
              type: WEBSEARCH_DOMAIN,
              status: options.values.base.status,
              credentials: options.values.credentials,
              settings: options.values.settings,
              metadata: options.values.metadata,
              projectIds: options.projectIds,
            });
          } catch (error) {
            // The refusal names the form field it is about: the provider form marks it.
            throw providerRequestError(isApiError(error) ? error.payload : null, t('providerCreateFailed'));
          }
          const key = String(created?.key ?? options.values.base.key);
          notifications.show({ color: 'teal', title: t('providerCreated'), message: created?.label ?? key });
          setProviderKey(key);
          // The provider form closes itself (after its assign step, when no project was picked).
          return {
            id: String(created?._id),
            name: String(created?.label ?? options.values.base.label),
            domain: WEBSEARCH_DOMAIN,
            key,
          };
        }}
      />
    </>
  );
}
