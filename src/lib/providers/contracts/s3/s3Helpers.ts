import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ProviderSettingsError } from '@/lib/providers/errors';

/**
 * Pure helpers of the S3 file drivers (Amazon S3 and S3-compatible storage): how an endpoint, a region and a bucket are
 * read, how object keys and metadata are written, and how a provider's location is shown. Nothing here talks to the
 * network, so the save-time checks (`s3Validation.ts`) and the runtime (`s3FileRuntime.ts`) share them.
 *
 * Two readings of the same settings exist on purpose. The functions named `normalize...` / `resolve...` are what a
 * runtime uses for a row that is already stored: they trim, fall back to defaults and only refuse what could not have
 * worked before. The strict checks that refuse a setting at save time live in `s3Validation.ts`.
 */

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3Settings {
  /** Custom S3 API endpoint. Empty = Amazon S3 itself (the regional endpoint of `region`). */
  endpoint?: string;
  region?: string;
  bucket: string;
  /** Prefix prepended to every object key, before the tenant and the provider key. */
  prefix?: string;
  /** Unset = automatic: path-style when an endpoint is set, virtual-hosted style for Amazon S3. */
  usePathStyleEndpoint?: boolean;
  /** PEM certificate(s) trusted in addition to the system roots. Only used with a custom endpoint. */
  caCertificate?: string;
  /** Skip certificate verification. Only used with a custom endpoint. */
  allowInsecureTls?: boolean;
}

export interface S3CompatibleSettings extends S3Settings {
  /** Create the bucket on the first upload when the store reports it missing. */
  createBucketIfMissing?: boolean;
}

/** The region sent to a custom endpoint that was given none: what virtually every S3-compatible store accepts. */
export const DEFAULT_S3_COMPATIBLE_REGION = 'us-east-1';

/** Under the provider's base prefix, reserved for the objects "Test connection" writes. */
export const S3_CONNECTION_TEST_PREFIX = '.cognipeer-connection-test/';

/* ------------------------------------------------------------------ */
/*  Settings as text                                                  */
/* ------------------------------------------------------------------ */

/** A setting as trimmed text, `undefined` when it is not text or is blank (settings arrive as free-form JSON). */
export function settingText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* ------------------------------------------------------------------ */
/*  Endpoint, region, bucket                                          */
/* ------------------------------------------------------------------ */

function endpointError(problem: string): ProviderSettingsError {
  return new ProviderSettingsError('endpoint', `Endpoint URL ${problem}`);
}

/**
 * `https://host:9000/prefix`: the endpoint as the S3 client should be given it. The scheme (http or https) is required,
 * the host is lower-cased, a path prefix is kept and trailing slashes are dropped (the SDK would send them on as `//`).
 *
 * Without `strict`, a user name, password, query string or fragment is ignored the way the SDK always did, so a
 * stored row that worked keeps working; with it (the save and test checks) they are refused, because a person who
 * typed credentials into a URL meant something else.
 */
export function normalizeS3Endpoint(raw: string, options: { strict?: boolean } = {}): string {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) {
    throw endpointError('must start with http:// or https:// (for example https://minio.internal:9000).');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw endpointError('is not a valid URL.');
  }
  if (!url.hostname) throw endpointError('has no host name.');
  if (options.strict) {
    if (url.username || url.password) {
      throw endpointError('must not contain a user name or password; enter the keys in the access key fields.');
    }
    if (url.search || url.hash) throw endpointError('must not contain a query string or fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** `host[:port]` of an endpoint for display (no user name, path or query), or `undefined` when it does not parse. */
export function s3EndpointHost(endpoint: string | undefined): string | undefined {
  const value = settingText(endpoint);
  if (!value) return undefined;
  try {
    return new URL(value).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The region a client signs with. A custom endpoint takes any region and defaults to `us-east-1`; Amazon S3 builds its
 * endpoint from the region, so it must be given. Shape is not checked here (see `s3Validation.ts`).
 */
export function resolveS3Region(raw: unknown, customEndpoint: boolean): string {
  const value = settingText(raw);
  if (value) return value;
  if (customEndpoint) return DEFAULT_S3_COMPATIBLE_REGION;
  throw new ProviderSettingsError('region', 'Region is required for Amazon S3 (for example eu-central-1).');
}

/** The bucket name, trimmed. Shape is not checked here (see `s3Validation.ts`): the store decides about a stored name. */
export function resolveS3Bucket(raw: unknown): string {
  const value = settingText(raw);
  if (!value) throw new ProviderSettingsError('bucket', 'Bucket name is required.');
  return value;
}

/* ------------------------------------------------------------------ */
/*  Keys and prefix                                                   */
/* ------------------------------------------------------------------ */

export function sanitizeKey(rawKey: string): string {
  const normalized = rawKey.replace(/\\/g, '/').replace(/\.{2,}/g, '.');
  const trimmed = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed || trimmed.includes('..')) {
    throw new Error('Invalid file key provided.');
  }
  return trimmed;
}

/** A UTF-16 surrogate with no partner: text that has no UTF-8 form, which the URL encoder of the SDK refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

/**
 * A key from a listing that the store URL-encoded because the request said `EncodingType=url`: `+` is a space and `%XX`
 * a byte. Text that is not valid percent-encoding (a store that answers "url" and does not mean it) is returned as it is.
 */
export function decodeListedKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;

/**
 * The `Content-Type` of an upload as a header can carry it. A header is bytes: the SDK signs the text of a value outside
 * printable ASCII as UTF-8 while Node writes it as Latin-1, so the store computes another signature and answers with an
 * error that reads like a wrong secret. A content type is a media type with parameters (`text/plain; charset=utf-8`),
 * ASCII in practice, so a value that is not is reduced to its media type (`reduced`); one that cannot be a header value at
 * all (a control character, a line break) is `invalid`. Blank means none.
 */
export function toHeaderContentType(raw: unknown): { value?: string; reduced?: true; invalid?: true } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') return { invalid: true };
  const value = raw.trim();
  if (value === '') return {};
  if (CONTROL_CHARACTER.test(value)) return { invalid: true };
  if (PRINTABLE_ASCII.test(value)) return { value };
  const mediaType = value.split(';')[0].trim();
  return mediaType !== '' && PRINTABLE_ASCII.test(mediaType) ? { value: mediaType, reduced: true } : { invalid: true };
}

export function generateKey(fileName?: string): string {
  if (!fileName) {
    return `${Date.now()}-${randomUUID()}`;
  }

  const extension = path.extname(fileName);
  const baseName = fileName.slice(0, fileName.length - extension.length);
  const slug = baseName.length > 0 ? baseName : 'file';
  // A dash left at either end of the stem (a name that starts or ends with a character outside a-z, 0-9, `-`, `_`) is dropped,
  // as the other drivers do: `(final).pdf` is `final-<time>-<id>.pdf`, not `-final--<time>-<id>.pdf`.
  const normalized = slug.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'file';
  return `${normalized}-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`;
}

/**
 * Where a provider's objects start inside the bucket: `<settings.prefix>/<tenantId>/<providerKey>/`, each part only
 * when it is given. The runtime builds every key from this and the location shown to people is built from it too, so
 * the two cannot drift apart.
 */
export function s3BasePrefix(prefix: unknown, tenantId: string, providerKey: string): string {
  const segments = [prefix, tenantId, providerKey]
    .filter((segment): segment is string => typeof segment === 'string' && segment.trim().length > 0)
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''));
  return segments.length > 0 ? `${segments.join('/')}/` : '';
}

/**
 * Where a provider's objects live, for display: `s3://<bucket>/<base prefix>` and, for a custom endpoint, ` · <host[:port]>`
 * after it so two providers that use the same bucket name on different servers can be told apart. Built from settings
 * alone (never credentials) and `null` when there is no bucket to name.
 */
export function describeS3Location(
  settings: { bucket?: string; prefix?: string; endpoint?: string },
  tenantId: string,
  providerKey: string,
): string | null {
  const bucket = settingText(settings.bucket);
  if (!bucket) return null;
  const location = `s3://${bucket}/${s3BasePrefix(settings.prefix, tenantId, providerKey)}`;
  const host = s3EndpointHost(settings.endpoint);
  return host ? `${location} · ${host}` : location;
}

/* ------------------------------------------------------------------ */
/*  User metadata (x-amz-meta-*)                                      */
/* ------------------------------------------------------------------ */

/**
 * S3 documents 2 KB of user-defined metadata per object (the UTF-8 bytes of every key and value added up); other
 * stores differ. What does not fit is left out and logged, never a reason to refuse the upload.
 *
 * Every entry is charged as the header it travels in, `x-amz-meta-<key>: <value>`: a store such as MinIO counts the
 * prefix against the same 2 KiB, so what fits here fits there, with a little headroom under 2048.
 */
export const S3_METADATA_BUDGET_BYTES = 2000;

/** The `x-amz-meta-` that the header name of every user entry carries. */
export const S3_METADATA_PREFIX_BYTES = 'x-amz-meta-'.length;

/**
 * Most user entries one object carries. Every entry is a request header, and servers refuse a request with too many
 * of them (one store answers HTTP 431 at about 90), however small the entries are.
 */
export const S3_METADATA_MAX_ENTRIES = 50;

/** An RFC 2047 encoded word as it may appear in a header value: `=?charset?B|Q?text?=` (RFC 2231 allows `charset*lang`). */
const ENCODED_WORD = /=\?([A-Za-z0-9_.:+-]{1,40}(?:\*[A-Za-z0-9-]{1,20})?)\?([BbQq])\?([^?\s]{0,4096})\?=/g;
const HAS_ENCODED_WORD = /=\?[A-Za-z0-9_.:+-]{1,40}(?:\*[A-Za-z0-9-]{1,20})?\?[BbQq]\?[^?\s]{0,4096}\?=/;
/** Printable ASCII with no space at either end: what a header value keeps byte for byte on its way through proxies. */
const PLAIN_HEADER_VALUE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The header-safe form of a metadata value. HTTP header values are bytes, and every piece of the path (the AWS SDK, a
 * reverse proxy, Go- and Python-based stores) treats anything but printable ASCII differently: the SDK refuses a
 * character above U+00FF, a Latin-1 byte reaches a Go server raw and fails the signature check. So a value that is not
 * plain printable ASCII travels as one RFC 2047 UTF-8 base64 word, the form S3 itself returns non-ASCII metadata in.
 * A plain value that already looks like an encoded word is wrapped too, so reading it back returns what was written.
 */
export function encodeS3MetadataValue(value: string): string {
  if (value === '') return '';
  if (PLAIN_HEADER_VALUE.test(value) && !HAS_ENCODED_WORD.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function charsetOf(label: string): 'utf8' | 'latin1' | undefined {
  const charset = label.split('*')[0].toLowerCase();
  if (charset === 'utf-8' || charset === 'utf8') return 'utf8';
  if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'us-ascii' || charset === 'ascii') return 'latin1';
  return undefined;
}

/** The bytes behind a Q-encoded word (`_` is a space, `=XX` a byte), or `undefined` when an escape is malformed. */
function decodeQ(text: string): Buffer | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '_') {
      bytes.push(0x20);
    } else if (char === '=') {
      const hex = text.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeWord(charset: string, encoding: string, text: string): string | undefined {
  const encoder = charsetOf(charset);
  if (!encoder) return undefined;
  if (encoding.toUpperCase() === 'B') {
    return BASE64_TEXT.test(text) ? Buffer.from(text, 'base64').toString(encoder) : undefined;
  }
  return decodeQ(text)?.toString(encoder);
}

/**
 * Reads a metadata value back. RFC 2047 encoded words are decoded wherever they stand in the value: B (base64) and Q
 * (quoted-printable) words, in UTF-8 or ISO-8859-1. Our own writes are single UTF-8 B words, but a store (or a proxy)
 * may re-encode a value, and objects put there by other tools use the other forms. White space between two adjacent
 * words is dropped, as RFC 2047 says. A word that cannot be read (other charset, malformed text) is left as it is.
 */
export function decodeS3MetadataValue(value: string): string {
  if (!value.includes('=?')) return value;
  let result = '';
  let last = 0;
  let afterWord = false;
  for (const match of value.matchAll(ENCODED_WORD)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const gap = value.slice(last, start);
    const decoded = decodeWord(match[1], match[2], match[3]);
    if (decoded === undefined) {
      result += gap + match[0];
      afterWord = false;
    } else {
      result += afterWord && /^[ \t]+$/.test(gap) ? '' : gap;
      result += decoded;
      afterWord = true;
    }
    last = end;
  }
  return result + value.slice(last);
}

export interface S3MetadataKeyOptions {
  /**
   * Keep `_` and `.` (and `-`) in a key. Amazon S3 itself accepts them and a client reaches it without a proxy in the
   * path, so an object keeps the key names it was always written under. A custom endpoint may sit behind a reverse
   * proxy, and nginx drops request headers with underscores by default, so there only `[a-z0-9-]` is sent.
   */
  keepPunctuation?: boolean;
}

/**
 * The name a metadata key is sent under: lower-case `[a-z0-9-]` (`[a-z0-9_.-]` with `keepPunctuation`). S3 lower-cases
 * keys anyway. `null` when nothing is left of the key.
 */
export function toS3MetadataKey(key: string, options: S3MetadataKeyOptions = {}): string | null {
  const unwanted = options.keepPunctuation ? /[^a-z0-9_.-]+/g : /[^a-z0-9]+/g;
  const cleaned = key.toLowerCase().replace(unwanted, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return cleaned || null;
}

function metadataText(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return String(value);
}

/**
 * The `Metadata` of a PutObject: keys normalised, values header-safe, the whole kept inside
 * `S3_METADATA_BUDGET_BYTES` (each entry counted as its `x-amz-meta-<key>: <value>` header) and
 * `S3_METADATA_MAX_ENTRIES`. Entries are taken in order; the first of two keys that normalise to the same name wins.
 * `dropped` lists the original keys that were left out (no usable name, does not fit, cannot be written).
 */
export function buildS3Metadata(
  entries: Array<[string, unknown]>,
  options: S3MetadataKeyOptions = {},
): {
  metadata?: Record<string, string>;
  dropped: string[];
} {
  const metadata: Record<string, string> = {};
  const dropped: string[] = [];
  let used = 0;
  let count = 0;
  for (const [rawKey, rawValue] of entries) {
    if (rawValue === undefined || rawValue === null) continue;
    const key = toS3MetadataKey(rawKey, options);
    const text = metadataText(rawValue);
    if (!key || text === undefined || Object.prototype.hasOwnProperty.call(metadata, key)) {
      dropped.push(rawKey);
      continue;
    }
    const value = encodeS3MetadataValue(text);
    const size = S3_METADATA_PREFIX_BYTES + Buffer.byteLength(key) + Buffer.byteLength(value);
    if (count >= S3_METADATA_MAX_ENTRIES || used + size > S3_METADATA_BUDGET_BYTES) {
      dropped.push(rawKey);
      continue;
    }
    metadata[key] = value;
    used += size;
    count += 1;
  }
  return { metadata: count > 0 ? metadata : undefined, dropped };
}

export function decodeS3Metadata(metadata: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!metadata) return undefined;
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, decodeS3MetadataValue(value)]));
}
