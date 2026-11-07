'use client';

import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import CreateModelModal from '@/components/models/CreateModelModal';
import ModelProviderModal from '@/components/models/ModelProviderModal';
import { resolveProviderCategories } from '@/components/models/catalog/catalogPrefill';
import type { ModelProviderView } from '@/lib/services/models/types';
import type { IModel } from '@/lib/database';

type ModelCategory = NonNullable<ComponentProps<typeof CreateModelModal>['defaultCategory']>;

/**
 * "+ Add model" inside another form (an agent's model, a knowledge base's embedding model): Model Hub's own create
 * form, opened over the form the person is filling. A project without a provider gets "Add provider" on top, then
 * comes back to the model form with that provider chosen. The created model is handed back so the picker can list
 * and select it at once.
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
  const [step, setStep] = useState<'model' | 'provider'>('model');
  const [providerKey, setProviderKey] = useState<string | undefined>();
  // Set by "Add provider", which closes the model form too: that close is not a cancel.
  const switchingRef = useRef(false);
  // The form starts on the first provider, which may not serve the category asked for (an embedding model on an
  // Anthropic provider): start on one that does, unless a provider was just added here.
  const startProviderKey = useMemo(() => {
    if (providerKey) return providerKey;
    if (!category) return undefined;
    return providers.find((provider) => resolveProviderCategories(provider).includes(category))?.key;
  }, [providerKey, category, providers]);

  useEffect(() => {
    if (!opened) return;
    setStep('model');
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
        opened={opened && step === 'model'}
        onClose={() => {
          if (switchingRef.current) {
            switchingRef.current = false;
            return;
          }
          onClose();
        }}
        providers={providers}
        defaultCategory={category}
        defaultProviderKey={startProviderKey}
        onAddProvider={() => {
          switchingRef.current = true;
          setStep('provider');
        }}
        onCreated={({ model }) => onCreated(model)}
      />
      <ModelProviderModal
        opened={opened && step === 'provider'}
        onClose={() => setStep('model')}
        onCreated={(provider) => {
          setProviders((current) =>
            current.some((p) => p.key === provider.key) ? current : [...current, provider],
          );
          setProviderKey(provider.key);
          setStep('model');
        }}
      />
    </>
  );
}
