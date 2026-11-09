'use client';

import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import CreateModelModal from '@/components/models/CreateModelModal';
import ModelProviderModal from '@/components/models/ModelProviderModal';
import { resolveProviderCategories } from '@/components/models/catalog/catalogPrefill';
import type { ModelProviderView } from '@/lib/services/models/types';
import type { IModel } from '@/lib/database';

type ModelCategory = NonNullable<ComponentProps<typeof CreateModelModal>['defaultCategory']>;

/**
 * "+ Add model" inside another form (an agent's model, a knowledge base's embedding model): Model Hub's own create
 * form, opened over the form the person is filling. A project without a provider gets "Add provider", whose form
 * opens on top of the model form (which stays as it was); the provider created there is selected in the model form.
 * The created model is handed back so the picker can list and select it at once.
 */
export default function InlineModelCreate({
  opened,
  onClose,
  category,
  onCreated,
}: {
  opened: boolean;
  onClose: () => void;
  category?: ModelCategory;
  onCreated: (model: IModel) => void;
}) {
  const [providers, setProviders] = useState<ModelProviderView[]>([]);
  const [addingProvider, setAddingProvider] = useState(false);
  const [providerKey, setProviderKey] = useState<string | undefined>();
  // The form starts on the first provider, which may not serve the category asked for (an embedding model on an
  // Anthropic provider): start on one that does, unless a provider was just added here.
  const startProviderKey = useMemo(() => {
    if (providerKey) return providerKey;
    if (!category) return undefined;
    return providers.find((provider) => resolveProviderCategories(provider).includes(category))?.key;
  }, [providerKey, category, providers]);

  useEffect(() => {
    if (!opened) return;
    setAddingProvider(false);
    setProviderKey(undefined);
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/models?includeProviders=true', { cache: 'no-store' });
        const data = response.ok ? await response.json() : {};
        if (!cancelled) setProviders((data.providers ?? []) as ModelProviderView[]);
      } catch {
        if (!cancelled) setProviders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opened]);

  return (
    <>
      <CreateModelModal
        opened={opened}
        onClose={onClose}
        providers={providers}
        defaultCategory={category}
        defaultProviderKey={startProviderKey}
        onAddProvider={() => setAddingProvider(true)}
        onCreated={({ model }) => onCreated(model)}
      />
      {/* Rendered after the model form, so its overlay is the top one (Escape closes it alone). */}
      <ModelProviderModal
        opened={opened && addingProvider}
        onClose={() => setAddingProvider(false)}
        onCreated={(provider) => {
          setProviders((current) =>
            current.some((p) => p.key === provider.key) ? current : [...current, provider],
          );
          setProviderKey(provider.key);
          setAddingProvider(false);
        }}
      />
    </>
  );
}
