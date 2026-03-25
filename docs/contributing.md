# Contributing

Thank you for your interest in contributing to Cognipeer Console.

Cognipeer Console docs live under `docs/` and are rendered with VitePress using the shared Cognipeer docs shell.

## Development Setup

### Prerequisites

- Node.js 20+
- MongoDB 6+ *(optional — only required when `DB_PROVIDER=mongodb`)*
- npm

### Getting Started

```bash
git clone https://github.com/Cognipeer/cognipeer-console.git
cd cognipeer-console
npm install
cp .env.example .env.local
npm run dev
```

SQLite is the default database backend, so a local MongoDB instance is not required for normal docs or UI development.

## Development Guidelines

### Mandatory Rules

1. **Never read `process.env` directly**. Use `getConfig()` from `@/lib/core/config`.
2. **Never use `console.*` in server code**. Use `createLogger()` from `@/lib/core/logger`.
3. **Never import MongoDB directly**. Use `getDatabase()` from `@/lib/database`.
4. **Preserve tenant isolation**. Always call `switchToTenant()` before tenant-scoped queries.
5. **Client APIs under `/api/client/v1/`**. Use the native Fastify auth helpers and keep policies aligned.
6. **Update `policies.json`** when adding endpoints that require feature access.

### Code Style

- TypeScript with strict types
- Async and await over raw promise chains
- Functional components with hooks for UI
- Scoped loggers per file or module
- Meaningful variable names
- Comments only where the code would otherwise hide important intent

### UI Guidelines

- Mantine components first
- Follow theme primitives in `src/theme/theme.ts`
- Cover loading, error, and empty states
- Use `useTranslations` for user-visible strings
- Add `'use client'` only when hooks or interactivity are required

## Documentation

When making changes that affect:

- core modules under `src/lib/core/`
- API endpoints under `src/server/api/plugins/`
- configuration and environment variables
- database schema or tenant behavior
- provider contracts or runtime behavior

Update the corresponding documentation page under `docs/`.

### Docs Structure

- Docs source: `docs/`
- Theme config: `docs/.vitepress/config.mts`
- Theme styling: `docs/.vitepress/theme/`
- Public docs assets: `docs/public/`

### Building Docs Locally

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

## PR Checklist

- [ ] Tenant isolation intact (`switchToTenant` where needed)
- [ ] New client endpoints under `/client/v1`
- [ ] `policies.json` mapping updated
- [ ] UI follows existing theme and component language
- [ ] Loading, error, and empty states handled
- [ ] No `process.env` in application code
- [ ] No `console.*` in server code
- [ ] No sensitive data in logs
- [ ] Documentation updated where behavior changed
- [ ] Lint passes (`npm run lint`)
- [ ] Build passes (`npm run build`)

## Validation

```bash
npm run lint
npm run build
npm run test
npm run docs:build
```

If you are changing licensing, community policies, or release-process documents, update the root repo files and the mirrored pages under `docs/guide/` in the same pull request.
