import { getConfig, getConfigSource } from '@/lib/core/config';
import {
  assertPublicUrl,
  OutboundNetworkError,
  privateNetworkBlockApplies,
  type OutboundGuardOptions,
} from '@/lib/security/outboundFetch';
import type { ProviderDomain } from '@/lib/database';

export const PROVIDER_ENDPOINT_NOT_ALLOWED = 'provider_endpoint_not_allowed';

/**
 * Thrown when a provider endpoint setting fails validation. Maps to HTTP 400. An endpoint the policy refuses stays
 * refused, so the error declares itself not retryable (`withResilience` and the file circuit breaker read `retryable`).
 */
export class ProviderEndpointError extends Error {
  readonly code = PROVIDER_ENDPOINT_NOT_ALLOWED;
  readonly field: string;
  readonly retryable = false;

  constructor(field: string, reason: string) {
    super(`Provider endpoint "${field}" is not allowed: ${reason}`);
    this.name = 'ProviderEndpointError';
    this.field = field;
  }
}

/** Provider domains whose endpoints are user-supplied: the inference services and the file stores (S3-compatible, Azure Blob). */
const GUARDED_DOMAINS = new Set(['model', 'embedding', 'image', 'stt', 'tts', 'moderation', 'decision', 'file']);
const URL_FIELDS = new Set(['baseUrl', 'baseURL', 'endpoint', 'apiBase', 'apiUrl', 'url', 'authorityHost']);
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const AZURE_RESOURCE_LABEL = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/i;

/**
 * Validates every user-supplied endpoint of a model-type or file-store provider.
 *
 * SaaS: the outbound guard is always enforced (private, loopback and link-local
 * targets are rejected). On-prem: private and loopback endpoints are allowed by
 * default, since operators point providers at in-network servers (vLLM, Ollama,
 * LM Studio, GPU Fleet, MinIO, Azurite). They are blocked only when
 * OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK is explicitly set to true, in which case
 * OUTBOUND_HTTP_ALLOWED_HOSTS still exempts listed hosts. The raw env value is
 * read here on purpose; the global outbound default is unchanged.
 *
 * A file store takes a bare host as well (a pasted `account.blob.core.windows.net`,
 * `minio:9000`), which its client reads as https, so it is vetted as `https://<value>`. The URL parser also reads
 * `http:/host:9000`, `http:\\host` and `http:host:9000` as http URLs on that host, so a value that parses that way
 * is vetted as it is, too.
 *
 * A file store can also hold a connection string (`mongodb://...`) in any credential or setting: the hosts it names
 * are dialled, so they are vetted like an endpoint, and a form whose hosts cannot be read here (a `+srv` record, a
 * local socket) is refused while private targets are blocked, since it could name one.
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
      if (type === 'file') await assertConnectionStringTargets(field, value, guardOptions);
      if (!URL_FIELDS.has(field)) continue;
      const candidate = value.trim();
      if (type === 'file' && !HAS_SCHEME.test(candidate)) {
        await assertEndpoint(field, `https://${candidate}`, guardOptions);
        if (parsesAsHttpUrl(candidate)) await assertEndpoint(field, candidate, guardOptions);
        continue;
      }
      await assertEndpoint(field, candidate, guardOptions);
    }
  }
}

/** True when the URL parser reads `value` as an http(s) URL: it takes the web schemes with one slash, a backslash or none (`http:/host`). */
function parsesAsHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The hosts of a known connection-string scheme, vetted; see `assertProviderEndpointsAllowed`. Any other value is not looked at. */
async function assertConnectionStringTargets(
  field: string,
  value: string,
  guardOptions: OutboundGuardOptions | undefined,
): Promise<void> {
  const scan = scanConnectionString(value);
  if (!scan?.known) return;
  for (const host of scan.hosts) await assertEndpoint(field, `https://${host}`, guardOptions);
  if (scan.unvettable && privateNetworkBlockApplies('', guardOptions)) {
    throw new ProviderEndpointError(field, 'the connection string must list the hosts it connects to (a +srv record or a local socket cannot be checked)');
  }
}

/**
 * True when private targets are blocked for a host nothing names: the deployment refuses what it cannot check (a
 * `+srv` record, a local socket) instead of letting it through. SaaS always; on-prem only when it blocks private
 * networks, and then no allow-list entry can apply, since the host is not known.
 */
export function refusesUnvettableEndpoints(): boolean {
  return privateNetworkBlockApplies('', endpointGuardOptions());
}

/**
 * Vets one URL a provider would dial that does not sit in an endpoint field: a host named inside a
 * credential (an Azure connection string's `BlobEndpoint`, a Microsoft Entra authority). Same deployment
 * rules as `assertProviderEndpointsAllowed`; throws `ProviderEndpointError` naming `field`.
 */
export async function assertProviderUrlAllowed(field: string, url: string): Promise<void> {
  await assertEndpoint(field, url.trim(), endpointGuardOptions());
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
 * What a `scheme://` connection string names: the hosts to vet, whether that list is complete, and whether the
 * scheme is one of the connection-string schemes this guard reads (`mongodb+srv:` is: the same kind of string,
 * with its hosts behind a DNS record). `null` for any other value (http(s) URLs are vetted as URLs).
 */
function scanConnectionString(value: string): { hosts: string[]; unvettable: boolean; known: boolean } | null {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!scheme) return null;
  const protocol = `${scheme[1].toLowerCase()}:`;
  if (protocol === 'http:' || protocol === 'https:') return null;
  // `+srv` names a DNS service record, and other schemes are not read here: neither can be vetted
  if (!CONNECTION_SCHEMES.has(protocol)) {
    return { hosts: [], unvettable: true, known: CONNECTION_SCHEMES.has(protocol.replace(/\+srv:$/, ':')) };
  }

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
  return { hosts: hosts.filter((host) => !host.startsWith('/')), unvettable: hosts.length === 0 || sockets.length > 0, known: true };
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
      if (HOST_FIELDS.has(field) && !HAS_SCHEME.test(trimmed)) {
        // a list of `host[:port]`; one that parses as an http URL (`http:/host:9000`) is vetted as that, too
        for (const entry of trimmed.split(',').map((part) => part.trim())) {
          const host = entry.replace(/:\d+$/, '');
          if (host) await assertEndpoint(field, `https://${host}`, guardOptions);
          if (parsesAsHttpUrl(entry)) await assertEndpoint(field, entry, guardOptions);
        }
        continue;
      }
      for (const host of scanConnectionString(trimmed)?.hosts ?? []) {
        await assertEndpoint(field, `https://${host}`, guardOptions);
      }
    }
  }
}
