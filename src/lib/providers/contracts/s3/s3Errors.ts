/**
 * What goes wrong with an S3 call, in words a person can act on.
 *
 * Every SDK call of the S3 runtime is wrapped: the error that comes out is an `S3OperationError` whose message says what
 * to change ("the secret access key is wrong, or the region does not match"), not what the SDK happened to say
 * ("UnknownError", an XML parse failure, an `AggregateError` with an empty message). It also carries the two facts the
 * resilience layer needs, `statusCode` and `retryable`, so a rejected credential is not retried and does not count
 * against the circuit breaker while a store that is down is and does.
 *
 * Wording rule: the file routes answer 404 for an error message that contains "not found" or "does not exist" (a missing
 * file). Only the object-level message may say so; every other message, including a store's own text that is passed
 * through, is kept free of both phrases, or a missing bucket would read as a missing file.
 */

export type S3Operation = 'list' | 'get' | 'head' | 'put' | 'delete' | 'create-bucket';

export interface S3ErrorContext {
  /** The custom endpoint, normalised; unset for Amazon S3 itself. */
  endpoint?: string;
  bucket: string;
  /** What the failed call was doing; narrows a few messages. */
  operation?: S3Operation;
  /** The provider's "Create bucket if missing" switch: `on`, `off`, or unset when the driver does not offer it. */
  createBucket?: 'on' | 'off';
  /** Values that must never appear in a message (the keys of the provider); they are masked if a store echoes one. */
  secrets?: readonly string[];
}

export interface MappedS3Error {
  code: string;
  message: string;
  statusCode?: number;
  retryable: boolean;
}

/** Longest message an `S3OperationError` carries. */
export const S3_ERROR_MESSAGE_MAX_CHARS = 300;

/** Phrases the file routes read as "no such file"; see the file header. */
function avoidMissingFileWording(message: string): string {
  return message.replace(/\bnot found\b/gi, 'missing').replace(/\bdoes not exist\b/gi, 'is missing');
}

function shorten(message: string): string {
  return message.length > S3_ERROR_MESSAGE_MAX_CHARS ? `${message.slice(0, S3_ERROR_MESSAGE_MAX_CHARS - 1)}…` : message;
}

/**
 * Carries the friendly message AND what `withResilience` and the file circuit breaker read (`statusCode`, `retryable`).
 * The SDK's own error is kept as `cause` for the logs.
 */
export class S3OperationError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(mapped: MappedS3Error, cause?: unknown) {
    const text = mapped.code === 'object_missing' ? mapped.message : avoidMissingFileWording(mapped.message);
    super(shorten(text), cause === undefined ? undefined : { cause });
    this.name = 'S3OperationError';
    this.code = mapped.code;
    this.statusCode = mapped.statusCode;
    this.retryable = mapped.retryable;
  }
}

/**
 * A key the driver cannot send: nothing is left of it once the slashes are trimmed, or it holds a character that has no
 * UTF-8 form. The text matches what the other file drivers throw; the status and `retryable: false` keep a rejected key
 * from being retried and from counting as an outage of the store (it would otherwise open the circuit breaker of the
 * provider for every caller).
 */
export function invalidKeyError(detail?: string): S3OperationError {
  return new S3OperationError({
    code: 'invalid_key',
    message: detail ? `Invalid file key provided: ${detail}` : 'Invalid file key provided.',
    statusCode: 400,
    retryable: false,
  });
}

/**
 * True for an error `createS3FileRuntime` raised for a failed storage call. The Files backend uses it to show the
 * message (which is safe and written for people) instead of a generic failure. Checks the name as well as the class, so
 * a copy of this module loaded twice by a bundler still matches.
 */
export function isS3OperationError(error: unknown): error is S3OperationError {
  if (error instanceof S3OperationError) return true;
  return error instanceof Error
    && error.name === 'S3OperationError'
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { retryable?: unknown }).retryable === 'boolean';
}

/* ------------------------------------------------------------------ */
/*  Reading an SDK / Node error                                       */
/* ------------------------------------------------------------------ */

/** The Node error code behind an error, looking through `cause` and the members of an `AggregateError`. */
function nodeCodeOf(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 4) return undefined;
  const carrier = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof carrier.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(carrier.code)) return carrier.code;
  return nodeCodeOf(carrier.cause, depth + 1) ?? (Array.isArray(carrier.errors) ? nodeCodeOf(carrier.errors[0], depth + 1) : undefined);
}

/** The host name a failed DNS lookup was for (Node puts it on the error). */
function lookupHostnameOf(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 4) return undefined;
  const carrier = error as { hostname?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof carrier.hostname === 'string') return carrier.hostname;
  return lookupHostnameOf(carrier.cause, depth + 1) ?? (Array.isArray(carrier.errors) ? lookupHostnameOf(carrier.errors[0], depth + 1) : undefined);
}

/** A store's own text, made safe to show: markup stripped, white space collapsed, the provider's keys masked. */
function cleanMessage(message: unknown, secrets: readonly string[] = []): string {
  let text = typeof message === 'string' ? message : '';
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function hostOf(endpoint: string | undefined): string {
  if (!endpoint) return 'Amazon S3';
  try {
    return new URL(endpoint).host;
  } catch {
    return 'the storage endpoint';
  }
}

const TLS_UNTRUSTED_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_UNTRUSTED',
]);

/** A failure that is the store's or the network's, as opposed to a request the store refused: another try can help. */
function retryableStatus(status: number | undefined): boolean {
  return status === undefined || status >= 500 || status === 408 || status === 429;
}

/**
 * Turns an AWS SDK or Node error into a code, a message a person can act on, and the retry verdict.
 *
 * The verdicts: configuration, credential and policy problems are not retryable (the same request fails the same way);
 * a store that is down or slow, a network failure and an error nothing recognises are. An unrecognised 4xx is not.
 */
export function describeS3Error(error: unknown, ctx: S3ErrorContext): MappedS3Error {
  const carrier = (error ?? {}) as { name?: unknown; message?: unknown; $metadata?: { httpStatusCode?: number } };
  const status = carrier.$metadata?.httpStatusCode;
  const name = typeof carrier.name === 'string' ? carrier.name : 'Error';
  const raw = cleanMessage(carrier.message, ctx.secrets);
  const host = hostOf(ctx.endpoint);
  const bucket = ctx.bucket;
  const mapped = (code: string, message: string, retryable = false): MappedS3Error => ({
    code,
    message: code === 'object_missing' ? message : shorten(avoidMissingFileWording(message)),
    statusCode: status,
    retryable,
  });

  switch (name) {
    case 'NoSuchBucket': {
      const next = ctx.createBucket === 'on'
        ? 'With "Create bucket if missing" on, the first upload creates it.'
        : ctx.createBucket === 'off'
          ? 'Create it first (for example with "mc mb"), or turn on "Create bucket if missing".'
          : ctx.endpoint ? 'Create it first.' : 'Check the bucket name and the region, or create the bucket.';
      return mapped('bucket_missing', `Bucket "${bucket}" is missing on ${host}. ${next}`);
    }
    case 'NoSuchKey':
      return mapped('object_missing', 'The object does not exist.');
    case 'InvalidAccessKeyId':
      return mapped('invalid_access_key', `${host} does not recognise this access key ID.`);
    case 'SignatureDoesNotMatch':
      return mapped(
        'signature_mismatch',
        'The secret access key is wrong, or the region or path-style setting does not match the server. Behind a reverse proxy, the Host header must be forwarded unchanged (nginx: proxy_set_header Host $http_host).',
      );
    case 'AccessDenied':
    case 'AllAccessDisabled':
      return mapped(
        'access_denied',
        ctx.operation === 'create-bucket'
          ? `Access denied: the credentials may not create bucket "${bucket}" (CreateBucket permission). Create the bucket yourself or grant the permission.`
          : `Access denied on bucket "${bucket}": the credentials are accepted but lack permission (needs PutObject, GetObject, DeleteObject and ListBucket).`,
      );
    case 'ExpiredToken':
    case 'ExpiredTokenException':
    case 'InvalidToken':
    case 'TokenRefreshRequired':
      return mapped('invalid_session_token', 'The session token is expired or not valid. Enter a current session token, or leave it empty for a long-lived access key.');
    case 'AuthorizationHeaderMalformed': {
      const expected = /expecting '?([A-Za-z0-9._-]+)'?/.exec(raw)?.[1];
      return mapped(
        'wrong_region',
        expected
          ? `The server expects region "${expected}". Set the Region field to that value.`
          : 'The region does not match what the server expects. Check the Region field.',
      );
    }
    case 'InvalidBucketName':
      return mapped('invalid_bucket_name', `"${bucket}" is not a valid bucket name for this store (usually 3-63 characters: lowercase letters, digits, dots and hyphens).`);
    case 'BucketAlreadyExists':
      return mapped('bucket_name_taken', `Bucket name "${bucket}" is already taken by another account on ${host}.`);
    case 'RequestTimeTooSkewed':
      return mapped('clock_skew', 'The clocks of this server and the storage service differ by more than 15 minutes.');
    case 'KeyTooLongError':
      return mapped('invalid_key', 'Invalid file key provided: it is longer than the store allows (Amazon S3: 1024 bytes in UTF-8, the provider prefix included).');
    case 'XMinioInvalidObjectName':
    case 'InvalidObjectName':
      return mapped('invalid_key', `Invalid file key provided: ${raw || 'the store does not accept this key'}`);
    case 'MetadataTooLarge':
      return mapped('metadata_too_large', 'The object metadata is larger than the store allows (2 KB for S3).');
    case 'EntityTooLarge':
      return mapped('object_too_large', 'The object is larger than the store allows for a single upload.');
    case 'NotImplemented':
      return mapped('not_implemented', `${host} does not implement a feature this request uses (NotImplemented). ${raw}`.trim());
    case 'BadDigest':
    case 'InvalidDigest':
    case 'XAmzContentSHA256Mismatch':
      return mapped('integrity', 'The storage rejected the upload checksum. A proxy in front of it may be changing the request body.');
    case 'PermanentRedirect':
    case 'TemporaryRedirect':
      return mapped('redirect', 'The endpoint redirected the request; check the endpoint URL and the region.');
    case 'RequestTimeout':
      return mapped('timeout', `${host} gave up waiting for the request (RequestTimeout).`, true);
    case 'Throttling':
    case 'ThrottlingException':
    case 'TooManyRequestsException':
    case 'RequestLimitExceeded':
      return mapped('rate_limited', `${host} is limiting the request rate (${name}).`, true);
    case 'SlowDown':
    case 'ServiceUnavailable':
    case 'InternalError':
    case 'InternalFailure':
      return mapped('store_unavailable', `${host} is overloaded or unavailable (${name}).`, true);
    default:
      break;
  }

  // Thrown by the SDK before anything is sent (a lone surrogate in a key, a prefix or a continuation token): the same
  // request fails the same way, so it is not a store failure to retry.
  if (name === 'URIError') {
    return mapped('invalid_request', 'A value of the request (a key, a prefix or a continuation token) holds a character that cannot be sent in a URL.');
  }

  const code = nodeCodeOf(error);
  if (code) {
    if (code === 'ECONNREFUSED') {
      return mapped(
        'connection_refused',
        ctx.endpoint
          ? `Connection refused by ${host}. Is the storage service running, and is this the S3 API port (MinIO: 9000, not the 9001 console)? Inside Docker or Kubernetes "localhost" is the console's own container.`
          : `Connection refused by ${host}. Check the network access of this server (proxy, firewall).`,
        true,
      );
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      const failed = lookupHostnameOf(error);
      const bucketSubdomain = Boolean(ctx.endpoint) && failed !== undefined && failed.toLowerCase().startsWith(`${bucket.toLowerCase()}.`);
      return mapped(
        'dns_failure',
        bucketSubdomain
          ? `The host name ${failed} cannot be resolved. The store may have no DNS for bucket sub-domains: turn on "Use path-style addressing".`
          : ctx.endpoint
            ? `The host name of ${host} cannot be resolved. Check the endpoint spelling and DNS.`
            : `The host name of ${host} cannot be resolved. Check the DNS and network access of this server.`,
        true,
      );
    }
    if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return mapped('timeout', `No answer from ${host} (timeout or unreachable). Check firewall rules and network policy.`, true);
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return mapped(
        'connection_reset',
        `${host} closed the connection unexpectedly.${ctx.endpoint?.startsWith('http:') ? ' If this port serves TLS, use https:// in the endpoint.' : ''}`,
        true,
      );
    }
    if (TLS_UNTRUSTED_CODES.has(code)) {
      return mapped('tls_untrusted', `The TLS certificate of ${host} is not trusted. Paste the CA certificate that issued it into "CA certificate" (recommended), or, for tests only, turn on "Skip TLS verification".`);
    }
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      return mapped('tls_hostname', `The TLS certificate of ${host} is not valid for the host name used in the endpoint. Use a name listed in the certificate or issue it again.`);
    }
    if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') {
      return mapped('tls_expired', `The TLS certificate of ${host} is expired or not valid yet (also check this server's clock).`);
    }
    if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
      const message = typeof carrier.message === 'string' ? carrier.message : '';
      return /wrong version number|packet length too long|http request/i.test(message) || code === 'ERR_SSL_WRONG_VERSION_NUMBER'
        ? mapped('tls_protocol', `${host} did not speak TLS on this port. Use http:// for a plain-HTTP port (or https:// for a TLS port).`)
        : mapped('tls_handshake', `The TLS handshake with ${host} failed. The server may require a newer TLS version or a client certificate.`);
    }
    if (code === 'ERR_INVALID_CHAR' || code === 'ERR_INVALID_HTTP_TOKEN') {
      return mapped('invalid_header', 'A metadata key or value contains characters that are not allowed in an HTTP header.');
    }
  }

  if (name === 'OutboundNetworkError' || name === 'OutboundDnsError' || name === 'ProviderEndpointError') {
    return mapped('endpoint_not_allowed', raw, (error as { retryable?: unknown } | undefined)?.retryable === true);
  }
  if (name === 'ProviderSettingsError') return mapped('invalid_settings', raw);
  if (status === 413) {
    return mapped('payload_too_large', `${host} (or a proxy in front of it) rejected the upload size with HTTP 413 (nginx: client_max_body_size).`);
  }
  const notS3 = (retryable: boolean) => mapped(
    'not_s3',
    `${host} answered HTTP ${status ?? '?'} but not with an S3 response. Check the endpoint URL and port${ctx.endpoint?.startsWith('https') ? '' : ' (and whether the port expects https://)'}, and that no proxy rewrites the reply.`,
    retryable,
  );
  // The reply could not be read as S3 XML (a web console, a proxy page, JSON from a gateway).
  if (/Deserialization error|is not expected|Unexpected end of|Unexpected token/i.test(raw) || (name === 'Error' && status !== undefined)) {
    return notS3((status ?? 0) >= 500);
  }
  if (status === 301 || status === 302 || status === 307 || status === 308) {
    return mapped('redirect', `${host} redirected the request (HTTP ${status}); use the final URL as the endpoint.`);
  }
  if (name === 'NotFound' && status === 404) {
    return ctx.operation === 'get'
      ? mapped('object_missing', 'The object does not exist.')
      : mapped('bucket_or_object_missing', `Bucket "${bucket}" or the object is missing (HTTP 404).`);
  }
  // A HEAD answer has no body to name the cause: the secret may be wrong as well as the permission missing.
  if (status === 403) {
    return mapped('access_denied', `Access denied (HTTP 403) on bucket "${bucket}". The store gave no reason: the secret access key may be wrong, or the credentials may lack permission.`);
  }
  if (status === 429) return mapped('rate_limited', `${host} is limiting the request rate (HTTP 429).`, true);
  if (status !== undefined && status >= 500) return mapped('store_unavailable', `${host} answered HTTP ${status}.`, true);
  // The SDK found no S3 error code in the reply and names it "Unknown": an error page that is not S3's, such as the
  // 400 an nginx sends when plain HTTP reaches a TLS port.
  if (name === 'Unknown' && status !== undefined) return notS3(false);
  if (name === 'TimeoutError' || name === 'AbortError') return mapped('timeout', `The request to ${host} timed out.`, true);
  // Unclassified: keep the retry-by-default of the resilience layer, except for an answer that was a plain refusal.
  return mapped('unknown', raw || (name === 'Error' ? 'The storage request failed.' : name), retryableStatus(status));
}
