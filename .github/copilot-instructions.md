# Cognipeer Console - Development Guidelines

## Project Overview

Cognipeer Console is a **multi-tenant SaaS platform** for AI and Agentic services that can operate both as SaaS and on-premise. The platform provides LLM services, agent orchestration, vector stores, workflow automation, and analytics with complete data isolation per company.

## Architecture

### Technology Stack

- **Frontend**: Next.js 15 with App Router, TypeScript, Mantine v7 UI
- **Backend**: Next.js API Routes
- **Database**: MongoDB (multi-tenant) with abstraction layer for future provider changes
- **Authentication**: JWT (using jose library for Edge Runtime compatibility)
- **Email**: Nodemailer with Handlebars templates
- **Styling**: Mantine theme system + Tailwind CSS

### Multi-Tenant Architecture

**CRITICAL**: The system is now fully multi-tenant. Each company has:
- A unique slug (URL-friendly identifier)
- A separate MongoDB database for complete data isolation
- License-based feature access

**Database Structure**:
```
MongoDB Server
├── console_main (Main/Shared)
│   └── tenants collection
├── tenant_{slug} (Per Company)
│   ├── users
│   └── api_tokens
└── ...
```

See [MULTI_TENANT_GUIDE.md](../MULTI_TENANT_GUIDE.md) for detailed architecture.

### Key Design Patterns

#### 1. Multi-Tenant Database Abstraction Layer

The database layer supports multi-tenancy with complete isolation:

```typescript
// Location: src/lib/database/
// - provider.interface.ts: Defines ITenant, IUser, IApiToken interfaces
// - mongodb.provider.ts: Multi-tenant MongoDB implementation
// - index.ts: Database factory with tenant switching

// Usage for tenant operations (uses main DB):
import { getDatabase } from '@/lib/database';
const db = await getDatabase();
const tenant = await db.findTenantBySlug(slug);

// Usage for user/token operations (uses tenant DB):
const db = await getDatabase();
await db.switchToTenant(`tenant_${slug}`);
const user = await db.findUserByEmail(email);
```

**Important**: 
- Main database: Tenant metadata only
- Tenant database: User and API token data
- Always call `switchToTenant()` before user/token operations
- Never import MongoDB directly in application code

#### 2. License-Based Feature Control

Features are controlled through a license system with JWT integration:

```typescript
// Location: src/config/policies.json
// Defines all features and license tiers

// Location: src/lib/license/
// - license-manager.ts: Feature and license utilities
// - token-manager.ts: JWT token management (includes tenant info)

// Usage:
import { LicenseManager } from '@/lib/license/license-manager';
const hasAccess = LicenseManager.hasFeature(licenseType, 'LLM_CHAT');
```

**Flow**:
1. User logs in → JWT generated with license features AND tenant info
2. JWT stored in HTTP-only cookie
3. Middleware checks feature access on each request
4. API routes can access user AND tenant info via headers

#### 3. Middleware-Based Access Control

```typescript
// Location: src/middleware.ts
// - Validates JWT tokens (using jose for Edge Runtime)
// - Checks feature access for API routes
// - Injects user AND tenant info into headers

// Headers available in API routes:
// - x-user-id
// - x-user-email
// - x-user-role
// - x-tenant-id
// - x-tenant-slug
// - x-license-type
// - x-features
```

**Important**: All protected routes automatically go through this middleware. Public paths are defined in the middleware file. Middleware uses `jose` library which is compatible with Edge Runtime.

#### 4. Email System

```typescript
// Location: src/lib/email/mailer.ts
// Handlebars-based template engine

// Templates: mail-templates/*.html
// Template format:
// <!-- subject: Email Subject -->
// <html>...</html>

// Usage:
import { sendEmail } from '@/lib/email/mailer';
await sendEmail(email, 'welcome', { name, companyName, slug, licenseType });
```

## Provider Architecture

### Contract Model

- Contracts live in `src/lib/providers/contracts` and must conform to the `ProviderContract` shape defined in `src/lib/providers/types.ts`.
- Each contract declares its `id`, semantic `version`, supported `domains` (for example, `vector`, `model`), a `display` configuration, optional `capabilities`, a `form` schema, and a `createRuntime` factory that returns a domain-specific runtime.
- Contracts are aggregated in `CORE_PROVIDER_CONTRACTS` (`src/lib/providers/contracts/index.ts`) and auto-registered by the `ProviderRegistry` on first use.

### Provider Registry & Domains

- `ProviderRegistry` (`src/lib/providers/registry.ts`) manages contract registration, descriptor listings, and runtime creation.
- Domain-specific runtime contracts live under `src/lib/providers/domains/*`:
  - `vector.ts` defines the `VectorProviderRuntime` interface (index CRUD, vector upsert/query/delete).
  - `model.ts` defines chat/embedding runtime capabilities and capability flags.
- Use `providerRegistry.listDescriptors(domain)` to expose drivers to the UI, and `providerRegistry.createRuntime(contractId, context)` to obtain a runtime for execution.

### Form Schemas & UI Rendering

- The modal UI renders credential/settings forms from the contract schema via `ProviderFormRenderer` (see `src/components/providers`).
- Form field definitions (`ProviderFormSection` + `ProviderFormField`) support types like `text`, `password`, `select`, `switch`, etc., and can scope fields to `credentials`, `settings`, or `metadata`.
- Keep labels, placeholders, and descriptions meaningful; the renderer auto-expands fields to the modal width.

### Provider Configuration Lifecycle

1. Provider descriptors are surfaced to tenants via helpers such as `listVectorDrivers` (vector drivers use `providerRegistry.listDescriptors('vector')`).
2. Creating a configuration persists provider metadata/credentials with `createProviderConfig` (vector-specific wrappers reside in `src/lib/services/vector/vectorService.ts`).
3. When executing runtime operations, call `loadProviderRuntimeData` to hydrate stored credentials/settings and then `providerRegistry.createRuntime` with a context that includes tenant identifiers, provider key, credentials, settings, metadata, and a scoped logger.
4. Always guard runtime usage with helpers like `ensureVectorProvider` to validate provider type/status before making remote calls.

### Adding or Updating Providers

1. Create a new contract file under `src/lib/providers/contracts` or extend the domain-specific aggregations (for example, `MODEL_PROVIDER_CONTRACTS`).
2. Export the contract through `CORE_PROVIDER_CONTRACTS` so it auto-registers.
3. Declare the appropriate domain(s) and implement the runtime factory. Reuse shared utility loggers for consistent diagnostics.
4. Update the provider form schema to collect any additional credentials/settings. Validate with the UI to ensure the new fields render correctly.
5. If the provider unlocks new capabilities, extend `capabilities` so the UI and services can conditionally enable features.

## Vector & Model Runtime Services

### Vector Workflow (`src/lib/services/vector/vectorService.ts`)

- Provides tenant-scoped helpers to list available drivers, create provider configs, and manage vector indexes.
- Uses slug helpers to derive unique index keys (`generateUniqueIndexKey`) and validates vector dimensionality before upserts.
- `buildRuntimeContext` resolves provider credentials, ensures the provider is active, and instantiates the `VectorProviderRuntime`.
- CRUD helpers (`createVectorIndex`, `listVectorIndexes`, `updateVectorIndex`, `deleteVectorIndex`, `upsertVectors`, `queryVectors`, etc.) wrap runtime calls with database bookkeeping and metadata merging.
- All functions require the tenant DB name and tenant ID. Derive these from `requireApiToken` in API routes or tenant context in server actions.

### Model Inference (`src/lib/services/models/inferenceService.ts`)

- `handleChatCompletion` and `handleEmbeddingRequest` provide OpenAI-compatible responses for chat and embedding workloads.
- Both helpers resolve model metadata with `getModelByKey`, validate model category (LLM vs embedding), and build a provider runtime via `buildModelRuntime`.
- Chat completions support streaming. Responses are converted to OpenAI wire formats via adapters (`toOpenAIChatResponse`, `toOpenAIStreamChunk`).
- Usage data is sanitized (`sanitizeForLogging`) and persisted through `logModelUsage`, capturing request payloads, latency, token usage, and tool call metadata.
- When extending inference features (new overrides, modalities, or tool behaviors), update `buildOverrides` and ensure usage logging continues to serialize safely.

## Client-Facing API (`src/app/api/client/v1`)

### Placement & Authentication Policy

- **All** endpoints consumable via customer API tokens must live under `src/app/api/client/v1`. This keeps the external surface versioned and discoverable.
- Use the shared `requireApiToken` helper (`src/lib/services/apiTokenAuth.ts`) at the top of each handler. It validates the `Authorization: Bearer <token>` header, resolves tenant context, switches to the tenant database, and surfaces the token record.
- Return structured errors with `NextResponse.json({ error: message }, { status })`. Wrap low-level failures with descriptive logs while avoiding credential leakage.

### Existing Endpoints

| Route | Method | Description |
| --- | --- | --- |
| `/api/client/v1/chat/completions` | `POST` | OpenAI-compatible chat completions with optional streaming (`handleChatCompletion`). |
| `/api/client/v1/embeddings` | `POST` | OpenAI-compatible embeddings (`handleEmbeddingRequest`). |
| `/api/client/v1/vector/providers` | `GET` | List tenant vector providers with optional status/driver filters. |
| `/api/client/v1/vector/providers` | `POST` | Create a vector provider configuration for the tenant. |
| `/api/client/v1/vector/providers/:providerKey/indexes` | `GET` | List indexes for a provider (metadata normalized via `serializeIndex`). |
| `/api/client/v1/vector/providers/:providerKey/indexes` | `POST` | Create or reuse a vector index; deduplicates by normalized name. |
| `/api/client/v1/vector/providers/:providerKey/indexes/:externalId` | `GET` | Fetch index metadata alongside provider capabilities. |
| `/api/client/v1/vector/providers/:providerKey/indexes/:externalId` | `PATCH` | Update index name/metadata. |
| `/api/client/v1/vector/providers/:providerKey/indexes/:externalId` | `DELETE` | Delete an index and detach remote resources. |
| `/api/client/v1/tracing/sessions` | `POST` | Ingest agent tracing session data (batch mode). Supports optional `threadId` for cross-agent correlation. |
| `/api/client/v1/tracing/sessions/stream/:sessionId/start` | `POST` | Start a streaming tracing session. Supports optional `threadId`. |
| `/api/client/v1/tracing/sessions/stream/:sessionId/event` | `POST` | Send a streaming tracing event. |
| `/api/client/v1/tracing/sessions/stream/:sessionId/end` | `POST` | End a streaming tracing session. |

- When adding new routes, keep the folder structure RESTful (`/client/v1/<domain>/<resource>/route.ts`). Expose only tenant-scoped data and sanitize logs via `sanitize` helpers as shown in existing handlers.
- Default `export const runtime = 'nodejs';` for streaming support and consistency.
- Use `ApiTokenAuthError` for standardized error responses from `requireApiToken`.

### Request & Response Guidelines

- Validate all required fields with clear 400 responses before invoking services.
- Sanitize provider responses (e.g., trim large payloads) before logging with `logModelUsage` to protect sensitive data.
- Include `request_id` in responses to help users correlate requests with usage logs. Reuse client-provided IDs when available.
- Wrap runtime operations in `try/catch` and log errors with scoped messages (`console.error('[scope]', error)`), mirroring patterns in chat/embedding routes.

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── auth/           # Authentication endpoints (tenant-aware)
│   │   ├── client/v1/      # Client-facing API (API-token auth)
│   │   │   ├── tracing/    # Tracing ingest (batch & streaming)
│   │   │   └── ...         # chat, embeddings, vector, files
│   │   └── tracing/        # Dashboard tracing APIs (threads, sessions)
│   ├── dashboard/          # Protected dashboard
│   │   └── tracing/        # Tracing UI (sessions, threads)
│   ├── login/              # Login page (requires slug)
│   ├── register/           # Registration page (creates tenant)
│   └── layout.tsx          # Root layout with Mantine providers
├── lib/
│   ├── database/           # Multi-tenant database abstraction layer
│   ├── license/            # License and JWT management
│   ├── services/           # Business logic (agentTracing, vector, models…)
│   └── email/              # Email service
├── config/
│   └── policies.json       # Feature policies and licenses
├── theme/
│   └── theme.ts            # Mantine theme configuration
└── middleware.ts           # Global middleware
```

## Development Guidelines

### Adding New Features

1. **Define in policies.json**:
```json
{
  "features": {
    "NEW_FEATURE": {
      "name": "Feature Name",
      "description": "Feature description",
      "endpoints": ["/api/new-feature", "/api/new-feature/*"]
    }
  }
}
```

2. **Add to license tiers** in policies.json

3. **Create API route** under `src/app/api/`

4. **Use database abstraction**:
```typescript
const db = await getDatabase();
// Use db.* methods
```
5. **Expose customer APIs under `/api/client/v1`** – if an endpoint is reachable with API tokens, place it in this namespace and use `requireApiToken` for authentication.

### Adding New Database Methods

1. Add method signature to `provider.interface.ts`
2. Implement in `mongodb.provider.ts`
3. Can create additional providers (PostgreSQL, etc.) by implementing the interface

### Creating New Email Templates

1. Create HTML file in `mail-templates/`
2. Add subject in first line: `<!-- subject: Your Subject -->`
3. Use Handlebars syntax: `{{variable}}`
4. Send using: `sendEmail(to, 'template-name', data)`

### UI Development

**Use Mantine components** for consistency:
- Forms: `useForm` hook from `@mantine/form`
- Notifications: `notifications.show()` from `@mantine/notifications`
- Tables: `DataTable` from `mantine-datatable`
- Theme: Customize in `src/theme/theme.ts`

**Component patterns**:
```typescript
'use client'; // Required for interactive components

import { Button, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
```

### Authentication Flow

1. **Registration**:
   - POST `/api/auth/register`
   - Creates tenant with company name and slug
   - Creates tenant-specific database
   - Creates user as owner with hashed password
   - Assigns default license (FREE)
   - Generates JWT with features and tenant info
   - Sets HTTP-only cookie
   - Sends welcome email

2. **Login**:
   - POST `/api/auth/login`
   - Requires slug, email, password
   - Finds tenant by slug
   - Switches to tenant database
   - Validates credentials
   - Generates JWT with user's license features and tenant info
   - Sets HTTP-only cookie

3. **Protected Routes**:
   - Middleware validates JWT
   - Checks feature access
   - Injects user AND tenant info in headers
   - Returns 401/403 as needed

### API Route Pattern

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/database';

export async function GET(request: NextRequest) {
  // Get user info from headers (injected by middleware)
  const userId = request.headers.get('x-user-id');
  const tenantId = request.headers.get('x-tenant-id');
  const tenantSlug = request.headers.get('x-tenant-slug');
  const features = JSON.parse(request.headers.get('x-features') || '[]');
  
  // Check specific feature if needed
  if (!features.includes('REQUIRED_FEATURE')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  
  const db = await getDatabase();
  await db.switchToTenant(`tenant_${tenantSlug}`);
  
  // All queries now scoped to this tenant
  const users = await db.listUsers();
  
  return NextResponse.json({ data: users });
}
```

## Environment Variables

Required variables (see `.env.example`):
- `MONGODB_URI`: MongoDB connection string
- `JWT_SECRET`: Secret for JWT signing (change in production!)
- `SMTP_*`: Email configuration

## Common Tasks

### Adding a New License Tier

1. Add to `policies.json` under `licenses`
2. Define features for that tier
3. Update registration/admin UI to allow selection

### Switching Database Providers

1. Create new provider class (e.g., `postgres.provider.ts`)
2. Implement `DatabaseProvider` interface
3. Update `src/lib/database/index.ts` to use new provider
4. No changes needed in application code!

### Adding API Endpoints

1. Create file in `src/app/api/[feature]/route.ts`
2. Add endpoint pattern to relevant feature in `policies.json`
3. Middleware will automatically enforce access control
4. If the endpoint must be reachable via API tokens, place it under `src/app/api/client/v1` and follow the client API guidelines above.

### Customizing UI Theme

Edit `src/theme/theme.ts`:
- Colors: Add to `colors` object
- Typography: Modify `fontFamily` and `headings`
- Component defaults: Update `components` object

## Testing

### Manual Testing Flow

1. Start MongoDB: `mongod`
2. Run dev server: `npm run dev`
3. Register a user at `/register`
4. Login at `/login`
5. Access dashboard at `/dashboard`

### Test Different License Tiers

Create users with different `licenseType` values and verify feature access.

## Production Considerations

1. **Change JWT_SECRET** to a strong random value
2. **Configure MongoDB** with proper authentication
3. **Set up SMTP** credentials for email
4. **Use HTTPS** in production (update `secure` cookie flag)
5. **Consider rate limiting** for API routes
6. **Add logging and monitoring**
7. **Implement password reset functionality**

## Future Enhancements

- [ ] License server integration (currently local policies.json)
- [ ] API key management system
- [ ] Usage tracking and analytics
- [ ] Multi-database support testing
- [ ] Admin dashboard for user management
- [ ] OAuth integration
- [ ] Webhook system for events

## Code Style

- Use TypeScript for type safety
- Prefer async/await over promises
- Use functional components with hooks
- Keep components focused and small
- Extract reusable logic to utilities
- Comment complex business logic
- Use meaningful variable names

## Common Pitfalls

1. **Don't bypass database abstraction** - Always use `getDatabase()`
2. **Don't store sensitive data in JWT** - Only IDs and feature flags
3. **Don't forget to add features to policies.json** - Required for middleware
4. **Don't use 'use client' unnecessarily** - Only for interactive components
5. **Remember HTTP-only cookies** - Never expose JWT to client JS

## Getting Help

- Check `policies.json` for available features and licenses
- Review `provider.interface.ts` for database operations
- Look at existing API routes for patterns
- Mantine docs: https://mantine.dev/
- Next.js docs: https://nextjs.org/docs

---

**Last Updated**: October 9, 2025
**Version**: 1.0.0
