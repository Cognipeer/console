/**
 * Bounding for the `params._meta` object an MCP host sends with a `tools/call`.
 *
 * Hosts use `_meta` to describe who and where the call comes from (ChatGPT
 * documents `openai/subject`, `openai/session`, `openai/locale`,
 * `openai/userLocation`, …; other hosts send whatever they like), and operators
 * want to see what actually arrives. The object comes from an unauthenticated
 * peer on the public endpoints, so what is persisted from it is small and
 * flat: a bounded number of keys, bounded strings, one level of nesting, and
 * no structure a later reader could trip over. Pure and synchronous — the
 * secret scrub that follows lives with the other log redaction (see
 * `logMcpRequest`), not here.
 */

/** The MCP protocol's own progress handle: not a description of the caller. */
const PROTOCOL_KEYS = new Set(['progressToken']);

/** Keys that would reach into an object's prototype if ever assigned to a plain object. */
const UNTRUSTED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Coordinates are kept as keys (an operator can see that a host sends them)
 * but never as values: precise location does not belong in a request log.
 * Applies at the top level as well as inside nested objects: a host that sends
 * `lat`/`lng` flat is no less sending a location.
 */
const LOCATION_KEYS = new Set(['latitude', 'longitude', 'lat', 'lng', 'lon']);
const REDACTED_LOCATION = '[redacted]';

const MAX_KEYS = 32;
const MAX_KEY_CHARS = 128;
const MAX_VALUE_CHARS = 256;

/**
 * What could make a log line lie about itself when it is shown: C0/C1 controls,
 * the line and paragraph separators, and the bidi override/isolate characters
 * that reorder how a key or value is displayed.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** A half of a surrogate pair with no other half next to it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Caps are counted in UTF-16 code units, so a cut can land between the two
 * halves of an emoji. A lone surrogate does not survive every JSON store (a
 * failed insert would drop the whole log row), so it becomes U+FFFD; the same
 * goes for one the peer sent on its own.
 */
function capText(value: string, maxChars: number): string {
  return value.slice(0, maxChars).replace(LONE_SURROGATE, '\ufffd');
}

function cleanText(value: string, maxChars: number): string {
  return capText(value.replace(CONTROL_CHARS, ' ').trim(), maxChars);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A value that is not a string, finite number, boolean or null; `undefined` = nothing worth keeping. */
function boundLeaf(value: unknown): unknown {
  if (typeof value === 'string') return capText(value.replace(CONTROL_CHARS, ' '), MAX_VALUE_CHARS);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return '[array]';
  if (typeof value === 'object') return '[object]';
  // undefined, bigint, function, symbol: not something JSON carries.
  return undefined;
}

/**
 * Clean the entries of one object: protocol and untrusted keys dropped, keys
 * cleaned and capped, at most `MAX_KEYS` kept. `nested` decides what an object
 * value becomes (kept one level deep at the top, a marker below that).
 */
function boundEntries(
  source: Record<string, unknown>,
  nested: boolean,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(source)) {
    if (entries.length >= MAX_KEYS) break;
    if (PROTOCOL_KEYS.has(rawKey)) continue;
    const key = cleanText(rawKey, MAX_KEY_CHARS);
    // Judged after cleaning: a key padded with whitespace is still the same key.
    if (!key || UNTRUSTED_KEYS.has(key) || seen.has(key)) continue;

    let value: unknown;
    if (LOCATION_KEYS.has(key.toLowerCase())) {
      value = REDACTED_LOCATION;
    } else if (!nested && isPlainObject(rawValue)) {
      value = Object.fromEntries(boundEntries(rawValue, true));
    } else {
      value = boundLeaf(rawValue);
    }
    if (value === undefined) continue;
    seen.add(key);
    entries.push([key, value]);
  }
  return entries;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * The bounded form of a request's `_meta`, or `undefined` when there is
 * nothing to store (not an object, or nothing left after cleaning). When the
 * result is still larger than `maxBytes` once serialized, keys are dropped from
 * the end until it fits and `_truncated: true` says so.
 *
 * `scrub` (the secret redaction of the log payload) runs on every candidate
 * before it is measured: masking a short value under a sensitive key name makes
 * it longer, so the size limit has to be judged on what is actually stored.
 */
export function boundClientMeta(
  raw: unknown,
  opts: { maxBytes: number; scrub?: (meta: Record<string, unknown>) => Record<string, unknown> },
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) return undefined;
  const entries = boundEntries(raw, false);
  if (entries.length === 0) return undefined;

  const build = (kept: Array<[string, unknown]>, truncated: boolean) => {
    const meta = Object.fromEntries(truncated ? [...kept, ['_truncated', true]] : kept);
    return opts.scrub ? opts.scrub(meta) : meta;
  };

  const whole = build(entries, false);
  if (byteLength(whole) <= opts.maxBytes) return whole;
  while (entries.length > 0 && byteLength(build(entries, true)) > opts.maxBytes) entries.pop();
  return build(entries, true);
}
