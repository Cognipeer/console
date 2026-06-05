# Resilience Module

The resilience module (`src/lib/core/resilience.ts`) provides retry with exponential backoff and per-key circuit breakers for external API calls. It protects the gateway from cascading failures when upstream providers are slow or unavailable.

## Why

- **Automatic retry** — Transient failures (timeouts, 5xx errors) are retried with exponential backoff.
- **Circuit breaker** — Repeated failures trip a circuit, rejecting requests immediately until the provider recovers.
- **Per-key isolation** — Each provider/tenant combination has its own circuit breaker state.
- **Smart error classification** — Authentication errors (401, 403) and validation errors (400, 404) are never retried.

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

```typescript
interface ResilienceOptions {
  key: string;                              // Circuit breaker key
  retry?: Partial<RetryConfig>;             // Override retry settings
  circuitBreaker?: Partial<CircuitBreakerConfig>; // Override CB settings
}
```

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
| 422 | Unprocessable — validation failure |

Error messages containing `unauthorized`, `forbidden`, or `api key` also skip retry.

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
| **Closed** | Normal operation. Failures are counted. |
| **Open** | All requests are rejected immediately with `CircuitOpenError`. Timer is running. |
| **Half-open** | After reset timeout, one probe request is allowed. Success → Closed, Failure → Open. |

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
- File storage operations

## Rules

> **Mandatory**: Wrap all external provider calls with `withResilience()`. Use a descriptive key that includes the provider and/or tenant for proper circuit isolation.
