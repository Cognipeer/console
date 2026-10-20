/**
 * What an Azure Blob call can fail with and how a failure is put into words.
 *
 * Nothing here touches the SDK or the network. The SDK's own errors carry the request (a SAS token's
 * signature sits in its URL) and the response body, so they never leave the runtime: `describeAzureError`
 * reads the few fields that matter and `describeFailure` writes a sentence from them.
 */

/** A request header Node refuses to write or a name it refuses to use: the same request fails the same way. */
const REQUEST_REJECTED_CODE = /^ERR_(?:INVALID|HTTP|UNESCAPED)_[A-Z_]+$/;
const TLS_CODE = /^(?:DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+|CERT_[A-Z_]+|HOSTNAME_MISMATCH|ERR_TLS_[A-Z_]+)$/;
const SYSTEM_CODE = /^(?:E[A-Z]+|ERR_[A-Z_]+|REQUEST_SEND_ERROR|PARSE_ERROR|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_[A-Z_]+|CERT_[A-Z_]+|HOSTNAME_MISMATCH)$/;
/** The text `OutboundNetworkError` carries when the deployment's network policy refuses an address. */
const POLICY_REFUSAL = /^Refusing outbound request to private\/loopback host/;

/* ------------------------------------------------------------------ */
/*  The error that leaves the runtime                                 */
/* ------------------------------------------------------------------ */

/** Whether another attempt at the same call can succeed: an outage, a timeout or throttling, not a rejection. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status >= 500 || status === 408 || status === 429;
}

/**
 * The only error type an operation of the runtime throws for a storage failure (setting problems are
 * `ProviderSettingsError`). It carries the status and Azure's error code but not the SDK's `request` /
 * `response`, and declares `retryable` so `withResilience` and the file circuit breaker read the verdict
 * instead of guessing from the message.
 */
export class AzureBlobError extends Error {
  readonly statusCode?: number;

  readonly code?: string;

  readonly requestId?: string;

  readonly retryable: boolean;

  constructor(
    message: string,
    info: { statusCode?: number; code?: string; requestId?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'AzureBlobError';
    this.statusCode = info.statusCode;
    this.code = info.code;
    this.requestId = info.requestId;
    this.retryable = info.retryable ?? isRetryableStatus(info.statusCode);
  }
}

export function isAzureBlobError(error: unknown): error is AzureBlobError {
  if (error instanceof AzureBlobError) return true;
  // A second copy of this module (a reset module registry) makes `instanceof` miss the same class.
  return error instanceof Error && error.name === 'AzureBlobError' && typeof (error as { retryable?: unknown }).retryable === 'boolean';
}

/**
 * A key or a blob name the service cannot take. The text matches what the other drivers throw; the
 * status and `retryable: false` keep a rejected key from being retried or counted as an outage.
 */
export function invalidKeyError(detail?: string): AzureBlobError {
  return new AzureBlobError(detail ? `Invalid file key provided: ${detail}` : 'Invalid file key provided.', {
    statusCode: 400,
    code: 'InvalidFileKey',
    retryable: false,
  });
}

/* ------------------------------------------------------------------ */
/*  Reading what the SDK threw                                        */
/* ------------------------------------------------------------------ */

export interface AzureErrorInfo {
  status?: number;
  /** Azure's error code (`BlobNotFound`, `AuthorizationFailure`, ...) when the response had one. */
  code?: string;
  /** A Node network / TLS code (`ECONNREFUSED`, `DEPTH_ZERO_SELF_SIGNED_CERT`, ...). */
  systemCode?: string;
  /** The service's own sentence, first line only. */
  detail?: string;
  requestId?: string;
  aborted: boolean;
  /** The deployment's network policy refused the address the host name resolves to. */
  blocked: boolean;
}

interface SdkErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  statusCode?: unknown;
  details?: {
    errorCode?: unknown;
    message?: unknown;
    /** camelCase on the real service, lowercase on some emulators. */
    authenticationErrorDetail?: unknown;
    authenticationerrordetail?: unknown;
    'x-ms-request-id'?: unknown;
  };
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.split(/\r?\n/, 1)[0]?.trim();
  return line ? line.slice(0, 300) : undefined;
}

export function describeAzureError(error: unknown): AzureErrorInfo {
  const e = (typeof error === 'object' && error !== null ? error : {}) as SdkErrorLike;
  const status = typeof e.statusCode === 'number' ? e.statusCode : undefined;
  const detailsCode = typeof e.details?.errorCode === 'string' ? e.details.errorCode : undefined;
  const rawCode = typeof e.code === 'string' ? e.code : undefined;
  const code = detailsCode ?? (rawCode && /^[A-Z][A-Za-z]+$/.test(rawCode) && !SYSTEM_CODE.test(rawCode) ? rawCode : undefined);
  const systemCode = rawCode && SYSTEM_CODE.test(rawCode) ? rawCode : undefined;
  return {
    status,
    code,
    systemCode,
    // A HEAD response has no body, so `message` is empty there; the service text is in `details` when present.
    detail: firstLine(e.details?.authenticationErrorDetail ?? e.details?.authenticationerrordetail) ?? firstLine(e.message) ?? firstLine(e.details?.message),
    requestId: typeof e.details?.['x-ms-request-id'] === 'string' ? e.details['x-ms-request-id'] : undefined,
    aborted: e.name === 'AbortError',
    // The SDK reports a refused lookup as a plain request error and keeps only the text.
    blocked: e.name === 'OutboundNetworkError' || (typeof e.message === 'string' && POLICY_REFUSAL.test(e.message)),
  };
}

/**
 * HEAD answers carry no body, but the service names the miss in `x-ms-error-code` (read as `details.errorCode`): a
 * missing blob is `BlobNotFound`. A 404 without it is not a verdict on the blob (a gateway, a proxy page, another
 * storage protocol's error), and neither is a missing container or account.
 */
export function isBlobMissing(info: AzureErrorInfo): boolean {
  return info.status === 404 && info.code === 'BlobNotFound';
}

export function isContainerMissing(info: AzureErrorInfo): boolean {
  return info.code === 'ContainerNotFound';
}

/** True for a verdict no second attempt changes: a refused address, an untrusted certificate, a rejected request. */
export function isHopelessFailure(info: AzureErrorInfo): boolean {
  if (info.blocked) return true;
  if (info.systemCode && (TLS_CODE.test(info.systemCode) || REQUEST_REJECTED_CODE.test(info.systemCode))) return true;
  return !isRetryableStatus(info.status);
}

/**
 * The TLS code (`DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, ...) an error carries itself or in
 * its cause chain, when it is a certificate verdict. `fetch` hides it one level down (`TypeError: fetch failed`).
 */
export function tlsFailureCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && TLS_CODE.test(code)) return code;
    current = cause;
  }
  return undefined;
}

/** What Node and undici call a connection that went away in the middle of a body. */
const CONNECTION_LOST_CODE = /^(?:ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|ERR_STREAM_PREMATURE_CLOSE|UND_ERR_SOCKET|UND_ERR_ABORTED|UND_ERR_CLOSED)$/;

/**
 * Whether a body read stopped before its last byte for a reason another request for the rest of it can fix: a
 * connection that dropped, or a body that ended short.
 *
 * The SDK reports a dropped connection to its body stream as an `AbortError` it cannot tell from a cancelled
 * request (it ends the stream with that error and does not retry), so the name alone proves nothing: a caller
 * rules out its own deadline and signal first.
 */
export function isInterruptedRead(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code, message, cause } = error as { name?: unknown; code?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (name === 'AbortError') return true;
  const systemCode = typeof code === 'string' ? code : typeof cause?.code === 'string' ? cause.code : undefined;
  if (systemCode && CONNECTION_LOST_CODE.test(systemCode)) return true;
  // the SDK's own wording for a body that ended short once it is told not to retry
  return typeof message === 'string' && message.startsWith('Data corruption failure: received less data than required');
}

/* ------------------------------------------------------------------ */
/*  Wording                                                           */
/* ------------------------------------------------------------------ */

/**
 * The client download route turns any message containing "not found" or "does not exist" into a 404 "File
 * not found". Text the service (or Microsoft Entra) wrote is passed through here before it goes into a
 * message, so only a file that is really missing reads that way.
 */
export function withoutMissingPhrases(text: string): string {
  return text.replace(/does not exist/gi, 'is not present').replace(/not found/gi, 'not located');
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\bsig=)[^&\s"']+/gi, '$1[redacted]'],
  [/(\bAccountKey=)[^;\s"']+/gi, '$1[redacted]'],
  [/(\bSharedAccessSignature=)[^;\s"']+/gi, '$1[redacted]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'],
  // a token request echoed back: the form field, or the same field in a JSON answer
  [/(\bclient_secret=)[^&\s"']+/gi, '$1[redacted]'],
  [/("client_secret"\s*:\s*")[^"]*"/gi, '$1[redacted]"'],
  // the signature of a Shared Key Authorization header, and a bare token (three base64url parts) in any text
  [/(\bSharedKey(?:Lite)?\s+[^\s:]+:)[A-Za-z0-9+/=]+/g, '$1[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted]'],
];

/**
 * A last line of defence for text that is about to leave the runtime: the credentials in play, and anything
 * shaped like a signature, an account key or a bearer token. The sentences written here carry none of them;
 * this covers the text of an error the SDK or Node produced.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * What an `AuthenticationFailed` detail means, in words that do not repeat it: the real service
 * puts the request's signature and the whole string-to-sign into the "MAC signature" detail.
 */
export function authenticationHint(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (/MAC signature .* is not the same as any computed signature/i.test(detail)) {
    return 'the signature does not match this account: wrong or rotated account key, or the account name belongs to another account';
  }
  const window = /Signature not valid in the specified time frame: Start \[([^\]]*)\] - Expiry \[([^\]]*)\] - Current \[([^\]]*)\]/i.exec(detail);
  if (window) return `the SAS is outside its validity window (valid ${window[1]} to ${window[2]}; Azure's time is ${window[3]})`;
  if (/Signed expiry time .* has to be after signed start time/i.test(detail)) return 'the SAS expiry time is before its start time';
  if (/Request date header (too old|not in range)|x-ms-date/i.test(detail)) return 'the clock of this server differs from Azure\'s by more than 15 minutes';
  if (/audience|issuer|tenant/i.test(detail)) return 'the token was issued for another audience, tenant or cloud; check the authority host and the tenant ID';
  return undefined;
}

export interface FailureContext {
  operation: string;
  /** The account name, or the host when the account is not known (a SAS on a custom domain). */
  account: string;
  container: string;
  host: string;
  authMethod: string;
  /** The validity window of the SAS in use, when one is (a connection string's SAS included). */
  sas?: { expiresAt?: Date; startsAt?: Date };
  /** The "API version" setting, when the provider pins one. */
  apiVersion?: string;
  /**
   * An abort that neither the operation's own deadline nor the caller's signal raised: the connection went away
   * while the request or its body was in flight, which is a different story from "no answer in time".
   */
  interrupted?: boolean;
}

/**
 * Whether the SAS the provider holds is outside its own validity window right now, as a sentence tail. The service
 * says so itself (`AuthenticationFailed` with the window in its detail); an emulator only refuses, and a SAS that
 * expires while the runtime is cached is the case this exists for. `undefined` when the window is fine.
 */
function sasWindowHint(sas: FailureContext['sas'], now: number): string | undefined {
  if (sas?.expiresAt && sas.expiresAt.getTime() <= now) {
    return `it expired on ${sas.expiresAt.toISOString()}. Create a new one and replace it in the provider settings.`;
  }
  if (sas?.startsAt && sas.startsAt.getTime() > now) {
    return `it is not valid before ${sas.startsAt.toISOString()}. Check the start time of the SAS and the clock of this server.`;
  }
  return undefined;
}

/** The SAS permission letters an operation needs, for a "your SAS lacks X" sentence. */
const SAS_PERMISSION: Readonly<Record<string, string>> = {
  list: 'l (list)',
  upload: 'c and w (create and write)',
  download: 'r (read)',
  'read properties': 'r (read)',
  delete: 'd (delete)',
};

/** The service's own sentence without its closing punctuation, for a place where this module adds its own. */
function withoutFinalStop(text: string): string {
  return text.replace(/[\s.!?;,]+$/, '');
}

/**
 * A sentence a person can act on. It never repeats a request URL, a header or a credential, and
 * it deliberately avoids the phrases "not found" / "does not exist" for anything but a missing file:
 * the client download route turns those into `404 File not found`.
 */
export function describeFailure(info: AzureErrorInfo, ctx: FailureContext, now: number = Date.now()): string {
  const where = `${ctx.account}/${ctx.container}`;
  if (info.aborted) {
    return ctx.interrupted
      ? `The connection to Azure Blob Storage was interrupted (${ctx.operation}).`
      : `Azure Blob Storage did not answer in time (${ctx.operation}).`;
  }
  if (info.blocked) {
    return `${ctx.host} resolves to a private or loopback address, which this deployment does not allow.`;
  }
  if (info.systemCode && TLS_CODE.test(info.systemCode)) {
    return `The TLS certificate of ${ctx.host} is not trusted (${info.systemCode}). Paste the issuing CA certificate into the "CA certificate" setting, or turn on "Skip TLS verification" for a test setup.`;
  }
  if (info.systemCode && REQUEST_REJECTED_CODE.test(info.systemCode)) {
    return `The ${ctx.operation} request was rejected before it was sent (${info.systemCode}).`;
  }
  if (info.systemCode === 'ENOTFOUND' || info.systemCode === 'EAI_AGAIN') {
    return `The host ${ctx.host} could not be resolved. Check the account name or endpoint.`;
  }
  if (info.systemCode) {
    const unnamed = info.systemCode === 'REQUEST_SEND_ERROR' || info.systemCode === 'PARSE_ERROR';
    return `Could not reach ${ctx.host} (${info.systemCode})${unnamed && info.detail ? `: ${withoutMissingPhrases(info.detail)}` : ''}.`;
  }

  switch (info.code) {
    case 'ContainerNotFound':
      return `The container "${ctx.container}" is missing in storage account "${ctx.account}". Create it or enable "Create container if missing".`;
    case 'ResourceNotFound':
      return `The storage endpoint answered 404 (ResourceNotFound) for ${where}. Check the account name and the endpoint.`;
    case 'KeyBasedAuthenticationNotPermitted':
      return 'Key-based access is turned off for this storage account. Use a SAS token or Microsoft Entra ID.';
    // The service answers a bearer token it cannot accept (wrong audience or issuer, expired, bad signature) with
    // InvalidAuthenticationInfo; the reason is in a response header that never leaves the runtime.
    case 'InvalidAuthenticationInfo':
    case 'AuthenticationFailed': {
      const window = sasWindowHint(ctx.sas, now);
      if (window) return `Azure rejected the SAS token: ${window}`;
      // What to check depends on what was sent; the service's own detail, when it gives one, says more.
      const fallback = ctx.authMethod === 'entra'
        ? 'the Microsoft Entra token was not accepted; check the authority host, the tenant ID and the clock of this server'
        : ctx.sas
          ? 'check the SAS signature and validity window'
          : 'check the account name and key';
      return `Azure rejected the credentials (${info.code}): ${authenticationHint(info.detail) ?? fallback}.`;
    }
    case 'AuthorizationPermissionMismatch': {
      if (ctx.operation === 'create the container') {
        return `The credentials may not create the container "${ctx.container}". Create it in the portal, or use an account key, an account-level SAS that allows creating containers, or a role that does.`;
      }
      if (ctx.authMethod === 'entra') {
        return `The service principal may not ${ctx.operation} in ${where}. Assign "Storage Blob Data Contributor" (or Reader for read-only) on the account or container; role changes take a few minutes.`;
      }
      const letters = SAS_PERMISSION[ctx.operation];
      return `The credentials do not allow "${ctx.operation}" in ${where}. A SAS needs the ${letters ? `${letters} permission` : 'matching permission letters (racwdl)'}.`;
    }
    case 'AuthorizationFailure': {
      // Emulators answer a SAS outside its window with this code, where the service names the window.
      const window = sasWindowHint(ctx.sas, now);
      if (window) return `Azure rejected the SAS token: ${window}`;
      return `Azure refused the request (AuthorizationFailure). Either the credentials were rejected or the storage account's firewall, virtual network or "public network access" setting blocks this server (${ctx.host}).`;
    }
    case 'AuthorizationServiceMismatch':
      return 'The SAS token is not valid for the Blob service (its "ss" field lacks b).';
    case 'AuthorizationResourceTypeMismatch':
      return 'The account SAS lacks the resource types this operation needs (srt must include s, c and o).';
    case 'AuthorizationProtocolMismatch':
      return 'The SAS token only allows another protocol (spr).';
    case 'AuthorizationSourceIPMismatch':
      return 'The SAS token is restricted to a different source IP address (sip).';
    case 'AccountIsDisabled':
      return `The storage account "${ctx.account}" is disabled.`;
    case 'UnauthorizedBlobOverwrite':
      return 'The credentials may create blobs but not overwrite them; the SAS or role also needs write and delete.';
    case 'InvalidHeaderValue': {
      const detail = info.detail ? ` (${withoutFinalStop(withoutMissingPhrases(info.detail))})` : '';
      return ctx.apiVersion
        ? `The service rejected a request header${detail}. If it names the API version, this service may not support ${ctx.apiVersion}: change or clear "API version" in the provider settings.`
        : `The service rejected a request header${detail}. If it names an API version, set "API version" in the provider settings.`;
    }
    case 'InvalidResourceName':
    case 'OutOfRangeInput':
      return `Azure rejected the container or blob name (${info.code}).`;
    case 'InvalidMetadata':
    case 'MetadataTooLarge':
      return `Azure rejected the blob metadata (${info.code}).`;
    case 'BlobImmutableDueToPolicy':
    case 'BlobImmutableDueToLegalHold':
      return 'The blob is protected by an immutability policy or legal hold and cannot be overwritten or deleted.';
    case 'ServerBusy':
    case 'OperationTimedOut':
    case 'InternalError':
      return `Azure Blob Storage is busy or timing out (${info.code}); try again.`;
    default:
      break;
  }
  const status = info.status ? `HTTP ${info.status}` : 'an unknown error';
  return `Azure Blob Storage ${ctx.operation} failed with ${status}${info.code ? ` (${info.code})` : ''}${info.detail ? `: ${withoutFinalStop(withoutMissingPhrases(info.detail))}` : ''}.`;
}
