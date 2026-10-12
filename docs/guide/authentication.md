# Authentication

The gateway supports two authentication mechanisms: JWT-based session auth for the dashboard and API token auth for client APIs. Authentication says who is calling; what the caller may do is decided by the policy engine, described in [Authorization](/guide/authorization).

## Authentication Modes

| Mode | Used For | Mechanism |
|------|----------|-----------|
| JWT Session | Dashboard UI | HTTP-only cookie |
| API Token | Client APIs (`/api/client/v1/*`) | `Authorization: Bearer <token>` |

## JWT Session Authentication

### Login Flow

1. User submits slug + email + password to `POST /api/auth/login`
2. Server finds tenant by slug, switches to tenant database
3. Validates email/password against stored bcrypt hash
4. Generates JWT with user info, license features, and tenant data
5. Sets HTTP-only cookie (`token`)
6. Returns user profile

### Registration Flow

1. User submits company name, slug, name, email, password to `POST /api/auth/register`
2. Server creates tenant with the given slug
3. Creates a new `tenant_{slug}` database
4. Creates user as owner with hashed password
5. Assigns default license (FREE)
6. Generates JWT and sets cookie
7. Sends welcome email

### JWT Payload

```typescript
{
  userId: string;
  email: string;
  role: 'owner' | 'admin' | 'project_admin' | 'user';
  tenantId: string;
  tenantSlug: string;
  tenantDbName: string;
  licenseType: string;
  features: string[];
}
```

The JWT is signed using the `jose` library (Edge Runtime compatible) with `JWT_SECRET`.

### Middleware Processing

The global middleware (`src/middleware.ts`) processes every request:

```
Request → Is public path? → Pass through
        → Is client API? → Skip cookie auth (Bearer handled in route)
        → Extract cookie → Verify JWT → Check license endpoint access
        → Inject headers → Forward to route handler
```

Headers injected for authenticated requests:

| Header | Content |
|--------|---------|
| `x-user-id` | User ObjectId |
| `x-user-email` | User email |
| `x-user-role` | `owner`, `admin`, `project_admin`, `user` |
| `x-tenant-id` | Tenant ObjectId |
| `x-tenant-slug` | Tenant slug |
| `x-tenant-db-name` | `tenant_{slug}` |
| `x-license-type` | License tier |
| `x-features` | JSON array of feature flags |
| `x-request-id` | Request UUID |

### Public Paths

These paths skip authentication:

- `/login`, `/register`
- `/api/auth/*`
- `/api/health/*`

## API Token Authentication

For programmatic access, tenants create API tokens through the dashboard. These tokens authenticate requests to `/api/client/v1/*` endpoints.

Tokens are managed under **API Tokens**. Each row shows the label, creation date, and last-used timestamp; the full secret is shown only once at creation time. The page lists **your own tokens only**, whatever your role: an administrator does not see anybody else's there.

![API Tokens](/screenshots/authentication/01-api-tokens.png)

Owners and admins manage other people's tokens, and the tokens of service accounts, under **IAM center → Principals → API tokens** (or from a person's drawer). They do so "never upward": an admin reaches every token but the owner's, and a project admin only those of service accounts in the projects they belong to. A token authorizes as its owner, so what it may do is capped by its owner's permissions and its own scope.

### Usage

```bash
curl -X POST https://gateway.example.com/api/client/v1/chat/completions \
  -H "Authorization: Bearer cpeer_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}'
```

### requireApiToken Helper

All client API routes use the `requireApiToken` helper:

```typescript
import { requireApiToken, ApiTokenAuthError } from '@/lib/services/apiTokenAuth';

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireApiToken(request);
    // ctx.token, ctx.tokenRecord, ctx.tenant
    // ctx.tenantId, ctx.tenantSlug, ctx.tenantDbName
    // ctx.projectId, ctx.user
  } catch (error) {
    if (error instanceof ApiTokenAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
```

### Token Validation Flow

1. Extract Bearer token from `Authorization` header
2. Check cache (SHA-256 hash key, 60s TTL)
3. On cache miss: query database, resolve tenant
4. Reject an expired token (`401`)
5. Reject a call from outside the token's IP allowlist (`403`, `ip_not_allowed`)
6. Switch to tenant database
7. Resolve the token owner fresh on every request and reject a missing or disabled owner (`401`)
8. Fire-and-forget: update `lastUsed` timestamp
9. Ensure default project exists
10. Return `ApiTokenContext`
11. The route's authorization gate decides what the token's owner, scope and project allow (see [Authorization](/guide/authorization))

### Token Properties

| Field | Description |
|-------|-------------|
| `token` | The raw token string |
| `userId` | Owning user |
| `tenantId` | Owning tenant |
| `projectId` | Scoped project (optional) |
| `servicePermissions` | Least-privilege scope that caps the owner's permissions, group grants included (optional) |
| `expiresAt` | Expiration date (optional) |
| `allowedIpRanges` | CIDR ranges the token may be used from (optional, see below) |
| `lastUsed` | Last usage timestamp |

### Expiry and the tenant token policy

A token may carry an expiry (`expiresAt`). An organization can make that
mandatory and cap how long a token may live under **IAM center →
Settings → API tokens** (the `GET/PUT /api/iam/settings` API):

| Setting | Meaning |
|---------|---------|
| `maxLifetimeDays` | No token may be set to expire later than this many days after it was created. `null` = no maximum. |
| `requireExpiry` | Every new token must have an expiry. A maximum lifetime implies it. |

The policy is checked when a token is created and when its expiry is extended
(the lifetime is counted from the token's creation, so a token cannot be renewed
forever; it has to be replaced). Shortening an expiry is always accepted. Tokens
that already exist keep working; the ones outside the policy are flagged
(`exceedsTenantPolicy`) in the token list so they can be rotated. The checks run
on every route that creates a token: `POST /api/tokens`,
`POST /api/projects/:projectId/tokens` and `POST /api/client/v1/users/:id/tokens`.

```bash
# create a token that expires in 30 days and only works from two networks
curl -X POST https://gateway.example.com/api/tokens \
  -H "Content-Type: application/json" --cookie "token=..." \
  -d '{"label": "ci", "expiresInDays": 30, "allowedIpRanges": ["203.0.113.0/24", "2001:db8::/32"]}'
```

`expiresAt` (ISO 8601, or `null` for "never") and `expiresInDays` (counted on the
server clock) are two ways to say the same thing; send one of them. A refusal is
a `400` with a stable `code`: `token_expiry_required`, `token_expiry_too_long`
(`details.latestExpiresAt` says how far it may go), `token_expiry_invalid`, or
`policy_unavailable` (`503`, the policy could not be read; nothing is created).
`GET /api/tokens/policy` returns the rules for a form; `PUT /api/tokens/:id`
edits a token's `label`, `expiresAt` / `expiresInDays` and `allowedIpRanges`.
A change to the expiry or the allowlist is written to the audit log with the old
and the new value (service `tokens`, event `token.restrictions.updated`), next to
the regular request row, and takes effect on the very next call.

### IP allowlists

`allowedIpRanges` is a list of IPv4 / IPv6 ranges in CIDR notation (a bare
address means a single host; at most 100 entries). A token with a list only
authenticates from an address inside one of the ranges. Any other call is
refused with:

```json
{ "error": "API token is not allowed from this IP address", "code": "ip_not_allowed" }
```

with status `403` (OpenAI- and Anthropic-compatible routes use their own error
envelope with the same status and code). A token without a list, which includes
every token created before the feature, is unrestricted. Refusals are written to
the audit log (service `tokens`, action `security`, outcome `denied`, at most one
row per token and address per minute).

The address that is matched is one the server can vouch for. With
`TRUSTED_PROXIES` set it is the address Fastify resolves through those proxies:
the connection address, or the forwarded one **only** when the connection comes
from a listed proxy, taking the entry the proxy itself appended (anything a
client wrote to the left of it is ignored). With `TRUSTED_PROXIES` unset (the
default) forwarded headers are not used for IP rules at all: the connection
address is matched, so a caller cannot claim an allowed address. The
`X-Forwarded-For`, `X-Real-IP` and `Forwarded` headers are never read directly.
Behind a reverse proxy or load balancer set `TRUSTED_PROXIES` to its address,
otherwise every caller looks like the proxy and an allowlist never matches; the
console says so next to the allowlist. The same address is used for the `ip`
condition of Authorization policies.

A token that mints another token (`POST /api/client/v1/users/:id/tokens`) cannot
widen its own network scope: the new token inherits the minting token's ranges
unless it asks for a subset of them.

### Acting for a user

An application that signs its own users in can send a signed statement about the person a call is for in the `X-Cognipeer-User-Token` header, next to its API token:

```bash
curl https://gateway.example.com/api/client/v1/models \
  -H "Authorization: Bearer cpeer_abc123..." \
  -H "X-Cognipeer-User-Token: eyJhbGciOiJSUzI1NiIs..."
```

The call then runs as that person (their access, limits and name in the logs), capped by the token's scope and project; the person must be able to open that project themselves, or the call is refused with `403` and `code: "project_not_accessible"`. The token must be set up for it by an owner or admin; sending the header to a token that is not set up is refused with `401` and `code: "delegation_not_enabled"`, never answered as the token's owner. See [Acting for a user](/guide/authorization#acting-for-a-user-verified-identity).

### Permission denials

A call that the permission gate refuses (the caller's level on the route's
service is below what the route needs) is answered with `403`. `error` is the
human-readable reason, and structured fields sit next to it, so a client that only
shows `body.error` (the SDKs and the dashboard do) still shows the reason:

```json
{
  "error": "Forbidden: mcp requires write permission",
  "message": "Forbidden: mcp requires write permission",
  "code": "forbidden",
  "service": "mcp",
  "required": "write",
  "decisionId": "7c0f6b2e-5d1a-4c1e-9a53-0d9b8a1f2e44"
}
```

`decisionId` identifies this refusal and is repeated in the `X-Decision-Id`
header: `GET /api/iam/decisions/:decisionId` resolves it to the audit row and a
ready-to-run access check (IAM center, **Access check**). A route that carries no
authorization declaration is refused with `code: "route_not_declared"`, and a
token with a service scope is refused on the tenant-wide `/api/metrics` export;
both put the reason in `error` as well. The OpenAI- and Anthropic-compatible
routes keep their own error envelopes: the reason is `error.message`, OpenAI
routes add `error.code`, and both carry the decision id as `error.decision_id`.

When the engine cannot decide a request at all, the answer is `503` with
`code: "authorization_unavailable"` and a `Retry-After` header, never an allow.
[Authorization](/guide/authorization#when-authorization-is-unavailable) describes
that case, the readiness check and the owner's safety rule.

## License-Based Feature Control

Features are controlled through a license system defined in `src/config/policies.json`:

```typescript
import { LicenseManager } from '@/lib/license/license-manager';

const hasAccess = LicenseManager.hasFeature(licenseType, 'LLM_CHAT');
const canAccessEndpoint = LicenseManager.hasEndpointAccess(licenseType, '/api/models');
```

### License Tiers

| Tier | Features | Request Limit |
|------|----------|---------------|
| FREE | 16 features | 1,000/month |
| STARTER | 10 features | 10,000/month |
| PROFESSIONAL | 14 features | 100,000/month |
| ENTERPRISE | All features | Unlimited |
| ON_PREMISE | All features | Unlimited |

### Feature Endpoint Mapping

Each feature in `policies.json` maps to API endpoint patterns:

```json
{
  "LLM_CHAT": {
    "name": "LLM Chat",
    "endpoints": ["/api/chat/*", "/api/client/v1/chat/*"]
  }
}
```

The middleware checks these mappings automatically.

## User Roles

| Role | Scope |
|------|-------|
| `owner` | Full tenant control |
| `admin` | Manage users and settings |
| `project_admin` | Manage assigned projects |
| `user` | Access assigned projects only |

A role sets the default level of every service; per-user permissions, group
grants, project member permissions and token scopes refine it. How they combine
is in [Authorization](/guide/authorization#the-settings-you-maintain).

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | **Required**. Secret for JWT signing |
| `JWT_EXPIRES_IN` | `7d` | JWT expiration duration |
| `PROVIDER_ENCRYPTION_SECRET` | `JWT_SECRET` | Encryption key for stored credentials |
| `TRUSTED_PROXIES` | — (unset: forwarded headers are not used for authorization) | Comma-separated IPs / CIDRs of the reverse proxies or load balancers allowed to set `X-Forwarded-For`. Set it whenever the console runs behind one: the client address that token IP allowlists, the IP condition of policies, rate limits and audit logs use depends on it. See [Authorization](/guide/authorization#client-address-and-trusted-proxies). |
