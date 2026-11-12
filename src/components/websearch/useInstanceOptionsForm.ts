'use client';

import { useMemo } from 'react';
import type { ProviderFormSchema } from '@/lib/providers/types';
import { useProviderDriverForm } from '@/lib/api/queries/providers';
import { useWebSearchDrivers } from '@/lib/api/queries/websearch';
import { instanceBehaviorForm, isHostedProvider, type WebSearchProviderOption } from './webSearchModel';

/** A driver whose form came back without sections. */
const EMPTY_FORM: ProviderFormSchema = { sections: [] };

/**
 * The form an instance's search options are edited with, for the provider it searches through (see
 * `instanceBehaviorForm`). Loads the web search drivers once, and the driver's own form when the provider is not a
 * hosted one. `form` is null until it can be told; `failed` says a load did not succeed.
 */
export function useInstanceOptionsForm(
  provider: Pick<WebSearchProviderOption, 'driver' | 'platform'> | null,
  enabled: boolean,
): { form: ProviderFormSchema | null; failed: boolean } {
  const driversQuery = useWebSearchDrivers(enabled);
  const drivers = driversQuery.data ?? null;

  const driver = provider?.driver ?? null;
  const platform = provider?.platform === true;
  const formDriver = driver && drivers && !isHostedProvider({ driver, platform }, drivers) ? driver : null;
  const formQuery = useProviderDriverForm<ProviderFormSchema>(formDriver ?? '', enabled && formDriver !== null);
  const driverSchema = formDriver && formQuery.isSuccess ? (formQuery.data ?? EMPTY_FORM) : null;

  // Built from plain values, so the form keeps its identity while the provider stays the same: the caller resets
  // the entered options when it changes.
  const form = useMemo(() => {
    if (!driver || !drivers) return null;
    return instanceBehaviorForm({ driver, platform }, drivers, driver === formDriver ? driverSchema : null);
  }, [driver, platform, drivers, formDriver, driverSchema]);

  return { form, failed: driversQuery.isError || (formDriver !== null && formQuery.isError) };
}
