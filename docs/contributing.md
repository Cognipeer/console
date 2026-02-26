# Contributing

Thank you for your interest in contributing to the Cognipeer Gateway.

## Development Setup

### Prerequisites

- Node.js 20+
- MongoDB 6+
- npm

### Getting Started

```bash
git clone https://github.com/Cognipeer/cgate.git
cd cgate
npm install
cp .env.example .env.local
npm run dev
```

## Development Guidelines

### Mandatory Rules

1. **Never read `process.env` directly** — Use `getConfig()` from `@/lib/core/config`
2. **Never use `console.*` in server code** — Use `createLogger()` from `@/lib/core/logger`
3. **Never import MongoDB directly** — Use `getDatabase()` from `@/lib/database`
4. **Preserve tenant isolation** — Always call `switchToTenant()` before tenant-scoped queries
5. **Client APIs under `/api/client/v1/`** — Use `requireApiToken()` for authentication
6. **Update `policies.json`** — When adding endpoints that require feature access

### Code Style

- TypeScript with strict types
- Async/await over raw promises
- Functional components with hooks (UI)
- Scoped loggers per file/module
- Meaningful variable names
- Comments for complex business logic

### UI Guidelines

- Mantine components first
- Follow theme primitives in `src/theme/theme.ts`
- Cover loading, error, and empty states
- Use `useTranslations` for user-visible strings
- Add `'use client'` only when hooks or interactivity are required

## Documentation

When making changes that affect:
- Core modules (`src/lib/core/`)
- API endpoints (`src/app/api/client/v1/`)
- Configuration (environment variables)
- Database schema
- Provider contracts

Update the corresponding documentation page under `docs/`.

### Building Docs Locally

```bash
npm run docs:dev      # Dev server with hot reload
npm run docs:build    # Production build
npm run docs:preview  # Preview production build
```

## PR Checklist

- [ ] Tenant isolation intact (`switchToTenant` where needed)
- [ ] New client endpoints under `client/v1`
- [ ] `policies.json` mapping updated
- [ ] UI follows theme/component language
- [ ] Loading/error/empty states handled
- [ ] No `process.env` in application code
- [ ] No `console.*` in server code
- [ ] No sensitive data in logs
- [ ] Documentation updated (if applicable)
- [ ] Lint passes (`npm run lint`)
- [ ] Build passes (`npm run build`)

## Validation

```bash
npm run lint          # ESLint
npm run build         # Next.js build
npm run test          # Vitest tests
npm run docs:build    # Documentation build
```
