/**
 * Microsoft Entra client-credentials token source for the Azure Blob provider.
 *
 * OAuth2 client credentials against the v2.0 token endpoint is the one thing `@azure/identity`'s
 * `ClientSecretCredential` does here, and it takes ~45 MB of MSAL dependencies to do it. This is one POST,
 * a cache and a single-flight guard. The request itself is made by the caller's `fetchImpl` (`safeFetch` in
 * production: DNS pinned to the vetted addresses, private targets refused under the deployment's policy,
 * redirects handed back instead of followed; for a provider with its own CA certificate or skipped verification,
 * the same call carries that trust).
 *
 * The authority host is a setting, so the token server is not always Microsoft's: the whole exchange (the request
 * and every byte of the answer) runs under one deadline, and the answer is read only up to a size no token
 * response comes near. A server that goes silent or never stops talking costs one failed attempt, not a stuck
 * credential.
 */

import { AzureBlobError, isAzureBlobError, redactSecrets, tlsFailureCode, withoutMissingPhrases } from './blobErrors';
import { validateClientSecretConfig } from './blobConfig';

/**
 * Structurally what the SDK calls a `TokenCredential` / `AccessToken` (@azure/core-auth), declared
 * here so the contract does not import a transitive dependency by name.
 */
export interface AccessToken {
  token: string;
  expiresOnTimestamp: number;
}

export interface TokenCredential {
  getToken(scopes?: string | string[], options?: unknown): Promise<AccessToken | null>;
}

export const STORAGE_SCOPE = 'https://storage.azure.com/.default';

export interface ClientSecretConfig {
  authorityHost: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /**
   * Makes the request. It is given the exchange's deadline as `init.signal`; one that keeps the signal on the body
   * (`safeFetch` with `keepAbortLinked`) ends a stalled read at once, and the credential enforces the deadline
   * itself for one that does not.
   */
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Deadline of one exchange (default `ENTRA_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Most bytes of an answer that are read (default `ENTRA_MAX_RESPONSE_BYTES`). */
  maxResponseBytes?: number;
}

/** Refresh a minute early; the SDK adds its own 2 minute buffer on top. */
const EXPIRY_SKEW_MS = 60_000;

/** Longest the whole exchange may take: the request, and the answer up to its last byte. */
export const ENTRA_TIMEOUT_MS = 10_000;

/** The most of an answer that is read. A token response is about 2 KB; anything near this is not one. */
export const ENTRA_MAX_RESPONSE_BYTES = 64 * 1024;

/** The spellings a server may echo a secret in: as sent in the form, URL-encoded, and form-encoded (a space as `+`). */
function secretSpellings(secret: string): string[] {
  const spellings = new Set([secret, encodeURIComponent(secret), new URLSearchParams({ s: secret }).toString().slice(2)]);
  return [...spellings];
}

/** Cuts at a word boundary so a long service sentence does not end mid-word. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}...`;
}

/** A short machine-readable token from an answer: at most 64 characters of `[A-Za-z0-9_.-]`, nothing else. */
function tokenText(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || undefined;
}

/** Why a request or a read failed, in one line: `fetch failed` hides the reason in its cause (ECONNREFUSED, ENOTFOUND, a TLS code). */
function reasonText(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message.split(/\r?\n/, 1)[0] : 'request failed';
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return withoutMissingPhrases(typeof cause === 'string' ? `${message} (${cause})` : message);
}

function durationText(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

/** The error a caller's own `abortSignal` ends a wait with; the SDK and `describeAzureError` know it by its name. */
function abortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** `work`, or `onTimeout()` as soon as `deadline` fires, whichever comes first. The loser is left to settle unheard. */
function beforeDeadline<T>(work: Promise<T>, deadline: AbortSignal, onTimeout: () => Error): Promise<T> {
  if (deadline.aborted) {
    work.catch(() => undefined);
    return Promise.reject(onTimeout());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(onTimeout());
    deadline.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        deadline.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        deadline.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** The abort signal a caller passed in the SDK's `GetTokenOptions`, when there is one. */
function abortSignalOf(options: unknown): AbortSignal | undefined {
  const signal = (options as { abortSignal?: unknown } | undefined)?.abortSignal as AbortSignal | undefined;
  return signal && typeof signal.addEventListener === 'function' ? signal : undefined;
}

interface TokenEndpointBody {
  error?: unknown;
  error_description?: unknown;
  error_codes?: unknown;
  access_token?: unknown;
  expires_in?: unknown;
}

/**
 * Tokens are cached per instance and concurrent callers share one request. The `tenantId` a service-sent
 * challenge may ask for is ignored on purpose: a storage endpoint that is not Azure must not be able to steer
 * where the secret is presented. Failures are `AzureBlobError`s whose text never carries the secret.
 */
export function createClientSecretCredential(cfg: ClientSecretConfig): TokenCredential {
  const { authority } = validateClientSecretConfig(cfg);
  const now = cfg.now ?? Date.now;
  const tokenUrl = `${authority}/${encodeURIComponent(cfg.tenantId.trim())}/oauth2/v2.0/token`;
  let cached: AccessToken | undefined;
  let inflight: Promise<AccessToken> | undefined;

  const timeoutMs = cfg.timeoutMs ?? ENTRA_TIMEOUT_MS;
  const maxResponseBytes = cfg.maxResponseBytes ?? ENTRA_MAX_RESPONSE_BYTES;

  // Whatever the authority writes back is its own text: the secret is taken out of it wherever it was echoed.
  const secrets = secretSpellings(cfg.clientSecret);
  const scrub = (text: string) => redactSecrets(text, secrets);

  const failed = (message: string) => new AzureBlobError(message, { code: 'EntraTokenRequestFailed', retryable: true });
  const timedOut = () => failed(`Microsoft Entra at ${authority} did not finish answering within ${durationText(timeoutMs)}.`);
  const tooLarge = () => failed(`Microsoft Entra at ${authority} answered with more than ${Math.round(maxResponseBytes / 1024)} KiB, which is not a token response.`);

  /** The answer's text, read piece by piece under the deadline and cut off once it passes the size cap. */
  async function readAnswer(response: Response, deadline: AbortSignal): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      // nothing to stream (no body, or a response that only offers its text)
      if (typeof response.text !== 'function') return '';
      const text = await beforeDeadline(response.text(), deadline, timedOut);
      if (Buffer.byteLength(text) > maxResponseBytes) throw tooLarge();
      return text;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await beforeDeadline(reader.read(), deadline, timedOut);
        if (done) break;
        total += value.byteLength;
        if (total > maxResponseBytes) throw tooLarge();
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function fetchToken(): Promise<AccessToken> {
    // One deadline for the whole exchange, request and answer alike. The flight is shared by every waiter, so it has
    // a clock of its own instead of a waiter's signal.
    const deadline = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await beforeDeadline(cfg.fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: cfg.clientId.trim(),
          client_secret: cfg.clientSecret,
          scope: STORAGE_SCOPE,
        }).toString(),
        signal: deadline,
      }), deadline, timedOut);
    } catch (error) {
      if (isAzureBlobError(error)) throw error;
      if (deadline.aborted || isAbortLike(error)) throw timedOut();
      const tlsCode = tlsFailureCode(error);
      if (tlsCode) {
        // The provider's CA certificate (or the verification switch) covers the authority as well as the blobs.
        throw new AzureBlobError(
          `The TLS certificate of Microsoft Entra at ${authority} is not trusted (${tlsCode}). Paste the issuing CA certificate into the "CA certificate" setting, or turn on "Skip TLS verification" for a test setup.`,
          { code: 'EntraTokenRequestFailed', retryable: false },
        );
      }
      throw new AzureBlobError(`Could not reach Microsoft Entra at ${authority}: ${reasonText(error)}.`, {
        // A refusal by the network policy stays refused; an outage may pass.
        retryable: (error as { retryable?: unknown } | undefined)?.retryable !== false,
      });
    }

    let answer: string;
    try {
      answer = await readAnswer(response, deadline);
    } catch (error) {
      if (isAzureBlobError(error)) throw error;
      if (deadline.aborted || isAbortLike(error)) throw timedOut();
      throw new AzureBlobError(`Could not read the answer of Microsoft Entra at ${authority}: ${reasonText(error)}.`, { retryable: true });
    }
    let body: TokenEndpointBody | undefined;
    try {
      body = JSON.parse(answer) as TokenEndpointBody;
    } catch {
      body = undefined;
    }
    if (!response.ok || typeof body?.access_token !== 'string' || body.access_token.trim() === '') {
      const status = response.status;
      const errorCode = typeof body?.error === 'string' ? tokenText(scrub(body.error)) : undefined;
      // An authority that is down or throttling is not a verdict on the service principal.
      if (status >= 500 || status === 429 || status === 408) {
        throw new AzureBlobError(
          `Microsoft Entra at ${authority} is unavailable or throttling (HTTP ${status}${errorCode ? ` ${errorCode}` : ''}); try again.`,
          { statusCode: status, code: 'EntraTokenRequestFailed' },
        );
      }
      // An OAuth error object is a rejection, and so is a plain 401 or 403. A page, an empty answer or a token-less
      // 200 means the URL is not a token endpoint.
      if (errorCode === undefined && status !== 401 && status !== 403) {
        throw new AzureBlobError(
          `Microsoft Entra at ${authority} answered with something that is not a token response (HTTP ${status}). Check the authority host.`,
          { code: 'EntraTokenRequestFailed', retryable: false },
        );
      }
      const aadsts = Array.isArray(body?.error_codes) && body.error_codes.length > 0 && tokenText(body.error_codes[0])
        ? ` AADSTS${tokenText(body.error_codes[0])}`
        : '';
      const description = typeof body?.error_description === 'string'
        ? clip(withoutMissingPhrases(scrub(body.error_description.split(/\r?\n/, 1)[0]).replace(/^AADSTS\d+:\s*/, '')), 240)
        : '';
      // A rejected service principal is the configuration's to fix (401).
      throw new AzureBlobError(
        `Microsoft Entra rejected the service principal (${errorCode ?? `HTTP ${status}`}${aadsts})${description ? `: ${description}` : ''}`,
        { statusCode: status === 400 || status === 401 || status === 200 ? 401 : status, code: 'EntraTokenRequestFailed' },
      );
    }
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in) || 3600;
    return { token: body.access_token, expiresOnTimestamp: now() + lifetime * 1000 };
  }

  /** Starts the one request every waiter shares. Whatever ends it, the next caller starts afresh. */
  function startFlight(): Promise<AccessToken> {
    const flight: Promise<AccessToken> = fetchToken()
      .then((token) => {
        cached = token;
        return token;
      })
      .finally(() => {
        if (inflight === flight) inflight = undefined;
      });
    return flight;
  }

  /** The flight's result for one caller; the caller's own `abortSignal` ends its wait, not the flight others share. */
  function waitFor(flight: Promise<AccessToken>, signal: AbortSignal | undefined): Promise<AccessToken> {
    if (!signal) return flight;
    if (signal.aborted) {
      flight.catch(() => undefined);
      return Promise.reject(abortError());
    }
    return new Promise<AccessToken>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      flight.then(
        (token) => {
          signal.removeEventListener('abort', onAbort);
          resolve(token);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  return {
    async getToken(_scopes?: string | string[], options?: unknown): Promise<AccessToken | null> {
      if (cached && cached.expiresOnTimestamp - EXPIRY_SKEW_MS > now()) return cached;
      inflight ??= startFlight();
      return waitFor(inflight, abortSignalOf(options));
    },
  };
}
