/**
 * Free-text PII redaction for PERSISTED usage logs.
 *
 * `logRedaction.ts` masks known secret VALUES and sensitive-named KEYS, which
 * is a different problem from this one: a customer's name or email sitting
 * inside ordinary free text (`messages[].content`, a tool result, an error
 * body) has no distinctive key name or known value to match against — it can
 * only be found by scanning the text itself. This module does that scan,
 * using the same detector the PII guardrail enforces requests with
 * (`@/lib/services/pii/piiService`), which already existed but — per its own
 * file header — was "intentionally not wired into other modules... yet".
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

import { redactPii } from '@/lib/services/pii/piiService';

const MAX_DEPTH = 8;

async function scrubPiiValue(value: unknown, depth: number, seen: WeakSet<object>): Promise<unknown> {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (!value) return value;
    try {
      return (await redactPii({ text: value })).outputText;
    } catch {
      // A detector failure must never block or corrupt the write path --
      // fall back to the untouched string rather than throw.
      return value;
    }
  }
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
  try {
    return (await redactPii({ text: str })).outputText;
  } catch {
    return str;
  }
}
