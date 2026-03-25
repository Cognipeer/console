# Core Modules Overview

The core infrastructure layer (`src/lib/core/`) provides production-ready cross-cutting concerns used by all services. These modules are initialized during application startup and follow consistent patterns.

## Module Map

| Module | Import | Purpose |
|--------|--------|---------|
| Config | `@/lib/core/config` | Centralized typed configuration |
| Logger | `@/lib/core/logger` | Structured logging with request context |
| Request Context | `@/lib/core/requestContext` | Per-request AsyncLocalStorage |
| Cache | `@/lib/core/cache` | Provider-based caching (none/memory/Redis) |
| Resilience | `@/lib/core/resilience` | Retry + circuit breaker for external calls |
| Runtime Pool | `@/lib/core/runtimePool` | LRU cache for provider SDK instances |
| Async Tasks | `@/lib/core/asyncTask` | Fire-and-forget background operations |
| Health | `@/lib/core/health` | Health check registry |
| Lifecycle | `@/lib/core/lifecycle` | Graceful shutdown management |
| CORS | `@/lib/core/cors` | CORS handling for client APIs |

## Design Principles

1. **Direct imports only** — Import from the specific module path (e.g., `@/lib/core/logger`) rather than barrel exports. This is required for Turbopack compatibility with Edge Runtime.

2. **No silent fallbacks** — If Redis is configured and unavailable, operations fail explicitly rather than silently falling back to memory.

3. **Singleton lifecycle** — Core modules are initialized once at startup via `src/instrumentation.ts` and destroyed during graceful shutdown.

4. **Mandatory rules** — See [AGENTS.md](https://github.com/Cognipeer/cognipeer-console/blob/main/AGENTS.md) for the full list of core infrastructure rules.

## Initialization Order

The bootstrap sequence in `src/instrumentation.ts`:

```typescript
// 1. Config validation
const cfg = getConfig();
validateConfig(cfg);

// 2. Lifecycle (signal handlers)
initLifecycle();

// 3. Cache provider
await getCache();
registerHealthCheck('cache', ...);

// 4. Shutdown handlers (LIFO: last registered runs first)
registerShutdownHandler('async-tasks', () => drainPendingTasks());
registerShutdownHandler('cache', () => destroyCache());
registerShutdownHandler('runtime-pool', () => runtimePool.destroy());

// 5. Background schedulers
startPollScheduler();
startAlertScheduler();
```

## Import Pattern

```typescript
// ✅ Correct — direct path import
import { createLogger } from '@/lib/core/logger';
import { getConfig } from '@/lib/core/config';
import { withResilience } from '@/lib/core/resilience';

// ❌ Wrong — barrel imports cause Edge Runtime issues
import { createLogger, getConfig } from '@/lib/core';
```
