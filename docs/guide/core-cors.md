# CORS Module

CORS for the client API surface (`/api/client/*`) lives in `src/server/api/cors.ts` and is applied by the Fastify API plugin (`src/server/api/plugin.ts`). It handles both preflight (OPTIONS) and normal requests.

## Why

- **Browser SDK support** — When customers call the gateway API from browser-based applications, CORS headers are required.
- **Security** — Origin allowlist prevents unauthorized domains from making cross-origin requests.
- **Wildcard subdomains** — Supports patterns like `*.example.com` to allow all subdomains.
- **Configurable** — Enabled/disabled via environment variables with no code changes.

## API Reference

### `applyCorsHeaders(request, reply): boolean`

Sets CORS headers on a Fastify reply when CORS is enabled and the request origin is allowed. Returns `true` if headers were set.

Headers set:
- `Access-Control-Allow-Origin` — The request origin (if allowed)
- `Access-Control-Allow-Methods` — `GET, POST, PUT, PATCH, DELETE, OPTIONS`
- `Access-Control-Allow-Headers` — `Authorization, Content-Type, X-Request-Id, X-Api-Key`
- `Access-Control-Max-Age` — Configurable (default: 86400 seconds)
- `Access-Control-Allow-Credentials` — `true`
- `Access-Control-Expose-Headers` — `X-Decision-Id`

### `matchesAllowedOrigin(origin, allowedOrigins): boolean`

Whether an origin is in the allowlist: an exact origin or a `*.example.com` wildcard.

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

# Empty list = no origins allowed (CORS headers are not emitted)
CORS_ALLOWED_ORIGINS=
```

## Behavior Matrix

| CORS_ENABLED | Origin Match | Result |
|-------------|-------------|--------|
| `false` | — | No CORS headers |
| `true` | No list configured (empty) | No CORS headers |
| `true` | Origin in list | CORS headers added |
| `true` | Origin not in list | No CORS headers |

## Scope

CORS is applied only to `/api/client/*` paths (external API consumers). Dashboard API routes (`/api/*` without `/client/`) are not affected since they use same-origin cookies.
