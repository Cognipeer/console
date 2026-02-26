---
layout: home
hero:
  name: Cognipeer Gateway
  text: Multi-Tenant AI Gateway
  tagline: Production-ready gateway for LLM inference, vector stores, agent tracing, RAG, guardrails, and more — with complete tenant isolation.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/Cognipeer/cgate

features:
  - title: 🏢 Multi-Tenant
    details: Complete data isolation per company with separate databases and license-based feature control.
  - title: 🤖 LLM Gateway
    details: OpenAI-compatible chat completions and embeddings API with provider abstraction and automatic retries.
  - title: 🔍 Vector Stores
    details: Manage vector indexes across providers (Pinecone, Qdrant, Weaviate, S3 Vectors) with a unified API.
  - title: 📊 Agent Tracing
    details: Ingest and visualize agent execution traces with batch and streaming modes, async persistence.
  - title: 🛡️ Guardrails
    details: Input/output validation with regex, keyword, and LLM-based evaluators to enforce content policies.
  - title: 📚 RAG Modules
    details: End-to-end retrieval-augmented generation with document ingestion, chunking, and query pipelines.
  - title: 💾 Caching & Resilience
    details: Built-in cache layer (memory/Redis), retry with exponential back-off, and circuit breaker protection.
  - title: 📈 Observability
    details: Structured logging with request correlation, health checks, usage tracking, and alert system.
---

## Quick Start

::: code-group

```bash [npm]
npm install
cp .env.example .env.local
npm run dev
```

```bash [Docker]
docker build -t cgate .
docker run -p 3000:3000 --env-file .env.local cgate
```

:::

## Architecture Overview

Cognipeer Gateway is built on **Next.js 15** with the App Router, TypeScript, and MongoDB. It serves as the central gateway for all AI operations:

```
┌─────────────────────────────────────────────────┐
│                   Clients                        │
│          (SDKs, Agents, Applications)            │
└────────────────┬────────────────────────────────┘
                 │ REST API
┌────────────────▼────────────────────────────────┐
│              Cognipeer Gateway                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Middleware│ │  CORS    │ │ Request Context  │ │
│  │ (Auth)   │ │          │ │ (AsyncLocalStore)│ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Inference│ │  Vector  │ │  Agent Tracing   │ │
│  │ Service  │ │  Service │ │  Service         │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │   RAG    │ │Guardrails│ │  File Storage    │ │
│  │ Service  │ │ Service  │ │  Service         │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────────────────────────────────────────┤
│  │  Core: Config │ Logger │ Cache │ Resilience  │
│  │  Runtime Pool │ Health │ Lifecycle │ Async   │
│  └──────────────────────────────────────────────┤
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│          LLM / Vector / Storage Providers        │
│   OpenAI, Anthropic, Google, AWS Bedrock, etc.   │
└─────────────────────────────────────────────────┘
```

## Key Capabilities

- **OpenAI-compatible API** — Drop-in replacement for `/v1/chat/completions` and `/v1/embeddings`
- **Provider abstraction** — Swap between OpenAI, Anthropic, Google Vertex, AWS Bedrock, and custom models
- **Multi-tenant isolation** — Each company gets a separate database and license tier
- **Production infrastructure** — Retry, circuit breaker, caching, structured logging, health checks
- **Async-first design** — Usage logging and tracing persist asynchronously without blocking responses
- **Kubernetes-ready** — Dockerfile, Helm charts, and graceful shutdown support included
