/**
 * The outbound policy for provider calls made at request time (model, embedding, image, speech, moderation, OCR and
 * web search runtimes), chosen by `PROVIDER_RUNTIME_GUARD`.
 *
 * `enforce`: the deployment's guard options apply and a redirect is handed back instead of followed.
 * `warn`: the request takes the same path it took before this setting existed (plain `fetch`), and the policy is
 * evaluated beside it: a target it would refuse is logged (once per host every ten minutes). Evaluating the policy
 * never fails or delays the call in this mode.
 *
 * The organization is read from the request context by the callers; a call without one (a background job) is judged
 * with no private networks opened.
 */
import { getConfig } from '@/lib/core/config';
import { createLogger } from '@/lib/core/logger';
import { assertPublicUrl, privateNetworkBlockApplies, type SafeFetchOptions } from '@/lib/security/outboundFetch';
import { endpointGuardOptions } from '@/lib/services/providers/providerEndpointGuard';

const logger = createLogger('provider-runtime-guard');

const WARN_INTERVAL_MS = 10 * 60 * 1000;
const MAX_TRACKED_HOSTS = 1000;
const lastWarnedAt = new Map<string, number>();

function shouldWarn(host: string, now: number): boolean {
  const last = lastWarnedAt.get(host);
  if (last !== undefined && now - last < WARN_INTERVAL_MS) return false;
  if (lastWarnedAt.size >= MAX_TRACKED_HOSTS) {
    for (const [key, at] of lastWarnedAt) {
      if (now - at >= WARN_INTERVAL_MS) lastWarnedAt.delete(key);
    }
    if (lastWarnedAt.size >= MAX_TRACKED_HOSTS) lastWarnedAt.clear();
  }
  lastWarnedAt.set(host, now);
  return true;
}

/** Options for `safeFetch` for a provider call to `url` made for `tenantId` (when known), per `PROVIDER_RUNTIME_GUARD`. */
export async function providerRuntimeGuardOptions(
  url: string,
  tenantId: string | undefined,
): Promise<Pick<SafeFetchOptions, 'allowPrivate' | 'forceBlock' | 'privateNetworks' | 'followRedirects'>> {
  const base = endpointGuardOptions(tenantId);
  if (getConfig().outboundHttp.providerRuntimeGuard !== 'warn') {
    return { ...base, followRedirects: false };
  }

  let host = '';
  try {
    host = new URL(url).hostname;
    if (!privateNetworkBlockApplies(host, base)) return { ...base };
    await assertPublicUrl(url, base);
    return { ...base };
  } catch (error) {
    // Only a refusal of the guard is reported; any other failure while evaluating leaves the call as it is.
    if (!(error instanceof Error) || error.name !== 'OutboundNetworkError') return { ...base };
    if (shouldWarn(host || 'unparsed', Date.now())) {
      logger.warn('Provider call target would be refused by the outbound guard; allowed while PROVIDER_RUNTIME_GUARD=warn', {
        ...(tenantId ? { tenantId } : {}),
        host: host || undefined,
        reason: error.message,
      });
    }
    return { allowPrivate: true };
  }
}

/** True while `PROVIDER_RUNTIME_GUARD=warn`: the policy is observed and logged, the request is not held to it. */
export function providerRuntimeGuardObserves(): boolean {
  return getConfig().outboundHttp.providerRuntimeGuard === 'warn';
}

/**
 * Evaluates the policy for a request that has already gone ahead and logs a refusal (see
 * `providerRuntimeGuardOptions`). Never throws and is not awaited by the caller.
 */
export function observeProviderTarget(url: string, tenantId: string | undefined): void {
  void providerRuntimeGuardOptions(url, tenantId).catch(() => undefined);
}
