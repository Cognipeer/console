/**
 * Free-text PII redaction for PERSISTED usage logs.
 *
 * `logRedaction.ts` masks known secret VALUES and sensitive-named KEYS, which
 * is a different problem from this one: a customer's name or email sitting
 * inside ordinary free text (`messages[].content`, a tool result, an error
 * body) has no distinctive key name or known value to match against — it can
 * only be found by scanning the text itself. This module does that scan,
 * using the same detector the PII guardrail enforces requests with
 * (`@/lib/services/pii/piiService`).
 *
 * A guardrail binding is a per-request, per-tenant DECISION about whether to
 * block/warn on PII in a LIVE call. This is unconditional and always runs
 * before a payload is written to the usage log table: an operator's
 * decision not to enforce a PII guardrail on a call should not also mean
 * "and store the customer's email in cost-tracking rows forever". If a
 * tenant genuinely needs raw, unredacted request/response bodies retained
 * for debugging, that is a separate, explicitly-permissioned capability to
 * design later — not the default for every usage log row.
 */

import { createHash } from 'node:crypto';
import { redactPii } from '@/lib/services/pii/piiService';

const MAX_DEPTH = 8;

// ── Work the detector does not need to repeat ─────────────────────────────

/** Below this a string cannot hold any category the detector finds (the shortest is `a@b.c`, five characters). */
const MIN_SCANNED_LENGTH = 4;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A hash or an object id: 16+ hex digits holding at least one letter. All-digit strings are NOT skipped: a card or phone number is one. */
const HEX_ID_PATTERN = /^(?=[0-9a-f]*[a-f])[0-9a-f]{16,}$/i;

/** True for strings that carry nothing the detector looks for: too short, or an identifier. */
function needsNoScan(str: string): boolean {
  return str.length < MIN_SCANNED_LENGTH || UUID_PATTERN.test(str) || HEX_ID_PATTERN.test(str);
}

/**
 * Results by exact string content. An agent step logs the whole conversation so far, so most strings of a payload were
 * already scanned for the previous step; the detector's answer for a string never depends on anything but the string.
 * Bounded LRU: a hit moves the entry to the end, the first key is the least recently used.
 */
const MEMO_MAX_ENTRIES = 2000;
/** Upper bound on the characters the memo holds (redacted values and inline keys), about 16 MB of UTF-16. */
const MEMO_MAX_CHARS = 8_000_000;
/** A redacted value larger than this is not kept: one long document must not push out the rest of the history. */
const MEMO_MAX_VALUE_CHARS = 500_000;
/** Strings shorter than this are their own key; longer ones are keyed by digest so the map does not hold a copy. */
const MEMO_INLINE_KEY_CHARS = 256;
/** The value of a string the detector left as it was: nothing to store beside the key. */
const UNCHANGED = null;
const memo = new Map<string, string | typeof UNCHANGED>();
let memoChars = 0;

/** The prefixes keep the two kinds of key apart: no short string can spell a digest key. */
function memoKeyOf(str: string): string {
  return str.length < MEMO_INLINE_KEY_CHARS ? `s:${str}` : `h:${createHash('sha256').update(str).digest('hex')}`;
}

function memoEntryChars(key: string, value: string | typeof UNCHANGED): number {
  return key.length + (value === UNCHANGED ? 0 : value.length);
}

function memoDelete(key: string): void {
  const value = memo.get(key);
  if (value === undefined) return;
  memo.delete(key);
  memoChars -= memoEntryChars(key, value);
}

function memoStore(key: string, value: string | typeof UNCHANGED): void {
  if (value !== UNCHANGED && value.length > MEMO_MAX_VALUE_CHARS) return;
  memoDelete(key);
  memo.set(key, value);
  memoChars += memoEntryChars(key, value);
  while (memo.size > MEMO_MAX_ENTRIES || memoChars > MEMO_MAX_CHARS) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memoDelete(oldest);
  }
}

/** Test only. */
export function clearLogPiiMemoForTests(): void {
  memo.clear();
  memoChars = 0;
}

/** Test only. */
export function logPiiMemoStatsForTests(): { entries: number; chars: number } {
  return { entries: memo.size, chars: memoChars };
}

async function scrubPiiValue(value: unknown, depth: number, seen: WeakSet<object>): Promise<unknown> {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactPiiFromLogString(value);
  if (typeof value !== 'object') return value;
  // Preserve native instances, matching logRedaction.ts's scrubValue: walking
  // a Date/Buffer/Error as a plain object would erase it (Object.entries is
  // empty -> {}).
  if (value instanceof Error || value instanceof Date || Buffer.isBuffer(value)) return value;
  if (depth > MAX_DEPTH) return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => scrubPiiValue(item, depth + 1, seen)));
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const scrubbed = await Promise.all(entries.map(([, val]) => scrubPiiValue(val, depth + 1, seen)));
  const out: Record<string, unknown> = {};
  entries.forEach(([key], i) => { out[key] = scrubbed[i]; });
  return out;
}

/**
 * Returns a deep copy of `payload` with every string value passed through
 * the PII detector's default category set and redacted. Never mutates the
 * input. Intended to run AFTER `redactLogPayload` (secret scrub) so a
 * sensitive-named key is already masked to a fixed marker before this ever
 * sees it.
 */
export async function redactPiiFromLogPayload<T>(payload: T): Promise<T> {
  if (payload === null || payload === undefined) return payload;
  return scrubPiiValue(payload, 0, new WeakSet()) as Promise<T>;
}

/** Same scan, for a single free-text field (e.g. an error message). */
export async function redactPiiFromLogString(str: string | undefined): Promise<string | undefined> {
  if (!str) return str;
  if (needsNoScan(str)) return str;
  const memoKey = memoKeyOf(str);
  const known = memo.get(memoKey);
  if (known !== undefined) {
    // Re-inserting moves the key to the end: the Map's first key is the least recently used.
    memo.delete(memoKey);
    memo.set(memoKey, known);
    return known === UNCHANGED ? str : known;
  }
  try {
    const redacted = (await redactPii({ text: str })).outputText;
    memoStore(memoKey, redacted === str ? UNCHANGED : redacted);
    return redacted;
  } catch {
    // A detector failure must never block or corrupt the write path --
    // fall back to the untouched string rather than throw.
    return str;
  }
}
