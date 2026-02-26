# CORS Module

The CORS module (`src/lib/core/cors.ts`) provides configurable Cross-Origin Resource Sharing for the client API surface (`/api/client/*`). It handles both preflight (OPTIONS) and normal requests.

## Why

- **Browser SDK support** — When customers call the gateway API from browser-based applications, CORS headers are required.
- **Security** — Origin allowlist prevents unauthorized domains from making cross-origin requests.
- **Wildcard subdomains** — Supports patterns like `*.example.com` to allow all subdomains.
- **Configurable** — Enabled/disabled via environment variables with no code changes.

## Usage

The CORS module is applied in `src/middleware.ts` for all `/api/client/*` paths:

```typescript
import { applyCors, handleCorsPreflightIfNeeded } from '@/lib/core/cors';

// Handle OPTIONS preflight
const preflightResponse = handleCorsPreflightIfNeeded(request);
if (preflightResponse) return preflightResponse;

// For normal responses:
const response = NextResponse.next();
applyCors(request, response);
```

## API Reference

### `applyCors(request, response): void`

Apply CORS headers to a response. Call this for non-preflight responses.

Headers set:
- `Access-Control-Allow-Origin` — The request origin (if allowed)
- `Access-Control-Allow-Methods` — `GET, POST, PUT, PATCH, DELETE, OPTIONS`
- `Access-Control-Allow-Headers` — `Authorization, Content-Type, X-Request-Id, X-Api-Key`
- `Access-Control-Max-Age` — Configurable (default: 86400 seconds)
- `Access-Control-Allow-Credentials` — `true`

### `handleCorsPreflightIfNeeded(request): NextResponse | null`

Handle CORS preflight (OPTIONS) requests. Returns a `204 No Content` response with CORS headers if applicable, or `null` if the request is not a preflight.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CORS_ENABLED` | `false` | Enable CORS headers |
| `CORS_ALLOWED_ORIGINS` | — | Comma-separated list of allowed origins |
| `CORS_MAX_AGE` | `86400` | Preflight cache duration (seconds) |

### Origin Patterns

```bash
# Allow specific origins
CORS_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com

# Allow all subdomains
CORS_ALLOWED_ORIGINS=*.example.com

# Allow all origins (empty list = wildcard mode when CORS_ENABLED=true)
CORS_ALLOWED_ORIGINS=
```

## Behavior Matrix

| CORS_ENABLED | Origin Match | Result |
|-------------|-------------|--------|
| `false` | — | No CORS headers |
| `true` | No list configured | All origins allowed |
| `true` | Origin in list | CORS headers added |
| `true` | Origin not in list | No CORS headers |

## Scope

CORS is applied only to `/api/client/*` paths (external API consumers). Dashboard API routes (`/api/*` without `/client/`) are not affected since they use same-origin cookies.
