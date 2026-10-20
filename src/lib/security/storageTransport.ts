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

function assertInsecureTlsAllowed(allowInsecureTls: unknown, isOnPrem: boolean): void {
  if (skipsVerification(allowInsecureTls) && !isOnPrem) {
    throw new ProviderSettingsError(
      'allowInsecureTls',
      "Skipping TLS verification is only available on self-hosted deployments; add the CA certificate that issued the storage service's certificate instead.",
    );
  }
}

/**
 * The save and "Test connection" check of the two TLS settings every storage provider has: a CA certificate
 * that parses, and certificate verification skipped only on a self-hosted deployment. Throws
 * `ProviderSettingsError` naming the field.
 *
 * `allowInsecureTls` must be a boolean when it is given (`undefined` and `null` mean "not set"): a value of
 * any other type is refused here instead of being read as on or off. A runtime stays lenient about a stored
 * value like that and treats it as off (`createStorageAgents`), so verification is only ever skipped by `true`.
 */
export function validateStorageTlsSettings(input: {
  caCertificate?: string;
  allowInsecureTls?: unknown;
  isOnPrem: boolean;
}): void {
  const { allowInsecureTls } = input;
  if (allowInsecureTls !== undefined && allowInsecureTls !== null && typeof allowInsecureTls !== 'boolean') {
    throw new ProviderSettingsError('allowInsecureTls', 'Skip TLS verification must be true or false.');
  }
  assertInsecureTlsAllowed(allowInsecureTls, input.isOnPrem);
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
   * Skip certificate verification. Self-hosted deployments only; a settings error anywhere else. Only `true`
   * counts: a stored value of another type (a JSON `"false"`) leaves verification on.
   */
  allowInsecureTls?: boolean;
  isOnPrem: boolean;
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
 *   connection would cost milliseconds each time).
 * - Throws `ProviderSettingsError` for a bad CA bundle, and for `allowInsecureTls` outside a self-hosted
 *   deployment; `OutboundPrivateTargetError` (an `OutboundNetworkError`) for a private literal-IP host the policy
 *   blocks.
 */
export function createStorageAgents(input: StorageAgentsInput): StorageAgents {
  assertInsecureTlsAllowed(input.allowInsecureTls, input.isOnPrem);
  const ca = buildTrustedCaList(input.caCertificate);

  const host = input.guardHost ?? '';
  const guarded = privateNetworkBlockApplies(host, input.guard);
  const literal = host.replace(/^\[|\]$/g, '');
  if (guarded && isIP(literal) && guardRefusesAddress(literal, input.guard)) {
    throw new OutboundPrivateTargetError(host);
  }

  const options = {
    keepAlive: input.keepAlive ?? true,
    maxSockets: input.maxSockets ?? DEFAULT_MAX_SOCKETS,
    timeout: input.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    ...(guarded ? { lookup: createGuardedLookup(input.guard) } : {}),
  };
  const httpAgent = new http.Agent(options);
  const httpsAgent = new https.Agent({
    ...options,
    ...(ca ? { secureContext: tls.createSecureContext({ ca }) } : {}),
    ...(skipsVerification(input.allowInsecureTls) ? { rejectUnauthorized: false } : {}),
  });

  return {
    httpAgent,
    httpsAgent,
    destroy() {
      httpAgent.destroy();
      httpsAgent.destroy();
    },
  };
}
