# Resilience Module

The resilience module (`src/lib/core/resilience.ts`) provides retry with exponential backoff and per-key circuit breakers for external API calls. It protects the gateway from cascading failures when upstream providers are slow or unavailable.

## Why

- **Automatic retry** — Transient failures (timeouts, 5xx errors) are retried with exponential backoff.
- **Circuit breaker** — Repeated failures trip a circuit, rejecting requests immediately until the provider recovers.
- **Per-key isolation** — Each provider/tenant combination has its own circuit breaker state.
- **Smart error classification** — Authentication errors (401, 403), validation errors (400, 404, 422), conflicts (409) and oversized payloads (413) are never retried, and an error can state its own verdict with a `retryable` flag.
- **Health-aware counting** — A caller can keep failures that say nothing about the provider's health (a wrong key, a missing bucket, a refused setting) out of the circuit breaker, so one bad request cannot cut a tenant off.

## Usage

```typescript
import { withResilience } from '@/lib/core/resilience';

const result = await withResilience(
  () => providerRuntime.chat(messages),
  { key: 'openai:tenant_acme' }
);
```

### With Configuration Overrides

```typescript
const result = await withResilience(
  () => embeddingProvider.embed(text),
  {
    key: 'voyage:tenant_acme',
    retry: { maxAttempts: 5, initialDelayMs: 500 },
    circuitBreaker: { threshold: 10 },
  }
);
```

## API Reference

### `withResilience<T>(operation, options): Promise<T>`

Execute an async operation with retry and circuit breaker protection.

The operation receives an `AbortSignal` (ignore it if you do not need it).

```typescript
interface ResilienceOptions {
  key: string;                              // Circuit breaker key
  retry?: Partial<RetryConfig>;             // Override retry settings
  circuitBreaker?: Partial<CircuitBreakerConfig>; // Override CB settings
  timeoutMs?: number;                       // Per-attempt timeout; default GATEWAY_REQUEST_TIMEOUT_MS, 0 = none
  signal?: AbortSignal;                     // The caller's cancellation (neutral for the circuit)
  countFailure?: (error: unknown) => boolean; // false = this failure is not about the provider's health
}
```

| Option | Behavior |
|--------|----------|
| `timeoutMs` | The budget is **per attempt**: a retried operation gets the full timeout again. A timeout aborts the operation's signal and raises `RequestTimeoutError`, which is retryable. |
| `signal` | The caller walked away (a client hung up, a barge-in). The operation's signal aborts with it, nothing is retried and the call rejects with an `AbortError`. It is neither a success nor a failure for the circuit: the failure count and a half-open circuit stay as they were. |
| `countFailure` | Asked once per call that failed for good (not retryable, or out of attempts) with the error it ended on. Return `false` for a failure that does not say the provider is unwell. See [Failures that do not count](#failures-that-do-not-count). |

### `getCircuitState(key): CircuitBreakerState | undefined`

Get the current circuit breaker state for monitoring.

### `getAllCircuitStates(): Map<string, CircuitBreakerState>`

Get all circuit breaker states (for health/metrics endpoints).

### `resetCircuit(key): void`

Manually reset a specific circuit breaker (admin recovery action).

### `resetAllCircuits(): void`

Reset all circuit breakers.

## Retry Behavior

```
Attempt 1 → fails → wait 200ms (± jitter)
Attempt 2 → fails → wait 400ms (± jitter)
Attempt 3 → fails → throw last error + record circuit failure
```

### Retry Configuration

| Setting | Env Variable | Default |
|---------|-------------|---------|
| Enabled | `GATEWAY_RETRY_ENABLED` | `true` |
| Max attempts | `GATEWAY_RETRY_MAX_ATTEMPTS` | `3` |
| Initial delay | `GATEWAY_RETRY_INITIAL_DELAY_MS` | `200` |
| Max delay cap | — | `5000ms` |
| Jitter factor | — | `0.25` (±25%) |

### Non-Retryable Errors

These HTTP status codes are never retried:

| Status | Reason |
|--------|--------|
| 400 | Bad request — fix the input |
| 401 | Unauthorized — credentials are wrong |
| 403 | Forbidden — access denied |
| 404 | Not found — resource doesn't exist |
| 409 | Conflict — duplicate resource |
| 413 | Payload too large — the same body is refused every time |
| 422 | Unprocessable — validation failure |

The status is read wherever the SDK that raised the error keeps it: `status` (fetch-style clients), `statusCode` (the agent-sdk providers and the Azure SDK) or `$metadata.httpStatusCode` (the AWS SDK). Other statuses stay retryable — `408`, `429` and every `5xx` among them.

Error messages containing `unauthorized`, `forbidden`, or `api key`, or a `status NNN` from the list above, also skip retry. So do these error codes, which fail the same way each time they are sent: `ERR_INVALID_CHAR` and `ERR_INVALID_HTTP_TOKEN` (a value Node refuses to write as an HTTP header) and `ENOENT`, `ENOTDIR` and `EISDIR` (a path that is not there, or is a directory).

### The `retryable` flag

An error can carry its own verdict as a boolean `retryable` property, and it beats every guess above in both directions: `retryable: false` is never retried (a storage driver that already classified a rejected key or a refused setting), `retryable: true` is retried even when the message looks like an authentication failure. `isRetryable(error)` is the one function behind these rules; callers that need a different question answered (does this failure say the provider is unwell?) start from it instead of keeping a list of their own.

## Circuit Breaker

The circuit breaker follows the standard three-state pattern:

```
         success
  ┌──────────────┐
  │              │
  ▼    failure   │
CLOSED ────────► OPEN
  ▲              │
  │    timeout   │
  │              ▼
  └──────── HALF-OPEN
              │
              │ failure
              ▼
             OPEN
```

### States

| State | Behavior |
|-------|----------|
| **Closed** | Normal operation. A call that fails for good (after its retries) adds one to the failure count; a success resets the count to zero. At the threshold the circuit opens. |
| **Open** | All requests are rejected immediately with `CircuitOpenError`. The reset timer runs from the last counted failure. |
| **Half-open** | Once the reset timeout has passed, the next call is let through and the circuit becomes half-open. Calls made while it is half-open are **not** held back: there is no single probe request. A success closes the circuit and clears the failure count; a counted failure opens it again at once; a failure that is not counted (see below) leaves it half-open, so the next call probes again. |

A call counts once, however many attempts it took: only the failure that ended it is recorded, and an operation cancelled by its caller is recorded as neither a success nor a failure.

### Failures that do not count

A refused credential, a missing bucket, a file that is too large or a setting the provider rejects fails the same way for every request and says nothing about whether the provider is up. `countFailure` lets the caller keep such failures out of the breaker. The caller still gets the error, and retrying is decided separately; but an uncounted failure is **neutral**: a closed circuit keeps its failure count (it is not reset either), and a half-open circuit stays half-open. A predicate that throws counts the failure.

```typescript
const result = await withResilience(
  () => runtime.uploadFile(input),
  {
    key: `file-upload:${tenantId}:${providerKey}`,
    // Only an outage should cut the tenant's uploads off, not a request that can never succeed.
    countFailure: isTransientStorageError,
  },
);
```

### Circuit Breaker Configuration

| Setting | Env Variable | Default |
|---------|-------------|---------|
| Enabled | `GATEWAY_CIRCUIT_BREAKER_ENABLED` | `true` |
| Failure threshold | `GATEWAY_CIRCUIT_BREAKER_THRESHOLD` | `5` |
| Reset timeout | `GATEWAY_CIRCUIT_BREAKER_RESET_MS` | `30000` (30s) |

## Error Handling

```typescript
import { withResilience, CircuitOpenError } from '@/lib/core/resilience';

try {
  const result = await withResilience(fn, { key: 'provider:tenant' });
} catch (error) {
  if (error instanceof CircuitOpenError) {
    // Provider is temporarily unavailable — circuit is open
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }
  // Other error (after all retries exhausted)
  throw error;
}
```

## Where It's Used

The gateway wraps these external calls with resilience:

- LLM chat completions (per provider + tenant)
- Embedding requests
- Vector store operations (upsert, query, delete)
- File storage operations (upload, download, delete, list)

### File storage circuits

Each file operation has a circuit per tenant **and** provider: the key is `file-<operation>:<tenantId>:<providerKey>`, with the operation one of `upload`, `download`, `delete` or `list`. A provider key is only unique inside its tenant, so the tenant is part of the key, and an outage of one tenant's store never opens another tenant's circuit. File calls pass `countFailure: isTransientStorageError`:

| Counts against the circuit | Does not count |
|----------------------------|----------------|
| Timeouts, network failures, `408`, `429`, `5xx`, and anything unclassified | A failure that declares `retryable: false` (refused settings and endpoints do), anything `isRetryable` calls hopeless (`403`, `404`, `413`, `ENOENT`, a header Node refuses to write...), and any other `4xx` |
| A failure that declares `retryable: true` (a resolver that is down) | |

An open circuit answers file calls with `503` and `code: "storage_unavailable"`, a timeout with `504` and `storage_timeout`; see [Files](/guide/files#resilience).

## Rules

> **Mandatory**: Wrap all external provider calls with `withResilience()`. Use a descriptive key that includes the provider and/or tenant for proper circuit isolation.
