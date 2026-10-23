/**
 * Redaction for PERSISTED MCP/tool request logs.
 *
 * Request-side runtime-header VALUES are already kept out of the log (only
 * header names are stored — see `describeRuntimeAuth`). But the raw upstream
 * response and error text are persisted verbatim as `responsePayload` /
 * `errorMessage`, and rendered in the dashboard. So a secret the upstream
 * echoes back — a passthrough runtime header, or the server/tool's own static
 * credential — would land in the log and leak. This module scrubs known secret
 * VALUES and sensitive-named KEYS out of a log payload before it is persisted,
 * and caps its serialized size.
 *
 * Applied centrally in `logMcpRequest` / `logToolRequest`, so every caller
 * (including the dead `routes/**` shadow tree and the EE hub overlay) gets the
 * key-name scrub and size cap for free; only value-scrubbing needs the caller
 * to supply the outbound secret values.
 *
 * `maskSecretValues` is the same value-scrub for text and structures that are
 * NOT persisted as logs (error messages handed back to callers, the `lastError`
 * stored on a server record, tool results): it replaces known secret values and
 * nothing else, so legitimate output keeps its shape.
 */

import { SENSITIVE_KEY_PATTERN } from '@/lib/core/logger';
import { isMediaPayloadRecord, redactMediaPayloads } from '@/lib/services/tools/toolOutput';

export const LOG_SECRET_MASK = '••••••';

/** Replacement for a secret value found in text that leaves the gateway. */
export const SECRET_REDACTED = '[REDACTED]';

/** Cap on a single persisted payload's serialized size (128 KiB). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 128 * 1024;

/**
 * Cap on a persisted log string (e.g. an error message). Upstream error bodies
 * are echoed verbatim into `errorMessage`, so this bounds an otherwise
 * uncapped, attacker-influenced field.
 */
export const DEFAULT_MAX_STRING_CHARS = 8 * 1024;

/**
 * Secret values shorter than this are NOT value-scrubbed — short strings
 * (e.g. "Bearer", "basic") collide with ordinary response text and would
 * over-redact. Real tokens/keys are comfortably longer.
 */
const MIN_SECRET_LENGTH = 6;
const MAX_DEPTH = 8;
const TRUNCATION_PREVIEW_CHARS = 2048;
/**
 * A base64 data URL: `data:<type>/<subtype>[;<parameter>…];base64,<payload>`.
 * Every part in front of the payload is bounded (type and subtype at most 127
 * characters each, as media types are; at most eight parameters of at most 256),
 * which bounds the work done at each candidate start, so scrubbing a string
 * takes time linear in its length. Only the payload, which nothing follows, is
 * open-ended.
 */
const DATA_URL_PATTERN = /data:[a-z0-9.+-]{1,127}\/[a-z0-9.+-]{1,127}(?:;(?!base64(?:[,;]))[^;,\s]{1,256}){0,8};base64,[a-z0-9+/_=-]+/gi;
const REDACTED_DATA_URL = 'data:[REDACTED];base64,[REDACTED]';

export interface RedactOptions {
  /** Outbound secret values (runtime-header values, static credentials) to mask. */
  secretValues?: Iterable<string>;
  /** Serialized-size cap; payloads over this are replaced with a truncation marker. */
  maxBytes?: number;
}

function usableSecrets(values: Iterable<string> | undefined): string[] {
  if (!values) return [];
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== 'string' || v.length < MIN_SECRET_LENGTH) continue;
    out.add(v);
    // An upstream may echo the value inside a JSON string or a URL; the encoded
    // spelling is the same secret.
    const jsonEscaped = JSON.stringify(v).slice(1, -1);
    if (jsonEscaped !== v) out.add(jsonEscaped);
    const urlEncoded = encodeURIComponent(v);
    if (urlEncoded !== v) out.add(urlEncoded);
  }
  // Longest first: when one secret contains another, replacing the shorter one
  // first would leave the remainder of the longer one in the text.
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactDataUrls(str: string): string {
  return str.replace(DATA_URL_PATTERN, REDACTED_DATA_URL);
}

function scrubString(str: string, secrets: string[]): string {
  let out = redactDataUrls(str);
  for (const secret of secrets) out = out.replaceAll(secret, LOG_SECRET_MASK);
  return out;
}

/**
 * Stored payloads never nest deeper than this (document stores cap nesting, e.g.
 * MongoDB at 100 levels); anything below is replaced by a fixed marker.
 */
const STORE_MAX_DEPTH = 32;
const TOO_DEEP_MARKER = '[nested too deep]';

function truncateDeep(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (depth > STORE_MAX_DEPTH) return TOO_DEEP_MARKER;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => truncateDeep(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = truncateDeep(val, depth + 1, seen);
  }
  return out;
}

function scrubValue(value: unknown, secrets: string[], depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value, secrets);
  if (typeof value !== 'object') return value;
  // Preserve native instances — walking a Date/Buffer/Error as a plain object
  // would erase it (Object.entries is empty → {}). Matches logger.ts.
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) return value;
  // Past the key-masking depth the structure is no longer walked key by key, but
  // secret VALUES are still masked (an echo can be nested arbitrarily deep).
  if (depth > MAX_DEPTH) {
    const masked = secrets.length > 0 ? maskDeep(value, secrets, LOG_SECRET_MASK, depth, new WeakSet()) : value;
    return truncateDeep(masked, depth, new WeakSet());
  }
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, secrets, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? LOG_SECRET_MASK
      : scrubValue(val, secrets, depth + 1, seen);
  }
  return out;
}

/** Stands in for a payload that could not be scrubbed or serialized; says nothing about its content. */
const UNSERIALIZABLE_PREVIEW = '[payload could not be serialized]';

/**
 * Return a redacted deep copy of a log payload: sensitive-named keys masked,
 * occurrences of known secret values masked, and the whole payload replaced
 * with a truncation marker when it exceeds `maxBytes`. Never mutates the input.
 *
 * A payload that cannot be scrubbed or serialized at all (nested deeper than
 * the serializer can walk, a getter that throws, ...) is replaced by a marker
 * of fixed size too, never handed back as it came: the log row that carries it
 * is then still written, and the structure is not passed on to a store that
 * cannot take it either.
 */
export function redactLogPayload<T>(payload: T, opts: RedactOptions = {}): T {
  if (payload === null || payload === undefined) return payload;
  const maxBytes = typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes) && opts.maxBytes >= 0
    ? Math.floor(opts.maxBytes)
    : DEFAULT_MAX_PAYLOAD_BYTES;
  // A small cap must also bound the marker that replaces the payload.
  const previewChars = Math.min(TRUNCATION_PREVIEW_CHARS, Math.floor(maxBytes / 2));

  try {
    const secrets = usableSecrets(opts.secretValues);
    // Media payloads become size markers first, so logs never hold base64 (and the cap is not eaten by it).
    const scrubbed = scrubValue(redactMediaPayloads(payload), secrets, 0, new WeakSet()) as T;
    const json = JSON.stringify(scrubbed);
    if (json && json.length > maxBytes) {
      // Preview comes from the already-scrubbed JSON, so it carries no secrets.
      return {
        _truncated: true,
        _originalBytes: json.length,
        preview: json.slice(0, previewChars),
      } as unknown as T;
    }
    return scrubbed;
  } catch {
    return {
      _truncated: true,
      _unserializable: true,
      preview: UNSERIALIZABLE_PREVIEW.slice(0, previewChars),
    } as unknown as T;
  }
}

/**
 * Mask known secret values inside a free-text string (e.g. an upstream error
 * body) and cap its length. Scrubs before truncating so secrets in the kept
 * portion are masked and any beyond the cap are dropped entirely.
 */
export function redactLogString(
  str: string | undefined,
  secretValues?: Iterable<string>,
  maxChars: number = DEFAULT_MAX_STRING_CHARS,
): string | undefined {
  if (!str) return str;
  const secrets = usableSecrets(secretValues);
  const scrubbed = scrubString(str, secrets);
  return scrubbed.length > maxChars ? `${scrubbed.slice(0, maxChars)}…[truncated]` : scrubbed;
}

// ── Value-only masking (error text, lastError, tool results) ──────────────

/** Past this nesting the remaining subtree is masked as text instead of walked. */
const MAX_MASK_DEPTH = 40;
const TRUNCATION_MARKER = '…[truncated]';

function maskString(str: string, secrets: string[], mask: string): string {
  let out = str;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.replaceAll(secret, mask);
  }
  return out;
}

function isPlainContainer(value: object): boolean {
  if (Array.isArray(value)) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function maskDeep(
  value: unknown,
  secrets: string[],
  mask: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return maskString(value, secrets, mask);
  if (value === null || typeof value !== 'object') return value;
  // JSON-shaped data only: a Date, Buffer, Error or class instance is returned as is.
  if (!isPlainContainer(value)) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth > MAX_MASK_DEPTH) {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
    return maskString(json ?? '[unserializable]', secrets, mask);
  }

  seen.add(value);
  // A base64 payload cannot contain a secret worth masking and is megabytes of work; keep it byte-for-byte.
  const media = !Array.isArray(value) && isMediaPayloadRecord(value);
  const out = Array.isArray(value)
    ? value.map((item) => maskDeep(item, secrets, mask, depth + 1, seen))
    // fromEntries defines own properties, so an own "__proto__" key survives.
    : Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, val]) => [key, media && key === 'data'
          ? val
          : media && key === 'resource' && val && typeof val === 'object'
            ? Object.fromEntries(Object.entries(val as Record<string, unknown>)
              .map(([k, v]) => [k, k === 'blob' ? v : maskDeep(v, secrets, mask, depth + 2, seen)]))
            : maskDeep(val, secrets, mask, depth + 1, seen)]),
    );
  seen.delete(value);
  return out;
}

export interface MaskSecretOptions {
  /** Replacement text (default `[REDACTED]`). */
  mask?: string;
  /** Strings only: cap the MASKED text at this many characters. */
  maxChars?: number;
}

/**
 * Replace every occurrence of a known secret VALUE with `[REDACTED]` in a
 * string or in a JSON-shaped structure, and nothing else — no key-name
 * masking, no size cap, no data-URL stripping — so a legitimate tool result
 * keeps its exact shape. Returns a copy; the input is never mutated.
 *
 * For strings `maxChars` bounds the length of the MASKED text (marker
 * included), so a secret straddling the cut can never leave a fragment behind.
 */
export function maskSecretValues<T>(
  value: T,
  secretValues?: Iterable<string>,
  opts: MaskSecretOptions = {},
): T {
  const mask = opts.mask ?? SECRET_REDACTED;
  const secrets = usableSecrets(secretValues);
  let masked: unknown = secrets.length === 0 ? value : maskDeep(value, secrets, mask, 0, new WeakSet());
  if (typeof masked === 'string' && opts.maxChars !== undefined && masked.length > opts.maxChars) {
    const limit = Math.max(0, opts.maxChars);
    masked = limit > TRUNCATION_MARKER.length
      ? `${masked.slice(0, limit - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
      : masked.slice(0, limit);
  }
  return masked as T;
}

/**
 * Plaintext secret values an auth config injects into an outbound request.
 * Accepts an ALREADY-OPENED (decrypted) config — callers that seal secrets at
 * rest must open them first. Shared by the MCP and tool secret collectors.
 *
 * MUST stay in sync with the wire-injection sites that actually set these on
 * outbound headers (toolService.ts executeOpenApiAction/executeMcpAction,
 * mcpService.ts executeOpenApiTool): if a new auth field is sent there without
 * being collected here, an echoed value would silently leak.
 */
export function authConfigSecretValues(
  auth:
    | { token?: string; headerValue?: string; username?: string; password?: string }
    | undefined,
): string[] {
  if (!auth) return [];
  const out: string[] = [];
  if (auth.token) out.push(auth.token);
  if (auth.headerValue) out.push(auth.headerValue);
  if (auth.password) {
    out.push(auth.password);
    // `basic` is sent as base64(user:pass) — mask that exact wire value too,
    // and the decoded `user:pass` pair an upstream may print instead.
    if (auth.username) {
      out.push(Buffer.from(`${auth.username}:${auth.password}`).toString('base64'));
      out.push(`${auth.username}:${auth.password}`);
    }
  }
  return out;
}
