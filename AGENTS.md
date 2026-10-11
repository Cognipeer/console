# AGENTS.md

This document defines the general development rules for `cognipeer-console` (gateway) and related client/SDK flows developed with this repository. The goal is to keep module boundaries clear, preserve multi-tenant security, and maintain consistent screen/API behavior.

## 1) Quick Context

- Platform: Next.js 15 (App Router UI) + Node.js/Fastify API + TypeScript + Mantine UI
- Architecture: multi-tenant SaaS (isolated database per tenant)
- Authentication: JWT (`jose`)
- Runtime entrypoint: `src/server/index.ts`
- Client API surface: `src/server/api/plugins/client-*.ts`
- Core principle: tenant isolation and license/feature constraints must be enforced in every layer.

## 2) Module Map (cognipeer-console)

### Application layer
- `src/app/*`: Next.js pages, layouts, middleware-backed UI shell
- `src/middleware.ts`: UI-only auth/header propagation for Next-rendered screens
- `src/server/*`: Node runtime, Fastify bootstrap, Next delegation
- `src/server/api/plugins/*`: native Fastify endpoint registrations for dashboard/internal + client APIs
- `src/server/api/fastify-utils.ts`: shared Fastify auth, request-context, parsing, cookie helpers
- `src/server/api/plugin.ts`: API auth, CORS, security headers, request-context hooks
- `src/server/api/routes/*`: legacy handler modules kept only until tests are migrated; runtime must not depend on them

### UI layer
- `src/components/*`: domain-focused UI components
  - `layout/`: shared page structure (for example, `PageHeader`, `DashboardDateFilter`)
  - `models/`, `vector/`, `tracing/`, `guardrails/`, `files/`, etc.: domain components

### Business logic
- `src/lib/services/*`: domain services
  - `vector/`, `models/`, `inferenceMonitoring/`, `guardrail/`, `files/`, `projects/`, etc.

### Core infrastructure (`src/lib/core/`)
- `config.ts`: central configuration via `ConfigSource` abstraction — ENV today, swappable to DB/UI later
- `logger.ts`: Winston structured logger with per-request context injection (requestId, tenantId)
- `requestContext.ts`: `AsyncLocalStorage` per-request context propagation
- `cache/`: provider-based cache (`none` | `memory` | `redis`) — no silent fallback
- `resilience.ts`: retry with exponential back-off + per-key circuit breaker
- `lifecycle.ts`: graceful shutdown (SIGTERM/SIGINT) with ordered handler teardown
- `cors.ts`: configurable CORS for `/api/client/*` endpoints
- `health.ts`: health-check registry feeding `/api/health/live` and `/api/health/ready`
- `runtimePool.ts`: LRU cache for LangChain SDK client instances (TTL + credential-hash invalidation)

### Other shared infrastructure
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
   - In Fastify routes, use request headers injected by `src/server/api/plugin.ts` (`x-tenant-*`, `x-user-*`) as the source of truth.
   - In Next UI layouts/pages, use middleware-injected headers from `src/middleware.ts`.
   - Never create query patterns that can return cross-tenant data.

3. **Client API authentication standard**
   - In native Fastify client endpoints, use `withClientApiRequestContext` / `getApiTokenContextForRequest`.
   - Do not import `next/server` in runtime API code.
   - Return Fastify responses directly with `reply.code(...).send(...)`.

4. **Feature/license enforcement**
   - Update feature endpoint patterns in `src/config/policies.json` when adding endpoints.
   - Keep Fastify hook-level and route-level checks consistent.

5. **Log sanitization**
   - Never log secrets, tokens, credentials, or raw provider payloads.
   - Use sanitize helpers whenever available.

## 3.1) Core Infrastructure Rules (Mandatory)

1. **Configuration — always use `getConfig()`**
   - Never read `process.env` directly in application code.
   - Import `getConfig` from `@/lib/core` and read typed values.
   - Exception: `src/instrumentation.ts` bootstrap guard (`NEXT_RUNTIME`) runs before config is ready.

2. **Logging — always use `createLogger(scope)`**
   - Never use `console.log`, `console.error`, `console.warn` in server-side code (`src/lib/`, `src/server/`).
   - Create a scoped logger at file/module level: `const logger = createLogger('module-name');`
   - Use `logger.info()`, `logger.warn()`, `logger.error()`, `logger.debug()`.
   - Request context (requestId, tenantId) is auto-injected when `runWithRequestContext` is active.
   - **Client components** (`'use client'` in `src/components/`, `src/app/dashboard/`) run in the browser — `console.error` is acceptable there since Winston is Node.js-only.

3. **Cache — provider-based, no fallback**
   - Access via `getCache()` from `@/lib/core`.
   - Provider is selected by `CACHE_PROVIDER` env var (`none` | `memory` | `redis`).
   - No silent fallback: if `redis` is configured and unavailable, operations fail explicitly.

4. **Resilience — wrap external calls**
   - Use `withResilience(key, fn)` for provider/external API calls.
   - Config via `GATEWAY_RETRY_*` and `GATEWAY_CIRCUIT_BREAKER_*` env vars.
   - Non-retryable status codes (400, 401, 403, 404) fail immediately.

5. **Runtime pool — cache SDK clients**
   - Use `runtimePool.getOrCreate()` for LangChain provider SDK instances.
   - Invalidate via `runtimePool.invalidate()` when credentials change.

6. **Health checks — register contributors**
   - Use `registerHealthCheck(name, fn)` from `@/lib/core` for new subsystems.
   - Routes: `/api/health/live` (always 200), `/api/health/ready` (503 if any component is `down`).

7. **Lifecycle — register shutdown handlers**
   - Use `registerShutdownHandler(name, fn)` for cleanup on SIGTERM/SIGINT.
   - Check `isShuttingDown()` to decline new work during shutdown.

## 3.2) Authorization (IAM) Rules (Mandatory)

Every request is decided by the Cedar policy engine (`src/lib/iam/*`). There is no legacy mode and no per-workspace switch. The simple settings — tenant role, per-user service permissions, group grants, project member levels, token scope — are inputs of the built-in (managed) policies (`managedPolicies.ts`); custom policies add exceptions. Read `docs/guide/authorization.md` before changing anything here.

1. **Declare every route**
   - Every Fastify route (community and EE overlay) carries `config: authz.*` from `src/lib/iam/routeAuthz.ts`:
     - `authz.service(service, level?)`: gated by a permission service. The gate asks `read` for GET/HEAD/OPTIONS and `write` for every other verb; pass `level` only when the route needs something else (a POST that only reads, an admin-only route).
     - `authz.authenticated()`: any signed-in principal, no service check. Use only when the handler makes its own engine checks.
     - `authz.self(reason)`: the route authorizes itself (capability URLs, portal runtime, auth flows). Always give the reason.
     - `authz.public()`: no authentication.
   - Undeclared routes are refused with 403 `route_not_declared`. CI guards: `src/__tests__/unit/iam-route-declarations.test.ts` (community) and the `ee-route-declarations` test (EE overlay).
   - Prefer an explicit declaration over the path map (`ROUTE_PREFIXES` in `rbac.ts`).

2. **Adding a service / module**
   - Add it to `RBAC_SERVICE_DEFINITIONS` (`src/lib/security/rbac.ts`): id, label, description, category, and `adminService: true` when mutations must require admin. Check the role defaults (`getRoleDefaultPermission`: owner/admin → admin, user/project_admin → write, adminService → none for non-admins).
   - The action catalog (`src/lib/iam/actions.ts`) derives `<service>.read|write|admin` automatically. `<service>.admin` is asked only by explicit handler checks: if the module has an admin-only operation, check it in the handler (rule 4), otherwise policies written against `.admin` match nothing.
   - Actions asked by handlers or the EE overlay (not visible in the route table) must be registered with `registerGateAction` (`src/lib/iam/gateActions.ts`), or policy compile warns that nothing asks them.
   - Add labels for the service and its actions to `en.ts` and `tr.ts`.

3. **Adding a resource type** (anything people will want to name in a policy or a limit)
   - Register it in the resource registry (`src/lib/resources/*`) with key, name, project, service and tags, so `<type>.<verb>` actions, the pickers and `/api/resources/search` know it.
   - The route gate only sees the service, never the resource. For "user X may not use resource Y" call the engine in the handler after resolving the resource: `authorizeResourceAccess` (`src/lib/iam/resourceAuthz.ts`) with action, resource, channel and context. Until a handler asks, the policy editor flags such rules as not enforced.
   - Reuse the execution verbs (`agent.invoke`, `model.infer`, `tool.execute`, `mcp-server.call`, `rag-module.query`, `portal.use`) instead of inventing parallel ones.

4. **Handler-level checks**
   - Never decide a request with `rbac.ts` arithmetic (`authorizeService*`). Use `authorizeServiceForRequest(request, service, { level })` (`src/server/api/fastify-utils.ts`) or `authorizeResourceAccess`. They follow the engine (project narrowing, token caps, group grants, custom policies), stamp `X-Decision-Id`, and throw `authorization_unavailable` (503) when the engine cannot decide: never catch that and allow.
   - Never check `role === 'owner' | 'admin'` from the JWT or a header. Use the live identity (`src/lib/iam/identity.ts`, `request.rbacUser`; server layouts: `getCurrentIdentity()` / `canOpenIamCenter()` in `src/lib/auth/serverIdentity.ts`). Writes on people go through `src/lib/services/users/peoplePolicy.ts` (owner immutable, no self role change, only owner/admin grant admin, never upward, directory-managed fields).
   - Per-item filtering asks the engine (batched where possible); never re-implement role tables.

5. **Failure semantics**
   - Fail closed: a missing principal, a store error or an engine error is 503 `authorization_unavailable` with a decision id, never a silent allow.
   - Owner safety is the only bypass: the workspace owner's session is always allowed on the `iam` service. Do not add others.
   - A custom forbid whose evaluation errors counts as a deny. Managed policies must not be able to error (use `has` checks).
   - Error bodies: `error` stays the human-readable reason; `code`, `message`, `service`, `required`, `decisionId` are additive; OpenAI/Anthropic envelopes carry `error.decision_id`. Never reveal which policy denied.

6. **Semantics to preserve**
   - Project levels narrow the workspace level (min), never widen; "Inherit" stores nothing; explicit `none` entries saved before a workspace's activation instant are read as not set (`projectLevels.ts`).
   - Tokens authorize as their owner (live role plus the owner's group grants), capped by the token scope; project-bound tokens use their project. Personal token lists are own-only; acting on another person's tokens follows never-upward (`canActOnTokensOf`).
   - Token rules (lifetime policy, IP allowlist) live in `src/lib/services/apiTokens/*`. Never use `request.ip` for authorization or allowlists: use `getAuthzClientIp` (connection address unless `TRUSTED_PROXIES` is set).
   - Group grants only raise. Directory groups (source `ldap`/`oidc`) have read-only memberships (409 `group_directory_managed`); directory-managed people keep name, email and password in the directory, and their role when role sync is on (409 `directory_managed`).

7. **Caching and invalidation**
   - Principals are cached for about 15 s (`principalCache.ts`), the live identity for about 30 s. Every write that changes role, status, group membership or grants, project membership or levels, token scope or policies must call the existing invalidation (follow `PATCH /api/users/:id`, the group and project member routes, the policy store) so it applies at once on this node; other nodes converge within the TTL.

8. **Audit and attribution**
   - Engine denials are audited automatically (`request.iamDenial`). Semantic changes (role, membership, policy, token restrictions, directory sync) write explicit audit rows with the actor (`directory:<source>` for directory sync); new event kinds go into the IAM audit feed (`auditFeed.ts`) and i18n.
   - Usage, tracing and request logs must carry `userId`, `apiTokenId` and the actor type so a person's activity stays attributable across services.

9. **Limits (quotas)**
   - A new metered call picks or adds a quota domain (`src/lib/quota/types.ts`) and calls the guard with the same keys the target picker stores (`src/lib/quota/targets.ts`); keep `quota-targets.test.ts` (drift guard) green.

10. **Channels and end-user surfaces**
    - Requests through a portal use channel `portal`; the portal access list is the portal's built-in policy. New end-user surfaces reuse `authorizeResourceAccess` with an explicit channel instead of keeping their own access lists.

11. **Storage, seams and upgrades**
    - No migrations and no new indexes; use existing JSON/settings fields. `iam_*` documents are created lazily through the iam-docs mixins. SQLite and MongoDB must behave the same (`describeForEachProvider` parity tests).
    - Community ↔ EE contracts go through `src/enterprise/*` seams (`registry.ts` `SEAM_CONTRACT_VERSION`, `iam-portal.ts`, `directory-role-sync.ts`). Changing a seam means bumping the version in both registries and in EE `COMPAT.json`.
    - A change that alters who may do what on existing data: run `scripts/iam/preflight-diff.ts` on a copy of the databases and describe the effect in `docs/guide/upgrading-to-the-policy-engine.md`.

12. **UI**
    - The IAM center is for owners, admins and holders of an `iam` grant. End-user pages (personal API tokens, My account) stay outside it. Gate in the UI (`useIamCapabilities`, server layouts) and enforce on the server.
    - Navigation visibility uses `session.effectivePermissions` (active project).
    - Create/edit flows are full-screen FormShell; every string in `en.ts` and `tr.ts`.

13. **Tests for any authorization-relevant change**
    - Route-declaration guard green; allow and deny through the real gates (session and token), including a custom forbid, project narrowing and a token cap; the 503 path; SQLite and MongoDB; a negative control for security fixes.
    - The community repo is public: neutral wording in code, tests, docs and commit messages; no exploit narratives.

## 4) API Design Rules

- All runtime APIs must be registered from `src/server/api/plugins/*`.
- Client-facing APIs must live under `/client/v1` in native Fastify plugins.
- Keep resource structure RESTful in plugin route declarations.
- For streaming routes, use Fastify raw headers/streams directly or return a standard `Response` only when necessary.
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
- Keep Fastify-specific concerns inside `src/server/api/*`; do not leak Fastify APIs into `src/app/*`.
- Place shared helpers in `src/lib/utils` or domain utility modules.
- Split large UI components by domain responsibility.
- Avoid breaking public APIs unless explicitly required.
- Prefer targeted, minimal changes over broad refactors.

## 8) Validation Routine (After Changes)

Validate in this order when feasible:
1. Focused smoke check of the changed page/route
2. `npm run lint`
3. `npx tsc --noEmit`
4. `npm run build`

If demo data is needed:
- `npm run seed:demo`
- `npm run seed:demo:status`

Note: fixing unrelated legacy issues is not required, but they should be reported.

## 9) PR Checklist

- [ ] Tenant isolation remains intact (`switchToTenant` in the correct place)
- [ ] New client endpoints are registered from native Fastify plugins under `/client/v1`
- [ ] `policies.json` feature-endpoint mapping is up to date
- [ ] UI follows theme/component language
- [ ] Loading/error/empty states are handled
- [ ] No `process.env` in application code — use `getConfig()`
- [ ] No `console.*` in server code (`src/lib/`, `src/server/`) — use `createLogger()`
- [ ] Runtime Fastify code does not depend on `src/server/api/routes/*`
- [ ] No sensitive data in logs
- [ ] Every new route has an `authz.*` declaration; handler checks use `authorizeServiceForRequest` / `authorizeResourceAccess`, never `rbac.ts` arithmetic or JWT role strings
- [ ] Authorization changes are tested allow + deny through the real gates (session and token, SQLite and MongoDB) and documented in `docs/guide/authorization.md`
- [ ] Writes that change role, membership, grants, project levels, token scope or policies invalidate the principal/identity caches
- [ ] Lint/build (and relevant tests) pass

## 10) console-sdk Alignment Notes

If gateway and SDK evolve together:
- When gateway client endpoint/schema changes, update `console-sdk/src/resources/*` and `console-sdk/src/types.ts`.
- Validate SDK changes with at least `npm run build` and relevant examples under `console-sdk/examples/*`.
- Preserve backward compatibility whenever possible.

---

## Short Agent Summary

- Prioritize tenant safety and license checks first.
- Every request is authorized by the policy engine: declare routes, ask the engine in handlers, fail closed (section 3.2).
- Keep UI work in `src/app/*` and runtime API work in `src/server/api/plugins/*`.
- Then implement API and service changes within correct domain boundaries.
- Keep UI strictly aligned with existing Mantine design language.
- Deliver changes small, traceable, and validated.
