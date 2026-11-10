/**
 * Retry + timeout helpers for the evaluation invokers.
 *
 * A suite run makes hundreds of provider calls; one 429 or one hung socket must
 * not turn into a failed item (or, for a hang, a worker slot that never comes
 * back and a run that never finishes). Model / retrieval targets and the LLM
 * judge retry transient transport failures; agent targets never do — an agent's
 * tools may have side effects, so a blind re-run is not safe — but they still get
 * a timeout.
 */

/** Delays before retry 1 and retry 2 (a rate-limited provider usually recovers within seconds). */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [1000, 3000];

/** Longest `Retry-After` we are willing to wait for; a provider asking for more is treated as a plain backoff. */
const MAX_RETRY_AFTER_MS = 30_000;

/** A call that did not answer within its time budget. Retryable (like a socket timeout), message says how long. */
export class EvaluationTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'EvaluationTimeoutError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** HTTP status an error exposes, whichever property the client library used. */
function statusOf(error: unknown): number | undefined {
  const e = asRecord(error);
  if (!e) return undefined;
  const candidates = [e.status, e.statusCode, asRecord(e.response)?.status, asRecord(e.response)?.statusCode];
  for (const candidate of candidates) {
    const n = typeof candidate === 'string' ? Number(candidate) : candidate;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  return undefined;
}

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

const RETRYABLE_MESSAGE =
  /\b(?:timed? ?out|timeout|etimedout|econnreset|socket hang up|overloaded|rate[ _-]?limit(?:ed)?|too many requests|service unavailable|bad gateway|gateway timeout|temporarily unavailable)\b|\b(?:status|http|error|code)\s*[:=]?\s*(?:408|429|5\d\d)\b/i;

/**
 * Whether an error is worth another attempt: HTTP 408/429/5xx, timeouts,
 * connection resets and "overloaded" / "rate limit" wording. Everything else
 * (auth, 400/404, output-limit verdicts, validation) is deterministic — retrying
 * it only burns money.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof EvaluationTimeoutError) return true;
  const status = statusOf(error);
  if (status !== undefined) return status === 408 || status === 429 || status >= 500;
  const e = asRecord(error);
  const code = typeof e?.code === 'string' ? e.code.toUpperCase() : undefined;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const cause = asRecord(e?.cause);
  const causeCode = typeof cause?.code === 'string' ? cause.code.toUpperCase() : undefined;
  if (causeCode && RETRYABLE_CODES.has(causeCode)) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return RETRYABLE_MESSAGE.test(message);
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value = (get as (n: string) => unknown).call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }
  const record = asRecord(headers);
  if (!record) return undefined;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name && typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

/** The delay a provider asked for (`Retry-After`, seconds or an HTTP date), when the error exposes one. */
export function retryAfterMs(error: unknown): number | undefined {
  const e = asRecord(error);
  if (!e) return undefined;
  const direct = e.retryAfter ?? e.retry_after;
  let raw: string | undefined;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) {
    return Math.min(direct * 1000, MAX_RETRY_AFTER_MS);
  }
  if (typeof direct === 'string') raw = direct;
  raw ??= headerValue(e.headers, 'retry-after') ?? headerValue(asRecord(e.response)?.headers, 'retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
  return undefined;
}

export interface CallPolicy {
  /** Time budget of ONE attempt. */
  timeoutMs: number;
  /** Extra attempts after the first; 0 = never retry (agent targets). */
  retries: number;
  /** Delay before each retry; the last entry repeats. */
  backoffMs?: readonly number[];
  /** Names the call in the timeout message ("Target model call"). */
  label?: string;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One attempt under a deadline. The callee gets an AbortSignal (aborted at the
 * deadline) when it can use one; a callee that ignores it is still released: the
 * returned promise rejects with `EvaluationTimeoutError` at the deadline either
 * way, so a hung socket cannot hold a runner slot.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label = 'Call',
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new EvaluationTimeoutError(label, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    const attempt = fn(controller.signal);
    // The loser of the race must not surface as an unhandled rejection.
    attempt.catch(() => undefined);
    return await Promise.race([attempt, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run `fn` with a per-attempt timeout and (when `policy.retries > 0`) retries of retryable errors. */
export async function callWithPolicy<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  policy: CallPolicy,
): Promise<T> {
  const backoff = policy.backoffMs && policy.backoffMs.length > 0 ? policy.backoffMs : DEFAULT_RETRY_BACKOFF_MS;
  const sleep = policy.sleep ?? realSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTimeout(fn, policy.timeoutMs, policy.label);
    } catch (error) {
      if (attempt >= policy.retries || !isRetryableError(error)) throw error;
      const base = backoff[Math.min(attempt, backoff.length - 1)];
      await sleep(retryAfterMs(error) ?? base);
    }
  }
}
