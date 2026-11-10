'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ProviderDescriptor, ProviderFormSchema } from '@/lib/providers/types';
import { instanceBehaviorForm, isHostedProvider, type WebSearchProviderOption } from './webSearchModel';

/**
 * The form an instance's search options are edited with, for the provider it searches through (see
 * `instanceBehaviorForm`). Loads the web search drivers once, and the driver's own form when the provider is not a
 * hosted one. `form` is null until it can be told; `failed` says a load did not succeed.
 */
export function useInstanceOptionsForm(
  provider: Pick<WebSearchProviderOption, 'driver' | 'platform'> | null,
  enabled: boolean,
): { form: ProviderFormSchema | null; failed: boolean } {
  const [drivers, setDrivers] = useState<ProviderDescriptor[] | null>(null);
  const [driversFailed, setDriversFailed] = useState(false);
  const [driverForm, setDriverForm] = useState<{ driver: string; schema: ProviderFormSchema } | null>(null);
  const [failedDriver, setFailedDriver] = useState<string | null>(null);

  const driver = provider?.driver ?? null;
  const platform = provider?.platform === true;
  const formDriver = driver && drivers && !isHostedProvider({ driver, platform }, drivers) ? driver : null;

  useEffect(() => {
    if (!enabled || drivers !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/websearch/providers/drivers', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { drivers?: ProviderDescriptor[] };
        if (!cancelled) setDrivers(body.drivers ?? []);
      } catch {
        if (!cancelled) setDriversFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, drivers]);

  useEffect(() => {
    if (!enabled || !formDriver || driverForm?.driver === formDriver) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/providers/drivers/${encodeURIComponent(formDriver)}/form`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { schema?: ProviderFormSchema };
        if (!cancelled) setDriverForm({ driver: formDriver, schema: body.schema ?? { sections: [] } });
      } catch {
        if (!cancelled) setFailedDriver(formDriver);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, formDriver, driverForm]);

  // Built from plain values, so the form keeps its identity while the provider stays the same: the caller resets
  // the entered options when it changes.
  const form = useMemo(() => {
    if (!driver || !drivers) return null;
    const loaded = driverForm?.driver === driver ? driverForm.schema : null;
    return instanceBehaviorForm({ driver, platform }, drivers, loaded);
  }, [driver, platform, drivers, driverForm]);

  return { form, failed: driversFailed || (formDriver !== null && failedDriver === formDriver) };
}
