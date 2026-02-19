# AGENTS.md

This document defines the general development rules for `cognipeer-console` (gateway) and related client/SDK flows developed with this repository. The goal is to keep module boundaries clear, preserve multi-tenant security, and maintain consistent screen/API behavior.

## 1) Quick Context

- Platform: Next.js 15 (App Router) + TypeScript + Mantine UI
- Architecture: multi-tenant SaaS (isolated database per tenant)
- Authentication: JWT (`jose`)
- Client API surface: `src/app/api/client/v1/*`
- Core principle: tenant isolation and license/feature constraints must be enforced in every layer.

## 2) Module Map (cognipeer-console)

### Application layer
- `src/app/*`: pages, route handlers, layout
- `src/app/api/*`: dashboard/internal APIs
- `src/app/api/client/v1/*`: external customer APIs consumed via API token

### UI layer
- `src/components/*`: domain-focused UI components
  - `layout/`: shared page structure (for example, `PageHeader`, `DashboardDateFilter`)
  - `models/`, `vector/`, `tracing/`, `guardrails/`, `files/`, etc.: domain components

### Business logic
- `src/lib/services/*`: domain services
  - `vector/`, `models/`, `inferenceMonitoring/`, `guardrail/`, `files/`, `projects/`, etc.

### Core infrastructure
- `src/lib/database/*`: database abstraction (do not import MongoDB directly in app code)
- `src/lib/providers/*`: provider contract/registry/runtime
- `src/lib/license/*`: license and feature access logic
- `src/lib/i18n/*`: translations and locale helpers
- `src/config/policies.json`: feature-to-endpoint and license mapping
- `src/theme/theme.ts`: design system primitives and component defaults

## 3) Multi-Tenant and Security Rules (Mandatory)

1. **Use database abstraction only**
   - Always use `getDatabase()`.
   - For tenant-scoped data (users/tokens/projects), call `switchToTenant()` first.

2. **Preserve tenant identity at route level**
   - Use middleware-injected headers (`x-tenant-*`, `x-user-*`) as the source of truth.
   - Never create query patterns that can return cross-tenant data.

3. **Client API authentication standard**
   - In `/api/client/v1/*` endpoints, use `requireApiToken`.
   - Return errors as `NextResponse.json({ error }, { status })`.

4. **Feature/license enforcement**
   - Update feature endpoint patterns in `src/config/policies.json` when adding endpoints.
   - Keep middleware-level and route-level checks consistent.

5. **Log sanitization**
   - Never log secrets, tokens, credentials, or raw provider payloads.
   - Use sanitize helpers whenever available.

## 4) API Design Rules

- Client-facing APIs must live under `src/app/api/client/v1`.
- Keep resource structure RESTful: `/client/v1/<domain>/<resource>/route.ts`.
- For streaming routes, use `export const runtime = 'nodejs';`.
- Validate request payloads early and return `400` for malformed input.
- Keep response schemas predictable and OpenAI-compatible where relevant.
- Produce/propagate `request_id` when possible for observability.

## 5) UI and Screen Development Rules

1. **Mantine-first implementation**
   - Prefer Mantine components and hooks (`@mantine/core`, `@mantine/form`, `@mantine/notifications`, `@mantine/dates`).
   - Reuse existing composition patterns before introducing new wrappers.
   - Dont use Badge with outline, use different variants

2. **Follow theme primitives strictly**
   - Respect `src/theme/theme.ts` defaults (radius, sizes, colors, typography).
   - Do not introduce new hard-coded brand colors, fonts, or shadow systems.
   - Prefer Mantine tokens (`c`, `variant`, `radius`, spacing props) over inline styles.

3. **Use shared dashboard skeleton**
   - Build dashboard pages with `PageHeader` for title/subtitle/actions consistency.
   - Use `DashboardDateFilter` for period/range filtering where date-scoped analytics exist.
   - Keep action groups compact (`size="xs"`/`sm`) and aligned with existing pages.

4. **State and feedback discipline**
   - Always cover `loading`, `refreshing`, `empty`, and `error` states.
   - Use `Loader`/`LoadingOverlay` and disabled states for long-running actions.
   - Surface success/failure with `notifications.show` and clear, user-facing messages.

5. **Forms and validation standards**
   - Use `useForm` for interactive forms with explicit field-level validation.
   - Validate URL/required/format inputs at UI level before API calls.
   - Keep submit actions idempotent-safe (disable while pending, avoid duplicate posts).

6. **i18n-first user text**
   - Prefer `useTranslations` for user-visible strings.
   - Add new keys to message files instead of hard-coding English text in components.
   - Do not mix translated and hard-coded labels in the same UI flow unless intentionally temporary.

7. **Client component boundaries**
   - Add `'use client'` only when hooks, browser APIs, or client interactivity are required.
   - Keep data-fetching and rendering logic aligned with existing page patterns.

8. **Data presentation consistency**
   - Use `Paper`, `Card`, `SimpleGrid`, `Group`, and `Stack` patterns already used across dashboard pages.
   - Use `mantine-datatable` for tabular views where sorting/filtering/pagination is needed.
   - Keep density and spacing consistent with current dashboard language.

## 6) Provider and Runtime Rules

- When adding providers, use contract-driven flow:
  1. Add/extend contract file under `src/lib/providers/contracts/*`.
  2. Register it through `CORE_PROVIDER_CONTRACTS`.
  3. Implement the correct domain runtime interface (`vector`, `model`, etc.).
  4. Update form schema and verify credential/settings rendering in UI.

- During runtime creation:
  - Hydrate stored credentials/settings via helper utilities.
  - Do not skip provider type/status validation (`ensure*` helpers).

## 7) File and Code Organization

- Do not overload route handlers with domain logic; keep business logic in services.
- Place shared helpers in `src/lib/utils` or domain utility modules.
- Split large UI components by domain responsibility.
- Avoid breaking public APIs unless explicitly required.
- Prefer targeted, minimal changes over broad refactors.

## 8) Validation Routine (After Changes)

Validate in this order when feasible:
1. Focused smoke check of the changed page/route
2. `npm run lint`
3. `npm run build`

If demo data is needed:
- `npm run seed:demo`
- `npm run seed:demo:status`

Note: fixing unrelated legacy issues is not required, but they should be reported.

## 9) PR Checklist

- [ ] Tenant isolation remains intact (`switchToTenant` in the correct place)
- [ ] New client endpoints are under `client/v1`
- [ ] `policies.json` feature-endpoint mapping is up to date
- [ ] UI follows theme/component language
- [ ] Loading/error/empty states are handled
- [ ] No sensitive data in logs
- [ ] Lint/build (and relevant tests) pass

## 10) console-sdk Alignment Notes

If gateway and SDK evolve together:
- When gateway client endpoint/schema changes, update `console-sdk/src/resources/*` and `console-sdk/src/types.ts`.
- Validate SDK changes with at least `npm run build` and relevant examples under `console-sdk/examples/*`.
- Preserve backward compatibility whenever possible.

---

## Short Agent Summary

- Prioritize tenant safety and license checks first.
- Then implement API and service changes within correct domain boundaries.
- Keep UI strictly aligned with existing Mantine design language.
- Deliver changes small, traceable, and validated.
