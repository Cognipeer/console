import { resolveSrv } from 'node:dns/promises';
import { getConfig, getConfigSource } from '@/lib/core/config';
import {
  assertPublicUrl,
  OutboundNetworkError,
  OutboundPrivateTargetError,
  privateNetworkBlockApplies,
  type OutboundGuardOptions,
} from '@/lib/security/outboundFetch';
import { getProviderPrivateNetworks } from '@/lib/security/providerPrivateNetworks';
import type { ProviderDomain } from '@/lib/database';

export const PROVIDER_ENDPOINT_NOT_ALLOWED = 'provider_endpoint_not_allowed';

/**
 * Thrown when a provider endpoint setting fails validation. Maps to HTTP 400. An endpoint the policy refuses stays
 * refused, so the error declares itself not retryable (`withResilience` and the file circuit breaker read `retryable`).
 * The one exception is a name that could not be resolved (`options.retryable`): that says nothing about the address and
 * may well succeed later, so the flag of the outbound error it comes from is kept.
 */
export class ProviderEndpointError extends Error {
  readonly code = PROVIDER_ENDPOINT_NOT_ALLOWED;
  readonly field: string;
  readonly retryable: boolean;

  constructor(field: string, reason: string, options?: { retryable?: boolean }) {
    super(`Provider endpoint "${field}" is not allowed: ${reason}`);
    this.name = 'ProviderEndpointError';
    this.field = field;
    this.retryable = options?.retryable === true;
  }
}

/**
 * Whose provider is being checked. The private networks an operator has opened (`PROVIDER_PRIVATE_NETWORKS`) belong
 * to an organization, so every check that can dial a private address needs the organization; `undefined` is allowed
 * and means none are opened (the check fails closed).
 */
export interface ProviderEndpointScope {
  readonly tenantId: string | undefined;
}

/** What a person is told when a private address is refused: neutral, and it names no URL, credential or range. */
const PRIVATE_TARGET_REASON = 'private network addresses are reachable only through networks the operator has opened for this organization';

/**
 * A refusal of the outbound guard as the error a person gets for a provider setting. A refused private address gets
 * the neutral reason above (the guard's own message is for logs); every other refusal keeps its message, and a name
 * that did not resolve (a resolver outage) keeps the `retryable` flag of the error it comes from. An error that is
 * not a refusal comes back unchanged.
 */
export function toProviderEndpointError(field: string, error: unknown): unknown {
  if (error instanceof OutboundPrivateTargetError) return new ProviderEndpointError(field, PRIVATE_TARGET_REASON);
  if (error instanceof OutboundNetworkError) return new ProviderEndpointError(field, error.message, { retryable: error.retryable });
  return error;
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
 * are dialled, so they are vetted like an endpoint. A `mongodb+srv://` string names them in a DNS record, which is
 * resolved here and every host in it vetted the same way; a form whose hosts cannot be read at all (a local socket)
 * is refused while private targets are blocked, since it could name one.
 *
 * Where private targets are blocked, a private address is still reachable when the operator has opened a network
 * that holds it for this organization (`scope.tenantId`, `PROVIDER_PRIVATE_NETWORKS`); see `endpointGuardOptions`.
 */
export async function assertProviderEndpointsAllowed(
  type: ProviderDomain | string | undefined,
  scope: ProviderEndpointScope,
  ...sources: Array<Record<string, unknown> | undefined>
): Promise<void> {
  if (!type || !GUARDED_DOMAINS.has(type)) return;
  await assertEndpointFields(type, endpointGuardOptions(scope.tenantId), sources, new Map());
}

/** The vetting of `assertProviderEndpointsAllowed`, for a domain that is already known to be guarded. */
async function assertEndpointFields(
  type: ProviderDomain | string,
  guardOptions: OutboundGuardOptions | undefined,
  sources: ReadonlyArray<Record<string, unknown> | undefined>,
  srvVetted: SrvVetted,
): Promise<void> {
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
      if (type === 'file') await assertConnectionStringTargets(field, value, guardOptions, srvVetted);
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
  srvVetted: SrvVetted,
): Promise<void> {
  const scan = scanConnectionString(value);
  if (!scan?.known) return;
  for (const host of scan.hosts) await assertEndpoint(field, `https://${host}`, guardOptions);
  if (scan.srv) await assertSrvTargets(field, scan.srv, guardOptions, srvVetted);
  if (scan.unvettable && privateNetworkBlockApplies('', guardOptions)) {
    throw new ProviderEndpointError(field, 'the connection string must list the hosts it connects to (a local socket, or a form this check cannot read, cannot be checked)');
  }
}

/**
 * True when private targets are blocked for a host nothing names: the deployment refuses what it cannot check (a
 * local socket, a connection string whose hosts cannot be read) instead of letting it through. SaaS always; on-prem
 * only when it blocks private networks, and then no allow-list entry can apply, since the host is not known.
 */
export function refusesUnvettableEndpoints(scope: ProviderEndpointScope): boolean {
  return privateNetworkBlockApplies('', endpointGuardOptions(scope.tenantId));
}

/**
 * Vets one URL a provider would dial that does not sit in an endpoint field: a host named inside a
 * credential (an Azure connection string's `BlobEndpoint`, a Microsoft Entra authority). Same deployment
 * rules as `assertProviderEndpointsAllowed`; throws `ProviderEndpointError` naming `field`.
 */
export async function assertProviderUrlAllowed(field: string, url: string, scope: ProviderEndpointScope): Promise<void> {
  await assertEndpoint(field, url.trim(), endpointGuardOptions(scope.tenantId));
}

/**
 * The outbound-guard mode of the deployment for one organization (see `assertProviderEndpointsAllowed`).
 *
 * - SaaS: private targets are always blocked.
 * - Self-hosted: allowed by default (`{ allowPrivate: true }`); blocked, with the allow-list still exempting listed
 *   hosts, when `OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK` is true.
 *
 * Wherever they are blocked, the options carry the private networks the operator has opened for `tenantId`
 * (`PROVIDER_PRIVATE_NETWORKS`), when it has any. With no organization, or none opened, the options are what they
 * were before that setting existed.
 */
export function endpointGuardOptions(tenantId: string | undefined): OutboundGuardOptions | undefined {
  const enforce = !getConfig().deployment.isOnPrem;
  const rawBlock = String(getConfigSource().get('OUTBOUND_HTTP_BLOCK_PRIVATE_NETWORK') ?? '').trim().toLowerCase();
  const onPremBlocks = rawBlock === 'true' || rawBlock === '1';
  if (!enforce && !onPremBlocks) return { allowPrivate: true };
  const privateNetworks = getProviderPrivateNetworks().forTenant(tenantId);
  if (enforce) return privateNetworks ? { forceBlock: true, privateNetworks } : { forceBlock: true };
  return privateNetworks ? { privateNetworks } : undefined;
}

async function assertEndpoint(field: string, url: string, guardOptions: OutboundGuardOptions | undefined): Promise<void> {
  try {
    await assertPublicUrl(url, guardOptions);
  } catch (error) {
    throw toProviderEndpointError(field, error);
  }
}

/* ------------------------------------------------------------------ */
/*  mongodb+srv                                                       */
/* ------------------------------------------------------------------ */

/**
 * A host name as a DNS name: letters, digits, `-`, `_` and dots, with no port, list, bracket or percent-encoding.
 * DNS allows more in a label; a name outside this is refused rather than parsed.
 */
const DNS_NAME = /^[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9_])?$/i;
const SRV_SERVICE_NAME = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/i;
const DEFAULT_SRV_SERVICE = 'mongodb';
const SRV_LOOKUP_TIMEOUT_MS = 5000;
/** A record that names more hosts than this is refused instead of being checked in part. */
const MAX_SRV_TARGETS = 64;

/** The SRV lookups of one validation, so a host named in two places is looked up once. */
type SrvVetted = Map<string, Promise<void>>;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Resolves the SRV record `_<service>._tcp.<host>` of a `mongodb+srv` connection string and vets every host it names
 * like an endpoint, under the same rule as every other target. No answer, a DNS failure, a host that cannot be read
 * or more hosts than `MAX_SRV_TARGETS` refuse the string (the check fails closed); the connection string itself is
 * never part of the message. Does nothing where private targets are not blocked for `host`.
 */
async function assertSrvTargets(
  field: string,
  srv: { host: string; serviceName: string },
  guardOptions: OutboundGuardOptions | undefined,
  vetted?: SrvVetted,
): Promise<void> {
  if (!privateNetworkBlockApplies(srv.host, guardOptions)) return;
  const key = `${field}\n${srv.serviceName}\n${srv.host}`;
  let pending = vetted?.get(key);
  if (!pending) {
    pending = vetSrvTargets(field, srv, guardOptions);
    vetted?.set(key, pending);
  }
  await pending;
}

async function vetSrvTargets(
  field: string,
  srv: { host: string; serviceName: string },
  guardOptions: OutboundGuardOptions | undefined,
): Promise<void> {
  let records: Array<{ name: string }>;
  try {
    records = await withDeadline(resolveSrv(`_${srv.serviceName}._tcp.${srv.host}`), SRV_LOOKUP_TIMEOUT_MS);
  } catch {
    records = [];
  }
  const targets = [...new Set(records.map((record) => String(record.name).replace(/\.$/, '').toLowerCase()))];
  if (targets.length === 0) {
    throw new ProviderEndpointError(field, 'the connection string uses an SRV record that could not be resolved, so the hosts it names cannot be checked');
  }
  if (targets.length > MAX_SRV_TARGETS) {
    throw new ProviderEndpointError(field, 'the SRV record of the connection string names too many hosts to check');
  }
  for (const target of targets) {
    if (!DNS_NAME.test(target)) {
      throw new ProviderEndpointError(field, 'the SRV record of the connection string names a host that cannot be checked');
    }
    await assertEndpoint(field, `https://${target}`, guardOptions);
  }
}

/**
 * Vets the hosts a `mongodb+srv` connection string reaches, from its SRV host (as the MongoDB driver parsed it) and
 * service name (`srvServiceName`, default `mongodb`): see `assertSrvTargets`. For a driver that already parsed the
 * string, so what is vetted is the record the driver will resolve.
 */
export async function assertSrvTargetsAllowed(
  field: string,
  srvHost: string,
  scope: ProviderEndpointScope,
  serviceName: string = DEFAULT_SRV_SERVICE,
): Promise<void> {
  const guardOptions = endpointGuardOptions(scope.tenantId);
  const host = srvHost.trim().toLowerCase();
  if (!privateNetworkBlockApplies(host, guardOptions)) return;
  if (!DNS_NAME.test(host) || !SRV_SERVICE_NAME.test(serviceName)) {
    throw new ProviderEndpointError(field, 'the connection string uses an SRV record that cannot be read, so the hosts it names cannot be checked');
  }
  await assertSrvTargets(field, { host, serviceName }, guardOptions);
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

interface ConnectionScan {
  hosts: string[];
  unvettable: boolean;
  known: boolean;
  /** A `mongodb+srv:` string: the host whose SRV record lists the servers, and the service name it is looked up under. */
  srv?: { host: string; serviceName: string };
}

/**
 * What a `scheme://` connection string names: the hosts to vet, whether that list is complete, and whether the
 * scheme is one of the connection-string schemes this guard reads (`mongodb+srv:` is: the same kind of string,
 * with its hosts behind a DNS record, which `srv` names so it can be resolved and vetted). `null` for any other
 * value (http(s) URLs are vetted as URLs).
 */
function scanConnectionString(value: string): ConnectionScan | null {
  const trimmed = value.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!scheme) return null;
  const protocol = `${scheme[1].toLowerCase()}:`;
  if (protocol === 'http:' || protocol === 'https:') return null;
  if (protocol === 'mongodb+srv:') return scanSrvConnectionString(trimmed.slice(scheme[0].length));
  // other schemes are not read here: they cannot be vetted
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
 * A `mongodb+srv:` string (the part after `://`): exactly one plain host name and an optional `srvServiceName`.
 * Anything else the driver would read differently (a port, a list, a bracket, percent-encoding, a service name given
 * twice or with odd characters) is `unvettable`, so it is refused where private targets are blocked.
 */
function scanSrvConnectionString(rest: string): ConnectionScan {
  const unreadable: ConnectionScan = { hosts: [], unvettable: true, known: true };
  let authority = rest.split(/[/?#]/, 1)[0];
  authority = authority.slice(authority.lastIndexOf('@') + 1);
  if (!DNS_NAME.test(authority)) return unreadable;

  const serviceNames: string[] = [];
  const query = /\?([^#]*)/.exec(rest)?.[1] ?? '';
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    if (at === -1 || decodeSafe(pair.slice(0, at)).trim().toLowerCase() !== 'srvservicename') continue;
    serviceNames.push(decodeSafe(pair.slice(at + 1)).trim());
  }
  if (serviceNames.length > 1) return unreadable;
  const serviceName = serviceNames[0] ?? DEFAULT_SRV_SERVICE;
  if (!SRV_SERVICE_NAME.test(serviceName)) return unreadable;
  return { hosts: [], unvettable: false, known: true, srv: { host: authority.toLowerCase(), serviceName } };
}

/**
 * True when a connection string cannot be vetted: a scheme this guard does not read, no host (the driver's
 * default), a local socket, or a `mongodb+srv` string whose SRV host cannot be read. A readable `mongodb+srv`
 * string can be vetted: its record is resolved by the assertions above.
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
  scope: ProviderEndpointScope,
  ...sources: Array<Record<string, unknown> | undefined>
): Promise<void> {
  const guardOptions = endpointGuardOptions(scope.tenantId);
  const srvVetted: SrvVetted = new Map();
  // The inference domains keep their own, stricter field rules (instance names, URL fields).
  if (type && GUARDED_DOMAINS.has(type)) await assertEndpointFields(type, guardOptions, sources, srvVetted);
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
      const scan = scanConnectionString(trimmed);
      for (const host of scan?.hosts ?? []) {
        await assertEndpoint(field, `https://${host}`, guardOptions);
      }
      if (scan?.srv) await assertSrvTargets(field, scan.srv, guardOptions, srvVetted);
    }
  }
}
