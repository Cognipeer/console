/**
 * Transport pieces the storage providers (S3-compatible, Azure Blob) share: the TLS trust a provider's own
 * CA certificate adds to Node's, and the http / https agents their clients connect through.
 *
 * A bad setting is thrown as `ProviderSettingsError` (`@/lib/providers/errors`, a module with no imports of
 * its own, so this file can use it without a cycle). The save and "Test connection" paths answer that as
 * HTTP 400 with the field name, which is why there is no error class of this file's own.
 */

import { X509Certificate } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
import { ProviderSettingsError } from '@/lib/providers/errors';
import {
  createGuardedLookup,
  guardRefusesAddress,
  OutboundPrivateTargetError,
  privateNetworkBlockApplies,
  type OutboundGuardOptions,
  type SafeFetchTls,
} from '@/lib/security/outboundFetch';

/* ------------------------------------------------------------------ */
/*  CA bundle                                                         */
/* ------------------------------------------------------------------ */

const BEGIN_CERTIFICATE = '-----BEGIN CERTIFICATE-----';
const END_CERTIFICATE = '-----END CERTIFICATE-----';

/** The bundle for one storage service is a few certificates; these caps bound what a pasted value can cost. */
export const CA_BUNDLE_MAX_BYTES = 64 * 1024;
export const CA_BUNDLE_MAX_CERTIFICATES = 50;

function caError(message: string): ProviderSettingsError {
  return new ProviderSettingsError('caCertificate', message);
}

/**
 * The certificates of a PEM bundle a provider was given, each re-serialised from the parsed certificate so
 * the text that reaches TLS is exactly what was validated. `undefined` when nothing was given.
 *
 * Throws `ProviderSettingsError('caCertificate', ...)` for text that is too large, holds a private key (a
 * trust setting is not a place for one; it is stored unencrypted), holds more than
 * `CA_BUNDLE_MAX_CERTIFICATES` certificates, has no certificate, or has one that does not parse. Text between
 * the blocks (comments, subject lines) is ignored.
 *
 * The scan walks the text once with `indexOf`; a pattern like /BEGIN[\s\S]+?END/g would restart at every
 * BEGIN marker and go quadratic on a value made of markers without an END.
 */
export function parseCaBundle(pem: string | undefined): string[] | undefined {
  if (!pem) return undefined;
  if (typeof pem !== 'string') throw caError('CA certificate must be PEM text.');
  if (pem.length > CA_BUNDLE_MAX_BYTES || Buffer.byteLength(pem, 'utf8') > CA_BUNDLE_MAX_BYTES) {
    throw caError(`CA certificate is larger than ${CA_BUNDLE_MAX_BYTES / 1024} KiB; paste only the certificates that issued the storage service's certificate.`);
  }
  if (pem.trim() === '') return undefined;
  if (/PRIVATE KEY/i.test(pem)) {
    throw caError('CA certificate must contain certificates only: remove the private key.');
  }

  const certificates: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = pem.indexOf(BEGIN_CERTIFICATE, cursor);
    if (start === -1) break;
    const end = pem.indexOf(END_CERTIFICATE, start + BEGIN_CERTIFICATE.length);
    if (end === -1) {
      throw caError(`CA certificate has a ${BEGIN_CERTIFICATE} line without a matching ${END_CERTIFICATE} line.`);
    }
    cursor = end + END_CERTIFICATE.length;
    if (certificates.length === CA_BUNDLE_MAX_CERTIFICATES) {
      throw caError(`CA certificate holds more than ${CA_BUNDLE_MAX_CERTIFICATES} certificates.`);
    }
    try {
      certificates.push(new X509Certificate(pem.slice(start, cursor)).toString());
    } catch {
      throw caError(`Certificate ${certificates.length + 1} of the CA certificate cannot be read; paste the PEM text exactly as the CA published it.`);
    }
  }

  if (certificates.length === 0) {
    throw caError(`CA certificate must contain at least one PEM certificate (a block starting with ${BEGIN_CERTIFICATE}).`);
  }
  return certificates;
}

/**
 * What Node's TLS clients trust when no `ca` is given: the bundled roots plus `NODE_EXTRA_CA_CERTS` where the
 * runtime can say so (`tls.getCACertificates`, Node 22.15+); the bundled roots alone on older Node.
 */
function defaultCaCertificates(): readonly string[] {
  const store = tls as typeof tls & { getCACertificates?: (type: 'default') => string[] };
  return typeof store.getCACertificates === 'function' ? store.getCACertificates('default') : tls.rootCertificates;
}

/**
 * The `ca` list for a provider with its own CA certificate: Node's default trust plus the bundle's
 * certificates (a `ca` option REPLACES the default trust, so a private CA alone would break a
 * public endpoint behind the same setting). `undefined` when the provider has none, so the default
 * trust stays in force untouched.
 */
export function buildTrustedCaList(pem: string | undefined): string[] | undefined {
  const custom = parseCaBundle(pem);
  return custom ? [...defaultCaCertificates(), ...custom] : undefined;
}

/* ------------------------------------------------------------------ */
/*  TLS settings                                                      */
/* ------------------------------------------------------------------ */

/**
 * Whether a provider's `allowInsecureTls` asks to skip certificate verification. Only the boolean `true` does:
 * provider settings arrive as free-form JSON (the API and imports take any value), and a `"false"`, `0` or `{}`
 * must never read as "on" - the failure to be afraid of is verification switched off by a value meant as off.
 */
function skipsVerification(allowInsecureTls: unknown): boolean {
  return allowInsecureTls === true;
}

/**
 * The save and "Test connection" check of the two TLS settings every storage provider has: a CA certificate
 * that parses, and a verification switch that is a boolean. Skipping verification is the provider's own choice on
 * every deployment; the network policy applies either way. Throws `ProviderSettingsError` naming the field.
 *
 * `allowInsecureTls` must be a boolean when it is given (`undefined` and `null` mean "not set"): a value of
 * any other type is refused here instead of being read as on or off. A runtime stays lenient about a stored
 * value like that and treats it as off (`createStorageAgents`), so verification is only ever skipped by `true`.
 */
export function validateStorageTlsSettings(input: {
  caCertificate?: string;
  allowInsecureTls?: unknown;
}): void {
  const { allowInsecureTls } = input;
  if (allowInsecureTls !== undefined && allowInsecureTls !== null && typeof allowInsecureTls !== 'boolean') {
    throw new ProviderSettingsError('allowInsecureTls', 'Skip TLS verification must be true or false.');
  }
  parseCaBundle(input.caCertificate);
}

/* ------------------------------------------------------------------ */
/*  Agents                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX_SOCKETS = 50;
/** Idle keep-alive sockets are closed after this long (and sooner when the server's own hint is shorter). */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface StorageAgentsInput {
  /** Outbound policy of the deployment for this endpoint and organization (`endpointGuardOptions(tenantId)`). */
  guard?: OutboundGuardOptions;
  /**
   * The endpoint's host as `URL.hostname` spells it. It decides whether the guarded lookup is installed
   * (an allow-listed host gets none); the lookup consults the allow-list again for every name it resolves.
   */
  guardHost?: string;
  /** PEM bundle trusted in addition to Node's default trust. */
  caCertificate?: string;
  /**
   * Skip certificate verification, on any deployment (the network policy still applies). Only `true` counts: a stored
   * value of another type (a JSON `"false"`) leaves verification on.
   */
  allowInsecureTls?: boolean;
  /** Default `true`. */
  keepAlive?: boolean;
  /** Per host, default 50. */
  maxSockets?: number;
  /**
   * Idle-socket timeout of the agents, default 60 s. Reaps idle keep-alive sockets; a client that sets its own
   * per-request timeout on a socket in use is not affected.
   */
  timeoutMs?: number;
}

export interface StorageAgents {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  /**
   * The TLS trust the https agent was built with (the provider's CA certificate, and the verification switch), in the
   * shape `safeFetch` takes - for the other requests a runtime makes for the same provider, such as the token request
   * of an identity provider, so they trust what the storage traffic trusts. `undefined` when the provider has neither.
   */
  tls: SafeFetchTls | undefined;
  /** Closes every socket both agents hold. Safe to call more than once. */
  destroy(): void;
}

/**
 * The agents a storage client connects through, as INSTANCES: a client handed agent options builds its own
 * agents, and the AWS SDK builds a throwaway https agent for a request that sends `Expect: 100-continue`,
 * which would drop the CA and the verification setting for that request.
 *
 * - Where the outbound policy blocks private targets for `guardHost`, both agents resolve names through
 *   `createGuardedLookup`, so the address a socket dials is checked when it connects. A literal IP never
 *   reaches `lookup` and is vetted here instead, by the same rule: a private address passes only inside the
 *   networks `guard.privateNetworks` has opened.
 * - A `caCertificate` becomes one secure context, built once (parsing the default trust again for every new
 *   connection would cost milliseconds each time); it is also handed back as `tls`, for the provider's other requests.
 * - Throws `ProviderSettingsError` for a bad CA bundle, and `OutboundPrivateTargetError` (an `OutboundNetworkError`)
 *   for a private literal-IP host the policy blocks.
 */
export function createStorageAgents(input: StorageAgentsInput): StorageAgents {
  const ca = buildTrustedCaList(input.caCertificate);

  const host = input.guardHost ?? '';
  const guarded = privateNetworkBlockApplies(host, input.guard);
  const literal = host.replace(/^\[|\]$/g, '');
  if (guarded && isIP(literal) && guardRefusesAddress(literal, input.guard)) {
    throw new OutboundPrivateTargetError(host);
  }

  // One context, shared by the agent and by whatever else the runtime fetches: parsing the default trust again for every
  // connection (or every request) would cost milliseconds each time.
  const skipVerification = skipsVerification(input.allowInsecureTls);
  const trust: SafeFetchTls | undefined = ca || skipVerification
    ? {
      ...(ca ? { secureContext: tls.createSecureContext({ ca }) } : {}),
      ...(skipVerification ? { rejectUnauthorized: false as const } : {}),
    }
    : undefined;

  const options = {
    keepAlive: input.keepAlive ?? true,
    maxSockets: input.maxSockets ?? DEFAULT_MAX_SOCKETS,
    timeout: input.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(guarded ? { lookup: createGuardedLookup(input.guard) } : {}),
  };
  const httpAgent = new http.Agent(options);
  const httpsAgent = new https.Agent({ ...options, ...trust });

  return {
    httpAgent,
    httpsAgent,
    tls: trust,
    destroy() {
      // A destroyed agent still serves a request that reaches it after this (a call that took the client just before its
      // runtime was replaced). With keep-alive on, that request's socket would go back to the agent's idle pool and stay open
      // for the idle timeout; with it off, the socket closes when its response ends.
      for (const agent of [httpAgent, httpsAgent]) {
        (agent as unknown as { keepAlive: boolean }).keepAlive = false;
        agent.destroy();
      }
    },
  };
}
