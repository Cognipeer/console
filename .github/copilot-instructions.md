# CognipeerAI Gateway - Development Guidelines

## Project Overview

CognipeerAI Gateway is a **multi-tenant SaaS platform** for AI and Agentic services that can operate both as SaaS and on-premise. The platform provides LLM services, agent orchestration, vector stores, workflow automation, and analytics with complete data isolation per company.

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
├── cgate_main (Main/Shared)
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

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   └── auth/           # Authentication endpoints (tenant-aware)
│   ├── dashboard/          # Protected dashboard
│   ├── login/              # Login page (requires slug)
│   ├── register/           # Registration page (creates tenant)
│   └── layout.tsx          # Root layout with Mantine providers
├── lib/
│   ├── database/           # Multi-tenant database abstraction layer
│   ├── license/            # License and JWT management
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

**Last Updated**: September 30, 2025
**Version**: 1.0.0
