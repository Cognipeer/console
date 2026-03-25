# Async Tasks Module

The async tasks module (`src/lib/core/asyncTask.ts`) provides fire-and-forget execution for non-critical background work. It tracks pending promises so they can be drained during graceful shutdown.

## Why

- **Non-blocking responses** — Usage logging, tracing ingestion, and cache writes run in the background without delaying the API response.
- **Error isolation** — Failures in background tasks are logged but never propagate to the caller.
- **Graceful drain** — All pending tasks are awaited during shutdown to prevent data loss.
- **Observability** — Task count is available for monitoring and health checks.

## Usage

```typescript
import { fireAndForget } from '@/lib/core/asyncTask';

// In a route handler — log usage without blocking response:
fireAndForget('log-usage', () => logModelUsage(db, model, payload));

// Tracing ingestion:
fireAndForget('tracing-ingest', () => ingestSession(dbName, session));

// Cache write:
fireAndForget('cache-set', () => cache.set(key, value));
```

## API Reference

### `fireAndForget(label, fn): void`

Schedule a non-critical async operation that runs in the background.

| Parameter | Description |
|-----------|-------------|
| `label` | Short descriptive label for logging (e.g., `'log-usage'`) |
| `fn` | Async function to execute |

**Behavior:**
- The function runs immediately but the caller does not wait for it
- Errors are caught and logged — they never propagate to the caller
- The promise is tracked so `drainPendingTasks()` can wait for it

```typescript
// This returns immediately — the caller is not blocked
fireAndForget('log-model-usage', async () => {
  await db.insertLogEntry(usageData);
});

// Response is sent while usage logging happens in background
return NextResponse.json(result);
```

### `drainPendingTasks(timeoutMs?): Promise<void>`

Wait for all pending fire-and-forget tasks to complete. Used during graceful shutdown.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `timeoutMs` | `5000` | Maximum time to wait |

```typescript
import { drainPendingTasks } from '@/lib/core/asyncTask';

// In shutdown handler:
registerShutdownHandler('async-tasks', () => drainPendingTasks());
```

If the timeout expires before all tasks complete, a warning is logged and shutdown continues.

### `pendingTaskCount(): number`

Returns the current count of pending tasks. Useful for monitoring and health checks.

```typescript
import { pendingTaskCount } from '@/lib/core/asyncTask';

logger.info('Pending async tasks', { count: pendingTaskCount() });
```

## Where It's Used

| Use Case | Label | Description |
|----------|-------|-------------|
| Model usage logging | `log-usage` | Records token counts, latency, model info |
| Tracing session ingestion | `tracing-ingest` | Processes batch tracing data |
| Tracing stream events | `tracing-stream-*` | Processes streaming trace events |
| Cache writes | `cache-set` | Non-critical cache updates |

## Shutdown Integration

Async tasks are the first thing drained during shutdown (LIFO order):

```typescript
// In instrumentation.ts:
registerShutdownHandler('async-tasks', () => drainPendingTasks());
registerShutdownHandler('cache', () => destroyCache());
registerShutdownHandler('runtime-pool', () => runtimePool.destroy());
```

Since shutdown handlers run in reverse order, async tasks drain before cache and runtime pool are destroyed — ensuring background tasks can still access these resources.

## Error Handling

```typescript
fireAndForget('risky-operation', async () => {
  // If this throws, the error is:
  // 1. Caught by fireAndForget
  // 2. Logged with the label
  // 3. NOT propagated to the caller
  throw new Error('Something went wrong');
});

// Log output:
// ERROR [async-task] Async task "risky-operation" failed { error: "Something went wrong" }
```
