'use client';

import { useTokenPolicyQuery } from '@/lib/api/queries/tokens';
import { NO_POLICY, type TokenPolicyView } from './tokenModel';

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
  const query = useTokenPolicyQuery(enabled);
  // A read is in flight from the moment the form opens until it answers (a cached answer of an earlier open is
  // shown meanwhile, as the form's own state did, but `ready` waits for the new one).
  const loading = enabled && query.isFetching;
  const ready = enabled && !query.isFetching;
  const failed = ready && query.isError;
  return { policy: failed || query.data === undefined ? NO_POLICY : query.data, loading, ready, failed };
}
