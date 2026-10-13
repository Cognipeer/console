import { getConfig } from '@/lib/core/config';
import { assertPublicUrl, OutboundNetworkError } from '@/lib/security/outboundFetch';
import type { ProviderDomain } from '@/lib/database';

export const PROVIDER_ENDPOINT_NOT_ALLOWED = 'provider_endpoint_not_allowed';

/** Thrown when a provider endpoint setting fails validation. Maps to HTTP 400. */
export class ProviderEndpointError extends Error {
  readonly code = PROVIDER_ENDPOINT_NOT_ALLOWED;
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Provider endpoint "${field}" is not allowed: ${reason}`);
    this.name = 'ProviderEndpointError';
    this.field = field;
  }
}

/** Inference-style provider domains whose endpoints are user-supplied. */
const GUARDED_DOMAINS = new Set(['model', 'embedding', 'image', 'stt', 'tts', 'moderation', 'decision']);
const URL_FIELDS = new Set(['baseUrl', 'baseURL', 'endpoint', 'apiBase', 'apiUrl', 'url']);
const AZURE_RESOURCE_LABEL = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/i;

/**
 * Validates every user-supplied endpoint of a model-type provider.
 *
 * SaaS: the outbound guard is always enforced (private, loopback and link-local
 * targets are rejected). On-prem: the deployment's
 * OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK / OUTBOUND_HTTP_ALLOWED_HOSTS settings
 * decide, so in-network servers keep working when the operator allows them.
 */
export async function assertProviderEndpointsAllowed(
  type: ProviderDomain | string | undefined,
  ...sources: Array<Record<string, unknown> | undefined>
): Promise<void> {
  if (!type || !GUARDED_DOMAINS.has(type)) return;
  const enforce = !getConfig().deployment.isOnPrem;

  for (const source of sources) {
    if (!source) continue;
    for (const [field, value] of Object.entries(source)) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      if (field === 'instanceName') {
        if (!AZURE_RESOURCE_LABEL.test(value.trim())) {
          throw new ProviderEndpointError(field, 'must be a plain resource name');
        }
        continue;
      }
      if (!URL_FIELDS.has(field)) continue;
      try {
        await assertPublicUrl(value.trim(), enforce ? { forceBlock: true } : undefined);
      } catch (error) {
        if (error instanceof OutboundNetworkError) {
          throw new ProviderEndpointError(field, error.message);
        }
        throw error;
      }
    }
  }
}
