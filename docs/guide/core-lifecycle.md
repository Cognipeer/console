# Lifecycle Module

The lifecycle module (`src/lib/core/lifecycle.ts`) manages graceful shutdown and resource cleanup. It registers signal handlers and executes shutdown handlers in reverse order (LIFO) on `SIGTERM` or `SIGINT`.

## Why

- **Data integrity** — Pending writes, background tasks, and open connections are cleaned up before the process exits.
- **LIFO ordering** — High-level services shut down before low-level resources they depend on.
- **Timeout protection** — A configurable deadline forces exit if shutdown handlers stall.
- **Double-shutdown guard** — Prevents re-entry if multiple signals arrive.

## Usage

### Initialization

```typescript
import { initLifecycle } from '@/lib/core/lifecycle';

// Called once in instrumentation.ts:
initLifecycle();
```

### Registering Shutdown Handlers

```typescript
import { registerShutdownHandler } from '@/lib/core/lifecycle';

registerShutdownHandler('async-tasks', async () => {
  await drainPendingTasks();
});

registerShutdownHandler('cache', async () => {
  await destroyCache();
});

registerShutdownHandler('runtime-pool', async () => {
  runtimePool.destroy();
});
```

**Registration order matters** — handlers run in LIFO (reverse) order:

```
Register: async-tasks → cache → runtime-pool
Execute:  runtime-pool → cache → async-tasks
```

This ensures high-level services shut down before the resources they depend on.

### Checking Shutdown State

```typescript
import { isShuttingDown } from '@/lib/core/lifecycle';

if (isShuttingDown()) {
  return NextResponse.json({ error: 'Server shutting down' }, { status: 503 });
}
```

## API Reference

### `initLifecycle(): void`

Initialize the lifecycle manager. Registers `SIGTERM`, `SIGINT`, `unhandledRejection`, and `uncaughtException` handlers. Must be called once at startup.

### `registerShutdownHandler(name, handler): void`

Register a named shutdown handler. Handlers execute in LIFO order during shutdown.

| Parameter | Description |
|-----------|-------------|
| `name` | Human-readable identifier for logging |
| `handler` | Async cleanup function |

### `isShuttingDown(): boolean`

Returns `true` if the process is currently shutting down. Use this to decline new work.

## Shutdown Sequence

When `SIGTERM` or `SIGINT` is received:

```
1. Set shuttingDown = true
2. Start timeout timer (SHUTDOWN_TIMEOUT_MS)
3. Run handlers in LIFO order:
   - Each handler logs "Shutting down: {name}"
   - Errors are caught and logged (don't stop other handlers)
   - Each success logs "Shut down: {name} ✓"
4. Log "Graceful shutdown complete"
5. process.exit(0)

If timeout expires → log error → process.exit(1)
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Maximum time for all shutdown handlers |

## Signal Handling

| Signal | When |
|--------|------|
| `SIGTERM` | Kubernetes pod termination, Docker stop |
| `SIGINT` | Ctrl+C in development |
| `unhandledRejection` | Unhandled promise rejection (logged, not fatal) |
| `uncaughtException` | Uncaught sync exception (logged, exit after 1s) |

## Integration with withRequestContext

The `withRequestContext` wrapper checks `isShuttingDown()` before processing requests:

```typescript
export function withRequestContext(handler) {
  return async (request, context) => {
    if (isShuttingDown()) {
      return NextResponse.json(
        { error: 'Server is shutting down' },
        { status: 503 }
      );
    }
    // ... process request
  };
}
```

## Rules

> **Mandatory**: Call `initLifecycle()` once from `instrumentation.ts`. Register shutdown handlers for any resource that needs cleanup (database connections, cache providers, SDK pools, etc.).
