# Architecture

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Next.js 15 (App Router) + TypeScript |
| UI | Mantine v7 + Tailwind CSS |
| Database | SQLite (default) or MongoDB (multi-tenant) |
| Authentication | JWT via `jose` (Edge-compatible) |
| Logging | Winston (structured, JSON/pretty) |
| Cache | Memory or Redis (ioredis) |
| Email | Nodemailer + Handlebars templates |
| Build | Turbopack |
| Testing | Vitest |
| Deployment | Docker + Kubernetes (Helm) |

## Request Flow

Every request goes through a well-defined pipeline:

```
Client Request
     │
     ▼
┌─────────────┐
│  Middleware  │  ← JWT validation, feature checks, CORS
│  (Edge)     │     Injects: x-user-id, x-tenant-id, x-request-id
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ withRequestContext│  ← Establishes AsyncLocalStorage context
│  (Route wrapper) │     Checks isShuttingDown → 503
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  Route Handler  │  ← requireApiToken (client routes)
│                 │     Validation, quota checks
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  Domain Service │  ← Business logic
│  (inference,    │     Uses: runtimePool, withResilience, cache
│   vector, etc.) │
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│  Provider       │  ← External API call (LLM, vector DB, etc.)
│  Runtime        │     Wrapped in withResilience (retry + circuit breaker)
└─────────────────┘
```

## Multi-Tenant Data Model

The gateway supports two database backends. **SQLite** is the default for zero-dependency setups; **MongoDB** is available for production deployments requiring higher concurrency.

### SQLite (default)

Each tenant gets a separate `.sqlite` file — full data isolation with no external services:

```
data/
├── console_main.sqlite       # Shared database (tenant registry)
├── tenant_acme.sqlite        # Tenant "acme"
├── tenant_globex.sqlite      # Tenant "globex"
└── ...
```

### MongoDB

```
MongoDB Server
├── console_main             # Shared database
│   └── tenants              # Tenant metadata, license, slug
├── tenant_{slug}            # Per-company database
│   ├── users                # User accounts
│   ├── api_tokens           # API tokens
│   ├── projects             # Projects
│   ├── models               # Model configurations
│   ├── provider_configs     # Provider credentials (encrypted)
│   ├── vector_indexes       # Vector index metadata
│   ├── model_usage_logs     # Inference usage logs
│   ├── agent_tracing_*      # Tracing sessions & events
│   ├── guardrails           # Guardrail policies
│   ├── prompts              # Prompt templates
│   ├── rag_modules          # RAG configurations
│   ├── memory_stores        # Memory store configs
│   └── ...
└── tenant_{another_slug}    # Another company (complete isolation)
```

Switch between providers with `DB_PROVIDER=sqlite` (default) or `DB_PROVIDER=mongodb`.

## Core Module Stack

The infrastructure layer (`src/lib/core/`) provides cross-cutting concerns that are used by all services:

| Module | Purpose |
|--------|---------|
| [Config](/guide/core-config) | Centralized typed configuration with ENV abstraction |
| [Logger](/guide/core-logger) | Structured logging with automatic request context |
| [Request Context](/guide/core-request-context) | Per-request AsyncLocalStorage propagation |
| [Cache](/guide/core-cache) | Provider-based caching (none / memory / Redis) |
| [Resilience](/guide/core-resilience) | Retry with exponential back-off + circuit breaker |
| [Runtime Pool](/guide/core-runtime-pool) | LRU cache for provider SDK client instances |
| [Async Tasks](/guide/core-async-tasks) | Fire-and-forget background operations |
| [Health Checks](/guide/core-health) | Subsystem health registry for readiness probes |
| [Lifecycle](/guide/core-lifecycle) | Graceful shutdown with ordered handler teardown |
| [CORS](/guide/core-cors) | Configurable CORS for client API endpoints |

## Bootstrap Sequence

The application bootstrap is managed by `src/instrumentation.ts` (Next.js instrumentation hook):

```
1. Validate config (getConfig + validateConfig)
2. Initialize lifecycle (signal handlers: SIGTERM, SIGINT)
3. Initialize cache provider (memory / Redis / none)
4. Register health check for cache
5. Register shutdown handlers (async-tasks → cache → runtime-pool)
6. Start background schedulers (inference monitoring, alerts)
7. Log startup summary
```

## Service Layer

Business logic is in `src/lib/services/`:

| Service | Responsibility |
|---------|---------------|
| `models/inferenceService` | Chat completions & embeddings (OpenAI-compatible) |
| `models/runtimeService` | Provider runtime creation with pool caching |
| `models/modelService` | Model CRUD with metadata caching |
| `vector/vectorService` | Vector index CRUD, upsert, query |
| `files/fileService` | File upload/download/delete via provider runtime |
| `guardrail/` | Input/output evaluation with regex/keyword/LLM |
| `agentTracing/` | Tracing session & event persistence |
| `providers/providerService` | Provider config CRUD, credential encryption |
| `rag/` | RAG module management, document ingestion, queries |
| `memory/` | Memory store CRUD, semantic search |
| `prompts/` | Prompt template management, versioning |
| `apiTokenAuth` | API token validation with caching |
