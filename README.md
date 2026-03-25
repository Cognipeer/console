# Cognipeer Console

Open-source, multi-tenant AI gateway for LLM services, agent orchestration, vector stores, RAG pipelines, prompt management, and more.

[![License](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

Community edition is available under AGPL-3.0. Commercial licensing, hosted deployments, and support agreements are available separately through Cognipeer.

## Features

- **Multi-Tenant Architecture** — Complete data isolation per tenant with per-tenant databases
- **LLM Gateway** — OpenAI-compatible chat completions and embeddings with multi-provider support (OpenAI, Anthropic, AWS Bedrock, Google Vertex AI, vLLM, Ollama, and more)
- **Vector Store Management** — Multi-provider vector operations with built-in SQLite vector support
- **RAG Pipeline** — Document ingestion, chunking, embedding, and retrieval
- **Agent Tracing** — Batch and streaming ingest with thread correlation
- **Guardrails** — PII detection, content moderation, prompt shields, and custom LLM-based evaluators
- **Prompt Management** — Versioned templates with environment-based deployment (dev/staging/prod)
- **Semantic Memory** — Scoped memory stores with vector-based recall
- **File Management** — Multi-provider file storage with automatic Markdown conversion
- **Inference Monitoring** — Real-time monitoring for self-hosted inference servers
- **Alerts** — Rule-based alerting with email notifications
- **Quota & Rate Limiting** — Multi-dimensional quota enforcement with plan-level defaults

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
git clone https://github.com/Cognipeer/cognipeer-console.git
cd cognipeer-console
npm install
cp .env.example .env.local
npm run dev
```

The gateway starts with **SQLite by default** — no external database required.

Visit [http://localhost:3000](http://localhost:3000) to access the dashboard.

### Docker

```bash
docker compose up -d
```

Or build and run manually:

```bash
docker build -t cognipeer-console .
docker run -p 3000:3000 -v ./data:/app/data -e JWT_SECRET=your-secret-here cognipeer-console
```

## Architecture

```
┌────────────────────────────────────────────────────┐
│                    Next.js App                      │
├──────────────┬──────────────┬──────────────────────┤
│  Dashboard   │  Client API  │    Dashboard API     │
│   (UI)       │ /client/v1/* │    /api/*            │
├──────────────┴──────────────┴──────────────────────┤
│                  Middleware                         │
│         (JWT Auth + Feature Gates + CORS)           │
├────────────────────────────────────────────────────┤
│                 Service Layer                       │
│  Models │ Vector │ RAG │ Memory │ Tracing │ ...    │
├────────────────────────────────────────────────────┤
│              Provider Registry                      │
│  Contracts → Runtimes (LLM, Vector, File)          │
├────────────────────────────────────────────────────┤
│             Database Abstraction                    │
│           SQLite (default) │ MongoDB               │
├────────────────────────────────────────────────────┤
│               Core Infrastructure                   │
│  Config │ Logger │ Cache │ Resilience │ Health     │
└────────────────────────────────────────────────────┘
```

### Technology Stack

- **Framework**: Next.js 15 (App Router) + TypeScript
- **UI**: Mantine v8 + Tailwind CSS
- **Database**: SQLite (default, zero-dependency) or MongoDB
- **Auth**: JWT (jose) + API tokens
- **Cache**: None / Memory / Redis
- **Logging**: Winston with structured context

## Configuration

All configuration is managed through environment variables. See [.env.example](.env.example) for the full list.

Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_PROVIDER` | `sqlite` | Database backend (`sqlite` or `mongodb`) |
| `JWT_SECRET` | — | **Required**. Secret for JWT signing |
| `MAIN_DB_NAME` | `cgate_main` | Main database name |
| `CACHE_PROVIDER` | `memory` | Cache backend (`none`, `memory`, `redis`) |
| `CORS_ENABLED` | `false` | Enable CORS for client APIs |

For the full configuration reference, see the [Configuration Guide](docs/guide/configuration.md).

## Client API

The gateway exposes an OpenAI-compatible API at `/api/client/v1/`:

```bash
# Chat completion
curl -X POST http://localhost:3000/api/client/v1/chat/completions \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4", "messages": [{"role": "user", "content": "Hello"}]}'

# Embeddings
curl -X POST http://localhost:3000/api/client/v1/embeddings \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"model": "text-embedding-3-small", "input": "Hello world"}'
```

See [openapi.yaml](openapi.yaml) for the full API specification.

## Official SDK

If you are building an application against Cognipeer Console, prefer the official TypeScript/JavaScript SDK:

- SDK repo: [console-sdk](https://github.com/Cognipeer/console-sdk)
- SDK docs: [cognipeer.github.io/console-sdk](https://cognipeer.github.io/console-sdk/)

Use this repository and its docs for platform setup, deployment, providers, tenancy, auth, and raw HTTP API semantics.

## Documentation

Full documentation is available in the [docs/](docs/) directory:

- [Getting Started](docs/guide/getting-started.md)
- [Architecture](docs/guide/architecture.md)
- [Configuration](docs/guide/configuration.md)
- [Deployment](docs/guide/deployment.md)
- [Multi-Tenancy](docs/guide/multi-tenancy.md)
- [API Reference](docs/api/overview.md)
- [Licensing](docs/guide/licensing.md)
- [Security](docs/guide/security.md)

Build and preview the documentation site:

```bash
npm run docs:dev
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines, code style, and PR checklist.

## Security

Security reporting guidance is in [SECURITY.md](SECURITY.md). Do not disclose vulnerabilities in public issues.

## License

This repository is licensed under the GNU Affero General Public License v3.0. See [LICENSE](LICENSE) for the full text.

If you want to embed Cognipeer Console in a closed-source product, offer a proprietary hosted derivative without AGPL obligations, or purchase support/SLA coverage, see [COMMERCIAL.md](COMMERCIAL.md).
