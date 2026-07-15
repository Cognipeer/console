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
}

export async function retry<T>(
  fn: () => Promise<T>,
  attempts: number,
  options: RetryOptions = {},
): Promise<T> {
  const { initialDelayMs = 1000, isRetryable } = options;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (isRetryable && !isRetryable(err)) throw err;
      if (i < attempts - 1) {
        await new Promise<void>((r) => setTimeout(r, initialDelayMs * (i + 1)));
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
