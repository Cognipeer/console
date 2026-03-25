# Multi-Tenancy

Cognipeer Console is a fully multi-tenant platform with complete data isolation per company. Each tenant gets a dedicated database — either a separate SQLite file (default) or a separate MongoDB database.

## Database Backends

### SQLite (default)

Each tenant gets its own `.sqlite` file. No external services required:

```
data/
├── console_main.sqlite       ← Shared database
│   ├── tenants               ← Tenant registry
│   └── tenant_user_directory ← Cross-tenant email lookup
├── tenant_acme.sqlite        ← Tenant "acme"
│   ├── users
│   ├── api_tokens
│   ├── models
│   ├── providers
│   ├── vector_indexes
│   ├── guardrails
│   ├── prompts
│   ├── memory_stores
│   ├── rag_modules
│   └── ...
└── tenant_globex.sqlite      ← Tenant "globex"
```

Enable with: `DB_PROVIDER=sqlite` (default — no env var needed).

### MongoDB

```
MongoDB Server
├── console_main              ← Shared/Main database
│   ├── tenants               ← Tenant registry
│   └── tenant_user_directory ← Cross-tenant email lookup
├── tenant_acme               ← Tenant "acme" database
│   ├── users
│   ├── api_tokens
│   ├── models
│   ├── providers
│   ├── vector_indexes
│   ├── guardrails
│   ├── prompts
│   ├── memory_stores
│   ├── rag_modules
│   └── ...
├── tenant_globex             ← Tenant "globex" database
│   └── ...
└── ...
```

Enable with: `DB_PROVIDER=mongodb` and set `MONGODB_URI`.

> **Note:** The database abstraction layer ensures all application code works identically with both backends. Switch by changing a single environment variable.

## Tenant Model

Each tenant has:

| Field | Description |
|-------|-------------|
| `companyName` | Display name |
| `slug` | URL-friendly identifier (unique) |
| `dbName` | Database name (`tenant_{slug}`) |
| `licenseType` | Active license tier |
| `ownerId` | Owner user ID |

## Database Abstraction

All database access goes through the abstraction layer — never import MongoDB directly:

```typescript
import { getDatabase, getTenantDatabase } from '@/lib/database';

// Main database (tenant registry)
const db = await getDatabase();
const tenant = await db.findTenantBySlug('acme');

// Tenant database (user data, configs, etc.)
const tenantDb = await getTenantDatabase('tenant_acme');
const users = await tenantDb.listUsers();
```

### switchToTenant Pattern

```typescript
const db = await getDatabase();
await db.switchToTenant(`tenant_${slug}`);
// All subsequent queries are scoped to this tenant
const user = await db.findUserByEmail(email);
```

## Tenant Context in Routes

Middleware injects tenant identity into request headers:

| Header | Description |
|--------|-------------|
| `x-tenant-id` | Tenant ObjectId |
| `x-tenant-slug` | Tenant slug |
| `x-tenant-db-name` | Full database name (`tenant_acme`) |

### Dashboard Routes

```typescript
export const GET = withRequestContext(async (request) => {
  const tenantDbName = request.headers.get('x-tenant-db-name')!;
  const tenantId = request.headers.get('x-tenant-id')!;
  
  // All queries scoped to this tenant
  const db = await getTenantDatabase(tenantDbName);
  const models = await db.listModels();
  
  return NextResponse.json({ data: models });
});
```

### Client API Routes

```typescript
export async function POST(request: NextRequest) {
  const ctx = await requireApiToken(request);
  // ctx.tenantDbName, ctx.tenantId, ctx.tenantSlug — all available
  // Database already switched to tenant
}
```

## Tenant Creation

When a user registers, the system:

1. Creates a tenant record in `console_main.tenants`
2. Creates a new database `tenant_{slug}`
3. Creates the user as owner in the tenant database
4. Initializes default collections and indexes
5. Generates a JWT with tenant info embedded

## Security Rules

- **Never create query patterns that can return cross-tenant data**
- Always call `switchToTenant()` before user/token operations
- Use middleware-injected headers as the source of truth for tenant identity
- Never trust client-supplied tenant identifiers without verification
