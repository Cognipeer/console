import { getConfig, getConfigSource } from '@/lib/core/config';
import { assertPublicUrl, OutboundNetworkError, type OutboundGuardOptions } from '@/lib/security/outboundFetch';
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
 * targets are rejected). On-prem: private and loopback endpoints are allowed by
 * default, since operators point providers at in-network servers (vLLM, Ollama,
 * LM Studio, GPU Fleet). They are blocked only when
 * OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK is explicitly set to true, in which case
 * OUTBOUND_HTTP_ALLOWED_HOSTS still exempts listed hosts. The raw env value is
 * read here on purpose; the global outbound default is unchanged.
 */
export async function assertProviderEndpointsAllowed(
  type: ProviderDomain | string | undefined,
  ...sources: Array<Record<string, unknown> | undefined>
): Promise<void> {
  if (!type || !GUARDED_DOMAINS.has(type)) return;
  const guardOptions = endpointGuardOptions();

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
      await assertEndpoint(field, value.trim(), guardOptions);
    }
  }
}

/** The outbound-guard mode of the deployment (see `assertProviderEndpointsAllowed`). */
export function endpointGuardOptions(): OutboundGuardOptions | undefined {
  const enforce = !getConfig().deployment.isOnPrem;
  const rawBlock = String(getConfigSource().get('OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK') ?? '').trim().toLowerCase();
  const onPremBlocks = rawBlock === 'true' || rawBlock === '1';
  return enforce
    ? { forceBlock: true }
    : onPremBlocks ? undefined : { allowPrivate: true };
}

async function assertEndpoint(field: string, url: string, guardOptions: OutboundGuardOptions | undefined): Promise<void> {
  try {
    await assertPublicUrl(url, guardOptions);
  } catch (error) {
    if (error instanceof OutboundNetworkError) {
      throw new ProviderEndpointError(field, error.message);
    }
    throw error;
  }
}

/** Fields that name a server without a scheme. */
const HOST_FIELDS = new Set(['host', 'hostname', 'address', 'server', 'node', 'nodes', 'brokers', 'endpoint', 'url']);
/** Connection-string schemes whose host part is an endpoint the console would dial. */
const CONNECTION_SCHEMES = new Set([
  'mongodb:', 'postgres:', 'postgresql:', 'redis:', 'rediss:', 'amqp:', 'amqps:', 'grpc:', 'grpcs:',
]);

/** Hosts a connection string (or a plain `host:port`) names. Empty when the value names none. */
function hostsOf(value: string): string[] {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!scheme) return [];
  const protocol = `${scheme[1].toLowerCase()}:`;
  if (protocol === 'http:' || protocol === 'https:') return [];
  if (!CONNECTION_SCHEMES.has(protocol)) return [];
  // userinfo@host1:port,host2:port/db?options
  let rest = trimmed.slice(scheme[0].length);
  rest = rest.split(/[/?#]/, 1)[0];
  rest = rest.slice(rest.lastIndexOf('@') + 1);
  return rest.split(',').map((entry) => entry.trim().replace(/:\d+$/, '')).filter(Boolean);
}

/** True when a connection string cannot be vetted (`mongodb+srv` names a DNS service record, not a host). */
export function hasUnvettableEndpoint(...sources: Array<Record<string, unknown> | undefined>): boolean {
  return sources.some((source) =>
    Object.values(source ?? {}).some((value) => typeof value === 'string' && /^[a-z]+\+srv:\/\//i.test(value.trim())),
  );
}

/**
 * Validates every endpoint a "Test connection" would dial, for ANY provider domain: http(s) URLs
 * (every string value that is one, whatever the field is called), the hosts of connection
 * strings and fields that name a server. Same deployment rules as `assertProviderEndpointsAllowed`.
 */
export async function assertProviderTestEndpointsAllowed(
  type: ProviderDomain | string | undefined,
  ...sources: Array<Record<string, unknown> | undefined>
): Promise<void> {
  const guardOptions = endpointGuardOptions();
  // The inference domains keep their own, stricter field rules (instance names, URL fields).
  await assertProviderEndpointsAllowed(type, ...sources);
  for (const source of sources) {
    if (!source) continue;
    for (const [field, value] of Object.entries(source)) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        await assertEndpoint(field, trimmed, guardOptions);
        continue;
      }
      const hosts = HOST_FIELDS.has(field) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
        ? trimmed.split(',').map((entry) => entry.trim().replace(/:\d+$/, '')).filter(Boolean)
        : hostsOf(trimmed);
      for (const host of hosts) await assertEndpoint(field, `https://${host}`, guardOptions);
    }
  }
}
