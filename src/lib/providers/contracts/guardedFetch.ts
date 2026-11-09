/**
 * `fetch` for provider runtimes: every call is checked against the outbound guard of the deployment at call time
 * (the target addresses are validated and pinned for the connection, redirects are handed back instead of followed;
 * with `PROVIDER_RUNTIME_GUARD=warn` the call takes the plain `fetch` path and a refused target is only logged, see
 * `runtimeGuard`),
 * so a stored endpoint is vetted on each request and not only when the provider is saved.
 *
 * The organization is read from the request context when the call is made: it decides which private networks the
 * operator has opened (see `endpointGuardOptions`). Without one, none are opened.
 */
import { getRequestContext } from '@/lib/core/requestContext';
import { safeFetch } from '@/lib/security/outboundFetch';
import {
  observeProviderTarget,
  providerRuntimeGuardObserves,
  providerRuntimeGuardOptions,
} from '@/lib/services/providers/runtimeGuard';

/** Upper bound on the wait for response headers; the provider SDKs and runtimes apply their own, shorter, budgets. */
const PROVIDER_HEADERS_TIMEOUT_MS = 600_000;

export type GuardedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createGuardedFetch(): GuardedFetch {
  return async (input, init) => {
    let url: string;
    let requestInit = init;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
      requestInit = {
        method: input.method,
        headers: input.headers,
        ...(input.body ? { body: input.body, duplex: 'half' } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...init,
      } as RequestInit;
    }
    const tenantId = getRequestContext()?.tenantId;
    if (providerRuntimeGuardObserves()) {
      observeProviderTarget(url, tenantId);
      return fetch(input, init);
    }
    return safeFetch(url, requestInit, {
      ...(await providerRuntimeGuardOptions(url, tenantId)),
      timeoutMs: PROVIDER_HEADERS_TIMEOUT_MS,
      keepAbortLinked: true,
      sensitiveHeaders: ['x-api-key', 'api-key', 'openai-organization'],
    });
  };
}

/** Shared instance for runtimes that have no transport of their own. */
export const guardedFetch: GuardedFetch = createGuardedFetch();
