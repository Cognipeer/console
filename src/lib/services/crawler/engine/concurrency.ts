/**
 * Simple counting semaphore + retry helper.
 */

export class Semaphore {
  private counter = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.counter < this.max) {
      this.counter++;
      return;
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.counter = Math.max(0, this.counter - 1);
    }
  }
}

export interface RetryOptions {
  initialDelayMs?: number;
  /**
   * Return false to stop retrying immediately and rethrow. Used to skip work
   * on errors that will never succeed on a re-attempt (bad TLS chain, 404/403,
   * DNS failures), so a run isn't paying N attempts + backoff for every dead
   * URL. Retryable-by-default when omitted.
   */
  isRetryable?: (err: unknown) => boolean;
  /**
   * Milliseconds to wait before the next attempt. `attempt` is the 0-based
   * index of the attempt that just failed. Defaults to a linear
   * `initialDelayMs * (attempt + 1)`.
   */
  getDelayMs?: (err: unknown, attempt: number) => number;
}

export async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
  options: RetryOptions = {},
): Promise<T> {
  const { initialDelayMs = 1000, isRetryable, getDelayMs } = options;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isRetryable && !isRetryable(err)) throw err;
      if (i < attempts - 1) {
        const delay = getDelayMs ? getDelayMs(err, i) : initialDelayMs * (i + 1);
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Heuristic error classifier shared by the fetchers. Permanent failures (a
 * broken/untrusted TLS chain, 4xx client errors, DNS/host-not-found) return
 * false so `retry()` bails out at once; everything else (timeouts, resets,
 * 5xx, transient WAF blips) stays retryable.
 */
export function isTransientFetchError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Permanent TLS trust problems — re-fetching the same cert won't fix them.
  if (
    message.includes('unable to verify the first certificate') ||
    message.includes('self-signed certificate') ||
    message.includes('self signed certificate') ||
    message.includes('cert_has_expired') ||
    message.includes('certificate has expired') ||
    message.includes('altname') ||
    message.includes('hostname/ip does not match') ||
    message.includes('err_tls_cert_altname_invalid')
  ) {
    return false;
  }
  // Permanent DNS / unroutable host.
  if (
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('getaddrinfo')
  ) {
    return false;
  }
  // 4xx client errors (except 408 Request Timeout / 429 Too Many Requests,
  // which can succeed on a retry). Matches "HTTP 404 for …" style messages.
  const httpMatch = /http (\d{3})/.exec(message);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code >= 400 && code < 500 && code !== 408 && code !== 429) return false;
  }
  return true;
}

/**
 * The peer closed or reset the connection before answering (axios/undici and
 * Chromium spellings). Typical of a firewall/WAF or load balancer shedding
 * load from a source IP — which is usually a RATE, not a permanent block, so
 * it can clear if we back off for longer than a normal transient blip.
 */
export function isConnectionResetError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes('econnreset') ||
    message.includes('err_connection_reset') ||
    message.includes('err_connection_closed') ||
    message.includes('err_empty_response') ||
    message.includes('socket hang up') ||
    message.includes('other side closed') ||
    message.includes('epipe')
  );
}

// Waits between attempts for a reset host (index = attempt that just failed;
// the last value repeats). Much longer than the 1s/2s default, which ends
// well inside a typical rate-limit window.
const RESET_BACKOFF_MS = [2000, 6000, 15000] as const;
// Pause before handing a reset host to the other engine, so the browser
// attempt isn't a second burst straight after the first one.
const RESET_COOLDOWN_MS = 3000;

/** +/-25% so concurrent fetches of one host don't retry in lockstep. */
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

/**
 * `retry()` delay policy: long jittered backoff for connection resets, the
 * default linear 1s/2s/... for every other retryable error.
 */
export function resetAwareDelayMs(err: unknown, attempt: number): number {
  if (!isConnectionResetError(err)) return 1000 * (attempt + 1);
  return jitter(RESET_BACKOFF_MS[Math.min(attempt, RESET_BACKOFF_MS.length - 1)]);
}

/**
 * After an engine fails with a connection reset, wait briefly before trying
 * the other engine on the same host. No-op for any other error. Returns early
 * when the crawl is cancelled.
 */
export async function coolDownAfterReset(err: unknown, signal?: AbortSignal): Promise<void> {
  if (!isConnectionResetError(err) || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, jitter(RESET_COOLDOWN_MS));
    signal?.addEventListener('abort', done, { once: true });
  });
}
