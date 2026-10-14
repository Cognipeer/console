'use client';

import { useEffect, useState } from 'react';
import { NO_POLICY, normalizeTokenPolicy, type TokenPolicyView } from './tokenModel';

export interface TokenPolicyState {
  policy: TokenPolicyView;
  /** A read is in flight. */
  loading: boolean;
  /** The latest read finished (successfully or not); false from the moment the form opens until then. */
  ready: boolean;
  /** The rules could not be read; the form then shows no limits and the server still enforces them. */
  failed: boolean;
}

/**
 * The tenant's token rules (`GET /api/tokens/policy`) for a create / edit form.
 * That route needs only the `tokens` service, so a person minting their own
 * token can read the limits without any Authorization engine permission. The
 * request runs when the form opens and again on every re-open, so a rule
 * changed in the meantime is picked up.
 */
export function useTokenPolicy(enabled: boolean): TokenPolicyState {
  const [state, setState] = useState<TokenPolicyState>({ policy: NO_POLICY, loading: false, ready: false, failed: false });

  useEffect(() => {
    if (!enabled) {
      setState((previous) => (previous.ready ? { ...previous, ready: false } : previous));
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({ ...previous, loading: true, ready: false, failed: false }));
    (async () => {
      try {
        const response = await fetch('/api/tokens/policy', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const policy = normalizeTokenPolicy(await response.json());
        setState({ policy, loading: false, ready: true, failed: false });
      } catch (error) {
        if ((error as { name?: string })?.name === 'AbortError') return;
        setState({ policy: NO_POLICY, loading: false, ready: true, failed: true });
      }
    })();
    return () => controller.abort();
  }, [enabled]);

  return state;
}
