# Changelog

## 1.1.0

### SQLite Database Provider
- Added SQLite as the **default** database backend — zero external dependencies
- Full multi-tenant support with per-tenant `.sqlite` files
- All 16 domain mixins implemented (tenants, users, projects, models, vectors, tracing, guardrails, RAG, memory, alerts, prompts, quotas, files, providers, inference, API tokens)
- WAL mode and foreign keys enabled for performance and data integrity
- Switch to MongoDB with `DB_PROVIDER=mongodb`

### SQLite Vector Provider
- Added `sqlite-vector` provider contract for local vector storage
- Brute-force cosine, dot-product, and euclidean similarity search
- No external vector database required
- Batch upsert within transactions for data consistency

### Local File Provider
- Already available as `local-file` provider

### Quick Installation
- Zero-dependency setup: just `npm install && npm run dev`
- Docker runs with a single volume mount for persistence
- Updated documentation with Quick Installation section

### Configuration
- New env vars: `DB_PROVIDER` (default: `sqlite`), `SQLITE_DATA_DIR` (default: `./data`)
- `MONGODB_URI` now only required when `DB_PROVIDER=mongodb`

---

## 1.0.0

Initial release of the Cognipeer Console documentation.

### Core Infrastructure
- Centralized configuration via `getConfig()`
- Winston structured logging with request context
- AsyncLocalStorage-based request context propagation
- Provider-based cache (none / memory / Redis)
- Retry with exponential backoff + circuit breaker
- LRU runtime pool for provider SDK instances
- Fire-and-forget async task runner
- Health check registry
- Graceful lifecycle management
- Configurable CORS for client APIs

### Features
- Multi-tenant architecture with per-tenant databases
- JWT session + API token authentication
- Contract-driven provider system (LLM, Vector, File)
- OpenAI-compatible chat completions and embeddings
- Vector store management (multi-provider)
- Agent tracing (batch + streaming)
- Guardrails (PII, moderation, prompt shield, custom)
- RAG pipeline (ingest, chunk, embed, query)
- Versioned prompt templates with environment deployment
- Semantic memory stores
- File storage with Markdown conversion
- License-based feature control
- Quota and rate limiting

### Deployment
- Docker multi-stage build
- Kubernetes Helm chart
- GitHub Pages documentation
