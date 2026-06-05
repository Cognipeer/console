# Authentication

The gateway supports two authentication mechanisms: JWT-based session auth for the dashboard and API token auth for client APIs.

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

### Usage

```bash
curl -X POST https://gateway.example.com/api/client/v1/chat/completions \
  -H "Authorization: Bearer cgt_abc123..." \
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
4. Fire-and-forget: update `lastUsed` timestamp
5. Switch to tenant database
6. Ensure default project exists
7. Resolve user from token record
8. Return `ApiTokenContext`

### Token Properties

| Field | Description |
|-------|-------------|
| `token` | The raw token string |
| `userId` | Owning user |
| `tenantId` | Owning tenant |
| `projectId` | Scoped project (optional) |
| `expiresAt` | Expiration date (optional) |
| `lastUsed` | Last usage timestamp |

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

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | — | **Required**. Secret for JWT signing |
| `JWT_EXPIRES_IN` | `7d` | JWT expiration duration |
| `PROVIDER_ENCRYPTION_SECRET` | `JWT_SECRET` | Encryption key for stored credentials |
