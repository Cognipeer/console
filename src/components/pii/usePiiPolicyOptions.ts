'use client';

import { useEffect, useState } from 'react';
import type { PiiPolicyOption, PiiPolicyOptions } from './piiProtectionForm';

/**
 * The project's PII policies, for the protection picker. Unfiltered on purpose: a policy switched off AFTER it was
 * chosen must still resolve to its name, and be flagged, instead of reading as deleted.
 */
export function usePiiPolicyOptions(enabled = true): PiiPolicyOptions {
  const [state, setState] = useState<PiiPolicyOptions>({ policies: [], loading: enabled, failed: false });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, failed: false }));
    (async () => {
      try {
        const res = await fetch('/api/pii/policies', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { policies?: Array<Record<string, unknown>> };
        const policies: PiiPolicyOption[] = (data.policies ?? [])
          .filter((p) => typeof p.key === 'string' && p.key)
          .map((p) => ({
            id: String(p.id ?? p._id ?? p.key),
            key: String(p.key),
            name: typeof p.name === 'string' && p.name ? p.name : String(p.key),
            enabled: p.enabled !== false,
            engine: typeof p.engine === 'string' ? p.engine : undefined,
          }));
        if (!cancelled) setState({ policies, loading: false, failed: false });
      } catch {
        if (!cancelled) setState({ policies: [], loading: false, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
