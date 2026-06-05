# Request Context Module

The request context module (`src/lib/core/requestContext.ts`) provides per-request state propagation using Node.js `AsyncLocalStorage`. It allows any function in the call chain to access request metadata without explicit parameter passing.

## Why

- **Implicit propagation** — Request ID, tenant ID, and user ID flow through the entire async call chain automatically.
- **Zero coupling** — Services, loggers, and middleware read context without being explicitly passed request objects.
- **Observability** — Every log entry, cache key, and error report can include the originating request ID.

## Usage

### Setting Context (Route Entry Point)

```typescript
import { runWithRequestContext } from '@/lib/core/requestContext';

// In middleware or route handler:
return runWithRequestContext(
  {
    requestId: crypto.randomUUID(),
    tenantId: 'tenant_acme',
    tenantSlug: 'acme',
    userId: 'user_123',
  },
  async () => {
    // Everything inside inherits this context
    return handleRequest(request);
  }
);
```

### Reading Context (Anywhere Downstream)

```typescript
import { getRequestContext } from '@/lib/core/requestContext';

function myServiceFunction() {
  const ctx = getRequestContext();
  if (ctx) {
    console.log(ctx.requestId);   // "a1b2c3d4-..."
    console.log(ctx.tenantId);    // "tenant_acme"
    console.log(ctx.startedAt);   // 1705312245000
  }
  // ctx is undefined outside of a request context
}
```

## API Reference

### `runWithRequestContext<T>(partial, fn): T`

Runs a function within a request context. All async operations spawned inside inherit the context automatically.

```typescript
function runWithRequestContext<T>(
  partial: Partial<RequestContext>,
  fn: () => T,
): T
```

- **`partial.requestId`** — Auto-generated UUID if not provided
- **`partial.startedAt`** — Defaults to `Date.now()` if not provided
- Other fields are optional

### `getRequestContext(): RequestContext | undefined`

Returns the current request context, or `undefined` if called outside of a context.

### `getRequestId(): string`

Convenience function that returns the current request ID, or generates a new UUID as fallback.

```typescript
import { getRequestId } from '@/lib/core/requestContext';

const id = getRequestId(); // always returns a string
```

## RequestContext Interface

```typescript
interface RequestContext {
  requestId: string;     // Unique request identifier
  tenantId?: string;     // Tenant database name (e.g., "tenant_acme")
  tenantSlug?: string;   // Tenant URL slug (e.g., "acme")
  userId?: string;       // Authenticated user ID
  startedAt: number;     // Request start timestamp (epoch ms)
}
```

## Integration with withRequestContext

The `withRequestContext` wrapper in `src/lib/api/withRequestContext.ts` automatically sets up request context for API routes using middleware-injected headers:

```typescript
import { withRequestContext } from '@/lib/api/withRequestContext';

export const GET = withRequestContext(async (request) => {
  // Context is already set from x-user-id, x-tenant-id, etc. headers
  // Logger, services, cache all pick it up automatically
  return NextResponse.json({ ok: true });
});
```

Headers extracted by the wrapper:

| Header | Context Field |
|--------|--------------|
| `x-user-id` | `userId` |
| `x-tenant-id` | `tenantId` |
| `x-tenant-slug` | `tenantSlug` |
| `x-request-id` | `requestId` |

## How It Flows

```
Request → Middleware (validates JWT)
       → withRequestContext (sets up AsyncLocalStorage)
         → Route Handler
           → Service Layer
             → createLogger('service').info(...)  ← requestId auto-injected
             → getCache().set(`key:${tenantId}`)  ← tenantId available
             → withResilience(fn, { key })        ← scoped per-request
```

## Lifecycle

- Context is created when `runWithRequestContext()` is called
- It persists for the duration of the callback (including all `await` chains)
- It is automatically cleaned up when the callback completes
- Nested calls create new contexts (inner overrides outer)
