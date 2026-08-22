/**
 * Resilience Module — Retry with Exponential Backoff + Circuit Breaker
 *
 * All settings come from GATEWAY_* env vars via core config.
 * No external dependencies.
 *
 * Usage:
 *   import { withResilience } from '@/lib/core/resilience';
 *
 *   const result = await withResilience(
 *     () => providerRuntime.chat(messages),
 *     { key: 'openai:tenant_abc' }
 *   );
 */

import { getConfig } from './config';
import { createLogger } from './logger';

const log = createLogger('resilience');

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface ResilienceOptions {
  /** Unique key for circuit breaker state (e.g. providerKey or providerKey:tenantId) */
  key: string;
  /** Override retry config */
  retry?: Partial<RetryConfig>;
  /** Override circuit breaker config */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  /**
   * Per-attempt timeout in ms. Defaults to GATEWAY_REQUEST_TIMEOUT_MS.
   * `0` disables the timeout for this call.
   *
   * The budget is per attempt, not per call: a retried operation gets the full
   * timeout again, the same way an HTTP client's timeout applies to each try.
   */
  timeoutMs?: number;
}

export interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;
  initialDelayMs: number;
  /** Maximum delay between retries (cap for exponential backoff) */
  maxDelayMs: number;
  /** Jitter factor (0–1). 0.25 means ±25% randomization on delay. */
  jitterFactor: number;
}

export interface CircuitBreakerConfig {
  enabled: boolean;
  /** Number of consecutive failures to trip the breaker */
  threshold: number;
  /** Time in ms before a tripped breaker moves to half-open */
  resetMs: number;
}

/* ------------------------------------------------------------------ */
/*  Non-retryable errors                                              */
/* ------------------------------------------------------------------ */

/** HTTP status codes that should never be retried */
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Authentication / authorization — don't retry
    if (msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('api key')) {
      return false;
    }
    // Check for HTTP status in error
    const statusMatch = msg.match(/status[:\s]*(\d{3})/);
    if (statusMatch && NON_RETRYABLE_STATUSES.has(parseInt(statusMatch[1], 10))) {
      return false;
    }
    // Check for status property
    if ('status' in error && typeof (error as { status: unknown }).status === 'number') {
      if (NON_RETRYABLE_STATUSES.has((error as { status: number }).status)) {
        return false;
      }
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/*  Circuit Breaker State                                             */
/* ------------------------------------------------------------------ */

type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  lastAttemptAt: number;
}

/** Per-key circuit breaker state */
const circuits = new Map<string, CircuitBreakerState>();

export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(`Circuit breaker is open for "${key}" — request rejected`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Raised when an attempt exceeds its timeout budget.
 *
 * Treated as retryable: a single upstream stall is usually transient, and a
 * provider that keeps stalling trips the circuit breaker after `threshold`
 * failed calls, which is what stops the bleeding.
 */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(key: string, timeoutMs: number) {
    super(`Request to "${key}" timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function getCircuit(key: string): CircuitBreakerState {
  let circuit = circuits.get(key);
  if (!circuit) {
    circuit = { state: 'closed', failures: 0, lastFailureAt: 0, lastAttemptAt: 0 };
    circuits.set(key, circuit);
  }
  return circuit;
}

function checkCircuit(key: string, cfg: CircuitBreakerConfig): void {
  if (!cfg.enabled) return;

  const circuit = getCircuit(key);
  const now = Date.now();

  if (circuit.state === 'open') {
    // Check if reset timeout has elapsed → move to half-open
    if (now - circuit.lastFailureAt >= cfg.resetMs) {
      circuit.state = 'half-open';
      log.info(`Circuit breaker half-open for "${key}"`);
    } else {
      throw new CircuitOpenError(key);
    }
  }

  circuit.lastAttemptAt = now;
}

function recordSuccess(key: string, cfg: CircuitBreakerConfig): void {
  if (!cfg.enabled) return;

  const circuit = getCircuit(key);
  if (circuit.state === 'half-open') {
    log.info(`Circuit breaker closed for "${key}" (recovered)`);
  }
  circuit.state = 'closed';
  circuit.failures = 0;
}

function recordFailure(key: string, cfg: CircuitBreakerConfig): void {
  if (!cfg.enabled) return;

  const circuit = getCircuit(key);
  circuit.failures += 1;
  circuit.lastFailureAt = Date.now();

  if (circuit.state === 'half-open' || circuit.failures >= cfg.threshold) {
    circuit.state = 'open';
    log.warn(`Circuit breaker opened for "${key}" (failures: ${circuit.failures})`);
  }
}

/* ------------------------------------------------------------------ */
/*  Retry with Backoff                                                */
/* ------------------------------------------------------------------ */

function calculateDelay(attempt: number, cfg: RetryConfig): number {
  // Exponential backoff: initialDelay * 2^(attempt-1)
  const baseDelay = cfg.initialDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(baseDelay, cfg.maxDelayMs);
  // Apply jitter
  const jitter = cappedDelay * cfg.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Per-attempt timeout                                               */
/* ------------------------------------------------------------------ */

/**
 * Run one attempt under a timeout.
 *
 * The signal is handed to the operation so a timeout *aborts* the upstream
 * call instead of merely abandoning it — abandoning leaves the socket, the
 * request context and (on a streaming call) the provider's generation alive,
 * which is the leak this guards against. Operations that ignore the signal
 * still stop blocking the caller, they just release their socket later.
 */
async function runAttempt<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  key: string,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation(new AbortController().signal);
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RequestTimeoutError(key, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    // Never hold the event loop open for a timer that only guards a request.
    timer.unref?.();
  });

  try {
    return await Promise.race([operation(controller.signal), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Main API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Execute an operation with retry + circuit breaker protection.
 *
 * @param operation Async function to execute
 * @param options Resilience options (key is required for circuit breaker state)
 */
export async function withResilience<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: ResilienceOptions,
): Promise<T> {
  const cfg = getConfig();

  const retryCfg: RetryConfig = {
    enabled: cfg.gateway.retryEnabled,
    maxAttempts: cfg.gateway.retryMaxAttempts,
    initialDelayMs: cfg.gateway.retryInitialDelayMs,
    maxDelayMs: 5000,
    jitterFactor: 0.25,
    ...options.retry,
  };

  const cbCfg: CircuitBreakerConfig = {
    enabled: cfg.gateway.circuitBreakerEnabled,
    threshold: cfg.gateway.circuitBreakerThreshold,
    resetMs: cfg.gateway.circuitBreakerResetMs,
    ...options.circuitBreaker,
  };

  const timeoutMs = options.timeoutMs ?? cfg.gateway.requestTimeoutMs;

  // Circuit breaker check (before any attempt)
  checkCircuit(options.key, cbCfg);

  let lastError: unknown;

  const maxAttempts = retryCfg.enabled ? retryCfg.maxAttempts : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await runAttempt(operation, options.key, timeoutMs);
      recordSuccess(options.key, cbCfg);
      return result;
    } catch (error) {
      lastError = error;

      // Don't retry non-retryable errors
      if (!isRetryable(error)) {
        log.debug(`Non-retryable error for "${options.key}", not retrying`, {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        recordFailure(options.key, cbCfg);
        throw error;
      }

      if (attempt < maxAttempts) {
        const delay = calculateDelay(attempt, retryCfg);
        log.warn(`Retry ${attempt}/${maxAttempts} for "${options.key}" in ${delay}ms`, {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(delay);

        // Re-check circuit breaker before retry
        try {
          checkCircuit(options.key, cbCfg);
        } catch (cbError) {
          throw cbError; // Circuit opened during retry wait
        }
      } else {
        log.error(`All ${maxAttempts} attempts failed for "${options.key}"`, {
          error: error instanceof Error ? error.message : String(error),
        });
        recordFailure(options.key, cbCfg);
      }
    }
  }

  throw lastError;
}

/**
 * Get circuit breaker state for a key (for monitoring / health checks).
 */
export function getCircuitState(key: string): CircuitBreakerState | undefined {
  return circuits.get(key);
}

/**
 * Get all circuit breaker states (for health/metrics endpoints).
 */
export function getAllCircuitStates(): Map<string, CircuitBreakerState> {
  return new Map(circuits);
}

/**
 * Reset a specific circuit breaker (admin / recovery action).
 */
export function resetCircuit(key: string): void {
  circuits.delete(key);
}

/**
 * Reset all circuit breakers.
 */
export function resetAllCircuits(): void {
  circuits.clear();
}
