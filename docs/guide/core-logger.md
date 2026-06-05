# Logger Module

The logger module (`src/lib/core/logger.ts`) provides structured, context-aware logging built on Winston. It automatically injects request context (requestId, tenantId) into every log entry.

## Why

- **Structured output** — JSON in production, colorized pretty-print in development.
- **Automatic context** — Request ID and tenant ID are injected transparently via `AsyncLocalStorage`.
- **Scoped loggers** — Each module gets a named child logger for easy filtering.
- **Configuration-driven** — Log level and format are controlled via environment variables.

## Usage

```typescript
import { createLogger } from '@/lib/core/logger';

const logger = createLogger('inference');

logger.info('Chat completion started', { model: 'gpt-4', tokens: 150 });
logger.warn('Rate limit approaching', { usage: 95 });
logger.error('Provider call failed', { error: err.message });
logger.debug('Request payload', { body: sanitized });
```

## Output Formats

### Pretty Format (Development)

```
2025-01-15 10:30:45.123 info [inference](a1b2c3d4){tenant_acme} Chat completion started {"model":"gpt-4","tokens":150}
```

Components: `timestamp level [scope](requestId){tenantId} message {extra}`

### JSON Format (Production)

```json
{
  "timestamp": "2025-01-15 10:30:45.123",
  "level": "info",
  "scope": "inference",
  "requestId": "a1b2c3d4-...",
  "tenantId": "tenant_acme",
  "message": "Chat completion started",
  "model": "gpt-4",
  "tokens": 150
}
```

## API Reference

### `createLogger(scope: string): Logger`

Creates a scoped child logger. The scope tag appears in every log entry.

```typescript
// File: src/lib/services/vector/vectorService.ts
const logger = createLogger('vector-service');
```

### `logger` (Root Logger)

The root logger instance. Prefer `createLogger(scope)` for domain-specific logging.

```typescript
import { logger } from '@/lib/core/logger';
logger.info('Server started');
```

### `resetLogger(): void`

Forces logger reconfiguration. Used in tests after config changes.

## Configuration

| Variable | Values | Default |
|----------|--------|---------|
| `LOG_LEVEL` | `error`, `warn`, `info`, `debug` | `debug` (dev) / `info` (prod) |
| `LOG_FORMAT` | `json`, `pretty` | `pretty` (dev) / `json` (prod) |

## Context Injection

When a request runs inside `runWithRequestContext()`, the logger automatically attaches:

| Field | Source |
|-------|--------|
| `requestId` | From request context (8-char prefix in pretty mode) |
| `tenantId` | From request context |
| `tenantSlug` | From request context |
| `userId` | From request context |

This happens transparently — no manual passing required:

```typescript
// In route handler wrapped with withRequestContext:
const logger = createLogger('my-service');
logger.info('Processing request'); 
// Output includes requestId, tenantId automatically
```

## Rules

> **Mandatory**: Never use `console.log`, `console.error`, or `console.warn` in server-side code (`src/lib/`, `src/app/api/`). Always use `createLogger()`.

**Exception**: Client components (`'use client'`) run in the browser where Winston is not available — `console.error` is acceptable there.

## Best Practices

```typescript
// ✅ Create one logger per file/module
const logger = createLogger('my-service');

// ✅ Use structured data, not string interpolation
logger.info('User created', { userId, email });

// ❌ Don't do this
logger.info(`User ${userId} created with email ${email}`);

// ✅ Log errors with context
logger.error('Operation failed', {
  error: err.message,
  stack: err.stack,
  context: { modelKey, provider },
});

// ❌ Never log sensitive data
logger.info('Request', { apiKey, password }); // WRONG
```
