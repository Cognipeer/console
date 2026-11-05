/**
 * AWS Signature Version 4 for a bodiless GET, with `node:crypto` only.
 *
 * The model catalog lists Bedrock's foundation models and inference profiles, which live on the Bedrock control-plane
 * API (`bedrock.<region>.amazonaws.com`), not on the runtime API the installed Bedrock client talks to. Pulling in the
 * control-plane SDK for two read-only GETs would add a dependency; signing them here keeps the request on the guarded
 * `safeFetch` path like every other catalog call. See
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsGetRequest {
  /** The full URL that will be fetched. Its query must be encoded with `encodeRfc3986` (see `awsQuery`). */
  url: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials: sent and signed as `x-amz-security-token`. */
  sessionToken?: string;
  /** Signing time; now by default. */
  now?: Date;
  /** Also send and sign `x-amz-content-sha256` (S3 requires it; most other services accept it). */
  signContentSha256?: boolean;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';
/** SHA-256 of the empty body. */
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value, 'utf8').digest();

/** RFC 3986 percent-encoding, as SigV4 wants it: everything but `A-Z a-z 0-9 - _ . ~` is encoded. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A query string encoded the way the signature reads it, so the URL sent and the URL signed are the same. */
export function awsQuery(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&');
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The query as SigV4 canonicalises it: every name and value decoded, re-encoded per RFC 3986, sorted. */
function canonicalQuery(search: string): string {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return '';
  return raw
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const equals = part.indexOf('=');
      const name = equals >= 0 ? part.slice(0, equals) : part;
      const value = equals >= 0 ? part.slice(equals + 1) : '';
      return [encodeRfc3986(decodeComponent(name)), encodeRfc3986(decodeComponent(value))] as const;
    })
    .sort(([nameA, valueA], [nameB, valueB]) => (nameA === nameB ? (valueA < valueB ? -1 : valueA > valueB ? 1 : 0) : nameA < nameB ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * The canonical path for every service but S3: the path is normalised (`.` and `..` resolved, empty segments
 * dropped) and each segment encoded once more on top of the URL's own encoding (the "double encoding" of the spec).
 */
function canonicalPath(pathname: string): string {
  const segments: string[] = [];
  for (const segment of pathname.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  if (segments.length === 0) return '/';
  const trailing = pathname.endsWith('/') ? '/' : '';
  return `/${segments.map(encodeRfc3986).join('/')}${trailing}`;
}

/** `20150830T123600Z` */
function amzDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/**
 * The headers that sign a bodiless GET of `url`: `host`, `x-amz-date`, `x-amz-security-token` (temporary
 * credentials), `x-amz-content-sha256` (when asked) and `authorization`. The request must be sent with exactly these
 * headers' values and with the URL as given; other headers may be added, they are not signed.
 */
export function signAwsGetRequest(request: AwsGetRequest): Record<string, string> {
  const url = new URL(request.url);
  const date = amzDate(request.now ?? new Date());
  const day = date.slice(0, 8);

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': date,
    ...(request.sessionToken ? { 'x-amz-security-token': request.sessionToken } : {}),
    ...(request.signContentSha256 ? { 'x-amz-content-sha256': EMPTY_BODY_SHA256 } : {}),
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');

  const canonicalRequest = [
    'GET',
    canonicalPath(url.pathname),
    canonicalQuery(url.search),
    canonicalHeaders,
    signedHeaders,
    EMPTY_BODY_SHA256,
  ].join('\n');

  const scope = `${day}/${request.region}/${request.service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${request.secretAccessKey}`, day), request.region), request.service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${request.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
