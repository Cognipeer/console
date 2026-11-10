'use client';

import { useCallback, useEffect, useState } from 'react';
import { notifications } from '@mantine/notifications';
import type { ProviderDescriptor } from '@/lib/providers/types';
import type { WebSearchInstanceView } from '@/lib/services/webSearch/webSearchInstanceView';
import { useTranslations } from '@/lib/i18n';
import ProviderConfigModal, { type CreatedProviderSummary } from '@/components/providers/ProviderConfigModal';
import { useTenantProjects } from '@/components/providers/ProviderAssignStep';
import { providerRequestError } from '@/components/providers/providerFormModel';
import WebSearchInstanceFormModal from './WebSearchInstanceFormModal';
import type { WebSearchProviderOption } from './webSearchModel';

const WEBSEARCH_DOMAIN = 'websearch' as const;

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
  const [providers, setProviders] = useState<WebSearchProviderOption[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerKey, setProviderKey] = useState<string | null>(null);

  const [providerFormOpen, setProviderFormOpen] = useState(false);
  const [drivers, setDrivers] = useState<ProviderDescriptor[]>([]);
  const [driversLoading, setDriversLoading] = useState(false);
  // A new provider is assigned to the project the instance is made in.
  const { activeProjectId } = useTenantProjects(opened);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const res = await fetch(`/api/providers?type=${WEBSEARCH_DOMAIN}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { providers?: WebSearchProviderOption[] };
      setProviders(body.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!opened) return;
    setResetKey((current) => current + 1);
    setProviderKey(initialProviderKey);
    setProviderFormOpen(false);
    void loadProviders();
    // A create starts from the provider it was opened for; a change of that while it is open is not one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, loadProviders]);

  const openProviderForm = async () => {
    setProviderFormOpen(true);
    setDriversLoading(true);
    try {
      const res = await fetch('/api/websearch/providers/drivers', { cache: 'no-store' });
      const body = res.ok ? ((await res.json()) as { drivers?: ProviderDescriptor[] }) : null;
      setDrivers(body?.drivers ?? []);
    } finally {
      setDriversLoading(false);
    }
  };

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
        onNewProvider={() => void openProviderForm()}
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
          const res = await fetch('/api/providers?scope=tenant', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
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
            }),
          });
          const body = await res.json().catch(() => null);
          // The refusal names the form field it is about: the provider form marks it.
          if (!res.ok) throw providerRequestError(body, t('providerCreateFailed'));
          const created = body?.provider as { _id?: string; key?: string; label?: string } | undefined;
          const key = String(created?.key ?? options.values.base.key);
          notifications.show({ color: 'teal', title: t('providerCreated'), message: created?.label ?? key });
          await loadProviders();
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
