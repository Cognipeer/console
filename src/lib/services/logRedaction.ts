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
 */

import { SENSITIVE_KEY_PATTERN } from '@/lib/core/logger';

export const LOG_SECRET_MASK = '••••••';

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
    if (typeof v === 'string' && v.length >= MIN_SECRET_LENGTH) out.add(v);
  }
  return [...out];
}

function scrubString(str: string, secrets: string[]): string {
  let out = str;
  for (const secret of secrets) out = out.replaceAll(secret, LOG_SECRET_MASK);
  return out;
}

function scrubValue(value: unknown, secrets: string[], depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return secrets.length ? scrubString(value, secrets) : value;
  if (typeof value !== 'object') return value;
  // Preserve native instances — walking a Date/Buffer/Error as a plain object
  // would erase it (Object.entries is empty → {}). Matches logger.ts.
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (depth > MAX_DEPTH) return value;
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

/**
 * Return a redacted deep copy of a log payload: sensitive-named keys masked,
 * occurrences of known secret values masked, and the whole payload replaced
 * with a truncation marker when it exceeds `maxBytes`. Never mutates the input.
 */
export function redactLogPayload<T>(payload: T, opts: RedactOptions = {}): T {
  if (payload === null || payload === undefined) return payload;
  const secrets = usableSecrets(opts.secretValues);
  const scrubbed = scrubValue(payload, secrets, 0, new WeakSet()) as T;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;

  try {
    const json = JSON.stringify(scrubbed);
    if (json && json.length > maxBytes) {
      // Preview comes from the already-scrubbed JSON, so it carries no secrets.
      return {
        _truncated: true,
        _originalBytes: json.length,
        preview: json.slice(0, TRUNCATION_PREVIEW_CHARS),
      } as unknown as T;
    }
  } catch {
    // Non-serializable payload (rare) — return the scrubbed structure as-is.
  }
  return scrubbed;
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
  const scrubbed = secrets.length ? scrubString(str, secrets) : str;
  return scrubbed.length > maxChars ? `${scrubbed.slice(0, maxChars)}…[truncated]` : scrubbed;
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
    // `basic` is sent as base64(user:pass) — mask that exact wire value too.
    if (auth.username) {
      out.push(Buffer.from(`${auth.username}:${auth.password}`).toString('base64'));
    }
  }
  return out;
}
