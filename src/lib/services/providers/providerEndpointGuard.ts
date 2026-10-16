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

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `host:port`, `[v6]:port` or a bare IPv6 address, without the port. */
function bareHost(entry: string): string {
  const host = decodeSafe(entry.trim());
  if (host.startsWith('[')) return host.replace(/\]:\d+$/, ']');
  if ((host.match(/:/g) ?? []).length > 1) return `[${host}]`;
  return host.replace(/:\d+$/, '');
}

/**
 * What a `scheme://` connection string names: the hosts to vet, and whether that list is
 * complete. `null` for any other value (http(s) URLs are vetted as URLs).
 */
function scanConnectionString(value: string): { hosts: string[]; unvettable: boolean } | null {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!scheme) return null;
  const protocol = `${scheme[1].toLowerCase()}:`;
  if (protocol === 'http:' || protocol === 'https:') return null;
  // `+srv` names a DNS service record, and other schemes are not read here: neither can be vetted
  if (!CONNECTION_SCHEMES.has(protocol)) return { hosts: [], unvettable: true };

  // userinfo@host1:port,host2:port/db?options
  const rest = trimmed.slice(scheme[0].length);
  let authority = rest.split(/[/?#]/, 1)[0];
  authority = authority.slice(authority.lastIndexOf('@') + 1);
  const hosts = authority.split(',').map(bareHost).filter(Boolean);
  // drivers also take the host from the options (libpq `host` / `hostaddr`), and those win over the authority
  const query = /\?([^#]*)/.exec(rest)?.[1] ?? '';
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    const key = decodeSafe(at === -1 ? pair : pair.slice(0, at)).trim().toLowerCase();
    if (at === -1 || (key !== 'host' && key !== 'hostaddr')) continue;
    hosts.push(...decodeSafe(pair.slice(at + 1).replace(/\+/g, ' ')).split(',').map(bareHost).filter(Boolean));
  }
  // no host = the driver's default (localhost); a path = a local socket
  const sockets = hosts.filter((host) => host.startsWith('/'));
  return { hosts: hosts.filter((host) => !host.startsWith('/')), unvettable: hosts.length === 0 || sockets.length > 0 };
}

/**
 * True when a connection string cannot be vetted: a `+srv` record, a scheme this guard does not
 * read, no host (the driver's default) or a local socket.
 */
export function hasUnvettableEndpoint(...sources: Array<Record<string, unknown> | undefined>): boolean {
  return sources.some((source) =>
    Object.values(source ?? {}).some((value) => typeof value === 'string' && scanConnectionString(value)?.unvettable === true),
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
        : scanConnectionString(trimmed)?.hosts ?? [];
      for (const host of hosts) await assertEndpoint(field, `https://${host}`, guardOptions);
    }
  }
}
